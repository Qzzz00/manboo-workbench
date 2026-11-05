/**
 * 外层那件事的卡上「派活的眼睛」那几样(2026-09-25,卡 O):花了多少 / 上限多少、「停掉这一件」、
 * 到上限了的三颗键、派不出去时的修法与换一家。**纯函数**,电脑事务官页那张卡与看板共用;
 * 手机那份(butler-app `items/itemControls.ts`)逐字同一套判据(两边构建独立,前端不跨包 import)。
 */
import type { CapCell, CapCellView, SessionView, TaskBudgetView, TaskView } from '../protocol.ts'
import { CAP_CELL_TITLES, DISPATCH_FAMILY_TITLES } from '../protocol.ts'

/** 给人看的钱:到分。 */
export function yuanText(value: number): string {
  return value < 0.01 && value > 0 ? '不到 0.01' : value.toFixed(2)
}

/** 「花了约 0.14 元 · 跑了 3 分钟(上限 0.5 元 / 10 分钟)」;命令行那种只说时间(花的是那家自己的额度)。 */
export function budgetLine(view: TaskBudgetView): string {
  if (view.cli_family !== undefined) {
    const who = DISPATCH_FAMILY_TITLES[view.cli_family] ?? view.cli_family
    const ran = view.run_minutes === undefined ? `${who} 在后台做` : `${who} 在后台做了 ${Math.floor(view.run_minutes)} 分钟`
    return `${ran}(上限 ${view.limit_minutes} 分钟;花的是 ${who} 自己的额度,这里只管时间)`
  }
  const parts = [
    view.spent_cny === undefined ? '' : `花了约 ${yuanText(view.spent_cny)} 元`,
    view.run_minutes === undefined ? '' : `跑了 ${Math.floor(view.run_minutes)} 分钟`,
  ].filter(one => one !== '')
  const head = parts.length === 0 ? '还没算出花了多少' : parts.join(' · ')
  return `${head}(上限 ${view.limit_cny} 元 / ${view.limit_minutes} 分钟)`
}

/**
 * 这件事此刻有没有**在跑的**可停:事务官那条会话在跑 / 派给别家命令行的进程在跑 / 派进窗口还在等回答。
 * 办完 / 取消了的不画;到上限已经停下来的(paused)也不画这一颗(那时画三颗键)。
 */
export function stoppable(task: TaskView, sessions: readonly SessionView[]): boolean {
  if (task.status === 'done' || task.status === 'canceled') return false
  if (task.budget?.state === 'paused') return false
  const conversation = task.conversation
  if (conversation !== undefined) {
    const session = sessions.find(one => one.agent === 'dsh' && one.session_id === conversation.session_id)
    if (session !== undefined && (session.status === 'running' || session.status === 'waiting')) return true
  }
  if (task.dispatch?.status === 'running' && task.dispatch.hand === 'cli') return true
  return task.client_dispatch?.reply_state === 'waiting'
}

/**
 * 派不出去那一句。**卡上的备注已经说了为什么**(派活那一层写的「没派给 Claude:……」)就不再念一遍,
 * 只在不在电脑前时补一句修法在哪(「要在电脑前点『登录 Claude』」)。
 */
export function blockLine(task: TaskView, desk: boolean): string | undefined {
  const block = task.dispatch_block
  if (block === undefined) return undefined
  const fix = block.fix
  const where = fix !== undefined && !desk && fix.desk_only === true ? `要在电脑前点「${fix.label}」` : ''
  if ((task.note ?? '').includes(block.why)) return where === '' ? undefined : where
  return where === '' ? block.why : `${block.why}(${where})`
}

/** 到上限那一句。卡上的备注就是这一句(到上限时两处写的同一句)就不再念一遍。 */
export function pausedLine(task: TaskView): string | undefined {
  const note = task.budget?.state === 'paused' ? task.budget.note : undefined
  return note === undefined || note === task.note ? undefined : note
}

/** 体检一格的符号(不靠颜色也读得出)。 */
export function capMark(cell: Pick<CapCellView, 'state'>): string {
  if (cell.state === 'ok') return '行'
  if (cell.state === 'no') return '不行'
  if (cell.state === 'na') return '没有'
  return '没查到'
}

export function capCellTitle(cell: CapCell): string {
  return CAP_CELL_TITLES[cell]
}

/** 「几点查的」:12:03。 */
export function clockOf(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
