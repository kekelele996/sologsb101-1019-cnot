/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 *   v2 → v3：染色浴次账（dyeBaths）+ 工位领用账（leafIssuances），
 *            旧补纸数据没有浴次归属，按纸种回填为历史浴次后再启用
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie'
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper, type PaperType } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import { LEGACY_BATH_ID, legacyBathNo, type DyeBath } from '@/types/dyeBath'
import type { LeafIssuance } from '@/types/leafIssuance'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号 */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  volumes!: Table<Volume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  dyeBaths!: Table<DyeBath, string>
  leafIssuances!: Table<LeafIssuance, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })
      })
    // v3：染色间浴次账 + 修复工位领用账；旧补纸没有浴次归属，按纸种回填为历史浴次再启用
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, bathId, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        dyeBaths: 'id, bathNo, paperType, state, updatedAt',
        leafIssuances: 'id, leafId, bathId, purpose, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 先按纸种建三口历史缸：旧补纸统一回填到对应历史浴次，启用后只入新缸
        const now = Date.now()
        const legacyBaths: DyeBath[] = (['bamboo', 'bark', 'xuan'] as PaperType[]).map((paperType) => ({
          id: LEGACY_BATH_ID[paperType],
          bathNo: legacyBathNo(paperType),
          paperType,
          recipe: DEFAULT_DYE_RECIPE[paperType],
          capacity: 0,
          startDate: '',
          dyer: '历史回填',
          state: 'legacy',
          legacy: true,
          createdAt: now,
          updatedAt: now
        }))
        await tx.table<DyeBath>('dyeBaths').bulkPut(legacyBaths)
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            paper.bathId = LEGACY_BATH_ID[paper.paperType] ?? LEGACY_BATH_ID.bamboo
          })
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Book → Volume → Leaf →（Paper / RepairOrder）＋ Volume → Binding */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  const volumes: Volume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, bindingType: 'thread', state: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, bindingType: 'wrapped', state: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, bindingType: 'thread', state: 'archived', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, bindingType: 'butterfly', state: 'archived', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, bathId: 'bath_bamboo_01', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, bathId: '', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, bathId: 'bath_xuan_01', createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, bathId: 'bath_legacy_bamboo', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, bathId: 'bath_bark_01', createdAt: now - day * 45, updatedAt: now - day * 45 },
    { id: 'paper_0202', leafId: 'leaf_020102', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.8, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, bathId: 'bath_bamboo_02', createdAt: now - day * 9, updatedAt: now - day * 9 },
    { id: 'paper_0104', leafId: 'leaf_010103', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.8, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, bathId: '', createdAt: now - day * 6, updatedAt: now - day * 6 }
  ]

  const dyeBaths: DyeBath[] = [
    // 启用浴次账之前按纸种回填的三口历史缸（旧补纸的浴次归属）
    { id: 'bath_legacy_bamboo', bathNo: '竹-旧', paperType: 'bamboo', recipe: DEFAULT_DYE_RECIPE.bamboo, capacity: 0, startDate: '', dyer: '历史回填', state: 'legacy', legacy: true, createdAt: now - day * 45, updatedAt: now - day * 45 },
    { id: 'bath_legacy_bark', bathNo: '皮-旧', paperType: 'bark', recipe: DEFAULT_DYE_RECIPE.bark, capacity: 0, startDate: '', dyer: '历史回填', state: 'legacy', legacy: true, createdAt: now - day * 45, updatedAt: now - day * 45 },
    { id: 'bath_legacy_xuan', bathNo: '宣-旧', paperType: 'xuan', recipe: DEFAULT_DYE_RECIPE.xuan, capacity: 0, startDate: '', dyer: '历史回填', state: 'legacy', legacy: true, createdAt: now - day * 45, updatedAt: now - day * 45 },
    // 启用后的新缸：竹-01 已到顶、竹-02 在染、皮-01 染坏退回后余量回补、宣-01 在染
    { id: 'bath_bamboo_01', bathNo: '竹-01', paperType: 'bamboo', recipe: DEFAULT_DYE_RECIPE.bamboo, capacity: 2, startDate: '2026-09-18', dyer: '染工 周禾', state: 'full', legacy: false, createdAt: now - day * 15, updatedAt: now - day * 10 },
    { id: 'bath_bamboo_02', bathNo: '竹-02', paperType: 'bamboo', recipe: DEFAULT_DYE_RECIPE.bamboo, capacity: 12, startDate: '2026-09-24', dyer: '染工 周禾', state: 'active', legacy: false, createdAt: now - day * 9, updatedAt: now - day * 9 },
    { id: 'bath_bark_01', bathNo: '皮-01', paperType: 'bark', recipe: DEFAULT_DYE_RECIPE.bark, capacity: 8, startDate: '2026-08-20', dyer: '染工 周禾', state: 'active', legacy: false, createdAt: now - day * 44, updatedAt: now - day * 40 },
    { id: 'bath_xuan_01', bathNo: '宣-01', paperType: 'xuan', recipe: DEFAULT_DYE_RECIPE.xuan, capacity: 3, startDate: '2026-09-21', dyer: '染工 林染', state: 'active', legacy: false, createdAt: now - day * 12, updatedAt: now - day * 12 }
  ]

  const leafIssuances: LeafIssuance[] = [
    // 竹-01 已用罄：两张均耗用
    { id: 'iss_010101', leafId: 'leaf_010101', bathId: 'bath_bamboo_01', sheets: 1, purpose: 'mend', state: 'issued', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '沈玉', date: '2026-09-19', reissueOfId: '', createdAt: now - day * 14, updatedAt: now - day * 13 },
    { id: 'iss_030102', leafId: 'leaf_030102', bathId: 'bath_bamboo_01', sheets: 1, purpose: 'mend', state: 'used', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '沈玉', date: '2026-09-20', reissueOfId: '', createdAt: now - day * 13, updatedAt: now - day * 10 },
    // 竹-02 在染：第 11 叶领用后已耗用
    { id: 'iss_020102', leafId: 'leaf_020102', bathId: 'bath_bamboo_02', sheets: 1, purpose: 'mend', state: 'used', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '陆敏', date: '2026-09-25', reissueOfId: '', createdAt: now - day * 8, updatedAt: now - day * 7 },
    // 宣-01：第 8 叶领用中
    { id: 'iss_010102', leafId: 'leaf_010102', bathId: 'bath_xuan_01', sheets: 1, purpose: 'mend', state: 'issued', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '陆敏', date: '2026-09-22', reissueOfId: '', createdAt: now - day * 11, updatedAt: now - day * 11 },
    // 皮-01：染坏整额退回、按余量重算后由沈玉重领重记（演示两本账对得上的正常退回）
    { id: 'iss_030101_r', leafId: 'leaf_030101', bathId: 'bath_bark_01', sheets: 2, purpose: 'mend', state: 'returned', queueNote: '', returnedSheets: 2, returnReason: '色花不匀，整批染坏', receiver: '沈玉', date: '2026-08-22', reissueOfId: '', createdAt: now - day * 42, updatedAt: now - day * 41 },
    { id: 'iss_030101', leafId: 'leaf_030101', bathId: 'bath_bark_01', sheets: 2, purpose: 'mount', state: 'used', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '沈玉', date: '2026-08-24', reissueOfId: 'iss_030101_r', createdAt: now - day * 40, updatedAt: now - day * 38 },
    // 竹-01 到顶后新领用先排队等下一缸（竹-02 已开缸，可在此补排）
    { id: 'iss_010101_q', leafId: 'leaf_010101', bathId: '', sheets: 1, purpose: 'press', state: 'queued', queueNote: '竹-01 容量到顶，排队等下一缸', returnedSheets: 0, returnReason: '', receiver: '沈玉', date: '2026-09-21', reissueOfId: '', createdAt: now - day * 12, updatedAt: now - day * 12 },
    // 对账挂起演示：第 8 叶水渍配的是宣纸，工位却记成皮-01（纸种不符），该册挂起待重记
    { id: 'iss_010103_bad', leafId: 'leaf_010103', bathId: 'bath_bark_01', sheets: 1, purpose: 'mend', state: 'issued', queueNote: '', returnedSheets: 0, returnReason: '', receiver: '陆敏', date: '2026-09-26', reissueOfId: '', createdAt: now - day * 7, updatedAt: now - day * 7 },
    // 宣纸余量不足：第 8 叶水渍还要 3 张，宣-01 只剩 2 张，排队等下一缸
    { id: 'iss_010103_q', leafId: 'leaf_010103', bathId: '', sheets: 3, purpose: 'mount', state: 'queued', queueNote: '宣-01 余量不足，排队等下一缸宣', returnedSheets: 0, returnReason: '', receiver: '陆敏', date: '2026-09-27', reissueOfId: '', createdAt: now - day * 6, updatedAt: now - day * 6 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBaths, db.leafIssuances],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.dyeBaths.bulkPut(dyeBaths)
      await db.leafIssuances.bulkPut(leafIssuances)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  dyeBaths: DyeBath[]
  leafIssuances: LeafIssuance[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, dyeBaths, leafIssuances] = await Promise.all([
    db.books.toArray(),
    db.volumes.toArray(),
    db.leaves.toArray(),
    db.papers.toArray(),
    db.repairOrders.toArray(),
    db.bindings.toArray(),
    db.dyeBaths.toArray(),
    db.leafIssuances.toArray()
  ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    volumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    dyeBaths,
    leafIssuances
  }
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot>
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`
  const keys: Array<keyof RestoreSnapshot> = [
    'books',
    'volumes',
    'leaves',
    'papers',
    'repairOrders',
    'bindings',
    'dyeBaths',
    'leafIssuances'
  ]
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBaths, db.leafIssuances],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.dyeBaths.clear(),
        db.leafIssuances.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.dyeBaths.bulkPut(snapshot.dyeBaths)
      await db.leafIssuances.bulkPut(snapshot.leafIssuances)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBaths, db.leafIssuances],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.dyeBaths.clear(),
        db.leafIssuances.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, dyeBaths, leafIssuances] = await Promise.all([
    db.books.count(),
    db.volumes.count(),
    db.leaves.count(),
    db.papers.count(),
    db.repairOrders.count(),
    db.bindings.count(),
    db.dyeBaths.count(),
    db.leafIssuances.count()
  ])
  return { books, volumes, leaves, papers, repairOrders, bindings, dyeBaths, leafIssuances }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 领用账（染色间浴次账不动） */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.leafIssuances],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.leafIssuances.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.volumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 领用账（染色间浴次账不动） */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.leafIssuances],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.leafIssuances.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 / 领用账 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders, db.leafIssuances], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.leafIssuances.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
