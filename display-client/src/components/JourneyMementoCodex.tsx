import type { Memento } from '../types/journey.ts';

interface JourneyMementoCodexProps {
  memorial: Memento;
}

export function JourneyMementoCodex({ memorial }: JourneyMementoCodexProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-amber-50">
      <div className="w-48 h-64 rounded-lg bg-amber-900/80 border-4 border-amber-600 shadow-2xl flex flex-col items-center justify-center p-4">
        <div className="text-5xl mb-3">📖</div>
        <div className="text-lg font-bold">图鉴</div>
      </div>
      <div className="mt-6 text-center max-w-sm">
        <div className="text-xl font-semibold">{memorial.characterName || '这段旅程'}</div>
        <div className="text-sm opacity-80 mt-1">{memorial.timeline.length} 个珍贵瞬间</div>
      </div>
    </div>
  );
}
