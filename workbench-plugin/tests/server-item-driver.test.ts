// @vitest-environment node
/**
 * 负责人驱动(2026-09-25,卡 N,`server/itemDriver.ts`)。
 *
 * 看板用真的 tasks.json(临时目录)、审批用真的审批经纪人(composer.ts,内存);派活、按证据核是注入的假件 ——
 * 一个真窗口、一个真进程都不碰。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentCard, ComposerMode, TaskProgressView } from '../src/protocol.ts'
import { PROGRESS_NONE_LINE } from '../src/protocol.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import type { DispatchChoicesLike } from '../src/server/itemDriver.ts'
import { askReason, createItemDriver, dispatchInstruction, drivable } from '../src/server/itemDriver.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const FOUND: TaskProgressView = {
  line: '11 屏已做完,逐屏文案稿在等你审',
  state: 'found',
  basis: [{ kind: 'session', source: 'Codex 里「制作参赛网页」那段对话', ref: '/x/rollout-01a0ccd1.jsonl', at: '2026-09-24T12:17:00Z', quote: '11 屏按网页顺序排列' }],
  checked_at: '2026-09-25T07:10:00Z',
  waiting_on: 'me',
  by: 'model',
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

function rig(opts: { mode?: ComposerMode, choices?: DispatchChoicesLike, dispatchOk?: boolean, driveFileBefore?: string, progress?: TaskProgressView } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-item-driver-'))
  dirs.push(dir)
  let n = 0
  const clock = { now: new Date('2026-09-25T07:00:00Z') }
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock.now.getTime() / 1000), newId: () => `t-0000${++n}` })
  const broker = createApprovalBroker(() => clock.now)
  // 挂出去的原样请求(卡 M 的审批卡取 `detail.say`;本分支这一版经纪人还不认这一格,照样要钉住我们给了它)。
  const asked: { tool: string, reason?: string, detail?: { say?: string } }[] = []
  const approvals = {
    ...broker,
    ask: (req: { sessionId: string, tool: string, reason?: string, detail?: { say?: string }, signal?: AbortSignal }) => {
      asked.push({ tool: req.tool, ...(req.reason === undefined ? {} : { reason: req.reason }), ...(req.detail === undefined ? {} : { detail: req.detail }) })
      return broker.ask(req)
    },
  }
  const dispatched: { taskId: string, family: string, text: string, kind?: string }[] = []
  const started: { taskId: string, text: string }[] = []
  const returns: string[] = []
  const prechecked: string[] = []
  /** 问过挑手几次(卡 Z:派的时候接着用问他那一拍的那一份,不再多问一次)。 */
  const choiceCalls: string[] = []
  const driver = createItemDriver({
    tasks,
    now: () => clock.now,
    file: join(dir, 'drive.json'),
    mode: async () => opts.mode ?? 'ask',
    approvals,
    dispatch: async (taskId, input) => { dispatched.push({ taskId, family: input.family, text: input.text, ...(input.kind === undefined ? {} : { kind: input.kind }) }); return opts.dispatchOk === false ? { ok: false, note: 'Claude 窗口上挂着对话框' } : { ok: true, note: '派出去了' } },
    butlerStart: async (taskId, text) => { started.push({ taskId, text }); return { ok: true } },
    precheck: async (taskId) => { prechecked.push(taskId); return opts.progress ?? FOUND },
    ...(opts.choices === undefined ? {} : { choices: async (id: string) => { choiceCalls.push(id); return opts.choices } }),
    onReturn: id => returns.push(id),
  })
  return { dir, clock, tasks, approvals, asked, driver, dispatched, started, returns, prechecked, choiceCalls }
}

describe('哪几张归驱动管', () => {
  it('待办 + 负责人是某家 AI 或事务官;他 / 同事 / 别人、需求卡、测试留下的、不在待办的都不管', () => {
    const base = { id: 't', status: 'todo' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '' }
    expect(drivable({ ...base, title: '打磨自媒体布局', assignee: 'claude' })).toBe(true)
    expect(drivable({ ...base, title: '事务官办', assignee: 'dsh' })).toBe(true)
    expect(drivable({ ...base, title: '9/28 放同事桌上', assignee: 'me' })).toBe(false)
    expect(drivable({ ...base, title: '参赛文案', assignee: 'colleague' })).toBe(false)
    expect(drivable({ ...base, title: '需求', assignee: 'claude', kind: 'feature' })).toBe(false)
    expect(drivable({ ...base, title: '[派活测试] 一天几小时', assignee: 'codex' })).toBe(false)
    expect(drivable({ ...base, title: 'x', assignee: 'claude', status: 'backlog' })).toBe(false)
  })

  /**
   * 名片负责人(2026-10-22,卡「名片补四样与Kimi命令行手」B):assignee 保留 `agent:…` 之后,
   * 「是不是 AI」照旧按名片自己的命令行家判 —— runtime.family 缺席退回 hand(与派活那一层同一个判法)。
   */
  it('名片负责人:按名片的 runtime.family(缺席退回 hand)判是不是 AI', () => {
    const base = { id: 't', status: 'todo' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '', title: '修日历认法' }
    const cards = [
      { id: 'agent:local:1' as AgentCard['id'], hand: 'kimi', runtime: { family: 'kimi' } },
      { id: 'agent:local:2' as AgentCard['id'], hand: 'codex' },
    ]
    expect(drivable({ ...base, assignee: 'agent:local:1' }, cards)).toBe(true)
    expect(drivable({ ...base, assignee: 'agent:local:2' }, cards)).toBe(true)
    // 不带名片表:认不出是 AI,照旧不驱动(老调用方一字不变)
    expect(drivable({ ...base, assignee: 'agent:local:1' })).toBe(false)
    // 便签上挂了、可名片已经被删了:不驱动(派的时候会如实说)
    expect(drivable({ ...base, assignee: 'agent:local:gone' }, cards)).toBe(false)
  })

  /**
   * 演示数据(2026-10-13,卡「演示数据一键放进去」):那一套里「当日新增、还没实质推进」那张
   * 正好是「待办 + 负责人写着某一家 + 没派过」—— 真派出去就在演示机上开那家的窗、送一段话出去,
   * 而放演示数据这件事说好了只写记录。
   */
  it('演示数据那几张不管(只写记录,不真派活)', () => {
    const base = { id: 't', status: 'todo' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '' }
    expect(drivable({ ...base, title: '品牌方植入:口播那一段怎么改', assignee: 'codex' })).toBe(true)
    expect(drivable({ ...base, title: '品牌方植入:口播那一段怎么改', assignee: 'codex', demo: true })).toBe(false)
  })

  it('别的路接过的不管:派出去过(任何一条路)、事务官那条会话还开着', () => {
    const base = { id: 't', status: 'todo' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '', title: '打磨自媒体布局', assignee: 'claude' as const }
    expect(drivable({ ...base, client_dispatch: { family: 'claude', status: 'sent', at: '2026-09-25T06:00:00Z', text: 'x' } as never })).toBe(false)
    expect(drivable({ ...base, dispatch: { family: 'claude', status: 'failed', started_at: '2026-09-25T06:00:00Z' } as never })).toBe(false)
    expect(drivable({ ...base, assignee: 'dsh', conversation: { agent: 'dsh', session_id: 's-1' } as never })).toBe(false)
    expect(drivable({ ...base, assignee: 'dsh', conversation: { agent: 'dsh', session_id: 's-1', archived_at: '2026-09-25T06:00:00Z' } as never })).toBe(true)
  })
})


describe('别的路在管这张的派不派(他交代时点了名 —— 卡 F;引导落地第一件)', () => {
  it('claim 过的:驱动不问;他在卡上点「派给 X」照样能派', async () => {
    const r = rig()
    const made = await r.tasks.create({ title: '让 Codex 修参赛网页的导航', assignee: 'codex', direction: 'mine', origin: 'user' })
    r.driver.claim(made.id as string)
    await r.driver.reconcile()
    await flush()
    expect(r.approvals.list()).toHaveLength(0)
    // 重启之后(内存清了)也不问:记进了 drive.json。
    const record = JSON.parse(readFileSync(join(r.dir, 'drive.json'), 'utf8')).cards[made.id as string]
    expect(record.claimed_at).toBe('2026-09-25T07:00:00.000Z')
    expect((await r.driver.driveNow(made.id as string)).ok).toBe(true)
    expect(r.dispatched.map(one => one.taskId)).toEqual([made.id])
  })

  it('★2026-10-29 E#2:只挂负责人的卡不问不派;他在卡上点「派给 X」照样能派(只派一次)', async () => {
    const r = rig()
    const a = await r.tasks.create({ title: '打磨自媒体布局', assignee: 'claude' })
    const b = await r.tasks.create({ title: '额度显示 / 会话读取', assignee: 'claude' })
    await r.driver.reconcile()
    await flush()
    // 「派给 X 开工?」那一问整个删掉:一问答不出去的驱动问题不再存在。
    expect(r.approvals.list()).toHaveLength(0)
    expect(r.dispatched).toHaveLength(0)
    expect((await r.driver.driveNow(a.id as string)).ok).toBe(true)
    r.driver.claim(b.id as string)
    await flush()
    expect(r.approvals.list()).toHaveLength(0)
    expect(r.dispatched.map(one => one.taskId)).toEqual([a.id])
  })

  it('驱动核证据那一会儿,那条路接过去了 → 不挂那一问、「自动办」也不再派一次', async () => {
    for (const mode of ['ask', 'auto'] as const) {
      const r = rig({ mode })
      const made = await r.tasks.create({ title: '打磨自媒体布局', assignee: 'claude' })
      const pending = r.driver.reconcile()
      r.driver.claim(made.id as string)
      await pending
      await flush()
      expect(r.approvals.list()).toHaveLength(0)
      expect(r.dispatched).toHaveLength(0)
    }
  })

  it('引导落地第一件(dispatchChecked):驱动不为它再问;没派成 → 卡上写原因,半小时后才再试', async () => {
    const r = rig({ dispatchOk: false })
    const made = await r.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex', origin: 'onboarding' })
    const first = r.driver.dispatchChecked(made.id as string, { family: 'codex' })
    await r.driver.reconcile()
    expect((await first).ok).toBe(false)
    await flush()
    expect(r.approvals.list()).toHaveLength(0)
    expect(r.driver.held().get(made.id as string)?.why).toBe('没派成:Claude 窗口上挂着对话框')
    await r.driver.reconcile()
    await flush()
    expect(r.approvals.list()).toHaveLength(0)
    // E#2:半小时后也不再自动问/自动派 —— 要派他在卡上点「派给 X」(driveNow)。
    r.clock.now = new Date('2026-09-25T07:31:00Z')
    await r.driver.reconcile()
    await flush()
    expect(r.approvals.list()).toHaveLength(0)
    expect((await r.driver.driveNow(made.id as string)).ok).toBe(false)
  })
})




describe('派出去的活交回来 → 叫进度核对当场核那一张', () => {
  it('第一次上线时已经交回来的不回放;之后新交回来的才叫', async () => {
    const r = rig()
    const made = await r.tasks.create({ title: '参赛网页架构收尾', assignee: 'codex', status: 'todo' })
    await r.tasks.update(made.id as string, { clientDispatch: { hand: 'window', family: 'codex', status: 'sent', at: '2026-09-25T05:42:05Z', text: 'x', reply_state: 'done', reply_at: '2026-09-25T06:27:39Z', reply: '已接着原有11屏补完导航' } })
    await r.driver.reconcile()
    expect(r.returns).toEqual([])
    await r.tasks.update(made.id as string, { clientDispatch: { hand: 'window', family: 'codex', status: 'sent', at: '2026-09-25T07:02:00Z', text: 'y', reply_state: 'done', reply_at: '2026-09-25T07:20:00Z', reply: '改好了' } })
    await r.driver.reconcile()
    expect(r.returns).toEqual([made.id])
    // 记账落盘(重启之后不再叫一遍)。
    const saved = JSON.parse(readFileSync(join(r.dir, 'drive.json'), 'utf8')) as { returns: Record<string, string> }
    expect(saved.returns[made.id as string]).toBe('window:2026-09-25T07:20:00Z')
  })
})

describe('指令与问句的字', () => {
  const card = { id: 't', title: '注册域名', status: 'todo' as const, assignee: 'codex' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '' }
  it('没看到进展:指令里明说,让它先看有关的文件和最近的改动再动手;问句里只说还没看到(他这会儿要答的是派不派,不是「说一句」)', () => {
    const none: TaskProgressView = { line: PROGRESS_NONE_LINE, state: 'none', basis: [], checked_at: '2026-09-25T07:00:00Z', by: 'rules' }
    expect(dispatchInstruction(card, none)).toContain('工作台没看到这件事的进展 —— 先看看跟这件事有关的文件和最近的改动')
    expect(askReason(card, none)).toBe('这张派给 Codex 开工?现在:还没看到这件事的进展')
    expect(askReason({ ...card, assignee: 'dsh' }, none)).toBe('这张交给事务官开工?现在:还没看到这件事的进展')
  })
  it('他亲口交代的描述带上(那是他的话);对不上的写明以证据为准', () => {
    const mismatch: TaskProgressView = { ...FOUND, state: 'mismatch', mismatch: '卡上写「架构还差一截」,会话里 11 屏已做完', waiting_on: 'agent' }
    const text = dispatchInstruction({ ...card, origin: 'user', desc: '域名用 aibooo.cn 的子域名' }, mismatch)
    expect(text).toContain('域名用 aibooo.cn 的子域名')
    expect(text).toContain('卡上写的和工作台看到的对不上:卡上写「架构还差一截」,会话里 11 屏已做完 —— 以看到的为准')
  })
})

/**
 * 卡 W 留的那一处(2026-09-25 卡 Z 补):驱动派活时的「这是什么活」原来没穿过去 ——
 * `run()` 调 `deps.dispatch` 不带 `kind`,派活那一层自己用纯函数 `jobKindOf` 再认一遍(不读额度、不读体检),
 * 于是「问他时说是写代码的活、派的时候当成聊天」是可能的。现在 `choicesFor` 回的那一个穿到 `run()`。
 */
