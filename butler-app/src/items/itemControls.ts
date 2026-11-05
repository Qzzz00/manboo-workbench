/**
 * 事项详情里「派活的眼睛」那几样的判据(2026-09-25,卡 O)。
 * **与电脑那份 workbench-plugin/src/client/itemControlsModel.ts 逐字同一套**(两边构建独立,前端不跨包 import)。
 */
import type { SessionView, TaskBudgetView, TaskView } from '../api/protocol';
import { ASSIGNEE_NAMES } from '../api/protocol';

export function yuanText(value: number): string {
  return value < 0.01 && value > 0 ? '不到 0.01' : value.toFixed(2);
}

/** 「花了约 0.14 元 · 跑了 3 分钟(上限 0.5 元 / 10 分钟)」。 */
export function budgetLine(view: TaskBudgetView): string {
  if (view.cli_family !== undefined) {
    // ★ 与电脑那份同源(2026-10-22,卡「契约对照测试补齐」):人名用静态那张表 —— 表里有就念正名;
    // 表里没有(运行时新登记的家,包标识 / agent 名片的家)原样念家名,不念 undefined。原来这里调
    // agentTitle 不带 state,落到原样家名(「豆包办公」被念成「doubao」),已对齐;兜底是 2026-10-22
    // 统筹验收补的(对照见 `tests/item-controls-sync.test.ts`)。
    const who = ASSIGNEE_NAMES[view.cli_family] ?? view.cli_family;
    const ran = view.run_minutes === undefined ? `${who} 在后台做` : `${who} 在后台做了 ${Math.floor(view.run_minutes)} 分钟`;
    return `${ran}(上限 ${view.limit_minutes} 分钟;花的是 ${who} 自己的额度,这里只管时间)`;
  }
  const parts = [
    view.spent_cny === undefined ? '' : `花了约 ${yuanText(view.spent_cny)} 元`,
    view.run_minutes === undefined ? '' : `跑了 ${Math.floor(view.run_minutes)} 分钟`,
  ].filter((one) => one !== '');
  const head = parts.length === 0 ? '还没算出花了多少' : parts.join(' · ');
  return `${head}(上限 ${view.limit_cny} 元 / ${view.limit_minutes} 分钟)`;
}

/** 这件事此刻有没有在跑的可停(事务官那条会话 / 命令行进程 / 窗口里还在等回答)。 */
export function stoppable(task: TaskView, sessions: readonly SessionView[]): boolean {
  if (task.status === 'done' || task.status === 'canceled') return false;
  if (task.budget?.state === 'paused') return false;
  const conversation = task.conversation;
  if (conversation !== undefined) {
    const session = sessions.find((one) => one.agent === 'dsh' && one.session_id === conversation.session_id);
    if (session !== undefined && (session.status === 'running' || session.status === 'waiting')) return true;
  }
  if (task.dispatch?.status === 'running' && task.dispatch.hand === 'cli') return true;
  return task.client_dispatch?.reply_state === 'waiting';
}

/**
 * 派不出去那一句(与电脑那份 `blockLine` 同一套):卡上的备注已经说了为什么就不再念一遍,
 * 手机上只补修法在哪 ——「要在电脑前点『登录 Claude』」。
 *
 * ★ 2026-10-22(卡「契约对照测试补齐」)对齐成**电脑那份带 desk=false 的写法**:手机永远不在电脑前,
 * 所以只有 `desk_only` 的修法才补「要在电脑前点…」,其余只念 why —— 原来会把非 desk_only 的
 * fix.label 也接在 why 后面(电脑那份不会),已收成一样(对照见 `tests/item-controls-sync.test.ts`)。
 */
export function blockLine(task: TaskView): string | undefined {
  const block = task.dispatch_block;
  if (block === undefined) return undefined;
  const fix = block.fix;
  const where = fix !== undefined && fix.desk_only === true ? `要在电脑前点「${fix.label}」` : '';
  if ((task.note ?? '').includes(block.why)) return where === '' ? undefined : where;
  return where === '' ? block.why : `${block.why}(${where})`;
}

/** 到上限那一句:卡上的备注就是这一句时不再念一遍。 */
export function pausedLine(task: TaskView): string | undefined {
  const note = task.budget?.state === 'paused' ? task.budget.note : undefined;
  return note === undefined || note === task.note ? undefined : note;
}
