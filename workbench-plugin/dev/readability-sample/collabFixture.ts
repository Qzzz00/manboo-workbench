/**
 * 协作区样张数据(2026-10-21 视觉 A):从 `dev/collab-board/main.tsx` 搬来的同一份假数据(三个目标、几张便签、一场会),
 * 让样张页的项目区 / 窗口槽里能看见协作区。全是编的。
 */
import type { TaskView } from '../../src/protocol.ts'

const AT = '2026-10-21T09:00:00.000Z'
const today = new Date()
const dayAt = (offset: number, hm: string): string => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const [h, m] = hm.split(':').map(Number) as [number, number]
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const note = (id: string, title: string, patch: Partial<TaskView> = {}): TaskView => ({
  id, title, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
})

export const COLLAB_TASKS: TaskView[] = [
  note('t1', '铃声换成柔和的', { goal_id: 'g1', status: 'doing', assignee: 'codex', start: dayAt(0, '11:30'), end: dayAt(0, '12:30'), work_type: 'dev', from: { kind: 'said', quote: '铃声太吵了,换一首柔和的' }, acceptance: ['手机上响一次', '电脑上也响'] }),
  note('t2', '提机就接通', { goal_id: 'g1', status: 'confirm', assignee: 'claude', start: dayAt(0, '11:00'), end: dayAt(0, '11:30'), work_type: 'dev', from: { kind: 'meeting', ref: 'm-1021' }, acceptance: ['提起听筒 1 秒内接通'], receipt: { kind: 'done', text: '做完:1 提机 0.6 秒接通,录屏在 /tmp/pickup.mov', by: 'claude', at: '2026-10-21T08:30:00.000Z' } }),
  note('t3', '配网说明写一页', { goal_id: 'g1', status: 'todo', assignee: 'me', start: dayAt(1, '14:00'), end: dayAt(1, '15:30'), work_type: 'content', acceptance: ['不懂代码的人照着能配上'] }),
  note('t4', '剪 30 秒样片', { goal_id: 'g2', status: 'blocked', assignee: 'doubao', start: dayAt(0, '11:30'), end: dayAt(0, '12:00'), work_type: 'content', acceptance: ['30 秒内', '有字幕'], receipt: { kind: 'blocked', text: '卡住:素材文件夹没权限', at: AT } }),
  note('t5', '封面三选一', { goal_id: 'g2', status: 'confirm', assignee: 'codex', start: dayAt(2, '10:00'), collaborators: ['me'], acceptance: ['给三张'], receipt: { kind: 'objection', text: '有异议:第三张版权不清楚,建议换', at: '2026-10-21T08:50:00.000Z' } }),
  // 一张高的(看「目标 · 验收 N 条」与为什么)、一个只有开始的时间点
  note('t8', '写清交回的样子', { goal_id: 'g1', status: 'doing', assignee: 'claude', start: dayAt(0, '08:30'), end: dayAt(0, '11:00'), work_type: 'dev', desc: '交回时先说检查结果,再说改了哪里,让人不打开文件也知道做没做完。', acceptance: ['对着验收编号答', '附录屏', '写明没验的'] }),
  note('t9', '给客户回电', { goal_id: 'g2', status: 'todo', assignee: 'me', start: dayAt(0, '15:30'), work_type: 'routine' }),
  note('t6', '按清单真机走一遍', { status: 'todo' }),
  note('t7', '上周会上提的那件', { status: 'backlog', origin: 'meeting' }),
]
export const COLLAB_GOALS = [
  { id: 'g1', title: '座机出门也能接', why: '不用守着电脑,电话响了就接', owner: 'me' as const, status: 'open' as const, due: '2026-10-30', version: '0.4.140', created_at: AT, updated_at: AT, risk: { level: 'tight' as const, reason: '还剩 9 天,按最近速度要 8 天', window_days: 14 } },
  { id: 'g2', title: '周五发样片', why: '客户等着看方向', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
  { id: 'g3', title: '早报改成播客', owner: 'me' as const, status: 'open' as const, created_at: AT, updated_at: AT },
]

export const COLLAB_EXTRA = {
  meetings: { recent: [{
      id: 'm1', title: '远程派活方案评审', date: '', started_at: dayAt(0, '14:00'), ended_at: dayAt(0, '14:30'), status: 'done', segments: 3,
      summary: '手机离开电脑后,派单与交回分别要给出明确结果。先用一轮真机实测确认,再调整桌面的派活入口。', unsure: [],
      decisions: ['先验通手机,再做桌面入口', '交回必须对着验收编号答'],
      todos: [{ id: 'td1', what: '先验通手机,再做桌面入口' }, { id: 'td2', what: '提机就接通', task_id: 't2' }],
      prep: { said: '', card_status: 'ready', card: { made_at: AT, questions: [{ q: '派单到了哪里', line: '', fallback: '' }, { q: '结果怎么交回来', line: '', fallback: '' }] }, people: { value: [{ alias: '小李' }], from: 'said' } },
      timeline: [{ at: dayAt(0, '14:00'), text: '会议开始' }, { at: dayAt(0, '14:32'), text: '你确认了纪要' }],
    }] },
}
