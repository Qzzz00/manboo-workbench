// @vitest-environment node
/**
 * ★ **三家额度自己读到**(2026-10-03,卡 QT)。
 *
 * ## 这张卡从哪儿来
 *
 * 维护者 10-03 17:4x:「我从实际的表格看,豆包办公、Muse、Grok Bot 都是不通的,
 * 你开张卡把三个都查吧,目标是以后的用户少动手。」
 *
 * 前两张卡(QZ `docs/交接-1003-额度自己读到.md`、QP `docs/交接-1003-壳后台翻到额度页.md`)
 * 把那条链接上了,但三家一家都没通,而且各自的「为什么」都写错了。这张卡在这台机器上逐家量了一遍,
 * 量出来的四件事就是这个文件钉的四组:
 *
 * 1. **藏着的那几家压根不用放出来就读得到**(`probe read-texts <包> --no-unhide`,三家都是藏着的):
 *        豆包办公 102 块字 / 517 个节点 / 127ms;Muse 85 块字 / 2 扇窗 / 440ms;Grok Bot 89 块字 / 64ms
 *    —— 卡 QZ / MQ3 的前提(「藏起来的 App 一扇窗都不在任何桌面上,什么都读不到」)不成立。
 *    于是读那一下改成**两眼**:第一眼按原样(她眼前一动不动),读不到才放窗。
 *    放窗那一眼没删:同一台机器上 Muse 藏着时 `AXWindows` 只有 2 扇、放出来是 3 扇,
 *    而「使用情况」那一页就在多出来的那一扇上。
 * 2. **Muse 的深链查实了**:`endo-window://settings` 开出设置窗,**第一页上**就是
 *    「使用情况」/「Free plan」/「Weekly limit resets on Oct 8」/「0% used」四条 —— 一颗键都不用按。
 *    那一下**会把藏着的那家放出来**(`hidden_before: true → hidden_after: false`),
 *    而壳那一头的「读完原样藏回去」只管它自己放的那一下 —— 所以插件要自己补一手藏回去。
 * 3. **一串键要在同一次放出来里按完**:豆包那颗通向额度页的键按下去弹一张菜单,而 `quota_page`
 *    返回前就把那家藏回去了、菜单跟着收 —— 分两条 op 发,第二颗键压根不在树上。
 * 4. **开集那几家(Grok Bot / Antigravity)也要能走「替她翻到那一页」**:`reach` 从前只长在
 *    `WindowQuotaSpec` 上,开集那条链压根没接 —— 这张卡把它挪成两条路共用的一张表。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW,
  GROK_BOT_FAMILY_ID,
  MUSE_WINDOW,
  QUOTA_LINK_SETTLE_MS,
  QUOTA_REACH_SETTLE_MS,
  backgroundLinkCommand,
  createWindowQuotaReader,
  forgetQuotaMemory,
  museQuotaOf,
  quotaReachFor,
} from '../src/server/agentQuota.ts'

const NOW = new Date('2026-10-03T06:00:00Z')
const FAKE = 'com.example.fake'

function fakeSpec(reach?: WindowQuotaSpec['reach']): WindowQuotaSpec {
  return {
    bundleId: FAKE,
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id: 'fake', title: '假的那家', state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
    ...(reach === undefined ? {} : { reach }),
  }
}

/**
 * 一台假机器。
 * - `hitAfterWalk` —— 第一眼 / 第二眼都读不到,**替她走过那一页之后**才读到(真机上那条路就是这么走的);
 * - `openFamily` —— 这一轮读的是开集那一家(走 `refreshOpen`)。
 */
function world(input: {
  reach?: WindowQuotaSpec['reach']
  quotaPage?: boolean
  hit?: boolean
  hitAfterWalk?: boolean
  linkOk?: boolean
  apps?: readonly { bundle_id: string, active?: boolean, hidden?: boolean }[]
}) {
  const sent: { op: string, bundle_id?: string, label?: string, labels?: readonly string[], unhide?: unknown }[] = []
  const ran: string[][] = []
  const logs: string[] = []
  const waits: number[] = []
  let walked = false
  const reader = createWindowQuotaReader({
    request: async (req: unknown) => {
      sent.push(req as never)
      const op = (req as { op: string }).op
      if (op === 'running_apps') return { ok: true, result: { apps: input.apps ?? [{ bundle_id: FAKE, hidden: true }] } }
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
        return { ok: true, result: { found: true, pressed: true, how: 'ax_press', pressed_count: 1, windows: 1, visited: 388 } }
      }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true,
                     ...(input.quotaPage === undefined ? {} : { quotaPage: input.quotaPage }) }),
    now: () => NOW,
    wait: async (ms: number) => { waits.push(ms) },
    runCommand: async (cmd: readonly string[]) => { ran.push([...cmd]); walked = true; return { ok: input.linkOk ?? true } },
    log: (line: string) => { logs.push(line) },
    specs: new Map([['fake', fakeSpec(input.reach)]]),
  } as never)
  return { reader, sent, ran, logs, waits }
}

beforeEach(() => { forgetQuotaMemory() })

describe('三家额度 · 先按原样读,放窗只当第二眼', () => {
  it('★按原样那一眼就读到了 → 一次都不放窗(常态下她眼前一扇窗都不动)', async () => {
    const { reader, sent } = world({ hit: true, apps: [{ bundle_id: FAKE, hidden: true }] })
    await reader.refresh()
    const reads = sent.filter(one => one.op === 'read_texts')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.unhide).toBe(false)
  })

  it('★按原样读不到 + 从没读到过数 → 放出来再读一眼(Muse 的设置窗就在多出来的那一扇上)', async () => {
    const { reader, sent } = world({ hit: false, apps: [{ bundle_id: FAKE, hidden: true }] })
    await reader.refresh()
    expect(sent.filter(one => one.op === 'read_texts').map(one => one.unhide)).toEqual([false, true])
  })

  it('★没藏起来的那一家:只读一眼(没有「放窗」这回事)', async () => {
    const { reader, sent } = world({ hit: false, apps: [{ bundle_id: FAKE }] })
    await reader.refresh()
    expect(sent.filter(one => one.op === 'read_texts').map(one => one.unhide)).toEqual([false])
  })

  /**
   * ★ **这一轮是我们把它起来、又自己藏起来的 → 第二眼照样放窗。**
   *
   * 那一下的「藏」是工作台自己按的(`launchHidden` 里的 `hide_app`),不是她的意思;而「值不值得
   * 动这个 App」在更前面那道门(`worthLaunching`:数还不旧就不拉 + 同一家 90 分钟只拉一次)上
   * 已经判过了,比放窗那道门严。少了这一条,刚起来的那一家只读得到「按原样」那一眼 ——
   * 而我们刚亲手把它藏起来。
   */
  it('★这一轮是我们起的那一家(她点「读一下」才起;2026-10-19):第二眼照样放窗', async () => {
    const { reader, sent } = world({ hit: false, apps: [] })
    await reader.refresh(['fake'], { press: true })
    expect(sent.filter(one => one.op === 'read_texts').map(one => one.unhide)).toEqual([false, true])
  })
})

describe('三家额度 · Muse:深链开设置窗,读完自己藏回去', () => {
  it('★表上写的就是那条查实过的深链(只开它自己的窗名,一个参数都不传)', () => {
    expect(MUSE_WINDOW.reach?.link).toBe('endo-window://settings')
    expect(backgroundLinkCommand(MUSE_WINDOW.reach?.link as string)).toEqual(['open', '-g', 'endo-window://settings'])
  })

  /**
   * 真机上那四条命中(`probe quota-link com.meta.endo endo-window://settings`)直接喂给 `museQuotaOf`:
   * 位置与原话都是量到的那一份,**不是编的**。「0% used」= 还剩约 100%。
   */
  it('★那四条真机命中喂给 Muse 的 parse → 真读出一个数', () => {
    const got = museQuotaOf({
      at: NOW.toISOString(),
      width: 1640,
      matches: [
        { id: 'page', text: '使用情况', x: 249, y: 151 },
        { id: 'plan', text: 'Free plan', x: 267, y: 195 },
        { id: 'reset', text: 'Weekly limit resets on Oct 8', x: 267, y: 214 },
        { id: 'used', text: '0% used', x: 1397, y: 195 },
      ],
    })
    expect(got?.state).toBe('numbers')
    expect(got?.left_pct).toBe(100)
    expect(got?.source).toContain('Weekly limit resets on Oct 8')
  })

  it('★深链开完等得比翻页久(开一扇新窗 + 建它那层网页树)', () => {
    expect(QUOTA_LINK_SETTLE_MS).toBeGreaterThan(QUOTA_REACH_SETTLE_MS)
  })

  it('★开过深链的那一家,读完自己 hide_app 藏回去(深链把它放出来了,壳那一头不会藏)', async () => {
    const { reader, sent, ran, waits } = world({
      reach: { page: '用量', link: 'fake://usage' }, hitAfterWalk: true, apps: [{ bundle_id: FAKE, hidden: true }],
    })
    await reader.refresh(['fake'], { press: true })  // 深链只在她亲手点时开(0.4.93 热修)
    expect(ran).toContainEqual(['open', '-g', 'fake://usage'])
    expect(waits).toContain(QUOTA_LINK_SETTLE_MS)
    // 开完深链那一眼要**按放出来的状态**读(那扇刚开的窗要读得到)。
    expect(sent.filter(one => one.op === 'read_texts').map(one => one.unhide)).toEqual([false, true, true])
    // 最后一条是藏回去。
    expect(sent[sent.length - 1]?.op).toBe('hide_app')
  })

  it('★本来没藏着的那一家开完深链**不**藏它(她自己开着的,别替她收走)', async () => {
    const { reader, sent } = world({
      reach: { page: '用量', link: 'fake://usage' }, hitAfterWalk: true, apps: [{ bundle_id: FAKE }],
    })
    await reader.refresh(['fake'], { press: true })
    expect(sent.some(one => one.op === 'hide_app')).toBe(false)
  })
})

describe('三家额度 · 一串键在同一次放出来里按完', () => {
  it('★`quota_page` 一条 op 带一串 labels(两颗键不再发两条 —— 菜单会收掉)', async () => {
    const { reader, sent } = world({
      reach: { page: '订阅与额度管理', press: ['标准套餐', '订阅与额度管理'] },
      quotaPage: true, hitAfterWalk: true, apps: [{ bundle_id: FAKE, hidden: true }],
    })
    await reader.refresh()
    const pages = sent.filter(one => one.op === 'quota_page')
    expect(pages).toHaveLength(1)
    expect(pages[0]?.labels).toEqual(['标准套餐', '订阅与额度管理'])
    // `label` 还带着:老壳只认这一格(它会按第一颗,回包里说它只按了一颗)。
    expect(pages[0]?.label).toBe('标准套餐')
  })

  it('★按回去那一串同样一条 op', async () => {
    const { reader, sent } = world({
      reach: { page: '用量', press: ['设置', '用量'], back: ['返回', '对话'] },
      quotaPage: true, hitAfterWalk: true, apps: [{ bundle_id: FAKE, hidden: true }],
    })
    await reader.refresh()
    const pages = sent.filter(one => one.op === 'quota_page')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.labels).toEqual(['返回', '对话'])
  })
})

describe('三家额度 · 那张表两条路共用一张', () => {
  it('★窗口型那几家照旧在自己的读法旁边声明(`WindowQuotaSpec.reach`),查得到', () => {
    expect(quotaReachFor('muse')?.link).toBe('endo-window://settings')
    expect(quotaReachFor('doubao')?.page).toBe('订阅与额度管理')
  })

  it('★开集那一家(Grok Bot)登在同一张表上 —— 从前它压根没有格子可填', () => {
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.page).toContain('账号菜单')
  })

  /**
   * 豆包那一格**空着是查实的结果**:那颗键认得出、后台也按得下去
   * (`probe quota-page com.bot.pc.doubao 标准套餐` 三次都回 `found/pressed:true`),
   * 可它弹的是系统原生菜单 —— 按完整扇窗的树一个字没变(visited 388 → 388),
   * 应用元素底下也没多出 `AXMenu`。填一颗 `press` 只是每 10 分钟白按一下她的 App。
   *
   * ★ **2026-10-03 晚(卡「豆包闪一下」)把这一条的理由收紧了一道**:当时留的那句
   * 「原生菜单要那家在台前才跟踪得住」在同一台机器上量掉了 —— **叫到台前按完照样不进树**
   * (`probe quota-page … --front` → `front_got: true`、`menu_roots: 0`、`stuck: 订阅与额度管理`)。
   * 所以这两格空着不再是「等一条台前的路」,而是「那张菜单压根不在辅助功能树上」。
   *
   * ★ **2026-10-04(卡「豆包台前点一下」)这一条翻过来了,而且理由又换了一次。**
   *
   * 维护者拍板「可以」之后真机量到:**那条路上压根没有「原生菜单」这回事** ——
   * 台前对那颗键**合成一次鼠标点击**,点下去直接在窗口里开一层
   * `AXWebArea「订阅与额度管理 - 豆包」`(`menu_roots` 照旧 0、`--watch-menu` 这几秒里
   * 一扇多出来的窗都没有)。`AXPress` 回 success 而什么都不开,是因为它要的是真点击。
   * 于是 `press` 填**一颗**「标准套餐」(第二颗「订阅与额度管理」是那一页的标题、不是键),
   * 外加 `front_ok` + `front_click`。深链那一格照旧永远空着(它一条 scheme 都不注册)。
   */
  it('★豆包:`press` 填上了一颗(台前点一下那条路查实了),深链照旧空着', () => {
    expect(DOUBAO_WINDOW.reach?.press).toEqual(['标准套餐'])
    expect(DOUBAO_WINDOW.reach?.front_ok).toBe(true)
    expect(DOUBAO_WINDOW.reach?.front_click).toBe(true)
    expect(DOUBAO_WINDOW.reach?.link).toBeUndefined()
  })

  it('★开集那条链也走「替她翻到那一页」(从前没接)', async () => {
    // 它得在跑(藏着也算):2026-10-19 起自动那一轮不起没在跑的家,没在跑就走不到翻页那一步。
    const { reader, sent } = world({
      reach: { page: '用量', press: ['用量'] }, quotaPage: true, hitAfterWalk: true,
      apps: [{ bundle_id: FAKE, hidden: true }],
    })
    // 验的是「`refreshOpen` 这条链会去查那张共用的表、查到就去翻」——
    // 这一家的 `reach` 从 `specs` 那一份来(同窗口型:声明它的地方还是这一家的读法旁边)。
    await reader.refreshOpen([{ id: 'fake', title: '假开集', bundleId: FAKE }])
    expect(sent.some(one => one.op === 'quota_page')).toBe(true)
  })
})
