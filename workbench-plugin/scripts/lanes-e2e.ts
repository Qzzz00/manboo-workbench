/**
 * ★ **派活按家隔离:本机两家窗口型真跑**(2026-10-21,卡「派活按家隔离」第 6 条验收)。
 *
 * 不装、不重启 DSH、不碰 `~/.dsh`:真的引擎 + 真的窗口适配器 + 真的派活巡检 + 每家一条通道 + 闸 + 账,
 * 只把「壳」换成用本分支 Swift 源码现编的探针(`workbench-app/probe-send-text.sh op …`,调壳 `runOp` 那同一批函数),
 * 看板、账、闸都落在一个临时目录。同 `demo-chain-e2e.ts` 的做法。
 *
 * 用法(先编好探针:`PROBE_APP=<.app> zsh workbench-app/probe-send-text.sh apps`):
 *   PROBE_APP=<.app> node scripts/lanes-e2e.ts isolate <目录> [--stop]   任一家卡死 60 秒内别家照常 + 重置这一家
 *   PROBE_APP=<.app> node scripts/lanes-e2e.ts crash <目录>               送到一半被 kill -9 再起,不丢不重
 *
 * 「卡死」两种:缺省是**壳那一侧堵住**(那一家的每一下 op 都不回 —— 等同壳的读队被一个慢读占着);
 * `--stop` 是真把那家 App 挂起(`kill -STOP`,跑完一定 `kill -CONT`)。
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createActionGate, createGateFileStore } from '../src/server/actionGate.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { createEngineWiring } from '../src/server/engine/wire.ts'
import { createFamilyLanes } from '../src/server/familyLanes.ts'
import { resetFamily } from '../src/server/familyReset.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createTasksService } from '../src/server/tasks.ts'

const mode = process.argv[2] ?? 'isolate'
const root = process.argv[3] ?? '/tmp/lanes-e2e'
const stopMode = process.argv.includes('--stop')
mkdirSync(root, { recursive: true })
const probe = join(dirname(new URL(import.meta.url).pathname), '../../workbench-app/probe-send-text.sh')
const t0 = Date.now()
const log = (...parts: unknown[]): void => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${parts.map(String).join(' ')}`
  console.log(line)
  appendFileSync(join(root, 'run.log'), `${new Date().toISOString()} ${mode} ${line}\n`)
}

/** 两家窗口型(本机装着、探针放行)。 */
const FAMILIES: readonly DispatchTarget[] = [
  { id: 'doubao', title: '豆包', bundle_id: 'com.bot.pc.doubao', hands: ['window'] },
  { id: 'kimi', title: 'Kimi', bundle_id: 'com.moonshot.kimichat', hands: ['window'] },
]
const HUNG = 'doubao'
const OTHER = 'kimi'
const bundleOf = (family: string): string | undefined => FAMILIES.find(one => one.id === family)?.bundle_id
const familyOfBundle = (bundle: unknown): string | undefined => FAMILIES.find(one => one.bundle_id === bundle)?.id

/** 那一家此刻「卡死」了没有(壳那一侧堵住的模拟:op 一个都不回)。 */
const hung = new Set<string>()

function probeOp(req: HelperRequest): Promise<Record<string, unknown>> {
  const allow = FAMILIES.flatMap(one => ['--allow', one.bundle_id as string])
  appendFileSync(join(root, 'ops.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, op: req.op, bundle_id: (req as { bundle_id?: string }).bundle_id })}\n`)
  return new Promise((resolve, reject) => {
    execFile('zsh', [probe, 'op', JSON.stringify(req), ...allow], { env: process.env, maxBuffer: 16 << 20 }, (error, stdout) => {
      const at = stdout.indexOf('{')
      if (at < 0) { reject(error ?? new Error(`探针没回 JSON:${stdout.slice(0, 200)}`)); return }
      try {
        const out = JSON.parse(stdout.slice(at)) as Record<string, unknown>
        if (out.ok === false) reject(new Error(String(out.error ?? '壳回了失败')))
        else resolve((out.result ?? out) as Record<string, unknown>)
      }
      catch (e) { reject(e) }
    })
  })
}

const helper = {
  connected: () => true,
  supports: (cap: string) => ['read_reply', 'agent_read', 'new_conversation', 'save_draft', 'agent_press'].includes(cap),
  request: async (req: HelperRequest, timeoutMs = 10_000): Promise<Record<string, unknown>> => {
    const family = familyOfBundle((req as { bundle_id?: string }).bundle_id)
    if (family !== undefined && hung.has(family)) return await new Promise(() => {})
    return await Promise.race([
      probeOp(req),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('壳响应超时')), timeoutMs).unref() }),
    ])
  },
}

/** 与生产 `openAgentApp` 同一只手:`open -b`(叫到前面;零窗口的 App 靠它把窗开回来)。 */
const openB = (bundle: string): Promise<{ ok: boolean }> =>
  new Promise(resolve => execFile('open', ['-b', bundle], e => resolve({ ok: e === null })))

function world() {
  const now = (): Date => new Date()
  const jobLog = createJobLog({ now, file: join(root, 'jobs.jsonl'), warn: () => {} })
  const gate = createActionGate({ phaseOf: () => 'open', log: jobLog, now, store: createGateFileStore(join(root, 'action-gate.json')) })
  const lanes = createFamilyLanes({ now, name: f => FAMILIES.find(one => one.id === f)?.title ?? f, onJam: jam => log(`  ⚠ 判堵:${jam.family} ${jam.step} ${jam.waitedMs}ms`) })
  const wiring = createEngineWiring({
    gate,
    log: jobLog,
    lanes,
    name: f => FAMILIES.find(one => one.id === f)?.title ?? f,
    warn: line => log('  账', line),
    window: {
      helper,
      bundleOf,
      installed: family => (bundleOf(family) === undefined ? undefined : [{ bundle_id: bundleOf(family) as string, running: true }]),
      nameOf: f => FAMILIES.find(one => one.id === f)?.title ?? f,
      openApp: openB,
      bringToFront: openB,
      // 框里她没发出去的字:与生产同一档(壳读出来、送完放回去),原文另存一份在本目录(不覆盖她的东西)。
      saveDraft: async (input) => {
        const path = join(root, `draft-${Date.now()}.txt`)
        appendFileSync(path, input.text)
        return { ok: true, path }
      },
      draftNote: input => `框里那段字存到了 ${input.saved.path ?? '?'}${input.returned ? ',已放回' : ''}`,
      gate,
      gateJobOf: job => (job.itemId ?? job.id),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now,
    },
  })
  const tasks = createTasksService({ file: join(root, 'tasks.json') })
  const clientDispatch = createClientDispatch({ engine: wiring.engine, sessionIdsOf: () => [], targets: () => FAMILIES, now })
  const runner = createDispatchRunner({
    tasks,
    engine: wiring.engine,
    clientDispatch,
    jobLog,
    readFile: async () => undefined,
    sessions: () => [],
    now,
    targets: () => FAMILIES,
    exclusive: () => true,
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  })
  return { tasks, runner, lanes, gate, jobLog, wiring }
}

const ASK = (n: string): string => `这是工作台派活通道的一次自测(${n}),不用做任何事,只回复两个字:收到`

async function waitCard(w: ReturnType<typeof world>, id: string, ok: (status: string) => boolean, label: string, limitMs: number): Promise<number> {
  const start = Date.now()
  for (;;) {
    const task = (await w.tasks.list()).tasks.find(one => one.id === id)
    if (task !== undefined && ok(task.status)) { log(`  ✓ ${label}:${task.status},${((Date.now() - start) / 1000).toFixed(1)}s;note=${task.note ?? ''};lane=${task.dispatch_lane?.note ?? ''}`); return Date.now() - start }
    if (Date.now() - start > limitMs) { log(`  ✗ ${label}:等了 ${limitMs / 1000}s 还是 ${task?.status};note=${task?.note ?? ''};lane=${task?.dispatch_lane?.note ?? ''};reply_state=${task?.client_dispatch?.reply_state}`); return -1 }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function pidOf(bundle: string): Promise<number | undefined> {
  return await new Promise(resolve => execFile('lsappinfo', ['info', '-only', 'pid', '-app', bundle], (_e, out) => {
    const m = /"pid"=(\d+)/.exec(out)
    resolve(m === null ? undefined : Number(m[1]))
  }))
}

async function isolate(): Promise<void> {
  const w = world()
  log(`== 1. 两家各派一件(${HUNG} / ${OTHER}),都收回来 ==`)
  const a = (await w.tasks.create({ title: `自测 ${HUNG} 一`, direction: 'mine', status: 'todo' })).id as string
  const b = (await w.tasks.create({ title: `自测 ${OTHER} 一`, direction: 'mine', status: 'todo' })).id as string
  const [sa, sb] = await Promise.all([
    w.runner.start(a, { family: HUNG, said: ASK('1a') }),
    w.runner.start(b, { family: OTHER, said: ASK('1b') }),
  ])
  log('  送:', HUNG, sa.note, '|', OTHER, sb.note)
  await Promise.all([
    waitCard(w, a, s => s !== 'doing' && s !== 'todo', `${HUNG} 收回`, 180_000),
    waitCard(w, b, s => s !== 'doing' && s !== 'todo', `${OTHER} 收回`, 180_000),
  ])

  log(`== 2. ${HUNG} 卡死(${stopMode ? 'kill -STOP' : '壳那一侧堵住'}),同时给它派一件、给 ${OTHER} 派一件 ==`)
  let stoppedPid: number | undefined
  if (stopMode) {
    stoppedPid = await pidOf(bundleOf(HUNG) as string)
    if (stoppedPid !== undefined) { process.kill(stoppedPid, 'SIGSTOP'); log(`  挂起 ${HUNG} pid ${stoppedPid}`) }
  }
  else hung.add(HUNG)
  const restore = (): void => { if (stoppedPid !== undefined) { try { process.kill(stoppedPid, 'SIGCONT') } catch { /* 已经不在 */ } } }
  process.on('exit', restore)
  const c = (await w.tasks.create({ title: `自测 ${HUNG} 二(卡死时)`, direction: 'mine', status: 'todo' })).id as string
  const d = (await w.tasks.create({ title: `自测 ${OTHER} 二(${HUNG} 卡死时)`, direction: 'mine', status: 'todo' })).id as string
  const hungAt = Date.now()
  void w.runner.start(c, { family: HUNG, said: ASK('2c') }).then(r => log(`  ${HUNG} 那一件结局:${r.note}`))
  const sd = await w.runner.start(d, { family: OTHER, said: ASK('2d') })
  log(`  ${OTHER} 送出:${((Date.now() - hungAt) / 1000).toFixed(1)}s,${sd.note}`)
  const otherMs = await waitCard(w, d, s => s !== 'doing' && s !== 'todo', `${HUNG} 卡死期间 ${OTHER} 收回`, 120_000)
  log(`  ★ 验收「任一家卡死 60 秒内别家派活照常」:${OTHER} 从派到收回 ${otherMs < 0 ? '没收回' : `${((Date.now() - hungAt) / 1000).toFixed(1)}s`}`)
  log(`  ${HUNG} 通道:${JSON.stringify(w.lanes.view(HUNG))}`)

  log(`== 3. 重置 ${HUNG},它能再接活;期间 ${OTHER} 不受影响 ==`)
  restore(); stoppedPid = undefined
  hung.delete(HUNG)
  const e = (await w.tasks.create({ title: `自测 ${OTHER} 三(重置期间)`, direction: 'mine', status: 'todo' })).id as string
  void w.runner.start(e, { family: OTHER, said: ASK('3e') })
  const resetAt = Date.now()
  const reset = await resetFamily({
    lanes: w.lanes, gate: w.gate, jobLog: w.jobLog, name: f => FAMILIES.find(one => one.id === f)?.title ?? f,
    now: () => new Date(), packagesOf: f => [bundleOf(f) as string], openApp: openB,
    tasks: { list: async () => await w.tasks.list(), update: async (id, patch) => await w.tasks.update(id, patch) },
  }, HUNG)
  log(`  重置:${((Date.now() - resetAt) / 1000).toFixed(1)}s,${reset.note}`)
  await waitCard(w, c, s => s !== 'doing' && s !== 'todo', `重置后 ${HUNG} 那一件(卡死时派的)`, 240_000)
  const f = (await w.tasks.create({ title: `自测 ${HUNG} 四(重置后)`, direction: 'mine', status: 'todo' })).id as string
  await w.runner.start(f, { family: HUNG, said: ASK('4f') })
  await waitCard(w, f, s => s !== 'doing' && s !== 'todo', `重置后 ${HUNG} 新接一件`, 240_000)
  await waitCard(w, e, s => s !== 'doing' && s !== 'todo', `重置期间 ${OTHER} 那一件`, 180_000)
  w.runner.stop()
  await w.jobLog.flush?.()
  log('== 账(本目录 jobs.jsonl)==')
  for (const one of w.jobLog.all().filter(x => x.step !== 'gate_pass')) log(`  ${one.at} ${one.job} ${one.step} ${one.family ?? ''} ${one.why ?? ''}`)
  process.exit(0)
}

function opsText(): string {
  try { return readFileSync(join(root, 'ops.jsonl'), 'utf8') }
  catch { return '' }
}

async function crash(): Promise<void> {
  log('== kill -9:子进程送到一半被杀,父进程照同一份看板起来 ==')
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'crash-child', root], { env: process.env, stdio: 'inherit' })
  const tasksFile = join(root, 'tasks.json')
  const id = await new Promise<string>((resolve) => {
    const timer = setInterval(() => {
      try {
        // 「送到一半」:壳已经收到 send_text(字可能已经进了那扇窗),卡上还没记下这一次。
        if (!opsText().includes('"send_text"')) return
        const raw = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks?: { id: string, dispatch_lane?: { state: string } }[] }
        const hit = raw.tasks?.find(one => one.dispatch_lane?.state === 'sending')
        if (hit !== undefined) { clearInterval(timer); resolve(hit.id) }
      }
      catch { /* 还没写出来 */ }
    }, 50)
  })
  const sendsBefore = opsText().split('\n').filter(line => line.includes('"send_text"')).length
  process.kill(child.pid as number, 'SIGKILL')
  log(`  kill -9 子进程 ${child.pid}(那一件 ${id};被杀前 send_text ${sendsBefore} 下)`)
  await new Promise(resolve => setTimeout(resolve, 500))
  const w = world()
  await w.jobLog.load?.()
  const before = (await w.tasks.list()).tasks.find(one => one.id === id)
  log(`  起来时卡上:status=${before?.status} lane=${before?.dispatch_lane?.state ?? '-'} reply_state=${before?.client_dispatch?.reply_state ?? '-'}`)
  await w.runner.resume()
  // 宽限期内巡检照常每拍核一眼(壳不跟着插件死,那一下 send_text 可能还在做)。
  for (let i = 0; i < 120; i += 1) {
    if ((await w.tasks.list()).tasks.find(one => one.id === id)?.dispatch_lane === undefined) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const after = (await w.tasks.list()).tasks.find(one => one.id === id)
  log(`  resume 之后:status=${after?.status} lane=${after?.dispatch_lane?.state ?? '-'} reply_state=${after?.client_dispatch?.reply_state ?? '-'} note=${after?.note ?? ''}`)
  if (after?.client_dispatch?.reply_state === 'waiting') await waitCard(w, id, s => s !== 'doing' && s !== 'todo', '重启后接着收回', 240_000)
  const sends = opsText().split('\n').filter(line => line.includes('"send_text"')).length
  log(`  ★ 验收「不丢不重」:send_text 一共 ${sends} 下(被杀前 ${sendsBefore});账上 ${id} 的步:${w.jobLog.all().filter(one => one.job === id).filter(one => one.step !== 'gate_pass').map(one => one.step).join(' → ')}`)
  w.runner.stop()
  process.exit(0)
}

async function crashChild(): Promise<void> {
  const w = world()
  const id = (await w.tasks.create({ title: '自测 kill -9', direction: 'mine', status: 'todo' })).id as string
  log(`  子进程 ${process.pid} 派 ${id} 给 ${HUNG}`)
  await w.runner.start(id, { family: HUNG, said: ASK('kill') })
  await new Promise(() => {})
}

if (mode === 'isolate') await isolate()
else if (mode === 'crash') await crash()
else if (mode === 'crash-child') await crashChild()
else { console.log('用法见文件头'); process.exit(2) }
