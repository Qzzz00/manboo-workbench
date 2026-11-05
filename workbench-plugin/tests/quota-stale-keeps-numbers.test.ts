/**
 * **读到过的数不因为一会儿没刷新就翻成「没接上」**(2026-09-26,卡 QS)。
 *
 * 维护者早上的原话:「Claude 的额度怎么突然显示为未接入了」。那天 Claude 桌面端从昨夜 20:42 起没再报用量
 * (它没在跑),额度那一格就从「本周还剩 69%」翻成了「没接上」;记录一刷新又回来了。
 * 按第一次用的人看,「没接上」= **从没接上** —— 又吓人又不对,20:42 那个数是真读到过的。
 *
 * ★ **2026-10-02(卡 QA)把第 1 条的后半截收紧了。** 维护者 21:3x:「本机上的 Claude 额度,
 * 一晚上了,还是 100%」—— 标灰不够:她看见的还是一个百分比,还是把它当此刻的用量。那个 100% 是桌面端
 * **04:27** 落的样本(`{fh:0, sd:18}`,5 小时窗口刚重置)算出来的,而她整晚都在用 Claude。
 * 所以那条线从 6 小时收到 **2 小时**,过线**连百分比都不出**,只说「读不到最新的,上次 04:27」。
 * 「仍然有数、不翻成没接上」这一条**没变**(那仍是卡 QS 的结论)。
 *
 * 这一份钉住三格的新判法(各家一致,都在 `server/agentQuota.ts` 的 `quotaFor` 一处):
 * 1. 先读到数、再读不到 → **仍然有数**(`state:'numbers'`,一个「没接上」的字都不出现):
 *    一刻钟以内不写时刻;一刻钟到 2 小时写「… · 截至 21:00」;过 2 小时只说「读不到最新的,上次 04:27」
 *    (百分比不出、标灰);
 * 2. **从没读到过** → 「没接上:原因」;
 * 3. **来源确实断了**(没装、钩子没装、凭据清空了、要先授权)→ 「没接上:原因」,上次那个数不许顶上来;
 * 4. 界面上不出现「过期」「记录」这类内部词;
 * 5. 派活确认那一行(`balanceFromQuota`)与额度区是同一套措辞。
 *
 * 时刻一律用**本地时间**构造(不写 ISO 串):这一层要把时刻说成人话,写死 UTC 串会让用例在别的时区变红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientsView, QuotaEntry } from '../src/protocol.ts'
import { QUOTA_AS_OF_STALE_AFTER_MS, claudeDesktopGoneNote } from '../src/protocol.ts'
import { CLAUDE_STALE_WHY } from '../src/quota/liveSources.ts'
import type { QuotaAdapterContext, WindowQuotaReading } from '../src/server/agentQuota.ts'
import {
  QUOTA_DATED_AFTER_MS, QUOTA_STALE_AFTER_MS, balanceFromQuota, forgetQuotaMemory, quotaFor, readWhen,
} from '../src/server/agentQuota.ts'

/** 今天中午 12:00(本地)。 */
const NOW = new Date(2026, 8, 26, 12, 0, 0)
/** 昨夜 20:42(本地)= 15 小时 18 分钟前,过了 6 小时那条线。 */
const LAST_NIGHT = new Date(2026, 8, 25, 20, 42, 0)
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)

const ON = { installed: true, connected: true }
const OFF = { installed: false, connected: false }
function clients(over: Partial<ClientsView> = {}): ClientsView {
  return { claude: ON, codex: ON, kimi: ON, wechat: OFF, wecom: OFF, ...over }
}

/**
 * Claude 桌面端报上来的那一格(本周还剩 69%)。
 *
 * 2026-10-02(卡 QK):那半句「Claude 桌面没在跑」从**服务端一张按家名写死的表**
 * (原 `STALE_HINTS`)改成**各家额度来源自己声明、跟着 entry 过来**(`quota/liveSources.ts`
 * 声明、`quota/collect.ts` 每轮现盖)。所以这里的 entry 要带上那一份 ——
 * 不带的 entry 现在就该一句都不多说(那正是「没声明的那几家只剩『上次 HH:MM』」那一条)。
 */
const WEEK_69: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '周', left_pct: 69 }],
  stale_hint: { why: CLAUDE_STALE_WHY },
}
/**
 * 这一轮没取到(采集层原话:桌面端没再提供用量记录)。**不是**「没接上」。
 * ★ 2026-10-03:那句话改由 `protocol.ts` 的 `claudeDesktopGoneNote` 拼,这里跟着读常量。
 */
const MISSED: QuotaEntry = { kind: 'unknown', note: claudeDesktopGoneNote(918 * 60_000) }

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, clients: clients(), now: NOW, ...patch }
}

/** 先在 `at` 那一刻读到 69%,再在 `now` 这一刻读不到 —— 撞出维护者早上看到的那一幕。 */
function claudeAfterMiss(at: Date, now = NOW) {
  quotaFor('claude', ctx({ quota: { claude: WEEK_69 }, now: at }))
  return quotaFor('claude', ctx({ quota: { claude: MISSED }, now }))
}

beforeEach(() => { forgetQuotaMemory() })

describe('读到过的数:照显示,带上几点读到的', () => {
  it('★昨夜 20:42 读到 69%、今天中午读不到 → 仍是「有数」,但**不出百分比**:「读不到最新的,上次昨晚 20:42 · Claude 桌面没在跑」(卡 QA)', () => {
    const view = claudeAfterMiss(LAST_NIGHT)
    expect(view.state).toBe('numbers')
    expect(view.line).toBe(`读不到最新的,上次昨晚 20:42 · ${CLAUDE_STALE_WHY}`)
    expect(view.short).toBe('读不到最新的,上次昨晚 20:42')
    expect(view.stale).toBe(true)
    expect(view.read_at).toBe(LAST_NIGHT.toISOString())
    // 过线那一档一个百分比都不许留下 —— 留一个,手机那一行、展示台那条横条就又把它画出来了。
    expect(view.left_pct).toBeUndefined()
    expect(view.level).toBeUndefined()
    // 一个「没接上」的字都不许出现 —— 那是「从没接上」的说法。
    expect(view.line).not.toContain('没接上')
    expect(view.why).toBeUndefined()
  })

  it('★线以内(一刻钟到 2 小时):照说那个数 + 「截至 HH:MM」,**不标灰**', () => {
    const view = claudeAfterMiss(ago(90 * 60 * 1000))
    expect(view.state).toBe('numbers')
    expect(view.left_pct).toBe(69)
    expect(view.stale).toBeUndefined()
    expect(view.line).toMatch(/^本周还剩约 69% · 截至 \d{2}:\d{2}$/)
    expect(view.line).not.toContain('读不到最新的')
  })

  it('刚读到的数不写时刻(一刻钟以内):那是噪音 —— 界面上就是「本周还剩约 69%」', () => {
    const fresh = quotaFor('claude', ctx({ quota: { claude: WEEK_69 } }))
    expect(fresh.line).toBe('本周还剩约 69%')
    expect(fresh.read_at).toBe(NOW.toISOString())
    // 刚读到就读不到了(一分钟以后那一轮):话也不变,只是这个数已经是「上次那个」。
    const missed = quotaFor('claude', ctx({ quota: { claude: MISSED }, now: new Date(NOW.getTime() + 60_000) }))
    expect(missed).toMatchObject({ state: 'numbers', left_pct: 69, line: '本周还剩约 69%' })
  })

  it('数没变就不把时刻往后推(否则界面永远写「刚读到的」,那个数其实几小时没动过)', () => {
    quotaFor('claude', ctx({ quota: { claude: WEEK_69 }, now: LAST_NIGHT }))
    // 中间每一轮都还取到同一个数(桌面端没落新样本,窗口值一模一样)。
    quotaFor('claude', ctx({ quota: { claude: WEEK_69 }, now: ago(7 * 60 * 60 * 1000) }))
    const view = quotaFor('claude', ctx({ quota: { claude: WEEK_69 } }))
    expect(view.read_at).toBe(LAST_NIGHT.toISOString())
    expect(view.line).toContain('上次昨晚 20:42')
    expect(view.stale).toBe(true)
    // 真的变了一个数 → 时刻跟着换成这一刻,灰也去掉。
    const changed = quotaFor('claude', ctx({ quota: { claude: { kind: 'quota', windows: [{ label: '周', left_pct: 68 }] } } }))
    expect(changed).toMatchObject({ state: 'numbers', left_pct: 68, line: '本周还剩约 68%' })
    expect(changed.stale).toBeUndefined()
  })

  it('派活确认那一行与手机上是同一套措辞(short 原样给过去),并带着标灰那面旗子', () => {
    const view = claudeAfterMiss(LAST_NIGHT)
    // 卡 QA:过线那一档没有百分比,所以 `level` 是 `unknown`(读不到 ≠ 额度充足),括号里仍留着时刻。
    expect(balanceFromQuota(view)).toEqual({
      level: 'unknown', text: '读不到最新的,上次昨晚 20:42', state: 'numbers', stale: true,
    })
  })

  it('★界面上一个内部词都没有(不出现「过期」「记录」「样本」)', () => {
    const view = claudeAfterMiss(LAST_NIGHT)
    for (const word of ['过期', '记录', '样本', 'unknown', 'stale']) {
      expect(`${view.line}${view.short ?? ''}${view.why ?? ''}`).not.toContain(word)
    }
  })

  it('那两条线就是 2 小时与一刻钟(卡 QA 把 6 小时收到 2 小时;改了就得改说法,所以钉住)', () => {
    expect(QUOTA_STALE_AFTER_MS).toBe(2 * 60 * 60 * 1000)
    expect(QUOTA_STALE_AFTER_MS).toBe(QUOTA_AS_OF_STALE_AFTER_MS)
    expect(QUOTA_DATED_AFTER_MS).toBe(15 * 60 * 1000)
  })
})

describe('「没接上」只剩两种', () => {
  it('★从没读到过 → 没接上,照实说原因(这一格本来就该这么写)', () => {
    const view = quotaFor('claude', ctx({ quota: { claude: MISSED } }))
    expect(view).toMatchObject({ state: 'unconnected', line: '没接上:这次没取到', why: '这次没取到' })
    // 采集层那句原话(带分钟数)不往界面上搬 —— 它是内部话,而且他要的是「数字可能旧」那个意思。
    expect(view.line).not.toContain('918')
  })

  it('★来源确实断了:没装 / 钩子没装 / 凭据清空了 / 要先授权 —— 上次那个数一律不顶上来', () => {
    // 先让每一家都读到过一个数。
    quotaFor('claude', ctx({ quota: { claude: WEEK_69 }, now: LAST_NIGHT }))
    quotaFor('dsh', ctx({ quota: { dsh: { kind: 'balance', currency: 'CNY', total: '2.26', available: true } }, now: LAST_NIGHT }))
    const read: WindowQuotaReading = {
      last: { at: LAST_NIGHT.toISOString(), width: 1200, matches: [{ id: 'credits', text: '1,234', x: 1100, y: 20 }] },
      attempt: { at: LAST_NIGHT.toISOString(), found: true },
    }
    quotaFor('manus', ctx({ window: { manus: read }, now: LAST_NIGHT }))

    // ① Claude 没装在这台电脑上。
    const gone = quotaFor('claude', ctx({ quota: { claude: MISSED }, clients: clients({ claude: OFF }) }))
    expect(gone).toMatchObject({ state: 'unconnected', line: '没接上:Claude 没装在这台电脑上' })
    // ② 装了但钩子没装(工作台还没接上它的额度)。
    const noHook = quotaFor('claude', ctx({ quota: { claude: MISSED }, clients: clients({ claude: { installed: true, connected: false } }) }))
    expect(noHook).toMatchObject({ state: 'unconnected', short: '没接上:点一次「全部接上」', fix: { kind: 'unlock' } })
    // ③ DeepSeek:凭据清空 / 换了来源(取数层打了 no_stale 那面旗子)。
    const cleared = quotaFor('dsh', ctx({ quota: { dsh: { kind: 'unknown', no_stale: true } } }))
    expect(cleared).toMatchObject({ state: 'unconnected', why: '没走工作台的服务,也没填 DeepSeek Key' })
    // ④ 读窗口那几家:要先授权辅助功能 / 要新版工作台 App —— 这台机器这会儿根本没有读它的本事。
    const needsAx = quotaFor('manus', ctx({ window: { manus: { ...read, attempt: { at: NOW.toISOString(), found: false, error: 'no_ax' } } } }))
    expect(needsAx).toMatchObject({ state: 'unconnected', fix: { kind: 'grant_ax' } })
    const oldShell = quotaFor('manus', ctx({ window: { manus: { ...read, attempt: { at: NOW.toISOString(), found: false, error: 'old_shell' } } } }))
    expect(oldShell).toMatchObject({ state: 'unconnected', fix: { kind: 'update_shell' } })
    for (const view of [gone, noHook, cleared, needsAx, oldShell]) {
      expect(view.state).toBe('unconnected')
      expect(view.line).not.toContain('%')
      expect(view.line).not.toContain('积分')
    }
  })

  it('认不出的那一家(运行时新接上的)照旧:「没接上:还没找到这家的额度来源」', () => {
    expect(quotaFor('perplexity', ctx())).toMatchObject({ state: 'unconnected', why: '还没找到这家的额度来源' })
  })
})

describe('从窗口上读的那几家(Manus / Muse):同一套判法', () => {
  const read = (at: Date): WindowQuotaReading => ({
    last: { at: at.toISOString(), width: 1200, matches: [{ id: 'credits', text: '1,234', x: 1100, y: 20 }] },
    attempt: { at: at.toISOString(), found: true },
  })

  // ★ 2026-09-30 维护者拍板全删「带我过去」(见 `docs/决策记录.md` 末尾那一条):
  // 原来这一行在数旁边还挂一颗「打开 Manus」。那颗键与「带我过去」「放出 X」是同一种,一并删了 ——
  // 有数的那一行只摆那个数(几点读到的、老没老照写),该他去打开哪一页那句话留在**真读不到**的那一格里。
  it('★不在首页了(读不到新的)→ 顶上上次那个积分,带时刻;行上一颗键都没有(2026-09-30 维护者拍板全删)', () => {
    quotaFor('manus', ctx({ window: { manus: read(LAST_NIGHT) } }))
    const view = quotaFor('manus', ctx({
      window: { manus: { ...read(LAST_NIGHT), attempt: { at: NOW.toISOString(), found: false, error: 'not_running' } } },
    }))
    expect(view.state).toBe('numbers')
    // 卡 QA:过线(2 小时)就不出积分数了,只说「读不到最新的,上次昨晚 20:42」。
    // Manus 没有「为什么读不到」那半句 —— 不替哪一家编一个原因(D13)。
    expect(view.line).toBe('读不到最新的,上次昨晚 20:42')
    expect(view.left).toBeUndefined()
    expect(view.stale).toBe(true)
    expect(view.fix).toBeUndefined()
  })

  it('Muse 那一页上读到「无限制」= 不限:不写时刻、不标灰(官方的说法不会因为读不到新的就变味)', () => {
    const page: WindowQuotaReading = {
      last: { at: LAST_NIGHT.toISOString(), matches: [{ id: 'page', text: '使用情况', x: 0, y: 0 }, { id: 'unlimited', text: '无限制', x: 0, y: 0 }] },
      attempt: { at: LAST_NIGHT.toISOString(), found: true },
    }
    expect(quotaFor('muse', ctx({ window: { muse: page } }))).toMatchObject({ state: 'unlimited', line: '不限' })
    // 之后读不到了:还是「不限」,不掉成「没接上」、也不加那句「数字可能旧」。
    const later = quotaFor('muse', ctx({ window: { muse: { ...page, attempt: { at: NOW.toISOString(), found: false } } } }))
    expect(later).toMatchObject({ state: 'unlimited', line: '不限' })
    expect(later.stale).toBeUndefined()
  })
})

describe('「几点读到的」说成人话', () => {
  it('今天只写几点;昨天傍晚以后写「昨晚」,白天写「昨天」;更早写日期', () => {
    expect(readWhen(new Date(2026, 8, 26, 9, 5).toISOString(), NOW)).toBe('09:05')
    expect(readWhen(new Date(2026, 8, 25, 20, 42).toISOString(), NOW)).toBe('昨晚 20:42')
    expect(readWhen(new Date(2026, 8, 25, 9, 15).toISOString(), NOW)).toBe('昨天 09:15')
    expect(readWhen(new Date(2026, 8, 24, 20, 0).toISOString(), NOW)).toBe('09-24 20:00')
  })

  it('认不出的时刻不写(宁可少一句,也不糊一个 ISO 串、不编一个时刻)', () => {
    expect(readWhen('哪天', NOW)).toBeUndefined()
  })
})

/**
 * **读到了的那一行不再挂着两颗催他的键**(2026-09-26 晚,卡 QG 第 4 条)。
 *
 * 维护者 22:40 原话:「额度那里我还有点问题,muse 和豆包办公都已经取到了,为什么还有『带我过去』和
 * 『读一下』这两个按钮啊?」—— 真机上 Muse 21:52 读到 97%、豆包办公 21:52 读到 5h/周两条,
 * 之后每 10 分钟那一轮都读不成(他把那一页切走了,窗口上就没有额度那几格了),
 * 于是 `windowQuota` 把「这一轮没读成」的修法挂了上去:数是好的,键却在催他再去一趟。
 *
 * ★ **2026-09-30 维护者拍板全删**(见 `docs/决策记录.md` 末尾那一条):卡 QG 那一版是把这几颗键
 * 「收进『▸ 说明』里」(`fix.quiet`),现在连那一步都不留 —— 「带我过去」「打开 X」「放出 X」
 * 是同一种键,整套删掉。所以这一组钉的变成了**更硬的一条**:
 * - **读到过数的那一行** → 一颗键都没有(不管新旧,`fix` 一律缺席),旧了只在字里说「几点读到的 · 数字可能旧」;
 * - **压根没读到过** → 也没有键,该他自己去打开哪一页那句人话写在行上那一句里(`line` / `why`)。
 *
 * 手机那一侧本来就一颗键都不画(`butler-app` 的 `quotaWords` 只吐那一句 `line`),
 * 全删之后两端彻底对上:两边看到的就是同一句话。
 */
describe('已经读到数的那一行不挂任何键(卡 QG → 2026-09-30 维护者拍板全删)', () => {
  /** Muse:先在 `at` 那一刻读到「3% used」,再在现在这一刻读不成(那一页切走了)。 */
  function museAfterMiss(at: Date) {
    const page: WindowQuotaReading = {
      last: {
        at: at.toISOString(),
        matches: [
          { id: 'page', text: '使用情况', x: 249, y: 151 },
          { id: 'plan', text: 'Free plan', x: 267, y: 195 },
          { id: 'used', text: '3% used', x: 1541, y: 195 },
        ],
        width: 1640,
      },
      attempt: { at: NOW.toISOString(), found: false },
    }
    return quotaFor('muse', ctx({ window: { muse: page } }))
  }

  it('★真机那一幕:21:52 读到 97%、这会儿读不成 → 数照给,行上一颗键都没有(2026-09-30 维护者拍板全删)', () => {
    const view = museAfterMiss(ago(48 * 60 * 1000))
    expect(view).toMatchObject({ state: 'numbers', left_pct: 97 })
    expect(view.stale).toBeUndefined()
    // 卡 QG 那一版把键打上 `quiet` 收进「▸ 说明」;2026-09-30 起那颗键本身就没有了。
    expect(view.fix).toBeUndefined()
  })

  /**
   * 2026-09-27 12:00 改(维护者对着截图:「这几个按钮可还没解决喔」—— Muse / 豆包办公那两行是昨晚 21:52 读到的,
   * 过了 6 小时那条线又把那两颗键挂回了行上)。**读到过数,那一行就不挂键**:旧了只在字里说
   * 「几点读到的 · 数字可能旧」、标灰。
   *
   * ★ 2026-09-30 维护者拍板全删之后连「压根没读到过」那一格也不挂键了(下一条),
   * 所以这一条钉的只剩「旧了也照样不挂」。
   */
  it('★数旧了(过了那条线)→ 不出百分比、标灰,行上照样一颗键都没有(2026-09-30 维护者拍板全删)', () => {
    const view = museAfterMiss(ago(QUOTA_STALE_AFTER_MS + 60_000))
    expect(view).toMatchObject({ state: 'numbers', stale: true })
    // 卡 QA:过线那一档说「读不到最新的,上次 …」,百分比不出(原来是「… · 数字可能旧」照说那个数)。
    expect(view.line).toContain('读不到最新的,上次')
    expect(view.left_pct).toBeUndefined()
    expect(view.fix).toBeUndefined()
  })

  it('★压根没读到过 → 也不挂键,该他去打开哪一页那句话写在行上(2026-09-30 维护者拍板全删)', () => {
    const never = quotaFor('muse', ctx({ window: { muse: { attempt: { at: NOW.toISOString(), found: false } } } }))
    expect(never.state).toBe('unconnected')
    expect(never.fix).toBeUndefined()
    // 原来这句人话写在「带我过去」旁边(`fix.hint`),现在就在他眼前那一行里。
    expect(never.why).toContain('在 Muse 的设置里打开「使用情况」,那扇窗留在你这会儿看着的桌面上,工作台看一眼就记下')
  })
})
