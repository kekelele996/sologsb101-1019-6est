/**
 * 纯逻辑验证（node 运行）：顺延挑选 + 对账 + 单叶退回
 * 不触 IndexedDB：直接构造批次 / 领用数据。
 */
import {
  availableSheets,
  batchCanSupply,
  rankBatches,
  reconcileRequisitions,
  selectBatch,
  type ReconcileResult
} from '../src/utils/paperRequisition'
import type { PaperBatch } from '../src/types/paperBatch'
import type { Requisition } from '../src/types/requisition'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

function batch(partial: Partial<PaperBatch>): PaperBatch {
  return {
    id: 'b',
    batchNo: 'B',
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    deltaE: 1,
    receivedSheets: 10,
    issuedSheets: 0,
    state: 'in_stock',
    receivedDate: '2026-01-01',
    sealedDate: '',
    remark: '',
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }
}

function req(partial: Partial<Requisition>): Requisition {
  return {
    id: 'r',
    leafId: 'leaf1',
    batchId: 'b1',
    sheets: 1,
    date: '2026-03-01',
    operator: '沈玉',
    state: 'issued',
    selectedRank: 0,
    skipReason: 'none',
    availableSnapshot: 0,
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }
}

console.log('1) 余量计算与可供应判断')
const enough = batch({ id: 'b1', receivedSheets: 10, issuedSheets: 3 })
assert(availableSheets(enough) === 7, '在库余量 = 入库 − 已出库 = 7')
assert(batchCanSupply(enough, 7) === true, '余量 7 可供应 7 张')
assert(batchCanSupply(enough, 8) === false, '余量 7 不足以供应 8 张')
const sealed = batch({ id: 'b2', state: 'sealed', receivedSheets: 100, issuedSheets: 0, sealedDate: '2026-02-01' })
assert(batchCanSupply(sealed, 1) === false, '已封批即使有货也不可供应')

console.log('2) 色差最近档被封批 → 顺延下一档')
{
  const nearest = batch({ id: 'near', deltaE: 1.0, receivedSheets: 50, issuedSheets: 0, state: 'sealed' })
  const second = batch({ id: 'second', deltaE: 2.0, receivedSheets: 50, issuedSheets: 0 })
  const ranked = rankBatches([nearest, second], { targetDeltaE: 1.0, sheets: 3 })
  assert(ranked[0].batch.id === 'near' && ranked[0].sealed, '第 1 档是色差最近且标记封批')
  const picked = selectBatch(ranked)
  assert(picked?.batch.id === 'second', '顺延选中第 2 档 second')
  assert(picked?.rank === 1 && picked.skipReason === 'sealed', '记录档位 1 与顺延原因 sealed')
}

console.log('3) 色差最近档余量不足 → 顺延下一档')
{
  const near = batch({ id: 'near', deltaE: 1.0, receivedSheets: 5, issuedSheets: 3 }) // 余 2
  const second = batch({ id: 'second', deltaE: 1.5, receivedSheets: 50, issuedSheets: 0 })
  const ranked = rankBatches([near, second], { targetDeltaE: 1.0, sheets: 4 })
  assert(ranked[0].insufficient && !ranked[0].selectable, '第 1 档余量不足不可选')
  const picked = selectBatch(ranked)
  assert(picked?.batch.id === 'second' && picked.skipReason === 'insufficient', '顺延选 second，原因 insufficient')
  assert(picked.availableSnapshot === 50, '选中时余量快照 50')
}

console.log('4) 全部封存 / 不足 → 选不出批次')
{
  const sealedAll = batch({ id: 's', state: 'sealed', receivedSheets: 50 })
  const empty = batch({ id: 'e', receivedSheets: 5, issuedSheets: 5 })
  const picked = selectBatch(rankBatches([sealedAll, empty], { targetDeltaE: 1, sheets: 2 }))
  assert(picked === null, '无可用批次时返回 null（登记应报错）')
}

console.log('5) 对账：对平 / 出库多于领用 / 退回不参与')
{
  const b1 = batch({ id: 'b1', batchNo: 'B1', issuedSheets: 5 })
  const b2 = batch({ id: 'b2', batchNo: 'B2', issuedSheets: 8 })
  const requisitions = [
    req({ id: 'r1', leafId: 'leaf1', batchId: 'b1', sheets: 3 }),
    req({ id: 'r2', leafId: 'leaf2', batchId: 'b1', sheets: 2 }), // b1 合计 5 对平
    req({ id: 'r3', leafId: 'leaf3', batchId: 'b2', sheets: 6 }), // b2 出库 8 − 领用 6 = +2
    req({ id: 'r4', leafId: 'leaf4', batchId: 'b2', sheets: 9, state: 'returned' }) // 已退回不计
  ]
  const result: ReconcileResult = reconcileRequisitions([b1, b2], requisitions)
  const row1 = result.rows.find((r) => r.batchId === 'b1')!
  const row2 = result.rows.find((r) => r.batchId === 'b2')!
  assert(row1.matched && row1.diff === 0, 'b1 出库 5 = 领用 5，对平')
  assert(row1.leafLines.length === 2, 'b1 按叶拆成两条（leaf1=3, leaf2=2）')
  assert(!row2.matched && row2.diff === 2, 'b2 出库 8 − 领用 6 = +2，对不上')
  assert(result.matchedCount === 1 && result.mismatchCount === 1, '对平 1 批、对不上 1 批')
  const leaf3 = row2.leafLines.find((l) => l.leafId === 'leaf3')!
  assert(leaf3.sheets === 6, '对不上批次可定位到具体叶 leaf3 = 6 张（只退这一叶）')
}

console.log('6) 历史领用无批次归属 → 照旧可查')
{
  const b1 = batch({ id: 'b1', issuedSheets: 0 })
  const requisitions = [req({ id: 'r1', batchId: '', sheets: 4 })]
  const result = reconcileRequisitions([b1], requisitions)
  assert(result.unassignedSheets === 4, '无批次归属的 4 张计入 unassignedSheets，不丢数据')
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
