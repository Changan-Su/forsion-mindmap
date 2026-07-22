/**
 * 思维导图插件的真浏览器 e2e。markmap 要 DOM/布局,node 断言不了 —— 深浅色、选中可见性、内联编辑定位、
 * 缩放控件这几类 bug 只有真渲染才暴露(它们此前全靠肉眼手验,全漏了)。
 *
 * 跑法:node harness/mindmap.e2e.cjs   (先 npm run build 生成 main.js)
 * chromium 取 ~/Library/Caches/ms-playwright 下最新版(同 desktop 的 e2e),可用 CHROMIUM_EXE 覆盖。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
// playwright-core 不是本插件的依赖(插件产物不该带 devDep 体积)→ 本地没有就借 Genesis desktop 那份。
let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  const shared = path.join(os.homedir(), 'Documents/Project/Forsion/Forsion-Genesis/desktop/node_modules/playwright-core')
  ;({ chromium } = require(shared))
}

const ROOT = path.resolve(__dirname, '..')

// playwright 各版本的 mac 目录布局不一(chrome-mac / chrome-mac-arm64、Chromium.app / Google Chrome for Testing.app),
// 逐个候选试,别写死一条路径。
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()
  const apps = ['Chromium.app/Contents/MacOS/Chromium', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
  for (const d of dirs) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      for (const app of apps) {
        const exe = path.join(base, d, arch, app)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' }
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rq) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'harness/mindmap.html'
      const file = path.join(ROOT, rel)
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rq.writeHead(404); rq.end('nope'); return }
      rq.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(rq)
    })
    srv.listen(0, '127.0.0.1', () => res(srv))
  })
}

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  | ${extra}` : ''}`) }
}

// 解析 rgb(...) → 相对亮度 0..1
const lum = (css) => {
  const m = /(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(css || '')
  return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : null
}

const SAMPLE = '# 中心\n- 分支一\n  - 子节点\n- **粗体分支**\n'
const NODE = 'g.markmap-node .markmap-foreign > div > div'

/** 等 markmap 布局稳定再量坐标 —— waitForSelector 只保证节点「存在」,而 markmap 是先插节点后布局,
 *  过早量到的是原点附近的位置(实测 8,39),会把断言引到错误结论上。 */
async function settle(page) {
  let prev = null
  for (let i = 0; i < 40; i++) {
    const cur = await page.evaluate((sel) => {
      const n = document.querySelector(sel)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return `${Math.round(r.left)},${Math.round(r.top)}`
    }, NODE)
    if (cur && cur === prev) return
    prev = cur
    await page.waitForTimeout(50)
  }
}

/**
 * 逐个节点双击,断言内联输入框的种子 = 这个节点自己显示的文字。
 * 这是「图内编辑改的是不是这个节点」的直接验证 —— 模型树(parseOutline 的 path)与 markmap 渲染树一旦错位,
 * 双击 A 会把 B 的原文喂进输入框,再提交就改错行。此前只能靠收紧门禁回避,现在能真验。
 * 返回 {checked, bad[]}。
 */
async function checkEditMapping(page) {
  const n = await page.locator(NODE).count()
  const bad = []
  let checked = 0
  for (let i = 0; i < n; i++) {
    const node = page.locator(NODE).nth(i)
    const shown = ((await node.textContent()) || '').trim()
    // 多中心文档的中枢是 markmap 造的**空虚拟根**(零尺寸、无源码行),本就不该能双击改名 —— 跳过,不算漏测。
    if (!shown) continue
    checked++
    await node.dblclick()
    let seed = null
    try {
      await page.waitForSelector('.mmp-inline', { timeout: 1500 })
      seed = await page.locator('.mmp-inline').inputValue()
    } catch { /* 门禁关闭时不开编辑框 */ }
    if (seed === null) { bad.push(`${shown}: 未打开编辑框`); continue }
    // 种子是 markdown 原文,显示是渲染后的 → 比较时剥掉行内标记
    const plain = seed.replace(/\*\*|__|[*_`~]/g, '').trim()
    if (plain !== shown) bad.push(`双击「${shown}」却拿到「${plain}」`)
    await page.locator('.mmp-inline').press('Escape')
    await page.waitForTimeout(60)
  }
  return { checked, bad }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'main.js'))) throw new Error('缺 main.js,先跑 npm run build')
  const srv = await serve()
  const base = `http://127.0.0.1:${srv.address().port}/harness/mindmap.html`
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  page.on('pageerror', (e) => { fail++; console.log(`FAIL  页面异常: ${e.message}`) })
  await page.goto(base)
  await page.evaluate((md) => window.__boot(md), SAMPLE)
  await page.evaluate(() => window.__mount())
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)

  const nodeCount = await page.locator(NODE).count()
  ok(nodeCount >= 4, `渲染出全部节点 (${nodeCount} ≥ 4)`)

  // ── 1. 深浅色:节点文字必须跟宿主前景色,而不是 markmap 写死的 #333 ──
  const lightColor = await page.locator(NODE).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(lightColor) !== null && lum(lightColor) < 0.5, `浅色主题下节点文字为深色 (${lightColor})`)

  // ⚠️ 关键:切主题后**不重挂**。真实场景是「导图开着,用户去切深浅」;如果这里 remount,
  // 那么即使插件完全没有主题同步机制也会通过(Codex 指出的假通过)。必须验同一实例自己跟上。
  await page.evaluate(() => window.__setDark(true))
  await page.waitForTimeout(200) // 等 MutationObserver
  const darkColor = await page.locator(NODE).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(darkColor) !== null && lum(darkColor) > 0.5, `切暗色后(不重挂)节点文字转为浅色 (${darkColor}) —— 深浅回归闸`)
  const hasDarkClass = await page.evaluate(() => !!document.querySelector('.mmp-root.markmap-dark'))
  ok(hasDarkClass, '切暗色后(不重挂)容器挂上 markmap-dark —— 主题订阅闸')

  await page.evaluate(() => window.__setDark(false))
  await page.waitForTimeout(200)
  const backLight = await page.locator(NODE).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(backLight) !== null && lum(backLight) < 0.5, `切回浅色后(不重挂)文字转回深色 (${backLight})`)
  ok(!(await page.evaluate(() => !!document.querySelector('.mmp-root.markmap-dark'))), '切回浅色后 markmap-dark 被摘掉')

  // ── 2. 单击选中必须有可见效果 = 垫在文字后面的 <rect>(1.5.0:比文字盒各方向大 10% → 总 +20%;
  //       用 rect 而非 CSS 描边,避免被 foreignObject 裁掉)──
  const first = page.locator(NODE).first()
  await first.click()
  await page.waitForTimeout(120)
  const sel = await page.evaluate(() => {
    const rect = document.querySelector('g.markmap-node .mmp-sel-rect')
    if (!rect) return null
    const cs = getComputedStyle(rect)
    const rr = rect.getBoundingClientRect()
    const fo = rect.closest('g.markmap-node').querySelector('foreignObject')
    const fr = fo ? fo.getBoundingClientRect() : null
    return { fill: cs.fill, stroke: cs.stroke, w: rr.width, h: rr.height, fw: fr && fr.width }
  })
  ok(!!sel, '单击后选中节点出现 .mmp-sel-rect 选中框')
  ok(!!sel && sel.stroke && sel.stroke !== 'none' && sel.stroke !== 'rgba(0, 0, 0, 0)', `选中框有 accent 描边 (${sel && sel.stroke})`)
  ok(!!sel && sel.w > 0 && sel.h > 0, '选中框有可见尺寸')
  // Req1:选中框比文字盒宽约 20%(容差含 2px 非缩放描边)
  ok(!!sel && sel.fw > 0 && sel.w >= sel.fw * 1.15 && sel.w <= sel.fw * 1.34, `选中框比文字盒宽约 20% (框 ${sel && Math.round(sel.w)} / 文字 ${sel && Math.round(sel.fw)})`)

  // ── 3. 缩放 / 回到中心(1.5.0:改由外层画布 transform,不再是 markmap 自带 pan/zoom)──
  const scaleOf = () => page.evaluate(() => {
    const c = document.querySelector('.mmp-canvas')
    if (!c) return null
    const t = getComputedStyle(c).transform
    return !t || t === 'none' ? 1 : new DOMMatrix(t).a
  })
  const s0 = await scaleOf()
  await page.locator('.mmp-zoom button[data-z="in"]').click()
  await page.waitForTimeout(150)
  const s1 = await scaleOf()
  ok(s1 > s0, `放大按钮把比例调大 (${s0?.toFixed(2)} → ${s1?.toFixed(2)})`)
  await page.locator('.mmp-zoom button[data-z="out"]').click()
  await page.waitForTimeout(150)
  const s2 = await scaleOf()
  ok(s2 < s1, `缩小按钮把比例调小 (${s1?.toFixed(2)} → ${s2?.toFixed(2)})`)
  await page.locator('.mmp-zoom button[data-z="fit"]').click()
  await page.waitForTimeout(200)
  ok((await scaleOf()) > 0, '「回到中心/适应全图」可用')
  // 百分比要与真实画布缩放一致(只断言"长得像数字"等于没测)
  const pct = await page.locator('.mmp-zoom .mmp-pct').textContent()
  const realPct = Math.round((await scaleOf()) * 100)
  ok(parseInt((pct || '').trim(), 10) === realPct, `缩放百分比与实际比例一致 (显示 ${pct} / 实际 ${realPct}%)`)

  // 源码模式不得吞按键:Shift+1 在 textarea 里应打出 "!",而不是被当成「适应全图」快捷键
  await page.locator('.mmp-seg button[data-mode="source"]').click()
  await page.waitForSelector('.mmp-src', { timeout: 3000 })
  const srcCount = await page.locator('.mmp-src').count()
  ok(srcCount === 1, `源码模式只有一个 textarea (${srcCount})`)
  await page.locator('.mmp-src').click()
  await page.locator('.mmp-src').press('Shift+Digit1')
  ok((await page.locator('.mmp-src').inputValue()).includes('!'), '源码模式下 Shift+1 能正常输入 "!"(缩放快捷键不抢)')
  await page.locator('.mmp-src').fill(SAMPLE) // 还原,免得那个 "!" 让文档不再是简单大纲、污染后续用例
  await page.locator('.mmp-seg button[data-mode="map"]').click()
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)

  // ── 4. 内联编辑:就地覆盖在节点上 + 种子是 markdown 原文(不是渲染后的纯文本)──
  const boldNode = page.locator(NODE).filter({ hasText: '粗体分支' }).first()
  const nodeBox = await boldNode.boundingBox()
  await boldNode.dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  const inputVal = await page.locator('.mmp-inline').inputValue()
  ok(inputVal === '**粗体分支**', `内联输入框种子是 markdown 原文而非渲染文本 (${JSON.stringify(inputVal)})`)
  const inBox = await page.locator('.mmp-inline').boundingBox()
  const overlaps = inBox && nodeBox
    && Math.abs(inBox.x - nodeBox.x) < 40 && Math.abs(inBox.y - nodeBox.y) < 40
  ok(!!overlaps, `编辑框就地覆盖在节点上 (node ${nodeBox && Math.round(nodeBox.x)},${nodeBox && Math.round(nodeBox.y)} / input ${inBox && Math.round(inBox.x)},${inBox && Math.round(inBox.y)})`)

  // ── 5. 空文本 + Enter 不得写出 `- ` 空 bullet(会让 isSimpleOutline 判 false,图内编辑永久锁死)──
  await page.locator('.mmp-inline').fill('')
  await page.locator('.mmp-inline').press('Enter')
  await page.waitForTimeout(700) // 过写盘防抖
  const md = await page.evaluate(() => window.__md())
  ok(!/^\s*-\s*$/m.test(md), `空节点提交不产生空 bullet\n${JSON.stringify(md)}`)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  const hint = await page.locator('.mmp-hint').textContent()
  ok(!/源码/.test(hint || ''), `图内编辑未被锁死 (提示: ${hint})`)

  // ── 6. 嵌入块(`![[x.mindmap.md]]`)同样要跟深浅色 —— 它走独立的 mountEmbed 分支,别只测编辑器 ──
  await page.evaluate(() => window.__setDark(true))
  await page.evaluate(() => window.__mountEmbed('t.mindmap.md'))
  await page.waitForSelector(`.mmp-embed ${NODE}`, { timeout: 5000 })
  const embedDark = await page.locator(`.mmp-embed ${NODE}`).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(embedDark) !== null && lum(embedDark) > 0.5, `嵌入块暗色下文字为浅色 (${embedDark})`)
  await page.evaluate(() => window.__setDark(false))
  await page.evaluate(() => window.__mountEmbed('t.mindmap.md'))
  await page.waitForSelector(`.mmp-embed ${NODE}`, { timeout: 5000 })
  const embedLight = await page.locator(`.mmp-embed ${NODE}`).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(embedLight) !== null && lum(embedLight) < 0.5, `嵌入块浅色下文字为深色 (${embedLight})`)

  // ── 7. 节点↔源码对齐:逐个节点双击,种子必须是它自己的原文(错位=会改错行)──
  await page.evaluate(() => window.__setDark(false))
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  const map2 = await checkEditMapping(page)
  ok(map2.bad.length === 0, `2 空格大纲:${map2.checked} 个节点双击均命中自身原文`, map2.bad.join(' / '))

  // 4 空格 / tab 缩进的大纲同样要能编辑且不错位(此前被门禁误挡,现已放开 —— 必须有闸守着)
  for (const [label, doc] of [
    ['4 空格', '# 中心\n- 分支一\n    - 子节点\n- **粗体分支**\n'],
    ['tab', '# 中心\n- 分支一\n\t- 子节点\n- **粗体分支**\n'],
  ]) {
    await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, doc)
    await page.waitForSelector(NODE, { timeout: 5000 })
    await settle(page)
    const hint = await page.locator('.mmp-hint').textContent()
    ok(!/源码/.test(hint || ''), `${label} 缩进大纲允许图内编辑(不再被误挡)`)
    const m = await checkEditMapping(page)
    ok(m.bad.length === 0, `${label} 缩进:${m.checked} 个节点双击均命中自身原文`, m.bad.join(' / '))
  }

  // ── 8. 控件深浅色:曾经用 `var(--am-bg,#fff)` 上色,而宿主根本没有 --am-* → 暗色下缩放条是白胶囊。
  //      当时 harness 自己定义了 --am-*,把宿主没有的东西喂进来,于是「通过」了。现在 harness 只提供真宿主
  //      真有的变量,这条断言才有意义:暗色下缩放条必须是深底浅字。 ──
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  await page.evaluate(() => window.__setDark(true))
  await page.waitForTimeout(200)
  const zoomDark = await page.evaluate(() => {
    const bar = document.querySelector('.mmp-zoom')
    const btn = bar && bar.querySelector('button')
    return bar ? { bg: getComputedStyle(bar).backgroundColor, fg: getComputedStyle(btn).color } : null
  })
  ok(zoomDark && lum(zoomDark.bg) < 0.5, `暗色下缩放条是深底 (${zoomDark && zoomDark.bg}) —— 宿主无 --am-* 回归闸`)
  ok(zoomDark && lum(zoomDark.fg) > 0.5, `暗色下缩放条是浅字 (${zoomDark && zoomDark.fg})`)
  ok(zoomDark && Math.abs(lum(zoomDark.bg) - lum(zoomDark.fg)) > 0.4, '暗色下缩放条底/字有足够反差')

  // 内联编辑框同理:暗色下必须深底浅字,否则打字时白底闪瞎
  await page.locator(NODE).first().dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  const inlineDark = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.mmp-inline'))
    return { bg: cs.backgroundColor, fg: cs.color }
  })
  ok(lum(inlineDark.bg) < 0.5 && lum(inlineDark.fg) > 0.5, `暗色下编辑框深底浅字 (${inlineDark.bg} / ${inlineDark.fg})`)

  // ── 9. 编辑框保留圆角 + 2px 内描边视觉(内描边而非外描边:foreignObject 会裁掉画在盒外的东西)──
  //    (选中框 1.5.0 起改为**比文字盒大 20%** 的 <rect>,不再与编辑框等大,故不再比对二者)
  const inp = await page.evaluate(() => {
    const b = document.querySelector('.mmp-inline')
    if (!b) return null
    const cs = getComputedStyle(b)
    return { r: cs.borderRadius, s: cs.boxShadow }
  })
  ok(!!inp && inp.r !== '0px', `编辑框有圆角 (${inp && inp.r})`)
  ok(!!inp && /inset/.test(inp.s), `编辑框用内描边 (${inp && inp.s})`)
  await page.evaluate(() => window.__setDark(false))

  // ── 10. 编辑框宽度贴合文字(旧版固定 minWidth + input 默认 ~20 字符固有宽度 → 短文字也拖一长条)──
  await page.locator('.mmp-inline').press('Escape')
  await page.waitForTimeout(150)
  const shortNode = page.locator(NODE).filter({ hasText: '分支一' }).first()
  const shortBox = await shortNode.boundingBox()
  await shortNode.dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  const narrow = await page.locator('.mmp-inline').boundingBox()
  ok(narrow.width < shortBox.width + 40, `短文字编辑框贴合内容 (节点 ${Math.round(shortBox.width)}px / 输入框 ${Math.round(narrow.width)}px)`)
  await page.locator('.mmp-inline').fill('这是一段明显长得多的节点文字内容用来验证宽度会跟随')
  await page.waitForTimeout(120)
  const wide = await page.locator('.mmp-inline').boundingBox()
  ok(wide.width > narrow.width + 60, `输入变长时编辑框跟着变宽 (${Math.round(narrow.width)} → ${Math.round(wide.width)}px)`)
  const bodyW = await page.evaluate(() => document.querySelector('.mmp-body').clientWidth)
  ok(wide.x + wide.width <= bodyW + 1, `编辑框不溢出画布 (右边 ${Math.round(wide.x + wide.width)} ≤ ${bodyW})`)
  await page.locator('.mmp-inline').press('Escape')
  await page.waitForTimeout(200)

  // ── 11. 多中心:空白处双击新建一个独立中心节点(参考 XMind 浮动主题)──
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  const before = await page.locator(NODE).count()
  // 找一块**确实空白**的画布位置(离所有节点 ≥ 40px、且不在缩放条上),别拍脑袋写死坐标
  const blank = await page.evaluate(() => {
    const svg = document.querySelector('svg.mmp-svg').getBoundingClientRect()
    const boxes = [...document.querySelectorAll('g.markmap-node'), ...document.querySelectorAll('.mmp-zoom')]
      .map((e) => e.getBoundingClientRect())
    for (let y = svg.top + 20; y < svg.bottom - 20; y += 14) {
      for (let x = svg.left + 20; x < svg.right - 20; x += 14) {
        if (boxes.every((b) => x < b.left - 40 || x > b.right + 40 || y < b.top - 40 || y > b.bottom + 40)) return { x, y }
      }
    }
    return null
  })
  ok(!!blank, '画布上找得到空白处')
  await page.mouse.dblclick(blank.x, blank.y)
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape') // 新中心会直接进编辑态,先退出
  await page.waitForTimeout(700) // 过写盘防抖
  const mdMulti = await page.evaluate(() => window.__md())
  ok((mdMulti.match(/^# /gm) || []).length === 2, `空白双击新增了第二个中心 (${JSON.stringify(mdMulti)})`)
  await settle(page)
  const after = await page.locator(NODE).count()
  ok(after > before, `多中心节点数增加 (${before} → ${after})`)
  const hintMulti = await page.locator('.mmp-hint').textContent()
  ok(!/源码/.test(hintMulti || ''), '多中心文档仍允许图内编辑')
  const mapMulti = await checkEditMapping(page)
  ok(mapMulti.bad.length === 0, `多中心:${mapMulti.checked} 个节点双击均命中自身原文`, mapMulti.bad.join(' / '))

  // ── 11b. 输入法组合期间的 Enter 不得提交(中文选词就是按 Enter,keydown 也报 key='Enter')──
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  await page.locator(NODE).filter({ hasText: '分支一' }).first().dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  const imeStillOpen = await page.evaluate(() => {
    const input = document.querySelector('.mmp-inline')
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = '分支一zhongwen' // 预编辑串
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
    return !!document.querySelector('.mmp-inline') // 还在 = 没被当成提交
  })
  ok(imeStillOpen, '输入法组合中按 Enter(选词)不提交编辑 —— 中文可用性闸')
  await page.waitForTimeout(700) // ⚠️ 必须过写盘防抖再读,否则读到的是旧内容,断言恒真(自测变异时抓到)
  const imeMd = await page.evaluate(() => window.__md())
  ok(!/新节点/.test(imeMd), `输入法组合中按 Enter 不新建同级节点 (${JSON.stringify(imeMd)})`)
  // 组合结束后 Enter 才生效
  const imeCommits = await page.evaluate(() => {
    const input = document.querySelector('.mmp-inline')
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return !document.querySelector('.mmp-inline')
  })
  ok(imeCommits, '组合结束后按键恢复正常接管')
  await page.waitForTimeout(700)

  // ── 11d. 节点内换行(1.5.0):Shift+Enter 插入换行,存成多行 bullet(续行缩进到内容列),渲染成 <br> ──
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)
  await page.locator(NODE).filter({ hasText: '子节点' }).first().dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  await page.locator('.mmp-inline').fill('行一')
  await page.locator('.mmp-inline').press('Shift+Enter')
  ok(await page.evaluate(() => !!document.querySelector('.mmp-inline')), 'Shift+Enter 只换行、不提交编辑')
  await page.keyboard.type('行二')
  await page.locator('.mmp-inline').press('Escape') // 提交
  await page.waitForTimeout(700)
  const mlMd = await page.evaluate(() => window.__md())
  ok(/  - 行一\n {4}行二/.test(mlMd), `多行节点存成续行(缩进到内容列) (${JSON.stringify(mlMd)})`)
  const mlHint = await page.locator('.mmp-hint').textContent()
  ok(!/源码/.test(mlHint || ''), '多行节点仍允许图内编辑(未退化到源码)')
  ok(await page.evaluate(() => document.querySelectorAll('g.markmap-node br').length) >= 1, '多行节点渲染出 <br> 换行')
  // 双击这个多行节点,种子应带回换行(而非丢成一行)
  await page.locator(NODE).filter({ hasText: '行一' }).first().dblclick()
  await page.waitForSelector('.mmp-inline', { timeout: 3000 })
  ok((await page.locator('.mmp-inline').inputValue()).includes('\n'), '多行节点双击回填的种子保留换行')
  await page.locator('.mmp-inline').press('Escape')
  await page.waitForTimeout(300)

  // ── 11e. 浮动中心(1.5.0):每个 # 中心 = 一张独立卡片 / 独立 markmap svg,无中枢连一起(不是空虚拟根挂各 H1)──
  const TWO_CENTER = '---\nmindmap: {"1":[520,60]}\n---\n# 主中心\n- a\n- b\n# 浮动中心\n- x\n- y\n'
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, TWO_CENTER)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await page.waitForTimeout(400)
  const layout = await page.evaluate(() => ({
    cards: document.querySelectorAll('.mmp-canvas .mmp-center').length,
    svgs: document.querySelectorAll('.mmp-canvas svg.mmp-svg').length,
    floatLeft: document.querySelector('.mmp-center[data-center="1"]') && document.querySelector('.mmp-center[data-center="1"]').style.left,
    noEmptyNode: [...document.querySelectorAll('g.markmap-node .markmap-foreign')].every((n) => (n.textContent || '').trim() !== ''),
  }))
  ok(layout.cards === 2, `两个中心 = 2 张独立卡片 (${layout.cards})`)
  ok(layout.svgs === 2, `每个中心一个独立 markmap svg,无中枢 (${layout.svgs})`)
  ok(layout.floatLeft === '520px', `浮动中心停在存档坐标 520px (${layout.floatLeft})`)
  ok(layout.noEmptyNode, '没有空的中枢节点(旧多中心会有一个空虚拟根)')
  const twoCenterMap = await checkEditMapping(page)
  ok(twoCenterMap.bad.length === 0, `浮动多中心:${twoCenterMap.checked} 个节点双击均命中自身原文`, twoCenterMap.bad.join(' / '))

  // ── 11f. 浮动中心可拖动,坐标写回 frontmatter(重开保留)──
  const title = page.locator(NODE).filter({ hasText: '浮动中心' }).first()
  const tbox = await title.boundingBox()
  await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tbox.x + tbox.width / 2 + 140, tbox.y + tbox.height / 2 + 90, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(700)
  const dragged = await page.evaluate(() => ({
    left: document.querySelector('.mmp-center[data-center="1"]').style.left,
    md: window.__md(),
  }))
  ok(parseFloat(dragged.left) > 520, `拖动后浮动中心 left 增大 (${dragged.left})`)
  const px = (dragged.md.match(/"1":\[(-?\d+),/) || [])[1]
  ok(px !== undefined && parseInt(px, 10) > 520, `拖动坐标写回 frontmatter,x 增大到 ${px}`)

  // ── 11c. 嵌入块也要跟随主题切换(不重挂)—— 编辑器修过一次,嵌入块当时漏了 ──
  await page.evaluate(() => window.__setDark(false))
  await page.evaluate(() => window.__mountEmbed('t.mindmap.md'))
  await page.waitForSelector(`.mmp-embed ${NODE}`, { timeout: 5000 })
  await page.evaluate(() => window.__setDark(true)) // 关键:切完**不重挂**
  await page.waitForTimeout(300)
  const embedFollow = await page.locator(`.mmp-embed ${NODE}`).first().evaluate((e) => getComputedStyle(e).color)
  ok(lum(embedFollow) > 0.5, `嵌入块切暗色后(不重挂)自己跟上 (${embedFollow}) —— 主题订阅闸`)
  await page.evaluate(() => window.__setDark(false))

  // ── 12. 导出 PNG / PDF / Markdown ──
  await page.evaluate((md) => { window.__files['t.mindmap.md'] = md; window.__mount() }, SAMPLE)
  await page.waitForSelector(NODE, { timeout: 5000 })
  await settle(page)

  await page.locator('.mmp-exp button[data-x="png"]').click()
  await page.waitForTimeout(1200)
  const png = await page.evaluate(() => window.__lastDownload())
  ok(!!png && /\.png$/.test(png.name), `导出 PNG 文件名正确 (${png && png.name})`)
  ok(!!png && png.head.slice(0, 4).join(',') === '137,80,78,71', 'PNG 魔数正确(确实是 PNG 而非空 blob)')
  const ink = await page.evaluate(() => window.__lastDownloadInk())
  // 关键:markmap 的节点文字都在 foreignObject 里,而 Chromium 一旦把含 foreignObject 的 SVG 画进 canvas
  // 就会污染画布(toBlob 抛 SecurityError)→ 导出必须先把它转成原生 <text>。这条断言守着那条转换真的有内容。
  ok(!!ink && ink.inkRatio > 0.005, `PNG 确实画上了内容而非空白 (内容像素 ${ink && (ink.inkRatio * 100).toFixed(1)}%, ${ink && ink.w}×${ink && ink.h})`)
  ok(!!ink && Math.abs(ink.bgLum - ink.inkLum) > 0.3, `浅色导出:底与内容反差足够 (底 ${ink && ink.bgLum.toFixed(2)} / 内容 ${ink && ink.inkLum.toFixed(2)})`)
  ok(!!ink && ink.bgLum > 0.5, `浅色主题导出的是浅底 (${ink && ink.bgLum.toFixed(2)})`)

  // 暗色主题下导出:必须**铺深色底**。曾经导出透明底 + 浅色文字 → 贴进任何浅色文档就是一片空白,
  // 而「不透明像素占比」那种断言完全看不出来(靠肉眼看导出图才发现)。
  await page.evaluate(() => window.__setDark(true))
  await page.waitForTimeout(300)
  await page.locator('.mmp-exp button[data-x="png"]').click()
  await page.waitForTimeout(1500)
  const inkDark = await page.evaluate(() => window.__lastDownloadInk())
  ok(!!inkDark && inkDark.bgLum < 0.5, `暗色主题导出的是深底而非透明 (${inkDark && inkDark.bgLum.toFixed(2)})`)
  ok(!!inkDark && inkDark.inkLum - inkDark.bgLum > 0.3, `暗色导出:浅内容压深底,看得清 (底 ${inkDark && inkDark.bgLum.toFixed(2)} / 内容 ${inkDark && inkDark.inkLum.toFixed(2)})`)
  await page.evaluate(() => window.__setDark(false))
  await page.waitForTimeout(300)

  await page.locator('.mmp-exp button[data-x="pdf"]').click()
  await page.waitForTimeout(1500)
  const pdf = await page.evaluate(() => window.__lastDownload())
  ok(!!pdf && /\.pdf$/.test(pdf.name), `导出 PDF 文件名正确 (${pdf && pdf.name})`)
  ok(!!pdf && pdf.head.slice(0, 4).join(',') === '37,80,68,70', 'PDF 魔数 %PDF 正确')
  ok(!!pdf && pdf.size > 3000, `PDF 体积合理(内嵌了图像而非空壳) ${pdf && pdf.size}B`)

  await page.locator('.mmp-exp button[data-x="md"]').click()
  await page.waitForTimeout(300)
  const mdDl = await page.evaluate(async () => {
    const d = window.__dl[window.__dl.length - 1]
    const blob = await (await fetch(d.url)).blob()
    return { name: d.name, text: await blob.text() }
  })
  ok(/\.md$/.test(mdDl.name), `导出 Markdown 文件名正确 (${mdDl.name})`)
  ok(mdDl.text === SAMPLE, '导出的 Markdown 与源文件逐字一致')

  // ── 13. 斜杠块:选中即「新建一份思维导图 + 就地插入嵌入块」 ──
  const slash = await page.evaluate(() => {
    const s = window.__reg.slash
    return s && { id: s.id, label: s.label, group: s.group, hasRun: typeof s.run === 'function', hasScaffold: 'scaffold' in s }
  })
  ok(!!slash && slash.label === '思维导图', `注册了斜杠块项 (${slash && slash.label} / 组 ${slash && slash.group})`)
  ok(!!slash && slash.hasRun && !slash.hasScaffold, '斜杠项走 run(动态新建)而非静态 scaffold')
  const picked = await page.evaluate(async () => {
    const before = Object.keys(window.__files).length
    const md = await window.__reg.slash.run({ pagePath: '笔记/日记.md', folder: '笔记/日记.fd' })
    const created = Object.keys(window.__files).filter((p) => /\.mindmap\.md$/.test(p) && p !== 't.mindmap.md')
    return { md, created, grew: Object.keys(window.__files).length > before, body: window.__files[created[0]] }
  })
  ok(picked.grew && picked.created.length === 1, `选中后真的新建了文件 (${picked.created.join(',')})`)
  ok(picked.created[0].startsWith('笔记/日记.fd/'), `新文件落在笔记自己的 .fd 文件夹 (${picked.created[0]})`)
  ok(picked.md === `![[${picked.created[0]}]]`, `插入的是指向它的嵌入块 (${picked.md})`)
  ok(/^# /.test(picked.body || ''), '新文件是可用的空白导图模板')
  // 插入的 target 必须能被本插件的嵌入渲染器认领,否则宿主会把它当普通文件卡片
  const claimed = await page.evaluate((t) => window.__reg.embed.match(t), picked.md.slice(3, -2))
  ok(claimed === true, '嵌入渲染器认领该 target(否则会退化成文件卡片)')
  // 重名不覆盖:同一文件夹再来一次应得到另一个文件
  const second = await page.evaluate(async () => window.__reg.slash.run({ pagePath: '笔记/日记.md', folder: '笔记/日记.fd' }))
  ok(second !== picked.md, `同文件夹重复新建不撞名 (${second})`)
  // 并发新建(连点两次 / 慢盘):探测重名与写盘不是原子的,不串行化就会两次返回同一路径 → 一个文件两个嵌入
  const conc = await page.evaluate(async () => {
    const cx = { pagePath: '并发/N.md', folder: '并发/N.fd' }
    const [a, b, c] = await Promise.all([window.__reg.slash.run(cx), window.__reg.slash.run(cx), window.__reg.slash.run(cx)])
    return { uniq: new Set([a, b, c]).size, files: Object.keys(window.__files).filter((p) => p.startsWith('并发/N.fd/')).length }
  })
  ok(conc.uniq === 3 && conc.files === 3, `并发三次新建得到三个不同文件 (${conc.uniq} 个路径 / ${conc.files} 个文件)`)

  // 旧宿主(没有 registerSlashItem/registerFileCreator)不得让整个插件装载失败 —— setup 抛错会连
  // 文件类型/嵌入渲染一起丢掉,表现为「插件整个坏了」而不是「少个菜单项」。
  const legacy = await page.evaluate(async () => {
    const res = await fetch('../main.js')
    const src = await res.text()
    const bare = { registerFileType: () => {}, registerEmbedRenderer: () => {}, registerCommand: () => {},
      app: { readFile: async () => null, writeFile: async () => {}, openFile: () => {}, notify: () => {} } }
    try { new Function('ctx', src)(bare); return 'ok' } catch (e) { return String(e && e.message) }
  })
  ok(legacy === 'ok', `缺可选扩展点的旧宿主仍能装载插件 (${legacy})`)

  await browser.close()
  srv.close()
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
