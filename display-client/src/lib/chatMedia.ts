/**
 * Chat media client — integrates sandbox storage with backend APIs.
 *
 * Flow:
 * 1. AI generates voice/image -> server returns bytes directly (no server persistence)
 * 2. Client saves bytes to sandbox (IndexedDB / Capacitor Filesystem)
 * 3. Rendering checks sandbox first, falls back to regenerate-media endpoint
 * 4. If regenerate also fails (410), show "内容已过期"
 */

import { apiFetch, getBaseUrl, getStoredToken, getDeviceId } from './apiClient.ts';
import {
  API_MESSAGES,
  API_MESSAGES_IMAGE_GENERATE,
  apiMessageRegenerateMediaPath,
} from './apiConfig.ts';
import type { ChatMessage } from './llm.ts';
import {
  saveVoiceToSandbox,
  saveImageToSandbox,
  loadVoiceFromSandbox,
  loadImageFromSandbox,
  hasVoiceInSandbox,
  hasImageInSandbox,
  deleteMediaFromSandbox,
  clearAllSandboxMedia,
  getDefaultMediaStore,
} from './mediaSandbox.ts';

export {
  deleteMediaFromSandbox,
  clearAllSandboxMedia,
  getDefaultMediaStore,
};

export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_DURATION_MS = 20 * 1000;

type MessagesResponse = {
  messages: ChatMessage[];
};

type MessageResponse = {
  message: ChatMessage;
};

export function resolveMediaUrl(url: string) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
  }
  return `${getBaseUrl()}${url.startsWith('/') ? url : `/${url}`}`;
}

// ---- Server API wrappers ----

export async function loadChatMessages(avatarId: string) {
  const params = new URLSearchParams({ avatarId });
  const response = (await apiFetch(`${API_MESSAGES}?${params.toString()}`, {
    method: 'GET',
  })) as MessagesResponse;
  return response.messages.map((message) => ({
    ...message,
    type: message.type || 'text',
    status: 'sent' as const,
  }));
}

export async function saveChatMessage(avatarId: string, message: ChatMessage) {
  const response = (await apiFetch(API_MESSAGES, {
    method: 'POST',
    body: JSON.stringify({
      id: message.id,
      avatarId,
      role: message.role,
      type: message.type || 'text',
      content: message.content || '',
      ttsText: message.ttsText,
      imagePrompt: message.imagePrompt,
      voice: message.voice,
      image: message.image,
      createdAt: message.createdAt || Date.now(),
    }),
  })) as MessageResponse;
  return { ...response.message, status: 'sent' as const };
}

/**
 * Generate an image via the backend DashScope / Tongyi Wanxiang integration.
 * Returns a Blob that the caller should save to sandbox.
 */
export async function generateImage(prompt: string): Promise<Blob> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${API_MESSAGES_IMAGE_GENERATE}`;
  const token = getStoredToken();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': getDeviceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Image generation failed (${res.status})`);
  }

  return res.blob();
}

/**
 * Regenerate media for a message (sandbox miss).
 * Returns a Blob on success; throws on failure.
 * A 410 error means the source material is gone (tts_text / image_prompt missing).
 */
export async function regenerateMedia(messageId: string): Promise<Blob> {
  const path = apiMessageRegenerateMediaPath(messageId);
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;
  const token = getStoredToken();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Device-Id': getDeviceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (res.status === 410) {
    const error = new Error('内容已过期');
    (error as Error & { code: string }).code = 'content_expired';
    throw error;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Regeneration failed (${res.status})`);
  }

  return res.blob();
}

// ---- Sandbox helpers ----

export async function ensureVoiceInSandbox(message: ChatMessage): Promise<string> {
  if (message.type !== 'voice' || !message.id) return '';

  const exists = await hasVoiceInSandbox(message.id);
  if (exists) {
    const blob = await loadVoiceFromSandbox(message.id);
    if (blob) return URL.createObjectURL(blob);
  }

  // Miss -> regenerate from server
  try {
    const blob = await regenerateMedia(message.id);
    await saveVoiceToSandbox(message.id, blob);
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error('[chatMedia] voice regeneration failed:', error);
    throw error;
  }
}

export async function ensureImageInSandbox(message: ChatMessage): Promise<string> {
  if (message.type !== 'image' || !message.id) return '';

  const exists = await hasImageInSandbox(message.id);
  if (exists) {
    const blob = await loadImageFromSandbox(message.id);
    if (blob) return URL.createObjectURL(blob);
  }

  // Miss -> regenerate from server
  try {
    const blob = await regenerateMedia(message.id);
    await saveImageToSandbox(message.id, blob);
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error('[chatMedia] image regeneration failed:', error);
    throw error;
  }
}

export async function saveGeneratedVoice(messageId: string, blob: Blob): Promise<void> {
  await saveVoiceToSandbox(messageId, blob);
}

export async function saveGeneratedImage(messageId: string, blob: Blob): Promise<void> {
  await saveImageToSandbox(messageId, blob);
}
