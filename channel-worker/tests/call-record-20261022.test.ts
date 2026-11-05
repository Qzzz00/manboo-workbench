/**
 * 通话落成记录(2026-10-22,决策记录同日「通电话是记录不是事项」)工人这一侧:
 *
 *   ① 报给 8791 的那几格与工作台 `CALL_RECORD_BODY_FIELDS` 同名(读源文件比对,不写「逐字相同」注释代替测试);
 *   ② 每一通都有编号:来电用台账上的 id;他拨出去的用手机 `start` 带来的那个;都没有就工人自己编一个;
 *   ③ 通话里建卡那一下**工作台连不上**的那几张 = 「要办」,跟着记录一起交(`todos`);
 *      这一通归手机报时,工人有没建成的「要办」也补报一份(带同一个 call_id,8791 并成一份);
 *   ④ 手机 `start` 带的 call_id 一路交到 `greet`。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CALL_RECORD_PAYLOAD_FIELDS,
  createCallRecorder,
  unsavedTodoOf,
  watchUnsavedCards,
  type CallRecordPayload,
} from '../src/callRecord.ts'
import { handleRpcRequest, parseRpcRequest, type RpcCallPort, type RpcWorkbenchPort } from '../src/rpc.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

const PLUGIN = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8')

function recorder() {
  const sent: CallRecordPayload[] = []
  let clock = 0
  let n = 0
  const it = createCallRecorder({
    report: async (payload) => { sent.push(payload); return true },
    now: () => clock,
    newId: () => `call-w-${++n}`,
  })
  return { it, sent, tick: (ms: number) => { clock += ms } }
}

describe('① 字段表与工作台同名', () => {
  it('CALL_RECORD_PAYLOAD_FIELDS === 工作台 CALL_RECORD_BODY_FIELDS', () => {
    const raw = /export const CALL_RECORD_BODY_FIELDS = \[([^\]]+)\] as const/.exec(PLUGIN)?.[1]
    expect(raw).toBeDefined()
    const plugin = [...raw!.matchAll(/'([^']+)'/g)].map(m => m[1])
    expect([...CALL_RECORD_PAYLOAD_FIELDS]).toEqual(plugin)
  })

  it('真发出去的那一份只用表里的字', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-1', report: true })
    t.it.add('me', '喂')
    t.it.unsaved({ title: '下周约牙医' })
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    for (const key of Object.keys(t.sent[0]!)) expect(CALL_RECORD_PAYLOAD_FIELDS as readonly string[]).toContain(key)
  })
})

describe('② 每一通都有编号', () => {
  it('他拨出去的那一通没带编号 → 工人自己编一个,报的时候带上', async () => {
    const t = recorder()
    t.it.start({ report: true })
    t.it.add('me', '帮我看一下')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.call_id).toBe('call-w-1')
  })

  it('带了就用带来的那个', async () => {
    const t = recorder()
    t.it.start({ callId: 'ph-abc', report: true })
    t.it.add('me', '帮我看一下')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.call_id).toBe('ph-abc')
  })
})

describe('③ 没建成的「要办」跟着记录走', () => {
  it('只有「工作台连不上」才算;没标题、被拒、建成了都不算', () => {
    expect(unsavedTodoOf({ title: '下周约牙医', desc: '帮我记一下下周约牙医' }, { ok: false, text: 'x', unreachable: true }))
      .toEqual({ title: '下周约牙医', desc: '帮我记一下下周约牙医' })
    expect(unsavedTodoOf({ title: '需求', desc: '要做成什么样', feature: true }, { ok: false, text: 'x', unreachable: true }))
      .toEqual({ title: '需求', desc: '要做成什么样', feature: true })
    expect(unsavedTodoOf({ title: '  ' }, { ok: false, text: 'x', unreachable: true })).toBeUndefined()
    expect(unsavedTodoOf({ title: '下周约牙医' }, { ok: false, text: '工作台不让写' })).toBeUndefined()
    expect(unsavedTodoOf({ title: '下周约牙医' }, { ok: true, text: '建好了' })).toBeUndefined()
  })

  it('工人报的那一通:todos 跟着走', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-2', report: true })
    t.it.add('me', '帮我记一下下周约牙医')
    t.it.unsaved({ title: '下周约牙医', desc: '帮我记一下下周约牙医' })
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.todos).toEqual([{ title: '下周约牙医', desc: '帮我记一下下周约牙医' }])
  })

  it('归手机报的那一通:有没建成的「要办」→ 工人也补报一份(同一个 call_id);没有就不报', async () => {
    const t = recorder()
    t.it.start({ callId: 'ph-1', report: false })
    t.it.add('me', '帮我记一下下周约牙医')
    t.it.unsaved({ title: '下周约牙医' })
    t.tick(10_000)
    t.it.finish()
    t.it.start({ callId: 'ph-2', report: false })
    t.it.add('me', '今天天气不错')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent.map(one => one.call_id)).toEqual(['ph-1'])
    expect(t.sent[0]!.todos).toEqual([{ title: '下周约牙医' }])
  })

  it('没在通话里时那一笔丢掉(不是哪一通的事)', async () => {
    const t = recorder()
    t.it.unsaved({ title: '下周约牙医' })
    t.it.start({ callId: 'call-3', report: true })
    t.it.add('me', '喂')
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.todos).toBeUndefined()
  })

  it('建卡那一下连不上工作台 → 回包带 unreachable;工作台拒了不带', async () => {
    const down = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch })
    expect(await down.createTask({ title: '下周约牙医' })).toMatchObject({ ok: false, unreachable: true })
    expect(await down.rememberItem('帮我把报价单发给客户')).toMatchObject({ ok: false, unreachable: true })
    const refused = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => new Response(JSON.stringify({ error: '不让写' }), { status: 403 })) as unknown as typeof fetch })
    const got = await refused.createTask({ title: '下周约牙医' })
    expect(got.ok).toBe(false)
    expect('unreachable' in got).toBe(false)
  })
})

describe('③′ 通话里那几件工具用的工作台', () => {
  it('建卡连不上 → 记一张;建成了 → 不记;别的方法原样', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-9', report: true })
    const base = {
      createTask: async (input: { title: string }) => (input.title === '连不上' ? { ok: false, text: 'x', unreachable: true as const } : { ok: true, text: '建好了' }),
      rememberItem: async (_text: string) => ({ ok: false, text: 'x', unreachable: true as const }),
      other() { return this.createTask({ title: '经 this 调的' }) },
    }
    const watched = watchUnsavedCards(base, t.it, text => text.slice(0, 4))
    await watched.createTask({ title: '连不上' })
    await watched.createTask({ title: '建得上' })
    await watched.rememberItem('帮我把报价单发给客户')
    expect(await watched.other()).toEqual({ ok: true, text: '建好了' })
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.todos).toEqual([{ title: '连不上' }, { title: '帮我把报', desc: '帮我把报价单发给客户' }])
  })
})

describe('③b 理解中枢执行口(A2):连不上时记 / 派的那几条照样记成没建成的「要办」', () => {
  it('note / dispatch 连不上 → 记;办成的、答护栏那一问的、别的命令 → 不记', async () => {
    const t = recorder()
    t.it.start({ callId: 'call-10', report: true })
    let up = false
    const base = {
      createTask: async () => ({ ok: true, text: '' }),
      rememberItem: async () => ({ ok: true, text: '' }),
      hubExecute: async (_input: unknown) => (up ? { ok: true as const, reply: { say_id: 's', results: [], say: { screen: '', spoken: '' } } } : { ok: false as const, why: '工作台连不上', unreachable: true as const }),
    }
    const watched = watchUnsavedCards(base, t.it, text => text.slice(0, 4))
    await watched.hubExecute!({ said: '记一下周四发样片', commands: [{ name: 'note', title: '周四发样片', status: 'todo' }] })
    await watched.hubExecute!({ said: '让小K查热点', commands: [{ name: 'dispatch', new: { title: '查 8791 热点' }, text: '查 8791 空转热点' }] })
    await watched.hubExecute!({ said: '取消它', commands: [{ name: 'cancel', card_id: 't-1' }] })
    await watched.hubExecute!({ said: '好', confirmed: { ask_id: 'a', choice: '好' } })
    up = true
    await watched.hubExecute!({ said: '记一下别的', commands: [{ name: 'note', title: '别的', status: 'todo' }] })
    t.tick(10_000)
    t.it.finish()
    await Promise.resolve()
    expect(t.sent[0]!.todos).toEqual([{ title: '周四发样片', desc: '记一下周四发样片' }, { title: '查 8791 热点', desc: '让小K查热点' }])
  })
})

describe('④ 手机 start 带的 call_id 交到 greet', () => {
  const workbench: RpcWorkbenchPort = {
    callAsDevice: async () => ({ status: 200, body: {} }),
    renewTicket: async () => ({ token: 't', expires_at: 1 }),
  }

  it('parse 留着它;handle 交给 greet', async () => {
    expect(parseRpcRequest(JSON.stringify({ id: '1', type: 'call', action: 'start', call_id: 'ph-9' })))
      .toEqual({ ok: true, request: { id: '1', type: 'call', action: 'start', call_id: 'ph-9' } })
    const port: RpcCallPort = { greet: vi.fn(async () => ({ ok: true })), answer: async () => ({ ok: true }), later: async () => ({ ok: true }) }
    await handleRpcRequest({ id: 'a', type: 'call', action: 'start', call_id: 'ph-9' }, { deviceId: 'd', workbench, call: port })
    expect(port.greet).toHaveBeenCalledWith(undefined, 'ph-9')
    await handleRpcRequest({ id: 'b', type: 'call', action: 'start' }, { deviceId: 'd', workbench, call: port })
    // 老手机不带:照老样子只交 by(老的那几条用例照旧对得上)。
    expect(port.greet).toHaveBeenLastCalledWith(undefined)
  })
})
