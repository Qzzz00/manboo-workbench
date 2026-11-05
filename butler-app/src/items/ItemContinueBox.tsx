/**
 * 事项详情里「继续这件事」那一格(2026-10-23,卡 A「同事项接续与动作契约」;10-23 复审一轮补齐)。
 *
 * 与桌面上同一个口:先 `GET /butler/item/:id/continue` 拿这件事的来源清单
 * (它自己的事务官会话 + links 里的外部会话,各能不能这会儿接着发话),再
 * `POST /butler/item/continue` 把一句话发到明确的那一条来源。
 *
 * 口径(与 SessionSayBox 同组件同回执纪律,复审补齐的三条):
 *   ① **歧义不代选**:能续的多条时,不替她选第一条 —— 她选定哪条才发哪条;
 *      没选就按发送,那一句不外发,屏上说「选一条再发」。
 *   ② **走既有待发箱**(session.outbox):发之前先落盘带请求号,App 被杀 / 断网,
 *      重开自动补发同一句同号(电脑按号只办一次);**HTTP 200 但回包说没办成**
 *      (pick/unsupported/failed)是业务拒绝 —— 不补发、不当已投递(outbox 那条
 *      标 rejected,人话原样摆)。草稿按事项存 localStorage,关页 / 重开都不丢,换事项不串稿。
 *   ③ **请求号绑整个动作包**(同事项 + 目标/record 档 + 原话 + 意图):同一包重试复用账上
 *      那一条(同一号);换了目标 / 换了 record 档 / 换了字 / 换了意图 = 另一个动作,新号新账。
 *      「只留记录」有在途锁,连点不会落多条;送成了把打字框清空。
 *   ④ 四意图(2026-10-26,卡「事务官机制A」):补充(缺省,不带 intent 字段)/
 *      改方向 / 催一下(打断在跑的轮次)/ 撤回(停住在跑的那一轮,允许不带字)。
 *      撤回走 composer 旁边那颗单独的键;意图与草稿同存,关页重开不丢。
 *   回执照服务端那句原样摆,不替它编 —— 「送到了 / 留着等它醒 / 这条这会儿走不通 / 要先选来源」。
 *
 * 与 SessionSayBox 的分工:那条是「往**这一条会话**里捎话」(只认一家);
 * 这条是「接着**这件事**做」—— 发给哪条来源由服务端认,人只从能续的几条里选。
 * 老的假 Session 没有 outbox(用例):退回直连那一档,动作包换号逻辑同一套。
 */
import { useEffect, useRef, useState } from 'react';
import { newClientKey } from '../channel/clientKey';
import { useSession } from '../session';
import { PhoneComposer } from '../composer/PhoneComposer';
import { FIELD_PLACEHOLDER } from '../stage/StageComposer';
import { registerOutboxClassifier, type SendOutcome } from '../outbox/sendOutbox';
import type { ApiResult } from '../api/client';
import type { ItemContinueResult, ItemContinueSource, ItemContinueView, ItemSayIntent } from '../api/protocol';

/** 输入框的标签(读屏念的就是这一句)。 */
export const CONTINUE_LABEL = '接着说';
/** 「只留记录」那颗次级键:这句话只落在卡上,不发给任何会话。 */
export const CONTINUE_RECORD = '只留记录';
/** 意图选择器的读屏标签(2026-10-26,卡「事务官机制A」)。 */
export const CONTINUE_INTENT_LABEL = '这句怎么递';
/** 「撤回」那颗键:把在跑的那一轮停住,这件先撤下,可以不填字。 */
export const CONTINUE_RECALL = '撤回';
/** 没送到(2026-10-12):再按发送,补发的是同一句,不会送两遍。 */
export const CONTINUE_UNSENT = '没送到 · 再按发送会补发这一句,不会送两遍';
/** 多条能续、她还没选就按了发送。 */
export const CONTINUE_NEED_PICK = '连着好几条能续的会话 —— 先选一条再发,不替你猜。';
/** 这条路的请求号由待发箱管;登记业务分类器:HTTP 200 但 ok:false = 业务拒绝(人话带回去)。 */
export const CONTINUE_PATH = '/butler/item/continue';
registerOutboxClassifier(CONTINUE_PATH, (result: ApiResult<unknown>): SendOutcome => {
  if (!result.ok) {
    if (result.kind === 'network' || result.kind === 'unauthorized' || result.status >= 500) {
      return { kind: 'unsent', error: result.error };
    }
    return { kind: 'rejected', error: result.error };
  }
  const data = result.data as { ok?: boolean, note?: string } | undefined;
  if (data?.ok === true) return { kind: 'delivered', data: result.data };
  return { kind: 'rejected', error: data?.note ?? '没办成' };
});

/** 草稿按事项存哪一格。一格一事,关页 / 重开不丢。 */
const draftKeyOf = (taskId: string): string => `wb.continue.draft.${taskId}`;

interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ReadbackTurn { k: 'ask' | 'reply'; text: string; at?: string }
interface ReadbackState { source: ItemContinueSource; loading: boolean; turns?: ReadbackTurn[]; error?: string }

/** 拿不到 localStorage 时(用例、隐私模式、站点数据被关)退内存:这一进程内照样不丢,行为不变。 */
const memoryDraftStore = ((): DraftStore => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
})();

/** 草稿存哪:真 WebView 用 localStorage(探一针,一写就抛的环境退内存,同 agentIcons 那个口径)。 */
function draftStore(): DraftStore {
  try {
    if (typeof localStorage === 'undefined') return memoryDraftStore;
    const probe = 'wb.continue.draft.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryDraftStore;
  }
}

/** 动作包:同事项 + 发给谁(或 record 档)+ 原话 + 意图。包没变 = 同一次的重试。 */
const packageOf = (taskId: string, aim: string, text: string, intent: ItemSayIntent): string =>
  JSON.stringify({ id: taskId, aim, text, intent });

export function ItemContinueBox({ taskId }: { taskId: string }) {
  const session = useSession();
  const [view, setView] = useState<ItemContinueView | undefined>(undefined);
  const [target, setTarget] = useState<string | undefined>(undefined);
  /** 这句怎么递(2026-10-26,卡「事务官机制A」):补充 / 改方向 / 催一下;撤回走那颗单独的键。 */
  const [intent, setIntent] = useState<ItemSayIntent>('supplement');
  /** 「只留记录」要拿当前草稿:从 composer 镜像一份(唯一的真值还是 composer 里那一份)。 */
  const [draft, setDraft] = useState('');
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [readback, setReadback] = useState<ReadbackState | undefined>(undefined);
  /** 上一个动作包 + 它的请求号/账键:同一包重试复用,换包换新。 */
  const [lastAttempt, setLastAttempt] = useState<{ pkg: string; key: string } | undefined>(undefined);
  /** 发送在途锁(记录键绕过 composer 的 sending,自己的这一把)。 */
  const sendingRef = useRef(false);
  const [recordBusy, setRecordBusy] = useState(false);
  /** composer 重挂载把手:送成了 bump 一下,打字框清空。 */
  const [composerNonce, setComposerNonce] = useState(0);
  /** 草稿恢复完成才挂 composer(它的初始文字只在挂载那一刻读一次)。 */
  const [restored, setRestored] = useState(false);
  /** 人动过这一格才许写/清存档 —— 挂载那一拍不能拿空框把存的草稿清掉(读取是异步的)。 */
  const dirtyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void session.client
      .json<ItemContinueView>(`/butler/item/${encodeURIComponent(taskId)}/continue`, { method: 'GET' })
      .then((got) => {
        // 旧工作台没有这条路(或回了个认不出的形状):这一格不摆,别的照常。
        if (!alive || !got.ok || !Array.isArray(got.data?.sources)) return;
        const data = got.data as ItemContinueView;
        setView(data);
        const sendable = data.sources.filter(one => one.action.kind !== 'none');
        // ★ 歧义不代选:只有一条能续 = 没有歧义;多条 = 空着等她选。草稿里选过的恢复回来。
        setTarget(sendable.length === 1 ? sendable[0]?.key : undefined);
        setRestored(true);
        try {
          const raw = draftStore().getItem(draftKeyOf(taskId));
          if (raw === null) return;
          const saved = JSON.parse(raw) as { text?: unknown; target?: unknown; intent?: unknown };
          if (typeof saved.text === 'string' && saved.text !== '') setDraft(saved.text);
          if (typeof saved.target === 'string' && sendable.some(one => one.key === saved.target)) {
            setTarget(saved.target);
          }
          if (saved.intent === 'redirect' || saved.intent === 'hurry') setIntent(saved.intent);
        } catch { /* 草稿读不懂就当没有 */ }
      });
    return () => { alive = false; };
  }, [session.client, taskId]);

  /** 草稿按事项落盘(人动过才写;写不进不挡发送)。意图也存 —— 关页重开不悄悄变回补充。 */
  useEffect(() => {
    if (!dirtyRef.current) return;
    try {
      const store = draftStore();
      const has = draft.trim() !== '' || target !== undefined;
      if (!has) {
        store.removeItem(draftKeyOf(taskId));
        return;
      }
      store.setItem(draftKeyOf(taskId), JSON.stringify({
        text: draft,
        target: target ?? null,
        ...(intent === 'supplement' ? {} : { intent }),
      }));
    } catch { /* 同上 */ }
  }, [taskId, draft, target, intent]);

  if (view === undefined) return null;
  const currentView = view;
  const sendable = view.sources.filter(one => one.action.kind !== 'none');
  const blocked = view.sources.filter(one => one.action.kind === 'none');

  async function readSource(source: ItemContinueSource): Promise<void> {
    setReadback({ source, loading: true });
    const url = `/sessions/transcript?agent=${encodeURIComponent(source.agent)}&id=${encodeURIComponent(source.session_id)}`;
    try {
      const got = await session.client.json<unknown>(url);
      if (!got.ok || got.data === undefined) { setReadback({ source, loading: false, error: got.ok ? '工作台没有返回这条会话记录。' : got.error }); return; }
      const wire = got.data as { agent?: unknown; session_id?: unknown; turns?: unknown; entries?: unknown };
      if (wire.agent !== source.agent || wire.session_id !== source.session_id) {
        setReadback({ source, loading: false, error: '工作台回的不是这条来源的会话记录。' });
        return;
      }
      const rawTurns = Array.isArray(wire.turns) ? wire.turns : Array.isArray(wire.entries) ? wire.entries : undefined;
      if (rawTurns === undefined) { setReadback({ source, loading: false, error: '工作台回来的会话形状无法识别。' }); return; }
      const turns = rawTurns.flatMap((raw): ReadbackTurn[] => {
        if (raw === null || typeof raw !== 'object') return [];
        const row = raw as { k?: unknown; text?: unknown; at?: unknown };
        if ((row.k !== 'ask' && row.k !== 'reply') || typeof row.text !== 'string') return [];
        return [{ k: row.k, text: row.text, ...(typeof row.at === 'string' ? { at: row.at } : {}) }];
      });
      setReadback({ source, loading: false, turns: turns.slice(-6) });
    } catch (error) {
      setReadback({ source, loading: false, error: error instanceof Error ? error.message : '连不上工作台' });
    }
  }

  const outcomeLine = (outcome: SendOutcome): { ok: boolean; text: string } => {
    if (outcome.kind === 'delivered') {
      const data = outcome.data as { note?: string } | undefined;
      return { ok: true, text: data?.note ?? '送到了。' };
    }
    if (outcome.kind === 'unsent') return { ok: false, text: `${CONTINUE_UNSENT}(${outcome.error})` };
    return { ok: false, text: outcome.error };
  };

  /** 同一包 → 走待发箱补发(同一号);新包 → 落盘新开一条。 */
  async function dispatch(pkg: string, body: Record<string, unknown>): Promise<SendOutcome> {
    const outbox = session.outbox;
    if (outbox === undefined) {
      // 老假 Session 没有待发箱:直连这一档,动作包换号逻辑同一套。
      const key = lastAttempt !== undefined && lastAttempt.pkg === pkg ? lastAttempt.key : newClientKey();
      setLastAttempt({ pkg, key });
      const result = await session.client.json(CONTINUE_PATH, { method: 'POST', body: { ...body, client_key: key } });
      return classifyLike(result);
    }
    if (lastAttempt !== undefined && lastAttempt.pkg === pkg) return outbox.resend(lastAttempt.key);
    const at = new Date().toISOString();
    // 撤回允许空原话:待发箱那条给人看的字用意图顶上,不能是空白。
    const shown = typeof body.text === 'string' && body.text !== '' ? body.text : '撤回这件';
    const sent = await outbox.send(CONTINUE_PATH, body, { text: shown, at });
    setLastAttempt({ pkg, key: sent.key });
    return sent.outcome;
  }

  /** 直连那一档的业务分类(与登记在 outbox 上的是同一个判据,一处两份会漂 —— 直接复用)。 */
  function classifyLike(result: ApiResult<unknown>): SendOutcome {
    if (!result.ok) {
      if (result.kind === 'network' || result.kind === 'unauthorized' || result.status >= 500) {
        return { kind: 'unsent', error: result.error };
      }
      return { kind: 'rejected', error: result.error };
    }
    const data = result.data as { ok?: boolean; note?: string } | undefined;
    if (data?.ok === true) return { kind: 'delivered', data: result.data };
    return { kind: 'rejected', error: data?.note ?? '没办成' };
  }

  async function send(text: string, record: boolean, intentOverride?: ItemSayIntent): Promise<boolean> {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setReceipt(undefined);
    try {
      // record 档永远纯留言(不带意图);撤回允许空原话(意图本身就是交代)。
      const effIntent: ItemSayIntent = record ? 'supplement' : intentOverride ?? intent;
      const aim = record ? 'record' : target ?? '';
      // ★ 多条能续还没选:那一句一个字都不外发(歧义不代选)。
      if (!record && sendable.length > 1 && target === undefined) {
        setReceipt({ ok: false, text: CONTINUE_NEED_PICK });
        return false;
      }
      const body: Record<string, unknown> = {
        id: taskId,
        text,
        // record 档不带给谁 —— 那句话只落在卡上,一个字都不往外发。
        ...(record ? { record: true } : target === undefined ? {} : { target }),
        // 补充是缺省档:不带 intent 字段,老服务端 / 卡 A 之前的行为逐字兼容。
        ...(effIntent === 'supplement' ? {} : { intent: effIntent }),
      };
      const outcome = await dispatch(packageOf(taskId, aim, text, effIntent), body);
      const line = outcomeLine(outcome);
      setReceipt(line);
      if (outcome.kind === 'delivered') {
        const result = outcome.data as ItemContinueResult | undefined;
        const resultTarget = typeof result?.target === 'string' ? result.target : target;
        const source = !record && resultTarget !== undefined ? currentView.sources.find(one => one.key === resultTarget && one.agent !== 'dsh' && one.action.kind === 'relay') : undefined;
        setReadback(undefined);
        if (source !== undefined) void readSource(source);
        // 送出去了:清打字框(重挂载 composer)与草稿,意图回缺省。没送成留着 —— 那句话还没落地。
        dirtyRef.current = false;
        setDraft('');
        setIntent('supplement');
        setTarget(sendable.length === 1 ? sendable[0]?.key : undefined);
        setLastAttempt(undefined);
        setComposerNonce(n => n + 1);
        try { draftStore().removeItem(draftKeyOf(taskId)); } catch { /* 同上 */ }
        return true;
      }
      return false;
    } finally {
      sendingRef.current = false;
    }
  }

  return (
    <section className="ba-sheet__say2" aria-label="继续这件事">
      {view.sources.length === 0 && (
        <p className="ba-sheet__hint" data-say="off">{view.note ?? '这件事没有连着能接续的会话。'}</p>
      )}
      {sendable.length > 1 && (
        <select
          aria-label="发给哪一条会话"
          className="ba-sheet__facts"
          value={target ?? ''}
          onChange={(event) => { dirtyRef.current = true; setTarget(event.target.value === '' ? undefined : event.target.value); }}
        >
          <option value="">选一条会话……</option>
          {sendable.map((one: ItemContinueSource) => <option key={one.key} value={one.key}>{one.title}</option>)}
        </select>
      )}
      {sendable.length === 1 && <p className="ba-sheet__hint">发给:{sendable[0]?.title}</p>}
      {blocked.map(one => (
        <p key={one.key} className="ba-sheet__hint">{one.title}:{one.action.kind === 'none' ? one.action.why : ''}</p>
      ))}
      {view.sources.map(one => (
        <button key={`read:${one.key}`} type="button" className="ba-btn ba-btn--ghost" disabled={readback?.loading === true} onClick={() => void readSource(one)}>查看原会话：{one.title}</button>
      ))}
      {receipt !== undefined && (
        <p className="ba-sheet__hint" role="status" data-say="receipt" data-ok={receipt.ok}>{receipt.text}</p>
      )}
      {readback !== undefined && (
        <section className="ba-sheet__rounds" aria-label="原会话回读">
          <p className="ba-sheet__hint">{readback.source.title} · 原会话记录</p>
          {readback.loading && <p className="ba-sheet__hint" role="status">正在读取原会话…</p>}
          {readback.error !== undefined && <p className="ba-sheet__hint" role="status">{readback.error}</p>}
          {!readback.loading && readback.error === undefined && readback.turns?.length === 0 && <p className="ba-sheet__hint">这条会话还没有可读回话。</p>}
          {readback.turns !== undefined && readback.turns.length > 0 && (
            <ol className="ba-rounds">
              {readback.turns.map((turn, index) => (
                <li key={`${turn.at ?? ''}-${index}`}>
                  {turn.k === 'ask' ? <p className="ba-rounds__ask"><small>你</small>{turn.text}</p> : <p className="ba-rounds__reply"><small>{readback.source.title}</small>{turn.text}</p>}
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="ba-btn ba-btn--ghost" disabled={readback.loading} onClick={() => void readSource(readback.source)}>再读一次</button>
        </section>
      )}
      {restored && (
        <select
          aria-label={CONTINUE_INTENT_LABEL}
          className="ba-sheet__facts"
          value={intent}
          onChange={(event) => { dirtyRef.current = true; setIntent(event.target.value === 'redirect' || event.target.value === 'hurry' ? event.target.value : 'supplement'); }}
        >
          <option value="supplement">补充一句(排在它后面)</option>
          <option value="redirect">改方向(打断正在跑的)</option>
          <option value="hurry">催一下(别干等)</option>
        </select>
      )}
      {restored && (
      <PhoneComposer
        key={composerNonce}
        trim="call"
        placeholder={FIELD_PLACEHOLDER}
        ariaLabel={CONTINUE_LABEL}
        initialText={draft}
        onTextChange={(text) => { dirtyRef.current = true; setDraft(text); }}
        onSubmit={async (composerDraft) => {
          const text = composerDraft.text.trim();
          if (text === '') return false;
          return send(text, false);
        }}
        extra={(
          <button
            type="button"
            className="ba-btn ba-btn--ghost ba-say__interrupt"
            disabled={draft.trim() === '' || recordBusy}
            onClick={() => {
              if (sendingRef.current) return;
              setRecordBusy(true);
              void send(draft.trim(), true).finally(() => { setRecordBusy(false); });
            }}
          >
            {CONTINUE_RECORD}
          </button>
        )}
      />
      )}
      {restored && (
        <button
          type="button"
          className="ba-btn ba-btn--ghost ba-say__interrupt"
          disabled={sendingRef.current}
          onClick={() => {
            if (sendingRef.current) return;
            // 撤回允许不带字:意图本身就是那句交代。
            void send(draft.trim(), false, 'recall');
          }}
        >
          {CONTINUE_RECALL}
        </button>
      )}
    </section>
  );
}
