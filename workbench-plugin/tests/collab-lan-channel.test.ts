// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPairingService } from '../src/server/devices.ts'
const servers: WorkbenchServer[] = [], dirs: string[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
async function instance() {
 const dir = mkdtempSync(join(tmpdir(), 'collab-lan-')); dirs.push(dir)
 const tasks = createTasksService({ file: join(dir, 'tasks.json') })
 await tasks.create({ title: '共同项目', projectId: 'shared-project', status: 'todo' })
 const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tasks, tickIntervalMs: 0, pairing: createPairingService({ file: join(dir, 'devices.json') }), collabWorkdir: async () => join(dir, 'work') })
 servers.push(server); return server.url
}
async function api(url: string, path: string, body?: unknown) {
 const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
 return { status: response.status, body: await response.json() as any }
}
async function pair(from: string, to: string) {
 const { body } = await api(to, '/pair/start', {})
 const identity = (await api(to, '/collab/lan/identity')).body.identity
 const result = await api(from, '/collab/lan/connect', { host: '127.0.0.1', port: Number(new URL(to).port), code: body.pairing.code, member_id: identity.member_id })
 expect(result.status).toBe(200)
 return identity.member_id as string
}
it('两受控实例真实配对后同项目消息与报告往返,重复请求不重复落账', async () => {
 const a = await instance(), b = await instance()
 const bId = await pair(a, b), aId = await pair(b, a)
 const sent = await api(a, '/collab/lan/channel/send', { project_id: 'shared-project', text: '请核对样片', recipients: [bId], client_msg_id: 'lan-once' })
 expect(sent.status).toBe(200)
 expect(sent.body.message.deliveries[0].status).toBe('delivered')
 const id = sent.body.message.id
 const incoming = await api(b, '/collab/lan/channel?project_id=shared-project')
 expect(incoming.body.messages).toHaveLength(1)
 expect(incoming.body.messages[0]).toMatchObject({ id, author: { member_id: aId }, text: '请核对样片' })
 await api(a, '/collab/lan/channel/send', { project_id: 'shared-project', text: '请核对样片', recipients: [bId], client_msg_id: 'lan-once' })
 expect((await api(b, '/collab/lan/channel?project_id=shared-project')).body.messages).toHaveLength(1)
 const report = await api(b, '/collab/lan/channel/send', { project_id: 'shared-project', text: '做完:已核样片', kind: 'report', reply_to: id, recipients: [aId], client_msg_id: 'report-once' })
 expect(report.status).toBe(200)
 const aMessages = (await api(a, '/collab/lan/channel?project_id=shared-project')).body.messages
 expect(aMessages.find((m: any) => m.id === id).deliveries[0]).toMatchObject({ status: 'accepted', receipt: { message_id: id, by: `member:${bId}` } })
 expect(JSON.stringify(aMessages)).not.toMatch(/token|Bearer/)
})
it('未配对来源不能写频道,不认识的项目与无原消息报告被拒', async () => {
 const a = await instance(), b = await instance()
 expect((await api(b, '/collab/lan/receive', { project_id: 'shared-project', text: '伪造' })).status).toBe(403)
 const bId = await pair(a, b)
 expect((await api(a, '/collab/lan/channel/send', { project_id: 'unknown', text: 'x', recipients: [bId] })).status).toBe(409)
 expect((await api(a, '/collab/lan/channel/send', { project_id: 'shared-project', text: '报告', kind: 'report', reply_to: 'missing', recipients: [bId] })).status).toBe(409)
})

it('成员邀请真正到达对端项目,原事项拿到对应报告并保留负责人', async () => {
 const a = await instance(), b = await instance()
 const bId = await pair(a, b), aId = await pair(b, a)
 const task = await api(a, '/task/create', { title: '成员共同事项', project_id: 'shared-project', assignee: 'me', from: { kind: 'user' }, acceptance: ['核对样片'], status: 'todo' })
 const asked = await api(a, '/collab/note/message', { task_id: task.body.id, text: '核对这条样片', intent: 'ask', mentions: [`member:${bId}`], client_msg_id: 'ask-lan-once' })
 expect(asked.body.message.deliveries[0].status).toBe('delivered')
 const incoming = (await api(b, '/collab/lan/channel?project_id=shared-project')).body.messages
 expect(incoming.find((m: any) => m.id === asked.body.message.id)?.text).toBe('核对这条样片')
 await api(b, '/collab/lan/channel/send', { project_id: 'shared-project', text: '卡住:缺少样片文件', kind: 'report', reply_to: asked.body.message.id, recipients: [aId] })
 const activity = (await api(a, `/collab/note/activity?id=${task.body.id}`)).body.items
 expect(activity.find((m: any) => m.type === 'message').message.deliveries[0]).toMatchObject({ status: 'accepted', receipt: { kind: 'blocked', message_id: asked.body.message.id } })
 expect((await api(a, '/state')).body.tasks.tasks.find((t: any) => t.id === task.body.id).assignee).toBe('me')
})

it('协作成员凭据只能交消息和探测身份,不能读取工作台快照', async () => {
 const b = await instance()
 const code = (await api(b, '/pair/start', {})).body.pairing.code
 const claim = await api(b, '/pair/claim', { code, device_name: 'LAN:controlled-peer', platform: 'collab-peer' })
 expect(claim.status).toBe(200)
 const response = await fetch(b + '/state', { headers: { authorization: `Bearer ${claim.body.token}` } })
 expect(response.status).toBe(403)
})
