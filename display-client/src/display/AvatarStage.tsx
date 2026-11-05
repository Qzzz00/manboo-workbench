/**
 * 形象舞台(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 第一节;界面稿 docs/design/形象切换/①–④)。
 *
 * 横屏展示台左栏、竖屏首页形象区(display/avatar.html)用的是同一个组件:
 *   · 左右滑换形象(粒子球也在队列里,永远能滑回去);
 *   · 换的时候旧画面留着、压暗 + 转圈 +「正在换成 九尾狐」,8 秒还没好改说「还在加载,模型比较大」,
 *     失败就回到上一个并说一句 —— 不能像卡死;
 *   · 顶上名字条「赛车场 · 3/5」(换完 1.6 秒淡出),底下圆点;点圆点出快速选择条。
 * 选择本身不在这里存:滑到 / 点了哪个回给手机壳(onSelect),壳存设置、再把 current 递回来。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PARTICLES, buildQueue, queueLabel, stepQueue, swipeDirection } from './avatarQueue';
import type { HostAvatarItem } from './hostFeed';
import { joinUrl } from './packModel';
import { createPackRenderer, type PackRenderer } from './packRenderer';
import { isStalled } from './renderGuard';
import './avatarStage.css';

export interface AvatarStageProps {
  /** 这台手机上已有的形象(不含粒子球)。 */
  items: readonly HostAvatarItem[];
  current: string;
  onSelect(id: string): void;
  /** 当前是粒子球时画什么(横屏是展示台的 ParticleAvatar)。 */
  particle: ReactNode;
  /** column = 横屏左栏(底下压着黄历,垫一层渐暗);portrait = 竖屏首页;center = 第二套横屏「环绕」的中间(不压暗、圆点贴底)。 */
  variant: 'column' | 'portrait' | 'center';
}

export const SLOW_LOAD_MS = 8_000;
/** 画面卡住时自动重建画布的次数上限(每次正常出帧后清零),防止在画不出来的设备上来回重建。 */
const MAX_REBUILDS = 3;
const TOAST_MS = 1_600;

export function AvatarStage({ items, current, onSelect, particle, variant }: AvatarStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PackRenderer | null>(null);
  const [shown, setShown] = useState<string>(PARTICLES);
  const [loading, setLoading] = useState<{ id: string; slow: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // 画布代次:卡住 / 丢了 WebGL 上下文就换一块新画布(key 变了 React 给新的 <canvas>)再载一次 —— 原来要靠转屏(10-01 真机)。
  const [epoch, setEpoch] = useState(0);
  const loadedEpochRef = useRef(0);
  const shownAtRef = useRef(0);
  const rebuildsRef = useRef(0);
  const loadingRef = useRef(false);

  const queue = useMemo(() => buildQueue(items, new Set(items.map((i) => i.id))), [items]);
  const ids = useMemo(() => queue.map((q) => q.id), [queue]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // 加载只跟着「选了谁」和画布代次走;壳每次状态变化都会再递一遍列表,不能因此重载(10-01:重载一份同样的模型 → 黑影)。
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const nameOf = (id: string) => queue.find((q) => q.id === id)?.name ?? '粒子球';

  const say = (text: string) => setToast(text);
  useEffect(() => {
    if (toast === null) return;
    const t = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  const ensureRenderer = (): PackRenderer | null => {
    if (rendererRef.current !== null) return rendererRef.current;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (canvas === null || root === null) return null;
    try {
      rendererRef.current = createPackRenderer(canvas, { w: root.clientWidth || 1, h: root.clientHeight || 1 }, variant === 'portrait' ? 'bust' : 'full');
    } catch {
      rendererRef.current = null;
    }
    return rendererRef.current;
  };

  // 目标变了:粒子球直接换;形象先载好再换,期间旧画面压暗 + 转圈。
  useEffect(() => {
    if (current === shownRef.current && loading === null && epoch === loadedEpochRef.current) return;
    if (current === PARTICLES) {
      loadingRef.current = false;
      rendererRef.current?.clear();
      setLoading(null);
      setShown(PARTICLES);
      return;
    }
    const item = byIdRef.current.get(current);
    if (item === undefined) { onSelect(PARTICLES); return; }
    const renderer = ensureRenderer();
    if (renderer === null) { say('这台设备画不了 Live2D,先用粒子球'); onSelect(PARTICLES); return; }
    let alive = true;
    loadingRef.current = true;
    setLoading({ id: current, slow: false });
    const slow = window.setTimeout(() => { if (alive) setLoading((l) => (l === null ? l : { ...l, slow: true })); }, SLOW_LOAD_MS);
    renderer.load(item).then((ok) => {
      if (!alive || !ok) return;
      loadedEpochRef.current = epoch;
      shownAtRef.current = performance.now();
      loadingRef.current = false;
      setShown(current);
      setLoading(null);
    }).catch(() => {
      if (!alive) return;
      loadingRef.current = false;
      const back = shownRef.current;
      setLoading(null);
      say(`${item.name} 没加载出来,先用回 ${nameOf(back)}`);
      onSelect(back);
    }).finally(() => window.clearTimeout(slow));
    return () => { alive = false; window.clearTimeout(slow); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, epoch]);

  // 看门狗:模型在上屏、页面可见,却 2.5 秒没画出一帧(或上下文丢了)→ 换画布重载。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const r = rendererRef.current;
      const root = rootRef.current;
      if (r === null || root === null || loadingRef.current) return;
      const h = r.health();
      const stalled = isStalled({
        now: performance.now(),
        lastFrameAt: h.lastFrameAt,
        shownSince: shownAtRef.current,
        visible: document.visibilityState === 'visible' && root.clientWidth > 0 && root.clientHeight > 0,
        showing: shownRef.current !== PARTICLES,
        lost: h.lost,
      });
      if (!stalled) { if (performance.now() - h.lastFrameAt < 1_000) rebuildsRef.current = 0; return; }
      if (rebuildsRef.current >= MAX_REBUILDS) return;
      rebuildsRef.current += 1;
      console.warn('[AvatarStage] 画面卡住,重建画布', { lost: h.lost, rebuild: rebuildsRef.current });
      r.destroy();
      rendererRef.current = null;
      setEpoch((e) => e + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // 尺寸跟着容器走。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => rendererRef.current?.resize({ w: root.clientWidth || 1, h: root.clientHeight || 1 }));
    ro.observe(root);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { rendererRef.current?.destroy(); rendererRef.current = null; }, []);

  // 左右滑。点在圆点 / 选择条上的不算滑。
  const start = useRef<{ x: number; y: number } | null>(null);
  const go = (id: string) => {
    if (id === current) return;
    setPicker(false);
    say(queueLabel(queue, id));
    onSelect(id);
  };
  const onPointerDown = (e: React.PointerEvent) => { start.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (s === null || ids.length < 2) return;
    const dir = swipeDirection(e.clientX - s.x, e.clientY - s.y);
    if (dir !== null) go(stepQueue(ids, current, dir));
  };

  const shownItem = byId.get(shown);
  const sceneUrl = (rel: string | null | undefined) => (shownItem === undefined || rel == null ? null : `url("${joinUrl(shownItem.base, rel)}")`);
  const bg = sceneUrl(shownItem?.scene?.background);
  const fg = sceneUrl(shownItem?.scene?.foreground);
  const at = Math.max(0, ids.indexOf(loading?.id ?? current));

  return (
    <div
      ref={rootRef}
      className="av-stage"
      data-variant={variant}
      data-shown={shown === PARTICLES ? 'particles' : 'live2d'}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; }}
    >
      {shown === PARTICLES && <div className="av-particle">{particle}</div>}
      {bg !== null && <div className="av-scene av-scene--bg" style={{ backgroundImage: bg }} aria-hidden="true" />}
      <canvas key={epoch} ref={canvasRef} className="av-canvas" hidden={shown === PARTICLES} aria-hidden="true" />
      {fg !== null && <div className="av-scene av-scene--fg" style={{ backgroundImage: fg }} aria-hidden="true" />}
      {variant === 'column' && shown !== PARTICLES && <div className="av-scrim" aria-hidden="true" />}

      {loading !== null && (
        <div className="av-veil" role="status" aria-live="polite">
          <span className="av-spinner" aria-hidden="true" />
          <b className="av-veil__title">正在换成 {nameOf(loading.id)}</b>
          <span className="av-veil__sub">{loading.slow ? '还在加载,模型比较大' : '加载模型 · 第一次会慢一点'}</span>
        </div>
      )}
      {toast !== null && <div className="av-toast" role="status">{toast}</div>}

      {ids.length > 1 && (
        <button
          type="button"
          className="av-dots"
          aria-label={`换形象,现在是 ${queueLabel(queue, loading?.id ?? current)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => setPicker((p) => !p)}
        >
          {ids.map((id, i) => <i key={id} data-on={i === at} />)}
        </button>
      )}

      {picker && (
        <div className="av-picker" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <p className="av-picker__title">换形象 · 左右滑也行</p>
          <div className="av-picker__row">
            {queue.map((q) => {
              const item = byId.get(q.id);
              const thumb = item?.thumb;
              return (
                <button key={q.id} type="button" className="av-pick" data-on={q.id === current} onClick={() => go(q.id)}>
                  <span className="av-pick__thumb" data-orb={q.id === PARTICLES} style={thumb === undefined ? undefined : { backgroundImage: `url("${thumb}")` }} />
                  <span className="av-pick__name">{q.name}</span>
                </button>
              );
            })}
          </div>
          {variant !== 'portrait' && <p className="av-picker__more">下载更多:竖屏 设置 › 形象</p>}
        </div>
      )}
    </div>
  );
}
