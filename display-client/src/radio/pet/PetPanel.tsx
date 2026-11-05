// src/radio/pet/PetPanel.tsx
/** 宠物小面板（非全屏 sheet，角色保持可见可喂）：五颗心/状态行/零食盘/累计。
 * ★不进 RadioOverlay 枚举——那个枚举会静音语音收音；面板开着时角色必须活着。 */
import type { PetCounters, PetDerived } from './petState.ts';
import { SNACKS, type SnackId } from './petReactions.ts';

export function PetPanel({ derived, counters, favorite, onClose, onSnackTap }: {
  derived: PetDerived;
  counters: PetCounters;
  favorite: SnackId | null;
  onClose: () => void;
  onSnackTap: (snack: SnackId, sourceEl: HTMLElement) => void;
}) {
  const heartsText = '♥'.repeat(derived.level) + '♡'.repeat(5 - derived.level);
  const status = derived.hunger === 'hungry' ? '🍚 有点饿了'
    : derived.hunger === 'full' ? '🍚 饱饱的' : '🙂 状态不错';
  return (
    <div
      className="pet-panel-backdrop"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <div className="pet-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pet-hearts">{heartsText}</div>
        <div className="pet-status">{status}{derived.sleepy ? ' · 😪 想睡了' : ''}</div>
        <div className="pet-snacks">
          {SNACKS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pet-snack${favorite === s.id ? ' pet-snack--fav' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => onSnackTap(s.id, e.currentTarget)}
            >
              <span className="pet-snack-emoji">{s.emoji}</span>
              <span className="pet-snack-label">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="pet-counters">摸头 {counters.taps} 次 · 喂食 {counters.feeds} 次</div>
      </div>
    </div>
  );
}
