import { useEffect, useMemo } from 'react';
import { Live2DStage } from '../features/live2d/Live2DStage.tsx';
import {
  getAvatarNeutralExpressionId,
  type AvatarManifest,
} from '../features/live2d/avatarManifest.ts';
import type { StageTransform } from '../features/live2d/live2dEngine.ts';
import { resolveHomeFraming } from '../lib/mobileTransform.ts';
import type { JourneyEnding } from '../lib/journeyApi.ts';
import { splitEndingText } from '../lib/endingText.ts';
import { useBgm } from '../hooks/useBgm.ts';
import { useCrisisResources } from '../hooks/useCrisisResources.ts';
import { useSentenceReveal } from '../hooks/useSentenceReveal.ts';
import { setNotificationPaused } from '../lib/notificationPause.ts';
import { CrisisResourceReminder } from './CrisisResourceReminder.tsx';

export type EndingSceneProps = {
  open: boolean;
  /** 当前选中的角色 manifest（用于 Live2D 渲染） */
  avatar: AvatarManifest;
  /** 结局对白数据 */
  ending: JourneyEnding;
  /** 配乐资源 URL；协议 v1.0 未返回，由调用方注入 */
  musicUrl?: string | null;
  /** 关闭回调（点击关闭/完成后） */
  onClose?: () => void;
  /** 全部对白揭示完成回调 */
  onComplete?: () => void;
};

function endingFramingFor(avatar: AvatarManifest): StageTransform {
  // 优先使用角色配置的主页构图（绝对构图）；未配置时使用 IDENTITY_DELTA（auto-fit 基准，无额外偏移）。
  return resolveHomeFraming(avatar);
}

export function EndingScene({
  open,
  avatar,
  ending,
  musicUrl,
  onClose,
  onComplete,
}: EndingSceneProps) {
  const sentences = useMemo(() => splitEndingText(ending.bodyText), [ending.bodyText]);
  const { visibleCount, isComplete, advance } = useSentenceReveal(sentences, {
    onComplete,
  });
  const { error: bgmError } = useBgm(musicUrl, {
    volume: 0.45,
    loop: true,
    fadeInMs: 1600,
    fadeOutMs: 1000,
  });
  const crisisResources = useCrisisResources();

  useEffect(() => {
    if (!open) return;
    setNotificationPaused(true);
    return () => {
      setNotificationPaused(false);
    };
  }, [open]);

  useEffect(() => {
    if (bgmError) {
      // 配乐失败不影响对白展示，仅控制台记录，避免弹 toast 打断沉浸。
      console.warn('[EndingScene] BGM error:', bgmError);
    }
  }, [bgmError]);

  if (!open) return null;

  const visibleSentences = sentences.slice(0, visibleCount);

  return (
    <div className="ending-scene" role="dialog" aria-label="结局展示" aria-modal="true">
      <div className="ending-scene__stage">
        <Live2DStage
          avatar={avatar}
          expressionMix={[{ key: getAvatarNeutralExpressionId(avatar), weight: 1 }]}
          parameterOverrides={[]}
          costumeParamOverrides={[]}
          watermarkVisible={false}
          transform={endingFramingFor(avatar)}
          backgroundUrl={avatar.defaultBackground ?? '/backgrounds/home-bg.jpg'}
          motionName="idle"
          interactive={false}
          surface="home"
        />
      </div>

      <div className="ending-scene__scrim" aria-hidden="true" />

      <button
        type="button"
        className="ending-scene__close"
        onClick={onClose}
        aria-label="关闭结局展示"
      >
        ✕
      </button>

      <div className="ending-scene__content">
        <div className="ending-scene__sentences" onClick={advance} role="button" tabIndex={0} aria-label="点击继续">
          {visibleSentences.map((sentence, index) => (
            <p
              key={`${index}-${sentence.slice(0, 16)}`}
              className="ending-scene__sentence"
              style={{ animationDelay: `${index * 80}ms` }}
            >
              {sentence}
            </p>
          ))}
          {isComplete ? (
            <button
              type="button"
              className="ending-scene__finish"
              onClick={onClose}
              aria-label="进入纪念物形态"
            >
              珍藏这段旅程
            </button>
          ) : null}
        </div>

        {!isComplete && sentences.length > 0 ? (
          <div className="ending-scene__hint">点击屏幕继续</div>
        ) : null}
        <CrisisResourceReminder resources={crisisResources} className="mt-5 text-left" />
      </div>
    </div>
  );
}
