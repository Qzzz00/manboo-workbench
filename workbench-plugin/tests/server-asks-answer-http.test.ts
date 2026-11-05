// @vitest-environment node
/**
 * **他在抽屉里点了那一项 → 工作台真替他答进那家窗口**(2026-09-28,卡 WQ;设计-派活到收回一条链 第 ⑧ 环)。
 *
 * 维护者原话:「它现在几个选项给出来了,给完之后我还不能选,我还得回那个会话窗口回……
 * 手机和电脑上都一样,都这么说的。那这个功能的意义就变成了:我告诉你有事,但是我帮你传不了话。」
 *
 * 真 http + 真会话文件 + 真 waitingService / sessionAnswer;壳那只手是假件(不动真窗口)。守:
 * ① 弹框那一问(`by:'form'`)照旧 `reply:'desk'`,但带 `press:true` —— 界面据此把选项摆成能点的键;
 * ② `POST /asks/answer {key:'session:…', choice}`:点下去、**重读核实那一问没了**才说「已替你答了」;
 * ③ 核不上(`gone:false`)如实说「点了,但没看到它收下」——**不谎报**;
 * ④ 不是它给的那一项 → 400,一处都不点(绝不替他挑);
 * ⑤ 壳不会这件事(旧壳)→ 200 + `where:'desk'`,照旧「到电脑上点」;
 * ⑥ 门同 `/sessions/answer`(回环或已配对的手机)。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { CALL_OUT_MOOT_ASK_ERROR, createCallOutService } from '../src/server/callOut.ts'
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
const NOW = new Date('2026-09-28T10:00:00.000Z')
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
/** 它弹了个框问他选哪个(与现场那道菜系题同一种形状:一问 + 几个选项)。 */
const ASKING = [
  line({ type: 'user', sessionId: 'd777', cwd: '/Users/example/Documents/GitHub/ben-dsh-workbench', entrypoint: 'claude-desktop', timestamp: '2026-09-28T09:30:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '随便问我一道选择题' } }),
  line({ type: 'assistant', sessionId: 'd777', entrypoint: 'claude-desktop', timestamp: '2026-09-28T09:34:23.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '你最喜欢哪种菜系?\n\n1. **川菜**\n2. **粤菜**\n3. **湘菜**\n\n你选哪个?' }] } }),
].join('\n')

async function serve(hand: { canPress: boolean, gone?: boolean, found?: boolean } = { canPress: true, gone: true },
                     /** 挂一本真台账(卡 AQ:答完那一通要撤掉)。缺省不挂 —— 与 09-28 那几条一个字不差。 */
                     withCallOut = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-asks-answer-'))
  dirs.push(dir)
  const file = join(dir, 'd777.jsonl')
  writeFileSync(file, `${ASKING}\n`)
  utimesSync(file, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000))
  let waiting: WaitingService | undefined
  const service = createWorkbenchService({ now: () => NOW_SEC, overlay: (views, nowSec) => waiting?.overlay(views, nowSec) ?? views })
  service.applyEvent({ agent: 'claude', session_id: 'd777', project: 'ben-dsh-workbench', type: 'done', title: '统筹', ts: NOW_SEC - 1500 })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions })
  digest.note('claude', 'd777', file, 'claude-transcript', '统筹')
  /** 壳那只手(假件):按了哪一项记下来,不动任何真窗口。 */
  const pressed: { bundleId: string, label: string, options?: readonly string[] }[] = []
  /*
   * ★ 2026-10-02:六只手删了 —— 「替她点那一项」现在是**假壳 + 真引擎**(`agent_press`)。
   * `hand.canPress` 那一格落成「这份壳会不会 `agent_press`」(旧壳就是不会);
   * `hand.found` / `hand.gone` 落成壳那一包的回执。
   */
  const engine = engineHarness({
    caps: hand.canPress ? ['read_reply', 'agent_press', 'new_conversation'] : ['read_reply'],
    installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    // 人话里那一家叫什么(生产里 index.ts 给的是登记表里的显示名)。
    nameOf: sessionAgentName,
    reply: (req) => {
      if (req.op === 'agent_press') {
        const options = (req as { options?: readonly string[] }).options
        pressed.push({ bundleId: req.bundle_id, label: req.label, ...(options === undefined ? {} : { options }) })
        return hand.found === false
          ? { found: false, note: `它窗口里没找到「${req.label}」这一项` }
          : { found: true, pressed: true, gone: hand.gone !== false, how: 'ax_press' }
      }
      // 送话那一路这一份用例不测(框收掉之后那条替代路要它):一律说送不出去。
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
  })
  waiting = createWaitingService({
    sessions: () => service.rawSessions(),
    files: () => digest.files(),
    now: () => NOW,
    childrenOf: async () => [],
    // Claude 自己记着「停下来等他输入」(弹框那一问的真证据,卡 KM)。
    claudeLive: async () => new Map([['d777', { alive: true, status: 'waiting', waitingFor: 'input needed', hostSessionId: 'local_host7' }]]),
    agentName: sessionAgentName,
    replyOf: (view, ask) => answer.replyOf(view, ask),
  })
  // 界面那几格读的是**同步**那一份能力(`knownCaps`):先现查一遍,免得第一拍答「还不知道」。
  await engine.registry.targets()
  await waiting.scanNow()
  const remote = { address: LOOPBACK }
  /**
   * 座机台账(卡 AQ)。`askEvents` 就是生产里那一串(`sessionAskCallOutEvents`,读同一份会话表),
   * 于是「这一问还在不在」这件事在用例里也是从同一处算出来的。
   */
  const callOut = withCallOut
    ? createCallOutService({
        file: join(dir, 'call-out.json'),
        newId: () => 'call-1',
        now: () => NOW.getTime(),
        askEvents: async () => sessionAskCallOutEvents({ sessions: service.getState().sessions as never }),
      })
    : undefined
  await callOut?.load()
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
    ...(callOut === undefined ? {} : { callOut }),
    pairing,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, body?: unknown, token?: string, from?: string, asProgram?: boolean } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        // 本机不带令牌的那一下默认是她在页面上点(卡 BS 那道门认 Origin);asProgram 模拟一段不带身份的程序。
        ...(init.token === undefined && init.asProgram !== true ? { origin: 'http://127.0.0.1:3080' } : {}),
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
    const claim = await call('/pair/claim', { code, device_name: 'Ben 的手机', platform: 'android' } as never)
    return claim
  }
  return { call, pair, pressed, callOut }
}

const KEY = 'session:claude/d777'

describe('抽屉里点一项 → 真替他答进那家窗口(卡 WQ)', () => {
  it('★弹框那一问:reply 照旧 desk(打字送不进去),但带 press:true —— 那几项点得下去', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    const ask = state.sessions.find(one => one.session_id === 'd777')?.ask
    expect(ask).toMatchObject({ by: 'form', reply: 'desk', press: true })
    expect(ask?.options?.map(one => one.label)).toEqual(['川菜', '粤菜', '湘菜'])
    // 「等你」那一堆里照旧一件(电脑与手机读同一份)。
    expect(state.waiting?.items.map(one => one.key)).toEqual([KEY])
  })

  it('★点「川菜」:壳按下去、重读核实那一问没了 → 「已替你答了:川菜」', async () => {
    const t = await serve({ canPress: true, gone: true })
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, picked: '川菜', confirmed: true, note: '已替你答了:川菜' })
    /*
     * 这一问的几项一并带给壳(只画了标题那一截时要核唯一,09-28 20:5x)。
     *
     * ★ 2026-10-02:断言的是**壳真收到的那一包**(`agent_press` 的字段就这三格)——
     * 从前这里断的是「那只手」的入参(`job` / `family` / `deepLink` 那几格),而那只手已经删了:
     * 闸的键、家名、深链都在引擎与窗口适配器里面,壳的 op 字段一格没动。
     * 「撞上没窗口时靠深链把那一段重新开出来再点一回」那一条由
     * `window-ops-no-window-wake.test.ts` 钉着(那一份数的就是开了几回深链)。
     */
    expect(t.pressed).toEqual([{
      bundleId: 'com.anthropic.claudefordesktop',
      label: '川菜',
      options: ['川菜', '粤菜', '湘菜'],
    }])
  })

  it('★点了、没看到它收下(核实没过)→ 如实说「去看一眼」,不谎报答上了', async () => {
    const t = await serve({ canPress: true, gone: false })
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })
    expect(res.body).toMatchObject({ ok: true, confirmed: false })
    expect(String(res.body.note)).toContain('没看到它收下')
    expect(String(res.body.note)).toContain('Claude')
  })

  it('★不是它给的那一项 → 400,一处都不点(绝不替他挑一个)', async () => {
    const t = await serve()
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '西北菜' } })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('不是它给的选项')
    expect(t.pressed).toEqual([])
  })

  it('★它窗口里没找到那一项(框收了 / 认不出)→ 200 + 去哪儿点那一句,不说成答上了', async () => {
    const t = await serve({ canPress: true, found: false })
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })
    expect(res.body).toMatchObject({ ok: false, where: 'desk' })
    expect(String(res.body.why)).toContain('没找到「川菜」')
  })

  it('★旧壳不会替他点:/state 里没有 press,这一项也答不上去 —— 照旧「到电脑上点」', async () => {
    const t = await serve({ canPress: false })
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    expect(state.sessions.find(one => one.session_id === 'd777')?.ask?.press).toBeUndefined()
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })
    expect(res.body).toMatchObject({ ok: false, where: 'desk' })
    expect(String(res.body.why)).toContain('Claude')
  })

  it('这个口只在本机或已配对的手机上开;key / choice 缺了就 400', async () => {
    const t = await serve()
    expect((await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' }, from: PHONE })).status).toBe(403)
    expect((await t.call('/asks/answer', { body: { choice: '川菜' } })).status).toBe(400)
    expect((await t.call('/asks/answer', { body: { key: KEY } })).status).toBe(400)
    expect((await t.call('/asks/answer', { body: { key: 'laid:x', choice: '好' } })).status).toBe(400)
  })

  /**
   * ★ **答完那一通就不打了**(2026-09-28,卡 AQ)。真机 18:0x:她在电脑上答上了(`confirmed:true`),
   * 可那一通还挂在 `call-out.json` 里 `state:'queued'`(当时房里没有在线手机,没响)——
   * 等手机上线就要为一个已经答掉的问打过去,电话里那句「Codex 在等你选…」是句假话。
   */
  it('★她答上了 → 排着的那一通当场撤掉,工人再也领不走它', async () => {
    const t = await serve({ canPress: true, gone: true }, true)
    await t.callOut?.pump()
    expect(t.callOut?.view().entries[0]).toMatchObject({ reason: 'ask', item_id: 'session:claude/d777', state: 'queued', silent: false })
    expect((await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })).body).toMatchObject({ confirmed: true })
    expect(t.callOut?.view().entries[0]).toMatchObject({ state: 'failed', error: CALL_OUT_MOOT_ASK_ERROR })
    expect(await t.callOut?.claim()).toEqual([])
  })

  it('★点了、没看到它收下 → 那一通不撤(那一问可能还在等她)', async () => {
    const t = await serve({ canPress: true, gone: false }, true)
    await t.callOut?.pump()
    expect((await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' } })).body).toMatchObject({ confirmed: false })
    expect(t.callOut?.view().entries[0]).toMatchObject({ state: 'queued' })
  })

  it('★只有她本人能答:本机一段不带身份的程序(事务官、别家)→ 403,一处都不点', async () => {
    const t = await serve()
    const res = await t.call('/asks/answer', { body: { key: KEY, choice: '川菜' }, asProgram: true })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toContain('只有你本人能答')
  })
})
