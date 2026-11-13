/**
 * 「首次安装后,强提示配置 DeepSeek 密钥」这一屏的**判定与文案**(纯函数,无副作用)。
 *
 * ## 为什么有这一屏
 *
 * 新用户装完、登录完进到工作台,面对一整屏模块,没人告诉他「事务官接话要用一把密钥」。
 * 现状只有顶栏一条不拦路的细横幅(NeedBar),还依赖上一次体检、以及「选了用自己的 Key」
 * 这个前提 —— 于是绝大多数新用户压根不知道要做这件事。这里把它提到**整屏强制**:
 * 没配好密钥之前,先看到这一屏。
 *
 * ## 2026-11-12 这一版:从「一屏塞满」改成「三步走」
 *
 * 维护者真机自测后给的五条:入口在哪不知道、一屏信息太杂、复制完 Key 回来还得自己找框、
 * 地址/模型名不该让人填、填错了不知道为什么。于是:
 *
 * 1. **直达外链**:第 1 步的主按钮就是 DeepSeek 开放平台的 API Keys 页,点一下系统浏览器
 *    直接打开(壳里 `target=_blank` 交给默认浏览器,见 WebPolicy.swift)。不再让人自己找入口。
 * 2. **分步 + 进度**:去登录 → 完成实名 → 回来贴 Key,一屏只做一件事,顶上一条 1/3 的进度。
 * 3. **剪贴板识别**:从浏览器复制完 sk- 开头的串回来,直接提示「一键填入」。
 * 4. **自动填参**:服务地址与模型名是服务端缺省(见 modelConfig.ts 的 OWN_DEFAULT_*),
 *    这一屏只读展示、不让人填,用户只需管 Key 一处。有对照测试钉着两边不漂。
 * 5. **一键测试连接**:401 / 402 由服务端翻成人话(credentialTest.ts),这里只显示结果。
 *
 * ## 判据(三条全中才拦)
 *
 * 1. **这台服务接了账号、且已登录** —— 没登录时先走登录屏,那一屏不叠任何东西(同登录屏纪律)。
 * 2. **DeepSeek 密钥没配** —— 真相是 `GET /credentials` 的 `deepseek.configured`,实时、不依赖体检。
 *    `undefined`(还没问到 / 服务没起)**不算没配**:这一整套是拦路的,问不到时把人按在引导里,
 *    比让他先进去糟得多 —— 与 firstRunApi「问不到就当走过了」同一条纪律。
 * 3. **本次会话没点过「稍后再说」** —— 点了就放他进去,但**不写任何持久旗子**,重启再提醒,
 *    直到真配上为止(用户拍板:强提示直到配上)。填对密钥后 `configured` 自己会变 true,
 *    那条才是天然的、持久的放行。
 *
 * ## 不碰 relay 模式
 *
 * 选了「用工作台提供的服务」(relay)的人不需要自己的密钥 —— `GET /credentials` 里 deepseek
 * 没配但模型照样 ready。他们会在这一屏点「稍后再说」进去;这是可以接受的:这一屏给的正是
 * 「配一把就能用你自己的额度」这条路,不填也不锁死。
 */

/** 判这一屏要不要出现,需要的那一丁点状态。字段刻意取最小值,方便单测。 */
export interface ApiKeyGateStage {
  /** `/account` 探测结果;只有「接了账号且已登录」才轮得到这一屏。 */
  loggedIn: boolean
  /**
   * `GET /credentials` 的 `deepseek.configured`。
   * `undefined` = 还没问到 / 服务没起 → 不拦(见文件头纪律)。
   */
  deepseekConfigured: boolean | undefined
  /** 本次会话点过「稍后再说」没有。点了就放行,但下次启动重新问。 */
  skipped: boolean
}

/**
 * 该不该把整屏密钥引导摆出来。
 *
 * 严格用 `deepseekConfigured === false` 判「没配」——`undefined` 是「还不知道」,不能当没配,
 * 否则服务刚起、/credentials 还没回来的那几百毫秒会把人按在引导屏上。
 */
export function needApiKeySetup(stage: ApiKeyGateStage): boolean {
  if (!stage.loggedIn) return false
  if (stage.skipped) return false
  return stage.deepseekConfigured === false
}

/** DeepSeek 开放平台的 API Keys 页。全仓唯一一处:引导屏、首页入口、设置里那一行都用它。 */
export const DEEPSEEK_API_KEYS_URL = 'https://platform.deepseek.com/api_keys'

/**
 * 服务端 own 档的预置参数(2026-11-12,「自动填参」)。
 *
 * 这两个值**不是这一屏决定的**:它们是 `src/server/modelConfig.ts` 里 `OWN_DEFAULT_BASE_URL` /
 * `OWN_DEFAULT_MODEL` 的缺省,零服务器档(开源构建)拿到手就是这个,用户不填也照样生效。
 * 这里只是**显示**出来让人看见「已经替你填好了,不用管」。client 打包不能 import server 的
 * modelConfig.ts(那边引了 node:fs),所以抄一份显示用的常量,并由
 * `apiKeyGate.test.ts` 读服务端源文件比对,防两边漂移(同仓库「读源头文件比对」的规矩)。
 */
export const DEEPSEEK_PRESET = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
} as const

/** 三步向导。一屏一件事,顺序即进度。 */
export const API_KEY_SETUP_STEPS = [
  { id: 'login', label: '去登录' },
  { id: 'verify', label: '完成实名' },
  { id: 'paste', label: '回来贴 Key' },
] as const

export type ApiKeySetupStep = typeof API_KEY_SETUP_STEPS[number]['id']

/** 第几步(1-based),给进度条与「第 N 步 / 共 3 步」用。 */
export function stepNumber(step: ApiKeySetupStep): number {
  return API_KEY_SETUP_STEPS.findIndex(one => one.id === step) + 1
}

/**
 * 剪贴板里那串是不是 DeepSeek 的 Key。
 *
 * 只认 `sk-` 开头、去掉首尾空白后长度够、且中间没有空白或换行的**单行串**。
 * 不校验具体字符集(各家 Key 的字符规则会变),也不回显这串内容 ——
 * 判定结果只是一个布尔,界面据此说「检测到 Key」,不把内容摆出来。
 */
export function looksLikeDeepSeekKey(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed.startsWith('sk-')) return false
  if (trimmed.length < 12 || trimmed.length > 256) return false
  return !/\s/.test(trimmed)
}

/** 这一屏上的话术,集中一处(组件、测试共用,改一处不会漂)。 */
export const API_KEY_GATE_COPY = {
  kicker: '还差一步',
  title: '配一把密钥,事务官就能开口办事',
  lead: '事务官接话、听懂你说话、帮你把手上的事办起来,都要用一把你自己的 DeepSeek 密钥。',
  fieldLabel: 'DeepSeek 密钥',
  placeholder: '把 sk- 开头那串粘进来',
  where: '打开 DeepSeek 开放平台的 API Keys 页',
  whereUrl: DEEPSEEK_API_KEYS_URL,
  save: '保存并开始使用',
  saving: '正在保存…',
  skip: '稍后再说',
  saved: '配好了。事务官这就来。',
  /** 保存失败时显示,刻意不拼底层错误(底层错误可能带出请求体里的 Key)。 */
  saveFailed: '没能保存,请确认密钥粘全了再试一次。',
  /** 密钥只落在这台电脑这一句,与 credentials.ts 的承诺一致。 */
  privacy: '密钥只存在这台电脑上,不会传到任何地方;随时能在设置里更换。',

  // ── 三步向导 ──────────────────────────────────────────────────────────
  progress: (n: number) => `第 ${n} 步 / 共 ${API_KEY_SETUP_STEPS.length} 步`,
  back: '上一步',
  login: {
    title: '先去 DeepSeek 开放平台登录',
    lead: '按下面这颗键,会直接打开开放平台的 API Keys 页。用手机号注册或登录一个账号。',
    primary: '确认,去开放平台登录 ↗',
    alt: '我已有账号,直接下一步',
  },
  verify: {
    title: '完成实名认证,再创建一把 Key',
    lead: '第一次用要先在开放平台完成实名认证,然后在 API Keys 页点「创建 API key」,把生成那串以 sk- 开头的密钥复制下来。',
    primary: '再打开一次 API Keys 页 ↗',
    alt: '已经拿到 Key 了,去粘贴',
  },
  paste: {
    title: '把复制好的 Key 贴进来',
    lead: '只填这一处。服务地址和模型名已经替你预置好,不用管。',
  },
  // ── 剪贴板 ────────────────────────────────────────────────────────────
  clipboardFound: '检测到 Key,一键填入',
  clipboardFill: '一键填入',
  clipboardRead: '从剪贴板粘贴',
  clipboardReadFailed: '读不到剪贴板,直接按 ⌘V / Ctrl+V 粘进输入框就行。',
  // ── 自动填参(只读展示) ──────────────────────────────────────────────
  presetTitle: '已经预置好,不用你填',
  presetBaseLabel: '服务地址',
  presetModelLabel: '模型名',
  // ── 一键测试连接 ──────────────────────────────────────────────────────
  test: '一键测试连接',
  testing: '正在测试…',
  testPassed: '连接成功,可以开始用了',
  testSave: '连接成功,保存并开始使用',
  testFailedFallback: '这次没测成,稍后再试,或者直接保存。',
} as const
