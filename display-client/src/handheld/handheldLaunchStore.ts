// 记住「上次从桌面开的是哪个游戏」，用于换游戏时决定要不要杀掉旧模拟器进程。
//
// 为什么要持久化而不是内存变量：按 HOME 回桌面时 App 走 pause→resume（同一 WebView），
// 内存能撑住；但进程被系统回收后重建 localStorage 才留得住。而且换游戏这条链路本来就横跨
// 「开 A → 回桌面 → 开 B」，中间隔着一次前后台切换，稳妥起见落盘。

import type { LaunchTarget } from './handheldRoms.ts';

const KEY = 'aiboo:handheld-last-launched';

/** 模拟器包名（与 HandheldPlugin.kt 的常量一致；前端要它来算 switchApp 杀谁）。 */
export const PACKAGE_BY_APP: Record<LaunchTarget['app'], string> = {
  retroarch: 'com.retroarch.aarch64',
  duckstation: 'com.github.stenzek.duckstation',
  drastic: 'com.dsemu.drastic',
  ppsspp: 'org.ppsspp.ppsspp',
};

export type LastLaunched = { pkg: string; romPath: string };

export function loadLastLaunched(): LastLaunched | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastLaunched>;
    if (typeof v?.pkg === 'string' && typeof v?.romPath === 'string') {
      return { pkg: v.pkg, romPath: v.romPath };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLastLaunched(v: LastLaunched): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 存不了不影响本次启动；顶多下次换游戏少杀一次（无害，见 switchAppFor 注释） */
  }
}

/**
 * 开一款游戏前要杀掉的模拟器包名（null=不杀）。
 *
 * 语义（与原厂桌面「新游戏杀掉重开 / 旧游戏切回前台」一致）：
 *   - 点的正是上次 Aiboo 开的那一款（pkg+romPath 全同）→ null（continue，切回前台保住现场）
 *   - 其余一律返回**这次要用的模拟器包名** nextPkg，先杀掉再开。
 *
 * ★为什么默认就杀、而不是「只有换游戏才杀」：模拟器的仿真 Activity 是常驻单例，只要它那个
 * task 还在（哪怕进程被系统回收、哪怕是用户在 Aiboo 之外自己开的、哪怕是上个 Aiboo 会话遗留的），
 * 不 CLEAR_TASK + 杀进程就会被旧 intent 重建 = 开出旧游戏。Aiboo 只认得自己开过的游戏
 * （lastLaunched），认不出这些「外来/遗留」的 task——所以不能靠「last 是不是换了」来决定杀不杀，
 * 只能默认杀，唯一例外是「明确在 continue 同一款」。真机实锤：lastLaunched 为空但残留 t186(漆黑)
 * 时，旧逻辑判 null → 开 召唤之夜 却弹出漆黑。
 *
 * ★杀不存在的进程是 no-op（killBackgroundProcesses 对没在跑的包无害），所以冷启动/跨模拟器
 * 多杀一下都不出问题。按 romPath 判 continue：两款 GBA 都走 RetroArch，pkg 同但换 ROM 也要重开。
 */
export function switchAppFor(
  last: LastLaunched | null,
  nextPkg: string,
  nextRomPath: string,
): string | null {
  if (last && last.pkg === nextPkg && last.romPath === nextRomPath) return null;
  return nextPkg;
}
