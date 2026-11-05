import type { WorkbenchState } from '../protocol.ts';
import { sayConfirmBody, sayScreen, sayDecidedChoices, type SayCardPayload } from './sayCards.ts';

/** `hideScreen`:球下那一行已经摆了服务端那一句时,看详情不再重复一遍(2026-10-27)。 */
export function SayDecisionCards({ payload, state, busy, onChoose, hideScreen = false }: { payload: SayCardPayload; state?: Pick<WorkbenchState, 'tasks'>; busy: boolean; onChoose: (choice: string, askId?: string, suggestId?: string, decidedId?: string) => void; hideScreen?: boolean }) {
  const asks = payload.asks ?? (payload.ask === undefined ? [] : [payload.ask]);
  const askCards = asks.length > 0 ? asks : (payload.hold === undefined ? [] : [{ ask_id: payload.hold.hold_id, question: payload.hold.question }]);
  return <section className="ben-wb__say-cards" aria-label="事务官处理结果" style={{ boxSizing: 'border-box', width: '100%', maxHeight: '22vh', overflowY: 'auto', overflowX: 'hidden', padding: '6px 8px', overflowWrap: 'anywhere' }}>
    {!hideScreen && sayScreen(payload) !== undefined && <p>{sayScreen(payload)}</p>}
    {payload.decided?.map((one, i) => {
      const original = payload.items?.[one.item_index];
      return <article key={`${one.item_index}:${one.field}:${i}`}>
        <strong>我替你定的</strong><p>{one.why}：{one.chosen}</p>
        <p>原件：{original?.title ?? '服务端未提供事项标题'} · {original?.card_id === undefined ? '服务端未提供事项 ID' : `事项 ID ${original.card_id}`}</p>
        {sayDecidedChoices(payload, one, state).map(option => <button type="button" key={option.id} disabled={busy || one.field !== 'who' || !one.decided_id} onClick={() => onChoose(option.id, undefined, undefined, one.decided_id)}>改为 {option.label}</button>)}
        {one.alternatives.length > 0 && (one.field !== 'who' || !one.decided_id) && <small>服务端未提供改选编号，暂不能提交。</small>}
      </article>;
    })}
    {payload.suggest !== undefined && <article><strong>建议</strong><p>{payload.suggest.line}</p>
      {payload.suggest.options.map(option => <button type="button" key={option.id} disabled={busy || !payload.suggest?.suggest_id} onClick={() => onChoose(option.id, undefined, payload.suggest?.suggest_id)}>{option.label}</button>)}
      <button type="button" disabled={busy || !payload.suggest.suggest_id || payload.suggest.default_action !== 'keep'} onClick={() => onChoose('keep', undefined, payload.suggest?.suggest_id)}>按建议默认处理</button>
    </article>}
    {askCards.map(ask => {
      const hasConfirmId = sayConfirmBody(payload, 'yes', ask.ask_id) !== undefined;
      return <article data-kind={payload.hold ? 'hold' : 'ask'} key={ask.ask_id}>
        <strong>{payload.hold ? '需要确认' : '等你确认'}</strong><p>{ask.question}</p>
        <button type="button" disabled={busy || !hasConfirmId} onClick={() => onChoose('yes', ask.ask_id)}>确认</button>
        <button type="button" disabled={busy || !hasConfirmId} onClick={() => onChoose('no', ask.ask_id)}>否定</button>
        {!hasConfirmId && <small>服务端没有提供确认编号，暂不能提交。</small>}
      </article>;
    })}
    {payload.items?.map((one, i) => <p key={one.card_id ?? `${one.title ?? 'item'}:${i}`}>
      {one.title ?? '未命名事项'} · {one.status === 'done' ? '已处理' : one.status === 'asked' ? '等待确认' : one.status === 'failed' ? '处理失败' : '状态未知'}
      {one.card_id === undefined && ' · 服务端未提供事项 ID'}
    </p>)}
  </section>;
}
