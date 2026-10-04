<script setup lang="ts">
/**
 * 纸库批次面板：纸库侧维护每批补纸的入库张数、已出库张数与封批状态。
 * 领用只能从未封批且在库余量足够的批次出库（分配规则见 paperStore / paperRequisition）。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Lock, Plus, Unlock } from '@element-plus/icons-vue'
import { usePaperStore } from '@/stores/paperStore'
import StatBadge from '@/components/common/StatBadge.vue'
import { PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS, type PaperType } from '@/types/paper'
import { LAID_PATTERN_OPTIONS } from '@/types/paper'
import {
  BATCH_STATE_LABEL,
  createEmptyBatchDraft,
  type PaperBatch,
  type PaperBatchDraft
} from '@/types/paperBatch'
import { availableSheets } from '@/utils/paperRequisition'

const paperStore = usePaperStore()

const dialog = ref(false)
const editing = ref<PaperBatch | null>(null)
const form = reactive<PaperBatchDraft>(createEmptyBatchDraft())

const inStockBatches = computed(() => paperStore.batches.filter((batch) => batch.state === 'in_stock'))
const sealedBatches = computed(() => paperStore.batches.filter((batch) => batch.state === 'sealed'))
const totalReceived = computed(() => paperStore.batches.reduce((sum, batch) => sum + batch.receivedSheets, 0))
const totalAvailable = computed(() =>
  inStockBatches.value.reduce((sum, batch) => sum + availableSheets(batch), 0)
)

const rows = computed(() =>
  [...paperStore.batches].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'sealed' ? 1 : -1
    return b.receivedDate.localeCompare(a.receivedDate)
  })
)

function openCreate(): void {
  editing.value = null
  Object.assign(form, createEmptyBatchDraft(), { batchNo: nextBatchNo(form.paperType) })
  dialog.value = true
}

function nextBatchNo(type: PaperType): string {
  const prefix = type === 'bamboo' ? '竹' : type === 'bark' ? '皮' : '宣'
  const year = new Date().getFullYear()
  const samePrefix = paperStore.batches.filter((batch) => batch.batchNo.startsWith(prefix))
  return `${prefix}-${year}-${String(samePrefix.length + 1).padStart(2, '0')}`
}

function openEdit(batch: PaperBatch): void {
  editing.value = batch
  Object.assign(form, {
    batchNo: batch.batchNo,
    paperType: batch.paperType,
    laidPattern: batch.laidPattern,
    thicknessMm: batch.thicknessMm,
    deltaE: batch.deltaE,
    receivedSheets: batch.receivedSheets,
    issuedSheets: batch.issuedSheets,
    state: batch.state,
    receivedDate: batch.receivedDate,
    sealedDate: batch.sealedDate,
    remark: batch.remark
  })
  dialog.value = true
}

async function submit(): Promise<void> {
  if (!form.batchNo.trim()) {
    ElMessage.warning('请填写批次号')
    return
  }
  if (form.issuedSheets > form.receivedSheets) {
    ElMessage.warning('已出库张数不能大于入库张数')
    return
  }
  const payload: PaperBatchDraft = {
    ...form,
    batchNo: form.batchNo.trim(),
    sealedDate: form.state === 'sealed' ? form.sealedDate || new Date().toISOString().slice(0, 10) : ''
  }
  try {
    if (editing.value) {
      await paperStore.updateBatch(editing.value.id, payload)
      ElMessage.success('已更新纸库批次')
    } else {
      await paperStore.createBatch(payload)
      ElMessage.success('已登记补纸入库批次')
    }
    dialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存批次失败')
  }
}

async function toggleSealed(batch: PaperBatch): Promise<void> {
  const sealing = batch.state !== 'sealed'
  try {
    if (sealing) {
      await ElMessageBox.confirm(`封批后「${batch.batchNo}」不再参与修复室领用，已领用记录保留。`, '封存批次', {
        type: 'warning',
        confirmButtonText: '确认封批',
        cancelButtonText: '取消'
      })
    }
  } catch {
    return
  }
  await paperStore.setBatchSealed(batch.id, sealing, sealing ? '封存' : '')
  ElMessage.success(sealing ? '批次已封批' : '批次已解封，恢复在库')
}

async function remove(batch: PaperBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除批次「${batch.batchNo}」，已有领用记录将变为「纸库查无此批」。`, '删除批次', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await paperStore.removeBatch(batch.id)
    ElMessage.success('已删除批次')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除批次失败')
  }
}
</script>

<template>
  <div>
    <div class="gb-stat-row">
      <StatBadge label="纸库批次" :value="paperStore.batches.length" suffix="批" tone="primary" />
      <StatBadge label="在库批次" :value="inStockBatches.length" suffix="批" tone="success" />
      <StatBadge label="已封批" :value="sealedBatches.length" suffix="批" tone="warning" />
      <StatBadge label="累计入库" :value="totalReceived" suffix="张" tone="info" />
      <StatBadge label="当下在库余量" :value="totalAvailable" suffix="张" tone="primary" />
    </div>

    <el-card shadow="never">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>纸库批次台账（入库张数 / 已出库 / 封批）</span>
          <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新增入库批次</el-button>
        </div>
      </template>

      <el-empty v-if="rows.length === 0" description="纸库还没有批次，先登记补纸入库" :image-size="70" />
      <el-table v-else :data="rows" size="small" border>
        <el-table-column prop="batchNo" label="批次号" width="130" />
        <el-table-column label="纸种" width="80">
          <template #default="{ row }">{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}</template>
        </el-table-column>
        <el-table-column prop="laidPattern" label="帘纹" width="100" />
        <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
        <el-table-column prop="deltaE" label="基准 ΔE" width="90" />
        <el-table-column prop="receivedSheets" label="入库张数" width="90" />
        <el-table-column prop="issuedSheets" label="已出库" width="80" />
        <el-table-column label="在库余量" width="90">
          <template #default="{ row }">
            <strong :style="{ color: availableSheets(row) === 0 ? '#b03a2e' : '#1e8449' }">
              {{ availableSheets(row) }}
            </strong>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.state === 'sealed' ? 'warning' : 'success'" effect="plain" size="small" round>
              {{ BATCH_STATE_LABEL[row.state as keyof typeof BATCH_STATE_LABEL] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="receivedDate" label="入库日期" width="110" />
        <el-table-column label="备注" min-width="140">
          <template #default="{ row }">
            <span class="gb-muted">{{ row.remark || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" text :icon="row.state === 'sealed' ? Unlock : Lock" @click="toggleSealed(row)">
              {{ row.state === 'sealed' ? '解封' : '封批' }}
            </el-button>
            <el-button size="small" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialog" :title="editing ? '编辑纸库批次' : '新增入库批次'" width="600px">
      <el-form label-width="100px">
        <el-form-item label="批次号" required>
          <el-input v-model="form.batchNo" placeholder="如：竹-2026-01" />
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="form.paperType" style="width: 100%" @change="(value: PaperType) => { if (!editing) form.batchNo = nextBatchNo(value) }">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="帘纹">
          <el-select v-model="form.laidPattern" style="width: 100%">
            <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="厚度(mm)">
              <el-input-number v-model="form.thicknessMm" :min="0.01" :max="0.5" :step="0.01" :precision="2" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基准 ΔE">
              <el-input-number v-model="form.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="入库张数" required>
              <el-input-number v-model="form.receivedSheets" :min="0" :max="100000" :step="1" :precision="0" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="已出库张数">
              <el-input-number v-model="form.issuedSheets" :min="0" :max="form.receivedSheets" :step="1" :precision="0" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="入库日期">
          <el-input v-model="form.receivedDate" type="date" />
        </el-form-item>
        <el-form-item label="封批">
          <el-switch
            v-model="form.state"
            active-value="sealed"
            inactive-value="in_stock"
            active-text="已封批（不参与领用）"
            inactive-text="在库"
          />
        </el-form-item>
        <el-form-item v-if="form.state === 'sealed'" label="封批备注">
          <el-input v-model="form.remark" placeholder="如：余批封存，不再出库" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
