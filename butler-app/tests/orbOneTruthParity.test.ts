/**
 * ★ **同一份 /state,电脑与手机算出的球色必须相同**(2026-10-04,卡「球的颜色一处算」)。
 *
 * 维护者 10-04 原话(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、
 * 颜色比如状态……我担心他跟到最新版两个端还是会有一样的问题」。
 *
 * 根子是两端各自从 /state 推算。现在工作台用 `workbench-plugin/src/orbCell.ts` 的 `orbCellOf`
 * 算好 `/state.orb`,两端只显示那一格。这一份**把同一份夹具喂给两边**:
 * 一边是插件那个纯函数(跨目录 import —— 只有用例这么做,产品代码照旧互不 import),
 * 一边是手机这边的 `signalsFromState` + `stageModeOf`。
 *
 * 方向只能是这一边:插件那个包的 tsconfig 比这边严(`exactOptionalPropertyTypes` /
 * `noUncheckedIndexedAccess`),反过来从插件 import 手机源码会把手机那几个文件一起判红。
 * `#orb-cell` 的真路径在 `vitest.config.ts` 的别名里、类型在 `tests/orb-cell-module.d.ts` 一行里
 * (理由写在那两处)。
 */
import { describe, expect, it } from 'vitest';
import { orbCellOf } from '#orb-cell';
import type { SessionView, TaskView, WorkbenchState } from '../src/api/protocol';
import { signalsFromState, stageModeOf } from '../src/swarm/orbState';

const NOW = '2026-10-04T10:00:00.000Z';

const session = (more: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: '工作台', status: 'running', elapsed_sec: 60, unread: false, updated_at: '2026-10-04T09:59:00.000Z', ...more,
});

const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status, direction: 'mine', source: { kind: 'manual' },
  created_at: '2026-10-04T09:00:00.000Z', updated_at: '2026-10-04T09:30:00.000Z', ...more,
});

function state(tasks: TaskView[], sessions: SessionView[] = [], more: Record<string, unknown> = {}): WorkbenchState {
  return {
    agents: [], sessions, quota: {}, stale: false, now: NOW,
    tasks: { tasks }, butler_inbox: { items: [] },
    ...more,
  } as WorkbenchState;
}

/** 此刻真有一件在跑、而且就是它出错了(球该红的那一种)。 */
const failingNow = (): WorkbenchState => state(
  [task('t-now', 'doing', { block_reason: 'error', links: [{ agent: 'codex', session_id: 'codex-1' }] })],
  [session({ agent: 'codex', session_id: 'codex-1', status: 'running' })],
);

/** 上周那件早就放下的事(出过错、不在跑)—— 以前手机这里是**永久红**。 */
const oldFailure = (): WorkbenchState => state([task('t-last-week', 'blocked', { block_reason: 'error' })]);

/** 工作台算好那一格,贴回快照(真机上这一步在服务端 composeState 里)。 */
function withCell(one: WorkbenchState): WorkbenchState {
  return { ...one, orb: orbCellOf(one) };
}

/** 手机这边最后画出来的提示色(不说话、不收音时 —— 本机交互态不在这一条的范围里)。 */
const phoneNotice = (one: WorkbenchState): string =>
  stageModeOf(signalsFromState(one, { speaking: false, listening: false })).notice;

describe('★ 同一份 /state:两端的球色相同', () => {
  const fixtures: [string, WorkbenchState][] = [
    ['正在跑的那件出错 → 两端都红', failingNow()],
    ['上周那件出过错 → 两端都不红(以前手机是永久红)', oldFailure()],
    ['等她回话 → 两端都琥珀', state([], [], { waiting: { count: 1, items: [] } })],
    ['她按了试铃(通话中)→ 两端都琥珀', state([], [], { test_ringing: true })],
    ['一切正常 → 两端都中性', state([task('t-ok', 'doing')])],
    ['办完了的那几件不染色', state([task('t-done', 'done'), task('t-canceled', 'canceled')])],
  ];

  it.each(fixtures)('%s', (_name, one) => {
    const snapshot = withCell(one);
    // 电脑:`ButlerInbox.tsx` 直接读这一格(`state.orb?.notice ?? 老兼容那一路`)。
    const desktop = snapshot.orb?.notice;
    expect(desktop).toBeDefined();
    expect(phoneNotice(snapshot)).toBe(desktop);
  });

  it('★ 在办与否也同源:那一格说没在办,手机就不摆莫比乌斯环(哪怕它自己数得出一条在跑的会话)', () => {
    const one = failingNow();
    const snapshot = { ...one, orb: { ...orbCellOf(one), working: false } } as WorkbenchState;
    expect(stageModeOf(signalsFromState(snapshot, { speaking: false, listening: false })).mode).not.toBe('working');
    expect(phoneNotice(withCell(one))).toBe('failed');
    expect(stageModeOf(signalsFromState(withCell(one), { speaking: false, listening: false })).mode).toBe('working');
  });

  it('★ 本机交互态照旧盖在上面:在说话 / 在收音时球是中性(电脑没有这两样,不强求一致)', () => {
    const snapshot = withCell(failingNow());
    expect(stageModeOf(signalsFromState(snapshot, { speaking: true, listening: false }))).toEqual({ mode: 'speaking', notice: 'neutral' });
    expect(stageModeOf(signalsFromState(snapshot, { speaking: false, listening: true }))).toEqual({ mode: 'listening', notice: 'neutral' });
  });

  it('★ 老工作台没有这一格:手机退回本地推算,行为与 0.4.96 一字不差(那件出过错的照旧红)', () => {
    expect(phoneNotice(oldFailure())).toBe('failed');
    expect(oldFailure().orb).toBeUndefined();
  });
});
