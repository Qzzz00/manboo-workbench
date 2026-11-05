/**
 * **Antigravity 的额度照它页面原样读**(2026-09-27,卡 AG)。
 *
 * 维护者 10:1x 截图、10:22 追问:「**为什么我肉眼都看到额度信息了,但是还说读不到或者读反了**」。
 * 他那一刻页上的原话:
 *
 * | 哪一块 | 原话 |
 * |---|---|
 * | 档位 | 「Your Plan: Google AI Pro」 |
 * | 组一 | 「Gemini Models」下「Weekly Limit Remaining …100%」「Five Hour Limit Remaining …98%」 |
 * | 组二 | 「Claude and GPT models」下同样两条 |
 * | 副标题 | 「…it will fully refresh in 6 days, 19 hours.」「…in 44 minutes.」 |
 *
 * 这张卡钉两件事:
 *
 * 1. **照它页面怎么列就怎么列**:四行,分两组,组名是从页面上**读回来的原话**(不是编的、不是并成一行)。
 *    组名靠第 9 条正则 `group` 认(壳的正则条数从 8 抬到 12、每窗段数从 12 抬到 24 —— 见
 *    `workbench-app/Sources/SendTextPolicy.swift`,**要重装壳**)。
 * 2. **通则(决策记录 D:页面上肉眼看得到的用量数字就必须读到)**:读不到时那一格要说清**卡在哪一步**,
 *    不许笼统一句「这页上没看见用量」。
 *
 * 真机夹具:09-27 10:3x 只读探针(`workbench-app/probe-send-text.sh read-texts com.google.antigravity
 * --allow com.google.antigravity`)回的原话 —— **一扇窗、261 段文字、0 条命中**,窗上是
 * 「Conversation Log」那一页(侧栏「Projects」「Conversations」「Settings」),
 * 也就是说那会儿「Models & Usage」根本不在辅助功能读得到的任何一扇窗上。
 * 老代码对这种情形只会说一句「这页上没看见用量」,维护者当然要问「我肉眼都看到了」。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpenQuotaFamily, QuotaAdapterContext } from '../src/server/agentQuota.ts'
import type { OpenQuotaVerdict } from '../src/server/openQuota.ts'
import { createWindowQuotaReader, forgetQuotaMemory, openQuotaView, quotaFor } from '../src/server/agentQuota.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import {
  OPEN_EVIDENCE_IDS, OPEN_NUMBER_IDS, OPEN_QUOTA_NOT_SEEN, OPEN_QUOTA_PATTERNS, OPEN_SHELL_MAX_MATCHES,
  openQuotaGroup, openQuotaMissShort, openQuotaMissWhy, openQuotaRecipe, rereadOpenNumbers, trustOpenQuota,
} from '../src/server/openQuota.ts'

const NOW = new Date('2026-09-27T02:30:00.000Z')
const ANTIGRAVITY: OpenQuotaFamily = { id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, now: NOW, ...patch }
}

beforeEach(() => { forgetQuotaMemory() })

/**
 * 维护者截图上那一页,**照原样摆**(y 从上往下:页标题 → 档位 → 组一 → 两行 → 组二 → 两行)。
 * 坐标照 1640×945 那扇窗估的:行名在左(x 600)、数在右(x 1200)、组名再往左一点(x 560)。
 */
const PAGE = [
  { id: 'page', text: 'Models & Usage', x: 560, y: 96 },
  { id: 'group', text: 'Gemini Models', x: 560, y: 200 },
  { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 248 },
  { id: 'pct', text: '100%', x: 1200, y: 248 },
  { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 312 },
  { id: 'pct', text: '98%', x: 1200, y: 312 },
  { id: 'group', text: 'Claude and GPT models', x: 560, y: 420 },
  { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 468 },
  { id: 'pct', text: '100%', x: 1200, y: 468 },
  { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 532 },
  { id: 'pct', text: '100%', x: 1200, y: 532 },
]

/** 模型那一行判词:四句原话都列进 items(口径与行名不归它判)。 */
const SAID: OpenQuotaVerdict = {
  kind: 'numbers', quote: '100%', evidence: 'Weekly Limit Remaining', measure: 'left_pct', value: 100,
  items: ['100%', '98%', '100%', '100%'], reason: '这一页上四条限额剩余',
}

describe('卡 AG 一、组名要从页面上读回来', () => {
  it('★第 9 条正则 `group` 认得出「Gemini Models」「Claude and GPT models」', () => {
    const group = OPEN_QUOTA_PATTERNS.find(one => one.id === 'group')
    expect(group).toBeDefined()
    const re = new RegExp(group!.regex)
    expect(re.test('Gemini Models')).toBe(true)
    expect(re.test('Claude and GPT models')).toBe(true)
  })

  it('★组名那一条**不算数字、也不算旁证**(它证明不了这是用量页,只说明这几行归谁)', () => {
    expect(OPEN_NUMBER_IDS).not.toContain('group')
    expect(OPEN_EVIDENCE_IDS).not.toContain('group')
  })

  it('★聊天里那几句照旧配不上组名(卡 MQ 那道门没松:带数的、中文整句的、一长串的都不算)', () => {
    const group = new RegExp(OPEN_QUOTA_PATTERNS.find(one => one.id === 'group')!.regex)
    for (const line of [
      '你上次说的那个周限额到底是多少来着',
      '你这周额度只剩 1% 了',
      '前 5 秒彻底甩开 99% 的纯软件聊天框项目',
      '我觉得这两个 models 都可以,你选一个吧',
      'Claude 4.5 models',
    ]) expect(group.test(line)).toBe(false)
  })

  it('★一条数归哪一组 = 页面上**它上面最近的那一条组名**(不是最近的,是上面的)', () => {
    const at = (y: number) => PAGE.find(one => one.id === 'pct' && one.y === y)!
    expect(openQuotaGroup(at(248), PAGE)).toBe('Gemini Models')
    expect(openQuotaGroup(at(312), PAGE)).toBe('Gemini Models')
    expect(openQuotaGroup(at(468), PAGE)).toBe('Claude and GPT models')
    expect(openQuotaGroup(at(532), PAGE)).toBe('Claude and GPT models')
    // 组名上面的那一行(页标题旁边)不归任何一组 —— 不拿下面的组名往上套。
    expect(openQuotaGroup({ id: 'pct', text: '1%', x: 1200, y: 120 }, PAGE)).toBeUndefined()
  })
})

describe('卡 AG 二、额度面板上照它页面原样列四行', () => {
  it('★四行两组,组名与行名都是原话,百分比照原话', () => {
    const trusted = trustOpenQuota(SAID, PAGE)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    const view = openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: trusted.numbers })
    expect(view.windows).toEqual([
      { group: 'Gemini Models', label: 'Weekly Limit Remaining', left_pct: 100 },
      { group: 'Gemini Models', label: 'Five Hour Limit Remaining', left_pct: 98 },
      { group: 'Claude and GPT models', label: 'Weekly Limit Remaining', left_pct: 100 },
      { group: 'Claude and GPT models', label: 'Five Hour Limit Remaining', left_pct: 100 },
    ])
    // 口径是**剩余**(页面上写着 Remaining),那一句照老规矩只说最紧的那一行。
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 98, line: '还剩约 98%' })
  })

  it('★两组里同名的那一行不再并成一条(卡 QG 当时并了,组名读不回来)', () => {
    const trusted = trustOpenQuota(SAID, PAGE)
    if (!trusted.ok) throw new Error('该采信')
    const view = openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: trusted.numbers })
    expect(view.windows).toHaveLength(4)
    expect(view.windows?.filter(one => one.label === 'Weekly Limit Remaining')).toHaveLength(2)
  })

  it('★出处里四条原话一条不落,而且组名 + 行名 + 数各自带引号(不拼成它没说过的一句话)', () => {
    const trusted = trustOpenQuota(SAID, PAGE)
    if (!trusted.ok) throw new Error('该采信')
    const view = openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: trusted.numbers })
    expect(view.source).toContain('「Gemini Models」「Five Hour Limit Remaining」「98%」')
    expect(view.source).toContain('「Claude and GPT models」「Weekly Limit Remaining」「100%」')
  })

  it('★重读(不叫模型):Gemini 那一组的周限额掉到 12%,Claude 那一组的周限额照旧 100% —— 两组不串行', () => {
    const trusted = trustOpenQuota(SAID, PAGE)
    if (!trusted.ok) throw new Error('该采信')
    const recipe = openQuotaRecipe(trusted.numbers)
    const later = PAGE.map(one => (one.id === 'pct' && one.y === 248 ? { ...one, text: '12%' } : one))
    const again = rereadOpenNumbers(recipe, later)
    expect(again).toBeDefined()
    const view = openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: again! })
    expect(view.windows).toEqual([
      { group: 'Gemini Models', label: 'Weekly Limit Remaining', left_pct: 12 },
      { group: 'Gemini Models', label: 'Five Hour Limit Remaining', left_pct: 98 },
      { group: 'Claude and GPT models', label: 'Weekly Limit Remaining', left_pct: 100 },
      { group: 'Claude and GPT models', label: 'Five Hour Limit Remaining', left_pct: 100 },
    ])
    expect(view).toMatchObject({ left_pct: 12, line: '只剩约 12%,快用完了' })
  })

  it('★整轮走通:那一页开着 + 点「读一下」→ 那一格四行两组', async () => {
    const fake = { prompts: [] as string[] }
    const r = createWindowQuotaReader({
      request: async (_req: HelperRequest) => ({
        ok: true,
        result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: PAGE.map(one => ({ ...one, window: 0 })) },
      }),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      judgeQuota: async (prompt) => {
        fake.prompts.push(prompt)
        return '{"kind":"numbers","quote":"100%","evidence":"Weekly Limit Remaining","measure":"left_pct","value":100,"items":["100%","98%","100%","100%"],"reason":"限额剩余"}'
      },
      now: () => NOW,
    })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(fake.prompts).toHaveLength(1)
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.windows?.map(one => `${one.group ?? ''}/${one.label}/${one.left_pct}`)).toEqual([
      'Gemini Models/Weekly Limit Remaining/100',
      'Gemini Models/Five Hour Limit Remaining/98',
      'Claude and GPT models/Weekly Limit Remaining/100',
      'Claude and GPT models/Five Hour Limit Remaining/100',
    ])
  })
})

/**
 * **通则(决策记录,2026-09-27 已拍板)**:页面上肉眼看得到的用量数字就必须读到;读不到时
 * 说清**卡在哪一步**(窗不在当前桌面 / 被藏 / 段数上限 / 规则没认出),不许笼统说「这页上没看见用量」。
 */
describe('卡 AG 三、读不到就说清卡在哪一步(不许笼统一句)', () => {
  it('★一条命中都没有(真机 09-27 10:3x:1 扇窗、261 段字、0 命中)→ 说「那一页多半没开着」,并报出读了几扇窗几段字', () => {
    const why = openQuotaMissWhy({ groups: [], windowCount: 1, textNodes: 261 })
    expect(why).not.toBe(OPEN_QUOTA_NOT_SEEN)
    expect(why).toContain('1 扇窗')
    expect(why).toContain('261 段字')
    expect(why).toContain('没开着')
  })

  it('★有数字、没有「这是用量页」的界面字 → 明说是**规则没认出**这一页;带数的那几段只报几段,原话一个字不抄(隐私)', () => {
    const why = openQuotaMissWhy({
      groups: [{ window: 0, matches: [{ id: 'pct', text: '前 5 秒彻底甩开 99% 的纯软件聊天框项目', x: 1200, y: 248 }] }],
      windowCount: 1,
      textNodes: 300,
    })
    expect(why).toContain('用量页')
    expect(why).toContain('1 段带数的字')
    // ★ 那一段很可能就是他对话里的一句话 —— 一个字都不许抄到额度面板上。
    expect(why).not.toContain('99')
    expect(why).not.toContain('聊天框')
    expect(why).not.toBe(OPEN_QUOTA_NOT_SEEN)
  })

  it('★认出是用量页、却一个数都没读到 → 说清是**数没读到**,不说「没看见用量」', () => {
    const why = openQuotaMissWhy({
      groups: [{ window: 0, matches: [{ id: 'page', text: 'Models & Usage', x: 560, y: 96 }] }],
      windowCount: 1,
      textNodes: 300,
    })
    expect(why).toContain('Models & Usage')
    expect(why).toContain('一个用量数字都没读到')
  })

  it('★命中顶到壳的段数上限 → 明说被挤掉了、要升级工作台 App(这正是卡 QG 读不回组名的那一步)', () => {
    const many = Array.from({ length: OPEN_SHELL_MAX_MATCHES }, (_, at) => ({ id: 'pct', text: `${at}%`, x: 1200, y: 100 + at * 20 }))
    const why = openQuotaMissWhy({ groups: [{ window: 0, matches: many }], windowCount: 1, textNodes: 600 })
    expect(why).toContain(`${OPEN_SHELL_MAX_MATCHES} 段`)
    expect(why).toContain('工作台 App')
  })

  it('★那扇窗在别的桌面上 → 那一句后面补上这一步(与七家同一句话,不在 missWhy 里重复说)', async () => {
    const r = createWindowQuotaReader({
      request: async (_req: HelperRequest) => ({
        ok: true,
        result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: [], text_nodes: 261, window_count: 1, offspace_windows: 2 },
      }),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      judgeQuota: async () => '{"kind":"none","reason":"没看见"}',
      now: () => NOW,
    })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.line).toContain('261 段字')
    expect(view.line).toContain('桌面')
  })

  it('★模型判 none → 说是**模型判的**,并带上它看到的那几段(而不是让人以为页面上没有)', () => {
    const why = openQuotaMissWhy({
      groups: [{ window: 0, matches: PAGE }],
      windowCount: 1,
      textNodes: 300,
      modelSaidNone: true,
    })
    expect(why).toContain('模型')
    expect(why).toContain('Models & Usage')
  })

  it('★短说法说的是同一步(派活确认点的括号、「读一下」按完那句话只有一行,摆不下整段)', () => {
    const one = (input: Parameters<typeof openQuotaMissShort>[0]) => openQuotaMissShort(input)
    expect(one({ groups: [], windowCount: 1, textNodes: 261 })).toBe('用量那一页没开着')
    expect(one({ groups: [{ window: 0, matches: [{ id: 'pct', text: '1%', x: 0, y: 0 }] }] })).toBe('规则没认出这是用量页')
    expect(one({ groups: [{ window: 0, matches: [{ id: 'page', text: 'Models & Usage', x: 0, y: 0 }] }] })).toBe('规则没认出那几个数')
    expect(one({ groups: [{ window: 0, matches: PAGE }], modelSaidNone: true })).toBe('模型判这页上没有它的用量')
    // 短说法也短:一行放得下(派活确认点括号里那一格)。
    for (const short of ['用量那一页没开着', '规则没认出这是用量页', '规则没认出那几个数']) expect(short.length).toBeLessThan(16)
  })

  it('★整轮走通:那一页没开着时,那一格那句话说得出卡在哪一步(真机 09-27 10:3x 的样子)', async () => {
    const r = createWindowQuotaReader({
      request: async (_req: HelperRequest) => ({
        ok: true,
        result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: [], text_nodes: 261, window_count: 1 },
      }),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      judgeQuota: async () => '{"kind":"none","reason":"没看见"}',
      now: () => NOW,
    })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.why ?? view.line).not.toBe(OPEN_QUOTA_NOT_SEEN)
    expect(view.line).toContain('261 段字')
  })
})
