// src/radio/pet/PetBadge.tsx
/** DJ 页左上角迷你角标：❤️+等级；提醒时旁边冒气泡。stopPropagation 挡住切页/触摸手势。 */
export function PetBadge({ level, bubble, onOpen }: {
  level: number;
  bubble: string | null;
  onOpen: () => void;
}) {
  return (
    <div className="pet-badge-wrap">
      <button
        type="button"
        className="pet-badge"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={onOpen}
      >
        <span className="pet-badge-heart">❤️</span>
        <span className="pet-badge-level">Lv{level}</span>
      </button>
      {bubble ? <div className="pet-bubble">{bubble}</div> : null}
    </div>
  );
}
