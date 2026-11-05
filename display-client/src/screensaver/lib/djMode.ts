/**
 * 屏保是否应进入「DJ 联动」状态的单一判定源。
 *
 * 期望行为：仅当主 App 已启动且正处于 DJ 模式时，屏保才显示 DJ 换装形象 + 底部电台卡片；
 * 否则显示未换装的默认形象、且不显示卡片。
 *
 * 真机：主 App 进入/退出 DJ 模式时把状态（带时间戳心跳）写入 SharedPreferences，屏保通过
 * 原生桥 window.AibooNative.isDjModeActive() 读出（新鲜度判定在原生侧：App 被杀/久未活动 → 失活）。
 * 浏览器(dev 预览)：无原生桥，用 ?dj=1 / ?djAvatar=<id> 模拟，方便不接真机也能验证两态。
 */
import { hasNativeBridge, getNativeDjModeActive, getNativeDjAvatarId } from './nativeBridge';

export function isDjModeActive(): boolean {
  if (hasNativeBridge()) return getNativeDjModeActive();
  try {
    return new URLSearchParams(window.location.search).get('dj') === '1';
  } catch {
    return false;
  }
}

/** DJ 激活时的当前角色 id（用于换装映射）；未知返回空串（调用方回落后端/默认）。 */
export function djActiveAvatarId(): string {
  if (hasNativeBridge()) return getNativeDjAvatarId();
  try {
    return new URLSearchParams(window.location.search).get('djAvatar') || '';
  } catch {
    return '';
  }
}
