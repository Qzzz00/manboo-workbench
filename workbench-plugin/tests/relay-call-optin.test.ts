// @vitest-environment node
/**
 * **捎话回电改成「勾了才打」**(2026-10-04,卡 `claude/relay-call-optin`
 * + 同日卡 `claude/relay-nocall-noread` 把「不勾」收到底)。
 *
 * 维护者当天经工作台捎来的原话:
 *
 * > 「现在每次我在手机里给你发信息,你回信息他就给我打电话……不是每次都要的,
 * > 能不能给个勾选,勾了才需要盯和打电话」
 *
 * 当天追的那一句(那张卡留的待拍板 ②「不勾的时候要不要干脆别读那扇窗」):
 *
 * > 「可以不读」
 *
 * 于是**不勾 = 不登记、不盯、不读**:那一句照旧送进去,回话就留在那条会话里
 * (她在手机「各家对话」里看得到)。勾了的那一路一个字没改。
 *
 * 这一份钉四件:
 * ① **开关在发出那一刻**(`POST /sessions/relay {call_on_reply}`),缺省**不勾**;
 * ② **不勾**:轻账上**一条都不记** → 没有巡检、没有读窗、没有通知、没有电话;
 *    回包说的是实话({@link RELAY_PROMISE_NOWATCH}),不许再许「回了我告诉你」;
 * ③ **勾了**:一个字没改 —— 盯着、读到回话就真响一通(`silent:false`);
 * ④ **老手机包没有这一格** = 按不勾(她嫌烦的正是盯)。
 *
 * 「等太久也说一声」那条 09-27 的纪律**只对勾了的生效**了 —— 不勾的既然不盯,也就没有那一条。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCallOutService } from '../src/server/callOut.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import {
  RELAY_PROMISE_CALL,
  RELAY_PROMISE_NOWATCH,
  RELAY_PROMISE_NOWATCH_UNSURE,
  createRelayWatchService,
  relayWatchOnDrain,
  type RelayReader,
} from '../src/server/relayWatch.ts'
import { relayIntoNewConversation } from '../src/server/relayNewConversation.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { sessionAgentName } from '../src/waiting.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-relay-optin-'))
  dirs.push(dir)
  return dir
}

/** 白天十点(不在缺省静默时段 23:00–08:00 里)—— 「响不响」只剩静默时段那一条说话。 */
const T0 = Date.parse('2026-10-04T10:00:00')

/** 假的窗口:第一拍就读到回话,之后一直回同一段(连着两次一样才算它说完了)。 */
function reader(text = '选题定了,三条都在文档里'): RelayReader & { reads: number } {
  const fake = {
    reads: 0,
    async read() { fake.reads += 1; return { found: true, busy: false, text } },
  }
  return fake
}

/** 真轻账 + 真座机台账(响不响是台账上那一格,不是这一层自己说的)。 */
async function rig(options: { now?: number } = {}) {
  const dir = tempDir()
  const at = options.now ?? T0
  const callOut = createCallOutService({ file: join(dir, 'call-out.json'), now: () => at })
  await callOut.load()
  const read = reader()
  const service = createRelayWatchService({
    file: join(dir, 'relay.json'),
    reader: read,
    callOut: { request: input => callOut.request(input) },
    agentName: () => 'Claude',
    now: () => at,
    newId: () => 'r-1a2b3c',
    pollMs: 0,
  })
  await service.load()
  await service.remember({
    agent: 'claude',
    session_id: 'd9991aac',
    title: '统筹交接',
    mark: '事务官捎话 d9991a',
    from: 'phone',
  })
  // 两拍:连着两次读回来一字不差才算它说完了。
  await service.pump()
  await service.pump()
  return { callOut, service, read }
}

describe('轻账里有这一条 = 她那一句上勾了(不勾的压根不进来)', () => {
  it('★登记了的那一条:读到回话 —— **真响一通**(09-27 那一套一个字没改)', async () => {
    const { callOut, service } = await rig()
    const entry = callOut.view().entries[0]
    expect(entry?.reason).toBe('relay')
    expect(entry?.silent).toBe(false)
    expect(entry?.silent_reason).toBeUndefined()
    expect(entry?.note).toContain('它的原话:选题定了,三条都在文档里')
    expect(service.list()[0]?.state).toBe('replied')
  })

  it('这会儿是夜里:照旧只发通知,理由记「夜里」(静默时段那条规矩在前)', async () => {
    const { callOut } = await rig({ now: Date.parse('2026-10-04T23:30:00') })
    expect(callOut.view().entries[0]).toMatchObject({ silent: true, silent_reason: 'quiet' })
  })
})

// ───────────────────────── POST /sessions/relay 那一格 ─────────────────────────

const LOOPBACK = '127.0.0.1'
const NOW = new Date('2026-10-04T10:00:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

function fakeMdns(): MdnsAdvertiser {
  let on = false
  return { async start() { on = true }, async stop() { on = false }, active: () => on }
}

/** 一份记事本(真读窗口与真排电话在上面那一组)。 */
function fakeWatch() {
  const remembered: Record<string, unknown>[] = []
  return {
    remembered,
    service: {
      load: async () => {},
      remember: async (input: Record<string, unknown>) => {
        remembered.push(input)
        return { id: 'r-1a2b3c', ...input, at: NOW.toISOString(), state: 'waiting' } as never
      },
      pump: async () => {},
      list: () => [] as never,
    },
  }
}

async function serve(watch: ReturnType<typeof fakeWatch>) {
  const dir = tempDir()
  const service = createWorkbenchService({ now: () => NOW_SEC })
  service.applyEvent({ agent: 'claude', session_id: 'd9991aac', project: 'desktop-workbench', type: 'running', title: '统筹交接', ts: NOW_SEC - 180 })
  const engine = engineHarness({
    connected: () => true,
    installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    hostIdOf: () => 'local_d9991aac',
    nameOf: sessionAgentName,
    openUrl: async () => ({ ok: true }),
    reply: (req: HelperRequest) => {
      if (req.op === 'read_reply') return { found: true, busy: false, texts: [] }
      if (req.op === 'send_text') return { submitted: true, method: 'ax' }
      return {}
    },
  })
  const answer = createSessionJobs({
    engine: engine.engine,
    registry: engine.registry,
    sessions: () => service.getState().sessions,
    entryOf: () => 'claude-desktop',
    hostIdOf: () => 'local_d9991aac',
    agentName: sessionAgentName,
  })
  await engine.registry.targets()
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    sessionAnswer: answer,
    relayWatch: watch.service as never,
    // 「只盯不发」那一路核那一眼走引擎(`engine.read`),没接就只会答「跟踪服务未连接」。
    engine: engine.engine,
    engineRegistry: engine.registry,
    pairing,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => LOOPBACK,
  })
  started.push(server)
  return async (body: unknown) => {
    const res = await fetch(`${server.url}/sessions/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
}

describe('POST /sessions/relay {call_on_reply}', () => {
  const say = { agent: 'claude', session_id: 'd9991aac', text: '这周选题定了吗' }

  it('★不带这一格(老手机包也是这一路)= **一条都不登记**:不盯、不读、没有通知也没有电话', async () => {
    const watch = fakeWatch()
    const call = await serve(watch)
    const res = await call(say)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // 送进去了(她那句话一个字没少),但轻账上**空的** —— 巡检没有这一条可盯。
    expect(watch.remembered).toEqual([])
    expect(res.body.watched).toBe(false)
    expect(String(res.body.note)).not.toContain(RELAY_PROMISE_CALL)
    expect(String(res.body.note)).toContain(RELAY_PROMISE_NOWATCH)
  })

  it('★勾了:登记一条,回包照旧说「它回了我打电话告诉你」', async () => {
    const watch = fakeWatch()
    const call = await serve(watch)
    const res = await call({ ...say, call_on_reply: true })
    expect(res.body.ok).toBe(true)
    expect(res.body.watched).toBe(true)
    expect(watch.remembered).toHaveLength(1)
    expect(watch.remembered[0]).toMatchObject({ agent: 'claude', session_id: 'd9991aac' })
    // 轻账上没有这一格了:**进了这本账就是她要那一通**(不勾的压根不登记)。
    expect(watch.remembered[0]).not.toHaveProperty('call_on_reply')
    expect(String(res.body.note)).toContain(RELAY_PROMISE_CALL)
  })

  it('明着送 false 也是不登记(勾过又取消的那一下)', async () => {
    const watch = fakeWatch()
    const call = await serve(watch)
    const res = await call({ ...say, call_on_reply: false })
    expect(res.body.ok).toBe(true)
    expect(watch.remembered).toEqual([])
    expect(String(res.body.note)).toContain(RELAY_PROMISE_NOWATCH)
  })

  it('★「只盯不发」那一路缺省照旧登记(它本身就是她明说的那一下);明着送 false 才不登记', async () => {
    const watch = fakeWatch()
    const call = await serve(watch)
    const on = await call({ who: 'Claude', text: '这周选题定了吗', watch_only: true })
    expect(on.body.watched).toBe(true)
    expect(watch.remembered).toHaveLength(1)
    const off = await call({ who: 'Claude', text: '这周选题定了吗', watch_only: true, call_on_reply: false })
    expect(off.body.ok).toBe(false)
    expect(off.body.watched).toBe(false)
    expect(watch.remembered).toHaveLength(1)
  })
})

// ───────────────────────── 新开一条 / 解锁重送 两条兄弟路 ─────────────────────────

describe('新开一条:同一格穿到底', () => {
  function run(callOnReply: boolean, status: 'sent' | 'typed' = 'sent') {
    const remembered: Record<string, unknown>[] = []
    return {
      remembered,
      go: async () => await relayIntoNewConversation({
        send: async () => ({
          ok: true,
          dispatch: { hand: 'window', family: 'doubao', status, at: new Date(T0).toISOString(), text: '帮我总结一下这周的选题' },
          bundle_id: 'com.work.pc.doubao',
        }),
        watch: {
          remember: async (input) => {
            remembered.push(input as unknown as Record<string, unknown>)
            return { id: 'r-1', ...input, at: new Date(T0).toISOString(), state: 'waiting' } as never
          },
        },
        newId: () => 'n-1004',
      }, {
        family: 'doubao',
        title: '豆包',
        text: '帮我总结一下这周的选题',
        from: 'call',
        ...(callOnReply ? { callOnReply: true } : {}),
      }),
    }
  }

  it('★她没说「回了打给我」:新开、发出去,**一条回电都不登记**,许的那句是实话', async () => {
    const h = run(false)
    const got = await h.go()
    expect(got.ok).toBe(true)
    expect(got.delivered).toBe('sent')
    expect(got.watched).toBe(false)
    expect(h.remembered).toEqual([])
    expect(got.note).toContain(RELAY_PROMISE_NOWATCH)
    expect(got.note).not.toContain(RELAY_PROMISE_CALL)
  })

  it('没勾、而且按了发送没当场核上:也不登记,照实说去那条会话里看', async () => {
    const h = run(false, 'typed')
    const got = await h.go()
    expect(got.delivered).toBe('unconfirmed')
    expect(got.watched).toBe(false)
    expect(h.remembered).toEqual([])
    expect(got.note).toContain(RELAY_PROMISE_NOWATCH_UNSURE)
  })

  it('★她明说了:照旧登记一条、照旧许那一通电话', async () => {
    const h = run(true)
    const got = await h.go()
    expect(got.watched).toBe(true)
    expect(h.remembered).toHaveLength(1)
    expect(got.note).toContain(RELAY_PROMISE_CALL)
  })
})

describe('锁着屏排队、解锁重送', () => {
  function job(extra: Partial<Job> = {}): Job {
    return {
      id: 'j-1004',
      family: 'claude',
      kind: 'relay',
      target: { kind: 'session', sessionId: 'd9991aac' },
      text: '这周选题定了吗',
      ...extra,
    } as Job
  }

  it('★她当初没勾:解锁重送只把话送进去,**不补登记那一条回电**', () => {
    expect(relayWatchOnDrain(job())).toBe(false)
  })

  it('★她当初勾了(跟着这件活落过一次盘):解锁重送照旧补登记', () => {
    expect(relayWatchOnDrain(job({ callOnReply: true }))).toBe(true)
  })

  it('不是捎话 / 不是点名某条会话的那一种:一律不登记', () => {
    expect(relayWatchOnDrain(job({ kind: 'dispatch', callOnReply: true }))).toBe(false)
    expect(relayWatchOnDrain(job({ target: { kind: 'current' }, callOnReply: true }))).toBe(false)
  })
})
