// @vitest-environment node
/**
 * `/feed/aidj` 两条路由(2026-09-22)。真起 8791、真走 HTTP,Aiboo 那边打桩。
 *
 * 盯住三件:
 *   ① **没接 AIDJ → 404**,与「接了但今天 Aiboo 那边没生成」(200 + status=empty)分得开
 *      —— 手机凭这个决定是退回单人口播还是说一句「今天还没生成」;
 *   ② 回给手机的音频地址是**指向 Aiboo 的绝对地址**(手机直接去拉,不经工作台);
 *   ③ 开关改了会落盘,下次起来还认。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createAidjService, DEFAULT_AIDJ_BASE, type AidjService } from '../src/server/aidj.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-aidj-'))
  dirs.push(dir)
  return dir
}

const TODAY = '2026-09-21'

/** 照 2026-09-21 真取到的那份写的一期节目。 */
const FAKE_PROGRAM = {
  date: TODAY,
  status: 'ready',
  bed: null,
  topics: [{ id: 'dfcca394b788e', section: '今日资讯', title: 'Gemini 安全测试', summary: '…', url: 'https://x.example/1', source: 'MarkTechPost' }],
  segments: [
    { id: 's1', speaker: '机车妹', hostIndex: 1, text: '早啊各位!', audio_url: '/uploads/tts/a.mp3', duration_ms: 5500, tier: 'opening', topicId: 'dfcca394b788e' },
    { id: 's2', speaker: '刘飞', hostIndex: 2, text: '先说第一条。', audio_url: '/uploads/tts/b.mp3', duration_ms: 4500, tier: 'flash', topicId: 'dfcca394b788e' },
  ],
}

/**
 * 起一个**他自己打开过 AIDJ** 的服务:先把那份偏好落到盘上,再 `load()` 读回来。
 *
 * 2026-09-30 起缺省是关着的(止血 7,维护者:「现在确实用的少,先关掉吧」)——
 * 下面这些用例钉的是「开着的时候这两条路由怎么走」,所以得先把它打开;
 * 「从来没打开过 → off」那一条单列在最后。
 */
function makeAidj(body: unknown, status = 200): { aidj: AidjService, configFile: string } {
  const configFile = join(tempDir(), 'aidj-config.json')
  writeFileSync(configFile, JSON.stringify({ enabled: true, push_interests: true, base_url: DEFAULT_AIDJ_BASE }))
  const aidj = createAidjService({
    configFile,
    today: () => TODAY,
    fetch: (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  })
  return { aidj, configFile }
}

async function serve(aidj?: AidjService): Promise<string> {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(Date.parse(`${TODAY}T07:30:00`) / 1000) }),
    tickIntervalMs: 0,
    ...(aidj === undefined ? {} : { aidj }),
  })
  started.push(server)
  return server.url
}

describe('GET /feed/aidj', () => {
  it('没接 AIDJ → 404(手机凭它原样退回单人口播)', async () => {
    const url = await serve()
    const res = await fetch(`${url}/feed/aidj`)
    expect(res.status).toBe(404)
  })

  it('取到今天那期 → 200 + status=ready,**音频是指向 Aiboo 的绝对地址**', async () => {
    const { aidj } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      status: string
      program?: { segments: { audio_url?: string, speaker: string }[], topics: unknown[], hosts: string[] }
      config: { base_url: string }
    }
    expect(body.status).toBe('ready')
    expect(body.program?.segments[0]?.audio_url).toBe(`${DEFAULT_AIDJ_BASE}/uploads/tts/a.mp3`)
    expect(body.program?.hosts).toEqual(['机车妹', '刘飞'])
    expect(body.program?.topics).toHaveLength(1)
    expect(body.config.base_url).toBe(DEFAULT_AIDJ_BASE)
  })

  it('Aiboo 今天还没生成 → **200 + status=empty**(不是 404,也不是错误)', async () => {
    const { aidj } = makeAidj({ date: TODAY, status: 'empty', bed: null, topics: [], segments: [] })
    await aidj.load()
    const url = await serve(aidj)
    const body = await (await fetch(`${url}/feed/aidj`)).json() as { status: string, error?: string }
    expect(body.status).toBe('empty')
    expect(body.error).toBeUndefined()
  })

  it('Aiboo 上最新那期是昨天的 → status=stale + 说清是哪天(**不播**)', async () => {
    const { aidj } = makeAidj({ ...FAKE_PROGRAM, date: '2026-09-20' })
    await aidj.load()
    const url = await serve(aidj)
    const body = await (await fetch(`${url}/feed/aidj`)).json() as { status: string, error?: string, program?: unknown }
    expect(body.status).toBe('stale')
    expect(body.error).toContain('2026-09-20')
    expect(body.program).toBeUndefined()
  })

  it('Aiboo 挂了 → status=error + 原话,**200**(界面据此退回单人口播)', async () => {
    const { aidj } = makeAidj({ error: 'boom' }, 502)
    await aidj.load()
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj`)
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string, error?: string }
    expect(body.status).toBe('error')
    expect(body.error).toContain('502')
  })

  /**
   * ★ 2026-09-30(止血 7):**从来没打开过这个开关的那台机器** —— 没有 `aidj-config.json`。
   * 缺省关着:200 + `status=off`,一次都不去打 Aiboo;`config` 里如实说它关着(手机上能打开)。
   */
  it('★没打开过 AIDJ(没有偏好文件)→ 200 + status=off,一次请求都不发', async () => {
    let hits = 0
    const aidj = createAidjService({
      configFile: join(tempDir(), '没有这个文件.json'),
      today: () => TODAY,
      fetch: (async () => { hits += 1; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch,
    })
    await aidj.load()
    const url = await serve(aidj)
    const body = await (await fetch(`${url}/feed/aidj`)).json() as {
      status: string
      program?: unknown
      config: { enabled: boolean, push_interests: boolean }
    }
    expect(body.status).toBe('off')
    expect(body.program).toBeUndefined()
    expect(body.config).toMatchObject({ enabled: false, push_interests: false })
    expect(hits).toBe(0)
  })
})

describe('POST /feed/aidj/config', () => {
  it('关掉之后落盘,再问就是 off(一次都不去打 Aiboo)', async () => {
    const { aidj, configFile } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { config: { enabled: boolean } }).config.enabled).toBe(false)
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toMatchObject({ enabled: false })
    expect((await (await fetch(`${url}/feed/aidj`)).json() as { status: string }).status).toBe('off')
  })

  it('body 不是 JSON → 400', async () => {
    const { aidj } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ 不是 json',
    })
    expect(res.status).toBe(400)
  })

  it('没接 AIDJ → 404', async () => {
    const url = await serve()
    const res = await fetch(`${url}/feed/aidj/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
  })
})

/**
 * Aiboo 令牌(2026-09-22)。这一节只盯一件事:**它下不去手机**。
 * 存在 `~/.dsh/workbench/aidj-config.json` 里,两条路由回给手机的都只有「存没存」。
 */
describe('Aiboo 令牌不回显', () => {
  it('GET /feed/aidj 的 config 里没有 token,只有 token_set', async () => {
    const { aidj } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    await aidj.setConfig({ token: 's3cr3t-abc' })
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj`)
    const text = await res.text()
    expect(text).not.toContain('s3cr3t')
    const body = JSON.parse(text) as { config: { token_set?: boolean, token?: string } }
    expect(body.config.token_set).toBe(true)
    expect(body.config.token).toBeUndefined()
  })

  it('没填的时候 token_set=false', async () => {
    const { aidj } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    const url = await serve(aidj)
    const body = await (await fetch(`${url}/feed/aidj`)).json() as { config: { token_set?: boolean } }
    expect(body.config.token_set).toBe(false)
  })

  it('POST /feed/aidj/config 存得下,**回包里不回显**,落盘的是真值', async () => {
    const { aidj, configFile } = makeAidj(FAKE_PROGRAM)
    await aidj.load()
    const url = await serve(aidj)
    const res = await fetch(`${url}/feed/aidj/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 's3cr3t-abc' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('s3cr3t')
    expect(JSON.parse(text)).toMatchObject({ ok: true, config: { token_set: true } })
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toMatchObject({ token: 's3cr3t-abc' })
  })
})
