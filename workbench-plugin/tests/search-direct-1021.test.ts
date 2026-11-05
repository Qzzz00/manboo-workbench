// @vitest-environment node
/**
 * 资讯搜索的三条路(2026-10-21,局域网 M7):自己的博查密钥直连 → 中转 → 都没有就如实说「搜索没配」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveCredential } from '../src/server/credentials.ts'
import { BOCHA_SEARCH_URL, createFeedSearch, SEARCH_NOT_CONFIGURED, normalizeSearchResults } from '../src/server/searchDirect.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function box(model?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-search-'))
  dirs.push(dir)
  const modelFile = join(dir, 'model.json')
  if (model !== undefined) writeFileSync(modelFile, JSON.stringify(model))
  return { modelFile, credentialFile: join(dir, 'credentials.json') }
}

const BOCHA_BODY = {
  data: { webPages: { value: [
    { name: '标题一', url: 'https://a.example/1', summary: '长摘要', snippet: '短', siteName: '甲站', datePublished: '2026-10-20' },
    { name: '没链接的丢掉' },
  ] } },
}

function recorder(body: unknown, status = 200) {
  const seen: { url: string, auth?: string | undefined, body?: unknown }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { impl, seen }
}

describe('资讯搜索', () => {
  it('填了自己的博查密钥:直连博查,不经中转(接了中转也一样)', async () => {
    const b = box({ mode: 'relay', relay_url: 'https://relay.test', relay_token: 'wb_x' })
    await saveCredential(b.credentialFile, 'bocha', 'bocha-key-fake')
    const net = recorder(BOCHA_BODY)
    const result = await createFeedSearch({ ...b, fetchImpl: net.impl })('AI 播客', 3)
    expect(net.seen).toHaveLength(1)
    expect(net.seen[0]).toMatchObject({ url: BOCHA_SEARCH_URL, auth: 'Bearer bocha-key-fake' })
    expect(net.seen[0]?.body).toMatchObject({ query: 'AI 播客', count: 3, freshness: 'oneWeek', summary: true })
    expect(result).toEqual({
      ok: true,
      results: [{ title: '标题一', url: 'https://a.example/1', snippet: '长摘要', source: '甲站', published_at: '2026-10-20' }],
    })
  })

  it('没填博查、接了中转:走中转那条老路', async () => {
    const b = box({ mode: 'relay', relay_url: 'https://relay.test', relay_token: 'wb_x' })
    const net = recorder({ results: [{ title: 't', url: 'https://u.example', snippet: 's' }] })
    const result = await createFeedSearch({ ...b, fetchImpl: net.impl })('q', 2)
    expect(net.seen[0]).toMatchObject({ url: 'https://relay.test/v1/search', auth: 'Bearer wb_x' })
    expect(result.ok).toBe(true)
  })

  it('没接中转、也没填博查:一个包都不发,说搜索没配、去哪填', async () => {
    const b = box()
    const net = recorder({})
    const result = await createFeedSearch({ ...b, fetchImpl: net.impl })('q', 2)
    expect(net.seen).toEqual([])
    expect(result).toEqual({ ok: false, error: SEARCH_NOT_CONFIGURED })
  })

  it('博查回错:一句人话,不带上游原文', async () => {
    const b = box()
    await saveCredential(b.credentialFile, 'bocha', 'bocha-key-fake')
    const result = await createFeedSearch({ ...b, fetchImpl: recorder({ message: 'key=bocha-key-fake 无效' }, 401).impl })('q', 2)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('bocha-key-fake')
  })

  it('认得博查与扁平数组两种回包,认不出就是 0 条', () => {
    expect(normalizeSearchResults(BOCHA_BODY)).toHaveLength(1)
    expect(normalizeSearchResults([{ title: 't', link: 'https://l.example' }])).toEqual([{ title: 't', url: 'https://l.example', snippet: '' }])
    expect(normalizeSearchResults({ 别的: 1 })).toEqual([])
  })
})
