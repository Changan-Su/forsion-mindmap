// Left-to-right tidy-tree layout for variable-size nodes (mindmap cards).
//
// Pure geometry — given a tree's child lookup and each node's measured size, it writes a top-left
// position for every node. Children grow to the right; siblings stack downward; a parent is
// centered against its children's vertical band. markmap's own layout can't do variable node
// sizes (it treats every node as one line), which is exactly what a card canvas needs, so we do
// the (small, classic) layout ourselves instead of pulling in d3-flextree.
//
// Cycle-safe: a corrupted stored map (canParent prevents creating cycles, but bytes on disk can be
// anything) must never hang the layout — a hang bricks the view. Both passes guard against revisits.

export interface Size {
  w: number
  h: number
}
export interface Pt {
  x: number
  y: number
}
export interface Gaps {
  /** Horizontal gap between a node and its children (depth spacing). */
  h: number
  /** Vertical gap between siblings. */
  v: number
}

/** Bottom-up subtree height: max(own height, children's stacked height). Memoized; a cycle back to
 *  an in-progress node counts as a leaf so recursion terminates. */
function measure(
  id: string,
  childrenOf: (id: string) => string[],
  sizeOf: (id: string) => Size,
  gaps: Gaps,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(id)
  if (cached != null) return cached
  if (visiting.has(id)) return sizeOf(id).h // cycle — treat as leaf
  visiting.add(id)
  const own = sizeOf(id).h
  const kids = childrenOf(id)
  let h = own
  if (kids.length) {
    let sum = 0
    for (const k of kids) sum += measure(k, childrenOf, sizeOf, gaps, memo, visiting)
    sum += gaps.v * (kids.length - 1)
    h = Math.max(own, sum)
  }
  visiting.delete(id)
  memo.set(id, h)
  return h
}

/** Lay out `rootId`'s subtree with its band's top-left anchored at `origin`. Writes each node's
 *  top-left into `out`. Returns the subtree's bounding size (from `origin`). */
export function layoutTree(
  rootId: string,
  childrenOf: (id: string) => string[],
  sizeOf: (id: string) => Size,
  origin: Pt,
  gaps: Gaps,
  out: Map<string, Pt>,
): Size {
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const placed = new Set<string>()
  let maxRight = origin.x
  let maxBottom = origin.y
  const place = (id: string, x: number, bandTop: number): void => {
    if (placed.has(id)) return // cycle guard
    placed.add(id)
    const s = sizeOf(id)
    const total = measure(id, childrenOf, sizeOf, gaps, memo, visiting)
    const y = bandTop + (total - s.h) / 2
    out.set(id, { x, y })
    maxRight = Math.max(maxRight, x + s.w)
    maxBottom = Math.max(maxBottom, y + s.h, bandTop + total)
    const kids = childrenOf(id)
    if (!kids.length) return
    const childX = x + s.w + gaps.h
    let childrenH = 0
    for (const k of kids) childrenH += measure(k, childrenOf, sizeOf, gaps, memo, visiting)
    childrenH += gaps.v * (kids.length - 1)
    let cy = bandTop + (total - childrenH) / 2
    for (const k of kids) {
      place(k, childX, cy)
      cy += measure(k, childrenOf, sizeOf, gaps, memo, visiting) + gaps.v
    }
  }
  place(rootId, origin.x, origin.y)
  return { w: maxRight - origin.x, h: maxBottom - origin.y }
}
