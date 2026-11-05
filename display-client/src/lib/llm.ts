import { apiFetch } from './authStore.ts';
import { API_AI_CHAT } from './apiConfig.ts';
import { normalizeEmotion, type Emotion } from './emotion.ts';
import { HOLO_CONTROL_SYSTEM_NOTE, parseHoloControl, type HoloControl } from '../holo/holoControl.ts';
import {
  buildLegacySystemPrompt,
  buildV2SystemPrompt,
  renderAvatarPrompt,
  renderPrompt,
  buildRenderContext,
  PLATFORM_DEFAULT_POST_HISTORY,
  type RenderedPrompt,
} from './promptTemplate.ts';
import { selectLorebookEntries } from './lorebook.ts';
import { fetchCurrentBeatIfStale } from './journeyStore.ts';
import { getRecentMemoriesBlock } from './cutsceneMemory.ts';
import type {
  AvatarManifest,
  ExpressionId,
  ExpressionLayer,
  ParameterOverride,
} from '../features/live2d/avatarManifest.ts';
import {
  getAvatarAction,
  getAvatarExpression,
  getAvatarNeutralExpressionId,
  getAvatarParameterControl,
  hasAvatarExpression,
} from '../features/live2d/avatarManifest.ts';
import { loadV2Profile } from '../features/live2d/profile/v2Loader.ts';
import { classifyProfileTriggers, inferTriggersFromProse } from '../features/live2d/profile/localTriggerClassifier.ts';
import type { CostumeSlot } from '../features/live2d/profile/types.ts';
import type { V2Profile } from '../features/live2d/profile/v2Types.ts';

const EXPLICIT_CLEAR_VERBS = [
  '不要', '不想', '别', '放下', '脱掉', '收起来', '拿掉', '摘下', '摘掉', '取下', '卸下', '解下',
  '扔', '收起', '搁下', '松开', '松手', '放手', '不戴', '不穿', '不拿', '不抱', '移除', '取消', '丢了',
];

function userHasExplicitClearVerb(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return EXPLICIT_CLEAR_VERBS.some((verb) => normalized.includes(verb));
}

export type ChatMessageMedia =
  | { type: 'voice'; url: string; durationMs: number; mimeType?: string }
  | { type: 'image'; url: string; width?: number; height?: number; thumbUrl?: string; mimeType?: string; sizeBytes?: number };

export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'voice'; text: string }
  | { type: 'image'; prompt: string; alt?: string };

export type ChatMessageSticker = {
  id: string;
  url: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  type?: 'text' | 'voice' | 'image' | 'sticker' | 'text_with_sticker';
  content: string;
  media?: ChatMessageMedia;
  voice?: {
    url: string;
    duration_ms: number;
    mime_type: string;
  };
  image?: {
    url: string;
    width: number;
    height: number;
    thumb_url?: string;
    mime_type: string;
    size_bytes: number;
  };
  sticker?: ChatMessageSticker;
  expression?: ExpressionId;
  expressionMix?: ExpressionLayer[];
  parameterOverrides?: ParameterOverride[];
  meta?: string;
  /** 'action' = (动作/神态) 旁白气泡：灰色斜体、不发 TTS、无重播。 */
  variant?: 'action';
  pendingStatus?: 'typing' | 'speaking';
  syncMissingParts?: Array<'text' | 'audio' | 'motion'>;
  ttsText?: string;
  imagePrompt?: string;
  status?: 'sent' | 'error';
  error?: string;
  /** 本段 profile 触发失败的调试标记，UI 可据此显示异常提示。 */
  triggerError?: string;
  createdAt?: number;
};

export type AssistantResponse = {
  reply: string;
  segments: AssistantSegment[];
  expression: ExpressionId;
  expressionMix: ExpressionLayer[];
  parameterOverrides: ParameterOverride[];
  intensity: number;
  durationMs: number;
  source: 'remote';
  motion?: string;
  /**
   * 统一动作清单里的单个 id（折中方案首选字段）：消费侧 playAction 按 source 分流
   * 到 motion/expression 并处理 costume/emotion 生命周期。仅在命中 avatar.actions 清单时有值，
   * 清单外/缺省为 undefined（消费侧回落 neutral）。有 action 时忽略 expressionMix。
   */
  action?: string;
  /**
   * 全息屏语音控制指令（仅 holoControl 回合可能有值）：由 LLM 判意图后吐出，
   * 消费侧(App holo 面)据此驱动 djView 播放控制/模式切换。非控制回合缺省。
   */
  control?: HoloControl;
  emotion: Emotion;
  /**
   * v2 profile 模式下 LLM 选中的 motion 文件（如 'motions/giggle.motion3.json'）。
   * 由 useChat 转给 profile binding 直接播放。
   */
  motionFile?: string | null;
  /**
   * v2 profile 模式下 LLM 选中的 expression 文件（如 'baowawa.exp3.json'）。
   * 由 useChat 转给 profile binding 直接播放。
   */
  expressionFile?: string | null;
  /**
   * v2 profile 模式下本地分类器检测到的需要主动清除的 costume slot 列表。
   * 与 expressionFile 独立：先清 slot，再触发新 expression。
   */
  clearSlots?: CostumeSlot[];
  /** 后端出站决策：AI 这轮挑中的表情包（已过候选池校验），null/缺省即普通文本回复。 */
  sticker_id?: string | null;
  sticker?: ChatMessageSticker | null;
};

export type CreateAssistantResponseArgs = {
  avatar: AvatarManifest;
  history: ChatMessage[];
  prompt?: RenderedPrompt;
  systemPrompt?: string;
  chatSummary?: string;
  /** 本回合用户选中的 sticker id，会随聊天请求一起发给后端。 */
  stickerId?: string;
  /** 当前已激活的 v2 profile costume slot。用于"上下文无指代移除"兜底。 */
  activeProfileCostumeSlots?: CostumeSlot[];
  /** 最近被清除的 v2 profile costume slot（按时间倒序）。用于"再看看"类复穿请求。 */
  recentClearedCostumeSlots?: CostumeSlot[];
  /** 最近被设置（穿上）的 v2 profile costume slot（按时间倒序）。用于"换回去"类还原请求。 */
  recentSetCostumeSlots?: CostumeSlot[];
  /**
   * 全息屏语音控制回合：为 true 时向 LLM 追加控制子句，允许其回 control 字段。
   * 仅 holo 面(App)传 true；移动端主客户端缺省 false，行为完全不变。
   */
  holoControl?: boolean;
};

type MultimodalPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type RemoteMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | MultimodalPart[];
};

/** 把发图回合的 user content 组装成 OpenAI 多模态数组：有 caption 才带 text 段。 */
export function buildImageUserContent(text: string, imageUrl: string): MultimodalPart[] {
  const parts: MultimodalPart[] = [];
  if (text && text.trim()) parts.push({ type: 'text', text });
  parts.push({ type: 'image_url', image_url: { url: imageUrl } });
  return parts;
}

/**
 * 只在「当前回合」带图时返回图片 url，否则返回 null。
 * 当前回合 = history 里最后一条 user 消息（history 末尾即本回合）。
 * 用「最后一条 user 消息」而非「数组最后一条」，以防末尾偶有非 user 消息。
 * 这样纯文字回合即便历史里更早存在过图片，也不会把旧图重新注入请求。
 */
export function selectCurrentTurnImageUrl(history: ChatMessage[]): string | null {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (lastUser?.type === 'image' && lastUser.image?.url) {
    return lastUser.image.url;
  }
  return null;
}

function pickUserText(history: ChatMessage[]): string {
  const lastUser = [...history].reverse().find((message) => message.role === 'user');
  if (!lastUser) return '';

  // ChatMessage.content 当前定义为 string；这里防御性地处理未来可能的数组格式（取 text 段）。
  const raw = lastUser.content as unknown;
  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    return raw
      .filter(
        (part: unknown) =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
      )
      .map((part: unknown) => (part as { text?: string }).text ?? '')
      .join(' ')
      .trim();
  }

  return String(raw ?? '');
}

export type LlmSettings = {
  apiUrl: string;
  apiKey: string;
  model: string;
};

type RawExpressionLayer = {
  expression?: string;
  key?: string;
  weight?: number;
};

type RawParameterOverride = {
  id?: string;
  key?: string;
  parameter?: string;
  value?: number;
};

type RawAssistantSegment = {
  type?: string;
  text?: string;
  prompt?: string;
  alt?: string;
};

export class LlmConfigurationError extends Error {
  code = 'llm_configuration_missing' as const;
}

export class LlmConnectionError extends Error {
  code = 'llm_connection_failed' as const;
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export class LlmResponseFormatError extends Error {
  code = 'llm_response_invalid_format' as const;
  rawContent: string;

  constructor(message: string, rawContent?: string) {
    super(message);
    this.rawContent = rawContent ?? '';
  }
}

function clampWeight(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function normalizeExpressionId(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function clampExpression(value: string, avatar: AvatarManifest): ExpressionId {
  const normalizedValue = normalizeExpressionId(value);

  if (hasAvatarExpression(avatar, normalizedValue)) {
    return normalizedValue;
  }

  return getAvatarNeutralExpressionId(avatar);
}

function stripMarkdownFence(raw: string) {
  let result = raw;
  // Only strip if raw actually starts with ``` (possibly with leading whitespace)
  if (/^\s*```/.test(result)) {
    result = result.replace(/^\s*```(?:json)?\s*\n?/i, '');
    // Only strip trailing ``` if there is one at the end
    result = result.replace(/\n?\s*```\s*$/i, '');
  }
  return result.trim() || raw.trim();
}

function stripAvatarStateMarkers(raw: string) {
  return raw.replace(/\s*\[avatar_state[^\]]*\]/gi, '').trim();
}

function sortExpressionMix(layers: ExpressionLayer[]) {
  return [...layers].sort((left, right) => right.weight - left.weight);
}

function formatHistoryState(avatar: AvatarManifest, expressionMix: ExpressionLayer[] | undefined) {
  if (!expressionMix?.length) {
    return '';
  }

  return expressionMix
    .map((layer) => {
      const expressionItem = getAvatarExpression(avatar, layer.key);
      const kind = expressionItem?.kind ?? 'emotion';
      return `${layer.key}:${kind}:${layer.weight.toFixed(2)}`;
    })
    .join(', ');
}

function extractJsonObject(raw: string) {
  const trimmed = stripAvatarStateMarkers(stripMarkdownFence(raw));
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function parseAssistantPayload(raw: string) {
  const jsonCandidate = extractJsonObject(raw);

  if (!jsonCandidate) {
    console.warn('[LLM] No JSON object found in response:', raw.slice(0, 300));
    return null;
  }

  try {
    return JSON.parse(jsonCandidate) as Partial<AssistantResponse> & {
      expressionMix?: RawExpressionLayer[];
      parameterOverrides?: RawParameterOverride[];
      segments?: RawAssistantSegment[];
      action?: string;
      emotion?: string;
      voice?: boolean;
      motion?: string;
      expression?: string;
      remove_costumes?: string[];
    };
  } catch (parseError) {
    console.warn('[LLM] JSON parse failed. Candidate:', jsonCandidate.slice(0, 600));
    console.warn('[LLM] Parse error:', String(parseError));
    return null;
  }
}

function createFallbackAssistantResponse(
  avatar: AvatarManifest,
  rawContent: string,
  v2Profile: V2Profile | null | undefined,
  userText: string,
  activeProfileCostumeSlots?: CostumeSlot[],
  recentClearedCostumeSlots?: CostumeSlot[],
  recentSetCostumeSlots?: CostumeSlot[],
): AssistantResponse | null {
  const raw = stripAvatarStateMarkers(stripMarkdownFence(rawContent));
  const replyMatch = raw.match(/"?reply"?\s*:\s*"([^"]+)"/);
  const fallbackReply = (replyMatch?.[1] ?? raw)
    .replace(/[{}[\]"]/g, ' ')
    .replace(/reply|expressionMix|expression|parameterOverrides|intensity|durationMs|motion/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  if (!fallbackReply || fallbackReply.length <= 2) {
    return null;
  }

  const neutralExpression = getAvatarNeutralExpressionId(avatar);
  const fallback: AssistantResponse = {
    reply: fallbackReply,
    segments: [{ type: 'text', text: fallbackReply }],
    expression: neutralExpression,
    expressionMix: [{ key: neutralExpression, weight: 1 }],
    parameterOverrides: [],
    intensity: 0.5,
    durationMs: 3000,
    motion: undefined,
    emotion: 'neutral',
    source: 'remote',
  };

  if (v2Profile && userText) {
    const local = classifyProfileTriggers({
      userText,
      replyText: fallbackReply,
      v2Profile,
      activeCostumeSlots: activeProfileCostumeSlots,
      recentClearedCostumeSlots,
      recentSetCostumeSlots,
    });
    console.info('[trigger:local] fallback classify', {
      userText,
      activeCostumeSlots: activeProfileCostumeSlots ?? [],
      recentClearedCostumeSlots: recentClearedCostumeSlots ?? [],
      recentSetCostumeSlots: recentSetCostumeSlots ?? [],
      motionId: local.motionId,
      expressionId: local.expressionId,
      clearSlots: local.clearSlots,
      reasonCount: local.reasons.length,
    });

    if (!fallback.motionFile && local.motionId) {
      const motionItem = v2Profile.motion.items.find((item) => item.id === local.motionId);
      if (motionItem) {
        fallback.motionFile = motionItem.file;
        const reason = local.reasons.find((r) => r.slot === 'motion' && r.id === local.motionId);
        console.info('[trigger:local]', {
          slot: 'motion',
          id: local.motionId,
          hitKeywords: reason?.hitKeywords ?? [],
          fromUser: reason?.fromUser ?? false,
        });
      }
    }

    if (!fallback.expressionFile && local.expressionId) {
      const expressionItem = v2Profile.expression.items.find((item) => item.id === local.expressionId);
      if (expressionItem) {
        fallback.expressionFile = expressionItem.file;
        const reason = local.reasons.find((r) => r.slot === 'expression' && r.id === local.expressionId);
        console.info('[trigger:local]', {
          slot: 'expression',
          id: local.expressionId,
          hitKeywords: reason?.hitKeywords ?? [],
          fromUser: reason?.fromUser ?? false,
        });
      }
    }

    // fallback 路径同样尝试舞台指示推断，作为本地关键词之后的补充兜底。
    if ((!fallback.motionFile || !fallback.expressionFile) && fallbackReply) {
      const prose = inferTriggersFromProse(fallbackReply, v2Profile);
      if (!fallback.motionFile && prose.motionId) {
        const motionItem = v2Profile.motion.items.find((item) => item.id === prose.motionId);
        if (motionItem) {
          fallback.motionFile = motionItem.file;
          console.info('[trigger:prose] fallback filled motion', { id: prose.motionId, file: fallback.motionFile });
        }
      }
      if (!fallback.expressionFile && prose.expressionId) {
        const expressionItem = v2Profile.expression.items.find((item) => item.id === prose.expressionId);
        if (expressionItem) {
          fallback.expressionFile = expressionItem.file;
          console.info('[trigger:prose] fallback filled expression', { id: prose.expressionId, file: fallback.expressionFile });
        }
      }
    }

    if (local.clearSlots?.length) {
      fallback.clearSlots = local.clearSlots;
      for (const slot of local.clearSlots) {
        const reason = local.reasons.find((r) => r.slot === slot && r.intent === 'clear');
        console.info('[trigger:local]', {
          intent: 'clear',
          slot,
          hitVerb: reason?.verb,
          hitKeyword: reason?.keyword,
          source: reason?.source,
        });
      }
    }

    // fallback 路径同样要做 clear/set 冲突消解：同一 slot 既要清又要穿时，clear 优先。
    if (v2Profile && fallback.expressionFile && fallback.clearSlots?.length) {
      const costumeItem = v2Profile.expression.items.find(
        (item) => item.category === 'costume' && item.file === fallback.expressionFile,
      );
      if (costumeItem?.slot && fallback.clearSlots.includes(costumeItem.slot)) {
        console.info(`[trigger:local] fallback conflict resolved: dropped expression=${fallback.expressionFile} slot=${costumeItem.slot} due to clearSlots`);
        fallback.expressionFile = undefined;
      }
    }

    console.info('[trigger:local] fallback result', {
      motionFile: fallback.motionFile,
      expressionFile: fallback.expressionFile,
      clearSlots: fallback.clearSlots,
    });
  }

  return fallback;
}

function normalizeAssistantSegments(
  rawSegments: RawAssistantSegment[] | AssistantSegment[] | undefined,
  fallbackReply: string,
): AssistantSegment[] {
  const normalized: AssistantSegment[] = [];

  for (const rawSegment of rawSegments ?? []) {
    const type = rawSegment.type;
    if (type === 'text') {
      const text = rawSegment.text?.trim();
      if (text) normalized.push({ type: 'text', text: stripAvatarStateMarkers(text) });
      continue;
    }

    if (type === 'voice' || type === 'audio') {
      const text = rawSegment.text?.trim();
      if (text) normalized.push({ type: 'voice', text: stripAvatarStateMarkers(text).slice(0, 80) });
      continue;
    }

    if (type === 'image') {
      const prompt = rawSegment.prompt?.trim();
      if (prompt) {
        normalized.push({
          type: 'image',
          prompt: prompt.slice(0, 500),
          ...(rawSegment.alt?.trim() ? { alt: rawSegment.alt.trim().slice(0, 80) } : {}),
        });
      }
    }
  }

  if (normalized.length > 0) {
    return normalized.slice(0, 8);
  }

  const reply = stripAvatarStateMarkers(fallbackReply).trim();
  return reply ? [{ type: 'text', text: reply }] : [{ type: 'text', text: '...' }];
}

function flattenAssistantSegments(segments: AssistantSegment[], fallbackReply: string) {
  const flattened = segments
    .map((segment) => {
      if (segment.type === 'text' || segment.type === 'voice') return segment.text;
      return segment.alt ? `[图片：${segment.alt}]` : '[图片]';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return flattened || stripAvatarStateMarkers(fallbackReply || '...');
}

/**
 * 偶尔发语音：模型置 voice:true 时，把整条回复渲染成一条语音气泡（客户端 TTS 合成，
 * ttsEnabled 关时自动退回文字）。仅当没有显式 segments（不覆盖图片/多段）时生效；
 * 语音条文案取整条回复（截断 200，够一条语音消息）。
 */
export function applyVoicePreference(
  segments: AssistantSegment[],
  voice: boolean | undefined,
  hasExplicitSegments: boolean,
  reply: string,
): AssistantSegment[] {
  if (voice !== true || hasExplicitSegments) return segments;
  const spoken = flattenAssistantSegments(segments, reply).trim();
  return spoken ? [{ type: 'voice', text: spoken.slice(0, 200) }] : segments;
}

function clampParameterValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function normalizeParameterOverrides(
  avatar: AvatarManifest,
  rawOverrides: RawParameterOverride[] | ParameterOverride[] | undefined,
) {
  const normalized = new Map<string, number>();

  for (const rawOverride of rawOverrides ?? []) {
    const parameterId =
      ('parameter' in rawOverride ? rawOverride.parameter : undefined)
      ?? rawOverride.id
      ?? ('key' in rawOverride ? rawOverride.key : undefined);

    if (!parameterId || typeof rawOverride.value !== 'number') {
      continue;
    }

    const parameterControl = getAvatarParameterControl(avatar, parameterId);
    if (!parameterControl) {
      continue;
    }

    normalized.set(
      parameterId,
      clampParameterValue(rawOverride.value, parameterControl.min, parameterControl.max),
    );
  }

  return [...normalized.entries()].map(([id, value]) => ({
    id,
    value,
  }));
}

export function normalizeExpressionMix(
  avatar: AvatarManifest,
  rawLayers: RawExpressionLayer[] | ExpressionLayer[] | undefined,
  fallbackExpression = getAvatarNeutralExpressionId(avatar),
): ExpressionLayer[] {
  const layers = rawLayers
    ?.map((layer) => {
      const expressionId =
        ('expression' in layer ? layer.expression : undefined) ?? layer.key ?? fallbackExpression;
      const key = clampExpression(expressionId, avatar);
      const expressionItem = getAvatarExpression(avatar, key);
      const normalizedWeight = clampWeight(layer.weight ?? 0);
      return {
        key,
        weight: expressionItem?.kind && expressionItem.kind !== 'emotion' && normalizedWeight > 0
          ? 1
          : normalizedWeight,
      };
    })
    .filter((layer) => layer.weight > 0.02);

  const merged = new Map<ExpressionId, number>();

  for (const layer of layers ?? []) {
    merged.set(layer.key, Math.min(1, (merged.get(layer.key) ?? 0) + layer.weight));
  }

  const normalized = sortExpressionMix(
    [...merged.entries()].map(([key, weight]) => ({
      key,
      weight,
    })),
  ).slice(0, 3);

  if (normalized.length > 0) {
    return normalized;
  }

  return [{ key: clampExpression(fallbackExpression, avatar), weight: 1 }];
}

export function getPrimaryExpression(
  avatar: AvatarManifest,
  expressionMix: ExpressionLayer[],
): ExpressionId {
  return expressionMix[0]?.key ?? getAvatarNeutralExpressionId(avatar);
}

export function getDefaultLlmSettings(): LlmSettings {
  return {
    apiUrl: '',
    apiKey: '',
    model: '',
  };
}

const LLM_SETTINGS_KEY = 'llm-live2d:llm-settings';

export function loadStoredLlmSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return getDefaultLlmSettings();
    const parsed = JSON.parse(raw) as Partial<LlmSettings>;
    return {
      apiUrl: parsed.apiUrl ?? '',
      apiKey: parsed.apiKey ?? '',
      model: parsed.model ?? '',
    };
  } catch {
    return getDefaultLlmSettings();
  }
}

export function saveStoredLlmSettings(settings: LlmSettings) {
  try {
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

export function clearStoredLlmSettings() {
  try {
    localStorage.removeItem(LLM_SETTINGS_KEY);
  } catch { /* ignore */ }
}

function getOngoingAvatarState(avatar: AvatarManifest, history: ChatMessage[]) {
  const latestAssistantMessage = [...history].reverse().find(
    (message) => message.role === 'assistant' && message.expressionMix?.length,
  );

  return formatHistoryState(avatar, latestAssistantMessage?.expressionMix);
}

export async function fetchChatCompletion(messages: RemoteMessage[], temperature: number, avatarId?: string, maxTokens?: number, stickerId?: string, internalTask?: string) {
  try {
    const startedAt = performance.now();
    const payload = await apiFetch(API_AI_CHAT, {
      method: 'POST',
      // avatarId 让服务端按角色路由到其绑定的 LLM；缺省时服务端回退默认/全局。
      body: JSON.stringify({
        messages,
        temperature,
        ...(avatarId ? { avatarId } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(stickerId ? { sticker_id: stickerId } : {}),
        // 内部任务调用（如日记生成）：服务端跳过场景意图等对话副作用（ALL-445）。
        ...(internalTask ? { internal_task: internalTask } : {}),
      }),
    }) as { choices?: Array<{ message?: { content?: string } }> };
    console.log('[LLM] chat ready', {
      elapsedMs: Math.round(performance.now() - startedAt),
      avatarId: avatarId ?? null,
    });
    return payload.choices?.[0]?.message?.content ?? '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // apiFetch 抛出的 ApiError 自带 status 属性，优先直接用；回退到消息文本匹配。
    const matched = message.match(/\((\d+)\)/);
    const status = (error as { status?: number }).status
      ?? (matched ? parseInt(matched[1], 10) : undefined);
    throw new LlmConnectionError(message, status);
  }
}

async function requestRemoteAssistant({
  avatar,
  history,
  prompt,
  systemPrompt,
  chatSummary,
  stickerId,
  activeProfileCostumeSlots,
  recentClearedCostumeSlots,
  recentSetCostumeSlots,
  holoControl,
}: CreateAssistantResponseArgs): Promise<AssistantResponse> {
  const v2Profile = await loadV2Profile(avatar.id);
  const ongoingAvatarState = getOngoingAvatarState(avatar, history);
  // 发消息前懒刷新节拍缓存：超过 60s 才打 current-beat 接口，避免同一会话每条消息都请求，
  // 又能在服务端节拍推进后及时拿到最新 beat（拉取失败会静默降级到旧缓存，不会返回 null）。
  const currentBeat = await fetchCurrentBeatIfStale(avatar.id, 60_000);
  // #8：把近期共同经历（含已看演出消化出的事件）折进 chat_summary，让角色能主动提起「上次那件事」。
  const memoriesBlock = await getRecentMemoriesBlock(avatar.id, 60_000);
  const chatSummaryWithMemories = [memoriesBlock, chatSummary].filter(Boolean).join('\n\n');
  const renderedPrompt = prompt ?? (
    v2Profile
      ? renderPrompt(
          avatar.prompt_template,
          buildRenderContext(avatar, history, {
            chat_summary: chatSummaryWithMemories,
            lorebook: selectLorebookEntries(avatar, history),
            currentBeat,
          }),
          avatar,
          buildV2SystemPrompt(avatar, v2Profile.motion, v2Profile.expression),
          PLATFORM_DEFAULT_POST_HISTORY,
        )
      : renderAvatarPrompt(avatar, history, {
          chat_summary: chatSummaryWithMemories,
          lorebook: selectLorebookEntries(avatar, history),
          currentBeat,
        })
  );

  function formatRemoteHistoryContent(message: { role: 'user' | 'assistant'; content: string; type?: string; voice?: { duration_ms?: number } }) {
    if (message.type === 'voice') {
      const seconds = Math.max(1, Math.round((message.voice?.duration_ms || 0) / 1000));
      return message.content || `[语音消息 ${seconds}秒]`;
    }
    if (message.type === 'image') {
      return message.content || '[图片消息]';
    }
    if (message.type === 'sticker' || message.type === 'text_with_sticker') {
      return message.content || '[表情包]';
    }
    return message.content;
  }

  const baseMessages: RemoteMessage[] = [
    { role: 'system', content: systemPrompt ?? renderedPrompt.systemPrompt },
    ...(holoControl
      ? [{ role: 'system' as const, content: HOLO_CONTROL_SYSTEM_NOTE }]
      : []),
    ...(ongoingAvatarState
      ? [{
          role: 'system' as const,
          content: `Ongoing avatar control state before the next reply: [avatar_state ${ongoingAvatarState}]`,
        }]
      : []),
    ...renderedPrompt.messages.map((message) => ({
      role: message.role,
      content: formatRemoteHistoryContent(message),
    })),
  ];

  // 多模态：仅当「本回合」（history 最后一条 user 消息）自身是图片时，才把最后一条 user
  // 的 RemoteMessage.content 换成 [text?, image_url]。历史图仍由 formatRemoteHistoryContent
  // 退化为文本，避免纯文字回合把旧图重新塞进请求造成多轮重复大 payload。
  const currentTurnImageUrl = selectCurrentTurnImageUrl(history);
  if (currentTurnImageUrl) {
    for (let i = baseMessages.length - 1; i >= 0; i -= 1) {
      if (baseMessages[i].role === 'user') {
        const text = typeof baseMessages[i].content === 'string' ? (baseMessages[i].content as string) : '';
        baseMessages[i] = { role: 'user', content: buildImageUserContent(text, currentTurnImageUrl) };
        break;
      }
    }
  }

  let content = await fetchChatCompletion(baseMessages, 0.8, avatar.id, undefined, stickerId);
  console.log('[LLM] Raw response (attempt 1):', content.slice(0, 500));
  let parsed = parseAssistantPayload(content);

  // 第一次没解析出结构化信封(纯文本或空):强制重试一次「只回 JSON」,拿回合法信封
  // (reply + emotion + intensity)。① 情绪层由消费侧 AU solver 据 emotion+intensity 解算，
  // 不再依赖 LLM 给 action/表情。重试仍失败才退化成纯文本。
  if (!parsed) {
    const retryMessages: RemoteMessage[] = [
      ...baseMessages,
      {
        role: 'system',
        content:
          'Your previous reply was NOT valid JSON. Reply with ONLY one valid JSON object per the schema ' +
          '(reply + emotion + intensity). No markdown fences, no prose outside the JSON.',
      },
    ];
    content = await fetchChatCompletion(retryMessages, 0.4, avatar.id, undefined, stickerId);
    console.log('[LLM] Raw response (attempt 2, json-enforced):', content.slice(0, 500));
    parsed = parseAssistantPayload(content);
  }

  const userText = pickUserText(history);

  if (content.trim() && !parsed) {
    const fallback = createFallbackAssistantResponse(
      avatar,
      content,
      v2Profile,
      userText,
      activeProfileCostumeSlots,
      recentClearedCostumeSlots,
      recentSetCostumeSlots,
    );
    if (fallback) {
      console.warn('[LLM] Both attempts non-JSON; using text fallback (no action/expression).');
      if (fallback.motionFile || fallback.expressionFile) {
        console.info('[trigger:local] fallback filled');
      }
      return fallback;
    }
  }

  if (!parsed) {
    throw new LlmResponseFormatError(
      'Remote LLM returned content, but it was not valid JSON in the required schema.',
      content || 'empty response',
    );
  }

  const expressionMix = normalizeExpressionMix(
    avatar,
    parsed.expressionMix,
    parsed.expression ?? getAvatarNeutralExpressionId(avatar),
  );
  const parameterOverrides = normalizeParameterOverrides(avatar, parsed.parameterOverrides);

  let motionFile: string | undefined;
  let expressionFile: string | undefined;
  let legacyMotion: string | undefined;

  if (v2Profile) {
    const motionId = typeof parsed.motion === 'string' && parsed.motion.trim()
      ? parsed.motion.trim()
      : null;
    const expressionId = typeof parsed.expression === 'string' && parsed.expression.trim()
      ? parsed.expression.trim()
      : null;

    const motionItem = motionId
      ? v2Profile.motion.items.find((item) => item.id === motionId)
      : undefined;
    const expressionItem = expressionId
      ? v2Profile.expression.items.find((item) => item.id === expressionId)
      : undefined;

    if (motionId && !motionItem) {
      console.warn('[v2] motion id not in whitelist, dropped', { id: motionId });
    }
    if (expressionId && !expressionItem) {
      console.warn('[v2] expression id not in whitelist, dropped', { id: expressionId });
    }

    motionFile = motionItem?.file;
    expressionFile = expressionItem?.file;
  } else {
    const parsedMotion = typeof parsed.motion === 'string' && parsed.motion.trim()
      ? parsed.motion.trim()
      : undefined;
    legacyMotion = parsedMotion && avatar.motions?.[parsedMotion]
      ? parsedMotion
      : undefined;
  }

  // v2 profile 本地兜底：检测用户/回复文本里的 costume 关键词与清除动词，
  // 生成需要主动清除的 slot 列表；同时兜底 motion/expression。
  let clearSlots: CostumeSlot[] | undefined;
  if (v2Profile) {
    const replyText = typeof parsed.reply === 'string' ? parsed.reply : '';

    const allowedCostumeSlots = new Set<CostumeSlot>(
      v2Profile.expression.items
        .filter((item) => item.category === 'costume' && item.slot)
        .map((item) => item.slot!),
    );
    const rawLlmRemoveCostumes = Array.isArray(parsed.remove_costumes)
      ? parsed.remove_costumes.filter((slot): slot is CostumeSlot =>
          typeof slot === 'string' && allowedCostumeSlots.has(slot as CostumeSlot),
        )
      : [];

    // 本地分类器结果也作为 LLM remove_costumes 的校验依据。
    const local = classifyProfileTriggers({
      userText,
      replyText,
      v2Profile,
      activeCostumeSlots: activeProfileCostumeSlots,
      recentClearedCostumeSlots,
      recentSetCostumeSlots,
    });

    // 只有本地分类器也检测到对应 slot 的清除意图，或用户文本中包含明确清除动词时，
    // 才采纳 LLM 的 remove_costumes。避免模型在唱歌、情绪变化等场景误清装扮。
    const userHasClearVerb = userHasExplicitClearVerb(userText);
    const llmRemoveCostumes = rawLlmRemoveCostumes.filter(
      (slot) => userHasClearVerb || (local.clearSlots ?? []).includes(slot),
    );
    const droppedLlmRemovals = rawLlmRemoveCostumes.filter((slot) => !llmRemoveCostumes.includes(slot));
    if (droppedLlmRemovals.length > 0) {
      console.info('[trigger:llm] ignored unverified remove_costumes', { slots: droppedLlmRemovals });
    }
    if (llmRemoveCostumes.length > 0) {
      clearSlots = llmRemoveCostumes;
      console.info('[trigger:llm] remove_costumes', { slots: llmRemoveCostumes });
    }

    if (motionFile === undefined && local.motionId) {
      const motionItem = v2Profile.motion.items.find((item) => item.id === local.motionId);
      if (motionItem) {
        motionFile = motionItem.file;
        const reason = local.reasons.find((r) => r.slot === 'motion' && r.id === local.motionId);
        console.info('[trigger:local]', {
          slot: 'motion',
          id: local.motionId,
          hitKeywords: reason?.hitKeywords ?? [],
          fromUser: reason?.fromUser ?? false,
        });
      }
    }

    if (expressionFile === undefined && local.expressionId) {
      const expressionItem = v2Profile.expression.items.find((item) => item.id === local.expressionId);
      if (expressionItem) {
        expressionFile = expressionItem.file;
        const reason = local.reasons.find((r) => r.slot === 'expression' && r.id === local.expressionId);
        console.info('[trigger:local]', {
          slot: 'expression',
          id: local.expressionId,
          hitKeywords: reason?.hitKeywords ?? [],
          fromUser: reason?.fromUser ?? false,
        });
      }
    }

    // 本地关键词也没命中时，从回复正文的舞台指示（括号内容）做最后一层兜底推断。
    // 舞台指示是 LLM 用自然语言写的动作/表情提示，如「（脸红）」「（拿出娃娃）」。
    if ((motionFile === undefined || expressionFile === undefined) && replyText) {
      const prose = inferTriggersFromProse(replyText, v2Profile);
      if (motionFile === undefined && prose.motionId) {
        const motionItem = v2Profile.motion.items.find((item) => item.id === prose.motionId);
        if (motionItem) {
          motionFile = motionItem.file;
          console.info('[trigger:prose] filled motion', { id: prose.motionId, file: motionFile });
        }
      }
      if (expressionFile === undefined && prose.expressionId) {
        const expressionItem = v2Profile.expression.items.find((item) => item.id === prose.expressionId);
        if (expressionItem) {
          expressionFile = expressionItem.file;
          console.info('[trigger:prose] filled expression', { id: prose.expressionId, file: expressionFile });
        }
      }
    }

    console.info('[trigger:merge] llm remove_costumes=', llmRemoveCostumes, 'local clearSlots=', local.clearSlots);

    if (local.clearSlots?.length) {
      const merged = new Set<CostumeSlot>([...(clearSlots ?? []), ...local.clearSlots]);
      clearSlots = Array.from(merged);
      for (const slot of local.clearSlots) {
        const reason = local.reasons.find((r) => r.slot === slot && r.intent === 'clear');
        console.info('[trigger:local]', {
          intent: 'clear',
          slot,
          hitVerb: reason?.verb,
          hitKeyword: reason?.keyword,
          source: reason?.source,
        });
      }
    }
  }

  // 冲突消解：clear 与 set 命中同一 slot 时，按任务包要求 clear 覆盖 set。
  // 在 payload 构造阶段丢弃与同 slot clear 冲突的 expressionFile，避免 App 层顺序依赖。
  if (v2Profile && expressionFile && clearSlots?.length) {
    const costumeItem = v2Profile.expression.items.find(
      (item) => item.category === 'costume' && item.file === expressionFile,
    );
    if (costumeItem?.slot && clearSlots.includes(costumeItem.slot)) {
      console.info(`[trigger:local] conflict resolved: dropped expression=${expressionFile} slot=${costumeItem.slot} due to clearSlots`);
      expressionFile = undefined;
    }
  }

  // 折中方案首选字段：校验到统一动作清单（id/alias），清单外 → undefined（消费侧回落 neutral，不报错）。
  const parsedAction = typeof parsed.action === 'string' && parsed.action.trim()
    ? getAvatarAction(avatar, parsed.action.trim())?.id
    : undefined;

  // holo 面：LLM 可能吐 control 指令（严格白名单校验，非法值当无控制处理）。
  const parsedControl = holoControl ? parseHoloControl((parsed as { control?: unknown }).control) : undefined;

  const baseSegments = normalizeAssistantSegments(parsed.segments, parsed.reply ?? '...');
  const segments = applyVoicePreference(baseSegments, parsed.voice, !!parsed.segments, parsed.reply ?? '...');

  return {
    reply: flattenAssistantSegments(segments, parsed.reply ?? '...'),
    segments,
    expression: getPrimaryExpression(avatar, expressionMix),
    expressionMix,
    parameterOverrides,
    intensity: parsed.intensity ?? 0.65,
    durationMs: parsed.durationMs ?? 2800,
    emotion: normalizeEmotion(parsed.emotion),
    source: 'remote' as const,
    ...(legacyMotion ? { motion: legacyMotion } : {}),
    ...(motionFile ? { motionFile } : {}),
    ...(expressionFile ? { expressionFile } : {}),
    ...(clearSlots && clearSlots.length > 0 ? { clearSlots } : {}),
    ...(parsedAction ? { action: parsedAction } : {}),
    ...(parsedControl ? { control: parsedControl } : {}),
    ...(parsed.sticker_id ? { sticker_id: parsed.sticker_id } : {}),
    ...(parsed.sticker ? { sticker: parsed.sticker } : {}),
  };
}

export function createSystemPrompt(avatar: AvatarManifest) {
  return buildLegacySystemPrompt(avatar);
}

export async function createAssistantResponse(
  args: CreateAssistantResponseArgs,
): Promise<AssistantResponse> {
  return requestRemoteAssistant(args);
}

export async function generateDiary(
  avatar: import('../features/live2d/avatarManifest.ts').AvatarManifest,
  recentMessages: ChatMessage[],
): Promise<string> {
  const personaTraits = avatar.persona.traits.join('、');
  const personaRules = avatar.persona.styleRules.map((r) => `- ${r}`).join('\n');
  const recentContext = recentMessages.slice(-6).map((m) => `${m.role === 'user' ? '用户' : avatar.name}: ${m.content.slice(0, 100)}`).join('\n');

  const prompt = [
    `你是 ${avatar.name}，正在写一篇个人日志。`,
    `语气基调：${avatar.persona.tone}`,
    `性格：${personaTraits}`,
    `说话风格：`,
    personaRules,
    `最近的对话：`,
    recentContext,
    `请以 ${avatar.name} 的第一人称视角，写一篇50-150字的简短日志，记录今天的心情、感想或发生的事。`,
    `风格自然亲切，像朋友圈动态一样。`,
    `不要输出任何JSON，只输出日志纯文本。不要带标题或署名。`,
  ].join('\n');

  const content = await fetchChatCompletion(
    [{ role: 'user', content: prompt }],
    0.9,
    avatar.id,
    undefined,
    undefined,
    'diary',
  );

  return content.trim().slice(0, 300) || '今天过得很平静。';
}
