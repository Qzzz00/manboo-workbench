// 掌机桌面原生桥（HandheldPlugin.kt）的 JS 封装：扫 ROM + 用 RetroArch 开游戏。
// 网页环境全部安全回落，绝不向 UI 抛异常——这是桌面，炸了用户就没地方去了。
import { registerPlugin } from '@capacitor/core';
import type { RomEntry } from '../handheld/handheldRoms.ts';

export interface HandheldNative {
  /**
   * 列出目录下的 ROM。dir 相对外部存储根（如 "GBA"）；extensions 不含点。
   * readable=false 表示目录不存在或被分区存储挡住——前端据此区分「没游戏」与「读不到」。
   */
  listRoms(opts: { dir: string; extensions: string[]; maxDepth?: number }): Promise<{
    dir: string;
    readable: boolean;
    roms: RomEntry[];
  }>;
  /**
   * 开一款游戏。app='retroarch' 时必须带 core（核心文件名）；其余不需要
   * （DuckStation/DraStic/PPSSPP 自己管 BIOS 与核心）。
   * switchApp=换游戏时要先杀掉的旧模拟器包名（同一游戏/冷启动传 null，见 handheldLaunchStore）。
   */
  launchRom(
    opts:
      | { path: string; app: 'retroarch'; core: string; switchApp?: string | null }
      | { path: string; app: 'duckstation' | 'drastic' | 'ppsspp'; switchApp?: string | null },
  ): Promise<void>;
  /** 打开某个模拟器本身（不带 ROM），用于进它的设置菜单。 */
  openEmulator(opts: { app: 'retroarch' | 'duckstation' | 'drastic' | 'ppsspp' }): Promise<void>;
  isRetroArchInstalled(): Promise<{ installed: boolean }>;
  /** 当前是不是默认桌面（HOME role）。roleAvailable=false 时该判断走的是旧版兜底（见原生实现注释）。 */
  getLauncherState(): Promise<{ isDefault: boolean; roleAvailable: boolean }>;
  /** 请求把 Aiboo 设为默认桌面；已是默认时直接 granted:true，不弹框。 */
  requestSetAsLauncher(): Promise<{ granted: boolean }>;
  /** 打开系统「主屏幕应用」设置页——查看/换回其他桌面用。 */
  openHomeSettings(): Promise<void>;
  /**
   * 打开系统「无障碍」设置页。侧键 F10 与军师截屏共用 AibooKeyService，
   * 这个授权会被**重装 APK** 和 **force-stop** 两件事清掉，且掉了没有任何提示
   * （症状只是按 F10 没反应）——设置页据此给一键去开回来的入口。
   */
  openAccessibilitySettings(): Promise<void>;
  /** 从游戏底条打开设置后，把 Aiboo 的 HOME task 放回后台，露出原先运行的游戏。 */
  returnToGame(): Promise<{ moved: boolean }>;
}

const Handheld = registerPlugin<HandheldNative>('Handheld');
export default Handheld;
