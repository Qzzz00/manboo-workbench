// @vitest-environment node
/**
 * 派活从头到尾由工作台自己跑(2026-09-24,卡 F「手机远程派活六家」,`server/dispatchRun.ts`)。
 *
 * **一个真窗口、一个真进程都不碰**:壳、送话、命令行、接口全是注入的假件;看板用真的 tasks.json
 * (临时目录),这样七态转换表、交付物、links 都是真的那一套。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DispatchBalanceView, DispatchChoicesView, TaskClientDispatch } from '../src/protocol.ts'
import type { AgentCli } from '../src/server/agentDispatch.ts'
// 2026-10-02:送话那一层搬到了 `dispatchSend.ts`(后面是一条引擎),类型跟着搬。
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import type { DispatchRunDeps, DispatchSessionLike } from '../src/server/dispatchRun.ts'
import { cliFailureNote, createDispatchRunner, threadIdOf } from '../src/server/dispatchRun.ts'
import type { ApiDispatchInput, ApiDispatchResult } from '../src/server/dispatchApi.ts'
import { isApiDispatchFamily } from '../src/server/dispatchApi.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import { createCliAdapter } from '../src/server/engine/adapters/cli.ts'
import { createApiAdapter } from '../src/server/engine/adapters/api.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

let clock = Date.parse('2026-09-24T12:00:00Z')

interface Rig {
  tasks: ReturnType<typeof createTasksService>
  sent: SendToClientInput[]
  reads: { found: boolean, busy: boolean, texts?: string[] }[]
  sessions: DispatchSessionLike[]
  runner: ReturnType<typeof createDispatchRunner>
  cliRuns: { argv: readonly string[], cwd: string }[]
  finishCli: (code: number | null) => void
  files: Map<string, string>
  jobLog: ReturnType<typeof engineHarness>['log']
}

function rig(opts: {
  sendOk?: boolean
  sendReason?: string
  /** 送不成那一下归哪一类(缺席 = `no_window`,老行为)。 */
  sendKind?: 'no_window' | 'screen_locked'
  /** 送不成是因为**电脑锁着屏**(2026-10-03,卡「锁屏时窗口型的家送不进」)。 */
  sendScreenLocked?: true
  /** 锁着屏、而且引擎排上队了(2026-10-12)。 */
  sendLockQueued?: true
  cli?: AgentCli
  withCli?: boolean
  api?: (input: ApiDispatchInput) => Promise<ApiDispatchResult>
  helperConnected?: boolean
  /** 壳报了哪些本事;缺席 = 老的假件(没有 supports 这一格)。 */
  caps?: string[]
  /** 卡 K 的两个口。 */
  rulesFor?: DispatchRunDeps['rulesFor']
  review?: DispatchRunDeps['review']
  /** 派活选项表(额度预检读它);缺席 = 没接表(老宿主),预检一字不拦。 */
  choicesFor?: DispatchRunDeps['choicesFor']
  /** 「能换的几家」那一格;缺席 = 回包里不带替代人选。 */
  alternativesFor?: DispatchRunDeps['alternativesFor']
  /**
   * 她那段草稿让了位(卡 DB)。**照 10-13 真机那条回包的形状**:那句话既在卡上那一格
   * (`dispatch.draft.note`)、又被送话那一层拼进了 `confirm_note` —— 这一份用例钉的是
   * 不管哪一头多给了一遍,**拼出来的那句话只许出现一次**(卡 F,四场景验收第 15 条)。
   */
  draftNote?: string
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-run-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-00000${++n}` })
  const sent: SendToClientInput[] = []
  const reads: Rig['reads'] = []
  const sessions: DispatchSessionLike[] = []
  const cliRuns: Rig['cliRuns'] = []
  const files = new Map<string, string>()
  let exit: (code: number | null) => void = () => {}
  /*
   * ★ 2026-10-03(卡「派活三只手收进引擎」):命令行 / 接口两只手搬进了引擎,`dispatchRun` 只调一次 `clientDispatch.send`,
   * 按回包里 `result.via` 写卡。这份假送话照**引擎回包的形状**答:窗口没送成 → 像引擎那样按备用次序换到命令行 / 接口
   * (真跑的是两条真适配器,起进程 / 调接口是假件),各条通道的原因按通道接起来(`窗口:…;命令行:…`)。
   * 引擎自己挑路、过闸、记账那一半在 `engine-hands-in-engine.test.ts` 用真引擎钉着;这里只测**卡怎么写**。
   */
  const jobOf = (input: SendToClientInput): Job => ({
    id: input.job ?? 'j', ...(input.job === undefined ? {} : { itemId: input.job }), family: input.family, kind: 'dispatch', target: { kind: 'new' },
    text: input.text, expect: 'ack',
    ...(input.work === undefined ? {} : { work: input.work }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.project === undefined ? {} : { project: input.project }), ...(input.brief === undefined ? {} : { brief: input.brief }),
  })
  const clientDispatch: ClientDispatch = {
    async send(input) {
      sent.push(input)
      if (opts.sendOk === false) {
        // 电脑锁着屏:引擎当场回那一句、一条替代的路都不走(不按通道接原因)。
        if (opts.sendScreenLocked === true) {
          return {
            ok: false, reason: opts.sendReason ?? '电脑锁着屏', kind: opts.sendKind ?? 'screen_locked', screen_locked: true as const,
            ...(opts.sendLockQueued === true ? { lock_queued: true as const } : {}),
          }
        }
        const failed = [`窗口:${opts.sendReason ?? '找不到窗口:com.openai.codex 没在运行'}`]
        if (opts.withCli === true && opts.cli?.found === true) {
          const out = await createCliAdapter(input.family, {
            resolveCli: () => opts.cli as AgentCli,
            runCli: (cmd) => {
              cliRuns.push({ argv: cmd.argv, cwd: cmd.cwd })
              return { pid: 4242, exited: new Promise<{ code: number | null }>((resolve) => { exit = code => resolve({ code }) }) }
            },
            resultDir: '/tmp/wb-dispatch-results',
            now: () => new Date(clock),
          }).run(jobOf(input))
          if (out.delivered === 'confirmed') return { ok: true, result: out }
          if (out.unsupported !== true) failed.push(`命令行:${out.why ?? '没送成'}`)
        }
        if (opts.api !== undefined && isApiDispatchFamily(input.family)) {
          const out = await createApiAdapter(input.family, { send: opts.api }).run(jobOf(input))
          if (out.delivered === 'confirmed') return { ok: true, result: out }
          failed.push(`接口:${out.why ?? '没回来'}`)
        }
        return {
          ok: false,
          reason: failed.join(';'),
          kind: opts.sendKind ?? 'no_window',
          ...(opts.sendScreenLocked === true ? { screen_locked: true as const } : {}),
        }
      }
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'ax_value',
        baseline: sessions.map(one => one.session_id), new_conversation: '新聊天',
        ...(opts.draftNote === undefined ? {} : { draft: { saved: true, saved_to: '/d.txt', returned: false, note: opts.draftNote } }),
      }
      return {
        ok: true,
        dispatch,
        baseline: dispatch.baseline ?? [],
        ...(opts.draftNote === undefined ? {} : { front_note: opts.draftNote, confirm_note: opts.draftNote }),
      }
    },
  }
  /**
   * ★ 2026-10-02(卡「引擎接线与删复制品」):盯窗读回话走 `engine.read` ——
   * 挑通道、挑包、过 `reply_watch` 那道闸、豆包办公那条「读整扇窗」的退路都在引擎与适配器一处。
   * 这里给的是**假壳 + 真引擎**:壳的 `read_reply` 照旧从 `reads` 这个队列里拿,
   * 「读到的那几行 → 一段回答」照旧走真的 `extractReply`。
   */
  const engineRig = engineHarness({
    installed: () => [{ bundle_id: 'com.openai.codex', name: 'Codex', running: true }],
    connected: () => opts.helperConnected !== false,
    ...(opts.caps === undefined ? {} : { caps: opts.caps }),
    reply: () => reads.shift() ?? { found: false, busy: false },
    /*
     * 盯窗那一样闸上有「两拍至少隔 3 秒」(`GATE_LIMITS.reply_watch`)。这一份用例按**拍**走,
     * 不按钟走(它测的是「连着两次一字不差才算说完」),所以把那个间隔压成 0 ——
     * 真机那个数在 `GATE_LIMITS` 里,`action-gate-pipelines.test.ts` 钉着。
     */
    limits: { reply_watch: { tries: 1000, minIntervalMs: 0 } },
  })
  const runner = createDispatchRunner({
    tasks,
    helper: {
      connected: () => opts.helperConnected !== false,
      ...(opts.caps === undefined ? {} : { supports: (cap: string) => (opts.caps as string[]).includes(cap) }),
      // 与真的 helperChannel 同一个约定:resolve 的是 result 本身。
      request: async () => reads.shift() ?? { found: false, busy: false },
    },
    engine: engineRig.engine,
    jobLog: engineRig.log,
    clientDispatch,
    ...(opts.withCli === true ? { alive: () => true } : {}),
    readFile: async file => files.get(file),
    sessions: () => sessions,
    now: () => new Date(clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
    notSeenMs: 60_000,
    replyTimeoutMs: 600_000,
    ...(opts.rulesFor === undefined ? {} : { rulesFor: opts.rulesFor }),
    ...(opts.review === undefined ? {} : { review: opts.review }),
    ...(opts.choicesFor === undefined ? {} : { choicesFor: opts.choicesFor }),
    ...(opts.alternativesFor === undefined ? {} : { alternativesFor: opts.alternativesFor }),
  })
  return { tasks, sent, reads, sessions, runner, cliRuns, finishCli: code => exit(code), files, jobLog: engineRig.log }
}

async function card(r: Rig, id = 't-000001') {
  return (await r.tasks.list()).tasks.find(one => one.id === id)
}

async function newItem(r: Rig, projectId?: string) {
  const created = await r.tasks.create({ title: '[派活测试] 一年有几个季节?', direction: 'mine', status: 'todo', ...(projectId === undefined ? {} : { projectId }) })
  return created.id as string
}

describe('窗口那只手:送出去 → 盯着读 → 收回来', () => {
  it('★先开新对话再送、替他按发送;卡挪「进行中」,记上记号,开始等回答', async () => {
    const r = rig()
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'kimi', said: '一年有几个季节?' })
    expect(started).toMatchObject({ ok: true, hand: 'window' })
    expect(started.note).toContain('Kimi')
    expect(r.sent[0]).toMatchObject({ family: 'kimi', submit: true, newConversation: true })
    expect(r.sent[0]?.text.startsWith('【工作台派活 000001】一年有几个季节?')).toBe(true)
    const task = await card(r, id)
    expect(task?.status).toBe('doing')
    expect(task?.assignee).toBe('kimi')
    expect(task?.client_dispatch).toMatchObject({ status: 'sent', reply_state: 'waiting', marker: '工作台派活 000001' })
  })

  /**
   * ★ 2026-10-13(卡 F,四场景验收第 15 条):真机那条 `dispatch_note` 里
   * 「你在豆包办公输入框里没发出去的那句我存在这里了:…」说了两遍 ——
   * 卡上那一格与送话那一层的 `confirm_note` 各带了一份,这里一拼就成了两遍。
   */
  it('★草稿那句话只说一遍(卡上那一格与 confirm_note 都给了也只出现一次)', async () => {
    const line = '你在豆包办公输入框里没发出去的那句我存在这里了:/d.txt —— 这次没能放回框里:发完框里还留着字,没敢再往上写'
    const r = rig({ draftNote: line })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'doubao', said: '出一张参考图' })
    expect(started.ok).toBe(true)
    expect(started.note).toContain('存在这里了')
    expect((started.note ?? '').split('存在这里了')).toHaveLength(2)
  })

  it('★回答连着两次一字不差、没有「停止」键才收;收回来写进卡、挂交付物、挪「等我确认」', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '一年有几个季节?' })
    const p = (await card(r, id))?.client_dispatch?.text as string
    r.reads.push({ found: true, busy: true, texts: [p, '一年有'] })
    r.reads.push({ found: true, busy: false, texts: [p, '一年有', '4 个季节。'] })
    r.reads.push({ found: true, busy: false, texts: [p, '一年有', '4 个季节。', '复制'] })
    await r.runner.tick()
    expect(r.jobLog.events(id).some(one => one.step === 'started')).toBe(true)
    await r.runner.tick()
    expect((await card(r, id))?.status).toBe('doing')
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.client_dispatch).toMatchObject({ reply_state: 'done', reply: '一年有4 个季节。' })
    expect(task?.deliverables).toEqual([{ kind: 'reply', ref: '一年有4 个季节。' }])
  })

  it('★有会话流的那几家:认出新冒出来的那条会话,links 进卡(首页只数一次)', async () => {
    const r = rig()
    r.sessions.push({ agent: 'codex', session_id: 'old-1', status: 'done' })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: '看一眼 README' })
    r.sessions.push({ agent: 'codex', session_id: 'new-2', status: 'running' })
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.client_dispatch?.session_id).toBe('new-2')
    expect(task?.links).toEqual([{ agent: 'codex', session_id: 'new-2' }])
  })

  it('★窗口里读不到了(他切走了那条对话),但会话流说那条已经答完 → 拿摘要兜底,并说清只有开头', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'claude', said: '看一眼 README' })
    r.sessions.push({ agent: 'claude', session_id: 's-new', status: 'running' })
    await r.runner.tick()
    r.sessions[0] = { agent: 'claude', session_id: 's-new', status: 'done', summary: 'README 第一段讲的是事务官。' }
    clock += 30_000
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.client_dispatch?.reply).toBe('README 第一段讲的是事务官。')
    expect(task?.client_dispatch?.reply_note).toContain('全文在 Claude 里')
  })

  // 2026-09-30 维护者拍板:没看到那一句 = 失败(挂「运行失败」,来电规矩据此打一通),不再挪进「等我确认」。
  it('★送出去三分钟还没在对话里看到那一句 → 如实写「已发出……要你到那家里看一眼」,并按失败挂上,不假装收回来了', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'muse', said: '一周有几天?' })
    clock += 61_000
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.client_dispatch?.reply_state).toBe('unreadable')
    expect(task?.client_dispatch?.reply).toBeUndefined()
    expect(task?.note).toContain('要你到 Muse 里看一眼')
    expect(task?.deliverables ?? []).toEqual([])
  })

  it('★旧壳(没报会开新对话)→ 不送,说清是工作台 App 太旧;Codex 还有命令行就退到命令行', async () => {
    const r = rig({ caps: [] })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'kimi', said: 'x' })
    expect(started.ok).toBe(false)
    expect(started.note).toContain('工作台 App 还是旧版')
    expect(r.sent).toEqual([])
    const ok = rig({ caps: ['new_conversation', 'read_reply'] })
    const id2 = await newItem(ok)
    expect((await ok.runner.start(id2, { family: 'kimi', said: 'x' })).ok).toBe(true)
  })

  it('工作台重启之后(新的一份 runner):重启前送出去的那几件接着等,不误报「没看到它发出去」', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: 'x' })
    const again = createDispatchRunner({
      tasks: r.tasks,
      helper: { connected: () => true, request: async () => ({ found: false, busy: false }) },
      readFile: async () => undefined,
      sessions: () => [],
      now: () => new Date(clock),
      setTimer: () => 'timer',
      clearTimer: () => {},
      notSeenMs: 60_000,
      replyTimeoutMs: 600_000,
    })
    await again.resume()
    clock += 61_000
    await again.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('doing')
    expect(task?.client_dispatch?.reply_state).toBe('waiting')
  })

  it('他把卡取消了 → 不再读、更不再挪回「等我确认」', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: 'x' })
    await r.tasks.move(id, 'canceled')
    r.reads.push({ found: true, busy: false, texts: ['x', '好。'] }, { found: true, busy: false, texts: ['x', '好。'] })
    expect(await r.runner.tick()).toBe(0)
    expect((await card(r, id))?.status).toBe('canceled')
  })
})

describe('一只手送不进去 → 按顺序试下一只;都不行就如实挂阻塞', () => {
  it('★Codex 窗口送不进去 → 退到命令行(-C 工作目录 + --json + -o),进程退出后读结果文件收回来', async () => {
    const r = rig({ sendOk: false, withCli: true, cli: { found: true, family: 'codex', bin: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'bundled' } })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'codex', said: '新建 hello.txt', cwd: '/tmp/demo', project: '派活测试项目' })
    expect(started).toMatchObject({ ok: true, hand: 'cli' })
    expect(r.cliRuns[0]?.argv.slice(0, 7)).toEqual(['exec', '--json', '-C', '/tmp/demo', '-s', 'workspace-write', '-o'])
    expect(r.cliRuns[0]?.argv.join(' ')).not.toContain('dangerously')
    let task = await card(r, id)
    expect(task?.dispatch).toMatchObject({ hand: 'cli', status: 'running', pid: 4242, cwd: '/tmp/demo' })
    const out = task?.dispatch?.output_file as string
    r.files.set(out, '已新建 hello.txt。')
    r.files.set(`${out}.jsonl`, '{"type":"thread.started","thread_id":"01a0d392"}\n')
    await r.runner.tick()
    /*
     * ★ 2026-10-29(任务书「在跑的事项要数到命令行真在跑的活」):起进程那一刻就记了 `started`
     * (带 pid 与轮次身份)——不再等「活动出现才补开工」;活动走 `updated`,30 秒节流。
     */
    expect(r.jobLog.events(id).filter(e => e.step === 'started')).toHaveLength(1)
    expect(r.jobLog.events(id).find(e => e.step === 'started')).toMatchObject({ pid: 4242, via: 'cli' })
    expect(r.jobLog.events(id).filter(e => e.step === 'updated')).toHaveLength(1)
    r.files.set(`${out}.jsonl`, '{"type":"thread.started","thread_id":"01a0d392"}\n{"type":"turn.started"}\n')
    await r.runner.tick(); await r.runner.tick()
    // 钟没走、还在节流窗口里:第二条活动不再记。
    expect(r.jobLog.events(id).filter(e => e.step === 'updated')).toHaveLength(1)
    r.finishCli(0)
    for (let i = 0; i < 50 && task?.status !== 'confirm'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = await card(r, id)
    }
    expect(task?.status).toBe('confirm')
    expect(task?.dispatch).toMatchObject({ status: 'done', reply: '已新建 hello.txt。', session_id: '01a0d392' })
    expect(task?.links).toEqual([{ agent: 'codex', session_id: '01a0d392' }])
    expect(task?.deliverables?.[0]).toMatchObject({ kind: 'reply', ref: '已新建 hello.txt。' })
  })

  it('CLI 退出原因未知且没有完成事件时,旧结果文件不能冒成功', async () => {
    const r = rig({ sendOk: false, withCli: true, cli: { found: true, family: 'codex', bin: '/test/codex', source: 'bundled' } })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: '生成结果', cwd: '/tmp/demo' })
    const out = (await card(r, id))!.dispatch!.output_file!
    r.files.set(out, '半截结果')
    r.files.set(`${out}.jsonl`, '{"type":"thread.started","thread_id":"real-thread"}\n')
    r.finishCli(null)
    for (let i = 0; i < 50 && (await card(r, id))?.status !== 'blocked'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect((await card(r, id))?.dispatch?.status).toBe('failed')
    expect(r.jobLog.events(id).some(e => e.step === 'replied')).toBe(false)
  })
  it('★命令行要工作目录:这件事没挂项目 → 不猜一个目录,如实挂阻塞', async () => {
    const r = rig({ sendOk: false, withCli: true, cli: { found: true, family: 'codex', bin: '/x/codex', source: 'bundled' } })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'codex', said: 'x' })
    expect(started.ok).toBe(false)
    expect(r.cliRuns).toEqual([])
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.note).toContain('不知道在哪个项目里做')
    expect(task?.note).toContain('窗口:找不到窗口')
  })

  it('命令行进程失败 → 卡上挂阻塞,原因是事件流里那句错误', async () => {
    const r = rig({ sendOk: false, withCli: true, cli: { found: true, family: 'codex', bin: '/x/codex', source: 'bundled' } })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: 'x', cwd: '/tmp/demo' })
    const out = (await card(r, id))?.dispatch?.output_file as string
    r.files.set(`${out}.jsonl`, '{"type":"error","message":"stream disconnected"}\n')
    r.finishCli(1)
    let task = await card(r, id)
    for (let i = 0; i < 50 && task?.status !== 'blocked'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = await card(r, id)
    }
    expect(task?.dispatch).toMatchObject({ status: 'failed', note: 'stream disconnected' })
    // 它出了输出(一行错误事件)才退 —— 按共用那把尺(`cliOutputLines` 非空白行)算「干了活没做成」,
    // 不是起跑失败:候选里没有别只,照旧挂阻塞。(按事件类型数会把这行漏掉误判起跑失败,退修已换尺。)
    expect(task?.note).toContain('派给 Codex 没做成')
    expect(task?.note).toContain('stream disconnected')
  })

  it('★Kimi 只有窗口:送不进去就停在这儿,**不改派别家**,卡上写清原话', async () => {
    const r = rig({ sendOk: false, sendReason: '输入框没找到:com.moonshot.kimichat' })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'kimi', said: 'x' })
    expect(started.ok).toBe(false)
    expect(started.note).toBe('派给 Kimi 没派出去:窗口:输入框没找到:com.moonshot.kimichat')
    const task = await card(r, id)
    expect(task?.assignee).toBe('kimi')
    expect(task?.status).toBe('blocked')
  })

  it('豆包窗口送不进去 → 退到接口(中转);回来就直接进「等我确认」', async () => {
    const r = rig({
      sendOk: false,
      api: async input => ({
        ok: true,
        reply: '中秋节是农历八月十五。',
        dispatch: { family: input.family, status: 'done', hand: 'api', started_at: 'x', ended_at: 'y' },
      }),
    })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'doubao', said: '中秋节是几月几日' })
    expect(started).toMatchObject({ ok: true, hand: 'api' })
    const task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.dispatch).toMatchObject({ hand: 'api', reply: '中秋节是农历八月十五。' })
  })
})

describe('协作区:写了验收的便签,派活说明带编号、回执三态落章(2026-10-21)', () => {
  const api = (reply: string) => async (input: ApiDispatchInput): Promise<ApiDispatchResult> => ({
    ok: true, reply, dispatch: { family: input.family, status: 'done', hand: 'api', started_at: 'x', ended_at: 'y' },
  })
  it('「做完:」→ 记回执、进「等你」;送出去的话里验收带编号', async () => {
    const r = rig({ sendOk: false, api: api('做完:1 查过了,八月十五') })
    const id = await newItem(r)
    await r.tasks.update(id, { acceptance: ['说出是几月几日'] })
    await r.runner.start(id, { family: 'doubao', said: '中秋节是几月几日' })
    expect(r.sent[0]?.text).toContain('1. 说出是几月几日')
    const task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.receipt).toMatchObject({ kind: 'done', by: 'doubao' })
    expect(task?.receipt_irregular).toBeUndefined()
  })
  it('「卡住:」→ 进「卡住」', async () => {
    const r = rig({ sendOk: false, api: api('卡住:查不到日历') })
    const id = await newItem(r)
    await r.tasks.update(id, { acceptance: ['说出是几月几日'] })
    await r.runner.start(id, { family: 'doubao', said: '中秋节是几月几日' })
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.receipt?.kind).toBe('blocked')
  })
  it('认不出三种之一 → 照旧进「等你」,章上标回执不规范;没写验收的老卡不标', async () => {
    const r = rig({ sendOk: false, api: api('中秋节是农历八月十五。') })
    const id = await newItem(r)
    await r.tasks.update(id, { acceptance: ['说出是几月几日'] })
    await r.runner.start(id, { family: 'doubao', said: '中秋节是几月几日' })
    expect((await card(r, id))?.receipt_irregular).toBe(true)
    const plain = await newItem(r)
    await r.runner.start(plain, { family: 'doubao', said: '中秋节是几月几日' })
    expect((await card(r, plain))?.receipt_irregular).toBeUndefined()
  })
})

describe('他已经完成 / 取消了的卡,后台一格都不挪(2026-09-25,卡 fix/confirm-cancel)', () => {
  it('★等接口回话的那几秒里他点了完成 → 回话回来也不把它重新打开、不挪「等我确认」', async () => {
    let release: () => void = () => {}
    const r = rig({
      sendOk: false,
      api: input => new Promise((resolve) => {
        release = () => resolve({ ok: true, reply: '中秋节是农历八月十五。', dispatch: { family: input.family, status: 'done', hand: 'api', started_at: 'x', ended_at: 'y' } })
      }),
    })
    const id = await newItem(r)
    const pending = r.runner.start(id, { family: 'doubao', said: '中秋节是几月几日' })
    // 等它走到接口那一步(窗口那只手先失败)。
    for (let i = 0; i < 50 && r.sent.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setTimeout(resolve, 20))
    await r.tasks.move(id, 'doing')
    await r.tasks.move(id, 'done')
    release()
    await pending
    expect((await card(r, id))?.status).toBe('done')
  })

  it('★送字那几秒里他取消了 → 送完也不挪进「进行中」,之后也不再读、不挪「等我确认」', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.tasks.move(id, 'canceled')
    await r.runner.start(id, { family: 'kimi', said: 'x' })
    expect((await card(r, id))?.status).toBe('canceled')
    const p = (await card(r, id))?.client_dispatch?.text as string
    r.reads.push({ found: true, busy: false, texts: [p, '好。'] }, { found: true, busy: false, texts: [p, '好。'] })
    await r.runner.tick()
    await r.runner.tick()
    expect((await card(r, id))?.status).toBe('canceled')
  })
})

describe('他的规矩(与卡 K 对齐的两个口)', () => {
  /**
   * ★ 2026-09-27(卡 MS):**只有写代码的活才附规矩**,所以这一条要明说 `kind:'code'`。
   * 21:23 那一通派给豆包的是一件聊天的活(「把这几天聊的内容总结一下」),正文里却附了一整段
   * 派活分工与构建规矩 —— 与这件活无关,还把内部口径发到了外面那家 AI 那里。
   */
  it('★送出去那段话末尾贴上这件活要守的规矩', async () => {
    const r = rig({ rulesFor: async () => '这件活要守的规矩:\n- 不许用蓝色' })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: '把按钮改一下' })
    expect(r.sent[0]?.text.endsWith('这件活要守的规矩:\n- 不许用蓝色')).toBe(true)
    expect(r.sent[0]?.text.startsWith('【工作台派活 000001】把按钮改一下')).toBe(true)
  })

  /**
   * ★ 挑哪几条规矩在 `rules.ts` 那一处判(`dispatchRulesBlock` 的 `kind`,用例在 tests/call-relay-dumb.test.ts):
   * 这里只钉**这件活是哪一类要交上去** —— 交不上去的话那一处就永远看不出这是一件聊天的活。
   */
  it('★这件活是哪一类要交给挑规矩那一处(聊天的活不附全局那一批)', async () => {
    const seen: { kind?: string }[] = []
    const r = rig({ rulesFor: async (input) => { seen.push({ ...(input.kind === undefined ? {} : { kind: input.kind }) }); return undefined } })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'doubao', said: '把这几天我跟你聊的内容总结一下', kind: 'chat' })
    expect(seen).toEqual([{ kind: 'chat' }])
  })

  it('★自查没过 → 打回**同一条对话**让它改一次(不开新对话);改完过了才进「等我确认」', async () => {
    let round = 0
    const r = rig({
      review: async ({ text }) => {
        round += 1
        return text.includes('蓝') ? { pass: false, violations: ['不许用蓝色'], reject_text: '按钮用了蓝色,改成黑白灰再交' } : { pass: true }
      },
    })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '改按钮' })
    const p1 = (await card(r, id))?.client_dispatch?.text as string
    r.reads.push({ found: true, busy: false, texts: [p1, '改成了蓝色。'] }, { found: true, busy: false, texts: [p1, '改成了蓝色。'] })
    await r.runner.tick()
    await r.runner.tick()
    let task = await card(r, id)
    expect(task?.status).toBe('doing')
    expect(r.sent[1]).toMatchObject({ newConversation: false, submit: true })
    expect(r.sent[1]?.text.startsWith('【工作台派活 000001 返工】按钮用了蓝色,改成黑白灰再交')).toBe(true)
    expect(r.sent[1]?.text).toContain('本次分工依据：')
    expect(task?.client_dispatch).toMatchObject({ rework: 1, marker: '工作台派活 000001 返工', reply_state: 'waiting' })
    const p2 = task?.client_dispatch?.text as string
    r.reads.push({ found: true, busy: false, texts: [p2, '改成了黑白灰。'] }, { found: true, busy: false, texts: [p2, '改成了黑白灰。'] })
    await r.runner.tick()
    await r.runner.tick()
    task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.client_dispatch?.reply).toBe('改成了黑白灰。')
    expect(round).toBe(2)
  })

  it('★改过一次还不过 → 不进「等我确认」,卡挂阻塞写清没过哪几条(不无限打回)', async () => {
    const r = rig({ review: async () => ({ pass: false, violations: ['不许用蓝色'], reject_text: '还是蓝的' }) })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '改按钮' })
    for (let i = 0; i < 2; i += 1) {
      const p = (await card(r, id))?.client_dispatch?.text as string
      r.reads.push({ found: true, busy: false, texts: [p, '蓝的。'] }, { found: true, busy: false, texts: [p, '蓝的。'] })
      await r.runner.tick()
      await r.runner.tick()
    }
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('自查没过(不许用蓝色)')
    expect(r.sent).toHaveLength(2)
  })

  it('★0.2.96 真机 Codex 那一串(我们的消息被画成 20 截):收回来的只有它的回答;自查拿到的是我们附的那些', async () => {
    const rules = [
      '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
      '- 不露内部的东西(`**` 这类符号、事项的出处说明、文件路径、英文键名)',
      '- 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 `taskpolicy -c utility`(别用 nice),一次只跑一个)',
    ].join('\n')
    const seen: { text: string, instruction?: string }[] = []
    const r = rig({
      rulesFor: async () => rules,
      review: async ({ text, instruction }) => { seen.push({ text, ...(instruction === undefined ? {} : { instruction }) }); return { pass: true } },
    })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: '[派活测试] 让 Codex 用一句话回答:一天有几个小时?' })
    const nodes = [
      '【工作台派活 000001】[派活测试] 让 Codex 用一句话回答:一天有几个小时?', '(这是工作台转交的活,做完直接回结果,我在手机上看。)',
      '【他的规矩:这件活要守的(工作台按他说过的话附上;交回来会先按这些验,不合格会打回)】',
      '-', ' 不露内部的东西(', '`', '*', '*', '`', ' 这类符号、事项的出处说明、文件路径、英文键名)',
      '-', ' 电话不能被电脑上的构建、测试、派出去的活挤卡(做法:在这台 Mac 上跑构建、测试一律前缀 ', '`', 'taskpolicy -c utility', '`', '(别用 nice),一次只跑一个)',
      '2:43', 'ChatGPT said:', '一天有24个小时。', '2:43',
    ]
    r.reads.push({ found: true, busy: false, texts: nodes }, { found: true, busy: false, texts: nodes })
    await r.runner.tick()
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('confirm')
    expect(task?.client_dispatch?.reply).toBe('一天有24个小时。')
    expect(task?.deliverables?.map(one => one.ref)).toEqual(['一天有24个小时。'])
    expect(seen[0]?.text).toBe('一天有24个小时。')
    expect(seen[0]?.instruction?.startsWith('这是工作台转交的活')).toBe(true)
    expect(seen[0]?.instruction).toContain('【他的规矩')
    expect(seen[0]?.instruction).not.toContain('一天有几个小时')
  })

  it('★读回来的回答里夹着我们派活时附的话 → 卡挂阻塞写清楚;不进「等我确认」、不挂交付物、不打回给那家', async () => {
    let reviewed = 0
    const r = rig({
      rulesFor: async () => '【他的规矩:这件活要守的】\n- 不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)',
      review: async () => { reviewed += 1; return { pass: false, violations: ['x'], reject_text: '改' } },
    })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: '一天有几个小时?' })
    const p = (await card(r, id))?.client_dispatch?.text as string
    const nodes = [p, 'ChatGPT said:', '好的,我会照做:不露内部的东西(星号这类符号、事项的出处说明、文件路径、英文键名)。一天有24个小时。']
    r.reads.push({ found: true, busy: false, texts: nodes }, { found: true, busy: false, texts: nodes })
    await r.runner.tick()
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('夹着我们派活时附的话(「不露内部的东西(星号这类符号')
    expect(task?.note).toContain('原文在 Codex 那扇窗里')
    expect(task?.client_dispatch).toMatchObject({ reply_state: 'done' })
    expect(task?.client_dispatch?.reply_note).toContain('可能没读对')
    expect(task?.deliverables ?? []).toHaveLength(0)
    expect(r.sent).toHaveLength(1)
    expect(reviewed).toBe(0)
  })

  it('命令行那只手自查没过 → 同样不进「等我确认」', async () => {
    const r = rig({
      sendOk: false, withCli: true, cli: { found: true, family: 'codex', bin: '/x/codex', source: 'bundled' },
      review: async () => ({ pass: false, violations: ['没跑测试'] }),
    })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'codex', said: 'x', cwd: '/tmp/demo' })
    const out = (await card(r, id))?.dispatch?.output_file as string
    r.files.set(out, '改好了。')
    r.finishCli(0)
    let task = await card(r, id)
    for (let i = 0; i < 50 && task?.status !== 'blocked'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      task = await card(r, id)
    }
    expect(task?.status).toBe('blocked')
    expect(task?.note).toContain('没跑测试')
    expect(task?.dispatch?.reply).toBe('改好了。')
  })
})

describe('电脑锁着屏(2026-10-03,卡「锁屏时窗口型的家送不进」)', () => {
  /** 窗口那只手撞上锁屏时,`dispatchSend` 回的那一句(真路上由 `screenLock.screenLockedSay` 出)。 */
  const SAY = '电脑锁着屏,窗口型的家这会儿送不进 —— Kimi 还在跑,可锁屏时它一扇窗都列不出来。解锁了再叫我一次'

  it('★★卡挂「等你处理」,不挂「运行失败」 —— 她去解锁就好,不是出错', async () => {
    const r = rig({ sendOk: false, sendReason: SAY, sendKind: 'screen_locked', sendScreenLocked: true })
    const id = await newItem(r)
    const out = await r.runner.start(id, { family: 'kimi', said: '帮我把这篇的封面做三版' })
    expect(out.ok).toBe(false)
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    /*
     * ★ **卡上那句备注就是同一句**(与手机回包、电话里念的、`jobs.jsonl` 那一行同一个出处)——
     * 不是「派给 Kimi 没派出去:窗口:…」那种把三只手的原因串起来的话。
     */
    expect(task?.note).toBe(SAY)
    expect(task?.dispatch_block?.why).toBe(SAY)
  })

  it('★★派活这一送带 waitUnlock(锁着屏就排队;2026-10-12)', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '帮我把这篇的封面做三版' })
    expect(r.sent[0]?.waitUnlock).toBe(true)
    expect(r.sent[0]?.job).toBe(id)
  })

  it('★★排上队了 → 卡上 dispatch_block.unlock、回包 screen_locked(解锁重派那一下据此认「还锁着」)', async () => {
    const SAY_QUEUED = '电脑锁着屏,窗口型的家这会儿送不进 —— 锁着屏的时候Kimi的窗口一扇都列不出来。解锁了我就把这件派出去'
    const r = rig({ sendOk: false, sendReason: SAY_QUEUED, sendScreenLocked: true, sendLockQueued: true })
    const id = await newItem(r)
    const out = await r.runner.start(id, { family: 'kimi', said: '帮我把这篇的封面做三版' })
    expect(out.ok).toBe(false)
    expect(out.screen_locked).toBe(true)
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('input')
    expect(task?.dispatch_block?.unlock).toBe(true)
    expect(task?.note).toBe(SAY_QUEUED)
  })

  it('没排上(老宿主没接那本队)→ 卡上没有 unlock 那一格(不许许「解锁就送」)', async () => {
    const r = rig({ sendOk: false, sendReason: SAY, sendScreenLocked: true })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '帮我把这篇的封面做三版' })
    expect((await card(r, id))?.dispatch_block?.unlock).toBeUndefined()
  })

  it('★对照:**没**锁屏、真没窗口 → 照旧「运行失败」那条路(一字不变)', async () => {
    const r = rig({ sendOk: false })
    const id = await newItem(r)
    await r.runner.start(id, { family: 'kimi', said: '帮我把这篇的封面做三版' })
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    // 老路那句 note 是「派给 X 没派出去:窗口:…」,而且 `dispatch_block` 那一格不是这一句
    expect(task?.note).toContain('没派出去')
    expect(task?.dispatch_block?.why).not.toBe('找不到窗口:com.openai.codex 没在运行')
  })
})

describe('命令行事件流的两个小工具', () => {
  it('threadIdOf:取第一个 thread id;半截行跳过', () => {
    expect(threadIdOf('{"type":"thread.started","thread_id":"abc"}\n{"type":"x"')).toBe('abc')
    expect(threadIdOf('not json\n')).toBeUndefined()
  })
  it('cliFailureNote:事件流里最后一条错误;没有就说退出码', () => {
    expect(cliFailureNote(1, '{"type":"error","message":"boom"}')).toBe('boom')
    expect(cliFailureNote(2, '')).toBe('退出码 2')
    expect(cliFailureNote(null, '')).toBe('进程被停掉了')
  })
})

it('配置过模型的自动返工保留原线程与请求,另建本轮证据', async () => {
  const r = rig({ review: async () => ({ pass: false, violations: ['改色'], reject_text: '改成黑白灰' }) })
  const id = await newItem(r)
  await r.runner.start(id, { family: 'codex', said: '改按钮' })
  const original = (await card(r, id))!.client_dispatch!
  await r.tasks.update(id, { clientDispatch: { ...original, session_id: 'native-thread', turn_id: 'old-turn', cwd: '/repo', runtime: { attempt_id: 'original-attempt', mode: 'new', started_at: original.at, requested: { model: 'chosen-model', effort: 'high' }, observed: { model: 'chosen-model', effort: 'high' }, status: 'verified', source: 'native_context' } } })
  r.reads.push({ found: true, busy: false, texts: [original.text, '按钮用了蓝色'] }, { found: true, busy: false, texts: [original.text, '按钮用了蓝色'] })
  await r.runner.tick(); await r.runner.tick()
  expect(r.sent[1]).toMatchObject({ resumeSessionId: 'native-thread', cwd: '/repo', model: 'chosen-model', effort: 'high', vias: ['protocol'] })
  const next = (await card(r, id))!.client_dispatch!
  expect(next.runtime?.attempt_id).not.toBe('original-attempt')
  expect(next.runtime?.status).toBe('unverified')
  expect(next.turn_id).not.toBe('old-turn')
})

it('原生运行档位不符时不自动发起返工', async () => {
  const r = rig({ review: async () => ({ pass: false, violations: ['改色'], reject_text: '改成黑白灰' }) })
  const id = await newItem(r)
  await r.runner.start(id, { family: 'codex', said: '改按钮' })
  const original = (await card(r, id))!.client_dispatch!
  await r.tasks.update(id, { clientDispatch: { ...original, session_id: 'native-thread', cwd: '/repo', runtime: { attempt_id: 'original-attempt', mode: 'new', started_at: original.at, requested: { model: 'chosen-model', effort: 'high' }, observed: { model: 'chosen-model', effort: 'low' }, status: 'mismatch', source: 'native_context' } } })
  r.reads.push({ found: true, busy: false, texts: [original.text, '按钮用了蓝色'] }, { found: true, busy: false, texts: [original.text, '按钮用了蓝色'] })
  await r.runner.tick(); await r.runner.tick()
  expect(r.sent).toHaveLength(1)
  expect((await card(r, id))?.status).toBe('blocked')
})

/**
 * ★ **派活前额度预检**(2026-10-28,演示断点①:点小G(=Codex)的活真派出去才撞 usage limit):
 * 选项表里这一家额度**查实是 0** → 派活那一层不派,卡挂「等你处理」,回话说清、列出能换的几家。
 * 「没读到数」不算零 —— 未核实照旧派(那是不知道,不是用完了)。
 */
describe('派活前额度预检:查实 0 → 不派,卡挂「等你处理」并给能换的几家', () => {
  const viewOf = (balance: DispatchBalanceView | undefined): DispatchChoicesView => ({
    kind: 'code',
    kind_why: '要改代码',
    default_why: '你点名要 Codex 做',
    line: '写代码的活 → 派给 Codex',
    options: [
      { family: 'codex', title: 'Codex', ok: true, hand: 'cli', ...(balance === undefined ? {} : { balance }) },
      { family: 'kimi', title: 'Kimi', ok: true, hand: 'cli', balance: { level: 'ok', text: '本周还剩约 58%', state: 'numbers' } },
    ],
  })

  it('这家额度查实 0:一步都不送(窗口 / 命令行都不起),卡挂「等你处理」,note 说清并列出能换的', async () => {
    const r = rig({
      withCli: true,
      cli: { found: true, family: 'codex', bin: '/usr/bin/codex', source: 'path' },
      choicesFor: async () => await Promise.resolve(viewOf({ level: 'empty', text: '本周额度用完了', state: 'numbers' })),
      alternativesFor: async () => [{ family: 'kimi', title: 'Kimi', note: '本周还剩约 58%' }],
    })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'codex', said: '改一下登录页的报错', kind: 'code', cwd: '/repo' })
    expect(started.ok).toBe(false)
    expect(started.note).toContain('没派给 Codex')
    expect(started.note).toContain('本周额度用完了')
    expect(started.note).toContain('换一张名片')
    expect(started.note).toContain('Kimi')
    expect(r.sent).toHaveLength(0)
    expect(r.cliRuns).toHaveLength(0)
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('quota')
    expect(task?.note).toBe(started.note)
  })

  it('额度没读到数(未核实):不是零,照旧派', async () => {
    const r = rig({
      choicesFor: async () => await Promise.resolve(viewOf({ level: 'unknown', text: '没接上:这次没取到', state: 'unconnected' })),
    })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'codex', said: '一年有几个季节?' })
    expect(started.ok).toBe(true)
    expect(r.sent).toHaveLength(1)
  })

  it('没接选项表(老宿主):预检一字不拦,照旧派', async () => {
    const r = rig()
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'codex', said: '一年有几个季节?' })
    expect(started.ok).toBe(true)
    expect(r.sent).toHaveLength(1)
  })
})
