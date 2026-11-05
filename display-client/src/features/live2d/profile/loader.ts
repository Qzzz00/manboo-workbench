// v1 Profile 加载器。
// 手写类型守卫，不引入 zod / io-ts 等新依赖。

import {
  COSTUME_SLOTS,
  type CostumeSlot,
  type ExpressionEntry,
  type Intensity,
  type MotionEntry,
  type RoleProfile,
} from './types';

const TRIGGER_KINDS = new Set(['idle', 'motion', 'expr', 'costume']);
const INTENSITIES = new Set(['light', 'strong']);
const SLOT_SET = new Set<string>(COSTUME_SLOTS);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${where}: 须为非空字符串`);
  }
  return v;
}

function assertDriver(v: unknown, where: string): 'v2' | undefined {
  if (v === undefined) return undefined;
  if (v === 'v2') return 'v2';
  throw new Error(`${where}: 必须是 "v2" 或未定义，得到 "${String(v)}"`);
}

function assertKind(v: unknown, where: string): string {
  if (typeof v !== 'string' || !TRIGGER_KINDS.has(v)) {
    throw new Error(`${where}: 非法 kind "${String(v)}"`);
  }
  return v;
}

function assertIntensity(v: unknown, where: string): Intensity {
  if (typeof v !== 'string' || !INTENSITIES.has(v)) {
    throw new Error(`${where}: intensity 必须是 "light" 或 "strong"，得到 "${String(v)}"`);
  }
  return v as Intensity;
}

function assertSlot(v: unknown, where: string): CostumeSlot {
  if (typeof v !== 'string' || !SLOT_SET.has(v)) {
    throw new Error(`${where}: 非法 costume slot "${String(v)}"`);
  }
  return v as CostumeSlot;
}

function parseMotionEntry(entry: unknown, where: string): MotionEntry {
  if (!isObject(entry)) {
    throw new Error(`${where}: motion entry 必须是对象`);
  }
  const file = assertString(entry.file, `${where}.file`);
  const kind = assertKind(entry.kind, `${where}.kind`);

  if (kind === 'idle') {
    return { file, kind };
  }

  if (kind === 'motion') {
    const intensity = assertIntensity(entry.intensity, `${where}.intensity`);
    return { file, kind, intensity };
  }

  throw new Error(`${where}: motion entry 不支持 kind "${kind}"`);
}

function parseExpressionEntry(entry: unknown, where: string): ExpressionEntry {
  if (!isObject(entry)) {
    throw new Error(`${where}: expression entry 必须是对象`);
  }
  const file = assertString(entry.file, `${where}.file`);
  const kind = assertKind(entry.kind, `${where}.kind`);

  if (kind === 'expr') {
    const intensity = assertIntensity(entry.intensity, `${where}.intensity`);
    return { file, kind, intensity };
  }

  if (kind === 'costume') {
    const slot = assertSlot(entry.slot, `${where}.slot`);
    return { file, kind, slot };
  }

  throw new Error(`${where}: expression entry 不支持 kind "${kind}"`);
}

function parseExcludedEntry(entry: unknown, where: string): { file: string; reason: string } {
  if (!isObject(entry)) {
    throw new Error(`${where}: excluded entry 必须是对象`);
  }
  return {
    file: assertString(entry.file, `${where}.file`),
    reason: assertString(entry.reason, `${where}.reason`),
  };
}

/**
 * 把未知对象解析为 RoleProfile。校验失败抛 Error，消息含路径。
 * @param raw 从 JSON 解析出的未知对象
 */
export function parseProfile(raw: unknown): RoleProfile {
  if (!isObject(raw)) {
    throw new Error('profile: 必须是对象');
  }

  const role = assertString(raw.role, 'role');

  if (raw.schemaVersion !== 'v1') {
    throw new Error(`schemaVersion: 必须是 "v1"，得到 "${String(raw.schemaVersion)}"`);
  }

  const driver = assertDriver(raw.driver, 'driver');

  if (!Array.isArray(raw.motions)) {
    throw new Error('motions: 必须是数组');
  }
  const motions = raw.motions.map((entry, i) => parseMotionEntry(entry, `motions[${i}]`));

  if (!Array.isArray(raw.expressions)) {
    throw new Error('expressions: 必须是数组');
  }
  const expressions = raw.expressions.map((entry, i) => parseExpressionEntry(entry, `expressions[${i}]`));

  const excluded = Array.isArray(raw.excluded)
    ? raw.excluded.map((entry, i) => parseExcludedEntry(entry, `excluded[${i}]`))
    : [];

  const profile: RoleProfile = {
    role,
    schemaVersion: 'v1',
    driver,
    motions,
    expressions,
    excluded,
  };

  if (raw.idleStrategy !== undefined) {
    if (raw.idleStrategy !== 'virtual_empty') {
      throw new Error(`idleStrategy: 必须是 "virtual_empty"，得到 "${String(raw.idleStrategy)}"`);
    }
    profile.idleStrategy = 'virtual_empty';
  }

  return profile;
}

/**
 * 从 JSON 字符串加载 RoleProfile。
 * @param json JSON 字符串
 */
export function loadProfileFromJson(json: string): RoleProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`JSON.parse 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProfile(raw);
}

const profileRawModules = import.meta.glob('../../../../model/profiles/*.v1.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<unknown>>;

/**
 * 按角色 ID 懒加载对应 profile JSON。
 * @param role 角色 ID，如 'shuangsheng'
 * @returns RoleProfile 或 null（文件不存在/校验失败）
 */
export async function loadProfileByRole(role: string): Promise<RoleProfile | null> {
  const modulePath = `../../../../model/profiles/${role}.v1.json`;
  const loader = profileRawModules[modulePath];
  if (!loader) return null;
  try {
    const raw = await loader();
    return loadProfileFromJson(typeof raw === 'string' ? raw : String(raw));
  } catch (error) {
    console.warn(`[profile] 加载 ${role}.v1.json 失败:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}
