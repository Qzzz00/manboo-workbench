import type { WorkbenchState } from '../api/protocol';
import type { SayCardPayload, SayChoiceOption } from './sayCards';
import { sayChoiceRequest, sayScreen, sayDecidedChoices } from './sayCards';

/** 服务端决策结果卡：不推测缺失字段，也不将事项状态折算成成功回执。 */
export function SayDecisionCards({ payload, state, busy = false, onChoose }: {
  payload: SayCardPayload; state?: Pick<WorkbenchState, 'tasks'>;
  busy?: boolean;
  onChoose: (choice: string, askId?: string, suggestId?: string, decidedId?: string) => void;
}) {
  const options = (payload.suggest?.options ?? []) as SayChoiceOption[];
  const asks = payload.asks ?? (payload.ask === undefined ? [] : [payload.ask]);
  const askCards = asks.length > 0 ? asks : (payload.hold === undefined ? [] : [{ ask_id: payload.hold.hold_id, question: payload.hold.question }]);
  return <section className="ba-say-cards" aria-label="事务官处理结果" style={{ boxSizing: 'border-box', width: '100%', maxHeight: '24vh', overflowY: 'auto', overflowX: 'hidden', padding: '0.5rem', overflowWrap: 'anywhere' }}>
    {sayScreen(payload) !== undefined && <p className="ba-say-cards__screen">{sayScreen(payload)}</p>}
    {payload.decided?.map((item, i) => <article className="ba-say-card" key={`${item.item_index}:${item.field}:${i}`}>
      <strong>我替你定的</strong><p>{item.why}：{item.chosen}</p>
      {sayDecidedChoices(payload, item, state).map(option => <button type="button" key={option.id} disabled={busy || item.field !== 'who' || !item.decided_id} onClick={() => onChoose(option.id, undefined, undefined, item.decided_id)}>改为 {option.label}</button>)}
      {item.alternatives.length > 0 && (item.field !== 'who' || !item.decided_id) && <small>服务端未提供改选编号，暂不能提交。</small>}
    </article>)}
    {payload.suggest !== undefined && <article className="ba-say-card">
      <strong>建议</strong><p>{payload.suggest.line}</p>
      {options.map(option => <button type="button" key={option.id} disabled={busy || !payload.suggest?.suggest_id} onClick={() => onChoose(option.id, undefined, payload.suggest?.suggest_id)}>{option.label}</button>)}
      <button type="button" disabled={busy || !payload.suggest.suggest_id || payload.suggest.default_action !== 'keep'} onClick={() => onChoose('keep', undefined, payload.suggest?.suggest_id)}>按建议默认处理</button>
    </article>}
    {askCards.map(ask => {
      const askIdExists = sayChoiceRequest(payload, 'yes', ask.ask_id) !== undefined;
      return <article className="ba-say-card" data-kind={payload.hold ? 'hold' : 'ask'} key={ask.ask_id}>
        <strong>{payload.hold ? '需要确认' : '等你确认'}</strong><p>{ask.question}</p>
        <button type="button" disabled={busy || !askIdExists} onClick={() => onChoose('yes', ask.ask_id)}>确认</button>
        <button type="button" disabled={busy || !askIdExists} onClick={() => onChoose('no', ask.ask_id)}>否定</button>
      </article>;
    })}
    {payload.decided?.map((decision, i) => {
      const original = payload.items?.[decision.item_index];
      return <p className="ba-say-card__item" key={`decision:${decision.item_index}:${i}`}>
        原件：{original?.title ?? '服务端未提供事项标题'} · {original?.card_id === undefined ? '服务端未提供事项 ID' : `事项 ID ${original.card_id}`}
      </p>;
    })}
    {payload.items?.map((item, i) => <p className="ba-say-card__item" key={item.card_id ?? `${item.title ?? 'item'}:${i}`}>
      {item.title ?? '未命名事项'} · {item.status === 'done' ? '已处理' : item.status === 'asked' ? '等待确认' : item.status === 'failed' ? '未处理成功' : '状态未知'}
      {item.card_id === undefined && <span> · 服务端未提供事项 ID</span>}
    </p>)}
  </section>;
}
