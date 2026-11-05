/**
 * 连接器的**装 / 卸**(卡 OC,2026-09-27)。
 *
 * 全部动作都经 `SetupIo`(登录台那一套注入口),于是测试既能整个搬进临时 HOME,
 * 又能只断言「调了什么命令、写了哪些文件」而不真去跑 npm 与 launchctl。
 *
 * ## 顺序(每一步都先看「是不是已经好了」,幂等)
 *
 * 1. 体检自带 node:`~/.dsh/node/bin/node`,大版本 ≥ 22(它 `engines` 要 22.18+,我们自带 24.19)。
 * 2. `~/.dsh/open-connector/package.json` —— 依赖**逐字钉死版本**,没有 `^`、没有 latest(C4)。
 * 3. `npm install`(用自带的 npm,装进那个目录;registry 自己会按 integrity 校验 tarball)。
 * 4. 写宿主 `server.mjs` 与 `policy.json`(默认只读,一家都没接时是「什么都不许」)。
 * 5. 配置 `~/.dsh/workbench/connector.json`,**0600**;已经有就原样留着(令牌不重开)。
 * 6. 启动脚本、环境脚本、launchd plist(`{{HOME}}` 占位,不写死 /Users/example)。
 * 7. `launchctl bootstrap`(`code 5` / already loaded 不算失败)。
 * 8. 往三家 Agent 的 MCP 配置里写我们那一条(她改过的不覆盖)。
 *
 * 卸载是倒着来,而且**连数据目录一起删** —— 那里头是加密存着的各家账号凭据,
 * 「一键卸」的意思就是机器上不再留着它们。这一条在界面上要说明白。
 */
import type { SetupIo } from '../setup/io.ts'
import {
  CONNECTOR_DEFAULT_PORT, CONNECTOR_HOST_SERVER_PACKAGE, CONNECTOR_HOST_SERVER_VERSION,
  CONNECTOR_LAUNCHD_LABEL, CONNECTOR_MIN_NODE_MAJOR, CONNECTOR_PACKAGE, CONNECTOR_VERSION,
  connectorPaths, type ConnectorPaths,
} from './manifest.ts'
import { CONNECTOR_HOST_SCRIPT, connectorEnvScript, connectorPlist, connectorStartScript } from './hostScript.ts'
import { MCP_HOSTS, parseMcpWritten, type McpHostId, type McpPatchReason, type McpWritten } from './mcpConfig.ts'
import { buildConnectorPolicy, type ConnectorCatalogReader } from './policy.ts'

export interface ConnectorConfigFile {
  version: 1
  port: number
  /** 本机令牌。**只住在这个 0600 的文件里**,不进 plist、不进任何 Agent 的配置。 */
  runtimeToken: string
  adminToken: string
  /** 落盘凭据的加密钥匙。省掉它就是明文存,所以一定要有。 */
  encryptionKey: string
  /** 她授权并打开了的那几家。 */
  services: string[]
}

export interface ConnectorInstallDeps {
  io: SetupIo
  home: string
  /** 生成本机令牌。测试里换成定值。 */
  randomToken: () => string
  /** npm 那一步可能要几分钟。 */
  npmTimeoutMs?: number
  onLine?: (line: string) => void
  /**
   * 「连接器此刻真答得上话吗」(卡 OC2)。
   *
   * 只有**事务官那一条**要它:DSH 的 `dsh-mcp-client` 是**启动时**连的,上游 README 明写
   * 「慢的或崩掉的服务器会拖慢启动、或者让调用一直失败到它恢复」。所以连接器没起来的时候
   * **宁可这次不接事务官**,也不能让 DSH 每次开机先卡一下 —— 那是工作台本体的启动路径。
   * Claude Code 与 Codex 是**用到才连**的,不受这条影响,照写。
   *
   * 不传 = 不探,三家都照写(测试与「先写配置再起进程」那种顺序用)。
   */
  probe?: () => Promise<boolean>
}

export interface ConnectorStepResult {
  step: string
  ok: boolean
  /** 说人话;成功那步也可以带一句(例如「本来就装着,跳过」)。 */
  message?: string
}

export interface ConnectorMcpResult {
  host: McpHostId
  reason: McpPatchReason
  /** 原样转达给界面的那一句人话。**前端不自己编话。** */
  say: string
}

export interface ConnectorInstallResult {
  ok: boolean
  steps: ConnectorStepResult[]
  mcp: ConnectorMcpResult[]
}

function packageJson(): string {
  return `${JSON.stringify({
    name: 'workbench-open-connector-host',
    private: true,
    type: 'module',
    // C4:逐字钉死,不用 ^ / ~ / latest。升级是单独一张卡。
    dependencies: {
      [CONNECTOR_PACKAGE]: CONNECTOR_VERSION,
      [CONNECTOR_HOST_SERVER_PACKAGE]: CONNECTOR_HOST_SERVER_VERSION,
    },
  }, null, 2)}\n`
}

/** 32 字节十六进制。`crypto` 在调用方注入,这里只定长度口径。 */
export const CONNECTOR_TOKEN_BYTES = 32

async function nodeMajor(io: SetupIo, nodeBin: string): Promise<number | undefined> {
  const r = await io.exec([nodeBin, '-v'])
  if (!r.ok) return undefined
  const m = /v(\d+)\./.exec(r.out.trim())
  if (!m?.[1]) return undefined
  return Number(m[1])
}

/** 读回已有配置;读不到 / 坏了一律回 `undefined`(不猜、不半修)。 */
export function parseConnectorConfig(text: string | undefined): ConnectorConfigFile | undefined {
  if (!text) return undefined
  try {
    const j: unknown = JSON.parse(text)
    if (!j || typeof j !== 'object') return undefined
    const o = j as Record<string, unknown>
    if (typeof o['port'] !== 'number') return undefined
    if (typeof o['runtimeToken'] !== 'string' || o['runtimeToken'] === '') return undefined
    if (typeof o['adminToken'] !== 'string' || o['adminToken'] === '') return undefined
    if (typeof o['encryptionKey'] !== 'string' || o['encryptionKey'] === '') return undefined
    return {
      version: 1,
      port: o['port'],
      runtimeToken: o['runtimeToken'],
      adminToken: o['adminToken'],
      encryptionKey: o['encryptionKey'],
      services: Array.isArray(o['services']) ? o['services'].filter((s): s is string => typeof s === 'string') : [],
    }
  } catch {
    return undefined
  }
}

/** 算这一刻该落盘的 policy.json。抽出来是为了「批过一条写动作」之后能只重算这一份 + 重启。 */
export function connectorPolicyFile(services: readonly string[], catalog: ConnectorCatalogReader, approvedWrites?: readonly string[]): string {
  const policy = buildConnectorPolicy({ services, catalog, ...(approvedWrites ? { approvedWrites } : {}) })
  return `${JSON.stringify({ allowedActions: policy.allowedActions }, null, 2)}\n`
}

export async function installConnector(deps: ConnectorInstallDeps): Promise<ConnectorInstallResult> {
  const { io, home } = deps
  const p = connectorPaths(home)
  const steps: ConnectorStepResult[] = []
  const mcp: ConnectorInstallResult['mcp'] = []
  const fail = (step: string, message: string): ConnectorInstallResult => {
    steps.push({ step, ok: false, message })
    return { ok: false, steps, mcp }
  }

  // 1. node
  const major = await nodeMajor(io, p.nodeBin)
  if (major === undefined) {
    return fail('node', `找不到工作台自带的 node(${p.nodeBin}):先在登录台把「自有 node」那一步装上`)
  }
  if (major < CONNECTOR_MIN_NODE_MAJOR) {
    return fail('node', `连接器要 node ${CONNECTOR_MIN_NODE_MAJOR} 以上,这台自带的是 ${major}`)
  }
  steps.push({ step: 'node', ok: true, message: `自带 node v${major}` })

  // 2 + 3. 依赖树
  await io.mkdirp(p.dir)
  const wantedPkg = packageJson()
  const havePkg = await io.readFile(`${p.dir}/package.json`)
  if (havePkg !== wantedPkg) await io.writeFile(`${p.dir}/package.json`, wantedPkg)
  const installed = await io.stat(`${p.packageDir}/package.json`)
  const installedVersion = installed ? versionOf(await io.readFile(`${p.packageDir}/package.json`)) : undefined
  if (installedVersion === CONNECTOR_VERSION && havePkg === wantedPkg) {
    steps.push({ step: 'deps', ok: true, message: `${CONNECTOR_PACKAGE}@${CONNECTOR_VERSION} 本来就装着,跳过` })
  } else {
    const npm = `${home}/.dsh/node/bin/npm`
    const r = await io.exec([npm, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: p.dir,
      timeoutMs: deps.npmTimeoutMs ?? 10 * 60 * 1000,
      ...(deps.onLine ? { onLine: deps.onLine } : {}),
    })
    if (!r.ok) {
      return fail('deps', `装 ${CONNECTOR_PACKAGE}@${CONNECTOR_VERSION} 没成:${tail(r.out)}`)
    }
    steps.push({ step: 'deps', ok: true, message: `装上 ${CONNECTOR_PACKAGE}@${CONNECTOR_VERSION}` })
  }

  // 4. 宿主与策略
  await writeIfChanged(io, p.entry, CONNECTOR_HOST_SCRIPT)
  await io.mkdirp(p.dataDir)
  const existingConfig = parseConnectorConfig(await io.readFile(p.configFile))
  const services = existingConfig?.services ?? []
  const catalogReader = await loadConnectorCatalog(io, p, services)
  await writeIfChanged(io, `${p.dir}/policy.json`, connectorPolicyFile(services, catalogReader))
  steps.push({ step: 'host', ok: true, message: services.length === 0 ? '默认只读;还没接任何一家,所以现在什么动作都不许' : `默认只读;接了 ${services.length} 家` })

  // 5. 配置(0600,已有就原样留着)
  if (!existingConfig) {
    await io.mkdirp(`${home}/.dsh/workbench`)
    const config: ConnectorConfigFile = {
      version: 1,
      port: CONNECTOR_DEFAULT_PORT,
      runtimeToken: deps.randomToken(),
      adminToken: deps.randomToken(),
      encryptionKey: deps.randomToken(),
      services: [],
    }
    await io.writeFile(p.configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600)
    steps.push({ step: 'config', ok: true, message: `生成 ${p.configFile}(0600)` })
  } else {
    steps.push({ step: 'config', ok: true, message: '配置本来就在,没重开令牌' })
  }
  const port = existingConfig?.port ?? CONNECTOR_DEFAULT_PORT

  // 6. 脚本与 plist
  await io.mkdirp(`${home}/.dsh/bin`)
  await io.mkdirp(`${home}/.dsh/logs`)
  await writeIfChanged(io, p.startScript, connectorStartScript(), 0o755)
  await io.chmod(p.startScript, 0o755)
  await writeIfChanged(io, `${home}/.dsh/bin/connector-env`, connectorEnvScript(), 0o755)
  await io.chmod(`${home}/.dsh/bin/connector-env`, 0o755)
  await io.mkdirp(`${home}/Library/LaunchAgents`)
  await writeIfChanged(io, p.plist, connectorPlist().replaceAll('{{HOME}}', home))
  steps.push({ step: 'scripts', ok: true })

  // 7. launchd
  const boot = await io.exec(['launchctl', 'bootstrap', `gui/${io.uid()}`, p.plist])
  if (!boot.ok && boot.code !== 5 && !/already\s+(loaded|bootstrapped)/i.test(boot.out)) {
    steps.push({ step: 'launchd', ok: false, message: `launchctl bootstrap 没成:${tail(boot.out)}` })
  } else {
    await io.exec(['launchctl', 'kickstart', '-k', `gui/${io.uid()}/${CONNECTOR_LAUNCHD_LABEL}`])
    steps.push({ step: 'launchd', ok: true })
  }

  // 8. 各家 Agent 的 MCP 配置。「是不是我们写的」**靠记账**(written.json),
  //    不靠往配置里塞自己的字段 —— Claude Code 与 Codex 对未知字段会报错(卡 SE 那条)。
  const written = parseMcpWritten(await io.readFile(`${p.dir}/written.json`))
  const nextWritten: McpWritten = { ...written }
  // 事务官那一条要先探一句(见 `probe` 的注释)。探不通就这一趟不接它,下次启动再试。
  const alive = deps.probe === undefined ? true : await deps.probe().catch(() => false)
  for (const host of MCP_HOSTS) {
    if (host.id === 'dsh' && !alive) {
      mcp.push({ host: host.id, reason: 'absent', say: '连接器这会儿还没答话,先没接给事务官(下次开机再试)。' })
      continue
    }
    const file = host.file(home)
    const before = (await io.readFile(file)) ?? ''
    const patch = host.patch(before, { port, ...(written[host.id] !== undefined ? { recorded: written[host.id] } : {}) })
    if (patch.ok && patch.changed) {
      await io.mkdirp(dirOf(file))
      await io.writeFile(file, patch.text)
    }
    if (patch.wrote !== undefined) nextWritten[host.id] = patch.wrote
    mcp.push({ host: host.id, reason: patch.reason, say: patch.say })
  }
  await writeIfChanged(io, `${p.dir}/written.json`, `${JSON.stringify(nextWritten, null, 2)}\n`)
  steps.push({ step: 'mcp', ok: true })

  return { ok: steps.every((s) => s.ok), steps, mcp }
}

export interface ConnectorUninstallResult {
  ok: boolean
  steps: ConnectorStepResult[]
  mcp: ConnectorMcpResult[]
  /** 真删掉的那几条路径,给交接与测试核「卸干净了没有」。 */
  removed: string[]
}

export async function uninstallConnector(deps: Pick<ConnectorInstallDeps, 'io' | 'home'>): Promise<ConnectorUninstallResult> {
  const { io, home } = deps
  const p = connectorPaths(home)
  const steps: ConnectorStepResult[] = []
  const mcp: ConnectorUninstallResult['mcp'] = []

  // 先停,再删 —— 反过来的话 launchd 会在半删状态上反复重拉。
  await io.exec(['launchctl', 'bootout', `gui/${io.uid()}/${CONNECTOR_LAUNCHD_LABEL}`])
  steps.push({ step: 'launchd', ok: true })

  // 摘配置要在删目录**之前** —— written.json 是判「这一格是不是我们写的」的唯一依据,
  // 删完就认不出来了,那时候只能把她手改过的也一起删掉,那是不对的。
  const written = parseMcpWritten(await io.readFile(`${p.dir}/written.json`))
  for (const host of MCP_HOSTS) {
    const file = host.file(home)
    const before = (await io.readFile(file)) ?? ''
    const patch = host.unpatch(before, { port: 0, ...(written[host.id] !== undefined ? { recorded: written[host.id] } : {}) })
    if (patch.ok && patch.changed) await io.writeFile(file, patch.text)
    mcp.push({ host: host.id, reason: patch.reason, say: patch.say })
  }
  steps.push({ step: 'mcp', ok: true })

  // 目录、配置、脚本、plist。**数据目录一起删** —— 里头是各家账号的凭据。
  const removed: string[] = []
  for (const path of [p.dir, p.configFile, p.startScript, `${home}/.dsh/bin/connector-env`, p.plist]) {
    if (await io.stat(path)) {
      await io.rmrf(path)
      removed.push(path)
    }
  }
  steps.push({ step: 'files', ok: true, message: removed.length === 0 ? '本来就没装' : `删了 ${removed.length} 处` })
  return { ok: true, steps, mcp, removed }
}

/* ---------------------------------------------------------------- */

async function writeIfChanged(io: SetupIo, path: string, text: string, mode?: number): Promise<boolean> {
  const before = await io.readFile(path)
  if (before === text) return false
  await io.mkdirp(dirOf(path))
  if (mode === undefined) await io.writeFile(path, text)
  else await io.writeFile(path, text, mode)
  return true
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function versionOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  try {
    const j: unknown = JSON.parse(text)
    const v = (j as Record<string, unknown> | null)?.['version']
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

function tail(out: string): string {
  return out.split('\n').slice(-20).join('\n').trim()
}

/** 从装好的包里读 catalog(只读要用的那几家)。读不到的那一家在策略里记 `missing`,**不放行任何动作**。 */
export async function loadConnectorCatalog(io: SetupIo, p: ConnectorPaths, services: readonly string[]): Promise<ConnectorCatalogReader> {
  const apps = new Map<string, ReturnType<ConnectorCatalogReader>>()
  for (const service of new Set(services)) {
    const text = await io.readFile(`${p.catalogDir}/${service}.json`)
    if (!text) continue
    try {
      const j: unknown = JSON.parse(text)
      if (j && typeof j === 'object' && Array.isArray((j as { actions?: unknown }).actions)) {
        apps.set(service, j as ReturnType<ConnectorCatalogReader>)
      }
    } catch {
      // 读坏了当没有这一家 —— 不猜。
    }
  }
  return (service) => apps.get(service)
}
