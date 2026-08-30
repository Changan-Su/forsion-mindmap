# 思维导图 mindmap

Forsion / Amadeus 插件:把想法摊成一张空间导图,**每个节点都是一个真正的 Amadeus 块**。全部离线。

> 3.0.0 是一次彻底重写。2.x 用 [markmap](https://github.com/markmap/markmap) 渲染,节点是单行纯文本;
> 现在节点是真块 —— 富 markdown、图片、`![[嵌入]]`、数据库表、斜杠命令,与笔记完全同一套。
> 这套界面 2026-07-24~26 曾短暂做进宿主(host-native),因为当时外置插件够不着块渲染;
> 2026-07-26 宿主补上了**块表面 seam**(`ctx.app.mountBlocks`),它就搬回插件了 ——
> **内置与外置的唯一区别应当是「提前装好了」**,缺能力就补接缝,不是把功能焊进宿主。

本插件因此也是**块表面 seam 的参考实现**:想做「节点/卡片里是真块」这类界面的插件,照 `src/host.tsx` 抄。

## 能力

- **一等文件类型 `.mindmap.md`**:文件树专属图标(🧠)、点击即在应用内打开,和白板 / 笔记同级。
- **节点即块**:双击或空格进编辑,里面就是普通 Amadeus 块 —— 打 `/` 出斜杠菜单、粘图片、写 `![[嵌入]]`、
  放一张数据库表都行。别的插件给块生态加的东西在导图里**自动**可用,不需要本插件改一行代码。
- **导图交互模型**(XMind / MindNode 那一套,不是笔记那一套):单击选中、双击/空格进编辑、Esc 退回;
  `Tab` 加子级、`Enter` 加同级、方向键按**视觉方向**导航、`⌫` 删子树、`⌥⌫` 只删本节点并提升子级。
- **结构操作**:拖节点改父级 / 调兄弟顺序(松手前有落点预览)、折叠分支并显示隐藏后代数、Shift 加选、
  框选、`⌘C`/`⌘V` 复制整棵子树(外部缩进大纲也能直接粘成树)、`⌘Z` 把块与结构一起回退。
- **非树语义**:关系线(任意两节点,可带标签)、边界(给子树画框)、概要(括号罩住一组兄弟)。
- **大纲侧栏**:与画布同步,点行即选中该节点。
- **导出**:Markdown 与 OPML(OPML 可导入 XMind 等)。
- **嵌入**:任意笔记里 `![[你的图.mindmap.md]]` 内联一张可点开的卡片。
- **随包技能**:`skills/mindmap-format/` —— 装上插件,Tangu 就知道 `.mindmap.md` 的真实格式,
  不会再写出「打开就塌成一个巨大节点」的文件。

## 文件格式

`.mindmap.md` 就是**一张普通 Amadeus 编译器页**:一个节点 = 一个真块(`<!-- a id -->` 标记),
树形关系旁挂在页 frontmatter 的 `mindmap:` 键上(`mindmap_rel:` 存关系线)。所以节点里能放任何块能放的东西。

完整规则与可整份抄走的模板见 `skills/mindmap-format/SKILL.md`;`skills/mindmap-format/template.mindmap.md`
是那份模板的可执行副本,`node check.mjs` 会拿宿主的解析规则验证它。

## 安装

把本文件夹拷到 `~/.forsion/plugins/mindmap/`,在 设置 → 插件 里启用。运行时**只需要**:

```
manifest.json  main.js  README.md  CHANGELOG.md  skills/
```

需要宿主 **2.7.0 及以上**(块表面 seam)。老宿主装上会弹一条提示并整体不注册,不会留下半截界面。

## 开发

```bash
npm install
npm run typecheck   # tsc
npm run test        # 纯逻辑单测(关系图 / 布局 / 大纲互转)
npm run build       # → main.js(esbuild IIFE,内联 React)
npm run check       # 产物 + 捆绑包形状 + 格式契约
npm run verify      # 以上全跑
```

`main.js` 是 `src/index.tsx` 经 esbuild 打成的单文件 **IIFE**(顶层无 import/export,`ctx` 由宿主注入)。
**产物必须与 src 同步并提交** —— 市场安装的是 zip,不会在用户机器上构建。

React 内联进包:插件跑在 `new Function('ctx', code)` 里,拿不到宿主的模块图。两份 React 共存没问题,
边界是一个 DOM 节点(`ctx.app.mountBlocks` 让宿主在里面渲染它自己的块)。

### 图形交互的实测

在 `Forsion-Genesis/desktop` 跑:

```bash
npm run e2e:mindmap
```

它**加载本仓库的 `main.js`**(默认按并排仓库找,可用 `MINDMAP_PLUGIN_MAIN` 指定),在真浏览器里验整条
「插件装载 → registerFileType → 插件文件视图 → 块表面 → 真块」接缝:卡片里真渲染真编辑、斜杠浮层不被画布
transform 带偏、数据库嵌入、拖拽改父级、撤销把块与结构一起回退,共 31 项。改了画布就跑它。
