// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/previewModelUrl.ts(种子表清空)
/**
 * Live2D 预览的「本地种子模型」路径解析。
 *
 * Aiboo 有四个种子角色的模型直接放在 public/live2D 下;本机版所有形象都是上传的 zip,
 * 预览一律走 butler-server 的签名预览 URL(AvatarEdit 里 getAvatarPreviewUrl),所以这张表为空。
 * 保留函数签名是为了让 AvatarEdit 的调用路径不变:返回 null 就走签名预览。
 */
const SEED_MODEL_PATHS: Record<string, string> = {};

export function resolvePreviewModelUrl(id: string): string | null {
  return SEED_MODEL_PATHS[id] ?? null;
}
