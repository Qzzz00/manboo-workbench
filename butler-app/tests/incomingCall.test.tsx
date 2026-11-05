/**
 * 座机来电在手机这一侧(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃,
 * 用户接起来处理事务」)。
 *
 * 三节:①状态机(响 / 接起 / 超时 / 静默那一条不响);②来电页画成什么样、按钮按下去发生什么;
 * ③接线(常驻房间、等工人那一声才真进通话、未接来电与回拨)。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WbchCallState, WbchRing } from '../src/channel/channelProtocol';
import { parseWbchInbound } from '../src/channel/channelProtocol';
import {
  IDLE,
  RING_REASON_TITLES,
  callTimeText,
  missedBannerText,
  missedCalls,
  missedGroupSummary,
  missedGroups,
  CALL_BACK_DONE_OFF_TEXT,
  parseCallLog,
  reduceIncoming,
  type IncomingState,
} from '../src/call/incomingModel';
import { ANSWER_LABEL, IncomingCallPage, LATER_LABEL, MUTE_LABEL } from '../src/call/IncomingCallPage';
import { CALL_BACK_LABEL, MISSED_CLEAR_LABEL, MISSED_MORE_LABEL, MissedCalls } from '../src/call/MissedCalls';
import {
  HANDSET_BANNER,
  HANDSET_BANNER_OTHER_PHONE,
  HANDSET_IN_CALL,
  HANDSET_IN_CALL_OTHER_PHONE,
  handsetItemText,
  handsetStatusText,
} from '../src/call/handsetCall';
import { RING_NO_ROOM_TEXT, useIncoming } from '../src/call/useIncoming';
import { SessionContext, type Session } from '../src/session';
import { createFakeLink, fakeChannel, fakeRouted } from './wbchFakes';
import type { ApiClient } from '../src/api/client';

function ring(patch: Partial<WbchRing> = {}): WbchRing {
  return {
    type: 'ring',
    call_id: 'c1',
    reason: 'confirm',
    item_id: 'task-1',
    title: '把首页文案改一版',
    at: '2026-09-21T06:00:00.000Z',
    silent: false,
    until: 60_000,
    ...patch,
  };
}

// ———————————————————————— ① 状态机 ————————————————————————

describe('来电状态机', () => {
  it('响 → 接起 → 挂断', () => {
    let state: IncomingState = IDLE;
    state = reduceIncoming(state, { type: 'ring', ring: ring() });
    expect(state).toMatchObject({ kind: 'ringing' });
    state = reduceIncoming(state, { type: 'answer' });
    expect(state).toMatchObject({ kind: 'answered' });
    state = reduceIncoming(state, { type: 'dismiss' });
    expect(state).toEqual(IDLE);
  });

  it('**夜间静默那一条不是来电**:不响、不弹来电页', () => {
    expect(reduceIncoming(IDLE, { type: 'ring', ring: ring({ silent: true }) })).toEqual(IDLE);
  });

  it('★ 按下接起(answering)后听到「接起来了」:是我这次接起 → answered;回话失败 → 退回待机', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const answering = reduceIncoming(ringing, { type: 'answering' });
    expect(answering).toMatchObject({ kind: 'ringing', answering: true });
    const viaEnd = reduceIncoming(answering, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone' } });
    expect(viaEnd).toMatchObject({ kind: 'answered' });
    // 回话随后到:原样返回,不重画。
    expect(reduceIncoming(viaEnd, { type: 'answer' })).toBe(viaEnd);
    // call_state 先到的那种顺序也一样。
    const viaState = reduceIncoming(answering, { type: 'call_state', state: { type: 'call_state', state: 'in_call', by: 'phone', call_id: 'c1', started_at: 1 } });
    expect(viaState).toMatchObject({ kind: 'answered' });
    expect(reduceIncoming(viaEnd, { type: 'answer_failed' })).toEqual(IDLE);
    expect(reduceIncoming(answering, { type: 'answer_failed' })).toEqual(IDLE);
  });

  it('★ answering 期间工人明说是话筒接的(by:handset,无 identity):仍进字幕页 —— 哪端接起只走哪端', () => {
    const answering = reduceIncoming(reduceIncoming(IDLE, { type: 'ring', ring: ring() }), { type: 'answering' });
    const next = reduceIncoming(answering, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' } });
    expect(next).toMatchObject({ kind: 'handset', by: 'handset' });
  });

  it('★ by_identity 优先于乐观标记:是我就进通话、不是我就字幕页', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const mine = reduceIncoming(ringing, { type: 'ring_end', self: 'me', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone', by_identity: 'me' } });
    expect(mine).toMatchObject({ kind: 'answered' });
    const answering = reduceIncoming(ringing, { type: 'answering' });
    const other = reduceIncoming(answering, { type: 'ring_end', self: 'me', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone', by_identity: 'you' } });
    expect(other).toMatchObject({ kind: 'handset', by: 'phone' });
    // 别人接走之后我的回话失败:那一面留着。
    expect(reduceIncoming(other, { type: 'answer_failed' })).toBe(other);
  });

  it('★ answering 期间铃的倒计时不收它(收不收由回话定)', () => {
    const answering = reduceIncoming(reduceIncoming(IDLE, { type: 'ring', ring: ring() }), { type: 'answering' });
    expect(reduceIncoming(answering, { type: 'timeout', now: 9_999_999 })).toBe(answering);
  });

  it('响着的时候又来一通,后来的不顶掉屏幕上这一通', () => {
    const first = reduceIncoming(IDLE, { type: 'ring', ring: ring({ call_id: 'a' }) });
    const again = reduceIncoming(first, { type: 'ring', ring: ring({ call_id: 'b' }) });
    expect(again).toBe(first);
  });

  it('工人说这一通完了就收掉;**已接的电话不会被「他接起来了」那条回声挂掉**', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    expect(reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'missed' } })).toEqual(IDLE);
    const answered = reduceIncoming(ringing, { type: 'answer' });
    const echo = reduceIncoming(answered, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered' } });
    expect(echo).toBe(answered);
  });

  /**
   * 2026-09-22 座机界面:**还在响的时候听见「接起来了」= 房里另一台设备接的**
   * (座机形态下那是树莓派上那只话筒)。这时手机不该把屏幕收掉 —— 它要改成字幕 + 挂断。
   */
  it('响着的时候收到「接起来了」→ 话筒接的,手机进 handset 态(不是收掉)', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const handset = reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered' } });
    expect(handset).toMatchObject({ kind: 'handset', call: { call_id: 'c1' } });
    // 铃响够了不收它(接起来的电话不会因为倒计时被挂断),按挂断才收。
    expect(reduceIncoming(handset, { type: 'timeout', now: 9_999_999 })).toBe(handset);
    expect(reduceIncoming(handset, { type: 'dismiss' })).toEqual(IDLE);
  });

  /**
   * 2026-09-22(待拍板 E1,按统筹建议做):**话筒挂机时工人广播一条
   * `ring_end{outcome:'hung_up'}`**,手机据此自己收掉「字幕 + 挂断」那一面 ——
   * 座机的整个意思就是手不用碰手机。
   */
  it('★收到 hung_up:handset 那一面自己收掉,回待机', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const handset = reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered' } });
    expect(handset).toMatchObject({ kind: 'handset' });
    expect(reduceIncoming(handset, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'hung_up' } })).toEqual(IDLE);
  });

  it('★hung_up 也结束手机自己那一通(本地通话态跟着一起结束)', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const answered = reduceIncoming(ringing, { type: 'answer' });
    expect(reduceIncoming(answered, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'hung_up' } })).toEqual(IDLE);
  });

  it('★别的通的 hung_up 收不掉这一通', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const handset = reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered' } });
    expect(reduceIncoming(handset, { type: 'ring_end', end: { type: 'ring_end', call_id: '别的', outcome: 'hung_up' } })).toBe(handset);
  });

  it('别的通的 ring_end 不许把这一通收掉', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    expect(reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: '别的', outcome: 'missed' } })).toBe(ringing);
  });

  it('手机自己那根倒计时到点收掉;**已接的电话不会因为铃响够了被挂掉**', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring({ until: 1000 }) });
    expect(reduceIncoming(ringing, { type: 'timeout', now: 999 })).toBe(ringing);
    expect(reduceIncoming(ringing, { type: 'timeout', now: 1000 })).toEqual(IDLE);
    const answered = reduceIncoming(ringing, { type: 'answer' });
    expect(reduceIncoming(answered, { type: 'timeout', now: 9_999_999 })).toBe(answered);
  });
});

describe('协议:ring / ring_end', () => {
  it('读得懂的照单收下', () => {
    expect(parseWbchInbound(JSON.stringify(ring()))).toMatchObject({ type: 'ring', call_id: 'c1', reason: 'confirm' });
    expect(parseWbchInbound(JSON.stringify({ type: 'ring_end', call_id: 'c1', outcome: 'missed' })))
      .toMatchObject({ type: 'ring_end', outcome: 'missed' });
    // 2026-09-22 多的那第四个(话筒挂机)。带的那句人话原样留着,界面上直接显示。
    expect(parseWbchInbound(JSON.stringify({ type: 'ring_end', call_id: 'c1', outcome: 'hung_up', text: '听筒放回去了,这一通结束了' })))
      .toMatchObject({ type: 'ring_end', outcome: 'hung_up', text: '听筒放回去了,这一通结束了' });
  });

  it('缺 call_id / 理由不认识都当没收到,**绝不抛**(它从网上来)', () => {
    expect(parseWbchInbound(JSON.stringify({ type: 'ring', reason: 'confirm', title: '甲' }))).toBeNull();
    expect(parseWbchInbound(JSON.stringify(ring({ reason: '随便' as never })))).toBeNull();
    expect(parseWbchInbound(JSON.stringify({ type: 'ring_end', call_id: 'c', outcome: '随便' }))).toBeNull();
  });
});

describe('未接来电那一本', () => {
  const body = {
    missed: 3,
    entries: [
      { id: 'a', reason: 'confirm', item_id: 't1', title: '甲', at: '2026-09-21T06:03:00.000Z', state: 'missed' },
      { id: 'b', reason: 'done', item_id: 't2', title: '乙', at: '2026-09-21T05:00:00.000Z', state: 'answered' },
      { id: 'c', reason: 'failed', item_id: 't3', title: '丙', at: '坏的', state: 'missed' },
    ],
  };

  it('只列未接的;**数字用服务端那个**(手机只拿到最近几十条)', () => {
    const log = parseCallLog(body);
    expect(missedCalls(log).map(one => one.id)).toEqual(['a', 'c']);
    expect(missedBannerText(log)).toBe('未接来电 3');
  });

  it('一条都没有时不显示「未接来电 0」', () => {
    expect(missedBannerText({ entries: [], missed: 0, doneCall: false })).toBeNull();
  });

  it('时刻读不出来就空字符串,不编一个「刚刚」', () => {
    expect(callTimeText('坏的')).toBe('');
    expect(callTimeText('2026-09-21T06:03:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  /* ——— 2026-09-22:收过的不再列、同一件事折叠成一行 ——— */

  it('★收过的那几条(带 `dismissed_at`)不再进未接列表 —— 清空之后面板就空了', () => {
    const log = parseCallLog({
      missed: 0,
      entries: [
        { id: 'a', reason: 'confirm', item_id: 't1', title: '甲', at: '2026-09-21T06:03:00.000Z', state: 'missed', dismissed_at: '2026-09-22T10:00:00.000Z' },
        { id: 'c', reason: 'failed', item_id: 't3', title: '丙', at: '2026-09-21T07:00:00.000Z', state: 'missed' },
      ],
    });
    // 台账里**两条都在**(服务端一条没删),但列出来的只有没收过的那一条。
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0]!.dismissed_at).toBe('2026-09-22T10:00:00.000Z');
    expect(missedCalls(log).map(one => one.id)).toEqual(['c']);
  });

  it('★同一件事的多次未接折叠成一组:计数 + 最近那一通', () => {
    const at = ['2026-09-22T09:06:00.000Z', '2026-09-22T07:37:05.000Z', '2026-09-21T10:30:00.000Z'];
    const log = parseCallLog({
      missed: 4,
      entries: [
        // `/call/log` 本来就是最近的在前。
        { id: 'd1', reason: 'done', item_id: 'routine:evening', title: '下班例程', at: at[0], state: 'missed' },
        { id: 'd2', reason: 'done', item_id: 'routine:evening', title: '下班例程', at: at[1], state: 'missed' },
        { id: 'd3', reason: 'done', item_id: 'routine:evening', title: '下班例程', at: at[2], state: 'missed' },
        { id: 'a', reason: 'confirm', item_id: 't1', title: '甲', at: at[1], state: 'missed' },
      ],
    });
    const groups = missedGroups(log);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 3, title: '下班例程', reason: 'done' });
    expect(groups[0]!.latest.id).toBe('d1');
    expect(groups[0]!.entries.map(one => one.id)).toEqual(['d1', 'd2', 'd3']);
    // 同一件事、**不同理由**是两回事(先失败后完成),这里那一组是另一件事。
    expect(groups[1]).toMatchObject({ count: 1, title: '甲' });
    expect(missedGroupSummary(groups[0]!)).toBe('未接 3 次 · 最近 ' + callTimeText(at[0]!));
    // 只有一通的那组不说「未接 1 次」,就是一个时刻。
    expect(missedGroupSummary(groups[1]!)).toBe(callTimeText(at[1]!));
  });

  it('回包整个读不懂也不抛', () => {
    // `doneCall` 读不到就是 false —— **保守**:宁可不给「回拨」,也不给一颗必被拒的键。
    expect(parseCallLog(null)).toEqual({ entries: [], missed: 0, doneCall: false });
    expect(parseCallLog({ entries: [{ 随便: 1 }] })).toEqual({ entries: [], missed: 0, doneCall: false });
  });
});

// ———————————————————————— ② 来电页 ————————————————————————

describe('来电页', () => {
  const call = { call_id: 'c1', reason: 'confirm' as const, item_id: 't1', title: '把首页文案改一版', at: '2026-09-21T06:00:00.000Z', until: Date.now() + 60_000 };

  it('先写为什么、再写哪件事;三颗键都在', () => {
    render(<IncomingCallPage call={call} onAnswer={() => {}} onLater={() => {}} />);
    expect(screen.getByText(RING_REASON_TITLES.confirm)).toBeTruthy();
    expect(screen.getByText('把首页文案改一版')).toBeTruthy();
    expect(screen.getByRole('button', { name: ANSWER_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: LATER_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: MUTE_LABEL })).toBeTruthy();
  });

  it('接起 / 稍后各自回调一次', () => {
    const onAnswer = vi.fn();
    const onLater = vi.fn();
    render(<IncomingCallPage call={call} onAnswer={onAnswer} onLater={onLater} />);
    fireEvent.click(screen.getByRole('button', { name: ANSWER_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: LATER_LABEL }));
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onLater).toHaveBeenCalledOnce();
  });

  it('**「静音」不改这通电话的状态** —— 他把铃按掉去开个会,电话还在,还接得起来', () => {
    const onAnswer = vi.fn();
    render(<IncomingCallPage call={call} onAnswer={onAnswer} onLater={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: MUTE_LABEL }));
    expect(screen.getByRole('button', { name: '已静音' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ANSWER_LABEL }));
    expect(onAnswer).toHaveBeenCalledOnce();
  });

  it('并进来的那几件只报一个数', () => {
    render(<IncomingCallPage call={{ ...call, reason: 'done', merged: [{ item_id: 'x', title: '甲' }] }} onAnswer={() => {}} onLater={() => {}} />);
    expect(screen.getByText('另外还有 1 件也完成了')).toBeTruthy();
  });
});

describe('未接来电那张卡', () => {
  const log = parseCallLog({
    missed: 2,
    entries: [{ id: 'a', reason: 'confirm', item_id: 't1', title: '甲', at: '2026-09-21T06:03:00.000Z', state: 'missed' }],
  });

  /** 一本台账:一行「完成」的未接 + 一行「等你确认」的未接,`done_call` 由调用方给。 */
  function logWith(doneCall: boolean, extra: readonly Record<string, unknown>[] = []) {
    return parseCallLog({
      missed: 2,
      config: { enabled: true, quiet_from: '23:00', quiet_to: '08:00', done_call: doneCall },
      entries: [
        { id: 'd', reason: 'done', item_id: 't9', title: '下班例程', at: '2026-09-22T07:32:00.000Z', state: 'missed' },
        { id: 'a', reason: 'confirm', item_id: 't1', title: '甲', at: '2026-09-21T06:03:00.000Z', state: 'missed' },
        ...extra,
      ],
    });
  }
  const rowOf = (id: string) => screen.getByText(id === 'd' ? '下班例程' : '甲').closest('.ba-missed__row')!;

  it('点回拨 = 让工作台再排一通;没排上就把原话摆在**那一行**上', async () => {
    const onCallBack = vi.fn(async () => ({ ok: false as const, error: '主动来电未启用' }));
    render(<MissedCalls log={log} onCallBack={onCallBack} onClear={async () => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('button', { name: CALL_BACK_LABEL }));
    await waitFor(() => expect(screen.getByText('主动来电未启用')).toBeTruthy());
    expect(onCallBack).toHaveBeenCalledOnce();
    // 「摆在那一行上」= 在那个 <li> 里面,不是整张卡末尾一句。
    expect(screen.getByText('甲').closest('.ba-missed__row')!.textContent).toContain('主动来电未启用');
  });

  /* ——— 2026-09-22:「完成」那几行的回拨键 ——— */

  it('★`done_call` 关着:「完成」那一行**没有回拨键**,改一行小字;别的理由照旧有键', () => {
    render(<MissedCalls log={logWith(false)} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(rowOf('d').querySelector('button')).toBeNull();
    expect(rowOf('d').textContent).toContain(CALL_BACK_DONE_OFF_TEXT);
    expect(rowOf('a').querySelector('button')).toBeTruthy();
  });

  it('★`done_call` 开着:「完成」那一行照旧回拨得了', () => {
    const onCallBack = vi.fn(async () => ({ ok: true as const }));
    render(<MissedCalls log={logWith(true)} onCallBack={onCallBack} onClear={async () => ({ ok: true })} />);
    const key = rowOf('d').querySelector('button')!;
    expect(key.textContent).toBe(CALL_BACK_LABEL);
    expect(rowOf('d').textContent).not.toContain(CALL_BACK_DONE_OFF_TEXT);
    fireEvent.click(key);
    expect(onCallBack).toHaveBeenCalledOnce();
  });

  it('★同一件事还有一通没收场:那颗键点不动(服务端同一条判据),收场了就亮回来', () => {
    // 同一件事(`t1` + `confirm`)的上一通,**标题另写一个**:收场之后它自己也会进未接列表,
    // 两行都叫「甲」的话用例自己都找不着北了。
    const live = [{ id: 'q', reason: 'confirm', item_id: 't1', title: '甲的上一通', at: '2026-09-22T07:40:00.000Z', state: 'ringing' }];
    const { unmount } = render(<MissedCalls log={logWith(true, live)} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect((rowOf('a').querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    // 「完成」那一件没有未收场的,它那颗照旧点得动 —— 挡的是这一件,不是整张卡。
    expect((rowOf('d').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    unmount();
    const settled = [{ ...live[0], state: 'missed' }];
    render(<MissedCalls log={logWith(true, settled)} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect((rowOf('a').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });

  /* ——— 2026-09-22:清空 + 折叠(Ben 真机:九条「完成 · 下班例程」堆着没法收) ——— */

  it('★顶上一颗「清空」:按下去**当场收起**,并且把那一下发给服务端', async () => {
    const onClear = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(<MissedCalls log={log} onCallBack={async () => ({ ok: true })} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: MISSED_CLEAR_LABEL }));
    expect(onClear).toHaveBeenCalledOnce();
    // 「当场」= 不等服务端那一趟回来。
    expect(container.querySelector('.ba-missed')).toBeNull();
  });

  it('★收起之后**又来一条新的未接**,这张卡自己回来(不是一按永久关掉)', () => {
    const onClear = async () => ({ ok: true as const });
    const { container, rerender } = render(<MissedCalls log={log} onCallBack={async () => ({ ok: true })} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: MISSED_CLEAR_LABEL }));
    expect(container.querySelector('.ba-missed')).toBeNull();
    const next = parseCallLog({
      missed: 1,
      entries: [{ id: '新的', reason: 'failed', item_id: 't7', title: '例程跑挂了', at: '2026-09-22T09:00:00.000Z', state: 'missed' }],
    });
    rerender(<MissedCalls log={next} onCallBack={async () => ({ ok: true })} onClear={onClear} />);
    expect(screen.getByText('例程跑挂了')).toBeTruthy();
  });

  it('★同一件事的 7 通未接只占一行,展开才看明细;回拨按**最近那一通**算', () => {
    const onCallBack = vi.fn(async () => ({ ok: true as const }));
    const times = ['2026-09-22T09:06:00.000Z', '2026-09-22T07:37:10.000Z', '2026-09-22T07:32:27.000Z'];
    const folded = parseCallLog({
      missed: 3,
      config: { done_call: true },
      entries: times.map((at, index) => ({
        id: `d${index}`, reason: 'done', item_id: 'routine:evening:2026-09-20', title: '下班例程', at, state: 'missed',
      })),
    });
    render(<MissedCalls log={folded} onCallBack={onCallBack} onClear={async () => ({ ok: true })} />);
    // 一行,不是三行。
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(1);
    expect(screen.getByText('未接 3 次 · 最近 ' + callTimeText(times[0]!))).toBeTruthy();
    // 明细要点开才有。
    expect(document.querySelector('.ba-missed__detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: MISSED_MORE_LABEL }));
    expect(document.querySelectorAll('.ba-missed__detail li')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: CALL_BACK_LABEL }));
    expect(onCallBack).toHaveBeenCalledWith(expect.objectContaining({ id: 'd0' }));
  });

  it('一条未接都没有就整张卡不出', () => {
    const { container } = render(<MissedCalls log={{ entries: [], missed: 0, doneCall: false }} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(container.querySelector('.ba-missed')).toBeNull();
  });
});

// ———————————————————————— ③ 接线 ————————————————————————

/*
 * ——— 话筒接起的那一通,屏上写什么(2026-09-22;2026-09-22 晚多了「是谁接的」) ———
 *
 * **那一屏本身 2026-09-28 并进了同一张通话页**(舞台页的通话态,粒子球 + 球下字幕 + 同一组键):
 * 维护者原话「座机拿起来的通话页面和我正常从首页打出去的那套 UI 不一样,因为座机……根本没有粒子球」。
 * 渲染出来长什么样由 `tests/handsetCallPage.test.tsx` 钉;这里只剩那几句话的口径(纯函数)。
 */
describe('话筒接起的那一通:屏上那几句话', () => {
  it('★ 话筒接的:说「对着话筒说就行」;顶上那行是「话筒通话中」', () => {
    expect(HANDSET_BANNER).toContain('话筒');
    expect(handsetStatusText('handset')).toBe(HANDSET_IN_CALL);
  });

  it('★ 房里另一台设备接的:两行都改口,不说「话筒」', () => {
    expect(HANDSET_BANNER_OTHER_PHONE).not.toContain('话筒');
    expect(handsetStatusText('phone')).toBe(HANDSET_IN_CALL_OTHER_PHONE);
  });

  it('老工人不带 by:照旧按话筒说(座机形态下那就是事实)', () => {
    expect(handsetStatusText(undefined)).toBe(HANDSET_IN_CALL);
  });
});

describe('接线(useIncoming)', () => {
  function harness(overrides: {
    channel?: Parameters<typeof fakeChannel>[0],
    json?: ApiClient['json'],
    /** 看门狗多久看一眼(2026-09-22 晚)。用例调快。 */
    holdCheckMs?: number,
    /** 手机自己那根倒计时的节拍与「现在几点」(2026-09-23:量「重复 ring 不重置计时」)。 */
    tickMs?: number,
    now?: () => number,
  } = {}) {
    const listeners: ((message: unknown) => void)[] = [];
    const answerCall = vi.fn(async () => ({ ok: true as const }));
    const laterCall = vi.fn(async () => ({ ok: true as const }));
    const link = createFakeLink();
    const holdForRing = vi.fn(async () => { link.setState('connected'); return { ok: true as const }; });
    const channel = fakeChannel({
      link,
      onRing: (listener) => { listeners.push(listener as (message: unknown) => void); return () => {}; },
      answerCall,
      laterCall,
      holdForRing,
      releaseRing: async () => {},
      ...overrides.channel,
    });
    const stops: number[] = [];
    const json = overrides.json ?? (async () => ({ ok: true as const, status: 200, data: { entries: [], missed: 0 } }));
    const client = fakeRouted({ baseUrl: 'http://x', json, blob: async () => ({ ok: false, status: 0, kind: 'network', error: '' }) } as ApiClient);
    const session = { channel, client } as unknown as Session;
    const ringCalls: unknown[] = [];
    /** 本地那段合成音被从头放了几次(2026-09-23:重复 ring 不许重放铃声开头)。 */
    const tonePlays: number[] = [];
    let handle: ReturnType<typeof useIncoming> | undefined;
    function Probe() {
      handle = useIncoming(session, {
        ...(overrides.holdCheckMs === undefined ? {} : { holdCheckMs: overrides.holdCheckMs }),
        ...(overrides.tickMs === undefined ? {} : { tickMs: overrides.tickMs }),
        ...(overrides.now === undefined ? {} : { now: overrides.now }),
        makeRingtone: () => ({ start: async () => { tonePlays.push(1); return { ok: true }; }, stop: () => {}, dispose: () => {} }),
        ring: async (input) => { ringCalls.push(input); return { ok: true, fullScreen: true }; },
        stopRing: async () => { stops.push(1); },
      });
      return null;
    }
    render(<SessionContext.Provider value={session}><Probe /></SessionContext.Provider>);
    return {
      push: (message: unknown) => act(() => { for (const l of listeners) l(message); }),
      get handle() { return handle!; },
      answerCall, laterCall, holdForRing, ringCalls, stops, tonePlays,
      // **那一份假的**(不是 channel.link —— 它的类型是 WbchRoomLink,看不见 micLog 这几格)。
      link,
    };
  }

  /**
   * ★ 2026-09-22 晚改的那一条(Ben:「要用户自己打开座机模式这个交互也不对」)。
   * 以前这里传的是 `deskPhone: true`,也就是「座机模式开着才常驻房间」——
   * 那正是他那台手机在 20:50 之前一通电话都收不到的原因。现在**一个开关都不传**。
   */
  it('★ 座机模式关着也常驻房间(不传任何开关)—— 不在房里永远收不到那条 ring', async () => {
    const h = harness();
    await waitFor(() => expect(h.holdForRing).toHaveBeenCalled());
  });

  /**
   * ★ 看门狗(2026-09-22 晚)。`holdForRing()` 只在挂载那一下调一次,而这条连接会掉 ——
   * 切 Wi-Fi、手机睡过去、服务器重启、凭证过期。掉了之后房里没有这台手机,
   * 工人那根领活的节拍看见「房里没有手机」压根不领,**于是电话一整天都不会响,
   * 而屏幕上什么都不说**。
   */
  it('★ 房间掉了:看门狗自己再拿一次(不然电话一整天都不会响,而屏上什么都不说)', async () => {
    const h = harness({ holdCheckMs: 5 });
    await waitFor(() => expect(h.holdForRing).toHaveBeenCalledTimes(1));
    // 已经在房里的那几拍不白跑一趟。
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.holdForRing).toHaveBeenCalledTimes(1);
    // 掉了。
    act(() => { h.link.setState('closed'); });
    await waitFor(() => expect(h.holdForRing).toHaveBeenCalledTimes(2));
  });

  it('★ 进不去房间:把服务端那句**原话**摆到屏幕上 —— 收不到电话这件事不许是哑的', async () => {
    const h = harness({
      holdCheckMs: 5,
      channel: { holdForRing: async () => ({ ok: false as const, error: '房间凭证已过期' }) },
    });
    await waitFor(() => expect(h.handle.note).toContain('房间凭证已过期'));
    expect(h.handle.note).toContain(RING_NO_ROOM_TEXT);
  });

  it('收到 ring → 响铃 + 来电态;接起要**等工人那一声**才真的进通话', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    expect(h.ringCalls).toHaveLength(1);
    await act(async () => { await h.handle.answer(); });
    expect(h.answerCall).toHaveBeenCalledWith('c1');
    expect(h.handle.state.kind).toBe('answered');
  });

  it('**工人说「正在响的不是这一通」就收掉**,不把他送进一通谁也不开口的电话', async () => {
    const h = harness({ channel: { answerCall: async () => ({ ok: false, error: '正在响的不是这一通' }) } });
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    await act(async () => { await h.handle.answer(); });
    expect(h.handle.state.kind).toBe('idle');
    expect(h.handle.note).toContain('正在响的不是这一通');
  });

  it('话筒接起之后按「挂断」:当场收掉并告诉工人(说不出去也照收)', async () => {
    const hangupCall = vi.fn(async () => ({ ok: true as const }));
    const h = harness({ channel: { hangupCall } });
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    await act(async () => { await h.handle.hangup(); });
    expect(hangupCall).toHaveBeenCalledOnce();
    expect(h.handle.state.kind).toBe('idle');
  });

  /**
   * 2026-09-22(待拍板 E1):这一条是这张卡的正主 —— **他把听筒放回去,手机上那一面自己没了**,
   * 而且**手机一个字都不用往回说**(挂的不是它)。
   */
  it('★话筒挂机:收到 hung_up 就收掉那一面,且不再往工人那边发挂断', async () => {
    const hangupCall = vi.fn(async () => ({ ok: true as const }));
    const h = harness({ channel: { hangupCall } });
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'hung_up', text: '听筒放回去了,这一通结束了' });
    await waitFor(() => expect(h.handle.state.kind).toBe('idle'));
    expect(hangupCall).not.toHaveBeenCalled();
  });

  /*
   * ——— 谁接谁说话(2026-09-22 晚,Ben 20:50 真机那一条) ———
   *
   * 真机现象:座机模式手动打开之后,手机响铃 ✓、提机接听 ✓,
   * **但事务官的声音从手机里出来,不从话筒出来**。
   * Ben 要的是:话筒接起后对话走话筒,手机只负责响铃与显示。
   */
  it('★ 话筒接起(ring_end 带 by:handset):手机停铃、进话筒态,而且**一路麦克风、一声喇叭都没有**', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    expect(h.ringCalls).toHaveLength(1);
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    // 工人明说了是谁接的,界面据此写那一行字(不再靠推断)。
    expect(h.handle.state).toMatchObject({ kind: 'handset', by: 'handset' });
    // **停铃**:他已经拿起听筒了,手机还在响是最难受的。
    expect(h.stops.length).toBeGreaterThan(0);
    // **不出声、不收音**:这一通归话筒。手机这一侧一次都没碰过这两样。
    expect(h.link.micLog).toEqual([]);
    expect(h.link.speakerLog).toEqual([]);
  });

  it('★ 老工人不带 by:照旧按话筒认(0921 那条推断留着当兜底)', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    expect((h.handle.state as { by?: string }).by).toBeUndefined();
  });

  /*
   * ——— 手机自己接起:广播先于回话到(2026-09-23 晚,维护者真机「接起来没声、不收音」) ———
   *
   * 工人 `answer()` 先广播 ring_end{answered}/call_state、后回 RPC;同一条通道按序读,
   * 广播**先到**。以前那条广播被当成「别人接的」→ 字幕页,喇叭麦克风一次都没开。
   */
  function answerThatBroadcastsFirst(h: { push: (m: unknown) => void }, extra: Record<string, unknown> = {}) {
    return vi.fn(async (callId: string) => {
      h.push({ type: 'ring_end', call_id: callId, outcome: 'answered', by: 'phone', ...extra });
      h.push({ type: 'call_state', state: 'in_call', by: 'phone', call_id: callId, started_at: 5, ...extra });
      return { ok: true as const };
    });
  }

  it('★★ 自己按接起、广播先于回话到(老工人不带 by_identity):进自己的通话,不进字幕页', async () => {
    const box: { h?: ReturnType<typeof harness> } = {};
    const answerCall = vi.fn(async (callId: string) => answerThatBroadcastsFirst(box.h!)(callId));
    const h = harness({ channel: { answerCall } });
    box.h = h;
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    await act(async () => { await h.handle.answer(); });
    expect(h.handle.state.kind).toBe('answered');
  });

  it('★★ 新工人带 by_identity = 我:进自己的通话', async () => {
    const box: { h?: ReturnType<typeof harness> } = {};
    const answerCall = vi.fn(async (callId: string) => answerThatBroadcastsFirst(box.h!, { by_identity: 'wb-phone-dev1' })(callId));
    const h = harness({ channel: { answerCall } });
    box.h = h;
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    await act(async () => { await h.handle.answer(); });
    expect(h.handle.state.kind).toBe('answered');
  });

  it('★★ 我没按,新工人说是另一台手机(by_identity ≠ 我)接的:字幕页', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone', by_identity: 'wb-phone-other' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    expect(h.link.micLog).toEqual([]);
  });

  it('★★ 我按了接起、但工人说接的是别人(by_identity ≠ 我):字幕页;随后回话失败不把那一面收掉', async () => {
    let release: (v: { ok: false, error: string }) => void = () => {};
    const answerCall = vi.fn(() => new Promise<{ ok: false, error: string }>((resolve) => { release = resolve; }));
    const h = harness({ channel: { answerCall } });
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = h.handle.answer(); });
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone', by_identity: 'wb-phone-other' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    await act(async () => { release({ ok: false, error: '这会儿没有电话在响' }); await pending; });
    expect(h.handle.state.kind).toBe('handset');
  });

  it('★★ 等回话的那几百毫秒里:铃的倒计时不收它、连点不重发', async () => {
    let release: (v: { ok: true }) => void = () => {};
    const answerCall = vi.fn(() => new Promise<{ ok: true }>((resolve) => { release = resolve; }));
    const h = harness({ channel: { answerCall }, tickMs: 5, now: () => 9_999_999 });
    h.push(ring({ until: 9_999_999 }));
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = h.handle.answer(); });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.handle.state.kind).toBe('ringing');
    await act(async () => { await h.handle.answer(); });
    expect(answerCall).toHaveBeenCalledOnce();
    await act(async () => { release({ ok: true }); await pending; });
    expect(h.handle.state.kind).toBe('answered');
  });

  it('★ 房里另一台手机接的(by:phone,这台**没按**接起):这台一样只看不出声,只是屏上那句话不一样', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone' });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    expect(h.handle.state).toMatchObject({ by: 'phone' });
    expect(h.link.micLog).toEqual([]);
  });

  /**
   * ——— 提机拨出那一通(2026-09-23,「打进打出同一张页」) ———
   *
   * 待机提机走的是 `call/start`,房里没有任何 `ring`。工人从这一版起广播一条
   * `call_state{state:'in_call',by:'handset'}`,手机据此进**同一张**通话页。
   */
  it('★ 话筒拨出:手机进同一张通话页,**一路麦克风、一声喇叭都没有**', async () => {
    const h = harness();
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1_700_000_000_000 });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    expect(h.handle.state).toMatchObject({ by: 'handset', since: 1_700_000_000_000 });
    // 拨出这一通没有铃:铃声一次都没起过(同权卡与 B 节那条规矩一个字没变)。
    expect(h.ringCalls).toEqual([]);
    expect(h.link.micLog).toEqual([]);
    expect(h.link.speakerLog).toEqual([]);
  });

  it('★ 话筒放回叉簧(idle)→ 手机自己回舞台,他的手不用碰手机', async () => {
    const h = harness();
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1 });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    h.push({ type: 'call_state', state: 'idle', by: 'handset', started_at: 1 });
    await waitFor(() => expect(h.handle.state.kind).toBe('idle'));
  });

  it('★ 手机上按挂断 = 发 `call/hangup`,两边一致', async () => {
    const hangupCall = vi.fn(async () => ({ ok: true as const }));
    const h = harness({ channel: { hangupCall } });
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1 });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    await act(async () => { await h.handle.hangup(); });
    expect(hangupCall).toHaveBeenCalledOnce();
    expect(h.handle.state.kind).toBe('idle');
  });

  it('★ 重复的 in_call 不闪:状态对象一个字没换', async () => {
    const h = harness();
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1 });
    await waitFor(() => expect(h.handle.state.kind).toBe('handset'));
    const before = h.handle.state;
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1 });
    h.push({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 2 });
    expect(h.handle.state).toBe(before);
  });

  /**
   * **同一通只响一次**(2026-09-22 晚)。这一版收铃只有房间那一条路,
   * 但同一条 `ring` 是**广播**,而且掉线重连、工人重启都可能把它再送一遍。
   * 去重不是靠一张 call_id 表,是靠状态机那条结构性的规矩:**不在待机就不开新的来电**。
   */
  it('★ 同一通 ring 连来三遍,只响一次', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    h.push(ring());
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    expect(h.ringCalls).toHaveLength(1);
  });

  /**
   * ——— 同一 call_id 的重复 `ring` 要**幂等**(2026-09-23) ———
   *
   * 从这一版起工人会**点名补发**正响着的那条 ring 给晚进房的设备
   * (channel-worker 的 `resendRingTo`;真机 10:27 手机比铃晚几秒回房,一声没响却记了未接)。
   * 于是「同一条 ring 收两遍」从一种意外变成了一条**正常路径** —— 它必须什么都不改:
   *
   *   · 不重放铃声开头(他听到的应该是一段连续的铃,不是每隔几秒从头「叮」一下);
   *   · 不重置那根倒计时(重置等于把这一通悄悄延长,手机还在响而工人已经记了未接)。
   */
  it('★ 补发来的那条 ring(同一 call_id)不重放铃声开头', async () => {
    const h = harness();
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    await waitFor(() => expect(h.tonePlays).toHaveLength(1));
    const before = h.handle.state;
    h.push(ring());
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    // 状态**原样返回**(同一个对象)—— React 连重画都不会做一次。
    expect(h.handle.state).toBe(before);
    expect(h.tonePlays).toHaveLength(1);
    expect(h.ringCalls).toHaveLength(1);
  });

  /**
   * 工人**保证**补发的是同一个 `until`(它逐字重发当初那一行)。这一条钉的是**手机自己**
   * 那一侧的兜底:哪怕来的那条 ring 把 `until` 往后挪了(老工人、别的实现、乱序),
   * 屏上这一通也按**第一条**那个时刻收掉 —— 一通电话响多久不该被一条补发偷偷延长,
   * 否则就会出现「手机还在响,而工人那边早记了未接」。
   */
  it('★ 补发来的那条 ring 不重置计时:到点照旧按**第一条那个 until** 收掉', async () => {
    let clock = 0;
    const h = harness({ tickMs: 5, now: () => clock });
    h.push(ring({ until: 1_000 }));
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    // 差一点到点时补发一条,而且这一条的 until 比第一条晚了一整分钟。
    clock = 999;
    h.push(ring({ until: 61_000 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.handle.state.kind).toBe('ringing');
    expect(h.handle.state).toMatchObject({ call: { until: 1_000 } });
    // 到点 —— 计时没有因为那条补发被往后推。
    clock = 1_000;
    await waitFor(() => expect(h.handle.state.kind).toBe('idle'));
  });

  it('「稍后」当场收掉并告诉工人;**说不出去也照收**', async () => {
    const h = harness({ channel: { laterCall: async () => { throw new Error('房间断了'); } } });
    h.push(ring());
    await waitFor(() => expect(h.handle.state.kind).toBe('ringing'));
    await act(async () => { await h.handle.later(); });
    expect(h.handle.state.kind).toBe('idle');
  });

  it('**夜间静默那一条只发通知**:不进状态机、不响铃', async () => {
    const h = harness();
    h.push(ring({ call_id: 'night', silent: true }));
    await waitFor(() => expect(h.ringCalls).toHaveLength(1));
    expect((h.ringCalls[0] as { silent: boolean }).silent).toBe(true);
    expect(h.handle.state.kind).toBe('idle');
  });

  it('回拨 = POST /call/out,不是手机自己拨一通普通电话', async () => {
    const json = vi.fn(async () => ({ ok: true as const, status: 200, data: { entries: [], missed: 0, ok: true } }));
    const h = harness({ json: json as unknown as ApiClient['json'] });
    await act(async () => { await h.handle.callBack({ reason: 'confirm', item_id: 't1', title: '甲' }); });
    expect(json).toHaveBeenCalledWith('/call/out', expect.objectContaining({ method: 'POST' }));
  });

  /* ——— 2026-09-22:回拨被拒 ——— */

  it('★被拒时**把服务端那句原话返回给调用方**(不是只塞进 note),并把台账再拉一遍', async () => {
    const json = vi.fn(async (path: string) => (path === '/call/out'
      ? { ok: true as const, status: 200, data: { ok: false, error: '这一件正在响,没有再排一通' } }
      : { ok: true as const, status: 200, data: { entries: [], missed: 0, config: { done_call: false } } }));
    const h = harness({ json: json as unknown as ApiClient['json'] });
    let said: { ok: boolean; error?: string } = { ok: true };
    await act(async () => { said = await h.handle.callBack({ reason: 'done', item_id: 't9', title: '下班例程' }); });
    expect(said).toEqual({ ok: false, error: '这一件正在响,没有再排一通' });
    expect(h.handle.note).toContain('这一件正在响,没有再排一通');
    // 拉台账那一次:那一通此刻还在响,未接列表上那颗键据此变灰,直到它收场。
    await waitFor(() => expect(json.mock.calls.filter(one => one[0] === '/call/log').length).toBeGreaterThan(1));
  });


  /* ——— 2026-09-22:清空未接 ——— */

  it('★清空 = POST /call/missed/clear,而且**当场把台账再拉一遍**', async () => {
    const json = vi.fn(async (path: string) => (path === '/call/missed/clear'
      ? { ok: true as const, status: 200, data: { ok: true, dismissed: 9 } }
      : { ok: true as const, status: 200, data: { entries: [], missed: 0 } }));
    const h = harness({ json: json as unknown as ApiClient['json'] });
    await waitFor(() => expect(json.mock.calls.some(one => one[0] === '/call/log')).toBe(true));
    const before = json.mock.calls.filter(one => one[0] === '/call/log').length;
    let said: { ok: boolean; error?: string } = { ok: false };
    await act(async () => { said = await h.handle.clearMissed(); });
    expect(said).toEqual({ ok: true });
    expect(json).toHaveBeenCalledWith('/call/missed/clear', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => expect(json.mock.calls.filter(one => one[0] === '/call/log').length).toBeGreaterThan(before));
  });

  it('★清空没发出去(出了局域网、工作台没开)就**如实说一句**,不假装收掉了', async () => {
    const json = vi.fn(async (path: string) => (path === '/call/missed/clear'
      ? { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }
      : { ok: true as const, status: 200, data: { entries: [], missed: 0 } }));
    const h = harness({ json: json as unknown as ApiClient['json'] });
    let said: { ok: boolean; error?: string } = { ok: true };
    await act(async () => { said = await h.handle.clearMissed(); });
    expect(said.ok).toBe(false);
    expect(h.handle.note).toContain('连不上工作台');
  });

  it('★`done_call` 跟着台账一起进手机的状态(`/call/log` 的回包里本来就带一份 config)', async () => {
    const json = (async (path: string) => (path === '/call/log'
      ? { ok: true as const, status: 200, data: { entries: [], missed: 0, config: { enabled: true, quiet_from: '23:00', quiet_to: '08:00', done_call: true } } }
      : { ok: true as const, status: 200, data: {} }));
    const h = harness({ json: json as unknown as ApiClient['json'] });
    await waitFor(() => expect(h.handle.log.doneCall).toBe(true));
  });
});

// ———————————————————————— ④ 未接面板的样式(2026-09-22) ————————————————————————

/**
 * Ben 真机 0.2.56:「未接来电」那个标题和手机的时钟 / 信号叠在一起 —— 面板顶到状态栏里去了。
 *
 * 这一条钉的是**源文件里那条约定**:这张卡是舞台页最靠上的那一块,顶上那一格要按
 * `--ba-safe-top`(Capacitor 里就是 `env(safe-area-inset-top)`)留出来,和这份文件里
 * 别的顶栏一套写法。jsdom 里演不出「叠没叠上」(vitest 没开 `css: true`,见
 * tests/orbSlotCss.test.ts 头注释里那一段),所以这里读的是 CSS 文本 ——
 * **代价如实写着**:它保证的是「那一格按安全区留了」,不是「真机上不压表」。
 *
 * 读之前先把注释整个剥掉:orbSlotCss 那一份就被自己写在 CSS 里的注释骗过一次(假绿)。
 */
describe('未接面板给状态栏让位', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('★`.ba-missed` 顶上那一格按 `--ba-safe-top` 留位', () => {
    const rule = ruleOf('.ba-missed');
    expect(rule).not.toBe('');
    expect(rule).toContain('--ba-safe-top');
  });

  it('`--ba-safe-top` 就是 `env(safe-area-inset-top)`(这条约定的前提)', () => {
    expect(css).toContain('--ba-safe-top: env(safe-area-inset-top');
  });
});

// ———————————————————————— ④ 打进打出同一张页(2026-09-23) ————————————————————————

/*
 * Ben 12:45 真机 0.2.68:「我拿起话筒确实是打出去了,但是手机上没有变化,这不对,
 * 打过来和打过去都应该是显示同一个页面。」
 *
 * 来电那条路(ring → 话筒接 → ring_end{answered,by:handset})早就进这一面;
 * **待机提机拨出**那条工人只开了个场,房里一个字都没广播。这一节钉的是那条统一信号
 * `call_state` 在手机这一侧怎么用。
 */
function callState(patch: Partial<WbchCallState> = {}): WbchCallState {
  return { type: 'call_state', state: 'in_call', by: 'handset', started_at: 1_700_000_000_000, ...patch };
}

describe('话筒拨出:同一张通话页', () => {
  it('★ 收到 in_call by:handset → 进话筒通话页(没有来电、没有 call_id 也进)', () => {
    const state = reduceIncoming(IDLE, { type: 'call_state', state: callState() });
    expect(state).toMatchObject({ kind: 'handset', by: 'handset', since: 1_700_000_000_000 });
    expect((state as { call?: unknown }).call).toBeUndefined();
  });

  it('★ 收到 idle → 退回舞台', () => {
    const inCall = reduceIncoming(IDLE, { type: 'call_state', state: callState() });
    expect(reduceIncoming(inCall, { type: 'call_state', state: callState({ state: 'idle' }) })).toEqual(IDLE);
  });

  it('★ 重复的 in_call 不闪:同一个对象原样返回(React 不为一条重复消息重画)', () => {
    const inCall = reduceIncoming(IDLE, { type: 'call_state', state: callState() });
    expect(reduceIncoming(inCall, { type: 'call_state', state: callState() })).toBe(inCall);
    expect(reduceIncoming(inCall, { type: 'call_state', state: callState({ started_at: 999 }) })).toBe(inCall);
  });

  it('★ 重复的 idle 不闪:已经待机就原样返回', () => {
    expect(reduceIncoming(IDLE, { type: 'call_state', state: callState({ state: 'idle' }) })).toBe(IDLE);
  });

  it('by:phone 的那一条不进这一面 —— 手机自己拨 / 自己接的那条路照旧', () => {
    expect(reduceIncoming(IDLE, { type: 'call_state', state: callState({ by: 'phone' }) })).toBe(IDLE);
    // 自己接起来的那一通(answered)更不许被它顶掉。
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    const answered = reduceIncoming(ringing, { type: 'answer' });
    expect(reduceIncoming(answered, { type: 'call_state', state: callState() })).toBe(answered);
  });

  it('★ 来电这条路上两条信号谁先到都进同一面,且**只进一次**', () => {
    const ringing = reduceIncoming(IDLE, { type: 'ring', ring: ring() });
    // 常态:ring_end 先到
    const a1 = reduceIncoming(ringing, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' } });
    const a2 = reduceIncoming(a1, { type: 'call_state', state: callState({ call_id: 'c1' }) });
    expect(a2).toMatchObject({ kind: 'handset', by: 'handset', call: { call_id: 'c1' }, since: 1_700_000_000_000 });
    // 反过来:call_state 先到,随后那条 ring_end 不该把这一面重画一遍
    const b1 = reduceIncoming(ringing, { type: 'call_state', state: callState({ call_id: 'c1' }) });
    expect(b1).toMatchObject({ kind: 'handset', call: { call_id: 'c1' }, since: 1_700_000_000_000 });
    expect(reduceIncoming(b1, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' } })).toBe(b1);
  });

  it('拨出那一通没有 call_id:别人那条 ring_end 收不掉它', () => {
    const inCall = reduceIncoming(IDLE, { type: 'call_state', state: callState() });
    expect(reduceIncoming(inCall, { type: 'ring_end', end: { type: 'ring_end', call_id: 'c9', outcome: 'hung_up' } })).toBe(inCall);
    expect(reduceIncoming(inCall, { type: 'timeout', now: 9_999_999_999 })).toBe(inCall);
  });

  it('手机上按挂断照旧走得掉(dismiss)', () => {
    const inCall = reduceIncoming(IDLE, { type: 'call_state', state: callState() });
    expect(reduceIncoming(inCall, { type: 'dismiss' })).toEqual(IDLE);
  });
});

describe('通话页上那行「从几点起」与那行事项', () => {
  it('★ 拨出那一通:没有事项,顶上写「话筒通话中 · 从 HH:MM 起」', () => {
    const at = new Date('2026-09-23T12:45:00').getTime();
    expect(handsetStatusText('handset', at)).toBe(`${HANDSET_IN_CALL} · 从 12:45 起`);
    // 没有事项那一行整个缺席 —— **不编一个事项出来**。
    expect(handsetItemText(undefined)).toBeNull();
  });

  it('★ 打进来那一通:同一张页,只是多一行事项(为什么 + 哪件事)', () => {
    const at = new Date('2026-09-23T09:05:00').getTime();
    expect(handsetStatusText('handset', at)).toBe(`${HANDSET_IN_CALL} · 从 09:05 起`);
    expect(handsetItemText({ call_id: 'c1', reason: 'confirm', item_id: 't1', title: '把首页文案改一版', at: '', until: 0 }))
      .toBe('等你确认 · 把首页文案改一版');
  });

  it('不知道从几点起就只写「话筒通话中」—— 不编一个时刻', () => {
    expect(handsetStatusText('handset')).toBe(HANDSET_IN_CALL);
    expect(handsetStatusText('handset', 0)).toBe(HANDSET_IN_CALL);
  });
});

describe('「等你回答」那一通(2026-09-25,卡 M:事务官在会话里问你 / 要你批)', () => {
  it('认得 ask:来电页写「等你回答」与怎么答', () => {
    expect(parseWbchInbound(JSON.stringify(ring({ reason: 'ask', title: '「修小头像」问你:派活前对一遍' })))).toMatchObject({ type: 'ring', reason: 'ask' });
    expect(RING_REASON_TITLES.ask).toBe('等你回答');
    expect(parseCallLog({ entries: [{ id: 'x', reason: 'ask', title: '甲', state: 'missed', at: 'y' }] }).entries).toHaveLength(1);
  });
});
