import { useEffect, useRef } from 'react';
import { getAvatarById, resolveAvatarManifestById } from './avatarManifest.ts';
import {
  applyExpressionMix,
  createLive2DRuntime,
  destroyRuntime,
  resizeRuntime,
  setFramingTarget,
  startMotion,
  updateStageTransform,
  type StageTransform,
} from './live2dEngine.ts';

type LoginLive2DProps = {
  /** 展示的角色 id，默认 shuangsheng */
  avatarId?: string;
  /** 画面缩放/位移，用于把角色摆进灰色展示区 */
  transform?: StageTransform;
  /** 入场动作，默认 idle */
  motionName?: string;
};

const DEFAULT_TRANSFORM: StageTransform = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * 登录页角色展示（只读）。
 * 直接复用 live2dEngine，不带拖拽/缩放/提示等交互 chrome。
 */
export function LoginLive2D({
  avatarId = 'shuangsheng',
  transform = DEFAULT_TRANSFORM,
  motionName = 'idle',
}: LoginLive2DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Awaited<ReturnType<typeof createLive2DRuntime>> | null>(null);
  const transformRef = useRef(transform);

  useEffect(() => {
    transformRef.current = transform;
    if (runtimeRef.current && containerRef.current) {
      updateStageTransform(runtimeRef.current, containerRef.current, transform);
    }
  }, [transform]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 这台机器上没有这个形象(仓库不带模型,10-21):登录页不画角色,不报错。
    if (getAvatarById(avatarId) === undefined) return;

    let cancelled = false;

    void resolveAvatarManifestById(avatarId)
      .then(async (avatar) => {
        const runtime = await createLive2DRuntime(container, avatar);
        if (cancelled) {
          destroyRuntime(runtime);
          return;
        }
        runtimeRef.current = runtime;
        await applyExpressionMix(runtime, avatar, [{ key: 'neutral', weight: 1 }]);
        setFramingTarget(runtime, 'login');
        updateStageTransform(runtime, container, transformRef.current);
        if (motionName) {
          void startMotion(runtime, avatar, motionName).catch(() => { /* ignore */ });
        }
      })
      .catch((error) => {
        console.error('[login-live2d] failed to load', error);
      });

    const observer = new ResizeObserver(() => {
      if (runtimeRef.current && containerRef.current) {
        resizeRuntime(runtimeRef.current, containerRef.current);
        updateStageTransform(runtimeRef.current, containerRef.current, transformRef.current);
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (runtimeRef.current) {
        destroyRuntime(runtimeRef.current);
        runtimeRef.current = null;
      }
    };
  }, [avatarId, motionName]);

  return <div ref={containerRef} className="login-live2d" aria-hidden="true" />;
}
