import { describe, it, expect } from 'vitest';
import { isEmulatorPackage, sortGamesFirst } from './handheldGames.ts';

const app = (pkg: string, label = pkg) => ({ pkg, label, icon: '' });

describe('isEmulatorPackage', () => {
  // 这 25 个是 2026-07-29 在 ROTATE02739640 上 `pm list packages` **全量**扫出来的。
  // ★第一版只写了 17 个，因为当时那条命令带了 head -25 被截断——真机装包后才发现
  // RetroArch/AetherSX2/Citra 等一批根本没进白名单。清单类判据别信截断过的输出。
  it('认出掌机上实测的 25 个模拟器', () => {
    const real = [
      'com.retroarch.aarch64', 'com.github.stenzek.duckstation', 'xyz.aethersx2.android',
      'org.ppsspp.ppsspp', 'org.dolphinemu.dolphinemu', 'org.dolphinemu.mmjr',
      'io.recompiled.redream', 'com.flycast.emulator', 'org.devmiyax.yabasanshioro2.pro',
      'org.mupen64plusae.v3.fzurita.pro', 'com.dsemu.drastic', 'org.citra.emu',
      'io.github.lime3ds.android', 'com.PceEmu', 'com.fishstix.dosbox',
      'org.openbor.engine', 'org.easyrpg.player',
      // *.emu 系列走前缀匹配
      'com.explusalpha.Snes9xPlus', 'com.explusalpha.NesEmu', 'com.explusalpha.GbaEmu',
      'com.explusalpha.GbcEmu', 'com.explusalpha.MdEmu', 'com.explusalpha.NeoEmu',
      'com.explusalpha.NgpEmu', 'com.explusalpha.MsxEmu',
    ];
    expect(real).toHaveLength(25);
    for (const pkg of real) expect(isEmulatorPackage(pkg), pkg).toBe(true);
  });

  it('不误伤系统应用、自己、以及掌机上的非模拟器', () => {
    for (const pkg of ['com.android.settings', 'com.android.launcher3', 'com.ylm.launcher',
                       'com.android.deskclock', 'com.aiboo.handheld', 'com.llm.live2d',
                       // 沾游戏但不是模拟器，刻意不提前（仍会出现在格子里）
                       'com.limelight', 'com.migu.miguplay', 'com.ylm.game',
                       'com.anbanic.rgsettings']) {
      expect(isEmulatorPackage(pkg), pkg).toBe(false);
    }
  });

  // ★「emulation」是系统 overlay 包名里的高频词：掌机上实测有 4 个
  // com.android.internal.display.cutout.emulation.*（屏幕圆角适配）。
  // 只按 'emu' 子串匹配会把它们全当成游戏塞进格子。
  it('不把 display cutout overlay 当模拟器', () => {
    for (const pkg of [
      'com.android.internal.display.cutout.emulation.corner',
      'com.android.internal.display.cutout.emulation.double',
      'com.android.internal.display.cutout.emulation.hole',
      'com.android.internal.display.cutout.emulation.tall',
    ]) {
      expect(isEmulatorPackage(pkg), pkg).toBe(false);
    }
  });
});

describe('sortGamesFirst', () => {
  it('模拟器排前面，各自内部按 label 字母序', () => {
    const out = sortGamesFirst([
      app('com.android.settings', '设置'),
      app('com.explusalpha.NesEmu', 'NES.emu'),
      app('com.android.deskclock', 'Clock'),
      app('com.github.stenzek.duckstation', 'DuckStation'),
    ]);
    expect(out.map((a) => a.pkg)).toEqual([
      'com.github.stenzek.duckstation', // D < N
      'com.explusalpha.NesEmu',
      'com.android.deskclock',          // Clock < 设置
      'com.android.settings',
    ]);
  });

  it('不改动入参数组', () => {
    const input = [app('com.android.settings'), app('com.explusalpha.NesEmu')];
    const copy = [...input];
    sortGamesFirst(input);
    expect(input).toEqual(copy);
  });

  it('空数组不炸', () => {
    expect(sortGamesFirst([])).toEqual([]);
  });
});
