/**
 * 对话记录列表(气泡流)。2026-09-17 从当时的对话页 ChatPage 原样搬出来一份(markup、类名、空态一个字没改),
 * 好让舞台页的「记录」面板有一份记录视图可用。ChatPage 本身在整合底部键那张卡里删掉了,这份列表是它留下的东西。
 */
import type { WorkbenchState } from '../api/protocol';
import type { RefObject } from 'react';
import { formatClock } from '../hooks';
import { RECEIPT_TEXT, type ThreadMessage } from './chatModel';
import { SayDecisionCards } from './SayDecisionCards';

export interface ThreadListProps {
  thread: readonly ThreadMessage[];
  /** 语音不可用时不画「重听」。 */
  voiceOff: boolean;
  /**
   * 每条气泡上那个时刻照谁的钟写「今天」(2026-10-02,卡 claude/phone-clock):**电脑的**,
   * 即 `/state.now`。这份列表是纯组件、手上没有 `state`,所以 `now` 由摆它的那一页传进来
   * (舞台页的记录面板),不许在这里摸手机自己的墙钟 —— 口径见 src/clock.ts。
   */
  now: string;
  onReplay?(message: ThreadMessage): void;
  /** 「没送到」那一句点「重发」(2026-10-12):带原来那个请求号再发,电脑办过的不办第二次。 */
  onResend?(localId: string): void;
  /** 电脑答了不行的那一句点「收起」。 */
  onDismiss?(localId: string): void;
  onSayChoice?(message: ThreadMessage, choice: string, askId?: string, suggestId?: string, decidedId?: string): void;
  sayBusy?: boolean;
  sayState?: Pick<WorkbenchState, 'tasks'>;
  listRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}

export function ThreadList({ thread, voiceOff, now, onReplay, onResend, onDismiss, onSayChoice, sayState, sayBusy = false, listRef, className = 'ba-chat__thread' }: ThreadListProps) {
  return (
    <div className={className} ref={listRef}>
      {thread.length === 0 && <p className="ba-chat__empty">把要办的事说给事务官听,一句一件。</p>}
      {thread.map((m) => (
        <div className="ba-msg" key={m.taskId ?? m.localId}>
          <div className="ba-bubble ba-bubble--me">
            <p>{m.user}</p>
            <span className="ba-bubble__time">{formatClock(m.at, now)}</span>
          </div>
          <div className={`ba-bubble ba-bubble--butler ba-bubble--${m.butler.kind}`}>
            <p>{m.butler.text}</p>
            {m.butler.kind === 'reply' && !voiceOff && onReplay !== undefined && (
              <button type="button" className="ba-bubble__replay" onClick={() => onReplay(m)} aria-label="重听">🔊</button>
            )}
          </div>
          {m.sayCards !== undefined && <SayDecisionCards payload={m.sayCards} state={sayState} busy={sayBusy} onChoose={(choice, askId, suggestId, decidedId) => onSayChoice?.(m, choice, askId, suggestId, decidedId)} />}
          {/* 回执三档(2026-10-12,卡「手机交代只执行一次」):没送到 / 送到了 · 在等 / 办完了。 */}
          {m.receipt !== undefined && (
            <p className="ba-receipt" data-receipt={m.receipt} role="status">
              {RECEIPT_TEXT[m.receipt]}
              {m.receipt === 'unsent' && m.localId !== undefined && onResend !== undefined && (
                <button type="button" className="ba-receipt__act" onClick={() => onResend(m.localId!)}>重发</button>
              )}
            </p>
          )}
          {m.receipt === undefined && m.butler.kind === 'error' && m.taskId === undefined && m.localId !== undefined && onDismiss !== undefined && (
            <p className="ba-receipt" data-receipt="rejected">
              <button type="button" className="ba-receipt__act" onClick={() => onDismiss(m.localId!)}>收起</button>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
