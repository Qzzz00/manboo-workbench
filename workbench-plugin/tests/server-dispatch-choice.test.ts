import { forgetQuotaMemory } from '../src/server/agentQuota.ts'
beforeEach(() => forgetQuotaMemory())
// @vitest-environment node
/**
 * 派活挑手(2026-09-25,卡 O「派活的眼睛」):这是什么活、派给谁、还剩多少。
 *
 * 维护者:「那就不应该派给 Codex 啊,应该派给 Claude 啊」(他在引导里说过 Claude 写代码);
 * 「事务官派活的时候,得知道现在各家的余额情况吧?」。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentCapsView, QuotaEntry } from '../src/protocol.ts'
import { agentCapsFrom } from '../src/server/agentCaps.ts'
import type { CapFacts } from '../src/server/agentCaps.ts'
import {
  balanceOf, choiceLine, dispatchChoices, divisionFromArchive, divisionOf, divisionOfText, divisionRuleText, expiryPickOf, handsFor, jobKindOf,
} from '../src/server/dispatchChoice.ts'
import { EXPIRY_RICH_LEFT_PCT, EXPIRY_SOON_MS } from '../src/server/dispatchChoice.ts'

/** 统筹 09-25 手加的那一条(维护者 rules.json 里的原文)。 */
const MANUAL_RULE = '派活默认分工:写代码的活派 Claude(他的主力,额度 Max 二十倍);综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'

/** 维护者引导存档里「其它习惯」那一段(onboarding.json answers.habits.other 原文)。 */
const HABITS_OTHER = 'Lapis 项目:仓库名还叫 Echo,产品名已改成 Lapis;Kimi 现在专门负责它;它也准备拿去参加 Spotlight 比赛;先聚焦 desktop-workbench,之后可能单独开项目。工作习惯:Codex 用 GPT6 后审美好,倾向让它做综合性的事;Claude 擅长写代码,额度 Max 二十倍,大部分代码工作放这边;常同时并行好几个项目。他喜欢听播客,想按这两个项目做定向搜索、生成播客与项目进展'

const AT = '2026-09-25T15:00:00.000Z'

function caps(claudeLogin: 'yes' | 'no' = 'no'): AgentCapsView {
  const facts: CapFacts = {
    installed: { claude: true, codex: true, kimi: true, muse: true, manus: true, doubao: true },
    helper: { connected: true, authorized: true, newConversation: true, readReply: true },
    window: {},
    // 2026-10-22(卡 C):Kimi 的命令行在体检范围内,与 Claude / Codex 同列。
    cli: { claude: { found: true, login: claudeLogin, at: AT }, codex: { found: true, login: 'yes', at: AT }, kimi: { found: true, login: 'yes', at: AT } },
  }
  return agentCapsFrom(facts)
}

/** 假额度:Claude 本周 62%、5 小时 88%;Codex 5 小时 80%;Kimi 读不到。 */
const QUOTA: Partial<Record<'dsh' | 'claude' | 'codex' | 'kimi', QuotaEntry>> = {
  claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '5h', left_pct: 88 }, { label: '周', left_pct: 62 }] },
  codex: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '5h', left_pct: 80 }, { label: '周', left_pct: 91 }] },
  kimi: { kind: 'unknown', note: '没登' },
  dsh: { kind: 'quota', windows: [{ label: '今日', left_pct: 67 }] },
}

const BUDGET = { cny: 0.5, minutes: 10 }

describe('这是什么活', () => {
  it('写代码 / 改文件 vs 只要一段字;明说的优先', () => {
    expect(jobKindOf('修一下首页球的显示问题').kind).toBe('code')
    expect(jobKindOf('把 settings.tsx 里那个按钮改成深色').kind).toBe('code')
    expect(jobKindOf('[派活测试] 让 Kimi 用一句话回答:一年有几个季节?').kind).toBe('chat')
    expect(jobKindOf('[派活测试] 让 Codex 只读地用一句话告诉我 README 第一段讲什么').kind).toBe('chat')
    expect(jobKindOf('写一段小红书文案').kind).toBe('chat')
    // 挂在代码项目下的「做 / 改 / 收尾」:写代码;内容类的不算
    expect(jobKindOf('参赛网页架构收尾', { inRepo: true }).kind).toBe('code')
    expect(jobKindOf('参赛网页架构收尾').kind).toBe('chat')
    expect(jobKindOf('参赛视频', { inRepo: true }).kind).toBe('chat')
    expect(jobKindOf('随便什么', { explicit: 'code' })).toEqual({ kind: 'code', why: '点明了是写代码的活' })
    // ★ 10-29 10:12(任务书「中枢派到窗口手不按发送」):「查 t-xxx 为什么…」是进仓库查根因的活 ——
    // 窗口拿不到仓库,认成 code 走命令行手;不带卡号的「查一下国庆放几天」照旧是聊天的活。
    expect(jobKindOf('查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天').kind).toBe('code')
    expect(jobKindOf('t-b804e4f2 查仓库里两张卡为什么派发 done 还挂在进行中,进仓库查根因').kind).toBe('code')
    expect(jobKindOf('查一下国庆放几天').kind).toBe('chat')
    expect(jobKindOf('让小K查 8791 空转热点').kind).toBe('chat')
  })

  it('★写代码的活只用能改本机文件的手(Claude / Codex / Kimi 的命令行,2026-10-22 卡 C);聊天的活照 A3 一字不变', () => {
    expect(handsFor('claude', 'code')).toEqual(['cli'])
    expect(handsFor('codex', 'code')).toEqual(['cli'])
    expect(handsFor('kimi', 'code')).toEqual(['cli'])
    expect(handsFor('muse', 'code')).toEqual([])
    expect(handsFor('claude', 'chat')).toEqual(['window'])
    expect(handsFor('codex', 'chat')).toEqual(['window', 'cli'])
    expect(handsFor('doubao', 'chat')).toEqual(['window', 'api'])
  })
})

describe('还剩多少(确认点里那一句)', () => {
  it('取最紧的那一格;快用完 / 用完了明说;每家三格之一(有数 / 不限 / 没接上:原因)', () => {
    expect(balanceOf('claude', QUOTA)).toMatchObject({ level: 'ok', text: '本周还剩约 62%', left_pct: 62, state: 'numbers' })
    expect(balanceOf('codex', QUOTA)).toMatchObject({ level: 'ok', text: '5 小时窗口还剩约 80%' })
    expect(balanceOf('kimi', QUOTA)).toEqual({ level: 'unknown', text: '没接上:这次没取到', state: 'unconnected' })
    // ★卡 QD(2026-09-26):豆包办公**有额度**,读不到就说没接上 ——「不限」那一版已撤
    //(维护者拿那一页的截图:「豆包办公是有额度的,你又糊弄我」)。Muse 同一条路:说清在哪。
    // ★ 2026-09-30 维护者拍板全删「带我过去」:这两行原来各挂一颗那样的键,该他自己去打开哪一页
    // 写在键旁边;键没了,那句话进了行上的 `why`,确认点里这一句一颗键都不带。
    expect(balanceOf('doubao', QUOTA)).toMatchObject({
      level: 'unknown', text: '没接上:额度只在它「订阅与额度管理」那一页上', state: 'unconnected',
    })
    expect(balanceOf('doubao', QUOTA).fix).toBeUndefined()
    expect(balanceOf('muse', QUOTA)).toMatchObject({ level: 'unknown', text: '没接上:剩多少只在它的「使用情况」页上', state: 'unconnected' })
    expect(balanceOf('muse', QUOTA).fix).toBeUndefined()
    expect(balanceOf('claude', { claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 9 }] } })).toMatchObject({ level: 'low', text: '5 小时窗口只剩约 9%,快用完了' })
    expect(balanceOf('claude', { claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 0 }] } })).toMatchObject({ level: 'empty', text: '本周额度用完了' })
    expect(balanceOf('dsh', QUOTA).text).toBe('今天还剩约 67%')
  })
})

describe('分工(规矩表里那一条)', () => {
  it('★统筹手加的那一条读得出:写代码 → Claude、综合 → Codex、Lapis(Echo)→ Kimi', () => {
    expect(divisionOfText(MANUAL_RULE)).toEqual({
      code: 'claude',
      synth: 'codex',
      projects: [{ name: 'Lapis', aliases: ['Echo'], family: 'kimi' }],
    })
    expect(divisionOf([{ text: '不要蓝' }, { text: MANUAL_RULE, title: '派活默认分工' }])?.code).toBe('claude')
    expect(divisionOf([{ text: '不要蓝' }])).toBeUndefined()
  })

  it('★引导存档抽出来的与手加那条是同一件事;写回规矩表的那句话', () => {
    const division = divisionFromArchive({ habits: { other: HABITS_OTHER } }, [{ name: 'Lapis', repo: 'Echo', owner: 'kimi' }])
    expect(division).toEqual({ code: 'claude', synth: 'codex', projects: [{ name: 'Lapis', aliases: ['Echo'], family: 'kimi' }] })
    const text = divisionRuleText(division as NonNullable<typeof division>)
    expect(text).toBe('派活默认分工:写代码的活派 Claude;综合、要审美的活派 Codex;Lapis(仓库 Echo)的活派 Kimi。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。')
    expect(divisionOfText(text as string)).toEqual(division)
    // 一句话里挤着两家分不清谁干什么 → 不认(宁可漏认)
    expect(divisionFromArchive({ x: 'Claude 和 Codex 都写代码' })).toBeUndefined()
  })
})

describe('选项表 + 默认项 + 确认点那一句', () => {
  const division = divisionOfText(MANUAL_RULE)
  const base = { quota: QUOTA, installed: () => true, ...(division === undefined ? {} : { division }) }

  it('★写代码的活:默认 Claude(按规矩);Claude 命令行没登录 → 这一条 ok:false + 「登录 Claude」,确认点里明说;Codex 列作能换的', () => {
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', caps: caps('no') })
    expect(view.kind).toBe('code')
    expect(view.default).toBe('claude')
    expect(view.default_why).toBe('按规矩:写代码的活派 Claude')
    const claude = view.options.find(one => one.family === 'claude')
    expect(claude).toMatchObject({ ok: false, hand: 'cli', recommended: true, balance: { text: '本周还剩约 62%' } })
    expect(claude?.fix?.label).toBe('帮我接上')
    // ★ 卡 BS2(2026-09-28,设计 C1):选项表里**没有「事务官自己做」**那一项了。
    expect(view.options.map(one => one.family)).toEqual(['claude', 'codex', 'kimi'])
    expect(view.options.some(one => one.family === 'dsh')).toBe(false)
    expect(view.line).toBe('写代码的活 → 派给 Claude(本周还剩约 62%);要让 Claude 直接改你电脑上的文件,还差一步:登录一次(点「帮我接上」);也能派给 Codex(5 小时窗口还剩约 80%)、Kimi(没接上:这次没取到)')
  })

  it('Claude 登好了:默认 Claude、ok,确认点里带余额', async () => {
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', caps: caps('yes') })
    expect(view.options.find(one => one.family === 'claude')?.ok).toBe(true)
    expect(view.line).toBe('写代码的活 → 派给 Claude(本周还剩约 62%);也能派给 Codex(5 小时窗口还剩约 80%)、Kimi(没接上:这次没取到)')
  })

  it('★默认那家额度用完了 → 换下一家并说清;他点了名的不换', () => {
    const empty = { ...QUOTA, claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 0 }] } as QuotaEntry }
    const view = dispatchChoices({ ...base, quota: empty, text: '修一下首页球的显示问题', caps: caps('yes') })
    expect(view.default).toBe('codex')
    expect(view.default_why).toContain('Claude 本周额度用完了,这次建议派 Codex')
    const named = dispatchChoices({ ...base, quota: empty, text: '修一下首页球的显示问题', caps: caps('yes'), named: 'claude' })
    expect(named.default).toBe('claude')
  })

  it('个位数的最紧窗口让位给已核实非低额,点名不换', () => {
    const quota = { ...QUOTA, claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 90 }, { label: '5h', left_pct: 9 }] } as QuotaEntry }
    const view = dispatchChoices({ ...base, quota, kind: 'code', text: '修一下首页', caps: caps('yes') })
    expect(view.default).toBe('codex')
    expect(view.default_why).toContain('9%')
    expect(view.default_why).toContain('80%')
    expect(dispatchChoices({ ...base, quota, kind: 'code', text: '修一下首页', named: 'claude', caps: caps('yes') }).default).toBe('claude')
  })

  it('低额之外只有未知时明确未核实,全部低额也解释', () => {
    const quota = { claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 9 }] } as QuotaEntry }
    const view = dispatchChoices({ ...base, quota, kind: 'code', text: '修一下首页', caps: caps('yes') })
    expect(view.default).toBe('codex')
    expect(view.default_why).toContain('额度未核实')
    const low = dispatchChoices({ ...base, quota: { ...quota, codex: quota.claude, kimi: quota.claude }, kind: 'code', text: '修一下首页', caps: caps('yes') })
    expect(low.default).toBe('claude')
    expect(low.default_why).toContain('没有额度已核实且不低的替代人选')
  })

  it('未知、无采集时间与过期读数不当足额或零；同条件仍守分工', () => {
    for (const claude of [
      { kind: 'unknown', no_stale: true },
      { kind: 'quota', windows: [{ label: '5h', left_pct: 90 }] },
      { kind: 'quota', as_of: '2020-01-01T00:00:00Z', windows: [{ label: '5h', left_pct: 90 }] },
    ] as QuotaEntry[]) {
      forgetQuotaMemory()
      const view = dispatchChoices({ ...base, quota: { ...QUOTA, claude }, kind: 'code', text: '修首页', caps: caps('yes') })
      expect(view.default).toBe('codex')
      expect(view.options.find(one => one.family === 'claude')?.balance?.level).toBe('unknown')
    }
    forgetQuotaMemory()
    expect(dispatchChoices({ ...base, quota: {}, kind: 'code', text: '修首页', caps: caps('yes') }).default).toBe('claude')
  })

  it('已耗尽时仍应让位给可用低额候选', () => {
    forgetQuotaMemory()
    const quota = { claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 0 }] }, codex: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 9 }] } } as typeof QUOTA
    const view = dispatchChoices({ ...base, quota, kind: 'code', text: '修首页', caps: caps('yes'), cliFacts: { claude: { found: true, login: 'yes', at: AT }, codex: { found: true, login: 'yes', at: AT }, kimi: { found: false, login: 'unknown', at: AT } } })
    expect(view.default).toBe('codex')
    expect(view.default_why).toContain('9%')
  })

  it('★聊天的活:没点名 → 没有默认项(这一件事务官在对话里自己答,不用派);说到 Lapis → Kimi(按规矩);要综合 / 审美的 → Codex', () => {
    // 卡 BS2:以前这里落到「事务官自己做」那一项上。那一项拿掉了 → `default` 缺席,理由如实写在 `default_why` / `line` 里。
    const chat = dispatchChoices({ ...base, text: '一年有几个季节', caps: caps() })
    expect(chat.default).toBeUndefined()
    expect(chat.default_why).toBe('没点名的聊天活事务官自己答,不用派')
    expect(chat.line).toContain('这一件事务官自己答,不用派')
    const lapis = dispatchChoices({ ...base, text: '看看 Lapis 这周的进展写个摘要', caps: caps() })
    expect(lapis.default).toBe('kimi')
    expect(lapis.default_why).toBe('按规矩:Lapis 的活派 Kimi')
    expect(lapis.options.find(one => one.family === 'kimi')?.balance?.text).toBe('没接上:这次没取到')
    expect(dispatchChoices({ ...base, text: '帮我想一个参赛页的整体设计方案', caps: caps() }).default).toBe('codex')
  })

  it('Lapis 的活要改代码 → 按规矩派 Kimi(2026-10-22 卡 C 起 Kimi 命令行能改本机文件)', () => {
    const view = dispatchChoices({ ...base, text: '修一下 Lapis 里的登录报错', caps: caps('yes') })
    expect(view.kind).toBe('code')
    expect(view.default).toBe('kimi')
    expect(view.default_why).toContain('按规矩:Lapis 的活派 Kimi')
    expect(view.options.find(one => one.family === 'kimi')).toMatchObject({ ok: true, hand: 'cli' })
  })

  it('没有规矩、Claude 没登录:写代码的活挑第一家能改文件的(Codex)', () => {
    const view = dispatchChoices({ quota: QUOTA, installed: () => true, text: '修一下首页球的显示问题', caps: caps('no') })
    expect(view.default).toBe('codex')
  })

  it('choiceLine:快用完了提一句可以换(不重复「快用完了」)', () => {
    const line = choiceLine('code', { family: 'claude', title: 'Claude', ok: true, balance: { level: 'low', text: '5 小时窗口只剩约 9%,快用完了' } }, [])
    expect(line).toBe('写代码的活 → 派给 Claude(5 小时窗口只剩约 9%,快用完了),可以换一家')
  })
})

/**
 * ★ **派活前额度预检**(2026-10-28,演示断点①:点小G(=Codex)的活真派出去才撞 usage limit):
 * 点名的那家额度**查实是 0** → 那一家标成派不出去、说清为什么、建议换一张名片;
 * 「快用完」与「没读到数(未核实)」都不是「用完了」——不拦(那是不知道,不是零)。
 */
describe('派活前额度预检:点名 + 额度查实 0 → 不派,建议换一张名片', () => {
  const division = divisionOfText(MANUAL_RULE)
  const base = { quota: QUOTA, installed: () => true, caps: caps('yes'), ...(division === undefined ? {} : { division }) }
  const emptyClaude = { ...QUOTA, claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 0 }] } as QuotaEntry }

  it('点名 + 查实 0:那一家 ok:false、话里带「额度用完了」与「换一张名片」;默认仍是他点的那家(不替他换)', () => {
    const view = dispatchChoices({ ...base, quota: emptyClaude, text: '修一下首页球的显示问题', named: 'claude' })
    const claude = view.options.find(one => one.family === 'claude')
    expect(claude?.ok).toBe(false)
    expect(claude?.why).toContain('本周额度用完了')
    expect(claude?.why).toContain('换一张名片')
    // 与「没装」那一条同款处置:他点了名的照列、照实说,不静默换人。
    expect(view.default).toBe('claude')
    expect(view.default_from).toBe('named')
    expect(view.line).toContain('本周额度用完了')
    expect(view.line).toContain('换一张名片')
  })

  it('快用完(低额)不拦:照旧派得出去,确认点里提一句可以换', () => {
    const quota = { ...QUOTA, claude: { kind: 'quota', as_of: new Date().toISOString(), windows: [{ label: '周', left_pct: 9 }] } as QuotaEntry }
    const view = dispatchChoices({ ...base, quota, text: '修一下首页球的显示问题', named: 'claude' })
    expect(view.options.find(one => one.family === 'claude')?.ok).toBe(true)
    expect(view.line).toContain('可以换一家')
  })

  it('数旧了(没核实到最新的)不拦:那是「不知道还剩多少」,不是「用完了」', () => {
    const stale = { ...QUOTA, claude: { kind: 'quota', as_of: '2020-01-01T00:00:00Z', windows: [{ label: '周', left_pct: 0 }] } as QuotaEntry }
    const view = dispatchChoices({ ...base, quota: stale, text: '修一下首页球的显示问题', named: 'claude' })
    const claude = view.options.find(one => one.family === 'claude')
    expect(claude?.ok).toBe(true)
    expect(claude?.balance?.level).toBe('unknown')
  })

  it('读不到数(没接上)不拦:照旧派,派的时候再看', () => {
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', named: 'kimi' })
    expect(view.options.find(one => one.family === 'kimi')?.ok).toBe(true)
  })
})

/**
 * ★ **额度按到期先花**(2026-10-28,任务书第 10 条;维护者 14:3x:「Kimi 月额度明天要重置了,
 * 这种场景要怎么做成机制」):选人从前只看「还剩多少」,不看「什么时候重置」。机制:默认项
 * (他没点名、也不是项目规矩)落定后,候选里有「快重置且剩得多」的一家 → 默认改派那一家
 * (剩得多 × 重置近 = 不用就作废),理由里说清哪家、哪扇窗、几点重置、还剩多少。
 */
describe('额度按到期先花:快重置且剩得多的排前', () => {
  const NOW = new Date('2026-10-28T14:30:00') // 本地时刻
  const TOMORROW_8AM = new Date(2026, 9, 29, 8, 0) // 明早 8 点(本地构造,与时区无关)= 17.5 小时后
  const iso = (d: Date): string => d.toISOString()
  const inHours = (h: number): string => iso(new Date(NOW.getTime() + h * 3_600_000))
  const division = divisionOfText(MANUAL_RULE)
  const base = { installed: () => true, caps: caps('yes'), ...(division === undefined ? {} : { division }) }
  /** 宽裕但重置在 3 天后(不快)的一家。 */
  const steady = (): QuotaEntry => ({ kind: 'quota', as_of: iso(NOW), windows: [{ label: '5h', left_pct: 88, reset_at: inHours(3) }, { label: '周', left_pct: 62, reset_at: inHours(72) }] }) as QuotaEntry
  /** Kimi 月窗 79% 明早 8 点重置 —— 快重置且剩得多。 */
  const soonRich = (left = 79, resetAt = iso(TOMORROW_8AM)): QuotaEntry => ({ kind: 'quota', as_of: iso(NOW), windows: [{ label: '月', left_pct: left, reset_at: resetAt }] }) as QuotaEntry
  const QUOTA_STEADY = { claude: steady(), codex: steady(), kimi: steady() }

  it('★规矩默认 Claude,但 Kimi 月窗快重置且剩得多 → 默认改派 Kimi;理由说清哪家几点重置还剩多少', () => {
    const view = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich() }, kind: 'code', text: '修一下首页球的显示问题', quotaCtx: { now: NOW } })
    expect(view.default).toBe('kimi')
    expect(view.default_from).toBe('fallback')
    expect(view.default_why).toBe('按规矩:写代码的活派 Claude;Kimi 本月还剩约 79%,08:00 重置,先用它')
    expect(view.options.find(one => one.family === 'kimi')?.recommended).toBe(true)
    expect(view.line).toBe('写代码的活 → 派给 Kimi(本月还剩约 79%);也能派给 Claude(本周还剩约 62%)、Codex(本周还剩约 62%)')
  })

  it('两家都够格 → 重置更近的那家赢;重置同时刻 → 剩得多的那家赢', () => {
    const nearer = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(), codex: soonRich(90, inHours(20)) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(nearer.default).toBe('kimi')
    expect(nearer.default_why).toContain('Kimi 本月还剩约 79%')
    const richer = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(79), codex: soonRich(60) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(richer.default).toBe('kimi')
  })

  it('短窗(5 小时 / 今日)本来就一天内重置,不算「快重置」 —— 周 / 月这种长窗才算', () => {
    // QUOTA_STEADY 里 Claude / Codex 的 5 小时窗 88%、3 小时后重置:够近也够多,但周期太短,不抢。
    const view = dispatchChoices({ ...base, quota: QUOTA_STEADY, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(view.default).toBe('claude')
    expect(view.default_why).toBe('按规矩:写代码的活派 Claude')
  })

  it('他点了名的不换:默认仍是他点的那家,理由不带「先用它」', () => {
    const view = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich() }, kind: 'code', text: '修一下首页', named: 'claude', quotaCtx: { now: NOW } })
    expect(view.default).toBe('claude')
    expect(view.default_from).toBe('named')
    expect(view.default_why).not.toContain('先用它')
  })

  it('项目规矩(这个项目的活归谁)不被抢:Lapis 归 Kimi,Claude 再快重置也照旧', () => {
    const quota = { ...QUOTA_STEADY, claude: soonRich(), kimi: steady() }
    const view = dispatchChoices({ ...base, quota, kind: 'code', text: '修一下 Lapis 里的登录报错', project: { name: 'Lapis' }, quotaCtx: { now: NOW } })
    expect(view.default).toBe('kimi')
    expect(view.default_from).toBe('project_rule')
    expect(view.default_why).toContain('按规矩:Lapis 的活派 Kimi')
    expect(view.default_why).not.toContain('先用它')
  })

  it('默认那家自己就是快重置且剩得多的那家 → 不换,理由也不重复这一句', () => {
    const quota = { ...QUOTA_STEADY, claude: soonRich() }
    const view = dispatchChoices({ ...base, quota, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(view.default).toBe('claude')
    expect(view.default_why).toBe('按规矩:写代码的活派 Claude')
  })

  it('线:24 小时内才算「快重置」(边界),超出照旧按规矩', () => {
    const at = (ms: number) => iso(new Date(NOW.getTime() + ms))
    const within = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(79, at(EXPIRY_SOON_MS)) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(within.default).toBe('kimi')
    const beyond = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(79, at(EXPIRY_SOON_MS + 60_000)) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(beyond.default).toBe('claude')
  })

  it('线:那一扇窗还剩一半以上才算「剩得多」(边界);剩得少的快重置窗不抢', () => {
    const rich = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(EXPIRY_RICH_LEFT_PCT) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(rich.default).toBe('kimi')
    const poor = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: soonRich(EXPIRY_RICH_LEFT_PCT - 1) }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(poor.default).toBe('claude')
  })

  it('数旧了(未核实)不抢:那是「不知道还剩多少」,不是「快重置剩得多」', () => {
    const stale: QuotaEntry = { kind: 'quota', as_of: iso(new Date(NOW.getTime() - 3 * 3_600_000)), windows: [{ label: '月', left_pct: 79, reset_at: iso(TOMORROW_8AM) }] } as QuotaEntry
    const view = dispatchChoices({ ...base, quota: { ...QUOTA_STEADY, kimi: stale }, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } })
    expect(view.default).toBe('claude')
    expect(view.options.find(one => one.family === 'kimi')?.balance?.level).toBe('unknown')
  })

  it('expiryPickOf:候选里一家都够不到格 → 回 undefined;够格时带回那句人话', () => {
    const options = dispatchChoices({ ...base, quota: QUOTA_STEADY, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } }).options
    expect(expiryPickOf({ options, quota: QUOTA_STEADY, now: NOW })).toBeUndefined()
    const quota = { ...QUOTA_STEADY, kimi: soonRich() }
    const picked = expiryPickOf({ options: dispatchChoices({ ...base, quota, kind: 'code', text: '修一下首页', quotaCtx: { now: NOW } }).options, quota, now: NOW })
    expect(picked?.option.family).toBe('kimi')
    expect(picked?.why).toBe('Kimi 本月还剩约 79%,08:00 重置,先用它')
  })
})

describe('★「能换的几家」只算命令行真探到、且登录状态不是 no 的(2026-10-22 卡 C 收尾)', () => {
  const division = divisionOfText(MANUAL_RULE)
  const base = { quota: QUOTA, installed: () => true, ...(division === undefined ? {} : { division }) }

  function capsWith(cli: CapFacts['cli']): AgentCapsView {
    const facts: CapFacts = {
      installed: { claude: true, codex: true, kimi: true, muse: true, manus: true, doubao: true },
      helper: { connected: true, authorized: true, newConversation: true, readReply: true },
      window: {},
      cli,
    }
    return agentCapsFrom(facts)
  }

  /**
   * ★ 没装 Kimi 命令行的机器(体检没探到 Kimi 那一份):写代码的活,「能换的几家」里**没有 Kimi** ——
   * 从前 `hasCodeCli('kimi')` 一说「有命令行手」就把它列成能换的,没装的机器也会把 Kimi 推荐给用户。
   */
  it('★没装 Kimi 命令行的机器:写代码的活不推荐 Kimi', () => {
    const cli: CapFacts['cli'] = { claude: { found: true, login: 'yes', at: AT }, codex: { found: true, login: 'yes', at: AT } }
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', caps: capsWith(cli), cliFacts: cli })
    expect(view.options.find(one => one.family === 'kimi')?.ok).toBe(false)
    expect(view.line).toBe('写代码的活 → 派给 Claude(本周还剩约 62%);也能派给 Codex(5 小时窗口还剩约 80%)')
  })

  it('Kimi 那份探过了、确实没装(found:false):照样不列,话照体检那一格说', () => {
    const cli: CapFacts['cli'] = {
      claude: { found: true, login: 'yes', at: AT },
      codex: { found: true, login: 'yes', at: AT },
      kimi: { found: false, login: 'unknown', at: AT },
    }
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', caps: capsWith(cli), cliFacts: cli })
    const kimi = view.options.find(one => one.family === 'kimi')
    expect(kimi?.ok).toBe(false)
    expect(kimi?.why).toContain('没装 Kimi Code CLI')
    expect(view.line).not.toContain('Kimi(')
  })

  /**
   * 正向钉:Kimi 没有只本地的登录查法,登录状态只会是 unknown —— **装了(found)就照列**,
   * 不许收紧成「登录查到 yes 才算」(那样真机上的 Kimi 永远进不了「能换的几家」,卡 C 那只手就废了)。
   */
  it('Kimi 命令行装着、登录状态 unknown:照列进「能换的几家」', () => {
    const cli: CapFacts['cli'] = {
      claude: { found: true, login: 'yes', at: AT },
      codex: { found: true, login: 'yes', at: AT },
      kimi: { found: true, login: 'unknown', at: AT },
    }
    const view = dispatchChoices({ ...base, text: '修一下首页球的显示问题', caps: capsWith(cli), cliFacts: cli })
    expect(view.options.find(one => one.family === 'kimi')).toMatchObject({ ok: true, hand: 'cli' })
    expect(view.line).toContain('也能派给 Codex(5 小时窗口还剩约 80%)、Kimi(没接上:这次没取到)')
  })
})

describe('确认点里每一家都有额度那一格(统筹 09-25:没有空白、没有占位句)', () => {
  it('★聊天的活:能换的每一家都列上,各带三格之一 —— 有数 / 不限 / 没接上:原因', () => {
    const view = dispatchChoices({
      text: '让 Claude 用一句话说说演示项目是干什么的', named: 'claude', quota: QUOTA, installed: () => true, caps: caps('no'), apiReady: true,
      // 卡 GH(2026-09-26):GPT 在名单上的前提是**中转上真配了 OpenAI**。
      relayProviders: { deepseek: true, openai: true, doubao: true },
    })
    expect(view.line).toBe('聊天 / 问答的活 → 派给 Claude(本周还剩约 62%);也能派给 Codex(5 小时窗口还剩约 80%)、Kimi(没接上:这次没取到)、豆包办公(没接上:额度只在它「订阅与额度管理」那一页上)、Muse(没接上:剩多少只在它的「使用情况」页上)、Manus(没接上:积分只在它首页右上角)、GPT(没接上:读不到工作台服务今天还剩多少)')
    for (const family of ['doubao', 'muse', 'manus'] as const) {
      expect(view.options.find(one => one.family === family)?.balance?.state).toMatch(/^(numbers|unlimited|unconnected)$/)
    }
  })

  /**
   * ★ 卡 GH(2026-09-26):**中转上没配 OpenAI → 这张选项表里压根没有 GPT**。
   * 豆包照常在(它还有窗口那只手)。这是维护者 09-26 那句「GPT 那条没有意义」的落法 ——
   * 不删代码,只是改成「中转配了哪家才出现哪家」。
   */
  it('★中转没配 OpenAI → 选项表里没有 GPT;豆包照常在', () => {
    const base = { text: '帮我把这段话润色一下', quota: QUOTA, installed: () => true, caps: caps('no'), apiReady: true }
    const view = dispatchChoices({ ...base, relayProviders: { deepseek: true, openai: false, doubao: true } })
    expect(view.options.some(one => one.family === 'gpt')).toBe(false)
    expect(view.options.some(one => one.family === 'doubao')).toBe(true)
    expect(view.line).not.toContain('GPT')
    // `/health` 一次都没问到过(缺席)= 同样当没配:宁可少一家,不摆空壳。
    expect(dispatchChoices(base).options.some(one => one.family === 'gpt')).toBe(false)
  })

  it('窗口上读到了(Manus 首页右上角的积分、Muse 使用情况页、豆包办公的订阅与额度管理页)→ 确认点里是数', () => {
    const at = '2026-09-25T09:40:00.000Z'
    const view = dispatchChoices({
      text: '让 Manus 查一下资料', named: 'manus', quota: QUOTA, installed: () => true, caps: caps('no'),
      quotaCtx: {
        now: new Date('2026-09-25T10:00:00.000Z'),
        window: {
          manus: { last: { at, width: 1200, matches: [{ id: 'credits', text: '1,234', x: 1100, y: 20 }] }, attempt: { at, found: true } },
          // 卡 MQ(2026-09-26):那个百分比要有「这确实是『使用情况』那一页」的旁证才认(见 museQuotaOf)。
          muse: { last: { at, matches: [{ id: 'page', text: '使用情况', x: 300, y: 120 }, { id: 'used', text: '已使用 38%', x: 300, y: 200 }] }, attempt: { at, found: true } },
          // 卡 QD(2026-09-26):豆包办公那一页上两扇窗;确认点里那一句说**最紧的那一扇**。
          doubao: { last: { at, matches: [
            { id: 'page', text: '订阅与额度管理', x: 520, y: 212 },
            { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
            { id: 'used', text: '已用 <1%', x: 860, y: 400 },
            { id: 'window_7d', text: '近 7 天', x: 420, y: 500 },
            { id: 'used', text: '已用 30%', x: 860, y: 500 },
          ] }, attempt: { at, found: true } },
        },
      },
    })
    // 20 分钟前在它窗口上读到的 → 那一句里带上「截至 HH:MM」(卡 QS 要写时刻,卡 QA 统一成「截至」)。
    expect(view.line).toMatch(/派给 Manus\(剩 1,234 积分 · 截至 \d{2}:\d{2}\)/)
    expect(view.line).toMatch(/Muse\(还剩约 62% · 截至 \d{2}:\d{2}\)/)
    expect(view.line).toMatch(/豆包办公\(本周还剩约 70% · 截至 \d{2}:\d{2}\)/)
    expect(view.line).not.toContain('豆包办公(不限)')
  })
})

/**
 * ★ 没装 Claude 的机器上不许把 Claude 当退路(2026-10-01 Air 诊断包 153413,同学反馈:
 * 「这台 MacBook 上我没装 Claude,事务官会说把活交给 Claude 做」)。
 * 写代码的活候选固定是 Codex / Claude,没装的那一家以前垫了个空壳目标、查不到能力 → 判成「派的时候再看」= 能派。
 */
describe('没装的那一家:列出来也照实说没装,不算能派', () => {
  const AIR_TARGETS = [
    { id: 'codex', title: 'Codex', bundle_id: 'com.openai.codex', hands: ['window', 'cli'], aliases: [], from_registry: true },
    { id: 'doubao', title: '豆包办公', bundle_id: 'com.work.pc.doubao', hands: ['window'], aliases: [], from_registry: true },
  ] as never

  it('★写代码的活:Claude 不在本机目标里 → ok:false「这台电脑上没装 Claude」,不是默认、不进退路', () => {
    const view = dispatchChoices({ text: '修一下首页球的显示问题', quota: {}, installed: family => family !== 'claude', targets: AIR_TARGETS })
    const claude = view.options.find(one => one.family === 'claude')
    expect(claude).toMatchObject({ ok: false })
    expect(claude?.why).toContain('没装')
    expect(view.default).not.toBe('claude')
    expect(view.options.filter(one => one.ok).map(one => one.family)).not.toContain('claude')
  })

  it('他点名要 Claude:照样列出来、照实说没装(不替他换)', () => {
    const view = dispatchChoices({ text: '让 Claude 修一下首页', named: 'claude', quota: {}, installed: family => family !== 'claude', targets: AIR_TARGETS })
    expect(view.default).toBe('claude')
    expect(view.options.find(one => one.family === 'claude')).toMatchObject({ ok: false })
  })
})
