/**
 * 人与 Agent 的头像标签(2026-10-21,视觉 A「头像关联」)。点选一个标签:相关事项加轮廓、其余原位变淡,
 * 卡内标「负责 / 协作 / 参加」。「只看我」= 选中的是你。纯函数。
 */
import type { CollabSquad, MeetingView, TaskView } from '../../protocol.ts'
import { boardAssignee } from '../../protocol.ts'

export type Relation = 'owner' | 'collab' | 'attend'
export const RELATION_TITLES: Readonly<Record<Relation, string>> = { owner: '负责', collab: '协作', attend: '参加' }

export function noteRelation(task: TaskView, person: string): Relation | undefined {
  if (boardAssignee(task.assignee) === person) return 'owner'
  if ((task.collaborators ?? []).includes(person)) return 'collab'
  return undefined
}

/**
 * 会议:一个人的板上你总在场;别人按会前登记的参与人名字认(会议目录里记的是花名,不是账号)。
 * 认不出就没关系 —— 不猜。
 */
export function meetingRelation(meeting: MeetingView, person: string, name: string): Relation | undefined {
  if (person === 'me') return 'attend'
  const people = meeting.prep?.people?.value ?? []
  return people.some(one => one.alias === name) ? 'attend' : undefined
}

/** 负责人那一行:派给小队时写成「小队 · 组长 → 实际负责人」。 */
export function ownerLine(task: TaskView, ctx: { squads: readonly CollabSquad[], nameOf: (id: string | undefined) => string }): string {
  const owner = ctx.nameOf(boardAssignee(task.assignee))
  const squad = task.squad_id === undefined ? undefined : ctx.squads.find(one => one.id === task.squad_id)
  if (squad === undefined) return owner
  const leader = ctx.nameOf(squad.leader)
  return leader === owner ? `${squad.name} · ${leader}` : `${squad.name} · ${leader} → ${owner}`
}

/** 头像里那个字:取名字第一个字(英文取首字母大写);Agent 名片统一写 A。 */
export function avatarGlyph(name: string, kind: 'me' | 'agent' | 'card' | 'member'): string {
  if (kind === 'agent' || kind === 'card') return 'A'
  const first = [...name.trim()][0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}
