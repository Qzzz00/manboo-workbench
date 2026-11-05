// @vitest-environment node
/**
 * 外观配置一份两端共用(2026-09-16,决策记录同日第 1 条):
 * `~/.dsh/workbench/appearance.json` 是真相源,GET /butler/appearance 回环与已配对手机都能读,
 * PUT 只认回环;/state.appearance_version 变了前端就重新拉。落盘用临时目录,不碰 ~/.dsh。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { createAppearanceService, validateAppearanceInput } from '../src/server/appearance.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const PRESET = { kind: 'butler-swarm-v4', version: 1, settings: { count: 1800, particleSize: 1.2 }, svg: '', fill: false }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-appearance-'))
  dirs.push(dir)
  return dir
}

describe('validateAppearanceInput', () => {
  it('合法输入:24 项调参是有限数、svg 字符串、fill 布尔、icon 可选', () => {
    const result = validateAppearanceInput({ preset: PRESET, icon: 'mood-smile' })
    expect(result).toEqual({ ok: true, preset: PRESET, icon: 'mood-smile' })
  })
  it('settings 里非数值、NaN、超长 svg、坏 icon 都 400 带人话', () => {
    expect(validateAppearanceInput({ preset: { ...PRESET, settings: { count: 'x' } } })).toMatchObject({ ok: false, error: expect.stringContaining('count') })
    expect(validateAppearanceInput({ preset: { ...PRESET, settings: { count: Number.NaN } } })).toMatchObject({ ok: false })
    expect(validateAppearanceInput({ preset: { ...PRESET, svg: 'x'.repeat(262145) } })).toMatchObject({ ok: false, error: expect.stringContaining('SVG') })
    expect(validateAppearanceInput({ preset: PRESET, icon: '../x' })).toMatchObject({ ok: false, error: expect.stringContaining('icon') })
    expect(validateAppearanceInput({ preset: { kind: 'other', version: 1, settings: {} } })).toMatchObject({ ok: false })
    expect(validateAppearanceInput({})).toMatchObject({ ok: false, error: expect.stringContaining('preset') })
  })
})

describe('createAppearanceService', () => {
  it('没文件 → get 缺省、version 缺省;put 落盘、版本从 1 递增、重启读回', async () => {
    const dir = tempDir()
    const file = join(dir, 'appearance.json')
    const now = new Date('2026-09-16T08:00:00Z')
    const service = createAppearanceService({ file, now: () => now })
    await service.load()
    expect(service.get()).toBeUndefined()
    expect(service.version()).toBeUndefined()

    const first = await service.put({ preset: PRESET })
    expect(first).toMatchObject({ ok: true, doc: { version: 1, updated_at: '2026-09-16T08:00:00.000Z', preset: PRESET } })
    const second = await service.put({ preset: { ...PRESET, settings: { count: 3600 } }, icon: 'phone' })
    expect(second).toMatchObject({ ok: true, doc: { version: 2, icon: 'phone' } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 2, preset: { settings: { count: 3600 } }, icon: 'phone' })

    const again = createAppearanceService({ file })
    await again.load()
    expect(again.version()).toBe(2)
    expect(again.get()?.preset.settings).toEqual({ count: 3600 })
  })
  it('坏文件当没有:不抛、不盖', async () => {
    const dir = tempDir()
    const file = join(dir, 'appearance.json')
    writeFileSync(file, '{not json')
    const service = createAppearanceService({ file })
    await service.load()
    expect(service.get()).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('{not json')
    expect(await service.put({ preset: { kind: 'x' } })).toMatchObject({ ok: false })
  })
})

describe('/butler/appearance', () => {
  async function serve(options: { withAppearance?: boolean, withPairing?: boolean } = {}) {
    const dir = tempDir()
    let remote = '127.0.0.1'
    const appearance = createAppearanceService({ file: join(dir, 'appearance.json') })
    await appearance.load()
    const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => Date.now() })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      remoteAddress: () => remote,
      isRemoteAllowed: () => true,
      ...(options.withAppearance === false ? {} : { appearance }),
      ...(options.withPairing === false ? {} : { pairing }),
    })
    started.push(server)
    return { url: server.url, setRemote: (address: string) => { remote = address }, pairing }
  }
  const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> })

  it('没接服务:GET 404「外观同步未接线」;/state 没有 appearance_version', async () => {
    const { url } = await serve({ withAppearance: false, withPairing: false })
    expect(await json(await fetch(`${url}/butler/appearance`))).toMatchObject({ status: 404, body: { error: '外观同步未接线' } })
    const state = (await json(await fetch(`${url}/state`))).body as unknown as WorkbenchState
    expect(state.appearance_version).toBeUndefined()
  })

  it('回环:没存过 404;PUT 落盘回版本;GET 读回;/state.appearance_version 跟着变;坏 body 400', async () => {
    const { url } = await serve({ withPairing: false })
    expect(await json(await fetch(`${url}/butler/appearance`))).toMatchObject({ status: 404, body: { error: '还没有保存过外观' } })
    const put = await fetch(`${url}/butler/appearance`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: PRESET }) })
    expect(await json(put)).toMatchObject({ status: 200, body: { ok: true, version: 1 } })
    expect(await json(await fetch(`${url}/butler/appearance`))).toMatchObject({ status: 200, body: { version: 1, preset: PRESET } })
    const state = (await json(await fetch(`${url}/state`))).body as unknown as WorkbenchState
    expect(state.appearance_version).toBe(1)
    const bad = await fetch(`${url}/butler/appearance`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{oops' })
    expect((await json(bad)).status).toBe(400)
    const invalid = await fetch(`${url}/butler/appearance`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: { ...PRESET, settings: { count: 'many' } } }) })
    expect(await json(invalid)).toMatchObject({ status: 400, body: { error: expect.stringContaining('count') } })
  })

  it('已配对手机能 GET,不能 PUT(403「只能在 Mac 上改外观」);没令牌 401', async () => {
    const { url, setRemote, pairing } = await serve()
    await fetch(`${url}/butler/appearance`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: PRESET }) })
    const code = (await pairing.start()).code
    setRemote('10.86.37.5')
    const claimed = await fetch(`${url}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device_name: '测试机', platform: 'android' }) })
    const { token } = (await claimed.json()) as { token: string }
    const auth = { authorization: `Bearer ${token}` }
    expect(await json(await fetch(`${url}/butler/appearance`, { headers: auth }))).toMatchObject({ status: 200, body: { version: 1 } })
    const put = await fetch(`${url}/butler/appearance`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ preset: PRESET }) })
    expect(await json(put)).toMatchObject({ status: 403, body: { error: '只能在 Mac 上改外观' } })
    expect((await fetch(`${url}/butler/appearance`)).status).toBe(401)
  })

  it('预检放行 PUT(Mac 页面是跨端口的 fetch)', async () => {
    const { url } = await serve({ withPairing: false })
    const res = await fetch(`${url}/butler/appearance`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3080', 'access-control-request-method': 'PUT' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT')
  })
})
