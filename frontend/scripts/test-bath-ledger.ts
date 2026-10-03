/* 浴次两本账核心逻辑冒烟测试（不触 IndexedDB，直接构造内存数据） */
import assert from 'node:assert'
import { occupancyOf, occupancyMap, chooseBath, reconcileLedger } from '@/utils/bathLedger'
import { LEGACY_BATH_ID } from '@/types/dyeBath'
import type { DyeBath } from '@/types/dyeBath'
import type { LeafIssuance } from '@/types/leafIssuance'
import type { Leaf } from '@/types/leaf'
import type { Paper } from '@/types/paper'

const now = 1000
function bath(partial: Partial<DyeBath> & Pick<DyeBath, 'id' | 'bathNo' | 'paperType' | 'capacity'>): DyeBath {
  return {
    recipe: 'r', startDate: '2026-10-01', dyer: 'd', state: 'active', legacy: false,
    createdAt: now, updatedAt: now, ...partial
  }
}
function iss(partial: Partial<LeafIssuance> & Pick<LeafIssuance, 'id' | 'leafId' | 'bathId' | 'sheets' | 'state'>): LeafIssuance {
  return {
    purpose: 'mend', queueNote: '', returnedSheets: 0, returnReason: '', receiver: 'r',
    date: '2026-10-01', reissueOfId: '', createdAt: now, updatedAt: now, ...partial
  }
}
function leaf(id: string, volumeId: string, leafNo: number): Leaf {
  return { id, volumeId, leafNo, damageType: 'worm', damageAreaCm2: 1, phValue: 7, state: 'pending', createdAt: now, updatedAt: now }
}
function paper(leafId: string, paperType: Paper['paperType']): Paper {
  return { id: `p_${leafId}`, leafId, paperType, laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1, dyeRecipe: 'r', bathId: '', createdAt: now, updatedAt: now }
}

/* 1. 余量：已领用+已耗用占，历史缸恒不可领 */
const b1 = bath({ id: 'b1', bathNo: '竹-01', paperType: 'bamboo', capacity: 5 })
const rows: LeafIssuance[] = [
  iss({ id: 'i1', leafId: 'l1', bathId: 'b1', sheets: 2, state: 'issued' }),
  iss({ id: 'i2', leafId: 'l2', bathId: 'b1', sheets: 2, state: 'used' })
]
let occ = occupancyOf(b1, rows)
assert.strictEqual(occ.occupied, 4)
assert.strictEqual(occ.remaining, 1)
assert.strictEqual(occ.full, false)
assert.strictEqual(occ.issuable, true)

const legacy = bath({ id: LEGACY_BATH_ID.bamboo, bathNo: '竹-旧', paperType: 'bamboo', capacity: 0, state: 'legacy', legacy: true })
occ = occupancyOf(legacy, [])
assert.strictEqual(occ.remaining, 0)
assert.strictEqual(occ.issuable, false)

/* 2. 容量到顶：5 张占满后 chooseBath 找不到缸 → 排队 */
rows.push(iss({ id: 'i3', leafId: 'l3', bathId: 'b1', sheets: 1, state: 'issued' }))
occ = occupancyOf(b1, rows)
assert.strictEqual(occ.remaining, 0)
assert.strictEqual(occ.full, true)
assert.strictEqual(chooseBath('bamboo', [b1], rows, 1), null)

/* 3. 染坏整额退回不占缸，余量回补可重领同缸 */
const returned = iss({ id: 'i3', leafId: 'l3', bathId: 'b1', sheets: 1, state: 'returned', returnedSheets: 1 })
const afterReturn = rows.map((x) => (x.id === 'i3' ? returned : x))
occ = occupancyOf(b1, afterReturn)
assert.strictEqual(occ.occupied, 4)
assert.strictEqual(occ.returned, 1)
assert.strictEqual(occ.remaining, 1)
const picked = chooseBath('bamboo', [b1], afterReturn, 1)
assert.strictEqual(picked?.id, 'b1')

// 部分退回（退 1 / 领 2）只回补 1 张
const partial = iss({ id: 'i4', leafId: 'l4', bathId: 'b1', sheets: 2, state: 'returned', returnedSheets: 1 })
assert.strictEqual(occupancyOf(b1, [...afterReturn, partial]).occupied, 5)

/* 4. 开下一缸：先开满余量旧缸（先到先得），旧缸满才给新缸 */
const b2 = bath({ id: 'b2', bathNo: '竹-02', paperType: 'bamboo', capacity: 10 })
const b0full = bath({ id: 'b0', bathNo: '竹-00', paperType: 'bamboo', capacity: 4 })
const fullRows = [
  iss({ id: 'f1', leafId: 'l9', bathId: 'b0', sheets: 4, state: 'used' })
]
assert.strictEqual(chooseBath('bamboo', [b2, b0full], fullRows, 1)?.id, 'b2')
// 旧缸有余量时优先旧缸
const b0space = bath({ id: 'b0', bathNo: '竹-00', paperType: 'bamboo', capacity: 4 })
assert.strictEqual(chooseBath('bamboo', [b2, b0space], [], 2)?.id, 'b0')

/* 5. 对账：纸种不符挂起；缺失浴次挂起；超缸容挂起；退回未重领挂起 */
const leaves: Leaf[] = [
  leaf('l1', 'v1', 1),
  leaf('l2', 'v1', 2),
  leaf('l3', 'v2', 3),
  leaf('l4', 'v2', 4),
  leaf('l5', 'v3', 5)
]
const papers: Paper[] = [
  paper('l1', 'bamboo'),
  paper('l2', 'bamboo'),
  paper('l3', 'bamboo'),
  paper('l4', 'bamboo'),
  paper('l5', 'xuan')
]
const bathBark = bath({ id: 'bk', bathNo: '皮-01', paperType: 'bark', capacity: 5 })
const bathXuan = bath({ id: 'xn', bathNo: '宣-01', paperType: 'xuan', capacity: 3 })
const ledger: LeafIssuance[] = [
  iss({ id: 'g1', leafId: 'l1', bathId: 'bk', sheets: 1, state: 'issued' }),          // 纸种不符 → v1
  iss({ id: 'g2', leafId: 'l2', bathId: 'gone', sheets: 1, state: 'issued' }),        // 浴次缺失 → v1
  iss({ id: 'g3', leafId: 'l3', bathId: 'b1', sheets: 6, state: 'issued' }),          // 缸容 5 超占 → v2
  iss({ id: 'g4', leafId: 'l4', bathId: 'b1', sheets: 1, state: 'returned', returnedSheets: 1 }), // 退回未重领 → v2
  iss({ id: 'g5', leafId: 'l5', bathId: '', sheets: 3, state: 'queued', queueNote: '等下一缸宣' }) // 排队不挂起
]
const rec = reconcileLedger({
  baths: [bath({ id: 'b1', bathNo: '竹-01', paperType: 'bamboo', capacity: 5 }), bathBark, bathXuan],
  issuances: ledger,
  leaves,
  papers
})
const kinds = new Set(rec.issues.map((x) => x.kind))
assert.deepStrictEqual([...kinds].sort(), ['missing-bath', 'over-capacity', 'paper-type-mismatch', 'returned-open'].sort())
assert.deepStrictEqual(rec.suspendedVolumeIds.sort(), ['v1', 'v2'])
assert.strictEqual(rec.waiting.length, 1)
assert.strictEqual(rec.waiting[0]?.leafNo, 5)
assert.strictEqual(rec.waiting[0]?.paperType, 'xuan')

// 退回后已有重领（reissueOfId 指回）→ 不再挂 returned-open
const withReissue = [
  ...ledger.filter((x) => x.id !== 'g4'),
  iss({ id: 'g4r', leafId: 'l4', bathId: 'b1', sheets: 1, state: 'returned', returnedSheets: 1 }),
  iss({ id: 'g4n', leafId: 'l4', bathId: 'b1', sheets: 1, state: 'issued', reissueOfId: 'g4r' })
]
const rec2 = reconcileLedger({
  baths: [bath({ id: 'b1', bathNo: '竹-01', paperType: 'bamboo', capacity: 5 }), bathBark, bathXuan],
  issuances: withReissue,
  leaves,
  papers
})
assert.ok(!rec2.issues.some((x) => x.kind === 'returned-open'))

/* 6. occupancyMap 覆盖所有缸 */
const map = occupancyMap([legacy, b2], [])
assert.strictEqual(map[legacy.id]?.bath.legacy, true)
assert.strictEqual(map[b2.id]?.remaining, 10)

console.log('bathLedger 全部断言通过 ✓')
