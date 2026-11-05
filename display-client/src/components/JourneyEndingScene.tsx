import { useEffect, useRef, useState } from 'react';
import type { JourneyEnding } from '../types/journey.ts';
import { setPausedNotifications } from '../lib/journeyStore.ts';
import { useCrisisResources } from '../hooks/useCrisisResources.ts';
import { CrisisResourceReminder } from './CrisisResourceReminder.tsx';

interface JourneyEndingSceneProps {
  ending: JourneyEnding;
  onClose: () => void;
}

export function JourneyEndingScene({ ending, onClose }: JourneyEndingSceneProps) {
  const [visibleLines, setVisibleLines] = useState(0);
  const lines = ending.content.split('\n').filter(Boolean);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const crisisResources = useCrisisResources();

  useEffect(() => {
    setPausedNotifications(true);
    const audio = audioRef.current;
    return () => {
      setPausedNotifications(false);
      if (audio) {
        audio.pause();
        audio.src = '';
      }
    };
  }, []);

  useEffect(() => {
    if (visibleLines < lines.length) {
      const timer = setTimeout(() => setVisibleLines((n) => n + 1), 1200);
      return () => clearTimeout(timer);
    }
  }, [visibleLines, lines.length]);

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col items-center justify-center p-6">
      {ending.bgm_url && (
        <audio
          ref={audioRef}
          src={ending.bgm_url}
          autoPlay
          loop
          className="hidden"
          aria-label="结局背景音乐"
        />
      )}

      <div className="text-2xl font-bold mb-6">结局</div>

      {/* Live2D 占位区：后续可挂载与结局氛围匹配的角色镜头/动画 */}
      <div className="journey-ending-live2d w-48 h-48 md:w-64 md:h-64 rounded-full border border-white/10 bg-white/5 mb-6 flex items-center justify-center">
        <span className="text-sm text-white/40">Live2D</span>
      </div>

      <div className="max-w-md space-y-4 text-center">
        {lines.slice(0, visibleLines).map((line, idx) => (
          <div key={idx} className="text-lg opacity-0 animate-fade-in" style={{ animation: 'fadeIn 0.8s forwards' }}>
            {line}
          </div>
        ))}
      </div>
      {visibleLines >= lines.length && (
        <>
          <CrisisResourceReminder resources={crisisResources} className="mt-8 max-w-md text-left text-slate-900" />
          <button className="mt-12 px-6 py-2 rounded-full border border-white/50 hover:bg-white/10" onClick={onClose}>
            珍藏这段旅程
          </button>
        </>
      )}
      <style>{`@keyframes fadeIn { to { opacity: 1; } }`}</style>
    </div>
  );
}
