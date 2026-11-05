/**
 * 已有项目拉齐(2026-09-24):扫描进度多一种 `phase:'read'`(她拿到点头之后读那个项目的说明和最近记录,`current` = 项目名)。
 * 电脑引导整屏那一行显示「正在读 X 的说明…」(与手机同一句;名字太长只说「正在读它的说明…」)、球进执行中、没有进度条;
 * 2026-09-24 傍晚起(卡 fix/scan-orb-working-whole-wait)那一行跟着「那一整段等待」走:读完了、她还没开口时照样是读的那一句
 * (服务端 held 的那一份,或老服务端收了之后凭 `last_read`);认不得的 phase 照「正在找你的项目… <current>」退化。
 * 手机那一份在 butler-app/tests/scanHoldRead.test.tsx,文案逐字一致。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_REPLY_WINDOW, nextReplyWindow, settledScanOf } from '../src/client/firstrun/scanHold.ts'
import {
  SCAN_LINE, scanLineOf, scanProgressOf, scanRatioOf, scanReadLine, stageViewOf,
} from '../src/client/firstrun/onboardingStage.ts'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const READ_LINE = '正在读 desktop-workbench 的说明…'

describe('read 那一行(纯函数)', () => {
  it('读回包:phase read 与 last_read 都认;那一行说读谁,没有进度条', () => {
    const reading = scanProgressOf({ scan: { scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' } })
    expect(reading).toEqual({ scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' })
    expect(scanLineOf(reading)).toBe(READ_LINE)
    expect(scanRatioOf(reading)).toBeUndefined()
    expect(scanReadLine('  ')).toBe('正在读它的说明…')
    // 两端同一句:名字太长就只说「正在读它的说明…」(手机 375 宽要整句看得见)。
    expect(scanReadLine('a'.repeat(25))).toBe('正在读它的说明…')
    expect(scanProgressOf({ scan: { scanning: false, done: 0, finished_at: '2026-09-24T05:00:00.000Z', last_read: 'desktop-workbench' } })?.lastRead)
      .toBe('desktop-workbench')
  })

  it('认不得的 phase 体面退化:照「正在找你的项目… <名字>」显示', () => {
    const later = scanProgressOf({ scan: { scanning: true, phase: 'summarize', current: 'desktop-workbench' } })
    expect(later?.phase).toBeUndefined()
    expect(scanLineOf(later)).toBe(`${SCAN_LINE} desktop-workbench`)
  })

  it('球进执行中(核心 working 形),读屏名是「在读你的项目」,状态行是读的那一句', () => {
    const view = stageViewOf({ speaking: false, busy: true, pending: false, waiting: false, drafting: false, stage: 'projects', scan: { scanning: true, phase: 'read', current: 'desktop-workbench' } })
    expect(view).toMatchObject({ cue: 'working', mode: 'working', label: '在读你的项目', status: READ_LINE })
    expect(view.ratio).toBeUndefined()
  })

  it('读完了、她还没开口:held 那一份、老服务端收了之后凭 last_read,都留在读的那一句', () => {
    expect(scanLineOf(scanProgressOf({ scan: { scanning: true, held: true, phase: 'read', current: 'desktop-workbench', id: 1 } }))).toBe(READ_LINE)
    expect(scanLineOf(settledScanOf({ scanning: false, lastRead: 'desktop-workbench' }))).toBe(READ_LINE)
    const win = [
      { scan: { scanning: true, phase: 'list' as const }, now: 0 },
      { scan: { scanning: false, lastRead: 'desktop-workbench' }, now: 2_000 },
    ].reduce((w, s) => nextReplyWindow(w, { her: '1', busy: true, ...s }), EMPTY_REPLY_WINDOW)
    expect(win.open).toBe(true)
    expect(scanLineOf(win.shown)).toBe(READ_LINE)
  })
})

describe('对话屏', () => {
  function snapshot(): WorkbenchState {
    return { agents: [], sessions: [], quota: {}, now: '2026-09-24T10:00:00+08:00', stale: false }
  }
  function server(scan: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? ''
      const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
      if (path === '/onboarding/turns') {
        return ok({ turns: [{ seq: 1, role: 'assistant', text: '我看一下' }], busy: true, ended: false, stage: 'projects', done: false, scan })
      }
      if (path === '/first-run') return ok({})
      return ok({ stage: 'projects', done: false })
    }) as unknown as typeof fetch
  }

  it('在读:球进执行中(核心 working 形),球下一行「正在读 X 的说明…」,不出进度条', async () => {
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={server({ scanning: true, phase: 'read', done: 0, current: 'desktop-workbench', id: 1 })} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    const line = await screen.findByText(READ_LINE)
    expect(line.closest('[role="status"]')).not.toBeNull()
    const root = screen.getByRole('dialog', { name: '第一次用' })
    expect(root).toHaveAttribute('data-cue', 'working')
    expect(root.querySelector('.ben-wb__onb-orb')).toHaveAttribute('data-mode', 'working')
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('读完了在等她(held):照样是读的那一句', async () => {
    render(<FirstRunFlow baseUrl="http://x" fetchImpl={server({ scanning: true, held: true, phase: 'read', done: 0, current: 'desktop-workbench', id: 1 })} state={snapshot()} onDone={() => {}} turnsPollMs={0} initialStep="chat" />)
    expect(await screen.findByText(READ_LINE)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '第一次用' })).toHaveAttribute('data-cue', 'working')
  })
})
