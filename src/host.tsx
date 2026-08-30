// 宿主适配层:把 Amadeus 的「块表面」seam 伪装成宿主内部 pageStore / BlockHost 的形状。
//
// 为什么要这一层,而不是把画布里的三十来处调用逐个改写成 `ctx.app.xxx(token, …)`:
//  1. **令牌只想管一次**。每个改数据的 API 都要带页令牌(块 id 是页内递增的,拿着 A 页的 id 打到 B 页
//     上轻则插错、重则删错文件)。散在三十处 = 迟早漏一处,而漏掉的那处正好是毁档路径。
//  2. **画布要能跟宿主编辑器对齐**。节点里是真块,块的手感、slash、嵌入都归宿主管;画布本身应当能
//     几乎原样跟随上游。留一层薄适配,上游改了直接拷,不必两边各改一遍。
//
// 2026-08-14 起 per-view 化:宿主给插件文件视图发**每 tab 一份**的 `file.surface`(绑定该视图自己的
// pageStore 作用域)—— 多张画布、画布与笔记可同时编辑。适配层随之从模块级单例改为实例
// (makeHostStore),经 React context 下发;数据源可以是 surface(scope 化)或 ctx.app(旧宿主门面,
// 单活页模型,保留「点击加载」互斥占位)。
//
// 这一层**只做形状转换**,不藏业务:能力边界完全由 seam 决定(见宿主 plugins/types.ts)。
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react'

// ── 宿主注入的 ctx(new Function('ctx', code) 的形参)────────────────────────────
export interface PageSnapshot {
  token: string
  path: string | null
  status: string
  /** blockId → markdown。冻结且全插件共用,绝不可改。 */
  blocks: Readonly<Record<string, string>>
  order: readonly string[]
  fmExtra: string
}

/** 页数据面:ctx.app(门面,活动页模型)与 file.surface(per-view scope)共同满足的形状。 */
export interface PageSourceApi {
  getPage(): Readonly<PageSnapshot>
  subscribePage(cb: (p: PageSnapshot) => void): () => void
  setFmExtra(token: string, text: string): void
  insertBlockAfter(token: string, afterId: string | null, content: string): string | null
  deleteBlock(token: string, id: string): Promise<void>
  requestFocus(id: string, place?: 'start' | 'end'): void
  consumeFocus(id: string): void
  undo(token: string): void
  redo(token: string): void
  prompt(title: string, initial?: string, opts?: { label?: string }): Promise<string | null>
  mountBlocks(el: HTMLElement, opts: { token: string; blockId: string; onInsertAfter?(id: string, content: string): void }): () => void
  loadPage(path: string): void
  getActivePage(): string | null
  /** 2026-08-14 seam:把原生笔记编辑器(真 PageView)挂进插件 DOM。只有 per-view surface 有。 */
  mountNoteView?(el: HTMLElement): () => void
}

export interface AppApi extends PageSourceApi {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  openFile(path: string): void
  notify(message: string): void
}

export const hasBlockSurface = (a: Partial<AppApi> | undefined): boolean =>
  typeof a?.mountBlocks === 'function' && typeof a?.subscribePage === 'function'

// ── pageStore 形状 ──────────────────────────────────────────────────────────────
// 画布读的是 `blocks[id].content`(宿主 BlockState 的形状),seam 给的是扁平的 id→markdown。
// 转换必须**按引用缓存**:画布把 blocks 当 effect/useMemo 的依赖,每帧新建对象 = 每次 store 变动
// 整棵树白重排一遍。
export interface PageState {
  manifest: { fmExtra: string } | null
  blocks: Record<string, { content: string }>
  /** 文档顺序的块 id(宿主里要从 manifest.root 的行/列里摊平,seam 直接给)。 */
  order: readonly string[]
  status: string
  activePage: string | null
  /** 页令牌(seam 的 PageSnapshot.token)。异步操作(弹窗/deleteBlock)跨 await 的守卫**必须比对它**
   *  而不是 activePage:A→B→A 往返后路径相同但文件可能已被外部重编号,旧 id 配新令牌照样被 seam
   *  放行 —— 令牌每次装载都换,比路径严格(Codex P0)。 */
  token: string
  flatOrder(): string[]
  setFmExtra(text: string): void
  insertBlockAfter(afterId: string | null, _col: undefined, content: string): string | null
  deleteBlock(id: string): Promise<void>
  requestFocus(id: string, place?: 'start' | 'end'): void
  consumeFocus(id: string): void
  undo(): void
  redo(): void
}

/** 宿主 usePageStore 的替身,每个视图一份实例。`use` 是「在组件渲染期调用的方法」——
 *  它内部走 useSyncExternalStore,实例经 context 下发且恒定,不违反 hooks 规则。 */
export interface HostStore {
  use<T>(selector: (s: PageState) => T): T
  getState(): PageState
  subscribe(cb: () => void): () => void
  prompt(title: string, initial?: string, opts?: { label?: string }): Promise<string | null>
  mountBlocks: PageSourceApi['mountBlocks']
  loadPage(path: string): void
  getActivePage(): string | null
  /** 有 = per-view surface(可挂原生笔记编辑器;无互斥);无 = 旧宿主门面。 */
  mountNoteView?: (el: HTMLElement) => () => void
}

export function makeHostStore(src: PageSourceApi): HostStore {
  // ⚠️ 下面三个缓存不是优化,是**正确性**:seam 的 getPage() 每次调用都返回新对象(它自己是冻结的
  // 快照),而画布把 blocks/order/manifest 当 useMemo 与 effect 的依赖。不按内容去重的话,
  // useSyncExternalStore 每次读快照都判定「变了」→ 无限重渲直接把应用挂死。
  let lastFlat: unknown = null
  let shapedBlocks: Record<string, { content: string }> = {}
  const shape = (flat: Readonly<Record<string, string>>): Record<string, { content: string }> => {
    if (flat === lastFlat) return shapedBlocks
    lastFlat = flat
    shapedBlocks = {}
    for (const [id, content] of Object.entries(flat)) shapedBlocks[id] = { content }
    return shapedBlocks
  }

  let lastFm: string | null = null
  let manifestObj: { fmExtra: string } | null = null
  const manifestOf = (fmExtra: string, path: string | null): { fmExtra: string } | null => {
    if (!path) return null
    if (fmExtra !== lastFm || !manifestObj) {
      lastFm = fmExtra
      manifestObj = { fmExtra }
    }
    return manifestObj
  }

  let orderCache: readonly string[] = []
  const cacheOrder = (o: readonly string[]): readonly string[] => {
    if (orderCache.length === o.length && orderCache.every((id, i) => id === o[i])) return orderCache
    orderCache = o
    return orderCache
  }

  // 改数据一律**现取**令牌,不用缓存快照里的那个:两次订阅回调之间页可能已换,拿旧令牌提交会被
  // seam 拒(好),而拿缓存的令牌则可能恰好蒙对、把改动打到另一份文件上。
  const tok = (): string => src.getPage().token

  const actions = {
    setFmExtra: (text: string) => src.setFmExtra(tok(), text),
    insertBlockAfter: (afterId: string | null, _col: undefined, content: string) =>
      src.insertBlockAfter(tok(), afterId ?? null, content ?? ''),
    deleteBlock: (id: string) => src.deleteBlock(tok(), id),
    requestFocus: (id: string, place?: 'start' | 'end') => src.requestFocus(id, place),
    consumeFocus: (id: string) => src.consumeFocus(id),
    undo: () => src.undo(tok()),
    redo: () => src.redo(tok()),
  } as const

  let cached: PageState | null = null
  /** 当前状态。所有派生字段引用稳定 → 内容没变时**返回同一个对象**。 */
  const current = (): PageState => {
    const p = src.getPage()
    const manifest = manifestOf(p.fmExtra, p.path)
    const blocks = shape(p.blocks)
    const order = cacheOrder(p.order)
    if (
      cached &&
      cached.manifest === manifest &&
      cached.blocks === blocks &&
      cached.order === order &&
      cached.status === p.status &&
      cached.activePage === p.path &&
      cached.token === p.token
    )
      return cached
    cached = {
      manifest,
      blocks,
      order,
      status: p.status,
      activePage: p.path,
      token: p.token,
      flatOrder: () => [...order], // 调用方会就地排序/改动,别把冻结的快照数组递出去
      ...actions,
    }
    return cached
  }

  // 一份订阅、多个组件:每个 useSyncExternalStore 各订阅一次也能工作,但同一次页变动会触发 N 次
  // 转换;合并成一份订阅后,所有组件读到的必然是同一个 state 对象。
  const listeners = new Set<() => void>()
  let unsubHost: (() => void) | null = null
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb)
    if (!unsubHost) {
      unsubHost = src.subscribePage(() => {
        current()
        for (const l of [...listeners]) l()
      })
    }
    return () => {
      listeners.delete(cb)
      if (!listeners.size) {
        unsubHost?.()
        unsubHost = null
      }
    }
  }

  return {
    use: <T,>(selector: (s: PageState) => T): T =>
      // eslint-disable-next-line react-hooks/rules-of-hooks -- 恒在组件渲染期经稳定实例调用
      useSyncExternalStore(subscribe, () => selector(current()), () => selector(current())),
    getState: current,
    subscribe,
    prompt: (title, initial, opts) => src.prompt(title, initial, opts),
    mountBlocks: (el, opts) => src.mountBlocks(el, opts),
    loadPage: (p) => src.loadPage(p),
    getActivePage: () => src.getActivePage(),
    ...(typeof src.mountNoteView === 'function' ? { mountNoteView: (el: HTMLElement) => src.mountNoteView!(el) } : {}),
  }
}

const HostStoreCtx = createContext<HostStore | null>(null)
export const HostStoreProvider = HostStoreCtx.Provider
export function useHostStore(): HostStore {
  const s = useContext(HostStoreCtx)
  if (!s) throw new Error('导图:HostStore 未提供(MindmapCanvas 必须包在 HostStoreProvider 里)')
  return s
}

// ── BlockHost 替身 ──────────────────────────────────────────────────────────────
export interface BlockSurface {
  insertAfter: (blockId: string, content: string) => void
}
export const BlockSurfaceContext = createContext<BlockSurface | null>(null)

/** 宿主把**真** <BlockHost> 渲染进这个 div。插件自己的 React 与宿主的 React 是两棵树,
 *  边界就在这个 DOM 节点上 —— 这正是 seam 的设计:块归宿主渲染,画布归插件。 */
export function BlockHost({ blockId }: { blockId: string }): JSX.Element {
  const store = useHostStore()
  const surface = useContext(BlockSurfaceContext)
  const ref = useRef<HTMLDivElement>(null)
  // 回调用 ref 转发:把 surface 直接放进 effect 依赖,会因为父组件重建 surface 而整块重挂
  // (重挂 = 块内正在输入的焦点/选区全丢)。
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const owns = !!surface // 给了 onInsertAfter 就是宣告「结构归我管」,这一位不能随渲染抖动
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return store.mountBlocks(el, {
      token: store.getState().token,
      blockId,
      ...(owns ? { onInsertAfter: (id: string, content: string) => surfaceRef.current?.insertAfter(id, content) } : {}),
    })
  }, [blockId, owns, store])
  return <div ref={ref} className="mmv-blockmount" />
}

// ── 视口夹取(浮层落位)──────────────────────────────────────────────────────────
// 与宿主 lcl/engine/menuAnchor.tsx 同一套算法的**独立实现**。故意不走 seam:它只用标准 DOM
// (currentCSSZoom / innerWidth / offsetWidth),第三方插件本来就该能自己做到 —— 为纯几何开接缝
// 只会让 API 面积白白变大。⚠️但算法必须与宿主一致:Forsion 在 body 上开了端级 zoom
// (网页 1.1 / 触屏 1.15 / mini 0.85),rect 是视口坐标而 offsetWidth 是未缩放的局部 px,
// 不反补偿的话菜单会离鼠标越来越远。
const UI_ZOOM_EVENT = 'forsion:uizoom'
const zoomOf = (el: Element | null): number =>
  (el as (Element & { currentCSSZoom?: number }) | null)?.currentCSSZoom || 1

export function clampMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = 8,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, vw - w - margin))
  const fits = (t: number): boolean => t >= margin && t + h <= vh - margin
  for (const t of [y, y - h]) if (fits(t)) return { left, top: t }
  return { left, top: Math.max(margin, Math.min(y, vh - h - margin)) }
}

export function useClampedMenu(x: number, y: number): { ref: RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, maxWidth: undefined as number | undefined })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = (): void => {
      const z = zoomOf(el)
      const vw = window.innerWidth
      const wV = el.offsetWidth * z
      const v = clampMenu(x, y, wV, el.offsetHeight * z, vw, window.innerHeight)
      const maxWidth = wV > vw - 16 ? (vw - 16) / z : undefined
      setPos((prev) => {
        const next = { left: v.left / z, top: v.top / z, maxWidth }
        return prev.left === next.left && prev.top === next.top && prev.maxWidth === next.maxWidth ? prev : next
      })
    }
    apply()
    window.addEventListener('resize', apply)
    window.addEventListener(UI_ZOOM_EVENT, apply) // 端级 zoom 改了不发 resize
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener(UI_ZOOM_EVENT, apply)
      ro.disconnect()
    }
  }, [x, y])
  return { ref, style: { left: pos.left, top: pos.top, maxWidth: pos.maxWidth } }
}

// ── 框选命中(纯几何,与宿主 lib/marquee.ts 同源)─────────────────────────────────
export function marqueeHits(
  rect: { x: number; y: number; w: number; h: number },
  box: { left: number; top: number; right: number; bottom: number },
): boolean {
  return rect.x < box.right && rect.x + rect.w > box.left && rect.y < box.bottom && rect.y + rect.h > box.top
}

/** "Notes/abc.canvas.md" → "Notes/abc.canvas"(与宿主 compiler/names.ts 同源)。 */
export function stripPageBasename(pagePath: string): string {
  const seg = pagePath.split(/[\\/]/).pop() ?? pagePath
  const dot = seg.lastIndexOf('.')
  return dot > 0 ? seg.slice(0, dot) : seg
}
