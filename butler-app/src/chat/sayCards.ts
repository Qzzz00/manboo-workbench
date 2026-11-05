import type { WorkbenchState } from '../api/protocol';

/** /butler/say 卡片的客户端投影；决策内容只照服务端结果呈现。 */
export interface SayChoiceOption { id: string; label: string }
export interface SayCardPayload {
  say_id?: string;
  say?: { screen?: unknown; spoken?: unknown };
  items?: { kind?: string; title?: string; status?: string; card_id?: string; who?: string }[];
  asks?: { ask_id: string; question: string }[];
  decided?: { decided_id?: string; item_index: number; field: string; chosen: string; why: string; alternatives: SayChoiceOption[] }[];
  suggest?: { suggest_id: string; line: string; default_action: string; options: SayChoiceOption[] };
  ask?: { ask_id: string; question: string };
  hold?: { hold_id: string; reason: string; question: string };
}

export interface SayChoiceRequest {
  text: string;
  ctx: { confirmed: { ask_id: string; choice: string }; last_say_id?: string };
}

export interface SayDecidedRequest {
  text: string;
  ctx: { decided: { decided_id: string; choice: string }; last_say_id?: string };
}

export interface SaySuggestRequest {
  text: string;
  ctx: { suggest: { suggest_id: string; choice: string }; last_say_id?: string };
}

export function sayScreen(payload: SayCardPayload): string | undefined {
  return typeof payload.say?.screen === 'string' && payload.say.screen.length > 0 ? payload.say.screen : undefined;
}

export function sayChoiceRequest(payload: SayCardPayload, choice: string, selectedAskId?: string): SayChoiceRequest | undefined {
  const knownIds = [...(payload.asks ?? []).map(one => one.ask_id), ...(payload.ask === undefined ? [] : [payload.ask.ask_id]), ...(payload.hold === undefined ? [] : [payload.hold.hold_id])];
  if (selectedAskId !== undefined && !knownIds.includes(selectedAskId)) return undefined;
  const askId = selectedAskId ?? payload.ask?.ask_id ?? payload.hold?.hold_id;
  if (typeof askId !== 'string' || askId.trim() === '' || choice.trim() === '') return undefined;
  return { text: choice === 'yes' ? '确认' : choice === 'no' ? '否定' : choice, ctx: { confirmed: { ask_id: askId, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

/** 名片来自实时状态；只用原件 ID 定位负责人，不按家名猜是哪一张。 */
export function sayDecidedChoices(payload: SayCardPayload, decision: NonNullable<SayCardPayload['decided']>[number], state?: Pick<WorkbenchState, 'tasks'>): { id: string; label: string }[] {
  const originalId = payload.items?.[decision.item_index]?.card_id;
  const original = state?.tasks?.tasks.find(task => task.id === originalId);
  // 手机的公共状态类型较窄；对服务端已有字段做运行时校验，不在这里复制名片协议。
  const raw: unknown = state?.tasks;
  const registered: unknown[] = raw !== null && typeof raw === 'object' && 'agent_cards' in raw && Array.isArray(raw.agent_cards) ? raw.agent_cards : [];
  const cards: SayChoiceOption[] = decision.field === 'who' && original !== undefined ? registered.flatMap(card => {
    if (card === null || typeof card !== 'object' || !('id' in card) || !('name' in card) || !('runtime' in card)) return [];
    if (typeof card.id !== 'string' || typeof card.name !== 'string' || card.id === original.assignee) return [];
    const runtime = card.runtime;
    return runtime !== null && typeof runtime === 'object' && 'family' in runtime && typeof runtime.family === 'string' && runtime.family !== '' ? [{ id: card.id, label: card.name }] : [];
  }) : [];
  return [...new Map([...decision.alternatives, ...cards].filter(option => option.id !== original?.assignee).map(option => [option.id, option])).values()];
}

export function sayDecidedRequest(payload: SayCardPayload, decidedId: string | undefined, choice: string, state?: Pick<WorkbenchState, 'tasks'>): SayDecidedRequest | undefined {
  const decision = payload.decided?.find(one => one.decided_id === decidedId && one.field === 'who');
  if (decision === undefined || decidedId === undefined || choice.trim() === '') return undefined;
  const option = sayDecidedChoices(payload, decision, state).find(one => one.id === choice);
  if (option === undefined) return undefined;
  return { text: `改为 ${option.label}`, ctx: { decided: { decided_id: decidedId, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

export function saySuggestRequest(payload: SayCardPayload, choice: string): SaySuggestRequest | undefined {
  const suggest = payload.suggest;
  if (suggest === undefined || suggest.suggest_id.trim() === '' || choice.trim() === '') return undefined;
  if (choice === 'keep') {
    if (suggest.default_action !== 'keep') return undefined;
    return { text: '先放着', ctx: { suggest: { suggest_id: suggest.suggest_id, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
  }
  const option = suggest.options.find(one => one.id === choice);
  if (option === undefined) return undefined;
  return { text: `派给 ${option.label}`, ctx: { suggest: { suggest_id: suggest.suggest_id, choice }, ...(payload.say_id === undefined ? {} : { last_say_id: payload.say_id }) } };
}

export function sayReceipt(payload: SayCardPayload): string {
  return sayScreen(payload) ?? '事务官返回了无法识别的回执；原话已保留，未判断为成功。';
}
