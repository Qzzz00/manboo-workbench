// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MEETING_NO_WORKDIR,
  MEETING_SERVICE_METHODS,
  RECORDINGS_DIR_NAME,
  createMeetingService,
  pcmOfWav,
} from '../src/server/meeting.ts'
import { CLAIM_KINDS, MEETING_SECTIONS, MEETING_TOPIC_FIELDS, encodeWav } from '../src/server/meetingText.ts'
import { createTasksService } from '../src/server/tasks.ts'

function tempHome(): { file: string, workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb-meeting-'))
  return { file: join(root, 'meetings.json'), workdir: join(root, 'repo') }
}

/** 一段能被「解码」的假录音:这里直接用 WAV,服务看见 .wav 就不去调解码器。 */
function fakeWav(seconds: number, amp = 3000): Buffer {
  const samples = 16_000 * seconds
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(i % 2 === 0 ? amp : -amp, i * 2)
  return encodeWav(pcm)
}

/**
 * 模型照《会议纪要生成规则》回的那一份(2026-10-13 改,老的「议题 / 结论 / 分歧」五段作废)。
 * 段落标题与四种性质标记都从 meetingText.ts 的常量来,中文不逐字抄在这里。
 */
const REPLY = [
  `## ${MEETING_SECTIONS.solved}`, '- 定了按段喂流式',
  `## ${MEETING_SECTIONS.topic}:会议模式怎么做`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`, '- 录音怎么转写',
  `### ${MEETING_TOPIC_FIELDS.claims}`, `- [${CLAIM_KINDS[0]}] 先按段喂流式`,
  `### ${MEETING_TOPIC_FIELDS.why}`, '- 批量那条要先把录音传到公网',
  `## ${MEETING_SECTIONS.keep}`, '- 按段喂流式',
  `## ${MEETING_SECTIONS.next}`, '- 小王|把转写跑一遍|这周五前', '- |写交接|',
  `## ${MEETING_SECTIONS.unsure}`, '- 「那个接口」没听清',
].join('\n')

/**
 * 打桩的转写里**必须有**「小王」与「这周五前」那几个字 —— 2026-10-13 起「下一步」里的
 * 人名与日期要在转写里找得到才留(《会议纪要生成规则》第 9 条,meetingText.ts 的 saidInTranscript)。
 */
const HEARD = '小王你把转写跑一遍,这周五前给我,另外写交接。'

type Over = { [K in keyof Parameters<typeof createMeetingService>[0]]?: Parameters<typeof createMeetingService>[0][K] | undefined }

function svc(over: Over = {}) {
  const { file, workdir } = tempHome()
  const base: Parameters<typeof createMeetingService>[0] = {
    file,
    workdir: () => workdir,
    transcribe: async () => HEARD,
    chat: async () => REPLY,
    now: () => Date.parse('2026-09-21T10:00:00.000Z'),
  }
  // 「这一项没接上」在这套 deps 里就是字段缺席(exactOptionalPropertyTypes),
  // 所以传 undefined 的那几个用例要把字段真的删掉,而不是把它设成 undefined。
  const merged = { ...base, ...over } as Record<string, unknown>
  for (const [key, value] of Object.entries(over)) if (value === undefined) delete merged[key]
  return createMeetingService(merged as unknown as Parameters<typeof createMeetingService>[0])
}

describe('能力清单(加一条能自动删录音的能力必须先改这条断言)', () => {
  it('方法名精确相等', () => {
    expect([...MEETING_SERVICE_METHODS]).toEqual(['view', 'start', 'segment', 'finish', 'import', 'seedDemo', 'get', 'apply', 'retry', 'plan', 'answer', 'card', 'drop', 'outcome', 'people', 'forgetPerson', 'idle'])
  })

  it('源码里没有任何一处能删掉会议目录的调用(rm / rmdir / rimraf 一个都没有)', () => {
    const source = readFileSync(new URL('../src/server/meeting.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\brm\b|rmdir|rimraf|force:\s*true/)
    // 唯一那处 unlink 删的是 afconvert 自己建的临时 wav,在系统临时目录里。
    expect(source.match(/unlink\(/g) ?? []).toHaveLength(1)
    expect(source).toContain('临时文件只在这儿删')
  })

  it('没有任何定时器(会议不会自己蒸发)', () => {
    const source = readFileSync(new URL('../src/server/meeting.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/setTimeout|setInterval/)
  })
})

describe('开一场', () => {
  it('没配工作目录 → 开不了,并说清为什么(不猜一个路径)', async () => {
    const { file } = tempHome()
    const service = createMeetingService({ file, workdir: () => undefined })
    const started = await service.start({ title: '周会' })
    expect(started.ok).toBe(false)
    expect(started.error).toBe(MEETING_NO_WORKDIR)
    expect((await service.view()).dir).toBeUndefined()
  })

  it('目录是 <工作目录>/会议/<日期-标题>/,底下还有一个「录音」', async () => {
    const service = svc()
    const started = await service.start({ title: '产品周会' })
    expect(started.ok).toBe(true)
    expect(started.dir).toMatch(/会议\/2026-09-21-产品周会$/)
    expect(existsSync(join(started.dir ?? '', RECORDINGS_DIR_NAME))).toBe(true)
  })

  it('标题里的 ../ 进不了路径(点与分隔符换掉之后剩下的才是目录名)', async () => {
    const service = svc()
    const started = await service.start({ title: '../../跑出去' })
    expect(started.dir).toMatch(/会议\/2026-09-21-跑出去$/)
    expect(started.dir).not.toContain('..')
  })

  it('同一天同一个标题开第二场 → 另起一个目录,绝不往已有目录里叠录音', async () => {
    const service = svc()
    const a = await service.start({ title: '周会' })
    const b = await service.start({ title: '周会' })
    expect(b.dir).not.toBe(a.dir)
    expect(b.dir).toMatch(/-2$/)
  })
})

describe('收分段(先落盘再记账)', () => {
  it('落成 01.m4a / 02.m4a,序号补零', async () => {
    const service = svc()
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: Buffer.from('a'), mimeType: 'audio/mp4', ms: 600_000 })
    await service.segment({ id: id ?? '', seq: 2, bytes: Buffer.from('b'), mimeType: 'audio/mp4;codecs=mp4a', ms: 120_000 })
    expect(readdirSync(join(dir ?? '', RECORDINGS_DIR_NAME)).sort()).toEqual(['01.m4a', '02.m4a'])
    expect((await service.get(id ?? ''))?.segments).toBe(2)
  })

  it('同一段重传(手机掉线重连)只留一份,不会转两遍收两遍钱', async () => {
    const service = svc()
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: Buffer.from('a'), mimeType: 'audio/mp4' })
    await service.segment({ id: id ?? '', seq: 1, bytes: Buffer.from('aa'), mimeType: 'audio/mp4' })
    expect((await service.get(id ?? ''))?.segments).toBe(1)
  })

  it('空的一段不收;没有这一场会也不收', async () => {
    const service = svc()
    const { id } = await service.start({ title: '周会' })
    expect((await service.segment({ id: id ?? '', seq: 1, bytes: Buffer.alloc(0) })).ok).toBe(false)
    expect((await service.segment({ id: '不存在', seq: 1, bytes: Buffer.from('a') })).ok).toBe(false)
  })
})

describe('结束 → 转写 → 梳理(一条端到端,转写与模型都打桩)', () => {
  it('两份 markdown 落在会议目录里,状态走到 done,待办读出来了', async () => {
    const wavs: Buffer[] = []
    const prompts: string[] = []
    const service = svc({
      transcribe: async (wav) => { wavs.push(wav); return `第 ${wavs.length} 句。${HEARD}` },
      chat: async (prompt) => { prompts.push(prompt); return REPLY },
    })
    const { id, dir } = await service.start({ title: '产品周会' })
    // 120 秒 → 按 20 秒一段(切点会往静音处挪)切成 7 段,transcribe 就被调 7 次。
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(120), mimeType: 'audio/wav', ms: 120_000 })
    expect((await service.finish({ id: id ?? '' })).ok).toBe(true)
    await service.idle()

    const view = await service.get(id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.seconds).toBe(120)
    expect(wavs.length).toBe(7)
    // 送出去的每一段都是真 WAV(带 RIFF 头),而不是裸 PCM
    expect(wavs[0]?.toString('ascii', 0, 4)).toBe('RIFF')

    const transcript = await readFile(join(dir ?? '', '转写.md'), 'utf8')
    expect(transcript).toContain('[00:00:00] 第 1 句。')
    expect(transcript).toContain('没有说话人分离')
    // 给模型的那段话里带着转写原文
    expect(prompts[0]).toContain('第 1 句。')

    const notes = await readFile(join(dir ?? '', '纪要.md'), 'utf8')
    expect(notes).toContain('# 产品周会 · 纪要')
    expect(notes).toContain('- 小王:把转写跑一遍(这周五前)')
    expect(notes).toContain('- 没说谁:写交接')

    expect(view?.todos.map(t => t.what)).toEqual(['把转写跑一遍', '写交接'])
    expect(view?.todos[1]?.who).toBeUndefined()
    expect(view?.unsure).toEqual(['「那个接口」没听清'])
  })

  it('「结束」时才起名 → 标题与**目录**一起改(不改的话纪要写新名、文件夹还叫「会议」,像两场会)', async () => {
    const service = svc()
    const { id, dir } = await service.start({})
    expect(dir).toMatch(/2026-09-21-会议$/)
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '', title: '产品周会' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.title).toBe('产品周会')
    expect(view?.dir).toMatch(/2026-09-21-产品周会$/)
    expect(existsSync(join(view?.dir ?? '', RECORDINGS_DIR_NAME, '01.wav'))).toBe(true)
    expect(existsSync(join(view?.dir ?? '', '纪要.md'))).toBe(true)
    expect(existsSync(dir ?? '')).toBe(false)
  })

  it('新名字和另一场会撞了 → **只改标题,不动目录**(覆盖掉别人的录音是这里能犯的最坏的错)', async () => {
    const service = svc()
    const first = await service.start({ title: '产品周会' })
    const second = await service.start({})
    await service.segment({ id: second.id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: second.id ?? '', title: '产品周会' })
    await service.idle()
    const view = await service.get(second.id ?? '')
    expect(view?.title).toBe('产品周会')
    expect(view?.dir).toBe(second.dir)
    // 第一场那个目录一个字没动
    expect(existsSync(join(first.dir ?? '', RECORDINGS_DIR_NAME))).toBe(true)
  })

  it('「结束」立刻返回,人可以先离开(返回的那一刻还在 transcribing)', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = svc({ transcribe: async () => { await gate; return '一句话。' } })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    expect((await service.get(id ?? ''))?.status).toBe('transcribing')
    release()
    await service.idle()
    expect((await service.get(id ?? ''))?.status).toBe('done')
  })

  it('重复点「结束」不会再跑一遍', async () => {
    let calls = 0
    const service = svc({ transcribe: async () => { calls += 1; return '一句。' } })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    await service.finish({ id: id ?? '' })
    await service.idle()
    expect(calls).toBe(1)
  })

  it('多段:时间戳按前面几段的真实时长往后累,不从 0 重新开始', async () => {
    const service = svc()
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(10), mimeType: 'audio/wav', ms: 10_000 })
    await service.segment({ id: id ?? '', seq: 2, bytes: fakeWav(10), mimeType: 'audio/wav', ms: 10_000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const transcript = await readFile(join(dir ?? '', '转写.md'), 'utf8')
    expect(transcript).toContain('[00:00:00]')
    expect(transcript).toContain('[00:00:10]')
    expect((await service.get(id ?? ''))?.seconds).toBe(20)
  })
})

describe('失败的几条路:录音一个都不删,而且说得出是哪一步出的事', () => {
  it('转写没接上 → failed,录音还在', async () => {
    const service = svc({ transcribe: undefined })
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('failed')
    expect(view?.error).toContain('转写没接上')
    expect(existsSync(join(dir ?? '', RECORDINGS_DIR_NAME, '01.wav'))).toBe(true)
  })

  it('火山整场都报错 → failed,转写.md 仍然落下来(里面如实说一个字都没转出来)', async () => {
    const service = svc({ transcribe: async () => { throw new Error('火山 ASR 错误(45000081)') } })
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('failed')
    expect(view?.error).toContain('45000081')
    expect(await readFile(join(dir ?? '', '转写.md'), 'utf8')).toContain('一个字都没转出来')
  })

  it('模型没接上 → 转写照样落盘,状态 done,并说清「所以没有纪要」', async () => {
    const service = svc({ chat: undefined })
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.error).toContain('没有纪要')
    expect(view?.summary).toBeUndefined()
    expect(existsSync(join(dir ?? '', '转写.md'))).toBe(true)
    expect(existsSync(join(dir ?? '', '纪要.md'))).toBe(false)
  })

  it('模型调用炸了 → 转写还在,状态 done + 一句原话', async () => {
    const service = svc({ chat: async () => { throw new Error('中转连不上') } })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.error).toContain('中转连不上')
  })

  it('一部分段落转失败 → 纪要照出,但如实留一句「有 N 段没转出来」', async () => {
    let n = 0
    const service = svc({ transcribe: async () => { n += 1; if (n === 2) throw new Error('这一段超时'); return `第 ${n} 句。` } })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(120), mimeType: 'audio/wav', ms: 120_000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.error).toContain('有 1 段没转出来')
    expect(view?.error).toContain('这一段超时')
  })

  it('解码器解不开(m4a + 没有 ffmpeg)→ failed,录音不动', async () => {
    const service = svc({ decode: async () => { throw new Error('这台机器上既没有 ffmpeg 也没有 afconvert') } })
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: Buffer.from('假的 m4a'), mimeType: 'audio/mp4', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    expect((await service.get(id ?? ''))?.status).toBe('failed')
    expect(existsSync(join(dir ?? '', RECORDINGS_DIR_NAME, '01.m4a'))).toBe(true)
  })
})

describe('待办进看板', () => {
  function tasksService() {
    return createTasksService({ file: join(mkdtempSync(join(tmpdir(), 'wb-meeting-tasks-')), 'tasks.json') })
  }

  it('「都建」:每条一张卡,source 是 meeting,ref 是这一场的 id', async () => {
    const tasks = tasksService()
    const service = svc({ tasks })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()

    const applied = await service.apply(id ?? '', [])
    expect(applied.ok).toBe(true)
    expect(applied.created).toHaveLength(2)
    const board = await tasks.list()
    expect(board.tasks.map(t => t.title).sort()).toEqual(['写交接', '把转写跑一遍'])
    expect(board.tasks.every(t => t.source.kind === 'meeting' && t.source.ref === id)).toBe(true)
    // 期限是会上那句原话,**没有换算成日期**;卡上的 due 一个都没填
    expect(board.tasks.every(t => t.due === undefined)).toBe(true)
    expect(board.tasks.find(t => t.title === '把转写跑一遍')?.desc).toContain('这周五前')
    expect(board.tasks.find(t => t.title === '写交接')?.desc).toContain('没说谁')
  })

  it('逐条勾:只建挑中的那条', async () => {
    const tasks = tasksService()
    const service = svc({ tasks })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    await service.apply(id ?? '', ['t2'])
    expect((await tasks.list()).tasks.map(t => t.title)).toEqual(['写交接'])
    expect((await service.get(id ?? ''))?.todos.find(t => t.id === 't2')?.task_id).toBeDefined()
    expect((await service.get(id ?? ''))?.todos.find(t => t.id === 't1')?.task_id).toBeUndefined()
  })

  it('点两下「都建」不出双份', async () => {
    const tasks = tasksService()
    const service = svc({ tasks })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    await service.apply(id ?? '', [])
    const second = await service.apply(id ?? '', [])
    expect(second.created).toHaveLength(0)
    expect((await tasks.list()).tasks).toHaveLength(2)
  })

  it('没接看板 → 如实说一句,不假装建好了', async () => {
    const service = svc()
    const { id } = await service.start({ title: '周会' })
    const applied = await service.apply(id ?? '', [])
    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('看板没接上')
  })
})

describe('/state.meetings', () => {
  it('最新的在最前,最多五场,并带上会议根目录', async () => {
    const { file, workdir } = tempHome()
    let clock = Date.parse('2026-09-21T10:00:00.000Z')
    const service = createMeetingService({ file, workdir: () => workdir, now: () => (clock += 1000) })
    for (let i = 0; i < 7; i++) await service.start({ title: `会 ${i}` })
    const view = await service.view()
    expect(view.recent).toHaveLength(5)
    expect(view.recent[0]?.title).toBe('会 6')
    expect(view.dir).toBe(join(workdir, '会议'))
  })

  it('索引写坏了 → 当空表,不抛(硬盘上的会议目录一个都没少)', async () => {
    const { file, workdir } = tempHome()
    const service = createMeetingService({ file, workdir: () => workdir })
    await service.start({ title: '周会' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 这不是 json')
    expect((await service.view()).recent).toEqual([])
  })
})

describe('开一场:手机先录着、后补开(出门不丢,2026-10-09)', () => {
  it('同一个 client_key 再开一次 → 回同一场,不另起目录(手机没收到回包重发)', async () => {
    const service = svc()
    const a = await service.start({ title: '周会', client_key: 'phone-1' })
    const b = await service.start({ title: '周会', client_key: 'phone-1' })
    expect(b.id).toBe(a.id)
    expect(b.dir).toBe(a.dir)
    expect((await service.view()).recent).toHaveLength(1)
  })

  it('带 started_at → 日期与开始时刻按手机开录那一刻(在外面录、晚上回家才补开)', async () => {
    const service = svc()
    const started = await service.start({ title: '外面的会', started_at: '2026-09-20T02:00:00.000Z' })
    expect(started.dir).toMatch(/2026-09-20-外面的会$/)
    expect((await service.get(started.id ?? ''))?.started_at).toBe('2026-09-20T02:00:00.000Z')
  })

  it('started_at 不像话(将来 / 太久以前 / 不是时间)→ 不认,按电脑此刻', async () => {
    const service = svc()
    for (const bad of ['2026-09-22T10:00:00.000Z', '2025-01-01T00:00:00.000Z', '昨天']) {
      const started = await service.start({ title: `会${bad.length}`, started_at: bad })
      expect((await service.get(started.id ?? ''))?.started_at).toBe('2026-09-21T10:00:00.000Z')
    }
  })
})

describe('重新来(2026-10-09):只重做失败的那一截', () => {
  it('部分段没转出来 → retryable;重新来只把没转好的那段再送识别,纪要重出、不再带那句错', async () => {
    let calls = 0
    let failSecond = true
    const sent: number[] = []
    const service = svc({
      transcribe: async () => {
        calls += 1
        sent.push(calls)
        if (failSecond && calls === 2) throw new Error('这一段超时')
        return `第 ${calls} 句。`
      },
    })
    const { id, dir } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.segment({ id: id ?? '', seq: 2, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    const before = await service.get(id ?? '')
    expect(before?.error).toContain('有 1 段没转出来')
    expect(before?.retryable).toBe(true)

    failSecond = false
    const callsBefore = calls
    expect((await service.retry(id ?? '')).ok).toBe(true)
    await service.idle()
    // 第 1 段已经转好了,不再送识别:只多送了 1 次(第 2 段那一片)。
    expect(calls - callsBefore).toBe(1)
    const after = await service.get(id ?? '')
    expect(after?.status).toBe('done')
    expect(after?.error).toBeUndefined()
    expect(after?.retryable).toBeUndefined()
    const transcript = await readFile(join(dir ?? '', '转写.md'), 'utf8')
    expect(transcript).toContain('第 1 句。')
    expect(transcript).toContain('第 3 句。')
  })

  it('梳理失败 → 重新来只再问一次模型,一段都不再送识别', async () => {
    let asr = 0
    let chatOk = false
    const service = svc({
      transcribe: async () => { asr += 1; return HEARD },
      chat: async () => { if (!chatOk) throw new Error('中转连不上'); return REPLY },
    })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    expect((await service.get(id ?? ''))?.retryable).toBe(true)
    const asrBefore = asr
    chatOk = true
    expect((await service.retry(id ?? '')).ok).toBe(true)
    await service.idle()
    expect(asr).toBe(asrBefore)
    const view = await service.get(id ?? '')
    expect(view?.status).toBe('done')
    expect(view?.summary).toContain('纪要')
    expect(view?.todos).toHaveLength(2)
  })

  it('整场转写失败(8792 没起来)→ failed + retryable;接上之后重新来走到 done', async () => {
    let up = false
    const service = svc({ transcribe: async () => { if (!up) throw new Error('连不上 8792'); return '一句。' } })
    const { id } = await service.start({ title: '周会' })
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    expect((await service.get(id ?? ''))?.status).toBe('failed')
    expect((await service.get(id ?? ''))?.retryable).toBe(true)
    up = true
    await service.retry(id ?? '')
    await service.idle()
    expect((await service.get(id ?? ''))?.status).toBe('done')
  })

  it('干净做完的、还在录的、没有这一场的 → 不重来,说清为什么', async () => {
    const service = svc()
    const { id } = await service.start({ title: '周会' })
    expect((await service.retry(id ?? '')).error).toContain('还在录')
    await service.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await service.finish({ id: id ?? '' })
    await service.idle()
    expect((await service.get(id ?? ''))?.retryable).toBeUndefined()
    expect((await service.retry(id ?? '')).ok).toBe(false)
    expect((await service.retry('没有这场')).ok).toBe(false)
  })

  it('工作台中途重启过(停在 transcribing,却没人在转)→ 新的那一个认得出来,能重新来', async () => {
    const { file, workdir } = tempHome()
    const base = { file, workdir: () => workdir, chat: async () => REPLY, now: () => Date.parse('2026-09-21T10:00:00.000Z') }
    const hung = createMeetingService({ ...base, transcribe: () => new Promise<string>(() => {}) })
    const { id } = await hung.start({ title: '周会' })
    await hung.segment({ id: id ?? '', seq: 1, bytes: fakeWav(3), mimeType: 'audio/wav', ms: 3000 })
    await hung.finish({ id: id ?? '' })
    // 那一个还「在转」:它自己不给重来(免得同一场跑两遍)
    expect((await hung.get(id ?? ''))?.retryable).toBeUndefined()
    const fresh = createMeetingService({ ...base, transcribe: async () => '一句。' })
    expect((await fresh.get(id ?? ''))?.status).toBe('transcribing')
    expect((await fresh.get(id ?? ''))?.retryable).toBe(true)
    await fresh.retry(id ?? '')
    await fresh.idle()
    expect((await fresh.get(id ?? ''))?.status).toBe('done')
  })
})

describe('pcmOfWav', () => {
  it('认 RIFF 头,取 data 段;没有头就当裸 PCM 原样回', () => {
    const pcm = Buffer.from([1, 0, 2, 0])
    expect(pcmOfWav(encodeWav(pcm))).toEqual(pcm)
    expect(pcmOfWav(pcm)).toEqual(pcm)
  })
})
