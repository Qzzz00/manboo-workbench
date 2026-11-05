import { describe, expect, it } from 'vitest'
import { collectCodexAppServerQuota, parseAppServerRateLimits } from '../src/quota/codexAppServer.ts'

/**
 * 按 `codex app-server` 的 `account/rateLimits/read` 实际返回造 result
 * （2026-08-24 在本机核对过：codex-cli 0.146.0，字段是驼峰，跟会话文件里的蛇形不是一套）。
 */
function result(primary: unknown, secondary: unknown = null): unknown {
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary,
      secondary,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null,
      spendControlReached: false,
      planType: 'prolite',
      rateLimitReachedType: null,
    },
  }
}

describe('parseAppServerRateLimits', () => {
  it('把 usedPercent 换算成剩余百分比——刚重置完是 0 用掉，界面上该是 100 剩余', () => {
    const quota = parseAppServerRateLimits(result({ usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788146676 }))

    expect(quota.windows).toEqual([
      { label: '周', left_pct: 100, reset_at: '2026-08-31T03:24:36.000Z' },
    ])
  })

  it('resetsAt 是秒，要翻成毫秒的 ISO——直接当毫秒用会把重置时刻甩到 1970', () => {
    const quota = parseAppServerRateLimits(result({ usedPercent: 60, windowDurationMins: 10080, resetsAt: 1787801902 }))

    expect(quota.windows[0]?.reset_at).toBe('2026-08-27T03:38:22.000Z')
  })

  it('两个窗口都在时按窗口长短排，短的在前', () => {
    const quota = parseAppServerRateLimits(result(
      { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1788146676 },
      { usedPercent: 25, windowDurationMins: 300, resetsAt: 1787559876 },
    ))

    expect(quota.windows.map(window => window.label)).toEqual(['5h', '周'])
  })

  it('没有可用窗口就抛错，不编造额度', () => {
    expect(() => parseAppServerRateLimits(result(null))).toThrow()
  })
})

describe('collectCodexAppServerQuota', () => {
  it('取到数就直接给出额度', async () => {
    const entry = await collectCodexAppServerQuota({
      readRateLimits: async () => result({ usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788146676 }),
    })

    expect(entry).toEqual({
      kind: 'quota',
      windows: [{ label: '周', left_pct: 100, reset_at: '2026-08-31T03:24:36.000Z' }],
    })
  })

  it('app-server 不通时抛错，由调用方决定退回本机会话文件', async () => {
    await expect(collectCodexAppServerQuota({
      readRateLimits: async () => { throw new Error('codex app-server 没起来') },
    })).rejects.toThrow()
  })
})

import { CODEX_APP_BUNDLE_BINARY, resolveCodexBinary } from '../src/quota/codexAppServer.ts'

describe('resolveCodexBinary:PATH 上没有 codex 时退回 ChatGPT.app 自带的那份(2026-09-08)', () => {
  it('PATH 里有 codex 就用 PATH 上的', () => {
    const exists = (f: string) => f === '/opt/homebrew/bin/codex'
    expect(resolveCodexBinary('/Users/example/.local/bin:/opt/homebrew/bin', exists)).toBe('codex')
  })
  it('PATH 里没有、ChatGPT.app 里有 → 用 app 自带的绝对路径', () => {
    const exists = (f: string) => f === CODEX_APP_BUNDLE_BINARY
    expect(resolveCodexBinary('/Users/example/.local/bin:/opt/homebrew/bin', exists)).toBe(CODEX_APP_BUNDLE_BINARY)
  })
  it('两边都没有 → 仍返回 codex,让 spawn 失败照常退回本机会话文件', () => {
    expect(resolveCodexBinary('/usr/bin', () => false)).toBe('codex')
    expect(resolveCodexBinary(undefined, () => false)).toBe('codex')
  })
})
