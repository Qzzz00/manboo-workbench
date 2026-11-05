/**
 * 起新工人前先收上一轮的(2026-10-10,通话组件孤儿进程)。
 *
 * 工人是工作台的非 detached 子进程。发版 / 闸用 `launchctl kickstart -k` 硬杀工作台时,
 * 工人收不到 SIGTERM,被过继给 1 号进程活下来,带着旧代码、用同一个身份 `wb-channel-worker`
 * 留在房间里,和新起的那一个互相踢(10-10 现场:三个孤儿,手机走房间那条路连不上)。
 * 工人那一侧也会自己看父进程退出(channel-worker/src/lifeline.ts);这里是另一头的保险。
 *
 * **只收认得出的**:
 *   - 进程号文件里记的那个:命令行确是 `channel-worker/src/main.ts`,父进程是 1 或不是这个工作台;
 *   - 没有进程号文件的(升级前那一代留下的):父进程是 1、命令行是 **这个 DSH_HOME 下**的工人。
 * 别的 node 进程、仓库里开发起的工人、自己的子进程一概不碰。
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 工人入口在命令行里的样子。 */
export const CHANNEL_WORKER_MAIN_MARK = 'channel-worker/src/main.ts'

/** SIGTERM 之后等多久再 SIGKILL。比工人自己的退出时限(lifeline.ts 的 2.5 秒)长一点。 */
export const REAP_TERM_GRACE_MS = 4000
const REAP_POLL_MS = 200
const REAP_KILL_WAIT_MS = 1000

/** 两条工人(卡 M6)各记各的:本机房间那条沿用老名字,云房间那条带 `-relay`(同日志的分法)。 */
export function defaultChannelWorkerPidFile(env: Record<string, string | undefined> = process.env, route?: 'lan' | 'relay'): string {
  return `${dshHomeOf(env)}/workbench/channel-worker${route === 'relay' ? '-relay' : ''}.pid`
}

export function dshHomeOf(env: Record<string, string | undefined> = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : `${env.HOME ?? ''}/.dsh`
}

export interface ProcessRow { pid: number, ppid: number, command: string }

/** 读 `ps -axo pid=,ppid=,command=` 的输出。 */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: (match[3] as string).trim() })
  }
  return rows
}

export function staleChannelWorkers(input: {
  recorded?: number
  procs: ProcessRow[]
  selfPid: number
  dshHome: string
}): number[] {
  const out: number[] = []
  const add = (pid: number): void => {
    if (pid !== input.selfPid && !out.includes(pid)) out.push(pid)
  }
  if (input.recorded !== undefined) {
    const row = input.procs.find(p => p.pid === input.recorded)
    if (row !== undefined && row.command.includes(CHANNEL_WORKER_MAIN_MARK) && (row.ppid === 1 || row.ppid !== input.selfPid)) add(row.pid)
  }
  const ours = `${input.dshHome}/${CHANNEL_WORKER_MAIN_MARK}`
  for (const row of input.procs) {
    if (row.ppid === 1 && row.command.includes(ours)) add(row.pid)
  }
  return out
}

export interface ChannelWorkerReaper {
  /** 收掉上一轮留下的;回收到了哪几个。出什么错都不抛 —— 收不了也照样起新的。 */
  reap: () => Promise<number[]>
  /** 记下这一轮工人的进程号。 */
  record: (pid: number) => Promise<void>
}

export interface ChannelWorkerReaperDeps {
  pidFile: string
  dshHome: string
  selfPid?: number
  listProcesses?: () => Promise<ProcessRow[]>
  kill?: (pid: number, signal: NodeJS.Signals) => void
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

function defaultListProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(parseProcessTable(stdout))
    })
  })
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export function createChannelWorkerReaper(deps: ChannelWorkerReaperDeps): ChannelWorkerReaper {
  const selfPid = deps.selfPid ?? process.pid
  const listProcesses = deps.listProcesses ?? defaultListProcesses
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  const isAlive = deps.isAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? (ms => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const log = deps.log ?? (() => {})

  async function readRecorded(): Promise<number | undefined> {
    try {
      const raw = (await readFile(deps.pidFile, 'utf8')).trim()
      if (!/^\d+$/.test(raw)) return undefined
      const pid = Number(raw)
      return pid > 1 ? pid : undefined
    }
    catch {
      return undefined
    }
  }

  function signal(pid: number, sig: NodeJS.Signals): void {
    try { kill(pid, sig) }
    catch { /* 已经走了 */ }
  }

  return {
    async reap() {
      let procs: ProcessRow[]
      try {
        procs = await listProcesses()
      }
      catch (err) {
        log(`[channel-worker] 取不到进程表,这次不收上一轮的工人:${(err as Error)?.message ?? String(err)}`)
        return []
      }
      const recorded = await readRecorded()
      const targets = staleChannelWorkers({ ...(recorded === undefined ? {} : { recorded }), procs, selfPid, dshHome: deps.dshHome })
      if (targets.length === 0) return []
      log(`[channel-worker] 上一轮留下的工人还在(进程 ${targets.join('、')}),先收掉再起新的`)
      for (const pid of targets) signal(pid, 'SIGTERM')
      let waited = 0
      while (waited < REAP_TERM_GRACE_MS && targets.some(pid => isAlive(pid))) {
        await sleep(REAP_POLL_MS)
        waited += REAP_POLL_MS
      }
      const stubborn = targets.filter(pid => isAlive(pid))
      if (stubborn.length > 0) {
        log(`[channel-worker] 进程 ${stubborn.join('、')} 收到 SIGTERM ${REAP_TERM_GRACE_MS / 1000} 秒还没退,SIGKILL`)
        for (const pid of stubborn) signal(pid, 'SIGKILL')
        // SIGKILL 之后进程还要片刻才真正消失;等它走了新工人再进房,免得最后再踢一次。
        let killWaited = 0
        while (killWaited < REAP_KILL_WAIT_MS && stubborn.some(pid => isAlive(pid))) {
          await sleep(REAP_POLL_MS)
          killWaited += REAP_POLL_MS
        }
      }
      return targets
    },

    async record(pid) {
      try {
        await mkdir(dirname(deps.pidFile), { recursive: true })
        await writeFile(deps.pidFile, `${pid}\n`)
      }
      catch (err) {
        log(`[channel-worker] 记不下进程号(不影响这一轮):${(err as Error)?.message ?? String(err)}`)
      }
    },
  }
}
