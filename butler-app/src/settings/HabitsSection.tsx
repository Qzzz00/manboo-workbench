/**
 * 手机设置里的「它学到了什么」(2026-10-09;desktop-workbench docs/设计-事务官从她的行为里学-2026-10-09.md 第三节第 4 条)。
 *
 * 与电脑设置里那一节(workbench-plugin/src/client/HabitsPanel.tsx)是**同一页**:读 `GET /habits`,
 * 撤掉打 `POST /habits/revoke`(8791 那边只认她本人,配对过的手机算),进化日志读 `GET /evolve/log` 只给摘要。
 * 出了局域网走房间代理,白名单在 channel-worker/src/rpc.ts。
 *
 * **按通用形状显示,不按种类写死**:学风格那一侧会加新种类;种类名用接口给的 `kind_title`,缺了有兜底。
 * 不露内部的东西:不显示 id、接口路径。
 */
import { useEffect, useState } from 'react';
import { useSession } from '../session';

/** 与 workbench-plugin/src/protocol.ts 的 HabitView 同形(两个仓库不互相 import)。`kind` 不收窄:新种类照样收。 */
export interface PhoneHabitView {
  id: string;
  kind: string;
  kind_title?: string;
  text: string;
  status: 'trial' | 'kept' | 'reverted' | 'removed';
  evidence: readonly { at: string; what: string; said?: string }[];
  applied: number;
  adopted_at: string;
  updated_at: string;
  verdict?: string;
}

export interface PhoneHabitsView {
  trial: readonly PhoneHabitView[];
  kept: readonly PhoneHabitView[];
  retired: readonly PhoneHabitView[];
}

export const PHONE_HABITS_EMPTY_NOTE = '还在攒记录,同一种情况出现两次以上才会开始试用。';
export const PHONE_HABIT_KIND_FALLBACK = '别的习惯';

function isHabitsView(body: unknown): body is PhoneHabitsView {
  if (typeof body !== 'object' || body === null) return false;
  const raw = body as Record<string, unknown>;
  return Array.isArray(raw.trial) && Array.isArray(raw.kept) && Array.isArray(raw.retired);
}

function kindTitle(habit: PhoneHabitView): string {
  return typeof habit.kind_title === 'string' && habit.kind_title.trim() !== '' ? habit.kind_title : PHONE_HABIT_KIND_FALLBACK;
}

function stamp(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return at.slice(0, 16);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
}

/** 每条底下那一小行(口径同电脑那一页的 habitSinceLine)。 */
export function phoneHabitSince(habit: PhoneHabitView): string {
  const parts = [`${stamp(habit.adopted_at)} 开始试用`];
  parts.push(habit.applied > 0 ? `用上 ${habit.applied} 次` : '还没用上');
  const why = habit.verdict === undefined || habit.verdict === '' ? '' : `:${habit.verdict}`;
  if (habit.status === 'kept') parts.push(`留下了${why}`);
  else if (habit.status === 'removed') parts.push(`你撤掉的${why}`);
  else if (habit.status === 'reverted') parts.push(`你纠正了,自动撤了${why}`);
  return parts.join(' · ');
}

const LOG_VERDICT = /^- \*\*(留下|撤了[^*]*|她撤掉了|她恢复了|已撤)\*\*/u;
const LOG_ID = /[((]\s*(?:习惯|提议) id `[^`]*`\s*[))]/gu;

/** 进化日志 → 最近几段的摘要,新的在前(同电脑那一页的 evolveLogDigest)。 */
export function phoneEvolveLogDigest(text: string, limit: number): { title: string; latest?: string }[] {
  return text.split(/^## /mu).slice(1).map((chunk) => {
    const lines = chunk.split('\n');
    const title = (lines[0] ?? '').trim();
    // 一段底下的结论新的在上(工作台 annotateLog 插在 id 那一行正下方),取第一句。
    const verdict = lines.find(line => LOG_VERDICT.test(line));
    const latest = verdict?.replace(/^- /u, '').replace(/\*\*/gu, '').replace(LOG_ID, '').trim();
    return latest === undefined || latest === '' ? { title } : { title, latest };
  }).filter(one => one.title !== '').slice(-limit).reverse();
}

const SEGMENTS: readonly { key: keyof PhoneHabitsView; title: string; note: string }[] = [
  { key: 'trial', title: '正在试用', note: '下一次同类的事你没纠正就留下,纠正了自动撤。' },
  { key: 'kept', title: '已经留下', note: '验过了,照这样做。' },
  { key: 'retired', title: '撤掉的', note: '撤掉的不会再自己学回来;撤错了点「恢复」,重新试用。' },
];

type LogState = { kind: 'closed' } | { kind: 'ok'; entries: { title: string; latest?: string }[] } | { kind: 'none'; note: string };

export function HabitsSection() {
  const session = useSession();
  const [view, setView] = useState<PhoneHabitsView | null>(null);
  const [off, setOff] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [log, setLog] = useState<LogState>({ kind: 'closed' });

  async function reload(): Promise<void> {
    const result = await session.client.json<unknown>('/habits');
    if (!result.ok) { setOff(true); return; }
    if (isHabitsView(result.data)) { setView(result.data); setOff(false); }
  }

  useEffect(() => { void reload(); }, [session]);

  // 老工作台没有这一页(404 / 连不上):整节不出现。
  if (off || view === null) return null;

  async function post(path: '/habits/revoke' | '/habits/restore', id: string): Promise<void> {
    setBusy(true);
    setNote(null);
    setConfirming(null);
    const result = await session.client.json<{ ok?: boolean; note?: string; error?: string }>(path, { method: 'POST', body: { id } });
    setNote(result.ok ? (result.data?.note ?? (path === '/habits/revoke' ? '撤掉了。' : '恢复了。')) : result.error);
    await reload();
    setBusy(false);
  }

  async function toggleLog(): Promise<void> {
    if (log.kind !== 'closed') { setLog({ kind: 'closed' }); return; }
    const result = await session.client.json<{ text?: unknown }>('/evolve/log');
    if (!result.ok) {
      setLog({ kind: 'none', note: result.status === 404 ? '还没有进化日志:还没有哪一条开始试用过。' : '进化日志这会儿读不到。' });
      return;
    }
    const text = result.data?.text;
    setLog(typeof text === 'string' ? { kind: 'ok', entries: phoneEvolveLogDigest(text, 8) } : { kind: 'none', note: '进化日志这会儿读不到。' });
  }

  const empty = view.trial.length + view.kept.length + view.retired.length === 0;
  return (
    <section className="ba-settings__sec" aria-label="它学到了什么">
      <h2 className="ba-inbox__h">它学到了什么</h2>
      <p className="ba-settings__line ba-settings__dim">
        从你平时怎么派活、几点接电话、点不点头里数出来的做法。同一种情况出现两次以上先试用,你没纠正就留下,纠正了自动撤;随时能撤。
        花钱、对外说的话、改你的习惯、要你亲手做的,永远先问你。你明说的规矩在上面那一节。
      </p>
      {empty && <p className="ba-settings__line ba-settings__dim">{PHONE_HABITS_EMPTY_NOTE}</p>}
      {SEGMENTS.map(segment => (
        <div key={segment.key} className="ba-habits__seg">
          <h3 className="ba-habits__h">{`${segment.title}(${view[segment.key].length})`}</h3>
          <p className="ba-settings__line ba-settings__dim">{segment.note}</p>
          {view[segment.key].map(habit => (
            <div className="ba-settings__line ba-habit" key={habit.id} data-habit-status={habit.status}>
              <span className="ba-habit__kind">{kindTitle(habit)}</span>
              <span className="ba-habit__text">{habit.text}</span>
              {habit.evidence.length > 0 && (
                <ul className="ba-habit__why" aria-label="依据">
                  {habit.evidence.map((one, index) => (
                    <li key={`${one.at}-${index}`}>
                      {one.what}
                      {one.said !== undefined && one.said !== '' && ` —— 你的原话「${one.said}」`}
                    </li>
                  ))}
                </ul>
              )}
              <span className="ba-settings__dim">{phoneHabitSince(habit)}</span>
              {segment.key === 'retired' && (
                <span className="ba-row">
                  <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void post('/habits/restore', habit.id); }}>恢复</button>
                </span>
              )}
              {segment.key !== 'retired' && (
                <span className="ba-row">
                  {confirming === habit.id
                    ? (
                        <>
                          <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void post('/habits/revoke', habit.id); }}>确定撤掉(不会再自己学回来)</button>
                          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setConfirming(null)}>算了</button>
                        </>
                      )
                    : <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => setConfirming(habit.id)}>撤掉</button>}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
      <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void toggleLog(); }}>
        {log.kind === 'closed' ? '看进化日志(最近几条)' : '收起进化日志'}
      </button>
      {log.kind === 'none' && <p className="ba-settings__line ba-settings__dim">{log.note}</p>}
      {log.kind === 'ok' && (
        <ul className="ba-habit__why">
          {log.entries.map((entry, index) => (
            <li key={`${entry.title}-${index}`} className="ba-habit__log">
              <span>{entry.title}</span>
              {entry.latest !== undefined && <span className="ba-settings__dim">{entry.latest}</span>}
            </li>
          ))}
        </ul>
      )}
      {note !== null && <p className="ba-settings__line ba-settings__dim" role="status">{note}</p>}
    </section>
  );
}
