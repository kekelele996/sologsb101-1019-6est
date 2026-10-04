/**
 * 补纸领用分配工具（纯函数）
 * - 按纸库当下批次挑批次：色差最近优先，已封批或在库余量不足顺延下一档
 * - 领用汇总按批次与纸库出库记录（batch.issuedSheets）对账
 * 不触碰 IndexedDB，事务封装在 paperStore 中。
 */
import type { PaperBatch } from '@/types/paperBatch'
import type { BatchSkipReason, Requisition } from '@/types/requisition'
import { laidPatternMatch } from './paperColor'

/** 批次当下在库余量 = 入库张数 − 已出库张数 */
export function availableSheets(batch: PaperBatch): number {
  return Math.max(0, batch.receivedSheets - batch.issuedSheets)
}

export function isBatchSealed(batch: PaperBatch): boolean {
  return batch.state === 'sealed'
}

/** 批次是否可满足本次领用：未封批且在库余量足够 */
export function batchCanSupply(batch: PaperBatch, sheets: number): boolean {
  return !isBatchSealed(batch) && availableSheets(batch) >= sheets
}

export interface RankedBatch {
  batch: PaperBatch
  /** 档位，0 为色差最近的一档 */
  rank: number
  /** 与目标 ΔE 的差距，越小越近 */
  deltaGap: number
  /** 当下在库余量 */
  available: number
  /** 该档是否被封批 */
  sealed: boolean
  /** 该档是否余量不足 */
  insufficient: boolean
  /** 本档能否满足本次领用 */
  selectable: boolean
  /** 不可选时的原因 */
  blockedReason: BatchSkipReason
}

export interface RankBatchesOptions {
  /** 目标 ΔE：取自已登记的配纸记录，或按书叶破损色调估算 */
  targetDeltaE: number
  /** 需求张数 */
  sheets: number
  /** 期望帘纹（取自已登记配纸），仅作同色差下的排序参考 */
  preferredPattern?: string
  /** 目标厚度 mm，同色差下优先接近者 */
  leafThicknessMm?: number
}

/**
 * 按色差由近到远给纸库批次排档：
 * 1) 与目标 ΔE 差距升序（色差最近优先）
 * 2) 同色差档：帘纹匹配度降序
 * 3) 再同：厚度接近度、入库时间新者优先
 */
export function rankBatches(batches: PaperBatch[], options: RankBatchesOptions): RankedBatch[] {
  const thickness = options.leafThicknessMm ?? 0.06
  const sorted = [...batches].sort((a, b) => {
    const gapA = Math.abs(a.deltaE - options.targetDeltaE)
    const gapB = Math.abs(b.deltaE - options.targetDeltaE)
    if (gapA !== gapB) return gapA - gapB
    const matchA = options.preferredPattern ? laidPatternMatch(a.laidPattern, options.preferredPattern) : 0
    const matchB = options.preferredPattern ? laidPatternMatch(b.laidPattern, options.preferredPattern) : 0
    if (matchA !== matchB) return matchB - matchA
    const thickA = Math.abs(a.thicknessMm - thickness)
    const thickB = Math.abs(b.thicknessMm - thickness)
    if (thickA !== thickB) return thickA - thickB
    return b.receivedDate.localeCompare(a.receivedDate)
  })
  return sorted.map((batch, index) => {
    const available = availableSheets(batch)
    const sealed = isBatchSealed(batch)
    const insufficient = !sealed && available < options.sheets
    let blockedReason: BatchSkipReason = 'none'
    if (sealed) blockedReason = 'sealed'
    else if (insufficient) blockedReason = 'insufficient'
    return {
      batch,
      rank: index,
      deltaGap: Math.round(Math.abs(batch.deltaE - options.targetDeltaE) * 100) / 100,
      available,
      sealed,
      insufficient,
      selectable: blockedReason === 'none',
      blockedReason
    }
  })
}

export interface BatchSelection {
  batch: PaperBatch
  /** 选中档位（0 = 色差最近档） */
  rank: number
  /** 首选档未采用的原因；选中第 0 档时为 none */
  skipReason: BatchSkipReason
  /** 登记当下该批次在库余量快照 */
  availableSnapshot: number
}

/**
 * 从排档结果中挑选可满足领用的批次：
 * 色差最近的一档已封批或余量不足时，顺延下一档。
 * 全部不可用时返回 null。
 */
export function selectBatch(ranked: RankedBatch[]): BatchSelection | null {
  const first = ranked[0]
  const chosen = ranked.find((item) => item.selectable)
  if (!first || !chosen) return null
  let skipReason: BatchSkipReason = 'none'
  if (chosen.rank > 0) {
    // 记录「色差最近的一档」为何被顺延
    skipReason = first.sealed ? 'sealed' : first.insufficient ? 'insufficient' : first.blockedReason
  }
  return {
    batch: chosen.batch,
    rank: chosen.rank,
    skipReason,
    availableSnapshot: chosen.available
  }
}

/* ------------------------------ 对账 ------------------------------ */

export interface ReconcileLeafLine {
  leafId: string
  requisitionIds: string[]
  sheets: number
}

export interface ReconcileBatchRow {
  batchId: string
  batch: PaperBatch | null
  /** 纸库出库记录：该批已出库张数 */
  issuedSheets: number
  /** 修复室领用汇总（仅未退回的领用）张数 */
  requisitionSheets: number
  /** 出库 − 领用；0 为对平 */
  diff: number
  matched: boolean
  requisitionCount: number
  leafLines: ReconcileLeafLine[]
  /** 领用指向的批次已不存在（纸库查无此批） */
  orphan: boolean
}

export interface ReconcileResult {
  rows: ReconcileBatchRow[]
  matchedCount: number
  mismatchCount: number
  /** 历史未归属批次（升级回填不了）的领用，照旧可查 */
  unassignedSheets: number
}

/**
 * 领用汇总按批次对账：
 * 已领用（未退回）的领用单按批次汇总张数，与纸库批次的已出库张数比对。
 */
export function reconcileRequisitions(
  batches: PaperBatch[],
  requisitions: Requisition[]
): ReconcileResult {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]))
  const active = requisitions.filter((item) => item.state === 'issued')

  const groups = new Map<string, Requisition[]>()
  let unassignedSheets = 0
  active.forEach((item) => {
    if (!item.batchId || !batchMap.has(item.batchId)) {
      unassignedSheets += item.sheets
      if (!item.batchId) return
    }
    const key = item.batchId || '(unassigned)'
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  })

  const rows: ReconcileBatchRow[] = []
  // 以纸库批次为骨架，逐批比对；再补上指向已删批次的领用组
  batchMap.forEach((batch, batchId) => {
    const list = groups.get(batchId) ?? []
    rows.push(buildRow(batchId, batch, list))
    groups.delete(batchId)
  })
  groups.forEach((list, key) => {
    if (key === '(unassigned)') return
    rows.push(buildRow(key, null, list))
  })

  rows.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? 1 : -1
    return (a.batch?.batchNo ?? '').localeCompare(b.batch?.batchNo ?? '')
  })

  const mismatchCount = rows.filter((row) => !row.matched).length
  return {
    rows,
    matchedCount: rows.length - mismatchCount,
    mismatchCount,
    unassignedSheets
  }
}

function buildRow(batchId: string, batch: PaperBatch | null, list: Requisition[]): ReconcileBatchRow {
  const leafMap = new Map<string, Requisition[]>()
  list.forEach((item) => {
    const leafList = leafMap.get(item.leafId) ?? []
    leafList.push(item)
    leafMap.set(item.leafId, leafList)
  })
  const leafLines: ReconcileLeafLine[] = Array.from(leafMap.entries())
    .map(([leafId, items]) => ({
      leafId,
      requisitionIds: items.map((item) => item.id),
      sheets: items.reduce((sum, item) => sum + item.sheets, 0)
    }))
    .sort((a, b) => a.leafId.localeCompare(b.leafId))
  const requisitionSheets = list.reduce((sum, item) => sum + item.sheets, 0)
  const issuedSheets = batch?.issuedSheets ?? 0
  return {
    batchId,
    batch,
    issuedSheets,
    requisitionSheets,
    diff: issuedSheets - requisitionSheets,
    matched: issuedSheets === requisitionSheets,
    requisitionCount: list.length,
    leafLines,
    orphan: batch === null
  }
}
