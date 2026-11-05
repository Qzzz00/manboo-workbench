// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/MappingEditor.tsx
/**
 * 通用键值映射编辑器：状态 / 情绪 → Live2D 表情参数 / TTS 情绪参数。
 * 用于 Live2DForm.expression_mappings 与 VoiceForm.emotion_mappings。
 */

interface Props {
  label: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyHint?: string;
}

export function MappingEditor({
  label,
  value,
  onChange,
  keyPlaceholder = '状态键（如 happy）',
  valuePlaceholder = '参数值',
  emptyHint = '暂无映射，点击下方按钮添加',
}: Props) {
  const entries = Object.entries(value);

  const updateKey = (oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    const next = { ...value };
    const v = next[oldKey];
    delete next[oldKey];
    if (newKey.trim() !== '') {
      next[newKey.trim()] = v;
    }
    onChange(next);
  };

  const updateValue = (key: string, newValue: string) => {
    onChange({ ...value, [key]: newValue });
  };

  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };

  const add = () => {
    // 避免连续点击产生多个空键行
    if (entries.some(([k]) => k.trim() === '')) return;
    onChange({ ...value, '': '' });
  };

  return (
    <div>
      <label>{label}</label>
      {entries.length === 0 && <p className="hint">{emptyHint}</p>}
      {entries.map(([k, v]) => (
        <div className="field-row" key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => {
              const newKey = e.target.value.trim();
              if (newKey === '') return;
              updateKey(k, newKey);
            }}
            onBlur={(e) => {
              if (e.target.value.trim() === '') remove(k);
            }}
            style={{ flex: 1 }}
          />
          <span style={{ color: 'var(--slate-400)' }}>→</span>
          <input
            type="text"
            value={v}
            placeholder={valuePlaceholder}
            onChange={(e) => updateValue(k, e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(k)}>
            删除
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={add}>
        + 添加映射
      </button>
    </div>
  );
}
