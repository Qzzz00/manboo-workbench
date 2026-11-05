/**
 * 「讲到哪条亮哪条」那张表(2026-10-13,卡「播客页重做」★1)。
 *
 * 盯住的几条:
 *   - 时长是**量出来的**:同一份 MPEG2/160kbps/24kHz 的字节,算出来要与 `afinfo` 当年报的
 *     20.688 秒对得上(交接-0921 第四节那条出处);
 *   - 量不出来**才**按字数估,而且那一段要标 `estimated` —— 估的就说是估的(D13);
 *   - **老稿子(没有记号)照旧整篇一次合成、不写 segments**:宁可不亮,也不猜「这会儿大概在讲第三条」;
 *   - 记号只进提示词与解析,**不进落盘的稿子**(手机上那份文字稿里不许出现方括号)。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHARS_PER_MINUTE, createFeedService, estimatePodcastMs, podcastFileName, podcastItemIds,
  podcastPrompt, segmentsOf, splitPodcastScript, type FeedFile, type FeedItem,
} from '../src/server/feed.ts'
import { mp3DurationMs } from '../src/server/mp3Duration.ts'

/** MPEG2 layer III / 160kbps / 24kHz / 单声道:一帧 480 字节、24ms(= 576 采样 / 24000)。 */
const FRAME_BYTES = 480
const FRAME_MS = 576 / 24000 * 1000

function mpegFrames(count: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES)
  frame[0] = 0xff
  frame[1] = 0xf3
  frame[2] = 0xe4
  frame[3] = 0xc0
  return Buffer.concat(Array.from({ length: count }, () => frame))
}

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'feed-seg-'))
}

function item(over: Partial<FeedItem> & { id: string }): FeedItem {
  return {
    project_id: 'p1',
    project_name: '工作台',
    title: '标题',
    url: `https://a.example/${over.id}`,
    why: '有关系',
    score: 5,
    follow_up: false,
    date: '2026-10-13',
    at: 0,
    ...over,
  }
}

describe('mp3DurationMs', () => {
  it('从帧头量出来,跟 afinfo 当年报的那一段对得上', () => {
    // 413,760 字节 = 862 帧 → 20.688 秒(交接-0921-资讯与播客 第四节那条出处)。
    const bytes = mpegFrames(862)
    expect(bytes.length).toBe(413_760)
    expect(mp3DurationMs(bytes)).toBe(20_688)
  })

  it('几段接起来 = 各段相加(mp3 的帧自描述,所以直接相接也量得准)', () => {
    const a = mpegFrames(10)
    const b = mpegFrames(15)
    expect(mp3DurationMs(Buffer.concat([a, b]))).toBe((mp3DurationMs(a) as number) + (mp3DurationMs(b) as number))
  })

  it('前面挂着 ID3v2 也量得出来', () => {
    const head = Buffer.alloc(10 + 32)
    head.write('ID3', 0, 'ascii')
    head[6] = 0
    head[7] = 0
    head[8] = 0
    head[9] = 32
    expect(mp3DurationMs(Buffer.concat([head, mpegFrames(5)]))).toBe(Math.round(5 * FRAME_MS))
  })

  it('不是 MPEG 就回 undefined —— 不硬凑一个数出来', () => {
    expect(mp3DurationMs(Buffer.from('这不是音频,是一段字'))).toBeUndefined()
    expect(mp3DurationMs(Buffer.alloc(0))).toBeUndefined()
  })
})

describe('splitPodcastScript', () => {
  const ids = ['a', 'b', 'c']

  it('按记号分段,记号不进落盘的稿子', () => {
    const text = '[[0]] 今天两件事。\n\n[[1]] 第一条,模型降价了。\n\n[[2]] 第二条,平台改了规则。\n\n[[0]] 就这些。'
    const got = splitPodcastScript(text, ids)
    expect(got.blocks.map(b => b.item_id)).toEqual([undefined, 'a', 'b', undefined])
    expect(got.script).not.toContain('[[')
    expect(got.script).toContain('今天两件事。')
    expect(got.blocks[1]?.text).toBe('第一条,模型降价了。')
  })

  it('一个记号都没有 = 老稿子:整篇一块、不挂条目', () => {
    const got = splitPodcastScript('先说第一条,模型降价了。再一个,平台改了规则。', ids)
    expect(got.blocks).toHaveLength(1)
    expect(got.blocks[0]?.item_id).toBeUndefined()
    expect(got.script).toBe('先说第一条,模型降价了。再一个,平台改了规则。')
  })

  it('相邻两段同一条并成一块(那条在音频里才是连续的一段)', () => {
    const got = splitPodcastScript('[[1]] 前半句。\n\n[[1]] 后半句。\n\n[[2]] 另一条。', ids)
    expect(got.blocks.map(b => b.item_id)).toEqual(['a', 'b'])
    expect(got.blocks[0]?.text).toBe('前半句。\n\n后半句。')
  })

  it('认不出的号当没挂条目:话照样合成,只是不亮', () => {
    const got = splitPodcastScript('[[9]] 不知道这是第几条。', ids)
    expect(got.blocks).toHaveLength(1)
    expect(got.blocks[0]?.item_id).toBeUndefined()
    expect(got.blocks[0]?.text).toBe('不知道这是第几条。')
  })

  it('只换一行、不留空行也切得开(记号绝不许被念出来)', () => {
    const text = '[[0]] 今天两件事。\n[[1]] 第一条,模型降价了。\n[[2]] 第二条,规则改了。'
    const got = splitPodcastScript(text, ids)
    expect(got.blocks.map(b => b.item_id)).toEqual([undefined, 'a', 'b'])
    expect(got.blocks.every(b => !b.text.includes('[['))).toBe(true)
    expect(got.script).not.toContain('[[')
  })

  it('句中残留的记号摘掉(模型写歪了也不许念出来)', () => {
    const got = splitPodcastScript('[[1]] 第一条讲 [[2]] 这件事。', ids)
    expect(got.blocks).toHaveLength(1)
    expect(got.blocks[0]?.text).not.toContain('[[')
    expect(got.blocks[0]?.item_id).toBe('a')
  })

  it('第一个记号之前那几句不丢', () => {
    const got = splitPodcastScript('早上好。\n[[1]] 第一条。', ids)
    expect(got.blocks.map(b => b.item_id)).toEqual([undefined, 'a'])
    expect(got.blocks[0]?.text).toBe('早上好。')
  })

  it('空稿子不出块', () => {
    expect(splitPodcastScript('   ', ids).blocks).toEqual([])
  })
})

describe('podcastPrompt / podcastItemIds', () => {
  it('清单带号,号的顺序与 podcastItemIds 一致', () => {
    const groups = [
      { project_name: '工作台', items: [item({ id: 'a', title: '甲' }), item({ id: 'b', title: '乙' })] },
      { project_name: '小红书号', items: [item({ id: 'c', title: '丙' })] },
    ]
    const prompt = podcastPrompt({ name: 'Ben', minutes: 4, groups })
    expect(prompt).toContain('1. 《甲》')
    expect(prompt).toContain('2. 《乙》')
    expect(prompt).toContain('3. 《丙》')
    expect(prompt).toContain('[[n]]')
    expect(podcastItemIds(groups)).toEqual(['a', 'b', 'c'])
  })
})

describe('segmentsOf', () => {
  it('量得出来就用真数,开头结尾那几块照样占时间', () => {
    const got = segmentsOf([
      { bytes: [mpegFrames(10)], chars: 20 },
      { item_id: 'a', bytes: [mpegFrames(20)], chars: 40 },
      { item_id: 'b', bytes: [mpegFrames(30)], chars: 60 },
    ])
    expect(got).toEqual([
      { item_id: 'a', start_ms: Math.round(10 * FRAME_MS), end_ms: Math.round(30 * FRAME_MS) },
      { item_id: 'b', start_ms: Math.round(30 * FRAME_MS), end_ms: Math.round(60 * FRAME_MS) },
    ])
    expect(got.every(one => one.estimated === undefined)).toBe(true)
  })

  it('量不出来才按字数估,而且标 estimated', () => {
    const got = segmentsOf([{ item_id: 'a', bytes: [Buffer.from('不是音频')], chars: CHARS_PER_MINUTE }])
    expect(got[0]?.estimated).toBe(true)
    expect(got[0]?.end_ms).toBe(estimatePodcastMs(CHARS_PER_MINUTE))
    expect(got[0]?.end_ms).toBe(60_000)
  })
})

describe('makePodcast:按条目分段合成', () => {
  async function run(script: string, tts: (text: string) => { buffer: Buffer, contentType: string }) {
    const dir = await tmpDir()
    const calls: string[] = []
    const service = createFeedService({
      file: join(dir, 'feed.json'),
      configFile: join(dir, 'feed-config.json'),
      projects: async () => [{ id: 'p1', name: '工作台' }],
      search: async () => ({
        ok: true,
        results: [
          { title: '甲', url: 'https://a.example/1', snippet: '一', source: '甲媒' },
          { title: '乙', url: 'https://b.example/2', snippet: '二', source: '乙媒' },
        ],
      }),
      chat: async prompt => (prompt.includes('口播稿') ? script : '[{"i":0,"score":5,"why":"有关系"},{"i":1,"score":4,"why":"也有"}]'),
      tts: async (text) => { calls.push(text); return tts(text) },
      now: () => Date.parse('2026-10-13T07:00:00+08:00'),
    })
    await service.load()
    await service.setConfig({
      version: 1,
      enabled: true,
      per_project: 5,
      podcast: true,
      podcast_minutes: 4,
      interests: [{ project_id: 'p1', project_name: '工作台', keywords: ['事务官'] }],
    })
    await service.run()
    return { service, calls, dir }
  }

  it('一条一块地合成,segments 落进 /feed 与盘上', async () => {
    const { service, calls, dir } = await run(
      '[[0]] 今天两件事。\n\n[[1]] 第一条,模型降价了。\n\n[[2]] 第二条,规则改了。\n\n[[0]] 就这些。',
      () => ({ buffer: mpegFrames(10), contentType: 'audio/mpeg' }),
    )
    // 四块:开头、第一条、第二条、结尾。
    expect(calls).toHaveLength(4)
    expect(calls[1]).toBe('第一条,模型降价了。')
    const podcast = service.view().podcast
    expect(podcast?.file).toBe(podcastFileName('2026-10-13'))
    expect(podcast?.script).not.toContain('[[')
    const segments = podcast?.segments
    expect(segments).toHaveLength(2)
    expect(segments?.[0]?.start_ms).toBe(Math.round(10 * FRAME_MS))
    expect(segments?.[0]?.end_ms).toBe(Math.round(20 * FRAME_MS))
    expect(segments?.[1]?.start_ms).toBe(Math.round(20 * FRAME_MS))
    // 真落盘了,而且读回来还在(parseSegments)。
    const saved = JSON.parse(await readFile(join(dir, 'feed.json'), 'utf8')) as FeedFile
    expect(saved.podcasts[0]?.segments).toHaveLength(2)
  })

  it('老稿子(没记号):整篇一次合成、不写 segments', async () => {
    const { service, calls } = await run(
      '先说第一条,模型降价了。再一个,规则改了。',
      () => ({ buffer: mpegFrames(10), contentType: 'audio/mpeg' }),
    )
    expect(calls).toHaveLength(1)
    expect(service.view().podcast?.file).toBe(podcastFileName('2026-10-13'))
    expect(service.view().podcast?.segments).toBeUndefined()
  })

  it('读回盘上的坏条:挑掉坏的,一张空表整格缺席', async () => {
    const dir = await tmpDir()
    await writeFile(join(dir, 'feed.json'), JSON.stringify({
      version: 1,
      items: [],
      last_run_at: 1,
      podcasts: [
        { date: '2026-10-13', script: 's', file: 'f.mp3', at: 1, segments: [{ item_id: 'a', start_ms: 0, end_ms: 10 }, { start_ms: 1 }, { item_id: 'b', start_ms: 'x', end_ms: 2 }] },
        { date: '2026-10-12', script: 's', file: 'g.mp3', at: 1, segments: [{ item_id: '' }] },
      ],
    }))
    const service = createFeedService({
      file: join(dir, 'feed.json'),
      configFile: join(dir, 'feed-config.json'),
      projects: async () => [],
      now: () => Date.parse('2026-10-13T07:00:00+08:00'),
    })
    await service.load()
    expect(service.view('2026-10-13').podcast?.segments).toEqual([{ item_id: 'a', start_ms: 0, end_ms: 10 }])
    expect(service.view('2026-10-12').podcast?.segments).toBeUndefined()
  })
})
