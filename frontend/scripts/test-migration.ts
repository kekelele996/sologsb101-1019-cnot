/* v2 → v3 Dexie 升级冒烟测试：旧补纸没有浴次归属，升级后按纸种回填历史浴次 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import Dexie, { type Table } from 'dexie'
import { db, DB_VERSION } from '@/utils/db'
import { LEGACY_BATH_ID } from '@/types/dyeBath'
import type { Paper } from '@/types/paper'

/* 1. 按旧结构（v2）建库并写入没有 bathId 的补纸 */
class LegacyDb extends Dexie {
  papers!: Table<Paper, string>
  constructor() {
    super('gbbookrestore')
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    this.version(2).stores({
      books: 'id, title, era, level, collectionNo, updatedAt',
      volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
      papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
      bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
    })
  }
}

const legacy = new LegacyDb()
await legacy.open()
const now = Date.now()
// 注意：旧对象刻意不带 bathId
await legacy.papers.bulkPut([
  { id: 'p1', leafId: 'x1', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.2, dyeRecipe: '旧竹配方', createdAt: now, updatedAt: now } as Paper,
  { id: 'p2', leafId: 'x2', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 2.2, dyeRecipe: '', createdAt: now, updatedAt: now } as Paper,
  { id: 'p3', leafId: 'x3', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 0.8, dyeRecipe: '旧宣配方', createdAt: now, updatedAt: now } as Paper
])
await legacy.close()

/* 2. 用当前代码（v3）打开同名库，触发升级 */
assert.strictEqual(DB_VERSION, 3)
await db.open()

const baths = await db.dyeBaths.toArray()
assert.strictEqual(baths.length, 3, '应回填 3 口历史缸')
const byId = Object.fromEntries(baths.map((b) => [b.id, b]))
assert.ok(byId[LEGACY_BATH_ID.bamboo]?.legacy)
assert.strictEqual(byId[LEGACY_BATH_ID.bamboo]?.bathNo, '竹-旧')
assert.strictEqual(byId[LEGACY_BATH_ID.bamboo]?.state, 'legacy')
assert.strictEqual(byId[LEGACY_BATH_ID.bamboo]?.capacity, 0)
assert.strictEqual(byId[LEGACY_BATH_ID.bark]?.bathNo, '皮-旧')
assert.strictEqual(byId[LEGACY_BATH_ID.xuan]?.bathNo, '宣-旧')

const papers = await db.papers.toArray()
const p1 = papers.find((p) => p.id === 'p1')
const p2 = papers.find((p) => p.id === 'p2')
const p3 = papers.find((p) => p.id === 'p3')
assert.strictEqual(p1?.bathId, LEGACY_BATH_ID.bamboo)
assert.strictEqual(p2?.bathId, LEGACY_BATH_ID.bark)
assert.strictEqual(p3?.bathId, LEGACY_BATH_ID.xuan)

// 历史缸不参与发放：新领用必须排队
const { occupancyOf, chooseBath } = await import('@/utils/bathLedger')
const occ = occupancyOf(byId[LEGACY_BATH_ID.bamboo], [])
assert.strictEqual(occ.issuable, false)
assert.strictEqual(chooseBath('bamboo', baths, [], 1), null)

console.log('v2→v3 升级（历史浴次回填）断言通过 ✓')
