// @vitest-environment node
/**
 * 壳的系统通知到底弹没弹(2026-09-25,卡 M 补;统筹:以前这一路是「静默失败」—— 服务端 `.catch(() => {})` 吞了、
 * 壳里 `center.add { _ in }` 也不看错误,维护者点了「允许」却一条都没看到,谁也说不清为什么)。
 * 壳每读到一次授权、每交一条给系统回一条 `notify_status`;/state.helper.notify 看得到;服务端这一头没交出去的也记下。
 */
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { WorkbenchState } from '../src/protocol.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createHelperChannel, parseNotifyStatus } from '../src/server/helperChannel.ts'
import { notifyTrouble } from '../src/client/askModel.ts'

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function shell() {
  const helper = createHelperChannel()
  const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, helper })
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/helper`)
  await new Promise(r => ws.on('open', r))
  ws.send(JSON.stringify({ kind: 'hello', role: 'helper', authorized: true, version: '1' }))
  await until(() => helper.view().authorized)
  const state = async (): Promise<WorkbenchState> => await (await fetch(`${server.url}/state`)).json() as WorkbenchState
  return { helper, server, ws, state }
}

describe('/state.helper.notify:三种授权各是什么', () => {
  it('★没问过 → not_determined;允许了、交了一条系统收下 → allowed + last_post ok;没允许 → denied + 那一条没弹的原话', async () => {
    const { server, ws, state } = await shell()
    expect((await state()).helper?.notify).toBeUndefined()

    ws.send(JSON.stringify({ kind: 'notify_status', permission: 'not_determined', at: '2026-09-25T11:21:02Z' }))
    await until(async () => (await state()).helper?.notify?.permission === 'not_determined')
    expect((await state()).helper?.notify).toEqual({ permission: 'not_determined' })

    ws.send(JSON.stringify({ kind: 'notify_status', permission: 'allowed', key: 'question:q-1', ok: true, at: '2026-09-25T11:21:21Z' }))
    await until(async () => (await state()).helper?.notify?.permission === 'allowed')
    expect((await state()).helper?.notify).toEqual({ permission: 'allowed', last_post: { key: 'question:q-1', at: '2026-09-25T11:21:21Z', ok: true } })
    expect(notifyTrouble((await state()).helper)).toBeUndefined()

    ws.send(JSON.stringify({ kind: 'notify_status', permission: 'denied', key: 'question:q-2', ok: false, error: '系统没让工作台发通知', at: '2026-09-25T11:29:22Z' }))
    await until(async () => (await state()).helper?.notify?.permission === 'denied')
    const denied = (await state()).helper
    expect(denied?.notify).toEqual({ permission: 'denied', last_post: { key: 'question:q-2', at: '2026-09-25T11:29:22Z', ok: false, error: '系统没让工作台发通知' } })
    expect(notifyTrouble(denied)).toEqual({ text: '系统没让我弹通知:去系统设置 → 通知里打开「工作台」', settings: true })
    ws.close(); await server.close()
  })

  it('只报授权(没有 key)时,上一次交的那一条留着', async () => {
    const { server, ws, state } = await shell()
    ws.send(JSON.stringify({ kind: 'notify_status', permission: 'allowed', key: 'k', ok: true, at: 'x' }))
    await until(async () => (await state()).helper?.notify?.last_post?.key === 'k')
    ws.send(JSON.stringify({ kind: 'notify_status', permission: 'allowed' }))
    await new Promise(r => setTimeout(r, 50))
    expect((await state()).helper?.notify?.last_post?.key).toBe('k')
    ws.close(); await server.close()
  })

  it('坏帧(授权那个词认不出)整条丢,不猜', () => {
    expect(parseNotifyStatus({ kind: 'notify_status', permission: 'maybe' })).toBeUndefined()
    expect(parseNotifyStatus({ kind: 'notify_status', permission: 'allowed', key: '', ok: 'yes' })).toEqual({ kind: 'notify_status', permission: 'allowed' })
  })

  it('服务端这一头没交到壳手上(老壳不认 notify):记成那一条没弹、说清要换壳,不指去系统设置', () => {
    const helper = createHelperChannel()
    helper.recordNotify?.({ key: 'question:q-9', ok: false, error: '这一版壳不会弹系统通知(要换新壳)' })
    expect(helper.view().notify).toEqual({ permission: 'unknown', last_post: { key: 'question:q-9', at: expect.any(String), ok: false, error: '这一版壳不会弹系统通知(要换新壳)' } })
    expect(notifyTrouble(helper.view())).toEqual({ text: '我弹不了系统通知:这一版壳不会弹系统通知(要换新壳)', settings: false })
  })
})
