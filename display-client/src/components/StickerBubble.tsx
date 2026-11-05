import { useEffect, useState } from 'react';
import { fetchAndCacheSticker } from '../lib/stickerCache.ts';
import { resolveStickerUrl } from '../lib/stickerApi.ts';

export type StickerBubbleProps = {
  stickerId: string;
  url: string;
  alt?: string;
  /** 纯文字降级内容，加载失败时显示；为空则显示占位图。 */
  fallbackText?: string;
};

export type StickerBubbleViewProps = {
  stickerId: string;
  blobUrl: string | null;
  size: { width: number; height: number } | null;
  failed: boolean;
  alt?: string;
  fallbackText?: string;
  onImageError?: () => void;
};

const SHORT_SIDE = 120;
const LONG_SIDE_MAX = 160;

function computeStickerSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: SHORT_SIDE, height: SHORT_SIDE };
  }
  const ratio = naturalWidth / naturalHeight;
  if (ratio >= 1) {
    const height = SHORT_SIDE;
    const width = Math.min(LONG_SIDE_MAX, Math.round(height * ratio));
    return { width, height };
  }
  const width = SHORT_SIDE;
  const height = Math.min(LONG_SIDE_MAX, Math.round(width / ratio));
  return { width, height };
}

function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(computeStickerSize(img.naturalWidth, img.naturalHeight));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function StickerBubbleView({
  blobUrl,
  size,
  failed,
  alt,
  fallbackText,
  onImageError,
}: StickerBubbleViewProps) {
  if (failed) {
    if (fallbackText) {
      return <p className="sticker-bubble-fallback">{fallbackText}</p>;
    }
    return (
      <div className="sticker-bubble sticker-bubble-failed" style={{ width: SHORT_SIDE, height: SHORT_SIDE }}>
        <span className="sticker-bubble-placeholder-icon">🙂</span>
      </div>
    );
  }

  if (!blobUrl || !size) {
    return (
      <div className="sticker-bubble sticker-bubble-loading" style={{ width: SHORT_SIDE, height: SHORT_SIDE }}>
        <span className="sticker-bubble-spinner" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      className="sticker-bubble"
      src={blobUrl}
      alt={alt || '表情包'}
      loading="lazy"
      width={size.width}
      height={size.height}
      style={{ width: size.width, height: size.height, objectFit: 'contain' }}
      onError={onImageError}
    />
  );
}

export function StickerBubble({ stickerId, url, alt, fallbackText }: StickerBubbleProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    setBlobUrl(null);
    setSize(null);
    setFailed(false);

    const resolvedUrl = resolveStickerUrl(url);

    fetchAndCacheSticker(stickerId, resolvedUrl)
      .then(async (blob) => {
        if (cancelled) return;
        if (!blob) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        try {
          const measured = await measureImage(objectUrl);
          if (cancelled) return;
          setBlobUrl(objectUrl);
          setSize(measured);
        } catch (error) {
          if (cancelled) return;
          console.warn('[StickerBubble] measure failed', stickerId, error);
          setFailed(true);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[StickerBubble] load failed', stickerId, error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [stickerId, url]);

  return (
    <StickerBubbleView
      stickerId={stickerId}
      blobUrl={blobUrl}
      size={size}
      failed={failed}
      alt={alt}
      fallbackText={fallbackText}
      onImageError={() => setFailed(true)}
    />
  );
}
