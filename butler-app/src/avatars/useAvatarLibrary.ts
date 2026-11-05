/**
 * 形象库的全局一份 + React 钩子(2026-10-01;10-21 起来源只有电脑上的 butler-server)。
 *
 * 形象库不挂在配对会话上:下过的形象在本地索引里,没配对、连不上电脑时照样能用、能换。
 * 「电脑上有哪些」要经配对会话问 —— App 拿到会话后调 `avatarLibrary().setSource(...)`(App.tsx),
 * 会话换了再调一次;进陈列页时再问一次(AvatarGalleryPage)。
 */
import { useSyncExternalStore } from 'react';
import { preferencesStore } from '../api/tokenStore';
import { capacitorAvatarFs, onWifiNow, sha256Hex, unzipAll } from './capacitorAvatarFs';
import { createAvatarLibrary, type AvatarLibrary, type LibrarySnapshot } from './library';

let lib: AvatarLibrary | null = null;

export function avatarLibrary(): AvatarLibrary {
  if (lib !== null) return lib;
  const created = createAvatarLibrary({
    kv: preferencesStore(),
    fs: capacitorAvatarFs(),
    unzip: unzipAll,
    sha256: sha256Hex,
    onWifi: onWifiNow,
  });
  lib = created;
  void created.init();
  const conn = (navigator as unknown as { connection?: EventTarget }).connection;
  conn?.addEventListener?.('change', () => created.networkChanged());
  return created;
}

export function useAvatarLibrary(): LibrarySnapshot {
  const l = avatarLibrary();
  return useSyncExternalStore((cb) => l.subscribe(cb), () => l.get(), () => l.get());
}
