// @vitest-environment node
/**
 * 行为账接在 8791 上(2026-10-09,卡「行为账」):端由 8791 自己认 ——
 * 电脑页面 = 电脑;手机在家(局域网带令牌)与出门(房间里工人带 `x-workbench-channel-device` 回环代发)= 手机;
 * 电话工人 = 电话;事务官 / 认不出来的不进账。`GET /behavior` 只给本机。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createBehaviorLog, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import { CHANNEL_DEVICE_HEADER } from '../src/server/channel.ts'
import { createPairingService } from '../src/server/devices.ts'
import { ACTOR_TOKEN_HEADER } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createCallRecordsService } from '../src/server/callRecords.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'
const PAGE = { origin: 'http://127.0.0.1:3080' }

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

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-behavior-http-'))
  dirs.push(dir)
  const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    tasks,
    behaviorLog,
    callRecords: createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => dir, fallbackDir: join(dir, 'fallback') }),
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.0.0.2', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
  })
  started.push(server)
  const call = async (path: string, init: { body?: unknown, headers?: Record<string, string>, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const pair = async () => {
    expect((await call('/lan', { body: { enabled: true } })).status).toBe(200)
    const code = ((await call('/pair/start', { body: {} })).body.pairing as { code: string }).code
    const claim = await call('/pair/claim', { body: { code, device_name: '她的手机', platform: 'android' }, from: PHONE })
    return { token: claim.body.token as string, id: claim.body.device_id as string }
  }
  const entries = async (): Promise<BehaviorEntry[]> => {
    await behaviorLog.flush()
    return behaviorLog.read({})
  }
  return { call, pair, tasks, entries }
}

describe('行为账 · 她对事务官说的话', () => {
  it('电脑页面上说的记「电脑」,原话原样', async () => {
    const t = await serve()
    await t.call('/butler/item', { body: { text: '下周的选题先别排' }, headers: PAGE })
    const said = (await t.entries()).filter(e => e.事 === '说')
    expect(said).toEqual([expect.objectContaining({ 端: '电脑', 原话: '下周的选题先别排' })])
  })

  it('手机在家(局域网带令牌)与出门(工人代发带设备头)都记「手机」,顺带记一次露面', async () => {
    const t = await serve()
    const phone = await t.pair()
    await t.call('/butler/item', { body: { text: '在家说的' }, headers: { authorization: `Bearer ${phone.token}` }, from: PHONE })
    // 工人代发时每条请求都挂着它自己那把令牌(channel-worker/src/workbench.ts 的 withActor)
    await t.call('/butler/item', { body: { text: '出门说的' }, headers: { [CHANNEL_DEVICE_HEADER]: phone.id, [ACTOR_TOKEN_HEADER]: 'worker-token' } })
    const all = await t.entries()
    expect(all.filter(e => e.事 === '说').map(e => `${e.端}:${e.原话}`)).toEqual(['手机:在家说的', '手机:出门说的'])
    expect(all.filter(e => e.事 === '露面').map(e => e.端)).toEqual(['手机'])
  })

  it('事务官自己建的、认不出是谁的,不进账', async () => {
    const t = await serve()
    await t.call('/butler/item', { body: { text: '事务官建的' }, headers: { [ACTOR_TOKEN_HEADER]: 'butler-token' } })
    await t.call('/butler/item', { body: { text: '一条 curl' } })
    expect(await t.entries()).toEqual([])
  })

  it('通话记录里她说的那几句记「电话」(对象是那一通);同一通后到的那份不重记', async () => {
    const t = await serve()
    const record = { call_id: 'c-1', durationSeconds: 30, transcript: [{ who: 'butler', text: '早,今天有两件等你' }, { who: 'me', text: '先说第一件' }] }
    await t.call('/butler/call/record', { body: record, headers: { [ACTOR_TOKEN_HEADER]: 'worker-token' } })
    await t.call('/butler/call/record', { body: { ...record, transcript: [...record.transcript, { who: 'me', text: '好' }] }, headers: { [ACTOR_TOKEN_HEADER]: 'worker-token' } })
    const said = (await t.entries()).filter(e => e.事 === '说')
    expect(said.map(e => `${e.端}:${e.对象}:${e.原话}`)).toEqual(['电话:通话 c-1:先说第一件'])
  })
})

describe('行为账 · 通过 / 打回', () => {
  it('等我确认那件在手机上点完成 = 手机 · 审 · 通过', async () => {
    const t = await serve()
    const phone = await t.pair()
    const created = await t.tasks.create({ title: '导出 PDF', direction: 'mine', status: 'confirm' })
    await t.call('/task/move', { body: { id: created.id, status: 'done' }, headers: { authorization: `Bearer ${phone.token}` }, from: PHONE })
    const review = (await t.entries()).filter(e => e.事 === '审')
    expect(review).toEqual([expect.objectContaining({ 端: '手机', 结果: '通过', 对象: `${created.id} 导出 PDF` })])
  })
})

describe('GET /behavior 只给本机', () => {
  it('本机读得到,按 事 筛;手机读 403', async () => {
    const t = await serve()
    const phone = await t.pair()
    await t.call('/butler/item', { body: { text: '记一下' }, headers: PAGE })
    const local = await t.call('/behavior?事=说')
    expect(local.status).toBe(200)
    expect((local.body.entries as BehaviorEntry[]).map(e => e.原话)).toEqual(['记一下'])
    expect((await t.call('/behavior?since=不是时间')).status).toBe(400)
    expect((await t.call('/behavior', { headers: { authorization: `Bearer ${phone.token}` }, from: PHONE })).status).toBe(403)
  })
})
