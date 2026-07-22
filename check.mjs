/**
 * 自检:纯大纲模型(解析 / 改名 / 加子 / 加同级 / 删除 / 转义)+ 构建产物完整性(main.js 无顶层
 * import/export、可 new Function 构造、含三处注册与扩展名)。markmap 的 SVG 渲染需浏览器 DOM,
 * 只能在桌面手验(见 README「验证」),不在此。
 * 跑法:node check.mjs
 */
import { readFileSync } from 'node:fs'
import { strict as A } from 'node:assert'
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
} from './src/model.mjs'

const MD = '# 中心\n- A\n  - A1\n  - A2\n- B\n'

// —— 解析:# 根 + 缩进 bullet → 树 + path ——
const { root } = parseOutline(MD)
A.equal(root.text, '中心')
A.equal(root.children.length, 2)
A.equal(root.children[0].text, 'A')
A.equal(root.children[0].children.length, 2)
A.equal(root.children[0].children[1].text, 'A2')
A.deepEqual(root.children[0].children[1].path, [0, 1])
A.equal(nodeAtPath(root, [0, 1]).text, 'A2')
A.equal(nodeAtPath(root, [9]), null)

// —— 改名(根 + bullet;去换行)——
A.equal(renameNode(MD, [], '新中心').split('\n')[0], '# 新中心')
A.ok(renameNode(MD, [0, 1], 'A2改').includes('  - A2改'))
A.ok(!/- A2\n/.test(renameNode(MD, [0, 1], 'A2改')))
// H1 标题恒单行:换行折叠成空格
A.equal(renameNode(MD, [], '多\n中心').split('\n')[0], '# 多 中心')

// —— 多行节点(1.5.0:节点内换行,Shift+Enter)——
// bullet 改成多行:首行 `- ...`,续行缩进到内容列(indent + 2),空续行丢弃
const ml = renameNode(MD, [1], '第一行\n第二行')
A.ok(ml.includes('- 第一行\n  第二行'), '多行 bullet:续行缩进到内容列')
// 往返:解析回来 node.text 恢复成带 \n 的多行,path/结构不变
const mlRoot = parseOutline(ml).root
A.equal(nodeAtPath(mlRoot, [1]).text, '第一行\n第二行')
A.equal(mlRoot.children.length, 2) // 续行不新增节点
// 嵌套 bullet 的续行缩进 = 该 bullet 内容列(A2 在 2 空格缩进,续行 4 空格)
const ml2 = renameNode(MD, [0, 1], 'A2\n注释')
A.ok(ml2.includes('  - A2\n    注释'))
A.equal(nodeAtPath(parseOutline(ml2).root, [0, 1]).text, 'A2\n注释')
// 删除多行节点连同续行一并删掉
A.ok(!deleteNode(ml, [1]).includes('第二行'))

// —— 加子:追加为最后一个孩子,深一层缩进,插在子树之后 ——
// A 是 level 1,其子节点 = level 2 = 缩进 2 空格(与 A1/A2 同级)。
const c = addChild(MD, [0])
A.deepEqual(c.path, [0, 2])
A.ok(c.md.includes('  - 新节点'), '子节点应缩进 2 空格(level 2)')
A.ok(c.md.indexOf('- A2') < c.md.indexOf('新节点'))
A.ok(c.md.indexOf('新节点') < c.md.indexOf('- B'))

// —— 加同级:同缩进,插在整棵子树之后 ——
const s = addSibling(MD, [0])
A.deepEqual(s.path, [1])
A.ok(s.md.indexOf('- A2') < s.md.indexOf('- 新节点'))
A.ok(s.md.indexOf('- 新节点') < s.md.indexOf('- B'))
A.deepEqual(addSibling(MD, []).path, [2]) // 根加同级 → 顶层子节点

// —— 删除:节点 + 整棵子树;根不可删 ——
const d = deleteNode(MD, [0])
A.ok(!/- A\n/.test(d) && !d.includes('- A1') && !d.includes('- A2'))
A.ok(d.includes('- B'))
A.equal(deleteNode(MD, []), MD)

// —— 无 H1 也解析 bullet + addChild 到根(Codex #13)——
const noH1 = '- A\n- B\n'
A.equal(parseOutline(noH1).root.children.length, 2)
A.equal(parseOutline(noH1).root.children[1].text, 'B')
const nh = addChild(noH1, [])
A.deepEqual(nh.path, [2])
A.ok(nh.md.includes('- 新节点'))
A.ok(nh.md.indexOf('- B') < nh.md.indexOf('- 新节点')) // 追加在末尾

// —— isSimpleOutline 图内编辑门禁(Codex #8/#9)——
A.equal(isSimpleOutline('# R\n- A\n  - B\n'), true)
A.equal(isSimpleOutline(BLANK_MINDMAP), true) // 模板可编辑
A.equal(isSimpleOutline('# R\n## H2\n- A\n'), false) // 二级标题
A.equal(isSimpleOutline('# R\n1. A\n'), false) // 有序列表
A.equal(isSimpleOutline('# R\n- A\n  续行\n'), true) // 1.5.0:续行(缩进到内容列)= 多行节点,放行
A.equal(isSimpleOutline('# R\n- A\n    深续行\n'), false) // 续行缩进多于内容列(不是 0/2 列)→ 拒
A.equal(isSimpleOutline('# R\n- A\n 一列续行\n'), false) // 续行缩进少于内容列 → 拒
A.equal(isSimpleOutline('- A\n- B\n'), false) // 无 H1(至少要有一个中心)
A.equal(isSimpleOutline('# A\n# B\n'), true) // 多个 H1 = 多中心,1.3.0 起放行
// 缩进跳级:本模型按字面缩进建树,markdown/markmap 却把它归并 → 两棵树错位,双击会改错行(Codex #1)
A.equal(isSimpleOutline('# R\n- A\n      - X\n  - A2\n'), false) // 1 级下面直接冒出 3 级
A.equal(isSimpleOutline('# R\n    - A\n'), false) // 首个 bullet 就不是 0 级
A.equal(isSimpleOutline('# R\n- A\n  - B\n    - C\n- D\n'), true) // 逐级加深 + 回退,合法
// H1 必须在所有 bullet 之前:否则 H1 前的 bullet 会把缩进基准顶高,放行 H1 后的跳级(Codex 实测能骗过门禁)
A.equal(isSimpleOutline('- P0\n  - P1\n# R\n    - A\n- B\n'), false)
A.equal(isSimpleOutline('- A\n# R\n- B\n'), false) // 任何 bullet 早于 H1 都不算简单大纲

// —— 分段:每中心一段(1.5.0 浮动中心,每段一个独立 markmap 实例)——
const twoC = '# 主\n- a\n- b\n# 中心二\n- x\n'
const segs = splitCenters(twoC)
A.equal(segs.length, 2)
A.ok(segs[0].startsWith('# 主') && segs[0].includes('- b') && !segs[0].includes('中心二'))
A.ok(segs[1].startsWith('# 中心二') && segs[1].includes('- x'))
A.equal(splitCenters('# 只有一个\n- a\n').length, 1) // 单中心 = 一段
A.equal(splitCenters('- 无中心\n').length, 0)

// —— 浮动中心坐标 frontmatter 往返 ——
const withPos = joinPositions({ 1: [300, -120] }, '', twoC)
A.ok(withPos.startsWith('---\nmindmap: {"1":[300,-120]}\n---\n'))
const sp = splitPositions(withPos)
A.deepEqual(sp.positions, { 1: [300, -120] })
A.equal(sp.body, twoC) // body 不含 frontmatter → parseOutline/markmap 行号一致
A.equal(parseOutline(sp.body).root.children.length, 2)
A.equal(joinPositions({}, '', twoC), twoC) // 无坐标 → 纯正文,不留空 frontmatter
// 用户自带的其它 frontmatter 原样保留
const userFm = '---\ntitle: 我的图\nmindmap: {"1":[5,6]}\n---\n# X\n- a\n'
const sp2 = splitPositions(userFm)
A.deepEqual(sp2.positions, { 1: [5, 6] })
A.equal(sp2.fmOther, 'title: 我的图')
A.ok(joinPositions(sp2.positions, sp2.fmOther, sp2.body).includes('title: 我的图'))
A.equal(splitPositions(twoC).body, twoC) // 无 frontmatter 原样透传

// —— 转义 ——
A.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;')
A.ok(!escapeHtml('<img src=x>').includes('<img'))

// —— 空白模板可解析 ——
A.equal(parseOutline(BLANK_MINDMAP).root.text, '新思维导图')

// —— 铁律不变式:门禁放行的文档,模型树必须与**真实 markmap transformer 树**逐节点对齐 ——
// (光靠启发式判「简单大纲」证明不了不会点错行;这里拿实际渲染用的那棵树来证。)
{
  const { Transformer } = await import('markmap-lib')
  const tr = new Transformer()
  tr.md.set({ html: false })
  const startLine = (n) => { const r = n?.payload?.lines; return typeof r === 'string' ? parseInt(r.split(',')[0], 10) : null }
  // 独立判据(**故意不照抄生产代码的算法**):把两棵树各自压成 `path -> 源码行` 的映射再整体比。
  // 生产侧 treesAligned 是递归成对比;这里换个角度算同一件事 —— 两边都对才算数。
  // 之所以必须比 path 而不是「DFS 行号序列」:层级不同但 DFS 行号恰好相同的文档存在(Codex 的 `- - dash`),
  // 而 SVG 节点是靠 path 反查模型的,path 对不上就会点到错误的节点。
  const mapOf = (root, isMarkmap) => {
    const out = new Map()
    const go = (n, path) => {
      out.set(path.join('.'), isMarkmap ? startLine(n) : (n.line < 0 ? null : n.line))
      ;(n.children || []).forEach((c, i) => go(c, path.concat(i)))
    }
    go(root, [])
    return out
  }
  const aligned = (md) => {
    const a = mapOf(tr.transform(md).root, true)
    const b = mapOf(parseOutline(md).root, false)
    if (a.size !== b.size) return false
    for (const [p, line] of a) if (!b.has(p) || b.get(p) !== line) return false
    return true
  }
  const VECTORS = [
    ['纯 2 空格三层', '# R\n- A\n  - B\n    - C\n- D\n', true],
    ['纯 4 空格三层', '# R\n- A\n    - B\n        - C\n- D\n', true],
    ['纯 tab 三层', '# R\n- A\n\t- B\n\t\t- C\n- D\n', true],
    ['只有根级无缩进', '# R\n- A\n- B\n', true],
    ['首 bullet 缩进 1 空格', '# R\n - A\n', false],
    ['首 bullet 缩进 4 空格', '# R\n    - A\n', false],
    ['0→4→6 非整数倍', '# R\n- A\n    - B\n      - C\n', false],
    ['0→8 直接跳级', '# R\n- A\n        - B\n', false],
    ['2 空格与 tab 混用', '# R\n- A\n  - B\n\t- C\n', false],
    ['marker 多空格 "-  A"', '# R\n-  A\n', false],
    ['H1 前有 bullet', '- P\n# R\n- A\n', false],
    ['有序列表', '# R\n1. A\n', false],
    ['续行 = 多行节点(1.5.0 放行)', '# R\n- A\n  续行\n', true],
    ['多行节点 + 后随子级', '# R\n- A\n  第二行\n  - 子\n', true],
    ['续行缩进过深', '# R\n- A\n    过深\n', false],
    // 多中心(1.3.0):markmap 对多个 H1 会造一个空虚拟根、把各 H1 挂成孩子 —— 本模型必须同构
    ['多中心 裸 H1', '# A\n# B\n', true],
    ['多中心 各带子树', '# A\n\n- x\n  - y\n\n# B\n\n- z\n', true],
    ['多中心 三个', '# A\n- x\n\n# B\n\n# C\n- z\n', true],
    ['多中心 段内跳级', '# A\n- x\n\n# B\n    - z\n', false], // B 段首个 bullet 就不是 0 级
    ['多中心 后段带 ##', '# A\n- x\n\n# B\n## H2\n', false],
    // Codex 反例:bullet 正文本身又是列表 → markdown 解析成内嵌列表,后续行归属变化(层级与本模型不同),
    // 而**展平后的 DFS 行号序列恰好一致** —— 老判据(只比行号序列)会误放行。
    ['bullet 正文是 dash 列表', '# A\n- parent\n  - - dash\n    - child\n', false],
    ['bullet 正文是有序列表', '# A\n- parent\n  - 1. num\n    - child\n', false],
    ['bullet 正文是星号列表', '# A\n- parent\n  - * star\n    - child\n', false],
  ]
  for (const [name, md, expectOpen] of VECTORS) {
    A.equal(isSimpleOutline(md), expectOpen, `门禁判定不符预期:${name}`)
    // 核心不变式:放行 ⇒ 必须真对齐(反之不要求,保守误杀是安全的)
    if (isSimpleOutline(md)) A.ok(aligned(md), `放行却与 markmap 树不对齐(会改错行):${name}`)
  }
  // 两道闸必须**各自独立**挡住「层级不同但 DFS 行号序列相同」:即使有人放松了 isSimpleOutline,
  // 结构判据也必须自己判 false(否则就退回到只靠初筛的老状态)。
  for (const md of ['# A\n- parent\n  - - dash\n    - child\n', '# A\n- parent\n  - 1. num\n    - child\n']) {
    A.equal(isSimpleOutline(md), false, `初筛应挡住嵌套列表正文:${JSON.stringify(md)}`)
    A.equal(aligned(md), false, `结构判据应独立挡住嵌套列表正文:${JSON.stringify(md)}`)
  }

  // 插入也必须沿用文档自己的缩进风格,别把 4 空格文档插成 2 空格
  // 已有子节点 → 复用它的缩进(与之同级),不是再深一层
  A.ok(addChild('# R\n- A\n    - B\n', [0]).md.includes('\n    - 新节点'), '已有子节点时应与其对齐(4 空格)')
  // 无子节点 → 才用本文档方言的一级增量
  A.ok(addChild('# R\n- A\n    - B\n', [0, 0]).md.includes('\n        - 新节点'), '4 空格文档新增一层应是 8 空格')
  A.ok(addChild('# R\n- A\n\t- B\n', [0, 0]).md.includes('\n\t\t- 新节点'), 'tab 文档新增一层应用 tab')
  A.ok(addSibling('# R\n- A\n    - B\n', [0, 0]).md.includes('\n    - 新节点'), '同级应复制目标节点的原始缩进')

  // —— 多中心结构操作:每一步都必须仍与真实 markmap 树对齐(否则双击会改错行)——
  const one = '# A\n- x\n  - y\n'
  const two = addRootNode(one)
  A.deepEqual(two.path, [1], '加中心后新中心是虚拟根的第 2 个孩子')
  A.ok(aligned(two.md), '单中心 + 新中心 → 必须与 markmap 树对齐')
  A.equal(nodeAtPath(parseOutline(two.md).root, two.path).text, '新中心')
  A.equal(parseOutline(two.md).root.virtual, true, '两个 H1 → 虚拟根')
  A.equal(parseOutline(one).root.virtual, false, '单个 H1 → 根就是那个 H1')
  // 改名 H1 写回的是 `# X` 而不是 `- X`
  A.ok(renameNode(two.md, [1], '中心二').includes('# 中心二'), 'H1 改名必须仍是标题行')
  A.ok(!renameNode(two.md, [1], '中心二').includes('- 中心二'))
  // H1 的「同级」= 又一个中心;H1 的「子级」= 顶层 bullet(零缩进)
  const sib = addSibling(two.md, [1])
  A.deepEqual(sib.path, [2])
  A.ok(sib.md.includes('\n# 新节点'), 'H1 加同级应产出新的 # 中心')
  A.ok(aligned(sib.md))
  const kid = addChild(two.md, [1])
  A.deepEqual(kid.path, [1, 0])
  A.ok(/\n- 新节点/.test(kid.md) && !kid.md.includes('\n  - 新节点'), 'H1 的子节点是零缩进顶层 bullet')
  A.ok(aligned(kid.md))
  // 虚拟根的「子级」也是新中心(选中中枢按 Enter/Tab 的行为)
  A.ok(addChild(two.md, []).md.includes('\n# 新中心'), '虚拟根加子 = 新中心')
  A.ok(aligned(addChild(two.md, []).md))
  // 删掉一个中心 → 退回单中心,剩下的内容不受损
  const del = deleteNode(kid.md, [0])
  A.ok(!del.includes('- x') && !del.includes('- y'), '删中心应连同其整棵子树')
  A.ok(del.includes('# 新中心') && del.includes('- 新节点'), '另一个中心必须完整保留')
  A.ok(aligned(del))

  // —— CRLF:换行风格必须原样保留(改一个节点不该把整份文件重写成 LF)——
  const crlf = '# A\r\n- x\r\n  - y\r\n'
  A.ok(renameNode(crlf, [0], 'X').includes('\r\n'), 'CRLF 文档改名后仍是 CRLF')
  A.ok(!/[^\r]\n/.test(renameNode(crlf, [0], 'X')), 'CRLF 文档不得混入裸 LF')
  A.ok(addChild(crlf, [0]).md.includes('\r\n'), 'CRLF 文档加子节点后仍是 CRLF')
  A.ok(!/\r/.test(renameNode('# A\n- x\n', [0], 'X')), 'LF 文档不得被塞进 CR')

  // —— 随机对抗扫描:门禁放行 ⇒ 必须与真实 markmap 树逐 path 对齐 ——
  // Codex 用 5 万份随机文档扫出「行号序列相同但层级不同」的整类漏洞(2890 个节点 path 在模型里不存在)。
  // 固化成带固定种子的确定性扫描,今后任何改动都得先过这一关。
  let seed = 20260721
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length]
  const BODIES = ['a', '**b**', '`c`', '- dash', '1. num', '* star', '+ plus', 'x y', '中文', '[l](u)']
  let opened = 0
  for (let n = 0; n < 3000; n++) {
    const lines = []
    const secs = 1 + Math.floor(rnd() * 2)
    for (let s = 0; s < secs; s++) {
      lines.push(`# H${s}`)
      const rows = Math.floor(rnd() * 5)
      for (let r = 0; r < rows; r++) lines.push(`${'  '.repeat(Math.floor(rnd() * 3))}- ${pick(BODIES)}`)
      if (rnd() < 0.4) lines.push('')
    }
    const md = lines.join('\n') + '\n'
    if (!isSimpleOutline(md)) continue
    opened++
    A.ok(aligned(md), `随机文档:门禁放行却与 markmap 树不对齐\n${JSON.stringify(md)}`)
  }
  A.ok(opened > 300, `随机扫描样本量太小(放行 ${opened} 份),扫描没起到作用`)
  console.log(`  随机对抗扫描:3000 份文档,放行 ${opened} 份,全部与真实 markmap 树逐 path 对齐`)
}

// —— 构建产物完整性(main.js 是 esbuild IIFE 打包物)——
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
A.ok(main.length > 1000, 'main.js 应是打包产物(含 markmap),不应为空/桩')
A.ok(!/^\s*(import|export)\s/m.test(main), 'main.js 不得有顶层 import/export(裸 setup 体闸)')
new Function('ctx', main) // 语法闸:构造成功=语法合法(不执行,避免 markmap 触 DOM)
for (const needle of ['registerFileType', 'registerEmbedRenderer', 'registerFileCreator', 'registerSlashItem', 'mindmap-new', '.mindmap.md']) {
  A.ok(main.includes(needle), `main.js 应含 ${needle}`)
}

console.log('check ok — mindmap: model(parse/rename/add/del/escape) + build integrity')
