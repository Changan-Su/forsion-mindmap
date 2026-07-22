// 思维导图插件入口。由 Amadeus 以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载,故:
//  - `ctx` 是宿主注入的自由变量(见下 declare);
//  - 打包产物顶层不得有 import/export(esbuild format:'iife' + minify 满足 validate.mjs 的裸 setup 体闸)。
// markmap 是纯渲染器(markdown 标题/缩进=树,无编辑 API),图内交互由本文件在 SVG 上自建一层(MindNode 式):
//  单击选中 → 双击/F2 就地内联编辑;选中态 Enter 加同级 / Tab 加子级 / Delete 删子树 / 方向键导航 / Esc 退选。
//  改动全部回写 markdown(纯逻辑在 ./model.mjs)。内联编辑的输入框种子取自「模型原始文本」(非渲染 DOM),故 `**粗体**` 不丢。
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import {
  BLANK_MINDMAP,
  escapeHtml,
  parseOutline,
  nodeAtPath,
  renameNode,
  addChild,
  addSibling,
  addRootNode,
  deleteNode,
  isSimpleOutline,
  splitCenters,
  splitPositions,
  joinPositions,
} from './model.mjs'

// 宿主注入(new Function('ctx', code) 的形参)。类型仅为作者便利,esbuild 会抹掉。
declare const ctx: {
  registerFileType(def: unknown): void
  registerEmbedRenderer(def: unknown): void
  registerFileCreator(def: unknown): void
  registerSlashItem(def: unknown): void
  registerCommand(def: unknown): void
  app: {
    readFile(path: string): Promise<string | null>
    writeFile(path: string, text: string): Promise<void>
    openFile(path: string): void
    notify(msg: string): void
  }
}

/** 注册一个**可选**扩展点:宿主可能是还没有它的旧版本。缺了就跳过这一项 —— 直接调用会在 setup 里抛,
 *  而 setup 抛错 = 整个插件装载失败(连文件类型/嵌入渲染一起没了),为了一个菜单项不值得。 */
function registerOptional(name: 'registerFileCreator' | 'registerSlashItem', def: unknown): void {
  const fn = (ctx as unknown as Record<string, unknown>)[name]
  if (typeof fn === 'function') (fn as (d: unknown) => void).call(ctx, def)
}

const transformer = new Transformer()
// 安全:禁止 markdown 里的原始 HTML —— 否则 `- <img src=x onerror=…>` 会被 markmap 经 D3 .html() 注入并在
// renderer origin 执行(可访问 window.amadeus)= XSS。关掉后原始标签被转义成文本,markdown 格式(**粗体**等)不受影响。
transformer.md.set({ html: false })
const SVG_NS = 'http://www.w3.org/2000/svg'

// 样式注入到挂载容器内(而非 document.head)→ 视图卸载 / 插件禁用时随容器一起移除,不留全局残留。
//
// ⚠️ 深浅色(两次踩坑的合并教训):
//  ① markmap 的暗色是 `.markmap-dark .markmap{--markmap-text-color:#eee}` —— 靠**祖先类名**驱动,不是
//     prefers-color-scheme;宿主切暗时它不会自己变 → 深底 + 默认 #333 深字几乎看不见。
//  ② 更隐蔽的一次:本插件曾用 `var(--am-bg,#fff)` 这类 token 上色,而 **Amadeus 里根本没有 `--am-*` 这套变量**
//     (仓内 grep 零命中) → 每一处都恒取浅色兜底值,缩放条/输入框在暗色下就是白底。仪器当时还「通过」了,
//     因为 harness 自己定义了 --am-*,把宿主没有的东西喂了进来 —— 假通过。
// 所以配色一律走 syncTheme() 从**实测计算样式**推导出的 `--mmp-*`(前景色取容器真实 color、背景取最近的不透明
// 祖先背景、边框/悬停由前景色调透明度合成),宿主有 `--accent` 就用、没有就退 Forsion 紫。不再依赖任何宿主 token 存在。
const STYLE_CSS = `
.mmp-root{display:flex;flex-direction:column;height:100%;min-height:0;color:inherit}
.mmp-root:focus,.mmp-root:focus-visible{outline:none}
.mmp-bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--mmp-border)}
.mmp-seg{display:inline-flex;border:1px solid var(--mmp-border);border-radius:8px;overflow:hidden}
.mmp-seg button{border:0;background:transparent;color:inherit;padding:3px 12px;font-size:13px;cursor:pointer}
.mmp-seg button:hover{background:var(--mmp-hover)}
.mmp-seg button.on{background:var(--mmp-accent);color:var(--mmp-on-accent)}
.mmp-exp{margin-left:auto}
.mmp-exp button{padding:3px 10px;font-size:12px}
.mmp-hint{font-size:12px;opacity:.6}
.mmp-body{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
/* 浮动画布:各中心是绝对定位的卡片,画布整体靠 transform 平移/缩放(取代 markmap 自带的 pan/zoom)。 */
.mmp-canvas{position:absolute;inset:0;transform-origin:0 0;touch-action:none}
.mmp-center{position:absolute;left:0;top:0}
.mmp-center.mmp-float>svg{cursor:default}
.mmp-svg{display:block;overflow:visible}
.mmp-src{width:100%;height:100%;border:0;outline:0;resize:none;padding:12px 14px;box-sizing:border-box;background:transparent;color:inherit;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.mmp-scope svg.mmp-svg{color:var(--mmp-fg);--markmap-text-color:var(--mmp-fg);--markmap-a-color:var(--mmp-accent)}
/* 选中框:画在节点 <g> 里、垫在文字后面的 SVG <rect> —— 比文字包围盒各方向大 10%(总面积 +20%,1.5.0)。
   用 <rect> 而非 CSS 描边:节点文字在 foreignObject 里,画到盒外会被裁切(历史「看不见选中」的真因),
   而 <rect> 是 foreignObject 的兄弟,不受裁切。non-scaling-stroke 保描边视觉恒 2px。 */
.mmp-scope .mmp-sel-rect{fill:var(--mmp-accent);fill-opacity:.18;stroke:var(--mmp-accent);stroke-width:2;vector-effect:non-scaling-stroke}
.mmp-inline{position:absolute;z-index:6;box-sizing:border-box;margin:0;border:0;outline:0;padding:0 3px;line-height:1.25;font-family:inherit;border-radius:6px;box-shadow:inset 0 0 0 2px var(--mmp-accent);background:var(--mmp-bg);color:var(--mmp-fg);resize:none;overflow:hidden;white-space:pre}
.mmp-gauge{position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;pointer-events:none}
.mmp-zoom{position:absolute;left:10px;bottom:10px;z-index:4;display:inline-flex;align-items:stretch;gap:2px;padding:2px;border-radius:9px;background:var(--mmp-bg);border:1px solid var(--mmp-border);box-shadow:0 1px 4px rgba(0,0,0,.12)}
.mmp-zoom button{border:0;background:transparent;color:var(--mmp-fg);cursor:pointer;font-size:13px;line-height:1;padding:5px 8px;border-radius:7px;min-width:26px}
.mmp-zoom button:hover{background:var(--mmp-hover)}
.mmp-zoom .mmp-pct{min-width:48px;font-variant-numeric:tabular-nums;font-size:12px}
.mmp-zoom .mmp-sep{width:1px;margin:4px 2px;background:var(--mmp-border)}
.mmp-embed{height:340px;position:relative;overflow:hidden}
.mmp-missing{padding:16px;opacity:.6;font-size:13px}
`
function injectStyle(container: HTMLElement): void {
  if (container.querySelector('style[data-mmp-style]')) return
  const s = document.createElement('style')
  s.setAttribute('data-mmp-style', '')
  s.textContent = STYLE_CSS
  container.appendChild(s)
}

/** 解析 CSS 颜色 → [r,g,b,a](rgb 0-255、a 0-1)。非法值返回 null。
 *  ⚠️ 不要自己抠数字:宿主主题可能用 `oklch()`/`hsl()`/`color(display-p3 …)`/带 `/ alpha` 的现代语法,
 *  按位置硬取前三个数会把 L/C/H 当成 R/G/B(Codex 实测 `oklch(0.5 0.1 250)` → [0.5,0.1,250]),
 *  而且**不会报错**,只会静默算出错误的亮度和背景色。这里直接借浏览器自己的颜色引擎:画 1px 再读回像素。 */
let probeCtx: CanvasRenderingContext2D | null = null
function parseColor(css: string): [number, number, number, number] | null {
  const s = (css || '').trim()
  if (!s) return null
  if (!probeCtx) {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    probeCtx = c.getContext('2d', { willReadFrequently: true })
  }
  const g = probeCtx
  if (!g) return null
  // fillStyle 遇到非法颜色会保持原值 → 用两个不同的哨兵试,两次都没变才判定为非法。
  g.fillStyle = '#000000'
  g.fillStyle = s
  const first = g.fillStyle
  g.fillStyle = '#ffffff'
  g.fillStyle = s
  if (first === '#000000' && g.fillStyle === '#ffffff') return null
  g.clearRect(0, 0, 1, 1)
  g.fillRect(0, 0, 1, 1)
  const d = g.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2], d[3] / 255]
}

/** 自身或最近祖先里第一个**不透明**的背景色(带 alpha 的现代语法也认得,见 parseColor)。
 *  ponytail: 只取第一层不透明底,不与其上的半透明层做 alpha 合成 —— 差的是细微色差,不是对错。 */
function opaqueBgOf(start: HTMLElement | null): string | null {
  for (let n: HTMLElement | null = start; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor
    const c = parseColor(bg)
    if (c && c[3] > 0.99) return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
  }
  return null
}

/** 从容器的**实测计算样式**推导本插件的全套配色变量,并按前景亮度给容器加/去 markmap 的 `markmap-dark` 类。
 *  不假设宿主定义了任何 token(见 STYLE_CSS 顶部注释:`--am-*` 曾是我们凭空假设的,宿主里并不存在)。
 *  ⚠️ 背景色的推导从**父元素**起算:`.mmp-root` 自己不设背景,否则下一次调用会读到上一次写进去的值 → 主题切换后卡死。 */
function syncTheme(el: HTMLElement): void {
  const cs = getComputedStyle(el)
  const rgb = parseColor(cs.color)
  const dark = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5 : false // 前景偏亮 = 暗色主题
  el.classList.toggle('markmap-dark', dark)
  const round = rgb ? [rgb[0], rgb[1], rgb[2]].map((v) => Math.round(v)).join(',') : '128,128,128'
  const pick = (name: string): string => cs.getPropertyValue(name).trim()
  const set = (k: string, v: string): void => el.style.setProperty(k, v)
  set('--mmp-fg', rgb ? `rgb(${round})` : dark ? '#e8e8ea' : '#1a1a1a')
  set('--mmp-bg', opaqueBgOf(el.parentElement) || (dark ? '#16181d' : '#ffffff'))
  set('--mmp-accent', pick('--accent') || pick('--am-accent') || '#4C2585')
  set('--mmp-on-accent', pick('--on-accent') || '#ffffff')
  set('--mmp-border', `rgba(${round},.24)`)
  set('--mmp-hover', `rgba(${round},.12)`)
  set('--mmp-wash', `rgba(${round},.10)`) // color-mix 不可用时选中底色的兜底
}

/** 订阅主题变化并持续同步:宿主切深浅时**不会重挂本视图**,只 syncTheme 一次的话会一直停在旧主题。
 *  主题类/变量可能挂在任意一级祖先上(宿主结构不由插件决定)→ 逐级往上全观察,别赌某一个元素。
 *  编辑器和嵌入块都必须用它 —— 嵌入块曾漏掉,笔记里的导图切主题不跟随(Codex)。返回 disconnect。 */
function observeTheme(el: HTMLElement): () => void {
  const ob = new MutationObserver(() => syncTheme(el))
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    ob.observe(n, { attributes: true, attributeFilter: ['class', 'data-mode', 'data-theme', 'style'] })
  }
  return () => ob.disconnect()
}

// duration:0 —— 每次改动都是整图重建,动画只会让节点在我们量取坐标时还在移动(内联输入框错位,Codex #5)。
const MAP_OPTS = { autoFit: true, duration: 0 }
// 编辑器里每个中心是**独立**的 markmap 实例:关掉自带 pan/zoom(改由外层浮动画布统一 transform)、
// 关 autoFit(避免它异步 fit() 与我们的 fitSvgToContent 抢 g.transform);渲染后手动缩 svg 到内容包围盒。
const MAP_OPTS_CENTER = { autoFit: false, duration: 0, zoom: false, pan: false }

/** 给树的每个节点打 path 标记(源序 DFS,与 model 的 path 一致)→ 双击 SVG 节点时反查本模型。 */
function tagPaths(node: any, path: number[]): void {
  node.__path = path
  const kids = node.children || []
  kids.forEach((c: any, i: number) => tagPaths(c, path.concat(i)))
}

/** 从 SVG 节点 <g> 反查它的模型 path。markmap 用 d3 把节点对象绑到 __data__(原地加 .state,保留我们的
 *  __path);若它用 flextree 包了一层,则 __data__.data 才是原节点 —— 两种都认。 */
function nodePathOf(g: Element): number[] | null {
  const raw = (g as unknown as { __data__?: any }).__data__
  if (!raw) return null
  if (Array.isArray(raw.__path)) return raw.__path
  if (raw.data && Array.isArray(raw.data.__path)) return raw.data.__path
  return null
}

const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** markmap 节点的源码起始行(payload.lines 形如 "1,3")。 */
function startLineOf(n: any): number | null {
  const raw = n?.payload?.lines
  if (typeof raw !== 'string') return null
  const v = parseInt(raw.split(',')[0], 10)
  return Number.isFinite(v) ? v : null
}

/**
 * **差分门禁**:拿实际渲染用的 transformer 树,证明它与本模型树**结构同构**且逐节点指向同一源码行。
 * isSimpleOutline 只是廉价初筛(启发式,可能与 markdown 真实嵌套规则分歧);这里才是权威判据 ——
 * 只有两棵树完全同构,SVG 节点上的 path 才必然指向模型里的同一个节点,「双击 A 改到 B」在结构上不可能发生。
 *
 * ⚠️ 必须**递归成对**比,不能只比 DFS 展平后的行号序列(Codex 实测反例):
 *   `# A / - parent /   - - dash /     - child`
 * 里 `- - dash` 的正文本身又是个列表,markdown 把 `child` 提升为 dash 的同级、模型却当成它的子级 ——
 * 两棵树层级不同,但 DFS 行号序列恰好一样,老判据会放行。加上各层 children 数量一致后,path 即被唯一确定。
 */
function treesAligned(transformerRoot: any, md: string): boolean {
  const same = (a: any, b: any): boolean => {
    const line = startLineOf(a)
    // 多中心文档的虚拟根:markmap 那边 payload.lines 为 undefined,本模型 line=-1 —— 必须两边同时「没有源码行」。
    if (b.line < 0 ? line !== null : line !== b.line) return false
    const ac = a.children || []
    const bc = b.children || []
    if (ac.length !== bc.length) return false
    for (let i = 0; i < ac.length; i++) if (!same(ac[i], bc[i])) return false
    return true
  }
  return same(transformerRoot, parseOutline(md).root)
}

/** 节点 <g> 里那个「紧贴文字」的内容盒(markmap: foreignObject.markmap-foreign > div > div,内层 inline-block 贴文字)。 */
function contentDivOf(g: Element): HTMLElement | null {
  return (g.querySelector('.markmap-foreign > div > div')
    || g.querySelector('.markmap-foreign > div')
    || g.querySelector('.markmap-foreign')) as HTMLElement | null
}

/** 等 markmap 的**布局真正稳定**再回调。
 *  ⚠️ 不能拿「g.markmap-node 已存在」当就绪:markmap 先同步插入节点、之后才在 rAF 里布局 + 异步 fit(),
 *  那一刻节点还压在原点附近,此时量坐标会把内联输入框放到错误位置(实测 node 8,39 vs 稳定后 486,411)。
 *  判据改为:首个节点的位置连续两帧不变。 */
function whenLayoutReady(svg: SVGSVGElement, cb: () => void, tries = 60): void {
  let prev: string | null = null
  const step = (left: number): void => {
    const n = svg.querySelector('g.markmap-node')
    if (!n) {
      if (left <= 0) { cb(); return }
      requestAnimationFrame(() => step(left - 1))
      return
    }
    const r = (n as SVGGraphicsElement).getBoundingClientRect()
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`
    if (prev !== null && key === prev) { cb(); return } // 连续两帧同位置 = 稳了
    prev = key
    if (left <= 0) { cb(); return }
    requestAnimationFrame(() => step(left - 1))
  }
  requestAnimationFrame(() => step(tries))
}

// ── 导出(PNG / PDF / Markdown) ──────────────────────────────────────────────
// 页面里的 SVG 靠宿主 CSS 上色、靠缩放变换定位;直接序列化出去会得到「无样式 + 只剩当前视口那块」。
// 故导出前先做一份自包含克隆:裁到内容包围盒、清掉缩放变换与选中装饰、把计算样式逐元素内联。
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const EXPORT_PROPS = [
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-dasharray', 'fill', 'fill-opacity', 'opacity',
]

/**
 * ⚠️ **canvas 污染**:Chromium 只要往 canvas 画一张含 `<foreignObject>` 的 SVG 图,就会把画布标记为
 * tainted,`toBlob`/`toDataURL` 随即抛 SecurityError —— 而 markmap 的每个节点文字都在 foreignObject 里,
 * 所以「序列化 SVG → Image → canvas」这条常规路子导不出任何位图。
 * 解法:导出前把每个 foreignObject 换成等价的原生 `<text>/<tspan>`(位置取 foreignObject 自己的 x/y/height,
 * 每段文字沿用它在页面上的计算字重/字形/字体/颜色)。既解除污染,导出的也是真矢量文字。
 *
 * **单行假设**成立的前提有两条,改任一条都要回来改这里:①`transformer.md.set({html:false})` —— 原始 HTML
 * 被转义成文本,节点里不会出现 `<br>`/块级元素;②markmap 的 `maxWidth` 保持默认 0(不自动折行,实测每个
 * foreignObject 高度恒为一行)。ponytail: 因此每个节点只出一行 `<text>`;代码块底色/圆角不还原(仅保等宽字体)。
 */
function foreignToText(srcFo: Element, dstFo: Element): void {
  const parent = dstFo.parentNode
  if (!parent) return
  const inner = (srcFo.querySelector('div > div') || srcFo.querySelector('div')) as HTMLElement | null
  if (!inner) {
    parent.removeChild(dstFo)
    return
  }
  const cs = getComputedStyle(inner)
  const num = (n: string, d: number): number => {
    const v = parseFloat(srcFo.getAttribute(n) || '')
    return Number.isFinite(v) ? v : d
  }
  const foX = num('x', 0)
  const foY = num('y', 0)
  const foH = num('height', 20)
  // 多行节点(1.5.0):内容里可能有 `<br>`(markmap 把续行渲成 `<br>`)→ 按行拆成多个 <text>,
  // 每行在 foreignObject 高度里均分居中。单行节点 = 1 行,与旧行为一致。
  const lines: { t: string; pcs: CSSStyleDeclaration }[][] = [[]]
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      const t = n.textContent || ''
      if (t) lines[lines.length - 1].push({ t, pcs: n.parentElement ? getComputedStyle(n.parentElement) : cs })
      return
    }
    const el = n as Element
    if (el.tagName === 'BR') { lines.push([]); return } // 断行
    // 图片没有文本子节点:不特殊处理的话整个节点在导出图里**凭空消失**(Codex)。退化成 alt 文本占位。
    if (el.tagName === 'IMG') {
      const alt = ((n as HTMLImageElement).alt || '').trim()
      lines[lines.length - 1].push({ t: alt ? `🖼 ${alt}` : '🖼', pcs: cs })
      return
    }
    n.childNodes.forEach(walk)
  }
  walk(inner)
  const rows = lines.filter((r) => r.length)
  if (!rows.length) { parent.removeChild(dstFo); return } // 空虚拟根等:没有文字,不留空 <text>
  const lineH = foH / rows.length
  const frag = document.createDocumentFragment()
  rows.forEach((segs, li) => {
    const text = document.createElementNS(SVG_NS, 'text')
    text.setAttribute('x', String(foX))
    text.setAttribute('y', String(foY + lineH * (li + 0.5)))
    text.setAttribute('dominant-baseline', 'central')
    text.setAttribute('font-family', cs.fontFamily)
    text.setAttribute('font-size', cs.fontSize)
    text.setAttribute('fill', cs.color)
    text.setAttributeNS(XML_NS, 'xml:space', 'preserve') // 否则 `**粗** 尾巴` 中间那个空格会被 SVG 吃掉
    // 逐段取它**父元素**的计算样式 → `<strong>`/`<em>`/`<a>`/`<code>` 任意嵌套都自然处理。
    for (const { t, pcs } of segs) {
      const span = document.createElementNS(SVG_NS, 'tspan')
      span.textContent = t
      if (parseInt(pcs.fontWeight, 10) >= 600) span.setAttribute('font-weight', 'bold')
      if (pcs.fontStyle === 'italic') span.setAttribute('font-style', 'italic')
      if (pcs.fontFamily && pcs.fontFamily !== cs.fontFamily) span.setAttribute('font-family', pcs.fontFamily) // `<code>` 的等宽
      if (pcs.color && pcs.color !== cs.color) span.setAttribute('fill', pcs.color)
      if (/underline|line-through/.test(pcs.textDecorationLine)) span.setAttribute('text-decoration', pcs.textDecorationLine)
      text.appendChild(span)
    }
    frag.appendChild(text)
  })
  parent.insertBefore(frag, dstFo)
  parent.removeChild(dstFo)
}

/** 把一个中心的 svg 内容克隆成**自包含**的 `<g>`(内联描边样式 + foreignObject→矢量文字),
 *  返回克隆 g 与它的自然坐标包围盒(viewBox 已在渲染期被 fitSvgToContent 设成该盒 → 1:1 像素)。 */
function exportCenterG(svg: SVGSVGElement): { g: SVGGElement; vb: number[] } | null {
  const srcG = svg.querySelector('g') as SVGGraphicsElement | null
  if (!srcG) return null
  const vbAttr = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
  if (vbAttr.length !== 4 || !(vbAttr[2] > 0) || !(vbAttr[3] > 0)) return null
  const clone = srcG.cloneNode(true) as SVGGElement
  clone.querySelectorAll('.mmp-sel-rect').forEach((e) => e.remove()) // 选中框不进导出
  clone.removeAttribute('transform')
  // 连线/折叠圈的描边色来自宿主 CSS,独立 SVG 不继承 → 内联。克隆树与源树同构,querySelectorAll 同序一一对应。
  const src = [srcG, ...Array.from(srcG.querySelectorAll('*'))]
  const dst = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < src.length && i < dst.length; i++) {
    if (dst[i].closest('foreignObject')) continue // 整块马上要被 <text> 顶掉,不必上样式
    const cs = getComputedStyle(src[i])
    let css = ''
    for (const p of EXPORT_PROPS) {
      const v = cs.getPropertyValue(p)
      if (v) css += `${p}:${v};`
    }
    dst[i].setAttribute('style', css + (dst[i].getAttribute('style') || ''))
  }
  const sfo = srcG.querySelectorAll('foreignObject')
  const dfo = clone.querySelectorAll('foreignObject')
  for (let i = 0; i < sfo.length && i < dfo.length; i++) foreignToText(sfo[i], dfo[i])
  return { g: clone, vb: vbAttr }
}

/** 把画布里各中心按它们的画布坐标拼成一张自包含 SVG(浮动中心各在其位、无中枢连线)。 */
function exportComposite(canvas: HTMLElement, pad = 24): { xml: string; w: number; h: number } | null {
  const parts: SVGGElement[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of Array.from(canvas.querySelectorAll('.mmp-center')) as HTMLElement[]) {
    const svg = c.querySelector('svg.mmp-svg') as SVGSVGElement | null
    if (!svg) continue
    const info = exportCenterG(svg)
    if (!info) continue
    const cx = parseFloat(c.style.left) || 0
    const cy = parseFloat(c.style.top) || 0
    const wrap = document.createElementNS(SVG_NS, 'g') as SVGGElement
    // 自然坐标(viewBox 起点 vb[0],vb[1])→ 画布坐标(cx,cy),1:1
    wrap.setAttribute('transform', `translate(${cx - info.vb[0]},${cy - info.vb[1]})`)
    wrap.appendChild(info.g)
    parts.push(wrap)
    minX = Math.min(minX, cx); minY = Math.min(minY, cy)
    maxX = Math.max(maxX, cx + info.vb[2]); maxY = Math.max(maxY, cy + info.vb[3])
  }
  if (!parts.length) return null
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  const outer = document.createElementNS(SVG_NS, 'g') as SVGGElement
  outer.setAttribute('transform', `translate(${-minX},${-minY})`)
  parts.forEach((p) => outer.appendChild(p))
  svg.appendChild(outer)
  const w = Math.ceil(maxX - minX) + pad * 2
  const h = Math.ceil(maxY - minY) + pad * 2
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${w} ${h}`)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.setAttribute('xmlns', SVG_NS)
  return { xml: new XMLSerializer().serializeToString(svg), w, h }
}

/** 超采样倍率,但先卡住 canvas 预算:单边 ≤ 16384、总像素 ≤ 4000 万。
 *  超大导图按 2× 直接开 canvas 可能要几 GB(Codex:20000² 的图 → 40000² RGBA ≈ 6.4GB),
 *  那是**渲染进程 OOM**,不是能被 try/catch 兜住的普通异常。宁可降采样也不能崩宿主。 */
function safeScale(w: number, h: number, want = 2): number {
  const byEdge = Math.min(16384 / Math.max(1, w), 16384 / Math.max(1, h))
  const byArea = Math.sqrt(40e6 / Math.max(1, w * h))
  return Math.max(0.2, Math.min(want, byEdge, byArea))
}

/** 自包含 SVG → canvas(scale 倍超采样;bg 给 JPEG/PDF 用,PNG 传 undefined 保留透明)。 */
async function rasterize(xml: string, w: number, h: number, scale: number, bg?: string): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('SVG 渲染失败'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const c2 = canvas.getContext('2d')
    if (!c2) throw new Error('canvas 不可用')
    if (bg) {
      c2.fillStyle = bg
      c2.fillRect(0, 0, canvas.width, canvas.height)
    }
    c2.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob> =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('图像编码失败'))), type, q))

/** 单页 PDF = 一张整页 JPEG。JPEG 可原样塞进 PDF 流(/DCTDecode),不需要 zlib,也就不需要引第三方 PDF 库。
 *  ponytail: 只做「一张图一页」,够导出用;要可选文字/矢量再上真 PDF 库。 */
function pdfFromJpeg(jpeg: Uint8Array, iw: number, ih: number, pw: number, ph: number): Blob {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const off: number[] = []
  let len = 0
  const push = (x: string | Uint8Array): void => {
    const b = typeof x === 'string' ? enc.encode(x) : x
    parts.push(b)
    len += b.length
  }
  const obj = (n: number, dict: string, stream?: Uint8Array): void => {
    off[n] = len // xref 要的是每个对象的**字节**偏移,所以全程按字节数累计
    push(`${n} 0 obj\n${dict}\n`)
    if (stream) {
      push('stream\n')
      push(stream)
      push('\nendstream\n')
    }
    push('endobj\n')
  }
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`
  push('%PDF-1.4\n')
  obj(1, '<</Type/Catalog/Pages 2 0 R>>')
  obj(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>')
  obj(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${pw} ${ph}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>`)
  obj(4, `<</Type/XObject/Subtype/Image/Width ${iw}/Height ${ih}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>`, jpeg)
  obj(5, `<</Length ${content.length}>>`, enc.encode(content))
  const xref = len
  let table = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) table += `${String(off[i]).padStart(10, '0')} 00000 n \n`
  push(table)
  push(`trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

/** 交给浏览器/Electron 下载。文件名里的路径分隔符必须剔除,否则 `a/b.png` 会被当成子目录。 */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name.replace(/[\\/:*?"<>|]/g, '_')
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** 完整编辑器视图(文件类型 mount):顶栏切图/源码 + 图内 MindNode 式交互 + 缩放/回中心 + 导出。 */
function mountEditor(el: HTMLElement, filePath: string): () => void {
  el.innerHTML = ''
  injectStyle(el)
  const rootEl = document.createElement('div')
  rootEl.className = 'mmp-root mmp-scope'
  rootEl.tabIndex = 0 // 可聚焦 → 选中态下接键盘(Enter/Tab/Delete/方向键)
  rootEl.innerHTML = `
<div class="mmp-bar">
  <span class="mmp-seg"><button data-mode="map" class="on">导图</button><button data-mode="source">源码</button></span>
  <span class="mmp-hint"></span>
  <span class="mmp-seg mmp-exp"><button data-x="png" title="导出 PNG 图片">PNG</button><button data-x="pdf" title="导出 PDF">PDF</button><button data-x="md" title="导出 Markdown 源文件">MD</button></span>
</div>
<div class="mmp-body">
  <div class="mmp-canvas"></div>
  <div class="mmp-zoom">
    <button data-z="out" title="缩小">−</button>
    <button data-z="reset" class="mmp-pct" title="重置为 100%">100%</button>
    <button data-z="in" title="放大">＋</button>
    <span class="mmp-sep"></span>
    <button data-z="fit" title="回到中心 / 适应全图（⇧1）">⤢</button>
  </div>
</div>`
  el.appendChild(rootEl)
  syncTheme(rootEl) // 先把 --mmp-* 铺上:顶栏在读盘完成前就可见,晚一步会闪一帧无边框/无底色的裸控件
  const body = rootEl.querySelector('.mmp-body') as HTMLElement
  const canvas = rootEl.querySelector('.mmp-canvas') as HTMLElement // 浮动画布(各中心卡片的容器,整体 transform 平移/缩放)
  const zoomBar = rootEl.querySelector('.mmp-zoom') as HTMLElement
  const pctEl = rootEl.querySelector('.mmp-pct') as HTMLElement
  const segBtns = Array.from(rootEl.querySelectorAll('.mmp-seg:not(.mmp-exp) button')) as HTMLButtonElement[]
  const expBar = rootEl.querySelector('.mmp-exp') as HTMLElement
  const hintEl = rootEl.querySelector('.mmp-hint') as HTMLElement | null
  const HINT_EDIT = '单击选中 · 双击改名 · 空白双击 新中心 · 拖标题移中心 · Enter 同级 · Tab 子级 · ⇧Enter 换行 · Delete 删除'
  const HINT_LOCKED = '含二级标题/复杂结构 · 请切「源码」编辑'

  let md = BLANK_MINDMAP // 只含正文(不含 frontmatter),parseOutline/markmap 都吃它
  let positions: Record<string, [number, number]> = {} // 浮动中心画布坐标,键=中心下标(见 splitPositions)
  let fmOther = '' // 用户自带的其它 frontmatter,原样保留回写
  let eol = '\n'
  let mode: 'map' | 'source' = 'map'
  let mms: any[] = [] // 每个中心一个独立 markmap 实例
  let panX = 0, panY = 0, zoom = 1 // 画布变换(取代 markmap 自带 pan/zoom)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let loaded = false // 读到真实内容前绝不写盘(否则读失败/库未就绪会用空白覆盖真文件)
  let saveChain: Promise<void> = Promise.resolve() // 串行化写盘,防并发写乱序
  let selectedPath: number[] | null = null
  let editing = false
  let pendingSelect: number[] | null = null // 编辑中被点下的目标节点,提交后由它接管选中
  let editable = false // 本次渲染是否允许图内编辑(renderCenters 里由初筛 + 差分门禁共同判定)
  let activeFinish: ((action: 'commit') => void) | null = null // 卸载时冲刷未提交的内联编辑(Codex #6)

  const flushSave = (): void => {
    if (!loaded) return
    const snapshot = joinPositions(positions, fmOther, md, eol) // 坐标 + 其它 frontmatter + 正文
    saveChain = saveChain
      .then(() => ctx.app.writeFile(filePath, snapshot))
      .catch(() => ctx.app.notify('思维导图保存失败'))
  }
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushSave()
    }, 500)
  }

  const destroyMms = (): void => {
    for (const m of mms) { try { m?.destroy?.() } catch { /* ignore */ } }
    mms = []
  }

  // ── 选中态(渲染无关的 DOM 装饰;每次重渲后按 selectedPath 重挂) ──
  // path 是**全局** path(tagPaths 已给每个中心的节点打了全局前缀),故跨所有中心 svg 搜。
  const gForPath = (path: number[]): SVGGElement | null => {
    for (const svg of Array.from(body.querySelectorAll('svg.mmp-svg'))) {
      for (const g of Array.from(svg.querySelectorAll('g.markmap-node'))) {
        const p = nodePathOf(g)
        if (p && samePath(p, path)) return g as SVGGElement
      }
    }
    return null
  }
  const clearSelDeco = (): void => body.querySelectorAll('.mmp-sel-rect').forEach((e) => e.remove())
  const applySelDeco = (): void => {
    clearSelDeco()
    if (!selectedPath) return
    const g = gForPath(selectedPath)
    if (!g) return
    // 选中框 = 垫在文字后面的 <rect>,比文字包围盒各方向大 10%(总面积 +20%)。取 foreignObject 的 x/y/w/h
    // (自然坐标,与 viewBox 同系);不受 foreignObject 裁切(它是兄弟节点,不是里面的内容)。
    const fo = g.querySelector('foreignObject')
    if (!fo) return
    const x = parseFloat(fo.getAttribute('x') || '0') || 0
    const y = parseFloat(fo.getAttribute('y') || '0') || 0
    const w = parseFloat(fo.getAttribute('width') || '0') || 0
    const h = parseFloat(fo.getAttribute('height') || '0') || 0
    if (!(w > 0) || !(h > 0)) return
    const px = w * 0.1, py = h * 0.1
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('class', 'mmp-sel-rect')
    rect.setAttribute('x', String(x - px))
    rect.setAttribute('y', String(y - py))
    rect.setAttribute('width', String(w + px * 2))
    rect.setAttribute('height', String(h + py * 2))
    rect.setAttribute('rx', '6')
    g.insertBefore(rect, g.firstChild)
  }
  const select = (path: number[]): void => {
    selectedPath = path
    applySelDeco()
    if (!editing) rootEl.focus()
  }
  const deselect = (): void => {
    selectedPath = null
    clearSelDeco()
  }

  // ── 缩放 / 平移 / 回到中心(画布整体 transform;取代 markmap 自带 pan/zoom) ──
  const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
  const applyCanvasTransform = (): void => { canvas.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})` }
  const syncPct = (): void => { if (pctEl) pctEl.textContent = `${Math.round(zoom * 100)}%` }
  // 各中心卡片在**画布坐标**里的并集包围盒(left/top + 卡片像素尺寸)。
  const contentBBox = (): { minX: number; minY: number; w: number; h: number } | null => {
    const cs = Array.from(canvas.querySelectorAll('.mmp-center')) as HTMLElement[]
    if (!cs.length) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of cs) {
      const x = parseFloat(c.style.left) || 0, y = parseFloat(c.style.top) || 0
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + c.offsetWidth); maxY = Math.max(maxY, y + c.offsetHeight)
    }
    return { minX, minY, w: maxX - minX, h: maxY - minY }
  }
  // 围绕屏幕点 (sx,sy) 缩放,保持该点在画布上不动(按钮取视口中心,滚轮取光标)。
  const zoomAbout = (factor: number, sx: number, sy: number): void => {
    const nz = clamp(zoom * factor, 0.2, 4)
    const f = nz / zoom
    panX = sx - (sx - panX) * f
    panY = sy - (sy - panY) * f
    zoom = nz
    applyCanvasTransform(); syncPct()
  }
  const zoomBy = (k: number): void => zoomAbout(k, body.clientWidth / 2, body.clientHeight / 2)
  const zoomFit = (): void => {
    const bb = contentBBox(); if (!bb) return
    const m = 40
    const z = clamp(Math.min((body.clientWidth - 2 * m) / Math.max(1, bb.w), (body.clientHeight - 2 * m) / Math.max(1, bb.h)), 0.2, 2)
    zoom = z
    panX = (body.clientWidth - bb.w * z) / 2 - bb.minX * z
    panY = (body.clientHeight - bb.h * z) / 2 - bb.minY * z
    applyCanvasTransform(); syncPct()
  }
  const zoomReset = (): void => {
    zoom = 1
    const bb = contentBBox()
    if (bb) { panX = 40 - bb.minX; panY = 40 - bb.minY } else { panX = 0; panY = 0 }
    applyCanvasTransform(); syncPct()
  }
  zoomBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn) return
    e.stopPropagation()
    const z = btn.dataset.z
    if (z === 'in') zoomBy(1.25)
    else if (z === 'out') zoomBy(0.8)
    else if (z === 'reset') zoomReset()
    else if (z === 'fit') zoomFit()
  })
  body.addEventListener('wheel', (e) => {
    if (mode !== 'map') return
    e.preventDefault()
    const br = body.getBoundingClientRect()
    zoomAbout(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - br.left, e.clientY - br.top)
  }, { passive: false })

  // ── 导出 ──
  const baseName = (): string => (filePath.split('/').pop() || '思维导图').replace(/\.mindmap\.md$/i, '') || '思维导图'
  const doExport = async (kind: string): Promise<void> => {
    if (kind === 'md') {
      download(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${baseName()}.md`)
      ctx.app.notify('已导出 Markdown')
      return
    }
    if (mode !== 'map') {
      ctx.app.notify('请先切回「导图」再导出图片')
      return
    }
    const shot = exportComposite(canvas) // 各中心按画布坐标拼成一张(浮动中心各在其位)
    if (!shot) {
      ctx.app.notify('导出失败:导图尚未渲染完成')
      return
    }
    // ⚠️ 背景必须铺**当前主题底色**,PNG 也不例外:暗色主题下文字是浅色,若导出透明底,贴进任何浅色文档/预览器
    //    都是「浅字压白底」= 什么也看不见(实测截图确认,而「不透明像素占比」这类断言看不出来)。
    //    JPEG 更是不支持透明,不铺底会变黑块。
    const bg = getComputedStyle(rootEl).getPropertyValue('--mmp-bg').trim() || '#ffffff'
    const raster = await rasterize(shot.xml, shot.w, shot.h, safeScale(shot.w, shot.h), bg)
    if (disposed) return // 导出期间视图被关掉:别再下载/弹提示(SVG 已同步克隆,不会读到已清理的 DOM)
    if (kind === 'png') {
      const png = await canvasBlob(raster, 'image/png')
      if (disposed) return
      download(png, `${baseName()}.png`)
      ctx.app.notify('已导出 PNG')
      return
    }
    const jpeg = new Uint8Array(await (await canvasBlob(raster, 'image/jpeg', 0.92)).arrayBuffer())
    if (disposed) return
    const pt = (px: number): number => Math.max(1, Math.round(px * 0.75)) // CSS px(96dpi)→ PDF pt(72dpi)
    download(pdfFromJpeg(jpeg, raster.width, raster.height, pt(shot.w), pt(shot.h)), `${baseName()}.pdf`)
    ctx.app.notify('已导出 PDF')
  }
  expBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !loaded) return
    void doExport(btn.dataset.x || '').catch((err: unknown) => {
      console.error('[mindmap] 导出失败', err)
      ctx.app.notify(`导出失败:${err instanceof Error ? err.message : String(err)}`)
    })
  })

  // 模型变更 → 重渲 → 之后定位(编辑新节点 / 选中 / 仅回聚焦)。
  const applyChange = (newMd: string, opts?: { edit?: number[]; select?: number[] }): void => {
    md = newMd
    scheduleSave()
    renderCenters(() => {
      if (opts?.edit) startEdit(opts.edit)
      else if (opts?.select) select(opts.select)
      else rootEl.focus()
    })
  }

  // 就地内联编辑:在节点上覆盖一个无边框 textarea,种子=模型原始文本(保 `**md**` 与多行 `\n`)。结构走键盘。
  function startEdit(path: number[]): void {
    if (disposed || mode !== 'map' || !editable) return
    body.querySelectorAll('.mmp-inline,.mmp-gauge').forEach((e) => e.remove())
    const node = nodeAtPath(parseOutline(md).root, path)
    if (!node || node.line < 0) return // 虚拟根没有源码行,不可改名
    const isHeading = node.level === 0 || node.heading // 中心标题恒单行(markdown 里标题就是单行)
    const g = gForPath(path)
    const cdiv = g && contentDivOf(g)
    if (!cdiv) return
    editing = true
    selectedPath = path
    applySelDeco()
    const cr = cdiv.getBoundingClientRect()
    const br = body.getBoundingClientRect()
    const scale = cdiv.offsetHeight ? cr.height / cdiv.offsetHeight : 1
    const fs = Math.max(11, Math.round((parseFloat(getComputedStyle(cdiv).fontSize) || 14) * scale))
    const left = Math.max(0, cr.left - br.left)
    const ta = document.createElement('textarea')
    ta.className = 'mmp-inline'
    ta.value = node.text
    ta.spellcheck = false
    ta.rows = 1
    ta.style.left = `${left}px`
    ta.style.top = `${Math.max(0, cr.top - br.top)}px`
    ta.style.fontSize = `${fs}px`
    body.appendChild(ta)
    // 尺寸跟随文字:同字体隐藏量尺测实际多行文本盒(textarea 无 fit-content;量尺 white-space:pre 支持多行)。
    const gauge = document.createElement('span')
    gauge.className = 'mmp-gauge'
    // 量尺必须与 textarea **字宽度量完全一致**:只抄 family/size/weight 不够,宿主若设了
    // font-stretch / 连字 / 字距 / text-transform,glyph advance 就不同,量出来会偏(Codex)。
    const ics = getComputedStyle(ta)
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontKerning',
      'fontFeatureSettings', 'fontVariationSettings', 'fontVariantLigatures', 'letterSpacing', 'wordSpacing',
      'textTransform', 'lineHeight'] as const) gauge.style[p] = ics[p]
    body.appendChild(gauge)
    const fitSize = (): void => {
      gauge.textContent = ta.value || ' '
      const gr = gauge.getBoundingClientRect()
      const avail = Math.max(48, body.clientWidth - left - 8) // 别顶出画布
      ta.style.width = `${Math.min(Math.max(Math.ceil(gr.width) + 14, 40), avail)}px`
      ta.style.height = `${Math.max(20, Math.ceil(gr.height) + 4)}px`
    }
    fitSize()
    ta.addEventListener('input', fitSize)
    ta.focus()
    ta.select()

    const orig = node.text
    let done = false
    const finish = (action: 'sibling' | 'child' | 'commit'): void => {
      if (done) return
      done = true
      activeFinish = null
      const text = ta.value
      ta.remove()
      gauge.remove()
      editing = false
      // 空文本不参与结构操作:否则会把 `- ` 空 bullet 写进源码,isSimpleOutline 随即判 false,图内编辑彻底锁死(Codex #2)。
      const act = action !== 'commit' && text.trim() === '' ? 'commit' : action
      if (act === 'sibling') {
        const r = addSibling(renameNode(md, path, text), path)
        applyChange(r.md, { edit: r.path })
      } else if (act === 'child') {
        const r = addChild(renameNode(md, path, text), path)
        applyChange(r.md, { edit: r.path })
      } else {
        // 编辑中点了别的节点 → 那个才是用户想选的,别把选中拽回原节点。
        const target = pendingSelect
        pendingSelect = null
        if (text === orig) { select(target || path); return } // 无改动不重渲,避免点开又点走时无谓抖动
        const isLeaf = !(nodeAtPath(parseOutline(md).root, path)?.children?.length)
        if (text.trim() === '' && isLeaf && path.length > 0) {
          deselect() // 删掉后旧 path 会指向「顶上来」的邻居,不清会选错/删错(Codex #3)
          applyChange(deleteNode(md, path))
        } else applyChange(renameNode(md, path, text), { select: target || path })
      }
    }
    activeFinish = finish
    // ⚠️ 输入法组合期间一概不接管按键:中文拼音选词就是按 Enter,此时 keydown 的 key 也是 'Enter'
    // (带 isComposing=true / keyCode 229)。不挡的话「选词」会被当成「提交并新建同级节点」,中文根本没法打。
    // Escape 同理(取消候选)。compositionend 后补一次量尺,组合期间的预编辑文字长度已经变过。
    let composing = false
    ta.addEventListener('compositionstart', () => { composing = true })
    ta.addEventListener('compositionend', () => { composing = false; fitSize() })
    ta.addEventListener('keydown', (e) => {
      if (composing || e.isComposing || (e as KeyboardEvent).keyCode === 229) return
      if (e.key === 'Enter' && e.shiftKey) {
        // Shift+Enter = 节点内换行(1.5.0)。标题恒单行 → 挡掉;bullet 放行默认插入换行,插完再量尺寸。
        if (isHeading) { e.preventDefault() } else { setTimeout(fitSize, 0) }
      } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('sibling') }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); finish(e.shiftKey ? 'commit' : 'child') }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('commit') }
    })
    ta.addEventListener('blur', () => finish('commit'))
  }

  // 方向键:按屏幕几何选视觉方向上最近的节点(简单锥形启发:沿向量为正 + 正交距离惩罚)。
  // ponytail: 朴素 O(n) 扫描,几十节点足够;真要大图再上空间索引。
  function navigate(key: string): void {
    if (!selectedPath) return
    // 跨所有中心按屏幕几何找最近节点 → 方向键可在中心之间跳转。
    const items: { p: number[]; cx: number; cy: number }[] = []
    for (const svg of Array.from(body.querySelectorAll('svg.mmp-svg'))) {
      for (const g of Array.from(svg.querySelectorAll('g.markmap-node'))) {
        const p = nodePathOf(g)
        const d = contentDivOf(g)
        if (!p || !d) continue
        const r = d.getBoundingClientRect()
        items.push({ p, cx: r.left + r.width / 2, cy: r.top + r.height / 2 })
      }
    }
    const cur = items.find((it) => samePath(it.p, selectedPath!))
    if (!cur) return
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const d = dir[key]
    let best: { p: number[] } | null = null
    let bs = Infinity
    for (const it of items) {
      if (it === cur) continue
      const dx = it.cx - cur.cx
      const dy = it.cy - cur.cy
      const along = dx * d[0] + dy * d[1]
      if (along <= 2) continue // 必须在该方向前方
      const perp = Math.abs(dx * d[1] - dy * d[0])
      const score = along + perp * 3
      if (score < bs) { bs = score; best = it }
    }
    if (best) select(best.p)
  }

  rootEl.addEventListener('keydown', (e) => {
    if (editing) return
    // 文本输入里绝不抢键(源码模式按 Shift+1 是要打「!」,不是适应全图)。
    const tgt = e.target as HTMLElement | null
    const typing = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
    // 缩放快捷键先于选中态(不需要选中也能用),但只在导图模式且实例就绪时接管
    if (!typing && mode === 'map' && mms.length) {
      if (e.shiftKey && (e.key === '1' || e.key === '!')) { e.preventDefault(); zoomFit(); return }
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.25); return }
        if (e.key === '-') { e.preventDefault(); zoomBy(0.8); return }
        if (e.key === '0') { e.preventDefault(); zoomReset(); return }
      }
    }
    if (typing || mode !== 'map' || !selectedPath || !editable) return
    switch (e.key) {
      case 'Enter': { e.preventDefault(); const r = addSibling(md, selectedPath); applyChange(r.md, { edit: r.path }); break }
      case 'Tab': { e.preventDefault(); const r = addChild(md, selectedPath); applyChange(r.md, { edit: r.path }); break }
      case 'Delete': case 'Backspace': {
        e.preventDefault()
        if (selectedPath.length > 0) { const p = selectedPath; deselect(); applyChange(deleteNode(md, p)) }
        break
      }
      case 'F2': e.preventDefault(); startEdit(selectedPath); break
      case 'Escape': e.preventDefault(); deselect(); break
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': e.preventDefault(); navigate(e.key); break
      default: break
    }
  })

  // 节点交互用**事件委托**挂在 body 上(只挂一次):markmap 是异步布局 + 每次改动整图重建,
  // 逐节点挂监听既会因时序扑空(节点还没画出来)、又要每次重挂。委托对时序免疫。
  // 选中走 pointerdown 而非 click:编辑中点别的节点时,pointerdown 先于 input 的 blur/重渲,
  // 否则那一下点击会被「提交→重建 SVG」吃掉(Codex #7)。
  // ⚠️ 两个监听都走**捕获阶段**:markmap 自己在 foreignObject 上绑了 mousedown/dblclick 且阻止冒泡(挡 d3-zoom 的
  // 双击缩放),冒泡阶段的委托收不到双击(实测:单击能中是因为它没绑 pointerdown)。捕获先于目标handler,不受影响。
  // 折叠圈(markmap 的 <circle>)也在 g.markmap-node 里 —— 点它是「折叠/展开」,不该顺带选中/进编辑。
  const isFoldCircle = (t: Element): boolean => t.tagName.toLowerCase() === 'circle' || !!t.closest('circle')
  // 通用拖拽:超过 4px 阈值才算拖(否则当点击),窗口级捕获 pointermove/up。onMove 收到自起点的累计位移。
  const beginDrag = (e: PointerEvent, onMove: (dx: number, dy: number) => void, onUp: (moved: boolean) => void): void => {
    const sx = e.clientX, sy = e.clientY
    let moved = false
    const mv = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      onMove(dx, dy)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', mv, true)
      window.removeEventListener('pointerup', up, true)
      onUp(moved)
    }
    window.addEventListener('pointermove', mv, true)
    window.addEventListener('pointerup', up, true)
  }
  // 屏幕坐标 → 画布坐标(去掉平移/缩放)。
  const toCanvas = (clientX: number, clientY: number): [number, number] => {
    const br = body.getBoundingClientRect()
    return [(clientX - br.left - panX) / zoom, (clientY - br.top - panY) / zoom]
  }
  body.addEventListener('pointerdown', (e) => {
    const t = e.target as Element | null
    if (!t || t.closest('.mmp-zoom') || t.closest('.mmp-inline') || isFoldCircle(t)) return
    const g = t.closest('g.markmap-node')
    if (!g) {
      // 空白:导图模式下拖动 = 平移画布;无位移的点击 = 退选。
      if (mode !== 'map' || editing) return
      const px0 = panX, py0 = panY
      beginDrag(e, (dx, dy) => { panX = px0 + dx; panY = py0 + dy; applyCanvasTransform() }, (moved) => { if (!moved) deselect() })
      return
    }
    const p = nodePathOf(g)
    if (!p || !editable) return
    // 编辑中点别的节点:此刻记为「待选」,由随后 blur 的 finish 决定最终选中 —— 否则 finish 会把选中又拽回原节点。
    if (editing) { pendingSelect = p; return }
    // 浮动中心的标题(H1,path 长度 1、下标 ≥1)= 拖动把手 → 拖整张卡片;无位移则当作选中。
    const centerEl = t.closest('.mmp-center') as HTMLElement | null
    const ci = centerEl ? Number(centerEl.dataset.center) : -1
    if (centerEl && ci >= 1 && p.length === 1) {
      const cx0 = parseFloat(centerEl.style.left) || 0
      const cy0 = parseFloat(centerEl.style.top) || 0
      let cx = cx0, cy = cy0
      beginDrag(e, (dx, dy) => {
        cx = cx0 + dx / zoom; cy = cy0 + dy / zoom
        centerEl.style.left = `${cx}px`; centerEl.style.top = `${cy}px`
      }, (moved) => {
        if (moved) { positions[ci] = [Math.round(cx), Math.round(cy)]; scheduleSave() } else select(p)
      })
      return
    }
    select(p)
  }, true)
  body.addEventListener('dblclick', (e) => {
    const t = e.target as Element | null
    if (!t || t.closest('.mmp-zoom') || isFoldCircle(t)) return
    const g = t.closest('g.markmap-node')
    if (!g) {
      // 画布空白双击 = 新建一个**独立浮动中心**(markdown 里新起一个 `# 段`),落在双击处(画布坐标)。
      if (mode !== 'map' || !editable) return
      e.preventDefault()
      e.stopPropagation()
      const [cx, cy] = toCanvas(e.clientX, e.clientY)
      const r = addRootNode(md)
      positions[r.path[0]] = [Math.round(cx), Math.round(cy)] // 新中心停在鼠标处
      applyChange(r.md, { edit: r.path })
      return
    }
    const p = nodePathOf(g)
    if (!p) return
    e.preventDefault()
    e.stopPropagation() // 顺带吃掉 markmap 的双击缩放:这里双击=改名
    startEdit(p)
  }, true)

  const anchorFor = (i: number): [number, number] => {
    if (i === 0) return [40, 40] // 主中心锚点固定(默认中心 = 最初的中心)
    const p = positions[i]
    if (Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0], p[1]]
    return [420, 40 + (i - 1) * 200] // 没存过坐标的浮动中心:自动错位,别叠在主中心上
  }
  // 渲染后把每个中心的 svg 缩到内容包围盒(1:1),让卡片贴合树、互不重叠。
  const fitSvgToContent = (svg: SVGSVGElement): void => {
    const g = svg.querySelector('g') as SVGGraphicsElement | null
    if (!g) return
    let bb: DOMRect
    try { bb = g.getBBox() } catch { return }
    if (!(bb.width > 0) || !(bb.height > 0)) return
    const pad = 6
    g.removeAttribute('transform') // 取消 markmap 的居中变换,按自然坐标 1:1 呈现(viewBox 框定)
    const w = Math.ceil(bb.width + pad * 2), h = Math.ceil(bb.height + pad * 2)
    svg.setAttribute('viewBox', `${bb.x - pad} ${bb.y - pad} ${w} ${h}`)
    svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h))
    svg.style.width = `${w}px`; svg.style.height = `${h}px`
  }
  // 等所有中心布局都稳(各自 whenLayoutReady)再统一收尾。
  const whenAllReady = (svgs: SVGSVGElement[], cb: () => void): void => {
    let n = svgs.length
    if (!n) { cb(); return }
    svgs.forEach((svg) => whenLayoutReady(svg, () => { if (--n === 0) cb() }))
  }

  let firstFit = true // 首帧渲染完适应全图一次(之后编辑不再乱动视角)
  // 每个 `#` 中心一个**独立** markmap 实例,绝对定位在浮动画布上;无中枢连线、可各自拖动。
  const renderCenters = (after?: () => void): void => {
    if (disposed) return
    destroyMms()
    canvas.querySelectorAll('.mmp-center').forEach((e) => e.remove())
    body.querySelectorAll('.mmp-inline,.mmp-gauge').forEach((e) => e.remove())
    applyCanvasTransform()
    // 权威门禁:用整份 md 的 transformer 树证明与模型树同构(isSimpleOutline 初筛 + treesAligned 权威,多中心已支持)。
    let wholeRoot: any
    try { wholeRoot = transformer.transform(md || BLANK_MINDMAP).root } catch { wholeRoot = transformer.transform(BLANK_MINDMAP).root }
    editable = isSimpleOutline(md) && treesAligned(wholeRoot, md)
    if (hintEl) hintEl.textContent = editable ? HINT_EDIT : HINT_LOCKED
    if (!editable) { selectedPath = null; editing = false }
    // 重渲后旧 path 可能已不存在(删除/结构变化)→ 清掉,免得装饰或 Delete 落到别的节点上。
    if (selectedPath && !nodeAtPath(parseOutline(md).root, selectedPath)) selectedPath = null
    const virtual = parseOutline(md).root.virtual
    let segs = splitCenters(md)
    if (!segs.length) segs = [md || BLANK_MINDMAP] // 无 H1 兜底:整份当一个中心
    const svgs: SVGSVGElement[] = []
    segs.forEach((seg: string, i: number) => {
      const centerEl = document.createElement('div')
      centerEl.className = 'mmp-center' + (i > 0 ? ' mmp-float' : '')
      centerEl.dataset.center = String(i)
      const [ax, ay] = anchorFor(i)
      centerEl.style.left = `${ax}px`; centerEl.style.top = `${ay}px`
      const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
      svg.classList.add('mmp-svg')
      // 临时视口;稳定后 fitSvgToContent 缩到内容。显式像素尺寸:销毁后已排程的异步读取不至于抛「Could not resolve relative length」。
      svg.setAttribute('width', '800'); svg.setAttribute('height', '600')
      centerEl.appendChild(svg)
      canvas.appendChild(centerEl)
      let root: any
      try { root = transformer.transform(seg).root } catch { root = transformer.transform('# ?\n').root }
      tagPaths(root, virtual ? [i] : []) // 打**全局** path 前缀 → nodePathOf 直接给全局 path,复用全部交互/模型操作
      mms.push(Markmap.create(svg, MAP_OPTS_CENTER, root))
      svgs.push(svg)
    })
    syncTheme(rootEl)
    whenAllReady(svgs, () => {
      if (disposed) return
      svgs.forEach(fitSvgToContent)
      applySelDeco()
      if (firstFit) { firstFit = false; zoomFit() }
      syncPct()
      after?.()
    })
  }

  const renderSource = (): void => {
    destroyMms()
    canvas.querySelectorAll('.mmp-center').forEach((e) => e.remove())
    body.querySelectorAll('.mmp-inline,.mmp-gauge').forEach((e) => e.remove())
    // ⚠️ 必须先清掉已有 textarea:慢读取期间点「源码」会先建一个空白 textarea,读完 render() 再建第二个,
    // 空白那个盖在上面继续输入 → 把刚读到的原文覆盖掉(毁档)。
    body.querySelectorAll('.mmp-src').forEach((e) => e.remove())
    const ta = document.createElement('textarea')
    ta.className = 'mmp-src'
    ta.value = md
    ta.spellcheck = false
    ta.addEventListener('input', () => {
      md = ta.value
      scheduleSave()
    })
    body.insertBefore(ta, zoomBar)
    ta.focus()
  }

  const render = (): void => {
    zoomBar.style.display = mode === 'map' ? '' : 'none'
    canvas.style.display = mode === 'map' ? '' : 'none'
    if (mode === 'map') renderCenters(); else renderSource()
  }

  const setMode = (m: 'map' | 'source'): void => {
    if (m === mode) return
    body.querySelector('.mmp-src')?.remove()
    mode = m
    editing = false
    deselect()
    segBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === m))
    render()
  }
  segBtns.forEach((b) => b.addEventListener('click', () => { if (loaded) setMode(b.dataset.mode as 'map' | 'source') }))

  const stopTheme = observeTheme(rootEl)

  void (async () => {
    const text = await ctx.app.readFile(filePath)
    if (disposed) return
    if (text == null) {
      // 读不到(库未就绪 / 文件缺失 / 越界):不 seed 空白、不允许写,显示错误态,别用空白覆盖真文件。
      body.innerHTML = '<div class="mmp-missing">无法读取此思维导图(库可能未就绪),请重新打开该文件。</div>'
      return
    }
    // 拆出浮动中心坐标 + 用户自带 frontmatter,正文(不含 frontmatter)才交给 parseOutline/markmap。
    const sp = splitPositions(text)
    md = sp.body
    positions = sp.positions as Record<string, [number, number]>
    fmOther = sp.fmOther
    eol = sp.eol
    loaded = true
    render()
  })()

  return () => {
    // 先置 disposed:activeFinish 内部会 applyChange→renderCenters,卸载中没必要(也不该)再重建一次 SVG/Markmap。
    // renderCenters 开头的 disposed 守卫会挡住重渲,但 md 已提交、scheduleSave 已排队 → 输入不丢。
    disposed = true
    activeFinish?.('commit')
    stopTheme()
    if (saveTimer) clearTimeout(saveTimer)
    flushSave() // 卸载即冲刷未落盘的改动(串行 + loaded 守卫)
    destroyMms()
  }
}

/** 解析嵌入 target 并读取:含 `/` 视为 vault 相对完整路径;否则先试所在笔记同目录的兄弟,再试 vault 根。 */
async function readEmbedTarget(target: string, pagePath: string): Promise<string | null> {
  const t = target.trim()
  const candidates: string[] = []
  if (t.includes('/')) {
    candidates.push(t)
  } else {
    const p = (pagePath || '').replace(/\\/g, '/')
    const slash = p.lastIndexOf('/')
    if (slash >= 0) candidates.push(`${p.slice(0, slash)}/${t}`)
    candidates.push(t)
  }
  for (const c of candidates) {
    const x = await ctx.app.readFile(c)
    if (x != null) return x
  }
  return null
}

/** 嵌入块(`![[x.mindmap.md]]`):只读渲染,不可编辑/缩放。 */
function mountEmbed(el: HTMLElement, target: string, pagePath: string): () => void {
  el.innerHTML = ''
  injectStyle(el)
  const box = document.createElement('div')
  box.className = 'mmp-embed mmp-scope'
  el.appendChild(box)
  let mm: any = null
  let disposed = false
  const stopTheme = observeTheme(box) // 嵌入块同样要跟宿主切主题(只 syncTheme 一次会停在旧主题,Codex)
  void (async () => {
    const text = await readEmbedTarget(target, pagePath)
    if (disposed) return
    if (text == null) {
      box.innerHTML = `<div class="mmp-missing">思维导图缺失：${escapeHtml(target)}</div>`
      return
    }
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
    svg.classList.add('mmp-svg')
    // 同 renderMap:补显式像素尺寸,否则销毁后已排程的异步 fit() 读百分比长度会抛 Could not resolve relative length。
    svg.setAttribute('width', String(Math.max(1, box.clientWidth || 800)))
    svg.setAttribute('height', String(Math.max(1, box.clientHeight || 340)))
    box.appendChild(svg)
    try {
      // 剥掉 frontmatter(浮动中心坐标)再渲染;嵌入是只读缩略图,多中心按 markmap 原生(连中枢)呈现即可,
      // ponytail: 不在只读预览里复刻浮动画布布局。
      const outline = splitPositions(text).body
      mm = Markmap.create(svg, { ...MAP_OPTS, zoom: false, pan: false }, transformer.transform(outline).root)
      syncTheme(box) // 嵌入块同样要跟宿主深浅色
    } catch {
      box.innerHTML = `<div class="mmp-missing">思维导图解析失败：${escapeHtml(target)}</div>`
    }
  })()
  return () => {
    disposed = true
    stopTheme()
    try {
      mm?.destroy?.()
    } catch {
      /* ignore */
    }
  }
}

// 「探测重名 → 写盘」不是原子操作:两次新建若交错,双方都可能先读到「不存在」再写同一个路径,
// 结果是一个文件配两个嵌入(Codex)。宿主的 writeFile 是覆盖语义,没有 O_EXCL 排他创建。
// ponytail: 先在本渲染进程内串行化,现实中的连点/慢盘由此覆盖;**跨窗口仍无保证**,
// 真正的修法是宿主提供 `createTextFile(path, text, { exclusive: true })`(底层 open 'wx'),已记入待办。
let createChain: Promise<unknown> = Promise.resolve()

/** 在 parentFolder(''=库根)建一份空白 `思维导图.mindmap.md`(重名加序号),返回它的库相对路径。
 *  失败一律抛 —— 三个入口(右键新建 / 命令面板 / 斜杠块)各自兜底提示,别在这里吞掉。 */
function newMindmapAt(parentFolder = ''): Promise<string> {
  const run = createChain.then(() => newMindmapAtUnsafe(parentFolder))
  createChain = run.catch(() => undefined) // 链条不能被一次失败掐断
  return run
}

async function newMindmapAtUnsafe(parentFolder = ''): Promise<string> {
  const dir = parentFolder ? `${parentFolder.replace(/\/+$/, '')}/` : ''
  let path = `${dir}思维导图.mindmap.md`
  // 每个候选先探测存在性再采用(readFile==null 才停),避免 off-by-one 覆盖既有文件。
  for (let n = 2; (await ctx.app.readFile(path)) != null; n++) {
    if (n > 999) throw new Error('同名思维导图太多,请先整理')
    path = `${dir}思维导图 ${n}.mindmap.md`
  }
  await ctx.app.writeFile(path, BLANK_MINDMAP) // 宿主写盘会 mkdir -p,父文件夹(如笔记的 .fd)不存在也没关系
  return path
}

/** 新建思维导图并打开(右键菜单 / 命令面板入口)。 */
async function createMindmap(parentFolder = ''): Promise<void> {
  ctx.app.openFile(await newMindmapAt(parentFolder))
}

ctx.registerFileType({
  id: 'mindmap',
  extensions: ['.mindmap.md'],
  icon: '🧠',
  title: '思维导图',
  mount: (el: HTMLElement, file: { filePath: string }) => mountEditor(el, file.filePath),
})

ctx.registerEmbedRenderer({
  id: 'mindmap',
  match: (t: string) => /\.mindmap\.md$/i.test(t),
  mount: (el: HTMLElement, embed: { target: string; pagePath: string }) => mountEmbed(el, embed.target, embed.pagePath),
})

// 右键菜单「新建思维导图」(文件树空白处/文件夹上),和内置 新建笔记/白板 并列 —— 生态 seam。
// 返回 Promise:宿主 await 得到失败才能提示用户(否则 rejection 只进全局兜底,菜单一关就静默失败,Codex #4)。
registerOptional('registerFileCreator', {
  id: 'mindmap',
  label: '新建思维导图',
  icon: '🧠',
  run: (parentFolder: string) => createMindmap(parentFolder),
})

// 笔记里打 `/` 的块菜单(和内置「数据库 / 画板」并列):选中即在本笔记的 .fd 子文件夹新建一份思维导图,
// 并在光标处插入 `![[…]]` 嵌入块 —— 所以是「新建 + 就地嵌入」,不是插一段静态文本。
// 用库相对完整路径而非裸文件名:笔记在哪个目录都能解析到(裸名要靠宿主的同名解析规则)。
registerOptional('registerSlashItem', {
  id: 'mindmap',
  label: '思维导图',
  hint: '.mindmap.md',
  icon: '🧠',
  group: '高级', // 与内置 数据库/画板 同组:它们是同一类「新建文件 + 嵌入」的块
  keywords: 'mindmap 思维导图 导图 daotu 脑图 naotu markmap xmind 嵌入 qianru',
  run: async ({ folder }: { pagePath: string; folder: string }) => `![[${await newMindmapAt(folder)}]]`,
})

// 命令面板入口保留(Cmd/Ctrl+K)。
// 宿主的命令接口只同步调用 run(),它的 try/catch 抓不到 promise rejection → 必须自己兜,否则新建失败静默。
ctx.registerCommand({
  id: 'mindmap-new',
  title: '思维导图:新建',
  keywords: 'mindmap 思维导图 导图 daotu new 新建',
  run: () => void createMindmap().catch((e: unknown) => ctx.app.notify(`新建思维导图失败:${e instanceof Error ? e.message : String(e)}`)),
})
