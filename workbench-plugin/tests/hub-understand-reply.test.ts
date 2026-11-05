// @vitest-environment node
/**
 * 模型出命令(understand)与回话 / say 账(reply)。
 * understand:模型按命令表出 commands[];接不上 / 坏结构如实回失败,**不在模型之前就地结束,也不拿半截冒称听懂**。
 * reply:回话由结果拼,不由模型编;屏上一份、口语一份;say 账落一条(句子、命令、结果、卡号)。
 */
import { describe, expect, it } from 'vitest'
import { buildContext, type HubHand } from '../src/server/hub/context.ts'
import { understandCommands, HUB_SYSTEM_PROMPT } from '../src/server/hub/understand.ts'
import { createSayBook, itemsOf, replyOf } from '../src/server/hub/reply.ts'
import type { HubResult } from '../src/server/hub/commands.ts'

const NOW = Date.parse('2026-10-28T09:40:00+08:00')
const HANDS: HubHand[] = [{ id: 'agent:me:k1', title: '小K', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 0, ok: true, code: true }]
const ctx = buildContext({ said: '', entrance: 'desktop', now: NOW, says: [], hands: HANDS, widgets: [], goals: [],
  tasks: [{ id: 't-ea1e8702', title: '修手机 App 重连竞态', status: 'blocked', updated_at: new Date(NOW).toISOString() }] })

const endpoint = async () => ({ baseUrl: 'http://model/v1', key: 'k', model: 'm', ready: true })

function fakeModel(content: string, seen?: { body?: string }) {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    if (seen !== undefined) seen.body = String(init?.body)
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 })
  }) as never
}

describe('understandCommands', () => {
  it('按命令表收命令;上下文包与她的原话都进了提示', async () => {
    const seen: { body?: string } = {}
    const got = await understandCommands('刚才手机 App 那件,改派给小K', ctx, { endpoint, fetchImpl: fakeModel('```json\n{"commands":[{"name":"reassign","card_id":"t-ea1e8702","to":"小K"}]}\n```', seen) })
    expect(got).toMatchObject({ ok: true, commands: [{ name: 'reassign', card_id: 't-ea1e8702', to: 'agent:me:k1', restart: true }] })
    expect(seen.body).toContain('t-ea1e8702')
    expect(seen.body).toContain('刚才手机 App 那件,改派给小K')
    expect(seen.body).not.toContain('"k"')
  })

  it('模型没接上:如实回 unreachable(不猜、不兜底记一条)', async () => {
    const got = await understandCommands('x', ctx, { endpoint: async () => ({ baseUrl: 'http://m', key: undefined, ready: false }) })
    expect(got).toEqual({ ok: false, why: 'unreachable' })
    const down = await understandCommands('x', ctx, { endpoint, fetchImpl: (async () => new Response('no', { status: 502 })) as never })
    expect(down).toEqual({ ok: false, why: 'unreachable' })
  })

  it('坏结构:回 bad_output', async () => {
    expect(await understandCommands('x', ctx, { endpoint, fetchImpl: fakeModel('我觉得应该改派') })).toEqual({ ok: false, why: 'bad_output' })
    expect(await understandCommands('x', ctx, { endpoint, fetchImpl: fakeModel('{"commands":[]}') })).toEqual({ ok: false, why: 'bad_output' })
  })

  it('全部命令都指向板上没有的东西:不是空着回,是变成一问(说清哪里对不上)', async () => {
    const got = await understandCommands('把 t-00000000 取消', ctx, { endpoint, fetchImpl: fakeModel('{"commands":[{"name":"cancel","card_id":"t-00000000"}]}') })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.commands[0]?.name).toBe('ask')
    expect(got.rejected[0]?.why).toContain('t-00000000')
  })

  it('提示里写着:改派永不改名、点名 + 动作是派活不是反馈、卡号必须认', () => {
    expect(HUB_SYSTEM_PROMPT).toContain('永不改名')
    expect(HUB_SYSTEM_PROMPT).toContain('反馈')
    expect(HUB_SYSTEM_PROMPT).toContain('卡号')
  })

  it('提示里写着(任务书 1029):补一句的整句都是给那张卡的、进仓库的活窗口拿不到', () => {
    expect(HUB_SYSTEM_PROMPT).toContain('冒号后的整句都是说给')
    expect(HUB_SYSTEM_PROMPT).toContain('另开一张')
    expect(HUB_SYSTEM_PROMPT).toContain('窗口拿不到仓库')
    expect(HUB_SYSTEM_PROMPT).toContain('能改本机文件')
  })
})

describe('replyOf / itemsOf', () => {
  const results: HubResult[] = [
    { command: 'reassign', ok: true, card_id: 't-ea1e8702', who: '小K', did: 't-ea1e8702「修手机 App 重连竞态」已改派给 小K,原来 小G 那次已停' },
    { command: 'dispatch', ok: false, card_id: 't-new1', did: '建了 t-new1「修 X」,没派', why: '小G 额度用完了', next: '换小K?' },
    { command: 'ask', ok: true, did: '指的是哪张?', ask: { question: '指的是哪张?', options: ['A', 'B'] } },
  ]
  it('屏上一份:每条结果一句,没办成的带为什么与下一步;问句带选项', () => {
    const say = replyOf(results)
    expect(say.screen).toContain('已改派给 小K')
    expect(say.screen).toContain('没派——小G 额度用完了')
    expect(say.screen).toContain('换小K?')
    expect(say.screen).toContain('指的是哪张?')
  })
  it('口语一份:不念卡号', () => {
    const say = replyOf(results)
    expect(say.spoken).not.toMatch(/t-[0-9a-z]{4,}/u)
    expect(say.spoken).toContain('已改派给 小K')
  })
  it('chat 的回话原样用', () => {
    expect(replyOf([{ command: 'chat', ok: true, did: '在呢。', reply: '在呢。' }]).screen).toBe('在呢。')
  })
  it('itemsOf:回包 items 沿用旧形状(kind / title / status / card_id / who / detail)', () => {
    expect(itemsOf(results)).toEqual([
      { kind: '办', title: 't-ea1e8702「修手机 App 重连竞态」已改派给 小K,原来 小G 那次已停', status: 'done', card_id: 't-ea1e8702', who: '小K' },
      { kind: '办', title: '建了 t-new1「修 X」,没派', status: 'failed', card_id: 't-new1', detail: '小G 额度用完了;换小K?' },
      { kind: '问', title: '指的是哪张?', status: 'asked', detail: '指的是哪张?' },
    ])
  })
})

describe('createSayBook:say 账与挂着的问', () => {
  it('落一条:句子、命令、结果、卡号;只回 2 天内最多 20 条', () => {
    let now = NOW
    const book = createSayBook({ now: () => now })
    for (let i = 0; i < 25; i += 1) book.record({ say_id: `s${i}`, entrance: 'desktop', said: `第${i}句`, commands: ['note'], results: [{ command: 'note', ok: true, did: 'x', card_id: `t-${i}aaaa` }] })
    const recent = book.recent()
    expect(recent).toHaveLength(20)
    expect(recent.at(-1)).toMatchObject({ say_id: 's24', said: '第24句', commands: ['note'], cards: ['t-24aaaa'] })
    now += 3 * 86_400_000
    expect(book.recent()).toEqual([])
  })
  it('挂问:按 ask_id 取走一次就没了;过期取不到', () => {
    let now = NOW
    const book = createSayBook({ now: () => now })
    book.hold({ ask_id: 'a1', say_id: 's1', said: '把 t-x 取消', question: '要取消吗?', options: ['取消它', '先留着'], held: [{ name: 'cancel', card_id: 't-ea1e8702' }] })
    expect(book.asks().map(one => one.ask_id)).toEqual(['a1'])
    expect(book.has('a1')).toBe(true)
    expect(book.take('a1')?.held).toEqual([{ name: 'cancel', card_id: 't-ea1e8702' }])
    expect(book.take('a1')).toBeUndefined()
    book.hold({ ask_id: 'a2', say_id: 's2', said: 'x', question: 'q', options: [], held: [] })
    now += 11 * 60_000
    expect(book.take('latest')).toBeUndefined()
  })
})

describe('对多张不猜(模型之后核一遍指向;用 sayTarget 那一个解析器)', () => {
  const NOW2 = Date.parse('2026-10-28T09:40:00+08:00')
  const two = buildContext({ said: '刚才手机 App 那件改派给小K。', entrance: 'desktop', now: NOW2, hands: HANDS, widgets: [], goals: [],
    tasks: [
      { id: 't-ea1e8702', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', status: 'blocked', updated_at: new Date(NOW2).toISOString(), assignee: 'agent:me:k1' },
      { id: 't-5e1f0a11', title: '手机 App 首页离线排查', status: 'todo', updated_at: new Date(NOW2).toISOString() },
    ],
    says: [
      { say_id: 's1', at: NOW2 - 180_000, entrance: 'desktop', said: '派给小G 修手机 App 重连竞态', commands: ['dispatch'], cards: ['t-ea1e8702'] },
      { say_id: 's2', at: NOW2 - 60_000, entrance: 'desktop', said: '记一下手机 App 首页离线排查', commands: ['note'], cards: ['t-5e1f0a11'] },
    ] })
  it('「刚才手机 App 那件」对上两张、模型挑了一张 → 改成问,选项是两张候选', async () => {
    const got = await understandCommands('刚才手机 App 那件改派给小K。', two, { endpoint, fetchImpl: fakeModel('{"commands":[{"name":"reassign","card_id":"t-ea1e8702","to":"agent:me:k1"}]}') })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.commands).toHaveLength(1)
    expect(got.commands[0]!.name).toBe('ask')
    const ask = got.commands[0] as { question: string, options: readonly string[] }
    expect(ask.options.join(' ')).toContain('t-ea1e8702')
    expect(ask.options.join(' ')).toContain('t-5e1f0a11')
  })
  it('句里给了卡号 / 只对上一张:照模型的办,不多问', async () => {
    const byId = await understandCommands('t-ea1e8702 改派给小K', two, { endpoint, fetchImpl: fakeModel('{"commands":[{"name":"reassign","card_id":"t-ea1e8702","to":"agent:me:k1"}]}') })
    expect(byId.ok && byId.commands[0]!.name).toBe('reassign')
    const one = await understandCommands('刚才首页离线那件取消掉', two, { endpoint, fetchImpl: fakeModel('{"commands":[{"name":"cancel","card_id":"t-5e1f0a11"}]}') })
    expect(one.ok && one.commands[0]!.name).toBe('cancel')
  })
})
