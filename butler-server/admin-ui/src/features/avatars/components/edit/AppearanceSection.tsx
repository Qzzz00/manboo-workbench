// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/edit/AppearanceSection.tsx
import { TransformForm } from '@/features/avatars/components/TransformForm';
import type { MotionMap, Transform } from '@/shared/types';

/** 外观 / 动作分区：Transform + motions 描述。从 AvatarEdit 拆出。 */
export function AppearanceSection({
  transform,
  setTransform,
  motions,
  setMotions,
}: {
  transform: Transform;
  setTransform: (t: Transform) => void;
  motions: MotionMap;
  setMotions: (m: MotionMap) => void;
}) {
  return (
    <>
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          Transform
        </div>
        <TransformForm value={transform} onChange={setTransform} />
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          Motions 描述
        </div>
        {Object.keys(motions).length === 0 ? (
          <p className="hint">该角色未配置 motions。motions 的 file 指向由 zip 决定，此处仅可编辑描述。</p>
        ) : (
          <div className="list-grid">
            {Object.entries(motions).map(([key, binding]) => (
              <div className="field-row" key={key} title={binding.file}>
                <span className="mono" style={{ minWidth: 72, fontWeight: 600 }}>
                  {key}
                </span>
                <input
                  type="text"
                  placeholder="描述"
                  value={binding.description ?? ''}
                  onChange={(e) =>
                    setMotions({ ...motions, [key]: { ...binding, description: e.target.value } })
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
