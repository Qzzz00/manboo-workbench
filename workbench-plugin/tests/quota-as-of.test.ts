/**
 * **每一份额度都带「截至什么时候」**(2026-10-02,卡 QA;维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」)。
 *
 * 当时 `/state.quota.claude` 是 `{windows:[{5h,left_pct:100},{周,left_pct:82}]}` —— 数没错,
 * 它是 Claude 桌面端 **04:27** 那个样本(`{fh:0, sd:18}`)算出来的;可那会儿是 **21:3x**,17 小时前的数
 * 被当成此刻显示,既没有时刻、也没有一个字说它旧。她整晚都在用 Claude,真实用量显然不是 0%。
 *
 * 机制(不只修 Claude,每一家都适用):
 * - 每一份额度带 `as_of`(这个数**截至什么时候**)与 `source`(哪来的);
 * - 过了**一条线**(`QUOTA_AS_OF_STALE_AFTER_MS`,2 小时)就**不出百分比**,只说「读不到最新的,上次 04:27」;
 * - 线以内照说百分比,后面缀上「截至 04:27」—— 不让人以为那是这一秒的数。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientsView, QuotaEntry, WindowQuota } from '../src/protocol.ts'
import {
  QUOTA_AS_OF_STALE_AFTER_MS, QUOTA_STALE_VALUE, quotaAsOfClock, quotaAsOfStale, quotaAsOfWords,
} from '../src/protocol.ts'
import type { QuotaAdapterContext } from '../src/server/agentQuota.ts'
import { balanceFromQuota, forgetQuotaMemory, quotaFor } from '../src/server/agentQuota.ts'
import { choiceLine } from '../src/server/dispatchChoice.ts'
import { parseClaudeDesktopUsage } from '../src/quota/claudeDesktop.ts'
import { parseClaudeStatusLine } from '../src/quota/claude.ts'
import { quotaExhausted } from '../src/quota/collector.ts'
import { CLAUDE_STALE_WHY } from '../src/quota/liveSources.ts'
import { loadLastQuota, saveLastQuota } from '../src/quota/persist.ts'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 现场那一天:10-02 21:30 本地。 */
const NOW = new Date(2026, 9, 2, 21, 30, 0)
/** 桌面端最后那个样本:10-02 04:27 本地(17 小时前)。 */
const AT_0427 = new Date(2026, 9, 2, 4, 27, 40)
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)

describe('那条线与那几句话(一处常量、一处判断)', () => {
  it('★线就是 2 小时(改了就得改说法,所以钉住)', () => {
    expect(QUOTA_AS_OF_STALE_AFTER_MS).toBe(2 * 60 * 60 * 1000)
  })

  it('截至时刻写成人话:今天只写几点,昨天写「昨晚」,更早带上日期', () => {
    expect(quotaAsOfClock(AT_0427.toISOString(), NOW)).toBe('04:27')
    expect(quotaAsOfClock(new Date(2026, 9, 1, 20, 42).toISOString(), NOW)).toBe('昨晚 20:42')
    expect(quotaAsOfClock(new Date(2026, 9, 1, 9, 15).toISOString(), NOW)).toBe('昨天 09:15')
    expect(quotaAsOfClock(new Date(2026, 8, 26, 22, 10).toISOString(), NOW)).toBe('09-26 22:10')
  })

  it('认不出的时刻回 undefined —— 宁可不写,也不糊一个 ISO 串或编一个时刻(D13)', () => {
    expect(quotaAsOfClock('不是时刻', NOW)).toBeUndefined()
    expect(quotaAsOfWords(undefined, NOW)).toBeUndefined()
    expect(quotaAsOfWords('不是时刻', NOW)).toBeUndefined()
  })

  it('★线以内:「截至 04:27」;过线:「读不到最新的,上次 04:27」', () => {
    const fresh = ago(30 * 60_000).toISOString()
    expect(quotaAsOfStale(fresh, NOW)).toBe(false)
    expect(quotaAsOfWords(fresh, NOW)).toBe(`截至 ${quotaAsOfClock(fresh, NOW)}`)

    expect(quotaAsOfStale(AT_0427.toISOString(), NOW)).toBe(true)
    expect(quotaAsOfWords(AT_0427.toISOString(), NOW)).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
  })

  it('时刻缺席(老宿主、来源没给)不算过线 —— 缺席就是缺席,不替它判一个旧', () => {
    expect(quotaAsOfStale(undefined, NOW)).toBe(false)
    expect(quotaAsOfStale('不是时刻', NOW)).toBe(false)
  })

  it('时钟倒着走(as_of 在未来)不算过线', () => {
    expect(quotaAsOfStale(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(false)
  })
})

describe('Claude 桌面端那条路:as_of 是**样本自己的时刻**,不是读文件的那一刻', () => {
  const payload = {
    version: 2,
    samples: [
      { t: new Date(2026, 9, 1, 21, 41, 30).getTime(), u: { fh: 12, sd: 18 } },
      { t: AT_0427.getTime(), u: { fh: 0, sd: 18 } },
    ],
  }

  it('★现场那一份:04:27 的样本 → as_of = 04:27(不是此刻)', () => {
    // 线以内读一次(04:27 + 1 小时),拿到的就是那两扇窗 + 样本自己的时刻。
    const entry = parseClaudeDesktopUsage(payload, { now: new Date(AT_0427.getTime() + 60 * 60_000) })
    expect(entry.windows).toEqual([{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }])
    expect(entry.as_of).toBe(new Date(AT_0427.getTime()).toISOString())
    expect(entry.source).toBeDefined()
  })

  it('★那一份过了 2 小时就不许冒充当下:同一个 entry,21:30 看时过线', () => {
    const entry = parseClaudeDesktopUsage(payload, { now: new Date(AT_0427.getTime() + 60 * 60_000) })
    expect(quotaAsOfStale(entry.as_of, NOW)).toBe(true)
    expect(quotaAsOfWords(entry.as_of, NOW)).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
  })
})

describe('statusLine 那条路:as_of = 收到那一刻(推送是实时的)', () => {
  it('收到的时刻由调用方给,不自己去取 new Date()(用例才钉得住)', () => {
    const entry = parseClaudeStatusLine(
      { rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2 } } },
      NOW,
    )
    expect(entry.as_of).toBe(NOW.toISOString())
    expect(entry.source).toBeDefined()
  })
})

describe('「额度不足」不拿过线的数算(D13:不确定就不填)', () => {
  const empty: WindowQuota = { kind: 'quota', windows: [{ label: '5h', left_pct: 0 }] }

  it('线以内的 0% 照算见底', () => {
    expect(quotaExhausted({ ...empty, as_of: ago(10 * 60_000).toISOString() }, NOW)).toBe(true)
    expect(quotaExhausted(empty, NOW)).toBe(true)
  })

  it('★过线的 0% 不算见底 —— 那是一份 17 小时前的数,拿它给整家挂「额度不足」就是在编', () => {
    expect(quotaExhausted({ ...empty, as_of: AT_0427.toISOString() }, NOW)).toBe(false)
  })
})

describe('服务端一处判(quotaFor):线以内带「截至」,过线不出百分比', () => {
  const clients = (): ClientsView => ({
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: true },
    kimi: { installed: true, connected: true },
    wechat: { installed: false, connected: false },
    wecom: { installed: false, connected: false },
  })
  const ctx = (quota: QuotaAdapterContext['quota'], now = NOW): QuotaAdapterContext =>
    ({ quota, clients: clients(), now })

  beforeEach(() => { forgetQuotaMemory() })

  /**
   * 现场那一份:04:27 的样本算出来的两扇窗。
   *
   * 2026-10-02(卡 QK):「Claude 桌面没在跑」那半句从服务端一张按家名写死的表(原 `STALE_HINTS`)
   * 改成**各家额度来源自己声明、跟着 entry 过来**,所以这里带上它(`quota/liveSources.ts` 一处声明)。
   */
  const SITE: QuotaEntry = {
    kind: 'quota',
    windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
    as_of: AT_0427.toISOString(),
    source: '桌面端自己记的用量',
    stale_hint: { why: CLAUDE_STALE_WHY },
  }

  it('★现场那一幕:17 小时前的 100% 不再冒充当下 —— 一个百分比都不出,只说「读不到最新的,上次 04:27」', () => {
    const view = quotaFor('claude', ctx({ claude: SITE }))
    expect(view.state).toBe('numbers')
    expect(view.line).toBe(`${QUOTA_STALE_VALUE},上次 04:27 · ${CLAUDE_STALE_WHY}`)
    expect(view.short).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
    expect(view.stale).toBe(true)
    expect(view.read_at).toBe(AT_0427.toISOString())
    // 这几格一个都不许留下 —— 留一个,手机那一行、展示台那条横条就又把百分比画出来了。
    expect(view.left_pct).toBeUndefined()
    expect(view.left).toBeUndefined()
    expect(view.reset_at).toBeUndefined()
    expect(view.windows).toBeUndefined()
    expect(view.level).toBeUndefined()
    // 「没接上」是「从没接上」的说法,这一格读到过数,不许那么写(2026-09-26 卡 QS 那条仍然成立)。
    expect(view.line).not.toContain('没接上')
    // 界面上一个内部词都没有。
    for (const word of ['过期', '样本', 'unknown', 'stale', 'as_of']) expect(view.line).not.toContain(word)
  })

  it('★线以内:照说百分比,后面缀上「截至 04:27」', () => {
    const at = ago(30 * 60_000)
    const view = quotaFor('claude', ctx({ claude: { ...SITE, as_of: at.toISOString() } }))
    // 窗口型取**最紧的那一扇**(周 82% 盖不住、也盖不过 5h 100%):这一条是老规矩,卡 QA 没动它。
    expect(view.left_pct).toBe(82)
    expect(view.line).toBe(`本周还剩约 82% · 截至 ${quotaAsOfClock(at.toISOString(), NOW)}`)
    expect(view.stale).toBeUndefined()
  })

  it('刚读到的(一刻钟以内)不写时刻:那是噪音 —— 界面上就是那一句', () => {
    const view = quotaFor('claude', ctx({ claude: { ...SITE, as_of: ago(60_000).toISOString() } }))
    expect(view.line).toBe('本周还剩约 82%')
    expect(view.read_at).toBe(ago(60_000).toISOString())
  })

  it('as_of 缺席(老宿主、这条来源没给)→ 照这一版之前那样走,不替它编一个时刻', () => {
    const view = quotaFor('claude', ctx({ claude: { kind: 'quota', windows: [{ label: '周', left_pct: 69 }] } }))
    expect(view.left_pct).toBe(69)
    expect(view.line).toBe('本周还剩约 69%')
    expect(view.read_at).toBe(NOW.toISOString())
  })

  it('★余额型(DeepSeek)同一条线:过线不出钱数', () => {
    const balance: QuotaEntry = {
      kind: 'balance', currency: '元', total: '12.34', available: true, as_of: AT_0427.toISOString(),
    }
    const view = quotaFor('dsh', ctx({ dsh: balance }))
    expect(view.line).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
    expect(view.left).toBeUndefined()
    expect(view.stale).toBe(true)
  })

  it('★派活确认点与电话念的是同一句(balanceFromQuota 原样带过去)', () => {
    const view = quotaFor('claude', ctx({ claude: SITE }))
    expect(balanceFromQuota(view)).toEqual({
      level: 'unknown', text: `${QUOTA_STALE_VALUE},上次 04:27`, state: 'numbers', stale: true,
    })
  })

  it('★电话里念的那一句(choiceLine)带着截至时刻,不念一个 17 小时前的百分比', () => {
    const balance = balanceFromQuota(quotaFor('claude', ctx({ claude: SITE })))
    const chosen = { family: 'claude', title: 'Claude', ok: true, balance }
    const line = choiceLine('code', chosen, [chosen])
    expect(line).toBe(`写代码的活 → 派给 Claude(${QUOTA_STALE_VALUE},上次 04:27)`)
    expect(line).not.toContain('%')
  })
})

describe('落盘那一份(last-quota.json)', () => {
  it('★存的时候带上 as_of —— 不带,重启之后那个数就没有年纪了', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-as-of-'))
    const file = join(dir, 'last-quota.json')
    const entry: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 54 }], as_of: AT_0427.toISOString() }
    await saveLastQuota(file, { claude: entry })
    expect(JSON.parse(await readFile(file, 'utf8')).quota.claude.as_of).toBe(AT_0427.toISOString())
    expect(await loadLastQuota(file)).toEqual({ claude: entry })
  })

  it('★没有 as_of 的那一份不载入(升级前写下的):宁可这一格空着,也不替它编一个时刻', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quota-as-of-'))
    const file = join(dir, 'last-quota.json')
    // 真机 ~/.dsh/workbench/last-quota.json 2026-09-26 22:10 那一份就是这个形状(周 54%、09-29 重置)。
    await writeFile(file, JSON.stringify({
      quota: { claude: { kind: 'quota', windows: [{ label: '周', left_pct: 54, reset_at: '2026-09-29T08:00:00.000Z' }] } },
    }))
    expect(await loadLastQuota(file)).toEqual({})
  })
})
