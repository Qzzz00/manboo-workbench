import type { CommentIntent } from './comments';
export interface CollabDraft { text: string; intent: CommentIntent; pickedIds: string[] }
const memory = new Map<string, string>();
const keyOf = (device: string, task: string) => `wb.collab.draft.${encodeURIComponent(device)}.${encodeURIComponent(task)}`;
const empty = (): CollabDraft => ({ text: '', intent: 'record', pickedIds: [] });
export function readCollabDraft(device: string, task: string): CollabDraft {
  const key = keyOf(device, task);
  let text: string | null | undefined;
  try { text = window.localStorage.getItem(key); } catch { text = memory.get(key); }
  try {
    const value: unknown = JSON.parse(text ?? 'null');
    if (value === null || typeof value !== 'object') return empty();
    const raw = value as Record<string, unknown>;
    return { text: typeof raw.text === 'string' ? raw.text : '', intent: raw.intent === 'ask' ? 'ask' : 'record', pickedIds: Array.isArray(raw.pickedIds) ? raw.pickedIds.filter((id): id is string => typeof id === 'string') : [] };
  } catch { return empty(); }
}
export function saveCollabDraft(device: string, task: string, draft: CollabDraft): void {
  const key = keyOf(device, task), value = JSON.stringify(draft);
  try {
    if (draft.text.trim() === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (draft.text.trim() === '') memory.delete(key); else memory.set(key, value);
  }
}
