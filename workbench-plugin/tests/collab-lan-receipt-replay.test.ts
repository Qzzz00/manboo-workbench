// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPairingService } from '../src/server/devices.ts'

const servers: WorkbenchServer[] = [], dirs: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function instance(existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'collab-receipt-replay-'))
  if (existingDir === undefined) dirs.push(dir)
  const file = join(dir, 'tasks.json')
  const tasks = createTasksService({ file })
  const server = await startWorkbenchServer({ port: 0, tasks, service: createWorkbenchService(), tickIntervalMs: 0,
    pairing: createPairingService({ file: join(dir, 'devices.json') }), collabWorkdir: async () => join(dir, 'work') })
  servers.push(server)
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as any }
  }
  const close = async () => { await server.close(); servers.splice(servers.indexOf(server), 1) }
  return { api, close, dir, file, url: server.url }
}
async function pairedReport() {
  const receiver = await instance(), peer = await instance()
  const peerId = (await peer.api('/collab/lan/identity')).body.identity.member_id
  const selfId = (await receiver.api('/collab/lan/identity')).body.identity.member_id
  const code = (await receiver.api('/pair/start', {})).body.pairing.code
  const claim = await receiver.api('/pair/claim', { code, device_name: `LAN:${peerId}`, platform: 'collab-peer' })
  expect(claim.status).toBe(200)
  const token = claim.body.token as string
  expect((await peer.api('/task/create', { title: '同项目接收端', project_id: 'receipt-d1', status: 'todo' })).status).toBe(200)
  const peerCode = (await peer.api('/pair/start', {})).body.pairing.code
  expect((await receiver.api('/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(peer.url).port), member_id: peerId, code: peerCode })).status).toBe(200)
  const task = await receiver.api('/task/create', { title: '运输回执核对', project_id: 'receipt-d1', status: 'todo', assignee: 'me' })
  expect(task.status).toBe(200)
  const invitation = await receiver.api('/collab/note/message', { task_id: task.body.id, text: '请核对材料', intent: 'ask', mentions: [`member:${peerId}`] })
  expect(invitation.status).toBe(200)
  const report = { id: 'd1-report', project_id: 'receipt-d1', author: { member_id: peerId, name: '受控成员' }, kind: 'report',
    reply_to: invitation.body.message.id, text: '卡住:缺少材料', at: '2026-01-01T00:00:00.000Z' }
  const receive = (message: unknown = report) => receiver.api('/collab/lan/receive', { message }, token)
  return { receiver, peer, selfId, report, receive, token, taskId: task.body.id }
}

it('D1 同包 HTTP 重试完整回放首次运输回执,原业务事实和文件不重写', async () => {
  const f = await pairedReport()
  const first = await f.receive()
  expect(first.status).toBe(200)
  expect(first.body.receipt).toEqual({ message_id: f.report.id, member_id: f.selfId, at: expect.any(String) })
  expect(first.body.receipt.at).not.toBe(f.report.at)
  const before = readFileSync(f.receiver.file, 'utf8')
  await setTimeout(20)
  const retry = await f.receive()
  expect(retry.status).toBe(200)
  expect(retry.body).toEqual(first.body)
  expect(readFileSync(f.receiver.file, 'utf8')).toBe(before)
  const state = (await f.receiver.api('/state')).body.tasks.tasks
  expect(state.find((t: any) => t.id === f.taskId).messages[0].deliveries[0].receipt.kind).toBe('blocked')
})

it('D1 回执持久化跨服务重建保持原 at,不依赖 transport 内存', async () => {
  const f = await pairedReport(), first = await f.receive()
  expect(first.status).toBe(200)
  await f.receiver.close()
  await setTimeout(20)
  const restarted = await instance(f.receiver.dir)
  const retry = await restarted.api('/collab/lan/receive', { message: f.report }, f.token)
  expect(retry.status).toBe(200)
  expect(retry.body).toEqual(first.body)
})

it('D1 并发首包与重包共用原写事务的唯一运输回执', async () => {
  const f = await pairedReport()
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.receive()))
  for (const response of responses) {
    expect(response.status).toBe(200)
    expect(response.body).toEqual(responses[0]!.body)
  }
  const messages = (await f.receiver.api('/collab/lan/channel?project_id=receipt-d1')).body.messages
  expect(messages.filter((m: any) => m.id === f.report.id)).toHaveLength(1)
})

it('D1 同 ID 换正文或 reply_to 仍409且文件零副作用,合法原包仍回原回执', async () => {
  const f = await pairedReport(), first = await f.receive()
  expect(first.status).toBe(200)
  const other = await f.receiver.api('/collab/lan/channel/send', { project_id: 'receipt-d1', text: '另一邀请', recipients: [f.report.author.member_id] })
  expect(other.status).toBe(200)
  const before = readFileSync(f.receiver.file, 'utf8')
  for (const change of [{ text: '做完:已齐备' }, { reply_to: other.body.message.id }]) {
    expect((await f.receive({ ...f.report, ...change })).status).toBe(409)
    expect(readFileSync(f.receiver.file, 'utf8')).toBe(before)
  }
  expect((await f.receive()).body).toEqual(first.body)
})

it('D1 普通消息同样稳定重放,只接受本机回执且公共频道不暴露存储元数据', async () => {
  const f = await pairedReport()
  const message = { ...f.report, id: 'ordinary-message', kind: 'message', reply_to: undefined,
    transport_receipt: { message_id: 'ordinary-message', member_id: 'forged', at: f.report.at },
    deliveries: [{ to: f.selfId, status: 'accepted', at: f.report.at }] }
  const first = await f.receive(message)
  expect(first.status).toBe(200)
  expect(first.body.receipt.member_id).toBe(f.selfId)
  expect(first.body.receipt.at).not.toBe(f.report.at)
  const channel = (await f.receiver.api('/collab/lan/channel?project_id=receipt-d1')).body.messages
  const stored = channel.find((m: any) => m.id === message.id)
  expect(stored).not.toHaveProperty('transport_receipt')
  expect(stored).not.toHaveProperty('deliveries')
  // 另一次正常写入也必须经读盘/净化后保留回执。
  expect((await f.receiver.api('/task/create', { title: '无关正常写入', status: 'todo' })).status).toBe(200)
  await setTimeout(20)
  expect((await f.receive(message)).body).toEqual(first.body)
})

it('D1 旧文件未记录运输回执时补记首次确认,不重做报告或倒退后来done', async () => {
  const f = await pairedReport()
  expect((await f.receive()).status).toBe(200)
  expect((await f.receive({ ...f.report, id: 'later-report', text: '做完:材料已齐备' })).status).toBe(200)
  // 仅构造升级前已有消息但无运输回执的文件,不冒充新执行。
  const data = JSON.parse(readFileSync(f.receiver.file, 'utf8'))
  delete data.lan_messages.find((m: any) => m.id === f.report.id).transport_receipt
  writeFileSync(f.receiver.file, JSON.stringify(data))
  const beforeChannel = (await f.receiver.api('/collab/lan/channel?project_id=receipt-d1')).body
  const first = await f.receive()
  expect(first.status).toBe(200)
  expect(JSON.parse(readFileSync(f.receiver.file, 'utf8')).tasks).toEqual(data.tasks)
  expect((await f.receiver.api('/collab/lan/channel?project_id=receipt-d1')).body).toEqual(beforeChannel)
  const after = readFileSync(f.receiver.file, 'utf8')
  await setTimeout(20)
  expect((await f.receive()).body).toEqual(first.body)
  expect(readFileSync(f.receiver.file, 'utf8')).toBe(after)
  const state = (await f.receiver.api('/state')).body.tasks.tasks
  expect(state.find((t: any) => t.id === f.taskId).messages[0].deliveries[0].receipt.kind).toBe('done')
})
