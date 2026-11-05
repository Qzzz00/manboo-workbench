/**
 * 「事务官工人」(仓库根目录 channel-worker/)的**常驻**那一层(2026-09-17)。
 *
 * 工人是一条独立生命周期的长驻进程,像 butler-server 一样跑在插件旁边。原型阶段只能手工
 * `node src/main.ts` 起 —— 这个文件把它变成「工作台起来就在、崩了自己回来」。
 *
 * ## 启动方式与 butler-server 同一套
 *
 * butler-server 的规矩是:插件 `POST /butler/start` → `~/.dsh/bin/butler-start`(Ben 自己装的
 * 一行脚本,里头写死他那台机器的 node 路径与仓库位置)。工人照抄:`~/.dsh/bin/channel-start`,
 * 脚本内容在仓库 `deploy/channel-start`,Ben 自己 cp 过去。
 *
 * **为什么脚本在 `~/.dsh/bin/` 而不是插件里直接 spawn 仓库里的 main.ts**:插件最后是 tsdown
 * 打成单文件装进 `~/.dsh` 运行时的,它**不知道仓库在哪**,也不该知道 —— 仓库路径是 Ben 那台机器
 * 的事。脚本是两边的接缝:插件只认「`~/.dsh/bin/channel-start` 这个名字」,路径全在脚本里。
 *
 * ## 和 butler-server 不一样的那一点:重启归谁管
 *
 * butler-server 有 launchd 项(`ai.deepseek.butler`),崩了 launchd 拉。工人**没有装 launchd**
 * (这张卡不许碰 `~/.dsh`),所以「崩了自动拉起」只能由这里做:子进程不 detach,退出事件这边收得到,
 * 按退避重来,有上限。代价写清楚:**插件重载/退出会带走工人**(dispose 里 SIGTERM)。
 * 这是故意的 —— 宁可跟着插件走,也不要出现「上一份插件留下的孤儿工人」和新插件抢同一个房间身份
 * (identity 是固定的 `wb-channel-worker`,两份会互相踢)。要真正脱离插件,下一步给它装 launchd 项,
 * 那时这一层只剩 `launchctl kickstart`,和 butler.ts 一模一样。
 *
 * ## 纪律
 *
 * - 日志落文件(`~/.dsh/workbench/logs/channel-worker.log`),**不进 /state、不进回包**;
 *   工人自己就不打密钥(channel-worker/src/config.ts 顶部),这边也不往它的环境里塞任何密钥 ——
 *   LiveKit 的 key/secret 只在 server/channel.ts 里签 JWT 时出现,工人拿的是签好的一次性凭证。
 * - 拉不起来就如实回一句能照着做的话,**不假装成功**(同 butler.ts)。
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChannelRoute } from './channel.ts'
import type { ChannelWorkerReaper } from './channelWorkerReap.ts'

/** 启动脚本的位置。与 `~/.dsh/bin/butler-start` 同一个目录、同一套规矩。 */
export function defaultChannelStartScript(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/bin/channel-start`
}

/**
 * 工人的日志。工作台的数据目录下单开一个 logs/,和 tasks.json 那些放一起但不混在一层。
 * 两条工人(卡 M6)各一份:本机房间那条沿用老名字(局域网是主路),云房间那条带 `-relay`。
 */
export function defaultChannelWorkerLogFile(home = process.env.HOME ?? '', route?: ChannelRoute): string {
  return `${home}/.dsh/workbench/logs/channel-worker${route === 'relay' ? '-relay' : ''}.log`
}

/**
 * 退避梯子(毫秒)。第 n 次连续失败等 `RESTART_BACKOFF_MS[min(n, len-1)]`。
 * 头两次快 —— 最常见的「崩了一下」值得马上回来;越往后越慢,免得把一个起不来的进程刷成日志风暴。
 */
export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000, 60_000]

/** 连续拉起多少次还不行就不再拉。**有上限**:一直重试等于把「它起不来」这件事藏起来。 */
export const MAX_CONSECUTIVE_RESTARTS = 8

/**
 * 撞了上限、停手之后,多久自己再试一次(2026-09-30,止血第 5 条)。
 *
 * **放弃不该是永久的**:起不来的原因常常是一会儿就好的(凭证还没从服务器取回来、网卡刚换、
 * 磁盘忙)。原来一放弃就再也不拉,而那一刻手机与座机从此打不进来,本机界面上只是通话那一格灰了 ——
 * 没人会想到去点一下「起」。冷却 10 分钟再从头数一轮:既不刷日志,也不把人锁死。
 */
export const RETRY_COOLDOWN_MS = 10 * 60_000

/** 活过这么久就算「这一轮是好的」,连续失败计数清零。 */
export const HEALTHY_UPTIME_MS = 60_000

/** 日志超过这个大小就在下次启动时截断。长跑几个月不该把磁盘吃掉。 */
export const LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * `stop()` 发完 SIGTERM 之后等它真的退多久。等一下的理由只有一个:不等的话回给界面的那份
 * 状态里 `running` 还是 true(SIGTERM 是异步的),Ben 点了「停」却看见「在跑」。
 * 等不到就如实回 running: true —— **不假装它停了**。
 */
export const STOP_GRACE_MS = 2000

export const LAUNCHING_NOTE = '正在起'

export interface ChannelWorkerExit {
  code?: number
  signal?: string
  at: string
}

/** `GET /channel/worker` 与 `/channel/status.process` 回的那一份。**没有任何密钥、没有日志内容**。 */
export interface ChannelWorkerView {
  running: boolean
  pid?: number
  /** 还会不会自动拉起。手动停过、或撞了上限,就是 false。 */
  supervising: boolean
  /** 连续拉起了几次(活够 HEALTHY_UPTIME_MS 就清零)。 */
  restarts: number
  /** 撞了上限停手之后,什么时候自己再试一次(ISO)。不在冷却里就缺席。 */
  retry_at?: string
  script: string
  log_file: string
  started_at?: string
  last_exit?: ChannelWorkerExit
  /** 一句人话。正常在跑时缺席。 */
  note?: string
  /** 一条路线一条工人时(卡 M6,`channelWorkerFleet.ts`)每条各自的样子。只有一个看护时缺席。 */
  routes?: readonly ChannelWorkerRouteView[]
}

/** 一条路线那条工人的样子:它自己那份看护状态 + 是哪条路线、进的哪一间。 */
export interface ChannelWorkerRouteView extends Omit<ChannelWorkerView, 'routes'> {
  route: ChannelRoute
  /** 这条路线此刻(上一次对过的)要进的那间房。 */
  room?: string
}

export interface ChannelWorkerActionResult { ok: boolean, note?: string, error?: string }

export interface ChannelWorkerService {
  view: () => ChannelWorkerView
  start: () => Promise<ChannelWorkerActionResult>
  stop: () => Promise<ChannelWorkerActionResult>
  /** 插件退出时调:停掉工人、不再拉起。 */
  dispose: () => Promise<void>
}

/** 起一个子进程要的最少能力。测试注入一个假的,不真 spawn。 */
export interface SpawnedWorker {
  pid?: number
  kill: (signal: NodeJS.Signals) => void
  /** 进程退出时调一次。 */
  onExit: (handler: (exit: { code: number | null, signal: NodeJS.Signals | null }) => void) => void
  /** spawn 本身就失败(文件没执行位之类)时调一次。 */
  onError: (handler: (err: Error) => void) => void
}

export interface ChannelWorkerServiceDeps {
  /** `~/.dsh/bin/channel-start`。 */
  script?: string
  logFile?: string
  /** 传给脚本的环境变量(在 process.env 之上加)。这里**只放地址,不放密钥**。 */
  env?: Record<string, string>
  spawnImpl?: (input: { script: string, env: Record<string, string>, logFd?: number }) => SpawnedWorker
  /** 脚本在不在。缺省 fs.stat。 */
  scriptExists?: (script: string) => Promise<boolean>
  /** 开日志文件,返回 fd;开不了返回 undefined(照样起,只是没日志)。缺省真开。 */
  openLog?: (file: string) => Promise<number | undefined>
  now?: () => number
  /** 定时器。测试注入。返回一个「取消」函数。 */
  schedule?: (ms: number, run: () => void) => () => void
  log?: (line: string) => void
  /**
   * 崩了又要被拉起来的时候喊一声(2026-09-22,自动上报里那一类 `crash_restart`)。
   *
   * **只在"还要再拉"和"不拉了"这两个时刻喊**,不在每次退出时喊 —— 用户自己点停、
   * 插件 dispose 带走它,那都不是故障。喊的时候连着最近几行日志一起给:
   * 工人的日志是它自己写的,插件这边拿不到内容,所以这里只给"日志在哪",
   * 由上报那一头决定要不要去读(见 diagnostics/report.ts:**不替它猜哪份日志相关**)。
   *
   * 接线在 index.ts;不接就整条缺席(既有那一批用例一行都不用改)。
   */
  /**
   * 起新工人前先收上一轮留下的孤儿、起了之后记进程号(2026-10-10,见 channelWorkerReap.ts)。
   * 不接就不收 —— 用例与旁路工作台不碰真进程表。
   */
  reaper?: Pick<ChannelWorkerReaper, 'reap' | 'record'>
  /** 这个工作台的进程号,传给工人(WORKBENCH_CHANNEL_PARENT_PID),让它看得出工作台没了。缺省 process.pid。 */
  selfPid?: number
  onCrash?: (event: { restarts: number, giving_up: boolean, note: string, log_file: string, exit: { code?: number, signal?: string } }) => void
}

async function defaultScriptExists(script: string): Promise<boolean> {
  try {
    const info = await stat(script)
    return info.isFile()
  }
  catch {
    return false
  }
}

async function defaultOpenLog(file: string): Promise<number | undefined> {
  try {
    await mkdir(dirname(file), { recursive: true })
    // 长跑几个月的日志不该把磁盘吃掉:超了就从头写(不做多份轮转——一份够查昨天的事)。
    try {
      const info = await stat(file)
      if (info.size > LOG_MAX_BYTES) await truncate(file, 0)
    }
    catch { /* 还没有这个文件,下面 'a' 会建 */ }
    return openSync(file, 'a')
  }
  catch {
    return undefined
  }
}

function defaultSpawn(input: { script: string, env: Record<string, string>, logFd?: number }): SpawnedWorker {
  const out = input.logFd ?? 'ignore'
  const child = spawn(input.script, [], {
    // **不 detach**:退出事件这边要收得到,不然「崩了自动拉起」无从谈起(文件头有完整理由)。
    detached: false,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...input.env },
  })
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill: (signal) => { try { child.kill(signal) } catch { /* 已经没了 */ } },
    onExit: handler => child.on('exit', (code, signal) => handler({ code, signal })),
    onError: handler => child.on('error', handler),
  }
}

export function createChannelWorkerService(deps: ChannelWorkerServiceDeps = {}): ChannelWorkerService {
  const script = deps.script ?? defaultChannelStartScript()
  const logFile = deps.logFile ?? defaultChannelWorkerLogFile()
  const env = deps.env ?? {}
  const spawnImpl = deps.spawnImpl ?? defaultSpawn
  const scriptExists = deps.scriptExists ?? defaultScriptExists
  const openLog = deps.openLog ?? defaultOpenLog
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((ms, run) => {
    const timer = setTimeout(run, ms)
    // 拉起工人的定时器不该把 Node 钉在事件循环里(插件退出时还等它)。
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const log = deps.log ?? (() => {})
  const selfPid = deps.selfPid ?? process.pid

  let child: SpawnedWorker | undefined
  let startedAt: number | undefined
  let restarts = 0
  /** 想不想让它跑。stop() 与撞上限都会把它按回 false —— 它是「自动拉起」的总开关。 */
  let wanted = false
  let cancelPending: (() => void) | undefined
  let lastExit: ChannelWorkerExit | undefined
  /** 冷却到期那一刻(ms)。undefined = 没在冷却里。 */
  let retryAt: number | undefined
  let note: string | undefined
  let logFd: number | undefined
  let disposed = false
  /** 当前这个子进程退出时兑现。stop() 等它(最多 STOP_GRACE_MS)。 */
  let exited: (() => void) | undefined
  let whenExited: Promise<void> | undefined
  /** 正在拉起(收孤儿最多等几秒)。这期间再 start 不起第二个。 */
  let launching = false

  function iso(at: number): string {
    return new Date(at).toISOString()
  }

  function closeLog(): void {
    if (logFd === undefined) return
    try { closeSync(logFd) } catch { /* 关不掉也不值得报 */ }
    logFd = undefined
  }

  /** 真去起一个。**不管 wanted**:调用方负责。 */
  async function launch(): Promise<ChannelWorkerActionResult> {
    if (launching) return { ok: true, note: LAUNCHING_NOTE }
    launching = true
    try {
      return await launchOnce()
    }
    finally {
      launching = false
    }
  }

  async function launchOnce(): Promise<ChannelWorkerActionResult> {
    if (!await scriptExists(script)) {
      note = `找不到 ${script}:把仓库里的 deploy/channel-start 拷过去并 chmod +x`
      return { ok: false, error: note }
    }
    // kickstart -k 硬杀工作台时工人会被过继给 1 号活下来,和新工人抢同一个房间身份:先收掉。
    if (deps.reaper !== undefined) await deps.reaper.reap()
    if (disposed) return { ok: false, error: '工作台正在退出,这会儿不起工人' }
    if (logFd === undefined) logFd = await openLog(logFile)
    let spawned: SpawnedWorker
    try {
      spawned = spawnImpl({ script, env: { ...env, WORKBENCH_CHANNEL_PARENT_PID: String(selfPid) }, ...(logFd === undefined ? {} : { logFd }) })
    }
    catch (err) {
      note = `起不来:${(err as Error)?.message ?? '没说原因'}`
      return { ok: false, error: note }
    }
    child = spawned
    startedAt = now()
    note = undefined
    whenExited = new Promise<void>((resolve) => { exited = resolve })
    log(`[channel-worker] 起了(pid ${spawned.pid ?? '?'}),日志在 ${logFile}`)

    spawned.onError((err) => {
      // spawn 本身失败(没执行位、路径不是可执行文件)。exit 也会跟着来,这里只记一句原因。
      note = `拉起 ${script} 失败:${err.message}`
      log(`[channel-worker] ${note}`)
    })
    spawned.onExit(({ code, signal }) => {
      if (child !== spawned) return // 已经被换掉了(stop 之后又 start),这条退出不算数
      const at = now()
      const upFor = startedAt === undefined ? 0 : at - startedAt
      child = undefined
      startedAt = undefined
      exited?.()
      exited = undefined
      lastExit = {
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
        at: iso(at),
      }
      if (!wanted) {
        log('[channel-worker] 停了(是我们让它停的)')
        closeLog()
        return
      }
      // 活够久就算这一轮是好的:连续失败计数清零,下次崩了还是从最短的退避重来。
      if (upFor >= HEALTHY_UPTIME_MS) restarts = 0
      if (restarts >= MAX_CONSECUTIVE_RESTARTS) {
        wanted = false
        const cooldownMinutes = Math.round(RETRY_COOLDOWN_MS / 60_000)
        note = `连着拉起 ${MAX_CONSECUTIVE_RESTARTS} 次都没活过 ${Math.round(HEALTHY_UPTIME_MS / 1000)} 秒,不再自动拉了;${cooldownMinutes} 分钟后再试一次——看 ${logFile}`
        log(`[channel-worker] ${note}`)
        /*
         * ★ 2026-09-30(止血第 5 条):停手,但**不是永久的**。冷却到了就从头数一轮 ——
         * 起不来的原因常常是一会儿就好的(凭证还没取回来、网卡刚换)。
         * 这个约用的是同一个 cancelPending:他中途自己点「停」/「起」,或者插件 dispose,都当场作废。
         */
        retryAt = at + RETRY_COOLDOWN_MS
        cancelPending = schedule(RETRY_COOLDOWN_MS, () => {
          cancelPending = undefined
          retryAt = undefined
          if (disposed || wanted || child !== undefined) return
          restarts = 0
          wanted = true
          note = undefined
          log('[channel-worker] 冷却到了,再试一次')
          void launch()
        })
        // 放弃这一刻最该让远处的人知道:手机从此打不进来,而本机界面上只是通话那一格灰了。
        deps.onCrash?.({
          restarts, giving_up: true, note, log_file: logFile,
          exit: { ...(code === null ? {} : { code }), ...(signal === null ? {} : { signal }) },
        })
        closeLog()
        return
      }
      const wait = RESTART_BACKOFF_MS[Math.min(restarts, RESTART_BACKOFF_MS.length - 1)] as number
      restarts += 1
      note = `工人退了(${signal ?? `code ${code ?? '?'}`}),${Math.round(wait / 1000)} 秒后第 ${restarts} 次拉起`
      log(`[channel-worker] ${note}`)
      deps.onCrash?.({
        restarts, giving_up: false, note, log_file: logFile,
        exit: { ...(code === null ? {} : { code }), ...(signal === null ? {} : { signal }) },
      })
      cancelPending = schedule(wait, () => {
        cancelPending = undefined
        if (!wanted || disposed) return
        void launch()
      })
    })
    if (spawned.pid !== undefined && deps.reaper !== undefined) await deps.reaper.record(spawned.pid)
    return { ok: true }
  }

  return {
    view() {
      return {
        running: child !== undefined,
        ...(child?.pid === undefined ? {} : { pid: child.pid }),
        supervising: wanted,
        restarts,
        script,
        log_file: logFile,
        ...(startedAt === undefined ? {} : { started_at: iso(startedAt) }),
        ...(lastExit === undefined ? {} : { last_exit: lastExit }),
        ...(retryAt === undefined ? {} : { retry_at: iso(retryAt) }),
        ...(note === undefined ? {} : { note }),
      }
    },

    async start() {
      if (disposed) return { ok: false, error: '工作台正在退出,这会儿不起工人' }
      if (child !== undefined) return { ok: true, note: '本来就在跑' }
      if (launching) return { ok: true, note: LAUNCHING_NOTE }
      // 手动 start 等于「重新开始数」:上一轮撞了上限也从头来,不然 Ben 点一下没反应。
      restarts = 0
      wanted = true
      cancelPending?.()
      cancelPending = undefined
      retryAt = undefined
      return launch()
    },

    async stop() {
      wanted = false
      cancelPending?.()
      cancelPending = undefined
      // 他自己点了「停」:那个「10 分钟后再试」的约当场作废。
      retryAt = undefined
      if (child === undefined) {
        closeLog()
        return { ok: true, note: '本来就没在跑' }
      }
      child.kill('SIGTERM')
      // 等它真的退,最多 STOP_GRACE_MS。等不到就回去,view() 里 running 仍是 true(如实)。
      const waited = whenExited
      if (waited !== undefined) {
        await Promise.race([waited, new Promise<void>((resolve) => { schedule(STOP_GRACE_MS, resolve) })])
      }
      return child === undefined ? { ok: true } : { ok: true, note: '发了 SIGTERM,它还没退干净' }
    },

    async dispose() {
      disposed = true
      wanted = false
      cancelPending?.()
      cancelPending = undefined
      retryAt = undefined
      child?.kill('SIGTERM')
      child = undefined
      closeLog()
    },
  }
}
