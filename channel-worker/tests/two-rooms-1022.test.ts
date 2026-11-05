/**
 * 两间房各一条工人,工人这一侧(2026-10-22,局域网主路 M6;docs/设计-局域网主路-2026-10-21.md 第三节「工人的那一份」)。
 *
 *   - 8791 在进程环境里告诉工人是哪条路线(`WORKBENCH_CHANNEL_WORKER_ROUTE`),取票时点名那一条;
 *   - 每拍按**自己那间房**领(`/call/claim {room}`):同一通两间房都领到、都响;房里没设备就不领(不发请求);
 *   - 接起之前先问 8791 谁先接(`/call/answered`):先接的出声;后到的不出声,房里广播 `ring_end{canceled}` 收铃;
 *   - 另一间房下一拍从 `answered_elsewhere` 知道「在别处接了」,收掉自己的铃、回一句(台账不多一条);
 *   - 回话都带房间;在线设备、「在不在通话」都带路线,8791 两条分开记。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createRingMachine, type RingCall } from '../src/callOut.ts'
import { postCallState } from '../src/callStateReport.ts'
import {
  ANSWERED_ELSEWHERE_ERROR,
  ANSWERED_ELSEWHERE_TEXT,
  WORKER_ROUTE_ENV,
  ackOf,
  answerFirst,
  claimRoomTick,
  workerRouteOf,
} from '../src/twoRooms.ts'
import type { AnsweredVerdict, RoomClaim } from '../src/workbench.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

const LAN_ROOM = 'wb-local-3f9c0a1b'
const CLOUD_ROOM = 'wb-acc0123456789abc'

function raw(patch: Partial<RingCall> = {}): Record<string, unknown> {
  return { id: 'call-1', reason: 'confirm', item_id: 'task-1', title: '看合同', at: '2026-10-22T06:00:00.000Z', silent: false, ...patch }
}

describe('路线从进程环境来', () => {
  it('lan / relay 认;别的、空的当没说(老 8791 不给 = 照老规矩取票)', () => {
    expect(workerRouteOf({ [WORKER_ROUTE_ENV]: 'lan' })).toBe('lan')
    expect(workerRouteOf({ [WORKER_ROUTE_ENV]: ' relay ' })).toBe('relay')
    expect(workerRouteOf({ [WORKER_ROUTE_ENV]: 'cloud' })).toBeUndefined()
    expect(workerRouteOf({})).toBeUndefined()
  })

  it('与 8791 那一头是同一个名字(channelWorkerFleet.ts 是这条接缝的主人)', () => {
    const source = readFileSync(new URL('../../workbench-plugin/src/server/channelWorkerFleet.ts', import.meta.url), 'utf8')
    expect(source).toContain(`export const CHANNEL_WORKER_ROUTE_ENV = '${WORKER_ROUTE_ENV}'`)
  })

  it('main.ts 把它交给取票那一层', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(source).toContain('workerRouteOf(process.env)')
    expect(source).toMatch(/workerRoute\b/)
  })
})

/** 一台工人的振铃机 + 它往房里发的那几条。 */
function worker(room: string) {
  const sent: Record<string, unknown>[] = []
  const answered: string[] = []
  const settled: string[] = []
  const elsewhere: string[] = []
  const ring = createRingMachine({
    send: line => sent.push(JSON.parse(line) as Record<string, unknown>),
    onAnswered: one => answered.push(one.id),
    onSettled: (one, outcome) => settled.push(`${one.id}:${outcome}`),
    onAnsweredElsewhere: one => elsewhere.push(one.id),
    setTimer: () => ({ cancel: () => {} }),
  })
  return { room, ring, sent, answered, settled, elsewhere }
}

describe('振铃机:在别处接起了', () => {
  it('正响着的那一通:房里广播 ring_end{canceled}(手机与听筒收到就收铃),不按「没接」记', () => {
    const w = worker(LAN_ROOM)
    w.ring.ring({ ...(raw() as unknown as RingCall) })
    expect(w.ring.answeredElsewhere('call-1')).toBe(true)
    expect(w.sent.at(-1)).toEqual({ type: 'ring_end', call_id: 'call-1', outcome: 'canceled', text: ANSWERED_ELSEWHERE_TEXT })
    expect(w.elsewhere).toEqual(['call-1'])
    expect(w.settled).toEqual([])
    expect(w.ring.current()).toBeUndefined()
  })

  it('排着的下一通这就响', () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    w.ring.ring(raw({ id: 'call-2', title: '回王总' }) as unknown as RingCall)
    w.ring.answeredElsewhere('call-1')
    expect(w.ring.current()?.id).toBe('call-2')
  })

  it('还排着没响的那一通:悄悄撤掉,不往房里发', () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    w.ring.ring(raw({ id: 'call-2' }) as unknown as RingCall)
    const before = w.sent.length
    expect(w.ring.answeredElsewhere('call-2')).toBe(true)
    expect(w.sent.length).toBe(before)
    expect(w.elsewhere).toEqual(['call-2'])
    w.ring.answeredElsewhere('call-1')
    expect(w.ring.current()).toBeUndefined()
  })

  it('这边已经接起来的、或者压根不认识的:不动', () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    w.ring.answer('call-1')
    expect(w.ring.answeredElsewhere('call-1')).toBe(false)
    expect(w.ring.answered()?.id).toBe('call-1')
    expect(w.ring.answeredElsewhere('nope')).toBe(false)
  })
})

describe('每拍按自己那间房领', () => {
  it('房里没设备:一个请求都不发(空着的那间房那条工人不空转)', async () => {
    const w = worker(CLOUD_ROOM)
    const asked: string[] = []
    await claimRoomTick({ room: w.room, devicePresent: () => false, claim: async (room) => { asked.push(room); return { calls: [raw()], answered_elsewhere: [] } }, ring: w.ring, ack: () => {}, log: () => {} })
    expect(asked).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('有设备:按自己那间房领,领到的响;读不懂的、提议类的不响', async () => {
    const w = worker(LAN_ROOM)
    const asked: string[] = []
    const claim = async (room: string): Promise<RoomClaim> => {
      asked.push(room)
      return { calls: [raw(), { nope: true }, raw({ id: 'call-9', reason: 'confirm', title: '要你批:这张派给 Codex 开工?' })], answered_elsewhere: [] }
    }
    await claimRoomTick({ room: w.room, devicePresent: () => true, claim, ring: w.ring, ack: () => {}, log: () => {} })
    expect(asked).toEqual([LAN_ROOM])
    expect(w.sent.filter(one => one.type === 'ring').map(one => one.call_id)).toEqual(['call-1'])
  })

  it('answered_elsewhere:收掉自己的铃;这条工人不认识的那几通(重起过)直接回一句,8791 不再提', async () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    const acked: string[] = []
    await claimRoomTick({
      room: w.room,
      devicePresent: () => true,
      claim: async () => ({ calls: [], answered_elsewhere: [{ id: 'call-1', room: CLOUD_ROOM }, { id: 'call-old', room: CLOUD_ROOM }] }),
      ring: w.ring,
      ack: id => acked.push(id),
      log: () => {},
    })
    expect(w.elsewhere).toEqual(['call-1'])
    expect(acked).toEqual(['call-old'])
    expect(w.ring.current()).toBeUndefined()
  })
})

describe('接起之前先问谁先接', () => {
  function ask(verdict: AnsweredVerdict) {
    const seen: { id: string, room: string, device_id?: string }[] = []
    return { seen, callAnswered: async (input: { id: string, room: string, device_id?: string }) => { seen.push(input); return verdict } }
  }

  it('这边先接:放行,报上房间与是哪台设备', async () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    const a = ask({ first: true, room: LAN_ROOM })
    expect(await answerFirst({ room: w.room, callAnswered: a.callAnswered, ring: w.ring, log: () => {} }, { callId: 'call-1', deviceId: 'h1' })).toEqual({ ok: true })
    expect(a.seen).toEqual([{ id: 'call-1', room: LAN_ROOM, device_id: 'h1' }])
  })

  it('别的房间先接了:不出声,这间房收铃;回一句人话给按「接起」的那台', async () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    const a = ask({ first: false, room: CLOUD_ROOM, device_id: 'd1' })
    expect(await answerFirst({ room: w.room, callAnswered: a.callAnswered, ring: w.ring, log: () => {} }, { callId: 'call-1' })).toEqual({ ok: false, error: ANSWERED_ELSEWHERE_ERROR })
    expect(w.sent.at(-1)).toMatchObject({ type: 'ring_end', outcome: 'canceled' })
    expect(w.answered).toEqual([])
  })

  it('问不到 8791:当这边先接(不为一个问不到的答案把她的电话挂掉)', async () => {
    const w = worker(LAN_ROOM)
    w.ring.ring(raw() as unknown as RingCall)
    const a = ask({ first: true, unknown: true })
    expect(await answerFirst({ room: w.room, callAnswered: a.callAnswered, ring: w.ring, log: () => {} }, { callId: 'call-1' })).toEqual({ ok: true })
  })

  it('这边压根没在响这一通:不去问(那句错由振铃机自己说)', async () => {
    const w = worker(LAN_ROOM)
    const a = ask({ first: true })
    expect(await answerFirst({ room: w.room, callAnswered: a.callAnswered, ring: w.ring, log: () => {} }, { callId: 'call-1' })).toEqual({ ok: true })
    expect(a.seen).toEqual([])
  })
})

describe('回 8791 的那一句都带房间', () => {
  const call = raw() as unknown as RingCall
  it('接了 / 没接 / 只通知照原样;取消记技术失败;在别处接了记「接了」(台账已经是接了,只记这间房回过话)', () => {
    expect(ackOf(call, 'answered', undefined, LAN_ROOM)).toEqual({ id: 'call-1', result: 'answered', room: LAN_ROOM })
    expect(ackOf(call, 'missed', '响了 60 秒没人接', LAN_ROOM)).toEqual({ id: 'call-1', result: 'missed', error: '响了 60 秒没人接', room: LAN_ROOM })
    expect(ackOf(call, 'notified', '只发了通知,没有响铃', LAN_ROOM)).toEqual({ id: 'call-1', result: 'notified', error: '只发了通知,没有响铃', room: LAN_ROOM })
    expect(ackOf(call, 'canceled', '和房间断开了', LAN_ROOM)).toEqual({ id: 'call-1', result: 'failed', error: '和房间断开了', fail_kind: 'tech', room: LAN_ROOM })
    expect(ackOf(call, 'elsewhere', undefined, LAN_ROOM)).toEqual({ id: 'call-1', result: 'answered', room: LAN_ROOM })
  })
})

describe('agent.ts 接的是这几件', () => {
  const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')
  it('领电话走 claimRoomTick(按 ticket.room),接起先走 answerFirst,收场走 ackOf', () => {
    expect(source).toContain('claimRoomTick({')
    expect(source).toContain('room: ticket.room')
    expect(source).toMatch(/answerFirst\(\s*\{ room: ticket\.room/)
    expect(source).toContain('ackOf(')
    expect(source).not.toContain('deps.workbench.claimCalls()')
  })
})

/**
 * 假 8791:只做「按房间领 + 先接先得 + 带房间回话」那几条规矩(真的那份在 workbench-plugin 的 callOut.ts,
 * 经 8791 的那一遍在 workbench-plugin/tests/server-channel-two-workers-http-1022.test.ts)。
 */
function fakeLedger() {
  const entry = { id: 'call-1', state: 'queued' as string, rooms: [] as string[], done: [] as string[], answered_room: undefined as string | undefined }
  const acks: string[] = []
  return {
    entry,
    acks,
    async claim(room: string): Promise<RoomClaim> {
      if (entry.state === 'queued') { entry.state = 'ringing'; entry.rooms.push(room); return { calls: [raw()], answered_elsewhere: [] } }
      if (entry.state === 'ringing' && !entry.rooms.includes(room)) { entry.rooms.push(room); return { calls: [raw()], answered_elsewhere: [] } }
      if (entry.state === 'answered' && entry.answered_room !== room && entry.rooms.includes(room) && !entry.done.includes(room)) {
        return { calls: [], answered_elsewhere: [{ id: entry.id, room: entry.answered_room as string }] }
      }
      return { calls: [], answered_elsewhere: [] }
    },
    async answered(input: { id: string, room: string }): Promise<AnsweredVerdict> {
      await Promise.resolve()
      if (entry.answered_room !== undefined) return { first: entry.answered_room === input.room, room: entry.answered_room }
      entry.state = 'answered'
      entry.answered_room = input.room
      return { first: true, room: input.room }
    },
    ack(input: { id: string, result: string, room?: string }) {
      acks.push(`${input.room}:${input.result}`)
      if (input.room !== undefined && !entry.done.includes(input.room)) entry.done.push(input.room)
    },
  }
}

describe('两条工人一通电话(假 8791)', () => {
  async function tick(w: ReturnType<typeof worker>, ledger: ReturnType<typeof fakeLedger>) {
    await claimRoomTick({ room: w.room, devicePresent: () => true, claim: room => ledger.claim(room), ring: w.ring, ack: id => ledger.ack({ id, result: 'answered', room: w.room }), log: () => {} })
  }
  function wire(room: string, ledger: ReturnType<typeof fakeLedger>) {
    const sent: Record<string, unknown>[] = []
    const answered: string[] = []
    const ring = createRingMachine({
      send: line => sent.push(JSON.parse(line) as Record<string, unknown>),
      onAnswered: one => answered.push(one.id),
      onSettled: (one, outcome, text) => ledger.ack(ackOf(one, outcome, text, room)),
      onAnsweredElsewhere: one => ledger.ack(ackOf(one, 'elsewhere', undefined, room)),
      setTimer: () => ({ cancel: () => {} }),
    })
    return { room, ring, sent, answered, settled: [] as string[], elsewhere: [] as string[] }
  }
  async function pickUp(w: ReturnType<typeof wire>, ledger: ReturnType<typeof fakeLedger>, deviceId: string) {
    const verdict = await answerFirst({ room: w.room, callAnswered: input => ledger.answered(input), ring: w.ring, log: () => {} }, { callId: 'call-1', deviceId })
    return verdict.ok ? w.ring.answer('call-1') : verdict
  }

  it('两间房都响;出门的手机(云房间)先接 → 只有云房间那条出声;本机房间下一拍收铃;台账两间房各回一句「接了」', async () => {
    const ledger = fakeLedger()
    const lan = wire(LAN_ROOM, ledger)
    const cloud = wire(CLOUD_ROOM, ledger)
    await tick(lan, ledger)
    await tick(cloud, ledger)
    expect(lan.sent.filter(one => one.type === 'ring')).toHaveLength(1)
    expect(cloud.sent.filter(one => one.type === 'ring')).toHaveLength(1)
    expect(await pickUp(cloud, ledger, 'd1')).toEqual({ ok: true })
    expect(cloud.answered).toEqual(['call-1'])
    await tick(lan, ledger)
    expect(lan.sent.at(-1)).toMatchObject({ type: 'ring_end', call_id: 'call-1', outcome: 'canceled', text: ANSWERED_ELSEWHERE_TEXT })
    expect(lan.answered).toEqual([])
    expect(ledger.entry).toMatchObject({ state: 'answered', answered_room: CLOUD_ROOM })
    expect(ledger.acks).toEqual([`${CLOUD_ROOM}:answered`, `${LAN_ROOM}:answered`])
    await tick(lan, ledger)
    expect(ledger.acks).toHaveLength(2)
  })

  it('两边几乎同时按「接起」:只有一边出声,另一边收铃并回一句人话', async () => {
    const ledger = fakeLedger()
    const lan = wire(LAN_ROOM, ledger)
    const cloud = wire(CLOUD_ROOM, ledger)
    await tick(lan, ledger)
    await tick(cloud, ledger)
    const [a, b] = await Promise.all([pickUp(lan, ledger, 'h1'), pickUp(cloud, ledger, 'd1')])
    expect([a, b].filter(one => one.ok)).toHaveLength(1)
    expect([...lan.answered, ...cloud.answered]).toEqual(['call-1'])
    const loser = a.ok ? cloud : lan
    expect(loser.sent.at(-1)).toMatchObject({ type: 'ring_end', outcome: 'canceled' })
    expect(ledger.acks).toHaveLength(2)
  })
})

describe('在线设备与「在不在通话」带路线', () => {
  it('reportDevices:取过票之后带上自己那条路线', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (typeof init?.body === 'string') bodies.push({ path, body: JSON.parse(init.body) })
      const body = path === '/channel/token'
        ? { url: 'wss://lk.example.cn', room: CLOUD_ROOM, identity: 'wb-channel-worker', token: 'jwt', expires_at: 1, route: 'relay' }
        : { ok: true }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl, workerRoute: 'relay' })
    await client.ticket()
    await client.reportDevices([{ identity: 'wb-phone-d1', kind: 'phone' }])
    expect(bodies.at(-1)).toEqual({ path: '/channel/devices', body: { devices: [{ identity: 'wb-phone-d1', kind: 'phone' }], route: 'relay' } })
  })

  it('postCallState:带上路线;没路线就照旧只有 in_call', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await postCallState('http://127.0.0.1:8791', fetchImpl, () => 'lan')(true)
    await postCallState('http://127.0.0.1:8791', fetchImpl)(false)
    expect(bodies).toEqual([{ in_call: true, route: 'lan' }, { in_call: false }])
  })
})
