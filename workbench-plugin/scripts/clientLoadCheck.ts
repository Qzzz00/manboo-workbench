/**
 * 「网页端能加载」的判法(2026-10-22,发版底座卡;决策记录 10-21 晚统筹定)。
 * 本机闸(`deploy/local-install-gate.sh`)与新机器演练(`pnpm rehearse`)都经 `scripts/client-load-check.ts` 调它。
 *
 * 0.4.143 第一次打包时插件服务起来了、`/state` 200,而 DSH 页面里插件 UI 一片空白:客户端产物里残留
 * `process.env.NODE_ENV`,页面里没有 process,模块一加载就抛。所以这里照 DSH 页面的样子摆:
 *
 * - 一个 jsdom 窗口,**没有 process**,产物当一段页面脚本在窗口那一侧求值(`window.eval`)。产物的形状是 DSH
 *   页面自己的装载口:`window.__ModuleLoader__.load({ id, factory: (require) => module.exports })`(tsdown.config.ts 的 banner),
 *   这里摆一个同名的 `load` 收下登记,再拿宿主那几个模块调一次 `factory`;
 * - `require` 只给宿主真给的那几个(react、react/jsx-runtime、dsh-client-store;同 tsdown.config.ts 的客户端外部依赖),
 *   store 的 `defineStore` 用一个只记形状的替身 —— 它在宿主那边是平台模块,这里不跑它;
 * - 调导出的 `apply(ctx)`,`ctx.slots.inject` 当场执行回调;**主界面那一格(`shell.overlay`)注册上了才算过**。
 *
 * 不渲染组件:要验的是「装得进页面、注册得上」,渲染出错由界面自己的用例管。
 * 这个文件在 scripts/ 下、不进插件产物(它要 jsdom,那是开发依赖)。
 */
import { createRequire } from 'node:module'

/** 主界面挂的那一格。它没注册上,整个工作台在页面里就不存在。 */
export const CLIENT_REQUIRED_SLOT = 'shell.overlay'

export interface ClientLoadResult {
  ok: boolean
  /** 注册上了哪几格(按顺序)。 */
  slots: string[]
  error?: string
  /** 出错时栈的前几行(定位用:产物里哪一处)。 */
  stack?: string[]
}

const localRequire = createRequire(import.meta.url)

/** jsdom 用到的那一点(仓库里没有它的类型包,为一个构造器不值得加)。 */
interface JsdomWindow { eval: (source: string) => unknown, close: () => void, __ModuleLoader__?: unknown }
const { JSDOM } = localRequire('jsdom') as { JSDOM: new (html: string, options: object) => { window: JsdomWindow } }

/** 宿主给插件的那几个模块。别的一律当「宿主不给」。 */
function hostModule(name: string): unknown {
  if (name === 'react' || name === 'react/jsx-runtime') return localRequire(name)
  if (name === '@deepseek-ai/dsh-client-store') {
    return { defineStore: (definition: unknown) => ({ definition }) }
  }
  throw new Error(`页面里没有模块「${name}」(宿主只给 react、react/jsx-runtime、@deepseek-ai/dsh-client-store)`)
}

export function checkClientBundle(code: string): ClientLoadResult {
  const slots: string[] = []
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://127.0.0.1:3080/' })
  try {
    const registrations: { id?: unknown, factory?: unknown }[] = []
    const window = dom.window
    window.__ModuleLoader__ = { load: (registration: { id?: unknown, factory?: unknown }) => { registrations.push(registration) } }
    window.eval(code)
    const registration = registrations[0]
    if (registration === undefined || typeof registration.factory !== 'function') {
      return { ok: false, slots, error: '产物执行完了,但没向页面登记自己(window.__ModuleLoader__.load)—— 宿主找不到这个插件' }
    }
    const exported = (registration.factory as (require: (name: string) => unknown) => unknown)(hostModule)
    const apply = typeof exported === 'object' && exported !== null ? (exported as Record<string, unknown>).apply : undefined
    if (typeof apply !== 'function') return { ok: false, slots, error: '客户端产物没有导出 apply —— 宿主拿它没法装' }
    const noop = (): void => {}
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return noop },
        register: (options: { name?: unknown }) => {
          slots.push(typeof options?.name === 'string' ? options.name : '(没名字)')
          return noop
        },
      },
      uiWorkspace: { openSession: noop, connectWorkspace: async () => '' },
    }
    ;(apply as (context: unknown) => void)(ctx)
    if (!slots.includes(CLIENT_REQUIRED_SLOT)) {
      return { ok: false, slots, error: `执行完了,但主界面那一格(${CLIENT_REQUIRED_SLOT})没注册上` }
    }
    return { ok: true, slots }
  }
  catch (error) {
    // 产物在窗口那一侧求值,抛出来的是窗口那个 realm 的 Error —— `instanceof Error` 认不得,按形状读。
    const shaped = typeof error === 'object' && error !== null ? error as { message?: unknown, stack?: unknown } : {}
    const stack = typeof shaped.stack === 'string' ? shaped.stack.split('\n').slice(1, 6).map(line => line.trim()) : undefined
    return {
      ok: false,
      slots,
      error: `在页面里加载就出错了:${typeof shaped.message === 'string' ? shaped.message : String(error)}`,
      ...(stack === undefined ? {} : { stack }),
    }
  }
  finally {
    dom.window.close()
  }
}
