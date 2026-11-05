import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DjModeView } from '../../hooks/useDjMode';
import type { CommuteTopic } from '../../screensaver/lib/djClient';

/**
 * 通勤播客视图（无 Live2D）：话题卡片纵向滚动，播客讲到哪条，哪张卡片就滚到正中（唱片机式）。
 * 点卡片看详情/原文。底部播放控制由 DjMode 收起为最小化。
 */
export function CommutePodcastView({ view }: { view: DjModeView }) {
  const topics = view.dj.topics ?? [];
  const currentTopicId = view.dj.currentTopicId ?? null;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [openTopic, setOpenTopic] = useState<CommuteTopic | null>(null);

  // 联动：当前讲到的话题卡片滚到正中。
  useEffect(() => {
    if (!currentTopicId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-topic="${CSS.escape(currentTopicId)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentTopicId]);

  if (topics.length === 0) {
    return (
      <div className="dj-commute-podcast dj-commute-podcast--empty">
        <p>通勤播客准备中…</p>
        <p className="dj-commute-hint">每天早上 7 点前生成，或在后台「重新生成」。</p>
      </div>
    );
  }

  return (
    <div className="dj-commute-podcast">
      <div className="dj-commute-cards" ref={listRef}>
        {topics.map((t) => (
          <button
            key={t.id}
            type="button"
            data-topic={t.id}
            className={`dj-commute-card${t.id === currentTopicId ? ' dj-commute-card--active' : ''}`}
            onClick={() => setOpenTopic(t)}
          >
            {t.source && <span className="dj-commute-card-source">{t.source}</span>}
            <span className="dj-commute-card-title">{t.title}</span>
            {t.summary && <span className="dj-commute-card-summary">{t.summary}</span>}
          </button>
        ))}
      </div>

      {/* 详情浮层用 portal 挂到 body，避开 .dj-commute-podcast 的层叠上下文，
          否则关闭按钮会被 DJ 台关闭键(z-index 4)盖住 → 误退出电台。 */}
      {openTopic &&
        createPortal(
          <div className="dj-commute-detail" role="dialog" aria-label="话题详情">
            <button
              type="button"
              className="dj-commute-detail-close"
              onClick={() => setOpenTopic(null)}
              aria-label="返回"
            >
              ✕
            </button>
            {openTopic.source && <div className="dj-commute-detail-source">{openTopic.source}</div>}
            <h3 className="dj-commute-detail-title">{openTopic.title}</h3>
            <p className="dj-commute-detail-summary">{openTopic.summary || '（暂无摘要）'}</p>
            {openTopic.url && (
              <a
                className="dj-commute-detail-link"
                href={openTopic.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  // Capacitor WebView：用系统浏览器打开原文，避免占用应用 WebView。
                  e.preventDefault();
                  window.open(openTopic.url, '_system');
                }}
              >
                阅读原文 ↗
              </a>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
