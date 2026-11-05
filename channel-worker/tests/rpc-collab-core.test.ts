import { describe, expect, it } from 'vitest'
import { handleRpcRequest, parseRpcRequest } from '../src/rpc.ts'

const routes = [
  ['GET', '/collab/goal/board'], ['GET', '/collab/note/activity'],
  ['GET', '/collab/relations'], ['GET', '/collab/runs'], ['GET', '/collab/capacity'],
  ['GET', '/collab/lan/identity'], ['GET', '/collab/lan/members'], ['GET', '/collab/lan/channel'],
  ['GET', '/collab/relay/studio'], ['GET', '/collab/relay/channel'],
  ['POST', '/collab/goal/create'], ['POST', '/collab/goal/condition/save'],
  ['POST', '/collab/goal/condition/remove'], ['POST', '/collab/goal/condition/verify'],
  ['POST', '/collab/goal/condition/deliver'], ['POST', '/collab/relation/save'],
  ['POST', '/collab/relation/remove'], ['POST', '/collab/lan/identity'],
  ['POST', '/collab/lan/channel/send'], ['POST', '/task/comment'], ['POST', '/collab/note/message'],
] as const

async function request(method: string, path: string, status: number, body: unknown) {
  const calls: unknown[] = []
  const wireBody = { client_key: 'same-key', text: '受控协作留言', pass: false, note: '补证后再验' }
  const parsed = parseRpcRequest(JSON.stringify({ id: 'rpc-correlated', type: 'http', method, path, ...(method === 'POST' ? { body: wireBody } : {}) }))
  if (!parsed.ok) throw new Error(parsed.error)
  const response = await handleRpcRequest(parsed.request, {
    deviceId: 'paired-phone-readonly-or-write',
    workbench: {
      callAsDevice: async input => { calls.push(input); return { status, body } },
      renewTicket: async () => ({ error: 'unused', status: 500 }),
    },
  })
  return { calls, response, wireBody }
}

describe('固定 core 协作经生产 RPC 解析和设备代理', () => {
  it.each(routes)('%s %s 保留设备身份、原始 query/正文、HTTP 状态与错误', async (method, path) => {
    const query = method === 'GET' ? '?goal_id=qa%2B1&task_id=a%2Fb&refresh=1&after=2' : ''
    const resultBody = { ok: false, error: '真实服务冲突', current: { version: 4 } }
    const { calls, response, wireBody } = await request(method, path + query, 409, resultBody)
    expect(response).toEqual({ id: 'rpc-correlated', type: 'http', status: 409, body: resultBody })
    expect(calls).toEqual([{ deviceId: 'paired-phone-readonly-or-write', method, path: path + query, ...(method === 'POST' ? { body: wireBody } : {}) }])
  })

  const forbidden = [
    ...routes.filter(([, path]) => path !== '/collab/lan/identity').map(([method, path]) => [method === 'GET' ? 'POST' : 'GET', path]),
    ...routes.map(([method, path]) => [method, path + '/extra']),
    ['POST', '/collab/lan/connect'], ['POST', '/collab/lan/receive'],
    ['POST', '/collab/lan/members/remember'], ['POST', '/collab/lan/members/remove'],
    ['GET', '/collab/lan/peer-credentials'], ['POST', '/pair/start'], ['POST', '/pair/claim'],
    ['POST', '/collab/agent/save'], ['GET', '/collab/unknown'],
  ]
  it.each(forbidden)('%s %s 不因协作前缀或 LAN peer 权限被泛开放', async (method, path) => {
    const { calls, response } = await request(method!, path!, 200, { ok: true })
    expect(response).toMatchObject({ id: 'rpc-correlated', type: 'http', status: 403 })
    expect(calls).toEqual([])
  })

  it.each([401, 403, 404, 409, 503])('手机设备的 HTTP %i 原样返回，不提升设备权限', async status => {
    const body = { error: '设备权限或生产状态拒绝', code: 'controlled' }
    const { response } = await request('POST', '/collab/note/message', status, body)
    expect(response).toEqual({ id: 'rpc-correlated', type: 'http', status, body })
  })
})
