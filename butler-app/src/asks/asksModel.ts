/**
 * 事务官问你的话、要你批的事 —— 手机首页「等你确认」那一格里的行(2026-09-25,卡 M)。只翻译,不判断(判断在工作台)。
 * 与电脑 workbench-plugin/src/client/askModel.ts 同一个说法。
 */
import type { PendingApprovalView, PendingQuestionView, WaitingItemView, WaitingView, WorkbenchState } from '../api/protocol';

export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/** 「这件事」怎么称呼:事项标题截短加书名号;查不到卡就说「事务官」。 */
export function askSubject(taskTitle: string | undefined, max = 12): string {
  const title = taskTitle?.trim() ?? '';
  return title === '' ? '事务官' : `「${clip(title, max)}」`;
}

/* ─────────── 批准卡一眼看清 + 点哪件开哪件(2026-09-28,卡 UX) ─────────── */

/** 这一家在卡上怎么称呼(`dsh` = 事务官自己做)。 */
export function approvalOptionName(option: { family: string; title: string }): string {
  return option.family === 'dsh' ? '事务官自己做' : option.title;
}

export type ApprovalOption = NonNullable<PendingApprovalView['options']>[number];

/**
 * 派活那一张批准卡的**脸**(2026-09-28,卡 UX;维护者原话:「那个允许这一次,我点了,但是他发给了 Claude」)。
 *
 * 出事的那一张:正文一整面各家额度(Claude 28% / Muse 97% / Codex 46% / 豆包 99%…),
 * 「哪件事、派给谁」只在最上面一小行灰字 —— 他以为批的是列表里第一行那件事(Manus 那一件),
 * 点了「允许这一次」,结果把「验证自我迭代能力」派给了 Claude。
 *
 * 现在:大字第一行就是这一问;别家额度收起成一行;「允许」那颗键带着对象。
 * 与电脑 workbench-plugin/src/waiting.ts 的 `dispatchApprovalFace` **同一份说法**(两个目录互不 import,各写一份)。
 */
export interface DispatchApprovalFace {
  headline: string;
  chosen?: ApprovalOption;
  others: readonly ApprovalOption[];
  othersLine?: string;
  yes: string;
}

export function dispatchApprovalFace(approval: PendingApprovalView): DispatchApprovalFace {
  const say = approval.say ?? approval.reason ?? approval.tool;
  const options = approval.options ?? [];
  const chosen = options.find((one) => one.chosen === true);
  if (chosen === undefined) return { headline: say, others: [], yes: '允许这一次' };
  const others = options.filter((one) => one !== chosen);
  const name = approvalOptionName(chosen);
  // 查不到卡时说「这件事」(`askSubject` 那时回的是「事务官」,放这句里就成了「把事务官派给 Claude?」)。
  const what = (approval.task_title ?? '').trim() === '' ? '这件事' : askSubject(approval.task_title, 20);
  return {
    headline: chosen.family === 'dsh' ? `把${what}交给事务官自己做?` : `把${what}派给 ${name}?`,
    chosen,
    others,
    ...(others.length === 0 ? {} : { othersLine: `其他可选:${others.map(approvalOptionName).join(' / ')}` }),
    yes: chosen.family === 'dsh' ? '允许她自己做' : `允许派给 ${name}`,
  };
}

/**
 * 首页「等你确认」里点了某一行 → 那一页**只摆那一件**(2026-09-28,卡 UX)。
 *
 * 维护者 09-28:首页第一行是「【工作台自测】让 Manus…」,点进去打开的是整列,最上面是另外两条 ——
 * 他以为眼前这张卡就是他点的那一件。现在点哪件开哪件,别的收在「还有 N 件」后面。
 * 认不到那一件(他点完在电脑上答掉了、那一问撤了)就照旧整列摆 —— **不给他一页空白**。
 */
export function focusedAskKeys(all: readonly string[], focus?: string): { shown: readonly string[]; others: number } {
  if (focus === undefined || !all.includes(focus)) return { shown: all, others: 0 };
  return { shown: [focus], others: all.length - 1 };
}

export function questionLine(question: PendingQuestionView): { id: string; text: string; note?: string } {
  const first = question.questions[0];
  const what = first?.header ?? clip((first?.question ?? '').split('\n').find((line) => line.trim() !== '') ?? '', 16);
  return { id: `question:${question.id}`, text: `${askSubject(question.task_title)}问你:${what}`, note: '要你回答' };
}

export function approvalLine(approval: PendingApprovalView): { id: string; text: string; note?: string } {
  const what = approval.say ?? approval.reason ?? approval.tool;
  return { id: `approval:${approval.id}`, text: `${askSubject(approval.task_title)}${clip(what, 18)}`, note: '要你批' };
}

/** 「等你确认」里她问你的、要你批的那几行(排在最前:那件事正卡在这儿等你)。 */
export function askLines(state: Pick<WorkbenchState, 'questions' | 'approvals'>): { id: string; text: string; note?: string }[] {
  // 事务官自己的提议(派单提议 / 进度要你说一句)不摆在「等你确认」里(2026-09-27,卡 WY)。
  // 要他批的那几条里,事务官自己提的那一条也不算(卡 UX:判据认 `proposal` 那一格)。
  return [...(state.questions ?? []).filter((question) => !isButlerProposalAsk(question.session_id)).map(questionLine), ...(state.approvals ?? []).filter((approval) => approval.proposal !== true).map(approvalLine)];
}

export function askCount(state: Pick<WorkbenchState, 'questions' | 'approvals'>): number {
  return askLines(state).length;
}

/* ─────────── 「等你」只放他不点头就卡住的事(2026-09-27,卡 WY) ─────────── */

/**
 * 维护者 2026-09-27 原话:「为什么叫等你,是因为这件事我不点头,不给反馈就卡住,而其他的事项是做完了告知我,
 * 所以本来就是只放我做判断的部分。」
 *
 * 判断在工作台(workbench-plugin/src/waiting.ts 的 `isButlerProposalAsk` / `blockingOnly`),手机只做两件事:
 *   - 老办法凑那一份时照同一条规矩筛(事务官自己的提议、「待排」卡不算);
 *   - **工作台给的那一份里要是还挂着这几种**(他机器上此刻就挂着两条「进度要你说一句」),读的时候撤掉 ——
 *     手机先于工作台升级是常事,不该要他手动清。两个仓库不互相 import,这几条按本仓库既有做法照抄一份。
 */
const BUTLER_PROPOSAL_ASK_PREFIXES = ['dispatch:', 'progress:'];

export function isButlerProposalAsk(sessionId: string | undefined): boolean {
  const id = sessionId ?? '';
  return BUTLER_PROPOSAL_ASK_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 收件箱里这一条是不是「证据里冒出来、等他点头要不要加」的那种(不是办完了等他验收的)。 */
export function isProposalConfirmItem(item: { kind: string; title?: string; status?: string }): boolean {
  if (item.kind !== 'confirm') return false;
  return item.status === 'backlog' || (item.title ?? '').startsWith('要加上吗:');
}

const STALE_WAITING_TEXTS = [/问你:进度要你说一句/, /要你批:这张派给/, /^「?要加上吗:/];

/** 工作台给的那一份里不该在的撤出来;一条都没撤就原样返回同一个对象(两端读的仍是同一份账)。 */
export function blockingOnly(view: WaitingView): WaitingView {
  const items = view.items.filter((item) => !STALE_WAITING_TEXTS.some((re) => re.test(item.text)));
  return items.length === view.items.length ? view : { count: items.length, items };
}

/**
 * 「等你」那一堆(2026-09-25,卡 M 追加;维护者硬规矩「同一件事的数字各处一致」)。
 * **工作台给了就只用它**(`state.waiting`,与电脑球下「等你 n」、「事务官」标签上的数是同一份、同一个函数算的);
 * 老工作台没给时按老办法凑一份:问你的、要你批的、等你点头的单子、办完了等你确认的(老工作台也不给手机看提议)。
 */
export function waitingPile(state: Pick<WorkbenchState, 'waiting' | 'questions' | 'approvals' | 'materialize' | 'butler_inbox'>): WaitingView {
  if (state.waiting !== undefined) return blockingOnly(state.waiting);
  const items: WaitingItemView[] = [
    ...(state.questions ?? []).filter((question) => !isButlerProposalAsk(question.session_id)).map((question): WaitingItemView => ({ key: `question:${question.id}`, kind: 'question', verb: '答', text: questionLine(question).text, ...(question.task_id === undefined ? {} : { task_id: question.task_id }) })),
    ...(state.approvals ?? []).filter((approval) => approval.proposal !== true).map((approval): WaitingItemView => ({ key: `approval:${approval.id}`, kind: 'approval', verb: '批', text: approvalLine(approval).text, ...(approval.task_id === undefined ? {} : { task_id: approval.task_id }) })),
    ...(state.materialize !== undefined && state.materialize.status === 'pending'
      ? [{ key: `laid:${state.materialize.id}`, kind: 'plan', verb: '批', text: '「我照你说的摆好了」等你点头' } satisfies WaitingItemView]
      : []),
    ...(state.butler_inbox?.items ?? []).filter((item) => item.kind === 'confirm' && !isProposalConfirmItem(item)).map((item): WaitingItemView => {
      const taskId = item.task_id ?? item.id;
      return { key: `confirm:${taskId}`, kind: 'confirm', verb: '验收', text: item.title, task_id: taskId };
    }),
  ];
  return { count: items.length, items };
}
