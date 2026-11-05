// @vitest-environment node
/**
 * 一条路(设计第二节):句子 + 入口 + 上下文包 → 模型出命令 → 护栏 → 执行 → 回话 + say 账。
 * 没有任何一步在模型之前就地结束;护栏挂起的问由模型出 confirm 答(10-29 卡,机制版),
 * 执行走现有 answerPending —— 与按钮 confirmed、电话 wb_confirm 同一个落点,不重新听懂。
 */
import { describe, expect, it } from 'vitest'
import type { HubHand } from '../src/server/hub/context.ts'
import type { HubHands } from '../src/server/hub/execute.ts'
import { createSayBook } from '../src/server/hub/reply.ts'
import { hubContext, hubExecute, hubSay, type HubRunDeps } from '../src/server/hub/run.ts'

const NOW = Date.parse('2026-10-28T13:03:00+08:00')
const iso = new Date(NOW).toISOString()
const HANDS: HubHand[] = [{ id: 'agent:me:k1', title: '小K', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true }]

function setup(modelReplies: string[]) {
  const calls: string[] = []
  const prompts: string[] = []
  let n = 0
  const hands: HubHands = {
    createCard: async input => { calls.push(`create ${input.title}`); return { ok: true, id: `t-new${++n}` } },
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
      fetchImpl: (async (_u: unknown, init?: { body?: unknown }) => {
        prompts.push(String(init?.body))
        const content = modelReplies.shift() ?? '{"commands":[{"name":"chat","reply":"在呢"}]}'
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
      }) as never,
    },
  }
  return { deps, calls, prompts, book }
}

describe('hubSay', () => {
  it('13:03「把卡 t-d7eeb2ff 取消掉」→ 先问一次;点「取消它」→ 真取消', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    const first = await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    expect(first.status).toBe(200)
    const ask = first.body.ask as { ask_id: string, question: string }
    expect(ask.question).toContain('t-d7eeb2ff')
    expect(h.calls).toEqual([])
    expect(JSON.stringify(first.body)).not.toContain('不支持')
    const second = await hubSay({ said: '取消它', entrance: 'desktop', confirmed: { ask_id: ask.ask_id, choice: 'yes' } }, h.deps)
    expect(second.status).toBe(200)
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
    expect((second.body.say as { screen: string }).screen).toContain('取消了')
  })

  it('护栏问挂着时,打字答选项原话:第一选项 = 点头 ——「取消它」一遍办成,不碰模型,不问第二遍', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    const first = await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    expect(first.body.ask).toBeDefined()
    expect(h.prompts).toHaveLength(1)
    const second = await hubSay({ said: '取消它', entrance: 'desktop' }, h.deps)
    expect(second.status).toBe(200)
    expect(h.prompts).toHaveLength(1)
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
    expect(second.body.ask).toBeUndefined()
    expect((second.body.say as { screen: string }).screen).toContain('取消了')
  })

  it('同上:其余选项 = 不批 ——「先留着」没办,不碰模型', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    const second = await hubSay({ said: '先留着', entrance: 'desktop' }, h.deps)
    expect(second.status).toBe(200)
    expect(h.prompts).toHaveLength(1)
    expect(h.calls).toEqual([])
    expect((second.body.say as { screen: string }).screen).toContain('没动')
  })

  it('选项原话压过「好 / 先别」快判:目标问句第一选项是「不要了」,答「不要了」= 点头照办', async () => {
    const h = setup(['{"commands":[{"name":"goal_status","goal_id":"g-1","status":"dropped"}]}'])
    const first = await hubSay({ said: '周五交接那个目标不要了', entrance: 'desktop' }, h.deps)
    expect(first.body.ask).toBeDefined()
    const second = await hubSay({ said: '不要了', entrance: 'desktop' }, h.deps)
    expect(second.status).toBe(200)
    expect(h.calls).toEqual(['goal g-1 {"status":"dropped"}'])
    expect(second.body.ask).toBeUndefined()
  })

  it('模型答挂着的问(主路):「把它取消掉」交模型,模型出 confirm{ask_id,choice} → 照挂着的办,结果里没有第二个 ask', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    const first = await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    const askId = (first.body.ask as { ask_id: string }).ask_id
    h.deps.model.fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => {
      h.prompts.push(String(init?.body))
      const content = `{"commands":[{"name":"confirm","ask_id":"${askId}","choice":"取消它"}]}`
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
    }) as never
    const second = await hubSay({ said: '把它取消掉', entrance: 'desktop' }, h.deps)
    expect(second.status).toBe(200)
    expect(h.prompts).toHaveLength(2)
    // 第二句的上下文包里看得见这一问(ask_id + 问句 + 选项),模型就是靠它出的 confirm。
    expect(h.prompts[1]).toContain('挂着等她答的问')
    expect(h.prompts[1]).toContain(askId)
    expect(h.prompts[1]).toContain('取消它')
    expect(h.prompts[1]).toContain('先留着')
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
    expect(second.body.ask).toBeUndefined()
    expect((second.body.items as { status: string }[]).every(one => one.status !== 'asked')).toBe(true)
    expect((second.body.say as { screen: string }).screen).toContain('取消了')
  })

  it('confirm 的 ask_id 已不在(答过了 / 过了十分钟)→ 照实说「这一问已经不在了」,不猜、不动卡', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    const first = await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    expect(first.body.ask).toBeDefined()
    const out = await hubExecute({ entrance: 'phone', commands: [{ name: 'confirm', ask_id: 'id-gone', choice: '取消它' }] }, h.deps)
    expect(out.status).toBe(200)
    expect(h.calls).toEqual([])
    expect((out.body.say as { screen: string }).screen).toContain('这一问已经不在了')
    // 原来那一条还挂着,没被误销。
    expect(h.book.asks().length).toBe(1)
  })

  it('没挂问的时候「取消它」照旧交模型(不误伤)', async () => {
    const h = setup(['{"commands":[{"name":"chat","reply":"好"}]}'])
    const out = await hubSay({ said: '取消它', entrance: 'desktop' }, h.deps)
    expect(out.status).toBe(200)
    expect(h.prompts).toHaveLength(1)
    expect(h.calls).toEqual([])
  })

  it('她回一句「好」也算点头(最近那一问);回「先别」就销掉不动', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}', '{"commands":[{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    await hubSay({ said: '好', entrance: 'desktop' }, h.deps)
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
    await hubSay({ said: '把卡 t-d7eeb2ff 取消掉', entrance: 'desktop' }, h.deps)
    const no = await hubSay({ said: '先别', entrance: 'desktop' }, h.deps)
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
    expect((no.body.say as { screen: string }).screen).toContain('没动')
  })

  it('12:52「把周五那个目标标成达成」→ 改目标状态,回话说清改了哪个', async () => {
    const h = setup(['{"commands":[{"name":"goal_status","goal_id":"g-1","status":"reached"}]}'])
    const out = await hubSay({ said: '把「周五(10-23)把仓库交接给研发」那个目标标成达成。', entrance: 'desktop' }, h.deps)
    expect(h.calls).toEqual(['goal g-1 {"status":"reached"}'])
    expect((out.body.say as { screen: string }).screen).toContain('达成')
  })

  it('say 账落一条;下一句的提示里看得见上一句与它的结果', async () => {
    const h = setup(['{"commands":[{"name":"note","title":"周四发样片"}]}', '{"commands":[{"name":"chat","reply":"好"}]}'])
    await hubSay({ said: '记一下周四发样片', entrance: 'desktop' }, h.deps)
    expect(h.book.recent()).toHaveLength(1)
    expect(h.book.recent()[0]).toMatchObject({ said: '记一下周四发样片', commands: ['note'], cards: ['t-new1'] })
    await hubSay({ said: '刚才那件到哪了', entrance: 'desktop' }, h.deps)
    expect(h.prompts[1]).toContain('记一下周四发样片')
    expect(h.prompts[1]).toContain('t-new1')
  })

  it('模型接不上 → 503,一张卡不建、账不落(原话留在她的输入框里)', async () => {
    const h = setup([])
    h.deps.model = { endpoint: async () => ({ baseUrl: 'http://m', key: undefined, ready: false }) }
    const out = await hubSay({ said: '让小K修一下', entrance: 'desktop' }, h.deps)
    expect(out.status).toBe(503)
    expect(h.calls).toEqual([])
    expect(h.book.recent()).toEqual([])
  })

  it('一条指向落空、一条能办:能办的照办,落空的那条照实说', async () => {
    const h = setup(['{"commands":[{"name":"cancel","card_id":"t-00000000"},{"name":"note","title":"x"}]}'])
    const out = await hubSay({ said: 'x', entrance: 'desktop' }, h.deps)
    expect(h.calls).toEqual(['create x'])
    expect((out.body.say as { screen: string }).screen).toContain('t-00000000')
  })

  it('模型自己问的(拿不准指哪张):问句与选项在回话里,不挂确认 / 否定键;下一句的提示里看得见这一问', async () => {
    const h = setup(['{"commands":[{"name":"ask","question":"指的是哪张?","options":["t-d7eeb2ff 旧排期卡","新建一张"]}]}', '{"commands":[{"name":"chat","reply":"好"}]}'])
    const out = await hubSay({ said: '把那件改一下', entrance: 'desktop' }, h.deps)
    expect(out.body.ask).toBeUndefined()
    expect((out.body.say as { screen: string }).screen).toContain('t-d7eeb2ff 旧排期卡')
    await hubSay({ said: '第一张', entrance: 'desktop' }, h.deps)
    expect(h.prompts[1]).toContain('指的是哪张?')
  })

  it('不可改清单:拒,说明为什么,不派', async () => {
    const h = setup(['{"commands":[{"name":"dispatch","new":{"title":"去掉日结"},"to":"agent:me:k1","text":"把日结功能删掉"}]}'])
    const out = await hubSay({ said: '让小K把日结功能删掉', entrance: 'desktop' }, h.deps)
    expect(h.calls).toEqual([])
    expect((out.body.say as { screen: string }).screen).toContain('不可改')
  })

  it('回包带 hub 段(命令与结果),旧形状的 say / items 照旧在', async () => {
    const h = setup(['{"commands":[{"name":"dispatch","new":{"title":"查 8791 空转热点"},"to":"agent:me:k1","text":"查 8791 空转热点"}]}'])
    const out = await hubSay({ said: '让小K查 8791 空转热点', entrance: 'desktop' }, h.deps)
    expect(out.body.say_id).toBeDefined()
    expect(Array.isArray(out.body.items)).toBe(true)
    expect((out.body.hub as { commands: { name: string }[] }).commands[0]!.name).toBe('dispatch')
    expect(h.calls).toEqual(['create 查 8791 空转热点', 'dispatch t-new1 agent:me:k1'])
  })
})

describe('hubContext / hubExecute:给电话工人与手机(A2)用的两个口,电脑入口内部调同一执行器', () => {
  it('hubContext:按入口出设计第三节那一包(结构 + 成文)', async () => {
    const h = setup([])
    const out = await hubContext({ entrance: 'call', said: '旧排期卡' }, h.deps)
    expect(out.context.entrance).toBe('call')
    expect(out.context.cards.map(one => one.id)).toContain('t-d7eeb2ff')
    expect(out.context.goals.map(one => one.id)).toEqual(['g-1'])
    expect(out.context.hands.map(one => one.id)).toEqual(['agent:me:k1'])
    expect(out.text).toContain('t-d7eeb2ff')
  })

  it('hubExecute:命令按上下文包核指向 → 护栏 → 执行;结果 {ok, did, why?, next?};不调模型', async () => {
    const h = setup([])
    const out = await hubExecute({ entrance: 'call', said: '把周五那个目标标成达成', commands: [{ name: 'goal_status', goal_id: 'g-1', status: 'reached' }, { name: 'cancel', card_id: 't-00000000' }] }, h.deps)
    expect(out.status).toBe(200)
    expect(h.calls).toEqual(['goal g-1 {"status":"reached"}'])
    const results = out.body.results as { ok: boolean, did: string, why?: string }[]
    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toMatchObject({ ok: false })
    expect(results[1]!.why).toContain('t-00000000')
    expect(h.prompts).toEqual([])
    expect(h.book.recent().at(-1)).toMatchObject({ entrance: 'call', said: '把周五那个目标标成达成' })
  })

  it('hubExecute:护栏挂起的那条带 ask_id;再打一次 confirmed 就照原命令办', async () => {
    const h = setup([])
    const first = await hubExecute({ entrance: 'phone', commands: [{ name: 'cancel', card_id: 't-d7eeb2ff' }] }, h.deps)
    const held = (first.body.results as { ask?: { ask_id: string, question: string } }[])[0]!.ask!
    expect(held.question).toContain('t-d7eeb2ff')
    expect(h.calls).toEqual([])
    const second = await hubExecute({ entrance: 'phone', commands: [], confirmed: { ask_id: held.ask_id, choice: 'yes' } }, h.deps)
    expect(second.status).toBe(200)
    expect(h.calls).toEqual(['move t-d7eeb2ff canceled'])
  })

  it('hubExecute:全部指向落空也照实回每条为什么,不回空表', async () => {
    const h = setup([])
    const out = await hubExecute({ entrance: 'call', commands: [{ name: 'cancel', card_id: 't-00000000' }] }, h.deps)
    const results = out.body.results as { ok: boolean, why?: string }[]
    expect(results).toHaveLength(1)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.why).toContain('t-00000000')
  })

  it('hubExecute:commands 不是数组 → 400', async () => {
    const h = setup([])
    expect((await hubExecute({ entrance: 'call', commands: 'cancel' }, h.deps)).status).toBe(400)
  })
})

describe('回话同源写卡(say_note):手机等卡回来时摆的是同一句', () => {
  it('办到的那几张卡写上这句回话;挂起的问不写', async () => {
    const h = setup(['{"commands":[{"name":"goal_status","goal_id":"g-1","status":"reached"},{"name":"note","title":"周四发样片"},{"name":"cancel","card_id":"t-d7eeb2ff"}]}'])
    const notes: string[] = []
    h.deps.hands.sayNote = async (id, text) => { notes.push(`${id}:${text}`) }
    const out = await hubSay({ said: '把周五那个目标标成达成,记一下周四发样片,把旧排期卡取消', entrance: 'call' }, h.deps)
    const screen = (out.body.say as { screen: string }).screen
    expect(notes).toEqual([`t-new1:${screen}`])
  })
})
