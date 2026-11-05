/**
 * 出了局域网的会议分段(2026-10-09,卡「会后真机走通」)—— 工人这一侧。
 *
 * 照「按住说话」那条(asrRelay.ts)走:一段 m4a 在 `wb.meeting` 字节流上到,`wb.rpc` 上一条
 * `type:'meeting_segment'` 来取;两样在信箱里对上,以那台手机的身份 POST 8791 的 `/meeting/segment`
 * (与局域网直连同一条路、同一道门)。**只转不存**:工人手里只在内存里过一下,不落盘。
 * 手机那一侧只有她在会议页上点过「现在经服务器传」才走这条(那一侧的用例守着)。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { AsrStreamReader } from '../src/asrRelay.ts'
import {
  MEETING_ID_ATTRIBUTE,
  MEETING_SEGMENT_MAX_BYTES,
  MEETING_SEGMENT_PATH,
  MEETING_TOPIC,
  createMeetingMailbox,
  createMeetingRelay,
  createMeetingStreamHandler,
  workbenchMeetingPoster,
} from '../src/meetingRelay.ts'
import { handleRpcRequest, isAllowedRpcPath, notPairedResponse, parseRpcRequest } from '../src/rpc.ts'
import type { RpcWorkbenchPort } from '../src/rpc.ts'
import { CHANNEL_DEVICE_HEADER } from '../src/workbench.ts'

function reader(bytes: Uint8Array, options: { id?: string, totalSize?: number, mimeType?: string } = {}): AsrStreamReader & { closed: boolean } {
  const out = {
    closed: false,
    info: {
      totalSize: options.totalSize ?? bytes.byteLength,
      ...(options.id === undefined ? {} : { attributes: { [MEETING_ID_ATTRIBUTE]: options.id } }),
      mimeType: options.mimeType ?? 'audio/mp4',
    },
    async close() { out.closed = true },
    async* [Symbol.asyncIterator]() {
      for (let at = 0; at < bytes.byteLength; at += 15_000) yield bytes.subarray(at, at + 15_000)
    },
  }
  return out
}

const servers: { close: () => void }[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function fake8791(status = 200, paired = ['dev-1']) {
  const seen: { method: string, path: string, device: string, contentType: string, bytes: Buffer }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const device = String(req.headers[CHANNEL_DEVICE_HEADER] ?? '')
      seen.push({ method: req.method ?? '', path: req.url ?? '', device, contentType: String(req.headers['content-type'] ?? ''), bytes: Buffer.concat(chunks) })
      if (!paired.includes(device)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '这台设备没配对过' })); return }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: '没有这一场会议' }))
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
  servers.push({ close: () => server.close() })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const noWorkbench: RpcWorkbenchPort = {
  callAsDevice: async () => { throw new Error('分段不该走通用代理') },
  renewTicket: async () => ({ error: '用不到', status: 500 }),
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise(done => setImmediate(done)) }

describe('两端的约定', () => {
  it('topic、编号属性、8791 那条路写死;手机那一侧逐字一样(读源头文件比对)', () => {
    expect(MEETING_TOPIC).toBe('wb.meeting')
    expect(MEETING_ID_ATTRIBUTE).toBe('wb_meeting_seg')
    expect(MEETING_SEGMENT_PATH).toBe('/meeting/segment')
    const phone = readFileSync(new URL('../../butler-app/src/channel/channelProtocol.ts', import.meta.url), 'utf8')
    expect(phone).toContain(`WBCH_MEETING_TOPIC = '${MEETING_TOPIC}'`)
    expect(phone).toContain(`WBCH_MEETING_ID_ATTRIBUTE = '${MEETING_ID_ATTRIBUTE}'`)
  })

  it('一段的上限放得下十分钟的 m4a(64kbps 约 4.7MB)与 WebView 退路的 webm,又不超过 8791 自己的上限', () => {
    expect(MEETING_SEGMENT_MAX_BYTES).toBeGreaterThan(10 * 60 * 128_000 / 8)
    expect(MEETING_SEGMENT_MAX_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024)
  })

  it('会议那几条只有文字的(开 / 结束 / 看纪要 / 建事项 / 重新来)在白名单里;分段本身不在(它走字节流)', () => {
    for (const [method, path] of [['POST', '/meeting/start'], ['POST', '/meeting/finish'], ['GET', '/meeting'], ['POST', '/meeting/apply'], ['POST', '/meeting/retry']] as const) {
      expect(isAllowedRpcPath(method, path)).toBe(true)
    }
    expect(isAllowedRpcPath('POST', '/meeting/segment')).toBe(false)
  })

  it('「导入转写出纪要」那条**不进**白名单(2026-10-13):它能读那台电脑上任意一个文件,只给本机', () => {
    expect(isAllowedRpcPath('POST', '/meeting/import')).toBe(false)
    // 「放三场演示用的会」也不进(2026-10-13):它在她的工作目录里建三场会、还要问几次模型
    expect(isAllowedRpcPath('POST', '/meeting/seed-demo')).toBe(false)
  })
})

describe('wb.rpc 上的 type:meeting_segment', () => {
  it('读得懂:id + 哪一场 + 第几段 + 多长', () => {
    expect(parseRpcRequest('{"id":"s1","type":"meeting_segment","meeting_id":"m1","seq":2,"ms":600000}'))
      .toEqual({ ok: true, request: { id: 's1', type: 'meeting_segment', meeting_id: 'm1', seq: 2, ms: 600000 } })
  })

  it('缺哪一场 / 段号不是正整数:当场说清', () => {
    expect(parseRpcRequest('{"id":"s1","type":"meeting_segment","seq":1}').ok).toBe(false)
    expect(parseRpcRequest('{"id":"s1","type":"meeting_segment","meeting_id":"m1","seq":0}').ok).toBe(false)
  })

  it('这个工人没接分段这条路:501(手机说「电脑上的事务官要更新」);那头抛了:502', async () => {
    const request = { id: 's1', type: 'meeting_segment' as const, meeting_id: 'm1', seq: 1 }
    await expect(handleRpcRequest(request, { deviceId: 'dev-1', identity: 'x', workbench: noWorkbench })).resolves.toMatchObject({ type: 'http', status: 501 })
    await expect(handleRpcRequest(request, {
      deviceId: 'dev-1', identity: 'x', workbench: noWorkbench, meeting: { segment: async () => { throw new Error('boom') } },
    })).resolves.toMatchObject({ type: 'http', status: 502 })
  })

  it('不是配对过的手机:403', () => {
    expect(notPairedResponse({ id: 's1', type: 'meeting_segment', meeting_id: 'm1', seq: 1 })).toMatchObject({ type: 'http', status: 403 })
  })
})

describe('wb.meeting 字节流的接法', () => {
  it('不是配对过的手机 / 没带编号 / 不是第一台电脑:不收,关掉那一头', async () => {
    for (const [primary, identity, id] of [[true, 'test-page', 'a1'], [true, 'wb-phone-dev-1', undefined], [false, 'wb-phone-dev-1', 'a1']] as const) {
      const mailbox = createMeetingMailbox()
      const on = createMeetingStreamHandler({ mailbox, primary, deviceOf: one => (one.startsWith('wb-phone-') ? 'dev-1' : undefined) })
      const r = reader(new Uint8Array(100), id === undefined ? {} : { id })
      on(r, { identity })
      await settle()
      expect(r.closed).toBe(true)
      expect(mailbox.size()).toBe(0)
    }
  })

  it('流头报的比上限大:不收(交给 8791 之前就回 413)', async () => {
    const mailbox = createMeetingMailbox()
    const on = createMeetingStreamHandler({ mailbox, primary: true, deviceOf: () => 'dev-1' })
    on(reader(new Uint8Array(10), { id: 'big', totalSize: MEETING_SEGMENT_MAX_BYTES + 1 }), { identity: 'wb-phone-dev-1' })
    await settle()
    expect(await mailbox.take('wb-phone-dev-1', 'big', 10)).toMatchObject({ ok: false, status: 413 })
  })
})

describe('整条路(字节流 + wb.rpc + 8791)', () => {
  it('一段 m4a:以那台手机的身份原样 POST /meeting/segment?id&seq&ms,8791 的回包原样回去', async () => {
    const wb = await fake8791()
    const mailbox = createMeetingMailbox()
    const on = createMeetingStreamHandler({ mailbox, primary: true, deviceOf: () => 'dev-1' })
    const relay = createMeetingRelay({ mailbox, post: workbenchMeetingPoster({ workbenchUrl: wb.url }) })
    const bytes = new Uint8Array(40_000).map((_, i) => i % 251)
    const answer = handleRpcRequest({ id: 's1', type: 'meeting_segment', meeting_id: 'm 1', seq: 3, ms: 600000 }, {
      deviceId: 'dev-1', identity: 'wb-phone-dev-1', workbench: noWorkbench, meeting: relay,
    })
    setTimeout(() => on(reader(bytes, { id: 's1' }), { identity: 'wb-phone-dev-1' }), 20)
    await expect(answer).resolves.toEqual({ id: 's1', type: 'http', status: 200, body: { ok: true } })
    expect(wb.seen[0]).toMatchObject({ method: 'POST', path: `${MEETING_SEGMENT_PATH}?id=m%201&seq=3&ms=600000`, device: 'dev-1', contentType: 'audio/mp4' })
    expect(Buffer.compare(wb.seen[0]!.bytes, Buffer.from(bytes))).toBe(0)
  })

  it('录音没到:408 + 人话;一次都不交给 8791', async () => {
    const wb = await fake8791()
    const relay = createMeetingRelay({ mailbox: createMeetingMailbox(), post: workbenchMeetingPoster({ workbenchUrl: wb.url }), streamWaitMs: 20 })
    const got = await relay.segment({ id: 's9', deviceId: 'dev-1', identity: 'wb-phone-dev-1', meetingId: 'm1', seq: 1 })
    expect(got.status).toBe(408)
    expect(wb.seen).toHaveLength(0)
  })

  it('8791 不认这一场(404)/ 解除配对(401):原样带回去', async () => {
    for (const [status, paired] of [[404, ['dev-1']], [401, []]] as const) {
      const wb = await fake8791(status, [...paired])
      const mailbox = createMeetingMailbox()
      mailbox.put('wb-phone-dev-1', 's1', { ok: true, bytes: new Uint8Array(10), mime: 'audio/mp4' })
      const relay = createMeetingRelay({ mailbox, post: workbenchMeetingPoster({ workbenchUrl: wb.url }) })
      const got = await relay.segment({ id: 's1', deviceId: 'dev-1', identity: 'wb-phone-dev-1', meetingId: 'm1', seq: 1 })
      expect(got.status).toBe(status === 404 ? 404 : 401)
    }
  })
})
