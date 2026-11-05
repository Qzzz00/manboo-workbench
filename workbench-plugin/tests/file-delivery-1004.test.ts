// @vitest-environment node
/**
 * 交付回执台账那三件后续(2026-10-04 午后统筹定,卡 `claude/three-small-1004`;
 * 出处 `docs/交接-1004-手机要文件一条路走通.md` 第四节「边界」与第六节「没查」):
 *
 * ① **电话里要文件也进台账**(`POST /files/phone-delivery` → 工人报流水带单号 → 回执落卡);
 * ② **台账落盘**(`~/.dsh/workbench/file-delivery.json`,重启不丢、老数据读得懂);
 * ③ **那一轮被打断(aborted)收尾时同样问「送到没有」**;
 * ④ **老手机包收不到推过来的卡** → 卡面说实话,不再说「点一下就到手」。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { createTasksService } from '../src/server/tasks.ts'
import {
  DELIVERY_PENDING_GRACE_MS,
  DELIVERY_WHY_NOT_SENT,
  DELIVERY_WHY_PHONE_TOO_OLD,
  DELIVERY_WHY_PUSHING,
  DELIVERY_WHY_WAITING_TAP,
  createFileDeliveryStore,
  deliveredNote,
  notDeliveredNote,
} from '../src/server/fileDelivery.ts'
import type { FileDeliveryNeed } from '../src/server/fileDelivery.ts'
import {
  createFileDeliveryPersist,
  defaultFileDeliveryFile,
  parseFileDeliveryFile,
  parseFileDeliveryNeed,
} from '../src/server/fileDeliveryFile.ts'
import { STOPPED_NOTE, itemTransitionOnSessionEnd } from '../src/server/butlerLifecycle.ts'
import { lanOn } from './helpers/lanOn.ts'

const T0 = Date.parse('2026-10-04T09:17:00Z')
const ITEM = 't-63a9291b'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), tag))
  dirs.push(dir)
  return dir
}

// ───────────────────────────── ① 电话里那条:字节直推,没有卡要她点 ─────────────────────────────

describe('① 电话里要的文件:字节是工人直推的,没有一张卡要她点', () => {
  it('★「为什么还没到」说「正在传」,不说「点一下就到手」—— 她手机上压根没有那张卡', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: '电话里要「逐字稿.md」', deviceId: 'dev-phone', deviceName: 'Ben 的手机', pushed: true })
    s.offered(ITEM, { what: '逐字稿.md', offers: ['call-1'] })
    expect(s.pending(ITEM)).toEqual({ what: '逐字稿.md', why: DELIVERY_WHY_PUSHING, waitingTap: false })
  })

  it('★这一条永远不是「等你输入」:没有哪一下要她点,回电就不该说「等你回答」', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: '电话里要', deviceId: 'dev-phone', deviceName: 'Ben 的手机', pushed: true })
    s.offered(ITEM, { what: 'a.md', offers: ['call-1'] })
    expect(s.pending(ITEM)?.waitingTap).toBe(false)
  })

  it('推完了报回执 → 到了(与手机打字那条同一处)', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: '电话里要', deviceId: 'dev-phone', deviceName: 'Ben 的手机', pushed: true })
    s.offered(ITEM, { what: 'a.md', offers: ['call-1'] })
    const settled = s.receipt({ offer: 'call-1', ok: true, name: 'a.md', bytes: 2048 })
    expect(settled?.item_id).toBe(ITEM)
    expect(s.pending(ITEM)).toBeUndefined()
    expect(deliveredNote('a.md', 2048)).toContain('已经到你手机上了')
  })

  it('推不过去 → 原因原样留着,不说「正在传」', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: '电话里要', deviceId: 'dev-phone', deviceName: 'Ben 的手机', pushed: true })
    s.offered(ITEM, { what: 'a.md', offers: ['call-1'] })
    s.receipt({ offer: 'call-1', ok: false, error: 'Ben 的手机这会儿不在房里(App 没开着,或者没网)' })
    expect(s.pending(ITEM)).toEqual({
      what: 'a.md',
      why: 'Ben 的手机这会儿不在房里(App 没开着,或者没网)',
      waitingTap: false,
    })
  })

  it('手机打字那条一个字没变(卡摆着等她点)', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    s.offered(ITEM, { what: 'a.md', offers: ['offer-1'], ask: { hits: [], query: 'a', device: 'Ben 的手机', total: 0 } as never })
    expect(s.pending(ITEM)).toEqual({ what: 'a.md', why: DELIVERY_WHY_WAITING_TAP, waitingTap: true })
  })
})

// ───────────────────────────── ④ 老手机包收不到那张卡 ─────────────────────────────

describe('④ 卡推过去了,可她手机一直没来取', () => {
  const ask = { hits: [], query: 'a', device: 'Ben 的手机', total: 0 } as never

  function pushed(now: () => number) {
    const s = createFileDeliveryStore({ now })
    s.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    s.offered(ITEM, { what: 'a.md', offers: ['offer-1'], ask })
    return s
  }

  it('刚推过去:照旧说「点一下就到手」(宽限期内,慢一拍不是坏)', () => {
    const s = pushed(() => T0)
    expect(s.pending(ITEM)?.why).toBe(DELIVERY_WHY_WAITING_TAP)
  })

  it('★过了宽限期还没有哪一次 `/files/pending` 来过 → 卡面说实话:手机端要更新才能收到', () => {
    let now = T0
    const s = pushed(() => now)
    now = T0 + DELIVERY_PENDING_GRACE_MS + 1
    expect(s.pending(ITEM)).toEqual({ what: 'a.md', why: DELIVERY_WHY_PHONE_TOO_OLD, waitingTap: false })
  })

  it('★这一条也不是「等你输入」:那张卡她根本看不见,点不着', () => {
    let now = T0
    const s = pushed(() => now)
    now = T0 + DELIVERY_PENDING_GRACE_MS + 1
    expect(s.pending(ITEM)?.waitingTap).toBe(false)
  })

  it('★新手机包问过一次 `/files/pending` → 照旧「点一下就到手」(这条路通着,只是她还没点)', () => {
    let now = T0
    const s = pushed(() => now)
    s.asksFor('dev-phone')
    now = T0 + DELIVERY_PENDING_GRACE_MS + 1
    expect(s.pending(ITEM)?.why).toBe(DELIVERY_WHY_WAITING_TAP)
  })

  it('别的那台来问过不算这一台来过(按设备分开数)', () => {
    let now = T0
    const s = pushed(() => now)
    s.asksFor('dev-别的手机')
    now = T0 + DELIVERY_PENDING_GRACE_MS + 1
    expect(s.pending(ITEM)?.why).toBe(DELIVERY_WHY_PHONE_TOO_OLD)
  })

  it('还没开单的那一条照旧说「事务官一下都没走」(这一问与手机包新旧无关)', () => {
    let now = T0
    const s = createFileDeliveryStore({ now: () => now })
    s.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    now = T0 + DELIVERY_PENDING_GRACE_MS + 1
    expect(s.pending(ITEM)?.why).toBe(DELIVERY_WHY_NOT_SENT)
  })
})

// ───────────────────────────── ② 落盘 ─────────────────────────────

describe('② 台账落盘:重启不丢', () => {
  it('★写一次、换一本新台账读回来 —— 那一条还在,还差一个回执', () => {
    const dir = tempDir('wb-delivery-file-')
    const persist = createFileDeliveryPersist(defaultFileDeliveryFile(dir))
    const first = createFileDeliveryStore({ now: () => T0, persist })
    first.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    first.offered(ITEM, { what: '官网逐字稿-2026-10-04.md', offers: ['offer-1'] })

    const after = createFileDeliveryStore({ now: () => T0, persist })
    expect(after.pending(ITEM)).toEqual({
      what: '官网逐字稿-2026-10-04.md',
      why: DELIVERY_WHY_WAITING_TAP,
      waitingTap: true,
    })
  })

  it('到了之后那一条读回来也是「到了」(不会重启一次又催她一遍)', () => {
    const dir = tempDir('wb-delivery-file-')
    const persist = createFileDeliveryPersist(defaultFileDeliveryFile(dir))
    const first = createFileDeliveryStore({ now: () => T0, persist })
    first.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    first.offered(ITEM, { what: 'a.md', offers: ['offer-1'] })
    first.receipt({ offer: 'offer-1', ok: true, name: 'a.md', bytes: 10 })
    expect(createFileDeliveryStore({ now: () => T0, persist }).pending(ITEM)).toBeUndefined()
  })

  it('★过了 TTL 的那几条读回来就丢掉(她早走开了)', () => {
    const dir = tempDir('wb-delivery-file-')
    const persist = createFileDeliveryPersist(defaultFileDeliveryFile(dir))
    const first = createFileDeliveryStore({ now: () => T0, persist })
    first.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    const after = createFileDeliveryStore({ now: () => T0 + 25 * 60 * 60 * 1000, persist })
    expect(after.list()).toEqual([])
  })

  it('电话里那条的 `pushed` 也落得下、读得回(不然重启后它又变成「点一下就到手」)', () => {
    const dir = tempDir('wb-delivery-file-')
    const persist = createFileDeliveryPersist(defaultFileDeliveryFile(dir))
    const first = createFileDeliveryStore({ now: () => T0, persist })
    first.expect({ itemId: ITEM, request: '电话里要', deviceId: 'dev-phone', deviceName: 'Ben 的手机', pushed: true })
    first.offered(ITEM, { what: 'a.md', offers: ['call-1'] })
    expect(createFileDeliveryStore({ now: () => T0, persist }).pending(ITEM)?.why).toBe(DELIVERY_WHY_PUSHING)
  })

  it('落盘那份文件长什么样:带版本号,一条就是一条', () => {
    const dir = tempDir('wb-delivery-file-')
    const path = defaultFileDeliveryFile(dir)
    const s = createFileDeliveryStore({ now: () => T0, persist: createFileDeliveryPersist(path) })
    s.expect({ itemId: ITEM, request: '把逐字稿发我', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
    const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number, needs: FileDeliveryNeed[] }
    expect(file.version).toBe(1)
    expect(file.needs).toHaveLength(1)
    expect(file.needs[0]?.item_id).toBe(ITEM)
  })

  it('没有 persist 就照旧只在内存里(单测、认不出家目录的那台)', () => {
    const s = createFileDeliveryStore({ now: () => T0 })
    s.expect({ itemId: ITEM, request: 'x', deviceId: 'd', deviceName: 'D' })
    expect(s.list()).toHaveLength(1)
  })
})

describe('② 老数据读得懂', () => {
  it('第一次跑 / 文件被删了 → 从空的开始,不抛', () => {
    const dir = tempDir('wb-delivery-file-')
    expect(createFileDeliveryPersist(defaultFileDeliveryFile(dir)).load()).toBeUndefined()
  })

  it('★写坏了的那份 → 当空的,不抛(台账照旧在内存里管事)', () => {
    const dir = tempDir('wb-delivery-file-')
    const path = join(dir, 'file-delivery.json')
    writeFileSync(path, '{ 这不是 json', 'utf8')
    expect(createFileDeliveryPersist(path).load()).toBeUndefined()
  })

  it('★看不懂的那一条丢掉,看得懂的留下 —— 不让一条把整本带走', () => {
    const got = parseFileDeliveryFile({
      version: 1,
      needs: [
        { item_id: '', request: 'x', device_id: 'd', created_at: T0 },
        { request: 'x', device_id: 'd', created_at: T0 },
        { item_id: 'a', device_id: 'd', created_at: T0 },
        { item_id: 'b', request: 'x', created_at: T0 },
        { item_id: 'c', request: 'x', device_id: 'd' },
        { item_id: 'good', request: '把逐字稿发我', device_id: 'dev-phone', created_at: T0 },
      ],
    })
    expect(got.map(one => one.item_id)).toEqual(['good'])
  })

  it('老台账里没有的那几格一律当缺席(不编一个)', () => {
    const one = parseFileDeliveryNeed({ item_id: 'a', request: 'x', device_id: 'd', created_at: T0 })
    expect(one).toEqual({ item_id: 'a', request: 'x', device_id: 'd', device_name: 'd', created_at: T0, offers: [] })
  })

  it('将来多出来的格不认得就不要(不让新版写的台账把老版弄崩)', () => {
    const one = parseFileDeliveryNeed({ item_id: 'a', request: 'x', device_id: 'd', created_at: T0, 以后加的: 1 })
    expect(one).not.toHaveProperty('以后加的')
  })

  it('整份不是对象 / 没有 needs → 空的', () => {
    expect(parseFileDeliveryFile(null)).toEqual([])
    expect(parseFileDeliveryFile([1, 2])).toEqual([])
    expect(parseFileDeliveryFile({ version: 1 })).toEqual([])
  })
})

// ───────────────────────────── ③ 被打断那一刻同样问一句 ─────────────────────────────

function doingTask(): TaskView {
  return {
    id: ITEM,
    title: '官网逐字稿发到手机',
    status: 'doing',
    direction: 'mine',
    assignee: 'dsh',
    conversation: { agent: 'dsh', session_id: 'session-d0d457fa' },
    updated_at: '2026-10-04T09:10:00.000Z',
  } as unknown as TaskView
}

describe('③ 那一轮被打断(aborted):同样问一句「送到没有」', () => {
  const abort = { kind: 'aborted' as const, ts: Math.floor(Date.parse('2026-10-04T09:19:00Z') / 1000) }

  it('★回执还没到 → 进「阻塞」,卡面既说「你停了它」也说差的是什么', () => {
    const next = itemTransitionOnSessionEnd(doingTask(), abort, undefined, {
      what: '官网逐字稿-2026-10-04.md',
      why: DELIVERY_WHY_PUSHING,
      waitingTap: false,
    })
    expect(next?.status).toBe('blocked')
    expect(next?.update.note).toBe(`${STOPPED_NOTE};${notDeliveredNote('官网逐字稿-2026-10-04.md', DELIVERY_WHY_PUSHING)}`)
    expect(next?.update.blockReason).toBe('error')
  })

  it('只差她点一下 → 「等你输入」那一档(回电按既有规矩说「等你回答」)', () => {
    const next = itemTransitionOnSessionEnd(doingTask(), abort, undefined, {
      what: 'a.md',
      why: DELIVERY_WHY_WAITING_TAP,
      waitingTap: true,
    })
    expect(next?.update.blockReason).toBe('input')
  })

  it('没有这一笔要交付的 → 照旧「待办 · 你停了它」(一个字没变)', () => {
    const next = itemTransitionOnSessionEnd(doingTask(), abort)
    expect(next).toEqual({ status: 'todo', update: { note: STOPPED_NOTE } })
  })
})

// ───────────────────────────── ① 那条路在 8791 上走一遍 ─────────────────────────────

async function serve() {
  const dir = tempDir('wb-phone-delivery-')
  const authFile = join(dir, '授权.md')
  writeFileSync(authFile, ['| 项 | 说明 | 授权 | 日期 |', '|---|---|---|---|', '', ''].join('\n'), 'utf8')
  const appConfig = createAppConfig({ file: join(dir, 'app.json') })
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const nowSec = Math.floor(T0 / 1000)
  let actor: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => nowSec }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing: createPairingService({ file: join(dir, 'devices.json'), now: () => nowSec }),
    authorization: createAuthorizationService({ file: authFile }),
    deviceDirectory: createDeviceDirectoryService(),
    tasks,
    paths: { home: dir, config: appConfig },
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    lan: lanOn(),
  })
  started.push(server)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> }
  }
  return { call, tasks, dir, as: (who: 'local' | 'phone') => { actor = who } }
}

async function untilTask(tasks: ReturnType<typeof createTasksService>, id: string, want: (one: { status: string, note?: string }) => boolean) {
  let last: { status: string, note?: string } = { status: '没有这张卡' }
  for (let i = 0; i < 50; i += 1) {
    const task = (await tasks.list()).tasks.find(one => one.id === id)
    if (task !== undefined) {
      last = { status: task.status, ...(task.note === undefined ? {} : { note: task.note }) }
      if (want(last)) return last
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return last
}

describe('POST /files/phone-delivery:电话里要的文件在看板上显形', () => {
  it('★登记一条 → 看板上多一张「还没到」的牌子,回一个单号', async () => {
    const h = await serve()
    const got = await h.call('POST', '/files/phone-delivery', {
      name: '官网逐字稿-2026-10-04.md',
      to_device: 'dev-phone',
      to_name: 'Ben 的手机',
      said: '官网逐字稿,这份文件发到我这个手机上。',
    })
    expect(got.status).toBe(200)
    expect(typeof got.body.offer).toBe('string')
    const id = got.body.item as string
    const task = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.title).toContain('官网逐字稿-2026-10-04.md')
    expect(task?.status).toBe('doing')
  })

  it('★工人报流水带着那个单号 → 卡进「完成」,卡面是「已经到你手机上了」', async () => {
    const h = await serve()
    const got = await h.call('POST', '/files/phone-delivery', { name: 'a.md', to_device: 'dev-phone', to_name: 'Ben 的手机' })
    const offer = got.body.offer as string
    const id = got.body.item as string
    const reported = await h.call('POST', '/channel/transfer', {
      record: { at: '2026-10-04T09:18:00.000Z', direction: 'out', peer: 'Ben 的手机', name: 'a.md', bytes: 2048, ok: true, by: 'butler', offer },
    })
    expect(reported.status).toBe(200)
    const task = await untilTask(h.tasks, id, one => one.status === 'done')
    expect(task.status).toBe('done')
    expect(task.note).toBe(deliveredNote('a.md', 2048))
  })

  it('★没推过去 → 卡进「阻塞」,卡面写的是工人报上来的那句原因', async () => {
    const h = await serve()
    const got = await h.call('POST', '/files/phone-delivery', { name: 'a.md', to_device: 'dev-phone', to_name: 'Ben 的手机' })
    const offer = got.body.offer as string
    const id = got.body.item as string
    await h.call('POST', '/channel/transfer', {
      record: { at: '2026-10-04T09:18:00.000Z', direction: 'out', peer: 'Ben 的手机', name: 'a.md', bytes: 0, ok: false, error: 'Ben 的手机这会儿不在房里', by: 'butler', offer },
    })
    const task = await untilTask(h.tasks, id, one => one.status === 'blocked')
    expect(task.status).toBe('blocked')
    expect(task.note).toContain('Ben 的手机这会儿不在房里')
  })

  it('老工人不带单号 → 照旧只是一条流水,不去认哪一件事(不编一个单号)', async () => {
    const h = await serve()
    const got = await h.call('POST', '/files/phone-delivery', { name: 'a.md', to_device: 'dev-phone', to_name: 'Ben 的手机' })
    const id = got.body.item as string
    await h.call('POST', '/channel/transfer', {
      record: { at: '2026-10-04T09:18:00.000Z', direction: 'out', peer: 'Ben 的手机', name: 'a.md', bytes: 2048, ok: true, by: 'butler' },
    })
    const task = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(task?.status).toBe('doing')
  })

  it('这个口只认回环(房外一律进不来,同 `/channel/transfer`)', async () => {
    const h = await serve()
    h.as('phone')
    const got = await h.call('POST', '/files/phone-delivery', { name: 'a.md', to_device: 'dev-phone', to_name: 'Ben 的手机' })
    // 没带设备令牌时在更外面那道门上就回 401;带了令牌是 403(不是回环)。两种都不是 200。
    expect([401, 403]).toContain(got.status)
  })

  it('说不出文件名 / 送到哪一台 → 不立一个送不到的牌子', async () => {
    const h = await serve()
    expect((await h.call('POST', '/files/phone-delivery', { to_device: 'dev-phone' })).status).toBe(400)
    expect((await h.call('POST', '/files/phone-delivery', { name: 'a.md' })).status).toBe(400)
  })
})
