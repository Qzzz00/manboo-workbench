// @vitest-environment node
/**
 * 对话里的附件(2026-10-01,手机读对话卡 C;维护者:「图片、视频、md 文件这些东西,肯定也是不支持显示」;
 * 统筹补:「任何文件至少有一张卡,能读的就显示内容」「转换都在 Mac 那头做,手机只收转好的」)。
 *
 * ① 列:她贴的图(记录里的 base64)、它那边的截图(工具结果里的图)、对话里提到的本机文件(含不在了的);
 * ② 取:**只认这条会话里出现过的** —— 附件编号指向记录里的那一行,路径必须真在那一行里;伪造的、半行的一律不给;
 * ③ 分块:每块 ≤ 512KB(base64 后装得进中转 1MB 一条);
 * ④ 每一类怎么看:图片(HEIC 转 JPEG)、视频、音频(不常见的格式转 m4a)、md / 文本 / 代码(json 排版)、
 *    csv / tsv 成表、html(给手机放进不跑脚本的框)、docx 正文、PDF 逐页、幻灯片 / 表格 / 压缩包只给缩略图 + 一句;
 * ⑤ 像密钥的文件不列不给;Mac 工具出不来就退一档(没缩略图),不报错。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_ATTACHMENT_PART_BYTES, type SessionAttachmentChunk, type SessionAttachmentInfo, type SessionAttachmentRef, type SessionTranscriptEntry } from '../src/protocol.ts'
import { createSessionAttachments, type MacPreviewTools } from '../src/server/sessionAttachments.ts'
import type { SessionFileRef } from '../src/server/sessionHistory.ts'
import { createSessionTranscript } from '../src/server/sessionTranscript.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const line = (row: unknown) => JSON.stringify(row)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-attach-'))
  dirs.push(dir)
  return dir
}

/** 假的 Mac 工具:记下被叫了什么,回固定的字节。 */
function fakeTools(over: Partial<MacPreviewTools> = {}) {
  const calls: string[] = []
  const tools: MacPreviewTools = {
    async thumbnail(file) { calls.push(`thumb:${file.split('/').pop()}`); return { mime: 'image/png', bytes: Buffer.from('THUMB') } },
    async toJpeg(file) { calls.push(`jpeg:${file.split('/').pop()}`); return Buffer.from('JPEG') },
    async toHtml(file) { calls.push(`html:${file.split('/').pop()}`); return '<p>正文</p>' },
    async toM4a(file) { calls.push(`m4a:${file.split('/').pop()}`); return Buffer.from('M4A') },
    async pdfPages() { return 3 },
    async pdfPage(_file, page) { calls.push(`page:${page}`); return Buffer.from(`PAGE${page}`) },
    ...over,
  }
  return { tools, calls }
}

function setup(rows: string[], options: { tools?: MacPreviewTools } = {}) {
  const dir = tmp()
  const file = join(dir, 's.jsonl')
  writeFileSync(file, `${rows.join('\n')}\n`)
  const ref: SessionFileRef = { agent: 'claude', session_id: 's', file, format: 'claude-transcript' }
  const locate = async (agent: string, id: string) => (agent === 'claude' && id === 's' ? ref : undefined)
  const attachments = createSessionAttachments({ locate, ...(options.tools === undefined ? {} : { tools: options.tools }) })
  const transcript = createSessionTranscript({ locate, attachmentsOf: attachments.hitsOf })
  const entries = async (): Promise<SessionTranscriptEntry[]> => {
    const got = await transcript.read({ agent: 'claude', id: 's' })
    if (!got.ok) throw new Error(got.error)
    return got.value.entries
  }
  const info = async (attachment: string) => {
    const got = await attachments.read({ agent: 'claude', id: 's', ref: attachment, view: 'info' })
    return got.ok ? got.value as SessionAttachmentInfo : got
  }
  const chunk = async (attachment: string, view: 'thumb' | 'full' | 'text' | 'page', n = 0) => {
    const got = await attachments.read({ agent: 'claude', id: 's', ref: attachment, view, part: n, page: n })
    return got.ok ? got.value as SessionAttachmentChunk : got
  }
  return { dir, file, entries, info, chunk, attachments }
}

const refsOf = (entries: readonly SessionTranscriptEntry[]): SessionAttachmentRef[] => entries.flatMap(entry => (entry.k === 'note' ? [] : entry.attachments ?? []))

function ask(content: unknown, at = '2026-09-30T13:00:00Z') {
  return line({ type: 'user', sessionId: 's', timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } })
}
function say(text: string) {
  return line({ type: 'assistant', sessionId: 's', timestamp: '2026-09-30T13:05:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
}

describe('列出附件', () => {
  it('★她贴的截图:挂在她那句上;取得回原图的字节;缩略图在电脑上做', async () => {
    const { tools, calls } = fakeTools()
    const t = setup([ask([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }, { type: 'text', text: '看这张' }]), say('看到了')], { tools })
    const entries = await t.entries()
    expect(entries[0]).toMatchObject({ k: 'ask', text: '看这张', attachments: [{ kind: 'image', from: 'you', name: '图片 1.png', bytes: PNG.length }] })
    const ref = refsOf(entries)[0]!.ref
    const info = await t.info(ref) as SessionAttachmentInfo
    expect(info).toMatchObject({ kind: 'image', mime: 'image/png', bytes: PNG.length, thumb: true, full: { mime: 'image/png', bytes: PNG.length, parts: 1 } })
    const full = await t.chunk(ref, 'full') as SessionAttachmentChunk
    expect(Buffer.from(full.data!, 'base64')).toEqual(PNG)
    // 小图直接拿原图当缩略图,不劳 Mac 工具
    expect((await t.chunk(ref, 'thumb') as SessionAttachmentChunk).mime).toBe('image/png')
    expect(calls).toEqual([])
  })

  it('★大图分块:每块不超过上限,拼起来就是原图', async () => {
    const big = Buffer.alloc(SESSION_ATTACHMENT_PART_BYTES * 2 + 100, 7)
    const t = setup([ask([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: big.toString('base64') } }])], { tools: fakeTools().tools })
    const ref = refsOf(await t.entries())[0]!.ref
    const info = await t.info(ref) as SessionAttachmentInfo
    expect(info.full?.parts).toBe(3)
    const parts = await Promise.all([0, 1, 2].map(async n => Buffer.from((await t.chunk(ref, 'full', n) as SessionAttachmentChunk).data!, 'base64')))
    expect(parts.every(part => part.length <= SESSION_ATTACHMENT_PART_BYTES)).toBe(true)
    expect(Buffer.concat(parts)).toEqual(big)
    // 大图的缩略图交给 Mac 工具缩(临时文件用完即删)
    expect((await t.chunk(ref, 'thumb') as SessionAttachmentChunk).data).toBe(Buffer.from('JPEG').toString('base64'))
  })

  it('它那边的截图(工具结果里的图):挂在那几步上,算它的', async () => {
    const t = setup([
      ask('截个图看看'),
      line({ type: 'assistant', timestamp: '2026-09-30T13:01:00Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'mcp__computer-use__screenshot', input: {} }] } }),
      line({ type: 'user', timestamp: '2026-09-30T13:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }] } }),
      say('截好了'),
    ])
    const entries = await t.entries()
    expect(entries.map(entry => entry.k)).toEqual(['ask', 'steps', 'reply'])
    expect(entries[1]).toMatchObject({ k: 'steps', attachments: [{ kind: 'image', from: 'ai', name: '截图 1.png' }] })
  })

  it('★对话里提到的本机文件:列出来(不在了的也列,标不在了);像密钥的不列;同一个只列一次', async () => {
    const dir = tmp()
    const md = join(dir, '交接 报告.md')
    writeFileSync(md, '# 交接\n\n- 一\n')
    mkdirSync(join(dir, 'shots'))
    const png = join(dir, 'shots', 'a.png')
    writeFileSync(png, PNG)
    const t = setup([
      ask(`看看 ${png} 这张`),
      say(`写好了:\`${md}\`,截图在 ${png},旧的 ${join(dir, 'gone.mp4')} 删了。钥匙在 ~/.ssh/id_rsa 别动。`),
    ])
    const entries = await t.entries()
    expect(entries[0]).toMatchObject({ attachments: [{ name: 'a.png', kind: 'image', from: 'you', bytes: PNG.length }] })
    const reply = entries[1] as Extract<SessionTranscriptEntry, { k: 'reply' }>
    expect(reply.attachments?.map(one => [one.name, one.kind, one.missing === true])).toEqual([
      ['交接 报告.md', 'markdown', false],
      ['a.png', 'image', false],
      ['gone.mp4', 'video', true],
    ])
    const text = await t.chunk(reply.attachments![0]!.ref, 'text') as SessionAttachmentChunk
    expect(text.text).toBe('# 交接\n\n- 一\n')
  })
})

describe('只认这条会话里出现过的', () => {
  it('★伪造的编号(换一条路径)、半行的偏移、不存在的会话:一律不给', async () => {
    const dir = tmp()
    const md = join(dir, 'a.md')
    writeFileSync(md, 'x')
    writeFileSync(join(dir, 'secret.md'), 'SECRET')
    const t = setup([ask('前一句'), say(`在 ${md}`)])
    const ref = refsOf(await t.entries())[0]!.ref
    const forged = ref.replace(Buffer.from(md).toString('base64url'), Buffer.from(join(dir, 'secret.md')).toString('base64url'))
    const bad = await t.info(forged)
    expect('status' in bad && bad.status).toBe(403)
    const offset = Number(ref.split('~')[0])
    const half = await t.info(`${offset + 3}~${ref.split('~').slice(1).join('~')}`)
    expect('status' in half && half.status).toBe(400)
    const gone = await t.attachments.read({ agent: 'claude', id: 'nope', ref, view: 'info' })
    expect(gone.ok ? 200 : gone.status).toBe(404)
    for (const junk of ['', 'abc', '12', '12~x/../../etc']) {
      const got = await t.info(junk)
      expect('status' in got && got.status, junk).toBe(400)
    }
  })
})

describe('每一类怎么看(转换都在电脑上做)', () => {
  async function one(name: string, body: Buffer | string, tools = fakeTools()) {
    const dir = tmp()
    const path = join(dir, name)
    writeFileSync(path, body)
    const t = setup([ask('看看'), say(`在这:${path}`)], { tools: tools.tools })
    const ref = refsOf(await t.entries())[0]!
    return { t, ref, info: await t.info(ref.ref) as SessionAttachmentInfo, calls: tools.calls }
  }

  it('md / 文本 / 代码:全文;json 排版;大文件分段', async () => {
    expect((await one('a.md', '# 标题')).info.text).toEqual({ format: 'markdown', parts: 1 })
    expect((await one('run.log', 'line1\nline2')).info.text).toMatchObject({ format: 'plain' })
    const code = await one('x.ts', 'const a = 1')
    expect(code.info).toMatchObject({ kind: 'code', text: { format: 'code', lang: 'ts' } })
    const json = await one('d.json', '{"a":[1,2]}')
    expect((await json.t.chunk(json.ref.ref, 'text') as SessionAttachmentChunk).text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    const big = await one('big.txt', 'x'.repeat(450_000))
    expect(big.info.text?.parts).toBe(3)
    expect((await big.t.chunk(big.ref.ref, 'text', 2) as SessionAttachmentChunk).text).toHaveLength(50_000)
  })

  it('★csv / tsv 渲染成表格(带引号、逗号的格子)', async () => {
    const csv = await one('a.csv', 'name,note\n"张三","说了一句,带逗号"\n李四,"有""引号"""\n')
    expect(csv.info).toMatchObject({ kind: 'table', text: { format: 'table', parts: 1 } })
    expect((await csv.t.chunk(csv.ref.ref, 'text') as SessionAttachmentChunk).rows).toEqual([['name', 'note'], ['张三', '说了一句,带逗号'], ['李四', '有"引号"']])
    const tsv = await one('b.tsv', 'a\tb\n1\t2')
    expect((await tsv.t.chunk(tsv.ref.ref, 'text') as SessionAttachmentChunk).rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('html 给原文(手机放进不跑脚本的框);docx / rtf 在电脑上转成正文', async () => {
    const html = await one('p.html', '<h1>页</h1><script>alert(1)</script>')
    expect(html.info.text?.format).toBe('html')
    const doc = await one('合同.docx', 'PK-fake')
    expect(doc.info).toMatchObject({ kind: 'document', text: { format: 'html' }, thumb: true })
    expect((await doc.t.chunk(doc.ref.ref, 'text') as SessionAttachmentChunk).text).toBe('<p>正文</p>')
    expect(doc.calls).toContain('html:合同.docx')
  })

  it('★图片:png 原样;HEIC 在电脑上转 JPEG(安卓不认 HEIC)', async () => {
    const png = await one('a.png', PNG)
    expect(png.info.full).toEqual({ mime: 'image/png', bytes: PNG.length, parts: 1 })
    const heic = await one('IMG_0001.HEIC', 'heic-bytes')
    expect(heic.info).toMatchObject({ kind: 'image', full: { mime: 'image/jpeg', bytes: 4 } })
    expect(Buffer.from((await heic.t.chunk(heic.ref.ref, 'full') as SessionAttachmentChunk).data!, 'base64').toString()).toBe('JPEG')
  })

  it('视频:mp4 / mov 原样给(播不了手机如实说);有首帧缩略图', async () => {
    const mp4 = await one('录屏.mp4', 'mp4-bytes')
    expect(mp4.info).toMatchObject({ kind: 'video', thumb: true, full: { mime: 'video/mp4' } })
    expect((await one('a.mov', 'mov')).info.full?.mime).toBe('video/quicktime')
  })

  it('音频:mp3 原样;flac 在电脑上转 m4a', async () => {
    expect((await one('a.mp3', 'mp3')).info.full?.mime).toBe('audio/mpeg')
    const flac = await one('a.flac', 'flac')
    expect(flac.info.full).toEqual({ mime: 'audio/mp4', bytes: 3, parts: 1 })
  })

  it('★PDF 逐页看(电脑上一页出一张图)', async () => {
    const pdf = await one('说明.pdf', '%PDF-fake')
    expect(pdf.info).toMatchObject({ kind: 'pdf', pages: 3, thumb: true })
    const page = await pdf.t.chunk(pdf.ref.ref, 'page', 2) as SessionAttachmentChunk
    expect(Buffer.from(page.data!, 'base64').toString()).toBe('PAGE2')
    expect(page).toMatchObject({ view: 'page', part: 2, parts: 3, mime: 'image/jpeg' })
  })

  it('幻灯片 / 表格 / 压缩包 / 认不出的:一张卡(缩略图 + 一句「完整的到电脑上打开」),不解', async () => {
    for (const [name, kind] of [['a.pptx', 'slides'], ['b.key', 'slides'], ['c.xlsx', 'sheet'], ['d.zip', 'archive'], ['e.bin', 'other']] as const) {
      // Keynote 是个几百 KB 起的包;几 KB 的 .key 是私钥(下一条)
      const got = await one(name, name.endsWith('.key') ? Buffer.alloc(80 * 1024, 1) : 'x')
      expect(got.info, name).toMatchObject({ kind, thumb: true })
      expect(got.info.full, name).toBeUndefined()
      expect(got.info.text, name).toBeUndefined()
      expect(got.info.note, name).toMatch(/电脑上/)
    }
  })

  it('几 KB 的 .key(私钥)不给', async () => {
    const dir = tmp()
    const path = join(dir, 'server.key')
    writeFileSync(path, '-----BEGIN PRIVATE KEY-----')
    const t = setup([ask('看看'), say(`在这:${path}`)])
    const got = await t.info(refsOf(await t.entries())[0]!.ref)
    expect('status' in got && got.status).toBe(403)
  })

  it('Mac 工具出不来(没缩略图、转不了):退一档,不报错', async () => {
    const none = fakeTools({ async thumbnail() { return undefined }, async toHtml() { return undefined }, async pdfPages() { return undefined } })
    const doc = await one('a.docx', 'x', none)
    expect(doc.info).toMatchObject({ kind: 'document', thumb: false })
    expect(doc.info.text).toBeUndefined()
    expect(doc.info.note).toMatch(/电脑上/)
    const pdf = await one('a.pdf', 'x', none)
    expect(pdf.info.pages).toBeUndefined()
  })
})
