import { describe, expect, it } from 'vitest'

/**
 * Node 26.12.1 实测:即使未指定 --localstorage-file,也把 localStorage 以 own
 * accessor 挂在 globalThis 上(取值 undefined,只发一条 ExperimentalWarning;
 * Node 24.19.0 / 24.22.1 实测无此属性)。vitest 的 jsdom 环境用 `k in global` 决定要不要把 jsdom
 * window 的同名属性铺到 global:Node 的占位属性存在 → jsdom 的真实现被跳过,
 * window.localStorage 跟着变成 undefined,客户端用例一批 0-test 全灭。
 * 环境包装(先删 Node 占位属性再交给 jsdom)见 tests/setup/jsdomEnv.ts。
 */
describe('Node 自带 web storage 不挡 jsdom 的 storage', () => {
  it('globalThis.localStorage 是 jsdom 实现,set/get 可用', () => {
    expect(globalThis.localStorage).toBeDefined()
    localStorage.setItem('node26-env-check', 'ok')
    expect(localStorage.getItem('node26-env-check')).toBe('ok')
    localStorage.removeItem('node26-env-check')
  })

  it('window.localStorage 与 globalThis 同一份', () => {
    expect(window.localStorage).toBeDefined()
    window.localStorage.setItem('node26-env-check-w', 'ok')
    expect(localStorage.getItem('node26-env-check-w')).toBe('ok')
    window.localStorage.removeItem('node26-env-check-w')
  })

  it('sessionStorage 同样不被 Node 占位属性挡住', () => {
    expect(globalThis.sessionStorage).toBeDefined()
    sessionStorage.setItem('node26-env-check-s', 'ok')
    expect(sessionStorage.getItem('node26-env-check-s')).toBe('ok')
    sessionStorage.removeItem('node26-env-check-s')
  })
})
