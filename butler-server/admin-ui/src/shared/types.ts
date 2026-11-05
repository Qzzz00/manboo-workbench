// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/types.ts(删掉世界书/LLM/DJ 歌单/旅程类型)
/**
 * Admin API DTO 类型(与 butler-server 的 JSON 字段一一对应,snake_case 不转换)。
 * 本机版删掉了世界书 / LLM 模型库 / DJ 歌单 / 旅程作息的类型。
 * 后端字段用 snake_case；这里直接采用契约字段名，不在前端做 camelCase 转换。
 */

export type AvatarStatus = 'draft' | 'published' | 'archived';

export interface Persona {
  tone: string;
  traits: string[];
  styleRules: string[];
}

export interface ModelTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Transform {
  scaleMultiplier: number;
  verticalOffset: number;
  mobileScale?: number;
  mobileDrawerScaleOffset?: number;
  mobileDrawerTargetScale?: number;
  mobileDrawerOffsetX?: number;
  mobileDrawerOffsetY?: number;
  mobileInitialOffsetY?: number;
  /** 老角色（种子数据）DB 里没有这两项，只有新上传角色写入；消费端缺省需按中性值兜底。 */
  modelTransform?: ModelTransform;
  transformDefaults?: ModelTransform;
  /**
   * 每场景构图（缩放+位置）：登录页 / 主页 / DJ 页。APP 按场景直接施加为舞台 transform。
   * 用 Partial：允许逐字段编辑/清空；APP 端只在三项齐全时采用，缺字段忽略并回落。
   */
  loginFraming?: Partial<ModelTransform>;
  homeFraming?: Partial<ModelTransform>;
  djFraming?: Partial<ModelTransform>;
}

export interface MotionBinding {
  file: string;
  group?: string;
  description?: string;
}

export type MotionMap = Record<string, MotionBinding>;

export interface UgcPolicy {
  allow_system_prompt_override: boolean;
  allow_post_history_override: boolean;
  force_original_macro: boolean;
}

export interface ContextTemplate {
  id: string;
  name: string;
  story_string: string;
  user_prefix: string;
  user_suffix: string;
  assistant_prefix: string;
  assistant_suffix: string;
  ugc_policy: UgcPolicy;
  version: number;
  created_at: string;
  updated_at: string;
  /** DJ 人设 prompt（≤1500 字，契约 api-admin.md §10.3），仅 DJ 链路读取，普通聊天不受影响。 */
  dj_persona_md?: string;
}

/** 列表行 DTO（只读） */
export type EmotionBaseline = 'neutral' | 'calm' | 'cheerful' | 'energetic' | 'melancholic' | 'serious' | 'playful';

export interface DjBinding {
  enabled: boolean;
  segment_template_md?: string;
  intro_voice_id?: string;
  emotion_baseline?: EmotionBaseline;
}

export interface AvatarAdminSummary {
  id: string;
  name: string;
  summary: string;
  status: AvatarStatus;
  current_version: number;
  updated_at: number;
  dj_binding: DjBinding | null;
}

export interface AvatarAssetVersion {
  version: number;
  size_bytes: number;
  checksum: string;
  uploaded_at: number;
  /** 恢复来源版本号；普通上传的版本为 null */
  restore_source_version: number | null;
  restore_reason: string | null;
  restored_at: number | null;
}

/** 官方公开资料（ALL-535/A）：只读角色页展示的身份/职业/年龄/世界背景摘要。 */
export interface OfficialProfile {
  identity: string | null;
  occupation: string | null;
  age: number | null;
  world_summary: string | null;
}

/** 详情 DTO（只读 + 可写字段混合） */
export interface AvatarAdminDetail {
  id: string;
  name: string;
  summary: string;
  persona: Persona;
  transform: Transform;
  motions: MotionMap | null;
  prompt_template: ContextTemplate | null;
  model_entry: string;
  current_version: number;
  status: AvatarStatus;
  llm_model_id: string | null;
  voice: string | null;
  default_background: string | null;
  portrait_url: string | null;
  ringtone_url: string | null;
  notify_sound_url: string | null;
  dj_binding: DjBinding | null;
  opening_enabled: boolean;
  opening_text: string | null;
  journey_runtime_enabled: boolean;
  idle_enhance_enabled: boolean;
  idle_enhance_interval_sec: number | null;
  public_profile: OfficialProfile;
  created_at: number;
  updated_at: number;
  versions: AvatarAssetVersion[];
  voice_bindings?: VoiceBinding[];
}

/** 角色 × 场景级音色绑定。一个音色 = (provider, voiceId)。 */
export type VoiceScene = 'chat' | 'dj_intro' | 'dj_podcast' | 'rtc';

export interface VoiceBinding {
  scene: VoiceScene;
  provider_id: string;
  voice_id: string;
  params: Record<string, unknown> | null;
}

/** 音色同步模式（ALL-605）：independent=分别生效，follow_base=基准为源，follow_rtc=RTC 为源。 */
export type VoiceSyncMode = 'independent' | 'follow_base' | 'follow_rtc';

/** 统一音色引用：provider_id 指向 provider 库行（base→tts_models，rtc→rtc_providers）。 */
export interface VoiceRef {
  provider_id: string;
  voice_id: string;
}

/** 逻辑音色映射：一个逻辑音色 id 到两套最终音色的权威映射。 */
export interface LogicalVoiceMapping {
  /** 映射记录唯一标识（= logical_voice_id，兼容旧字段名）。 */
  id: string;
  logical_voice_id: string;
  base_voice: VoiceRef;
  rtc_voice: VoiceRef;
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
}

/** 角色音色同步配置（PUT/GET /api/voice-settings 的返回体）。 */
export interface VoiceSettings {
  avatar_id: string;
  voice_sync_mode: VoiceSyncMode;
  base_voice: VoiceRef | null;
  rtc_voice: VoiceRef | null;
}

/** 新建上传 multipart 的 meta JSON 结构 */
export interface CreateAvatarMeta {
  name: string;
  summary: string;
  persona: Persona;
  transform: Transform;
  motions?: MotionMap;
}

/** PATCH 可写字段，全部可选，只发送被修改的字段 */
export interface PatchAvatarPayload {
  name?: string;
  summary?: string;
  persona?: Persona;
  transform?: Transform;
  motions?: MotionMap;
  llm_model_id?: string | null;
  voice?: string | null;
  default_background?: string | null;
  portrait_url?: string | null;
  ringtone_url?: string | null;
  notify_sound_url?: string | null;
  prompt_template?: ContextTemplate | null;
  dj_binding?: DjBinding | null;
  opening_enabled?: boolean;
  opening_text?: string | null;
  journey_runtime_enabled?: boolean;
  idle_enhance_enabled?: boolean;
  idle_enhance_interval_sec?: number | null;
  public_profile?: OfficialProfile;
}

export interface UploadVersionResult {
  version: number;
  checksum: string;
  size_bytes: number;
  model_entry: string;
  uploaded_at: number;
}

/** POST /admin/avatars/:id/assets/restore 的返回 */
export interface RestoreVersionResult {
  version: number;
  restored_from: number;
  checksum: string;
  size_bytes: number;
  model_entry: string;
}

/** POST /admin/avatars/:id/assets/:version/reextract 的返回:原地重新解压,不生成新版本 */
export interface ReextractVersionResult {
  version: number;
  model_entry: string;
  extracted_files: number;
  checksum: string;
  /** 该版本是否当前版本(是则 avatars.model_entry 已同步更新) */
  current: boolean;
}

/** GET /admin/avatars/:id/preview-url 的返回 */
export interface AvatarPreviewUrl {
  baseUrl: string;
  /** 模型入口原名(可能含中文),仅展示用 */
  modelEntry: string;
  /** 已逐段 encodeURIComponent 的完整模型 URL,直接交给加载器;老服务端可能没有 */
  modelUrl?: string;
  version: number;
}

// ── 类型化 TTS provider（dashscope | volcengine | minimax）──────────
export type TtsProviderType = 'dashscope' | 'volcengine' | 'minimax';

export interface TtsSecretField {
  configured: boolean;
  preview: string | null;
}

export interface TtsProvider {
  id: string;
  name: string;
  provider_type: TtsProviderType;
  is_default: boolean;
  config: Record<string, string>; // 非密钥字段（明文）
  secrets: Record<string, TtsSecretField>; // 密钥字段（脱敏）
  created_at: number;
  updated_at: number;
}

export interface CreateTtsProviderPayload {
  name: string;
  provider_type: TtsProviderType;
  config: Record<string, string>;
  isDefault?: boolean;
}

export interface PatchTtsProviderPayload {
  name?: string;
  config?: Record<string, string>;
  isDefault?: boolean;
}

// ── 类型化 实时通话(RTC) provider（volcengine_rtc）──────────
export type RtcProviderType = 'volcengine_rtc';

export interface RtcProvider {
  id: string;
  name: string;
  provider_type: RtcProviderType;
  is_default: boolean;
  config: Record<string, string>; // 非密钥字段（明文）
  secrets: Record<string, TtsSecretField>; // 密钥字段（脱敏）
  created_at: number;
  updated_at: number;
}

export interface CreateRtcProviderPayload {
  name: string;
  provider_type: RtcProviderType;
  config: Record<string, string>;
  isDefault?: boolean;
}

export interface PatchRtcProviderPayload {
  name?: string;
  config?: Record<string, string>;
  isDefault?: boolean;
}

export interface TtsVoice {
  id: string;
  name: string;
  state?: string;
  /** 语种（zh/en），火山大模型音色目录带 */
  lang?: string;
  /** 推荐场景（通用场景/角色扮演/有声阅读…），用于下拉分组 */
  scene?: string;
  /** 2026-09-27：这一条是不是实取确认过的（false = 目录里有、这次没试到） */
  probed?: boolean;
  /** 实取时这一条**没问出来**（太挤 / 念不了探针那句话），照列但没验上 */
  probe_inconclusive?: boolean;
}

/**
 * 这一单是**什么时候、怎么向火山取回来的**(2026-09-27,卡 VO)。
 * 火山没有「列出本账号已开通音色」的接口,所以这一份是逐个试合一句极短文本试出来的;
 * `fetched_at` 是 null 就表示**这次没取到**,下拉里列的是本地清单(可能有换不成的)。
 */
export interface VoiceAvailability {
  fetched_at: string | null;
  method: string | null;
  counts?: { total: number; ok: number; inconclusive: number; unavailable: number; listed: number };
  stale?: boolean;
  /** 一句给人看的实话。页面**原样显示**,不要自己再编一句。 */
  note: string;
  refreshing?: { done: number; total: number; started_at: string };
}

export interface TtsVoicesResponse {
  provider_type: string;
  official: TtsVoice[];
  cloned: TtsVoice[];
  clonedError: string | null;
  /** 火山这一路才有。见 VoiceAvailability。 */
  availability?: VoiceAvailability;
}

// ── 旅程引擎：角色立面 Live2D / Voice（ALL-200 接口契约）──────────

/** 旅程引擎 Live2D 子面板数据 */
export interface CharacterLive2D {
  model_id: string;
  expression_mappings: Record<string, string>;
}

/** 旅程引擎语音子面板：TTS 引擎枚举（与 CharacterFacet.voice.tts_provider 对齐） */
export type TtsEngine = 'volc_seedtts' | 'volc_v3' | 'qwen';

/** 旅程引擎语音子面板数据 */
export interface CharacterVoice {
  tts_provider: TtsEngine;
  voice_id: string;
  emotion_mappings: Record<string, string>;
}

/** Live2D 模型库下拉项（供 Live2D 关联子面板使用） */
export interface Live2dModelSummary {
  id: string;
  name: string;
  preview_url?: string | null;
}
