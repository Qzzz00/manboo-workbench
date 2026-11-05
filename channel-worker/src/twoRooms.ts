/**
 * 两间房各一条工人时,工人这一侧那几件事(2026-10-22,局域网主路 M6;docs/设计-局域网主路-2026-10-21.md 第三节)。
 *
 * 8791 看管两条工人:本机房间一条(在家的听筒、手机)、云房间一条(出门的手机),两条都叫 `wb-channel-worker`、
 * 各在一间房。同一通来电两间房都响,谁先接谁出声:
 *
 *   1. 每拍按**自己那间房**领(`/call/claim {room}`,{@link claimRoomTick})。房里没有设备就不领、一个请求都不发
 *      —— 领走即转「振铃中」,没人听得见的铃是在记一件没发生的事,空着的那间房那条工人也就不空转;
 *   2. 有人按了「接起」先问 8791 谁先接(`/call/answered`,{@link answerFirst}):这边先接才放行开口;
 *      别的房间先接了就不出声,这间房广播 `ring_end{canceled}` 收铃,按「接起」的那台回一句人话;
 *   3. 另一间房下一拍从 `answered_elsewhere` 知道「在别处接了」,收掉自己的铃;
 *   4. 回 8791 的每一句都带自己那间房({@link ackOf}):一间房「没接」不落整通未接,在别处接了只记这间房回过话。
 *
 * 老 8791(没有按房间领 / 先接先得)照样能用:不认 `room` 的回包形状不变,`/call/answered` 问不到当这边先接。
 */
import type { RingCall, RingMachine, RingOutcome } from './callOut.ts'
import { parseRingCall, shouldRing } from './callOut.ts'
import type { AnsweredVerdict, ChannelRoute, RoomClaim } from './workbench.ts'
import { channelRouteOf } from './workbench.ts'

export { ANSWERED_ELSEWHERE_TEXT } from './callOut.ts'

/** 8791 在进程环境里告诉工人「你是哪条路线」那一格。与 `workbench-plugin/src/server/channelWorkerFleet.ts` 同一个名字(有对照用例)。 */
export const WORKER_ROUTE_ENV = 'WORKBENCH_CHANNEL_WORKER_ROUTE'

/** 按「接起」的那台、而别的房间已经先接了时,回给它的那句话(手机据此收掉自己那一屏)。 */
export const ANSWERED_ELSEWHERE_ERROR = '这一通已经在别处接起了'

/** 进程环境里的路线。认不出 / 没给 = undefined(取票时不点名,8791 照老规矩签)。 */
export function workerRouteOf(env: Record<string, string | undefined>): ChannelRoute | undefined {
  return channelRouteOf(env[WORKER_ROUTE_ENV]?.trim())
}

/** 一拍领电话。见文件头第 1、3 条。 */
export async function claimRoomTick(deps: {
  room: string
  /** 房里此刻有没有手机或听筒。 */
  devicePresent: () => boolean
  claim: (room: string) => Promise<RoomClaim>
  ring: Pick<RingMachine, 'ring' | 'answeredElsewhere'>
  /** 这条工人不认识的那一通(它重起过)在别处接了:直接回一句「这间房回过话了」,8791 不再提。 */
  ack: (id: string) => void
  log: (line: string) => void
}): Promise<void> {
  if (!deps.devicePresent()) return
  const claimed = await deps.claim(deps.room)
  for (const one of claimed.answered_elsewhere) {
    if (deps.ring.answeredElsewhere(one.id)) continue
    deps.ack(one.id)
  }
  for (const raw of claimed.calls) {
    const call = parseRingCall(raw)
    if (call === undefined) { deps.log('[channel-worker] 领到一通读不懂的电话,跳过'); continue }
    // 事务官自己的提议不该让座机响(2026-09-27,卡 WY):老 8791 还会交下来,这里兜一道。
    if (!shouldRing(call)) { deps.log(`[channel-worker] 这一通是提议不是卡住的事,不响:${call.title}`); continue }
    deps.ring.ring(call)
  }
}

/** 接起之前先问谁先接。见文件头第 2 条。 */
export async function answerFirst(
  deps: {
    room: string
    callAnswered: (input: { id: string, room: string, device_id?: string }) => Promise<AnsweredVerdict>
    ring: Pick<RingMachine, 'current' | 'answeredElsewhere'>
    log: (line: string) => void
  },
  input: { callId: string, deviceId?: string },
): Promise<{ ok: true } | { ok: false, error: string }> {
  // 这边压根没在响这一通:不去问,那一句错由振铃机自己说。
  if (deps.ring.current()?.id !== input.callId) return { ok: true }
  const verdict = await deps.callAnswered({
    id: input.callId,
    room: deps.room,
    ...(input.deviceId === undefined ? {} : { device_id: input.deviceId }),
  })
  if (verdict.first) {
    if (verdict.unknown === true) deps.log('[channel-worker] 问不到工作台谁先接,当这边先接')
    return { ok: true }
  }
  deps.log(`[channel-worker] 这一通已经在${verdict.room === undefined ? '别的房间' : `房间 ${verdict.room} `}接起了,这边不出声`)
  deps.ring.answeredElsewhere(input.callId)
  return { ok: false, error: ANSWERED_ELSEWHERE_ERROR }
}

export interface RoomAck {
  id: string
  result: 'answered' | 'missed' | 'notified' | 'failed'
  error?: string
  fail_kind?: 'tech'
  room: string
}

/**
 * 这一通在这间房怎么收场的 → 回 8791 那一句。被取消的记 `failed`(它不是「他没接」,是这一通压根没打成;
 * 工人这边取消只有一种来由:和房间断开 / 工人退出,是技术失败);在别处接了记「接了」(台账已经是接了,只记这间房回过话)。
 */
export function ackOf(call: Pick<RingCall, 'id'>, outcome: RingOutcome | 'elsewhere', text: string | undefined, room: string): RoomAck {
  if (outcome === 'elsewhere') return { id: call.id, result: 'answered', room }
  return {
    id: call.id,
    result: outcome === 'canceled' ? 'failed' : outcome,
    ...(text === undefined ? {} : { error: text }),
    ...(outcome === 'canceled' ? { fail_kind: 'tech' as const } : {}),
    room,
  }
}
