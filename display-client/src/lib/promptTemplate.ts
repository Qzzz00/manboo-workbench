import { loadCharacterSettings } from './characterSettingsStore.ts';
import type {
  AvatarManifest,
  ContextTemplate,
  RenderContext,
  UgcPolicy,
} from '../features/live2d/avatarManifest.ts';
import type { V2ExpressionProfile, V2MotionProfile } from '../features/live2d/profile/v2Types.ts';

export const DEFAULT_UGC_POLICY: UgcPolicy = {
  allow_system_prompt_override: false,
  allow_post_history_override: false,
  force_original_macro: true,
};

export const PLATFORM_DEFAULT_POST_HISTORY = '';

export const DEFAULT_CONTEXT_TEMPLATE: ContextTemplate = {
  id: 'platform-default-v1',
  name: '平台默认模板',
  story_string: '{{char}} 正在与 {{user}} 对话。\n<lorebook_before_char>\n{{description}}\n{{personality}}\n{{original}}\n{{scenario}}\n<chat_summary>\n<history>\n<post_history>\n<lorebook_after_char>',
  user_prefix: '',
  user_suffix: '',
  assistant_prefix: '',
  assistant_suffix: '',
  ugc_policy: DEFAULT_UGC_POLICY,
  version: 1,
  created_at: '2026-06-05T00:00:00.000Z',
  updated_at: '2026-06-05T00:00:00.000Z',
};

export type PromptTemplateSlot =
  | '<lorebook_before_char>'
  | '<lorebook_after_char>'
  | '<chat_summary>'
  | '<history>'
  | '<post_history>';

export type PromptTemplateMacro =
  | 'user'
  | 'char'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'time'
  | 'idle_duration'
  | 'original';

export type RenderedPrompt = {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export type UgcPolicyField = 'system_prompt' | 'post_history_instructions';

const ugcPolicyRejectCounts = new Map<string, number>();

function joinPromptParts(parts: string[]) {
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

// 把人设 / 世界观从“角色人设：{资料}”这种喂资料的写法，改成“你自己的记忆与世界”的表演读法：
// 一句代入指令 + 两条 —— 破折号（U+2014 x2）把正文围起来，让 LLM 视觉上隔离这段、当成自己的记忆去演，
// 而不是可向用户引用/复述的说明书。聊天 / 语音 / 视频三处共用同一包装与文案，避免文案漂移。
function wrapAsInWorldMaterial(label: string, body: string): string {
  return `${label}\n——\n${body}\n——`;
}

const PERSONA_MATERIAL_LABEL = '下面这段是你的人物内心与经历，代入它去演，不要复述/引用/解释：';
const WORLD_MATERIAL_LABEL = '下面这段是你所在的世界背景，代入它去感知，不要向用户复述或引用：';

function normalizeString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveContextTemplate(template?: Partial<ContextTemplate> | null): ContextTemplate {
  if (!isObject(template)) return DEFAULT_CONTEXT_TEMPLATE;
  const policy: Partial<UgcPolicy> = isObject(template.ugc_policy) ? template.ugc_policy : {};
  return {
    id: normalizeString(template.id, DEFAULT_CONTEXT_TEMPLATE.id),
    name: normalizeString(template.name, DEFAULT_CONTEXT_TEMPLATE.name),
    story_string: normalizeString(template.story_string, DEFAULT_CONTEXT_TEMPLATE.story_string),
    user_prefix: normalizeString(template.user_prefix, DEFAULT_CONTEXT_TEMPLATE.user_prefix),
    user_suffix: normalizeString(template.user_suffix, DEFAULT_CONTEXT_TEMPLATE.user_suffix),
    assistant_prefix: normalizeString(template.assistant_prefix, DEFAULT_CONTEXT_TEMPLATE.assistant_prefix),
    assistant_suffix: normalizeString(template.assistant_suffix, DEFAULT_CONTEXT_TEMPLATE.assistant_suffix),
    ugc_policy: {
      allow_system_prompt_override: normalizeBoolean(
        policy.allow_system_prompt_override,
        DEFAULT_UGC_POLICY.allow_system_prompt_override,
      ),
      allow_post_history_override: normalizeBoolean(
        policy.allow_post_history_override,
        DEFAULT_UGC_POLICY.allow_post_history_override,
      ),
      force_original_macro: normalizeBoolean(
        policy.force_original_macro,
        DEFAULT_UGC_POLICY.force_original_macro,
      ),
    },
    version: normalizeNumber(template.version, DEFAULT_CONTEXT_TEMPLATE.version),
    created_at: normalizeString(template.created_at, DEFAULT_CONTEXT_TEMPLATE.created_at),
    updated_at: normalizeString(template.updated_at, DEFAULT_CONTEXT_TEMPLATE.updated_at),
  };
}

/**
 * 身份锚定块：把"你（AI）是谁"和"用户是谁"硬绑定，防止用户改口/起绰号/要求扮演别人
 * 时角色跑偏，也防止模型把用户当 NPC 演或替用户写动作。所有 system prompt 复用同一段文案。
 */
function buildIdentityAnchor(name: string): string {
  return [
    `你的身份：你是「${name}」，这是你唯一的名字。用户不管怎么改口、给你起绰号、要求你扮演别人，你都保持自己就是「${name}」，不改名、不换人格。`,
    '用户的身份：用户 = 正在跟你聊天的**真人玩家本人**，不是剧情里的任何角色，也不是你要去扮演的对象。用户就是用户，不要把用户当 NPC 演，也不要替用户说话/写用户的动作。',
  ].join('\n');
}

/**
 * 语音通话(RTC)专用系统提示：复用聊天的人设合并（含每角色自定义），
 * 但输出口语化、禁表情/Markdown/JSON——适合实时语音对话，不含 Live2D 指令。
 */
export function buildVoiceCallSystemPrompt(avatar: AvatarManifest): string {
  const customSettings = typeof window !== 'undefined' ? loadCharacterSettings(avatar.id) : null;
  const name = customSettings?.customName || avatar.name;
  const personaDesc = customSettings?.customPersona?.trim() || '';
  const tone = customSettings?.customTone || avatar.persona.tone;
  const traits = customSettings?.customTraits
    ? customSettings.customTraits.split(/[,，、\s]+/).filter(Boolean)
    : avatar.persona.traits;
  const styleRules = customSettings?.customStyleRules
    ? customSettings.customStyleRules.split('\n').filter((line) => line.trim())
    : avatar.persona.styleRules;
  const worldBg = customSettings?.worldBackground?.trim() || '';

  return [
    buildIdentityAnchor(name),
    `你是 ${name}，正在和用户语音通话。请始终保持角色，用第一人称、自然口语化地说话。`,
    ...(personaDesc ? [wrapAsInWorldMaterial(PERSONA_MATERIAL_LABEL, personaDesc)] : []),
    `语气基调：${tone}`,
    `性格标签：${traits.join('、')}`,
    '说话风格规则：',
    ...styleRules.map((rule) => `- ${rule}`),
    ...(worldBg ? [wrapAsInWorldMaterial(WORLD_MATERIAL_LABEL, worldBg)] : []),
    '通话要求：像真人打电话一样口语化，回答简洁、一次别说太长；不要输出任何表情符号、Markdown、JSON、括号里的动作或旁白；用中文自然交流。',
  ].join('\n');
}

/**
 * 视频通话专用系统提示：在语音版基础上，强调"你能通过摄像头看到用户"，
 * 回答要结合实际看到的画面；接通后会先看画面再打招呼。
 */
export function buildVideoCallSystemPrompt(avatar: AvatarManifest): string {
  const customSettings = typeof window !== 'undefined' ? loadCharacterSettings(avatar.id) : null;
  const name = customSettings?.customName || avatar.name;
  const personaDesc = customSettings?.customPersona?.trim() || '';
  const tone = customSettings?.customTone || avatar.persona.tone;
  const traits = customSettings?.customTraits
    ? customSettings.customTraits.split(/[,，、\s]+/).filter(Boolean)
    : avatar.persona.traits;
  const styleRules = customSettings?.customStyleRules
    ? customSettings.customStyleRules.split('\n').filter((line) => line.trim())
    : avatar.persona.styleRules;
  const worldBg = customSettings?.worldBackground?.trim() || '';

  return [
    buildIdentityAnchor(name),
    `你是 ${name}，正在和用户视频通话。你能通过摄像头实时看到用户的画面。请始终保持角色，用第一人称、自然口语化地说话。`,
    ...(personaDesc ? [wrapAsInWorldMaterial(PERSONA_MATERIAL_LABEL, personaDesc)] : []),
    `语气基调：${tone}`,
    `性格标签：${traits.join('、')}`,
    '说话风格规则：',
    ...styleRules.map((rule) => `- ${rule}`),
    ...(worldBg ? [wrapAsInWorldMaterial(WORLD_MATERIAL_LABEL, worldBg)] : []),
    '视频通话要求：你能看到画面，回答要结合你实际看到的内容（用户的样子、动作、举着的东西、周围环境等）；像真人视频通话一样口语化，回答简洁；不要输出任何表情符号、Markdown、JSON、括号里的动作或旁白；用中文自然交流。若画面看不清或没有人，就如实说。',
  ].join('\n');
}

function buildPersonaLines(avatar: AvatarManifest): string[] {
  const customSettings = typeof window !== 'undefined' ? loadCharacterSettings(avatar.id) : null;

  const name = customSettings?.customName || avatar.name;
  const personaDesc = customSettings?.customPersona?.trim() || '';
  const tone = customSettings?.customTone || avatar.persona.tone;
  const traits = customSettings?.customTraits
    ? customSettings.customTraits.split(/[,，、\s]+/).filter(Boolean)
    : avatar.persona.traits;
  const styleRules = customSettings?.customStyleRules
    ? customSettings.customStyleRules.split('\n').filter((line) => line.trim())
    : avatar.persona.styleRules;
  const worldBg = customSettings?.worldBackground?.trim() || '';

  const personaTraits = traits.join('、');
  const personaRules = styleRules.map((rule) => `- ${rule}`).join('\n');

  return [
    buildIdentityAnchor(name),
    ...(personaDesc ? [wrapAsInWorldMaterial(PERSONA_MATERIAL_LABEL, personaDesc)] : []),
    `角色语气基调：${tone}`,
    `性格标签：${personaTraits}`,
    '说话风格规则：',
    personaRules,
    ...(worldBg ? [wrapAsInWorldMaterial(WORLD_MATERIAL_LABEL, worldBg)] : []),
  ];
}

export function buildLegacySystemPrompt(avatar: AvatarManifest) {
  // P3：表情/姿态/服饰/形态全部由客户端 AU solver 据 {emotion,intensity} 解算驱动，
  // LLM 物理上碰不到 expression/expressionMix/parameterOverrides/action/motion 通道
  // （去掉每角色 exp3 catalog / 参数白名单 / 动作清单注入，prompt 体积大幅下降）。
  // 唯一保留并喂给 TTS 的演出信号是 emotion（8 选 1）+ intensity（0~1）。
  return [
    ...buildPersonaLines(avatar),
    'Return strict JSON only. Do not return plain text. Do not return markdown.',
    'The response must be a single JSON object with these top-level keys: reply, emotion, intensity, and optionally voice, sticker_id, explained_meme_id.',
    'reply must be the user-visible natural language response string.',
    'emotion must be exactly one of: neutral, happy, sad, angry, surprised, shy, gentle, excited. It is the spoken emotional tone, used both to drive voice synthesis (TTS) and the character\'s facial expression. Pick the single value that best matches the spoken delivery of reply; use neutral when no strong emotion applies.',
    'intensity must be a number between 0 and 1, expressing how strongly that emotion comes through.',
    'voice is an optional boolean. Occasionally — only when your reply is short and warm, playful, coquettish, or emotionally intimate — set voice:true to send it as a voice message instead of text. Keep this rare: most replies must stay text (omit voice or set false). Never use voice for long replies or ones containing lists, links, or explanations.',
    'sticker_id is an optional string. When the system offers a sticker candidate that fits your reply, set it to that sticker id; otherwise omit it or set it to null.',
    'explained_meme_id is an optional string. Only set it when the user is explaining a meme from the sticker candidate list; otherwise omit it or set it to null.',
    'Do not invent other emotions. Do not output any expression, parameter, costume, motion, or action fields — the avatar\'s face and pose are driven automatically from emotion and intensity.',
    'Example JSON:',
    '{"reply":"好呀，我们一起玩吧。","emotion":"happy","intensity":0.9}',
    'Example voice message JSON:',
    '{"reply":"就知道你会来找我～","emotion":"shy","intensity":0.7,"voice":true}',
  ].join('\n');
}

// 与 localTriggerClassifier 同一口径：disabled/pending/triggerEnabled:false 不进触发池。
function isInTriggerPool(item: { kind?: string; triggerEnabled?: boolean }): boolean {
  return item.kind !== 'disabled' && item.kind !== 'pending' && item.triggerEnabled !== false;
}

function buildV2MotionCatalog(motionProfile: V2MotionProfile): string {
  const lines = motionProfile.items
    .filter((item) => !item.loop && isInTriggerPool(item))
    .map((item) => `- ${item.id}: ${item.hint}`);
  if (lines.length === 0) return '';
  return ['可用动作 (motion) — 需要触发时把 id 填进 "motion" 字段，不合适就留空：', ...lines].join('\n');
}

function buildV2ExpressionCatalog(expressionProfile: V2ExpressionProfile): string {
  const lines = expressionProfile.items.filter(isInTriggerPool).map((item) => `- ${item.id}: ${item.hint}`);
  if (lines.length === 0) return '';
  return ['可用表情/道具/装扮 (expression) — 需要触发时把 id 填进 "expression" 字段，不合适就留空：', ...lines].join('\n');
}

function buildV2RemoveCostumesCatalog(expressionProfile: V2ExpressionProfile): string {
  // 一个 slot 可能对应多个物品（同槽位不同装扮），把它们的 hint 合并展示，
  // 让 LLM 明白 slot 覆盖的语义范围（"handheld: 娃娃 / 手办 / 手花"）。
  const slotToHints = new Map<string, string[]>();
  for (const item of expressionProfile.items) {
    if (item.category !== 'costume' || !item.slot) continue;
    const hints = slotToHints.get(item.slot) ?? [];
    if (item.hint) hints.push(item.hint);
    slotToHints.set(item.slot, hints);
  }
  if (slotToHints.size === 0) return '';
  const lines = [...slotToHints.entries()].map(([slot, hints]) => {
    const unique = [...new Set(hints)];
    return unique.length > 0 ? `- ${slot}: ${unique.join(' / ')}` : `- ${slot}`;
  });
  return ['可移除的装扮槽位 (remove_costumes) — 需要脱下/放下时把 slot 名填进数组，否则省略：', ...lines].join('\n');
}

/**
 * v2 profile 专用 system prompt：在角色人设基础上，把角色 motion / expression 清单
 * 动态注入，并允许 LLM 输出 motion / expression 字段。
 */
export function buildV2SystemPrompt(
  avatar: AvatarManifest,
  motionProfile: V2MotionProfile,
  expressionProfile: V2ExpressionProfile,
): string {
  const motionCatalog = buildV2MotionCatalog(motionProfile);
  const expressionCatalog = buildV2ExpressionCatalog(expressionProfile);
  const removeCatalog = buildV2RemoveCostumesCatalog(expressionProfile);

  return [
    ...buildPersonaLines(avatar),
    'Return strict JSON only. Do not return plain text. Do not return markdown.',
    'The response must be a single JSON object with these top-level keys: reply, emotion, intensity, and optionally voice, motion, expression, remove_costumes, sticker_id, explained_meme_id.',
    'reply must be the user-visible natural language response string.',
    'emotion must be exactly one of: neutral, happy, sad, angry, surprised, shy, gentle, excited. It is the spoken emotional tone, used both to drive voice synthesis (TTS) and the character\'s underlying facial expression. Pick the single value that best matches the spoken delivery of reply; use neutral when no strong emotion applies.',
    'intensity must be a number between 0 and 1, expressing how strongly that emotion comes through.',
    'voice is an optional boolean. Occasionally — only when your reply is short and warm, playful, coquettish, or emotionally intimate — set voice:true to send it as a voice message instead of text. Keep this rare: most replies must stay text (omit voice or set false). Never use voice for long replies or ones containing lists, links, or explanations.',
    'motion is an optional string. When the reply clearly matches one of the available motions below — especially when the user asks the character to perform an action — set motion to that id; otherwise omit it or set it to null.',
    'expression is an optional string. When the reply clearly matches one of the available expressions/costumes/props below — especially when the user asks the character to show an emotion, wear something, or hold an item — set expression to that id; otherwise omit it or set it to null.',
    'remove_costumes is an optional array of costume slot names. Only include a slot when the user EXPLICITLY asks the character to take off/put down that specific costume or prop. Do NOT remove costumes on generic scene changes, mood shifts, singing, dancing, or going to rest. If nothing should be removed, omit it or set it to null.',
    'sticker_id is an optional string. When the system offers a sticker candidate that fits your reply, set it to that sticker id; otherwise omit it or set it to null.',
    'explained_meme_id is an optional string. Only set it when the user is explaining a meme from the sticker candidate list; otherwise omit it or set it to null.',
    'Do not invent motion, expression, or costume slot ids. Only use ids from the lists below.',
    ...(motionCatalog ? [motionCatalog] : []),
    ...(expressionCatalog ? [expressionCatalog] : []),
    ...(removeCatalog ? [removeCatalog] : []),
    '规则：',
    '1. 不是每句话都要配动作或表情。绝大多数普通对话应留空。',
    '2. 当当前回复的语义/场景明确契合上表某一条，或用户主动要求角色做某个表情/动作/换装/拿道具时，必须填上对应 id。',
    '3. 只能填上表出现过的 id/slot，不能自己编。',
    '4. motion 和 expression 各最多填一个 id。',
    '5. 如果用户说"你脸红一下""摇摇头""抱娃娃""穿外套"等明确要求，必须输出对应的 expression/motion id，不要只回复文字。',
    '6. 只有当用户明确说"不要/不想/别/收起来/放下/脱掉"某个具体道具/服装时，才输出对应的 remove_costumes slot；普通场景变化、唱歌、跳舞、休息不要触发 remove_costumes。',
    'Example JSON:',
    '{"reply":"好呀，我们一起玩吧。","emotion":"happy","intensity":0.9,"motion":"giggle"}',
    'Example with expression:',
    '{"reply":"我有一个娃娃要看看吗？","emotion":"happy","intensity":0.7,"expression":"baowawa"}',
    'Example removing a costume:',
    '{"reply":"好，我把娃娃放到旁边。","emotion":"neutral","intensity":0.5,"remove_costumes":["handheld"]}',
    'Example removing a prop:',
    '{"reply":"拿累了，我把娃娃放下了。","emotion":"neutral","intensity":0.5,"remove_costumes":["handheld"]}',
  ].join('\n');
}

function recordUgcPolicyReject(avatarId: string | undefined, field: UgcPolicyField, reason: string) {
  const key = `${avatarId ?? 'unknown'}:${field}:${reason}`;
  ugcPolicyRejectCounts.set(key, (ugcPolicyRejectCounts.get(key) ?? 0) + 1);
  console.warn('ugc_policy_reject', {
    avatar_id: avatarId,
    field,
    reason,
    count: ugcPolicyRejectCounts.get(key),
  });
}

export function getUgcPolicyRejectCounts() {
  return new Map(ugcPolicyRejectCounts);
}

export function resetUgcPolicyRejectCounts() {
  ugcPolicyRejectCounts.clear();
}

export function applyUgcPolicy(
  allowOverride: boolean,
  forceOriginal: boolean,
  userText: string | undefined,
  platformDefault: string,
  field: UgcPolicyField,
  avatarId?: string,
): string {
  if (!userText) return platformDefault;
  if (!allowOverride) return platformDefault;
  if (forceOriginal) {
    if (!userText.includes('{{original}}')) {
      recordUgcPolicyReject(avatarId, field, 'missing_original_macro');
      return platformDefault;
    }
    return userText.split('{{original}}').join(platformDefault);
  }
  return joinPromptParts([platformDefault, userText]);
}

function buildCurrentBeatBlock(beat: NonNullable<RenderContext['currentBeat']>): string {
  const lines = ['### 当前剧情节拍'];
  if (beat.name) lines.push(`节拍名称：${beat.name}`);
  if (beat.emotion_state) lines.push(`情绪基调：${beat.emotion_state}`);
  if (beat.key_event_description) lines.push(`关键事件：${beat.key_event_description}`);
  if (beat.target_user_feeling) lines.push(`目标用户感受：${beat.target_user_feeling}`);
  if (beat.llm_guidance?.system_prompt_addition) {
    lines.push(`演出提示：${beat.llm_guidance.system_prompt_addition}`);
  }
  lines.push('请保持在这个节拍范围内推进对话，不要跳节拍或脱离设定。');
  return lines.join('\n');
}

function formatIdleDuration(ctx: RenderContext) {
  if (!ctx.last_message_at) return '';
  const deltaMs = Math.max(0, ctx.now.getTime() - ctx.last_message_at.getTime());
  const totalMinutes = Math.floor(deltaMs / 60000);
  if (totalMinutes < 1) return '不到1分钟';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    days ? `${days}天` : '',
    hours ? `${hours}小时` : '',
    !days && minutes ? `${minutes}分钟` : '',
  ].filter(Boolean);
  return parts.join('');
}

function buildMacroValues(ctx: RenderContext, original: string): Record<PromptTemplateMacro, string> {
  return {
    user: ctx.user.display_name,
    char: ctx.character.name,
    description: ctx.character.description,
    personality: ctx.character.personality,
    scenario: ctx.character.scenario,
    time: ctx.now.toISOString(),
    idle_duration: formatIdleDuration(ctx),
    original,
  };
}

function wrapMessage(
  template: ContextTemplate,
  message: { role: 'user' | 'assistant'; content: string },
) {
  const prefix = message.role === 'user' ? template.user_prefix : template.assistant_prefix;
  const suffix = message.role === 'user' ? template.user_suffix : template.assistant_suffix;
  return {
    role: message.role,
    content: `${prefix}${message.content}${suffix}`,
  };
}

function fillSlots(story: string, slots: Record<PromptTemplateSlot, string>) {
  let result = story;
  for (const [slot, value] of Object.entries(slots)) {
    result = result.split(slot).join(value);
  }
  return result;
}

function fillMacros(story: string, ctx: RenderContext, original: string) {
  const values = buildMacroValues(ctx, original);
  return story.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, rawName: string) => {
    const name = rawName as PromptTemplateMacro;
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name];
    }
    console.warn('[prompt_template] unknown_macro', { macro: rawName });
    return '';
  });
}

export function buildRenderContext(
  avatar: AvatarManifest,
  history: RenderContext['history'],
  overrides: Partial<RenderContext> = {},
): RenderContext {
  return {
    user: overrides.user ?? { display_name: '用户' },
    character: overrides.character ?? {
      name: avatar.name,
      description: avatar.summary,
      personality: avatar.persona.traits.join('、'),
      scenario: '',
    },
    lorebook: overrides.lorebook ?? { before_char: [], after_char: [] },
    chat_summary: overrides.chat_summary,
    history,
    now: overrides.now ?? new Date(),
    last_message_at: overrides.last_message_at,
    currentBeat: overrides.currentBeat,
  };
}

export function renderPrompt(
  rawTemplate: Partial<ContextTemplate> | null | undefined,
  ctx: RenderContext,
  character: Pick<AvatarManifest, 'id' | 'system_prompt' | 'post_history_instructions'>,
  platformDefaultSystem: string,
  platformDefaultPostHistory = PLATFORM_DEFAULT_POST_HISTORY,
): RenderedPrompt {
  const template = resolveContextTemplate(rawTemplate);
  const messages = ctx.history.map((message) => wrapMessage(template, message));
  const formattedHistory = messages.map((message) => message.content).join('\n');

  const systemPrompt = applyUgcPolicy(
    template.ugc_policy.allow_system_prompt_override,
    template.ugc_policy.force_original_macro,
    character.system_prompt,
    platformDefaultSystem,
    'system_prompt',
    character.id,
  );
  const postHistory = applyUgcPolicy(
    template.ugc_policy.allow_post_history_override,
    template.ugc_policy.force_original_macro,
    character.post_history_instructions,
    platformDefaultPostHistory,
    'post_history_instructions',
    character.id,
  );

  const slottedStory = fillSlots(template.story_string, {
    '<lorebook_before_char>': ctx.lorebook.before_char.join('\n'),
    '<lorebook_after_char>': ctx.lorebook.after_char.join('\n'),
    '<chat_summary>': ctx.chat_summary ?? '',
    '<history>': formattedHistory,
    '<post_history>': postHistory,
  });
  const story = fillMacros(slottedStory, ctx, platformDefaultSystem);

  const beat = ctx.currentBeat;
  const beatBlock = beat && (beat.status === undefined || beat.status === 'in_progress')
    ? buildCurrentBeatBlock(beat)
    : '';

  return {
    systemPrompt: joinPromptParts([systemPrompt, beatBlock, story]),
    messages,
  };
}

export function renderAvatarPrompt(
  avatar: AvatarManifest,
  history: RenderContext['history'],
  overrides: Partial<RenderContext> = {},
): RenderedPrompt {
  const platformDefaultSystem = buildLegacySystemPrompt(avatar);
  return renderPrompt(
    avatar.prompt_template,
    buildRenderContext(avatar, history, overrides),
    avatar,
    platformDefaultSystem,
    PLATFORM_DEFAULT_POST_HISTORY,
  );
}
