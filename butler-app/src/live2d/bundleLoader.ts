/**
 * 把本机后端下发的形象包(bundle.zip)喂给 Aiboo 的 Live2D 引擎。
 *
 * 为什么不直接给引擎一个 URL:形象资源要经工作台代理、带设备令牌,而 pixi 的资源加载器
 * 自己发 XHR、带不上我们的 Authorization 头。所以:App 自己带令牌下载 zip → 内存解压 →
 * 每个文件一个 object URL → 把 model3.json 里的相对路径改写成这些 URL → 引擎照常 `fetchJson(modelJson)`,
 * pixi-live2d-display 对绝对 URL 直接用(url.resolve 遇到带 scheme 的路径不再拼目录)。引擎一个字不用改。
 */
import type { AvatarManifest, AvatarExpression, MotionBinding } from './types.ts';
import type { AvatarDetail, AvatarSummary } from '../api/voice';

type Json = Record<string, unknown>;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** 解出 `base/rel` 的规范路径(处理 ./ 与 ../)。 */
function joinPath(base: string, rel: string): string {
  const parts = (base + rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

export function rewriteModelSettings(settings: Json, modelEntry: string, files: ReadonlyMap<string, string>): Json {
  const base = dirOf(modelEntry);
  const map = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    return files.get(joinPath(base, value)) ?? value;
  };
  const refs = { ...((settings.FileReferences as Json | undefined) ?? {}) };
  for (const key of ['Moc', 'Physics', 'Pose', 'DisplayInfo', 'UserData']) {
    if (key in refs) refs[key] = map(refs[key]);
  }
  if (Array.isArray(refs.Textures)) refs.Textures = refs.Textures.map(map);
  if (Array.isArray(refs.Expressions)) {
    refs.Expressions = refs.Expressions.map((e) => (typeof e === 'object' && e !== null
      ? { ...(e as Json), File: map((e as Json).File) }
      : e));
  }
  if (typeof refs.Motions === 'object' && refs.Motions !== null) {
    const groups: Json = {};
    for (const [group, list] of Object.entries(refs.Motions as Json)) {
      groups[group] = Array.isArray(list)
        ? list.map((m) => (typeof m === 'object' && m !== null
          ? { ...(m as Json), File: map((m as Json).File), ...('Sound' in (m as Json) ? { Sound: map((m as Json).Sound) } : {}) }
          : m))
        : list;
    }
    refs.Motions = groups;
  }
  return { ...settings, FileReferences: refs };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function manifestFromBundle(input: {
  avatar: Pick<AvatarDetail, 'id' | 'name' | 'summary' | 'transform'>;
  settings: Json;
  settingsUrl: string;
}): AvatarManifest {
  const refs = (input.settings.FileReferences as Json | undefined) ?? {};
  const expressions: AvatarExpression[] = Array.isArray(refs.Expressions)
    ? refs.Expressions
      .filter((e): e is { Name: string; File: string } => typeof e === 'object' && e !== null
        && typeof (e as Json).Name === 'string' && typeof (e as Json).File === 'string')
      .map((e) => ({ id: e.Name, label: e.Name, kind: 'emotion', prompt: e.Name, binding: { mode: 'file', file: e.File } }))
    : [];
  let motions: Record<string, MotionBinding> | undefined;
  if (typeof refs.Motions === 'object' && refs.Motions !== null) {
    motions = {};
    for (const [group, list] of Object.entries(refs.Motions as Json)) {
      const first = Array.isArray(list) ? list[0] : undefined;
      const file = typeof first === 'object' && first !== null ? (first as Json).File : undefined;
      if (typeof file === 'string') motions[group] = { file };
    }
    if (Object.keys(motions).length === 0) motions = undefined;
  }
  const t = (input.avatar.transform ?? {}) as Json;
  const mt = (t.modelTransform ?? {}) as Json;
  return {
    id: input.avatar.id,
    name: input.avatar.name,
    summary: input.avatar.summary ?? '',
    persona: { tone: '', traits: [], styleRules: [] },
    modelJson: input.settingsUrl,
    scaleMultiplier: num(t.scaleMultiplier, 1),
    verticalOffset: num(t.verticalOffset, 0),
    ...(typeof t.headAnchorY === 'number' ? { headAnchorY: t.headAnchorY } : {}),
    ...(typeof t.headSizeNorm === 'number' ? { headSizeNorm: t.headSizeNorm } : {}),
    modelTransform: { scale: num(mt.scale, 1), offsetX: num(mt.offsetX, 0), offsetY: num(mt.offsetY, 0) },
    transformDefaults: { scale: 1, offsetX: 0, offsetY: 0 },
    expressions,
    ...(motions === undefined ? {} : { motions }),
  };
}

export function pickAvatar<T extends AvatarSummary>(avatars: readonly T[], remembered: string | null): T | undefined {
  if (remembered !== null) {
    const hit = avatars.find((a) => a.id === remembered);
    if (hit !== undefined) return hit;
  }
  return avatars[0];
}

export interface LoadedBundle {
  manifest: AvatarManifest;
  /** 释放全部 object URL。换形象或卸载时调。 */
  release(): void;
}

/** 解压 zip,建 object URL,凑出 manifest。model_entry 缺省时找包里第一个 *.model3.json。 */
export async function loadBundle(avatar: AvatarDetail, zip: Blob): Promise<LoadedBundle> {
  const { BlobReader, BlobWriter, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(zip));
  const entries = await reader.getEntries();
  const files = new Map<string, string>();
  const urls: string[] = [];
  let modelEntry = avatar.model_entry;
  let settingsText: string | undefined;
  for (const entry of entries) {
    if (entry.directory || entry.getData === undefined) continue;
    const name = entry.filename.replace(/^\.?\//, '');
    const blob = await entry.getData(new BlobWriter());
    if (modelEntry === undefined && /\.model3\.json$/i.test(name)) modelEntry = name;
    if (name === modelEntry) settingsText = await blob.text();
    const url = URL.createObjectURL(blob);
    files.set(name, url);
    urls.push(url);
  }
  await reader.close();
  if (modelEntry === undefined || settingsText === undefined) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw new Error('形象包里没有 model3.json');
  }
  const settings = rewriteModelSettings(JSON.parse(settingsText) as Json, modelEntry, files);
  const settingsUrl = URL.createObjectURL(new Blob([JSON.stringify(settings)], { type: 'application/json' }));
  urls.push(settingsUrl);
  return {
    manifest: manifestFromBundle({ avatar, settings, settingsUrl }),
    release() { for (const url of urls) URL.revokeObjectURL(url); },
  };
}
