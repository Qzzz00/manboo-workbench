/**
 * 顶栏那一排灯与「N 家」那张面板上的两件事(2026-10-01;Air 诊断 14:47)。
 *
 * 维护者:「豆包工作和 muse 我已关闭后台但依旧挂在事务官处」—— 关掉的那几家**跟开着的混在一起**,
 * 还写着「空闲」(登记表里它们的状态是「显示的是上次读到的」,界面照着念成了空闲)。
 *
 * 这里钉两件:
 * - 没开的排在最后、灰着、那一句写「没开」;
 * - 认出是 AI 应用、窗口却读不到的那几家(Air 上的新版 Kimi、可灵、App Store 版豆包)
 *   在那张面板上**有一行**,说清工作台替不了她往里发话 —— 不是默默不列。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TopBar } from '../src/client/TopBar.tsx'
import { registryCount, registryLamps } from '../src/client/agentRegistryView.ts'
import type { AgentEntryView, WorkbenchState } from '../src/protocol.ts'
import { agentNotOpenWhy, agentUnreadableWhy } from '../src/protocol.ts'

afterEach(cleanup)

const WIDGET = { error: false, valueText: '—', alert: false }

function entry(over: Partial<AgentEntryView> & { id: string, name: string }): AgentEntryView {
  return {
    color: '#888', found: { how: 'patrol', at: '', basis: '' }, sources: [], status: 'idle',
    gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 }, ...over,
  } as AgentEntryView
}

/** 事务官自己 + 开着的 Codex + 关掉的 Muse / 豆包办公。 */
function state(): WorkbenchState {
  return {
    sessions: [],
    agent_registry: {
      entries: [
        entry({ id: 'dsh', name: '事务官', self: true }),
        entry({ id: 'muse', name: 'Muse', bundle_id: 'com.meta.endo', app_running: false }),
        entry({ id: 'codex', name: 'Codex', bundle_id: 'com.openai.codex', app_running: true, status: 'running' }),
        entry({ id: 'doubao', name: '豆包办公', bundle_id: 'com.work.pc.doubao', app_running: false }),
      ],
      asking: [],
      notices: [],
      unreadable: [{
        id: 'com.moonshot.kimichat.kmp.mac', name: 'Kimi', bundle_id: 'com.moonshot.kimichat.kmp.mac',
        why: agentUnreadableWhy('Kimi'), detail: '不像对话窗口:没有输入框;没有对话区也没有会话列表',
        at: '2026-10-01T06:10:00.000Z',
      }],
    },
  } as unknown as WorkbenchState
}

describe('关掉的那几家排在后面、灰着、写「没开」', () => {
  it('registryLamps:开着的在前,没开的在后并灰着', () => {
    const lamps = registryLamps(state())
    expect(lamps.map(one => one.id)).toEqual(['dsh', 'codex', 'muse', 'doubao'])
    const muse = lamps.find(one => one.id === 'muse')
    expect(muse?.dim).toBe(true)
    expect(muse?.why).toContain(agentNotOpenWhy('Muse'))
    expect(muse?.why).not.toContain('一扇窗都没有')
    // 开着的那一家一个字都不动。
    expect(lamps.find(one => one.id === 'codex')?.dim).toBeUndefined()
  })

  it('registryCount:那张面板上也是开着的在前、没开的在后,那一句写「没开」', () => {
    const count = registryCount(state())
    expect(count.items.map(one => one.id)).toEqual(['codex', 'muse', 'doubao'])
    const doubao = count.items.find(one => one.id === 'doubao')
    expect(doubao?.connected).toBe(false)
    expect(doubao?.why).toContain(agentNotOpenWhy('豆包办公'))
  })
})

describe('认出是 AI 应用、窗口读不到的那几家摆一行', () => {
  it('registryCount 带上它们(不算进「N 家」)', () => {
    const count = registryCount(state())
    expect(count.total).toBe(3)
    expect(count.unreadable.map(one => one.name)).toEqual(['Kimi'])
    expect(count.unreadable[0]?.why).toBe(agentUnreadableWhy('Kimi'))
  })

  it('顶栏那张面板上真画出那一行', () => {
    const current = state()
    render(<TopBar lamps={registryLamps(current)} agentCount={registryCount(current)} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: registryCount(current).text }))
    expect(screen.getByText('认出来了、读不到它的窗口:')).toBeInTheDocument()
    expect(screen.getByText(agentUnreadableWhy('Kimi'))).toBeInTheDocument()
  })
})
