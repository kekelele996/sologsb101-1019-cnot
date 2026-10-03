/**
 * 补纸领用（LeafIssuance）数据模型 —— 修复工位那本账（按本侧重记）
 * 按书叶登记领哪一浴次的补纸、领几张、顶哪道补破；染坏的按余量退回重算。
 * 修复工位侧记录可反复重记；浴次账（dyeBaths）本身不在此处改写，
 * 余量由染色间账本 + 领用/退纸流水在对账工具中派生。
 */
import type { RepairName } from './repairOrder'

/** 领用状态：待染排队 / 已领用 / 染坏退回 / 已耗用 */
export type IssuanceState = 'queued' | 'issued' | 'returned' | 'used'

/** 领用条目（修复工位侧一条领用记录） */
export interface LeafIssuance {
  id: string
  /** 领用书叶 id */
  leafId: string
  /** 领用浴次 id（排队等下一缸时可为空串） */
  bathId: string
  /** 领用张数 */
  sheets: number
  /** 顶哪道补破（工序名） */
  purpose: RepairName
  /** 待染排队 / 已领用 / 染坏退回 / 已耗用 */
  state: IssuanceState
  /** 排队等下一缸的原因，如「竹-01 容量到顶」 */
  queueNote: string
  /** 染坏退回张数（state=returned 时 > 0） */
  returnedSheets: number
  /** 染坏退回原因 */
  returnReason: string
  /** 领用人 */
  receiver: string
  /** 领用日期 yyyy-MM-dd */
  date: string
  /** 原领用记录 id：染坏后按本侧重记时指向被替换的那条 */
  reissueOfId: string
  createdAt: number
  updatedAt: number
}

export type LeafIssuanceDraft = Omit<LeafIssuance, 'id' | 'createdAt' | 'updatedAt'>

export const ISSUANCE_STATE_LABEL: Record<IssuanceState, string> = {
  queued: '待染排队',
  issued: '已领用',
  returned: '染坏退回',
  used: '已耗用'
}

export const ISSUANCE_STATE_COLOR: Record<IssuanceState, string> = {
  queued: '#d68910',
  issued: '#3a6ea5',
  returned: '#b03a2e',
  used: '#1e8449'
}

export const ISSUANCE_STATE_OPTIONS: ReadonlyArray<{ value: IssuanceState; label: string }> = [
  { value: 'queued', label: '待染排队' },
  { value: 'issued', label: '已领用' },
  { value: 'returned', label: '染坏退回' },
  { value: 'used', label: '已耗用' }
]

/** 可领用 / 可耗用的浴次选择只展示非退回记录的状态 */
export function createEmptyIssuanceDraft(leafId: string): LeafIssuanceDraft {
  return {
    leafId,
    bathId: '',
    sheets: 1,
    purpose: 'mend',
    state: 'queued',
    queueNote: '',
    returnedSheets: 0,
    returnReason: '',
    receiver: '',
    date: new Date().toISOString().slice(0, 10),
    reissueOfId: ''
  }
}
