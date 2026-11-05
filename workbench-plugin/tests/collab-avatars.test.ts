// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { AVATAR_PHOTO_MAX_BYTES } from '../src/protocol.ts'
import { createAvatarStore, pngSizeOf } from '../src/server/collabAvatars.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'wb-avatars-')); dirs.push(dir); return dir }

/** 只有 PNG 头与 IHDR 的「图」(服务端只核头与宽高,不解码)。`pad` 撑大字节数。 */
function png(w: number, h: number, pad = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(w, 8)
  ihdr.writeUInt32BE(h, 12)
  ihdr[16] = 8; ihdr[17] = 6
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad, 7)])
}
const dataUrl = (buf: Buffer): string => `data:image/png;base64,${buf.toString('base64')}`

describe('pngSizeOf', () => {
  it('认 PNG 头与 IHDR;别的都不认', () => {
    expect(pngSizeOf(png(256, 256))).toEqual({ width: 256, height: 256 })
    expect(pngSizeOf(Buffer.from('GIF89a........................'))).toBeUndefined()
    expect(pngSizeOf(Buffer.alloc(4))).toBeUndefined()
  })
})

describe('头像存本机', () => {
  it('内置:存记录;照片:两张文件 + v;换回内置删照片;恢复默认全删', async () => {
    const home = tmp()
    const store = createAvatarStore({ home, now: () => 1000 })
    expect((await store.save('card:1', { preset: 'agent-3' })).ok).toBe(true)
    expect(await store.table()).toEqual({ 'card:1': { kind: 'preset', id: 'agent-3' } })
    const saved = await store.save('card:1', { photo: dataUrl(png(256, 256)), thumb: dataUrl(png(64, 64)) })
    expect(saved).toEqual({ ok: true, avatar: { kind: 'photo', v: 1000 } })
    const dir = join(home, '.dsh', 'workbench', 'avatars')
    expect(readdirSync(dir).sort()).toEqual(['card_1.png', 'card_1.thumb.png'])
    expect((await store.read('card:1', false))?.length).toBe(png(256, 256).length)
    expect((await store.thumbDataUrl('card:1'))).toBe(dataUrl(png(64, 64)))
    await store.save('card:1', { preset: 'human-0' })
    expect(readdirSync(dir)).toEqual([])
    expect(await store.thumbDataUrl('card:1')).toBeUndefined()
    await store.reset('card:1')
    expect(await store.table()).toEqual({})
    expect(existsSync(join(home, '.dsh', 'workbench', 'avatars.json'))).toBe(true)
  })

  it('不合规的一律拒,说清哪样不对;路径逃不出目录', async () => {
    const store = createAvatarStore({ home: tmp() })
    expect(await store.save('../x', { preset: 'agent-1' })).toMatchObject({ ok: false, reason: expect.stringContaining('owner') })
    expect(await store.save('a/b', { preset: 'agent-1' })).toMatchObject({ ok: false })
    expect(await store.read('../x', false)).toBeUndefined()
    expect(await store.save('me', { preset: 'cat-1' })).toMatchObject({ ok: false, reason: expect.stringContaining('内置') })
    expect(await store.save('me', { photo: dataUrl(png(200, 200)), thumb: dataUrl(png(64, 64)) })).toMatchObject({ ok: false, reason: expect.stringContaining('256') })
    expect(await store.save('me', { photo: dataUrl(png(256, 256)), thumb: dataUrl(png(32, 32)) })).toMatchObject({ ok: false, reason: expect.stringContaining('64') })
    expect(await store.save('me', { photo: 'data:image/jpeg;base64,AAAA', thumb: dataUrl(png(64, 64)) })).toMatchObject({ ok: false, reason: expect.stringContaining('PNG') })
    expect(await store.save('me', { photo: dataUrl(png(256, 256, AVATAR_PHOTO_MAX_BYTES)), thumb: dataUrl(png(64, 64)) })).toMatchObject({ ok: false, reason: expect.stringContaining('太大') })
  })
})

async function serve() {
  const home = tmp()
  let n = 0
  const tasks = createTasksService({ file: join(home, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService({ now: () => NOW_SEC }), tickIntervalMs: 0, tasks,
    collabAvatars: { home },
  })
  started.push(server)
  return { url: server.url, home }
}
const PAGE = { origin: 'http://127.0.0.1:3080' }
async function post(url: string, path: string, body: unknown, headers: Record<string, string> = PAGE) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('/collab/avatar/*', () => {
  it('存 → /state.tasks.avatars 带表(不带字节);GET 给图;恢复默认 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/avatar/save', { owner: 'codex', photo: dataUrl(png(256, 256)), thumb: dataUrl(png(64, 64)) })).status).toBe(200)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.tasks?.avatars?.codex).toMatchObject({ kind: 'photo' })
    expect(JSON.stringify(state)).not.toContain(png(256, 256).toString('base64').slice(0, 40))
    const got = await fetch(`${url}/collab/avatar/codex.png`)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('cache-control')).toBe('no-cache')
    expect((await got.arrayBuffer()).byteLength).toBe(png(256, 256).length)
    expect((await (await fetch(`${url}/collab/avatar/codex.png?thumb=1`)).arrayBuffer()).byteLength).toBe(png(64, 64).length)
    expect((await post(url, '/collab/avatar/reset', { owner: 'codex' })).status).toBe(200)
    expect((await fetch(`${url}/collab/avatar/codex.png`)).status).toBe(404)
  })
  it('不是页面点的 403;owner 不合规 400;内置 id 不认 400', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/avatar/save', { owner: 'me', preset: 'human-1' }, {})).status).toBe(403)
    expect((await post(url, '/collab/avatar/save', { owner: '../x', preset: 'human-1' })).status).toBe(400)
    expect((await post(url, '/collab/avatar/save', { owner: 'me', preset: 'x' })).status).toBe(400)
    expect((await fetch(`${url}/collab/avatar/..%2Fx.png`)).status).toBe(400)
  })
})
