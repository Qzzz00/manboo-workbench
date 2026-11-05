/**
 * 连接器在工作台这一侧的接线(卡 OC2,2026-09-27)。
 *
 * 维护者 11:30 改了口径:「到底是装还是不装?我是让你装啊」——
 * **连接器默认装上**,每台机器都有。于是这一份要做的是:
 *
 * 1. **工作台服务起来之后,在后台自己装**。第一次要下 229MB,所以:
 *    - **不挡启动**:`ensure()` 立刻返回,活在一个游离的 promise 里;
 *    - **不挡别的功能**:整条链路只碰 `~/.dsh/open-connector` 与那三家的 MCP 配置;
 *    - **装不上不吭声地重试**:这一次失败就记一句人话,**下次启动再试**(不轮询、不自己重试 ——
 *      没网的时候每分钟重下一次 229MB 是害人),另有一颗手动「再试一次」。
 * 2. 装好之后**自动起**(launchctl)、**自动写**三家的 MCP 配置(靠 written.json 记账,她手改过的不覆盖)。
 * 3. 给设置页一行状态。**数字取不到就缺席,不编 0**(仓库通例)。
 *
 * ## 从零装机那条线不受影响
 *
 * 安装包里不带这 229MB(`build-installer.sh` 一行没动),装机时不下载;
 * 开机之后工作台起来了,才在后台去装。所以「双击装好就能用」那条路径一秒都没变长。
 *
 * ## 单飞
 *
 * 同一时刻只许一趟装。`ensure()` 重入时返回同一个 promise ——
 * 两趟 `npm install` 打同一个目录会互相拆台。
 */
import { readdir, stat } from 'node:fs/promises'
import { nodeSetupIo, type SetupIo } from '../setup/io.ts'
import {
  CONNECTOR_DEFAULT_PORT, CONNECTOR_DISK_BYTES, CONNECTOR_LAUNCHD_LABEL, CONNECTOR_VERSION,
  connectorPaths,
} from './manifest.ts'
import type { ConnectorPhase, ConnectorView } from '../../protocol.ts'
export { connectorRowText } from '../../connectorText.ts'
import { MCP_HOSTS, parseMcpWritten } from './mcpConfig.ts'
import { installConnector, parseConnectorConfig, uninstallConnector, type ConnectorMcpResult } from './install.ts'

/** 形状住在 `protocol.ts`(电脑与手机都读它),这里只管把它算出来。 */
export type { ConnectorPhase, ConnectorView } from '../../protocol.ts'

export interface ConnectorService {
  view(): Promise<ConnectorView>
  /** 开机后由 index.ts 叫一次;重入返回同一趟。**立刻返回,不等装完。** */
  ensure(): void
  /** 手动「再试一次」。等这一趟装完。 */
  install(): Promise<{ ok: boolean, error?: string }>
  start(): Promise<{ ok: boolean, error?: string }>
  stop(): Promise<{ ok: boolean, error?: string }>
  /** 「卸掉」。**连凭据一起删** —— 界面上要把这句话说明白。 */
  uninstall(): Promise<{ ok: boolean, error?: string }>
}

export interface ConnectorServiceDeps {
  home: string
  io?: SetupIo
  fetchImpl?: typeof fetch
  /** 状态缓存毫秒,缺省 3000;0 = 不缓存(测试用)。界面 1 秒轮一次 /state,不该每秒去数一遍目录。 */
  cacheMs?: number
  now?: () => number
  /** 生成本机令牌。缺省 `crypto.getRandomValues`。 */
  randomToken?: () => string
  /** 状态变了就重组一次 /state(照 butler / questions 那套)。 */
  onChanged?: () => void
  /** 探「连接器答上话了没有」探几次、每次隔多久。缺省 16 × 500ms = 最多等 8 秒。测试里调小。 */
  probeAttempts?: number
  probeGapMs?: number
}

function defaultToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** npm 那一步失败时,把原话归成一句她能行动的人话。**归不了就照原话的尾巴说,不编。** */
export function connectorFailureNote(out: string): string {
  const text = out.toLowerCase()
  if (/enotfound|eai_again|etimedout|econnreset|network|offline|getaddrinfo/.test(text)) {
    return '这会儿下载不了(网络不通),等有网了下次开机自己接着装。'
  }
  if (/enospc|no space left/.test(text)) {
    return '磁盘快满了,装不下(要约 230MB)。腾点地方之后下次开机自己接着装。'
  }
  if (/eacces|permission denied/.test(text)) {
    return '没有写入权限,装不上。'
  }
  const tail = out.split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(-1)[0]
  return tail ? `这次没装上:${tail}` : '这次没装上。'
}

export function createConnectorService(deps: ConnectorServiceDeps): ConnectorService {
  const io = deps.io ?? nodeSetupIo()
  const home = deps.home
  const p = connectorPaths(home)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const cacheMs = deps.cacheMs ?? 3000
  const randomToken = deps.randomToken ?? defaultToken

  let phase: ConnectorPhase = 'missing'
  let note: string | undefined
  let running: Promise<{ ok: boolean, error?: string }> | undefined
  let cached: { at: number, view: ConnectorView } | undefined
  let appsCount: number | undefined

  const changed = (): void => {
    cached = undefined
    deps.onChanged?.()
  }

  async function healthy(port: number): Promise<boolean> {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
      if (!r.ok) return false
      const body = await r.json() as { name?: unknown }
      return body?.name === 'open-connector'
    } catch {
      return false
    }
  }

  /** 数 catalog 里有多少家。数一次就记住 —— 那是 1554 个文件,不该每秒数一遍。 */
  async function countApps(): Promise<number | undefined> {
    if (appsCount !== undefined) return appsCount
    try {
      const names = await readdir(p.catalogDir)
      appsCount = names.filter((n) => n.endsWith('.json')).length
      return appsCount
    } catch {
      return undefined
    }
  }

  async function bytesOf(): Promise<number | undefined> {
    // 不去递归数 229MB 那棵树(几千个文件,每次开设置都数一遍太贵)。
    // 装好之后就报钉死的那个实测值 —— 界面上说的是「占多大」这个量级,不是精确到字节。
    try {
      const s = await stat(p.packageDir)
      return s.isDirectory() ? CONNECTOR_DISK_BYTES : undefined
    } catch {
      return undefined
    }
  }

  async function compose(): Promise<ConnectorView> {
    const installedText = await io.readFile(`${p.packageDir}/package.json`)
    const installed = installedText !== undefined
    const config = parseConnectorConfig(await io.readFile(p.configFile))
    const port = config?.port ?? CONNECTOR_DEFAULT_PORT
    const written = parseMcpWritten(await io.readFile(`${p.dir}/written.json`))
    const hosts = MCP_HOSTS.map((h) => ({ id: h.id, label: h.label, connected: written[h.id] !== undefined }))
    const livePhase: ConnectorPhase = phase === 'installing' ? 'installing' : installed ? 'ready' : phase
    const view: ConnectorView = {
      phase: livePhase,
      installed,
      running: installed ? await healthy(port) : false,
      port,
      version: CONNECTOR_VERSION,
      downloadBytes: CONNECTOR_DISK_BYTES,
      hosts,
    }
    const apps = await countApps()
    if (apps !== undefined) view.apps = apps
    if (installed) {
      view.connected = config?.services.length ?? 0
      const bytes = await bytesOf()
      if (bytes !== undefined) view.bytes = bytes
    }
    if (note !== undefined) view.note = note
    return view
  }

  async function runInstall(): Promise<{ ok: boolean, error?: string }> {
    phase = 'installing'
    note = '正在装(第一次要下载约 230MB)'
    changed()
    try {
      const r = await installConnector({
        io, home, randomToken,
        /**
         * 探到「真答上话」为止,最多等 8 秒 —— launchd 那一下 kickstart 之后
         * 它 0.2 秒就起来了(实测),8 秒是给磁盘慢的机器留的余量。
         * 探不通就这一趟不接事务官(见 install.ts 里 `probe` 的注释)。
         */
        probe: async () => {
          const config = parseConnectorConfig(await io.readFile(p.configFile))
          const port = config?.port ?? CONNECTOR_DEFAULT_PORT
          const attempts = deps.probeAttempts ?? 16
          const gap = deps.probeGapMs ?? 500
          for (let i = 0; i < attempts; i += 1) {
            if (await healthy(port)) return true
            if (gap > 0) await new Promise((r2) => setTimeout(r2, gap))
          }
          return false
        },
      })
      if (!r.ok) {
        const bad = r.steps.find((s) => !s.ok)
        phase = 'failed'
        note = connectorFailureNote(bad?.message ?? '')
        changed()
        return { ok: false, error: note }
      }
      phase = 'ready'
      note = mcpNote(r.mcp)
      changed()
      return { ok: true }
    } catch (e) {
      phase = 'failed'
      note = connectorFailureNote(e instanceof Error ? e.message : String(e))
      changed()
      return { ok: false, error: note }
    } finally {
      running = undefined
    }
  }

  /** 三家里有谁因为「她手改过」没接上,就把那句话原样带到界面上。都好就没话说。 */
  function mcpNote(results: readonly ConnectorMcpResult[]): string | undefined {
    const trouble = results.filter((r) => r.reason === 'user-edited' || r.reason === 'bad')
    if (trouble.length === 0) return undefined
    return trouble.map((r) => r.say).join(' ')
  }

  function ensureOnce(): Promise<{ ok: boolean, error?: string }> {
    running ??= runInstall()
    return running
  }

  return {
    async view() {
      if (cacheMs > 0 && cached && now() - cached.at < cacheMs) return cached.view
      const view = await compose()
      cached = { at: now(), view }
      return view
    },
    ensure() {
      // 故意游离:开机那一刻不许等它。装挂了只记一句话,下次启动再试。
      void ensureOnce().catch(() => undefined)
    },
    install() {
      return ensureOnce()
    },
    async start() {
      const r = await io.exec(['launchctl', 'kickstart', '-k', `gui/${io.uid()}/${CONNECTOR_LAUNCHD_LABEL}`])
      changed()
      if (r.ok) return { ok: true }
      return { ok: false, error: `起不来:${r.out.split('\n').slice(-1)[0] ?? ''}`.trim() }
    },
    async stop() {
      const r = await io.exec(['launchctl', 'kill', 'SIGTERM', `gui/${io.uid()}/${CONNECTOR_LAUNCHD_LABEL}`])
      changed()
      if (r.ok) return { ok: true }
      return { ok: false, error: `停不下来:${r.out.split('\n').slice(-1)[0] ?? ''}`.trim() }
    },
    async uninstall() {
      const r = await uninstallConnector({ io, home })
      phase = 'missing'
      note = '已经卸掉了 —— 各家账号的凭据也一起删了,以后要用得重新授权。'
      appsCount = undefined
      changed()
      return r.ok ? { ok: true } : { ok: false, error: '没卸干净' }
    },
  }
}
