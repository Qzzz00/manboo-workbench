import { describe, expect, it } from 'vitest';

import { initialState, isBusy, statusTextFor, strategistReducer } from './strategistSession.ts';

/** 走完整链路到「正在出答案」：按住 → 松开 → 识别 → 出字。 */
function answering(text = '答案') {
  let s = strategistReducer(initialState(), { type: 'holdStart' });
  s = strategistReducer(s, { type: 'holdEnd' });
  s = strategistReducer(s, { type: 'transcribed', text: '这里怎么过' });
  return strategistReducer(s, { type: 'delta', text });
}

describe('strategistReducer', () => {
  it('★初始态是「角色主动招呼」，不是空白待机', () => {
    expect(initialState().kind).toBe('greeting');
    expect(statusTextFor(initialState())).toContain('需要我帮忙');
  });

  it('★点一下角色不再直接出答案——提问必须由用户开口', () => {
    // 原来 ask→capturing→直接问，用户会懵「我不用问问题吗」；现在 ask 只回到待命。
    expect(strategistReducer(initialState(), { type: 'ask' }).kind).toBe('greeting');
  });

  it('点一下把上一条答案收走，回到待命', () => {
    const s = strategistReducer(answering('上一条答案'), { type: 'done' });
    expect(strategistReducer(s, { type: 'ask' }).kind).toBe('greeting');
  });

  it('delta 逐段拼接成回答', () => {
    let s = answering('你现在');
    s = strategistReducer(s, { type: 'delta', text: '在道馆' });
    expect(s.kind).toBe('answering');
    expect(s.kind === 'answering' && s.text).toBe('你现在在道馆');
  });

  it('done 保留已经吐出来的文字（别把答案清空）', () => {
    const s = strategistReducer(answering('答案'), { type: 'done' });
    expect(s.kind).toBe('done');
    expect(s.kind === 'done' && s.text).toBe('答案');
  });

  it('任何阶段的 error 都进 error 态并带上文案', () => {
    const s = strategistReducer(strategistReducer(initialState(), { type: 'ask' }), {
      type: 'error',
      message: '截屏失败了',
    });
    expect(s.kind).toBe('error');
    expect(s.kind === 'error' && s.message).toBe('截屏失败了');
  });

  it('忙的时候点一下 = 取消，回到待命（而不是并发发两轮）', () => {
    expect(strategistReducer(answering(), { type: 'ask' }).kind).toBe('greeting');
  });

  it('reset 无条件回待命（F10 收条用）', () => {
    expect(strategistReducer(answering(), { type: 'reset' }).kind).toBe('greeting');
  });

  it('★答案出完就停在 done——不再定时收走，用户要能回头慢慢看', () => {
    const s = strategistReducer(answering('很长的一段攻略'), { type: 'done' });
    expect(s.kind).toBe('done');
    expect(s.kind === 'done' && s.text).toBe('很长的一段攻略');
  });

  it('按住进入 listening，松开进入转写', () => {
    let s = strategistReducer(initialState(), { type: 'holdStart' });
    expect(s.kind).toBe('listening');
    s = strategistReducer(s, { type: 'holdEnd' });
    expect(s.kind).toBe('transcribing');
  });

  it('没在录音时收到 holdEnd 不改状态（原生手势乱序的兜底）', () => {
    const before = answering();
    expect(strategistReducer(before, { type: 'holdEnd' })).toBe(before);
  });

  it('忙的时候按住不抢占正在跑的那一轮', () => {
    const before = answering();
    expect(strategistReducer(before, { type: 'holdStart' })).toBe(before);
  });

  it('识别出的文字一路带到答案里（底条要显示「你问：…」）', () => {
    let s = strategistReducer(initialState(), { type: 'holdStart' });
    s = strategistReducer(s, { type: 'holdEnd' });
    s = strategistReducer(s, { type: 'transcribed', text: '这里怎么过' });
    expect(s.kind === 'thinking' && s.transcript).toBe('这里怎么过');
    s = strategistReducer(s, { type: 'delta', text: '往左走' });
    expect(s.kind === 'answering' && s.transcript).toBe('这里怎么过');
    s = strategistReducer(s, { type: 'done' });
    expect(s.kind === 'done' && s.transcript).toBe('这里怎么过');
  });
});

describe('isBusy', () => {
  it('跑着的四个态都算忙', () => {
    expect(isBusy({ kind: 'capturing' })).toBe(true);
    expect(isBusy({ kind: 'listening' })).toBe(true);
    expect(isBusy({ kind: 'thinking' })).toBe(true);
    expect(isBusy({ kind: 'answering', text: 'x' })).toBe(true);
  });

  it('结果挂在屏幕上不算忙（要能马上问下一个）', () => {
    expect(isBusy({ kind: 'greeting' })).toBe(false);
    expect(isBusy({ kind: 'done', text: 'x' })).toBe(false);
    expect(isBusy({ kind: 'error', message: 'x' })).toBe(false);
  });
});

describe('statusTextFor', () => {
  it('每个中间态都有话说，不让用户面对空白', () => {
    for (const s of [
      { kind: 'greeting' as const },
      { kind: 'capturing' as const },
      { kind: 'listening' as const },
      { kind: 'transcribing' as const },
      { kind: 'thinking' as const },
    ]) {
      expect(statusTextFor(s)).not.toBe('');
    }
  });

  it('出答案的两个态由内容本身表达，不再叠状态文案', () => {
    expect(statusTextFor({ kind: 'answering', text: 'x' })).toBe('');
    expect(statusTextFor({ kind: 'done', text: 'x' })).toBe('');
  });

  it('error 直接显示原因', () => {
    expect(statusTextFor({ kind: 'error', message: '连不上服务器' })).toBe('连不上服务器');
  });
});
