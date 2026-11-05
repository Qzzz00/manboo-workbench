/**
 * 事务官(或别的程序)动了哪一块:页面在那一块旁边出一行字(2026-09-25 卡 P 补三)。
 *
 * 来历:2026-09-10 起「事务官在控制哪个区域,那个区域的边缘显示一圈光圈」—— 服务端按动作认出区域,
 * 算出那块区域在屏幕上的矩形,让壳在上面画一圈光 + 一行字。看板那块页面从没报过矩形,服务端就按布局参数
 * 自己**重算**一遍版面(`moduleRectInWebview`),注释里自己写着「三处走漂就会算出一个页面上并不存在的版面」。
 * 0.3.1 真的漂了:维护者截图里「事务官正在挪任务卡的状态」连同一圈光框挂在工作台左上角(标题、顶栏、
 * 窗口槽上半截),任务卡却在右边的看板里。维护者:「看到红框里的东西了吗,好像是个新bug」。
 *
 * 统筹定(从根上改):
 * 1. 程序做的动作**一律只出一行字**,窗口槽、文件区、看板都一样;不出流线光、不出光圈。
 *    流线光只属于他亲手把新应用拖进窗口槽、松手那一下(`highlight.drop`)。
 * 2. 那行字**由页面自己画,挂在真实的元素上**(看板动作挂那张卡或项目区,文件动作挂文件区,窗口槽动作挂
 *    窗口槽);元素看不见(纯净模式、模块收起)就不画。服务端**不再算矩形**,只广播「哪个动作、哪张卡、一句话」
 *    (`/live` 的 `actor_note`)。
 *
 * 这一层只做两件事:
 * - **动作 → 哪一块 + 一句人话**(`planForAction`):一张写死的表。表里没有的动作不出字,不按名字猜。
 * - **动作前后各广播一条**(`withActorNote`):动作前一条,跑得久就每半个时长续一条,做完再一条
 *   (让字在做完之后还留一会儿给人看见)。**出字永远不是动作的前置条件**,广播出了什么事动作都照跑。
 *
 * 他自己在页面上点的动作(页面来的请求)不出字(2026-09-11 Ben:「为什么我现在操作,也会显示光圈」)。
 */
import type { ActorNote, ActorNoteRegion } from '../protocol.ts'

/** 这条写请求是页面来的(他自己点的)还是程序来的(事务官 / 别的 Agent 调的)。 */
export type RequestActor = 'page' | 'agent'

/** 一行字留多久。沿用光圈那 2 秒:够看见一眼,不会糊在界面上。 */
export const DEFAULT_NOTE_TTL_MS = 2000

/** 事务官手动指一下(`POST /highlight` 没带字)时的那行字。 */
export const POINT_DEFAULT_TEXT = '事务官在看这一块'

/**
 * 动作 → 挂在哪一块 + 一句人话动词。**这是一张表,不是规则**——新动作要出字就往这里加一行,
 * 别在调用处临时拼区域名。
 */
const PLANS: Record<string, { region: ActorNoteRegion, verb: string }> = {
  'dock.switch': { region: 'slot', verb: '切换窗位' },
  'dock.release': { region: 'slot', verb: '放开窗位里的应用' },
  // 2026-09-25:把他要的应用拉进窗位(点「点一下拉进来」/ 引导落地批量拉)。
  'dock.claim': { region: 'slot', verb: '把应用拉进窗位' },
  'scene.restore': { region: 'slot', verb: '恢复场景' },
  'files.pin': { region: 'files', verb: '贴 Finder' },
  'inbox.archive': { region: 'files', verb: '归档收件箱里的文件' },
  'task.create': { region: 'board', verb: '建事项' },
  'task.update': { region: 'board', verb: '改任务卡' },
  // 改状态(七态状态机那条唯一路由)也是"改任务卡"。
  'task.move': { region: 'board', verb: '挪任务卡的状态' },
}

/** 表里没有就是 undefined——不出字,不按动作名去猜。 */
export function planForAction(action: string): { region: ActorNoteRegion, verb: string } | undefined {
  return PLANS[action]
}

/**
 * 这条写请求是页面来的还是程序来的。**只用来决定出不出字**,不当权限用——权限是回环 / 令牌那道门的事。
 *
 * 判据是"有没有浏览器的痕迹":浏览器的 fetch 一定带 Origin 头,壳内页面另有壳 UA 标记
 * (壳给自己 WKWebView 配的 applicationNameForUserAgent,网页伪造不了)。两样都没有的
 * 才当程序调用。**它认的是"不是页面",不是"一定是事务官"**——curl 手敲也会被算成 agent,
 * 那一行字因此可能把他自己的一次 curl 说成"事务官正在…"。这个误判的代价只是一行小字不准。
 */
export function actorOfRequest(headers: { origin?: string | undefined, 'user-agent'?: string | string[] | undefined }): RequestActor {
  if (typeof headers.origin === 'string' && headers.origin !== '') return 'page'
  const ua = headers['user-agent']
  if (typeof ua === 'string' && ua.includes('BenWorkbenchShell/')) return 'page'
  return 'agent'
}

export interface ActorNoteRun<T> {
  action: string
  actor: RequestActor
  run: () => Promise<T>
  /** 广播出去(http.ts 接到 `/live`)。 */
  notify: (note: ActorNote) => void
  /** 看板动作挂哪张卡(改卡、挪状态有;建事项没有 —— 挂任务所在的那一块)。 */
  target?: { task_id?: string }
  ttlMs?: number
}

/**
 * 在一个写动作前后各广播一行字:动作前一条,动作跑得久就每半个时长续一条,做完再一条。
 * 动作的返回值与异常**原样透传**;广播自己出了什么事都吞掉(出字不是动作的前置条件)。
 */
export async function withActorNote<T>(options: ActorNoteRun<T>): Promise<T> {
  const plan = planForAction(options.action)
  if (plan === undefined || options.actor === 'page') return options.run()
  const ttlMs = options.ttlMs ?? DEFAULT_NOTE_TTL_MS
  const renewMs = Math.max(1, Math.floor(ttlMs / 2))
  const taskId = options.target?.task_id
  const note: ActorNote = {
    action: options.action,
    region: plan.region,
    ...(taskId === undefined || taskId === '' ? {} : { task_id: taskId }),
    text: `事务官正在${plan.verb}`,
    ttl_ms: ttlMs,
  }
  const send = (): void => {
    try { options.notify(note) }
    catch { /* 广播失败:没有那行字而已 */ }
  }

  send()
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const renew = (): void => {
    if (!alive) return
    send()
    timer = setTimeout(renew, renewMs)
    timer.unref?.()
  }
  timer = setTimeout(renew, renewMs)
  timer.unref?.()
  try {
    return await options.run()
  }
  finally {
    alive = false
    if (timer !== undefined) clearTimeout(timer)
    send() // 收尾那一条:动作做完之后字还留一会儿。
  }
}

/** 事务官手动指一下某一块(`POST /highlight {region, label}`):同样只是一行字,由页面挂在那一块上。 */
export function pointNote(region: ActorNoteRegion, label: string | undefined, ttlMs = DEFAULT_NOTE_TTL_MS): ActorNote {
  return { action: 'point', region, text: label === undefined || label.trim() === '' ? POINT_DEFAULT_TEXT : label, ttl_ms: ttlMs }
}
