import { useEffect, useState, type ReactNode } from 'react';
import type { ChatMessage } from '../lib/llm.ts';
import { ensureVoiceInSandbox, ensureImageInSandbox } from '../lib/chatMedia.ts';
import { VoiceBubble } from './VoiceBubble.tsx';
import { ImageBubble } from './ImageBubble.tsx';
import { StickerBubble } from './StickerBubble.tsx';

type MessageBubbleProps = {
  message: ChatMessage;
  avatarName: string;
  playingVoiceId: string | null;
  onToggleVoice: (messageId: string, url: string) => void;
  onPreviewImage: (url: string) => void;
  onReplay?: (text: string) => void;
  onRetryImage?: (messageId: string) => void;
  /** 搜索命中词（忽略大小写），文本气泡内用 <mark> 标出。 */
  highlightQuery?: string;
};

function highlightText(text: string, query: string): ReactNode {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(q, from);
    if (idx === -1) {
      parts.push(text.slice(from));
      break;
    }
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(<mark key={key++}>{text.slice(idx, idx + query.length)}</mark>);
    from = idx + query.length;
  }
  return parts;
}

export function MessageBubble({
  message,
  avatarName,
  playingVoiceId,
  onToggleVoice,
  onPreviewImage,
  onReplay,
  onRetryImage,
  highlightQuery,
}: MessageBubbleProps) {
  const isAction = message.variant === 'action';
  const isSystem = message.meta && message.role === 'assistant';
  const isPending = Boolean(message.pendingStatus);
  const isMine = message.role === 'user';
  const msgType = message.type || 'text';

  const pendingText = message.pendingStatus === 'speaking'
    ? '对方正在说话中...'
    : '对方正在输入中...';

  const [resolvedVoiceUrl, setResolvedVoiceUrl] = useState<string | null>(null);
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    setResolvedVoiceUrl(null);
    setResolvedImageUrl(null);
    setMediaError(null);
    setImageLoadFailed(false);

    if (msgType === 'voice') {
      ensureVoiceInSandbox(message)
        .then((url) => {
          if (url) setResolvedVoiceUrl(url);
        })
        .catch((err) => {
          if ((err as Error & { code?: string }).code === 'content_expired') {
            setMediaError('内容已过期');
          }
        });
    } else if (msgType === 'image') {
      ensureImageInSandbox(message)
        .then((url) => {
          if (url) setResolvedImageUrl(url);
        })
        .catch((err) => {
          if ((err as Error & { code?: string }).code === 'content_expired') {
            setMediaError('内容已过期');
          } else {
            // 沙盒未命中且重生失败(如旧的用户上传图无留存)：标记失败，避免永远「加载中」
            setImageLoadFailed(true);
          }
        });
    }
    // message 对象只在 id 或 type 变化时才需要重新解析；避免 content 等字段抖动导致重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, msgType]);

  const voiceUrl = resolvedVoiceUrl ?? message.voice?.url ?? message.media?.url ?? '';
  const imageUrl = resolvedImageUrl ?? message.image?.url ?? message.media?.url ?? '';

  return (
    <article
      className={`message ${message.role}${isSystem ? ' system' : ''}${isAction ? ' action' : ''}${isPending ? ' pending' : ''}`}
      aria-live={isPending ? 'polite' : undefined}
      data-message-id={message.id}
    >
      {isSystem ? null : message.role === 'assistant' ? (
        <header>
          <strong>{avatarName}</strong>
        </header>
      ) : null}

      {isPending && msgType === 'text' ? (
        <p className="message-pending-text">
          <span>{pendingText}</span>
          <span className="message-pending-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </p>
      ) : msgType === 'voice' && (message.voice || message.media?.type === 'voice') ? (
        mediaError ? (
          <p className="message-media-error">{mediaError}</p>
        ) : (
          <VoiceBubble
            messageId={message.id}
            durationMs={message.voice?.duration_ms ?? (message.media as { durationMs?: number } | undefined)?.durationMs ?? 0}
            isPlaying={playingVoiceId === message.id}
            isMine={isMine}
            onToggle={() => onToggleVoice(message.id, voiceUrl)}
          />
        )
      ) : msgType === 'image' && (message.image || message.media?.type === 'image') ? (
        mediaError ? (
          <p className="message-media-error">{mediaError}</p>
        ) : (
          <ImageBubble
            messageId={message.id}
            url={imageUrl}
            thumbUrl={message.image?.thumb_url ?? (message.media as { thumbUrl?: string } | undefined)?.thumbUrl}
            width={message.image?.width ?? (message.media as { width?: number } | undefined)?.width}
            height={message.image?.height ?? (message.media as { height?: number } | undefined)?.height}
            isMine={isMine}
            caption={message.content}
            loadError={imageLoadFailed && !imageUrl}
            onRetry={onRetryImage ? () => onRetryImage(message.id) : undefined}
            onPreview={onPreviewImage}
          />
        )
      ) : msgType === 'sticker' && message.sticker ? (
        <StickerBubble
          stickerId={message.sticker.id}
          url={message.sticker.url}
          alt={message.content}
          fallbackText={message.content}
        />
      ) : msgType === 'text_with_sticker' && message.sticker ? (
        <div className="message-sticker-wrap">
          {message.content ? <p>{highlightQuery ? highlightText(message.content, highlightQuery) : message.content}</p> : null}
          <StickerBubble
            stickerId={message.sticker.id}
            url={message.sticker.url}
            alt={message.content}
            fallbackText={message.content}
          />
        </div>
      ) : isAction ? (
        <p className="message-action">{highlightQuery ? highlightText(message.content, highlightQuery) : message.content}</p>
      ) : (
        <p>{highlightQuery ? highlightText(message.content, highlightQuery) : message.content}</p>
      )}

      {message.role === 'assistant' && onReplay && !isPending && !isAction && msgType === 'text' && (
        <button
          className="msg-replay-btn"
          onClick={(e) => { e.stopPropagation(); onReplay(message.content); }}
          title="重播"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
      )}
    </article>
  );
}
