// @vitest-environment node
/**
 * 每一家对话里的图片与文件,手机上都看得到(2026-10-04,卡 `claude/phone-session-media`)。
 *
 * 维护者 10-04:「为什么 Codex 的图片和文件在手机上是显示不出来的,以此类推,其他的 Agent 是不是也不行」。
 * 查实见 `docs/交接-1004-手机看各家对话里的图片和文件.md`:断在**服务端认不出那几种写法** ——
 * 10-01 那版 Codex 只认老版 `event_msg.user_message.images`(本机 09/10 两个月的 rollout 里只剩 1 份文件在用),
 * Kimi 一张都没认。
 *
 * 下面每一条夹具都照**本机真会话里数出来的形状**写(脱敏:图换成 4 个字节的假 PNG、话换成短句),
 * 形状一个字不改 —— 真数据的来源与计数写在交接里。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionAttachmentInfo, SessionAttachmentRef, SessionTranscriptEntry } from '../src/protocol.ts'
import { attachmentIsFileRef, createSessionAttachments } from '../src/server/sessionAttachments.ts'
import type { SessionFileRef } from '../src/server/sessionHistory.ts'
import { createSessionTranscript } from '../src/server/sessionTranscript.ts'
import type { DigestFormat } from '../src/server/sessionDigest.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-att-fam-'))
  dirs.push(dir)
  return dir
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const JPG = Buffer.from('ffd8ffe000104a46', 'hex')
const b64 = (bytes: Buffer): string => bytes.toString('base64')

function setup(format: DigestFormat, rows: unknown[], options: { dir?: string, name?: string } = {}) {
  const dir = options.dir ?? tmp()
  const file = join(dir, options.name ?? 's.jsonl')
  writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const ref: SessionFileRef = { agent: 'x', session_id: 's', file, format }
  const locate = async (agent: string, id: string) => (agent === 'x' && id === 's' ? ref : undefined)
  const attachments = createSessionAttachments({ locate })
  const transcript = createSessionTranscript({ locate, attachmentsOf: attachments.hitsOf })
  return {
    dir,
    file,
    attachments,
    async entries(): Promise<SessionTranscriptEntry[]> {
      const got = await transcript.read({ agent: 'x', id: 's' })
      if (!got.ok) throw new Error(got.error)
      return got.value.entries
    },
    async info(attachment: string) {
      const got = await attachments.read({ agent: 'x', id: 's', ref: attachment, view: 'info' })
      return got.ok ? got.value as SessionAttachmentInfo : got
    },
    async full(attachment: string) {
      const got = await attachments.read({ agent: 'x', id: 's', ref: attachment, view: 'full', part: 0 })
      if (!got.ok) return got
      return Buffer.from(('data' in got.value ? got.value.data : undefined) ?? '', 'base64')
    },
    file_(attachment: string) {
      return attachments.file({ agent: 'x', id: 's', ref: attachment })
    },
  }
}

const refsOf = (entries: readonly SessionTranscriptEntry[]): SessionAttachmentRef[] =>
  entries.flatMap(entry => (entry.k === 'note' ? [] : entry.attachments ?? []))

// ───────────────────────────── Codex ─────────────────────────────

/** 新版 Codex 她那一句:`event_msg.item_completed.item(UserMessage)`。 */
const codexAsk = (content: unknown[]) => ({
  timestamp: '2026-10-04T04:57:20.429Z',
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content } },
})
const codexSay = (text: string) => ({
  timestamp: '2026-10-04T04:58:00.000Z',
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', phase: 'final_answer', content: [{ type: 'text', text }] } },
})

describe('Codex:新版记录里的图与文件', () => {
  it('★她贴的图(`local_image` 本机路径)挂在她那句上,取得回原图', async () => {
    const dir = tmp()
    const shot = join(dir, 'codex-clipboard-1.jpg')
    writeFileSync(shot, JPG)
    const t = setup('codex-rollout', [
      codexAsk([
        // 真记录里正文最前面就是这一段(Codex 自己塞的),路径也在里面。
        { type: 'text', text: `\n# Files mentioned by the user:\n\n## codex-clipboard-1.jpg: ${shot}\nImage attachment: true\n\n## My request:\n这个可以的\n` },
        { type: 'local_image', path: shot },
      ]),
      codexSay('好'),
    ], { dir })
    const entries = await t.entries()
    expect(entries[0]).toMatchObject({ k: 'ask', attachments: [{ kind: 'image', from: 'you', name: 'codex-clipboard-1.jpg', bytes: JPG.length }] })
    // 正文里那同一条路径不再列第二遍
    expect(refsOf(entries).filter(one => one.name === 'codex-clipboard-1.jpg')).toHaveLength(1)
    expect(await t.full(refsOf(entries)[0]!.ref)).toEqual(JPG)
  })

  it('★她贴的图不在了(剪贴板那种临时文件被清了):卡还在,标「不在了」', async () => {
    const gone = '/var/folders/ab/T/codex-clipboard-gone.jpg'
    const t = setup('codex-rollout', [codexAsk([{ type: 'text', text: '看这张' }, { type: 'local_image', path: gone }]), codexSay('好')])
    expect(refsOf(await t.entries())[0]).toMatchObject({ name: 'codex-clipboard-gone.jpg', missing: true, from: 'you' })
  })

  it('★她那句里内联的 data URL(`input_image`)也认', async () => {
    const t = setup('codex-rollout', [
      codexAsk([{ type: 'text', text: '看这张' }, { type: 'input_image', detail: 'original', image_url: `data:image/png;base64,${b64(PNG)}` }]),
      codexSay('好'),
    ])
    const entries = await t.entries()
    expect(entries[0]).toMatchObject({ k: 'ask', attachments: [{ kind: 'image', from: 'you', bytes: PNG.length }] })
    expect(await t.full(refsOf(entries)[0]!.ref)).toEqual(PNG)
  })

  it('★它那边的截图:工具结果里的 `{data, mimeType}` 与 `*_call_output` 里的 data URL —— 同一张只算一份', async () => {
    const t = setup('codex-rollout', [
      codexAsk([{ type: 'text', text: '看一下页面' }]),
      { timestamp: '2026-10-04T05:00:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'chrome', tool: 'screenshot', result: { content: [{ type: 'text', text: '好了' }, { type: 'image', data: b64(JPG), mimeType: 'image/jpeg' }] } } } },
      { timestamp: '2026-10-04T05:00:01Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_image', detail: 'original', image_url: `data:image/jpeg;base64,${b64(JPG)}` }] } },
      codexSay('看到了'),
    ])
    const entries = await t.entries()
    const shots = refsOf(entries).filter(one => one.from === 'ai')
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ kind: 'image', from: 'ai' })
    expect(await t.full(shots[0]!.ref)).toEqual(JPG)
    // 挂在「那几步」上,不混进她那句
    expect(entries.find(one => one.k === 'steps')?.attachments).toHaveLength(1)
  })

  it('★它写出来的非代码文件(FileChange):列出来、能读正文', async () => {
    const dir = tmp()
    const doc = join(dir, '报告.md')
    writeFileSync(doc, '# 标题\n\n正文')
    const t = setup('codex-rollout', [
      codexAsk([{ type: 'text', text: '写个报告' }]),
      { timestamp: '2026-10-04T05:10:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [doc]: { add: {} }, [join(dir, 'a.ts')]: { update: {} } } } } },
      codexSay('写好了'),
    ], { dir })
    const entries = await t.entries()
    const refs = refsOf(entries)
    // 代码那一个不进附件
    expect(refs.map(one => one.name)).toEqual(['报告.md'])
    expect(await t.info(refs[0]!.ref)).toMatchObject({ kind: 'markdown', text: { format: 'markdown', parts: 1 } })
  })

  it('老版 `user_message.images` 照旧认(没回头改老会话)', async () => {
    const t = setup('codex-rollout', [
      { timestamp: '2026-09-01T05:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '看这张', images: [`data:image/png;base64,${b64(PNG)}`] } },
      { timestamp: '2026-09-01T05:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: '好' } },
    ])
    expect(refsOf(await t.entries())[0]).toMatchObject({ kind: 'image', from: 'you', bytes: PNG.length })
  })
})

// ───────────────────────────── Kimi ─────────────────────────────

describe('Kimi:记录里只有 blobref,字节在同目录的 blobs/', () => {
  const wire = (hash: string) => [
    { type: 'turn.prompt', time: 1_790_000_000_000, origin: { kind: 'user' }, input: [{ type: 'text', text: '看一下页面' }] },
    {
      type: 'context.append_loop_event',
      event: { part: { type: 'text', text: '看到了' }, result: { output: [{ type: 'image_url', imageUrl: { url: `blobref:image/jpeg;${hash}` } }] } },
    },
  ]
  const HASH = 'a'.repeat(64)

  it('★它那边的截图:列出来、取得回字节', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'blobs'))
    writeFileSync(join(dir, 'blobs', HASH), JPG)
    const t = setup('kimi-wire', wire(HASH), { dir, name: 'wire.jsonl' })
    const refs = refsOf(await t.entries())
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ kind: 'image', from: 'ai' })
    expect(refs[0]!.ref).toMatch(/~k~a{64}$/)
    expect(await t.info(refs[0]!.ref)).toMatchObject({ kind: 'image', mime: 'image/jpeg', bytes: JPG.length })
    expect(await t.full(refs[0]!.ref)).toEqual(JPG)
  })

  it('那家把图清掉了:如实说不在了,不报别的错', async () => {
    const t = setup('kimi-wire', wire(HASH), { name: 'wire.jsonl' })
    const refs = refsOf(await t.entries())
    const got = await t.info(refs[0]!.ref)
    expect('status' in got && got.status).toBe(410)
  })

  it('★编号是伪造的(这条对话里没有这个 blobref):不给', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'blobs'))
    writeFileSync(join(dir, 'blobs', 'b'.repeat(64)), JPG)
    const t = setup('kimi-wire', wire(HASH), { dir, name: 'wire.jsonl' })
    const offset = Number(/^(\d+)~/.exec(refsOf(await t.entries())[0]!.ref)![1])
    const got = await t.info(`${offset}~k~${'b'.repeat(64)}`)
    expect('status' in got && got.status).toBe(403)
  })
})

// ───────────────────────────── 存到手机上 ─────────────────────────────

describe('存到手机上(view=keep 要的那一格)', () => {
  it('★本机文件给得出路径;写在记录里的 base64 图给不出(看能看,存不下来)', async () => {
    const dir = tmp()
    const zip = join(dir, '素材.zip')
    writeFileSync(zip, Buffer.alloc(32, 1))
    const t = setup('codex-rollout', [
      codexAsk([{ type: 'text', text: `素材在 ${zip}` }, { type: 'input_image', image_url: `data:image/png;base64,${b64(PNG)}` }]),
      codexSay('好'),
    ], { dir })
    const refs = refsOf(await t.entries())
    const packed = refs.find(one => one.name === '素材.zip')!
    const inline = refs.find(one => one.kind === 'image')!
    expect(attachmentIsFileRef(packed.ref)).toBe(true)
    expect(attachmentIsFileRef(inline.ref)).toBe(false)
    const got = await t.file_(packed.ref)
    expect(got.ok && got.value).toMatchObject({ path: zip, name: '素材.zip', bytes: 32 })
    const no = await t.file_(inline.ref)
    expect(no.ok).toBe(false)
    expect(!no.ok && no.status).toBe(403)
    expect(!no.ok && no.error).toMatch(/存不下来/)
  })

  it('Kimi 的图也存得下来(那是它自己图库里的一个文件)', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'blobs'))
    const hash = 'c'.repeat(64)
    writeFileSync(join(dir, 'blobs', hash), JPG)
    const t = setup('kimi-wire', [
      { type: 'turn.prompt', time: 1_790_000_000_000, origin: { kind: 'user' }, input: [{ type: 'text', text: '看页面' }] },
      { type: 'context.append_loop_event', event: { part: { type: 'text', text: '看到了' }, result: { output: [{ type: 'image_url', imageUrl: { url: `blobref:image/jpeg;${hash}` } }] } } },
    ], { dir, name: 'wire.jsonl' })
    const got = await t.file_(refsOf(await t.entries())[0]!.ref)
    expect(got.ok && got.value).toMatchObject({ path: join(dir, 'blobs', hash), bytes: JPG.length })
  })
})
