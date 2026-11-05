import { getBaseUrl, getStoredToken } from './apiClient.ts';
import { API_AI_IMAGE } from './apiConfig.ts';

export type GeneratedBg = {
  url: string;
  prompt: string;
  timestamp: number;
};

export async function generateBackground(prompt: string): Promise<GeneratedBg> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${API_AI_IMAGE}`;
  const token = getStoredToken();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `背景生成失败 (${res.status})`);
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  return { url: objectUrl, prompt, timestamp: Date.now() };
}

export async function generateAssistantImage(prompt: string): Promise<GeneratedBg> {
  // Reuse the same endpoint; the caller decides how to use the result.
  return generateBackground(prompt);
}

const BG_STORAGE_KEY = 'llm-live2d:backgrounds';

export function loadBackgrounds(): Record<string, GeneratedBg> {
  try {
    return JSON.parse(localStorage.getItem(BG_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveBackground(avatarId: string, bg: GeneratedBg) {
  const bgs = loadBackgrounds();
  bgs[avatarId] = bg;
  localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(bgs));
}
