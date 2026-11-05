import { markLocalChanged } from './syncEngine.ts';

export type BubbleStyle = 'light' | 'dark';

const KEY = 'llm-live2d:chat-bubble-style';

export function loadBubbleStyle(): BubbleStyle {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'dark') return 'dark';
  } catch { /* ignore */ }
  return 'light';
}

export function saveBubbleStyle(style: BubbleStyle) {
  localStorage.setItem(KEY, style);
  markLocalChanged('bubbleStyle');
}
