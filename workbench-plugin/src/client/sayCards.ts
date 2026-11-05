import type { WorkbenchState } from '../protocol.ts';

export interface SayCardPayload {
  say_id?: string;
  say?: { screen?: unknown };
  decided?: { decided_id?: string; item_index: number; field: string; chosen: string; why: string; alternatives: { id: string; label: string }[] }[];
  suggest?: { suggest_id: string; line: string; default_action: string; options: { id: string; label: string }[] };
  ask?: { ask_id: string; question: string };
  hold?: { hold_id: string; reason: string; question: string };
  items?: { kind?: string; title?: string; status?: string; card_id?: string; who?: string }[];
  asks?: { ask_id: string; question: string }[];
}

export function sayScreen(payload: SayCardPayload): string | undefined {
  return typeof payload.say?.screen === 'string' && payload.say.screen.length > 0 ? payload.say.screen : undefined;
}

export function sayConfirmBody(payload: SayCardPayload, choice: string, selectedAskId?: string): Record<string, unknown> | undefined {
  const knownIds = [...(payload.asks ?? []).map(one => one.ask_id), ...(payload.ask === undefined ? [] : [payload.ask.ask_id]), ...(payload.hold === undefined ? [] : [payload.hold.hold_id])];
  if (selectedAskId !== undefined && !knownIds.includes(selectedAskId)) return undefined;
  const ask_id = selectedAskId ?? payload.ask?.ask_id ?? payload.hold?.hold_id;
  if (typeof ask_id !== 'string' || ask_id.trim() === '' || choice.trim() === '') return undefined;
  return { text: choice === 'yes' ? '确认' : choice === 'no' ? '否定' : choice, entrance: 'desktop', ctx: { confirmed: { ask_id, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

/** 名片来自实时状态；只用原件 ID 定位负责人，不按家名猜是哪一张。 */
export function sayDecidedChoices(payload: SayCardPayload, decision: NonNullable<SayCardPayload['decided']>[number], state?: Pick<WorkbenchState, 'tasks'>): { id: string; label: string }[] {
  const originalId = payload.items?.[decision.item_index]?.card_id;
  const original = state?.tasks?.tasks.find(task => task.id === originalId);
  const cards = decision.field === 'who' && original !== undefined
    ? (state?.tasks?.agent_cards ?? []).filter(card => card.id !== original.assignee && card.runtime?.family !== undefined).map(card => ({ id: card.id, label: card.name }))
    : [];
  return [...new Map([...decision.alternatives, ...cards].filter(option => option.id !== original?.assignee).map(option => [option.id, option])).values()];
}

export function sayDecidedBody(payload: SayCardPayload, decidedId: string | undefined, choice: string, state?: Pick<WorkbenchState, 'tasks'>): Record<string, unknown> | undefined {
  const decision = payload.decided?.find(one => one.decided_id === decidedId && one.field === 'who');
  if (decision === undefined || decidedId === undefined || choice.trim() === '') return undefined;
  const option = sayDecidedChoices(payload, decision, state).find(one => one.id === choice);
  if (option === undefined) return undefined;
  return { text: `改为 ${option.label}`, entrance: 'desktop', ctx: { decided: { decided_id: decidedId, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

export function saySuggestBody(payload: SayCardPayload, choice: string): Record<string, unknown> | undefined {
  const suggest = payload.suggest;
  if (suggest === undefined || suggest.suggest_id.trim() === '' || choice.trim() === '') return undefined;
  if (choice === 'keep') {
    if (suggest.default_action !== 'keep') return undefined;
    return { text: '先放着', entrance: 'desktop', ctx: { suggest: { suggest_id: suggest.suggest_id, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
  }
  const option = suggest.options.find(one => one.id === choice);
  if (option === undefined) return undefined;
  return { text: `派给 ${option.label}`, entrance: 'desktop', ctx: { suggest: { suggest_id: suggest.suggest_id, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

/**
 * 还要她点的:确认 / 改选 / 建议。只报处理结果的那种不算 —— 那种收成「最近结果」那一行,不在输入框上方占一块
 * (2026-10-27,浮窗 680 高时这一块挤掉唯一的滚动区、又没有收起)。
 */
export function sayNeedsAction(payload: SayCardPayload): boolean {
  return (payload.asks?.length ?? 0) > 0 || payload.ask !== undefined || payload.hold !== undefined
    || payload.suggest !== undefined || (payload.decided?.length ?? 0) > 0
}

/** 处理完那一行:服务端那一句原样,件数与失败数按每件状态数,不编。 */
export function sayResultLine(payload: SayCardPayload): { screen?: string, count?: string } {
  const screen = sayScreen(payload)
  const items = payload.items ?? []
  const failed = items.filter(one => one.status === 'failed').length
  const count = items.length === 0 ? undefined : `刚处理 ${items.length} 件${failed > 0 ? ` · ${failed} 件失败` : ''}`
  return { ...(screen === undefined ? {} : { screen }), ...(count === undefined ? {} : { count }) }
}
