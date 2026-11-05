/**
 * 自媒体布局「消耗数据」那一格上面那张 **Codex 剩余额度** 卡的取数(2026-10-04 合入运营同学那一版)。
 *
 * 维护者 10-04 拍板时点名的三条,全在这个文件里:
 *
 * 1. **优先 5 小时窗口,另列一周窗口** —— Codex 的窗口标签由 `src/quota/codex.ts` 的 `windowLabel`
 *    拼出来,就是 `5h` 与 `周`(别家窗口的写法不一样,所以下面认的是一组写法,不是一个字符串);
 * 2. **数只从现成那两格来**:`/state.quota.codex`(`kind:'quota'` 的 `windows`)与
 *    `/state.agent_quota` 里 codex 那一格(`state:'numbers'` 时的 `windows`)。
 *    两格都取不到就**照实说「暂未读取」**;
 * 3. **不推算** —— 这张卡上一个数都不从 token 用量折算出来。取不到就是缺席(D13:
 *    取不到就缺席,不编一个数)。
 *
 * ## 2026-10-12:两个来源**按窗口合并**,不再「任一来源有值就整组覆盖」(他 10-09 修的,卡 `claude/ops-patch-1012`)
 *
 * Codex 偶尔先回周额度、稍后才回 5h:`/state.quota.codex` 里只有「周」那一扇时,老逻辑拿它整组顶掉
 * `/state.agent_quota` 那一份,里面仍有效的「5h」就丢了;更糟的是「认不出 5h 就退回第一扇」把「周」摆到
 * 5 小时那个位置。现在按「5h / 周」各认各的:同一扇两边都有时以 `/state.quota` 那一份为准(采集层原样的数);
 * 只有「周」时 5 小时那一行缺席、大字写 {@link CODEX_QUOTA_FIVE_PENDING}。退回第一扇只在两扇都认不出时才做。
 *
 * 取数与画面分开的理由:`air/usage.js` 是运营同学交来的原件(`contrib/air-20261002/`,只读),
 * 那边的规矩是「布局、文案、CSS 一个字不动,只换数据来源」。判据写在这里才测得到。
 */
import type { AgentQuotaView, QuotaEntry } from '../protocol.ts'

/** 卡上一条横条要的三样。 */
export interface CodexQuotaBar {
  label: string
  /** 剩余百分比,夹到 0–100 的整数(条的宽度直接用它)。 */
  leftPct: number
  resetAt?: string
}

export interface CodexQuotaView {
  /** 5 小时那一扇(两扇都认不出写法时退回**第一扇**:总比一张空卡实在)。 */
  five?: CodexQuotaBar
  /** 一周那一扇。与 `five` 是同一扇时不重复列。 */
  weekly?: CodexQuotaBar
  /** 5 小时那一扇没有时,卡上大字那一处写什么(「暂未读取」/「等 5h 那一扇」/ 那一家自己给的短句)。 */
  head: string
  /** 一个数都没有时,下面那句话(那一家自己说的原因优先)。 */
  why: string
}

/** 「暂未读取」那四个字只在这里写一次(断言也引它,不逐字抄中文)。 */
export const CODEX_QUOTA_UNREAD = '暂未读取'
/** 只读到了「周」那一扇、5 小时那一扇还没回来时,大字写的那一句。 */
export const CODEX_QUOTA_FIVE_PENDING = '等 5h 那一扇'

const FIVE_HOUR = /(^|[^0-9])5\s*(小时|h)/i
const WEEKLY = /(周|week|7\s*天)/i

function barOf(window: { label: string, left_pct: number, reset_at?: string }): CodexQuotaBar {
  return {
    label: window.label,
    leftPct: Math.max(0, Math.min(100, Math.round(window.left_pct))),
    ...(window.reset_at === undefined ? {} : { resetAt: window.reset_at }),
  }
}

/** 这一扇是哪一扇:`5h` / `week` / 认不出就按标签原样当一扇。 */
function windowKeyOf(label: string): string {
  if (FIVE_HOUR.test(label)) return '5h'
  if (WEEKLY.test(label)) return 'week'
  return `other:${label.trim().toLowerCase()}`
}

/**
 * 这张卡此刻该画什么。`quota` 是 `/state.quota`,`agentQuota` 是 `/state.agent_quota` ——
 * 两样都可能整块缺席(展示台、手机、一大批用例),缺席就是「暂未读取」。
 */
export function codexQuotaOf(
  quota: Partial<Record<string, QuotaEntry>> | undefined,
  agentQuota: readonly AgentQuotaView[] | undefined,
): CodexQuotaView {
  const entry = quota?.codex
  const view = agentQuota?.find(one => one.id === 'codex')
  const raw = entry?.kind === 'quota' ? entry.windows ?? [] : []
  const fromView = view?.state === 'numbers' ? view.windows ?? [] : []
  // 按扇合并:agent_quota 那一份先放、/state.quota 那一份后放 —— 同一扇以后者(采集层原样的数)为准。
  const byWindow = new Map<string, CodexQuotaBar>()
  for (const one of [...fromView, ...raw]) byWindow.set(windowKeyOf(one.label), barOf(one))
  const windows = [...byWindow.values()]
  const weekly = byWindow.get('week')
  // 5 小时那一扇:认得出就是它;两扇都认不出时才退回第一扇(「周」认得出,不会被当成 5h)。
  const five = byWindow.get('5h') ?? (weekly === undefined ? windows[0] : undefined)
  const head = five !== undefined
    ? `${five.leftPct}%`
    : weekly !== undefined ? CODEX_QUOTA_FIVE_PENDING : view?.short ?? CODEX_QUOTA_UNREAD
  return {
    ...(five === undefined ? {} : { five }),
    ...(weekly === undefined || weekly === five ? {} : { weekly }),
    head,
    why: view?.why ?? `Codex 额度${CODEX_QUOTA_UNREAD}。`,
  }
}
