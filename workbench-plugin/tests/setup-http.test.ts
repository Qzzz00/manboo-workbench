// @vitest-environment node
/**
 * 登录台经 8791 的那几条路(2026-09-17 卡 A)。
 *
 *   GET  /setup/status / POST /setup/install / GET /setup/install/:job
 *   POST /setup/open / GET /setup/apk.json / GET /setup/apk
 *   以及 /state 里那一格 setup_required。
 *
 * 整台服务跑在真 socket 上,但**登录台看的那台「机器」是 mktemp 出来的临时 HOME**,
 * 命令执行是注入的假的 —— 一条 launchctl / npm / ditto 都不会真跑。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { lanOn } from './helpers/lanOn.ts'
import { createSetupService } from '../src/server/setup/service.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { SetupJobView, SetupStatus } from '../src/server/setup/types.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-17T10:00:00Z') / 1000)
/**
 * 扮演手机的地址。这些用例验的是**设备令牌那道门**,不是外层那道来源门。
 *
 * 2026-08-21 — 2026-10-01 之间,这个地址取在手机热点网段(172.20.10.0/28)上,
 * 靠 `isAllowedRemoteAddress` 的热点例外过来源门。那条例外 2026-10-01 被维护者撤掉了,
 * 现在改成照真机的样子:harness 把「允许手机在局域网访问」开着(见 lanOn)。
 */
const PHONE_ADDRESS = '172.20.10.5'
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Harness {
  server: WorkbenchServer
  home: string
  repo: string
  who: (value: 'local' | 'phone') => void
  token: string
  calls: string[][]
  recheckOnce: () => Promise<void>
}

async function serve(options: {
  execOk?: boolean
  /** 云上那份手机包(更新清单里的 assets.apk)。不给就当"没网 / 这一版没带手机包"。 */
  cloudApk?: () => Promise<{ version: string, url: string, size: number, sha256: string } | undefined>
} = {}): Promise<Harness> {
  const home = temp('wb-setup-http-home-')
  const repo = temp('wb-setup-http-repo-')
  const calls: string[][] = []
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd) => {
      calls.push([...cmd])
      return { ok: options.execOk ?? true, code: options.execOk === false ? 1 : 0, out: '' }
    },
    uid: () => 501,
    currentNodeBinary: () => join(home, '不存在的-node'),
  }
  const setup = createSetupService({
    io,
    paths: setupPaths({ home, repoRoot: repo, applicationsDir: join(home, 'Applications') }),
    pluginVersion: '9.9.9',
    scanRoots: async () => [],
    repoRoot: repo,
    now: () => Date.now(),
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
    apkUrl: () => 'http://172.20.10.1:8791/setup/apk',
    apkPath: join(repo, 'butler.apk'),
    ...(options.cloudApk === undefined ? {} : { cloudApk: options.cloudApk }),
    // 每拍都可以重检:用例要能立刻看到 setup_required 变化。
    recheckMs: 0,
  })

  const pairing = createPairingService({ file: join(home, 'devices.json'), now: () => NOW_SEC })
  let from: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    usageIntervalMs: 0,
    setup,
    pairing,
    remoteAddress: (_req: IncomingMessage) => (from === 'local' ? '127.0.0.1' : PHONE_ADDRESS),
    lan: lanOn(),
    credentialFile: join(home, 'credentials.json'),
  })
  started.push(server)
  pairing.start()
  const code = pairing.current()?.code ?? ''
  const claimed = await pairing.claim({ code, device_name: '手机', platform: 'android' })
  if (!claimed.ok) throw new Error('配对桩没配上')

  return {
    server,
    home,
    repo,
    calls,
    who: (value) => { from = value },
    token: claimed.token,
    // pump 是 fire-and-forget,用例要看结论就自己跑一次完整体检。
    recheckOnce: async () => { await setup.status() },
  }
}

async function call(h: Harness, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${h.server.url}${path}`, init)
}

const JSON_HEAD = { 'content-type': 'application/json' }

describe('登录台 · HTTP', () => {
  it('GET /setup/status 回逐项体检', async () => {
    const h = await serve()
    const res = await call(h, '/setup/status')
    expect(res.status).toBe(200)
    const body = await res.json() as SetupStatus
    expect(body.items.length).toBeGreaterThan(10)
    expect(body.all_ok).toBe(false)
    expect(body.items.find(item => item.key === 'node')?.state).toBe('missing')
  })

  it('POST /setup/install 回一条作业,GET /setup/install/:id 看得到结局', async () => {
    const h = await serve()
    const first = await (await call(h, '/setup/install', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ step: 'restart' }),
    })).json() as SetupJobView
    expect(first.id).toBe('job-1')
    expect(first.step).toBe('restart')

    // 轮询到收尾(生产里界面也是这么干的)。
    let job = first
    for (let i = 0; i < 50 && job.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      job = await (await call(h, '/setup/install/job-1')).json() as SetupJobView
    }
    expect(job.state).toBe('done')
    expect(h.calls).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh'])
  })

  it('认不得的 step 回 400,认不得的作业号回 404', async () => {
    const h = await serve()
    const bad = await call(h, '/setup/install', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ step: '把机器格了' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('step')
    expect((await call(h, '/setup/install/没这条')).status).toBe(404)
  })

  it('POST /setup/open 打开系统设置那一页', async () => {
    const h = await serve()
    const res = await call(h, '/setup/open', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ pane: 'accessibility' }),
    })
    expect(res.status).toBe(200)
    expect(h.calls).toContainEqual(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'])
  })

  it('打不开就把话如实回给界面,不假装成功', async () => {
    const h = await serve({ execOk: false })
    const res = await call(h, '/setup/open', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ pane: 'files' }),
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('系统设置')
  })

  it('手机(带令牌)也碰不到这几条:只认回环', async () => {
    const h = await serve()
    h.who('phone')
    const auth = { authorization: `Bearer ${h.token}` }
    expect((await call(h, '/setup/status', { headers: auth })).status).toBe(403)
    expect((await call(h, '/setup/install', { method: 'POST', headers: { ...auth, ...JSON_HEAD }, body: '{"step":"restart"}' })).status).toBe(403)
    expect((await call(h, '/setup/open', { method: 'POST', headers: { ...auth, ...JSON_HEAD }, body: '{"pane":"files"}' })).status).toBe(403)
    expect((await call(h, '/setup/apk.json', { headers: auth })).status).toBe(403)
  })
})

describe('登录台 · 手机端的包', () => {
  it('没出过包:apk.json 说没有并给出包的办法,下载回 404', async () => {
    const h = await serve()
    const info = await (await call(h, '/setup/apk.json')).json() as { available: boolean, hint?: string }
    expect(info.available).toBe(false)
    expect(info.hint).toContain('android:debug')
    expect((await call(h, '/setup/apk')).status).toBe(404)
  })

  /**
   * 二维码走公网(2026-09-18「包一律放阿里云服务器」)。Ben 真机反馈:
   * 「扫码下载是失效的,IP 是局域网。」局域网那条从此只是兜底。
   */
  it('云上有包:apk.json 给公网地址,**这台电脑上一个 apk 都没有也照样给**', async () => {
    const h = await serve({
      cloudApk: async () => ({ version: '0.2.42', url: 'https://api.aibooo.cn/updates/0.2.42/app.apk', sha256: 'a'.repeat(64), size: 32_000_000 }),
    })
    // 故意不往 repo 里写那个 apk 文件:普通用户的机器上本来就没有。
    const info = await (await call(h, '/setup/apk.json')).json() as { available: boolean, url?: string, source?: string, sha256?: string, version?: string, size?: number }
    expect(info.available).toBe(true)
    expect(info.source).toBe('cloud')
    expect(info.url).toBe('https://api.aibooo.cn/updates/0.2.42/app.apk')
    expect(info.sha256).toBe('a'.repeat(64))
    expect(info.version).toBe('0.2.42')
    expect(info.size).toBe(32_000_000)
  })

  it('云上取不到(没网):退回局域网地址,source=lan —— 不是报错', async () => {
    const h = await serve({ cloudApk: async () => undefined })
    writeFileSync(join(h.repo, 'butler.apk'), 'PK假的安装包')
    const info = await (await call(h, '/setup/apk.json')).json() as { available: boolean, url?: string, source?: string }
    expect(info.available).toBe(true)
    expect(info.source).toBe('lan')
    expect(info.url).toBe('http://172.20.10.1:8791/setup/apk')
  })

  it('取云上那份时自己抛了:也只是退回局域网,绝不连累这条路', async () => {
    const h = await serve({ cloudApk: async () => { throw new Error('清单坏了') } })
    writeFileSync(join(h.repo, 'butler.apk'), 'PK假的安装包')
    const res = await call(h, '/setup/apk.json')
    expect(res.status).toBe(200)
    const info = await res.json() as { source?: string, url?: string }
    expect(info.source).toBe('lan')
    expect(info.url).toBe('http://172.20.10.1:8791/setup/apk')
  })

  it('出过包:apk.json 带大小与地址,下载真把字节发出来', async () => {
    const h = await serve()
    writeFileSync(join(h.repo, 'butler.apk'), 'PK假的安装包')
    const info = await (await call(h, '/setup/apk.json')).json() as { available: boolean, size: number, url?: string }
    expect(info.available).toBe(true)
    expect(info.size).toBeGreaterThan(0)
    expect(info.url).toBe('http://172.20.10.1:8791/setup/apk')

    const res = await call(h, '/setup/apk')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(await res.text()).toContain('假的安装包')
  })

  it('没配对过的手机也下得到包 —— 它此刻不可能有令牌(双端流程)', async () => {
    const h = await serve()
    writeFileSync(join(h.repo, 'butler.apk'), '安装包')
    h.who('phone')
    const res = await call(h, '/setup/apk')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('安装包')
    // 但别的都还是 401(它没带令牌)。
    expect((await call(h, '/state')).status).toBe(401)
  })
})

describe('登录台 · /state.setup_required', () => {
  it('还没体检过时这一格缺席(不是 false)', async () => {
    const h = await serve()
    const state = await (await call(h, '/state')).json() as Record<string, unknown>
    // 第一拍 /state 只是**触发**了一次后台体检,结论还没出来 —— 这时不该猜一个值。
    if ('setup_required' in state) expect(typeof state.setup_required).toBe('boolean')
    else expect(state.setup_required).toBeUndefined()
  })

  it('体检出来之后,没装好就是 true', async () => {
    const h = await serve()
    await h.recheckOnce()
    const state = await (await call(h, '/state')).json() as { setup_required?: boolean }
    expect(state.setup_required).toBe(true)
  })
})

describe('登录台 · /state.setup_alerts(2026-09-17 那两条横幅)', () => {
  it('还没体检过时整格缺席 —— 「没查过」不是「差着」', async () => {
    const h = await serve()
    const state = await (await call(h, '/state')).json() as Record<string, unknown>
    if ('setup_alerts' in state) expect(typeof state.setup_alerts).toBe('object')
    else expect(state.setup_alerts).toBeUndefined()
  })

  it('体检出来之后:缺授权、缺密钥各自一个布尔,读的是同一份结论(不额外跑体检)', async () => {
    const h = await serve()
    await h.recheckOnce()
    const state = await (await call(h, '/state')).json() as {
      setup_alerts?: { accessibility: boolean, deepseek_key: boolean }
    }
    // 这台临时 HOME 上什么都没有:缺授权亮着;用例跑的是开源缺省(构建不带中转,2026-10-21),
    // 没有 model.json = 只能用自己的 DeepSeek Key,密钥那一条也亮。接了中转时不亮(2026-09-23),
    // 那一档的判据在 setup-status 用例里钉着。
    expect(state.setup_alerts).toEqual({ accessibility: true, deepseek_key: true })
  })
})

describe('登录台 · 没启用时', () => {
  it('既没传 setup 也没传 setupEnv → /setup/* 一律 404,而且不会去跑任何体检命令', async () => {
    /**
     * 这条用例守的是一处**真会伤到这台机器**的默认值:体检会真跑 mdfind / osascript / launchctl、
     * 真读 $HOME/.dsh。直接 startWorkbenchServer(...) 的那一大批既有用例都没传 env —— 要是
     * http.ts 在那种情况下拿 process.env 兜底造一个真的登录台,跑一次测试就会在开发机上起一堆
     * 子进程(osascript 那条还可能弹一个系统日历授权框)。所以默认是**整块不启用**。
     */
    const home = temp('wb-setup-off-')
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      usageIntervalMs: 0,
      credentialFile: join(home, 'credentials.json'),
    })
    started.push(server)
    for (const path of ['/setup/status', '/setup/apk.json', '/setup/apk', '/setup/install/x']) {
      const res = await fetch(`${server.url}${path}`)
      expect(res.status, path).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe('登录台未启用')
    }
    const state = await (await fetch(`${server.url}/state`)).json() as Record<string, unknown>
    expect('setup_required' in state).toBe(false)
  })
})
