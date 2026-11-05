// @vitest-environment node
/**
 * 事务官捎话给**任何一条**会话(sessionRelay.ts + sessionAnswer.relay,2026-09-26 卡 BR)。
 *
 * 维护者 16:41 那一通的原话就是下面第一条用例里那一句;当时事务官答的是「它归哪件事」,他算 bug。
 *
 * 守:① 按标题 / 家名 / 状态认那一条 —— 唯一命中 / 几条都对得上(念给他选,**不猜**)/ 一条都对不上;
 * ② 认出来之后拿去调的就是 `/sessions/answer` 那两个字段(`agent` + `session_id`);
 * ③ 送进去的话 = 一个记号 + **他的原话**,一个字不改、什么都不补;
 * ④ 捎不到的三种如实说:那只手对这家不通 / 窗口里没认出那段对话 / 那条会话不在了;
 * ⑤ 工作台自己起的探针(selfcheck)与事务官自己的会话(dsh)不在候选里。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):捎话那一半后面换成**一条引擎** ——
 * `sessionAnswer.createWindowAnswerHand` 那六只手删了,服务搬到 `sessionJobs.createSessionJobs`。
 * 所以第三节改成「假壳 + 真引擎」端到端跑(`tests/helpers/engineHarness.ts`):
 * 从前那只假手挡在中间,壳那一侧的事实(回执不可靠、reject 一个 Error)测不到。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { relayMarkersOf } from '../src/server/sessionAnswer.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { matchRelaySession, relayMark, relayPrompt } from '../src/server/sessionRelay.ts'
import { createLockQueue } from '../src/server/engine/lockQueue.ts'
import { SESSION_CLOSED_QUEUED_SAY } from '../src/server/sessionClosed.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness, type EngineHarnessOptions, type FakeHelperReply } from './helpers/engineHarness.ts'

const NOW = '2026-09-26T08:41:00.000Z'

const view = (patch: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: 'desktop-workbench', status: 'running', elapsed_sec: 600, unread: false, updated_at: '2026-09-26T08:38:00.000Z', ...patch,
})

/** 09-26 16:41 这台机器上真有的那几条(会话号与标题照抄卡 V 交接里那张表)。 */
const 统筹交接 = view({ agent: 'claude', session_id: 'd9991aac-5e0e-4ba6-8dcf-7170236b3763', title: 'Desktop-workbench 统筹交接', status: 'running' })
const 坞气泡 = view({ agent: 'claude', session_id: 'd4ac442e-1111-2222-3333-444455556666', title: '坞上小气泡数不对', status: 'done', updated_at: '2026-09-26T07:10:00.000Z' })
const 探针 = view({ agent: 'claude', session_id: '8233a09f-aaaa-bbbb-cccc-dddddddddddd', title: '能力体检', status: 'error', selfcheck: { by: 'env', kind: 'caps' } })
const 事务官 = view({ agent: 'dsh', session_id: 'dsh-1', title: '事务官', status: 'running' })
const codex旧 = view({ agent: 'codex', session_id: 'c-old', title: '额度行对齐', status: 'running', updated_at: '2026-09-26T05:00:00.000Z' })
const codex新 = view({ agent: 'codex', session_id: 'c-new', title: '窗口槽那一扇', status: 'running', updated_at: '2026-09-26T08:30:00.000Z' })

const match = (who: string, sessions: readonly SessionView[]) =>
  matchRelaySession({ sessions, who, agentName: sessionAgentName, now: NOW })

describe('他点名那一句 → 哪一条会话', () => {
  it('★维护者 09-26 16:41 那一句:唯一命中统筹交接那条,拿去调 /sessions/answer 的就是这两个字段', () => {
    const got = match('给那个 Claude,现在正在做统筹交接的那个会话窗口,发个信息问一下:现在进行到什么情况,大概什么时候能处理完', [统筹交接, 坞气泡, 探针, 事务官])
    expect(got.kind).toBe('one')
    if (got.kind !== 'one') return
    expect({ agent: got.target.agent, session_id: got.target.session_id }).toEqual({
      agent: 'claude',
      session_id: 'd9991aac-5e0e-4ba6-8dcf-7170236b3763',
    })
    expect(got.target.line).toBe('Claude 「Desktop-workbench 统筹交接」(在跑 · 3 分钟前)')
  })

  it('★几条都对得上:候选一条不落地念给他,**不挑一条送**', () => {
    const got = match('给 Claude 发个信息', [统筹交接, 坞气泡])
    expect(got.kind).toBe('many')
    if (got.kind !== 'many') return
    expect(got.candidates.map(one => one.session_id)).toEqual([统筹交接.session_id, 坞气泡.session_id])
    expect(got.line).toContain('有 2 条都对得上')
    expect(got.line).toContain('Desktop-workbench 统筹交接')
    expect(got.line).toContain('坞上小气泡数不对')
    expect(got.line).toContain('问他是哪一条')
  })

  it('★一条都对不上:说没认出来、问他是哪一条(不挑最像的那条)', () => {
    const got = match('给张三那条发个信息', [统筹交接, 坞气泡])
    expect(got.kind).toBe('none')
    if (got.kind !== 'none') return
    expect(got.line).toContain('没认出')
    expect(got.line).toContain('2 条')
  })

  it('状态词也是判据:「Claude 那条正在跑的」不会认成做完了那条', () => {
    const got = match('跟 Claude 那条正在跑的会话说一句', [统筹交接, 坞气泡])
    expect(got.kind).toBe('one')
    if (got.kind !== 'one') return
    expect(got.target.session_id).toBe(统筹交接.session_id)
  })

  it('「刚才那条」:并列时取最近动过的那一条,不再念一串让他挑', () => {
    const got = match('给 Codex 刚才那条捎句话', [codex旧, codex新])
    expect(got.kind).toBe('one')
    if (got.kind !== 'one') return
    expect(got.target.session_id).toBe('c-new')
  })

  it('念了会话号也认;工作台自己的探针与事务官自己的会话不在候选里', () => {
    expect(match('捎话给 d9991aac 那条', [统筹交接, 坞气泡]).kind).toBe('one')
    // 只有探针和事务官自己那条时:候选池是空的,如实说没有能捎话的地方
    const empty = match('给 Claude 发个信息', [探针, 事务官])
    expect(empty.kind).toBe('none')
    if (empty.kind !== 'none') return
    expect(empty.line).toContain('一条别家的会话都没有')
  })

  it('没说是哪一条(who 是空的)→ 问他,不猜', () => {
    const got = match('   ', [统筹交接])
    expect(got.kind).toBe('none')
    if (got.kind !== 'none') return
    expect(got.line).toContain('没说清')
  })
})

describe('送进去那句话 = 他的原话(09-28 20:5x 起不带前缀)', () => {
  it('★他的话一个字不改,前后什么都不补(维护者:「前缀还带了什么事务官捎话」)', () => {
    expect(relayMark('d9991aac-5e0e-4ba6')).toBe('事务官捎话 d9991a')
    expect(relayPrompt({ sessionId: 'd9991aac-5e0e', said: '现在进行到什么情况,大概什么时候能处理完' }))
      .toBe('现在进行到什么情况,大概什么时候能处理完')
  })

  it('在窗口里认那段对话用哪几截字:调用方给的原文 → 它刚说的那一句 → 标题(太短的不用)', () => {
    // 记号最多 20 个字(answerMarkerOf 那道门:太长的截掉,太短的不用)
    expect(relayMarkersOf(统筹交接)).toEqual(['Desktop-workbench 统筹'])
    expect(relayMarkersOf(view({ agent: 'claude', session_id: 'x', title: '短' }))).toEqual([])
    expect(relayMarkersOf(统筹交接, ['我刚跑完那一轮测试,八个文件都绿了'])).toEqual([
      '我刚跑完那一轮测试,八个文件都绿了',
      'Desktop-workbench 统筹',
    ])
  })

  /*
   * ★ **重复的那一截只留一份,而且最多三截**(2026-09-28 11166695 那条修复的后半句)。
   * 壳那一侧每一截字都要在几千个节点上比一遍 —— 同一截比两遍是白花的时间;
   * 而「只留一份」也是顺序断言的前提(去重若按后来者留,顺序就反了)。
   */
  it('同一截字只留一份,最多三截(去重按先到的留,顺序不变)', () => {
    // 原文与标题是同一截:只出现一次
    expect(relayMarkersOf(统筹交接, ['Desktop-workbench 统筹交接'])).toEqual(['Desktop-workbench 统筹'])
    // 四截不同的 → 截到三截(标题那一截被挤掉)
    expect(relayMarkersOf(统筹交接, ['第一句话长得够认', '第二句话长得够认', '第三句话长得够认'])).toEqual([
      '第一句话长得够认',
      '第二句话长得够认',
      '第三句话长得够认',
    ])
  })
})

describe('真往那条会话里送(sessionJobs.relay + 一条引擎)', () => {
  /** 这份假壳每一回 `read_reply` 答「认出来了没有」(给一串 = 按次序答,用完按 false)。 */
  function reply(found: boolean | readonly boolean[]): FakeHelperReply {
    let read = 0
    return (req) => {
      if (req.op === 'read_reply') {
        const hit = Array.isArray(found) ? (found[read] ?? false) : found
        read += 1
        return { found: hit, busy: false, texts: [] }
      }
      if (req.op === 'send_text') return { submitted: true, method: 'ax' }
      // `agent_pick`:这份壳点不着那一行(认不出也照发 —— 卡 AW)。
      return {}
    }
  }

  const rig = (options: {
    found?: boolean | readonly boolean[]
    sessions?: readonly SessionView[]
    markers?: readonly string[]
    engine?: EngineHarnessOptions
  } = {}) => {
    const opened: string[] = []
    const h = engineHarness({
      reply: reply(options.found ?? true),
      nameOf: sessionAgentName,
      // 深链要的 `local_…` 是**窗口那一层**问的(生产里 index.ts 给的也是这一格)。
      hostIdOf: () => 'local_d9991aac',
      openUrl: async (url) => { opened.push(url); return { ok: true } },
      ...options.engine,
    })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => options.sessions ?? [统筹交接],
      entryOf: () => 'claude-desktop',
      hostIdOf: () => 'local_d9991aac',
      ...(options.markers === undefined ? {} : { markersOf: () => options.markers as readonly string[] }),
      agentName: sessionAgentName,
    })
    return { ...h, service, opened }
  }

  it('★认到那段对话:深链开到那一段 → 打字 → 替他发出去;进去的只有他的原话', async () => {
    const t = rig()
    // 卡 WR(2026-09-28):那条会话在跑,这一句是**排进去**的 —— 多一格 `queued`,别的一字不变。
    expect(await t.service.relay('claude', 统筹交接.session_id, '现在进行到什么情况,大概什么时候能处理完')).toEqual({
      ok: true,
      route: 'window',
      // 读回话认他那句原话本身(前缀拿掉之后)
      mark: '现在进行到什么情况,大概什么时候能处理完',
      // 真送进去的那个包(2026-09-30 止血 ⑤):上一层记进捎话台账,读回话按它读,不再按家名去查。
      bundle_id: 'com.anthropic.claudefordesktop',
      queued: true,
      /*
       * ★ 2026-10-02:`front` 那一格没了。「这一次怎么开到前台的」是**窗口那一层**里面的事
       * (`windowWake` 的 `FrontTrace`),引擎的 `JobResult` 不带它 —— 开窗那几回由闸数、进任务日志,
       * 不再一路往上传到回包里。
       */
    })
    expect(t.opened).toEqual(['claude://code/continue?session=local_d9991aac'])
    // 送之前多读一眼她那句在不在对话区里(回执不可靠时拿它补认;2026-09-28 Air 维护包)
    expect(t.requests.map(req => req.op)).toEqual(['read_reply', 'read_reply', 'send_text'])
    /*
     * ★ 2026-10-02:认那一段对话的**头一截**是**标题全文**(`marks[0]` 的约定:侧栏里点它用的就是这一行),
     * 20 个字那一截(`answerMarkerOf`)排在它后面。从前那只手拿的是截过的那一截。
     */
    expect(t.requests[0]).toMatchObject({ op: 'read_reply', marker: 'Desktop-workbench 统筹交接' })
    expect(t.requests.find(req => req.op === 'send_text')).toMatchObject({
      op: 'send_text',
      bundle_id: 'com.anthropic.claudefordesktop',
      text: '现在进行到什么情况,大概什么时候能处理完',
      submit: true,
    })
  })

  /*
   * ★ 2026-10-01(卡 AW):从前这里「一个字都不打」—— 维护者两次在手机上看到的「没敢替你打字」就是它。
   * 现在照发,送完读窗口核一次;这份假壳一直说窗里没有 → 如实回「可能发到了别的对话」(`unconfirmed`),
   * 上一层照新开会话那条路登记回电,不叫她重发。
   */
  it('★窗口里没认出那段对话 → 照样发,核不上如实说(不再「没敢替你打字」)', async () => {
    const t = rig({ found: false })
    const got = await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: true, unconfirmed: true })
    if (got.ok || got.status !== 200) return
    expect(got.why).toBe('按了发送,但没在那条对话里看到这句话 —— 可能发到了别的对话,去 Claude 里看一眼')
    expect(t.requests.map(req => req.op)).toContain('send_text')
  })

  it('认那一段用哪几截:`marks[0]` 是标题全文,调用方给的那几截排在后面;深链只开一次', async () => {
    const t = rig({ found: [true], markers: ['我刚跑完那一轮测试,八个文件都绿了'] })
    expect((await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')).ok).toBe(true)
    // 送之前多读一眼她那句在不在对话区里(回执不可靠时拿它补认;2026-09-28 Air 维护包)
    expect(t.requests.map(req => req.op)).toEqual(['read_reply', 'read_reply', 'send_text'])
    expect(t.requests.map(req => (req as { marker?: string }).marker)).toEqual([
      'Desktop-workbench 统筹交接',
      '现在到哪了',
      undefined,
    ])
    expect(t.opened).toEqual(['claude://code/continue?session=local_d9991aac'])
  })

  it('★没深链、只有标题(Kimi)→ 照样发:把那一家叫到台前、照送、再核(2026-10-01,卡 AW)', async () => {
    // Kimi 没有「开到某一段对话」的深链;从前只剩标题就一个字不打,现在照发、送完核
    const kimi = view({ agent: 'kimi', session_id: 'k-1', title: '帮我理一版提纲', status: 'running' })
    const t = rig({ sessions: [kimi] })
    expect((await t.service.relay('kimi', 'k-1', '先停一下,我再想想')).ok).toBe(true)
    expect(t.requests.map(req => req.op)).toContain('send_text')
    // 这一家没有深链 → 一条链都不开(不编一条)
    expect(t.opened).toEqual([])
    // 给一截只属于那一段的原文(它最后说的那几行)照旧更稳
    const withMarker = rig({ sessions: [kimi], markers: ['提纲我列了三版,你看第二版行不行'] })
    expect((await withMarker.service.relay('kimi', 'k-1', '先停一下,我再想想')).ok).toBe(true)
  })

  /*
   * ★ 2026-10-02:这一条守的行为与那句人话都没变(**不假装送到了**),判这一下的人换了 ——
   * 「这一家此刻送不送得进去」由引擎当场答(壳没连上 → 窗口那条通道的 `capabilities().send` 是假
   * → 一条通道都排不上队 → `not_sent` + `unsupported`),服务照旧只说那句干净的人话。
   */
  it('★捎不到之二:这一家此刻一条送得进话的通道都没有(壳没接上)—— 不假装送到了', async () => {
    const t = rig({ engine: { connected: () => false } })
    const got = await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')
    expect(got).toEqual({ ok: false, status: 200, where: 'desk', why: '这句话得你到电脑上的 Claude 里自己说', reveal: true })
    // 「没送到」就是一个 op 都没发出去
    expect(t.requests).toEqual([])
  })

  it('★捎不到之三:那条会话不在了 → 404;要捎的话是空的 → 400', async () => {
    const t = rig()
    expect(await t.service.relay('claude', '没这条', '喂')).toEqual({ ok: false, status: 404, error: '那条会话不在了(关掉了,或者这会儿认不出来)' })
    expect(await t.service.relay('claude', 统筹交接.session_id, '   ')).toEqual({ ok: false, status: 400, error: '要捎的话是空的' })
    expect(t.requests).toEqual([])
  })

  it('那条会话正在等他、而且是弹窗那种:打字送不进去,直说去哪儿点', async () => {
    const popup = { ...统筹交接, status: 'waiting' as const, ask: { kind: 'approve' as const, question: '要不要允许', since: NOW, by: 'form' as const } }
    const t = rig({ sessions: [popup] })
    const got = await t.service.relay('claude', popup.session_id, '你自己定')
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk' })
    if (got.ok || got.status !== 200) return
    expect(got.why).toBe('这句话得你到电脑上的 Claude 里自己说(它那边弹了个框等你点)')
    // 这一路**一个 op 都不发**(打字批不了它弹的那个框)
    expect(t.requests).toEqual([])
  })

  /*
   * ★ 2026-10-23(卡「捎话到没开着的会话留言等它醒」):协议手回「那条会话没开着」,
   * 引擎把这一件排进队、回 `sessionClosed + lockQueued` + 留言那句。服务照「已收下」翻 ——
   * ok:true + note(她不用重试),**不登记回电**(那一条由醒来重送那一下补,见 `index.ts` 的 drain.after)。
   */
  it('★那条会话没开着(协议手回「没开着」)→ 留言排上队:回 ok:true + 留言那句', async () => {
    const queue = createLockQueue()
    /*
     * 壳没连上 → 窗口那条通道排不进队(生产里就是「会话闲了一夜、窗口也没了」那一种);
     * 登记表里**另一条会话开着**(协议手的 `capabilities().send` 才是 true、排得进候选),
     * 要捎的这条不在 → 真 Claude 适配器回「没开着」+ `sessionClosed`;接一本队,引擎才排得进。
     */
    const t = rig({ engine: { connected: () => false, claude: { sockets: async () => [{ sessionId: 'another-open-one', pid: 21384, socket: '/tmp/cc-socks/another.sock' }], socketReady: async () => true }, lockQueue: { add: (job, reason) => queue.add(job, reason) } } })
    const got = await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')
    expect(got).toMatchObject({
      ok: true,
      route: 'window',
      mark: '现在到哪了',
      note: SESSION_CLOSED_QUEUED_SAY,
      sessionClosed: true,
    })
    // 一个字都没往壳里打(引擎这一下就到此为止,没有替代的路)
    expect(t.requests).toEqual([])
    expect(queue.list()).toHaveLength(1)
  })

  /*
   * ★ 2026-10-23(统筹合并「留言等它醒」时补的那一支):**替她答**撞上「那条会话没开着」——
   * 引擎同样排进队,服务层照锁屏那一路的口径回 ok:false + 留言那句(`sessionClosedReply`),
   * **不接**「这一问得到电脑上的 Claude 里回答」那截(接了她会去电脑上再答一遍,醒来重送就成了答两次)。
   */
  it('★替她答撞上「没开着」→ 同样留言排队:回 ok:false + 留言那句,不接「到电脑上」', async () => {
    const queue = createLockQueue()
    const asking = { ...统筹交接, status: 'waiting' as const, ask: { kind: 'choose' as const, question: '选哪个方案', quote: '选哪个方案', since: NOW, by: 'model' as const } }
    const t = rig({ sessions: [asking], engine: { connected: () => false, claude: { sockets: async () => [{ sessionId: 'another-open-one', pid: 21384, socket: '/tmp/cc-socks/another.sock' }], socketReady: async () => true }, lockQueue: { add: (job, reason) => queue.add(job, reason) } } })
    const got = await t.service.answer('claude', asking.session_id, '第二个')
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk', why: SESSION_CLOSED_QUEUED_SAY, reveal: false })
    if (got.ok || got.status !== 200) return
    expect(got.why).not.toContain('到电脑上')
    expect(t.requests).toEqual([])
    expect(queue.list()).toHaveLength(1)
  })
})
