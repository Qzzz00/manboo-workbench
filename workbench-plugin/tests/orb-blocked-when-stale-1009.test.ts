/**
 * ★ **掉线时「受阻 N」不跳上去**(2026-10-09,卡「四件小事」第 3 件;0.4.96 遗留,10-04 统筹定两端一起修)。
 *
 * 快照冻结(`stale`)时,工作台读不到各家此刻在干什么 —— 「在等某家」那一条判据就数不出来,
 * 不能把每件挂了会话的事都算成受阻(那是「掉线」,球上方已有掉线那一句)。
 * 真卡在「阻塞」那一列、真出过错的照旧算:那是事项自己的账,不靠各家此刻的状态。
 *
 * 电脑首页与手机都读 `/state.orb.blocked`(`src/orbCell.ts` 一处算);
 * 电脑那条老兼容路(`buildButlerScene().blocked`)同一条判据,两边在同一份快照上相等。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { blockedCountOf, orbCellOf } from '../src/orbCell.ts'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const NOW = '2026-10-09T10:00:00.000Z'

const session = (more: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: '工作台', status: 'running', elapsed_sec: 60, unread: false, updated_at: '2026-10-09T09:59:00.000Z', ...more,
})

const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status, direction: 'mine', source: { kind: 'manual' },
  created_at: '2026-10-09T09:00:00.000Z', updated_at: '2026-10-09T09:30:00.000Z', ...more,
})

function state(tasks: TaskView[], sessions: SessionView[], stale: boolean): WorkbenchState {
  const base: WorkbenchState = {
    agents: [{ id: 'codex', online: true }, { id: 'claude', online: true }] as unknown as WorkbenchState['agents'],
    sessions, quota: {}, stale, now: NOW,
    tasks: { tasks, sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] },
  }
  return { ...base, butler_inbox: deriveButlerInbox({ tasks: base.tasks, sessions: base.sessions }) }
}

/** 两件正在各家那里跑的事 + 一件真卡在「阻塞」那一列的。 */
function board(stale: boolean): WorkbenchState {
  return state(
    [
      task('t-codex', 'doing', { links: [{ agent: 'codex', session_id: 'codex-1' }] }),
      task('t-claude', 'doing', { links: [{ agent: 'claude', session_id: 'claude-1' }] }),
      task('t-stuck', 'blocked'),
    ],
    [session({ agent: 'codex', session_id: 'codex-1' }), session({ agent: 'claude', session_id: 'claude-1' })],
    stale,
  )
}

describe('★ 掉线时不把各家算成受阻', () => {
  it('在线时:只有真卡住的那一件', () => {
    expect(orbCellOf(board(false)).blocked).toBe(1)
  })

  it('快照冻结:挂着会话的那两件不跳成受阻,真卡住的那一件照旧算', () => {
    expect(orbCellOf(board(true)).blocked).toBe(1)
  })

  it('快照冻结时,冻结前就在等她 / 那家下线的,也不在这时候算(数不出来就不编)', () => {
    const one = state(
      [task('t-wait', 'doing', { links: [{ agent: 'claude', session_id: 's-wait' }] })],
      [session({ agent: 'claude', session_id: 's-wait', status: 'waiting' })],
      true,
    )
    expect(orbCellOf(one).blocked).toBe(0)
    expect(orbCellOf({ ...one, stale: false }).blocked).toBe(1)
  })

  it('快照冻结时,真出过错的那件照旧算(事项自己的账)', () => {
    const one = state([task('t-err', 'doing', { block_reason: 'error' })], [], true)
    expect(orbCellOf(one).blocked).toBe(1)
  })

  it.each([false, true])('电脑老兼容那一路与服务端那一格同一个数(stale=%s)', (stale) => {
    const one = board(stale)
    expect(buildButlerScene(one).blocked).toBe(blockedCountOf(one))
  })
})
