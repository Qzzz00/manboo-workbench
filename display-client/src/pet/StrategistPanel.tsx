// 掌机底条的 Figma 控制面板与军师聊天面板。
// 控制区需要整窗可触；聊天区同时保留主线已有的 Markdown 清理和跟随朗读滚动。

import { useEffect, useRef, useState } from 'react';

import { stripMarkdown } from '../lib/strategist/markdown.ts';
import type { StrategistState } from './strategistSession.ts';
import {
  HANDHELD_FIGMA_ASSETS,
  handheldStripControlsForState,
  handheldStripTouchAction,
  statusBubblesForState,
  stripFallbackPrefix,
  type StripControlKind,
} from './handheldStripUi.ts';

/** 把 speaker 在原始流里的计数映射到清理后的正文下标。 */
export function spokenCursor(raw: string, body: string, spokenChars: number): number {
  const removed = Math.max(0, raw.length - body.length);
  return Math.min(Math.max(spokenChars - removed, 0), body.length);
}

type NativePanel = { setPanelTouchable: (touchable: boolean) => void };
type NativeStrip = { openSettings?: () => void; exitGame?: () => void };

type Props = {
  state: StrategistState;
  spokenChars?: number;
  chatOpen?: boolean;
  onOpenChat?: () => void;
  onExitChat?: () => void;
  onOpenSettings?: () => void;
  onExitGame?: () => void;
};

function tapStrategist(kind: string) {
  (window as unknown as { __strategistTap?: (kind: string) => void }).__strategistTap?.(kind);
}

function nativeStrip() {
  return (window as unknown as { AibooHandheldStrip?: NativeStrip }).AibooHandheldStrip;
}

function useMinuteTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function StrategistPanel({
  state,
  spokenChars = 0,
  chatOpen = false,
  onOpenChat,
  onExitChat,
  onOpenSettings,
  onExitGame,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLSpanElement | null>(null);
  const [handOver, setHandOver] = useState(false);
  const time = useMinuteTime();

  const rawAnswer = state.kind === 'answering' || state.kind === 'done' ? state.text : '';
  const { body: answerRaw, fallback } = stripFallbackPrefix(rawAnswer);
  const answer = stripMarkdown(answerRaw);
  const transcript = 'transcript' in state ? state.transcript : undefined;
  const cursor = spokenCursor(rawAnswer, answer, spokenChars);

  useEffect(() => {
    if (!answer) setHandOver(false);
  }, [answer]);

  // Figma 版底条的三个按钮和 PTT 都在 DOM 中，整条 WebView 必须保持可触。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const native = (window as unknown as { AibooStrategistPanel?: NativePanel })
      .AibooStrategistPanel;
    native?.setPanelTouchable(true);
    return () => native?.setPanelTouchable(false);
  }, []);

  // 文字按实际朗读进度移动；用户主动滑动后，本轮不再抢滚动位置。
  useEffect(() => {
    if (!chatOpen || handOver || cursor <= 0) return;
    cursorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [answer, chatOpen, cursor, handOver]);

  function runControl(kind: StripControlKind) {
    if (kind === 'chat') {
      onOpenChat?.();
      return;
    }
    if (kind === 'settings') {
      onOpenSettings?.();
      nativeStrip()?.openSettings?.();
      return;
    }
    onExitGame?.();
    nativeStrip()?.exitGame?.();
  }

  if (!chatOpen) {
    return (
      <div className="pet-strip-panel pet-strip-panel--controls">
        <div className="pet-strip-controls">
          {handheldStripControlsForState().map((item) => (
            <button
              key={item.kind}
              type="button"
              className="pet-strip-control"
              onClick={() => runControl(item.kind)}
            >
              <img src={item.icon} alt="" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="pet-strip-statusbar" aria-label={`电量 78%，${time}`}>
          <span className="pet-strip-statusitem">
            <img src={HANDHELD_FIGMA_ASSETS.stripBattery} alt="" />
            <span>78%</span>
          </span>
          <span>{time}</span>
        </div>
      </div>
    );
  }

  const ptt = handheldStripTouchAction(state);
  const bubbles = answer
    ? [
        ...(transcript ? [{ role: 'user' as const, text: transcript }] : []),
        { role: 'assistant' as const, text: answer, fallback },
      ]
    : statusBubblesForState(state);

  return (
    <div className="pet-strip-panel pet-strip-panel--chat">
      <div className="pet-strip-chatlog" ref={scrollRef}>
        {bubbles.map((bubble, index) => {
          const trackedAnswer = bubble.role === 'assistant' && Boolean(answer);
          return (
            <div
              key={`${bubble.role}-${index}`}
              className={`pet-strip-chatrow pet-strip-chatrow--${bubble.role}`}
            >
              <div
                className={[
                  'pet-strip-bubble',
                  bubble.role === 'user' ? 'pet-strip-bubble--user' : null,
                  state.kind === 'error' ? 'pet-strip-bubble--err' : null,
                ].filter(Boolean).join(' ')}
                onPointerDown={trackedAnswer ? () => setHandOver(true) : undefined}
              >
                {bubble.fallback ? <span className="pet-strip-badge">网上搜的</span> : null}
                {trackedAnswer ? (
                  <>
                    {answer.slice(0, cursor)}
                    <span className="pet-strip-cursor" ref={cursorRef} aria-hidden="true" />
                    {answer.slice(cursor)}
                  </>
                ) : bubble.text}
              </div>
            </div>
          );
        })}
      </div>
      <div className="pet-strip-chat-actions">
        <button
          type="button"
          className="pet-strip-exit-chat"
          onClick={() => {
            tapStrategist('tap');
            onExitChat?.();
          }}
        >
          退出聊天
        </button>
        <button
          type="button"
          className="pet-strip-ptt"
          onPointerDown={(event) => {
            event.preventDefault();
            tapStrategist('holdStart');
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            tapStrategist('holdEnd');
          }}
          onPointerCancel={() => tapStrategist('holdEnd')}
          onPointerLeave={(event) => {
            if (event.buttons) tapStrategist('holdEnd');
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {ptt.mode === 'waveform' && ptt.waveform ? (
            <img className="pet-strip-waveform" src={ptt.waveform} alt={ptt.label} />
          ) : (
            ptt.label
          )}
        </button>
      </div>
    </div>
  );
}
