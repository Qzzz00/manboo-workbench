/**
 * 主 App → 原生：上报「是否正处于 DJ 模式 + 当前 DJ 角色」。
 *
 * 原生侧（DjState 插件）把状态写入 ScreensaverPrefs(SharedPreferences)，充电屏保 DreamService
 * 读取后联动：DJ 模式 → 换装形象 + 电台卡片；否则 → 未换装形象 + 无卡片。
 *
 * 非原生环境（浏览器 dev）下静默 no-op。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface DjStatePlugin {
  setDjMode(options: { active: boolean; avatarId: string }): Promise<void>;
  getDeviceLocation(): Promise<{ lat?: number; lon?: number; city?: string }>;
  // 通勤播客：原生前台 Service 播放（锁屏后台续播）。
  commuteStart(options: { episodeId: string; voiceUrls: string[]; startIndex: number; bedUrl: string }): Promise<void>;
  commutePause(): Promise<void>;
  commuteResume(): Promise<void>;
  commuteStop(): Promise<void>;
  commuteSeekIndex(options: { index: number }): Promise<void>;
  commuteState(): Promise<Partial<CommuteNativeState>>;
  // DJ 音乐模式（默认/工作/学习/休息）：整段歌单交原生前台 Service 循环播放（锁屏续播+控制）。
  // 控制/状态复用 commutePause/Resume/Stop/SeekIndex/State（同一个 Service）。
  musicStart(options: {
    sessionId: string;
    urls: string[];
    titles: string[];
    artists: string[];
    artworks: string[];
    startIndex: number;
    startPositionMs: number;
    title: string;
  }): Promise<void>;
  audioDuck(): Promise<void>;
  audioUnduck(): Promise<void>;
  /** DJ 音乐模式的口播：交给原生 bedPlayer 播（WebView <audio> 在展示台那台 ROM 上放不出声）。 */
  audioSpeak(options: { url: string }): Promise<void>;
  audioSpeakStop(): Promise<void>;
  musicSetArtwork(options: { index: number; url: string }): Promise<void>;
}

const DjState = registerPlugin<DjStatePlugin>('DjState');

/** 原生通勤播放状态快照。 */
export type CommuteNativeState = {
  episodeId: string;
  index: number;
  total: number;
  positionMs: number;
  playing: boolean;
  ended: boolean;
  active: boolean;
};

/** 当前环境是否具备原生通勤播放能力（原生 App → 是；dev 浏览器 → 否，回落 WebView JS 播放）。 */
export function hasNativeCommute(): boolean {
  return Capacitor.isNativePlatform();
}

/** 起播一期通勤播客。成功返回 true；原生不可用/失败返回 false（调用方回落 JS 播放）。 */
export async function commuteStartNative(
  episodeId: string,
  voiceUrls: string[],
  startIndex: number,
  bedUrl: string,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await DjState.commuteStart({ episodeId, voiceUrls, startIndex, bedUrl });
    return true;
  } catch {
    return false;
  }
}

export function commutePauseNative(): void {
  if (Capacitor.isNativePlatform()) DjState.commutePause().catch(() => {});
}

export function commuteResumeNative(): void {
  if (Capacitor.isNativePlatform()) DjState.commuteResume().catch(() => {});
}

export function commuteStopNative(): void {
  if (Capacitor.isNativePlatform()) DjState.commuteStop().catch(() => {});
}

export function commuteSeekIndexNative(index: number): void {
  if (Capacitor.isNativePlatform()) DjState.commuteSeekIndex({ index }).catch(() => {});
}

/** DJ 音乐模式：把当前时段整段歌单（含逐曲元数据）交原生前台 Service 循环播放。失败返回 false。 */
export async function musicStartNative(opts: {
  sessionId: string;
  urls: string[];
  titles: string[];
  artists: string[];
  artworks: string[];
  startIndex: number;
  startPositionMs: number;
  title: string;
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await DjState.musicStart(opts);
    return true;
  } catch {
    return false;
  }
}

/** 封面懒取回填：把某首歌封面补给原生 MediaSession（锁屏显示封面）。亮屏时触发即可。 */
export function musicSetArtworkNative(index: number, url: string): void {
  if (Capacitor.isNativePlatform() && url) DjState.musicSetArtwork({ index, url }).catch(() => {});
}

/** 口播插播时压低原生音乐 / 插播结束恢复（仅亮屏时由 WebView 触发）。 */
export function audioDuckNative(): void {
  if (Capacitor.isNativePlatform()) DjState.audioDuck().catch(() => {});
}
export function audioUnduckNative(): void {
  if (Capacitor.isNativePlatform()) DjState.audioUnduck().catch(() => {});
}

/** 口播交原生播。非原生环境（浏览器调试）返回 false，调用方据此回落 WebView 那条路。 */
export function audioSpeakNative(url: string): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  DjState.audioSpeak({ url }).catch(() => {});
  return true;
}

export function audioSpeakStopNative(): void {
  if (Capacitor.isNativePlatform()) DjState.audioSpeakStop().catch(() => {});
}

export async function commuteStateNative(): Promise<CommuteNativeState | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const v = await DjState.commuteState();
    return {
      episodeId: String(v.episodeId ?? ''),
      index: Number(v.index ?? 0),
      total: Number(v.total ?? 0),
      positionMs: Number(v.positionMs ?? 0),
      playing: !!v.playing,
      ended: !!v.ended,
      active: !!v.active,
    };
  } catch {
    return null;
  }
}

/**
 * 主 App → 原生：取设备最近已知位置（lat/lon）。供 DJ 口播跟随本地天气。
 * 非原生/未授权/取不到返回 null；城市名由 JS 侧反查。
 */
export async function getNativeDeviceLocation(): Promise<{ lat: number; lon: number; city?: string } | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const r = await DjState.getDeviceLocation();
    if (r && typeof r.lat === 'number' && typeof r.lon === 'number') {
      return { lat: r.lat, lon: r.lon, city: typeof r.city === 'string' ? r.city : undefined };
    }
  } catch {
    /* 原生不可用：忽略 */
  }
  return null;
}

/** 上报 DJ 模式状态。进入/退出 DJ 模式时调用；DJ 模式期间需定期心跳调用以刷新时间戳。 */
export function reportDjMode(active: boolean, avatarId: string): void {
  if (!Capacitor.isNativePlatform()) return;
  DjState.setDjMode({ active, avatarId: avatarId || '' }).catch(() => {
    /* 原生不可用时忽略，不影响主流程 */
  });
}
