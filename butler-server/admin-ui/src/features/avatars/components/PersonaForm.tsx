// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/PersonaForm.tsx
/** 人设编辑：tone（文本）+ traits[] / styleRules[]（字符串数组增删改）。受控组件。 */
import type { Persona } from '@/shared/types';

interface Props {
  value: Persona;
  onChange: (next: Persona) => void;
}

function StringListEditor({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const update = (i: number, v: string) => onChange(items.map((it, idx) => (idx === i ? v : it)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);
  return (
    <div>
      <label>{label}</label>
      {items.length === 0 && <p className="hint">暂无，点击下方按钮添加</p>}
      <div className="list-grid">
        {items.map((it, i) => (
          <div className="field-row" key={i}>
            <input
              type="text"
              value={it}
              placeholder={placeholder}
              onChange={(e) => update(i, e.target.value)}
            />
            <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(i)}>
              删除
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" onClick={add}>
        + 添加一项
      </button>
    </div>
  );
}

export function PersonaForm({ value, onChange }: Props) {
  return (
    <div>
      <label>语气 tone *</label>
      <textarea
        value={value.tone}
        placeholder="例如：温柔、开朗、情感充沛"
        onChange={(e) => onChange({ ...value, tone: e.target.value })}
      />
      <StringListEditor
        label="性格特质 traits"
        items={value.traits}
        placeholder="例如：善良"
        onChange={(traits) => onChange({ ...value, traits })}
      />
      <StringListEditor
        label="说话风格 styleRules"
        items={value.styleRules}
        placeholder="例如：说话清晰温暖"
        onChange={(styleRules) => onChange({ ...value, styleRules })}
      />
    </div>
  );
}
