# 思维导图 mindmap

Forsion / Amadeus 插件:把 markdown 大纲变成一等的思维导图文件类型。基于开源 [markmap](https://github.com/markmap/markmap),全部离线。

这是**首个用到 Amadeus 文件类型扩展点**的插件(`ctx.registerFileType` / `ctx.registerEmbedRenderer` / `ctx.app.readFile·writeFile·openFile`,配合 manifest 的 `fileExtensions`)——可当作第三方新增文件类型的参考实现。

## 能力

- **一等文件类型 `.mindmap.md`**:文件树里有专属图标(🧠)、点击即在应用内打开专属视图,和白板 / 笔记同级。
- **图内编辑(MindNode 式)**:单击选中、双击就地内联改名;选中态 **Enter 加同级**、**Tab 加子级**、**Delete 删子树**、方向键按视觉方向导航。改动即时回写底层 markdown。
- **多个中心节点**:画布空白处双击新建一个独立中心(底层 = markdown 里再起一个 `# 段`;markmap 对多 H1 的原生建树就是「空虚拟根 + 各中心」)。
- **缩放 / 回到中心**:左下角 `−` `100%` `＋` `⤢`;`⇧1` 适应全图,`⌘/Ctrl ±0` 缩放与重置。
- **导出**:顶栏右侧 PNG / PDF / MD。PNG、PDF 是整图矢量文字(非截屏),跟随当前深浅主题。
- **源码模式**:顶栏「源码」切到 textarea,直接编辑 markdown;切回导图即渲染。
- **双链嵌入**:任意笔记里 `![[你的图.mindmap.md]]` 内联一个只读导图预览块。
- **新建**:文件树右键「新建思维导图」,或命令面板「思维导图:新建」。

底层就是普通 markdown —— 标题 + 缩进列表就是树,和 markmap 一致;因此源码模式看到的就是文件真身,可被任何 markdown 工具读写。

图内编辑只在文档是「简单大纲」时开放,判据不是拍脑袋的启发式:每次渲染都会拿**实际渲染用的 markmap 树**与本模型树逐节点比对源码行(`treesAligned`),不一致就退回源码模式 —— 从结构上排除「双击 A 改到 B」。含二级标题 / 有序列表 / 续行等复杂结构时即属此列。

## 命令

- **思维导图:新建**(`mindmap-new`)—— 在库根建 `思维导图.mindmap.md`(重名加序号)并打开。

## 安装

把本文件夹拷到 `~/.forsion/plugins/mindmap/`,在 设置 → 社区插件 里启用即可。**至少需要包含** `manifest.json` 与构建产物 `main.js`(见下)。

> 依赖宿主支持文件类型扩展点(`registerFileType` 等)。旧版 Amadeus 无此扩展点时,`.mindmap.md` 会被当普通文件、不能点击打开——升级宿主即可。

## 构建(改了 src 必看)

`main.js` 是 `src/index.ts`(含 markmap)经 esbuild 打成的单文件 **IIFE**(顶层无 import/export,`ctx` 由宿主注入)。**dist 必须与 src 同步并提交**:

```bash
npm install
npm run build      # → 生成 main.js
```

- `src/index.ts` —— 插件入口:注册文件类型 / 嵌入渲染 / 新建命令,以及 markmap 渲染 + 图内编辑的 DOM 胶水。
- `src/model.mjs` —— 纯大纲模型(大纲 ⇄ 树 + 改名/加子/加同级/删除),不碰 DOM,是编辑逻辑的真源。

## 自检

```bash
npm run verify   # = build + check + e2e,发版前跑这一条
```

两层:

```bash
npm run check    # 纯模型(解析/改名/加子/加同级/删除/转义/图内编辑门禁)+ 构建产物完整性
npm run e2e      # 真 chromium 装载真 main.js:深浅色 / 选中 / 缩放 / 内联编辑 / 多中心 / 三种导出
```

`harness/` 是真浏览器仪器(`playwright-core` + `~/Library/Caches/ms-playwright` 的 chromium,本地没有就借 Genesis desktop 那份;`CHROMIUM_EXE` 可覆盖)。**它的存在是有原因的**:深浅色不跟随、选中环被 `foreignObject` 裁掉、markmap 吃掉 dblclick 这几类 bug 纯靠肉眼手验全部漏过,只有真渲染 + 计算样式断言才抓得到。改图内交互/样式后必须跑。

⚠️ 改 harness 时守住一条:**它只能提供真宿主真有的东西**。`harness/mindmap.html` 里曾自定义了一整套 `--am-*` 变量,而 Amadeus 根本没有这套 token —— 于是深色测试一路绿灯、产品在真宿主里却是白底控件。同理,断言要挑「功能缺失时会失败」的判据(例:导出改成铺底色后,「不透明像素占比 > 0」恒真,等于没测)。

仍需人眼确认的只剩宿主集成:在 `Forsion-Genesis/desktop` dev 里 ① 树里 🧠 图标 ② 右键「新建思维导图」 ③ 别的笔记里 `![[x.mindmap.md]]` 渲成可预览导图块。
