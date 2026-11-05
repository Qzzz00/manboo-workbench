/**
 * 工人里不碰网络、不碰房间的那些:配置、WAV、文件名、发件目录、key 的来路。
 * 这些是**不需要任何密钥就能验到底**的部分,所以验得细一点。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNEL_DEFAULTS, channelWorkerConfigOf, defaultInboxDir } from '../src/config.ts'
import { ASR_SAMPLE_RATE, encodeWav, pcmOfInt16, pcmSeconds } from '../src/audio/wav.ts'
import { humanBytes, inboxNotice, safeFileName, saveInboxFile, uniqueFileName } from '../src/files/inbox.ts'
import { defaultOutboxDir, outboxPicks, scanOutbox } from '../src/files/outbox.ts'
import { deepseekKeyOfCredentials, loadDeepseekKey } from '../src/deepseekKey.ts'
import { pcmOfWav } from '../src/tts/butlerTts.ts'
import { boardItemsOf, spokenBoardSummary } from '../src/workbench.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'channel-worker-'))
  dirs.push(dir)
  return dir
}

describe('配置', () => {
  it('什么都不配时全指向本机', () => {
    const config = channelWorkerConfigOf({}, '/home/ben')
    expect(config.workbenchUrl).toBe(CHANNEL_DEFAULTS.workbenchUrl)
    expect(config.butlerUrl).toBe(CHANNEL_DEFAULTS.butlerUrl)
    expect(config.asr).toBe('segmented')
    expect(config.llmModel).toBe('deepseek-v4-flash')
    expect(config.inboxDir).toBe(defaultInboxDir('/home/ben'))
  })

  it('环境变量能把每一项都改掉,末尾斜杠会被去掉', () => {
    const config = channelWorkerConfigOf({
      WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://192.168.1.9:8791/',
      WORKBENCH_CHANNEL_BUTLER_URL: 'http://192.168.1.9:8792//',
      WORKBENCH_CHANNEL_ASR: 'volc-streaming',
      WORKBENCH_CHANNEL_INBOX_DIR: '/tmp/收件',
      WORKBENCH_CHANNEL_LLM_MODEL: 'deepseek-chat',
      WORKBENCH_CHANNEL_TTS_VOICE: 'S_abc',
    }, '/home/ben')
    expect(config.workbenchUrl).toBe('http://192.168.1.9:8791')
    expect(config.butlerUrl).toBe('http://192.168.1.9:8792')
    expect(config.asr).toBe('volc-streaming')
    expect(config.inboxDir).toBe('/tmp/收件')
    expect(config.llmModel).toBe('deepseek-chat')
    expect(config.ttsVoiceId).toBe('S_abc')
  })

  it('★ 开场那一句缺省晚 700ms(提机到贴耳那一段),0 是一个真正的值不是「没设」', () => {
    expect(channelWorkerConfigOf({}, '/home/ben').greetingDelayMs).toBe(700)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_GREETING_DELAY_MS: '1200' }, '/home/ben').greetingDelayMs).toBe(1200)
    // 设 0 = 逐字回到 09-23 下午那一版(叉簧一抬就说),**不许被当成缺席退回 700**
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_GREETING_DELAY_MS: '0' }, '/home/ben').greetingDelayMs).toBe(0)
    // 读不懂 / 负数照旧当没配
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_GREETING_DELAY_MS: '晚一点' }, '/home/ben').greetingDelayMs).toBe(700)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_GREETING_DELAY_MS: '-1' }, '/home/ben').greetingDelayMs).toBe(700)
  })

  it('ASR 名字拼错就退回 segmented(不认识的值不当成流式)', () => {
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_ASR: 'volc' }).asr).toBe('segmented')
  })

  /** 2026-09-23 加的三个开关(通话延迟那张卡)。**缺省都不改任何行为**。 */
  it('计时默认开,`off` 能关掉', () => {
    expect(channelWorkerConfigOf({}).latencyLog).toBe(true)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_LATENCY: 'off' }).latencyLog).toBe(false)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_LATENCY: '0' }).latencyLog).toBe(false)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_LATENCY: 'on' }).latencyLog).toBe(true)
  })

  it('端点检测与断句门槛:不配就缺席(用框架/默认值),配了才有', () => {
    const bare = channelWorkerConfigOf({})
    expect(bare.endpointingMinMs).toBeUndefined()
    expect(bare.endpointingMaxMs).toBeUndefined()
    expect(bare.ttsSoftBreakAt).toBeUndefined()
    const tuned = channelWorkerConfigOf({
      WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS: '200',
      WORKBENCH_CHANNEL_ENDPOINTING_MAX_MS: '2000',
      WORKBENCH_CHANNEL_TTS_SOFT_BREAK: '8',
    })
    expect(tuned.endpointingMinMs).toBe(200)
    expect(tuned.endpointingMaxMs).toBe(2000)
    expect(tuned.ttsSoftBreakAt).toBe(8)
  })

  it('★ 垫场由工人说:缺省开,`off` 回到老行为', () => {
    expect(channelWorkerConfigOf({}).workerFiller).toBe(true)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_WORKER_FILLER: 'off' }).workerFiller).toBe(false)
  })

  it('抢跑合成默认关(与框架默认值一致),`on` 才开', () => {
    expect(channelWorkerConfigOf({}).preemptiveTts).toBe(false)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_PREEMPTIVE_TTS: 'on' }).preemptiveTts).toBe(true)
    // ★ 拼错了不该把一个默认关着的手悄悄打开。
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_PREEMPTIVE_TTS: '开' }).preemptiveTts).toBe(false)
  })

  it('读不懂的数当没配(拼错了照跑会让真机数字对不上任何一份配置)', () => {
    const bad = channelWorkerConfigOf({
      WORKBENCH_CHANNEL_ENDPOINTING_MIN_MS: '快一点',
      WORKBENCH_CHANNEL_ENDPOINTING_MAX_MS: '-5',
      WORKBENCH_CHANNEL_TTS_SOFT_BREAK: '0',
    })
    expect(bad.endpointingMinMs).toBeUndefined()
    expect(bad.endpointingMaxMs).toBeUndefined()
    expect(bad.ttsSoftBreakAt).toBeUndefined()
  })
})

describe('WAV', () => {
  it('编出来的头能被自己解回去,采样率与声道数原样', () => {
    const pcm = pcmOfInt16(Int16Array.from([0, 1, -1, 32767, -32768]))
    const wav = encodeWav(pcm, ASR_SAMPLE_RATE, 1)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(ASR_SAMPLE_RATE)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    const decoded = pcmOfWav(wav)
    expect(decoded.sampleRate).toBe(ASR_SAMPLE_RATE)
    expect(decoded.channels).toBe(1)
    expect(Buffer.compare(decoded.pcm, pcm)).toBe(0)
  })

  it('不是 RIFF 就当裸 PCM,不去猜', () => {
    const raw = Buffer.from([1, 2, 3, 4])
    expect(Buffer.compare(pcmOfWav(raw).pcm, raw)).toBe(0)
  })

  it('秒数按 16 位单声道算', () => {
    expect(pcmSeconds(Buffer.alloc(ASR_SAMPLE_RATE * 2), ASR_SAMPLE_RATE, 1)).toBe(1)
  })
})

describe('收件:文件名', () => {
  it('路径穿越只留最后一段', () => {
    expect(safeFileName('../../.dsh/settings.yaml')).toBe('settings.yaml')
    expect(safeFileName('/etc/passwd')).toBe('passwd')
    expect(safeFileName('a\\b\\c.txt')).toBe('c.txt')
  })

  it('前导点清掉,做不出隐藏文件', () => {
    expect(safeFileName('.bashrc')).toBe('bashrc')
    expect(safeFileName('...')).toBe('文件')
  })

  it('空名字有兜底', () => {
    expect(safeFileName(undefined)).toBe('文件')
    expect(safeFileName('   ')).toBe('文件')
  })

  it('重名不覆盖,依次加序号', () => {
    const taken = new Set(['图.png', '图-2.png'])
    expect(uniqueFileName('图.png', name => taken.has(name))).toBe('图-3.png')
    expect(uniqueFileName('无后缀', name => taken.has(name))).toBe('无后缀')
  })
})

describe('收件:落盘', () => {
  it('真写进目录,并回一句能念出来的话', async () => {
    const dir = join(tempDir(), '收件')
    const result = await saveInboxFile({ name: '截图.png', data: Buffer.alloc(2048, 7) }, { dir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.name).toBe('截图.png')
    expect(result.bytes).toBe(2048)
    expect(inboxNotice(result)).toContain('截图.png')
    // 再发一次同名的:两个都在。
    const second = await saveInboxFile({ name: '截图.png', data: Buffer.alloc(16, 1) }, { dir })
    expect(second.ok && second.name).toBe('截图-2.png')
  })

  it('空文件与超大文件都拒收,并说清楚原因', async () => {
    const dir = join(tempDir(), '收件')
    const empty = await saveInboxFile({ name: 'a.bin', data: Buffer.alloc(0) }, { dir })
    expect(empty).toEqual({ ok: false, reason: '这个文件是空的,没收' })
    const big = await saveInboxFile({ name: 'a.bin', data: Buffer.alloc(100) }, { dir, maxBytes: 50 })
    expect(big.ok).toBe(false)
    if (big.ok) return
    expect(big.reason).toContain('太大')
  })

  it('写不进去也不抛,变成一句话', async () => {
    const result = await saveInboxFile(
      { name: 'a.bin', data: Buffer.alloc(8) },
      { dir: '/x', mkdirImpl: async () => { throw new Error('只读') } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('只读')
  })

  it('字节数说人话', () => {
    expect(humanBytes(512)).toBe('512 字节')
    expect(humanBytes(2048)).toBe('2.0 KB')
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('发件目录', () => {
  it('点开头的、已发送目录、空文件都不发', () => {
    expect(outboxPicks([
      { name: '.DS_Store', size: 10 },
      { name: '已发送', size: 64 },
      { name: '半个文件', size: 0 },
      { name: '报告.pdf', size: 100 },
    ])).toEqual(['报告.pdf'])
  })

  it('扫一个真目录只挑出普通文件', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, '要发的.txt'), 'hi')
    writeFileSync(join(dir, '.隐藏'), 'x')
    expect(await scanOutbox({ dir })).toEqual(['要发的.txt'])
  })

  it('目录不存在时回空,不抛', async () => {
    expect(await scanOutbox({ dir: '/一个不存在的目录/xyz' })).toEqual([])
  })

  it('发件目录默认跟收件目录并排', () => {
    expect(defaultOutboxDir('/home/ben/.dsh/workbench/channel-inbox'))
      .toBe('/home/ben/.dsh/workbench/channel-outbox')
  })
})

describe('接话模型的 key', () => {
  it('环境变量优先', async () => {
    const key = await loadDeepseekKey({ env: { DEEPSEEK_API_KEY: 'from-env' }, readFileImpl: async () => '{}' })
    expect(key).toBe('from-env')
  })

  it('没有环境变量就读 credentials.json 的 keys.deepseek', async () => {
    const key = await loadDeepseekKey({
      env: {},
      readFileImpl: async () => JSON.stringify({ keys: { deepseek: 'from-file', kimi_web: 'x' } }),
    })
    expect(key).toBe('from-file')
  })

  it('文件不存在、坏 JSON、字段缺席,都只是「没有」', async () => {
    expect(await loadDeepseekKey({ env: {}, readFileImpl: async () => { throw new Error('ENOENT') } })).toBeUndefined()
    expect(deepseekKeyOfCredentials('不是 JSON')).toBeUndefined()
    expect(deepseekKeyOfCredentials('{"keys":{}}')).toBeUndefined()
    expect(deepseekKeyOfCredentials('{"keys":{"deepseek":"  "}}')).toBeUndefined()
  })
})

describe('看板摘要', () => {
  const state = {
    tasks: {
      tasks: [
        { id: 't-1', title: '订机票', status: 'doing' },
        { id: 't-2', title: '看合同', status: 'confirm' },
        { id: 't-3', title: '还没决定做的', status: 'backlog' },
      ],
    },
  }

  it('只取看板上那几列,形状不对的跳过', () => {
    expect(boardItemsOf(state)).toHaveLength(3)
    expect(boardItemsOf({ tasks: { tasks: [{ id: 1 }] } })).toEqual([])
    expect(boardItemsOf(null)).toEqual([])
  })

  it('念出来的那段带 id,且不含「待排」', () => {
    const summary = spokenBoardSummary(boardItemsOf(state))
    expect(summary).toContain('在办:订机票(id t-1)')
    expect(summary).toContain('等他确认:看合同(id t-2)')
    expect(summary).toContain('待办:没有。')
    expect(summary).not.toContain('还没决定做的')
  })

  // 2026-09-24(卡 F):派给别家那一件,她在电话里答得出「回来说什么了」—— 通过事务官去验收的那一半。
  it('★派给别家的那一件:回来了就带上回答开头;还在等 / 读不回来 / 没派出去各一句', () => {
    const summary = spokenBoardSummary(boardItemsOf({ tasks: { tasks: [
      { id: 'd-1', title: '[派活测试] README', status: 'confirm', client_dispatch: { family: 'codex', status: 'sent', reply_state: 'done', reply: 'README 第一段讲的是事务官。' } },
      { id: 'd-2', title: '一年几季', status: 'doing', client_dispatch: { family: 'kimi', status: 'sent', reply_state: 'waiting' } },
      { id: 'd-3', title: '中秋', status: 'confirm', client_dispatch: { family: 'muse', status: 'sent', reply_state: 'unreadable' } },
      { id: 'd-4', title: '建文件', status: 'confirm', dispatch: { family: 'codex', status: 'done', hand: 'cli', reply: '已新建 hello.txt。' } },
    ] } }))
    expect(summary).toContain('[派活测试] README(id d-1;派给 Codex,回来了:README 第一段讲的是事务官。)')
    expect(summary).toContain('一年几季(id d-2;派给 Kimi,还在等它做完)')
    expect(summary).toContain('中秋(id d-3;派给 Muse,已经发出去了,但结果没读回来,要他到 Muse 里看)')
    expect(summary).toContain('建文件(id d-4;派给 Codex,回来了:已新建 hello.txt。)')
  })
})
