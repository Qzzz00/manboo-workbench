// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/TransformForm.tsx
/**
 * Transform 数字字段编辑。受控。
 * 空值语义：可选 mobile* 字段清空 => undefined（提交时省略）；必填字段保留为 0 起点。
 */
import { useEffect, useRef, useState } from 'react';
import type { ModelTransform, Transform } from '@/shared/types';

interface Props {
  value: Transform;
  onChange: (next: Transform) => void;
}

/**
 * 数字输入。用本地字符串态，允许「负号 / 小数」中间态（如 '-'、'-0.'、'.5'）不被 NaN 清空——
 * 之前 type=number + 直接 Number() 会把刚敲的 '-' 解析成 NaN 当场清空，导致无法输入负数。
 * 仅在「未聚焦」时把外部 value 同步回输入框，避免编辑过程被回填打断。空串 => undefined。
 */
function NumField({
  label,
  value,
  optional,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | undefined;
  optional?: boolean;
  placeholder?: string;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value == null ? '' : String(value));
  }, [value]);
  return (
    <div>
      <label>
        {label}
        {optional ? '' : ' *'}
      </label>
      <input
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
          setText(value == null ? '' : String(value));
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') return onChange(undefined);
          const n = Number(raw);
          if (!Number.isNaN(n)) onChange(n); // 中间态('-'、'-0.')暂不回传，保留输入文字
        }}
      />
    </div>
  );
}

export function TransformForm({ value, onChange }: Props) {
  const set = (patch: Partial<Transform>) => onChange({ ...value, ...patch });
  // 旧数据 / 种子数据可能缺少 modelTransform / transformDefaults，用 ?? {} 兜底避免崩溃
  const setModel = (patch: Partial<Transform['modelTransform']>) =>
    onChange({ ...value, modelTransform: { ...(value.modelTransform ?? {}), ...patch } as Transform['modelTransform'] });
  const setDefaults = (patch: Partial<Transform['transformDefaults']>) =>
    onChange({ ...value, transformDefaults: { ...(value.transformDefaults ?? {}), ...patch } as Transform['transformDefaults'] });

  // 每场景构图（登录页/主页/DJ页）：逐字段编辑；某字段清空即删除该字段，三字段都空即删除整套（回落）。
  // 注意：APP 端只在「scale+offsetX+offsetY 三者齐全」时才采用该套，缺字段会被忽略并回落，故部分填写安全。
  type FramingKey = 'loginFraming' | 'homeFraming' | 'djFraming';
  const setFraming = (key: FramingKey, patch: Partial<ModelTransform>) => {
    const cur: Partial<ModelTransform> = { ...(value[key] ?? {}) };
    (Object.keys(patch) as (keyof ModelTransform)[]).forEach((k) => {
      const v = patch[k];
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    });
    const next = { ...value };
    if (Object.keys(cur).length === 0) delete next[key];
    else next[key] = cur;
    onChange(next);
  };

  /** 可选数字：undefined 时从对象删除该 key，避免提交空值 */
  const setOptional = (key: keyof Transform, v: number | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else (next[key] as number) = v;
    onChange(next);
  };

  return (
    <div>
      <div className="grid-2">
        <NumField label="scaleMultiplier" value={value.scaleMultiplier} onChange={(v) => set({ scaleMultiplier: v ?? 0 })} />
        <NumField label="verticalOffset" value={value.verticalOffset} onChange={(v) => set({ verticalOffset: v ?? 0 })} />
      </div>

      <div className="section-title">移动端适配（可选）</div>
      <div className="grid-3">
        <NumField label="mobileScale" optional value={value.mobileScale} onChange={(v) => setOptional('mobileScale', v)} />
        <NumField
          label="mobileDrawerScaleOffset"
          optional
          value={value.mobileDrawerScaleOffset}
          onChange={(v) => setOptional('mobileDrawerScaleOffset', v)}
        />
        <NumField
          label="mobileDrawerTargetScale"
          optional
          value={value.mobileDrawerTargetScale}
          onChange={(v) => setOptional('mobileDrawerTargetScale', v)}
        />
        <NumField
          label="mobileDrawerOffsetX"
          optional
          value={value.mobileDrawerOffsetX}
          onChange={(v) => setOptional('mobileDrawerOffsetX', v)}
        />
        <NumField
          label="mobileDrawerOffsetY"
          optional
          value={value.mobileDrawerOffsetY}
          onChange={(v) => setOptional('mobileDrawerOffsetY', v)}
        />
        <NumField
          label="mobileInitialOffsetY"
          optional
          value={value.mobileInitialOffsetY}
          onChange={(v) => setOptional('mobileInitialOffsetY', v)}
        />
      </div>

      <div className="section-title">modelTransform *</div>
      <div className="grid-3">
        <NumField label="scale" value={value.modelTransform?.scale} onChange={(v) => setModel({ scale: v ?? 0 })} />
        <NumField label="offsetX" value={value.modelTransform?.offsetX} onChange={(v) => setModel({ offsetX: v ?? 0 })} />
        <NumField label="offsetY" value={value.modelTransform?.offsetY} onChange={(v) => setModel({ offsetY: v ?? 0 })} />
      </div>

      <div className="section-title">transformDefaults *</div>
      <div className="grid-3">
        <NumField label="scale" value={value.transformDefaults?.scale} onChange={(v) => setDefaults({ scale: v ?? 0 })} />
        <NumField label="offsetX" value={value.transformDefaults?.offsetX} onChange={(v) => setDefaults({ offsetX: v ?? 0 })} />
        <NumField label="offsetY" value={value.transformDefaults?.offsetY} onChange={(v) => setDefaults({ offsetY: v ?? 0 })} />
      </div>

      <div className="section-title">登录页构图 ⚠ offsetY 负=上移/正=下移，中性约 -0.98（填 0 或正数角色会下沉甚至看不到）；scale 推荐 0.6~0.8；三项都填才生效，留空=用主页构图</div>
      <div className="grid-3">
        <NumField label="scale 缩放(倍数,如 0.63)" optional placeholder="0.63" value={value.loginFraming?.scale} onChange={(v) => setFraming('loginFraming', { scale: v })} />
        <NumField label="offsetX 左右(可负)" optional placeholder="0" value={value.loginFraming?.offsetX} onChange={(v) => setFraming('loginFraming', { offsetX: v })} />
        <NumField label="offsetY 上下(负=上移,如 -0.98)" optional placeholder="-0.98" value={value.loginFraming?.offsetY} onChange={(v) => setFraming('loginFraming', { offsetY: v })} />
      </div>

      <div className="section-title">主页构图 ⚠ offsetY 负=上移/正=下移，中性约 -0.98（填 0 或正数角色会下沉甚至看不到）；scale 推荐 0.6~0.8；三项都填才生效，留空=自动对齐</div>
      <div className="grid-3">
        <NumField label="scale 缩放(倍数,如 0.63)" optional placeholder="0.63" value={value.homeFraming?.scale} onChange={(v) => setFraming('homeFraming', { scale: v })} />
        <NumField label="offsetX 左右(可负)" optional placeholder="0" value={value.homeFraming?.offsetX} onChange={(v) => setFraming('homeFraming', { offsetX: v })} />
        <NumField label="offsetY 上下(负=上移,如 -0.98)" optional placeholder="-0.98" value={value.homeFraming?.offsetY} onChange={(v) => setFraming('homeFraming', { offsetY: v })} />
      </div>

      <div className="section-title">DJ页构图（完整换装模型） ⚠ offsetY 负=上移/正=下移，DJ 推荐约 -1.15；scale 推荐 0.6~0.8；三项都填才生效</div>
      <div className="grid-3">
        <NumField label="scale 缩放(倍数,如 0.63)" optional placeholder="0.63" value={value.djFraming?.scale} onChange={(v) => setFraming('djFraming', { scale: v })} />
        <NumField label="offsetX 左右(可负)" optional placeholder="0" value={value.djFraming?.offsetX} onChange={(v) => setFraming('djFraming', { offsetX: v })} />
        <NumField label="offsetY 上下(负=上移,如 -1.15)" optional placeholder="-1.15" value={value.djFraming?.offsetY} onChange={(v) => setFraming('djFraming', { offsetY: v })} />
      </div>
    </div>
  );
}
