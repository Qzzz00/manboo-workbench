import { useState } from 'react';
import { avatarList } from '../features/live2d/avatarManifest.ts';
import {
  getAllEntries,
  addEntry,
  toggleLike,
  addComment,
  type DiaryEntry,
} from '../lib/diaryStore.ts';

type Props = {
  open: boolean;
  selectedAvatarId: string;
  onClose: () => void;
  onTriggerGenerate: (avatarId: string) => void;
};

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const avatarColors = ['#f4a7b9','#a7c5f4','#c5f4a7','#f4d7a7','#d7a7f4','#a7f4d7','#f4a7a7','#a7f4f4','#d4a0e6'];

export function DiaryPage({ open, selectedAvatarId, onClose, onTriggerGenerate }: Props) {
  const [tab, setTab] = useState<string>('all');
  const [showFab, setShowFab] = useState(false);
  const [fabAction, setFabAction] = useState<'post' | 'generate' | null>(null);
  const [postText, setPostText] = useState('');
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [tick, setTick] = useState(0);

  // Compute entries directly from store on every open/tab/tick change
  void tick;
  const entries: DiaryEntry[] = open
    ? (tab === 'all' ? getAllEntries() : getAllEntries().filter((e) => e.authorId === '_user'))
    : [];

  if (!open) return null;

  const tabs = [
    { id: 'all', name: '全部' },
    { id: '_user', name: '我的' },
  ];

  function refresh() { setTick((n) => n + 1); }

  function handlePost() {
    if (!postText.trim()) return;
    addEntry({
      id: crypto.randomUUID(),
      authorId: '_user',
      authorName: '我',
      text: postText.trim(),
      time: Date.now(),
      likes: [],
      comments: [],
    });
    setPostText('');
    setFabAction(null);
    refresh();
  }

  function handleLike(entryId: string) {
    toggleLike(entryId, '_user');
    refresh();
  }

  function handleComment(entryId: string) {
    if (!commentText.trim()) return;
    addComment(entryId, {
      id: crypto.randomUUID(),
      authorId: '_user',
      authorName: '我',
      text: commentText.trim(),
      time: Date.now(),
    });
    setCommentText('');
    setCommentingId(null);
    refresh();
  }

  return (
    <div className="diary-overlay-v2">
      {/* Nav */}
      <div className="diary-nav-v2">
        <button className="diary-nav-back-v2" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div className="diary-nav-title-v2">动态</div>
        <div style={{ width: 36 }} />
      </div>

      {/* Tabs */}
      <div className="diary-tabs-v2">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`diary-tab-v2${t.id === tab ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="diary-body-v2">
        {entries.length === 0 ? (
          <div className="diary-empty-v2">
            <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
            <div style={{ color: '#999', fontSize: 14 }}>暂无动态</div>
          </div>
        ) : (
          entries.map((entry) => {
            const colorIdx = [...avatarList].findIndex((a) => a.id === entry.authorId);
            const avatarBg = avatarColors[Math.max(0, colorIdx) % avatarColors.length];

            return (
              <div key={entry.id} className="diary-card-v2">
                {/* Header */}
                <div className="diary-card-header-v2">
                  <div className="diary-avatar-v2" style={{ background: avatarBg }}>
                    {entry.authorName[0]}
                  </div>
                  <div className="diary-card-meta-v2">
                    <div className="diary-card-name-v2">{entry.authorName}</div>
                    <div className="diary-card-time-v2">{formatTime(entry.time)}</div>
                  </div>
                </div>

                {/* Body text */}
                <div className="diary-card-text-v2">{entry.text}</div>

                {/* Image grid (placeholder) */}
                {entry.image && (
                  <div className="diary-card-images-v2">
                    <div className="diary-card-img-v2" />
                    <div className="diary-card-img-v2" />
                  </div>
                )}

                {/* Actions */}
                <div className="diary-card-actions-v2">
                  <button
                    className={`diary-action-btn-v2${entry.likes.includes('_user') ? ' liked' : ''}`}
                    onClick={() => handleLike(entry.id)}
                  >
                    <svg viewBox="0 0 24 24" fill={entry.likes.includes('_user') ? '#ef4444' : 'none'} stroke="currentColor" strokeWidth="1.6" width="16" height="16"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                    <span>{entry.likes.length || '点赞'}</span>
                  </button>
                  <button
                    className="diary-action-btn-v2"
                    onClick={() => setCommentingId(commentingId === entry.id ? null : entry.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    <span>{entry.comments.length || '评论'}</span>
                  </button>
                </div>

                {/* Comments */}
                {entry.comments.length > 0 && (
                  <div className="diary-comments-v2">
                    {entry.comments.map((c) => (
                      <div key={c.id} className="diary-comment-item-v2">
                        <span className="diary-comment-author-v2">{c.authorName}</span>
                        <span>{c.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Comment input */}
                {commentingId === entry.id && (
                  <div className="diary-comment-box-v2">
                    <input
                      className="diary-comment-input-v2"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="写评论..."
                      onKeyDown={(e) => e.key === 'Enter' && handleComment(entry.id)}
                    />
                    <button className="diary-comment-send-v2" onClick={() => handleComment(entry.id)}>
                      发送
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* FAB */}
      <div className="diary-fab-wrap">
        {fabAction === 'post' ? (
          <div className="diary-fab-sheet" onClick={(e) => e.stopPropagation()}>
            <textarea
              className="diary-fab-textarea"
              value={postText}
              onChange={(e) => setPostText(e.target.value)}
              placeholder="分享今天发生的事..."
              rows={3}
              autoFocus
            />
            <div className="diary-fab-sheet-actions">
              <button className="diary-fab-cancel" onClick={() => { setFabAction(null); setPostText(''); }}>
                取消
              </button>
              <button className="diary-fab-submit" onClick={handlePost} disabled={!postText.trim()}>
                发布
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={`diary-fab-menu${showFab ? ' open' : ''}`}>
              <button className="diary-fab-menu-item" onClick={() => { setFabAction('post'); setShowFab(false); }}>
                <span className="diary-fab-menu-icon">✍️</span> 写动态
              </button>
              <button className="diary-fab-menu-item" onClick={() => { onTriggerGenerate(selectedAvatarId); setShowFab(false); setTimeout(refresh, 500); }}>
                <span className="diary-fab-menu-icon">🤖</span> 生成日志
              </button>
            </div>
            <button
              className={`diary-fab-btn${showFab ? ' open' : ''}`}
              onClick={() => setShowFab(!showFab)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="24" height="24">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </>
        )}
      </div>

      {showFab && <div className="diary-fab-backdrop" onClick={() => setShowFab(false)} />}
    </div>
  );
}
