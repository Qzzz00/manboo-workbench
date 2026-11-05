// @vitest-environment node
/**
 * 电话按房间领 + 先接先得(2026-10-21,局域网主路 M2;设计稿第三节「工人的那一份」)。
 *
 * 工人总在本机房间;登录了账号、中转配了房间时再进云房间(卡 M6)。响铃要两间房都响(在家的听筒 + 出门的手机),所以:
 *   - `/call/claim {room}`:**同一通两间房都领得到**,每间房只领一次;
 *   - `/call/answered {id, room, device_id}`:谁先接起谁出声,后到的判「已被接」挂断;
 *     另一间房下一次来领时从 `answered_elsewhere` 里知道「这通在别处接了」,收掉自己的铃;
 *   - 一间房说「没接」不算整通没接:两间房都收了场才落「未接」;
 *   - 不带房间领(今天的老工人)照旧,一个字不变。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { createCallOutService, loadCallOutFile } from '../src/server/callOut.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { lanOn } from './helpers/lanOn.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-room-'))
  dirs.push(dir)
  return join(dir, 'call-out.json')
}

const LAN_ROOM = 'wb-local-3f9c0a1b'
const CLOUD_ROOM = 'wb-acc0123456789abc'

/** 白天(缺省免打扰 23:00–08:00 之外),手动点一通「等你确认」。 */
async function oneCall(options: { file?: string, now?: () => number } = {}) {
  let seq = 0
  const settled: string[] = []
  const service = createCallOutService({
    file: options.file ?? tmpFile(),
    newId: () => `call-${++seq}`,
    now: options.now ?? (() => new Date('2026-10-21T14:00:00').getTime()),
    onSettled: entry => settled.push(`${entry.id}:${entry.state}`),
  })
  await service.load()
  const queued = await service.request({ reason: 'confirm', item_id: 't-1', title: '看合同' })
  if (!queued.ok || queued.entry === undefined) throw new Error('测试装置:没排上')
  return { service, id: queued.entry.id, settled }
}

describe('按房间领', () => {
  it('同一通两间房都领得到,每间房只领一次', async () => {
    const { service, id } = await oneCall()
    const lan = await service.claimRoom(LAN_ROOM)
    expect(lan.calls.map(one => one.id)).toEqual([id])
    expect(lan.calls[0]).toMatchObject({ state: 'ringing', rooms: [LAN_ROOM] })
    const cloud = await service.claimRoom(CLOUD_ROOM)
    expect(cloud.calls.map(one => one.id)).toEqual([id])
    expect(service.view().entries[0]?.rooms).toEqual([LAN_ROOM, CLOUD_ROOM])
    expect((await service.claimRoom(LAN_ROOM)).calls).toEqual([])
    expect((await service.claimRoom(CLOUD_ROOM)).calls).toEqual([])
  })

  it('不带房间领(老工人)领走的那一通,不再交给按房间来领的', async () => {
    const { service, id } = await oneCall()
    expect((await service.claim()).map(one => one.id)).toEqual([id])
    expect((await service.claimRoom(LAN_ROOM)).calls).toEqual([])
  })

  it('老路一个字不变:不带房间领、不带房间回话', async () => {
    const { service, id, settled } = await oneCall()
    const [taken] = await service.claim()
    expect(taken).toMatchObject({ id, state: 'ringing' })
    expect(taken?.rooms).toBeUndefined()
    await service.ack({ id, result: 'missed' })
    expect(service.view().entries[0]?.state).toBe('missed')
    expect(settled).toEqual([`${id}:missed`])
  })
})

describe('先接先得', () => {
  it('先报接起的那间房出声;后到的判「已被接」,并说清是哪一间', async () => {
    const { service, id, settled } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.claimRoom(CLOUD_ROOM)
    expect(await service.answered({ id, room: CLOUD_ROOM, device_id: 'phone-1' })).toEqual({ ok: true, first: true, room: CLOUD_ROOM, device_id: 'phone-1' })
    expect(await service.answered({ id, room: LAN_ROOM, device_id: 'handset-1' })).toEqual({ ok: true, first: false, room: CLOUD_ROOM, device_id: 'phone-1' })
    expect(service.view().entries[0]).toMatchObject({ state: 'answered', answered_room: CLOUD_ROOM, answered_device: 'phone-1' })
    // 接起即收场一次(行为账记一笔「接了」),后到的那一问不再记。
    expect(settled).toEqual([`${id}:answered`])
  })

  it('同一间房再报一次是同一个答案(工人重试不改结果)', async () => {
    const { service, id } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.answered({ id, room: LAN_ROOM })
    expect(await service.answered({ id, room: LAN_ROOM })).toEqual({ ok: true, first: true, room: LAN_ROOM })
  })

  it('另一间房下一次来领时知道「这通在别处接了」,回过话之后不再提', async () => {
    const { service, id } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.claimRoom(CLOUD_ROOM)
    await service.answered({ id, room: LAN_ROOM, device_id: 'handset-1' })
    expect((await service.claimRoom(CLOUD_ROOM)).answered_elsewhere).toEqual([{ id, room: LAN_ROOM }])
    expect((await service.claimRoom(LAN_ROOM)).answered_elsewhere).toEqual([])
    // 云房间收掉铃、回一句「没接」:不改「已接」,之后不再提。
    await service.ack({ id, result: 'missed', room: CLOUD_ROOM })
    expect(service.view().entries[0]?.state).toBe('answered')
    expect((await service.claimRoom(CLOUD_ROOM)).answered_elsewhere).toEqual([])
  })

  it('一间房说没接不算整通没接:两间房都收了场才落「未接」', async () => {
    const { service, id, settled } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.claimRoom(CLOUD_ROOM)
    await service.ack({ id, result: 'missed', room: LAN_ROOM })
    expect(service.view().entries[0]?.state).toBe('ringing')
    expect(settled).toEqual([])
    await service.ack({ id, result: 'missed', room: CLOUD_ROOM })
    expect(service.view().entries[0]?.state).toBe('missed')
    expect(settled).toEqual([`${id}:missed`])
  })

  it('一间房说没接、另一间随后接起:照样算接了', async () => {
    const { service, id } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.claimRoom(CLOUD_ROOM)
    await service.ack({ id, result: 'missed', room: LAN_ROOM })
    expect(await service.answered({ id, room: CLOUD_ROOM })).toMatchObject({ ok: true, first: true })
    expect(service.view().entries[0]?.state).toBe('answered')
  })

  it('带房间回「接了」等于报接起(只领了一间房的工人照这样也成)', async () => {
    const { service, id } = await oneCall()
    await service.claimRoom(LAN_ROOM)
    await service.ack({ id, result: 'answered', room: LAN_ROOM })
    expect(service.view().entries[0]).toMatchObject({ state: 'answered', answered_room: LAN_ROOM })
  })

  it('没有这一通 / 还没响:如实说', async () => {
    const { service, id } = await oneCall()
    expect(await service.answered({ id: 'nope', room: LAN_ROOM })).toMatchObject({ ok: false })
    expect(await service.answered({ id, room: LAN_ROOM })).toMatchObject({ ok: false })
  })

  it('房间与接起的那一间落盘,重启读回来还在', async () => {
    const file = tmpFile()
    const { service, id } = await oneCall({ file })
    await service.claimRoom(LAN_ROOM)
    await service.claimRoom(CLOUD_ROOM)
    await service.answered({ id, room: LAN_ROOM, device_id: 'handset-1' })
    await service.ack({ id, result: 'missed', room: CLOUD_ROOM })
    const back = await loadCallOutFile(file)
    expect(back.log[0]).toMatchObject({ rooms: [LAN_ROOM, CLOUD_ROOM], rooms_done: [CLOUD_ROOM], answered_room: LAN_ROOM, answered_device: 'handset-1', state: 'answered' })
  })
})

describe('经 8791', () => {
  async function serve() {
    const file = tmpFile()
    let seq = 0
    const callOut = createCallOutService({ file, newId: () => `call-${++seq}`, now: () => new Date('2026-10-21T14:00:00').getTime() })
    await callOut.load()
    const pairing = createPairingService({ file: join(file, '..', 'devices.json') })
    let actor: 'local' | 'phone' = 'local'
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      callOut,
      pairing,
      remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '192.168.31.40'),
      lan: lanOn(),
    })
    started.push(server)
    pairing.start()
    const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '小米', platform: 'android' })
    if (!claimed.ok) throw new Error('测试装置:配对没成')
    const queued = await callOut.request({ reason: 'confirm', item_id: 't-1', title: '看合同' })
    const post = async (path: string, body?: unknown, token?: string) => {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const log = async () => await (await fetch(`${server.url}/call/log`)).json() as { entries: { state: string }[] }
    return { post, log, id: queued.entry?.id ?? '', who: (value: 'local' | 'phone') => { actor = value }, token: claimed.token }
  }

  it('POST /call/claim {room}:两间房都领到;不带 body 照旧', async () => {
    const h = await serve()
    const lan = await h.post('/call/claim', { room: LAN_ROOM })
    expect((lan.body.calls as { id: string }[]).map(one => one.id)).toEqual([h.id])
    expect(lan.body.answered_elsewhere).toEqual([])
    const cloud = await h.post('/call/claim', { room: CLOUD_ROOM })
    expect((cloud.body.calls as { id: string }[]).map(one => one.id)).toEqual([h.id])
    // 老工人:不带 body,回包里没有新那一格。
    const old = await h.post('/call/claim')
    expect(old.body).toEqual({ calls: [] })
  })

  it('POST /call/answered:先接先得;只认回环;房间名不像样 400', async () => {
    const h = await serve()
    await h.post('/call/claim', { room: LAN_ROOM })
    await h.post('/call/claim', { room: CLOUD_ROOM })
    expect((await h.post('/call/answered', { id: h.id, room: LAN_ROOM, device_id: 'handset-1' })).body).toEqual({ ok: true, first: true, room: LAN_ROOM, device_id: 'handset-1' })
    expect((await h.post('/call/answered', { id: h.id, room: CLOUD_ROOM, device_id: 'phone-1' })).body).toMatchObject({ ok: true, first: false, room: LAN_ROOM })
    expect((await h.post('/call/answered', { id: h.id, room: '带 空格' })).status).toBe(400)
    expect((await h.post('/call/answered', { room: LAN_ROOM })).status).toBe(400)
    h.who('phone')
    expect((await h.post('/call/answered', { id: h.id, room: LAN_ROOM }, h.token)).status).toBe(403)
    expect((await h.post('/call/claim', { room: LAN_ROOM }, h.token)).status).toBe(403)
  })

  it('POST /call/ack 带房间:一间房没接不落「未接」', async () => {
    const h = await serve()
    await h.post('/call/claim', { room: LAN_ROOM })
    await h.post('/call/claim', { room: CLOUD_ROOM })
    expect((await h.post('/call/ack', { id: h.id, result: 'missed', room: LAN_ROOM })).body).toMatchObject({ ok: true })
    expect((await h.log()).entries[0]?.state).toBe('ringing')
    await h.post('/call/ack', { id: h.id, result: 'missed', room: CLOUD_ROOM })
    expect((await h.log()).entries[0]?.state).toBe('missed')
  })
})

describe('字段表:领电话与报接起的回包对得上 channelWire.cases.json', () => {
  const wire = JSON.parse(readFileSync(new URL('../src/server/channelWire.cases.json', import.meta.url), 'utf8')) as { fields: Record<string, string[]> }

  it('按房间领一格不少;报接起每一格都在表里', async () => {
    const file = tmpFile()
    let seq = 0
    const callOut = createCallOutService({ file, newId: () => `call-${++seq}`, now: () => new Date('2026-10-21T14:00:00').getTime() })
    await callOut.load()
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, callOut })
    started.push(server)
    const queued = await callOut.request({ reason: 'confirm', item_id: 't-1', title: '看合同' })
    const post = async (path: string, body: unknown) => await (await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Record<string, unknown>
    const claimed = await post('/call/claim', { room: LAN_ROOM })
    expect(Object.keys(claimed).sort()).toEqual([...wire.fields.call_claim_room as string[]].sort())
    const answered = await post('/call/answered', { id: queued.entry?.id, room: LAN_ROOM, device_id: 'handset-1' })
    for (const key of Object.keys(answered)) expect(wire.fields.call_answered).toContain(key)
  })
})
