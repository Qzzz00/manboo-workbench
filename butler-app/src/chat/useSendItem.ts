/**
 * 「发一句 = 建一条事项」:POST /butler/item { text } → 回执带事项 id(与 conversation 或「会话未开」)。
 * 发出去之前先摆一条 pending 在对话末尾;/state 一带回那条事项,pending 自动退场(mergePending)。
 * 2026-10-12 起经待发箱(outbox/sendOutbox.ts)发:先落盘带请求号,没送到留着自动补发,回执三档见 chatModel.ts。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyValueStore } from '../api/tokenStore';
import { createSendOutbox, registerOutboxClassifier, type OutboxEntry, type SendOutcome } from '../outbox/sendOutbox';
import type { ApiResult } from '../api/client';
import type { Session } from '../session';
import type { PendingMessage } from './chatModel';
import { parseFileAsk, type FileAsk } from '../files/fileFetch';
import type { SayCardPayload } from './sayCards';
import { sayReceipt, sayScreen } from './sayCards';
import { sayChoiceRequest, sayDecidedRequest, saySuggestRequest } from './sayCards';

/** 登记了一场会之后,接在那一句后面:缺的几问在哪答。 */
export const MEETING_PLAN_WHERE = '(会前的几问与预案卡在「会议」里,首页右边那排的耳机。)';

/** 交代一句走的那条路。 */
const ITEM_PATH = '/butler/item';
const SAY_PATH = '/butler/say';

/** 测试与老的假 Session 没有待发箱:就地起一个只在内存里的(行为一样,只是 App 重开就忘)。 */
function memoryKv(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
  };
}

/** 待发箱里那一条摆成什么气泡:在发 / 没送到(可重发)/ 电脑答了不行。 */
function pendingOfEntry(entry: OutboxEntry): PendingMessage {
  const base = { localId: entry.key, text: entry.text, at: entry.at };
  if (entry.state === 'unsent') return { ...base, unsent: true, error: entry.error ?? '连不上电脑' };
  if (entry.state === 'rejected') return { ...base, error: entry.error ?? '电脑那边没收下这一句' };
  return base;
}

/**
 * 送到了之后这条气泡变成什么(回包是哪一种)。`fileAsk` 交给调用方摆卡;别的落成一条「送到了」的气泡。
 * 送到那一下可能是她当场发的,也可能是待发箱后来补发的(App 重开、网络回来了)—— 两处走同一个判断。
 */
function deliveredOf(entry: Pick<OutboxEntry, 'key' | 'text' | 'at'>, raw: unknown, path: string): { pending?: PendingMessage; fileAsk?: FileAsk; refresh?: true } {
  const base = { localId: entry.key, text: entry.text, at: entry.at };
  if (path === SAY_PATH && (typeof (raw as SayCardPayload | undefined)?.say?.screen !== 'string' || (raw as SayCardPayload).say?.screen === '')) {
    return { pending: { ...base, error: '服务端 say 回包缺少 say.screen；没有按事项 ID 推断成功。' } };
  }
  const fileAsk = parseFileAsk((raw as { file_ask?: unknown } | undefined)?.file_ask);
  if (fileAsk !== null) {
    const screen = (raw as SayCardPayload).say?.screen;
    return { fileAsk: { ...fileAsk, ...(typeof screen === 'string' && screen !== '' ? { screen } : {}) } };
  }
  /**
   * 「接着刚才那件说了」(2026-09-25,卡 Y):电脑那头把这句话说进了上一件那条会话里,**没建新卡**。
   * 所以这条气泡**不挂那张卡的 id** —— 挂了会被 mergePending 当成"那张卡已经在对话里了"收掉,
   * 他刚说的那句话就从屏上消失了。原话在那件事的对话里(事项页点开看得到)。
   */
  /**
   * 本体的毛病(2026-09-28,卡 FB):这句话说的是工作台自己哪儿不对 —— 电脑那头**没建卡**、
   * 一家都没派,回的是那条反馈 + 事务官那一句(「我已经反馈给开发者了」/「我记下了,还没发出去:…」)。
   * 所以这条气泡**不挂卡 id**(挂了 mergePending 会去等一张永远不会来的卡),把那一句摆上去就是答案。
   */
  const data = (raw ?? {}) as { id?: unknown; carried_on?: boolean; feedback?: unknown; note?: unknown; meeting_plan?: unknown; publish_plan?: unknown; today_view?: unknown };
  /**
   * ★ **换了「今天的待办」那一版**(2026-10-13,卡「三个入口一套管线」):电脑那头**当场换完了**,
   * 没建卡、没人在办 —— 这条气泡摆电脑那一句、回执直接「办完了」,**不挂卡 id**
   * (同登记一场会、排发布计划那两档的理由)。
   *
   * 为什么手机也要认这一格:那张卡的要紧处是「adb 往手机打字测的效果和通话告知的效果应该是一致的」
   * (维护者原话)—— 电话里听到的是「好,改成按日期汇总了。」,交代框里也得是同一句。
   */
  if (data.today_view !== undefined) {
    const line = typeof data.note === 'string' && data.note !== '' ? data.note : '换好了。';
    return { pending: { ...base, note: line, settled: true }, refresh: true };
  }
  /**
   * 登记了一场会(2026-10-10,卡「会前画像与预案」):电脑那头**没建事项**,落成一场待开的会。
   * 这条气泡不挂卡 id(没有卡会来接它),摆上「记下了 + 还差哪一问」;缺的那几问在会议页里答。
   */
  if (data.meeting_plan !== undefined) {
    const line = typeof data.note === 'string' && data.note !== '' ? data.note : '记下了这场会。';
    return { pending: { ...base, note: `${line}${MEETING_PLAN_WHERE}`, settled: true }, refresh: true };
  }
  /**
   * 排进发布计划(2026-10-13,卡「座机一句话记发布计划」):电脑那头**已经记上了**(日历那一格里的一条),
   * 没有人在办、也没派给谁 —— 所以这条气泡摆电脑那一句、回执直接「办完了」,**不挂那张卡的 id**:
   * 挂了底下会写「已交给事务官」,而这件事没有谁在办(同登记一场会那一档的理由)。
   */
  if (data.publish_plan !== undefined) {
    const line = typeof data.note === 'string' && data.note !== '' ? data.note : '记进发布计划了。';
    return { pending: { ...base, note: line, settled: true }, refresh: true };
  }
  if (data.feedback !== undefined) {
    const line = typeof data.note === 'string' && data.note !== '' ? data.note : '这是工作台本身的问题,我反馈给开发者了。';
    return { pending: { ...base, note: line, settled: true } };
  }
  if (data.carried_on === true) return { pending: { ...base, note: '接着刚才那件说了' }, refresh: true };
  /**
   * 「落地」口(2026-10-24,卡 1a):回包里带事务官那一句(`say.screen`)就摆它 —— 卡回来之后
   * chatModel 还会按卡上的 say_note 显示同一句(两处同一来源,不各拼一套)。
   */
  const sayScreen = (raw as { say?: { screen?: unknown } | undefined } | undefined)?.say?.screen;
  if (typeof sayScreen === 'string' && sayScreen !== '') {
    const returnedItems = (raw as SayCardPayload).items ?? [];
    const ids = returnedItems.flatMap(item => typeof item.card_id === 'string' ? [item.card_id] : []);
    const allItemsHaveCards = returnedItems.length > 0 && returnedItems.every(item => item.status === 'done' && typeof item.card_id === 'string');
    return { pending: { ...base, ...(!allItemsHaveCards ? {} : { taskIds: ids }), note: sayScreen, sayCards: raw as SayCardPayload }, refresh: true };
  }
  if (typeof data.id === 'string' && data.id !== '') return { pending: { ...base, taskId: data.id }, refresh: true };
  return { pending: { ...base, note: '送到了' }, refresh: true };
}

/** `/say` 的结构不完整时保留为 rejected，避免待发箱把卡 ID 当作成功回执。 */
function classifySayResult(result: ApiResult<unknown>): SendOutcome {
  if (result.ok && (typeof (result.data as SayCardPayload | undefined)?.say?.screen !== 'string' || (result.data as SayCardPayload).say?.screen === '')) {
    return { kind: 'rejected', error: '服务端 say 回包缺少 say.screen；请先核对服务端结果，不要直接重复发送。' };
  }
  if (result.ok) return { kind: 'delivered', data: result.data };
  if (result.kind === 'network' || result.kind === 'unauthorized' || result.status >= 500) return { kind: 'unsent', error: result.error };
  return { kind: 'rejected', error: result.error };
}

// 注册在模块层，确保所有待发箱实例在首个请求前使用同一 `/say` 回执校验。
registerOutboxClassifier(SAY_PATH, classifySayResult);

export function useSendItem(session: Session) {
  /**
   * 待发箱(2026-10-12,卡「手机交代只执行一次」):先落盘再发,没送到的留在手机上、连上了自动补发,
   * 补发带同一个请求号(电脑不办第二次)。挂在会话上(session.ts),App 重开接着补;这里只是它的一张脸。
   */
  const outbox = useMemo(() => session.outbox ?? createSendOutbox({ kv: memoryKv(), client: session.client }), [session]);
  /** 送到了的那几条(等 /state 带回卡来接它们)。按 localId(= 请求号)存,同一条送到两次只算一条。 */
  const [delivered, setDelivered] = useState<PendingMessage[]>([]);
  const lastSayId = useRef<string | undefined>(undefined);
  const choosingRef = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [, setVersion] = useState(0);

  const settle = useCallback((entry: Pick<OutboxEntry, 'key' | 'text' | 'at'>, raw: unknown, path: string): FileAsk | undefined => {
    const returnedSayId = (raw as { say_id?: unknown } | undefined)?.say_id;
    if (typeof returnedSayId === 'string' && returnedSayId !== '') lastSayId.current = returnedSayId;
    const got = deliveredOf(entry, raw, path);
    setDelivered((list) => [...list.filter((p) => p.localId !== entry.key), ...(got.pending === undefined ? [] : [got.pending])]);
    if (got.refresh === true) void session.feed.refresh();
    return got.fileAsk;
  }, [session]);

  useEffect(() => outbox.subscribe((event) => {
    if (event?.delivered !== undefined && (event.delivered.path === ITEM_PATH || event.delivered.path === SAY_PATH)) settle(event.delivered, event.data, event.delivered.path);
    setVersion((n) => n + 1);
  }), [outbox, settle]);
  // 账上原来就有的(App 重开前没送到的)读进来后画出来。
  useEffect(() => { void outbox.ready().then(() => setVersion((n) => n + 1)); }, [outbox]);

  /**
   * `extra`(2026-09-24 统一输入框):谁来办、附件、引用。只有附件没有字时服务端会写「附件:<名字>」当标题。
   */
  /**
   * 回执里带 `file_ask`(2026-09-25,卡 J):他打的是「把 X 发我」,电脑**没建事项**,
   * 回的是一张「找到了什么」的卡 —— 这时对话末尾那条 pending 收掉(不会有事项来接它),卡交给调用方摆。
   */
  const send = useCallback(async (text: string, extra?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; fileAsk?: FileAsk }> => {
    const trimmed = text.trim();
    const hasAttachments = Array.isArray(extra?.attachments) && extra.attachments.length > 0;
    if (trimmed === '' && !hasAttachments) return { ok: false, error: '内容不能为空' };
    /**
     * 这条气泡上那个时刻用**电脑的钟**(2026-10-02,卡 claude/phone-clock):气泡画出来时
     * `formatClock` 判「是不是今天」看的是 `/state.now`,这里要是按手机自己的墙钟盖戳,
     * 手机钟歪了他刚说的那句话就会写成「12-25 10:00」—— 同一条对话里两个钟。
     * 还没连上(`now` 是空串)才退回手机的钟:那时 `formatClock` 也退回它,两头仍是同一个钟。
     */
    const now = session.feed.get().state.now;
    const at = now === '' ? new Date().toISOString() : now;
    // `can_file_ask`(2026-09-25,卡 J):这个包认得「取文件」那张卡 —— 8791 只对带它的手机岔出去,老包照旧建事项。
    // `can_meeting_plan`(2026-10-10):这个包认得「登记了一场会」那条回执 —— 「下午三点跟 B 客户谈…」落成待开的会,不建事项。
    const useSay = !hasAttachments && Object.keys(extra ?? {}).every(key => key === 'entrance');
    const path = useSay ? SAY_PATH : ITEM_PATH;
    const { key, outcome } = await outbox.send(path, useSay
      // 手机文字进理解中枢(A2,2026-10-28):8791 按 entrance:'phone' 认;老 8791 不认时照旧走旧路。
      ? { ...(extra ?? {}), text: trimmed, entrance: 'phone', ...(lastSayId.current === undefined ? {} : { ctx: { last_say_id: lastSayId.current } }) }
      : { ...(extra ?? {}), text: trimmed, can_file_ask: true, can_meeting_plan: true }, { text: trimmed, at });
    if (outcome.kind !== 'delivered') return { ok: false, error: outcome.error };
    const fileAsk = settle({ key, text: trimmed, at }, outcome.data, path);
    return fileAsk === undefined ? { ok: true } : { ok: true, fileAsk };
  }, [session, outbox, settle]);

  /** 「重发」:带原来那个请求号再发一次(电脑办过的不办第二次)。 */
  const resend = useCallback(async (localId: string): Promise<{ ok: boolean; error?: string }> => {
    const outcome = await outbox.resend(localId);
    return outcome.kind === 'delivered' ? { ok: true } : { ok: false, error: outcome.error };
  }, [outbox]);

  const dismiss = useCallback((localId: string) => {
    outbox.discard(localId);
    setDelivered((list) => list.filter((p) => p.localId !== localId));
  }, [outbox]);

  const choose = useCallback(async (localId: string, choice: string, askId?: string, suggestId?: string, decidedId?: string): Promise<{ ok: boolean; error?: string }> => {
    if (choosingRef.current) return { ok: false, error: '正在提交上一项选择。' };
    const current = delivered.find(one => one.localId === localId);
    if (current?.sayCards === undefined) return { ok: false, error: '这张卡没有可提交的服务端决策编号。' };
    const body = decidedId !== undefined ? sayDecidedRequest(current.sayCards, decidedId, choice, session.feed.get().state)
      : suggestId !== undefined ? saySuggestRequest(current.sayCards, choice) : sayChoiceRequest(current.sayCards, choice, askId);
    if (suggestId !== undefined && current.sayCards.suggest?.suggest_id !== suggestId) return { ok: false, error: '这条建议已更新，请按最新回话重新选择。' };
    if (body === undefined) return { ok: false, error: '服务端没有提供可用的确认编号。' };
    choosingRef.current = true;
    setChoosing(true);
    try {
      const result = await session.client.json<SayCardPayload & { error?: string }>(SAY_PATH, { method: 'POST', body: { entrance: 'phone', ...body } });
      if (!result.ok || sayScreen(result.data) === undefined) return { ok: false, error: result.ok ? '服务端没有返回有效回话。' : result.error };
      const responseItems = result.data.items ?? [];
      const taskIds = responseItems.flatMap(item => typeof item.card_id === 'string' ? [item.card_id] : []);
      const allItemsHaveCards = responseItems.length > 0 && responseItems.every(item => item.status === 'done' && typeof item.card_id === 'string');
      setDelivered(list => list.map(one => one.localId === localId ? { ...one, ...(!allItemsHaveCards ? {} : { taskIds }), note: sayReceipt(result.data), sayCards: result.data } : one));
      if (typeof result.data.say_id === 'string') lastSayId.current = result.data.say_id;
      void session.feed.refresh();
      return { ok: true };
    } catch {
      return { ok: false, error: '工作台没有确认这次选择。' };
    } finally {
      choosingRef.current = false;
      setChoosing(false);
    }
  }, [delivered, session]);

  const queued = outbox.list().filter((entry) => entry.path === ITEM_PATH || entry.path === SAY_PATH).map(pendingOfEntry);
  const pending = [...queued, ...delivered.filter((p) => !queued.some((q) => q.localId === p.localId))]
    .sort((a, b) => a.at.localeCompare(b.at));

  return { pending, send, resend, dismiss, choose, choosing };
}
