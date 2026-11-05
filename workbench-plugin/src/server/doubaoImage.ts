/**
 * **豆包出的图,从它自己的本机缓存里取原图**(2026-10-12,卡「演示 · 出图进可灵」)。
 *
 * 豆包办公的对话在 Chromium IndexedDB 里,按表读不了(`docs/交接-1008-新接一家先找记录.md`);
 * 可它**显示过的每一张图**都进了 Chromium 的 HTTP 缓存(「简单缓存」格式):一个 `<hash>_0` 文件 =
 * 24 字节头 + 网址(键)+ 图的原始字节 + 结尾标记 + 响应头。这是原图,不是截屏。
 *
 * 挑法(纯函数 {@link pickGeneratedImage}):派活之后才写进缓存的、`content-type` 是图、
 * 短边够大(图标 / 头像 / 缩略图都小)的那几张里取像素最多的那张。只读、不写、不删缓存里任何东西。
 *
 * 取不到(缓存关了 / 豆包换了图床 / 还没显示出来)就如实回 `undefined`,调用方说「图出来了但没取到」,
 * **不截屏凑一张**。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 简单缓存条目的结尾标记(`SimpleFileEOF::kSimpleFinalMagicNumber`),文件里小端存。 */
const EOF_MAGIC = 0xF4FA6F45970D41D8n
const EOF_SIZE = 24
const HEADER_SIZE = 24

/** 豆包办公本机包(`com.bot.pc.doubao`)的缓存目录 —— 这台 Mac 上核过的那一个。 */
export function doubaoCacheDirs(home = homedir()): string[] {
  return [join(home, 'Library/Caches/Doubao/Default/Cache/Cache_Data')]
}

/**
 * **现找**豆包的缓存目录:`~/Library/Caches` 与 `~/Library/Application Support` 底下名字带 doubao(不分大小写)、
 * 而且真有 `Default/Cache/Cache_Data` 的都算。两个包(本机 `com.bot.pc.doubao`、Air 上的维护包 `com.work.pc.doubao`)
 * 各自的目录名不一样,维护包那个没在真机上见过 —— 所以不写死,找得到几个算几个。
 */
export async function discoverDoubaoCacheDirs(home = homedir()): Promise<string[]> {
  const out: string[] = []
  for (const base of ['Library/Caches', 'Library/Application Support']) {
    const names = await readdir(join(home, base)).catch(() => [] as string[])
    for (const name of names) {
      if (!/doubao/i.test(name)) continue
      const dir = join(home, base, name, 'Default/Cache/Cache_Data')
      const st = await stat(dir).catch(() => undefined)
      if (st?.isDirectory() === true) out.push(dir)
    }
  }
  return out
}

export interface CacheEntry {
  url: string
  contentType?: string
  body: Buffer
}

/** 拆一份 `_0` 文件。认不出格式就 `undefined`(不猜)。 */
export function parseSimpleCacheEntry(buf: Buffer): CacheEntry | undefined {
  if (buf.length < HEADER_SIZE + EOF_SIZE * 2) return undefined
  const keyLen = buf.readUInt32LE(12)
  const bodyStart = HEADER_SIZE + keyLen
  if (keyLen === 0 || bodyStart > buf.length) return undefined
  // 第一个结尾标记 = 正文(stream 1)到此为止;第二个在文件末尾,带响应头(stream 0)的长度。
  const magic = Buffer.alloc(8)
  magic.writeBigUInt64LE(EOF_MAGIC)
  const firstEof = buf.indexOf(magic, bodyStart)
  if (firstEof < 0) return undefined
  const key = buf.subarray(HEADER_SIZE, bodyStart).toString('utf8')
  const url = key.split(' ').at(-1) ?? ''
  if (!/^https?:\/\//.test(url)) return undefined
  const tail = buf.subarray(firstEof + EOF_SIZE)
  const headers = tail.toString('latin1')
  const contentType = /content-type:\s*([^\0;\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase()
  return { url, ...(contentType === undefined ? {} : { contentType }), body: buf.subarray(bodyStart, firstEof) }
}

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  ext: 'png' | 'jpg' | 'webp'
  width: number
  height: number
}

/** 只看文件头认格式与尺寸。认不出就 `undefined`。 */
export function imageInfo(body: Buffer): ImageInfo | undefined {
  if (body.length >= 24 && body.readUInt32BE(0) === 0x89504E47 && body.toString('latin1', 12, 16) === 'IHDR') {
    return { mime: 'image/png', ext: 'png', width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
  }
  if (body.length >= 4 && body[0] === 0xFF && body[1] === 0xD8) {
    let at = 2
    while (at + 9 < body.length) {
      if (body[at] !== 0xFF) return undefined
      const marker = body[at + 1] as number
      const len = body.readUInt16BE(at + 2)
      // SOF0..SOF15,除去 DHT(C4)、JPG(C8)、DAC(CC)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { mime: 'image/jpeg', ext: 'jpg', height: body.readUInt16BE(at + 5), width: body.readUInt16BE(at + 7) }
      }
      at += 2 + len
    }
    return undefined
  }
  if (body.length >= 30 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = body.toString('latin1', 12, 16)
    if (chunk === 'VP8X') return { mime: 'image/webp', ext: 'webp', width: body.readUIntLE(24, 3) + 1, height: body.readUIntLE(27, 3) + 1 }
    if (chunk === 'VP8 ' && body.length >= 30) return { mime: 'image/webp', ext: 'webp', width: body.readUInt16LE(26) & 0x3FFF, height: body.readUInt16LE(28) & 0x3FFF }
    if (chunk === 'VP8L' && body.length >= 25) {
      const bits = body.readUInt32LE(21)
      return { mime: 'image/webp', ext: 'webp', width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }
    }
  }
  return undefined
}

export interface CachedImage {
  url: string
  mtimeMs: number
  body: Buffer
  info: ImageInfo
}

/** 短边小于它的不算「出的图」(界面图标 64、头像 128、对话里的缩略图 320 上下)。 */
export const GENERATED_MIN_SIDE = 480

/** 网址上一看就不是她要的那张:图标、头像、人脸裁切、表情。 */
const NOT_GENERATED = [/\/rc\/icon\//, /user-avatar/, /icon-tiny/, /smart_face_crop/, /\/emoji\//]

/** 同一张图不同尺寸的那几份,网址去掉 `~tplv…` 与查询串之后是同一个。 */
function sameImageKey(url: string): string {
  return url.replace(/\?.*$/, '').replace(/~tplv.*$/, '').replace(/^https?:\/\/p\d+-/, 'https://p-')
}

/**
 * 挑出「这一轮豆包出的那张图」。派活之前就在缓存里的一律不算(那是别的对话里的图)。
 * 同一张图缓存了几种尺寸时取像素最多那份;几张不同的图都新出现时取像素最多、再取最新的。
 */
export function pickGeneratedImage(images: readonly CachedImage[], since: number): CachedImage | undefined {
  const fresh = images.filter(one => one.mtimeMs >= since
    && Math.min(one.info.width, one.info.height) >= GENERATED_MIN_SIDE
    && !NOT_GENERATED.some(re => re.test(one.url)))
  const best = new Map<string, CachedImage>()
  for (const one of fresh) {
    const key = sameImageKey(one.url)
    const had = best.get(key)
    if (had === undefined || area(one) > area(had)) best.set(key, one)
  }
  return [...best.values()].sort((a, b) => area(b) - area(a) || b.mtimeMs - a.mtimeMs)[0]
}

function area(one: CachedImage): number {
  return one.info.width * one.info.height
}

export interface FindDoubaoImageInput {
  cacheDirs: readonly string[]
  /** 派活那一刻(毫秒)。只看这之后改过的条目。 */
  since: number
  /**
   * ★ **这一趟看到了什么,留一行**(2026-10-13 晚,卡 Q)。
   *
   * 演示机 20:55 那一单卡上写的是「豆包回话了,但在它的本机缓存里没找到这一轮出的图」——
   * 诊断包里**看不出是路径变了还是尺寸筛掉了**(那台豆包比本机新,缓存目录名没核过)。
   * 所以每一趟把看到的东西说出来(见 {@link describeImageScan});**判据一个字没改**。缺席 = 不写。
   */
  log?: (line: string) => void
}

/** 一个缓存目录里看到了什么。 */
export interface ImageScanDir {
  dir: string
  /** 目录里 `_0` 文件总共几条。 */
  entries: number
  /** 其中派活之后改过的几条。 */
  fresh: number
  /** 其中认出是图的几张。 */
  images: number
}

export interface ImageScanTally {
  dirs: readonly ImageScanDir[]
  /** 新出现的图里按这几条排掉的各几张:短边不够、网址一看就不是她要的那张、认不出格式 / 不是图。 */
  tooSmall: number
  byUrl: number
  unknown: number
  picked?: { url: string, width: number, height: number }
}

/** 一趟找图写成一行人话(进日志;接力那一层另有卡上那一句)。 */
export function describeImageScan(tally: ImageScanTally): string {
  const dirs = tally.dirs.length === 0
    ? '一个豆包缓存目录都没找到'
    : tally.dirs.map(one => `${one.dir}(${one.entries} 条,新的 ${one.fresh},认出是图 ${one.images})`).join(';')
  const dropped = `排掉:太小 ${tally.tooSmall}、网址不像出的图 ${tally.byUrl}、认不出格式 ${tally.unknown}`
  const picked = tally.picked === undefined
    ? '一张都没挑出来'
    : `挑了 ${tally.picked.width}×${tally.picked.height} ${tally.picked.url}`
  return `[取图] ${dirs};${dropped};${picked}`
}

/** 读缓存目录里派活之后改过的 `_0` 文件,挑出那张图。目录不在 / 读不了 → 跳过;一张都没有 → `undefined`。 */
export async function findDoubaoImage(input: FindDoubaoImageInput): Promise<CachedImage | undefined> {
  const found: CachedImage[] = []
  const dirs: ImageScanDir[] = []
  let unknown = 0
  for (const dir of input.cacheDirs) {
    const names = await readdir(dir).catch(() => undefined)
    if (names === undefined) continue
    const tally: ImageScanDir = { dir, entries: 0, fresh: 0, images: 0 }
    dirs.push(tally)
    for (const name of names) {
      if (!name.endsWith('_0')) continue
      tally.entries += 1
      const file = join(dir, name)
      const st = await stat(file).catch(() => undefined)
      if (st === undefined || !st.isFile() || st.mtimeMs < input.since) continue
      tally.fresh += 1
      const parsed = parseSimpleCacheEntry(await readFile(file).catch(() => Buffer.alloc(0)))
      if (parsed === undefined || (parsed.contentType !== undefined && !parsed.contentType.startsWith('image/'))) { unknown += 1; continue }
      const info = imageInfo(parsed.body)
      if (info === undefined) { unknown += 1; continue }
      tally.images += 1
      found.push({ url: parsed.url, mtimeMs: st.mtimeMs, body: parsed.body, info })
    }
  }
  const picked = pickGeneratedImage(found, input.since)
  if (input.log !== undefined) {
    input.log(describeImageScan({
      dirs,
      tooSmall: found.filter(one => Math.min(one.info.width, one.info.height) < GENERATED_MIN_SIDE).length,
      byUrl: found.filter(one => NOT_GENERATED.some(re => re.test(one.url))).length,
      unknown,
      ...(picked === undefined ? {} : { picked: { url: picked.url, width: picked.info.width, height: picked.info.height } }),
    }))
  }
  return picked
}
