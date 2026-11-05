/**
 * **「读不到最新」那一格说清为什么、给一个入口**(2026-10-02,卡 QK)。
 *
 * 卡 QA 把过线那一档从「照说那个数」改成「读不到最新的,上次 04:27」—— 不再骗人了,
 * 可她看到的仍然只有这一句。查实的那一幕(`docs/交接-1002-额度陈旧要标出来.md` 第 2 节):
 * Claude 唯一能**随她的使用实时更新**的那条路要一把她没配的凭据;桌面端那份用量文件 04:27 起停更;
 * statusLine 在桌面端拉起的 Claude Code 里压根不响。**界面上一个字都没说。**
 *
 * 机制(每一家都适用,不只 Claude):
 * - 「有没有更实时的来源、缺什么」由**各家额度来源自己声明**(`quota/liveSources.ts` 一处),
 *   界面与服务端一个家名都不写;
 * - 采集层**每轮现盖**到 entry 上(`quota/collect.ts` 一处)—— 它说的是「这台机器此刻缺什么」,
 *   跟那个数是哪一轮读到的无关;
 * - 文案一处拼(`protocol.ts` 的 `quotaStaleNote`),电脑额度格 / 手机 / 展示台三端共用;
 * - **没有更实时来源的家只说「上次 HH:MM」**,不凭空长出一句话、也不长出一颗按钮。
 *
 * 外加一条:**一个密钥都不许出现在这条路上**(AGENTS.md「不展示或写入 API Key…」)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, ClientsView, QuotaEntry, QuotaStaleHint } from '../src/protocol.ts'
import { QUOTA_STALE_VALUE, quotaStaleNote } from '../src/protocol.ts'
import {
  CLAUDE_KEY_REJECTED_WHY, CLAUDE_LIVE_FIX, CLAUDE_LIVE_WHY, CLAUDE_STALE_WHY, hasLiveQuotaSource, quotaStaleHintFor,
} from '../src/quota/liveSources.ts'
import { collectQuota } from '../src/quota/collect.ts'
import type { QuotaAdapterContext } from '../src/server/agentQuota.ts'
import { forgetQuotaMemory, quotaFor } from '../src/server/agentQuota.ts'
import { quotaCells } from '../src/client/quotaCells.ts'

/** 现场那一天:10-02 21:30 本地。 */
const NOW = new Date(2026, 9, 2, 21, 30, 0)
/** 桌面端最后那个样本:10-02 04:27 本地(17 小时前,过线)。 */
const AT_0427 = new Date(2026, 9, 2, 4, 27, 40)

/** 一把**假**的 setup-token。只用来证明它一个字节都不会出现在界面上。 */
const FAKE_TOKEN = 'sk-ant-fake-not-a-real-token'

/** 两样都没配(她真机上的状态:那份凭据文件里只有 `kimi_web`)。 */
const NOTHING = () => false

describe('声明那一处:哪一家有更实时的来源、缺什么', () => {
  it('★Claude:两样都没配 → 「为什么」+「配一把就能实时」+ 一个入口', () => {
    const hint = quotaStaleHintFor('claude', NOTHING)
    expect(hint).toEqual({ why: CLAUDE_STALE_WHY, live: { why: CLAUDE_LIVE_WHY, fix: CLAUDE_LIVE_FIX } })
    // 入口指向**已经有的那一行**(设置 →「各家的密钥与登录」→ Claude),这张卡不做配置流程。
    expect(CLAUDE_LIVE_FIX.at).toEqual({ group: 'agents', row: 'claude_api' })
    // 只能在这台电脑前做:手机与展示台只念那句话,不画按钮。
    expect(CLAUDE_LIVE_FIX.desk_only).toBe(true)
  })

  it('★配上了(环境变量 / 凭据任一)→ 那句话自己闭嘴:实时源通着,再劝她配一把是句废话', () => {
    const byEnv = quotaStaleHintFor('claude', name => name === 'CLAUDE_SETUP_TOKEN')
    const byCred = quotaStaleHintFor('claude', name => name === 'claude_api')
    expect(byEnv).toEqual({ why: CLAUDE_STALE_WHY })
    expect(byCred).toEqual({ why: CLAUDE_STALE_WHY })
    expect(byEnv?.live).toBeUndefined()
    expect(byCred?.live).toBeUndefined()
  })

  it('★没有更实时来源的那几家:整格缺席 —— 不替它编一个原因、也不编一个入口(D13)', () => {
    for (const id of ['dsh', 'codex', 'kimi', 'manus', 'muse', 'doubao', '认不出的一家']) {
      expect(quotaStaleHintFor(id, NOTHING)).toBeUndefined()
      expect(hasLiveQuotaSource(id)).toBe(false)
    }
    expect(hasLiveQuotaSource('claude')).toBe(true)
  })

  it('★这条路上一个密钥都不经过:声明里只有名字,那句话里不提值、也不提它长什么样', () => {
    const hint = quotaStaleHintFor('claude', name => name === 'claude_api')
    expect(JSON.stringify(hint)).not.toContain(FAKE_TOKEN)
    // 卡 SG:界面上不说「API Key」「setup-token」这类词 —— 用的人是不写代码的半专业个体。
    for (const jargon of ['token', 'Token', 'API Key', '终端', '命令行']) {
      expect(CLAUDE_LIVE_WHY).not.toContain(jargon)
    }
  })

  /**
   * ★ 2026-10-03(卡「不让用户知道什么叫 setup-token」)。维护者按原来那句「配一把 Claude 的密钥就能实时」
   * 去配,发现要先在终端里跑一条命令,于是说:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」
   * 所以这句话现在说的是**她真要做的那一下**:点那颗「接上」。
   */
  it('★那句话说的是她真要按的那一下(「接上」),不是「去配一把密钥」', () => {
    expect(CLAUDE_LIVE_WHY).toContain('接上')
    expect(CLAUDE_LIVE_FIX.label).toBe('去接上')
  })

  /**
   * ★「配了但不管用」与「没配」是两句话(卡里第 3 条:密钥过期 / 被 401 时那一格要回到「接上」键)。
   * 两种的下一步一样(再接一次),可说错了她会去找别的毛病。
   */
  it('★密钥被上游拒了:当成缺那一样 —— 那颗键回来,话改成「那把不管用了」', () => {
    const configured = (name: string): boolean => name === 'claude_api'
    // 配着、没被拒 → 这条更实时的路通着,一个字都不多说。
    expect(quotaStaleHintFor('claude', configured)).toEqual({ why: CLAUDE_STALE_WHY })
    // 配着、被拒了 → 那颗入口键回来,而且换一句话。
    expect(quotaStaleHintFor('claude', configured, true)).toEqual({
      why: CLAUDE_STALE_WHY,
      live: { why: CLAUDE_KEY_REJECTED_WHY, fix: CLAUDE_LIVE_FIX },
    })
    expect(CLAUDE_KEY_REJECTED_WHY).not.toBe(CLAUDE_LIVE_WHY)
  })
})

describe('那一句三端共用(quotaStaleNote 一处拼)', () => {
  const at = AT_0427.toISOString()

  it('★三段:这个数多大年纪 · 为什么读不到 · 有更实时的一条缺什么', () => {
    expect(quotaStaleNote(at, NOW, quotaStaleHintFor('claude', NOTHING)))
      .toBe(`上次 04:27 · ${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`)
  })

  it('★没声明的那一家只剩第一段 —— 与卡 QA 那一版一字不差', () => {
    expect(quotaStaleNote(at, NOW, undefined)).toBe('上次 04:27')
    expect(quotaStaleNote(at, NOW, quotaStaleHintFor('codex', NOTHING))).toBe('上次 04:27')
  })

  it('配上了之后那一句自己短一段(只剩「为什么」)', () => {
    expect(quotaStaleNote(at, NOW, quotaStaleHintFor('claude', () => true)))
      .toBe(`上次 04:27 · ${CLAUDE_STALE_WHY}`)
  })

  it('时刻认不出 / 缺席:不糊一个 ISO 串、也不编一个时刻,只剩后面那两段', () => {
    expect(quotaStaleNote('不是时刻', NOW, quotaStaleHintFor('claude', NOTHING)))
      .toBe(`${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`)
    expect(quotaStaleNote(undefined, NOW, undefined)).toBe('')
  })

  it('中文开头的时刻不留那个空格(「上次昨晚 20:42」),数字开头留(「上次 04:27」)', () => {
    const lastNight = new Date(2026, 9, 1, 20, 42).toISOString()
    expect(quotaStaleNote(lastNight, NOW, undefined)).toBe('上次昨晚 20:42')
  })
})

describe('采集层:每轮现盖(quota/collect.ts 一处)', () => {
  const io = {
    codexAppServerIo: { readRateLimits: async () => { throw new Error('没起来') } },
    codexIo: { listSessionFiles: async () => [], readFile: async () => '' },
  }
  /**
   * Claude 桌面端那份文件:20 分钟前落的样本(= 这一轮**真读到数**)。
   *
   * 为什么不拿 04:27 那一份:那条路自己有一道两小时的门槛(`claudeDesktop.ts`),
   * 17 小时前的样本它会直接抛错、走兜底 —— 那是下面第三条用例要撞的那一幕。
   * 这一格盖不盖跟数新不新**无关**(它说的是「此刻缺什么」),所以这里用一份新的更干净。
   */
  const AT_FRESH = new Date(NOW.getTime() - 20 * 60_000)
  const desktopFresh = {
    readFile: async () => JSON.stringify({ version: 2, samples: [{ t: AT_FRESH.getTime(), u: { fh: 0, sd: 18 } }] }),
  }

  it('★她没配那把密钥时:claude 那一格带着「为什么 + 配一把就能实时」', async () => {
    const { quota } = await collectQuota({ env: {}, ...io, claudeDesktopIo: desktopFresh, now: NOW })
    expect(quota.claude).toMatchObject({
      kind: 'quota',
      as_of: AT_FRESH.toISOString(),
      stale_hint: { why: CLAUDE_STALE_WHY, live: { why: CLAUDE_LIVE_WHY } },
    })
  })

  it('★配上了就撤掉那半句 —— 这一格说的是「此刻缺什么」,所以每轮都得现盖', async () => {
    const { quota } = await collectQuota({
      env: { CLAUDE_SETUP_TOKEN: FAKE_TOKEN },
      // 实时那条路要打接口,这里让它不通 —— 走桌面端那条,数还是 04:27 那一份。
      fetch: async () => { throw new Error('打不通') },
      ...io,
      claudeDesktopIo: desktopFresh,
      now: NOW,
    })
    expect((quota.claude as { stale_hint?: unknown }).stale_hint).toEqual({ why: CLAUDE_STALE_WHY })
    // 那把 token 一个字节都不许进 entry(它只该出现在请求头里)。
    expect(JSON.stringify(quota)).not.toContain(FAKE_TOKEN)
  })

  it('★退回上一轮那个 entry 时也盖(现场那一幕的另一半:兜底那条路也得说得出缺什么)', async () => {
    const stale: QuotaEntry = {
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
      as_of: AT_0427.toISOString(),
    }
    const { quota } = await collectQuota({
      env: {},
      ...io,
      claudeDesktopIo: { readFile: async () => { throw new Error('桌面端没在跑') } },
      claude: stale,
      now: NOW,
    })
    // `as_of` 照旧不盖(盖一下那份 04:27 就又变成「刚读到的」),但「缺什么」要盖上。
    expect(quota.claude).toMatchObject({
      as_of: AT_0427.toISOString(),
      stale_hint: { live: { why: CLAUDE_LIVE_WHY } },
    })
  })

  it('没声明的那几家一个字节没多(`unknown` 那一格也不盖:它没有「读不到最新」这一档)', async () => {
    const { quota } = await collectQuota({ env: {}, ...io, claudeDesktopIo: desktopFresh, now: NOW })
    for (const id of ['dsh', 'codex', 'kimi'] as const) {
      expect((quota[id] as { stale_hint?: unknown }).stale_hint).toBeUndefined()
    }
  })
})

describe('服务端一处判(quotaFor → 手机 / 电话念的那一句)', () => {
  const ON = { installed: true, connected: true }
  const OFF = { installed: false, connected: false }
  const clients = (): ClientsView => ({ claude: ON, codex: ON, kimi: ON, wechat: OFF, wecom: OFF })
  const ctx = (quota: QuotaAdapterContext['quota']): QuotaAdapterContext =>
    ({ quota, clients: clients(), now: NOW })

  const site = (hint?: QuotaStaleHint): QuotaEntry => ({
    kind: 'quota',
    windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
    as_of: AT_0427.toISOString(),
    ...(hint === undefined ? {} : { stale_hint: hint }),
  })

  beforeEach(() => { forgetQuotaMemory() })

  it('★过线那一句里三段都在(手机照念的就是它),一个百分比都没有', () => {
    const view = quotaFor('claude', ctx({ claude: site(quotaStaleHintFor('claude', NOTHING)) }))
    expect(view.line).toBe(`${QUOTA_STALE_VALUE},上次 04:27 · ${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`)
    expect(view.line).not.toContain('%')
    // 「没接上」是「从没接上」的说法 —— 这一家读到过数。
    expect(view.line).not.toContain('没接上')
    // 派活确认点括号里那一句照旧短:她在那儿要判的是「这一家值不值得派」,不是去配密钥。
    expect(view.short).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
  })

  it('★那颗入口键的去处原样顶上来(电脑那一格按它定位,服务端不画界面)', () => {
    const view = quotaFor('claude', ctx({ claude: site(quotaStaleHintFor('claude', NOTHING)) }))
    expect(view.stale_hint?.live?.fix).toEqual(CLAUDE_LIVE_FIX)
  })

  it('★没声明的那一家:那一句与卡 QA 一字不差,也没有入口', () => {
    const view = quotaFor('codex', ctx({ codex: site() }))
    expect(view.line).toBe(`${QUOTA_STALE_VALUE},上次 04:27`)
    expect(view.stale_hint).toBeUndefined()
  })

  it('线以内不说这两句 —— 数还新的时候「配一把就能实时」是噪音', () => {
    const fresh = { ...site(quotaStaleHintFor('claude', NOTHING)), as_of: new Date(NOW.getTime() - 60_000).toISOString() }
    const view = quotaFor('claude', ctx({ claude: fresh }))
    expect(view.line).toBe('本周还剩约 82%')
    expect(view.line).not.toContain(CLAUDE_LIVE_WHY)
  })
})

describe('电脑额度格(老四格,读 /state.quota 的原始 entry)', () => {
  const cellOf = (id: 'claude' | 'codex', entry: QuotaEntry, view?: AgentQuotaView) =>
    quotaCells({ [id]: entry }, {}, NOW, undefined, view === undefined ? undefined : [view], [id])[0]!

  const site = (hint?: QuotaStaleHint): QuotaEntry => ({
    kind: 'quota',
    windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
    as_of: AT_0427.toISOString(),
    ...(hint === undefined ? {} : { stale_hint: hint }),
  })

  it('★现场那一格:大字「读不到最新的」,小字三段都在,外加一颗去设置那一行的键', () => {
    const cell = cellOf('claude', site(quotaStaleHintFor('claude', NOTHING)))
    expect(cell.value).toBe(QUOTA_STALE_VALUE)
    expect(cell.note).toBe(`上次 04:27 · ${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`)
    expect(cell.fix).toEqual(CLAUDE_LIVE_FIX)
    expect(cell.stale).toBe(true)
    // 过线那一格一个百分比都不许留下。
    expect(`${cell.value}${cell.note}`).not.toContain('%')
  })

  it('★没有更实时来源的那一家:只说「上次 HH:MM」,一颗键都不画', () => {
    const cell = cellOf('codex', site())
    expect(cell.note).toBe('上次 04:27')
    expect(cell.fix).toBeUndefined()
  })

  it('线以内那一格不长出这颗键(数还新的时候它不是「还差一步」)', () => {
    const fresh = { ...site(quotaStaleHintFor('claude', NOTHING)), as_of: new Date(NOW.getTime() - 60_000).toISOString() }
    const cell = cellOf('claude', fresh)
    expect(cell.value).toBe('82%')
    expect(cell.fix).toBeUndefined()
  })

  it('★这一轮压根没取到数、靠服务端顶上来的那一格(卡 QS 那条路)也给那颗键', () => {
    const kept: AgentQuotaView = {
      id: 'claude',
      title: 'Claude',
      state: 'numbers',
      line: `${QUOTA_STALE_VALUE},上次 04:27 · ${CLAUDE_STALE_WHY} · ${CLAUDE_LIVE_WHY}`,
      read_at: AT_0427.toISOString(),
      stale: true,
      stale_hint: quotaStaleHintFor('claude', NOTHING)!,
    }
    const cell = cellOf('claude', { kind: 'unknown', note: '桌面端没在跑' }, kept)
    expect(cell.note).toContain(CLAUDE_LIVE_WHY)
    expect(cell.fix).toEqual(CLAUDE_LIVE_FIX)
  })
})
