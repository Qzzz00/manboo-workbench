/**
 * 竖屏对话 = 事项的另一种投影。一事项一会话:我说的一句 = 一条 direction=mine 的卡,
 * 事务官那侧 = 那张卡底下会话的最新回合。
 *
 * **回复只认会话的 `summary`**;没有它就只显示状态(在办 / 等审批 / 办完 / 会话未开),
 * 状态是事实,不是回复,所以不朗读、也不画成事务官说的话——不编假回复。
 */
import { BUTLER_NO_SESSION_NOTE, CASUAL_ASK_LABEL, dispatchWho, taskOriginOf, type TaskView, type WorkbenchState } from '../api/protocol';
import { conversationOf, mineTasks } from '../items/itemsModel';
import type { SayCardPayload } from './sayCards';

export interface ButlerSide {
  kind: 'reply' | 'status' | 'error';
  text: string;
  /** 只有真回复才朗读。 */
  speak: boolean;
  /**
   * 这件事此刻停着等他(2026-09-25,卡 M 补):`answer` 她问了他一句、`approve` 要他批一件事。
   * 首页字幕据此先摆这一件(她在等他答时,字幕说的就是「等你回答」—— 同电脑球下那一句)。
   */
  waiting?: 'answer' | 'approve';
}

export interface ThreadMessage {
  /** 已落到工作台的事项 id;还没落地的只有 localId。 */
  taskId?: string;
  taskIds?: string[];
  localId?: string;
  user: string;
  /**
   * 事项标题(已落地的才有)。**首页球下面那行字幕只写这个**(2026-09-25,统筹 19:55:
   * 「显示事项标题,出处说明不上首页」)—— desc 里可能是出处说明,也可能是他那段话的全文,都不上字幕。
   */
  title?: string;
  at: string;
  butler: ButlerSide;
  status?: TaskView['status'];
  /** 回执三档(2026-10-12):没送到 / 送到了在等 / 办完了。还在发、或电脑答了不行,缺席。 */
  receipt?: Receipt;
  sayCards?: SayCardPayload;
}

/**
 * ★ **回执三档**(2026-10-12,卡「手机交代只执行一次」)。运营同学的验收标准:发送失败、等待处理、处理完成在手机上明确区分。
 * 「没送到」是手机这边留着、连上了自动补发的(outbox/sendOutbox.ts);电脑答了不行的不算(那是送到了、被拒,原话照摆)。
 */
export type Receipt = 'unsent' | 'waiting' | 'done';

export const RECEIPT_TEXT: Readonly<Record<Receipt, string>> = {
  unsent: '没送到 · 连上电脑会自动重发',
  waiting: '送到了 · 在等',
  done: '办完了',
};

/** 有卡的那句话按卡的状态算:做完、等她确认、取消了都算这一句办完了。 */
export function receiptOfStatus(status: TaskView['status']): Receipt {
  return status === 'done' || status === 'confirm' || status === 'canceled' ? 'done' : 'waiting';
}

export interface PendingMessage {
  localId: string;
  text: string;
  at: string;
  /** 回执里的事项 id;有了它 /state 一带回来这条就退场。 */
  taskId?: string;
  taskIds?: string[];
  /**
   * 这条气泡底下那一句状态(2026-09-25,卡 Y:「接着刚才那件说了」)。
   * 有它就不说「发送中…」—— 这句话已经送到了,只是没有自己那张卡。
   */
  note?: string;
  error?: string;
  /** 没送到(连不上 / 电脑 5xx),留在待发箱里等补发。`error` 是那一句原因。 */
  unsent?: true;
  /** 送到了、电脑那头不用再办(登记了一场会、本体反馈):回执直接「办完了」。 */
  settled?: true;
  sayCards?: SayCardPayload;
}

function status(text: string): ButlerSide {
  return { kind: 'status', text, speak: false };
}

/**
 * 派给别家那一件,**它回来的那段话**(2026-09-24,卡 F)。工作台把回答收回来写在卡上
 * (窗口那只手读回复 / 命令行那只手读结果文件 / 接口那只手同步回),手机照着显示;
 * 读不回来就显示那句「已发出,结果要你到 X 里看」—— 不编一个回答。没派过活回 undefined。
 *
 * ★ 2026-10-03(卡「两条接缝」):从前这里有手机自己那张 `DISPATCH_WHO`(审计第二表第 8 条的
 * 第三个池,`doubao` 已经漂成「豆包」)。现在问 {@link dispatchWho} —— 先登记表(主人下发的那一份),
 * 没有才查那一张退路表。`state` 缺席(从前的调用形状)就只有退路表,行为不比从前差。
 */
export function dispatchReplyOf(task: TaskView, agents?: Pick<WorkbenchState, 'agent_registry'>): ButlerSide | undefined {
  const cd = task.client_dispatch;
  const d = task.dispatch;
  const family = cd?.family ?? d?.family ?? '';
  const who = family === '' ? '那一家' : dispatchWho(family, agents);
  if (cd?.reply !== undefined && cd.reply.trim() !== '') return { kind: 'reply', text: `${who}回来了:${cd.reply.trim()}`, speak: true };
  if (d?.reply !== undefined && d.reply.trim() !== '') return { kind: 'reply', text: `${who}回来了:${d.reply.trim()}`, speak: true };
  if (cd?.reply_state === 'unreadable') return status(cd.reply_note ?? `已发出,结果要你到 ${who} 里看`);
  if (cd?.status === 'failed') return { kind: 'error', text: `派给 ${who} 没送成:${cd.reason ?? '没说原因'}`, speak: false };
  if (d?.status === 'failed') return { kind: 'error', text: `派给 ${who} 没做成:${d.note ?? '没说原因'}`, speak: false };
  if (cd?.reply_state === 'waiting') return status(`已派给 ${who},等它回答`);
  if (d?.status === 'running') return status(`${who} 在做,做完把结果收回来`);
  return undefined;
}

export function replyOf(state: WorkbenchState, task: TaskView): ButlerSide {
  // 派给别家的那一件:先看它回来的那段话(没开事务官会话,会话摘要里什么都没有)。
  const dispatched = dispatchReplyOf(task, state);
  if (dispatched !== undefined) return dispatched;
  /**
   * 「落地」口写下的一句话回话(2026-10-24,卡 1a):手机上优先显示它 —— 与电脑浮窗/全屏同源,
   * 不另按状态拼。它是事务官的真回话,朗读。
   */
  if (task.say_note !== undefined && task.say_note.trim() !== '') {
    return { kind: 'reply', text: task.say_note.trim(), speak: true };
  }
  /**
   * 这件事里事务官在问他 / 要他批(2026-09-25,卡 M;卡 M 补:统筹真壳「她在等他答时,状态要说『等你回答』」):
   * 字幕说「等你回答:…」「等你批:…」—— 同电脑球下那一句;在哪答就在首页「等你确认」那一格(不再说「在电脑上确认」)。
   * 排在会话那一句前面:这件事正停着等他,比上一句回复要紧。工作台没接上这一问(旧版)时落到下面会话的状态,照旧说在电脑上。
   */
  const question = (state.questions ?? []).find((one) => one.task_id === task.id);
  if (question !== undefined) return { ...status(`等你回答:${question.questions[0]?.header ?? '要你定一下'}`), waiting: 'answer' };
  const approval = (state.approvals ?? []).find((one) => one.task_id === task.id);
  if (approval !== undefined) return { ...status(`等你批:${approval.say ?? '一件事'}`), waiting: 'approve' };
  const session = conversationOf(state, task);
  if (session?.summary !== undefined && session.summary.trim() !== '') {
    return { kind: 'reply', text: session.summary.trim(), speak: true };
  }
  // 交回来的那条回答(2026-09-25 卡 N):「XX 到哪了」工作台当场按证据答,不开会话,答的那一句挂在交付物里;
  // 会话答完时服务端挂的那条也在这里。有它就是回复,不说「会话未开」。
  const answered = [...(task.deliverables ?? [])].reverse().find((one) => one.kind === 'reply')?.ref;
  if (answered !== undefined && answered.trim() !== '') return { kind: 'reply', text: answered.trim(), speak: true };
  if (task.conversation === undefined) return status(BUTLER_NO_SESSION_NOTE);
  if (task.status === 'confirm') return status('办完了,等你确认(审批在电脑上点)');
  // 「只是问了一句」的那一张(2026-09-25,卡 Y):她答完自己收掉的,不说「办完了」—— 他没交代过一件活。
  if (task.status === 'done') return status(task.casual === true ? CASUAL_ASK_LABEL : '办完了');
  if (task.status === 'canceled') return status('已取消');
  if (session?.status === 'waiting') {
    if (session.wait_reason === 'approval') return status('等你审批(在电脑上确认)');
    if (session.wait_reason === 'quota') return status('额度不足,停下了');
    if (session.wait_reason === 'error') return status('出错了,停下了');
    return status('等你补一句(在电脑上回)');
  }
  if (session?.status === 'error') return status('出错了');
  if (task.status === 'blocked') return status('卡住了');
  if (session?.status === 'done') return status('这一轮跑完了');
  return status('事务官在办');
}

/**
 * 对话记录 = 他说的一句 = 一张 `mine` 卡。**系统写下的卡不是他说的话**(2026-09-25,卡 feat/first-look-orb-top):
 * 通话纪要、引导排的方案、会议挑出来的待办不进这里 —— 以前首页球下面那行字幕显示的就是引导那几条的**出处说明**
 * (「引导 ②′ 排的方案「desktop-workbench」。你自己说的头号需求」)配一句「会话未开」,那不是给人看的。
 * 他亲口交代的那条,desc 是他那句话的全文(标题是截短的第一行),照旧用 desc。
 */
export function buildThread(state: WorkbenchState): ThreadMessage[] {
  return mineTasks(state)
    .filter((task) => taskOriginOf(task) === 'user')
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((task) => ({
      taskId: task.id,
      user: task.desc !== undefined && task.desc.trim() !== '' ? task.desc : task.title,
      title: task.title,
      at: task.created_at,
      butler: replyOf(state, task),
      status: task.status,
      receipt: receiptOfStatus(task.status),
    }));
}

function pendingReceipt(p: PendingMessage): { receipt?: Receipt } {
  if (p.unsent === true) return { receipt: 'unsent' };
  if (p.error !== undefined) return {};
  if (p.settled === true) return { receipt: 'done' };
  if (p.taskId !== undefined || p.note !== undefined) return { receipt: 'waiting' };
  return {};
}

export function mergePending(thread: ThreadMessage[], pending: readonly PendingMessage[]): ThreadMessage[] {
  const known = new Set(thread.map((m) => m.taskId));
  const extra = pending
    // 快照只有事项事实，不能替代本次 say 的决定编号与回话；动作后回包也沿同一 localId 更新。
    .filter((p) => p.sayCards !== undefined || p.taskId === undefined && !(p.taskIds?.length) || (p.taskId !== undefined && !known.has(p.taskId)) || (p.taskIds?.some(id => !known.has(id)) ?? false))
    .map<ThreadMessage>((p) => ({
      localId: p.localId,
      ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
      ...(p.taskIds === undefined ? {} : { taskIds: p.taskIds }),
      ...(p.sayCards === undefined ? {} : { sayCards: p.sayCards }),
      user: p.text,
      at: p.at,
      butler: p.unsent === true
        ? { kind: 'error', text: `没送到:${p.error ?? '连不上电脑'}`, speak: false }
        : p.error !== undefined
          ? { kind: 'error', text: p.error, speak: false }
          : p.note !== undefined ? status(p.note)
            : p.taskId === undefined ? status('发送中…') : status('已交给事务官'),
      ...pendingReceipt(p),
    }));
  return [...thread, ...extra];
}
