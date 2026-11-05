/**
 * 看一场整理好的会(2026-10-13,卡「会议页不再空着」)。维护者原话:
 * 「会议里要有一些方便演示的历史会议案例,一样按照会前会中会后三个来看」。
 *
 * 三个页签,**默认停在会后**(刚开完会、或者从列表里点开一场,人要看的是纪要与待办):
 *
 * - **会前**:她登记那一句、五问画像(每一答带出处)、预案卡。没登记过的那一场照实说没有。
 * - **会中**:录了多久 / 几段;转写里的时间戳摆成一条线。**会中记号这一版没有**,所以这里
 *   明写「这是转写自己带的时间」——不让人以为是她在会上记的。
 * - **会后**:纪要原文、待办(勾着建成事项)、拿不准的、会后那一句「要定的定下来没有」。
 *
 * 这一块只管**显示与勾选**:请求都在会议页那边(同一组 `GET /meeting?id=` / `/meeting/apply` /
 * `/meeting/retry` / `/meeting/outcome`),所以这里一个 fetch 都没有。
 */
import { useState } from 'react';
import type { MeetingDetail } from './meetingApi';
import {
  MEETING_DEMO_TAG,
  MEETING_NO_PREP_TEXT,
  MEETING_NO_TIMELINE_TEXT,
  MEETING_RETRY_LABEL,
  MEETING_TABS,
  MEETING_TIMELINE_NOTE,
  meetingDuringLine,
  type MeetingTab,
} from './meetingModel';
import { MeetingPrepCardList, MeetingPrepFacts } from './MeetingPrepPanel';

const OUTCOME_KEYS = [['yes', '定下来了'], ['partly', '定了一部分'], ['no', '没定下来']] as const;

export interface MeetingReviewProps {
  detail: MeetingDetail;
  /** 建事项:回 true 才把勾清掉(没成的那一下保留她勾的那几条)。 */
  onApply: (ids: readonly string[]) => Promise<boolean>;
  /** 会后那一句。回 true 才把补的那句清掉。 */
  onOutcome: (settled: 'yes' | 'partly' | 'no', said: string) => Promise<boolean>;
  onRetry: () => void;
  onLeave: () => void;
  leaveLabel: string;
}

export function MeetingReview({ detail, onApply, onOutcome, onRetry, onLeave, leaveLabel }: MeetingReviewProps) {
  const [tab, setTab] = useState<MeetingTab>('after');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState('');

  return (
    <div className="ba-meeting__result">
      <div className="ba-meeting__tabs" role="tablist" aria-label="这一场会">
        {MEETING_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="ba-meeting__tab"
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </div>
      {detail.demo === true && <p className="ba-meeting__hint ba-meeting__hint--dim">{`${MEETING_DEMO_TAG}:这一场是放进来的虚构样例,不是真开过的会。`}</p>}

      {tab === 'before' && (
        detail.prep === undefined
          ? <p className="ba-meeting__hint">{MEETING_NO_PREP_TEXT}</p>
          : (
            <>
              <h2 className="ba-meeting__h">登记时你说的那一句</h2>
              <blockquote className="ba-meeting__quote">{detail.prep.said}</blockquote>
              {detail.prep.when !== undefined && <p className="ba-meeting__hint">{detail.prep.when}</p>}
              <MeetingPrepFacts prep={detail.prep} />
              <MeetingPrepCardList prep={detail.prep} />
              {detail.prep.card === undefined && <p className="ba-meeting__hint">{detail.prep.card_error ?? '这一场没有预案卡。'}</p>}
            </>
          )
      )}

      {tab === 'during' && (
        <>
          <p className="ba-meeting__status">{meetingDuringLine(detail)}</p>
          <h2 className="ba-meeting__h">时间线</h2>
          {detail.timeline === undefined || detail.timeline.length === 0
            ? <p className="ba-meeting__hint">{MEETING_NO_TIMELINE_TEXT}</p>
            : (
              <ol className="ba-meeting__line" aria-label="时间线">
                {detail.timeline.map(mark => (
                  <li key={`${mark.at}-${mark.text}`}>
                    <span className="ba-meeting__at">{mark.at}</span>
                    <span>{mark.text}</span>
                  </li>
                ))}
              </ol>
            )}
          <p className="ba-meeting__hint ba-meeting__hint--dim">{MEETING_TIMELINE_NOTE}</p>
        </>
      )}

      {tab === 'after' && (
        <>
          {detail.error !== undefined && <p className="ba-meeting__warn">{detail.error}</p>}
          {detail.retryable === true && <button type="button" className="ba-btn ba-btn--ghost" onClick={onRetry}>{MEETING_RETRY_LABEL}</button>}
          {detail.summary === undefined
            ? <p className="ba-meeting__status">转写好了,但这一场没有纪要(上面那句说了为什么)。</p>
            : <pre className="ba-meeting__notes">{detail.summary}</pre>}

          <h2 className="ba-meeting__h">待办</h2>
          {detail.todos.length === 0
            ? <p className="ba-meeting__hint">这一场没梳理出待办。</p>
            : (
              <>
                <ul className="ba-meeting__todos">
                  {detail.todos.map(todo => (
                    <li key={todo.id}>
                      <label>
                        <input
                          type="checkbox"
                          disabled={todo.task_id !== undefined}
                          checked={todo.task_id !== undefined || picked.has(todo.id)}
                          onChange={(e) => {
                            setPicked((old) => {
                              const next = new Set(old);
                              if (e.target.checked) next.add(todo.id); else next.delete(todo.id);
                              return next;
                            });
                          }}
                        />
                        <span className="ba-meeting__what">{todo.what}</span>
                        {/* 「谁」听不出来就明写「没说谁」—— 留空会被当成排版漏了(D13 同款) */}
                        <span className="ba-meeting__who">{todo.who ?? '没说谁'}</span>
                        {todo.due !== undefined && <span className="ba-meeting__due">{todo.due}</span>}
                        {todo.task_id !== undefined && <span className="ba-meeting__made">已建</span>}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="ba-meeting__keys">
                  <button
                    type="button"
                    className="ba-btn"
                    disabled={detail.todos.every(todo => todo.task_id !== undefined)}
                    onClick={() => { void onApply([]).then((ok) => { if (ok) setPicked(new Set()); }); }}
                  >都建</button>
                  <button
                    type="button"
                    className="ba-btn ba-btn--ghost"
                    disabled={picked.size === 0}
                    onClick={() => { void onApply([...picked]).then((ok) => { if (ok) setPicked(new Set()); }); }}
                  >{`建选中的 ${picked.size} 条`}</button>
                </div>
              </>
            )}

          {detail.unsure.length > 0 && (
            <>
              <h2 className="ba-meeting__h">事务官拿不准的</h2>
              <ul className="ba-meeting__unsure">
                {detail.unsure.map(one => <li key={one}>{one}</li>)}
              </ul>
            </>
          )}

          {/* 会后那一句(2026-10-10):登记时要定的那件事,定下来没有 —— 先存好,给以后的会议学习用。 */}
          {detail.prep?.goal !== undefined && detail.outcome === undefined && (
            <div className="ba-meeting__ask">
              <p className="ba-meeting__status">{`这场要定「${detail.prep.goal.value}」,定下来了吗?`}</p>
              <input className="ba-input" aria-label="想补一句(可以不填)" placeholder="想补一句(可以不填)" value={said} onChange={e => setSaid(e.target.value)} />
              <div className="ba-meeting__keys">
                {OUTCOME_KEYS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className="ba-btn ba-btn--ghost"
                    onClick={() => { void onOutcome(key, said).then((ok) => { if (ok) setSaid(''); }); }}
                  >{label}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {detail.dir !== undefined && <p className="ba-meeting__hint ba-meeting__hint--dim">{`转写与纪要在电脑上的 ${detail.dir}`}</p>}
      <div className="ba-meeting__keys">
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onLeave}>{leaveLabel}</button>
      </div>
    </div>
  );
}
