/**
 * 「现在能不能出声」——**整个产品只有这一处判断**(2026-09-26,卡 QH)。
 *
 * ## 为什么要它
 *
 * 免打扰时段(`/call/config` 的 `quiet_from` / `quiet_to`,维护者设的是 21:00–08:30)原来只长在
 * 座机那条路里:`planCallOuts` 拿它决定一通电话响不响。别的出声点谁也不知道有这回事 ——
 * 2026-09-26 00:19 手机冷启动,首页顶上就出现了「停止朗读」:朗读在半夜念东西。
 * 维护者的规矩只有一句:**晚上 9 点以后不想被打扰**。那句话管的不是「电话」,是「声音」。
 *
 * 所以时段判断从 callOut.ts 搬到这里,并且**不许再有第二份**:
 * 服务端把结论摆在 `/state.quiet`(见 protocol.ts 的 `QuietView`),
 * 来电、朗读、提示音、手机与电脑的一切出声都读那一格。各处各写一份的结果就是这次这种
 * ——一处对了、别处还在响。
 *
 * ## 它**不**管什么
 *
 * - **他自己按下的「播放 / 朗读 / 回拨」不受它管**:那是他要的声音,不是打扰。
 *   这一层只回「此刻算不算免打扰时段」,「拦不拦」由每个出声点自己按「是他按的吗」决定。
 * - 它不关心界面:字幕、气泡、通知照常出。免打扰是**不出声**,不是不告诉他。
 */

/** `'23:00'` → 分钟数。读不出来就 undefined(**不猜一个 0 出来**:那是午夜,会把整晚静音)。 */
export function parseClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (matched === null) return undefined
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/**
 * 这个时刻在静默时段里吗。
 *
 * **跨零点是常态不是边角**:维护者设的 21:00–8:30 就跨。两头相等 = 整天静默(他真想那样就随他),
 * 两头有一个读不出来 = **不静默**(读不出来就别替他静音 —— 那会让他以为座机坏了、朗读坏了)。
 */
export function inQuietHours(at: Date, from: unknown, to: unknown): boolean {
  const start = parseClock(from)
  const end = parseClock(to)
  if (start === undefined || end === undefined) return false
  const minutes = at.getHours() * 60 + at.getMinutes()
  if (start === end) return true
  if (start < end) return minutes >= start && minutes < end
  // 跨零点:21:00–8:30 = 「晚上 21 点之后」或者「早上 8 点半之前」。
  return minutes >= start || minutes < end
}

/**
 * 免打扰时段里那句「为什么不出声」。**一句人话,不带键名、不带时段以外的术语**;
 * 界面把它和 `until` 拼成「免打扰中 · 08:30 后恢复」这类话。
 */
export const QUIET_REASON = '免打扰时段'

/** {@link quietViewOf} 的入参。`from` / `to` 直接喂 `/call/config` 里那两格,读不出来这一层自己兜。 */
export interface QuietViewInput {
  at: Date
  from: unknown
  to: unknown
}

/** 与 protocol.ts 的 `QuietView` 同形(这一层不 import protocol,避免 server → protocol 的反向依赖打结)。 */
export interface QuietViewShape {
  active: boolean
  from?: string
  to?: string
  until?: string
  reason?: string
}

/**
 * `/state.quiet` 那一格。
 *
 * - 时段读得出来就带 `from` / `to`(时段外也带 —— 设置里要显示、界面要说得出「几点起不出声」);
 * - **读不出来时整个时段缺席**(只回 `{ active: false }`):不编一个 23:00–08:00 出来当真的;
 * - `until` / `reason` 只在 `active` 时有 —— 没在免打扰里就没有「几点恢复」这回事。
 */
export function quietViewOf(input: QuietViewInput): QuietViewShape {
  const from = parseClock(input.from)
  const to = parseClock(input.to)
  if (from === undefined || to === undefined) return { active: false }
  const fromText = String(input.from).trim()
  const toText = String(input.to).trim()
  const active = inQuietHours(input.at, input.from, input.to)
  return {
    active,
    from: fromText,
    to: toText,
    ...(active ? { until: toText, reason: QUIET_REASON } : {}),
  }
}
