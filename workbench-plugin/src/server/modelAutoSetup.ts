/**
 * 「注册/登录成功那一刻,自动把模型服务接上」(2026-09-18,决策记录同日
 * 「新用户零凭据:模型服务令牌要在注册那一刻自动领」)。
 *
 * Ben 09-18 真机:清空凭据之后 `/model` 回的是 `mode:'relay'` 但 `relay_token_configured:false`
 * —— 默认值说得没错,只是**没人去领那把令牌**,他得自己进设置点一下「用工作台提供的服务」。
 * 新用户不该被要求点这一下;他压根不知道「模型服务」是什么。
 *
 * 这个模块只做三件事,一件都不许拖住登录:
 *
 * 1. **kick()**:注册/登录成功之后**不 await** 地跑一遍 `model.autoSetup()`。
 *    领令牌要打一次网络,而那台服务器可能慢、可能没部署好 —— 让它挡在
 *    `POST /account/login` 的响应前面,等于把"登不进去"的风险绑在一件可有可无的事上。
 * 2. **alert()**:上一次试过、没成 → `/state.setup_alerts.model_service` 那一格为真,
 *    顶上那条横幅说「模型服务还没接上」并给一颗「重试」。
 *    **没试过是 undefined,不是 false**(同 setup_alerts 那两格的老规矩:「没查过」不是「没缺」)。
 * 3. **restartIfPending()**:刚往 DSH 的 `.env` 写过令牌时,替他 `launchctl kickstart -k` 一次。
 *
 * ## 关于那一下重启:为什么只在"没有会话在跑"的时候
 *
 * 工作台插件**跑在 DSH 这个进程里**(同 update/apply.ts 里那句"这一下会把跑着这个作业的
 * 进程杀掉")。所以 kickstart 杀的不只是事务官的运行时,还有工作台自己:页面会断几秒再回来。
 * 正在跑的 DSH 会话会当场没掉 —— 那是用户的活儿,不能替他决定丢掉。
 * 所以:**有会话就不重启**,把一句人话交回去让界面说;没有会话(新用户的常态,他还没开始干活)
 * 才真的重启,而且是在"引导开始之前"这个最不碍事的时刻。
 *
 * ## 凭据纪律
 *
 * 这里从头到尾碰不到令牌:`model.autoSetup()` 回来的是 `ModelStatusView`(只有布尔与数字)。
 * 日志里只写"接上了/没接上"与那句人话,不写地址、不写令牌。
 */
import type { ModelAutoSetupResult, ModelService, ModelUpdateResult } from './modelService.ts'
import { OWN_DEFAULT_BASE_URL, OWN_DEFAULT_MODEL } from './modelConfig.ts'
import { DSH_LAUNCHD_LABEL } from './setup/paths.ts'
import { ONBOARDING_RESTARTING_NOTE } from '../protocol.ts'

export interface ModelAutoSetupDeps {
  model: ModelService
  /**
   * 跑一条命令。生产接 setup 那套 io.exec;不传就**不重启**(测试与"这台机器上没有 launchd"
   * 都走这条,而不是假装重启过了)。
   */
  exec?: (cmd: readonly string[]) => Promise<{ ok: boolean }>
  /** 当前用户的 uid,拼 `gui/<uid>/<label>` 用。不传就 process.getuid。 */
  uid?: () => number
  /**
   * 这会儿 DSH 里有几条会话在跑。生产接 `service.getState().sessions` 里 agent==='dsh' 的条数。
   * 不传按"不知道"处理 —— **不知道就不重启**(宁可让人多等一次,也不能把他的活儿杀掉)。
   */
  dshSessionCount?: () => number | undefined
  /** 一行日志。默认什么都不写(同 relay 的 log)。 */
  log?: (line: string) => void
  /** 真发出 kickstart 之前等多久,让当前这个响应先出去。测试传 0。 */
  restartDelayMs?: number
}

/** 上一次自动接的结论。`undefined` = 还没跑过。 */
export interface ModelAutoSetupState {
  /** 真去领了没有。 */
  attempted: boolean
  /** 这会儿接上了没有(`status.ready`)。 */
  ready: boolean
  /** 没接上时那一句人话(领令牌失败的原因)。 */
  error?: string
}

export type RestartOutcome =
  | { restarted: false, reason: 'not_pending' }
  | { restarted: false, reason: 'busy', note: string }
  | { restarted: false, reason: 'no_exec' | 'failed', note: string }
  | { restarted: true, note: string }

export interface ModelAutoSetup {
  /** 注册/登录成功后叫一次。**不 await**,永远不抛。 */
  kick: () => void
  /** 真跑一遍并等它跑完(界面上那颗「重试」、以及用例用)。 */
  run: () => Promise<ModelAutoSetupResult>
  /** 上一次的结论;没跑过就 undefined。 */
  last: () => ModelAutoSetupState | undefined
  /**
   * `/state.setup_alerts.model_service` 那一格:**真 = 还没接上**(同那两格的口径:真 = 还缺着)。
   * 没跑过、或者压根不该自动接(他用自己的 Key)时 undefined —— 那一格随之缺席。
   */
  alert: () => boolean | undefined
  /**
   * 别处也把模型服务改过了(设置里那颗「用工作台提供的服务」/「重新领取」)——
   * 把上一次的结论换成这一次的(2026-09-18)。
   *
   * 不接这一条会出一幕很难查的事:自动那次没领到 → 顶上挂着「模型服务还没接上」→
   * 他进设置自己点了一下、成了 → **横幅还在那儿说着一句已经过期的话**。
   * 结论只有一份,谁改的都算数。顺带:那条路写 `.env` 时,重启也一样该排上队。
   */
  note: (result: ModelUpdateResult) => void
  /** DSH 的 .env 刚被写过、还没重启。 */
  restartPending: () => boolean
  /** 该重启就重启(有会话就不重启,把话交回去)。 */
  restartIfPending: () => Promise<RestartOutcome>
}

const BUSY_NOTE = '事务官那边还有活儿在跑,先不重启它。等它空下来,工作台会自己重启一次把新的模型服务接上。'
/** 与界面同一句(protocol.ts):预料之中的一步,灰字,不像报错(2026-09-24)。 */
const RESTART_NOTE = ONBOARDING_RESTARTING_NOTE

export function createModelAutoSetup(deps: ModelAutoSetupDeps): ModelAutoSetup {
  const log = deps.log ?? (() => {})
  const restartDelayMs = deps.restartDelayMs ?? 800
  let state: ModelAutoSetupState | undefined
  let pending = false
  /**
   * 重启已经发出去了(2026-09-24)。这个进程马上就要被换掉:这期间再来的 `/onboarding/session` 一律照样回
   * 「正在重启」,**不在这个快没了的进程里开会话**(开了会跟着一起没)。界面据此一直等到新进程回话。
   * kickstart 自己失败了就撤掉这面旗子,不把人永远挡在门外。
   */
  let restartFired = false
  /** 同一时刻只跑一遍:注册之后紧跟着一次 /account 轮询,不该变成两次领令牌。 */
  let running: Promise<ModelAutoSetupResult> | undefined

  async function once(): Promise<ModelAutoSetupResult> {
    const result = await deps.model.autoSetup()
    state = {
      attempted: result.attempted,
      ready: result.status.ready,
      /**
       * 哪一句是"为什么没接上":**第一句**,不是最后一句。
       * hints 的顺序是 `[领令牌那一句, ...DSH 那几句]` —— 领不到的时候最后一句是
       * 「还没领到凭证,事务官那一侧要等领到之后才真的能用」,那是**后果**;
       * 第一句才是原因(「领取太频繁了」「连不上模型服务」)。拿后果当原因,
       * 屏幕上就会出现一句谁也照着做不了的话。
       */
      ...(result.status.ready || !result.attempted
        ? {}
        : { error: result.error ?? result.hints[0] ?? '没能接上工作台提供的模型服务。' }),
    }
    if (result.dsh_restart_required === true) pending = true
    log(result.attempted
      ? `model auto-setup attempted ready=${result.status.ready}`
      : `model auto-setup skipped reason=${result.skipped ?? 'unknown'}`)
    return result
  }

  function run(): Promise<ModelAutoSetupResult> {
    if (running !== undefined) return running
    // 领令牌自己坏了(读不了文件、fetch 抛了)不能把登录带下去:兜住,记一条"没接上"。
    running = once()
      .catch((error: unknown) => {
        const name = error instanceof Error ? error.name : '未知错误'
        state = { attempted: true, ready: false, error: `接工作台提供的模型服务时出错(${name})。` }
        log(`model auto-setup failed: ${name}`)
        return {
          ok: false,
          attempted: true,
          status: {
            mode: 'relay', relay_url: '', relay_configured: false, relay_token_configured: false,
            own_key_configured: false, own_base_url: OWN_DEFAULT_BASE_URL, own_model: OWN_DEFAULT_MODEL, ready: false,
          },
          hints: [],
          error: state.error as string,
        } satisfies ModelAutoSetupResult
      })
      .finally(() => { running = undefined })
    return running
  }

  async function restartIfPending(): Promise<RestartOutcome> {
    if (restartFired) return { restarted: true, note: RESTART_NOTE }
    if (!pending) return { restarted: false, reason: 'not_pending' }
    const sessions = deps.dshSessionCount?.()
    // 「不知道有几条」与「有好几条」一样处理:不重启。宁可让人多等一次。
    if (sessions === undefined || sessions > 0) return { restarted: false, reason: 'busy', note: BUSY_NOTE }
    if (deps.exec === undefined) {
      return { restarted: false, reason: 'no_exec', note: '这台机器上没有可以重启事务官的办法,模型服务要等它下次自己重启才生效。' }
    }
    const uid = (deps.uid ?? (() => process.getuid?.() ?? 0))()
    const target = `gui/${uid}/${DSH_LAUNCHD_LABEL}`
    // 这一下会把**跑着这段代码的进程**一起换掉(工作台插件就住在 DSH 里,同 update/apply.ts),
    // 所以先把 pending 落下来、再延迟发出去,让当前这个响应有机会先出去。
    pending = false
    restartFired = true
    log(`model auto-setup kickstart ${target}`)
    const fire = (): void => {
      void deps.exec?.(['launchctl', 'kickstart', '-k', target])
        .then(result => { if (!result.ok) restartFired = false })
        .catch(() => { restartFired = false })
    }
    if (restartDelayMs <= 0) fire()
    else {
      const timer = setTimeout(fire, restartDelayMs)
      timer.unref?.()
    }
    return { restarted: true, note: RESTART_NOTE }
  }

  function note(result: ModelUpdateResult): void {
    // 没改成:上一次的结论仍然成立,不拿一次失败去覆盖它。
    if (!result.ok) return
    if (result.dsh_restart_required === true) pending = true
    if (result.status.mode === 'own') {
      // 他改成用自己的 Key 了 —— 这件事从此不归自动化管,那一格该**缺席**而不是变假。
      state = undefined
      return
    }
    state = {
      attempted: true,
      ready: result.status.ready,
      ...(result.status.ready ? {} : { error: result.hints[0] ?? '没能接上工作台提供的模型服务。' }),
    }
  }

  return {
    kick: () => { void run() },
    run,
    last: () => state,
    note,
    alert: () => {
      if (state === undefined) return undefined
      // 压根没去领(他用自己的 Key、或者早就接上了)时这一格不该出现:
      // 那不是"还差一件事",那是"这件事不归自动化管"。
      if (!state.attempted) return undefined
      return !state.ready
    },
    restartPending: () => pending,
    restartIfPending,
  }
}
