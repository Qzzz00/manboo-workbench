import { useState } from 'react';
import { createPortal } from 'react-dom';

import { getPetSettings, setPetSettings, type PetSettings } from '../lib/petSettingsStore';
import { overlaySetDimensions } from '../lib/overlayPlugin';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 设置变化后回调（父层据此重启浮窗使之生效）。 */
  onChange: (next: PetSettings) => void;
};

type Row = { key: keyof PetSettings; label: string; desc: string; disabled?: boolean };
const ROWS: Row[] = [
  { key: 'bg', label: '显示背景', desc: '关=透明悬浮（底部渐隐）；开=角色背景，遮住裁切边' },
  { key: 'chibi', label: 'Q 版形态', desc: '仅部分角色（如 Rattan）：矮身大头、全身展示' },
  { key: 'gyro', label: '陀螺仪朝向', desc: '角色随设备倾斜看向' },
];

const ASPECTS = [
  { value: '3:4', label: '竖 3:4' },
  { value: '1:1', label: '方 1:1' },
  { value: '9:16', label: '长 9:16' },
];

/** 桌宠设置底部弹窗：三开关（背景/Q版/陀螺仪）。改动即存 localStorage + 回调父层重启浮窗。 */
export function PetSettingsModal({ open, onClose, onChange }: Props) {
  const [s, setS] = useState<PetSettings>(() => getPetSettings());
  if (!open) return null;

  const toggle = (key: keyof PetSettings) => {
    const next = setPetSettings({ [key]: !s[key] });
    setS(next);
    onChange(next);
  };

  // 挂到 document.body：主 App 根容器有 transform: translateZ(0)，会让内部 position:fixed 相对它、
  // 导致弹窗点击盒与视觉错位（点不动）。portal 出去即真正相对视口。
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480, background: '#1c1c22', color: '#fff',
          borderRadius: '16px 16px 0 0', padding: '18px 18px 28px',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 14 }}>桌宠设置</div>
        {ROWS.map((r) => (
          <div
            key={r.key}
            onClick={() => !r.disabled && toggle(r.key)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 4px', opacity: r.disabled ? 0.45 : 1,
              cursor: r.disabled ? 'default' : 'pointer',
            }}
          >
            <div style={{ flex: 1, paddingRight: 12 }}>
              <div style={{ fontSize: 15 }}>{r.label}{r.disabled ? '（待接）' : ''}</div>
              <div style={{ fontSize: 12, color: '#9a9aa5', marginTop: 3 }}>{r.desc}</div>
            </div>
            <div
              style={{
                width: 44, height: 26, borderRadius: 13, flexShrink: 0,
                background: s[r.key] ? '#4f8cff' : '#3a3a44', position: 'relative',
                transition: 'background 0.15s',
              }}
            >
              <span
                style={{
                  position: 'absolute', top: 3, left: s[r.key] ? 21 : 3,
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.15s',
                }}
              />
            </div>
          </div>
        ))}

        {/* 大小（实时，不重启） */}
        <div style={{ padding: '12px 4px' }}>
          <div style={{ fontSize: 15, marginBottom: 8 }}>大小</div>
          <input
            type="range" min={140} max={360} step={4} value={s.widthDp}
            onChange={(e) => {
              const next = setPetSettings({ widthDp: Number(e.target.value) });
              setS(next);
              void overlaySetDimensions(next.widthDp, next.aspect);
            }}
            style={{ width: '100%' }}
          />
        </div>

        {/* 比例（实时） */}
        <div style={{ padding: '12px 4px' }}>
          <div style={{ fontSize: 15, marginBottom: 8 }}>比例</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                type="button"
                onClick={() => {
                  const next = setPetSettings({ aspect: a.value });
                  setS(next);
                  void overlaySetDimensions(next.widthDp, next.aspect);
                }}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: s.aspect === a.value ? '#4f8cff' : '#3a3a44', color: '#fff', fontSize: 13,
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#9a9aa5', marginTop: 10, textAlign: 'center' }}>
          开关改动会重启浮窗；大小/比例实时生效
        </div>
      </div>
    </div>,
    document.body,
  );
}
