import type { Chat } from './types.ts';
import { saveChatMetadata } from './store.ts';

function findMsgIndex(chat: Chat, messageId: string): number {
  return chat.messages.findIndex((m) => m.id === messageId);
}

function findMsg(chat: Chat, messageId: string) {
  const idx = findMsgIndex(chat, messageId);
  return idx >= 0 ? chat.messages[idx] : undefined;
}

/**
 * 级联 dirty：把所有 prev_summary_id 指向 dirty 摘要的后代也标 dirty，反复传播到稳定。
 */
export function cascadeDirty(chat: Chat): void {
  const byId = new Map(chat.metadata.summaries.map((s) => [s.id, s]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of chat.metadata.summaries) {
      if (s.status !== 'dirty' && s.prev_summary_id) {
        const prev = byId.get(s.prev_summary_id);
        if (prev?.status === 'dirty') {
          s.status = 'dirty';
          changed = true;
        }
      }
    }
  }
}

/**
 * 删除消息时的摘要钩子。
 * 当被删除的消息是某摘要的 bound_message_id 时，移除该摘要并链式 dirty 其后代。
 * 当被删除的消息仅被某摘要覆盖（非 bound）时，视为编辑：链式 dirty。
 */
export function onMessageDeleted(chat: Chat, messageId: string): void {
  // 1) 删除直接 bound 到该消息的摘要
  const toDrop = chat.metadata.summaries.filter((s) => s.bound_message_id === messageId);
  if (toDrop.length === 0) {
    // 2) 若该消息只是被某摘要覆盖但不是其末位，等同于编辑：链式 dirty
    onMessageEdited(chat, messageId);
    return;
  }
  const droppedIds = new Set(toDrop.map((s) => s.id));
  // 3) 删除后，原本 prev_summary_id 指向被删摘要的链式后代也要 dirty
  for (const s of chat.metadata.summaries) {
    if (s.prev_summary_id && droppedIds.has(s.prev_summary_id)) {
      s.status = 'dirty';
    }
  }
  chat.metadata.summaries = chat.metadata.summaries.filter((s) => !droppedIds.has(s.id));
  cascadeDirty(chat);
  saveChatMetadata(chat.id, chat.metadata);
}

/**
 * 编辑消息时的摘要钩子。
 * 当被编辑的消息落在某个摘要的覆盖区间内时，该摘要及其之后所有链式摘要全部 dirty。
 */
export function onMessageEdited(chat: Chat, messageId: string): void {
  const editedMsg = findMsg(chat, messageId);
  if (!editedMsg) return;

  const editedIdx = findMsgIndex(chat, messageId);
  if (editedIdx < 0) return;

  // 找到第一份覆盖该消息的摘要（按 created_at 升序，即数组顺序）
  let hitIdx = -1;
  const sorted = [...chat.metadata.summaries].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const fromIdx = findMsgIndex(chat, s.from_message_id);
    const toIdx = findMsgIndex(chat, s.to_message_id);
    if (fromIdx >= 0 && toIdx >= 0 && editedIdx >= fromIdx && editedIdx <= toIdx) {
      hitIdx = i;
      break;
    }
  }
  if (hitIdx < 0) return; // 该消息不在任何摘要覆盖区间内，无需动作

  // 命中的那份 + 其后所有摘要全部 dirty
  for (let i = hitIdx; i < sorted.length; i++) {
    sorted[i].status = 'dirty';
  }

  // 再走一遍 prev_summary_id 链式传播
  cascadeDirty(chat);
  saveChatMetadata(chat.id, chat.metadata);
}
