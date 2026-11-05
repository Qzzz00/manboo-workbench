/**
 * 统一输入框 —— 手机那一份(2026-09-24,docs/设计-统一输入框-2026-09-24.md)。
 *
 * 与电脑的 workbench-plugin/src/client/composer/Composer.tsx 同一套长相与口径(两端不互相 import)。
 * 手机首页那一档(维护者 09-24 拍板「要全套,收紧摆」):
 *   - 「+」、@、模式与模型合成的**一枚胶囊**「先问我 · V4 Flash ⌄」在左下,胶囊点开是底部抽屉,上下两段;
 *   - 右下角一对键(同日下午,卡 feat/phone-composer-call-slot,维护者原话见决策记录):
 *       · 右边那颗:**没内容时是通话键**(电话),一打字 / 加了图片文件就是发送键(向上箭头),删光了变回通话键;
 *         通话打不了时灰着、点不动(说明在上面那一行 ba-scene__callnote);
 *       · 左边那颗:**麦克风,按住说话**,样式大小和发送键一样。一按下就录(不再先等 260ms 判「点还是按住」),
 *         松开转成文字直接发出去,上滑松开作废,太短 / 被打断 / 识别没成都说一句人话。
 *   - 输入框本身只管打字:一直是真的 textarea,长按就是系统原生的粘贴 / 选词。
 *     (09-17 到 09-24 上午它是一颗「长得像输入框的按钮」:点了打字、按住录音 —— 为了躲系统长按;
 *      维护者真机上按不出来,正是撞上了长按粘贴那一套。这一版把手势整个挪到麦克风键上,输入框还给系统。)
 * 通话页与引导兜底页用同一个组件的另外两档裁剪:只有文字与发送(没有麦克风、没有通话键)。
 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { ComposerAgentView, ComposerCurrentView, ComposerMode, ComposerModelView, ComposerOptionsView } from '../api/protocol';
import type { AsrResult } from '../api/voice';
import { VoiceRecordOverlay } from '../aiboo/VoiceRecordOverlay';
import { useHoldToTalk } from '../chat/useHoldToTalk';
import { FxBeam } from '../fx/Fx';
import type { BeamSpec } from '../fx/fxModel';
import { StageIcon } from '../stage/icons';
import { useBackHandler } from '../nav/back';
import type { ComposerApi } from './composerApi';
import './composer.css';
import {
  TRIMS, actionKeyOf, atQuery, canSend, dropAtQuery, filesOf, filterAgents, handLine, hasChips, isSendKey, joinSaid, modeTitle,
  type ComposerDraft, type DraftAttachment,
} from './composerModel';

type Sheet = 'plus' | 'refs' | 'at' | 'pills';

export interface PhoneVoice {
  /** 语音用不了(设置里关了 / 本机没配 / 出了局域网被挡过):麦克风键灰着,按下去说 disabledNote,不录音。 */
  disabled?: boolean;
  disabledNote?: string;
  transcribe(wav: Blob): Promise<AsrResult>;
  onError(text: string): void;
  onLevel?(level: number): void;
}

/** 首页右下角那颗在「没内容」时的样子:通话入口(2026-09-24)。 */
export interface PhoneCallSlot {
  /** 能不能打。不能时灰着、点不动。 */
  ready: boolean;
  /** 键的无障碍名(不能打时带上原因)。 */
  label: string;
  /** 悬停提示。 */
  title?: string;
  /** 点了进通话 —— 与原来左边那颗同一条路(StagePage 的 setInCall(true))。 */
  onCall(): void;
}

export interface PhoneComposerProps {
  trim: 'phone-home' | 'call' | 'onboarding';
  /** 发出去:回 true = 接住了(清掉正文与片)。 */
  onSubmit(draft: ComposerDraft): Promise<boolean> | boolean;
  placeholder: string;
  /** 打字框的标签。 */
  ariaLabel: string;
  current?: ComposerCurrentView | undefined;
  api?: ComposerApi;
  glow?: boolean;
  fxSpec?: BeamSpec;
  voice?: PhoneVoice;
  /** 首页那一档:没内容时右下角那颗是通话键。缺席 = 永远是发送键。 */
  call?: PhoneCallSlot;
  /** 打字框有没有焦点(键盘在不在)—— 球的「聆听」态也认打字。只有首页那一档报 true。 */
  onTypingChange?(typing: boolean): void;
  /** 引导兜底页:发送键旁边还要摆别的(「停」)。 */
  extra?: ReactNode;
  /** 正文一变就告诉外面(引导页的球认「在打字」)。 */
  onTextChange?(text: string): void;
  /**
   * 挂载时框里的初始文字(2026-10-23,卡 A 复审):接续那一格关页再开,把存的草稿放回框里。
   * 缺席 = 空框(老用法一字不变);只在挂载那一刻读一次,之后框里还是它自己那份真值。
   */
  initialText?: string;
}

/** 麦克风键被系统打断(来电、下拉通知、头一次弹的录音权限框……)。 */
export const MIC_INTERRUPTED_TEXT = '被打断了,这句没发出去。再按住说一次';
/** 只点了一下、没有按住(读屏的双击、外接键盘回车):这颗键怎么用。 */
export const MIC_HINT_TEXT = '按住麦克风说话,松开就发出去';
/** 说完了,可附件还在传:这句话先放进框里,别丢。 */
export const SAID_WAITING_TEXT = '附件还没传完,这句先放进框里,传完再点发送';
/** 指针松开后这么久之内来的 click 是这一下按住带出来的,不另说话。 */
const CLICK_AFTER_POINTER_MS = 1000;

export function PhoneComposer(props: PhoneComposerProps) {
  const { trim, onSubmit, placeholder, ariaLabel, current, api, glow = false, fxSpec, voice, call, onTypingChange, extra, onTextChange, initialText } = props;
  const spec = TRIMS[trim];
  const home = trim === 'phone-home';
  /** 这一档有没有麦克风键。 */
  const talk = spec.voice && voice !== undefined;
  const [text, setTextState] = useState(initialText ?? '');
  const setText = useCallback((next: string) => { setTextState(next); onTextChange?.(next); }, [onTextChange]);
  const [chips, setChips] = useState<Omit<ComposerDraft, 'text'>>({ attachments: [], refs: [] });
  const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
  // 系统返回(2026-09-24,卡 fix/phone-nav-back):底部抽屉开着先收它,和点遮罩一样。
  useBackHandler(sheet !== undefined, () => setSheet(undefined));
  const [options, setOptions] = useState<ComposerOptionsView | undefined>(undefined);
  const [optionsNote, setOptionsNote] = useState<string | undefined>(undefined);
  const [atState, setAtState] = useState<{ start: number; query: string } | undefined>(undefined);
  const [picked, setPicked] = useState<{ mode?: ComposerMode; model?: ComposerModelView }>({});
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 麦克风键上正按着的那根手指(pointerId);没按着是 null。 */
  const pressRef = useRef<number | null>(null);
  /** 麦克风键上最近一次指针按下 / 松开的时刻:紧跟着来的 click 是它带出来的。 */
  const lastPointerAtRef = useRef(0);

  const draft: ComposerDraft = { ...chips, text };
  const sendable = canSend(draft) && !sending;
  const key = actionKeyOf(draft, { call: call !== undefined, sending });
  const mode = picked.mode ?? current?.mode ?? options?.mode;
  const model = picked.model ?? current?.model;

  const submitDraft = useCallback(async (d: ComposerDraft) => {
    if (!canSend(d)) {
      if (d.agent?.ready === false) {
        setOptionsNote(d.agent.why ?? '未就绪');
      }
      return;
    }
    setSending(true);
    try {
      const ok = await onSubmit(d);
      if (ok) {
        setText('');
        setChips({ attachments: [], refs: [] });
        // 首页:发完收起键盘,屏幕还给球和字幕(09-17 那条「发完自动收回」在真 textarea 上就是失焦)。
        if (home && inputRef.current !== null && document.activeElement === inputRef.current) inputRef.current.blur();
      }
    } finally {
      setSending(false);
    }
  }, [onSubmit, home, setText]);

  // 按住说话:说完的那句连同片一起发(片是「交给谁、带什么」,不该因为换了说的方式就丢);
  // 打了一半的字也一起(2026-09-24:麦克风键常驻,打着字也按得到它)。
  const hold = useHoldToTalk({
    transcribe: voice?.transcribe ?? (async (): Promise<AsrResult> => ({ ok: false, kind: 'unavailable', error: '语音不可用' })),
    onText: (said) => {
      const next: ComposerDraft = { ...chips, text: joinSaid(text, said) };
      // 附件还在传(发不出去):这句话先放进框里,别悄悄丢了。
      if (!canSend(next)) { setText(next.text); voice?.onError(SAID_WAITING_TEXT); return; }
      void submitDraft(next);
    },
    onError: voice?.onError ?? (() => {}),
    ...(voice?.onLevel === undefined ? {} : { onLevel: voice.onLevel }),
  });

  useEffect(() => { onTypingChange?.(home && focused); }, [home, focused, onTypingChange]);
  useEffect(() => {
    if (picked.mode !== undefined && current?.mode === picked.mode) setPicked(({ mode: _m, ...rest }) => rest);
    if (picked.model !== undefined && current?.model?.id === picked.model.id) setPicked(({ model: _m, ...rest }) => rest);
  }, [current, picked]);

  async function loadOptions(): Promise<void> {
    if (api === undefined) return;
    const got = await api.loadOptions();
    if ('error' in got) { setOptionsNote(got.error); return; }
    setOptions(got);
    setOptionsNote(undefined);
  }

  function open(next: Sheet): void {
    setSheet((s) => (s === next ? undefined : next));
    void loadOptions();
  }

  function addFiles(files: readonly File[]): void {
    if (!spec.plus || files.length === 0 || api === undefined) return;
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const image = file.type.startsWith('image/');
      let preview: string | undefined;
      try { preview = image && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined; } catch { preview = undefined; }
      const pending: DraftAttachment = { key, name: file.name === '' ? '照片' : file.name, image, ...(preview === undefined ? {} : { preview }) };
      setChips((c) => ({ ...c, attachments: [...c.attachments, pending] }));
      void api.upload(file).then((result) => {
        setChips((c) => ({
          ...c,
          attachments: c.attachments.map((one) => (one.key !== key ? one : result.ok ? { ...one, name: result.view.name, view: result.view } : { ...one, error: result.error })),
        }));
      });
    }
  }

  function pickAgent(agent: ComposerAgentView): void {
    if (agent.family === 'dsh') {
      setChips(({ agent: _a, ...rest }) => rest);
      setOptionsNote(undefined);
    } else {
      const why = agent.ready ? undefined : (agent.hands.find(h => !h.ready)?.why ?? agent.hands[0]?.why ?? '尚未就绪');
      setChips((c) => ({ ...c, agent: { family: agent.family, title: agent.title, ready: agent.ready, ...(why ? { why } : {}) } }));
      if (!agent.ready) setOptionsNote(why);
      else setOptionsNote(undefined);
    }
    if (atState !== undefined) {
      const caret = inputRef.current?.selectionStart ?? text.length;
      setText(dropAtQuery(text, atState.start, caret));
      setAtState(undefined);
    }
    setSheet(undefined);
  }

  function pickMode(next: ComposerMode): void {
    setPicked((p) => ({ ...p, mode: next }));
    void api?.saveChoice({ mode: next });
  }

  function pickModel(next: ComposerModelView): void {
    setPicked((p) => ({ ...p, model: next }));
    void api?.saveChoice({ model: { provider: next.provider, id: next.id } });
  }

  function onChangeText(next: string, caret: number): void {
    setText(next);
    if (!spec.at) return;
    const found = atQuery(next, caret);
    setAtState(found);
    if (found !== undefined && sheet !== 'at') { setSheet('at'); if (options === undefined) void loadOptions(); }
    else if (found === undefined && sheet === 'at') setSheet(undefined);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (!spec.plus) return;
    const files = filesOf(event.clipboardData?.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  // ——— 麦克风键:按住说话(2026-09-24) ———
  // 一按下就开录:这颗键只有一个意思,不用等表判「点还是按住」。按下那一刻录音浮层与键的按下态就出来。
  const micOff = voice?.disabled === true;
  const micNote = voice?.disabledNote ?? '语音不可用';
  const onMicDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    lastPointerAtRef.current = Date.now();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 不让按下这一下把焦点从打字框抢走:键盘在的话别收,版面别在手指底下跳。
    e.preventDefault();
    if (micOff) { voice?.onError(micNote); return; }
    // 真在录 / 在识别上一句:这一下不算(识别中的浮层本身就在说「识别中…」)。
    if (hold.recording || hold.transcribing) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 有的 WebView 不认这个 pointerId;触屏本来就隐式捕获,照样能录 */ }
    // 不看 pressRef 旧值:之前哪根手指万一没收到松开,也不能让这颗键从此按不动。
    pressRef.current = e.pointerId;
    hold.begin(e.clientY);
  };
  const onMicMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (pressRef.current === e.pointerId) hold.move(e.clientY);
  };
  const onMicUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    lastPointerAtRef.current = Date.now();
    if (pressRef.current !== e.pointerId) return;
    pressRef.current = null;
    void hold.end();
  };
  /** 系统把这根手指抢走了(来电、下拉通知、权限框):作废,并说一句。 */
  const onMicLost = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    lastPointerAtRef.current = Date.now();
    if (pressRef.current !== e.pointerId) return;
    pressRef.current = null;
    hold.abort();
    voice?.onError(MIC_INTERRUPTED_TEXT);
  };
  /** 没有指针的 click(读屏双击、外接键盘):告诉他这颗键怎么用。指针按住带出来的那个 click 不另说话。 */
  const onMicClick = (): void => {
    if (Date.now() - lastPointerAtRef.current < CLICK_AFTER_POINTER_MS) return;
    voice?.onError(micOff ? micNote : MIC_HINT_TEXT);
  };

  const atList = options === undefined ? [] : filterAgents(options.agents, atState?.query ?? '');
  const pillText = `${modeTitle(options, mode)}${model === undefined ? '' : `·${model.title}`}`;

  const box = (
    <div className="pc-box" data-trim={trim} data-glow={glow}>
      {hasChips(draft) && (
        <div className="pc-chips">
          {chips.agent !== undefined && (
            <span className="pc-chip" data-kind="agent">@{chips.agent.title}
              <button type="button" aria-label={`不交给${chips.agent.title}`} onClick={() => setChips(({ agent: _a, ...rest }) => rest)}>×</button>
            </span>
          )}
          {chips.attachments.map((one) => (
            <span key={one.key} className="pc-chip" data-kind="file" data-state={one.error !== undefined ? 'error' : one.view === undefined ? 'uploading' : 'ok'}>
              {one.preview !== undefined && <img src={one.preview} alt="" />}
              <span className="pc-chip__name">{one.name}</span>
              {one.view === undefined && one.error === undefined && <span className="pc-chip__state">传着</span>}
              {one.error !== undefined && <span className="pc-chip__state">{one.error}</span>}
              <button type="button" aria-label={`去掉 ${one.name}`} onClick={() => setChips((c) => ({ ...c, attachments: c.attachments.filter((a) => a.key !== one.key) }))}>×</button>
            </span>
          ))}
          {chips.refs.map((ref) => (
            <span key={`${ref.kind}-${ref.id}`} className="pc-chip" data-kind="ref"># {ref.title}
              <button type="button" aria-label={`不引用 ${ref.title}`} onClick={() => setChips((c) => ({ ...c, refs: c.refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) }))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="pc-row">
        <textarea
          ref={inputRef}
          className="pc-input ba-composer__input"
          rows={1}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={text}
          onChange={(e) => onChangeText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void submitDraft(draft); }
          }}
          {...(home ? { onFocus: () => setFocused(true), onBlur: () => setFocused(false) } : {})}
        />
        {!spec.plus && (
          <>
            {extra}
            {/* 发送中那颗键显示「···」(2026-09-27,卡 PS:会话卡里那个框也要看得出「在路上」—— 同首页那一颗)。 */}
            <button type="button" className="pc-send" aria-label="发送" disabled={!sendable} onClick={() => { void submitDraft(draft); }}>
              {sending ? <span aria-hidden="true">···</span> : <SendIcon />}
            </button>
          </>
        )}
      </div>
      {spec.plus && (
        <div className="pc-bar">
          <button type="button" className="pc-round" aria-label="添加" aria-expanded={sheet === 'plus' || sheet === 'refs'} onClick={() => open('plus')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className="pc-round pc-round--at" aria-label="交给谁" aria-expanded={sheet === 'at'} onClick={() => { setAtState(undefined); open('at'); }}>@</button>
          <button type="button" className="pc-pill" aria-label={`模式与模型:${pillText}`} aria-expanded={sheet === 'pills'} onClick={() => open('pills')}>
            <span>{pillText}</span>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="pc-spacer" />
          <span className="pc-keys">
            {talk && (
              <button
                type="button"
                className="pc-send pc-key pc-mic"
                aria-label="按住说话"
                {...(micOff ? { 'aria-disabled': true, title: micNote } : {})}
                data-off={micOff}
                data-recording={hold.recording}
                onPointerDown={onMicDown}
                onPointerMove={onMicMove}
                onPointerUp={onMicUp}
                onPointerCancel={onMicLost}
                onLostPointerCapture={onMicLost}
                onClick={onMicClick}
                onContextMenu={(e) => e.preventDefault()}
              ><StageIcon name="microphone" /></button>
            )}
            {key === 'call' && call !== undefined
              ? (
                <button
                  type="button"
                  className="pc-send pc-key pc-action"
                  data-key="call"
                  aria-label={call.label}
                  {...(call.title === undefined ? {} : { title: call.title })}
                  disabled={!call.ready}
                  onClick={() => call.onCall()}
                ><StageIcon name="phone" /></button>
              )
              : (
                <button type="button" className="pc-send pc-key pc-action" data-key="send" aria-label="发送" disabled={!sendable} onClick={() => { void submitDraft(draft); }}>
                  {sending ? <span aria-hidden="true">···</span> : <SendIcon />}
                </button>
              )}
          </span>
        </div>
      )}
      {spec.plus && (
        <input ref={fileRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { addFiles(filesOf(e.target.files)); e.target.value = ''; }} />
      )}
    </div>
  );

  return (
    <div className="pc" data-trim={trim}>
      {fxSpec === undefined ? box : <FxBeam name="composer" spec={fxSpec} active={glow && !hold.recording}>{box}</FxBeam>}
      {sheet !== undefined && (
        <>
          <div className="pc-scrim" onClick={() => setSheet(undefined)} aria-hidden="true" />
          <div className="pc-sheet" role="dialog" aria-label={sheet === 'at' ? '交给谁' : sheet === 'pills' ? '模式与模型' : sheet === 'refs' ? '引用' : '添加'}>
            {optionsNote !== undefined && sheet !== 'plus' && <p className="pc-sheet__note">{optionsNote}</p>}
            {sheet === 'plus' && (
              <>
                <button type="button" className="pc-item" onClick={() => { setSheet(undefined); fileRef.current?.click(); }}>
                  <span className="pc-item__title">加文件 / 照片</span><span className="pc-item__hint">也可以直接粘贴</span>
                </button>
                <button type="button" className="pc-item" onClick={() => setSheet('refs')}>
                  <span className="pc-item__title">引用一个事项或项目</span><span className="pc-item__hint">把它现在的状态一起交代过去</span>
                </button>
                <button type="button" className="pc-item" disabled>
                  <span className="pc-item__title">录音 / 会议</span><span className="pc-item__hint">首页右上角「会议」开一场</span>
                </button>
                <button type="button" className="pc-item" onClick={() => { setAtState(undefined); setSheet('at'); }}>
                  <span className="pc-item__title">指定谁来办</span><span className="pc-item__hint">也可以直接打 @</span>
                </button>
              </>
            )}
            {sheet === 'refs' && (options?.recent.length === 0
              ? <p className="pc-sheet__note">还没有能引用的事项或项目</p>
              : (options?.recent ?? []).map((ref) => (
                <button key={`${ref.kind}-${ref.id}`} type="button" className="pc-item" onClick={() => {
                  setChips((c) => (c.refs.some((r) => r.kind === ref.kind && r.id === ref.id) ? c : { ...c, refs: [...c.refs, { kind: ref.kind, id: ref.id, title: ref.title }] }));
                  setSheet(undefined);
                }}>
                  <span className="pc-item__title">{ref.kind === 'item' ? '事项' : '项目'} · {ref.title}</span>
                  {ref.note !== undefined && <span className="pc-item__hint">{ref.note}</span>}
                </button>
              )))}
            {sheet === 'at' && atList.map((agent, index) => (
              <button key={`${agent.family}:${agent.title}:${index}`} type="button" className="pc-item" data-ready={agent.ready} onMouseDown={(e) => e.preventDefault()} onClick={() => pickAgent(agent)}>
                <span className="pc-item__title">{agent.title}{agent.in_slot ? <span className="pc-tag">窗口槽里</span> : null}</span>
                <span className="pc-item__hint">{handLine(agent)}</span>
              </button>
            ))}
            {sheet === 'pills' && (
              <>
                <p className="pc-sheet__head">模式</p>
                {(options?.modes ?? []).map((one) => (
                  <button key={one.id} type="button" className="pc-item" aria-pressed={one.id === mode} onClick={() => pickMode(one.id)}>
                    <span className="pc-item__title">{one.title}</span><span className="pc-item__hint">{one.hint}</span>
                  </button>
                ))}
                <p className="pc-sheet__head">模型</p>
                {options?.models_note !== undefined && <p className="pc-sheet__note">{options.models_note}</p>}
                {(options?.models ?? []).map((one) => (
                  <button key={`${one.provider}/${one.id}`} type="button" className="pc-item" aria-pressed={one.id === model?.id && one.provider === model?.provider} onClick={() => pickModel(one)}>
                    <span className="pc-item__title">{one.id}</span><span className="pc-item__hint">{one.images ? '能直接看图' : '只看文字(照片给它路径)'}</span>
                  </button>
                ))}
                <button type="button" className="pc-done" onClick={() => setSheet(undefined)}>好了</button>
              </>
            )}
          </div>
        </>
      )}
      {talk && (
        <VoiceRecordOverlay
          visible={hold.recording || hold.transcribing}
          elapsedMs={hold.elapsedMs}
          cancelHint={hold.cancelHint}
          transcribing={hold.transcribing}
          level={hold.level}
        />
      )}
    </div>
  );
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
}
