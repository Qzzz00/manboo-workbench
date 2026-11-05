/**
 * 本机房间(2026-10-21,局域网主路卡 M1;docs/设计-局域网主路-2026-10-21.md 第一节)。
 *
 * 这台 Mac 上随包装着一台 `livekit-server`(`~/.dsh/livekit/`),由 launchd 那一项 `ai.deepseek.livekit`
 * 跑 `~/.dsh/bin/livekit-start` 看管。这个文件管两件事:
 *
 *   1. **钥匙与两份配置**:装的时候(或 8791 起来时发现装了二进制却没有钥匙)生成一对 api key / secret,
 *      写进 `~/.dsh/workbench/channel.json`(8791 签票用,字段沿用 `channel.ts` 的配置文件)与
 *      `~/.dsh/livekit/livekit.yaml`(livekit 进程认的),两份都 0600、钥匙是同一对。
 *      **secret 只出现在这两份文件里**:回给调用方的那句话、日志、`/channel/status` 一律不带。
 *   2. **8791 的看管**:每 30 秒看一次这台 Mac 的局域网地址,变了就 `launchctl kickstart -k` 那一项
 *      (livekit 不写死 `node_ip`,单 UDP 口时按每块网卡出候选;换了网卡要重起才认新地址),
 *      `/channel/status` 的 `local_room` 一格报「在不在、地址、上次重起的时刻」。
 *
 * channel.json 里已经有一对钥匙、地址却指向别处(从云上那台拷来的那份)时**不替她改**,
 * 也不写 livekit.yaml —— 那是她自己定的路,本机房间就不起(`livekit-start` 读不到配置就以 0 退出)。
 */
import { randomBytes } from 'node:crypto'
import { isThisMachineHost } from './channel.ts'
import { localRoomOf } from './machineId.ts'
import type { SetupIo } from './setup/io.ts'
import { LIVEKIT_LAUNCHD_LABEL, LIVEKIT_PORTS, type SetupPaths } from './setup/paths.ts'

export interface LocalRoomKeys { apiKey: string, apiSecret: string }
export interface LocalRoomPorts { signal: number, tcp: number, udp: number }

/** 8791 多久看一次局域网地址。 */
export const LOCAL_ROOM_WATCH_MS = 30_000
/** 探 7880 给多久。本机回环,一秒都嫌多。 */
const PROBE_TIMEOUT_MS = 1_000

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** n 位字母数字。按字节拒绝采样(248 以上丢掉),不偏向前几个字母。 */
function randomAlnum(n: number): string {
  let out = ''
  while (out.length < n) {
    for (const byte of randomBytes(n * 2)) {
      if (byte >= 248) continue
      out += ALNUM[byte % ALNUM.length]
      if (out.length === n) break
    }
  }
  return out
}

/**
 * 一对新钥匙。形状照 `livekit-server generate-keys`(`API` + 12 位;secret 要不少于 32 位,这里 43 位)。
 * 只用字母数字:YAML 与 JSON 里都不用操心转义。
 */
export function generateLocalRoomKeys(): LocalRoomKeys {
  return { apiKey: `API${randomAlnum(12)}`, apiSecret: randomAlnum(43) }
}

/** 地址里的信令口 → 一整组口(另两个跟着 +1 / +2)。没写口就是缺省那一组。 */
export function portsOfUrl(url: string): LocalRoomPorts {
  let signal: number = LIVEKIT_PORTS.signal
  try {
    const port = Number(new URL(url).port)
    if (Number.isInteger(port) && port > 0) signal = port
  }
  catch { /* 读不懂的地址:缺省那一组 */ }
  return { signal, tcp: signal + 1, udp: signal + 2 }
}

/** livekit.yaml 里那一行 `port:`。读不出来回 undefined。 */
export function readLivekitPort(yaml: string | undefined): number | undefined {
  const match = /^port:\s*(\d+)\s*$/m.exec(yaml ?? '')
  return match === null ? undefined : Number(match[1])
}

/**
 * livekit.yaml。**`deploy/livekit-start` 按行改 `port:` / `tcp_port:` / `udp_port:` 三行**(7880 被占时换口),
 * 所以这三行的写法(顶格 / 两格缩进、冒号后一个空格)改了要一起改那个脚本。
 */
export function renderLivekitYaml(input: { keys: LocalRoomKeys, ports: LocalRoomPorts }): string {
  return [
    '# 本机房间(livekit-server)的配置。工作台装的时候生成,0600;钥匙与 ~/.dsh/workbench/channel.json 里那一对是同一对。',
    '# 7880 被别的程序占着时,~/.dsh/bin/livekit-start 会把三个口整组换到 7890 / 7891 / 7892,并把 channel.json 的地址一起改掉。',
    `port: ${input.ports.signal}`,
    'bind_addresses:',
    '  - "0.0.0.0"',
    'rtc:',
    `  tcp_port: ${input.ports.tcp}`,
    `  udp_port: ${input.ports.udp}`,
    '  use_external_ip: false',
    'keys:',
    `  ${JSON.stringify(input.keys.apiKey)}: ${JSON.stringify(input.keys.apiSecret)}`,
    'logging:',
    '  level: info',
    'room:',
    '  empty_timeout: 300',
    '',
  ].join('\n')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function hostOfUrl(url: string): string | undefined {
  try { return new URL(url).hostname }
  catch { return undefined }
}

export interface LocalRoomConfigPlan {
  /**
   * `written` = 至少有一份要写;`unchanged` = 两份都已经是该有的样子;
   * `foreign` = channel.json 指向别处的 LiveKit,不替她改、不起本机房间。
   */
  state: 'written' | 'unchanged' | 'foreign'
  /** 这一趟现生成了钥匙。 */
  generated: boolean
  /** 要写进 channel.json 的全文。缺席 = 不用写。 */
  channelText?: string
  /** 要写进 livekit.yaml 的全文。缺席 = 不用写。 */
  yamlText?: string
  /** 原来那份 channel.json 读不懂,写之前先留一份备份。 */
  backup?: boolean
  /** 给人看的一句话。**不含任何钥匙**。 */
  note: string
}

/**
 * 两份配置该是什么样(纯函数)。
 *
 * - channel.json 没有、或者没有完整的一对钥匙 → 现生成一对,补上 `url`(回环 7880)与 `room`,别的格原样留着;
 * - 有一对、地址指向本机(或没写地址)→ 沿用那一对,缺 `url` / `room` 就补,livekit.yaml 照它重写;
 * - 有一对、地址指向别处 → `foreign`,两份都不碰;
 * - 读不懂 → 留备份,当成没有。
 */
export function planLocalRoomConfig(input: {
  channelText?: string
  yamlText?: string
  /** `wb-local-<机器 id 前 8 位>`。取不到机器 id 就不写(8791 读不到 room 时自己补)。 */
  room?: string
  newKeys: () => LocalRoomKeys
}): LocalRoomConfigPlan {
  let raw: Record<string, unknown> = {}
  let backup = false
  if (input.channelText !== undefined) {
    try {
      const parsed = JSON.parse(input.channelText) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
      else backup = true
    }
    catch { backup = true }
  }
  const url = text(raw.url)
  const hadKey = text(raw.api_key)
  const hadSecret = text(raw.api_secret)
  const pair = hadKey !== undefined && hadSecret !== undefined

  if (pair && url !== undefined && !isThisMachineHost(hostOfUrl(url))) {
    return {
      state: 'foreign',
      generated: false,
      note: `channel.json 指向别处的 LiveKit(${hostOfUrl(url) ?? url}),不替你改;这台 Mac 上的本机房间不起。要换成本机房间,删掉 channel.json 里 url / api_key / api_secret 三格,工作台下次起来会补上。`,
    }
  }

  const keys = pair ? { apiKey: hadKey, apiSecret: hadSecret } : input.newKeys()
  const next: Record<string, unknown> = { ...raw }
  if (!pair) {
    next.api_key = keys.apiKey
    next.api_secret = keys.apiSecret
  }
  // 地址指向本机(包括 livekit-start 换到 7890 之后写回的那个)就照旧;没写、或者没钥匙时指着别处的,改成回环 7880。
  if (url === undefined || !isThisMachineHost(hostOfUrl(url))) next.url = `ws://127.0.0.1:${LIVEKIT_PORTS.signal}`
  if (text(raw.room) === undefined && input.room !== undefined) next.room = input.room
  // 键的顺序:新写的那几格排前面(人打开文件先看见地址),原有的格跟在后面。
  const ordered: Record<string, unknown> = {}
  for (const key of ['url', 'api_key', 'api_secret', 'room']) if (next[key] !== undefined) ordered[key] = next[key]
  for (const [key, value] of Object.entries(next)) if (!(key in ordered)) ordered[key] = value

  const channelChanged = backup || input.channelText === undefined
    || Object.keys(ordered).some(key => JSON.stringify(ordered[key]) !== JSON.stringify(raw[key]))
  const yaml = renderLivekitYaml({ keys, ports: portsOfUrl(String(ordered.url)) })
  const yamlChanged = input.yamlText !== yaml

  const plan: LocalRoomConfigPlan = {
    state: channelChanged || yamlChanged ? 'written' : 'unchanged',
    generated: !pair,
    note: !pair
      ? '本机房间的钥匙现生成了一对,写进了 channel.json 与 livekit.yaml(两份都只有你这个账户能读)。'
      : channelChanged || yamlChanged
        ? '本机房间沿用 channel.json 里那一对钥匙,配置已经核对成这一版该有的样子。'
        : '本机房间的两份配置都在,不用动。',
  }
  if (channelChanged) plan.channelText = `${JSON.stringify(ordered, null, 2)}\n`
  if (yamlChanged) plan.yamlText = yaml
  if (backup) plan.backup = true
  return plan
}

export interface EnsureLocalRoomDeps {
  io: SetupIo
  paths: SetupPaths
  /** 机器 id(`machineId.ts` 的 `readOrCreateMachineId`)。取不到回 undefined / 抛都行:房间名不写。 */
  machineId: () => Promise<string | undefined>
  now?: () => number
}

/**
 * 照 {@link planLocalRoomConfig} 落盘,两份都收成 0600。回的那句话里没有钥匙。
 * **不管二进制装没装**:要不要现在就写(没装时不写)由调用方定。
 */
export async function ensureLocalRoomConfig(deps: EnsureLocalRoomDeps): Promise<LocalRoomConfigPlan> {
  let room: string | undefined
  try {
    const id = await deps.machineId()
    if (id !== undefined) room = localRoomOf(id)
  }
  catch { /* 落不了盘:这一次不写房间名 */ }
  const channelText = await deps.io.readFile(deps.paths.channelJson)
  const plan = planLocalRoomConfig({
    ...(channelText === undefined ? {} : { channelText }),
    ...(await readOptional(deps.io, deps.paths.livekitYaml)),
    ...(room === undefined ? {} : { room }),
    newKeys: generateLocalRoomKeys,
  })
  if (plan.backup === true && channelText !== undefined) {
    const stamp = new Date(deps.now?.() ?? Date.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    await deps.io.writeFile(`${deps.paths.channelJson}.bak-${stamp}`, channelText, 0o600)
  }
  if (plan.channelText !== undefined) await deps.io.writeFile(deps.paths.channelJson, plan.channelText, 0o600)
  if (plan.yamlText !== undefined) {
    await deps.io.mkdirp(deps.paths.livekitDir)
    await deps.io.writeFile(deps.paths.livekitYaml, plan.yamlText, 0o600)
  }
  return plan
}

async function readOptional(io: SetupIo, path: string): Promise<{ yamlText?: string }> {
  const yaml = await io.readFile(path)
  return yaml === undefined ? {} : { yamlText: yaml }
}

// ───────────────────────── 8791 的看管 ─────────────────────────

/** `/channel/status` 的 `local_room` 一格。**没有任何钥匙**。 */
export interface LocalRoomView {
  /** `~/.dsh/livekit/livekit-server` 在不在。 */
  installed: boolean
  /** 本机回环上那个信令口答了 200 没有。 */
  running: boolean
  /** 这台 Mac 自己连的地址(回环)。读不出口时缺席。 */
  url?: string
  /** 局域网里的设备连的那几个地址(每块网卡一个)。 */
  lan_urls: readonly string[]
  /** 8791 上一次因为地址变了让 launchd 重起它的时刻(ISO)。这个进程里没重起过就缺席。 */
  restarted_at?: string
  restart_reason?: string
  /** 不在 / 没装 / 不起时那句人话。 */
  note?: string
}

export interface LocalRoomService {
  /** 装了二进制、没有钥匙就补上(补了就让 launchd 重起它)。插件起来时跑一次。 */
  ensure: () => Promise<void>
  /** 看一眼地址,变了就重起。 */
  tick: () => Promise<void>
  /** `ensure` 一次,然后每 30 秒 `tick` 一次。 */
  start: () => void
  stop: () => void
  view: () => Promise<LocalRoomView>
}

export interface LocalRoomServiceDeps {
  io: SetupIo
  paths: SetupPaths
  lanAddresses: () => readonly string[]
  machineId: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  intervalMs?: number
  log?: (line: string) => void
}

export function createLocalRoomService(deps: LocalRoomServiceDeps): LocalRoomService {
  const now = deps.now ?? Date.now
  const doFetch = deps.fetchImpl ?? fetch
  const log = deps.log ?? (() => {})
  let lastAddresses: string | undefined
  let restarted: { at: string, reason: string } | undefined
  let foreignNote: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const installed = async (): Promise<boolean> => (await deps.io.stat(deps.paths.livekitBin))?.isFile === true

  async function kickstart(reason: string): Promise<boolean> {
    const target = `gui/${deps.io.uid()}/${LIVEKIT_LAUNCHD_LABEL}`
    const result = await deps.io.exec(['launchctl', 'kickstart', '-k', target], { timeoutMs: 30_000 })
    if (!result.ok) {
      log(`[本机房间] ${reason},想让 launchd 重起 ${LIVEKIT_LAUNCHD_LABEL},没成(退出码 ${result.code})`)
      return false
    }
    log(`[本机房间] ${reason},已让 launchd 重起 ${LIVEKIT_LAUNCHD_LABEL}`)
    return true
  }

  async function ensure(): Promise<void> {
    if (!await installed()) return
    const plan = await ensureLocalRoomConfig({ io: deps.io, paths: deps.paths, machineId: deps.machineId, now })
    foreignNote = plan.state === 'foreign' ? plan.note : undefined
    if (plan.state === 'written') {
      log(`[本机房间] ${plan.note}`)
      await kickstart('配置刚补上')
    }
  }

  async function tick(): Promise<void> {
    const addresses = [...deps.lanAddresses()].sort().join(', ')
    const before = lastAddresses
    lastAddresses = addresses
    if (before === undefined || before === addresses) return
    if (!await installed() || await deps.io.stat(deps.paths.livekitPlist) === undefined) return
    const reason = `局域网地址变了(${before === '' ? '没有' : before} → ${addresses === '' ? '没有' : addresses})`
    if (await kickstart(reason)) restarted = { at: new Date(now()).toISOString(), reason }
  }

  return {
    ensure,
    tick,
    start() {
      if (timer !== undefined) return
      void ensure().catch(() => {}).then(() => tick()).catch(() => {})
      timer = setInterval(() => { void tick().catch(() => {}) }, deps.intervalMs ?? LOCAL_ROOM_WATCH_MS)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
    async view() {
      const has = await installed()
      const yaml = await deps.io.readFile(deps.paths.livekitYaml)
      const port = readLivekitPort(yaml)
      const base: LocalRoomView = {
        installed: has,
        running: false,
        lan_urls: port === undefined ? [] : deps.lanAddresses().map(address => `ws://${address}:${port}`),
        ...(restarted === undefined ? {} : { restarted_at: restarted.at, restart_reason: restarted.reason }),
      }
      if (!has) return { ...base, note: '这台 Mac 上没装本机通话服务(livekit-server);打电话走云上那条。' }
      if (foreignNote !== undefined) return { ...base, note: foreignNote }
      if (port === undefined) return { ...base, note: `本机通话服务装了,但还没有配置(${deps.paths.livekitYaml})。工作台下次起来会补上。` }
      const url = `ws://127.0.0.1:${port}`
      let running = false
      try {
        const res = await doFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        running = res.ok
      }
      catch { running = false }
      return running
        ? { ...base, url, running: true }
        : { ...base, url, note: `本机通话服务没答(127.0.0.1:${port})。launchd 会自己拉起它;一直不在的话看 ~/.dsh/logs/livekit.stderr.log。` }
    },
  }
}
