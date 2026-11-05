/**
 * 轻量角色配置拉取（双击模型触发，不下载模型）。
 *
 * 只命中 GET /api/avatars/:id 这个几 KB 的纯 JSON 接口，取其中的
 * persona + transform 子集；模型 / 表情 / 动作文件全部沿用本地内置。
 * 与 useRemoteAvatars 的「catalog → 下载 zip」重链路完全平行、互不依赖。
 *
 * 设计约束：
 * - 永不抛错：游客 / 401 / 404 / 网络失败一律返回 null，调用方静默兜底；
 * - 传 skipAuthHandler，避免 401 触发全局登出（游客双击不该被踢回登录页）。
 */

import { apiGet } from '../../lib/apiClient.ts';
import { apiAvatarManifest } from '../../lib/apiConfig.ts';
import type { ContextTemplate, ManifestLorebook, RemoteAvatarConfig } from './types.ts';

export type AvatarConfigTransport = () => Promise<unknown>;

const TRANSFORM_KEYS = [
  'scaleMultiplier',
  'verticalOffset',
  'mobileScale',
  'mobileDrawerScaleOffset',
  'mobileDrawerTargetScale',
  'mobileDrawerScaleMul',
  'mobileDrawerOffsetX',
  'mobileDrawerOffsetY',
  'mobileInitialOffsetY',
  'headAnchorY',
  'headSizeNorm',
] as const;

/**
 * 解析单场景构图 {scale,offsetX,offsetY}；缺一不可，否则视为未配置返回 null。
 * 并对取值做安全 clamp（防后台误填如 scale=70 把角色放到屏外「消失」）：
 * scale 是相对基准的倍数，全身/半身正常 ~0.4~0.9，特写构图允许到 4；偏移正常 ~[-2,1]。超界即夹到可见范围。
 */
function normalizeFraming(raw: unknown): { scale: number; offsetX: number; offsetY: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const scale = num(o.scale);
  const offsetX = num(o.offsetX);
  const offsetY = num(o.offsetY);
  if (scale == null || offsetX == null || offsetY == null) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    scale: clamp(scale, 0.05, 4),
    offsetX: clamp(offsetX, -3, 3),
    offsetY: clamp(offsetY, -3, 3),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLorebook(raw: unknown): ManifestLorebook | null {
  if (!isObject(raw)) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  if (!Array.isArray(raw.entries)) return null;

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tokenBudget = num(raw.token_budget) ?? 1024;
  const defaultScanDepth = num(raw.default_scan_depth) ?? 4;

  const entries: ManifestLorebook['entries'] = [];
  for (const item of raw.entries) {
    if (!isObject(item)) continue;
    if (typeof item.id !== 'string') continue;
    if (!Array.isArray(item.keys) || !item.keys.every((k) => typeof k === 'string')) continue;
    if (typeof item.content !== 'string') continue;
    if (typeof item.constant !== 'boolean') continue;
    if (typeof item.insertion_order !== 'number' || !Number.isFinite(item.insertion_order)) continue;
    if (typeof item.priority !== 'number' || !Number.isFinite(item.priority)) continue;
    if (item.position !== 'before_char' && item.position !== 'after_char') continue;

    const entry: ManifestLorebook['entries'][number] = {
      id: item.id,
      keys: item.keys as string[],
      content: item.content,
      constant: item.constant,
      insertion_order: item.insertion_order,
      priority: item.priority,
      position: item.position,
    };
    if (typeof item.scan_depth === 'number' && Number.isFinite(item.scan_depth)) {
      entry.scan_depth = item.scan_depth;
    }
    entries.push(entry);
  }

  return { enabled: raw.enabled, token_budget: tokenBudget, default_scan_depth: defaultScanDepth, entries };
}

function normalizePromptTemplate(raw: unknown): ContextTemplate | null {
  if (!isObject(raw)) return null;
  if (typeof raw.story_string !== 'string') return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    story_string: raw.story_string,
    user_prefix: typeof raw.user_prefix === 'string' ? raw.user_prefix : '',
    user_suffix: typeof raw.user_suffix === 'string' ? raw.user_suffix : '',
    assistant_prefix: typeof raw.assistant_prefix === 'string' ? raw.assistant_prefix : '',
    assistant_suffix: typeof raw.assistant_suffix === 'string' ? raw.assistant_suffix : '',
    ugc_policy: {
      allow_system_prompt_override: isObject(raw.ugc_policy)
        ? raw.ugc_policy.allow_system_prompt_override === true
        : false,
      allow_post_history_override: isObject(raw.ugc_policy)
        ? raw.ugc_policy.allow_post_history_override === true
        : false,
      force_original_macro: isObject(raw.ugc_policy)
        ? raw.ugc_policy.force_original_macro !== false
        : true,
    },
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  };
}

/**
 * 把后端响应收敛成我们关心的字段；非法 / 缺失字段一律丢弃。
 * 整体无有效字段时返回 null（视作「没拿到配置」）。导出以便单测。
 */
export function normalizeAvatarConfig(raw: unknown): RemoteAvatarConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const cfg: RemoteAvatarConfig = {};

  if (typeof obj.name === 'string' && obj.name.trim()) cfg.name = obj.name;
  if (typeof obj.summary === 'string' && obj.summary.trim()) cfg.summary = obj.summary;

  if (obj.persona && typeof obj.persona === 'object') {
    const p = obj.persona as Record<string, unknown>;
    const persona: NonNullable<RemoteAvatarConfig['persona']> = {};
    if (typeof p.tone === 'string') persona.tone = p.tone;
    if (Array.isArray(p.traits) && p.traits.every((x) => typeof x === 'string')) {
      persona.traits = p.traits as string[];
    }
    if (Array.isArray(p.styleRules) && p.styleRules.every((x) => typeof x === 'string')) {
      persona.styleRules = p.styleRules as string[];
    }
    if (Object.keys(persona).length > 0) cfg.persona = persona;
  }

  if (obj.transform && typeof obj.transform === 'object') {
    const t = obj.transform as Record<string, unknown>;
    const transform: Record<string, unknown> = {};
    for (const key of TRANSFORM_KEYS) {
      const value = t[key];
      if (typeof value === 'number' && Number.isFinite(value)) transform[key] = value;
    }
    // 每场景构图（嵌套 {scale,offsetX,offsetY}）：登录页/主页/DJ页。
    for (const key of ['loginFraming', 'homeFraming', 'djFraming'] as const) {
      const framing = normalizeFraming(t[key]);
      if (framing) transform[key] = framing;
    }
    // 模型自身变换（后台可配，此前客户端不消费导致后台改 modelTransform 无效，见 ALL-440 排查）。
    // 与 framing 同形状 {scale,offsetX,offsetY}，复用 normalizeFraming 的取值校验与安全 clamp。
    const modelTransform = normalizeFraming(t.modelTransform);
    if (modelTransform) transform.modelTransform = modelTransform;
    if (Object.keys(transform).length > 0) {
      cfg.transform = transform as NonNullable<RemoteAvatarConfig['transform']>;
    }
  }

  // 每角色运行配置（服务端 snake_case）。
  if (typeof obj.voice === 'string' && obj.voice.trim()) cfg.voice = obj.voice;
  if (typeof obj.default_background === 'string' && obj.default_background.trim()) {
    cfg.defaultBackground = obj.default_background;
  }

  // 触达路由三件套（服务端 snake_case → 客户端 camelCase）：立绘 / 铃声 / 通知提示音。
  if (typeof obj.portrait_url === 'string' && obj.portrait_url.trim()) {
    cfg.portraitUrl = obj.portrait_url;
  }
  if (typeof obj.ringtone_url === 'string' && obj.ringtone_url.trim()) {
    cfg.ringtoneUrl = obj.ringtone_url;
  }
  if (typeof obj.notify_sound_url === 'string' && obj.notify_sound_url.trim()) {
    cfg.notifySoundUrl = obj.notify_sound_url;
  }

  // 待机动作增强（服务端已 camelCase 收敛为 { enabled, intervalSec }）。
  if (obj.idleEnhancement && typeof obj.idleEnhancement === 'object') {
    const ie = obj.idleEnhancement as Record<string, unknown>;
    const intervalSec =
      typeof ie.intervalSec === 'number' && Number.isFinite(ie.intervalSec) ? ie.intervalSec : null;
    cfg.idleEnhancement = { enabled: ie.enabled !== false, intervalSec };
  }

  // 世界书 / prompt 模板（服务端 snake_case → 客户端 camelCase）。
  const lorebook = normalizeLorebook(obj.lorebook);
  if (lorebook) cfg.lorebook = lorebook;
  const promptTemplate = normalizePromptTemplate(obj.prompt_template);
  if (promptTemplate) cfg.promptTemplate = promptTemplate;

  if (
    !cfg.name && !cfg.summary && !cfg.persona && !cfg.transform
    && !cfg.voice && !cfg.defaultBackground && !cfg.idleEnhancement
    && !cfg.portraitUrl && !cfg.ringtoneUrl && !cfg.notifySoundUrl
    && !cfg.lorebook && !cfg.promptTemplate
  ) {
    return null;
  }
  return cfg;
}

/**
 * 拉取单个角色的轻量配置（persona + transform）。永不 reject。
 * @param transport 注入用（测试 / 自定义请求）；默认走 apiGet。
 */
export async function fetchAvatarConfig(
  id: string,
  transport?: AvatarConfigTransport,
): Promise<RemoteAvatarConfig | null> {
  const fetchFn =
    transport ?? (() => apiGet(apiAvatarManifest(id), { skipAuthHandler: true }));
  try {
    return normalizeAvatarConfig(await fetchFn());
  } catch {
    return null;
  }
}
