/**
 * 「就这一条资讯深聊」那一层(2026-10-13,卡「播客页重做」★3 / ★4)。
 *
 * 维护者原话:「我点击之后,可以打断正在播放的播客,我可以与事务官针对这条信息进行深入挖掘和
 * 交流,文字和语音两种选项,语音可以是按住说话的那种,也可以是通话,聊完之后的结论同步到电脑的
 * 随手记,如果需要形成待办的则做成事项卡出现在项目区的看板里,要带上来源于」。
 *
 * 一层四块:
 *   顶上 —— 这条资讯本身(标题、来源 · 项目、一句话为什么相关、看原文);
 *   中间 —— 对话。打字与按住说话**走同一条路**(`send`),按住说话那一句标一下「说的」;
 *   底下 —— 输入框 + 按住说话 + 「打电话聊」;
 *   收尾 —— 结论那一栏:先摆事务官最后那一句(**不额外花钱**),她可以自己改,
 *           也可以点「让它收一句」让模型收一句;两颗键「存成随手记」「做成事项」各给回执。
 *
 * **「让它收一句」是一颗键,不是自动跑**:那是多一次模型调用,花的是她的钱 ——
 * 自动跑等于替她决定花钱(AGENTS.md「要花钱的别自己定」)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceRecordOverlay } from '../aiboo/VoiceRecordOverlay';
import { useHoldToTalk } from '../chat/useHoldToTalk';
import type { AsrResult } from '../api/voice';
import { conclusionDraft, digMetaLine, type DigTurn } from './digModel';
import type { DigApi } from './digApi';
import type { NewsItem } from './newsModel';

/** 两颗键各自的回执(她点完要看得见「真记上了」)。 */
export const DIG_NOTE_DONE = '记进电脑的随手记了';
export const DIG_TASK_DONE = '做成事项卡了,在项目区的看板里';
/** 「打电话聊」这台机器上没接通话时说的话。**不画一颗点了没反应的键**。 */
export const DIG_CALL_OFF = '这台手机这会儿打不了电话:先在首页确认通话能用';

export interface DigSheetProps {
  item: NewsItem;
  api: DigApi;
  /** 转文字(与首页那颗麦克风同一条路:`session.voice.asr`)。 */
  transcribe(wav: Blob): Promise<AsrResult>;
  /** 点原文:用系统浏览器开。 */
  onOpenLink(url: string): void;
  /** 关掉这一层(回播客页,能从暂停处接着播)。 */
  onClose(): void;
  /**
   * 「打电话聊」。缺席 = 这台机器上通话没接上 → 那颗键**灰掉并写明原因**。
   * 调用方要做两件事:告诉 8791「这一通是为哪条打的」(由这里先打 `/feed/dig/call`)、然后开那一通。
   */
  onCall?(): void;
}

export function DigSheet(props: DigSheetProps) {
  const { item, api } = props;
  const [turns, setTurns] = useState<DigTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conclusion, setConclusion] = useState('');
  /** 她动过结论那一栏之后,别再被新回合覆盖掉(她改的比我们摆的算数)。 */
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<'conclude' | 'note' | 'task' | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // 新回合进来就滚到底(她在看最后一句)。
  // `scrollIntoView` 在 jsdom 里压根没有实现 —— 可选调用,滚不动不该把这一层弄崩。
  useEffect(() => { tailRef.current?.scrollIntoView?.({ block: 'end' }); }, [turns.length]);

  // 结论那一栏:她没动过就跟着对话走(摆事务官最后那一句)。**不问模型**,不花钱。
  useEffect(() => {
    if (touched) return;
    setConclusion(conclusionDraft(turns));
  }, [turns, touched]);

  /** 打字与按住说话走的同一条路。 */
  const send = useCallback(async (text: string, spoken?: true) => {
    const said = text.trim();
    if (said === '' || sending) return;
    setSending(true);
    setError(null);
    setTurns(list => [...list, { who: 'her', text: said, ...(spoken === undefined ? {} : { spoken }) }]);
    const result = await api.say(item.id, said, turns);
    setSending(false);
    if (!result.ok) { setError(result.error); return; }
    setTurns(list => [...list, { who: 'butler', text: result.data.said }]);
  }, [api, item.id, sending, turns]);

  const hold = useHoldToTalk({
    transcribe: props.transcribe,
    onText: (text) => { void send(text, true); },
    onError: setError,
  });

  const conclude = useCallback(async () => {
    setBusy('conclude');
    const result = await api.conclude(item.id, turns);
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    setTouched(true);
    setConclusion(result.data.said);
  }, [api, item.id, turns]);

  const keep = useCallback(async (where: 'note' | 'task') => {
    const said = conclusion.trim();
    if (said === '') { setError('先写一句结论(或者点「让它收一句」)'); return; }
    setBusy(where);
    setError(null);
    const result = where === 'note' ? await api.note(item.id, said) : await api.task(item.id, said);
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    setReceipt(where === 'note' ? DIG_NOTE_DONE : DIG_TASK_DONE);
  }, [api, conclusion, item.id]);

  const call = useCallback(async () => {
    if (props.onCall === undefined) return;
    setError(null);
    // 先告诉电脑「这一通是为哪条打的」,再开那一通 —— 反过来的话第一句就已经说出去了。
    const marked = await api.callContext(item.id, turns);
    if (!marked.ok) { setError(marked.error); return; }
    props.onCall();
  }, [api, item.id, turns, props]);

  const meta = digMetaLine({
    ...(item.source === undefined ? {} : { source: item.source }),
    project_name: item.project_name,
  });

  return (
    <div className="ba-sheet ba-dig" role="dialog" aria-label="就这一条深聊">
      <div className="ba-sheet__card ba-dig__card">
        <header className="ba-dig__head">
          <p className="ba-dig__title">{item.title}</p>
          {meta !== '' && <p className="ba-dig__meta">{meta}</p>}
          {item.why !== '' && <p className="ba-dig__why">{item.why}</p>}
          <button type="button" className="ba-dig__link" onClick={() => props.onOpenLink(item.url)}>看原文</button>
        </header>

        <div className="ba-dig__turns" role="log">
          {turns.length === 0 && <p className="ba-dig__hint">想问什么就问 —— 打字,或者按住下面那颗键说。</p>}
          {turns.map((turn, i) => (
            <p className="ba-dig__turn" data-who={turn.who} key={`${i}-${turn.text.slice(0, 8)}`}>
              {turn.spoken === true && <span className="ba-dig__spoken">说的</span>}
              {turn.text}
            </p>
          ))}
          {sending && <p className="ba-dig__turn" data-who="butler">…</p>}
          <div ref={tailRef} />
        </div>

        <div className="ba-dig__ask">
          <input
            className="ba-dig__input"
            type="text"
            value={draft}
            placeholder="就这一条问一句"
            aria-label="就这一条问一句"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { void send(draft); setDraft(''); } }}
          />
          <button
            type="button"
            className="ba-dig__send"
            disabled={sending || draft.trim() === ''}
            onClick={() => { void send(draft); setDraft(''); }}
          >发</button>
        </div>

        <div className="ba-dig__voice">
          <button
            type="button"
            className="ba-mic ba-dig__mic"
            data-recording={hold.recording}
            onPointerDown={(e) => {
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 有的 WebView 不认这个 pointerId */ }
              hold.begin(e.clientY);
            }}
            onPointerMove={e => hold.move(e.clientY)}
            onPointerUp={() => { void hold.end(); }}
            onPointerCancel={() => hold.abort()}
            onContextMenu={e => e.preventDefault()}
            aria-label="按住说话"
          >{hold.recording ? '松开发送' : '按住说话'}</button>
          <button
            type="button"
            className="ba-dig__act"
            disabled={props.onCall === undefined}
            title={props.onCall === undefined ? DIG_CALL_OFF : '和事务官就这条通话'}
            onClick={() => { void call(); }}
          >打电话聊</button>
        </div>
        {props.onCall === undefined && <p className="ba-dig__off" role="status">{DIG_CALL_OFF}</p>}

        <section className="ba-dig__end">
          <p className="ba-dig__h">聊完的结论</p>
          <textarea
            className="ba-dig__conclusion"
            aria-label="聊完的结论"
            rows={3}
            value={conclusion}
            placeholder="一两句话,写她真正留下来的那句"
            onChange={(e) => { setTouched(true); setConclusion(e.target.value); }}
          />
          <div className="ba-dig__acts">
            <button
              type="button"
              className="ba-dig__act"
              disabled={busy !== null || turns.length === 0}
              onClick={() => { void conclude(); }}
            >{busy === 'conclude' ? '在收…' : '让它收一句'}</button>
            <button
              type="button"
              className="ba-dig__act"
              disabled={busy !== null}
              onClick={() => { void keep('note'); }}
            >{busy === 'note' ? '在记…' : '存成随手记'}</button>
            <button
              type="button"
              className="ba-dig__act"
              disabled={busy !== null}
              onClick={() => { void keep('task'); }}
            >{busy === 'task' ? '在建…' : '做成事项'}</button>
          </div>
          {receipt !== null && <p className="ba-dig__done" role="status">{receipt}</p>}
        </section>

        {error !== null && <p className="ba-dig__err" role="alert">{error}</p>}
        <button type="button" className="ba-btn ba-dig__close" onClick={props.onClose}>聊完了,回去听</button>
      </div>
      <VoiceRecordOverlay
        visible={hold.recording || hold.transcribing}
        elapsedMs={hold.elapsedMs}
        cancelHint={hold.cancelHint}
        transcribing={hold.transcribing}
        level={hold.level}
      />
    </div>
  );
}
