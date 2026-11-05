/**
 * 这个包自己那一行:版本 + 构建于什么时候(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 源头是构建时写出来的 `public/build.json`(butler-app/scripts/write-build-stamp.mjs):
 * 随 Vite 原样进 `dist/`、随 `npx cap sync android` 进 APK 的 `assets/public/` ——
 * 所以在 App 里 `fetch('build.json')` 就能读到**这个包自己的**那一份。
 *
 * 那个文件本来是给**发版的人**看的(「这个包出自哪一份源码」,见 docs/交接-1003-手机包指纹.md);
 * 这一版给它加了 `version` / `version_code` 两格,于是手机自己也答得出「我是哪一版」——
 * 维护者 10-03 的原话:「包也没有版本号」。
 *
 * **读不到就缺席**:不编一个版本号,也不编一个构建时间。老包(10-03 之前打的)里
 * 压根没有 `version` 那一格,那一行就整行不出现 —— 比写一个假的强。
 */
import { useEffect, useState } from 'react';

/** APK 里那一份的路径(相对页面根,Capacitor 从 `assets/public/` 起服务)。 */
export const PHONE_BUILD_STAMP_URL = 'build.json';

export interface PhoneBuildStamp {
  /** 这棵子树在 HEAD 里的 tree id,40 位小写十六进制。给发版的人核对。 */
  butler_app_tree?: string;
  /** 构建那一刻,ISO 8601。 */
  built_at?: string;
  /** 构建时 butler-app 底下有没提交的改动。 */
  dirty?: boolean;
  /** 这个包是哪一版(与工作台同源)。 */
  version?: string;
  /** Android 的 versionCode。 */
  version_code?: number;
}

function hex40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

/**
 * 一格一格地认。**某一格坏了只丢那一格**:一个手改坏的 `built_at` 不该把版本号一起带走。
 * 整份不是对象就 undefined。
 */
export function parsePhoneBuildStamp(raw: unknown): PhoneBuildStamp | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const tree = hex40(v.butler_app_tree);
  const builtAt = typeof v.built_at === 'string' && !Number.isNaN(Date.parse(v.built_at)) ? v.built_at : undefined;
  const version = typeof v.version === 'string' && /^\d+\.\d+\.\d+$/.test(v.version.trim()) ? v.version : undefined;
  const code = typeof v.version_code === 'number' && Number.isInteger(v.version_code) ? v.version_code : undefined;
  return {
    ...(tree === undefined ? {} : { butler_app_tree: tree }),
    ...(builtAt === undefined ? {} : { built_at: builtAt }),
    ...(typeof v.dirty === 'boolean' ? { dirty: v.dirty } : {}),
    ...(version === undefined ? {} : { version }),
    ...(code === undefined ? {} : { version_code: code }),
  };
}

function two(n: number): string {
  return `${n}`.padStart(2, '0');
}

/**
 * 设置页顶上那一行。**没有版本号就整行缺席** —— 一行只写着「构建于 10-03」的字对她没用。
 * 时间按**本地时区**显示(她在哪儿看就是哪儿的钟点),不显示年份:这一行要短。
 */
export function buildStampLine(stamp: PhoneBuildStamp | undefined): string | undefined {
  const version = stamp?.version;
  if (version === undefined || version === '') return undefined;
  const dirtyNote = stamp?.dirty === true ? '(构建时有没提交的改动)' : '';
  if (stamp?.built_at === undefined) return `版本 ${version}${dirtyNote}`;
  const at = new Date(stamp.built_at);
  if (Number.isNaN(at.getTime())) return `版本 ${version}${dirtyNote}`;
  return `版本 ${version} · 构建于 ${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}${dirtyNote}`;
}

/**
 * 读一次。**失败一律 undefined、一句不吵**:它只是屏上一行字,
 * 读不到(浏览器里调试、老包里没这个文件)就不显示那一行。
 */
export async function loadPhoneBuildStamp(fetchImpl?: typeof fetch): Promise<PhoneBuildStamp | undefined> {
  const call = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (call === undefined) return undefined;
  try {
    const res = await call(PHONE_BUILD_STAMP_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    return parsePhoneBuildStamp(JSON.parse(await res.text()));
  } catch {
    return undefined;
  }
}

/** 整个 App 只读一次(它是个常量:这个包的构建指纹不会在运行时变)。 */
let cached: PhoneBuildStamp | undefined;
let inflight: Promise<PhoneBuildStamp | undefined> | undefined;

/** 测试用:把那一次读过的忘掉。 */
export function resetPhoneBuildStampCache(): void {
  cached = undefined;
  inflight = undefined;
}

/** 设置页那一行与「已更新到」那一句共用这一个。 */
export function usePhoneBuildStamp(fetchImpl?: typeof fetch): PhoneBuildStamp | undefined {
  const [stamp, setStamp] = useState<PhoneBuildStamp | undefined>(cached);
  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    inflight ??= loadPhoneBuildStamp(fetchImpl);
    void inflight.then((got) => {
      if (got !== undefined) cached = got;
      inflight = undefined;
      if (alive) setStamp(got);
    });
    return () => { alive = false; };
  }, [fetchImpl]);
  return stamp;
}
