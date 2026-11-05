import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/llm.ts';
import { MessageBubble } from './MessageBubble.tsx';

type Props = {
  open: boolean;
  avatarName: string;
  messages: ChatMessage[];
  playingVoiceId: string | null;
  onClose: () => void;
  onToggleVoice: (messageId: string, url: string) => void;
  onPreviewImage: (url: string) => void;
  onReplay?: (text: string) => void;
  onRetryImage?: (messageId: string) => void;
};

// createdAt 单位混存：服务端统一秒（normalizeCreatedAtSeconds），本地新消息是 Date.now() 毫秒。
// >= 1e11 判毫秒（约 5138 年，不会误伤秒），与服务端同口径。
const MS_EPOCH_THRESHOLD = 1e11;
const SEARCH_DEBOUNCE_MS = 300;
const FLASH_MS = 1800;

function toEpochMs(createdAt?: number): number | null {
  if (!createdAt || !Number.isFinite(createdAt) || createdAt < 0) return null;
  return createdAt >= MS_EPOCH_THRESHOLD ? createdAt : createdAt * 1000;
}

function dayLabelOf(ms: number): string {
  const d = new Date(ms);
  const label = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date().getFullYear() ? label : `${d.getFullYear()}年${label}`;
}

type DayGroup = { key: string; label: string; messages: ChatMessage[] };

type CalMonth = { year: number; month: number }; // month 0 基

const monthIndex = (m: CalMonth) => m.year * 12 + m.month;

function parseDayKey(key: string): CalMonth & { day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month: month - 1, day };
}

/** 月历格子：周日开头的 6×7 阵列，空白补 null。 */
function buildCalendarCells(year: number, month: number): Array<number | null> {
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: offset }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return cells;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 消息按日历日切段（输入须升序）。无 createdAt 的并进前一天组，开头缺失则单列「未知时间」。 */
function groupByDay(messages: ChatMessage[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const message of messages) {
    const ms = toEpochMs(message.createdAt);
    const d = ms === null ? null : new Date(ms);
    const key = d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : 'unknown';
    const last = groups[groups.length - 1];
    if (last && (last.key === key || (d === null && last.key !== 'unknown'))) {
      last.messages.push(message);
    } else {
      groups.push({ key, label: d ? dayLabelOf(ms as number) : '未知时间', messages: [message] });
    }
  }
  return groups;
}

/**
 * 全屏「聊天记录」页：把完整对话历史从主画面移出，避免气泡堆积挡住 Live2D 角色。
 * 复用 MessageBubble 渲染，图片/语音走同一沙盒解析逻辑。overlay 结构镜像 DiaryPage。
 *
 * 打开即定位到最新一条（scrollTop=scrollHeight）；顶栏 🔍 过滤式搜索（点命中跳回完整列表
 * 对应消息并闪高亮）、📅 日期索引浮层（点击滚到当天第一条）。
 */
export function ChatHistoryPage({
  open,
  avatarName,
  messages,
  playingVoiceId,
  onClose,
  onToggleVoice,
  onPreviewImage,
  onReplay,
  onRetryImage,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [dateOpen, setDateOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<CalMonth | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // 打开时复位到初始状态并滚到最新一条。组件常驻挂载、display 控制显隐，状态会跨次残留——
  // 用户视角「返回再进入」是新打开，不该看到上次没收起的搜索框/日期浮层，更不该看到
  // 残留关键词过滤后的残表（会误以为记录丢了）。scrollHeight 须在 open 变 true 之后读。
  useEffect(() => {
    if (!open) return;
    setSearchOpen(false);
    setQuery('');
    setDebouncedQuery('');
    setDateOpen(false);
    setFlashId(null);
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (flashId === null) return;
    const timer = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const searching = debouncedQuery.length > 0;
  const loweredQuery = debouncedQuery.toLowerCase();

  const visibleMessages = useMemo(
    () => (searching
      ? messages.filter((m) => (m.content || '').toLowerCase().includes(loweredQuery))
      : messages),
    [messages, searching, loweredQuery],
  );
  const dayGroups = useMemo(() => groupByDay(visibleMessages), [visibleMessages]);
  // 日期索引永远基于完整列表（搜索模式下 📅 隐藏，但保持计算口径一致）
  const allDayGroups = useMemo(() => groupByDay(messages), [messages]);
  const recordedDayKeys = useMemo(() => new Set(allDayGroups.map((g) => g.key)), [allDayGroups]);
  // 月份切换范围：最早记录月 ~ 最新记录月（记录不可能在未来）
  const calRange = useMemo(() => {
    if (allDayGroups.length === 0) return null;
    return {
      min: parseDayKey(allDayGroups[0].key),
      max: parseDayKey(allDayGroups[allDayGroups.length - 1].key),
    };
  }, [allDayGroups]);

  const toggleDatePanel = () => {
    if (!dateOpen && calRange) {
      // 每次打开落在最新记录所在月——打开页面时人在最底部，心智上「现在在这儿」
      setCalMonth({ year: calRange.max.year, month: calRange.max.month });
    }
    setDateOpen((v) => !v);
  };

  const shiftCalMonth = (delta: number) => {
    setCalMonth((cur) => {
      if (!cur || !calRange) return cur;
      const next = monthIndex(cur) + delta;
      if (next < monthIndex(calRange.min) || next > monthIndex(calRange.max)) return cur;
      return { year: Math.floor(next / 12), month: ((next % 12) + 12) % 12 };
    });
  };

  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  })();

  const scrollToDay = (dayKey: string) => {
    setDateOpen(false);
    bodyRef.current
      ?.querySelector(`[data-day-key="${CSS.escape(dayKey)}"]`)
      ?.scrollIntoView({ block: 'start' });
  };

  /** 点搜索命中：退出搜索回到完整列表，滚动定位到该条并短暂闪高亮。 */
  const jumpToMessage = (messageId: string) => {
    setSearchOpen(false);
    setQuery('');
    setDebouncedQuery('');
    setFlashId(messageId);
    requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
  };

  // 始终挂载（含消息列表），display 控制显隐——打开时零挂载成本，消除"由黑渐显"延迟。
  return (
    <div className="chat-history-overlay" style={{ display: open ? 'flex' : 'none' }}>
      <div className="chat-history-nav">
        <button className="chat-history-back" onClick={onClose} aria-label="返回">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="chat-history-title">聊天记录 · {avatarName}</div>
        <div className="chat-history-actions">
          <button
            className="chat-history-icon-btn"
            onClick={() => { setSearchOpen((v) => !v); setDateOpen(false); }}
            aria-label="搜索"
            title="搜索"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="20" height="20">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </button>
          {!searching && (
            <button
              className="chat-history-icon-btn"
              onClick={toggleDatePanel}
              aria-label="按日期跳转"
              title="按日期跳转"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="20" height="20">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="chat-history-searchbar">
          <input
            type="search"
            placeholder="搜索聊天内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button className="chat-history-search-clear" onClick={() => setQuery('')} aria-label="清空">
              ×
            </button>
          )}
        </div>
      )}

      {dateOpen && !searching && (
        <>
          <div className="chat-history-date-mask" onClick={() => setDateOpen(false)} />
          <div className="chat-history-date-panel">
            {!calRange || !calMonth ? (
              <div className="chat-history-date-empty">暂无记录</div>
            ) : (
              <>
                <div className="chat-history-cal-head">
                  <button
                    className="chat-history-cal-nav"
                    onClick={() => shiftCalMonth(-1)}
                    disabled={monthIndex(calMonth) <= monthIndex(calRange.min)}
                    aria-label="上个月"
                  >
                    ‹
                  </button>
                  <div className="chat-history-cal-title">{calMonth.year}年{calMonth.month + 1}月</div>
                  <button
                    className="chat-history-cal-nav"
                    onClick={() => shiftCalMonth(1)}
                    disabled={monthIndex(calMonth) >= monthIndex(calRange.max)}
                    aria-label="下个月"
                  >
                    ›
                  </button>
                </div>
                <div className="chat-history-cal-grid">
                  {WEEKDAY_LABELS.map((w) => (
                    <div key={w} className="chat-history-cal-weekday">{w}</div>
                  ))}
                  {buildCalendarCells(calMonth.year, calMonth.month).map((day, i) => {
                    if (day === null) return <div key={`blank-${i}`} />;
                    const key = `${calMonth.year}-${calMonth.month + 1}-${day}`;
                    const hasRecords = recordedDayKeys.has(key);
                    return (
                      <button
                        key={key}
                        className={[
                          'chat-history-cal-day',
                          hasRecords ? 'has-records' : '',
                          key === todayKey ? 'is-today' : '',
                        ].join(' ')}
                        disabled={!hasRecords}
                        onClick={() => scrollToDay(key)}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div className="chat-history-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="chat-history-empty">还没有聊天记录</div>
        ) : searching && dayGroups.length === 0 ? (
          <div className="chat-history-empty">没有找到「{debouncedQuery}」相关的记录</div>
        ) : (
          dayGroups.map((group) => (
            <div className="chat-history-day-group" key={group.key} data-day-key={group.key}>
              <div className="chat-history-day-label">{group.label}</div>
              {group.messages.map((message) => (
                <div
                  key={message.id}
                  className={[
                    searching ? 'chat-history-hit' : '',
                    flashId === message.id ? 'chat-history-flash' : '',
                  ].join(' ')}
                  onClick={searching ? () => jumpToMessage(message.id) : undefined}
                >
                  <MessageBubble
                    message={message}
                    avatarName={avatarName}
                    playingVoiceId={playingVoiceId}
                    onToggleVoice={onToggleVoice}
                    onPreviewImage={onPreviewImage}
                    onReplay={onReplay}
                    onRetryImage={onRetryImage}
                    highlightQuery={searching ? debouncedQuery : undefined}
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
