import type { ChatMetadata } from './types.ts';

const STORAGE_KEY = 'llm-live2d:chat-summaries';

export function loadChatMetadata(chatId: string): ChatMetadata {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { summaries: [] };
    const all = JSON.parse(raw) as Record<string, ChatMetadata>;
    return all[chatId] ?? { summaries: [] };
  } catch {
    return { summaries: [] };
  }
}

export function saveChatMetadata(chatId: string, metadata: ChatMetadata): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all: Record<string, ChatMetadata> = raw ? (JSON.parse(raw) as Record<string, ChatMetadata>) : {};
    all[chatId] = metadata;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage errors
  }
}

export function clearChatMetadata(chatId: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, ChatMetadata>;
    delete all[chatId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}
