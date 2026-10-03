/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   （v1 → v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方；
 *     v2 → v3：新增染色浴次 / 补纸领用两本台账，旧补纸记录按纸种回填成历史浴次）
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
import type { DyeBatch } from '@/types/dyeBatch'
import type { PaperUsage } from '@/types/paperUsage'

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
  dyeBatches!: Table<DyeBatch, string>
  paperUsages!: Table<PaperUsage, string>

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
    // v3：新增染色浴次 / 补纸领用两本台账（未列出的表沿用 v2 结构）；
    // 本地旧数据的补纸记录没有浴次归属，先按纸种回填成历史浴次再启用
    this.version(DB_VERSION)
      .stores({
        dyeBatches: 'id, seq, paperType, source, updatedAt',
        paperUsages: 'id, batchId, leafId, repairOrderId, paperType, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const existing = await tx.table('dyeBatches').count()
        if (existing > 0) return
        const papers = await tx.table<Paper>('papers').toArray()
        if (papers.length === 0) return
        const { batches, usages } = backfillHistoricalBatches(papers)
        await tx.table('dyeBatches').bulkPut(batches)
        await tx.table('paperUsages').bulkPut(usages)
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 旧数据回填：没有浴次归属的补纸记录按纸种汇总成历史浴次，
 * 并为每张补纸生成一条对应的领用记录（容量 = 该纸种补纸张数，余量恰好为 0）。
 * v2 → v3 升级迁移与导入旧版备份共用。
 */
export function backfillHistoricalBatches(papers: Paper[]): { batches: DyeBatch[]; usages: PaperUsage[] } {
  const now = Date.now()
  const byType = new Map<PaperType, Paper[]>()
  papers.forEach((paper) => {
    const list = byType.get(paper.paperType) ?? []
    list.push(paper)
    byType.set(paper.paperType, list)
  })
  const batches: DyeBatch[] = []
  const usages: PaperUsage[] = []
  let seq = 1
  byType.forEach((list, paperType) => {
    const batchId = createId('batch')
    batches.push({
      id: batchId,
      seq,
      paperType,
      dyeRecipe: DEFAULT_DYE_RECIPE[paperType],
      capacity: list.length,
      source: 'backfill',
      note: '旧数据按纸种回填的历史浴次',
      createdAt: now,
      updatedAt: now
    })
    seq += 1
    list.forEach((paper) => {
      usages.push({
        id: createId('usage'),
        batchId,
        paperType,
        leafId: paper.leafId,
        repairOrderId: '',
        count: 1,
        returnedCount: 0,
        state: 'active',
        note: '历史回填',
        createdAt: now,
        updatedAt: now
      })
    })
  })
  return { batches, usages }
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
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
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

  // 染色间台账：三缸浴次（竹纸头缸余量仅 1 张，用来演示排队等下一缸）
  const dyeBatches: DyeBatch[] = [
    { id: 'batch_01', seq: 1, paperType: 'bamboo', dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, capacity: 6, source: 'manual', note: '头缸竹纸，先配《昌黎先生集》补破', createdAt: now - day * 14, updatedAt: now - day * 11 },
    { id: 'batch_02', seq: 2, paperType: 'bark', dyeRecipe: DEFAULT_DYE_RECIPE.bark, capacity: 8, source: 'manual', note: '', createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'batch_03', seq: 3, paperType: 'xuan', dyeRecipe: DEFAULT_DYE_RECIPE.xuan, capacity: 5, source: 'manual', note: '', createdAt: now - day * 9, updatedAt: now - day * 9 }
  ]

  // 修复工位台账：按书叶领用、顶哪道补破；usage_01 演示染坏退回，usage_04 演示容量到顶排队
  const paperUsages: PaperUsage[] = [
    { id: 'usage_01', batchId: 'batch_01', paperType: 'bamboo', leafId: 'leaf_010101', repairOrderId: 'order_010101', count: 2, returnedCount: 1, state: 'active', note: '染坏 1 张已退回', createdAt: now - day * 13, updatedAt: now - day * 11 },
    { id: 'usage_02', batchId: 'batch_01', paperType: 'bamboo', leafId: 'leaf_020101', repairOrderId: 'order_020101', count: 4, returnedCount: 0, state: 'active', note: '', createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'usage_03', batchId: 'batch_03', paperType: 'xuan', leafId: 'leaf_010102', repairOrderId: '', count: 1, returnedCount: 0, state: 'active', note: '', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'usage_04', batchId: '', paperType: 'bamboo', leafId: 'leaf_010201', repairOrderId: 'order_010201', count: 2, returnedCount: 0, state: 'queued', note: '头缸到顶，等下一缸', createdAt: now - day * 8, updatedAt: now - day * 8 }
  ]

  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBatches, db.paperUsages],
    async () => {
      await db.books.bulkPut(books)
      await db.volumes.bulkPut(volumes)
      await db.leaves.bulkPut(leaves)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
      await db.dyeBatches.bulkPut(dyeBatches)
      await db.paperUsages.bulkPut(paperUsages)
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
  dyeBatches: DyeBatch[]
  paperUsages: PaperUsage[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, volumes, leaves, papers, repairOrders, bindings, dyeBatches, paperUsages] = await Promise.all([
    db.books.toArray(),
    db.volumes.toArray(),
    db.leaves.toArray(),
    db.papers.toArray(),
    db.repairOrders.toArray(),
    db.bindings.toArray(),
    db.dyeBatches.toArray(),
    db.paperUsages.toArray()
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
    dyeBatches,
    paperUsages
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
    'bindings'
  ]
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }
  // v2 及以前的旧备份没有两本台账，允许缺省（导入时按纸种回填历史浴次）
  const ledgerKeys: Array<keyof RestoreSnapshot> = ['dyeBatches', 'paperUsages']
  for (const key of ledgerKeys) {
    const value = snapshot[key]
    if (value !== undefined && !Array.isArray(value)) return `备份文件的 ${String(key)} 集合格式不正确`
  }
  return ''
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  // 旧版备份没有浴次归属：先按纸种回填成历史浴次再启用
  const backfilled =
    Array.isArray(snapshot.dyeBatches) && Array.isArray(snapshot.paperUsages)
      ? null
      : backfillHistoricalBatches(snapshot.papers)
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBatches, db.paperUsages],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.dyeBatches.clear(),
        db.paperUsages.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.volumes.bulkPut(snapshot.volumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.dyeBatches.bulkPut(backfilled ? backfilled.batches : snapshot.dyeBatches)
      await db.paperUsages.bulkPut(backfilled ? backfilled.usages : snapshot.paperUsages)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.dyeBatches, db.paperUsages],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.volumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.dyeBatches.clear(),
        db.paperUsages.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, volumes, leaves, papers, repairOrders, bindings, dyeBatches, paperUsages] = await Promise.all([
    db.books.count(),
    db.volumes.count(),
    db.leaves.count(),
    db.papers.count(),
    db.repairOrders.count(),
    db.bindings.count(),
    db.dyeBatches.count(),
    db.paperUsages.count()
  ])
  return { books, volumes, leaves, papers, repairOrders, bindings, dyeBatches, paperUsages }
}

/** 级联删除古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订 / 领用（染色间浴次台账不动） */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.volumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [db.books, db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperUsages],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.paperUsages.where('leafId').anyOf(leafIds).delete()
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

/** 级联删除册次 → 书叶 → 补纸 / 工序 / 装订 / 领用（染色间浴次台账不动） */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings, db.paperUsages],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
        await db.paperUsages.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.volumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序 / 领用 */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders, db.paperUsages], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.paperUsages.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}
