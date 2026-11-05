/**
 * 对话里的附件:列、按需取、分块、在 Mac 上转成手机看得了的样子(2026-10-01,手机读对话卡 C)。
 *
 * 维护者:「图片、视频、md 文件这些东西,肯定也是不支持显示,更别说点击、放大缩小」;统筹补:
 * 「任何文件至少有一张卡,能读的就显示内容」「转换都在 Mac 那头做」。
 *
 * ## 列(读对话时顺手认,见 sessionTranscript.ts 的 `attachmentsOf`)
 *   - 她贴的图:记录里的 base64 图片块(Claude `image`、Codex `input_image` / `images`);
 *   - 它那边的截图:工具结果里的图片块;
 *   - 对话里提到的本机文件:她那句 / 它那句里的绝对路径(`/Users/…`、`~/…`,反引号里带空格的也认),
 *     以及它写出来的非代码文件。不在了的也列(标「不在了」),像密钥的不列。
 *
 * ## 取:只认这条会话里出现过的
 *   附件编号 = `<那一行的字节偏移>~b~<块的位置>` 或 `<偏移>~p~<路径>`。取的时候**回到记录里那一行**:
 *   偏移得是一行的开头、那一行里得真有这个图片块 / 这条路径 —— 伪造一个编号拿不到别的文件(不开放任意读盘)。
 *
 * ## 分块与转换
 *   每块 ≤ {@link SESSION_ATTACHMENT_PART_BYTES}(base64 后装得进中转 1MB 一条的回包),在家在外同一条路。
 *   转换(缩略图、HEIC → JPEG、docx → 正文、flac → m4a、PDF 逐页)走 macPreview.ts;转好的在内存里留一会儿
 *   (分块取的时候不必每块重转),不落盘。
 */
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import {
  SESSION_ATTACHMENT_PART_BYTES,
  SESSION_ATTACHMENT_TEXT_PART,
  type SessionAttachmentChunk,
  type SessionAttachmentInfo,
  type SessionAttachmentKind,
  type SessionAttachmentRef,
} from '../protocol.ts'
import { FETCH_MAX_BYTES, fetchMimeOf } from './fileFetch.ts'
import { createMacPreviewTools, type MacPreviewTools } from './macPreview.ts'
import { asRecord, claudeAsk, type DigestFormat } from './sessionDigest.ts'
import type { SessionFileRef } from './sessionHistory.ts'
import type { LibraryResult } from './sessionLibrary.ts'
import type { AttachmentHit } from './sessionTranscript.ts'

export type { MacPreviewTools } from './macPreview.ts'

// ───────────────────────────── 哪一类 ─────────────────────────────

const KIND_BY_EXT: Readonly<Record<string, SessionAttachmentKind>> = {}
const kinds: [SessionAttachmentKind, string][] = [
  ['image', 'png jpg jpeg gif webp svg heic heif bmp tif tiff avif'],
  ['video', 'mp4 m4v mov webm mkv avi'],
  ['audio', 'mp3 m4a wav aac flac ogg oga opus aif aiff caf'],
  ['markdown', 'md markdown'],
  ['table', 'csv tsv'],
  ['html', 'html htm'],
  ['pdf', 'pdf'],
  ['document', 'docx doc rtf rtfd odt pages wps'],
  ['slides', 'pptx ppt key odp'],
  ['sheet', 'xlsx xls numbers ods'],
  ['archive', 'zip tar gz tgz bz2 xz 7z rar dmg pkg apk ipa jar'],
  ['code', 'ts tsx js jsx mjs cjs py swift sh zsh bash fish rb go rs java kt kts c h cc cpp hpp m mm cs php lua pl r sql css scss less json jsonl yaml yml toml xml plist ini conf gradle vue svelte dart'],
  ['text', 'txt log text out err diff patch srt vtt'],
]
for (const [kind, list] of kinds) for (const ext of list.split(' ')) (KIND_BY_EXT as Record<string, SessionAttachmentKind>)[ext] = kind

export function attachmentKindOf(name: string, mime?: string): SessionAttachmentKind {
  if (mime?.startsWith('image/') === true) return 'image'
  return KIND_BY_EXT[extname(name).slice(1).toLowerCase()] ?? 'other'
}

const MIME_EXTRA: Readonly<Record<string, string>> = {
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

function mimeOf(name: string): string {
  return MIME_EXTRA[extname(name).toLowerCase()] ?? fetchMimeOf(name)
}

/** 手机(安卓 WebView)直接认得的:图片、音视频。别的要在 Mac 上转。 */
const WEB_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp'])
const WEB_AUDIO = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/ogg'])
const WEB_VIDEO = new Set(['video/mp4', 'video/quicktime', 'video/webm'])

// ───────────────────────────── 不出门的 ─────────────────────────────

/** 看着像密钥 / 凭据 / 浏览器登录态的(与 fileFetch 那一道同口径,另加几样)。这类不列、不给。 */
const SECRET_NAME = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|cookies(?:\.sqlite)?|login data|.*\.(?:pem|p12|pfx|key|keychain|keychain-db|kdbx|ovpn))$/i
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'Keychains', '.password-store'])

export function attachmentBlocked(path: string): boolean {
  const segments = path.split('/')
  if (segments.some(segment => SECRET_DIRS.has(segment))) return true
  const name = basename(path)
  // .key 是 Keynote 也是私钥:Keynote 是个目录包或 zip,私钥是几 KB 的文本 —— 取的时候再按大小分,这里放过 Keynote。
  if (/\.key$/i.test(name)) return false
  return SECRET_NAME.test(name)
}

// ───────────────────────────── 列 ─────────────────────────────

/** 对话文字里的本机绝对路径。反引号里的可以带空格;裸写的到空白 / 标点为止。都得有扩展名。 */
const QUOTED_PATH = /`((?:~|\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library|home))\/[^`\n]*?\.[A-Za-z0-9]{1,8})`/g
const BARE_PATH = /(?:~|\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library|home))\/[^\s`'"<>|*?()[\]{}，。、；：！？「」《》“”‘’]*?\.[A-Za-z0-9]{1,8}(?=$|[\s`'"<>|*?()[\]{}，。、；：！？「」《》“”‘’,;:!?]|\.(?:\s|$))/g

export function pathsInText(text: string): string[] {
  const found: { at: number, path: string }[] = []
  const taken: [number, number][] = []
  for (const match of text.matchAll(QUOTED_PATH)) {
    const at = match.index ?? 0
    found.push({ at, path: match[1]! })
    taken.push([at, at + match[0].length])
  }
  for (const match of text.matchAll(BARE_PATH)) {
    const at = match.index ?? 0
    if (taken.some(([from, to]) => at >= from && at < to)) continue
    found.push({ at, path: match[0] })
  }
  const out: string[] = []
  for (const one of found.sort((a, b) => a.at - b.at)) {
    const path = one.path.startsWith('~/') ? join(homedir(), one.path.slice(2)) : one.path
    if (!out.includes(path)) out.push(path)
  }
  return out
}

const encodePath = (path: string): string => Buffer.from(path, 'utf8').toString('base64url')

/**
 * 这个编号指的是**电脑上一个真文件**吗(2026-10-04)。`~p~` 是本机路径、`~k~` 是那家自己的图库
 * (Kimi 的 `blobs/`);`~b~` 是写在对话记录里的 base64 —— 那一种没有对应的文件,
 * 「存到手机上」给不出来(手机那一侧同一条规矩在 `butler-app/src/items/attachments/Attachments.tsx`)。
 */
export function attachmentIsFileRef(ref: string): boolean {
  return /^\d{1,15}~[pk]~/.test(ref)
}

/**
 * 一张图片块(base64)的字节数与类型;不是图就 undefined。
 *
 * 认的几种写法(2026-10-04 在本机真会话上数出来的,见 `docs/交接-1004-手机看各家对话里的图片和文件.md`):
 *   - Claude:`{type:'image', source:{type:'base64', media_type, data}}`;
 *   - Codex 她那句 / 工具结果:`{type:'input_image'|'image', image_url:'data:image/…;base64,…'}`;
 *   - Codex / MCP 工具结果:`{type:'image', data:'<base64>', mimeType:'image/jpeg'}`(没有 `data:` 前缀)。
 * `image_url` 也可能是 `{url}`(OpenAI 老写法)。
 */
function imageBlock(value: unknown): { mime: string, data: string } | undefined {
  const block = asRecord(value)
  if (block === undefined) return undefined
  const source = asRecord(block.source)
  if (block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string') {
    return { mime: typeof source.media_type === 'string' ? source.media_type : 'image/png', data: source.data }
  }
  const url = typeof block.image_url === 'string' ? block.image_url : typeof asRecord(block.image_url)?.url === 'string' ? asRecord(block.image_url)!.url as string : undefined
  if (url !== undefined) return dataUrl(url)
  // MCP 工具结果那一种:裸 base64 + mimeType(Codex 的 `item.result.content[]` 里就是这个)。
  if (block.type === 'image' && typeof block.data === 'string' && block.data !== '' && typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
    return { mime: block.mimeType, data: block.data }
  }
  return undefined
}

/**
 * Kimi 桌面版的图不写在记录里,记录里只有一句 `blobref:<mime>;<sha256>` ——
 * 真字节在**同一个目录下**的 `blobs/<sha256>`(2026-10-04 在本机 78 条 blobref 上数过:78/78 都在)。
 */
const BLOBREF = /^blobref:(image\/[\w.+-]+);([0-9a-f]{64})$/

export function kimiBlobRef(value: unknown): { mime: string, hash: string } | undefined {
  const block = asRecord(value)
  const url = typeof block?.imageUrl === 'string'
    ? block.imageUrl
    : typeof asRecord(block?.imageUrl)?.url === 'string'
      ? asRecord(block?.imageUrl)!.url as string
      : typeof asRecord(block?.image_url)?.url === 'string'
        ? asRecord(block?.image_url)!.url as string
        : typeof block?.image_url === 'string' ? block.image_url : undefined
  if (url === undefined) return undefined
  const match = BLOBREF.exec(url)
  return match === null ? undefined : { mime: match[1]!, hash: match[2]! }
}

function dataUrl(value: unknown): { mime: string, data: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(value)
  return match === null ? undefined : { mime: match[1]!, data: match[2]! }
}

const EXT_OF_MIME: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function embeddedRef(offset: number, pointer: (string | number)[], index: number, mime: string, data: string, from: 'you' | 'ai'): SessionAttachmentRef {
  return {
    ref: `${offset}~b~${pointer.join('.')}`,
    name: `${from === 'you' ? '图片' : '截图'} ${index}.${EXT_OF_MIME[mime] ?? 'png'}`,
    kind: 'image',
    bytes: Math.floor(data.replace(/=+$/, '').length * 3 / 4),
    from,
  }
}

/** 一行里她 / 它说的那几段字,带路径的那几段。 */
function textsOf(format: DigestFormat, row: Record<string, unknown>): { on: 'ask' | 'reply', text: string }[] {
  const out: { on: 'ask' | 'reply', text: string }[] = []
  if (format === 'claude-transcript') {
    const content = asRecord(row.message)?.content
    if (row.type === 'user' && claudeAsk(row) !== undefined) {
      if (typeof content === 'string') out.push({ on: 'ask', text: content })
      for (const block of Array.isArray(content) ? content : []) {
        const b = asRecord(block)
        if (b?.type === 'text' && typeof b.text === 'string') out.push({ on: 'ask', text: b.text })
      }
    }
    else if (row.type === 'assistant' && row.isApiErrorMessage !== true) {
      for (const block of Array.isArray(content) ? content : []) {
        const b = asRecord(block)
        if (b?.type === 'text' && typeof b.text === 'string') out.push({ on: 'reply', text: b.text })
      }
    }
    return out
  }
  if (format === 'codex-rollout') {
    const payload = asRecord(row.payload)
    if (row.type === 'event_msg' && typeof payload?.message === 'string') {
      if (payload.type === 'user_message') out.push({ on: 'ask', text: payload.message })
      if (payload.type === 'agent_message') out.push({ on: 'reply', text: payload.message })
    }
    /**
     * 新版 Codex 的那一句在 `event_msg.item_completed.item.content[]`(老版那两个 payload 在新版文件里压根不出现)。
     * 她贴文件时 Codex 会在正文最前面塞一段「# Files mentioned by the user: ## <名字>: <绝对路径>」——
     * 路径就在那里面,所以这一段也要交给 `pathsInText` 过一遍。
     */
    if (row.type === 'event_msg' && payload?.type === 'item_completed') {
      const item = asRecord(payload.item)
      const on = item?.type === 'UserMessage' ? 'ask' : item?.type === 'AgentMessage' ? 'reply' : undefined
      if (on !== undefined) {
        for (const block of Array.isArray(item?.content) ? item!.content as unknown[] : []) {
          const b = asRecord(block)
          if (typeof b?.text === 'string') out.push({ on, text: b.text })
        }
      }
    }
    return out
  }
  if (row.type === 'turn.prompt') {
    const input = row.input
    if (typeof input === 'string') out.push({ on: 'ask', text: input })
    for (const block of Array.isArray(input) ? input : []) {
      const b = asRecord(block)
      if (typeof b?.text === 'string') out.push({ on: 'ask', text: b.text })
    }
  }
  const part = asRecord(asRecord(row.event)?.part)
  if (row.type === 'context.append_loop_event' && part?.type === 'text' && typeof part.text === 'string') out.push({ on: 'reply', text: part.text })
  return out
}

/** 它写出来的文件(Write / FileChange 那一步),只认非代码的:报告、图、表…… 改代码的那一堆不进附件(太多,也不是她要看的)。 */
function writtenFiles(format: DigestFormat, row: Record<string, unknown>): string[] {
  const out: string[] = []
  const keep = (path: unknown): void => {
    if (typeof path !== 'string' || !path.startsWith('/')) return
    const kind = attachmentKindOf(path)
    if (kind !== 'code' && kind !== 'text' && kind !== 'other') out.push(path)
  }
  if (format === 'claude-transcript') {
    if (row.type !== 'assistant') return out
    for (const block of Array.isArray(asRecord(row.message)?.content) ? asRecord(row.message)!.content as unknown[] : []) {
      const b = asRecord(block)
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !/^(?:write|notebookedit)$/i.test(b.name)) continue
      keep(asRecord(b.input)?.file_path)
    }
    return out
  }
  // Codex 新版:`item_completed` 的 FileChange 一条带一张 `changes` 表(键是绝对路径);老版是 `patch_apply_begin`。
  if (format === 'codex-rollout' && row.type === 'event_msg') {
    const payload = asRecord(row.payload)
    const changes = payload?.type === 'item_completed' && asRecord(payload.item)?.type === 'FileChange'
      ? asRecord(asRecord(payload.item)!.changes)
      : payload?.type === 'patch_apply_begin' ? asRecord(payload.changes) : undefined
    for (const path of Object.keys(changes ?? {})) keep(path)
  }
  return out
}

const MAX_PER_ROW = 12

async function fileRef(offset: number, path: string, from: 'you' | 'ai'): Promise<SessionAttachmentRef | undefined> {
  if (attachmentBlocked(path)) return undefined
  const name = basename(path)
  const base = { ref: `${offset}~p~${encodePath(path)}`, name, kind: attachmentKindOf(name), from } as const
  try {
    const info = await stat(path)
    if (!info.isFile()) return info.isDirectory() && /\.(?:key|pages|numbers|rtfd)$/i.test(name) ? { ...base } : undefined
    return { ...base, bytes: info.size }
  }
  catch {
    return { ...base, missing: true }
  }
}

/** 这一行带出了哪些附件(sessionTranscript 读每一行时问一句)。 */
export async function attachmentHits(format: DigestFormat, row: Record<string, unknown>, offset: number): Promise<AttachmentHit[]> {
  const hits: AttachmentHit[] = []
  let images = 0
  // 记录里的图片块
  if (format === 'claude-transcript' && row.type === 'user') {
    const content = asRecord(row.message)?.content
    const human = claudeAsk(row) !== undefined
    if (Array.isArray(content)) {
      content.forEach((block, i) => {
        const image = imageBlock(block)
        if (image !== undefined && human) hits.push({ on: 'ask', ref: embeddedRef(offset, ['message', 'content', i], ++images, image.mime, image.data, 'you') })
        const b = asRecord(block)
        if (!human && b?.type === 'tool_result' && Array.isArray(b.content)) {
          b.content.forEach((inner, j) => {
            const shot = imageBlock(inner)
            if (shot !== undefined) hits.push({ on: 'steps', ref: embeddedRef(offset, ['message', 'content', i, 'content', j], ++images, shot.mime, shot.data, 'ai') })
          })
        }
      })
    }
  }
  /** 同一张图在 Codex 的记录里会写两三遍(`item_completed` 一遍、`response_item` 一遍)—— 按内容去重,见 AttachmentHit.same。 */
  const same = (mime: string, data: string): string => `${mime}|${data.length}|${data.slice(0, 64)}`
  const seen = new Set<string>()
  if (format === 'codex-rollout') {
    const payload = asRecord(row.payload)
    if (row.type === 'event_msg' && payload?.type === 'user_message' && Array.isArray(payload.images)) {
      payload.images.forEach((value, k) => {
        const image = dataUrl(value)
        if (image !== undefined) hits.push({ on: 'ask', ref: embeddedRef(offset, ['payload', 'images', k], ++images, image.mime, image.data, 'you'), same: same(image.mime, image.data) })
      })
    }
    /**
     * 新版(2026-10-04 在本机 09 / 10 月的 rollout 上数过:老版 `user_message.images` 只剩 1 份文件在用):
     *   - 她贴的图:`item_completed.item(UserMessage).content[]` 里的 `local_image`(本机路径,Codex 自己生成的在
     *     `~/.codex/generated_images/`、剪贴板粘的在 `/var/folders/…/T/codex-clipboard-*.jpg`)或 data URL;
     *   - 它那边的截图:`item_completed.item.result.content[]`(MCP 那种 `{data, mimeType}`)、
     *     `response_item.custom_tool_call_output|function_call_output.output[]` 里的 `input_image`(data URL)。
     * `compacted` 那几行(`replacement_history` / `guardian_history`)是压缩时抄的副本,不出事件也不列。
     */
    if (row.type === 'event_msg' && payload?.type === 'item_completed') {
      const item = asRecord(payload.item)
      if (item?.type === 'UserMessage' && Array.isArray(item.content)) {
        for (const [i, block] of item.content.entries()) {
          const image = imageBlock(block)
          if (image !== undefined) {
            hits.push({ on: 'ask', ref: embeddedRef(offset, ['payload', 'item', 'content', i], ++images, image.mime, image.data, 'you'), same: same(image.mime, image.data) })
            continue
          }
          const local = asRecord(block)
          if (local?.type !== 'local_image' || typeof local.path !== 'string' || !local.path.startsWith('/')) continue
          if (seen.has(local.path)) continue
          seen.add(local.path)
          const ref = await fileRef(offset, local.path, 'you')
          if (ref !== undefined) hits.push({ on: 'ask', ref })
        }
      }
      for (const [j, inner] of (Array.isArray(asRecord(item?.result)?.content) ? asRecord(item!.result)!.content as unknown[] : []).entries()) {
        const shot = imageBlock(inner)
        if (shot !== undefined) hits.push({ on: 'steps', ref: embeddedRef(offset, ['payload', 'item', 'result', 'content', j], ++images, shot.mime, shot.data, 'ai'), same: same(shot.mime, shot.data) })
      }
    }
    if (row.type === 'response_item') {
      // 她那句的另一份写法:同一句同时有 `item_completed` 时那一行不出事件,这一条就不会显示(`take()` 按行偏移认)。
      if (payload?.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
        for (const [i, block] of payload.content.entries()) {
          const image = imageBlock(block)
          if (image !== undefined) hits.push({ on: 'ask', ref: embeddedRef(offset, ['payload', 'content', i], ++images, image.mime, image.data, 'you'), same: same(image.mime, image.data) })
        }
      }
      if ((payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') && Array.isArray(payload.output)) {
        for (const [j, inner] of payload.output.entries()) {
          const shot = imageBlock(inner)
          if (shot !== undefined) hits.push({ on: 'steps', ref: embeddedRef(offset, ['payload', 'output', j], ++images, shot.mime, shot.data, 'ai'), same: same(shot.mime, shot.data) })
        }
      }
    }
  }
  /**
   * Kimi 桌面版:记录里只有 `blobref:<mime>;<sha256>`,真字节在同目录 `blobs/<sha256>`。
   * 工具结果里那几张在 `context.append_loop_event.event.result.output[]`;她贴的图在 `turn.prompt.input[]`。
   */
  if (format === 'kimi-wire') {
    const blobs: { on: AttachmentHit['on'], value: unknown }[] = []
    if (row.type === 'turn.prompt') for (const block of Array.isArray(row.input) ? row.input : []) blobs.push({ on: 'ask', value: block })
    if (row.type === 'context.append_loop_event') {
      const output = asRecord(asRecord(asRecord(row.event)?.result))?.output
      for (const block of Array.isArray(output) ? output : []) blobs.push({ on: 'steps', value: block })
    }
    for (const { on, value } of blobs) {
      const blob = kimiBlobRef(value)
      if (blob === undefined || seen.has(blob.hash)) continue
      seen.add(blob.hash)
      hits.push({
        on,
        ref: {
          ref: `${offset}~k~${blob.hash}`,
          name: `${on === 'ask' ? '图片' : '截图'} ${++images}.${EXT_OF_MIME[blob.mime] ?? 'png'}`,
          kind: 'image',
          from: on === 'ask' ? 'you' : 'ai',
        },
      })
    }
  }
  // 提到的本机文件
  for (const { on, text } of textsOf(format, row)) {
    for (const path of pathsInText(text)) {
      if (seen.has(path) || hits.length >= MAX_PER_ROW) continue
      seen.add(path)
      const ref = await fileRef(offset, path, on === 'ask' ? 'you' : 'ai')
      if (ref !== undefined) hits.push({ on, ref })
    }
  }
  for (const path of writtenFiles(format, row)) {
    if (seen.has(path) || hits.length >= MAX_PER_ROW) continue
    seen.add(path)
    const ref = await fileRef(offset, path, 'ai')
    if (ref !== undefined) hits.push({ on: 'steps', ref })
  }
  return hits
}

// ───────────────────────────── 取 ─────────────────────────────

export interface AttachmentQuery {
  agent: string
  id: string
  ref: string
  view: 'info' | 'thumb' | 'full' | 'text' | 'page'
  part?: number | undefined
  page?: number | undefined
}

export interface SessionAttachmentsDeps {
  locate: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
  tools?: MacPreviewTools
  /** 转好的东西在内存里最多留多少字节(默认 96MB)、留多久(默认 10 分钟)。 */
  cacheBytes?: number
  cacheMs?: number
  now?: () => number
}

/** 「存到手机上」要的那几格:交给取件单那一套(`fileFetch.ts` 的 `FileOffer`),这里不碰传输。 */
export interface AttachmentFile {
  path: string
  name: string
  bytes: number
  /** 给人看的「在哪」(与取文件那张卡同一格)。 */
  where: string
}

export interface SessionAttachments {
  hitsOf: (format: DigestFormat, row: Record<string, unknown>, offset: number) => Promise<AttachmentHit[]>
  read: (query: AttachmentQuery) => Promise<LibraryResult<SessionAttachmentInfo | SessionAttachmentChunk>>
  /**
   * 这个附件在电脑上的那个文件(2026-10-04):`view=keep` 要把它**存到手机上**时用 ——
   * 走的是现成的取件单 + `GET /files/offer/<单号>`(在家直连、出门工人推),不另造一条传输路。
   * 记录里的 base64 图没有对应的文件 → 403 加一句人话(看是能看的,存不下来)。
   */
  file: (query: Pick<AttachmentQuery, 'agent' | 'id' | 'ref'>) => Promise<LibraryResult<AttachmentFile>>
}

/** 缩略图边长。 */
const THUMB_PX = 480
/** 小于这么大的图直接拿原图当缩略图。 */
const THUMB_DIRECT_MAX = 256 * 1024
/** PDF 一页出多宽。 */
const PAGE_PX = 1400
/** 文字类最多读这么多(再大的日志到电脑上看)。 */
const TEXT_READ_MAX = 16 * 1024 * 1024
/** 表格一块最多几行。 */
const TABLE_ROWS_PART = 2000
const ROW_READ_MAX = 96 * 1024 * 1024

type Source =
  | { type: 'bytes', name: string, mime: string, bytes: Buffer, key: string }
  | { type: 'file', name: string, path: string, size: number, mtimeMs: number, key: string }

type Fail = { ok: false, status: number, error: string }
const fail = (status: number, error: string): Fail => ({ ok: false, status, error })

/** 读文件里从 offset 起的那一行(offset 必须是一行的开头)。 */
async function readLineAt(file: string, offset: number): Promise<string | Fail> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(file, 'r') }
  catch { return fail(404, '读不到这条对话的记录') }
  try {
    const { size } = await handle.stat()
    if (offset < 0 || offset >= size) return fail(400, '这个附件的编号不对')
    if (offset > 0) {
      const prev = Buffer.alloc(1)
      await handle.read(prev, 0, 1, offset - 1)
      if (prev[0] !== 0x0a) return fail(400, '这个附件的编号不对')
    }
    const parts: Buffer[] = []
    let position = offset
    let total = 0
    while (position < size && total < ROW_READ_MAX) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      const newline = slice.indexOf(0x0a)
      if (newline !== -1) { parts.push(slice.subarray(0, newline)); break }
      parts.push(slice)
      position += bytesRead
      total += bytesRead
    }
    return Buffer.concat(parts).toString('utf8')
  }
  finally {
    await handle.close()
  }
}

function at(value: unknown, pointer: readonly string[]): unknown {
  let current = value
  for (const key of pointer) {
    if (Array.isArray(current) && /^\d{1,4}$/.test(key)) current = current[Number(key)]
    else if (typeof current === 'object' && current !== null && !Array.isArray(current) && /^[a-z_]{1,32}$/i.test(key)) current = (current as Record<string, unknown>)[key]
    else return undefined
  }
  return current
}

/** 简单 CSV / TSV:引号、引号里的分隔符与换行、`""` 转义。 */
export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === separator) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      rows.push(row); row = []
    }
    else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

interface Prepared {
  info: SessionAttachmentInfo
  /** 整份(原样或转好的)。 */
  full?: { mime: string, bytes?: Buffer, path?: string, size: number }
  text?: string
  rows?: string[][]
  thumb?: { mime: string, bytes: Buffer }
}

export function createSessionAttachments(deps: SessionAttachmentsDeps): SessionAttachments {
  const tools = deps.tools ?? createMacPreviewTools()
  const now = deps.now ?? (() => Date.now())
  const cacheBytes = deps.cacheBytes ?? 96 * 1024 * 1024
  const cacheMs = deps.cacheMs ?? 10 * 60_000
  const cache = new Map<string, { at: number, size: number, value: Prepared }>()

  function remember(key: string, value: Prepared): Prepared {
    const size = (value.full?.bytes?.length ?? 0) + (value.text?.length ?? 0) * 2 + (value.thumb?.bytes.length ?? 0) + (value.rows === undefined ? 0 : JSON.stringify(value.rows).length * 2)
    cache.set(key, { at: now(), size, value })
    let total = 0
    for (const one of cache.values()) total += one.size
    for (const [k, one] of cache) {
      if (total <= cacheBytes && now() - one.at < cacheMs) continue
      if (k === key) continue
      cache.delete(k)
      total -= one.size
    }
    return value
  }

  function recall(key: string): Prepared | undefined {
    const hit = cache.get(key)
    if (hit === undefined || now() - hit.at > cacheMs) return undefined
    return hit.value
  }

  /** 编号 → 这条会话里真有的那个东西。 */
  async function resolve(query: Pick<AttachmentQuery, 'agent' | 'id' | 'ref'>): Promise<Source | Fail> {
    const match = /^(\d{1,15})~([bpk])~([A-Za-z0-9._-]{1,4000})$/.exec(query.ref)
    if (match === null) return fail(400, '这个附件的编号不对')
    const ref = await deps.locate(query.agent, query.id)
    if (ref === undefined) return fail(404, '读不到这条对话的记录')
    const offset = Number(match[1])
    const line = await readLineAt(ref.file, offset)
    if (typeof line !== 'string') return line
    let row: Record<string, unknown> | undefined
    try { row = asRecord(JSON.parse(line)) }
    catch { row = undefined }
    if (row === undefined) return fail(400, '这个附件的编号不对')
    if (match[2] === 'b') {
      const pointer = match[3]!.split('.')
      const value = at(row, pointer)
      const image = imageBlock(value) ?? dataUrl(value)
      if (image === undefined) return fail(400, '这个附件的编号不对')
      const bytes = Buffer.from(image.data, 'base64')
      return { type: 'bytes', name: `图片.${EXT_OF_MIME[image.mime] ?? 'png'}`, mime: image.mime, bytes, key: `${ref.file}|${query.ref}` }
    }
    /**
     * Kimi 的图(2026-10-04):记录里只有 `blobref:<mime>;<sha256>`,字节在**这份记录自己目录下**的 `blobs/<sha256>`。
     * 门:这个 sha256 得真在那一行里写着(连 mime 一起),路径由记录文件的位置算出来 —— 调用方给不了别的路径。
     */
    if (match[2] === 'k') {
      const hash = match[3]!
      const found = new RegExp(`blobref:(image/[\\w.+-]+);${hash}`).exec(line)
      if (found === null) return fail(403, '这张图不在这条对话里,不给')
      const file = join(dirname(ref.file), 'blobs', hash)
      let info: Awaited<ReturnType<typeof stat>>
      try { info = await stat(file) }
      catch { return fail(410, '电脑上这张图已经不在了(那家把它清掉了)') }
      if (!info.isFile()) return fail(403, '这不是一个普通文件,不传')
      if (info.size > FETCH_MAX_BYTES) return fail(413, `这张图有 ${(info.size / 1024 / 1024).toFixed(1)}MB,太大了;到电脑上打开`)
      return { type: 'file', name: `图片.${EXT_OF_MIME[found[1]!] ?? 'png'}`, path: file, size: info.size, mtimeMs: info.mtimeMs, key: `${file}|${info.mtimeMs}|${info.size}` }
    }
    const path = Buffer.from(match[3]!, 'base64url').toString('utf8')
    // 这条路径得真在那一行里(原样或 JSON 转义过的样子;`~/` 写法按展开前的样子认)。
    const home = homedir()
    const spelled = [path, JSON.stringify(path).slice(1, -1), ...(path.startsWith(`${home}/`) ? [`~/${path.slice(home.length + 1)}`] : [])]
    if (!spelled.some(one => line.includes(one))) return fail(403, '这个文件不在这条对话里,不给')
    if (attachmentBlocked(path)) return fail(403, '这个文件看着像密钥或凭据,不传')
    let info: Awaited<ReturnType<typeof stat>>
    try { info = await stat(path) }
    catch { return fail(410, '电脑上这个文件已经不在了(被挪走或删了)') }
    if (!info.isFile() && !info.isDirectory()) return fail(403, '这不是一个普通文件,不传')
    if (info.isFile() && info.size > FETCH_MAX_BYTES) return fail(413, `这个文件有 ${(info.size / 1024 / 1024).toFixed(1)}MB,太大了;到电脑上打开`)
    // .key 既可能是 Keynote,也可能是私钥:私钥是几 KB 的文本,Keynote 是包或 zip。拿不准就不给。
    if (/\.key$/i.test(path) && info.isFile() && info.size < 64 * 1024) return fail(403, '这个文件看着像密钥或凭据,不传')
    return { type: 'file', name: basename(path), path, size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs, key: `${path}|${info.mtimeMs}|${info.size}` }
  }

  async function thumbOf(source: Source, kind: SessionAttachmentKind): Promise<{ mime: string, bytes: Buffer } | undefined> {
    if (source.type === 'bytes') {
      if (source.bytes.length <= THUMB_DIRECT_MAX && WEB_IMAGE.has(source.mime)) return { mime: source.mime, bytes: source.bytes }
      return await withTempFile(source.bytes, EXT_OF_MIME[source.mime] ?? 'png', async (file) => {
        const jpeg = await tools.toJpeg(file, THUMB_PX)
        return jpeg === undefined ? undefined : { mime: 'image/jpeg', bytes: jpeg }
      })
    }
    if (kind === 'image' && source.size <= THUMB_DIRECT_MAX && WEB_IMAGE.has(mimeOf(source.name))) return { mime: mimeOf(source.name), bytes: await readFile(source.path) }
    return await tools.thumbnail(source.path, THUMB_PX)
  }

  async function prepare(source: Source): Promise<Prepared> {
    const known = recall(source.key)
    if (known !== undefined) return known
    const kind = source.type === 'bytes' ? 'image' : attachmentKindOf(source.name)
    const mime = source.type === 'bytes' ? source.mime : mimeOf(source.name)
    const size = source.type === 'bytes' ? source.bytes.length : source.size
    const modified = source.type === 'file' ? { modified_at: new Date(source.mtimeMs).toISOString() } : {}
    const thumb = await thumbOf(source, kind).catch(() => undefined)
    const base = { ref: '', name: source.name, kind, mime, bytes: size, ...modified, thumb: thumb !== undefined }
    const parts = (n: number): number => Math.max(1, Math.ceil(n / SESSION_ATTACHMENT_PART_BYTES))
    const prepared: Prepared = { info: base, ...(thumb === undefined ? {} : { thumb }) }
    const onDesk = '完整的到电脑上打开'

    if (source.type === 'bytes') {
      if (WEB_IMAGE.has(mime)) prepared.full = { mime, bytes: source.bytes, size }
      else {
        const jpeg = await withTempFile(source.bytes, 'img', file => tools.toJpeg(file))
        if (jpeg !== undefined) prepared.full = { mime: 'image/jpeg', bytes: jpeg, size: jpeg.length }
      }
    }
    else if (kind === 'image') {
      if (WEB_IMAGE.has(mime)) prepared.full = { mime, path: source.path, size }
      else {
        const jpeg = await tools.toJpeg(source.path)
        if (jpeg !== undefined) prepared.full = { mime: 'image/jpeg', bytes: jpeg, size: jpeg.length }
      }
    }
    else if (kind === 'video') {
      if (WEB_VIDEO.has(mime)) prepared.full = { mime, path: source.path, size }
    }
    else if (kind === 'audio') {
      if (WEB_AUDIO.has(mime)) prepared.full = { mime, path: source.path, size }
      else {
        const m4a = await tools.toM4a(source.path)
        if (m4a !== undefined) prepared.full = { mime: 'audio/mp4', bytes: m4a, size: m4a.length }
      }
    }
    else if (kind === 'markdown' || kind === 'code' || kind === 'text' || kind === 'html' || kind === 'table') {
      const raw = await readText(source.path)
      if (raw !== undefined) {
        if (kind === 'table') {
          prepared.rows = parseDelimited(raw, /\.tsv$/i.test(source.name) ? '\t' : ',')
        }
        else {
          let text = raw
          if (/\.json$/i.test(source.name)) {
            try { text = JSON.stringify(JSON.parse(raw), null, 2) }
            catch { /* 坏的 json 照原样 */ }
          }
          prepared.text = text
        }
      }
    }
    else if (kind === 'document') {
      const html = /\.(?:docx|doc|rtf|rtfd|odt|wps)$/i.test(source.name) ? await tools.toHtml(source.path) : undefined
      if (html !== undefined) prepared.text = html
    }
    else if (kind === 'pdf') {
      const pages = await tools.pdfPages(source.path)
      if (pages !== undefined) prepared.info = { ...prepared.info, pages }
    }

    const info: SessionAttachmentInfo = { ...prepared.info }
    if (prepared.full !== undefined) info.full = { mime: prepared.full.mime, bytes: prepared.full.size, parts: parts(prepared.full.size) }
    if (prepared.text !== undefined) {
      const format = kind === 'markdown' ? 'markdown' : kind === 'code' ? 'code' : kind === 'html' || kind === 'document' ? 'html' : 'plain'
      const lang = kind === 'code' ? extname(source.name).slice(1).toLowerCase() : undefined
      info.text = { format, parts: Math.max(1, Math.ceil(prepared.text.length / SESSION_ATTACHMENT_TEXT_PART)), ...(lang === undefined ? {} : { lang }) }
    }
    if (prepared.rows !== undefined) info.text = { format: 'table', parts: Math.max(1, Math.ceil(prepared.rows.length / TABLE_ROWS_PART)) }
    if (info.full === undefined && info.text === undefined && info.pages === undefined) {
      info.note = kind === 'video' ? '这段视频手机上放不了,到电脑上看' : kind === 'audio' ? '这段声音手机上放不了,到电脑上听' : onDesk
    }
    else if (kind === 'slides' || kind === 'sheet') info.note = onDesk
    prepared.info = info
    return remember(source.key, prepared)
  }

  return {
    hitsOf: attachmentHits,

    async file(query) {
      const source = await resolve(query)
      if ('ok' in source) return source
      if (source.type !== 'file') return { ok: false, status: 403, error: '这张图只在对话记录里,电脑上没有这个文件 —— 看是能看的,存不下来' }
      if (source.size <= 0) return { ok: false, status: 403, error: '这不是一个普通文件,不传' }
      return { ok: true, value: { path: source.path, name: source.name, bytes: source.size, where: '这条对话里' } }
    },

    async read(query) {
      const source = await resolve(query)
      if ('ok' in source) return source
      if (source.type === 'file' && !(await stat(source.path).then(info => info.isFile() || info.isDirectory()).catch(() => false))) return fail(410, '电脑上这个文件已经不在了')
      const prepared = await prepare(source)
      const info = { ...prepared.info, ref: query.ref }
      if (query.view === 'info') return { ok: true, value: info }
      const part = Math.max(0, Math.floor(query.part ?? 0))
      if (query.view === 'thumb') {
        if (prepared.thumb === undefined) return fail(404, '这个文件出不了缩略图')
        return { ok: true, value: { ref: query.ref, view: 'thumb', part: 0, parts: 1, mime: prepared.thumb.mime, data: prepared.thumb.bytes.toString('base64') } }
      }
      if (query.view === 'full') {
        const full = prepared.full
        if (full === undefined || info.full === undefined) return fail(404, '这个文件手机上打不开,到电脑上看')
        if (part >= info.full.parts) return fail(400, '没有这一块')
        const from = part * SESSION_ATTACHMENT_PART_BYTES
        const length = Math.min(SESSION_ATTACHMENT_PART_BYTES, full.size - from)
        const bytes = full.bytes !== undefined ? full.bytes.subarray(from, from + length) : await readSlice(full.path!, from, length)
        return { ok: true, value: { ref: query.ref, view: 'full', part, parts: info.full.parts, mime: full.mime, data: bytes.toString('base64') } }
      }
      if (query.view === 'text') {
        if (info.text === undefined) return fail(404, '这个文件读不成文字')
        if (part >= info.text.parts) return fail(400, '没有这一块')
        if (prepared.rows !== undefined) return { ok: true, value: { ref: query.ref, view: 'text', part, parts: info.text.parts, rows: prepared.rows.slice(part * TABLE_ROWS_PART, (part + 1) * TABLE_ROWS_PART) } }
        const text = prepared.text ?? ''
        return { ok: true, value: { ref: query.ref, view: 'text', part, parts: info.text.parts, text: text.slice(part * SESSION_ATTACHMENT_TEXT_PART, (part + 1) * SESSION_ATTACHMENT_TEXT_PART) } }
      }
      // page
      if (info.pages === undefined || source.type !== 'file') return fail(404, '这个文件不能逐页看')
      const page = Math.max(0, Math.floor(query.page ?? query.part ?? 0))
      if (page >= info.pages) return fail(400, '没有这一页')
      const pageKey = `${source.key}|page|${page}`
      const cached = recall(pageKey)?.thumb
      const jpeg = cached?.bytes ?? await tools.pdfPage(source.path, page, PAGE_PX)
      if (jpeg === undefined) return fail(404, '这一页出不了图,到电脑上看')
      if (cached === undefined) remember(pageKey, { info, thumb: { mime: 'image/jpeg', bytes: jpeg } })
      return { ok: true, value: { ref: query.ref, view: 'page', part: page, parts: info.pages, mime: 'image/jpeg', data: jpeg.toString('base64') } }
    },
  }
}

async function readSlice(path: string, from: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    return buffer.subarray(0, bytesRead)
  }
  finally {
    await handle.close()
  }
}

/** 读成文字;太大或者看着是二进制(有 NUL)就 undefined。 */
async function readText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (info.size > TEXT_READ_MAX) return undefined
    const bytes = await readFile(path)
    if (bytes.subarray(0, 8192).includes(0)) return undefined
    return bytes.toString('utf8')
  }
  catch {
    return undefined
  }
}

/** 记录里的图要交给 Mac 工具转:先写进临时目录,转完整个删掉。 */
async function withTempFile<T>(bytes: Buffer, ext: string, work: (file: string) => Promise<T | undefined>): Promise<T | undefined> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'wb-attach-'))
    const file = join(dir, `in.${ext}`)
    await writeFile(file, bytes)
    return await work(file)
  }
  catch {
    return undefined
  }
  finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
