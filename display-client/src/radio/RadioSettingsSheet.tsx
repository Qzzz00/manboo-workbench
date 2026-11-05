// 电台设置：DJ 角色切换 + Wi-Fi/蓝牙/默认桌面直达系统设置 + 后台播放保护 + 重扫 + 关于。
import RadioLauncher from '../lib/radioLauncherPlugin.ts';
import { RADIO_DJ_OPTIONS } from './radioDjAvatar.ts';

const open = (section: 'wifi' | 'bluetooth' | 'home' | 'settings') => () =>
  void RadioLauncher.openSystemSettings({ section }).catch(() => {});

// 首启弹窗被拒后的手动补救入口：重新拉起电池优化豁免授权（无豁免则 careai ROM 灭屏约12分钟杀播放）。
const requestExemption = () => void RadioLauncher.requestBatteryExemption().catch(() => {});

export function RadioSettingsSheet({
  onRescan,
  onClose,
  djId,
  onSelectDj,
  voiceVolume,
  onVoiceVolume,
}: {
  onRescan: () => void;
  onClose: () => void;
  djId: string;
  onSelectDj: (id: string) => void;
  /** 叫声音量 0..1（独立于音乐/系统音量，见 radioVoiceVolume.ts）。 */
  voiceVolume: number;
  onVoiceVolume: (v: number) => void;
}) {
  return (
    <div className="radio-sheet">
      <div className="radio-sheet-head">
        <div className="radio-sheet-title">设置</div>
        <button className="radio-sheet-close" onClick={onClose}>✕</button>
      </div>
      <div className="radio-sheet-body">
        <div className="radio-settings">
          <div className="radio-dj-picker">
            <div className="radio-dj-picker-label">电台角色</div>
            <div className="radio-dj-picker-row">
              {RADIO_DJ_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={`radio-dj-chip${opt.id === djId ? ' radio-dj-chip--on' : ''}`}
                  onClick={() => onSelectDj(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="radio-voice-vol">
            <div className="radio-voice-vol-label">
              <span>叫声音量</span>
              <span className="radio-voice-vol-val">{Math.round(voiceVolume * 100)}%</span>
            </div>
            <input
              className="radio-voice-vol-range"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(voiceVolume * 100)}
              onChange={(e) => onVoiceVolume(Number(e.currentTarget.value) / 100)}
              aria-label="叫声音量"
            />
          </div>
          <button onClick={open('wifi')}>Wi-Fi 设置</button>
          <button onClick={open('bluetooth')}>蓝牙设置</button>
          <button onClick={open('home')}>更换默认桌面</button>
          <button onClick={open('settings')}>系统设置</button>
          <button onClick={requestExemption}>后台播放保护</button>
          <button onClick={onRescan}>重新扫描音乐</button>
          <div className="radio-about">Aiboo电台 · U3 · com.aiboo.radio</div>
        </div>
      </div>
    </div>
  );
}
