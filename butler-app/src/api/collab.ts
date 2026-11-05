/** 协作区公共 API 消费口:沿用 ApiClient 的直连/房间选路、请求号与错误回执。 */
import type { ApiClient } from './client';
import type { ActivityItem, CapacityItem, CollabGoal, GoalBoardSummary, GoalCondition, LanChannelMessage, LanChannelCategory, LanChannelSourceScope, LanIdentity, LanMember, NoteMessage, RunSegment, TaskRelation } from './protocol';
export function collabClient(client: ApiClient) {
  const post = <T = { ok: boolean }>(path: string, body: unknown) => client.json<T>(path, { method: 'POST', body });
  return {
    board: (goalId: string) => client.json<{ summary: GoalBoardSummary }>(`/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`),
    activity: (taskId: string) => client.json<{ items: ActivityItem[] }>(`/collab/note/activity?id=${encodeURIComponent(taskId)}`),
    relations: (taskId: string) => client.json<{ relations: TaskRelation[] }>(`/collab/relations?task_id=${encodeURIComponent(taskId)}`),
    runs: (taskId: string) => client.json<{ runs: RunSegment[] }>(`/collab/runs?task_id=${encodeURIComponent(taskId)}`),
    capacity: () => client.json<{ items: CapacityItem[] }>('/collab/capacity'),
    lanIdentity: () => client.json<{ identity: LanIdentity }>('/collab/lan/identity'),
    lanMembers: () => client.json<{ members: LanMember[] }>('/collab/lan/members'),
    lanChannel: (projectId: string, filter: { category?: LanChannelCategory | 'unknown' | undefined, topic_id?: string | undefined, source_id?: string | undefined } = {}) => {
      const query = Object.entries(filter).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join('');
      return client.json<{ messages: LanChannelMessage[], transport: 'lan', scope: string, source_scope?: LanChannelSourceScope }>(`/collab/lan/channel?project_id=${encodeURIComponent(projectId)}${query}`);
    },
    createGoal: (goal: Pick<CollabGoal, 'title'> & Partial<Pick<CollabGoal, 'why' | 'due' | 'project_id'>>) => post<{ ok: boolean, id: string }>('/collab/goal/create', goal),
    saveCondition: (goalId: string, condition: Pick<GoalCondition, 'text'> & Partial<Pick<GoalCondition, 'id' | 'evidence'>> & { task_id?: string | null }) => post<{ ok: boolean, id: string }>('/collab/goal/condition/save', { goal_id: goalId, ...condition }),
    removeCondition: (goalId: string, conditionId: string) => post('/collab/goal/condition/remove', { goal_id: goalId, condition_id: conditionId }),
    verify: (goalId: string, conditionId: string, input: { pass: boolean, note?: string }) => post('/collab/goal/condition/verify', { goal_id: goalId, condition_id: conditionId, by: 'me', ...input }),
    deliver: (goalId: string, conditionId: string) => post('/collab/goal/condition/deliver', { goal_id: goalId, condition_id: conditionId }),
    message: (taskId: string, message: Pick<NoteMessage, 'text' | 'intent'> & Partial<Pick<NoteMessage, 'mentions' | 'reply_to' | 'client_msg_id'>>) => post<{ ok: boolean, message: NoteMessage }>('/collab/note/message', { task_id: taskId, ...message }),
    saveRelation: (relation: Pick<TaskRelation, 'from_id' | 'to_id' | 'kind'> & Partial<Pick<TaskRelation, 'note'>>) => post<{ ok: boolean, id: string }>('/collab/relation/save', relation),
    removeRelation: (id: string) => post('/collab/relation/remove', { id }),
    rename: (name: string, expectedVersion: number) => post('/collab/lan/identity', { name, expected_version: expectedVersion }),
    sendLan: (message: Pick<LanChannelMessage, 'project_id' | 'text'> & Partial<Pick<LanChannelMessage, 'kind' | 'reply_to' | 'client_msg_id'>> & { recipients: string[] }) => post<{ ok: boolean, message: LanChannelMessage }>('/collab/lan/channel/send', message),
  };
}
