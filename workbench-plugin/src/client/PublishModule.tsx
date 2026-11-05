/**
 * 「发布计划」那一格**的那几份口径与零件**(2026-09-21 布局模板,运营模板横屏右侧栏)。
 *
 * ★ 2026-10-03:这一格的组件本体是**运营同学(Air)自己写的那一份**,在
 * `src/client/air/publish.js`(原件 `contrib/air-20261002/src/publish.js`)。
 * 它 import 这里的 `pad` / `WEEKDAYS` / `PUBLISH_VIEWS` / `monthCells` / `shiftMonth` /
 * `publishDayOf` / `tasksByPublishDay` / `isOverdue` —— 那几份是「一条卡摆在哪一天」
 * 这件事的读法,没有变过,也还各自带着自己那一份用例。
 *
 * ## 两个状态(2026-09-22,Ben 原话)
 *
 * > 其实是未发布和已发布的部分,我认为这是两个状态,UI 层面可以优先表现未发布的,
 * > 但是也可以回溯已发布。
 *
 * 两个视图读的是**两个不同的日期**,不是同一份数据的两种筛法:
 *
 * | 视图 | 按哪个日期摆 | 谁进得来 |
 * |---|---|---|
 * | 未发布 | `planned_at`(选题的计划发布日);没有就退回 `due`(普通事项那一个) | **没有 `published_at`** 的 |
 * | 已发布 | `published_at`(实际发布日) | 有 `published_at` 的 |
 *
 * 一条卡只会出现在其中一个视图里 —— 「发没发」本来就是二选一。
 *
 * ## 三条不许破的规矩
 *
 * 1. **不自己造数据**:格子里的条数来自 `/state.tasks.tasks`,没有就是没有(D13)。
 *    **逾期也一样**:`now` 读不出来时一天都不标逾期(宁可不说,不猜)。
 * 2. **不读时钟**:今天是哪天由 `now`(服务端快照的 ISO 时刻)给。
 * 3. **本地时区切天**:`due` 是 `YYYY-MM-DD` 的本地日期,格子的日期也必须按本地时区
 *    拼(见 client/dates.ts localDateStr 顶上那段)。
 *
 * `tasksByDue` 此刻没有消费方(她那一版不用它),留着连同它那一份用例 —— 见文件末尾那段。
 */
import type { TaskView } from '../protocol.ts'
import { PUBLISH_PLAN_SOURCE_PREFIX, publishPlanDescParts } from '../protocol.ts'

/** 月历头上那一排(周一开头)。她那一版 import 它、在前面各加一个「周」字。 */
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 一格日历。`date` 是本地日期 `YYYY-MM-DD`;`inMonth` false = 为了补满一周而露出来的邻月那几天。 */
export interface PublishCell {
  date: string
  day: number
  inMonth: boolean
}

export function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 一个月的格子,**周一开头**,前后补到整周。
 *
 * `month` 是 `YYYY-MM`。认不出的月份回空数组(不抛、不退回"这个月"——退回会让界面上
 * 显示一个跟标题对不上的月份)。
 */
export function monthCells(month: string): PublishCell[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (match === null) return []
  const year = Number(match[1])
  const mon = Number(match[2])
  if (mon < 1 || mon > 12) return []
  const first = new Date(year, mon - 1, 1)
  // JS 的 getDay():周日 = 0。我们要周一开头,所以周日算第 7 天。
  const lead = (first.getDay() + 6) % 7
  const start = new Date(year, mon - 1, 1 - lead)
  const cells: PublishCell[] = []
  for (let i = 0; i < 42; i++) {
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    cells.push({
      date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      day: at.getDate(),
      inMonth: at.getMonth() === mon - 1 && at.getFullYear() === year,
    })
    // 补满最后一整周就停:6 行是上限(一个月最多跨 6 周),但大多数月份 5 行就够,
    // 多画一行空的会把这一格撑矮。
    if (i >= 27 && (i + 1) % 7 === 0 && cells[cells.length - 1]?.inMonth === false) {
      const nextStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i + 1)
      if (nextStart.getMonth() !== mon - 1) break
    }
  }
  return cells
}

/** 往前 / 往后翻一个月。`YYYY-MM` 进,`YYYY-MM` 出;认不出原样返回。 */
export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (match === null) return month
  const at = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`
}

/**
 * 月历的两个状态(2026-09-22)。**未发布在前**:Ben 定的「UI 层面可以优先表现未发布的」。
 */
export const PUBLISH_VIEWS = ['未发布', '已发布'] as const

export type PublishView = typeof PUBLISH_VIEWS[number]

/**
 * 这条卡在这个视图里摆在哪一天(`YYYY-MM-DD`);哪天都不摆就回 undefined。
 *
 * - 取消掉的两个视图都不进 —— 它已经不是一条计划了(与 `tasksByDue` 同一条老规矩);
 * - **未发布**:有 `published_at` 的一律不进(它已经发了);日期取 `planned_at`,
 *   没有才退回 `due`。退回这一步是**故意留的**:运营模板上一版建出来的那些带 `due`
 *   的事项还在盘上,不退回的话它们会从月历上整片消失。
 * - **已发布**:只认 `published_at`,没有的一条都不进 —— 拿计划日冒充"发出去了"是编的(D13)。
 */
export function publishDayOf(task: TaskView, view: PublishView): string | undefined {
  if (task.status === 'canceled') return undefined
  const published = task.published_at === undefined || task.published_at === '' ? undefined : task.published_at
  if (view === '已发布') return published?.slice(0, 10)
  if (published !== undefined) return undefined
  const planned = task.planned_at === undefined || task.planned_at === '' ? undefined : task.planned_at
  const fallback = task.due === undefined || task.due === '' ? undefined : task.due
  return (planned ?? fallback)?.slice(0, 10)
}

/** 这份事项在这个视图里每天各有几件(键是 `YYYY-MM-DD`)。顺序即原顺序。 */
export function tasksByPublishDay(tasks: readonly TaskView[], view: PublishView): Map<string, TaskView[]> {
  const map = new Map<string, TaskView[]>()
  for (const task of tasks) {
    const day = publishDayOf(task, view)
    if (day === undefined) continue
    const list = map.get(day)
    if (list === undefined) map.set(day, [task])
    else list.push(task)
  }
  return map
}

/**
 * 这一天算不算逾期:**今天之前**就算(今天不算 —— 今天还没过完)。
 *
 * 按 `YYYY-MM-DD` 逐位比大小,不解析成 Date:字符串比较对这个格式天然是日期序,
 * 而 `new Date('2026-09-20')` 是 UTC 午夜,在东八区又会把日子挪回去一天。
 * `today` 读不出来时**一律回 false**:不知道今天是哪天就不标,不猜(D13)。
 */
export function isOverdue(day: string, today: string | undefined): boolean {
  if (today === undefined || today === '') return false
  return day < today
}

/**
 * ——— 悬浮上去看到的那几行(2026-10-13,卡「座机一句话记发布计划」)———
 *
 * 维护者 10-12 晚:「悬浮上去就能看到相关内容」。四样:标题、是什么(内容形式 / 账号 / 发没发)、
 * 她说的原话、这条是从哪儿交代的。
 *
 * **一条都不编**(D13):卡上没有的那一样整行不出现 —— 她手填的那几条没有原话与来源,
 * 悬浮上去就只有标题与那一行「是什么」。原话与来源怎么存在 `protocol.ts`
 * (`publishPlanDescOf` / `publishPlanDescParts`,写在服务端、读在这里,只认那一个记号)。
 */
export interface PublishHoverView {
  title: string
  /** 「视频 · 露营账号 · 待发布」。至少有一截(发没发总说得出来)。 */
  meta: string
  /** 她那句原话 / 卡上的备注。 */
  said?: string
  /** 「电话 10-13 19:30」。 */
  source?: string
}

export function publishHoverOf(task: TaskView, input: { account?: string } = {}): PublishHoverView {
  const parts = publishPlanDescParts(task.desc)
  const published = task.published_at === undefined || task.published_at === '' ? undefined : task.published_at.slice(0, 10)
  const planned = task.planned_at === undefined || task.planned_at === '' ? task.due : task.planned_at
  const meta = [
    task.content_type,
    input.account,
    published === undefined ? (planned === undefined ? '待发布' : `待发布 ${planned}`) : `已发布 ${published}`,
  ].filter((one): one is string => one !== undefined && one !== '')
  return {
    title: task.title,
    meta: meta.join(' · '),
    ...(parts.said === undefined ? {} : { said: parts.said }),
    ...(parts.source === undefined ? {} : { source: parts.source }),
  }
}

/** 悬浮那一块的纯文本(也就是 `title=` 那个原生提示里的内容:键盘与读屏靠它)。 */
export function publishHoverText(view: PublishHoverView): string {
  return [view.title, view.meta, view.said, view.source === undefined ? undefined : `${PUBLISH_PLAN_SOURCE_PREFIX}${view.source}`]
    .filter((one): one is string => one !== undefined && one !== '')
    .join('\n')
}

/**
 * 这份事项里,每天各有几件(键是 `YYYY-MM-DD`)。没有 `due` 的不算。
 *
 * **这一份是上一版那个按 `due` 的读法,一个字没改**:月历现在走 `tasksByPublishDay`,
 * 但「一件普通事项的 due 落在哪一天」这条约定没有变过,它那份用例照旧守着。
 */
export function tasksByDue(tasks: readonly TaskView[]): Map<string, TaskView[]> {
  const map = new Map<string, TaskView[]>()
  for (const task of tasks) {
    if (task.due === undefined || task.due === '') continue
    if (task.status === 'canceled') continue
    const day = task.due.slice(0, 10)
    const list = map.get(day)
    if (list === undefined) map.set(day, [task])
    else list.push(task)
  }
  return map
}
