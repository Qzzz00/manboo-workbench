/**
 * 手机才显示的那几格,从哪一版手机包起才有(2026-10-09,卡「四件小事」第 1 件)。
 *
 * 工作台常比手机包新(不是每一版都重打手机包),老手机包收不到这几格时她看不出缺了什么。
 * 这张表随 `/state.phone_cells` 发给手机;手机拿自己装的版本比,落后于任何一格、
 * 而且电脑上那份手机包比它新时,首页说「电脑上的事务官更新了,手机端也更新一下」并一键更新。
 *
 * **加一格只有手机显示的东西,就在这里加一行**,`since` 写那一版插件号(手机包版本就是插件版本)。
 * 起始版本按发版记录:要文件 0.4.95、答案来找她 0.4.98、它学到了什么与会议待传箱 0.4.110、会前画像与新学到一条的提醒 0.4.111、今天的待办 0.4.113、今天的待办两种显示 0.4.114(10-12 写的是下一版号,统筹发版若不是这一版请改)。
 */
import type { PhoneCellView } from './protocol.ts'

export const PHONE_CELLS: readonly PhoneCellView[] = [
  { cell: 'file_offers', title: '手机要文件', since: '0.4.95' },
  { cell: 'answers', title: '答案来找她', since: '0.4.98' },
  { cell: 'habits', title: '它学到了什么', since: '0.4.110' },
  { cell: 'meeting_outbox', title: '会议待传箱', since: '0.4.110' },
  { cell: 'meeting_prep', title: '会前画像与预案卡', since: '0.4.111' },
  { cell: 'habit_notice', title: '新学到一条的提醒', since: '0.4.111' },
  { cell: 'today_todos', title: '今天的待办', since: '0.4.113' },
  { cell: 'today_view', title: '今天的待办两种显示', since: '0.4.115' },
]
