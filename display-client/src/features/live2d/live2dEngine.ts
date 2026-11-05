import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { isLowEndDevice, downscaleTexturePath } from '../../lib/deviceTier.ts';
import { createAugmentedSettings as createAugmentedSettingsBase } from './modelSettings.ts';
import type {
  AvatarManifest,
  AvatarExpression,
  DiscoveredLive2DParameter,
  ExpressionBinding,
  ExpressionLayer,
  ParameterCall,
  ParameterOverride,
  UnifiedAction,
} from './avatarManifest.ts';
import { getAvatarAction, getAvatarNeutralExpressionId } from './avatarManifest.ts';
import type { SurfaceKey } from './types.ts';
import { dizzyWobble } from './dizzyWobble.ts';
import type { CostumeSlot } from './profile/types.ts';
import { computeCoverScale } from './coverScale.ts';

// 各界面的取景目标：headScreenY=脸中心在屏高的归一化位置，faceScreenFrac=脸高占屏高的比例。
// topClampMin=computeModelLayout 顶部钳制下限(×rawHeight)，默认 -0.2；桌宠全身要撑满窗口须放开
// （Q版 morph 让角色缩在模型 bbox 下半部、上方空白，-0.2 会把角色顶死在上、放大即沉底出界）。
// fitWindowHeight=按真实窗口高度(rawHeight)适配，跳过「虚拟竖屏」放大。默认关(其余界面走虚拟竖屏=方屏仅裁腿、头保框内)。
// 桌宠全身要露完整脚 → 开它，否则方屏/非3:4 窗口按虚拟竖屏放大会把腿脚裁出画。
export const SURFACE_FRAMING: Record<SurfaceKey, { headScreenY: number; faceScreenFrac: number; topClampMin?: number; fitWindowHeight?: boolean }> = {
  home:  { headScreenY: 0.30, faceScreenFrac: 0.19 },
  login: { headScreenY: 0.34, faceScreenFrac: 0.19 },
  dj:    { headScreenY: 0.22, faceScreenFrac: 0.17 },
  // U3 电台 DJ 页：胸部以上的近景（Ben「只显示胸部以上会比较好，现在好小一只」）。
  // 与 dj 分开是因为 dj 还服务 DjMode/屏保的全身构图；这里脸放到两倍大、位置略往下留头顶空间。
  // 三只电台角色比例迥异（猫/狗/幽灵），靠各自 avatar 的 headAnchorY/headSizeNorm 归一化到同一取景，
  // 而不是给每只写一套 transform——那样加角色就要重调一轮。
  radio: { headScreenY: 0.30, faceScreenFrac: 0.43 },
  // holo 全息屏：独立可调构图(URL ?scale= 调大小 / ?head= 调竖向)。默认全身略小、头靠上留空。
  // faceScreenFrac=脸占屏比(大小)、headScreenY=头竖向位置(0靠顶/1靠底)——两者独立解算，互不干扰、不飞屏。
  holo:  { headScreenY: 0.20, faceScreenFrac: 0.11 },
  // 桌宠浮窗：上半身特写（脸更大=拉近，腿切出画）。真机可一行微调这两个值。
  pet:     { headScreenY: 0.35, faceScreenFrac: 0.31 },
  // 掌机底条（720×240 满宽横条）：取景值与 pet 相同，唯一差别是放开顶部钳制。
  // ★不放开的话位置滑块必死：条只有 240px 高而角色模型远高于条，模型顶部深度越界，
  // 默认钳制 [-0.2,0.55]×240px 把 ha 滑块的整个行程都夹在同一个位置上（7-29 实锤，
  // Ben「滑到最左和最右都不行」）。-3 与 petFull 同值=事实上不钳。
  petStrip: { headScreenY: 0.35, faceScreenFrac: 0.31, topClampMin: -3 },
  // 桌宠·全身（chibi/Q版角色，如 rattan）：脸更小=拉远，露全身腿脚。放开顶部钳制+按真实窗口高度适配→任何比例都露全身撑满。
  petFull: { headScreenY: 0.30, faceScreenFrac: 0.19, topClampMin: -3, fitWindowHeight: true },
  // 桌宠·视频通话：比 pet 更近的上半身特写（脸更大=更近，视频「面对面」感）。初值预览调。
  petCall: { headScreenY: 0.42, faceScreenFrac: 0.38 },
};

declare global {
  interface Window {
    PIXI: typeof PIXI;
    Live2DCubismCore?: object;
  }
}

// PixiJS 6 把 filters 导成值 const（非类型/命名空间），故类型位置无法直接写
// PIXI.filters.DisplacementFilter；用 typeof 从值推导实例类型（运行时构造仍走 PIXI.filters.*）。
type DisplacementFilter = InstanceType<typeof PIXI.filters.DisplacementFilter>;

type DepthLayerState = {
  bgSprite: PIXI.Sprite;
  depthSprite: PIXI.Sprite;
  filter: DisplacementFilter;
  bgTexture: PIXI.Texture;
  depthTexture: PIXI.Texture;
};

// 背景/深度 Sprite 的 cover overscan：略放大给位移滤镜留边缘余量，防露白。
const DEPTH_OVERSCAN = 1.18;

// 每个 WebGL 上下文只承载一个 Cubism 模型：同一上下文里常驻第二个模型会冻死第一个的 moc 形变（已真机实证）。
// 三页(登录/主页/DJ)共用同一个模型实例，换装走参数(Param67)、切页只改构图/参数，绝不在上下文里加载第二个模型。
export type RuntimeState = {
  model: Live2DModel;
  activeParams: Map<string, number> | null;
  overlayCurrentParams: Map<string, number>;
  overlayTargetParams: Map<string, number>;
  baselineParams: Map<string, number>;
  trackedParamIds: Set<string>;
  app: PIXI.Application;
  avatar: AvatarManifest;
  modelBaseWidth: number;
  modelBaseHeight: number;
  currentTransform: StageTransform;
  currentBounds: ModelBounds;
  resolvedBindingCache: Map<string, ResolvedBinding>;
  expressionMix: ExpressionLayer[];
  parameterOverrides: ParameterOverride[];
  watermarkVisible: boolean;
  mouthSyncOverrides: Map<string, number>;
  // 持久参数覆盖（如 DJ 换装 Param67=1）：每帧应用，独立于口型，不被 setMouthSyncOverrides 替换。
  costumeParamOverrides: Map<string, number>;
  // SoulLink 情绪层：每帧由 soullinkBridge 刷新，写在 costume 之后、口型之前。仅含情绪域参数。
  soullinkEmotionParams: Map<string, number>;
  // playAction 维护的分层表情：costume 持久（换装/场景层，不被情绪覆盖），
  // emotion 临时（触发后定时回落）。两者合并成 expressionMix，使「戴猫耳时变开心」不丢猫耳。
  costumeMix: ExpressionLayer[];
  emotionMix: ExpressionLayer[];
  emotionResetTimer: ReturnType<typeof setTimeout> | null;
  // 渲染循环健康监测：最后一帧 ticker 回调的时间戳（performance.now）。
  lastTickAt: number;
  // 待机动作组名（avatar.motions 第一个 idle*）；无 idle 动作时为 null。
  idleMotionKey: string | null;
  // 待机看门狗上次补播的时间戳（节流 + 卡死恢复）。
  lastIdleRequestAt: number;
  // —— 待机小动作调度（在基础待机之上每隔随机间隔插一个「小动作拍」）——
  // 待机动作增强总开关（后台每角色可配）；false → 不插任何小动作拍。
  idleBeatEnabled: boolean;
  // 小动作平均触发间隔（秒，后台可配）；null → 用内置默认区间。
  idleBeatIntervalSec: number | null;
  // 有动作库的模型可随机轮播的「安静」动作名；空数组 → 走程序化 focus 朝向拍。
  idleBeatKeys: string[];
  // idle=等下一拍；hold=程序化拍朝向保持中（到点转 recover）；recover=正缓慢收回中位。
  idleBeatPhase: 'idle' | 'hold' | 'recover';
  // 下一拍触发时间（performance.now）。
  idleBeatNextAt: number;
  // 当前相位（hold/recover）的截止时刻。
  idleBeatHoldUntil: number;
  // 程序化拍自管的 focus 点：每帧把 current 缓慢插值向 target，再喂给 focusController，
  // 在控制器自带平滑之上再加一层慢插值 → 转向柔和可控（解决「切到其他朝向太快」）。
  idleFocusX: number;
  idleFocusY: number;
  idleFocusTargetX: number;
  idleFocusTargetY: number;
  // —— 程序化朝向拍：基于时长的缓动（替代固定系数指数插值）——
  // 本段运动起点（捕获自进入该段时的 idleFocusX/Y）。
  idleFocusFromX: number;
  idleFocusFromY: number;
  // 本段运动起始时刻（performance.now）与时长。
  idleMoveStartAt: number;
  idleMoveDurMs: number;
  // 近期有指针交互 → 待机拍让位到此刻。
  idleSuppressUntil: number;
  // 摇一摇「晕」演出：触发时刻(ms)，null=未在演出。见 tickDizzy / triggerDizzyRuntime。
  dizzyStartAt: number | null;
  // 景深层（背景Sprite + 深度Sprite + DisplacementFilter），null=未建层。
  depthLayer: DepthLayerState | null;
  // 代际 token：每次 teardownDepthLayer 时递增，使在途的 setDepthParallaxBackground 加载失效（I1）。
  depthLoadToken: number;
  // 当前取景目标（对应 SURFACE_FRAMING 某一行），由 setFramingTarget 切换。
  framingTarget: { headScreenY: number; faceScreenFrac: number; topClampMin?: number; fitWindowHeight?: boolean };
  // 卸载时移除看门狗 / 可见性 / WebGL 上下文监听器。
  disposeWatchers?: () => void;
  // ---- v2 profile 触发通道（独立存在，不污染 playAction / expressionMix 等老通道） ----
  // 当前生效的 profile 表情文件名（如 '爱心眼.exp3'），由调度器生命周期管理。
  profileExpressionId: string | null;
  // profile 装扮：按 slot 持久保存对应的 expression 文件名。
  profileCostumeSlots: Map<CostumeSlot, string>;
  // profile 装扮解析后的参数覆盖，每帧直接写模型。
  profileCostumeParamOverrides: Map<string, number>;
  // 最近一次 profile motion 的文件名，用于 motionFinished 回调透传。
  profileMotionFile: string | null;
  // 是否有 profile motion 正在等待结束通知。
  profileMotionInFlight: boolean;
};

export type StageTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** 绝对构图标志：true=本 transform 是后台配置的「该页面绝对构图」（scale 相对模型基准、offset 相对布局高度），
   *  fitModel 直接按绝对语义施加（不再叠加 auto-fit 基准），并开启视口包含钳制。缺省 false=增量语义（现状）。 */
  absolute?: boolean;
};

export type ModelBounds = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  modelHeight: number;
  modelWidth: number;
};

export function getModelBounds(runtime: RuntimeState | null) {
  return runtime?.currentBounds ?? null;
}

type CubismCoreModel = {
  getParameterValueById(parameterId: string): number;
  setParameterValueById(parameterId: string, value: number, weight?: number): void;
  getParameterCount?: () => number;
  getParameterId?: (index: number) => string;
  getParameterValueByIndex?: (index: number) => number;
  getParameterMinimumValue?: (index: number) => number;
  getParameterMaximumValue?: (index: number) => number;
  getParameterDefaultValue?: (index: number) => number;
};

type CubismParameterTable = {
  count?: number;
  ids?: unknown[];
  values?: ArrayLike<number>;
  minimumValues?: ArrayLike<number>;
  maximumValues?: ArrayLike<number>;
  defaultValues?: ArrayLike<number>;
};

type CubismCoreModelWithTables = CubismCoreModel & {
  parameters?: CubismParameterTable;
  _model?: {
    parameters?: CubismParameterTable;
  };
};

type FocusControllerLike = {
  focus(x: number, y: number, instant?: boolean): void;
};

type ExpressionFilePayload = {
  Parameters?: Array<{
    Id?: string;
    Value?: number;
    Blend?: 'Add' | 'Multiply' | 'Overwrite' | string;
  }>;
};

type ResolvedBinding =
  | {
      mode: 'preset';
      params: Record<string, number>;
    }
  | {
      mode: 'file';
      params: Array<{
        id: string;
        value: number;
        blend: 'Add' | 'Multiply' | 'Overwrite';
      }>;
    };

function getCoreModel(runtime: RuntimeState) {
  return runtime.model.internalModel.coreModel as CubismCoreModel;
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeParameterId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  const text = String(value ?? '');
  return text && text !== '[object Object]' ? text : undefined;
}

function getRuntimeParameterTable(coreModel: CubismCoreModel) {
  const modelWithTables = coreModel as CubismCoreModelWithTables;
  return modelWithTables.parameters ?? modelWithTables._model?.parameters;
}

function getParameterFromTable(
  runtime: RuntimeState,
  table: CubismParameterTable,
  index: number,
): DiscoveredLive2DParameter | null {
  const id = normalizeParameterId(table.ids?.[index]);
  if (!id) return null;

  return {
    avatarId: runtime.avatar.id,
    avatarName: runtime.avatar.name,
    id,
    min: toFiniteNumber(table.minimumValues?.[index]),
    max: toFiniteNumber(table.maximumValues?.[index]),
    defaultValue: toFiniteNumber(table.defaultValues?.[index]),
    currentValue: toFiniteNumber(table.values?.[index]),
    source: ['runtime'],
    callable: true,
  };
}

function getParameterFromMethods(
  runtime: RuntimeState,
  coreModel: CubismCoreModel,
  index: number,
): DiscoveredLive2DParameter | null {
  const id = coreModel.getParameterId?.(index);
  if (!id) return null;

  return {
    avatarId: runtime.avatar.id,
    avatarName: runtime.avatar.name,
    id,
    min: toFiniteNumber(coreModel.getParameterMinimumValue?.(index)),
    max: toFiniteNumber(coreModel.getParameterMaximumValue?.(index)),
    defaultValue: toFiniteNumber(coreModel.getParameterDefaultValue?.(index)),
    currentValue: toFiniteNumber(coreModel.getParameterValueByIndex?.(index)),
    source: ['runtime'],
    callable: true,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    throw new Error(`Failed to fetch ${url} (${response.status}): ${body.slice(0, 200)}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

// export：原生渲染路径（nativeStage）复用同一份「增强 settings」逻辑——动作命名组注入 +
// 低端纹理降档在 JS 一处完成，原生端直接吃增强后的 model3.json 文本，两端零漂移。
// 实现抽在 modelSettings.ts（不依赖 PixiJS/DOM），构建期为动态壁纸烘 settings 的脚本也复用它。
export function createAugmentedSettings(
  settings: Record<string, unknown>,
  avatar: AvatarManifest,
): Record<string, unknown> {
  // 低端设备把模型纹理降档（构建期已生成变体），显存↓，避免弱机换页卡顿。
  return createAugmentedSettingsBase(settings, avatar, { mapTexturePath: downscaleTexturePath });
}

export function smootherstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 6 * clamped ** 5 - 15 * clamped ** 4 + 10 * clamped ** 3;
}

function easeTowards(current: number, target: number, factor: number) {
  if (Math.abs(target - current) <= 0.0005) {
    return target;
  }

  return current + (target - current) * factor;
}

function getOverlayFactor(paramId: string, hasExplicitTarget: boolean) {
  if (/^ParamEyeBall[XY]$/i.test(paramId)) {
    return hasExplicitTarget ? 0.24 : 0.16;
  }

  if (/^(ParamAngle|ParamBodyAngle)/i.test(paramId)) {
    return hasExplicitTarget ? 0.14 : 0.09;
  }

  if (/^Param(Brow|Cheek)/i.test(paramId)) {
    return hasExplicitTarget ? 0.18 : 0.12;
  }

  if (/^ParamMouthOpenY$/i.test(paramId)) {
    return hasExplicitTarget ? 0.22 : 0.14;
  }

  if (/^ParamMouthForm$/i.test(paramId)) {
    return hasExplicitTarget ? 0.18 : 0.12;
  }

  return hasExplicitTarget ? 0.16 : 0.1;
}

function ensureTrackedBaseline(runtime: RuntimeState, paramId: string) {
  if (runtime.trackedParamIds.has(paramId)) {
    return;
  }

  const coreModel = getCoreModel(runtime);
  runtime.trackedParamIds.add(paramId);
  runtime.baselineParams.set(paramId, coreModel.getParameterValueById(paramId));
}

function clampLayerWeight(weight: number) {
  return Math.min(Math.max(weight, 0), 1);
}

function normalizeBlend(value: string | undefined): 'Add' | 'Multiply' | 'Overwrite' {
  if (value === 'Multiply' || value === 'Overwrite') {
    return value;
  }

  return 'Add';
}

function normalizeProfileExpressionFile(file: string): string {
  // 与 avatarManifest.toExpressionId 对齐：空白/连字符折叠成下划线——
  // profile 的 file 是原始文件名（'Game console.exp3.json'），而目录发现生成的
  // expression.id 是归一化后的（'game_console'），不归一化永远匹配不上。
  return file
    .replace(/\.exp3(\.json)?$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function findAvatarExpressionByProfileFile(
  avatar: AvatarManifest,
  file: string,
): AvatarExpression | undefined {
  const target = normalizeProfileExpressionFile(file);
  return avatar.expressions.find((expression) => {
    // 优先按 id 匹配：生产构建后 expression 的 binding.file 会被 Vite 加 hash
    // （如 /assets/baowawa-BgT0QkHE.exp3.json），按 basename 比较会失败，
    // 但 expression.id 仍保持为原始文件名（如 baowawa）。
    if (expression.id.toLowerCase() === target) return true;
    if (expression.binding.mode !== 'file') return false;
    const expressionFile = normalizeProfileExpressionFile(expression.binding.file.split('/').pop() ?? '');
    return expressionFile === target;
  });
}

function getParameterDefaultById(coreModel: CubismCoreModel, paramId: string): number | undefined {
  const table = getRuntimeParameterTable(coreModel);
  if (table?.ids) {
    const count = table.count ?? table.ids.length;
    for (let index = 0; index < count; index += 1) {
      if (normalizeParameterId(table.ids[index]) === paramId) {
        return toFiniteNumber(table.defaultValues?.[index]);
      }
    }
  }

  const methodCount = coreModel.getParameterCount?.();
  if (typeof methodCount === 'number' && Number.isFinite(methodCount)) {
    for (let index = 0; index < methodCount; index += 1) {
      if (coreModel.getParameterId?.(index) === paramId) {
        return toFiniteNumber(coreModel.getParameterDefaultValue?.(index));
      }
    }
  }

  return undefined;
}

async function recomputeProfileCostumeParams(runtime: RuntimeState, avatar: AvatarManifest): Promise<void> {
  const previous = runtime.profileCostumeParamOverrides;
  const next = new Map<string, number>();
  for (const [slot, file] of runtime.profileCostumeSlots) {
    const expression = findAvatarExpressionByProfileFile(avatar, file);
    if (!expression) {
      console.warn(`[profile] costume expression not found: slot=${slot} file=${file}`);
      continue;
    }
    const resolved = await resolveBinding(runtime, expression.binding);
    if (resolved.mode === 'preset') {
      for (const [id, value] of Object.entries(resolved.params)) {
        next.set(id, value);
      }
    } else {
      for (const param of resolved.params) {
        next.set(param.id, param.value);
      }
    }
  }

  // 被移除的 costume 参数要显式写回 Cubism 默认值，否则只停止覆盖并不能让视觉状态复位。
  const coreModel = getCoreModel(runtime);
  for (const [paramId] of previous) {
    if (!next.has(paramId)) {
      const defaultValue = getParameterDefaultById(coreModel, paramId);
      const fallbackValue = runtime.baselineParams.get(paramId);
      const resetValue = typeof defaultValue === 'number' ? defaultValue : fallbackValue;
      if (typeof resetValue === 'number') {
        writeFiniteParam(coreModel, paramId, resetValue);
        console.info('[profile] reset costume param to default', { paramId, value: resetValue, source: typeof defaultValue === 'number' ? 'cubism' : 'baseline' });
      } else {
        console.warn('[profile] unable to reset costume param, no default/baseline', { paramId });
      }
    }
  }

  runtime.profileCostumeParamOverrides = next;
}

function mixOverwrite(base: number, target: number, weight: number) {
  return base + (target - base) * weight;
}

function mixMultiply(base: number, value: number, weight: number) {
  const factor = 1 + (value - 1) * weight;
  return base * factor;
}

async function resolveBinding(
  runtime: RuntimeState,
  binding: ExpressionBinding,
): Promise<ResolvedBinding> {
  if (binding.mode === 'preset') {
    return {
      mode: 'preset',
      params: binding.params,
    };
  }

  const cached = runtime.resolvedBindingCache.get(binding.file);
  if (cached) {
    return cached;
  }

  const payload = await fetchJson<ExpressionFilePayload>(binding.file);
  const resolved: ResolvedBinding = {
    mode: 'file',
    params: (payload.Parameters ?? [])
      .filter((parameter) => parameter.Id && typeof parameter.Value === 'number')
      .map((parameter) => ({
        id: parameter.Id!,
        value: parameter.Value!,
        blend: normalizeBlend(parameter.Blend),
      })),
  };

  runtime.resolvedBindingCache.set(binding.file, resolved);
  return resolved;
}

async function mergeBindingIntoParameters(
  runtime: RuntimeState,
  nextParams: Map<string, number>,
  binding: ExpressionBinding,
  weight: number,
) {
  const resolved = await resolveBinding(runtime, binding);
  const normalizedWeight = clampLayerWeight(weight);

  if (resolved.mode === 'preset') {
    for (const [paramId, value] of Object.entries(resolved.params)) {
      ensureTrackedBaseline(runtime, paramId);
      const baseline = runtime.baselineParams.get(paramId) ?? 0;
      const current = nextParams.get(paramId) ?? baseline;
      nextParams.set(paramId, mixOverwrite(current, value, normalizedWeight));
    }
    return;
  }

  for (const param of resolved.params) {
    ensureTrackedBaseline(runtime, param.id);
    const baseline = runtime.baselineParams.get(param.id) ?? 0;
    const current = nextParams.get(param.id) ?? baseline;

    if (param.blend === 'Overwrite') {
      nextParams.set(param.id, mixOverwrite(current, param.value, normalizedWeight));
    } else if (param.blend === 'Multiply') {
      nextParams.set(param.id, mixMultiply(current, param.value, normalizedWeight));
    } else {
      nextParams.set(param.id, current + param.value * normalizedWeight);
    }
  }
}

async function buildMixedParameters(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  expressionMix: ExpressionLayer[],
  parameterOverrides: ParameterOverride[],
  watermarkVisible: boolean,
) {
  const nextParams = new Map<string, number>();
  const expressionMap = new Map<string, AvatarExpression>(
    avatar.expressions.map((expressionItem) => [expressionItem.id, expressionItem]),
  );

  for (const layer of expressionMix) {
    const expressionItem = expressionMap.get(layer.key);
    if (!expressionItem) {
      continue;
    }

    await mergeBindingIntoParameters(runtime, nextParams, expressionItem.binding, layer.weight);
  }

  if (watermarkVisible && avatar.watermark) {
    for (const binding of avatar.watermark.bindings) {
      await mergeBindingIntoParameters(runtime, nextParams, binding, 1);
    }
  }

  for (const parameterOverride of parameterOverrides) {
    ensureTrackedBaseline(runtime, parameterOverride.id);
    nextParams.set(parameterOverride.id, parameterOverride.value);
  }

  return nextParams;
}

export type ModelLayoutInput = {
  width: number;
  rawHeight: number;
  modelBaseWidth: number;
  modelBaseHeight: number;
  scaleMultiplier: number;
  verticalOffset: number;
  modelTransform: { scale: number; offsetX: number; offsetY: number };
  transform: { scale: number; offsetX: number; offsetY: number };
  // 顶部钳制下限(×rawHeight)，默认 -0.2。桌宠全身放宽到负很多以允许角色上移撑满窗口。
  topClampMin?: number;
  // 按真实窗口高度适配(跳过虚拟竖屏)。默认关。桌宠全身开它=任何比例都露完整脚。
  fitWindowHeight?: boolean;
  // 视口包含钳制：模型主体始终留在画面内（极端 scale/offset 也不推出）。仅页面绝对构图开启。
  containment?: boolean;
};

export type ModelLayout = {
  totalScale: number;
  modelX: number;
  modelY: number;
  modelPixelWidth: number;
  modelPixelHeight: number;
};

// 方屏自适应：参考宽高比（标准竖屏 9:16）。
// layoutHeight = max(rawHeight, width / REFERENCE_ASPECT)：
// 竖屏帧 rawHeight >= width/REFERENCE_ASPECT，layoutHeight == rawHeight → 零回归；
// 方屏/宽屏帧 rawHeight < width/REFERENCE_ASPECT，layoutHeight 拉伸到等效 9:16 高度，
// 令 baseScale/modelY 按"虚拟竖屏"计算，头部保持在框内，仅腿部裁切。
export const REFERENCE_ASPECT = 9 / 16;

// 视口包含钳制的 scale 上限系数：绝对构图允许模型放大到视口适配的 SCALE_CAP 倍
// （后台推荐 0.6~0.8 的全身/半身构图约 1~1.3 倍，特写构图允许到 4 倍；更极端的值仍夹回防呆，
//  且顶部钳制保证头部不飞出画面）。
const CONTAINMENT_SCALE_CAP = 4;

// 水平钳制的出血余量：允许包围盒左右各出屏最多 BLEED_FRAC×屏宽。
// Live2D 画布通常接近方形（含发丝摆动余量/两侧留白），竖屏高度适配后画布宽≈屏宽，
// 若按包围盒硬钳，可见身体的 offsetX 行程会被压到接近 0（双马尾模型尤其明显）；
// 出血后 offsetX 才有实际行程，同时仍保证包围盒大部分留在屏内（防误填把角色彻底推出画面）。
const CONTAINMENT_BLEED_X_FRAC = 0.25;

export function computeModelLayout(input: ModelLayoutInput): ModelLayout {
  const { width, modelBaseWidth, modelBaseHeight, scaleMultiplier, verticalOffset, modelTransform, transform } = input;
  const layoutHeight = input.fitWindowHeight ? input.rawHeight : Math.max(input.rawHeight, width / REFERENCE_ASPECT);

  const baseScale = Math.min(width / modelBaseWidth, layoutHeight / modelBaseHeight);
  let totalScale = baseScale * scaleMultiplier * modelTransform.scale * transform.scale;

  let modelX = width * (0.5 + modelTransform.offsetX + transform.offsetX);
  let modelY = layoutHeight * (1 - verticalOffset + modelTransform.offsetY + transform.offsetY);

  let modelPixelWidth = modelBaseWidth * totalScale;
  let modelPixelHeight = modelBaseHeight * totalScale;

  if (input.containment) {
    // ① 极端 scale：夹到不超过视口适配的 SCALE_CAP 倍（正常构图不受影响，极端值收回）。
    const fitScale = Math.min(width / modelBaseWidth, layoutHeight / modelBaseHeight);
    const maxTotalScale = fitScale * CONTAINMENT_SCALE_CAP;
    if (totalScale > maxTotalScale) {
      totalScale = maxTotalScale;
      modelPixelWidth = modelBaseWidth * totalScale;
      modelPixelHeight = modelBaseHeight * totalScale;
    }
    // ② 水平包含：模型左右主体不出视口（宽于视口+出血余量则居中，两侧裁切）。
    const bleedX = width * CONTAINMENT_BLEED_X_FRAC;
    if (modelPixelWidth <= width + 2 * bleedX) {
      modelX = Math.min(Math.max(modelX, modelPixelWidth / 2 - bleedX), width - modelPixelWidth / 2 + bleedX);
    } else {
      modelX = width / 2;
    }
    // ③ 竖直包含：模型能整身放入视口时整体保留在视口内（防极端 offsetY 把角色推出画面）。
    if (modelPixelHeight <= input.rawHeight) {
      modelY = Math.min(Math.max(modelY, modelPixelHeight), input.rawHeight);
    }
  }

  // 安全兜底：把模型顶部夹到 [-0.2h, 0.55h]，使用真实 rawHeight，避免方屏下因 layoutHeight 虚高放松夹紧范围。
  const top = modelY - modelPixelHeight;
  const clampedTop = Math.min(Math.max(top, (input.topClampMin ?? -0.2) * input.rawHeight), 0.55 * input.rawHeight);
  if (clampedTop !== top) modelY = clampedTop + modelPixelHeight;

  return { totalScale, modelX, modelY, modelPixelWidth, modelPixelHeight };
}

export type AutoFitInput = {
  width: number; rawHeight: number;
  modelBaseWidth: number; modelBaseHeight: number;
  scaleMultiplier: number; verticalOffset: number;
  modelTransform: { scale: number; offsetX: number; offsetY: number };
  headAnchorY: number; headSizeNorm: number;
  target: { headScreenY: number; faceScreenFrac: number; fitWindowHeight?: boolean };
};

// 头部锚点自适应：算出施加到 computeModelLayout 的 stage transform。大小与位置分用不同基准：
//  ① 大小：脸高(px) = faceScreenFrac × layoutHeight（按【画面比例】自适应——方屏 layoutHeight 被
//     虚拟竖屏拉高→角色更大，竖屏 layoutHeight==rawHeight 不变。DPI/分辨率已折进 CSS px，无需另算）。
//  ② 位置：脸中心(px) = headScreenY × rawHeight（按【实际屏高】，方屏不会偏矮）。
// 不改 computeModelLayout；offsetY 反解里 modelY 系数是 layoutHeight，故除 layoutHeight。
// 竖屏 rawHeight==layoutHeight，与旧 calcMobileTransform 量级一致（零回归）。
export function computeAutoFit(input: AutoFitInput): { scale: number; offsetX: number; offsetY: number } {
  if (!(input.modelBaseWidth > 0) || !(input.modelBaseHeight > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const { width, rawHeight, modelBaseWidth, modelBaseHeight, scaleMultiplier, verticalOffset, modelTransform, headAnchorY, headSizeNorm, target } = input;
  // fitWindowHeight=true：用真实窗口高，不走虚拟竖屏放大（桌宠全身露完整脚，不裁腿）。
  const layoutHeight = target.fitWindowHeight ? rawHeight : Math.max(rawHeight, width / REFERENCE_ASPECT);
  const baseScale = Math.min(width / modelBaseWidth, layoutHeight / modelBaseHeight);
  const fixedScale = baseScale * scaleMultiplier * modelTransform.scale;

  // ① scale：脸高(模型单位)=modelBaseHeight*headSizeNorm；要求其 px = faceScreenFrac*layoutHeight（画面比例自适应）。
  const denom = modelBaseHeight * headSizeNorm * fixedScale;
  const scale = denom > 0 ? (target.faceScreenFrac * layoutHeight) / denom : 1;

  // ② offsetY：脸中心px = (modelY - modelPixelHeight) + headAnchorY*modelPixelHeight；要求 = headScreenY*rawHeight（实际屏）。
  const totalScale = fixedScale * scale;
  const modelPixelHeight = modelBaseHeight * totalScale;
  // modelY = layoutHeight*(1 - verticalOffset + modelTransform.offsetY + offsetY)
  // 令 faceCenterPx = headScreenY*rawHeight 反解 offsetY（modelY 系数是 layoutHeight，故除 layoutHeight）：
  const desiredFaceCenter = target.headScreenY * rawHeight;
  const desiredModelY = desiredFaceCenter + modelPixelHeight * (1 - headAnchorY);
  const offsetY = desiredModelY / layoutHeight - (1 - verticalOffset + modelTransform.offsetY);

  return { scale, offsetX: 0, offsetY };
}

function fitModel(runtime: RuntimeState, container: HTMLElement, transform?: StageTransform) {
  const { model, avatar, app } = runtime;
  const width = container.clientWidth || 800;
  const rawHeight = container.clientHeight || 800;
  const nextTransform = transform ?? runtime.currentTransform;

  app.renderer.resize(width, rawHeight);

  // 绝对构图（后台 home/login/dj 页面配置的 loginFraming/homeFraming/djFraming）：
  // 直接把 framing 当绝对 transform 施加（scale 相对模型基准、offset 相对布局高度），
  // 不再叠加 auto-fit 基准；走视口包含钳制，保证极端值也不把模型推出画面。
  if (nextTransform.absolute === true) {
    const layout = computeModelLayout({
      width,
      rawHeight,
      modelBaseWidth: runtime.modelBaseWidth,
      modelBaseHeight: runtime.modelBaseHeight,
      scaleMultiplier: avatar.scaleMultiplier,
      verticalOffset: avatar.verticalOffset,
      modelTransform: avatar.modelTransform,
      transform: { scale: nextTransform.scale, offsetX: nextTransform.offsetX, offsetY: nextTransform.offsetY },
      containment: true,
    });

    model.scale.set(layout.totalScale);
    model.anchor.set(0.5, 1);
    model.x = layout.modelX;
    model.y = layout.modelY;

    runtime.currentTransform = nextTransform;
    runtime.currentBounds = {
      top: layout.modelY - layout.modelPixelHeight,
      bottom: layout.modelY,
      left: layout.modelX - layout.modelPixelWidth * 0.5,
      right: layout.modelX + layout.modelPixelWidth * 0.5,
      modelWidth: layout.modelPixelWidth,
      modelHeight: layout.modelPixelHeight,
    };
    return;
  }

  // 头部锚点自适应：先算出使脸大小+位置符合取景目标的基准 transform，
  // 再把 React 传入的 nextTransform 当作相对基准的增量叠加（scale 乘、offset 加）。
  const autoBase = computeAutoFit({
    width,
    rawHeight,
    modelBaseWidth: runtime.modelBaseWidth,
    modelBaseHeight: runtime.modelBaseHeight,
    scaleMultiplier: avatar.scaleMultiplier,
    verticalOffset: avatar.verticalOffset,
    modelTransform: avatar.modelTransform,
    headAnchorY: avatar.headAnchorY ?? 0.16,
    headSizeNorm: avatar.headSizeNorm ?? 0.18,
    target: runtime.framingTarget,
  });

  const effective: StageTransform = {
    scale: autoBase.scale * nextTransform.scale,
    offsetX: autoBase.offsetX + nextTransform.offsetX,
    offsetY: autoBase.offsetY + nextTransform.offsetY,
  };

  const layout = computeModelLayout({
    width,
    rawHeight,
    modelBaseWidth: runtime.modelBaseWidth,
    modelBaseHeight: runtime.modelBaseHeight,
    scaleMultiplier: avatar.scaleMultiplier,
    verticalOffset: avatar.verticalOffset,
    modelTransform: avatar.modelTransform,
    transform: effective,
    topClampMin: runtime.framingTarget.topClampMin,
    fitWindowHeight: runtime.framingTarget.fitWindowHeight,
  });

  model.scale.set(layout.totalScale);
  model.anchor.set(0.5, 1);
  model.x = layout.modelX;
  model.y = layout.modelY;

  runtime.currentTransform = nextTransform;

  runtime.currentBounds = {
    top: layout.modelY - layout.modelPixelHeight,
    bottom: layout.modelY,
    left: layout.modelX - layout.modelPixelWidth * 0.5,
    right: layout.modelX + layout.modelPixelWidth * 0.5,
    modelWidth: layout.modelPixelWidth,
    modelHeight: layout.modelPixelHeight,
  };
}

function getFocusController(runtime: RuntimeState) {
  return runtime.model.internalModel.focusController as FocusControllerLike;
}

// 只写入有限数值，杜绝 NaN/Infinity 污染模型参数（坏值会让 internalModel.update 里的物理计算抛错，进而掐死整个 ticker）。
function writeFiniteParam(coreModel: CubismCoreModel, paramId: string, value: number) {
  if (!Number.isFinite(value)) return;
  coreModel.setParameterValueById(paramId, value);
}

// 每帧覆盖逻辑（表情/参数平滑 + 口型同步）。必须保持「绝不抛错」语义：
// PixiJS ticker 的某个监听器一旦抛异常，主循环就不再排下一帧（@pixi/ticker 的 _tick：
// update() 抛错后 requestAnimationFrame 那行被跳过），模型会永久定住。调用方已用 try/catch
// 兜底，这里再做存在性 + 有限性守卫，双保险。
function runOverlayFrame(runtime: RuntimeState) {
  const coreModel = runtime.model?.internalModel?.coreModel as CubismCoreModel | undefined;
  if (!coreModel) return;

  if (runtime.trackedParamIds.size > 0) {
    for (const paramId of runtime.trackedParamIds) {
      const baseline = runtime.baselineParams.get(paramId) ?? 0;
      const hasExplicitTarget = runtime.overlayTargetParams.has(paramId);
      const target = runtime.overlayTargetParams.get(paramId) ?? baseline;
      const current = runtime.overlayCurrentParams.get(paramId) ?? baseline;
      const next = easeTowards(current, target, getOverlayFactor(paramId, hasExplicitTarget));
      if (!Number.isFinite(next)) continue;

      runtime.overlayCurrentParams.set(paramId, next);
      writeFiniteParam(coreModel, paramId, next);
    }
  }

  // 持久参数覆盖（如 DJ 换装 Param67=1）：每帧应用，独立于口型。
  if (runtime.costumeParamOverrides.size > 0) {
    for (const [paramId, value] of runtime.costumeParamOverrides) {
      writeFiniteParam(coreModel, paramId, value);
    }
  }

  // v2 profile 装扮参数覆盖：与 DJ costume 同机制，但独立维护 slot 映射；后应用可覆盖 DJ 同参数。
  if (runtime.profileCostumeParamOverrides.size > 0) {
    for (const [paramId, value] of runtime.profileCostumeParamOverrides) {
      writeFiniteParam(coreModel, paramId, value);
    }
  }

  // SoulLink 情绪层：costume 之后、口型之前。白名单已保证不含 costume/口型参数。
  if (runtime.soullinkEmotionParams.size > 0) {
    for (const [paramId, value] of runtime.soullinkEmotionParams) {
      writeFiniteParam(coreModel, paramId, value);
    }
  }

  // 口型同步优先级最高，写在表情/动作叠加之后，确保它最终生效（ALL-173）。
  if (runtime.mouthSyncOverrides.size > 0) {
    for (const [paramId, value] of runtime.mouthSyncOverrides) {
      writeFiniteParam(coreModel, paramId, value);
    }
  }
}

// pixi-live2d-display 动作优先级：NONE=0 / IDLE=1 / NORMAL=2 / FORCE=3。
const MOTION_PRIORITY_IDLE = 1;
const MOTION_PRIORITY_NORMAL = 2;

const IDLE_BEAT_FADE_S = 0.9; // 待机拍/idle 双向淡化时长（秒），盖过 motion3 偏短的作者标注，避免生硬切换。

// 取 avatar 第一个 idle* 动作组名作为待机循环源。无则 null（如 DJ 完整模型靠物理摆动）。
// export：原生路径复用（原生端的待机循环选同一组）。
export function findIdleMotionKey(avatar: AvatarManifest): string | null {
  if (!avatar.motions) return null;
  return Object.keys(avatar.motions).find((key) => /^idle/i.test(key)) ?? null;
}

type RawMotion = { setIsLoop?: (v: boolean) => void; setFadeInTime?: (s: number) => void; setFadeOutTime?: (s: number) => void };

type RawMotionManager = {
  groups?: { idle?: string };
  playing?: boolean;
  // 当前在播动作的优先级（IDLE=1/NORMAL=2/FORCE=3）。用于待机拍给聊天/情绪动作让位。
  currentPriority?: number;
  motionGroups?: Record<string, Array<RawMotion | null>>;
  loadMotion?: (group: string, index: number) => Promise<RawMotion | undefined>;
  stopAllMotions?: () => void;
};

// 启用自然待机：让待机动作「内部无限循环」。
// 背景：本模型实测无内置呼吸/眨眼可见效果（参数被帧末 loadParameters 还原），自然待机只能靠 idle 动作驱动；
// 而 pixi-live2d-display 0.4.0 的 CubismMotion.create() 不读 motion3.json 的 Loop 标志（_isLoop 恒 false），
// 动作播 8s 就结束、靠不可靠的「再触发」续播——在 autoUpdate:false 下其 IDLE 预约会 reserve 成功但 start 未执行
// → reservedIdleGroup 永不清空 → 后续待机全被挡 → 彻底定住。
// 解法：预载 idle 动作并手动 setIsLoop(true)，让它永不结束、平滑无缝循环，根本不依赖再触发。聊天/统一动作(NORMAL)
// 仍能抢占；播完由 ensureIdle 看门狗确定性地恢复待机。
async function setupIdle(runtime: RuntimeState): Promise<void> {
  const key = runtime.idleMotionKey;
  if (!key) return;
  const mm = runtime.model?.internalModel?.motionManager as RawMotionManager | undefined;
  if (!mm) return;
  try { if (mm.groups) mm.groups.idle = key; } catch { /* ignore */ }
  try {
    // 预载并设为内部循环（motionGroups 缓存同一实例，循环标志对后续每次起播持续有效）。
    const motion = await mm.loadMotion?.(key, 0);
    motion?.setIsLoop?.(true);
    motion?.setFadeInTime?.(IDLE_BEAT_FADE_S);
    motion?.setFadeOutTime?.(IDLE_BEAT_FADE_S);
  } catch { /* ignore */ }
  if (!mm.playing) {
    runtime.lastIdleRequestAt = performance.now();
    void runtime.model.motion(key, 0, MOTION_PRIORITY_IDLE);
  }
}

// 待机看门狗（每帧）：当前无任何动作在播时，确定性地（重启前先 stopAllMotions 清掉可能卡死的预约）补播循环待机。
// 有动作在播（待机循环 or 聊天 NORMAL）则不打断；聊天播完→playing 转 false→由本函数无缝恢复待机。
function ensureIdle(runtime: RuntimeState): void {
  const key = runtime.idleMotionKey;
  if (!key) return;
  const mm = runtime.model?.internalModel?.motionManager as RawMotionManager | undefined;
  if (!mm || mm.playing) return;
  const now = performance.now();
  if (now - runtime.lastIdleRequestAt < 600) return; // 节流：避开异步起播窗口，避免重复请求
  runtime.lastIdleRequestAt = now;
  try { mm.stopAllMotions?.(); } catch { /* ignore */ } // 清掉卡死的 reservedIdle/current，杜绝死锁
  const motion = mm.motionGroups?.[key]?.[0];
  motion?.setIsLoop?.(true); // 已缓存则直接设；未缓存则起播时按需加载（首轮不循环，下一轮看门狗补上）
  motion?.setFadeInTime?.(IDLE_BEAT_FADE_S);
  motion?.setFadeOutTime?.(IDLE_BEAT_FADE_S);
  void runtime.model.motion(key, 0, MOTION_PRIORITY_IDLE);
}

// —— 待机小动作（Idle Beats）——
// 基础待机（物理摆 / idle 循环）之上，每隔随机间隔插一个「小动作拍」，让待机不再单调。
// A. 有动作库的模型：从「安静」动作里随机播一个（NORMAL 优先级，播完由 ensureIdle 恢复循环）。
// B. 无动作库的模型：用 focusController 做程序化朝向拍（望向旁边/抬眼/歪头），focus 会带动头+眼+身，物理自然跟随。
const IDLE_BEAT_MIN_GAP_MS = 6000;
const IDLE_BEAT_MAX_GAP_MS = 14000;
const IDLE_BEAT_HOLD_MS = 2400; // 程序化拍：到达朝向后再停留一会儿（含 ramp 抵达时间）
const IDLE_BEAT_RECOVER_MAX_MS = 2600; // 程序化拍：收回中位的最长用时（兜底，避免卡相位）
const IDLE_BEAT_RECOVER_MS = 900; // 程序化拍：收回后再等的额外冷却
const IDLE_BEAT_DEFER_MS = 2000; // 让位（交互/高优动作）时的小退避
const IDLE_BEAT_INTERVAL_JITTER = 0.3; // 后台配置间隔的 ±随机抖动比例，避免机械等距
const IDLE_FOCUS_MOVE_MS = 1800;    // 程序化拍：转向到目标的用时（缓入缓出）。
const IDLE_FOCUS_RECOVER_MS = 1600; // 程序化拍：收回中位的用时（缓入缓出）。

// 程序化小动作池：focus 归一化目标 [-1,1]，驱动「头+眼+身」自然转向。
const PROCEDURAL_IDLE_BEATS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0.5, y: 0.05 }, // 望向右
  { x: -0.5, y: 0.05 }, // 望向左
  { x: 0.12, y: -0.42 }, // 抬眼（思考/出神）
  { x: 0.34, y: 0.3 }, // 瞥向右下
  { x: -0.36, y: -0.28 }, // 歪头斜望（对角带头部倾斜）
];

// 适合待机随机播的「安静」动作名（排除跳舞/欢呼/飞吻/惊讶等明显情绪化动作）。
// swing 是真机实测「不倒翁式左右摇摆」的来源（ALL 待机摇摆事故），不属于安静动作。
const IDLE_SAFE_MOTION_ALLOW = [
  'idle2', 'look_around', 'stretch', 'sleepy', 'think',
  'nod', 'ear_perk', 'giggle', 'cradle', 'shy',
];

function randomGap(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// 开始一段程序化朝向移动：记录起点（当前自管 focus 位置）、目标、起始时刻、用时。
// 之后每帧由 feedIdleFocus 按 smootherstep 插值推进。
function startIdleFocusMove(
  runtime: RuntimeState,
  targetX: number,
  targetY: number,
  durMs: number,
): void {
  runtime.idleFocusFromX = runtime.idleFocusX;
  runtime.idleFocusFromY = runtime.idleFocusY;
  runtime.idleFocusTargetX = targetX;
  runtime.idleFocusTargetY = targetY;
  runtime.idleMoveStartAt = performance.now();
  runtime.idleMoveDurMs = durMs;
}

// 程序化朝向：按 smootherstep 时间曲线将 focus 从 From 插值到 Target，再喂给 focusController。
// 返回是否已完成（t >= 1）。绝不抛错（ticker 语义）。
function feedIdleFocus(runtime: RuntimeState): boolean {
  const elapsed = performance.now() - runtime.idleMoveStartAt;
  const t = runtime.idleMoveDurMs > 0 ? Math.min(elapsed / runtime.idleMoveDurMs, 1) : 1;
  const s = smootherstep(t);
  runtime.idleFocusX = runtime.idleFocusFromX + (runtime.idleFocusTargetX - runtime.idleFocusFromX) * s;
  runtime.idleFocusY = runtime.idleFocusFromY + (runtime.idleFocusTargetY - runtime.idleFocusFromY) * s;
  try { getFocusController(runtime).focus(runtime.idleFocusX, runtime.idleFocusY); } catch { /* ignore */ }
  return t >= 1;
}

// 下一拍间隔：后台配了平均间隔 → 在其 ±抖动内随机；否则用内置默认区间。
function nextIdleBeatGap(runtime: RuntimeState): number {
  const sec = runtime.idleBeatIntervalSec;
  if (sec && sec > 0) {
    const center = sec * 1000;
    return randomGap(center * (1 - IDLE_BEAT_INTERVAL_JITTER), center * (1 + IDLE_BEAT_INTERVAL_JITTER));
  }
  return randomGap(IDLE_BEAT_MIN_GAP_MS, IDLE_BEAT_MAX_GAP_MS);
}

// 解析模型的待机轮播动作池：显式 idleBeats 优先，否则按白名单从 motions 推断（排除主 idle 循环本身）。
// 无 motions 的模型返回空数组 → 调度走程序化朝向拍。
// export：原生路径复用（原生端小动作拍从同一池子随机）。
export function resolveIdleBeatKeys(avatar: AvatarManifest): string[] {
  const motions = avatar.motions;
  if (!motions) return [];
  const available = new Set(Object.keys(motions));
  if (avatar.idleBeats && avatar.idleBeats.length > 0) {
    return avatar.idleBeats.filter((key) => available.has(key));
  }
  const primaryIdle = findIdleMotionKey(avatar);
  return IDLE_SAFE_MOTION_ALLOW.filter((key) => available.has(key) && key !== primaryIdle);
}

// 预载待机小动作拍的 Cubism motion 实例，并批量设置双向淡化时长。
// 只对有动作库的模型生效；程序化朝向拍不需要预载。绝不抛错（try/catch 兜底）。
async function setupIdleBeats(runtime: RuntimeState): Promise<void> {
  const keys = runtime.idleBeatKeys;
  if (keys.length === 0) return;
  const mm = runtime.model?.internalModel?.motionManager as RawMotionManager | undefined;
  if (!mm?.loadMotion) return;
  for (const key of keys) {
    try {
      const motion = await mm.loadMotion(key, 0);
      motion?.setFadeInTime?.(IDLE_BEAT_FADE_S);
      motion?.setFadeOutTime?.(IDLE_BEAT_FADE_S);
    } catch { /* ignore：单个预载失败不影响其余动作 */ }
  }
}

// 每帧调度待机拍。绝不抛错（沿用 ticker 语义），全程 try/catch 兜底。
function tickIdleBeat(runtime: RuntimeState): void {
  const now = performance.now();

  // 总开关关闭：不插任何小动作拍；若正处程序化拍中则缓慢收回中位再退出。
  if (!runtime.idleBeatEnabled) {
    if (runtime.idleBeatPhase !== 'idle') {
      // 只在刚进入收回时（目标尚不为中位）触发一次 startIdleFocusMove，之后每帧仅推进动画。
      if (runtime.idleFocusTargetX !== 0 || runtime.idleFocusTargetY !== 0) {
        startIdleFocusMove(runtime, 0, 0, IDLE_FOCUS_RECOVER_MS);
      }
      if (feedIdleFocus(runtime)) runtime.idleBeatPhase = 'idle';
    }
    return;
  }

  // 程序化拍：朝向保持中，到点转 recover。
  if (runtime.idleBeatPhase === 'hold') {
    feedIdleFocus(runtime); // smootherstep 插值抵达目标朝向
    if (now >= runtime.idleBeatHoldUntil) {
      runtime.idleBeatPhase = 'recover';
      startIdleFocusMove(runtime, 0, 0, IDLE_FOCUS_RECOVER_MS);
      runtime.idleBeatHoldUntil = now + IDLE_BEAT_RECOVER_MAX_MS;
    }
    return;
  }

  // 程序化拍：缓慢收回中位；到位或超时即结束，排下一拍。用户交互期间让指针 focus 接管（不喂）。
  if (runtime.idleBeatPhase === 'recover') {
    const settled = now < runtime.idleSuppressUntil ? true : feedIdleFocus(runtime);
    if (settled || now >= runtime.idleBeatHoldUntil) {
      runtime.idleBeatPhase = 'idle';
      runtime.idleBeatNextAt = now + nextIdleBeatGap(runtime) + IDLE_BEAT_RECOVER_MS;
    }
    return;
  }

  if (now < runtime.idleBeatNextAt) return;

  // 让位：近期有指针交互、或正在播更高优先级动作（聊天/情绪/统一动作）时，退避后再试。
  if (now < runtime.idleSuppressUntil) {
    runtime.idleBeatNextAt = now + IDLE_BEAT_DEFER_MS;
    return;
  }
  const mm = runtime.model?.internalModel?.motionManager as RawMotionManager | undefined;
  if (mm && typeof mm.currentPriority === 'number' && mm.currentPriority >= MOTION_PRIORITY_NORMAL) {
    runtime.idleBeatNextAt = now + IDLE_BEAT_DEFER_MS;
    return;
  }

  if (runtime.idleBeatKeys.length > 0) {
    // A. 有动作库：随机播一个安静动作（NORMAL 暂时盖过 idle 循环，播完由 ensureIdle 恢复）。
    const key = runtime.idleBeatKeys[Math.floor(Math.random() * runtime.idleBeatKeys.length)];
    try { void runtime.model.motion(key, 0, MOTION_PRIORITY_NORMAL); } catch { /* ignore */ }
    runtime.idleBeatNextAt = now + nextIdleBeatGap(runtime);
    return;
  }

  // B. 无动作库：用 smootherstep 缓动驱动朝向拍，消除起步抽搐。
  const beat = PROCEDURAL_IDLE_BEATS[Math.floor(Math.random() * PROCEDURAL_IDLE_BEATS.length)];
  startIdleFocusMove(runtime, beat.x, beat.y, IDLE_FOCUS_MOVE_MS);
  runtime.idleBeatPhase = 'hold';
  runtime.idleBeatHoldUntil = now + IDLE_BEAT_HOLD_MS;
}

// 把模型加载进给定 Pixi app（仅 addChild，不触碰 runtime 状态）。一个上下文只有这一个模型。
async function loadModelInstance(
  app: PIXI.Application,
  avatar: AvatarManifest,
): Promise<{ model: Live2DModel; modelBaseWidth: number; modelBaseHeight: number }> {
  const rawSettings = await fetchJson<Record<string, unknown>>(encodeURI(avatar.modelJson));
  const settings = createAugmentedSettings(rawSettings, avatar);
  const model = await Live2DModel.from(settings, {
    autoInteract: false,
    // 关闭内置 autoUpdate：默认它把模型 deltaTime 累加挂到全局 Ticker.shared 上，
    // 形成「渲染在 app.ticker、计时在 Ticker.shared」的双 ticker 依赖。我们改为在下方
    // 受 try/catch 守护的 app.ticker 回调里手动 model.update()，把全部逻辑收敛到单一 ticker，
    // 任一 ticker 死亡都不会让模型半冻结（参见 ALL「随机渲染冻结」修复）。
    autoUpdate: false,
    crossOrigin: '',
  });

  app.stage.addChild(model);
  model.scale.set(1);

  const localBounds = model.getLocalBounds();
  return {
    model,
    modelBaseWidth: Math.max(localBounds.width, 1),
    modelBaseHeight: Math.max(localBounds.height, 1),
  };
}

export async function createLive2DRuntime(
  container: HTMLElement,
  avatar: AvatarManifest,
): Promise<RuntimeState> {
  if (!window.Live2DCubismCore) {
    throw new Error('live2dcubismcore.min.js is not loaded.');
  }

  window.PIXI = PIXI;

  const lowEnd = isLowEndDevice();
  const app = new PIXI.Application({
    autoStart: true,
    resizeTo: container,
    backgroundAlpha: 0,
    // 低端弱 GPU（如 Mali-T720）关抗锯齿：省帧缓冲显存 + 大幅降低填充开销。
    antialias: !lowEnd,
    // 高 DPI 手机上按设备像素渲染避免模糊；低端设备锁 1x，砍帧缓冲与填充率（防换页卡顿）。
    resolution: lowEnd ? 1 : window.devicePixelRatio || 1,
    autoDensity: true,
  });

  // 极低端机（0.99GHz 单核）锁 18fps：重模型单帧 JS ~30-40ms，冲 30fps（33ms 预算）冲不到 →
  // 满负荷和 UI 抢线程 → 帧时间忽长忽短「卡爆」（抖动方差大才是主观卡的真凶，不是均值）。
  // 锁 18fps（55ms 预算）让单帧渲染完还有余量让出线程给 UI/GC → 稳定命中、方差小、观感稳。
  if (lowEnd) {
    app.ticker.maxFPS = 18;
  }

  // 兼容旧 WebView（<Chrome 86 无 Element.replaceChildren，如一加 8T 的 WebView 85）：
  // 清空容器后挂载 canvas，语义与 replaceChildren(canvas) 完全等价。
  const canvasEl = app.view as HTMLCanvasElement;
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(canvasEl);

  const { model, modelBaseWidth, modelBaseHeight } = await loadModelInstance(app, avatar);

  const runtime: RuntimeState = {
    model,
    activeParams: null,
    overlayCurrentParams: new Map(),
    overlayTargetParams: new Map(),
    baselineParams: new Map(),
    trackedParamIds: new Set(),
    app,
    avatar,
    modelBaseWidth,
    modelBaseHeight,
    currentTransform: avatar.transformDefaults,
    framingTarget: SURFACE_FRAMING.home,
    currentBounds: { top: 0, bottom: 0, left: 0, right: 0, modelWidth: 0, modelHeight: 0 },
    resolvedBindingCache: new Map(),
    expressionMix: [],
    parameterOverrides: [],
    watermarkVisible: avatar.watermark?.enabledByDefault ?? false,
    mouthSyncOverrides: new Map(),
    costumeParamOverrides: new Map(),
    soullinkEmotionParams: new Map<string, number>(),
    costumeMix: [],
    emotionMix: [],
    emotionResetTimer: null,
    lastTickAt: performance.now(),
    idleMotionKey: findIdleMotionKey(avatar),
    lastIdleRequestAt: 0,
    idleBeatEnabled: avatar.idleBeatsEnabled !== false,
    idleBeatIntervalSec: avatar.idleBeatIntervalSec ?? null,
    idleBeatKeys: resolveIdleBeatKeys(avatar),
    idleBeatPhase: 'idle',
    idleBeatNextAt: performance.now() + randomGap(IDLE_BEAT_MIN_GAP_MS, IDLE_BEAT_MAX_GAP_MS),
    idleBeatHoldUntil: 0,
    idleFocusX: 0,
    idleFocusY: 0,
    idleFocusTargetX: 0,
    idleFocusTargetY: 0,
    idleFocusFromX: 0,
    idleFocusFromY: 0,
    idleMoveStartAt: 0,
    idleMoveDurMs: IDLE_FOCUS_MOVE_MS,
    idleSuppressUntil: 0,
    dizzyStartAt: null,
    profileExpressionId: null,
    profileCostumeSlots: new Map<CostumeSlot, string>(),
    profileCostumeParamOverrides: new Map<string, number>(),
    profileMotionFile: null,
    profileMotionInFlight: false,
    depthLayer: null,
    depthLoadToken: 0,
  };

  app.ticker.add(() => {
    runtime.lastTickAt = performance.now();
    // 绝不让一帧的异常掐死整个渲染循环。PixiJS ticker 的监听器抛错会导致
    // 主循环停止排下一帧 requestAnimationFrame，模型从此永久定住（画面还在、其余 UI 正常）。
    try {
      // 手动推进模型时间（autoUpdate 已关）。只累加 deltaTime/elapsedTime，
      // 真正的动作/物理计算仍在随后的 _render（LOW 优先级）里消费，时序与原先一致。
      // clamp 上限 80ms：偶发大 hitch（GC 暂停/切后台回来）会给出巨大 delta，直接喂给物理会瞬移/跳帧；
      // 限幅后最多按 80ms 推进，弱机上抖动观感明显更稳。正常帧 delta 远小于 80ms，不受影响。
      runtime.model.update(Math.min(app.ticker.deltaMS, 80));
      runOverlayFrame(runtime);
      tickDizzy(runtime); // 摇一摇「晕」演出：在 overlay 之后覆盖 focus/张嘴，物理带动头身晃
      ensureIdle(runtime); // 待机看门狗：无动作时无缝循环补播 idle（含卡死自恢复）
      tickIdleBeat(runtime); // 待机小动作：每隔随机间隔插一个安静动作/朝向拍，避免单调
    } catch (error) {
      console.error('[live2d] 覆盖帧出错，已跳过该帧：', error);
    }
  });

  installRenderWatchdog(runtime);

  fitModel(runtime, container);
  getFocusController(runtime).focus(0, 0, true);
  void setupIdle(runtime);
  void setupIdleBeats(runtime);

  return runtime;
}

// 看门狗 + 可见性 + WebGL 上下文恢复：哪怕渲染循环因为任何原因（某帧抛错、
// 上下文丢失后 PixiJS 重建了上下文但 ticker 已死、系统回收等）停掉，也能把它救活。
function installRenderWatchdog(runtime: RuntimeState) {
  const WATCHDOG_INTERVAL_MS = 1000;
  const STALE_THRESHOLD_MS = 1500;

  // ticker 抛错后 started 仍为 true 但不再排帧，单纯 start() 不会复活；必须 stop 再 start。
  const reviveTicker = (reason: string) => {
    const ticker = runtime.app?.ticker;
    if (!ticker) return;
    try {
      ticker.stop();
      ticker.start();
      runtime.lastTickAt = performance.now();
      console.warn(`[live2d] 渲染循环已复活（${reason}）`);
    } catch (error) {
      console.error('[live2d] 复活渲染循环失败：', error);
    }
  };

  const watchdogId = window.setInterval(() => {
    // 页面在后台时 rAF 本就被浏览器暂停，属正常，不算卡死。
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const stale = performance.now() - runtime.lastTickAt;
    if (stale > STALE_THRESHOLD_MS) {
      reviveTicker(`停滞 ${Math.round(stale)}ms`);
    }
  }, WATCHDOG_INTERVAL_MS);

  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      // 回前台：重置时间戳并补排一帧，避免看门狗误判，也让恢复即时生效。
      runtime.lastTickAt = performance.now();
      reviveTicker('回到前台');
    }
  };

  // PixiJS 自身已处理 webglcontextlost（preventDefault + 重建上下文）。这里只在
  // 上下文恢复后主动复活 ticker —— 否则若丢失那一帧已经把 ticker 抛死，PixiJS 重建
  // 的新上下文也没有循环去重绘。lost 只记录日志便于诊断。
  const canvas = runtime.app.view as HTMLCanvasElement;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    console.warn('[live2d] webglcontextlost：WebGL 上下文丢失，等待恢复');
  };
  const onContextRestored = () => {
    reviveTicker('webglcontextrestored');
  };

  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  runtime.disposeWatchers = () => {
    window.clearInterval(watchdogId);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
  };
}

export async function applyExpressionMix(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  expressionMix: ExpressionLayer[],
) {
  runtime.expressionMix = expressionMix;
  await applyRuntimeState(runtime, avatar);
}

export async function setWatermarkVisibility(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  watermarkVisible: boolean,
) {
  runtime.watermarkVisible = watermarkVisible;
  await applyRuntimeState(runtime, avatar);
}

export async function setParameterOverrides(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  parameterOverrides: ParameterOverride[],
) {
  runtime.parameterOverrides = parameterOverrides;
  await applyRuntimeState(runtime, avatar);
}

export function setMouthSyncOverrides(
  runtime: RuntimeState,
  overrides: ParameterOverride[],
) {
  runtime.mouthSyncOverrides = new Map(overrides.map((o) => [o.id, o.value]));
}

/** 设置持久参数覆盖（如 DJ 换装 Param67=1）。每帧应用，不被口型同步替换；传空数组清除。 */
export function setCostumeParamOverrides(
  runtime: RuntimeState,
  overrides: ParameterOverride[],
) {
  runtime.costumeParamOverrides = new Map(overrides.map((o) => [o.id, o.value]));
}

// ---- 统一动作播放（playAction）：costume/emotion 分层 + motion 分流 ----

// 情绪层默认保持时长，到点回落到「仅 costume」。LLM 步可按 durationMs 覆盖。
const DEFAULT_EMOTION_HOLD_MS = 3200;

function clearEmotionTimer(runtime: RuntimeState) {
  if (runtime.emotionResetTimer !== null) {
    clearTimeout(runtime.emotionResetTimer);
    runtime.emotionResetTimer = null;
  }
}

// 合并 costume(持久) + emotion(临时) 两层为一张 expressionMix 应用。
// 都为空时回落到 neutral，保证模型回到待机脸而不是「无表情指令」的不确定态。
async function applyLayeredExpression(runtime: RuntimeState, avatar: AvatarManifest) {
  const combined = [...runtime.costumeMix, ...runtime.emotionMix];
  const mix = combined.length > 0
    ? combined
    : [{ key: getAvatarNeutralExpressionId(avatar), weight: 1 }];
  await applyExpressionMix(runtime, avatar, mix);
}

function upsertLayer(layers: ExpressionLayer[], key: string, weight: number): ExpressionLayer[] {
  const next = layers.filter((layer) => layer.key !== key);
  next.push({ key, weight });
  return next;
}

/**
 * 统一动作入口：按 source 分流，对调用方屏蔽 motion/expression 差异。
 * - 清单外 id：回落到 neutral 待机，不抛错。
 * - source='motion'：一次性播放，由 motion 系统自行回到 idle，不动表情分层。
 * - source='expression' 且 kind='costume'：加入持久层，保留当前情绪（戴猫耳时变开心不丢猫耳）。
 * - source='expression' 其它(emotion 等)：替换临时情绪层，保留 costume，定时回落。
 */
export function playAction(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  actionId: string,
  options?: { emotionHoldMs?: number },
): void {
  const action: UnifiedAction | undefined = getAvatarAction(avatar, actionId);

  if (!action) {
    // 清单外：清掉临时情绪，回落到 costume（或 neutral）。不报错。
    clearEmotionTimer(runtime);
    runtime.emotionMix = [];
    void applyLayeredExpression(runtime, avatar);
    return;
  }

  if (action.source === 'motion') {
    void startMotion(runtime, avatar, action.ref);
    return;
  }

  if (action.kind === 'costume') {
    // 持久换装层：去重叠加，不触碰情绪层，也不设回落定时器。
    runtime.costumeMix = upsertLayer(runtime.costumeMix, action.ref, 1);
    void applyLayeredExpression(runtime, avatar);
    return;
  }

  // emotion（及其它表情类）：替换临时情绪层，保留 costume；到时回落。
  runtime.emotionMix = [{ key: action.ref, weight: 1 }];
  void applyLayeredExpression(runtime, avatar);

  clearEmotionTimer(runtime);
  const holdMs = options?.emotionHoldMs ?? DEFAULT_EMOTION_HOLD_MS;
  runtime.emotionResetTimer = setTimeout(() => {
    runtime.emotionResetTimer = null;
    runtime.emotionMix = [];
    void applyLayeredExpression(runtime, avatar);
  }, holdMs);
}

/** 移除某个持久换装层（用户明确要求脱下时调用）。不在清单/非 costume 则忽略。 */
export function removeCostume(runtime: RuntimeState, avatar: AvatarManifest, actionId: string): void {
  const action = getAvatarAction(avatar, actionId);
  const ref = action?.ref ?? actionId;
  const next = runtime.costumeMix.filter((layer) => layer.key !== ref);
  if (next.length === runtime.costumeMix.length) return;
  runtime.costumeMix = next;
  void applyLayeredExpression(runtime, avatar);
}

export function getRuntimeParameterSnapshot(runtime: RuntimeState) {
  const coreModel = getCoreModel(runtime);
  const table = getRuntimeParameterTable(coreModel);
  const parameters: DiscoveredLive2DParameter[] = [];
  const seen = new Set<string>();

  if (table?.ids) {
    const count = table.count ?? table.ids.length;
    for (let index = 0; index < count; index += 1) {
      const parameter = getParameterFromTable(runtime, table, index);
      if (!parameter || seen.has(parameter.id)) continue;
      seen.add(parameter.id);
      parameters.push(parameter);
    }
  }

  const methodCount = coreModel.getParameterCount?.();
  if (typeof methodCount === 'number' && Number.isFinite(methodCount)) {
    for (let index = 0; index < methodCount; index += 1) {
      const parameter = getParameterFromMethods(runtime, coreModel, index);
      if (!parameter || seen.has(parameter.id)) continue;
      seen.add(parameter.id);
      parameters.push(parameter);
    }
  }

  return parameters.sort((a, b) => a.id.localeCompare(b.id));
}

export function applyParameterCall(
  call: ParameterCall,
  parameterInfo?: DiscoveredLive2DParameter,
): ParameterCall {
  if (parameterInfo && call.avatarId !== parameterInfo.avatarId) {
    throw new Error(`角色不匹配：expected ${parameterInfo.avatarId}, got ${call.avatarId}`);
  }

  if (parameterInfo && call.id !== parameterInfo.id) {
    throw new Error(`参数不匹配：expected ${parameterInfo.id}, got ${call.id}`);
  }

  if (parameterInfo && !parameterInfo.callable) {
    throw new Error('该参数未在 runtime 参数表中确认');
  }

  let value = call.value;
  if (typeof parameterInfo?.min === 'number') {
    value = Math.max(parameterInfo.min, value);
  }
  if (typeof parameterInfo?.max === 'number') {
    value = Math.min(parameterInfo.max, value);
  }

  return { ...call, value };
}

async function applyRuntimeState(runtime: RuntimeState, avatar: AvatarManifest) {
  runtime.model.internalModel.motionManager.expressionManager?.resetExpression();

  if (
    runtime.expressionMix.length === 0
    && runtime.parameterOverrides.length === 0
    && !(runtime.watermarkVisible && avatar.watermark)
  ) {
    runtime.activeParams = null;
    runtime.overlayTargetParams = new Map();
    return;
  }

  const mixedParams = await buildMixedParameters(
    runtime,
    avatar,
    runtime.expressionMix,
    runtime.parameterOverrides,
    runtime.watermarkVisible,
  );

  if (mixedParams.size === 0) {
    runtime.activeParams = null;
    runtime.overlayTargetParams = new Map();
    return;
  }

  runtime.activeParams = mixedParams;
  runtime.overlayTargetParams = mixedParams;
}

// 从 URL 载入纹理，加载失败 reject（→ 上层回退 CSS 平面）。已缓存/合法时立即 resolve。
function loadTexture(url: string): Promise<PIXI.Texture> {
  return new Promise((resolve, reject) => {
    const tex = PIXI.Texture.from(url);
    if (tex.baseTexture.valid) {
      resolve(tex);
      return;
    }
    tex.baseTexture.once('loaded', () => resolve(tex));
    tex.baseTexture.once('error', () => reject(new Error(`depth-layer texture failed: ${url}`)));
    // m1：注册监听后再校验一次——防止在注册间隙纹理已就绪导致 Promise 永挂。
    if (tex.baseTexture.valid) {
      resolve(tex);
    }
  });
}

// 按当前舞台尺寸把背景/深度 Sprite cover 铺满并居中。resize 时复用。
function layoutDepthLayer(runtime: RuntimeState): void {
  const d = runtime.depthLayer;
  if (!d) return;
  const sw = runtime.app.screen.width;
  const sh = runtime.app.screen.height;
  for (const sprite of [d.bgSprite, d.depthSprite]) {
    const s = computeCoverScale(sprite.texture.width, sprite.texture.height, sw, sh, DEPTH_OVERSCAN);
    sprite.scale.set(s);
    sprite.position.set(sw / 2, sh / 2);
  }
}

/**
 * 在模型之下建景深层：背景 Sprite（挂 DisplacementFilter）+ 深度 Sprite（位移贴图，不可见）。
 * 建层前先拆旧层（换背景/换角色）。任一纹理加载失败返回 false 并保证已拆净，调用方回退 CSS 平面。
 */
export async function setDepthParallaxBackground(
  runtime: RuntimeState,
  opts: { backgroundTextureUrl: string; depthTextureUrl: string },
): Promise<boolean> {
  teardownDepthLayer(runtime);
  // I1：在 await 之前捕获当前代际 token，await 期间若被再次 teardown，token 会变。
  const token = runtime.depthLoadToken;

  let bgTexture: PIXI.Texture;
  let depthTexture: PIXI.Texture;
  try {
    [bgTexture, depthTexture] = await Promise.all([
      loadTexture(opts.backgroundTextureUrl),
      loadTexture(opts.depthTextureUrl),
    ]);
  } catch (error) {
    console.warn('[live2d] 景深层纹理加载失败，回退平面视差：', error);
    return false;
  }

  // I1：竞态保护——用代际 token 而非 depthLayer !== null 判断，正确处理「快速切背景」并发场景。
  if (runtime.depthLoadToken !== token) {
    bgTexture.destroy(true);
    depthTexture.destroy(true);
    return false;
  }

  const bgSprite = new PIXI.Sprite(bgTexture);
  bgSprite.anchor.set(0.5);

  const depthSprite = new PIXI.Sprite(depthTexture);
  depthSprite.anchor.set(0.5);
  depthSprite.renderable = false; // 仅作位移贴图，不直接绘制
  depthSprite.interactive = false; // m2：不吃指针事件

  const filter = new PIXI.filters.DisplacementFilter(depthSprite);
  filter.scale.x = 0;
  filter.scale.y = 0;
  bgSprite.filters = [filter];

  runtime.app.stage.addChildAt(bgSprite, 0); // 模型之下
  runtime.app.stage.addChild(depthSprite); // 必须在场景图中，滤镜每帧才取到其变换

  runtime.depthLayer = { bgSprite, depthSprite, filter, bgTexture, depthTexture };
  layoutDepthLayer(runtime);
  return true;
}

/** 命令式写位移强度（陀螺仪每帧调）。无层时 no-op。 */
export function setDepthParallaxScale(runtime: RuntimeState, sx: number, sy: number): void {
  const d = runtime.depthLayer;
  if (!d) return;
  d.filter.scale.x = sx;
  d.filter.scale.y = sy;
}

/** 拆景深层并释放纹理。无层时 no-op。换背景/换角色/销毁前调用。 */
export function teardownDepthLayer(runtime: RuntimeState): void {
  // I1：先递增代际 token，使所有在途的 setDepthParallaxBackground await 失效（即使当前无层也要递增）。
  runtime.depthLoadToken++;
  const d = runtime.depthLayer;
  if (!d) return;
  runtime.depthLayer = null;
  d.bgSprite.filters = null;
  // I2：显式从舞台移除，防止 destroy() 之前 Sprite 仍挂在 stage 上被下一帧渲染。
  runtime.app.stage.removeChild(d.bgSprite);
  runtime.app.stage.removeChild(d.depthSprite);
  d.bgSprite.destroy();
  d.depthSprite.destroy();
  d.filter.destroy();
  d.bgTexture.destroy(true);
  d.depthTexture.destroy(true);
}

export function resizeRuntime(runtime: RuntimeState, container: HTMLElement) {
  fitModel(runtime, container);
  layoutDepthLayer(runtime);
}

/** 切换取景目标（home/login/dj）。调用方随后触发一次 updateStageTransform/resizeRuntime 即生效。 */
export function setFramingTarget(runtime: RuntimeState, surface: SurfaceKey): void {
  runtime.framingTarget = SURFACE_FRAMING[surface];
}

/**
 * 覆盖 holo 全息屏构图（大小/竖向）。holo 是独立页面(holo.html 自己的运行时上下文)，
 * 改这里只影响本页——手机/DJ/屏保用各自的 surface，不受影响。
 * App 在 holo 初始化时按 URL(?scale=&head=)调用；下一次 fitModel 即生效。
 */
export function setHoloFraming(overrides: { headScreenY?: number; faceScreenFrac?: number }): void {
  if (typeof overrides.headScreenY === 'number') SURFACE_FRAMING.holo.headScreenY = overrides.headScreenY;
  if (typeof overrides.faceScreenFrac === 'number') SURFACE_FRAMING.holo.faceScreenFrac = overrides.faceScreenFrac;
}

/**
 * 覆盖掌机底条构图（大小/竖向）。语义与 setHoloFraming 同族：pet.html 是独立页面上下文，
 * 改这里只影响本页，主 App / DJ / 屏保各走各的 surface，不受影响。
 *
 * ★两条渲染路径都会自动吃到，不需要另铺参数：
 *   Pixi   —— runtime.framingTarget 持有的**就是** SURFACE_FRAMING.petStrip 这个对象引用
 *             （见 setFramingTarget），改字段即改运行时；
 *   原生   —— computeLayoutFractions 每次现取 SURFACE_FRAMING[surface]。
 * 改完必须触发一次 refit（Pixi 走 resizeRuntime / 原生走 applyNativeScreensaverLayout）才成像。
 *
 * ★只写这两个字段：topClampMin 是这条预设的命根子（240px 条里放开顶部钳制，
 * 否则位置滑块全程被夹死——7-29 那个「滑到两端都没反应」就是它），不能顺手覆盖掉。
 * ★挡 NaN：坏值一旦写进去，整条底条构图当场崩，且会被持久化到下次 F10。
 */
export function setPetStripFraming(overrides: { headScreenY?: number; faceScreenFrac?: number }): void {
  if (typeof overrides.headScreenY === 'number' && Number.isFinite(overrides.headScreenY)) {
    SURFACE_FRAMING.petStrip.headScreenY = overrides.headScreenY;
  }
  if (typeof overrides.faceScreenFrac === 'number' && Number.isFinite(overrides.faceScreenFrac)) {
    SURFACE_FRAMING.petStrip.faceScreenFrac = overrides.faceScreenFrac;
  }
}

export function updateStageTransform(
  runtime: RuntimeState,
  container: HTMLElement,
  transform: StageTransform,
) {
  fitModel(runtime, container, transform);
}

export function focusRuntime(runtime: RuntimeState, container: HTMLElement, clientX: number, clientY: number) {
  const rect = container.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  runtime.model.focus(x, y);
  yieldIdleToExternalFocus(runtime);
}

// 外部源（指针/陀螺仪）接管 focus 时：待机朝向拍让位（避免抢 focus），并结束当前程序化拍，
// 自管点归零，下一拍从中位平滑起步。
function yieldIdleToExternalFocus(runtime: RuntimeState) {
  runtime.idleSuppressUntil = performance.now() + 3000;
  if (runtime.idleBeatPhase !== 'idle') {
    runtime.idleBeatPhase = 'idle';
    runtime.idleBeatNextAt = performance.now() + randomGap(IDLE_BEAT_MIN_GAP_MS, IDLE_BEAT_MAX_GAP_MS);
    runtime.idleFocusX = 0;
    runtime.idleFocusY = 0;
    runtime.idleFocusTargetX = 0;
    runtime.idleFocusTargetY = 0;
    runtime.idleFocusFromX = 0;
    runtime.idleFocusFromY = 0;
    runtime.idleMoveStartAt = 0;
    runtime.idleMoveDurMs = IDLE_FOCUS_MOVE_MS;
  }
}

// 归一化朝向（陀螺仪）：focus 点已是 [-1,1] 空间，直接喂 focusController（与待机拍同一通道，
// 带动头+眼+身物理跟随），复用同一抢占逻辑让待机让位。
export function focusRuntimeNormalized(runtime: RuntimeState, nx: number, ny: number) {
  if (runtime.dizzyStartAt != null) return; // 晕摇演出中，陀螺仪跟随让位给晕摇
  try { getFocusController(runtime).focus(nx, ny); } catch { /* ignore */ }
  yieldIdleToExternalFocus(runtime);
}

// 触发一次「被摇晕」演出（摇一摇）。重复触发从头重放（覆盖旧的起点时刻）。
export function triggerDizzyRuntime(runtime: RuntimeState) {
  runtime.dizzyStartAt = performance.now();
}

// 每帧推进晕摇：算 focus 摆动喂 focusController（头+眼+身物理晃动）+ 张嘴，并压制待机拍。
// 越界（演出结束）时把张嘴收回 0 并清除起点。tick 在 runOverlayFrame 之后跑，覆盖其余通道。
function tickDizzy(runtime: RuntimeState) {
  if (runtime.dizzyStartAt == null) return;
  const frame = dizzyWobble(performance.now() - runtime.dizzyStartAt);
  if (!frame.active) {
    runtime.dizzyStartAt = null;
    writeFiniteParam(getCoreModel(runtime), 'ParamMouthOpenY', 0); // 收回张嘴
    return;
  }
  try { getFocusController(runtime).focus(frame.focusX, frame.focusY); } catch { /* ignore */ }
  writeFiniteParam(getCoreModel(runtime), 'ParamMouthOpenY', frame.mouthOpen);
  runtime.idleSuppressUntil = performance.now() + 500; // 让待机拍别来抢 focus
}

export async function startMotion(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  motionName: string,
): Promise<boolean> {
  if (!avatar.motions || !avatar.motions[motionName]) {
    return false;
  }

  return runtime.model.motion(motionName, 0, 2);
}

// ---- v2 profile 触发通道：追加导出，不改动 playAction 等已有语义 ----

/**
 * 订阅 profile motion 的结束事件。
 * 实现：通过 motionManager.queueManager.isFinished() 每帧轮询，检测到 motion 队列从「非空」变「空」
 * 且当前有 profile motion 在飞时，回调最近一次 startProfileMotion 的文件名。
 * 不依赖第三方库的 motionFinished 事件（该库未暴露），落到最简可用实现。
 */
export function subscribeMotionFinished(
  runtime: RuntimeState,
  cb: (motionId: string) => void,
): () => void {
  let wasFinished = true;

  const tick = () => {
    const motionManager = runtime.model?.internalModel?.motionManager as
      | (RawMotionManager & { queueManager?: { isFinished(): boolean } })
      | undefined;
    const queueManager = motionManager?.queueManager;
    const finished = !queueManager || queueManager.isFinished();

    if (!wasFinished && finished && runtime.profileMotionInFlight) {
      runtime.profileMotionInFlight = false;
      cb(runtime.profileMotionFile ?? '');
    }
    wasFinished = finished;
  };

  runtime.app.ticker.add(tick);
  return () => runtime.app.ticker.remove(tick);
}

/**
 * 把 profile 中的 .exp3 表情应用为当前表情层。
 * 内部复用 applyExpressionMix；生命周期（hold/clear）由外部调度器管理，引擎内部不设回落定时器。
 */
export async function applyProfileExpression(
  runtime: RuntimeState,
  expressionId: string,
): Promise<void> {
  const expression = findAvatarExpressionByProfileFile(runtime.avatar, expressionId);
  if (!expression) {
    console.warn(`[profile] expression not found: ${expressionId}`);
    return;
  }
  runtime.profileExpressionId = expressionId;
  await applyExpressionMix(runtime, runtime.avatar, [{ key: expression.id, weight: 1 }]);
}

/** 清除 profile 表情层，回到无表情态。 */
export async function clearProfileExpression(runtime: RuntimeState): Promise<void> {
  runtime.profileExpressionId = null;
  await applyExpressionMix(runtime, runtime.avatar, []);
}

/**
 * 把 costume 类 .exp3 应用为持久装扮层。
 * 同 slot 覆盖，不同 slot 并存；解析出的参数覆盖每帧直接写模型，不经过 expressionMix。
 */
export async function applyProfileCostume(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  expressionId: string,
  slot: CostumeSlot,
): Promise<void> {
  runtime.profileCostumeSlots.set(slot, expressionId);
  await recomputeProfileCostumeParams(runtime, avatar);
}

/** 按 slot 移除一件 profile 装扮。 */
export async function removeProfileCostume(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  slot: CostumeSlot,
): Promise<void> {
  const previousFiles = [...runtime.profileCostumeSlots.entries()].map(([s, f]) => `${s}:${f}`);
  const hadSlot = runtime.profileCostumeSlots.has(slot);
  runtime.profileCostumeSlots.delete(slot);
  await recomputeProfileCostumeParams(runtime, avatar);
  console.info('[profile] removeProfileCostume', { slot, hadSlot, previousSlots: previousFiles, remainingSlots: [...runtime.profileCostumeSlots.keys()] });
}

/**
 * 播放 profile motion。语义为 startMotion 的简单包装，
 * 同时记录文件名用于 subscribeMotionFinished 的结束回调。
 */
export async function startProfileMotion(
  runtime: RuntimeState,
  avatar: AvatarManifest,
  motionId: string,
): Promise<void> {
  // profile 里存的是文件名（如 'motions/dance.motion3.json' 或旧 'dance.motion3'），
  // 而 startMotion 需要模型 motion group 名（如 'dance'）。
  // 先提取 basename 再去掉 .motion3(.json) 后缀，然后按统一动作清单查一次；
  // 找不到对应 motion 时再按原样兜底尝试。
  const baseId = motionId
    .replace(/\.motion3(\.json)?$/i, '')
    .split('/')
    .pop()?.trim()
    .toLowerCase() ?? '';
  const action = baseId ? getAvatarAction(avatar, baseId) : undefined;
  const motionName = action?.source === 'motion' ? action.ref : motionId;
  const started = await startMotion(runtime, avatar, motionName);
  if (started) {
    runtime.profileMotionFile = motionId;
    runtime.profileMotionInFlight = true;
  }
}

export function resetRuntimeFocus(runtime: RuntimeState) {
  getFocusController(runtime).focus(0, 0);
}

export function destroyRuntime(runtime: RuntimeState) {
  clearEmotionTimer(runtime);
  // C1：景深层纹理用 texture:false 故意不自动释放，必须手动销毁防泄漏。
  teardownDepthLayer(runtime);
  runtime.disposeWatchers?.();
  runtime.disposeWatchers = undefined;
  // 取出 canvas 以便销毁后显式释放 WebGL 上下文。
  const canvas = runtime.app.view as HTMLCanvasElement | undefined;
  runtime.app.destroy(true, { children: true, texture: false, baseTexture: false });
  // PIXI 的 destroy 不会立即释放底层 WebGL 上下文（靠 GC），移动端多上下文（如通勤双舞台）
  // 会累积到浏览器上限后驱逐其它上下文 → 别的 Live2D 直接黑屏。这里显式 loseContext 即时回收。
  try {
    const gl =
      canvas?.getContext('webgl2') ||
      canvas?.getContext('webgl') ||
      (canvas?.getContext('experimental-webgl') as WebGLRenderingContext | null);
    (gl as WebGLRenderingContext | null)
      ?.getExtension('WEBGL_lose_context')
      ?.loseContext();
  } catch {
    /* 上下文已丢失/不可用：忽略 */
  }
}

// 供主页/DJ 编排每帧刷新 SoulLink 情绪层。传入的 Map 应已过情绪域白名单(见 soullinkBridge)。
export function setSoullinkEmotionParams(runtime: RuntimeState, params: Map<string, number>): void {
  runtime.soullinkEmotionParams = params;
}
