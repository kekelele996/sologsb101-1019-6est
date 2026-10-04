/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：新增纸库批次 / 出库流水 / 领用单三张表，Paper 增加 batchId
 *           并按纸种 + 帘纹（色差最近）回填批次归属，回填不了置空照旧可查
 * - 九张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { PaperBatch, PaperOutbound, PaperRequisition } from '@/types/warehouse'
import { backfillBatchForPaper } from '@/utils/warehouse'

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
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  paperBatches!: Table<PaperBatch, string>
  paperOutbounds!: Table<PaperOutbound, string>
  paperRequisitions!: Table<PaperRequisition, string>

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
    // v3：接入纸库——批次 / 出库流水 / 领用单；Paper 增加 batchId 并按纸种 + 帘纹回填
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, batchId, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        paperBatches: 'id, batchNo, paperType, laidPattern, sealed, updatedAt',
        paperOutbounds: 'id, batchId, requisitionId, date, createdAt',
        paperRequisitions: 'id, leafId, paperType, laidPattern, status, date, createdAt'
      })
      .upgrade(async (tx) => {
        // 历史补纸没有批次归属：按纸种 + 帘纹回填（同档取色差最近），回填不了置 null
        const batches = await tx.table<PaperBatch>('paperBatches').toArray()
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (paper.batchId === undefined || paper.batchId === '') {
              paper.batchId = backfillBatchForPaper(paper, batches)
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
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, batchId: null, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, batchId: null, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, batchId: null, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, batchId: null, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, batchId: null, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  // 纸库批次台账：入库张数 + 封批情况；竹纸二指帘有两档（近色已封批，登记领用时顺延）
  const batches: PaperBatch[] = [
    { id: 'batch_01', batchNo: 'ZC-2025-118', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, colorDelta: 1.2, quantityIn: 200, sealed: false, note: '富阳产，色最接近', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'batch_02', batchNo: 'ZC-2025-117', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, colorDelta: 2.0, quantityIn: 120, sealed: true, note: '已封批，停发待复检', createdAt: now - day * 31, updatedAt: now - day * 6 },
    { id: 'batch_03', batchNo: 'PC-2025-206', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, colorDelta: 3.4, quantityIn: 80, sealed: false, note: '桑皮纸', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'batch_04', batchNo: 'ZC-2025-120', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, colorDelta: 1.0, quantityIn: 60, sealed: false, note: '', createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'batch_05', batchNo: 'PC-2025-198', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, colorDelta: 5.0, quantityIn: 40, sealed: false, note: '偏深批次', createdAt: now - day * 50, updatedAt: now - day * 50 },
    { id: 'batch_06', batchNo: 'XZ-2026-002', paperType: 'xuan', laidPattern: '无帘纹', thicknessMm: 0.05, colorDelta: 2.4, quantityIn: 150, sealed: false, note: '无细帘纹档，仅作色样对照', createdAt: now - day * 22, updatedAt: now - day * 22 }
  ]

  // 历史补纸按纸种 + 帘纹回填批次归属；回填不了的（如宣纸细帘纹）保持 null，照旧可查
  papers.forEach((paper) => {
    paper.batchId = backfillBatchForPaper(paper, batches)
  })

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

  // 领用示例：leaf_010101 领竹纸二指帘 3 张（目标 ΔE 1.4），当下在库 batch_01 最近且足量
  const requisitions: PaperRequisition[] = [
    {
      id: 'req_0101',
      requester: '沈玉',
      leafId: 'leaf_010101',
      paperType: 'bamboo',
      laidPattern: '二指帘纹',
      targetDeltaE: 1.4,
      quantity: 3,
      allocations: [{ batchId: 'batch_01', batchNo: 'ZC-2025-118', quantity: 3, colorGap: 0.2 }],
      status: 'active',
      returnedAt: null,
      returnReason: '',
      date: '2026-03-05',
      createdAt: now - day * 14,
      updatedAt: now - day * 14
    }
  ]

  const outbounds: PaperOutbound[] = [
    { id: 'out_0101', batchId: 'batch_01', requisitionId: 'req_0101', quantity: 3, operator: '沈玉', date: '2026-03-05', createdAt: now - day * 14, updatedAt: now - day * 14 }
  ]

  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperBatches, db.paperOutbounds, db.paperRequisitions],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.paperBatches.bulkPut(batches)
      await db.paperRequisitions.bulkPut(requisitions)
      await db.paperOutbounds.bulkPut(outbounds)
    }
  )
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
  repairOrders: RepairOrder[]
  bindings: Binding[]
  paperBatches: PaperBatch[]
  paperOutbounds: PaperOutbound[]
  paperRequisitions: PaperRequisition[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, paperBatches, paperOutbounds, paperRequisitions] = await Promise.all([
    db.books.toArray(),
    db.volumes.toArray(),
    db.leaves.toArray(),
    db.papers.toArray(),
    db.repairOrders.toArray(),
    db.bindings.toArray(),
    db.paperBatches.toArray(),
    db.paperOutbounds.toArray(),
    db.paperRequisitions.toArray()
  ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    paperBatches,
    paperOutbounds,
    paperRequisitions
  }
}

/**
 * 校验导入文件结构，返回错误文案（空串表示通过）。
 * 纸库三表为 v3 新增：旧备份缺失时按空集合处理（历史补纸 batchId 留空，照旧可查）。
 */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  const requiredKeys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'repairOrders',
    'bindings'
  ]
  for (const key of requiredKeys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperBatches, db.paperOutbounds, db.paperRequisitions],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.paperBatches.clear(),
        db.paperOutbounds.clear(),
        db.paperRequisitions.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      // 兼容 v2 旧备份：补纸没有批次归属时按纸种 + 帘纹回填，回填不了置 null
      const importedBatches = Array.isArray(snapshot.paperBatches) ? snapshot.paperBatches : []
      const normalizedPapers = snapshot.papers.map((paper) =>
        paper.batchId === undefined || paper.batchId === ''
          ? { ...paper, batchId: backfillBatchForPaper(paper, importedBatches) }
          : paper
      )
      await db.papers.bulkPut(normalizedPapers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      // 兼容 v2 旧备份：没有纸库三表时按空集合导入
      if (Array.isArray(snapshot.paperBatches)) await db.paperBatches.bulkPut(snapshot.paperBatches)
      if (Array.isArray(snapshot.paperRequisitions)) await db.paperRequisitions.bulkPut(snapshot.paperRequisitions)
      if (Array.isArray(snapshot.paperOutbounds)) await db.paperOutbounds.bulkPut(snapshot.paperOutbounds)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperBatches, db.paperOutbounds, db.paperRequisitions],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.paperBatches.clear(),
        db.paperOutbounds.clear(),
        db.paperRequisitions.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, paperBatches, paperOutbounds, paperRequisitions] = await Promise.all([
    db.books.count(),
    db.volumes.count(),
    db.leaves.count(),
    db.papers.count(),
    db.repairOrders.count(),
    db.bindings.count(),
    db.paperBatches.count(),
    db.paperOutbounds.count(),
    db.paperRequisitions.count()
  ])
  return { books, volumes, leaves, papers, repairOrders, bindings, paperBatches, paperOutbounds, paperRequisitions }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 纸库领用（含出库流水） */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  const requisitionIds = leafIds.length
    ? (await db.paperRequisitions.where('leafId').anyOf(leafIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperBatches, db.paperOutbounds, db.paperRequisitions],
    async () => {
      if (requisitionIds.length > 0) {
        await db.paperOutbounds.where('requisitionId').anyOf(requisitionIds).delete()
        await db.paperRequisitions.where('leafId').anyOf(leafIds).delete()
      }
      if (leafIds.length > 0) {
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

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 纸库领用（含出库流水） */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  const requisitionIds = leafIds.length
    ? (await db.paperRequisitions.where('leafId').anyOf(leafIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperOutbounds, db.paperRequisitions],
    async () => {
      if (requisitionIds.length > 0) {
        await db.paperOutbounds.where('requisitionId').anyOf(requisitionIds).delete()
        await db.paperRequisitions.where('leafId').anyOf(leafIds).delete()
      }
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 / 纸库领用（含出库流水） */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.leaves, db.papers, db.repairOrders, db.paperOutbounds, db.paperRequisitions],
    async () => {
      const requisitionIds = (await db.paperRequisitions.where('leafId').equals(leafId).toArray()).map((row) => row.id)
      if (requisitionIds.length > 0) {
        await db.paperOutbounds.where('requisitionId').anyOf(requisitionIds).delete()
      }
      await db.paperRequisitions.where('leafId').equals(leafId).delete()
      await db.papers.where('leafId').equals(leafId).delete()
      await db.repairOrders.where('leafId').equals(leafId).delete()
      await db.leaves.delete(leafId)
    }
  )
}
