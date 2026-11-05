// @vitest-environment node
/**
 * **豆包出的图从它自己的本机缓存里取原图**(2026-10-12,卡「演示 · 出图进可灵」)。
 *
 * 豆包办公是 Chromium 外壳,对话在 IndexedDB 里读不了(交接-1008),但它显示过的每一张图都进了
 * `~/Library/Caches/Doubao/Default/Cache/Cache_Data` 的「简单缓存」:一张图一个 `<hash>_0` 文件,
 * 头 24 字节 + 网址 + 图的原始字节 + 结尾标记 + 响应头。这里按格式拆出来,挑「派活之后才出现的、够大的那张」。
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeImageScan, discoverDoubaoCacheDirs, findDoubaoImage, imageInfo, parseSimpleCacheEntry, pickGeneratedImage,
} from '../src/server/doubaoImage.ts'
import type { CachedImage } from '../src/server/doubaoImage.ts'

const MAGIC = Buffer.from('d8410d97456ffaf4', 'hex') // 0xf4fa6f45970d41d8,小端

function png(w: number, h: number): Buffer {
  const head = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const size = Buffer.alloc(8)
  size.writeUInt32BE(w, 0)
  size.writeUInt32BE(h, 4)
  return Buffer.concat([head, size, Buffer.alloc(64, 7)])
}

function jpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255])
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0]), sof, Buffer.alloc(32)])
}

function eof(flags: number, size: number): Buffer {
  const b = Buffer.alloc(24)
  MAGIC.copy(b, 0)
  b.writeUInt32LE(flags, 8)
  b.writeUInt32LE(size, 16)
  return b
}

/** 照 Chromium 简单缓存 `_0` 文件的排法拼一份:头、键、正文、EOF、响应头、键的摘要、EOF。 */
function entry(url: string, body: Buffer, contentType = 'image/png'): Buffer {
  const key = Buffer.from(`1/0/_dk_chrome://doubao-chat chrome://doubao-chat ${url}`)
  const head = Buffer.alloc(24)
  Buffer.from('30c5a2fcb8a4e5fc', 'hex').copy(head, 0)
  head.writeUInt32LE(5, 8)
  head.writeUInt32LE(key.length, 12)
  const headers = Buffer.from(`HTTP/2.0 200 OK\0content-type: ${contentType}\0\0`)
  return Buffer.concat([head, key, body, eof(1, 0), headers, Buffer.alloc(32), eof(3, headers.length)])
}

describe('拆一份缓存条目', () => {
  it('拆出网址、正文与 content-type', () => {
    const body = png(1024, 768)
    const got = parseSimpleCacheEntry(entry('https://p3-flow-imagex-sign.byteimg.com/a/b.png~x.png?x=1', body))
    expect(got?.url).toBe('https://p3-flow-imagex-sign.byteimg.com/a/b.png~x.png?x=1')
    expect(got?.contentType).toBe('image/png')
    expect(got?.body.equals(body)).toBe(true)
  })

  it('不是缓存条目的文件 → 不认', () => {
    expect(parseSimpleCacheEntry(Buffer.from('hello'))).toBeUndefined()
    expect(parseSimpleCacheEntry(Buffer.alloc(40))).toBeUndefined()
  })
})

describe('图的格式与尺寸(只看文件头)', () => {
  it('PNG / JPEG / WebP', () => {
    expect(imageInfo(png(1280, 720))).toEqual({ mime: 'image/png', ext: 'png', width: 1280, height: 720 })
    expect(imageInfo(jpeg(800, 1200))).toEqual({ mime: 'image/jpeg', ext: 'jpg', width: 800, height: 1200 })
    const webp = Buffer.alloc(40)
    webp.write('RIFF', 0)
    webp.write('WEBPVP8X', 8)
    webp.writeUIntLE(1919, 24, 3)
    webp.writeUIntLE(1079, 27, 3)
    expect(imageInfo(webp)).toEqual({ mime: 'image/webp', ext: 'webp', width: 1920, height: 1080 })
    expect(imageInfo(Buffer.from('not an image'))).toBeUndefined()
  })
})

describe('挑哪一张', () => {
  const since = Date.parse('2026-10-14T10:00:00+08:00')
  const one = (url: string, w: number, h: number, at: number): CachedImage => ({
    url, mtimeMs: at, body: png(w, h), info: { mime: 'image/png', ext: 'png', width: w, height: h },
  })

  it('只认派活之后才出现的、够大的;图标、头像、缩略图不算;同一张取最大那份', () => {
    const picked = pickGeneratedImage([
      one('https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/old.png', 2048, 2048, since - 60_000),
      one('https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc/icon/abc~tplv.png', 1024, 1024, since + 5000),
      one('https://p26-flow-imagex-sign.byteimg.com/user-avatar/x~tplv-icon-tiny.jpeg', 512, 512, since + 5000),
      one('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/aaa~tplv-thumb.png', 320, 180, since + 9000),
      one('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/aaa~tplv-origin.png', 1920, 1080, since + 8000),
    ], since)
    expect(picked?.url).toContain('tplv-origin')
  })

  it('一张都没有 → undefined(不拿旧图凑)', () => {
    expect(pickGeneratedImage([one('https://x.byteimg.com/a.png', 2048, 2048, since - 1)], since)).toBeUndefined()
  })
})

describe('从缓存目录里找', () => {
  it('只读派活之后改过的 `_0` 文件,找到就带回原图字节', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doubao-cache-'))
    const since = Date.now() - 10_000
    const gen = png(1536, 1024)
    writeFileSync(join(dir, 'aaaa_0'), entry('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/new.png', gen))
    writeFileSync(join(dir, 'bbbb_0'), entry('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/old.png', png(2048, 2048)))
    const old = (since - 3_600_000) / 1000
    utimesSync(join(dir, 'bbbb_0'), old, old)
    writeFileSync(join(dir, 'index'), 'x')
    const got = await findDoubaoImage({ cacheDirs: [dir, join(dir, 'missing')], since })
    expect(got?.url).toContain('new.png')
    expect(got?.body.equals(gen)).toBe(true)
    expect(got?.info.width).toBe(1536)
  })
})

/* ──────── ★ 找图那一趟留一行:2026-10-13 晚演示机那一单(卡 Q)──────── */

/**
 * ★ 演示机 20:55 那一单:「豆包回话了,但在它的本机缓存里没找到这一轮出的图」——
 * **看不出是路径变了还是尺寸筛掉了**(那台豆包比本机新,缓存目录名没核过)。
 * 所以每一趟留一行:找了哪几个目录、各几条、新的几条、认出是图几张、按哪一条排掉的各几张、挑了哪张。
 * **判据一个字没改**,只是把看到的东西说出来。
 */
describe('★找图那一趟写一行', () => {
  it('哪几个目录、各几张候选、为什么排掉、挑了哪张', () => {
    const line = describeImageScan({
      dirs: [{ dir: '/h/Library/Caches/Doubao/Default/Cache/Cache_Data', entries: 120, fresh: 4, images: 3 }],
      tooSmall: 1,
      byUrl: 1,
      unknown: 2,
      picked: { url: 'https://x/rc_gen_image/a.png', width: 1536, height: 1024 },
    })
    expect(line).toContain('/h/Library/Caches/Doubao/Default/Cache/Cache_Data')
    expect(line).toContain('120')
    expect(line).toContain('1536×1024')
    expect(line).toContain('太小 1')
    expect(line).toContain('认不出格式 2')
    // 一个目录都没找到 / 一张都没挑出来,也要说得出来(这正是演示机那一单要看的)。
    const none = describeImageScan({ dirs: [], tooSmall: 0, byUrl: 0, unknown: 0 })
    expect(none).toContain('一个豆包缓存目录都没找到')
    expect(none).toContain('一张都没挑出来')
  })

  it('真走一趟:目录、条数、排掉的原因都对得上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doubao-scan-'))
    const since = Date.now() - 10_000
    writeFileSync(join(dir, 'aaaa_0'), entry('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/new.png', png(1536, 1024)))
    // 太小的那张(短边 < 480)与网址一看就不是她要的那张。
    writeFileSync(join(dir, 'bbbb_0'), entry('https://p9-flow-imagex-sign.byteimg.com/rc_gen_image/small.png', png(320, 180)))
    writeFileSync(join(dir, 'cccc_0'), entry('https://p9-flow-imagex-sign.byteimg.com/rc/icon/i.png', png(1024, 1024)))
    // 认不出格式的那一条(不是图)。
    writeFileSync(join(dir, 'dddd_0'), entry('https://p9-flow-imagex-sign.byteimg.com/x.bin', Buffer.alloc(40, 3), 'image/png'))
    const lines: string[] = []
    const got = await findDoubaoImage({ cacheDirs: [dir, join(dir, 'missing')], since, log: one => lines.push(one) })
    expect(got?.url).toContain('new.png')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(dir)
    expect(lines[0]).toContain('太小 1')
    expect(lines[0]).toContain('认不出格式 1')
    expect(lines[0]).toContain('1536×1024')
  })
})

describe('缓存目录现找(两个豆包包各自的目录名不一样)', () => {
  it('Caches / Application Support 底下名字带 doubao 的、有 Default/Cache/Cache_Data 的都算', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doubao-home-'))
    for (const dir of ['Library/Caches/Doubao', 'Library/Caches/DoubaoWork', 'Library/Application Support/com.work.pc.doubao']) {
      mkdirSync(join(home, dir, 'Default/Cache/Cache_Data'), { recursive: true })
    }
    mkdirSync(join(home, 'Library/Caches/Kimi/Default/Cache/Cache_Data'), { recursive: true })
    mkdirSync(join(home, 'Library/Caches/doubao-empty'), { recursive: true })
    const got = await discoverDoubaoCacheDirs(home)
    expect(got.map(one => one.slice(home.length)).sort()).toEqual([
      '/Library/Application Support/com.work.pc.doubao/Default/Cache/Cache_Data',
      '/Library/Caches/Doubao/Default/Cache/Cache_Data',
      '/Library/Caches/DoubaoWork/Default/Cache/Cache_Data',
    ])
  })
})
