// @vitest-environment node
/**
 * ★ **豆包:台前对那颗键点一下**(2026-10-04,卡 `claude/quota-doubao-click`)。
 *
 * ## 这张卡从哪儿来
 *
 * 卡「豆包闪一下」(10-03)把「闪到台前按一下」做出来了,真机量到的是:叫得到台前、
 * `AXPress`「标准套餐」回 success —— **而那一页压根不开**(`menu_roots: 0`)。
 * 那张交接留了一句要维护者拍的话:「要不要只在台前、对着那颗键**合成一次鼠标点击**」。
 * 维护者 2026-10-04 答「**可以**」,配三样:只在 `front_got` 之后点、点之前现取一次矩形、
 * 点完照旧按 AX 认下一颗;而且**自动那一轮一律不走**(0.4.92 Muse 事故那条规矩)。
 *
 * ## 这张卡在真机上量到的两件事(都写进了 `DOUBAO_WINDOW.reach` 旁边那段注释)
 *
 * 1. **那条路上压根没有「原生菜单」这回事**:点下去直接在窗口里开一层
 *    `AXWebArea「订阅与额度管理 - 豆包」`(448,97 600x777);`menu_roots` 照旧 0,
 *    而 `--watch-menu` 那几秒里 `CGWindowList` 上一扇多出来的窗都没有。
 *    → `press` 只有**一颗**(「订阅与额度管理」是那一页的标题,不是键:两次都「认不出」)。
 * 2. **到了那一页之后按原样读得到、而且一直停在那儿**:每 45 秒读一次,连着十来轮都命中
 *    (141–257ms、一扇窗不动、`app_hidden: true`)。那一页上两行的用量写的是**「未消耗」**
 *    (= 已用 0%),不是「已用 N%」—— 原来的正则因此一条都配不上。
 *
 * ## 这个文件钉的四组
 *
 * 1. **那一下点击的四道门**(插件要了 / 闪台前那一支 / 她亲手点的 / 这份壳会这一下);
 * 2. **后台那一支一下都不点**(`click` 那一格压根不发);
 * 3. **表上那几格是真机量到的**(一颗 press、`front_ok`、`front_click`);
 * 4. **「未消耗」= 已用 0%**,而且**整格相等**才认。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW,
  MANUS_WINDOW,
  MUSE_WINDOW,
  createWindowQuotaReader,
  doubaoQuotaOf,
  doubaoWindowGroups,
  forgetQuotaMemory,
} from '../src/server/agentQuota.ts'

const START = new Date('2026-10-04T07:40:00Z')
const FAKE = 'com.example.fake'

interface Sent { op: string, label?: string, labels?: readonly string[], front?: unknown, click?: unknown }

/** 一台假机器(同 `quota-doubao-grok.test.ts` 那一份,多一格 `quotaClick`)。 */
function world(input: {
  reach?: WindowQuotaSpec['reach']
  caps?: { quotaPage?: boolean, quotaFront?: boolean, quotaClick?: boolean }
}) {
  const sent: Sent[] = []
  const logs: string[] = []
  const caps = input.caps ?? { quotaPage: true, quotaFront: true, quotaClick: true }
  let walked = false
  const spec: WindowQuotaSpec = {
    bundleId: FAKE,
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id: 'fake', title: '假的那家', state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
    ...(input.reach === undefined ? {} : { reach: input.reach }),
  }
  const reader = createWindowQuotaReader({
    request: async (req: unknown) => {
      sent.push(req as Sent)
      const op = (req as { op: string }).op
      if (op === 'running_apps') return { ok: true, result: { apps: [{ bundle_id: FAKE, hidden: true }] } }
      if (op === 'read_texts') {
        return {
          ok: true,
          result: {
            matches: walked ? [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
            window_count: 1,
          },
        }
      }
      if (op === 'quota_page') {
        walked = true
        return { ok: true, result: { found: true, pressed: true, how: 'front_click', pressed_count: 1 } }
      }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true, ...caps }),
    now: () => START,
    wait: async () => {},
    runCommand: async () => ({ ok: true }),
    log: (line: string) => { logs.push(line) },
    specs: new Map([['fake', spec]]),
  } as never)
  return { reader, logs, pages: () => sent.filter(one => one.op === 'quota_page') }
}

/** 豆包今天那张表的样子(台前 + 合成点击那一下)。 */
const CLICK_REACH = { page: '订阅与额度管理', press: ['标准套餐'], front_ok: true, front_click: true } as const

beforeEach(() => { forgetQuotaMemory() })

describe('豆包台前点一下 · 那几道门', () => {
  it('★她亲手点「读一下」+ 新壳 → 一条 op 同时带 `front: true` 与 `click: true`', async () => {
    const { reader, pages, logs } = world({ reach: CLICK_REACH })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBe(true)
    expect(pages()[0]?.click).toBe(true)
    expect(pages()[0]?.labels).toEqual(['标准套餐'])
    // 她眼前真闪了一下、还替她点了一下 —— 日志里得说得清(维护者会看的就是这一行)。
    expect(logs.join('\n')).toMatch(/闪了一下/)
    expect(logs.join('\n')).toMatch(/点一下/)
  })

  it('★自动那一轮一下都不点(凡会把 App 顶到台前的动作自动那一轮一律不走:0.4.92 Muse 事故)', async () => {
    const { reader, pages, logs } = world({ reach: CLICK_REACH })
    await reader.refresh()
    expect(pages()).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/自动那一轮不闪/)
  })

  it('★这份壳不会那一下(caps 里没有 `quota_click`)→ **一下都不闪**,不白按一颗换回一个 stuck', async () => {
    const { reader, pages, logs } = world({ reach: CLICK_REACH, caps: { quotaPage: true, quotaFront: true } })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/要台前点一下才开/)
  })

  it('★声明了 `front_ok` 却**没**声明 `front_click` 的那一家:照旧只闪、不点(`click` 那一格压根不发)', async () => {
    const { reader, pages } = world({ reach: { page: '用量', press: ['设置'], front_ok: true } })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBe(true)
    expect(pages()[0]?.click).toBeUndefined()
  })

  it('★后台那条路(没声明 `front_ok` 的那几家)**一下都不点**:两格都不发', async () => {
    const { reader, pages } = world({ reach: { page: '用量', press: ['设置', '用量'] } })
    await reader.refresh()
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBeUndefined()
    expect(pages()[0]?.click).toBeUndefined()
  })
})

describe('豆包台前点一下 · 表上那几格是真机量到的(10-04 这台机器)', () => {
  it('★一颗 press:「标准套餐」——「订阅与额度管理」是那一页的标题,不是键', () => {
    expect(DOUBAO_WINDOW.reach?.press).toEqual(['标准套餐'])
    expect(DOUBAO_WINDOW.reach?.page).toBe('订阅与额度管理')
    // 按回去那一串照旧没有:按回去同样非台前不可 = 再闪她一下(卡「豆包闪一下」的规矩)。
    expect(DOUBAO_WINDOW.reach?.back).toBeUndefined()
  })

  it('★两格门都在:台前(`front_ok`)+ 台前那一下合成点击(`front_click`)', () => {
    expect(DOUBAO_WINDOW.reach?.front_ok).toBe(true)
    expect(DOUBAO_WINDOW.reach?.front_click).toBe(true)
  })

  it('★别家一格 `front_click` 都没有(这一格只给查实过的那一家)', () => {
    // Muse 走深链、Manus 的积分在首页 —— 两家都不用点,也都不许顺手开这一格。
    expect(MUSE_WINDOW.reach?.front_click).toBeUndefined()
    expect(MANUS_WINDOW.reach?.front_click).toBeUndefined()
  })
})

describe('豆包那一页 · 「未消耗」= 已用 0%', () => {
  /** 10-04 07:3x 真机那一张(`probe read-texts com.bot.pc.doubao --no-unhide`,一扇窗不动、141–257ms)。 */
  const REAL = {
    at: '2026-10-04T07:39:10+08:00',
    matches: [
      { id: 'page', text: '标准套餐', x: 480, y: 166 },
      { id: 'page', text: '订阅与额度管理', x: 480, y: 206 },
      { id: 'window_5h', text: '当前时段', x: 488, y: 381 },
      { id: 'used_none', text: '未消耗', x: 966, y: 381 },
      { id: 'window_7d', text: '近 7 天', x: 488, y: 490 },
      { id: 'used_none', text: '未消耗', x: 966, y: 490 },
    ],
  }

  it('★那两格「未消耗」各归到自己那一扇窗上(同「已用 N%」占的是同一格)', () => {
    const groups = doubaoWindowGroups(REAL.matches)
    expect(groups.map(one => one.label)).toEqual(['5h', '周'])
    expect(groups.map(one => one.used?.text)).toEqual(['未消耗', '未消耗'])
  })

  it('★读出来是「两扇窗都还剩 100%」,出处里照抄那一页上的原话', () => {
    const view = doubaoQuotaOf(REAL)
    expect(view?.windows?.map(one => one.left_pct)).toEqual([100, 100])
    expect(view?.left_pct).toBe(100)
    expect(view?.source).toContain('「当前时段 未消耗」')
    expect(view?.source).toContain('订阅与额度管理')
  })

  it('★**整格相等**才认:一句话里的「未消耗」不算(假阳性比读不到坏)', () => {
    const rx = new RegExp(DOUBAO_WINDOW.patterns.find(one => one.id === 'used_none')?.regex ?? '')
    expect(rx.test('未消耗')).toBe(true)
    expect(rx.test('本月未消耗任何额度')).toBe(false)
    expect(rx.test('未消耗额度')).toBe(false)
  })

  it('★「已用 N%」那一条一个字没动(两种写法并存)', () => {
    const rx = new RegExp(DOUBAO_WINDOW.patterns.find(one => one.id === 'used')?.regex ?? '')
    expect(rx.test('已用 38%')).toBe(true)
    expect(rx.test('已用 <1%')).toBe(true)
    expect(rx.test('未消耗')).toBe(false)
  })
})
