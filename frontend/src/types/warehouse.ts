/**
 * 纸库（Warehouse）数据模型
 * - PaperBatch：纸库批次台账，记每批补纸的入库张数、批次色差与封批情况
 * - PaperOutbound：纸库出库流水（账实凭证）
 * - PaperRequisition：修复师领用单（书叶粒度），内含按批次的实际分配明细
 *
 * 领用规则：按纸库「当下在库」的批次挑——同纸种同帘纹、色差最近的批次
 * 张数不够或已封批就顺延下一档；领用汇总按批次与出库流水逐批对账，
 * 对不上只退回该叶的领用，其他书叶照旧。
 */
import type { PaperType } from './paper'

/** 封批情况：在库可领 / 已封批停发 */
export type BatchSealState = 'open' | 'sealed'

export interface PaperBatch {
  id: string
  /** 批次号，如「ZC-2026-03」 */
  batchNo: string
  /** 纸种 */
  paperType: PaperType
  /** 帘纹，如「二指帘纹」 */
  laidPattern: string
  /** 厚度 mm */
  thicknessMm: number
  /** 该批补纸对标准色样的色差 ΔE；领用时按与目标 ΔE 的接近度排序 */
  colorDelta: number
  /** 入库张数 */
  quantityIn: number
  /** 是否已封批（封批后停发，登记领用时顺延下一档） */
  sealed: boolean
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

export interface PaperOutbound {
  id: string
  /** 来源批次 id */
  batchId: string
  /** 所属领用单 id（书叶粒度） */
  requisitionId: string
  /** 出库张数 */
  quantity: number
  /** 经办人 */
  operator: string
  /** 出库日期 YYYY-MM-DD */
  date: string
  createdAt: number
  updatedAt: number
}

/** 领用单上的单批分配明细（按批次的领用汇总据此生成） */
export interface RequisitionAllocation {
  batchId: string
  /** 冗余批次号，批次删除后仍可核对 */
  batchNo: string
  /** 从该批领用的张数 */
  quantity: number
  /** 该档与目标色差的差距 |批次 ΔE − 目标 ΔE|，体现顺延了几档 */
  colorGap: number
}

/** 领用单状态：领用中（有出库占用库存）/ 已退回（出库流水已删、库存还回） */
export type RequisitionStatus = 'active' | 'returned'

export interface PaperRequisition {
  id: string
  /** 领用修复师 */
  requester: string
  /** 关联书叶 id：对账不符只退回这一叶的领用 */
  leafId: string
  /** 要求纸种 */
  paperType: PaperType
  /** 要求帘纹 */
  laidPattern: string
  /** 目标色差 ΔE（取自选配记录） */
  targetDeltaE: number
  /** 登记领用张数 */
  quantity: number
  /** 按批次的实际分配（可跨批凑齐） */
  allocations: RequisitionAllocation[]
  status: RequisitionStatus
  /** 退回时间戳，未退回为 null */
  returnedAt: number | null
  /** 退回原因（对账不符时记下差异批次） */
  returnReason: string
  /** 领用日期 YYYY-MM-DD */
  date: string
  createdAt: number
  updatedAt: number
}

export type PaperBatchDraft = Omit<PaperBatch, 'id' | 'createdAt' | 'updatedAt'>

export interface RequisitionDraft {
  requester: string
  leafId: string
  paperType: PaperType
  laidPattern: string
  targetDeltaE: number
  quantity: number
  date: string
}

export const BATCH_SEAL_LABEL: Record<BatchSealState, string> = {
  open: '在库',
  sealed: '已封批'
}

export const REQUISITION_STATUS_LABEL: Record<RequisitionStatus, string> = {
  active: '领用中',
  returned: '已退回'
}

export function createEmptyBatchDraft(): PaperBatchDraft {
  return {
    batchNo: '',
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    colorDelta: 1.5,
    quantityIn: 100,
    sealed: false,
    note: ''
  }
}
