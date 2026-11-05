import { FAMILY_SOURCES } from './agentSources.ts'

/**
 * 激活+校验+重试闭环(调研 §R1R2 的三条铁律):
 * 1. open 是异步且 flaky 的(微信双开交替实测失败率 6/12=50%),单发不能假定成功;
 * 2. 校验读 bundle id 用 lsappinfo(`info -only pid -app <id>`),禁用 System Events
 *    (实测挂死 120s);空输出≠"未读 0",是"没在跑"(§R4);
 * 3. 双开微信只能靠 bundle id 区分,显示名和 URL scheme 都不可靠。
 *
 * 现状(2026-09-28):**一律按包标识拉起**(`apps.ts` 的 `APP_COMMANDS` 全是 `open -b <包标识>`),
 * 不假定任何 App 叫什么 —— 维护者旧机器上微信双开改名叫 WeChat2.app,曾经写死那个名字,
 * 别人机器上(新 Air)就「找不到应用」。包标识也不是一成不变(2026-08-24:WeChat2.app 升到
 * 4.1.13 之后 CFBundleIdentifier 又翻回 `com.tencent.xinWeChat`),所以真正的兜底是
 * (A2b)服务端自愈注册:壳报来一个认不出的 bundle 时,dockService 直接拿壳查到的展示名
 * 把它注册进 registry,不要求这张表提前把 id 猜对。
 */
import { APP_COMMANDS } from './apps.ts'

export const APP_BUNDLES: Record<string, string> = {
  /**
   * AI 那几家的包标识从知识表现长(2026-09-27,卡 HC):原来这里只有 claude / codex / kimi,
   * 豆包办公 / Muse / Manus 各自的包标识只写在 `FAMILY_SOURCES` 里,于是探测、坞、窗口槽
   * 都换算不出它们来。同一个包标识不许在仓库里存在第二份。
   */
  ...Object.fromEntries(
    FAMILY_SOURCES
      .filter(one => one.bundle_id !== undefined && one.bundle_id !== '')
      .map(one => [one.agent, one.bundle_id as string]),
  ),
  wechat: 'com.tencent.xinWeChat',
  wecom: 'com.tencent.WeWorkMac',
  term: 'com.apple.Terminal',
  calendar: 'com.apple.iCal',
}

export interface ActivationDeps {
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  sleep: (ms: number) => Promise<void>
  /** 激活尝试轮数,默认 3。每轮等待递增(1.5s/3s/4.5s,调研:1.5s 偶发失败、3s 更稳仍非 100%)。 */
  attempts?: number
}

export async function isRunning(
  bundleId: string,
  runCommand: ActivationDeps['runCommand'],
): Promise<boolean> {
  const { ok, stdout } = await runCommand(['lsappinfo', 'info', '-only', 'pid', '-app', bundleId])
  return ok && /"pid"\s*=\s*\d+/.test(stdout)
}

/**
 * 确保应用在运行的核心闭环:没跑就发命令拉起,lsappinfo 校验,失败按轮重试。
 * 从 ensureRunning 拆出来(spec S4):command/bundleId 不再限定来自 APP_COMMANDS/APP_BUNDLES——
 * appsRegistry.ts 的自定义应用也要走同一套重试闭环,不能另起一份。
 */
export async function ensureRunningWith(
  cmd: readonly string[],
  bundleId: string,
  deps: ActivationDeps,
): Promise<{ ok: boolean, reason?: string }> {
  if (await isRunning(bundleId, deps.runCommand)) return { ok: true }

  const attempts = deps.attempts ?? 3
  for (let round = 1; round <= attempts; round++) {
    await deps.runCommand(cmd)
    await deps.sleep(1500 * round)
    if (await isRunning(bundleId, deps.runCommand)) return { ok: true }
  }
  return { ok: false, reason: `激活失败:${bundleId} 未在运行(已重试 ${attempts} 轮)` }
}

/** 确保应用在运行:基础七应用走 APP_COMMANDS/APP_BUNDLES 解析,核心闭环见 ensureRunningWith。 */
export async function ensureRunning(
  app: string,
  deps: ActivationDeps,
): Promise<{ ok: boolean, reason?: string }> {
  // 原型链键防护,先例见 apps.ts 的 activateApp。
  const cmd = Object.hasOwn(APP_COMMANDS, app) ? APP_COMMANDS[app] : undefined
  const bundleId = Object.hasOwn(APP_BUNDLES, app) ? APP_BUNDLES[app] : undefined
  if (cmd === undefined || bundleId === undefined) {
    return { ok: false, reason: `不认识这个应用:${app}` }
  }
  return ensureRunningWith(cmd, bundleId, deps)
}
