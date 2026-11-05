/**
 * 页面连自己的服务端口 —— 页面这一半(2026-09-26,卡 GP)。宿主那一半与守门 grep 在
 * `server-service-origin.test.ts`(那边要 node 环境)。
 *
 * 撞出来的事:页面里的服务地址写死成 `http://127.0.0.1:8791`,而服务端的端口是
 * `WORKBENCH_PORT` 算出来的。于是灰度实例(DSH 3090 + 服务 8890)的页面把**所有**请求
 * 打到了生产的 8791 —— 统筹在灰度页面注册演示账号,被生产回了「这台电脑已经有账号了」。
 * 界面上看不出任何异常,这类沉默失效只有守门用例治得住。
 */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, serviceBaseUrlForPage } from '../src/client/index.ts'
import { DEFAULT_BASE_URL } from '../src/client/useWorkbenchState.ts'
import { createWorkbenchStore } from '../src/client/store.ts'
import { SERVICE_CONFIG_GLOBAL, readServiceBaseUrl, serviceBaseUrl } from '../src/serviceOrigin.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SERVICE_CONFIG_GLOBAL]
  vi.restoreAllMocks()
})

describe('服务地址怎么算', () => {
  it('通配地址收成回环:0.0.0.0 绑了所有网卡,而页面就在这台机器上', () => {
    expect(serviceBaseUrl('0.0.0.0', 8890)).toBe('http://127.0.0.1:8890')
    expect(serviceBaseUrl('::', 8791)).toBe('http://127.0.0.1:8791')
    // localhost 也收成 127.0.0.1:别让账号 cookie 落在两个域上。
    expect(serviceBaseUrl('localhost', 8791)).toBe('http://127.0.0.1:8791')
  })

  it('回环原样;显式配了局域网地址的旧用法原样留着(那一档回环上没人听)', () => {
    expect(serviceBaseUrl('127.0.0.1', 8890)).toBe('http://127.0.0.1:8890')
    expect(serviceBaseUrl('192.168.1.23', 8791)).toBe('http://192.168.1.23:8791')
  })

  it('读注入值:形状不对、协议不对一律 undefined —— 不编一个地址出来', () => {
    expect(readServiceBaseUrl({})).toBeUndefined()
    expect(readServiceBaseUrl({ [SERVICE_CONFIG_GLOBAL]: 'http://127.0.0.1:8890' })).toBeUndefined()
    expect(readServiceBaseUrl({ [SERVICE_CONFIG_GLOBAL]: { baseUrl: '' } })).toBeUndefined()
    expect(readServiceBaseUrl({ [SERVICE_CONFIG_GLOBAL]: { baseUrl: '8890' } })).toBeUndefined()
    expect(readServiceBaseUrl({ [SERVICE_CONFIG_GLOBAL]: { baseUrl: 'javascript:alert(1)' } })).toBeUndefined()
    // 结尾斜杠规范掉:下游是 `${baseUrl}/state` 这样拼的。
    expect(readServiceBaseUrl({ [SERVICE_CONFIG_GLOBAL]: { baseUrl: 'http://127.0.0.1:8890/' } }))
      .toBe('http://127.0.0.1:8890')
  })
})

describe('页面端:用注入进来的那个地址', () => {
  /** 装好插件,把浮层那一格的 inject 结果取出来(同 apply.test.ts 的做法)。 */
  async function overlayProps() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('uiWorkspace', { connectWorkspace: async () => 'session-1', openSession: vi.fn() } as never)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('shell.overlay')[0]!
    const instance = createWorkbenchStore().create()
    return (entry.inject as (actions: typeof instance.actions) => { serviceBaseUrl?: string })(instance.actions)
  }

  it('注入了 8890:浮层拿到的就是 8890(页面上每一处请求都从这一个 prop 往下传)', async () => {
    ;(globalThis as Record<string, unknown>)[SERVICE_CONFIG_GLOBAL] = { baseUrl: 'http://127.0.0.1:8890' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await overlayProps()).serviceBaseUrl).toBe('http://127.0.0.1:8890')
    expect(warn).not.toHaveBeenCalled()
  })

  it('没注入:不传这一项(于是退回兜底),并且在日志里说一句「没拿到服务地址,退回 8791」', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await overlayProps()).serviceBaseUrl).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(`[工作台] 没拿到服务地址,退回 ${DEFAULT_BASE_URL}`)
    expect(DEFAULT_BASE_URL).toBe('http://127.0.0.1:8791')
  })

  it('形状不对时当没拿到,一样吼一声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(serviceBaseUrlForPage({ [SERVICE_CONFIG_GLOBAL]: { baseUrl: 'ftp://127.0.0.1:8890' } })).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
