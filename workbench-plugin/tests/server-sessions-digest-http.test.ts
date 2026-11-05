// @vitest-environment node
/**
 * GET /sessions/digest(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
 *
 * 点开一条「某家在跑的会话」:标题、在哪个项目、最近在做什么、最近几轮。守四件事:
 * ① 门与 /butler/item/:id/turns 同一道(回环或已配对的手机);局域网裸请求 401;
 * ② 只认各家接入登记过的会话(按 id 找文件,**不收路径**),认不出 → 404 + 一句人话;
 * ③ 标题与项目以 /state 里那条会话为准(卡片上看到的和点开看到的是同一句);
 * ④ 回的都是人话:没有路径、工具名、英文键名。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionDigestView } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import type { SessionAnswerService } from '../src/server/sessionAnswer.ts'
import { createSessionDigestService } from '../src/server/sessionDigestService.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const NOW_SEC = Math.floor(Date.parse('2026-09-25T07:20:00Z') / 1000)

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
const TRANSCRIPT = [
  line({ type: 'user', sessionId: 'd999', cwd: '/Users/example/Documents/GitHub/desktop-workbench', timestamp: '2026-09-25T07:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '还有多久' } }),
  line({ type: 'assistant', sessionId: 'd999', timestamp: '2026-09-25T07:05:00.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git -C /Users/example/x log --oneline -3', description: 'Show commits' } }] } }),
  line({ type: 'assistant', sessionId: 'd999', timestamp: '2026-09-25T07:16:08.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '先说结论：**大约 16:30 能先用上第一批**，四张卡全部合进去。' }] } }),
].join('\n')

async function serve(options: { withDigest?: boolean, relayReady?: { can: boolean, why?: string } } = {}) {
  const ready = options.relayReady
  const dir = mkdtempSync(join(tmpdir(), 'wb-sessions-digest-'))
  dirs.push(dir)
  const file = join(dir, 'd999.jsonl')
  writeFileSync(file, TRANSCRIPT)
  const service = createWorkbenchService({ now: () => NOW_SEC })
  service.applyEvent({ agent: 'claude', session_id: 'd999', project: '工作台', type: 'running', title: 'Desktop-workbench 统筹交接', ts: NOW_SEC - 600 })
  const digest = createSessionDigestService({ sessions: () => service.getState().sessions, now: () => new Date(NOW_SEC * 1000) })
  digest.note('claude', 'd999', file, 'claude-transcript', 'Desktop-workbench 统筹交接')
  const remote = { address: LOOPBACK }
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(options.withDigest === false ? {} : { sessionDigest: digest }),
    /**
     * 这张卡下面给不给输入框(2026-09-27,卡 PS):digest 里带一格 `relay`,原样来自捎话那道门
     * (`sessionAnswer.relayReady`)。这里只给那一格用得到的那一只桩。
     */
    ...(ready === undefined ? {} : { sessionAnswer: { relayReady: () => ready } as unknown as SessionAnswerService }),
    pairing,
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.86.37.27', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { method?: string, body?: string, token?: string, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async () => {
    expect((await call('/lan', { body: JSON.stringify({ enabled: true }) })).status).toBe(200)
    const startRes = await call('/pair/start', { method: 'POST' })
    const code = (startRes.body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: JSON.stringify({ code, device_name: 'Ben 的 iPhone', platform: 'ios' }), from: PHONE })
    expect(claim.status).toBe(200)
    return claim.body.token as string
  }
  return { call, pair }
}

describe('GET /sessions/digest', () => {
  it('★本机:标题 / 项目以会话表为准,最近在做什么与最近几轮是当场读的人话', async () => {
    const t = await serve()
    const res = await t.call('/sessions/digest?agent=claude&id=d999')
    expect(res.status).toBe(200)
    const view = res.body as unknown as SessionDigestView
    expect(view).toMatchObject({
      agent: 'claude',
      session_id: 'd999',
      title: 'Desktop-workbench 统筹交接',
      project: '工作台',
      status: 'running',
      activity: { line: '先说结论：大约 16:30 能先用上第一批，四张卡全部合进去。', at: '2026-09-25T07:16:08.000Z' },
      // 看提交记录不算「做了什么」(只数改文件、测试、构建、提交这类),这一轮没有 did。
      rounds: [{ ask: '还有多久', reply: '先说结论：大约 16:30 能先用上第一批，四张卡全部合进去。', at: '2026-09-25T07:16:08.000Z' }],
      read_at: '2026-09-25T07:20:00.000Z',
    })
    // 人话:不露路径、工具名、`**`
    expect(JSON.stringify(view)).not.toMatch(/\/Users|Bash|\*\*|git -C/)
  })

  it('★局域网裸请求 401;带设备令牌 200', async () => {
    const t = await serve()
    const token = await t.pair()
    expect((await t.call('/sessions/digest?agent=claude&id=d999', { from: PHONE })).status).toBe(401)
    const ok = await t.call('/sessions/digest?agent=claude&id=d999', { from: PHONE, token })
    expect(ok.status).toBe(200)
    expect(ok.body.title).toBe('Desktop-workbench 统筹交接')
  })

  /**
   * 2026-09-27,卡 PS:手机在这张卡下面直接说一句 —— 给不给输入框由 digest 里这一格说了算。
   * 捎话那条路没接上时**这一格缺席**(界面就不摆输入框,不假装能送)。
   */
  it('★带回「现在能不能往这条会话里捎话」;捎话那条路没接上时这一格缺席', async () => {
    const yes = await serve({ relayReady: { can: true } })
    expect((await yes.call('/sessions/digest?agent=claude&id=d999')).body.relay).toEqual({ can: true })

    const no = await serve({ relayReady: { can: false, why: '这句话得你到电脑上的 Claude 里自己说' } })
    expect((await no.call('/sessions/digest?agent=claude&id=d999')).body.relay)
      .toEqual({ can: false, why: '这句话得你到电脑上的 Claude 里自己说' })

    const off = await serve()
    expect((await off.call('/sessions/digest?agent=claude&id=d999')).body.relay).toBeUndefined()
  })

  it('认不出的会话 404(不收路径);缺参数 400;没接线 404', async () => {
    const t = await serve()
    expect((await t.call('/sessions/digest?agent=claude&id=nope')).status).toBe(404)
    expect((await t.call('/sessions/digest?agent=codex&id=d999')).status).toBe(404)
    // 哪一家按字符串认(自动发现的一家也走这条);没登记过就是 404,不是 400。
    expect((await t.call('/sessions/digest?agent=muse&id=x')).status).toBe(404)
    expect((await t.call('/sessions/digest?agent=claude')).status).toBe(400)
    expect((await t.call('/sessions/digest?agent=../../etc&id=x')).status).toBe(400)
    const off = await serve({ withDigest: false })
    const res = await off.call('/sessions/digest?agent=claude&id=d999')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('会话读取未接线')
  })
})
