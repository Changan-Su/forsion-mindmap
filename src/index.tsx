// 思维导图插件入口。由 Amadeus 以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载,故:
//  - `ctx` 是宿主注入的自由变量;
//  - 打包产物顶层不得有 import/export(esbuild format:'iife' 满足「main.js 必须是裸 setup 体」闸)。
//
// 3.0.0 起本插件是**捆绑包(bundle)**:画布本体 + 随包技能(skills/mindmap-format,教 agent 写
// `.mindmap.md` 的格式)。此前 2.x 用 markmap 渲染(纯只读树,节点是纯文本);现在节点是**真 Amadeus 块** ——
// 靠宿主 2.7.0 的「块表面」seam(ctx.app.mountBlocks),块的内容/编辑/slash/`![[嵌入]]` 全归宿主渲染。
//
// 为什么是插件而不是宿主内置:内置与外置的唯一区别应当是「提前装好了」。这套界面曾经只能做进宿主,
// 那不是设计而是缺口 —— 缺口补上(seam)之后,它就该回到插件里,与第三方插件同一条起跑线。
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { hasBlockSurface, makeHostStore, HostStoreProvider, type AppApi, type PageSourceApi } from './host'
import { MindmapCanvas } from './MindmapCanvas'
import css from './mindmap.css'

const SUFFIX = '.mindmap.md'
const isMindmapPath = (p: string): boolean => /\.mindmap\.md$/i.test(p)
const baseOf = (p: string): string => (p.split(/[\\/]/).pop() || p).replace(/\.mindmap\.md$/i, '')

// 宿主注入(new Function('ctx', code) 的形参)。类型只为作者便利,打包后会被抹掉。
declare const ctx: {
  app: AppApi
  registerFileType(def: unknown): boolean | void
  registerFileCreator(def: unknown): void
  registerEmbedRenderer(def: unknown): void
  registerCommand(def: unknown): void
  registerSlashItem(def: unknown): void
  notify?(msg: string, opts?: { level?: 'info' | 'warning' | 'error'; title?: string }): void
  activity?: { log(event: string, detail?: Record<string, unknown>): void }
}

/** 注册一个**可选**扩展点:宿主可能是还没有它的旧版本。缺了就跳过这一项,别让整个 setup 抛。 */
function tryRegister(name: keyof typeof ctx, def: unknown): void {
  const fn = ctx[name]
  if (typeof fn !== 'function') return
  try {
    ;(fn as (d: unknown) => void).call(ctx, def)
  } catch (e) {
    console.error(`[mindmap] ${String(name)} 注册失败`, e)
  }
}

// ── 样式 ────────────────────────────────────────────────────────────────────────
// 配色全部走 .am-app 上的真实主题 token,所以这里只注入布局,主题切换自动跟随。
function injectCss(): void {
  const ID = 'forsion-mindmap-css'
  // 恒覆写 textContent:插件热更新(禁用→装新版→启用,渲染进程不重启)时旧 <style> 还挂着,
  // 只查存在性会让新版顶着旧样式跑(画布插件评审 P2,同款回访修掉)。
  let el = document.getElementById(ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = ID
    document.head.appendChild(el)
  }
  el.textContent = css
}

// ── 文件视图 ────────────────────────────────────────────────────────────────────
// 有 file.surface(2026-08-14 宿主)= per-view 作用域:多张图、图与笔记并存编辑,无互斥。
// 旧宿主(无 surface)回落 ctx.app 的单活页门面,保留「点击加载」互斥占位。
function MindmapFileView({ path, surface }: { path: string; surface?: PageSourceApi }): JSX.Element {
  const store = useMemo(() => makeHostStore(surface ?? (ctx.app as AppApi)), [surface])
  const scoped = !!surface
  const activePage = store.use((s) => s.activePage)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    void (async () => {
      // ⚠️ loadPage 对不存在的路径会**建**一份空白页。所以打开前必须确认文件真在库里,否则一条
      // 已删除的旧条目(树没刷新 / 最近文件 / 恢复的 tab)会把这张图凭空复活。
      const text = await ctx.app.readFile(path)
      if (cancelled) return
      if (text === null) {
        setMissing(true)
        return
      }
      if (store.getActivePage() !== path) store.loadPage(path)
    })()
    return () => {
      cancelled = true
    }
  }, [path, store])

  if (missing && activePage !== path)
    return <div className="amx-pane mmv-pane mmv-state">找不到「{baseOf(path)}」—— 该文件可能已被删除或移动。</div>
  if (activePage !== path) {
    // scope 化:这里只是首载在途(通常一眨眼),给骨架不给空白/转圈(Genesis 骨架屏铁律)。
    if (scoped)
      return (
        <div className="amx-pane mmv-pane mmv-state">
          <div className="mmv-skel" aria-hidden>
            <i />
            <i />
            <i />
          </div>
        </div>
      )
    return (
      <div className="amx-pane mmv-pane mmv-state">
        <button
          className="mmv-empty-btn"
          onClick={() =>
            void (async () => {
              // 复用挂载守卫:loadPage 对不存在的路径会**建**空白页,按钮点下时文件可能已被删
              // (画布插件评审抓的同款,回访修掉)。
              const t = await ctx.app.readFile(path)
              if (t === null) {
                setMissing(true)
                return
              }
              store.loadPage(path)
            })()
          }
        >
          点击加载「{baseOf(path)}」
        </button>
        <div className="mmv-empty-hint">另一处编辑器/导图正在显示其它文件(旧版 Forsion:同一时刻只能编辑一处)。</div>
      </div>
    )
  }
  return (
    <div className="amx-pane mmv-pane">
      <HostStoreProvider value={store}>
        <MindmapCanvas />
      </HostStoreProvider>
    </div>
  )
}

/** 新建一张图。内容就是图名一行:编译器对没有 amadeus_page 的外来 markdown 走 importForeign,
 *  正好落成「一个块 = 中心节点,内容 = 图名」——XMind 的中心主题。 */
async function createAt(folder: string, stem: string): Promise<string | null> {
  const dir = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = stem.trim().replace(/[\\/]/g, '').replace(/\.mindmap(\.md)?$/i, '')
  if (!name) return null
  const rel = dir ? `${dir}/${name}${SUFFIX}` : `${name}${SUFFIX}`
  // ⚠️ 撞名必须自己挡:writeFile 是「有则覆盖」,直接写会把同名的图整份抹掉。
  // 也不能靠宿主改名 —— 它把 `-N` 插在最后一个扩展名前(`x.mindmap-1.md`),复合后缀一破就掉出
  // 导图判定、混回笔记树被编译器改写 = 毁档。
  if ((await ctx.app.readFile(rel)) !== null) {
    ctx.notify?.(`「${name}${SUFFIX}」已存在`, { level: 'warning' })
    return null
  }
  await ctx.app.writeFile(rel, `${name}\n`)
  ctx.activity?.log('create', { f: rel })
  return rel
}

async function promptCreate(folder: string): Promise<string | null> {
  const label = folder ? `在「${folder.split('/').pop()}」中新建思维导图` : '新建思维导图'
  const name = await ctx.app.prompt(label, '未命名思维导图')
  if (!name) return null
  const rel = await createAt(folder, name)
  if (rel) ctx.app.openFile(rel)
  return rel
}

// ── setup ───────────────────────────────────────────────────────────────────────
if (!hasBlockSurface(ctx.app)) {
  // 老宿主没有块表面 → 画布无从渲染。明说一句,别注册半套入口让用户点开一片空白。
  ctx.notify?.('思维导图需要 Forsion 2.7.0 及以上(块表面 API)', { level: 'error', title: '思维导图' })
} else {
  injectCss()

  // 宿主可能仍把 `.mindmap.md` 当内置类型(返回 false)→ 整体退让,连「新建」入口也不注册,
  // 否则用户会看到两个「新建思维导图」。
  const refused =
    ctx.registerFileType({
      id: 'mindmap',
      extensions: [SUFFIX],
      icon: 'mindmap', // 宿主图标词表(非 emoji)→ 与内置项同一套 SVG
      title: '思维导图',
      // 树键+关系线键都归导图私有:宿主属性面板对本类型文件隐藏(手改毁图;模型全量往返不会被抹)。
      // 旧宿主不认识该字段,无害。= mmMap.ts MM_FM_KEY / MM_REL_FM_KEY(漏 rel = 关系线裸露可删,Codex P0)。
      fmKeys: ['mindmap', 'mindmap_rel'],
      mount(el: HTMLElement, file: { filePath: string; surface?: PageSourceApi }) {
        const root = createRoot(el)
        root.render(<MindmapFileView path={file.filePath} surface={file.surface} />)
        // React 18+ 不许在渲染周期里同步 unmount(宿主常在自己的 effect 清理里调本函数)→ 推迟一拍。
        return () => queueMicrotask(() => root.unmount())
      },
    }) === false

  if (!refused) {
    tryRegister('registerFileCreator', {
      id: 'new-mindmap',
      label: '新建思维导图',
      icon: 'mindmap', // 宿主图标词表(非 emoji)→ 与内置项同一套 SVG
      run: (parent: string) => promptCreate(parent || ''),
    })

    tryRegister('registerCommand', {
      id: 'new-mindmap',
      title: '思维导图:新建',
      run: () => void promptCreate(''),
    })

    // 笔记里打 `/` → 在这篇笔记自己的附件文件夹里建一份并就地嵌入(与内置「数据库 / 画板」同一套)。
    tryRegister('registerSlashItem', {
      id: 'mindmap',
      label: '思维导图',
      hint: SUFFIX,
      icon: 'mindmap', // 宿主图标词表(非 emoji)→ 与内置项同一套 SVG
      group: '高级',
      keywords: 'mindmap mind map 思维导图 导图 脑图 naotu daotu siwei xmind 分支 branch',
      async run(cx: { pagePath: string; folder: string }) {
        // 名字用时间戳而不是「未命名」:同一篇笔记里插第二张时不撞名(撞名会被上面的检查挡掉,
        // 用户得到的是一次失败而不是一张新图)。
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
        const rel = await createAt(cx.folder, `思维导图 ${stamp}`)
        return rel ? `![[${rel}]]` : ''
      },
    })

    // `![[x.mindmap.md]]`:给一张卡片,不渲染画布 —— 单活页模型下第二张图会把正在编辑的那张顶掉。
    tryRegister('registerEmbedRenderer', {
      id: 'mindmap-card',
      match: (target: string) => isMindmapPath(target),
      mount(el: HTMLElement, embed: { target: string }) {
        // 用宿主自己的 embed-file 类名:文件卡的样式归主题管,插件复刻一套只会在换主题时穿帮。
        const btn = document.createElement('button')
        btn.className = 'embed-file'
        btn.title = '在 Forsion 标签页中打开'
        for (const [cls, text] of [
          ['embed-file-ic', '🧠'],
          ['embed-file-name', embed.target.split(/[\\/]/).pop() || embed.target],
          ['embed-file-open', '打开 ↗'],
        ]) {
          const s = document.createElement('span')
          s.className = cls
          s.textContent = text
          btn.appendChild(s)
        }
        const open = (): void => ctx.app.openFile(embed.target)
        btn.addEventListener('click', open)
        el.appendChild(btn)
        return () => {
          btn.removeEventListener('click', open)
          btn.remove()
        }
      },
    })
  }
}
