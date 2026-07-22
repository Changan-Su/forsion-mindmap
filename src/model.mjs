// 思维导图的纯数据模型:markdown 大纲(单个 # 根 + 2 空格缩进的嵌套 - 列表)⇄ 节点树,以及
// 图内编辑的结构操作(改名 / 加子 / 加同级 / 删除)。全部是**纯字符串/行**操作,不碰 DOM/markmap
// —— 这样 check.mjs 能在 node 里完整验证(markmap 的 SVG 渲染只能桌面手验)。
//
// 约定:节点用 path 定位 = 从根到该节点的「第几个孩子」下标数组。根 = []、其一级孩子 = [0]/[1]…,
// 与 markmap 的源序遍历一致(两边都自上而下读同一份 markdown),故 SVG 节点可按同序 path 反查本模型。

/** 文档的缩进方言。markdown 的列表嵌套其实看父项内容偏移(marker 宽 + 后随空格),不是全局固定单位;
 *  但本插件把图内编辑严格限定在 marker 恰为 `- ` 的安全子集内,此时纯 2 空格 / 纯 4 空格 / 纯 tab 三种
 *  规范序列与 markmap 建树一致(Codex 用 markmap 0.18.12 每种跑 550 组序列实测无差异)。
 *  混用 tab+空格、单位不是 2/4、缩进非单位整数倍 → 'unsupported'(退源码,宁可少放行也不改错行)。
 *  无任何正缩进时无从推断 → 固定 spaces-2,否则下次 addChild 的缩进会随文档内容漂移。 */
export function detectDialect(md) {
  const prefixes = []
  for (const ln of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^([ \t]*)- \S/.exec(ln)
    if (m) prefixes.push(m[1])
  }
  if (!prefixes.length) return 'spaces-2'
  const anyTab = prefixes.some((p) => p.includes('\t'))
  const anySpace = prefixes.some((p) => p.includes(' '))
  if (anyTab && anySpace) return 'unsupported' // tab 按列对齐,和空格混用会与 markdown-it 分歧
  if (anyTab) return 'tabs'
  const widths = prefixes.map((p) => p.length).filter((n) => n > 0)
  if (!widths.length) return 'spaces-2'
  const unit = Math.min(...widths)
  if (unit !== 2 && unit !== 4) return 'unsupported'
  if (widths.some((w) => w % unit !== 0)) return 'unsupported'
  return unit === 2 ? 'spaces-2' : 'spaces-4'
}

const unitOf = (dialect) => (dialect === 'tabs' ? '\t' : dialect === 'spaces-4' ? '    ' : '  ')
/** 缩进前缀 → 层级(0 起)。 */
const levelOfPrefix = (prefix, dialect) =>
  dialect === 'tabs' ? prefix.length : Math.floor(prefix.length / (dialect === 'spaces-4' ? 4 : 2))

/** HTML 转义(用户文本进 DOM 前必用;check.mjs 断言拦 `<img src=x>` 这类)。 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** 新建文件的空白模板。 */
export const BLANK_MINDMAP = '# 新思维导图\n\n- 分支一\n- 分支二\n'

const oneLine = (s) => String(s).replace(/\r?\n/g, ' ').trim()

/** 原文的主换行符。解析一律先正规化成 `\n`,但**回写时必须用回原来的** —— 否则在 Windows 写的文件上
 *  改一个节点会把整份文件的换行风格换掉(整文件 diff)。 */
const eolOf = (md) => (/\r\n/.test(String(md)) ? '\r\n' : '\n')
const joinLines = (lines, md) => lines.join(eolOf(md))

/** 解析大纲 → { lines, root }。root/每节点带:text、level(根=0)、line(源行号)、children、path,
 *  H1 节点另带 heading:true。
 *
 *  **多中心**:文档有 ≥2 个 H1 时,markmap 会造一个空内容的虚拟根、把各 H1 挂成它的孩子(实测 payload.lines
 *  为 undefined)。本模型照此对齐:root.virtual=true、root.line=-1、每个 H1 = level 1 的孩子,其 bullet 从
 *  level 2 起。恰好 1 个 H1 时 root 就是那个 H1(与 markmap 一致)。没有 H1 时 root 是无内容虚拟根(图内编辑
 *  门禁本来就不放行,但 addChild 到根仍可加顶层 bullet)。 */
export function parseOutline(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const dialect = detectDialect(md)
  const h1s = []
  for (let i = 0; i < lines.length; i++) if (/^#\s+/.test(lines[i])) h1s.push(i)
  const multi = h1s.length > 1
  const root = { text: '', level: 0, line: -1, endLine: -1, children: [], path: [], indent: '', heading: false, virtual: multi }
  let from = 0
  if (!multi && h1s.length === 1) {
    root.text = lines[h1s[0]].match(/^#\s+(.*)$/)[1]
    root.line = h1s[0]
    root.endLine = h1s[0]
    root.heading = true
    from = h1s[0] + 1
  }
  const base = multi ? 2 : 1 // 多中心时 H1 占了 level 1,bullet 整体下沉一层
  const stack = [root]
  for (let j = from; j < lines.length; j++) {
    if (multi) {
      const hm = lines[j].match(/^#\s+(.*)$/)
      if (hm) {
        const node = { text: hm[1], level: 1, line: j, endLine: j, children: [], indent: '', heading: true, path: [root.children.length] }
        root.children.push(node)
        stack.length = 1
        stack.push(node)
        continue
      }
    }
    const bm = lines[j].match(/^([ \t]*)-\s+(.*)$/)
    if (!bm) {
      // 续行(多行节点):归属栈顶 bullet —— 恰好缩进到它的内容列(`indent + 2`,marker 宽)、非空、
      // 且不是 bullet/有序列表标记。markmap 把这类续行渲成节点内 `<br>`(即便 html:false),故它属于该节点的
      // 文本而非新节点;treesAligned 只比节点数与起始行,续行不新增节点,门禁不受影响。其它非匹配行照旧忽略。
      const top = stack[stack.length - 1]
      if (top && !top.heading && top.level > 0) {
        const cp = top.indent + '  '
        const rest = lines[j].startsWith(cp) ? lines[j].slice(cp.length) : null
        if (rest && !/^\s/.test(rest) && !/^([-+*] |\d+[.)] )/.test(rest)) {
          top.text += '\n' + rest
          top.endLine = j
        }
      }
      continue
    }
    const level = levelOfPrefix(bm[1], dialect) + base
    const node = { text: bm[2], level, line: j, endLine: j, children: [], indent: bm[1], heading: false }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1] || root
    node.path = [...parent.path, parent.children.length]
    parent.children.push(node)
    stack.push(node)
  }
  return { lines, root }
}

/** 按 path 取节点(path=[] 即根);越界返回 null。 */
export function nodeAtPath(root, path) {
  let n = root
  for (const idx of path) {
    if (!n.children[idx]) return null
    n = n.children[idx]
  }
  return n
}

/** 节点子树的最后一行(= 该节点自身多行文本的末行及其所有后代里最大的源行号)。 */
function lastLine(node) {
  let last = node.endLine ?? node.line
  for (const c of node.children) last = Math.max(last, lastLine(c))
  return last
}

/** 按「给定的原始缩进前缀」生成 bullet 行 —— 不按 level×unit 重建,避免把用户原有缩进风格悄悄规范化。 */
const bulletAt = (indent, text) => `${indent}- ${oneLine(text)}`

/** 新子节点该用的缩进:已有孩子就跟第一个孩子对齐;否则父缩进 + 本文档方言的一级增量。
 *  根 / H1 节点的孩子都是顶层 bullet(无缩进)。 */
function childIndentOf(node, dialect) {
  if (node.children.length) return node.children[0].indent
  return node.level === 0 || node.heading ? '' : node.indent + unitOf(dialect)
}

/** 新增一个**独立中心节点**(= 文末追加一段 `# 文本`)。1 个 H1 的文档加完变成多中心(虚拟根 + 两个中心),
 *  这正是 markmap 对多 H1 的原生建树方式,故无需别的表示法。返回 { md, path:新中心 path }。
 *  前置空行:ATX 标题虽不强制,但紧跟在列表行后容易被当成列表的懒续行,留一行最稳妥。 */
export function addRootNode(md, text = '新中心') {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const at = lines.length + 1 // 追加 '' 之后,`# text` 落在这一行
  lines.push('', `# ${oneLine(text)}`, '')
  const out = joinLines(lines, md)
  const { root } = parseOutline(out)
  const idx = root.children.findIndex((c) => c.line === at)
  return { md: out, path: idx >= 0 ? [idx] : [] }
}

/** 改名:替换该节点占的**整段源码行**(单行或多行)。返回新 markdown。
 *  H1 是标题、markdown 里恒为单行 → 换行折叠成空格;bullet 支持多行:首行 `- 第一行`,续行缩进到内容列。
 *  空续行会终止列表项段落(毁掉归属)→ 一律丢弃,节点文本不含空行。 */
export function renameNode(md, path, newText) {
  const { lines, root } = parseOutline(md)
  const node = nodeAtPath(root, path)
  if (!node || node.line < 0) return md
  const span = (node.endLine ?? node.line) - node.line + 1
  if (node.level === 0 || node.heading) {
    lines.splice(node.line, span, `# ${oneLine(newText)}`)
  } else {
    const parts = String(newText).replace(/\r\n?/g, '\n').split('\n').map((p) => p.trim())
    const first = bulletAt(node.indent, parts[0] || '')
    const cont = parts.slice(1).filter((p) => p !== '').map((p) => `${node.indent}  ${p}`)
    lines.splice(node.line, span, first, ...cont)
  }
  return joinLines(lines, md)
}

/** 加子节点(追加为最后一个孩子,插在该节点整棵子树之后)。返回 { md, path:新子节点 path }。
 *  虚拟根(多中心)的「孩子」是各中心 → 转为新增中心节点。
 *  根即便缺 H1(line<0)也可加:插一个顶层 bullet(honor parseOutline 的「无 H1 仍可 addChild」)。 */
export function addChild(md, path, text = '新节点') {
  const { lines, root } = parseOutline(md)
  const node = nodeAtPath(root, path)
  if (!node) return { md, path }
  if (node === root && root.virtual) return addRootNode(md, text)
  if (node.line < 0 && path.length > 0) return { md, path } // 非根缺行才拒
  const insertAt = lastLine(node) + 1
  lines.splice(insertAt, 0, bulletAt(childIndentOf(node, detectDialect(md)), text))
  return { md: joinLines(lines, md), path: [...path, node.children.length] }
}

/** 加同级节点(插在该节点整棵子树之后,同缩进)。H1 的同级 = 另一个中心节点;根无同级 → 退化为加子节点。 */
export function addSibling(md, path, text = '新节点') {
  if (path.length === 0) return addChild(md, [], text)
  const { lines, root } = parseOutline(md)
  const node = nodeAtPath(root, path)
  if (!node || node.line < 0) return { md, path }
  if (node.heading) return addRootNode(md, text)
  const insertAt = lastLine(node) + 1
  lines.splice(insertAt, 0, bulletAt(node.indent, text)) // 同级 = 复制目标节点自己的缩进
  return { md: joinLines(lines, md), path: [...path.slice(0, -1), path[path.length - 1] + 1] }
}

/** 删除节点及其整棵子树。根不可删(返回原文)。返回新 markdown。 */
export function deleteNode(md, path) {
  if (path.length === 0) return md
  const { lines, root } = parseOutline(md)
  const node = nodeAtPath(root, path)
  if (!node || node.line < 0) return md
  const from = node.line
  const to = lastLine(node)
  lines.splice(from, to - from + 1)
  return joinLines(lines, md)
}

/** 该文档是否是本模型能安全图内编辑的「简单大纲」= 至少一个 # H1(**允许多个 = 多中心**)+ 其余非空行都是
 *  单位整数倍缩进的单行 `- ` bullet,且每个 H1 段内缩进逐级加深。
 *  只有 simple 时 parseOutline 的树才可能与 markmap transformer 的树逐节点对齐,此时才允许双击改节点;
 *  含 ##/有序列表/续行/代码块等复杂结构时返回 false → 宿主退回「源码模式编辑」,绝不点错节点(防数据完整性错误)。
 *  注意本函数只是廉价初筛,权威判据是 index.ts 的 treesAligned(拿真实 transformer 树逐节点比对源码行)。 */
export function isSimpleOutline(md) {
  const dialect = detectDialect(md)
  if (dialect === 'unsupported') return false // 混用 tab/空格、单位非 2/4、缩进非整数倍
  const unitLen = dialect === 'tabs' ? 1 : dialect === 'spaces-4' ? 4 : 2
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  let h1 = 0
  let prevLevel = -1 // 本段还没遇到 bullet
  let contPrefix = null // 最近一个 bullet 的内容列前缀(它的续行必须恰好缩进到这里)
  for (const ln of lines) {
    if (ln.trim() === '') continue
    if (/^#{2,}\s/.test(ln)) return false // 二级以上标题
    if (/^#\s+/.test(ln)) {
      h1++
      prevLevel = -1 // 新中心 = 新的缩进基准段
      contPrefix = null
      continue
    }
    // 任何 bullet 都必须在某个 H1 之后:H1 之前的 bullet 不进导图根却会顶高缩进基准,放行跳级 → 会改错行。
    if (h1 === 0) return false
    // marker 必须**恰好**是 `- `:`-  A` / `-    A` 会改变父项内容偏移量,后续合法子缩进阈值随之变化,
    // 只看行首缩进就会与 markdown-it 分歧(Codex)。
    const m = /^([ \t]*)- (\S.*)$/.exec(ln)
    if (!m) {
      // 续行(多行节点):恰好缩进到最近 bullet 的内容列、非空、非 bullet/有序列表 → 属于该 bullet,放行。
      // 与 parseOutline 的续行判据一致;treesAligned 仍是权威兜底。
      if (contPrefix !== null && ln.startsWith(contPrefix)) {
        const rest = ln.slice(contPrefix.length)
        if (rest !== '' && !/^\s/.test(rest) && !/^([-+*] |\d+[.)] )/.test(rest)) continue
      }
      return false // 有序列表 / 代码块 / 空 bullet / 非标准 marker / 缩进不符的续行
    }
    // bullet 正文本身又是个列表(`- - x`、`- 1. x`)时,markdown 会把它解析成内嵌列表,后续行的归属随之改变
    // (Codex 反例:`- - dash` 下面的 `- child` 被提升为 dash 的同级,模型却当成子级)→ 直接拒。
    if (/^([-+*] |\d+[.)] )/.test(m[2])) return false
    if (m[1].length % unitLen !== 0) return false // 非单位整数倍(含首行 1~3 空格)
    // 段内首个 bullet 必须零缩进,之后每次最多深一级 —— 跳级时模型按字面缩进建树、markdown 却归并到上层,
    // 两棵树错位 = 双击会改错行。
    const level = levelOfPrefix(m[1], dialect)
    if (level > prevLevel + 1) return false
    prevLevel = level
    contPrefix = m[1] + '  ' // 该 bullet 的内容列(marker `- ` 宽 2)
  }
  return h1 >= 1
}

/** 按 `#` 边界把大纲切成**各中心**的独立子文档(每段以自己的 `# 标题` 起头,到下一个 `#` 前结束)。
 *  段数 === parseOutline 的中心数(顺序一致)。用于「每个中心一个独立 markmap 实例」的浮动画布渲染。
 *  首个 `#` 之前的内容(简单大纲里本不该有)一律丢弃。 */
export function splitCenters(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) if (/^#\s+/.test(lines[i])) starts.push(i)
  const segs = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length
    segs.push(lines.slice(starts[k], end).join('\n'))
  }
  return segs
}

/** 浮动中心的画布坐标存在文件最前的 YAML frontmatter 里(单行 JSON):`mindmap: {"1":[x,y]}`,键=中心下标。
 *  拆出坐标 + 正文:**正文(body)不含 frontmatter**,交给 parseOutline/markmap —— 两边行号一致,编辑对齐门禁不受影响。
 *  用户可能自带的其它 frontmatter 行原样留在 fmOther,回写时放回,绝不丢。返回 { positions, fmOther, body, eol }。 */
export function splitPositions(md) {
  const s = String(md)
  const eol = /\r\n/.test(s) ? '\r\n' : '\n'
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(s)
  if (!m) return { positions: {}, fmOther: '', body: s, eol }
  let positions = {}
  const other = []
  for (const ln of m[1].split(/\r?\n/)) {
    const mm = /^mindmap:\s*(.*)$/.exec(ln)
    if (mm) {
      try {
        const v = JSON.parse(mm[1])
        if (v && typeof v === 'object') positions = v
      } catch { /* 坏坐标忽略,不影响正文 */ }
    } else other.push(ln)
  }
  const fmOther = other.some((l) => l.trim() !== '') ? other.join(eol) : ''
  return { positions, fmOther, body: s.slice(m[0].length), eol }
}

/** 把坐标 + 保留的其它 frontmatter 写回正文之前。两者都空 → 返回纯 body(不留空 frontmatter,文件保持干净)。 */
export function joinPositions(positions, fmOther, body, eol = '\n') {
  const hasPos = positions && Object.keys(positions).length > 0
  if (!hasPos && !fmOther) return body
  const inner = []
  if (fmOther) inner.push(fmOther)
  if (hasPos) inner.push(`mindmap: ${JSON.stringify(positions)}`)
  return `---${eol}${inner.join(eol)}${eol}---${eol}${body}`
}
