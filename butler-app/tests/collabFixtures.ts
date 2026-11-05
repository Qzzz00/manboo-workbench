/**
 * 协作模型测试共用的假件(2026-10-24,小K)。
 *
 * `fieldsOf`:把「原始 JSON 里的协作字段」按 id 打到一张卡上 —— 模拟 /state 真实回包里
 * 手机镜像还没声明的那几格(goal_id/acceptance/comments/receipt/children/from/start/end…)。
 */
import type { TaskView } from '../src/api/protocol';
import { collabFields, type CollabFields } from '../src/collab/collabState';

export type FieldsFn = (task: TaskView) => CollabFields;

export function fieldsOf(map: ReadonlyMap<string, Partial<CollabFields>>): FieldsFn {
  return (task) => ({ ...collabFields(task), ...(map.get(task.id) ?? {}) });
}
