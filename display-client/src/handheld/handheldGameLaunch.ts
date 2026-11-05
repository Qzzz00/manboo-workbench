import Handheld, { type HandheldNative } from '../lib/handheldPlugin.ts';
import { prewarmBottomStrip, syncStripParams } from './handheldStrip.ts';
import type { RomItem } from './handheldCovers.ts';
import { launchTargetForRom } from './handheldRoms.ts';
import {
  PACKAGE_BY_APP,
  loadLastLaunched,
  saveLastLaunched,
  switchAppFor,
} from './handheldLaunchStore.ts';

type NativeLaunchArgs = Parameters<HandheldNative['launchRom']>[0];

export type HandheldRomLaunchDeps = {
  loadLastLaunched: typeof loadLastLaunched;
  saveLastLaunched: typeof saveLastLaunched;
  syncStripParams: typeof syncStripParams;
  prewarmBottomStrip: typeof prewarmBottomStrip;
  launchRom: (args: NativeLaunchArgs) => Promise<void>;
  warn: (...args: unknown[]) => void;
};

const DEFAULT_LAUNCH_DEPS: HandheldRomLaunchDeps = {
  loadLastLaunched,
  saveLastLaunched,
  syncStripParams,
  prewarmBottomStrip,
  launchRom: (args) => Handheld.launchRom(args),
  warn: (...args) => console.warn(...args),
};

/** 新 ROM 先落盘，然后并发同步底条、预热与启动模拟器，三路互不阻塞。 */
export function launchHandheldRom(
  avatarId: string,
  rom: RomItem,
  deps: HandheldRomLaunchDeps = DEFAULT_LAUNCH_DEPS,
): void {
  const target = launchTargetForRom(rom);
  if (!target) return;
  const nextPkg = PACKAGE_BY_APP[target.app];
  const switchApp = switchAppFor(deps.loadLastLaunched(), nextPkg, rom.path);
  deps.saveLastLaunched({ pkg: nextPkg, romPath: rom.path });

  void deps.syncStripParams(avatarId).catch(() => {});
  void deps.prewarmBottomStrip(avatarId).catch(() => {
    deps.warn('[handheld-strip] prewarm failed; F10 will cold-start');
  });
  void deps.launchRom(
    target.app === 'retroarch'
      ? { path: rom.path, app: 'retroarch', core: target.core, switchApp }
      : { path: rom.path, app: target.app, switchApp },
  ).catch(() => {});
}
