/**
 * 未读角标采样(spec §R4):微信/企业微信两个 Dock 角标数字。
 *
 * 命令语法定案(调研 2026-08-20-v5-能力调研.md §R4):`lsappinfo info -only StatusLabel -app <bundleID>`。
 * `-only` 是 `info` 子命令的选项,必须紧跟在 `info` 后面——简报早期写的
 * `lsappinfo -only StatusLabel info -app <id>` 顺序在这台机器的 lsappinfo 版本上跑不通:
 * `-only`/`StatusLabel` 会被当成两个独立的顶层命令,各自报 "Unrecognized command"(不致命,
 * 继续往下解析),看起来"什么都没输出",实际是命令语法错了,不是这条路径读不到数据。
 *
 * bundle id(§R4 用 `osascript -e 'id of app "..."'` 与 §R1/R2 的 `plutil -p` 交叉验证过):
 * wechat=com.tencent.xinWeChat、wecom=com.tencent.WeWorkMac——这是调研当时双开
 * 还在的实况。2026-08-22 实况:主微信客户端已删除,仅存 WeChat2.app,角标取数
 * 跟 activation.ts 的 APP_BUNDLES 同源对齐,wechat 改指向 com.tencent.xinWeChat2、
 * 删掉 wechat2 这一档——不然 wechat 永远查一个已删除应用的 bundle id,角标静默
 * 死掉,而真正在跑的 WeChat2 的未读数据没人读。
 * 2026-08-24 真机实况(A2a,跟 activation.ts APP_BUNDLES 同一条证据):WeChat2.app 升级到
 * 4.1.13 后 plist id 又翻回了 com.tencent.xinWeChat——这里同步改回去,否则角标会在
 * 那次更新之后重新静默死掉(这张表跟 activation.ts 不共享同一个常量,各自维护,漏改
 * 一处就是一处死角标)。
 *
 * 空输出的歧义(§R4 补测的核心结论):`StatusLabel` 对"应用未运行"和"应用在跑但没有未读"
 * 输出完全相同——都是空字符串、exit 0,单看这一个字段分不出来。所以必须先查一次 pid
 * (`lsappinfo info -only pid -app <bundleID>`)确认应用是否在跑,再决定怎么解释 `StatusLabel`:
 * - 没有 pid → 应用没开(或 bundle id 根本不存在),界面不该显示角标 → 返回 null。
 * - 有 pid 但 label 是空字符串 → 应用开着、真的没有未读,是一条明确的"零"信号 → 返回 0。
 *   0 和 null 在协议里语义不同(见 protocol.ts `badges` 字段注释):null = 没接入/没开,
 *   0 = 接入了、当前没有未读。把"开着但没读到有效角标"一律记成 null 会把"这个来源没打开"
 *   和"这个来源打开了只是没有未读"混成一件事,界面没法区分。
 *
 * label 非空时的格式没有实测样本(§R4 明确写"这不能当实测结论,只是推断"):解析只认两种
 * 明确形状——纯数字字符串直接转数字;"99+"这类上限文案按数字部分算。除此之外一律 null,
 * 不去猜它是什么意思(比如某种 emoji/圆点占位符)——错的猜测比说"不知道"更害人。
 */
import { createSampleCache } from './sampleCache.ts'

export type RunCommand = (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>

/** 两个角标来源的 bundle id,键名即 /state.badges 里对外的字段名。 */
const BUNDLE_IDS: Record<string, string> = {
  wechat: 'com.tencent.xinWeChat',
  wecom: 'com.tencent.WeWorkMac',
}

/** 从 `lsappinfo info -only StatusLabel -app <id>` 的原始输出里抠出 `label` 字段的值,抠不到就是空字符串。 */
function extractLabel(out: string): string {
  const match = /"label"\s*=\s*"([^"]*)"/.exec(out)
  return match?.[1] ?? ''
}

/**
 * 解析 StatusLabel 的 label 内容 → 数字。这一层只管"这段文本能不能读成数字",
 * 不知道也不关心应用有没有在跑——空字符串同样返回 null,"跑着且空 → 0"这条裁决
 * 是 readOne/createBadgesSampler 的责任,不下沉到这里。
 */
export function parseStatusLabel(out: string): number | null {
  const label = extractLabel(out)
  if (label === '') return null
  if (/^\d+$/.test(label)) return Number(label)
  const capped = /^(\d+)\+$/.exec(label)
  if (capped !== null) return Number(capped[1])
  return null // 非数字、非"NN+"格式的垃圾内容,如实返回不知道,不猜
}

/** 从 `lsappinfo info -only pid -app <id>` 的输出判断应用是否在跑。 */
function hasPid(out: string): boolean {
  return /"pid"\s*=\s*\d+/.test(out)
}

/** 读一个来源的角标:先查 pid 定运行状态,再按运行状态解释 StatusLabel。 */
async function readOne(run: RunCommand, bundleId: string): Promise<number | null> {
  const pidResult = await run(['lsappinfo', 'info', '-only', 'pid', '-app', bundleId])
  if (!pidResult.ok) return null // 连"有没有在跑"都查不到,如实标未接入,不猜
  if (!hasPid(pidResult.stdout)) return null // 没有 pid → 应用没开(或 bundle id 不存在)

  const labelResult = await run(['lsappinfo', 'info', '-only', 'StatusLabel', '-app', bundleId])
  if (!labelResult.ok) return null // 应用在跑,但读角标这条命令本身失败了,同样如实标未接入

  const label = extractLabel(labelResult.stdout)
  if (label === '') return 0 // 跑着且 label 空 → 明确的"零未读"信号(§R4 裁决)
  return parseStatusLabel(labelResult.stdout) // 非空:能读成数字就给数字,读不懂就 null,不猜
}

/**
 * 造一个"采一次角标"函数,内置最短间隔缓存(默认 5 秒),请求驱动、不额外起 setInterval——
 * 只有 GET /state 真的来问才会真去跑三条 `lsappinfo`。
 *
 * 2026-08-26 从 60 秒收紧到 5 秒(Ben 实报:气泡比真实消息慢很多、读完消息气泡还挂着):
 * 60 秒缓存意味着角标的出现和消失最坏各迟一分钟。这不是新增轮询回路——采样仍然只在
 * GET /state 来问时发生(界面本来就按 1s 轮询 /state),改的只是"多久肯真跑一次 lsappinfo"
 * 的参数。成本实测量级:一轮 4 条 lsappinfo 共 ~50ms,5 秒一轮可忽略。
 *
 * single-flight（2026-08-21 真机实测补的,与 machine.ts 同一个根因）：冷启动时展示台
 * 按 1 秒轮询,重启后第一秒内的并发请求会各自发现缓存是空的、各自起一轮 `lsappinfo`——
 * 这里把"正在进行的那次采样"存成共享 promise,并发调用者共享它,不各自重开一轮。
 *
 * 过期了先回上一份、后台补采,不让碰上的那一拍 `/state` 干等(2026-10-21;三格同一份,见 sampleCache.ts)。
 */
export function createBadgesSampler(
  run: RunCommand,
  now: () => number,
  minIntervalSec = 5,
): () => Promise<Record<string, number | null>> {
  return createSampleCache(
    async () => Object.fromEntries(await Promise.all(
      Object.entries(BUNDLE_IDS).map(async ([key, bundleId]) => [key, await readOne(run, bundleId)] as const),
    )),
    now,
    minIntervalSec,
  )
}
