/**
 * **开集的额度读法**(2026-09-26,卡 QO)。维护者原话:「要有机制」——
 * 登记表里新接上的任何一家(今天 Grok Bot、Antigravity),额度那一格不再永远写
 * 「没接上:还没找到这家的额度来源」,而是有一条不写死的路把它的用量读回来。
 *
 * 钉住的几条:
 * - 没有专门读法、**又有本机窗口**的那一家 → 那一格给「读一下」(桌面端才有);
 *   连窗口都没有的(只走接口那几家)照旧是老那句 —— 给一颗点不出结果的按钮是骗人;
 * - 点了之后:每一扇窗跑一次 `read_texts`(通用正则,只认用量那类字),命中**按窗分组**交给模型;
 * - **判词要带原话引用,而且原话与旁证都得真在这一扇窗的命中里**;
 * - ★ **聊天窗里的「周额度只剩 1%」没旁证一律不采信** —— 而且压根不花那一次模型钱;
 * - 三档都说得清:有数 / 这页上没看见用量 / 今天判额度的模型额度用完了,明天再读;
 * - 认出来之后按 10 分钟节流自动重读:**只带上次命中的那几条正则、不再叫模型**;判词变了才再叫一次;
 * - 窗口不在了 / 这一轮没读成:上次那个数照给(几点读到的由 `quotaFor` 一处写上,卡 QS 的口径);
 * - 要先授权辅助功能 / 要新版壳:**不许拿旧数顶上来**(`no_stale`,同 Manus / Muse 那条纪律);
 * - 手机端不给按钮(`desk_only`)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { OpenQuotaFamily, QuotaAdapterContext } from '../src/server/agentQuota.ts'
import type { OpenQuotaVerdict } from '../src/server/openQuota.ts'
import {
  createWindowQuotaReader, forgetQuotaMemory, openQuotaFamilies, openQuotaView, quotaFor,
} from '../src/server/agentQuota.ts'
import {
  OPEN_EVIDENCE_IDS, OPEN_EVIDENCE_MAX_CHARS, OPEN_QUOTA_PATTERNS, openQuotaRecipe, openQuotaSkeleton,
  openQuotaWorth, parseOpenQuotaVerdict, rereadOpenNumbers, trustOpenQuota,
} from '../src/server/openQuota.ts'

const NOW = new Date('2026-09-26T10:00:00.000Z')
const GROK: OpenQuotaFamily = { id: 'grokbot', title: 'Grok Bot', bundleId: 'com.anysphere.sand' }

/**
 * 这几条用例一直假设的那个样子:**那家在跑、又不在前台**(只是没停在用量那一页)。
 * 2026-10-03(卡 QZ)起读之前会先问壳「谁在跑 / 谁在前台」——「没在跑」会走后台拉起那一支,
 * 那是另一条路(它自己的用例在 `quota-reads-itself.test.ts`),这里照原样把它们报成在跑。
 */
const RUNNING_IN_TESTS: readonly string[] = [GROK.bundleId, 'com.google.antigravity']

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, now: NOW, ...patch }
}

beforeEach(() => { forgetQuotaMemory() })

/** 一扇窗的假回包(壳 `read_texts` 那一份:命中带 `window`,每扇窗的宽高在 `windows` 里)。 */
function windows(...frames: readonly { id: string, text: string, window?: number }[][]) {
  return {
    ok: true,
    result: {
      windows: frames.map((_, index) => ({ index, w: 1200, h: 800 })),
      matches: frames.flatMap((frame, index) => frame.map(one => ({ ...one, x: 300, y: 200, window: one.window ?? index }))),
    },
  }
}

interface Fake {
  /** 壳每次被问到的那一份(看带了哪几条正则)。 */
  reads: { bundleId: string, ids: string[] }[]
  /** 每问一次模型记一段(看叫了几次、话里写了什么)。 */
  prompts: string[]
  /** 记下的花费(元)。 */
  spent: number[]
}

function reader(input: {
  answer: (read: number) => Record<string, unknown>
  say?: (prompt: string) => string
  gate?: (estimate: number) => { ok: true } | { ok: false, why: string }
  helper?: { connected: boolean, authorized: boolean, readTexts: boolean }
}) {
  const fake: Fake = { reads: [], prompts: [], spent: [] }
  let clock = NOW.getTime()
  let changed = 0
  const r = createWindowQuotaReader({
    request: async (req: HelperRequest) => {
      const one = req as { op: string, bundle_id: string, patterns?: readonly { id: string }[] }
      /*
       * 2026-10-03(卡 QZ):读之前先问一句壳「谁在跑 / 谁在前台」(`running_apps`,不碰辅助功能)——
       * 这一下**不算一次读**,所以不进 `fake.reads`(不然「一轮读了几次」那几条断言数的是两样东西)。
       * 这一家在跑、又不在前台:就是这几条用例一直假设的那个样子(所以回空表以外还要回它一格)。
       */
      if (one.op === 'running_apps') {
        return { ok: true, result: { apps: RUNNING_IN_TESTS.map(bundle => ({ bundle_id: bundle, active: false, hidden: false })) } }
      }
      fake.reads.push({ bundleId: one.bundle_id, ids: (one.patterns ?? []).map(p => p.id) })
      return input.answer(fake.reads.filter(x => x.bundleId === one.bundle_id).length - 1)
    },
    helper: () => input.helper ?? { connected: true, authorized: true, readTexts: true },
    judgeQuota: async (prompt) => {
      fake.prompts.push(prompt)
      return input.say?.(prompt) ?? '{"kind":"none","reason":"看不出来"}'
    },
    judgeBudget: {
      gate: async estimate => input.gate?.(estimate) ?? { ok: true },
      spend: async (cny) => { fake.spent.push(cny) },
    },
    now: () => new Date(clock),
    onChanged: () => { changed += 1 },
  })
  return { r, fake, changed: () => changed, tick: (ms: number) => { clock += ms } }
}

/** 那一家此刻的额度那一格(`/state.agent_quota` 里的同一份)。 */
function cell(r: ReturnType<typeof reader>['r'], family = GROK) {
  return quotaFor(family.id, ctx({ open: r.openReadings([family]) }))
}

const USAGE_PAGE = [{ id: 'page', text: 'Usage' }, { id: 'used', text: '已使用 38%' }]
const SAYS_38 = '{"kind":"numbers","quote":"已使用 38%","evidence":"Usage","measure":"used_pct","value":38,"reason":"用量页上写着已使用 38%"}'

describe('哪几家走开集那条路', () => {
  it('★有本机窗口、又没有专门读法的那几家才走;有专门读法的、没有窗口的都不动', () => {
    const targets = [
      { id: 'claude', title: 'Claude', bundle_id: 'com.anthropic.claudefordesktop' },
      { id: 'muse', title: 'Muse', bundle_id: 'com.meta.endo' },
      { id: 'doubao', title: '豆包办公', bundle_id: 'com.bytedance.doubao' },
      { id: 'gpt', title: 'GPT' },
      { id: 'grokbot', title: 'Grok Bot', bundle_id: 'com.anysphere.sand' },
      { id: 'antigravity', title: 'Antigravity', bundle_id: 'com.google.antigravity' },
    ]
    expect(openQuotaFamilies(targets).map(one => one.id)).toEqual(['grokbot', 'antigravity'])
  })

  it('★开集那条路整个缺席(只走接口、没有窗口的一家)→ 照旧是老那句,不给一颗点不出结果的按钮', () => {
    expect(quotaFor('perplexity', ctx())).toEqual({
      id: 'perplexity', title: 'perplexity', state: 'unconnected', line: '没接上:还没找到这家的额度来源', why: '还没找到这家的额度来源',
    })
  })

  /**
   * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条)。
   * 原来这一格挂一颗那样的键、「打开它显示用量/额度的那一页」写在键旁边,还得靠 `desk_only`
   * 把手机那一侧挡掉;键没了,那句人话进 `line` —— 两端读的于是是同一句,不用再分桌面 / 手机。
   */
  it('★还没读过的那一家:那一格说清先打开哪一页,不摆键(2026-09-30 维护者拍板全删)', () => {
    const { r } = reader({ answer: () => windows([]) })
    const view = cell(r)
    expect(view).toMatchObject({
      id: 'grokbot',
      state: 'unconnected',
      line: '没接上:还没读过它窗口上的用量 —— 打开它显示用量/额度的那一页,切走时工作台会自己读一次',
    })
    expect(view.fix).toBeUndefined()
  })
})

describe('三档:有数 / 这页上没看见用量 / 今天判额度的模型钱用完了', () => {
  it('★有数:命中交给模型,判词带原话 → 「还剩约 62%」,出处写几点在谁的窗口上读到的、原话是什么', async () => {
    const { r, fake } = reader({ answer: () => windows(USAGE_PAGE), say: () => SAYS_38 })
    await r.refreshOpen([GROK], { full: true })
    const view = cell(r)
    expect(view).toMatchObject({ id: 'grokbot', title: 'Grok Bot', state: 'numbers', level: 'ok', left_pct: 62, line: '还剩约 62%' })
    expect(view.source).toMatch(/^\d\d:\d\d 在 Grok Bot 的窗口上读到的:「已使用 38%」$/)
    expect(view.read_at).toBe(NOW.toISOString())
    // 问模型那一段里:有原话、有「对话里说的话不算」那条规矩,**没有**窗口里别的字(压根没读出来)。
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]).toContain('已使用 38%')
    expect(fake.prompts[0]).toContain('对话里说的话不算')
    // 记账:花了一笔(共用登记表那一份每日上限)。
    expect(fake.spent).toHaveLength(1)
    expect(fake.spent[0]).toBeGreaterThan(0)
  })

  it('★读到窗口了、这一页上没有用量 → 说清卡在哪一步(卡 AG 改:不再笼统一句「这页上没看见用量」),几点读过写在里面;不摆键(2026-09-30 维护者拍板全删)', async () => {
    const { r, fake } = reader({ answer: () => windows([{ id: 'page', text: 'Usage' }]) })
    await r.refreshOpen([GROK], { full: true })
    const view = cell(r)
    expect(view).toMatchObject({ state: 'unconnected' })
    expect(view.fix).toBeUndefined()
    // ★ 卡 AG(2026-09-27,维护者:「为什么我肉眼都看到额度信息了,但是还说读不到」):
    // 这一格要说得出**是哪一步没过** —— 这一例是「认出是用量页了,可一个数都没读到」。
    expect(view.line).toMatch(/^没接上:\d\d:\d\d 读过 Grok Bot 的窗口,读了 /)
    expect(view.line).toContain('认出这是用量页(「Usage」)')
    expect(view.line).toContain('一个用量数字都没读到')
    // 只有界面字、没有数字:不值得花那一次模型钱。
    expect(fake.prompts).toHaveLength(0)
  })

  it('★今天判额度的模型额度用完了 → 照实说「明天再读」,不偷偷不显示、也不摆一个数', async () => {
    const { r, fake } = reader({
      answer: () => windows(USAGE_PAGE),
      gate: () => ({ ok: false, why: '今天判是不是 Agent 花的钱到上限了,明天再判' }),
    })
    await r.refreshOpen([GROK], { full: true })
    expect(cell(r)).toMatchObject({
      state: 'unconnected',
      line: '没接上:今天判额度的模型额度用完了,明天再读',
      short: '没接上:今天判额度的模型额度用完了,明天再读',
    })
    // 闸门没放行 = 一次都没问、一分钱没记。
    expect(fake.prompts).toHaveLength(0)
    expect(fake.spent).toHaveLength(0)
  })

  it('模型服务没接上 → 说「判不了这一页上的用量」,不瞎猜', async () => {
    let clock = NOW.getTime()
    const r = createWindowQuotaReader({
      request: async () => windows(USAGE_PAGE),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      now: () => new Date(clock),
    })
    clock += 0
    await r.refreshOpen([GROK], { full: true })
    expect(quotaFor(GROK.id, ctx({ open: r.openReadings([GROK]) })).why).toContain('模型服务没接上,判不了这一页上的用量')
  })
})

describe('★聊天窗里的那个百分比一律不采信(假阳性比读不到坏得多)', () => {
  it('★聊天窗只有百分比、没有旁证 → 压根不问模型,那一格说没看见', async () => {
    // 卡 MQ 实测过的那一幕:他跟这家聊的正是额度,聊天记录里明晃晃写着「周额度只剩 1%」。
    const { r, fake } = reader({ answer: () => windows([{ id: 'pct', text: '你这周额度只剩 1% 了' }]) })
    await r.refreshOpen([GROK], { full: true })
    expect(fake.prompts).toHaveLength(0)
    const view = cell(r)
    expect(view.state).toBe('unconnected')
    // 卡 AG:说清卡在哪一步(「没有一句『这是用量页』的界面字」),但**他那句话一个字都不往外抄**。
    expect(view.line).toContain('没有一句「这是用量页」的界面字')
    expect(view.line).toContain('1 段带数的字')
    expect(view.line).not.toContain('1%')
    expect(view.line).not.toContain('周额度')
  })

  it('★同窗既有数字又有界面字才值得问;只有一样的一律不问', () => {
    expect(openQuotaWorth([{ id: 'pct', text: '只剩 1%', x: 0, y: 0 }])).toBe(false)
    expect(openQuotaWorth([{ id: 'page', text: 'Usage', x: 0, y: 0 }])).toBe(false)
    expect(openQuotaWorth([{ id: 'page', text: 'Usage', x: 0, y: 0 }, { id: 'pct', text: '只剩 1%', x: 0, y: 0 }])).toBe(true)
    // 旁证还得**短**:界面标签都短,聊天里那一整句不短(这是最便宜的那一道门)。
    const long = 'x'.repeat(OPEN_EVIDENCE_MAX_CHARS + 1)
    expect(openQuotaWorth([{ id: 'limit', text: long, x: 0, y: 0 }, { id: 'pct', text: '只剩 1%', x: 0, y: 0 }])).toBe(false)
  })

  it('★判词里的原话 / 旁证对不回命中里 → 不采信(模型自己编一句话是不算的)', () => {
    const matches = [{ id: 'page', text: 'Usage', x: 0, y: 0 }, { id: 'used', text: '已使用 38%', x: 0, y: 0 }]
    const good = parseOpenQuotaVerdict(SAYS_38) as OpenQuotaVerdict
    expect(good).toMatchObject({ kind: 'numbers', quote: '已使用 38%', evidence: 'Usage', measure: 'used_pct', value: 38 })
    expect(trustOpenQuota(good, matches)).toMatchObject({ ok: true })
    // 旁证是编的。
    expect(trustOpenQuota({ ...good, evidence: '这是用量页' }, matches)).toMatchObject({ ok: false })
    // 原话是编的(把两段拼起来也不算)。
    expect(trustOpenQuota({ ...good, quote: '已使用 38% Usage' }, matches)).toMatchObject({ ok: false })
    // 原话在,但那个数被模型改了(38 → 83):挡住。
    expect(trustOpenQuota({ ...good, value: 83 }, matches)).toMatchObject({ ok: false })
    // 没说是「已用」还是「还剩」:挡住(不然 38% 可能是剩 38%,也可能是剩 62%)。
    expect(trustOpenQuota({ kind: 'numbers', quote: '已使用 38%', evidence: 'Usage', reason: '' }, matches)).toMatchObject({ ok: false })
    // 旁证与原话是同一段:不算(那等于自己给自己作证)。
    expect(trustOpenQuota({ kind: 'numbers', quote: 'Usage', evidence: 'Usage', measure: 'left_pct', reason: '' }, matches)).toMatchObject({ ok: false })
  })

  it('「不限」也要原话:判词说不限、原话里没有「不限 / 无限制」→ 不采信', () => {
    const matches = [{ id: 'page', text: 'Billing', x: 0, y: 0 }, { id: 'plan', text: 'Unlimited', x: 0, y: 0 }]
    expect(trustOpenQuota({ kind: 'unlimited', quote: 'Unlimited', evidence: 'Billing', reason: '' }, matches)).toMatchObject({ ok: true })
    expect(trustOpenQuota({ kind: 'unlimited', quote: 'Billing', evidence: 'Unlimited', reason: '' }, matches)).toMatchObject({ ok: false })
  })

  it('★几扇窗一起回:聊天窗在前、用量页在后,认的是用量页那一扇(按窗分组,不混一个篮子)', async () => {
    const { r, fake } = reader({
      answer: () => windows(
        [{ id: 'pct', text: '你这周额度只剩 1% 了' }],
        USAGE_PAGE,
      ),
      say: () => SAYS_38,
    })
    await r.refreshOpen([GROK], { full: true })
    // 只问了用量页那一组(聊天窗那一组没旁证,压根不问)—— 他那句话一个字都没进过问模型那一段。
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]).not.toContain('你这周额度只剩 1% 了')
    expect(cell(r)).toMatchObject({ state: 'numbers', left_pct: 62 })
    expect(r.openReadings([GROK]).grokbot?.found?.window).toBe(1)
  })
})

describe('★认出来之后的自动重读:只用上次命中的那几条正则,不再叫模型', () => {
  it('★重读只带上次那几条正则;数变了照算,一次模型都不叫', async () => {
    let page = USAGE_PAGE
    const { r, fake } = reader({ answer: () => windows(page), say: () => SAYS_38 })
    await r.refreshOpen([GROK], { full: true })
    expect(fake.reads[0]?.ids).toEqual(OPEN_QUOTA_PATTERNS.map(one => one.id))
    expect(fake.prompts).toHaveLength(1)
    // 一刻钟后他又用了一些:38% → 41%。
    page = [{ id: 'page', text: 'Usage' }, { id: 'used', text: '已使用 41%' }]
    await r.refreshOpen([GROK])
    // ★只带了上次命中的那两条(外加重置那一条 —— 读到了就一起写进出处),**没再叫模型**。
    expect(fake.reads[1]?.ids.sort()).toEqual(['page', 'reset', 'used'])
    expect(fake.prompts).toHaveLength(1)
    expect(cell(r)).toMatchObject({ state: 'numbers', left_pct: 59, line: '还剩约 59%' })
  })

  it('★判词变了(那一句换了个说法)→ 先保留上次那个数,下一轮读全套、再叫一次模型', async () => {
    let page = USAGE_PAGE
    const { r, fake } = reader({
      answer: () => windows(page),
      say: prompt => (prompt.includes('已用完使用额度')
        ? '{"kind":"numbers","quote":"已用完使用额度 100%","evidence":"Usage","measure":"used_pct","value":100,"reason":"用完了"}'
        : SAYS_38),
    })
    await r.refreshOpen([GROK], { full: true })
    expect(cell(r)).toMatchObject({ left_pct: 62 })
    // 那一页换了说法:骨架变了,按上次的方子算不出来。
    page = [{ id: 'page', text: 'Usage' }, { id: 'used', text: '已用完使用额度 100%' }]
    await r.refreshOpen([GROK])
    expect(fake.prompts).toHaveLength(1)
    // 这一轮先摆上次那个数(带「截至 HH:MM」—— 卡 QS:读到过的数不因为一会儿没刷新就翻成「没接上」;卡 QA 统一成「截至」)。
    const kept = quotaFor(GROK.id, ctx({ open: r.openReadings([GROK]), now: new Date(NOW.getTime() + 40 * 60_000) }))
    expect(kept).toMatchObject({ state: 'numbers', left_pct: 62 })
    expect(kept.line).toContain('截至')
    expect(kept.line).not.toContain('没接上')
    // 下一轮读全套、再判一次 → 用完了。
    await r.refreshOpen([GROK])
    expect(fake.reads[2]?.ids).toEqual(OPEN_QUOTA_PATTERNS.map(one => one.id))
    expect(fake.prompts).toHaveLength(2)
    expect(cell(r)).toMatchObject({ state: 'numbers', level: 'empty', line: '用量用完了' })
  })

  it('骨架:只有数变了算同一句,换了说法就不算', () => {
    expect(openQuotaSkeleton('已使用 38%')).toBe(openQuotaSkeleton('已使用 41%'))
    expect(openQuotaSkeleton('剩 1,234 积分')).toBe(openQuotaSkeleton('剩 980 积分'))
    expect(openQuotaSkeleton('已使用 38%')).not.toBe(openQuotaSkeleton('已用完使用额度'))
  })

  it('重读要旁证还在:那一页切走了(只剩数字)就不算 —— 不拿别处的一个数续上', () => {
    const recipe = { kind: 'numbers' as const, measure: 'used_pct' as const, quote: { id: 'used', skeleton: '已使用 #%' }, evidence: { id: 'page', skeleton: 'Usage' } }
    expect(rereadOpenNumbers(recipe, [{ id: 'page', text: 'Usage', x: 0, y: 0 }, { id: 'used', text: '已使用 41%', x: 0, y: 0 }])).toMatchObject({ value: 41 })
    expect(rereadOpenNumbers(recipe, [{ id: 'used', text: '已使用 41%', x: 0, y: 0 }])).toBeUndefined()
  })

  it('★节流:缺省 10 分钟内只读一轮', async () => {
    const { r, fake, tick } = reader({ answer: () => windows([]) })
    r.pumpOpen([GROK])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.reads).toHaveLength(1)
    r.pumpOpen([GROK])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.reads).toHaveLength(1)
    tick(10 * 60_000 + 1)
    r.pumpOpen([GROK])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.reads).toHaveLength(2)
  })
})

describe('读不成时说清差哪一步(同 Manus / Muse 那一套)', () => {
  // 2026-09-30 维护者拍板全删:「打开 Grok Bot」与「带我过去」是同一种键,一并删了 ——
  // 原因照说,该他自己去打开哪一页那句话接在后面。
  it('它没开着 / 没连上壳:说清原因,该他去开哪一页写成一句话,不摆键(2026-09-30 维护者拍板全删)', async () => {
    const closed = reader({ answer: () => ({ ok: false, error: '找不到窗口:com.anysphere.sand 没在运行' }) })
    await closed.r.refreshOpen([GROK], { full: true })
    const closedView = cell(closed.r)
    expect(closedView).toMatchObject({ short: '没接上:Grok Bot 没开着' })
    expect(closedView.fix).toBeUndefined()
    expect(closedView.line).toContain('打开它显示用量/额度的那一页')
    const off = reader({ answer: () => windows([]), helper: { connected: false, authorized: false, readTexts: false } })
    await off.r.refreshOpen([GROK], { full: true })
    expect(cell(off.r)).toMatchObject({ short: '没接上:工作台 App 没连上' })
    expect(off.fake.reads).toHaveLength(0)
  })

  it('★没授权辅助功能 / 老壳:不许拿上次那个数顶上来(他得先去做那一步)', async () => {
    let helper = { connected: true, authorized: true, readTexts: true }
    const { r } = reader({ answer: () => windows(USAGE_PAGE), say: () => SAYS_38, helper: { get connected() { return helper.connected }, get authorized() { return helper.authorized }, get readTexts() { return helper.readTexts } } as never })
    await r.refreshOpen([GROK], { full: true })
    expect(cell(r)).toMatchObject({ state: 'numbers', left_pct: 62 })
    helper = { connected: true, authorized: false, readTexts: true }
    await r.refreshOpen([GROK], { full: true })
    const view = cell(r)
    expect(view).toMatchObject({ state: 'unconnected', short: '没接上:要先授权辅助功能', fix: { kind: 'grant_ax' }, no_stale: true })
    expect(view.line).not.toContain('62')
  })

  it('★窗口不在了(这一轮什么都没命中):上次那个数照给,带上「截至 HH:MM」', async () => {
    let page = USAGE_PAGE
    const { r } = reader({ answer: () => windows(page), say: () => SAYS_38 })
    await r.refreshOpen([GROK], { full: true })
    page = []
    await r.refreshOpen([GROK], { full: true })
    const view = quotaFor(GROK.id, ctx({ open: r.openReadings([GROK]), now: new Date(NOW.getTime() + 40 * 60_000) }))
    expect(view).toMatchObject({ state: 'numbers', left_pct: 62 })
    expect(view.line).toMatch(/^还剩约 62% · 截至 \d\d:\d\d$/)
    // ★ 2026-09-30 维护者拍板全删:原来这里把「这一轮没读成」那一格的键搬过来挂在有数的这一行上,
    // 那颗键只有「带我过去」一种 —— 键删了,有数的行上只摆那个数。
    expect(view.fix).toBeUndefined()
  })
})

describe('通用正则:只认用量那类字,而且在 JS 里跑得起来', () => {
  it('★不超过壳一次收得下的条数(卡 AG:壳抬到 12 条之后这里是 9 条),没有一条写 `(?i)`(JS 不认内联标志,会悄悄失效)', () => {
    expect(OPEN_QUOTA_PATTERNS).toHaveLength(9)
    expect(OPEN_QUOTA_PATTERNS.length).toBeLessThanOrEqual(12)
    for (const one of OPEN_QUOTA_PATTERNS) {
      expect(one.regex).not.toContain('(?i)')
      expect(() => new RegExp(one.regex)).not.toThrow()
    }
  })

  it('★数字类带上下文(光一个「used」判不出什么);旁证类**整格文字**才算', () => {
    const rx = (id: string): RegExp => new RegExp(OPEN_QUOTA_PATTERNS.find(one => one.id === id)?.regex ?? '')
    // 数字类:命中的那一段里要带着数与那几个字。
    expect(rx('pct').exec('已使用 38%')?.[0]).toContain('38%')
    expect(rx('used').exec('Used 12 of 50')?.[0]).toContain('Used')
    expect(rx('credits').exec('剩 1,234 积分')?.[0]).toContain('积分')
    expect(rx('times').exec('还剩 20 次')?.[0]).toContain('20 次')
    // 旁证类:整格文字(界面标签)才算,聊天里的一句话配不上。
    expect(rx('page').test('Usage')).toBe(true)
    expect(rx('page').test('我看了一下 Usage 那一页')).toBe(false)
    expect(rx('plan').test('Free plan')).toBe(true)
    expect(rx('plan').test('I am on the free plan right now')).toBe(false)
    expect(rx('reset').test('Resets on Oct 1')).toBe(true)
    expect(rx('reset').test('你说过 resets on Oct 1 对吧,我记着呢')).toBe(false)
    expect(rx('limit').test('周限额')).toBe(true)
    expect(rx('limit').test('你上次说的那个周限额到底是多少来着,我忘了')).toBe(false)
  })

  /**
   * ★ **2026-09-26 在维护者那台机器上真读到的那一段**(卡 QO,壳的只读探针,生产 8791 上两家都开着):
   *
   * | 家 | 窗口 | 文字节点 | 命中 |
   * |---|---|---|---|
   * | Grok Bot(`com.anysphere.sand`)| 1 扇 | 52 | **0 条** |
   * | Antigravity(`com.google.antigravity`)| 1 扇 | 240 | **1 条**:`pct` =「前 5 秒彻底甩开 99% 的纯软件聊天框项目」|
   *
   * Antigravity 那一条正是这张卡最怕的那种东西:**他对话里的一句话**,里面有个百分号。
   * 见着百分号就当额度,那一格就会写「还剩约 1%」或者「已用 99%」—— 一个凭空捏出来的数(D13)。
   * 这一例把那段真话钉在这里:它**一次模型都不该叫**,那一格该说「这页上没看见用量」。
   */
  it('★真机上 Antigravity 窗口里唯一的命中是他对话里的一句话 → 不叫模型、不给数', async () => {
    const real = '前 5 秒彻底甩开 99% 的纯软件聊天框项目'
    const { r, fake } = reader({ answer: () => windows([{ id: 'pct', text: real }]) })
    await r.refreshOpen([{ id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }], { full: true })
    expect(fake.prompts).toHaveLength(0)
    const view = quotaFor('antigravity', ctx({ open: r.openReadings([{ id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }]) }))
    expect(view.state).toBe('unconnected')
    // 卡 AG:说清卡在哪一步,而**他那句话一个字都不抄**(这正是这一例最要紧的一条)。
    expect(view.line).toContain('没有一句「这是用量页」的界面字')
    expect(view.line).not.toContain('99')
    expect(view.line).not.toContain('聊天框')
    expect(view.left_pct).toBeUndefined()
  })

  it('★一段用量页的字也**不会**把聊天里那一句认成数字类的旁证', () => {
    // 「你这周额度只剩 1% 了」:pct 会命中(它就是要命中,不然读不到数),但它配不上任何一条旁证。
    const evidence = OPEN_QUOTA_PATTERNS.filter(one => ['page', 'plan', 'limit', 'reset'].includes(one.id))
    for (const one of evidence) expect(new RegExp(one.regex).test('你这周额度只剩 1% 了')).toBe(false)
  })
})

describe('「剩多少个」那一种(积分 / 次)', () => {
  it('剩 1,234 积分:数照原话写,单位照判词;0 = 用完了', () => {
    const matches = [{ id: 'page', text: 'Credits', x: 0, y: 0 }, { id: 'credits', text: '剩 1,234 积分', x: 0, y: 0 }]
    const trusted = trustOpenQuota({ kind: 'numbers', quote: '剩 1,234 积分', evidence: 'Credits', measure: 'left_amount', value: 1234, unit: '积分', reason: '' }, matches)
    expect(trusted).toMatchObject({ ok: true, numbers: { text: '1,234', value: 1234, unit: '积分' } })
  })

  it('★整轮走通:「Credits」+「剩 1,234 积分」→ 那一格写「剩 1,234 积分」', async () => {
    const { r } = reader({
      answer: () => windows([{ id: 'page', text: 'Credits' }, { id: 'credits', text: '剩 1,234 积分' }]),
      say: () => '{"kind":"numbers","quote":"剩 1,234 积分","evidence":"Credits","measure":"left_amount","value":1234,"unit":"积分","reason":"额度页上写着剩 1,234 积分"}',
    })
    await r.refreshOpen([GROK], { full: true })
    expect(cell(r)).toMatchObject({ state: 'numbers', level: 'ok', line: '剩 1,234 积分', left: { text: '1,234', unit: '积分', amount: 1234 } })
  })
})

/**
 * **两家额度读错**(2026-09-26 晚,卡 QG)。维护者 22:15 两张截图:
 *
 * 1. **Grok Bot**(`com.anysphere.sand`,Cursor 出的)的 Usage & Billing 页上写着「Weekly Usage」
 *    「Resets in 7 days」「5%」—— 那是**已用 5%**。工作台那一行画成了橙色短条「5%」,
 *    意思成了**只剩 5%**。根因:那一格的原话只有「5%」三个字符,已用还是剩余全靠模型猜,它猜反了。
 *    **改法:口径不问模型,照同一扇窗上的原话数出来**(Usage / used / 已用 → 已用;
 *    Remaining / 剩余 → 剩余;两样都没有 → 不采信,不猜)。
 * 2. **Antigravity**(`com.google.antigravity`)的「Models & Usage」页上四条都写着
 *    「Weekly Limit Remaining … 100%」「Five Hour Limit Remaining … 98%」,维护者说「明明都有了」,
 *    工作台读不到。根因:**八条通用正则一条旁证都没命中** —— `page` 要整格正好是「Usage」
 *    (「Models & Usage」不算),`limit` 后面只留 6 个字(「Weekly Limit Remaining」不算)。
 *    没有旁证 → `openQuotaWorth` 是 false → 一次模型都不叫 → 那一格永远「这页上没看见用量」。
 *
 * 真机原话(22:4x 用只读探针 `probe-send-text.sh read-texts` 读回来的,Grok Bot 那一扇窗整窗只有 9 段字):
 * 「Usage & Billing」「Usage」「Weekly Usage」「Resets in 7 days」「5%」「On-demand monthly limit」
 * 「Billed through Cursor」「Manage Plan」「Manage on-demand billing on Cursor」。
 */
describe('卡 QG:已用还是剩余,照同窗原话数,不问模型', () => {
  /** 真机 Grok Bot 那一扇窗上与额度有关的那几段(x / y 是探针读回来的真坐标)。 */
  const GROK_REAL = [
    { id: 'page', text: 'Usage & Billing', x: 609, y: 156 },
    { id: 'page', text: 'Usage', x: 609, y: 206 },
    { id: 'page', text: 'Weekly Usage', x: 615, y: 243 },
    { id: 'reset', text: 'Resets in 7 days', x: 615, y: 280 },
    { id: 'pct', text: '5%', x: 1205, y: 280 },
    { id: 'limit', text: 'On-demand monthly limit', x: 615, y: 320 },
  ]

  it('★真机 Grok Bot:同窗写的是「Weekly Usage」→「5%」是已用 → 还剩 95%(不是只剩 5%)', () => {
    const said: OpenQuotaVerdict = { kind: 'numbers', quote: '5%', evidence: 'Usage', measure: 'left_pct', value: 5, reason: '' }
    const trusted = trustOpenQuota(said, GROK_REAL)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    // ★模型说的是 left_pct(只剩 5%),照原话数出来的是「已用」—— 以原话为准。
    expect(trusted.numbers.measure).toBe('used_pct')
    const view = openQuotaView({ id: 'grokbot', title: 'Grok Bot', at: NOW.toISOString(), numbers: trusted.numbers })
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 95, line: '还剩约 95%' })
  })

  it('★整轮走通(真机那一扇窗的九段字):模型答 left_pct,那一格照样写「还剩约 95%」', async () => {
    const { r, fake } = reader({
      answer: () => ({ ok: true, result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: GROK_REAL.map(one => ({ ...one, window: 0 })) } }),
      // 模型这次照样把「5%」说成 left_pct(22:11 生产上就是这么读错的)。
      say: () => '{"kind":"numbers","quote":"5%","evidence":"Usage","measure":"left_pct","value":5,"reason":"用量页上写着 5%"}',
    })
    await r.refreshOpen([GROK], { full: true })
    expect(fake.prompts).toHaveLength(1)
    const view = cell(r)
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 95, line: '还剩约 95%' })
    expect(view.line).not.toContain('快用完了')
  })

  it('★同窗写的是 Remaining → 同一个「5%」就是只剩 5%(口径是数出来的,不是写死的)', () => {
    const matches = [
      { id: 'limit', text: 'Weekly Limit Remaining', x: 615, y: 243 },
      { id: 'pct', text: '5%', x: 1205, y: 243 },
    ]
    const trusted = trustOpenQuota({ kind: 'numbers', quote: '5%', evidence: 'Weekly Limit Remaining', measure: 'used_pct', value: 5, reason: '' }, matches)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    expect(trusted.numbers.measure).toBe('left_pct')
    expect(openQuotaView({ id: 'x', title: 'X', at: NOW.toISOString(), numbers: trusted.numbers }))
      .toMatchObject({ level: 'low', left_pct: 5, line: '只剩约 5%,快用完了' })
  })

  it('★同窗一个「已用 / 剩余」的字都没有 → 不采信(宁可读不到,也不猜一个口径)', () => {
    const matches = [
      { id: 'page', text: '订阅', x: 600, y: 200 },
      { id: 'pct', text: '5%', x: 1200, y: 200 },
    ]
    expect(trustOpenQuota({ kind: 'numbers', quote: '5%', evidence: '订阅', measure: 'left_pct', value: 5, reason: '' }, matches))
      .toMatchObject({ ok: false })
  })

  it('★「剩多少个」那一种也照原话:同窗说的是「已用」→ 不采信(没有总数,算不出还剩多少)', () => {
    const matches = [
      { id: 'page', text: 'Credits', x: 600, y: 200 },
      { id: 'used', text: '已用 1,234 积分', x: 600, y: 240 },
    ]
    expect(trustOpenQuota({ kind: 'numbers', quote: '已用 1,234 积分', evidence: 'Credits', measure: 'left_amount', value: 1234, unit: '积分', reason: '' }, matches))
      .toMatchObject({ ok: false })
  })

  it('★「已用」与「剩余」离得近的那一句说了算(同窗两样都有时,不摇骰子)', () => {
    const matches = [
      { id: 'page', text: 'Models & Usage', x: 600, y: 100 },
      { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 300 },
      { id: 'pct', text: '100%', x: 1200, y: 300 },
    ]
    const trusted = trustOpenQuota({ kind: 'numbers', quote: '100%', evidence: 'Weekly Limit Remaining', measure: 'left_pct', value: 100, reason: '' }, matches)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    expect(trusted.numbers.measure).toBe('left_pct')
  })
})

/**
 * **Antigravity 的「Models & Usage」页**(卡 QG 第二件)。维护者截图上的原话:
 * Plan「Your Plan: Google AI Pro」;「Gemini Models」下「Weekly Limit Remaining … 100%」
 * 「Five Hour Limit Remaining … 98%」;「Claude and GPT models」下同样两条,都是 100%。
 *
 * 组名(「Gemini Models」「Claude and GPT models」)**读不回来**:壳一次最多 8 条正则
 * (`SendTextPolicy.readTextsMaxPatterns`)、每扇窗最多回 12 段,八条已经占满,没有一条认得出组名。
 * 所以这里按**限额窗口**分行(周 / 5 小时),同名的那一行取**最紧的那一个**,四条原话一条不落地写进出处。
 */
describe('卡 QG:Antigravity 的「Models & Usage」读得到', () => {
  const ANTI = [
    { id: 'page', text: 'Models & Usage', x: 600, y: 100 },
    { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 300 },
    { id: 'pct', text: '100%', x: 1200, y: 300 },
    { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 380 },
    { id: 'pct', text: '98%', x: 1200, y: 380 },
    { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 520 },
    { id: 'pct', text: '100%', x: 1200, y: 520 },
    { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 600 },
    { id: 'pct', text: '100%', x: 1200, y: 600 },
  ]

  it('★通用正则认得出这一页(以前一条旁证都不命中 → 一次模型都不叫 → 永远「这页上没看见用量」)', () => {
    const hit = (text: string) => OPEN_QUOTA_PATTERNS.filter(one => new RegExp(one.regex).test(text)).map(one => one.id)
    expect(hit('Models & Usage')).toContain('page')
    expect(hit('Weekly Limit Remaining')).toContain('limit')
    expect(hit('Five Hour Limit Remaining')).toContain('limit')
    expect(hit('100%')).toContain('pct')
    expect(openQuotaWorth(ANTI)).toBe(true)
  })

  it('★放宽之后,聊天里那一整句照旧配不上任何一条旁证(卡 MQ 那道门没松)', () => {
    const chat = ['你上次说的那个周限额到底是多少来着', '你这周额度只剩 1% 了', '前 5 秒彻底甩开 99% 的纯软件聊天框项目']
    const evidence = OPEN_QUOTA_PATTERNS.filter(one => OPEN_EVIDENCE_IDS.includes(one.id))
    for (const line of chat) for (const one of evidence) expect(new RegExp(one.regex).test(line)).toBe(false)
  })

  it('★四条都读回来:按限额窗口分两行(周 100%、5 小时 98%),那一句说最紧的那一个', () => {
    const said: OpenQuotaVerdict = {
      kind: 'numbers', quote: '100%', evidence: 'Weekly Limit Remaining', measure: 'left_pct', value: 100,
      items: ['100%', '98%', '100%', '100%'], reason: '四条都是这一页上的限额剩余',
    }
    const trusted = trustOpenQuota(said, ANTI)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    expect(trusted.numbers.extra?.length).toBe(3)
    const view = openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: trusted.numbers })
    expect(view.windows).toEqual([
      { label: 'Weekly Limit Remaining', left_pct: 100 },
      { label: 'Five Hour Limit Remaining', left_pct: 98 },
    ])
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 98, line: '还剩约 98%' })
    // 四条原话一条不落地写进出处(界面上「这个数哪来的」点开就是它)。
    expect(view.source).toContain('98%')
    expect(view.source).toContain('Weekly Limit Remaining')
  })

  it('★重读(不叫模型)也认得出这几行:98% 掉到 12% 照算,同名两行各归各的', () => {
    const said: OpenQuotaVerdict = {
      kind: 'numbers', quote: '100%', evidence: 'Weekly Limit Remaining', measure: 'left_pct', value: 100,
      items: ['98%'], reason: '',
    }
    const trusted = trustOpenQuota(said, ANTI)
    expect(trusted).toMatchObject({ ok: true })
    if (!trusted.ok) return
    const recipe = openQuotaRecipe(trusted.numbers)
    const later = ANTI.map(one => (one.text === '98%' ? { ...one, text: '12%' } : one))
    const again = rereadOpenNumbers(recipe, later)
    expect(again?.value).toBe(100)
    expect(again?.extra?.[0]).toMatchObject({ value: 12, label: 'Five Hour Limit Remaining' })
    expect(openQuotaView({ id: 'antigravity', title: 'Antigravity', at: NOW.toISOString(), numbers: again! }))
      .toMatchObject({ left_pct: 12, line: '只剩约 12%,快用完了' })
  })

  it('★整轮走通:那一页开着 + 点「读一下」→ 那一格从「这页上没看见用量」变成有数', async () => {
    const family: OpenQuotaFamily = { id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }
    const { r, fake } = reader({
      answer: () => ({ ok: true, result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: ANTI.map(one => ({ ...one, window: 0 })) } }),
      say: () => '{"kind":"numbers","quote":"100%","evidence":"Weekly Limit Remaining","measure":"left_pct","value":100,"items":["100%","98%","100%","100%"],"reason":"限额剩余"}',
    })
    await r.refreshOpen([family], { full: true })
    expect(fake.prompts).toHaveLength(1)
    const view = quotaFor(family.id, ctx({ open: r.openReadings([family]) }))
    expect(view).toMatchObject({ state: 'numbers', left_pct: 98 })
    expect(view.windows).toHaveLength(2)
  })
})
