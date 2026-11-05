// @vitest-environment node
/**
 * **替她批准那家的权限弹窗**(2026-10-01 卡 AP「手机替她批准」)。
 *
 * 现场:维护者 10-01 午饭在外面(走中转),修手机横屏那条 Claude 会话在等批准。原话:
 * 「找到那个会话是在待确认里,输入回复内容之后,说发不出去」—— 两次 `POST /sessions/answer → 200` 都是 ok:false。
 *
 * 守:① 权限弹窗那一问**不摆输入框**:`permission` 一格,读得了就 `readable`,读过了带壳读到的那几颗键;
 * ② 读键:先不动她的窗口读一眼,没认出再把那段对话开到前面读;认不准(两个弹窗都像)如实说;
 * ③ 按键:只按「批准一次 / 拒绝」;按完那颗键没了才 `confirmed`,还在就说没按上;
 * ④ 放宽的那颗(本次会话都允许)不替她按;旧壳 / 没有记号 → 照旧「到电脑上点」,不假装;
 * ⑤ 打字撞上权限弹窗 → 说清「这是权限弹窗,点批准或拒绝」+ `permission:true`(界面据此切到按键)。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」)这一份改成「假壳 + 真引擎」端到端跑,三处口径跟着变了:
 *
 * 1. `sessionAnswer.createWindowAnswerHand` 的 `readApproval` / `pressApproval` 删了 ——
 *    看 / 按那个弹框在 `engine/adapters/window.ts` 一处。**「先只读一眼、读不到再开到前面读」那两步
 *    收进了适配器**(从前在服务这一层连调两回那只手,而那只手每一回都过一次 `approval_read` 的闸、
 *    间隔 1 秒,所以第二回必然被自己拦下 —— 「开到前面再读」那条路其实从没走通过);
 * 2. 「这一家此刻看不看得了那个弹框」**不在服务这一层判** —— 引擎 / 适配器现查、看不了如实说。
 *    所以旧壳那几条的人话从「它那边弹了个框等你点」换成壳自己那句「还不会替你看那个批准弹窗」;
 * 3. 界面那一格(`permission`)的判据只有一处:`registry.knownCaps(family).approve`(契约 10-02 加的那一格)。
 *    **这一份用例因此要先 `await registry.targets()` 现查一遍能力**,与生产里界面那一拍一样。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import type { ApprovalPanelRead } from '../src/server/approvalKeys.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { ALL_HELPER_CAPS, engineHarness } from './helpers/engineHarness.ts'
import { sessionAgentName } from '../src/waiting.ts'

const SINCE = '2026-10-01T04:10:00.000Z'
const CLAUDE = 'com.anthropic.claudefordesktop'
const MARKS = ['npx vitest run --root butler-app', '跑一遍手机端测试']

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  agent: 'claude',
  session_id: 'h1',
  project: 'desktop-workbench',
  title: '修手机横屏',
  status: 'waiting',
  elapsed_sec: 30,
  unread: false,
  updated_at: SINCE,
  ask: { kind: 'approve', question: 'Claude 要跑一条命令,等你批准', since: SINCE, quote: '跑一遍手机端测试', by: 'form' },
  ...patch,
})

const DIALOG: ApprovalPanelRead = { rect: { x: 20, y: 600, w: 640, h: 140 }, keys: ['Allow once', 'Allow for this session', 'Deny'] }

/** 这一下是「只读一眼」还是「按那一颗」(同一个 op、两种用法)。 */
const isPress = (req: { op: string }): boolean => req.op === 'agent_approval' && (req as { press?: string }).press !== undefined

/**
 * 一套「假壳 + 真引擎 + 会话服务」。
 *
 * `passive` / `active` = 第一眼(不动她的窗口)/ 开到前面之后那几眼各读到哪几块;
 * `gone` = 按完那颗键还在不在;`canApprove:false` = 这份壳不会 `agent_approval`(旧壳)。
 *
 * ★ 钟**定住**:界面那一格读的是 `knownCaps` 的缓存(几秒就过期),钟往前走会让它在同一条用例里
 * 变回「还没查过」。这一组用例每一种闸上的动作只来一回,所以定住的钟不会撞上「离上一回太密」。
 */
async function rig(one: SessionView, opts: {
  passive?: readonly ApprovalPanelRead[]
  active?: readonly ApprovalPanelRead[]
  gone?: boolean
  press?: Record<string, unknown>
  canApprove?: boolean
  marks?: readonly string[]
} = {}) {
  const opened: string[] = []
  let reads = 0
  const h = engineHarness({
    nameOf: sessionAgentName,
    now: () => new Date(SINCE),
    hostIdOf: () => 'local_7f3a',
    openUrl: async (url) => { opened.push(url); return { ok: true } },
    bringToFront: async () => { opened.push('front'); return { ok: true } },
    ...(opts.canApprove === false ? { caps: ALL_HELPER_CAPS.filter(cap => cap !== 'agent_approval') } : {}),
    reply: (req) => {
      if (isPress(req)) return opts.press ?? { found: true, pressed: true, gone: opts.gone ?? true, how: 'ax_press' }
      if (req.op === 'agent_approval') {
        // 第一眼读 `passive`,开到前面之后那几眼读 `active`(缺席 = 还是 `passive`)。
        reads += 1
        const panels = (reads === 1 ? opts.passive : opts.active ?? opts.passive) ?? []
        return { found: panels.length > 0, panels }
      }
      if (req.op === 'read_reply') return { found: true, busy: false, texts: [] }
      return {}
    },
  })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => [one],
    entryOf: () => 'claude-desktop',
    hostIdOf: () => 'local_7f3a',
    agentName: sessionAgentName,
    approvalMarksOf: () => opts.marks ?? MARKS,
  })
  // 界面那几格读的是现查来的那一份能力(同生产里 /state 那一拍)。
  await h.registry.targets()
  return {
    ...h,
    service,
    opened,
    /** 真按下去那几回(带 `press` 的那几个 op)。 */
    presses: () => h.requests.filter(isPress),
    /** 只读那几回。 */
    reads: () => h.requests.filter(one2 => one2.op === 'agent_approval' && !isPress(one2)),
  }
}

describe('等你那一格:权限弹窗不摆输入框', () => {
  it('★读得了(壳会、认得出是哪一家、有记号)→ permission.readable,不带 press / write', async () => {
    const t = await rig(view())
    const reply = t.service.replyOf(view(), { kind: 'approve', by: 'form', since: SINCE })
    expect(reply).toMatchObject({ reply: 'desk', reveal: true, permission: { readable: true } })
    expect(reply.press).toBeUndefined()
    expect(reply.write).toBeUndefined()
    // 问「读得了没有」一个 op 都不发
    expect(t.requests).toEqual([])
  })

  it('★旧壳(不会 agent_approval)→ permission 照挂(界面照样不摆输入框),只是读不了:照旧一句到电脑上点', async () => {
    const t = await rig(view(), { canApprove: false })
    const reply = t.service.replyOf(view(), { kind: 'approve', by: 'form', since: SINCE })
    expect(reply).toEqual({ reply: 'desk', where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true, permission: {} })
  })

  it('没有一截原话能认出是哪个弹窗(记号缺席、ask 也没 quote)→ 读不了,不假装', async () => {
    const bare = view({ ask: { kind: 'approve', question: 'Claude 要你批准一步操作', since: SINCE, by: 'form' } })
    const t = await rig(bare, { marks: [] })
    expect(t.service.replyOf(bare, { kind: 'approve', by: 'form', since: SINCE })).toMatchObject({ permission: {} })
  })

  it('按内容读出来的「要不要我…」不是权限弹窗,不挂这一格', async () => {
    const said = view({ status: 'done', ask: { kind: 'approve', question: '要不要顺手改手机端', since: SINCE, by: 'rules' } })
    const t = await rig(said)
    expect(t.service.replyOf(said, { kind: 'approve', by: 'rules', since: SINCE }).permission).toBeUndefined()
  })
})

describe('读键', () => {
  it('★先不动她的窗口读一眼:认出来了就给「批准一次 / 拒绝」,放宽那颗不给;读过之后等你那一格带上这几颗', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.approvalRead('claude', 'h1')).toEqual({
      ok: true,
      keys: [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }],
      held: ['Allow for this session'],
    })
    // 只读到了就收手:**一回都没动她的窗口**(不叫台前、不开深链、只一个 op)
    expect(t.requests).toEqual([{ op: 'agent_approval', bundle_id: CLAUDE, marks: MARKS }])
    expect(t.opened).toEqual([])
    expect(t.service.replyOf(view(), { kind: 'approve', by: 'form', since: SINCE }).permission)
      .toEqual({ keys: [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }] })
  })

  it('★那一眼没认出(前台是别的会话)→ 叫台前 + 用深链把这一段开到前面再读', async () => {
    const t = await rig(view(), { passive: [], active: [DIALOG] })
    expect(await t.service.approvalRead('claude', 'h1')).toMatchObject({ ok: true })
    // ★ 2026-10-02:这两眼是**一次调用、一回闸**(收进了适配器)—— 从前在这一层连调两回,第二回必被闸拦下
    expect(t.reads()).toHaveLength(2)
    expect(t.opened).toEqual(['front', 'claude://code/continue?session=local_7f3a'])
  })

  it('★两个弹窗都像 → 如实说认不准,一颗键都不给', async () => {
    const twin = { ...DIALOG, rect: { x: 20, y: 200, w: 640, h: 140 } }
    const t = await rig(view(), { passive: [DIALOG, twin] })
    expect(await t.service.approvalRead('claude', 'h1')).toEqual({
      ok: false, status: 200, where: 'desk', reveal: true,
      why: '这一问得在电脑上的 Claude 里回答(它窗口里有 2 个批准弹窗都像这一步的,认不准是哪一个,一颗键都没敢按)',
    })
  })

  it('读了也没认出 → 如实说,而且等你那一格不再一直说「读得了」(免得界面一打开又去读)', async () => {
    const t = await rig(view(), { passive: [], active: [] })
    /*
     * ★ 2026-10-02:一块都没读到时那句人话换了出处 —— 从前是 `approvalKeys` 的「没在它窗口里认出这一步的批准弹窗」
     * (服务拿着空数组还要去挑一遍),现在适配器回「一块都没有」,服务这一层直说「没在它窗口里找到那个权限弹框」。
     */
    expect(await t.service.approvalRead('claude', 'h1'))
      .toMatchObject({ ok: false, status: 200, why: '这一问得在电脑上的 Claude 里回答(没在它窗口里找到那个权限弹框)' })
    expect(t.service.replyOf(view(), { kind: 'approve', by: 'form', since: SINCE }).permission)
      .toEqual({ why: '没在它窗口里找到那个权限弹框' })
  })

  it('★旧壳:一个 op 都不发,照旧一句到电脑上点(不假装看过了)', async () => {
    const t = await rig(view(), { canApprove: false, passive: [DIALOG] })
    expect(await t.service.approvalRead('claude', 'h1')).toEqual({
      ok: false, status: 200, where: 'desk', reveal: true,
      why: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)',
    })
    expect(t.requests).toEqual([])
  })

  it('不是权限弹窗那一问 → 409;那条会话不在 → 404', async () => {
    const choose = view({ ask: { kind: 'choose', question: '选哪个', since: SINCE, by: 'form', options: [{ label: 'A' }] } })
    expect(await (await rig(choose, { passive: [DIALOG] })).service.approvalRead('claude', 'h1')).toMatchObject({ ok: false, status: 409 })
    expect(await (await rig(view(), { passive: [DIALOG] })).service.approvalRead('claude', 'nope')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('按键', () => {
  it('★点「Allow once」→ 只在认准的那一块里按那一颗;按完那颗键没了才说批了', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.press('claude', 'h1', 'Allow once')).toEqual({ ok: true, label: 'Allow once', confirmed: true, approved: 'once' })
    /*
     * 按下去之前**重新读一次**(位置以这一次为准),只在位置对得上的那一块里按那一颗。
     * 读那两回:① 服务摆键之前那一眼 ② 适配器按之前重读的那一眼(后者不另算一回 `approval_read` 的闸)。
     */
    expect(t.reads()).toHaveLength(2)
    expect(t.presses()).toEqual([{ op: 'agent_approval', bundle_id: CLAUDE, marks: MARKS, press: 'Allow once', panel: DIALOG.rect }])
  })

  it('★按完那个弹窗还在 → 说没按上,不说批了', async () => {
    const t = await rig(view(), { passive: [DIALOG], gone: false })
    expect(await t.service.press('claude', 'h1', 'Deny')).toEqual({
      ok: true, label: 'Deny', confirmed: false, approved: 'deny',
      // ★ 2026-10-02:这句人话现在由窗口适配器一处出(`pressApproval` 的 `verdict`),与从前逐字相同
      note: '按了「Deny」,可那个弹窗还在 —— 没按上,去电脑上的 Claude 看一眼',
    })
  })

  it('★壳说读的时候认准的那个弹窗这会儿不在原处了 → 原样往上报,不说批了', async () => {
    const t = await rig(view(), {
      passive: [DIALOG],
      press: { found: false, note: '读的时候认准的那个弹窗这会儿不在原处了' },
    })
    const got = await t.service.press('claude', 'h1', 'Allow once')
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: true })
    if (got.ok || got.status !== 200) return
    expect(got.why).toContain('这会儿不在原处了')
  })

  it('★电话里说「批准」→ 认成批准一次那一颗', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.press('claude', 'h1', '批准')).toMatchObject({ ok: true, label: 'Allow once', confirmed: true })
    expect(t.presses().map(one => (one as { press: string }).press)).toEqual(['Allow once'])
  })

  it('★放宽的那颗(本次会话都允许)不替她按 —— 一个 op 都不发', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.press('claude', 'h1', 'Allow for this session')).toEqual({
      ok: false, status: 400,
      error: '「Allow for this session」会放宽这条会话往后的权限,工作台不替你按 —— 要放宽请在电脑上自己按',
    })
    expect(t.requests).toEqual([])
  })

  it('听不出是哪一颗 → 400,一颗都不按', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.press('claude', 'h1', '我想想')).toMatchObject({ ok: false, status: 400 })
    expect(t.presses()).toEqual([])
  })

  it('★旧壳 → 照旧到电脑上点,不假装', async () => {
    const t = await rig(view(), { passive: [DIALOG], canApprove: false })
    expect(await t.service.press('claude', 'h1', 'Allow once')).toEqual({
      ok: false, status: 200, where: 'desk', reveal: true, why: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)',
    })
    expect(t.requests).toEqual([])
  })

  it('★子任务的弹窗:记号是那个子任务那一步的原话,按法一样', async () => {
    const child = view({ ask: { kind: 'approve', question: 'Claude 的子任务要跑一条命令', since: SINCE, by: 'form', child: { id: 'agent-a7', title: '跑一遍测试' } } })
    const t = await rig(child, { passive: [DIALOG], marks: ['pnpm test'] })
    expect(await t.service.press('claude', 'h1', 'Allow once')).toMatchObject({ ok: true, confirmed: true })
    expect(t.presses()[0]).toMatchObject({ marks: ['pnpm test'] })
  })
})

describe('打字撞上权限弹窗', () => {
  it('★回一句「这是权限弹窗,点批准或拒绝」+ permission:true,一个字都不往对话里打', async () => {
    const t = await rig(view(), { passive: [DIALOG] })
    expect(await t.service.answer('claude', 'h1', '可以')).toEqual({
      ok: false, status: 200, where: 'desk', reveal: true, permission: true,
      why: '这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键',
    })
    expect(t.requests).toEqual([])
  })

  it('旧壳:同样说清是权限弹窗,再说去哪儿点', async () => {
    const t = await rig(view(), { canApprove: false })
    expect(await t.service.answer('claude', 'h1', '可以')).toEqual({
      ok: false, status: 200, where: 'desk', reveal: true, permission: true,
      why: '这是权限弹窗,打字批不了它 —— 这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)',
    })
    expect(t.requests).toEqual([])
  })
})

/**
 * ★ 窗口适配器那一层(壳的 `agent_approval`)。这一节原来测的是
 * `sessionAnswer.createWindowAnswerHand` 的 `readApproval` / `pressApproval` 两只手;
 * 那两只手删了,同一串动作现在在 `engine/adapters/window.ts` 的 `Adapter.readApproval` 里
 * ——**而且那两步(只读一眼 / 开到前面再读)收进了一次调用**。
 */
describe('只看一眼那个权限弹框(Adapter.readApproval,经引擎)', () => {
  /** 适配器那一层要的那个 `Job`(服务那一层拼的也是这一个形状)。 */
  const job = (marks: readonly string[]) => ({
    id: 'job-approve',
    family: 'claude',
    kind: 'press' as const,
    target: { kind: 'session' as const, sessionId: 'h1' },
    text: '',
    marks,
    expect: 'none' as const,
  })

  function harness(replies: readonly Record<string, unknown>[], caps?: readonly string[]) {
    const opened: string[] = []
    let at = 0
    const h = engineHarness({
      nameOf: sessionAgentName,
      now: () => new Date(SINCE),
      hostIdOf: () => 'local_7f3a',
      openUrl: async (url) => { opened.push(`open ${url}`); return { ok: true } },
      bringToFront: async () => { opened.push('front'); return { ok: true } },
      ...(caps === undefined ? {} : { caps }),
      reply: (req) => {
        if (req.op !== 'agent_approval' && req.op !== 'agent_pick') return {}
        const one = replies[Math.min(at, replies.length - 1)] ?? {}
        at += 1
        return one
      },
    })
    return { ...h, opened }
  }

  it('★只读那一下不动她的窗口:不叫台前、不开深链', async () => {
    const t = harness([{ found: true, panels: [{ rect: DIALOG.rect, keys: DIALOG.keys }] }])
    expect(await t.engine.readApproval(job(['pnpm test']), { active: false }))
      .toEqual({ panels: [DIALOG], via: 'window' })
    expect(t.opened).toEqual([])
    expect(t.requests).toEqual([{ op: 'agent_approval', bundle_id: CLAUDE, marks: ['pnpm test'] }])
  })

  it('★开到前面那一下:先只读一眼 → 叫台前 → 深链 → 再读;还没认出、有标题 → 侧栏里点它一下再读', async () => {
    const t = harness([
      // ① 不动窗口那一眼:没有 ② 开到前面之后那一眼:还是没有 ③ 侧栏点那一下:点着了 ④ 再读:有了
      { found: false, panels: [] },
      { found: false, panels: [] },
      { found: true, pressed: true },
      { found: true, panels: [{ rect: DIALOG.rect, keys: DIALOG.keys }] },
    ])
    expect(await t.engine.readApproval(job(['pnpm test']), { active: true })).toMatchObject({ panels: [DIALOG] })
    expect(t.opened).toEqual(['front', 'open claude://code/continue?session=local_7f3a'])
    expect(t.requests.map(one => one.op)).toEqual(['agent_approval', 'agent_approval', 'agent_pick', 'agent_approval'])
  })

  it('★旧壳:不发这个 op,如实说这一路看不了', async () => {
    const t = harness([], ALL_HELPER_CAPS.filter(cap => cap !== 'agent_approval'))
    /*
     * ★ 2026-10-02:挑通道按**契约新加的那一格**挑(`picksFor` 的 `need:'approve'`)——
     * 旧壳的 `capabilities().approve` 是假,于是一条通道都排不上队,引擎如实说这一路看不了。
     * (从前按 `press` 挑:会挑中一条点得了选项、却看不了权限弹框的通道。)
     */
    expect(await t.engine.readApproval(job(['pnpm test']), { active: false })).toEqual({
      panels: [],
      via: 'none',
      why: 'Claude 这一路看不了那个权限弹框上有哪几颗键',
    })
    expect(t.requests).toEqual([])
  })

  it('★一截原话都没有(认不出那个弹框)→ 一眼都不看', async () => {
    const t = harness([{ found: true, panels: [{ rect: DIALOG.rect, keys: DIALOG.keys }] }])
    expect(await t.engine.readApproval(job([]), { active: true }))
      .toEqual({ panels: [], via: 'none', why: '没有一截原话能用来认出它那个权限弹框,一眼都没看' })
    expect(t.requests).toEqual([])
  })
})
