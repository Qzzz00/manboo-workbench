// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createModelService } from '../src/server/modelService.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const SETTINGS = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`

const TOKEN = 'wb_issued-in-this-test'

function relayImpl(): typeof fetch {
  return async (url) => {
    const href = String(url)
    if (href.endsWith('/register-device')) return new Response(JSON.stringify({ token: TOKEN }), { status: 201 })
    if (href.endsWith('/usage')) {
      return new Response(JSON.stringify({
        day: '2026-09-17', used_tokens: 800, daily_token_limit: 50_000, remaining_tokens: 49_200,
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
}

async function serve(over: { isLoopback?: () => boolean, withModel?: boolean, noRelay?: true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-modelroute-'))
  dirs.push(root)
  const dshHome = join(root, '.dsh')
  await mkdir(join(dshHome, 'workbench'), { recursive: true })
  await writeFile(join(dshHome, 'settings.yaml'), SETTINGS)
  // 用例跑的是开源缺省(构建不带中转);这里测的是接了中转的那一档,地址写进 model.json(同我们的构建 / 自建中转)。
  if (over.noRelay !== true) await writeFile(join(dshHome, 'workbench', 'model.json'), JSON.stringify({ relay_url: 'https://relay.test' }))

  const model = createModelService({
    modelFile: join(dshHome, 'workbench', 'model.json'),
    credentialFile: join(dshHome, 'workbench', 'credentials.json'),
    dshHome,
    fetchImpl: relayImpl(),
  })

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    ...(over.withModel === false ? {} : { model }),
    ...(over.isLoopback === undefined ? {} : { isLoopback: over.isLoopback }),
  })
  started.push(server)
  return server
}

describe('GET /model', () => {
  it('第一次打开:用工作台提供的服务、还没接上,且回包里没有任何令牌', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/model`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({
      mode: 'relay', relay_token_configured: false, own_key_configured: false, ready: false,
    })
    expect(text).not.toContain(TOKEN)
  })

  it('没接这个服务时 404(旧版本插件的行为),不是 500', async () => {
    const server = await serve({ withModel: false })
    expect((await fetch(`${server.url}/model`)).status).toBe(404)
  })
})

describe('PUT /model', () => {
  it('切到中转:领到凭证、回包里有今日用量、但没有凭证本身', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'relay' }),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    const body = JSON.parse(text) as { ok: boolean, status: Record<string, unknown>, hints: string[] }
    expect(body.ok).toBe(true)
    expect(body.status).toMatchObject({ mode: 'relay', relay_token_configured: true, ready: true })
    expect((body.status.usage as { used_tokens: number }).used_tokens).toBe(800)
    expect(text).not.toContain(TOKEN)
    expect(body.hints.join('\n')).toContain('不用填任何东西')
  })

  it('这台没接中转:切到中转回 409 + code no_relay,一句人话,不是 500', async () => {
    const server = await serve({ noRelay: true })
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'relay' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { code?: string, error?: string, status?: { relay_configured?: boolean } }
    expect(body.code).toBe('no_relay')
    expect(body.error).toContain('这台没接中转')
    expect(body.status?.relay_configured).toBe(false)
  })

  it('切成 own', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'own' }),
    })
    expect((await res.json() as { status: { mode: string } }).status.mode).toBe('own')
  })

  it('mode 不对回 400,一句人话', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: '火星' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('自己的 DeepSeek Key')
  })

  it('坏 JSON 回 400', async () => {
    const server = await serve()
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{坏',
    })
    expect(res.status).toBe(400)
  })

  it('不是本机就不许改 —— 同 /credentials 那条规矩', async () => {
    const server = await serve({ isLoopback: () => false })
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'own' }),
    })
    expect(res.status).toBe(403)
    // 读还是可以的(手机以后也要看今天还剩多少)。
    expect((await fetch(`${server.url}/model`)).status).toBe(200)
  })
})

describe('POST /model/reissue', () => {
  it('重新领一次', async () => {
    const server = await serve()
    await fetch(`${server.url}/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'relay' }),
    })
    const res = await fetch(`${server.url}/model/reissue`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json() as { status: { ready: boolean } }).status.ready).toBe(true)
  })

  it('不是本机就不许领', async () => {
    const server = await serve({ isLoopback: () => false })
    expect((await fetch(`${server.url}/model/reissue`, { method: 'POST' })).status).toBe(403)
  })
})

describe('PUT /model · own 档自己接的端点(2026-10-23)', () => {
  it('收下地址与模型名:状态里读得出来;坏的地址回 400 一句人话', async () => {
    const server = await serve()
    const ok = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'own', own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'deepseek-v4-flash' }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json() as { status: Record<string, unknown> }).status)
      .toMatchObject({ mode: 'own', own_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', own_model: 'deepseek-v4-flash' })

    const bad = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'own', own_base_url: 'ark.test' }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toContain('http')
  })

  it('不是本机就不许改', async () => {
    const server = await serve({ isLoopback: () => false })
    const res = await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'own', own_model: 'm' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /model/try(2026-10-23)', () => {
  it('没填 Key:不发包,回一句人话', async () => {
    const server = await serve()
    // 切到「自己的账号」但还没填 Key —— 「试一下」要说出缺的是密钥。
    await fetch(`${server.url}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'own' }),
    })
    const res = await fetch(`${server.url}/model/try`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean, message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('密钥')
  })

  it('不是本机不许试', async () => {
    const server = await serve({ isLoopback: () => false })
    expect((await fetch(`${server.url}/model/try`, { method: 'POST' })).status).toBe(403)
  })
})
