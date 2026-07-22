// 打包 src/index.ts(含 markmap-lib / markmap-view)→ 单文件 IIFE main.js。
//  - format:'iife' + minify → 顶层无 import/export,过 Amadeus 的「main.js 必须是裸 setup 体」闸;
//  - `ctx` 是自由变量,由宿主 new Function('ctx', code) 注入,esbuild 原样保留其引用;
//  - dist(main.js)必须提交并与 src 同步(市场装 zip 不构建)—— 改 src 后务必重跑本脚本。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
})
console.log('built main.js')
