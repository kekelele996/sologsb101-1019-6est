/**
 * 补纸领用（Requisition）数据模型
 * 修复师按叶登记领用：登记时按纸库当下在库批次挑选，
 * 色差最近的批次张数不够或已封批就顺延下一档；
 * 领用汇总按批次与纸库出库记录对账，对不上只退回本叶领用，其他书叶不受影响。
 */

/** 领用单状态：已领用（已出库）/ 已退回（已退库，不占批次库存） */
export type RequisitionState = 'issued' | 'returned'

/**
 * 批次挑选依据（登记 / 重新领用当下的快照）：
 * 记录「首选批次被顺延」的原因，便于修复师核对配纸过程。
 */
export type BatchSkipReason = 'none' | 'sealed' | 'insufficient'

export interface Requisition {
  id: string
  /** 关联书叶 id（按叶领用，退回也只退这一叶） */
  leafId: string
  /** 指向纸库批次 id；v3 前的历史领用按纸种 + 帘纹回填，回填不了为空串 */
  batchId: string
  /** 领用张数（正整数） */
  sheets: number
  /** 领用日期 yyyy-MM-dd */
  date: string
  /** 领用人 */
  operator: string
  /** 状态：已领用 / 已退回 */
  state: RequisitionState
  /** 登记时按色差顺延选中的候选档位（0 = 色差最近的在库批次） */
  selectedRank: number
  /** 首选批次未被采用的原因 */
  skipReason: BatchSkipReason
  /** 登记时该批次的在库余量快照，便于事后核对 */
  availableSnapshot: number
  createdAt: number
  updatedAt: number
}

export type RequisitionDraft = Omit<Requisition, 'id' | 'createdAt' | 'updatedAt'>

export const REQUISITION_STATE_LABEL: Record<RequisitionState, string> = {
  issued: '已领用',
  returned: '已退回'
}

export const REQUISITION_STATE_COLOR: Record<RequisitionState, string> = {
  issued: '#1e8449',
  returned: '#8c8c8c'
}

export const SKIP_REASON_LABEL: Record<BatchSkipReason, string> = {
  none: '首选批次',
  sealed: '首选已封批，顺延下一档',
  insufficient: '首选余量不足，顺延下一档'
}

export function createEmptyRequisitionDraft(leafId: string): RequisitionDraft {
  return {
    leafId,
    batchId: '',
    sheets: 1,
    date: new Date().toISOString().slice(0, 10),
    operator: '',
    state: 'issued',
    selectedRank: 0,
    skipReason: 'none',
    availableSnapshot: 0
  }
}
