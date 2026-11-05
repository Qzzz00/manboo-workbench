import { useEffect, useState } from 'react';

export type ImageBubbleProps = {
  messageId: string;
  url: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
  isMine: boolean;
  /** 用户随图发送的说明文字（发图时输入框里的字），显示在图片下方。 */
  caption?: string;
  /** 沙盒未命中且重生失败：直接显示失败态，避免空 url 永远卡「加载中」 */
  loadError?: boolean;
  onRetry?: () => void;
  onPreview: (url: string) => void;
};

export function ImageBubble({
  url,
  thumbUrl,
  width,
  height,
  isMine,
  caption,
  loadError,
  onRetry,
  onPreview,
}: ImageBubbleProps) {
  const [failed, setFailed] = useState(false);
  const displayUrl = thumbUrl || url;

  useEffect(() => {
    setFailed(false);
  }, [displayUrl]);

  const aspectRatio = width && height && height > 0 ? width / height : 1;
  const maxW = 240;
  const maxH = 240;
  let imgW = maxW;
  let imgH = maxH;
  if (aspectRatio >= 1) {
    imgH = Math.min(maxH, maxW / aspectRatio);
  } else {
    imgW = Math.min(maxW, maxH * aspectRatio);
  }

  let inner;
  if (failed || loadError) {
    inner = (
      <div className="image-bubble image-bubble-failed" style={{ width: imgW, height: imgH }}>
        <div className="image-bubble-placeholder">
          <span className="image-bubble-error-icon">⚠</span>
          {onRetry && (
            <button type="button" className="image-bubble-retry" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      </div>
    );
  } else if (!displayUrl) {
    inner = (
      <div className="image-bubble image-bubble-uploading" style={{ width: imgW, height: imgH }}>
        <div className="image-bubble-placeholder">
          <span className="image-bubble-spinner" aria-hidden="true" />
          <span>加载中...</span>
        </div>
      </div>
    );
  } else {
    inner = (
      <button
        type="button"
        className={`image-bubble ${isMine ? 'image-bubble-mine' : ''}`}
        style={{ width: imgW, height: imgH }}
        onClick={() => onPreview(url)}
        aria-label="查看大图"
      >
        <img
          src={displayUrl}
          alt="图片消息"
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
        />
      </button>
    );
  }

  const trimmedCaption = caption?.trim();
  if (!trimmedCaption) return inner;

  return (
    <div className={`image-bubble-wrap ${isMine ? 'image-bubble-wrap-mine' : ''}`}>
      {inner}
      <p className="image-bubble-caption">{trimmedCaption}</p>
    </div>
  );
}
