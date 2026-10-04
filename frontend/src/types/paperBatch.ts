/**
 * 纸库补纸批次（PaperBatch）数据模型
 * 纸库侧按批管理补纸入库：每批有纸种、帘纹、厚度、批次色差 ΔE，
 * 以及入库张数、已出库张数（以领用单为唯一出库记录）和封批状态。
 * 修复室的领用（Requisition）必须指向当下在库且张数足够的批次。
 */
import type { PaperType } from './paper'

/** 批次状态：在库 / 已封批 */
export type BatchState = 'in_stock' | 'sealed'

export interface PaperBatch {
  id: string
  /** 批次号，如「竹-2026-01」 */
  batchNo: string
  /** 纸种 */
  paperType: PaperType
  /** 帘纹，如「二指帘纹」 */
  laidPattern: string
  /** 厚度 mm */
  thicknessMm: number
  /** 该批补纸与书叶比对时的基准色差 ΔE（配纸排序用） */
  deltaE: number
  /** 入库张数 */
  receivedSheets: number
  /** 已出库张数：仅由领用出库 / 退库回写 */
  issuedSheets: number
  /** 封批状态；封批后不再参与领用 */
  state: BatchState
  /** 入库日期 yyyy-MM-dd */
  receivedDate: string
  /** 封批日期 yyyy-MM-dd，未封为空串 */
  sealedDate: string
  /** 备注（封批原因等） */
  remark: string
  createdAt: number
  updatedAt: number
}

export type PaperBatchDraft = Omit<PaperBatch, 'id' | 'createdAt' | 'updatedAt'>

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  in_stock: '在库',
  sealed: '已封批'
}

export const BATCH_STATE_OPTIONS: ReadonlyArray<{ value: BatchState; label: string }> = [
  { value: 'in_stock', label: '在库' },
  { value: 'sealed', label: '已封批' }
]

/** 新建批次默认已出库 0、在库、未封 */
export function createEmptyBatchDraft(): PaperBatchDraft {
  return {
    batchNo: '',
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    deltaE: 1.5,
    receivedSheets: 50,
    issuedSheets: 0,
    state: 'in_stock',
    receivedDate: new Date().toISOString().slice(0, 10),
    sealedDate: '',
    remark: ''
  }
}
