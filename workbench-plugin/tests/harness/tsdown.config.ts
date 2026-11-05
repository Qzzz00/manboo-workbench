/**
 * 真实 React 验收 harness 的打包配置(2026-10-23,卡「图谱显示修复与Archify接入」)。
 *
 * react / react-dom 必须打**进**包里(iife 单文件,浏览器直接 <script> 引):
 * 默认 peerDependencies 会被 external 成全局引用,页面里没有那些全局,跑不起来。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  entry: [join(here, 'workbench-harness-entry.tsx')],
  format: ['iife'],
  outDir: join(here, 'dist'),
  deps: {
    alwaysBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'scheduler'],
  },
  // react-dom 的 cjs 构建在模块初始化期就读 process.env.NODE_ENV(import 先于入口体执行,
  // 运行时 shim 来不及),只能在构建期替掉
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  minify: false,
})
