import { useEffect, useMemo, useState } from 'react';
import type { Memento, MementoForm } from '../types/journey.ts';
import { apiGet } from '../lib/apiClient.ts';
import { JourneyMementoCard } from './JourneyMementoCard.tsx';
import { JourneyMementoCodex } from './JourneyMementoCodex.tsx';
import { JourneyMementoFigurine } from './JourneyMementoFigurine.tsx';
import { JourneyMementoStatue } from './JourneyMementoStatue.tsx';

interface JourneyMementoProps {
  /** 已拉取到的纪念物数据。 */
  memorial?: Memento;
  onClose?: () => void;
}

/**
 * 当 memorial 未传时，组件会尝试拉取 /api/journey/memorial。
 * 形态决策优先级：memorial.endingRhythm fallback（结局已不携带模板 id，ALL-421）。
 */
export function JourneyMemento({ memorial: initialMemorial, onClose }: JourneyMementoProps) {
  const [memorial, setMemorial] = useState<Memento | undefined>(initialMemorial);
  const [loading, setLoading] = useState(!initialMemorial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialMemorial) return;

    let cancelled = false;
    setLoading(true);
    apiGet('/api/journey/memorial')
      .then((res) => {
        if (cancelled) return;
        setMemorial(res as Memento);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载纪念物失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [initialMemorial]);

  const form: MementoForm = useMemo(() => {
    // 契约当前只保证 Memorial.endingRhythm，按 rhythm 兜底映射
    switch (memorial?.endingRhythm) {
      case 'warm':
        return 'card';
      case 'bittersweet':
        return 'figurine';
      case 'open':
        return 'codex';
      case 'reflective':
        return 'statue';
      case 'celebratory':
        return 'figurine';
      default:
        return 'codex';
    }
  }, [memorial]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 bg-black/90 text-white flex items-center justify-center">
        正在唤醒纪念物…
      </div>
    );
  }

  if (error || !memorial) {
    return (
      <div className="fixed inset-0 z-50 bg-black/90 text-white flex flex-col items-center justify-center p-6">
        <div className="text-4xl mb-4">🍂</div>
        <div className="text-center opacity-80">{error || '暂无纪念物'}</div>
        {onClose && (
          <button
            className="mt-6 px-6 py-2 rounded-full border border-white/30 hover:bg-white/10"
            onClick={onClose}
          >
            返回
          </button>
        )}
      </div>
    );
  }

  const content = (() => {
    switch (form) {
      case 'card':
        return <JourneyMementoCard memorial={memorial} />;
      case 'statue':
        return <JourneyMementoStatue memorial={memorial} />;
      case 'figurine':
        return <JourneyMementoFigurine memorial={memorial} />;
      case 'codex':
      default:
        return <JourneyMementoCodex memorial={memorial} />;
    }
  })();

  return (
    <div className="fixed inset-0 z-50 bg-black/95 text-white flex flex-col">
      <div className="flex-1 overflow-auto flex items-center justify-center">{content}</div>
      {memorial.derivedSkus && memorial.derivedSkus.length > 0 && (
        <div className="p-4 border-t border-white/10">
          <div className="text-xs uppercase tracking-wider opacity-60 mb-2">衍生 SKU</div>
          <div className="flex gap-3 overflow-x-auto">
            {memorial.derivedSkus.map((sku) => (
              <div
                key={sku.skuId}
                className="flex-shrink-0 w-24 rounded-lg bg-white/10 p-2 text-center"
              >
                {sku.previewUrl ? (
                  <img src={sku.previewUrl} alt="" className="w-full h-16 object-cover rounded mb-1" />
                ) : (
                  <div className="w-full h-16 rounded bg-white/5 flex items-center justify-center text-xl">🎁</div>
                )}
                <div className="text-xs truncate">{sku.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {onClose && (
        <div className="p-4 flex justify-center">
          <button
            className="px-6 py-2 rounded-full border border-white/30 hover:bg-white/10"
            onClick={onClose}
          >
            珍藏
          </button>
        </div>
      )}
    </div>
  );
}
