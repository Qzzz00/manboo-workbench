import { apiGet, apiPost } from './apiClient.ts';
import type { ChatMessage } from './llm.ts';

export type ServerChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  type: 'text' | 'voice' | 'image';
  content: string;
  media?:
    | { type: 'voice'; url: string; durationMs: number; mimeType?: string }
    | { type: 'image'; url: string; width?: number; height?: number; thumbUrl?: string; mimeType?: string; sizeBytes?: number };
  expression?: string;
  expressionMix?: Array<{ key: string; weight: number }>;
  parameterOverrides?: Array<{ id: string; value: number }>;
  meta?: string;
  createdAt?: number;
};

export async function fetchChatMessages(avatarId: string): Promise<ServerChatMessage[]> {
  const data = (await apiGet(`/api/messages?avatarId=${encodeURIComponent(avatarId)}`)) as {
    messages: ServerChatMessage[];
  };
  return data.messages || [];
}

export async function saveChatMessage(
  avatarId: string,
  message: ChatMessage,
): Promise<void> {
  const payload: Record<string, unknown> = {
    id: message.id,
    avatarId,
    role: message.role,
    type: message.type || 'text',
    content: message.content,
  };
  if (message.media) payload.media = message.media;
  if (message.expression) payload.expression = message.expression;
  if (message.expressionMix) payload.expressionMix = message.expressionMix;
  if (message.parameterOverrides) payload.parameterOverrides = message.parameterOverrides;
  if (message.meta) payload.meta = message.meta;

  await apiPost('/api/messages', payload);
}
