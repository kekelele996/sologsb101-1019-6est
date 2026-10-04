/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：接入纸库（PaperBatch 批次、Requisition 领用），历史补纸按纸种 + 帘纹回填批次归属
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { PaperBatch } from '@/types/paperBatch'
import type { Requisition } from '@/types/requisition'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  paperBatches!: Table<PaperBatch, string>
  requisitions!: Table<Requisition, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：接入纸库批次与按叶领用；历史补纸无批次归属，按纸种 + 帘纹回填，回填不了的留空照旧可查
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, batchId, deltaE, updatedAt',
        paperBatches: 'id, batchNo, paperType, state, receivedDate, updatedAt',
        requisitions: 'id, leafId, batchId, state, date, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 升级的库批次表必为空：先播种纸库默认批次，供历史补纸回填。
        // 老用户没有领用流水，播种批次的已出库张数一律为 0，避免凭空产生对账差额。
        const batchCount = await tx.table<PaperBatch>('paperBatches').count()
        if (batchCount === 0) {
          const now = Date.now()
          await tx.table<PaperBatch>('paperBatches').bulkAdd(buildSeedBatches(now, { withIssued: false }))
        }
        const batches = await tx.table<PaperBatch>('paperBatches').toArray()
        // 历史补纸没有批次归属：按纸种 + 帘纹回填；回填不了的 batchId 保持空串
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (typeof paper.batchId !== 'string') paper.batchId = ''
            if (typeof paper.batchBackfilled !== 'boolean') paper.batchBackfilled = false
            if (paper.batchId) return
            const match = batches.find(
              (batch) => batch.paperType === paper.paperType && batch.laidPattern === paper.laidPattern
            )
            if (match) {
              paper.batchId = match.id
              paper.batchBackfilled = true
            }
          })
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, batchId: 'batch_01', batchBackfilled: false, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, batchId: 'batch_03', batchBackfilled: true, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, batchId: 'batch_05', batchBackfilled: false, createdAt: now - day * 12, updatedAt: now - day * 12 },
    // 无帘纹宣纸在纸库无同纸种 + 同帘纹批次：回填不了，batchId 留空，旧记录照旧可查
    { id: 'paper_0104', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '无帘纹', thicknessMm: 0.05, deltaE: 4.2, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, batchId: '', batchBackfilled: false, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, batchId: 'batch_02', batchBackfilled: false, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, batchId: 'batch_03', batchBackfilled: false, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  // 纸库批次：入库张数 / 已出库张数 / 封批状态由纸库侧管理
  const paperBatches: PaperBatch[] = buildSeedBatches(now)

  // 按叶领用：出库张数与批次 issuedSheets 对应；batch_04 另有 5 张出库无领用（对账不平演示）
  const requisitions: Requisition[] = [
    { id: 'req_0101', leafId: 'leaf_010101', batchId: 'batch_01', sheets: 3, date: '2026-03-04', operator: '沈玉', state: 'issued', selectedRank: 0, skipReason: 'none', availableSnapshot: 37, createdAt: now - day * 14, updatedAt: now - day * 14 },
    { id: 'req_0102', leafId: 'leaf_010102', batchId: 'batch_05', sheets: 4, date: '2026-03-05', operator: '沈玉', state: 'issued', selectedRank: 1, skipReason: 'insufficient', availableSnapshot: 16, createdAt: now - day * 13, updatedAt: now - day * 13 },
    { id: 'req_0201', leafId: 'leaf_020101', batchId: 'batch_02', sheets: 2, date: '2026-02-26', operator: '陆敏', state: 'issued', selectedRank: 0, skipReason: 'none', availableSnapshot: 28, createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'req_0202', leafId: 'leaf_020102', batchId: 'batch_01', sheets: 2, date: '2026-02-27', operator: '陆敏', state: 'issued', selectedRank: 0, skipReason: 'none', availableSnapshot: 35, createdAt: now - day * 21, updatedAt: now - day * 21 },
    { id: 'req_0301', leafId: 'leaf_030101', batchId: 'batch_03', sheets: 5, date: '2026-02-12', operator: '沈玉', state: 'issued', selectedRank: 0, skipReason: 'none', availableSnapshot: 25, createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'req_0302', leafId: 'leaf_030102', batchId: 'batch_03', sheets: 3, date: '2026-02-13', operator: '沈玉', state: 'issued', selectedRank: 0, skipReason: 'none', availableSnapshot: 20, createdAt: now - day * 39, updatedAt: now - day * 39 },
    // 已退回的领用不占在库余量，对账只汇总未退回部分
    { id: 'req_0103', leafId: 'leaf_010201', batchId: 'batch_02', sheets: 2, date: '2026-03-02', operator: '陆敏', state: 'returned', selectedRank: 0, skipReason: 'none', availableSnapshot: 30, createdAt: now - day * 9, updatedAt: now - day * 8 }
  ]

  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders, db.bindings],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.paperBatches.bulkPut(paperBatches)
      await db.requisitions.bulkPut(requisitions)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
    }
  )
}

/**
 * 纸库默认批次（首次播种与 v2→v3 升级共用）：
 * 覆盖在库、余量不足顺延、封批顺延与对账不平几种情形。
 * @param options.withIssued 是否带上演示用已出库张数（全新播种 true；老用户升级 false，避免凭空对账差额）
 */
export function buildSeedBatches(
  now: number,
  options: { withIssued?: boolean } = { withIssued: true }
): PaperBatch[] {
  const day = 86400000
  const withIssued = options.withIssued ?? true
  return [
    {
      id: 'batch_01',
      batchNo: '竹-2026-01',
      paperType: 'bamboo',
      laidPattern: '二指帘纹',
      thicknessMm: 0.06,
      deltaE: 1.4,
      receivedSheets: 40,
      issuedSheets: withIssued ? 5 : 0,
      state: 'in_stock',
      receivedDate: '2026-01-12',
      sealedDate: '',
      remark: '',
      createdAt: now - day * 50,
      updatedAt: now - day * 14
    },
    {
      id: 'batch_02',
      batchNo: '竹-2025-08',
      paperType: 'bamboo',
      laidPattern: '三指帘纹',
      thicknessMm: 0.06,
      deltaE: 0.9,
      receivedSheets: 30,
      issuedSheets: withIssued ? 2 : 0,
      state: 'in_stock',
      receivedDate: '2025-08-20',
      sealedDate: '',
      remark: '',
      createdAt: now - day * 60,
      updatedAt: now - day * 22
    },
    {
      id: 'batch_03',
      batchNo: '皮-2025-11',
      paperType: 'bark',
      laidPattern: '二指帘纹',
      thicknessMm: 0.08,
      deltaE: 3.2,
      receivedSheets: 30,
      issuedSheets: withIssued ? 8 : 0,
      state: 'in_stock',
      receivedDate: '2025-11-06',
      sealedDate: '',
      remark: '',
      createdAt: now - day * 55,
      updatedAt: now - day * 39
    },
    {
      id: 'batch_04',
      batchNo: '竹-2025-05',
      paperType: 'bamboo',
      laidPattern: '细帘纹',
      thicknessMm: 0.05,
      deltaE: 1.2,
      receivedSheets: 20,
      issuedSheets: withIssued ? 5 : 0,
      state: 'in_stock',
      receivedDate: '2025-05-18',
      sealedDate: '',
      remark: withIssued ? '早期批次，出库记录待与修复室核对' : '',
      createdAt: now - day * 90,
      updatedAt: now - day * 30
    },
    {
      id: 'batch_05',
      batchNo: '宣-2026-02',
      paperType: 'xuan',
      laidPattern: '细帘纹',
      thicknessMm: 0.05,
      deltaE: 2.4,
      receivedSheets: 20,
      issuedSheets: withIssued ? 4 : 0,
      state: 'in_stock',
      receivedDate: '2026-02-08',
      sealedDate: '',
      remark: '',
      createdAt: now - day * 35,
      updatedAt: now - day * 13
    },
    {
      id: 'batch_06',
      batchNo: '宣-2025-12',
      paperType: 'xuan',
      laidPattern: '细帘纹',
      thicknessMm: 0.05,
      deltaE: 2.0,
      receivedSheets: 50,
      issuedSheets: 0,
      state: 'in_stock',
      receivedDate: '2025-12-15',
      sealedDate: '',
      remark: '',
      createdAt: now - day * 45,
      updatedAt: now - day * 45
    },
    {
      id: 'batch_07',
      batchNo: '竹-2025-09',
      paperType: 'bamboo',
      laidPattern: '细帘纹',
      thicknessMm: 0.05,
      deltaE: 1.1,
      receivedSheets: 60,
      issuedSheets: 0,
      state: 'sealed',
      receivedDate: '2025-09-10',
      sealedDate: '2026-02-20',
      remark: '余批封存，不再出库',
      createdAt: now - day * 100,
      updatedAt: now - day * 20
    }
  ]
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  paperBatches: PaperBatch[]
  requisitions: Requisition[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, paperBatches, requisitions, repairOrders, bindings] = await Promise.all([
    db.books.toArray(),
    db.volumes.toArray(),
    db.leaves.toArray(),
    db.papers.toArray(),
    db.paperBatches.toArray(),
    db.requisitions.toArray(),
    db.repairOrders.toArray(),
    db.bindings.toArray()
  ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    paperBatches,
    requisitions,
    repairOrders,
    bindings
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  // v1/v2 备份没有 paperBatches / requisitions，导入时按空集合处理（兼容旧备份）
  const keys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'paperBatches',
    'requisitions',
    'repairOrders',
    'bindings'
  ]
  for (const key of keys) {
    if (snapshot[key] === undefined) {
      ;(snapshot as Record<string, unknown>)[key] = []
      continue
    }
    if (!Array.isArray(snapshot[key])) return `备份文件的 ${String(key)} 集合格式不正确`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  const paperBatches = snapshot.paperBatches ?? []
  const requisitions = snapshot.requisitions ?? []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders, db.bindings],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.paperBatches.clear(),
        db.requisitions.clear(),
        db.repairOrders.clear(),
        db.bindings.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(normalizeImportedPapers(snapshot.papers))
      await db.paperBatches.bulkPut(paperBatches)
      await db.requisitions.bulkPut(requisitions)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
    }
  )
}

/** 旧备份（v2 及以前）的补纸没有批次字段，补空值保证结构完整，旧记录照旧可查 */
function normalizeImportedPapers(papers: Paper[]): Paper[] {
  return papers.map((paper) => ({
    ...paper,
    batchId: typeof paper.batchId === 'string' ? paper.batchId : '',
    batchBackfilled: paper.batchBackfilled === true
  }))
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders, db.bindings],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.paperBatches.clear(),
        db.requisitions.clear(),
        db.repairOrders.clear(),
        db.bindings.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, paperBatches, requisitions, repairOrders, bindings] = await Promise.all([
    db.books.count(),
    db.volumes.count(),
    db.leaves.count(),
    db.papers.count(),
    db.paperBatches.count(),
    db.requisitions.count(),
    db.repairOrders.count(),
    db.bindings.count()
  ])
  return { books, volumes, leaves, papers, paperBatches, requisitions, repairOrders, bindings }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 领用 / 工序 / 装订 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders, db.bindings],
    async () => {
      if (leafIds.length > 0) {
        // 书叶下未退回的领用先按张数回退纸库批次出库量，再删领用单
        await rollbackRequisitionsByLeafIds(leafIds)
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 领用 / 工序 / 装订 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders, db.bindings],
    async () => {
      if (leafIds.length > 0) {
        await rollbackRequisitionsByLeafIds(leafIds)
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 领用（回退批次出库量）/ 工序 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.leaves, db.papers, db.paperBatches, db.requisitions, db.repairOrders],
    async () => {
      await rollbackRequisitionsByLeafIds([leafId])
      await db.papers.where('leafId').equals(leafId).delete()
      await db.repairOrders.where('leafId').equals(leafId).delete()
      await db.leaves.delete(leafId)
    }
  )
}

/** 事务内：回退书叶集合下未退回领用的批次出库张数，并删除这些领用单 */
async function rollbackRequisitionsByLeafIds(leafIds: string[]): Promise<void> {
  if (leafIds.length === 0) return
  const list = await db.requisitions.where('leafId').anyOf(leafIds).toArray()
  for (const item of list) {
    if (item.state !== 'issued' || !item.batchId) continue
    const batch = await db.paperBatches.get(item.batchId)
    if (batch) {
      await db.paperBatches.update(batch.id, {
        issuedSheets: Math.max(0, batch.issuedSheets - item.sheets)
      })
    }
  }
  await db.requisitions.where('leafId').anyOf(leafIds).delete()
}
