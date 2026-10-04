/**
 * 纸库批次与补纸领用 store（Pinia setup store）
 * - 维护纸库批次（入库张数 / 已出库张数 / 封批）与按叶领用单
 * - 登记领用：按纸库当下在库批次挑选，色差最近的批次封批或余量不足则顺延下一档
 * - 出库 / 退库与领用在同一事务内，保证纸库余量与领用记录一致
 * - 对账对不上时只退回指定书叶的领用，其他书叶照旧
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import type { Paper } from '@/types/paper'
import type { PaperBatch, PaperBatchDraft } from '@/types/paperBatch'
import type { Requisition, RequisitionDraft } from '@/types/requisition'
import {
  availableSheets,
  batchCanSupply,
  rankBatches,
  reconcileRequisitions,
  selectBatch,
  type RankedBatch
} from '@/utils/paperRequisition'

export interface RequisitionInput {
  leafId: string
  /** 需求张数（正整数） */
  sheets: number
  operator: string
  date: string
  /** 期望纸种；未登记配纸时由修复师选择 */
  paperType: Paper['paperType']
  /** 目标 ΔE：取自已登记配纸，或由调用方按书叶估算 */
  targetDeltaE: number
  /** 已登记配纸的帘纹，作为同色差档排序参考 */
  preferredPattern?: string
  /** 已登记配纸的厚度 */
  leafThicknessMm?: number
}

export interface RequisitionPreview {
  ranked: RankedBatch[]
  selectable: boolean
}

export const usePaperStore = defineStore('paperStore', () => {
  const batches = ref<PaperBatch[]>([])
  const requisitions = ref<Requisition[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadPaperData(): Promise<void> {
    loading.value = true
    try {
      const [batchRows, requisitionRows] = await Promise.all([
        db.paperBatches.toArray(),
        db.requisitions.toArray()
      ])
      batchRows.sort((a, b) => b.receivedDate.localeCompare(a.receivedDate))
      requisitionRows.sort((a, b) => (a.date === b.date ? b.updatedAt - a.updatedAt : b.date.localeCompare(a.date)))
      batches.value = batchRows
      requisitions.value = requisitionRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '纸库数据读取失败'
    } finally {
      loading.value = false
    }
  }

  function batchById(id: string): PaperBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  function requisitionsOfLeaf(leafId: string): Requisition[] {
    return requisitions.value
      .filter((item) => item.leafId === leafId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
  }

  /** 书叶当前未退回的领用张数合计 */
  function issuedSheetsOfLeaf(leafId: string): number {
    return requisitionsOfLeaf(leafId)
      .filter((item) => item.state === 'issued')
      .reduce((sum, item) => sum + item.sheets, 0)
  }

  const activeRequisitions = computed(() => requisitions.value.filter((item) => item.state === 'issued'))

  /* ------------------------------ 批次 ------------------------------ */

  async function createBatch(draft: PaperBatchDraft): Promise<PaperBatch> {
    if (draft.issuedSheets > draft.receivedSheets) {
      throw new Error('已出库张数不能大于入库张数')
    }
    const now = Date.now()
    const row: PaperBatch = { ...draft, id: createId('batch'), createdAt: now, updatedAt: now }
    await db.paperBatches.put(row)
    await loadPaperData()
    return row
  }

  async function updateBatch(id: string, patch: Partial<PaperBatch>): Promise<void> {
    const current = batches.value.find((batch) => batch.id === id)
    if (current) {
      const received = patch.receivedSheets ?? current.receivedSheets
      const issued = patch.issuedSheets ?? current.issuedSheets
      if (issued > received) throw new Error('已出库张数不能大于入库张数')
    }
    await db.paperBatches.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadPaperData()
  }

  async function removeBatch(id: string): Promise<void> {
    const used = requisitions.value.some((item) => item.batchId === id && item.state === 'issued')
    if (used) throw new Error('该批次仍有未退回的领用，不能删除；可先封批或退回相关领用')
    await db.paperBatches.delete(id)
    await loadPaperData()
  }

  /** 封批 / 解封；封批记录日期，解封清空 */
  async function setBatchSealed(id: string, sealed: boolean, remark = ''): Promise<void> {
    const patch: Partial<PaperBatch> = {
      state: sealed ? 'sealed' : 'in_stock',
      sealedDate: sealed ? new Date().toISOString().slice(0, 10) : '',
      remark: sealed ? remark || '封存' : ''
    }
    await updateBatch(id, patch)
  }

  /* ------------------------------ 领用挑选预览 ------------------------------ */

  /** 按当下在库批次排档（不落库），供登记对话框展示顺延过程 */
  function previewRanking(input: RequisitionInput): RequisitionPreview {
    const sameType = batches.value.filter((batch) => batch.paperType === input.paperType)
    const ranked = rankBatches(sameType, {
      targetDeltaE: input.targetDeltaE,
      sheets: input.sheets,
      preferredPattern: input.preferredPattern,
      leafThicknessMm: input.leafThicknessMm
    })
    return { ranked, selectable: ranked.some((item) => item.selectable) }
  }

  /* ------------------------------ 登记领用（出库） ------------------------------ */

  /**
   * 登记领用：
   * 事务内重新按纸库当下批次排档挑选（封批 / 余量不足顺延下一档），
   * 选中后批次已出库张数累加并写领用单；同一事务回写配纸归属批次。
   */
  async function registerRequisition(input: RequisitionInput): Promise<Requisition> {
    if (!Number.isInteger(input.sheets) || input.sheets <= 0) {
      throw new Error('领用张数必须为正整数')
    }
    return db.transaction(
      'rw',
      [db.paperBatches, db.requisitions, db.papers],
      async () => {
        const all = await db.paperBatches.toArray()
        const sameType = all.filter((batch) => batch.paperType === input.paperType)
        const ranked = rankBatches(sameType, {
          targetDeltaE: input.targetDeltaE,
          sheets: input.sheets,
          preferredPattern: input.preferredPattern,
          leafThicknessMm: input.leafThicknessMm
        })
        const picked = selectBatch(ranked)
        if (!picked) throw new Error('纸库没有在库且张数足够的同纸种批次，无法登记领用')

        // 事务内以库里最新值复核一次余量，防止并发改动
        if (!batchCanSupply(picked.batch, input.sheets)) {
          throw new Error(`批次 ${picked.batch.batchNo} 当下余量不足，请重新登记`)
        }

        const now = Date.now()
        const nextIssued = picked.batch.issuedSheets + input.sheets
        await db.paperBatches.update(picked.batch.id, {
          issuedSheets: nextIssued,
          updatedAt: now
        })

        const draft: RequisitionDraft = {
          leafId: input.leafId,
          batchId: picked.batch.id,
          sheets: input.sheets,
          date: input.date,
          operator: input.operator,
          state: 'issued',
          selectedRank: picked.rank,
          skipReason: picked.skipReason,
          availableSnapshot: picked.availableSnapshot
        }
        const row: Requisition = { ...draft, id: createId('req'), createdAt: now, updatedAt: now }
        await db.requisitions.put(row)

        // 同叶同纸种的配纸记录接上批次归属（升级回填不了的旧记录也可在此补上）
        const linked = await db.papers
          .where('leafId')
          .equals(input.leafId)
          .toArray()
        await Promise.all(
          linked
            .filter((paper) => paper.paperType === input.paperType)
            .map((paper: Paper) =>
              db.papers.update(paper.id, {
                batchId: picked.batch.id,
                batchBackfilled: false,
                updatedAt: now
              } as never)
            )
        )
        return row
      }
    ).finally(() => {
      void loadPaperData()
    })
  }

  /* ------------------------------ 退回（只退本叶） ------------------------------ */

  /**
   * 退回指定领用单：只回退该单（一叶可对应一单 / 多单），
   * 批次已出库张数回退；其他书叶的领用与出库记录不受影响。
   */
  async function returnRequisition(requisitionId: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.paperBatches, db.requisitions],
      async () => {
        const target = await db.requisitions.get(requisitionId)
        if (!target) throw new Error('领用单不存在')
        if (target.state === 'returned') return
        const batch = await db.paperBatches.get(target.batchId)
        if (batch) {
          await db.paperBatches.update(batch.id, {
            issuedSheets: Math.max(0, batch.issuedSheets - target.sheets),
            updatedAt: Date.now()
          })
        }
        await db.requisitions.update(target.id, {
          state: 'returned',
          updatedAt: Date.now()
        } as never)
      }
    )
    await loadPaperData()
  }

  /**
   * 按对账结果退回某书叶在某批次下的全部未退回领用（单叶退回入口）：
   * 对不上时只退回这一叶的领用，别的书叶照旧。单事务内一次性回退批次余量。
   */
  async function returnLeafBatchRequisitions(leafId: string, batchId: string): Promise<number> {
    return db.transaction('rw', [db.paperBatches, db.requisitions], async () => {
      const targets = (await db.requisitions.where('leafId').equals(leafId).toArray()).filter(
        (item) => item.batchId === batchId && item.state === 'issued'
      )
      if (targets.length === 0) return 0
      const totalSheets = targets.reduce((sum, item) => sum + item.sheets, 0)
      const batch = await db.paperBatches.get(batchId)
      const now = Date.now()
      if (batch) {
        await db.paperBatches.update(batch.id, {
          issuedSheets: Math.max(0, batch.issuedSheets - totalSheets),
          updatedAt: now
        })
      }
      await Promise.all(
        targets.map((item) =>
          db.requisitions.update(item.id, { state: 'returned', updatedAt: now } as never)
        )
      )
      return targets.length
    }).finally(() => {
      void loadPaperData()
    })
  }

  async function removeRequisition(id: string): Promise<void> {
    const target = requisitions.value.find((item) => item.id === id)
    if (!target) return
    if (target.state === 'issued') await returnRequisition(id)
    await db.requisitions.delete(id)
    await loadPaperData()
  }

  /* ------------------------------ 对账派生 ------------------------------ */

  const reconciliation = computed(() => reconcileRequisitions(batches.value, requisitions.value))

  function availableOf(batch: PaperBatch): number {
    return availableSheets(batch)
  }

  return {
    batches,
    requisitions,
    activeRequisitions,
    loading,
    ready,
    error,
    reconciliation,
    loadPaperData,
    batchById,
    requisitionsOfLeaf,
    issuedSheetsOfLeaf,
    availableOf,
    createBatch,
    updateBatch,
    setBatchSealed,
    removeBatch,
    previewRanking,
    registerRequisition,
    returnRequisition,
    returnLeafBatchRequisitions,
    removeRequisition
  }
})
