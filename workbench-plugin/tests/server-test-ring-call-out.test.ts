// @vitest-environment node
/**
 * 「🔔 试铃」改走**真来电**(2026-09-23,Ben:「能不能自己在桌面端点击试铃」)。
 *
 * 老的 `/ring/test` 只往 `/live` 广播一条 `ring`:展示台会响,而**手机不响、听筒接不了**
 * —— 那两台听的是房间里那条 `ring`(工人从 `/call/out` 的队列领出来的),
 * 跟这条广播是两条不相干的链。桌面上按下去看着在响,抓起听筒却接不到任何东西。
 *
 * 现在按一下 = 排一通真的(`reason:'confirm'`、`title:'试铃'`),工人下一拍领走就真响。
 * 这一份钉四件事:
 *   ① 按一下**排一通**,进了台账、状态 `queued`;
 *   ② 排的是**固定的测试 id**,不借用看板上真的那一件(那会把一通真电话吃掉);
 *   ③ 再按一下**取消**这一通(还没被工人领走时);工人已经领走就如实说停不掉;
 *   ④ 主动来电没启用时**退回老的展示台广播**(那条路上还有展示台与派的 8791 老路)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveMessage } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/** 中午,不在缺省的夜间静默时段(23:00–08:00)里 —— 否则排出来的是一条静音通知。 */
const NOON = Date.parse('2026-09-23T12:00:00+08:00')

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function serve(options: { withCallOut?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-test-ring-'))
  dirs.push(dir)
  let n = 0
  const callOut = options.withCallOut === false
    ? undefined
    : createCallOutService({ file: join(dir, 'call-out.json'), now: () => NOON, newId: () => `call-${++n}` })
  await callOut?.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(NOON / 1000) }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(callOut === undefined ? {} : { callOut }),
  })
  started.push(server)
  return { server, callOut }
}

async function press(server: WorkbenchServer): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.url}/ring/test`, { method: 'POST' })
  expect(res.status).toBe(200)
  return await res.json() as Record<string, unknown>
}

describe('POST /ring/test 排一通真来电', () => {
  it('★ 按一下就排一通:台账上多一条 confirm·试铃,状态 queued', async () => {
    const { server, callOut } = await serve()

    const said = await press(server)

    expect(said).toMatchObject({ ok: true, ringing: true, call_id: 'call-1' })
    const log = callOut?.view().entries ?? []
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ id: 'call-1', reason: 'confirm', title: '试铃', state: 'queued', silent: false })
  })

  it('★ 排的是固定的测试 id:不借看板上真的那一件,否则试一次铃就吃掉一通真电话', async () => {
    const { server, callOut } = await serve()

    await press(server)

    expect(callOut?.view().entries[0]?.item_id).toBe('ring-test')
  })

  it('工人还没领走时,再按一下把这一通取消掉(它再也不会被 claim 领走)', async () => {
    const { server, callOut } = await serve()
    await press(server)

    const stopped = await press(server)

    expect(stopped).toMatchObject({ ok: true, ringing: false, canceled: true })
    expect(callOut?.view().entries[0]?.state).toBe('failed')
    // 取消掉的那一通工人再也领不到 —— 这就是「取消」在这条链上的全部含义。
    expect(await callOut?.claim(NOON)).toEqual([])
  })

  it('★ 工人已经领走(ringing)就**如实说停不掉**,不假装停掉了', async () => {
    const { server, callOut } = await serve()
    await press(server)
    await callOut?.claim(NOON)  // 工人那一拍

    const stopped = await press(server)

    expect(stopped).toMatchObject({ ok: true, ringing: false, canceled: false })
    expect(String(stopped.note)).toContain('手机上按挂断')
    // 台账一个字没动:这一通归工人收场(接了 / 未接 / 60 秒超时)。
    expect(callOut?.view().entries[0]?.state).toBe('ringing')
  })

  it('上一通早就收场了,这一按是**重新试一通**而不是空停铃', async () => {
    const { server, callOut } = await serve()
    await press(server)
    await callOut?.claim(NOON)
    await callOut?.ack({ id: 'call-1', result: 'missed' })

    const again = await press(server)

    expect(again).toMatchObject({ ok: true, ringing: true, call_id: 'call-2' })
    expect(callOut?.view().entries).toHaveLength(2)
  })

  it('不再往 /live 广播那条假 ring:屏上不许多出一行 dsh:test-ring', async () => {
    const { server } = await serve()
    const messages: LiveMessage[] = []
    const ws = new (await import('ws')).default(`${server.url.replace('http://', 'ws://')}/live`)
    ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise(resolve => ws.once('open', resolve))

    await press(server)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(messages.filter(m => m.kind === 'ring')).toEqual([])
    ws.close()
  })
})

describe('主动来电没启用时', () => {
  it('退回老的展示台广播(展示台与派的 8791 老路还在听这一条)', async () => {
    const { server } = await serve({ withCallOut: false })

    const said = await press(server)

    expect(said).toEqual({ ok: true, ringing: true })
  })
})
