/**
 * 协作区跨机那几条 8791 路由(2026-10-21,`collabRelay.ts`)。**接缝**:8791 接口(主人 = 统筹),全是新路径。
 *
 * | 路由 | 做什么 |
 * |---|---|
 * | `GET  /collab/relay/studio` | `{state:'unwired'|'offline'|'none'|'joined', why?, me?, workspace?, members?, channels?}` |
 * | `POST /collab/relay/studio/create\|invite\|join\|role\|remove` | 工作室(要账号会话令牌,没有 409) |
 * | `GET  /collab/relay/channel?id=`、`POST /collab/relay/channel/say` | 频道快照 / 发一句 |
 * | `GET  /collab/relay/agents`、`POST /collab/relay/agents/share` | 工作室里的 Agent 名片 / 把本机名片登记上去 |
 * | `POST /collab/relay/borrow` | 用别人的 Agent(发请求,等主人批) |
 * | `GET  /collab/relay/asks`、`POST /collab/relay/asks/answer` | 别人想用我的 Agent:待批 / 批或拒 |
 * | `POST /collab/relay/webhook`、`/collab/relay/webhook/rotate` | 定时派活的回调地址 |
 * | `POST /collab/relay/wecom/code`、`GET /collab/relay/wecom`、`POST /collab/relay/wecom/remove` | 企微群绑定 |
 *
 * 看与发一句、借用:本机或配对过的手机都行;管工作室、批借用、开回调地址、企微、登记名片:只认这台电脑上的页面点的。
 */
import type { CollabChannelRef, WorkspaceRole } from '../protocol.ts'
import { WORKSPACE_ROLES } from '../protocol.ts'
import type { CollabRelay, RelayAnswer } from './collabRelay.ts'
import type { CollabRouteContext } from './collabRoutes.ts'

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** 只认这台电脑上页面点的那几条。 */
const PAGE_ONLY = new Set([
  '/collab/relay/studio/create', '/collab/relay/studio/invite', '/collab/relay/studio/join', '/collab/relay/studio/role', '/collab/relay/studio/remove',
  '/collab/relay/asks/answer', '/collab/relay/agents/share',
  '/collab/relay/webhook', '/collab/relay/webhook/rotate',
  '/collab/relay/wecom/code', '/collab/relay/wecom/remove',
])

export function createCollabRelayRoutes(deps: { relay?: CollabRelay, changed: () => Promise<void> }) {
  async function handle(ctx: CollabRouteContext): Promise<boolean> {
    const { req, res, path, sendJson } = ctx
    if (path !== '/collab/relay' && !path.startsWith('/collab/relay/')) return false
    const relay = deps.relay
    if (relay === undefined) { sendJson(res, 404, { error: '协作区跨机没接上' }); return true }
    if (!ctx.trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上用协作区' }); return true }

    function reply<T>(out: RelayAnswer<T>, shape: (value: T) => Record<string, unknown> = value => ({ ...value as Record<string, unknown> })): void {
      if (out.ok) { sendJson(res, 200, { ok: true, ...shape(out.value) }); return }
      const { ok: _ok, status, ...rest } = out
      sendJson(res, status, rest)
    }

    if (req.method === 'GET') {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      if (path === '/collab/relay/studio') { sendJson(res, 200, await relay.studio()); return true }
      if (path === '/collab/relay/channel') {
        const out = await relay.channel(str(query.get('id')))
        if (out.ok) sendJson(res, 200, out.value)
        else reply(out)
        return true
      }
      if (path === '/collab/relay/agents') { reply(await relay.agents()); return true }
      if (path === '/collab/relay/asks') { sendJson(res, 200, { asks: await relay.asks() }); return true }
      if (path === '/collab/relay/wecom') { reply(await relay.wecomBindings()); return true }
      sendJson(res, 404, { error: '没有这个路径' })
      return true
    }
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只收 GET / POST' }); return true }
    if (PAGE_ONLY.has(path) && (!ctx.loopback || !ctx.page)) { sendJson(res, 403, { error: '这一步要在这台电脑的协作区页面上点' }); return true }
    const denied = await ctx.writeDenied()
    if (denied !== undefined) { sendJson(res, 403, { error: denied }); return true }
    const body = await ctx.readJsonBody(req, res)
    if (body === undefined) return true
    const need = (name: string): string | undefined => {
      const value = str(body[name])
      if (value === undefined) sendJson(res, 400, { error: `缺 ${name}` })
      return value
    }

    switch (path) {
      case '/collab/relay/studio/create': {
        const name = need('name')
        const nick = name === undefined ? undefined : need('nick')
        if (name === undefined || nick === undefined) return true
        reply(await relay.createStudio({ name, nick }))
        break
      }
      case '/collab/relay/studio/invite':
        reply(await relay.invite(), invite => ({ invite }))
        break
      case '/collab/relay/studio/join': {
        const code = need('code')
        const nick = code === undefined ? undefined : need('nick')
        if (code === undefined || nick === undefined) return true
        reply(await relay.join({ code, nick }))
        break
      }
      case '/collab/relay/studio/role': {
        const accountId = need('account_id')
        if (accountId === undefined) return true
        if (!(WORKSPACE_ROLES as readonly unknown[]).includes(body.role)) { sendJson(res, 400, { error: 'role 要是 member / admin' }); return true }
        reply(await relay.setRole({ account_id: accountId, role: body.role as WorkspaceRole }))
        break
      }
      case '/collab/relay/studio/remove': {
        const accountId = need('account_id')
        if (accountId === undefined) return true
        reply(await relay.removeMember({ account_id: accountId }))
        break
      }
      case '/collab/relay/channel/say': {
        const channelId = need('channel_id')
        const text = channelId === undefined ? undefined : need('text')
        if (channelId === undefined || text === undefined) return true
        const refs = Array.isArray(body.refs) ? body.refs as CollabChannelRef[] : undefined
        reply(await relay.say({ channel_id: channelId, text, ...(refs === undefined ? {} : { refs }) }))
        break
      }
      case '/collab/relay/agents/share': {
        const cardId = need('card_id')
        if (cardId === undefined) return true
        reply(await relay.shareAgent(cardId))
        break
      }
      case '/collab/relay/borrow': {
        const objectId = need('object_id')
        const owner = objectId === undefined ? undefined : need('owner_account')
        const noteId = owner === undefined ? undefined : need('note_id')
        if (objectId === undefined || owner === undefined || noteId === undefined) return true
        const out = await relay.borrow({
          object_id: objectId, owner_account: owner, note_id: noteId,
          ...(typeof body.owner_epoch === 'number' ? { owner_epoch: body.owner_epoch } : {}),
        })
        if (out.ok) await deps.changed()
        reply(out)
        break
      }
      case '/collab/relay/asks/answer': {
        const requestId = need('request_id')
        if (requestId === undefined) return true
        if (typeof body.approve !== 'boolean') { sendJson(res, 400, { error: 'approve 要是 true / false' }); return true }
        const out = await relay.answer(requestId, body.approve)
        if (out.ok) await deps.changed()
        reply(out)
        break
      }
      case '/collab/relay/webhook':
      case '/collab/relay/webhook/rotate': {
        const timerId = need('timer_id')
        if (timerId === undefined) return true
        const out = await relay.webhook(timerId, path.endsWith('/rotate'))
        if (out.ok) await deps.changed()
        reply(out)
        break
      }
      case '/collab/relay/wecom/code': {
        const channelId = need('channel_id')
        if (channelId === undefined) return true
        reply(await relay.wecomCode(channelId))
        break
      }
      case '/collab/relay/wecom/remove': {
        const chatid = need('chatid')
        if (chatid === undefined) return true
        reply(await relay.wecomRemove(chatid))
        break
      }
      default:
        sendJson(res, 404, { error: `不认识的协作区跨机操作:${path}` })
    }
    return true
  }
  return { handle }
}
