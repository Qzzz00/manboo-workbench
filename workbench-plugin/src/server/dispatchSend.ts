/**
 * ★ **派活送话后面换成引擎**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 这一份接的是 `docs/交接-1002-引擎核心.md` 第四节那张对照表的派活那一半:
 * `/dispatch/client`、`/dispatch/run` 的送话段、`relayNewConversation`、`/devtool/confirm` 派活、
 * `materializeService` 那条兜底派活 —— 它们打的都是 {@link ClientDispatch.send} 这一个口,**回包形状一个字没改**。
 *
 * ## 删掉的那一份
 *
 * `dispatchClient.sendOnce`(挑包 → 过闸 → 拉起来 → 叫台前 → 存草稿 → 打字发送 → 读窗核实)
 * 与外面那一层**自己 for 循环换包**全删。现在:
 *
 * | 那一步 | 现在在哪 |
 * |---|---|
 * | 挑哪一个包、送不进去换另一个 | `engine/adapters/window.ts`(决定在适配器,循环在引擎) |
 * | 拉起来、叫台前、没窗口就开窗 | 同上一处(`ensureRunning` + `windowWake`) |
 * | 存草稿、替她关掉挡着的那层框 | 同上一处(`JobResult.draft` / `.modalClosed`) |
 * | 过闸(第一次派 / 重派两档)、落账、重试 | `engine/engine.ts` 一处 |
 * | 读窗核「真发出去了」 | 同上(`delivered` 三种结局) |
 *
 * 留在这里的只有**派活自己的事**:那句话归哪张卡、送出那一刻的会话基线(认新会话用)、
 * 卡上那一格(`TaskClientDispatch`)怎么写、派不出去那几句人话。
 */
import type { ClientDispatchFamily, TaskClientDispatch } from '../protocol.ts'
import { pickFamilyPackage } from './agentSources.ts'
import { isClientDispatchFamily } from '../protocol.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { dispatchReadiness, fallbackTargets } from './dispatchTargets.ts'
import type { UnreadableApp } from './dispatchTargets.ts'
import { classifyFailure, FAILURE_HINTS, isRealSessionId, type DispatchFailureKind } from './dispatchClient.ts'
import type { Engine } from './engine/engine.ts'
import type { Job, JobResult, WorkKind } from './engine/adapter.ts'
import { SEND_RECEIPT_UNSURE } from './engine/adapters/window.ts'

export interface SendToClientInput {
  family: string
  text: string
  /**
   * ★ **这一送是为哪一件事**:事项 id。动作闸靠它查「这件事此刻还动不动得」
   * (办完 / 取消 / 撤了 → 一下都不动那一家),也靠它数「同一件事对同一家来过几回」。
   * 缺席 = 这一件没有卡(电话里「新开一条发给 X」那一种)→ 用这一送自己的 id 当键。
   */
  job?: string
  /**
   * ★ **这一送是「再来一回」**(2026-10-02,卡 AG2)。判「是不是重派」只看**卡上有没有上一次**(证据),
   * 不看谁调的、不按话里有没有「重派」这个词。缺席 = 按第一次算。
   *
   * 2026-10-02 起它只做一件事:把 `Job.attempt` 填成 2 —— 引擎据此过闸里 `dispatch_resend` 那一档
   * (2 回、隔一分钟;判法在 `engine.jobGateActionOf` 一处)。
   */
  resend?: boolean
  /**
   * 送完要不要替她按发送。**缺省 false**(2026-09-22 A2:她自己在界面上点「送进窗口」的那一种不按)。
   *
   * ★ 窗口适配器那一条**永远按发送**(`send_text` 的 `submit:true`),所以 `submit:false` 这一路
   * 在引擎上**走不通** —— 真有人要「只写进框、不发出去」时如实回一句,不假装写进去了。
   */
  submit?: boolean
  /** 送完把用户原来在台前的那个应用换回去。缺省 false(留在台前,人才看得见字进去了)。 */
  restoreFront?: boolean
  /**
   * 送之前先按那家菜单里的「新对话」(2026-09-24,卡 F)。缺省 false(老调用方一字不变)。
   * 派活一律要开:不开,话就打进她此刻正开着的那条对话 —— 那是她自己的会话。
   */
  newConversation?: boolean
  /** **发完拿这一截字在它的对话区里核一眼**(卡 WR)。核实在窗口适配器里,这一格只是记号。 */
  confirmMarker?: string
  /** **她的原话**:只用来挑「一家装着两个 App 时派给哪一个」(挑法在 `agentSources.pickFamilyPackage` 一处)。 */
  said?: string
  /** **她明说了「盖掉」**。输入框里有她没发出去的字时照送、不再先存草稿。缺省 false。 */
  overwrite?: boolean
  /**
   * ★ 派活那几格(2026-10-03,卡「派活三只手收进引擎」),原样放进 `Job`:
   * `work` 这件活是哪一种(引擎按它挑通道:写代码只走命令行、在电脑上动手只走窗口);
   * `cwd` / `project` 在哪儿干(命令行起进程的地方、接口的上下文);`brief` 她的原话(接口那条只送这个)。
   */
  work?: WorkKind
  cwd?: string
  project?: string
  brief?: string
  /**
   * 名片带了才给(2026-10-22 卡 D):命令行那家照它拼参数 —— claude `--model`、kimi `-m` + `--agent-file`、
   * codex `-m`(模型名 / 智能体文件路径,拼法在 `agentDispatch.dispatchCommand` 一处)。
   */
  model?: string
  effort?: 'low' | 'medium' | 'high'
  attemptId?: string
  vias?: Job['vias']
  agentFile?: string
  /**
   * **这次不带 `--agent-file`**(2026-10-29,任务书「派活智能体文件与起跑换手」):智能体文件解析过、
   * 不存在或这一件走用户层那条路 → 命令行适配器连缺省那一份也不给 kimi 加。与 {@link agentFile} 二选一。
   */
  agentFileOmit?: boolean
  /**
   * **续跑接原会话**(2026-10-23,卡「派活给名片的四处」③;契约 `Job.target:{kind:'session'}`):
   * 到时长上限他说「继续」,上一次命令行活留下的会话号照原样接着(Kimi `--session` / Claude `--resume`)。
   * 只有 `dispatchRun` 那一条带;窗口那只手不认这一格(写代码的活只走命令行)。
   */
  resumeSessionId?: string
  /**
   * ★ **这一下是她亲手点出来的**(2026-10-28,任务书「取消要收场执行者」):卡取消时对窗口手
   * 捎的那句「这件取消了,停下」就是**她点取消那一下**带出来的,不是工作台自动追的管线 —
   * 闸的「收场了就不再动那一家」对它不拦(与引擎 `Job.by` 那份同一语义)。缺席 = 自动的,照旧拦。
   */
  by?: 'user'
  /**
   * ★ **锁着屏就排队等解锁**(2026-10-12,卡「锁屏派活排队」;契约 `Job.waitUnlock`)。
   * 只有 `dispatchRun` 那一条带(解锁后它接得住「回到派活的正常流程」);要配 {@link job}。
   */
  waitUnlock?: true
}

export interface SendToClientResult {
  ok: boolean
  dispatch?: TaskClientDispatch
  /**
   * ★ 引擎的原始结局(2026-10-03)。命令行 / 接口那两条通道的结局不长成窗口那份记录
   * (`TaskClientDispatch` 是 `hand:'window'` 那一套),调用方按 `result.via` 写卡:`cli` → `result.process`,`api` → `result.reply`。
   */
  result?: JobResult
  /** 送出那一刻那家的会话 id 基线——调用方要把它存着,之后拿去 `matchNewSession`。 */
  baseline?: readonly string[]
  /** **按了发送,可这会儿还没在它对话区里看见那句话**(只是一句要告诉她的话,**不改状态**)。 */
  confirm_note?: string
  reason?: string
  kind?: DispatchFailureKind
  /** 叫台前 / 替她关掉挡着那层框那几步的结果(不影响成败,如实说一句)。 */
  front_note?: string
  /** **这一家装着两个 App,派给的是哪一个**(卡 DP)。 */
  package_note?: string
  /** **真送进去的那个包**(2026-09-30 晚,故障 ③)。回电巡检按它读窗。 */
  bundle_id?: string
  /**
   * ★ **电脑锁着屏,这一件排着队等解锁**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 为什么要这一格、为什么这一下**不往卡上写 `dispatch`**:`TaskClientDispatch.status` 只有
   * `sent` / `typed` / `failed` 三档,而这一件**既没送出去、也没失败,它在等** ——
   * 写 `failed` 等于在卡上留一句不是事实的话(解锁之后它会自己送出去)。
   * 所以上一层(`dispatchRun`)据此把卡挂**「等你处理」**(她去解锁就好),而不是「运行失败」。
   *
   * 排没排上看 {@link lock_queued}(2026-10-12 起派活也排,条件与理由在 `engine.LOCK_QUEUE_KINDS`)。
   */
  screen_locked?: true
  /** ★ 锁着屏、这一件**真排上队了**(引擎 `JobResult.lockQueued`):卡上挂「在等你解锁电脑」,解锁后自动重派。 */
  lock_queued?: true
  /*
   * ★ **「这一次怎么开到前台」那一格没有了**(2026-10-02,卡「引擎接线与删复制品」)。
   *
   * 卡 AX3 加过一格 `front`(深链 / 侧栏点 / 叫台前、又开了几回窗、壳回的窗口状态),
   * 只进日志那一行。现在那一行由引擎一处记(`engine.ENGINE_LOGGED_STEPS`),而契约里
   * `JobResult` 没有这一格 —— 「又开了几回窗」那句实话由 `windowWake.noWindowWhy` 接进 `why`,
   * 照旧进那一行。所以这一格是死的,删掉;要把它做成结构化的一格,得先改契约(另一张卡)。
   */
}

export interface ClientDispatch {
  send: (input: SendToClientInput) => Promise<SendToClientResult>
}

export interface ClientDispatchDeps {
  /** 一条引擎(`engine/wire.ts` 造的那一份)。 */
  engine: Engine
  /** 那家此刻的会话 id(基线用)。读不到就回空数组。 */
  sessionIdsOf: (family: ClientDispatchFamily) => readonly string[]
  /**
   * 能接活的每一家(卡 Z:Agent 登记表算出来的那一份 `dispatchTargets`)。
   * 缺席 = 老宿主 / 用例:退回「写过专门接法、装着的那几家」。
   */
  targets?: () => readonly DispatchTarget[]
  /**
   * **认出是 AI 应用、可那扇窗读不到**的那几家(2026-10-01)。送之前当场回那一句人话,不去翻窗、不重试。
   */
  unreadable?: () => readonly UnreadableApp[]
  now: () => Date
}

export function createClientDispatch(deps: ClientDispatchDeps): ClientDispatch {
  return {
    async send(input) {
      const family = input.family
      /*
       * ★ **读不到它窗口的那一家:一个字都别试**(2026-10-01,卡「派给读不到的那家当场说」)。
       * 那一句与派活、与电话里「能派谁」出自同一个函数(`dispatchReadiness`)。
       */
      const targetsNow = deps.targets?.() ?? fallbackTargets()
      if (deps.unreadable !== undefined) {
        const blocked = dispatchReadiness({ family, targets: targetsNow, unreadable: deps.unreadable() })
        if (!blocked.ok && blocked.unreadable === true) return { ok: false, reason: blocked.why, kind: 'not_allowed' }
      }
      /*
       * ★ 2026-09-28(卡 CF):这一句与派活那一层、与电话里答「能派谁」**出自同一个函数**
       * —— 以前这里自己拼一遍,于是真机上出现了「现在能派的是 豆包工作」紧接着「豆包办公 没接上」。
       */
      /*
       * ★ 没有本机 App 的那几家也能送(2026-10-03,卡「派活三只手收进引擎」):只走接口的 GPT 没有包标识,
       * 从前这里一刀「没有包 = 没接上」就把它拦在引擎外面;现在看的是**候选名单上这一家有没有一只不靠窗口的手**。
       * 有包照旧按包挑窗(卡 DP);两样都没有才是「没接上」。
       */
      const target = isClientDispatchFamily(family) ? targetsNow.find(one => one.id === family) : undefined
      if (target === undefined || (target.bundle_id === undefined && !target.hands.some(hand => hand !== 'window'))) {
        const known = dispatchReadiness({ family, targets: targetsNow })
        const reason = known.ok ? `这台电脑上还没接上 ${family},这句话没送出去` : `${known.why},这句话没送出去`
        return { ok: false, reason, kind: 'not_allowed' }
      }
      const text = input.text
      if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, reason: '要送的话是空的,没送', kind: 'other' }
      }
      // 基线**必须在送之前取**:送完再取,那条刚开的会话就已经混进基线里了。
      const baseline = deps.sessionIdsOf(family as ClientDispatchFamily).filter(isRealSessionId)
      const at = deps.now().toISOString()
      /** 她原话里点名了某个包专有的说法没有(挑法在 `pickFamilyPackage` 一处;只认 `why:'said'` 那一种)。 */
      const named = pickFamilyPackage({
        family,
        ...(input.said === undefined ? {} : { said: input.said }),
        // 没有本机 App 的那几家(只走接口的 GPT)一个包都没有 —— 挑包那一步自然挑不出,`Job.package` 缺席。
        installed: target.packages ?? (target.bundle_id === undefined ? [] : [{ bundle_id: target.bundle_id }]),
      })
      const said = named?.why === 'said' ? named.bundle_id : undefined
      const job: Job = {
        // 没有卡的那一种(电话里「新开一条」)用这一送自己的 id —— `jobPhaseOf` 对它答「查不出」(放行),不编一个。
        id: input.job ?? `dispatch:${family}:${at}`,
        family,
        kind: 'dispatch',
        /*
         * 新开一条 / 送进它此刻开着的那条(返工那一下、`/dispatch/client` 没要求新开那一种)。
         * 窗口适配器只在 `new` 那一种发 `new_conversation` —— 与老的 `newConversation` 那一格逐字同义。
         * 续跑接原会话(2026-10-23 卡「派活给名片的四处」③):带了会话号就指明那一条
         * (命令行那只手照它 `--session` / `--resume`;写代码的活只走命令行,窗口那只手见不到它)。
         */
        target: input.resumeSessionId !== undefined
          ? { kind: 'session', sessionId: input.resumeSessionId }
          : input.newConversation === true ? { kind: 'new' } : { kind: 'current' },
        text,
        expect: 'ack',
        /*
         * ★ **替不替她按发送**(2026-09-22 A2):她自己在界面上点「送进窗口」那一种不按
         * (`submitForSource('ui')` / 统一输入框「先问我」那一档)。
         * 缺席 = **不按**(老调用方一字不变:送错一句话撤不回来,缺省站在「不按」那一边)。
         */
        submit: input.submit === true,
        // 送完核那一眼按**卡上记着的那个记号**(盯窗那条巡检后来按的就是它)。
        ...(input.confirmMarker === undefined || input.confirmMarker.trim() === '' ? {} : { confirmMark: input.confirmMarker }),
        ...(input.job === undefined ? {} : { itemId: input.job }),
        // 重派:引擎据此过闸里 `dispatch_resend` 那一档(2 回、隔一分钟)。
        ...(input.resend === true ? { attempt: 2 } : {}),
        /*
         * ★ **她点名了哪一个包**(卡 DP:「豆包工作 / 豆包办公」= `com.work.pc.doubao`)。
         *
         * 挑法只在 `pickFamilyPackage` 一处;这里只把**她点名的那一种**(`why:'said'`)带过去 ——
         * 契约里 `Job.package` 的意思就是「她点名了哪个」,而**点名的不许换包**
         * (窗口适配器三道门里的第二道)。她没点名就不带,让适配器自己按装机 / 开着挑、送不进去可以换。
         */
        ...(said === undefined ? {} : { package: said }),
        // 派活那几格(2026-10-03):引擎按 `work` 挑通道;命令行 / 接口那两条要 `cwd` / `project` / `brief`。
        ...(input.work === undefined ? {} : { work: input.work }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        // 名片带的模型与智能体文件(2026-10-22 卡 D):原样进 Job,命令行适配器照它拼参数。
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.vias === undefined ? {} : { vias: input.vias }),
        ...(input.agentFile === undefined ? {} : { agentFile: input.agentFile }),
        ...(input.agentFileOmit === true ? { agentFileOmit: true as const } : {}),
        ...(input.by === undefined ? {} : { by: input.by }),
        ...(input.waitUnlock === true && input.job !== undefined ? { waitUnlock: true as const } : {}),
      }
      const out = await deps.engine.run(job)
      /*
       * ★ 命令行 / 接口那两条通道(2026-10-03):结局原样交给调用方按 `result.via` 写卡(`dispatchRun`)——
       * 它们没有「包」「回执」「草稿」那几样窗口的事。送到没送到照旧看 `delivered`;闸拦下照旧 `not_allowed`。
       */
      if (out.via === 'cli' || out.via === 'api') {
        if (out.delivered === 'confirmed') return { ok: true, result: out }
        const why = out.why ?? '没送成'
        return { ok: false, result: out, reason: why, kind: out.blocked === true ? 'not_allowed' : classifyFailure(why) }
      }
      const bundleId = out.bundle_id ?? target.bundle_id
      /**
       * ★ **这一家装着两个 App,派给的是哪一个**(卡 DP):两个同名的图标摆在坞上,不说她不知道去哪扇窗看。
       * 只在真的装着两个以上时说;名字取**真送进去那个包**自己的显示名。
       */
      const packages = target.packages ?? []
      const packageNote = packages.length < 2
        ? undefined
        : `你这台电脑上装着 ${packages.length} 个${target.title},这次派给的是「${packages.find(one => one.bundle_id === bundleId)?.name ?? bundleId}」那一个`
      /** 要当场告诉她的那几句(替她关了框、草稿存哪了)。 */
      const told = [out.modalClosed, out.draft?.note].filter((one): one is string => one !== undefined && one !== '')
      if (out.delivered === 'not_sent') {
        const reason = out.why ?? (out.screenLocked === true ? FAILURE_HINTS.screen_locked : '没送成')
        return {
          ok: false,
          result: out,
          reason,
          /*
           * ★ **电脑锁着屏**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
           *
           * 这一格让上一层分得出「窗口型的家这会儿送不进」与「那扇窗上的事实」:
           * `dispatchRun` 据此把卡挂**「等你处理」**(她去解锁就好),而不是「运行失败」。
           *
           * 排没排上照引擎那一格(2026-10-12 起派活也排,条件见 `engine.lockQueueable`)。
           */
          ...(out.screenLocked === true ? { screen_locked: true as const } : {}),
          ...(out.lockQueued === true ? { lock_queued: true as const } : {}),
          /*
           * ★ **闸拦下的那一下归 `not_allowed`**:它不是那扇窗上的事实(没窗口 / 输入框没接住),
           * 而是工作台**不许**这一下(这件事收场了 / 到顶了)。归成 `other` 会让上一层按
           * 「没送成,再试试」说话,而正确的下一句是「要再来一次你说一声」。
           */
          kind: out.blocked === true ? 'not_allowed' : classifyFailure(reason),
          ...(told.length === 0 ? {} : { front_note: told.join(';') }),
          dispatch: { hand: 'window', family, status: 'failed', at, text, reason, ...(bundleId === undefined ? {} : { bundle_id: bundleId }) },
        }
      }
      /**
       * ★ **要我们按发送、可它没发出去 → 记 `typed`,绝不记 `sent`**(2026-09-28,卡 WR;这一道是硬的)。
       * 判据是壳那条回执(`JobResult.submitted`)或者在对话区里亲眼看见了(`delivered:'confirmed'`)——
       * 两样都没有才是「字进了框、没发出去」。
       */
      /*
       * 判据与 2026-09-28 卡 WR 那一处逐字同义:**她要我们按发送、而它没发出去**才记 `typed`。
       * 她本来就只要「写进框里」(`submit:false`,A2)那一种记 `sent` —— 字送进去了,这就是她要的。
       */
      const wantedSubmit = input.submit === true
      const submitted = out.submitted === true || out.delivered === 'confirmed'
      const status: TaskClientDispatch['status'] = wantedSubmit && !submitted ? 'typed' : 'sent'
      /** 按了发送、这会儿还没在对话区里看见那一句:**说一句**,不假装亲眼看见了,也不改状态。 */
      const confirmNote = status === 'sent' && out.delivered !== 'confirmed' ? out.why : undefined
      const dispatch: TaskClientDispatch = {
        hand: 'window',
        family,
        status,
        // 回执没确认 ≠ 没发出去(豆包真机:发出去了回执还说没发)—— 说实话,别叫她重发一遍。
        /*
         * 回执没确认 ≠ 没发出去(豆包真机:发出去了回执还说没发)—— 说实话,别叫她重发一遍。
         * 那句话只有一份(`window.SEND_RECEIPT_UNSURE`),引擎原样带上来,这里不另写一句。
         */
        ...(status === 'typed' ? { reason: out.why ?? SEND_RECEIPT_UNSURE } : {}),
        at,
        text,
        ...(out.draft === undefined ? {} : { draft: out.draft }),
        // 字是怎么进去的(排障用:真机上「打属性」与「粘贴」两条路的毛病不一样)。
        ...(out.method === undefined ? {} : { method: out.method }),
        ...(input.submit === undefined ? {} : { submitted }),
        baseline,
        /*
         * 「新开一条」那一下壳到底怎么开的(原样记在卡上)。Muse 那种只有一条对话的 App
         * 报的是 `single_thread` —— 卡上那句话据此说「它只有一条对话,送进了那一条」,
         * 不许对她说「新开了一条对话」。
         */
        ...(out.newConversation === undefined ? {} : { new_conversation: out.newConversation }),
        /*
         * ★ **协议那条路当场就知道送进了哪一段**(2026-10-02 真机那一跑查出来的)。
         *
         * Codex 的 `thread/start` 回的就是那条新线程的 id(`JobResult.sessionId`),Claude socket
         * 那条也认得出那条会话 —— 丢掉它的后果真机上看得见:卡上 `session_id` 空着,
         * 四秒一拍的盯窗于是拿 `target:{kind:'current'}` 去问协议,而协议**认不出她此刻开着哪一条**
         * (`codex.say` 那一句「协议认不出它此刻开着的是哪一条对话」),于是那句回答永远收不回来 ——
         * 真机上 Codex 10 秒就答完了「一周有七天。」,卡上却一直是「等它回」。
         *
         * 这一格比盯窗那边的差集 / 记号猜(`matchNewSession` / `sessionByMarker`)硬得多:
         * 它是对端自己报的号。所以**记上它就不再猜**(`checkWindow` 看见 `session_id` 就跳过认会话那一步)。
         */
        ...(out.sessionId === undefined || out.sessionId.trim() === ''
          ? {}
          : { session_id: out.sessionId, matched_at: deps.now().toISOString() }),
        // 哪一轮也是对端自己报的(2026-10-03):读回话只认这一轮,她自己又发了一句也不认错。
        ...(out.turnId === undefined || out.turnId.trim() === '' ? {} : { turn_id: out.turnId }),
        ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
        ...(out.delivered === 'confirmed' ? { seen_at: deps.now().toISOString() } : {}),
        ...(confirmNote === undefined ? {} : { confirm_note: confirmNote }),
      }
      /*
       * ★ **草稿那一句不进 `confirm_note`**(2026-10-13,卡 F;四场景验收第 15 条)。
       *
       * 它已经在卡上那一格里(`dispatch.draft.note`),上一层(`dispatchRun`)按那一格拼话;
       * 这里再给一遍的后果 10-13 真机上看见了 ——「你在豆包办公输入框里没发出去的那句我存在这里了:…」
       * 在同一条 `dispatch_note` 里说了两遍。**一句话只许有一个说的人**。
       * 界面上「送进窗口」那一下当场要说的照旧走 `front_note`(那条路不读卡)。
       */
      const notes = [
        ...(out.modalClosed === undefined || out.modalClosed === '' ? [] : [out.modalClosed]),
        ...(confirmNote === undefined ? [] : [confirmNote]),
      ]
      return {
        ok: true,
        dispatch,
        baseline,
        ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
        ...(told.length === 0 ? {} : { front_note: told.join(';') }),
        ...(notes.length === 0 ? {} : { confirm_note: notes.join(';') }),
        ...(packageNote === undefined ? {} : { package_note: packageNote }),
      }
    },
  }
}
