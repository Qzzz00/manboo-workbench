// U3 电台桌面（RadioLauncher）插件 JS 封装：构建标志 / 本地音乐 / 播放控制 / 应用抽屉 / 系统设置直达。
// 网页环境全部安全回落，绝不向 UI 抛异常。
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PlaybackSnapshotRaw } from '../radio/radioState.ts';

export type { PlaybackSnapshotRaw };

export interface RadioLauncherNative {
  /** kind = 原生 BuildConfig.LAUNCHER_KIND（none/radio/handheld）。
   *  isLauncher 为兼容旧原生包保留（kind 出现之前唯一的桌面标志）。 */
  getLauncherInfo(): Promise<{ isLauncher: boolean; kind?: string }>;
  hasAudioPermission(): Promise<{ granted: boolean }>;
  requestAudioPermission(): Promise<void>;
  scanAudio(): Promise<{ granted: boolean; tracks: unknown[] }>;
  getAlbumArt(opts: { trackId: string }): Promise<{ dataUrl: string }>;
  setQueue(opts: {
    tracks: { uri: string; title: string; artist: string; album: string }[];
    startIndex: number;
    /** 缺省 true=setQueue 后自动播放；false=就绪但暂停（冷启恢复上次曲目时用，不炸音乐）。 */
    playWhenReady?: boolean;
  }): Promise<void>;
  playbackControl(opts: {
    op: 'toggle' | 'next' | 'prev' | 'playAt' | 'seekTo';
    index?: number;
    positionMs?: number;
  }): Promise<void>;
  getPlaybackState(): Promise<PlaybackSnapshotRaw>;
  addListener(
    eventName: 'playbackState',
    cb: (s: PlaybackSnapshotRaw) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  /** SD 卡挂载/弹出后触发（原生侧 2s 去抖），前端订阅后应重扫曲库。 */
  addListener(
    eventName: 'mediaChanged',
    cb: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
  listApps(): Promise<{ apps: { pkg: string; label: string; icon: string }[] }>;
  launchApp(opts: { pkg: string }): Promise<void>;
  /** 绝对设定媒体音量（AudioManager STREAM_MUSIC），value ∈ [0,1]，越界钳制。 */
  setVolume(opts: { value: number }): Promise<void>;
  /** 相对增减媒体音量，delta ∈ [-1,1] 分数，至少变动一档。 */
  adjustVolume(opts: { delta: number }): Promise<void>;
  /** 读当前媒体音量归一值 0..1。 */
  getVolume(): Promise<{ value: number }>;
  openSystemSettings(opts: { section: 'wifi' | 'bluetooth' | 'home' | 'settings' }): Promise<void>;
  /** 是否已在电池优化白名单（careai ROM 不豁免则灭屏约12分钟按 app-idle 杀播放服务）。 */
  getBatteryExemption(): Promise<{ exempt: boolean }>;
  /** 拉起系统「忽略电池优化」授权弹窗（u3 manifest 声明 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。 */
  requestBatteryExemption(): Promise<void>;
}

const RadioLauncher = registerPlugin<RadioLauncherNative>('RadioLauncher');
export default RadioLauncher;

/**
 * 纯函数：决定挂哪个根（可测）。
 * launcherKind 来自原生 BuildConfig.LAUNCHER_KIND（none/radio/handheld）。
 * ?radio=1 / ?handheld=1 供浏览器开发强制指定根。
 * ★未知 kind 一律回落主 App——桌面白屏是致命的，宁可挂错根也不能不挂。
 */
export function resolveRootKind(opts: {
  isNative: boolean;
  search: string;
  launcherKind: string;
}): 'radio' | 'handheld' | 'app' {
  const q = new URLSearchParams(opts.search);
  if (q.get('radio') === '1') return 'radio';
  if (q.get('handheld') === '1') return 'handheld';
  if (opts.isNative && opts.launcherKind === 'radio') return 'radio';
  if (opts.isNative && opts.launcherKind === 'handheld') return 'handheld';
  return 'app';
}

/**
 * 首启电池优化豁免引导：未豁免则拉起系统授权弹窗。
 * careai ROM 会在灭屏约 12 分钟后按 app-idle 杀前台播放服务（task-10 实锤），豁免是电台不断播的生命线。
 * 已豁免/网页环境/查询失败都静默跳过；被拒后下次冷启动会再次引导（设置页也有手动入口）。
 */
export async function ensureBatteryExemption(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { exempt } = await RadioLauncher.getBatteryExemption();
    console.log('[battery-exemption] exempt=', exempt);
    if (!exempt) await RadioLauncher.requestBatteryExemption();
  } catch (e) {
    // 原生方法缺失/旧包混跑等异常一律不阻塞电台启动；留 console 供真机 logcat(Capacitor/Console) 排障
    console.log('[battery-exemption] failed:', e);
  }
}

/** 启动时探测入口根：原生查 BuildConfig 标志，失败/网页回落主 App。 */
export async function detectRootKind(): Promise<'radio' | 'handheld' | 'app'> {
  let launcherKind = 'none';
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await RadioLauncher.getLauncherInfo();
      // 旧原生包没有 kind 字段：用 isLauncher 兜底当电台——那是 kind 出现之前唯一的桌面形态，
      // 猜错了也只会把旧电台包挂回电台根，不会白屏。
      launcherKind = info.kind ?? (info.isLauncher ? 'radio' : 'none');
    } catch {
      launcherKind = 'none';
    }
  }
  return resolveRootKind({
    isNative: Capacitor.isNativePlatform(),
    search: window.location.search,
    launcherKind,
  });
}
