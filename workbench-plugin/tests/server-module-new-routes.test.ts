// @vitest-environment node
/**
 * 2026-10-01 给小组件新放行的那两条(卡「小组件派出去与改造内置」第 3 件):
 *
 *   POST /xhs/refresh            她自己那一版「数据复盘」上的「刷新」。受它原有那道 10 分钟的闸。
 *   POST /files/asset-reveal     她自己那一版「素材管理」里点开一个素材文件夹。**只收文件夹名**。
 *
 * 这一份钉的是**门**:模块身份打这两条通,打任意路径的 `/files/reveal` 照旧 403;
 * 名字不在 `/state.template.asset_dirs` 里就 404,服务端一条 `open -R` 都不跑。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createModuleTokens } from '../src/server/moduleOrigin.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 素材那几个固定子文件夹(模板建出来的那一份,键是名字、值是绝对路径)。 */
const ASSET_DIRS = { 脚本: '/w/素材/脚本', 选题: '/w/选题' } as const

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-module-new-routes-'))
  dirs.push(dir)
  const modulesDir = join(dir, 'modules')
  mkdirSync(join(modulesDir, 'pomodoro'), { recursive: true })
  const tokens = createModuleTokens()
  /** 取了几次数(那颗「刷新」真打到服务上了没有)。 */
  const collects: string[] = []
  /** 真去 Finder 定位过哪几条路径。**一条都不该是模块给的字面量**。 */
  const revealed: string[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    modules: createCustomModulesService({ dir: modulesDir }),
    moduleOrigin: { port: 0, tokens },
    xhs: {
      view: () => ({ login: { connected: true }, accounts: [], ranges: [], fetches: [] }),
      collect: async (how: string) => { collects.push(how); return { ok: true } },
    } as never,
    reveal: { reveal: async (path: string) => { revealed.push(path); return { ok: true } } } as never,
    // `currentId`:composeState 要问「现在是哪个模板」(今天的待办那一格只在运营模板里出);这份假的照真服务回「没选过」。
    template: { view: () => ({ asset_dirs: { ...ASSET_DIRS } }), currentId: () => undefined } as never,
  })
  started.push(server)
  return { url: server.url, tokens, collects, revealed }
}

/** 一条"从模块页面里发出来的"请求:origin 是 null(sandbox 之后就是它),带模块令牌。 */
function asModule(token: string): Record<string, string> {
  return { origin: 'null', authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function post(url: string, path: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /xhs/refresh(第八条)', () => {
  it('★模块身份打得通:真去取了一次数', async () => {
    const { url, tokens, collects } = await serve()
    const res = await post(url, '/xhs/refresh', asModule(tokens.issue('pomodoro')), {})
    expect(res.status).toBe(200)
    // 走的就是内置那颗「刷新」同一条路(`collect('manual')`,闸在它自己身上)。
    expect(collects).toEqual(['manual'])
  })

  it('同一块里别的几条照旧打不通(登录、翻页):403,一次都没打到服务上', async () => {
    const { url, tokens, collects } = await serve()
    const headers = asModule(tokens.issue('pomodoro'))
    for (const path of ['/xhs/login', '/xhs/peek']) {
      const res = await post(url, path, headers, {})
      expect(res.status, path).toBe(403)
      expect(String(res.body.error), path).toContain('自定义模块用不了这条接口')
    }
    expect(collects).toEqual([])
  })
})

describe('POST /files/asset-reveal(第九条)', () => {
  it('★只收文件夹名,路径由服务端自己查', async () => {
    const { url, tokens, revealed } = await serve()
    const res = await post(url, '/files/asset-reveal', asModule(tokens.issue('pomodoro')), { name: '脚本' })
    expect(res.status).toBe(200)
    expect(revealed).toEqual([ASSET_DIRS.脚本])
  })

  it('名字不在那一份里:404,一条命令都不跑(**不拿它当路径使**)', async () => {
    const { url, tokens, revealed } = await serve()
    const headers = asModule(tokens.issue('pomodoro'))
    for (const name of ['不存在的', '/etc/passwd', '../../..']) {
      const res = await post(url, '/files/asset-reveal', headers, { name })
      expect(res.status, name).toBe(404)
    }
    expect(await post(url, '/files/asset-reveal', headers, {}).then(one => one.status)).toBe(400)
    expect(revealed).toEqual([])
  })

  it('★任意路径的 /files/reveal 照旧 403(2026-09-22 拿掉的那一条没回来)', async () => {
    const { url, tokens, revealed } = await serve()
    const res = await post(url, '/files/reveal', asModule(tokens.issue('pomodoro')), { path: '/w/素材/脚本' })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toContain('自定义模块用不了这条接口')
    expect(revealed).toEqual([])
  })

  it('页面自己那一侧(回环)也能用它:同一条路,名字照样服务端解析', async () => {
    const { url, revealed } = await serve()
    const res = await post(url, '/files/asset-reveal', { 'content-type': 'application/json' }, { name: '选题' })
    expect(res.status).toBe(200)
    expect(revealed).toEqual([ASSET_DIRS.选题])
  })
})
