// @vitest-environment node
/**
 * 同事项四意图的真 HTTP 验收(2026-10-26,卡「事务官机制A:同事项补充改向加速撤回真实接续」;
 * 与同树另一会话的冲突上报 reconcile 后,三处机制缺口的落地也钉在这里):
 *
 * 一整条隔离的 8791(真 HTTP、真路由、真 clientKeys 台账;会话通道是内存假手但记下每一次
 * prompt 的 mode / cancel / clearQueued / running),验四件事:
 *   1. 四种意图在同一条事项的**真实生命周期**里可区分:queue / steer / cancel+clear 的落地不同、
 *      回执 fact / stopped / cleared 不同、卡上留言带结构化 intent;
 *   2. 改方向 = 先清掉队列里经工作台递进去的旧句(旧队列不复活,清不动就拒 stale-queue、
 *      零发送),再打断在跑的轮次;没在跑退化成 queue;
 *   3. 撤回 = 停轮 + 清旧队列 + 卡挪回待排,**一个字不进会话**(递了等于又把它叫醒);
 *      收场的卡撤不回;blocked 退一格到 todo;没会话也照回待排;
 *   4. 无二派 / 旧调用兼容:不带 intent 的调用 queue + 原话逐字不变、卡上不留痕;
 *      异常(model/host/stale-queue)零副作用;同号重放一次执行;服务重启后接续仍在。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createRulesService, type RulesService } from '../src/server/rules.ts'
import { ITEM_CONTINUE_BUTLER_KEY } from '../src/protocol.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-26T06:30:00.000Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 内存假会话手:记下每一次 prompt 的 mode、cancel、clearQueued、running 的编排。 */
interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  prompts: { session: string, mode: string, text: string }[]
  cancels: string[]
  clears: string[]
  relayed: { agent: string, sessionId: string, text: string }[]
  running: boolean
  cancelAvailable: boolean
  clearAvailable: boolean
  clearMode: 'ok' | 'partial'
  commentFail: undefined | 'all' | 'final-evidence'
  queued: string[]
  queuedByTask: Record<string, string[]>
  nextSayReject: 'model' | 'host' | 'bare-false' | undefined
  id: string
  rules: RulesService
  dir: string
}

async function serve(dir?: string): Promise<Harness> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'wb-item-intent-'))
  if (dir === undefined) dirs.push(root)
  let n = 0
  const tasks = createTasksService({ file: join(root, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const prompts: { session: string, mode: string, text: string }[] = []
  const cancels: string[] = []
  const clears: string[] = []
  const relayed: { agent: string, sessionId: string, text: string }[] = []
  const state = {
    running: true, cancelAvailable: true, clearAvailable: true, clearMode: 'ok' as 'ok' | 'partial',
    queuedByTask: {} as Record<string, string[]>,
    commentFail: undefined as undefined | 'all' | 'final-evidence',
    nextSayReject: undefined as 'model' | 'host' | 'bare-false' | undefined,
  }
  // 证据落盘失败的编排:all=留言一律写不进(先留证失败→拒删);final-evidence=只让终证写不进。
  const realComment = tasks.comment.bind(tasks)
  ;(tasks as unknown as { comment: typeof tasks.comment }).comment = ((taskId: string, input: Parameters<typeof tasks.comment>[1]) => {
    if (state.commentFail === 'all') return Promise.resolve({ ok: false as const, reason: '留言这会儿落不了盘' })
    if (state.commentFail === 'final-evidence' && typeof input.text === 'string' && input.text.includes('没清完')) {
      return Promise.resolve({ ok: false as const, reason: '留言这会儿落不了盘' })
    }
    return realComment(taskId, input)
  }) as typeof tasks.comment
  const rules = createRulesService({
    file: join(root, 'rules.json'),
    agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) },
  })
  await rules.load()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    butlerSession: {
      open: async () => 'sess-new',
      say: async (session: string, text: string, onRejected?: (reason: 'model' | 'host') => void, opts?: { mode?: 'queue' | 'steer' }) => {
        prompts.push({ session, mode: opts?.mode ?? 'queue', text })
        if (state.nextSayReject === 'bare-false') return false
        if (state.nextSayReject !== undefined) onRejected?.(state.nextSayReject)
        return state.nextSayReject === undefined
      },
      cancel: async (session: string) => {
        cancels.push(session)
        if (!state.cancelAvailable) return { ok: false, why: '这一版 DSH 停不了会话' }
        return state.running ? { ok: true, running: true } : { ok: true, running: false }
      },
      clearQueued: async (session: string, taskId: string, evidence: (texts: readonly string[]) => Promise<boolean>) => {
        clears.push(`${session}:${taskId}`)
        if (!state.clearAvailable) return undefined
        const q = state.queuedByTask[taskId] ?? []
        // 契约:先留证、后动手。证据写不进 → 一条不摘(refused),原文进 remaining。
        const evidenceOk = q.length === 0 ? true : await evidence(q)
        if (!evidenceOk) return { removed: [], remaining: q, incomplete: false, refused: 'evidence' as const }
        if (state.clearMode === 'partial' && q.length > 1) {
          // 模拟 updateQueue 摘第二条时抛错:第一条真摘掉,第二条清不动(原文证据都不丢)。
          const [first, ...rest] = q
          state.queuedByTask[taskId] = rest
          return { removed: [first as string], remaining: rest, incomplete: true }
        }
        state.queuedByTask[taskId] = []
        return { removed: q, remaining: [], incomplete: false }
      },
      running: (session: string) => { void session; return state.running },
    },
    sessionAnswer: {
      relay: async (agent: string, sessionId: string, text: string) => {
        relayed.push({ agent, sessionId, text })
        return { ok: true, route: 'window', mark: 'm1' }
      },
      relayReady: (agent: string) => agent === 'claude' ? { can: true } : { can: false, why: '这家这会儿送不进' },
    } as unknown as NonNullable<Parameters<typeof startWorkbenchServer>[0]['sessionAnswer']>,
    rules,
  })
  started.push(server)
  const created = await tasks.create({ title: '图谱显示修复', status: 'doing' })
  const id = created.id as string
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  const theId = id
  return {
    url: server.url, tasks, prompts, cancels, clears, relayed, id, rules, dir: root,    get running() { return state.running },
    set running(v: boolean) { state.running = v },
    get cancelAvailable() { return state.cancelAvailable },
    set cancelAvailable(v: boolean) { state.cancelAvailable = v },
    get clearAvailable() { return state.clearAvailable },
    set clearAvailable(v: boolean) { state.clearAvailable = v },
    get clearMode() { return state.clearMode },
    set clearMode(v: 'ok' | 'partial') { state.clearMode = v },
    get commentFail() { return state.commentFail },
    set commentFail(v: undefined | 'all' | 'final-evidence') { state.commentFail = v },
    /** 本事项(h.id)的排队旧句;queuedByTask 供多事项场景直接编排。 */
    get queued() { return state.queuedByTask[theId] ?? [] },
    set queued(v: string[]) { state.queuedByTask[theId] = v },
    get queuedByTask() { return state.queuedByTask },
    set queuedByTask(v: Record<string, string[]>) { state.queuedByTask = v },
    get nextSayReject() { return state.nextSayReject },
    set nextSayReject(v) { state.nextSayReject = v },
  } as unknown as Harness
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function cardOf(h: Harness) {
  return (await h.tasks.list()).tasks.find(one => one.id === h.id)!
}

describe('POST /butler/item/continue:四意图落地可区分', () => {
  it('★旧调用(不带 intent)→ queue、原话逐字不变、回包没有 intent 字段、卡上零留言', async () => {
    const h = await serve()
    h.running = false
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '顺便把 X 也办了' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'sent', target: ITEM_CONTINUE_BUTLER_KEY })
    expect(res.body.intent).toBeUndefined()
    expect(h.prompts).toEqual([{ session: 'sess-1', mode: 'queue', text: '顺便把 X 也办了' }])
    expect(h.cancels).toEqual([])
    expect(h.clears).toEqual([])
    expect((await cardOf(h)).comments ?? []).toEqual([])
  })

  it('★改方向 · 正在跑 → 先清旧队列再 steer,fact redirected,卡上结构化 intent 痕 + 旧句留存', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['旧话一:先按 A 方案', '旧话二:把 B 也带上']
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '别走那条路,改手动验收', intent: 'redirect' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'redirected', intent: 'redirect', cleared: 2 })
    expect(String(res.body.note)).toContain('打断')
    expect(String(res.body.note)).toContain('2 句旧话一并作废')
    // 旧队列真被作废(假手里的队列空了),然后才是 steer 那一句。
    expect(h.clears).toEqual([`sess-1:${h.id}`])
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.mode).toBe('steer')
    expect(h.prompts[0]?.text).toContain('【改方向')
    expect(h.prompts[0]?.text).toContain('别走那条路,改手动验收')
    expect(h.prompts[0]?.text).toContain('别派第二路')
    // 卡上留言:结构化 intent + 带框 + 旧句一句不丢。
    const last = (await cardOf(h)).comments?.at(-1)
    expect(last?.intent).toBe('redirect')
    expect(last?.text).toContain('【改方向')
    expect(last?.text).toContain('旧话一:先按 A 方案')
  })

  it('★改方向 · 没在跑 → 旧队列照清,steer 退化成 queue(没有要打断的,回执照实说)', async () => {
    const h = await serve()
    h.running = false
    h.queued = ['旧话一']
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '换个方向', intent: 'redirect' })
    expect(res.body).toMatchObject({ ok: true, fact: 'redirected', intent: 'redirect', cleared: 1 })
    expect(String(res.body.note)).toContain('没在跑')
    expect(String(res.body.note)).not.toContain('打断')
    expect(h.clears).toEqual([`sess-1:${h.id}`])
    expect(h.prompts[0]?.mode).toBe('queue')
  })

  it('加速 · 正在跑 → steer(不动队列:计划不变),fact sent,intent 回显', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['排队中的补充,催不改它']
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '今天就要', intent: 'hurry' })
    expect(res.body).toMatchObject({ ok: true, fact: 'sent', intent: 'hurry' })
    expect(String(res.body.note)).toContain('催')
    expect(h.clears).toEqual([])
    expect(h.prompts[0]?.mode).toBe('steer')
    expect(h.prompts[0]?.text).toContain('【加速')
    expect(h.prompts[0]?.text).toContain('别干等')
  })

  it('★撤回 · 正在跑 → 停轮 + 清旧队列 + 回待排;一个字不进会话', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['旧话一', '旧话二']
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先不做了', intent: 'recall' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'recalled', intent: 'recall', stopped: true, cleared: 2 })
    expect(String(res.body.note)).toContain('停住')
    expect(String(res.body.note)).toContain('挪回待排')
    expect(h.cancels).toEqual(['sess-1'])
    expect(h.clears).toEqual([`sess-1:${h.id}`])
    expect(h.prompts).toEqual([])
    const card = await cardOf(h)
    expect(card.status).toBe('backlog')
    const last = card.comments?.at(-1)
    expect(last?.intent).toBe('recall')
    expect(last?.text).toContain('【撤回')
    expect(last?.text).toContain('先不做了')
    expect(last?.text).toContain('旧话一')
  })

  it('撤回 · 没在跑 → 不用停(不调用 cancel),照样清队列、回待排;空原话也收', async () => {
    const h = await serve()
    h.running = false
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '', intent: 'recall' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'recalled', intent: 'recall', stopped: false })
    expect(String(res.body.note)).toContain('没在跑')
    expect(h.cancels).toEqual([])
    expect(h.prompts).toEqual([])
    expect((await cardOf(h)).status).toBe('backlog')
  })

  it('★撤回 · blocked 的卡 → 进路退一格回 todo(blocked 到不了 backlog)', async () => {
    const h = await serve()
    await h.tasks.move(h.id, 'blocked')
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先停', intent: 'recall' })
    expect(res.body).toMatchObject({ ok: true, fact: 'recalled' })
    expect((await cardOf(h)).status).toBe('todo')
  })

  it('★撤回 · 收场的卡(done)→ 挡在入口:什么都不会发生', async () => {
    const h = await serve()
    await h.tasks.move(h.id, 'done')
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先停', intent: 'recall' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'unsupported' })
    expect(h.cancels).toEqual([])
    expect(h.prompts).toEqual([])
    expect((await cardOf(h)).status).toBe('done')
  })

  it('★撤回 · 停不住(老宿主没有 cancel)→ 如实回 failed,零落地', async () => {
    const h = await serve()
    h.running = true
    h.cancelAvailable = false
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先不做了', intent: 'recall' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.note)).toContain('停不住')
    expect(h.prompts).toEqual([])
    expect(h.clears).toEqual([])
    const card = await cardOf(h)
    expect(card.comments ?? []).toEqual([])
    expect(card.status).toBe('doing')
  })

  it('★改方向 · 队列读不清/清不动(stale-queue)→ 拒发:零 prompt、卡不动、会话原样', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['旧话一']
    h.clearAvailable = false
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_stale_queue' })
    expect(h.prompts).toEqual([])
    expect((await cardOf(h)).status).toBe('doing')
  })

  it('★撤回 · 停住了但队列清不动 → 如实说停轮为真、撤回没办成;卡不挪、痕不落', async () => {
    const h = await serve()
    h.running = true
    h.clearAvailable = false
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先停', intent: 'recall' })
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_stale_queue', stopped: true })
    expect(h.cancels).toEqual(['sess-1'])
    expect(h.prompts).toEqual([])
    const card = await cardOf(h)
    expect(card.status).toBe('doing')
    expect(card.comments ?? []).toEqual([])
  })

  it('外部(relay)来源 + 非补充意图 → unsupported,话不外发,不假装已改向', async () => {
    const h = await serve()
    await h.tasks.update(h.id, { links: [{ agent: 'claude', session_id: 'c-1' }] })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '别做了', intent: 'recall', target: 'claude:c-1' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'unsupported', intent: 'recall' })
    expect(h.prompts).toEqual([])
    expect(h.relayed).toEqual([])
  })

  it('★同一条会话两件事:A 改方向只清 A 的排队句,B 的保留 —— B 随后改方向摘得动(验收缺陷 1)', async () => {
    const h = await serve()
    h.running = true
    const other = await h.tasks.create({ title: '同会话的另一件', status: 'doing' })
    const otherId = other.id as string
    await h.tasks.update(otherId, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
    h.queuedByTask = { [h.id]: ['A 的排队句'], [otherId]: ['B 的排队句'] }
    // A 改方向:只动 A 的。
    const a = await post(h.url, '/butler/item/continue', { id: h.id, text: 'A 换条路', intent: 'redirect' })
    expect(a.body).toMatchObject({ ok: true, fact: 'redirected', cleared: 1 })
    expect(h.clears).toEqual([`sess-1:${h.id}`])
    expect(h.queuedByTask[otherId]).toEqual(['B 的排队句'])
    const aCard = await cardOf(h)
    expect(aCard.comments?.at(-1)?.text).toContain('A 的排队句')
    expect(aCard.comments?.at(-1)?.text).not.toContain('B 的排队句')
    // B 随后改方向:它那句还在、真被清掉 —— A 的清没误伤 B。
    const b = await post(h.url, '/butler/item/continue', { id: otherId, text: 'B 也换', intent: 'redirect' })
    expect(b.body).toMatchObject({ ok: true, fact: 'redirected', cleared: 1 })
    const bCard = (await h.tasks.list()).tasks.find(one => one.id === otherId)!
    expect(bCard.comments?.at(-1)?.text).toContain('B 的排队句')
  })

  it('★清队列摘到一半失败 → 拒发但进度照实:已摘/没摘的原文都留在卡上,重试先清剩下的(验收缺陷 2)', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['第一句排队旧话', '第二句排队旧话']
    h.clearMode = 'partial'
    const first = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_stale_queue', cleared: 1 })
    expect(String(first.body.note)).toContain('1 句')
    expect(String(first.body.note)).toContain('清不动')
    expect(String(first.body.note)).not.toContain('原样没动')
    expect(h.prompts).toEqual([])
    // 原文证据:摘掉的和没摘动的,卡上同一条里都留着。
    const card = await cardOf(h)
    expect(card.status).toBe('doing')
    const evidence = card.comments?.at(-1)
    expect(evidence?.intent).toBe('redirect')
    expect(evidence?.text).toContain('第一句排队旧话')
    expect(evidence?.text).toContain('第二句排队旧话')
    expect(evidence?.text).toContain('没清动')
    // 重试(通道恢复):先清剩下的那一句,然后改方向落地。
    h.clearMode = 'ok'
    const retry = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(retry.body).toMatchObject({ ok: true, fact: 'redirected', cleared: 1 })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.mode).toBe('steer')
  })

  it('★证据落不了盘(先留证写不进)→ 拒绝清队列:一条没摘、零发送、回执不谎称已作废(验收二轮·/continue)', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['A1', 'A2']
    h.commentFail = 'all'
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_stale_queue', cleared: 0 })
    expect(String(res.body.note)).toContain('一条没动')
    expect(String(res.body.note)).not.toContain('已作废')
    // 真没摘:队列原样、零发送、卡上零留言。
    expect(h.queuedByTask[h.id]).toEqual(['A1', 'A2'])
    expect(h.prompts).toEqual([])
    expect((await cardOf(h)).comments ?? []).toEqual([])
  })

  it('★部分失败且终证落不了盘 → 照实可恢复:先留证已在卡(原文可核),回执不说「原样」不说「留住了进度」(验收二轮·/continue)', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['第一句排队旧话', '第二句排队旧话']
    h.clearMode = 'partial'
    h.commentFail = 'final-evidence'
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_stale_queue', cleared: 1 })
    expect(String(res.body.note)).toContain('1 句')
    expect(String(res.body.note)).toContain('清不动')
    expect(String(res.body.note)).not.toContain('原样没动')
    // 先留证在卡上(动手前写的):两条原文都查得到 —— 进度可恢复。
    const evidence = (await cardOf(h)).comments?.at(-1)
    expect(evidence?.text).toContain('先留证')
    expect(evidence?.text).toContain('第一句排队旧话')
    expect(evidence?.text).toContain('第二句排队旧话')
    // 恢复落盘 → 重试先清剩下的,改方向落地。
    h.commentFail = undefined
    const retry = await post(h.url, '/butler/item/continue', { id: h.id, text: '换条路', intent: 'redirect' })
    expect(retry.body).toMatchObject({ ok: true, fact: 'redirected', cleared: 1 })
  })

  it('★/say 证据落不了盘 → 拒删照实(409,队列没动、零发送);/say 撤回部分失败+重启 → 先留证在卡、重启后重试完成(验收二轮·/say)', async () => {
    // —— /say 拒删:
    const h = await serve()
    h.running = true
    h.queued = ['S1', 'S2']
    h.commentFail = 'all'
    const refused = await post(h.url, '/butler/item/say', { id: h.id, text: '别按原方案了', intent: 'redirect' })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: 'session_stale_queue' })
    expect(String(refused.body.error)).toContain('一条没动')
    expect(String(refused.body.error)).not.toContain('已作废')
    expect(h.queuedByTask[h.id]).toEqual(['S1', 'S2'])
    expect(h.prompts).toEqual([])
    // —— /say 撤回:清到一半,先留证落盘、终证失败,随后服务重启。
    h.commentFail = 'final-evidence'
    h.clearMode = 'partial'
    const partial = await post(h.url, '/butler/item/say', { id: h.id, text: '这件先停', intent: 'recall' })
    expect(partial.status).toBe(409)
    expect(partial.body).toMatchObject({ code: 'session_stale_queue', stopped: true })
    expect(String(partial.body.error)).toContain('1 句')
    expect(String(partial.body.error)).not.toContain('原样没动')
    // 关服重启(同一本 tasks.json):先留证的原文还在卡上。
    const dir = h.dir
    await started.pop()?.close()
    const revived = await serve(dir)
    const evidence = (await cardOf(revived)).comments?.find(one => one.text.includes('先留证'))
    expect(evidence?.text).toContain('S1')
    expect(evidence?.text).toContain('S2')
    // 重启后重试:真 DSH 的队列里还剩 S2(它从没被摘掉)—— 假手按此续态;先清剩下的那一句,撤回完成、卡回待排。
    revived.queued = ['S2']
    const retry = await post(revived.url, '/butler/item/say', { id: revived.id, text: '这件先停', intent: 'recall' })
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ ok: true, intent: 'recall', cleared: 1 })
    expect((await cardOf(revived)).status).toBe('backlog')
  })
})

describe('门与兼容', () => {
  it('intent 带错值 → 400,不静默当补充', async () => {
    const h = await serve()
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: 'x', intent: 'urgent' })
    expect(res.status).toBe(400)
    expect(h.prompts).toEqual([])
  })

  it('只留记录 + 意图 → 400(纯留言档不带意图)', async () => {
    const h = await serve()
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: 'x', record: true, intent: 'redirect' })
    expect(res.status).toBe(400)
    expect(h.prompts).toEqual([])
  })

  it('补充 / 改方向 / 加速不带原话 → 400(没有话可递是空动作)', async () => {
    const h = await serve()
    for (const intent of ['supplement', 'redirect', 'hurry']) {
      const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '', intent })
      expect(res.status).toBe(400)
    }
    expect(h.prompts).toEqual([])
  })

  it('★拒发(model)→ failed,意图的那句不落地:会话零发送、卡上零留言、规矩表零新增', async () => {
    const h = await serve()
    h.nextSayReject = 'model'
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '以后别在晚上派活', intent: 'redirect' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'model_alignment_failed' })
    const task = await cardOf(h)
    expect(task.comments ?? []).toEqual([])
    expect(h.rules.view().rules).toEqual([])
  })

  it('同一个 client_key 同包重试 → 真只打断一次,重放回第一次的回包', async () => {
    const h = await serve()
    h.running = true
    const body = { id: h.id, text: '改方向:换验收路径', intent: 'redirect', client_key: 'intent-retry-1' }
    const first = await post(h.url, '/butler/item/continue', body)
    const second = await post(h.url, '/butler/item/continue', body)
    expect(first.body).toMatchObject({ ok: true, fact: 'redirected' })
    expect(second.body.replayed).toBe(true)
    expect(second.body.fact).toBe('redirected')
    expect(h.prompts).toHaveLength(1)
    expect(h.cancels).toEqual([])
  })
})

describe('真实生命周期:重启后接续', () => {
  it('服务重启(同一 tasks 目录)→ 意图痕还在、改方向仍走得通', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-item-intent-restart-'))
    dirs.push(dir)
    const first = await serve(dir)
    await post(first.url, '/butler/item/continue', { id: first.id, text: '第一轮交代' })
    await post(first.url, '/butler/item/continue', { id: first.id, text: '先别干', intent: 'recall' })
    await started.pop()?.close()
    const second = await serve(dir)
    const tasksNow = (await second.tasks.list()).tasks
    expect(tasksNow.map(one => one.title)).toContain('图谱显示修复')
    // 重启前撤回留下的痕:状态 + 结构化 intent 留言都还在。
    const before = (await second.tasks.list()).tasks[0]!
    expect(before.status).toBe('backlog')
    expect(before.comments?.at(-1)?.intent).toBe('recall')
    const view = await get(second.url, `/butler/item/${second.id}/continue`)
    expect(view.status).toBe(200)
    expect((view.body.sources as { key: string }[]).map(one => one.key)).toContain(ITEM_CONTINUE_BUTLER_KEY)
    // 重启后改方向仍落地(steer 可区分)。
    second.running = true
    const res = await post(second.url, '/butler/item/continue', { id: second.id, text: '重启后改方向', intent: 'redirect' })
    expect(res.body).toMatchObject({ ok: true, fact: 'redirected', intent: 'redirect' })
    expect(second.prompts.some(one => one.mode === 'steer' && one.text.includes('重启后改方向'))).toBe(true)
  })
})

describe('POST /butler/item/say:程序来源同一句口', () => {
  it('带 redirect → 清队列 + steer,回包带 intent;显式意图卡上留痕(结构化)', async () => {
    const h = await serve()
    h.running = true
    h.queued = ['旧话一']
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '改方向,先合这一头', intent: 'redirect' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, intent: 'redirect' })
    expect(h.prompts[0]?.mode).toBe('steer')
    expect((await cardOf(h)).comments?.at(-1)?.intent).toBe('redirect')
  })

  it('显式 intent:补充 → 送达 + 卡上结构化 supplement 痕;隐式(旧调用)→ 零痕', async () => {
    const explicit = await serve()
    await post(explicit.url, '/butler/item/say', { id: explicit.id, text: '再把数据核一遍', intent: 'supplement' })
    expect(explicit.prompts[0]?.mode).toBe('queue')
    expect((await cardOf(explicit)).comments?.at(-1)?.intent).toBe('supplement')
    const implicit = await serve()
    const res = await post(implicit.url, '/butler/item/say', { id: implicit.id, text: '刚才那件事,顺便把 X 也办了' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: implicit.id, session_id: 'sess-1' })
    expect(implicit.prompts).toEqual([{ session: 'sess-1', mode: 'queue', text: '刚才那件事,顺便把 X 也办了' }])
    expect((await cardOf(implicit)).comments ?? []).toEqual([])
  })

  it('★撤回 · 没有会话的卡:没有要停的,照样回待排、照留痕(不在 say 梯里)', async () => {
    const h = await serve()
    await h.tasks.update(h.id, { conversation: null as never })
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '这件先停', intent: 'recall' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, intent: 'recall', stopped: false, cleared: 0 })
    expect(h.cancels).toEqual([])
    const card = await cardOf(h)
    expect(card.status).toBe('backlog')
    expect(card.comments?.at(-1)?.intent).toBe('recall')
  })

  it('★撤回 · 收场的卡 → 409 说清原因,什么都没发生', async () => {
    const h = await serve()
    await h.tasks.move(h.id, 'done')
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '这件先停', intent: 'recall' })
    expect(res.status).toBe(409)
    expect(h.cancels).toEqual([])
    expect(h.clears).toEqual([])
    expect((await cardOf(h)).status).toBe('done')
  })

  it('★改向清不动队列(stale-queue)→ 409 + code,零发送、零留言、卡不动', async () => {
    const h = await serve()
    h.clearAvailable = false
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '别按原方案了', intent: 'redirect' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'session_stale_queue' })
    expect(String(res.body.error)).toContain('没有发送')
    expect((await cardOf(h)).comments ?? []).toEqual([])
    expect((await cardOf(h)).status).toBe('doing')
  })

  it('append(固定流程补细节)+ 意图 → 400,那条 pure 路保持原样', async () => {
    const h = await serve()
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '七八岁吧', append: true, intent: 'redirect' })
    expect(res.status).toBe(400)
    expect(h.prompts).toEqual([])
  })
})
