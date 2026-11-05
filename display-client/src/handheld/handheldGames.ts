// 掌机桌面的模拟器识别与排序。
//
// RadioLauncher.listApps() 吐的是**全部**可启动应用（掌机上实测除 17 个模拟器外还有一堆
// 系统应用），游戏格要把模拟器挑到前面。判据走包名白名单 + 明确前缀，理由见 isEmulatorPackage。
import type { AppEntry } from '../radio/AppDrawerSheet.tsx';

/**
 * 2026-07-29 在 ROTATE02739640 上 `pm list packages` 全量实测出的模拟器包名（17 条 + 下面的
 * *.emu 系列 8 个 = 25 个）。
 * 新装的模拟器若不在表里，只是排序靠后，**仍然出现在格子里**，不会消失。
 */
const EMULATOR_PACKAGES = new Set([
  'com.retroarch.aarch64',               // RetroArch（多核心，掌机上的主力）
  'com.github.stenzek.duckstation',      // PS1
  'xyz.aethersx2.android',               // PS2
  'org.ppsspp.ppsspp',                   // PSP
  'org.dolphinemu.dolphinemu',           // GameCube / Wii
  'org.dolphinemu.mmjr',                 // GameCube / Wii（MMJR 分支）
  'io.recompiled.redream',               // Dreamcast
  'com.flycast.emulator',                // Dreamcast（Flycast）
  'org.devmiyax.yabasanshioro2.pro',     // Sega Saturn
  'org.mupen64plusae.v3.fzurita.pro',    // N64
  'com.dsemu.drastic',                   // NDS
  'org.citra.emu',                       // 3DS（Citra）
  'io.github.lime3ds.android',           // 3DS（Lime3DS）
  'com.PceEmu',                          // PC Engine
  'com.fishstix.dosbox',                 // DOS
  'org.openbor.engine',                  // OpenBOR
  'org.easyrpg.player',                  // RPG Maker 2000/2003 运行时
]);

/**
 * 刻意**不**收进白名单的「沾游戏但不是模拟器」：
 *   com.limelight    Moonlight（串流 PC 游戏）
 *   com.migu.miguplay 咪咕快游（云游戏）
 *   com.ylm.game     Anbernic 自带游戏入口
 * 它们仍会出现在格子里，只是排在模拟器之后。等 Ben 用过再决定要不要提前。
 */

/** Robert Broglia 的 *.emu 系列：NesEmu / Snes9xPlus / GbaEmu / GbcEmu / MdEmu / NeoEmu / NgpEmu / MsxEmu。 */
const EMU_SERIES_PREFIX = 'com.explusalpha.';

/**
 * 是不是模拟器。
 *
 * ★绝不能用 'emu' 子串判定：「emulation」是系统 overlay 包名里的高频词，掌机上实测有 4 个
 * `com.android.internal.display.cutout.emulation.*`（屏幕圆角适配），子串匹配会把它们
 * 全当成游戏塞进格子。所以只走白名单 + 明确的厂商前缀。
 */
export function isEmulatorPackage(pkg: string): boolean {
  if (EMULATOR_PACKAGES.has(pkg)) return true;
  return pkg.startsWith(EMU_SERIES_PREFIX);
}

/** 模拟器优先，组内按 label 本地化字母序。返回新数组，不改动入参。 */
export function sortGamesFirst(apps: AppEntry[]): AppEntry[] {
  return [...apps].sort((a, b) => {
    const ga = isEmulatorPackage(a.pkg) ? 0 : 1;
    const gb = isEmulatorPackage(b.pkg) ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return a.label.localeCompare(b.label);
  });
}
