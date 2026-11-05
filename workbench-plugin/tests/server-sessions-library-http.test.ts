// @vitest-environment node
/**
 * 手机读对话那几个口(2026-10-01):`/sessions/history`、`/sessions/transcript`、`/sessions/attachment`。
 * 守的是接缝:门与 `/sessions/digest` 同一道(本机或已配对的手机;局域网裸请求挡住)、参数不对 400、没接线 404、
 * 回包原样是读对话那一层给的。读法本身的用例在 session-history / session-transcript / session-attachments 里。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_HISTORY_PER_FAMILY, type SessionHistoryView } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createPairingService } from '../src/server/devices.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import type { SessionLibrary } from '../src/server/sessionLibrary.ts'
import { PER_FAMILY_MAX, type SessionHistoryQuery } from '../src/server/sessionHistory.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createSessionTranscript } from '../src/server/sessionTranscript.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

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

const HISTORY: SessionHistoryView = {
  items: [{ agent: 'claude', session_id: 'c1', title: '统筹交接', last_at: '2026-10-01T00:00:00.000Z', last_line: { who: 'ai', text: '好' } }],
  next: 'cursor-1',
  days: 7,
  read_at: '2026-10-01T09:00:00.000Z',
}

export async function serveLibrary(library: SessionLibrary | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sessions-library-'))
  dirs.push(dir)
  const remote = { address: LOOPBACK }
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(library === undefined ? {} : { sessionLibrary: library }),
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
    const claim = await call('/pair/claim', { body: JSON.stringify({ code, device_name: 'Ben 的手机', platform: 'android' }), from: PHONE })
    expect(claim.status).toBe(200)
    return claim.body.token as string
  }
  return { call, pair }
}

describe('GET /sessions/history', () => {
  it('★本机能看;局域网裸请求挡住;已配对的手机能看;查询参数原样交给读对话那一层', async () => {
    const seen: SessionHistoryQuery[] = []
    const t = await serveLibrary({ history: async (query) => { seen.push(query); return HISTORY } })
    const local = await t.call('/sessions/history')
    expect(local.status).toBe(200)
    expect(local.body).toEqual(HISTORY)
    const token = await t.pair()
    expect((await t.call('/sessions/history', { from: PHONE })).status).toBe(401)
    const phone = await t.call('/sessions/history?agent=claude&before=cursor-1&limit=5', { from: PHONE, token })
    expect(phone.status).toBe(200)
    expect(seen.at(-1)).toEqual({ agent: 'claude', before: 'cursor-1', limit: 5 })
  })

  it('agent 写得不对 → 400;没接线 → 404', async () => {
    const t = await serveLibrary({ history: async () => HISTORY })
    expect((await t.call('/sessions/history?agent=../../etc')).status).toBe(400)
    const none = await serveLibrary(undefined)
    expect((await none.call('/sessions/history')).status).toBe(404)
  })

  /** 固定入口那一档(2026-10-03,卡「手机各家最近会话固定入口」):多一个参数,别的一个字没动。 */
  it('★ per_family 原样交给读对话那一层;不是 1…上限的整数 → 400;不带它那一层就收不到这一格', async () => {
    const seen: SessionHistoryQuery[] = []
    const t = await serveLibrary({ history: async (query) => { seen.push(query); return { ...HISTORY, ...(query.per_family === undefined ? {} : { per_family: query.per_family }) } } })
    const got = await t.call(`/sessions/history?per_family=${SESSION_HISTORY_PER_FAMILY}`)
    expect(got.status).toBe(200)
    expect(seen.at(-1)).toEqual({ per_family: SESSION_HISTORY_PER_FAMILY })
    expect(got.body.per_family).toBe(SESSION_HISTORY_PER_FAMILY)
    expect((await t.call('/sessions/history')).status).toBe(200)
    expect(seen.at(-1)).toEqual({})
    for (const bad of ['0', '-1', '2.5', 'ten', String(PER_FAMILY_MAX + 1)]) {
      expect((await t.call(`/sessions/history?per_family=${bad}`)).status, bad).toBe(400)
    }
  })
})

describe('GET /sessions/transcript', () => {
  it('★门同 digest;参数原样交下去;读不到的照那一层说的码与那句话回', async () => {
    const seen: unknown[] = []
    const t = await serveLibrary({
      history: async () => HISTORY,
      transcript: async (query) => {
        seen.push(query)
        if (query.id === 'gone') return { ok: false, status: 404, error: '读不到这条对话的记录' }
        return { ok: true, value: { agent: query.agent, session_id: query.id, entries: [{ k: 'ask', text: '你好' }], before: '120', read_at: '2026-10-01T09:00:00.000Z' } }
      },
    })
    const local = await t.call('/sessions/transcript?agent=claude&id=c1&before=300&from=')
    expect(local.status).toBe(200)
    expect(local.body).toMatchObject({ entries: [{ k: 'ask', text: '你好' }], before: '120' })
    expect(seen.at(-1)).toEqual({ agent: 'claude', id: 'c1', before: '300' })
    const gone = await t.call('/sessions/transcript?agent=claude&id=gone')
    expect(gone.status).toBe(404)
    expect(gone.body).toEqual({ error: '读不到这条对话的记录' })
    expect((await t.call('/sessions/transcript?agent=claude&id=c1&from=100')).status).toBe(200)
    expect(seen.at(-1)).toEqual({ agent: 'claude', id: 'c1', from: '100' })
    const token = await t.pair()
    expect((await t.call('/sessions/transcript?agent=claude&id=c1', { from: PHONE })).status).toBe(401)
    expect((await t.call('/sessions/transcript?agent=claude&id=c1', { from: PHONE, token })).status).toBe(200)
    expect((await t.call('/sessions/transcript?agent=claude')).status).toBe(400)
    expect((await (await serveLibrary({ history: async () => HISTORY })).call('/sessions/transcript?agent=claude&id=c1')).status).toBe(404)
  })

  it('受控本地原件经正式读取器：缺文件/未知来源/坏游标的错误不由CLI能力判断覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-transcript-local-')); dirs.push(dir)
    const file = join(dir, 'c1.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'user', sessionId: 'c1', origin: { kind: 'human' }, message: { role: 'user', content: '受控读取问题' } }) + '\n')
    const reader = createSessionTranscript({ locate: async (agent, id) => agent === 'claude' && (id === 'c1' || id === 'missing')
      ? { agent, session_id: id, format: 'claude-transcript', file: id === 'c1' ? file : join(dir, 'missing.jsonl') }
      : undefined })
    const t = await serveLibrary({ history: async () => HISTORY, transcript: query => reader.read(query) })
    const valid = await t.call('/sessions/transcript?agent=claude&id=c1')
    expect(valid.status).toBe(200)
    expect(valid.body).toMatchObject({ entries: [{ k: 'ask', text: '受控读取问题' }] })
    for (const [query, status, error] of [
      ['agent=claude&id=gone', 404, '读不到这条对话的记录(可能删掉了,或者不是这几家的)'],
      ['agent=claude&id=missing', 404, '读不到这条对话的记录(可能删掉了)'],
      ['agent=other&id=c1', 404, '读不到这条对话的记录(可能删掉了,或者不是这几家的)'],
      ['agent=claude&id=c1&before=bad', 400, '往上翻的位置不对'],
    ] as const) {
      expect(await t.call('/sessions/transcript?' + query)).toEqual({ status, body: { error } })
    }
  })

  it.each([
    ['claude', 403, '这条受控来源未授权'],
    ['unavailable', 501, '该读取器不支持此来源'],
  ] as const)('读取层明确拒绝或不支持：%s 的原码与原错都保留', async (agent, status, error) => {
    const t = await serveLibrary({ history: async () => HISTORY, transcript: async () => ({ ok: false, status, error }) })
    expect(await t.call(`/sessions/transcript?agent=${agent}&id=c1`)).toEqual({ status, body: { error } })
  })
})

describe('GET /sessions/attachment', () => {
  it('★门同 digest;参数原样交下去;view 不认识 400;那一层说不给就原样回码', async () => {
    const seen: unknown[] = []
    const t = await serveLibrary({
      history: async () => HISTORY,
      attachment: async (query) => {
        seen.push(query)
        if (query.ref === 'forged') return { ok: false, status: 403, error: '这个文件不在这条对话里,不给' }
        return { ok: true, value: { ref: query.ref, view: 'full', part: query.part ?? 0, parts: 2, mime: 'image/png', data: 'AAAA' } }
      },
    })
    const ok = await t.call('/sessions/attachment?agent=claude&id=c1&ref=12~b~message.content.0&view=full&part=1')
    expect(ok.status).toBe(200)
    expect(seen.at(-1)).toEqual({ agent: 'claude', id: 'c1', ref: '12~b~message.content.0', view: 'full', part: 1, page: 0 })
    expect((await t.call('/sessions/attachment?agent=claude&id=c1&ref=forged')).status).toBe(403)
    expect((await t.call('/sessions/attachment?agent=claude&id=c1&ref=x&view=raw')).status).toBe(400)
    const token = await t.pair()
    expect((await t.call('/sessions/attachment?agent=claude&id=c1&ref=x', { from: PHONE })).status).toBe(401)
    expect((await t.call('/sessions/attachment?agent=claude&id=c1&ref=x', { from: PHONE, token })).status).toBe(200)
  })

  /**
   * `view=keep`(2026-10-04,卡「手机看各家对话里的图片和文件」):开一张取件单,手机照旧走
   * `GET /files/offer/<单号>`。这里守三件事:**只给手机**(电脑上文件就在本机)、回包里**没有路径**、
   * 那一层说不给就原样回码。
   */
  it('★view=keep:手机点一下开一张取件单(回单号,不回路径);本机点 403;那一层说存不下来就原样回', async () => {
    const asked: unknown[] = []
    const dir = mkdtempSync(join(tmpdir(), 'wb-keep-'))
    dirs.push(dir)
    const zip = join(dir, '素材.zip')
    writeFileSync(zip, Buffer.alloc(16, 1))
    const t = await serveLibrary({
      history: async () => HISTORY,
      attachment: async () => ({ ok: false, status: 404, error: '不该走到这儿' }),
      attachmentFile: async (query) => {
        asked.push(query)
        if (query.ref.includes('~b~')) return { ok: false, status: 403, error: '这张图只在对话记录里,电脑上没有这个文件 —— 看是能看的,存不下来' }
        return { ok: true, value: { path: zip, name: '素材.zip', bytes: 16, where: '这条对话里' } }
      },
    })
    // 本机:不开单(文件就在这台电脑上)
    expect((await t.call('/sessions/attachment?agent=codex&id=c1&ref=12~p~abc&view=keep')).status).toBe(403)
    const token = await t.pair()
    const got = await t.call('/sessions/attachment?agent=codex&id=c1&ref=12~p~abc&view=keep', { from: PHONE, token })
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ name: '素材.zip', bytes: 16, where: '这条对话里', kind: 'other' })
    expect(typeof got.body.offer).toBe('string')
    expect(JSON.stringify(got.body)).not.toContain(dir)
    expect(asked.at(-1)).toEqual({ agent: 'codex', id: 'c1', ref: '12~p~abc' })
    // 写在记录里的 base64 图:原样回那一句
    const no = await t.call('/sessions/attachment?agent=codex&id=c1&ref=12~b~payload.output.1&view=keep', { from: PHONE, token })
    expect(no.status).toBe(403)
    expect(no.body.error).toMatch(/存不下来/)
  })

  it('view=keep 但这台电脑没接这条路:404,如实说', async () => {
    const t = await serveLibrary({ history: async () => HISTORY, attachment: async () => ({ ok: false, status: 404, error: 'x' }) })
    const token = await t.pair()
    const got = await t.call('/sessions/attachment?agent=codex&id=c1&ref=12~p~abc&view=keep', { from: PHONE, token })
    expect(got.status).toBe(404)
    expect(got.body.error).toMatch(/没接上/)
  })
})
