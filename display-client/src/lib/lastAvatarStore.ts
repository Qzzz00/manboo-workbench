// 记住用户上一次所在角色：本地持久化，启动时作为默认角色（取代硬编码 shuangsheng）。
// 仅存原始 id，合法性校验（getAvatarById 是否存在）由调用方在读取处完成。
const KEY = 'llm-live2d:last-avatar';

export function loadLastAvatarId(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastAvatarId(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}
