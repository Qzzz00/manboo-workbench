// @vitest-environment node
/**
 * ★ **豆包闪一下换一个真数 / Grok Bot 读「键身上的字」**(2026-10-03,卡 `claude/quota-doubao-grok`)。
 *
 * ## 这张卡从哪儿来
 *
 * 卡 QT(`docs/交接-1003-三家额度自动读到.md`)把三家各自查清了,留下两句要维护者拍的话;
 * 维护者 2026-10-03 21:4x 原话「**行,处理吧**」:
 *
 * ① **豆包**:只在那一格**真坏了**(过了那条 2 小时线)时,把它叫到台前**闪一下** ——
 *    它那颗键弹的是 Chromium 交给系统画的**原生弹出菜单**,后台 `AXPress` 回 success 而整扇窗的树
 *    一个字没变(卡 QT 真机:visited 388 → 388)。读完**立刻**把台前与隐藏状态都还原,
 *    **一家 90 分钟最多闪一次**;常态下照旧不闪(第一眼仍按原样读)。
 * ② **Grok Bot**:让 `read_texts` **按家声明**地也读「键身上的字」(`AXMenuItem` / `AXButton` 的 title)
 *    —— 它的额度写在一颗 `AXMenuItem` 身上(「SuperGrok N%」),而整扇窗的静态字里一个百分号都没有。
 *    **不能全局开**:一颗叫「使用情况」的侧栏键会把 Muse / 豆包那条「这确实是那一页」的整格旁证骗过去。
 *
 * ## 这个文件钉的四组
 *
 * 1. **闪那一下的三道门**(壳会不会 / 这一格真坏了没有 / 90 分钟最多一次)——
 *    少一道,她的屏就会每 10 分钟被闪一次,那正是 09-27 维护者否掉的那件事;
 * 2. **闪完的善后**:那一眼**按原样读**(不再放一次窗 = 不闪第二下)、`back` 那一串**不按回去**
 *    (按回去同样非台前不可 = 再闪她一下);
 * 3. **`include_titles` 只给声明过的那一家**(两条路都钉:窗口型与开集);
 * 4. **表上那几格是真机量到的**(10-03 这台机器,见 `docs/交接-1003-豆包闪一下与Grok读键字.md`)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW,
  GROK_BOT_FAMILY_ID,
  MUSE_WINDOW,
  QUOTA_FRONT_GAP_MS,
  createWindowQuotaReader,
  forgetQuotaMemory,
  quotaReachFor,
} from '../src/server/agentQuota.ts'
import { QUOTA_AS_OF_STALE_AFTER_MS } from '../src/protocol.ts'

const START = new Date('2026-10-03T14:00:00Z')
const FAKE = 'com.example.fake'

interface Sent { op: string, bundle_id?: string, label?: string, labels?: readonly string[], unhide?: unknown, front?: unknown, include_titles?: unknown }

/**
 * 一台假机器(一把可以往前拨的钟)。
 *
 * - `reach` —— 这一家的那张表(闪那一下要 `front_ok`、读键字要 `read_titles`);
 * - `lastAt` —— 上次**真读到**那个数的时刻(落盘那一份;`undefined` = 从没读到过 → 那一格就是「真坏了」);
 * - `hitAfterWalk` —— 两眼都读不到,**替她走过那一页之后**才读到(真机上豆包那条路就是这么走的)。
 */
function world(input: {
  reach?: WindowQuotaSpec['reach']
  caps?: { quotaPage?: boolean, quotaFront?: boolean, readTitles?: boolean }
  lastAt?: string
  hit?: boolean
  hitAfterWalk?: boolean
  hidden?: boolean
}) {
  const sent: Sent[] = []
  const logs: string[] = []
  let at = START
  let walked = false
  const caps = input.caps ?? { quotaPage: true, quotaFront: true, readTitles: true }
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
      if (op === 'running_apps') {
        return { ok: true, result: { apps: [{ bundle_id: FAKE, hidden: input.hidden ?? true }] } }
      }
      if (op === 'read_texts') {
        const hit = input.hit ?? (input.hitAfterWalk === true ? walked : false)
        return {
          ok: true,
          result: {
            matches: hit ? [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
            window_count: 1,
          },
        }
      }
      if (op === 'quota_page') {
        walked = true
        return { ok: true, result: { found: true, pressed: true, how: 'ax_press', pressed_count: 2, windows: 1, visited: 388 } }
      }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true, ...caps }),
    now: () => at,
    wait: async () => {},
    runCommand: async () => ({ ok: true }),
    log: (line: string) => { logs.push(line) },
    specs: new Map([['fake', spec]]),
    ...(input.lastAt === undefined
      ? {}
      : {
          store: {
            load: () => ({ lasts: { fake: { at: input.lastAt as string, matches: [{ id: 'used', text: '剩 62%', x: 10, y: 10 }] } } }),
            save: () => {},
          },
        }),
  } as never)
  return {
    reader,
    sent,
    logs,
    /** 把钟往前拨(量那条 90 分钟的闸)。 */
    tick: (ms: number) => { at = new Date(at.getTime() + ms) },
    pages: () => sent.filter(one => one.op === 'quota_page'),
    reads: () => sent.filter(one => one.op === 'read_texts'),
  }
}

/**
 * 一张**声明了「这几颗键非台前不可」**的假表(闪那一下的三道门就是拿它量的)。
 *
 * ★ 为什么是假的:10-03 这一轮量到**豆包连台前也不行** —— 叫到台前 `AXPress`「标准套餐」,
 * 那一页照样不开(`menu_roots: 0`、`stuck: 订阅与额度管理`),所以那一版
 * `DOUBAO_WINDOW.reach` **没有** `press` / `front_ok`。闪那一下的机制是维护者拍板要的、也验过了,
 * 这个文件钉的就是它那三道门与善后 —— 所以这里用一张**假**表,与豆包那一格填没填无关。
 *
 * ★ **2026-10-04(卡「豆包台前点一下」):豆包那一格填上了**(`press: ['标准套餐']` +
 * `front_ok` + `front_click`)—— 台前**合成一次鼠标点击**就开得了那一页(维护者拍板「可以」)。
 * 这个文件这几条用例**一个字都没改**,它们钉的是那三道门与善后本身;
 * 点那一下的四道门与「未消耗」那一条在 `tests/quota-doubao-click.test.ts`。
 */
const FRONT_REACH = { page: '订阅与额度管理', press: ['标准套餐', '订阅与额度管理'], front_ok: true } as const

beforeEach(() => { forgetQuotaMemory() })

describe('豆包闪一下 · 几道门', () => {
  it('★她亲手点「读一下」+ 新壳 → 叫到台前闪一下,一条 op 带 `front: true` 与那一串键', async () => {
    const { reader, pages, logs } = world({ reach: FRONT_REACH, hitAfterWalk: true })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBe(true)
    expect(pages()[0]?.labels).toEqual(['标准套餐', '订阅与额度管理'])
    // 老壳只认 `label` 那一格,照旧带着(它会按第一颗)。
    expect(pages()[0]?.label).toBe('标准套餐')
    // 她眼前确实闪了一下 —— 日志里得有一句说得清为什么(维护者会看的就是这一行)。
    expect(logs.join('\n')).toMatch(/闪了一下/)
    expect(logs.join('\n')).toMatch(/换一个真数/)
  })

  it('★自动那一轮哪怕这一格真坏了(从没读到过)也一颗都不按 —— 顶到台前的动作只在她亲手点时走(0.4.92 Muse 事故)', async () => {
    const { reader, pages, logs } = world({ reach: FRONT_REACH, hitAfterWalk: true })
    await reader.refresh()
    expect(pages()).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/自动那一轮不闪/)
  })

  it('★自动那一轮过了 2 小时线也不闪', async () => {
    const stale = new Date(START.getTime() - QUOTA_AS_OF_STALE_AFTER_MS - 60_000).toISOString()
    const { reader, pages } = world({ reach: FRONT_REACH, lastAt: stale, hitAfterWalk: true })
    await reader.refresh()
    expect(pages()).toHaveLength(0)
  })

  it('★她亲手点也是 90 分钟最多闪一次:30 分钟后再点不闪,过了 90 分钟再闪一次', async () => {
    const world1 = world({ reach: FRONT_REACH })
    await world1.reader.refresh(undefined, { press: true })
    expect(world1.pages()).toHaveLength(1)
    world1.tick(30 * 60_000)
    await world1.reader.refresh(undefined, { press: true })
    expect(world1.pages()).toHaveLength(1)
    expect(world1.logs.join('\n')).toMatch(/刚闪过一次/)
    world1.tick(QUOTA_FRONT_GAP_MS)
    await world1.reader.refresh(undefined, { press: true })
    expect(world1.pages()).toHaveLength(2)
  })

  it('★老壳(caps 里没有 `quota_front`)→ 一颗都不按,不背着台前白按一下她的 App', async () => {
    const { reader, pages, logs } = world({ reach: FRONT_REACH, caps: { quotaPage: true } })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/非台前不可/)
  })

  it('★这一格的数还不旧、她亲手点 → 照样闪(她正等着这一下)', async () => {
    const fresh = new Date(START.getTime() - 10 * 60_000).toISOString()
    const { reader, pages } = world({ reach: FRONT_REACH, lastAt: fresh, hitAfterWalk: true })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBe(true)
  })
})

describe('豆包闪一下 · 闪完的善后', () => {
  it('★闪完那一眼**按原样读**(再放一次窗等于同一轮里闪她第二下)', async () => {
    const { reader, reads } = world({ reach: FRONT_REACH, hitAfterWalk: true })
    await reader.refresh(undefined, { press: true })
    // 第一眼按原样(miss)→ 第二眼放窗(miss)→ 闪一下 → 第三眼**按原样**(命中)。
    expect(reads().map(one => one.unhide)).toEqual([false, true, false])
  })

  it('★`back` 那一串不按回去(按回去同样非台前不可),如实记一行', async () => {
    const { reader, pages, logs } = world({
      reach: { ...FRONT_REACH, back: ['返回'] }, hitAfterWalk: true,
    })
    await reader.refresh(undefined, { press: true })
    expect(pages()).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/不按回原来那一页/)
  })

  it('★没声明 `front_ok` 的那几家一个字没变:照旧不抢焦点那条路(不带 `front`)', async () => {
    const { reader, pages } = world({
      reach: { page: '用量', press: ['设置', '用量'] }, hitAfterWalk: true,
    })
    await reader.refresh()
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.front).toBeUndefined()
  })
})

describe('Grok 读键字 · 只给声明过的那一家', () => {
  it('★声明了 `read_titles` + 壳会这一下 → 每一眼都带 `include_titles: true`', async () => {
    const { reader, reads } = world({ reach: { page: '账号菜单', read_titles: true } })
    await reader.refresh()
    expect(reads().length).toBeGreaterThan(0)
    for (const one of reads()) expect(one.include_titles).toBe(true)
  })

  it('★声明了、但这份壳没有 `read_titles` 那一格 → 压根不发它(不假装读到了)', async () => {
    const { reader, reads } = world({ reach: { page: '账号菜单', read_titles: true }, caps: { quotaPage: true } })
    await reader.refresh()
    for (const one of reads()) expect(one.include_titles).toBeUndefined()
  })

  it('★没声明的那一家一个字不多 —— **不许全局开**(一颗叫「使用情况」的侧栏键会骗过整格旁证)', async () => {
    const { reader, reads } = world({ reach: { page: '使用情况' } })
    await reader.refresh()
    for (const one of reads()) expect(one.include_titles).toBeUndefined()
  })

  it('★开集那条路也一样(声明了就带)', async () => {
    const { reader, reads } = world({ reach: { page: '账号菜单', read_titles: true } })
    await reader.refreshOpen([{ id: 'fake', title: '假开集', bundleId: FAKE }])
    expect(reads().length).toBeGreaterThan(0)
    for (const one of reads()) expect(one.include_titles).toBe(true)
  })
})

describe('表上那几格是真机量到的(10-03 这台机器)', () => {
  /**
   * `probe quota-keys com.anysphere.sand`(账号菜单**收起来**的那一刻,卡 QT 没量到的就是这一下):
   *     AXPopUpButton (16,919) 36x36 ['Open account menu']   ← 通向那六行的触发键
   * 后台 `AXPress` 它**按得开**(77ms、没抢焦点、读完照旧藏着):等一拍之后那六行进了树,
   * 其中一行就是 `AXMenuItem (22,708) ['SuperGrok 0%']`。
   */
  it('★Grok Bot:声明 `read_titles`,页名里说得出那一行在哪儿', () => {
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.read_titles).toBe(true)
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.page).toContain('账号菜单')
  })

  /**
   * ★ **这一条 2026-10-04 改了口径**(卡「Grok 读已用」,见 `tests/quota-grok-used.test.ts`)。
   *
   * 这张卡当时写的是「`press` 空着」,挡着的两条是:① 同一扇窗上没有旁证(开集那条路的门);
   * ② 「N%」是已用还是剩余没查实。维护者 10-04 答了第二条(**是已用**),于是这一家从开集搬到
   * **窗口型**(自己的整格正则 + `parse`,不问模型 → 旁证那道门压根不适用),
   * `press` 填上已查实的那颗 `Open account menu`。
   *
   * 这里只留**没变的那一半**:`front_ok` 照旧空着 —— 它那张菜单是网页里的 ARIA 菜单,
   * 后台按得开(77ms),压根不需要台前(10-03 22:4x 规矩:顶到前台的动作自动那一轮一律不走)。
   */
  it('★Grok Bot:`front_ok` 照旧空着(后台按得开,不需要台前)', () => {
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.front_ok).toBeUndefined()
  })

  it('★Muse / 豆包都没有 `read_titles`(它们的旁证是整格静态字认的,这一格一开就被骗)', () => {
    expect(MUSE_WINDOW.reach?.read_titles).toBeUndefined()
    expect(DOUBAO_WINDOW.reach?.read_titles).toBeUndefined()
  })
})
