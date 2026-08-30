// 导图 ⇄ 缩进大纲的互转(纯函数,单测在 mmOutline.test.ts)。
//
// 这是导图的**结构互操作层**:导出 Markdown/OPML、复制节点到别处、从任意缩进文本粘贴出一棵子树,
// 全部经过这里。原型分析文档 §10.5 的教训:只做图片导出的导图迁不走也再编辑不了 —— 树结构必须
// 有一个纯文本、可往返的表示。
//
// 刻意只表达**树**:关系线、坐标、折叠状态是导图私有语义,降级时丢弃(§6.12 的「互操作降级规则」)。

export interface OutlineNode {
  text: string
  children: OutlineNode[]
}

/** 一个块的显示文本:取首个非空行,剥掉 markdown 前缀(#、-、>、任务勾选框)与行尾空白。
 *  节点正文可以是整段富文本/嵌入,大纲里只呈现它的「标题行」。 */
export function nodeLabel(content: string): string {
  const line = (content ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^>\s?/, '')
    .trim()
}

/** 树 → 缩进大纲(每层两个空格 + '- ')。空标题写成 '-',保住层级不塌。 */
export function toOutline(nodes: OutlineNode[], indent = 0): string {
  const out: string[] = []
  for (const n of nodes) {
    out.push(`${'  '.repeat(indent)}- ${n.text}`.trimEnd())
    if (n.children.length) out.push(toOutline(n.children, indent + 1))
  }
  return out.join('\n')
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 树 → OPML 2.0(XMind / MindNode / Freeplane 都吃这个格式)。 */
export function toOpml(nodes: OutlineNode[], title: string): string {
  const body = (ns: OutlineNode[], depth: number): string =>
    ns
      .map((n) => {
        const pad = '  '.repeat(depth)
        const t = xmlEscape(n.text)
        return n.children.length
          ? `${pad}<outline text="${t}">\n${body(n.children, depth + 1)}\n${pad}</outline>`
          : `${pad}<outline text="${t}"/>`
      })
      .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${xmlEscape(title)}</title></head>`,
    '  <body>',
    body(nodes, 2),
    '  </body>',
    '</opml>',
  ].join('\n')
}

/** 缩进文本 → 树。缩进宽度按**文中出现的最小非零缩进**推断(2 空格 / 4 空格 / Tab 都吃),
 *  比写死 2 空格稳。列表符号(- * +)、markdown 标题(#)前缀会被剥掉;空行忽略。
 *  比当前层深多级的行不会凭空造中间节点,只挂到最近的合法父级(粘贴外部文本必须永远得到一棵合法树)。 */
export function parseOutline(text: string): OutlineNode[] {
  const raw = (text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const rows: Array<{ indent: number; text: string; hash: number }> = []
  for (const line of raw) {
    if (!line.trim()) continue
    const lead = /^[\t ]*/.exec(line)?.[0] ?? ''
    const indent = lead.replace(/\t/g, '  ').length
    const body = line.slice(lead.length)
    const hash = /^(#{1,6})\s+/.exec(body)?.[1].length ?? 0
    rows.push({ indent, text: nodeLabel(body), hash })
  }
  if (!rows.length) return []
  // 全是 markdown 标题(没有缩进)时,用 # 的级数当层级 —— 从笔记大纲直接粘过来的常见形态。
  const flat = rows.every((r) => r.indent === 0)
  if (flat && rows.some((r) => r.hash > 0)) {
    for (const r of rows) r.indent = (r.hash > 0 ? r.hash - 1 : 6) * 2
  }
  // reduce 而非 Math.min(...spread):粘进来的可以是几万行,展开成实参会直接 RangeError(Codex)。
  const step = rows.reduce((m, r) => (r.indent > 0 && r.indent < m ? r.indent : m), 2)
  const roots: OutlineNode[] = []
  const stack: Array<{ depth: number; node: OutlineNode }> = []
  for (const r of rows) {
    const depth = Math.round(r.indent / step)
    const node: OutlineNode = { text: r.text, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)
    stack.push({ depth: parent ? parent.depth + 1 : 0, node })
  }
  return roots
}
