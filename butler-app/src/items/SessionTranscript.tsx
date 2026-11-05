/**
 * 点开一条对话看完整内容(2026-10-01,手机读对话卡 B;维护者:「只有最近一轮我说的和一轮 AI 说的,往上就没了」)。
 *
 * 问电脑要 `GET /sessions/transcript`:先给最新那几轮,**往上滑到顶就接着要更早的**(游标 `before`),一直到开头;
 * 她看着的时候对话还在长 → 那条会话一动(`beat`)就只刷新最新那一段(`from=` 最新一页的起点),和翻上去的那几页接得上。
 * 文字不截断,AI 那句按 Markdown 显示;工具调用折成一行,点开看每步的说明与文件名。
 * 电脑是旧版(没有这条路)→ `unsupported`,外面退回原来那几轮摘要。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import type { SessionAttachmentRef, SessionTranscriptEntry, SessionTranscriptView } from '../api/protocol';
import { formatClock } from '../hooks';
import { Markdown } from '../ui/Markdown';

/** 已经读到的一段:从 `start` 那一行起(缺席 = 文件开头)。 */
interface Segment {
  start?: string;
  entries: SessionTranscriptEntry[];
}

type Load = { ok: true; view: SessionTranscriptView } | { ok: false; status: number; error: string };

interface TranscriptWire {
  agent?: unknown;
  session_id?: unknown;
  title?: unknown;
  before?: unknown;
  read_at?: unknown;
  entries?: unknown;
  turns?: unknown;
}

async function loadTranscript(client: ApiClient, agent: string, id: string, cursor: { before?: string; from?: string } = {}): Promise<Load> {
  const res = await client.json<TranscriptWire>(`/sessions/transcript?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(id)}&before=${encodeURIComponent(cursor.before ?? '')}&from=${encodeURIComponent(cursor.from ?? '')}`);
  if (res.ok && res.data !== undefined) {
    const wire = res.data;
    if (wire.agent !== agent || wire.session_id !== id || typeof wire.read_at !== 'string') return { ok: false, status: 0, error: '电脑回的不是这条会话记录' };
    const entries = Array.isArray(wire.entries)
      ? wire.entries as SessionTranscriptEntry[]
      : Array.isArray(wire.turns)
        ? wire.turns.flatMap((value): SessionTranscriptEntry[] => {
            if (value === null || typeof value !== 'object') return [];
            const turn = value as { k?: unknown; text?: unknown; at?: unknown };
            if ((turn.k !== 'ask' && turn.k !== 'reply') || typeof turn.text !== 'string') return [];
            return [{ k: turn.k, text: turn.text, ...(typeof turn.at === 'string' ? { at: turn.at } : {}) }];
          })
        : undefined;
    if (entries !== undefined) return { ok: true, view: {
      agent, session_id: id, entries, read_at: wire.read_at,
      ...(typeof wire.title === 'string' ? { title: wire.title } : {}),
      ...(typeof wire.before === 'string' ? { before: wire.before } : {}),
    } };
  }
  if (res.ok) return { ok: false, status: 0, error: '电脑回的对话认不出' };
  return { ok: false, status: res.status, error: res.error };
}

export interface TranscriptState {
  entries: SessionTranscriptEntry[];
  /** 上面还有更早的。 */
  more: boolean;
  loading: boolean;
  error?: string;
  /** 电脑是旧版,没有这条路。 */
  unsupported: boolean;
  title?: string;
  loadOlder(): void;
}

export function useTranscript(client: ApiClient, agent: string, sessionId: string, beat: string): TranscriptState {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [top, setTop] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [unsupported, setUnsupported] = useState(false);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const busy = useRef(false);
  const newest = useRef<{ start?: string } | undefined>(undefined);

  // 第一次:最新那几轮。
  useEffect(() => {
    let alive = true;
    newest.current = undefined;
    setSegments([]);
    setLoaded(false);
    if (sessionId === '') { setLoading(false); return; }
    setLoading(true);
    void loadTranscript(client, agent, sessionId).then((got) => {
      if (!alive) return;
      if (got.ok) {
        const start = got.view.before;
        newest.current = start === undefined ? {} : { start };
        setSegments([{ ...(start === undefined ? {} : { start }), entries: got.view.entries }]);
        setTop(start);
        setTitle(got.view.title);
        setError(undefined);
        setLoaded(true);
      }
      else {
        setUnsupported(got.status === 404 && /没这条路|未接线/.test(got.error));
        setError(got.error);
      }
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : '连不上工作台'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, agent, sessionId]);

  // 那条会话动了:只刷新最新那一段(起点不变,新的几轮接在后面)。
  useEffect(() => {
    if (!loaded || newest.current === undefined) return;
    let alive = true;
    const start = newest.current.start;
    void loadTranscript(client, agent, sessionId, { from: start ?? '0' }).then((got) => {
      if (!alive || !got.ok) return;
      setSegments((prior) => prior.length === 0 ? prior : [...prior.slice(0, -1), { ...(start === undefined ? {} : { start }), entries: got.view.entries }]);
    }).catch(() => {});
    return () => { alive = false; };
    // 只跟着 beat 走:第一次读完(loaded 变了)那一下不重读。
  }, [beat]);

  const loadOlder = useCallback(() => {
    if (top === undefined || busy.current) return;
    busy.current = true;
    setLoading(true);
    const before = top;
    void loadTranscript(client, agent, sessionId, { before }).then((got) => {
      if (got.ok) {
        const start = got.view.before;
        setSegments((prior) => [{ ...(start === undefined ? {} : { start }), entries: got.view.entries }, ...prior]);
        setTop(start);
      }
      else setError(got.error);
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : '连不上工作台')).finally(() => {
      busy.current = false;
      setLoading(false);
    });
  }, [client, agent, sessionId, top]);

  return {
    entries: segments.flatMap((segment) => segment.entries),
    more: loaded && top !== undefined,
    loading,
    ...(error === undefined ? {} : { error }),
    unsupported,
    ...(title === undefined ? {} : { title }),
    loadOlder,
  };
}

function Steps({ entry }: { entry: Extract<SessionTranscriptEntry, { k: 'steps' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ba-tx__steps">
      <button type="button" className="ba-tx__steps-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {entry.line}{entry.steps.length > 0 && <span aria-hidden>{open ? ' ▾' : ' ▸'}</span>}
      </button>
      {open && entry.steps.length > 0 && (
        <ol className="ba-tx__step-list">
          {entry.steps.map((step, index) => (
            <li key={index}>
              <span>{step.line}</span>
              {step.detail !== undefined && <span className="ba-tx__step-detail">{step.detail}</span>}
              {step.files !== undefined && <span className="ba-tx__step-files">{step.files.join('、')}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function TranscriptView({ state, name, now, renderAttachments }: {
  state: TranscriptState;
  /** 那一家叫什么(AI 那句前面那个小字)。 */
  name: string;
  /**
   * 每一句后面那个时刻照谁的钟写「今天」(2026-10-02,卡 claude/phone-clock):**电脑的**,
   * 即 `/state.now`。这一份只拿到 `client` 与读出来的那几段,手上没有 `state`,
   * 所以 `now` 由摆它的那一页传进来(会话详情);不许在这里摸手机自己的墙钟(口径见 src/clock.ts)。
   */
  now: string;
  /** 附件那一排(卡 C);缺席就不画。 */
  renderAttachments?: (refs: readonly SessionAttachmentRef[]) => ReactNode;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const topSentinel = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<SessionTranscriptEntry | undefined>(undefined);

  // 新的接在下面:她在最底下就跟着滚到底;往上翻接上来的那一段不让画面跳(保住她正在看的那一行)。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const first = state.entries[0];
    if (prevFirst.current !== undefined && first !== prevFirst.current && prevHeight.current > 0) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    }
    else if (stick.current) el.scrollTop = el.scrollHeight;
    prevHeight.current = el.scrollHeight;
    prevFirst.current = first;
  }, [state.entries]);

  // 滑到顶就接着要更早的(看得见顶上那一条线就算到顶)。
  useEffect(() => {
    const el = topSentinel.current;
    if (el === null || typeof IntersectionObserver === 'undefined' || !state.more) return;
    const observer = new IntersectionObserver((seen) => { if (seen.some((one) => one.isIntersecting)) state.loadOlder(); }, { root: scroller.current });
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.more, state.loadOlder]);

  return (
    <div
      className="ba-tx"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div ref={topSentinel} className="ba-tx__top">
        {state.more
          ? <button type="button" className="ba-btn ba-btn--ghost" disabled={state.loading} onClick={state.loadOlder}>{state.loading ? '正在读更早的…' : '再往上看'}</button>
          : state.entries.length > 0 && <p className="ba-sheet__hint">这就是开头了</p>}
      </div>
      {state.error !== undefined && <p className="ba-sheet__hint" role="status">{state.error}</p>}
      {state.entries.length === 0 && state.error === undefined && <p className="ba-sheet__hint" role="status">{state.loading ? '正在读这条对话…' : '这条对话里还没有能给你看的内容。'}</p>}
      <ol className="ba-tx__list" aria-label="完整对话">
        {state.entries.map((entry, index) => (
          <li key={index} className={`ba-tx__item ba-tx__item--${entry.k}`} {...(entry.k === 'note' ? { 'data-tone': entry.tone } : {})}>
            {entry.k === 'ask' && (
              <>
                <small className="ba-tx__who">你{entry.at === undefined ? '' : ` · ${formatClock(entry.at, now)}`}</small>
                {entry.text !== '' && <p className="ba-tx__ask-text">{entry.text}</p>}
              </>
            )}
            {entry.k === 'reply' && (
              <>
                <small className="ba-tx__who">{name}{entry.at === undefined ? '' : ` · ${formatClock(entry.at, now)}`}</small>
                <Markdown text={entry.text} />
                {entry.clipped === true && <p className="ba-sheet__hint">这一段太长,这里只显示了前面一部分;完整的到电脑上看。</p>}
              </>
            )}
            {entry.k === 'steps' && <Steps entry={entry} />}
            {entry.k === 'note' && <p className="ba-tx__note">{entry.text}</p>}
            {entry.k !== 'note' && entry.attachments !== undefined && entry.attachments.length > 0 && renderAttachments?.(entry.attachments)}
          </li>
        ))}
      </ol>
    </div>
  );
}
