/**
 * 「等你确认」里别家的会话:首页那一行与点进去那张卡**查的是同一份会话**(2026-10-03,审计第四节第 1、2 条)。
 *
 * 10-03 之前首页的数(`/state.waiting`,工作台算的)包含两路会话 —— 会话文件那几家(`state.sessions`)
 * 与登记表里读窗口读出来的(`agent_registry.entries[].sessions`,`via:'window'`);而点进去那一页只在
 * `state.sessions` 里找。窗口型(豆包 / Muse / Manus…)只在登记表里 → 首页列得出、详情只剩一行字,
 * 批准 / 作答的键根本不渲染,还误注「到电脑上回答」。
 *
 * 键的拼法 10-03 从 `session:<家>:<id>` 改成 `session:<家>/<id>`;手机与插件分开发版,新手机连着老插件时
 * 收到的仍是老键 —— 认键容两种,**拼键只用新的**(`sessionJobId`,由 session-job-key-sync 钉着与插件一致)。
 */
import { describe, expect, it } from 'vitest';
import { emptyState, sessionJobId, sessionJobMatches, type SessionView, type WorkbenchState } from '../src/api/protocol';
import { askSessionOf, waitingRows } from '../src/stage/stageCardsModel';

const ASK: NonNullable<SessionView['ask']> = {
  kind: 'choose', question: '继续还是停止?', since: '2026-10-03T00:00:00Z', by: 'form', reply: 'window',
  press: true, write: true, options: [{ label: '继续' }, { label: '停止' }],
};

const fileSession: SessionView = {
  agent: 'codex', session_id: 'cx1', project: 'p', status: 'waiting', title: '文件型', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: ASK,
};
/** 登记表里读窗口读出来的那一条(窗口型会话 id 自带冒号)。 */
const windowSession = {
  agent: 'doubao', session_id: 'window:abc', via: 'window' as const, project: 'p', status: 'waiting' as const, title: '窗口型', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: ASK,
};

function stateOf(input: { sessions?: SessionView[]; registry?: boolean; keys?: string[] }): WorkbenchState {
  const sessions = input.sessions ?? [];
  const keys = input.keys ?? [];
  return {
    ...emptyState(),
    now: '2026-10-03T00:00:00Z',
    stale: false,
    sessions,
    ...(input.registry === true
      ? { agent_registry: { entries: [{ id: 'doubao', name: '豆包办公', status: 'waiting', gaps: {}, sessions: [windowSession], counts: { running: 0, waiting: 1, unread: 0 } }], asking: [], notices: [] } }
      : {}),
    waiting: { count: keys.length, items: keys.map((key) => ({ key, kind: 'session' as const, verb: '答', text: '有一家在等你' })) },
  } as unknown as WorkbenchState;
}

describe('认键:新拼法与 10-03 之前的老拼法都认,拼键只用新的', () => {
  it('新键 session:<家>/<id> 认', () => {
    expect(sessionJobMatches(sessionJobId('codex', 'cx1'), 'codex', 'cx1')).toBe(true);
    expect(sessionJobId('codex', 'cx1')).toBe('session:codex/cx1');
  });
  it('★老键 session:<家>:<id> 也认(新手机连老插件)—— 窗口型 id 自带冒号也不拆错', () => {
    expect(sessionJobMatches('session:codex:cx1', 'codex', 'cx1')).toBe(true);
    expect(sessionJobMatches('session:doubao:window:abc', 'doubao', 'window:abc')).toBe(true);
  });
  it('别家 / 别的会话 / 别的前缀一律不认(不猜)', () => {
    expect(sessionJobMatches('session:codex/cx1', 'claude', 'cx1')).toBe(false);
    expect(sessionJobMatches('session:codex/cx1', 'codex', 'cx2')).toBe(false);
    expect(sessionJobMatches('approval:cx1', 'codex', 'cx1')).toBe(false);
    expect(sessionJobMatches('session:codex/cx1/extra', 'codex', 'cx1')).toBe(false);
  });
});

describe('askSessionOf:首页与详情同一份会话来源', () => {
  it('会话文件那几家:按新键找得到', () => {
    expect(askSessionOf(stateOf({ sessions: [fileSession] }), 'session:codex/cx1')?.session_id).toBe('cx1');
  });
  it('★会话文件那几家:老键(冒号)也找得到', () => {
    expect(askSessionOf(stateOf({ sessions: [fileSession] }), 'session:codex:cx1')?.session_id).toBe('cx1');
  });
  it('★只在登记表里的窗口型会话(sessions 是空的)也找得到,ask 原样带着', () => {
    const found = askSessionOf(stateOf({ registry: true }), 'session:doubao/window:abc');
    expect(found?.agent).toBe('doubao');
    expect(found?.session_id).toBe('window:abc');
    expect(found?.ask).toEqual(ASK);
  });
  it('登记表里 via:"sessions" 那几条是 state.sessions 的副本,不从登记表取(不双份)', () => {
    const state = stateOf({ sessions: [], registry: true });
    const copy = { ...windowSession, agent: 'codex', session_id: 'cx1', via: 'sessions' as const };
    (state.agent_registry!.entries[0] as unknown as { sessions: unknown[] }).sessions = [copy];
    expect(askSessionOf(state, 'session:codex/cx1')).toBeUndefined();
  });
  it('★读它自己记录长出来的(via:"records",2026-10-08 千问办公)也只在登记表里 → 找得到', () => {
    const state = stateOf({ sessions: [], registry: true });
    const fromRecords = { ...windowSession, agent: 'cn.qwenwork.desktop.mac', via: 'records' as const };
    (state.agent_registry!.entries[0] as unknown as { sessions: unknown[] }).sessions = [fromRecords];
    expect(askSessionOf(state, 'session:cn.qwenwork.desktop.mac/window:abc')?.ask).toEqual(ASK);
  });
  it('都没有 → undefined', () => {
    expect(askSessionOf(stateOf({ sessions: [fileSession], registry: true }), 'session:kimi/none')).toBeUndefined();
  });
});

describe('首页那一行的附注跟着同一份来源走', () => {
  it('★窗口型会话 ask.reply 是 window → 「要你回答」,不再误注「到电脑上回答」;logo 按家取', () => {
    const rows = waitingRows(stateOf({ registry: true, keys: ['session:doubao/window:abc'] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'session:doubao/window:abc', kind: 'session', agent: 'doubao', note: '要你回答' });
  });
  it('老键(冒号)那一行也认得出是哪一家、该在哪儿答', () => {
    const rows = waitingRows(stateOf({ sessions: [fileSession], keys: ['session:codex:cx1'] }));
    expect(rows[0]).toMatchObject({ agent: 'codex', note: '要你回答' });
  });
});
