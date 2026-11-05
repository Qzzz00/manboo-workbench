// @vitest-environment node
/**
 * 交回核验与退修的第二批洞(2026-10-28,任务书「交回核验与退修的第二批洞」)——
 * 真机两张卡红出来的:
 *   t-a5cea106:小K回执里的测试命令按仓库规矩带 `taskpolicy -c utility` 前缀,白名单只认
 *     npx / npm / node… 的 basename → 三条「用例 / 测试」类条件全回「核不了:这条命令不敢代跑」;
 *   t-b82dadb0:三条条件是用例描述(「第一次取代码超时 → 状态是『重试中』文案…」),决定性门要求
 *     条件引号里的 UI 字逐字出现在回执里 → 全判「缺」→ 退修 round 2;退修重派又被租约挡
 *     (「进程状态读不准」,进程 2 秒前刚 ended)→ 换手候选表第一家还是原手 → 两次都没派出去。
 * 这一份钉三个洞:
 *   洞5 `safeTestCommand` 剥 `taskpolicy -c <utility|background>` 再按白名单核,代跑原样带前缀跑;
 *   洞6 分到 test 类(有「用例 / 测试 / →」)且代跑通过的条件,以代跑结果为准,引号里的 UI 字
 *     不在回执里不再判「缺」;没命令 → unknown 留人,不退修;
 *   洞7 上一轮派发记录已 ended(run_id 对得上卡上 runtime.attempt_id)→ 租约视为已放手,退修
 *     重派派得出去;换手候选去掉与原手同一家(候选表可能重复列同一家),没有别家 → 留言
 *     「没有别家可换」,不把「没派给 X」写两遍。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  artifactKindOf,
  createArtifactCheckDeps,
  reworkResendNote,
  safeTestCommand,
  testSpawnArgv,
  verifyAcceptance,
  type ArtifactCheckDeps,
} from '../src/server/dispatchVerify.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import { createExecutionLeaseStore } from '../src/server/executionLease.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-holes2-'))
  dirs.push(dir)
  return dir
}

/** 全部产物核都照替身说的过的 deps;用例逐个覆盖。 */
const stubArtifacts = (over: Partial<ArtifactCheckDeps>): ArtifactCheckDeps => ({
  readFile: async () => undefined,
  differs: async () => undefined,
  runTest: async () => undefined,
  knownPath: async () => true,
  matchByName: async () => undefined,
  // 任务书第 5 条(1029)的 diff 代跑兜底:默认「git 核不动」(老用例的行为一格不动)。
  changedTestFiles: async () => undefined,
  ...over,
})

describe('洞5 代跑命令认 taskpolicy 规矩前缀', () => {
  it('safeTestCommand:taskpolicy -c utility / background 剥掉前缀按白名单核,原样返回带前缀的 argv', () => {
    expect(safeTestCommand('taskpolicy -c utility npx vitest run tests/x.test.ts --maxWorkers 1'))
      .toEqual(['taskpolicy', '-c', 'utility', 'npx', 'vitest', 'run', 'tests/x.test.ts', '--maxWorkers', '1'])
    expect(safeTestCommand('taskpolicy -c background npm test')).toEqual(['taskpolicy', '-c', 'background', 'npm', 'test'])
  })

  it('safeTestCommand:不认得的 class / 剥完不是白名单 / 只有前缀没命令 → 仍拒(不敢代跑)', () => {
    // class 只认 utility / background:foo 不认 → 前缀不剥,bin=taskpolicy 不在白名单。
    expect(safeTestCommand('taskpolicy -c foo rm -rf')).toBeUndefined()
    // 前缀合法但剥完是 rm:不在代跑白名单。
    expect(safeTestCommand('taskpolicy -c utility rm -rf x')).toBeUndefined()
    // 只有前缀没有真命令。
    expect(safeTestCommand('taskpolicy -c utility')).toBeUndefined()
  })

  it('testSpawnArgv:回执自己带了前缀 → 实际执行原样带前缀;没带由这台机器补上;没有 taskpolicy 退回直跑', () => {
    // 真机红例那条命令:代跑真正起的 argv 带前缀,逐字不动。
    expect(testSpawnArgv(['taskpolicy', '-c', 'utility', 'npx', 'vitest', 'run', 'tests/x.test.ts', '--maxWorkers', '1'], true))
      .toEqual({ bin: 'taskpolicy', args: ['-c', 'utility', 'npx', 'vitest', 'run', 'tests/x.test.ts', '--maxWorkers', '1'] })
    // 没有 taskpolicy 的机器(非 macOS):退回直跑剥掉前缀的命令。
    expect(testSpawnArgv(['taskpolicy', '-c', 'utility', 'npx', 'vitest'], false))
      .toEqual({ bin: 'npx', args: ['vitest'] })
    // 回执没带前缀:有 taskpolicy 的机器按他的规矩补上 -c utility。
    expect(testSpawnArgv(['npx', 'vitest'], true))
      .toEqual({ bin: 'taskpolicy', args: ['-c', 'utility', 'npx', 'vitest'] })
    expect(testSpawnArgv(['npx', 'vitest'], false)).toEqual({ bin: 'npx', args: ['vitest'] })
    expect(testSpawnArgv([], true)).toBeUndefined()
  })

  it('runTest 真代跑带前缀的命令:允许且执行通过', async () => {
    const deps = createArtifactCheckDeps()
    // 无害命令:只证明带规矩前缀的命令进得了代跑、真起得来(机器没有 taskpolicy 时这层退回直跑)。
    expect(await deps.runTest(temp(), 'taskpolicy -c utility node --version')).toBe('pass')
    // 对照:不带前缀的老命令照样跑(这台机器补上前缀)。
    expect(await deps.runTest(temp(), 'node --version')).toBe('pass')
  })
})

describe('洞6 用例描述式条件按代跑核,不按逐字门', () => {
  it('artifactKindOf:带「→」的用例描述式条件分到 test 类', () => {
    expect(artifactKindOf('第一次取代码超时 → 状态是「重试中」文案')).toBe('test')
    expect(artifactKindOf('重试用尽 → failed + 「再试一次」键可用')).toBe('test')
  })

  const input = {
    acceptance: ['第一次取代码超时 → 状态是「重试中」文案'],
    // 回执里**没有**「重试中」这几个字(UI 字不出现在回执里正是这批洞的真机形状)。
    receipt: '做完了:超时与重试两条用例都补了,定向代跑全部通过。',
    title: '用户层重试',
  }
  const command = 'npx vitest run tests/retry.test.ts --maxWorkers 1'
  const judged = (artifact: string): string => `{"items":[{"condition":"第一次取代码超时 → 状态是「重试中」文案","met":true,"evidence":"超时与重试两条用例都补了","artifact":${artifact}}]}`

  it('★回执带通过的测试命令 → 通过,不因「重试中」没在回执里而判缺(真机 t-b82dadb0 红例)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judged(`{"kind":"test","command":"${command}"}`),
      artifacts: stubArtifacts({ runTest: async (_ws, cmd) => cmd === command ? 'pass' : 'fail' }),
    })
    expect(got).toEqual({ verdict: 'pass' })
  })

  it('没给测试命令 → unknown 留人,不退修(fail)', async () => {
    // 判词里干脆没给产物凭据。
    const noArtifact = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => '{"items":[{"condition":"第一次取代码超时 → 状态是「重试中」文案","met":true,"evidence":"超时与重试两条用例都补了"}]}',
      artifacts: stubArtifacts({}),
    })
    expect(noArtifact).toMatchObject({ verdict: 'unknown' })
    // 给了命令但不敢代跑(不在白名单)→ 一样 unknown。
    const refused = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judged('{"kind":"test","command":"git push --force"}'),
      artifacts: stubArtifacts({ runTest: async () => undefined }),
    })
    expect(refused).toMatchObject({ verdict: 'unknown' })
  })

  it('对照:代跑没通过 → 不过(代跑结果说了算,方向两个都一样)', async () => {
    const got = await verifyAcceptance({ ...input, workspace: '/ws/x' }, {
      askModel: async () => judged(`{"kind":"test","command":"${command}"}`),
      artifacts: stubArtifacts({ runTest: async () => 'fail' }),
    })
    expect(got).toMatchObject({ verdict: 'fail' })
  })
})

describe('洞7 换手留言:去掉与原手同一家的候选', () => {
  const base = {
    who: '小K',
    family: 'kimi',
    resendNote: '没派给小K:这张卡从 2026-10-28T09:00:00 起被 Kimi 接着(第 ab12cd34 号)占着,而它的进程状态读不准 —— 不凭进程号消失就重复派',
  }

  it('★候选表 [kimi, kimi] 与原手 kimi → 一句「没有别家可换」,「没派给」不重复两段', async () => {
    let tried = 0
    const note = await reworkResendNote({
      ...base,
      alternatives: [{ family: 'kimi', title: '小K' }, { family: 'kimi', title: '小K(窗口那只手)' }],
      tryAlt: async () => { tried += 1; return { ok: false } },
    })
    expect(note).toContain('没有别家可换')
    expect(note).toContain('退修没派出去:')
    expect(note.match(/没派给/gu) ?? []).toHaveLength(1)
    expect(tried).toBe(0)
  })

  it('有别家且换成功 → 照原话式:「退修没派给 X,换 Y 去改了」', async () => {
    const tried: string[] = []
    const note = await reworkResendNote({
      ...base,
      alternatives: [{ family: 'kimi', title: '小K' }, { family: 'codex', title: 'Codex' }],
      tryAlt: async (family) => { tried.push(family); return { ok: true } },
    })
    expect(note).toContain('退修没派给 小K,换 Codex 去改了')
    expect(tried).toEqual(['codex'])
  })

  it('别家也派不出去 → 「退修没派出去:…;换一家也没派出去:…」;同一家多只手的候选只试一次', async () => {
    const tried: string[] = []
    const note = await reworkResendNote({
      ...base,
      alternatives: [{ family: 'codex', title: 'Codex' }, { family: 'codex', title: 'Codex(第二只手)' }, { family: 'claude', title: 'Claude' }],
      tryAlt: async (family) => { tried.push(family); return { ok: false, note: `没派给${family}(替身挡)` } },
    })
    expect(note).toContain('退修没派出去:')
    expect(note).toContain('换一家也没派出去:')
    expect(note).not.toContain('没有别家可换')
    expect(tried).toEqual(['codex', 'claude'])
  })
})

/* ── 洞7 上半:租约认 ended —— 派发器层,假送话手 + 真任务账 + 真租约文件(与 20261026 那份同款) ── */

interface Proc {
  pid: number
  outputFile: string
  exited: Promise<{ code: number }>
  resolve: (outcome: { code: number }) => void
}

interface LeaseRig {
  runner: ReturnType<typeof createDispatchRunner>
  tasks: ReturnType<typeof createTasksService>
  lease: ReturnType<typeof createExecutionLeaseStore>
  sends: string[]
  procs: Map<number, Proc>
  outputs: Map<string, string>
  dispatch: (taskId: string, cwd?: string) => Promise<{ ok: boolean, note: string }>
}

const NOW_SEC = Math.floor(Date.parse('2026-10-28T09:00:00.000Z') / 1000)

function leaseRig(): LeaseRig {
  const dir = temp()
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${Math.random().toString(36).slice(2, 9)}` })
  const lease = createExecutionLeaseStore({ file: join(dir, 'leases.json') })
  const sends: string[] = []
  const procs = new Map<number, Proc>()
  const outputs = new Map<string, string>()
  let nextPid = 8200
  const clientDispatch = {
    send: async () => {
      sends.push('send')
      let resolve!: (outcome: { code: number }) => void
      const exited = new Promise<{ code: number }>((res) => { resolve = res })
      const pid = nextPid++
      const outputFile = join(dir, `out-${pid}`)
      procs.set(pid, { pid, outputFile, exited, resolve })
      return { ok: true, result: { via: 'cli', process: { pid, output_file: outputFile, exited } } }
    },
  } as unknown as ClientDispatch
  const runner = createDispatchRunner({
    tasks,
    clientDispatch,
    lease,
    readFile: async (file) => outputs.get(file),
    alive: () => false,
    sessions: () => [],
    now: () => new Date(NOW_SEC * 1000),
    pollMs: 60_000,
  })
  return {
    runner, tasks, lease, sends, procs, outputs,
    dispatch: async (taskId, cwd = '/wt/holes2') => {
      const r = await runner.start(taskId, { family: 'codex', said: '把这件事办了', kind: 'code', cwd })
      return { ok: r.ok, note: r.note }
    },
  }
}

/** 终态:进程退出(exit-observed),输出带交卷的话 → 收尾写 dispatch.status done 并放锁。 */
async function exitDelivered(r: LeaseRig, pid: number): Promise<void> {
  const proc = r.procs.get(pid)
  if (proc === undefined) throw new Error(`no proc ${pid}`)
  r.outputs.set(proc.outputFile, '做完了:第一轮交卷')
  r.outputs.set(`${proc.outputFile}.jsonl`, '{"type":"turn.completed"}')
  proc.resolve({ code: 0 })
  await proc.exited
  // exit 回调是微任务挂链:让 finishCli 跑完。
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('洞7 租约认 ended:上一轮收场后锁还没放,退修重派照派', () => {
  it('★上一轮 done、锁还在(run_id 对得上)→ 重派派得出去,新进程真起来(真机 t-b82dadb0 红例)', async () => {
    const r = leaseRig()
    const id = (await r.tasks.create({ title: '退修那一件', status: 'doing' })).id as string
    expect((await r.dispatch(id)).ok).toBe(true)
    const pid1 = [...r.procs.keys()][0] as number
    // 第一轮收场:交卷 + 进程退出 → 卡上 dispatch.status done,锁正常放掉。
    await exitDelivered(r, pid1)
    let card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('done')
    // 真机那一下:收尾的释放丢了(退出回调迟到 / 被旧回调拒),锁还挂着 —— 把已收场那一轮的锁原样种回去。
    const endedAttempt = card.dispatch?.runtime?.attempt_id as string
    expect(endedAttempt).toBeTruthy()
    const planted = await r.lease.claim({ taskId: id, cwd: '/wt/holes2', family: 'codex', runId: endedAttempt, at: new Date(NOW_SEC * 1000).toISOString() })
    expect(planted.ok).toBe(true)
    // 2 秒之后(真机时序)退修重派:租约认 ended,不再按进程表判「读不准」→ 派得出去。
    const again = await r.dispatch(id)
    expect(again.ok).toBe(true)
    expect(r.sends).toHaveLength(2)
    card = (await r.tasks.list()).tasks.find(one => one.id === id)!
    expect(card.dispatch?.status).toBe('running')
  })

  it('对照:挂着的锁对不上已收场那一轮(run_id 不同)→ 照旧拒,不猜、不抢', async () => {
    const r = leaseRig()
    const id = (await r.tasks.create({ title: '退修那一件', status: 'doing' })).id as string
    expect((await r.dispatch(id)).ok).toBe(true)
    const pid1 = [...r.procs.keys()][0] as number
    await exitDelivered(r, pid1)
    // 一把**别的**轮次留下的锁(对不上卡上 runtime.attempt_id):不能凭「上一轮 done」放它。
    const planted = await r.lease.claim({ taskId: id, cwd: '/wt/holes2', family: 'codex', runId: 'r-别的轮次', at: new Date(NOW_SEC * 1000).toISOString() })
    expect(planted.ok).toBe(true)
    const again = await r.dispatch(id)
    expect(again.ok).toBe(false)
    expect(again.note).toMatch(/读不准|不重复派/u)
    // 锁原样挂着。
    const held = await r.lease.activeForTask(id)
    expect(held?.run_id).toBe('r-别的轮次')
  })
})
