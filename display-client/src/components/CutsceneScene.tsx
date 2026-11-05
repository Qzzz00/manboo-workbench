import { useEffect, useRef, useState } from 'react';
import { setPausedNotifications } from '../lib/journeyStore.ts';
import { loadStoredTtsSettings, speakText, stopSpeaking } from '../lib/tts.ts';
import { normalizeStoryboard, panelDurationMs, isLastPanel, type CutscenePanel } from '../lib/cutscenePlayback.ts';

interface CutsceneSceneProps {
  storyboard: unknown;
  bgmUrl?: string | null;
  avatarId?: string;
  onComplete: () => void;
  /** 是否允许点击加速/跳到下一格。首播可传 false。 */
  skippable?: boolean;
}

const ASPECT_RATIO: Record<CutscenePanel['aspect'], string> = {
  wide: '16 / 9',
  tall: '3 / 4',
  square: '1 / 1',
  splash: '4 / 5',
};

// 竖向动态条漫播放器：格子逐条插入 + 自动下滑 + 每格 TTS + HTML 台词浮层。
// Live2D 由父层在挂载本组件时隐藏；本组件占满全屏黑底。
export function CutsceneScene({ storyboard, bgmUrl, avatarId, onComplete, skippable = true }: CutsceneSceneProps) {
  const panels = normalizeStoryboard(storyboard);
  const [visibleCount, setVisibleCount] = useState(panels.length ? 1 : 0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // 挂载：暂停通知；卸载：恢复 + 停音频/TTS（中途退出不回写，由父层不调 complete 保证）。
  useEffect(() => {
    setPausedNotifications(true);
    return () => {
      setPausedNotifications(false);
      stopSpeaking();
      const audio = audioRef.current;
      if (audio) { audio.pause(); audio.src = ''; }
    };
  }, []);

  // 空 storyboard 兜底：直接完成，不卡死。
  useEffect(() => {
    if (!panels.length) onCompleteRef.current();
  }, [panels.length]);

  // 每当最新一格出现：播 TTS（best-effort）+ 计时，到点插下一格或收尾。
  useEffect(() => {
    const idx = visibleCount - 1;
    const panel = panels[idx];
    if (!panel) return;

    speakPanel(panel, avatarId);

    const timer = setTimeout(() => {
      if (isLastPanel(idx, panels.length)) onCompleteRef.current();
      else setVisibleCount((n) => n + 1);
    }, panelDurationMs(panel));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount]);

  // 新格插入后自动滚到底。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visibleCount]);

  function advance() {
    if (!skippable) return;
    const idx = visibleCount - 1;
    if (isLastPanel(idx, panels.length)) onCompleteRef.current();
    else setVisibleCount((n) => n + 1);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black text-white overflow-y-auto"
      onClick={advance}
      role="dialog"
      aria-label="事件演出"
    >
      <style>{`
        @keyframes cutsceneFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cutsceneSlideUp { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {bgmUrl && <audio ref={audioRef} src={bgmUrl} autoPlay loop className="hidden" aria-label="演出背景音乐" />}

      <div className="mx-auto max-w-md px-3 py-8 space-y-6">
        {panels.slice(0, visibleCount).map((panel) => (
          <figure
            key={panel.panel_index}
            className="relative"
            style={{ animation: `${panel.reveal === 'fade' ? 'cutsceneFade' : 'cutsceneSlideUp'} 0.55s ease-out both` }}
          >
            <div
              className="w-full overflow-hidden rounded-lg bg-white/5 border border-white/10"
              style={{ aspectRatio: ASPECT_RATIO[panel.aspect] }}
            >
              {panel.image_url && (
                <img src={panel.image_url} alt="" className="w-full h-full object-cover" draggable={false} />
              )}
            </div>

            {/* 对白气泡（HTML 浮层，不烤进图） */}
            {panel.dialogue.map((d, i) => (
              <div
                key={i}
                className={`absolute max-w-[70%] rounded-2xl bg-white/90 text-black text-sm px-3 py-2 shadow-lg ${bubblePosClass(d.bubble_pos)}`}
              >
                {d.text}
              </div>
            ))}

            {/* 旁白 caption 条 */}
            {panel.narration && (
              <figcaption className="mt-2 text-center text-sm text-white/80 leading-relaxed">{panel.narration}</figcaption>
            )}
          </figure>
        ))}
        <div ref={bottomRef} className="h-2" />
      </div>
    </div>
  );
}

function bubblePosClass(pos?: string): string {
  switch (pos) {
    case 'top': return 'top-3 left-3';
    case 'top-right': return 'top-3 right-3';
    case 'bottom-right': return 'bottom-3 right-3';
    case 'center': return 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2';
    case 'bottom':
    default: return 'bottom-3 left-3';
  }
}

// 每格 TTS：旁白 + 台词拼一句读，best-effort，失败/无文字都不阻塞演出推进。
function speakPanel(panel: CutscenePanel, avatarId?: string) {
  const text = [panel.narration, ...panel.dialogue.map((d) => d.text)].filter(Boolean).join(' ');
  if (!text) return;
  try {
    const settings = loadStoredTtsSettings();
    void speakText({ text, settings, onMouthChange: () => {}, avatarId }).catch(() => {});
  } catch {
    /* best-effort，忽略 */
  }
}
