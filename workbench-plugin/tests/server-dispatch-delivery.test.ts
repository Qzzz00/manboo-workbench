// @vitest-environment node
/**
 * **派活成功不回电话,但卡上要一眼看得出派出去了没有**
 * (2026-09-30 维护者拍板;`docs/设计-重构-接缝与技术债-2026-09-30.md` 根子 1 与 3)。
 *
 * 这一份钉四件事:
 * ① 那一格怎么算出来(`clientDispatchDelivery` / `clientDeliveryLine`,协议层一处,手机照抄);
 * ② **真送进去的那个包记在卡上**,读回话按它读(Air 上只有 `com.work.pc.doubao`);
 * ③ 派活启动抛错不再静悄悄:卡上挂「运行失败」写清原话;
 * ④ 超时 / 没看到那一句 = 失败(挂「运行失败」→ 现成的来电规矩会打电话),不再挪进「等我确认」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import { clientDeliveryLine, clientDispatchDelivery } from '../src/protocol.ts'
import type { ClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchRunDeps } from '../src/server/dispatchRun.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { createTasksService, sanitizeClientDispatch } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

let clock = Date.parse('2026-09-30T20:00:00Z')

const AT = '2026-09-30T20:00:00.000Z'
function dispatch(over: Partial<TaskClientDispatch> = {}): TaskClientDispatch {
  return { hand: 'window', family: 'doubao', status: 'sent', at: AT, text: '【工作台派活 000001】总结一下', ...over }
}

/** Air 那台:豆包这一家只装着「豆包办公」(`com.work.pc.doubao`),主包 `com.bot.pc.doubao` 没装。 */
const AIR_DOUBAO: DispatchTarget = {
  id: 'doubao',
  title: '豆包办公',
  bundle_id: 'com.work.pc.doubao',
  hands: ['window'],
  aliases: ['豆包'],
  from_registry: true,
}

interface Rig {
  tasks: ReturnType<typeof createTasksService>
  runner: ReturnType<typeof createDispatchRunner>
  /** 壳收到的每一条请求(读回话按哪个包读,就查这里)。 */
  asked: readonly Record<string, unknown>[]
  reads: Record<string, unknown>[]
}

function rig(opts: { sendThrows?: boolean, bundleId?: string } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-delivery-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-00000${++n}` })
  const reads: Record<string, unknown>[] = []
  /**
   * ★ 2026-10-02(卡「引擎接线与删复制品」):盯窗那一拍走 `engine.read` ——
   * 挑哪个包、读 `read_reply`、豆包办公那一路再读一次整扇窗,全在引擎与窗口适配器一处。
   * 所以这一份换成「假壳 + 真引擎」(`engineHarness`),`asked` 就是**假壳真收到的那几条**:
   * 「派给哪个包、就读哪个包」这一条于是是端到端钉住的,不再隔着一只假手。
   */
  const h = engineHarness({
    now: () => new Date(clock),
    // Air 那台:豆包这一家只装着「豆包办公」(主包 `com.bot.pc.doubao` 没装)。
    installed: () => [{ bundle_id: 'com.work.pc.doubao', name: '豆包工作', running: true }],
    reply: req => (req.op === 'read_reply' ? (reads.shift() ?? { found: false, busy: false }) : {}),
  })
  const clientDispatch: ClientDispatch = {
    async send(input) {
      if (opts.sendThrows === true) throw new Error('壳那边炸了')
      return {
        ok: true,
        bundle_id: opts.bundleId ?? 'com.work.pc.doubao',
        dispatch: {
          hand: 'window', family: input.family as TaskClientDispatch['family'], status: 'sent',
          at: new Date(clock).toISOString(), text: input.text, submitted: true, method: 'ax_value',
          seen_at: new Date(clock).toISOString(),
        },
        baseline: [],
      }
    },
  }
  const deps: DispatchRunDeps = {
    tasks,
    /*
     * 壳这一格只剩一件事:**旧壳不会「先开新对话」就不送**那一道门(`dispatchRun` 自己判)。
     * 读窗、送字一个都不经它了,所以 `request` 这一下在这条管线上压根不会被叫到。
     */
    helper: {
      connected: () => true,
      supports: (cap: string) => ['new_conversation', 'read_reply'].includes(cap),
      request: async () => ({}),
    },
    engine: h.engine,
    clientDispatch,
    readFile: async () => undefined,
    sessions: () => [],
    targets: () => [AIR_DOUBAO],
    now: () => new Date(clock),
    setTimer: () => 'timer',
    clearTimer: () => {},
    notSeenMs: 60_000,
    replyTimeoutMs: 600_000,
  }
  return { tasks, runner: createDispatchRunner(deps), asked: h.requests as unknown as readonly Record<string, unknown>[], reads }
}

async function newItem(r: Rig): Promise<string> {
  const created = await r.tasks.create({ title: '[派活] 总结一下', direction: 'mine', status: 'todo' })
  return created.id as string
}

async function card(r: Rig, id: string) {
  return (await r.tasks.list()).tasks.find(one => one.id === id)
}

describe('卡上那一格:派出去了没有', () => {
  it('★四档各说一句人话', () => {
    expect(clientDispatchDelivery(dispatch({ seen_at: AT }))).toBe('seen')
    expect(clientDeliveryLine(dispatch({ seen_at: AT }))).toBe('已派出 · 豆包办公那边看到了')
    expect(clientDispatchDelivery(dispatch())).toBe('unconfirmed')
    expect(clientDeliveryLine(dispatch())).toBe('按了发送,还没在豆包办公那边看到 —— 我在盯着')
    expect(clientDispatchDelivery(dispatch({ status: 'typed' }))).toBe('typed')
    expect(clientDeliveryLine(dispatch({ status: 'typed' }))).toBe('没派出去:字写进豆包办公的输入框了,没发出去')
    expect(clientDispatchDelivery(dispatch({ status: 'failed', reason: '找不到窗口' }))).toBe('failed')
    expect(clientDeliveryLine(dispatch({ status: 'failed', reason: '找不到窗口' }))).toBe('没派出去:找不到窗口')
  })

  it('★回答都收回来了就是看到过(老记录没有 seen_at 也不冤枉它)', () => {
    expect(clientDispatchDelivery(dispatch({ reply_state: 'done', reply: '好' }))).toBe('seen')
  })

  it('★登记表里那一家的名字优先(卡 Z:新接上一家用它自己的名字)', () => {
    expect(clientDeliveryLine(dispatch({ seen_at: AT }), '豆包(办公版)')).toBe('已派出 · 豆包(办公版)那边看到了')
  })

  it('★这三格读盘时留得住(包、看见的时刻、没核上那一句)', () => {
    const cleaned = sanitizeClientDispatch({
      ...dispatch(), bundle_id: 'com.work.pc.doubao', seen_at: AT, confirm_note: '按了发送,可这会儿还没在它对话区里看见这句话',
    })
    expect(cleaned).toMatchObject({ bundle_id: 'com.work.pc.doubao', seen_at: AT })
    expect(cleaned?.confirm_note).toContain('还没在它对话区里看见')
  })

  it('★没发出去的草稿存哪了,读盘时留得住(卡 DB)', () => {
    const draft = { saved: true, saved_to: '/tmp/drafts/doubao-1.txt', returned: false, note: '你没发的那句我存在这里了' }
    expect(sanitizeClientDispatch({ ...dispatch(), draft })?.draft).toEqual(draft)
    const unsaved = { saved: false, returned: false, note: '没存住' }
    expect(sanitizeClientDispatch({ ...dispatch(), draft: unsaved })?.draft).toEqual(unsaved)
  })

  it('★草稿那一格长得不对:只挑掉这一格,卡留着', () => {
    for (const bad of [
      'x',
      { saved: 'yes', returned: false, note: 'n' },
      { saved: true, returned: 1, note: 'n' },
      { saved: true, returned: false },
      { saved: true, saved_to: 3, returned: false, note: 'n' },
    ]) {
      const cleaned = sanitizeClientDispatch({ ...dispatch(), draft: bad })
      expect(cleaned?.text).toBe(dispatch().text)
      expect(cleaned).not.toHaveProperty('draft')
    }
  })
})

describe('Air 那台(只装着豆包办公):派给哪个包,就读哪个包', () => {
  it('★送出去的那个包记在卡上,读回话按它读(不按家名回主包)', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'doubao', said: '总结一下' })
    const task = await card(r, id)
    expect(task?.client_dispatch?.bundle_id).toBe('com.work.pc.doubao')
    await r.runner.tick()
    expect(r.asked.map(one => one.bundle_id)).toContain('com.work.pc.doubao')
    expect(r.asked.some(one => one.bundle_id === 'com.bot.pc.doubao')).toBe(false)
  })

  it('★老记录(没记包)照旧按登记表那一家的包读', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'doubao', said: '总结一下' })
    const task = await card(r, id)
    const old = { ...(task?.client_dispatch as TaskClientDispatch) }
    delete (old as { bundle_id?: string }).bundle_id
    await r.tasks.update(id, { clientDispatch: old })
    await r.runner.tick()
    expect(r.asked.map(one => one.bundle_id)).toContain('com.work.pc.doubao')
  })
})

describe('不再有静悄悄的失败', () => {
  it('★派活启动抛错:卡上挂「运行失败」、写清原话(以前只回一句 ok:false,卡上什么都没有)', async () => {
    const r = rig({ sendThrows: true })
    const id = await newItem(r)
    const started = await r.runner.start(id, { family: 'doubao', said: '总结一下' })
    expect(started.ok).toBe(false)
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.note).toContain('壳那边炸了')
  })

  it('★送出去一直没在它对话区里看到那一句 = 失败(挂「运行失败」,来电规矩据此打电话),不进「等我确认」', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'doubao', said: '总结一下' })
    // 送出那一刻壳核上了(seen_at),这里把它抹掉:模拟「按了发送、始终没核上」。
    const sent = await card(r, id)
    const never = { ...(sent?.client_dispatch as TaskClientDispatch) }
    delete (never as { seen_at?: string }).seen_at
    await r.tasks.update(id, { clientDispatch: never })
    clock += 61_000
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.client_dispatch?.reply_state).toBe('unreadable')
    expect(clientDispatchDelivery(task?.client_dispatch as TaskClientDispatch)).toBe('unconfirmed')
    clock -= 61_000
  })

  it('★等过头也算失败(卡上看得见,不是一张安安静静的「等你确认」)', async () => {
    const r = rig()
    const id = await newItem(r)
    await r.runner.start(id, { family: 'doubao', said: '总结一下' })
    r.reads.push({ found: true, busy: true, texts: ['【工作台派活 000001】总结一下', '我先想想'] })
    await r.runner.tick()
    clock += 700_000
    await r.runner.tick()
    const task = await card(r, id)
    expect(task?.status).toBe('blocked')
    expect(task?.block_reason).toBe('error')
    expect(task?.note).toContain('没读到它说完')
    clock -= 700_000
  })
})
