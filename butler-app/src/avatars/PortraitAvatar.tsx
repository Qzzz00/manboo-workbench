/**
 * 竖屏首页的形象区(2026-10-01,界面稿 docs/design/形象切换/④;设计文档 1.2、2.4)。
 *
 *   · 当前是粒子球:照旧画手机那颗球(说话 / 聆听 / 在办那几态都在它身上),外面包一层左右滑;
 *   · 当前是某个形象:嵌 `display/avatar.html`(与横屏展示台左栏同一个形象舞台,它自己管滑动、加载遮罩、圆点),
 *     把队列和选择递进去、听它回报选了哪个。
 * 顶上一颗小方格进「形象」陈列页。通话 / 引导时调用方不用它(球的那几态要紧)。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { avatarLibrary, useAvatarLibrary } from './useAvatarLibrary';
import { PARTICLES } from './library';
import { avatarSelectFromDisplay, avatarsMessage, readyFromDisplay } from '../display/displayUrl';

const SWIPE_MIN_PX = 40;

function step(ids: readonly string[], current: string, dir: 1 | -1): string {
  const at = Math.max(0, ids.indexOf(current));
  return ids[(at + dir + ids.length) % ids.length];
}

export function PortraitAvatar({ particle, onOpenGallery }: { particle: ReactNode; onOpenGallery(): void }) {
  const lib = useAvatarLibrary();
  const ids = [PARTICLES, ...lib.stage.map((s) => s.id)];
  const nameOf = (id: string) => (id === PARTICLES ? '粒子球' : lib.stage.find((s) => s.id === id)?.name ?? '');
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const t = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ——— 粒子球:外面包一层左右滑 ———
  const start = useRef<{ x: number; y: number } | null>(null);
  const select = useCallback((id: string) => {
    setToast(`${nameOf(id)} · ${ids.indexOf(id) + 1}/${ids.length}`);
    void avatarLibrary().select(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (s === null || ids.length < 2) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    select(step(ids, lib.choice, dx < 0 ? 1 : -1));
  };

  // ——— 形象:iframe,递队列与选择 ———
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(lib);
  latest.current = lib;
  const push = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (target == null) return;
    try { target.postMessage(avatarsMessage(latest.current.stage, latest.current.choice), window.location.origin); } catch { /* 还没好 */ }
  }, []);
  useEffect(() => { push(); }, [lib, push]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const picked = avatarSelectFromDisplay(event.data);
      if (picked !== null) { void avatarLibrary().select(picked); return; }
      if (readyFromDisplay(event.data)) push();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [push]);

  const live2d = lib.choice !== PARTICLES;
  return (
    <div className="ba-avportrait" data-live2d={live2d}>
      {live2d
        ? <iframe ref={frame} className="ba-avportrait__frame" title="形象" src="./display/avatar.html?feed=host" onLoad={push} />
        : (
          <div
            className="ba-avportrait__orb"
            onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY }; }}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { start.current = null; }}
          >
            {particle}
            {ids.length > 1 && (
              <span className="ba-avportrait__dots" aria-hidden="true">{ids.map((id) => <i key={id} data-on={id === lib.choice} />)}</span>
            )}
          </div>
        )}
      {toast !== null && !live2d && <span className="ba-avportrait__toast" role="status">{toast}</span>}
      <button type="button" className="ba-avportrait__gallery" aria-label="形象:全部、下载" onClick={onOpenGallery}>
        <span>{nameOf(lib.choice)}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="currentColor" /></svg>
      </button>
    </div>
  );
}
