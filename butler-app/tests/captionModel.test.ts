/**
 * 字幕模型(2026-09-17 舞台式主界面):球下面一到两行字,最新一句。
 * 纯函数,不碰 DOM——「显示什么」「显示多少」「什么时候淡出」都在这里定。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTION_MAX,
  CAPTION_TIMING,
  captionLinesOf,
  captionPhaseAt,
  revealedText,
  splitSentences,
  truncateCaption,
} from '../src/stage/captionModel';
import type { ThreadMessage } from '../src/chat/chatModel';

function msg(over: Partial<ThreadMessage> & { user: string }): ThreadMessage {
  return {
    taskId: 't-1',
    at: '2026-09-17T01:00:00Z',
    butler: { kind: 'reply', text: '好的,我去办。', speak: true },
    ...over,
  };
}

describe('captionLinesOf', () => {
  it('没有记录就没有字幕', () => {
    expect(captionLinesOf([])).toEqual({});
  });
  it('只取最后一条:上面是我说的,下面是事务官那句', () => {
    const lines = captionLinesOf([
      msg({ user: '第一件事', taskId: 't-1' }),
      msg({ user: '把版本号补一下', taskId: 't-2', butler: { kind: 'reply', text: '补好了。', speak: true } }),
    ]);
    expect(lines.me?.text).toBe('把版本号补一下');
    expect(lines.butler?.text).toBe('补好了。');
    expect(lines.butler?.kind).toBe('reply');
    // key 认「哪条事项 + 说了什么」:同一条事项换了回复也算新字幕。
    expect(lines.butler?.key).toContain('t-2');
    expect(lines.me?.key).toContain('t-2');
  });
  it('状态句(不是真回复)也上字幕,但标成 status,由界面决定淡一点', () => {
    const lines = captionLinesOf([msg({ user: '喂', butler: { kind: 'status', text: '事务官在办', speak: false } })]);
    expect(lines.butler).toEqual({ kind: 'status', text: '事务官在办', key: expect.stringContaining('t-1') });
  });
  it('★她停着等他答的那一件先上字幕(卡 M 补:她在等他答时字幕说「等你回答」),哪怕后来他又说了一件别的', () => {
    const lines = captionLinesOf([
      msg({ user: '修一下小头像', taskId: 't-1', butler: { kind: 'status', text: '等你回答:派活前对一遍', speak: false, waiting: 'answer' } }),
      msg({ user: '顺便看看天气', taskId: 't-2', butler: { kind: 'status', text: '事务官在办', speak: false } }),
    ]);
    expect(lines.me?.text).toBe('修一下小头像');
    expect(lines.butler?.text).toBe('等你回答:派活前对一遍');
  });
  it('还没落地的那条(只有 localId)也能出字幕', () => {
    const lines = captionLinesOf([{ localId: 'p-9', user: '在吗', at: '', butler: { kind: 'status', text: '发送中…', speak: false } }]);
    expect(lines.me?.text).toBe('在吗');
    expect(lines.butler?.key).toContain('p-9');
  });
});

describe('truncateCaption', () => {
  it('短句原样,不截', () => {
    expect(truncateCaption('补好了。')).toEqual({ shown: '补好了。', truncated: false });
  });
  it('超长截断加省略号,长度不超过上限 + 1', () => {
    const long = '一'.repeat(CAPTION_MAX + 40);
    const r = truncateCaption(long);
    expect(r.truncated).toBe(true);
    expect(r.shown.endsWith('…')).toBe(true);
    expect(r.shown.length).toBe(CAPTION_MAX + 1);
  });
  it('上限可以调', () => {
    expect(truncateCaption('一二三四五', 3)).toEqual({ shown: '一二三…', truncated: true });
  });
});

describe('splitSentences', () => {
  it('按句号 / 问号 / 感叹号 / 换行切,标点跟着前一句', () => {
    expect(splitSentences('补好了。要发版吗?')).toEqual(['补好了。', '要发版吗?']);
    expect(splitSentences('第一行\n第二行')).toEqual(['第一行\n', '第二行']);
  });
  it('没有标点就是一整句;空串没有句子', () => {
    expect(splitSentences('在办')).toEqual(['在办']);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('revealedText:随朗读逐句出现', () => {
  const text = '补好了。要发版吗?我先等你一句。';
  it('一开头就有第一句(不是一个字一个字蹦)', () => {
    expect(revealedText(text, 0, 100)).toBe('补好了。');
  });
  it('时间够了才出第二句、第三句', () => {
    expect(revealedText(text, 450, 100)).toBe('补好了。要发版吗?');
    expect(revealedText(text, 5000, 100)).toBe(text);
  });
  it('空文本就是空', () => {
    expect(revealedText('', 999, 100)).toBe('');
  });
});

describe('captionPhaseAt:出现 → 停留 → 淡出', () => {
  const timing = { msPerChar: 100, holdMs: 1000, fadeMs: 200 };
  const len = 10; // 读完要 1000ms

  it('还在出字的时候是 revealing', () => {
    expect(captionPhaseAt({ length: len, sinceMs: 300, speaking: false, expanded: false, timing })).toBe('revealing');
  });
  it('在朗读就一直不走(TTS 比估算的慢也不会提前消失)', () => {
    expect(captionPhaseAt({ length: len, sinceMs: 99999, speaking: true, expanded: false, timing })).toBe('revealing');
  });
  it('读完停留几秒', () => {
    expect(captionPhaseAt({ length: len, sinceMs: 1500, speaking: false, expanded: false, timing })).toBe('hold');
  });
  it('停留完了淡出,再之后就没了', () => {
    expect(captionPhaseAt({ length: len, sinceMs: 2100, speaking: false, expanded: false, timing })).toBe('leaving');
    expect(captionPhaseAt({ length: len, sinceMs: 2500, speaking: false, expanded: false, timing })).toBe('gone');
  });
  it('点开看全文的时候不淡出', () => {
    expect(captionPhaseAt({ length: len, sinceMs: 99999, speaking: false, expanded: true, timing })).toBe('hold');
  });
  it('缺省时值:停留 ≥ 4 秒(Ben 要看得清),淡出不超过 1 秒', () => {
    expect(CAPTION_TIMING.holdMs).toBeGreaterThanOrEqual(4000);
    expect(CAPTION_TIMING.fadeMs).toBeLessThanOrEqual(1000);
  });
});
