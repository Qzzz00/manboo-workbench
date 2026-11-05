// @vitest-environment node
/**
 * **替她点一下 / 批一次 / 写一句 / 按停止:同一个 `WindowAdapter`**(2026-10-02,卡「窗口适配器」)。
 *
 * 这四样原来是 `sessionAnswer.createWindowAnswerHand` 上四只分开的手(`press` / `readApproval` +
 * `pressApproval` / `writeAsk` / `stop`),各自一套「壳没连上」「壳太旧」「没窗口重开」「成没成」的写法。
 * 现在只有一条路,区别只在 `Job.kind`。
 *
 * 守的口径(每一样都**不许假装做到了**):
 * - 点选项:点完**重读一次,那一项没了**才算答上了(`gone`);
 * - 批准:`approvalKeys` 挑那一块、那一颗(**放宽的那一类一颗都不给**),按完**那颗键没了**才算批了;
 * - 写面板:**面板没了 + 窗口里出现了她那句**,两条都成立才算;
 * - 按停止:壳说 `stopped` 才算停了。
 *
 * 壳的两种形状都测:回 `{ok:false}` 与 **reject 一个 Error**(真壳是后一种)。
 */
import { describe, expect, it } from 'vitest'
import { createWindowAdapter } from '../src/server/engine/adapters/window.ts'
import type { WindowAdapterDeps } from '../src/server/engine/adapters/window.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const FAMILY = 'manus'
const BUNDLE = 'im.manus.desktop'
const NO_WINDOW = '找不到窗口:im.manus.desktop 在跑,但一扇标准窗口都没有'
const AX_ERROR = '它窗口里点不动:AXPress 回 -25200'
const CAPS = ['read_reply', 'agent_pick', 'agent_press', 'agent_write_ask', 'agent_stop', 'agent_approval']

/** 这一回答什么:一包回包、`'reject'`(像真壳那样抛)、或者一句失败原话。 */
type Answer = Record<string, unknown> | 'reject' | { fail: string, rejects?: boolean }
/** 壳那一下的名字。`agent_approval` 分「只读一眼」与「按那一颗」两种(同一个 op、两种用法)。 */
type OpKey = HelperRequest['op'] | 'agent_approval_press'

const DEFAULTS: Partial<Record<OpKey, Record<string, unknown>>> = {
  read_reply: { found: true },
  agent_press: { found: true, pressed: true, gone: true },
  agent_write_ask: { found: true, wrote: true, submitted: true, gone: true, echoed: true },
  agent_stop: { found: true, pressed: true, stopped: true },
  agent_approval_press: { found: true, pressed: true, gone: true },
}

/** 真机上那个权限弹窗读回来的样子(一块容器 + 两颗键)。 */
const PANEL = { rect: { x: 10, y: 10, w: 300, h: 120 }, keys: ['Allow once', "Don't allow"] }
/** 能批的只有放宽的那一颗(「本次会话都允许」)—— 这一块**一颗都不许按**。 */
const BROAD_PANEL = { rect: { x: 10, y: 10, w: 300, h: 120 }, keys: ['Allow for this session', "Don't allow"] }
/** 它明写的选项框(不是权限弹窗:没有「拒绝」那一类)。 */
const OPTION_PANEL = { rect: { x: 10, y: 10, w: 300, h: 120 }, keys: ['方案 A', '方案 B'] }

function opKeyOf(req: HelperRequest): OpKey {
  return req.op === 'agent_approval' && (req as { press?: string }).press !== undefined ? 'agent_approval_press' : req.op
}

function shell(answers: Partial<Record<OpKey, readonly Answer[]>> = {}, caps: readonly string[] = CAPS) {
  const requests: HelperRequest[] = []
  const used = new Map<OpKey, number>()
  return {
    requests,
    countOf: (op: OpKey): number => requests.filter(one => opKeyOf(one) === op).length,
    reqOf: (op: OpKey): HelperRequest | undefined => requests.find(one => opKeyOf(one) === op),
    helper: {
      connected: () => true,
      supports: (cap: string) => caps.includes(cap),
      request: async (req: HelperRequest): Promise<Record<string, unknown>> => {
        requests.push(req)
        const key = opKeyOf(req)
        const list = answers[key]
        let answer: Answer | undefined
        if (list !== undefined && list.length > 0) {
          const index = Math.min(used.get(key) ?? 0, list.length - 1)
          used.set(key, (used.get(key) ?? 0) + 1)
          answer = list[index]
        }
        if (answer === 'reject') throw new Error(NO_WINDOW)
        if (answer !== undefined && 'fail' in answer && typeof answer.fail === 'string') {
          if (answer.rejects === true) throw new Error(answer.fail)
          return { ok: false, error: answer.fail }
        }
        return { ok: true, result: (answer as Record<string, unknown> | undefined) ?? DEFAULTS[key] ?? {} }
      },
    },
  }
}

function adapterFor(fake: ReturnType<typeof shell>, caps?: readonly string[], who?: { family: string, bundle: string, name: string }) {
  const openedApps: string[] = []
  const one = who ?? { family: FAMILY, bundle: BUNDLE, name: 'Manus' }
  const deps: WindowAdapterDeps = {
    helper: caps === undefined ? fake.helper : { ...fake.helper, supports: (cap: string) => caps.includes(cap) },
    installed: () => [{ bundle_id: one.bundle, name: one.name, running: true }],
    bundleOf: () => one.bundle,
    nameOf: () => one.name,
    openApp: async (bundleId: string) => { openedApps.push(bundleId); return { ok: true } },
    bringToFront: async () => ({ ok: true }),
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { openedApps, it: createWindowAdapter(one.family, deps) }
}

function job(over: Partial<Job> & Pick<Job, 'kind' | 'text'>): Job {
  return {
    id: 'job-1',
    family: FAMILY,
    target: { kind: 'session', sessionId: 'window:825f1900' },
    expect: 'none',
    ...over,
  }
}

describe('替她点它明写的那一项(agent_press)', () => {
  it('★点完重读一次、那一项没了 → 算答上了', async () => {
    const fake = shell()
    const made = adapterFor(fake)
    const got = await made.it.run(job({ kind: 'press', text: '方案 A', marks: ['方案 A', '方案 B'] }))
    expect(got.delivered).toBe('confirmed')
    expect(got.evidence).toBe('window')
    const req = fake.reqOf('agent_press') as Extract<HelperRequest, { op: 'agent_press' }>
    expect(req.label).toBe('方案 A')
    expect(req.bundle_id).toBe(BUNDLE)
  })

  it('★点了、那一项还在 → 不说成答上了(unconfirmed + 去看一眼)', async () => {
    const fake = shell({ agent_press: [{ found: true, pressed: true, gone: false }] })
    const made = adapterFor(fake)
    const got = await made.it.run(job({ kind: 'press', text: '方案 A', marks: ['方案 A', '方案 B'] }))
    expect(got.delivered).toBe('unconfirmed')
    expect(got.why).toContain('没看到它收下')
  })

  it('★碰到了窗、没找着那一项 → not_sent,壳那句原话原样带走', async () => {
    const fake = shell({ agent_press: [{ found: false, note: '它窗口里有两处都叫「方案 A」,一处都没点' }] })
    const made = adapterFor(fake)
    const got = await made.it.run(job({ kind: 'press', text: '方案 A', marks: ['方案 A'] }))
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('两处都叫')
    expect(made.openedApps).toEqual([])
  })

  it('★旧壳不会点 → unsupported,如实说装上新版就能点', async () => {
    const fake = shell()
    const made = adapterFor(fake, ['read_reply'])
    const got = await made.it.run(job({ kind: 'press', text: '方案 A' }))
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
    expect(fake.countOf('agent_press')).toBe(0)
  })

  for (const rejects of [false, true]) {
    const shape = rejects ? 'reject 一个 Error(真壳这一种)' : '回 {ok:false}'
    it(`★没窗口 → 把窗开出来再点一回就点上了(壳${shape})`, async () => {
      const fake = shell({ agent_press: [{ fail: NO_WINDOW, rejects }, DEFAULTS.agent_press as Record<string, unknown>] })
      const made = adapterFor(fake)
      const got = await made.it.run(job({ kind: 'press', text: '方案 A', marks: ['方案 A'] }))
      expect(got.delivered).toBe('confirmed')
      expect(made.openedApps).toEqual([BUNDLE])
      expect(fake.countOf('agent_press')).toBe(2)
    })

    it(`★别的失败一回都不重开(壳${shape};重开 = 多点一下,这一条最怕)`, async () => {
      const fake = shell({ agent_press: [{ fail: AX_ERROR, rejects }] })
      const made = adapterFor(fake)
      const got = await made.it.run(job({ kind: 'press', text: '方案 A', marks: ['方案 A'] }))
      expect(got.delivered).toBe('not_sent')
      expect(got.why).toContain(AX_ERROR)
      expect(made.openedApps).toEqual([])
      expect(fake.countOf('agent_press')).toBe(1)
    })
  }
})

describe('替她批一次(agent_approval + approvalKeys)', () => {
  const approveJob = (text = 'Allow once'): Job =>
    job({ kind: 'press', text, marks: ['rm -rf ./build', '要不要让它跑这条命令'] })

  it('★读一眼 → 挑那一块那一颗 → 只在那一块里按 → 按完那颗键没了才算批了', async () => {
    const fake = shell({ agent_approval: [{ found: true, panels: [PANEL] }] })
    const made = adapterFor(fake)
    const got = await made.it.run(approveJob())
    expect(got.delivered).toBe('confirmed')
    const pressed = fake.reqOf('agent_approval_press') as Extract<HelperRequest, { op: 'agent_approval' }>
    expect(pressed.press).toBe('Allow once')
    // 只在位置对得上的那一块里按(壳认那一块靠这个矩形)。
    expect(pressed.panel).toEqual(PANEL.rect)
    // 普通选项那条路一次都没走。
    expect(fake.countOf('agent_press')).toBe(0)
  })

  it('★按了、那颗键还在 → 不说成批了', async () => {
    const fake = shell({
      agent_approval: [{ found: true, panels: [PANEL] }],
      agent_approval_press: [{ found: true, pressed: true, gone: false }],
    })
    const made = adapterFor(fake)
    const got = await made.it.run(approveJob())
    expect(got.delivered).toBe('unconfirmed')
    expect(got.why).toContain('没按上')
  })

  it('★★能批的只有「本次会话都允许」那种放宽的键 → 一颗都不按,**也不许退回普通选项那条路**', async () => {
    const fake = shell({ agent_approval: [{ found: true, panels: [BROAD_PANEL] }] })
    const made = adapterFor(fake)
    const got = await made.it.run(approveJob())
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('放宽权限')
    expect(fake.countOf('agent_approval_press')).toBe(0)
    // 这一条是整节的要点:退回 agent_press 就等于替她把这条会话往后的权限放宽了。
    expect(fake.countOf('agent_press')).toBe(0)
  })

  it('★壳圈到的是它明写的选项框(不像权限弹窗)→ 退回 agent_press 按那一项', async () => {
    const fake = shell({ agent_approval: [{ found: true, panels: [OPTION_PANEL] }] })
    const made = adapterFor(fake)
    const got = await made.it.run(job({ kind: 'press', text: 'Allow once', marks: ['要不要让它跑这条命令'] }))
    expect(got.delivered).toBe('confirmed')
    expect(fake.countOf('agent_press')).toBe(1)
  })

  it('★一块都没读到 → 也退回 agent_press(那就不是权限弹窗)', async () => {
    const fake = shell({ agent_approval: [{ found: false, panels: [] }] })
    const made = adapterFor(fake)
    await made.it.run(approveJob())
    expect(fake.countOf('agent_press')).toBe(1)
  })

  it('★她说的那颗键对不上弹窗上的任何一颗 → 一颗都没敢按', async () => {
    const fake = shell({ agent_approval: [{ found: true, panels: [PANEL] }] })
    const made = adapterFor(fake)
    const got = await made.it.run(approveJob('Approve and remember'))
    expect(got.delivered).toBe('not_sent')
    expect(fake.countOf('agent_approval_press')).toBe(0)
  })

  it('★旧壳不会看批准弹窗 → 这一下走普通选项那条路(不假装批了)', async () => {
    const fake = shell()
    const made = adapterFor(fake, ['read_reply', 'agent_press'])
    await made.it.run(approveJob())
    expect(fake.countOf('agent_approval')).toBe(0)
    expect(fake.countOf('agent_press')).toBe(1)
  })

  for (const rejects of [false, true]) {
    const shape = rejects ? 'reject' : '{ok:false}'
    it(`★读那一下没窗口 → 开窗再读一回(壳${shape})`, async () => {
      const fake = shell({ agent_approval: [{ fail: NO_WINDOW, rejects }, { found: true, panels: [PANEL] }] })
      const made = adapterFor(fake)
      const got = await made.it.run(approveJob())
      expect(got.delivered).toBe('confirmed')
      expect(made.openedApps).toEqual([BUNDLE])
    })

    it(`★按那一下别的失败 → 一回都不重开(壳${shape})`, async () => {
      const fake = shell({
        agent_approval: [{ found: true, panels: [PANEL] }],
        agent_approval_press: [{ fail: AX_ERROR, rejects }],
      })
      const made = adapterFor(fake)
      const got = await made.it.run(approveJob())
      expect(got.delivered).toBe('not_sent')
      expect(made.openedApps).toEqual([])
      expect(fake.countOf('agent_approval_press')).toBe(1)
    })
  }
})

describe('把她那句写进它的提问面板(agent_write_ask)', () => {
  /*
   * ★ **这一路只对认准了的那个包开着**(2026-09-28 卡 AT / AT2 的真机口径,2026-10-02 收进
   * `window.WRITE_ASK_PACKAGES` 一处):豆包办公那个面板在真机上认准了(写进去、面板收了、正文里有她那句);
   * 别家关着 —— 0.4.60 真机上 Codex 那个提问框其实已经收了,那句话落进了**底部主输入框**(没发出去),
   * 回包却报「已替你答了」。所以这一组用例动的是那个包,底下另有一条钉着「别家一个字都不写」。
   */
  const DOUBAO = { family: 'doubao', bundle: 'com.work.pc.doubao', name: '豆包工作' }
  const writeAdapter = (fake: ReturnType<typeof shell>, caps?: readonly string[]) => adapterFor(fake, caps, DOUBAO)
  const writeJob = (): Job => ({
    ...job({ kind: 'write_ask', text: '先按方案 A 做,但别动数据库', marks: ['方案 A', '方案 B', '要不要动数据库'] }),
    family: DOUBAO.family,
  })

  it('★别家那个提问面板还没在真机上认准 → 一个字都不写(如实说,不假装写进去了)', async () => {
    const fake = shell()
    const made = adapterFor(fake)
    const got = await made.it.run(job({ kind: 'write_ask', text: '先按方案 A 做', marks: ['方案 A'] }))
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
    expect(fake.countOf('agent_write_ask')).toBe(0)
  })

  it('★面板没了 + 窗口里出现了她那句 —— 两条都成立才算答上了', async () => {
    const fake = shell()
    const made = writeAdapter(fake)
    const got = await made.it.run(writeJob())
    expect(got.delivered).toBe('confirmed')
    const req = fake.reqOf('agent_write_ask') as Extract<HelperRequest, { op: 'agent_write_ask' }>
    // **她那句原文一字不改**(不清洗、不补话、不截断)。
    expect(req.text).toBe('先按方案 A 做,但别动数据库')
    expect(req.marks).toEqual(['方案 A', '方案 B', '要不要动数据库'])
  })

  it('★面板收了、可窗口里没出现她那句 → 不说成答上了', async () => {
    const fake = shell({ agent_write_ask: [{ found: true, wrote: true, submitted: true, gone: true, echoed: false }] })
    const made = writeAdapter(fake)
    const got = await made.it.run(writeJob())
    expect(got.delivered).toBe('unconfirmed')
    expect(got.why).toContain('没看到它收下')
  })

  it('★字写进去了、没按下发送 → not_sent(不许说成写进去了就完了)', async () => {
    const fake = shell({ agent_write_ask: [{ found: true, wrote: true, submitted: false }] })
    const made = writeAdapter(fake)
    const got = await made.it.run(writeJob())
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('没按下发送')
  })

  it('★一截原话都没有(认不出那个面板)→ 一个字都不写', async () => {
    const fake = shell()
    const made = writeAdapter(fake)
    const got = await made.it.run({ ...job({ kind: 'write_ask', text: '随便写点什么' }), family: DOUBAO.family })
    expect(got.delivered).toBe('not_sent')
    expect(fake.countOf('agent_write_ask')).toBe(0)
  })

  it('★旧壳不会往那个框里写字 → unsupported', async () => {
    const fake = shell()
    const made = writeAdapter(fake, ['read_reply'])
    const got = await made.it.run(writeJob())
    expect(got.unsupported).toBe(true)
    expect(fake.countOf('agent_write_ask')).toBe(0)
  })

  for (const rejects of [false, true]) {
    it(`★没窗口 → 开窗再写一回(壳${rejects ? 'reject' : '{ok:false}'};不会多写一遍)`, async () => {
      const fake = shell({ agent_write_ask: [{ fail: NO_WINDOW, rejects }, DEFAULTS.agent_write_ask as Record<string, unknown>] })
      const made = writeAdapter(fake)
      const got = await made.it.run(writeJob())
      expect(got.delivered).toBe('confirmed')
      expect(fake.countOf('agent_write_ask')).toBe(2)
    })
  }
})

describe('按它的停止键(agent_stop)', () => {
  const stopJob = (): Job => job({ kind: 'stop', text: '' })

  it('★壳说停下来了 → 算停了', async () => {
    const fake = shell()
    const made = adapterFor(fake)
    const got = await made.it.run(stopJob())
    expect(got.delivered).toBe('confirmed')
  })

  it('★按了、看不出它停下来 → 不说成打断了', async () => {
    const fake = shell({ agent_stop: [{ found: true, pressed: true, stopped: false }] })
    const made = adapterFor(fake)
    const got = await made.it.run(stopJob())
    expect(got.delivered).toBe('unconfirmed')
  })

  it('★认不出它的停止键 → not_sent', async () => {
    const fake = shell({ agent_stop: [{ found: false }] })
    const made = adapterFor(fake)
    const got = await made.it.run(stopJob())
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('认不出它的停止键')
  })

  it('★旧壳不会按停止 → unsupported,**不假装打断**', async () => {
    const fake = shell()
    const made = adapterFor(fake, ['read_reply'])
    const got = await made.it.run(stopJob())
    expect(got.unsupported).toBe(true)
    expect(fake.countOf('agent_stop')).toBe(0)
  })
})

describe('这一家能做哪几样:现查,不写死', () => {
  it('★壳会的那几件本事 → 对上那几格', async () => {
    const fake = shell()
    const made = adapterFor(fake)
    const caps = await made.it.capabilities()
    /*
     * ★ 2026-10-02(卡「引擎接线与删复制品」)多了两格:`approve`(看 / 按那个权限弹框)与
     * `writeAsk`(往那个提问面板里写字)。从前这两件在 `sessionAnswer` 那两只手上各判一份
     * (`canApprove` / `canWriteAsk`),界面那几格读的是那一份 —— 两处一漂就出 D13 的「点了没反应」。
     * `writeAsk` 对 Manus 是 false:那一路只对真机上认准了的那个包开着(`WRITE_ASK_PACKAGES`)。
     */
    expect(caps).toEqual({ open: true, send: true, read: true, press: true, approve: true, writeAsk: false, stop: true, openSession: true })
  })

  it('★「往那个提问面板里写字」这一格按家族:豆包几个包都为真(2026-10-12 维护者:一律按豆包处理),别家为假', async () => {
    const fake = shell()
    const doubao = adapterFor(fake, undefined, { family: 'doubao', bundle: 'com.work.pc.doubao', name: '豆包工作' })
    expect((await doubao.it.capabilities()).writeAsk).toBe(true)
    const store = adapterFor(fake, undefined, { family: 'doubao', bundle: 'com.bot.neotix.doubao', name: '豆包' })
    expect((await store.it.capabilities()).writeAsk).toBe(true)
    const manus = adapterFor(fake)
    expect((await manus.it.capabilities()).writeAsk).toBe(false)
  })

  it('★旧壳(只会 read_reply)→ 点 / 停 / 开到某一段都不行;Manus 没有深链', async () => {
    const fake = shell()
    const made = adapterFor(fake, ['read_reply'])
    const caps = await made.it.capabilities()
    expect(caps.press).toBe(false)
    expect(caps.stop).toBe(false)
    expect(caps.openSession).toBe(false)
    expect(caps.read).toBe(true)
  })

  it('★Codex 有深链 → 旧壳也开得到某一段', async () => {
    const fake = shell()
    const made = createWindowAdapter('codex', {
      helper: { ...fake.helper, supports: () => false },
      installed: () => [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }],
      bringToFront: async () => ({ ok: true }),
      sleep: async () => {},
    })
    const caps = await made.capabilities()
    expect(caps.openSession).toBe(true)
    expect(caps.press).toBe(false)
  })

  it('★壳没连上 → 送 / 读 / 点那几样一格都不行;**开得到它的窗照旧行**(那一下不经壳)', async () => {
    const made = createWindowAdapter(FAMILY, {
      helper: { connected: () => false, supports: () => true, request: async () => ({}) },
      installed: () => [{ bundle_id: BUNDLE, name: 'Manus' }],
      bringToFront: async () => ({ ok: true }),
      sleep: async () => {},
    })
    const caps = await made.capabilities()
    /*
     * ★ 2026-10-02(接「去回答」那一样时查实):`open <深链>` / `open -b <包>` / 窗位叠切一格
     * 都是工作台自己做的事,**壳没连上照样开得出来** —— 所以 `open` 那一格不看壳。
     * 「去回答」那颗键于是在壳没接上时照旧摆得出来(她点了真能把窗开到眼前)。
     */
    expect(caps.open).toBe(true)
    const { open: _open, ...rest } = caps
    void _open
    expect(Object.values(rest).every(one => one === false)).toBe(true)
  })

  it('★体检表说这一家聊不了 / 收不回结果 → 那两格跟着为假(现查的,不是写死的)', async () => {
    const fake = shell()
    const made = createWindowAdapter(FAMILY, {
      helper: fake.helper,
      installed: () => [{ bundle_id: BUNDLE, name: 'Manus', running: true }],
      bringToFront: async () => ({ ok: true }),
      sleep: async () => {},
      /*
       * ★ 2026-10-03(卡「0.4.87 启动崩溃」):这一格从**整张体检表**换成了**只问这一家那几格**。
       * 整张表的第一件事是算「体检哪几家」,那一步会回头问引擎登记处的候选名单 ——
       * 「这条通道会什么」绕一圈回去问「有哪几家」,同步递归爆栈(真机上 8791 永不响应)。
       */
      capCells: () => ({
        chat: { state: 'no', note: '它窗口上弹着一层框' },
        edit: { state: 'na', note: '' },
        collect: { state: 'no', note: '这份壳读不回回复' },
      }),
    })
    const caps = await made.capabilities()
    expect(caps.send).toBe(false)
    expect(caps.read).toBe(false)
    // 点 / 停不看体检表那三格(体检表没有这两样),照壳此刻会不会算。
    expect(caps.press).toBe(true)
  })
})
