import { SEEDED_DEFAULT_MODEL } from './setup/paths.ts'
import type { LiveConfigRequest, LiveConfigRollback } from './dshLiveConfig.ts'
/**
 * 「模型」那一节背后的活儿(2026-09-17)。把三件事串起来:
 *
 *   1. `~/.dsh/workbench/model.json` —— 用哪一家、令牌存哪(modelConfig.ts);
 *   2. 中转 —— 第一次领令牌、问今日用量(同上);
 *   3. DSH 运行时 —— 它自己的那份设置(`dshSettingsStore.ts` 按装着的版本决定是 `settings.yaml`
 *      还是 profile 的补丁层)与 `~/.dsh/.env`(令牌)。
 *
 * 在线设置先完成 DSH 配置与受控会话的应用，再保存 model.json。失败拒绝保存与续聊，
 * 让工作台、工人与 DSH 不会把未完成的切换显示成成功。离线安装保留纯文件能力。
 *
 * ## 凭据纪律
 *
 * 令牌只在三个地方存在:model.json(0600)、`~/.dsh/.env`(交给 DSH 用)、内存。
 * 任何返回给浏览器的东西里都没有它(`modelStatusOf` 只回布尔),日志里也没有。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadCredentials } from './credentials.ts'
import { DSH_OWN_KEY_ENV, DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER, DSH_RELAY_TOKEN_ENV, removeEnvLine, upsertEnvLine } from './dshModelSettings.ts'
import { createDshSettingsStore } from './dshSettingsStore.ts'
import { ModelRetargetError, type ModelRetargetChange, type ModelRetargetRollback } from './modelRetarget.ts'
import type { ModelConfig, ModelStatusView } from './modelConfig.ts'
import {
  autoRelayDecision, deviceTokenBindingOf, fetchRelayUsage, loadModelConfig, modelEndpointOf,
  modelStatusOf, NO_RELAY_NOTE, OWN_DEFAULT_BASE_URL, OWN_DEFAULT_MODEL, ownEndpointOf, registerRelayDevice, relayConfigured,
  saveModelConfig,
} from './modelConfig.ts'

/** 没接中转时点了「用工作台提供的服务」(或「重新接一次」)回的那句。 */
export const NO_RELAY_MODEL_ERROR = `${NO_RELAY_NOTE},「用工作台提供的服务」用不了;填上你自己的 DeepSeek 密钥就能用。`

/** 用量拉取的节流窗口。设置弹窗每次打开都会 GET 一次,别把中转拉麻了。 */
const USAGE_TTL_MS = 15_000

/** DSH 的两个文件在哪。`dshHome` 缺省 `~/.dsh`;灰度实例与测试传别的。 */
/** DSH 凭据服务里工作台用得到的那两样(按名字存 / 删;不读值)。 */
export interface DshCredentialStore {
  set: (name: string, value: string) => Promise<unknown>
  unset: (name: string) => Promise<unknown>
}

export interface ModelServiceOptions {
  modelFile: string
  credentialFile: string
  /** `~/.dsh`。传 undefined = 不碰 DSH(测试与「这台机器上没装 DSH」都走这条)。 */
  dshHome?: string
  /** 账号文件(feat/account-login 那张卡的产物)。读不到就退回一个本机名字。 */
  accountFile?: string
  /**
   * 账号会话令牌(2026-09-21)。有它就带着去领设备令牌 —— 设备从此记在服务器上那个账号名下。
   * 没登录 / 这台中转没有账号服务时回 undefined,一切照旧走老路。
   */
  relaySession?: () => Promise<string | undefined>
  /**
   * 当前登录账号在中转那边的 scope(`acct:<账号 id>`,2026-09-27 卡 RM)。
   * 没登录 / 账号还在本机时回 undefined。**只用来比对**「手上那把令牌是不是这个账号的」,
   * 不进任何回包。
   */
  relayAccountScope?: () => Promise<string | undefined>
  /** 这台电脑叫什么(显示在「我的设备」里)。 */
  deviceName?: () => Promise<string | undefined>
  /**
   * DSH 自己的凭据服务(`ctx.credentials`,index.ts 注入;2026-10-01 Air 引导修复日志)。
   * 令牌存进这里**立即生效**(它盯着自己的文件、优先于 `.env`),不用重启 DSH;
   * 缺席 / 存不进(被启动环境挡着)才退回「写 .env + 挑空闲时重启」那条老路。只按名字存取,值不回传。
   */
  dshCredentials?: () => DshCredentialStore | undefined
  /**
   * 「**房间号换了**」(2026-09-27,卡 RM)。换了一把属于别的账号的设备令牌 =
   * 中转算出来的房间名跟着换,而**通话工人还在旧房间里坐着**:座机在新房间提机,
   * 它听不见。所以这一刀之后得有人把工人挪过去,那件事由 index.ts 接
   * (丢掉手上的通道凭据 + 重启工人)。这里只管喊一声,**不 await、不看结果**。
   */
  onRoomChanged?: (note: string) => void
  /**
   * 模型设置的 DSH 侧目标变了(2026-10-23 运行时 P1):切中转 / 自己端点 / 只换模型名 /
   * 恢复默认 —— 让 index.ts 把钉在受控路由上的会话重指过去
   * (modelRetarget.ts,走 DSH selectModel,保留会话上下文)。
   * `model` 缺席 = 目标模型名由接收方问 catalog 缺省(中转 / 默认官方);`prevModel` =
   * 「只换模型名」那一场被换掉的模型名(官方 provider 上正用它的会话要跟)。
   * 可返回本次成功会话的回滚闭包；部分失败抛 ModelRetargetError 保留同一补偿。
   */
  onModelTargetChanged?: (change: ModelRetargetChange) => Promise<void | ModelRetargetRollback> | void | ModelRetargetRollback
  /**
   * 宿主注入的 live reconciler (2026-10-23,卡「换Key运行时」)。
   * 交给 ConfigEditor 持久化并等待 DSH live reconciliation 完成。
   */
  liveReconcile?: ((request: LiveConfigRequest) => Promise<void | LiveConfigRollback>) | undefined
  liveDocPath?: (() => string | undefined) | undefined
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ModelUpdateResult {
  ok: boolean
  status: ModelStatusView
  /** 给用户看的话:领到令牌了、DSH 也切了、DSH 那边要重启、DSH 那边没切成…… */
  hints: string[]
  /** 整件事失败时的那一句(model.json 没写成,或这台没接中转却要切到中转)。 */
  error?: string
  /** `no_relay` = 这台没接中转,切不到「用工作台提供的服务」(8791 回 409,不是 500)。 */
  code?: 'no_relay'
  /**
   * DSH 的 `.env` 这一次真的被改过,**要重启一次那个进程才认**(2026-09-18)。
   * 以前这件事只以 hints 里那句人话存在,于是"要不要替他重启"这个判断只能去
   * 认字符串。现在是一个字段:`modelAutoSetup` 拿它决定要不要 kickstart。
   * 设置那一侧两代都是热加载,不进这一格 —— 只有 `.env` 要重启。
   */
  dsh_restart_required?: boolean
}

/** autoSetup 的结论。**没做**也是一种成功,而且要说得出为什么没做。 */
export interface ModelAutoSetupResult extends ModelUpdateResult {
  /** 真去领了(不管成没成)还是压根没动。 */
  attempted: boolean
  /** 没动时的原因,给日志与用例看;真动了就缺席。 */
  skipped?: 'no_relay' | 'own_mode' | 'already_linked' | 'own_key'
}

export interface ModelService {
  status: () => Promise<ModelStatusView>
  /**
   * 接没接上(= `status().ready`),**只看配置、不走网络**(2026-10-21)。`status()` 还要去中转查今天的用量,
   * 挂在每秒一拍的 `/state` 上的那几处(引导三件事)只要这一格,用它。
   */
  ready: () => Promise<boolean>
  update: (patch: {
    mode: 'relay' | 'own'
    relay_url?: string
    /** own 档自己接的端点(2026-10-23,卡「事务官换Key」);缺席 = 不动这两格。 */
    own_base_url?: string
    own_model?: string
  }) => Promise<ModelUpdateResult>
  /** 重新领一次令牌(令牌失效、换了服务器时用)。 */
  reissue: () => Promise<ModelUpdateResult>
  /**
   * 「注册/登录成功那一刻」调的那一份(2026-09-18)。要不要动由 `autoRelayDecision` 定,
   * 真要动时走的是**与设置里那颗按钮完全同一条** `applyMode` —— 两份实现迟早会漂,
   * 而这条路上漂掉的后果是"界面说接上了、DSH 那边没写"。
   */
  autoSetup: () => Promise<ModelAutoSetupResult>
  /**
   * 「这台设备在服务器那边得有个身份」(2026-09-21,通道凭据下发那张卡)。
   *
   * 中转令牌本来只为**模型**服务,所以 `autoRelayDecision` 有一条「他填了自己的 DeepSeek Key
   * 就不动」—— 那时候令牌确实只跟模型有关。现在它还是**取通道凭据的那张门票**
   * (server/channelCredentials.ts),于是「用自己的 Key」的人会连电话都打不了,
   * 而那跟他选了哪家模型一点关系都没有。
   *
   * 所以这一条:**只保证令牌在,不碰 mode、不碰 DSH 的设置、不碰 .env**。
   * 已经有令牌就一个字节都不动(重领会把旧的作废,手机上正通着的那条会当场断)。
   */
  ensureDeviceToken: () => Promise<{ ok: boolean, error?: string }>
  /**
   * **「登录 = 把这台机器挂到账号下」**(2026-09-27,卡 RM)。
   *
   * 叫它的有两处,一处都不能少:
   *   ① 登录 / 注册成功那一刻(serverAccount 的 `onLoggedIn`)—— 不能等下次启动,
   *      新装机器的主路径就是「装完 → 领 legacy 令牌 → 登录」,登录完人马上就要提机;
   *   ② 工作台每次启动(index.ts)—— 09-27 之前装的机器、以及登录时那一次领失败的,
   *      靠这一下自己恢复,用户什么都不用点。
   *
   * 要不要动由 `deviceTokenBindingOf` 定(纯函数,判据全在 modelConfig.ts)。
   * `changed: true` = 令牌真换了一把 → **房间号跟着换了**,调用方要让通道凭据重取、
   * 让通话工人重进房(index.ts 那一段)。
   *
   * 和 `ensureDeviceToken` 一样**不碰 mode、不碰 DSH 的设置与 .env**:绑的只是
   * 「这台机器在服务器上的身份」,与他选哪家模型无关。
   */
  bindToAccount: () => Promise<{ ok: boolean, changed: boolean, reason: string, error?: string }>
  /** 给别处用的「此刻该往哪发」。通道层工人自己读文件,这个是工作台内部要用时的口子。 */
  endpoint: () => Promise<ReturnType<typeof modelEndpointOf>>
  /**
   * 「此刻 DSH 侧目标」(2026-10-23 续聊对齐用):provider 必给;model 在明确知道时给
   * (自己端点 / 只换模型名 / 默认官方),relay 缺席(模型名由 catalog 缺省补)。纯读配置,不走网络。
   */
  target: () => Promise<ModelRetargetChange>
  /**
   * 「试一下」(2026-10-23,卡「事务官换Key」):用此刻该用的端点打一句话回来。
   * 成了才算接上。`message` 是人话(模型的半句话或一句错因),**永不带 key**。
   */
  try: () => Promise<{ ok: boolean, message: string }>
}

async function readTextOr(file: string, fallback: string): Promise<string> {
  try { return await readFile(file, 'utf8') }
  catch { return fallback }
}

/**
 * 账号名。账号体系还在本机(feat/account-login),这里**只读不写**,而且读不到也不算错:
 * 退回 `local-<设备 id 前 8 位>`,中转那边只拿它做分组与设备数封顶。
 * 账号搬到服务器之后这一条改成「带着登录态去换令牌」(交接第六节)。
 */
async function accountNameOf(accountFile: string | undefined, deviceId: string): Promise<string> {
  const fallback = `local-${deviceId.slice(0, 8)}`
  if (accountFile === undefined) return fallback
  try {
    const parsed = JSON.parse(await readFile(accountFile, 'utf8')) as Record<string, unknown>
    for (const key of ['username', 'name', 'account']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return fallback
  }
  catch { return fallback }
}

export function createModelService(options: ModelServiceOptions): ModelService {
  const fetchImpl = options.fetchImpl ?? fetch
  let applicationFailed = false
  let pendingRecovery: (() => Promise<void>) | undefined
  // 一条设置事务拥有其全部 awaits 与回滚；其它持久化入口也排在同一队列。
  let applicationQueue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const task = applicationQueue.then(run)
    applicationQueue = task.catch(() => undefined)
    return task
  }

  /**
   * 一个值存进 DSH 的凭据服务,**按名字**存(2026-10-23 退修):中转令牌是 WORKBENCH_RELAY_TOKEN,
   * 他自己那把 Key 是 WORKBENCH_OWN_MODEL_KEY —— 名字写死成中转那个,他的 Key 会盖掉中转令牌,
   * 两边就再也分不清了。存成了回 true;没接上 / 存不进回 false(调用方退回 .env + 重启那条路),
   * 失败**绝不冒充另一个名字的成功**。
   */
  async function storeInDsh(name: string, value: string): Promise<boolean> {
    const store = options.dshCredentials?.()
    if (store === undefined) return false
    try {
      await store.set(name, value)
      return true
    }
    catch { return false }
  }
  const now = options.now ?? Date.now

  /**
   * 领令牌时要不要带账号会话、带什么名字(2026-09-21)。
   * 取不到一律当成"没登录",**绝不抛** —— 领令牌这条路上多一个抛点,
   * 换来的是"新用户注册完模型服务没接上"这种最难查的失败。
   */
  async function deviceIdentity(): Promise<{ session?: string, name?: string, kind?: 'mac' }> {
    let session: string | undefined
    let name: string | undefined
    try { session = await options.relaySession?.() } catch { session = undefined }
    if (session === undefined) return {}
    try { name = await options.deviceName?.() } catch { name = undefined }
    return { session, ...(name === undefined ? {} : { name }), kind: 'mac' }
  }
  let usageCache: { at: number, result: Awaited<ReturnType<typeof fetchRelayUsage>> } | undefined
  /** 正在查的那一趟(2026-10-21):并发来问的共用它,不每人各发一趟。 */
  let usageInflight: Promise<Awaited<ReturnType<typeof fetchRelayUsage>>> | undefined

  async function ownKeyOf(): Promise<string | undefined> {
    return (await loadCredentials(options.credentialFile)).deepseek
  }

  /**
   * DSH 那一侧的设置与 `.env`。写不了就把原因当一句人话回去,绝不抛。
   *
   * **「设置在哪」不在这儿判**(2026-09-26,卡 U1b):0.1.7 把 `settings.yaml` 收进了 profile 的
   * 补丁层,两代运行时都可能装在用户机器上,判据与路径一律在 `dshSettingsStore.ts` 里 ——
   * 这里只管「切哪一边、令牌写不写、要不要重启」。
   *
   * `ownKey` 是他自己那把 Key(credentials.json 里那一个):own 档填了自己接的端点时,
   * 要把它交给 DSH 用(.env 的 WORKBENCH_OWN_MODEL_KEY + 凭据服务),所以这条路得带着它走。
   */
  async function applyToDsh(
    config: ModelConfig,
    ownKey?: string,
    previous?: ModelConfig,
  ): Promise<{ rollback?: LiveConfigRollback, hints: string[], switched: boolean, prevProvider?: string, prevModel?: string, restartRequired?: boolean }> {
    if (options.dshHome === undefined) return { hints: [], switched: false }
    const store = createDshSettingsStore({
      dshHome: options.dshHome,
      ...(options.liveReconcile === undefined ? {} : { liveReconcile: options.liveReconcile }),
      ...(options.liveDocPath === undefined ? {} : { liveDocPath: options.liveDocPath }),
    })
    const envFile = `${options.dshHome}/.env`
    const hints: string[] = []

    /**
     * `.env` 这一次有没有真被改过(2026-09-18)。只有它要重启 —— 设置那一侧两代都是热加载
     * (0.1.2 的 `settings.yaml`、0.1.7 的 profile 补丁层都有人盯着文件变化)。
     * 令牌本来就在 `.env` 里、这次一个字节都没动时,**不要报"要重启"**:
     * 那会让工作台在每一次登录之后都去 kickstart 一遍自己。
     */
    let envChanged = false
    let before = await store.readDefaultModel()
    const own = ownEndpointOf(config)
    // 「自己接的端点」= 地址不是官方缺省;「只换模型名」= 地址是官方但模型名不是缺省。
    // 两者都要 DSH 那一侧跟上(插件/工人已经跟了),只比地址会让 DSH 停在旧模型名上。
    const ownEndpointCustom = config.mode === 'own' && own.baseUrl !== OWN_DEFAULT_BASE_URL
    const ownModelCustom = config.mode === 'own' && own.model !== OWN_DEFAULT_MODEL
    // 全缺省、但此前替他写过 model 行 → 恢复他原来选的(见 config.dsh_prev_model)。
    const restoringPrevModel = config.mode === 'own' && !ownEndpointCustom && !ownModelCustom
      && config.dsh_prev_model !== undefined
    const priorTarget = previous === undefined ? undefined : dshTargetOf(previous)
    const restoreRelayModel = config.mode === 'relay' && previous?.mode === 'own'
      && priorTarget?.model !== undefined && before?.provider === priorTarget.provider && before.model === priorTarget.model
      ? previous.dsh_prev_model ?? SEEDED_DEFAULT_MODEL : undefined
    const edit = config.mode === 'relay'
      ? await store.applyRelay({ baseUrl: `${config.relay_url}/v1`, ...(restoreRelayModel === undefined ? {} : { model: restoreRelayModel }) })
      : ownEndpointCustom
        ? await store.applyOwnKey(config.dsh_prev_provider, { baseUrl: own.baseUrl, model: own.model })
        : ownModelCustom
          ? await store.applyOwnKey(config.dsh_prev_provider, { model: own.model })
          : restoringPrevModel
            ? await store.applyOwnKey(config.dsh_prev_provider, { model: config.dsh_prev_model as string })
            : await store.applyOwnKey(config.dsh_prev_provider)

    if (edit.ok && edit.rollback?.previousDefault !== undefined) before = edit.rollback.previousDefault
    if (!edit.ok) {
      hints.push(`事务官(DSH)那一侧没能自动切:${edit.error}`)
      // 没切成:DSH 还在旧路由上,受控会话照旧能用 —— 不重指(重指过去反而把它们弄断)。
      return { hints, switched: false }
    }

    const envBefore = await readTextOr(envFile, '')
    const rollback = edit.rollback === undefined ? undefined : async (): Promise<void> => {
      await edit.rollback?.()
      await writeFile(envFile, envBefore, { mode: 0o600 })
      await chmod(envFile, 0o600)
      if (previous !== undefined) {
        const keys = options.dshCredentials?.()
        if (keys !== undefined) {
          if (previous.mode === 'relay' && previous.relay_token !== undefined) await keys.set(DSH_RELAY_TOKEN_ENV, previous.relay_token)
          else await keys.unset(DSH_RELAY_TOKEN_ENV)
          if (previous.mode === 'own' && ownEndpointOf(previous).baseUrl !== OWN_DEFAULT_BASE_URL && ownKey !== undefined) await keys.set(DSH_OWN_KEY_ENV, ownKey)
          else await keys.unset(DSH_OWN_KEY_ENV)
        }
      }
    }
    try {
      if (config.mode === 'relay') {
        // 中转值班:自己端点那把 Key 从 .env 与凭据服务里收走(下次切回来再写)。
        try { await options.dshCredentials?.()?.unset(DSH_OWN_KEY_ENV) }
        catch { /* 收不走就留着:那条路由已经不在值班,Key 不会被用到 */ }
        const envBeforeRelay = await readTextOr(envFile, '')
        const envWithoutOwn = removeEnvLine(envBeforeRelay, DSH_OWN_KEY_ENV)
        if (envWithoutOwn !== envBeforeRelay) {
          await writeFile(envFile, envWithoutOwn, { mode: 0o600 })
          await chmod(envFile, 0o600)
          envChanged = true
        }
        if (config.relay_token === undefined) {
          hints.push('还没领到模型服务的凭证,事务官(DSH)那一侧要等领到之后才真的能用。')
        }
        else {
          const envText = await readTextOr(envFile, '')
          const nextEnv = upsertEnvLine(envText, DSH_RELAY_TOKEN_ENV, config.relay_token)
          if (nextEnv !== envText) {
            await mkdir(dirname(envFile), { recursive: true })
            await writeFile(envFile, nextEnv, { mode: 0o600 })
            await chmod(envFile, 0o600)
            envChanged = true
          }
          // ★ 先存进 DSH 的凭据服务:立即生效,`.env` 那一份只是兜底,于是不用重启(新装机上引导卡在缺凭据的根子)。
          if (await storeInDsh(DSH_RELAY_TOKEN_ENV, config.relay_token)) envChanged = false
          /**
           * 2026-09-18:这句话里**不再出现那行命令**。Ben 是 PM、不写代码,
           * 「去终端里跑一行」对他等于"这件事没做完,而且得你自己想办法" ——
           * 任务卡原话是"不让用户碰终端"。重启这一下改由工作台自己在引导开始前做
           * (server/modelAutoSetup.ts:只在 DSH 没有会话在跑时),所以这里只说结果。
           */
          hints.push('事务官(DSH)那一侧也切好了。它要重启一次才认这份凭证,工作台会自己挑个没在跑活儿的时候重启,你不用管。')
        }
      }
      else if (ownEndpointCustom) {
        // 自己接的端点(2026-10-23,卡「事务官换Key」):Key 交给 DSH 用,写法同中转令牌那一套。
        if (ownKey === undefined) {
          hints.push('还没填自己的密钥,事务官(DSH)那一侧指过去了但现在开不了口;在「各家的登录与密钥」里填完就好。')
        }
        else {
          try { await options.dshCredentials?.()?.set(DSH_OWN_KEY_ENV, ownKey) }
          catch { /* 凭据服务写不进就退回 .env 那一条 */ }
          const envText = await readTextOr(envFile, '')
          const nextEnv = upsertEnvLine(envText, DSH_OWN_KEY_ENV, ownKey)
          if (nextEnv !== envText) {
            await mkdir(dirname(envFile), { recursive: true })
            await writeFile(envFile, nextEnv, { mode: 0o600 })
            await chmod(envFile, 0o600)
            envChanged = true
          }
          if (await storeInDsh(DSH_OWN_KEY_ENV, ownKey)) envChanged = false
          hints.push('事务官(DSH)那一侧也切到你自己接的模型服务了。它要重启一次才认这份密钥,工作台会自己挑个没在跑活儿的时候重启,你不用管。')
        }
      }
      else if (ownModelCustom || restoringPrevModel) {
        // 官方地址、只换/恢复模型名:官方 provider 用它自己的 Key 通路,不碰 .env;
        // 但「自己端点的 Key」若在(之前接过端点)照样收走。
        try { await options.dshCredentials?.()?.unset(DSH_OWN_KEY_ENV) }
        catch { /* 收不走就留着:那条路由已经不在值班,Key 不会被用到 */ }
        const envText0 = await readTextOr(envFile, '')
        const envWithoutOwn0 = removeEnvLine(envText0, DSH_OWN_KEY_ENV)
        if (envWithoutOwn0 !== envText0) {
          await writeFile(envFile, envWithoutOwn0, { mode: 0o600 })
          await chmod(envFile, 0o600)
          envChanged = true
        }
        hints.push(ownModelCustom
          ? '事务官(DSH)那一侧也换成你自己选的模型了。'
          : '事务官(DSH)那一侧也切回你自己的 Key 了。')
      }
      else {
        // 切回自己的 Key(默认官方):把令牌与「自己端点的 Key」都收走,不留在磁盘上。
        try { await options.dshCredentials?.()?.unset(DSH_RELAY_TOKEN_ENV) }
        catch { /* 收不走就照旧靠 provider 已经切回去;那把令牌不会再被用到 */ }
        try { await options.dshCredentials?.()?.unset(DSH_OWN_KEY_ENV) }
        catch { /* 同上 */ }
        const envText = await readTextOr(envFile, '')
        const nextEnv = removeEnvLine(removeEnvLine(envText, DSH_RELAY_TOKEN_ENV), DSH_OWN_KEY_ENV)
        if (nextEnv !== envText) {
          await writeFile(envFile, nextEnv, { mode: 0o600 })
          envChanged = true
        }
        hints.push('事务官(DSH)那一侧也切回你自己的 Key 了,它要重启一次才认,工作台会自己挑时候重启。')
      }

      return {
        hints,
        switched: true,
        ...(rollback === undefined ? {} : { rollback }),
        ...(before?.provider === undefined ? {} : { prevProvider: before.provider }),
        ...(before?.model === undefined ? {} : { prevModel: before.model }),
        ...(envChanged ? { restartRequired: true } : {}),
      }
    }
    catch {
      await rollback?.().catch(() => undefined)
      return { hints: ['事务官凭据未能完成应用，模型切换失败。'], switched: false }
    }
  }

  /** 领令牌。已经有了就不重领(除非 force)。 */
  async function ensureToken(config: ModelConfig, force: boolean): Promise<{ config: ModelConfig, hints: string[] }> {
    if (config.mode !== 'relay') return { config, hints: [] }
    if (config.relay_token !== undefined && !force) return { config, hints: [] }
    const account = config.account ?? await accountNameOf(options.accountFile, config.device_id)
    const result = await registerRelayDevice({
      relayUrl: config.relay_url, account, deviceId: config.device_id, fetchImpl, ...(await deviceIdentity()),
    })
    if (!result.ok) {
      return { config: { ...config, account }, hints: [`还没能领到模型服务的凭证:${result.error}`] }
    }
    usageCache = undefined
    return {
      config: withTokenAccount({ ...config, account, relay_token: result.token }, result.account),
      hints: ['已经接上工作台提供的模型服务,不用填任何东西。'],
    }
  }

  /**
   * 「这把新领的令牌记在哪个账号名下」写进配置(2026-09-27,卡 RM)。
   * 中转没回这一项(老版本)就**把这一格删掉**,而不是留着上一把的值 ——
   * 留着等于对着一把新令牌说一句旧话,下一次比对就会漏绑。
   */
  function withTokenAccount(config: ModelConfig, tokenAccount: string | undefined): ModelConfig {
    if (tokenAccount !== undefined) return { ...config, relay_token_account: tokenAccount }
    const next = { ...config }
    delete next.relay_token_account
    return next
  }

  async function statusOf(config: ModelConfig): Promise<ModelStatusView> {
    const ownConfigured = (await ownKeyOf()) !== undefined
    if (config.mode !== 'relay' || config.relay_token === undefined) {
      return modelStatusOf(config, ownConfigured)
    }
    const fresh = usageCache !== undefined && now() - usageCache.at < USAGE_TTL_MS
    let result: Awaited<ReturnType<typeof fetchRelayUsage>>
    if (fresh) result = (usageCache as NonNullable<typeof usageCache>).result
    else {
      usageInflight ??= fetchRelayUsage({ relayUrl: config.relay_url, token: config.relay_token, fetchImpl })
        .then((got) => { usageCache = { at: now(), result: got }; return got })
        .finally(() => { usageInflight = undefined })
      result = await usageInflight
    }
    return result.ok
      ? modelStatusOf(config, ownConfigured, result.usage)
      : modelStatusOf(config, ownConfigured, undefined, result.error)
  }

  function sameTarget(a: { provider: string, model?: string, prevModel?: string }, b: typeof a): boolean {
    return a.provider === b.provider && a.model === b.model && a.prevModel === b.prevModel
  }

  /**
   * DSH 侧此刻的目标(provider[, model[, prevModel]])。`model` 只在明确知道时给
   * (自己端点 / 只换模型名);relay 与默认官方不给 —— 接收方问 catalog 缺省
   * (= agent-default-model,他自己选的那个,中转切换刻意不动它)。
   */
  function dshTargetOf(config: ModelConfig): { provider: string, model?: string, prevModel?: string } {
    const alignment = config.dsh_alignment_prev_model === undefined ? {} : { prevModel: config.dsh_alignment_prev_model }
    if (config.mode === 'relay') return { provider: DSH_RELAY_PROVIDER, ...alignment }
    const own = ownEndpointOf(config)
    if (own.baseUrl !== OWN_DEFAULT_BASE_URL) return { provider: DSH_OWN_PROVIDER, model: own.model, ...alignment }
    if (own.model !== OWN_DEFAULT_MODEL) {
      return {
        provider: 'deepseek-official',
        model: own.model,
        ...alignment,
      }
    }
    return { provider: 'deepseek-official', ...alignment }
  }

  async function applyMode(
    patch: {
      mode: 'relay' | 'own'
      relay_url?: string
      own_base_url?: string
      own_model?: string
    },
    force: boolean,
  ): Promise<ModelUpdateResult> {
    const current = await loadModelConfig(options.modelFile)
    if (pendingRecovery !== undefined) {
      try { await pendingRecovery(); pendingRecovery = undefined }
      catch {
        return { ok: false, status: await statusOf(current), hints: [], error: '上次会话选择恢复仍未完成，请重试模型设置后再发送。' }
      }
    }
    let next: ModelConfig = {
      ...current,
      mode: patch.mode,
      ...(patch.relay_url === undefined ? {} : { relay_url: patch.relay_url }),
      ...(patch.own_base_url === undefined ? {} : { own_base_url: patch.own_base_url }),
      ...(patch.own_model === undefined ? {} : { own_model: patch.own_model }),
    }
    // 换了地址就等于换了一家服务,旧令牌作废。
    if (patch.relay_url !== undefined && patch.relay_url !== current.relay_url) delete next.relay_token
    // 没接中转(零服务器档)时走不了中转:如实拒绝,什么都不写、一个包都不发。
    if (next.mode === 'relay' && !relayConfigured(next)) {
      return { ok: false, status: await statusOf(current), hints: [], error: NO_RELAY_MODEL_ERROR, code: 'no_relay' }
    }

    const issued = await ensureToken(next, force)
    next = issued.config

    const dsh = await applyToDsh(next, await ownKeyOf().catch(() => undefined), current)
    if (!dsh.switched && options.liveReconcile !== undefined) {
      applicationFailed = true
      return { ok: false, status: await statusOf(current), hints: dsh.hints, error: '事务官未完成模型切换，选择没有保存。' }
    }
    if (dsh.prevProvider !== undefined && patch.mode === 'relay' && dsh.prevProvider !== 'workbench-relay') {
      next = { ...next, dsh_prev_provider: dsh.prevProvider }
    }
    /**
     * 「替他写 model 行之前,记住他原来选的」(2026-10-23 退修,模式与 dsh_prev_provider 同一条):
     * own 档他自己填模型名(或接端点)时,DSH 的 model 行会被我们覆盖;
     * 他改回缺省或切回中转时照 prevModel 恢复。每轮 relay→own 重新捕获有效默认，
     * 同一轮 own→own 保留最初来源，避免把临时模型记成恢复目标。
     */
    const writingOwnModel = next.mode === 'own' && (
      (next.own_base_url ?? OWN_DEFAULT_BASE_URL) !== OWN_DEFAULT_BASE_URL
      || (next.own_model ?? OWN_DEFAULT_MODEL) !== OWN_DEFAULT_MODEL
    )
    if (writingOwnModel && (current.mode === 'relay' || next.dsh_prev_model === undefined)
      && dsh.prevModel !== undefined && dsh.prevProvider !== DSH_OWN_PROVIDER) {
      next = { ...next, dsh_prev_model: dsh.prevModel }
    }
    // 恢复支跑完了就把记忆清掉:他后来又在自己选时,不该被旧记忆盖回去。
    if (next.mode === 'own'
      && (next.own_base_url ?? OWN_DEFAULT_BASE_URL) === OWN_DEFAULT_BASE_URL
      && (next.own_model ?? OWN_DEFAULT_MODEL) === OWN_DEFAULT_MODEL
      && next.dsh_prev_model !== undefined) {
      next = { ...next }
      delete next.dsh_prev_model
    }

    // 回滚失败时保留本次精确补偿，下一次设置先完成它；成功设置前始终拒发。
    const recoverApplication = async (selections?: ModelRetargetRollback): Promise<boolean> => {
      pendingRecovery = async () => {
        if (dsh.rollback !== undefined) await dsh.rollback()
        else if (!(await applyToDsh(current, await ownKeyOf().catch(() => undefined))).switched) throw new Error('MODEL_RUNTIME_ROLLBACK_FAILED')
        await selections?.()
      }
      try { await pendingRecovery(); pendingRecovery = undefined; return true }
      catch { return false }
    }
    let rollbackSelections: ModelRetargetRollback | void = undefined
    try {
      const restored = next.mode === 'own' && current.dsh_prev_model !== undefined && next.dsh_prev_model === undefined
      const changed = restored || !sameTarget(dshTargetOf(current), dshTargetOf(next))
      if (changed && dsh.switched) {
        // 会话跟随的是这次被覆盖的官方选择；最终恢复用的 R 不能代替此次 A→B 的 A。
        // 同值保存保留上次来源，失败时这份候选与模式一起不落盘。
        next = { ...next }
        delete next.dsh_alignment_prev_model
        if (dsh.prevProvider === 'deepseek-official' && dsh.prevModel !== undefined) next.dsh_alignment_prev_model = dsh.prevModel
        const change = restored
          ? { ...dshTargetOf(next), model: current.dsh_prev_model as string }
          : dshTargetOf(next)
        rollbackSelections = await options.onModelTargetChanged?.(change)
      }
    }
    catch (error) {
      applicationFailed = true
      const restored = await recoverApplication(error instanceof ModelRetargetError ? error.rollback : undefined)
      return { ok: false, status: await statusOf(current), hints: [],
        error: restored ? '会话未能切到新模型，选择没有保存，请重试。' : '会话切换失败，运行时恢复也未完成，请重试模型设置后再发送。' }
    }
    try { await saveModelConfig(options.modelFile, next) }
    catch (error) {
      applicationFailed = true
      const selectionsRestored = await recoverApplication(rollbackSelections || undefined)
      return {
        ok: false,
        status: await statusOf(current),
        hints: [],
        error: selectionsRestored
          ? `没能把选择写进本机文件(${error instanceof Error ? error.name : '未知错误'})。`
          : '选择未保存，会话选择恢复也未完成，请重试模型设置后再发送。',
      }
    }

    applicationFailed = false
    usageCache = undefined
    return {
      ok: true,
      status: await statusOf(next),
      hints: [...issued.hints, ...dsh.hints],
      ...(dsh.restartRequired === true ? { dsh_restart_required: true } : {}),
    }
  }

  /**
   * 注册/登录那一刻跑的那一份(2026-09-18)。要不要动由 `autoRelayDecision` 定(纯函数、
   * 三条判据都在 modelConfig.ts 里),真要动时走的是**和设置里那颗按钮同一条** applyMode。
   *
   * 不动也回 `ok: true` —— 「他自己选了用自己的 Key」不是失败,界面上一个字都不该出。
   */
  /** 见 `ModelService.bindToAccount` 那一段。判据在 `deviceTokenBindingOf`(modelConfig.ts)。 */
  async function bindToAccount(): Promise<{ ok: boolean, changed: boolean, reason: string, error?: string }> {
    const current = await loadModelConfig(options.modelFile)
    let scope: string | undefined
    try { scope = await options.relayAccountScope?.() } catch { scope = undefined }
    const decision = deviceTokenBindingOf(current, scope)
    // 没登录、或者手上那把已经是这个账号的 —— **一个字节都不动**
    // (重领会把旧的作废,手机上正通着的那条会当场断)。
    if (!decision.rebind) return { ok: true, changed: false, reason: decision.reason }

    const identity = await deviceIdentity()
    if (identity.session === undefined) {
      // scope 说登录着、会话却取不到:这是一次读文件的抖动,不是「没登录」。下次启动再试。
      return {
        ok: false, changed: false, reason: decision.reason,
        error: '这会儿读不到登录态,没能把这台机器绑到账号。',
      }
    }
    const account = current.account ?? await accountNameOf(options.accountFile, current.device_id)
    const issued = await registerRelayDevice({
      relayUrl: current.relay_url, account, deviceId: current.device_id, fetchImpl, ...identity,
    })
    if (!issued.ok) return { ok: false, changed: false, reason: decision.reason, error: issued.error }
    /**
     * 中转是老版本、不回 `account` 时:令牌确实换成了带会话领的那一把(房间已经对了),
     * 但我们记不下「它属于谁」。**照样写**,只是下一次启动会再绑一遍 —— 多领一把令牌
     * 比留在错房间里便宜得多。
     */
    const next = withTokenAccount({ ...current, account, relay_token: issued.token }, issued.account)
    try { await saveModelConfig(options.modelFile, next) }
    catch (error) {
      return {
        ok: false,
        changed: false,
        reason: decision.reason,
        error: `领到了凭证但没能写进本机文件(${error instanceof Error ? error.name : '未知错误'})。`,
      }
    }
    usageCache = undefined
    /**
     * `changed` 的意思是「**房间号可能换了**,拿着旧房间的那几位要跟着搬」,
     * 而不是「令牌换了一把」。原来压根没有令牌那一种(`no_token`)也算换 ——
     * 在那之前这台机器不在任何房间里,工人正等着一张凭证。
     */
    try { options.onRoomChanged?.(`这台机器绑到了当前登录的账号(${decision.reason})`) }
    catch { /* 换房那一下失败不该把绑定本身判成失败 */ }
    return { ok: true, changed: true, reason: decision.reason }
  }

  async function autoSetup(): Promise<ModelAutoSetupResult> {
    /**
     * **先把这台机器挂到账号下**(2026-09-27,卡 RM)。
     *
     * 这一条是整张卡的关键时机:`autoSetup` 正是注册/登录成功那一刻被 `modelAutoSetup.kick()`
     * 叫到的那一份。新装机器的主路径是「装完 → 领一把 legacy 令牌(引导要调模型)→ 登录」,
     * 而登录完人下一步就是提机说话 —— 所以绑定必须**在这里**完成,不能等下次启动。
     *
     * 放在最前面还有一层:下面那条 `already_linked` 会因为「令牌已经在」直接跳过重领,
     * 而那把令牌恰恰就是错房间的那一把。
     *
     * 失败不连累 autoSetup:绑不上只是「这会儿还打不了电话」,而模型那一侧照旧要接。
     */
    await bindToAccount().catch(() => undefined)
    const current = await loadModelConfig(options.modelFile)
    const decision = autoRelayDecision(current, (await ownKeyOf()) !== undefined)
    if (!decision.auto) {
      /**
       * 令牌已经在、走的也是中转,但 **DSH 那一侧不一定跟上了**(2026-09-23 从零重装自跑):
       * 通话要用,工作台起服务时会先经 `ensureDeviceToken` 领一把令牌 —— 那条路故意不碰
       * settings.yaml / .env。于是登录这一刻判成 `already_linked` 直接跳过,`~/.dsh/.env`
       * 永远没人写,DSH 一开口就是「no API key」。所以这里照样把 DSH 那侧对一遍:
       * 已经对的一个字节不动(`applyToDsh` 只在真变了时写、只在 .env 真变了时要重启)。
       */
      if (current.mode === 'relay' && current.relay_token !== undefined) {
        const dsh = await applyToDsh(current)
        if (dsh.restartRequired === true) {
          return {
            ok: true, attempted: true, status: await statusOf(current), hints: dsh.hints, dsh_restart_required: true,
          }
        }
      }
      return { ok: true, attempted: false, skipped: decision.reason, status: await statusOf(current), hints: [] }
    }
    const result = await applyMode({ mode: 'relay' }, false)
    return { ...result, attempted: true }
  }

  return {
    status: async () => statusOf(await loadModelConfig(options.modelFile)),
    ready: async () => modelStatusOf(await loadModelConfig(options.modelFile), (await ownKeyOf()) !== undefined).ready,
    update: patch => serialize(() => applyMode(patch, false)),
    reissue: () => serialize(async () => {
      const current = await loadModelConfig(options.modelFile)
      return applyMode({ mode: 'relay', relay_url: current.relay_url }, true)
    }),
    autoSetup: () => serialize(autoSetup),
    /**
     * 只补令牌那一件事。走的是与 `ensureToken` 同一个 `registerRelayDevice`,
     * 但**不经过 applyMode** —— applyMode 会顺手写 DSH 的设置与 .env,
     * 而"我要打个电话"不该把他的模型选择一起改了。
     */
    ensureDeviceToken: () => serialize(async () => {
      const current = await loadModelConfig(options.modelFile)
      if (current.relay_token !== undefined) return { ok: true }
      const account = current.account ?? await accountNameOf(options.accountFile, current.device_id)
      const issued = await registerRelayDevice({
        relayUrl: current.relay_url, account, deviceId: current.device_id, fetchImpl, ...(await deviceIdentity()),
      })
      if (!issued.ok) return { ok: false, error: issued.error }
      try {
        await saveModelConfig(
          options.modelFile,
          withTokenAccount({ ...current, account, relay_token: issued.token }, issued.account),
        )
      }
      catch (error) {
        return { ok: false, error: `领到了凭证但没能写进本机文件(${error instanceof Error ? error.name : '未知错误'})。` }
      }
      usageCache = undefined
      return { ok: true as const }
    }),

    bindToAccount: () => serialize(bindToAccount),
    endpoint: async () => modelEndpointOf(await loadModelConfig(options.modelFile), await ownKeyOf()),
    target: async () => {
      if (applicationFailed) throw new Error('MODEL_APPLICATION_FAILED')
      return dshTargetOf(await loadModelConfig(options.modelFile))
    },
    /**
     * 「试一下」(2026-10-23,卡「事务官换Key」):用此刻该用的端点与模型名打一句话。
     * 不发包的那几种(没接上)先说人话;回了什么只取半句,错因也只带状态码,**不带 key**。
     */
    async try() {
      const config = await loadModelConfig(options.modelFile)
      const endpoint = modelEndpointOf(config, await ownKeyOf().catch(() => undefined))
      if (!endpoint.ready || endpoint.key === undefined) {
        return config.mode === 'own'
          ? { ok: false, message: '还没填自己的密钥:在「各家的登录与密钥」里填完,再回来试。' }
          : { ok: false, message: '模型服务还没接上:先领工作台的凭证,或切到自己的账号。' }
      }
      const model = endpoint.model ?? OWN_DEFAULT_MODEL
      try {
        const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: '用一句不超过十五个字的话,只说「在,说」两个字加上一个标点。' }],
            max_tokens: 40,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) {
          return { ok: false, message: `模型服务没接成(回了 ${res.status}):看一下地址、密钥与模型名有没有填对。` }
        }
        const body = await res.json().catch(() => ({})) as { choices?: { message?: { content?: unknown } }[] }
        const content = body.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content.trim() === '') {
          return { ok: false, message: '模型回了空内容:它认这个地址,但模型名可能不对。' }
        }
        return { ok: true, message: content.trim() }
      }
      catch {
        return { ok: false, message: '连不上这个模型服务:看一下地址有没有填对、这台电脑能不能上网。' }
      }
    },
  }
}
