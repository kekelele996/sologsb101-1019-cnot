<script setup lang="ts">
/**
 * /baths 染色浴次与领用对账
 * 两本账：
 * - 染色间账本：按浴次登记纸种、配方、容量（到顶先排队，账本不被工位侧重记改写）
 * - 工位账本：按本（册）侧重记领用哪一浴、几张、顶哪道补破；染坏按余量退回重算
 * 两账浴次对不上的册次挂起，摆出浴次号与叶号，由工位侧重记。
 * 消费 DyeBath、LeafIssuance、Paper、Leaf、Volume；复用 StatBadge、EmptyPanel、FilterBar、DamageTag。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, RefreshLeft, SortDown, Timer } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import DamageTag from '@/components/common/DamageTag.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useDyeStore } from '@/stores/dyeStore'
import {
  DYE_BATH_STATE_COLOR,
  DYE_BATH_STATE_LABEL,
  type DyeBath,
  type DyeBathState
} from '@/types/dyeBath'
import {
  ISSUANCE_STATE_COLOR,
  ISSUANCE_STATE_LABEL,
  ISSUANCE_STATE_OPTIONS,
  type IssuanceState,
  type LeafIssuance
} from '@/types/leafIssuance'
import {
  DEFAULT_DYE_RECIPE,
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  type PaperType
} from '@/types/paper'
import { DAMAGE_TYPE_LABEL, type Leaf } from '@/types/leaf'
import { REPAIR_NAME_LABEL, REPAIR_NAME_OPTIONS, type RepairName } from '@/types/repairOrder'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL, isVolumeLocked } from '@/types/volume'
import { RECONCILE_ISSUE_LABEL, type ReconcileIssue } from '@/utils/bathLedger'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const dyeStore = useDyeStore()

const activeTab = ref<'baths' | 'issuances' | 'reconcile'>('baths')

/* ------------------------------ 通用展示 ------------------------------ */

interface LeafOption {
  value: string
  label: string
  leaf: Leaf
  paperType: PaperType
  locked: boolean
}

const leafOptions = computed<LeafOption[]>(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).flatMap((leaf) => {
        const paperType = dyeStore.paperTypeOfLeaf(leaf.id)
        if (!paperType) return []
        return [
          {
            value: leaf.id,
            label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]} · ${PAPER_TYPE_LABEL[paperType]}`,
            leaf,
            paperType,
            locked: isVolumeLocked(volume.state)
          }
        ]
      })
    )
  )
)

function paperTypeOf(leafId: string): PaperType | undefined {
  return dyeStore.paperTypeOfLeaf(leafId)
}

function leafOf(id: string): Leaf | undefined {
  return leafStore.leafById(id)
}

function leafTitle(leafId: string): string {
  const leaf = leafOf(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function volumeTitle(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]} · ${VOLUME_STATE_LABEL[volume.state]}`
}

function stateLabelOf(state: IssuanceState): string {
  return ISSUANCE_STATE_LABEL[state]
}

function stateColorOf(state: IssuanceState): string {
  return ISSUANCE_STATE_COLOR[state]
}

function bathStateColor(state: DyeBathState): string {
  return DYE_BATH_STATE_COLOR[state]
}

function bathStateLabel(state: DyeBathState): string {
  return DYE_BATH_STATE_LABEL[state]
}

const bathStats = computed(() => {
  const active = dyeStore.baths.filter((bath) => bath.state === 'active' && !bath.legacy).length
  const remaining = dyeStore.baths.reduce((sum, bath) => sum + (dyeStore.occupancy[bath.id]?.remaining ?? 0), 0)
  return {
    total: dyeStore.baths.length,
    active,
    legacy: dyeStore.baths.filter((bath) => bath.legacy).length,
    remaining,
    queued: dyeStore.queuedCount,
    suspended: dyeStore.suspendedCount
  }
})

/* --------------------------- 染色间浴次账 --------------------------- */
const bathDialog = ref(false)
const bathForm = reactive({
  paperType: 'bamboo' as PaperType,
  recipe: DEFAULT_DYE_RECIPE.bamboo,
  capacity: 20,
  startDate: new Date().toISOString().slice(0, 10),
  dyer: ''
})
const previewBathNo = ref('')

function openBathCreate(paperType?: PaperType): void {
  const type = paperType ?? 'bamboo'
  bathForm.paperType = type
  bathForm.recipe = DEFAULT_DYE_RECIPE[type]
  bathForm.capacity = 20
  bathForm.startDate = new Date().toISOString().slice(0, 10)
  bathForm.dyer = ''
  previewBathNo.value = dyeStore.suggestedBathNo(type)
  bathDialog.value = true
}

function onBathTypeChange(type: PaperType): void {
  bathForm.recipe = DEFAULT_DYE_RECIPE[type]
  previewBathNo.value = dyeStore.suggestedBathNo(type)
}

async function submitBath(): Promise<void> {
  if (bathForm.capacity <= 0) {
    ElMessage.warning('本缸容量需大于 0')
    return
  }
  const row = await dyeStore.createBath({ ...bathForm })
  const pumped = await dyeStore.pumpQueue()
  bathDialog.value = false
  ElMessage.success(`已开 ${row.bathNo}（${PAPER_TYPE_LABEL[row.paperType]}，容量 ${row.capacity} 张）`)
  if (pumped > 0) ElMessage.info(`排队中的 ${pumped} 条领用已补排入缸`)
}

/** 工位账开缸后不允许改容量；只允许改备注状态。这里仅做状态手动切换 */
async function toggleBathState(bath: DyeBath): Promise<void> {
  if (bath.legacy) {
    ElMessage.warning('历史浴次为旧数据回填，不可改状态')
    return
  }
  const next: DyeBathState = bath.state === 'active' ? 'full' : 'active'
  await dyeStore.updateBath(bath.id, { state: next })
  ElMessage.success(`${bath.bathNo} 已置为「${DYE_BATH_STATE_LABEL[next]}」`)
}

const bathRows = computed(() =>
  [...dyeStore.baths].sort((a, b) => {
    const group = (bath: DyeBath): number => PAPER_TYPE_OPTIONS.findIndex((item) => item.value === bath.paperType)
    if (group(a) !== group(b)) return group(a) - group(b)
    return a.bathNo.localeCompare(b.bathNo, 'zh-Hans-CN')
  })
)

/* --------------------------- 修复工位领用账 --------------------------- */
const FILTER_KEYS = ['issueState', 'paperType'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  issueState: url.values.value.issueState ?? [],
  paperType: url.values.value.paperType ?? []
}))

const filterSelects = [
  {
    key: 'issueState',
    label: '领用状态',
    options: ISSUANCE_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value }))
  },
  {
    key: 'paperType',
    label: '纸种',
    options: PAPER_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value }))
  }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    issueState: (next.issueState as string[]) ?? [],
    paperType: (next.paperType as string[]) ?? []
  })
}

const issuanceRows = computed<LeafIssuance[]>(() => {
  const keyword = url.keyword.value.trim()
  const states = (url.values.value.issueState ?? []) as IssuanceState[]
  const types = (url.values.value.paperType ?? []) as PaperType[]
  return dyeStore.issuances
    .filter((item) => {
      const leaf = leafOf(item.leafId)
      if (states.length > 0 && !states.includes(item.state)) return false
      if (types.length > 0) {
        const paperType = paperTypeOf(item.leafId)
        if (!paperType || !types.includes(paperType)) return false
      }
      if (keyword.length > 0) {
        const bath = item.bathId ? dyeStore.bathById(item.bathId) : undefined
        const haystack = `${leafTitle(item.leafId)}${item.receiver}${item.queueNote}${item.returnReason}${bath?.bathNo ?? ''}${REPAIR_NAME_LABEL[item.purpose]}`
        if (!haystack.includes(keyword)) return false
      }
      void leaf
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
})

const issueDialog = ref(false)
const issueForm = reactive({
  leafId: '',
  sheets: 1,
  purpose: 'mend' as RepairName,
  receiver: '',
  date: new Date().toISOString().slice(0, 10)
})

function openIssue(): void {
  const first = leafOptions.value[0]
  if (!first) {
    ElMessage.warning('请先在补纸选配页为书叶选配补纸')
    return
  }
  // reRecord 重记时会先把叶号写入 issueForm.leafId，这里保留预选
  if (!leafOptions.value.some((item) => item.value === issueForm.leafId)) {
    issueForm.leafId = first.value
  }
  if (issueForm.sheets <= 0) issueForm.sheets = 1
  if (!issueForm.purpose) issueForm.purpose = 'mend'
  if (!issueForm.date) issueForm.date = new Date().toISOString().slice(0, 10)
  issueDialog.value = true
}

const issuePaperType = computed<PaperType | undefined>(() =>
  issueForm.leafId ? paperTypeOf(issueForm.leafId) : undefined
)

const issuePreview = computed(() => {
  if (!issuePaperType.value) return { bathNo: '', remaining: 0, willQueue: true }
  // 与 store.issue 相同的选缸口径
  const type = issuePaperType.value
  let chosen: DyeBath | undefined
  for (const bath of [...dyeStore.baths]
    .filter((item) => !item.legacy && item.state === 'active' && item.paperType === type)
    .sort((a, b) => a.bathNo.localeCompare(b.bathNo, 'zh-Hans-CN'))) {
    if ((dyeStore.occupancy[bath.id]?.remaining ?? 0) >= issueForm.sheets) {
      chosen = bath
      break
    }
  }
  return {
    bathNo: chosen?.bathNo ?? '',
    remaining: chosen ? dyeStore.occupancy[chosen.id]?.remaining ?? 0 : 0,
    willQueue: !chosen
  }
})

async function submitIssue(): Promise<void> {
  if (!issueForm.leafId) {
    ElMessage.warning('请选择书叶')
    return
  }
  const option = leafOptions.value.find((item) => item.value === issueForm.leafId)
  if (option?.locked) {
    ElMessage.warning('该书叶所属册次已装订锁定，不能再领用')
    return
  }
  if (issueForm.sheets <= 0) {
    ElMessage.warning('领用张数需大于 0')
    return
  }
  const type = issuePaperType.value
  if (!type) {
    ElMessage.warning('该书叶尚未选配补纸，无法确定浴次纸种')
    return
  }
  const row = await dyeStore.issue({ ...issueForm }, type)
  issueDialog.value = false
  if (row.state === 'queued') {
    ElMessage.warning(`容量到顶，已排队等下一缸${PAPER_TYPE_LABEL[type]}`)
  } else {
    const bath = dyeStore.bathById(row.bathId)
    ElMessage.success(`已从 ${bath?.bathNo ?? '浴次'} 领用 ${row.sheets} 张`)
  }
}

async function markUsed(item: LeafIssuance): Promise<void> {
  await dyeStore.markUsed(item.id)
  ElMessage.success('已记为耗用')
}

async function removeIssuance(item: LeafIssuance): Promise<void> {
  try {
    await ElMessageBox.confirm('工位账按本侧重记：删除该条领用后余量自动回算，染色间浴次账不动。', '删除领用记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await dyeStore.removeIssuance(item.id)
  ElMessage.success('已按本侧重记删除，余量已重算')
}

/* --------------------------- 染坏退回重领 --------------------------- */
const returnDialog = ref(false)
const returning = ref<LeafIssuance | null>(null)
const returnForm = reactive({ bathId: '', receiver: '', date: '', reason: '色花不匀，整批染坏' })

function openReturn(item: LeafIssuance): void {
  if (item.state === 'returned' || item.state === 'queued') {
    ElMessage.warning('只有已领用 / 已耗用且未退回的记录能办染坏退回')
    return
  }
  returning.value = item
  returnForm.bathId = item.bathId
  returnForm.receiver = item.receiver
  returnForm.date = new Date().toISOString().slice(0, 10)
  returnForm.reason = '色花不匀，整批染坏'
  returnDialog.value = true
}

const returnableBaths = computed<DyeBath[]>(() => {
  if (!returning.value) return []
  const type = paperTypeOf(returning.value.leafId)
  if (!type) return []
  return dyeStore.baths.filter((bath) => !bath.legacy && bath.paperType === type)
})

async function submitReturn(): Promise<void> {
  if (!returning.value) return
  if (!returnForm.bathId) {
    ElMessage.warning('请选择重领浴次（余量不足会自动排队等下一缸）')
    return
  }
  const type = paperTypeOf(returning.value.leafId)
  if (!type) return
  const reissued = await dyeStore.returnAndReissue(
    {
      source: returning.value,
      bathId: returnForm.bathId,
      receiver: returnForm.receiver,
      date: returnForm.date
    },
    type,
    returnForm.reason
  )
  returnDialog.value = false
  if (reissued.state === 'queued') {
    ElMessage.warning('染坏已按余量退回；重领张数容量仍不足，已排队等下一缸')
  } else {
    ElMessage.success('染坏已退回并重记领用，浴次余量已重算')
  }
  returning.value = null
}

/* --------------------------- 排队补排 --------------------------- */
const queueDialog = ref(false)
const queueTarget = ref<LeafIssuance | null>(null)
const queueBathId = ref('')

function openAssign(item: LeafIssuance): void {
  queueTarget.value = item
  const type = paperTypeOf(item.leafId)
  const candidates = dyeStore.baths.filter(
    (bath) => !bath.legacy && bath.state === 'active' && bath.paperType === type && (dyeStore.occupancy[bath.id]?.remaining ?? 0) >= item.sheets
  )
  queueBathId.value = candidates[0]?.id ?? ''
  queueDialog.value = true
}

const queueCandidates = computed<DyeBath[]>(() => {
  if (!queueTarget.value) return []
  const type = paperTypeOf(queueTarget.value.leafId)
  if (!type) return []
  return dyeStore.baths
    .filter((bath) => !bath.legacy && bath.paperType === type)
    .sort((a, b) => a.bathNo.localeCompare(b.bathNo, 'zh-Hans-CN'))
})

async function submitAssign(): Promise<void> {
  if (!queueTarget.value || !queueBathId.value) {
    ElMessage.warning('请选择要改记的浴次')
    return
  }
  const occ = dyeStore.occupancy[queueBathId.value]
  if (occ && occ.remaining < queueTarget.value.sheets) {
    ElMessage.warning('该缸余量不足，请改选其他缸或先开下一缸')
    return
  }
  await dyeStore.assignQueued(queueTarget.value.id, queueBathId.value)
  queueDialog.value = false
  ElMessage.success('已按本侧重记到指定浴次，染色间账本未改动')
}

/* --------------------------- 对账挂起 --------------------------- */
const reconcile = computed(() => dyeStore.reconcile)

interface SuspendedGroup {
  volumeId: string
  issues: ReconcileIssue[]
}

const suspendedGroups = computed<SuspendedGroup[]>(() =>
  reconcile.value.suspendedVolumeIds.map((volumeId) => ({
    volumeId,
    issues: reconcile.value.suspendedByVolume[volumeId] ?? []
  }))
)

function issueKindLabel(kind: ReconcileIssue['kind']): string {
  return RECONCILE_ISSUE_LABEL[kind]
}

function issueKindType(kind: ReconcileIssue['kind']): 'danger' | 'warning' | 'info' {
  if (kind === 'missing-bath' || kind === 'paper-type-mismatch') return 'danger'
  if (kind === 'over-capacity') return 'warning'
  return 'info'
}

function issuanceById(id: string): LeafIssuance | undefined {
  return dyeStore.issuances.find((item) => item.id === id)
}

/** 对账挂起后工位侧重记：删掉对不上的领用条，余量回算（染色间账不动），再带起领用对话框 */
async function reRecord(issue: ReconcileIssue): Promise<void> {
  const target = issuanceById(issue.issuanceId)
  if (!target) {
    ElMessage.info('该条已被重记或删除')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将删除 ${issue.bathNo} → 第 ${issue.leafNo} 叶 的工位账记录（${issue.message}），随后请按正确浴次重新领用。染色间账本不动。`,
      '工位侧重记',
      { type: 'warning', confirmButtonText: '删除并重记', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await dyeStore.removeIssuance(target.id)
  issueForm.leafId = issue.leafId
  issueForm.sheets = target.sheets
  issueForm.purpose = target.purpose
  issueForm.receiver = target.receiver
  activeTab.value = 'issuances'
  openIssue()
  ElMessage.info('请在领用账中按正确浴次重新领用')
}

/** 从排队面板跳转到浴次账（开下一缸或补排已有缸） */
function goBaths(): void {
  activeTab.value = 'baths'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>染色浴次与领用对账</h2>
        <p>
          染色间按浴次记纸种、配方、缸容；修复工位按本（册）记领用浴次、张数与顶哪道补破。
          容量到顶先排队，染坏按余量退回重算；浴次对不上的册次挂起，只重记工位这本账。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Plus" @click="openBathCreate()">新开染色浴次</el-button>
        <el-button type="primary" :icon="Plus" @click="openIssue">工位领用补纸</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="浴次总数" :value="bathStats.total" suffix="缸" tone="primary" />
      <StatBadge label="在染缸" :value="bathStats.active" suffix="缸" tone="success" />
      <StatBadge label="当前可领余量" :value="bathStats.remaining" suffix="张" tone="info" />
      <StatBadge label="排队等下一缸" :value="bathStats.queued" suffix="条" tone="warning" />
      <StatBadge label="历史回填浴次" :value="bathStats.legacy" suffix="缸" />
      <StatBadge label="挂起册次" :value="bathStats.suspended" suffix="册" tone="danger" />
    </div>

    <el-tabs v-model="activeTab">
      <!-- ======================== 染色间浴次账 ======================== -->
      <el-tab-pane name="baths">
        <template #label>
          <span>染色间浴次账</span>
        </template>
        <el-card shadow="never">
          <EmptyPanel
            v-if="bathRows.length === 0"
            title="还没有染色浴次"
            description="按浴次登记纸种、染色配方和这一缸能染的张数；容量到顶后新领用自动排队等下一缸。"
            action-text="新开染色浴次"
            size="small"
            @action="openBathCreate()"
          />
          <el-table v-else :data="bathRows" size="small" border>
            <el-table-column label="浴次号" width="100">
              <template #default="{ row }">
                <strong>{{ row.bathNo }}</strong>
                <el-tag
                  v-if="row.legacy"
                  size="small"
                  type="warning"
                  effect="plain"
                  round
                  style="margin-left: 4px"
                >旧数据回填</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="纸种" width="80">
              <template #default="{ row }">{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}</template>
            </el-table-column>
            <el-table-column label="染色配方" min-width="220">
              <template #default="{ row }"><span class="gb-muted">{{ row.recipe }}</span></template>
            </el-table-column>
            <el-table-column label="缸容(张)" width="90" prop="capacity" />
            <el-table-column label="已占/余量" width="170">
              <template #default="{ row }">
                <template v-if="row.legacy">
                  <span class="gb-muted">历史缸，不再发放</span>
                </template>
                <template v-else>
                  <div>{{ dyeStore.occupancy[row.id]?.occupied ?? 0 }} / {{ dyeStore.occupancy[row.id]?.remaining ?? 0 }} 张</div>
                  <el-progress
                    :percentage="Math.min(100, Math.round(((dyeStore.occupancy[row.id]?.occupied ?? 0) / Math.max(1, row.capacity)) * 100))"
                    :stroke-width="6"
                    :show-text="false"
                    :color="(dyeStore.occupancy[row.id]?.remaining ?? 0) <= 0 ? '#8c8c8c' : '#1e8449'"
                    style="width: 110px"
                  />
                </template>
              </template>
            </el-table-column>
            <el-table-column label="染坏退回" width="90">
              <template #default="{ row }">{{ dyeStore.occupancy[row.id]?.returned ?? 0 }} 张</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: bathStateColor(row.state as DyeBathState), borderColor: `${bathStateColor(row.state as DyeBathState)}66` }"
                  effect="plain"
                  size="small"
                  round
                >
                  {{ bathStateLabel(row.state as DyeBathState) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="dyer" label="染工" width="100" />
            <el-table-column prop="startDate" label="开缸日期" width="110" />
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button
                  v-if="!row.legacy"
                  size="small"
                  text
                  @click="toggleBathState(row as DyeBath)"
                >
                  {{ row.state === 'active' ? '封缸' : '解封' }}
                </el-button>
                <el-button size="small" text type="primary" @click="openBathCreate(row.paperType as PaperType)">开下一缸</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ======================== 修复工位领用账 ======================== -->
      <el-tab-pane name="issuances">
        <template #label>
          <span>修复工位领用账</span>
          <el-badge v-if="dyeStore.queuedCount > 0" :value="dyeStore.queuedCount" type="warning" style="margin-left: 6px" />
        </template>

        <el-alert
          v-if="dyeStore.queuedCount > 0"
          type="warning"
          show-icon
          :closable="false"
          style="margin-bottom: 12px"
          :title="`有 ${dyeStore.queuedCount} 条领用在排队等下一缸；开新缸或染坏退回释放余量后会按先到先得自动补排。`"
        />

        <FilterBar
          :model-value="filterModel"
          :selects="filterSelects"
          keyword-placeholder="搜索叶号 / 浴次 / 领用人 / 补破工序…"
          @change="handleFilterChange"
          @reset="url.reset()"
        />

        <el-card shadow="never" style="margin-top: 14px">
          <EmptyPanel
            v-if="issuanceRows.length === 0"
            title="还没有领用记录"
            description="工位按本（册）登记领用哪一浴、领几张、顶哪道补破；容量到顶会自动排队。"
            action-text="工位领用补纸"
            size="small"
            @action="openIssue"
          />
          <el-table v-else :data="issuanceRows" size="small" border>
            <el-table-column label="书叶 / 破损" min-width="220">
              <template #default="{ row }">
                <div>{{ leafTitle(row.leafId) }}</div>
                <DamageTag v-if="leafOf(row.leafId)" :type="leafOf(row.leafId)!.damageType" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="浴次" width="100">
              <template #default="{ row }">
                <span v-if="row.state === 'queued'" class="gb-queue">
                  <el-icon><Timer /></el-icon> 待排
                </span>
                <span v-else>{{ dyeStore.bathById(row.bathId)?.bathNo ?? '浴次缺失' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="纸种" width="80">
              <template #default="{ row }">
                {{ paperTypeOf(row.leafId) ? PAPER_TYPE_LABEL[paperTypeOf(row.leafId)!] : '未选配' }}
              </template>
            </el-table-column>
            <el-table-column label="张数" prop="sheets" width="70" />
            <el-table-column label="顶哪道" width="90">
              <template #default="{ row }">{{ REPAIR_NAME_LABEL[row.purpose as RepairName] }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag
                  :style="{ color: stateColorOf(row.state as IssuanceState), borderColor: `${stateColorOf(row.state as IssuanceState)}66` }"
                  effect="plain"
                  size="small"
                  round
                >
                  {{ stateLabelOf(row.state as IssuanceState) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="排队 / 退回说明" min-width="180">
              <template #default="{ row }">
                <span v-if="row.state === 'queued'" class="gb-queue">{{ row.queueNote || '排队等下一缸' }}</span>
                <span v-else-if="row.state === 'returned'" class="gb-return">
                  退回 {{ row.returnedSheets }} 张：{{ row.returnReason }}
                  <span v-if="row.reissueOfId" class="gb-muted">（已重领）</span>
                </span>
                <span v-else class="gb-muted">{{ row.receiver }} · {{ row.date }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="230">
              <template #default="{ row }">
                <el-button
                  v-if="row.state === 'issued'"
                  size="small"
                  text
                  type="success"
                  @click="markUsed(row as LeafIssuance)"
                >记耗用</el-button>
                <el-button
                  v-if="row.state === 'issued' || row.state === 'used'"
                  size="small"
                  text
                  type="warning"
                  :icon="RefreshLeft"
                  @click="openReturn(row as LeafIssuance)"
                >染坏退回</el-button>
                <el-button
                  v-if="row.state === 'queued'"
                  size="small"
                  text
                  type="primary"
                  :icon="SortDown"
                  @click="openAssign(row as LeafIssuance)"
                >补排入缸</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="removeIssuance(row as LeafIssuance)">重记</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ======================== 对账挂起 ======================== -->
      <el-tab-pane name="reconcile">
        <template #label>
          <span>对账挂起</span>
          <el-badge v-if="dyeStore.suspendedCount > 0" :value="dyeStore.suspendedCount" type="danger" style="margin-left: 6px" />
        </template>

        <el-row :gutter="16">
          <el-col :xs="24" :xl="15">
            <el-card shadow="never">
              <template #header>
                <div class="gb-toolbar" style="justify-content: space-between">
                  <span>浴次对不上、已挂起的册次（{{ suspendedGroups.length }}）</span>
                  <span class="gb-muted">只摆浴次号与叶号，工位侧重记，染色间账本不动</span>
                </div>
              </template>
              <EmptyPanel
                v-if="suspendedGroups.length === 0"
                title="两本账浴次全部对得上"
                description="没有挂起册次；染坏退回与排队领用均已在工位账中重记。"
                size="small"
              />
              <div v-else style="display: flex; flex-direction: column; gap: 14px">
                <el-card v-for="group in suspendedGroups" :key="group.volumeId" shadow="never" class="gb-suspend-card">
                  <template #header>
                    <div class="gb-toolbar" style="justify-content: space-between">
                      <strong>挂起：{{ volumeTitle(group.volumeId) }}</strong>
                      <el-tag type="danger" effect="plain" round>{{ group.issues.length }} 处对不上</el-tag>
                    </div>
                  </template>
                  <el-table :data="group.issues" size="small" border>
                    <el-table-column label="浴次号" width="100">
                      <template #default="{ row }">
                        <el-tag :type="issueKindType(row.kind)" effect="plain" size="small" round>{{ row.bathNo }}</el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column label="叶号" width="80">
                      <template #default="{ row }">第 {{ row.leafNo }} 叶</template>
                    </el-table-column>
                    <el-table-column label="问题" width="110">
                      <template #default="{ row }">
                        <el-tag :type="issueKindType(row.kind)" effect="plain" size="small">
                          {{ issueKindLabel(row.kind) }}
                        </el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column label="对账说明" min-width="220">
                      <template #default="{ row }"><span class="gb-muted">{{ row.message }}</span></template>
                    </el-table-column>
                    <el-table-column label="处置" width="120">
                      <template #default="{ row }">
                        <el-button size="small" text type="primary" @click="reRecord(row)">按本侧重记</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </div>
            </el-card>
          </el-col>

          <el-col :xs="24" :xl="9">
            <el-card shadow="never">
              <template #header>排队等下一缸（不算对不上）</template>
              <EmptyPanel
                v-if="reconcile.waiting.length === 0"
                title="当前没有排队领用"
                description="容量到顶的领用会在这里摆出叶号与纸种，开下一缸后自动补排。"
                size="small"
              />
              <div v-else style="display: flex; flex-direction: column; gap: 8px">
                <div v-for="item in reconcile.waiting" :key="item.issuanceId" class="gb-queue-row">
                  <div>
                    <el-icon class="gb-queue-icon"><Timer /></el-icon>
                    <strong>第 {{ item.leafNo }} 叶</strong>
                    <el-tag size="small" effect="plain" round style="margin-left: 6px">
                      {{ item.paperType ? PAPER_TYPE_LABEL[item.paperType] : '未选配' }}
                    </el-tag>
                    <span class="gb-muted"> · {{ item.sheets }} 张</span>
                  </div>
                  <div class="gb-muted">{{ item.note }}</div>
                  <div class="gb-toolbar" style="margin-top: 4px">
                    <el-button size="small" text type="primary" @click="openBathCreate(item.paperType || undefined)">
                      开下一缸
                    </el-button>
                    <el-button size="small" text @click="goBaths">补排已有缸</el-button>
                  </div>
                </div>
              </div>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>

    <!-- 新开浴次对话框 -->
    <el-dialog v-model="bathDialog" title="染色间登记新浴次" width="560px">
      <el-form label-width="100px">
        <el-form-item label="浴次号">
          <el-tag effect="plain" round>{{ previewBathNo }}</el-tag>
          <span class="gb-muted" style="margin-left: 8px">同纸种自动连号，历史浴次不占序号</span>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="bathForm.paperType" style="width: 100%" @change="onBathTypeChange">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="染色配方">
          <el-input v-model="bathForm.recipe" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="本缸容量" required>
          <el-input-number v-model="bathForm.capacity" :min="1" :max="500" />
          <span class="gb-muted" style="margin-left: 8px">张；到顶后新领用先排队</span>
        </el-form-item>
        <el-form-item label="开缸日期">
          <el-input v-model="bathForm.startDate" type="date" />
        </el-form-item>
        <el-form-item label="染工">
          <el-input v-model="bathForm.dyer" placeholder="如：周禾" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bathDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBath">登记开缸</el-button>
      </template>
    </el-dialog>

    <!-- 工位领用对话框 -->
    <el-dialog v-model="issueDialog" title="修复工位领用补纸" width="560px">
      <el-form label-width="100px">
        <el-form-item label="书叶" required>
          <el-select v-model="issueForm.leafId" filterable style="width: 100%">
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="领用张数" required>
          <el-input-number v-model="issueForm.sheets" :min="1" :max="50" />
        </el-form-item>
        <el-form-item label="顶哪道补破" required>
          <el-select v-model="issueForm.purpose" style="width: 100%">
            <el-option v-for="item in REPAIR_NAME_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="领用人">
          <el-input v-model="issueForm.receiver" placeholder="如：沈玉" />
        </el-form-item>
        <el-form-item label="日期">
          <el-input v-model="issueForm.date" type="date" />
        </el-form-item>
        <el-form-item label="浴次安排">
          <el-tag v-if="issuePreview.willQueue" type="warning" effect="plain" round>
            在染{{ issuePaperType ? PAPER_TYPE_LABEL[issuePaperType] : '' }}缸余量不足，先排队等下一缸
          </el-tag>
          <el-tag v-else type="success" effect="plain" round>
            领 {{ issueForm.sheets }} 张 → {{ issuePreview.bathNo }}（领后余 {{ issuePreview.remaining - issueForm.sheets }} 张）
          </el-tag>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueDialog = false">取消</el-button>
        <el-button type="primary" @click="submitIssue">登记领用</el-button>
      </template>
    </el-dialog>

    <!-- 染坏退回重领对话框 -->
    <el-dialog v-model="returnDialog" title="染坏退回并重领（按余量重算）" width="560px">
      <el-form label-width="100px">
        <el-form-item label="退回张数">
          <el-tag type="danger" effect="plain" round>{{ returning?.sheets ?? 0 }} 张（整额退回，余量回补）</el-tag>
        </el-form-item>
        <el-form-item label="退回原因">
          <el-input v-model="returnForm.reason" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="重领浴次" required>
          <el-select v-model="returnForm.bathId" style="width: 100%">
            <el-option
              v-for="bath in returnableBaths"
              :key="bath.id"
              :label="`${bath.bathNo}（余 ${dyeStore.occupancy[bath.id]?.remaining ?? 0} 张）`"
              :value="bath.id"
            />
          </el-select>
          <span class="gb-muted">同缸余量够就重领同缸；不够会自动排队等下一缸</span>
        </el-form-item>
        <el-form-item label="重领人">
          <el-input v-model="returnForm.receiver" placeholder="如：沈玉" />
        </el-form-item>
        <el-form-item label="重领日期">
          <el-input v-model="returnForm.date" type="date" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="returnDialog = false">取消</el-button>
        <el-button type="primary" @click="submitReturn">退回并重记</el-button>
      </template>
    </el-dialog>

    <!-- 排队补排对话框 -->
    <el-dialog v-model="queueDialog" title="排队领用改记到指定浴次" width="480px">
      <el-form label-width="90px">
        <el-form-item label="排队叶号">
          <strong>第 {{ queueTarget ? leafOf(queueTarget.leafId)?.leafNo : '?' }} 叶</strong>
          <span class="gb-muted"> · {{ queueTarget?.sheets ?? 0 }} 张</span>
        </el-form-item>
        <el-form-item label="改记浴次">
          <el-select v-model="queueBathId" style="width: 100%">
            <el-option
              v-for="bath in queueCandidates"
              :key="bath.id"
              :label="`${bath.bathNo}（余 ${dyeStore.occupancy[bath.id]?.remaining ?? 0} 张）`"
              :value="bath.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert type="info" show-icon :closable="false" title="工位账按本侧重记：只改这一条领用，染色间浴次账不动。" />
      <template #footer>
        <el-button @click="queueDialog = false">取消</el-button>
        <el-button type="primary" @click="submitAssign">确认补排</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gb-queue {
  color: #d68910;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.gb-return {
  color: #b03a2e;
}

.gb-queue-row {
  padding: 10px 12px;
  border: 1px dashed #d8cbb4;
  border-radius: 8px;
  background: var(--gb-paper-light);
}

.gb-queue-icon {
  color: #d68910;
  vertical-align: -2px;
  margin-right: 4px;
}

.gb-suspend-card {
  border-left: 4px solid #b03a2e;
}
</style>
