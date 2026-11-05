// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MeetingView, TaskView } from '../src/protocol.ts'
import { workTypeOf } from '../src/protocol.ts'
import { meetingRelation, noteRelation, ownerLine, RELATION_TITLES } from '../src/client/collab/peopleModel.ts'

const AT = '2026-10-21T01:00:00.000Z'
const note = (patch: Partial<TaskView> = {}): TaskView => ({ id: 'a', title: 'a', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })

describe('点选头像:负责 / 协作 / 参加', () => {
  it('负责人 = 负责;协作者 = 协作;别的 = 没关系', () => {
    expect(noteRelation(note({ assignee: 'codex' }), 'codex')).toBe('owner')
    expect(noteRelation(note({ assignee: 'me', collaborators: ['codex'] }), 'codex')).toBe('collab')
    expect(noteRelation(note({ assignee: 'me' }), 'codex')).toBeUndefined()
    expect(RELATION_TITLES.owner).toBe('负责')
  })
  it('老卡上的「同事」按「你」算', () => {
    expect(noteRelation(note({ assignee: 'colleague' }), 'me')).toBe('owner')
  })
  it('会议:你总在场(一个人的板);别人按会前登记的参与人名字认', () => {
    const meeting = { id: 'm', title: 'x', date: '', started_at: AT, status: 'planned', segments: 0, todos: [], unsure: [], prep: { said: '', card_status: 'answers', people: { value: [{ alias: '小李' }], from: 'said' } } } as unknown as MeetingView
    expect(meetingRelation(meeting, 'me', '你')).toBe('attend')
    expect(meetingRelation(meeting, 'member:li', '小李')).toBe('attend')
    expect(meetingRelation(meeting, 'codex', 'Codex')).toBeUndefined()
  })
})

describe('负责人那一行', () => {
  it('派给小队:小队 · 组长 → 实际负责人', () => {
    expect(ownerLine(note({ assignee: 'codex', squad_id: 's1' }), { squads: [{ id: 's1', name: '前端组', leader: 'me', members: ['codex'], created_at: AT, updated_at: AT }], nameOf: id => (id === 'me' ? '你' : 'Codex') })).toBe('前端组 · 你 → Codex')
    expect(ownerLine(note({ assignee: 'codex' }), { squads: [], nameOf: () => 'Codex' })).toBe('Codex')
  })
})

describe('事项类型只从已知事实认', () => {
  it('明写优先;需求 = 研发;选题 = 内容;写代码的派活 = 研发;认不出缺席(不按 Agent 名字猜)', () => {
    expect(workTypeOf(note({ work_type: 'meeting' }))).toBe('meeting')
    expect(workTypeOf(note({ kind: 'feature' }))).toBe('dev')
    expect(workTypeOf(note({ kind: 'topic' }))).toBe('content')
    expect(workTypeOf(note({ assignee: 'codex' }))).toBeUndefined()
  })
})
