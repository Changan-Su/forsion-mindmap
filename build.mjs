// 打包 src/index.tsx(含 React + 画布)→ 单文件 IIFE main.js。
//  - format:'iife' → 顶层无 import/export,过 Amadeus 的「main.js 必须是裸 setup 体」闸;
//  - `ctx` 是自由变量,由宿主 new Function('ctx', code) 注入,esbuild 原样保留其引用;
//  - React **内联进包**:插件跑在 new Function 里,拿不到宿主的模块图。两份 React 共存没问题 ——
//    边界是一个 DOM 节点(ctx.app.mountBlocks 让宿主在里面渲染它自己的块),不跨实例传 element。
//  - .css 当文本进包,运行时注入 <style>(插件没有构建期样式管线)。
//  - dist(main.js)必须提交并与 src 同步(市场装 zip 不构建)—— 改 src 后务必重跑本脚本。
import { build } from 'esbuild'

const dev = process.argv.includes('--dev')

const out = await build({
  entryPoints: ['src/index.tsx'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  logLevel: 'info',
})

const bytes = out.metafile.outputs['main.js'].bytes
console.log(`built main.js (${(bytes / 1024).toFixed(0)} KB)`)
