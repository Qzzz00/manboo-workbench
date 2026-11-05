// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/Live2DPreview.tsx
/**
 * 角色 Live2D 交互预览。
 * - 用 pixi.js@6 + pixi-live2d-display 渲染 model3.json。
 * - 交互：视线跟随鼠标（autoInteract）、点击触发动作、滚轮缩放、拖拽平移、双击复位。
 *
 * 模型文件来自上传的形象包:butler-server 把 zip 解到 BUTLER_HOME/uploads 下,用签名预览地址给这里读
 * (routes/admin/avatars.cjs 的 preview-url)。仓库不带任何模型(2026-10-21)。
 */
import { useEffect, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { computeMobileHomeLayout } from '@/features/avatars/components/mobileFraming';
import { toPreviewRequestUrl } from '@/features/avatars/components/previewRequestUrl';

/** 预览按移动端构图定位所需的角色参数（对齐客户端 avatar.transform）。 */
export type PreviewFraming = {
  scaleMultiplier: number;
  verticalOffset: number;
  /** 老角色（种子数据）DB 里没有 modelTransform，缺省时构图数学按中性值兜底。 */
  modelTransform?: { scale: number; offsetX: number; offsetY: number };
  headAnchorY?: number;
  headSizeNorm?: number;
};

// pixi-live2d-display 需要全局 PIXI 才能自动挂接 ticker 与交互
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

// 种子模型路径解析已拆到 previewModelUrl.ts（纯函数，无 pixi），
// 以便调用方按需 lazy 加载本重组件而非被迫打进整个 pixi 引擎。

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Phase = 'loading' | 'ready' | 'error' | 'nocore';

export function Live2DPreview({
  modelUrl,
  backgroundUrl,
  framing,
  resizeKey,
}: {
  modelUrl: string;
  backgroundUrl?: string;
  framing?: PreviewFraming;
  /** 容器宽高比等外部尺寸依据变化时传入新值，触发画布 resize + 重新构图（不重载模型）。 */
  resizeKey?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  // framing 随编辑态变化：放 ref 让 fit 读到最新值；变化时由下方 effect 触发 refit。
  const framingRef = useRef(framing);
  framingRef.current = framing;
  // 暴露当前 fit 函数，供 framing 变化时外部触发重新构图。
  const refitRef = useRef<() => void>(() => {});
  // 暴露 PIXI app：ResizePlugin 只监听 window resize，容器比例变化要主动 app.resize()。
  const appRef = useRef<PIXI.Application | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      setPhase('nocore');
      return;
    }

    let destroyed = false;
    setPhase('loading');

    const app = new PIXI.Application({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    host.replaceChildren(app.view as HTMLCanvasElement);
    appRef.current = app;

    const canvas = app.view as HTMLCanvasElement;
    let cleanupListeners = () => {};

    // 逐段编码且幂等:服务端给的 modelUrl 已编码、种子表给的是原名,两种都能直接用。
    Live2DModel.from(toPreviewRequestUrl(modelUrl), { autoInteract: true, crossOrigin: '' })
      .then((model) => {
        if (destroyed) {
          model.destroy();
          return;
        }
        app.stage.addChild(model);

        // 模型固有像素尺寸（scale=1），供移动端构图数学使用。
        model.scale.set(1);
        const modelBaseWidth = Math.max(model.width, 1);
        const modelBaseHeight = Math.max(model.height, 1);

        // 按移动端 home 构图定位（与客户端一致）：anchor(0.5,1) 底部居中。
        const fit = () => {
          model.anchor.set(0.5, 1);
          const f = framingRef.current;
          if (f) {
            const layout = computeMobileHomeLayout({
              width: app.screen.width,
              rawHeight: app.screen.height,
              modelBaseWidth,
              modelBaseHeight,
              scaleMultiplier: f.scaleMultiplier,
              verticalOffset: f.verticalOffset,
              modelTransform: f.modelTransform,
              headAnchorY: f.headAnchorY,
              headSizeNorm: f.headSizeNorm,
            });
            model.scale.set(layout.totalScale);
            model.position.set(layout.modelX, layout.modelY);
          } else {
            // 无构图参数（缺字段）时回退居中，避免空白。
            const base = Math.min(
              app.screen.width / modelBaseWidth,
              app.screen.height / modelBaseHeight,
            );
            model.scale.set(base * 0.9);
            model.position.set(app.screen.width / 2, app.screen.height);
          }
        };
        fit();
        refitRef.current = fit;

        // 容器尺寸变化（窗口缩放）时按最新尺寸重构图。
        const onResize = () => fit();
        window.addEventListener('resize', onResize);

        // 滚轮缩放（以模型为中心）
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          model.scale.set(clamp(model.scale.x * factor, 0.02, 8));
        };
        // 拖拽平移（与 autoInteract 的视线跟随共存：仅按住时移动模型）
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        const onDown = (e: PointerEvent) => {
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
        };
        const onMove = (e: PointerEvent) => {
          if (!dragging) return;
          model.x += e.clientX - lastX;
          model.y += e.clientY - lastY;
          lastX = e.clientX;
          lastY = e.clientY;
        };
        const onUp = () => {
          dragging = false;
        };
        const onDblClick = () => fit(); // 双击复位

        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('dblclick', onDblClick);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        cleanupListeners = () => {
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('dblclick', onDblClick);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('resize', onResize);
          refitRef.current = () => {};
        };

        setPhase('ready');
      })
      .catch((err) => {
        console.error('[Live2DPreview] 加载失败', err);
        if (!destroyed) setPhase('error');
      });

    return () => {
      destroyed = true;
      cleanupListeners();
      appRef.current = null;
      try {
        app.destroy(true, { children: true });
      } catch {
        /* noop */
      }
    };
  }, [modelUrl]);

  // 容器比例切换（预览尺寸切换按钮）：等新尺寸生效后 resize 画布并重新构图。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      appRef.current?.resize();
      refitRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [resizeKey]);

  // framing 编辑态变化时，按最新参数重新构图（模型实例不重建）。
  const framingKey = framing
    ? [
        framing.scaleMultiplier,
        framing.verticalOffset,
        framing.modelTransform?.scale ?? '',
        framing.modelTransform?.offsetX ?? '',
        framing.modelTransform?.offsetY ?? '',
        framing.headAnchorY ?? '',
        framing.headSizeNorm ?? '',
      ].join('|')
    : '';
  useEffect(() => {
    refitRef.current();
  }, [framingKey]);

  // 背景图铺满（cover）：与客户端一致，模型 canvas 透明叠在其上；无背景回退浅灰渐变。
  const bg = backgroundUrl?.trim()
    ? `center / cover no-repeat url(${JSON.stringify(backgroundUrl)})`
    : 'linear-gradient(180deg,#f8fafc,#eef2f7)';

  // 填满父容器（父级用 9:16 外框约束尺寸）
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={hostRef}
        style={{
          width: '100%',
          height: '100%',
          background: bg,
          overflow: 'hidden',
          touchAction: 'none',
          cursor: 'grab',
        }}
      />
      {phase !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            fontSize: '0.9rem',
            textAlign: 'center',
            padding: '0 16px',
            pointerEvents: 'none',
          }}
        >
          {phase === 'loading' && '模型加载中…'}
          {phase === 'error' && '模型加载失败（检查资源文件是否存在）'}
          {phase === 'nocore' && 'Live2D 核心未加载（live2dcubismcore.min.js）'}
        </div>
      )}
      {phase === 'ready' && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '6px 10px',
            background: 'rgba(255,255,255,0.72)',
            fontSize: '0.72rem',
            color: '#64748b',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          已按移动端构图 · 拖拽/滚轮临时查看 · 双击回移动端构图
        </div>
      )}
    </div>
  );
}
