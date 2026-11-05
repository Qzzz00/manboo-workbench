import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import type {
  AvatarManifest,
  AvatarParameterControl,
  AvatarResolver,
  ManifestLorebook,
  MotionBinding,
  RemoteAvatarConfig,
  RemoteAvatarManifest,
} from './types.ts';

export function publicAsset(assetPath: string) {
  return `${import.meta.env.BASE_URL}${assetPath.replace(/^\/+/, '')}`;
}

export function createModelTransform(scale = 1, offsetX = 0, offsetY = 0) {
  return {
    scale: scale * 8,
    offsetX,
    offsetY: offsetY + 1.3,
  };
}

export function parameterControl(
  id: string,
  label: string,
  prompt: string,
  min: number,
  max: number,
): AvatarParameterControl {
  return { id, label, prompt, min, max };
}

export function baseAvatar(
  avatar: Omit<AvatarManifest, 'expressions' | 'parameterControls' | 'transformDefaults'> & {
    expressions?: AvatarManifest['expressions'];
    parameterControls?: AvatarManifest['parameterControls'];
    transformDefaults?: AvatarManifest['transformDefaults'];
  },
): AvatarManifest {
  return {
    ...avatar,
    expressions: avatar.expressions ?? [],
    parameterControls: avatar.parameterControls ?? [],
    transformDefaults: avatar.transformDefaults ?? {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    },
  };
}

function isHtmlResponse(response: Response) {
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/html');
}

export async function assetExists(assetPath: string) {
  const safePath = encodeURI(assetPath);
  try {
    const response = await fetch(safePath, { method: 'HEAD' });
    if (response.ok && !isHtmlResponse(response)) return true;
  } catch {
    // Fall through to GET for hosts that do not support HEAD
  }

  try {
    const response = await fetch(safePath, { method: 'GET' });
    return response.ok && !isHtmlResponse(response);
  } catch {
    return false;
  }
}

// --- Avatar registry ---
//
// 仓库不带任何 Live2D 模型(2026-10-21 维护者定:模型文件全部出库,只留 butler-server 的上传入口),
// 所以内置表是空的。形象从两条路来:手机壳把 butler-server 上传过的递进展示台(`?feed=host`,display/hostFeed.ts),
// 或 Aiboo 账号下载(App.tsx 的 useRemoteAvatars 老路)。查不到就是没有 —— 调用方画粒子球,不去网上补。

export const avatarResolvers = new Map<string, AvatarResolver>();

export const avatars: Record<string, AvatarManifest> = {};

export const featuredAvatarIds: readonly string[] = [];

/**
 * 「这台机器上一个形象都没有」时给老页面(Aiboo 那几页、全息屏的对话钩子)垫的一份:没有模型地址,
 * 舞台见到它就不加载、画粒子球或留空。不进注册表,`getAvatarById` 查不到它。
 */
export const NO_AVATAR: AvatarManifest = baseAvatar({
  id: '',
  name: '事务官',
  summary: '',
  persona: { tone: '', traits: [], styleRules: [] },
  modelJson: '',
  scaleMultiplier: 1,
  verticalOffset: 0,
  modelTransform: createModelTransform(1, 0, 0),
});

// --- 远端覆盖与离线兜底 ---
//
// `avatars` 始终是内置的 4 角色离线兜底，永不被改写。远端 manifest 通过
// `applyRemoteOverrides` 合并进 `remoteOverrides`，对外暴露的合并视图
// (`avatarList` / `getAvatarById`) = { ...内置, ...远端 }。这样断网或未调用
// 覆盖时，内置角色仍可展示与选择。

const remoteOverrides: Record<string, AvatarManifest> = {};

function buildAvatarList(registry: Record<string, AvatarManifest>): AvatarManifest[] {
  // 内部「模型专用」条目（listedInDrawer === false）不作为独立角色卡露出，但仍保留在注册表里供 getAvatarById 渲染取用。
  const listable = Object.values(registry).filter((a) => a.listedInDrawer !== false);
  const featured = featuredAvatarIds
    .filter((id) => registry[id] && registry[id].listedInDrawer !== false)
    .map((id) => registry[id]);
  const rest = listable.filter((a) => !featuredAvatarIds.includes(a.id));
  return [...featured, ...rest];
}

// 合并后的注册表与列表快照。`avatarList` 用 `let` 以保留 ES module live binding：
// 既不破坏 `import { avatarList }` 的数组 API，又能在覆盖后让消费者读到最新值。
let mergedAvatars: Record<string, AvatarManifest> = { ...avatars };
export let avatarList: AvatarManifest[] = buildAvatarList(mergedAvatars);

function recomputeRegistry() {
  mergedAvatars = { ...avatars, ...remoteOverrides };
  avatarList = buildAvatarList(mergedAvatars);
}

export function getAvatarById(avatarId: string): AvatarManifest | undefined {
  return mergedAvatars[avatarId];
}

/** 往内置表里登记形象并重算注册表(内置表默认空;用例拿它装 testAvatars.ts 那份假清单)。 */
export function registerBuiltinAvatars(list: Readonly<Record<string, AvatarManifest>>): void {
  Object.assign(avatars, list);
  recomputeRegistry();
  emitAvatarsChanged();
}

// --- 订阅（供 React 组件响应远端覆盖刷新） ---

const listeners = new Set<() => void>();

function subscribeAvatars(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitAvatarsChanged() {
  for (const listener of listeners) listener();
}

/** 响应式订阅合并后的角色列表，远端覆盖后自动重渲染。 */
export function useAvatarList() {
  return useSyncExternalStore(subscribeAvatars, () => avatarList, () => avatarList);
}

/** 响应式订阅单个角色（合并后）。 */
export function useAvatarById(avatarId: string) {
  return useSyncExternalStore(
    subscribeAvatars,
    () => mergedAvatars[avatarId],
    () => mergedAvatars[avatarId],
  );
}

// --- 远端 manifest -> AvatarManifest 映射 ---

// Directory.Data 的可加载基址（如 http://localhost/_capacitor_file_/data/user/0/<app>/files）。
// 远端角色资源都落在该目录下；渲染前必须把相对路径（avatars/<id>/v<n>/...）拼成此绝对 URL，
// 否则 convertFileSrc 拿到相对路径只会拼成 http://localhost/avatars/... 被当作内置 web 资源 → 404。
let dataDirSrc: string | null = null;

/** 解析并缓存 Directory.Data 基址。须在 applyRemoteOverrides 之前 await 一次。 */
export async function initLocalAvatarRoot(): Promise<void> {
  if (dataDirSrc !== null) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    // 取 avatars 目录的绝对 uri，再去掉末尾 /avatars 得到 Data 根。
    const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: 'avatars' });
    const rootUri = uri.replace(/\/avatars\/?$/, '');
    dataDirSrc = Capacitor.convertFileSrc(rootUri).replace(/\/+$/, '');
  } catch {
    // 非 Capacitor 环境（浏览器 / 测试）：标记已尝试，toLocalSrc 走回退分支。
    dataDirSrc = '';
  }
}

function toLocalSrc(localDir: string, relativePath: string) {
  const joined = `${localDir.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
  if (dataDirSrc) {
    // 已解析出 Data 根：拼成绝对的 _capacitor_file_ URL（中文不在此编码，引擎加载前统一 encodeURI）。
    return `${dataDirSrc}/${joined}`;
  }
  try {
    return Capacitor.convertFileSrc(joined);
  } catch {
    // 非 Capacitor 环境（浏览器 / 测试）下直接返回拼接路径
    return joined;
  }
}

function buildRemoteMotions(entry: RemoteAvatarManifest): Record<string, MotionBinding> | undefined {
  if (!entry.motions) return undefined;
  const motions: Record<string, MotionBinding> = {};
  for (const [key, value] of Object.entries(entry.motions)) {
    const file = typeof value === 'string' ? value : value.file;
    if (!file) continue;
    const group = typeof value === 'string' ? undefined : value.group;
    motions[key] = group ? { file: toLocalSrc(entry.localDir, file), group } : { file: toLocalSrc(entry.localDir, file) };
  }
  return motions;
}

/** 继承内置同名角色的动作库时把文件 URL 绝对化：相对路径（'./live2D/...'）在覆盖包
 *  modelJson 目录下解析会 404（覆盖包在 _capacitor_file_ 数据目录，不含 live2D 资产）。
 *  绝对化后指向 WebView 源（APK 内置资产），Pixi/原生两侧都按绝对 URL 加载。
 *  例外：覆盖包自带同名动作文件（按 basename 匹配包内 files 清单）时优先用包内版本——
 *  包内曲线是按其模型重调校的，混用内置曲线会出现待机抽搐。 */
function absolutizeInheritedMotions(
  motions: Record<string, MotionBinding> | undefined,
  entry?: RemoteAvatarManifest,
): Record<string, MotionBinding> | undefined {
  if (!motions) return undefined;
  const base = typeof window !== 'undefined' ? `${window.location.origin}/` : null;
  const packageByBasename = new Map<string, string>();
  for (const f of entry?.files ?? []) {
    if (f.endsWith('.motion3.json')) packageByBasename.set(f.split('/').pop()!, f);
  }
  const out: Record<string, MotionBinding> = {};
  for (const [key, value] of Object.entries(motions)) {
    const basename = value.file.split('/').pop();
    const packaged = basename ? packageByBasename.get(basename) : undefined;
    const file = packaged && entry
      ? toLocalSrc(entry.localDir, packaged)
      : base ? new URL(value.file, base).href : value.file;
    out[key] = { ...value, file };
  }
  return out;
}

// --- 轻量配置落盘缓存 ---
//
// 远端角色的 transform/persona 不进 zip manifest（indexEntryToManifest 不带 transform），
// 冷启动建注册表条目时只能吃硬编码兜底（scaleMultiplier 0.27 + createModelTransform 的
// 8×/1.3 模型变换）——重启后构图「回到没调的状态」，直到选中时的 silent sync 拉到新值。
// 这里把每次 applyRemoteConfig 的 cfg 落盘，remoteEntryToManifest 时先合缓存，
// 让重启后立即以上次同步的构图渲染；网络回来后再由 silent sync 刷新。
const AVATAR_CONFIG_CACHE_PREFIX = 'llm-live2d:avatar-config:';

function persistAvatarConfig(id: string, cfg: RemoteAvatarConfig): void {
  try {
    localStorage.setItem(AVATAR_CONFIG_CACHE_PREFIX + id, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function loadPersistedAvatarConfig(id: string): RemoteAvatarConfig | null {
  try {
    const raw = localStorage.getItem(AVATAR_CONFIG_CACHE_PREFIX + id);
    if (!raw) return null;
    // 存的就是 normalize 后的 RemoteAvatarConfig（camelCase），不能再过 normalizeAvatarConfig
    // （它吃的是服务端 snake_case 原始响应，再过一遍会丢 defaultBackground/portraitUrl 等字段）。
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as RemoteAvatarConfig)
      : null;
  } catch {
    return null;
  }
}

function remoteEntryToManifest(entry: RemoteAvatarManifest): AvatarManifest {
  const base: AvatarManifest | undefined = avatars[entry.id];
  const transform = entry.transform ?? {};

  const manifest = baseAvatar({
    id: entry.id,
    name: entry.name ?? base?.name ?? entry.id,
    summary: entry.summary ?? base?.summary ?? '',
    persona: {
      tone: entry.persona?.tone ?? base?.persona.tone ?? '',
      traits: entry.persona?.traits ?? base?.persona.traits ?? [],
      styleRules: entry.persona?.styleRules ?? base?.persona.styleRules ?? [],
    },
    // 远端角色一律使用本地解压后的 model3.json
    modelJson: toLocalSrc(entry.localDir, entry.model_entry),
    scaleMultiplier: transform.scaleMultiplier ?? base?.scaleMultiplier ?? 0.27,
    verticalOffset: transform.verticalOffset ?? base?.verticalOffset ?? 0.08,
    mobileScale: transform.mobileScale ?? base?.mobileScale,
    mobileDrawerScaleOffset: transform.mobileDrawerScaleOffset ?? base?.mobileDrawerScaleOffset,
    mobileDrawerTargetScale: transform.mobileDrawerTargetScale ?? base?.mobileDrawerTargetScale,
    mobileDrawerScaleMul: transform.mobileDrawerScaleMul ?? base?.mobileDrawerScaleMul,
    mobileDrawerOffsetX: transform.mobileDrawerOffsetX ?? base?.mobileDrawerOffsetX,
    mobileDrawerOffsetY: transform.mobileDrawerOffsetY ?? base?.mobileDrawerOffsetY,
    mobileInitialOffsetY: transform.mobileInitialOffsetY ?? base?.mobileInitialOffsetY,
    headAnchorY: transform.headAnchorY ?? base?.headAnchorY,
    headSizeNorm: transform.headSizeNorm ?? base?.headSizeNorm,
    // 每场景构图（后台配置）：远端下载角色同样应用登录页/主页/DJ页 三套绝对构图。
    loginFraming: transform.loginFraming ?? base?.loginFraming,
    homeFraming: transform.homeFraming ?? base?.homeFraming,
    djFraming: transform.djFraming ?? base?.djFraming,
    modelTransform: base?.modelTransform ?? createModelTransform(1, 0, 0),
    motions: buildRemoteMotions(entry) ?? absolutizeInheritedMotions(base?.motions, entry),
    // 覆盖包不带表情清单时继承内置同名角色的：exp3 按模型参数 id 驱动，同模型族兼容；
    // 不继承则 expressions=[]，v2 profile 的表情/换装触发全部查无此物（v3 覆盖包事故）。
    expressions: base?.expressions,
    transformDefaults: base?.transformDefaults,
    prompt_template: entry.prompt_template ?? base?.prompt_template,
    system_prompt: entry.system_prompt ?? base?.system_prompt,
    post_history_instructions: entry.post_history_instructions ?? base?.post_history_instructions,
    lorebook: entry.lorebook ?? base?.lorebook,
  });
  // 上次同步落盘的轻量配置（构图/人设）盖在硬编码兜底之上；服务端最新值由选中时的
  // silent sync 再刷新（见 applyRemoteConfig → persistAvatarConfig）。
  const cachedCfg = loadPersistedAvatarConfig(entry.id);
  return cachedCfg ? mergeRemoteConfig(manifest, cachedCfg) : manifest;
}

/**
 * 用远端 manifest 覆盖/追加同 id 角色。多次调用按 entry 增量合并，
 * 不影响内置离线兜底。会触发 `avatarList` 重算并通知所有订阅者。
 */
export function applyRemoteOverrides(remoteEntries: RemoteAvatarManifest[]): void {
  if (!Array.isArray(remoteEntries) || remoteEntries.length === 0) return;
  let changed = false;
  for (const entry of remoteEntries) {
    if (!entry?.id || !entry.model_entry || !entry.localDir) continue;
    remoteOverrides[entry.id] = remoteEntryToManifest(entry);
    changed = true;
  }
  if (!changed) return;
  recomputeRegistry();
  emitAvatarsChanged();
}

/** 清空远端覆盖，回到内置表（仓库不带模型，默认是空的；测试 / 登出时使用）。 */
export function clearRemoteOverrides(): void {
  if (Object.keys(remoteOverrides).length === 0) return;
  for (const id of Object.keys(remoteOverrides)) delete remoteOverrides[id];
  recomputeRegistry();
  emitAvatarsChanged();
}

// --- 轻量配置覆盖（仅 persona + transform，不下载模型） ---
//
// 与 applyRemoteOverrides 平行：那条路绑定「已下载模型」(需 localDir/model_entry)；
// 这条只更新人设与站位参数，模型 / 表情 / 动作 / 水印一律保留 base 不动。

/**
 * 把轻量远端配置（persona + transform）合并到一份现有 manifest 上。纯函数，
 * 便于在注册表覆盖与 App 当前选中角色两处复用，也便于单测。
 */
export function mergeRemoteConfig(base: AvatarManifest, cfg: RemoteAvatarConfig): AvatarManifest {
  const t = cfg.transform ?? {};
  return {
    ...base,
    name: cfg.name?.trim() || base.name,
    summary: cfg.summary?.trim() || base.summary,
    persona: {
      tone: cfg.persona?.tone ?? base.persona.tone,
      traits: cfg.persona?.traits ?? base.persona.traits,
      styleRules: cfg.persona?.styleRules ?? base.persona.styleRules,
    },
    scaleMultiplier: t.scaleMultiplier ?? base.scaleMultiplier,
    verticalOffset: t.verticalOffset ?? base.verticalOffset,
    mobileScale: t.mobileScale ?? base.mobileScale,
    mobileDrawerScaleOffset: t.mobileDrawerScaleOffset ?? base.mobileDrawerScaleOffset,
    mobileDrawerTargetScale: t.mobileDrawerTargetScale ?? base.mobileDrawerTargetScale,
    mobileDrawerScaleMul: t.mobileDrawerScaleMul ?? base.mobileDrawerScaleMul,
    mobileDrawerOffsetX: t.mobileDrawerOffsetX ?? base.mobileDrawerOffsetX,
    mobileDrawerOffsetY: t.mobileDrawerOffsetY ?? base.mobileDrawerOffsetY,
    mobileInitialOffsetY: t.mobileInitialOffsetY ?? base.mobileInitialOffsetY,
    headAnchorY: t.headAnchorY ?? base.headAnchorY,
    headSizeNorm: t.headSizeNorm ?? base.headSizeNorm,
    // 每场景构图（后台配置优先，缺省保留内置/上次值）。
    loginFraming: t.loginFraming ?? base.loginFraming,
    homeFraming: t.homeFraming ?? base.homeFraming,
    djFraming: t.djFraming ?? base.djFraming,
    // 模型自身变换（后台可配，缺省保留内置/上次值）——此前不合并导致后台改 modelTransform 无效（ALL-440 排查）。
    modelTransform: t.modelTransform ?? base.modelTransform,
    voice: cfg.voice ?? base.voice,
    defaultBackground: cfg.defaultBackground ?? base.defaultBackground,
    // 触达路由三件套（后台配置优先，缺省保留内置/上次值）。
    portraitUrl: cfg.portraitUrl ?? base.portraitUrl,
    ringtoneUrl: cfg.ringtoneUrl ?? base.ringtoneUrl,
    notifySoundUrl: cfg.notifySoundUrl ?? base.notifySoundUrl,
    // 待机动作增强（后台配置优先，缺省保留内置）。
    idleBeatsEnabled: cfg.idleEnhancement?.enabled ?? base.idleBeatsEnabled,
    idleBeatIntervalSec: cfg.idleEnhancement?.intervalSec ?? base.idleBeatIntervalSec,
    // 世界书 / prompt 模板（后台配置优先，缺省保留内置/已下载值）。
    lorebook: cfg.lorebook ?? base.lorebook,
    prompt_template: cfg.promptTemplate ?? base.prompt_template,
  };
}

/**
 * 用远端轻量配置覆盖某个已存在角色的 persona + transform（不下载模型）。
 * base 取当前合并视图（内置或已下载），写入 remoteOverrides 并通知订阅者。
 * 返回是否命中——未知 id（既非内置也未下载）返回 false，调用方据此静默忽略。
 */
export function applyRemoteConfig(id: string, cfg: RemoteAvatarConfig): boolean {
  const base = mergedAvatars[id];
  if (!base) return false;
  remoteOverrides[id] = mergeRemoteConfig(base, cfg);
  persistAvatarConfig(id, cfg);
  recomputeRegistry();
  emitAvatarsChanged();
  return true;
}

/**
 * 把对账拿到的最新世界书写回 manifest 注册表并触发订阅者刷新（世界书对账通道）。
 * 不改变 mergeRemoteConfig 的现有行为——这里直接构造覆盖，只替换 lorebook 字段。
 * `lorebook` 为 undefined 表示服务端世界书未启用/不再下发，清空 manifest 中的世界书。
 * 内容无变化时返回 false，避免无谓的订阅者刷新。
 */
export function applyLorebookConfig(id: string, lorebook: ManifestLorebook | undefined): boolean {
  const base = mergedAvatars[id];
  if (!base) return false;
  const current = base.lorebook ?? null;
  const next = lorebook ?? null;
  if (current === next || JSON.stringify(current) === JSON.stringify(next)) return false;
  remoteOverrides[id] = { ...base, lorebook };
  recomputeRegistry();
  emitAvatarsChanged();
  return true;
}
