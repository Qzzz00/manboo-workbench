// @vitest-environment node
/**
 * 重派 / 退修的派发词带上补话、验收条件与轮次(2026-10-28,卡「重派派发词带补话与轮次」)。
 *
 * 0.4.170 真机第二句:中枢出了 reassign(小K,重跑)+ supplement,板上 confirm → doing,补话落卡,
 * 可重派拼出来的派发词里**一个字都没有**那句退修要求 —— 小K 原样又报了一遍「可合并」。
 * 这里钉住:
 * - 卡已有一轮交回(confirm),重派 → 新一轮派发词含补话原句、含「第 2 轮」、含上一轮的可合并号;
 * - 首派(没有上一轮)→ 派发词没有「上一轮」「退修」字样,与改前逐字相同(守旧);
 * - 上一轮在独立工作区改过的(分支在卡上):分支一并带上。
 * 一个真窗口、一个真进程都不碰(窗口手是假壳,回话由假的引擎读回来)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { AdapterReadResult, Job } from '../src/server/engine/adapter.ts'
import type { ClientDispatch, SendToClientInput } from '../src/server/dispatchSend.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { dispatchPrompt } from '../src/server/dispatchReply.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

async function until(what: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await what()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`等不到:${label}`)
}

function world(reply: string) {
  const clock = { t: Date.parse('2026-10-28T08:00:00Z') }
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-rework-'))
  dirs.push(dir)
  let seq = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock.t / 1000), newId: () => `t-1028${++seq}` })
  const sent: SendToClientInput[] = []
  const clientDispatch: ClientDispatch = {
    async send(input) {
      sent.push(input)
      const dispatch: TaskClientDispatch = {
        hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
        at: new Date(clock.t).toISOString(), text: input.text, submitted: true, method: 'paste', baseline: [],
      }
      return { ok: true, dispatch, baseline: [] }
    },
  }
  const marker = (id: string) => `工作台派活 ${id.replace(/^t-/, '').slice(0, 6)}`
  const runner = createDispatchRunner({
    tasks,
    engine: {
      read: async (job: Job): Promise<AdapterReadResult> =>
        job.marks?.[0] !== undefined && job.text.includes(job.marks[0]) && job.expect === 'reply'
          ? { via: 'window', evidence: 'window', reply }
          : { via: 'window', evidence: 'none' },
    },
    clientDispatch,
    readFile: async () => undefined,
    sessions: () => [],
    now: () => new Date(clock.t),
    setTimer: () => 'timer',
    clearTimer: () => {},
  })
  const find = async (id: string) => (await tasks.list()).tasks.find(one => one.id === id)
  return { clock, tasks, runner, sent, find, marker }
}

const FIRST_REPLY = '做完:收起球与计数已并上。\n可合并:a9507089c'
const SUPPLEMENT = '以 main 上的 useCollabRuns 为准,只并上收起球与 runningCountOf,合 main 后再交。'

describe('重派 / 退修的派发词', () => {
  it('★已有一轮交回(confirm):重派时派发词含补话原句、「第 2 轮」、上一轮的可合并号;评论在派发前已落卡', async () => {
    const w = world(FIRST_REPLY)
    const made = await w.tasks.create({ title: '收起球与计数', direction: 'mine', status: 'todo' })
    const id = made.id as string
    // 第一轮:首派,回答收回来,卡进「等我确认」(定时器是假的,巡检手动泵)。
    await w.runner.start(id, { family: 'kimi', said: '把收起球与 runningCountOf 并上' })
    await until(async () => { void w.runner.tick(); return (await w.find(id))?.status === 'confirm' }, '第一轮交回收回来')
    expect(w.sent).toHaveLength(1)
    // 退修:板上 confirm → doing 之前,她那句补话先落卡(中枢 supplement 的顺序由 hub-execute 用例钉住)。
    // 时间往后拨一分钟:补话落在上一轮派发**之后**(同秒不算之后)。
    w.clock.t += 60_000
    await w.tasks.comment(id, { by: 'user', text: SUPPLEMENT })
    // 重派(同一家,新起一轮)。
    await w.runner.start(id, { family: 'kimi', said: '把收起球与 runningCountOf 并上' })
    expect(w.sent).toHaveLength(2)
    const second = w.sent[1]!.text
    // 补话原句逐条带上。
    expect(second).toContain(SUPPLEMENT)
    // 轮次:卡上 round(服务端那一份)+ 1,不另记一本。
    expect(second).toContain('第 2 轮')
    // 上一轮交回的可合并号。
    expect(second).toContain('可合并 a9507089c')
    // 上一轮交回时间之后落的评论才算;第一轮派发词里不含补话。
    expect(w.sent[0]!.text).not.toContain(SUPPLEMENT)
  })

  it('★首派(没有上一轮):派发词没有「上一轮」「退修」字样', async () => {
    const w = world(FIRST_REPLY)
    const made = await w.tasks.create({ title: '首派那件', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await w.runner.start(id, { family: 'kimi', said: '做这件事' })
    expect(w.sent).toHaveLength(1)
    const first = w.sent[0]!.text
    expect(first).not.toContain('上一轮')
    expect(first).not.toContain('退修')
    expect(first).not.toContain('第 2 轮')
    // 与改前逐字相同:dispatchPrompt 不带 rework 字段时的原样输出。
    expect(first).toBe(`${dispatchPrompt({ taskId: id, said: '做这件事' })}\n\n本次分工依据：按默认推荐挑的;额度与候选未核实`)
  })

  it('★上一轮在独立工作区改过的:重派时把分支一并带上', async () => {
    const w = world(FIRST_REPLY)
    const made = await w.tasks.create({ title: '独立工作区那件', direction: 'mine', status: 'todo' })
    const id = made.id as string
    await w.runner.start(id, { family: 'kimi', said: '改一下' })
    await until(async () => { void w.runner.tick(); return (await w.find(id))?.status === 'confirm' }, '第一轮交回收回来')
    // 命令行那一轮在卡上留着分支(独立工作区);重派时它要在派发词里露出来。
    // 读侧体检认 `cwd`(命令行那一次活在哪个目录里干),缺了整条按没有读。
    w.clock.t += 60_000
    const cliRound = {
      family: 'kimi' as const, status: 'done' as const, hand: 'cli' as const,
      cwd: '/tmp/wb-dispatch-rework-worktree',
      started_at: new Date(w.clock.t).toISOString(), ended_at: new Date(w.clock.t).toISOString(),
      reply: FIRST_REPLY, branch: 'kimi/收起球与计数',
    }
    await w.tasks.update(id, { dispatch: cliRound, clientDispatch: null })
    await w.runner.start(id, { family: 'kimi', said: '改一下' })
    const second = w.sent[1]!.text
    expect(second).toContain('分支 kimi/收起球与计数')
    expect(second).toContain('可合并 a9507089c')
  })
})

describe('dispatchPrompt 的退修段(一处拼,首派同源)', () => {
  it('带 rework:段落在交代行之前(回答复述退修要求不算「夹带指令」),补话逐条原样', () => {
    const text = dispatchPrompt({
      taskId: 't-491e7a2e', said: '把收起球并上',
      rework: { round: 2, merge: 'a9507089c', branch: 'kimi/x', supplements: [SUPPLEMENT, '顺带补一条用例'] },
    })
    const saidLine = text.indexOf('把收起球并上')
    const reworkLine = text.indexOf('这是第 2 轮')
    const noteLine = text.indexOf('这是工作台转交的活')
    expect(reworkLine).toBeGreaterThan(saidLine)
    expect(reworkLine).toBeLessThan(noteLine)
    expect(text).toContain(`- ${SUPPLEMENT}`)
    expect(text).toContain('- 顺带补一条用例')
    expect(text).toContain('可合并 a9507089c')
    expect(text).toContain('分支 kimi/x')
    expect(text).toContain('退修要求')
  })

  it('认不出可合并号 / 分支时,带上一轮交回的开头一句', () => {
    const text = dispatchPrompt({
      taskId: 't-491e7a2e', said: '重做',
      rework: { round: 3, replyHead: '做完:改了一半,剩下的接不上', supplements: [] },
    })
    expect(text).toContain('第 3 轮')
    expect(text).toContain('做完:改了一半')
  })
})
