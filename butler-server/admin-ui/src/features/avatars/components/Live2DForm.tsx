// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/Live2DForm.tsx(旅程立面子面板,本机版暂无页面引用)
/**
 * 旅程引擎：角色立面 - Live2D 关联子面板。
 *
 * 字段对齐 ALL-200 接口契约：
 * - model_id: 下拉选择现有 Live2D 模型
 * - expression_mappings: 状态 → Live2D 表情参数映射表
 */

import type { CharacterLive2D, Live2dModelSummary } from '@/shared/types';
import { MappingEditor } from '@/features/avatars/components/MappingEditor';

interface Props {
  value: CharacterLive2D;
  availableModels: Live2dModelSummary[];
  onChange: (next: CharacterLive2D) => void;
}

export function Live2DForm({ value, availableModels, onChange }: Props) {
  const selectedModel = availableModels.find((m) => m.id === value.model_id);

  return (
    <div>
      <label>Live2D 模型 *</label>
      {availableModels.length === 0 ? (
        <p className="hint">暂无可用模型，请先上传或配置 Live2D 模型库。</p>
      ) : (
        <select
          value={value.model_id}
          onChange={(e) => onChange({ ...value, model_id: e.target.value })}
        >
          <option value="">请选择模型</option>
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}（{m.id}）
            </option>
          ))}
        </select>
      )}

      {selectedModel?.preview_url && (
        <div style={{ marginTop: 12 }}>
          <img
            src={selectedModel.preview_url}
            alt={`${selectedModel.name} 预览`}
            style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8 }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <MappingEditor
        label="表情参数映射 expression_mappings"
        value={value.expression_mappings}
        onChange={(expression_mappings) => onChange({ ...value, expression_mappings })}
        keyPlaceholder="状态键（如 happy / sad / angry）"
        valuePlaceholder="Live2D 表情参数名"
        emptyHint="暂无表情映射，点击下方按钮添加"
      />

      <p className="hint" style={{ marginTop: 8 }}>
        运行时根据角色当前状态命中映射键，驱动 Live2D 切换到对应表情参数。
      </p>
    </div>
  );
}
