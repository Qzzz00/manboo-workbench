/** 房间 say_decision 事件的手机消费投影；源字段由 1b room-seam-contract 定义。 */
export interface SayDecisionRoomEvent {
  type: 'say_decision';
  event_id: string;
  call_id?: string;
  say_id: string;
  kind: 'decided' | 'suggest' | 'ask' | 'hold';
  decision: Record<string, unknown>;
  /** 1b may attach the same response screen and decided source item. */
  say?: { screen?: string };
  item?: { title?: string; status?: string; card_id?: string; who?: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function parseSayDecisionRoomEvent(text: string): SayDecisionRoomEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isRecord(raw) || raw.type !== 'say_decision' || !nonEmpty(raw.event_id) || !nonEmpty(raw.say_id) || !isRecord(raw.decision)) return null;
  if (raw.kind !== 'decided' && raw.kind !== 'suggest' && raw.kind !== 'ask' && raw.kind !== 'hold') return null;
  const say = isRecord(raw.say) && typeof raw.say.screen === 'string' ? { screen: raw.say.screen } : undefined;
  const sourceItem = isRecord(raw.item) ? raw.item : undefined;
  const item = raw.kind === 'decided' && sourceItem !== undefined
    ? Object.fromEntries(['title', 'status', 'card_id', 'who'].flatMap(key => typeof sourceItem[key] === 'string' ? [[key, sourceItem[key]]] : [])) as SayDecisionRoomEvent['item']
    : undefined;
  return {
    type: 'say_decision',
    event_id: raw.event_id,
    say_id: raw.say_id,
    kind: raw.kind,
    decision: raw.decision,
    ...(nonEmpty(raw.call_id) ? { call_id: raw.call_id } : {}),
    ...(say === undefined ? {} : { say }),
    ...(item === undefined ? {} : { item }),
  };
}

/** 即时广播没有重放；同一通中重复 event_id 只消费一次。 */
export function createSayDecisionEventDeduper(): (event: SayDecisionRoomEvent) => boolean {
  const seen = new Set<string>();
  return (event) => {
    if (seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  };
}

export function mergeSayDecisionEvent<T extends { say_id?: string; say?: { screen?: unknown }; items?: { title?: string; status?: string; card_id?: string; who?: string }[]; decided?: unknown[]; asks?: unknown[]; suggest?: unknown; ask?: unknown; hold?: unknown }>(current: readonly T[], event: SayDecisionRoomEvent): T[] {
  const index = current.findIndex(one => one.say_id === event.say_id);
  const previous = index < 0 ? { say_id: event.say_id } as T : current[index]!;
  const next = { ...previous } as T & Record<string, unknown>;
  if (event.kind === 'decided') next.decided = [...(previous.decided ?? []), event.decision];
  else if (event.kind === 'ask') {
    const asks = [...(previous.asks ?? [])];
    const askId = event.decision.ask_id;
    if (!asks.some(one => typeof one === 'object' && one !== null && (one as Record<string, unknown>).ask_id === askId)) asks.push(event.decision);
    next.asks = asks;
  } else next[event.kind] = event.decision;
  if (event.say !== undefined) next.say = { ...previous.say, ...event.say };
  if (event.kind === 'decided' && event.item !== undefined && Number.isInteger(event.decision.item_index) && (event.decision.item_index as number) >= 0) {
    const items = [...(previous.items ?? [])];
    items[event.decision.item_index as number] = event.item;
    next.items = items;
  }
  if (index < 0) return [...current, next];
  return current.map((one, i) => i === index ? next : one);
}
