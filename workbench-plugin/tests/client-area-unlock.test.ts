/**
 * 每个区域单独解锁 —— 取数那一半(纯函数)。
 *
 * 守的是 Ben 那句话拆出来的三条:没装的不显示、装了没接上给一步、接上了才给数字;
 * 外加一条贯穿全文件的:`clients` 缺席时一切照旧。
 */
import { describe, expect, it } from 'vitest'
import type { ClientsView, QuotaEntry } from '../src/protocol.ts'
import { quotaCells } from '../src/client/quotaCells.ts'
import {
  DEEPSEEK_UNLOCK_HOW_NO_RELAY, deepseekProgress, quotaAreas, relayCell, unlockButtonLabel, unlockProgress, unlockTarget,
} from '../src/client/areaUnlock.ts'

const NOW = new Date('2026-09-17T10:30:00+08:00')
const BALANCE: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true, today_spent: '3.21' }
const WINDOWS: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '周', left_pct: 62, reset_at: '2026-09-20T03:33:00Z' }],
}

const OFF = { installed: false, connected: false }
const ON = { installed: true, connected: true }
function locked(how: string) { return { installed: true, connected: false, how } }

function view(over: Partial<ClientsView> = {}): ClientsView {
  return { claude: OFF, codex: OFF, kimi: OFF, wechat: OFF, wecom: OFF, ...over }
}

const QUOTA = { dsh: BALANCE, claude: WINDOWS, codex: WINDOWS, kimi: WINDOWS }

function cells() { return quotaCells(QUOTA, {}, NOW) }

describe('quotaAreas:三态各画成什么', () => {
  it('★clients 缺席(还没扫过)→ 四格全画,跟这一版之前一模一样', () => {
    const areas = quotaAreas(cells(), undefined, QUOTA)
    expect(areas.map(a => a.agent)).toEqual(['dsh', 'claude', 'codex', 'kimi'])
    expect(areas.every(a => a.kind === 'quota')).toBe(true)
  })

  it('★没装的那家整格不出现 —— 不是一格空的,是不存在', () => {
    const areas = quotaAreas(cells(), view({ claude: ON }), QUOTA)
    expect(areas.map(a => a.agent)).toEqual(['dsh', 'claude'])
    // 没装的 Kimi / Codex 连"未接入"三个字都不该露面。
    expect(areas.find(a => a.agent === 'kimi')).toBeUndefined()
  })

  it('装了没接上 → 一张解锁卡:名字 + 那句 how', () => {
    const areas = quotaAreas(cells(), view({ kimi: locked('去设置 → 额度凭据,点「登录 Kimi」') }), QUOTA)
    const kimi = areas.find(a => a.agent === 'kimi')
    expect(kimi?.kind).toBe('unlock')
    expect(kimi).toMatchObject({ kind: 'unlock', client: 'kimi', name: 'Kimi', how: '去设置 → 额度凭据,点「登录 Kimi」' })
  })

  it('接上了才给数字', () => {
    const areas = quotaAreas(cells(), view({ kimi: ON }), QUOTA)
    const kimi = areas.find(a => a.agent === 'kimi')
    expect(kimi?.kind).toBe('quota')
    expect(kimi?.kind === 'quota' ? kimi.cell.value : '').toBe('62%')
  })

  it('★DeepSeek 那格永远在:它没有桌面客户端,不该跟着别家一起消失', () => {
    const areas = quotaAreas(cells(), view(), QUOTA) // 五家全没装
    expect(areas.map(a => a.agent)).toEqual(['dsh'])
  })

  it('服务端漏了 how 时也不留一张空白卡(给一句最保守的通用话)', () => {
    const areas = quotaAreas(cells(), view({ codex: { installed: true, connected: false } }), QUOTA)
    const codex = areas.find(a => a.agent === 'codex')
    expect(codex?.kind === 'unlock' ? codex.how : '').not.toBe('')
  })
})

describe('model.json 的 mode(DeepSeek 那一格)', () => {
  /**
   * 2026-09-18 换了取数那一头(「凭据清空后还显示 ¥2.26」那张卡):中转用量由服务端直接
   * 给成一条 `{ label:'今日' }` 的窗口,不再拿官方账户的 `today_spent` 冒充。
   */
  it('relay:换成「工作台提供的服务 · 今日用量」,画的是中转那条今日,不是账号余额', () => {
    const relay: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] }
    const areas = quotaAreas(quotaCells({ dsh: relay }, {}, NOW), undefined, { dsh: relay }, 'relay')
    const dsh = areas[0]
    expect(dsh?.kind === 'quota' ? dsh.cell.note : '').toBe('工作台提供的服务 · 今日用量')
    expect(dsh?.kind === 'quota' ? dsh.cell.value : '').toBe('62%')
    // 今日用量**有分母**(今日上限),所以照别家那样画条;余额那条"没分母不画条"的老纪律
    // 只管余额型。
    expect(dsh?.kind === 'quota' ? dsh.cell.showBar : false).toBe(true)
  })

  it('★relay 下服务端还给着一条账号余额(切换那一瞬)→ 一分钱都不许画出来', () => {
    const areas = quotaAreas(cells(), undefined, QUOTA, 'relay')
    const dsh = areas[0]
    expect(dsh?.kind === 'quota' ? dsh.cell.value : '').toBe('未接入')
    expect(dsh?.kind === 'quota' ? dsh.cell.value : '').not.toContain('¥')
  })

  it('★relay 但中转那边的计量还没接线 → 如实写"还没接上",不编一个数', () => {
    const noSpent: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true }
    const areas = quotaAreas(quotaCells({ dsh: noSpent }, {}, NOW), undefined, { dsh: noSpent }, 'relay')
    const dsh = areas[0]
    expect(dsh?.kind === 'quota' ? dsh.cell.value : '').toBe('未接入')
    expect(dsh?.kind === 'quota' ? dsh.cell.note : '').toContain('还没接上')
  })

  it('取不到用量时,服务端那句带原因的话原样显示(里头那个状态码是他去问人的凭据)', () => {
    const entry: QuotaEntry = { kind: 'unknown', note: '工作台提供的服务 · 今日用量还没接上(中转没能给出用量(HTTP 404))' }
    const areas = quotaAreas(quotaCells({ dsh: entry }, {}, NOW), undefined, { dsh: entry }, 'relay')
    const dsh = areas[0]
    expect(dsh?.kind === 'quota' ? dsh.cell.note : '').toContain('HTTP 404')
  })

  it('own / 缺席 → 按现有逻辑(账号余额照旧)', () => {
    for (const mode of ['own', undefined] as const) {
      const areas = quotaAreas(cells(), undefined, QUOTA, mode)
      const dsh = areas[0]
      expect(dsh?.kind === 'quota' ? dsh.cell.value : '').toBe('¥218.40')
    }
  })

  /**
   * 2026-09-21:没走中转、也没填 Key 那一档,从「一行字」换成和别家一样的解锁卡
   * (决策记录 09-18 留给 Ben 的第 ② 条)。三种状态各一条。
   */
  it('★own 且一把 Key 都没有 → 解锁卡,两颗按钮,推荐的在前', () => {
    const none: QuotaEntry = { kind: 'unknown', note: '还没接 DeepSeek(去设置里填自己的 API Key,或用工作台提供的服务)', no_stale: true }
    const areas = quotaAreas(quotaCells({ dsh: none }, {}, NOW), undefined, { dsh: none }, 'own')
    const dsh = areas[0]
    expect(dsh?.kind).toBe('unlock')
    expect(dsh?.kind === 'unlock' ? dsh.name : '').toBe('DeepSeek')
    // 它不是那五家桌面客户端里的任何一家 —— client 这一格该缺席,不许硬塞一个。
    expect(dsh?.kind === 'unlock' ? dsh.client : 'x').toBeUndefined()
    const actions = dsh?.kind === 'unlock' ? dsh.actions : []
    expect(actions.map(one => one.label)).toEqual(['用我们的服务(推荐)', '填自己的 Key'])
    expect(actions[0]).toMatchObject({ target: 'relay', primary: true })
    expect(actions[1]).toMatchObject({ target: 'model' })
    // 卡上一个数字都没有。
    expect(JSON.stringify(dsh)).not.toContain('%')
  })

  it('这台没接中转(/state.relay_configured === false)→ 只有「填自己的 Key」那一颗,而且它是推荐的那颗', () => {
    const none: QuotaEntry = { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true }
    const areas = quotaAreas(quotaCells({ dsh: none }, {}, NOW), undefined, { dsh: none }, 'own', false)
    const dsh = areas[0]
    expect(dsh?.kind).toBe('unlock')
    const actions = dsh?.kind === 'unlock' ? dsh.actions : []
    expect(actions).toEqual([{ label: '填自己的 Key', target: 'model', primary: true }])
    expect(dsh?.kind === 'unlock' ? dsh.how : '').toBe(DEEPSEEK_UNLOCK_HOW_NO_RELAY)
  })

  it('★own 且填了 Key(取到余额)→ 照旧是余额那一格,不是解锁卡', () => {
    const areas = quotaAreas(cells(), undefined, QUOTA, 'own')
    expect(areas[0]?.kind).toBe('quota')
    expect(areas[0]?.kind === 'quota' ? areas[0].cell.value : '').toBe('¥218.40')
  })

  it('★relay → 照旧是中转今日用量那一格,解锁卡不该冒出来', () => {
    const relay: QuotaEntry = { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] }
    const areas = quotaAreas(quotaCells({ dsh: relay }, {}, NOW), undefined, { dsh: relay }, 'relay')
    expect(areas[0]?.kind).toBe('quota')
  })

  it('★「这次没取到」不是「还没接上」:没有 no_stale 那面旗子就不换成解锁卡', () => {
    // 填了 Key,但这一轮 DeepSeek 的接口抖了一下 —— 让他再去填一次 Key 就是编(D13)。
    const flaky: QuotaEntry = { kind: 'unknown', note: '这次没取到(HTTP 503)' }
    const areas = quotaAreas(quotaCells({ dsh: flaky }, {}, NOW), undefined, { dsh: flaky }, 'own')
    expect(areas[0]?.kind).toBe('quota')
    expect(areas[0]?.kind === 'quota' ? areas[0].cell.note : '').toContain('HTTP 503')
  })

  it('★no_stale 是服务端下的确定结论:model_mode 缺席时也照它出解锁卡', () => {
    // 这面旗子只在取数层**确定**一把 Key 都没有时才打上,跟 mode 报没报过来无关。
    const none: QuotaEntry = { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true }
    const areas = quotaAreas(quotaCells({ dsh: none }, {}, NOW), undefined, { dsh: none })
    expect(areas[0]?.kind).toBe('unlock')
  })

  it('relayCell 不会把峰谷那一行弄丢(时段跟用谁的额度无关)', () => {
    const [cell] = quotaCells({ dsh: BALANCE }, {}, NOW, { phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] })
    expect(cell).toBeDefined()
    expect(relayCell(cell as NonNullable<typeof cell>, BALANCE).peak).toBe('高峰 · 12:02 转低谷')
  })
})

describe('解锁进度那一行', () => {
  it('★还没扫过 / 一家都没扫到 → 整行缺席,不占一行说废话', () => {
    expect(unlockProgress(undefined)).toBeUndefined()
    expect(unlockProgress(view())).toBeUndefined()
  })

  it('两接上一待接 → 「已接上 2 家:Claude、Kimi;Codex 装了还没接:…」', () => {
    const progress = unlockProgress(view({
      claude: ON, kimi: ON, codex: locked('把 Codex 的钩子贴进 ~/.codex/hooks.json'),
    }))
    expect(progress?.connected).toEqual(['Claude', 'Kimi'])
    expect(progress?.pending.map(row => row.name)).toEqual(['Codex'])
    expect(progress?.line).toBe('已接上 2 家:Claude、Kimi;Codex 装了还没接:把 Codex 的钩子贴进 ~/.codex/hooks.json')
  })

  it('★没装的那几家不进这句话——否则又变成"一上来全摆出来"', () => {
    const progress = unlockProgress(view({ claude: ON }))
    expect(progress?.line).toBe('已接上 1 家:Claude')
    expect(progress?.line).not.toContain('Kimi')
    expect(progress?.line).not.toContain('微信')
  })

  it('全接上了也说一句(顺带解释"为什么界面上只有这几家")', () => {
    expect(unlockProgress(view({ claude: ON, kimi: ON }))?.line).toBe('已接上 2 家:Claude、Kimi')
  })
})

/**
 * 2026-09-25(卡 fix/quota-and-slot-apps):维护者引导完看到「已接上 2 家:微信、企业微信」——
 * 有额度的三家一家都没接,原话「接微信和企业微信干嘛,这两家有额度???」。
 * 这一行从此只数有额度的那几家(Claude / Codex / Kimi,外加 DeepSeek)。
 */
describe('「已接上 N 家」只数有额度的那几家', () => {
  const PENDING = { installed: true, connected: false }

  it('★维护者那台机器的样子:三家装了没接 + 微信企微装着 → 一个「已接上」都不说,微信企微连名字都不出现', () => {
    const progress = unlockProgress(view({
      claude: { ...PENDING, how: '点一下,工作台帮你接上' },
      codex: { ...PENDING, how: '点一下,工作台帮你接上' },
      kimi: { ...PENDING, how: '要你自己登一次(账号密码工作台不经手)—— 去设置 → 额度凭据,点「登录 Kimi」' },
      // 老服务端(09-25 之前)还会把这两家报成 connected:true —— 前台照样不认。
      wechat: ON,
      wecom: ON,
    }))
    expect(progress?.connected).toEqual([])
    expect(progress?.line).not.toContain('已接上')
    expect(progress?.line).not.toMatch(/微信|企业微信/)
    // Claude、Codex 并成一句,指向那颗「全部接上」;Kimi 单独一句,说清要他自己登、登一次就好。
    expect(progress?.applyAll).toEqual(['claude', 'codex'])
    expect(progress?.line).toContain('Claude、Codex 装了还没接:点「全部接上」')
    expect(progress?.line).toContain('写完每家都能单独撤回')
    expect(progress?.line).toContain('Kimi 装了还没接:要你自己登一次')
    expect(progress?.line).not.toContain('Claude 装了还没接')
  })

  it('★只装了微信企微(有额度的一家都没装)→ 整行缺席,不拿聊天应用凑数', () => {
    expect(unlockProgress(view({ wechat: ON, wecom: ON }))).toBeUndefined()
  })

  it('只剩一家能代写(另一家接上了)→ 不并句、不出「全部接上」,照那一家自己的话说', () => {
    const progress = unlockProgress(view({ claude: ON, codex: { ...PENDING, how: '点一下,工作台帮你接上' } }))
    expect(progress?.applyAll).toEqual(['codex'])
    expect(progress?.line).toBe('已接上 1 家:Claude;Codex 装了还没接:点一下,工作台帮你接上')
  })

  it('DeepSeek 算一家:走中转 / 取到余额 = 接上了,确定没 Key = 还没接,排在最前', () => {
    expect(unlockProgress(view({ claude: ON }), { connected: true })?.line).toBe('已接上 2 家:DeepSeek、Claude')
    const line = unlockProgress(view({ claude: ON }), { connected: false })?.line ?? ''
    expect(line).toContain('已接上 1 家:Claude')
    expect(line).toContain('DeepSeek 还没接:两条路随你挑')
  })

  it('deepseekProgress:说不出来的时候就不说(还没取过数 / 这次没取到)', () => {
    const none: QuotaEntry = { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true }
    const flaky: QuotaEntry = { kind: 'unknown', note: '这次没取到(HTTP 503)' }
    expect(deepseekProgress(undefined, 'relay')).toEqual({ connected: true })
    expect(deepseekProgress(BALANCE, 'own')).toEqual({ connected: true })
    expect(deepseekProgress(none, 'own')).toEqual({ connected: false })
    expect(deepseekProgress(undefined, 'own')).toBeUndefined()
    // 网络抖一下不是"还没接上",也不是"接上了"(D13)。
    expect(deepseekProgress(flaky, 'own')).toBeUndefined()
  })
})

describe('那颗按钮把他送到哪儿', () => {
  /**
   * 2026-09-17 改:Claude / Codex 从「去初始化页看钩子」改成**代写**(Ben 拍板)。
   * 这两家原来那条路的终点是一页渲染好的 JSON,剩下的合并动作还是他自己做 ——
   * 对不懂代码的人,那一步是整条流程里唯一会卡死、而且做错不报错的地方。
   */
  it('Kimi 去设置(凭据在那儿),Claude / Codex 走代写(工作台替他写)', () => {
    expect(unlockTarget('kimi')).toBe('settings')
    expect(unlockTarget('claude')).toBe('apply')
    expect(unlockTarget('codex')).toBe('apply')
    expect(unlockButtonLabel('kimi')).toBe('去设置里接上')
    expect(unlockButtonLabel('claude')).toBe('点一下,工作台帮你接上')
    expect(unlockButtonLabel('codex')).toBe('点一下,工作台帮你接上')
  })

  it('★按钮上一个技术词都没有(面向不懂代码的人:没有 hook、没有 JSON、没有路径)', () => {
    for (const client of ['claude', 'codex', 'kimi'] as const) {
      expect(unlockButtonLabel(client)).not.toMatch(/hook|json|settings|\.|\//i)
    }
  })
})
