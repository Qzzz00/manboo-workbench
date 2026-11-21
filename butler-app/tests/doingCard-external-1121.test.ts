/**
 * 2026-11-21(维护者:「手机端正在办一直 0 事项,监测不到电脑端 agent 的进展」)。
 *
 * 10-28 执行范围改成分类业务任务(断点④)之后,首页「正在办」卡在服务端给了
 * `state.running` 时只画业务事项行,**各家客户端在跑、没挂在事项上的会话被整段丢掉**
 * —— 而这张卡的契约(本文件头那张表,与电脑首页球周围同一个口径)一直是
 * 「事务官在办的事项 + 各家在跑的会话」。电脑舞台那几张卡还在,手机首页成了空白
 * 「业务任务总数未知,已观测 0 件」。
 *
 * 这份钉:分类业务范围里,各家在跑的会话照旧列进「正在办」;卡面列出它们时,
 * 那颗数 = 公共业务数 + 各家在跑会话数(09-25 卡 V 的老规矩:列着的与数着的要一致);
 * 业务总数没核完(闸门未过)时不画数(D13),会话行照列。
 */
import { expect, it } from 'vitest'
import { emptyState, type SessionView, type WorkbenchState } from '../src/api/protocol'
import { stageCards } from '../src/stage/stageCardsModel'
import { registryOf } from './registryFixture'

function session(over: Partial<SessionView> = {}): SessionView {
  return { agent: 'kimi', session_id: 'km-1', project: '工作台', status: 'running', title: '修手机端监测', elapsed_sec: 60, unread: false, updated_at: '2026-11-21T06:20:00Z', ...over }
}

function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return { ...emptyState(), stale: false, now: '2026-11-21T14:20:00+08:00', agent_registry: registryOf([session()]), ...over }
}

const doing = (s: WorkbenchState) => stageCards(s).find(one => one.id === 'doing')!

it('分类业务范围里,各家在跑、没挂事项的会话照旧列进「正在办」', () => {
  const card = doing(state({ running: { scope: 'classified_business_tasks', count: 0, observed_count: 0, items: [], excluded: [] } }))
  expect(card.lines.map(one => one.id)).toEqual(['session:kimi/km-1'])
  expect(card.lines[0]?.text).toBe('修手机端监测')
  expect(card.lines[0]?.note).toContain('Kimi')
  expect(card.lines[0]?.agent).toBe('kimi')
})

it('卡面列着各家在跑会话时,那颗数 = 公共业务数 + 各家在跑会话数', () => {
  const card = doing(state({ running: { scope: 'classified_business_tasks', count: 0, observed_count: 0, items: [], excluded: [] } }))
  expect(card.count).toBe(1)
  const withBusiness = doing(state({ running: { scope: 'classified_business_tasks', count: 2, observed_count: 2, items: [
    { key: 'task-a', task_id: 'task-a', text: '图谱返修', agent: 'codex', role: 'business', sources: [{ agent: 'codex', session_id: 'one', provider: 'codex', transport: 'codex-rollout', role: 'business', state: 'running' }] },
  ], excluded: [] } }))
  expect(withBusiness.count).toBe(3)
  expect(withBusiness.lines.map(one => one.id)).toEqual(['task-a', 'session:kimi/km-1'])
})

it('业务总数没核完(闸门未过)时不画数,各家在跑会话照列、不背「业务总数未知」那句', () => {
  const card = doing(state({ running: { scope: 'classified_business_tasks', observed_count: 0, items: [], excluded: [] } }))
  expect(card.count).toBeUndefined()
  expect(card.lines.map(one => one.id)).toEqual(['session:kimi/km-1'])
  expect(card.lines[0]?.note).not.toContain('业务总数未知')
})

it('挂在事项上的会话不重复列(去重口径照旧)', () => {
  const linked = state({
    tasks: { ...emptyState().tasks!, tasks: [{
      id: 'task-1', title: '派给 Kimi 的活', status: 'doing', direction: 'mine', created_at: '', updated_at: '',
      links: [{ agent: 'kimi', session_id: 'km-1' }],
    }] },
    running: { scope: 'classified_business_tasks', count: 1, observed_count: 1, items: [
      { key: 'task-1', task_id: 'task-1', text: '派给 Kimi 的活', agent: 'kimi', role: 'business', sources: [{ agent: 'kimi', session_id: 'km-1', provider: 'kimi', transport: 'kimi-wire', role: 'business', state: 'running' }] },
    ], excluded: [] },
  })
  const card = doing(linked)
  expect(card.lines.map(one => one.id)).toEqual(['task-1'])
  expect(card.count).toBe(1)
})
