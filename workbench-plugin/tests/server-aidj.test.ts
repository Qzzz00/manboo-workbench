// @vitest-environment node
/**
 * 资讯播客接 Aiboo AIDJ(2026-09-22,server/aidj.ts)。
 *
 * 分两半:
 *   ① **纯函数** —— 归一化 Aiboo 的 `/api/dj/commute/today` 回包、拼绝对音频地址、
 *      按分数把当天资讯压成「兴趣点」关键词串。一行 I/O 都不碰。
 *   ② **服务** —— `fetch` 打桩,盯住四条纪律:
 *      取不到就如实说(**不拿昨天的冒充今天**)、Aiboo 没装补丁(404)不算错、
 *      推信源失败不连累取节目、关了 AIDJ 就整块不去打它。
 *
 * 假数据全部照着 2026-09-21 真取到的那一份的形状写(见
 * `docs/设计-资讯播客接AIDJ-2026-09-22.md` 第五节),**不是我编的字段名**。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aidjAudioUrl, createAidjService, interestKeywords, normalizeCommute, parseAidjConfig,
  publicAidjConfig, DEFAULT_AIDJ_CONFIG,
  type AidjConfig, type AidjRawPayload,
} from '../src/server/aidj.ts'
import { createFeedService } from '../src/server/feed.ts'
import type { FeedItem, FeedProjectGroup } from '../src/server/feed.ts'

const BASE = 'http://your-aiboo-host:3456'

/** 一段照真形状写的口播。 */
function seg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '415a5c4d-97ab-477b-9196-fbb133266bf6',
    speaker: '机车妹',
    hostIndex: 1,
    text: '早啊各位!今天天气不错,心情也跟着飞扬起来。',
    audio_url: '/uploads/tts/1789945243690-94c4205f949f2c89.mp3',
    duration_ms: 5500,
    tier: 'opening',
    topicId: 'dfcca394b788e',
    ...over,
  }
}

function topic(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dfcca394b788e',
    section: '今日资讯',
    title: 'Google 确认 Gemini 在安全测试中访问 3 家真实公司系统',
    summary: 'Google 于 9 月 18 日确认…',
    url: 'https://www.marktechpost.com/2026/09/20/you-too-google',
    source: 'MarkTechPost',
    ...over,
  }
}

function raw(over: Partial<AidjRawPayload> = {}): AidjRawPayload {
  return {
    date: '2026-09-21',
    status: 'ready',
    bed: null,
    topics: [topic()],
    segments: [seg()],
    ...over,
  } as AidjRawPayload
}

function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'i1', project_id: 'p1', project_name: '桌面工作台', title: '中转计费新规',
    url: 'https://a.example/1', why: '你们的中转就是转这家', score: 4, follow_up: false,
    date: '2026-09-21', at: 1, ...over,
  }
}

function group(over: Partial<FeedProjectGroup> = {}): FeedProjectGroup {
  return { project_id: 'p1', project_name: '桌面工作台', items: [item()], ...over }
}

// ---------------------------------------------------------------- 纯函数

describe('aidjAudioUrl', () => {
  it('相对路径拼上 Aiboo 的地址', () => {
    expect(aidjAudioUrl(BASE, '/uploads/tts/a.mp3')).toBe(`${BASE}/uploads/tts/a.mp3`)
  })

  it('base 末尾多一条斜杠不会拼出两条', () => {
    expect(aidjAudioUrl(`${BASE}/`, '/uploads/tts/a.mp3')).toBe(`${BASE}/uploads/tts/a.mp3`)
  })

  it('已经是绝对地址就原样回(哪天 Aiboo 换了 CDN 不用改这里)', () => {
    expect(aidjAudioUrl(BASE, 'https://cdn.example/a.mp3')).toBe('https://cdn.example/a.mp3')
  })

  it('空的回 undefined —— 不编一个地址出来', () => {
    expect(aidjAudioUrl(BASE, '')).toBeUndefined()
    expect(aidjAudioUrl(BASE, undefined)).toBeUndefined()
  })
})

describe('normalizeCommute', () => {
  it('按真形状归一:段落有序、音频绝对、话题带过来', () => {
    const p = normalizeCommute(raw(), BASE)
    expect(p.date).toBe('2026-09-21')
    expect(p.status).toBe('ready')
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0]?.audio_url).toBe(`${BASE}/uploads/tts/1789945243690-94c4205f949f2c89.mp3`)
    expect(p.segments[0]?.speaker).toBe('机车妹')
    expect(p.segments[0]?.topic_id).toBe('dfcca394b788e')
    expect(p.topics[0]?.title).toContain('Gemini')
  })

  it('没有一段口播 → status=empty(**不是 ready**)', () => {
    expect(normalizeCommute(raw({ segments: [] }), BASE).status).toBe('empty')
  })

  it('TTS 失败那一行(audio_url=null)**留着**,只是没有地址', () => {
    const p = normalizeCommute(raw({ segments: [seg({ audio_url: null })] }), BASE)
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0]?.audio_url).toBeUndefined()
    expect(p.segments[0]?.text).not.toBe('')
  })

  it('没有文字的段丢掉 —— 一段既没字又没音的东西播不出来也读不出来', () => {
    const p = normalizeCommute(raw({ segments: [seg(), seg({ id: 'x', text: '  ' })] }), BASE)
    expect(p.segments).toHaveLength(1)
  })

  it('duration_ms 不是数就当 0(它本来就是 Aiboo 按字数估的,不拿它报时长)', () => {
    const p = normalizeCommute(raw({ segments: [seg({ duration_ms: 'いっぱい' })] }), BASE)
    expect(p.segments[0]?.duration_ms).toBe(0)
  })

  it('总时长 = 各段之和,并标明它是估的', () => {
    const p = normalizeCommute(raw({ segments: [seg(), seg({ id: 'b', duration_ms: 4500 })] }), BASE)
    expect(p.estimated_total_ms).toBe(10000)
  })

  it('topicId 为 null 的段不带话题(不硬塞第一张卡片)', () => {
    const p = normalizeCommute(raw({ segments: [seg({ topicId: null })] }), BASE)
    expect(p.segments[0]?.topic_id).toBeUndefined()
  })

  it('音乐床有就带上(Aiboo 现在恒 null,但字段还在)', () => {
    const p = normalizeCommute(
      raw({ bed: { id: 'q1', ncm_id: '123', title: '晨光', artist: '某某' } } as Partial<AidjRawPayload>),
      BASE,
    )
    expect(p.bed?.url).toBe(`${BASE}/api/track/stream?id=q1`)
    expect(p.bed?.title).toBe('晨光')
  })

  it('音乐床没有 id 就整块不要(拼不出取流地址)', () => {
    const p = normalizeCommute(raw({ bed: { ncm_id: '123' } } as Partial<AidjRawPayload>), BASE)
    expect(p.bed).toBeUndefined()
  })

  it('主播名单从段落里数出来,按出场顺序', () => {
    const p = normalizeCommute(raw({
      segments: [seg(), seg({ id: 'b', speaker: '刘飞', hostIndex: 2 }), seg({ id: 'c' })],
    }), BASE)
    expect(p.hosts).toEqual(['机车妹', '刘飞'])
  })

  it('整包不是对象 / 缺字段也不抛,回一份空的', () => {
    expect(normalizeCommute(null as unknown as AidjRawPayload, BASE).status).toBe('empty')
    expect(normalizeCommute({} as AidjRawPayload, BASE).segments).toEqual([])
  })
})

describe('interestKeywords', () => {
  it('按分数降序取主题词', () => {
    const words = interestKeywords([group({
      items: [
        item({ id: 'a', title: '博查搜索接口涨价了', score: 1 }),
        item({ id: 'b', title: '大模型中转计费新规', score: 5 }),
      ],
    })])
    expect(words[0]).toContain('中转计费')
  })

  it('一个项目最多贡献两个词 —— 不让它把名额占满', () => {
    const words = interestKeywords([group({
      items: [
        item({ id: 'a', title: '中转计费新规', score: 5 }),
        item({ id: 'b', title: '搜索接口涨价', score: 4 }),
        item({ id: 'c', title: '模型蒸馏方法', score: 3 }),
      ],
    })], { perProject: 2 })
    expect(words).toHaveLength(2)
  })

  it('两个项目各出各的', () => {
    const words = interestKeywords([
      group({ items: [item({ title: '中转计费新规', score: 5 })] }),
      group({ project_id: 'p2', project_name: '小红书', items: [item({ id: 'z', title: '小红书评论采集', score: 4 })] }),
    ])
    expect(words).toHaveLength(2)
  })

  it('重复的词只留一个', () => {
    const words = interestKeywords([group({
      items: [item({ id: 'a', title: '中转计费,新规落地' }), item({ id: 'b', title: '中转计费,又变了' })],
    })])
    expect(words).toEqual(['中转计费'])
  })

  it('「不看了」的那些不推过去 —— 他刚说了不想看', () => {
    const words = interestKeywords([group({
      items: [item({ id: 'a', title: '中转计费,新规落地', feedback: 'mute' }), item({ id: 'b', title: '搜索接口,涨价了' })],
    })])
    expect(words).toEqual(['搜索接口'])
  })

  it('0 分的不推(模型判了跟他没关系)', () => {
    expect(interestKeywords([group({ items: [item({ score: 0 })] })])).toEqual([])
  })

  it('整串截到 500 字以内(Aiboo 的 MAX_INTERESTS_LEN)', () => {
    const many = Array.from({ length: 60 }, (_, i) => group({
      project_id: `p${i}`, project_name: `项目${i}`,
      items: [item({ id: `i${i}`, title: `这是第${i}条很长很长的资讯标题用来把串撑爆`, score: 5 })],
    }))
    expect(interestKeywords(many).join(',').length).toBeLessThanOrEqual(500)
  })

  it('没有条目就回空 —— 空串推过去等于把他原来填的兴趣点清了', () => {
    expect(interestKeywords([])).toEqual([])
  })
})

describe('parseAidjConfig', () => {
  /**
   * ★ 2026-09-30(止血 7,维护者:「现在确实用的少,先关掉吧」):**缺省是关着的**。
   * 地址照旧写着 —— 他哪天打开开关不用再填一遍。
   */
  it('★缺席时两个开关都关着;地址还是 Ben 那台阿里云', () => {
    const c = parseAidjConfig(undefined)
    expect(c.enabled).toBe(false)
    expect(c.push_interests).toBe(false)
    expect(c.base_url).toBe(DEFAULT_AIDJ_CONFIG.base_url)
    expect(DEFAULT_AIDJ_CONFIG.enabled).toBe(false)
    expect(DEFAULT_AIDJ_CONFIG.push_interests).toBe(false)
  })

  it('★已经在用的人不受影响:文件里明写着开着,就照文件来', () => {
    const c = parseAidjConfig({ enabled: true, push_interests: true })
    expect(c.enabled).toBe(true)
    expect(c.push_interests).toBe(true)
  })

  it('认自定义地址,末尾斜杠削掉', () => {
    expect(parseAidjConfig({ base_url: 'http://1.2.3.4:3456/' }).base_url).toBe('http://1.2.3.4:3456')
  })

  it('不是 http/https 的地址不认,退回默认(别让一行配置把请求打到奇怪的地方)', () => {
    expect(parseAidjConfig({ base_url: 'file:///etc/passwd' }).base_url).toBe(DEFAULT_AIDJ_CONFIG.base_url)
    expect(parseAidjConfig({ base_url: '不是地址' }).base_url).toBe(DEFAULT_AIDJ_CONFIG.base_url)
  })

  it('关得掉', () => {
    expect(parseAidjConfig({ enabled: false }).enabled).toBe(false)
    expect(parseAidjConfig({ push_interests: false }).push_interests).toBe(false)
  })
})

// ---------------------------------------------------------------- 服务

type StubInit = { method?: string, body?: string, headers?: Record<string, string> }
type Handler = (url: string, init?: StubInit) => Promise<Response> | Response
/** 记下来的一次调用。`headers` 是为了验**凭据只跟着写请求走**(2026-09-22 加的那把令牌)。 */
type StubCall = { url: string, method: string, body?: string, headers: Record<string, string> }

function stubFetch(handler: Handler): { calls: StubCall[], fetch: typeof fetch } {
  const calls: StubCall[] = []
  const fn = (async (input: unknown, init?: StubInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(init?.body === undefined ? {} : { body: init.body }),
      headers: init?.headers ?? {},
    })
    return await handler(url, init)
  }) as unknown as typeof fetch
  return { calls, fetch: fn }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * **他自己打开过 AIDJ 的那一份偏好**。
 *
 * 2026-09-30 起缺省是关着的(止血 7),下面这些用例钉的是「开着的时候怎么走」——
 * 所以它们一律从这一份出发,而不是从 `DEFAULT_AIDJ_CONFIG`。
 * 「关着怎么走」的那几条在「偏好落盘」与 program 的 `off` 那一条里。
 */
const AIDJ_ON: AidjConfig = { ...DEFAULT_AIDJ_CONFIG, enabled: true, push_interests: true }

describe('createAidjService · 取节目', () => {
  it('取到就归一化回来,并记下是几点取的', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse(raw()))
    const aidj = createAidjService({ config: () => AIDJ_ON, fetch, now: () => 1000, today: () => '2026-09-21' })
    const view = await aidj.program()
    expect(view.status).toBe('ready')
    expect(view.program?.segments).toHaveLength(1)
    expect(view.fetched_at).toBe(1000)
    expect(calls[0]?.url).toBe(`${DEFAULT_AIDJ_CONFIG.base_url}/api/dj/commute/today`)
  })

  it('Aiboo 说今天还没生成 → status=empty,**不报错**', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ date: '2026-09-21', topics: [], segments: [], status: 'empty' }))
    const view = await createAidjService({ config: () => AIDJ_ON, fetch, today: () => '2026-09-21' }).program()
    expect(view.status).toBe('empty')
    expect(view.error).toBeUndefined()
  })

  it('连不上 → status=error + 一句人话,**没有 program**', async () => {
    const { fetch } = stubFetch(() => { throw new Error('connect ECONNREFUSED your-aiboo-host:3456') })
    const view = await createAidjService({ config: () => AIDJ_ON, fetch, today: () => '2026-09-21' }).program()
    expect(view.status).toBe('error')
    expect(view.error).toContain('连不上')
    expect(view.program).toBeUndefined()
  })

  it('回了 500 → status=error,带上状态码', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: 'boom' }, 500))
    const view = await createAidjService({ config: () => AIDJ_ON, fetch, today: () => '2026-09-21' }).program()
    expect(view.status).toBe('error')
    expect(view.error).toContain('500')
  })

  it('回了读不懂的东西 → status=error,不当成空节目', async () => {
    const { fetch } = stubFetch(() => new Response('<html>502</html>', { status: 200 }))
    const view = await createAidjService({ config: () => AIDJ_ON, fetch, today: () => '2026-09-21' }).program()
    expect(view.status).toBe('error')
  })

  it('关了就整块不去打它(一次请求都不发)', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse(raw()))
    const view = await createAidjService({ config: () => ({ ...DEFAULT_AIDJ_CONFIG, enabled: false }), fetch, today: () => '2026-09-21' }).program()
    expect(view.status).toBe('off')
    expect(calls).toHaveLength(0)
  })

  it('缓存:同一分钟内再问不再打服务器', async () => {
    let hits = 0
    const { fetch } = stubFetch(() => { hits += 1; return jsonResponse(raw()) })
    let ms = 1000
    const aidj = createAidjService({ config: () => AIDJ_ON, fetch, now: () => ms, today: () => '2026-09-21' })
    await aidj.program()
    await aidj.program()
    expect(hits).toBe(1)
    ms += 10 * 60 * 1000
    await aidj.program()
    expect(hits).toBe(2)
  })

  it('**不拿昨天的冒充今天**:缓存里是昨天那期就重新去取', async () => {
    let day = '2026-09-20'
    const { fetch } = stubFetch(() => jsonResponse(raw({ date: day })))
    let ms = 1000
    const aidj = createAidjService({ config: () => AIDJ_ON, fetch, now: () => ms, today: () => '2026-09-21' })
    const first = await aidj.program()
    expect(first.status).toBe('stale')
    expect(first.error).toContain('2026-09-20')
    day = '2026-09-21'
    ms += 10 * 60 * 1000
    expect((await aidj.program()).status).toBe('ready')
  })

  it('取失败之后**不留**上一次成功的那份在缓存里顶包', async () => {
    let ok = true
    const { fetch } = stubFetch(() => (ok ? jsonResponse(raw()) : jsonResponse({}, 503)))
    let ms = 1000
    const aidj = createAidjService({ config: () => AIDJ_ON, fetch, now: () => ms, today: () => '2026-09-21' })
    expect((await aidj.program()).status).toBe('ready')
    ok = false
    ms += 10 * 60 * 1000
    const view = await aidj.program()
    expect(view.status).toBe('error')
    expect(view.program).toBeUndefined()
  })
})

describe('createAidjService · 推信源', () => {
  it('先推条目接口;Aiboo 装了补丁就只走它', async () => {
    const { calls, fetch } = stubFetch(url => (url.endsWith('/api/dj/commute/source')
      ? jsonResponse({ ok: true, accepted: 1 })
      : jsonResponse({}, 404)))
    const r = await createAidjService({ config: () => AIDJ_ON, fetch })
      .push([group()], '2026-09-21')
    expect(r.ok).toBe(true)
    expect(r.note).toContain('条目')
    expect(calls.map(c => c.url)).toContain(`${DEFAULT_AIDJ_CONFIG.base_url}/api/dj/commute/source`)
    const body = JSON.parse(calls[0]?.body ?? '{}') as { items?: { title?: string, project?: string }[] }
    expect(body.items?.[0]?.project).toBe('桌面工作台')
  })

  it('Aiboo 还没装补丁(404)→ **不算错**,退回推兴趣点', async () => {
    const { calls, fetch } = stubFetch(url => (url.endsWith('/api/dj/commute/source')
      ? jsonResponse({ error: 'not found' }, 404)
      : jsonResponse({ commute: { interests: '中转计费' } })))
    const r = await createAidjService({ config: () => AIDJ_ON, fetch })
      .push([group()], '2026-09-21')
    expect(r.ok).toBe(true)
    expect(r.note).toContain('兴趣点')
    const cfg = calls.find(c => c.url.endsWith('/api/dj/mode-config'))
    expect(cfg?.method).toBe('POST')
    expect(JSON.parse(cfg?.body ?? '{}')).toEqual({ commute: { interests: '中转计费新规' } })
  })

  it('**只写 commute.interests 一个字段** —— 主播人设是 Ben 在后台填的,不许我们碰', async () => {
    const { calls, fetch } = stubFetch(url => (url.endsWith('/api/dj/commute/source')
      ? jsonResponse({}, 404)
      : jsonResponse({})))
    await createAidjService({ config: () => AIDJ_ON, fetch }).push([group()], '2026-09-21')
    const body = JSON.parse(calls.find(c => c.url.endsWith('/api/dj/mode-config'))?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['commute'])
    expect(Object.keys(body.commute as object)).toEqual(['interests'])
  })

  it('没有够得上的条目就**一次都不推** —— 空串会把他原来填的兴趣点清掉', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({}))
    const r = await createAidjService({ config: () => AIDJ_ON, fetch })
      .push([group({ items: [item({ score: 0 })] })], '2026-09-21')
    expect(r.ok).toBe(false)
    expect(r.note).toContain('没有')
    expect(calls).toHaveLength(0)
  })

  it('偏好里把「推信源」关了就不推(节目照取)', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({}))
    const r = await createAidjService({ config: () => ({ ...AIDJ_ON, push_interests: false }), fetch })
      .push([group()], '2026-09-21')
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('推不动就如实说一句,不抛(它不该连累整轮资讯)', async () => {
    const { fetch } = stubFetch(() => { throw new Error('socket hang up') })
    const r = await createAidjService({ config: () => AIDJ_ON, fetch }).push([group()], '2026-09-21')
    expect(r.ok).toBe(false)
    expect(r.note).toContain('推')
  })

  it('推完顺手请 Aiboo 重生成(没这条接口就 404,静默)', async () => {
    const { calls, fetch } = stubFetch(url => (url.endsWith('/api/dj/commute/source')
      ? jsonResponse({}, 404)
      : jsonResponse({ ok: true })))
    await createAidjService({ config: () => AIDJ_ON, fetch }).push([group()], '2026-09-21')
    expect(calls.some(c => c.url.endsWith('/api/dj/commute/regenerate'))).toBe(true)
  })
})

describe('createAidjService · 偏好落盘', () => {
  it('没有文件时是默认;改了之后读得回来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const configFile = join(dir, 'aidj-config.json')
    const { fetch } = stubFetch(() => jsonResponse(raw()))
    const a = createAidjService({ configFile, fetch })
    await a.load()
    expect(a.config()).toEqual(DEFAULT_AIDJ_CONFIG)
    await a.setConfig({ enabled: false })
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toMatchObject({ enabled: false })

    const b = createAidjService({ configFile, fetch })
    await b.load()
    expect(b.config().enabled).toBe(false)
  })

  it('只给一个键不会把别的冲掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const a = createAidjService({ configFile: join(dir, 'c.json') })
    await a.load()
    await a.setConfig({ base_url: 'http://1.2.3.4:3456' })
    expect(a.config()).toEqual({ enabled: false, base_url: 'http://1.2.3.4:3456', push_interests: false })
  })

  /**
   * ★ 2026-09-30(止血 7):**缺省关掉不许把已经打开过的人一起关掉**。
   * 他那份 `aidj-config.json` 里明写着 `enabled: true`,重启之后照旧开着。
   */
  it('★他自己打开过的:落盘那一份明写着开着,重新读回来还是开着', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const configFile = join(dir, 'aidj-config.json')
    const a = createAidjService({ configFile })
    await a.load()
    expect(a.config().enabled).toBe(false)
    await a.setConfig({ enabled: true, push_interests: true })
    // 落盘的是整份(两个布尔都明写着),不是一个补丁。
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toMatchObject({ enabled: true, push_interests: true })

    const b = createAidjService({ configFile })
    await b.load()
    expect(b.config().enabled).toBe(true)
    expect(b.config().push_interests).toBe(true)
  })

  it('★从来没动过这个开关的(没有这个文件)→ 关着,一次请求都不发', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const { calls, fetch } = stubFetch(() => jsonResponse(raw()))
    const a = createAidjService({ configFile: join(dir, '没有这个文件.json'), fetch })
    await a.load()
    expect(a.config().enabled).toBe(false)
    expect((await a.program()).status).toBe('off')
    // 推信源那一路也不打服务器,而且**一个字都不往早报的 note 里加**(不是每天说一遍「关着」)。
    expect(await a.push([group()], '2026-09-21')).toEqual({ ok: false, note: '' })
    expect(calls).toEqual([])
    // 回给手机那一份如实说它关着(开关在手机设置里,他随时能打开)。
    expect(a.publicConfig()).toMatchObject({ enabled: false, push_interests: false, token_set: false })
  })

  it('文件坏了就走默认,不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const configFile = join(dir, 'c.json')
    await writeFile(configFile, '{ 这不是 json')
    const a = createAidjService({ configFile })
    await a.load()
    expect(a.config()).toEqual(DEFAULT_AIDJ_CONFIG)
  })

  it('换了地址之后缓存作废(不拿上一台的节目顶包)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    let hits = 0
    const { fetch } = stubFetch(() => { hits += 1; return jsonResponse(raw()) })
    const a = createAidjService({ configFile: join(dir, 'c.json'), fetch, today: () => '2026-09-21' })
    await a.load()
    // 2026-09-30 起缺省关着(止血 7):这一条钉的是开着时换地址的行为,先打开它。
    await a.setConfig({ enabled: true })
    await a.program()
    await a.setConfig({ base_url: 'http://1.2.3.4:3456' })
    await a.program()
    expect(hits).toBe(2)
  })
})

// ---------------------------------------------------------------- 接进资讯管线

/** 起一份最小可跑的资讯服务,`aidj` 那只手可以打桩。 */
async function feedWith(aidj?: {
  ready?: () => Promise<{ ready: boolean, note?: string }>
  push?: (groups: readonly FeedProjectGroup[], date: string) => Promise<{ ok: boolean, note: string }>
}): Promise<{ service: ReturnType<typeof createFeedService>, tts: string[], pushed: FeedProjectGroup[][] }> {
  const dir = await mkdtemp(join(tmpdir(), 'feed-aidj-'))
  const tts: string[] = []
  const pushed: FeedProjectGroup[][] = []
  const service = createFeedService({
    file: join(dir, 'feed.json'),
    configFile: join(dir, 'feed-config.json'),
    projects: async () => [{ id: 'p1', name: '桌面工作台' }],
    search: async () => ({ ok: true, results: [{ title: '中转计费新规', url: 'https://a.example/1', snippet: '摘要' }] }),
    chat: async prompt => (prompt.includes('口播稿') ? '今天的稿子。' : '[{"i":0,"score":5,"why":"有关系"}]'),
    tts: async (text) => { tts.push(text); return { buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' } },
    now: () => Date.parse('2026-09-21T07:00:00+08:00'),
    ...(aidj === undefined ? {} : {
      aidj: {
        ready: aidj.ready ?? (async () => ({ ready: true })),
        push: aidj.push ?? (async (groups) => { pushed.push([...groups]); return { ok: true, note: '已推' } }),
      },
    }),
  })
  await service.load()
  await service.setConfig({ interests: [{ project_id: 'p1', project_name: '桌面工作台', keywords: ['中转'] }] })
  return { service, tts, pushed }
}

describe('createFeedService · 接上 AIDJ 之后', () => {
  it('AIDJ 那期在 → **不自己合成**,note 里说清楚走的是 Aiboo', async () => {
    const { service, tts } = await feedWith({ ready: async () => ({ ready: true }) })
    const r = await service.run()
    expect(tts).toEqual([])
    expect(r.note).toContain('Aiboo 的双主播节目')
    expect(service.view('2026-09-21').podcast).toBeUndefined()
  })

  it('AIDJ 取不到 → **退回单人口播**,并把原因带进 note', async () => {
    const { service, tts } = await feedWith({
      ready: async () => ({ ready: false, note: '连不上 Aiboo(http://…):socket hang up' }),
    })
    const r = await service.run()
    expect(tts.length).toBeGreaterThan(0)
    expect(r.note).toContain('连不上 Aiboo')
    expect(service.view('2026-09-21').podcast?.file).toBeDefined()
  })

  it('推信源拿到的是**打过分的那份**(按项目分组)', async () => {
    const { service, pushed } = await feedWith({})
    await service.run()
    expect(pushed[0]?.[0]?.project_name).toBe('桌面工作台')
    expect(pushed[0]?.[0]?.items[0]?.score).toBe(5)
  })

  it('推信源抛了也只是一句 note,资讯照落', async () => {
    const { service } = await feedWith({ push: async () => { throw new Error('socket hang up') } })
    const r = await service.run()
    expect(r.added).toBe(1)
    expect(r.note).toContain('没能把资讯推给 Aiboo')
  })

  it('问 AIDJ 时抛了 → 当成取不到,退回单人口播', async () => {
    const { service, tts } = await feedWith({ ready: async () => { throw new Error('boom') } })
    const r = await service.run()
    expect(tts.length).toBeGreaterThan(0)
    expect(r.note).toContain('没能问到 Aiboo')
  })

  it('播客整个关着时**连问都不问 Aiboo**(省一次请求)', async () => {
    let asked = 0
    const { service } = await feedWith({ ready: async () => { asked += 1; return { ready: true } } })
    await service.setConfig({ podcast: false })
    await service.run()
    expect(asked).toBe(0)
  })
})

// ---------------------------------------------------------------- Aiboo 令牌(2026-09-22)
/**
 * Aiboo 把 `/api/dj/*` 的**写**路由关上了(它那边 `fix/dj-api-auth`,
 * `server/middleware/djWriteAuth.cjs`)。工作台这边认的凭据就一把:
 * 请求头 `X-Aidj-Token` == 服务器 `.env` 里的 `AIDJ_WORKBENCH_TOKEN`。
 *
 * 三条纪律,下面逐条钉住:
 *   ① **只跟着写请求走**。取节目那条(`GET /api/dj/commute/today`)Aiboo 维持匿名,
 *      带过去只是白白多一份凭据在网上跑;
 *   ② **不回显**。存进 `aidj-config.json`,`GET /feed/aidj` 只说存没存;
 *   ③ **不进日志、不进错误原话**。401 的那句提示里一个字符的令牌都不许有。
 */

describe('parseAidjConfig · 令牌', () => {
  it('没填时**字段缺席**(不是空串)—— 缺席与「填了个空的」在界面上是一句话', () => {
    expect(parseAidjConfig(undefined).token).toBeUndefined()
    expect(DEFAULT_AIDJ_CONFIG.token).toBeUndefined()
  })

  it('填了就留着,首尾空白削掉(从别处拷过来常带一个换行)', () => {
    expect(parseAidjConfig({ token: '  s3cr3t-abc  ' }).token).toBe('s3cr3t-abc')
  })

  it('填空串 = 清掉(Ben 换令牌时要清得掉)', () => {
    expect(parseAidjConfig({ token: '' }, { ...DEFAULT_AIDJ_CONFIG, token: 'old' }).token).toBeUndefined()
  })

  it('不是字符串就当没说,原来那把不动', () => {
    expect(parseAidjConfig({ token: 123 }, { ...DEFAULT_AIDJ_CONFIG, token: 'old' }).token).toBe('old')
  })

  it('只改别的键不会把令牌冲掉', () => {
    const before = { ...DEFAULT_AIDJ_CONFIG, token: 'keep-me' }
    expect(parseAidjConfig({ ...before, enabled: false }, before)).toEqual({ ...before, enabled: false })
  })
})

describe('publicAidjConfig', () => {
  it('**不回显令牌**,只说存没存', () => {
    const pub = publicAidjConfig({ ...DEFAULT_AIDJ_CONFIG, token: 's3cr3t-abc' })
    expect(pub.token_set).toBe(true)
    expect(JSON.stringify(pub)).not.toContain('s3cr3t')
    expect((pub as unknown as Record<string, unknown>).token).toBeUndefined()
  })

  it('没填 → token_set=false,别的字段原样', () => {
    const pub = publicAidjConfig(DEFAULT_AIDJ_CONFIG)
    expect(pub).toEqual({
      enabled: DEFAULT_AIDJ_CONFIG.enabled,
      base_url: DEFAULT_AIDJ_CONFIG.base_url,
      push_interests: DEFAULT_AIDJ_CONFIG.push_interests,
      token_set: false,
    })
  })
})

describe('createAidjService · 令牌只跟着写请求走', () => {
  const withToken = { ...AIDJ_ON, token: 's3cr3t-abc' }

  it('取节目那条**不带**(Aiboo 的读路由维持匿名)', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse(raw()))
    await createAidjService({ config: () => withToken, fetch, today: () => '2026-09-21' }).program()
    expect(calls[0]?.url).toContain('/api/dj/commute/today')
    expect(calls[0]?.headers['x-aidj-token']).toBeUndefined()
  })

  it('推条目 / 请重生成**都带**', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({ ok: true }))
    const r = await createAidjService({ config: () => withToken, fetch }).push([group()], '2026-09-21')
    expect(r.ok).toBe(true)
    const source = calls.find(c => c.url.endsWith('/api/dj/commute/source'))
    const regen = calls.find(c => c.url.endsWith('/api/dj/commute/regenerate'))
    expect(source?.headers['x-aidj-token']).toBe('s3cr3t-abc')
    expect(regen?.headers['x-aidj-token']).toBe('s3cr3t-abc')
    // content-type 一个没丢。
    expect(source?.headers['content-type']).toBe('application/json')
  })

  it('退回兴趣点那条老路时也带(`POST /api/dj/mode-config` 同样被关上了)', async () => {
    const { calls, fetch } = stubFetch(url => (url.endsWith('/api/dj/commute/source')
      ? jsonResponse({}, 404)
      : jsonResponse({})))
    await createAidjService({ config: () => withToken, fetch }).push([group()], '2026-09-21')
    expect(calls.find(c => c.url.endsWith('/api/dj/mode-config'))?.headers['x-aidj-token']).toBe('s3cr3t-abc')
  })

  it('没配令牌 → **一个请求也不带这个头**(不发一个空的凭据过去)', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({ ok: true }))
    const aidj = createAidjService({ config: () => AIDJ_ON, fetch, today: () => '2026-09-21' })
    await aidj.program()
    await aidj.push([group()], '2026-09-21')
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every(c => c.headers['x-aidj-token'] === undefined)).toBe(true)
  })

  it('Aiboo 回 401 → 说清是**要凭据**,并且那句话里没有令牌本身', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({ error: '未授权' }, 401))
    const r = await createAidjService({ config: () => withToken, fetch }).push([group()], '2026-09-21')
    expect(r.ok).toBe(false)
    expect(r.note).toContain('令牌')
    expect(r.note).not.toContain('s3cr3t')
    // 401 就别再拿同一把令牌去敲兴趣点那条了 —— 它一样是写路由,一样会 401。
    expect(calls.some(c => c.url.endsWith('/api/dj/mode-config'))).toBe(false)
  })
})

describe('createAidjService · 令牌落盘与不回显', () => {
  it('存进配置文件;`publicConfig()` 里没有它,只说存了', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const configFile = join(dir, 'c.json')
    const a = createAidjService({ configFile })
    await a.load()
    expect(a.publicConfig().token_set).toBe(false)

    await a.setConfig({ token: 's3cr3t-abc' })
    expect(a.config().token).toBe('s3cr3t-abc')
    expect(a.publicConfig().token_set).toBe(true)
    expect(JSON.stringify(a.publicConfig())).not.toContain('s3cr3t')
    // 真值只在 Ben 本机那份 aidj-config.json 里。
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toMatchObject({ token: 's3cr3t-abc' })

    // 起来之后还认。
    const b = createAidjService({ configFile })
    await b.load()
    expect(b.config().token).toBe('s3cr3t-abc')
  })

  it('改别的开关不会把令牌冲掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const a = createAidjService({ configFile: join(dir, 'c.json') })
    await a.load()
    await a.setConfig({ token: 's3cr3t-abc' })
    await a.setConfig({ push_interests: false })
    expect(a.config().token).toBe('s3cr3t-abc')
    expect(a.config().push_interests).toBe(false)
  })

  it('填空串清得掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aidj-'))
    const configFile = join(dir, 'c.json')
    const a = createAidjService({ configFile })
    await a.load()
    await a.setConfig({ token: 's3cr3t-abc' })
    await a.setConfig({ token: '' })
    expect(a.config().token).toBeUndefined()
    expect(a.publicConfig().token_set).toBe(false)
    expect(await readFile(configFile, 'utf8')).not.toContain('s3cr3t')
  })
})
