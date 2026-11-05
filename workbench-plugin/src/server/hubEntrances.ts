/**
 * 电话与手机两个入口接到理解中枢(A2,2026-10-28;设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第六节)。
 *
 * 判断全在 `hub/`(A1);这里只做入口适配:
 * - 入口映射:`/butler/say` 的 `entrance` + `ctx.in_call` 认成中枢的三入口;认不出 = 走旧路(老调用方一字不变);
 * - 电话那份回包:理解没成也回标准形状念一句「没动」。
 * 执行口 / 上下文包两条路由直接用 `hub/run.ts` 的 `hubExecute` / `hubContext`。
 */
import { randomUUID } from 'node:crypto'
import type { HubEntrance } from './hub/context.ts'
import type { HubReply } from './hub/run.ts'

/**
 * `/butler/say` 的入口 → 中枢入口。电话工人早先每句都发 `entrance:'phone'` + `ctx.in_call`(现在发 `call`),
 * 手机文字老包发 `phone_text`(现在发 `phone`);两种老写法都认。
 */
export function hubEntranceOf(entrance: unknown, inCall: unknown): HubEntrance | undefined {
  if (entrance === 'desktop') return 'desktop'
  if (entrance === 'call') return 'call'
  if (entrance === 'phone') return inCall === true ? 'call' : 'phone'
  if (entrance === 'phone_text') return 'phone'
  return undefined
}

/** 电话里理解没成时念的那一句(电脑那份「原话还在输入框里」电话上不成立)。 */
export const CALL_HUB_UNREACHABLE = '我这会儿没连上理解服务,这句没动,等一下再说一遍?'
export const CALL_HUB_BAD_OUTPUT = '这句我没听明白,先没动,换个说法再说一遍?'

/**
 * 电话入口的回包:理解没成(503 接不上 / 502 坏输出)也回 200 的标准形状,念一句「没动、再说一遍」。
 * 工人对非 200 一律念「电话入口暂时不可用」,而这两种都是确定没办的(一张卡都没建),照实说更准。
 * 手机文字不转:待发箱按 5xx 自动补发、按 4xx 摆错,本来就是对的。
 */
export function callReplyOf(out: HubReply, newId: () => string = randomUUID): HubReply {
  if (out.status !== 502 && out.status !== 503) return out
  const line = out.status === 503 ? CALL_HUB_UNREACHABLE : CALL_HUB_BAD_OUTPUT
  return { status: 200, body: { say_id: newId(), items: [], say: { screen: line, spoken: line }, hub: out.body.hub ?? { why: out.status === 503 ? 'unreachable' : 'bad_output' } } }
}
