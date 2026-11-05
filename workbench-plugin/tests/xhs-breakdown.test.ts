// @vitest-environment node
/**
 * 爆款拆解(src/server/xhsBreakdownText.ts + xhsBreakdown.ts)。
 *
 * ★ 这一份最要紧的一条是 **C6**(Ben 2026-09-22 定):**拆解产物带时间戳**。
 * 它不是排版要求,是防一件具体的事:预研实验六里 ASR **凭空插进来一句原片没说的话**
 * (「点个关注」)。产物里带上时间戳,他才能回去核对原片。
 *
 * 所以这里钉:
 *
 * 1. **时间戳是转写给的,不是模型给的** —— 模型写了清单外的时间戳,那一条当场丢掉;
 * 2. **转写为空就不调模型** —— 从没有字的视频里"分析"出来的框架是纯编的;
 * 3. **每一段带时间戳 + 那个时间点的原话**;
 * 4. 产物头上逐字写着「机器转写,可能有出入」;
 * 5. 缺 ffmpeg / whisper-cli **如实说缺哪个**,不说「不可用」,也不叫他去开终端。
 *
 * 外部命令、下载、模型全部打桩 —— 这一份**不跑一个真进程、不走一个字节网络**。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FRAMEWORK_SECTIONS, allowedStamps, buildFrameworkPrompt, frameTimes, imageStamps,
  parseFrameworkReply, parseSrt, renderBreakdownMd, renderTranscriptMd, srtTimeToSeconds, stampOf,
} from '../src/server/xhsBreakdownText.ts'
import { NO_FFMPEG, NO_WHISPER, NO_VIDEO, runBreakdown, toolsNote } from '../src/server/xhsBreakdown.ts'
import type { CollectedNote } from '../src/server/xhsNoteText.ts'
import { FAKE_NOTE_URL, FAKE_SRT, REAL_SRT_TRADITIONAL } from './xhsNoteFixtures.ts'

const CUES = parseSrt(FAKE_SRT)

describe('SRT', () => {
  it('读得出三段,时间戳对得上', () => {
    expect(CUES).toHaveLength(3)
    expect(CUES[0]?.start).toBe(0)
    expect(CUES[2]?.start).toBeCloseTo(66, 3)
    expect(CUES[0]?.text).toContain('开头在这里')
  })

  it('★ 时间戳读不出来的那一块整块跳过,不半信半疑地收一半', () => {
    const broken = ['1', '坏掉的时间行', '这句话不知道落在第几秒', '', ...FAKE_SRT.split('\n')].join('\n')
    expect(parseSrt(broken).map(one => one.text)).toEqual(CUES.map(one => one.text))
  })

  it('srtTimeToSeconds 读不出来回 undefined,不猜 0', () => {
    expect(srtTimeToSeconds('00:00:07,700')).toBeCloseTo(7.7, 3)
    expect(srtTimeToSeconds('乱写')).toBeUndefined()
    expect(srtTimeToSeconds('')).toBeUndefined()
  })

  it('stampOf:一小时以内两段,超过一小时三段', () => {
    expect(stampOf(0)).toBe('00:00')
    expect(stampOf(66)).toBe('01:06')
    expect(stampOf(3_700)).toBe('01:01:40')
  })
})

describe('抽帧', () => {
  it('★ 6~12 帧之间,两头都夹住', () => {
    expect(frameTimes(30)).toHaveLength(6)
    expect(frameTimes(120)).toHaveLength(8)
    expect(frameTimes(3_600)).toHaveLength(12)
  })

  it('第一帧是封面(第 0 秒),最后一帧不踩末尾(常是黑帧)', () => {
    const times = frameTimes(60)
    expect(times[0]).toBe(0)
    expect(times.at(-1)).toBeLessThan(60)
  })

  it('时长读不出来时只抽封面那一张,不抛', () => {
    expect(frameTimes(0)).toEqual([0])
    expect(frameTimes(Number.NaN)).toEqual([0])
  })
})

describe('★ 时间戳是转写给的,不是模型给的', () => {
  const stamps = allowedStamps(CUES)

  it('清单就是逐字稿里那几个开始时间', () => {
    expect(stamps).toEqual(['00:00', '00:07', '01:06'])
  })

  it('★ 模型写了清单外的时间戳 → 那一条丢掉', () => {
    const reply = [
      '开头|00:00|自报家门',
      '正文结构|99:99|★ 这个时间戳是模型编的,整条都不该留下',
      '结尾|01:06|给了收藏的理由',
    ].join('\n')
    const picked = parseFrameworkReply(reply, stamps)
    expect(picked.map(one => one.section)).toEqual(['开头', '结尾'])
    expect(JSON.stringify(picked)).not.toContain('模型编的')
  })

  it('段名不认识的丢掉,同一段回两条只留第一条,正文空的丢掉', () => {
    const reply = [
      '开头|00:00|第一条',
      '开头|00:07|第二条,该被丢掉',
      '不存在的段|00:00|该被丢掉',
      '钩子|00:07|   ',
    ].join('\n')
    const picked = parseFrameworkReply(reply, stamps)
    expect(picked).toHaveLength(1)
    expect(picked[0]?.text).toBe('第一条')
  })

  it('一条都留不下来时回空数组 —— 调用方据此不写产物', () => {
    expect(parseFrameworkReply('模型答非所问的一大段话', stamps)).toEqual([])
  })

  it('提示词里逐字写着「只能从这个清单里挑」和那几个时间戳', () => {
    const prompt = buildFrameworkPrompt({ title: '假标题', tags: [], cues: CUES, frames: [0, 10] })
    expect(prompt).toContain('一个都不许自己编')
    for (const stamp of stamps) expect(prompt).toContain(stamp)
    // 五段逐字都在。
    for (const section of FRAMEWORK_SECTIONS) expect(prompt).toContain(section)
    // 转写会出错这件事也写在提示词里。
    expect(prompt).toContain('机器转的')
    expect(prompt).toContain('不评价好坏')
  })
})

describe('产物', () => {
  const meta = { at: '2026-09-22T02:00:00.000Z', url: FAKE_NOTE_URL, asr_model: 'ggml-base', duration: 66, frames: 6 }

  it('★ 每一段都带时间戳,而且底下贴着那个时间点的原话', () => {
    const items = parseFrameworkReply('开头|00:00|自报家门\n结尾|01:06|给了收藏的理由', allowedStamps(CUES))
    const md = renderBreakdownMd(items, CUES, meta)
    expect(md).toContain('## 开头 · `00:00`')
    expect(md).toContain('## 结尾 · `01:06`')
    // 依据那一行念的是逐字稿里的原话。
    expect(md).toContain('假逐字稿第一句:开头在这里')
    expect(md).toContain('假逐字稿第三句:结尾在这里')
  })

  it('★ 头上逐字写着「机器转的,可能有出入」', () => {
    const md = renderBreakdownMd(parseFrameworkReply('开头|00:00|x', allowedStamps(CUES)), CUES, meta)
    expect(md).toContain('机器转的')
    expect(md).toContain('核对原片')
  })

  it('一条都没有时如实说,不画一个空框架', () => {
    const md = renderBreakdownMd([], CUES, meta)
    expect(md).toContain('对不上')
    expect(md).not.toContain('## 开头')
  })

  it('逐字稿.md 每一行都带时间戳,头上写着音频没上传', () => {
    const md = renderTranscriptMd(CUES, { at: meta.at, url: meta.url, model: 'ggml-base' })
    expect(md).toContain('`00:00`')
    expect(md).toContain('`01:06`')
    expect(md).toContain('一个字节都没上传')
  })

  /**
   * ★ 2026-09-21 起繁→简那一步接上了(`zhSimplify.ts`,用例在 `zh-simplify.test.ts`)。
   * 产物头上**转没转都要写**:转了要说(他看到的字形不是机器原话的字形),
   * 没转也要说(不然他以为这一步根本没跑)。
   */
  it('★ 转了:逐字稿头上说清楚「已经替你转成简体」,并写明占比与那条线', () => {
    const md = renderTranscriptMd(CUES, {
      at: meta.at, url: meta.url, model: 'ggml-base',
      simplify: { converted: true, measure: { han: 182, traditional: 67, ratio: 67 / 182 } },
    })
    expect(md).toContain('已经替你转成简体')
    expect(md).toContain('36.8%')
    expect(md).toContain('10%')
    // 「只换字形」这一条要明说 —— 不然他以为我们替他改了用词。
    expect(md).toContain('只换字形,没改用词')
  })

  it('★ 没转:逐字稿头上也要说一句,并写明夹着的繁体字是内容本身', () => {
    const md = renderTranscriptMd(CUES, {
      at: meta.at, url: meta.url, model: 'ggml-base',
      simplify: { converted: false, measure: { han: 52, traditional: 2, ratio: 2 / 52 } },
    })
    expect(md).toContain('不用转')
    expect(md).toContain('3.8%')
    expect(md).toContain('不替你改')
  })

  it('一句都没转出来时说「两种我分不清」,不写「这条视频没有人声」', () => {
    const md = renderTranscriptMd([], { at: meta.at, url: meta.url, model: 'ggml-base' })
    expect(md).toContain('分不清')
  })

  it('★ 图文笔记:位置是「图 N」,并且逐字写明模型没看见图', () => {
    expect(imageStamps(3)).toEqual(['图 1', '图 2', '图 3'])
    const items = parseFrameworkReply('开头|图 1|第一张是封面', imageStamps(3))
    const md = renderBreakdownMd(items, [], { ...meta, images_only: true, frames: 3 })
    expect(md).toContain('## 开头 · `图 1`')
    expect(md).toContain('模型没有看见图本身')
    // 图文没有逐字稿,就不要提逐字稿。
    expect(md).not.toContain('完整逐字稿')
  })
})

describe('本机工具:缺什么说什么', () => {
  it('缺 ffmpeg / whisper-cli 时点名说,并且不叫他去开终端', () => {
    const said = toolsNote({}, 'base')
    expect(said).toContain('ffmpeg')
    expect(said).toContain('whisper-cli')
    expect(said).not.toContain('brew install')
    // 采集那两项不受影响 —— 这一句要说出来,不然他以为整块都坏了。
    expect(said).toContain('采集那两项不受影响')
  })

  it('工具都在、模型还没下时,提前说清「第一次要等」', () => {
    const said = toolsNote({ ffmpeg: '/x/ffmpeg', whisper: '/x/whisper-cli' }, 'base')
    expect(said).toContain('147 MB')
    expect(said).toContain('报进度')
  })

  it('都齐了就说清楚「全在你这台电脑上跑」', () => {
    const said = toolsNote({ ffmpeg: '/x/ffmpeg', whisper: '/x/w', modelFile: '/x/m.bin' }, 'base')
    expect(said).toContain('不上传')
  })
})

describe('runBreakdown:每一步失败都如实说、当场停', () => {
  const videoNote: CollectedNote = {
    id: 'fake', title: '假标题', desc: '假文案', kind: 'video', tags: ['假标签'],
    images: [], video: { url: 'https://fake.example/大-1111.mp4', ms: 66_000 },
  }

  async function dir(): Promise<string> { return await mkdtemp(join(tmpdir(), 'wb-breakdown-')) }

  /** 一个"什么都在"的桩。`which` 回一个假路径,别的命令什么都不做。 */
  function deps(over: Partial<Parameters<typeof runBreakdown>[3]> = {}) {
    return {
      home: '/nowhere',
      // ★ 这台开发机上 ffmpeg 是真装着的,所以「有没有这个命令」必须打桩 ——
      //   不然"缺 ffmpeg 就停下"那条用例在这台机器上根本走不到那个分支。
      find: async (name: string) => `/fake/bin/${name}`,
      run: async () => '',
      fetchTo: async () => { /* 不走网 */ },
      chat: async () => '开头|00:00|自报家门\n钩子|00:07|第一句抛了结论\n结尾|01:06|给了收藏的理由',
      now: () => Date.parse('2026-09-22T02:00:00Z'),
      ...over,
    }
  }

  it('★ 没接模型就不跑 —— 不去下视频、不去转写', async () => {
    const target = await dir()
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, { home: '/nowhere' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('模型服务还没接上')
  })

  it('缺 ffmpeg 就停在那里', async () => {
    const target = await dir()
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      find: async (name: string) => (name === 'ffmpeg' ? undefined : `/fake/bin/${name}`),
    }))
    expect(result.message).toBe(NO_FFMPEG)
  })

  it('缺 whisper-cli 就停在那里', async () => {
    const target = await dir()
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      find: async (name: string) => (name === 'whisper-cli' ? undefined : `/fake/bin/${name}`),
    }))
    expect(result.message).toBe(NO_WHISPER)
  })

  it('★ 视频下不下来:如实说,并且明说「我不会拿 cookie 去换」', async () => {
    const target = await dir()
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      fetchTo: async (url: string) => {
        if (url.includes('huggingface')) return
        throw new Error('curl 回了 22:HTTP 403')
      },
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('403')
    expect(result.message).toContain('不会拿 cookie 去换')
  })

  it('★ 转写一句都没出来:不调模型,也不写一份编的框架', async () => {
    const target = await dir()
    let asked = 0
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      chat: async () => { asked++; return 'x' },
      // whisper 跑完什么都不写 → 读不到 SRT。
      run: async () => '',
    }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不给一份编的框架')
    expect(asked).toBe(0)
  })

  it('★ 一条路走通:落 逐字稿.md 与 拆解.md,拆解里每段带时间戳', async () => {
    const target = await dir()
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      run: async (_file: string, args: readonly string[]) => {
        // whisper 那一趟:`-of <前缀>` 之后自己写一份 .srt 出来。
        const ofAt = args.indexOf('-of')
        if (ofAt >= 0) await writeFile(`${args[ofAt + 1]}.srt`, FAKE_SRT, 'utf8')
        return ''
      },
    }))
    expect(result.ok).toBe(true)
    const md = await readFile(join(target, '拆解.md'), 'utf8')
    expect(md).toContain('## 开头 · `00:00`')
    expect(md).toContain('## 钩子 · `00:07`')
    expect(md).toContain('机器转的')
    const transcript = await readFile(join(target, '逐字稿.md'), 'utf8')
    expect(transcript).toContain('假逐字稿第一句')
  })

  /**
   * ★ 繁→简那一层的端到端:喂进去的是 **2026-09-21 真跑出来的那份繁体 SRT**
   * (`REAL_SRT_TRADITIONAL`,逐字抄的),落盘的逐字稿必须是简体。
   */
  it('★ whisper 出的是繁体:逐字稿落盘时已经是简体,并且记了一行', async () => {
    const target = await dir()
    const said: string[] = []
    const prompts: string[] = []
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      onStep: (line: string) => { said.push(line) },
      chat: async (prompt: string) => {
        prompts.push(prompt)
        return '开头|00:00|自报家门\n钩子|00:08|第一句抛了结论'
      },
      run: async (_file: string, args: readonly string[]) => {
        const ofAt = args.indexOf('-of')
        if (ofAt >= 0) await writeFile(`${args[ofAt + 1]}.srt`, REAL_SRT_TRADITIONAL, 'utf8')
        return ''
      },
    }))
    expect(result.ok).toBe(true)

    const transcript = await readFile(join(target, '逐字稿.md'), 'utf8')
    expect(transcript).toContain('今天这条我们只讲一件事')
    expect(transcript).toContain('结尾不要说谢谢观看')
    // 一个繁体字都不许剩下(挑原文里最显眼的几个钉住)。
    for (const 繁 of ['這', '們', '講', '個', '節', '說', '頭', '麼']) expect(transcript).not.toContain(繁)
    // 头上那句话说了转过。
    expect(transcript).toContain('已经替你转成简体')

    // ★ 记了一行:占比、那条线、以及「只换字形」。
    const 那一行 = said.find(line => line.includes('繁体'))
    expect(那一行).toBeDefined()
    expect(那一行).toContain('36.8%')
    expect(那一行).toContain('10%')
    expect(那一行).toContain('没改用词')

    // ★ 交给模型的也是简体 —— 不然模型看着繁体写框架,引用的原话又跟逐字稿对不上。
    expect(prompts[0]).toContain('今天这条我们只讲一件事')
    expect(prompts[0]).not.toContain('這')
  })

  it('★ whisper 出的本来就是简体:一个字都不动,也不记那一行', async () => {
    const target = await dir()
    const said: string[] = []
    const result = await runBreakdown(videoNote, target, FAKE_NOTE_URL, deps({
      onStep: (line: string) => { said.push(line) },
      run: async (_file: string, args: readonly string[]) => {
        const ofAt = args.indexOf('-of')
        if (ofAt >= 0) await writeFile(`${args[ofAt + 1]}.srt`, FAKE_SRT, 'utf8')
        return ''
      },
    }))
    expect(result.ok).toBe(true)
    const transcript = await readFile(join(target, '逐字稿.md'), 'utf8')
    expect(transcript).toContain('假逐字稿第一句:开头在这里')
    expect(transcript).toContain('不用转')
    expect(said.some(line => line.includes('转成简体'))).toBe(false)
  })

  it('图文笔记:没有图也没有视频 → 如实说没得拆', async () => {
    const target = await dir()
    const result = await runBreakdown(
      { id: 'x', tags: [], images: [] },
      target, FAKE_NOTE_URL, deps(),
    )
    expect(result.message).toBe(NO_VIDEO)
  })

  it('★ 图文笔记走「图 N」那一支,不去碰 ffmpeg / whisper', async () => {
    const target = await dir()
    const touched: string[] = []
    const result = await runBreakdown(
      { id: 'x', title: '假图文', tags: [], images: ['https://fake.example/1.jpg', 'https://fake.example/2.jpg'] },
      target, FAKE_NOTE_URL,
      deps({
        chat: async () => '开头|图 1|第一张是封面\n钩子|图 2|第二张给了对比',
        run: async (file: string) => { touched.push(file); return '' },
      }),
    )
    expect(result.ok).toBe(true)
    // ★ 一个外部命令都没跑过。
    expect(touched).toEqual([])
    const md = await readFile(join(target, '拆解.md'), 'utf8')
    expect(md).toContain('## 开头 · `图 1`')
    expect(md).toContain('模型没有看见图本身')
  })
})
