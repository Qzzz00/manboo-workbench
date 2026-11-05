// @vitest-environment node
/**
 * 「网页端能加载」(2026-10-22,发版底座卡;决策记录 10-21 晚统筹定)。
 *
 * 0.4.143 第一次打包:插件起来了、`/state` 200,本机闸照样过 —— 而 DSH 页面里插件 UI 一片空白,
 * 「process is not defined」(客户端产物里残留 `process.env.NODE_ENV`,页面里没有 process)。
 * 所以本机闸与新机器演练都多一道:把要发的那份 `lib/client.js` 放进一个**没有 process 的** jsdom 窗口里执行,
 * 调它的 `apply()`,要看到主界面那一格(`shell.overlay`)注册上。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkClientBundle, CLIENT_REQUIRED_SLOT } from '../scripts/clientLoadCheck.ts'

/** 一份最小的「像插件客户端」的产物(DSH 页面装载口的形状,同 tsdown.config.ts 的 banner)。`body` 是 apply 里干的事。 */
function bundle(opts: { top?: string, body?: string } = {}): string {
  return [
    'window.__ModuleLoader__.load({ id: "@ben/dsh-workbench", factory: (require) => {',
    'var module = { exports: {} }; var exports = module.exports;',
    'const React = require("react");',
    'const store = require("@deepseek-ai/dsh-client-store");',
    opts.top ?? '',
    'exports.inject = ["slots", "uiWorkspace"];',
    'exports.apply = function apply(ctx) {',
    opts.body ?? `  ctx.slots.inject("${CLIENT_REQUIRED_SLOT}", () => ctx.slots.register({ name: "${CLIENT_REQUIRED_SLOT}", id: "x", store: store.defineStore({}) }, function C() { return React.createElement("div") }));`,
    '};',
    'return module.exports;',
    '} });',
  ].join('\n')
}

/** 同上,但把 `body` 原样当成 factory 里的代码(不带 apply 那一套)。 */
function raw(body: string): string {
  return `window.__ModuleLoader__.load({ id: "@ben/dsh-workbench", factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports; } });`
}

describe('checkClientBundle', () => {
  it('执行得了、apply 注册上了主界面那一格 → 过,并列出注册了哪几格', () => {
    const got = checkClientBundle(bundle())
    expect(got.ok).toBe(true)
    expect(got.slots).toEqual([CLIENT_REQUIRED_SLOT])
  })

  it('★模块顶上读 process.env(0.4.143 第一次的样子)→ 不过,话里有 process', () => {
    const got = checkClientBundle(bundle({ top: 'const mode = process.env.NODE_ENV;' }))
    expect(got.ok).toBe(false)
    expect(got.error).toContain('process')
  })

  it('apply 里抛了 → 不过,带上那句报错', () => {
    const got = checkClientBundle(bundle({ body: '  throw new Error("坏了")' }))
    expect(got.ok).toBe(false)
    expect(got.error).toContain('坏了')
  })

  it('执行得了但主界面那一格没注册 → 不过', () => {
    const got = checkClientBundle(bundle({ body: '  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "x" }, null));' }))
    expect(got.ok).toBe(false)
    expect(got.error).toContain(CLIENT_REQUIRED_SLOT)
    expect(got.slots).toEqual(['sidebar.footer.action'])
  })

  it('没导出 apply → 不过', () => {
    expect(checkClientBundle(raw('exports.inject = [];')).ok).toBe(false)
  })

  it('没向页面登记自己(不是装载口的形状)→ 不过,并说宿主找不到它', () => {
    const got = checkClientBundle('"use strict"; var exports = {}; exports.apply = function () {};')
    expect(got.ok).toBe(false)
    expect(got.error).toContain('__ModuleLoader__')
  })

  it('要了一个宿主不给的模块 → 不过,并说是哪一个', () => {
    const got = checkClientBundle(raw('require("left-pad"); exports.apply = () => {};'))
    expect(got.ok).toBe(false)
    expect(got.error).toContain('left-pad')
  })

  it('★构建出来的那份 lib/client.js(构建过才有):在没有 process 的页面里能加载、三格都注册上', () => {
    const file = join(__dirname, '..', 'lib', 'client.js')
    if (!existsSync(file)) return
    const got = checkClientBundle(readFileSync(file, 'utf8'))
    expect(got.error, got.stack?.join('\n')).toBeUndefined()
    expect(got.ok).toBe(true)
    expect(got.slots).toContain(CLIENT_REQUIRED_SLOT)
  }, 60_000)
})
