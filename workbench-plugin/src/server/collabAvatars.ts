/**
 * 名片头像存本机(2026-10-21,协作区评审第 ⑤ 条)。
 *
 * - 表:`<home>/.dsh/workbench/avatars.json`,owner → `CollabAvatar`;照片两张文件在 `avatars/` 下(`:` 换 `_`)。
 * - 页面在浏览器里裁好再送来:256×256 的照片 + 64×64 的小图,都是 PNG data URL。这里只核 PNG 头、IHDR 宽高与字节数,
 *   不解码 —— 显示在 `<img>` 里,解不出来浏览器自己不画。
 * - 跨机只给小图(`thumbDataUrl`),原图不出这台电脑。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CollabAvatar } from '../protocol.ts'
import { AVATAR_PHOTO_MAX_BYTES, AVATAR_PHOTO_PX, AVATAR_THUMB_MAX_BYTES, AVATAR_THUMB_PX } from '../protocol.ts'

const OWNER = /^[A-Za-z0-9:_-]{1,80}$/
const PRESET = /^(human|agent)-\d{1,2}$/
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const PNG_URL = 'data:image/png;base64,'

export const isAvatarOwner = (owner: string): boolean => OWNER.test(owner)

/** PNG 的宽高(只看头八字节与紧跟的 IHDR);不是 PNG 就 undefined。 */
export function pngSizeOf(buf: Buffer): { width: number, height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export type AvatarInput = { preset: string } | { photo: string, thumb: string }
export type AvatarSaved = { ok: true, avatar: CollabAvatar } | { ok: false, reason: string }

export interface AvatarStore {
  table: () => Promise<Record<string, CollabAvatar>>
  save: (owner: string, input: AvatarInput) => Promise<AvatarSaved>
  reset: (owner: string) => Promise<{ ok: boolean, reason?: string }>
  /** 照片字节(`thumb` = 小图);没有 / owner 不合规就 undefined。 */
  read: (owner: string, thumb: boolean) => Promise<Buffer | undefined>
  /** 跨机用:内置给 id,照片给小图 data URL;没设就 undefined。 */
  shareOf: (owner: string) => Promise<{ preset: string } | { thumb: string } | undefined>
  thumbDataUrl: (owner: string) => Promise<string | undefined>
}

function decodePng(url: unknown, px: number, max: number, what: string): Buffer | string {
  if (typeof url !== 'string' || !url.startsWith(PNG_URL)) return `${what}要是 PNG(data:image/png;base64,…)`
  const buf = Buffer.from(url.slice(PNG_URL.length), 'base64')
  if (buf.length > max) return `${what}太大:${Math.ceil(buf.length / 1024)} KB,上限 ${Math.floor(max / 1024)} KB`
  const size = pngSizeOf(buf)
  if (size === undefined) return `${what}不是 PNG`
  if (size.width !== px || size.height !== px) return `${what}要正好 ${px}×${px},送来的是 ${size.width}×${size.height}`
  return buf
}

export function createAvatarStore(opts: { home: string, now?: () => number }): AvatarStore {
  const base = join(opts.home, '.dsh', 'workbench')
  const file = join(base, 'avatars.json')
  const dir = join(base, 'avatars')
  const now = opts.now ?? Date.now
  const photoPath = (owner: string, thumb: boolean): string => join(dir, `${owner.replace(/:/g, '_')}${thumb ? '.thumb' : ''}.png`)

  async function load(): Promise<Record<string, CollabAvatar>> {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      const out: Record<string, CollabAvatar> = {}
      for (const [owner, value] of Object.entries(raw)) {
        if (!OWNER.test(owner) || typeof value !== 'object' || value === null) continue
        const one = value as Record<string, unknown>
        if (one.kind === 'preset' && typeof one.id === 'string' && PRESET.test(one.id)) out[owner] = { kind: 'preset', id: one.id }
        else if (one.kind === 'photo' && typeof one.v === 'number') out[owner] = { kind: 'photo', v: one.v }
      }
      return out
    }
    catch { return {} }
  }
  async function store(table: Record<string, CollabAvatar>): Promise<void> {
    await mkdir(base, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }
  async function dropPhotos(owner: string): Promise<void> {
    await rm(photoPath(owner, false), { force: true })
    await rm(photoPath(owner, true), { force: true })
  }
  async function read(owner: string, thumb: boolean): Promise<Buffer | undefined> {
    if (!OWNER.test(owner)) return undefined
    if ((await load())[owner]?.kind !== 'photo') return undefined
    try { return await readFile(photoPath(owner, thumb)) }
    catch { return undefined }
  }
  async function thumbDataUrl(owner: string): Promise<string | undefined> {
    const buf = await read(owner, true)
    return buf === undefined ? undefined : `${PNG_URL}${buf.toString('base64')}`
  }

  return {
    table: load,
    read,
    thumbDataUrl,
    async shareOf(owner) {
      if (!OWNER.test(owner)) return undefined
      const one = (await load())[owner]
      if (one === undefined) return undefined
      if (one.kind === 'preset') return { preset: one.id }
      const thumb = await thumbDataUrl(owner)
      return thumb === undefined ? undefined : { thumb }
    },
    async save(owner, input) {
      if (!OWNER.test(owner)) return { ok: false, reason: 'owner 只认字母、数字与 : _ -(最多 80 个)' }
      const table = await load()
      if ('preset' in input) {
        if (!PRESET.test(input.preset)) return { ok: false, reason: '内置头像 id 认不出' }
        await dropPhotos(owner)
        table[owner] = { kind: 'preset', id: input.preset }
        await store(table)
        return { ok: true, avatar: table[owner] }
      }
      const photo = decodePng(input.photo, AVATAR_PHOTO_PX, AVATAR_PHOTO_MAX_BYTES, '照片')
      if (typeof photo === 'string') return { ok: false, reason: photo }
      const thumb = decodePng(input.thumb, AVATAR_THUMB_PX, AVATAR_THUMB_MAX_BYTES, '小图')
      if (typeof thumb === 'string') return { ok: false, reason: thumb }
      await mkdir(dir, { recursive: true })
      await writeFile(photoPath(owner, false), photo)
      await writeFile(photoPath(owner, true), thumb)
      table[owner] = { kind: 'photo', v: now() }
      await store(table)
      return { ok: true, avatar: table[owner] }
    },
    async reset(owner) {
      if (!OWNER.test(owner)) return { ok: false, reason: 'owner 只认字母、数字与 : _ -(最多 80 个)' }
      const table = await load()
      delete table[owner]
      await dropPhotos(owner)
      await store(table)
      return { ok: true }
    },
  }
}
