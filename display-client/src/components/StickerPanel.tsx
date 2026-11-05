import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStickers } from '../lib/stickerApi.ts';
import { getRecentStickers, recordStickerUsed } from '../lib/stickerRecents.ts';
import type { Sticker } from '../lib/stickerTypes.ts';

type TabKey = 'emoji' | 'stickers';

type StickerPanelProps = {
  open: boolean;
  onClose: () => void;
  /** 选中系统 emoji 后回调；参数为插入的 emoji 字符 */
  onEmoji: (emoji: string) => void;
  /** 选中 sticker 后回调；外部负责发送并关闭面板 */
  onSendSticker: (sticker: Sticker) => void;
};

const GRID_COLUMNS = 5;

const EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😘', '😭',
  '😅', '😆', '😉', '😌', '😎', '🥺', '😢', '😡',
  '🤔', '🤗', '🤭', '🤫', '🤥', '😶', '😐', '😴',
  '❤️', '💕', '💖', '💔', '💯', '✨', '🔥', '💩',
  '👍', '👎', '👏', '🙏', '🤝', '✌️', '🤞', '🫶',
  '🐶', '🐱', '🐼', '🐷', '🐰', '🦊', '🐸', '🐤',
  '🌸', '🌹', '🌻', '🌷', '🍀', '🍎', '🍊', '🍉',
  '🎉', '🎁', '🎵', '⚡', '⭐', '🌙', '☀️', '☕',
];

function groupByType(stickers: Sticker[]): { daily: Sticker[]; meme: Sticker[]; other: Sticker[] } {
  const daily: Sticker[] = [];
  const meme: Sticker[] = [];
  const other: Sticker[] = [];
  for (const sticker of stickers) {
    if (sticker.sticker_type === 'daily') daily.push(sticker);
    else if (sticker.sticker_type === 'meme') meme.push(sticker);
    else other.push(sticker);
  }
  return { daily, meme, other };
}

function sortByCreatedAtDesc(a: Sticker, b: Sticker): number {
  if (!a.created_at || !b.created_at) return 0;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

export function StickerPanel({ open, onClose, onEmoji, onSendSticker }: StickerPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('stickers');
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<Sticker[]>([]);
  const mountedRef = useRef(false);

  const loadStickers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStickers({ fallbackToMock: true });
      setStickers(result.stickers);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setStickers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    mountedRef.current = true;
    setRecents(getRecentStickers());
    void loadStickers();
  }, [open, loadStickers]);

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
    },
    [],
  );

  const handleEmojiClick = useCallback(
    (emoji: string) => {
      onEmoji(emoji);
      onClose();
    },
    [onEmoji, onClose],
  );

  const handleStickerClick = useCallback(
    (sticker: Sticker) => {
      recordStickerUsed(sticker);
      setRecents(getRecentStickers());
      onSendSticker(sticker);
    },
    [onSendSticker],
  );

  const { daily, meme, other } = useMemo(() => groupByType(stickers), [stickers]);
  const allStickers = useMemo(
    () => [...daily.sort(sortByCreatedAtDesc), ...meme.sort(sortByCreatedAtDesc), ...other.sort(sortByCreatedAtDesc)],
    [daily, meme, other],
  );

  if (!open) return null;

  return (
    <div
      className="sticker-panel"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="表情包"
    >
      <div className="sticker-panel-header">
        <button
          type="button"
          className={`sticker-panel-tab${activeTab === 'emoji' ? ' active' : ''}`}
          onClick={() => handleTabChange('emoji')}
          aria-label="系统 emoji"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 3a9 9 0 100 18 9 9 0 000-18zM8.5 9a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8zm7 0a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8zM7.5 14a4.6 4.6 0 009 0H7.5z"
            />
          </svg>
          <span>系统 emoji</span>
        </button>
        <button
          type="button"
          className={`sticker-panel-tab${activeTab === 'stickers' ? ' active' : ''}`}
          onClick={() => handleTabChange('stickers')}
          aria-label="我的表情包"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M4 3a2 2 0 00-2 2v14a2 2 0 002 2h16a2 2 0 002-2V5a2 2 0 00-2-2H4zm4.5 3.5a2 2 0 100 4 2 2 0 000-4zM4.5 18.5l4.2-5 2.8 3.3L14.5 13l5 5.5h-15z"
            />
          </svg>
          <span>我的表情包</span>
        </button>
      </div>

      {activeTab === 'emoji' && (
        <div className="sticker-panel-body">
          <div className="emoji-grid" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-grid-item"
                onClick={() => handleEmojiClick(emoji)}
                aria-label={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'stickers' && (
        <div className="sticker-panel-body">
          {loading && stickers.length === 0 && (
            <div className="sticker-panel-empty">
              <div className="sticker-panel-spinner" />
              <span>加载中…</span>
            </div>
          )}

          {!loading && error && stickers.length === 0 && (
            <div className="sticker-panel-empty">
              <span>{error}</span>
              <button type="button" className="sticker-panel-retry" onClick={() => void loadStickers()}>
                重试
              </button>
            </div>
          )}

          {recents.length > 0 && (
            <section className="sticker-panel-section">
              <h4 className="sticker-panel-section-title">最近使用</h4>
              <StickerGrid stickers={recents} columns={GRID_COLUMNS} onClick={handleStickerClick} />
            </section>
          )}

          {allStickers.length > 0 && (
            <section className="sticker-panel-section">
              <h4 className="sticker-panel-section-title">全部</h4>
              <StickerGrid stickers={allStickers} columns={GRID_COLUMNS} onClick={handleStickerClick} />
            </section>
          )}

          {!loading && !error && stickers.length === 0 && (
            <div className="sticker-panel-empty">暂无表情包</div>
          )}
        </div>
      )}
    </div>
  );
}

type StickerGridProps = {
  stickers: Sticker[];
  columns: number;
  onClick: (sticker: Sticker) => void;
};

function StickerGrid({ stickers, columns, onClick }: StickerGridProps) {
  return (
    <div className="sticker-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {stickers.map((sticker) => (
        <button
          key={sticker.id}
          type="button"
          className="sticker-grid-item"
          onClick={() => onClick(sticker)}
          aria-label={sticker.name || '表情'}
        >
          <img
            src={sticker.thumb_url || sticker.url}
            alt={sticker.name || ''}
            loading="lazy"
            decoding="async"
            width={sticker.width ?? 80}
            height={sticker.height ?? 80}
            onError={(event) => {
              const target = event.currentTarget;
              target.style.visibility = 'hidden';
            }}
          />
        </button>
      ))}
    </div>
  );
}
