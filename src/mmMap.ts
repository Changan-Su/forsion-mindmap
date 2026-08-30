// The mindmap relationship layer over a page's real Amadeus blocks.
//
// A `.mindmap.md` file IS a normal Amadeus page (real blocks, compiler format) — so block
// content, editing, the slash menu and `![[embeds]]` all come from the ordinary block stack
// for free. A mindmap adds exactly two things on top of blocks: which block is a node's PARENT,
// and where free ("center") nodes sit on the canvas. Both live in ONE foreign frontmatter key
// (`mindmap`, a JSON string) so they round-trip through the compiler with ZERO core changes —
// the compiler preserves foreign frontmatter verbatim (see db/pageFrontmatter.ts). Storing them
// inside the `amadeus_layout` BlockRef instead would need edits to the zod-validated "sacred core".
//
// This module is pure (JSON + arrays only — no store, React, or YAML) so it unit-tests cleanly;
// the frontmatter read/write glue lives in the view, where pageStore + pageFrontmatter are in scope.

export type Pos = [number, number]

export interface MmNode {
  /** Parent block id. Absent ⇒ this block is a root ("center"). */
  p?: string
  /** Free canvas position — for roots, and any node the user has dragged off auto-layout. */
  xy?: Pos
  /** Collapsed: its subtree is hidden (the blocks still exist — this is view state, not a delete). */
  c?: 1
  /** Sibling order. Absent ⇒ sorts after ordered siblings, by manifest order (i.e. "appended").
   *  Written for a whole sibling group at once when the user drags a node between siblings —
   *  deliberately NOT the manifest block order: reordering a subtree there means moving every one
   *  of its blocks, and document reading order is meaningless on a canvas anyway. */
  o?: number
  /** Boundary: draw a frame around this node's subtree (XMind 的边界). */
  bd?: 1
  /** Summary: this child summarizes its parent's OTHER children — it is laid out to the right of the
   *  whole sibling band with a bracket instead of a normal branch line (XMind 的概要). */
  sm?: 1
}

/** blockId → relationship data. A block absent from the map is a root with an auto position. */
export type MmMap = Record<string, MmNode>

/** A non-tree relationship line between any two nodes (XMind 的关系线):层级之外的「有关/依赖/跳转」。
 *  Kept OUT of MmMap because it is not a per-node property and must not affect layout at all. */
export interface MmRel {
  f: string
  t: string
  /** Optional label rendered at the line's midpoint. */
  l?: string
}

/** Frontmatter keys the map/relations persist under. Deliberately NOT `amadeus_*`: that range is
 *  reserved and would be skipped by the surgical frontmatter writer (pageFrontmatter.isReserved). */
export const MM_FM_KEY = 'mindmap'
export const MM_REL_FM_KEY = 'mindmap_rel'

function isPos(v: unknown): v is Pos {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])
}

/** Parse the `mindmap` frontmatter value (a JSON string) into a map. Anything malformed ⇒ {} — a
 *  mindmap must never fail to open because its relationship blob got corrupted; worst case every
 *  block just falls back to being a root. Junk fields on a node are dropped, not trusted. */
export function parseMm(json: string | null | undefined): MmMap {
  if (!json || typeof json !== 'string') return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: MmMap = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const node: MmNode = {}
    const p = (v as MmNode).p
    if (typeof p === 'string' && p) node.p = p
    const xy = (v as MmNode).xy
    if (isPos(xy)) node.xy = [xy[0], xy[1]]
    // 标志位只认真正的 1。手改出来的 `c: "false"` / `sm: {}` / `bd: []` 全是 truthy,松着收就等于
    // 「垃圾字段被当成开关」——一个假的 c 能把整棵子树藏起来,与「坏数据一律降级」的契约相反(Codex)。
    if ((v as MmNode).c === 1) node.c = 1
    if ((v as MmNode).bd === 1) node.bd = 1
    if ((v as MmNode).sm === 1) node.sm = 1
    const o = (v as MmNode).o
    if (typeof o === 'number' && Number.isFinite(o)) node.o = o
    out[id] = node
  }
  return out
}

/** Serialize a map to the compact JSON string stored in frontmatter. Empty nodes are dropped and
 *  positions rounded to keep the blob small; an all-empty map serializes to '' (⇒ the key is removed). */
export function serializeMm(map: MmMap): string {
  const out: MmMap = {}
  for (const [id, n] of Object.entries(map)) {
    const node: MmNode = {}
    if (n.p) node.p = n.p
    if (n.xy) node.xy = [Math.round(n.xy[0]), Math.round(n.xy[1])]
    if (n.c) node.c = 1
    if (n.bd) node.bd = 1
    if (n.sm) node.sm = 1
    if (typeof n.o === 'number') node.o = n.o
    if (!isEmptyNode(node)) out[id] = node
  }
  return Object.keys(out).length ? JSON.stringify(out) : ''
}

/** 关系线数组的解析/序列化(独立 frontmatter 键)。同 parseMm:坏数据一律降级为空,绝不让图打不开。 */
export function parseRels(json: string | null | undefined): MmRel[] {
  if (!json || typeof json !== 'string') return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: MmRel[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const { f, t, l } = v as MmRel
    if (typeof f !== 'string' || typeof t !== 'string' || !f || !t || f === t) continue
    const rel: MmRel = { f, t }
    if (typeof l === 'string' && l) rel.l = l
    out.push(rel)
  }
  return out
}
export function serializeRels(rels: MmRel[]): string {
  return rels.length ? JSON.stringify(rels) : ''
}
/** 丢掉端点已不存在的关系线(引用完整性:删节点必须同步修关系,原型文档 §4.6)。 */
export function pruneRels(rels: MmRel[], present: Set<string>): MmRel[] {
  return rels.filter((r) => present.has(r.f) && present.has(r.t))
}

/** A block is a root when it has no parent, or its parent id is not itself a present block — a
 *  dangling pointer must never hide a block, so a stale parent degrades it to a root. */
function hasPresentParent(map: MmMap, id: string, present: Set<string>): boolean {
  const p = map[id]?.p
  return !!p && present.has(p)
}

/** 兄弟排序:显式 `o` 在前(小→大),没有 `o` 的按 manifest 顺序缀在后面(= 新建即追加)。 */
function sortSiblings(map: MmMap, ids: string[], order: string[]): string[] {
  const idx = (id: string): number => order.indexOf(id)
  return ids.slice().sort((a, b) => {
    const oa = map[a]?.o
    const ob = map[b]?.o
    if (oa != null && ob != null) return oa - ob || idx(a) - idx(b)
    if (oa != null) return -1
    if (ob != null) return 1
    return idx(a) - idx(b)
  })
}

/** Roots ("centers"), in sibling order. */
export function rootsOf(map: MmMap, order: string[]): string[] {
  const present = new Set(order)
  return sortSiblings(map, order.filter((id) => !hasPresentParent(map, id, present)), order)
}

/** Direct children of `parent`, in sibling order. */
export function childrenOf(map: MmMap, parent: string, order: string[]): string[] {
  return sortSiblings(map, order.filter((id) => map[id]?.p === parent), order)
}

/** 一组选中 id 里的「顶层」:祖先(任意深度)也被选中的一律剔掉。批量操作(复制/拖拽/删除)必须只
 *  作用在顶层 —— 子级本来就跟着父级整棵走,父子都各搬各的会把子级从父级下面拽平(Codex)。环安全。 */
export function topSelected(map: MmMap, ids: string[]): string[] {
  const sel = new Set(ids)
  const tops = ids.filter((id) => {
    let p = map[id]?.p
    const seen = new Set([id])
    while (p && !seen.has(p)) {
      if (sel.has(p)) return false
      seen.add(p)
      p = map[p]?.p
    }
    return true
  })
  // 关系图成环且环里的节点全被选中时,每个都是别人的「祖先」→ 一个顶层都剩不下,删除/复制会变成
  // 什么都不做(用户按多少次都没反应)。环里本来就没有层级可言,此时原样返回。
  return tops.length ? tops : ids
}

/** 同一层的兄弟(parent=null ⇒ 根们)。 */
export function siblingsOf(map: MmMap, parent: string | null, order: string[]): string[] {
  return parent ? childrenOf(map, parent, order) : rootsOf(map, order)
}

/** `id`'s subtree in DFS order, INCLUDING `id`. Visits each block once, so a cycle in the stored
 *  map can't hang the layout. */
export function subtree(map: MmMap, id: string, order: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    out.push(n)
    for (const c of childrenOf(map, n, order)) walk(c)
  }
  walk(id)
  return out
}

/** `id`'s descendants (its subtree minus `id`). */
export function descendantsOf(map: MmMap, id: string, order: string[]): string[] {
  return subtree(map, id, order).slice(1)
}

/** Whether `parent` may become `id`'s parent without creating a cycle: it can't be `id` itself nor
 *  anything in `id`'s subtree. A null parent (→ root) is always allowed. */
export function canParent(map: MmMap, id: string, parent: string | null, order: string[]): boolean {
  if (parent == null) return true
  if (parent === id) return false
  return !subtree(map, id, order).includes(parent)
}

/** 一个节点条目是不是「什么都没说」——是就该从图里删掉,别留残渣。 */
function isEmptyNode(n: MmNode): boolean {
  return !n.p && !n.xy && !n.c && !n.bd && !n.sm && n.o == null
}
/** 就地改一个节点条目(不可变;空条目自动剪掉)。所有 setXxx 都走它,免得漏掉新字段。 */
function patchNode(map: MmMap, id: string, patch: (n: MmNode) => void): MmMap {
  const node: MmNode = { ...map[id] }
  patch(node)
  const next = { ...map }
  if (isEmptyNode(node)) delete next[id]
  else next[id] = node
  return next
}

/** Reparent `id` (null = detach to root). Immutable; refuses cycles (returns the map unchanged so
 *  the caller can no-op safely). 换父 = 换了一组兄弟,原来的 `o` 不再有意义 → 一并清掉(落到末尾)。 */
export function setParent(map: MmMap, id: string, parent: string | null, order: string[]): MmMap {
  if (!canParent(map, id, parent, order)) return map
  return patchNode(map, id, (n) => {
    if (parent) n.p = parent
    else delete n.p
    delete n.o
  })
}

/** Set (or clear, with null) a node's free canvas position. Immutable; prunes if it empties. */
export function setPos(map: MmMap, id: string, xy: Pos | null): MmMap {
  return patchNode(map, id, (n) => {
    if (xy) n.xy = xy
    else delete n.xy
  })
}

/** Collapse / expand `id`. Pure view state — the descendant BLOCKS stay in the page; they just stop
 *  being laid out (XMind/MindNode 式折叠)。Immutable; prunes if it empties. */
export function setCollapsed(map: MmMap, id: string, on: boolean): MmMap {
  return patchNode(map, id, (n) => {
    if (on) n.c = 1
    else delete n.c
  })
}

/** 边界(bd)/ 概要(sm)开关。 */
export function setFlag(map: MmMap, id: string, flag: 'bd' | 'sm', on: boolean): MmMap {
  return patchNode(map, id, (n) => {
    if (on) n[flag] = 1
    else delete n[flag]
  })
}

/** 把 `id` 排到 `targetId` 之前/之后(同时把它挂到 target 的父级下)——拖拽调整兄弟顺序。
 *  提交方式是给**整组兄弟**重新写 `o`(0..n-1):只写被拖的那个会与「没有 o 的按 manifest 排」混着算,
 *  顺序不稳定。拒绝成环(target 在自己子树里)时原样返回。 */
export function reorderSibling(
  map: MmMap,
  id: string,
  targetId: string,
  place: 'before' | 'after',
  order: string[],
): MmMap {
  if (id === targetId) return map
  const parent = map[targetId]?.p ?? null
  if (!canParent(map, id, parent, order)) return map
  let next = setParent(map, id, parent, order)
  const sibs = siblingsOf(next, parent, order).filter((s) => s !== id)
  const at = sibs.indexOf(targetId)
  if (at < 0) return map
  sibs.splice(place === 'before' ? at : at + 1, 0, id)
  sibs.forEach((s, i) => {
    next = patchNode(next, s, (n) => {
      n.o = i
    })
  })
  return next
}

/** Children that actually get laid out — none when `parent` is collapsed. */
export function visibleChildrenOf(map: MmMap, parent: string, order: string[]): string[] {
  return map[parent]?.c ? [] : childrenOf(map, parent, order)
}

/** 进入常规「子级带」堆叠的子节点(概要节点除外 —— 它们挂在整条带的右侧,不占带内位置)。 */
export function bandChildrenOf(map: MmMap, parent: string, order: string[]): string[] {
  return visibleChildrenOf(map, parent, order).filter((id) => !map[id]?.sm)
}
/** 概要子节点(XMind 的概要:汇总同一父级下的其它子级)。 */
export function summaryChildrenOf(map: MmMap, parent: string, order: string[]): string[] {
  return visibleChildrenOf(map, parent, order).filter((id) => !!map[id]?.sm)
}

/** Every block hidden under a collapsed ancestor. Callers must skip these everywhere — including
 *  the canvas's "block with no position" safety net, which would otherwise resurrect a collapsed
 *  subtree as a pile of stray roots. */
export function hiddenIds(map: MmMap, order: string[]): Set<string> {
  const hidden = new Set<string>()
  const seen = new Set<string>()
  const walk = (id: string, underCollapsed: boolean): void => {
    if (seen.has(id)) return
    seen.add(id)
    if (underCollapsed) hidden.add(id)
    const deeper = underCollapsed || map[id]?.c === 1
    for (const c of childrenOf(map, id, order)) walk(c, deeper)
  }
  // 只从**根**往下传播折叠。按「谁被折叠就藏它的后代」逐个算的话,两个互为父子且都折叠的坏节点会
  // 把对方藏起来 —— 双方都消失,连个能展开的把手都没有(Codex)。
  for (const r of rootsOf(map, order)) walk(r, false)
  // 环里的节点从根走不到:按散根处理(画布的安全网也是这么补渲染的,两边必须一致)。
  for (const id of order) if (!seen.has(id)) walk(id, false)
  return hidden
}

/** Drop entries for the given block ids (used when their blocks are deleted). Also clears any
 *  surviving node whose parent was among the removed ids, so nothing is left pointing at a ghost
 *  (defensive — subtree deletes usually pass the whole subtree, leaving no such node). */
export function removeNodes(map: MmMap, ids: string[]): MmMap {
  const gone = new Set(ids)
  const next: MmMap = {}
  for (const [id, n] of Object.entries(map)) {
    if (gone.has(id)) continue
    if (n.p && gone.has(n.p)) {
      // orphaned → becomes a root:除了 p 与只在父级下才有意义的两个字段(兄弟序 o、概要 sm),
      // 其余视图状态(位置、折叠、边界)全部留着 —— 少抄一个字段就是无声丢用户设置(Codex)。
      const kept: MmNode = { ...n }
      delete kept.p
      delete kept.o
      delete kept.sm
      if (!isEmptyNode(kept)) next[id] = kept
      continue
    }
    next[id] = n
  }
  return next
}
