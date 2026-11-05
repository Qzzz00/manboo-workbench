import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '../src/protocol.ts'
import { collectQuota } from '../src/quota/collect.ts'
import type { FetchLike } from '../src/quota/deepseek.ts'
import { localDay, trackDailySpend } from '../src/quota/dailySpend.ts'
// 过线那一格那两句由各家来源自己声明(quota/liveSources.ts);断言读常量,不逐字抄中文。
import { CLAUDE_KEY_REJECTED_WHY, CLAUDE_LIVE_WHY } from '../src/quota/liveSources.ts'

const FAKE_KEY = 'sk-test-fake-key-not-real'

/** Codex 桩：默认没有任何会话文件，测试绝不碰真实 ~/.codex。 */
const noCodex = { listSessionFiles: async () => [], readFile: async () => '' }

/**
 * Claude 桌面端用量记录的默认桩：读不到。
 *
 * 必须每个用例都注入——不注入的话 collectQuota 会去读真机上的
 * ~/Library/Application Support/Claude/plan-usage-history.json，
 * 测试结果就跟着 Ben 当下的额度变，本地过 CI 挂。
 */
const noClaudeDesktop = { readFile: async () => { throw new Error('没有这个文件') } }
const claudeDesktopWith = (fh: number, sd: number) => ({
  readFile: async () => JSON.stringify({
    version: 2,
    samples: [{ t: Date.now(), org: 'add5d0cf', u: { fh, sd } }],
  }),
})

/**
 * Codex 实时路的默认桩：app-server 不通。
 *
 * 必须每个用例都注入——不注入的话 collectQuota 会去 spawn 真的 `codex app-server`，
 * 测试就跟着 Ben 当下的登录态和额度变，还慢一秒多。
 */
const noCodexAppServer = { readRateLimits: async () => { throw new Error('codex app-server 没起来') } }

/** 造一条 app-server 的 rateLimits 返回，字段是驼峰，形状取自本机实际观察。 */
function codexAppServerWith(usedPercent: number, resetsAt: number) {
  return {
    readRateLimits: async () => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent, windowDurationMins: 10080, resetsAt },
        secondary: null,
      },
    }),
  }
}

/** 造一条 Codex 额度记录行，形状取自本机实际观察。 */
function codexIoWith(usedPercent: number) {
  // 重置时刻要放在未来：过了重置点的读数会被当成上一轮的旧数降级掉（那是另一条用例在测）。
  const resetsAt = Math.floor(Date.now() / 1000) + 86_400
  return {
    listSessionFiles: async () => [{ path: 'rollout-x.jsonl', mtimeMs: 1 }],
    readFile: async () => JSON.stringify({
      info: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt } } },
    }),
  }
}

function okFetch(total = '218.40'): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0.00', topped_up_balance: total }],
    }),
    text: async () => '',
  })
}

const failFetch: FetchLike = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:443')
}

describe('collectQuota', () => {
  it('四家来源全部出现，接不上的也占位（PRD §12 风险表）', async () => {
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(Object.keys(quota).sort()).toEqual([...AGENT_IDS].sort())
  })

  it('DeepSeek 有 key 时产出 BalanceQuota，挂在 dsh 位', async () => {
    const { quota } = await collectQuota({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    // 2026-10-02(卡 QA):每一家取到的数都带「截至什么时候」—— 这条路是现打的接口,就是这一刻。
    expect(quota.dsh).toEqual({
      kind: 'balance', currency: 'CNY', total: '218.40', available: true, as_of: expect.any(String),
    })
    expect(Date.parse((quota.dsh as { as_of: string }).as_of)).toBeGreaterThan(0)
  })

  it('没配 key 时明说未配置，而不是显示 0', async () => {
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(quota.dsh?.kind).toBe('unknown')
    // 2026-09-18 换了措辞并加了 no_stale:那句话现在既说"还没接",也带一步出路;
    // 旗子告诉采集循环这不是一次抖动,不许用宽限把上一次的余额留着(tests/quota-no-stale.test.ts)。
    expect(quota.dsh).toMatchObject({ note: expect.stringContaining('还没接 DeepSeek'), no_stale: true })
  })

  it('Codex 实时路不通时退回本机会话记录', async () => {
    const { quota } = await collectQuota({
      env: {},
      fetch: okFetch(),
      codexAppServerIo: noCodexAppServer,
      codexIo: codexIoWith(64),
      claudeDesktopIo: noClaudeDesktop,
    })

    expect(quota.codex).toMatchObject({ kind: 'quota', windows: [{ label: '周', left_pct: 36 }] })
  })

  it('Codex 优先用 app-server 的实时读数，而不是会话文件里那份可能已经放旧的', async () => {
    // 真机上栽过：会话文件停在 8/21（周 40%），而窗口早已重置（100%）。
    const { quota } = await collectQuota({
      env: {},
      fetch: okFetch(),
      codexAppServerIo: codexAppServerWith(0, 1788146676),
      codexIo: codexIoWith(60),
      claudeDesktopIo: noClaudeDesktop,
    })

    expect(quota.codex).toMatchObject({
      kind: 'quota',
      windows: [{ label: '周', left_pct: 100, reset_at: '2026-08-31T03:24:36.000Z' }],
    })
  })

  it('Claude 从桌面端的用量记录出数，无需网络与凭据', async () => {
    const { quota } = await collectQuota({
      env: {},
      fetch: okFetch(),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex,
      claudeDesktopIo: claudeDesktopWith(73, 8),
    })

    expect(quota.claude).toMatchObject({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 27 }, { label: '周', left_pct: 92 }],
    })
  })

  it('拉得到就以拉取为准，不被 statusLine 推来的旧值盖住', async () => {
    // 推送值会被 last-quota.json 持久化，重启后仍在，可能已经是几小时前的。
    const pushed = { kind: 'quota', windows: [{ label: '5h', left_pct: 76.5 }] } as const
    const { quota } = await collectQuota({
      env: {},
      fetch: okFetch(),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex,
      claude: pushed,
      claudeDesktopIo: claudeDesktopWith(73, 8),
    })

    expect(quota.claude).toMatchObject({
      windows: [{ label: '5h', left_pct: 27 }, { label: '周', left_pct: 92 }],
    })
  })

  it('两条路都没有时如实标未接入，不显示 0', async () => {
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(quota.claude).toMatchObject({ kind: 'unknown', note: expect.stringContaining('没装或没跑过') })
  })

  it('推来的是 unknown 时不拿它兜底——说清楚拉取为什么失败更有用', async () => {
    const { quota } = await collectQuota({
      env: {},
      fetch: okFetch(),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex,
      claude: { kind: 'unknown', note: '等 Claude Code statusLine 上报' },
      claudeDesktopIo: noClaudeDesktop,
    })

    expect(quota.claude).toMatchObject({ kind: 'unknown', note: expect.stringContaining('没装或没跑过') })
  })

  it('拉不到时退回 statusLine 推来的值（C1：上游断了也要留住上次状态）', async () => {
    const pushed = { kind: 'quota', windows: [{ label: '5h', left_pct: 76.5 }] } as const
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claude: pushed, claudeDesktopIo: noClaudeDesktop })

    /**
     * 那个数一个字节没动(`as_of` 照旧不盖 —— 盖一下这份旧数就又变成「刚读到的」)。
     *
     * 2026-10-02(卡 QK)多出来的只有 `stale_hint`:**「这台机器此刻缺什么」每轮现盖**,
     * 连退回上一轮那份也盖 —— 她刚在设置里配上密钥,下一轮那一格就该闭嘴。
     * 这里连 `env` 都是空的,所以盖上的正是那句「点一下「接上」就实时」
     * (声明在 `quota/liveSources.ts`,整条机制的用例在 tests/quota-key-hint.test.ts;
     * 2026-10-03 起断言读那个导出的常量,不逐字抄中文)。
     */
    const { stale_hint: hint, ...rest } = quota.claude as { stale_hint?: unknown }
    expect(rest).toEqual(pushed)
    expect(hint).toMatchObject({ live: { why: CLAUDE_LIVE_WHY } })
  })

  /**
   * ★ 2026-10-03(卡「一键接上」第 3 条:「密钥过期 / 被 401 时格子回到「接上」键,不是「未接入」」)。
   *
   * 过期的 token **永远不会自己好**。在此之前它与「网络抖了一下」走同一条退路(闷声退回桌面端那份旧文件),
   * 于是那一格挂着一个越来越旧的数、一句提示都没有 —— 这正是卡 QK 现场的另一半。
   */
  describe('那把 Claude 密钥被上游拒了(401/403)', () => {
    /** DeepSeek 照常回余额;打 api.anthropic.com 的那一条回 401(头里什么都没有)。 */
    const rejecting: FetchLike = async (url) => {
      if (String(url).includes('api.anthropic.com')) {
        return { ok: false, status: 401, json: async () => ({}), text: async () => '', headers: { get: () => null } }
      }
      return await okFetch()(url, undefined)
    }

    it('★ 还有旧数时:那一格把「接上」那颗入口键放回来,话改成「那把不管用了」', async () => {
      const { quota } = await collectQuota({
        env: {},
        credentials: { claude_api: 'sk-ant-oat01-fake-expired-for-tests-0000' },
        fetch: rejecting,
        codexAppServerIo: noCodexAppServer,
        codexIo: noCodex,
        claudeDesktopIo: claudeDesktopWith(10, 20),
      })

      // 桌面端那份旧数照旧给(有数总比没数强),但这一格现在说得出下一步了。
      expect(quota.claude).toMatchObject({ kind: 'quota' })
      expect((quota.claude as { stale_hint?: unknown }).stale_hint)
        .toMatchObject({ live: { why: CLAUDE_KEY_REJECTED_WHY } })
    })

    it('★ 一个数都没有时:「未接入」那一格里写的是她能照做的那一句,不是「取数方式待实测」', async () => {
      const { quota } = await collectQuota({
        env: {},
        credentials: { claude_api: 'sk-ant-oat01-fake-expired-for-tests-0000' },
        fetch: rejecting,
        codexAppServerIo: noCodexAppServer,
        codexIo: noCodex,
        claudeDesktopIo: noClaudeDesktop,
      })

      expect(quota.claude).toEqual({ kind: 'unknown', note: CLAUDE_KEY_REJECTED_WHY })
    })

    it('不是被拒(网络抖了一下)就照旧闷声退回去 —— 不替它编一句「密钥不管用了」(D13)', async () => {
      const { quota } = await collectQuota({
        env: {},
        credentials: { claude_api: 'sk-ant-oat01-fake-but-fine-for-tests-000' },
        fetch: failFetch,
        codexAppServerIo: noCodexAppServer,
        codexIo: noCodex,
        claudeDesktopIo: claudeDesktopWith(10, 20),
      })

      expect(JSON.stringify(quota.claude)).not.toContain(CLAUDE_KEY_REJECTED_WHY)
    })
  })

  it('Kimi 没登录时明说未登录', async () => {
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(quota.kimi).toMatchObject({ kind: 'unknown', note: expect.stringContaining('未登录 Kimi') })
  })

  it('DeepSeek 没配 key 也不能拖垮其余三家', async () => {
    const { quota } = await collectQuota({ env: {}, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: codexIoWith(10), claudeDesktopIo: noClaudeDesktop })

    expect(quota.dsh?.kind).toBe('unknown')
    expect(quota.codex?.kind).toBe('quota')
  })

  it('余额查询失败时降级为 unknown，且 note 里没有 API Key', async () => {
    const { quota } = await collectQuota({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: failFetch, codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(quota.dsh?.kind).toBe('unknown')
    expect(JSON.stringify(quota)).not.toContain(FAKE_KEY)
  })

  it('返回结果里任何地方都不出现 API Key', async () => {
    const result = await collectQuota({ env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch(), codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop })

    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
  })

  it('带上今日消耗：第二次采集才有数，第一次不编 0', async () => {
    const first = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY },
      fetch: okFetch('218.40'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex,
      now: new Date('2026-08-18T09:00:00+08:00'),
      claudeDesktopIo: noClaudeDesktop,
    })
    expect((first.quota.dsh as { today_spent?: string }).today_spent).toBeUndefined()

    const second = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY },
      fetch: okFetch('205.80'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex,
      now: new Date('2026-08-18T10:00:00+08:00'),
      spend: first.spend,
      claudeDesktopIo: noClaudeDesktop,
    })
    expect((second.quota.dsh as { today_spent?: string }).today_spent).toBe('12.60')
  })
})

describe('trackDailySpend', () => {
  it('首次读数只建基线，不报今日消耗', () => {
    const state = trackDailySpend(undefined, '218.40', '2026-08-18')

    expect(state.spent).toBeUndefined()
    expect(state.date).toBe('2026-08-18')
  })

  it('余额下降即为消耗，按 2 位小数累计', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-08-18')
    state = trackDailySpend(state, '210.00', '2026-08-18')
    expect(state.spent).toBe('8.40')

    state = trackDailySpend(state, '205.80', '2026-08-18')
    expect(state.spent).toBe('12.60')
  })

  it('余额不动时今日消耗保持不变', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-08-18')
    state = trackDailySpend(state, '218.40', '2026-08-18')
    expect(state.spent).toBe('0.00')
  })

  it('充值让余额变多时不算负消耗，已累计的消耗保留', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-08-18')
    state = trackDailySpend(state, '210.00', '2026-08-18')
    state = trackDailySpend(state, '310.00', '2026-08-18')
    expect(state.spent).toBe('8.40')

    state = trackDailySpend(state, '305.00', '2026-08-18')
    expect(state.spent).toBe('13.40')
  })

  it('跨天清零重来，且当天第一次读数不报数', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-08-18')
    state = trackDailySpend(state, '210.00', '2026-08-18')
    expect(state.spent).toBe('8.40')

    state = trackDailySpend(state, '208.00', '2026-08-19')
    expect(state.date).toBe('2026-08-19')
    expect(state.spent).toBeUndefined()
  })
})

describe('localDay', () => {
  it('按指定时区切天，跨时区不串日', () => {
    const midnightShanghai = new Date('2026-08-19T00:30:00+08:00')

    expect(localDay(midnightShanghai, 'Asia/Shanghai')).toBe('2026-08-19')
    expect(localDay(midnightShanghai, 'UTC')).toBe('2026-08-18')
  })
})

describe('trackDailySpend 按峰谷分两笔(2026-09-09,借 save-money 的时间窗语义)', () => {
  it('差值整笔算在后一次读数所处的时段', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-09-09', 'peak')
    state = trackDailySpend(state, '210.00', '2026-09-09', 'peak')
    expect(state.spent).toBe('8.40')
    expect(state.peak).toBe('8.40')
    expect(state.offpeak).toBeUndefined() // 低谷一笔都没记过就不出现,不写 0

    state = trackDailySpend(state, '208.00', '2026-09-09', 'offpeak')
    expect(state.spent).toBe('10.40')
    expect(state.peak).toBe('8.40')
    expect(state.offpeak).toBe('2.00')
  })

  it('不传时段就只记总数,两笔都不动——分不了账时如实缺席,不硬塞进某一边', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-09-09')
    state = trackDailySpend(state, '210.00', '2026-09-09')
    expect(state.spent).toBe('8.40')
    expect(state.peak).toBeUndefined()
    expect(state.offpeak).toBeUndefined()
  })

  it('中途才有时段:那之前的差值不补记,两笔之和小于总数(如实,不是算错)', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-09-09')
    state = trackDailySpend(state, '210.00', '2026-09-09') // 无时段,8.40 不归任何一边
    state = trackDailySpend(state, '208.00', '2026-09-09', 'peak')
    expect(state.spent).toBe('10.40')
    expect(state.peak).toBe('2.00')
  })

  it('充值(余额变多)那一笔按 0 计,不给某个时段记负数', () => {
    let state = trackDailySpend(undefined, '10.00', '2026-09-09', 'peak')
    state = trackDailySpend(state, '210.00', '2026-09-09', 'peak')
    expect(state.spent).toBe('0.00')
    expect(state.peak).toBe('0.00')
  })

  it('跨天连同两笔一起清零', () => {
    let state = trackDailySpend(undefined, '218.40', '2026-09-09', 'peak')
    state = trackDailySpend(state, '210.00', '2026-09-09', 'peak')
    state = trackDailySpend(state, '208.00', '2026-09-10', 'peak')
    expect(state.peak).toBeUndefined()
    expect(state.spent).toBeUndefined()
  })
})

describe('collectQuota 把峰谷时段接进今日消耗(2026-09-09)', () => {
  const schedule = { periods: [{ start: '08:58', end: '12:02' }] }

  it('传了时间表:高峰段采到的那笔记进高峰', async () => {
    const first = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('218.40'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T10:00:00+08:00'), peakSchedule: schedule,
    })
    const second = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('210.00'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T10:05:00+08:00'), peakSchedule: schedule, spend: first.spend,
    })
    expect(second.spend?.peak).toBe('8.40')
    expect(second.spend?.offpeak).toBeUndefined()
  })

  it('低谷段采到的那笔记进低谷', async () => {
    const first = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('218.40'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T20:00:00+08:00'), peakSchedule: schedule,
    })
    const second = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('210.00'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T20:05:00+08:00'), peakSchedule: schedule, spend: first.spend,
    })
    expect(second.spend?.offpeak).toBe('8.40')
    expect(second.spend?.peak).toBeUndefined()
  })

  it('没传时间表就只记总数,不分账', async () => {
    const first = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('218.40'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T10:00:00+08:00'),
    })
    const second = await collectQuota({
      env: { DEEPSEEK_API_KEY: FAKE_KEY }, fetch: okFetch('210.00'),
      codexAppServerIo: noCodexAppServer, codexIo: noCodex, claudeDesktopIo: noClaudeDesktop,
      now: new Date('2026-09-09T10:05:00+08:00'), spend: first.spend,
    })
    expect(second.spend?.spent).toBe('8.40')
    expect(second.spend?.peak).toBeUndefined()
    expect(second.spend?.offpeak).toBeUndefined()
  })
})
