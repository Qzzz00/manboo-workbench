// @vitest-environment node
/**
 * 热更新经 8791 的那几条路(2026-09-18)。
 *
 *   GET  /update/check / POST /update/apply / GET /update/job/:id
 *   `/setup/install/:job` 也认更新作业的 id(界面用的是同一套轮询)
 *   以及 /state 里那两格 update / update_available_apk
 *
 * 整台服务跑在真 socket 上,清单由**本地起的一个 http 假服务器**发 —— 一次都不去
 * api.aibooo.cn。要下载的产物指向同一个假服务器,于是"产物必须与清单同源"那道校验
 * 在用例里也是真的在起作用(改成别的 host 就该被挡掉,下面有一条钉着)。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fakePnpmExec, seedInstalledPnpm } from './setup/pnpmFake.ts'
import type { IncomingMessage } from 'node:http'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { createSetupService } from '../src/server/setup/service.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { UpdateCheckView, UpdateJobView } from '../src/server/update/types.ts'
import type { SetupApkView } from '../src/server/setup/types.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { lanOn } from './helpers/lanOn.ts'

/** 仓库根(读壳那个 Swift 文件用:两头写的那条路径必须逐字相同)。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '').replace(/\/workbench-plugin$/, '')

const NOW_SEC = Math.floor(Date.parse('2026-09-18T10:00:00Z') / 1000)
const PHONE_ADDRESS = '172.20.10.5'
const SHA_OK = '1'.repeat(64)

const started: WorkbenchServer[] = []
const fakes: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (fakes.length) await new Promise<void>((resolve) => { fakes.pop()?.close(() => resolve()) })
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 起一个只发一份清单的本地 http 服务器。`body` 是一个函数,用例可以中途换答案。 */
async function fakeServer(body: () => { status: number, text: string }): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url !== '/updates/latest.json') { res.writeHead(404); res.end('no'); return }
    const answer = body()
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(answer.text)
  })
  fakes.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

interface Harness {
  server: WorkbenchServer
  home: string
  origin: string
  calls: string[][]
  who: (value: 'local' | 'phone') => void
  token: string
  checkOnce: () => Promise<UpdateCheckView>
}

async function serve(options: { manifest?: (origin: string) => unknown, status?: number, currentVersion?: string } = {}): Promise<Harness> {
  const home = temp('wb-update-http-home-')
  const calls: string[][] = []
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd) => {
      calls.push([...cmd])
      // 自带 pnpm 那一段(卡 PN)照"装上了"回答 —— 尤其是 `<dsh>/node/bin/pnpm --version`,
      // 不然上面那条"什么都回空"会把它判成版本不对、又去装一遍。
      const pnpm = fakePnpmExec(paths, cmd)
      if (pnpm !== undefined) return pnpm
      // shasum 一律回"对得上",于是下载那一段直接命中"已经下好过"的幂等分支,
      // 不会真发 curl —— 这一组用例验的是**路由与权限**,下载本身在 update-apply 那组里验。
      if (cmd[0] === 'shasum') return { ok: true, code: 0, out: `${SHA_OK}  ${cmd[2]}` }
      return { ok: true, code: 0, out: '' }
    },
    // `~/.dsh/packages/plugin.tgz` **当作不存在**:有它的话「只下变了的」那道兜底会算出
    // 同一个 SHA_OK,于是这一组每条用例都变成"什么都不用下",路由就验不到了。
    // 增量判断本身在 update-incremental 那一组里验(那里用的是真文件、真 shasum)。
    stat: async path => (path.endsWith('/packages/plugin.tgz')
      ? undefined
      : { isFile: true, isDirectory: false, size: 100, mtimeMs: 0, executable: false }),
    readFile: async () => '# 假的\n',
    // 下下来的原件在这一组里是"假装有"的(stat 上面直接回了个文件),所以真复制会 ENOENT。
    // 这一组验的是路由与权限;复制、解包、校验那几件在 update-apply 那一组里各自有用例。
    copyFile: async () => {},
    uid: () => 501,
  }
  let origin = ''
  const defaultManifest = (base: string): unknown => ({
    version: '9.9.9',
    notes: '这一版修了那个谁都在问的毛病',
    assets: {
      plugin_tgz: { url: `${base}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
      apk: { url: `${base}/updates/9.9.9/app.apk`, sha256: SHA_OK, size: 32_000_000 },
    },
  })
  origin = await fakeServer(() => ({
    status: options.status ?? 200,
    text: JSON.stringify((options.manifest ?? defaultManifest)(origin)),
  }))

  // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
  seedInstalledPnpm(paths)
  const update = createUpdateService({
    io,
    paths,
    now: () => Date.now(),
    newId: (() => { let n = 0; return () => `up-${++n}` })(),
    currentVersion: options.currentVersion ?? '0.2.41',
    manifestUrl: `${origin}/updates/latest.json`,
    // 每拍都可以重查:用例要能立刻看到 /state 里那一格。
    checkIntervalMs: 0,
    applyTuning: { subPollMs: 0, restartDelayMs: 0 },
  })

  // 登录台也接上:生产里这两块是一起启用的(都跟着 setupEnv 走),而
  // 「`/setup/install/:job` 也认更新作业的 id」这条只在两块都在时才谈得上。
  const setup = createSetupService({
    io,
    paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
    pluginVersion: '0.2.41',
    scanRoots: async () => [],
    now: () => Date.now(),
    newId: (() => { let n = 0; return () => `setup-${++n}` })(),
    recheckMs: 0,
    // 生产里这两条接线一模一样(见 http.ts):二维码优先云上,局域网只兜底。
    apkUrl: () => 'http://172.20.10.1:8791/setup/apk',
    cloudApk: async () => await update.ensureCloudApk(),
  })

  const pairing = createPairingService({ file: join(home, 'devices.json'), now: () => NOW_SEC })
  let from: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    usageIntervalMs: 0,
    update,
    setup,
    pairing,
    remoteAddress: (_req: IncomingMessage) => (from === 'local' ? '127.0.0.1' : PHONE_ADDRESS),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
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
    origin,
    calls,
    who: (value) => { from = value },
    token: claimed.token,
    checkOnce: () => update.check(),
  }
}

async function call(h: Harness, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${h.server.url}${path}`, init)
}

describe('热更新 · HTTP', () => {
  it('GET /update/check 回「当前 / 最新 / 有没有 / 说了什么 / 要下多大」', async () => {
    const h = await serve()
    const body = await (await call(h, '/update/check')).json() as UpdateCheckView
    expect(body.current).toBe('0.2.41')
    expect(body.latest).toBe('9.9.9')
    expect(body.available).toBe(true)
    expect(body.notes).toContain('毛病')
    // apk 不进「要下多大」—— 那 32MB 是手机自己去下的。
    expect(body.size).toBe(1100)
    expect(body.apk?.size).toBe(32_000_000)
  })

  it('已经是最新的:available 是 false,不是报错', async () => {
    const h = await serve({ currentVersion: '9.9.9' })
    const body = await (await call(h, '/update/check')).json() as UpdateCheckView
    expect(body.available).toBe(false)
    expect(body.error).toBeUndefined()
  })

  it('服务器那边有事(500):回一句人话,available 一定是 false,不抛', async () => {
    const h = await serve({ status: 500 })
    const res = await call(h, '/update/check')
    expect(res.status).toBe(200)
    const body = await res.json() as UpdateCheckView
    expect(body.available).toBe(false)
    expect(body.error).toContain('HTTP 500')
    expect(body.error).toContain('不是你这台电脑的毛病')
  })

  it('清单里的产物指到别的服务器:整份清单不认,话里说清楚', async () => {
    const h = await serve({
      manifest: () => ({
        version: '9.9.9',
        assets: { plugin_tgz: { url: 'https://somewhere-else.example/a.tgz', sha256: SHA_OK, size: 1 } },
      }),
    })
    const body = await (await call(h, '/update/check')).json() as UpdateCheckView
    expect(body.available).toBe(false)
    expect(body.error).toContain('别的服务器')
  })

  it('min_installer_version 比本机新:不给「立即更新」,只说去重新装一次', async () => {
    const h = await serve({
      manifest: origin => ({
        version: '9.9.9',
        min_installer_version: '9.0.0',
        assets: { plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1 } },
      }),
    })
    const body = await (await call(h, '/update/check')).json() as UpdateCheckView
    expect(body.available).toBe(false)
    expect(body.needs_installer).toContain('重新下一次安装包')

    const applied = await call(h, '/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(applied.status).toBe(409)
  })

  it('没查过就点「立即更新」:409 + 一句「先点一次检查更新」', async () => {
    const h = await serve()
    const res = await call(h, '/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toContain('检查更新')
  })

  it('POST /update/apply 回一条作业;/update/job/:id 与 /setup/install/:job 都查得到同一条', async () => {
    const h = await serve()
    await h.checkOnce()
    const job = await (await call(h, '/update/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as UpdateJobView
    expect(job.step).toBe('update')
    expect(job.version).toBe('9.9.9')

    // 轮到收尾(生产里界面也是这么干的)。
    let seen = job
    for (let i = 0; i < 80 && seen.state === 'running'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      seen = await (await call(h, `/update/job/${job.id}`)).json() as UpdateJobView
    }
    expect(seen.state).toBe('done')
    expect(seen.restarting).toBe(true)
    expect(seen.progress).toBe(100)

    // **同一个 id 走登录台那条路也查得到** —— 界面那套轮询与进度框因此一份代码两处用。
    const viaSetup = await (await call(h, `/setup/install/${job.id}`)).json() as UpdateJobView
    expect(viaSetup.id).toBe(job.id)
    expect(viaSetup.step).toBe('update')
  })

  it('这几条路一律只认回环:手机拿着有效令牌也碰不到', async () => {
    const h = await serve()
    h.who('phone')
    const head = { authorization: `Bearer ${h.token}` }
    expect((await call(h, '/update/check', { headers: head })).status).toBe(403)
    expect((await call(h, '/update/apply', { method: 'POST', headers: { ...head, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect((await call(h, '/update/job/up-1', { headers: head })).status).toBe(403)
  })

  it('没接热更新时 /update/* 一律 404(既有那一大批用例不会因此多一条对外请求)', async () => {
    const home = temp('wb-update-off-home-')
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      usageIntervalMs: 0,
      credentialFile: join(home, 'credentials.json'),
    })
    started.push(server)
    expect((await fetch(`${server.url}/update/check`)).status).toBe(404)
    const state = await (await fetch(`${server.url}/state`)).json() as WorkbenchState
    expect(state.update).toBeUndefined()
    expect(state.update_available_apk).toBeUndefined()
  })

  it('/state 里那两格:查过之后才有,手机端能读到新手机包的地址', async () => {
    const h = await serve()
    // 还没查过:整格缺席(不编一个 false)。
    const before = await (await call(h, '/state')).json() as WorkbenchState
    expect(before.update).toBeUndefined()

    await h.checkOnce()
    const after = await (await call(h, '/state')).json() as WorkbenchState
    expect(after.update?.available).toBe(true)
    expect(after.update?.latest).toBe('9.9.9')
    expect(after.update_available_apk?.version).toBe('9.9.9')
    expect(after.update_available_apk?.url).toContain('/updates/9.9.9/app.apk')
  })

  /**
   * 二维码走公网(2026-09-18「包一律放阿里云服务器」)。Ben 真机反馈:
   * 「扫码下载是失效的,IP 是局域网。」于是 `/setup/apk.json` 的 url 改成优先取清单里那份。
   */
  describe('二维码优先给云上那份', () => {
    it('清单里有手机包:回公网地址 + source=cloud + sha256,而且是**自己现取的一次清单**(没先点过检查更新)', async () => {
      const h = await serve()
      const body = await (await call(h, '/setup/apk.json')).json() as SetupApkView
      expect(body.available).toBe(true)
      expect(body.source).toBe('cloud')
      expect(body.url).toBe(`${h.origin}/updates/9.9.9/app.apk`)
      expect(body.sha256).toBe(SHA_OK)
      expect(body.version).toBe('9.9.9')
      expect(body.size).toBe(32_000_000)
    })

    it('本机已经是最新:二维码照样给云上那份 —— 它问的是「包在哪」,不是「有没有新版」', async () => {
      const h = await serve({ currentVersion: '9.9.9' })
      const body = await (await call(h, '/setup/apk.json')).json() as SetupApkView
      expect(body.source).toBe('cloud')
      expect(body.url).toContain('/updates/9.9.9/app.apk')
      // 这一版不算"有新版",所以手机那一格是空的 —— 两格各说各的。
      const state = await (await call(h, '/state')).json() as WorkbenchState
      expect(state.update_available_apk).toBeUndefined()
      expect(state.phone_apk?.url).toContain('/updates/9.9.9/app.apk')
    })

    it('清单取不到(服务器 500):安静退回局域网地址 + source=lan,不是报错也不是空二维码', async () => {
      const h = await serve({ status: 500 })
      const body = await (await call(h, '/setup/apk.json')).json() as SetupApkView
      expect(body.available).toBe(true)
      expect(body.source).toBe('lan')
      expect(body.url).toBe('http://172.20.10.1:8791/setup/apk')
      expect(body.sha256).toBeUndefined()
    })

    it('清单里这一版没带手机包:同样退回局域网地址', async () => {
      const h = await serve({
        manifest: origin => ({
          version: '9.9.9',
          assets: { plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 } },
        }),
      })
      const body = await (await call(h, '/setup/apk.json')).json() as SetupApkView
      expect(body.source).toBe('lan')
      expect(body.url).toBe('http://172.20.10.1:8791/setup/apk')
    })

    /**
     * 发版时没重打的那几样照上一版清单原样带上(2026-09-26,卡 U8;deploy/publish-update.sh)。
     * 清单里那一格于是带着 `from_version`。这边两条:**说的是它真出自哪一版**,
     * 而且**不报「手机包有新的了」**(一个字节没变,报了就是骗他去重下一份一样的)。
     */
    it('手机包是照上一版原样带上的(from_version):phone_apk 说的是那一版,「有新的手机包」不出现', async () => {
      const h = await serve({
        manifest: origin => ({
          version: '9.9.9',
          assets: {
            plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
            // 9.9.8 打的那一份,原样带到 9.9.9 的清单里:url 还指着 9.9.8 的目录。
            apk: { url: `${origin}/updates/9.9.8/app.apk`, sha256: SHA_OK, size: 32_000_000, from_version: '9.9.8' },
          },
        }),
      })
      await h.checkOnce()
      const state = await (await call(h, '/state')).json() as WorkbenchState
      // 「那个包在哪」:一直在,而且说真话 —— 它是 9.9.8 打的。
      expect(state.phone_apk?.version).toBe('9.9.8')
      expect(state.phone_apk?.url).toBe(`${h.origin}/updates/9.9.8/app.apk`)
      // 「有没有新的手机包」:这一版没换包,那一格就不出现(电脑本体照旧有新版)。
      expect(state.update?.available).toBe(true)
      expect(state.update_available_apk).toBeUndefined()
      const body = await (await call(h, '/update/check')).json() as UpdateCheckView
      expect(body.apk).toBeUndefined()
      // 二维码照旧给云上那份(它问的是「包在哪」)。
      const qr = await (await call(h, '/setup/apk.json')).json() as SetupApkView
      expect(qr.source).toBe('cloud')
      expect(qr.version).toBe('9.9.8')
    })

    it('清单里这一格又漏了:phone_apk 保留上一次看到的那一份(卡 U8 的双保险),不变空', async () => {
      let withApk = true
      const h = await serve({
        manifest: origin => ({
          version: withApk ? '9.9.9' : '9.9.10',
          assets: {
            plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
            ...(withApk ? { apk: { url: `${origin}/updates/9.9.9/app.apk`, sha256: SHA_OK, size: 32_000_000 } } : {}),
          },
        }),
      })
      await h.checkOnce()
      const before = await (await call(h, '/state')).json() as WorkbenchState
      expect(before.phone_apk?.url).toBe(`${h.origin}/updates/9.9.9/app.apk`)
      // 下一版的清单漏了 apk 那一格(0.4.1 那次就是这样):上一次看到的那一份顶上,
      // 手机上「重新下载手机包」照样点得动(旧版本的目录从不删)。
      withApk = false
      await h.checkOnce()
      const after = await (await call(h, '/state')).json() as WorkbenchState
      expect(after.update?.latest).toBe('9.9.10')
      expect(after.phone_apk?.version).toBe('9.9.9')
      expect(after.phone_apk?.url).toBe(`${h.origin}/updates/9.9.9/app.apk`)
      expect(after.phone_apk?.size).toBe(32_000_000)
      // 记着的那一份不算「有新的手机包」(它本来就不比版本)。
      expect(after.update_available_apk).toBeUndefined()
    })

    it('/state.phone_apk 手机也读得到(设置里「重新下载手机包」用它),而且**不联网**', async () => {
      const h = await serve()
      // 还没查过清单:整格缺席(/state 自己绝不去取清单 —— 每拍一次那可受不了)。
      const before = await (await call(h, '/state')).json() as WorkbenchState
      expect(before.phone_apk).toBeUndefined()

      await h.checkOnce()
      h.who('phone')
      const state = await (await call(h, '/state', { headers: { authorization: `Bearer ${h.token}` } })).json() as WorkbenchState
      expect(state.phone_apk?.version).toBe('9.9.9')
      expect(state.phone_apk?.url).toBe(`${h.origin}/updates/9.9.9/app.apk`)
      expect(state.phone_apk?.size).toBe(32_000_000)
    })
  })

  /**
   * 电脑安装包那一格(2026-09-26,卡 SM):`/state.update.installer`。
   * 与「这台有没有新版」是两回事 —— 它答的是「那个包在哪」,给**另一台**机器装用。
   */
  describe('/state.update.installer:给别的机器装用的那份安装包', () => {
    const DMG = (origin: string, version: string): string => `${origin}/updates/${version}/工作台安装器.dmg`

    it('★清单里有 installer_dmg → 那一格有地址、大小、sha;这台已经是最新的时候照样有', async () => {
      const h = await serve({
        currentVersion: '9.9.9',
        manifest: origin => ({
          version: '9.9.9',
          assets: {
            plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
            installer_dmg: { url: DMG(origin, '9.9.9'), sha256: SHA_OK, size: 102_454_199 },
          },
        }),
      })
      await h.checkOnce()
      const state = await (await call(h, '/state')).json() as WorkbenchState
      // 这台机器已经是最新的(没有新版可升)—— 安装包那一格照样在。
      expect(state.update?.available).toBe(false)
      expect(state.update?.installer).toEqual({
        version: '9.9.9', url: DMG(h.origin, '9.9.9'), size: 102_454_199, sha256: SHA_OK,
      })
      // 这台机器**不下载它**:这次更新的账里没有它(别的几样才有)。
      const body = await (await call(h, '/update/check')).json() as UpdateCheckView
      expect(body.plan?.items.map(one => one.kind)).not.toContain('installer_dmg')
    })

    it('安装包是照上一版原样带上的(from_version):那一格说的是它真出自哪一版', async () => {
      const h = await serve({
        manifest: origin => ({
          version: '9.9.9',
          assets: {
            plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
            installer_dmg: { url: DMG(origin, '9.9.8'), sha256: SHA_OK, size: 102_454_199, from_version: '9.9.8' },
          },
        }),
      })
      await h.checkOnce()
      const state = await (await call(h, '/state')).json() as WorkbenchState
      expect(state.update?.installer?.version).toBe('9.9.8')
      expect(state.update?.installer?.url).toBe(DMG(h.origin, '9.9.8'))
    })

    it('清单里这一格又漏了:保留上一次看到的那一份(同手机包那道双保险),不变空', async () => {
      let withDmg = true
      const h = await serve({
        manifest: origin => ({
          version: withDmg ? '9.9.9' : '9.9.10',
          assets: {
            plugin_tgz: { url: `${origin}/updates/9.9.9/plugin.tgz`, sha256: SHA_OK, size: 1100 },
            ...(withDmg ? { installer_dmg: { url: DMG(origin, '9.9.9'), sha256: SHA_OK, size: 102_454_199 } } : {}),
          },
        }),
      })
      await h.checkOnce()
      expect(((await (await call(h, '/state')).json()) as WorkbenchState).update?.installer?.version).toBe('9.9.9')
      withDmg = false
      await h.checkOnce()
      const after = await (await call(h, '/state')).json() as WorkbenchState
      expect(after.update?.latest).toBe('9.9.10')
      expect(after.update?.installer?.version).toBe('9.9.9')
      expect(after.update?.installer?.url).toBe(DMG(h.origin, '9.9.9'))
    })

    it('清单里根本没这一格(老服务器)→ 整格缺席,不编一个地址', async () => {
      const h = await serve()
      await h.checkOnce()
      const state = await (await call(h, '/state')).json() as WorkbenchState
      expect(state.update?.latest).toBe('9.9.9')
      expect(state.update?.installer).toBeUndefined()
    })
  })

  it('/state 里那两格手机也读得到(它要靠这一格显示「电脑有新版手机包」)', async () => {
    const h = await serve()
    await h.checkOnce()
    h.who('phone')
    const state = await (await call(h, '/state', { headers: { authorization: `Bearer ${h.token}` } })).json() as WorkbenchState
    expect(state.update_available_apk?.version).toBe('9.9.9')
  })
})

/**
 * 壳那条就绪探针 + 「装运行环境」那条路(2026-09-26,卡 U6)。
 *
 * `/ready` 是壳在**让页面开始加载之前**探的那一条(白屏那一幕的修法,见
 * workbench-app/Sources/ShellReadiness.swift);两头的路径名各有一条用例钉着。
 */
describe('就绪探针与「装运行环境」', () => {
  it('★GET /ready 回 ok + 版本号,而且什么都不做(不算一次「工作台露面了」)', async () => {
    const h = await serve()
    const res = await call(h, '/ready')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean, version: string }
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
    // 它不碰 composeState,所以整条路上不该发出任何命令(那是"什么都不做"的可观察形式)。
    expect(h.calls).toEqual([])
  })

  it('★壳里写的探针路径与服务端这一条逐字相同(哪一头打错字都在这里红)', () => {
    // 两头各写一段字符串,中间打错一个字 → 壳永远探不到、永远盖着盖板等,而单元测试全绿。
    // 所以这一条真去读 Swift 那个文件(同 install-shape-runtime 读 publish-update.sh 的做法)。
    const swift = readFileSync(join(REPO_ROOT, 'workbench-app', 'Sources', 'ShellReadiness.swift'), 'utf8')
    expect(swift).toContain('static let probePath = "/ready"')
  })

  it('没接那块服务时 POST /update/runtime 回 404(整块不启用,同 setup / update 的规矩)', async () => {
    const h = await serve()
    const res = await call(h, '/update/runtime', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(404)
  })
})
