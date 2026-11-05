import { isAbsolute, relative, resolve, sep } from 'node:path'
import { sayDecisionEvents } from './sayDecisionRoomEvent.ts'
import type { SayReply } from './sayTurn.ts'

export interface SentDecisionPacket { event_id: string, call_id?: string, packet: string }
export interface RoomDecisionReplay {
  list: () => SentDecisionPacket[]
  replay: (eventId: string) => Promise<boolean>
}

/** Explicit QA process only; the ordinary text test switch alone never enables capture. */
export function roomReplayEnabled(env: Record<string, string | undefined>): boolean {
  if (env.WORKBENCH_CHANNEL_ROOM_REPLAY_QA !== '1' || !['1', 'on', 'true', 'yes'].includes(env.WORKBENCH_CHANNEL_TEXT_TURN ?? '')) return false
  const root = env.WB_FIXTURE_CAPTURE_ROOT
  const home = env.HOME
  if (!root || !home || !isAbsolute(root) || !isAbsolute(home) || resolve(root) === sep) return false
  const inside = relative(root, home)
  return inside !== '' && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)
}

/** Both normal and QA sends use this publisher; only successfully sent immutable packets can be replayed. */
export function createSayDecisionPublisher(input: { publish: (packet: string) => Promise<void>, qa?: boolean }): {
  send: (reply: SayReply, callId?: string) => Promise<void>
  qa?: RoomDecisionReplay
} {
  const sent = input.qa ? new Map<string, SentDecisionPacket>() : undefined
  return {
    async send(reply, callId) {
      // Start each send immediately as before, without serialising distinct decision cards.
      await Promise.all(sayDecisionEvents(reply, callId).map(async event => {
        const packet = JSON.stringify(event)
        await input.publish(packet)
        if (sent && !sent.has(event.event_id)) {
          sent.set(event.event_id, { event_id: event.event_id, ...(event.call_id === undefined ? {} : { call_id: event.call_id }), packet })
          if (sent.size > 32) sent.delete(sent.keys().next().value!)
        }
      }))
    },
    ...(sent === undefined ? {} : { qa: {
      list: () => [...sent.values()].map(record => ({ ...record })),
      async replay(eventId: string) {
        const record = sent.get(eventId)
        if (!record) return false
        await input.publish(record.packet)
        return true
      },
    } }),
  }
}
