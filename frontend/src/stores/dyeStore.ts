/**
 * 染色与领用双台账 store（Pinia setup store）
 * 染色间账：浴次（纸种 / 染色配方 / 这一缸能染的张数）；
 * 修复工位账：按书叶领用哪一浴次、领几张、顶哪道补破。
 * 规则：
 * - 浴次容量到顶，新领用先排队；新开浴次或染坏退回释放余量后按登记先后补位；
 * - 染坏退回按余量重算（退回张数加回浴次余量）；
 * - 两本账浴次对不上（浴次查不到 / 浴次超量）即挂起该册，摆出浴次与叶号，
 *   修复工位按本侧重记（作废重登），染色间台账不动。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { dyeBatchLabel, type DyeBatch, type DyeBatchDraft } from '@/types/dyeBatch'
import { usageNetCount, type PaperUsage, type PaperUsageState } from '@/types/paperUsage'
import type { PaperType } from '@/types/paper'
import { useLeafStore } from './leafStore'

export interface UsageRequest {
  leafId: string
  repairOrderId: string
  paperType: PaperType
  count: number
  note: string
}

/** 对账差异明细：摆出浴次与叶号 */
export interface MismatchIssue {
  usageId: string
  leafId: string
  batchLabel: string
  reason: string
}

/** 一册的对账差异（挂起单位） */
export interface VolumeMismatch {
  volumeId: string
  issues: MismatchIssue[]
}

export const useDyeStore = defineStore('dye', () => {
  const leafStore = useLeafStore()

  const batches = ref<DyeBatch[]>([])
  const usages = ref<PaperUsage[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  const sortedBatches = computed<DyeBatch[]>(() => [...batches.value].sort((a, b) => b.seq - a.seq))
  const sortedUsages = computed<PaperUsage[]>(() => [...usages.value].sort((a, b) => b.createdAt - a.createdAt))
  /** 排队等下一缸的领用，按登记先后补位 */
  const queuedUsages = computed<PaperUsage[]>(() =>
    usages.value.filter((usage) => usage.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)
  )
  const totalReturned = computed<number>(() =>
    usages.value.reduce((sum, usage) => sum + usage.returnedCount, 0)
  )
  const totalRemaining = computed<number>(() =>
    batches.value.reduce((sum, batch) => sum + Math.max(0, remainingOfBatch(batch.id)), 0)
  )

  async function loadBatches(): Promise<void> {
    batches.value = await db.dyeBatches.toArray()
  }

  async function loadUsages(): Promise<void> {
    usages.value = await db.paperUsages.toArray()
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      await Promise.all([loadBatches(), loadUsages()])
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '染色台账读取失败'
    } finally {
      loading.value = false
    }
  }

  function batchById(id: string): DyeBatch | undefined {
    return batches.value.find((batch) => batch.id === id)
  }

  /** 已领（净）：已领用状态的 领 - 退 */
  function allocatedOfBatch(batchId: string): number {
    return usages.value
      .filter((usage) => usage.batchId === batchId)
      .reduce((sum, usage) => sum + usageNetCount(usage), 0)
  }

  /** 浴次余量：容量 - 已领（净）；超量时为负 */
  function remainingOfBatch(batchId: string): number {
    const batch = batchById(batchId)
    if (!batch) return 0
    return batch.capacity - allocatedOfBatch(batchId)
  }

  /** 当前可开的缸：同纸种里浴次最新且余量够的一浴 */
  function pickBatch(paperType: PaperType, count: number): DyeBatch | null {
    return (
      batches.value
        .filter((batch) => batch.paperType === paperType && remainingOfBatch(batch.id) >= count)
        .sort((a, b) => b.seq - a.seq)[0] ?? null
    )
  }

  /** 排队补位：按登记先后把排队领用塞进有余量的浴次，返回补位笔数 */
  async function fulfillQueue(): Promise<number> {
    const queue = queuedUsages.value
    if (queue.length === 0) return 0
    const remaining = new Map<string, number>()
    batches.value.forEach((batch) => remaining.set(batch.id, remainingOfBatch(batch.id)))
    const now = Date.now()
    const updates: PaperUsage[] = []
    queue.forEach((usage) => {
      const target = batches.value
        .filter((batch) => batch.paperType === usage.paperType && (remaining.get(batch.id) ?? 0) >= usage.count)
        .sort((a, b) => b.seq - a.seq)[0]
      if (!target) return
      remaining.set(target.id, (remaining.get(target.id) ?? 0) - usage.count)
      updates.push({ ...usage, batchId: target.id, state: 'active', updatedAt: now })
    })
    if (updates.length > 0) {
      await db.paperUsages.bulkPut(updates)
      await loadUsages()
    }
    return updates.length
  }

  /** 新开一缸：浴次序号全库递增，开缸后先给排队领用补位 */
  async function createBatch(draft: DyeBatchDraft): Promise<{ batch: DyeBatch; fulfilled: number }> {
    const now = Date.now()
    const seq = batches.value.reduce((max, batch) => Math.max(max, batch.seq), 0) + 1
    const row: DyeBatch = { ...draft, id: createId('batch'), seq, source: 'manual', createdAt: now, updatedAt: now }
    await db.dyeBatches.put(row)
    await loadBatches()
    const fulfilled = await fulfillQueue()
    return { batch: row, fulfilled }
  }

  /** 调整浴次（配方 / 容量 / 备注）；容量调低可能超量挂起，调高则给排队补位 */
  async function updateBatch(id: string, patch: Partial<DyeBatch>): Promise<number> {
    await db.dyeBatches.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadBatches()
    return fulfillQueue()
  }

  /** 删除浴次：已有领用（未作废）的浴次不能删，防止两本账对不上 */
  async function removeBatch(id: string): Promise<string> {
    const referenced = usages.value.some((usage) => usage.batchId === id && usage.state !== 'void')
    if (referenced) return '该浴次已有领用记录，不能删除；如对账需要，请走「按本侧重记」'
    await db.dyeBatches.delete(id)
    await loadBatches()
    return ''
  }

  /** 登记领用：有余量直接领，容量到顶则排队等下一缸 */
  async function requestUsage(input: UsageRequest): Promise<PaperUsage> {
    const now = Date.now()
    const batch = pickBatch(input.paperType, input.count)
    const row: PaperUsage = {
      id: createId('usage'),
      batchId: batch?.id ?? '',
      paperType: input.paperType,
      leafId: input.leafId,
      repairOrderId: input.repairOrderId,
      count: input.count,
      returnedCount: 0,
      state: batch ? 'active' : 'queued',
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
    await db.paperUsages.put(row)
    await loadUsages()
    return row
  }

  /** 染坏退回：按余量退回重算，释放的容量顺手给排队领用补位 */
  async function returnUsage(id: string, count: number): Promise<{ error: string; fulfilled: number }> {
    const usage = usages.value.find((item) => item.id === id)
    if (!usage || usage.state !== 'active') return { error: '领用记录不存在或已作废', fulfilled: 0 }
    const returnable = usage.count - usage.returnedCount
    if (count < 1 || count > returnable) return { error: `可退回 1–${returnable} 张`, fulfilled: 0 }
    await db.paperUsages.update(id, { returnedCount: usage.returnedCount + count, updatedAt: Date.now() } as never)
    await loadUsages()
    const fulfilled = await fulfillQueue()
    return { error: '', fulfilled }
  }

  /** 作废单笔领用（记错重登），余量相应重算 */
  async function voidUsage(id: string): Promise<void> {
    await db.paperUsages.update(id, { state: 'void' as PaperUsageState, updatedAt: Date.now() } as never)
    await loadUsages()
    await fulfillQueue()
  }

  /** 两本账对不上的册：浴次查不到或浴次超量，按册摆出浴次与叶号 */
  const mismatches = computed<VolumeMismatch[]>(() => {
    const leafVolume = new Map(leafStore.leaves.map((leaf) => [leaf.id, leaf.volumeId]))
    const byVolume = new Map<string, MismatchIssue[]>()
    const push = (usage: PaperUsage, batchLabel: string, reason: string): void => {
      const volumeId = leafVolume.get(usage.leafId)
      if (!volumeId) return
      const list = byVolume.get(volumeId) ?? []
      list.push({ usageId: usage.id, leafId: usage.leafId, batchLabel, reason })
      byVolume.set(volumeId, list)
    }
    usages.value
      .filter((usage) => usage.state === 'active')
      .forEach((usage) => {
        if (!usage.batchId || !batchById(usage.batchId)) {
          push(usage, usage.batchId ? `未知浴次（${usage.batchId}）` : '未登记浴次', '工位账的浴次在染色间台账中查不到')
        }
      })
    batches.value.forEach((batch) => {
      const allocated = allocatedOfBatch(batch.id)
      if (allocated <= batch.capacity) return
      usages.value
        .filter((usage) => usage.state === 'active' && usage.batchId === batch.id)
        .forEach((usage) =>
          push(usage, dyeBatchLabel(batch), `浴次超量：已领 ${allocated} 张，超过容量 ${batch.capacity} 张`)
        )
    })
    return Array.from(byVolume.entries())
      .map(([volumeId, issues]) => ({ volumeId, issues }))
      .sort((a, b) => a.volumeId.localeCompare(b.volumeId))
  })

  const suspendedCount = computed<number>(() => mismatches.value.length)
  /** 导航角标：排队笔数 + 挂起册数 */
  const attentionCount = computed<number>(() => queuedUsages.value.length + mismatches.value.length)

  /** 按本侧重记：作废该册全部领用（染色间台账不动），随后重新登记 */
  async function reRecordVolume(volumeId: string): Promise<number> {
    const leafIds = new Set(leafStore.leaves.filter((leaf) => leaf.volumeId === volumeId).map((leaf) => leaf.id))
    const now = Date.now()
    const rows = usages.value
      .filter((usage) => leafIds.has(usage.leafId) && usage.state !== 'void')
      .map((usage) => ({
        ...usage,
        state: 'void' as PaperUsageState,
        note: usage.note ? `${usage.note}；对账重记作废` : '对账重记作废',
        updatedAt: now
      }))
    if (rows.length > 0) {
      await db.paperUsages.bulkPut(rows)
      await loadUsages()
      await fulfillQueue()
    }
    return rows.length
  }

  return {
    batches,
    usages,
    loading,
    ready,
    error,
    sortedBatches,
    sortedUsages,
    queuedUsages,
    totalReturned,
    totalRemaining,
    mismatches,
    suspendedCount,
    attentionCount,
    loadAll,
    batchById,
    allocatedOfBatch,
    remainingOfBatch,
    createBatch,
    updateBatch,
    removeBatch,
    requestUsage,
    returnUsage,
    voidUsage,
    reRecordVolume
  }
})
