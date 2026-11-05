import { describe, expect, it } from 'vitest';
import { selectCurrentTurnImageUrl, type ChatMessage } from './llm.ts';

function userText(id: string, content: string): ChatMessage {
  return { id, role: 'user', type: 'text', content };
}

function userImage(id: string, url?: string): ChatMessage {
  return {
    id,
    role: 'user',
    type: 'image',
    content: '[图片消息]',
    image: url
      ? { url, width: 100, height: 100, mime_type: 'image/png', size_bytes: 1234 }
      : undefined,
  } as ChatMessage;
}

function assistant(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', type: 'text', content };
}

describe('selectCurrentTurnImageUrl', () => {
  it('当前回合最后一条 user 是图 → 返回该 url', () => {
    const history: ChatMessage[] = [
      userText('1', '你好'),
      assistant('2', '嗨'),
      userImage('3', 'https://example.com/pic.png'),
    ];
    expect(selectCurrentTurnImageUrl(history)).toBe('https://example.com/pic.png');
  });

  it('当前回合是文字、历史里更早有一张图 → 返回 null（核心回归）', () => {
    const history: ChatMessage[] = [
      userImage('1', 'https://example.com/old.png'),
      assistant('2', '收到'),
      userText('3', '这段纯文字'),
    ];
    expect(selectCurrentTurnImageUrl(history)).toBeNull();
  });

  it('历史里完全没有图 → 返回 null', () => {
    const history: ChatMessage[] = [
      userText('1', '你好'),
      assistant('2', '嗨'),
      userText('3', '在吗'),
    ];
    expect(selectCurrentTurnImageUrl(history)).toBeNull();
  });

  it('图消息缺 image.url → 返回 null', () => {
    const history: ChatMessage[] = [
      userText('1', '你好'),
      userImage('2'),
    ];
    expect(selectCurrentTurnImageUrl(history)).toBeNull();
  });

  it('末尾是 assistant 时以最后一条 user 为准（其为图 → 返回 url）', () => {
    const history: ChatMessage[] = [
      userImage('1', 'https://example.com/pic.png'),
      assistant('2', '思考中...'),
    ];
    expect(selectCurrentTurnImageUrl(history)).toBe('https://example.com/pic.png');
  });

  it('空历史 → 返回 null', () => {
    expect(selectCurrentTurnImageUrl([])).toBeNull();
  });
});
