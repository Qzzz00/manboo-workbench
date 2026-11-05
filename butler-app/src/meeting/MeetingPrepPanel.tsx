/**
 * 手机上的会前准备(2026-10-10,卡「会前画像与预案」)。会议页里点开一场「待开的会」就是这一块。
 *
 * - 五问缺哪问问哪问(一问一答,不猜);
 * - 要定什么说不清 → 先拦,摆出拟好的那句去问组织者的话:**只能复制,发不发由她**;
 * - 预案卡只读,按手机这一屏排(一个数带出处 / 一个说法 / 一个退路),开会前在路上看熟;
 * - 「开始录这场」→ 录音接到同一场。
 * 真相在电脑上:答完用回包里那一场换掉这一块,也等 `/state` 那一拍。
 */
import { useState } from 'react';
import type { MeetingPlanView, MeetingPrepAnswer, MeetingPrepView } from '../api/protocol';
import type { MeetingApi, MeetingDetail } from './meetingApi';

const FROM_LABEL = { said: '你那句话里说的', asked: '你答的' } as const;

function fromOf(answer: MeetingPrepAnswer<unknown>): string {
  return answer.from === 'record' ? (answer.basis ?? '已有记录里认出的') : FROM_LABEL[answer.from];
}

/** 列表里那一行的小字:这场会前准备到哪了。 */
export function meetingPlanLine(plan: MeetingPlanView): string {
  const prep = plan.prep;
  const when = prep?.when === undefined ? '' : `${prep.when} · `;
  if (prep === undefined) return when;
  if (prep.ask !== undefined) return `${when}还差一问`;
  if (prep.card_status === 'goal') return `${when}要定什么还没说清`;
  if (prep.card_status === 'ready') return `${when}预案卡好了`;
  if (prep.card_status === 'failed') return `${when}预案卡没做成`;
  return `${when}预案卡在做`;
}

/** 首页那颗会议键要不要亮点:有一场待开的会在等她答,或者预案卡好了(推到手机上的就是它)。 */
export function meetingPlanNeedsLook(plans: readonly MeetingPlanView[] | undefined): boolean {
  return (plans ?? []).some(plan => plan.prep !== undefined && (plan.prep.ask !== undefined || plan.prep.card_status === 'goal' || plan.prep.card_status === 'ready'));
}

/**
 * 画像五问那张表(只读)。会前准备里用它,会后那一场的「会前」页签也用它(2026-10-13)——
 * **一份,不画两遍**:两处要显示的是同一件事(答的是什么、这答案从哪来)。
 */
export function MeetingPrepFacts({ prep }: { prep: MeetingPrepView }) {
  return (
    <>
      <dl className="ba-meeting__portrait">
        {prepRows(prep).map(row => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}{row.from !== undefined && <small>{row.from}</small>}</dd>
          </div>
        ))}
      </dl>
      <p className="ba-meeting__hint ba-meeting__hint--dim">参会人只记花名;花名对应谁只有你知道。</p>
    </>
  );
}

/** 预案卡(只读):一个问题配一个数(带出处)、一个说法、一个退路。没做出来的那一场整块不出现。 */
export function MeetingPrepCardList({ prep }: { prep: MeetingPrepView }) {
  if (prep.card === undefined) return null;
  return (
    <>
      <h2 className="ba-meeting__h">预案卡</h2>
      <ol className="ba-meeting__card" aria-label="预案卡">
        {prep.card.questions.map(one => (
          <li key={one.q}>
            <p className="ba-meeting__q">{one.q}</p>
            <p>{one.number === undefined ? '数:没有这个数' : `数:${one.number.text}`}</p>
            {one.number !== undefined && <p className="ba-meeting__hint ba-meeting__hint--dim">{`出处:${one.number.source}`}</p>}
            <p>{`说法:${one.line}`}</p>
            <p>{`退路:${one.fallback}`}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

export function prepRows(prep: MeetingPrepView): { label: string; value: string; from?: string }[] {
  const row = <T,>(label: string, answer: MeetingPrepAnswer<T> | undefined, show: (value: T) => string) =>
    answer === undefined ? { label, value: '还没答' } : { label, value: show(answer.value), from: fromOf(answer as MeetingPrepAnswer<unknown>) };
  return [
    row('内部还是外部', prep.scope, v => v),
    row('类型', prep.kind, v => v),
    row('谁来', prep.people, v => v.map(p => (p.role === undefined ? p.alias : `${p.alias}(${p.role})`)).join('、') || '没说'),
    row('谁拍板', prep.decider, v => v),
    row('你的角色', prep.my_role, v => v),
    prep.goal_unclear === true ? { label: '要定下什么', value: '还没说清' } : row('要定下什么', prep.goal, v => v),
  ];
}

export interface MeetingPrepPanelProps {
  plan: MeetingPlanView;
  api: MeetingApi;
  onStart: (title: string, planId: string) => void;
  onBack: () => void;
}

export function MeetingPrepPanel({ plan: initial, api, onStart, onBack }: MeetingPrepPanelProps) {
  const [plan, setPlan] = useState<MeetingPlanView | MeetingDetail>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const prep = plan.prep;

  const apply = async (call: () => ReturnType<MeetingApi['answer']>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const got = await call();
      if (!got.ok) { setNote(got.error); return false; }
      if (got.data.meeting !== undefined) setPlan(got.data.meeting);
      setNote(got.data.note ?? null);
      return true;
    } finally { setBusy(false); }
  };
  const answer = async (value: string, question = prep?.ask?.id): Promise<void> => {
    if (question === undefined || value.trim() === '') return;
    if (await apply(() => api.answer(plan.id, question, value))) setText('');
  };
  const copyAsk = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(prep?.organizer_ask ?? ''); setNote('复制好了,发不发、发给谁由你。'); }
    catch { setNote('没复制成,照着上面那句自己发就行。'); }
  };
  const drop = async (): Promise<void> => {
    const got = await api.drop(plan.id);
    if (!got.ok) { setNote(got.error); return; }
    onBack();
  };

  if (prep === undefined) return null;
  return (
    <div className="ba-meeting__prep" aria-label={`会前准备:${plan.title}`}>
      <h2 className="ba-meeting__h">{plan.title}</h2>
      {prep.when !== undefined && <p className="ba-meeting__hint">{prep.when}</p>}
      <MeetingPrepFacts prep={prep} />

      {prep.ask !== undefined && (
        <div className="ba-meeting__ask">
          <p className="ba-meeting__status">{prep.ask.text}</p>
          {prep.ask.hint !== undefined && <p className="ba-meeting__hint">{prep.ask.hint}</p>}
          {prep.ask.choices !== undefined && (
            <div className="ba-meeting__chips">
              {prep.ask.choices.map(choice => <button key={choice} type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void answer(choice); }}>{choice}</button>)}
            </div>
          )}
          <div className="ba-meeting__top">
            <input className="ba-input ba-meeting__title" aria-label={prep.ask.text} value={text} disabled={busy} onChange={e => setText(e.target.value)} />
            <button type="button" className="ba-btn" disabled={busy || text.trim() === ''} onClick={() => { void answer(text); }}>答</button>
          </div>
        </div>
      )}

      {prep.card_status === 'goal' && (
        <div className="ba-meeting__ask" role="alert">
          <p className="ba-meeting__warn">这场会要定什么还没说清,先别急着备材料。可以先问问组织者:</p>
          <blockquote className="ba-meeting__quote">{prep.organizer_ask}</blockquote>
          <p className="ba-meeting__hint ba-meeting__hint--dim">这句话只替你拟好,发不发、发给谁由你,事务官不会替你发。</p>
          <div className="ba-meeting__keys">
            <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void copyAsk(); }}>复制这句</button>
            <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void apply(() => api.card(plan.id, true)); }}>先照现在的准备</button>
          </div>
          <div className="ba-meeting__top">
            <input className="ba-input ba-meeting__title" aria-label="问清楚了:这场会要定下什么" placeholder="问清楚了就写在这儿" value={text} disabled={busy} onChange={e => setText(e.target.value)} />
            <button type="button" className="ba-btn" disabled={busy || text.trim() === ''} onClick={() => { void answer(text, 'goal'); }}>就定这个</button>
          </div>
        </div>
      )}

      {prep.card_status === 'making' && <p className="ba-meeting__status" role="status">预案卡在做…做好会出现在这里。</p>}
      {prep.card_status === 'failed' && <p className="ba-meeting__warn">{prep.card_error ?? '预案卡没做成'}</p>}
      <MeetingPrepCardList prep={prep} />

      <div className="ba-meeting__keys">
        <button type="button" className="ba-btn ba-btn--big" onClick={() => onStart(plan.title, plan.id)}>开始录这场</button>
      </div>
      <div className="ba-meeting__keys">
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onBack}>回去</button>
        <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void drop(); }}>这不是一场会,撤掉</button>
      </div>
      {note !== null && <p className="ba-meeting__note" role="status">{note}</p>}
    </div>
  );
}
