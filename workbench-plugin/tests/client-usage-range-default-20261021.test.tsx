/**
 * ★ 2026-10-21 消耗数据**默认看全部记录**,切过的那一档记住(维护者原话:「能不能默认展示All,我每次都得从30d切到all」)。
 *
 * 只管产品研发那一版(`UsagePanel.tsx`):第一次打开 = All;点过 30d / 7d 之后,下次打开照上次的(记在 localStorage,
 * 键名带 `ben-wb` 前缀);记的值认不出、或这台浏览器不让读写 localStorage,都退回 All,不报错。
 * 自媒体那一版(`air/usage.js`)归运营同学,缺省仍是「近 7 天」、不记(统筹 10-21 定),由它自己那份用例守着;
 * 这里只钉一条:产品研发这边记下的那一档不会串到它那边去。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UsageDay, UsageState } from '../src/protocol.ts'
import { USAGE_RANGE_KEY, UsagePanel } from '../src/client/UsagePanel.tsx'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const AirUsagePanel = starterWidget('usage')

/** 这套环境里 `window.localStorage` 缺席(同 client-actor-notes):每条用例装一份内存里的。 */
const stored = new Map<string, string>()
const memoryStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) }, clear: () => stored.clear() }
function useStorage(storage: unknown): void {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
}
beforeEach(() => {
  stored.clear()
  useStorage(memoryStorage)
})
afterEach(cleanup)

function day(date: string, output: number): UsageDay {
  const totals = { input: 0, output, cache_read: 0, cache_write: 0 }
  return { date, by_project: { Aiboo: totals }, by_model: { m: totals }, by_source: { codex: totals }, sessions: 1, messages: 1, hour_counts: {} }
}

/** 31 天:最早那一天大(10 亿),其余 30 天各 1。30d 那一档切掉的正是最早那一天。 */
const DAYS = [day('2026-08-01', 1_000_000_000), ...Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2026, 7, 2 + i)).toISOString().slice(0, 10), 1))]
const USAGE: UsageState = { days: DAYS, sources: { codex: { status: 'ok' } }, scanned_at: '2026-09-01T00:00:00Z' }

function pressed(name: string): string | null {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed')
}
function primary(): string | null | undefined {
  return document.querySelector('.ben-wb__usage-tile--primary .ben-wb__usage-tile-v')?.textContent
}

describe('产品研发那一版:默认 All,记住上次那一档', () => {
  it('第一次打开亮着 All,最早那一天也算进大字', () => {
    render(<UsagePanel usage={USAGE} />)
    expect(pressed('All')).toBe('true')
    expect(pressed('30d')).toBe('false')
    expect(primary()).toBe('1.0B')
  })

  it('切到 7d 之后再打开(刷新)还是 7d', () => {
    const first = render(<UsagePanel usage={USAGE} />)
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    expect(stored.get(USAGE_RANGE_KEY)).toBe('7d')
    first.unmount()
    render(<UsagePanel usage={USAGE} />)
    expect(pressed('7d')).toBe('true')
    expect(primary()).toBe('7')
  })

  it('切回 All 也记住', () => {
    stored.set(USAGE_RANGE_KEY, '30d')
    const first = render(<UsagePanel usage={USAGE} />)
    expect(pressed('30d')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    first.unmount()
    render(<UsagePanel usage={USAGE} />)
    expect(pressed('All')).toBe('true')
  })

  it('记的值认不出就回 All', () => {
    stored.set(USAGE_RANGE_KEY, '90d')
    render(<UsagePanel usage={USAGE} />)
    expect(pressed('All')).toBe('true')
  })

  it('这台浏览器不让读写 localStorage(一读就抛 / 压根没有):照样打开(All),点了照样切,不报错', () => {
    const blocked = () => { throw new Error('blocked') }
    for (const storage of [{ getItem: blocked, setItem: blocked }, undefined]) {
      useStorage(storage)
      const one = render(<UsagePanel usage={USAGE} />)
      expect(pressed('All')).toBe('true')
      fireEvent.click(screen.getByRole('button', { name: '7d' }))
      expect(pressed('7d')).toBe('true')
      one.unmount()
    }
  })

  it('键名带 ben-wb 前缀', () => {
    expect(USAGE_RANGE_KEY.startsWith('ben-wb.')).toBe(true)
  })
})

describe('自媒体那一版不跟着变', () => {
  it('产品研发这边记下了 All,它那边照旧亮「近 7 天」', () => {
    stored.set(USAGE_RANGE_KEY, 'all')
    render(<AirUsagePanel usage={USAGE} now="2026-09-01T10:00:00+08:00" />)
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '全部记录' })).toHaveAttribute('aria-pressed', 'false')
  })
})
