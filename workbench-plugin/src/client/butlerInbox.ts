/**
 * 事项收件箱的两个纯函数(2026-09-10):顶上那条**代码生成**的汇报条,
 * 与下半区「我交给事务官的」怎么分组。
 *
 * 为什么汇报条必须是代码生成的(docs/设计-事务官的主动性.md §三):它是"事务官开口说的第一句",
 * 每次打开事务官页都会看见——**一句编出来的话在这个位置会被当成事实**。所以它只做一件事:
 * 把 /state 里已经算好的几个数原样念出来,不经模型、不加形容词、算不出的那段整段不说。
 *
 * 组件只管渲染,判断全在这里,这样"汇报条说了什么"是可单测的(先例:client/butler.ts 的结论)。
 */
import type { ButlerInboxItem, TaskView, TasksState, WorkbenchState } from '../protocol.ts'
import { waitingOf } from '../waiting.ts'
import { isTrackedItem } from '../protocol.ts'

/** 分段之间的分隔符。用「·」不用逗号:这几段是并列的数,不是一句话。 */
const JOIN = ' · '

function hhmm(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 汇报条那一句。
 *
 * 四段,口径写死:
 * - **运行会话 N 个**:此刻「执行中」的事项数——`executing` 由调用方从 butlerSceneModel 的 `running`
 *   传进来,**与球下「执行 N」是同一个数**(2026-09-16 口径统一:真机上曾出现顶栏「运行会话 3 个」
 *   而球下「执行 0」——这一条原来自己数 status=running 的会话,四家一起数,连没挂在事项上的都算)。
 *   口径定义在 protocol.ts 的 isItemExecuting。取不到(任务板没接 / 快照冻结)时**整段不说**,不写 0。
 * - **等你 N 件**:「等你」那一堆(src/waiting.ts:要他答的、要他批的、要他验收的)。2026-09-25(卡 M 追加)以前这里只数
 *   待确认的、写「等我确认 N 件」—— 手机「等你确认」、球下「等你 n」数的是整堆,同一刻两个数;维护者硬规矩「同一件事的数字各处一致」。
 * - **哨兵最近一次**:最新命中的那条,带时刻与它自己那句话;一条监视项都没有时**整段不说**
 *   (说"哨兵没动静"会让人以为在盯着);在盯但没命中过时说「还没动静」。
 * - **排期赶不上 N 项**:0 项时整段不说——"赶不上 0 项"是句废话,占着一行还容易读成"有事"。
 */
export function butlerReportLine(state: WorkbenchState, executing: number | undefined): string {
  const items = state.butler_inbox?.items ?? []
  const late = items.filter(item => item.kind === 'risk').length

  const parts = [...(executing === undefined ? [] : [`业务任务执行 ${executing} 件`]), `等你 ${waitingOf(state).count} 件`]

  const watches = state.sentinel?.watches ?? []
  if (watches.length > 0) {
    const latest = items.find(item => item.kind === 'sentinel')
    const at = latest?.at === undefined ? '' : hhmm(latest.at)
    parts.push(latest === undefined
      ? '哨兵还没动静'
      : `哨兵最近一次${at === '' ? '' : ` ${at}`}「${latest.title}」`)
  }

  if (late > 0) parts.push(`排期赶不上 ${late} 项`)

  return parts.join(JOIN)
}

/**
 * 球下那一句「此刻在干嘛」(2026-09-25,卡 M 补;统筹真壳:「她在等他答时,球下还写『文字输入中』」)。
 *
 * 她停下来等他 —— 问了他一句、要他批一件事 —— 时**先说这个**:那一刻最要紧的是他要做什么,
 * 不是他手上在打字、也不是「正在执行」(那件事其实停着)。问的排在批的前面(批的那条她还能换个办法)。
 * 手机首页字幕同一个口径(butler-app/src/chat/chatModel.ts 的 replyOf)。
 */
export function orbStatusLine(input: {
  /** 外观预览时那一格(预览优先,那是他此刻在看的)。 */
  preview?: string | undefined
  /** 在等他回答的几问 / 等他批的几条(`state.questions` / `state.approvals`)。 */
  questions: number
  approvals: number
  /** 他在输入框里打字(或草稿没清)。 */
  typing: boolean
  /** 点开的那一件正在执行。 */
  focusRunning: boolean
  /** 执行中的事项数(取不到就缺席)。 */
  running: number | undefined
  /** 总数缺席时，公共事实仍已确认的在办业务数。 */
  observedRunning?: number | undefined
}): string {
  if (input.preview !== undefined) return input.preview
  if (input.questions > 0) return '等你回答'
  if (input.approvals > 0) return '等你批一件事'
  if (input.typing) return '文字输入中'
  if (input.focusRunning) return '正在执行当前事项'
  if ((input.running ?? 0) > 0) return `正在执行 ${input.running} 件`
  if (input.running === undefined && (input.observedRunning ?? 0) > 0) return '有业务任务正在执行 · 总数未知'
  return '我在。'
}

/** 下半区的两摞。 */
export interface MineGroups {
  /** 在办:待排/待办/进行中/阻塞。 */
  open: readonly TaskView[]
  /** 办完:完成/取消(取消也是"这条事项结束了",不是删掉)。 */
  finished: readonly TaskView[]
}

/**
 * 「我交给事务官的」怎么分组。
 *
 * **「等我确认」的那几条不在这里出现**:它们已经升到上半区了(事务官在找我)。同一条事项
 * 同时出现在上下两半,读的人得自己判断是不是同一件事——那正是收件箱要替他省掉的活。
 *
 * 排序:各自按最后一次改动从新到旧。办完的那摞不截断——截断等于替他决定哪几条不用看了。
 *
 * 2026-09-25(卡 N,一件事一份):数的是**事项**(isTrackedItem)—— 他交给事务官的,加上看板上写了负责人的那些。
 * 事项与看板卡是同一份数据的两种排法,看板上写着「Claude」的那张在这里也看得见。
 */
export function mineGroups(tasks: TasksState | undefined): MineGroups {
  const mine = (tasks?.tasks ?? []).filter(isTrackedItem)
  const byRecent = (a: TaskView, b: TaskView): number => b.updated_at.localeCompare(a.updated_at)
  return {
    open: mine.filter(task => task.status !== 'confirm' && task.status !== 'done' && task.status !== 'canceled')
      .sort(byRecent),
    finished: mine.filter(task => task.status === 'done' || task.status === 'canceled').sort(byRecent),
  }
}

/**
 * 一条「事务官交给我」点得开吗。点不开的不画成按钮——一个点了没反应的条目比不给点更糟
 * (哨兵那一档就是:它那条"会话"是投影,DSH 里根本没有)。
 */
export function itemSessionId(item: ButlerInboxItem): string | undefined {
  return item.conversation?.session_id
}
