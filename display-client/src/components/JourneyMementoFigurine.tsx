import type { Memento } from '../types/journey.ts';

interface JourneyMementoFigurineProps {
  memorial: Memento;
}

export function JourneyMementoFigurine({ memorial }: JourneyMementoFigurineProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-pink-50">
      <div className="w-44 h-56 rounded-3xl bg-gradient-to-b from-pink-300 to-rose-400 shadow-2xl flex items-center justify-center border-b-8 border-rose-600">
        <span className="text-6xl">🧸</span>
      </div>
      <div className="mt-6 text-center max-w-sm">
        <div className="text-xl font-semibold">{memorial.characterName || '旅途伙伴'}</div>
        <div className="text-sm opacity-80 mt-1">{memorial.derivedSkus?.length ?? 0} 款衍生周边</div>
      </div>
    </div>
  );
}
