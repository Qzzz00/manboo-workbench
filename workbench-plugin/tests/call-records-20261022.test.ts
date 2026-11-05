// @vitest-environment node
/**
 * 通话落成记录,不再是事项(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 *
 * 维护者:「『和事务官通了电话』这个不叫事项,这是个记录或者说动作……如果只是闲聊,有必要建立吗?」
 *
 * 钉这几件:
 *   ① 一通电话 = 工作目录 `通话/` 下一份 md + `calls.json` 里一条索引(材料那一类),**看板上不多任何一张卡**;
 *   ② 同一个 call_id 报两次只落一份(后到的更全就补上),文件名不换;
 *   ③ 通话中经「电话」那一端建过 / 挪过 / 补过话的事项挂在记录上,建的那几张反过来指回这一通(`from.ref = call:<id>`);
 *   ④ 「要办」只认工人带来的那几条(通话里建卡那一下工作台连不上);她明说「记一下」却没有对得上的卡 → 只标「可能要办」,不建;
 *   ⑤ 行为账照记一条「通了电话」,她说的那几句照记「说」。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallRecordView, WorkbenchState } from '../src/protocol.ts'
import { CALL_RECORD_BODY_FIELDS, CALL_RECORD_FROM_PREFIX } from '../src/protocol.ts'
import { BEHAVIOR_EVENTS, createBehaviorLog, type BehaviorEntry } from '../src/server/behaviorLog.ts'
import {
  CALL_RECORDS_DIR_NAME,
  callRecordFileName,
  createCallRecordsService,
  maybeTodosOf,
  renderCallRecordMd,
} from '../src/server/callRecords.ts'
import { ACTOR_TOKEN_HEADER } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const AT_MS = Date.parse('2026-10-22T06:35:00.000Z')
const WORKER = { [ACTOR_TOKEN_HEADER]: 'worker-token' }

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-records-'))
  dirs.push(dir)
  return dir
}

describe('① 纯函数:文件名、正文、「可能要办」', () => {
  it('文件名 = 本地日期-时刻-call_id;id 里不该进文件名的字一律换掉', () => {
    const at = new Date(2026, 9, 22, 14, 35, 9).getTime()
    expect(callRecordFileName(at, 'call-abc')).toBe('2026-10-22-1435-call-abc.md')
    expect(callRecordFileName(at, '../etc/passwd')).toBe('2026-10-22-1435-___etc_passwd.md')
  })

  it('正文写时长、聊了什么、通话里建过 / 挪过的事项、可能要办、双方原话', () => {
    const md = renderCallRecordMd({
      id: 'call-1',
      kind: 'call',
      at: '2026-10-22T06:35:00.000Z',
      duration_seconds: 185,
      summary: '电话里:周五之前把报销交了',
      lines: 2,
      transcript: [{ who: 'me', text: '周五之前把报销交了' }, { who: 'butler', text: '记下了。' }],
      items: [{ task_id: 't-1', did: 'created', title: '周五之前把报销交了' }, { task_id: 't-2', did: 'moved', title: '导出 PDF', to: 'done' }],
      maybe_todo: ['帮我记一下下周约牙医'],
    })
    expect(md).toContain('3 分 5 秒')
    expect(md).toContain('电话里:周五之前把报销交了')
    expect(md).toContain('t-1')
    expect(md).toContain('导出 PDF')
    expect(md).toContain('可能要办')
    expect(md).toContain('帮我记一下下周约牙医')
    expect(md).toContain('我:周五之前把报销交了')
    expect(md).toContain('事务官:记下了。')
  })

  it('「可能要办」:她明说记一下、通话里又没有对得上的卡 → 标出来;对得上 / 闲聊 / 以后都算数的规矩 → 不标', () => {
    expect(maybeTodosOf([{ who: 'me', text: '帮我记一下下周约牙医' }], [])).toEqual(['帮我记一下下周约牙医'])
    expect(maybeTodosOf([{ who: 'me', text: '帮我记一下下周约牙医' }], [{ task_id: 't-1', did: 'created', title: '下周约牙医' }])).toEqual([])
    expect(maybeTodosOf([{ who: 'me', text: '今天天气不错' }, { who: 'me', text: '哈哈' }], [])).toEqual([])
    expect(maybeTodosOf([{ who: 'me', text: '以后记住别念路径' }], [])).toEqual([])
    // 事务官说的「我记下了」不是她要办的事。
    expect(maybeTodosOf([{ who: 'butler', text: '好,我记一下' }], [])).toEqual([])
  })
})

describe('② 服务:一通一份文件 + 一条索引', () => {
  it('落在 <工作目录>/通话/;同一个 id 再落一次就地更新,文件名不换', async () => {
    const dir = tempDir()
    const workdir = join(dir, 'repo')
    const records = createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => workdir, fallbackDir: join(dir, 'fallback'), now: () => AT_MS })
    const first = await records.put({ id: 'call-1', kind: 'call', at: new Date(AT_MS).toISOString(), summary: '电话里:甲', lines: 1, transcript: [{ who: 'me', text: '甲' }], items: [] })
    expect(first.ok).toBe(true)
    const file = first.ok ? first.record.file : undefined
    expect(file).toBeDefined()
    expect(file!.startsWith(join(workdir, CALL_RECORDS_DIR_NAME))).toBe(true)
    expect(readFileSync(file!, 'utf8')).toContain('我:甲')

    const again = await records.put({ id: 'call-1', kind: 'call', at: new Date(AT_MS + 60_000).toISOString(), summary: '电话里:甲;乙', lines: 2, transcript: [{ who: 'me', text: '甲' }, { who: 'me', text: '乙' }], items: [] })
    expect(again.ok && again.record.file).toBe(file)
    expect(readdirSync(join(workdir, CALL_RECORDS_DIR_NAME))).toHaveLength(1)
    expect(readFileSync(file!, 'utf8')).toContain('我:乙')
    const view = await records.view()
    expect(view.recent.map(one => one.id)).toEqual(['call-1'])
    expect(view.dir).toBe(join(workdir, CALL_RECORDS_DIR_NAME))
  })

  it('没配工作目录 → 落在工作台自己的数据目录里,不丢这一通', async () => {
    const dir = tempDir()
    const records = createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => undefined, fallbackDir: join(dir, 'fallback'), now: () => AT_MS })
    const put = await records.put({ id: 'call-2', kind: 'call', at: new Date(AT_MS).toISOString(), summary: '电话里:甲', lines: 1, transcript: [{ who: 'me', text: '甲' }], items: [] })
    expect(put.ok && put.record.file!.startsWith(join(dir, 'fallback'))).toBe(true)
  })

  it('最新的在前', async () => {
    const dir = tempDir()
    let now = AT_MS
    const records = createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => dir, fallbackDir: join(dir, 'fallback'), now: () => now })
    await records.put({ id: 'a', kind: 'call', at: new Date(now).toISOString(), summary: 'a', lines: 0, transcript: [], items: [] })
    now += 60_000
    await records.put({ id: 'b', kind: 'call', at: new Date(now).toISOString(), summary: 'b', lines: 0, transcript: [], items: [] })
    expect((await records.view()).recent.map(one => one.id)).toEqual(['b', 'a'])
  })
})

describe('③ POST /butler/call/record:落记录,不建卡', () => {
  async function serve() {
    const dir = tempDir()
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
    const behaviorLog = createBehaviorLog({ dir: join(dir, '行为账') })
    const workdir = join(dir, 'repo')
    let id = 0
    const callRecords = createCallRecordsService({ file: join(dir, 'calls.json'), workdir: () => workdir, fallbackDir: join(dir, 'fallback'), newId: () => `call-gen-${++id}` })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      tasks,
      behaviorLog,
      callRecords,
      actorTokens: { butler: 'butler-token', worker: 'worker-token' },
    })
    started.push(server)
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
      const text = await res.text()
      return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
    }
    const state = async (): Promise<WorkbenchState> => await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    const entries = async (): Promise<BehaviorEntry[]> => { await behaviorLog.flush(); return behaviorLog.read({}) }
    return { post, state, tasks, entries, workdir }
  }

  it('闲聊那一通:看板上一张卡都不多,通话记录多一份(文件也在)', async () => {
    const t = await serve()
    const res = await t.post('/butler/call/record', {
      call_id: 'call-chat',
      durationSeconds: 40,
      transcript: [{ who: 'butler', text: '在呢。' }, { who: 'me', text: '今天天气不错' }, { who: 'butler', text: '是啊,适合出去走走。' }],
    }, WORKER)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: 'call-chat' })
    const state = await t.state()
    expect(state.tasks?.tasks ?? []).toHaveLength(0)
    const recent = state.calls?.recent ?? []
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ id: 'call-chat', kind: 'call', duration_seconds: 40, lines: 3, items: [] })
    expect(recent[0]!.summary).toContain('今天天气不错')
    expect(recent[0]!.transcript).toHaveLength(3)
    expect(existsSync(recent[0]!.file!)).toBe(true)
    expect(recent[0]!.file!.startsWith(join(t.workdir, CALL_RECORDS_DIR_NAME))).toBe(true)
  })

  it('不带 call_id 的老手机:照旧落一份(编号由工作台给),不去猜是不是刚才那一通', async () => {
    const t = await serve()
    await t.post('/butler/call/record', { durationSeconds: 10, transcript: [{ who: 'me', text: '甲' }] }, WORKER)
    await t.post('/butler/call/record', { durationSeconds: 10, transcript: [{ who: 'me', text: '甲' }] }, WORKER)
    const recent = (await t.state()).calls?.recent ?? []
    expect(recent.map(one => one.id).sort()).toEqual(['call-gen-1', 'call-gen-2'])
  })

  it('什么都没有的空包 → 不落(那不是一通电话)', async () => {
    const t = await serve()
    const res = await t.post('/butler/call/record', {}, WORKER)
    expect(res.body).toMatchObject({ ok: true, skipped: true })
    expect((await t.state()).calls?.recent ?? []).toHaveLength(0)
  })

  it('同一个 call_id 两边都报:只一份;后到的更全就补上', async () => {
    const t = await serve()
    const first = await t.post('/butler/call/record', { call_id: 'call-2', durationSeconds: 30, transcript: [{ who: 'butler', text: '有一件事等你确认。' }] }, WORKER)
    const second = await t.post('/butler/call/record', {
      call_id: 'call-2',
      durationSeconds: 30,
      transcript: [{ who: 'butler', text: '有一件事等你确认。' }, { who: 'me', text: '那件就按你说的办' }],
    }, WORKER)
    expect(first.body.id).toBe('call-2')
    expect(second.body).toMatchObject({ ok: true, id: 'call-2', deduped: true, merged: true })
    const recent = (await t.state()).calls?.recent ?? []
    expect(recent).toHaveLength(1)
    expect(recent[0]!.transcript).toHaveLength(2)
    const less = await t.post('/butler/call/record', { call_id: 'call-2', durationSeconds: 30, transcript: [] }, WORKER)
    expect(less.body).toMatchObject({ deduped: true, merged: false })
    expect((await t.state()).calls?.recent[0]!.transcript).toHaveLength(2)
    expect((await t.state()).tasks?.tasks ?? []).toHaveLength(0)
  })

  it('通话里工人建的卡、挪的卡挂在记录上;建的那张指回这一通', async () => {
    const t = await serve()
    const before = await t.tasks.create({ title: '导出 PDF', direction: 'mine', status: 'confirm' })
    // 通话里:工人(电话那一端)建一张、挪一张。
    const made = await t.post('/task/create', { title: '周五之前把报销交了', source: { kind: 'session', ref: '电话' } }, WORKER)
    expect(made.status).toBe(200)
    expect((await t.post('/task/move', { id: before.id, status: 'done' }, WORKER)).status).toBe(200)
    // 页面上她自己在电脑上建的那张不算这一通的。
    await t.post('/task/create', { title: '电脑上建的' }, { origin: 'http://127.0.0.1:3080' })

    const res = await t.post('/butler/call/record', {
      call_id: 'call-3',
      durationSeconds: 60,
      transcript: [{ who: 'me', text: '帮我记一下周五之前把报销交了' }, { who: 'me', text: '导出 PDF 那件通过' }],
    }, WORKER)
    expect(res.status).toBe(200)
    const record = (await t.state()).calls!.recent[0] as CallRecordView
    expect(record.items).toEqual([
      { task_id: made.body.id, did: 'created', title: '周五之前把报销交了' },
      { task_id: before.id, did: 'moved', title: '导出 PDF', to: 'done' },
    ])
    // 记一下那一句对得上建好的那张卡 → 不算「可能要办」。
    expect(record.maybe_todo ?? []).toEqual([])
    const tasks = (await t.state()).tasks?.tasks ?? []
    // 看板上还是那三张:没有多出一张「纪要卡」。
    expect(tasks).toHaveLength(3)
    const linked = tasks.find(one => one.id === made.body.id)!
    expect(linked.from).toEqual({ kind: 'said', ref: `${CALL_RECORD_FROM_PREFIX}call-3` })
  })

  it('她明说「记一下」可是通话里没建成 → 不建卡,记录上标「可能要办」', async () => {
    const t = await serve()
    await t.post('/butler/call/record', {
      call_id: 'call-4',
      durationSeconds: 20,
      transcript: [{ who: 'me', text: '帮我记一下下周约牙医' }, { who: 'butler', text: '好。' }],
    }, WORKER)
    const state = await t.state()
    expect(state.tasks?.tasks ?? []).toHaveLength(0)
    expect(state.calls!.recent[0]!.maybe_todo).toEqual(['帮我记一下下周约牙医'])
  })

  it('工人带来的「要办」(通话里建卡那一下工作台连不上)→ 按建卡那一套补建,指回这一通', async () => {
    const t = await serve()
    const res = await t.post('/butler/call/record', {
      call_id: 'call-5',
      durationSeconds: 20,
      transcript: [{ who: 'me', text: '帮我记一下下周约牙医' }],
      todos: [{ title: '下周约牙医', desc: '帮我记一下下周约牙医' }, { title: '   ' }],
    }, WORKER)
    expect(res.status).toBe(200)
    const state = await t.state()
    const tasks = state.tasks?.tasks ?? []
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: '下周约牙医', from: { kind: 'said', ref: `${CALL_RECORD_FROM_PREFIX}call-5` } })
    expect(tasks[0]!.source).toEqual({ kind: 'session', ref: '电话' })
    expect(state.calls!.recent[0]!.items).toEqual([{ task_id: tasks[0]!.id, did: 'created', title: '下周约牙医' }])
    expect(state.calls!.recent[0]!.maybe_todo ?? []).toEqual([])
    // 同一通再报一次(手机那份),不再建第二张。
    await t.post('/butler/call/record', { call_id: 'call-5', durationSeconds: 20, transcript: [{ who: 'me', text: '帮我记一下下周约牙医' }], todos: [{ title: '下周约牙医' }] }, WORKER)
    expect((await t.state()).tasks?.tasks ?? []).toHaveLength(1)
  })

  it('行为账:一条「通了电话」+ 她说的每一句「说」;同一通后到的那份不重记', async () => {
    const t = await serve()
    const body = { call_id: 'call-6', durationSeconds: 30, transcript: [{ who: 'butler', text: '早' }, { who: 'me', text: '先说第一件' }] }
    await t.post('/butler/call/record', body, WORKER)
    await t.post('/butler/call/record', { ...body, transcript: [...body.transcript, { who: 'me', text: '好' }] }, WORKER)
    const all = await t.entries()
    expect(all.filter(e => e.事 === BEHAVIOR_EVENTS.talk)).toEqual([expect.objectContaining({ 端: '电话', 对象: '通话 call-6' })])
    expect(all.filter(e => e.事 === BEHAVIOR_EVENTS.say).map(e => `${e.对象}:${e.原话}`)).toEqual(['通话 call-6:先说第一件'])
  })

  it('引导那一通:落一份引导记录,不落字幕', async () => {
    const t = await serve()
    await t.post('/butler/call/record', { kind: 'onboarding', durationSeconds: 27 * 60, transcript: [{ who: 'me', text: '不该落下的一句' }] }, WORKER)
    const record = (await t.state()).calls!.recent[0]!
    expect(record).toMatchObject({ kind: 'onboarding', duration_seconds: 27 * 60, transcript: [] })
    expect(readFileSync(record.file!, 'utf8')).not.toContain('不该落下的一句')
    expect((await t.state()).tasks?.tasks ?? []).toHaveLength(0)
  })

  it('通话记录没接线 → 404,不假装写下了', async () => {
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)
    const res = await fetch(`${server.url}/butler/call/record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('④ 请求体字段表(三端对照的源头)', () => {
  it('五格:call_id / durationSeconds / transcript / kind / todos', () => {
    expect([...CALL_RECORD_BODY_FIELDS]).toEqual(['call_id', 'durationSeconds', 'transcript', 'kind', 'todos'])
  })
})
