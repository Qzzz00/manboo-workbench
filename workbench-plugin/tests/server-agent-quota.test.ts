/**
 * 每一家的额度(2026-09-25,卡 O;统筹:「额度/余额要覆盖派活名单里的每一家 —— Muse、Manus、豆包现在额度那里什么都没有」)。
 *
 * 钉住的几条:
 * - **按 agent id 取**(`quotaFor(id)`),每家只落在三格之一:有数 / 不限(查实)/ 没接上:原因;
 * - **认不出的 id 一律回「没接上:还没找到这家的额度来源」,不报错、不返回空**;
 * - 豆包办公 = **有额度**(卡 QD;维护者 09-26 19:00 拿那一页的截图说「豆包办公是有额度的,你又糊弄我」):
 *   它「订阅与额度管理」页上的「当前时段」+「近 7 天」两扇窗,同 Claude 那两条。**「不限」那一版已撤**;
 * - Manus 的积分从它首页右上角那一格读(只认顶栏最右、窗口右半边的那个数;通知角标不算);用完 / 快用完的横幅;
 * - Muse 从「使用情况」页上的「已使用 N%」、窗口上的「已用完使用额度」读;「无限制」要同时看见那一页才认;
 * - 读不到时按最近一次尝试说清原因 + 一键接上(没开着 → 打开它;老壳 → 装新版;没授权 → 去授权);
 * - 读窗口那一下:壳没连 / 没授权 / 老壳都不去问;读到的留着(带时刻),额度那一格不在窗口上时留着上一次的。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { QuotaAdapterContext, WindowQuotaReading } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW, MANUS_WINDOW, MUSE_WINDOW, balanceFromQuota, createWindowQuotaReader, doubaoQuotaOf, doubaoResetAt,
  forgetQuotaMemory, manusQuotaOf, museQuotaOf, quotaCheckSaid, quotaFor, quotasFor, readErrorOf, registerQuotaAdapter, windowQuotaSpecs,
} from '../src/server/agentQuota.ts'

const NOW = new Date('2026-09-25T10:00:00.000Z')
const AT = '2026-09-25T09:40:00.000Z'

/**
 * 要从窗口上读额度的那几家(卡 QD 起多了豆包办公;2026-10-04 卡「Grok 读已用」起多了 Grok Bot
 * —— 它那个数在账号菜单那一行上,从开集那条路搬到了窗口型)。
 * 读之前那一问(`running_apps`)按这张表回「都在跑」。
 */
const WINDOW_BUNDLES: readonly string[] = ['im.manus.desktop', 'com.meta.endo', 'com.bot.pc.doubao', 'com.anysphere.sand']

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, now: NOW, ...patch }
}

/**
 * 「上次读到的那个数」记在模块里(卡 QS),用例之间要清零 —— 不清的话上一条读到的数会顶进
 * 下一条「读不到」的用例里(那正是它该干的事,所以只能一条一条地立场景)。
 */
beforeEach(() => { forgetQuotaMemory() })

function read(matches: WindowQuotaReading['last'] extends infer L ? L extends { matches: infer M } ? M : never : never, width = 1200): WindowQuotaReading {
  return { last: { at: AT, width, matches }, attempt: { at: AT, found: true } }
}

describe('quotaFor:按 agent id 取,三格之一', () => {
  it('★认不出的 id → 「没接上:还没找到这家的额度来源」,不报错、不返回空', () => {
    expect(quotaFor('perplexity', ctx())).toEqual({
      id: 'perplexity', title: 'perplexity', state: 'unconnected', line: '没接上:还没找到这家的额度来源', why: '还没找到这家的额度来源',
    })
    expect(quotaFor('', ctx()).state).toBe('unconnected')
  })

  it('适配器自己抛了 → 也是「没接上」,不把错往外抛', () => {
    registerQuotaAdapter('broken-test', () => { throw new Error('boom') })
    expect(quotaFor('broken-test', ctx())).toMatchObject({ state: 'unconnected', line: '没接上:这次没读成' })
  })

  /**
   * ★ 卡 QD(2026-09-26 19:00):**豆包办公那一格不许再写「不限」**。
   *
   * 09-26 上午按维护者一句话(「豆包本身是不限制额度的」)把它写成了 `state:'unlimited'`;当晚他把
   * 豆包办公里「标准套餐 · 订阅与额度管理」那一页截图发来:「豆包办公是有额度的,你又糊弄我」。
   * 这一条就是那句话的守卫 —— 读不到的时候也只准说「没接上:原因」,不准回「不限」。
   */
  it('★豆包办公读不到时是「没接上:额度只在它那一页上」,不是「不限」', () => {
    const view = quotaFor('doubao', ctx())
    expect(view).toMatchObject({ id: 'doubao', title: '豆包办公', state: 'unconnected' })
    expect(view.state).not.toBe('unlimited')
    expect(view.line).not.toBe('不限')
    expect(balanceFromQuota(view)).toMatchObject({ level: 'unknown', state: 'unconnected' })
    expect(balanceFromQuota(view).text).not.toBe('不限')
  })

  it('Claude / Codex / Kimi:采集器那一格(取最紧的);没接上照「全部接上」/「自己登一次」说,带入口', () => {
    const quota = { claude: { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 88 }, { label: '周', left_pct: 62, reset_at: '2026-09-28T03:00:00Z' }] } }
    expect(quotaFor('claude', ctx({ quota }))).toMatchObject({ state: 'numbers', level: 'ok', line: '本周还剩约 62%', left_pct: 62, reset_at: '2026-09-28T03:00:00Z' })
    const clients = {
      claude: { installed: true, connected: true }, codex: { installed: true, connected: false }, kimi: { installed: true, connected: false },
      wechat: { installed: false, connected: false }, wecom: { installed: false, connected: false },
    }
    expect(quotaFor('codex', ctx({ clients }))).toMatchObject({ state: 'unconnected', short: '没接上:点一次「全部接上」', fix: { kind: 'unlock', label: '全部接上' } })
    expect(quotaFor('kimi', ctx({ clients }))).toMatchObject({ state: 'unconnected', line: '没接上:要你自己登一次 Kimi(账号密码工作台不经手)', fix: { kind: 'unlock' } })
  })

  it('DeepSeek 与 GPT:走工作台的服务时花的是同一份今日额度;接口没接上 GPT 就说没接上', () => {
    const quota = { dsh: { kind: 'quota' as const, windows: [{ label: '今日', left_pct: 80 }] } }
    // 卡 GH(2026-09-26):GPT 有数的前提多了一条 —— **中转上真配了 OpenAI**。
    const openai = { deepseek: true, openai: true, doubao: false }
    expect(quotaFor('dsh', ctx({ quota, modelMode: 'relay' })).line).toBe('工作台模型服务今天还剩约 80%')
    expect(quotaFor('gpt', ctx({ quota, modelMode: 'relay', apiReady: true, relayProviders: openai }))).toMatchObject({ state: 'numbers', line: '工作台服务今天还剩约 80%' })
    expect(quotaFor('gpt', ctx({ quota, modelMode: 'relay', relayProviders: openai }))).toMatchObject({ state: 'unconnected', line: '没接上:GPT 走工作台的服务,这台电脑还没接上' })
    expect(quotaFor('dsh', ctx({ quota: { dsh: { kind: 'unknown', no_stale: true } } }))).toMatchObject({ state: 'unconnected', fix: { kind: 'unlock' } })
  })

  /**
   * ★ 卡 GH(2026-09-26):**中转上没配 OpenAI** 时 GPT 那一格说的是「中转没配这家」,不是「这台电脑没接上」。
   * 两句话的下一步不一样:前者要在服务器上加一把 Key(不是他能做的),后者他自己在设置里点一下就好。
   * (名单里本来就不该有 GPT —— `dispatchTargets` 已经把它挡在外面;走到这一格的只有「他点名了 GPT」那条路。)
   */
  it('★中转没配 OpenAI → GPT 那一格说「中转没配这家」;从没问到过 /health 也算没配', () => {
    const quota = { dsh: { kind: 'quota' as const, windows: [{ label: '今日', left_pct: 80 }] } }
    const base = { quota, modelMode: 'relay' as const, apiReady: true }
    expect(quotaFor('gpt', ctx({ ...base, relayProviders: { deepseek: true, openai: false, doubao: false } })))
      .toMatchObject({ state: 'unconnected', line: '没接上:GPT 走工作台的服务,中转没配这家', short: '没接上:中转没配这家' })
    // `/health` 一次都没问到:同样当「没配」—— 宁可少一家,不摆空壳。
    expect(quotaFor('gpt', ctx(base))).toMatchObject({ state: 'unconnected', line: '没接上:GPT 走工作台的服务,中转没配这家' })
  })

  it('几家一起(额度区那一排):顺序照给的 id', () => {
    expect(quotasFor(['doubao', 'muse', 'manus', 'nope'], ctx()).map(one => [one.id, one.state])).toEqual([
      ['doubao', 'unconnected'], ['muse', 'unconnected'], ['manus', 'unconnected'], ['nope', 'unconnected'],
    ])
  })
})

describe('Manus:首页右上角那一格积分', () => {
  it('★认顶栏最右、窗口右半边的那个数;通知角标、左半边的数不算', () => {
    const view = quotaFor('manus', ctx({ window: { manus: read([
      { id: 'credits', text: '1.6', x: 90, y: 20 },
      { id: 'credits', text: '3', x: 1010, y: 20 },
      { id: 'credits', text: '1,234', x: 1120, y: 20 },
    ]) } }))
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left: { text: '1,234', unit: '积分', amount: 1234 }, read_at: AT })
    // 20 分钟前读到的 → 那一句里带上「截至 HH:MM」(卡 QS 要写时刻,卡 QA 统一成「截至」);还没过线,不标灰。
    expect(view.line).toMatch(/^剩 1,234 积分 · 截至 \d{2}:\d{2}$/)
    expect(view.stale).toBeUndefined()
    expect(view.source).toContain('在 Manus 窗口上读到的')
    expect(balanceFromQuota(view)).toMatchObject({ level: 'ok', text: view.short, state: 'numbers' })
  })

  it('1.2K 这种缩写照原样说;∞(限时免费)= 不限;横幅:用完了 / 快用完了', () => {
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [{ id: 'credits', text: '12.5K', x: 1100, y: 20 }] })).toMatchObject({ line: '剩 12.5K 积分', left: { amount: 12500 } })
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [{ id: 'credits', text: '∞', x: 1100, y: 20 }] })).toMatchObject({ state: 'unlimited', line: '不限' })
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [{ id: 'empty', text: '积分已用完，将于 9月26日 重置', x: 300, y: 600 }] }))
      .toMatchObject({ state: 'numbers', level: 'empty', line: '积分用完了(积分已用完，将于 9月26日 重置)', short: '积分用完了' })
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [{ id: 'credits', text: '120', x: 1100, y: 20 }, { id: 'low', text: 'Running low. Resets on Sep 26', x: 300, y: 600 }] }))
      .toMatchObject({ level: 'low', line: '剩 120 积分,快用完了' })
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [{ id: 'credits', text: '0', x: 1100, y: 20 }] })).toMatchObject({ level: 'empty', line: '积分用完了' })
    expect(manusQuotaOf({ at: AT, width: 1200, matches: [] })).toBeUndefined()
  })

  /**
   * ★ 2026-09-30(维护者拍板把「叫到台前」那一整套键删掉,见 `docs/决策记录.md` 末尾那一条)。
   * 原来这几支各挂一颗键(叫到台前 / 打开 Manus / 放出 X)。**键没了,话一个字不少**:
   * 该他自己去打开哪一页那句人话,从键旁边搬进那一行本身(`line` / `why`)。
   */
  it('★读不到时按最近一次尝试说清原因;该他自己去点的那一步写成一句话,不摆键', () => {
    const manus = (attempt: WindowQuotaReading['attempt']) => quotaFor('manus', ctx({ window: { manus: attempt === undefined ? {} : { attempt } } }))
    const never = manus(undefined)
    expect(never.state).toBe('unconnected')
    expect(never.fix).toBeUndefined()
    expect(never.why).toContain('在 Manus 里回到首页,右上角那一格就是积分;工作台看一眼就记下')
    // ★读过窗口、那一格不在(2026-09-26 维护者点了「读一下」看不出动过):要写上几点读过,跟「从没读过」不能是同一句。
    const missed = manus({ at: AT, found: false })
    expect(missed).toMatchObject({ short: '没接上:积分只在它首页右上角' })
    expect(missed.fix).toBeUndefined()
    expect(missed.line).toMatch(/^没接上:\d\d:\d\d 读过 Manus 的窗口,积分只在它首页右上角那一格,这会儿窗口不在首页 —— 在 Manus 里回到首页,右上角那一格就是积分;工作台看一眼就记下$/)
    expect(missed.why).not.toBe(manus(undefined).why)
    const museMissed = quotaFor('muse', ctx({ window: { muse: { attempt: { at: AT, found: false } } } }))
    expect(museMissed.why).toMatch(/^\d\d:\d\d 读过 Muse 的窗口,这会儿不在「使用情况」页上;/)
    expect(museMissed).toMatchObject({ short: '没接上:不在「使用情况」页上' })
    expect(museMissed.fix).toBeUndefined()
    expect(museMissed.why).toContain('在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
    expect(museMissed.why).not.toBe(quotaFor('muse', ctx({ window: { muse: {} } })).why)
    const closed = manus({ at: AT, found: false, error: 'not_running' })
    expect(closed).toMatchObject({ short: '没接上:Manus 没开着' })
    expect(closed.fix).toBeUndefined()
    expect(closed.why).toBe(`Manus 没开着,读不了它窗口上的额度 —— 在 Manus 里回到首页,右上角那一格就是积分;工作台看一眼就记下`)
    expect(manus({ at: AT, found: false, error: 'old_shell' })).toMatchObject({ short: '没接上:要新版工作台 App', fix: { kind: 'update_shell' } })
    expect(manus({ at: AT, found: false, error: 'no_ax' })).toMatchObject({ short: '没接上:要先授权辅助功能', fix: { kind: 'grant_ax', label: '去授权' } })
    expect(manus({ at: AT, found: false, error: 'no_helper' })).toMatchObject({ short: '没接上:工作台 App 没连上' })
  })

  it('★读到很久了仍然不是「没接上」,但**不出那个数**(2026-09-26 卡 QS 否掉「没接上」;2026-10-02 卡 QA 否掉「照说那个数」)', () => {
    const old = { last: { at: '2026-09-24T20:00:00.000Z', width: 1200, matches: [{ id: 'credits', text: '900', x: 1100, y: 20 }] }, attempt: { at: AT, found: false } }
    const view = quotaFor('manus', ctx({ window: { manus: old } }))
    expect(view).toMatchObject({ state: 'numbers', stale: true, read_at: '2026-09-24T20:00:00.000Z' })
    expect(view.line).toContain('读不到最新的,上次')
    // 那个数一个字都不留:陈旧的数不能冒充当下(她看见一个数就会把它当此刻的用量)。
    expect(view.line).not.toContain('900')
    expect(view.left).toBeUndefined()
    expect(view.line).not.toContain('没接上')
  })

  it('给壳的正则只找那几小段(积分那一格限在顶栏)', () => {
    expect(windowQuotaSpecs().get('manus')).toBe(MANUS_WINDOW)
    expect(MANUS_WINDOW.bundleId).toBe('im.manus.desktop')
    const credits = MANUS_WINDOW.patterns.find(one => one.id === 'credits')
    expect(credits?.top).toBeGreaterThan(0)
    const rx = new RegExp(credits?.regex ?? '')
    expect(['1,234', '12.5K', '∞', '0'].every(one => rx.test(one))).toBe(true)
    expect(['给 Lapis 写周报 3 份', 'Manus 1.6 Lite', '1,234 credits'].some(one => rx.test(one))).toBe(false)
  })
})

describe('Muse:「使用情况」页上的百分比 / 窗口上的「已用完使用额度」', () => {
  it('已使用 38% → 还剩约 62%;用完了;快用完了', () => {
    const muse = quotaFor('muse', ctx({ window: { muse: read([{ id: 'page', text: '使用情况', x: 300, y: 120 }, { id: 'used', text: '已使用 38%', x: 300, y: 200 }]) } }))
    expect(muse).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 62 })
    expect(muse.line).toMatch(/^还剩约 62% · 截至 \d{2}:\d{2}$/)
    expect(museQuotaOf({ at: AT, matches: [{ id: 'plan', text: 'Free plan', x: 0, y: 0 }, { id: 'used', text: '91% used', x: 0, y: 0 }] }))
      .toMatchObject({ level: 'low', line: '只剩约 9%,快用完了' })
    expect(museQuotaOf({ at: AT, matches: [{ id: 'empty', text: '已用完使用额度', x: 0, y: 0 }] })).toMatchObject({ level: 'empty', left_pct: 0, short: '用量用完了' })
  })

  it('★维护者那一屏:「Free plan」「Weekly limit resets on Oct 1」「2% used」→ 还剩约 98%,重置那一行写进出处', () => {
    const view = museQuotaOf({
      at: AT,
      matches: [
        { id: 'page', text: '使用情况', x: 400, y: 120, window: 1 },
        { id: 'plan', text: 'Free plan', x: 400, y: 160, window: 1 },
        { id: 'reset', text: 'Weekly limit resets on Oct 1', x: 400, y: 190, window: 1 },
        { id: 'used', text: '2% used', x: 400, y: 220, window: 1 },
      ],
    })
    expect(view).toMatchObject({ state: 'numbers', level: 'ok', left_pct: 98, line: '还剩约 98%' })
    expect(view?.source).toContain('在 Muse 窗口上读到的')
    expect(view?.source).toContain('2% used')
    // 「几号重置」原话照抄,**不折算成时刻**(「Oct 1」没有年份也没有时区,折出来的那个时刻是编的)。
    expect(view?.source).toContain('Weekly limit resets on Oct 1')
    expect(view).not.toHaveProperty('reset_at')
  })

  it('★百分比要有「这确实是那一页」的旁证才认 —— 不然读到的可能是他跟 Muse 聊天里的一个数', () => {
    // 壳改成每一扇窗都读之后,聊天窗也在读的范围里了;而他跟 Muse 聊的正是额度,
    // 那扇窗的记录里就写着「…周限额的 0%」「…只剩 1%」。差这条旁证就说读不到,不给假数(D13)。
    expect(museQuotaOf({ at: AT, matches: [{ id: 'used', text: '已使用 38%', x: 300, y: 900 }] })).toBeUndefined()
    expect(museQuotaOf({ at: AT, matches: [{ id: 'used', text: '2% used', x: 300, y: 900 }] })).toBeUndefined()
    // 三条旁证任意一条都算(页标题 / 档位 / 重置那一行)。
    for (const mark of [{ id: 'page', text: '使用情况' }, { id: 'plan', text: 'Free plan' }, { id: 'reset', text: 'Weekly limit resets on Oct 1' }]) {
      expect(museQuotaOf({ at: AT, matches: [{ ...mark, x: 300, y: 100 }, { id: 'used', text: '2% used', x: 300, y: 200 }] }))
        .toMatchObject({ state: 'numbers', left_pct: 98 })
    }
  })

  it('给壳的正则:旁证那三条都要**整格文字**才算,聊天里的一句话配不上', () => {
    const rx = (id: string): RegExp => new RegExp(MUSE_WINDOW.patterns.find(one => one.id === id)?.regex ?? '')
    expect(rx('page').test('使用情况')).toBe(true)
    expect(rx('page').test('额度,我刚帮你看了一下,使用情况是这样')).toBe(false)
    expect(rx('plan').test('Free plan')).toBe(true)
    expect(rx('plan').test('I am on the free plan right now')).toBe(false)
    expect(rx('reset').test('Weekly limit resets on Oct 1')).toBe(true)
    expect(rx('reset').test('你说过 weekly limit resets on Oct 1 对吧')).toBe(false)
    expect(rx('used').test('2% used')).toBe(true)
    expect(rx('used').test('已使用 38%')).toBe(true)
  })

  it('「无限制」要同时看见「使用情况」那一页才认(别处的「无限制」说的是别的事)', () => {
    expect(museQuotaOf({ at: AT, matches: [{ id: 'unlimited', text: '无限制', x: 0, y: 0 }] })).toBeUndefined()
    expect(museQuotaOf({ at: AT, matches: [{ id: 'page', text: '使用情况', x: 0, y: 0 }, { id: 'unlimited', text: '无限制', x: 0, y: 0 }] }))
      .toMatchObject({ state: 'unlimited', line: '不限' })
  })

  it('★读不到:说清剩多少只在它自己的「使用情况」页上(那句话写在行上,不摆键)', () => {
    const view = quotaFor('muse', ctx())
    expect(view).toMatchObject({
      state: 'unconnected',
      short: '没接上:剩多少只在它的「使用情况」页上',
    })
    // ★ 卡 MQ2:那半句「留在你这会儿看着的桌面上」是实测钉出来的 —— 窗一到别的桌面上,
    // 系统就不让工作台看见它,少这半句他照着做完还是读不到。
    // ★ 2026-09-30:这句话原来挂在那颗「叫到台前」的键旁边;键删了,话搬进那一行(`why`)。
    expect(view.fix).toBeUndefined()
    expect(view.why).toContain('在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
    expect(MUSE_WINDOW.bundleId).toBe('com.meta.endo')
  })
})

/**
 * 豆包办公:**窗口型额度**(卡 QD,2026-09-26)。维护者 19:00 的那一屏(Doubao.app 里一个居中弹窗):
 *
 *     标准套餐 / 订阅与额度管理            免费体验至10月25日
 *     升级至付费订阅 · 享高峰期优先
 *     购买创作额度包
 *     当前时段        已用 <1%     ▁▁▁▁▁▁▁▁     4 小时 45 分钟后重置
 *     近 7 天         已用 <1%     ▁▁▁▁▁▁▁▁     10月2日 16:02 重置
 *     订阅记录
 *
 * 钉住的:两组三段按位置(y)各配成一组 → 两扇窗;「已用 <1%」= 剩 99;相对 / 绝对两种重置各自折成时刻;
 * **没有那一页的旁证不认**(他跟豆包聊的可能正是额度);读不到时说清那一页在哪。
 */
describe('豆包办公:「订阅与额度管理」页上的「当前时段」+「近 7 天」', () => {
  /**
   * 维护者那一屏,**坐标是真机探针读回来的那八小段**(2026-09-26 19:0x,
   * `probe read-texts com.bot.pc.doubao …`):小标题与它的「已用 N%」同一行(y 相同),
   * 重置那一行在下面 —— 分组规矩(见 `doubaoWindowGroups`)就是照这个量出来的,不是猜的。
   */
  const SCREEN = [
    { id: 'page', text: '标准套餐', x: 552, y: 163, window: 0 },
    { id: 'page', text: '订阅与额度管理', x: 552, y: 203, window: 0 },
    { id: 'window_5h', text: '当前时段', x: 560, y: 378, window: 0 },
    { id: 'used', text: '已用 <1%', x: 1020, y: 378, window: 0 },
    { id: 'reset_rel', text: '4 小时 45 分钟后重置', x: 560, y: 442, window: 0 },
    { id: 'window_7d', text: '近 7 天', x: 560, y: 487, window: 0 },
    { id: 'used', text: '已用 <1%', x: 1020, y: 487, window: 0 },
    { id: 'reset_abs', text: '10月2日 16:02 重置', x: 560, y: 551, window: 0 },
  ]
  /** 绝对那一行缺年份,按**本地**年份折 —— 用例也照本地算,不写死一个 ISO 串(跨时区跑会假红)。 */
  const OCT_2 = new Date(2026, 9, 2, 16, 2).toISOString()

  it('★维护者那一屏 → 两扇窗(5h / 周)各剩 99%,两个重置各自折成时刻,出处写页上原话', () => {
    const view = doubaoQuotaOf({ at: AT, width: 1200, matches: SCREEN })
    expect(view).toMatchObject({ id: 'doubao', title: '豆包办公', state: 'numbers', level: 'ok', left_pct: 99 })
    // 形状就是老四格那份 QuotaWindow —— 界面照这个画出「5h / 周」两条横条。
    expect(view?.windows).toEqual([
      { label: '5h', left_pct: 99, reset_at: '2026-09-25T14:25:00.000Z' },
      { label: '周', left_pct: 99, reset_at: OCT_2 },
    ])
    // 那一句只说**最紧的那一扇**(两扇一样紧就是上面那扇),措辞与老四格逐字相同。
    expect(view?.line).toBe('5 小时窗口还剩约 99%')
    expect(view?.reset_at).toBe('2026-09-25T14:25:00.000Z')
    expect(view?.source).toContain('在豆包办公窗口上读到的')
    expect(view?.source).toContain('「订阅与额度管理」页上写着')
    expect(view?.source).toContain('「当前时段 已用 <1%」')
    expect(view?.source).toContain('「4 小时 45 分钟后重置」')
    expect(view?.source).toContain('「近 7 天 已用 <1%」')
    expect(view?.source).toContain('「10月2日 16:02 重置」')
  })

  it('★额度那一格与派活确认点那一句都跟着变:有数、不再是「不限」', () => {
    const view = quotaFor('doubao', ctx({ window: { doubao: read(SCREEN) } }))
    expect(view.state).toBe('numbers')
    expect(view.line).toMatch(/^5 小时窗口还剩约 99% · 截至 \d{2}:\d{2}$/)
    expect(balanceFromQuota(view)).toMatchObject({ level: 'ok', state: 'numbers', left_pct: 99, reset_at: '2026-09-25T14:25:00.000Z' })
    expect(balanceFromQuota(view).text).not.toBe('不限')
  })

  it('「已用 <1%」→ 剩 99(不到 1% 按 1% 折:宁可少说剩余);「已用 38%」→ 剩 62;最紧的那一扇说话', () => {
    const at = (used5h: string, used7d: string) => doubaoQuotaOf({
      at: AT,
      matches: [
        { id: 'page', text: '订阅与额度管理', x: 520, y: 212 },
        { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
        { id: 'used', text: used5h, x: 860, y: 400 },
        { id: 'window_7d', text: '近 7 天', x: 420, y: 500 },
        { id: 'used', text: used7d, x: 860, y: 500 },
      ],
    })
    expect(at('已用 <1%', '已用 38%')).toMatchObject({ left_pct: 62, line: '本周还剩约 62%', level: 'ok' })
    expect(at('已用 91%', '已用 38%')).toMatchObject({ left_pct: 9, line: '5 小时窗口只剩约 9%,快用完了', level: 'low' })
    expect(at('已用 100%', '已用 38%')).toMatchObject({ left_pct: 0, line: '5 小时窗口额度用完了', level: 'empty' })
    expect(at('已用 <1%', '已用 <1%')?.windows).toEqual([{ label: '5h', left_pct: 99 }, { label: '周', left_pct: 99 }])
  })

  /**
   * ★ 同 Muse 那条纪律(卡 MQ):壳一次读这个 App 的**每一扇窗**,他跟豆包聊天的那扇也在里面,
   * 而人跟 Agent 聊的正可能是额度。见着百分号就当额度,会把**他对话里的一个数**当成额度显示出来。
   */
  it('★只见百分号、没有那一页的旁证 → 不认', () => {
    expect(doubaoQuotaOf({
      at: AT,
      matches: [{ id: 'window_5h', text: '当前时段', x: 420, y: 400 }, { id: 'used', text: '已用 38%', x: 860, y: 400 }],
    })).toBeUndefined()
    // 反过来:有旁证、但一扇窗的小标题都没读到 —— 配不出「这个数说的是哪一扇窗」,同样不认。
    expect(doubaoQuotaOf({
      at: AT,
      matches: [{ id: 'page', text: '订阅与额度管理', x: 520, y: 212 }, { id: 'used', text: '已用 38%', x: 860, y: 400 }],
    })).toBeUndefined()
    // 旁证只有「标准套餐」那半句也算(它也是那一页上的整格标题)。
    expect(doubaoQuotaOf({
      at: AT,
      matches: [
        { id: 'page', text: '标准套餐', x: 520, y: 180 },
        { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
        { id: 'used', text: '已用 38%', x: 860, y: 400 },
      ],
    })).toMatchObject({ state: 'numbers', left_pct: 62 })
  })

  it('★按位置配组:重置那一行归它上面那一格;第一格之上的百分比不算(页头那两行入口)', () => {
    const view = doubaoQuotaOf({
      at: AT,
      matches: [
        { id: 'page', text: '订阅与额度管理', x: 520, y: 212 },
        // 页头上方还有一个百分号(升级那一行的角标之类):它在第一格小标题之上 —— 丢掉,不算任何一扇窗的。
        { id: 'used', text: '已用 77%', x: 860, y: 260 },
        { id: 'window_5h', text: '当前时段', x: 420, y: 400 },
        { id: 'used', text: '已用 10%', x: 860, y: 400 },
        { id: 'reset_rel', text: '30 分钟后重置', x: 420, y: 446 },
        { id: 'window_7d', text: '近 7 天', x: 420, y: 500 },
        { id: 'used', text: '已用 20%', x: 860, y: 500 },
        { id: 'reset_abs', text: '10月2日 16:02 重置', x: 420, y: 546 },
      ],
    })
    expect(view?.windows).toEqual([
      { label: '5h', left_pct: 90, reset_at: '2026-09-25T10:10:00.000Z' },
      { label: '周', left_pct: 80, reset_at: OCT_2 },
    ])
    expect(view?.line).toBe('本周还剩约 80%')
  })

  it('重置那一行折成时刻:相对的按读到那一刻算,绝对的按本地年份(跨年算明年)', () => {
    expect(doubaoResetAt('4 小时 45 分钟后重置', AT)).toBe('2026-09-25T14:25:00.000Z')
    expect(doubaoResetAt('5 小时后重置', AT)).toBe('2026-09-25T14:40:00.000Z')
    expect(doubaoResetAt('30 分钟后重置', AT)).toBe('2026-09-25T10:10:00.000Z')
    expect(doubaoResetAt('10月2日 16:02 重置', AT)).toBe(OCT_2)
    // 12 月读到「1月2日」:说的是明年那一天(7 天窗的重置一定在往后不远处)。
    expect(doubaoResetAt('1月2日 16:02 重置', '2026-12-30T09:40:00.000Z')).toBe(new Date(2027, 0, 2, 16, 2).toISOString())
    expect(doubaoResetAt('过一会儿重置', AT)).toBeUndefined()
  })

  it('给壳的正则:旁证与两格小标题都要**整格文字**,聊天里的一句话配不上', () => {
    expect(windowQuotaSpecs().get('doubao')).toBe(DOUBAO_WINDOW)
    expect(DOUBAO_WINDOW.bundleId).toBe('com.bot.pc.doubao')
    // 壳一次最多 8 条(卡 MQ 那条口径)。
    expect(DOUBAO_WINDOW.patterns.length).toBeLessThanOrEqual(8)
    const rx = (id: string): RegExp => new RegExp(DOUBAO_WINDOW.patterns.find(one => one.id === id)?.regex ?? '')
    expect(rx('page').test('订阅与额度管理')).toBe(true)
    expect(rx('page').test('标准套餐')).toBe(true)
    expect(rx('page').test('你帮我看看订阅与额度管理那页写的什么')).toBe(false)
    expect(rx('window_5h').test('当前时段')).toBe(true)
    expect(rx('window_5h').test('当前时段还剩多少?')).toBe(false)
    expect(rx('window_7d').test('近 7 天')).toBe(true)
    expect(rx('window_7d').test('近7天')).toBe(true)
    expect(rx('used').test('已用 <1%')).toBe(true)
    expect(rx('used').test('已用 38%')).toBe(true)
    expect(rx('used').test('这周你已用 38% 了吧')).toBe(false)
    expect(rx('reset_rel').test('4 小时 45 分钟后重置')).toBe(true)
    expect(rx('reset_rel').test('30 分钟后重置')).toBe(true)
    expect(rx('reset_abs').test('10月2日 16:02 重置')).toBe(true)
  })

  it('★读不到:说清额度只在「订阅与额度管理」那一页上(那句话写在行上,不摆键)', () => {
    const never = quotaFor('doubao', ctx())
    expect(never).toMatchObject({
      state: 'unconnected',
      short: '没接上:额度只在它「订阅与额度管理」那一页上',
    })
    expect(never.fix).toBeUndefined()
    /*
     * ★ 2026-10-04(卡「豆包台前点一下」):这句话跟着能力改了 —— 她不用自己去豆包里点了。
     * 台前合成一次鼠标点击就开得了那一页(维护者拍板「可以」,真机量过),所以这一行说的是
     * 「点一下『读一下』,工作台替你点开那一页」。原来那句「你自己打开头像 → …」是那会儿
     * 唯一的通路,今天不是了。
     */
    expect(never.why).toContain('点一下「读一下」,工作台会闪一下豆包办公、替你点开「订阅与额度管理」那一页再读,读完立刻把台前与窗口都还原')
    // 读过窗口、那一页不在(同 Muse / Manus:写上几点读过、现在差哪一步,不然点完「读一下」看不出动过)。
    const missed = quotaFor('doubao', ctx({ window: { doubao: { attempt: { at: AT, found: false } } } }))
    expect(missed.why).toMatch(/^\d\d:\d\d 读过豆包办公的窗口,这会儿不在「订阅与额度管理」那一页上;/)
    expect(missed).toMatchObject({ short: '没接上:不在「订阅与额度管理」那一页上' })
    // 中文家名起头的那几句不留半角空格(「豆包办公没开着」,不是「豆包办公 没开着」)。
    const closed = quotaFor('doubao', ctx({ window: { doubao: { attempt: { at: AT, found: false, error: 'not_running' } } } }))
    expect(closed).toMatchObject({ short: '没接上:豆包办公没开着' })
    expect(closed.fix).toBeUndefined()
    expect(closed.why).toBe(`豆包办公没开着,读不了它窗口上的额度 —— 点一下「读一下」,工作台会闪一下豆包办公、替你点开「订阅与额度管理」那一页再读,读完立刻把台前与窗口都还原`)
  })
})

describe('读窗口那一下(壳 read_texts)', () => {
  function reader(answer: (req: HelperRequest) => Promise<Record<string, unknown>>, helper = { connected: true, authorized: true, readTexts: true }) {
    const calls: HelperRequest[] = []
    let changed = 0
    let clock = NOW.getTime()
    const waits: number[] = []
    const r = createWindowQuotaReader({
      request: async (req) => {
        /*
         * 2026-10-03(卡 QZ):读之前先问一句壳「谁在跑 / 谁在前台」(`running_apps`,不碰辅助功能)。
         * 这一下**不算一次读**,所以不进 `calls`(下面那几条断言数的是「一轮各问了哪几家的窗口」);
         * 回的是「这三家都在跑、都不在前台」—— 这几条用例一直假设的那个样子
         * (「没在跑」走的是后台拉起那一支,它自己的用例在 `quota-reads-itself.test.ts`)。
         */
        if ((req as { op: string }).op === 'running_apps') {
          return { ok: true, result: { apps: WINDOW_BUNDLES.map(bundle => ({ bundle_id: bundle, active: false, hidden: false })) } }
        }
        calls.push(req)
        return await answer(req)
      },
      helper: () => helper,
      now: () => new Date(clock),
      onChanged: () => { changed += 1 },
      // 「等一拍再看一眼」(卡 QD):用例里立刻回,只记下等过几次 —— 别让用例真睡 900ms。
      wait: async (ms) => { waits.push(ms) },
    })
    return { r, calls, waits, changed: () => changed, tick: (ms: number) => { clock += ms } }
  }

  it('★壳没连 / 没授权 / 老壳:都不去问,记下为什么', async () => {
    for (const [helper, error] of [
      [{ connected: false, authorized: false, readTexts: false }, 'no_helper'],
      [{ connected: true, authorized: false, readTexts: true }, 'no_ax'],
      [{ connected: true, authorized: true, readTexts: false }, 'old_shell'],
    ] as const) {
      const { r, calls } = reader(async () => ({ ok: true }), { ...helper })
      await r.refresh()
      expect(calls).toEqual([])
      expect(r.readings().manus?.attempt).toMatchObject({ found: false, error })
    }
  })

  it('读到了就留着(带时刻);额度那一格不在窗口上时留着上一次的;只问注册过的那几家、只给那几条正则', async () => {
    let manusOnHome = true
    const { r, calls, changed } = reader(async (req) => {
      if (req.op === 'read_texts' && req.bundle_id === 'im.manus.desktop') {
        return { ok: true, result: { matches: manusOnHome ? [{ id: 'credits', text: '1,234', x: 1100, y: 20 }] : [], window: { w: 1200, h: 800 } } }
      }
      return { ok: true, result: { matches: [] } }
    })
    await r.refresh()
    // 要从窗口上读的那几家(卡 QD 起多了豆包办公,卡「Grok 读已用」起多了 Grok Bot):
    // 一轮各问一次,别家一个都不问。这份壳没有 `quota_page` 那一格(老壳),所以自动这一轮一颗键都不按。
    expect(calls.map(one => (one as { bundle_id: string }).bundle_id).sort()).toEqual([...WINDOW_BUNDLES].sort())
    expect((calls[0] as { patterns: unknown }).patterns).toBeDefined()
    // ★卡 MQ:**不给 index** —— 新壳据此把每一扇窗都读一遍(写死第 0 扇就是掷骰子)。
    expect(calls.every(one => !('index' in one))).toBe(true)
    expect(r.readings().manus?.last?.matches).toEqual([{ id: 'credits', text: '1,234', x: 1100, y: 20, window: 0 }])
    expect(r.readings().muse?.attempt).toMatchObject({ found: false })
    expect(changed()).toBe(1)
    manusOnHome = false
    await r.refresh()
    expect(r.readings().manus?.last?.matches[0]?.text).toBe('1,234')
    expect(r.readings().manus?.attempt?.found).toBe(false)
  })

  it('★几扇窗一起回:**按窗分开**一扇一扇地问,认得出的那扇算数(2026-09-26 卡 MQ)', async () => {
    // Muse 开着两扇窗:第 0 扇是聊天窗(他正跟 Muse 聊额度,记录里就有百分比),
    // 第 1 扇是设置窗的「使用情况」页。合在一个篮子里会拿聊天里的数配设置页的旁证 —— 读出一个假数。
    const { r } = reader(async (req) => {
      if (req.op !== 'read_texts' || req.bundle_id !== 'com.meta.endo') return { ok: true, result: { matches: [] } }
      return {
        ok: true,
        result: {
          windows: [{ index: 0, w: 1640, h: 945 }, { index: 1, w: 800, h: 600 }],
          window: { w: 1640, h: 945 },
          matches: [
            { id: 'used', text: '已使用 99%', x: 300, y: 500, window: 0 },
            { id: 'page', text: '使用情况', x: 400, y: 120, window: 1 },
            { id: 'used', text: '2% used', x: 400, y: 220, window: 1 },
          ],
        },
      }
    })
    await r.refresh(['muse'])
    expect(r.readings().muse?.attempt).toMatchObject({ found: true })
    // 留下的是**第 1 扇那一组**,聊天窗那个 99% 没混进来。
    expect(r.readings().muse?.last?.matches.map(one => one.window)).toEqual([1, 1])
    expect(quotaFor('muse', ctx({ window: { muse: r.readings().muse } }))).toMatchObject({ state: 'numbers', left_pct: 98 })
  })

  it('★有窗不在这会儿看着的桌面上:辅助功能看不见它们,那一格要照直说(2026-09-26 卡 MQ / MQ2)', async () => {
    // 实测(卡 MQ2 在维护者机器上同一刻对照采样):窗一到别的桌面上,`AXWindows` 里就没有它 ——
    // 这时候只说「这会儿不在『使用情况』页上」是句不对的话:那一页可能开得好好的,只是在别的桌面上。
    // 壳回的 `offspace_windows` 是**数出来的**那个数(不在当前桌面上的有几扇),不是减出来的。
    const { r } = reader(async () => ({ ok: true, result: { matches: [], windows: [{ index: 0, w: 1640, h: 945 }], offspace_windows: 3 } }))
    await r.refresh(['muse'])
    expect(r.readings().muse?.attempt).toMatchObject({ found: false, offspace: 3 })
    const view = quotaFor('muse', ctx({ window: { muse: r.readings().muse } }))
    // **主句不变**:他多半就是没打开那一页,该做的那一步还是「去打开『使用情况』」
    // (Muse 那两扇登录 / 欢迎的老窗一直挂在别的桌面上,抢了主句就天天说这句、把该做的那步盖掉)。
    expect(view).toMatchObject({ state: 'unconnected', short: '没接上:不在「使用情况」页上' })
    expect(view.why).toMatch(/^\d\d:\d\d 读过 Muse 的窗口,这会儿不在「使用情况」页上/)
    expect(view.why).toContain('另有 3 扇窗不在你这会儿看着的桌面上')
    // 没有别的桌面上的窗时,一个字都不多说。
    const { r: plain } = reader(async () => ({ ok: true, result: { matches: [], windows: [{ index: 0, w: 1640, h: 945 }] } }))
    await plain.refresh(['muse'])
    // 2026-09-30(维护者拍板全删「带我过去」):该他自己去点的那一步并进了这一句,而那句话里本来就带着
    // 「那扇窗留在你这会儿看着的桌面上」—— 所以这一条钉的是**「别的桌面上还有几扇」那半句**不出场
    //(它才是「没有别的桌面上的窗时一个字都不多说」要挡的那句),不是整句里不许有「桌面」两个字。
    const plainWhy = quotaFor('muse', ctx({ window: { muse: plain.readings().muse } })).why
    expect(plainWhy).not.toContain('别的桌面')
    expect(plainWhy).not.toContain('另有')
    expect(plainWhy).not.toContain('扇窗不在你这会儿看着的桌面上')
  })

  it('★这家这会儿是藏起来的:别说「有窗在别的桌面上」,更别说「没有窗口」(2026-09-26 卡 MQ2)', async () => {
    // 实测维护者那台机器:Muse 多数时候被藏着(⌘H,或者工作台自己把它藏回去)——
    // 四扇窗好好地开着,只是一扇都不在任何桌面上,辅助功能什么都读不到。
    // 他要做的下一步是「点一下图标把它放出来」,不是去别的桌面找,也不是开一扇新窗。
    const { r } = reader(async () => ({
      ok: true,
      result: { matches: [], windows: [{ index: 0, w: 1640, h: 945 }], app_hidden: true, os_windows: 4, offspace_windows: 4 },
    }))
    await r.refresh(['muse'])
    expect(r.readings().muse?.attempt).toMatchObject({ found: false, hidden: true, offspace: 4 })
    const hiddenView = quotaFor('muse', ctx({ window: { muse: r.readings().muse } }))
    expect(hiddenView.why).toContain('它这会儿是藏起来的')
    expect(hiddenView.why).not.toContain('别的桌面')
    expect(hiddenView.why).not.toContain('不在你这会儿看着的桌面上')

    // 藏着连窗都读不到那一种(壳回「一扇标准窗口都没有」):照直说藏起来了,别说「没有窗口」。
    const { r: none } = reader(async () => ({
      ok: false,
      error: '找不到窗口:com.meta.endo 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)',
      app_hidden: true,
    }))
    await none.refresh(['muse'])
    expect(none.readings().muse?.attempt).toMatchObject({ found: false, error: 'no_window', hidden: true })
    const noneView = quotaFor('muse', ctx({ window: { muse: none.readings().muse } }))
    expect(noneView).toMatchObject({ state: 'unconnected', short: '没接上:Muse 藏起来了' })
    // 2026-09-30 维护者拍板全删「带我过去」:原来这句后面跟一颗「放出 Muse」的键,键旁边写着去哪一页。
    // 键没了,那句话接在「把它放出来」后面 ——「读一下」2026-09-27 就撤了,所以不再让他去点一颗不存在的键。
    expect(noneView.fix).toBeUndefined()
    expect(noneView.why).toBe('Muse 这会儿是藏起来的,藏着的窗读不到 —— 点一下它的图标把它放出来,再在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
    // 一句话里不许出现两道破折号(读起来断两次)。
    expect(noneView.why?.match(/——/g) ?? []).toHaveLength(1)
    // 没藏着、真没有窗口的那一种:话照旧。
    const { r: bare } = reader(async () => ({
      ok: false,
      error: '找不到窗口:com.meta.endo 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)',
    }))
    await bare.refresh(['muse'])
    const bareView = quotaFor('muse', ctx({ window: { muse: bare.readings().muse } }))
    expect(bareView.fix).toBeUndefined()
    expect(bareView.why).toBe('Muse 开着,但没有窗口 —— 在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
  })

  /**
   * ★ 2026-09-26(卡 MQ3):**藏着的家也要读得到额度。**
   *
   * 维护者 18:50 看到 Muse、Manus 都成了「没接上」+ 两颗键,点「读一下」什么都不变 —— 可 Manus
   * 之前明明读到过 2,690 积分。根子是:藏它的手正是工作台自己的窗口槽(「遮罩一收就藏回去」),
   * 而藏着的 App 辅助功能一扇窗都列不出。所以这一下由**壳**消化:读之前 `unhide()`(不 activate、
   * 不抢焦点)、等一拍让 AX 清单跟上、读完照原样藏回去(`TextInsert.readTexts`;节奏与取舍那几条
   * 纯函数在壳 `SendTextPolicy.worthAnotherUnhideLook` / `shouldRehide`,壳的单测里钉着)。
   * 服务端这一侧因此只会收到下面这两种回包。
   */
  it('★藏着的那一家:壳放出来读到了 → 那一格当场是数,「藏起来了」这句话不再出现(2026-09-26 卡 MQ3)', async () => {
    // 新壳的回包:`app_hidden: false`(已经放出来了,所以这会儿不藏着)+ `app_unhidden: true`
    // (诊断记号:本来藏着、工作台为了这一眼放出来又藏回去了)+「使用情况」页上那两行。
    const { r } = reader(async () => ({
      ok: true,
      result: {
        windows: [{ index: 0, w: 1640, h: 945 }],
        matches: [
          { id: 'page', text: '使用情况', x: 400, y: 120, window: 0 },
          { id: 'used', text: '3% used', x: 400, y: 220, window: 0 },
        ],
        app_hidden: false,
        app_unhidden: true,
        os_windows: 4,
      },
    }))
    await r.refresh(['muse'])
    expect(r.readings().muse?.attempt).toMatchObject({ found: true })
    // 藏着那一笔压根没进 attempt —— 壳已经把它消化掉了,服务端没有话要多说。
    expect(r.readings().muse?.attempt?.hidden).toBeUndefined()
    const view = quotaFor('muse', ctx({ window: { muse: r.readings().muse } }))
    expect(view).toMatchObject({ state: 'numbers', left_pct: 97, line: '还剩约 97%' })
    expect(JSON.stringify(view)).not.toContain('藏')
  })

  it('★放出来了仍读不到:只说那两句(不在那一页 / 在别的桌面),不再说「藏起来了」(2026-09-26 卡 MQ3)', async () => {
    // 放出来只是把它放回它原来那个桌面 —— 窗真在别的桌面上、或者他真没打开那一页,照旧读不到。
    // 这时候该说的还是卡 MQ / MQ2 那两句真话;「藏起来了」这一句由机制消化了,不该再冒出来。
    const { r } = reader(async () => ({
      ok: true,
      result: { matches: [], windows: [{ index: 0, w: 1640, h: 945 }], app_hidden: false, app_unhidden: true, os_windows: 4, offspace_windows: 2 },
    }))
    await r.refresh(['muse'])
    expect(r.readings().muse?.attempt).toMatchObject({ found: false, offspace: 2 })
    expect(r.readings().muse?.attempt?.hidden).toBeUndefined()
    const view = quotaFor('muse', ctx({ window: { muse: r.readings().muse } }))
    expect(view.why).toMatch(/^\d\d:\d\d 读过 Muse 的窗口,这会儿不在「使用情况」页上/)
    expect(view.why).toContain('另有 2 扇窗不在你这会儿看着的桌面上')
    expect(view.why).not.toContain('藏')
  })

  it('壳回的错误话 → 哪一种没读成', async () => {
    expect(readErrorOf('未知 op:read_texts')).toBe('old_shell')
    expect(readErrorOf('找不到窗口:im.manus.desktop 没在运行')).toBe('not_running')
    expect(readErrorOf('找不到窗口:com.meta.endo 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)')).toBe('no_window')
    /*
      * ★ 卡 QD(2026-09-26 真机):壳这一句说的是**那个 App** 的通道没开(Chromium 那几家刚起来时),
      * 不是「工作台没被授权」。原来两种都报 `no_ax` —— 那一格就会写「工作台 App 还没有辅助功能权限」
      * (假话,还把他领到系统设置里白点一遍),而且 `no_ax` 打着 `no_stale`,连上次真读到的数都被压掉。
      */
    expect(readErrorOf('辅助功能通道关着:com.bot.pc.doubao 回 -25204(kAXErrorAPIDisabled = -25211,Chromium 系要先写 AXManualAccessibility 唤醒)')).toBe('app_asleep')
    expect(readErrorOf('辅助功能未授权')).toBe('no_ax')
    expect(readErrorOf('怪事')).toBe('failed')
    const { r } = reader(async () => { throw new Error('壳没回话(超时)') })
    await r.refresh(['manus'])
    expect(r.readings().manus?.attempt).toMatchObject({ found: false, error: 'failed' })
    expect(r.readings().muse).toBeUndefined()
  })

  /**
   * ★ 卡 QD(2026-09-26,真机撞出来的):Chromium 那几家(豆包办公 / Manus / Grok Bot / Antigravity)
   * **敲了门树也不是当场就好** —— 第一下回「辅助功能通道关着…-25204」,等一拍再看一眼就全读到了
   * (实测豆包办公:3017ms 失败 → 704ms 成功)。不重这一下,它凉着的时候永远读不到。
   */
  it('★那个 App 的通道这会儿没开 → 等一拍再看一眼;别的没读成不重试', async () => {
    const asleep = '辅助功能通道关着:com.bot.pc.doubao 回 -25204(kAXErrorAPIDisabled = -25211,Chromium 系要先写 AXManualAccessibility 唤醒)'
    let tries = 0
    const { r, calls, waits } = reader(async (req) => {
      if (req.op !== 'read_texts' || req.bundle_id !== 'com.bot.pc.doubao') return { ok: true, result: { matches: [] } }
      tries += 1
      if (tries === 1) return { ok: false, error: asleep }
      return { ok: true, result: { matches: [
        { id: 'page', text: '订阅与额度管理', x: 552, y: 203 },
        { id: 'window_5h', text: '当前时段', x: 560, y: 378 },
        { id: 'used', text: '已用 <1%', x: 1020, y: 378 },
      ] } }
    })
    await r.refresh(['doubao'])
    expect(calls.filter(one => (one as { bundle_id?: string }).bundle_id === 'com.bot.pc.doubao')).toHaveLength(2)
    expect(waits).toEqual([900])
    expect(r.readings().doubao?.attempt?.found).toBe(true)
    expect(quotaFor('doubao', ctx({ window: { doubao: r.readings().doubao } }))).toMatchObject({ state: 'numbers', left_pct: 99 })

    // 两下都没醒 → 照实说「这次没读成」,**不说「工作台还没有辅助功能权限」**(那是假话),也不打 no_stale。
    // (上一段刚读到过,记忆里存着那个数 —— 要看「从没读到过」那一句,先清零,卡 QS。)
    forgetQuotaMemory('doubao')
    const { r: still, calls: again } = reader(async () => ({ ok: false, error: asleep }))
    await still.refresh(['doubao'])
    expect(again).toHaveLength(2)
    const view = quotaFor('doubao', ctx({ window: { doubao: still.readings().doubao } }))
    expect(view).toMatchObject({ state: 'unconnected', short: '没接上:这次没读成' })
    // 2026-09-30 维护者拍板全删「带我过去」:这一支原来也挂着那颗键,键旁边写着去哪一页;
    // 键没了,那句话并进这一行(「读一下」2026-09-27 就撤了,所以改成说「过一会儿它自己再读一次」)。
    expect(view.fix).toBeUndefined()
    // 后半句跟着上面那一条一起改了(2026-10-04 卡「豆包台前点一下」):她不用自己去豆包里点了。
    expect(view.why).toBe('豆包办公这会儿还没让工作台读它窗口上的字(它刚起来时会这样,过一会儿它自己再读一次) —— 点一下「读一下」,工作台会闪一下豆包办公、替你点开「订阅与额度管理」那一页再读,读完立刻把台前与窗口都还原')
    expect(view.no_stale).toBeUndefined()

    // 没开着那一种重了也是白重:只问一次。
    const { r: off, calls: once } = reader(async () => ({ ok: false, error: '找不到窗口:com.bot.pc.doubao 没在运行' }))
    await off.refresh(['doubao'])
    expect(once).toHaveLength(1)
  })

  it('pump 节流:缺省 10 分钟内只读一轮', async () => {
    const { r, calls, tick } = reader(async () => ({ ok: true, result: { matches: [] } }))
    // 一轮 = 要从窗口上读的每一家各问一次(这张表会长,所以按它的大小算,不写死个数)。
    const round = windowQuotaSpecs().size
    r.pump()
    await new Promise(resolve => setTimeout(resolve, 10))
    const first = calls.length
    expect(first).toBe(round)
    r.pump()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls.length).toBe(first)
    tick(10 * 60_000 + 1)
    r.pump()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls.length).toBe(first + round)
  })
})

/**
 * 「读一下」按完说的那一句(2026-09-26,卡 MQ3)。
 *
 * 原来界面写死「读过了,这一格会跟着变」—— 与真实结果无关的一句话。维护者点 Muse / Manus 的
 * 「读一下」看到的正是它,而那一格一个字没变,他只能以为界面坏了。现在这句话**取自回包里那一格**。
 */
describe('quotaCheckSaid:那颗键底下说真话', () => {
  it('★读到了 → 说读到了什么(那一格此刻的话)', () => {
    expect(quotaCheckSaid({ id: 'muse', title: 'Muse', state: 'numbers', line: '还剩约 97%', left_pct: 97 }, true))
      .toBe('读到了:还剩约 97%')
    expect(quotaCheckSaid({ id: 'doubao', title: '豆包办公', state: 'unlimited', line: '不限' }, true))
      .toBe('读到了:不限')
  })

  it('★读了、没读到:说清差哪一步(「没接上:」那四个字不重复说一遍)', () => {
    expect(quotaCheckSaid({
      id: 'muse', title: 'Muse', state: 'unconnected',
      line: '没接上:19:05 读过 Muse 的窗口,这会儿不在「使用情况」页上', short: '没接上:不在「使用情况」页上',
      why: '19:05 读过 Muse 的窗口,这会儿不在「使用情况」页上',
    }, false)).toBe('读了,不在「使用情况」页上')
    // 开集那几家(卡 QO):那一页上没有用量,这也是句真话。
    expect(quotaCheckSaid({
      id: 'com.anysphere.sand', title: 'Grok Bot', state: 'unconnected',
      line: '没接上:19:05 读过 Grok Bot 的窗口,这页上没看见用量', short: '没接上:这页上没看见用量',
    }, false)).toBe('读了,这页上没看见用量')
  })

  it('★这一轮没读到、那一格还摆着上次那个数(卡 QS):不许说成「读到了」', () => {
    // 读不到时上次那个数照摆着(卡 QS 的口径)—— 拿「那一格有数」当读到了就又是一句假话(D13)。
    expect(quotaCheckSaid({ id: 'manus', title: 'Manus', state: 'numbers', line: '剩 2,690 积分' }, false))
      .toBe('读了,没读到新的;这一格还是上次那个数(剩 2,690 积分)')
  })

  it('面板上压根没有这一格:只说做过了,不编结果', () => {
    expect(quotaCheckSaid(undefined, false)).toBe('读过了')
    expect(quotaCheckSaid(undefined, true)).toBe('读过了')
  })
})
