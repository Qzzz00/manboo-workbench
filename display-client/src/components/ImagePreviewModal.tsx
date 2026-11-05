import { useCallback, useEffect, useRef, useState } from 'react';

type ImagePreviewModalProps = {
  url: string | null;
  onClose: () => void;
};

export function ImagePreviewModal({ url, onClose }: ImagePreviewModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const gestureRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    initialTranslate: { x: 0, y: 0 },
    isDragging: false,
    lastPoint: { x: 0, y: 0 },
  });

  const resetTransform = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (url) {
      resetTransform();
    }
  }, [url, resetTransform]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (url) {
      window.addEventListener('keydown', onKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [url, onClose]);

  const getDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches;
    if (t.length === 2) {
      gestureRef.current.initialDistance = getDistance(t);
      gestureRef.current.initialScale = scale;
    } else if (t.length === 1) {
      gestureRef.current.isDragging = true;
      gestureRef.current.lastPoint = { x: t[0].clientX, y: t[0].clientY };
    }
  }, [scale]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches;
    if (t.length === 2 && gestureRef.current.initialDistance > 0) {
      e.preventDefault();
      const dist = getDistance(t);
      const ratio = dist / gestureRef.current.initialDistance;
      const newScale = Math.min(Math.max(gestureRef.current.initialScale * ratio, 0.5), 5);
      setScale(newScale);
    } else if (t.length === 1 && gestureRef.current.isDragging && scale > 1) {
      e.preventDefault();
      const dx = t[0].clientX - gestureRef.current.lastPoint.x;
      const dy = t[0].clientY - gestureRef.current.lastPoint.y;
      gestureRef.current.lastPoint = { x: t[0].clientX, y: t[0].clientY };
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    }
  }, [scale]);

  const handleTouchEnd = useCallback(() => {
    gestureRef.current.initialDistance = 0;
    gestureRef.current.isDragging = false;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.min(Math.max(s * delta, 0.5), 5));
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (scale > 1) {
      resetTransform();
    } else {
      setScale(2.5);
    }
  }, [scale, resetTransform]);

  if (!url) return null;

  return (
    <div
      ref={containerRef}
      className="image-preview-modal"
      onClick={(e) => { if (e.target === containerRef.current) onClose(); }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      <button type="button" className="image-preview-close" onClick={onClose} aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      <img
        ref={imgRef}
        src={url}
        alt="预览"
        className="image-preview-img"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        onDoubleClick={handleDoubleClick}
        draggable={false}
      />
    </div>
  );
}
