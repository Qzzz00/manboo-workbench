// AUProfile 加载器：按模型目录 fetch public/live2D/<dir>/au-profile.json，
// 校验后缓存（Map）。找不到 / 校验失败 / fetch 异常一律优雅降级返回 null
// （其他角色没 profile 时聊天链路回退临时桥，不报错）。

import { validateAUProfile } from './validate';
import type { AUProfile } from './types';

/** 由模型 model3.json 的 URL 推出其所在目录（含末尾斜杠）。 */
export function modelDirFromModelJson(modelJsonUrl: string): string {
  const idx = modelJsonUrl.lastIndexOf('/');
  return idx >= 0 ? modelJsonUrl.slice(0, idx + 1) : '';
}

/** 由模型目录拼出 au-profile.json 的 URL。 */
export function auProfileUrlFromModelJson(modelJsonUrl: string): string {
  return `${modelDirFromModelJson(modelJsonUrl)}au-profile.json`;
}

type Fetcher = (url: string) => Promise<Response>;

// 缓存：key = profile URL，value = AUProfile | null（null 也缓存，避免反复 404）。
const cache = new Map<string, AUProfile | null>();

/** 默认 fetch；测试可注入。 */
function defaultFetch(url: string): Promise<Response> {
  return fetch(encodeURI(url));
}

/**
 * 加载某模型目录下的 AUProfile。
 * @param modelJsonUrl 该角色 model3.json 的 URL（来自 AvatarManifest.modelJson）
 * @param opts.fetcher 可注入的 fetch（测试用）
 * @param opts.force   跳过缓存重新加载
 * 找不到/无效一律返回 null（降级）。
 */
export async function loadAuProfile(
  modelJsonUrl: string,
  opts: { fetcher?: Fetcher; force?: boolean } = {},
): Promise<AUProfile | null> {
  const url = auProfileUrlFromModelJson(modelJsonUrl);
  if (!opts.force && cache.has(url)) return cache.get(url) ?? null;

  const fetcher = opts.fetcher ?? defaultFetch;
  let profile: AUProfile | null = null;
  try {
    const res = await fetcher(url);
    if (res.ok) {
      const json = (await res.json()) as unknown;
      if (validateAUProfile(json).ok) {
        profile = json as AUProfile;
      } else {
        console.warn('[au-profile] validation failed, falling back to null:', url);
      }
    }
  } catch (error) {
    console.warn('[au-profile] load failed, falling back to null:', url, error);
    profile = null;
  }

  cache.set(url, profile);
  return profile;
}

/** 清空缓存（测试 / 远程配置更新后用）。 */
export function clearAuProfileCache(): void {
  cache.clear();
}
