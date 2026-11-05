import { builtinEnvironments } from 'vitest/runtime'

/**
 * Node 26.12.1 实测:即使未指定 --localstorage-file,也把 localStorage(取值
 * undefined,发一条 ExperimentalWarning)/ sessionStorage 以 own accessor 形式
 * 挂在 globalThis 上(本机内置 Node 24.19.0 与便携包 24.22.1 实测**没有**这两个
 * 属性,从哪个版本开始挂的未逐版本查证,这里只按实测版本写)。vitest 的 jsdom 环境(populateGlobal)用 `k in global`
 * 决定要不要把 jsdom window 的同名属性铺到 global:占位属性存在 → jsdom 的
 * 真实现被跳过,window.localStorage 在 Node 26 上是 undefined,客户端代码里
 * 带 try/catch 的存储路径全部静默失效。
 *
 * 这里在环境初始化前删掉 Node 自带的占位属性,其余原样委托给 vitest 自带的
 * jsdom 环境。vitest.config.ts 的 environment 指到本文件。
 */
delete (globalThis as { localStorage?: unknown }).localStorage
delete (globalThis as { sessionStorage?: unknown }).sessionStorage

export default {
  name: 'jsdom',
  viteEnvironment: 'client',
  setup: builtinEnvironments.jsdom.setup,
  setupVM: builtinEnvironments.jsdom.setupVM,
}
