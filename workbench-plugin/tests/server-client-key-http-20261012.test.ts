// @vitest-environment node
/**
 * 手机交代一次、电脑只办一次(2026-10-12,卡「手机交代只执行一次」):8791 那一层。
 *
 * 同一台手机在家(局域网带令牌)与出门(房间里工人带 `x-workbench-channel-device` 回环代发)
 * 落成同一个设备 —— 所以「直连发了一半断了、改走房间又发一遍」带着同一个 `client_key`,只建一张卡。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import { CHANNEL_DEVICE_HEADER } from '../src/server/channel.ts'
import { CLIENT_KEY_PATHS, createClientKeyLedger } from '../src/server/clientKeys.ts'
import { createPairingService } from '../src/server/devices.ts'
import { ACTOR_TOKEN_HEADER } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { MdnsAdvertiser } from '../src/server/mdns.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

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

async function serve(keysFile?: string, answers: Parameters<typeof fakeHubModel>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-client-key-http-'))
  dirs.push(dir)
  const pairing = createPairingService({ file: join(dir, 'devices.json'), randomCode: () => '004217' })
  const config = createAppConfig({ file: join(dir, 'app.json') })
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const remote = { address: LOOPBACK }
  const clientKeys = createClientKeyLedger(keysFile === undefined ? {} : { file: keysFile })
  // 2026-10-29 入口归一:/butler/item 不再自己建卡,一律进理解中枢 —— 这几个用例接假模型,
  // 按原话回 note(标题用原话),去重断言(只建一张 / 重放回包)一字不变。
  const model = fakeHubModel(answers)
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    tasks,
    clientKeys,
    actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    lan: { config, mdns: fakeMdns(), lanAddress: () => '10.0.0.2', name: '测试工作台', version: '0.0.0' },
    remoteAddress: () => remote.address,
    model: model.service as never,
    fetchImpl: model.fetchImpl,
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
  const home = (phone: { token: string }) => ({ headers: { authorization: `Bearer ${phone.token}` }, from: PHONE })
  const away = (phone: { id: string }) => ({ headers: { [CHANNEL_DEVICE_HEADER]: phone.id, [ACTOR_TOKEN_HEADER]: 'worker-token' } })
  return { call, pair, tasks, home, away, clientKeys }
}

describe('POST /butler/item 带 client_key', () => {
  it('在家发一次、断了又经房间发一遍(同一个号):只建一张卡,第二次回第一次的回包', async () => {
    const t = await serve(undefined, { '把周报整理一下': [{ name: 'note', title: '把周报整理一下', status: 'todo' }] })
    const phone = await t.pair()
    const first = await t.call('/butler/item', { body: { text: '把周报整理一下', client_key: 'k-1' }, ...t.home(phone) })
    const second = await t.call('/butler/item', { body: { text: '把周报整理一下', client_key: 'k-1' }, ...t.away(phone) })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)
    expect(second.body.replayed).toBe(true)
    expect(first.body.replayed).toBeUndefined()
    expect((await t.tasks.list()).tasks.filter(x => x.title.includes('周报'))).toHaveLength(1)
  })

  it('两条同时到(直连还没回、房间那条已经发出):也只建一张', async () => {
    const t = await serve(undefined, { '订周五的会议室': [{ name: 'note', title: '订周五的会议室', status: 'todo' }] })
    const phone = await t.pair()
    const [a, b] = await Promise.all([
      t.call('/butler/item', { body: { text: '订周五的会议室', client_key: 'k-2' }, ...t.home(phone) }),
      t.call('/butler/item', { body: { text: '订周五的会议室', client_key: 'k-2' }, ...t.away(phone) }),
    ])
    expect(a.body.id).toBe(b.body.id)
    expect((await t.tasks.list()).tasks.filter(x => x.title.includes('会议室'))).toHaveLength(1)
  })

  it('不带号(老手机包、电脑页面)照旧:说两遍建两张', async () => {
    const t = await serve(undefined, { '买咖啡豆': [{ name: 'note', title: '买咖啡豆', status: 'todo' }] })
    const phone = await t.pair()
    await t.call('/butler/item', { body: { text: '买咖啡豆' }, ...t.home(phone) })
    await t.call('/butler/item', { body: { text: '买咖啡豆' }, ...t.home(phone) })
    expect((await t.tasks.list()).tasks.filter(x => x.title.includes('咖啡豆'))).toHaveLength(2)
  })

  it('换一个号就是新的一句', async () => {
    const t = await serve(undefined, { '回邮件': [{ name: 'note', title: '回邮件', status: 'todo' }] })
    const phone = await t.pair()
    await t.call('/butler/item', { body: { text: '回邮件', client_key: 'k-3' }, ...t.home(phone) })
    await t.call('/butler/item', { body: { text: '回邮件', client_key: 'k-4' }, ...t.home(phone) })
    expect((await t.tasks.list()).tasks.filter(x => x.title.includes('回邮件'))).toHaveLength(2)
  })

  it('电脑重启(换一个服务、同一份台账文件)之后补发:还认得', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-client-key-file-'))
    dirs.push(dir)
    const file = join(dir, 'client-keys.json')
    const a = await serve(file, { '交房租': [{ name: 'note', title: '交房租', status: 'todo' }] })
    const phone = await a.pair()
    const first = await a.call('/butler/item', { body: { text: '交房租', client_key: 'k-5' }, ...a.home(phone) })
    await a.clientKeys.flush()
    const ledger = createClientKeyLedger({ file })
    const again = await ledger.begin(`${phone.id} /butler/item`, 'k-5')
    expect(again.kind).toBe('replay')
    expect(again.kind === 'replay' && JSON.parse(again.body).id).toBe(first.body.id)
  })
})

describe('请求号那张路径表', () => {
  it('交代、捎话、派活、答问、批准、回拨这几类都在表里', () => {
    for (const path of ['/butler/item', '/sessions/relay', '/item/drive', '/dispatch/run', '/questions/answer', '/approvals/answer', '/call/out']) {
      expect(CLIENT_KEY_PATHS.has(path), path).toBe(true)
    }
  })
})

describe('/state 报一格「认请求号」', () => {
  it('client_keys: true —— 手机据此才自动补发', async () => {
    const t = await serve()
    expect((await t.call('/state')).body.client_keys).toBe(true)
  })
})
