import { getServerBaseUrl } from './serverConfig';

// 内置角色 id → 头像图（文件名不规则，手工映射）。无映射则用默认。
const PORTRAITS: Record<string, string> = {
  shuangsheng: './touxiang/shuang%20sheng.png',
  estella: './touxiang/estella.jpg',
  rattan: './touxiang/rattan.png',
};

const DEFAULT_PORTRAIT = './touxiang/shuang%20sheng.png';

/** 查询后端当前 DJ 角色 id（无后端/失败返回 null）。 */
export async function fetchActiveDjAvatarId(): Promise<string | null> {
  const base = getServerBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/dj/avatar`);
    if (res.ok) {
      const data = (await res.json()) as { avatar_id?: string | null };
      return data.avatar_id ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 角色 id → 头像图 URL（用于音乐播放器封面），未知回落默认。 */
export function portraitForAvatar(id: string | null | undefined): string {
  if (id && PORTRAITS[id]) return PORTRAITS[id];
  return DEFAULT_PORTRAIT;
}
