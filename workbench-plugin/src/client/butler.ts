/**
 * 事务官浮窗的结论(spec D11:跨区结论)。
 *
 * 事务官不是又一个数据源——它只读别的区域已经算好的东西(项目区的 DDL/停摆天数、
 * 会话区的等待时长、机器信号)，挑出"值得单独说一句"的那几条，按优先级排出主文案。
 * 纯函数，不碰 DOM、不发请求，方便单测；Butler.tsx 只管把结果渲染出来。
 */
import type { WorkbenchState } from '../protocol.ts'
import { RING_AFTER_SEC } from '../protocol.ts'
import { daysLeftFromNow } from './dates.ts'
import { approvalRowText, notifyTrouble, questionRowText } from './askModel.ts'

const AGENT_LABEL: Record<string, string> = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

/** YYYY-MM-DD → M-D。解析不了就原样回,不编。 */
function monthDay(dateOnly: string): string {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(dateOnly) ?? []
  return month === undefined || day === undefined ? dateOnly : `${Number(month)}-${Number(day)}`
}

/**
 * 四条规则,按优先级从高到低依次判定、依次追加进结论列表——多条命中时数组顺序
 * 本身就是优先级序,调用方只要取第一条当主文案即可,不必再额外排序。
 *
 * ① 项目有 DDL 且明天/今天就要交付,但已经停摆好几天——最容易被忽略的"要出事"信号。
 * ② 排期风险变成「赶不上」(2026-09-09)——服务端算好的那一份,事务官只转述,不自己再算一遍。
 *    **只在「赶不上」时开口**:宽裕/紧/无法判断都不是要出事,天天念一遍就成了噪音。
 * ③ 有会话等你确认超过响铃阈值——响铃可能被静音错过,事务官再提一句。
 * ④ 磁盘快满了——机器信号里最容易拖垮一切的一条。
 *
 * ⓪(2026-09-25,卡 M)排在最前:事务官在会话里问他的话、要他批的事 —— 那件事正停着等他,
 *    比什么都急。以前这里对它一个字不说(真机上浮窗写着「一切正常」,球下却有一张要他批的卡)。
 */
export function butlerConclusions(state: WorkbenchState, nowSec: number): string[] {
  const trouble = notifyTrouble(state.helper)
  const conclusions: string[] = [
    ...(state.questions ?? []).map(questionRowText),
    ...(state.approvals ?? []).map(approvalRowText),
    // 系统通知出了问题(卡 M 补):以前静默失败,他以为工作台不会提醒。
    ...(trouble === undefined ? [] : [trouble.text]),
  ]

  if (state.projects !== undefined) {
    for (const project of state.projects.projects) {
      if (project.ddl === undefined || project.signals === undefined) continue
      const left = daysLeftFromNow(project.ddl.date, nowSec)
      const idleDays = project.signals.idle_days
      if (left <= 1 && idleDays >= 3) {
        const when = left <= 0 ? '今天' : '明天'
        conclusions.push(`${project.name} ${when}交付，但已停 ${idleDays} 天`)
      }
    }
  }

  if (state.projects !== undefined) {
    for (const project of state.projects.projects) {
      if (project.risk?.level !== 'late') continue
      const when = project.ddl === undefined ? '' : ` ${monthDay(project.ddl.date)}`
      const eta = project.risk.eta === undefined ? '' : `,预计 ${monthDay(project.risk.eta)} 才做完`
      conclusions.push(`${project.name} 按当前速度赶不上${when}${eta}`)
    }
  }

  for (const session of state.sessions) {
    if (session.status !== 'waiting') continue
    // 排期风险那条会话是**投影**,不是真有人在等回话:说成"等你 N 分了"就是句假话。
    // 它该说的那句已经由上面规则②按项目行说过了(会话本身只负责在会话流里留个黄点)。
    if (session.session_id.startsWith('schedule:')) continue
    if (session.elapsed_sec < RING_AFTER_SEC) continue
    const minutes = Math.floor(session.elapsed_sec / 60)
    conclusions.push(`${AGENT_LABEL[session.agent] ?? session.agent} 等你 ${minutes} 分了`)
  }

  if (state.machine !== undefined && !('error' in state.machine) && state.machine.disk_pct >= 95) {
    conclusions.push(`磁盘只剩 ${Math.round(state.machine.disk_free_gb)} G`)
  }

  return conclusions
}
