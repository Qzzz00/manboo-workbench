// @vitest-environment node
/**
 * 壳模式与内嵌帧判定(W4)。纯函数,不碰 DOM——套娃防护这种"错了就无限递归"的东西
 * 必须能单测,不能只靠在浏览器里手点一次。
 */
import { describe, expect, it } from 'vitest'
import { inShellApp, isTopFrame, notifyShellReady, SHELL_READY_HANDLER } from '../src/client/shell.ts'

describe('isTopFrame(W4 套娃防护)', () => {
  it('顶层窗口:self === top → true', () => {
    const w = {}
    expect(isTopFrame(w, w)).toBe(true)
  })

  it('被 iframe 嵌着:self !== top → false', () => {
    expect(isTopFrame({}, {})).toBe(false)
  })

  it('拿不到 top(跨源被挡)按"不是顶层"处理——宁可不渲染,也不冒无限套娃的险', () => {
    expect(isTopFrame({}, undefined)).toBe(false)
  })
})

describe('inShellApp(既有行为,回归护栏)', () => {
  it('search 命中', () => {
    expect(inShellApp('?ben-workbench=app', '')).toBe(true)
  })
  it('hash 命中', () => {
    expect(inShellApp('', '#/x?ben-workbench=app')).toBe(true)
  })
  it('都没有', () => {
    expect(inShellApp('', '')).toBe(false)
  })
})

describe('notifyShellReady(壳的加载占位,2026-09-23)', () => {
  it('壳里:往 benWorkbenchShell 发一条 ready,不带别的数据', () => {
    const got: unknown[] = []
    const win = { webkit: { messageHandlers: { [SHELL_READY_HANDLER]: { postMessage: (m: unknown) => got.push(m) } } } }
    expect(notifyShellReady(win)).toBe(true)
    expect(got).toEqual([{ type: 'ready' }])
  })
  it('浏览器里(没有 webkit / 没有这个 handler):什么都不做', () => {
    expect(notifyShellReady({})).toBe(false)
    expect(notifyShellReady({ webkit: { messageHandlers: {} } })).toBe(false)
    expect(notifyShellReady(undefined)).toBe(false)
  })
  it('handler 抛错也不炸页面', () => {
    const win = { webkit: { messageHandlers: { [SHELL_READY_HANDLER]: { postMessage: () => { throw new Error('x') } } } } }
    expect(notifyShellReady(win)).toBe(false)
  })
})
