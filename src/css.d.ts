// esbuild 用 loader:{'.css':'text'} 把样式表当字符串进包(见 build.mjs)。
declare module '*.css' {
  const css: string
  export default css
}
