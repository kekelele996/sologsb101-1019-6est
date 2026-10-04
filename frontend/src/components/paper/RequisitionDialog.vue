<script setup lang="ts">
/**
 * 按叶领用补纸对话框：
 * 登记领用张数时按纸库当下在库批次挑，色差最近的批次不够或已封批就顺延下一档；
 * 保存时在同一事务出库并写领用单（见 paperStore.registerRequisition）。
 */
import { computed, inject, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usePaperStore } from '@/stores/paperStore'
import { useBookStore } from '@/stores/bookStore'
import {
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  type Paper,
  type PaperType
} from '@/types/paper'
import type { Leaf } from '@/types/leaf'
import { deltaEForLeaf } from '@/utils/paperColor'
import { PAPER_LIST_GETTER_KEY } from './injection'

const props = defineProps<{
  modelValue: boolean
  leaf: Leaf | null
  /** 预选纸种（从某条配纸记录发起时带入），不传则取该叶色差最小的配纸 */
  initialPaperType?: PaperType | ''
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'registered'): void
}>()

const paperStore = usePaperStore()
const bookStore = useBookStore()

const getPaperList = inject(PAPER_LIST_GETTER_KEY, () => [] as Paper[])

const form = reactive({
  paperType: 'bamboo' as PaperType,
  sheets: 1,
  operator: '',
  date: new Date().toISOString().slice(0, 10)
})

const submitting = ref(false)

const papersOfLeaf = computed<Paper[]>(() =>
  props.leaf ? getPaperList().filter((paper) => paper.leafId === props.leaf?.id) : []
)

const matchedPaper = computed<Paper | undefined>(() =>
  papersOfLeaf.value.find((paper) => paper.paperType === form.paperType)
)

const leafLabel = computed(() => {
  if (!props.leaf) return ''
  const volume = bookStore.volumeById(props.leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${props.leaf.leafNo} 叶`
})

/** 目标 ΔE：优先取该叶该纸种已登记配纸的 ΔE，没有则按书叶破损色调估算 */
const targetDeltaE = computed(() =>
  matchedPaper.value ? matchedPaper.value.deltaE : props.leaf ? deltaEForLeaf(props.leaf.damageType, form.paperType) : 0
)

const preferredPattern = computed(() => matchedPaper.value?.laidPattern)
const preferredThickness = computed(() => matchedPaper.value?.thicknessMm ?? 0.06)

const preview = computed(() =>
  props.leaf
    ? paperStore.previewRanking({
        leafId: props.leaf.id,
        sheets: form.sheets,
        operator: form.operator,
        date: form.date,
        paperType: form.paperType,
        targetDeltaE: targetDeltaE.value,
        preferredPattern: preferredPattern.value,
        leafThicknessMm: preferredThickness.value
      })
    : { ranked: [], selectable: false }
)

const chosen = computed(() => preview.value.ranked.find((item) => item.selectable))
const alreadyIssued = computed(() => (props.leaf ? paperStore.issuedSheetsOfLeaf(props.leaf.id) : 0))

watch(
  () => props.modelValue,
  (open) => {
    if (!open || !props.leaf) return
    const initial: PaperType | '' = props.initialPaperType ?? ''
    const preset: PaperType =
      initial || [...papersOfLeaf.value].sort((a, b) => a.deltaE - b.deltaE)[0]?.paperType || 'bamboo'
    form.paperType = preset
    form.sheets = 1
    form.date = new Date().toISOString().slice(0, 10)
    form.operator = paperStore.requisitionsOfLeaf(props.leaf.id).find((item) => item.operator)?.operator ?? ''
  }
)

function close(): void {
  emit('update:modelValue', false)
}

async function submit(): Promise<void> {
  if (!props.leaf) return
  if (!form.operator.trim()) {
    ElMessage.warning('请填写领用人')
    return
  }
  if (!Number.isInteger(form.sheets) || form.sheets <= 0) {
    ElMessage.warning('领用张数必须为正整数')
    return
  }
  if (!chosen.value) {
    ElMessage.error('纸库没有在库且张数足够的同纸种批次')
    return
  }
  submitting.value = true
  try {
    await paperStore.registerRequisition({
      leafId: props.leaf.id,
      sheets: form.sheets,
      operator: form.operator.trim(),
      date: form.date,
      paperType: form.paperType,
      targetDeltaE: targetDeltaE.value,
      preferredPattern: preferredPattern.value,
      leafThicknessMm: preferredThickness.value
    })
    ElMessage.success(
      chosen.value.rank > 0
        ? `首选批次不可用，已顺延采用第 ${chosen.value.rank + 1} 档「${chosen.value.batch.batchNo}」并出库 ${form.sheets} 张`
        : `已从批次「${chosen.value.batch.batchNo}」出库 ${form.sheets} 张`
    )
    emit('registered')
    close()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登记领用失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="按叶登记补纸领用"
    width="720px"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      :title="`领用书叶：${leafLabel}`"
      :description="`该叶当前已领用未退回 ${alreadyIssued} 张；登记后纸库批次出库张数同步增加。`"
    />
    <el-form label-width="92px">
      <el-row :gutter="12">
        <el-col :span="10">
          <el-form-item label="纸种" required>
            <el-select v-model="form.paperType" style="width: 100%">
              <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="7">
          <el-form-item label="领用张数" required>
            <el-input-number v-model="form.sheets" :min="1" :max="999" :step="1" :precision="0" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="7">
          <el-form-item label="领用日期">
            <el-input v-model="form.date" type="date" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="领用人" required>
        <el-input v-model="form.operator" placeholder="如：沈玉" />
      </el-form-item>
    </el-form>

    <el-divider content-position="left">纸库当下批次（按色差由近到远）</el-divider>
    <el-table :data="preview.ranked" size="small" border max-height="260">
      <el-table-column label="档" width="56">
        <template #default="{ $index }">第 {{ $index + 1 }} 档</template>
      </el-table-column>
      <el-table-column prop="batch.batchNo" label="批次号" width="120" />
      <el-table-column label="纸种 / 帘纹" min-width="130">
        <template #default="{ row }">
          {{ PAPER_TYPE_LABEL[row.batch.paperType as PaperType] }} · {{ row.batch.laidPattern }}
        </template>
      </el-table-column>
      <el-table-column prop="batch.deltaE" label="批次 ΔE" width="84" />
      <el-table-column prop="deltaGap" label="色差差" width="80" />
      <el-table-column prop="available" label="在库余量" width="80" />
      <el-table-column label="状态" min-width="120">
        <template #default="{ row }">
          <el-tag v-if="row.sealed" type="warning" effect="plain" size="small" round>已封批，顺延</el-tag>
          <el-tag v-else-if="row.insufficient" type="danger" effect="plain" size="small" round>余量不足，顺延</el-tag>
          <el-tag v-else type="success" effect="plain" size="small" round>可出库</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-alert
      v-if="preview.ranked.length === 0"
      type="warning"
      :closable="false"
      show-icon
      title="纸库没有该纸种的批次，请先在「纸库批次」页签登记入库"
      style="margin-top: 8px"
    />
    <el-alert
      v-else-if="!chosen"
      type="error"
      :closable="false"
      show-icon
      title="色差最近的批次均已封批或余量不足，且没有可顺延的下一档"
      style="margin-top: 8px"
    />
    <el-alert
      v-else-if="chosen.rank > 0"
      type="warning"
      :closable="false"
      show-icon
      :title="`色差最近的第 1 档${preview.ranked[0].sealed ? '已封批' : '余量不足'}，已顺延到第 ${chosen.rank + 1} 档「${chosen.batch.batchNo}」`"
      style="margin-top: 8px"
    />
    <el-alert
      v-else
      type="success"
      :closable="false"
      show-icon
      :title="`将采用色差最近的在库批次「${chosen.batch.batchNo}」，出库后余量 ${chosen.available - form.sheets} 张`"
      style="margin-top: 8px"
    />
    <p class="gb-muted" style="margin: 8px 0 0">
      目标 ΔE {{ targetDeltaE }}
      <template v-if="matchedPaper">（取自该叶已登记配纸）</template>
      <template v-else>（该叶尚无该纸种配纸记录，按破损色调估算）</template>
    </p>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!chosen" @click="submit">确认领用并出库</el-button>
    </template>
  </el-dialog>
</template>
