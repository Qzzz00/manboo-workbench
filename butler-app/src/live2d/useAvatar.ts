/**
 * 形象从哪来:GET /avatars → 取记住的那个,否则第一个已发布的 → GET /avatars/:id → bundle.zip → 解包成 manifest。
 * 任一步 503/404 → 「本机没有配形象」,画声纹球占位;掉线 → 说掉线,也画球。
 */
import { useEffect, useState } from 'react';
import type { Session } from '../session';
import type { AvatarManifest } from './types.ts';
import { loadBundle, pickAvatar, type LoadedBundle } from './bundleLoader';
import type { AvatarSummary } from '../api/voice';

export type AvatarState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: AvatarManifest; avatars: AvatarSummary[] }
  | { status: 'placeholder'; note: string; avatars: AvatarSummary[] };

export const NO_AVATAR_TEXT = '电脑上还没有形象';

export function useAvatar(session: Session, avatarId: string | null): AvatarState {
  const [state, setState] = useState<AvatarState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let bundle: LoadedBundle | null = null;
    setState({ status: 'loading' });
    (async () => {
      const list = await session.voice.listAvatars();
      if (cancelled) return;
      if (!list.ok) {
        setState({ status: 'placeholder', note: list.kind === 'unavailable' || list.status === 404 ? NO_AVATAR_TEXT : list.error, avatars: [] });
        return;
      }
      const picked = pickAvatar(list.avatars, avatarId);
      if (picked === undefined) {
        setState({ status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] });
        return;
      }
      const detail = await session.voice.getAvatar(picked.id);
      if (cancelled) return;
      if (!detail.ok) { setState({ status: 'placeholder', note: detail.error, avatars: list.avatars }); return; }
      const zip = await session.voice.fetchBundle(picked.id);
      if (cancelled) return;
      if (!zip.ok) { setState({ status: 'placeholder', note: zip.error, avatars: list.avatars }); return; }
      try {
        bundle = await loadBundle({ ...picked, ...detail.data }, zip.data);
      } catch (error) {
        setState({ status: 'placeholder', note: error instanceof Error ? error.message : '形象包读不出来', avatars: list.avatars });
        return;
      }
      if (cancelled) { bundle.release(); return; }
      setState({ status: 'ready', manifest: bundle.manifest, avatars: list.avatars });
    })();
    return () => {
      cancelled = true;
      bundle?.release();
    };
  }, [session, avatarId]);

  return state;
}
