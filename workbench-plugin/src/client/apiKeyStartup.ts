/**
 * 启动时的「有没有配 AI 来源」这一问(2026-11-13):判定、话术、时长。
 *
 * ## 为什么要插在首次流程之前
 *
 * 原来的启动顺序是:登录 → 首次流程第一屏(「你好,很高兴认识你…」,图一) → …
 * → 走完引导 → 整屏密钥引导。新用户装完第一眼看到的是**聊天引导**,压根不知道
 * 「事务官要接话,得先有一把大模型密钥」。密钥引导排得太靠后了。
 *
 * 维护者这次要的时序:启动先判断有没有配 AI 模型;**没配就弹窗**
 * 「检测到未配置大模型api key,请先配置」,**3 秒后自动落到 DeepSeek 密钥配置那一屏**
 * (首次流程里的 `config` 步,即 `ModelPanel` + `CredentialPanel`,图二)。
 *
 * ## 三条纪律（2026-11-13 真机返工后）
 *
 * 1. **只有「走完配置、且明确配好了」才放行**。第一版把「问不到」和「已配」一起放行,
 *    结果真机上 `/credentials` 回 `{deepseek:{configured:true}}` 就直接进图一;干净新机上
 *    服务晚起一拍也会因为问不到而直接进图一 —— 两头都看不见弹窗。现在首次流程旗子还立着
 *    就一律先弹(旗子立着 = 图二那趟配置没走完),探测说没配 / 问不到也弹。弹窗自带
 *    「稍后再说」和 3 秒倒计时,不会把人锁住,所以「宁可多提醒一次」是安全的。
 * 2. **首次流程没走完,本身就等于「没配置完成」**。图二(`config` 步)就是配模型与 AI 来源
 *    那一屏,旗子还立着就说明这一趟没走完;哪怕本机存着一把旧 Key,启动也照弹。
 *    已进过工作台那一支(`firstRunNeeded !== true`)不归这层管,交给 `ApiKeySetupGate`。
 * 3. **不再拿 `loggedIn` 单独当门槛**。`firstRunNeeded === true` 是登录之后才问得出来的旗子,
 *    它本身就是登录凭证;真机上 `/account` 的 `logged_in` 会抖,多叠一道只会让弹窗时有时无。
 *    本次启动只弹一次(跳过去了 / 点稍后再说置 `handled`),不写持久旗子,下次启动重新问。
 *
 * ## 判定口径
 *
 * 「有没有配 AI 模型」取 `GET /credentials` 的 `deepseek.configured`:开源构建零服务器档
 * 默认就是 own 档 + DeepSeek 官方地址,这一格就是唯一的 AI 来源,与 `needApiKeySetup`
 * 同源。刻意没有改成「任意一家配了就算」—— 那样会与「直到配上 DeepSeek Key」的拍板冲突。
 */

/** 启动探测最多等这么久;过了就按「问不到」放行,不许把人卡在空屏。 */
export const API_KEY_STARTUP_PROBE_TIMEOUT_MS = 3000

/** 弹窗停留时间:3 秒后自动去配置界面(维护者指定)。 */
export const API_KEY_STARTUP_DELAY_MS = 3000

export interface ApiKeyStartupStage {
  /** 仅是状态记录,**不参与判定**:`firstRunNeeded === true` 本身就说明登录过了。 */
  loggedIn: boolean
  /** 首次流程旗子。`undefined` = 还没问到(照原流程,不弹)。 */
  firstRunNeeded: boolean | undefined
  /** 启动探测回来了没有(不管结论是什么)。 */
  probeDone: boolean
  /**
   * 探测结论:`true` 明确配好(唯一放行) / `false` 明确没配 / `undefined` 问不到。
   * 后两者都弹 —— 弹窗自带 3 秒倒计时与「稍后再说」,不会锁人。
   */
  aiConfigured: boolean | undefined
  /** 本次启动已经处理过这道弹窗(跳过去了 / 点了稍后再说)。 */
  handled: boolean
}

/** 该不该把启动提示弹出来。 */
export function needApiKeyStartupNotice(stage: ApiKeyStartupStage): boolean {
  if (stage.handled) return false
  if (stage.firstRunNeeded !== true) return false
  if (!stage.probeDone) return false
  // 两个信号任一成立就提醒:
  //   ① 首次流程旗子还立着 —— 图二(配置模型与 AI 来源)这一趟没走完,本机哪怕存着
  //      一把 11-06 的旧 Key,也算「没配置完成」。真机返工(2026-11-13)就是栽在
  //      旧版「configured:true 就放行」,结果每次启动都直接到图一。
  //   ② 探测说没配 / 问不到 —— 服务没起、回包看不懂、超时,都按「还没配好」提醒。
  // 弹窗自带 3 秒倒计时与「稍后再说」,不会把人锁住,所以宁可多提醒一次是安全的。
  return stage.firstRunNeeded === true || stage.aiConfigured !== true
}

/** 探测还没回来时先空屏,避免「先闪一下图一、再弹窗」那一下跳动。 */
export function apiKeyStartupWaiting(stage: ApiKeyStartupStage): boolean {
  if (stage.handled) return false
  if (stage.firstRunNeeded !== true) return false
  return !stage.probeDone
}

/** 这一屏上的话术,集中一处(组件、测试共用,改一处不会漂)。 */
export const API_KEY_STARTUP_COPY = {
  kicker: '还差一步',
  /** 维护者原话,逐字不改。 */
  title: '检测到未配置大模型api key，请先配置',
  lead: '事务官接话、听懂你说话,都要用一把你自己的 DeepSeek 密钥。下面带你去填,服务地址和模型名已经预置好了。',
  countdown: (seconds: number) => `${seconds} 秒后自动前往配置…`,
  go: '立即去配置',
  skip: '稍后再说',
} as const
