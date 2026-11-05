import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { WorkbenchButton, WorkbenchOverlay } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'

async function bench(connectWorkspace: () => Promise<string> = async () => 'session-aiboo') {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // 0.1.7-rc.2:导航(openSession)从 ctx.sessions 搬到 ctx.uiWorkspace,ISessions 已无 open。
  const open = vi.fn()
  ctx.provide('uiWorkspace', { connectWorkspace, openSession: open } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots, open }
}

async function deferredBench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('uiWorkspace', { connectWorkspace: async () => 'session-aiboo', openSession: vi.fn() } as never)
  const slots = ctx.get('slots') as SlotRegistry
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots }
}

describe('workbench client apply', () => {
  it('declares the services used to navigate native DSH sessions', () => {
    // 0.1.7-rc.2 起不再 inject sessions:导航归视图所有者,uiWorkspace 一个就够。
    expect(inject).toEqual(['slots', 'uiWorkspace'])
  })

  it('registers the full-screen surface and sidebar entry with one shared store', async () => {
    const { slots } = await bench()
    const overlay = slots.entries('shell.overlay')[0]
    const button = slots.entries('sidebar.footer.action')[0]

    expect(overlay?.component).toBe(WorkbenchOverlay)
    expect(button?.component).toBe(WorkbenchButton)
    expect(overlay?.options.id).toBe('ben-workbench')
    expect(button?.options.id).toBe('ben-workbench')
    expect(overlay?.store).toBe(button?.store)
  })

  it('waits for DSH to declare its shell and sidebar slots', async () => {
    const { slots } = await deferredBench()

    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)

    slots.register({
      name: 'root',
      children: {
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    expect(slots.entries('shell.overlay')[0]?.component).toBe(WorkbenchOverlay)
    expect(slots.entries('sidebar.footer.action')[0]?.component).toBe(WorkbenchButton)
  })

  it('opens the existing DSH session and closes the overlay only after success', async () => {
    const connectWorkspace = vi.fn(async () => 'session-aiboo')
    const { slots, open } = await bench(connectWorkspace)
    const entry = slots.entries('shell.overlay')[0]!
    const instance = createWorkbenchStore().create()
    const injected = (entry.inject as (actions: typeof instance.actions) => {
      openWorkspace: (workspaceId: string, projectName: string) => Promise<void>
    })(instance.actions)

    await injected.openWorkspace('workspace-aiboo', 'Aiboo')

    expect(connectWorkspace).toHaveBeenCalledWith('workspace-aiboo')
    expect(open).toHaveBeenCalledWith('session-aiboo')
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('点开一条事项:打开那条会话,并把工作台浮层让开(2026-09-10 事项收件箱)', async () => {
    // 让开是这条路的一半——浮层盖着整屏,不让开的话点完什么都看不到。
    const { slots, open } = await bench(async () => 'session-aiboo')
    const entry = slots.entries('shell.overlay')[0]!
    const instance = createWorkbenchStore().create()
    const injected = (entry.inject as (actions: typeof instance.actions) => {
      openSession: (sessionId: string) => void
    })(instance.actions)

    injected.openSession('sess-1')

    expect(open).toHaveBeenCalledWith('sess-1')
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('keeps the Workbench open and exposes a useful error when navigation fails', async () => {
    const { slots } = await bench(async () => { throw new Error('offline') })
    const entry = slots.entries('shell.overlay')[0]!
    const instance = createWorkbenchStore().create()
    const injected = (entry.inject as (actions: typeof instance.actions) => {
      openWorkspace: (workspaceId: string, projectName: string) => Promise<void>
    })(instance.actions)

    await injected.openWorkspace('workspace-aiboo', 'Aiboo')

    expect(instance.getSnapshot()).toMatchObject({
      open: true,
      openingProjectId: null,
      error: '无法进入 Aiboo，请稍后重试。',
    })
  })
})
