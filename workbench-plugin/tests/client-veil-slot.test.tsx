/**
 * useVeilSlot(弹层让开窗位,2026-09-11):弹层挂载且 open 为真 → POST /dock/veil {on:true};
 * 关闭/卸载 → {on:false}。配对是硬要求——少一个 off 窗位就永远空着,多一个 on 也一样。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVeilSlot, type VeilTarget } from '../src/client/useVeilSlot.ts'

afterEach(cleanup)

function Probe({ open, target }: { open: boolean, target: VeilTarget | undefined }) {
  useVeilSlot(open, target)
  return null
}

function fakeFetch() {
  const calls: { url: string, body: unknown, keepalive: boolean | undefined }[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), keepalive: init?.keepalive })
    return new Response('{"ok":true}', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** 发送走的是一条 promise 链,得让微任务跑完再看 calls。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('useVeilSlot', () => {
  it('open:true 挂载 → on;卸载 → off(带 keepalive,关页也能发出)', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const target = { baseUrl: 'http://127.0.0.1:8791', fetchImpl }
    const view = render(<Probe open target={target} />)
    await flush()
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8791/dock/veil', body: { on: true }, keepalive: undefined }])

    view.unmount()
    await flush()
    expect(calls.map(c => c.body)).toEqual([{ on: true }, { on: false }])
    expect(calls[1]?.keepalive).toBe(true)
  })

  it('open 从 false 翻到 true 才 on,翻回 false 就 off——不是挂载就发', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const target = { baseUrl: 'http://x', fetchImpl }
    const view = render(<Probe open={false} target={target} />)
    await flush()
    expect(calls).toEqual([])

    view.rerender(<Probe open target={target} />)
    await flush()
    expect(calls.map(c => c.body)).toEqual([{ on: true }])

    view.rerender(<Probe open={false} target={target} />)
    await flush()
    expect(calls.map(c => c.body)).toEqual([{ on: true }, { on: false }])
  })

  it('没有 target(不在壳里/测试环境)→ 一个请求都不发', async () => {
    const { calls, fetchImpl } = fakeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const view = render(<Probe open target={undefined} />)
    await flush()
    view.unmount()
    await flush()
    expect(calls).toEqual([])
    vi.unstubAllGlobals()
  })

  it('两个弹层同时开:各自 on/off 一对,服务端按计数只让一次;顺序严格 on,on,off,off', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const target = { baseUrl: 'http://x', fetchImpl }
    const a = render(<Probe open target={target} />)
    const b = render(<Probe open target={target} />)
    await flush()
    a.unmount()
    b.unmount()
    await flush()
    expect(calls.map(c => c.body)).toEqual([{ on: true }, { on: true }, { on: false }, { on: false }])
  })

  it('页面 pagehide(关页/重载,React 不会跑卸载)→ 补发一次 off(keepalive)', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const target = { baseUrl: 'http://x', fetchImpl }
    render(<Probe open target={target} />)
    await flush()
    window.dispatchEvent(new Event('pagehide'))
    await flush()
    expect(calls.map(c => c.body)).toEqual([{ on: true }, { on: false }])
    expect(calls[1]?.keepalive).toBe(true)
  })

  it('fetch 抛错不炸组件,后面的 off 照发', async () => {
    const calls: unknown[] = []
    let first = true
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      if (first) { first = false; throw new Error('8791 重启中') }
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    const view = render(<Probe open target={{ baseUrl: 'http://x', fetchImpl }} />)
    await flush()
    view.unmount()
    await flush()
    expect(calls).toEqual([{ on: true }, { on: false }])
  })
})
