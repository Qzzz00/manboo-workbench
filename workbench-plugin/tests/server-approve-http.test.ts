// @vitest-environment node
/**
 * **手机 / 电脑 / 电话替她批准那家的权限弹窗**(2026-10-01,卡 AP)—— 真 http + 真会话文件 + 真 waitingService / sessionAnswer,
 * 壳那只手是假件(不动真窗口)。
 *
 * 现场:维护者 10-01 午饭在外面(走中转),修手机横屏那条 Claude 会话在等批准:
 * 「找到那个会话是在待确认里,输入回复内容之后,说发不出去」—— 两次 `POST /sessions/answer → 200` 都是 ok:false。
 *
 * 守:① /state 上那一问带 `permission`(不摆输入框);② `POST /sessions/approval/read` 读出壳上的键,只给批准一次 / 拒绝;
 * ③ `POST /asks/answer {choice:<键名>}` 按下去、重读核实;④ 打字撞上 → `permission:true` + 一句说清;
 * ⑤ 电话里说「批准」→ 同一条路;⑥ 门:本机或已配对的手机;⑦ 旧壳照旧到电脑上点。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { ApprovalPanelRead } from '../src/server/approvalKeys.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
// 2026-10-02:服务搬到 `sessionJobs.ts`(后面是一条引擎),六只手删了。
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { sessionAskCallOutEvents } from '../src/server/sessionAskCalls.ts'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createWaitingService, type WaitingService } from '../src/server/waitingService.ts'
import { sessionAgentName } from '../src/waiting.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW = new Date('2026-10-01T04:15:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

const line = (row: unknown) => JSON.stringify(row)
/** 它要跑一条命令,停在权限弹窗上(与 10-01 现场同一种形状)。 */
const WAITING = [
  line({ type: 'user', sessionId: 'h1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', entrypoint: 'claude-desktop', timestamp: '2026-10-01T04:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '修一下手机横屏' } }),
  line({ type: 'assistant', sessionId: 'h1', entrypoint: 'claude-desktop', timestamp: '2026-10-01T04:10:00.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm --dir butler-app test', description: '跑一遍手机端测试' } }] } }),
].join('\n')

const DIALOG: ApprovalPanelRead = { rect: { x: 20, y: 600, w: 640, h: 140 }, keys: ['Allow once', 'Allow for this session', 'Deny'] }
const KEY = 'session:claude/h1'

async function serve(hand: { canApprove?: boolean, gone?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-approve-'))
  dirs.push(dir)
  const file = join(dir, 'h1.jsonl')
  writeFileSync(file, `${WAITING}\n`)
  utimesSync(file, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000))
  let waiting: WaitingService | undefined
  const service = createWorkbenchService({ now: () => NOW_SEC, overlay: (views, nowSec) => waiting?.overlay(views, nowSec) ?? views })
  service.applyEvent({ agent: 'claude', session_id: 'h1', project: 'desktop-workbench', type: 'done', title: '修手机横屏', ts: NOW_SEC - 300 })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions })
  digest.note('claude', 'h1', file, 'claude-transcript', '修手机横屏')
  /** 壳收到的每一次「读一眼那个弹框」(2026-10-02:那两步都在适配器里面,所以这里不再有 `active` 那一格)。 */
  const reads: { marks: readonly string[] }[] = []
  const presses: { label: string, marks: readonly string[] }[] = []
  /*
   * ★ 2026-10-02:六只手删了 —— 看 / 按那个权限弹框现在是**假壳 + 真引擎**(`agent_approval`:
   * 不带 `press` = 读一眼,带 `press` = 按那一颗)。`hand.canApprove` 落成「这份壳会不会 `agent_approval`」。
   *
   * 「只读一眼 → 读不到再开到前面读」那两步现在都在适配器里面(一次调用、一回闸),
   * 所以 `reads` 记的是壳收到的每一次读 —— 第一次是不动她窗口的那一下。
   */
  const engine = engineHarness({
    // 真壳(HelperSocket)把 `agent_press` 与 `agent_approval` 报在同一串里,这里照它。
    caps: (hand.canApprove ?? true) ? ['read_reply', 'agent_press', 'agent_approval', 'new_conversation'] : ['read_reply'],
    installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    nameOf: sessionAgentName,
    reply: (req) => {
      if (req.op === 'agent_approval') {
        const press = (req as { press?: string }).press
        if (press === undefined) { reads.push({ marks: req.marks }); return { panels: [DIALOG] } }
        presses.push({ label: press, marks: req.marks })
        return { found: true, pressed: true, gone: hand.gone ?? true, how: 'ax_press' }
      }
      if (req.op === 'send_text') throw new Error('这份用例不走打字那一路')
      if (req.op === 'read_reply') return { found: false }
      return {}
    },
  })
  const answer = createSessionJobs({
    engine: engine.engine,
    registry: engine.registry,
    sessions: () => service.getState().sessions,
    entryOf: (agent, id) => waiting?.entryOf(agent, id),
    hostIdOf: (agent, id) => waiting?.hostIdOf(agent, id),
    /*
     * ★ 2026-10-02:「去回答」走 `engine.reveal` —— 开深链 / 叫台前都在**窗口适配器**那一层
     * (设计第三节:开窗只在那一层),所以这两样不在服务上了。
     */
    agentName: sessionAgentName,
    approvalMarksOf: (agent, id) => waiting?.verdictOf(agent, id)?.marks,
  })
  waiting = createWaitingService({
    sessions: () => service.rawSessions(),
    files: () => digest.files(),
    now: () => NOW,
    childrenOf: async () => [],
    // Claude 自己记着停在权限弹窗上(形式上的真证据)。
    claudeLive: async () => new Map([['h1', { alive: true, status: 'waiting', waitingFor: 'permission prompt', hostSessionId: 'local_h1' }]]),
    agentName: sessionAgentName,
    replyOf: (view, ask) => answer.replyOf(view, ask),
  })
  // 界面那几格读的是**同步**那一份能力(`knownCaps`):先现查一遍,免得第一拍答「还不知道」。
  await engine.registry.targets()
  await waiting.scanNow()
  const remote = { address: LOOPBACK }
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    sessionDigest: digest,
    waitingPump: () => { waiting?.pump() },
    sessionAnswer: answer,
    pairing,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { body?: unknown, token?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? { origin: 'http://127.0.0.1:3080' } : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async (): Promise<string> => {
    expect((await call('/lan', { body: { enabled: true } })).status).toBe(200)
    const code = ((await call('/pair/start', { body: {} })).body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: 'Ben 的手机', platform: 'android' }, from: PHONE })
    return String(claim.body.token)
  }
  const askOf = async () => ((await call('/state')).body as unknown as WorkbenchState).sessions.find(one => one.session_id === 'h1')?.ask
  return { call, pair, askOf, reads, presses, sessions: () => service.getState().sessions }
}

describe('权限弹窗:手机 / 电脑上不摆输入框,摆它弹窗上那几颗键(卡 AP)', () => {
  it('★/state:那一问是权限弹窗,读得了;没有选项、没有 press / write', async () => {
    const t = await serve()
    const ask = await t.askOf()
    expect(ask).toMatchObject({ kind: 'approve', by: 'form', reply: 'desk', permission: { readable: true } })
    expect(ask?.press).toBeUndefined()
    expect(ask?.write).toBeUndefined()
    // 命令原字不上 /state(只给认弹窗那一路用)
    expect(JSON.stringify(ask)).not.toContain('pnpm --dir')
  })

  it('★手机上打开那张卡 → 读键:只给「批准一次 / 拒绝」,之后 /state 带上这两颗', async () => {
    const t = await serve()
    const token = await t.pair()
    const read = await t.call('/sessions/approval/read', { body: { agent: 'claude', session_id: 'h1' }, token, from: PHONE })
    expect(read).toEqual({ status: 200, body: { ok: true, keys: [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }], held: ['Allow for this session'] } })
    // 认弹窗用的是这一步自己的命令 + 那一步的说明
    expect(t.reads[0]?.marks).toEqual(['pnpm --dir butler-app test', '跑一遍手机端测试'])
    expect((await t.askOf())?.permission).toEqual({ keys: [{ label: 'Allow once', does: 'once' }, { label: 'Deny', does: 'deny' }] })
  })

  it('★点「Allow once」→ 按下去、核实那颗键没了 → 「已替你批准了这一次」', async () => {
    const t = await serve()
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: 'Allow once' } })
    expect(res.body).toEqual({ ok: true, picked: 'Allow once', confirmed: true, note: '已替你批准了这一次(按的是「Allow once」)' })
    expect(t.presses).toEqual([{ label: 'Allow once', marks: ['pnpm --dir butler-app test', '跑一遍手机端测试'] }])
  })

  it('★点「Deny」→ 「已替你拒绝了」;按了还在 → 没按上,不说成批了', async () => {
    expect((await (await serve()).call('/asks/answer', { body: { key: KEY, choice: 'Deny' } })).body)
      .toMatchObject({ ok: true, confirmed: true, note: '已替你拒绝了(按的是「Deny」)' })
    const stuck = await (await serve({ gone: false })).call('/asks/answer', { body: { key: KEY, choice: 'Allow once' } })
    expect(stuck.body).toMatchObject({ ok: true, confirmed: false, note: '按了「Allow once」,可那个弹窗还在 —— 没按上,去电脑上的 Claude 看一眼' })
  })

  it('★「本次会话都允许」那颗不替她按 → 400', async () => {
    const t = await serve()
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: 'Allow for this session' } })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('放宽')
    expect(t.presses).toEqual([])
  })

  it('★打字撞上(10-01 现场)→ 一句说清是权限弹窗 + permission:true;一个字都不往对话里打', async () => {
    const t = await serve()
    const token = await t.pair()
    const res = await t.call('/sessions/answer', { body: { agent: 'claude', session_id: 'h1', text: '可以' }, token, from: PHONE })
    expect(res.body).toEqual({ ok: false, where: 'desk', why: '这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键', reveal: true, permission: true })
    // 同一个口的新路(asks/answer 的 text 那一格)也一样
    expect((await t.call('/asks/answer', { body: { key: KEY, text: '可以' } })).body).toMatchObject({ ok: false, permission: true })
  })

  it('★电话里说「批准」→ 同一条路按「批准一次」那颗', async () => {
    const t = await serve()
    const res = await t.call('/asks/voice', { body: { item_id: 'session:h1', said: '批准吧' } })
    expect(res.body).toMatchObject({ ok: true, kind: 'session', picked: 'Allow once', approved: 'once', confirmed: true })
    expect(t.presses.map(one => one.label)).toEqual(['Allow once'])
  })

  it('电话里没听出批还是不批 → 400,一颗都不按', async () => {
    const t = await serve()
    const res = await t.call('/asks/voice', { body: { item_id: 'session:h1', said: '等我想想' } })
    expect(res.status).toBe(400)
    expect(t.presses).toEqual([])
  })

  it('★座机那一通的话:说得清能在电话里批 / 拒', async () => {
    const t = await serve()
    const events = sessionAskCallOutEvents({ sessions: t.sessions() as never })
    expect(events[0]?.note).toBe('电话里说「批准」或「拒绝」,我替你按它弹窗上那颗键')
  })

  it('门:没配对的手机读不了也按不了;已配对的读得了', async () => {
    const t = await serve()
    expect((await t.call('/sessions/approval/read', { body: { agent: 'claude', session_id: 'h1' }, from: PHONE })).status).toBe(403)
    expect((await t.call('/sessions/approval/read', { body: { agent: 'claude' } })).status).toBe(400)
  })

  it('★旧壳:/state 那一格是空的(照样不摆输入框),读 / 按都如实说到电脑上点', async () => {
    const t = await serve({ canApprove: false })
    expect((await t.askOf())).toMatchObject({ permission: {}, where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)' })
    expect((await t.call('/sessions/approval/read', { body: { agent: 'claude', session_id: 'h1' } })).body)
      .toEqual({ ok: false, where: 'desk', why: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true })
    const events = sessionAskCallOutEvents({ sessions: t.sessions() as never })
    expect(events[0]?.note).toBe('这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)')
  })
})
