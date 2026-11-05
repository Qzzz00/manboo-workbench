// @vitest-environment node
/**
 * ★ **额度自己读到 —— 她一个字都不该操作**(2026-10-03,卡 QZ)。
 *
 * ## 现场
 *
 * 10-03 14:3x 维护者机器(0.4.90):面板上 Muse / 豆包办公 / Grok Bot 停在 **09-26**、Manus 停在 **10-01**,
 * 一律只写「读不到最新的,上次 09-26 21:52」。统筹原先要做的是「把为什么读不到写进格子」,
 * 维护者当天否了这条路 —— 原话:**「不用写原因,我要的是解决」**。
 *
 * ## 查实出来的两个根子(都在这台机器上数出来的)
 *
 * ① **自动那几路一律不把藏着的家放出来读**(2026-09-27 那条拍板,原 `quota-no-unhide-auto.test.ts`)。
 *    豆包 / Muse / Grok Bot 此刻**都在跑**,只是被工作台自己的窗口槽 ⌘H 藏起来了 ——
 *    藏着的 App 一扇窗都不在任何桌面上,`read_texts` 不放它出来就只能回 `no_window`。
 *    于是那三家永远读不到,格子永远停在 09-26。
 * ② **没在跑的那一家压根没人去起它**。Manus Studio 此刻不在跑(`ps` 里没有),
 *    而唯一的自动重读路是「她从那家切走」(`nudge`)—— 一个没在跑的 App 她永远切不走。
 *
 * ## 这张卡的改法(三条,全在插件里)
 *
 * - **自动那一轮也放出来读**:`unhide` 不再是「只有她点『读一下』才放」,而是一律放
 *   —— 代价(09-27 那句「依次闪过四个应用」)由壳那一头消化:`read_texts` 放出来**不 activate**、
 *   读完照原样藏回去(`TextInsert.readTexts` 的 `defer`,卡 MQ3 起就在那儿了)。
 * - **没在跑就后台起它**:`open -g -b <包>`(`-g` = 不抢焦点),起完 `hide_app` 藏到后台,再读。
 *   ★ **2026-10-19 收窄:只在她亲手点「读一下」时起**。自动那一轮对没在跑的家一律不起、记 `not_running`
 *   (维护者 10-19 关掉的千问办公 / Muse / Grok Bot / Manus 被这一路一轮轮开回来;
 *   用例在 `quota-auto-no-launch-20261019.test.ts`)。下面「后台起它」那一组因此全改成她点「读一下」那一下。
 * - **她正用着那家(它在前台)这一轮跳过**:不打扰;**这一轮一个字都不写进格子**(照旧摆上次那个数),
 *   原因只进日志 —— 维护者 10-03 第 4 条。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW,
  MANUS_WINDOW,
  MUSE_WINDOW,
  backgroundLinkCommand,
  backgroundOpenCommand,
  createWindowQuotaReader,
  forgetQuotaMemory,
  quotaReadStepFor,
  worthUnhiding,
} from '../src/server/agentQuota.ts'

const NOW = new Date('2026-10-03T06:00:00Z')

/**
 * 缺省「谁在跑」:假的那家与登记表上的三家都在跑。2026-10-19 起自动那一轮不起、也不读没在跑的家,
 * 下面不传 `apps` 的那几条验的是「在跑的家怎么读」,所以它们得都在跑。
 */
const ALL_RUNNING = [
  { bundle_id: 'com.example.fake' },
  { bundle_id: MANUS_WINDOW.bundleId },
  { bundle_id: MUSE_WINDOW.bundleId },
  { bundle_id: DOUBAO_WINDOW.bundleId },
]

/** 一家假的窗口型额度:认得出就给一个数,认不出回 undefined(同真的那三家)。 */
function fakeSpec(extra: Partial<WindowQuotaSpec> = {}): WindowQuotaSpec {
  return {
    bundleId: 'com.example.fake',
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id: 'fake', title: '假的那家', state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
    ...extra,
  }
}

interface World {
  sent: { op: string, bundle_id?: string, unhide?: unknown, label?: unknown }[]
  ran: readonly (readonly string[])[]
  logs: string[]
}

/**
 * 一台假机器。`apps` = 壳 `running_apps` 回的那几家(缺席 = 老壳不会这个 op);
 * `hit` = 这一次 `read_texts` 读到没读到那几个数。
 */
function world(input: {
  apps?: readonly { bundle_id: string, active?: boolean, hidden?: boolean }[] | 'unsupported'
  hit?: boolean
  launchOk?: boolean
  specs?: ReadonlyMap<string, WindowQuotaSpec>
} = {}) {
  const w: World = { sent: [], ran: [], logs: [] }
  let hit = input.hit ?? true
  let apps = input.apps
  const reader = createWindowQuotaReader({
    request: async (req) => {
      w.sent.push(req as never)
      const op = (req as { op: string }).op
      if (op === 'running_apps') {
        if (apps === 'unsupported') return { ok: false, error: '未知 op running_apps' }
        return { ok: true, result: { apps: apps ?? ALL_RUNNING } }
      }
      if (op === 'read_texts') {
        return {
          ok: true,
          result: {
            matches: hit ? [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
            window_count: 1,
            text_nodes: hit ? 1 : 0,
          },
        }
      }
      // 壳按一颗键:认出来了就回 `found:true`(同 `AgentWindow.press`)。
      if (op === 'agent_press') return { ok: true, result: { found: true, pressed: true } }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    now: () => NOW,
    wait: async () => {},
    runCommand: async (cmd) => { w.ran = [...w.ran, cmd]; return { ok: input.launchOk ?? true } },
    log: (line) => { w.logs.push(line) },
    ...(input.specs === undefined ? {} : { specs: input.specs }),
  })
  /** 下一轮换个样子(同一个读数器):她退了那个 App、或者那一页开上了。 */
  const setApps = (next: typeof input.apps): void => { apps = next }
  /** 下一轮读得到 / 读不到(她从那一页切走了)。 */
  const setHit = (next: boolean): void => { hit = next }
  return { ...w, reader, world: w, setApps, setHit }
}

beforeEach(() => { forgetQuotaMemory() })

describe('额度自己读到 · 放出来读', () => {
  /**
   * ★ **这一条被 2026-10-03 卡 QT 改过一次**。
   *
   * 卡 QZ 原来钉的是「自动那一轮也把藏着的家**放出来**读:每一条 `read_texts` 都 `unhide:true`」
   * (为的是否掉 09-27 那句「自动那几路一律 `unhide:false`」)。
   * 卡 QT 在同一台机器上量到**藏着的家压根不用放出来就读得到**
   * (`probe read-texts <包> --no-unhide`:豆包 102 块字 / Muse 85 / Grok Bot 89),
   * 于是改成**两眼**:第一眼按原样读(她眼前一动不动),读不到才放窗。
   * 口径的来龙去脉与那三组真机数写在 `tests/quota-no-unhide-auto.test.ts` 的文件头。
   */
  it('★自动那一轮的第一眼按原样读(unhide:false)—— 她眼前一扇窗都不动', async () => {
    const { reader, world: w } = world()
    await reader.refresh()
    const reads = w.sent.filter(one => one.op === 'read_texts')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0]?.unhide).toBe(false)
  })

  /**
   * 「谁在跑 / 谁在前台」**一轮只问一次**。十几个 App 的 `NSWorkspace` 清单一次几毫秒、不碰辅助功能,
   * 可一轮三家各问一次就是三次白来回。(别的几份用例里这一问被过滤掉了不计入「读了几次」,
   * 所以这条断言放在这儿 —— 免得哪天它变成一家一问也没人发现。)
   */
  it('★「谁在跑」一轮只问一次(三家共用那一张清单)', async () => {
    const { reader, world: w } = world()
    await reader.refresh()
    expect(w.sent.filter(one => one.op === 'running_apps')).toHaveLength(1)
    expect(w.sent.filter(one => one.op === 'read_texts').length).toBeGreaterThan(1)
  })

  it('★壳没连 / 没授权 / 老壳:连「谁在跑」都不问(那一趟读压根不会发生)', async () => {
    for (const helper of [
      { connected: false, authorized: false, readTexts: false },
      { connected: true, authorized: false, readTexts: true },
      { connected: true, authorized: true, readTexts: false },
    ]) {
      const sent: { op: string }[] = []
      const reader = createWindowQuotaReader({
        request: async (req) => { sent.push(req as never); return { ok: true } },
        helper: () => helper,
        now: () => NOW,
        wait: async () => {},
      })
      await reader.refresh()
      expect(sent).toEqual([])
    }
  })

  it('★10 分钟那一轮(pump)走的是同一条链:第一眼按原样读', async () => {
    const { reader, world: w } = world()
    reader.pump()
    await reader.refresh()
    expect(w.sent.filter(one => one.op === 'read_texts')[0]?.unhide).toBe(false)
  })
})

describe('额度自己读到 · 她正用着那家就不碰', () => {
  it('★它在前台(她在用)→ 一条 read_texts 都不发、这一格一个字不改,只记一行日志', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake', active: true }], specs })
    await reader.refresh()
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(false)
    // 跳过这一轮**不写格子**(卡 QZ 第 4 条:原因只进日志)—— 否则界面会说「读过它的窗口」,那是假话。
    expect(reader.readings().fake).toBeUndefined()
    expect(w.logs.join('\n')).toContain('在前台')
  })

  it('★它在跑、只是藏着 → 照读(藏着不是「她在用」)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake', hidden: true }], specs })
    await reader.refresh()
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(true)
    expect(reader.readings().fake?.attempt?.found).toBe(true)
  })
})

/**
 * ★ **09-27 那条拍板里说对了的那一半:放出来那一下她眼前真的会多出一扇窗。**
 *
 * 壳放出来**不 activate**(不抢焦点、不叫台前),但那几扇窗确实会露在屏上一两秒 ——
 * 维护者 09-27 看见的「依次闪过 manus、muse、豆包、Grok bot 四个应用」就是这一下。
 * 这张卡没把那半句丢掉,**换了个判据**:数还不旧就不为它放窗(没坏的不去修);
 * 过线了才放(那一格此刻写的是「读不到最新的」,一两秒换回一个真数,值);她亲手点的一律放。
 */
describe('额度自己读到 · 藏着的那一家,只在这一格真的坏了时才放窗', () => {
  /**
   * ★ **卡 QT 把这一条改了半句**:原来是「数还不旧 + 藏着 → 这一轮**不读**」(那时读它非得先放窗,
   * 所以「不放窗」等于「不读」)。现在第一眼按原样读压根不动她的窗,**没有理由不读** ——
   * 所以这一条钉的是「照原样读一眼、但一次都不放窗」。
   */
  it('★数还不旧 + 藏着 → 照原样读到了,一次都不放窗', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w, setApps } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()                                   // 它没藏着:先正常读到一个数(这一刻)
    setApps([{ bundle_id: 'com.example.fake', hidden: true }])
    const before = w.sent.filter(one => one.op === 'read_texts').length
    await reader.refresh()
    const after = w.sent.filter(one => one.op === 'read_texts').slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(one => one.unhide === false)).toBe(true)
  })

  it('★数还不旧 + 藏着 + 按原样那一眼没读到 → 还是不放窗,日志说清为什么', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w, setApps, setHit } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()                                   // 先读到一个数(这一格于是「还不旧」)
    setApps([{ bundle_id: 'com.example.fake', hidden: true }])
    setHit(false)                                            // 她从那一页切走了
    const before = w.sent.filter(one => one.op === 'read_texts').length
    await reader.refresh()
    const after = w.sent.filter(one => one.op === 'read_texts').slice(before)
    expect(after.every(one => one.unhide === false)).toBe(true)
    expect(w.logs.join('\n')).toContain('不为它放窗')
  })

  it('★数过了线 + 藏着 → 放窗读一次(一两秒的一闪换回一个真数)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake', hidden: true }], specs })
    // 从没读到过数 = 这一格此刻就是坏的,该放。
    await reader.refresh()
    expect(w.sent.filter(one => one.op === 'read_texts').length).toBeGreaterThan(0)
  })

  it('★没藏起来的那一家压根不经过这道门(读它一个窗都不用动)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w, setApps } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()
    const before = w.sent.filter(one => one.op === 'read_texts').length
    setApps([{ bundle_id: 'com.example.fake', hidden: false }])
    await reader.refresh()
    expect(w.sent.filter(one => one.op === 'read_texts').length).toBeGreaterThan(before)
  })

  it('★她亲手点「读一下」→ 藏着、数也不旧,照样放窗(她在等这一下)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w, setApps } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()
    const before = w.sent.filter(one => one.op === 'read_texts').length
    setApps([{ bundle_id: 'com.example.fake', hidden: true }])
    await reader.refresh(undefined, { press: true })
    expect(w.sent.filter(one => one.op === 'read_texts').length).toBeGreaterThan(before)
  })

  it('★一处判(`worthUnhiding`):她点的一律放;没读到过数一律放;不旧不放;过线放', () => {
    const now = NOW
    const fresh = new Date(NOW.getTime() - 10 * 60_000).toISOString()
    const old = new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString()
    expect(worthUnhiding({ lastAt: fresh, byHand: true, now })).toBe(true)
    expect(worthUnhiding({ byHand: false, now })).toBe(true)
    expect(worthUnhiding({ lastAt: fresh, byHand: false, now })).toBe(false)
    expect(worthUnhiding({ lastAt: old, byHand: false, now })).toBe(true)
    // 认不出的时刻 / 时钟倒着走:**放**(宁可多闪一下,也不让一格永远读不到)。
    expect(worthUnhiding({ lastAt: '不是时刻', byHand: false, now })).toBe(true)
  })
})

describe('额度自己读到 · 没在跑:她点「读一下」才后台起它(2026-10-19 起自动那一轮不起)', () => {
  it('★不在 running_apps 里 + 她点「读一下」→ `open -g -b <包>` 起它、起完 hide_app 藏到后台、再读', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [], specs })
    await reader.refresh(['fake'], { press: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand('com.example.fake'))
    // `-g` 是「不抢焦点」那一格,少了它起 App 会跳到她眼前。
    expect(backgroundOpenCommand('com.example.fake')).toContain('-g')
    const ops = w.sent.map(one => one.op)
    expect(ops.indexOf('hide_app')).toBeGreaterThan(-1)
    expect(ops.indexOf('hide_app')).toBeLessThan(ops.lastIndexOf('read_texts'))
    expect(reader.readings().fake?.attempt?.found).toBe(true)
  })

  it('★她点「读一下」、起不来 → 不读、如实记 not_running、一行日志(格子照旧摆上次那个数)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [], launchOk: false, specs })
    await reader.refresh(['fake'], { press: true })
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(false)
    expect(reader.readings().fake?.attempt?.error).toBe('not_running')
    expect(w.logs.join('\n')).toContain('起不来')
  })

  /**
   * ★ **这一条挡的是 10-02 那个毛病的慢放版。**
   *
   * 运营同学(Air)10-02:「我让他打开网易云音乐……完成后每隔 10s 又自行打开。。不断弹窗」。
   * 10 分钟那一轮接回来之后,**她亲手退掉的 App 会每 10 分钟被工作台重新拉起一次** —— 同一个毛病,
   * 只是慢了六十倍。两道门:①数还不旧就压根不拉(没坏的不去修);②同一家 90 分钟内只拉一次。
   */
  it('★这一格的数还不旧 → 她点「读一下」也不去拉她的 App(没坏的不去修)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    // 先在「它在跑」的时候读到一个数(时刻 = 这一刻),再让它「没在跑」—— 那个数一点都不旧。
    const { reader, world: w, setApps } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()
    expect(reader.readings().fake?.last?.at).toBeTruthy()
    setApps([])
    await reader.refresh(['fake'], { press: true })
    expect(w.ran).toEqual([])
    expect(w.logs.join('\n')).toContain('还不旧')
  })

  it('★这一格的数已经过线、它又没在跑 → 她点「读一下」这才去后台起它;自动那一轮不起', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [], specs })
    // 从没读到过数(`last` 缺席)= 原来「最该去拉一次」的时候 —— 2026-10-19 起自动那一轮也不拉。
    await reader.refresh()
    expect(w.ran).toEqual([])
    await reader.refresh(['fake'], { press: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand('com.example.fake'))
  })

  it('★同一家 90 分钟内只起一次(她连点两下「读一下」也只起一次)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [], hit: false, specs })
    await reader.refresh(['fake'], { press: true })
    await reader.refresh(['fake'], { press: true })
    // 两下都走到了「没在跑」,但只拉过一次(第二下被那条 90 分钟的线挡下)。
    expect(w.ran.filter(cmd => cmd[0] === 'open' && cmd.includes('-b'))).toHaveLength(1)
    expect(w.logs.join('\n')).toContain('分钟内只起一次')
  })

  it('★老壳不会 running_apps → 照这一版之前那样只读,不拉起、不跳过', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: 'unsupported', specs })
    await reader.refresh()
    expect(w.ran).toEqual([])
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(true)
  })
})

describe('额度自己读到 · 读完窗口状态与读前一致', () => {
  it('★本来在跑、又没藏的那一家:一条 hide_app / unhide_app 都不发(她眼前什么都没变)', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake' }], specs })
    await reader.refresh()
    expect(w.sent.some(one => one.op === 'hide_app' || one.op === 'unhide_app')).toBe(false)
  })

  it('★本来藏着的那一家:第一眼按原样读(连放出来都不用),插件这头一条 hide_app 都不发', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake', hidden: true }], specs })
    await reader.refresh()
    expect(w.sent.some(one => one.op === 'hide_app' || one.op === 'unhide_app')).toBe(false)
    // 读到了 → 一次都没放窗(卡 QT:常态下她眼前一扇窗都不动)。
    expect(w.sent.filter(one => one.op === 'read_texts').every(one => one.unhide === false)).toBe(true)
  })

  it('★我们起的那一家(她点「读一下」):读完**最后**一条还是 hide_app —— 不把它留在她眼前', async () => {
    const specs = new Map([['fake', fakeSpec()]])
    const { reader, world: w } = world({ apps: [], specs })
    await reader.refresh(['fake'], { press: true })
    const shell = w.sent.filter(one => one.op === 'hide_app' || one.op === 'read_texts')
    expect(shell[shell.length - 1]?.op).toBe('hide_app')
  })
})

describe('额度自己读到 · 额度在哪一页、怎么到那一页(那张表)', () => {
  it('★三家都写着页名(界面上那句话、按钮那一步都认它)', () => {
    expect(MANUS_WINDOW.reach?.page).toBeTruthy()
    expect(MUSE_WINDOW.reach?.page).toBe('使用情况')
    expect(DOUBAO_WINDOW.reach?.page).toBe('订阅与额度管理')
  })

  /**
   * ★ **深链这一格 2026-10-03(卡 QT)填上了一条,另两条仍旧空着 —— 三条都是查实的结果。**
   *
   * - **Muse**:`endo-window://settings`。包里注册了 `endo-window`,二进制里那一行是
   *   `endo-window://permissions`,而窗名那一组里有 `settings` —— 真机上开了一次
   *   (`probe quota-link com.meta.endo endo-window://settings`),设置窗开出来、第一页上
   *   「使用情况」/「Free plan」/「Weekly limit resets on Oct 8」/「0% used」四条全命中,
   *   `front_before == front_after`(没抢焦点)。
   * - **豆包**:包里**压根没有 `CFBundleURLTypes`**,一条 scheme 都不注册 —— 这一家**永远**没有深链。
   * - **Manus**:注册了 `manus`,**没查实过**哪条地址开得到首页 / 积分那一格,所以空着(D13)。
   */
  it('★深链:查实了的填上,没查实的宁可空着', () => {
    expect(MUSE_WINDOW.reach?.link).toBe('endo-window://settings')
    expect(MANUS_WINDOW.reach?.link).toBeUndefined()
    expect(DOUBAO_WINDOW.reach?.link).toBeUndefined()
  })

  it('★自动那一轮**不开**深链(`open -g` 对 URL 不生效,会把它顶到台前);她亲手点「读一下」才开', async () => {
    // 0.4.92 热修(2026-10-03 22:4x):装上后 Muse 每轮自动读、她一切走就又被顶到台前,5 分钟 22 次,关都关不掉。
    const specs = new Map([['fake', fakeSpec({ reach: { page: '用量', link: 'fake://usage' } })]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake' }], hit: false, specs })
    await reader.refresh()
    expect(w.ran).not.toContainEqual(backgroundLinkCommand('fake://usage'))
    await reader.refresh(['fake'], { press: true })
    expect(w.ran).toContainEqual(backgroundLinkCommand('fake://usage'))
    expect(backgroundLinkCommand('fake://usage')).toContain('-g')
  })

  it('★这一次就读到了的,不开深链、不按键(别无故动她的 App)', async () => {
    const specs = new Map([['fake', fakeSpec({ reach: { page: '用量', link: 'fake://usage' } })]])
    const { reader, world: w } = world({ apps: [{ bundle_id: 'com.example.fake' }], hit: true, specs })
    await reader.refresh()
    expect(w.ran).toEqual([])
    expect(w.sent.some(one => one.op === 'agent_press')).toBe(false)
  })

  /**
   * ★ 按钮那一步**只在她亲手点「读一下」时走**。今天壳的 `agent_press` 点之前必须把那家
   * **叫到台前**(`TextInsert.frontForWindowAction`;Electron 那几家在后台按了不作数)——
   * 那就是抢焦点,与这张卡「不抢她的焦点」直接冲突。所以自动那一轮一颗键都不按;
   * 要让自动那一轮也走到那一页,得有一条**不叫台前**的壳 op(交接里写了设计,留给下一张卡)。
   */
  it('★自动那一轮一颗键都不按;她点「读一下」(press:true)才按那几颗', async () => {
    const reach = { page: '用量', press: ['设置', '用量'] } as const
    const specs = new Map([['fake', fakeSpec({ reach })]])
    const auto = world({ apps: [{ bundle_id: 'com.example.fake' }], hit: false, specs })
    await auto.reader.refresh()
    expect(auto.world.sent.some(one => one.op === 'agent_press')).toBe(false)

    const byHand = world({ apps: [{ bundle_id: 'com.example.fake' }], hit: false, specs })
    await byHand.reader.refresh(undefined, { press: true })
    const pressed = byHand.world.sent.filter(one => one.op === 'agent_press').map(one => one.label)
    expect(pressed).toEqual(['设置', '用量'])
  })
})

/**
 * 开集那条路(2026-09-26,卡 QO:没有专门读法的那几家 —— 今天 Grok Bot / Antigravity)。
 * 现场里 **Grok Bot 也停在 09-26**,走的就是这一条,所以它与窗口型那三家**同一条链**(卡 QZ)。
 */
describe('额度自己读到 · 开集那几家(Grok Bot)走同一条链', () => {
  const GROK = { id: 'grok', title: 'Grok Bot', bundleId: 'com.anysphere.sand' }

  it('★藏着的那一家第一眼也是按原样读(unhide:false;卡 QT 同 readOne)', async () => {
    const { reader, world: w } = world({ apps: [{ bundle_id: GROK.bundleId, hidden: true }] })
    await reader.refreshOpen([GROK])
    const reads = w.sent.filter(one => one.op === 'read_texts' && one.bundle_id === GROK.bundleId)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0]?.unhide).toBe(false)
  })

  it('★没在跑 + 她点「读一下」(byHand)→ 后台起它、藏回去、再读;自动那一轮不起', async () => {
    const { reader, world: w } = world({ apps: [] })
    await reader.refreshOpen([GROK])
    expect(w.ran).toEqual([])
    await reader.refreshOpen([GROK], { full: true, byHand: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand(GROK.bundleId))
    expect(w.sent.some(one => one.op === 'hide_app' && one.bundle_id === GROK.bundleId)).toBe(true)
    expect(w.sent.some(one => one.op === 'read_texts' && one.bundle_id === GROK.bundleId)).toBe(true)
  })

  it('★它在前台(她在用)→ 一条 read_texts 都不发、这一格一个字不改', async () => {
    const { reader, world: w } = world({ apps: [{ bundle_id: GROK.bundleId, active: true }] })
    await reader.refreshOpen([GROK])
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(false)
    expect(reader.openReadings().grok).toBeUndefined()
    expect(w.logs.join('\n')).toContain('在前台')
  })

  it('★她点「读一下」、起不来 → 不读、如实记 not_running(格子照旧摆上次那个数)', async () => {
    const { reader, world: w } = world({ apps: [], launchOk: false })
    await reader.refreshOpen([GROK], { full: true, byHand: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand(GROK.bundleId))
    expect(w.sent.some(one => one.op === 'read_texts')).toBe(false)
    expect(reader.openReadings().grok?.attempt?.error).toBe('not_running')
  })
})

describe('额度自己读到 · 这一轮该走哪一步(一处判)', () => {
  it('★她在用 → 跳过;没在跑 → 起它;在跑 → 读;问不出来 → 照旧读', () => {
    expect(quotaReadStepFor({ running: true, active: true })).toBe('in_use')
    expect(quotaReadStepFor({ running: false, active: false })).toBe('launch')
    expect(quotaReadStepFor({ running: true, active: false })).toBe('read')
    // 问不出来(老壳 / 这一下没回话):**不猜** —— 照这一版之前那样只读一次(D13)。
    expect(quotaReadStepFor(undefined)).toBe('read')
  })
})
