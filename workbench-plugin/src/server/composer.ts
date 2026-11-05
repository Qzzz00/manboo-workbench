/**
 * 统一输入框的服务端(2026-09-24,设计 docs/设计-统一输入框-2026-09-24.md)。
 *
 * 维护者 2026-09-24:「你之前做的输入框(引导和事务官、手机和电脑端)都不是同一套,应该是同一套的
 * 不同裁剪才对;也说明我们现在没有加号、没有模型切换、没有模式选择」。
 *
 * 电脑与手机的输入框长在两个仓库目录里、互不 import,所以「同一套」落在这里:
 * - 四个菜单的数据只有一份(`GET /composer/options` 由 {@link composerOptions} 拼);
 * - 附件只有一个落处(电脑的收件文件夹,与手机「发文件」那条 LiveKit 字节流同一个目录);
 * - 选择(模式、模型)只有一份,电脑与手机共用(`~/.dsh/workbench/composer.json`);
 * - 审批只有一个经纪人(`approval/request` 的答复方之一),档上与手机上点的是同一条。
 *
 * 这个文件的纯函数一行 I/O 都没有;I/O 集中在 {@link createComposerService}。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import {
  COMPOSER_MODES, COMPOSER_MODE_HINTS, COMPOSER_MODE_TITLES,
  DEFAULT_COMPOSER_MODE, isComposerMode,
} from '../protocol.ts'
import type {
  AgentDispatchFamily, ApprovalOptionView, ComposerAgentView, ComposerMode, ComposerModelView, ComposerOptionsView, ComposerUploadView,
  DispatchHand, PendingApprovalView, TaskView, WorkbenchState,
} from '../protocol.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { knownFamilyTargets } from './dispatchTargets.ts'
import { DSH_RELAY_PROVIDER, relayModelSpec } from './dshModelSettings.ts'
import type { RelayProvidersView } from './relayProviders.ts'
import { apiHandStatus } from './relayProviders.ts'
import { askOnlyFourKindsBlock } from './confirmPoints.ts'

// ───────────────────────────── @ 候选 ─────────────────────────────

/** 「用过」往回看多少天。 */
export const USED_WITHIN_DAYS = 30

export interface ComposerAgentSignals {
  /** 组好的 /state(窗口槽、装了没有、会话、用量都从这里读 —— 与界面看到的是同一份)。 */
  state: Partial<Pick<WorkbenchState, 'apps' | 'dock' | 'clients' | 'sessions' | 'usage' | 'tasks'>>
  /** 本机探得到命令行的那几家(`resolveAgentCli` 的结果,found 的才进来)。 */
  clis: ReadonlySet<AgentDispatchFamily>
  /** 送话进窗口那只手接上了没(壳在不在)。 */
  windowReady: boolean
  /** 接口那只手(中转)接上了没。 */
  apiReady: boolean
  /**
   * 中转上配了哪几家上游(2026-09-26,卡 GH;`relayProviders.ts`)。有窗口的那几家(豆包)据此把
   * **接口那一只**标成不可用(「中转没配这家」),整家照常在;只有接口那一只的(GPT)压根不在
   * `targets` 里(`dispatchTargets` 已经把它挡在外面)。缺席 = 从没问到过 → 当一家都没配。
   */
  relayProviders?: RelayProvidersView
  now: Date
  /**
   * 那家的 app 装在这台电脑上没有(2026-09-24,卡 F)。`state.clients` 只认得 Claude / Codex / Kimi 三家,
   * 豆包 / Muse / Manus 靠这一格(`/Applications/<名>.app` 在不在)。缺席 = 只看 `state.clients`(老行为)。
   */
  appInstalled?: (family: AgentDispatchFamily) => boolean
  /**
   * 能接活的每一家(2026-09-25,卡 Z:Agent 登记表算出来的 `dispatchTargets`)。
   * 缺席 = 老宿主 / 用例:退回「写过专门接法、装着的那几家」。
   */
  targets?: readonly DispatchTarget[]
}

/**
 * 窗口那只手送得进去的几家。★ 2026-09-24(卡 F)起**六家都在**:豆包 2.17.10 的输入框
 * 在辅助功能树里读得到了(0921 那张表里的「10 个节点、0/5」是旧版本),Muse / Manus 新加。
 */

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

/**
 * 「@」的候选。**不写死**:哪几家出现、排在哪,全看这台机器此刻的样子。
 *
 * ★ 2026-09-25(卡 Z):连「认得哪几家」「每家几只手」也不写死了 —— 两样都从 Agent 登记表算出来的
 * `signals.targets` 来(`dispatchTargets`)。登记表里新接上一家,输入框里 @ 得到它,不改代码。
 *
 * 出现条件(满足一条就列):在窗口槽里 / 近 30 天用过 / 本机有命令行 / 中转能接。
 * 排序:在窗口槽里 > 最近用过 > 其余。事务官自己永远第一条(不 @ 就是它)。
 */
export function composerAgents(signals: ComposerAgentSignals): ComposerAgentView[] {
  const { state, clis, windowReady, apiReady, now } = signals
  const slotKeys = new Set<string>([
    ...(state.apps ?? []).map(app => app.key),
    ...(state.dock?.stack ?? []).map(tab => tab.key),
  ])
  const cutoff = new Date(now.getTime() - USED_WITHIN_DAYS * 86_400_000).toISOString()
  const out: ComposerAgentView[] = []
  /*
   * 退路(老调用方、用例):**写过专门接法的每一家**都过一遍下面那几个出现条件
   * (在槽里 / 近 30 天用过 / 有命令行 / 接口接得上 / 装了且窗口能送),与 09-25 之前一字不变。
   * 有登记表时只认登记表那一份 —— 里面每一条都是判过、接上了的。
   */
  const targets = signals.targets ?? knownFamilyTargets()
  for (const target of targets) {
    const family = target.id
    let lastUsed: string | undefined
    for (const session of state.sessions ?? []) {
      if (session.agent === family) lastUsed = latest(lastUsed, session.updated_at)
    }
    const usage = state.usage !== undefined && 'days' in state.usage ? state.usage : undefined
    for (const day of usage?.days ?? []) {
      if (day.by_source[family] !== undefined) lastUsed = latest(lastUsed, `${day.date}T23:59:59.000Z`)
    }
    const used = lastUsed !== undefined && lastUsed >= cutoff
    const inSlot = slotKeys.has(family)
    const installed = (state.clients as Record<string, { installed?: boolean }> | undefined)?.[family]?.installed === true
      || signals.appInstalled?.(family) === true
    const hands = target.hands.map((hand): { hand: DispatchHand, ready: boolean, why?: string } => {
      if (hand === 'window') {
        if (!windowReady) return { hand, ready: false, why: '窗口编排没接上' }
        // 登记表说它开着就算装着(运行时认出来的那一家只有包标识,没有 App 名去 stat)。
        if (!installed && !inSlot && target.app_running !== true) return { hand, ready: false, why: '这台电脑上没装它' }
        return { hand, ready: true }
      }
      if (hand === 'cli') return clis.has(family) ? { hand, ready: true } : { hand, ready: false, why: '这台电脑上它还不能在后台做' }
      /*
       * 接口那只手(2026-09-26 卡 GH):「模型服务没接上」与「中转没配这家」是两句不同的话 ——
       * 前者他自己在设置里点一下就好,后者要在服务器上加一把 Key(不是他能做的)。
       */
      const api = apiHandStatus(family, { apiReady, ...(signals.relayProviders === undefined ? {} : { relayProviders: signals.relayProviders }) })
      return api.ready ? { hand, ready: true } : { hand, ready: false, why: api.why ?? '接口这只手这会儿用不了' }
    })
    /*
     * 「凭接口那只手就列出来」的那一档(2026-09-26 卡 GH 收紧):要那只手**真能用**,
     * 不只是「模型服务接上了」—— 中转上没配这一家上游时,列出来的是一颗点了必失败的钮。
     * 于是只有接口那一只的 GPT 在 `openai:false` 那天一处都不出现;豆包靠窗口那一档照常在。
     */
    const apiFamily = hands.some(one => one.hand === 'api' && one.ready)
    // 装了、而且窗口那只手接得上的也列出来(2026-09-24,卡 F):Muse / Manus / 豆包这种**没有会话流**的,
    // 光看"用过 / 在槽里"永远列不出来(它们的"用过"没有任何地方记),他在手机上就点不到它。
    // 有会话流的三家照旧按"用过 / 在槽里 / 有命令行"判,行为一字不变。
    const noSessionFeed = target.feed === undefined
    const windowFamily = noSessionFeed && target.hands.includes('window') && windowReady && (installed || target.app_running === true)
    if (!(inSlot || used || clis.has(family) || apiFamily || windowFamily)) continue
    out.push({
      family,
      // 名字从登记表来(卡 Z)。
      title: target.title,
      hands,
      ready: hands.some(one => one.ready),
      in_slot: inSlot,
      ...(lastUsed === undefined ? {} : { last_used_at: lastUsed }),
    })
  }
  out.sort((a, b) => {
    if (a.in_slot !== b.in_slot) return a.in_slot ? -1 : 1
    const au = a.last_used_at ?? ''
    const bu = b.last_used_at ?? ''
    if (au !== bu) return au > bu ? -1 : 1
    return 0
  })

  /*
   * 协作区自定义名片(2026-10-23,卡 t-83cd57eb):
   * 协作区自定义名片(agent_cards)在 @ 候选展示其专属名称与底层家族;
   * 因后端分派契约尚未由公共接口(A/1a)接通,在此如实标为未就绪(ready: false),
   * 绝不设置 ready: true 诱导发送后静默回退到 dsh 或其他家族。
   */
  const cardViews: ComposerAgentView[] = []
  for (const card of state.tasks?.agent_cards ?? []) {
    const rawFamily = card.runtime?.family ?? (['cli', 'window'].includes(card.hand) ? 'codex' : card.hand)
    const family = (rawFamily === '' ? 'codex' : rawFamily) as AgentDispatchFamily
    const inSlot = slotKeys.has(family)
    cardViews.push({
      family,
      title: card.name,
      hands: [{ hand: 'cli', ready: false, why: '名片分派待公共接线' }],
      ready: false,
      in_slot: inSlot,
    })
  }
  cardViews.sort((a, b) => (a.in_slot === b.in_slot ? 0 : a.in_slot ? -1 : 1))

  return [
    { family: 'dsh', title: '事务官自己', hands: [], ready: true, in_slot: false },
    ...cardViews,
    ...out,
  ]
}

// ───────────────────────────── 模型 ─────────────────────────────

/** DSH `sessionController.modelCatalog()` 的形状里我们用到的那几格。 */
export interface ModelCatalogLike {
  default: { provider: string, model: string }
  routableProviders: readonly string[]
  groups: readonly { id: string, name: string, models: readonly { id: string, name: string }[] }[]
  failures: readonly { id: string, name: string, message: string }[]
}

/**
 * 模型表:DSH 的 catalog 原样列(维护者:直接列模型名),只列此刻能用的路由。
 * 中转那组按我们的表认短名与能不能看图;别的路由短名用它自己给的名字、按「不能看图」算 ——
 * 我们没实测过的不替它说能。
 */
export function composerModels(catalog: ModelCatalogLike): ComposerModelView[] {
  const routable = new Set(catalog.routableProviders)
  const out: ComposerModelView[] = []
  for (const group of catalog.groups) {
    if (!routable.has(group.id)) continue
    for (const model of group.models) {
      if (group.id === DSH_RELAY_PROVIDER) {
        const spec = relayModelSpec(model.id)
        out.push({ provider: group.id, id: model.id, title: spec.title, images: spec.images })
      }
      else {
        out.push({ provider: group.id, id: model.id, title: model.name === '' ? model.id : model.name, images: false })
      }
    }
  }
  return out
}

/** 这一个模型能不能直接看图(没登记在表里 = 不能)。 */
export function modelTakesImages(models: readonly ComposerModelView[], model: { provider: string, id: string } | undefined): boolean {
  if (model === undefined) return false
  return models.find(one => one.provider === model.provider && one.id === model.id)?.images === true
}

// ───────────────────────────── 选择(粘性) ─────────────────────────────

export interface ComposerChoice {
  mode: ComposerMode
  model?: { provider: string, id: string }
}

export function parseComposerChoice(raw: unknown): ComposerChoice {
  const body = (raw ?? {}) as Record<string, unknown>
  const model = body.model as Record<string, unknown> | undefined
  return {
    mode: isComposerMode(body.mode) ? body.mode : DEFAULT_COMPOSER_MODE,
    ...(model !== undefined && typeof model.provider === 'string' && model.provider !== '' && typeof model.id === 'string' && model.id !== ''
      ? { model: { provider: model.provider, id: model.id } }
      : {}),
  }
}

// ───────────────────────────── 附件 ─────────────────────────────

/** 一个附件最大多少。图片另受 DSH 的 20MB 限制(见 IMAGE_MAX_BYTES)。 */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
/** DSH 一张图的上限(dsh-attachment-local 缺省)。 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** DSH 认的四种图。别的(heic、svg……)按普通文件给路径。 */
export function imageTypeOf(name: string): string | undefined {
  return IMAGE_TYPES[extname(name).toLowerCase()]
}

/** 文件名只留一段、清掉危险字符(与 channel-worker/src/files/inbox.ts 同一口径;两边不互相 import)。 */
export function safeFileName(raw: string | undefined): string {
  const name = basename((raw ?? '').replace(/\\/g, '/')).trim()
  const cleaned = name
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return cleaned === '' ? '文件' : cleaned
}

/** 重名加 -2、-3……不覆盖。 */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/** 交办时带进来的附件 id 表(字符串或 `{id}`),去重、最多 20 个。 */
export function attachmentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const id = typeof item === 'string' ? item : (typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : '')
    const safe = safeFileName(id)
    if (id.trim() === '' || out.includes(safe)) continue
    out.push(safe)
    if (out.length >= 20) break
  }
  return out
}

export interface ResolvedAttachment {
  name: string
  path: string
  bytes: number
  /** DSH 认得的图片类型;不是图就缺席。 */
  imageType?: string
}

// ───────────────────────────── 引用 ─────────────────────────────

export interface ComposerRefInput { kind: 'item' | 'project', id: string }

export function refInputs(raw: unknown): ComposerRefInput[] {
  if (!Array.isArray(raw)) return []
  const out: ComposerRefInput[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const one = item as Record<string, unknown>
    if ((one.kind !== 'item' && one.kind !== 'project') || typeof one.id !== 'string' || one.id === '') continue
    if (out.some(ref => ref.kind === one.kind && ref.id === one.id)) continue
    out.push({ kind: one.kind, id: one.id })
    if (out.length >= 10) break
  }
  return out
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  backlog: '以后再说', todo: '待办', doing: '在办', confirm: '等他确认', done: '已完成', blocked: '卡住', canceled: '取消了',
}

/**
 * 引用展开成第一句里的几行。**原样拼,不经模型**:标题、状态、项目路径与那一句状态原文;
 * 查不到的那一条如实写「没找到」,不编。
 */
export function refLines(
  refs: readonly ComposerRefInput[],
  lookup: {
    tasks: readonly Pick<TaskView, 'id' | 'title' | 'status' | 'note' | 'project_id'>[]
    projects: readonly { id: string, name: string, path?: string, status?: { text?: string } }[]
  },
): string[] {
  return refs.map((ref) => {
    if (ref.kind === 'item') {
      const task = lookup.tasks.find(one => one.id === ref.id)
      if (task === undefined) return `- 事项 ${ref.id}:没找到(可能已经删了)`
      const status = STATUS_WORDS[task.status] ?? task.status
      return `- 事项「${task.title}」(${status},id ${task.id}${task.note === undefined ? '' : `,卡上记着:${task.note}`})`
    }
    const project = lookup.projects.find(one => one.id === ref.id)
    if (project === undefined) return `- 项目 ${ref.id}:没找到`
    return `- 项目「${project.name}」${project.path === undefined ? '' : `(在 ${project.path})`}${project.status?.text === undefined ? '' : `,状态:${project.status.text}`}`
  })
}

// ───────────────────────────── 第一句的尾巴 ─────────────────────────────

/**
 * 模式那一句(给事务官看的,话说得像交代)。**只出方案**那档另由服务端的三道门兜住,
 * 这一句只是让它知道为什么派不出去。
 */
export const MODE_LINES: Readonly<Record<ComposerMode, string>> = {
  plan: '这件按「只出方案」办:只读、不改文件、不派给别家;把方案写清楚回给他,等他说「照这个办」。',
  /*
   * ——— 2026-10-02:这一句删掉了「复述成 2–4 个确认点」(卡「电话里像个活人」)———
   *
   * 「先问我」保留的是**判断**(澄清环节在不可改清单上):拿不准才问。
   * 以前这一句把它写成了**话术** —— 每件事项的第一条消息里都带着
   * 「先把你的理解复述成 2–4 个确认点问他」,于是「查个天气」「放进发布计划」
   * 也先被复述一遍、再被问三条。Air 那几通里「要你确认三点 / 跟你核三条」8 次。
   */
  /*
   * ——— 2026-10-04:后面接上「只问四类事」(卡 `claude/three-small-1004`)———
   *
   * 「先问我」这一档说的是**什么时候**对一句(要派活、要动她的文件);
   * 那一句接的是**问什么**(只有那四类)。10-02 删掉话术之后留下的「拿不准才问」
   * 被当成了「凡有分歧就问」—— 维护者:「别拿细枝末节来问我拍板」。
   * 字只有一处定:`confirmPoints.askOnlyFourKindsBlock`。
   */
  ask: '这件按「先问我」办:要派给别家、或者要动他的文件,**拿不准的时候**先问一句 —— '
    + '一次只问最要紧的那一件(答案不同、做法就不同的那个点),用他自己的话问,'
    + '**不要复述一遍他刚说的话、不要列①②③**;听懂了就直接办,办完说结果。'
    + '他只是问一件事(问规矩、问进度、问在哪),就直接答。'
    + askOnlyFourKindsBlock('他').join(''),
  auto: '这件按「自动办」办:不用先问,直接办、直接派;授权表里写着「要问」的照问。',
}

/** 附件与引用拼在原话后面的那一段。没有就空串。 */
export function composerTail(input: {
  mode: ComposerMode
  attachments: readonly ResolvedAttachment[]
  /** 图片已经直接放进这条消息里了(模型能看图)。 */
  imagesInline: boolean
  refs: readonly string[]
}): string {
  const parts: string[] = [MODE_LINES[input.mode]]
  if (input.attachments.length > 0) {
    parts.push([
      '他附了文件(都在这台电脑上):',
      ...input.attachments.map(one => `- ${one.path}${one.imageType !== undefined && input.imagesInline ? '(图片,已经放在这条消息里)' : ''}`),
    ].join('\n'))
  }
  if (input.refs.length > 0) parts.push(['他引用了:', ...input.refs].join('\n'))
  return parts.join('\n')
}

// ───────────────────────────── 审批 ─────────────────────────────

export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 这一条审批的人话(2026-09-25,卡 M;server/butlerAsks.ts 的 describeApproval 翻好)。
 * 派活前那一问(卡 F)只带 `say`。缺席 = 界面退回 `reason ?? tool`(老调用方)。
 */
export type ApprovalAskDetail = Pick<PendingApprovalView, 'say' | 'why' | 'scope' | 'kind' | 'raw' | 'proposal'>

export interface ApprovalAsk {
  sessionId: string
  tool: string
  reason?: string
  /** 派活前那一问(卡 O):能派给的几家,一家一行、各带额度那一格。 */
  options?: readonly ApprovalOptionView[]
  signal?: AbortSignal
  detail?: ApprovalAskDetail
}

/** 经纪人手里一条的样子(还没配上卡)。 */
export type ApprovalPendingView = { id: string, session_id: string, tool: string, reason?: string, at: string, options?: readonly ApprovalOptionView[] } & ApprovalAskDetail

export interface ApprovalBroker {
  /** 挂一条,等档上 / 手机上点;signal 取消就回 cancelled。 */
  ask: (req: ApprovalAsk) => { id: string, answer: Promise<ApprovalAnswer> }
  list: () => readonly ApprovalPendingView[]
  /** 回 false = 没有这一条(已经答过 / 取消了)。 */
  answer: (id: string, allow: boolean) => boolean
  /** 有变化(挂上、答掉、取消)就叫一次。 */
  onChange: (listener: () => void) => () => void
}

export function createApprovalBroker(now: () => Date = () => new Date()): ApprovalBroker {
  const pending = new Map<string, { view: ApprovalPendingView, resolve: (a: ApprovalAnswer) => void }>()
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of listeners) { try { listener() } catch { /* 一个监听者坏了不连累别人 */ } } }
  return {
    ask(req) {
      const id = randomUUID()
      const answer = new Promise<ApprovalAnswer>((resolve) => {
        const settle = (a: ApprovalAnswer): void => {
          if (!pending.delete(id)) return
          resolve(a)
          changed()
        }
        pending.set(id, {
          view: {
            id, session_id: req.sessionId, tool: req.tool, ...(req.reason === undefined ? {} : { reason: req.reason }), at: now().toISOString(),
            ...(req.options === undefined || req.options.length === 0 ? {} : { options: req.options }),
            ...(req.detail?.say === undefined ? {} : { say: req.detail.say }),
            ...(req.detail?.why === undefined ? {} : { why: req.detail.why }),
            ...(req.detail?.scope === undefined ? {} : { scope: req.detail.scope }),
            ...(req.detail?.kind === undefined ? {} : { kind: req.detail.kind }),
            ...(req.detail?.raw === undefined ? {} : { raw: req.detail.raw }),
            // 事务官自己的提议(卡 UX):不进「等你」、座机不为它响。判据只认这一格,不认那句话。
            ...(req.detail?.proposal === true ? { proposal: true as const } : {}),
          },
          resolve: settle,
        })
        if (req.signal !== undefined) {
          if (req.signal.aborted) { settle('cancelled'); return }
          req.signal.addEventListener('abort', () => settle('cancelled'), { once: true })
        }
      })
      changed()
      return { id, answer }
    },
    list: () => [...pending.values()].map(one => one.view),
    answer(id, allow) {
      const one = pending.get(id)
      if (one === undefined) return false
      one.resolve(allow ? 'allowed-once' : 'rejected')
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 「先问我」档下派活前要他批的那一问,挂进审批经纪人时用的会话 id 前缀(2026-09-24,卡 F)。
 * 它不是一条 DSH 会话 —— 批的是"要不要把这件事派给某一家",手机首页那一行与 DSH 的审批长得一样。
 */
export const DISPATCH_APPROVAL_PREFIX = 'dispatch:'

/** 挂着的审批配上卡(会话 → 事项)。 */
export function approvalViews(
  pending: ReturnType<ApprovalBroker['list']>,
  tasks: readonly Pick<TaskView, 'id' | 'title' | 'conversation'>[],
): PendingApprovalView[] {
  return pending.map((one) => {
    // 派活前那一问(2026-09-24,卡 F):会话 id 写的是 `dispatch:<事项 id>`,直接按事项 id 对。
    const dispatchTaskId = one.session_id.startsWith(DISPATCH_APPROVAL_PREFIX) ? one.session_id.slice(DISPATCH_APPROVAL_PREFIX.length) : undefined
    const task = dispatchTaskId !== undefined
      ? tasks.find(t => t.id === dispatchTaskId)
      : tasks.find(t => t.conversation?.session_id === one.session_id)
    return {
      ...one,
      ...(task === undefined ? {} : { task_id: task.id, task_title: task.title }),
    }
  })
}

// ───────────────────────────── 服务(I/O) ─────────────────────────────

export interface ComposerServiceOptions {
  /** `~/.dsh/workbench/composer.json`。 */
  choiceFile: string
  /** 电脑的收件文件夹(与手机「发文件」同一个)。 */
  inboxDir: string
  /** 本机探得到命令行的那几家。缺省由 HTTP 层用 resolveAgentCli 现探;测试注入。 */
  clis?: () => ReadonlySet<AgentDispatchFamily>
}

export interface ComposerService {
  readonly inboxDir: string
  readonly clis?: () => ReadonlySet<AgentDispatchFamily>
  choice: () => Promise<ComposerChoice>
  saveChoice: (next: Partial<ComposerChoice>) => Promise<ComposerChoice>
  upload: (input: { name: string, type?: string, data: Buffer }) => Promise<{ ok: true, view: ComposerUploadView } | { ok: false, error: string }>
  /** 附件 id → 文件。手机走字节流发来的那一份可能晚一两秒落盘,等 `waitMs`。 */
  resolve: (ids: readonly string[], waitMs?: number) => Promise<{ found: ResolvedAttachment[], missing: string[] }>
  readImage: (file: ResolvedAttachment) => Promise<string | undefined>
}

/** 缺省收件文件夹:`~/Documents/事务官/收件`(与 channel-worker config.ts defaultInboxDir 同一处)。 */
export function defaultComposerInboxDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const fromEnv = env.WORKBENCH_CHANNEL_INBOX_DIR?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(home, 'Documents', '事务官', '收件')
}

export function createComposerService(options: ComposerServiceOptions): ComposerService {
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  async function choice(): Promise<ComposerChoice> {
    try { return parseComposerChoice(JSON.parse(await readFile(options.choiceFile, 'utf8'))) }
    catch { return { mode: DEFAULT_COMPOSER_MODE } }
  }
  return {
    inboxDir: options.inboxDir,
    ...(options.clis === undefined ? {} : { clis: options.clis }),
    choice,
    async saveChoice(next) {
      const current = await choice()
      const merged = parseComposerChoice({ ...current, ...next })
      await mkdir(dirname(options.choiceFile), { recursive: true })
      const tmp = `${options.choiceFile}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      await rename(tmp, options.choiceFile)
      return merged
    },
    async upload(input) {
      if (input.data.length === 0) return { ok: false, error: '这个文件是空的' }
      if (input.data.length > UPLOAD_MAX_BYTES) return { ok: false, error: `文件太大了(超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB)` }
      try {
        await mkdir(options.inboxDir, { recursive: true })
        const name = uniqueFileName(safeFileName(input.name), candidate => existsSync(join(options.inboxDir, candidate)))
        await writeFile(join(options.inboxDir, name), input.data)
        const imageType = imageTypeOf(name)
        return {
          ok: true,
          view: {
            id: name,
            name,
            type: imageType ?? (input.type !== undefined && input.type !== '' ? input.type : 'application/octet-stream'),
            bytes: input.data.length,
            image: imageType !== undefined,
          },
        }
      }
      catch (err) {
        return { ok: false, error: `写不进收件文件夹:${(err as Error)?.message ?? '没说原因'}` }
      }
    },
    async resolve(ids, waitMs = 0) {
      const found: ResolvedAttachment[] = []
      const missing: string[] = []
      for (const id of ids) {
        const path = join(options.inboxDir, safeFileName(id))
        let info: Awaited<ReturnType<typeof stat>> | undefined
        const deadline = Date.now() + waitMs
        for (;;) {
          try { info = await stat(path) } catch { info = undefined }
          if (info?.isFile() === true || Date.now() >= deadline) break
          await sleep(250)
        }
        if (info?.isFile() !== true) { missing.push(id); continue }
        const imageType = imageTypeOf(path)
        found.push({ name: basename(path), path, bytes: info.size, ...(imageType === undefined ? {} : { imageType }) })
      }
      return { found, missing }
    },
    async readImage(file) {
      if (file.imageType === undefined || file.bytes > IMAGE_MAX_BYTES) return undefined
      try { return (await readFile(file.path)).toString('base64') }
      catch { return undefined }
    },
  }
}

/** 组 `GET /composer/options`。 */
export function composerOptions(input: {
  agents: readonly ComposerAgentView[]
  choice: ComposerChoice
  catalog?: ModelCatalogLike
  catalogError?: string
  tasks: readonly Pick<TaskView, 'id' | 'title' | 'status' | 'updated_at' | 'direction'>[]
  projects: readonly { id: string, name: string, idle?: boolean }[]
}): ComposerOptionsView {
  const models = input.catalog === undefined ? [] : composerModels(input.catalog)
  const chosen = input.choice.model !== undefined && models.some(one => one.provider === input.choice.model?.provider && one.id === input.choice.model.id)
    ? input.choice.model
    : input.catalog === undefined ? undefined : { provider: input.catalog.default.provider, id: input.catalog.default.model }
  const recentTasks = [...input.tasks]
    .filter(task => task.status !== 'done' && task.status !== 'canceled')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, 8)
    .map(task => ({ kind: 'item' as const, id: task.id, title: task.title, note: STATUS_WORDS[task.status] ?? task.status }))
  const recentProjects = input.projects.filter(p => p.idle !== true).slice(0, 8)
    .map(p => ({ kind: 'project' as const, id: p.id, title: p.name }))
  return {
    agents: input.agents,
    modes: COMPOSER_MODES.map(id => ({ id, title: COMPOSER_MODE_TITLES[id], hint: COMPOSER_MODE_HINTS[id] })),
    mode: input.choice.mode,
    models,
    ...(chosen === undefined ? {} : { model: chosen }),
    ...(input.catalog === undefined
      ? { models_note: input.catalogError ?? '事务官(DSH)还没接上,模型表拿不到' }
      : models.length === 0 ? { models_note: '现在没有能用的模型路由' } : {}),
    recent: [...recentTasks, ...recentProjects],
  }
}

/** 这件事按哪档办(卡上缺席当「先问我」)。 */
export function modeOfTask(task: Pick<TaskView, 'mode'> | undefined): ComposerMode {
  return task?.mode ?? DEFAULT_COMPOSER_MODE
}

/** 「只出方案」那档派活口一律回的那一句。 */
export const PLAN_ONLY_DISPATCH_ERROR = '这件是「只出方案」,不派活。要办的话在卡上点「照这个办」,或者重新交办时把模式换成「先问我」或「自动办」。'

/** 模式 → DSH 的权限预设(dsh-base 里的三档,不给 danger-full-access)。 */
export const MODE_PERMISSION_PRESET: Readonly<Record<ComposerMode, 'read-only' | 'workspace-write'>> = {
  plan: 'read-only',
  ask: 'workspace-write',
  auto: 'workspace-write',
}

/** 模式 → 送进窗口要不要替他按回车。 */
export function submitForMode(mode: ComposerMode): boolean {
  return mode === 'auto'
}

// Shared request-driven execution facts boundary used by the public state composer.
export { readLinkedCodexExecutions } from './codexExecutionFacts.ts'
export type { CodexExecutionDeps, CodexExecutionSource } from './codexExecutionFacts.ts'
