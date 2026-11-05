/**
 * 协作区打 8791 的那几下(2026-10-21)。**只走既有的路**:改便签走 `/task/*`、跟事务官说走 `/butler/item` 与
 * `/butler/item/say`;板自己的几样(摆法、目标、名片、会话挂目标)走 `/collab/*`。客户端不留副本,
 * 以服务端推回来的下一份快照为准(同看板那一套规矩);失败的那一句原样给人看(D13)。
 */
import type { TaskStatus } from '../../protocol.ts'

export interface CollabPost {
  ok: boolean
  body: Record<string, unknown>
  /** 没办成时那一句(服务端给的原话;服务没应答就说没应答)。 */
  error?: string
}

export interface CollabApi {
  /** 当前适配器实际使用的服务来源；只供本域 UI 推导默认值，不参与请求包。 */
  readonly baseUrl?: string
  post: (path: string, body: unknown) => Promise<CollabPost>
  get: <T>(path: string) => Promise<T | undefined>
}

export function collabApi(baseUrl: string, fetchImpl: typeof fetch): CollabApi {
  return {
    baseUrl,
    async post(path, body) {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const got = await res.json().catch(() => ({})) as Record<string, unknown>
        if (res.ok) return { ok: true, body: got }
        return { ok: false, body: got, error: typeof got.error === 'string' ? got.error : '没办成,稍后再试' }
      }
      catch {
        return { ok: false, body: {}, error: '工作台服务没应答,稍后再试' }
      }
    },
    async get(path) {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`)
        if (!res.ok) return undefined
        return await res.json() as never
      }
      catch { return undefined }
    },
  }
}

/** 照转换表一格一格走(`/task/move` 一次只走一格)。走不动就停,回那一句原因。 */
export async function moveAlong(api: CollabApi, id: string, path: readonly TaskStatus[]): Promise<string | undefined> {
  for (const status of path) {
    const moved = await api.post('/task/move', { id, status })
    if (!moved.ok) return moved.error
  }
  return undefined
}
