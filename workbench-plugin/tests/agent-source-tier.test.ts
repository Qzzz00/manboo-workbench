// @vitest-environment node
/**
 * **来源分级写在登记表上;只能看屏幕的那几家,藏着时如实说看不见**(2026-10-09,根治方案第三节第 1、2 条)。
 *
 * - 来源那一格写明这一家用的是哪一级:它自己的记录(第一级)/ 看它的屏幕(第三级,本机没有能读的记录);
 * - 窗口槽把那一家藏起来后,Chromium 的辅助功能树停在藏起那一刻(10-08 千问办公现场):读到的是旧画面。
 *   这时不凭旧画面判「在跑」或「做完」—— 会话保留最后一次看得见时的判断,那一句写「藏着,看不见它此刻在干什么」。
 */
import { describe, expect, it } from 'vitest'
import { agentHiddenInSlotWhy } from '../src/protocol.ts'
import { RECORD_SOURCE_LABEL, SCREEN_ONLY_NOTE, SCREEN_SOURCE_LABEL } from '../src/server/agentRecords.ts'
import { ACTIVITY_MAX, emptyRegistry, registryView } from '../src/server/agentRegistry.ts'
import type { AppRecord, RegistryFile } from '../src/server/agentRegistry.ts'
import { clipText, nextWindowState, parseRead, summarizeRead } from '../src/server/agentWindowModel.ts'
import type { WindowAgentState } from '../src/server/agentWindowModel.ts'
import { chatRead } from './fixtures/agentWorld.ts'

const BUNDLE = 'com.example.someagent'
const NAME = '某家'

function connected(): RegistryFile {
  const data = emptyRegistry()
  data.apps[BUNDLE] = {
    bundle_id: BUNDLE, name: NAME, state: 'connected',
    found: { how: 'patrol', at: '2026-10-09T01:00:00.000Z', basis: '巡检读到它的窗口' },
  }
  return data
}

/** 读一拍:`hidden` = 窗口槽把它藏着,读到的是藏起那一刻的画面(窗还列得出来)。 */
function step(prev: WindowAgentState | undefined, input: { busy: boolean, answer: string, hidden?: boolean, at: string }) {
  const raw = { ...chatRead({ busy: input.busy, answer: input.answer }), running: true, hidden: input.hidden === true }
  return nextWindowState(prev, summarizeRead(parseRead(raw), NAME), { now: new Date(input.at), active: false, name: NAME })
}

function view(data: RegistryFile, last: WindowAgentState, records?: { label: string }) {
  ;(data.apps[BUNDLE] as AppRecord).last = last
  return registryView({
    data, running: () => true, sessions: [], bubbles: new Map(), now: new Date('2026-10-09T01:10:00.000Z'),
    ...(records === undefined ? {} : { records: () => records }),
  }).entries.find(one => one.id === BUNDLE)
}

describe('来源那一格写明用的是哪一级', () => {
  it('★本机没有能读的记录 → 那一格叫「看它的屏幕」,并写明只能看屏幕', () => {
    const { state } = step(undefined, { busy: false, answer: '周报写好了。', at: '2026-10-09T01:05:00.000Z' })
    const entry = view(connected(), state)
    expect(entry?.sources).toEqual([{ kind: 'window', label: SCREEN_SOURCE_LABEL, ok: true, note: SCREEN_ONLY_NOTE }])
  })

  it('有它自己的记录这一路 → 第一格是记录,看屏幕那一格标成兜底,不写「只能看屏幕」', () => {
    const { state } = step(undefined, { busy: false, answer: '周报写好了。', at: '2026-10-09T01:05:00.000Z' })
    const entry = view(connected(), state, { label: RECORD_SOURCE_LABEL })
    expect(entry?.sources[0]).toMatchObject({ kind: 'records', label: RECORD_SOURCE_LABEL })
    expect(entry?.sources[1]).toMatchObject({ kind: 'window', label: SCREEN_SOURCE_LABEL })
    expect(entry?.sources[1]?.note).not.toBe(SCREEN_ONLY_NOTE)
  })
})

describe('只能看屏幕的,藏着时不凭旧画面下判断', () => {
  it('summarizeRead:藏着时窗还列得出来(停住的画面上还有停止键)→ 这一拍算没看成,不算在跑', () => {
    const raw = { ...chatRead({ busy: true, answer: '规划中' }), running: true, hidden: true }
    const summary = summarizeRead(parseRead(raw), NAME)
    expect(summary.ok).toBe(false)
    expect(summary.hidden).toBe(true)
    expect(summary.busy).toBe(false)
    expect(summary.gaps.status).toBe(agentHiddenInSlotWhy(NAME))
  })

  it('那一句如实说「看不见它此刻在干什么」', () => {
    expect(agentHiddenInSlotWhy(NAME)).toContain('看不见它此刻在干什么')
  })

  it('★藏起来之前在跑 → 藏着时会话仍是最后看见的「在跑」,不因停住的画面判成做完;那一句说看不见', () => {
    const first = step(undefined, { busy: true, answer: '正在搜索', at: '2026-10-09T01:00:00.000Z' })
    const second = step(first.state, { busy: true, answer: '正在搜索', at: '2026-10-09T01:00:05.000Z' })
    expect(second.state.status).toBe('running')
    // 藏起来:停住的画面一拍拍读下去,秒表、停止键都不动。
    let state = second.state
    for (let i = 1; i <= 40; i++) {
      const next = step(state, { busy: false, answer: '正在搜索', hidden: true, at: new Date(Date.parse('2026-10-09T01:00:05.000Z') + i * 5000).toISOString() })
      expect(next.bubble).toBeUndefined()
      state = next.state
    }
    const entry = view(connected(), state)
    expect(entry?.status).toBe('unknown')
    expect(entry?.gaps.status).toBe(agentHiddenInSlotWhy(NAME))
    expect(entry?.gaps.bubble).toBe(agentHiddenInSlotWhy(NAME))
    expect(JSON.stringify(entry?.gaps)).not.toContain('没接上')
    const session = entry?.sessions[0]
    expect(session?.status).toBe('running')
    expect(session?.unread).toBe(false)
    expect(session?.activity?.line).toBe(clipText(agentHiddenInSlotWhy(NAME), ACTIVITY_MAX))
    expect(entry?.sources[0]).toMatchObject({ kind: 'window', label: SCREEN_SOURCE_LABEL, ok: false, note: agentHiddenInSlotWhy(NAME) })
  })

  it('藏起来之前空闲 → 停住的画面上有停止键也不判成在跑,不冒「开始跑了」', () => {
    const first = step(undefined, { busy: false, answer: '周报写好了。', at: '2026-10-09T01:00:00.000Z' })
    const hidden = step(first.state, { busy: true, answer: '正在搜索', hidden: true, at: '2026-10-09T01:00:05.000Z' })
    expect(hidden.bubble).toBeUndefined()
    const entry = view(connected(), hidden.state)
    expect(entry?.sessions[0]?.status).toBe('done')
    expect(entry?.counts.running).toBe(0)
  })

  it('切回来(不藏了)照常读:这一拍按当场看见的判', () => {
    const first = step(undefined, { busy: true, answer: '正在搜索', at: '2026-10-09T01:00:00.000Z' })
    const hidden = step(first.state, { busy: false, answer: '正在搜索', hidden: true, at: '2026-10-09T01:00:05.000Z' })
    const back = step(hidden.state, { busy: false, answer: '搜到三篇。', at: '2026-10-09T01:03:00.000Z' })
    expect(back.state.status).toBe('idle')
    expect(back.state.hidden).toBeUndefined()
    const entry = view(connected(), back.state)
    expect(entry?.sessions[0]?.status).toBe('done')
    expect(entry?.sources[0]).toEqual({ kind: 'window', label: SCREEN_SOURCE_LABEL, ok: true, note: SCREEN_ONLY_NOTE })
  })
})
