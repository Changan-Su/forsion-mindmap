/**
 * 自检:`node check.mjs`。三件事,都是「坏了用户立刻能看见」的那种:
 *
 *  1. **构建产物**能过宿主的装载闸(顶层无 import/export、可被 new Function('ctx', …) 构造),
 *     且确实注册了文件类型/创建器/命令/斜杠项/嵌入渲染器。
 *  2. **捆绑包形状**:skills/mindmap-format/ 随包在位 —— 技能是跟着能力走的,插件在而技能不在,
 *     agent 就会凭直觉写出打开即塌的文件。
 *  3. **格式契约**:随包模板在宿主的块标记规则下真能切成一棵树。这条是给技能兜底的 ——
 *     技能里那份「照着改」的模板一旦手滑(最常见:块 id 用了连字符),用户拿到的就是一个巨大节点。
 *
 * 图形交互需要真浏览器,不在这里:见 Forsion-Genesis/desktop 的 `npm run e2e:mindmap`
 * (它加载**本仓库的 main.js**,验的是整条「插件 → 块表面 → 真块」接缝)。
 */
import { readFileSync, existsSync } from 'node:fs'
import { strict as A } from 'node:assert'

const fail = []
const t = (name, fn) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail.push(name)
    console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

// ── 1. 构建产物 ──────────────────────────────────────────────────────────────────
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

t("main.js 是裸 setup 体(顶层无 import/export)", () => {
  A.ok(!/^\s*(import|export)\s/m.test(main), '顶层出现了 import/export —— 宿主的 new Function 会直接抛')
})
t("main.js 语法可被 new Function('ctx', …) 构造", () => {
  new Function('ctx', main) // 只构造不执行:执行要真 DOM,那是 e2e 的事
})
t('main.js 像是真打包过(改了源码要重跑 build.mjs)', () => {
  A.ok(main.length > 100_000, `产物只有 ${main.length} 字节,像是没打包 React/画布`)
})
for (const [what, needle] of [
  ['文件类型', 'registerFileType'],
  ['创建器', 'registerFileCreator'],
  ['命令', 'registerCommand'],
  ['斜杠项', 'registerSlashItem'],
  ['嵌入渲染器', 'registerEmbedRenderer'],
  ['块表面', 'mountBlocks'],
]) {
  t(`产物里注册了${what}`, () => A.ok(main.includes(needle), `找不到 ${needle}`))
}
t('声明的扩展名与代码一致', () => {
  A.deepEqual(manifest.fileExtensions, ['.mindmap.md'])
  A.ok(main.includes('.mindmap.md'))
})
t('manifest / package.json 版本一致', () => A.equal(manifest.version, pkg.version))
t('声明了 minAppVersion(块表面 seam 是 2.7.0 才有的)', () => {
  A.ok(manifest.minAppVersion, '缺 minAppVersion —— 老宿主装上会是一片空白')
})

// ── 2. 捆绑包形状 ────────────────────────────────────────────────────────────────
const skillPath = new URL('./skills/mindmap-format/SKILL.md', import.meta.url)
const tplPath = new URL('./skills/mindmap-format/template.mindmap.md', import.meta.url)
t('随包技能在位(skills/mindmap-format/)', () => {
  A.ok(existsSync(skillPath), '缺 SKILL.md —— 引擎按 <bundle>/skills/<slug>/SKILL.md 找')
  A.ok(existsSync(tplPath), '缺 template.mindmap.md —— 技能正文引用了它')
})
const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
t('技能有 name/description/version 前置区', () => {
  for (const k of ['name:', 'description:', 'version:']) A.ok(new RegExp(`^${k}`, 'm').test(skill), `缺 ${k}`)
})

// ── 3. 格式契约:模板真能切成一棵树 ────────────────────────────────────────────────
// 规则镜像宿主编解码器(shared/amadeus/compiler)。id 字符集**没有连字符** —— 这是真踩过的坑:
// 一份用 `ai-root` 写的导图,44 个标记在真解析器下只切出 1 个块。
const MARKER = /^<!--\s*a\s+([A-Za-z0-9_]+)\s*-->\s*$/
const LOOSE = /^<!--\s*a\s+(\S+)\s*-->\s*$/

function parseMindmap(raw) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const head = fm ? fm[1] : ''
  const body = fm ? raw.slice(fm[0].length) : raw
  const ids = []
  const blocks = new Map()
  const bad = []
  let cur = null
  let buf = []
  const flush = () => {
    if (cur) blocks.set(cur, buf.join('\n').trim())
    buf = []
  }
  for (const line of body.split('\n')) {
    const m = MARKER.exec(line)
    const loose = LOOSE.exec(line)
    if (!m && loose) {
      bad.push(loose[1])
      continue
    }
    if (m) {
      flush()
      cur = m[1]
      ids.push(cur)
    } else buf.push(line)
  }
  flush()
  let map = {}
  const mm = /^mindmap:\s*(.*)$/m.exec(head)
  if (mm) {
    let s = mm[1].trim()
    if (/^['"]/.test(s)) s = s.slice(1, -1)
    map = JSON.parse(s)
  }
  return { head, ids, blocks, bad, map, hasPageKey: /^amadeus_page:/m.test(head) }
}

if (existsSync(tplPath)) {
  const tpl = readFileSync(tplPath, 'utf8')
  const r = parseMindmap(tpl)
  t('模板有 amadeus_page(缺了整份塌成一个块)', () => A.ok(r.hasPageKey))
  t('模板没有非法块 id(连字符是最常见的塌图原因)', () => A.deepEqual(r.bad, []))
  t('模板切出 7 个块', () => A.equal(r.ids.length, 7))
  t('模板恰好一个根节点', () => {
    const roots = r.ids.filter((id) => r.map[id]?.p === undefined)
    A.deepEqual(roots, ['center'])
  })
  t('模板没有空块(空块会在画布上多出一个空白散根)', () => {
    const empty = [...r.blocks].filter(([, c]) => !c).map(([id]) => id)
    A.deepEqual(empty, [])
  })
  t('关系表里的 id 都有对应的块', () => {
    for (const [id, n] of Object.entries(r.map)) {
      A.ok(r.ids.includes(id), `幽灵条目 ${id}`)
      if (n?.p !== undefined) A.ok(r.ids.includes(n.p), `${id} 的父 ${n.p} 不存在`)
    }
  })
  t('模板不写 amadeus_layout(加载时会按实际块重建)', () => {
    A.ok(!/^amadeus_layout:/m.test(r.head))
  })
  t('技能正文里内联的那份模板与 template.mindmap.md 一致', () => {
    // 技能被 use_skill 读走时只有正文、拿不到目录 → 正文里必须自带可整份抄走的模板。
    // 两份漂开就等于给 agent 一份没人验过的例子。
    const norm = (s) => s.replace(/\r\n/g, '\n').trim()
    A.ok(norm(skill).includes(norm(tpl)), 'SKILL.md 里的模板与 template.mindmap.md 不一致')
  })
}

console.log(fail.length ? `\n不通过:${fail.length} 项` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
