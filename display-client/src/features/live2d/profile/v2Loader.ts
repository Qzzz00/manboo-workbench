// v2/v3 Profile 加载器与启动期校验器。
// 不引入 zod / io-ts 等新依赖，手写轻量类型守卫。

import type {
  V2ExpressionCategory,
  V2ExpressionProfile,
  V2MotionProfile,
  V2Profile,
  V3CostumeMode,
  V3Emotion,
  V3Intensity,
  V3Kind,
} from './v2Types.ts';
import { V3_KIND_EXPRESSION, V3_KIND_MOTION } from './v2Types.ts';
import { COSTUME_SLOTS } from './types.ts';

const motionModules = import.meta.glob('../../../../model/profiles/*.motion.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<unknown>>;

const expressionModules = import.meta.glob('../../../../model/profiles/*.expression.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<unknown>>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertString(v: unknown, where: string): string {
  if (typeof v !== 'string') {
    throw new Error(`${where}: 须为字符串，得到 ${String(v)}`);
  }
  return v;
}

function assertBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`${where}: 须为布尔值，得到 ${String(v)}`);
  }
  return v;
}

function assertStringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: 须为字符串数组，得到 ${String(v)}`);
  }
  return v;
}

const EXPRESSION_CATEGORIES = new Set(['emotion', 'prop', 'costume']);

function assertExpressionCategory(v: unknown, where: string): V2ExpressionCategory {
  if (typeof v !== 'string' || !EXPRESSION_CATEGORIES.has(v)) {
    throw new Error(`${where}: 非法 expression category "${String(v)}"`);
  }
  return v as V2ExpressionCategory;
}

const VALID_V3_EMOTIONS = new Set<V3Emotion>([
  'happy',
  'angry',
  'sad',
  'shy',
  'surprised',
  'excited',
  'neutral',
]);

const VALID_V3_INTENSITIES = new Set<V3Intensity>(['light', 'medium', 'strong']);

const VALID_V3_COSTUME_MODES = new Set<V3CostumeMode>(['add', 'remove']);

function parseV3Kind(v: unknown, where: string, channel: 'motion' | 'expression'): V3Kind {
  if (v === undefined || v === null) {
    throw new Error(`${where}: kind 未提供`);
  }
  if (typeof v !== 'string') {
    throw new Error(`${where}: kind 须为字符串，得到 ${String(v)}`);
  }
  const whitelist = channel === 'motion' ? V3_KIND_MOTION : V3_KIND_EXPRESSION;
  if (!whitelist.includes(v as V3Kind)) {
    console.warn(`[v2 profile] 未知 kind "${v}"，降级为 pending`, { where, channel });
    return 'pending';
  }
  return v as V3Kind;
}

function parseV3Emotion(v: unknown, where: string): V3Emotion | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !VALID_V3_EMOTIONS.has(v as V3Emotion)) {
    throw new Error(`${where}: 非法 emotion "${String(v)}"`);
  }
  return v as V3Emotion;
}

function parseV3Intensity(v: unknown, where: string): V3Intensity | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !VALID_V3_INTENSITIES.has(v as V3Intensity)) {
    throw new Error(`${where}: 非法 intensity "${String(v)}"`);
  }
  return v as V3Intensity;
}

function parseV3CostumeMode(v: unknown, where: string): V3CostumeMode {
  if (v === undefined || v === null) return 'add';
  if (typeof v !== 'string' || !VALID_V3_COSTUME_MODES.has(v as V3CostumeMode)) {
    throw new Error(`${where}: 非法 costume mode "${String(v)}"`);
  }
  return v as V3CostumeMode;
}

/** motion 侧无 kind 时，统一推断为 emotion_motion（保持老 v2 行为）。 */
function inferMotionKind(): V3Kind {
  return 'emotion_motion';
}

/** expression 侧无 kind 时，按 category 推断。 */
function inferExpressionKind(category: V2ExpressionCategory): V3Kind {
  switch (category) {
    case 'emotion':
      return 'emotion_expr';
    case 'prop':
      return 'prop';
    case 'costume':
      return 'costume';
    default:
      return 'pending';
  }
}

function parseMotionItem(raw: unknown, where: string): V2MotionProfile['items'][number] {
  if (!isObject(raw)) {
    throw new Error(`${where}: 必须是对象`);
  }
  const item: V2MotionProfile['items'][number] = {
    id: assertString(raw.id, `${where}.id`),
    file: assertString(raw.file, `${where}.file`),
    group: assertString(raw.group, `${where}.group`),
    loop: assertBoolean(raw.loop, `${where}.loop`),
    hint: typeof raw.hint === 'string' ? raw.hint : '',
  };
  if (raw.keywords !== undefined) {
    item.keywords = assertStringArray(raw.keywords, `${where}.keywords`);
  }
  // v3 扩展字段
  const kind = raw.kind === undefined ? inferMotionKind() : parseV3Kind(raw.kind, `${where}.kind`, 'motion');
  item.kind = kind;
  if (raw.emotion !== undefined) {
    item.emotion = parseV3Emotion(raw.emotion, `${where}.emotion`);
  }
  if (raw.intensity !== undefined) {
    item.intensity = parseV3Intensity(raw.intensity, `${where}.intensity`);
  }
  return item;
}

const VALID_COSTUME_SLOTS = new Set(COSTUME_SLOTS);

function parseExpressionItem(raw: unknown, where: string): V2ExpressionProfile['items'][number] {
  if (!isObject(raw)) {
    throw new Error(`${where}: 必须是对象`);
  }
  const category = assertExpressionCategory(raw.category, `${where}.category`);
  const item: V2ExpressionProfile['items'][number] = {
    id: assertString(raw.id, `${where}.id`),
    file: assertString(raw.file, `${where}.file`),
    category,
    hint: typeof raw.hint === 'string' ? raw.hint : '',
  };
  if (raw.slot !== undefined) {
    item.slot = assertString(raw.slot, `${where}.slot`) as typeof item.slot;
  }
  if (raw.keywords !== undefined) {
    item.keywords = assertStringArray(raw.keywords, `${where}.keywords`);
  }
  // v3 扩展字段
  const kind = raw.kind === undefined ? inferExpressionKind(category) : parseV3Kind(raw.kind, `${where}.kind`, 'expression');
  item.kind = kind;
  if (raw.emotion !== undefined) {
    item.emotion = parseV3Emotion(raw.emotion, `${where}.emotion`);
  }
  if (raw.intensity !== undefined) {
    item.intensity = parseV3Intensity(raw.intensity, `${where}.intensity`);
  }
  if (category === 'costume' || raw.mode !== undefined) {
    item.mode = parseV3CostumeMode(raw.mode, `${where}.mode`);
  }
  if (raw.triggerEnabled !== undefined) {
    item.triggerEnabled = assertBoolean(raw.triggerEnabled, `${where}.triggerEnabled`);
  }
  if (raw.defaultWorn !== undefined) {
    item.defaultWorn = assertBoolean(raw.defaultWorn, `${where}.defaultWorn`);
  }
  return item;
}

function warnInvalidCostumeSlot(
  role: string,
  item: V2ExpressionProfile['items'][number],
  index: number,
): void {
  if (item.category !== 'costume') return;
  const slot = item.slot;
  if (slot === undefined || !VALID_COSTUME_SLOTS.has(slot)) {
    console.warn('[v2 profile] costume expression 缺少或包含非法 slot', {
      role,
      id: item.id,
      category: item.category,
      slot: slot ?? '(missing)',
      index,
    });
  }
}

function warnDisabledWithKeywords(
  role: string,
  item: V2MotionProfile['items'][number] | V2ExpressionProfile['items'][number],
  index: number,
  channel: 'motion' | 'expression',
): void {
  if (item.kind !== 'disabled') return;
  if (item.keywords && item.keywords.length > 0) {
    console.warn('[v2 profile] disabled 项不应挂 keywords', {
      role,
      channel,
      id: item.id,
      index,
    });
  }
}

function assertVersion(v: unknown, where: string): 'v2' | 'v3' {
  if (v !== 'v2' && v !== 'v3') {
    throw new Error(`${where}: version 必须是 "v2" 或 "v3"，得到 "${String(v)}"`);
  }
  return v;
}

export function parseMotionProfile(raw: unknown): V2MotionProfile {
  if (!isObject(raw)) {
    throw new Error('motion profile: 必须是对象');
  }
  if (raw.kind !== 'motion') {
    throw new Error(`motion profile: kind 必须是 "motion"，得到 "${String(raw.kind)}"`);
  }
  const version = assertVersion(raw.version, 'motion profile.version');
  if (!Array.isArray(raw.items)) {
    throw new Error('motion profile: items 必须是数组');
  }
  const role = assertString(raw.role, 'motion profile.role');
  const items = raw.items.map((entry, i) => parseMotionItem(entry, `motion profile.items[${i}]`));
  items.forEach((item, i) => warnDisabledWithKeywords(role, item, i, 'motion'));
  return {
    role,
    kind: 'motion',
    version,
    items,
  };
}

export function parseExpressionProfile(raw: unknown): V2ExpressionProfile {
  if (!isObject(raw)) {
    throw new Error('expression profile: 必须是对象');
  }
  if (raw.kind !== 'expression') {
    throw new Error(`expression profile: kind 必须是 "expression"，得到 "${String(raw.kind)}"`);
  }
  const version = assertVersion(raw.version, 'expression profile.version');
  if (!Array.isArray(raw.items)) {
    throw new Error('expression profile: items 必须是数组');
  }
  const role = assertString(raw.role, 'expression profile.role');
  const items = raw.items.map((entry, i) => parseExpressionItem(entry, `expression profile.items[${i}]`));
  items.forEach((item, i) => warnInvalidCostumeSlot(role, item, i));
  items.forEach((item, i) => warnDisabledWithKeywords(role, item, i, 'expression'));
  return {
    role,
    kind: 'expression',
    version,
    items,
  };
}

async function loadRaw(path: string): Promise<unknown> {
  const loader = motionModules[path] ?? expressionModules[path];
  if (!loader) return null;
  const raw = await loader();
  return typeof raw === 'string' ? raw : String(raw);
}

async function loadJson(path: string): Promise<unknown> {
  const raw = await loadRaw(path);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    console.warn(`[v2 profile] JSON 解析失败: ${path}`, error);
    return null;
  }
}

/**
 * 加载角色的 v2/v3 motion profile。
 * @param role 角色 ID，如 'shuangsheng'
 */
export async function loadV2MotionProfile(role: string): Promise<V2MotionProfile | null> {
  const raw = await loadJson(`../../../../model/profiles/${role}.motion.json`);
  if (!raw) return null;
  try {
    return parseMotionProfile(raw);
  } catch (error) {
    console.warn(`[v2 profile] ${role}.motion.json 校验失败:`, error);
    return null;
  }
}

/**
 * 加载角色的 v2/v3 expression profile。
 * @param role 角色 ID，如 'shuangsheng'
 */
export async function loadV2ExpressionProfile(role: string): Promise<V2ExpressionProfile | null> {
  const raw = await loadJson(`../../../../model/profiles/${role}.expression.json`);
  if (!raw) return null;
  try {
    return parseExpressionProfile(raw);
  } catch (error) {
    console.warn(`[v2 profile] ${role}.expression.json 校验失败:`, error);
    return null;
  }
}

/**
 * 加载角色的完整 v2/v3 profile（motion + expression）。
 * @param role 角色 ID，如 'shuangsheng'
 */
export async function loadV2Profile(role: string): Promise<V2Profile | null> {
  const [motion, expression] = await Promise.all([
    loadV2MotionProfile(role),
    loadV2ExpressionProfile(role),
  ]);
  if (!motion || !expression) return null;
  return { role, motion, expression };
}

/**
 * 启动期校验器：仅打日志，不阻塞启动。
 * 在浏览器环境通过 fetch HEAD 检查文件是否存在；在 Node/dev 控制台输出 warn。
 * @param profile v2/v3 profile
 * @param assetsRoot 资源根目录 URL（以 / 结尾），如 '/live2D/shuangsheng-dj/'
 */
export async function validateV2Profile(
  profile: V2Profile,
  assetsRoot: string,
): Promise<void> {
  // 覆盖包角色的 assetsRoot 在 _capacitor_file_ 数据目录下，而 profile 引用的表情/动作
  // 走的是继承清单（内置或包内重映射），按 assetsRoot 拼 URL 检查必然 404，纯噪音。
  if (assetsRoot.includes('_capacitor_file_')) return;
  const root = assetsRoot.endsWith('/') ? assetsRoot : `${assetsRoot}/`;
  const allItems = [
    ...profile.motion.items.map((item) => ({ ...item, channel: 'motion' as const })),
    ...profile.expression.items.map((item) => ({ ...item, channel: 'expression' as const })),
  ];

  for (const item of allItems) {
    const url = `${root}${item.file}`;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) {
        console.warn('[v2 profile] asset file missing', {
          role: profile.role,
          channel: item.channel,
          id: item.id,
          file: item.file,
          status: response.status,
        });
      }
    } catch (error) {
      console.warn('[v2 profile] asset file check failed', {
        role: profile.role,
        channel: item.channel,
        id: item.id,
        file: item.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!item.hint) {
      console.info('[v2 profile] item has empty hint', {
        role: profile.role,
        channel: item.channel,
        id: item.id,
      });
    }
  }
}
