/**
 * **Agent 的小鼠标**(2026-10-21 协作区,设计稿 3.4;维护者 10-21:「我希望 Agent 也有小鼠标」)。
 *
 * Agent 没有鼠标,它有的是「现在在哪张便签上」。这一格**由任务账的事件推**(`jobLog` 的 `JobStep`,不新加步):
 *
 * | 账上的事件 | 小鼠标 |
 * |---|---|
 * | `assigned` | 从名片滑向那张便签(moving) |
 * | `sent` / `seen` / `waiting` | 停在便签上干活(working) |
 * | `replied` / `done` | 在便签上盖一下章(stamping),界面画完就滑回名片 |
 * | `timeout` / `unreadable` / `not_sent` / `gate_block` / `budget_stop` | 回名片(idle,没有 on_note) |
 *
 * **不进账、不进快照、不落盘**:它是即时画面,不是事实。经 `/live` 的 `kind:'presence'` 广播,
 * 刚打开板的那一页用 `GET /collab/presence` 拿一次现在的样子;重启就没了(本来就该没了)。
 */
import type { CollabPresence, PresenceState } from '../protocol.ts'
import type { JobEvent, JobStep } from './jobLog.ts'

const STATE_OF: Partial<Record<JobStep, PresenceState>> = {
  assigned: 'moving',
  sent: 'working',
  seen: 'working',
  waiting: 'working',
  replied: 'stamping',
  done: 'stamping',
  timeout: 'idle',
  unreadable: 'idle',
  not_sent: 'idle',
  gate_block: 'idle',
  budget_stop: 'idle',
}

/** 一条账上的事件 → 小鼠标此刻的样子。与板无关的那几步(电话、闸放行)回 undefined。 */
export function presenceOfJob(event: JobEvent): CollabPresence | undefined {
  const state = STATE_OF[event.step]
  if (state === undefined || event.family === undefined || event.family === '') return undefined
  return {
    actor: { kind: 'agent', id: event.family },
    ...(state === 'idle' ? {} : { on_note: event.job }),
    state,
    at: event.at,
  }
}

/** 过了这么久没新动静的小鼠标不再画(半小时:一件活卡着不动,画一个永远在那儿的光标是假的)。 */
export const PRESENCE_TTL_MS = 30 * 60_000

export interface PresenceBoard {
  apply: (presence: CollabPresence) => void
  list: () => CollabPresence[]
}

function keyOf(presence: CollabPresence): string {
  return presence.actor.kind === 'agent' ? `agent:${presence.actor.id}` : `member:${presence.actor.account}`
}

export function createPresenceBoard(now: () => number = Date.now): PresenceBoard {
  const latest = new Map<string, CollabPresence>()
  return {
    apply(presence) { latest.set(keyOf(presence), presence) },
    list() {
      const cut = now() - PRESENCE_TTL_MS
      return [...latest.values()].filter((one) => {
        const at = Date.parse(one.at)
        return Number.isFinite(at) && at >= cut
      })
    },
  }
}
