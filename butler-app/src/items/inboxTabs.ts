/**
 * 事项页的四个标签,以及搬出事项页的那几样各去哪(2026-10-01,梳理与拍板见 docs/梳理-1001-手机事项页.md)。
 *
 * 一页只干一件事:事项页只放「事」——
 *   在办 = AI 与事务官手上的(各家正在跑的会话在页面里另算,摆在同一个标签最上面);
 *   等你 = 收件箱里要她拍板的;排着 = 你来的 + 等别人的;办完 = 真正办完 / 取消的事。
 * 不是「事」的搬出去:例程汇报 → 汇报页;资讯搜索结果(收件箱 `feed`)→ 只在资讯页;
 * 通话纪要 → 通话记录页;各家历史对话 → 各家对话页;测试单子哪儿都不摆(设置 › 高级里删)。
 * 这个文件是纯的(不认 React)。
 */
import { taskOriginOf, type ButlerInboxItem, type TaskView, type WorkbenchState } from '../api/protocol';
import { clockOf, type NowRef } from '../clock';
import { inboxItemCard, moverGroups, type ItemCard } from './itemsModel';

export type InboxTab = 'doing' | 'waiting' | 'queued' | 'done';

export const INBOX_TABS: readonly { key: InboxTab; label: string }[] = [
  { key: 'doing', label: '在办' },
  { key: 'waiting', label: '等你' },
  { key: 'queued', label: '排着' },
  { key: 'done', label: '办完' },
];

/** 收件箱里不算「事」的几档:例程汇报(开工 / 下班 / 知识 lint)、资讯搜索结果、剩余额度告警、额度活用建议。
 * 额度告警(2026-10-23,卡 t-8e617888)维护者拍板「工作台消息即可」:电脑收件箱里看得见,
 * 手机这一页不摆(不推送、不来电,也不占「等你」一格)。
 * 额度活用建议(2026-10-28,卡 t-f68365f6)同一纪律:只是工作台消息,手机上不摆。 */
const NOT_ITEMS: ReadonlySet<string> = new Set(['routine', 'feed', 'quota', 'spend']);

/**
 * 测试单子:我们测派活、测提问弹窗时建的那些(标题带 `[派活测试]` `[统筹自测…]` `[测试·…]` `【工作台自测】`)。
 * 看板上没有别的标记能认它们,只能认标题;前缀要带括号与这几个词,她自己写的「测试一下…」不算。
 */
const TEST_PREFIX = /^\s*[[【]\s*(派活测试|工作台自测|统筹自测[^\]】]*|测试(?:[·・:][^\]】]*)?)\s*[\]】]/;

export function isTestTicket(title: string): boolean {
  return TEST_PREFIX.test(title);
}

function isCallTask(task: TaskView): boolean {
  return taskOriginOf(task) === 'call';
}

export interface InboxBuckets {
  doing: TaskView[];
  waiting: ItemCard[];
  queued: TaskView[];
  done: TaskView[];
}

export function inboxBuckets(state: WorkbenchState): InboxBuckets {
  const lower = moverGroups(state);
  const real = (t: TaskView): boolean => !isTestTicket(t.title) && !isCallTask(t);
  return {
    doing: lower.agents.filter(real),
    waiting: (state.butler_inbox?.items ?? []).filter((i) => !NOT_ITEMS.has(i.kind)).map(inboxItemCard),
    queued: [...lower.me, ...lower.others].filter(real),
    done: lower.finished.filter(real),
  };
}

/** 汇报页:收件箱里的例程汇报(开工汇报、下班例程、每周知识 lint),原样。 */
export function reportItems(state: WorkbenchState): ButlerInboxItem[] {
  return (state.butler_inbox?.items ?? []).filter((i) => i.kind === 'routine');
}

/** 通话记录页:通话纪要卡,新的在前。 */
export function callTasks(state: WorkbenchState): TaskView[] {
  return (state.tasks?.tasks ?? []).filter(isCallTask).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** 设置 › 高级 里删的那一摞:看板上所有测试单子。 */
export function testTickets(state: WorkbenchState): TaskView[] {
  return (state.tasks?.tasks ?? []).filter((t) => isTestTicket(t.title));
}

function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/**
 * 办完按天分组:今天 / 昨天 / M-D;组内新的在前。读不出时间的归「更早」。
 *
 * 「今天」照谁的钟算:**电脑的**(`/state.now`),与卡上那句「今天 20:17」(`friendlyWhen`)、
 * 卡上那个时刻(`formatClock`)同一个口径。参考时刻那一条规矩只有一个主人:{@link clockOf}
 * (2026-10-02 从这里提到 src/clock.ts,行为一个字没变)。
 */
export function doneByDay(tasks: readonly TaskView[], now?: NowRef): { label: string; tasks: TaskView[] }[] {
  const ref = clockOf(now);
  const today = dayKey(ref);
  const yesterday = dayKey(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1));
  const order: string[] = [];
  const groups = new Map<string, { label: string; tasks: TaskView[] }>();
  const sorted = [...tasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  for (const task of sorted) {
    const at = new Date(task.updated_at);
    const valid = !Number.isNaN(at.getTime());
    const key = valid ? dayKey(at) : 'earlier';
    const label = !valid ? '更早' : key === today ? '今天' : key === yesterday ? '昨天' : `${at.getMonth() + 1}-${at.getDate()}`;
    if (!groups.has(key)) { order.push(key); groups.set(key, { label, tasks: [] }); }
    groups.get(key)!.tasks.push(task);
  }
  return order.map((k) => groups.get(k)!);
}
