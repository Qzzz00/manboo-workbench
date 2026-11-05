/** 邀请复用既有派活引擎。先原子认领精确子事项,重发/并发/重启都不再自动派第二次。 */
import type { AgentCardAssignee, NoteMessage } from '../protocol.ts'
import type { TasksService } from './tasks.ts'
export type InvitationDispatch = (taskId: string, input: { family: AgentCardAssignee, text: string }) => Promise<{ ok: boolean, note: string }>
export async function deliverInvitations(tasks: TasksService, taskId: string, message: NoteMessage, dispatch?: InvitationDispatch): Promise<void> {
  if (message.intent !== 'ask') return
  for (const delivery of message.deliveries ?? []) {
    if (delivery.status !== 'pending') continue
    if (delivery.to.startsWith('agent:')) {
      const card = (await tasks.list()).agent_cards?.find(c => c.id === delivery.to)
      if (card !== undefined && card.owner !== 'me') {
        await tasks.finishInvitation(taskId, message.id, delivery.to, { ok: false, note: '这张名片属于外部成员,当前没有获准的远程执行路径;未在本机代派' })
        continue
      }
    }
    const claimed = await tasks.prepareInvitation(taskId, message.id, delivery.to)
    if (!claimed.fresh || claimed.taskId === undefined) continue
    const result = dispatch === undefined ? { ok: false, note: '这台未接派活引擎' }
      : await dispatch(claimed.taskId, { family: delivery.to as AgentCardAssignee, text: message.text }).catch(() => ({ ok: false, note: '投递中断,结果未知;请查执行事项后再决定重派' }))
    await tasks.finishInvitation(taskId, message.id, delivery.to, result)
  }
}
