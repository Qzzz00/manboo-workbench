import type { Emotion } from '../../lib/emotion.ts';

/** 界面取景目标键：home=主页、login=登录页、dj=DJ 页、holo=全息屏(独立可调构图)。供 React 层调用 setFramingTarget 时引用。 */
export type SurfaceKey = 'home' | 'login' | 'dj' | 'radio' | 'pet' | 'petStrip' | 'petFull' | 'petCall' | 'holo';

export type ExpressionId = string;

export type ExpressionLayer = {
  key: ExpressionId;
  weight: number;
};

type ExpressionFileBinding = {
  mode: 'file';
  file: string;
};

type ExpressionPresetBinding = {
  mode: 'preset';
  params: Record<string, number>;
};

export type ExpressionBinding = ExpressionFileBinding | ExpressionPresetBinding;

export type ExpressionKind = 'emotion' | 'pose' | 'prop' | 'effect';

export type AvatarExpression = {
  id: ExpressionId;
  label: string;
  kind: ExpressionKind;
  prompt: string;
  binding: ExpressionBinding;
  aliases?: string[];
};

// 统一动作清单（Motions + Expressions 合并成一张表，对 LLM/调用方屏蔽底层机制差异）。
// emotion=临时情绪(触发后回落)；costume=持久换装/场景层(保持，不被情绪覆盖)；
// action=一次性动作(motion 播放后自行回到 idle)；other=其它。
export type UnifiedActionKind = 'emotion' | 'action' | 'costume' | 'other';

export type UnifiedAction = {
  /** 给 LLM 的语义标签，snake_case，清单内唯一。 */
  id: string;
  /** UI/调试展示名。 */
  label: string;
  /** 底层机制：调用时据此分流到 model.motion / model.expression。 */
  source: 'motion' | 'expression';
  /** motion 的 group 名 / expression 的 id（Name）。 */
  ref: string;
  kind: UnifiedActionKind;
  /** 注入 system prompt 的含义说明。 */
  prompt: string;
  aliases: string[];
};

export type ParameterId = string;

export type ParameterOverride = {
  id: ParameterId;
  value: number;
};

export type DiscoveredLive2DParameterSource = 'runtime' | 'cdi3' | 'vtube' | 'exp3' | 'generic';

export type DiscoveredLive2DParameter = {
  avatarId: string;
  avatarName: string;
  id: ParameterId;
  label?: string;
  min?: number;
  max?: number;
  defaultValue?: number;
  currentValue?: number;
  source: DiscoveredLive2DParameterSource[];
  callable: boolean;
};

export type ParameterCall = {
  avatarId: string;
  id: ParameterId;
  value: number;
};

export type Live2DParameterDiscoveryResult = {
  avatarId: string;
  avatarName: string;
  parameters: DiscoveredLive2DParameter[];
  error?: string;
};

export type AvatarParameterControl = {
  id: ParameterId;
  label: string;
  prompt: string;
  min: number;
  max: number;
};

export type MotionBinding = {
  file: string;
  group?: string;
  // 以下为可选的统一清单覆盖项：buildUnifiedActions 默认按关键字正则推断 kind/label/prompt，
  // 在 avatarData.ts 显式填写可修正个别误判（如 ear_perk 不应被当作 costume）。
  kind?: UnifiedActionKind;
  label?: string;
  prompt?: string;
  aliases?: string[];
};

export type WatermarkBinding = {
  enabledByDefault: boolean;
  bindings: ExpressionBinding[];
};

/** 单场景构图：作为 fitModel 的 stage transform(nextTransform) 直接施加（scale 为相对基准的倍数）。 */
export type StageFraming = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type AvatarManifest = {
  id: string;
  name: string;
  summary: string;
  persona: {
    tone: string;
    traits: string[];
    styleRules: string[];
  };
  modelJson: string;
  scaleMultiplier: number;
  verticalOffset: number;
  mobileScale?: number;
  mobileDrawerScaleOffset?: number;
  /** @deprecated 旧绝对值语义，已被 mobileDrawerScaleMul 取代；字段保留以兼容现有 avatarData 数据，不再用于抽屉动画计算。 */
  mobileDrawerTargetScale?: number;
  /** 抽屉打开时相对乘子（相对当前 stage 增量 scale），如 0.82 = 缩小到当前的 82%。
   *  取代旧 mobileDrawerTargetScale 的绝对值语义。缺省 0.82。*/
  mobileDrawerScaleMul?: number;
  mobileDrawerOffsetX?: number;
  mobileDrawerOffsetY?: number;
  mobileInitialOffsetY?: number;
  /** 头部锚点：脸中心距模型 localBounds 顶部的比例 (0..1)。缺省 0.16。用于自适应竖直对齐。 */
  headAnchorY?: number;
  /** 脸高占模型 localBounds 高度的比例 (0..1)。缺省 0.18。用于自适应脸大小归一化。 */
  headSizeNorm?: number;
  modelTransform: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };
  transformDefaults: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };
  /** 每场景构图（后台可配，缺省回落）：施加为 fitModel 的 stage transform(nextTransform)。 */
  loginFraming?: StageFraming;
  homeFraming?: StageFraming;
  djFraming?: StageFraming;
  expressions: AvatarExpression[];
  /**
   * 情绪 → 表情 id 直连表（给**没有 au-profile.json 的角色**用）。
   *
   * 正常链路是 AU solver 按 profile 解算出 expressionMix；没 profile 的角色 solver 恒出空，
   * 于是通话/电台的 performCallUtterance（expressionMix 传 []）永远不改表情——
   * exp3 文件挂在清单里却没人触发。这张表就是那条回落：判出情绪直接点名一个 exp3。
   * 只在这里声明的角色生效，缺省不影响任何既有角色（有 profile 的仍走 solver 优先）。
   */
  emotionExpressions?: Partial<Record<Emotion, ExpressionId>>;
  parameterControls?: AvatarParameterControl[];
  motions?: Record<string, MotionBinding>;
  /**
   * 是否在用户选人抽屉里展示。缺省视为 true；内部「模型专用」条目（如 DJ 完整模型
   * shuangsheng-dj，仅供 DjMode/屏保按 id 取用渲染）置 false，不作为独立角色卡露出。
   */
  listedInDrawer?: boolean;
  /**
   * 待机小动作池：待机时除基础摆动/idle 循环外，每隔随机间隔随机播一个的「安静」动作名。
   * 缺省时由引擎按白名单从 motions 自动推断；无 motions 的模型走程序化朝向拍（不读此字段）。
   */
  idleBeats?: string[];
  /** 待机动作增强开关（后台每角色可配）。缺省视为 true。false → 引擎完全不插小动作拍。 */
  idleBeatsEnabled?: boolean;
  /** 待机小动作平均触发间隔（秒，后台可配）。缺省 → 引擎用内置默认区间；引擎在此值 ±30% 随机抖动。 */
  idleBeatIntervalSec?: number;
  /** Motions+Expressions 合并出的统一动作清单（enrichAvatarManifest 阶段填充）。 */
  actions?: UnifiedAction[];
  watermark?: WatermarkBinding;
  /** 每角色 TTS 音色（服务端配置，缺省回退全局 ttsSettings.apiVoice） */
  voice?: string;
  /** 每角色默认背景图绝对 URL（服务端配置，用户本地背景优先） */
  defaultBackground?: string;
  /** 触达路由三件套（服务端配置，来电/通知消费）：立绘 / 铃声 / 通知提示音，均为绝对 URL。 */
  portraitUrl?: string;
  ringtoneUrl?: string;
  notifySoundUrl?: string;
  prompt_template?: ContextTemplate;
  system_prompt?: string;
  post_history_instructions?: string;
  lorebook?: ManifestLorebook;
};

export type AvatarResolver = () => Promise<AvatarManifest>;

export type UgcPolicy = {
  allow_system_prompt_override: boolean;
  allow_post_history_override: boolean;
  force_original_macro: boolean;
};

export type ContextTemplate = {
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
};

export type RenderContext = {
  user: { display_name: string };
  character: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
  };
  lorebook: { before_char: string[]; after_char: string[] };
  chat_summary?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  now: Date;
  last_message_at?: Date;
  currentBeat?: {
    name: string;
    emotion_state: string;
    key_event_description?: string;
    target_user_feeling?: string;
    llm_guidance?: { system_prompt_addition?: string };
    status?: string;
  } | null;
};

/**
 * 远端下载的角色清单 entry（对应接口契约 ALL-143 / 后端 GET /api/avatars/:id）。
 * 字段名沿用契约的下划线风格（model_entry / localDir）；transform 与 motions
 * 为可选，缺失字段在 applyRemoteOverrides 中回退到内置兜底或默认值。
 */
export type RemoteAvatarTransform = {
  scaleMultiplier?: number;
  verticalOffset?: number;
  mobileScale?: number;
  mobileDrawerScaleOffset?: number;
  /** @deprecated 旧绝对值语义，已被 mobileDrawerScaleMul 取代；字段保留以兼容现有 avatarData 数据，不再用于抽屉动画计算。 */
  mobileDrawerTargetScale?: number;
  /** 抽屉打开时相对乘子（相对当前 stage 增量 scale），如 0.82 = 缩小到当前的 82%。
   *  取代旧 mobileDrawerTargetScale 的绝对值语义。缺省 0.82。*/
  mobileDrawerScaleMul?: number;
  mobileDrawerOffsetX?: number;
  mobileDrawerOffsetY?: number;
  mobileInitialOffsetY?: number;
  headAnchorY?: number;
  headSizeNorm?: number;
  /** 每场景构图（后台配置：登录页/主页/DJ页 的缩放与位置）。 */
  loginFraming?: StageFraming;
  homeFraming?: StageFraming;
  djFraming?: StageFraming;
  /** 模型自身变换（后台配置）：此前客户端不消费导致后台改 modelTransform 无效（ALL-440 排查）。 */
  modelTransform?: StageFraming;
};

export type ManifestLorebookEntry = {
  id: string;
  keys: string[];
  content: string;
  constant: boolean;
  insertion_order: number;
  priority: number;
  scan_depth?: number;
  position: 'before_char' | 'after_char';
};

export type ManifestLorebook = {
  enabled: boolean;
  token_budget: number;
  default_scan_depth: number;
  entries: ManifestLorebookEntry[];
};

export type RemoteAvatarManifest = {
  id: string;
  name?: string;
  summary?: string;
  persona?: Partial<AvatarManifest['persona']>;
  transform?: RemoteAvatarTransform;
  prompt_template?: ContextTemplate;
  system_prompt?: string;
  post_history_instructions?: string;
  /** motion key -> 相对 localDir 的文件路径（或 { file, group }） */
  motions?: Record<string, string | { file: string; group?: string }>;
  /** model3.json 相对 localDir 的路径 */
  model_entry: string;
  version?: string | number;
  /** 解压后的本地目录（Filesystem Data 下） */
  localDir: string;
  /** 包内全部文件的相对路径清单（来自包内 manifest.json 的 files 字段）；缺省表示未知。 */
  files?: string[];
  lorebook?: ManifestLorebook;
};

/**
 * 轻量角色配置（双击拉取，不下载模型）。对应 GET /api/avatars/:id 的子集：
 * 仅取 persona / transform / name / summary，模型与动作文件保持本地内置不变。
 * 字段全部可选——缺失即沿用本地兜底（见 mergeRemoteConfig）。
 */
export type RemoteAvatarConfig = {
  name?: string;
  summary?: string;
  persona?: Partial<AvatarManifest['persona']>;
  transform?: RemoteAvatarTransform;
  voice?: string;
  defaultBackground?: string;
  /** 触达路由三件套（服务端配置，来电/通知消费）：立绘 / 铃声 / 通知提示音，均为绝对 URL。 */
  portraitUrl?: string;
  ringtoneUrl?: string;
  notifySoundUrl?: string;
  /** 待机动作增强（后台每角色配置）。enabled 缺省视为 true；intervalSec 为 null = 用引擎内置默认区间。 */
  idleEnhancement?: { enabled: boolean; intervalSec: number | null };
  /** 世界书设定集（服务端 GET /api/avatars/:id 与 catalog 均会透传）。 */
  lorebook?: ManifestLorebook;
  /** 角色级 prompt 模板（服务端 GET /api/avatars/:id 与 catalog 均会透传）。 */
  promptTemplate?: ContextTemplate;
};

export type ModelJsonPayload = {
  FileReferences?: {
    DisplayInfo?: string;
    Expressions?: Array<{
      Name?: string;
      File?: string;
    }>;
  };
  // model3.json 顶层 Groups：口型同步参数声明在 Name==="LipSync" 的 Ids 里。
  Groups?: Array<{
    Target?: string;
    Name?: string;
    Ids?: string[];
  }>;
};

export type Cdi3Payload = {
  Parameters?: Array<{
    Id?: string;
    Name?: string;
  }>;
};

export type VtubePayload = {
  ParameterSettings?: Array<{
    Name?: string;
    OutputLive2D?: string;
    OutputRangeLower?: number;
    OutputRangeUpper?: number;
  }>;
};

export type DiscoveredParameterInfo = {
  id: ParameterId;
  name?: string;
  min?: number;
  max?: number;
};

// Mouth sync types (ALL-173)
export type MouthSyncTarget = {
  avatarId: string;
  parameterId: string;
  min: number;
  max: number;
  neutral: number;
};

export type MouthSyncSource = 'voice-message' | 'tts' | 'track' | 'debug' | 'unknown';

export type MouthSyncState = {
  active: boolean;
  source: MouthSyncSource;
  level: number;
  appliedValue: number;
  target?: MouthSyncTarget;
};
