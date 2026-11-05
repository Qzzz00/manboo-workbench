// @vitest-environment node
/**
 * `POST /sessions/relay`:事务官捎话给**任何一条**会话(2026-09-26,卡 BR)。
 *
 * 维护者 16:41 在电话里要给「正在做统筹交接的那个 Claude 会话窗口」发一句话,事务官答的是
 * 「那条会话不挂在看板事项上,捎不进话去。**它归哪件事**?」—— 他算 bug:「它不能给你发信息」。
 *
 * 真 http + 真 sessionAnswer + **假的壳**(一扇真窗口都不碰)。守:
 * ① 只给 `who`(他点名那一句原话)就能捎:认出那一条 → 真走送话那只手 → 回「捎到了」;
 * ② 几条都对得上 → `where:'pick'` + 候选(界面 / 事务官念给他选),**一个字都没打出去**;
 * ③ 一条都对不上 → `where:'none'`;
 * ④ 捎不到 → `where:'desk'` + 那句原话(哪一步没成);那条会话不在了 → 404;
 * ⑤ 门同 `/sessions/answer`:本机或已配对的手机(带令牌);局域网没开时外面一律 403,开了没带令牌 401。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
// 2026-10-03:「现有几种路都登记回电」那一条照这张表跑(卡「接缝清理」第 3 条)。
import { RELAY_ROUTES } from '../src/server/sessionAnswer.ts'
// 2026-10-04:许的那一句分两套(勾了 = 打电话 / 没勾 = 一条不响的通知),断言照常量。
import { RELAY_PROMISE_CALL } from '../src/server/relayWatch.ts'
// 2026-10-02:服务搬到 `sessionJobs.ts`(后面是一条引擎),六只手删了。
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { SESSION_CLOSED_QUEUED_SAY } from '../src/server/sessionClosed.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const OUTSIDER = '10.0.0.9'
const NOW = new Date('2026-09-26T08:41:00.000Z')
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

/**
 * 捎进去之后那本**轻账**(2026-09-27,卡 CB):记下哪条会话、什么记号、几点、从哪一端问的,
 * 巡检按记号读回话,读到了回个电话给他。这里只要一份记事本 —— 读窗口与排电话另有用例
 * (`tests/relay-watch.test.ts`)。
 */
function fakeWatch(list: readonly Record<string, unknown>[] = [], options: { throws?: boolean } = {}) {
  const remembered: Record<string, unknown>[] = []
  return {
    remembered,
    service: {
      load: async () => {},
      remember: async (input: Record<string, unknown>) => {
        // 落不了盘那一路(2026-09-30 止血 ①):`remember` 抛,调用方必须如实说「回电没登记上」。
        if (options.throws === true) throw new Error('台账落不了盘')
        remembered.push(input)
        return { id: 'r-1a2b3c', ...input, at: NOW.toISOString(), state: 'waiting' } as never
      },
      pump: async () => {},
      list: () => list as never,
    },
  }
}

async function serve(options: { found?: boolean, submitted?: boolean, connected?: boolean, watch?: ReturnType<typeof fakeWatch>, claude?: NonNullable<Parameters<typeof engineHarness>[0]>['claude'], lockQueue?: NonNullable<Parameters<typeof engineHarness>[0]>['lockQueue'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sessions-relay-'))
  dirs.push(dir)
  const service = createWorkbenchService({ now: () => NOW_SEC })
  // 09-26 16:41 这台机器上真有的那几条
  service.applyEvent({ agent: 'claude', session_id: 'd9991aac', project: 'desktop-workbench', type: 'running', title: 'Desktop-workbench 统筹交接', ts: NOW_SEC - 180 })
  service.applyEvent({ agent: 'claude', session_id: 'd4ac442e', project: 'desktop-workbench', type: 'done', title: '坞上小气泡数不对', ts: NOW_SEC - 5400 })
  service.applyEvent({ agent: 'dsh', session_id: 'dsh-1', project: '事务官', type: 'running', ts: NOW_SEC - 100 })
  // 派活起的那条 Codex(`entry:'exec'`)—— 2026-10-20 卡 D 起按 App 线程办(协议 / 深链开到那一段)。
  service.applyEvent({ agent: 'codex', session_id: 'c-exec-1', project: 'desktop-workbench', type: 'running', title: '导出 PDF', ts: NOW_SEC - 200 })

  /** 假的壳:`read_reply` 按参数说认到没认到,`send_text` 一律成功。记下每一个 op。 */
  const opened: string[] = []
  const engine = engineHarness({
    connected: () => options.connected ?? true,
    installed: family => (family === 'claude'
      ? [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }]
      : [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }]),
    hostIdOf: () => 'local_d9991aac',
    nameOf: sessionAgentName,
    openUrl: async (url: string) => { opened.push(url); return { ok: true } },
    reply: (req: HelperRequest) => {
      if (req.op === 'read_reply') return { found: options.found ?? true, busy: false, texts: [] }
      if (req.op === 'send_text') return { submitted: options.submitted ?? true, method: 'ax' }
      return {}
    },
    ...(options.claude === undefined ? {} : { claude: options.claude }),
    ...(options.lockQueue === undefined ? {} : { lockQueue: options.lockQueue }),
  })
  const requests = engine.requests
  const answer = createSessionJobs({
    engine: engine.engine,
    registry: engine.registry,
    sessions: () => service.getState().sessions,
    entryOf: (agent: string) => (agent === 'codex' ? 'exec' : 'claude-desktop'),
    hostIdOf: () => 'local_d9991aac',
    /*
     * ★ 2026-10-02:「去回答」走 `engine.reveal` —— 开深链 / 叫台前都在**窗口适配器**那一层
     * (设计第三节:开窗只在那一层),所以这两样不在服务上了。
     */
    agentName: sessionAgentName,
  })
  // 界面那几格读的是**同步**那一份能力(`knownCaps`):先现查一遍。
  await engine.registry.targets()
  const remote = { address: LOOPBACK }
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    sessionAnswer: answer,
    ...(options.watch === undefined ? {} : { relayWatch: options.watch.service as never }),
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
  const pair = async (): Promise<string> => {
    expect((await call('/lan', { body: { enabled: true } })).status).toBe(200)
    const code = ((await call('/pair/start', { method: 'POST' })).body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: 'Ben 的手机', platform: 'android' }, from: PHONE })
    return claim.body.token as string
  }
  return { call, pair, requests, opened }
}

describe('捎进去之后记一条轻账(卡 CB:它回了要回电话给他)', () => {
  it('★送成了才记:哪条会话、读回话认哪一截、几点、从哪一端问的(09-28 20:5x 前缀拿掉后,记号就是他那句的前 30 个字)', async () => {
    const watch = fakeWatch()
    const t = await serve({ watch })
    const got = await t.call('/sessions/relay', {
      /*
       * ★ 2026-10-04(卡 `claude/relay-call-optin` → `claude/relay-nocall-noread`):这一句带上了
       * `call_on_reply` —— **回电从此是勾了才有**,不勾的那一句**一条都不登记**(不盯、不读),
       * 而这一条用例钉的是「回电那一套」,所以它走的是勾上的那一路。
       * 缺省那一路见 `tests/relay-call-optin.test.ts`。
       */
      body: { who: '正在做统筹交接的那个 Claude', text: '现在进行到什么情况', call_on_reply: true },
    })
    expect(got.body.ok).toBe(true)
    expect(watch.remembered).toEqual([{
      agent: 'claude',
      session_id: 'd9991aac',
      title: 'Desktop-workbench 统筹交接',
      mark: '现在进行到什么情况',
      // 本机(回环)问的就是「电脑上」;手机带令牌来的记「手机上」,通话那只工人自己带 from:'call'。
      from: 'desk',
      // 真送进去的那个包(2026-09-30 止血 ⑤):读回话按它读,不再按家名去查。
      bundle_id: 'com.anthropic.claudefordesktop',
      /*
       * ★ 2026-10-04 下午(卡 `claude/relay-nocall-noread`):轻账上**没有「要不要回电」那一格**了 ——
       * 不勾的那一句压根不登记,所以进了这本账的每一条都是她要那一通。
       */
    }])
    // 接上了这条回程,回话那一句就多一句承诺 —— 而且这句承诺是**真的**(有轻账、有巡检)。
    expect(String(got.body.note)).toContain(RELAY_PROMISE_CALL)
  })

  it('★真捎不到的那几种一个字不记(不然他会等一通永远不来的电话)', async () => {
    // 2026-10-01(卡 AW):窗口里认不出那段对话**不再是捎不到** —— 照发、按证据核、登记回电。
    // 真捎不到剩下的是安全那几种,这里拿「壳没连上」当代表。
    const watch = fakeWatch()
    const t = await serve({ watch, connected: false })
    const got = await t.call('/sessions/relay', {
      body: { who: '正在做统筹交接的那个 Claude', text: '现在进行到什么情况' },
    })
    expect(got.body.ok).toBe(false)
    expect(got.body.where).toBe('desk')
    expect(watch.remembered).toEqual([])
  })

  it('★从哪一端问的:手机带令牌来的记「手机上」,通话那只工人自己说是「电话里」', async () => {
    const watch = fakeWatch()
    const t = await serve({ watch })
    const token = await t.pair()
    await t.call('/sessions/relay', {
      // 两句都勾了(2026-10-04):这一条钉的是「从哪一端问的」那一格,不勾的压根不进这本账。
      body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true },
      token,
      from: PHONE,
    })
    await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', from: 'call', call_on_reply: true } })
    expect(watch.remembered.map(one => one.from)).toEqual(['phone', 'call'])
  })

  it('没接这本轻账的工作台(老版本 / 没接座机):捎话照旧能捎,只是不多说那句承诺', async () => {
    const t = await serve()
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了' } })
    expect(got.body.ok).toBe(true)
    // 卡 WR(2026-09-28):那条会话在跑 —— 回执要说清这句话是**排在它后面**的(它跑完自己看见)。
    expect(got.body.queued).toBe(true)
    expect(got.body.note).toBe('捎到了 —— 你那句话已经送进 Claude 那条会话里了(它这会儿还在跑,这句话排在它后面,它跑完就看得见)。')
  })
})

/**
 * 2026-09-30 止血:已有会话那条捎话路上的四处「说得比做到的多」。
 * 口径同新开会话那条(`relayNewConversation.ts`):**指派 → 投递 → 完成 → 电话**,任一步没成都明说。
 */
describe('已有会话捎话:投递与回电各自说实话(2026-09-30 止血)', () => {
  it('★回执尚未确认:当成「按了发送、没当场核上」—— ok:true、照样登记回电(带 unconfirmed 与真送进去的包)', async () => {
    const watch = fakeWatch()
    const t = await serve({ watch, submitted: false })
    // 勾了那一路(2026-10-04):这一组钉的全是回电那一套,不勾的一条都不登记(见 relay-call-optin)。
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
    expect(got.status).toBe(200)
    expect(got.body.ok).toBe(true)
    expect(got.body.delivered).toBe('unconfirmed')
    expect(got.body.watched).toBe(true)
    expect(String(got.body.note)).toContain('还没在它对话区里看到这句话')
    expect(String(got.body.note)).toContain('先别重发')
    expect(String(got.body.note)).toContain('打电话')
    expect(String(got.body.note)).not.toContain('捎不进去')
    expect(watch.remembered).toEqual([{
      agent: 'claude',
      session_id: 'd9991aac',
      title: 'Desktop-workbench 统筹交接',
      mark: '到哪了',
      from: 'desk',
      bundle_id: 'com.anthropic.claudefordesktop',
      unconfirmed: true,
    }])
  })

  it('★回执尚未确认、回电又登记不上:还是不许说「我盯着」——明说不会自己打电话', async () => {
    const watch = fakeWatch([], { throws: true })
    const t = await serve({ watch, submitted: false })
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
    expect(got.body.ok).toBe(true)
    expect(got.body.delivered).toBe('unconfirmed')
    expect(got.body.watched).toBe(false)
    expect(String(got.body.note)).toContain('回电也没登记上')
    expect(String(got.body.note)).toContain('不会自己打电话')
  })

  it('★送到了、可轻账落不了盘:不许再说「它回了我打电话告诉你」', async () => {
    const watch = fakeWatch([], { throws: true })
    const t = await serve({ watch })
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
    expect(got.body.ok).toBe(true)
    expect(got.body.watched).toBe(false)
    expect(String(got.body.note)).toContain('回电没登记上')
    expect(String(got.body.note)).not.toContain('它回了我打电话告诉你')
  })

  it('★派活起的那条 Codex(exec):按 App 线程办 —— 进引擎、捎得进,回包形状与别的会话一样', async () => {
    /*
     * ★ 2026-10-20(卡 D):从前这一路在门 3 就被拒(「得你自己到那家里说」),引擎一次都没被问到。
     * 探针 55b38005(`docs/交接-1019-codex续线程探针.md`)量过 exec 线程与 App 线程同一份 rollout、同一把写锁:
     * 协议那只手 `thread/resume` 续得上;App 握着时照既有规矩换窗口那只手(深链开到那一段)。
     * 这一份只有窗口那只手 → 走窗口,`/sessions/relay` 的回包形状一个字没变(`route:'window'`、`delivered`、`watched`)。
     */
    const watch = fakeWatch()
    const t = await serve({ watch })
    const got = await t.call('/sessions/relay', { body: { agent: 'codex', session_id: 'c-exec-1', text: '到哪了', call_on_reply: true } })
    expect(got.body).toMatchObject({ ok: true, route: 'window', delivered: 'sent', watched: true })
    expect(watch.remembered).toHaveLength(1)
    expect(t.opened).toContain('codex://threads/c-exec-1')
  })

  it('派活起的那条 Codex(exec)、壳没连上:如实说要她自己去说,一条回电都不登记', async () => {
    // 守的那一条一个字没松:真没送出去的那一路**一条回电都不登记**(登记了就是一通 20 分钟后的假话)。
    const watch = fakeWatch()
    const t = await serve({ watch, connected: false })
    const got = await t.call('/sessions/relay', { body: { agent: 'codex', session_id: 'c-exec-1', text: '到哪了', call_on_reply: true } })
    expect(got.body.ok).toBe(false)
    expect(got.body.where).toBe('desk')
    expect(watch.remembered).toEqual([])
    expect(String(got.body.why)).toContain('Codex')
  })

  /**
   * ★ **现有的每一种路都登记回电**(2026-10-03,卡「接缝清理」第 3 条;决策记录「2026-10-03 早」⑦)。
   *
   * 2026-09-30 止血在这条路上加过一道门 `result.route === 'window'`(命令行那一路没有窗口可读,
   * 登记了就等于安排一通 20 分钟后的假话)。可 `codex exec resume` 那只手 2026-10-02 整只删了,
   * `sessionJobs.relay` 从此只回 `route:'window'` —— 那道门**恒为真**,写不出一条用例走它
   * (交接 1002 第六节 ⑥)。2026-10-03 把门与类型里的 `'cli'` 一起删了,纪律改由这一条钉:
   *
   * **`RELAY_ROUTES` 里每一种路都登记回电**。哪天真接上第二条路(命令行 / 接口),
   * 第一行断言先红 —— 到那时必须明说这一路登不登记回电(读不到回话的那种一条都不许登记)。
   */
  it('★现有的每一种 route 都登记回电(那道恒为真的门删了之后由它钉着)', async () => {
    // 今天只有窗口这一种路产得出来(唯一产出点 `sessionJobs.relay`)。
    expect(RELAY_ROUTES).toEqual(['window'])
    for (const route of RELAY_ROUTES) {
      // ① 核上了那一档。
      const watch = fakeWatch()
      const ok = await (await serve({ watch })).call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
      expect(ok.body).toMatchObject({ ok: true, route, delivered: 'sent', watched: true })
      expect(watch.remembered).toHaveLength(1)
      // ② 按了发送、当场没核上那一档(从前那儿还有同一道门,一起删了)。
      const later = fakeWatch()
      const unsure = await (await serve({ watch: later, submitted: false })).call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
      expect(unsure.body).toMatchObject({ ok: true, route, delivered: 'unconfirmed', watched: true })
      expect(later.remembered).toHaveLength(1)
    }
  })

  it('★送成了的那一条也记下真送进去的包(读回话按它读,不再按家名去查)', async () => {
    const watch = fakeWatch()
    const t = await serve({ watch })
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd9991aac', text: '到哪了', call_on_reply: true } })
    expect(got.body.watched).toBe(true)
    expect(got.body.delivered).toBe('sent')
    expect(watch.remembered[0]).toMatchObject({ bundle_id: 'com.anthropic.claudefordesktop' })
  })
})

describe('POST /sessions/relay:捎话给任何一条会话', () => {
  it('★维护者那一句(只有 who,没有事项、那条会话也没在等他):认出统筹交接那条 → 真送进去 → 回「捎到了」', async () => {
    const t = await serve()
    const got = await t.call('/sessions/relay', {
      body: {
        who: '那个 Claude,现在正在做统筹交接的那个会话窗口',
        text: '现在进行到什么情况,大概什么时候能处理完',
      },
    })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({
      ok: true,
      route: 'window',
      agent: 'claude',
      session_id: 'd9991aac',
      mark: '现在进行到什么情况,大概什么时候能处理完',
    })
    // 卡 WR(2026-09-28):那条会话在跑 —— 回执要说清这句话是**排在它后面**的(它跑完自己看见)。
    expect(got.body.queued).toBe(true)
    expect(got.body.note).toBe('捎到了 —— 你那句话已经送进 Claude 那条会话里了(它这会儿还在跑,这句话排在它后面,它跑完就看得见)。')
    // 深链开到那一段 → 用记号认 → 才打字;进去的只有他的原话(一个字没改,不带前缀)
    expect(t.opened).toEqual(['claude://code/continue?session=local_d9991aac'])
    // 送之前多读一眼她那句在不在对话区里(回执不可靠时拿它补认;2026-09-28 Air 维护包)
    expect(t.requests.map(req => req.op)).toEqual(['read_reply', 'read_reply', 'send_text'])
    expect(t.requests.find(req => req.op === 'send_text')).toMatchObject({
      op: 'send_text',
      bundle_id: 'com.anthropic.claudefordesktop',
      text: '现在进行到什么情况,大概什么时候能处理完',
      submit: true,
    })
  })

  it('★几条都对得上:念给他选,一个字都不打出去', async () => {
    const t = await serve()
    const got = await t.call('/sessions/relay', { body: { who: '给 Claude 发个信息', text: '到哪了' } })
    expect(got.status).toBe(200)
    expect(got.body.ok).toBe(false)
    expect(got.body.where).toBe('pick')
    // 两条都在,每条带念给他听的那一行(「几分钟前」按服务端此刻的钟算,这里不钉那一截)
    const candidates = got.body.candidates as readonly { agent: string, session_id: string, title: string, status: string, line: string }[]
    expect([...candidates].sort((a, b) => a.session_id.localeCompare(b.session_id)).map(one => ({ ...one, line: one.line.replace(/ · .*\)$/u, ')') }))).toEqual([
      // score 是认人打的那个分(2026-09-27,卡 LK 加):只给「同一句话在两份会话池里认两次」比大小用,不念给他听。
      { agent: 'claude', session_id: 'd4ac442e', title: '坞上小气泡数不对', status: 'done', line: 'Claude 「坞上小气泡数不对」(说完了)', score: 15 },
      { agent: 'claude', session_id: 'd9991aac', title: 'Desktop-workbench 统筹交接', status: 'running', line: 'Claude 「Desktop-workbench 统筹交接」(在跑)', score: 15 },
    ])
    expect(String(got.body.note)).toContain('有 2 条都对得上')
    expect(String(got.body.note)).toContain('问他是哪一条')
    expect(t.requests).toEqual([])
  })

  it('★他说了是哪一条之后:带 agent + session_id 直接送(就是 /sessions/answer 那两个字段)', async () => {
    const t = await serve()
    const got = await t.call('/sessions/relay', { body: { agent: 'claude', session_id: 'd4ac442e', text: '这条先放着' } })
    expect(got.body).toMatchObject({ ok: true, agent: 'claude', session_id: 'd4ac442e' })
  })

  it('★一条都对不上:说没认出来,不挑最像的那条', async () => {
    const t = await serve()
    const got = await t.call('/sessions/relay', { body: { who: '给张三那条发个信息', text: '在吗' } })
    expect(got.status).toBe(200)
    expect(got.body.ok).toBe(false)
    expect(got.body.where).toBe('none')
    expect(String(got.body.note)).toContain('没认出')
    expect(t.requests).toEqual([])
  })

  it('★窗口里没认出那段对话 → 照样发,核不上如实说(2026-10-01,卡 AW)', async () => {
    const t = await serve({ found: false })
    const got = await t.call('/sessions/relay', { body: { who: '统筹交接那条', text: '到哪了' } })
    expect(got.status).toBe(200)
    // 按了发送、当场没核上 —— 照新开会话那条路办:回 ok、登记回电、说清别重发
    expect(got.body).toMatchObject({ ok: true, agent: 'claude', session_id: 'd9991aac' })
    expect(String(got.body.note)).toContain('先别重发')
    expect(t.requests.map(req => req.op)).toContain('send_text')
  })

  it('★那条会话不在了 → 404;话是空的 / 谁都没说 → 400', async () => {
    const t = await serve()
    expect((await t.call('/sessions/relay', { body: { agent: 'claude', session_id: '没这条', text: '喂' } })).status).toBe(404)
    expect((await t.call('/sessions/relay', { body: { who: '统筹交接那条', text: '  ' } })).status).toBe(400)
    expect((await t.call('/sessions/relay', { body: { text: '到哪了' } })).status).toBe(400)
  })

  it('门同 /sessions/answer:本机可以;局域网没开时外面一律 403;配对过的手机带令牌才行', async () => {
    const t = await serve()
    const say = { who: '统筹交接那条', text: '到哪了' }
    // 局域网还没开:外面来的一律进不来
    expect((await t.call('/sessions/relay', { body: say, from: PHONE })).status).toBe(403)
    expect((await t.call('/sessions/relay', { body: say, from: OUTSIDER })).status).toBe(403)
    const token = await t.pair()
    // 配对过的那台手机:没带令牌 401,带了就能捎(手机上他也要能给那条会话说一句)
    expect((await t.call('/sessions/relay', { body: say, from: PHONE })).status).toBe(401)
    expect((await t.call('/sessions/relay', { body: say, from: PHONE, token })).body).toMatchObject({ ok: true, session_id: 'd9991aac' })
  })

  it('没接送话那条路的工作台(sessionAnswer 缺席)→ 404,说清这一版不会捎话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-sessions-relay-off-'))
    dirs.push(dir)
    const service = createWorkbenchService({ now: () => NOW_SEC })
    const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)
    const res = await fetch(`${server.url}/sessions/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ who: '统筹交接那条', text: '到哪了' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('往那家会话里捎话的路没接上')
  })

  /*
   * ★ 2026-10-23(卡「捎话到没开着的会话留言等它醒」):协议手回「那条会话没开着」,留言排上队。
   * 回包**形状不变**(ok / route / delivered / watched / agent / session_id / mark / note),只是
   * note 就是那句完整的话(不套「捎到了/送进了」的框)、不登记回电(醒来重送那一下由 drain.after 补)。
   */
  it('★那条会话没开着 → 留言排上队:note 是留言那句、不登记回电、回包形状不变', async () => {
    const watch = fakeWatch()
    const t = await serve({
      watch,
      /*
       * 壳没连上 → 窗口那条通道 `capabilities().send` 是假、排不进队(生产里就是「会话闲了一夜,
       * 窗口也没了」那一种);登记表里**另一条会话开着**(协议手的 `capabilities().send` 才是 true、
       * 排得进候选),要捎的这条不在 → 真 Claude 适配器回「没开着」+ `sessionClosed`;接一本队,引擎才排得进。
       */
      connected: false,
      claude: { sockets: async () => [{ sessionId: 'another-open-one', pid: 21384, socket: '/tmp/cc-socks/another.sock' }], socketReady: async () => true },
      lockQueue: { add: () => true },
    })
    const got = await t.call('/sessions/relay', {
      body: { agent: 'claude', session_id: 'd9991aac', text: '现在到哪了', call_on_reply: true },
    })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({
      ok: true,
      route: 'window',
      delivered: 'kept',
      watched: false,
      agent: 'claude',
      session_id: 'd9991aac',
      mark: '现在到哪了',
      note: SESSION_CLOSED_QUEUED_SAY,
    })
    // 一个字都没往壳里打(引擎这一下就到此为止);回电**不在这儿登记**(醒来重送那一下才补)
    expect(t.requests).toEqual([])
    expect(watch.remembered).toEqual([])
  })
})

describe('GET /sessions/lookup:捎话账上那一条原样带上(2026-09-30 晚,故障 ③)', () => {
  it('★看一眼统筹交接那条:它回了 → 这一句里带上它的原话', async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString()
    const watch = fakeWatch([{ id: 'r-9', agent: 'claude', session_id: 'd9991aac', title: 'x', mark: '到哪了', at, from: 'call', state: 'replied', reply: '交接写完了,在跑测试。' }])
    const t = await serve({ watch })
    const got = await t.call(`/sessions/lookup?who=${encodeURIComponent('统筹交接那个 Claude')}`)
    expect(got.body.ok).toBe(true)
    expect(String(got.body.note)).toContain('它的原话:交接写完了,在跑测试。')
    expect(String(got.body.note)).toContain('5 分钟前')
  })

  it('账上没有这一家的:照旧只说状态那一句', async () => {
    const t = await serve({ watch: fakeWatch() })
    const got = await t.call(`/sessions/lookup?who=${encodeURIComponent('统筹交接那个 Claude')}`)
    expect(got.body.ok).toBe(true)
    expect(String(got.body.note)).not.toContain('让我捎的')
  })
})
