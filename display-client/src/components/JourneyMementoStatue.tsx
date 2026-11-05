import type { Memento } from '../types/journey.ts';

interface JourneyMementoStatueProps {
  memorial: Memento;
}

export function JourneyMementoStatue({ memorial }: JourneyMementoStatueProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-stone-50">
      <div className="relative w-40 h-56 rounded-t-full bg-gradient-to-b from-stone-300 to-stone-500 shadow-2xl flex items-center justify-center">
        <span className="text-6xl">🗿</span>
      </div>
      <div className="w-48 h-4 rounded-full bg-stone-600 mt-1" />
      <div className="mt-6 text-center max-w-sm">
        <div className="text-xl font-semibold">{memorial.characterName || '永恒雕像'}</div>
        <div className="text-sm opacity-80 mt-1">{memorial.timeline.length} 段回忆铸成</div>
      </div>
    </div>
  );
}
