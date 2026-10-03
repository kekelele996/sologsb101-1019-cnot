/**
 * 补纸领用（PaperUsage）数据模型
 * 修复工位台账：按书叶领用哪一浴次、领几张、顶哪道补破。
 * 容量到顶的领用先排队（queued）等下一缸；染坏的按余量退回（returnedCount）重算；
 * 两本账对不上时整册作废（void）重记，染色间台账不动。
 */
import type { PaperType } from './paper'

/** 领用状态：已领用 / 排队中 / 已作废 */
export type PaperUsageState = 'active' | 'queued' | 'void'

export interface PaperUsage {
  id: string;
  /** 领用的浴次 id；排队中为空串 */
  batchId: string;
  /** 纸种（排队时没有浴次，也要记下等哪一缸） */
  paperType: PaperType;
  /** 关联书叶 id */
  leafId: string;
  /** 顶哪道补破（RepairOrder id）；不关联或历史回填为空串 */
  repairOrderId: string;
  /** 领几张 */
  count: number;
  /** 染坏退回的张数（按余量退回重算） */
  returnedCount: number;
  state: PaperUsageState;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export const PAPER_USAGE_STATE_LABEL: Record<PaperUsageState, string> = {
  active: '已领用',
  queued: '排队中',
  void: '已作废',
}

export const PAPER_USAGE_STATE_OPTIONS: ReadonlyArray<{ value: PaperUsageState; label: string }> = [
  { value: 'active', label: '已领用' },
  { value: 'queued', label: '排队中' },
  { value: 'void', label: '已作废' },
]

/** 净领用张数：只有「已领用」占浴次余量（领 - 退） */
export function usageNetCount(usage: PaperUsage): number {
  return usage.state === 'active' ? usage.count - usage.returnedCount : 0
}
