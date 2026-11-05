import { describe, expect, it } from 'vitest';
import type { WorkbenchState, TaskView } from '../src/api/protocol';
import { buildThread, mergePending, replyOf, type PendingMessage } from '../src/chat/chatModel';

function task(partial: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return { title: partial.id, created_at: '2026-09-14T01:00:00Z', updated_at: '2026-09-14T01:00:00Z', direction: 'mine', ...partial };
}

const state: WorkbenchState = {
  now: '', stale: false,
  sessions: [
    { agent: 'dsh', session_id: 's-1', project: 'p', status: 'running', elapsed_sec: 3, unread: false, updated_at: '2026-09-14T01:30:00Z' },
    { agent: 'dsh', session_id: 's-2', project: 'p', status: 'waiting', wait_reason: 'approval', elapsed_sec: 60, unread: false, updated_at: '2026-09-14T01:40:00Z' },
    { agent: 'dsh', session_id: 's-3', project: 'p', status: 'done', summary: '版本号已经补到 0.1.6,顺手改了 changelog。', elapsed_sec: 0, unread: true, updated_at: '2026-09-14T01:50:00Z' },
  ],
  tasks: { tasks: [
    task({ id: 't-1', status: 'doing', title: '补版本号', desc: '把 Aiboo 的客户端版本号补上\n顺便看看 changelog', conversation: { agent: 'dsh', session_id: 's-1' }, created_at: '2026-09-14T01:00:00Z' }),
    task({ id: 't-2', status: 'confirm', title: '整理交接', conversation: { agent: 'dsh', session_id: 's-2' }, created_at: '2026-09-14T01:05:00Z' }),
    task({ id: 't-3', status: 'todo', title: '没开会话的', created_at: '2026-09-14T01:10:00Z' }),
    task({ id: 't-4', status: 'done', title: '有回复的', conversation: { agent: 'dsh', session_id: 's-3' }, created_at: '2026-09-14T00:50:00Z' }),
  ] },
};

describe('replyOf:一条事项的「回复」', () => {
  it('会话有 summary → 那就是回复(kind=reply),可朗读', () => {
    const t = state.tasks!.tasks[3];
    expect(replyOf(state, t)).toEqual({ kind: 'reply', text: '版本号已经补到 0.1.6,顺手改了 changelog。', speak: true });
  });
  /** 「随手问一句不算一件事」(2026-09-25,卡 Y):她答完自己收掉的那张,状态那一句不说「办完了」。 */
  it('★盖了 casual 章又没 summary → 说「只是问了一句」,不说「办完了」', () => {
    const casual = task({ id: 't-9', status: 'done', casual: true, title: '一周有几天?', conversation: { agent: 'dsh', session_id: 's-none' } });
    expect(replyOf(state, casual)).toEqual({ kind: 'status', text: '只是问了一句', speak: false });
    const plain = task({ id: 't-10', status: 'done', title: '办完的', conversation: { agent: 'dsh', session_id: 's-none' } });
    expect(replyOf(state, plain).text).toBe('办完了');
  });
  it('没有 summary → 只给状态,不编回复;文案来自状态,不朗读', () => {
    expect(replyOf(state, state.tasks!.tasks[0])).toEqual({ kind: 'status', text: '事务官在办', speak: false });
    expect(replyOf(state, state.tasks!.tasks[1])).toEqual({ kind: 'status', text: '办完了,等你确认(审批在电脑上点)', speak: false });
    expect(replyOf(state, state.tasks!.tasks[2])).toEqual({ kind: 'status', text: '会话未开', speak: false });
  });
  it('会话在等审批但卡还在进行中 → 状态说等审批', () => {
    const t = task({ id: 'x', status: 'doing', conversation: { agent: 'dsh', session_id: 's-2' } });
    expect(replyOf(state, t).text).toBe('等你审批(在电脑上确认)');
  });
  it('这件事里事务官在问你 / 要你批:字幕说「等你回答」「等你批」(同电脑球下那一句),不再说「在电脑上」(卡 M)', () => {
    const t = task({ id: 'x', status: 'doing', conversation: { agent: 'dsh', session_id: 's-2' } });
    const asked: WorkbenchState = {
      ...state,
      questions: [{ id: 'q', session_id: 's-2', task_id: 'x', at: '', questions: [{ id: 'a', header: '派活前对一遍', question: '都对就开工。', multi: false, options: [] }] }],
    };
    expect(replyOf(asked, t)).toEqual({ kind: 'status', text: '等你回答:派活前对一遍', speak: false, waiting: 'answer' });
    const approving: WorkbenchState = {
      ...state,
      approvals: [{ id: 'p', session_id: 's-2', task_id: 'x', tool: 'bash', at: '', say: '要开一个看不见的浏览器,把页面截下来看' }],
    };
    expect(replyOf(approving, t)).toEqual({ kind: 'status', text: '等你批:要开一个看不见的浏览器,把页面截下来看', speak: false, waiting: 'approve' });
    // 别的事项里的那一问不算到这件头上
    expect(replyOf({ ...approving, approvals: [{ ...approving.approvals![0]!, task_id: 'other' }] }, t).text).toBe('等你审批(在电脑上确认)');
  });
  it('卡有 conversation 但 sessions 里查不到(还没上报 / 归档)→ 按卡的状态说', () => {
    const t = task({ id: 'x', status: 'done', conversation: { agent: 'dsh', session_id: 'gone', archived_at: 'z' } });
    expect(replyOf(state, t).text).toBe('办完了');
  });
});

describe('buildThread:把事项串成对话', () => {
  it('按建立时间从旧到新;每条事项 = 我说的一句(desc 优先,没有用 title)+ 事务官那侧', () => {
    const thread = buildThread(state);
    expect(thread.map((m) => m.taskId)).toEqual(['t-4', 't-1', 't-2', 't-3']);
    expect(thread[1].user).toBe('把 Aiboo 的客户端版本号补上\n顺便看看 changelog');
    expect(thread[3].user).toBe('没开会话的');
    expect(thread[0].butler).toEqual({ kind: 'reply', text: '版本号已经补到 0.1.6,顺手改了 changelog。', speak: true });
  });
  it('不算看板上普通的卡', () => {
    const s: WorkbenchState = { ...state, tasks: { tasks: [...state.tasks!.tasks, task({ id: 'k', status: 'doing', direction: undefined })] } };
    expect(buildThread(s).some((m) => m.taskId === 'k')).toBe(false);
  });
});

describe('mergePending:刚发出去、/state 还没带回来的那句', () => {
  it('事项已进真实快照也保留同源决定与动作回话，不以 card ID 代替 say 结果', () => {
    const known = [{ taskId: 't-real', user: '原件', at: 'x', butler: { kind: 'status' as const, text: '在办', speak: false as const } }];
    for (const payload of [
      { say_id: 's', say: { screen: '服务端决定原话' }, decided: [{ decided_id: 'd', item_index: 0, field: 'who' as const, chosen: 'codex', why: '已学习默认', alternatives: [] }] },
      { say_id: 's', say: { screen: '服务端建议原话' }, suggest: { suggest_id: 'g', line: '建议', default_action: 'keep', options: [{ id: 'codex', label: 'Codex' }] } },
      { say_id: 's2', say: { screen: '已按选择派发，仍是原件' } },
    ]) {
      const result = mergePending(known, [{ localId: 'p-real', taskIds: ['t-real'], text: '交代', at: 'x', note: payload.say.screen, sayCards: payload }]);
      expect(result.find(one => one.localId === 'p-real')?.sayCards).toEqual(payload);
      expect(result.find(one => one.localId === 'p-real')?.butler.text).toBe(payload.say.screen);
    }
  });
  it('pending 里 id 已在 state 出现 → 丢掉 pending;没出现 → 追加在末尾', () => {
    const pending: PendingMessage[] = [
      { localId: 'p1', text: '补版本号', taskId: 't-1', at: '2026-09-14T01:00:00Z' },
      { localId: 'p2', text: '新的一句', taskId: 't-9', at: '2026-09-14T02:00:00Z' },
      { localId: 'p3', text: '还在发', at: '2026-09-14T02:01:00Z' },
    ];
    const thread = mergePending(buildThread(state), pending);
    const ids = thread.map((m) => m.taskId ?? m.localId);
    expect(ids).toEqual(['t-4', 't-1', 't-2', 't-3', 't-9', 'p3']);
    expect(thread[4].butler).toEqual({ kind: 'status', text: '已交给事务官', speak: false });
    expect(thread[5].butler).toEqual({ kind: 'status', text: '发送中…', speak: false });
  });
  it('一句多件只有所有 done 卡都进 state 才收起临时回包，部分失败留住原回话', () => {
    expect(mergePending([{ taskId: 't-a', user: 'a', at: 'x', butler: { kind: 'status', text: 'done', speak: false } }], [
      { localId: 'p-all', text: '一句两件', at: 'x', taskIds: ['t-a'] },
    ])).toHaveLength(1);
    expect(mergePending([], [
      { localId: 'p-partial', text: '一句两件', at: 'x', taskIds: ['t-a'], note: '第一件办完，第二件失败', sayCards: { items: [{ status: 'done' }, { status: 'failed' }] } },
    ])).toHaveLength(1);
  });
  /**
   * 「接着刚才那件说了」(2026-09-25,卡 Y):这句话说进了上一件那条会话里、没建新卡,所以它**不挂那张卡的 id** ——
   * 挂了就会被当成"那张卡已经在对话里了"收掉,他刚说的那句话从屏上消失。气泡底下那句说「接着刚才那件说了」,
   * 不说「发送中…」(它已经送到了)。
   */
  it('★接着刚才那件说的那一句:留成自己一条气泡,底下说「接着刚才那件说了」', () => {
    const thread = mergePending(buildThread(state), [
      { localId: 'p9', text: '第二个按你说的来', at: '2026-09-14T02:02:00Z', note: '接着刚才那件说了' },
    ]);
    const last = thread[thread.length - 1];
    expect(last.localId).toBe('p9');
    expect(last.user).toBe('第二个按你说的来');
    expect(last.butler).toEqual({ kind: 'status', text: '接着刚才那件说了', speak: false });
  });
  it('pending 带 error → 事务官那侧显示错误原话', () => {
    const thread = mergePending([], [{ localId: 'p', text: 'x', at: 'z', error: '连不上工作台' }]);
    expect(thread[0].butler).toEqual({ kind: 'error', text: '连不上工作台', speak: false });
  });
});

// 2026-09-24(卡 F「手机远程派活六家」):派给别家那一件,手机上看到的是**那家回来的那段话**。
describe('dispatchReplyOf / replyOf:派给别家的那一件', () => {
  it('窗口那只手读回来了 → 「Kimi回来了:…」,可朗读(没开事务官会话,摘要里什么都没有)', () => {
    const t = task({ id: 'd-1', status: 'confirm', client_dispatch: { status: 'sent', at: 'x', family: 'kimi', reply_state: 'done', reply: '一年有 4 个季节。' } });
    expect(replyOf(state, t)).toEqual({ kind: 'reply', text: 'Kimi回来了:一年有 4 个季节。', speak: true });
  });
  it('命令行那只手的结果文件 → 同样显示回答', () => {
    const t = task({ id: 'd-2', status: 'confirm', dispatch: { status: 'done', started_at: 'x', family: 'codex', hand: 'cli', reply: '已新建 hello.txt。' } });
    expect(replyOf(state, t).text).toBe('Codex回来了:已新建 hello.txt。');
  });
  it('★读不回来 → 照那一句说「已发出,结果要你到 X 里看」,不编回答、不朗读', () => {
    const t = task({ id: 'd-3', status: 'confirm', client_dispatch: { status: 'sent', at: 'x', family: 'muse', reply_state: 'unreadable', reply_note: '已发出,结果要你到 Muse 里看' } });
    expect(replyOf(state, t)).toEqual({ kind: 'status', text: '已发出,结果要你到 Muse 里看', speak: false });
  });
  it('还在等 → 「已派给 Manus,等它回答」;没送成 → 报错那一格带原话', () => {
    const waiting = task({ id: 'd-4', status: 'doing', client_dispatch: { status: 'sent', at: 'x', family: 'manus', reply_state: 'waiting' } });
    expect(replyOf(state, waiting).text).toBe('已派给 Manus,等它回答');
    const failed = task({ id: 'd-5', status: 'blocked', client_dispatch: { status: 'failed', at: 'x', family: 'doubao', reason: '输入框没找到' } });
    // 2026-10-03(卡「两条接缝」):家名与插件那份主人对齐 —— 以前手机说「豆包」、电脑说「豆包办公」。
    expect(replyOf(state, failed)).toEqual({ kind: 'error', text: '派给 豆包办公 没送成:输入框没找到', speak: false });
  });
  it('没派过活的卡 → 行为一字不变(还是按会话 / 卡的状态说)', () => {
    expect(replyOf(state, state.tasks!.tasks[2])).toEqual({ kind: 'status', text: '会话未开', speak: false });
  });
});
