/**
 * 手机登录页(欢迎屏)顶上的粒子黑洞(2026-09-23 维护者拍板:产品的主视觉;事务官的粒子球不替换,
 * 她在登录 / 配对成功那一下从黑洞里「飞出来」,见 brandHandoff.ts)。
 *
 * 与电脑端 workbench-plugin/src/client/brand/BlackholeHero.tsx 同一个画法、同一份核心(blackhole.js,三处逐字节相同);
 * 手机上每 5 颗画 1 颗(约 4000 颗)、30 帧,手机端一律深色底,所以总是白光相加。
 * 「减少动效」开着只画一帧静图;App 切到后台就停。
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { BlackholePainter, handoffLaunching } from './blackhole.js';

export interface HeroHandle {
  painter: BlackholePainter;
  canvas: HTMLCanvasElement;
  clock(): number;
}

export const HERO_FRAME_MS = 1000 / 30;
export const HERO_STRIDE = 5;
export const HERO_START_CLOCK = 12;

/** 版式:环半径占宽的 10.5%(原型窄屏的比例),但不超过高的 26%;圆心在 60% 高处。 */
export function heroLayout(width: number, height: number): { radius: number; cx: number; cy: number } {
  return { radius: Math.max(8, Math.min(width * 0.105, height * 0.26)), cx: width / 2, cy: height * 0.6 };
}

export function BlackholeHero({ handleRef }: { handleRef?: MutableRefObject<HeroHandle | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof CanvasRenderingContext2D === 'undefined') return;
    let painter: BlackholePainter;
    try { if (!canvas.getContext('2d')) return; painter = new BlackholePainter(canvas, { stride: HERO_STRIDE }); } catch { return; }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let clock = HERO_START_CLOCK, frame = 0, last: number | undefined, dead = false;
    const fit = () => {
      // 卸载 / 串联途中 ResizeObserver 报的 0 尺寸:不重排、不重画光环(2026-09-24 去卡顿)。
      if (!canvas.isConnected || handoffLaunching()) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0 && painter.view.width > 1) return;
      const width = rect.width || 360, height = rect.height || 240;
      painter.layout({ width, height, dpr: window.devicePixelRatio || 1, ...heroLayout(width, height) });
      painter.paint(clock);
    };
    const schedule = () => { if (!dead && !frame && !document.hidden && !reduced?.matches) frame = requestAnimationFrame(tick); };
    const tick = (at: number) => {
      frame = 0;
      if (dead) return;
      // 串联开始了:这块画布已经拷进飞行层、藏起来了(styles.css),不再每帧画它,主线程留给飞行和新屏。
      if (document.documentElement.dataset.brandHandoff !== undefined) { last = undefined; schedule(); return; }
      if (last === undefined || at - last >= HERO_FRAME_MS * 0.8) {
        clock += last === undefined ? 0 : Math.min(0.1, (at - last) / 1000);
        last = at;
        painter.paint(clock);
      }
      schedule();
    };
    const wake = () => {
      if (document.hidden || reduced?.matches) { if (frame) cancelAnimationFrame(frame); frame = 0; last = undefined; painter.paint(clock); }
      else schedule();
    };
    fit(); schedule();
    canvas.dataset.running = String(!reduced?.matches);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : undefined;
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', wake);
    reduced?.addEventListener?.('change', wake);
    if (handleRef) handleRef.current = { painter, canvas, clock: () => clock };
    return () => {
      dead = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      reduced?.removeEventListener?.('change', wake);
      if (handleRef?.current?.canvas === canvas) handleRef.current = null;
    };
  }, [handleRef]);
  return (
    <div className="ba-brand-hero" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
