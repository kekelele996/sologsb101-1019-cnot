/**
 * 染色浴次与领用 store（Pinia setup store）
 * 同时背两本账：
 * - 染色间账本（dyeBaths）：按浴次登记纸种、配方、容量；一经登记不被工位侧重记改写
 * - 工位账本（leafIssuances）：按本（册）侧重记领用、染坏退回、重领；对账不上可删改重记
 *
 * 容量到顶先排队；染坏按余量退回重算，下一缸 / 余量释放后自动补排。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import { createId, db } from '@/utils/db'
import { createEmptyDyeBathDraft, nextBathNo, type DyeBath, type DyeBathDraft } from '@/types/dyeBath'
import { createEmptyIssuanceDraft, type LeafIssuance, type LeafIssuanceDraft } from '@/types/leafIssuance'
import { PAPER_TYPE_LABEL, type Paper, type PaperType } from '@/types/paper'
import { chooseBath, occupancyMap, reconcileLedger, type BathOccupancy, type ReconcileResult } from '@/utils/bathLedger'
import { useLeafStore } from './leafStore'

export interface CreateBathInput {
  paperType: PaperType
  recipe: string
  capacity: number
  startDate: string
  dyer: string
}

export interface IssueInput {
  leafId: string
  sheets: number
  purpose: LeafIssuanceDraft['purpose']
  receiver: string
  date: string
}

export interface ReissueInput {
  source: LeafIssuance
  bathId: string
  receiver: string
  date: string
}

export const useDyeStore = defineStore('dye', () => {
  const baths = ref<DyeBath[]>([])
  const issuances = ref<LeafIssuance[]>([])
  // 补纸表决定每叶领用的纸种；liveQuery 订阅保证补纸选配页改动后对账实时刷新
  const papers = ref<Paper[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  liveQuery(() => db.papers.toArray()).subscribe({
    next: (rows) => {
      papers.value = rows
    },
    error: () => {
      /* 首次启动尚未 open 时由 loadAll 兜底 */
    }
  })

  async function loadBaths(): Promise<void> {
    const rows = await db.dyeBaths.toArray()
    rows.sort((a, b) => a.bathNo.localeCompare(b.bathNo, 'zh-Hans-CN'))
    baths.value = rows
  }

  async function loadIssuances(): Promise<void> {
    const rows = await db.leafIssuances.toArray()
    rows.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date.localeCompare(b.date)))
    issuances.value = rows
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      await Promise.all([loadBaths(), loadIssuances()])
      papers.value = await db.papers.toArray()
      await syncBathStates()
      // 启动时补排：下一缸已开 / 余量已退回时，排队中的老领用按先到先得入缸
      await pumpQueue()
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '浴次账读取失败'
    } finally {
      loading.value = false
    }
  }

  /** 每缸占用 / 余量（染坏退回后实时重算） */
  const occupancy = computed<Record<string, BathOccupancy>>(() => occupancyMap(baths.value, issuances.value))

  /** 每叶选配的纸种（用于排队补排与纸种对账） */
  function paperTypeOfLeaf(leafId: string): PaperType | undefined {
    return papers.value.find((paper) => paper.leafId === leafId)?.paperType
  }

  function bathById(id: string): DyeBath | undefined {
    return baths.value.find((bath) => bath.id === id)
  }

  function issuancesOfLeaf(leafId: string): LeafIssuance[] {
    return issuances.value.filter((item) => item.leafId === leafId)
  }

  function suggestedBathNo(paperType: PaperType): string {
    return nextBathNo(paperType, baths.value)
  }

  /** 开下一缸（排队中的同纸种领用随后补排） */
  async function createBath(input: CreateBathInput): Promise<DyeBath> {
    const now = Date.now()
    const draft: DyeBathDraft = {
      ...createEmptyDyeBathDraft(input.paperType, suggestedBathNo(input.paperType), input.recipe),
      capacity: input.capacity,
      startDate: input.startDate,
      dyer: input.dyer
    }
    const row: DyeBath = { ...draft, id: createId('bath'), createdAt: now, updatedAt: now }
    await db.dyeBaths.put(row)
    await loadBaths()
    await pumpQueue()
    return row
  }

  /** 染色间账本仅允许改配方备注 / 状态等，不改容量占用事实；工位侧重记不动这里 */
  async function updateBath(id: string, patch: Partial<DyeBath>): Promise<void> {
    await db.dyeBaths.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadBaths()
  }

  /** 按余量重算后回写在染 / 已用罄状态（历史缸保持历史） */
  async function syncBathStates(): Promise<void> {
    const patch: DyeBath[] = []
    const now = Date.now()
    baths.value.forEach((bath) => {
      if (bath.legacy) return
      const occ = occupancy.value[bath.id]
      if (!occ) return
      const state = occ.remaining <= 0 ? 'full' : 'active'
      if (bath.state !== state) patch.push({ ...bath, state, updatedAt: now })
    })
    if (patch.length > 0) {
      await db.dyeBaths.bulkPut(patch)
      baths.value = baths.value.map((bath) => patch.find((item) => item.id === bath.id) ?? bath)
    }
  }

  /**
   * 工位领用：有够余量的在染缸则直接占用；容量到顶就先排队等下一缸。
   */
  async function issue(input: IssueInput, paperType: PaperType): Promise<LeafIssuance> {
    const bath = chooseBath(paperType, baths.value, issuances.value, input.sheets)
    const now = Date.now()
    const draft: LeafIssuanceDraft = {
      ...createEmptyIssuanceDraft(input.leafId),
      sheets: input.sheets,
      purpose: input.purpose,
      receiver: input.receiver,
      date: input.date,
      state: bath ? 'issued' : 'queued',
      bathId: bath?.id ?? '',
      queueNote: bath
        ? ''
        : `在染缸余量不足 ${input.sheets} 张，排队等下一缸${PAPER_TYPE_LABEL[paperType]}`
    }
    const row: LeafIssuance = { ...draft, id: createId('iss'), createdAt: now, updatedAt: now }
    await db.leafIssuances.put(row)
    await loadIssuances()
    await syncBathStates()
    return row
  }

  /**
   * 染坏退回：原领用条标记退回（按余量退回重算，整额退回不占缸），
   * 再按本侧重记一条领用，优先重领同缸余量，否则排队等下一缸。
   */
  async function returnAndReissue(input: ReissueInput, paperType: PaperType, reason: string): Promise<LeafIssuance> {
    const now = Date.now()
    const returned: LeafIssuance = {
      ...input.source,
      state: 'returned',
      returnedSheets: input.source.sheets,
      returnReason: reason,
      updatedAt: now
    }
    // 先把退回条放进工作集再算余量：整额退回后同缸余量释放，优先重领同缸
    const afterReturn = issuances.value.map((item) => (item.id === input.source.id ? returned : item))
    const specified = baths.value.find((bath) => bath.id === input.bathId && !bath.legacy)
    const sameBathOk =
      specified && occupancyMap(baths.value, afterReturn)[specified.id]?.remaining >= input.source.sheets
    const target =
      sameBathOk && specified
        ? specified
        : chooseBath(paperType, baths.value, afterReturn, input.source.sheets)
    const reissued: LeafIssuance = {
      ...createEmptyIssuanceDraft(input.source.leafId),
      sheets: input.source.sheets,
      purpose: input.source.purpose,
      receiver: input.receiver,
      date: input.date,
      bathId: target?.id ?? '',
      state: target ? 'issued' : 'queued',
      queueNote: target
        ? ''
        : `染坏重领：在染缸余量不足 ${input.source.sheets} 张，排队等下一缸${PAPER_TYPE_LABEL[paperType]}`,
      reissueOfId: input.source.id,
      id: createId('iss'),
      createdAt: now,
      updatedAt: now
    }
    await db.leafIssuances.bulkPut([returned, reissued])
    await loadIssuances()
    await syncBathStates()
    return reissued
  }

  /** 排队补排：开新缸 / 退回释放余量后，先到先得补入可领的缸 */
  async function pumpQueue(): Promise<number> {
    const queue = issuances.value
      .filter((item) => item.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
    if (queue.length === 0) return 0
    const working = [...issuances.value]
    const patched: LeafIssuance[] = []
    const now = Date.now()
    queue.forEach((item) => {
      const paperType = paperTypeOfLeaf(item.leafId)
      if (!paperType) return
      const bath = chooseBath(paperType, baths.value, working, item.sheets)
      if (!bath) return
      const index = working.findIndex((row) => row.id === item.id)
      const next: LeafIssuance = {
        ...item,
        bathId: bath.id,
        state: 'issued',
        queueNote: '',
        updatedAt: now
      }
      working[index] = next
      patched.push(next)
    })
    if (patched.length > 0) {
      await db.leafIssuances.bulkPut(patched)
      await loadIssuances()
      await syncBathStates()
    }
    return patched.length
  }

  /** 工位侧重记：把排队条目改记到指定缸（对账后由修复工位操作，染色间账不改动） */
  async function assignQueued(id: string, bathId: string): Promise<void> {
    const target = issuances.value.find((item) => item.id === id)
    if (!target || target.state !== 'queued') return
    await db.leafIssuances.update(id, { bathId, state: 'issued', queueNote: '', updatedAt: Date.now() } as never)
    await loadIssuances()
    await syncBathStates()
  }

  /** 工位侧状态推进：已领用 → 已耗用 */
  async function markUsed(id: string): Promise<void> {
    await db.leafIssuances.update(id, { state: 'used', updatedAt: Date.now() } as never)
    await loadIssuances()
  }

  /** 删除工位侧领用条（按本侧重记用）；染色间浴次账不改动 */
  async function removeIssuance(id: string): Promise<void> {
    await db.leafIssuances.delete(id)
    await loadIssuances()
    await syncBathStates()
  }

  /** 两本账对账：浴次对不上的册次挂起，排队等下一缸的另列 */
  const reconcile = computed<ReconcileResult>(() => {
    const leafStore = useLeafStore()
    return reconcileLedger({
      baths: baths.value,
      issuances: issuances.value,
      leaves: leafStore.leaves,
      papers: papers.value
    })
  })

  const queuedCount = computed(() => issuances.value.filter((item) => item.state === 'queued').length)
  const suspendedCount = computed(() => reconcile.value.suspendedVolumeIds.length)

  return {
    baths,
    issuances,
    loading,
    ready,
    error,
    occupancy,
    queuedCount,
    suspendedCount,
    reconcile,
    loadAll,
    loadBaths,
    loadIssuances,
    bathById,
    issuancesOfLeaf,
    paperTypeOfLeaf,
    suggestedBathNo,
    createBath,
    updateBath,
    issue,
    returnAndReissue,
    pumpQueue,
    assignQueued,
    markUsed,
    removeIssuance
  }
})
