---
name: 思维导图文件格式
description: 当用户让你新建、扩充、重排或整理 Forsion 思维导图(`.mindmap.md`)——「做一张关于 X 的思维导图」「把这份大纲变成导图」「给导图加几个分支」「整理一下我的导图」——时,一定要用这个技能。导图不是缩进大纲:它是一张 Amadeus 页,节点是带 `<!-- a id -->` 标记的真块,树形关系存在 frontmatter 里。凭直觉写出来的文件打开会塌成一个巨大的节点。本技能给出可整份抄走的模板和一个交付前必须跑的校验脚本。
version: 3.1.0
author: Forsion
category: Forsion
---

# 思维导图文件格式(`.mindmap.md`)

## 心智模型

**导图不是一种新文件格式,它就是一张普通 Amadeus 页。** 一个节点 = 一个真块;树形关系是**旁挂**在页 frontmatter 上的一张映射表。

这个设计的好处是节点里能放富 markdown、图片、`![[嵌入]]`、数据库 —— 因为那本来就是块能做的事。代价是:**结构不在缩进里**,凭直觉写的缩进大纲一个节点都生成不出来。

## 照这份模板改

新建导图时抄它、改内容;扩充已有导图时照它的形状加块。

```markdown
---
amadeus_page: template-mindmap
mindmap: '{"why":{"p":"center","o":0},"why_a":{"p":"why","o":0},"why_b":{"p":"why","o":1},"how":{"p":"center","o":1},"how_a":{"p":"how","o":0},"next":{"p":"center","o":2}}'
mindmap_rel: '[{"f":"why_b","t":"how_a","l":"依赖"}]'
---
<!-- a center -->
中心主题

<!-- a why -->
为什么

<!-- a why_a -->
第一个理由

<!-- a why_b -->
第二个理由 —— 节点里可以写**任意 markdown**、`代码`、[链接](https://example.com)

<!-- a how -->
怎么做

<!-- a how_a -->
- [ ] 待办也可以
- [ ] 一个节点就是一个真正的 Amadeus 块

<!-- a next -->
下一步
```

读法:`center` 没出现在 `mindmap` 表里 → 它是根(中心主题)。其余每个块用 `p` 指向父、`o` 定同级次序。

## 三条会让整份文件塌成一个节点的规则

这三条不是风格偏好 —— 违反任何一条,用户打开看到的是**一个塞满全文的巨大节点**,树完全不存在。

### 1. 块 id 只能用 `[A-Za-z0-9_-]`,而且新写的**一律用下划线**

宿主解析块边界的正则是 `^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->\s*$`。除这个字符集之外的任何字符
(空格、中文、`.`、`:`……)都让该行**不被当作块边界**,整份塌成一个巨大节点。

```markdown
<!-- a ai.root -->     ❌ 不匹配 → 这行被当成正文
<!-- a ai_root -->     ✅
<!-- a ai-root -->     ⚠️ 新宿主认;2026-08-05 之前的旧端不认 —— 别新写
```

**连字符的历史**:2026-08-05 之前正则里没有 `-`,一份用 `ai-root`/`ai-what` 写出来的导图,
44 个标记在真解析器下只切出 1 个块。之后字符集补上了 `-`,所以**今天看到带连字符的 id 是合法的,
不要「顺手修好」它** —— 改 id 会把既有的 `![[笔记#id]]` 引用全部切断。但**新写的 id 仍用下划线**:
舰队里还有 08-05 之前的旧端(旧手机 App、未换代的云端 worker),下划线在所有代上都对。

### 2. frontmatter 必须有 `amadeus_page`

没有它,编译器认定这是「外来 markdown」,把整份内容原样收成一个块。值随便取个稳定字符串(这个键不受上面的字符限制)。

### 3. 结构在 `mindmap` 表里,不在缩进里

```markdown
- 中心主题
  - 分支一          ❌ 存成 .mindmap.md 就是一个块
```

## 用哪些工具读写

| 想干什么 | 用 | 别用 |
|---|---|---|
| 看真实结构 | `read_file` 绝对路径 | `amadeus_read_note` —— 它**剥掉 frontmatter**,你会看不到 `mindmap:` 关系表,只剩一堆没有归属的正文 |
| 写/改 | `write_file`(整份)或 `edit_file`(局部) | `amadeus_write_note` —— 契约是「纯 markdown 覆盖」且**会把布局重置成线性** |
| 找文件 | `amadeus_list_notes`(库相对路径)+ `glob_files` 定位绝对路径 | |

库根在你的 Amadeus 提示段里(常见 `~/Forsion/Amadeus`,开发版 `~/Forsion-Dev/Amadeus`)。

## 交付前跑这个校验器

写完别靠肉眼数。把下面这段存成 `check_mindmap.mjs`,`node check_mindmap.mjs <你的文件>` 跑一遍;它把宿主的规则镜像了一份,报出的每条都是会让用户打不开的真问题。

```javascript
import { readFileSync } from 'node:fs';
const raw = readFileSync(process.argv[2], 'utf8'); const errs = [], warns = [];
const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
const body = fm ? raw.slice(fm[0].length) : raw, head = fm ? fm[1] : '';
if (!/^amadeus_page:/m.test(head)) errs.push('缺 amadeus_page → 整份塌成一个块');
if (/^amadeus_layout:/m.test(head)) warns.push('写了 amadeus_layout,删掉(加载时会按实际块重建)');
const MARKER = /^<!--\s*a\s+([A-Za-z0-9_-]+)\s*-->\s*$/, LOOSE = /^<!--\s*a\s+(\S+)\s*-->\s*$/;
const ids = [], blocks = new Map(); let cur = null, buf = [];
const flush = () => { if (cur) blocks.set(cur, buf.join('\n').trim()); buf = []; };
for (const line of body.split('\n')) {
  const m = MARKER.exec(line), loose = LOOSE.exec(line);
  if (!m && loose) { errs.push(`块 id 非法: "${loose[1]}" → 该行不被当作块边界,整份塌成一个节点`); continue; }
  if (m) { flush(); cur = m[1]; if (ids.includes(cur)) errs.push(`id 重复: ${cur}`);
    if (cur.includes('-')) warns.push(`id "${cur}" 含连字符:新宿主认,08-05 之前的旧端不认。既有的别改(会切断 ![[笔记#id]]),新写的用下划线`);
    ids.push(cur); } else buf.push(line);
}
flush();
if (!ids.length) errs.push('没有合法块标记 → 打开就是一个节点');
for (const [id, c] of blocks) if (!c) errs.push(`块 ${id} 内容为空 → 画布上多一个空白散根`);
let map = {}; const mm = /^mindmap:\s*(.*)$/m.exec(head);
if (mm) { let s = mm[1].trim(); if (/^['"]/.test(s)) s = s.slice(1, -1);
  try { map = JSON.parse(s); } catch (e) { errs.push(`mindmap 不是合法 JSON: ${e.message}`); }
} else if (ids.length > 1) warns.push('没有关系表 → 每个块都是独立中心,不成树');
const known = new Set(ids);
for (const [id, n] of Object.entries(map)) {
  if (!known.has(id)) errs.push(`mindmap 里的 "${id}" 没有对应块(幽灵条目)`);
  if (n?.p !== undefined) { if (!known.has(n.p)) errs.push(`"${id}" 的父 "${n.p}" 不存在`); if (n.p === id) errs.push(`"${id}" 的父是自己`); }
}
for (const id of Object.keys(map)) { const seen = new Set([id]); let p = map[id]?.p;
  while (p) { if (seen.has(p)) { errs.push(`父子成环: ${[...seen, p].join(' → ')}`); break; } seen.add(p); p = map[p]?.p; } }
const roots = ids.filter((i) => map[i]?.p === undefined);
if (ids.length > 1 && roots.length === ids.length) warns.push('全是根节点 → 没有父子关系');
console.log(`块 ${ids.length} 个,根 ${roots.length} 个${roots.length ? ` (${roots.join(', ')})` : ''}`);
warns.forEach((w) => console.log(`⚠️  ${w}`)); errs.forEach((e) => console.log(`❌ ${e}`));
console.log(errs.length ? `\n不通过:${errs.length} 个问题` : '\n通过');
process.exit(errs.length ? 1 : 0);
```

跑出红的就改到全绿再交付。跑不了 node 就照它的检查项手工核一遍:id 字符集 / `amadeus_page` / 表里的 id 都有块 / 没有空块 / 没写 `amadeus_layout`。

## `mindmap` 表的字段

| 字段 | 含义 |
|---|---|
| `p` | 父节点块 id。缺省 = 它自己是根(可以有多个根) |
| `o` | 同一父级下的兄弟次序(0 起)。**顺序看这个,不看块在文件里的先后** |
| `xy` | `[x, y]` 手工拖过的坐标;缺省 = 交给自动布局 |
| `c` | `1` = 折叠。**只认 `=== 1`**(`"false"` 是 truthy,会出事) |
| `bd` | `1` = 该节点连同子树画边界框 |
| `sm` | `1` = 概要节点(括号罩住兄弟组) |

`mindmap_rel` 是**非树的关系线**:`[{"f":起点id,"t":终点id,"l":可选标签}]`。删块时把涉及它的关系线一并删掉。

## 几件容易忘的事

- **`amadeus_layout` 不要写。** 加载时会按实际存在的块重建;手写只会留下指向不存在块的幽灵引用。
- **改 frontmatter 要外科式改** —— 用户和别的插件的键也在同一份里,整段重写会抹掉它们。
- **绝不把导图数据塞进 `amadeus_layout`**:那个键有 zod 校验且没有 passthrough,未知字段加载时被静默 strip,写进去下次打开就没了。
- **换父级要清掉 `o`**(它只在同一父级内有意义)。
- **块 id 会被复用** → 删块时把 `mindmap` 里的对应条目也删掉,否则新块会继承旧的父级/折叠状态。
- **文件名的 `.mindmap.md` 一个字都不能破**。撞名时被改成 `x.mindmap-1.md` 就掉出导图判定、混回笔记树被编译器改写 = 毁档。所以新建时先确认目标文件名没被占用。

## 只要一个中心节点时

写一行纯文本存成 `<名字>.mindmap.md` 即可 —— 没有 `amadeus_page` 时编译器会把它收成单个块,正好落成「一个中心节点,内容 = 图名」。之后再按上面的模板加节点。
