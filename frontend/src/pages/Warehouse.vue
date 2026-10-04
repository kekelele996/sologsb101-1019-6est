<script setup lang="ts">
/**
 * /warehouse 纸库批次与领用对账
 * 三段：
 * 1. 批次台账：入库张数、封批情况、批次 ΔE 与当下在库
 * 2. 领用登记：按纸库当下在库顺延选批（封批 / 不足跳过），登记即写领用单 + 出库流水
 * 3. 领用对账：领用汇总按批次与出库流水逐批比对，对不上只退回该叶，别的叶照旧
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Lock, Plus, RefreshLeft, Unlock } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import {
  BATCH_SEAL_LABEL,
  REQUISITION_STATUS_LABEL,
  createEmptyBatchDraft,
  type PaperBatch,
  type PaperBatchDraft,
  type PaperOutbound,
  type PaperRequisition,
  type RequisitionDraft
} from '@/types/warehouse'
import { LAID_PATTERN_OPTIONS, PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS, type Paper, type PaperType } from '@/types/paper'
import { DAMAGE_TYPE_LABEL } from '@/types/leaf'
import { db } from '@/utils/db'
import {
  createRequisition,
  deleteBatchGuarded,
  loadBatchStocks,
  planAllocation,
  reconcileRequisitions,
  returnRequisition,
  type AllocationPlan,
  type BatchStock,
  type ReconcileLine
} from '@/utils/warehouse'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const batchTable = useIdbTable<PaperBatch>((database) => database.paperBatches, { sortByUpdatedAt: false })
const outboundTable = useIdbTable<PaperOutbound>((database) => database.paperOutbounds, { sortByUpdatedAt: false })
const requisitionTable = useIdbTable<PaperRequisition>((database) => database.paperRequisitions, { sortByUpdatedAt: false })

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* ------------------------------ 书叶与标签 ------------------------------ */

const leafOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).map((leaf) => ({
        value: leaf.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]}`
      }))
    )
  )
)

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

/* ------------------------------ 库存与统计 ------------------------------ */

/** 逐批在库：由出库流水（只计未退回领用单）实时汇总 */
const stocks = computed<Map<string, BatchStock>>(() => {
  const activeIds = new Set(
    requisitionTable.rows.value.filter((item) => item.status === 'active').map((item) => item.id)
  )
  const map = new Map<string, BatchStock>()
  batchTable.rows.value.forEach((batch) => {
    map.set(batch.id, {
      batchId: batch.id,
      quantityIn: batch.quantityIn,
      outbound: 0,
      onHand: batch.quantityIn,
      sealed: batch.sealed
    })
  })
  outboundTable.rows.value.forEach((record) => {
    if (!activeIds.has(record.requisitionId)) return
    const entry = map.get(record.batchId)
    if (!entry) return
    entry.outbound += record.quantity
    entry.onHand -= record.quantity
  })
  return map
})

const stat = computed(() => {
  const list = batchTable.rows.value
  const sealedCount = list.filter((batch) => batch.sealed).length
  const totalOnHand = [...stocks.value.values()].reduce((sum, item) => sum + Math.max(0, item.onHand), 0)
  const activeReqs = requisitionTable.rows.value.filter((item) => item.status === 'active')
  const returnedReqs = requisitionTable.rows.value.filter((item) => item.status === 'returned')
  return {
    batchCount: list.length,
    sealedCount,
    totalOnHand,
    activeRequisitions: activeReqs.length,
    returnedRequisitions: returnedReqs.length
  }
})

/* ------------------------------ 批次台账表单 ------------------------------ */
const batchDialog = ref(false)
const editingBatch = ref<PaperBatch | null>(null)
const batchForm = reactive<PaperBatchDraft>(createEmptyBatchDraft())

function openCreateBatch(): void {
  editingBatch.value = null
  Object.assign(batchForm, createEmptyBatchDraft(), { batchNo: `ZC-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}` })
  batchDialog.value = true
}

function openEditBatch(batch: PaperBatch): void {
  editingBatch.value = batch
  Object.assign(batchForm, {
    batchNo: batch.batchNo,
    paperType: batch.paperType,
    laidPattern: batch.laidPattern,
    thicknessMm: batch.thicknessMm,
    colorDelta: batch.colorDelta,
    quantityIn: batch.quantityIn,
    sealed: batch.sealed,
    note: batch.note
  })
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  if (!batchForm.batchNo.trim()) {
    ElMessage.warning('请填写批次号')
    return
  }
  if (batchForm.quantityIn <= 0) {
    ElMessage.warning('入库张数必须大于 0')
    return
  }
  const duplicated = batchTable.rows.value.some(
    (batch) => batch.batchNo === batchForm.batchNo.trim() && batch.id !== editingBatch.value?.id
  )
  if (duplicated) {
    ElMessage.warning('该批次号已存在')
    return
  }
  if (editingBatch.value) {
    await batchTable.update(editingBatch.value.id, { ...batchForm, batchNo: batchForm.batchNo.trim() })
    ElMessage.success('已更新批次')
  } else {
    await batchTable.create({ ...batchForm, batchNo: batchForm.batchNo.trim() }, 'batch')
    ElMessage.success('已登记入库批次')
  }
  batchDialog.value = false
}

async function toggleSeal(batch: PaperBatch): Promise<void> {
  const next = !batch.sealed
  try {
    await ElMessageBox.confirm(
      next ? `封批后该批（${batch.batchNo}）停发，登记领用时自动顺延下一档。` : `确认解除批次 ${batch.batchNo} 的封批？`,
      next ? '封批停发' : '解除封批',
      { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await batchTable.update(batch.id, { sealed: next })
  ElMessage.success(next ? '已封批，新登记领用将顺延其他批次' : '已解除封批')
}

async function removeBatch(batch: PaperBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除批次 ${batch.batchNo}；已有出库记录的批次不可删。`, '删除批次', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await deleteBatchGuarded(batch.id)
    ElMessage.success('已删除批次')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

/* ------------------------------ 领用登记 ------------------------------ */
const requisitionForm = reactive<RequisitionDraft>({
  requester: '',
  leafId: '',
  paperType: 'bamboo',
  laidPattern: '二指帘纹',
  targetDeltaE: 1.5,
  quantity: 1,
  date: today()
})

/** 选书叶或换纸种时，从该书叶已有选配记录带出目标 ΔE（取该纸种最小 ΔE） */
watch(
  () => [requisitionForm.leafId, requisitionForm.paperType] as const,
  async ([leafId, paperType]) => {
    if (!leafId) return
    const papers = await db.papers.where('leafId').equals(leafId).toArray()
    const sameType = papers.filter((paper: Paper) => paper.paperType === paperType)
    if (sameType.length > 0) {
      requisitionForm.targetDeltaE = Math.min(...sameType.map((paper: Paper) => paper.deltaE))
      const first = sameType[0]
      requisitionForm.laidPattern = first.laidPattern
    }
  }
)

/** 顺延选批的实时预演：读当下在库，不写任何数据 */
const plan = ref<AllocationPlan | null>(null)
let planTimer: ReturnType<typeof setTimeout> | null = null

function schedulePlanRefresh(): void {
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(() => void refreshPlan(), 80)
}

async function refreshPlan(): Promise<void> {
  if (!requisitionForm.leafId || requisitionForm.quantity <= 0) {
    plan.value = null
    return
  }
  const [batches, current] = await Promise.all([db.paperBatches.toArray(), loadBatchStocks()])
  plan.value = planAllocation(batches, current, {
    paperType: requisitionForm.paperType,
    laidPattern: requisitionForm.laidPattern,
    targetDeltaE: requisitionForm.targetDeltaE,
    quantity: requisitionForm.quantity
  })
}

watch(
  () => [
    requisitionForm.leafId,
    requisitionForm.paperType,
    requisitionForm.laidPattern,
    requisitionForm.targetDeltaE,
    requisitionForm.quantity
  ],
  () => void refreshPlan(),
  { immediate: true }
)
// 批次台账 / 出库流水 / 领用状态变化 → 当下在库变化 → 去抖重算预演
watch(stocks, () => schedulePlanRefresh(), { deep: true })

async function submitRequisition(): Promise<void> {
  if (!requisitionForm.leafId) {
    ElMessage.warning('请选择领用书叶')
    return
  }
  if (!requisitionForm.requester.trim()) {
    ElMessage.warning('请填写领用人')
    return
  }
  if (requisitionForm.quantity <= 0) {
    ElMessage.warning('领用张数必须大于 0')
    return
  }
  if (!plan.value?.fulfills) {
    ElMessage.error(
      `在库不足：同纸种同帘纹批次合计仅剩 ${plan.value?.totalOnHand ?? 0} 张，缺 ${plan.value?.shortfall ?? 0} 张`
    )
    return
  }
  const detail = plan.value.allocations
    .map((item) => `${item.batchNo} ${item.quantity} 张`)
    .join('、')
  try {
    await ElMessageBox.confirm(`将从纸库出库：${detail}，并逐批登记出库流水。`, '确认登记领用', {
      type: 'info',
      confirmButtonText: '确认领用',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    const { plan: resolvedPlan } = await createRequisition({
      ...requisitionForm,
      requester: requisitionForm.requester.trim()
    })
    const skippedSealed = resolvedPlan.steps.filter((step) => step.skipReason === 'sealed').length
    ElMessage.success(
      skippedSealed > 0
        ? `领用已登记：${skippedSealed} 档近色批次已封批，已顺延下一档出库`
        : '领用已登记，出库流水同步生成'
    )
    requisitionForm.quantity = 1
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '领用登记失败')
  }
}

/* ------------------------------ 领用对账 ------------------------------ */
const reconcileLines = ref<ReconcileLine[]>([])
const reconciling = ref(false)

async function runReconcile(): Promise<void> {
  reconciling.value = true
  try {
    reconcileLines.value = await reconcileRequisitions()
    const mismatch = reconcileLines.value.filter((line) => !line.matched).length
    if (reconcileLines.value.length === 0) ElMessage.info('当前没有领用中的单据')
    else if (mismatch === 0) ElMessage.success(`对账完成：${reconcileLines.value.length} 张领用单全部账实相符`)
    else ElMessage.warning(`对账发现 ${mismatch} 张领用单与出库流水不符，可按叶退回`)
  } finally {
    reconciling.value = false
  }
}

const mismatchCount = computed(() => reconcileLines.value.filter((line) => !line.matched).length)

async function returnLine(line: ReconcileLine): Promise<void> {
  const badBatches = line.batchRows
    .filter((row) => !row.matched)
    .map((row) => `${row.batchNo}（领用 ${row.requisitionQty} / 出库 ${row.outboundQty}）`)
    .join('；')
  try {
    await ElMessageBox.confirm(
      `只退回 ${leafLabel(line.leafId)} 这一叶的领用：删除该单出库流水，已出库张数自动还回批次库存，其他书叶的领用不受影响。`,
      '对账不符 · 退回该叶',
      { type: 'warning', confirmButtonText: '只退这一叶', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await returnRequisition(line.requisitionId, `对账不符：${badBatches}`)
    ElMessage.success('该叶领用已退回，出库张数已还回纸库；其他书叶照旧')
    await runReconcile()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '退回失败')
  }
}

const typeTagType = (type: PaperType): 'success' | 'warning' | 'info' =>
  type === 'bamboo' ? 'success' : type === 'bark' ? 'warning' : 'info'
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>纸库批次与领用对账</h2>
        <p>
          领用接纸库当下在库：同纸种同帘纹、色差最近的批次不够或已封批就顺延下一档；领用汇总按批次与出库流水对账，对不上只退该叶。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button type="primary" :icon="Plus" @click="openCreateBatch">登记入库批次</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在库批次" :value="stat.batchCount" suffix="批" tone="primary" />
      <StatBadge label="已封批" :value="stat.sealedCount" suffix="批" tone="warning" />
      <StatBadge label="在库张数合计" :value="stat.totalOnHand" suffix="张" tone="success" />
      <StatBadge label="领用中" :value="stat.activeRequisitions" suffix="单" tone="info" />
      <StatBadge label="已退回" :value="stat.returnedRequisitions" suffix="单" tone="danger" />
    </div>

    <!-- 批次台账 -->
    <el-card shadow="never">
      <template #header>纸库批次台账（入库张数 / 封批 / 当下在库）</template>
      <EmptyPanel
        v-if="batchTable.rows.value.length === 0"
        title="纸库还没有批次"
        description="先登记每批补纸的入库张数、纸种帘纹与批次色差，再为书叶登记领用。"
        action-text="登记入库批次"
        size="small"
        @action="openCreateBatch"
      />
      <el-table v-else :data="batchTable.rows.value" size="small" border>
        <el-table-column prop="batchNo" label="批次号" width="150" />
        <el-table-column label="纸种" width="90">
          <template #default="{ row }">
            <el-tag :type="typeTagType(row.paperType as PaperType)" effect="plain" size="small" round>
              {{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="laidPattern" label="帘纹" width="110" />
        <el-table-column label="批次 ΔE" width="100">
          <template #default="{ row }">{{ row.colorDelta }}</template>
        </el-table-column>
        <el-table-column prop="thicknessMm" label="厚度(mm)" width="100" />
        <el-table-column label="入库 / 已出 / 在库" width="170">
          <template #default="{ row }">
            <span>{{ row.quantityIn }} / {{ stocks.get(row.id)?.outbound ?? 0 }} / </span>
            <strong :style="{ color: (stocks.get(row.id)?.onHand ?? 0) <= 0 ? '#b03a2e' : '#1e8449' }">
              {{ Math.max(0, stocks.get(row.id)?.onHand ?? row.quantityIn) }}
            </strong>
            <span> 张</span>
          </template>
        </el-table-column>
        <el-table-column label="封批" width="100">
          <template #default="{ row }">
            <el-tag :type="row.sealed ? 'danger' : 'success'" effect="plain" size="small" round>
              {{ BATCH_SEAL_LABEL[row.sealed ? 'sealed' : 'open'] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="210">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openEditBatch(row)">编辑</el-button>
            <el-button size="small" text :type="row.sealed ? 'success' : 'warning'" :icon="row.sealed ? Unlock : Lock" @click="toggleSeal(row)">
              {{ row.sealed ? '解封' : '封批' }}
            </el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16" style="margin-top: 16px">
      <!-- 领用登记 -->
      <el-col :xs="24" :xl="11">
        <el-card shadow="never">
          <template #header>登记书叶领用（按当下在库顺延选批）</template>
          <el-form label-width="96px">
            <el-form-item label="领用书叶" required>
              <el-select v-model="requisitionForm.leafId" filterable placeholder="选择书叶" style="width: 100%">
                <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="领用人" required>
              <el-input v-model="requisitionForm.requester" placeholder="如：沈玉" />
            </el-form-item>
            <el-form-item label="纸种" required>
              <el-select v-model="requisitionForm.paperType" style="width: 100%">
                <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="帘纹" required>
              <el-select v-model="requisitionForm.laidPattern" style="width: 100%">
                <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="目标 ΔE">
              <el-input-number v-model="requisitionForm.targetDeltaE" :min="0" :max="20" :step="0.1" :precision="1" />
              <span class="gb-muted">选书叶后自动带出选配色差</span>
            </el-form-item>
            <el-form-item label="领用张数" required>
              <el-input-number v-model="requisitionForm.quantity" :min="1" :max="9999" :step="1" />
            </el-form-item>
            <el-form-item label="领用日期">
              <el-input v-model="requisitionForm.date" type="date" />
            </el-form-item>
          </el-form>

          <el-divider content-position="left">顺延选批预演（不写库）</el-divider>
          <EmptyPanel v-if="!plan" title="选择书叶与张数后生成预演" description="按色差最近逐档顺延，封批 / 不足的批次会标出。" size="small" />
          <div v-else>
            <el-alert
              :type="plan.fulfills ? 'success' : 'error'"
              show-icon
              :closable="false"
              style="margin-bottom: 10px"
              :title="
                plan.fulfills
                  ? `在库可满足，将跨 ${plan.allocations.length} 个批次出库`
                  : `在库不足：合计仅剩 ${plan.totalOnHand} 张，还缺 ${plan.shortfall} 张`
              "
            />
            <el-table :data="plan.steps" size="small" border>
              <el-table-column prop="batch.batchNo" label="批次（按色差排序）" min-width="140" />
              <el-table-column label="批次 ΔE" width="85">
                <template #default="{ row }">{{ row.batch.colorDelta }}</template>
              </el-table-column>
              <el-table-column label="在库" width="70">
                <template #default="{ row }">{{ Math.max(0, stocks.get(row.batch.id)?.onHand ?? 0) }}</template>
              </el-table-column>
              <el-table-column label="处理" min-width="150">
                <template #default="{ row }">
                  <el-tag v-if="row.taken > 0" type="success" effect="plain" size="small" round>取 {{ row.taken }} 张</el-tag>
                  <el-tag v-else-if="row.skipReason === 'sealed'" type="danger" effect="plain" size="small" round>已封批，顺延</el-tag>
                  <el-tag v-else type="info" effect="plain" size="small" round>在库不足，顺延</el-tag>
                </template>
              </el-table-column>
            </el-table>
            <el-button type="primary" style="margin-top: 12px" :disabled="!plan.fulfills" @click="submitRequisition">
              确认登记领用
            </el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 领用记录 -->
      <el-col :xs="24" :xl="13">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>领用记录（书叶粒度 · 按批次出库）</span>
              <el-button size="small" @click="runReconcile" :loading="reconciling">重新对账</el-button>
            </div>
          </template>
          <EmptyPanel
            v-if="requisitionTable.rows.value.length === 0"
            title="还没有领用记录"
            description="在左侧为书叶登记领用后，这里按叶展示批次分配与状态。"
            size="small"
          />
          <el-table v-else :data="[...requisitionTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)" size="small" border row-key="id">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div style="padding: 8px 16px">
                  <div v-for="item in row.allocations" :key="item.batchId" class="gb-muted" style="line-height: 1.9">
                    批次 {{ item.batchNo }}（{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }} · {{ row.laidPattern }}）
                    出库 <strong>{{ item.quantity }}</strong> 张 · 与目标 ΔE 相差 {{ item.colorGap }}
                  </div>
                  <div v-if="row.status === 'returned'" class="gb-muted" style="color: #b03a2e; margin-top: 4px">
                    已退回（{{ row.returnReason || '对账不符退回' }}）
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="书叶" min-width="180">
              <template #default="{ row }">{{ leafLabel(row.leafId) }}</template>
            </el-table-column>
            <el-table-column label="纸种 / 帘纹" width="130">
              <template #default="{ row }">
                {{ PAPER_TYPE_LABEL[row.paperType as PaperType] }} · {{ row.laidPattern }}
              </template>
            </el-table-column>
            <el-table-column prop="quantity" label="张数" width="60" />
            <el-table-column prop="requester" label="领用人" width="80" />
            <el-table-column prop="date" label="日期" width="105" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain" size="small" round>
                  {{ REQUISITION_STATUS_LABEL[row.status as PaperRequisition['status']] }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <el-divider content-position="left">领用汇总 × 出库流水 对账</el-divider>
          <EmptyPanel
            v-if="reconcileLines.length === 0"
            title="点击「重新对账」核对领用账与纸库出库账"
            description="逐批比对领用汇总与出库流水；对不上可只退回该叶，库存自动还回。"
            size="small"
          />
          <el-alert
            v-else
            :type="mismatchCount === 0 ? 'success' : 'warning'"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            :title="mismatchCount === 0 ? `${reconcileLines.length} 张领用单全部账实相符` : `${mismatchCount} 张领用单对不上，可按叶退回`"
          />
          <el-table v-if="reconcileLines.length > 0" :data="reconcileLines" size="small" border row-key="requisitionId">
            <el-table-column type="expand">
              <template #default="{ row }">
                <el-table :data="row.batchRows" size="small" border style="margin: 8px 16px; width: calc(100% - 32px)">
                  <el-table-column prop="batchNo" label="批次" min-width="140" />
                  <el-table-column prop="requisitionQty" label="领用汇总(张)" width="110" />
                  <el-table-column prop="outboundQty" label="出库流水(张)" width="110" />
                  <el-table-column label="核对" width="90">
                    <template #default="{ row: sub }">
                      <el-tag :type="sub.matched ? 'success' : 'danger'" effect="plain" size="small" round>
                        {{ sub.matched ? '相符' : sub.orphan ? '孤儿流水' : '不符' }}
                      </el-tag>
                    </template>
                  </el-table-column>
                </el-table>
              </template>
            </el-table-column>
            <el-table-column label="书叶" min-width="180">
              <template #default="{ row }">{{ leafLabel(row.leafId) }}</template>
            </el-table-column>
            <el-table-column label="领用合计" width="90">
              <template #default="{ row }">{{ row.totalRequisition }}</template>
            </el-table-column>
            <el-table-column label="出库合计" width="90">
              <template #default="{ row }">{{ row.totalOutbound }}</template>
            </el-table-column>
            <el-table-column label="结果" width="90">
              <template #default="{ row }">
                <el-tag :type="row.matched ? 'success' : 'danger'" effect="plain" size="small" round>
                  {{ row.matched ? '相符' : '不符' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button size="small" text type="warning" :icon="RefreshLeft" :disabled="row.matched" @click="returnLine(row)">
                  只退该叶
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 批次编辑对话框 -->
    <el-dialog v-model="batchDialog" :title="editingBatch ? '编辑纸库批次' : '登记入库批次'" width="600px">
      <el-form label-width="100px">
        <el-form-item label="批次号" required>
          <el-input v-model="batchForm.batchNo" placeholder="如 ZC-2026-118" />
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="batchForm.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="帘纹" required>
          <el-select v-model="batchForm.laidPattern" style="width: 100%">
            <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="batchForm.thicknessMm" :min="0.01" :max="0.5" :step="0.01" :precision="2" />
        </el-form-item>
        <el-form-item label="批次 ΔE">
          <el-input-number v-model="batchForm.colorDelta" :min="0" :max="20" :step="0.1" :precision="1" />
          <span class="gb-muted">登记领用时按与目标 ΔE 的差距排序</span>
        </el-form-item>
        <el-form-item label="入库张数" required>
          <el-input-number v-model="batchForm.quantityIn" :min="0" :max="99999" :step="10" />
        </el-form-item>
        <el-form-item label="封批">
          <el-switch v-model="batchForm.sealed" active-text="已封批停发" inactive-text="在库可领" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
