/**
 * 哨兵(2026-09-09,借鉴 fuhefei/dsh-sentinel 0.11.1 的设计,**不装它**)。
 *
 * 借来的是产品设计:四类传感器 + 唤醒附一句 note + 冷却/次数上限/到期 + 一张总表。
 * 没借的是它的要害——`command` 传感器用 `child_process.exec` 按间隔执行任意 shell 行,
 * 而且注册入口是给模型的工具、源码里没有任何权限门(审计:docs/superpowers/research/
 * 审计-dsh-sentinel-2026-09-09.md)。**这里明确不做 command 类**:add() 只认四类,
 * 别的一律拒。这不是"暂时没做",是拍板不做,改这一条要先改决策记录。
 *
 * 边界(设计-借鉴功能落位与资产区 §二「哨兵」):
 * - **唤醒对象只有「人」**。触发产出一条 WorkbenchEvent 走现有会话/响铃通道
 *   (waiting + idle_prompt),黄点 + 事务官浮窗那一栏 + 一句 note。「叫 DSH 会话」
 *   要等 DSH 自家会话接入之后再议。
 * - **不新增常驻扫描器**。这里没有一根自己的 setInterval:tick() 由 http.ts 那根
 *   既有的 1 秒节拍调用,每个监视项自己的 interval_sec 决定这一拍要不要真去探。
 * - **探不到就如实记 error,绝不当成变化去触发**(D13)。半夜因为网线松了而响一次铃,
 *   比不响更糟。
 *
 * 落盘 ~/.dsh/workbench/sentinel.json,原子写 + 容错读(规格同 readMarks.ts/notes.ts)。
 * 基线(signature)跟着落盘:重启后同一份文件没变就不该凭空触发一次。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import type { SensorKind, SentinelWatch, WorkbenchEvent } from '../protocol.ts'
import { SENSOR_KINDS } from '../protocol.ts'

/** 探针失败时给人看的原因上限——错误原文可能很长,截一段就够定位。 */
const MAX_ERROR_CHARS = 120
/** http 传感器读多少正文头进指纹。够看出"页面变了",又不至于把整页存进磁盘。 */
export const HTTP_HEAD_CHARS = 200
/** 默认间隔 60 秒、冷却 600 秒(对齐 RING_COOLDOWN_SEC 的克制口径)。 */
const DEFAULT_INTERVAL_SEC = 60
const DEFAULT_COOLDOWN_SEC = 600
/** 间隔下限:比这更密就是在给自己造一个后台扫描器。 */
export const MIN_INTERVAL_SEC = 5

/** 四类传感器各自的探法。真实现在 defaultSentinelDeps,测试注入假的。 */
export interface SentinelDeps {
  /** 文件的 mtime 与大小;不存在返回 undefined(那本身是一种状态,不是错误)。 */
  statFile: (path: string) => Promise<{ mtime_ms: number, size: number } | undefined>
  /** 取一次 HTTP:状态码 + 正文头。连不上就抛,由上层记成 error。 */
  fetchHttp: (url: string) => Promise<{ status: number, head: string }>
  /** 跑一条命令。只用来跑 pgrep,模式由 Ben 填,不接受任意命令行(见文件头)。 */
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  probePort: (host: string, port: number, timeoutMs: number) => Promise<boolean>
}

/** 新增一条监视项时能填的东西。 */
export interface SentinelInput {
  kind: SensorKind
  target: string
  note: string
  interval_sec?: number
  cooldown_sec?: number
  max_fires?: number
  expires_at?: string
}

export interface SentinelService {
  /** 从磁盘装载。失败静默,当空表。 */
  load: () => Promise<void>
  /** 当前全部监视项(给 /state 看的视图,不含内部指纹)。 */
  list: () => readonly SentinelWatch[]
  add: (input: SentinelInput) => Promise<SentinelWatch>
  /** 取消一条。连同它那条会话一起收掉(返回一条 offline 事件),不留永远黄着的点。 */
  remove: (id: string) => Promise<{ ok: boolean, event?: WorkbenchEvent }>
  /** 走一拍:到点的监视项各探一次,返回这一拍触发的事件。 */
  tick: () => Promise<WorkbenchEvent[]>
  /** 把挂起的写落定——测试用;生产靠内部异步写。 */
  flush: () => Promise<void>
}

export interface SentinelOptions {
  file: string
  deps: SentinelDeps
  /** 当前 Unix 秒。默认 Date.now()/1000。 */
  now?: () => number
}

export function defaultSentinelFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/sentinel.json`
}

/** 落盘记录 = 视图 + 内部指纹。指纹不进 /state:它是给机器比对用的,不是给人看的。 */
interface WatchRecord extends SentinelWatch {
  signature?: string
}

interface SentinelFile { version: 1, watches: WatchRecord[] }

/** 这条监视项对应的会话主键。稳定不变:同一条监视项反复触发只更新同一行会话。 */
export function sentinelSessionId(id: string): string {
  return `sentinel:${id}`
}

function clip(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

/**
 * `host:port` 或光一个 `port`(默认 127.0.0.1)。解析不出来就 undefined,
 * 由调用方记成 error——不猜一个端口去连。
 */
export function parsePortTarget(target: string): { host: string, port: number } | undefined {
  const trimmed = target.trim()
  const at = trimmed.lastIndexOf(':')
  const host = at === -1 ? '127.0.0.1' : trimmed.slice(0, at)
  const portText = at === -1 ? trimmed : trimmed.slice(at + 1)
  const port = Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: host === '' ? '127.0.0.1' : host, port }
}

/** 一次探测的结果:要么读到了当下的状态,要么如实说没读到。 */
type Probe = { signature: string, detail: string } | { error: string }

async function probeWatch(watch: WatchRecord, deps: SentinelDeps): Promise<Probe> {
  try {
    if (watch.kind === 'file') {
      const stat = await deps.statFile(watch.target)
      if (stat === undefined) return { signature: 'missing', detail: '不存在' }
      return { signature: `${stat.mtime_ms}|${stat.size}`, detail: `${stat.size} 字节` }
    }
    if (watch.kind === 'http') {
      const reply = await deps.fetchHttp(watch.target)
      const head = reply.head.slice(0, HTTP_HEAD_CHARS)
      return { signature: `${reply.status}|${head}`, detail: `HTTP ${reply.status}` }
    }
    if (watch.kind === 'process') {
      // pgrep 的退出码就是答案:0=有匹配,1=没有。命令本身跑不起来也走这条(当没有),
      // 那和"进程不在"在界面上是同一件事——真要区分得靠 which pgrep,不值当。
      const result = await deps.runCommand(['pgrep', '-f', watch.target])
      const count = result.stdout.split('\n').filter(line => line.trim() !== '').length
      const running = result.ok && count > 0
      return { signature: running ? 'running' : 'gone', detail: running ? `在跑(${count} 个)` : '没在跑' }
    }
    const parsed = parsePortTarget(watch.target)
    if (parsed === undefined) return { error: `端口写法认不出:${clip(watch.target)}` }
    const open = await deps.probePort(parsed.host, parsed.port, 2000)
    return { signature: open ? 'open' : 'closed', detail: open ? '通' : '不通' }
  }
  catch (error) {
    return { error: clip(error instanceof Error ? error.message : String(error)) }
  }
}

function emptyFile(): SentinelFile {
  return { version: 1, watches: [] }
}

async function loadFile(file: string): Promise<SentinelFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyFile() // 第一次用本来就没有这个文件,不是错误。
  }
  try {
    const parsed = JSON.parse(text) as Partial<SentinelFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.watches)) return emptyFile()
    return { version: 1, watches: parsed.watches.filter(watch => typeof watch?.id === 'string') }
  }
  catch {
    return emptyFile() // 写坏了按空表兜底,先例见 notes.ts loadNotesFile。
  }
}

function validate(input: SentinelInput): void {
  if (!SENSOR_KINDS.includes(input.kind)) {
    // command 落在这里:审计结论是"这一类明确不做",错误里把话说清楚。
    throw new Error(`认不得的传感器类型:${String(input.kind)}(只有 file/http/process/port;command 类不做)`)
  }
  if (typeof input.target !== 'string' || input.target.trim() === '') {
    throw new Error('target 必须是非空字符串')
  }
  if (typeof input.note !== 'string' || input.note.trim() === '') {
    throw new Error('note 必须是非空字符串——触发时要对人说一句话')
  }
  if (input.max_fires !== undefined && (!Number.isInteger(input.max_fires) || input.max_fires <= 0)) {
    throw new Error('max_fires 必须是正整数')
  }
  if (input.expires_at !== undefined && Number.isNaN(Date.parse(input.expires_at))) {
    throw new Error('expires_at 必须是可解析的时间')
  }
}

export function createSentinelService(options: SentinelOptions): SentinelService {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const { deps } = options
  let watches: WatchRecord[] = []
  // 写队列:add/remove/tick 都会改状态,不排队会丢更新(先例见 notes.ts/scenes.ts)。
  let writeQueue: Promise<void> = Promise.resolve()
  // 单飞:tick 由 1 秒节拍调用,上一轮探针还没回来就跳过这一轮,不叠罗汉
  //(先例见 http.ts 的 runUsageRefresh 与 webLogin 的 captureInFlight)。
  let ticking = false

  async function save(): Promise<void> {
    const data: SentinelFile = { version: 1, watches }
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  function enqueueSave(): void {
    // 失败静默:退化成"这次重启后监视项没了",跟没落盘一样,不更糟(D13)。
    writeQueue = writeQueue.then(() => save()).catch(() => {})
  }

  /** 触发一次:记账 + 产出一条走现有通道的事件。 */
  function fire(watch: WatchRecord, change: string, nowSec: number): WorkbenchEvent {
    watch.fires += 1
    watch.last_fired_at = new Date(nowSec * 1000).toISOString()
    watch.last_change = change
    if (watch.max_fires !== undefined && watch.fires >= watch.max_fires) {
      watch.done = true
    }
    return {
      agent: 'dsh',
      session_id: sentinelSessionId(watch.id),
      project: '哨兵',
      type: 'waiting',
      // idle_prompt 而不是 permission_prompt:响铃判定(ring.ts)只让"等审批"响,
      // 哨兵不是审批。要它响铃就得谎称是审批——宁可不响,也不在会话数据里说假话。
      reason: 'idle_prompt',
      title: watch.note,
      summary: change,
      ts: nowSec,
    }
  }

  return {
    async load() {
      watches = (await loadFile(options.file)).watches
    },

    list() {
      // 指纹是内部比对用的,不进 /state。
      return watches.map(({ signature: _signature, ...view }) => view)
    },

    async add(input) {
      validate(input)
      const nowSec = now()
      const watch: WatchRecord = {
        id: randomUUID(),
        kind: input.kind,
        target: input.target.trim(),
        note: input.note.trim(),
        interval_sec: Math.max(MIN_INTERVAL_SEC, Math.floor(input.interval_sec ?? DEFAULT_INTERVAL_SEC)),
        cooldown_sec: Math.max(0, Math.floor(input.cooldown_sec ?? DEFAULT_COOLDOWN_SEC)),
        created_at: new Date(nowSec * 1000).toISOString(),
        fires: 0,
        ...(input.max_fires === undefined ? {} : { max_fires: input.max_fires }),
        ...(input.expires_at === undefined ? {} : { expires_at: new Date(input.expires_at).toISOString() }),
      }
      watches = [watch, ...watches]
      enqueueSave()
      const { signature: _signature, ...view } = watch
      return view
    },

    async remove(id) {
      const before = watches.length
      watches = watches.filter(watch => watch.id !== id)
      if (watches.length === before) return { ok: false } // 删不存在的:如实回,不抛
      enqueueSave()
      return {
        ok: true,
        // 收掉它那条会话:哨兵会话是这个监视项的投影,项没了,黄点不该还挂着。
        event: {
          agent: 'dsh',
          session_id: sentinelSessionId(id),
          type: 'offline',
          reason: 'offline',
          ts: now(),
        },
      }
    },

    async tick() {
      if (ticking) return []
      ticking = true
      const nowSec = now()
      const events: WorkbenchEvent[] = []
      let changed = false
      try {
        for (const watch of watches) {
          if (watch.done === true) continue
          if (watch.expires_at !== undefined && Date.parse(watch.expires_at) <= nowSec * 1000) {
            watch.done = true
            watch.last_change = '已到期,不再盯了'
            changed = true
            continue
          }
          const lastChecked = watch.last_checked_at === undefined
            ? undefined
            : Math.floor(Date.parse(watch.last_checked_at) / 1000)
          if (lastChecked !== undefined && nowSec - lastChecked < watch.interval_sec) continue

          const probe = await probeWatch(watch, deps)
          watch.last_checked_at = new Date(nowSec * 1000).toISOString()
          changed = true

          if ('error' in probe) {
            // 探不到就如实记,不动基线、不触发(D13)。下一拍还探不到就还是这句话。
            watch.error = probe.error
            continue
          }
          delete watch.error

          const previous = watch.signature
          const previousDetail = watch.last_change
          watch.signature = probe.signature
          if (previous === undefined) {
            // 第一拍只建基线:刚加上的监视项不该立刻报一次"变了"。
            watch.last_change = `刚开始盯 · ${probe.detail}`
            continue
          }
          if (previous === probe.signature) continue

          const inCooldown = watch.last_fired_at !== undefined
            && nowSec - Math.floor(Date.parse(watch.last_fired_at) / 1000) < watch.cooldown_sec
          if (inCooldown) {
            // 冷却里的变化只记不喊——记下来是为了让人回头看得见发生过什么。
            watch.last_change = `${probe.detail}(冷却中,没喊)`
            continue
          }
          const from = previousDetail === undefined ? '上次' : previousDetail.replace(/^刚开始盯 · /, '')
          events.push(fire(watch, `${from} → ${probe.detail}`, nowSec))
        }
      }
      finally {
        ticking = false
      }
      if (changed) enqueueSave()
      return events
    },

    async flush() {
      await writeQueue
    },
  }
}

/**
 * 生产用的四个探针。全部**只读**:stat 一个文件、GET 一次 URL、pgrep 一次、连一次 TCP 端口。
 *
 * 三条刻意为之的边界:
 * - **不发凭据**。http 探针只发一个裸 GET,不带 Cookie/Authorization——哨兵盯的是
 *   "这个地址的回应变没变",不是"以我的身份去取数"(AGENTS.md:凭据不进任何出口)。
 * - **只跑 pgrep**。process 探针把 Ben 填的字符串当作 pgrep 的**参数**传进 execFile 风格的
 *   数组,不拼 shell 行——这正是不装 dsh-sentinel 的那一条(它的 command 类是
 *   `exec(任意 shell 行)`)在我们这边的反面做法。
 * - **都有超时**。文件之外的三类都可能挂住(网络黑洞、端口 DROP),超时到点就当"这次没读到"。
 */
export function defaultSentinelDeps(
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>,
  fetchImpl: typeof fetch = globalThis.fetch,
): SentinelDeps {
  return {
    async statFile(path) {
      try {
        const info = await stat(path)
        return { mtime_ms: Math.floor(info.mtimeMs), size: info.size }
      }
      catch {
        return undefined // 不存在/没权限:当"不存在"这一种状态,它本身就是要盯的东西之一。
      }
    },

    async fetchHttp(url) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' })
        const body = await res.text()
        return { status: res.status, head: body.slice(0, HTTP_HEAD_CHARS) }
      }
      finally {
        clearTimeout(timer)
      }
    },

    runCommand,

    probePort(host, port, timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port })
        const finish = (open: boolean): void => {
          socket.removeAllListeners()
          socket.destroy()
          resolve(open)
        }
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
      })
    },
  }
}
