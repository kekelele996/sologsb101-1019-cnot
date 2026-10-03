/**
 * 染色浴次（DyeBatch）数据模型
 * 染色间台账：每一缸染液记一浴 —— 纸种、染色配方与这一缸能染的张数。
 * 修复工位领用走 PaperUsage；余量 = 容量 - 已领（净），到顶后新领用排队等下一缸。
 */
import { DEFAULT_DYE_RECIPE, PAPER_TYPE_LABEL, type PaperType } from './paper'

/** 浴次来源：染色间登记 / 旧数据按纸种回填 */
export type DyeBatchSource = 'manual' | 'backfill'

export interface DyeBatch {
  id: string;
  /** 浴次序号，全库递增，从 1 开始 */
  seq: number;
  /** 纸种 */
  paperType: PaperType;
  /** 染色配方 */
  dyeRecipe: string;
  /** 这一缸能染的张数 */
  capacity: number;
  /** 来源：染色间登记或旧数据回填 */
  source: DyeBatchSource;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 新开一缸时由染色间填写；seq 与 source 由台账自动编定 */
export type DyeBatchDraft = Omit<DyeBatch, 'id' | 'seq' | 'source' | 'createdAt' | 'updatedAt'>;

export const DYE_BATCH_SOURCE_LABEL: Record<DyeBatchSource, string> = {
  manual: '染色间登记',
  backfill: '历史回填',
};

/** 台账里的浴次称呼，如「第 3 浴 · 宣纸」 */
export function dyeBatchLabel(batch: Pick<DyeBatch, 'seq' | 'paperType'>): string {
  return `第 ${batch.seq} 浴 · ${PAPER_TYPE_LABEL[batch.paperType]}`;
}

export function createEmptyDyeBatchDraft(): DyeBatchDraft {
  return {
    paperType: 'bamboo',
    dyeRecipe: DEFAULT_DYE_RECIPE.bamboo,
    capacity: 10,
    note: '',
  };
}
