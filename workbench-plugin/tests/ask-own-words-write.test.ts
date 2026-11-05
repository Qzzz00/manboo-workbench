// @vitest-environment node
/**
 * **她打了一句自己的话 → 工作台把那句原文写进那家提问面板里的自由作答框**
 * (2026-09-28,卡 AT;设计-派活到收回一条链 第 ⑧ 环剩下那一半)。
 *
 * 维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
 *
 * 卡 WQ / AQ 做到的是「替她点框上那一项」;不在那几项里的一句话从前只能如实说
 * 「要自己说一句,得在电脑上…」。这一份用例守的是那半件补上之后的口径:
 * ① `/state` 上多一格 `write:true` —— 界面据此摆「我自己说」那个框;
 * ② `POST /asks/answer {key, text}`:她那句**原文一字不改**交给壳,壳那边认面板要的几截原话
 *    (选项 + 它那一句)一并带上;
 * ③ 核实**两条**(那个面板没了 + 窗口里出现了她那句)才说「已替你答了」;
 * ④ 少一条就如实说「写进去了,但没看到它收下」,并且**排着的那一通不撤**;
 * ⑤ 认不出那个面板 / 这一家没这一样 → 照旧那句「到电脑上…」,**不假装写进去了**;
 * ⑥ 电话里说的那一句不在选项里 → 走同一条路;
 * ⑦ 门照旧:只认她本人。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」)这一份改成「假壳 + 真引擎」,**换了主角**。为什么要换:
 *
 * 「往提问面板里写字」从卡 AT2 起就**只对真机上认准了的那个包开着**(`com.work.pc.doubao`,
 * 2026-09-28 Air 维护包真机:写进去、面板收了、正文里有她那句)。别家关着 ——
 * 0.4.60 真机上 Codex 那个提问框其实已经收了,那句话落进了底部主输入框(没发出去),回包却报「已替你答了」。
 * 判据从前在 `sessionAnswer` 那只手上(`canWriteAsk(bundleId)`),现在在
 * `engine/adapters/window.ts` 的 `WRITE_ASK_PACKAGES` 一处(`capabilities().writeAsk` 读的就是它)。
 *
 * 而这一份用例从前给的是一只**自己答应「会写」的假手**,所以它用 Claude 那条会话跑面板那条路 ——
 * 那是生产里**从来没有过**的行为(Claude 那个包不在名单里)。接上真适配器之后假不下去了,于是:
 *
 * - 第一节(真 http + 真会话文件 + 真 waitingService):主角还是 Claude,钉的是**真实口径** ——
 *   面板那一路对它关着,她那句话走「原样送进这条对话、按发送」(维护者 09-28 20:1x:
 *   「是把我的文字复制过去发送」);
 * - 第二节:面板那条路钉在**豆包办公**那个包上(服务 + 真适配器,不起 http),卡 AT 那几条口径一条不少。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { CALL_OUT_MOOT_ASK_ERROR, createCallOutService } from '../src/server/callOut.ts'
import { askPanelMarksOf } from '../src/server/sessionAnswer.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAskCallOutEvents } from '../src/server/sessionAskCalls.ts'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createWaitingService, type WaitingService } from '../src/server/waitingService.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW = new Date('2026-09-28T10:00:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)
/** 她打的那一句(不在它给的那几项里)。**一字不改**地送进去。 */
const HERS = '换成江浙菜,清淡一点'

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
/** 它弹了个框问她选哪个(与现场那道菜系题同一种形状)。 */
const ASKING = [
  line({ type: 'user', sessionId: 'd777', cwd: '/Users/example/Documents/GitHub/ben-dsh-workbench', entrypoint: 'claude-desktop', timestamp: '2026-09-28T09:30:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '随便问我一道选择题' } }),
  line({ type: 'assistant', sessionId: 'd777', entrypoint: 'claude-desktop', timestamp: '2026-09-28T09:34:23.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '你最喜欢哪种菜系?\n\n1. **川菜**\n2. **粤菜**\n3. **湘菜**\n\n你选哪个?' }] } }),
].join('\n')

type Hand = {
  /** 送完读窗口,对话区里出现她那句了没有(这一路的证据就是它)。 */
  echoed?: boolean
  /** 壳这一下直接失败(真壳失败是 reject 一个 Error)。 */
  fails?: string
}

async function serve(hand: Hand = {}, withCallOut = false) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ask-own-words-'))
  dirs.push(dir)
  const file = join(dir, 'd777.jsonl')
  writeFileSync(file, `${ASKING}\n`)
  utimesSync(file, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000))
  let waiting: WaitingService | undefined
  const service = createWorkbenchService({ now: () => NOW_SEC, overlay: (views, nowSec) => waiting?.overlay(views, nowSec) ?? views })
  service.applyEvent({ agent: 'claude', session_id: 'd777', project: 'ben-dsh-workbench', type: 'done', title: '统筹', ts: NOW_SEC - 1500 })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions })
  digest.note('claude', 'd777', file, 'claude-transcript', '统筹')
  /*
   * 假壳 + 真引擎。钟**定住**:界面那几格(`press` / `write`)读的是 `knownCaps` 的缓存(几秒就过期),
   * 钟往前走会让同一条用例里那一格变回「还没查过」。每一种闸上的动作在一条用例里只来一回。
   */
  let afterSend = false
  const h = engineHarness({
    nameOf: sessionAgentName,
    now: () => NOW,
    hostIdOf: (_family, id) => waiting?.hostIdOf('claude', id),
    openUrl: async () => ({ ok: true }),
    reply: (req: HelperRequest) => {
      if (req.op === 'send_text') {
        if (hand.fails !== undefined) throw new Error(hand.fails)
        afterSend = true
        return { submitted: true, method: 'ax' }
      }
      if (req.op === 'read_reply') {
        // 认那段对话:一直认不出(真机上就是这样);读她那句:送完才读得到
        const marker = (req as { marker?: string }).marker
        return { found: afterSend && hand.echoed !== false && marker === HERS, busy: false, texts: [] }
      }
      if (req.op === 'agent_press') return { found: true, pressed: true, gone: true, how: 'ax_press' }
      return {}
    },
  })
  const answer = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => service.getState().sessions,
    entryOf: (agent, id) => waiting?.entryOf(agent, id),
    hostIdOf: (agent, id) => waiting?.hostIdOf(agent, id),
    agentName: sessionAgentName,
  })
  // 界面那几格读的是现查来的那一份能力(同生产里 /state 那一拍)。
  await h.registry.targets()
  waiting = createWaitingService({
    sessions: () => service.rawSessions(),
    files: () => digest.files(),
    now: () => NOW,
    childrenOf: async () => [],
    claudeLive: async () => new Map([['d777', { alive: true, status: 'waiting', waitingFor: 'input needed', hostSessionId: 'local_host7' }]]),
    agentName: sessionAgentName,
    replyOf: (view, ask) => answer.replyOf(view, ask),
  })
  await waiting.scanNow()
  const remote = { address: LOOPBACK }
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
  const call = async (path: string, init: { method?: string, body?: unknown, from?: string, asProgram?: boolean } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.asProgram !== true ? { origin: 'http://127.0.0.1:3080' } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return {
    call,
    callOut,
    /** 面板那一路(`agent_write_ask`)有没有动过。 */
    wrote: () => h.requests.filter(one => one.op === 'agent_write_ask'),
    /** 当一句话送进对话那一路。 */
    sent: () => h.requests.filter(one => one.op === 'send_text') as (HelperRequest & { text: string, submit?: boolean, bundle_id: string })[],
    pressed: () => h.requests.filter(one => one.op === 'agent_press').map(one => (one as { label: string }).label),
  }
}

const KEY = 'session:claude/d777'
const ITEM = 'session:claude/d777'

describe('写面板只对认准了的那个包开着 —— Claude 这一路走「把她的文字复制过去发送」', () => {
  it('★弹框那一问:/state 上 press:true;write 那一格**不摆**(Claude 那个包不在名单里)', async () => {
    const t = await serve()
    const state = (await t.call('/state')).body as unknown as WorkbenchState
    const ask = state.sessions.find(one => one.session_id === 'd777')?.ask
    expect(ask).toMatchObject({ by: 'form', reply: 'desk', press: true })
    expect(ask?.write).toBeUndefined()
  })

  it('★她打的那一句:面板一个字都不写,原样送进这条对话、按发送(09-28 20:1x「是把我的文字复制过去发送」)', async () => {
    const t = await serve()
    const res = await t.call('/asks/answer', { body: { key: KEY, text: HERS } })
    expect(res.status).toBe(200)
    expect(t.wrote()).toEqual([])
    expect(t.sent()).toHaveLength(1)
    expect(t.sent()[0]?.bundle_id).toBe('com.anthropic.claudefordesktop')
    // **一字不改**(不清洗、不补话、不截断)
    expect(t.sent()[0]?.text).toBe(HERS)
    expect(t.sent()[0]?.submit).toBe(true)
    // 一处都没点(这一路不碰选项)
    expect(t.pressed()).toEqual([])
  })

  it('★送完在对话区里看见了她那句 → 「已替你答了:<她那句>」', async () => {
    const t = await serve({ echoed: true })
    const res = await t.call('/asks/answer', { body: { key: KEY, text: HERS } })
    expect(res.body).toMatchObject({ ok: true, confirmed: true, note: `已替你答了:${HERS}` })
  })

  it('★对话区里没出现她那句 → 如实说核不上,不谎报答上了', async () => {
    const t = await serve({ echoed: false })
    const res = await t.call('/asks/answer', { body: { key: KEY, text: HERS } })
    expect(res.body).toMatchObject({ ok: true, confirmed: false })
    expect(String(res.body.note)).toContain('可能发到了别的对话')
  })

  it('★壳那边送不出去 → 200 + 去哪儿答那一句,绝不说成送到了', async () => {
    const t = await serve({ fails: '它窗口里没找着输入框' })
    const res = await t.call('/asks/answer', { body: { key: KEY, text: HERS } })
    expect(res.body).toMatchObject({ ok: false, where: 'desk' })
    expect(String(res.body.why)).toContain('没找着输入框')
  })

  it('★答上了 → 排着的那一通当场撤掉,工人再也领不走它', async () => {
    const t = await serve({ echoed: true }, true)
    await t.callOut?.pump()
    expect(t.callOut?.view().entries[0]).toMatchObject({ reason: 'ask', item_id: ITEM, state: 'queued' })
    expect((await t.call('/asks/answer', { body: { key: KEY, text: HERS } })).body).toMatchObject({ confirmed: true })
    expect(t.callOut?.view().entries[0]).toMatchObject({ state: 'failed', error: CALL_OUT_MOOT_ASK_ERROR })
    expect(await t.callOut?.claim()).toEqual([])
  })

  it('★没核上 → 那一通照旧排着(那一问可能还在等她)', async () => {
    const t = await serve({ echoed: false }, true)
    await t.callOut?.pump()
    expect((await t.call('/asks/answer', { body: { key: KEY, text: HERS } })).body).toMatchObject({ confirmed: false })
    expect(t.callOut?.view().entries[0]).toMatchObject({ state: 'queued' })
  })

  it('电话里说中了某一项 → 照旧替她点那一项(卡 WQ 那一路一个字没改)', async () => {
    const t = await serve()
    const res = await t.call('/asks/voice', { body: { item_id: ITEM, said: '就川菜吧' } })
    expect(res.body).toMatchObject({ ok: true, kind: 'session', picked: '川菜', confirmed: true })
    expect(t.wrote()).toEqual([])
  })

  /**
   * ★ **电话里那一句与手机 / 电脑上那一句走同一条路**(2026-10-02 收成一份;审计第二表第 12 条)。
   *
   * 从前 `/asks/voice` 要 `ask.write === true`(= 那一家的提问面板在真机上认准了,今天只有豆包办公
   * 那一个包)才肯送,别的一律回 400「一项都没点」—— 于是**同一句话从手机上答得进去、
   * 从电话里答不进去**。维护者 09-28 20:1x 的原话是「是把我的文字复制过去发送」,
   * 两条路本来就是同一句话的两个入口。现在三条入口都走 `sessionAnswer.answer`:
   * 面板认准了就写面板,写不进就**原样送进这条对话、按发送**。
   */
  it('★电话里说的那一句不在选项里:与手机上同一条路 —— 原样送进这条对话、按发送', async () => {
    const t = await serve()
    const res = await t.call('/asks/voice', { body: { item_id: ITEM, said: HERS } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, kind: 'session', custom: HERS })
    // 面板那一路对 Claude 关着(`WRITE_ASK_PACKAGES`):一个字都没往面板里写。
    expect(t.wrote()).toEqual([])
    // 她那句原文**一字不改**送进了这条对话。
    expect(t.sent()).toMatchObject([{ op: 'send_text', text: HERS, submit: true }])
  })

  it('★门照旧:只认她本人 + 只在本机或已配对的手机上', async () => {
    const t = await serve()
    expect((await t.call('/asks/answer', { body: { key: KEY, text: HERS }, from: PHONE })).status).toBe(403)
    const res = await t.call('/asks/answer', { body: { key: KEY, text: HERS }, asProgram: true })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toContain('只有你本人能答')
    expect(t.wrote()).toEqual([])
    expect(t.sent()).toEqual([])
  })
})

/**
 * ★ **卡 AT 那条面板的路钉在认准了的那个包上**(豆包办公 `com.work.pc.doubao`;
 * 2026-09-28 Air 维护包真机:写进去、面板收了、正文里有她那句)。
 *
 * 这一节不起 http:服务(`sessionJobs`)+ 真引擎 + 真窗口适配器就够钉住卡 AT 那五条口径。
 * 适配器那一层自己的那几条(壳回 `{ok:false}` / reject、没窗口再写一回)在
 * `tests/engine-window-press.test.ts`。
 */
describe('她自己那句话写进它那个提问面板(卡 AT,豆包办公)', () => {
  const DOUBAO = 'com.work.pc.doubao'
  const ASK: NonNullable<SessionView['ask']> = {
    kind: 'choose',
    question: '你最喜欢哪种菜系?',
    options: [{ label: '川菜' }, { label: '粤菜' }, { label: '湘菜' }],
    since: NOW.toISOString(),
    quote: '你最喜欢哪种菜系?1. 川菜 2. 粤菜 3. 湘菜',
    by: 'form',
  }
  const asking: SessionView = {
    agent: 'doubao' as SessionView['agent'],
    session_id: 'window:825f1900',
    project: '豆包办公',
    title: '周报',
    status: 'waiting',
    elapsed_sec: 30,
    unread: false,
    updated_at: NOW.toISOString(),
    ask: ASK,
  }

  /** `panel` = 壳这一下回什么(缺席 = 两条都成立:面板没了 + 对话区里出现了她那句)。 */
  async function rig(panel?: Record<string, unknown>, over: EngineHarnessOptions = {}) {
    const h = engineHarness({
      nameOf: () => '豆包办公',
      now: () => NOW,
      // 这台电脑上装着的是办公版那个包(挑包由 `agentSources.pickFamilyPackage` 一处说了算)。
      installed: () => [{ bundle_id: DOUBAO, name: '豆包工作', running: true }],
      reply: (req) => {
        if (req.op === 'agent_write_ask') return panel ?? { found: true, wrote: true, submitted: true, gone: true, echoed: true, how: 'paste' }
        if (req.op === 'read_reply') return { found: false, busy: false, texts: [] }
        if (req.op === 'send_text') return { submitted: true, method: 'ax' }
        return {}
      },
      ...over,
    })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [asking],
      bundleOf: () => DOUBAO,
      agentName: () => '豆包办公',
    })
    await h.registry.targets()
    return {
      ...h,
      service,
      wrote: () => h.requests.filter(one => one.op === 'agent_write_ask') as (HelperRequest & { text: string, marks: readonly string[], bundle_id: string })[],
    }
  }

  it('★弹框那一问:界面上 press 与 write 两格都摆得出(判据只有 capabilities() 那一份)', async () => {
    const t = await rig()
    expect(t.service.replyOf(asking, { kind: 'choose', by: 'form', since: ASK.since })).toMatchObject({ press: true, write: true })
  })

  it('★她打的那一句:原文一字不改交给壳,认面板那几截原话一并带上', async () => {
    const t = await rig()
    expect(await t.service.writeAsk('doubao', 'window:825f1900', HERS)).toEqual({ ok: true, text: HERS, confirmed: true })
    expect(t.wrote()).toHaveLength(1)
    expect(t.wrote()[0]?.bundle_id).toBe(DOUBAO)
    // **一字不改**(不清洗、不补话、不截断)
    expect(t.wrote()[0]?.text).toBe(HERS)
    // 认那个面板靠它明写的那几项 + 它那一句原话
    expect(t.wrote()[0]?.marks).toContain('川菜')
    expect(t.wrote()[0]?.marks).toContain('湘菜')
    expect((t.wrote()[0]?.marks ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('★她在「等你」那一格里打字:也走面板这条路(answer 自己分岔)', async () => {
    const t = await rig()
    expect(await t.service.answer('doubao', 'window:825f1900', HERS)).toEqual({ ok: true, route: 'window', confirmed: true })
    expect(t.wrote()).toHaveLength(1)
    // 面板这条路通了就不往对话里再发一句(发了就是答两遍)
    expect(t.requests.some(one => one.op === 'send_text')).toBe(false)
  })

  it('★那个面板还在(gone:false)→ 如实说「没看到它收下」,不谎报答上了', async () => {
    const t = await rig({ found: true, wrote: true, submitted: true, gone: false, echoed: true })
    const got = await t.service.writeAsk('doubao', 'window:825f1900', HERS)
    expect(got).toMatchObject({ ok: true, text: HERS, confirmed: false })
    if (!got.ok) return
    expect(String(got.note)).toContain('没看到它收下')
    expect(String(got.note)).toContain(HERS)
  })

  it('★对话区里没出现她那句(echoed:false)→ 同样不算答上了', async () => {
    const t = await rig({ found: true, wrote: true, submitted: true, gone: true, echoed: false })
    const got = await t.service.writeAsk('doubao', 'window:825f1900', HERS)
    expect(got).toMatchObject({ ok: true, confirmed: false })
    if (!got.ok) return
    expect(String(got.note)).toContain('没看到它收下')
  })

  it('★字写进去了、没按下发送 → 不许说成写进去了就完了', async () => {
    const t = await rig({ found: true, wrote: true, submitted: false })
    const got = await t.service.writeAsk('doubao', 'window:825f1900', HERS)
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk', reveal: true })
    if (got.ok || got.status !== 200) return
    expect(got.why).toContain('没按下发送')
  })

  it('★壳认不出那个面板(两处都像 / 找不着)→ 200 + 去哪儿答那一句,绝不说成写进去了', async () => {
    const t = await rig({ found: false, note: '它窗口里没找着那个能打字的提问面板(那个框可能已经不在了)' })
    const got = await t.service.writeAsk('doubao', 'window:825f1900', HERS)
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk' })
    if (got.ok || got.status !== 200) return
    expect(got.why).toContain('没找着那个能打字的提问面板')
  })

  it('★旧壳不会往那个框里写字 → 照旧那句「到电脑上点」,一个字都不写', async () => {
    const t = await rig(undefined, { caps: ['read_reply', 'agent_press'] })
    const got = await t.service.writeAsk('doubao', 'window:825f1900', HERS)
    expect(got).toMatchObject({ ok: false, status: 200, where: 'desk' })
    if (got.ok || got.status !== 200) return
    expect(got.why).toContain('它那边弹了个框等你点')
    expect(t.wrote()).toEqual([])
  })

  it('★豆包别的包(App Store 版)也按这一家写(2026-10-12 维护者:一律按豆包处理;与界面那一格同一处判据)', async () => {
    const t = await rig(undefined, { installed: () => [{ bundle_id: 'com.bot.neotix.doubao', name: '豆包', running: true }] })
    expect(t.service.replyOf(asking, { kind: 'choose', by: 'form', since: ASK.since }).write).toBe(true)
  })

  it('要写进去的话是空的 → 400;这一问已经不在了 → 409;没有这条会话 → 404', async () => {
    const t = await rig()
    expect(await t.service.writeAsk('doubao', 'window:825f1900', '   ')).toMatchObject({ ok: false, status: 400 })
    expect(await t.service.writeAsk('doubao', '没这条', HERS)).toMatchObject({ ok: false, status: 404 })
    expect(t.wrote()).toEqual([])
  })
})

describe('认那个面板用哪几截原话(askPanelMarksOf)', () => {
  const ask = {
    kind: 'choose' as const,
    question: '你最喜欢哪种菜系?',
    options: [{ label: '川菜' }, { label: '粤菜' }],
    since: NOW.toISOString(),
    quote: '你最喜欢哪种菜系?1. 川菜 2. 粤菜',
    by: 'form' as const,
  }
  it('选项原话 + 它那一句 + 洗过的那句问题,按这个顺序', () => {
    expect(askPanelMarksOf(ask)).toEqual(['川菜', '粤菜', '你最喜欢哪种菜系?1. 川菜 2. 粤菜', '你最喜欢哪种菜系?'])
  })
  it('一样的只留一截(问句与它那一句撞上时)', () => {
    expect(askPanelMarksOf({ ...ask, quote: '你最喜欢哪种菜系?' })).toEqual(['川菜', '粤菜', '你最喜欢哪种菜系?'])
  })
  it('没有选项也给得出(它那一句就够壳认面板)', () => {
    const { options: _options, ...noOptions } = ask
    expect(askPanelMarksOf(noOptions)).toEqual(['你最喜欢哪种菜系?1. 川菜 2. 粤菜', '你最喜欢哪种菜系?'])
  })
  it('★这一问不在了 → 一截都没有(壳那边据此一处都不动)', () => {
    expect(askPanelMarksOf(undefined)).toEqual([])
  })
  it('最多八截(壳那一侧每截都要在几千个节点上比一遍)', () => {
    const many = { ...ask, options: Array.from({ length: 12 }, (_, i) => ({ label: `第 ${i} 项` })) }
    expect(askPanelMarksOf(many)).toHaveLength(8)
  })
})
