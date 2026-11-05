/**
 * 工人跟着工作台活、跟着工作台走(2026-10-10,通话组件孤儿进程)。
 *
 * 工人是工作台的非 detached 子进程。工作台正常退出时会 SIGTERM 它;但发版 / 闸用
 * `launchctl kickstart -k` 硬杀工作台时,工人被过继给 1 号进程活下来,带着旧代码、用同一个身份
 * `wb-channel-worker` 留在房间里,和新工作台起的那一个互相踢 —— 手机走房间那条路就连不上了。
 * 所以两件事:
 *   1. **定时看父进程**:被过继给 1 号、父进程号变了、或工作台传进来的那个号不在了 → 离开房间、退出;
 *   2. **退出有时限**:收场(`session.close` / `room.disconnect`)没有自己的超时,挂住就永远不退
 *      —— 那几个孤儿收到 SIGTERM 不走,多半就卡在这里。到点不管收没收完都退。
 *
 * 工作台那一侧(起新工人前先收上一轮的)见 workbench-plugin/src/server/channelWorkerReap.ts。
 */

/** 多久看一次父进程。发现得慢一点不要紧,新工作台起新工人前还会先收一遍。 */
export const PARENT_CHECK_MS = 5000

/**
 * 收到退出信号后最多等多久就硬退。比工作台那边「SIGTERM 后等一会儿再 SIGKILL」短,
 * 让它尽量自己体面地走。
 */
export const EXIT_DEADLINE_MS = 2500

/** 工作台把自己的进程号放在这里传进来。 */
export const PARENT_PID_ENV = 'WORKBENCH_CHANNEL_PARENT_PID'

export function parentPidOf(env: Record<string, string | undefined>): number | undefined {
  const raw = env[PARENT_PID_ENV]?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return undefined
  const pid = Number(raw)
  return pid > 1 ? pid : undefined
}

export interface ParentState {
  /** 启动时的父进程号。 */
  startPpid: number
  /** 现在的父进程号。 */
  ppid: number
  /** 工作台传进来的进程号(启动脚本 exec 之后通常就等于 startPpid)。 */
  expected?: number
  expectedAlive?: boolean
}

export function parentGone(state: ParentState): boolean {
  // 一开始就挂在 1 号下面的(将来 launchd 拉起、手动 nohup)不按「过继」算。
  if (state.startPpid !== 1 && state.ppid === 1) return true
  if (state.ppid !== state.startPpid) return true
  if (state.expected !== undefined && state.expectedAlive === false) return true
  return false
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    // EPERM:进程在,只是不归我们管。
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export interface ParentWatchDeps {
  readPpid?: () => number
  isAlive?: (pid: number) => boolean
  expected?: number
  every?: (ms: number, run: () => void) => () => void
  onGone: (reason: string) => void
}

export function createParentWatch(deps: ParentWatchDeps): { start: () => void, stop: () => void } {
  const readPpid = deps.readPpid ?? (() => process.ppid)
  const isAlive = deps.isAlive ?? isPidAlive
  const every = deps.every ?? ((ms, run) => {
    const timer = setInterval(run, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  })
  const startPpid = readPpid()
  let cancel: (() => void) | undefined
  let fired = false

  function check(): void {
    if (fired) return
    const ppid = readPpid()
    const expectedAlive = deps.expected === undefined ? undefined : isAlive(deps.expected)
    const state: ParentState = {
      startPpid,
      ppid,
      ...(deps.expected === undefined ? {} : { expected: deps.expected }),
      ...(expectedAlive === undefined ? {} : { expectedAlive }),
    }
    if (!parentGone(state)) return
    fired = true
    cancel?.()
    cancel = undefined
    const watched = deps.expected ?? startPpid
    deps.onGone(`工作台(进程 ${watched})不在了(现在的父进程 ${ppid}),这个工人不该再留在房间里`)
  }

  return {
    start() {
      if (cancel !== undefined || fired) return
      cancel = every(PARENT_CHECK_MS, check)
    },
    stop() {
      cancel?.()
      cancel = undefined
    },
  }
}

export interface ShutdownDeps {
  /** 离开房间那些收场。可能挂住,所以有时限。 */
  close: () => Promise<void>
  exit?: (code: number) => void
  after?: (ms: number, run: () => void) => void
  log?: (line: string) => void
}

/** 返回「退出」函数。第一次:收场 + 时限;再喊一次:当场退。 */
export function createShutdown(deps: ShutdownDeps): (reason: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  // 不 unref:收场挂住时事件循环可能还被原生句柄占着,这一下必须能响。
  const after = deps.after ?? ((ms: number, run: () => void) => { setTimeout(run, ms) })
  const log = deps.log ?? ((line: string) => console.log(line))
  let started = false
  let done = false
  const finish = (code: number): void => {
    if (done) return
    done = true
    exit(code)
  }
  return (reason) => {
    if (started) {
      log(`[channel-worker] 又收到一次退出(${reason}),不等了`)
      finish(1)
      return
    }
    started = true
    log(`[channel-worker] 要退出了(${reason}),正在离开房间……`)
    after(EXIT_DEADLINE_MS, () => {
      log(`[channel-worker] ${EXIT_DEADLINE_MS / 1000} 秒还没收完,直接退出`)
      finish(1)
    })
    void (async () => {
      try { await deps.close() }
      catch (err) { log(`[channel-worker] 收场出错(照样退出):${(err as Error)?.message ?? String(err)}`) }
      finish(0)
    })()
  }
}
