import { useEffect, useState } from 'react';
import type { PickupResult } from '../types/journey.ts';

interface JourneyPickupOverlayProps {
  pickup: PickupResult;
  onReveal: () => void;
}

export function JourneyPickupOverlay({ pickup, onReveal }: JourneyPickupOverlayProps) {
  const [revealed, setRevealed] = useState(pickup.mode === 'pickup' || pickup.mode === 'pickup_short');

  useEffect(() => {
    if (pickup.mode === 'pickup_delayed' && pickup.latency_ms) {
      const timer = setTimeout(() => {
        setRevealed(true);
        onReveal();
      }, pickup.latency_ms);
      return () => clearTimeout(timer);
    }
    if (pickup.mode === 'no_pickup' && pickup.deferred_response_at) {
      const delay = Math.max(0, pickup.deferred_response_at - Date.now());
      const timer = setTimeout(() => {
        setRevealed(true);
        onReveal();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [pickup, onReveal]);

  if (revealed) return null;

  const messages: Record<typeof pickup.mode, string> = {
    pickup: '已接通',
    pickup_short: '她今天话不多...',
    pickup_delayed: `她在${pickup.location || '路上'}，慢半拍...`,
    pickup_voice_memo: '她在健身房，回复会是语音备忘',
    no_pickup: pickup.reason || '她现在没接，稍后给你回',
  };

  return (
    <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
      <div className="bg-white rounded-2xl p-6 text-center max-w-xs">
        <div className="text-lg font-medium text-slate-800">{messages[pickup.mode]}</div>
        {pickup.mode === 'pickup_delayed' && (
          <div className="mt-3 w-8 h-8 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin mx-auto" />
        )}
      </div>
    </div>
  );
}
