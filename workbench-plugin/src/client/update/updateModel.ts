/**
 * 「更新」那一节里**所有的判断与措辞**(2026-09-18)。纯函数,一个 React 都不碰 ——
 * 照 `client/setup/steps.ts` 同一条规矩:界面会改,这几句话不该跟着界面一起没人验。
 *
 * 目标用户不懂代码,所以这里每一句都得是能直接念出来的话:
 * 不出现「HTTP 404」「sha256」「manifest」,也不出现「更新失败」这种什么也没说的四个字。
 */
import type { SetupJobView } from '../../server/setup/types.ts'
import type { UpdateCheckView, UpdateJobView, UpdateRuntimeStaleView } from '../../server/update/types.ts'
import { humanSize } from '../../server/update/types.ts'

/** 这一节此刻处在哪一档。界面按它决定画什么。 */
export type UpdateStage =
  /** 还没查过。 */
  | 'idle'
  /** 正在查。 */
  | 'checking'
  /** 查过了,已经是最新的。 */
  | 'latest'
  /** 有新版,等着点「立即更新」。 */
  | 'available'
  /** 查不到(没网 / 服务器那边有事)。 */
  | 'unreachable'
  /** 这台太旧,热更新跨不过去,要重新装一次。 */
  | 'needs_installer'

export function stageOf(view: UpdateCheckView | undefined, checking: boolean): UpdateStage {
  if (checking) return 'checking'
  if (view === undefined) return 'idle'
  if (view.needs_installer !== undefined) return 'needs_installer'
  if (view.error !== undefined) return 'unreachable'
  return view.available ? 'available' : 'latest'
}

/** 那一节里最显眼的那一句。 */
export function headlineOf(view: UpdateCheckView | undefined, stage: UpdateStage): string {
  switch (stage) {
    case 'idle':
    case 'checking':
      // 打开这一页就自己查了(2026-09-28,卡 UP),所以「还没查过」这一档在人眼里不存在。
      return '正在看有没有新版…'
    case 'latest':
      return `已经是最新的了(${view?.current ?? '?'})。`
    case 'available':
      return `有新版:${view?.latest ?? '?'}(你现在是 ${view?.current ?? '?'})。`
    case 'unreachable':
      // 服务端已经把"没网 / 服务器 404 / 清单写坏了"翻成人话了,原样说出来 ——
      // 再包一层「检查失败」只会把那句真正有用的话推远。
      return view?.error ?? '这会儿没查到,多半是没网。过一会儿再点一次。'
    case 'needs_installer':
      return view?.needs_installer ?? '这台电脑上的工作台太旧了,要重新装一次。'
  }
}

/* ─────────── 官网那一句(2026-09-28,卡 UP) ─────────── */

/** 安装包只从官网拿。**全仓库只有这一处写这个地址**,界面上不出现 dmg 直链。 */
export const OFFICIAL_SITE = 'www.aibooo.cn'

/**
 * 「给另一台电脑装」那一行小字,排在这一节最底下。
 *
 * 09-28 维护者在这一页点了「下载安装包」(以为那是更新),下到的是给新电脑用的 dmg:
 * **一颗跟「更新」长得一样的按钮,做的却是另一件事**。所以那颗按钮没了,
 * 剩下这一句话与一个可以照着打开的网址 —— 拿地址是"顺手"的事,不该长成一个动作。
 */
export const INSTALLER_HINT = `给另一台电脑装:打开 ${OFFICIAL_SITE} 下载`

/**
 * 这台太旧、热更新跨不过去时那一句。同样指官网,不给 dmg 直链 ——
 * 官网上永远是最新那一份,直链会过期。
 */
export const NEEDS_INSTALLER_HINT
  = `打开 ${OFFICIAL_SITE},下载最新的安装包,双击装一遍就好 —— 你的项目、事项、记忆都不会动。`

/** 「立即更新」那颗按钮上写什么;`undefined` = 这一档根本不该有这颗按钮。 */
export function applyLabelOf(view: UpdateCheckView | undefined, stage: UpdateStage): string | undefined {
  if (stage !== 'available') return undefined
  const latest = view?.latest
  // 按钮上把**这一下会发生什么**说全:有新版、更新、然后重启。
  // 下载多大不写在按钮上 —— 那是旁边那句账的事(09-28 卡 UP:一颗按钮,一句人话)。
  return latest === undefined ? '更新并重启' : `有新版 ${latest},更新并重启`
}

/** 进度框里那一行大字。跑完、失败、重启中各有各的说法。 */
export function jobHeadlineOf(job: UpdateJobView): string {
  if (job.state === 'failed') return job.error ?? '没做完,原因没说清楚 —— 下面那几行原始输出是唯一的线索。'
  if (job.restarting === true) return '重启中…几秒后页面会自己回来。'
  if (job.state === 'done') return `装好了(${job.version})。`
  return job.note ?? `${job.phase}…`
}

/**
 * 进度条上的数。**只增不减** —— 一个会往回跳的进度条比没有进度条更让人不安。
 * (服务端那边已经保证了单调,这里再夹一次是因为轮询回来的顺序不保证。)
 */
export function progressOf(job: UpdateJobView, previous: number): number {
  return Math.max(previous, Math.min(100, Math.max(0, Math.round(job.progress))))
}

/**
 * 失败之后那颗按钮写什么。**一律是「重试」而不是「重新更新」**:每一步都幂等,
 * 已经下好、已经装好的不会重来 —— 这句话要让人敢按第二下。
 */
export const RETRY_HINT = '已经下好的那几样不会重下,点重试是从断的那一步接着来。'

/* ─────────────────── 只下变了的 / 进度上的那几个数(2026-09-18) ─────────────────── */

/**
 * 「5 项里 2 项有变化,下载 12MB」。`undefined` = 这一档不该出现这句话。
 *
 * 为什么要这一句:Ben 看到的是一颗「立即更新(要下 12MB)」的按钮,而上一版那颗写的是
 * 128MB。**不解释一句,他会以为是漏下了。** 这句话就是那个解释。
 */
export function planLineOf(view: UpdateCheckView | undefined, stage: UpdateStage): string | undefined {
  if (stage !== 'available') return undefined
  const plan = view?.plan
  if (plan === undefined || plan.total === 0) return undefined
  if (plan.changed === 0) {
    return `这一版的 ${plan.total} 样东西跟你这台电脑上装着的一模一样,不用下也不用换。`
  }
  if (plan.changed === plan.total) {
    return `这一版有 ${plan.total} 样东西要下,合计 ${humanSize(plan.bytes)}。`
  }
  const saved = plan.all_bytes - plan.bytes
  return `${plan.total} 项里 ${plan.changed} 项有变化,下载 ${humanSize(plan.bytes)}`
    + (saved > 0 ? `(另外 ${plan.total - plan.changed} 项跟你机器上那份一样,省下 ${humanSize(saved)})。` : '。')
}

/* ─────────── 运行环境还没换到这一版(2026-09-26,卡 U6) ─────────── */

/**
 * 那一格里最显眼的那一句。**优先说"这会儿正在发生什么"**:
 * 自动补正在跑 / 刚失败 / 试过两次不再自动试了,这三种都比"运行环境还是旧的"更要紧 ——
 * 他要知道的是这会儿该不该等、该不该点。
 */
export function runtimeStaleLineOf(stale: UpdateRuntimeStaleView | undefined): string | undefined {
  if (stale === undefined) return undefined
  const repair = stale.repair
  if (repair !== undefined && repair.says !== '') return repair.says
  return stale.says
}

/**
 * 那颗按钮写什么;`undefined` = 这会儿不该有按钮。
 *
 * 自动补正在跑的时候**不给按钮**(点第二下不会更快,只会让人以为刚才那下没算);
 * 除此之外一律给 —— 包括失败之后与"不再自动试了"之后,那正是这颗按钮存在的时候。
 */
export function runtimeStaleButtonOf(
  stale: UpdateRuntimeStaleView | undefined,
  busy: boolean,
  /** 这会儿那颗「有新版,更新并重启」在不在屏上(2026-09-28,卡 UP)。 */
  updateOnScreen = false,
): string | undefined {
  if (stale === undefined) return undefined
  if (busy) return undefined
  if (stale.repair?.state === 'running') return undefined
  // **同一时刻屏上最多一颗主按钮**(09-28 卡 UP:三颗长得一样的按钮谁也分不清)。
  // 有新版时该先按的是「更新并重启」—— 更新那一趟本来就会把运行环境一起换好。
  if (updateOnScreen) return undefined
  return stale.action_label
}

/**
 * 有新版时,运行环境那一行后面补的半句:说清它跟「更新」的关系,
 * 免得他以为这里还欠着一件要他动手的事。
 */
export const RUNTIME_AFTER_UPDATE_HINT = '更新那一下会把运行环境一起换好,先点上面那颗就行。'

/** 「装运行环境」那一趟进度框里那一行大字。跟更新作业那一行同一套说法。 */
export function runtimeJobHeadlineOf(job: SetupJobView): string {
  if (job.state === 'failed') return job.error ?? '没装成,原因没说清楚 —— 下面那几行原始输出是唯一的线索。'
  if (job.state === 'done') return job.note ?? '装好了。'
  return job.note ?? '正在装 DSH 运行环境…'
}

/** 「2 分 10 秒」这种。给人看的,不求精确 —— 超过一小时就只说「一小时以上」。 */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
  }
  return '一小时以上'
}

/**
 * 进度框里那一行小字:「已下 12.3 MB / 28.0 MB · 1.2 MB/秒 · 大约还要 13 秒」。
 *
 * **每一段都可能缺席**:服务端算不出速度就不给速度,于是这里也不写那半句
 * (0918 那张卡第 4 条:宁可停着不动,也不编一个假的在那儿爬)。
 * 下载那一段过去之后整行消失 —— 解包与安装不是按字节走的。
 */
export function downloadLineOf(job: UpdateJobView): string | undefined {
  const d = job.download
  if (d === undefined || d.total <= 0) return undefined
  if (job.state !== 'running') return undefined
  const parts = [`已下 ${humanSize(d.done)} / ${humanSize(d.total)}`]
  if (d.bytes_per_sec !== undefined && d.bytes_per_sec > 0) parts.push(`${humanSize(d.bytes_per_sec)}/秒`)
  if (d.eta_seconds !== undefined) parts.push(`大约还要 ${humanDuration(d.eta_seconds)}`)
  return parts.join(' · ')
}

/** 收热修、可服务器上这会儿还没有单独的热修版时那一句(服务端照稳定版那份查的)。 */
export const CHANNEL_FALLBACK_HINT = '热修这会儿没有单独的版本,跟着稳定版走。'

/**
 * 「收哪条更新」那一格底下的小字(2026-10-21)。没查过(不知道是哪条)就不说。
 * 热修那一句要把"切回稳定版会怎样"说在前面:切回去不降级,等稳定版追上来再收。
 */
export function channelHintOf(view: UpdateCheckView | undefined): string | undefined {
  if (view?.channel === undefined) return undefined
  if (view.channel === 'stable') return '每周一版,发之前都在一台新机器上从头演练过一遍安装。体验的人用这一条。'
  if (view.channel_fallback === true) return CHANNEL_FALLBACK_HINT
  return '修完就发,一天可能好几版。切回稳定版不会退回旧版,等稳定版追上来再收。'
}
