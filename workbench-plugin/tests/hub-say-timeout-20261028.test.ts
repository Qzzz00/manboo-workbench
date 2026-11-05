// @vitest-environment node
/**
 * 悬浮窗 say 挂住与超时(2026-10-28 卡)的服务端一半:
 * 用例 2 —— 中枢某一步(假手让 execute 永不返回)→ 总时限内照回 200,say.screen 含「卡在」与那一步的名字,
 *          say 账里有 收到 / 模型回了 / 执行开始 的打点(再加一笔 timeout)。
 * 用例 3 —— 正常一句的回包与改前逐字相同(金样是在改前代码上跑出来的,见交接);正常一路也逐步打点。
 */
import { describe, expect, it } from 'vitest'
import type { HubHand } from '../src/server/hub/context.ts'
import type { HubHands } from '../src/server/hub/execute.ts'
import { createSayBook } from '../src/server/hub/reply.ts'
import { hubSay, type HubRunDeps } from '../src/server/hub/run.ts'

const NOW = Date.parse('2026-10-28T13:03:00+08:00')
const iso = new Date(NOW).toISOString()
const HANDS: HubHand[] = [{ id: 'agent:me:k1', title: '小K', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true }]

function setup(modelReplies: string[], opts: { hangCreateCard?: boolean } = {}) {
  const calls: string[] = []
  let n = 0
  const hands: HubHands = {
    createCard: async input => {
      calls.push(`create ${input.title}`)
      // 假手:建卡那一步永不返回(用例 2 的「中枢某一步挂着不回」)。
      if (opts.hangCreateCard === true) return new Promise<never>(() => undefined)
      return { ok: true, id: `t-new${++n}` }
    },
    updateCard: async (id, patch) => { calls.push(`update ${id} ${JSON.stringify(patch)}`); return true },
    moveCard: async (id, status) => { calls.push(`move ${id} ${status}`); return { ok: true } },
    comment: async () => ({ ok: true }),
    carry: async () => ({ ok: false }),
    dispatch: async (id, input) => { calls.push(`dispatch ${id} ${input.to}`); return { ok: true } },
    reassign: async (id, input) => { calls.push(`reassign ${id} ${input.to}`); return { ok: true, note: `${id} 已改派给${input.to}` } },
    createGoal: async () => ({ ok: true, id: 'g-2' }),
    updateGoal: async (id, patch) => { calls.push(`goal ${id} ${JSON.stringify(patch)}`); return true },
    userLayerFix: async () => ({ ok: true, id: 't-ul' }),
    remember: async () => ({ ok: true }),
    feedback: async () => ({ ok: true }),
    voice: async () => ({ ok: true, note: '' }),
  }
  const book = createSayBook({ now: () => NOW })
  let ids = 0
  const deps: HubRunDeps = {
    book,
    hands,
    now: () => NOW,
    newId: () => `id-${++ids}`,
    facts: async () => ({
      tasks: [{ id: 't-d7eeb2ff', title: '旧排期卡', status: 'todo', updated_at: iso }],
      goals: [{ id: 'g-1', title: '周五(10-23)把仓库交接给研发', status: 'open' }],
      hands: HANDS,
      widgets: [],
    }),
    model: {
      endpoint: async () => ({ baseUrl: 'http://m/v1', key: 'k', model: 'm', ready: true }),
      fetchImpl: (async () => {
        const content = modelReplies.shift() ?? '{"commands":[{"name":"chat","reply":"在呢"}]}'
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
      }) as never,
    },
  }
  return { deps, calls, book }
}

describe('hubSay 总时限(卡:悬浮窗 say 挂住与超时)', () => {
  it('用例 2:执行那一步永不返回 → 总时限内回 200,回执说清卡在哪一步,账里看得见每一步打点', async () => {
    const h = setup(['{"commands":[{"name":"dispatch","new":{"title":"查 8791 空转热点"},"to":"agent:me:k1","text":"查 8791 空转热点"}]}'], { hangCreateCard: true })
    h.deps.sayTimeoutMs = 80
    const started = Date.now()
    const out = await hubSay({ said: '让小K查 8791 空转热点', entrance: 'desktop' }, h.deps)
    // 120 秒那档的时限(测试注了 80 毫秒):远没到真等满,回包就得回来。
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(out.status).toBe(200)
    const screen = (out.body.say as { screen: string }).screen
    expect(screen).toContain('卡在')
    expect(screen).toContain('执行')
    expect(screen).toContain('我接着办')
    expect(typeof out.body.say_id).toBe('string')
    // say 账:收到 → 模型回了 → 执行开始(卡在这一步)→ timeout,一步不缺。
    const stages = h.book.stagesOf(out.body.say_id as string).map(one => one.stage)
    expect(stages).toEqual(['received', 'model', 'exec_start', 'timeout'])
    // 卡着的那一路不回断:办(这里是建卡)还没成,没有重复回话、没有假结果。
    expect(h.calls).toEqual(['create 查 8791 空转热点'])
  })

  it('用例 3:没卡的那一句回包逐字照旧(金样,改前代码上抓的)', async () => {
    const h = setup(['{"commands":[{"name":"note","title":"周四发样片"}]}'])
    h.deps.sayTimeoutMs = 80
    const out = await hubSay({ said: '记一下周四发样片', entrance: 'desktop' }, h.deps)
    // 金样:改前代码上抓的完整回包,一个字段不多、一个不少。
    expect(out).toEqual({
      status: 200,
      body: {
        say_id: 'id-1',
        items: [{ kind: '记', title: '记下了 t-new1「周四发样片」(待办)', status: 'done', card_id: 't-new1' }],
        say: { screen: '记下了 t-new1「周四发样片」(待办)', spoken: '记下了 「周四发样片」(待办)' },
        hub: {
          commands: [{ name: 'note', title: '周四发样片', status: 'todo' }],
          rejected: [],
          results: [{ command: 'note', ok: true, card_id: 't-new1', did: '记下了 t-new1「周四发样片」(待办)' }],
        },
      },
    })
  })

  it('没卡的那一句不受时限影响:账里五步打点一步不缺(收到 → 模型回了 → 执行开始 → 执行完 → 回了)', async () => {
    const h = setup(['{"commands":[{"name":"note","title":"周四发样片"}]}'])
    h.deps.sayTimeoutMs = 80
    await hubSay({ said: '记一下周四发样片', entrance: 'desktop' }, h.deps)
    expect(h.book.stagesOf('id-1').map(one => one.stage)).toEqual(['received', 'model', 'exec_start', 'exec_done', 'replied'])
  })
})
