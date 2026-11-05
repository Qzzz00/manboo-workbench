/**
 * ★ **同事项执行持久租约**(2026-10-26,卡「事务官机制D」t-ea3ba424)。
 *
 * 治 10-26 14:36 的真实事故:同一张卡、同一棵工作树,正常派发两次,起来了**两个** Kimi
 * 进程(1892 / 1961,同一秒);其中一个 06:50 拿着**中途文本**说 done,原生轮次却跑到 07:19 —
 * 期间任何一路都能再派第二遍。根子:派发链上没有任何「这张卡/这棵树此刻有作者」的**持久**事实,
 * 只有按家互斥(窗口手)和内存里的 sending 幂等。
 *
 * 这一份是最小持久租约:
 *   - **双键**:同 `task_id` 或同 `cwd`(工作树)已有活跃租约 → 拒,给出 holder 真身
 *     (task / family / run_id / pid / claimed_at —— 精确归属,不靠家名猜);
 *   - **串行队列 + JSON 落盘**:两个并发 dispatch 只有一个赢家(先落盘者),重启之后新进程
 *     照同一份文件继续拒 —— 租约随文件走,不随 PID 走;
 *   - **release 精确认领**:必须带 `run_id` 或 `pid`,对不上 = `stale-run` 不动 ——
 *     迟到的旧进程退出摘不动新租约;
 *   - **不确定性保留**:只剩「pid 没了」时不释放(`markUncertain`)—— 不凭进程号消失
 *     就重新派;同一张卡的人点重派(takeover)才换租约,别的卡同树仍拒;
 *   - 释放只在**真终态证据**上记:进程退出(exit 回调 / pid 对上的收尾)、没起来、到顶被停、
     她取消了这张卡(`canceled_by_user`,2026-10-28 任务书「取消要收场执行者」)。
 *
 * 只存最近 {@link EXECUTION_LEASE_KEEP} 条(含已释放的 —— 那是审计 trail)。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 释放一条租约的终态证据(谁证明它结束了)。 */
export type LeaseReleaseEvidence = 'process-exit' | 'process-failed' | 'stopped-cap' | 'not-started' | 'canceled_by_user'

/** 一条租约(活跃或已释放)。 */
export interface ExecutionLease {
  task_id: string
  /** 工作树身份:写代码的活 = 独立工作区 / 仓库目录。 */
  cwd: string
  family: string
  /** 这一派的唯一号:release 按它精确认领(迟到的旧回调对不上 = 摘不动)。 */
  run_id: string
  /** 原生进程号(attachPid 补上;命令行手才有)。 */
  pid?: number
  claimed_at: string
  state: 'active' | 'released'
  /** 只剩「pid 没了」这一格证据:不释放,标不确定 —— 不凭进程号消失就重派。 */
  uncertain?: boolean
  release?: { at: string, evidence: LeaseReleaseEvidence, code?: number | null }
}

export interface LeaseClaimInput {
  taskId: string
  cwd: string
  family: string
  runId: string
  at: string
  /**
   * 同卡人来重派(takeover):holder 是**这张卡自己**且标了不确定、进程也没活着的证据时,
   * 人的这一次明确决定允许换租约;别卡同树永远不许。调用方(派发器)负责核这两个前提。
   */
  takeover?: boolean
}

export type LeaseClaimResult = { ok: true, lease: ExecutionLease } | { ok: false, holder: ExecutionLease } | { ok: false, unreadable: string }

export interface ExecutionLeaseStore {
  claim: (input: LeaseClaimInput) => Promise<LeaseClaimResult>
  /** 进程号补上(命令行手送成那一刻)。 */
  attachPid: (input: { taskId: string, runId: string, pid: number }) => Promise<void>
  /** 真终态证据上释放;身份(run_id 或 pid)对不上 = stale-run,一条不动。 */
  release: (input: { taskId: string, runId?: string | undefined, pid?: number | undefined, evidence: LeaseReleaseEvidence, code?: number | null, at: string }) => Promise<{ ok: true, lease: ExecutionLease } | { ok: false, why: 'stale-run' }>
  /** 只剩「pid 没了」:标不确定,不释放。 */
  markUncertain: (input: { taskId: string, runId: string }) => Promise<void>
  activeForTask: (taskId: string) => Promise<ExecutionLease | undefined>
  activeForCwd: (cwd: string) => Promise<ExecutionLease | undefined>
}

/** 落盘保留多少条(含已释放的审计 trail)。 */
export const EXECUTION_LEASE_KEEP = 200

/** 生产落点(与 client-keys 台账同一个目录、同一种「本机状态文件」)。 */
export function defaultExecutionLeaseFile(): string {
  return join(homedir(), '.dsh', 'workbench', 'execution-leases.json')
}

interface LeaseFileShape { leases: ExecutionLease[] }

function sanitizeLease(raw: unknown): ExecutionLease | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as Record<string, unknown>
  if (typeof one.task_id !== 'string' || typeof one.cwd !== 'string' || typeof one.family !== 'string'
    || typeof one.run_id !== 'string' || typeof one.claimed_at !== 'string') return undefined
  if (one.state !== 'active' && one.state !== 'released') return undefined
  const lease: ExecutionLease = {
    task_id: one.task_id, cwd: one.cwd, family: one.family, run_id: one.run_id,
    claimed_at: one.claimed_at, state: one.state,
  }
  if (typeof one.pid === 'number') lease.pid = one.pid
  if (one.uncertain === true) lease.uncertain = true
  if (typeof one.release === 'object' && one.release !== null) {
    const r = one.release as Record<string, unknown>
    if (typeof r.at === 'string' && typeof r.evidence === 'string'
      && ['process-exit', 'process-failed', 'stopped-cap', 'not-started', 'canceled_by_user'].includes(r.evidence)) {
      lease.release = { at: r.at, evidence: r.evidence as LeaseReleaseEvidence, ...(typeof r.code === 'number' || r.code === null ? { code: r.code as number | null } : {}) }
    }
  }
  return lease
}

type LeaseRead = { ok: true, leases: ExecutionLease[] } | { ok: false, why: string }

/**
 * 读租约文件。**ENOENT = 还没有租约(空)**;其余一切读不动/坏 JSON/形状不对/有认不出的条目,
 * 一律回「读不清 + 为什么」(2026-10-26 合流返工缺口 1)——绝不当作「没有租约」放行:
 * 丢一条活跃锁 = 同一个工作区里冒出第二个写者,正是这张卡要治的病。半截文件、有人正写到一半
 * (非原子写)也都落在「读不清」里,宁可拒发由人看。
 */
function readLeases(file: string): LeaseRead {
  let raw: string
  try { raw = readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return { ok: true, leases: [] }
    return { ok: false, why: `读不动(${(error as Error).message})` }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (error) { return { ok: false, why: `文件不是整的 JSON(${(error as Error).message})` } }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as LeaseFileShape).leases)) {
    return { ok: false, why: '形状不对(没有 leases 数组)' }
  }
  const out: ExecutionLease[] = []
  for (const one of (parsed as LeaseFileShape).leases) {
    const lease = sanitizeLease(one)
    if (lease === undefined) return { ok: false, why: '里有认不出的条目(形状半截)' }
    out.push(lease)
  }
  return { ok: true, leases: out }
}

/** 原子写:先写临时文件再改名 —— 永远不给读方留下半截 JSON(缺口 1 的另一半)。 */
function writeLeases(file: string, leases: readonly ExecutionLease[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, `${JSON.stringify({ leases }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 裁剪(缺口 2):**活跃锁一条不裁** —— 只裁已释放的审计 trail,留最近 {@link EXECUTION_LEASE_KEEP} 条。
 * 从前「取最后 200 条」会把长活的活跃锁挤掉:先占 A,再来 200 个别卡短活结束,A 的锁就没了。
 */
function trimLeases(leases: readonly ExecutionLease[]): ExecutionLease[] {
  const active = leases.filter(one => one.state === 'active')
  const released = leases.filter(one => one.state === 'released').slice(-EXECUTION_LEASE_KEEP)
  return [...leases.filter(one => one.state !== 'active' && one.state !== 'released'), ...active, ...released]
}

export function createExecutionLeaseStore(opts: { file?: string, now?: () => Date } = {}): ExecutionLeaseStore {
  const file = opts.file ?? defaultExecutionLeaseFile()
  // 串行队列:claim/release 的全部判定(读-判-写)合成一段,并发请求只有一个赢家。
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => T): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  function holderFor(leases: readonly ExecutionLease[], taskId: string, cwd: string): ExecutionLease | undefined {
    return leases.find(one => one.state === 'active' && one.task_id === taskId)
      ?? leases.find(one => one.state === 'active' && one.cwd === cwd)
  }

  return {
    claim(input) {
      return serial(() => {
        const read = readLeases(file)
        // 读不清 → 拒发(缺口 1):宁可不派,不许第二个写者。
        if (!read.ok) return { ok: false as const, unreadable: read.why }
        const leases = read.leases
        const holder = holderFor(leases, input.taskId, input.cwd)
        if (holder !== undefined) {
          const takeoverOk = input.takeover === true && holder.task_id === input.taskId
          if (!takeoverOk) return { ok: false as const, holder }
          // 同卡人来重派:旧租约补一条释放记录(证据=被接管),再立新租约 —— trail 不断。
          const index = leases.findIndex(one => one === holder)
          leases[index] = {
            ...holder, state: 'released' as const,
            release: { at: input.at, evidence: 'not-started' as const },
          }
        }
        const lease: ExecutionLease = {
          task_id: input.taskId, cwd: input.cwd, family: input.family,
          run_id: input.runId, claimed_at: input.at, state: 'active',
        }
        writeLeases(file, trimLeases([...leases, lease]))
        return { ok: true as const, lease }
      })
    },
    attachPid(input) {
      return serial(() => {
        const read = readLeases(file)
        if (!read.ok) return
        const leases = read.leases
        const index = leases.findIndex(one => one.state === 'active' && one.task_id === input.taskId && one.run_id === input.runId)
        if (index < 0) return
        leases[index] = { ...leases[index] as ExecutionLease, pid: input.pid }
        writeLeases(file, leases)
      })
    },
    release(input) {
      return serial(() => {
        const read = readLeases(file)
        // 读不清 → 拒(缺口 1):拿不到账就不动账,迟到的旧回调也不能借「读不清」洗新锁。
        if (!read.ok) return { ok: false as const, why: 'stale-run' as const }
        const leases = read.leases
        const index = leases.findIndex(one => one.state === 'active' && one.task_id === input.taskId)
        if (index < 0) return { ok: false as const, why: 'stale-run' as const }
        const lease = leases[index] as ExecutionLease
        // 精确认领:**给了 run_id 它就是权威**——必须匹配,且同时给的 pid 也要一致
        // (PID 会被系统重用:旧 runId + 重用的 pid 不许把新租约救走);attachPid 没补上
        // pid 的旧实现,只带 run_id 照常能放。没带 run_id 才退回 pid 认领(重启巡检路)。
        const match = input.runId !== undefined
          ? lease.run_id === input.runId && (input.pid === undefined || lease.pid === undefined || lease.pid === input.pid)
          : input.pid !== undefined && lease.pid === input.pid
        if (!match) return { ok: false as const, why: 'stale-run' as const }
        const released: ExecutionLease = {
          ...lease, state: 'released',
          release: { at: input.at, evidence: input.evidence, ...(input.code === undefined ? {} : { code: input.code }) },
        }
        leases[index] = released
        writeLeases(file, leases)
        return { ok: true as const, lease: released }
      })
    },
    markUncertain(input) {
      return serial(() => {
        const read = readLeases(file)
        if (!read.ok) return
        const leases = read.leases
        const index = leases.findIndex(one => one.state === 'active' && one.task_id === input.taskId && one.run_id === input.runId)
        if (index < 0) return
        leases[index] = { ...leases[index] as ExecutionLease, uncertain: true }
        writeLeases(file, leases)
      })
    },
    activeForTask(taskId) {
      return serial(() => {
        const read = readLeases(file)
        return read.ok ? read.leases.find(one => one.state === 'active' && one.task_id === taskId) : undefined
      })
    },
    activeForCwd(cwd) {
      return serial(() => {
        const read = readLeases(file)
        return read.ok ? read.leases.find(one => one.state === 'active' && one.cwd === cwd) : undefined
      })
    },
  }
}
