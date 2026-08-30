import { describe, it, expect } from 'vitest'
import {
  parseMm,
  serializeMm,
  rootsOf,
  childrenOf,
  subtree,
  descendantsOf,
  canParent,
  setParent,
  setPos,
  setCollapsed,
  setFlag,
  reorderSibling,
  siblingsOf,
  topSelected,
  bandChildrenOf,
  summaryChildrenOf,
  visibleChildrenOf,
  hiddenIds,
  removeNodes,
  parseRels,
  serializeRels,
  pruneRels,
  type MmMap,
} from '../src/mmMap'

describe('mmMap', () => {
  // a(root, positioned) → b → d ; a → c ; e(root)
  const order = ['a', 'b', 'c', 'd', 'e']
  const map: MmMap = { b: { p: 'a' }, c: { p: 'a' }, d: { p: 'b' }, a: { xy: [10, 20] } }

  it('parse/serialize round-trips and rejects junk', () => {
    expect(parseMm(serializeMm(map))).toEqual(map)
    expect(parseMm('not json')).toEqual({})
    expect(parseMm('[1,2]')).toEqual({})
    expect(parseMm(undefined)).toEqual({})
    // bad field types are dropped, not trusted
    expect(parseMm(JSON.stringify({ x: { p: 5, xy: 'no' } }))).toEqual({ x: {} })
    expect(serializeMm({ z: {} })).toBe('') // empty node ⇒ nothing to store
    expect(serializeMm({ a: { xy: [10.4, 20.6] } })).toBe('{"a":{"xy":[10,21]}}') // positions rounded
  })

  it('roots = blocks with no present parent, in manifest order', () => {
    expect(rootsOf(map, order)).toEqual(['a', 'e'])
    expect(rootsOf({ b: { p: 'gone' } }, ['b'])).toEqual(['b']) // dangling parent degrades to root
  })

  it('children/subtree follow manifest order and are cycle-safe', () => {
    expect(childrenOf(map, 'a', order)).toEqual(['b', 'c'])
    expect(subtree(map, 'a', order)).toEqual(['a', 'b', 'd', 'c'])
    expect(descendantsOf(map, 'a', order)).toEqual(['b', 'd', 'c'])
    // a cycle b→c→b must not hang
    expect(subtree({ b: { p: 'c' }, c: { p: 'b' } }, 'b', ['b', 'c'])).toEqual(['b', 'c'])
  })

  it('canParent forbids cycles; setParent refuses them', () => {
    expect(canParent(map, 'a', 'd', order)).toBe(false) // d is a's descendant
    expect(canParent(map, 'a', null, order)).toBe(true)
    expect(canParent(map, 'd', 'e', order)).toBe(true)
    expect(setParent(map, 'a', 'd', order)).toBe(map) // refused ⇒ same reference
  })

  it('setParent/setPos are immutable and prune empties', () => {
    const m2 = setParent(map, 'e', 'a', order)
    expect(m2.e).toEqual({ p: 'a' })
    expect(map.e).toBeUndefined() // original untouched
    expect(setParent(m2, 'e', null, order).e).toBeUndefined() // back to root, now empty ⇒ dropped
    expect(setPos(map, 'e', [1, 2]).e).toEqual({ xy: [1, 2] })
    expect(setParent(map, 'a', null, order).a).toEqual({ xy: [10, 20] }) // detach keeps position
  })

  it('collapse hides a whole subtree (view state only) and survives round-trip', () => {
    const m = setCollapsed(map, 'a', true)
    expect(m.a).toEqual({ xy: [10, 20], c: 1 })
    expect(parseMm(serializeMm(m))).toEqual(m) // 折叠状态跟着关系图一起落盘
    expect(visibleChildrenOf(m, 'a', order)).toEqual([]) // 折叠 ⇒ 不再布局子级
    expect(childrenOf(m, 'a', order)).toEqual(['b', 'c']) // 但块还在,关系没动
    // 整棵后代都算隐藏 —— 画布的「没被布局到就当散根补一张」安全网必须跳过它们
    expect([...hiddenIds(m, order)].sort()).toEqual(['b', 'c', 'd'])
    expect(hiddenIds(setCollapsed(map, 'b', true), order)).toEqual(new Set(['d']))
    expect(hiddenIds(map, order).size).toBe(0)
    // ⚠️ 折叠只从根往下传播:两个互为父子且都折叠的坏节点若各藏对方,双方一起消失、没有把手可展开。
    // 环里第一个(manifest 序)按根处理 → 它自己一定可见。
    const cyc: MmMap = { x: { p: 'y', c: 1 }, y: { p: 'x', c: 1 } }
    const h = hiddenIds(cyc, ['x', 'y'])
    expect(h.has('x')).toBe(false)
    expect(['x', 'y'].filter((i) => !h.has(i)).length).toBeGreaterThan(0)
    expect(setCollapsed(m, 'a', false).a).toEqual({ xy: [10, 20] }) // 展开:只摘掉 c
    expect(setCollapsed({}, 'z', false).z).toBeUndefined() // 空节点不留残渣
  })

  it('兄弟顺序:显式 o 在前,没 o 的按 manifest 缀后', () => {
    const m: MmMap = { b: { p: 'a' }, c: { p: 'a', o: 0 }, d: { p: 'a' } }
    expect(childrenOf(m, 'a', ['a', 'b', 'c', 'd'])).toEqual(['c', 'b', 'd'])
    expect(siblingsOf(m, null, ['a', 'e'])).toEqual(['a', 'e']) // parent=null ⇒ 根们
  })

  it('reorderSibling 给整组兄弟重写 o,并可跨父级插入', () => {
    const ord = ['a', 'b', 'c', 'd']
    const m: MmMap = { b: { p: 'a' }, c: { p: 'a' }, d: { p: 'a' } }
    const m2 = reorderSibling(m, 'd', 'b', 'before', ord)
    expect(childrenOf(m2, 'a', ord)).toEqual(['d', 'b', 'c'])
    expect([m2.d?.o, m2.b?.o, m2.c?.o]).toEqual([0, 1, 2]) // 整组重写,不留混合态
    expect(childrenOf(reorderSibling(m, 'b', 'c', 'after', ord), 'a', ord)).toEqual(['c', 'b', 'd'])
    // 拖到自己的后代之前 = 成环,原样返回
    const cyc: MmMap = { b: { p: 'a' }, c: { p: 'b' } }
    expect(reorderSibling(cyc, 'b', 'c', 'before', ord)).toBe(cyc)
    expect(reorderSibling(m, 'b', 'b', 'after', ord)).toBe(m)
  })

  it('换父级清掉旧的兄弟序(否则会拿别组的名次排队)', () => {
    const ord = ['a', 'b', 'c', 'e']
    const m: MmMap = { b: { p: 'a', o: 3 } }
    expect(setParent(m, 'b', 'e', ord).b).toEqual({ p: 'e' })
  })

  it('概要节点不进常规子级带;边界/概要开关可往返', () => {
    const ord = ['a', 'b', 's']
    const m = setFlag({ b: { p: 'a' }, s: { p: 'a' } }, 's', 'sm', true)
    expect(visibleChildrenOf(m, 'a', ord)).toEqual(['b', 's'])
    expect(bandChildrenOf(m, 'a', ord)).toEqual(['b'])
    expect(summaryChildrenOf(m, 'a', ord)).toEqual(['s'])
    expect(parseMm(serializeMm(m))).toEqual(m)
    expect(setFlag(m, 's', 'sm', false).s).toEqual({ p: 'a' })
    expect(setFlag({}, 'x', 'bd', false).x).toBeUndefined() // 关掉不留空条目
  })

  it('关系线:坏数据降级,端点消失即剪掉', () => {
    expect(parseRels(serializeRels([{ f: 'a', t: 'b', l: '因为' }]))).toEqual([{ f: 'a', t: 'b', l: '因为' }])
    expect(parseRels('{"f":"a"}')).toEqual([]) // 不是数组
    expect(parseRels(JSON.stringify([{ f: 'a' }, { f: 'a', t: 'a' }, 3]))).toEqual([]) // 缺端点/自环/非对象
    expect(serializeRels([])).toBe('')
    expect(pruneRels([{ f: 'a', t: 'b' }, { f: 'a', t: 'gone' }], new Set(['a', 'b']))).toEqual([{ f: 'a', t: 'b' }])
  })

  it('标志位只认真正的 1(垃圾值不当开关)', () => {
    // `c: "false"` / `sm: {}` / `bd: []` 都是 truthy —— 松着收就等于一个假字段能藏掉整棵子树(Codex)
    expect(parseMm(JSON.stringify({ x: { c: 'false', sm: {}, bd: [], o: 'no' } }))).toEqual({ x: {} })
    expect(parseMm(JSON.stringify({ x: { c: 1, bd: 1, o: 2 } }))).toEqual({ x: { c: 1, bd: 1, o: 2 } })
  })

  it('topSelected 只留没有被选中祖先覆盖的顶层(隔代也算),环安全', () => {
    const m: MmMap = { b: { p: 'a' }, c: { p: 'b' }, d: {} }
    expect(topSelected(m, ['a', 'c', 'd'])).toEqual(['a', 'd']) // c 的祖先 a 被选中(隔了一个 b)
    expect(topSelected(m, ['b', 'c'])).toEqual(['b'])
    const cyc: MmMap = { x: { p: 'y' }, y: { p: 'x' } }
    expect(topSelected(cyc, ['x'])).toEqual(['x']) // 环里只选了一个:它没有**被选中的**祖先
    expect(topSelected(cyc, ['x', 'y'])).toEqual(['x', 'y']) // 全选中 → 互为祖先,原样返回(否则删不掉)
  })

  it('removeNodes drops ids and clears dangling parents', () => {
    const m = removeNodes(map, ['b', 'd']) // delete b's subtree
    expect(m.b).toBeUndefined()
    expect(m.d).toBeUndefined()
    expect(m.c).toEqual({ p: 'a' }) // sibling untouched
    // parent removed but child kept (defensive): child with only a parent link is dropped...
    expect(removeNodes({ b: { p: 'a' }, a: { xy: [1, 2] } }, ['a']).b).toBeUndefined()
    // ...but a positioned orphan keeps its spot as a root
    expect(removeNodes({ b: { p: 'a', xy: [3, 4] }, a: {} }, ['a']).b).toEqual({ xy: [3, 4] })
    // 孤儿保留全部仍有意义的视图状态(位置/折叠/边界),只丢掉父级与「只在父级下才有意义」的 o/sm
    expect(removeNodes({ b: { p: 'a', xy: [3, 4], c: 1, bd: 1, o: 2, sm: 1 }, a: {} }, ['a']).b).toEqual({
      xy: [3, 4],
      c: 1,
      bd: 1,
    })
  })
})
