/**
 * 名片头像的 8791 路由(2026-10-21,`collabAvatars.ts`)。**接缝**:8791 接口(主人 = 统筹),全是新路径。
 *
 * | 路由 | 做什么 |
 * |---|---|
 * | `POST /collab/avatar/save {owner, preset}` 或 `{owner, photo, thumb}` | 存内置 / 裁好的照片(PNG data URL) |
 * | `POST /collab/avatar/reset {owner}` | 恢复默认 |
 * | `GET  /collab/avatar/<owner>.png[?thumb=1]` | 照片 / 小图 |
 *
 * 看图:本机或配对过的手机;存与恢复默认:只认这台电脑上的页面点的(同名片登记)。
 */
import type { AvatarStore } from './collabAvatars.ts'
import { isAvatarOwner } from './collabAvatars.ts'
import type { CollabRouteContext } from './collabRoutes.ts'

export function createCollabAvatarRoutes(deps: { store?: AvatarStore, changed: () => Promise<void> }) {
  async function handle(ctx: CollabRouteContext): Promise<boolean> {
    const { req, res, path, sendJson } = ctx
    if (!path.startsWith('/collab/avatar/')) return false
    const store = deps.store
    if (store === undefined) { sendJson(res, 404, { error: '头像没接上' }); return true }
    if (!ctx.trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上用协作区' }); return true }

    if (req.method === 'GET') {
      const name = path.slice('/collab/avatar/'.length)
      let owner: string
      try { owner = decodeURIComponent(name.replace(/\.png$/, '')) }
      catch { owner = '' }
      if (!name.endsWith('.png') || !isAvatarOwner(owner)) { sendJson(res, 400, { error: 'owner 认不出' }); return true }
      const thumb = new URL(req.url ?? '/', 'http://x').searchParams.get('thumb') === '1'
      const buf = await store.read(owner, thumb)
      if (buf === undefined) { sendJson(res, 404, { error: '没有这张头像' }); return true }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': buf.length })
      res.end(buf)
      return true
    }
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只收 GET / POST' }); return true }
    if (!ctx.loopback || !ctx.page) { sendJson(res, 403, { error: '头像要在这台电脑的协作区页面上换' }); return true }
    const denied = await ctx.writeDenied()
    if (denied !== undefined) { sendJson(res, 403, { error: denied }); return true }
    const body = await ctx.readJsonBody(req, res)
    if (body === undefined) return true
    const owner = typeof body.owner === 'string' ? body.owner : ''

    if (path === '/collab/avatar/save') {
      const input = typeof body.preset === 'string'
        ? { preset: body.preset }
        : { photo: typeof body.photo === 'string' ? body.photo : '', thumb: typeof body.thumb === 'string' ? body.thumb : '' }
      const saved = await store.save(owner, input)
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, avatar: saved.avatar })
      return true
    }
    if (path === '/collab/avatar/reset') {
      const out = await store.reset(owner)
      if (!out.ok) { sendJson(res, 400, { error: out.reason }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }
    sendJson(res, 404, { error: '没有这个路径' })
    return true
  }
  return { handle }
}
