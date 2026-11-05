// @vitest-environment node
/**
 * 对外地址可配(2026-10-21,开源整理):默认与之前写死的一字不差;
 * `~/.dsh/workbench/endpoints.json` 或环境变量能换,写 "off" 能关。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAidjService, DEFAULT_AIDJ_BASE } from '../src/server/aidj.ts'
import { createBriefService } from '../src/server/brief.ts'
import { DEFAULT_ENDPOINTS, DEFAULT_UV_BOOTSTRAP_URL, DEFAULT_VIZ_CDN_URL, defaultEndpointsFile, loadEndpoints } from '../src/server/endpoints.ts'
import { AIHOT_BASE_URL } from '../src/server/feedAihot.ts'
import { DEFAULT_MANIFEST_URL } from '../src/server/update/service.ts'

function home(json?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-endpoints-'))
  if (json !== undefined) {
    mkdirSync(join(dir, '.dsh/workbench'), { recursive: true })
    writeFileSync(defaultEndpointsFile(dir), typeof json === 'string' ? json : JSON.stringify(json))
  }
  return dir
}

describe('loadEndpoints', () => {
  it('什么都没配:就是今天写死的那几个地址', () => {
    expect(loadEndpoints(home(), {})).toEqual(DEFAULT_ENDPOINTS)
    expect(DEFAULT_ENDPOINTS).toEqual({
      aiboo_url: DEFAULT_AIDJ_BASE,
      aihot_url: AIHOT_BASE_URL,
      // 更新清单缺省 = 构建带的那一个(src/buildEndpoints.ts);用例跑的是开源缺省(空)= 不查更新。
      update_manifest_url: undefined,
      viz_cdn_url: DEFAULT_VIZ_CDN_URL,
      uv_bootstrap_url: DEFAULT_UV_BOOTSTRAP_URL,
    })
    expect(DEFAULT_MANIFEST_URL).toBe('')
    expect(DEFAULT_ENDPOINTS.aiboo_url).toBe('http://your-aiboo-host:3456')
    expect(DEFAULT_ENDPOINTS.viz_cdn_url).toBe(DEFAULT_VIZ_CDN_URL)
    expect(DEFAULT_ENDPOINTS.uv_bootstrap_url).toBe(DEFAULT_UV_BOOTSTRAP_URL)
  })

  it('开源构建(不带更新地址)也能在 endpoints.json 里自己填一个', () => {
    expect(loadEndpoints(home({ update_manifest_url: 'https://mirror.example.test/latest.json' }), {}).update_manifest_url)
      .toBe('https://mirror.example.test/latest.json')
  })

  it('文件里写了就用它(去掉末尾斜杠);环境变量压过文件', () => {
    const dir = home({
      aiboo_url: 'https://my-aiboo.example.test/',
      aihot_url: 'https://hot.example.test',
      viz_cdn_url: 'https://my-cdn.example.test/vis.js',
      uv_bootstrap_url: 'https://my-uv.example.test/install.sh',
    })
    expect(loadEndpoints(dir, {})).toMatchObject({
      aiboo_url: 'https://my-aiboo.example.test',
      aihot_url: 'https://hot.example.test',
      viz_cdn_url: 'https://my-cdn.example.test/vis.js',
      uv_bootstrap_url: 'https://my-uv.example.test/install.sh',
    })
    expect(loadEndpoints(dir, {
      WORKBENCH_AIBOO_URL: 'http://127.0.0.1:3456',
      WORKBENCH_UPDATE_URL: 'http://127.0.0.1:1/latest.json',
      WORKBENCH_VIZ_CDN_URL: 'http://127.0.0.1:2/vis.js',
      WORKBENCH_UV_BOOTSTRAP_URL: 'http://127.0.0.1:3/install.sh',
    }))
      .toEqual({
        aiboo_url: 'http://127.0.0.1:3456',
        aihot_url: 'https://hot.example.test',
        update_manifest_url: 'http://127.0.0.1:1/latest.json',
        viz_cdn_url: 'http://127.0.0.1:2/vis.js',
        uv_bootstrap_url: 'http://127.0.0.1:3/install.sh',
      })
  })

  it('写 "off" 就关掉那一条(undefined = 不连)', () => {
    expect(loadEndpoints(home({
      aiboo_url: 'off',
      aihot_url: 'off',
      update_manifest_url: 'off',
      viz_cdn_url: 'off',
      uv_bootstrap_url: 'off',
    }), {}))
      .toEqual({
        aiboo_url: undefined,
        aihot_url: undefined,
        update_manifest_url: undefined,
        viz_cdn_url: undefined,
        uv_bootstrap_url: undefined,
      })
    expect(loadEndpoints(home(), { WORKBENCH_AIHOT_URL: 'off' }).aihot_url).toBeUndefined()
    expect(loadEndpoints(home(), { WORKBENCH_VIZ_CDN_URL: 'off' }).viz_cdn_url).toBeUndefined()
    expect(loadEndpoints(home(), { WORKBENCH_UV_BOOTSTRAP_URL: 'off' }).uv_bootstrap_url).toBeUndefined()
  })

  it('坏文件、认不出的值(不是 http/https)一律退回默认,不抛', () => {
    expect(loadEndpoints(home('{坏'), {})).toEqual(DEFAULT_ENDPOINTS)
    expect(loadEndpoints(home({ aiboo_url: 'file:///etc/passwd', aihot_url: 42 }), { WORKBENCH_UPDATE_URL: '' })).toEqual(DEFAULT_ENDPOINTS)
  })
})

describe('消费方', () => {
  it('今晨快报:默认打 Aiboo 那条;换了地址就打新地址;关了一次都不连', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ status: 'empty', topics: [] }))
    }) as unknown as typeof fetch
    const dir = mkdtempSync(join(tmpdir(), 'wb-brief-'))
    await createBriefService({ file: join(dir, 'a.json'), fetchImpl }).view()
    await createBriefService({ file: join(dir, 'b.json'), fetchImpl, baseUrl: 'https://my.example.test' }).view()
    expect(seen).toEqual(['http://your-aiboo-host:3456/api/dj/commute/today', 'https://my.example.test/api/dj/commute/today'])
    expect(await createBriefService({ file: join(dir, 'c.json'), fetchImpl, baseUrl: null }).view()).toBeUndefined()
    expect(seen).toHaveLength(2)
  })

  it('AiDJ:默认地址跟着 endpoints 走;存偏好时不把默认地址写死进 aidj-config.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-aidj-'))
    const configFile = join(dir, 'aidj-config.json')
    const aidj = createAidjService({ configFile, defaultBase: 'https://my-aiboo.example.test' })
    await aidj.load()
    expect(aidj.config().base_url).toBe('https://my-aiboo.example.test')
    await aidj.setConfig({ enabled: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).not.toHaveProperty('base_url')
    await aidj.setConfig({ base_url: 'https://picked.example.test' })
    expect(JSON.parse(readFileSync(configFile, 'utf8')).base_url).toBe('https://picked.example.test')
  })
})
