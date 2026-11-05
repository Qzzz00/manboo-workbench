import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'
import { buildEndpointDefines } from './scripts/build-endpoints.mjs'

// 版本号构建时注入(src/version.ts):从 package.json 读一次,两份产物都注入同一个值。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
// 中转与更新清单地址同样构建时注入(src/buildEndpoints.ts):我们的构建档有就带,开源构建是空。
const define = { __WORKBENCH_VERSION__: JSON.stringify(pkg.version), ...buildEndpointDefines() }

const id = '@ben/dsh-workbench'
const clientExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-store', // 0.1.2-rc.1 起 defineStore 搬到 store 包,且是平台模块(platform.ts PLATFORM_MODULES),由宿主提供
] as const

const config: UserConfig[] = [
  /**
   * `workbench` 命令行(2026-10-21 协作区):薄壳打本机 8791,只用 node 内置的 fetch,不打包任何依赖。
   * 单独一份产物,`package.json` 的 `bin` 指它。
   */
  {
    name: `${id}/cli`,
    entry: { workbench: 'src/cli/workbench.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    define,
    outputOptions: { banner: '#!/usr/bin/env node' },
  },
  {
    name: id,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    define,
  },
  {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    // 协作区的画布(@xyflow/react)带着 zustand,它读 `import.meta.env`(MODE)分开发 / 生产;
    // 客户端产物是 cjs 闭包,`import.meta` 会被换成空对象 —— 这里明说是生产(2026-10-21)。
    // 同一批库(zustand / use-sync-external-store)还读 `process.env.NODE_ENV`;DSH 页面里没有 process,
    // 不定义就「process is not defined」、整个插件起不来(2026-10-21 隔离实例撞到)。
    define: { ...define, 'import.meta.env': JSON.stringify({ MODE: 'production' }), 'process.env.NODE_ENV': JSON.stringify('production') },
    sourcemap: true,
    deps: {
      neverBundle: [...clientExternals],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]

export default config
