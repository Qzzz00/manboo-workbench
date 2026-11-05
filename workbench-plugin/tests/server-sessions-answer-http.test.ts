// @vitest-environment node
/**
 * 「在等你」接到 /state 与外层(2026-09-25,卡 T):别家会话在等他 → 进卡 M 那一堆、同一个数;答了往哪送 / 「去回答」。
 *
 * 真 http + 真会话文件(临时目录,Claude transcript 的形状)+ 真的 waitingService / sessionAnswer;不调模型。守:
 * ① 正文里在问他(没弹窗)的那条会话:/state.sessions 里是 waiting + ask,/state.waiting 里多一件 `session`,数一起算;
 * ② `POST /sessions/answer`:两只手都没接时如实说「这一问得在电脑上的 Claude 里回答」;门同 /questions/answer;
 * ③ `POST /sessions/reveal`(「去回答」)只在本机;深链是那家自己的;
 * ④ 事务官自己的会话不进这一格(她问他的走卡 M 那两样,已经数过)。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WaitingView, WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
// 2026-10-02:服务搬到 `sessionJobs.ts`(后面是一条引擎),六只手删了。
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createWaitingService, type WaitingService } from '../src/server/waitingService.ts'
import { sessionAgentName } from '../src/waiting.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW = new Date('2026-09-25T10:00:00.000Z')
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
const ASKING = [
  line({ type: 'user', sessionId: 'd999', cwd: '/Users/example/Documents/GitHub/ben-dsh-workbench', entrypoint: 'claude-desktop', timestamp: '2026-09-25T09:30:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '额度那边你看着办' } }),
  line({ type: 'assistant', sessionId: 'd999', entrypoint: 'claude-desktop', timestamp: '2026-09-25T09:34:23.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '有件事需要你定:**今天的模型额度只剩 0.58 元。**\n\n三个选择:\n\n1. **把上限提到 15 元(我推荐)**:我改中转上的设置\n2. **不提,今天省着用**:剩下的留给你\n3. **你换成自己的 DeepSeek Key**:在设置里填\n\n你选哪个?回个数字就行。' }] } }),
].join('\n')

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sessions-answer-'))
  dirs.push(dir)
  const file = join(dir, 'd999.jsonl')
  writeFileSync(file, `${ASKING}\n`)
  utimesSync(file, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000))
  let waiting: WaitingService | undefined
  const service = createWorkbenchService({ now: () => NOW_SEC, overlay: (views, nowSec) => waiting?.overlay(views, nowSec) ?? views })
  // 这一轮说完了(桌面 App 记着 idle)—— 状态上一点看不出在等他
  service.applyEvent({ agent: 'claude', session_id: 'd999', project: 'ben-dsh-workbench', type: 'done', title: '统筹', ts: NOW_SEC - 1500 })
  service.applyEvent({ agent: 'dsh', session_id: 'dsh-1', project: '事务官', type: 'done', ts: NOW_SEC - 100 })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions })
  digest.note('claude', 'd999', file, 'claude-transcript', '统筹')
  const opened: string[] = []
  /*
   * 这一份测的是**回包与那几道门**(谁答得了、409 / 404 / 400、「去回答」开哪条深链),
   * 不测「送进那扇窗」那一下 —— 所以壳**没连上**:送话那一路于是一律如实回「到电脑上答」。
   */
  /*
   * 这一份测的是**回包与那几道门**;送话那一下不测 —— 所以壳**没连上**。
   * 但「去回答」那一下要测(它走 `engine.reveal`,开深链在窗口适配器那一层),
   * 所以 `openUrl` / `hostIdOf` 接在引擎上。
   */
  const engine = engineHarness({
    connected: () => false,
    hostIdOf: () => 'local_host1',
    openUrl: async (url: string) => { opened.push(url); return { ok: true } },
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
    dismiss: async (agent, id) => await waiting?.dismiss(agent, id) ?? false,
  })
  waiting = createWaitingService({
    sessions: () => service.rawSessions(),
    files: () => digest.files(),
    now: () => NOW,
    childrenOf: async () => [],
    // Claude 自己记的这条会话(idle,桌面 App 里的编号 local_…)
    claudeLive: async () => new Map([['d999', { alive: true, status: 'idle', hostSessionId: 'local_host1' }]]),
    agentName: sessionAgentName,
    replyOf: (view, ask) => answer.replyOf(view, ask),
  })
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
  const call = async (path: string, init: { method?: string, body?: unknown, token?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async () => {
    expect((await call('/lan', { body: { enabled: true } })).status).toBe(200)
    const code = ((await call('/pair/start', { method: 'POST' })).body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: 'Ben 的手机', platform: 'android' }, from: PHONE })
    return claim.body.token as string
  }
  return { call, pair, opened }
}

describe('「在等你」进 /state 与外层那一堆', () => {
  /**
   * 2026-09-26(卡 V 补)改了断言的一半:**按内容判出来的不改运行状态**。
   * 这条会话是 `done`(它说完了、顺口问了他一句),所以在「几条在跑几条做完」那个口径里就是**做完了**;
   * 那一问一个都没少 —— `ask` 挂着、外层「等你」那一堆照旧数它一件(下面几行原样没动)。
   * 理由与那一幕见 src/server/waitingForYou.ts 的 overlayWaiting。
   */
  it('★正文里在问他、没弹窗的那条 Claude 会话:挂 ask、运行状态原样;进「等你」那一堆、同一个数;事务官的不进', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    const session = state.sessions.find(one => one.session_id === 'd999')
    // 运行状态原样(seed 里它是 done);没有被改成 waiting、也没被补 wait_reason。
    expect(session).toMatchObject({ status: 'done' })
    expect(session?.wait_reason).toBeUndefined()
    expect(session?.ask).toMatchObject({
      kind: 'choose',
      question: '今天的模型额度只剩 0.58 元。',
      since: '2026-09-25T09:34:23.000Z',
      quote: '你选哪个?回个数字就行。',
      by: 'rules',
      reply: 'desk',
      where: '这一问得在电脑上的 Claude 里回答',
    })
    expect(session?.ask?.options?.map(option => option.label)).toEqual(['把上限提到 15 元(我推荐)', '不提,今天省着用', '你换成自己的 DeepSeek Key'])
    // 外层那一堆:一件 `session`,一句人话说清哪家在等、等他做什么;不贴原文
    const pile = state.waiting as WaitingView
    expect(pile.count).toBe(1)
    expect(pile.items).toEqual([{ key: 'session:claude/d999', kind: 'session', verb: '答', text: 'Claude 在等你选:今天的模型额度只剩 0.58 元' }])
    expect(JSON.stringify(pile)).not.toContain('回个数字')
    /**
     * Claude 那一格:既不算「等你」也不算「在跑」—— 它**做完了**(卡 V 09-26)。
     * 「等你」那个数看的是外层那一堆(上面 `pile.count === 1`),那才是他要动手的清单;
     * `agents[].waiting` 数的是**会话停在那儿动不了**的条数,这条会话没停着。
     */
    expect(state.agents.find(agent => agent.id === 'claude')).toMatchObject({ waiting: 0, running: 0 })
  })

  it('★POST /sessions/answer:两只手都没接 → 如实说去哪儿答(不假装送到了);已配对的手机也能问;这一问不在了 409', async () => {
    const t = await serve()
    const desk = await t.call('/sessions/answer', { body: { agent: 'claude', session_id: 'd999', text: '1' } })
    expect(desk).toEqual({ status: 200, body: { ok: false, where: 'desk', why: '这一问得在电脑上的 Claude 里回答', reveal: true } })
    const token = await t.pair()
    expect((await t.call('/sessions/answer', { body: { agent: 'claude', session_id: 'd999', text: '1' }, from: PHONE })).status).toBe(401)
    const phone = await t.call('/sessions/answer', { body: { agent: 'claude', session_id: 'd999', text: '1' }, from: PHONE, token })
    expect(phone.body).toMatchObject({ ok: false, where: 'desk' })
    expect((await t.call('/sessions/answer', { body: { agent: 'dsh', session_id: 'dsh-1', text: '1' } })).status).toBe(409)
    expect((await t.call('/sessions/answer', { body: { agent: 'claude', session_id: 'd999', text: '' } })).status).toBe(400)
    expect((await t.call('/sessions/answer', { body: { agent: '../x', session_id: 'd999', text: '1' } })).status).toBe(400)
  })

  it('★POST /sessions/reveal(「去回答」):只在本机;用 Claude 自己的深链开到那一段', async () => {
    const t = await serve()
    const res = await t.call('/sessions/reveal', { body: { agent: 'claude', session_id: 'd999' } })
    expect(res.body).toEqual({ ok: true, how: 'link' })
    expect(t.opened).toEqual(['claude://code/continue?session=local_host1'])
    const token = await t.pair()
    expect((await t.call('/sessions/reveal', { body: { agent: 'claude', session_id: 'd999' }, from: PHONE, token })).status).toBe(403)
  })

  it('POST /sessions/ask/dismiss(「不用管这条」):拿掉之后 /state 里不再算它,「等你」那一堆也少一件', async () => {
    const t = await serve()
    expect((await t.call('/sessions/ask/dismiss', { body: { agent: 'claude', session_id: 'd999' } })).body).toEqual({ ok: true })
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.sessions.find(one => one.session_id === 'd999')?.ask).toBeUndefined()
    expect((state.waiting as WaitingView).count).toBe(0)
    expect((await t.call('/sessions/ask/dismiss', { body: { agent: 'claude', session_id: 'd999' } })).status).toBe(409)
  })
})
