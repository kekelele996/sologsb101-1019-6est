/**
 * IndexedDB 集成验证（node + fake-indexeddb）：
 * A. v2 旧库 → v3：播种纸库批次；历史补纸按纸种 + 帘纹回填，回填不了留空
 * B. 全新播种 → store 事务：按色差顺延出库、出库回写、只退本叶、对账
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { setActivePinia, createPinia } from 'pinia'
import { DB_NAME, db, initDatabase } from '../src/utils/db'
import { DEFAULT_DYE_RECIPE } from '../src/types/paper'
import { usePaperStore } from '../src/stores/paperStore'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

async function wipe(): Promise<void> {
  await db.close()
  await Dexie.delete(DB_NAME)
}

async function buildV2Database(): Promise<void> {
  // 用旧版（v2）结构建库并写入无批次归属的历史补纸
  const legacy = new Dexie(DB_NAME)
  legacy.version(2).stores({
    books: 'id, title, era, level, collectionNo, updatedAt',
    volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
    leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
    papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
    repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
    bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
  })
  await legacy.table('books').bulkAdd([
    { id: 'book_x', title: '旧本', edition: '旧刻', era: '明', volumeCount: 1, collectionNo: '', level: 'ordinary', createdAt: 1, updatedAt: 1 }
  ])
  await legacy.table('papers').bulkAdd([
    // 竹纸 + 二指帘纹：应回填到 batch_01
    {
      id: 'p_old_match',
      leafId: 'leaf_x',
      paperType: 'bamboo',
      laidPattern: '二指帘纹',
      thicknessMm: 0.06,
      deltaE: 1.4,
      dyeRecipe: DEFAULT_DYE_RECIPE.bamboo,
      createdAt: 1,
      updatedAt: 1
    },
    // 宣纸 + 无帘纹：升级播种的批次里没有同纸种同帘纹 → 回填不了，留空照旧可查
    {
      id: 'p_old_orphan',
      leafId: 'leaf_x',
      paperType: 'xuan',
      laidPattern: '无帘纹',
      thicknessMm: 0.05,
      deltaE: 4,
      dyeRecipe: DEFAULT_DYE_RECIPE.xuan,
      createdAt: 1,
      updatedAt: 1
    }
  ])
  await legacy.close()
}

async function main(): Promise<void> {
  /* ---------------- A. v2 → v3 升级 ---------------- */
  console.log('A) v2 旧库升级到 v3')
  await wipe()
  await buildV2Database()
  await db.open()
  const batchCount = await db.paperBatches.count()
  assert(batchCount === 7, `升级时播种 7 个纸库批次（实际 ${batchCount}）`)
  const matched = await db.papers.get('p_old_match')
  assert(matched?.batchId === 'batch_01', '竹纸二指帘纹历史补纸按纸种 + 帘纹回填到 batch_01')
  assert(matched?.batchBackfilled === true, '回填记录标记 batchBackfilled=true')
  const orphan = await db.papers.get('p_old_orphan')
  assert(orphan?.batchId === '', '无同纸种同帘纹批次的历史补纸回填不了，batchId 保持空串')
  assert(orphan?.batchBackfilled === false && orphan.deltaE === 4, '回填不了的旧记录字段照旧保留可查')
  const upgradeIssued = await db.paperBatches.toArray()
  assert(
    upgradeIssued.every((b) => b.issuedSheets === 0),
    '升级播种的批次已出库张数一律为 0（老用户无领用流水，不凭空产生对账差额）'
  )
  const upgradeReqs = await db.requisitions.count()
  assert(upgradeReqs === 0, '升级不凭空生成领用单')

  /* ---------------- B. 全新播种 + store 事务 ---------------- */
  console.log('\nB) 全新播种后的领用与对账')
  await wipe()
  await initDatabase()
  setActivePinia(createPinia())
  const store = usePaperStore()
  await store.loadPaperData()

  const initial = store.reconciliation
  assert(initial.matchedCount === 6 && initial.mismatchCount === 1, `播种数据 6 批对平、1 批对不上（batch_04）（实际 ${initial.matchedCount}/${initial.mismatchCount}）`)

  // B1. 首选批次色差最近且足够 → batch_01（ΔE 1.4），出库 6 张
  const leaf = 'leaf_010101'
  await store.registerRequisition({
    leafId: leaf,
    sheets: 6,
    operator: '测试',
    date: '2026-10-04',
    paperType: 'bamboo',
    targetDeltaE: 1.4,
    preferredPattern: '二指帘纹',
    leafThicknessMm: 0.06
  })
  const b01 = await db.paperBatches.get('batch_01')
  assert(b01?.issuedSheets === 11, 'batch_01 已出库 5 + 6 = 11')
  const newReq = (await db.requisitions.where('leafId').equals(leaf).toArray()).find((r) => r.date === '2026-10-04')!
  assert(newReq && newReq.batchId === 'batch_01' && newReq.selectedRank === 0 && newReq.skipReason === 'none', '领用单指向首选档且无顺延')

  // B2. 首选余量不足 → 顺延：leaf_020101 竹纸目标 ΔE 0.9，要 29 张
  // 第 1 档 batch_02（余 28）不足 → batch_07 封存 → batch_04 余 15 不足 → batch_01 余 29 可出
  await store.registerRequisition({
    leafId: 'leaf_020101',
    sheets: 29,
    operator: '测试',
    date: '2026-10-04',
    paperType: 'bamboo',
    targetDeltaE: 0.9,
    preferredPattern: '三指帘纹',
    leafThicknessMm: 0.06
  })
  const skipReq = (await db.requisitions.where('leafId').equals('leaf_020101').toArray()).find((r) => r.date === '2026-10-04')!
  assert(skipReq.batchId === 'batch_01' && skipReq.selectedRank === 3, '首选不足并跳过封批档后顺延到第 4 档 batch_01')
  assert(skipReq.skipReason === 'insufficient', '顺延原因记录为 insufficient')
  const b01after = await db.paperBatches.get('batch_01')
  assert(b01after?.issuedSheets === 40, 'batch_01 出库 11 + 29 = 40（余量归零）')
  const linked = await db.papers.get('paper_0201')
  assert(linked?.batchId === 'batch_01' && linked.batchBackfilled === false, '同叶同纸种配纸记录接上领用批次，且不再标记回填')

  // B3. 全部不可用 → 报错（batch_01 余 0、batch_02 余 28、batch_04 余 15、batch_07 封）
  let threw = ''
  try {
    await store.registerRequisition({
      leafId: 'leaf_010102',
      sheets: 30,
      operator: '测试',
      date: '2026-10-04',
      paperType: 'bamboo',
      targetDeltaE: 1.4,
      preferredPattern: '细帘纹',
      leafThicknessMm: 0.05
    })
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  assert(threw.length > 0, `没有在库且足够的批次时登记被拒绝：${threw}`)

  // B4. 只退这一叶：退回 req_0101（leaf_010101，3 张）；req_0202（leaf_020102，2 张）不受影响
  const before0202 = (await db.requisitions.get('req_0202'))!
  assert(before0202.state === 'issued', '退回前其他书叶领用为已领用')
  await store.returnRequisition('req_0101')
  const b01final = await db.paperBatches.get('batch_01')
  assert(b01final?.issuedSheets === 37, '退回本叶 3 张后 batch_01 出库 40 − 3 = 37')
  const r0101 = await db.requisitions.get('req_0101')
  const r0202 = await db.requisitions.get('req_0202')
  assert(r0101?.state === 'returned', '被退叶领用标记为已退回')
  assert(r0202?.state === 'issued', '别的书叶领用照旧（未受影响）')

  // 退回后该批对账仍平：出库 37 = 新领用6 + skip 29 + req_0202 2
  await store.loadPaperData()
  const row01 = store.reconciliation.rows.find((r) => r.batchId === 'batch_01')!
  assert(row01.requisitionSheets === 37 && row01.matched, '退回后批次对账重新对平（37 = 6 + 29 + 2）')

  // B5. 同批两叶各有领用，只退其中一叶：batch_03 上 leaf_030101=5、leaf_030102=3
  const count = await store.returnLeafBatchRequisitions('leaf_030101', 'batch_03')
  assert(count === 1, '按叶退回命中 leaf_030101 的 1 张领用单')
  const b03 = await db.paperBatches.get('batch_03')
  assert(b03?.issuedSheets === 3, '只退回该叶 5 张后 batch_03 出库 8 − 5 = 3')
  const otherLeaf = await db.requisitions.get('req_0302')
  assert(otherLeaf?.state === 'issued', '同批另一叶 leaf_030102 的 3 张领用照旧')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main()
