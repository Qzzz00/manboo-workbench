// @vitest-environment node
/**
 * ★ **窗口上那六只手也过同一道闸**(2026-10-02,卡 AG2)。
 *
 * 卡 AG 把动作闸立起来时,这六条路是**唯一**没接上的 —— 交接
 * `docs/交接-1002-网易云反复弹出与不点名不派.md` 第二节 D 把它们逐条列着:
 * 替她答 / 捎话送进去 / 替她点选项 / 往提问面板写字 / 看按权限弹框 / 按停止。
 * 没接上的后果不是「少一道保险」:事情早已收场,她在手机上再点一下、电话里再说一句,
 * 工作台照样去动那一家 —— 10-02 真机那一类(「完成后每隔 10s 又自行打开网易云」)就是这么来的。
 *
 * 这一份逐条守两样(每条路各一条用例,照维护者「机制上的调整」那句话,不是对着某一家打补丁):
 * ① **收场了就一下都不动那一家** —— 壳那边一个 op 都不发,而且**不许从拦下的那条路漏到另一条路上**
 *    (点选项被拦下时,「框收掉了就当一句话发进去」那条替代路也不许走);
 * ② **次数到顶如实说** —— 回的是闸那句人话(「到顶了,不再来 —— 要再来一次你说一声」),
 *    不是假装做到了。上限用例里压到 1 回,**真机那几个数在 `GATE_LIMITS` 里**(她手点不出那个密度)。
 *
 * 另外守一条键:**有卡认领了这条会话就记在那张卡上**,没有才用会话键(`jobKey.ts`)——
 * 这就是交接里「要定的一件事」。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { GateAction, GateLimit, JobPhase } from '../src/server/actionGate.ts'
import { sessionJobId } from '../src/server/jobKey.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const SINCE = '2026-10-02T04:10:00.000Z'
const CLAUDE = 'com.anthropic.claudefordesktop'
const DOUBAO = 'com.work.pc.doubao'

/** 一条 Claude 桌面会话(「答」「捎话」「停止」那几条路走它)。 */
const claudeSession = (patch: Partial<SessionView> = {}): SessionView => ({
  agent: 'claude',
  session_id: 'h1',
  project: 'desktop-workbench',
  title: '修手机横屏',
  status: 'waiting',
  elapsed_sec: 30,
  unread: false,
  updated_at: SINCE,
  ask: { kind: 'do', question: '要我接着改吗', since: SINCE, quote: '要我接着改吗', by: 'rules' },
  ...patch,
})

/** 豆包办公那条窗口型对话(「点选项」「写面板」那两条路走它:写面板今天只它一家开着)。 */
const doubaoSession = (patch: Partial<SessionView> = {}): SessionView => ({
  // 窗口型那几家的 `agent` 是登记表 id(不在 `AgentId` 那几家里;答题 / 捎话这几路只按 id 找)。
  agent: 'doubao' as SessionView['agent'],
  session_id: 'window:825f1900',
  project: '',
  title: '国庆放假几天',
  status: 'waiting',
  elapsed_sec: 10,
  unread: false,
  updated_at: SINCE,
  ask: {
    kind: 'choose',
    question: '你最喜欢哪种菜系?',
    since: SINCE,
    quote: '你最喜欢哪种菜系?',
    by: 'form',
    options: [{ label: '川菜' }, { label: '粤菜' }],
  },
  ...patch,
})

interface Harness {
  /** 这台用例里每个键此刻的状态(没写的按「还在办」算)。 */
  phases?: Record<string, JobPhase>
  /** 压低某一样的上限(真机那几个数在 `GATE_LIMITS` 里,用例不照抄那些数)。 */
  limits?: Partial<Record<GateAction, GateLimit>>
  /** 这条会话归哪一件事(缺席 = 没有卡认领,走会话键)。 */
  item?: string
  sessions: readonly SessionView[]
}

/**
 * ★ 2026-10-02(卡「引擎接线与删复制品」):六只手删了,这几条路都经**一条引擎**。
 * 所以这一份也改成「假壳 + 真引擎 + 真闸」端到端跑 —— 守的两样一条没少,
 * 而且比从前硬:壳收到哪几个 op 是真的(从前那只假手挡在中间)。
 */
async function harness(options: Harness) {
  const h = engineHarness({
    phaseOf: job => options.phases?.[job] ?? 'open',
    nameOf: sessionAgentName,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    // 用例里的钟:每问一次走一分钟 —— 「太密」那一道不该把「到顶」那一道的用例盖住。
    now: (() => {
      let tick = 0
      return (): Date => new Date(Date.UTC(2026, 9, 2, 5, (tick += 1), 0))
    })(),
    installed: family => (family === 'doubao'
      ? [{ bundle_id: DOUBAO, name: '豆包工作', running: true }]
      : [{ bundle_id: CLAUDE, name: 'Claude', running: true }]),
    bundleOf: agent => (agent === 'doubao' ? DOUBAO : undefined),
    hostIdOf: () => 'local_7f3a',
    openUrl: async () => ({ ok: true }),
    openApp: async () => ({ ok: true }),
    bringToFront: async () => ({ ok: true }),
    reply: (req: HelperRequest) => {
      if (req.op === 'send_text') return { submitted: true, method: 'ax_value' }
      if (req.op === 'read_reply') return { found: false }
      if (req.op === 'agent_press') return { found: true, pressed: true, gone: true }
      if (req.op === 'agent_write_ask') return { found: true, wrote: true, submitted: true, gone: true, echoed: true }
      if (req.op === 'agent_stop') return { found: true, pressed: true, stopped: true }
      if (req.op === 'agent_pick') return { found: true, pressed: true }
      if (req.op === 'agent_approval') {
        return (req as { press?: string }).press === undefined
          ? { panels: [{ rect: { x: 20, y: 600, w: 640, h: 140 }, keys: ['Allow once', 'Deny'] }] }
          : { found: true, pressed: true, gone: true }
      }
      return {}
    },
  })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => options.sessions,
    windowSessions: () => options.sessions.filter(one => one.session_id.startsWith('window:')) as never,
    bundleOf: agent => (agent === 'doubao' ? DOUBAO : undefined),
    entryOf: () => 'claude-desktop',
    hostIdOf: () => 'local_7f3a',
    agentName: sessionAgentName,
    approvalMarksOf: () => ['npx vitest run --root butler-app'],
    ...(options.item === undefined ? {} : { itemOf: () => options.item as string }),
  })
  /** 真动到那扇窗的那几个 op(`read_reply` 只是读一眼找记号,不算动手)。 */
  const touched = (): string[] => h.requests.filter(one => one.op !== 'read_reply').map(one => one.op)
  // 界面那几格(摆不摆输入框 / 摆不摆那两颗批准键)读的是**同步**那一份能力:先现查一遍。
  await h.registry.targets()
  return { service, log: h.log, ops: h.requests, touched, registry: h.registry }
}

/** 这件事收场了 —— 键按「没有卡认领」算(会话键)。 */
const settledSession = (agent: string, sessionId: string): Record<string, JobPhase> =>
  ({ [sessionJobId(agent, sessionId)]: 'settled' })

const once = (action: GateAction): Partial<Record<GateAction, GateLimit>> =>
  ({ [action]: { tries: 1, minIntervalMs: 0 } })

describe('替她答(打字送回那条会话)', () => {
  it('★收场了 → 一个字都不打,如实说这件已经收场', async () => {
    const h = await harness({ sessions: [claudeSession()], phases: settledSession('claude', 'h1') })
    const got = await h.service.answer('claude', 'h1', '接着改')
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    expect(h.touched()).toEqual([])
  })

  it('★次数到顶 → 如实说到顶了(不假装送到了)', async () => {
    const h = await harness({ sessions: [claudeSession()], limits: once('answer_send') })
    expect((await h.service.answer('claude', 'h1', '第一句')).ok).toBe(true)
    const over = await h.service.answer('claude', 'h1', '第二句')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })
})

describe('捎话送进去', () => {
  /**
   * ★ 2026-10-13 夜(卡 Y)口径反过来:**她亲手捎的那一句,收场了也照旧送进去**。真机:维护者手机上往 Codex
   * 「查询 GoSim 深圳活动日期」那条(10-12 派活起的、卡早已办完)捎话,闸回「这件已经收场了…我不再去把你那句捎进去」。
   * 「收场了就不再动那一家」拦的是工作台自动追着办的(盯窗 / 重派 / 巡检,另有用例照旧拦);她再说一句是新的交代。
   */
  it('★收场了 → 她亲手捎的那一句照旧送进去(自动那几路另有用例照旧拦)', async () => {
    const h = await harness({ sessions: [claudeSession({ status: 'running' })], phases: settledSession('claude', 'h1') })
    const got = await h.service.relay('claude', 'h1', '现在到哪了')
    // 真送出去了(这套夹具的窗里永远找不到回显,所以结局是「发了没核上」那一档,不是闸拦的)。
    expect(h.ops.filter(one => one.op === 'send_text')).toHaveLength(1)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).not.toContain('收场')
  })

  it('★次数到顶 → 如实说到顶了', async () => {
    const h = await harness({ sessions: [claudeSession({ status: 'running' })], limits: once('relay_send') })
    await h.service.relay('claude', 'h1', '现在到哪了')
    const over = await h.service.relay('claude', 'h1', '再问一句')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })
})

describe('替她点选项', () => {
  it('★收场了 → 那一项不点,**而且不许改走「当一句话发进去」那条替代路**', async () => {
    const h = await harness({ sessions: [doubaoSession()], phases: settledSession('doubao', 'window:825f1900') })
    const got = await h.service.press('doubao', 'window:825f1900', '川菜')
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    // 一个 op 都没发:既没点,也没拐到打字那条路上去。
    expect(h.touched()).toEqual([])
  })

  it('★次数到顶 → 如实说到顶了', async () => {
    const h = await harness({ sessions: [doubaoSession()], limits: once('press_option') })
    expect((await h.service.press('doubao', 'window:825f1900', '川菜')).ok).toBe(true)
    const over = await h.service.press('doubao', 'window:825f1900', '粤菜')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'agent_press')).toHaveLength(1)
    expect(h.ops.filter(one => one.op === 'send_text')).toHaveLength(0)
  })
})

describe('往提问面板写字', () => {
  it('★收场了 → 一个字都不写', async () => {
    const h = await harness({ sessions: [doubaoSession()], phases: settledSession('doubao', 'window:825f1900') })
    const got = await h.service.writeAsk('doubao', 'window:825f1900', '我自己说一句')
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    expect(h.touched()).toEqual([])
  })

  it('★次数到顶 → 如实说到顶了', async () => {
    const h = await harness({ sessions: [doubaoSession()], limits: once('write_ask') })
    expect((await h.service.writeAsk('doubao', 'window:825f1900', '第一句')).ok).toBe(true)
    const over = await h.service.writeAsk('doubao', 'window:825f1900', '第二句')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'agent_write_ask')).toHaveLength(1)
  })
})

describe('权限弹框:读键', () => {
  const approving = (): SessionView => claudeSession({
    ask: { kind: 'approve', question: 'Claude 要跑一条命令,等你批准', since: SINCE, quote: '跑一遍手机端测试', by: 'form' },
  })

  it('★收场了 → 连读一眼都不读(读一次是在她窗口上遍历一遍)', async () => {
    const h = await harness({ sessions: [approving()], phases: settledSession('claude', 'h1') })
    const got = await h.service.approvalRead('claude', 'h1')
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    expect(h.touched()).toEqual([])
  })

  it('★次数到顶 → 如实说到顶了', async () => {
    const h = await harness({ sessions: [approving()], limits: once('approval_read') })
    expect((await h.service.approvalRead('claude', 'h1')).ok).toBe(true)
    const over = await h.service.approvalRead('claude', 'h1')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'agent_approval')).toHaveLength(1)
  })
})

describe('权限弹框:按键', () => {
  const approving = (): SessionView => claudeSession({
    ask: { kind: 'approve', question: 'Claude 要跑一条命令,等你批准', since: SINCE, quote: '跑一遍手机端测试', by: 'form' },
  })

  it('★收场了 → 一颗键都不按', async () => {
    const h = await harness({ sessions: [approving()], phases: settledSession('claude', 'h1') })
    const got = await h.service.press('claude', 'h1', 'Allow once')
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    expect(h.touched()).toEqual([])
  })

  it('★按键次数到顶 → 如实说到顶了(读键照旧放行,那是另一样)', async () => {
    const h = await harness({ sessions: [approving()], limits: once('approval') })
    expect((await h.service.press('claude', 'h1', 'Allow once')).ok).toBe(true)
    const over = await h.service.press('claude', 'h1', 'Allow once')
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'agent_approval' && (one as { press?: string }).press !== undefined)).toHaveLength(1)
  })
})

describe('按它的停止键(打断再发)', () => {
  /**
   * 打断只走窗口型那一路(`relayMove.ts`:她自己那条会话记录那一路工作台不去按停止)——
   * 所以这两条用例用豆包办公那条**正在跑、没挂那一问**的对话。
   */
  const running = (): SessionView => ({
    agent: 'doubao' as SessionView['agent'],
    session_id: 'window:825f1900',
    project: '',
    title: '国庆放假几天',
    status: 'running',
    elapsed_sec: 10,
    unread: false,
    updated_at: SINCE,
  })

  it('★收场了 → 不按停止、也不接着说那句话', async () => {
    const h = await harness({ sessions: [running()], phases: settledSession('doubao', 'window:825f1900') })
    const got = await h.service.relay('doubao', 'window:825f1900', '别做了,改成这样', { interrupt: true })
    expect(got.ok).toBe(false)
    expect(got.ok ? '' : got.status === 200 ? got.why : got.error).toContain('收场')
    expect(h.touched()).toEqual([])
  })

  it('★次数到顶 → 如实说到顶了,而且**没打断就不往里说**', async () => {
    const h = await harness({ sessions: [running()], limits: once('stop') })
    // 第一下:停止按上了、那句话也送进去了(送到没送到要另外核,这一条不看核实那一格)。
    await h.service.relay('doubao', 'window:825f1900', '先停下,改成这样', { interrupt: true })
    expect(h.ops.filter(one => one.op === 'agent_stop')).toHaveLength(1)
    const over = await h.service.relay('doubao', 'window:825f1900', '再停一次', { interrupt: true })
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.status === 200 ? over.why : over.error).toContain('到顶了')
    expect(h.ops.filter(one => one.op === 'agent_stop')).toHaveLength(1)
    expect(h.ops.filter(one => one.op === 'send_text')).toHaveLength(1)
  })
})

describe('这件事的键:有卡认领就记在那张卡上', () => {
  it('★有对应事项 → 账上记在事项 id 下(闸于是按卡的状态算)', async () => {
    const h = await harness({ sessions: [claudeSession()], item: 't-59322587' })
    await h.service.answer('claude', 'h1', '接着改')
    expect(h.log.events('t-59322587').map(one => one.action)).toContain('answer_send')
    expect(h.log.events(sessionJobId('claude', 'h1'))).toHaveLength(0)
  })

  it('★真没有事项 → 用会话当这件事的键(不为捎一句话硬造一张卡)', async () => {
    const h = await harness({ sessions: [claudeSession()] })
    await h.service.answer('claude', 'h1', '接着改')
    expect(h.log.events(sessionJobId('claude', 'h1')).map(one => one.action)).toContain('answer_send')
  })

  it('★那张卡收了 → 这条路这就停手(键换成事项 id 之后「收场了就不动」真生效)', async () => {
    const h = await harness({ sessions: [claudeSession()], item: 't-59322587', phases: { 't-59322587': 'settled' } })
    const got = await h.service.answer('claude', 'h1', '接着改')
    expect(got.ok).toBe(false)
    expect(h.touched()).toEqual([])
  })
})
