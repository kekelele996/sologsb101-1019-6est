/**
 * 纸库领用服务
 * - 选批：同纸种同帘纹，按与目标 ΔE 接近度升序；封批或在库不足的批次顺延下一档
 * - 登记：一个 Dexie 事务内写领用单 + 出库流水（要么全成，要么不占用任何库存）
 * - 对账：领用汇总按批次与纸库出库流水逐批比对，整单合计也校验
 * - 退回：对不上只退回该叶的领用（删其出库流水、库存随出库记录自动还回）
 *
 * 「在库张数」由入库张数 − 该批有效（领用单未退回的）出库流水汇总得出，
 * 不另存冗余字段，保证领用账与纸库账始终同源。
 */
import { createId, db } from './db'
import type {
  PaperBatch,
  PaperOutbound,
  PaperRequisition,
  RequisitionAllocation,
  RequisitionDraft
} from '@/types/warehouse'

/** 逐批在库张数：入库张数 − 未退回领用单的出库合计 */
export interface BatchStock {
  batchId: string
  quantityIn: number
  outbound: number
  onHand: number
  sealed: boolean
}

export type SkipReason = 'sealed' | 'shortage'

export interface PlanStep {
  batch: PaperBatch
  /** 与目标 ΔE 的差距，升序逐档顺延 */
  colorGap: number
  /** 顺延原因：封批 / 在库张数不够；取走张数则表示该档命中 */
  taken: number
  skipReason: SkipReason | null
}

export interface AllocationPlan {
  /** 是否在可用批次中凑齐了领用张数 */
  fulfills: boolean
  allocations: RequisitionAllocation[]
  steps: PlanStep[]
  /** 候选批次（同纸种同帘纹）总在库 */
  totalOnHand: number
  shortfall: number
}

/**
 * 计算各批次当下在库。
 * @param excludeRequisitionId 规划新领用单时忽略该单自身的出库（事务内尚不存在，传空即可）
 */
export async function loadBatchStocks(excludeRequisitionId = ''): Promise<Map<string, BatchStock>> {
  const [batches, outbounds, requisitions] = await Promise.all([
    db.paperBatches.toArray(),
    db.paperOutbounds.toArray(),
    db.paperRequisitions.toArray()
  ])
  const activeRequisitions = new Set(
    requisitions.filter((item) => item.status !== 'returned' && item.id !== excludeRequisitionId).map((item) => item.id)
  )
  const stock = new Map<string, BatchStock>()
  batches.forEach((batch) => {
    stock.set(batch.id, {
      batchId: batch.id,
      quantityIn: batch.quantityIn,
      outbound: 0,
      onHand: batch.quantityIn,
      sealed: batch.sealed
    })
  })
  outbounds.forEach((record) => {
    if (!activeRequisitions.has(record.requisitionId)) return
    const entry = stock.get(record.batchId)
    if (!entry) return
    entry.outbound += record.quantity
    entry.onHand -= record.quantity
  })
  return stock
}

/**
 * 按纸库当下在库规划领用分配：
 * 同纸种同帘纹 → 与目标 ΔE 差距升序逐档顺延；封批整档跳过，在库不足则先取尽再顺延下一档。
 */
export function planAllocation(
  batches: PaperBatch[],
  stocks: Map<string, BatchStock>,
  request: { paperType: PaperBatch['paperType']; laidPattern: string; targetDeltaE: number; quantity: number }
): AllocationPlan {
  const candidates = batches
    .filter((batch) => batch.paperType === request.paperType && batch.laidPattern === request.laidPattern)
    .sort((a, b) => {
      const gapA = Math.abs(a.colorDelta - request.targetDeltaE)
      const gapB = Math.abs(b.colorDelta - request.targetDeltaE)
      if (gapA !== gapB) return gapA - gapB
      if (a.batchNo !== b.batchNo) return a.batchNo.localeCompare(b.batchNo, 'zh-Hans-CN')
      return a.id.localeCompare(b.id)
    })

  const steps: PlanStep[] = []
  const allocations: RequisitionAllocation[] = []
  let remaining = request.quantity
  let totalOnHand = 0

  for (const batch of candidates) {
    const entry = stocks.get(batch.id)
    const onHand = entry?.onHand ?? 0
    const colorGap = Math.abs(batch.colorDelta - request.targetDeltaE)

    if (entry?.sealed || batch.sealed) {
      steps.push({ batch, colorGap, taken: 0, skipReason: 'sealed' })
      continue
    }
    // 封批批次不计入可领在库
    totalOnHand += Math.max(0, onHand)
    if (onHand <= 0) {
      steps.push({ batch, colorGap, taken: 0, skipReason: 'shortage' })
      continue
    }
    if (onHand < remaining) {
      // 该档不够：先取尽在库，再顺延下一档
      allocations.push({ batchId: batch.id, batchNo: batch.batchNo, quantity: onHand, colorGap })
      steps.push({ batch, colorGap, taken: onHand, skipReason: 'shortage' })
      remaining -= onHand
    } else {
      allocations.push({ batchId: batch.id, batchNo: batch.batchNo, quantity: remaining, colorGap })
      steps.push({ batch, colorGap, taken: remaining, skipReason: null })
      remaining = 0
      break
    }
  }

  return {
    fulfills: remaining === 0,
    allocations,
    steps,
    totalOnHand,
    shortfall: Math.max(0, remaining)
  }
}

/**
 * 事务登记领用：先按当下在库规划，凑不齐则整体拒绝（不写任何记录、不占用库存）；
 * 凑齐则同一事务写领用单与逐批出库流水。
 */
export async function createRequisition(draft: RequisitionDraft): Promise<{ requisition: PaperRequisition; plan: AllocationPlan }> {
  if (!Number.isFinite(draft.quantity) || draft.quantity <= 0) {
    throw new Error('领用张数必须大于 0')
  }
  let created: PaperRequisition | null = null
  let resolvedPlan: AllocationPlan | null = null

  await db.transaction(
    'rw',
    [db.paperBatches, db.paperRequisitions, db.paperOutbounds],
    async () => {
      const [batches, stocks] = await Promise.all([
        db.paperBatches.toCollection().toArray(),
        loadBatchStocks()
      ])
      const plan = planAllocation(batches, stocks, draft)
      if (!plan.fulfills) {
        throw new Error(
          `同纸种同帘纹的在库批次合计仅剩 ${plan.totalOnHand} 张，不足领用 ${draft.quantity} 张（缺 ${plan.shortfall} 张），已取消登记`
        )
      }
      const now = Date.now()
      const requisition: PaperRequisition = {
        id: createId('req'),
        requester: draft.requester,
        leafId: draft.leafId,
        paperType: draft.paperType,
        laidPattern: draft.laidPattern,
        targetDeltaE: draft.targetDeltaE,
        quantity: draft.quantity,
        allocations: plan.allocations,
        status: 'active',
        returnedAt: null,
        returnReason: '',
        date: draft.date,
        createdAt: now,
        updatedAt: now
      }
      const outbound: PaperOutbound[] = plan.allocations.map((item) => ({
        id: createId('out'),
        batchId: item.batchId,
        requisitionId: requisition.id,
        quantity: item.quantity,
        operator: draft.requester,
        date: draft.date,
        createdAt: now,
        updatedAt: now
      }))
      await db.paperRequisitions.put(requisition)
      await db.paperOutbounds.bulkPut(outbound)
      created = requisition
      resolvedPlan = plan
    }
  )

  if (!created || !resolvedPlan) throw new Error('领用登记失败')
  return { requisition: created, plan: resolvedPlan }
}

export interface ReconcileLine {
  requisitionId: string
  leafId: string
  status: PaperRequisition['status']
  /** 按批次逐行：领用汇总 vs 出库流水 */
  batchRows: Array<{
    batchId: string
    batchNo: string
    requisitionQty: number
    outboundQty: number
    matched: boolean
    /** 出库流水里有、领用明细里没有（孤儿流水） */
    orphan: boolean
  }>
  totalRequisition: number
  totalOutbound: number
  matched: boolean
}

/** 领用汇总按批次与纸库出库记录对账；只核对领用中的单据 */
export async function reconcileRequisitions(): Promise<ReconcileLine[]> {
  const [requisitions, outbounds] = await Promise.all([
    db.paperRequisitions.toArray(),
    db.paperOutbounds.toArray()
  ])
  return requisitions
    .filter((item) => item.status === 'active')
    .map((requisition) => {
      const records = outbounds.filter((item) => item.requisitionId === requisition.id)
      const requisitionByBatch = new Map<string, { batchNo: string; quantity: number }>()
      requisition.allocations.forEach((item) => {
        requisitionByBatch.set(item.batchId, { batchNo: item.batchNo, quantity: item.quantity })
      })
      const outboundByBatch = new Map<string, { quantity: number }>()
      records.forEach((item) => {
        const prev = outboundByBatch.get(item.batchId)?.quantity ?? 0
        outboundByBatch.set(item.batchId, { quantity: prev + item.quantity })
      })
      const batchIds = new Set([...requisitionByBatch.keys(), ...outboundByBatch.keys()])
      const batchRows = [...batchIds].map((batchId) => {
        const requisitionQty = requisitionByBatch.get(batchId)?.quantity ?? 0
        const outboundQty = outboundByBatch.get(batchId)?.quantity ?? 0
        return {
          batchId,
          batchNo: requisitionByBatch.get(batchId)?.batchNo ?? '（已删批次）',
          requisitionQty,
          outboundQty,
          matched: requisitionQty === outboundQty,
          orphan: !requisitionByBatch.has(batchId)
        }
      })
      const totalRequisition = requisition.allocations.reduce((sum, item) => sum + item.quantity, 0)
      const totalOutbound = records.reduce((sum, item) => sum + item.quantity, 0)
      return {
        requisitionId: requisition.id,
        leafId: requisition.leafId,
        status: requisition.status,
        batchRows,
        totalRequisition,
        totalOutbound,
        matched: batchRows.every((row) => row.matched) && totalRequisition === totalOutbound
      }
    })
}

/**
 * 对不上只退回这一叶的领用：删除该单全部出库流水（库存随记录自动还回），
 * 领用单标记已退回保留可查；其他书叶的领用单与出库不动。
 */
export async function returnRequisition(requisitionId: string, reason: string): Promise<void> {
  await db.transaction('rw', [db.paperRequisitions, db.paperOutbounds], async () => {
    const requisition = await db.paperRequisitions.get(requisitionId)
    if (!requisition) throw new Error('领用单不存在')
    if (requisition.status === 'returned') throw new Error('该领用单已退回')
    await db.paperOutbounds.where('requisitionId').equals(requisitionId).delete()
    await db.paperRequisitions.update(requisitionId, {
      status: 'returned',
      returnedAt: Date.now(),
      returnReason: reason || '对账不符，退回该叶领用',
      updatedAt: Date.now()
    } as never)
  })
}

/** 删除批次前校验：已有出库记录的批次不可删，保证账实可追溯 */
export async function deleteBatchGuarded(batchId: string): Promise<void> {
  const used = await db.paperOutbounds.where('batchId').equals(batchId).count()
  if (used > 0) throw new Error('该批次已有出库记录，不能删除；如已停发请改为封批')
  await db.paperBatches.delete(batchId)
}

/**
 * 历史数据回填：补纸没有批次归属时按「纸种 + 帘纹」匹配，
 * 同档多批取与补纸记录 ΔE 最近者；回填不了（库中无同纸种帘纹批次）返回 null，照旧可查。
 */
export function backfillBatchForPaper(
  paper: { paperType: PaperBatch['paperType']; laidPattern: string; deltaE: number },
  batches: PaperBatch[]
): string | null {
  const matched = batches
    .filter((batch) => batch.paperType === paper.paperType && batch.laidPattern === paper.laidPattern)
    .sort((a, b) => {
      const gapA = Math.abs(a.colorDelta - paper.deltaE)
      const gapB = Math.abs(b.colorDelta - paper.deltaE)
      if (gapA !== gapB) return gapA - gapB
      if (a.batchNo !== b.batchNo) return a.batchNo.localeCompare(b.batchNo, 'zh-Hans-CN')
      return a.id.localeCompare(b.id)
    })
  return matched[0]?.id ?? null
}
