// @vitest-environment node
/**
 * 答了送回那家会话 / 「去回答」(2026-09-25 卡 T 第 5 条)。
 *
 * 守:① 每一家从哪开的 → 走哪条路、送不回去时那句人话说清去哪儿答;
 * ② **认不出那段对话也照发**(2026-10-01 卡 AW),送完按证据核;核不上如实说,不说成答上了;
 * ③ 这一问已经不在了 → 409;字是空的 → 400;没有这条会话 → 404;
 * ④ 弹窗 / 子任务那一问打字送不进去(得在那家里点那个框),权限弹窗说清切到按键。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):`sessionAnswer.ts` 里那六只手删了,
 * 服务搬到 `sessionJobs.ts`、后面接**一条引擎**。所以这一份用例改成「假壳 + 真引擎」端到端跑:
 * 从前那只假手挡在中间,壳那一侧的事实(回执不可靠、reject 一个 Error)测不到。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { answerMarkerOf, answerPlanOf } from '../src/server/sessionAnswer.ts'
import { createSessionJobs, type SessionJobsDeps } from '../src/server/sessionJobs.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const view = (patch: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: 'p', status: 'waiting', elapsed_sec: 30, unread: false, updated_at: '2026-09-25T10:00:00.000Z', ...patch,
})
const asking = (agent: SessionView['agent'], id: string): SessionView => view({
  agent, session_id: id,
  ask: { kind: 'choose', question: '今天额度只剩 0.58 元', options: [{ label: '提到 15 元' }], since: '2026-09-25T09:50:00.000Z', quote: '你选哪个?回个数字就行。', by: 'rules' },
})

/** 一套「假壳 + 真引擎 + 会话服务」。`await warm()` 之后 `replyOf` 那几格才有现查来的能力。 */
async function harness(input: {
  sessions: readonly SessionView[]
  service?: Omit<SessionJobsDeps, 'engine' | 'registry' | 'sessions'>
  engine?: EngineHarnessOptions
}) {
  const h = engineHarness(input.engine ?? {})
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => input.sessions,
    ...input.service,
  })
  // 候选名单那一下顺手把每条通道的 `capabilities()` 现查一遍(界面那几格读的是它)。
  await h.registry.targets()
  return { ...h, service }
}

describe('各家从哪开的 → 走哪条路', () => {
  // ★ 2026-10-03(卡「接缝清理」第 3 条):`hands` 里那一格 `cli` 删了(三个调用方一律传 false、
  // 函数体一次都没读过它)。这两份现在只有「这一家送不送得进话」一格。
  const none = { window: false }
  const both = { window: true }

  it('★这一家送不进话时:一律到电脑上回答,Claude / Codex 带深链', () => {
    // Claude 的深链只认桌面 App 里的编号(local_…,从 ~/.claude/sessions/<pid>.json 的 hostSessionId 读),不认会话文件的 id
    expect(answerPlanOf('claude', 'd999', 'claude-desktop', none, 'local_1a6954')).toEqual({ route: 'desk', why: '这一问得在电脑上的 Claude 里回答', deepLink: 'claude://code/continue?session=local_1a6954', revealable: true })
    expect(answerPlanOf('claude', 'd999', 'claude-desktop', none)).toEqual({ route: 'desk', why: '这一问得在电脑上的 Claude 里回答', revealable: true })
    expect(answerPlanOf('codex', 'c-1', 'vscode', none)).toEqual({ route: 'desk', why: '这一问得在电脑上的 Codex 里回答', deepLink: 'codex://threads/c-1', revealable: true })
    expect(answerPlanOf('kimi', 'k-1', undefined, none)).toEqual({ route: 'desk', why: '这一问得在电脑上的 Kimi 里回答', revealable: true })
  })

  it('送得进话时:桌面 App 开的走窗口那条;终端 / VS Code 里开的、派活起的 Codex 也走同一支(卡 D)', () => {
    expect(answerPlanOf('claude', 'd999', 'claude-desktop', both, 'local_1a6954')).toEqual({ route: 'window', bundleId: 'com.anthropic.claudefordesktop', deepLink: 'claude://code/continue?session=local_1a6954', revealable: true })
    expect(answerPlanOf('codex', 'c-1', 'appServer', both)).toMatchObject({ route: 'window', bundleId: 'com.openai.codex' })
    /*
     * ★ 2026-10-20(卡 D):`codex exec` 起的线程按 App 线程办 —— 探针 55b38005
     * (`docs/交接-1019-codex续线程探针.md`):同一份 rollout、同一把写锁,`thread/resume` 960 ms 续上。
     * 从前这里一律「去电脑上的 Codex 里答」,引擎一次都没被问到。
     */
    expect(answerPlanOf('codex', 'c-2', 'exec', both)).toEqual({ route: 'window', bundleId: 'com.openai.codex', deepLink: 'codex://threads/c-2', revealable: true })
    expect(answerPlanOf('kimi', 'k-1', undefined, both)).toEqual({ route: 'window', bundleId: 'com.moonshot.kimichat', revealable: true })
    /*
     * ★ 2026-10-20(卡 D):终端 / VS Code 里开的**不再按 entry 先拒** —— 探针 13e2bf20
     * (`docs/交接-1019-claude捎话探针.md`)量过终端会话登记表里一样有 socket、收得到、照样回话。
     * entry 只定两样:「去回答」调不到那个终端(不摆那颗键、不给深链);只许协议那只手(窗口那只开的是桌面 App)。
     */
    expect(answerPlanOf('claude', 'd1', 'cli', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    expect(answerPlanOf('codex', 'c-3', 'cli', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    expect(answerPlanOf('claude', 'd1', 'claude-vscode', both)).toEqual({ route: 'window', revealable: false, vias: ['protocol'] })
    /*
     * ★ 2026-10-02:窗口型那几家(Muse / Manus / 豆包办公)**也走窗口那条** ——
     * 包问家族目录(从前这个文件里有一张只有三家的 `WINDOW_APPS`,表外的一家一律「去电脑上那个 App 里答」)。
     */
    expect(answerPlanOf('muse', 'm-1', undefined, both)).toEqual({ route: 'window', bundleId: 'com.meta.endo', revealable: true })
    // 家族目录也不认识、又不是一个包标识 → 照旧「电脑上那个 App」
    expect(answerPlanOf('whoever', 'w-1', undefined, both)).toEqual({ route: 'desk', why: '这一问得在电脑上那个 App 里回答', revealable: false })
  })

  it('认那段对话的记号:原话去掉记号、截 20 个字;太短不用', () => {
    expect(answerMarkerOf('**你选哪个?** 回个数字就行。')).toBe('你选哪个? 回个数字就行。')
    expect(answerMarkerOf('一二三四五六七八九十一二三四五六七八九十多出来的')).toBe('一二三四五六七八九十一二三四五六七八九十')
    expect(answerMarkerOf('好的')).toBeUndefined()
    expect(answerMarkerOf(undefined)).toBeUndefined()
  })
})

describe('答 / 去回答', () => {
  it('★壳没连上:如实说去哪儿答,能「去回答」;不假装送到了', async () => {
    const h = await harness({
      sessions: [asking('claude', 'd999')],
      service: { entryOf: () => 'claude-desktop' },
      engine: { connected: () => false },
    })
    expect(await h.service.answer('claude', 'd999', '1')).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: true })
    // 终端里开的、这台又没有协议那只手(socket 那条没登记):没有「去回答」,窗口那只手不接 —— 那句话照旧
    const terminal = await harness({ sessions: [asking('claude', 'd1')], service: { entryOf: () => 'cli' } })
    expect(terminal.service.replyOf(asking('claude', 'd1'))).toEqual({ reply: 'desk', where: '这一问得在电脑上开着 Claude 的那个终端窗口里回答' })
    expect(await terminal.service.answer('claude', 'd1', '1')).toMatchObject({ where: 'desk', reveal: false })
  })

  it('这一问已经不在了 → 409;没有这条会话 → 404;字是空的 → 400', async () => {
    const h = await harness({ sessions: [view({ agent: 'claude', session_id: 'd1', status: 'running' })] })
    expect(await h.service.answer('claude', 'd1', '1')).toMatchObject({ ok: false, status: 409 })
    expect(await h.service.answer('claude', 'nope', '1')).toMatchObject({ ok: false, status: 404 })
    expect(await h.service.answer('claude', 'd1', '   ')).toMatchObject({ ok: false, status: 400 })
  })

  it('★接上窗口那条:开深链 → 认那段对话 → 打字发送;两种证据都没有时如实说核不了(卡 AW)', async () => {
    const opened: string[] = []
    let broken = false
    const h = await harness({
      sessions: [asking('claude', 'd999')],
      service: { entryOf: () => 'claude-desktop', hostIdOf: () => 'local_d999', agentName: () => 'Claude' },
      engine: {
        // 深链要的那个编号(`local_…`)是**窗口那一层**问的(生产里 index.ts 给的也是这一格)。
        hostIdOf: () => 'local_d999',
        openUrl: async (url) => { opened.push(url); return { ok: true } },
        reply: (req) => {
          if (req.op === 'read_reply') return { found: true, busy: false, texts: [] }
          if (req.op === 'send_text') {
            if (broken) throw new Error('输入框没接住那一句')
            return { submitted: true, method: 'ax_value' }
          }
          return {}
        },
      },
    })
    /*
     * 送之前那段对话认在前台了(`read_reply` 找到了记号)= 卡 AW 的第一档旁证 → `confirmed:true`。
     * 深链用的是桌面 App 里那个编号(`local_…`)。
     */
    expect(await h.service.answer('claude', 'd999', ' 1 ')).toEqual({ ok: true, route: 'window', confirmed: true })
    expect(opened).toEqual(['claude://code/continue?session=local_d999'])
    expect(h.requests.filter(one => one.op === 'send_text')).toMatchObject([
      { bundle_id: 'com.anthropic.claudefordesktop', text: '1', submit: true },
    ])
    // 真没发出去(打字那一步坏了)才说没送到
    broken = true
    expect(await h.service.answer('claude', 'd999', '2')).toMatchObject({ ok: false, status: 200, where: 'desk' })
    expect((await h.service.answer('claude', 'd999', '2') as { why: string }).why).toContain('输入框没接住')
  })

  it('★认不出那段对话:照样发,送完核不上就如实说(不说成答上了,也不当没送)', async () => {
    const h = await harness({
      sessions: [asking('kimi', 'k1')],
      service: { agentName: () => 'Kimi' },
      engine: {
        // 读窗一律「没看见」:认不出那段对话、送完也核不上 —— 两种结局里的「没核上」那一档。
        reply: req => (req.op === 'send_text' ? { submitted: true } : { found: false, busy: false, texts: [] }),
      },
    })
    const got = await h.service.answer('kimi', 'k1', '技术')
    expect(got).toMatchObject({ ok: true, route: 'window', confirmed: false })
    expect((got as { note: string }).note).toContain('按了发送')
    expect(h.sentTo()).toEqual(['com.moonshot.kimichat'])
  })

  /*
   * ★ **替她按掉了她窗口上那层框 → 一定说一句**(卡 DP;审计第二表第 5 条)。
   *
   * 从前只有派活那一处读 `modal_closed` 并说一句,答 / 捎话压根不读那一格 ——
   * 于是工作台替她按了豆包正中那个推广框上的 ×,她一个字都不知道。
   * 收成一份之后这一句由 `JobResult.modalClosed` 带上来,三条路都说。
   * **替她按了键就不许做完不说**:核上了也说、没核上也说。
   */
  it('★替她按掉了挡着输入框的那层框:核上了也要说一句(卡 DP;审计第二表 5)', async () => {
    const h = await harness({
      sessions: [asking('kimi', 'w1')],
      service: { agentName: () => 'Kimi' },
      engine: {
        reply: req => (req.op === 'send_text'
          ? { submitted: true, modal_closed: '替你把挡着输入框的那层框关掉了' }
          : { found: true, busy: false, texts: [] }),
      },
    })
    expect(await h.service.answer('kimi', 'w1', '技术')).toEqual({
      ok: true, route: 'window', confirmed: true, note: '替你把挡着输入框的那层框关掉了',
    })
  })

  /*
   * ★ **账只许有一个记的人**(审计第二表第 17 条收口之后最容易回归的点)。
   * 一次答 = 闸放行一行 + 指派一行 + 投递一行,**一行不多**;键只有一种(`session:<家>/<会话 id>`)。
   * 真机那一跑在派活那一侧撞到过「两条 `assigned`」(引擎记一遍、外面又手记一遍),
   * 答这一侧没有第二个记账人 —— 这一条把它钉住。
   */
  it('★一次答恰好一行指派 + 一行投递(键只有一种,不多记)', async () => {
    const h = await harness({
      sessions: [asking('kimi', 'k1')],
      engine: { reply: req => (req.op === 'send_text' ? { submitted: true } : { found: true, busy: false, texts: [] }) },
    })
    expect(await h.service.answer('kimi', 'k1', '技术')).toMatchObject({ ok: true })
    const mine = h.events().filter(one => one.job === 'session:kimi/k1')
    expect(mine.filter(one => one.step === 'assigned')).toHaveLength(1)
    expect(mine.filter(one => one.step === 'seen' || one.step === 'sent' || one.step === 'not_sent')).toHaveLength(1)
    // 这一条链上不许冒出第二种键(从前三种 `session:` 格式就是这么漂起来的)。
    expect([...new Set(h.events().map(one => one.job))]).toEqual(['session:kimi/k1'])
    expect(mine.find(one => one.step === 'assigned')).toMatchObject({ action: 'answer_send', family: 'kimi' })
  })

  it('★同一下既按掉了那层框、又没核上:两句都说(不许只说一句)', async () => {
    const h = await harness({
      sessions: [asking('kimi', 'w1')],
      service: { agentName: () => 'Kimi' },
      engine: {
        reply: req => (req.op === 'send_text'
          ? { submitted: true, modal_closed: '替你把挡着输入框的那层框关掉了' }
          : { found: false, busy: false, texts: [] }),
      },
    })
    const got = await h.service.answer('kimi', 'w1', '技术') as { ok: boolean, confirmed?: boolean, note?: string }
    expect(got).toMatchObject({ ok: true, confirmed: false })
    expect(got.note).toContain('替你把挡着输入框的那层框关掉了')
    expect(got.note).toContain('按了发送')
  })

  it('★弹窗 / 子任务的那一问:打字送不进去(得在那家里点那个框)—— 接上了也不碰,直说去哪儿点', async () => {
    const popup: SessionView = { ...asking('claude', 'd999'), ask: { kind: 'approve', question: '它要跑测试,等你批准', since: '2026-09-25T09:50:00.000Z', by: 'form', child: { id: 'agent-a7', title: '跑一遍测试' } } }
    const h = await harness({
      sessions: [popup],
      service: { entryOf: () => 'claude-desktop', hostIdOf: () => 'local_d999' },
      // 这份壳不会 `agent_approval` → 照旧「到电脑上点」,`permission` 那一格空着。
      engine: { caps: ['read_reply', 'new_conversation'] },
    })
    const where = '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)'
    expect(h.service.replyOf(popup, { by: 'form' })).toEqual({ reply: 'desk', where, reveal: true, permission: {} })
    expect(h.service.replyOf(popup, { by: 'rules', child: { id: 'agent-a7' } })).toEqual({ reply: 'desk', where, reveal: true, permission: {} })
    expect(h.service.replyOf(popup, { by: 'rules' })).toEqual({ reply: 'window', reveal: true })
    expect(await h.service.answer('claude', 'd999', '可以')).toEqual({ ok: false, status: 200, where: 'desk', why: `这是权限弹窗,打字批不了它 —— ${where}`, reveal: true, permission: true })
    // 权限那一类**一个 op 都不发**(往对话里打一句「可以」批不了它弹的权限框)。
    expect(h.requests).toEqual([])
  })

  it('「去回答」:Claude / Codex 用它们自己的深链开到那一段;开不了或 Kimi → 把那家叫到前面', async () => {
    const opened: string[] = []
    const fronted: string[] = []
    const h = await harness({
      sessions: [],
      service: {
        entryOf: (agent) => (agent === 'codex' ? 'vscode' : 'claude-desktop'),
        hostIdOf: (agent) => (agent === 'claude' ? 'local_d999' : undefined),
      },
      /*
       * ★ 2026-10-02:「去回答」走 `engine.reveal` —— 开深链 / 叫台前都在**窗口适配器**那一层
       * (设计第三节:开窗只在那一层),顺带过上了 `bring_front` 那一样闸。所以这两样接在引擎上。
       */
      engine: {
        hostIdOf: agent => (agent === 'claude' ? 'local_d999' : undefined),
        openUrl: async (url: string) => { opened.push(url); return { ok: !url.startsWith('codex') } },
        bringToFront: async (bundleId: string) => { fronted.push(bundleId); return { ok: true } },
      },
    })
    expect(await h.service.reveal('claude', 'd999')).toEqual({ ok: true, how: 'link' })
    expect(await h.service.reveal('codex', 'c-1')).toEqual({ ok: true, how: 'app' })
    expect(await h.service.reveal('kimi', 'k-1')).toEqual({ ok: true, how: 'app' })
    expect(opened).toEqual(['claude://code/continue?session=local_d999', 'codex://threads/c-1'])
    expect(fronted).toEqual(['com.openai.codex', 'com.moonshot.kimichat'])
    // 开不到那一段、也叫不到台前(没接那两样)→ 如实说没有窗口可以调到前面
    const bare = await harness({ sessions: [] })
    expect(await bare.service.reveal('gpt', 'g1')).toMatchObject({ ok: false, how: 'none' })
  })
})

describe('「不用管这条」', () => {
  it('按内容判出来的:交给 waitingService 拿掉;弹窗那种 409;没在等 409;没有这条 404', async () => {
    const dismissed: string[] = []
    const form = { ...asking('kimi', 'k1'), ask: { kind: 'approve' as const, question: 'Kimi 停下来等你确认', since: 'x', by: 'form' as const } }
    const h = await harness({
      sessions: [asking('claude', 'd999'), form, view({ agent: 'codex', session_id: 'c1', status: 'running' })],
      service: { dismiss: async (agent, id) => { dismissed.push(`${agent}:${id}`); return true } },
    })
    expect(await h.service.dismiss('claude', 'd999')).toEqual({ ok: true })
    expect(await h.service.dismiss('kimi', 'k1')).toMatchObject({ ok: false, status: 409 })
    expect(await h.service.dismiss('codex', 'c1')).toMatchObject({ ok: false, status: 409 })
    expect(await h.service.dismiss('claude', 'nope')).toMatchObject({ ok: false, status: 404 })
    expect(dismissed).toEqual(['claude:d999'])
  })
})
