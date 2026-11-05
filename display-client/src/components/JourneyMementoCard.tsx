import type { Memento } from '../types/journey.ts';

interface JourneyMementoCardProps {
  memorial: Memento;
}

export function JourneyMementoCard({ memorial }: JourneyMementoCardProps) {
  const cover = memorial.timeline[0]?.imageRef;
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-slate-50">
      <div className="w-56 h-80 rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-700 shadow-2xl p-4 flex flex-col">
        <div className="text-xs uppercase tracking-wider opacity-70">纪念卡牌</div>
        <div className="flex-1 rounded-xl bg-black/20 my-3 flex items-center justify-center overflow-hidden">
          {cover ? (
            <img src={cover} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-6xl">🃏</span>
          )}
        </div>
        <div className="text-center">
          <div className="font-bold truncate">{memorial.characterName || '旅程纪念'}</div>
          <div className="text-xs opacity-80">{new Date(memorial.completedAt).toLocaleDateString()}</div>
        </div>
      </div>
    </div>
  );
}
