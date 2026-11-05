// @vitest-environment node
/**
 * `GET /butler/item/:id/continue` 与 `POST /butler/item/continue`(2026-10-23,卡 A `t-0c770bc0`)。
 *
 * 走一整条隔离的 8791(真 HTTP、内存假会话通道 / 假捎话手):
 *   - 来源清单:事务官会话 + links 里两条外部会话,能续 / 不能续各说各的;
 *   - record 档 → 只记留言(fact:saved),一个字都不往外发;
 *   - 目标明确 → 发到那条来源;不带目标多条 → pick(不猜最新);目标不认识 → 失败并说清;
 *   - relay 三档:送到(sent)/ 留言等它醒(kept)/ 这会儿走不通(unsupported);
 *   - 同一个 client_key 发两遍 → 真只发一遍(请求号台账,重连重试不重复执行)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayResult } from '../src/server/sessionAnswer.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createRulesService, type RulesService } from '../src/server/rules.ts'
import { ITEM_CONTINUE_BUTLER_KEY } from '../src/protocol.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-23T07:30:00.000Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  said: { session: string, text: string }[]
  relayed: { agent: string, sessionId: string, text: string }[]
  nextRelay: RelayResult
  /** 编排 butler say 的下一拍:undefined=成功;'model'/'host'=带分类拒发;'bare-false'=只回 false(会话没了)。 */
  nextSayReject: 'model' | 'host' | 'bare-false' | undefined
  id: string
  rules: RulesService
}

async function serve(over: { withConversation?: boolean, withLinks?: boolean, blockRelay?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-item-continue-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const said: { session: string, text: string }[] = []
  const relayed: { agent: string, sessionId: string, text: string }[] = []
  let nextRelay: RelayResult = { ok: true, route: 'window', mark: 'm1' }
  let nextSayReject: 'model' | 'host' | 'bare-false' | undefined
  // 真规矩表(复审 Important 5):record / 失败 / 歧义那几句**不许**被激活成长期规矩。
  const rules = createRulesService({
    file: join(dir, 'rules.json'),
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
      say: async (session: string, text: string, onRejected?: (reason: 'model' | 'host') => void) => {
        said.push({ session, text })
        if (nextSayReject === 'bare-false') return false
        if (nextSayReject !== undefined) onRejected?.(nextSayReject)
        return nextSayReject === undefined
      },
    },
    sessionAnswer: {
      relay: async (agent: string, sessionId: string, text: string) => {
        relayed.push({ agent, sessionId, text })
        return nextRelay
      },
      relayReady: (agent: string) => agent === 'claude' && over.blockRelay !== true
        ? { can: true }
        : { can: false, why: '这家这会儿送不进' },
    } as unknown as NonNullable<Parameters<typeof startWorkbenchServer>[0]['sessionAnswer']>,
    rules,
  })
  started.push(server)
  const created = await tasks.create({ title: '梳理报告', status: 'doing' })
  const id = created.id as string
  if (over.withConversation !== false) await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  if (over.withLinks === true) {
    await tasks.update(id, {
      links: [{ agent: 'claude', session_id: 'c-1' }, { agent: 'codex', session_id: 'x-1' }],
    })
  }
  return {
    url: server.url, tasks, said, relayed, id, rules,
    get nextRelay() { return nextRelay },
    set nextRelay(v: RelayResult) { nextRelay = v },
    get nextSayReject() { return nextSayReject },
    set nextSayReject(v: 'model' | 'host' | 'bare-false' | undefined) { nextSayReject = v },
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

describe('GET /butler/item/:id/continue:来源清单', () => {
  it('事务官会话 + 两条外部会话:能续 / 不能续各说各的', async () => {
    const h = await serve({ withLinks: true })
    const res = await get(h.url, `/butler/item/${h.id}/continue`)
    expect(res.status).toBe(200)
    const view = res.body as { id: string, sources: { key: string, title: string, action: Record<string, unknown> }[] }
    expect(view.id).toBe(h.id)
    expect(view.sources.map(one => [one.key, one.action.kind])).toEqual([
      [ITEM_CONTINUE_BUTLER_KEY, 'butler'],
      ['claude:c-1', 'relay'],
      ['codex:x-1', 'none'],
    ])
    expect(view.sources[2]?.action.why).toBe('这家这会儿送不进')
  })

  it('没有会话也没挂外部会话 → 来源空,note 说清(普通记录仍可以)', async () => {
    const h = await serve({ withConversation: false })
    const res = await get(h.url, `/butler/item/${h.id}/continue`)
    expect(res.status).toBe(200)
    expect(res.body.sources).toEqual([])
    expect(String(res.body.note)).toContain('只留一句')
  })

  it('没有这张卡 → 404', async () => {
    const h = await serve()
    const res = await get(h.url, '/butler/item/t-nope/continue')
    expect(res.status).toBe(404)
  })
})

describe('POST /butler/item/continue:动作与结果', () => {
  it('★record 档 → 只记留言(saved),一个字都不往外发', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '先记一句', record: true })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'saved' })
    expect(h.said).toHaveLength(0)
    expect(h.relayed).toHaveLength(0)
    const card = (await h.tasks.list()).tasks[0]
    expect((card?.comments ?? []).map(one => one.text)).toContain('先记一句')
  })

  it('★不带目标、只有事务官会话能续 → 直接说进那条会话(sent)', async () => {
    const h = await serve()
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '接着做' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, fact: 'sent', target: ITEM_CONTINUE_BUTLER_KEY })
    expect(h.said).toEqual([{ session: 'sess-1', text: '接着做' }])
  })

  it('★指明外部会话 → 走 relay 那条路,原话一字不改', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '补一句材料', target: 'claude:c-1' })
    expect(res.body).toMatchObject({ ok: true, fact: 'sent', target: 'claude:c-1' })
    expect(h.relayed).toEqual([{ agent: 'claude', sessionId: 'c-1', text: '补一句材料' }])
    expect(h.said).toHaveLength(0)
  })

  it('★不带目标、能续的多条 → pick,候选列出来,不猜最新、一个字都不发', async () => {
    const h = await serve({ withLinks: true })
    // 两条都能续:外部那条也放行
    h.nextRelay = { ok: true, route: 'window', mark: 'm' }
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '该发给谁?' })
    expect(res.body).toMatchObject({ ok: false, fact: 'pick' })
    expect((res.body.candidates as { key: string }[]).map(one => one.key)).toEqual([ITEM_CONTINUE_BUTLER_KEY, 'claude:c-1'])
    expect(h.said).toHaveLength(0)
    expect(h.relayed).toHaveLength(0)
  })

  it('目标键不认识 → 失败并说清,不掉进别的会话', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '喂', target: 'grok:z-9' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'failed' })
    expect(String(res.body.note)).toContain('不认识这条来源')
    expect(h.said).toHaveLength(0)
    expect(h.relayed).toHaveLength(0)
  })

  it('目标这会儿不能续 → unsupported + 那句为什么', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '喂', target: 'codex:x-1' })
    expect(res.body).toMatchObject({ ok: false, fact: 'unsupported', note: '这家这会儿送不进' })
  })

  it('★会话没开着 → relay 留言排上队,回 kept(暂存待上线,不是失败)', async () => {
    const h = await serve({ withConversation: false, withLinks: true })
    h.nextRelay = { ok: true, route: 'window', mark: 'm', sessionClosed: true, note: '那条会话没开着,这句我留着,它一开就送进去' }
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '醒了再看', target: 'claude:c-1' })
    expect(res.body).toMatchObject({ ok: true, fact: 'kept', delivered: 'kept' })
    expect(res.body.note).toBe('那条会话没开着,这句我留着,它一开就送进去')
  })

  it('一条能续的都没有 → unsupported,note 给可回溯的替代', async () => {
    const h = await serve({ withConversation: false, withLinks: true, blockRelay: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '喂' })
    expect(res.body).toMatchObject({ ok: false, fact: 'unsupported' })
  })

  it('★同一个 client_key 发两遍 → 真只发一遍,回包一样(断线重试不重复执行)', async () => {
    const h = await serve()
    const first = await post(h.url, '/butler/item/continue', { id: h.id, text: '同一句', client_key: 'ph-1' })
    const second = await post(h.url, '/butler/item/continue', { id: h.id, text: '同一句', client_key: 'ph-1' })
    // 台账按号重放第一次的回包(标 replayed:true),**真不再执行**:通道只收到一句。
    expect(second.body).toEqual({ ...first.body, replayed: true })
    expect(h.said).toHaveLength(1)
  })

  it('空文本 / 超长 → 400', async () => {
    const h = await serve()
    expect((await post(h.url, '/butler/item/continue', { id: h.id, text: '' })).status).toBe(400)
    expect((await post(h.url, '/butler/item/continue', { id: h.id, text: '字'.repeat(4001) })).status).toBe(400)
  })
})

describe('record / 失败 / 歧义那几句,不激活长期规矩(2026-10-23 复审 Important 5)', () => {
  const RULE_TEXT = '以后别在晚上派活'

  it('★record(只留记录)带规矩形的字 → 只落留言,规矩表一条都不进', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: RULE_TEXT, record: true })
    expect(res.body).toMatchObject({ ok: true, fact: 'saved' })
    expect((await h.rules.counting())).toHaveLength(0)
    expect(h.said).toHaveLength(0)
    expect(h.relayed).toHaveLength(0)
  })

  it('★发送没办成(unsupported)→ 那句规矩不生效(话没送进去,规矩不许先进表)', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: RULE_TEXT, target: 'codex:x-1' })
    expect(res.body).toMatchObject({ ok: false, fact: 'unsupported' })
    expect((await h.rules.counting())).toHaveLength(0)
  })

  it('★歧义(pick)那一句 → 规矩不生效(还没选定发给谁,更不算生效指令)', async () => {
    const h = await serve({ withLinks: true })
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: RULE_TEXT })
    expect(res.body).toMatchObject({ ok: false, fact: 'pick' })
    expect((await h.rules.counting())).toHaveLength(0)
  })

  it('对照:真送进事务官会话的那句规矩 → 当场生效(只留记录那条路之外的老规矩没松)', async () => {
    const h = await serve()
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: RULE_TEXT })
    expect(res.body).toMatchObject({ ok: true, fact: 'sent' })
    expect((await h.rules.counting())).toHaveLength(1)
  })
})

describe('Key 最终拒发分类(2026-10-23 晚,吸收 main 787f4d8f8):say/continue 共用,零发送零副作用', () => {
  it('★/butler/item/say:model 拒发 → 409 + code,一句话没发送、原事项和会话保留', async () => {
    const h = await serve()
    h.nextSayReject = 'model'
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '接着做' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'model_alignment_failed' })
    expect(String(res.body.error)).toContain('这句话没有发送')
    expect(String(res.body.error)).toContain('原事项和会话保留')
    // 零副作用:卡没变、没留留言。
    expect(((await h.tasks.list()).tasks[0])?.comments ?? []).toHaveLength(0)
  })

  it('★/butler/item/say:host 拒发 → 409 + code session_send_failed', async () => {
    const h = await serve()
    h.nextSayReject = 'host'
    const res = await post(h.url, '/butler/item/say', { id: h.id, text: '接着做' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'session_send_failed' })
  })

  it('★/butler/item/continue(事务官来源):model 拒发 → failed + 同一 code 与原文,零规矩零留言', async () => {
    const h = await serve()
    h.nextSayReject = 'model'
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '以后别在晚上派活' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', code: 'model_alignment_failed', target: 'butler' })
    expect(res.body.note).toBe('当前模型还没完成应用，这句话没有发送；原事项和会话保留，请重试模型设置。')
    // 没送进去:规矩/留言都不许多。
    expect((await h.rules.counting()).filter(one => one.status !== 'reverted')).toHaveLength(0)
    expect(((await h.tasks.list()).tasks[0])?.comments ?? []).toHaveLength(0)
  })

  it('★/butler/item/continue:host 拒发 → failed + session_send_failed', async () => {
    const h = await serve()
    h.nextSayReject = 'host'
    const hostRes = await post(h.url, '/butler/item/continue', { id: h.id, text: '喂' })
    expect(hostRes.body).toMatchObject({ ok: false, fact: 'failed', code: 'session_send_failed' })
  })

  it('★say 只回 false、不调 onRejected = 会话不存在的老边界:failed、无 code、不许降级新建', async () => {
    const h = await serve()
    h.nextSayReject = 'bare-false'
    const res = await post(h.url, '/butler/item/continue', { id: h.id, text: '喂' })
    expect(res.body).toMatchObject({ ok: false, fact: 'failed', target: 'butler' })
    expect(res.body.code).toBeUndefined()
    expect(res.body.note).toBe('这条会话在 DSH 里已经没了')
    // 老边界:没有偷开新会话(事项仍只有原来那条会话)。
    expect(((await h.tasks.list()).tasks[0])?.conversation?.session_id).toBe('sess-1')
  })
})
