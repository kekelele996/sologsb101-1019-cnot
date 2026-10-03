<script setup lang="ts">
/**
 * /dyeing 补纸染色与领用对账
 * 两本账同屏：染色间按浴次登记纸种 / 配方 / 容量；修复工位按书叶领用、顶哪道补破。
 * 容量到顶排队等下一缸，染坏按余量退回重算；两账对不上挂起整册，工位按本侧重记。
 * 消费 DyeBatch、PaperUsage、Leaf、RepairOrder；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, RefreshLeft, Tickets, WarningFilled } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { useDyeStore, type VolumeMismatch } from '@/stores/dyeStore'
import {
  DYE_BATCH_SOURCE_LABEL,
  createEmptyDyeBatchDraft,
  dyeBatchLabel,
  type DyeBatch,
  type DyeBatchDraft
} from '@/types/dyeBatch'
import { PAPER_USAGE_STATE_LABEL, PAPER_USAGE_STATE_OPTIONS, type PaperUsage, type PaperUsageState } from '@/types/paperUsage'
import { DEFAULT_DYE_RECIPE, PAPER_TYPE_OPTIONS, type Paper, type PaperType } from '@/types/paper'
import { REPAIR_NAME_LABEL } from '@/types/repairOrder'
import { VOLUME_STATE_LABEL } from '@/types/volume'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const dyeStore = useDyeStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const FILTER_KEYS = ['paperType', 'usageState'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  paperType: url.values.value.paperType ?? [],
  usageState: url.values.value.usageState ?? []
}))

const filterSelects = [
  { key: 'paperType', label: '纸种', options: PAPER_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  {
    key: 'usageState',
    label: '领用状态',
    options: PAPER_USAGE_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value as string }))
  }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    paperType: (next.paperType as string[]) ?? [],
    usageState: (next.usageState as string[]) ?? []
  })
}

/* ----------------------------- 标签辅助 ----------------------------- */
function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function leafNoOf(leafId: string): number | string {
  return leafStore.leafById(leafId)?.leafNo ?? '?'
}

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册（${VOLUME_STATE_LABEL[volume.state]}）`
}

function batchLabelOf(batchId: string): string {
  if (!batchId) return '待分配'
  const batch = dyeStore.batchById(batchId)
  return batch ? dyeBatchLabel(batch) : `未知浴次（${batchId}）`
}

function orderLabel(orderId: string): string {
  if (!orderId) return '—'
  const order = repairStore.orders.find((item) => item.id === orderId)
  return order ? `第 ${order.seq} 道 · ${REPAIR_NAME_LABEL[order.name]}` : '工序已删除'
}

function remainingTagType(remaining: number): 'success' | 'danger' | 'info' {
  if (remaining < 0) return 'danger'
  if (remaining === 0) return 'info'
  return 'success'
}

function usageStateTagType(state: PaperUsageState): 'success' | 'warning' | 'info' {
  if (state === 'active') return 'success'
  if (state === 'queued') return 'warning'
  return 'info'
}

/* ----------------------------- 列表与统计 ----------------------------- */
const batchRows = computed(() => {
  const keyword = url.keyword.value.trim()
  const types = url.values.value.paperType ?? []
  return dyeStore.sortedBatches.filter((batch) => {
    if (types.length > 0 && !types.includes(batch.paperType)) return false
    if (keyword.length > 0) {
      const haystack = `${dyeBatchLabel(batch)}${batch.dyeRecipe}${batch.note}`
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
})

const usageRows = computed(() => {
  const keyword = url.keyword.value.trim()
  const types = url.values.value.paperType ?? []
  const states = url.values.value.usageState ?? []
  return dyeStore.sortedUsages.filter((usage) => {
    if (states.length > 0 && !states.includes(usage.state)) return false
    if (types.length > 0 && !types.includes(usage.paperType)) return false
    if (keyword.length > 0) {
      const haystack = `${leafLabel(usage.leafId)}${batchLabelOf(usage.batchId)}${usage.note}`
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
})

const stat = computed(() => ({
  batches: dyeStore.batches.length,
  remaining: dyeStore.totalRemaining,
  queued: dyeStore.queuedUsages.length,
  returned: dyeStore.totalReturned,
  suspended: dyeStore.suspendedCount
}))

/* ----------------------------- 浴次表单 ----------------------------- */
const batchDialog = ref(false)
const editingBatch = ref<DyeBatch | null>(null)
const batchForm = reactive<DyeBatchDraft>(createEmptyDyeBatchDraft())

// 纸种变化时带出默认染色配方（与补纸选配页同一约定）
watch(
  () => batchForm.paperType,
  (type: PaperType) => {
    const recipe = DEFAULT_DYE_RECIPE[type]
    if (!batchForm.dyeRecipe || Object.values(DEFAULT_DYE_RECIPE).includes(batchForm.dyeRecipe)) {
      batchForm.dyeRecipe = recipe
    }
  }
)

const editingAllocated = computed(() => (editingBatch.value ? dyeStore.allocatedOfBatch(editingBatch.value.id) : 0))

function openBatchCreate(): void {
  editingBatch.value = null
  Object.assign(batchForm, createEmptyDyeBatchDraft())
  batchDialog.value = true
}

function openBatchEdit(batch: DyeBatch): void {
  editingBatch.value = batch
  Object.assign(batchForm, {
    paperType: batch.paperType,
    dyeRecipe: batch.dyeRecipe,
    capacity: batch.capacity,
    note: batch.note
  })
  batchDialog.value = true
}

async function submitBatch(): Promise<void> {
  if (editingBatch.value) {
    const fulfilled = await dyeStore.updateBatch(editingBatch.value.id, { ...batchForm })
    ElMessage.success(fulfilled > 0 ? `已更新浴次，并补位 ${fulfilled} 笔排队领用` : '已更新浴次')
  } else {
    const { batch, fulfilled } = await dyeStore.createBatch({ ...batchForm })
    ElMessage.success(`已开${dyeBatchLabel(batch)}${fulfilled > 0 ? `，补位 ${fulfilled} 笔排队领用` : ''}`)
  }
  batchDialog.value = false
}

async function removeBatch(batch: DyeBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除${dyeBatchLabel(batch)}。`, '删除浴次', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const errorMessage = await dyeStore.removeBatch(batch.id)
  if (errorMessage) ElMessage.error(errorMessage)
  else ElMessage.success('已删除浴次')
}

/* ----------------------------- 领用表单 ----------------------------- */
const usageDialog = ref(false)
const usageForm = reactive({ leafId: '', repairOrderId: '', paperType: 'bamboo' as PaperType, count: 1, note: '' })

const leafOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).map((leaf) => ({
        value: leaf.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶`
      }))
    )
  )
)

const orderOptions = computed(() => {
  if (!usageForm.leafId) return []
  return repairStore.ordersOfLeaf(usageForm.leafId).map((order) => ({
    value: order.id,
    label: `第 ${order.seq} 道 · ${REPAIR_NAME_LABEL[order.name]}${order.operator ? ` · ${order.operator}` : ''}`
  }))
})

// 选定书叶后带出选配记录的纸种，并默认顶该叶的补破工序
watch(
  () => usageForm.leafId,
  (leafId: string) => {
    if (!leafId) return
    const paper = paperTable.rows.value.find((item) => item.leafId === leafId)
    usageForm.paperType = paper?.paperType ?? 'bamboo'
    const orders = repairStore.ordersOfLeaf(leafId)
    const mend = orders.find((order) => order.name === 'mend')
    usageForm.repairOrderId = (mend ?? orders[0])?.id ?? ''
  }
)

function openUsageCreate(): void {
  const first = leafOptions.value[0]
  if (!first) {
    ElMessage.warning('请先登记书叶')
    return
  }
  Object.assign(usageForm, { leafId: '', repairOrderId: '', paperType: 'bamboo' as PaperType, count: 1, note: '' })
  usageForm.leafId = first.value
  usageDialog.value = true
}

async function submitUsage(): Promise<void> {
  if (!usageForm.leafId) {
    ElMessage.warning('请选择书叶')
    return
  }
  const row = await dyeStore.requestUsage({ ...usageForm })
  if (row.state === 'queued') ElMessage.warning('染色容量到顶，该笔已排队等下一缸')
  else ElMessage.success(`已从${batchLabelOf(row.batchId)}领用 ${row.count} 张`)
  usageDialog.value = false
}

/* ----------------------------- 染坏退回 / 作废 ----------------------------- */
const returnDialog = ref(false)
const returning = ref<PaperUsage | null>(null)
const returnCount = ref(1)
const returnable = computed(() => (returning.value ? returning.value.count - returning.value.returnedCount : 0))

function openReturn(usage: PaperUsage): void {
  returning.value = usage
  returnCount.value = 1
  returnDialog.value = true
}

async function submitReturn(): Promise<void> {
  if (!returning.value) return
  const result = await dyeStore.returnUsage(returning.value.id, returnCount.value)
  if (result.error) {
    ElMessage.error(result.error)
    return
  }
  ElMessage.success(`已按余量退回重算${result.fulfilled > 0 ? `，补位 ${result.fulfilled} 笔排队领用` : ''}`)
  returnDialog.value = false
}

async function voidUsage(usage: PaperUsage): Promise<void> {
  try {
    await ElMessageBox.confirm('作废后该笔不再占用浴次余量，需要时重新登记。', '作废领用', {
      type: 'warning',
      confirmButtonText: '确认作废',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await dyeStore.voidUsage(usage.id)
  ElMessage.success('已作废，余量已重算')
}

/* ----------------------------- 对账挂起 ----------------------------- */
async function reRecord(item: VolumeMismatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将作废${volumeLabel(item.volumeId)}在修复工位台账中的全部领用记录，随后按本册重新登记；染色间台账保持不变。`,
      '按本侧重记',
      { type: 'warning', confirmButtonText: '确认重记', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await dyeStore.reRecordVolume(item.volumeId)
  ElMessage.success(`已作废 ${count} 条领用记录，染色间台账未动，请按本册重新登记领用`)
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>补纸染色与领用对账</h2>
        <p>
          染色间按浴次记纸种、配方与容量；修复工位按书叶领用、顶哪道补破。容量到顶排队等下一缸，染坏按余量退回重算。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button type="primary" :icon="Plus" @click="openBatchCreate">新开一缸</el-button>
        <el-button type="success" plain :icon="Tickets" @click="openUsageCreate">登记领用</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="染色浴次" :value="stat.batches" suffix="缸" tone="primary" />
      <StatBadge label="在架余量" :value="stat.remaining" suffix="张" tone="success" />
      <StatBadge label="排队等下一缸" :value="stat.queued" suffix="笔" tone="warning" />
      <StatBadge label="染坏退回" :value="stat.returned" suffix="张" tone="info" />
      <StatBadge label="对账挂起" :value="stat.suspended" suffix="册" tone="danger" />
    </div>

    <el-card v-if="dyeStore.mismatches.length > 0" shadow="never" class="dye-suspend">
      <template #header>
        <div class="dye-suspend__head">
          <el-icon><WarningFilled /></el-icon>
          <span>
            两本账浴次对不上，{{ dyeStore.mismatches.length }} 册已挂起 ——
            摆出浴次与叶号，修复工位按本侧重记，染色间台账不动
          </span>
        </div>
      </template>
      <el-table :data="dyeStore.mismatches" size="small" border>
        <el-table-column label="挂起册次" min-width="210">
          <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
        </el-table-column>
        <el-table-column label="对不上的浴次与叶号" min-width="340">
          <template #default="{ row }">
            <div v-for="issue in row.issues" :key="issue.usageId" class="dye-issue">
              <el-tag size="small" type="danger" effect="plain" round>第 {{ leafNoOf(issue.leafId) }} 叶</el-tag>
              <span>{{ issue.batchLabel }}</span>
              <span class="gb-muted">{{ issue.reason }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain @click="reRecord(row)">按本侧重记</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索浴次 / 配方 / 书叶 / 备注…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <div class="dye-card-head">
              <span>染色间台账（浴次）</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openBatchCreate">新开一缸</el-button>
            </div>
          </template>
          <EmptyPanel
            v-if="batchRows.length === 0"
            :title="dyeStore.batches.length === 0 ? '还没有染色浴次' : '当前条件下没有浴次'"
            :description="
              dyeStore.batches.length === 0
                ? '每一缸染液记一浴：纸种、染色配方与这一缸能染的张数。'
                : '试着调整纸种筛选或关键字。'
            "
            action-text="新开一缸"
            secondary-text="重置筛选"
            size="small"
            @action="openBatchCreate"
            @secondary="url.reset()"
          />
          <el-table v-else :data="batchRows" size="small" border>
            <el-table-column label="浴次" width="150">
              <template #default="{ row }">
                <div>{{ dyeBatchLabel(row) }}</div>
                <el-tag v-if="row.source === 'backfill'" size="small" type="info" effect="plain" round>
                  {{ DYE_BATCH_SOURCE_LABEL[row.source as DyeBatch['source']] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="染色配方" min-width="170">
              <template #default="{ row }">
                <span class="gb-muted">{{ row.dyeRecipe }}</span>
                <div v-if="row.note" class="gb-muted">备注：{{ row.note }}</div>
              </template>
            </el-table-column>
            <el-table-column label="容量" width="70" align="right">
              <template #default="{ row }">{{ row.capacity }} 张</template>
            </el-table-column>
            <el-table-column label="已领" width="70" align="right">
              <template #default="{ row }">{{ dyeStore.allocatedOfBatch(row.id) }} 张</template>
            </el-table-column>
            <el-table-column label="余量" width="96">
              <template #default="{ row }">
                <el-tag :type="remainingTagType(dyeStore.remainingOfBatch(row.id))" size="small" effect="plain" round>
                  余 {{ dyeStore.remainingOfBatch(row.id) }} 张
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button size="small" text :icon="Edit" @click="openBatchEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeBatch(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div class="dye-card-head">
              <span>修复工位台账（领用）</span>
              <el-button type="success" plain size="small" :icon="Tickets" @click="openUsageCreate">登记领用</el-button>
            </div>
          </template>
          <el-alert
            v-if="dyeStore.queuedUsages.length > 0"
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 10px"
            :title="`${dyeStore.queuedUsages.length} 笔领用排队等下一缸`"
            :description="`按登记先后补位：${dyeStore.queuedUsages.map((usage) => `第 ${leafNoOf(usage.leafId)} 叶 ×${usage.count}`).join('、')}`"
          />
          <EmptyPanel
            v-if="usageRows.length === 0"
            :title="dyeStore.usages.length === 0 ? '还没有领用记录' : '当前条件下没有记录'"
            :description="
              dyeStore.usages.length === 0
                ? '按书叶领用哪一浴次、领几张、顶哪道补破；容量到顶会自动排队。'
                : '试着调整领用状态或纸种筛选。'
            "
            action-text="登记领用"
            secondary-text="重置筛选"
            size="small"
            @action="openUsageCreate"
            @secondary="url.reset()"
          />
          <el-table v-else :data="usageRows" size="small" border>
            <el-table-column label="书叶" min-width="190">
              <template #default="{ row }">{{ leafLabel(row.leafId) }}</template>
            </el-table-column>
            <el-table-column label="浴次" width="150">
              <template #default="{ row }">
                <el-tag v-if="row.state === 'queued'" size="small" type="warning" effect="plain" round>等下一缸</el-tag>
                <span v-else>{{ batchLabelOf(row.batchId) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="顶哪道补破" width="130">
              <template #default="{ row }">{{ orderLabel(row.repairOrderId) }}</template>
            </el-table-column>
            <el-table-column label="领 / 退" width="110" align="right">
              <template #default="{ row }">
                {{ row.count }} 张
                <span v-if="row.returnedCount > 0" class="gb-muted">/ 退 {{ row.returnedCount }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="usageStateTagType(row.state as PaperUsageState)" size="small" effect="plain" round>
                  {{ PAPER_USAGE_STATE_LABEL[row.state as PaperUsageState] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="备注" min-width="120">
              <template #default="{ row }"><span class="gb-muted">{{ row.note || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="170">
              <template #default="{ row }">
                <el-button
                  v-if="row.state === 'active' && row.count - row.returnedCount > 0"
                  size="small"
                  text
                  :icon="RefreshLeft"
                  @click="openReturn(row)"
                >
                  退回染坏
                </el-button>
                <el-button v-if="row.state !== 'void'" size="small" text type="danger" :icon="Delete" @click="voidUsage(row)">
                  作废
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="batchDialog" :title="editingBatch ? `编辑${dyeBatchLabel(editingBatch)}` : '新开一缸'" width="560px">
      <el-form label-width="110px">
        <el-form-item label="纸种" required>
          <el-select v-model="batchForm.paperType" style="width: 100%" :disabled="Boolean(editingBatch)">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="editingBatch" class="gb-muted">浴次纸种与领用账挂钩，登记后不可改</span>
        </el-form-item>
        <el-form-item label="染色配方" required>
          <el-input v-model="batchForm.dyeRecipe" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="容量（张）" required>
          <el-input-number v-model="batchForm.capacity" :min="1" :max="999" :precision="0" />
          <span class="gb-muted" style="margin-left: 8px">这一缸能染的张数</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.note" placeholder="如：配《昌黎先生集》补破" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="editingBatch && batchForm.capacity < editingAllocated"
        type="warning"
        show-icon
        :closable="false"
        :title="`新容量低于该浴次已领 ${editingAllocated} 张，保存后将超量并挂起相关册次`"
      />
      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="usageDialog" title="登记领用" width="560px">
      <el-form label-width="110px">
        <el-form-item label="书叶" required>
          <el-select v-model="usageForm.leafId" style="width: 100%" filterable>
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="顶哪道补破">
          <el-select v-model="usageForm.repairOrderId" style="width: 100%" clearable placeholder="不关联工序（补记）">
            <el-option v-for="item in orderOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="usageForm.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span class="gb-muted">默认带出该书叶选配记录的纸种</span>
        </el-form-item>
        <el-form-item label="领几张" required>
          <el-input-number v-model="usageForm.count" :min="1" :max="99" :precision="0" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="usageForm.note" />
        </el-form-item>
      </el-form>
      <el-alert type="info" show-icon :closable="false" title="所选纸种当前浴次余量不足时，该笔先排队等下一缸" />
      <template #footer>
        <el-button @click="usageDialog = false">取消</el-button>
        <el-button type="primary" @click="submitUsage">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="returnDialog" title="染坏退回" width="460px">
      <template v-if="returning">
        <p class="gb-muted" style="margin-top: 0">
          {{ leafLabel(returning.leafId) }} · {{ batchLabelOf(returning.batchId) }} · 已领 {{ returning.count }} 张，可退
          {{ returnable }} 张
        </p>
        <el-form label-width="110px">
          <el-form-item label="退回张数" required>
            <el-input-number v-model="returnCount" :min="1" :max="Math.max(1, returnable)" :precision="0" />
          </el-form-item>
        </el-form>
        <el-alert type="info" show-icon :closable="false" title="退回的张数按余量重算，释放的容量会给排队领用补位" />
      </template>
      <template #footer>
        <el-button @click="returnDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReturn">确认退回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.dye-suspend {
  margin-bottom: 14px;
  border-color: rgba(176, 58, 46, 0.35);
}

.dye-suspend__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #b03a2e;
  font-weight: 600;
}

.dye-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dye-issue {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}
</style>
