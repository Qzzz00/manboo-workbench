/**
 * 最后已知额度落盘。
 *
 * 为什么需要：Claude 那格是 statusLine **推**上来的，而它触发得不规律
 *（真机实测：11:41、14:47、14:58 各来一批，之间隔几小时）。
 * 服务是纯内存的，DSH 一重启就清零——Ben 就会看到「等 statusLine 上报」，
 * 而实际上二十分钟前刚收到过一份好数据。
 *
 * 只存**推送型**的来源（claude）。拉取型的（dsh/codex/kimi）下一轮几秒内就重采，
 * 存了反而可能在启动瞬间盖住更新的值。
 *
 * 这不算"引入数据库"（PRD §2.2）：一个几百字节的 JSON，只为跨重启保住最后一次已知状态，
 * 和架构约束 C1「Agent 层挂掉时看板要继续显示上一次已知状态」是同一个意思。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentId, QuotaEntry } from '../protocol.ts'

/** 只有这些来源值得跨重启保留：它们等的是外部推送，不是我们主动去取。 */
const PUSHED: readonly AgentId[] = ['claude']

export function defaultLastQuotaFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/last-quota.json`
}

export async function loadLastQuota(file: string): Promise<Partial<Record<AgentId, QuotaEntry>>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return {}
  }

  try {
    const parsed = JSON.parse(text) as { quota?: unknown }
    const quota = parsed?.quota
    if (typeof quota !== 'object' || quota === null) return {}

    const out: Partial<Record<AgentId, QuotaEntry>> = {}
    for (const agent of PUSHED) {
      const entry = (quota as Record<string, unknown>)[agent]
      if (typeof entry !== 'object' || entry === null) continue
      /**
       * **没有「截至什么时候」的那一份不载入**(2026-10-02,卡 QA)。
       *
       * 这份文件就是跨重启顶回界面的那一份,而顶回去的数**没有年纪**时,界面只能把它当此刻的数画。
       * 真机上这一格是 2026-09-26 22:10 收到的那次 statusLine 推送(「周 54%、09-29 重置」),
       * 到 10-02 还躺在文件里 —— 重置时刻都已经是过去式了。时刻我们**编不出来**(文件里没有),
       * 所以宁可这一格空着(下一轮真读到就有了),也不让一份说不出年纪的数顶上来(D13)。
       *
       * 我们自己写下的每一份都带 `as_of`(statusLine 那条在 `parseClaudeStatusLine` 里填),
       * 所以走到这一条的只有升级前留下的那一份,只会发生一次。
       */
      if (typeof (entry as { as_of?: unknown }).as_of !== 'string') continue
      out[agent] = entry as QuotaEntry
    }
    return out
  }
  catch {
    // 写坏了就当没有。界面会显示"等上报"，那是此刻的真实状态。
    return {}
  }
}

export async function saveLastQuota(
  file: string,
  quota: Partial<Record<AgentId, QuotaEntry>>,
): Promise<void> {
  const keep: Partial<Record<AgentId, QuotaEntry>> = {}
  for (const agent of PUSHED) {
    const entry = quota[agent]
    // unknown 不存：它没有保存价值，还会在下次启动时盖掉那句更准确的初始说明。
    if (entry !== undefined && entry.kind !== 'unknown') keep[agent] = entry
  }

  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ quota: keep }, null, 2)}\n`)
}

/**
 * 把某一家的记录从这份文件里删掉(2026-09-18,凭据被清空那一刻)。
 *
 * 为什么不能只清内存:重启之后 `loadLastQuota` 会把它顶回界面上 —— 那正是
 * 「凭据都删了,余额还在」最难查的一种变体(屏幕上的数字来自一个已经不存在的
 * 凭据文件里的一把已经不存在的 Key)。
 *
 * **文件不在就什么都不做**,不顺手建一个空的:第一次用本来就没有这个文件,
 * 凭空建一个只会让"到底采过没有"从此看不出来。
 */
export async function forgetLastQuota(file: string, agent: AgentId): Promise<void> {
  try {
    await readFile(file, 'utf8')
  }
  catch {
    return
  }

  const current = await loadLastQuota(file)
  if (current[agent] === undefined) return
  delete current[agent]
  await saveLastQuota(file, current)
}
