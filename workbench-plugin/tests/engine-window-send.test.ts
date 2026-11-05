// @vitest-environment node
/**
 * **一个 `WindowAdapter` 管窗口型那七家**(2026-10-02,卡「窗口适配器」)。
 *
 * 维护者 10-02:「嘴上说着不打补丁,结果全是打补丁」。这一份守的就是「不打补丁」那句话:
 * 七家走的是**同一段代码**,所以每一家的三条用例也是同一张表跑出来的 ——
 * 哪天有人为某一家在里面加一个 `if`,这张表里别家那几条照旧绿、而这一家多出来的那一下没人守,
 * 下一次就又成了「一修一个不达预期」。
 *
 * 每家三条:
 * ① **送到** —— 开到那一段 → 打字发送 → 按证据核(记号认出那段对话 = 卡 AW 第一档);
 * ② **没窗口、重开之后送到** —— 壳说「一扇标准窗口都没有」→ `open -b` 把窗开出来、等一拍 → 再送一遍;
 * ③ **别的失败一回都不重开** —— 那是那扇窗上的事实,重开只会多打一遍(这一条是最怕的事)。
 *
 * ②③ 两种壳的形状**都测**:回 `{ok:false}` 与 **reject 一个 Error**(真壳是后一种;
 * 10-01 20:57 真机 4505d5da 就是栽在这 —— 「没窗口」直接落进 catch、绕过了开窗那一圈)。
 */
import { describe, expect, it } from 'vitest'
import { createWindowAdapter, quietProofAllowed } from '../src/server/engine/adapters/window.ts'
import type { WindowAdapterDeps, WindowPackage } from '../src/server/engine/adapters/window.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import { NO_WINDOW_GAVE_UP } from '../src/server/windowWake.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
/** 壳那句「没应声」的原话与那句人话:两边都取导出的那一份,不逐字抄中文(卡 N)。 */
import { HELPER_TIMEOUT_REASON } from '../src/server/helperChannel.ts'
import { humanizeFailure } from '../src/server/dispatchClient.ts'

/** 壳那句原话(`SendTextPolicy.Failure.noWindow`,workbench-app/Sources/SendTextPolicy.swift)。 */
const NO_WINDOW = '找不到窗口:<包> 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)'
/** 别的失败一例(辅助功能那一层回了错):这一类**一回都不重开、一个包都不换**。 */
const AX_ERROR = '它窗口里点不动:AXPress 回 -25200'
/** 这份壳会的那几件本事(真壳 hello 里的 `caps`)。 */
const CAPS = ['new_conversation', 'read_reply', 'agent_pick', 'agent_press', 'agent_write_ask', 'agent_stop', 'agent_approval']

interface ShellOptions {
  /** 哪一个 op 要先失败几次。 */
  op?: HelperRequest['op']
  failTimes?: number
  error?: string
  /** 像真壳那样 **reject 一个 Error**(不是回 `{ok:false}`)。 */
  rejects?: boolean
  /**
   * ★ **这一下壳报了失败,可字其实已经送进去了**(2026-10-13,卡 N 的真机现场):
   * 17:42 豆包那一送 `send_text` 整 60 秒没回,而窗口里那句「【工作台派活 c43a90】…」明明进去了。
   * 打开它 = 失败那一下照旧算「送出去过」(`read: 'after_send'` 那一档于是在失败之后也看得见)。
   */
  landed?: boolean
  /** 那个 op 成功时回什么。 */
  ok?: Record<string, unknown>
  caps?: readonly string[]
  /**
   * `read_reply` 回什么。缺省 = 认出来了(记号那一档旁证成立);
   * `'after_send'` = 送之前没这句、送完才有(**读窗前后比**那一档,派活新开一条走的是它)。
   */
  read?: Record<string, unknown> | 'after_send'
}

function shell(options: ShellOptions = {}) {
  const requests: HelperRequest[] = []
  /**
   * ★ **这份壳压根读不回话**(`read` 那一格给的是一个失败回包)。真壳上这两件事是一起的:
   * 会读回话的壳才会读整扇窗 —— 旧壳两个 op 都不认(`HelperSocket` 回「未知 op」),
   * 不会出现「`read_reply` 回失败、`agent_read` 却好好读回来一扇窗」这种壳。
   * 只让 `read_reply` 失败,「读不回来」那一条就被豆包一家的退路接住、变成了「读窗也没看见」。
   */
  const readBroken = typeof options.read === 'object' && (options.read as { ok?: unknown }).ok === false
  let failed = 0
  /** 送进去了没有(`read: 'after_send'` 那一档靠它分「送前」「送后」)。 */
  let sentOk = false
  let lastSent = ''
  return {
    requests,
    countOf: (op: HelperRequest['op']): number => requests.filter(one => one.op === op).length,
    helper: {
      connected: () => true,
      supports: (cap: string) => (options.caps ?? CAPS).includes(cap),
      request: async (req: HelperRequest): Promise<Record<string, unknown>> => {
        requests.push(req)
        if (req.op === 'read_reply') {
          if (options.read === 'after_send') return { ok: true, result: { found: sentOk } }
          return options.read ?? { ok: true, result: { found: true } }
        }
        /*
         * 读整扇窗(豆包一家认不出时会退到这一下,2026-10-12 起按家族)。照真壳回一扇窗:
         * `after_send` 那一档送出后对话区里看得见刚送的那句,别的档都看不见(「读窗也没看见」)。
         *
         * ★ **这一包不许套 `{ok,result}`**:`readRelayEvidence` 里这一下是 `parseRead(await helper.request(...))`
         * (不过 `helperOutcome`),而真通道 resolve 出来的就是回包本身(`HelperSocket.swift` 的 `agent_read`
         * 把 `running` / `window` / `input` / `tail` 直接摆在顶上,`agentDiscovery.readOne` 也是这么收的)。
         * 套一层就成了 `running` 缺席 → `parseRead` 判「没在跑」→ 这一路一律回读不到,
         * 「读窗前后比」那一档永远缺席(新开一条会报成「没能核实」)。
         */
        if (req.op === 'agent_read') {
          if (readBroken) throw new Error('未知 op:agent_read')
          const tail = options.read === 'after_send' && sentOk && lastSent !== '' ? [{ t: lastSent, x: 120, y: 300, w: 600, h: 20 }] : []
          return { running: true, window: { w: 1000, h: 800 }, input: { x: 100, y: 700, w: 800, h: 60 }, tail, side: [], stop: [] }
        }
        if (req.op === options.op && failed < (options.failTimes ?? 0)) {
          failed += 1
          // 壳报失败、字其实进去了那一种(卡 N):这一下照旧算「送出去过」。
          if (req.op === 'send_text' && options.landed === true) {
            sentOk = true
            lastSent = typeof (req as { text?: unknown }).text === 'string' ? (req as { text: string }).text : ''
          }
          if (options.rejects === true) throw new Error(options.error ?? NO_WINDOW)
          return { ok: false, error: options.error ?? NO_WINDOW }
        }
        if (req.op === 'send_text') { sentOk = true; lastSent = typeof (req as { text?: unknown }).text === 'string' ? (req as { text: string }).text : '' }
        /*
         * ★ 真壳的 `send_text` **只要 `submit` 为真就一定报 `submitted`**
         * (`workbench-app/Sources/TextInsert.swift`:`result["submitted"] = submitted.ok`)。
         * 2026-10-02 起适配器按卡 AW 的原话算第一档证据 ——「送之前那段对话认在前台了,
         * **而且回执说发出去了**」—— 所以这份假壳也要照真壳报这一格
         * (回执说没发出去那一种另有一条用例钉着)。
         */
        if (req.op === 'send_text') return { ok: true, result: { submitted: true, ...(req.op === options.op ? (options.ok ?? {}) : {}) } }
        return { ok: true, result: req.op === options.op ? (options.ok ?? {}) : {} }
      },
    },
  }
}

interface Row {
  /** 她嘴里的那一家。 */
  title: string
  /** 登记表 id(运行时发现的那两家 id 就是包标识)。 */
  family: string
  bundle: string
  installed: readonly WindowPackage[]
}

/**
 * **窗口型那七家**(卡上点名的那一列)。前两条是**同一家的两个包**
 * (`doubao` 一家在 Air 上装着好几个 —— 「豆包办公」是她嘴里那个办公版)。
 * 后两条是**表外的一家**:家名就是包标识,从来没进过 `FAMILY_SOURCES` —— 它们走缺省行,
 * **一行代码、一行配置都没为它们加**,这正是「新接上一家不用改代码」的证据。
 */
const ROWS: readonly Row[] = [
  { title: '豆包办公', family: 'doubao', bundle: 'com.work.pc.doubao', installed: [{ bundle_id: 'com.work.pc.doubao', name: '豆包工作', running: true }] },
  { title: '豆包', family: 'doubao', bundle: 'com.bot.pc.doubao', installed: [{ bundle_id: 'com.bot.pc.doubao', name: '豆包', running: true }] },
  { title: 'Kimi', family: 'kimi', bundle: 'com.moonshot.kimichat', installed: [{ bundle_id: 'com.moonshot.kimichat', name: 'Kimi', running: true }] },
  { title: 'Manus', family: 'manus', bundle: 'im.manus.desktop', installed: [{ bundle_id: 'im.manus.desktop', name: 'Manus', running: true }] },
  { title: 'Muse', family: 'muse', bundle: 'com.meta.endo', installed: [{ bundle_id: 'com.meta.endo', name: 'Muse', running: true }] },
  { title: 'Antigravity', family: 'com.google.antigravity', bundle: 'com.google.antigravity', installed: [{ bundle_id: 'com.google.antigravity', name: 'Antigravity', running: true }] },
  { title: 'Grok Bot', family: 'com.anysphere.sand', bundle: 'com.anysphere.sand', installed: [{ bundle_id: 'com.anysphere.sand', name: 'Grok Bot', running: true }] },
]

/**
 * 接出来的那几样都是注入的 —— 用例里一次也不会真激活维护者的窗口。
 * `wake: false` = **一样能开窗的本事都没有**(没注入 `openApp` / `openUrl`),那一圈就该一回都不重开。
 */
interface Wiring {
  installed?: () => readonly WindowPackage[] | undefined
  bundleOf?: () => string | undefined
  hostIdOf?: () => string | undefined
  wake?: boolean
}

function adapterFor(row: Row, fake: ReturnType<typeof shell>, wiring: Wiring = {}) {
  const openedApps: string[] = []
  const openedUrls: string[] = []
  const fronted: string[] = []
  const wake = wiring.wake !== false
  const deps: WindowAdapterDeps = {
    helper: fake.helper,
    installed: wiring.installed ?? (() => row.installed),
    bundleOf: wiring.bundleOf ?? (() => row.bundle),
    nameOf: () => row.title,
    ...(wiring.hostIdOf === undefined ? {} : { hostIdOf: wiring.hostIdOf }),
    ...(wake
      ? {
          openApp: async (bundleId: string) => { openedApps.push(bundleId); return { ok: true } },
          openUrl: async (url: string) => { openedUrls.push(url); return { ok: true } },
        }
      : {}),
    bringToFront: async (bundleId: string) => { fronted.push(bundleId); return { ok: true } },
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { openedApps, openedUrls, fronted, it: createWindowAdapter(row.family, deps) }
}

/** 捎话那一件:送进她点名的那条已有对话(`marks[0]` = 那条对话在侧栏里的名字 / 认它的头一截原话)。 */
function relayJob(id = 'job-1'): Job {
  return {
    id,
    family: 'x',
    kind: 'relay',
    target: { kind: 'session', sessionId: 'window:825f1900' },
    text: '现在进行到什么情况,大概什么时候能处理完',
    marks: ['统筹交接'],
    expect: 'ack',
  }
}

function sendText(requests: readonly HelperRequest[]): Extract<HelperRequest, { op: 'send_text' }> | undefined {
  return requests.find(one => one.op === 'send_text') as Extract<HelperRequest, { op: 'send_text' }> | undefined
}

describe.each(ROWS)('窗口型:$title', (row) => {
  it('★送到:开到那一段 → 打字发送 → 记号认出那段对话 = 核上了', async () => {
    const fake = shell()
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('confirmed')
    expect(got.evidence).toBe('window')
    expect(got.via).toBe('window')
    expect(got.sessionId).toBe('window:825f1900')
    // 送进去的是**她的原话**,而且替她按了发送(手机上她按不到那家的回车)。
    const sent = sendText(fake.requests)
    expect(sent?.bundle_id).toBe(row.bundle)
    expect(sent?.text).toBe(relayJob().text)
    expect(sent?.submit).toBe(true)
    // 捎进已有对话**不开新对话**(开了就打到另一条上去了)。
    expect(sent?.new_conversation).toBeUndefined()
    // 一回都没重开窗(壳没说没窗口)。
    expect(made.openedApps).toEqual([])
  })

  for (const rejects of [false, true]) {
    const shape = rejects ? 'reject 一个 Error(真壳这一种)' : '回 {ok:false}'
    it(`★没窗口、把窗开出来再送一遍就送到了(壳${shape})`, async () => {
      const fake = shell({ op: 'send_text', failTimes: 1, rejects })
      const made = adapterFor(row, fake)
      const got = await made.it.run(relayJob())
      expect(got.delivered).toBe('confirmed')
      // 真把它的窗开出来过(`open -b <包标识>`),而且送了两回。
      expect(made.openedApps).toEqual([row.bundle])
      expect(fake.countOf('send_text')).toBe(2)
    })

    it(`★别的失败一回都不重开、一个包都不换(壳${shape})`, async () => {
      const fake = shell({ op: 'send_text', failTimes: 99, error: AX_ERROR, rejects })
      const made = adapterFor(row, fake)
      const got = await made.it.run(relayJob())
      expect(got.delivered).toBe('not_sent')
      // 壳那句原话原样带走(归不出类的不猜,D13),而且不许接上「又开了几回」那一句。
      expect(got.why).toContain(AX_ERROR)
      expect(got.why).not.toContain(NO_WINDOW_GAVE_UP)
      expect(made.openedApps).toEqual([])
      expect(fake.countOf('send_text')).toBe(1)
    })

    /*
     * ★ **壳这一送没应声:再核一眼窗口再定**(2026-10-13,卡 N)。
     * 这两条放在 `describe.each` 里 = **七家同一条送话路一起受益**(卡上第 3 条:别家也不许误伤)。
     */
    it(`★壳没应声、可窗口里看得见那句话 → 按送到了记(壳${shape})`, async () => {
      const fake = shell({ op: 'send_text', failTimes: 99, error: HELPER_TIMEOUT_REASON, rejects, landed: true, read: 'after_send' })
      const made = adapterFor(row, fake)
      const got = await made.it.run(relayJob())
      expect(got.delivered).toBe('confirmed')
      expect(got.evidence).toBe('window')
      expect(got.submitted).toBe(true)
      // 一个字都没再往那扇窗里送(只多读了几眼),一回窗也没重开。
      expect(fake.countOf('send_text')).toBe(1)
      expect(made.openedApps).toEqual([])
    })

    it(`★壳没应声、窗口里也看不见 → 照旧 not_sent,话是人话、原因留在后半句(壳${shape})`, async () => {
      const fake = shell({ op: 'send_text', failTimes: 99, error: HELPER_TIMEOUT_REASON, rejects, read: 'after_send' })
      const made = adapterFor(row, fake)
      const got = await made.it.run(relayJob())
      expect(got.delivered).toBe('not_sent')
      // 前半句是人话(「壳」「超时」这些内部口径不许进第一个分号之前那半句 —— 嘴那一侧只念它)。
      const spoken = (got.why ?? '').split(';')[0] as string
      expect(spoken).toBe(humanizeFailure(HELPER_TIMEOUT_REASON, row.family))
      expect(spoken).not.toContain(HELPER_TIMEOUT_REASON)
      // 原因照旧留在卡上(后半句)。
      expect(got.why).toContain(HELPER_TIMEOUT_REASON)
      expect(fake.countOf('send_text')).toBe(1)
      expect(made.openedApps).toEqual([])
    })
  }
})

/**
 * ★ **「送之前没有、送之后出现」那条底子**(2026-10-13,卡 N;判据 {@link quietProofAllowed})。
 * 这几条是纯函数,钉的是「什么时候敢把『窗口里看见了』当凭据」。
 */
describe('壳没应声:哪一种敢认「它之前不在那儿」', () => {
  const dispatch: Job = { id: 't-c43a9009', family: 'doubao', kind: 'dispatch', target: { kind: 'new' }, text: '【工作台派活 c43a90】请帮我生成一张图片', expect: 'ack', itemId: 't-c43a9009', confirmMark: '工作台派活 c43a90' }

  it('★送之前读得出来、没看见 → 认(最硬的一种)', () => {
    expect(quietProofAllowed(dispatch, false)).toBe(true)
    expect(quietProofAllowed(relayJob(), false)).toBe(true)
  })

  it('★送之前就看见了 → 一律不认(那一行不是这一送留下的)', () => {
    expect(quietProofAllowed(dispatch, true)).toBe(false)
    expect(quietProofAllowed(relayJob(), true)).toBe(false)
  })

  it('★送之前读不出来:派活第一回认(标记行是这张卡自己的短 id),重派不认', () => {
    expect(quietProofAllowed(dispatch, undefined)).toBe(true)
    expect(quietProofAllowed({ ...dispatch, attempt: 2 }, undefined)).toBe(false)
    expect(quietProofAllowed({ ...dispatch, confirmMark: '  ' }, undefined)).toBe(false)
  })

  it('★送之前读不出来:捎话 / 替她答那一路不认(记号是她那句话的前 20 字,她自己发过就撞上)', () => {
    expect(quietProofAllowed(relayJob(), undefined)).toBe(false)
    expect(quietProofAllowed({ ...relayJob(), kind: 'answer' }, undefined)).toBe(false)
  })
})

describe('没窗口到顶:如实说 + 说出又开了几回', () => {
  it('★一直没窗口、这一家只有一个包 → not_sent,话里带着「又开了几回」', async () => {
    const row = ROWS[3] as Row
    const fake = shell({ op: 'send_text', failTimes: 99, rejects: true })
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain(NO_WINDOW_GAVE_UP)
    // 开窗那几回在 `windowWake` 一处定上限(NO_WINDOW_WAKE_TRIES);这里只确认真开过。
    expect(made.openedApps.length).toBeGreaterThan(0)
  })

  it('★一样能开窗的本事都没有(没注入 openApp / openUrl)→ 一回都不重开', async () => {
    const row = ROWS[4] as Row
    const fake = shell({ op: 'send_text', failTimes: 99 })
    const made = adapterFor(row, fake, { wake: false })
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('not_sent')
    expect(fake.countOf('send_text')).toBe(1)
    expect(got.why).not.toContain(NO_WINDOW_GAVE_UP)
  })
})

describe('一家多包:送不进去就换一个,她点名的不换', () => {
  /** Air 上同时装着三个豆包(2026-10-01 诊断包 095718)。 */
  const THREE: readonly WindowPackage[] = [
    { bundle_id: 'com.bot.pc.doubao', name: '豆包' },
    { bundle_id: 'com.work.pc.doubao', name: '豆包工作', running: true },
    { bundle_id: 'com.bot.neotix.doubao', name: '豆包(App Store)', running: true },
  ]
  const row: Row = { title: '豆包办公', family: 'doubao', bundle: 'com.work.pc.doubao', installed: THREE }

  it('★挑中的那个没窗口 → 抛「可以再来一次」,换哪一个由适配器说(重不重来由引擎定)', async () => {
    const fake = shell({ op: 'send_text', failTimes: 99, rejects: true })
    const made = adapterFor(row, fake)
    await expect(made.it.run(relayJob('job-swap'))).rejects.toThrow(/换那一个再送一回/)
    // 第一回动的是家族目录挑中的那个(开着的那一个)。
    expect(sendText(fake.requests)?.bundle_id).toBe('com.work.pc.doubao')
  })

  it('★引擎再来一回 → 换一个还没试过的包;都试完了才如实说「都试了」', async () => {
    const fake = shell({ op: 'send_text', failTimes: 99, rejects: true })
    const made = adapterFor(row, fake)
    const job = relayJob('job-swap-2')
    await expect(made.it.run(job)).rejects.toThrow(/换那一个再送一回/)
    await expect(made.it.run(job)).rejects.toThrow(/换那一个再送一回/)
    const last = await made.it.run(job)
    expect(last.delivered).toBe('not_sent')
    expect(last.why).toContain('3 个都试了')
    // 三个包各送过一轮,一个都没重复。
    const bundles = new Set(fake.requests.filter(one => one.op === 'send_text').map(one => (one as { bundle_id: string }).bundle_id))
    expect([...bundles].sort()).toEqual([...THREE].map(one => one.bundle_id).sort())
  })

  it('★她点名了用哪一个(job.package)→ 一个字不换,直接如实说', async () => {
    const fake = shell({ op: 'send_text', failTimes: 99, rejects: true })
    const made = adapterFor(row, fake)
    const got = await made.it.run({ ...relayJob('job-said'), package: 'com.work.pc.doubao' })
    expect(got.delivered).toBe('not_sent')
    expect(got.why).not.toContain('换那一个')
    // 开窗那一圈照旧重试(那是同一个包的事),但**送到的包一个字没换**。
    const bundles = new Set(fake.requests.filter(one => one.op === 'send_text').map(one => (one as { bundle_id: string }).bundle_id))
    expect([...bundles]).toEqual(['com.work.pc.doubao'])
  })

  it('★不知道装了哪几个(没接 installed)→ 主包,一个包都不换', async () => {
    const fake = shell({ op: 'send_text', failTimes: 99, rejects: true })
    const made = adapterFor(row, fake, { installed: () => undefined })
    const got = await made.it.run(relayJob('job-unknown'))
    expect(got.delivered).toBe('not_sent')
    expect(got.why).not.toContain('换那一个')
    expect(sendText(fake.requests)?.bundle_id).toBe('com.bot.pc.doubao')
  })

  it('★探过、一个都没装 → 如实说这台电脑上还没接上', async () => {
    const fake = shell()
    const made = adapterFor(row, fake, { installed: () => [], bundleOf: () => undefined })
    const got = await made.it.run(relayJob('job-none'))
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('还没接上')
    expect(fake.countOf('send_text')).toBe(0)
  })
})

describe('派活(新开一条)', () => {
  /** 豆包那一家(App Store 版那个包);豆包办公另有「读回话要读两次」那一条,见下面那一节。 */
  const row = ROWS[1] as Row
  function dispatchJob(): Job {
    return { id: 'task-1', family: 'doubao', kind: 'dispatch', target: { kind: 'new' }, text: '把这几天的聊天总结一下', expect: 'ack', itemId: 'task-1' }
  }

  it('★新开一条:给壳发 new_conversation', async () => {
    const fake = shell({ read: 'after_send' })
    const made = adapterFor(row, fake)
    const got = await made.it.run(dispatchJob())
    expect(sendText(fake.requests)?.new_conversation).toBe(true)
    // 新开一条没有「那一段」可认 → 记号那一档旁证不成立,靠读窗前后比核;读得了而且看见了就算核上。
    expect(got.delivered).toBe('confirmed')
  })

  it('★旧壳不会先开新对话 → 不送,说清是壳太旧(不打进她正开着的那条对话)', async () => {
    const fake = shell({ caps: ['read_reply'] })
    const made = adapterFor(row, fake)
    const got = await made.it.run(dispatchJob())
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('先开一条新对话')
    expect(fake.countOf('send_text')).toBe(0)
  })
})

describe('豆包办公:read_reply 认不出就再读一次整扇窗(判断在 readRelayEvidence 一处)', () => {
  it('★豆包办公(com.work.pc.doubao)认不出 → 多发一条 agent_read', async () => {
    const fake = shell({ read: { ok: true, result: { found: false } } })
    const made = adapterFor(ROWS[0] as Row, fake)
    await made.it.run(relayJob('job-work'))
    expect(fake.countOf('agent_read')).toBeGreaterThan(0)
  })

  // 2026-10-12(卡「豆包问题打座机」):按家族认,不再只对办公版那个包 —— 本机的 com.bot.pc.doubao 一样多读。
  it('★同一家的另一个包(com.bot.pc.doubao)认不出 → 一样多读一次整扇窗', async () => {
    const fake = shell({ read: { ok: true, result: { found: false } } })
    const made = adapterFor(ROWS[1] as Row, fake)
    await made.it.run(relayJob('job-bot'))
    expect(fake.countOf('agent_read')).toBeGreaterThan(0)
  })
})

describe('核不上的那两档:一个字不说成送到了', () => {
  const row = ROWS[1] as Row

  it('★回执说没发出去(豆包真机那一种)→ unconfirmed,而且要紧的是叫她**别重发**', async () => {
    /*
     * 2026-09-28 Air 维护包真机:豆包按了发送、回执说没发,可它**其实收到了**。
     * 所以这一下既不说成送到了、也不当失败 ——「未确证」+ `SEND_RECEIPT_UNSURE`
     * (那句话最要紧的半句是「不要重复发送」)。
     *
     * 这一条守的是卡 AW 第一档的后半句:`matched`(送之前那段对话认在前台了)**只是旁证**,
     * 要带上回执才算核上;少了它就会出真机那个毛病 —— 回执说没发,我们报「送到了」。
     */
    const fake = shell({ op: 'send_text', ok: { submitted: false } })
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('unconfirmed')
    expect(got.submitted).toBe(false)
    expect(got.why).toContain('不要重复发送')
  })

  it('★记号认不出那段对话、读窗也没看见 → unconfirmed + 「可能发到了别的对话」', async () => {
    const fake = shell({ read: { ok: true, result: { found: false } } })
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('unconfirmed')
    expect(got.evidence).toBe('none')
    expect(got.why).toContain('可能发到了别的对话')
  })

  it('★旧壳读不回来(read_reply 回失败)→ unconfirmed + 「没能核实」', async () => {
    const fake = shell({ read: { ok: false, error: '未知 op' } })
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(got.delivered).toBe('unconfirmed')
    expect(got.why).toContain('没能核实')
  })
})

describe('永不送的那几家', () => {
  it('★微信:unsupported + 人话,一个 op 都不发', async () => {
    const fake = shell()
    const row: Row = { title: '微信', family: 'com.tencent.xinWeChat', bundle: 'com.tencent.xinWeChat', installed: [{ bundle_id: 'com.tencent.xinWeChat', name: '微信' }] }
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob('job-wechat'))
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
    expect(got.why).toContain('跟人聊天')
    expect(fake.requests).toEqual([])
  })

  it('★企业微信:同一条路、同一句话', async () => {
    const fake = shell()
    const row: Row = { title: '企业微信', family: 'com.tencent.WeWorkMac', bundle: 'com.tencent.WeWorkMac', installed: [{ bundle_id: 'com.tencent.WeWorkMac', name: '企业微信' }] }
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob('job-wework'))
    expect(got.unsupported).toBe(true)
    expect(fake.requests).toEqual([])
  })
})

describe('Codex / Claude:窗口是它们的第二条路', () => {
  it('★Codex 有深链(会话 id 就是 threadId)→ 开它', async () => {
    const fake = shell()
    const row: Row = { title: 'Codex', family: 'codex', bundle: 'com.openai.codex', installed: [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }] }
    const made = adapterFor(row, fake)
    const got = await made.it.run({ ...relayJob('job-codex'), target: { kind: 'session', sessionId: 'thread_abc' } })
    expect(got.delivered).toBe('confirmed')
    expect(made.openedUrls).toEqual(['codex://threads/thread_abc'])
  })

  it('★Claude 读到桌面 App 的编号 → 开深链;读不到 → 退回侧栏点一下,不编一条链', async () => {
    const row: Row = { title: 'Claude', family: 'claude', bundle: 'com.anthropic.claudefordesktop', installed: [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }] }
    const withId = adapterFor(row, shell(), { hostIdOf: () => 'local_aceefe64' })
    await withId.it.run(relayJob('job-claude-1'))
    expect(withId.openedUrls).toEqual(['claude://code/continue?session=local_aceefe64'])

    // 读不到编号:一条链都不开 —— 记号认得出那段对话就不用点侧栏。
    const noId = shell({ read: { ok: true, result: { found: false } } })
    const without = adapterFor(row, noId, { hostIdOf: () => undefined })
    await without.it.run(relayJob('job-claude-2'))
    expect(without.openedUrls).toEqual([])
    expect(noId.countOf('agent_pick')).toBe(1)
  })
})

describe('开到那一段:记号认不出就在侧栏里点那一行', () => {
  const row = ROWS[3] as Row

  it('★认不出 → agent_pick 点那条对话的名字;点完重新认一次', async () => {
    const fake = shell({ read: { ok: true, result: { found: false } } })
    const made = adapterFor(row, fake)
    await made.it.run(relayJob())
    const pick = fake.requests.find(one => one.op === 'agent_pick') as Extract<HelperRequest, { op: 'agent_pick' }> | undefined
    expect(pick?.title).toBe('统筹交接')
  })

  it('★旧壳不会在侧栏里点行 → 不点,照样发(认不出也发,卡 AW)', async () => {
    const fake = shell({ caps: ['read_reply', 'new_conversation'], read: { ok: true, result: { found: false } } })
    const made = adapterFor(row, fake)
    const got = await made.it.run(relayJob())
    expect(fake.countOf('agent_pick')).toBe(0)
    expect(fake.countOf('send_text')).toBe(1)
    expect(got.delivered).toBe('unconfirmed')
  })
})

describe('壳没连上', () => {
  it('★一句原话都不发,如实说', async () => {
    const row = ROWS[2] as Row
    const requests: HelperRequest[] = []
    const made = createWindowAdapter(row.family, {
      helper: { connected: () => false, supports: () => true, request: async (req) => { requests.push(req); return {} } },
      installed: () => row.installed,
      nameOf: () => row.title,
      sleep: async () => {},
    })
    const got = await made.run(relayJob('job-down'))
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('工作台 App 没连上')
    expect(requests).toEqual([])
  })
})
