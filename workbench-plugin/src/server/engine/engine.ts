/**
 * ★ **一条引擎:往别家 AI 送一句话、把回答拿回来**(2026-10-02,卡「引擎核心」)。
 *
 * 设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节。维护者 10-02 原话:
 * 「你现在完全不是站在全局、最优解、从底层机制出发去解决问题……嘴上说着不打补丁,结果全是打补丁。」
 *
 * 所以这一份**不是**在八条管线前面再放一层,它就是那八条管线本身:
 * `sessionAnswer` 的六只手、`dispatchClient.sendOnce` 的家族换包、`dispatchRun.checkWindow`、
 * `relayNewConversation` 的送话段、`relayWatch.pump` 的读窗段 —— 迁完全删(第三段那张卡)。
 *
 * ## 这里只做五件事,每件只做一遍
 *
 * | 做什么 | 怎么做 | 不在这里的那一份 |
 * |---|---|---|
 * | 挑通道 | `registry.picksFor(job)`(家族目录 + 各家 `capabilities()` 现查) | 「怎么和这一家说话」在适配器里 |
 * | 过闸 | `actionGate.allow()`,**一件事问一次**(见下) | 闸**只接在这里**(七处旧接法删掉) |
 * | 重试 | 只有 {@link RetryableError} 才重试,最多 {@link ENGINE_MAX_RETRIES} 回,等它自己说的 `waitMs` | 适配器只管抛,别的失败一回都不重试 |
 * | 换路 | `unsupported:true` → 队里下一条通道(Claude 的 `press` 从 socket 换到窗口) | 适配器不许自己换路 |
 * | 落账 | `jobLog`:指派 → 投递(确证 / 未确证)/ 没送 → 回了,键用 `jobKey` | 四步查得回来靠这本账 |
 *
 * ## ★ 闸的「一回」= 一次 `run`,不是一次 `adapter.run`
 *
 * 一次 `run` 里面可能动那一家两三下(可重试的失败再来一回、`unsupported` 换一条通道),
 * 这几下**合起来算一回**。理由写在 `actionGate.GATE_LIMITS` 里 `dispatch_send` 那一条注释上:
 * 换包(现在是换路)那两下相隔只有几毫秒,而点选项 / 批准 / 停止 / 捎话那几样的间隔是 1~1.5 秒
 * ——每一下都去问一次闸,换路就会被「离上一回太密」拦死,等于把 10-01 修好的东西又弄坏。
 * 一次 `run` 里面那几下由**引擎自己**封顶:重试最多 {@link ENGINE_MAX_RETRIES} 回,
 * 换路最多换到队尾(这一家登记了几条通道就几条)。跨调用的上限照旧是闸的。
 *
 * ## 三条纪律(与账、与她说话那两条同源)
 *
 * - **三种结局原样回**:`confirmed` 有证据、`unconfirmed` 按了发送但核不上、`not_sent` 没送 + 人话。
 *   `unconfirmed` **一个字都不说成送到了**。
 * - **闸拦下的那一下就是 `not_sent`,不许换路**:旧代码里闸拦下会漏进「另一条替代的路」
 *   (`sessionAnswer.handBlocked` 那一格防的就是这个)—— 引擎里换路只有 `unsupported` 一个由头。
 * - **账上没有她的话**:账上只有时刻、事项、哪一家、哪个包、什么动作、为什么。
 *   适配器写 `why` 时不许把她那句原话塞进来(同 `relayWatch.ts` 那一条)。
 */
import type { ActionGate, GateAction } from '../actionGate.ts'
import { GATE_ACTION_TEXT, RELAY_DEDUPED_NOTE } from '../actionGate.ts'
import { sessionJobId } from '../jobKey.ts'
import type { JobLog, JobStep } from '../jobLog.ts'
import { jobLogLine } from '../jobLog.ts'
/** 锁着屏那一句人话(手机 / 电话 / 账上那一行**同一个出处**;2026-10-03)。 */
import { screenLockedSay } from '../screenLock.ts'
/** 那条会话没开着时留言的那一句人话(2026-10-23,卡「捎话留言等它醒」)。 */
import { SESSION_CLOSED_QUEUED_SAY } from '../sessionClosed.ts'
import type { FamilyLanes } from '../familyLanes.ts'
import { LOCK_WITHDRAW_LOG, type LockQueueReason } from './lockQueue.ts'
import type { AdapterReadResult, ApprovalReadResult, Job, JobKind, JobResult } from './adapter.ts'
import { ENGINE_MAX_RETRIES, RetryableError, VIA_TEXT } from './adapter.ts'
import type { AdapterPick, AdapterRegistry } from './registry.ts'

/**
 * **这一件事此刻算哪一种动作**(闸的 `GateAction`)。一处写。
 *
 * 剩下那几样 `GateAction` 不从这张表来,各有各的理由:
 * - `dispatch_resend`(重派)看 `Job.attempt`(契约 10-02 加的那一格),见 {@link jobGateActionOf};
 * - `window_wake` / `bring_front` 是窗口适配器 `open` 里面的两下(设计第三节:开窗**只在那一层**);
 * - `reply_watch` 是盯窗那一圈,走 {@link Engine.read}(闸接在这儿,见 {@link createEngine});
 * - `approval_read`(只读那个弹框上有哪几颗键)不是送话,走 {@link Engine.readApproval}(闸在适配器那一层,
 *   与按下去那一颗的 `approval` 分成两样 —— 她每打开那张卡就读一次)。
 */
export const JOB_GATE_ACTION: Readonly<Record<JobKind, GateAction>> = {
  answer: 'answer_send',
  relay: 'relay_send',
  dispatch: 'dispatch_send',
  press: 'press_option',
  write_ask: 'write_ask',
  stop: 'stop',
}

/**
 * ★ **这一下算哪一种动作:第一次派,还是重派**(2026-10-02,接线那张卡;契约的 `Job.attempt`)。
 *
 * 交接「引擎核心」第六节第 4 条留的那个口子:`GATE_LIMITS.dispatch_resend`(2 回、隔一分钟)
 * 在引擎里没有调用方,因为 `Job` 不带「这是第几次派」。契约 10-02 加了 `attempt` 那一格之后,
 * 判法收在这一处:**派活、而且这是第二次起** = 重派。
 *
 * 为什么只有派活有这一档:重派是「同一件交代再送一遍给同一家」(她点卡再派一次、自查没过打回);
 * 替她答 / 捎话那几样没有「重派」这个概念 —— 她说第二句话就是第二句话,不是把第一句再送一遍。
 */
export function jobGateActionOf(job: Job): GateAction {
  if (job.kind === 'dispatch' && (job.attempt ?? 1) >= 2) return 'dispatch_resend'
  return JOB_GATE_ACTION[job.kind]
}

/**
 * **三种结局记在账上的哪一步**(`jobLog.JobStep` 那张表,不新加一步 —— 加一步要改 `jobLog.ts`)。
 *
 * - `confirmed` → `seen`:有证据(协议回执 / 记录文件多出那条 / 窗口里看见了);
 * - `unconfirmed` → `sent`:按了发送、证据没核上(四步表上照旧算「投递」,`why` 里写明没核上);
 * - `not_sent` → `not_sent`:**一个字都没送出去**(2026-10-02 接线那张卡给 `jobLog` 加的那一步;
 *   从前暂借 `unreadable`,于是账上分不出「那扇窗读不到」与「这一家压根没这条通道」)。
 *   ★ 闸拦下的那一下**不记这一步** —— 闸自己已经记了 `gate_block`,再记一条等于把同一件事记成两回,
 *   而且会在四步表的「完成」那一格留下一个不是事实的收场。
 */
export const JOB_LOG_STEP: Readonly<Record<JobResult['delivered'], JobStep>> = {
  confirmed: 'seen',
  unconfirmed: 'sent',
  not_sent: 'not_sent',
}

/**
 * ★ **电脑锁着屏、而且这一件排上队了:账上记 `waiting`,不记 `not_sent`**
 * (2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 理由写在 `jobLog.JobStep` 的 `waiting` 那一格上,最要紧的一条是**闸**:
 * `not_sent` 算收场,一记上去,解锁之后那一下重送会被「收场了就不再动那一家」拦下。
 *
 * **没排上队**(这台没接那本队、或者排不进去)照旧记 `not_sent` —— 那一下真的没了,不许装作在等。
 */
export const JOB_LOG_STEP_WAITING: JobStep = 'waiting'

/**
 * **哪几种活锁着屏时排队等解锁**:她自己那句话那两种 + 派活。
 *
 * - **替她答 / 捎话排**:那是她打出来的一句话,不排就是**弄丢了**
 *   （2026-10-03 09:04 那一回就是这么丢的);
 * - **点她那个选项 / 写提问面板 / 按停止不排**:那几下是「此刻那扇窗上有那颗键」才成立的事,
 *   隔了半小时解锁再按,那个弹框早就不在了(按下去等于按在别的东西上)。如实说没做,她再点一次;
 * - ★ **派活排**(2026-10-12,卡「锁屏派活排队」;10-03 那一版不排,理由是「另一只手成了会派两遍」)。
 *   现在派两遍的三条缝都补上了:
 *   ① 窗口那只手撞上锁屏,**不靠窗口的手(命令行 / 接口)接着试**,成了就不排(见 `run` 里那一段);
 *   ② 排队按**这件事**去重(事项 id + 派给哪家,`lockQueue.lockQueueKey`):再派一次是换掉那一条,不排第二条;
 *      同一件事经别的手送成了 → 排着那条**撤掉**并记一行({@link LOCK_WITHDRAW_LOG});
 *   ③ 解锁重送之前问一句「这件事还在等吗」(`drainLockQueue` 的 `stillWanted`,判据是卡上的事实)。
 *   只有带 `Job.waitUnlock` 且有事项 id 的派活才排 —— 解锁后要回到派活的正常流程,只有 `dispatchRun` 那一条路接得住。
 */
/** 这几种路会在她那家 App 之外另起一段(答案不进 App 里的对话):锁屏时派活不改走它们(维护者 10-12 拍板)。 */
export const OUTSIDE_APP_VIAS: ReadonlySet<string> = new Set(['api', 'cli'])

export const LOCK_QUEUE_KINDS: readonly JobKind[] = ['answer', 'relay', 'dispatch']

export { LOCK_WITHDRAW_LOG }

/** 这一件锁着屏时排不排(种类对、派活还要明说 `waitUnlock` 且有事项 id)。 */
export function lockQueueable(job: Job): boolean {
  if (!LOCK_QUEUE_KINDS.includes(job.kind)) return false
  if (job.kind !== 'dispatch') return true
  return job.waitUnlock === true && job.itemId !== undefined && job.itemId.trim() !== ''
}

/** 证据那一格记在账上的短话(不是她的话)。 */
export const EVIDENCE_WHY: Readonly<Record<NonNullable<JobResult['evidence']>, string>> = {
  receipt: '协议回执',
  transcript: '记录文件里多出那条',
  window: '它窗口里看见了',
  none: '没有证据',
}

/** 适配器没给 `why` 的「未确证」记在账上的那一句。 */
export const UNCONFIRMED_WHY = '按了发送,证据没核上'

/**
 * **哪几步要记一行日志**(结局那三步 + 「排着等解锁」那一步;见 {@link EngineDeps.warn})。
 *
 * `waiting`(2026-10-03)也记:维护者 09:04 那一回之所以只能靠对比三次日志才看出是锁屏,
 * 就是因为账上只有一句「一扇标准窗口都没有」——「它在等解锁」这件事必须在日志里看得见。
 */
export const ENGINE_LOGGED_STEPS: readonly JobStep[] = ['sent', 'seen', 'not_sent', 'waiting']

/**
 * ★ **一条通道都没用上时 `via` 记哪一格**(2026-10-02:契约加了 `'none'` 之后就是它)。
 *
 * 交接「引擎核心」第六节第 1 条留的那个口子:从前契约里 `via` 只有四种通道,一条都没用上时只能
 * 挑一条「登记了的第一条」顶上 —— 而那是在说一条压根没走过的路。契约 468b8ec4 加了 `'none'`
 * (「一条通道都没用上」),所以这一格现在说实话。
 */
export const VIA_WHEN_NONE: JobResult['via'] = 'none'

/** 这一样该怎么跟她说(**不新写一张中文表**:用闸那一份)。 */
export function jobActionText(kind: JobKind): string {
  return GATE_ACTION_TEXT[JOB_GATE_ACTION[kind]]
}

/**
 * 这一家一条能办这件事的通道都没有。
 *
 * `why` = 各条通道自己报的「此刻为什么用不上」(`Adapter.unavailable`)。有就照它说 ——
 * 「**工作台 App 没连上**」与「这台**没装**它」下一步做的事完全不同(一个去开壳,一个去装那一家),
 * 混成一句通用的就等于把 D13 那条「查不到不许冒充没有」又犯一次。
 */
export function engineNoChannelSay(who: string, kind: JobKind, why: readonly string[] = []): string {
  const tail = why.length === 0 ? '它没装 / 没开,或者这一样它做不了' : why.join(';')
  return `${who} 在这台电脑上没有一条能${jobActionText(kind)}的通道 —— ${tail}`
}

/** 试过的通道都说「这一样我做不了」。 */
export function engineUnsupportedSay(who: string, kind: JobKind, last?: string): string {
  const tail = last === undefined || last.trim() === '' ? '' : `它说:${last}`
  return `${who} 的通道都做不了${jobActionText(kind)}这一样${tail === '' ? '' : ` —— ${tail}`}`
}

/** 这一家一条**读得回话**的通道都没有(**不许说成「它还没回」**)。 */
export function engineNoReadSay(who: string): string {
  return `${who} 在这台电脑上没有一条读得到回话的通道 —— 读不到,不是它没回`
}

/** 这一家没有一条开得到窗的通道(「去回答」那颗键于是摆不出来)。 */
export function engineNoRevealSay(who: string): string {
  return `${who} 这台电脑上没有窗口可以调到前面`
}

/** 这一家没有「看一眼权限弹框」这一样。 */
export function engineNoApprovalSay(who: string): string {
  return `${who} 这一路看不了那个权限弹框上有哪几颗键`
}

/** 可重试的失败试到顶了(窗口一直没露面、协议一直没起来)。 */
export function engineGaveUpSay(who: string, kind: JobKind, input: { tries: number, last?: string }): string {
  const tail = input.last === undefined || input.last.trim() === '' ? '' : ` —— 它说:${input.last}`
  return `${who} 这一下${jobActionText(kind)}试了 ${input.tries} 回、每回都等了它一下,还是没成${tail}`
}

export interface EngineDeps {
  registry: AdapterRegistry
  /**
   * 动作闸。**不是可选的** —— 可选就等于留了一条不过闸的旁路,而「闸只接在引擎一处」是这张卡的全部意思。
   */
  gate: ActionGate
  /** 任务日志。同上:不落账的旁路就查不回那四步。 */
  log: JobLog
  /** 家名(人话)。缺席就用家名 id 原样。 */
  name?: (family: string) => string
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /**
   * 一条通道最多跑几回(含第一回)。默认 {@link ENGINE_MAX_RETRIES} = 3,
   * 与 `windowWake.NO_WINDOW_WAKE_TRIES` 的 3 回同源(契约里那个常量的注释就是这么写的)。
   */
  maxTries?: number
  /**
   * ★ **结局那一行往哪记**(缺席 = `console.log`)。
   *
   * 2026-10-02(卡「引擎接线与删复制品」):`http.ts` 里原来有 **11 处**各自手拼的
   * `[answer]` / `[relay]` / `[approval]` / `[dispatch]` 日志行(审计第二表第 17 条:
   * 只盯不发、去回答两路一个字不记;电话里点普通选项也记成 `[approval]`;六只手不写 sent/replied)。
   * 现在**只有这一处**:每一次 `run` 的结局记一行,带时间、这件事、哪一家、哪个包、什么动作、结局、为什么。
   * **她那句话一个字不记**(与 `jobLog.ts` 第三条纪律同源)。
   */
  warn?: (line: string) => void
  /**
   * ★ **电脑锁着屏时那几件活排的队**(2026-10-03,卡「锁屏时窗口型的家送不进」;
   * 那一本在 `engine/lockQueue.ts`)。
   *
   * 窗口那一层撞上锁屏回 `screenLocked`(契约那一格),引擎在这儿**排一条**、账上记 `waiting`,
   * 并把那句人话换成「解锁了我就送进去」。缺席 = 不排(如实说没送,行为与 2026-10-03 之前一字不差)。
   *
   * 只排 {@link lockQueueable} 认的那几件(她那句话 + 带 `waitUnlock` 的派活);点键那几样不排,理由见 {@link LOCK_QUEUE_KINDS}。
   */
  lockQueue?: {
    /** 排一条;回「排上了没有」(排不上就不许跟她说「我会送」)。`reason` = 为什么排的(2026-10-23:`'closed'` = 等它醒)。 */
    add: (job: Job, reason?: LockQueueReason) => boolean
    /**
     * 同一件派活经别的手送成了:把排着的那条撤掉,回撤没撤(2026-10-12)。缺席 = 不撤(老宿主)。
     */
    withdraw?: (job: Job) => boolean
  }
  /**
   * ★ **第三档证据:那条会话自己的记录文件里多没多出她那句**(卡 AW 的三档里最硬的那一档;
   * 设计第三节写明「记录文件由引擎与那两个协议适配器管」)。
   *
   * 为什么在引擎这一层:窗口那一层只看得见那扇窗(`evidence:'window'`),而 Claude / Codex / Kimi
   * 的会话**有本机记录文件** —— 从窗口送进去的那一句核不上时,回文件里再核一次就是最硬的那一档。
   * 只在 `via === 'window'` 的结局上走这一下(协议那两条自己已经核过记录文件了,再核一遍只是白等)。
   *
   * 缺席 = 这一档关着,行为与没有它时一字不差。
   */
  transcript?: {
    /** 送之前她在这条会话里说过的那几句(`undefined` = 这条会话在本机**没有**记录文件)。 */
    said: (job: Job) => Promise<readonly string[] | undefined>
    /** 送完等记录文件里多出她那句(上限、节拍由实现自己定)。 */
    confirm: (job: Job, before: readonly string[]) => Promise<boolean>
    /** 有记录文件、却没多出她那句时那一句人话(**不说成送到了,也不当没送**)。 */
    why: (job: Job) => string
  }
  /**
   * ★ **每一家一条窗口通道**(2026-10-21,卡「派活按家隔离」;`familyLanes.ts`)。
   *
   * 窗口那一条通道(`via === 'window'`)的每一下 `read` / `run` 都在**那一家自己的通道里**做:
   * 同一家排队、不同家互不等,每一下有硬上限,超了回 `jammed`(账上记一行 `jammed`)、放开通道。
   * 堵着的那一家读窗先跳过(连闸都不问),到了再探的时候才放一下。协议 / 命令行 / 接口不进这里。
   * 缺席 = 不隔离(行为与 2026-10-21 之前一字不差)。
   */
  lanes?: Pick<FamilyLanes, 'run' | 'due'>
}

export interface Engine {
  /** 做这一件。**绝不抛**:每一种失败都是一个 {@link JobResult}。 */
  run: (job: Job) => Promise<JobResult>
  /**
   * ★ **只读一眼那一段此刻的回话**(「盯着等回话」那条巡检用它;2026-10-02 接线那张卡把
   * `relayWatch.pump` 与 `dispatchRun.checkWindow` 的读窗段收到这儿)。
   *
   * **不送、不点、不叫台前、不开窗**;闸走 `reply_watch` 那一样(节拍、二十分钟的预算仍在巡检那一层)。
   * 拦下 / 这一家一条读得到的通道都没有 → 没有 `reply` + 一句实话,**绝不把「读不到」说成「它还没回」**。
   */
  read: (job: Job) => Promise<AdapterReadResult & { blocked?: true }>  // `jammed` 见 AdapterReadResult
  /**
   * ★ **只看一眼它那个权限弹框上有哪几颗键**(手机上打开那张卡时念给她听;一颗都不按)。
   * 闸在适配器那一层(`approval_read`,与真按下去那一颗的 `approval` 分成两样)。
   */
  readApproval: (job: Job, options: { active: boolean }) => Promise<ApprovalReadResult>
  /**
   * ★ **「去回答」:把那一段开到她眼前**(一个字都不送)。
   * 闸走 `bring_front`(在适配器那一层 —— 开窗 / 叫台前只存在于那一层)。
   */
  reveal: (job: Job) => Promise<{ ok: boolean, how: 'link' | 'pick' | 'app' | 'none', why?: string }>
}

/**
 * **这一件事的键**(`jobKey.ts` 那一处定法,这里只是照它取):
 * 有事项就用事项 id;没有事项、送进某一段对话的用会话键;连对话都还没有的(新开一条)用这一件自己的 id
 * —— 那种键 `jobPhaseOf` 查不出收场没有,于是是 `unknown`(照旧放行,次数照算),不编一个。
 */
export function engineJobKey(job: Job): string {
  if (job.itemId !== undefined && job.itemId.trim() !== '') return job.itemId
  if (job.target.kind === 'session') return sessionJobId(job.family, job.target.sessionId)
  return job.id
}

export function createEngine(deps: EngineDeps): Engine {
  const who = (family: string): string => deps.name?.(family) ?? family
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const warn = deps.warn ?? ((line: string) => { console.log(line) })
  const maxTries = deps.maxTries ?? ENGINE_MAX_RETRIES

  /** 记一行(键、哪一家、哪个包、什么动作)。 */
  function note(input: { key: string, job: Job, pick?: AdapterPick, step: JobStep, why?: string }): void {
    const event = deps.log.append({
      job: input.key,
      step: input.step,
      family: input.job.family,
      action: jobGateActionOf(input.job),
      // 走的哪条通道(2026-10-03):换过路账上看得出来 —— 两条 `assigned` 各带一条。
      ...(input.pick === undefined ? {} : { via: input.pick.adapter.via }),
      ...(input.pick?.bundle_id === undefined ? {} : { bundle_id: input.pick.bundle_id }),
      ...(input.why === undefined || input.why === '' ? {} : { why: input.why }),
    })
    // ★ **成没成都记一行**(维护者 10-02:「一修一个不吱声」)。指派 / 回了那两步不记:
    // 指派紧跟着就有结局那一行,「回了」那一行会把盯窗那几百拍刷满一屏。
    if (ENGINE_LOGGED_STEPS.includes(input.step)) warn(jobLogLine(event))
  }

  /** 结局落账:投递那一格 + 回了那一格。 */
  function record(key: string, job: Job, pick: AdapterPick | undefined, result: JobResult): void {
    const why = result.delivered === 'confirmed'
      ? (result.evidence === undefined ? undefined : EVIDENCE_WHY[result.evidence])
      : result.delivered === 'unconfirmed'
        ? (result.why ?? UNCONFIRMED_WHY)
        : result.why
    note({
      key,
      job,
      ...(pick === undefined ? {} : { pick }),
      step: JOB_LOG_STEP[result.delivered],
      ...(why === undefined ? {} : { why }),
    })
    if (result.reply !== undefined && result.reply.trim() !== '') {
      note({ key, job, ...(pick === undefined ? {} : { pick }), step: 'replied' })
    }
  }

  /**
   * ★ **第三档证据**(见 {@link EngineDeps.transcript}):窗口那一层说「按了发送、核不上」时,
   * 回那条会话自己的记录文件里再核一次 —— 多出了她那句就是 `confirmed`(证据 `transcript`,最硬的一档);
   * 没多出来**照旧 `unconfirmed`**,只把 `why` 换成「有记录文件、却没看到这句话」那一句。
   *
   * 只对 `via === 'window'` 走:协议那两条(Claude socket / Codex app-server)自己已经核过记录文件 / 回执了。
   */
  async function confirmed(job: Job, before: readonly string[] | undefined, out: JobResult): Promise<JobResult> {
    const transcript = deps.transcript
    if (transcript === undefined || before === undefined) return out
    if (out.delivered !== 'unconfirmed' || out.via !== 'window') return out
    const seen = await transcript.confirm(job, before).catch(() => false)
    if (!seen) return { ...out, why: transcript.why(job) }
    const { why: _dropped, ...rest } = out
    void _dropped
    return { ...rest, delivered: 'confirmed', evidence: 'transcript' }
  }

  /**
   * ★ **这台电脑上哪几家不靠窗口**(协议型那几条通道的家名,人话)。
   *
   * 锁着屏时那句话的最后半句要它:「要现在就办,只能 Claude / Codex 这种不靠窗口的家」——
   * **名字由登记处现查**(`via:'protocol'` 的那几条),代码里一个 App 的名字都不写死
   * (同窗口适配器那条纪律)。这一家自己不算进去(它这会儿正撞在锁屏上)。
   */
  function protocolNames(family: string): readonly string[] {
    try {
      const names: string[] = []
      for (const adapter of deps.registry.all()) {
        if (adapter.via !== 'protocol' || adapter.family === family) continue
        const name = who(adapter.family)
        if (!names.includes(name)) names.push(name)
      }
      return names
    }
    catch { return [] }
  }

  /**
   * ★ **锁着屏的那一下**(2026-10-03):排一条 → 账上记一步 → 换那句人话。
   *
   * 排上了记 `waiting`(这件事**还开着**,闸才不会在解锁之后把重送拦下);
   * 排不上(这台没接那本队 / 点键那几种不排 / 队满了)照旧记 `not_sent` —— 那一下真的没了,
   * **不许装作在等**(许了才说得出「解锁了我就送」)。
   */
  function locked(key: string, job: Job, pick: AdapterPick | undefined, out: JobResult): JobResult {
    const queued = lockQueueable(job) && (deps.lockQueue?.add(job) ?? false)
    const why = screenLockedSay({
      agentName: who(job.family),
      queued,
      protocols: protocolNames(job.family),
      ...(job.kind === 'dispatch' ? { what: 'dispatch' as const } : {}),
    })
    note({
      key,
      job,
      ...(pick === undefined ? {} : { pick }),
      step: queued ? JOB_LOG_STEP_WAITING : JOB_LOG_STEP.not_sent,
      why,
    })
    return { ...out, delivered: 'not_sent', screenLocked: true, why, ...(queued ? { lockQueued: true as const } : {}) }
  }

  /**
   * ★ **那条会话没开着的那一下**(2026-10-23,卡「捎话到没开着的会话留言等它醒」):
   * 与 {@link locked} 同款 —— 排一条 → 账上记一步 → 换那句人话。
   *
   * 排上了记 `waiting`(这件事**还开着**,它一开重送才不会被闸拦下),`why` = 留言那句
   * (`SESSION_CLOSED_QUEUED_SAY` 一处);排不上(这台没接那本队 / 点键那几种不排 / 队满了)
   * 照旧记 `not_sent`、照适配器原话如实说 —— 那一下真的没了,**不许装作留言留住了**。
   */
  function closed(key: string, job: Job, pick: AdapterPick | undefined, out: JobResult): JobResult {
    const queued = lockQueueable(job) && (deps.lockQueue?.add(job, 'closed') ?? false)
    const why = queued ? SESSION_CLOSED_QUEUED_SAY : (out.why ?? '那条会话没开着')
    note({
      key,
      job,
      ...(pick === undefined ? {} : { pick }),
      step: queued ? JOB_LOG_STEP_WAITING : JOB_LOG_STEP.not_sent,
      why,
    })
    return { ...out, delivered: 'not_sent', sessionClosed: true, why, ...(queued ? { lockQueued: true as const } : {}) }
  }

  /**
   * ★ **同一件派活送成了:排着等解锁的那条撤掉**(2026-10-12)。所有通道都过这一处,
   * 所以「另一只手成了」只在这儿认一次;撤了才记那一行(没排着就一声不吭)。
   */
  function withdrawQueued(job: Job, out: JobResult): void {
    if (job.kind !== 'dispatch' || out.delivered === 'not_sent') return
    if (deps.lockQueue?.withdraw?.(job) !== true) return
    warn(`${LOCK_WITHDRAW_LOG}:${job.family} · 这件事经${VIA_TEXT[out.via]}送成了,解锁后不再送`)
  }

  /** 一条通道跑到底:只有 {@link RetryableError} 才再来一回,最多 {@link maxTries} 回。 */
  async function attempt(job: Job, pick: AdapterPick): Promise<JobResult> {
    let tries = 0
    let last: string | undefined
    while (tries < maxTries) {
      tries += 1
      try {
        return await pick.adapter.run(job)
      }
      catch (error) {
        if (!(error instanceof RetryableError)) {
          // 别的失败**一回都不重试**(契约:适配器只许把「这一下可以再来一次」那种抛成 RetryableError)。
          return { delivered: 'not_sent', via: pick.adapter.via, evidence: 'none', why: messageOf(error) }
        }
        last = error.message
        if (tries >= maxTries) break
        await sleep(error.waitMs)
      }
    }
    return {
      delivered: 'not_sent',
      via: pick.adapter.via,
      evidence: 'none',
      why: engineGaveUpSay(who(job.family), job.kind, { tries, ...(last === undefined ? {} : { last }) }),
    }
  }

  /**
   * 窗口那一条走那一家的通道(见 {@link EngineDeps.lanes});超了上限 = 没送、带 `jammed`,账上记一行。
   * 别的通道原样 `attempt`。
   */
  async function attemptInLane(key: string, job: Job, pick: AdapterPick): Promise<JobResult> {
    if (deps.lanes === undefined || pick.adapter.via !== 'window') return await attempt(job, pick)
    const laned = await deps.lanes.run(job.family, 'send', () => attempt(job, pick))
    if (laned.ok) return laned.value
    if (laned.why === 'jammed') note({ key, job, pick, step: 'jammed', why: laned.say })
    return { delivered: 'not_sent', via: pick.adapter.via, evidence: 'none', why: laned.say, ...(laned.why === 'reset' ? {} : { jammed: true as const }) }
  }

  return {
    async run(job) {
      const key = engineJobKey(job)
      const picks = await deps.registry.picksFor(job).catch((): readonly AdapterPick[] => [])
      if (picks.length === 0) {
        const result: JobResult = {
          delivered: 'not_sent',
          via: VIA_WHEN_NONE,
          evidence: 'none',
          unsupported: true,
          why: engineNoChannelSay(who(job.family), job.kind, deps.registry.whyNotFor(job.family)),
        }
        record(key, job, undefined, result)
        return result
      }
      /*
       * ★ 过闸:**一件事问一次**(见文件头)。拦下的那一下就到这儿 ——
       * 一条替代的路都不许走(旧代码里闸拦下会漏进「另一条路」,`sessionAnswer.handBlocked` 防的就是这个),
       * 而且**不再补记一行**:闸自己已经记了 `gate_block`,再记等于在四步表上多一个不是事实的收场。
       */
      const first = picks[0] as AdapterPick
      const verdict = deps.gate.allow({
        job: key,
        family: job.family,
        // 第一次派 / 重派两档(契约的 `Job.attempt`;判法只在 `jobGateActionOf` 一处)。
        action: jobGateActionOf(job),
        ...(first.bundle_id === undefined ? {} : { bundle_id: first.bundle_id }),
        // 她亲手交代的那一下(卡 Y):闸的「收场了」那一条对它不拦。
        ...(job.by === undefined ? {} : { by: job.by }),
        // 那一句原话(卡「捎话节流闸误拦」):relay_send 靠它认「同一句」去重。
        ...(job.text === undefined || job.text.trim() === '' ? {} : { text: job.text }),
      })
      /*
       * ★ **同一句刚捎过、被静默合并**(2026-10-23,卡「捎话节流闸误拦」):闸把窗口内同一件事 · 同一句
       * 原话的重试并进同一回 —— 这一下**一个字都不再送**。不是失败(`blocked` 缺席),是重复;
       * 消费方照「已按这一句办过」回(捎话那一路回 ok + `RELAY_DEDUPED_NOTE`),账上一个字都不记。
       */
      if (verdict.ok && verdict.deduped === true) {
        return { delivered: 'not_sent', via: first.adapter.via, evidence: 'none', why: RELAY_DEDUPED_NOTE, deduped: true }
      }
      /*
       * 闸拦下:`blocked` 那一格说清「这是闸,不是那扇窗上的事实」——
       * 消费方见了它**一条替代的路都不许走**(契约 `JobResult.blocked` 那一段)。
       */
      if (!verdict.ok) return { delivered: 'not_sent', via: first.adapter.via, evidence: 'none', why: verdict.say, blocked: true }
      /*
       * ★ 第三档证据的**底子**:送之前先记下她在这条会话里说过哪几句(见 {@link EngineDeps.transcript})。
       * 只有「她指名了某一段对话、而且要送字进去」才取 —— 新开一条还没有那条会话,点一下键没有字可核。
       */
      const wantTranscript = deps.transcript !== undefined && job.target.kind === 'session' && job.expect !== 'none'
      const before = wantTranscript ? await deps.transcript?.said(job).catch(() => undefined) : undefined
      let lastUnsupported: JobResult | undefined
      /** 派活里**没送成**的那几条通道各自的原因(按通道念:「窗口:…;接口:…」),见下面「备用」那一段。 */
      const failed: string[] = []
      /** 派活里撞上锁屏的那一下(后面不靠窗口的手都没成,才按它排队 / 说话)。 */
      let lockedAt: { pick: AdapterPick, out: JobResult } | undefined
      /** 派活里那条会话没开着的那一下(2026-10-23;同 {@link lockedAt},按「等它醒」排队 / 说话)。 */
      let closedAt: { pick: AdapterPick, out: JobResult } | undefined
      for (const [at, pick] of picks.entries()) {
        /*
         * 窗口已撞上锁屏 / 那条会话已说「没开着」:**不改走 App 之外的路**(接口 / 命令行另起一段,
         * 答案不进她那家 App 里的对话 —— 维护者 10-12 拍板「等解锁再发进 App」;留言那条同理)。
         * 跳过它们,最后按锁屏 / 等它醒排队。
         */
        if ((lockedAt !== undefined || closedAt !== undefined) && OUTSIDE_APP_VIAS.has(pick.adapter.via)) {
          if (at < picks.length - 1) continue
          if (closedAt !== undefined) return closed(key, job, closedAt.pick, closedAt.out)
          // 进这个分支的条件是 lockedAt / closedAt 至少有一个 → 到这一句时锁屏那一下一定在。
          return locked(key, job, lockedAt?.pick, lockedAt!.out)
        }
        // 指派:这一件交给了这一家的这一条通道(换路时账上多一条 —— 换过路看得出来)。
        note({ key, job, pick, step: 'assigned' })
        const out = await confirmed(job, before, await attemptInLane(key, job, pick))
        /*
         * ★ **电脑锁着屏**(2026-10-03,卡「锁屏时窗口型的家送不进」):
         * 替她答 / 捎话那几样**一条替代的路都不许走**(换一条通道不是同一段对话),排进队、账上记 `waiting`、
         * 把那句人话换成最终版(只有这儿知道排上队没有、这台还有哪几家不靠窗口)。
         *
         * ★ 派活(2026-10-12):接着试后面那几条里**仍进同一个 App 对话**的(协议那种);接口 / 命令行不试
         * (见循环开头 `OUTSIDE_APP_VIAS`),一条都没成就排队。
         * 后面若还有窗口通道,它自己在第一道门就拦下(一个 op 都不发),不会弹窗。
         */
        if (out.screenLocked === true) {
          if (job.kind !== 'dispatch') return locked(key, job, pick, out)
          lockedAt ??= { pick, out }
          if (at < picks.length - 1) continue
          return locked(key, job, lockedAt.pick, lockedAt.out)
        }
        /*
         * ★ **那条会话没开着**(2026-10-23,卡「捎话到没开着的会话留言等它醒」):
         * 与锁屏同款 —— 替她答 / 捎话**一条替代的路都不许走**(那条会话没开,换一条通道也认不出这段对话),
         * 排进队、账上记 `waiting`、那句人话换成「这句我留着,它一开就送进去」。
         * 派活同 {@link out.screenLocked} 那一段(仍进同一个 App 对话的接着试,接口 / 命令行不试)。
         */
        if (out.sessionClosed === true) {
          if (job.kind !== 'dispatch') return closed(key, job, pick, out)
          closedAt ??= { pick, out }
          if (at < picks.length - 1) continue
          return closed(key, job, closedAt.pick, closedAt.out)
        }
        if (out.unsupported !== true) {
          /*
           * ★ **派活的「备用」规矩**(2026-10-03,卡「派活三只手收进引擎」):窗口没送成(没窗口 / 输入框没接住)、
           * 队里还有下一条通道 → 接着试 —— 命令行 / 接口就是为这一刻留的(维护者 09-22:聊天的活命令行给 Codex 当备用;
           * 接口是豆包 / GPT 的备用)。只有派活这一种这么走:替她答 / 捎话指的是那一段对话,换条通道不是同一件事。
           * 闸拦下(`blocked`)与锁屏不在此列(上面已经回了)。每一条的结局都落账,最后那句把各条的原因按通道接起来
           * (卡上要看得到每只手各卡在哪,念给她听的只有第一段 —— 卡 CF 第 8 条,截那一刀在嘴那一侧)。
           */
          if (job.kind === 'dispatch' && out.delivered === 'not_sent' && out.blocked !== true) {
            record(key, job, pick, out)
            failed.push(`${VIA_TEXT[pick.adapter.via]}:${out.why ?? '没送成'}`)
            if (at < picks.length - 1) continue
            // 窗口那一下是锁屏、后面的手也没成:按锁屏办(排队 / 说「解锁了…」),不说成「运行失败」。
            if (closedAt !== undefined) return closed(key, job, closedAt.pick, closedAt.out)
            if (lockedAt !== undefined) return locked(key, job, lockedAt.pick, lockedAt.out)
            return { ...out, why: failed.join(';') }
          }
          record(key, job, pick, out)
          withdrawQueued(job, out)
          return out
        }
        // 换路:这一条说「这一样我做不了」,队里还有下一条就接着走(Claude 的 press:socket → 窗口)。
        lastUnsupported = out
      }
      /*
       * 队里每一条都说「这一样我做不了」—— 如实回没送,`unsupported` 留着,上层照它说话。
       * 派活里前面有没送成的那几条,它们的原因一并带上(`unsupported` 这时不留:真有一条试过、没成)。
       */
      if (closedAt !== undefined) return closed(key, job, closedAt.pick, closedAt.out)
      if (lockedAt !== undefined) return locked(key, job, lockedAt.pick, lockedAt.out)
      const last = picks[picks.length - 1]
      const tail = engineUnsupportedSay(who(job.family), job.kind, lastUnsupported?.why)
      const result: JobResult = {
        delivered: 'not_sent',
        via: last?.adapter.via ?? VIA_WHEN_NONE,
        evidence: 'none',
        ...(failed.length === 0 ? { unsupported: true } : {}),
        why: failed.length === 0 ? tail : [...failed, tail].join(';'),
      }
      record(key, job, last, result)
      return result
    },

    /**
     * ★ **只读一眼**(见 {@link Engine.read})。与 `run` 的三处不同,每一处都是故意的:
     * ① 挑通道按「**读**得到」挑(`need:'read'`),不按「送得进」—— 自绘界面那一类送得进、读得到,
     *    而协议型(Codex `thread/resume` / Claude 记录文件)读得更准,`comparePicks` 的通道次序照旧先协议;
     * ② 闸走 `reply_watch`(一拍一回,上限 1000 回、隔 3 秒 —— 不是送话那几样的 30 回);
     * ③ **不落账**:一条会话要读几百次,每次记一行等于把那本账冲掉(回了那一行由巡检自己记 `replied`)。
     */
    async read(job) {
      const picks = await deps.registry.picksFor(job, { need: 'read' }).catch((): readonly AdapterPick[] => [])
      const readable = picks.filter(one => one.adapter.read !== undefined)
      const first = readable[0]
      if (first === undefined) {
        return { via: VIA_WHEN_NONE, evidence: 'none', why: engineNoReadSay(who(job.family)) }
      }
      // 堵着的那一家、还没到再探的时候:一个壳 op 都不发,连闸都不问(不白扣次数)。
      const lanes = deps.lanes
      if (lanes !== undefined && first.adapter.via === 'window' && !lanes.due(job.family)) {
        const skipped = await lanes.run(job.family, 'read', () => Promise.resolve(undefined))
        if (!skipped.ok) return { via: first.adapter.via, evidence: 'none', why: skipped.say, jammed: true }
      }
      const verdict = deps.gate.allow({
        job: engineJobKey(job),
        family: job.family,
        action: 'reply_watch',
        ...(first.bundle_id === undefined ? {} : { bundle_id: first.bundle_id }),
      })
      // 闸拦下:这一拍一个 op 都不发(**不改账、不说成「它还没回」**);为什么拦下闸自己记了。
      if (!verdict.ok) return { via: first.adapter.via, evidence: 'none', why: verdict.say, blocked: true }
      /*
       * ★ **换路也在读这一侧**(2026-10-04,卡「Codex 线程被占时换路」):一条通道说
       * `unsupported`(这一段我此刻读不了 —— Codex 那条线程被她的 App 占着,`thread/resume` 都进不去)
       * 就接着问队里下一条(读窗那条照样读得到)。与 `run` 同一个由头、同一个封顶(队尾为止)。
       *
       * **闸只问一次**(同 `run` 的「一件事问一次」):换路那两下相隔只有几毫秒,每下都问
       * 会被 `reply_watch` 的节拍拦死 —— 等于把这一样又弄坏。
       */
      let last: AdapterReadResult | undefined
      for (const pick of readable) {
        let out: AdapterReadResult
        const readOnce = (): Promise<AdapterReadResult> => (pick.adapter.read as NonNullable<typeof pick.adapter.read>)(job)
        try {
          if (lanes !== undefined && pick.adapter.via === 'window') {
            const laned = await lanes.run(job.family, 'read', readOnce)
            if (laned.ok) out = laned.value
            else {
              if (laned.why === 'jammed') note({ key: engineJobKey(job), job, pick, step: 'jammed', why: laned.say })
              // 堵了 / 被重置撤了:这一拍就到这儿(**不换下一条通道去读** —— 那不是「这一段我读不了」)。
              return { via: pick.adapter.via, evidence: 'none', why: laned.say, ...(laned.why === 'reset' ? {} : { jammed: true as const }) }
            }
          }
          else out = await readOnce()
        }
        catch (error) { out = { via: pick.adapter.via, evidence: 'none', why: messageOf(error) } }
        if (out.unsupported !== true) return out
        last = out
      }
      // 队里每一条都说「这一段我读不了」:如实回最后那一句(**不说成「它还没回」**)。
      return last ?? { via: first.adapter.via, evidence: 'none', why: engineNoReadSay(who(job.family)) }
    },

    /**
     * ★ **「去回答」**(见 {@link Engine.reveal})。挑通道按「**开得到**那一段 / 开得到那扇窗」挑
     * (`open`):协议那两条开不了窗(Claude 的深链要桌面 App 里那个编号,也在窗口那一层),
     * 所以实际上走的是窗口那一条。一家都开不到就如实说。
     */
    async reveal(job) {
      const picks = await deps.registry.picksFor(job, { need: 'open' }).catch((): readonly AdapterPick[] => [])
      const pick = picks.find(one => one.adapter.reveal !== undefined)
      if (pick === undefined) {
        return { ok: false, how: 'none' as const, why: engineNoRevealSay(who(job.family)) }
      }
      try { return await (pick.adapter.reveal as NonNullable<typeof pick.adapter.reveal>)(job) }
      catch (error) { return { ok: false, how: 'none' as const, why: messageOf(error) } }
    },

    /** ★ **只看一眼那个权限弹框上有哪几颗键**(见 {@link Engine.readApproval})。闸在适配器那一层。 */
    async readApproval(job, options) {
      // 挑通道按「**会不会看**那个权限弹框」挑(`approve`),不是按「会不会点它明写的那一项」(`press`)。
      const picks = await deps.registry.picksFor(job, { need: 'approve' }).catch((): readonly AdapterPick[] => [])
      const pick = picks.find(one => one.adapter.readApproval !== undefined)
      if (pick === undefined) {
        return { panels: [], via: VIA_WHEN_NONE, why: engineNoApprovalSay(who(job.family)) }
      }
      try { return await (pick.adapter.readApproval as NonNullable<typeof pick.adapter.readApproval>)(job, options) }
      catch (error) { return { panels: [], via: pick.adapter.via, why: messageOf(error) } }
    },
  }
}

/** 适配器抛出来的那句原话(不是 Error 的也说得出)。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
