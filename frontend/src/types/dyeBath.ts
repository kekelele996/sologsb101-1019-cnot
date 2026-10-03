/**
 * 染色浴次（DyeBath）数据模型 —— 染色间那本账
 * 按浴次登记纸种、染色配方与这一缸能染的张数（容量）。
 * 容量到顶后新的领用先排队等下一缸；染色间账本一经登记不可改写。
 */
import type { PaperType } from './paper'

/** 浴次状态：在染（仍有余量可领）/ 已用罄 / 历史回填 */
export type DyeBathState = 'active' | 'full' | 'legacy'

export interface DyeBath {
  id: string
  /** 浴次号，同纸种内唯一，如「竹-01」；历史回填为「竹-旧」 */
  bathNo: string
  /** 纸种 */
  paperType: PaperType
  /** 染色配方 */
  recipe: string
  /** 本缸能染的张数（容量） */
  capacity: number
  /** 开缸日期 yyyy-MM-dd */
  startDate: string
  /** 染色间登记人 */
  dyer: string
  /** 在染 / 已用罄 / 历史（旧数据回填） */
  state: DyeBathState
  /** 是否为启用浴次账之前按纸种回填的历史浴次 */
  legacy: boolean
  createdAt: number
  updatedAt: number
}

export type DyeBathDraft = Omit<DyeBath, 'id' | 'createdAt' | 'updatedAt'>

export const DYE_BATH_STATE_LABEL: Record<DyeBathState, string> = {
  active: '在染',
  full: '已用罄',
  legacy: '历史'
}

export const DYE_BATH_STATE_COLOR: Record<DyeBathState, string> = {
  active: '#1e8449',
  full: '#8c8c8c',
  legacy: '#a8623a'
}

export const DYE_BATH_STATE_OPTIONS: ReadonlyArray<{ value: DyeBathState; label: string }> = [
  { value: 'active', label: '在染' },
  { value: 'full', label: '已用罄' },
  { value: 'legacy', label: '历史' }
]

/** 纸种 → 浴次号前缀（竹 / 皮 / 宣） */
export const BATH_NO_PREFIX: Record<PaperType, string> = {
  bamboo: '竹',
  bark: '皮',
  xuan: '宣'
}

/** 历史浴次的浴次号后缀 */
export const LEGACY_BATH_NO = '旧'

/** 生成同纸种下一个浴次号：竹-01、竹-02 …（历史浴次不占序号） */
export function nextBathNo(paperType: PaperType, existing: Array<Pick<DyeBath, 'bathNo' | 'legacy'>>): string {
  const prefix = BATH_NO_PREFIX[paperType]
  let max = 0
  existing.forEach((bath) => {
    if (bath.legacy) return
    const match = bath.bathNo.match(new RegExp(`^${prefix}-(\\d+)$`))
    if (match) max = Math.max(max, Number(match[1]))
  })
  return `${prefix}-${String(max + 1).padStart(2, '0')}`
}

/** 历史浴次的固定浴次号 */
export function legacyBathNo(paperType: PaperType): string {
  return `${BATH_NO_PREFIX[paperType]}-${LEGACY_BATH_NO}`
}

/** 历史浴次固定主键（v3 迁移回填与播种共用） */
export const LEGACY_BATH_ID: Record<PaperType, string> = {
  bamboo: 'bath_legacy_bamboo',
  bark: 'bath_legacy_bark',
  xuan: 'bath_legacy_xuan'
}

export function createEmptyDyeBathDraft(
  paperType: PaperType,
  bathNo: string,
  recipe: string
): DyeBathDraft {
  return {
    bathNo,
    paperType,
    recipe,
    capacity: 20,
    startDate: new Date().toISOString().slice(0, 10),
    dyer: '',
    state: 'active',
    legacy: false
  }
}
