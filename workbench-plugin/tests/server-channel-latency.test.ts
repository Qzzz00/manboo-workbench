// @vitest-environment node
/**
 * 通话延迟那两条(2026-09-23,docs/交接-0923-通话延迟.md):
 *
 *   POST /channel/latency  工人报一回合的计时。**只认回环**。
 *   GET  /channel/latency  最近 20 回合。本机与已配对的设备都能读(体检页读的就是它)。
 *
 * 这一份钉的核心只有一条:**没测到的那一段一路是 `null`,谁都不许把它变成 0**。
 * 每一段多久由工人算(channel-worker/src/latency.ts),8791 一段都不算 —— 它不进房。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import {
  LATENCY_KEEP,
  createChannelLatencyStore,
  latencySummary,
  parseTurnLatency,
} from '../src/server/channelLatency.ts'
import type { TurnLatency } from '../src/server/channelLatency.ts'
import { lanOn } from './helpers/lanOn.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-23T10:30:00Z') / 1000)

/** 工人真会报上来的那一条(形状与 channel-worker/src/latency.ts 的 TurnLatency 一字不差)。 */
function turn(round: number, overrides: Partial<TurnLatency> = {}): TurnLatency {
  return {
    round,
    at: Date.parse('2026-09-23T10:30:00Z') + round * 1000,
    asr_ms: 300,
    commit_ms: 300,
    llm_first_ms: 600,
    llm_gen_ms: 900,
    tts_first_ms: 380,
    publish_ms: 60,
    tts_all_ms: 1640,
    mouth_ms: 500,
    total_ms: 1700,
    ...overrides,
  }
}

describe('parseTurnLatency', () => {
  it('工人报上来的那一条原样认得出来', () => {
    expect(parseTurnLatency(turn(7))).toEqual(turn(7))
  })

  it('★ 没测到的那一段是 null,**不许补 0**', () => {
    const got = parseTurnLatency({ round: 1, at: 1_790_000_000_000 })
    expect(got?.total_ms).toBeNull()
    expect(got?.asr_ms).toBeNull()
    expect(got?.tts_first_ms).toBeNull()
  })

  it('读不懂的值(字符串、NaN、负数)一律落成 null', () => {
    const got = parseTurnLatency({
      round: 1, at: 1_790_000_000_000,
      total_ms: '很快', asr_ms: Number.NaN, commit_ms: -5, publish_ms: null,
    })
    expect(got?.total_ms).toBeNull()
    expect(got?.asr_ms).toBeNull()
    expect(got?.commit_ms).toBeNull()
    expect(got?.publish_ms).toBeNull()
  })

  it('0 毫秒是一个真数,照收(它和「没量到」不是一回事)', () => {
    expect(parseTurnLatency({ round: 1, at: 1_790_000_000_000, publish_ms: 0 })?.publish_ms).toBe(0)
  })

  it('没有 round / at 就整条不收(排不了序、认不出是哪一回合)', () => {
    expect(parseTurnLatency({ at: 1_790_000_000_000 })).toBeUndefined()
    expect(parseTurnLatency({ round: 1 })).toBeUndefined()
    expect(parseTurnLatency({ round: 1, at: 0 })).toBeUndefined()
    expect(parseTurnLatency(null)).toBeUndefined()
    expect(parseTurnLatency([turn(1)])).toBeUndefined()
    expect(parseTurnLatency('1700ms')).toBeUndefined()
  })
})

describe('最近 20 条', () => {
  it('留最近 20 条,最近的在前', () => {
    const store = createChannelLatencyStore()
    for (let i = 1; i <= 25; i += 1) store.add(turn(i))
    const rows = store.recent()
    expect(rows).toHaveLength(LATENCY_KEEP)
    expect(rows[0]?.round).toBe(25)
    expect(rows[LATENCY_KEEP - 1]?.round).toBe(6)
  })

  it('形状不对的不进表(路由据此回 400,不静默丢掉)', () => {
    const store = createChannelLatencyStore()
    expect(store.add({ nope: true })).toBeUndefined()
    expect(store.recent()).toHaveLength(0)
  })
})

describe('念给人听的那一行', () => {
  it('一条都没有时说的是实话,不是 0ms', () => {
    expect(latencySummary([])).toContain('还没有量到过')
  })

  it('★ 没量到就说「没量到」,屏幕上不许出现一个假的 0ms', () => {
    const line = latencySummary([turn(1, { total_ms: null, mouth_ms: null, tts_first_ms: null })])
    expect(line).toContain('停说到出声 没量到')
    expect(line).toContain('首字到出声 没量到')
    expect(line).not.toMatch(/\d+ms/)
  })

  it('量到了就念那三个数', () => {
    const line = latencySummary([turn(1)])
    expect(line).toContain('停说到出声 1700ms')
    expect(line).toContain('首字到出声 500ms')
    expect(line).toContain('合成首句 380ms')
  })
})

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-latency-'))
  dirs.push(dir)
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  let actor: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
  })
  started.push(server)
  pairing.start()
  const claimed = await pairing.claim({
    code: pairing.current()?.code ?? '', device_name: 'Ben 的手机', platform: 'android',
  })
  if (!claimed.ok) throw new Error('测试装置:配对没成')
  const call = async (method: string, path: string, body?: unknown, withToken = false) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(withToken ? { authorization: `Bearer ${claimed.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { call, who: (value: 'local' | 'phone') => { actor = value } }
}

describe('/channel/latency', () => {
  it('工人报一条、谁都读得到,null 一路原样到读的那一头', async () => {
    const { call } = await serve()
    expect((await call('POST', '/channel/latency', { turn: turn(1, { asr_ms: null }) })).status).toBe(200)
    expect((await call('POST', '/channel/latency', { turn: turn(2) })).status).toBe(200)
    const got = await call('GET', '/channel/latency')
    expect(got.status).toBe(200)
    const turns = got.body.turns as TurnLatency[]
    expect(turns.map(row => row.round)).toEqual([2, 1])
    expect(turns[1]?.asr_ms).toBeNull()
    expect(got.body.note).toContain('停说到出声 1700ms')
  })

  it('一条都没报过时读得到一句实话,而不是一张编出来的表', async () => {
    const { call } = await serve()
    const got = await call('GET', '/channel/latency')
    expect(got.status).toBe(200)
    expect(got.body.turns).toEqual([])
    expect(got.body.note).toContain('还没有量到过')
  })

  it('看不懂的一条回 400,不静默丢掉(否则体检页上「没有数」有两种解释)', async () => {
    const { call } = await serve()
    const got = await call('POST', '/channel/latency', { turn: { 快不快: '还行' } })
    expect(got.status).toBe(400)
  })

  it('★ 写只认回环:房里的谁都不能往这张表里塞数', async () => {
    const { call, who } = await serve()
    who('phone')
    expect((await call('POST', '/channel/latency', { turn: turn(1) }, true)).status).toBe(403)
  })

  it('读给已配对的设备(手机上也看得到这一通有多慢),没配对的不给', async () => {
    const { call, who } = await serve()
    await call('POST', '/channel/latency', { turn: turn(1) })
    who('phone')
    expect((await call('GET', '/channel/latency', undefined, true)).status).toBe(200)
    // 不带设备令牌的外来请求在更前面就被挡了(401),连这条路由都走不到。
    expect((await call('GET', '/channel/latency')).status).toBe(401)
  })
})

describe('成绩单上的分流(2026-09-23,回合分流与 Jev 评估)', () => {
  it('★ 垫过的回合带 filler:true 原样留着;别的值不认', () => {
    expect(parseTurnLatency({ ...turn(1), filler: true })).toMatchObject({ filler: true })
    expect(parseTurnLatency({ ...turn(1), filler: 'yes' })).not.toHaveProperty('filler')
    expect(parseTurnLatency(turn(1))).not.toHaveProperty('filler')
  })

  it('工人报上来的 route / router 原样留着', () => {
    const row = parseTurnLatency({ ...turn(1), route: 'chat', router: 'rules' })
    expect(row).toMatchObject({ route: 'chat', router: 'rules' })
  })

  it('老工人没有这两格 —— 照收,不补一个上去', () => {
    const row = parseTurnLatency(turn(1))
    expect(row).not.toHaveProperty('route')
    expect(row).not.toHaveProperty('router')
  })

  it('读不懂的那两格当没有(和「没测到写 null」同一条纪律)', () => {
    const row = parseTurnLatency({ ...turn(1), route: '随便', router: 42 })
    expect(row).not.toHaveProperty('route')
    expect(row).not.toHaveProperty('router')
  })

  it('体检页那一行说得出这一回合是闲聊还是办事', () => {
    const note = latencySummary([parseTurnLatency({ ...turn(1), route: 'chat', router: 'rules' })!])
    expect(note).toContain('闲聊')
    expect(note).toContain('rules')
  })

  it('没判过的那一回合,那一行一个字都不多说', () => {
    expect(latencySummary([parseTurnLatency(turn(1))!])).not.toContain('闲聊')
  })

  it('GET 回去的那一份里带着这两格(统筹在真机上按它分开算平均)', async () => {
    const { call } = await serve()
    await call('POST', '/channel/latency', { turn: { ...turn(1), route: 'act', router: 'jev' } })
    const got = await call('GET', '/channel/latency')
    const turns = got.body.turns as TurnLatency[]
    expect(turns[0]).toMatchObject({ route: 'act', router: 'jev' })
  })
})
