/**
 * **替她批准:弹窗上哪几颗键给她按**(2026-10-01,卡 AP「手机替她批准」)。全是纯函数。
 *
 * 维护者 10-01 午饭在外面(走中转):修手机横屏那条 Claude 会话在等批准,手机「待确认」里打了字,
 * 「输入回复内容之后,说发不出去」—— 打字批不了权限弹窗。卡 WQ 拍板的「批准」那一类一直没做。
 *
 * 链:壳的 `agent_approval` 用**这一步自己的原话**(命令 / 说明)圈出这条会话的那个弹窗,
 * 读回含那截原话的几块容器和它们的键名 → 这里挑出**那一块**、只留「批准一次 / 拒绝」两类 →
 * 界面摆壳读到的那几个字 → 她按 → 壳只在那一块里按那一颗,按完重读,那颗键没了才算批了。
 *
 * **放宽的那一类(本次会话都允许 / 始终允许 / 不再询问)不给**:那是替她改了这条会话往后的权限,
 * 决策记录里没有拍板(见「待拍板」),她要放宽就在电脑上自己按。
 */
import type { SessionApprovalKey, SessionAskView } from '../protocol.ts'
import { voiceVerdict } from './butlerAsks.ts'

/** 一颗键是哪一类:批准一次 / 放宽(往后都允许)/ 拒绝。 */
export type ApprovalKeyKind = 'once' | 'broad' | 'deny'

/** 给她按的一颗:`label` 是壳读到的原字(按的时候原样交回去),`does` 是它的意思(界面上配一句中文)。 */
export type ApprovalKey = SessionApprovalKey

/** 壳读回来的一块(相对那扇窗左上角)。 */
export interface ApprovalPanelRect { x: number, y: number, w: number, h: number }
export interface ApprovalPanelRead { rect: ApprovalPanelRect, keys: readonly string[] }

/** 放宽:往后同类的不再问她。先认它 —— 「Allow for this session」开头也是 Allow。 */
const BROAD = /always|session|don'?t ask|do not ask|never ask|remember|\ball\b|this (project|folder|directory|workspace)|始终|总是|一直|都允许|全部允许|本次会话|这次会话|会话内|会话中|不再询问|不再问|以后|记住/i
/** 拒绝。排在「批准」前面:「Don't allow」「不允许」里也有 allow / 允许。 */
const DENY = /^(no\b|deny|reject|decline|cancel|disallow|don'?t\b|do not\b|block|stop)|拒绝|不允许|不批准|不同意|^取消|^否$/i
/** 批准一次。 */
const ONCE = /^(allow|approve|yes|accept|ok\b|okay|run|proceed|continue|confirm)|允许|批准|同意|^是$|^好$|^确定|^确认|^运行|^继续|^执行/i

export function approvalKeyKind(label: string): ApprovalKeyKind | undefined {
  const text = label.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  if (BROAD.test(text)) return 'broad'
  if (DENY.test(text)) return 'deny'
  if (ONCE.test(text)) return 'once'
  return undefined
}

/**
 * 这一问是不是**权限弹窗**:要她批(`approve`)+ 那家自己弹的框(`by:'form'`)或子任务的那一问。
 * 与 `sessionAnswer.ts` 的 `mustClick` 同一条线(弹框 / 子任务那一问打字送不进去)。
 */
export function isPermissionAsk(ask: Pick<SessionAskView, 'kind' | 'by' | 'child'> | undefined): boolean {
  return ask !== undefined && ask.kind === 'approve' && (ask.by === 'form' || ask.child !== undefined)
}

const NOT_FOUND = '没在它窗口里认出这一步的批准弹窗'

function contains(outer: ApprovalPanelRect, inner: ApprovalPanelRect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
}

function sameRect(a: ApprovalPanelRect, b: ApprovalPanelRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * 壳读回来的那几块里**哪一块是这条会话的那个弹窗**、给她哪几颗。
 *
 * 1. 够格:一块里**既有批准、又有拒绝**(宁窄勿宽:随便一颗「Run」「Copy」的不是批准弹窗);
 * 2. 同一个弹窗它外面几层也够格 → 取**最里面**的(不包着另一块够格的);
 * 3. 最里面的还有两块 → 两个弹窗都含这截原话,认不准 —— 一颗都不给;
 * 4. 那一块里同名的键两颗 → 两个弹窗挤在一块里,认不准;
 * 5. 能批的只有放宽的那颗 → 不给(她在电脑上自己决定放不放宽)。
 */
export function pickApprovalPanel(panels: readonly ApprovalPanelRead[]):
  | { ok: true, panel: ApprovalPanelRect, keys: readonly ApprovalKey[], held: readonly string[] }
  | { ok: false, why: string } {
  const kinds = (panel: ApprovalPanelRead): Set<ApprovalKeyKind | undefined> => new Set(panel.keys.map(approvalKeyKind))
  const able = panels.filter((panel) => {
    const seen = kinds(panel)
    return (seen.has('once') || seen.has('broad')) && seen.has('deny')
  })
  const inner = able.filter(one => !able.some(other => other !== one && !sameRect(other.rect, one.rect) && contains(one.rect, other.rect)))
  // 同一块读出两份(位置一样)只算一块。
  const distinct = inner.filter((one, index) => inner.findIndex(other => sameRect(other.rect, one.rect)) === index)
  if (distinct.length === 0) return { ok: false, why: NOT_FOUND }
  if (distinct.length > 1) return { ok: false, why: `它窗口里有 ${distinct.length} 个批准弹窗都像这一步的,认不准是哪一个,一颗键都没敢按` }
  const panel = distinct[0]!
  const keys: ApprovalKey[] = []
  const held: string[] = []
  const seen = new Set<string>()
  for (const raw of panel.keys) {
    const label = raw.replace(/\s+/g, ' ').trim()
    const kind = approvalKeyKind(label)
    if (kind === undefined) continue
    if (seen.has(label)) return { ok: false, why: `那一块里有两颗都叫「${label}」,认不准是哪个弹窗的,一颗键都没敢按` }
    seen.add(label)
    if (kind === 'broad') held.push(label)
    else keys.push({ label, does: kind })
  }
  if (!keys.some(one => one.does === 'once')) {
    return { ok: false, why: `那个弹窗上只有「${held[0] ?? '放宽权限'}」这种放宽权限的键能批,这一下得你在电脑上自己按` }
  }
  return { ok: true, panel: panel.rect, keys, held }
}

/**
 * 她点的 / 她说的是哪一颗:正是那颗键名 → 就是它;不是就听意思(「批准 / 可以」→ 批准一次,
 * 「拒绝 / 不行」→ 拒绝;判据同电话里批事项那一套 `voiceVerdict`),**那一类恰好一颗**才算。听不出 → 不替她挑。
 */
export function resolveApprovalKey(keys: readonly ApprovalKey[], said: string): ApprovalKey | undefined {
  const text = said.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const exact = keys.find(one => one.label === text)
  if (exact !== undefined) return exact
  // 正是某颗放宽的键名(或别的认得出类别的键名)—— 不拿它的意思去顶一颗别的。
  if (approvalKeyKind(text) === 'broad') return undefined
  const verdict = voiceVerdict(text)
  if (verdict === undefined) return undefined
  const does = verdict === 'allow' ? 'once' : 'deny'
  const pool = keys.filter(one => one.does === does)
  return pool.length === 1 ? pool[0] : undefined
}

/** 界面上那颗键底下配的一句中文(键名照壳读到的原字摆,英文的她也认得出是哪一颗)。 */
export const APPROVAL_DOES_TEXT: Readonly<Record<ApprovalKey['does'], string>> = {
  once: '批准这一次',
  deny: '不批',
}
