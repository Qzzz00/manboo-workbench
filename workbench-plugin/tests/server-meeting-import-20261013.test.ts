// @vitest-environment node
/**
 * 不靠现场录音出一份纪要(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
 *
 * 为什么有这一条:一小时的会按段识别大约等 35 分钟,周三演示与展位都等不起。
 * 所以加一条「拿现成材料出纪要」的路 —— **走的是同一条流水线**,产物与真录的一场同形:
 * 同一份 `会议/<日期>-<标题>/`、同一份 `转写.md` + `纪要.md`、同一批待办、同一颗「重新整理」。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MEETING_IMPORT_MAX_CHARS,
  MEETING_NO_WORKDIR,
  RECORDINGS_DIR_NAME,
  createMeetingService,
} from '../src/server/meeting.ts'
import { MEETING_SECTIONS, MEETING_TOPIC_FIELDS, encodeWav, transcriptBodyOf } from '../src/server/meetingText.ts'
import { createTasksService } from '../src/server/tasks.ts'

function tempHome(): { file: string, workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb-meeting-import-'))
  return { file: join(root, 'meetings.json'), workdir: join(root, 'repo') }
}

function fakeWav(seconds: number): Buffer {
  const samples = 16_000 * seconds
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(i % 2 === 0 ? 3000 : -3000, i * 2)
  return encodeWav(pcm)
}

/** 演示样例那份转写(文件头不算)。 */
const SAMPLE = transcriptBodyOf(readFileSync(new URL('../../docs/演示/会议样例-自媒体选题会-转写.md', import.meta.url), 'utf8'))

/** 模型照新格式回的那一份。最后一条「下一步」里的人是编的(转写里没有「阿杏」),该被程序丢掉。 */
const REPLY = [
  `## ${MEETING_SECTIONS.solved}`,
  '- 定了下个月四条短的加一条长的',
  `## ${MEETING_SECTIONS.topic}:下个月的选题方向`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`,
  '- 流量掉了一截',
  `### ${MEETING_TOPIC_FIELDS.claims}`,
  '- [已确定] 四条短的加一条长的',
  '- [初步想法] 讲自己翻车那一条不排期',
  `### ${MEETING_TOPIC_FIELDS.why}`,
  '- 推荐权重挪到了完播率',
  `## ${MEETING_SECTIONS.keep}`,
  '- 开头不自我介绍,直接抛数',
  `## ${MEETING_SECTIONS.next}`,
  '- 小满|把那两条确定的选题框架写出来|周五之前',
  '- |把平台对切片和搬运的规则查一份出来|下周一之前',
  '- 阿杏|跟剪辑对一下片头|这周三',
  `## ${MEETING_SECTIONS.unsure}`,
  '- 「上次那个」指的是哪个场地没听清',
].join('\n')

type Over = { [K in keyof Parameters<typeof createMeetingService>[0]]?: Parameters<typeof createMeetingService>[0][K] | undefined }

function svc(over: Over = {}) {
  const { file, workdir } = tempHome()
  const base: Parameters<typeof createMeetingService>[0] = {
    file,
    workdir: () => workdir,
    transcribe: async () => '这是一句转出来的话。',
    chat: async () => REPLY,
    now: () => Date.parse('2026-10-13T02:00:00.000Z'),
  }
  const merged = { ...base, ...over } as Record<string, unknown>
  for (const [key, value] of Object.entries(over)) if (value === undefined) delete merged[key]
  return createMeetingService(merged as unknown as Parameters<typeof createMeetingService>[0])
}

describe('导入一段转写 → 一次模型调用出纪要', () => {
  it('★ 产物与真录的一场同形:同一个目录、两份 markdown、待办照旧;转写原样落盘', async () => {
    const prompts: string[] = []
    let asr = 0
    const service = svc({
      chat: async (prompt) => { prompts.push(prompt); return REPLY },
      transcribe: async () => { asr += 1; return '不该被调到' },
    })
    const done = await service.import({ text: SAMPLE, title: '十一月选题会', from: '会议样例-自媒体选题会-转写.md' })
    expect(done.ok).toBe(true)
    expect(done.dir).toMatch(/会议\/2026-10-13-十一月选题会$/)
    await service.idle()

    // 识别一次都没走(所以一分钟就出来,不是半小时)
    expect(asr).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('流量明显掉了一截')

    const dir = done.dir ?? ''
    const transcript = readFileSync(join(dir, '转写.md'), 'utf8')
    expect(transcript).toContain('导入的现成文字')
    expect(transcript).toContain('会议样例-自媒体选题会-转写.md')
    expect(transcript).toContain('[00:00:00] 行,人齐了')
    const notes = readFileSync(join(dir, '纪要.md'), 'utf8')
    expect(notes).toContain('# 十一月选题会 · 纪要')
    expect(notes).toContain(MEETING_SECTIONS.solved)
    expect(notes).toContain('已确定 · 四条短的加一条长的')

    const view = await service.get(done.id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.error).toBeUndefined()
    expect(view?.summary).toContain(MEETING_SECTIONS.keep)
    // 「阿杏」是编的 → 整条没留,剩两条
    expect(view?.todos.map(one => one.what)).toEqual(['把那两条确定的选题框架写出来', '把平台对切片和搬运的规则查一份出来'])
    expect(notes).toContain('阿杏')
    expect(view?.unsure).toHaveLength(1)
  })

  it('没有录音就不摆一个空的「录音」文件夹(她在访达里一眼看得出这一场是导入的)', async () => {
    const service = svc()
    const done = await service.import({ text: SAMPLE, title: '导入的会' })
    await service.idle()
    expect(existsSync(join(done.dir ?? '', '转写.md'))).toBe(true)
    expect(existsSync(join(done.dir ?? '', RECORDINGS_DIR_NAME))).toBe(false)
  })

  it('进得了「最近几场」,待办能建成卡,来源照旧钉成 meeting', async () => {
    const tasks = createTasksService({ file: join(mkdtempSync(join(tmpdir(), 'wb-meeting-import-tasks-')), 'tasks.json') })
    const service = svc({ tasks })
    const done = await service.import({ text: SAMPLE, title: '十一月选题会' })
    await service.idle()
    expect((await service.view()).recent[0]?.title).toBe('十一月选题会')
    const applied = await service.apply(done.id ?? '', [])
    expect(applied.created).toHaveLength(2)
    const board = await tasks.list()
    expect(board.tasks.every(one => one.source.kind === 'meeting' && one.source.ref === done.id)).toBe(true)
    expect(board.tasks.find(one => one.title.includes('选题框架'))?.desc).toContain('周五之前')
  })

  it('★ 「重新整理」对导入那一场照用:一段都不送识别,只再问一次模型', async () => {
    let chatOk = false
    let asr = 0
    let chats = 0
    const service = svc({
      transcribe: async () => { asr += 1; return '不该被调到' },
      chat: async () => { chats += 1; if (!chatOk) throw new Error('中转连不上'); return REPLY },
    })
    const done = await service.import({ text: SAMPLE, title: '十一月选题会' })
    await service.idle()
    const before = await service.get(done.id ?? '')
    expect(before?.error).toContain('中转连不上')
    expect(before?.retryable).toBe(true)

    chatOk = true
    expect((await service.retry(done.id ?? '')).ok).toBe(true)
    await service.idle()
    expect(asr).toBe(0)
    expect(chats).toBe(2)
    const after = await service.get(done.id ?? '')
    expect(after?.status).toBe('done')
    expect(after?.summary).toContain(MEETING_SECTIONS.next)
  })

  it('模型没接上 → 转写照样在盘上,如实说这一场没有纪要', async () => {
    const service = svc({ chat: undefined })
    const done = await service.import({ text: SAMPLE, title: '十一月选题会' })
    await service.idle()
    const view = await service.get(done.id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.error).toContain('没有纪要')
    expect(existsSync(join(done.dir ?? '', '转写.md'))).toBe(true)
    expect(existsSync(join(done.dir ?? '', '纪要.md'))).toBe(false)
  })

  it('空的、两样都给的、太长的 → 当场拒,不建目录', async () => {
    const service = svc()
    expect((await service.import({})).ok).toBe(false)
    expect((await service.import({ text: '   ' })).ok).toBe(false)
    const both = await service.import({ text: SAMPLE, audio_path: '/tmp/x.m4a' })
    expect(both.ok).toBe(false)
    expect(both.error).toContain('一次只导一样')
    const long = await service.import({ text: '啊'.repeat(MEETING_IMPORT_MAX_CHARS + 1) })
    expect(long.ok).toBe(false)
    expect(long.error).toContain('太长')
    expect((await service.view()).recent).toHaveLength(0)
  })

  it('没配工作目录 → 导不了,并说清为什么(不猜一个路径)', async () => {
    const { file } = tempHome()
    const service = createMeetingService({ file, workdir: () => undefined })
    const done = await service.import({ text: SAMPLE })
    expect(done.ok).toBe(false)
    expect(done.error).toBe(MEETING_NO_WORKDIR)
  })
})

describe('导入一个本机录音文件(走现有识别那条路)', () => {
  it('录音落进「录音」里、识别照走、纪要照出 —— 与手机录的一场一个样', async () => {
    let asr = 0
    const service = svc({ transcribe: async () => { asr += 1; return `第 ${asr} 句。` } })
    const audio = join(mkdtempSync(join(tmpdir(), 'wb-meeting-import-audio-')), '上周的会.wav')
    writeFileSync(audio, fakeWav(30))
    const done = await service.import({ audio_path: audio })
    expect(done.ok).toBe(true)
    await service.idle()
    // 标题没给就用文件名(不叫「会议」,她一眼认得出是哪一份)
    expect(done.dir).toMatch(/会议\/2026-10-13-上周的会$/)
    expect(existsSync(join(done.dir ?? '', RECORDINGS_DIR_NAME, '01.wav'))).toBe(true)
    expect(asr).toBeGreaterThan(0)
    const view = await service.get(done.id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.seconds).toBe(30)
    expect(readFileSync(join(done.dir ?? '', '转写.md'), 'utf8')).toContain('第 1 句。')
  })

  it('路径不存在 → 如实说一句,不建一场空会', async () => {
    const service = svc()
    const done = await service.import({ audio_path: '/tmp/这个文件不存在-20261013.m4a' })
    expect(done.ok).toBe(false)
    expect(done.error).toContain('读不开')
    expect((await service.view()).recent).toHaveLength(0)
  })
})
