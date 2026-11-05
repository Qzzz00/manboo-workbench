// @vitest-environment node
/**
 * 理解中枢的上下文包(设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第三节):
 * 模型读这一包,不是全板;包里没有的,它只能问。上限:话 20 条 / 2 天,卡 60 张未结 + 关键词命中 20,目标全部。
 */
import { describe, expect, it } from 'vitest'
import { buildContext, handUsable, renderContext, type HubHand, type HubSayRecord } from '../src/server/hub/context.ts'

const NOW = Date.parse('2026-10-28T09:40:00+08:00')

function card(id: string, title: string, status: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return { id, title, status, updated_at: new Date(NOW - minutesAgo * 60_000).toISOString(), ...extra }
}

const HANDS: HubHand[] = [
  { id: 'claude', title: 'Claude', family: 'claude', card: false, installed: true, login: 'no', quota: 'ok', running: 0, ok: true, code: true },
  { id: 'kimi', title: 'Kimi', family: 'kimi', card: false, installed: true, login: 'yes', quota: 'ok', quota_text: '本周还剩约 56%', running: 1, ok: true, code: true },
  { id: 'agent:me:k1', title: '小K(重生版)', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', running: 1, ok: true, code: true },
  { id: 'agent:me:g1', title: '小G', family: 'codex', card: true, installed: true, login: 'yes', quota: 'empty', quota_text: '额度用完了', running: 0, ok: true, code: true },
]

describe('buildContext:上下文包的取舍', () => {
  it('未结卡按最近改动取前 60;已结卡只按关键词 / 卡号命中补进来(最多 20)', () => {
    const open = Array.from({ length: 70 }, (_, i) => card(`t-open${String(i).padStart(4, '0')}`, `活 ${i}`, 'todo', i))
    const closed = [
      card('t-ea1e8702', '修手机 App 远程连回电脑时 LiveKit 重连竞态', 'done', 600),
      card('t-c323ffa6', '查工作台 8791 空转热点', 'canceled', 600),
      card('t-zzzz0001', '无关的旧事', 'done', 600),
    ]
    const ctx = buildContext({ said: '刚才手机 App 那件,改派给小K', entrance: 'desktop', now: NOW, says: [], tasks: [...open, ...closed], goals: [], hands: HANDS, widgets: [] })
    const ids = ctx.cards.map(one => one.id)
    expect(ids.filter(id => id.startsWith('t-open'))).toHaveLength(60)
    expect(ids).toContain('t-open0000')
    expect(ids).not.toContain('t-open0069')
    expect(ids).toContain('t-ea1e8702')
    expect(ids).not.toContain('t-zzzz0001')
  })

  it('句子里点到的卡号一定进包(哪怕已结、哪怕不在前 60)', () => {
    const open = Array.from({ length: 70 }, (_, i) => card(`t-open${String(i).padStart(4, '0')}`, `活 ${i}`, 'todo', i))
    const ctx = buildContext({ said: '把卡 t-open0069 取消掉;t-c323ffa6 的标题改回来', entrance: 'desktop', now: NOW, says: [], tasks: [...open, card('t-c323ffa6', '查热点', 'done', 900)], goals: [], hands: HANDS, widgets: [] })
    const ids = ctx.cards.map(one => one.id)
    expect(ids).toContain('t-open0069')
    expect(ids).toContain('t-c323ffa6')
  })

  it('最近的话:只留 2 天内、最多 20 条,新的在后', () => {
    const says: HubSayRecord[] = Array.from({ length: 25 }, (_, i) => ({ say_id: `s${i}`, at: NOW - (25 - i) * 60_000, entrance: 'desktop', said: `第 ${i} 句`, commands: [], cards: [] }))
    says.unshift({ say_id: 'old', at: NOW - 3 * 86_400_000, entrance: 'desktop', said: '三天前', commands: [], cards: [] })
    const ctx = buildContext({ said: 'x', entrance: 'desktop', now: NOW, says, tasks: [], goals: [], hands: HANDS, widgets: [] })
    expect(ctx.says).toHaveLength(20)
    expect(ctx.says.at(-1)?.said).toBe('第 24 句')
    expect(ctx.says.some(one => one.said === '三天前')).toBe(false)
  })

  it('目标全部带上,条件数照实数', () => {
    const ctx = buildContext({ said: 'x', entrance: 'desktop', now: NOW, says: [], tasks: [], hands: HANDS, widgets: [],
      goals: [{ id: 'g-1', title: '周五(10-23)把仓库交接给研发', status: 'open', due: '2026-10-23', conditions: [{ text: 'a' }, { text: 'b' }] }] })
    expect(ctx.goals).toEqual([{ id: 'g-1', title: '周五(10-23)把仓库交接给研发', status: 'open', due: '2026-10-23', conditions: 2 }])
  })
})

describe('handUsable:派前核手的判据', () => {
  it('登录过期 / 额度用完 / 没装 / 选项说不行 都不可用,并说出为什么', () => {
    expect(handUsable(HANDS[0]!)).toEqual({ ok: false, why: 'Claude 登录过期了' })
    expect(handUsable(HANDS[1]!)).toEqual({ ok: true })
    expect(handUsable(HANDS[3]!)).toEqual({ ok: false, why: '小G 额度用完了' })
    expect(handUsable({ ...HANDS[1]!, installed: false }).ok).toBe(false)
    expect(handUsable({ ...HANDS[1]!, ok: false, why: '这台读不到它的窗口' })).toEqual({ ok: false, why: 'Kimi 这台读不到它的窗口' })
  })
})

describe('renderContext:模型看到的那一段字', () => {
  it('带卡号、目标、手的状态(登录 / 额度 / 在跑几件)、用户层、入口与时间', () => {
    const ctx = buildContext({
      said: '随手记那一格的提示语改一下', entrance: 'desktop', now: NOW, devMachine: true,
      says: [{ say_id: 's1', at: NOW - 60_000, entrance: 'desktop', said: '让小G修手机 App 重连竞态', commands: ['dispatch'], cards: ['t-ea1e8702'] }],
      tasks: [card('t-ea1e8702', '修手机 App 重连竞态', 'blocked', 5, { assignee: 'agent:me:g1' })],
      goals: [{ id: 'g-1', title: '周五交接', status: 'open' }],
      hands: HANDS,
      widgets: [{ id: 'quick-note', name: '随手记', status: 'ok', replaces: 'quick_note' }],
      files: [{ path: 'docs/任务书.md', head: '验收:一、二' }],
    })
    const text = renderContext(ctx)
    expect(text).toContain('t-ea1e8702')
    expect(text).toContain('修手机 App 重连竞态')
    expect(text).toContain('g-1')
    expect(text).toContain('Claude')
    expect(text).toContain('登录过期')
    expect(text).toContain('额度用完')
    expect(text).toContain('agent:me:k1')
    expect(text).toContain('quick-note')
    expect(text).toContain('随手记')
    expect(text).toContain('让小G修手机 App 重连竞态')
    expect(text).toContain('desktop')
    expect(text).toContain('docs/任务书.md')
    expect(text).toContain('有源码')
  })

  it('★交回过的卡一行带「交回于 <时间>」(回归集 10-29 09:30 行):「哪几天交回的」对得上;没交回时间的不带', () => {
    const returnedAt = new Date(NOW - 5 * 86_400_000).toISOString()
    const ctx = buildContext({
      said: '等你里前几天交回的那几张,按卡上条件核一遍,过的结掉,不过的退修',
      entrance: 'desktop', now: NOW, says: [], hands: HANDS, widgets: [],
      tasks: [
        card('t-d66412f5', '周一交回的活', 'confirm', 500, { acceptance: ['同数'], dispatch: { family: 'kimi', status: 'ended', ended_at: returnedAt } }),
        card('t-3109f7ab', '还没交回的活', 'doing', 30, { dispatch: { family: 'kimi', status: 'running' } }),
      ],
      goals: [],
    })
    // 结构化那一格也带(执行 verify 时认 confirm 卡用得上)。
    expect(ctx.cards.find(one => one.id === 't-d66412f5')?.dispatch?.ended_at).toBe(returnedAt)
    const lines = renderContext(ctx).split('\n')
    const returned = lines.find(one => one.includes('t-d66412f5')) ?? ''
    const running = lines.find(one => one.includes('t-3109f7ab')) ?? ''
    expect(returned).toContain('交回于')
    expect(returned).toContain('10-2')
    expect(running).not.toContain('交回于')
  })
})
