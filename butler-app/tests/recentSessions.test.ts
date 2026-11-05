// 「最近的对话」(2026-09-30,维护者:「如果会话状态不是正在办的话,我甚至在手机上都找不到这个会话」)。
//
// 手机「事项」页里各家的对话只有「各家正在办」那一段 —— 一条对话停下来(在等他、刚答完),
// 就从手机上消失了,点不进去,也就没法往里说一句。而他最要回话的,恰恰是停下来等他的那条。
import { describe, expect, it } from 'vitest';
import { externalRecent, externalRunning, RECENT_SESSION_DAYS, RECENT_SESSION_MAX } from '../src/stage/stageCardsModel';
import { emptyState, type AgentEntryView, type WorkbenchState } from '../src/api/protocol';

const NOW = '2026-09-30T10:00:00.000Z';
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

function entry(id: string, sessions: { id: string, status: string, updated: string, selfcheck?: boolean }[]): AgentEntryView {
  return {
    id, name: id, status: 'idle', gaps: {},
    sessions: sessions.map((s) => ({
      agent: id, session_id: s.id, project: id, status: s.status, title: `对话 ${s.id}`, elapsed_sec: 0, unread: false, updated_at: s.updated,
      ...(s.selfcheck === true ? { selfcheck: 'probe' } : {}),
    })),
    counts: { running: 0, waiting: 0, unread: 0 },
  } as unknown as AgentEntryView;
}
function state(entries: AgentEntryView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions: [], agent_registry: { entries, asking: [], notices: [] } } as unknown as WorkbenchState;
}

describe('最近的对话:停着的、在等他的也列出来', () => {
  it('★停着的与在等他的都在,在跑的不重复(它在「各家正在办」里),新的在前', () => {
    const s = state([entry('claude', [
      { id: 'run', status: 'running', updated: ago(0) },
      { id: 'wait', status: 'waiting', updated: ago(1) },
      { id: 'done', status: 'done', updated: ago(2) },
    ])]);
    expect(externalRunning(s).map((one) => one.session_id)).toEqual(['run']);
    expect(externalRecent(s).map((one) => one.session_id)).toEqual(['wait', 'done']);
  });

  it('太久以前的不列;工作台自己起的(自测)不列;事务官自己不列', () => {
    const s = state([
      entry('claude', [
        { id: 'old', status: 'done', updated: ago(24 * RECENT_SESSION_DAYS + 1) },
        { id: 'probe', status: 'done', updated: ago(1), selfcheck: true },
      ]),
      { ...entry('dsh', [{ id: 'mine', status: 'done', updated: ago(1) }]), self: true } as AgentEntryView,
    ]);
    expect(externalRecent(s)).toEqual([]);
  });

  it(`最多列 ${RECENT_SESSION_MAX} 条`, () => {
    const many = Array.from({ length: RECENT_SESSION_MAX + 5 }, (_, i) => ({ id: `s${i}`, status: 'done', updated: ago(i) }));
    expect(externalRecent(state([entry('codex', many)]))).toHaveLength(RECENT_SESSION_MAX);
  });

  it('电脑那份是上次的(stale):不列(同「正在办」那条规矩)', () => {
    const s = { ...state([entry('claude', [{ id: 'done', status: 'done', updated: ago(1) }])]), stale: true } as WorkbenchState;
    expect(externalRecent(s)).toEqual([]);
  });
});
