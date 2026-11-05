// 「体感互动」开关：陀螺仪驱动视线跟随 + 摇一摇。
// 属本设备偏好（与设备传感器能力相关），故纯本地存储、不跨设备同步。默认开启。

const KEY = 'llm-live2d:sensor-interaction';

export function loadSensorEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'off') return false;
  } catch { /* ignore */ }
  return true; // 默认开
}

export function saveSensorEnabled(enabled: boolean) {
  try {
    localStorage.setItem(KEY, enabled ? 'on' : 'off');
  } catch { /* ignore */ }
}
