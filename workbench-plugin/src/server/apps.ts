import { FAMILY_SOURCES } from './agentSources.ts'

/**
 * 应用激活(spec R1/R2)。
 *
 * ★ **命令一律是 `open -b <包标识>`**(2026-09-28,新 Air 真机):按显示名拉起(`open -a <名字>`)
 * 赌的是「这个 App 在这台机器上叫这个名字」—— 维护者旧机器上微信双开改名叫 WeChat2.app,
 * 写死那个名字之后别人机器上(WeChat.app)点微信标签就「没有第 0 个窗口」;Codex 那一行同理:
 * macOS 上并没有 Codex.app,它是 `ChatGPT.app`(bundle id `com.openai.codex`)。
 * 包标识是稳定的那一个,所以只按它拉。
 *
 * 激活是异步且 flaky 的（调研 §R1 双开一节：WeChat/WeChat2 交替激活失败率实测 6/12＝50%），
 * 这里只负责"把命令发出去"，不做前台校验：
 * - 前台校验需要 `lsappinfo`（`osascript ... System Events` 实测会挂起到 120s 超时，
 *   调研 §R1"环境噪声"一节已确认，绝不能用它查前台）；
 * - 校验通不过之后要不要重试，属于下一轮任务的范围，这里先如实交出"命令发没发出去"，
 *   不假装自己知道 App 有没有真的切到前台。
 *
 * ★ **2026-09-27(卡 HC「不写死各家 AI」)**:AI 那几行不再在这里写字面量,从那张知识表
 * (`agentSources.ts` 的 `FAMILY_SOURCES`)现长 —— 原来这里只有 claude / codex / kimi 三家,
 * 于是全新 Air 上装着的豆包办公在窗口槽、常用应用里**一处都认不出来**(维护者:「豆包办公还认不出来呢」)。
 * 表里那几条 `open` 命令本来就与这里逐字相同(`agentSources.ts` 那条注释写着),合成一份之后
 * 新写一家专门读法时这里自动跟上。**装没装另说**:清单可见性由探测把关
 * (`SCANNED_BASE_KEYS` + `installedAgents`),这张表只回答「怎么把它拉起来」。
 */
const AI_APP_COMMANDS: Record<string, readonly string[]> = Object.fromEntries(
  FAMILY_SOURCES
    .filter(one => one.bundle_id !== undefined && one.open !== undefined)
    // 按包标识拉起,不按显示名(2026-09-28):同一个 App 在不同机器上名字不同(Codex 在维护者机器上叫 ChatGPT.app)。
    .map(one => [one.agent, ['open', '-b', one.bundle_id as string] as readonly string[]]),
)

/**
 * 不是 AI 的那几个基础应用。**一律按包标识拉起**(2026-09-28,新 Air 真机):
 * 原来微信写死 `open -a WeChat2` —— 那是维护者旧机器双开改名留下的名字,别人机器上是 WeChat.app,
 * 点微信标签就「没有第 0 个窗口」(Air 上 Codex 查实并热修过,这里合进正式版)。
 */
const OTHER_APP_COMMANDS: Record<string, readonly string[]> = {
  wechat: ['open', '-b', 'com.tencent.xinWeChat'],
  wecom: ['open', '-b', 'com.tencent.WeWorkMac'],
  term: ['open', '-b', 'com.apple.Terminal'],
  calendar: ['open', '-b', 'com.apple.iCal'],
}

export const APP_COMMANDS: Record<string, readonly string[]> = { ...AI_APP_COMMANDS, ...OTHER_APP_COMMANDS }

/**
 * 未知 app 直接返回 false，不发任何命令。
 *
 * 必须先过 `Object.hasOwn` 白名单再取值：`APP_COMMANDS[app]` 直接按下标取，
 * `app` 传 `__proto__`/`constructor`/`toString`/`hasOwnProperty`/`valueOf` 这类
 * Object.prototype 上天然存在的键时，取到的不是 `undefined` 而是原型链上的函数/对象，
 * 后面 `run(cmd)` 会拿一个非法值去跑，实测直接 500 而不是这里期望的 404。
 */
export async function activateApp(
  app: string,
  run: (cmd: readonly string[]) => Promise<{ ok: boolean }>,
): Promise<boolean> {
  const cmd = Object.hasOwn(APP_COMMANDS, app) ? APP_COMMANDS[app] : undefined
  if (cmd === undefined) return false
  const result = await run(cmd)
  return result.ok
}
