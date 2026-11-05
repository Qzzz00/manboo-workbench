/**
 * 统一 API 配置中心
 *
 * 所有后端接口路径、外部 API 默认地址集中在此处定义，
 * 避免在业务代码中散落硬编码路径。
 */

// ── Auth ──────────────────────────────────────────
export const API_AUTH_LOGIN = '/api/auth/login';
export const API_AUTH_REGISTER = '/api/auth/register';
export const API_AUTH_REFRESH = '/api/auth/refresh';
export const API_AUTH_CONFIG = '/api/auth/config';
export const API_USER_PROFILE = '/api/user/profile';

// ── AI ────────────────────────────────────────────
export const API_AI_CHAT = '/ai/chat';
export const API_AI_TTS = '/ai/tts';
export const API_AI_IMAGE = '/ai/image';
export const API_AI_ASR = '/ai/asr';

// ── Chat Messages ─────────────────────────────────
export const API_MESSAGES = '/api/messages';
export const API_MESSAGES_IMAGE_GENERATE = '/api/messages/image/generate';
export function apiMessageRegenerateMediaPath(id: string) {
  return `/api/messages/${encodeURIComponent(id)}/regenerate-media`;
}

// ── Stickers ──────────────────────────────────────
export const API_STICKERS = '/api/stickers';

// ── Usage（前台活跃时长统计） ──────────────────────
export const API_USAGE_REPORT = '/api/usage/report';
export const API_USAGE_OPEN = '/api/usage/open';

// ── Sync ──────────────────────────────────────────
export const API_SYNC_PULL = '/sync/pull';
export const API_SYNC_PUSH = '/sync/push';

// ── 远端角色形象库 ────────────────────────────────
export const API_AVATAR_CATALOG = '/api/avatars/catalog';
export const API_JOURNEY_CRISIS_RESOURCES = '/api/journey/crisis-resources';
export const API_JOURNEY_CURRENT_BEAT = '/api/journey-engine/current-beat';
export const API_JOURNEY_ENDING = '/api/journey/ending';

/** 远端角色资源包下载路径：/api/avatars/:id/asset/v:version.zip */
export function apiAvatarAssetPath(id: string, version: string | number) {
  return `/api/avatars/${encodeURIComponent(id)}/asset/v${version}.zip`;
}

/** 单角色完整 manifest（含 persona/transform，纯 JSON 不含资源包）：GET /api/avatars/:id */
export function apiAvatarManifest(id: string) {
  return `/api/avatars/${encodeURIComponent(id)}`;
}

/** 世界书轻量对账：GET /api/avatars/:id/lorebook?version=<本地版本>（无本地版本则不带查询参数）。 */
export function apiAvatarLorebook(id: string, version?: string) {
  const base = `/api/avatars/${encodeURIComponent(id)}/lorebook`;
  return version ? `${base}?version=${encodeURIComponent(version)}` : base;
}

// ── 外部 API 默认地址 ─────────────────────────────
export const DEFAULT_QWEN_TTS_API_URL =
  '/dashscope/api/v1/services/aigc/multimodal-generation/generation';
export const DEFAULT_QWEN_TTS_MODEL = 'qwen3-tts-instruct-flash';
export const DEFAULT_QWEN_TTS_VOICE = 'Bunny';
export const DEFAULT_QWEN_TTS_INSTRUCTIONS =
  'Use a bright, sweet, lively, cute anime-style voice with natural conversational delivery.';
