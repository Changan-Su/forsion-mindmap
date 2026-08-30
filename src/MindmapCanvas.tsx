// The mindmap spatial canvas: renders a page's REAL blocks as cards laid out by their parent/pos
// relationships (mmMap), with SVG edges. Each card hosts a real <BlockHost> — so content, editing,
// the slash menu and `![[embeds]]` are the ordinary block stack, and stay consistent with the rest
// of Amadeus for free (a plugin/slash addition shows up here with no code here).
//
// Interaction model is the mind-mapping one (XMind / MindNode / 原型分析文档 §3.3 的状态机),
// NOT the note one: a click SELECTS a node, 双击/空格/F2 才进编辑,Esc 退回选中态。选中态下
// Tab=子节点、Shift+Tab=升级、Enter=同级(根上=主分支)、方向键按**视觉方向**导航、Delete=删子树、
// Alt+Delete=删本节点但提升子级、Cmd+C/X/V=子树复制粘贴(与外部缩进大纲互通)、Cmd+Z=撤销
// (结构改动写进 manifest.fmExtra,天然进 pageStore 的文档级撤销栈)。
//
// 非树语义(原型文档 §6.3)也在这里:关系线(任意两节点)、边界(给子树画框)、概要(汇总同层子级)。
// 三者都不改父子层级,只改渲染 —— 关系线存独立 frontmatter 键,边界/概要是节点上的标志位。
//
// 节点里的卡片正文是**宿主渲染的真块**:插件把一个 div 交给 ctx.app.mountBlocks,宿主在里面挂
// <BlockHost>。两棵 React 树的边界就在那个 div 上 —— 块的内容、编辑、slash、`![[嵌入]]` 全归宿主,
// 画布(布局、拖拽、框选、平移缩放)归插件。dnd-kit 的 <DndContext>/<SortableContext> 也由宿主在
// mountBlocks 内部包好(空 sensors:dnd-kit 不启动拖拽,不抢我们的指针逻辑)。
// 非编辑态的卡片正文 pointer-events:none —— 指针事件全落卡片本身(选中优先)。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
  type PointerEvent as RPointerEvent,
  type WheelEvent as RWheelEvent,
} from 'react'
import { parseFmObject, patchFmExtraText } from './fm'
import {
  useHostStore,
  BlockHost,
  BlockSurfaceContext,
  useClampedMenu,
  marqueeHits,
  stripPageBasename,
  type BlockSurface,
} from './host'
import {
  MM_FM_KEY,
  MM_REL_FM_KEY,
  parseMm,
  serializeMm,
  parseRels,
  serializeRels,
  pruneRels,
  rootsOf,
  childrenOf,
  siblingsOf,
  topSelected,
  bandChildrenOf,
  summaryChildrenOf,
  hiddenIds,
  subtree,
  descendantsOf,
  canParent,
  setParent,
  setPos,
  setCollapsed,
  setFlag,
  reorderSibling,
  removeNodes,
  type MmMap,
  type MmRel,
} from './mmMap'
import { nodeLabel, toOutline, toOpml, parseOutline, type OutlineNode } from './mmOutline'
import { MindmapOutline, type OutlineRow } from './MindmapOutline'
import { layoutTree, type Pt, type Size } from './layout'

const CARD_W = 280
const DEFAULT_H = 56 // 首帧未量到真实高度前的占位;量到后重排一次
const GAPS = { h: 56, v: 18 }
const ROOT_GAP = 48
const PAD = 40
const PASTE_MAX = 300 // 从外部文本粘贴时最多造多少个节点(每个都是一次建块 + 一次提交)
const SUM_GAP = 40 // 概要节点离子级带右缘的距离(中间放括号)
const BD_PAD = 14 // 边界框比子树包围盒外扩多少

/** YAML 里手写的对象可以是**自引用**的(`mindmap: &a {x: *a}` 是合法 YAML),JSON.stringify 遇到
 *  循环结构会抛 —— 在 useMemo 里抛就是整页白屏。坏数据一律降级,绝不让图打不开。 */
function jsonOrNull(v: unknown): string | null {
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

/** 读 fmExtra 里的关系图。YAML 可能把值解析成字符串(常态,含 `{` 会被引号包住)或对象(手写),两种都收。 */
function readMmMap(fmExtra: string): MmMap {
  const raw = parseFmObject(fmExtra)[MM_FM_KEY]
  if (typeof raw === 'string') return parseMm(raw)
  if (raw != null && typeof raw === 'object') return parseMm(jsonOrNull(raw))
  return {}
}
/** 同上,读关系线数组。 */
function readRels(fmExtra: string): MmRel[] {
  const raw = parseFmObject(fmExtra)[MM_REL_FM_KEY]
  if (typeof raw === 'string') return parseRels(raw)
  if (Array.isArray(raw)) return parseRels(jsonOrNull(raw))
  return []
}

/** manifest 顺序里 id 子树中最靠后的块 —— 新子/同级节点插在它后面,才落在既有兄弟之后。 */
function lastOfSubtree(map: MmMap, id: string, order: string[]): string {
  const sub = subtree(map, id, order)
  let best = id
  let bestIdx = order.indexOf(id)
  for (const s of sub) {
    const i = order.indexOf(s)
    if (i > bestIdx) {
      bestIdx = i
      best = s
    }
  }
  return best
}

/** 环安全的树遍历(存盘数据可能被手改成环,任何递归都必须自带保险)。 */
function walkTree<T>(id: string, map: MmMap, ord: string[], make: (id: string, kids: T[]) => T, seen = new Set<string>()): T {
  if (seen.has(id)) return make(id, [])
  seen.add(id)
  return make(id, childrenOf(map, id, ord).map((c) => walkTree(c, map, ord, make, seen)))
}

/** 内部剪贴板:保留每个块的**完整正文**(不只是大纲标题行),粘贴才不会把富文本/嵌入降级成一行字。 */
interface ClipNode {
  content: string
  children: ClipNode[]
}

type DropMode = 'child' | 'before' | 'after'
interface DropInfo {
  id: string
  mode: DropMode
}

function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

interface LayoutOut {
  pos: Map<string, Pt>
  /** 概要括号:罩住 [y0,y1] 的兄弟带,再引一条线到概要节点 (toX,toY)。 */
  brackets: Array<{ x: number; y0: number; y1: number; toX: number; toY: number }>
  /** 边界框(节点 id + 画布坐标矩形)。 */
  bounds: Array<{ id: string; x: number; y: number; w: number; h: number }>
}

/** 全图布局:每个根(无父块)独立成树 → 概要节点挂到兄弟带右侧 → 边界框套住子树。
 *  纯函数(只读 map/order/sizes),放模块级是为了让调用方能整体 try/catch —— 递归布局遇到病态数据
 *  (手改出的几千层父子链)会爆栈,视图必须能降级而不是白屏。 */
function computeLayout(mmMap: MmMap, order: string[], visible: string[], sizes: Record<string, Size>): LayoutOut {
  const pos = new Map<string, Pt>()
  const kidsOf = (id: string): string[] => bandChildrenOf(mmMap, id, order)
  const size = (id: string): Size => sizes[id] ?? { w: CARD_W, h: DEFAULT_H }
  let autoY = 0
  for (const root of rootsOf(mmMap, order)) {
    const xy = mmMap[root]?.xy
    const origin = xy ? { x: xy[0], y: xy[1] } : { x: 0, y: autoY }
    const bb = layoutTree(root, kidsOf, size, origin, GAPS, pos)
    if (!xy) autoY += bb.h + ROOT_GAP
  }
  /** 已放置节点集合的包围盒(用于概要括号 / 边界框)。 */
  const boxOf = (ids: string[]): { x0: number; y0: number; x1: number; y1: number } | null => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const id of ids) {
      const p = pos.get(id)
      if (!p) continue
      const s = size(id)
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x + s.w)
      y1 = Math.max(y1, p.y + s.h)
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 }
  }
  // 概要:不占兄弟带的位置,摆在整条带右侧,并画一道括号罩住被汇总的兄弟(XMind 语义)。
  // 多轮:概要节点自己也可能有概要子级。轮数封顶,防手改数据造出的病态嵌套把渲染拖死。
  const brackets: LayoutOut['brackets'] = []
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const pid of visible) {
      if (!pos.has(pid)) continue
      const sums = summaryChildrenOf(mmMap, pid, order)
      if (!sums.length || pos.has(sums[0])) continue
      const band = bandChildrenOf(mmMap, pid, order).flatMap((c) => subtree(mmMap, c, order))
      const box = boxOf(band.length ? band : [pid])
      if (!box) continue
      const x = box.x1 + SUM_GAP
      let y = (box.y0 + box.y1) / 2 - size(sums[0]).h / 2
      for (const s of sums) {
        const bb = layoutTree(s, kidsOf, size, { x, y }, GAPS, pos)
        brackets.push({ x: box.x1 + 10, y0: box.y0, y1: box.y1, toX: x, toY: y + size(s).h / 2 })
        y += bb.h + GAPS.v
      }
      changed = true
    }
    if (!changed) break
  }
  // 安全网:关系图若含环,环内每个块都有「存在的父」→ rootsOf 一个都不返回 → 整片消失(Codex)。
  // 把任何没被布局到的**可见**块(环孤儿)当独立根补布局一次,保证它绝不隐身;折叠隐藏的块不在此列
  // (否则一折叠就把整棵子树变成一堆散根摊在画布上)。
  for (const id of visible) {
    if (pos.has(id)) continue
    const bb = layoutTree(id, kidsOf, size, { x: 0, y: autoY }, GAPS, pos)
    autoY += bb.h + ROOT_GAP
  }
  // 边界:给标了 bd 的节点的整棵可见子树套框。
  const bounds: LayoutOut['bounds'] = []
  for (const id of visible) {
    if (!mmMap[id]?.bd) continue
    const box = boxOf(subtree(mmMap, id, order))
    if (!box) continue
    bounds.push({ id, x: box.x0 - BD_PAD, y: box.y0 - BD_PAD, w: box.x1 - box.x0 + BD_PAD * 2, h: box.y1 - box.y0 + BD_PAD * 2 })
  }
  return { pos, brackets, bounds }
}

export function MindmapCanvas() {
  const store = useHostStore()
  const manifest = store.use((s) => s.manifest)
  const blocks = store.use((s) => s.blocks)
  const status = store.use((s) => s.status)
  const activePage = store.use((s) => s.activePage)

  // 文档顺序:宿主内部要从 manifest.root 的行/列摊平,块表面 seam 直接给这一份(同一个东西)。
  const orderRo = store.use((s) => s.order)
  const order = useMemo(() => [...orderRo], [orderRo])
  const fmExtra = manifest?.fmExtra ?? ''
  const mmMap = useMemo(() => readMmMap(fmExtra), [fmExtra])
  const rels = useMemo(() => readRels(fmExtra), [fmExtra])
  const hidden = useMemo(() => hiddenIds(mmMap, order), [mmMap, order])
  const visible = useMemo(() => {
    const v = order.filter((id) => !hidden.has(id))
    // 兜底:被手改坏的关系图能让**每一个**块都藏在别人后面(如 a.p=b、b.p=a 且两个都折叠 → 互相
    // 隐藏),那样画布全空、连个能展开的把手都没有。宁可把折叠当没发生,也绝不让一整页块隐身(Codex)。
    return v.length || !order.length ? v : order
  }, [order, hidden])

  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const onMeasure = useCallback((id: string, w: number, h: number) => {
    setSizes((prev) => {
      const cur = prev[id]
      if (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1) return prev
      return { ...prev, [id]: { w, h } }
    })
  }, [])
  const sizeOf = useCallback((id: string): Size => sizes[id] ?? { w: CARD_W, h: DEFAULT_H }, [sizes])

  // ── 布局:每个根(无父块)独立成树 → 概要节点挂到兄弟带右侧 → 边界框套住子树 ──
  const layout = useMemo((): LayoutOut => {
    try {
      return computeLayout(mmMap, order, visible, sizes)
    } catch (e) {
      // 布局是递归的:手改出一条几千层深的父子链能把调用栈打爆。这里抛出去 = 整个视图白屏,
      // 用户连内容都看不到。降级成一列平铺(无连线/边界/概要),至少块还在、还能编辑和撤销。
      console.error('[mindmap] 布局失败,降级为平铺', e)
      const pos = new Map<string, Pt>()
      let y = 0
      for (const id of visible) {
        pos.set(id, { x: 0, y })
        y += (sizes[id]?.h ?? DEFAULT_H) + GAPS.v
      }
      return { pos, brackets: [], bounds: [] }
    }
  }, [mmMap, order, visible, sizes])
  const positions = layout.pos

  // ── 持久化(外科式写进外来 frontmatter,编译器往返无损;两个键各写各的) ──
  const patchFm = useCallback((patch: Record<string, string | undefined>) => {
    const cur = store.getState().manifest?.fmExtra ?? ''
    const patched = patchFmExtraText(cur, patch)
    if (patched != null) {
      store.getState().setFmExtra(patched)
      return
    }
    // patchFmExtraText 只在既有 fmExtra 非空却解析失败(被手工改坏)时返回 null → 关系没落盘(Codex)。
    // 只写 console 等于静默:用户会以为改动生效了,关掉重开才发现全没了。必须当面说。
    console.warn('[mindmap] 关系保存失败:页面 frontmatter 无法解析,本次结构改动未落盘。')
    window.dispatchEvent(new CustomEvent('amadeus:toast', {
      detail: { text: '结构改动没能保存:这张图的 frontmatter 无法解析,请检查文件头部的 YAML', error: true },
    }))
  }, [])
  const persist = useCallback(
    (next: MmMap) => {
      // 落盘前剪掉「已经没有对应块」的条目:块 id 是页内递增的,留着幽灵条目意味着**下一个**拿到同号 id
      // 的新块会凭空继承它的父级/折叠/概要 —— 新建的中心节点一出生就藏在某个折叠祖先下(Codex)。
      // order 为空 = 页面还没加载完,此时不敢剪(会把整张关系图抹掉)。
      const ord = store.getState().flatOrder()
      const clean = ord.length ? removeNodes(next, Object.keys(next).filter((id) => !ord.includes(id))) : next
      patchFm({ [MM_FM_KEY]: serializeMm(clean) || undefined })
    },
    [patchFm],
  )
  const persistRels = useCallback(
    (next: MmRel[]) => patchFm({ [MM_REL_FM_KEY]: serializeRels(next) || undefined }),
    [patchFm],
  )

  // ── 选中态 / 编辑态(导图的状态机核心:浏览 → 选中 → 编辑) ──
  const rootRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null)
  const [relFrom, setRelFrom] = useState<string | null>(null) // 关系线创建模式:等用户点第二个节点
  const [selRel, setSelRel] = useState<number | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const clip = useRef<{ text: string; nodes: ClipNode[] } | null>(null)
  const menuPos = useClampedMenu(menu?.x ?? -1, menu?.y ?? -1)
  const canvasMenuPos = useClampedMenu(canvasMenu?.x ?? -1, canvasMenu?.y ?? -1)
  const selSet = useMemo(() => new Set(sel), [sel])
  const primary = sel.length ? sel[sel.length - 1] : null

  const focusCanvas = useCallback(() => {
    // 编辑器可能还持有焦点(退出编辑时);先摘掉,键盘才回到画布。
    const ae = document.activeElement as HTMLElement | null
    if (ae && ae !== rootRef.current && rootRef.current?.contains(ae)) ae.blur?.()
    rootRef.current?.focus()
  }, [])
  const closeMenus = useCallback(() => {
    setMenu(null)
    setCanvasMenu(null)
  }, [])
  /** additive = Shift/Cmd 点击:切换该节点的选中,不清空其它(原型文档 §4.4)。 */
  const select = useCallback(
    (id: string | null, additive = false) => {
      setSelRel(null)
      closeMenus()
      setEditing(null)
      setSel((cur) => {
        if (id == null) return []
        if (!additive) return [id]
        return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      })
      focusCanvas()
    },
    [focusCanvas, closeMenus],
  )
  const beginEdit = useCallback((id: string) => {
    setSel([id])
    setEditing(id)
    setSelRel(null)
    store.getState().requestFocus(id, 'end')
  }, [])
  const exitEdit = useCallback(() => {
    setEditing(null)
    focusCanvas()
  }, [focusCanvas])

  // 编辑态的 Esc 兜底:焦点未必在卡片里。只读控件块(图片/嵌入/数据库/书签)被 requestFocus 时,
  // BlockHost 会先 blur 再进「块选中」态,焦点落到 body —— 事件不再经过 .mmv-root,React 的 onKeyDown
  // 收不到,用户就卡在编辑态出不来(Codex)。挂一个 window 级捕获,只在编辑态存在时装。
  useEffect(() => {
    if (!editing) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (rootRef.current?.contains(document.activeElement)) return // 焦点还在画布内:交给 React 那条路
      e.preventDefault()
      setEditing(null)
      rootRef.current?.focus()
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [editing])

  // 选中的块被删掉(别处删/撤销)→ 清掉,免得键盘操作打在幽灵上。
  useEffect(() => {
    setSel((cur) => (cur.every((id) => blocks[id]) ? cur : cur.filter((id) => blocks[id])))
    setEditing((cur) => (cur && !blocks[cur] ? null : cur))
  }, [blocks])
  // 折叠把选中节点藏起来了 → 选中跳到那个折叠的祖先(不然选中态看不见)。
  useEffect(() => {
    setSel((cur) => {
      if (!cur.some((id) => hidden.has(id))) return cur
      const lift = (id: string): string | null => {
        let p = mmMap[id]?.p
        const seen = new Set([id])
        while (p && hidden.has(p) && !seen.has(p)) {
          seen.add(p)
          p = mmMap[p]?.p
        }
        return p ?? null
      }
      const next = [...new Set(cur.map((id) => (hidden.has(id) ? lift(id) : id)).filter((x): x is string => !!x))]
      return next
    })
    setEditing((cur) => (cur && hidden.has(cur) ? null : cur))
  }, [hidden, mmMap])

  // ── 节点操作(建/删走块 store,关系走 mmMap) ──
  /** 新建子节点。content 非空 = 承载 slash 脚手架(数据库/代码块…),此时不进编辑态。 */
  const addChild = useCallback(
    (parentId: string, content = ''): string | null => {
      const st = store.getState()
      const ord = st.flatOrder()
      const map = readMmMap(st.manifest?.fmExtra ?? '')
      const after = lastOfSubtree(map, parentId, ord)
      const id = st.insertBlockAfter(after, undefined, content) // 建块 + 自动 requestFocus
      if (!id) return null
      // 往折叠节点里加子级 → 自动展开,否则新节点看不见(原型文档 §4.2)。
      persist(setParent(setCollapsed(map, parentId, false), id, parentId, [...ord, id]))
      setSel([id])
      setEditing(content ? null : id)
      // 带内容的脚手架(/数据库、代码块)不进编辑态 —— 但 insertBlockAfter 已经替它要了焦点,不撤掉的话
      // 卡片看着是「只选中」、光标却在里面,打字照样改内容、Esc 走错分支(Codex)。焦点还给画布。
      if (content) {
        store.getState().consumeFocus(id)
        focusCanvas()
      }
      return id
    },
    [persist, focusCanvas],
  )
  const addSibling = useCallback(
    (nodeId: string): string | null => {
      const st = store.getState()
      const ord = st.flatOrder()
      const map = readMmMap(st.manifest?.fmExtra ?? '')
      const parent = map[nodeId]?.p ?? null // 根的同级 = 新根
      const after = lastOfSubtree(map, nodeId, ord)
      const id = st.insertBlockAfter(after, undefined, '')
      if (!id) return null
      persist(reorderSibling(setParent(map, id, parent, [...ord, id]), id, nodeId, 'after', [...ord, id]))
      setSel([id])
      setEditing(id)
      return id
    },
    [persist],
  )
  const addRoot = useCallback(() => {
    const id = store.getState().insertBlockAfter(null, undefined, '') // 无父块 = 新中心
    if (id) {
      setSel([id])
      setEditing(id)
    }
  }, [])
  /** 升级(Shift+Tab):挂到父级的父级,并排在原父级之后。 */
  const outdent = useCallback(
    (nodeId: string) => {
      const st = store.getState()
      const ord = st.flatOrder()
      const map = readMmMap(st.manifest?.fmExtra ?? '')
      const parent = map[nodeId]?.p
      if (!parent) return // 已是根
      persist(reorderSibling(map, nodeId, parent, 'after', ord))
    },
    [persist],
  )
  /** 降级(Tab 在已有兄弟时的另一种用法留给右键):挂到上一个兄弟下。 */
  const indent = useCallback(
    (nodeId: string) => {
      const st = store.getState()
      const ord = st.flatOrder()
      const map = readMmMap(st.manifest?.fmExtra ?? '')
      const sibs = siblingsOf(map, map[nodeId]?.p ?? null, ord)
      const at = sibs.indexOf(nodeId)
      if (at <= 0) return // 没有上一个兄弟
      persist(setCollapsed(setParent(map, nodeId, sibs[at - 1], ord), sibs[at - 1], false))
    },
    [persist],
  )
  const removeSubtrees = useCallback(
    async (ids: string[]) => {
      const st = store.getState()
      const tok0 = st.token // ⚠️ deleteBlock 里有 await(反链查询):期间页可能被切换/外部重装,而块 id
      const ord = st.flatOrder() //    是页内递增的(b1/1/2…),两页撞号是常态 —— 守令牌不守路径:A→B→A 往返路径相同但 id 已易主(画布同款,评审回访)。
      const map = readMmMap(st.manifest?.fmExtra ?? '')
      const tops = topSelected(map, ids) // 选中集合里已被祖先覆盖的不重复删
      const all = [...new Set(tops.flatMap((id) => subtree(map, id, ord)))]
      if (!all.length) return
      // 一次性把整棵子树的确认摆在最前:取消 = 什么都不删(Codex:旧版先清关系再逐块删,取消根删除
      // 反而留下孤儿、循环里还继续删没确认的子孙)。确认后再删,删完只清「真删掉的」那些关系。
      if (all.length > tops.length && !window.confirm(`删除 ${tops.length} 个节点及其 ${all.length - tops.length} 个子节点?此操作无法撤销。`)) return
      const parent = map[tops[0]]?.p ?? null
      const spared = new Set<string>() // 用户在「别处嵌入了」确认框上取消的块 + 它整棵子树
      for (const id of all) {
        if (spared.has(id)) continue
        await st.deleteBlock(id) // 「别处嵌入了」的块 deleteBlock 仍会二次确认
        if (store.getState().token !== tok0) return // 页已切换/重装:剩下的一个都不删
        // 这一块被用户救下 → 它的子孙也不该删(否则「保住了父、子孙照删」= 意料之外的半棵子树,Codex)
        if (store.getState().blocks[id]) for (const d of subtree(map, id, ord)) spared.add(d)
      }
      const cur = store.getState()
      const gone = all.filter((id) => !cur.blocks[id])
      if (gone.length) {
        persist(removeNodes(readMmMap(cur.manifest?.fmExtra ?? ''), gone))
        // 引用完整性:端点被删的关系线必须同时消失,不能留一条连着幽灵的线(原型文档 §4.6)。
        const after = store.getState()
        const left = new Set(after.flatOrder())
        const before = readRels(after.manifest?.fmExtra ?? '')
        const keep = pruneRels(before, left)
        if (keep.length !== before.length) persistRels(keep)
      }
      select(parent && store.getState().blocks[parent] ? parent : null)
    },
    [persist, persistRels, select],
  )
  /** 只删这一个节点,子级提升到它的父级(Alt+Delete;原型文档 §4.6 的第二种删除)。 */
  const removeKeepChildren = useCallback(
    async (nodeId: string) => {
      const st0 = store.getState()
      const tok0 = st0.token
      const parent = readMmMap(st0.manifest?.fmExtra ?? '')[nodeId]?.p ?? null
      await st0.deleteBlock(nodeId)
      const st = store.getState()
      if (st.token !== tok0) return // 页已切换/重装:后面的写入会落到别的文件上(令牌比路径严)
      if (st.blocks[nodeId]) return // 用户在「别处嵌入了」确认框取消 → 结构不动
      // ⚠️ 提升子级必须用 **await 之后**重新读的关系图:拿等待前的快照写回去,会把这期间别的操作
      //(改父/折叠/调序)整个抹掉(Codex,与上一轮 deleteBlock 的陈旧 manifest 同一类)。
      const ord = st.flatOrder()
      let map = readMmMap(st.manifest?.fmExtra ?? '')
      for (const c of childrenOf(map, nodeId, ord)) map = setParent(map, c, parent, ord)
      persist(removeNodes(map, [nodeId]))
      const after = store.getState()
      persistRels(pruneRels(readRels(after.manifest?.fmExtra ?? ''), new Set(after.flatOrder())))
      select(parent && after.blocks[parent] ? parent : null)
    },
    [persist, persistRels, select],
  )
  const toggleCollapse = useCallback(
    (ids: string[]) => {
      const st = store.getState()
      let map = readMmMap(st.manifest?.fmExtra ?? '')
      const on = !ids.every((id) => map[id]?.c) // 混合状态 → 全部折叠
      for (const id of ids) map = setCollapsed(map, id, on)
      persist(map)
    },
    [persist],
  )
  const toggleFlag = useCallback(
    (ids: string[], flag: 'bd' | 'sm') => {
      const st = store.getState()
      let map = readMmMap(st.manifest?.fmExtra ?? '')
      const on = !ids.every((id) => map[id]?.[flag])
      for (const id of ids) {
        if (flag === 'sm' && !map[id]?.p) continue // 概要必须依附父级(根节点没有「同层兄弟」可汇总)
        map = setFlag(map, id, flag, on)
      }
      persist(map)
    },
    [persist],
  )
  const setAllCollapsed = useCallback(
    (on: boolean) => {
      const st = store.getState()
      const ord = st.flatOrder()
      let map = readMmMap(st.manifest?.fmExtra ?? '')
      for (const id of ord) {
        if (on && !childrenOf(map, id, ord).length) continue
        map = setCollapsed(map, id, on)
      }
      persist(map)
    },
    [persist],
  )

  // ── 复制 / 剪切 / 粘贴(子树级;与外部缩进大纲互通) ──
  const clipOf = useCallback((ids: string[]): ClipNode[] => {
    const st = store.getState()
    const ord = st.flatOrder()
    const map = readMmMap(st.manifest?.fmExtra ?? '')
    // topSelected 看**任意深度**的祖先:只比对直接父级的话,选了 A 和它的孙子 C(中间 B 没选)会把
    // C 复制两遍 —— 一遍在 A 的子树里,一遍作为顶层(Codex)。
    const tops = topSelected(map, ids)
    return tops.map((id) =>
      walkTree<ClipNode>(id, map, ord, (nid, kids) => ({ content: st.blocks[nid]?.content ?? '', children: kids })),
    )
  }, [])
  const outlineOf = (nodes: ClipNode[]): OutlineNode[] =>
    nodes.map((n) => ({ text: nodeLabel(n.content), children: outlineOf(n.children) }))
  const copy = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      const nodes = clipOf(ids)
      const text = toOutline(outlineOf(nodes))
      clip.current = { text, nodes } // 内部副本保全文;系统剪贴板给大纲文本,可粘到任何地方
      void navigator.clipboard?.writeText(text).catch(() => {})
    },
    [clipOf],
  )
  const pasteInto = useCallback(
    (parentId: string | null, nodes: ClipNode[], tok?: string) => {
      if (!nodes.length) return
      const st = store.getState()
      // 读剪贴板是异步的:期间页可能被切换/外部重装。守令牌不守路径(A→B→A 往返路径相同但 id 已易主)。
      if (tok !== undefined && tok !== st.token) return
      let ord = st.flatOrder()
      let map = readMmMap(st.manifest?.fmExtra ?? '')
      let after: string | null = parentId ? lastOfSubtree(map, parentId, ord) : ord[ord.length - 1] ?? null
      let first: string | null = null
      const walk = (n: ClipNode, parent: string | null): void => {
        const id = store.getState().insertBlockAfter(after, undefined, n.content)
        if (!id) return
        first ??= id
        after = id
        ord = [...ord, id]
        if (parent) map = setParent(map, id, parent, ord)
        for (const c of n.children) walk(c, id)
      }
      for (const n of nodes) walk(n, parentId)
      if (parentId) map = setCollapsed(map, parentId, false)
      persist(map)
      if (first) {
        setSel([first])
        setEditing(null)
      }
      focusCanvas()
    },
    [persist, focusCanvas],
  )
  /** 粘贴:系统剪贴板文本与我们上次复制的一致 → 用保全文的内部副本;否则按缩进大纲解析(外部文本导入)。 */
  const paste = useCallback(
    async (parentId: string | null) => {
      const tok0 = store.getState().token // 读剪贴板期间页可能被切换/重装,粘贴前必须核对令牌
      let text = ''
      try {
        text = await navigator.clipboard.readText()
      } catch {
        /* 无剪贴板权限:退回内部副本 */
      }
      if (clip.current && (!text || text.trim() === clip.current.text.trim())) {
        pasteInto(parentId, clip.current.nodes, tok0)
        return
      }
      const parsed = parseOutline(text)
      if (!parsed.length) return
      // 外部文本可以是一整篇几千行的文档:每个节点都是一次建块 + 一次 store 提交,不设上限会当场卡死。
      // 截断而不是拒绝(拿到前 N 条比什么都没有有用),但必须**明说**截了 —— 静默截断会被当成「粘丢了」。
      let budget = PASTE_MAX
      const toClip = (ns: OutlineNode[]): ClipNode[] => {
        const out: ClipNode[] = []
        for (const n of ns) {
          if (budget <= 0) break
          budget--
          out.push({ content: n.text, children: toClip(n.children) })
        }
        return out
      }
      const clipped = toClip(parsed)
      if (budget <= 0) {
        window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text: `粘贴内容过长,只取了前 ${PASTE_MAX} 个节点` } }))
      }
      pasteInto(parentId, clipped, tok0)
    },
    [pasteInto],
  )

  // ── 导出(原型文档 §10.5:只做图片导出的导图迁不走,树结构必须有纯文本表示) ──
  const treeOutline = useCallback((): OutlineNode[] => {
    const st = store.getState()
    const ord = st.flatOrder()
    const map = readMmMap(st.manifest?.fmExtra ?? '')
    return rootsOf(map, ord).map((id) =>
      walkTree<OutlineNode>(id, map, ord, (nid, kids) => ({ text: nodeLabel(st.blocks[nid]?.content ?? ''), children: kids })),
    )
  }, [])
  const title = activePage ? stripPageBasename(activePage).split('/').pop() ?? 'mindmap' : 'mindmap'
  const exportOutline = useCallback(() => download(`${title}.md`, toOutline(treeOutline()) + '\n', 'text/markdown'), [title, treeOutline])
  const exportOpml = useCallback(() => download(`${title}.opml`, toOpml(treeOutline(), title), 'text/xml'), [title, treeOutline])

  /** 宿主接管块的结构语义:块内无法合并的内容(/数据库 的 `![[x.db]]`、代码块、Shift+Enter)
   *  一律落成**子节点**,而不是像笔记那样在下面插一个平级块(在导图里那会变成一个游离的根)。 */
  const surface = useMemo<BlockSurface>(
    () => ({ insertAfter: (blockId, content) => void addChild(blockId, content) }),
    [addChild],
  )

  // ── 画布 pan/zoom ──
  const activeDragCleanup = useRef<(() => void) | null>(null) // 在途拖拽收尾:卸载/取消/失焦时强制摘掉 window 监听
  useEffect(() => () => activeDragCleanup.current?.(), [])
  const [pan, setPan] = useState({ x: PAD, y: PAD })
  const [zoom, setZoom] = useState(1)
  const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
  // 以 (sx,sy) 为定点缩放。两个 set 都用当前渲染的值算,**不能**把 setPan 塞进 setZoom 的 updater 里
  // ——updater 必须是纯的、可能被重放(StrictMode 就会),重放一次 pan 就多补偿一次(Codex)。
  const zoomAbout = (factor: number, sx: number, sy: number): void => {
    const nz = clamp(zoom * factor, 0.25, 2.5)
    if (nz === zoom) return
    const f = nz / zoom
    setZoom(nz)
    setPan({ x: sx - (sx - pan.x) * f, y: sy - (sy - pan.y) * f })
  }
  const onWheel = (e: RWheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 && !e.altKey) {
      // 无修饰的滚轮 = 平移(触控板双指);要缩放按住 Cmd/Ctrl 或用缩放条
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      return
    }
    e.preventDefault()
    const r = rootRef.current?.getBoundingClientRect()
    zoomAbout(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0))
  }
  /** 屏幕坐标 → 画布坐标。 */
  const toCanvas = useCallback(
    (cx: number, cy: number): Pt => {
      const r = rootRef.current?.getBoundingClientRect()
      return { x: (cx - (r?.left ?? 0) - pan.x) / zoom, y: (cy - (r?.top ?? 0) - pan.y) / zoom }
    },
    [pan, zoom],
  )
  // ── 通用指针拖拽(>4px 才算拖);window 级监听,收尾必摘。 ──
  const beginDrag = (
    e: RPointerEvent,
    onMove: (dx: number, dy: number, ev: PointerEvent) => void,
    onUp: (dx: number, dy: number, moved: boolean, e: PointerEvent | null) => void,
  ): void => {
    activeDragCleanup.current?.() // 上一次拖拽还没收尾(第二根手指/杂散指针)→ 先作废它,免得两套 window 监听并存
    const pid = e.pointerId // 只认这一个指针,别的指针的 move/up 一律无视(多点触控/杂散指针不乱入)
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    let done = false
    let ldx = 0
    let ldy = 0
    const cleanup = (): void => {
      if (done) return
      done = true
      activeDragCleanup.current = null
      window.removeEventListener('pointermove', mv, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel, true)
    }
    const mv = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return
      ldx = ev.clientX - sx
      ldy = ev.clientY - sy
      if (!moved && Math.hypot(ldx, ldy) < 4) return
      moved = true
      onMove(ldx, ldy, ev)
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      cleanup()
      onUp(dx, dy, moved, ev)
    }
    // 取消/失焦/卸载:一律作废本次拖拽(moved=false → 上层不提交,视觉复位),绝不在丢失 release 后
    // 用陈旧 delta 落一次 reparent/reposition(Codex:否则后续无关的指针释放会把节点乱扔)。
    const cancel = (): void => {
      cleanup()
      onUp(ldx, ldy, false, null)
    }
    activeDragCleanup.current = cancel
    window.addEventListener('pointermove', mv, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel, true)
  }

  // 画布空白:左键拖 = 框选(原型文档 §4.4);中键 / Alt 拖 = 平移;单击 = 取消选中。
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const onCanvasPointerDown = (e: RPointerEvent): void => {
    const t = e.target as HTMLElement
    if (t.closest('.mmv-node') || t.closest('.mmv-zoom') || t.closest('.ctx-menu') || t.closest('.mmv-outline')) return
    closeMenus()
    if (relFrom) setRelFrom(null) // 点空白 = 放弃建关系线
    const panning = e.button === 1 || e.altKey
    if (panning) {
      const p0 = pan
      beginDrag(e, (dx, dy) => setPan({ x: p0.x + dx, y: p0.y + dy }), () => {})
      return
    }
    const start = toCanvas(e.clientX, e.clientY)
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    if (!additive) select(null)
    else focusCanvas()
    beginDrag(
      e,
      (_dx, _dy, ev) => {
        const cur = toCanvas(ev.clientX, ev.clientY)
        setMarquee({ x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) })
      },
      (_dx, _dy, moved, ev) => {
        setMarquee(null)
        if (!moved || !ev) return
        const cur = toCanvas(ev.clientX, ev.clientY)
        const rect = { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) }
        const hit = visible.filter((id) => {
          const p = positions.get(id)
          if (!p) return false
          const s = sizeOf(id)
          return marqueeHits(rect, { left: p.x, top: p.y, right: p.x + s.w, bottom: p.y + s.h })
        })
        setSel((old) => (additive ? [...new Set([...old, ...hit])] : hit))
        focusCanvas()
      },
    )
  }

  // 双击空白 = 在该处新建一个自由中心节点(原型文档 §4.2 的「创建自由节点」)。
  const onCanvasDoubleClick = (e: RMouseEvent): void => {
    const t = e.target as HTMLElement
    if (t.closest('.mmv-node') || t.closest('.mmv-zoom') || t.closest('.ctx-menu') || t.closest('.mmv-outline')) return
    const at = toCanvas(e.clientX, e.clientY)
    const st = store.getState()
    const id = st.insertBlockAfter(null, undefined, '')
    if (!id) return
    persist(setPos(readMmMap(st.manifest?.fmExtra ?? ''), id, [Math.round(at.x), Math.round(at.y)]))
    setSel([id])
    setEditing(id)
  }

  // 节点拖:抓头部把整棵子树一起挪(视觉)。落点在别的节点中部=成为其子级、上/下缘=插到它前/后
  // (调整兄弟顺序),落在空白=脱离成中心停在该处。松手前必须能看出会发生哪一种(原型文档 §10.3)。
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [drop, setDrop] = useState<DropInfo | null>(null)
  const dragSubtree = useMemo(
    () => (drag ? new Set(subtree(mmMap, drag.id, order)) : null),
    [drag, mmMap, order],
  )
  /** 指针下的落点(排除自身子树;不能作父级/兄弟就返回 null)。 */
  const dropAt = (id: string, map: MmMap, ord: string[], x: number, y: number): DropInfo | null => {
    const sub = new Set(subtree(map, id, ord))
    const hit = document
      .elementsFromPoint(x, y)
      .map((el) => (el as HTMLElement).closest?.('.mmv-node') as HTMLElement | null)
      .find((el): el is HTMLElement => !!el && !!el.dataset.id && !sub.has(el.dataset.id))
    const target = hit?.dataset.id
    if (!target) return null
    const r = hit!.getBoundingClientRect()
    const f = (y - r.top) / Math.max(1, r.height)
    if (f < 0.3 || f > 0.7) {
      const place: DropMode = f < 0.3 ? 'before' : 'after'
      return canParent(map, id, map[target]?.p ?? null, ord) ? { id: target, mode: place } : null
    }
    return canParent(map, id, target, ord) ? { id: target, mode: 'child' } : null
  }
  const startNodeDrag = (e: RPointerEvent, id: string): void => {
    e.stopPropagation()
    closeMenus()
    if (!selSet.has(id)) select(id)
    else focusCanvas()
    beginDrag(
      e,
      (dx, dy, ev) => {
        setDrag({ id, dx: dx / zoom, dy: dy / zoom })
        const st = store.getState()
        setDrop(dropAt(id, readMmMap(st.manifest?.fmExtra ?? ''), st.flatOrder(), ev.clientX, ev.clientY))
      },
      (dx, dy, moved, ev) => {
        setDrag(null)
        setDrop(null)
        if (!moved || !ev) return // 取消/失焦(ev=null):只复位,不落 reparent/reposition
        const st = store.getState()
        const ord = st.flatOrder()
        let map = readMmMap(st.manifest?.fmExtra ?? '')
        const target = dropAt(id, map, ord, ev.clientX, ev.clientY)
        // 多选拖动:被抓的那个是选中集合的一员时,整批一起落(批量改父是多选最有用的场景)。
        // 只搬**选中集合里的顶层节点** —— 选了父又选了子还各搬各的,会把子级从父级下面拽平,等于
        // 悄悄改掉用户没打算动的层级(子级本来就跟着父级整棵走)。
        const batch = selSet.has(id) && sel.length > 1 ? topSelected(map, sel) : [id]
        const movers = batch.filter((s) => s === id || canParent(map, s, target?.id ?? null, ord))
        if (target?.mode === 'child') {
          // 挂到折叠节点上 → 顺手展开,否则「拖进去就不见了」。
          map = setCollapsed(map, target.id, false)
          for (const m of movers) map = setPos(setParent(map, m, target.id, ord), m, null) // 改父 → 交回自动布局
        } else if (target) {
          // 'after' 要倒着插:每个都插到 target 之后,顺序才不会被翻过来。
          const seq = target.mode === 'after' ? [...movers].reverse() : movers
          for (const m of seq) map = setPos(reorderSibling(map, m, target.id, target.mode, ord), m, null)
        } else {
          const cur = positions.get(id) ?? { x: 0, y: 0 }
          const at: [number, number] = [cur.x + dx / zoom, cur.y + dy / zoom]
          map = setPos(setParent(map, id, null, ord), id, at) // 脱离成中心,停在落点
        }
        persist(map)
      },
    )
  }

  // ── 视图变换 + 内容包围盒(给 SVG 边定尺寸;坐标含负,故 viewBox 从 minX/minY 起) ──
  const posOf = (id: string): Pt | null => {
    const p = positions.get(id)
    if (!p) return null
    if (drag && dragSubtree?.has(id)) return { x: p.x + drag.dx, y: p.y + drag.dy }
    return p
  }
  const bbox = useMemo(() => {
    let minX = 0
    let minY = 0
    let maxX = CARD_W
    let maxY = DEFAULT_H
    for (const id of visible) {
      const p = positions.get(id)
      if (!p) continue
      const s = sizeOf(id)
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + s.w)
      maxY = Math.max(maxY, p.y + s.h)
    }
    return { minX: minX - PAD, minY: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 }
  }, [positions, visible, sizeOf])

  /** 父→子的贝塞尔:从父卡右缘中点连到子卡左缘中点。 */
  const edgePath = (from: Pt, fs: Size, to: Pt, ts: Size): string => {
    const x1 = from.x + fs.w
    const y1 = from.y + fs.h / 2
    const x2 = to.x
    const y2 = to.y + ts.h / 2
    const mx = (x1 + x2) / 2
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  }
  const edges = visible
    .map((id) => {
      const p = mmMap[id]?.p
      if (!p || mmMap[id]?.sm) return null // 概要节点走括号,不画普通分支线
      const from = posOf(p)
      const to = posOf(id)
      if (!from || !to) return null
      return <path key={id} className="mmv-edge" d={edgePath(from, sizeOf(p), to, sizeOf(id))} />
    })
    .filter(Boolean)
  // 拖拽落点预览:候选父级 → 被拖节点当前位置的虚线(松手就会变成这条真连线)。
  const previewEdge = (() => {
    if (!drag || drop?.mode !== 'child') return null
    const from = posOf(drop.id)
    const to = posOf(drag.id)
    if (!from || !to) return null
    return <path className="mmv-edge mmv-edge-preview" d={edgePath(from, sizeOf(drop.id), to, sizeOf(drag.id))} />
  })()
  // 关系线:任意两节点之间的非树连线(有箭头,可选标签)。
  const relPaths = rels.map((r, i) => {
    const a = posOf(r.f)
    const b = posOf(r.t)
    if (!a || !b) return null
    const as = sizeOf(r.f)
    const bs = sizeOf(r.t)
    const ac = { x: a.x + as.w / 2, y: a.y + as.h / 2 }
    const bc = { x: b.x + bs.w / 2, y: b.y + bs.h / 2 }
    const dir = bc.x >= ac.x ? 1 : -1
    const p1 = { x: ac.x + (dir * as.w) / 2, y: ac.y }
    const p2 = { x: bc.x - (dir * bs.w) / 2, y: bc.y }
    const bow = Math.min(90, Math.abs(p2.x - p1.x) / 2 + 40)
    const d = `M${p1.x},${p1.y} C${p1.x + dir * bow},${p1.y - 50} ${p2.x - dir * bow},${p2.y - 50} ${p2.x},${p2.y}`
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 38 }
    return (
      <g key={`${r.f}-${r.t}-${i}`} className="mmv-rel" data-selected={selRel === i || undefined}>
        <path
          className="mmv-rel-hit"
          d={d}
          onPointerDown={(e) => {
            e.stopPropagation()
            setSelRel(i)
            setSel([])
            focusCanvas()
          }}
          onDoubleClick={() => {
            const tok0 = store.getState().token
            void store.prompt('关系线标签', r.l ?? '').then((v) => {
              if (v == null) return
              const st = store.getState()
              if (st.token !== tok0) return // 弹窗期间页被切换/重装:别把这条标签写进别人的文件(令牌比路径严)
              // 按端点重新定位,不用弹窗打开时的下标 —— 期间可能已经删/加过关系线(Codex)。
              const cur = readRels(st.manifest?.fmExtra ?? '')
              const at = cur.findIndex((x) => x.f === r.f && x.t === r.t)
              if (at < 0) return
              persistRels(cur.map((x, j) => (j === at ? { ...x, l: v || undefined } : x)))
            })
          }}
        />
        <path className="mmv-rel-line" d={d} markerEnd="url(#mmv-arrow)" />
        {r.l && (
          <text className="mmv-rel-label" x={mid.x} y={mid.y} textAnchor="middle">
            {r.l}
          </text>
        )}
      </g>
    )
  })

  const fitView = (): void => {
    const el = rootRef.current
    if (!el) return
    const vw = el.clientWidth
    const vh = el.clientHeight
    const z = clamp(Math.min((vw - 2 * PAD) / Math.max(1, bbox.w), (vh - 2 * PAD) / Math.max(1, bbox.h)), 0.25, 1.5)
    setZoom(z)
    setPan({ x: (vw - bbox.w * z) / 2 - bbox.minX * z, y: (vh - bbox.h * z) / 2 - bbox.minY * z })
  }

  // ── 方向键:按**视觉方向**选最近的节点(树数组顺序在左右展开的图里毫无意义,原型文档 §4.7) ──
  const navigate = (dir: 'up' | 'down' | 'left' | 'right'): void => {
    if (!primary) {
      if (visible.length) select(visible[0])
      return
    }
    const from = positions.get(primary)
    if (!from) return
    const fs = sizeOf(primary)
    const fc = { x: from.x + fs.w / 2, y: from.y + fs.h / 2 }
    let best: string | null = null
    let bestScore = Infinity
    for (const id of visible) {
      if (id === primary) continue
      const p = positions.get(id)
      if (!p) continue
      const s = sizeOf(id)
      const dx = p.x + s.w / 2 - fc.x
      const dy = p.y + s.h / 2 - fc.y
      const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
      if (along <= 1) continue // 不在该方向上
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
      const score = along + across * 2 // 主方向近者优先,横向偏得多的罚分
      if (score < bestScore) {
        bestScore = score
        best = id
      }
    }
    if (best) select(best)
  }

  // ── 键盘:状态决定含义(选中态=结构操作,编辑态=一律交给编辑器,只留 Esc 退出) ──
  const onKeyDown = (e: RKeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    const inEditor = !!t?.closest?.('[contenteditable="true"], input, textarea')
    if (e.key === 'Escape') {
      // slash 菜单/行内工具栏开着时它们在 window 捕获相就吃掉了 Esc → 这里收到的必是「退出编辑/取消选中」。
      if (editing) {
        e.preventDefault()
        exitEdit()
      } else if (relFrom) {
        setRelFrom(null)
      } else if (menu || canvasMenu) {
        closeMenus()
      } else if (sel.length || selRel != null) {
        select(null)
      }
      return
    }
    if (editing || inEditor) return // 编辑态:输入法组合、Enter 换行、Tab 缩进全归编辑器
    const mod = e.metaKey || e.ctrlKey
    if (mod) {
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        // 结构改动写在 manifest.fmExtra 里,与块的增删同属 pageStore 的 struct 快照 → 一步撤销两者都回。
        if (e.shiftKey) store.getState().redo()
        else store.getState().undo()
      } else if (k === 'y') {
        e.preventDefault()
        store.getState().redo()
      } else if (k === 'a') {
        e.preventDefault()
        setSel(visible)
      } else if (k === 'c' && sel.length) {
        e.preventDefault()
        copy(sel)
      } else if (k === 'x' && sel.length) {
        e.preventDefault()
        copy(sel)
        void removeSubtrees(sel)
      } else if (k === 'v') {
        e.preventDefault()
        void paste(primary)
      }
      return
    }
    if (selRel != null && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      persistRels(rels.filter((_, i) => i !== selRel))
      setSelRel(null)
      return
    }
    if (!primary) {
      if (e.key.startsWith('Arrow')) {
        e.preventDefault()
        navigate(e.key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right')
      }
      return
    }
    switch (e.key) {
      case 'Tab': // 子节点 / Shift+Tab 升级
        e.preventDefault()
        if (e.shiftKey) outdent(primary)
        else addChild(primary)
        break
      case 'Enter': // 同级;根节点上 = 长出一条主分支(原型文档 §4.2)
        e.preventDefault()
        if (mmMap[primary]?.p) addSibling(primary)
        else addChild(primary)
        break
      case ' ':
      case 'F2':
        e.preventDefault()
        beginEdit(primary)
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        void (e.altKey ? removeKeepChildren(primary) : removeSubtrees(sel))
        break
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault()
        navigate(e.key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right')
        break
      default:
        break
    }
  }

  /** 大纲行:与画布同一份数据的 DFS 投影(含折叠态,折叠的子树不展开)。 */
  const outlineRows = useMemo((): OutlineRow[] => {
    const rows: OutlineRow[] = []
    const seen = new Set<string>()
    const walk = (id: string, depth: number): void => {
      if (seen.has(id)) return
      seen.add(id)
      rows.push({
        id,
        depth,
        label: nodeLabel(blocks[id]?.content ?? ''),
        kids: childrenOf(mmMap, id, order).length,
        collapsed: !!mmMap[id]?.c,
        kind: mmMap[id]?.sm ? 'summary' : 'node',
      })
      if (mmMap[id]?.c) return
      for (const c of childrenOf(mmMap, id, order)) walk(c, depth + 1)
    }
    for (const r of rootsOf(mmMap, order)) walk(r, 0)
    // 关系图成环时 rootsOf 可能一个都不给(环里每个节点都「有父」)→ 大纲空白但画布上明明有卡片。
    // 画布靠安全网补渲染,大纲也要:凡是可见却没走到的,一律按根补一行(Codex)。
    for (const id of visible) if (!seen.has(id)) walk(id, 0)
    return rows
  }, [mmMap, order, blocks, visible])

  const nodeMenu = menu && blocks[menu.id] && (
    <div ref={menuPos.ref} className="ctx-menu mmv-menu" style={menuPos.style} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => { closeMenus(); addChild(menu.id) }}>＋ 子节点 <span className="mmv-kbd">Tab</span></button>
      <button onClick={() => { closeMenus(); mmMap[menu.id]?.p ? addSibling(menu.id) : addChild(menu.id) }}>
        ⤵ 同级节点 <span className="mmv-kbd">Enter</span>
      </button>
      <button onClick={() => { closeMenus(); beginEdit(menu.id) }}>✎ 编辑 <span className="mmv-kbd">空格</span></button>
      <button onClick={() => { closeMenus(); indent(menu.id) }}>→ 降级(挂到上一个兄弟)</button>
      <button onClick={() => { closeMenus(); outdent(menu.id) }}>← 升级 <span className="mmv-kbd">⇧Tab</span></button>
      {!!childrenOf(mmMap, menu.id, order).length && (
        <button onClick={() => { closeMenus(); toggleCollapse([menu.id]) }}>
          {mmMap[menu.id]?.c ? '⌄ 展开子级' : '› 折叠子级'}
        </button>
      )}
      <button onClick={() => { const id = menu.id; closeMenus(); setRelFrom(id) }}>🔗 关系线连到…</button>
      <button onClick={() => { closeMenus(); toggleFlag([menu.id], 'bd') }}>{mmMap[menu.id]?.bd ? '▢ 去掉边界' : '▢ 加边界'}</button>
      {!!mmMap[menu.id]?.p && (
        <button onClick={() => { closeMenus(); toggleFlag([menu.id], 'sm') }}>
          {mmMap[menu.id]?.sm ? '} 取消概要' : '} 设为概要'}
        </button>
      )}
      <button onClick={() => { closeMenus(); copy(sel.includes(menu.id) ? sel : [menu.id]) }}>⎘ 复制 <span className="mmv-kbd">⌘C</span></button>
      <button onClick={() => { const id = menu.id; closeMenus(); void paste(id) }}>⎗ 粘贴到此 <span className="mmv-kbd">⌘V</span></button>
      <button onClick={() => { closeMenus(); void removeKeepChildren(menu.id) }}>✕ 删除本节点(保留子级)</button>
      <button className="danger" onClick={() => { const ids = sel.includes(menu.id) ? sel : [menu.id]; closeMenus(); void removeSubtrees(ids) }}>✕ 删除子树</button>
    </div>
  )

  const blankMenu = canvasMenu && (
    <div ref={canvasMenuPos.ref} className="ctx-menu mmv-menu" style={canvasMenuPos.style} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => { closeMenus(); addRoot() }}>＋ 新建中心节点</button>
      <button onClick={() => { closeMenus(); setSel(visible); focusCanvas() }}>▣ 全选 <span className="mmv-kbd">⌘A</span></button>
      <button onClick={() => { closeMenus(); setAllCollapsed(true) }}>› 全部折叠</button>
      <button onClick={() => { closeMenus(); setAllCollapsed(false) }}>⌄ 全部展开</button>
      <button onClick={() => { closeMenus(); fitView() }}>⤢ 适应全图</button>
      <button onClick={() => { closeMenus(); setShowOutline((v) => !v) }}>☰ {showOutline ? '隐藏大纲' : '显示大纲'}</button>
      <button onClick={() => { closeMenus(); void paste(null) }}>⎗ 粘贴为新中心 <span className="mmv-kbd">⌘V</span></button>
      <button onClick={() => { closeMenus(); exportOutline() }}>↧ 导出 Markdown 大纲</button>
      <button onClick={() => { closeMenus(); exportOpml() }}>↧ 导出 OPML(XMind 可读)</button>
    </div>
  )

  if (manifest && !order.length) {
    return (
      <div className="mmv-root mmv-empty">
        <button className="mmv-empty-btn" onClick={addRoot}>＋ 新建中心</button>
        <div className="mmv-empty-hint">思维导图的每个节点都是一个真正的 Amadeus 块 —— 可写富文本、插入 ![[嵌入]]、图片、数据库。</div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="mmv-root"
      data-status={status}
      data-rel-mode={relFrom ? '' : undefined}
      tabIndex={0}
      onWheel={onWheel}
      onPointerDown={onCanvasPointerDown}
      onDoubleClick={onCanvasDoubleClick}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('.mmv-node') || t.closest('.mmv-outline')) return
        e.preventDefault()
        setMenu(null)
        setCanvasMenu({ x: e.clientX, y: e.clientY })
      }}
      onKeyDown={onKeyDown}
    >
      {title && (
        <div className="mmv-title" style={showOutline ? { left: 244 } : undefined} title={activePage ?? ''}>
          {title}
        </div>
      )}
      <div className="mmv-canvas" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
        <svg
          className="mmv-edges"
          style={{ left: bbox.minX, top: bbox.minY, width: bbox.w, height: bbox.h }}
          viewBox={`${bbox.minX} ${bbox.minY} ${bbox.w} ${bbox.h}`}
          width={bbox.w}
          height={bbox.h}
        >
          <defs>
            <marker id="mmv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="mmv-arrow-head" />
            </marker>
          </defs>
          {layout.bounds.map((b) => (
            <rect key={`bd-${b.id}`} className="mmv-boundary" x={b.x} y={b.y} width={b.w} height={b.h} rx={14} />
          ))}
          {layout.brackets.map((b, i) => (
            <path
              key={`sm-${i}`}
              className="mmv-bracket"
              d={`M${b.x},${b.y0} q10,0 10,10 L${b.x + 10},${(b.y0 + b.y1) / 2 - 8} q0,8 10,8 q-10,0 -10,8 L${b.x + 10},${b.y1 - 10} q0,10 -10,10 M${b.x + 20},${(b.y0 + b.y1) / 2} L${b.toX},${b.toY}`}
            />
          ))}
          {edges}
          {previewEdge}
          {relPaths}
        </svg>
        {marquee && <div className="mmv-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        {drag && drop && drop.mode !== 'child' && (() => {
          const p = positions.get(drop.id)
          if (!p) return null
          const s = sizeOf(drop.id)
          return <div className="mmv-insert" style={{ left: p.x, top: (drop.mode === 'before' ? p.y : p.y + s.h) - 1.5, width: s.w }} />
        })()}
        <BlockSurfaceContext.Provider value={surface}>
            {visible.map((id) => {
              const p = posOf(id)
              if (!p || !blocks[id]) return null
              return (
                <NodeCard
                  key={id}
                  id={id}
                  x={p.x}
                  y={p.y}
                  dragging={drag?.id === id}
                  selected={selSet.has(id)}
                  editing={editing === id}
                  dropTarget={drop?.mode === 'child' && drop.id === id}
                  relTarget={!!relFrom && relFrom !== id}
                  childCount={childrenOf(mmMap, id, order).length}
                  hiddenCount={mmMap[id]?.c ? descendantsOf(mmMap, id, order).length : 0}
                  collapsed={!!mmMap[id]?.c}
                  summary={!!mmMap[id]?.sm}
                  onMeasure={onMeasure}
                  onDragHead={startNodeDrag}
                  onSelect={(nid, additive) => {
                    if (relFrom) {
                      // 同一对节点不重复连(两条重合的线看不出是两条,只会删不干净)。
                      if (relFrom !== nid && !rels.some((r) => r.f === relFrom && r.t === nid)) {
                        persistRels([...rels, { f: relFrom, t: nid }])
                      }
                      setRelFrom(null)
                      select(nid)
                      return
                    }
                    select(nid, additive)
                  }}
                  onEdit={beginEdit}
                  onMenu={(e, nid) => { setCanvasMenu(null); setMenu({ x: e.clientX, y: e.clientY, id: nid }) }}
                  onToggleCollapse={(nid) => toggleCollapse([nid])}
                  onAddChild={addChild}
                  onAddSibling={addSibling}
                  onDelete={(nid) => void removeSubtrees([nid])}
                />
              )
            })}
        </BlockSurfaceContext.Provider>
      </div>
      {showOutline && (
        <MindmapOutline
          rows={outlineRows}
          selected={selSet}
          onSelect={(id, additive) => select(id, additive)}
          onEdit={beginEdit}
          onToggle={(id) => toggleCollapse([id])}
          onClose={() => setShowOutline(false)}
        />
      )}
      <div className="mmv-zoom">
        <button onClick={() => zoomAbout(1 / 1.25, (rootRef.current?.clientWidth ?? 0) / 2, (rootRef.current?.clientHeight ?? 0) / 2)} title="缩小">−</button>
        <button className="mmv-pct" onClick={() => { setZoom(1); setPan({ x: PAD, y: PAD }) }} title="重置 100%">{Math.round(zoom * 100)}%</button>
        <button onClick={() => zoomAbout(1.25, (rootRef.current?.clientWidth ?? 0) / 2, (rootRef.current?.clientHeight ?? 0) / 2)} title="放大">＋</button>
        <span className="mmv-sep" />
        <button onClick={fitView} title="适应全图">⤢</button>
        <button className="mmv-outline-btn" data-on={showOutline || undefined} onClick={() => setShowOutline((v) => !v)} title="大纲(与画布同步)">☰</button>
      </div>
      <div className="mmv-hint">
        {relFrom
          ? '点击目标节点建立关系线 · Esc 取消'
          : editing
            ? 'Esc 退出编辑 · 卡内就是普通 Amadeus 块(/ 唤起命令)'
            : sel.length > 1
              ? `已选 ${sel.length} 个 · ⌫ 批量删除 · ⌘C/⌘X 复制剪切 · 拖头部批量改父`
              : primary
                ? 'Tab 子节点 · ⇧Tab 升级 · Enter 同级 · 空格 编辑 · 方向键 移动 · ⌫ 删子树 · ⌥⌫ 只删本节点 · ⌘C/⌘V 复制粘贴'
                : '单击选中 · 双击编辑 · 空白拖=框选 · ⌥拖/中键=平移 · 双击空白=新中心 · 右键=更多'}
      </div>
      {nodeMenu}
      {blankMenu}
    </div>
  )
}

function NodeCard({
  id,
  x,
  y,
  dragging,
  selected,
  editing,
  dropTarget,
  relTarget,
  childCount,
  hiddenCount,
  collapsed,
  summary,
  onMeasure,
  onDragHead,
  onSelect,
  onEdit,
  onMenu,
  onToggleCollapse,
  onAddChild,
  onAddSibling,
  onDelete,
}: {
  id: string
  x: number
  y: number
  dragging: boolean
  selected: boolean
  editing: boolean
  dropTarget: boolean
  relTarget: boolean
  childCount: number
  hiddenCount: number
  collapsed: boolean
  summary: boolean
  onMeasure: (id: string, w: number, h: number) => void
  onDragHead: (e: RPointerEvent, id: string) => void
  onSelect: (id: string, additive: boolean) => void
  onEdit: (id: string) => void
  onMenu: (e: RMouseEvent, id: string) => void
  onToggleCollapse: (id: string) => void
  onAddChild: (id: string) => void
  onAddSibling: (id: string) => void
  onDelete: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = (): void => onMeasure(id, el.offsetWidth, el.offsetHeight)
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [id, onMeasure])
  return (
    <div
      ref={ref}
      className="mmv-node"
      data-id={id}
      data-dragging={dragging || undefined}
      data-selected={selected || undefined}
      data-editing={editing || undefined}
      data-drop={dropTarget || undefined}
      data-reltarget={relTarget || undefined}
      data-summary={summary || undefined}
      style={{ left: x, top: y, width: CARD_W }}
      // 选中优先:非编辑态的正文 pointer-events:none(见 mindmap.css)→ 指针事件都落在这里。
      onPointerDown={(e) => { if (!editing) onSelect(id, e.shiftKey || e.metaKey || e.ctrlKey) }}
      onDoubleClick={(e) => {
        if (editing) return
        e.stopPropagation() // 别让画布的「双击空白建中心」也触发
        onEdit(id)
      }}
      onContextMenu={(e) => {
        if (editing) return // 编辑态:右键交给块菜单(BlockHost)
        e.preventDefault()
        e.stopPropagation()
        onSelect(id, e.shiftKey || e.metaKey || e.ctrlKey)
        onMenu(e, id)
      }}
    >
      <div className="mmv-node-head" onPointerDown={(e) => onDragHead(e, id)}>
        <span className="mmv-grip" title="拖动:中部=改父级,上/下缘=调兄弟顺序">⠿</span>
        {childCount > 0 && (
          <button
            className="mmv-collapse"
            title={collapsed ? '展开子级' : '折叠子级'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggleCollapse(id)}
          >
            {collapsed ? '›' : '⌄'}
          </button>
        )}
        {hiddenCount > 0 && (
          <button
            className="mmv-folded"
            title={`展开 ${hiddenCount} 个后代`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggleCollapse(id)}
          >
            {hiddenCount}
          </button>
        )}
        {summary && <span className="mmv-tag" title="概要节点:汇总同层其它子级">概要</span>}
        <span className="mmv-node-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button title="加子级 (Tab)" onClick={() => onAddChild(id)}>＋</button>
          <button title="加同级 (Enter)" onClick={() => onAddSibling(id)}>⤵</button>
          <button title="删除(含子级)" onClick={() => onDelete(id)}>🗑</button>
        </span>
      </div>
      <div className="mmv-node-body">
        <BlockHost blockId={id} />
      </div>
    </div>
  )
}
