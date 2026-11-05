// 桌宠浮窗的用户设置（主 App 侧存储）。浮窗是分离 WebView（appassets 源）、与主 App（localhost 源）
// 不同源不共享 localStorage，故设置在此存储、开浮窗时经 URL 参数下发（见 overlayPlugin.buildPetQuery）。
// 改设置需重启浮窗才生效（stop+start，约 1s）。
export type PetSettings = {
  /** 显示角色对应背景（关=透明悬浮，底部软边渐隐避免「截肢」）。 */
  bg: boolean;
  /** Q 版形态（仅部分角色有对应「变小」参数，如 rattan/estella）。 */
  chibi: boolean;
  /** 陀螺仪朝向：角色随设备倾斜看向（待接）。 */
  gyro: boolean;
  /** 浮窗宽度（dp）。高度由 aspect 推出。 */
  widthDp: number;
  /** 浮窗宽:高 比例，如 '3:4'。 */
  aspect: string;
};

const KEY = 'aiboo:pet-settings';
const DEFAULT: PetSettings = { bg: false, chibi: false, gyro: false, widthDp: 260, aspect: '3:4' };

export function getPetSettings(): PetSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<PetSettings>) };
  } catch {
    return { ...DEFAULT };
  }
}

export function setPetSettings(patch: Partial<PetSettings>): PetSettings {
  const next = { ...getPetSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
