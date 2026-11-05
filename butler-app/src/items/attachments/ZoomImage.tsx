/**
 * 一张能双指缩放、拖动、双击放大、左右滑换下一张的图(2026-10-01,手机读对话卡 C;维护者:「点击、放大缩小这些更进一步的交互」)。
 * 只用指针事件,不加依赖。放大了拖的是图;没放大时横着滑就是换上一张 / 下一张。
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const MAX_SCALE = 6;
const SWIPE_PX = 60;

interface View { scale: number; x: number; y: number }

export function ZoomImage({ src, alt, onSwipe }: { src: string; alt: string; onSwipe?: (direction: 1 | -1) => void }) {
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; x: number; y: number; startX: number; startY: number; panX: number; panY: number } | undefined>(undefined);
  const lastTap = useRef(0);

  const distance = (): number => {
    const [a, b] = [...pointers.current.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
  };

  const begin = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 抓住这根手指(拖出图外也跟着走);抓不住(这根指针已经不在了)不碍事,照样记下来。
    try { e.currentTarget.setPointerCapture?.(e.pointerId); }
    catch { /* 不抓也能缩放 */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = { dist: distance(), scale: view.scale, x: view.x, y: view.y, startX: e.clientX, startY: e.clientY, panX: view.x, panY: view.y };
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId) || gesture.current === undefined) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size >= 2 && g.dist > 0) {
      const scale = Math.min(MAX_SCALE, Math.max(1, g.scale * distance() / g.dist));
      setView((v) => ({ ...v, scale, ...(scale === 1 ? { x: 0, y: 0 } : {}) }));
      return;
    }
    if (view.scale > 1) setView((v) => ({ ...v, x: g.panX + e.clientX - g.startX, y: g.panY + e.clientY - g.startY }));
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    const wasPinch = pointers.current.size >= 2;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      // 两指松开一指:剩下那一指接着拖,从这一刻量起。
      const [rest] = [...pointers.current.values()];
      if (rest !== undefined) gesture.current = { dist: 0, scale: view.scale, x: view.x, y: view.y, startX: rest.x, startY: rest.y, panX: view.x, panY: view.y };
      return;
    }
    gesture.current = undefined;
    if (g === undefined || wasPinch) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (view.scale === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dy) < SWIPE_PX * 1.5) { onSwipe?.(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const now = Date.now();
      if (now - lastTap.current < 300) { setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 })); lastTap.current = 0; }
      else lastTap.current = now;
    }
  };

  return (
    <div
      className="ba-zoom"
      data-scale={view.scale.toFixed(2)}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
  );
}
