/**
 * 浴次两本账对账工具
 * - 染色间账本（DyeBath）：容量 / 配方 / 纸种，一经登记不做工位侧改写
 * - 工位账本（LeafIssuance）：按本（册）侧重记领用、染坏退回、重领
 *
 * 余量 = 容量 -（已领用 + 已耗用）-（染坏未退回部分）；染坏整额退回后不占余量。
 * 容量到顶的领用先排队（queued），下一缸开缸或余量退回后按先到先得补排。
 * 两边浴次对不上的册次挂起，只摆浴次号与叶号，由工位侧重记，染色间账本不动。
 */
import type { DyeBath } from '@/types/dyeBath'
import type { LeafIssuance } from '@/types/leafIssuance'
import type { Leaf } from '@/types/leaf'
import type { Paper, PaperType } from '@/types/paper'
import { PAPER_TYPE_LABEL } from '@/types/paper'

/** 一缸的占用与余量 */
export interface BathOccupancy {
  bath: DyeBath
  /** 实际占用张数（染坏整额退回的不计） */
  occupied: number
  /** 染坏退回张数累计 */
  returned: number
  /** 剩余可领张数（历史浴次恒为 0，不再发放新领用） */
  remaining: number
  /** 是否到顶 */
  full: boolean
  /** 是否还能从这缸领纸 */
  issuable: boolean
}

/** 某浴次下参与占用的账条：已领用、已耗用全额占；染坏按未退回部分占 */
function issuanceLoad(item: LeafIssuance): number {
  if (item.bathId === '') return 0
  if (item.state === 'returned') return Math.max(0, item.sheets - item.returnedSheets)
  if (item.state === 'issued' || item.state === 'used') return item.sheets
  return 0
}

export function occupancyOf(bath: DyeBath, issuances: LeafIssuance[]): BathOccupancy {
  const rows = issuances.filter((item) => item.bathId === bath.id)
  const occupied = rows.reduce((sum, item) => sum + issuanceLoad(item), 0)
  const returned = rows
    .filter((item) => item.state === 'returned')
    .reduce((sum, item) => sum + item.returnedSheets, 0)
  const remaining = bath.legacy ? 0 : Math.max(0, bath.capacity - occupied)
  const overfull = !bath.legacy && occupied >= bath.capacity
  return {
    bath,
    occupied,
    returned,
    remaining,
    full: overfull,
    issuable: !bath.legacy && bath.state === 'active' && remaining > 0
  }
}

export function occupancyMap(baths: DyeBath[], issuances: LeafIssuance[]): Record<string, BathOccupancy> {
  const result: Record<string, BathOccupancy> = {}
  baths.forEach((bath) => {
    result[bath.id] = occupancyOf(bath, issuances)
  })
  return result
}

/** 浴次号按纸种序号排序（竹-01 在竹-02 前，历史浴次排最后） */
function bathOrder(bath: DyeBath): number {
  if (bath.legacy) return Number.MAX_SAFE_INTEGER
  const match = bath.bathNo.match(/-(\d+)$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER - 1
}

/**
 * 为指定纸种挑一缸还能领的浴次（先到先得：先开满余量的缸先用）。
 * 容量到顶 / 只有历史缸时返回 null，调用方按排队处理。
 */
export function chooseBath(
  paperType: PaperType,
  baths: DyeBath[],
  issuances: LeafIssuance[],
  sheets = 1
): DyeBath | null {
  const candidates = baths
    .filter((bath) => !bath.legacy && bath.state === 'active' && bath.paperType === paperType)
    .sort((a, b) => bathOrder(a) - bathOrder(b))
  return (
    candidates.find((bath) => occupancyOf(bath, issuances).remaining >= sheets) ?? null
  )
}

/* ------------------------------ 对账挂起 ------------------------------ */

export type ReconcileIssueKind = 'missing-bath' | 'paper-type-mismatch' | 'over-capacity' | 'returned-open'

export interface ReconcileIssue {
  kind: ReconcileIssueKind
  /** 对应的工位账条 id（按本侧重记时精确定位） */
  issuanceId: string
  volumeId: string
  leafId: string
  leafNo: number
  bathId: string
  bathNo: string
  message: string
}

export interface WaitingQueueItem {
  volumeId: string
  leafId: string
  leafNo: number
  issuanceId: string
  paperType: PaperType | ''
  sheets: number
  note: string
}

export interface ReconcileResult {
  /** 两边浴次对不上的账条 */
  issues: ReconcileIssue[]
  /** 需要挂起的册次 id（去重） */
  suspendedVolumeIds: string[]
  /** 挂起明细，按册分组 */
  suspendedByVolume: Record<string, ReconcileIssue[]>
  /** 容量到顶、排队等下一缸的账条（不算对不上，但要摆出来） */
  waiting: WaitingQueueItem[]
}

export const RECONCILE_ISSUE_LABEL: Record<ReconcileIssueKind, string> = {
  'missing-bath': '浴次缺失',
  'paper-type-mismatch': '纸种不符',
  'over-capacity': '超出缸容',
  'returned-open': '退回未重领'
}

export interface ReconcileInput {
  baths: DyeBath[]
  issuances: LeafIssuance[]
  leaves: Leaf[]
  papers: Paper[]
}

export function reconcileLedger(input: ReconcileInput): ReconcileResult {
  const { baths, issuances, leaves, papers } = input
  const bathMap = new Map(baths.map((bath) => [bath.id, bath]))
  const leafMap = new Map(leaves.map((leaf) => [leaf.id, leaf]))
  const paperOfLeaf = (leafId: string): Paper | undefined => papers.find((paper) => paper.leafId === leafId)
  const successorIds = new Set(
    issuances.map((item) => item.reissueOfId).filter((id): id is string => id.length > 0)
  )

  const issues: ReconcileIssue[] = []
  const waiting: WaitingQueueItem[] = []

  const pushIssue = (
    kind: ReconcileIssueKind,
    item: LeafIssuance,
    bath: DyeBath | undefined,
    message: string
  ): void => {
    const leaf = leafMap.get(item.leafId)
    issues.push({
      kind,
      issuanceId: item.id,
      volumeId: leaf?.volumeId ?? '',
      leafId: item.leafId,
      leafNo: leaf?.leafNo ?? 0,
      bathId: item.bathId,
      bathNo: bath?.bathNo ?? '?',
      message
    })
  }

  issuances.forEach((item) => {
    const leaf = leafMap.get(item.leafId)
    if (item.state === 'queued') {
      const paper = paperOfLeaf(item.leafId)
      waiting.push({
        volumeId: leaf?.volumeId ?? '',
        leafId: item.leafId,
        leafNo: leaf?.leafNo ?? 0,
        issuanceId: item.id,
        paperType: paper?.paperType ?? '',
        sheets: item.sheets,
        note: item.queueNote || (paper ? `等待下一缸（${PAPER_TYPE_LABEL[paper.paperType]}）` : '等待下一缸')
      })
      return
    }

    const bath = item.bathId ? bathMap.get(item.bathId) : undefined
    if (!bath) {
      pushIssue('missing-bath', item, undefined, `工位账所记浴次在染色间账本中不存在（浴次 id ${item.bathId || '空'}）`)
      return
    }

    const paper = paperOfLeaf(item.leafId)
    if (paper && paper.paperType !== bath.paperType) {
      pushIssue(
        'paper-type-mismatch',
        item,
        bath,
        `领用浴次为${PAPER_TYPE_LABEL[bath.paperType]}缸，该叶选配的却是${PAPER_TYPE_LABEL[paper.paperType]}`
      )
    }

    if (item.state === 'returned' && !successorIds.has(item.id)) {
      pushIssue('returned-open', item, bath, `染坏退回 ${item.returnedSheets} 张后尚未按本侧重领（${item.returnReason || '未填原因'}）`)
    }
  })

  // 超缸容：按浴次聚合一次，涉及的每个叶号各摆一条
  baths.forEach((bath) => {
    const occ = occupancyOf(bath, issuances)
    if (!bath.legacy && occ.occupied > bath.capacity) {
      issuances
        .filter((item) => item.bathId === bath.id && issuanceLoad(item) > 0)
        .forEach((item) => {
          pushIssue(
            'over-capacity',
            item,
            bath,
            `该缸容量 ${bath.capacity} 张，工位账已领/耗用 ${occ.occupied} 张，超出 ${occ.occupied - bath.capacity} 张`
          )
        })
    }
  })

  const suspendedByVolume: Record<string, ReconcileIssue[]> = {}
  issues.forEach((issue) => {
    if (!issue.volumeId) return
    ;(suspendedByVolume[issue.volumeId] ??= []).push(issue)
  })

  return {
    issues,
    suspendedVolumeIds: Object.keys(suspendedByVolume),
    suspendedByVolume,
    waiting: waiting.sort((a, b) => a.leafId.localeCompare(b.leafId))
  }
}
