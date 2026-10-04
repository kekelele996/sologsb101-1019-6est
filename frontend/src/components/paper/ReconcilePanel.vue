<script setup lang="ts">
/**
 * 领用汇总对账面板：
 * 按批次把修复室领用汇总与纸库出库记录（batch.issuedSheets）对账；
 * 对不上的批次逐叶展开，只退回这一叶的领用，别的书叶照旧。
 */
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, RefreshLeft } from '@element-plus/icons-vue'
import { usePaperStore } from '@/stores/paperStore'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import StatBadge from '@/components/common/StatBadge.vue'
import { PAPER_TYPE_LABEL, type PaperType } from '@/types/paper'
import { REQUISITION_STATE_COLOR, REQUISITION_STATE_LABEL } from '@/types/requisition'
import { exportPaperReconcileCsv } from '@/utils/export'
import type { ReconcileBatchRow } from '@/utils/paperRequisition'

const paperStore = usePaperStore()
const bookStore = useBookStore()
const leafStore = useLeafStore()

const reconciliation = computed(() => paperStore.reconciliation)
const issuedCount = computed(() => paperStore.requisitions.filter((item) => item.state === 'issued').length)
const returnedCount = computed(() => paperStore.requisitions.filter((item) => item.state === 'returned').length)

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return `书叶已删除（${leafId}）`
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function batchLabel(batchId: string): string {
  return paperStore.batchById(batchId)?.batchNo ?? '纸库查无此批'
}

/** 对不上的批次行底色高亮 */
function mismatchRowClass(data: { row: ReconcileBatchRow }): string {
  return data.row.matched ? '' : 'gb-row-mismatch'
}

/** 对账不平 → 只退回这一叶在该批次下的领用，其他书叶不动 */
async function returnLeafLine(rowBatchId: string, leafId: string, sheets: number): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将退回「${leafLabel(leafId)}」在批次「${batchLabel(rowBatchId)}」下未退回的 ${sheets} 张领用，并回退纸库出库；其他书叶的领用不受影响。`,
      '只退回这一叶的领用',
      { type: 'warning', confirmButtonText: '确认退回本叶', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await paperStore.returnLeafBatchRequisitions(leafId, rowBatchId)
  ElMessage.success(count > 0 ? `已退回该叶 ${sheets} 张领用，其他书叶照旧` : '该叶没有可退回的领用')
}

async function returnOne(requisitionId: string): Promise<void> {
  const target = paperStore.requisitions.find((item) => item.id === requisitionId)
  if (!target) return
  try {
    await ElMessageBox.confirm(
      `退回该领用单（${target.sheets} 张）后回退纸库出库，同书叶其他领用不受影响。`,
      '退回领用单',
      { type: 'warning', confirmButtonText: '确认退回', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await paperStore.returnRequisition(requisitionId)
  ElMessage.success('已退回该领用单')
}

function exportCsv(): void {
  const filename = exportPaperReconcileCsv({
    books: bookStore.books,
    volumes: bookStore.volumes,
    leaves: leafStore.leaves,
    papers: [],
    paperBatches: paperStore.batches,
    requisitions: paperStore.requisitions,
    repairOrders: [],
    bindings: []
  })
  ElMessage.success(`已导出 ${filename}`)
}
</script>

<template>
  <div>
    <div class="gb-stat-row">
      <StatBadge label="对账批次" :value="reconciliation.rows.length" suffix="批" tone="primary" />
      <StatBadge label="对平" :value="reconciliation.matchedCount" suffix="批" tone="success" />
      <StatBadge label="对不上" :value="reconciliation.mismatchCount" suffix="批" tone="danger" />
      <StatBadge label="未退回领用" :value="issuedCount" suffix="单" tone="info" />
      <StatBadge label="已退回" :value="returnedCount" suffix="单" tone="warning" />
    </div>

    <el-alert
      v-if="reconciliation.unassignedSheets > 0"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
      :title="`有 ${reconciliation.unassignedSheets} 张领用未归属现存批次（历史回填不了或批次已删），记录保留可查`"
    />

    <el-card shadow="never">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>领用汇总 × 纸库出库（按批次对账）</span>
          <el-button size="small" :icon="Download" @click="exportCsv">导出对账 CSV</el-button>
        </div>
      </template>

      <el-table
        :data="reconciliation.rows"
        size="small"
        border
        :row-class-name="mismatchRowClass"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 8px 16px">
              <el-table :data="row.leafLines" size="small" border>
                <el-table-column label="书叶（对不上时只退这一叶）" min-width="260">
                  <template #default="{ row: leafRow }">{{ leafLabel(leafRow.leafId) }}</template>
                </el-table-column>
                <el-table-column prop="sheets" label="该叶领用张数" width="130" />
                <el-table-column label="操作" width="160">
                  <template #default="{ row: leafRow }">
                    <el-button
                      size="small"
                      text
                      type="warning"
                      :icon="RefreshLeft"
                      :disabled="row.matched"
                      @click="returnLeafLine(row.batchId, leafRow.leafId, leafRow.sheets)"
                    >
                      只退回这一叶
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-if="row.leafLines.length === 0" :image-size="50" description="该批次没有未退回领用（纸库出库无对应领用）" />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="批次" min-width="150">
          <template #default="{ row }">
            <strong>{{ row.batch?.batchNo ?? '纸库查无此批' }}</strong>
            <div class="gb-muted">
              {{ row.batch ? `${PAPER_TYPE_LABEL[row.batch.paperType as PaperType]} · ${row.batch.laidPattern}` : '' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="纸库出库张数" width="120">
          <template #default="{ row }">{{ row.issuedSheets }}</template>
        </el-table-column>
        <el-table-column prop="requisitionSheets" label="领用汇总张数" width="120" />
        <el-table-column prop="requisitionCount" label="领用单数" width="90" />
        <el-table-column label="差额（出库 − 领用）" width="150">
          <template #default="{ row }">
            <el-tag :type="row.matched ? 'success' : 'danger'" effect="plain" size="small" round>
              {{ row.diff > 0 ? `+${row.diff}` : row.diff }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对账" width="100">
          <template #default="{ row }">
            <el-tag :type="row.matched ? 'success' : 'danger'" effect="plain" size="small" round>
              {{ row.matched ? '对平' : '对不上' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <p class="gb-muted" style="margin: 8px 0 0">
        点击行首箭头逐叶展开；对账对不上时用「只退回这一叶」回退该书叶领用并恢复批次在库余量，其他书叶领用照旧。
      </p>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>领用 / 退回流水（按叶）</template>
      <el-table :data="paperStore.requisitions" size="small" border>
        <el-table-column label="领用日期" prop="date" width="110" />
        <el-table-column label="书叶" min-width="220">
          <template #default="{ row }">{{ leafLabel(row.leafId) }}</template>
        </el-table-column>
        <el-table-column label="批次" width="130">
          <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
        </el-table-column>
        <el-table-column prop="sheets" label="张数" width="70" />
        <el-table-column prop="operator" label="领用人" width="90" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              :style="{ color: REQUISITION_STATE_COLOR[row.state as keyof typeof REQUISITION_STATE_COLOR] }"
              effect="plain"
              size="small"
              round
            >
              {{ REQUISITION_STATE_LABEL[row.state as keyof typeof REQUISITION_STATE_LABEL] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button
              v-if="row.state === 'issued'"
              size="small"
              text
              type="warning"
              :icon="RefreshLeft"
              @click="returnOne(row.id)"
            >
              退回
            </el-button>
            <span v-else class="gb-muted">已退库</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
:deep(.gb-row-mismatch) {
  background-color: #fdf3f2;
}
</style>
