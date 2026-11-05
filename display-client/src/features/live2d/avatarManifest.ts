// Re-exports
export type {
  ExpressionId,
  ExpressionLayer,
  ExpressionBinding,
  ExpressionKind,
  AvatarExpression,
  UnifiedAction,
  UnifiedActionKind,
  ParameterId,
  ParameterOverride,
  AvatarParameterControl,
  MotionBinding,
  WatermarkBinding,
  AvatarManifest,
  AvatarResolver,
  UgcPolicy,
  ContextTemplate,
  RenderContext,
  ModelJsonPayload,
  Cdi3Payload,
  VtubePayload,
  DiscoveredParameterInfo,
  DiscoveredLive2DParameter,
  DiscoveredLive2DParameterSource,
  ParameterCall,
  Live2DParameterDiscoveryResult,
  MouthSyncTarget,
  MouthSyncSource,
  MouthSyncState,
} from './types.ts';

export {
  avatars,
  avatarList,
  avatarResolvers,
  featuredAvatarIds,
  getAvatarById,
  useAvatarList,
  useAvatarById,
  applyRemoteOverrides,
  clearRemoteOverrides,
  NO_AVATAR,
  applyRemoteConfig,
  mergeRemoteConfig,
  baseAvatar,
  createModelTransform,
  parameterControl,
  publicAsset,
  assetExists,
} from './avatarData.ts';

import type {
  AvatarManifest,
  AvatarExpression,
  AvatarParameterControl,
  UnifiedAction,
  UnifiedActionKind,
  ExpressionId,
  ParameterId,
  ExpressionBinding,
  ExpressionKind,
  ModelJsonPayload,
  Cdi3Payload,
  VtubePayload,
  DiscoveredParameterInfo,
  DiscoveredLive2DParameterSource,
  DiscoveredLive2DParameter,
} from './types.ts';
import { avatarResolvers, getAvatarById } from './avatarData.ts';

// --- Constants ---

export const genericParameterCatalog = [
  { id: 'ParamAngleX', label: 'Head Turn X', prompt: 'turn head left or right', fallbackMin: -30, fallbackMax: 30 },
  { id: 'ParamAngleY', label: 'Head Tilt Y', prompt: 'tilt head up or down', fallbackMin: -30, fallbackMax: 30 },
  { id: 'ParamAngleZ', label: 'Head Roll Z', prompt: 'roll head sideways', fallbackMin: -30, fallbackMax: 30 },
  { id: 'ParamBodyAngleX', label: 'Body Turn X', prompt: 'rotate upper body left or right', fallbackMin: -15, fallbackMax: 15 },
  { id: 'ParamBodyAngleY', label: 'Body Turn Y', prompt: 'lean upper body forward or backward', fallbackMin: -10, fallbackMax: 10 },
  { id: 'ParamBodyAngleZ', label: 'Body Roll Z', prompt: 'roll upper body sideways', fallbackMin: -15, fallbackMax: 15 },
  { id: 'ParamEyeBallX', label: 'Eye Look X', prompt: 'shift gaze left or right', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamEyeBallY', label: 'Eye Look Y', prompt: 'shift gaze up or down', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamBrowLY', label: 'Left Brow Y', prompt: 'raise or lower the left eyebrow', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamBrowRY', label: 'Right Brow Y', prompt: 'raise or lower the right eyebrow', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamBrowLAngle', label: 'Left Brow Angle', prompt: 'tilt the left eyebrow angle', fallbackMin: -30, fallbackMax: 30 },
  { id: 'ParamBrowRAngle', label: 'Right Brow Angle', prompt: 'tilt the right eyebrow angle', fallbackMin: -30, fallbackMax: 30 },
  { id: 'ParamBrowLForm', label: 'Left Brow Form', prompt: 'change the left eyebrow toward soft or tense form', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamBrowRForm', label: 'Right Brow Form', prompt: 'change the right eyebrow toward soft or tense form', fallbackMin: -1, fallbackMax: 1 },
  { id: 'ParamCheek', label: 'Cheek Flush', prompt: 'increase cheek blush intensity', fallbackMin: 0, fallbackMax: 1 },
  { id: 'ParamMouthOpenY', label: 'Mouth Open', prompt: 'open or close the mouth vertically', fallbackMin: 0, fallbackMax: 1 },
  { id: 'ParamMouthForm', label: 'Mouth Form', prompt: 'shape the mouth toward smile or pout', fallbackMin: -1, fallbackMax: 1 },
] as const;

const expressionAssetModules = import.meta.glob('../../../public/live2D/**/*.exp3.json', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const avatarResolutionCache = new Map<string, Promise<AvatarManifest>>();

// --- Asset utilities ---

async function fetchOptionalJson<T>(assetPath: string) {
  try {
    const response = await fetch(encodeURI(assetPath));
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function getModelDirectory(modelJson: string) {
  return modelJson.slice(0, modelJson.lastIndexOf('/') + 1);
}

function resolveRelativeAsset(modelJson: string, assetPath: string) {
  if (/^https?:\/\//i.test(assetPath) || assetPath.startsWith(import.meta.env.BASE_URL)) {
    return assetPath;
  }
  return `${getModelDirectory(modelJson)}${assetPath.replace(/^\.?\/+/, '')}`;
}

function createVtubeCandidatePath(modelJson: string) {
  return modelJson.replace(/\.model3\.json$/i, '.vtube.json');
}

function stripBaseUrl(assetPath: string) {
  const baseUrl = import.meta.env.BASE_URL || '/';
  return assetPath.startsWith(baseUrl) ? assetPath.slice(baseUrl.length) : assetPath.replace(/^\/+/, '');
}

// --- Expression naming utilities ---

function normalizeExpressionFileName(value: string) {
  return value.replace(/\.exp3\.json$/i, '').trim();
}

function toExpressionId(value: string) {
  const normalized = normalizeExpressionFileName(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'expression';
}

function toExpressionLabel(value: string) {
  const normalized = normalizeExpressionFileName(value);
  if (/[一-鿿]/u.test(normalized)) return normalized;
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferExpressionKind(value: string): ExpressionKind {
  const normalized = normalizeExpressionFileName(value).toLowerCase();
  if (/(flower|sparkle|effect|question|\?|花|问号|特效|汗|teardrop)/i.test(normalized)) return 'effect';
  if (/(game|gaming|microphone|mic|pillow|flag|controller|话筒|抱枕|旗|游戏)/i.test(normalized)) return 'prop';
  if (/(pose|hand|finger_heart|fingerheart|比心|手|姿势)/i.test(normalized)) return 'pose';
  return 'emotion';
}

function createGenericExpressionPrompt(label: string, kind: ExpressionKind) {
  if (kind === 'pose') return `pose cue "${label}"`;
  if (kind === 'prop') return `prop or held-item cue "${label}"`;
  if (kind === 'effect') return `visual effect cue "${label}"`;
  return `facial expression cue "${label}"`;
}

function normalizeDiscoveredRange(
  lower: number | undefined,
  upper: number | undefined,
  fallbackMin: number,
  fallbackMax: number,
) {
  if (typeof lower !== 'number' || typeof upper !== 'number' || Number.isNaN(lower) || Number.isNaN(upper)) {
    return { min: fallbackMin, max: fallbackMax };
  }
  return { min: Math.min(lower, upper), max: Math.max(lower, upper) };
}

// --- Auto-discovery ---

type ExpressionParameterPayload = {
  Parameters?: Array<{
    Id?: string;
  }>;
};

type ParameterDraft = Omit<DiscoveredLive2DParameter, 'source' | 'callable'> & {
  source: Set<DiscoveredLive2DParameterSource>;
  callable?: boolean;
};

function addParameterSource(
  parameters: Map<ParameterId, ParameterDraft>,
  avatar: AvatarManifest,
  id: ParameterId,
  source: DiscoveredLive2DParameterSource,
  metadata: Partial<Pick<DiscoveredLive2DParameter, 'label' | 'min' | 'max' | 'defaultValue' | 'currentValue'>> = {},
) {
  const existing = parameters.get(id);
  const next: ParameterDraft = existing ?? {
    avatarId: avatar.id,
    avatarName: avatar.name,
    id,
    source: new Set(),
  };

  next.source.add(source);
  if (metadata.label && !next.label) next.label = metadata.label;
  if (typeof metadata.min === 'number') next.min = metadata.min;
  if (typeof metadata.max === 'number') next.max = metadata.max;
  if (typeof metadata.defaultValue === 'number') next.defaultValue = metadata.defaultValue;
  if (typeof metadata.currentValue === 'number') next.currentValue = metadata.currentValue;
  parameters.set(id, next);
}

function finalizeDiscoveredParameters(parameters: Map<ParameterId, ParameterDraft>) {
  return Array.from(parameters.values())
    .map((parameter): DiscoveredLive2DParameter => ({
      avatarId: parameter.avatarId,
      avatarName: parameter.avatarName,
      id: parameter.id,
      label: parameter.label,
      min: parameter.min,
      max: parameter.max,
      defaultValue: parameter.defaultValue,
      currentValue: parameter.currentValue,
      source: Array.from(parameter.source),
      callable: parameter.callable ?? parameter.source.has('runtime'),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function discoverExpressionParameterIds(expressions: AvatarExpression[]) {
  const discovered = new Set<ParameterId>();

  for (const expression of expressions) {
    if (expression.binding.mode !== 'file') continue;
    const payload = await fetchOptionalJson<ExpressionParameterPayload>(expression.binding.file);
    for (const parameter of payload?.Parameters ?? []) {
      if (parameter.Id) discovered.add(parameter.Id);
    }
  }

  return discovered;
}

export async function discoverAvatarResourceParameters(
  avatar: AvatarManifest,
  expressions: AvatarExpression[] = avatar.expressions,
) {
  const modelSettings = await fetchOptionalJson<ModelJsonPayload>(avatar.modelJson);
  const displayInfoPath = modelSettings?.FileReferences?.DisplayInfo
    ? resolveRelativeAsset(avatar.modelJson, modelSettings.FileReferences.DisplayInfo)
    : null;
  const vtubePath = createVtubeCandidatePath(avatar.modelJson);

  const [displayInfo, vtubeInfo, expressionParameterIds] = await Promise.all([
    displayInfoPath ? fetchOptionalJson<Cdi3Payload>(displayInfoPath) : Promise.resolve(null),
    fetchOptionalJson<VtubePayload>(vtubePath),
    discoverExpressionParameterIds(expressions),
  ]);

  const discovered = new Map<ParameterId, ParameterDraft>();

  for (const parameter of displayInfo?.Parameters ?? []) {
    if (!parameter.Id) continue;
    addParameterSource(discovered, avatar, parameter.Id, 'cdi3', { label: parameter.Name });
  }

  for (const parameter of vtubeInfo?.ParameterSettings ?? []) {
    if (!parameter.OutputLive2D) continue;
    addParameterSource(discovered, avatar, parameter.OutputLive2D, 'vtube', {
      label: parameter.Name,
      min: typeof parameter.OutputRangeLower === 'number' ? parameter.OutputRangeLower : undefined,
      max: typeof parameter.OutputRangeUpper === 'number' ? parameter.OutputRangeUpper : undefined,
    });
  }

  for (const parameterId of expressionParameterIds) {
    addParameterSource(discovered, avatar, parameterId, 'exp3');
  }

  for (const catalog of genericParameterCatalog) {
    addParameterSource(discovered, avatar, catalog.id, 'generic', {
      label: catalog.label,
      min: catalog.fallbackMin,
      max: catalog.fallbackMax,
    });
  }

  return finalizeDiscoveredParameters(discovered);
}

export function mergeDiscoveredLive2DParameters(
  avatar: AvatarManifest,
  sources: DiscoveredLive2DParameter[][],
) {
  const merged = new Map<ParameterId, ParameterDraft>();

  for (const sourceList of sources) {
    for (const parameter of sourceList) {
      for (const source of parameter.source) {
        addParameterSource(merged, avatar, parameter.id, source, {
          label: parameter.label,
          min: parameter.min,
          max: parameter.max,
          defaultValue: parameter.defaultValue,
          currentValue: parameter.currentValue,
        });
      }
      const draft = merged.get(parameter.id);
      if (draft) draft.callable = draft.callable || parameter.callable;
    }
  }

  return finalizeDiscoveredParameters(merged);
}

async function discoverAvatarParameterControls(avatar: AvatarManifest) {
  const modelSettings = await fetchOptionalJson<ModelJsonPayload>(avatar.modelJson);
  const displayInfoPath = modelSettings?.FileReferences?.DisplayInfo
    ? resolveRelativeAsset(avatar.modelJson, modelSettings.FileReferences.DisplayInfo)
    : null;
  const vtubePath = createVtubeCandidatePath(avatar.modelJson);

  const [displayInfo, vtubeInfo] = await Promise.all([
    displayInfoPath ? fetchOptionalJson<Cdi3Payload>(displayInfoPath) : Promise.resolve(null),
    fetchOptionalJson<VtubePayload>(vtubePath),
  ]);

  const discovered = new Map<ParameterId, DiscoveredParameterInfo>();

  for (const parameter of displayInfo?.Parameters ?? []) {
    if (!parameter.Id) continue;
    discovered.set(parameter.Id, { id: parameter.Id, name: parameter.Name });
  }

  for (const parameter of vtubeInfo?.ParameterSettings ?? []) {
    if (!parameter.OutputLive2D) continue;
    const existing = discovered.get(parameter.OutputLive2D);
    discovered.set(parameter.OutputLive2D, {
      id: parameter.OutputLive2D,
      name: parameter.Name ?? existing?.name,
      min: typeof parameter.OutputRangeLower === 'number' ? parameter.OutputRangeLower : existing?.min,
      max: typeof parameter.OutputRangeUpper === 'number' ? parameter.OutputRangeUpper : existing?.max,
    });
  }

  const discoveredControls = genericParameterCatalog
    .map((catalog): AvatarParameterControl | null => {
      const info = discovered.get(catalog.id);
      if (!info) return null;
      const { min, max } = normalizeDiscoveredRange(info.min, info.max, catalog.fallbackMin, catalog.fallbackMax);
      return { id: catalog.id, label: catalog.label, prompt: catalog.prompt, min, max };
    });
  return discoveredControls.filter((item): item is AvatarParameterControl => item !== null);
}

function getWatermarkFiles(avatar: AvatarManifest) {
  return new Set(
    avatar.watermark?.bindings
      .filter((binding): binding is Extract<ExpressionBinding, { mode: 'file' }> => binding.mode === 'file')
      .map((binding) => stripBaseUrl(binding.file)) ?? [],
  );
}

function getExpressionAssetsForAvatar(avatar: AvatarManifest) {
  const avatarDirectory = stripBaseUrl(getModelDirectory(avatar.modelJson)).replace(/\/+$/, '');
  return Object.entries(expressionAssetModules)
    .map(([sourcePath, assetUrl]) => ({
      publicPath: sourcePath.replace(/^.*\/public\//, '').replace(/\\/g, '/'),
      assetUrl,
    }))
    .filter((asset) => asset.publicPath.startsWith(`${avatarDirectory}/`));
}

async function discoverAvatarExpressions(avatar: AvatarManifest) {
  const modelSettings = await fetchOptionalJson<ModelJsonPayload>(avatar.modelJson);
  const watermarkFiles = getWatermarkFiles(avatar);
  const expressionAssets = getExpressionAssetsForAvatar(avatar);

  const referencedExpressions = (modelSettings?.FileReferences?.Expressions ?? [])
    .filter((item) => item.File)
    .map((item) => {
      const publicPath = stripBaseUrl(resolveRelativeAsset(avatar.modelJson, item.File!));
      const asset = expressionAssets.find((candidate) => candidate.publicPath === publicPath);
      if (!asset) return null;
      return {
        name: item.Name?.trim() || normalizeExpressionFileName(publicPath.split('/').pop() ?? ''),
        publicPath: asset.publicPath,
        assetUrl: asset.assetUrl,
      };
    })
    .filter((item): item is { name: string; publicPath: string; assetUrl: string } => Boolean(item));

  const expressionSources = referencedExpressions.length > 0
    ? referencedExpressions
    : expressionAssets.map((asset) => ({
        name: normalizeExpressionFileName(asset.publicPath.split('/').pop() ?? ''),
        publicPath: asset.publicPath,
        assetUrl: asset.assetUrl,
      }));

  const discoveredExpressions: AvatarExpression[] = [];
  const seen = new Set<string>();

  for (const source of expressionSources) {
    if (watermarkFiles.has(source.publicPath)) continue;
    const id = toExpressionId(source.name);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = toExpressionLabel(source.name);
    const kind = inferExpressionKind(source.name);
    discoveredExpressions.push({
      id,
      label,
      kind,
      prompt: createGenericExpressionPrompt(label, kind),
      binding: { mode: 'file', file: source.assetUrl },
      aliases: [],
    });
  }

  const neutralExpression: AvatarExpression = {
    id: 'neutral',
    label: 'Neutral',
    kind: 'emotion',
    prompt: 'default calm face with no extra expression overlay',
    binding: { mode: 'preset', params: {} },
    aliases: ['neutral', 'calm', 'normal', 'default'],
  };

  return [neutralExpression, ...discoveredExpressions];
}

// --- 统一动作清单（Motions + Expressions 合并） ---

// ExpressionKind(emotion/pose/prop/effect) → UnifiedActionKind。
// pose/prop/effect 在现有 prompt 里就按「持久 on/off 场景层」处理 → 归为 costume；emotion → emotion。
function mapExpressionKindToActionKind(kind: ExpressionKind): UnifiedActionKind {
  return kind === 'emotion' ? 'emotion' : 'costume';
}

// 按 _ / 空格 / 连字符 / 驼峰 切词。snake_case 友好，且能避免子串误伤：
// 'swing' 整词不含 'wing' token，'detail' 整词不含 'tail' token，'ear_perk' 切成 ['ear','perk']。
function tokenizeActionName(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

// 无歧义的穿戴/造型/发型 token（作为整词出现才算；末尾数字会被剥离，故 hat1→hat、hairstyle2→hairstyle）。
const COSTUME_TOKENS = new Set([
  'glasses', 'costume', 'outfit', 'dress', 'mask', 'crown', 'hat', 'cap', 'hood',
  'cape', 'ribbon', 'eyepatch', 'bunny', 'console', 'pupil', 'pupils', 'wig',
  'horn', 'horns', 'wing', 'wings',
  'hair', 'hairstyle', 'headset', 'headphone', 'headphones', 'headband', 'earring', 'earrings',
  // 尺寸/形态变身:持久状态,直到明确取消(如 Estella 的 "Get smaller" 变小→正太)。
  'smaller', 'bigger', 'small', 'tiny', 'giant', 'shrink', 'chibi', 'huge',
]);
// ear/ears/tail 有歧义：cat_ears(造型) vs ear_perk(动作)。仅当前缀是动物词时才判为造型。
const ANIMAL_PREFIX = new Set(['cat', 'dog', 'fox', 'wolf', 'bear', 'rabbit', 'neko', 'bunny']);

// 名称是否像「穿戴/造型」。同时用于 Expressions(cat_ears/black_mask 等) 与 Motions。
function isCostumeName(value: string): boolean {
  const tokens = tokenizeActionName(value);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const base = token.replace(/\d+$/, ''); // hat1→hat, hairstyle2→hairstyle
    if (COSTUME_TOKENS.has(token) || COSTUME_TOKENS.has(base)) return true;
    if ((token === 'ear' || token === 'ears' || token === 'tail') && i > 0 && ANIMAL_PREFIX.has(tokens[i - 1])) {
      return true;
    }
  }
  return false;
}

// 明确情绪词（情绪常为完整词，用正则匹配词干即可，如 surpris→surprised）。
const MOTION_EMOTION_RE = /(happy|joy|sad|cry|angry|mad|shy|blush|embarrass|surpris|shock|panic|pout|sulk|giggle|laugh|smile|cheer|excit|love)/i;

function inferMotionActionKind(key: string): UnifiedActionKind {
  if (isCostumeName(key)) return 'costume';
  if (MOTION_EMOTION_RE.test(key.toLowerCase())) return 'emotion';
  return 'action';
}

// expression 的 kind：名称像穿戴/造型则 costume（即便 inferExpressionKind 归为 emotion，
// 如 Estella 的 cat_ears），否则按 ExpressionKind 映射。
function inferExpressionActionKind(expr: AvatarExpression): UnifiedActionKind {
  if (isCostumeName(expr.id) || isCostumeName(expr.label)) return 'costume';
  return mapExpressionKindToActionKind(expr.kind);
}

function toActionId(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'action';
}

function createGenericMotionPrompt(label: string, kind: UnifiedActionKind) {
  if (kind === 'emotion') return `表达「${label}」情绪时使用`;
  if (kind === 'costume') return `切换「${label}」造型/场景层（持久保持，直到明确取消）`;
  return `做出「${label}」动作`;
}

/**
 * 把 Expressions 和 Motions 合并成一张统一动作清单。
 * - Expressions（含 neutral）先入表，source='expression'（可混合，优先级更高）；
 * - Motions 的 group 名作为 source='motion'，与已有 expression id 冲突时跳过（expression 优先）；
 * - kind 优先取 avatarData 显式覆盖（MotionBinding.kind），否则按关键字正则推断。
 */
export function buildUnifiedActions(
  avatar: Pick<AvatarManifest, 'expressions' | 'motions'>,
): UnifiedAction[] {
  const actions: UnifiedAction[] = [];
  const seen = new Set<string>();

  for (const expr of avatar.expressions) {
    if (seen.has(expr.id)) continue;
    seen.add(expr.id);
    actions.push({
      id: expr.id,
      label: expr.label,
      source: 'expression',
      ref: expr.id,
      kind: inferExpressionActionKind(expr),
      prompt: expr.prompt,
      aliases: expr.aliases ?? [],
    });
  }

  for (const [key, binding] of Object.entries(avatar.motions ?? {})) {
    const id = toActionId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = binding.kind ?? inferMotionActionKind(key);
    const label = binding.label ?? toExpressionLabel(key);
    actions.push({
      id,
      label,
      source: 'motion',
      ref: key, // model.motion 用原始 group 名
      kind,
      prompt: binding.prompt ?? createGenericMotionPrompt(label, kind),
      aliases: binding.aliases ?? [],
    });
  }

  return actions;
}

async function enrichAvatarManifest(avatar: AvatarManifest) {
  const [discoveredExpressions, parameterControls] = await Promise.all([
    discoverAvatarExpressions(avatar),
    discoverAvatarParameterControls(avatar),
  ]);
  // 清单里已声明的表情（内置 / 覆盖包继承）优先，目录发现的只补未声明的。
  // 覆盖包模型目录下没有 exp3 时发现结果只剩 neutral，直接替换会把继承来的
  // 表情清单清空，v2 换装/表情触发全部查无此物（v3 覆盖包事故的另一半）。
  const declaredIds = new Set(avatar.expressions.map((expression) => expression.id));
  const expressions = [
    ...avatar.expressions,
    ...discoveredExpressions.filter((expression) => !declaredIds.has(expression.id)),
  ];
  const actions = buildUnifiedActions({ expressions, motions: avatar.motions });
  return { ...avatar, expressions, parameterControls, actions } as AvatarManifest;
}

// --- Public API ---

export async function resolveAvatarManifest(avatar: AvatarManifest) {
  const cached = avatarResolutionCache.get(avatar.id);
  if (cached) return cached;

  const resolver = avatarResolvers.get(avatar.id);
  const resolution = Promise.resolve(resolver ? resolver() : avatar).then(enrichAvatarManifest);
  avatarResolutionCache.set(avatar.id, resolution);
  return resolution;
}

export function resolveAvatarManifestById(avatarId: string) {
  const avatar = getAvatarById(avatarId);
  if (avatar === undefined) return Promise.reject(new Error(`这台机器上没有形象 ${avatarId}`));
  return resolveAvatarManifest(avatar);
}

/**
 * 丢弃某角色已缓存的解析结果，使下次 resolveAvatarManifest 重新富集。
 * 远端配置（persona/transform）更新后调用，保证切走再切回拿到的是新值。
 */
export function invalidateAvatarResolution(avatarId: string) {
  avatarResolutionCache.delete(avatarId);
}

export function getAvatarExpression(avatar: AvatarManifest, expressionId: ExpressionId) {
  return avatar.expressions.find((item) => item.id === expressionId);
}

export function getAvatarExpressionIds(avatar: AvatarManifest) {
  return avatar.expressions.map((item) => item.id);
}

export function getAvatarExpressionLabel(avatar: AvatarManifest, expressionId: ExpressionId) {
  return getAvatarExpression(avatar, expressionId)?.label ?? expressionId;
}

export function getAvatarNeutralExpressionId(avatar: AvatarManifest) {
  return avatar.expressions.find((item) => item.id === 'neutral')?.id
    ?? avatar.expressions[0]?.id
    ?? 'neutral';
}

export function hasAvatarExpression(avatar: AvatarManifest, expressionId: ExpressionId) {
  return avatar.expressions.some((item) => item.id === expressionId);
}

export function getAvatarParameterControl(avatar: AvatarManifest, parameterId: ParameterId) {
  return avatar.parameterControls?.find((item) => item.id === parameterId);
}

/** 按 id 或 alias 查统一动作（大小写不敏感）。清单外返回 undefined，由调用方决定 fallback。 */
export function getAvatarAction(avatar: AvatarManifest, idOrAlias: string): UnifiedAction | undefined {
  const normalized = idOrAlias.trim().toLowerCase();
  if (!normalized) return undefined;
  return avatar.actions?.find(
    (action) => action.id === normalized
      || action.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

/**
 * 生成「仅含 id+label+prompt」的动作清单文本，供注入 system prompt。
 * （本步只提供函数，接入 prompt 在 LLM 字段解析那一步单独完成。）
 */
export function formatActionCatalog(actions: UnifiedAction[] = []): string {
  return actions
    .map((action) => `- id: "${action.id}", label: "${action.label}", meaning: "${action.prompt}"`)
    .join('\n');
}

/**
 * 读取 model3.json 顶层 Groups 中 Name==="LipSync" 的 Ids（口型同步参数）。
 * 这是口型参数 id 的最优先来源：模型加载即可用、且换模型自动适配。
 * 注意：必须用 Ids.length>0 判断——有的模型声明了 LipSync 组但 Ids 为空数组
 * （如 Estella），此时应返回 [] 让调用方跌落到运行时发现 / 硬编码兜底，
 * 而不能因「找到了 LipSync 组」就返回空 id。
 * 读取失败（网络/JSON 异常）一律返回 []，不抛错。
 */
export async function readLipSyncParamIds(modelJsonUrl: string): Promise<string[]> {
  const payload = await fetchOptionalJson<ModelJsonPayload>(modelJsonUrl);
  const ids = payload?.Groups?.find((group) => group.Name === 'LipSync')?.Ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}
