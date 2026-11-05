import { describe, expect, it } from 'vitest';
import type { SessionView } from './workbenchProtocol';
import {
  formatResetAt,
  humanDuration,
  reduceLive,
} from './displayFeed';
import { emptyState } from './workbenchProtocol';

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh',
    session_id: 'a7c1',
    project: '扣扣直聘',
    status: 'running',
    elapsed_sec: 60,
    unread: false,
    updated_at: '2026-08-18T10:03:00+08:00',
    ...over,
  };
}

describe('reduceLive：WS 消息归约', () => {
  it('snapshot 整份替换', () => {
    const next = reduceLive(emptyState(), {
      kind: 'snapshot',
      state: { ...emptyState(), sessions: [session()], stale: false },
    });

    expect(next.state.sessions).toHaveLength(1);
    expect(next.state.stale).toBe(false);
  });

  it('event 增量并进快照，不用等下一份 snapshot', () => {
    const base = { state: emptyState(), ringing: new Set<string>() };
    const next = reduceLive(base.state, {
      kind: 'event',
      event: { agent: 'claude', session_id: 'b1', type: 'waiting', reason: 'permission_prompt', title: '要改 schema' },
    });

    expect(next.state.sessions).toHaveLength(1);
    expect(next.state.sessions[0]).toMatchObject({ agent: 'claude', session_id: 'b1', status: 'waiting' });
  });

  it('同一会话的 event 覆盖而不是追加', () => {
    let state = reduceLive(emptyState(), {
      kind: 'event',
      event: { agent: 'dsh', session_id: 'x', type: 'waiting' },
    }).state;
    state = reduceLive(state, {
      kind: 'event',
      event: { agent: 'dsh', session_id: 'x', type: 'done', reason: 'stop' },
    }).state;

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].status).toBe('done');
  });

  it('ring 标记该会话响铃中（判定在工作台做，展示台只消费结果 — C2）', () => {
    const result = reduceLive(emptyState(), { kind: 'ring', agent: 'dsh', session_id: 'a7c1' });

    expect(result.ring).toEqual('dsh:a7c1');
  });

  it('★call/offhook 是停铃信号（有人接了）——绝不能被当成又一次响铃', () => {
    const result = reduceLive(emptyState(), {
      kind: 'call', phase: 'offhook', agent: 'dsh', session_id: 'a7c1',
    });

    expect(result.ring).toBeUndefined();
    expect(result.ringStop).toBe('dsh:a7c1');
  });

  it('call/missed 同样停铃（响铃超时没人接）', () => {
    const result = reduceLive(emptyState(), {
      kind: 'call', phase: 'missed', agent: 'claude', session_id: 'b1',
    });

    expect(result.ring).toBeUndefined();
    expect(result.ringStop).toBe('claude:b1');
  });

  it('call/onhook 与铃声无关（挂断时铃早停了）：不响也不停', () => {
    const result = reduceLive(emptyState(), {
      kind: 'call', phase: 'onhook', agent: 'dsh', session_id: 'a7c1',
    });

    expect(result.ring).toBeUndefined();
    expect(result.ringStop).toBeUndefined();
  });

  it('★认不得的消息类型一律不响铃——兜底必须是「默认忽略」而不是「默认响铃」', () => {
    // 这条是防同一个坑第四次复发。ping 补过一次例外、call 补过一次，
    // 悬停高亮 v1 的 hover 是第三次：它不在契约里，掉进兜底就成了
    // 一条 undefined:undefined 的假响铃——按钮和网页都停不掉，因为键对不上。
    const result = reduceLive(emptyState(), { kind: 'hover', inside: false });

    expect(result.ring).toBeUndefined();
    expect(result.ringStop).toBeUndefined();
  });

  it('★兜底改成忽略之后，认不得的消息也不能弄丢已有状态', () => {
    const base = reduceLive(emptyState(), {
      kind: 'event',
      event: { agent: 'dsh', session_id: 'x', type: 'waiting' },
    }).state;

    const result = reduceLive(base, { kind: '将来某个新类型' } as never);

    expect(result.state.sessions).toHaveLength(1);
  });
});

describe('humanDuration', () => {
  it('说人话', () => {
    expect(humanDuration(45)).toBe('45 秒');
    expect(humanDuration(252)).toBe('4 分 12 秒');
    expect(humanDuration(720)).toBe('12 分钟');
    expect(humanDuration(7800)).toBe('2 小时 10 分');
  });
});

describe('formatResetAt', () => {
  const now = new Date('2026-08-19T21:14:00+08:00');

  it('今天之内只报时刻', () => {
    expect(formatResetAt('2026-08-19T23:30:00+08:00', now)).toBe('今天 23:30');
  });

  it('明天的窗口说"明天"，这是最常见的一种', () => {
    expect(formatResetAt('2026-08-20T11:33:00+08:00', now)).toBe('明天 11:33');
  });

  it('更远的只给日期不给钟点——几天后的重置精确到分是噪音，还会把格子撑到折行（真机实锤）', () => {
    expect(formatResetAt('2026-08-24T00:00:00+08:00', now)).toBe('08-24');
  });

  it('认不出的时间返回 undefined，宁可不显示也不把 ISO 串糊在屏上', () => {
    expect(formatResetAt('不是时间', now)).toBeUndefined();
  });
});

