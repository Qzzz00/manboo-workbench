/**
 * 插件 /live 广播 → 事件(阶段 1 的「按主题」先取最朴素的一刀)。
 *
 * 插件今天每次有变化都把整份 composeState() 推一遍({kind:'snapshot', state}),76 个顶层键、几百 KB。
 * 这里按顶层键比较:变了的键出一条 `state.<键>` / set(payload 是这个键的新值),没了的键出 unset。
 * v3 表 5-2 把这些键再归并成事件种类是下一步的事;阶段 1 先保证「重建出来的镜像与上游一模一样」,
 * 主题名就用键名本身,不在这一层自造分类。
 *
 * 其余广播(event / call / ring / actor_note / hover …)是一次性的通知,不进镜像,原样包成 `live.<kind>`。
 * 心跳 ping 只是连接层的事,不进流。
 */
export interface Change {
  topic: string
  kind: string
  payload: unknown
}

const STATE_PREFIX = 'state.'

export function translate(prev: Record<string, unknown> | null, message: unknown): Change[] {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return []
  const kind = (message as { kind?: unknown }).kind
  if (typeof kind !== 'string') return []
  if (kind === 'ping') return []
  if (kind === 'snapshot') {
    const state = (message as { state?: unknown }).state
    if (typeof state !== 'object' || state === null || Array.isArray(state)) return []
    return diffState(prev ?? {}, state as Record<string, unknown>)
  }
  return [{ topic: `live.${kind}`, kind: 'message', payload: message }]
}

function diffState(prev: Record<string, unknown>, next: Record<string, unknown>): Change[] {
  const changes: Change[] = []
  for (const [key, value] of Object.entries(next)) {
    if (!(key in prev) || JSON.stringify(prev[key]) !== JSON.stringify(value)) {
      changes.push({ topic: STATE_PREFIX + key, kind: 'set', payload: value })
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) changes.push({ topic: STATE_PREFIX + key, kind: 'unset', payload: null })
  }
  return changes
}

/** 把一条事件应用回镜像。终端重建状态用的就是这一个函数的逻辑(快照 + 续流)。 */
export function applyEvent(state: Record<string, unknown>, event: Change): Record<string, unknown> {
  if (!event.topic.startsWith(STATE_PREFIX)) return state
  const key = event.topic.slice(STATE_PREFIX.length)
  if (event.kind === 'set') return { ...state, [key]: event.payload }
  if (event.kind === 'unset') {
    const { [key]: _gone, ...rest } = state
    return rest
  }
  return state
}
