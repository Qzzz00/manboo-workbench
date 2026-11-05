// @vitest-environment node
/**
 * 「现在该谁动」(2026-09-25,卡 N,`server/itemMover.ts`)与早报里负责人那两段。
 * 卡的形状照维护者那份真看板(引导落地排的十张卡:Codex / Claude / 你 / 同事 / 别人)。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { isTrackedItem } from '../src/protocol.ts'
import { itemMover, ownerMorningLines } from '../src/server/itemMover.ts'

function task(title: string, extra: Partial<TaskView> = {}): TaskView {
  return { id: `t-${title.length}`, title, status: 'todo', source: { kind: 'manual' }, created_at: '2026-09-25T05:42:03Z', updated_at: '2026-09-25T05:42:03Z', ...extra }
}

describe('一件事一份:事项那一排的门', () => {
  it('他交代的(mine)照旧;看板上写了负责人的卡也是事项;选题只按 mine 算;没负责人的看板卡不是', () => {
    expect(isTrackedItem({ direction: 'mine' })).toBe(true)
    expect(isTrackedItem({ assignee: 'claude' })).toBe(true)
    expect(isTrackedItem({ assignee: 'me' })).toBe(true)
    expect(isTrackedItem({ assignee: 'claude', kind: 'topic' })).toBe(false)
    expect(isTrackedItem({})).toBe(false)
  })
})

describe('现在该谁动', () => {
  it('某家 AI:还没派 → 事务官排着;等他点头派 → 他;派出去在等回答 → 那家;挑手说不行 → 他', () => {
    const card = task('手机远程派单 + 汇报 / 进度评估准确', { assignee: 'claude' })
    expect(itemMover(card)).toEqual({ who: 'butler', line: '排着,等派给 Claude', assignee: 'claude' })
    expect(itemMover(card, { askingDispatch: new Set([card.id]) }).line).toBe('等你点头派给 Claude')
    expect(itemMover(card, { askingDispatch: new Set([card.id]) }).who).toBe('me')
    const sent = { ...card, status: 'doing' as const, client_dispatch: { hand: 'window' as const, family: 'claude' as const, status: 'sent' as const, at: '2026-09-25T06:00:00Z', text: 'x', reply_state: 'waiting' as const } }
    expect(itemMover(sent)).toEqual({ who: 'agent', line: 'Claude 在做', assignee: 'claude' })
    const held = new Map([[card.id, { why: 'Claude 能聊天,但改不了你电脑上的文件 —— 点「登录 Claude」', who: 'me' as const }]])
    expect(itemMover(card, { held })).toEqual({ who: 'me', line: 'Claude 能聊天,但改不了你电脑上的文件 —— 点「登录 Claude」', assignee: 'claude' })
  })

  it('他自己的 → 你来(带截止);同事 / 别人 → 等那个人(带补充与到期)', () => {
    expect(itemMover(task('9/28 把材料整理好放同事桌上', { assignee: 'me', due: '2026-09-28' })).line).toBe('你来 · 截止 9/28')
    expect(itemMover(task('参赛文案', { assignee: 'colleague', assignee_note: '9/29 回来写' }))).toEqual({ who: 'others', line: '等同事 · 9/29 回来写', assignee: 'colleague' })
    expect(itemMover(task('参赛视频', { assignee: 'other', assignee_note: '接手做' })).line).toBe('等别人 · 接手做')
  })

  it('不管负责人是谁:等我确认 → 他验收;阻塞 → 他;证据里冒出来的待排卡 → 他点头;办完 → 没人', () => {
    expect(itemMover(task('a', { assignee: 'codex', status: 'confirm', client_dispatch: { hand: 'window', family: 'codex', status: 'sent', at: 'x', text: 'x' } })).line).toBe('Codex 交回来了,等你验收')
    expect(itemMover(task('a', { assignee: 'codex', status: 'blocked', block_reason: 'quota' })).line).toBe('卡住了:额度不够了')
    expect(itemMover(task('换真截图', { status: 'backlog', origin: 'evidence' })).who).toBe('me')
    expect(itemMover(task('a', { status: 'done', assignee: 'me' })).who).toBe('none')
  })

  it('没点名的老事项 / 事务官自己的 → 事务官(在跑 = 在办)', () => {
    const mine = task('这个有点问题', { direction: 'mine', conversation: { agent: 'dsh', session_id: 's1' } })
    expect(itemMover(mine).line).toBe('事务官排着')
    expect(itemMover(mine, { runningSessions: new Set(['dsh:s1']) }).line).toBe('事务官在办')
  })
})

describe('早报里负责人那两段', () => {
  it('他自己的按截止日;同事 / 别人三天内到期的提醒;办完的不念', () => {
    const lines = ownerMorningLines([
      task('9/28 把材料整理好放同事桌上', { assignee: 'me', due: '2026-09-28' }),
      task('定核心体验流程(四段)', { assignee: 'me', status: 'done' }),
      task('参赛文案', { assignee: 'colleague', assignee_note: '9/29 回来写', due: '2026-09-29' }),
      task('参赛视频', { assignee: 'other' }),
      task('Lapis 上线', { assignee: 'colleague', due: '2026-10-20' }),
    ], new Date('2026-09-27T08:30:00+08:00'))
    expect(lines).toEqual([
      '你自己的:9/28 把材料整理好放同事桌上(截止 9/28)',
      '到期提醒:参赛文案(同事,9/29 回来写,9/29)',
    ])
  })
})
