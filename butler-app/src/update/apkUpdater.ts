/**
 * 在 App 里把新手机包下下来、装上(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 维护者原话:「手机端现在每次更新我都得跳转官网去下载」。跳官网那条路的毛病不是"多两步",
 * 是**中间有四处会断**:浏览器下完落在「下载」里、她得自己找到那个文件、系统再问一次
 * 「允不允许安装未知应用」、而官网上那份是不是电脑清单里那一份谁也不知道(校验码对不上也看不出来)。
 *
 * ## 为什么是一件原生插件
 *
 * 下载、算 sha256、调起系统安装器**三件都在原生**
 * (`android/app/src/main/java/ai/ben/butler/ApkUpdatePlugin.java`):
 *   · 一个 30MB 以上的 APK 在 WebView 里是一条 40MB 的 ArrayBuffer(再转 base64 过桥就是 54MB),
 *     `fileSink.ts` 为 40MB 的附件已经不得不改成 512KB 分块 —— 装一个包不该走那条路;
 *   · sha256 要在**落盘的那一条流上**算,算完才知道要不要装(算在网页侧等于把字节过两遍桥);
 *   · 调起系统安装器只有原生够得着(`FileProvider` + `ACTION_VIEW`,APK 23 以上也只有这一条)。
 *
 * ## 这一份(外壳)只做判断
 *
 * 没原生桥怎么说、**校验码对不上绝不往下走**、系统没给安装权限时单独一档(界面好给一颗
 * 去系统设置的键)、进度原样往上报、失败照实说原因。一句都不劝她去官网 ——
 * 官网那条链接降成了设置里的一行小字,不再是唯一的路。
 */
import { registerPlugin } from '@capacitor/core';
import {
  PHONE_UPDATE_NEED_PERMISSION_TEXT,
  PHONE_UPDATE_SHA_MISMATCH_TEXT,
  phoneUpdateFailText,
  shaOk,
  type PhoneApkOffer,
} from './phoneUpdate';

/** 原生那边报的「我是哪个包」。 */
export interface ApkUpdateNativeInfo {
  /** 这个 APK 的 `versionName`(构建时写的,见 android/app/build.gradle)。 */
  versionName?: string;
  versionCode?: number;
  /** 系统此刻允不允许这个 App 装包(`canRequestPackageInstalls`)。 */
  canInstall?: boolean;
}

export interface ApkUpdateProgress {
  received?: number;
  /** 服务器报的总字节数。报不出来就缺席(界面上那句话于是只说下了多少)。 */
  total?: number;
}

export interface ApkUpdateNative {
  info(): Promise<ApkUpdateNativeInfo>;
  /** 流式下到 App 自己的目录里,边下边算 sha256。对不上原生那边就**删掉文件**并 reject。 */
  download(options: { url: string; sha256: string; size: number }): Promise<{ path?: string; bytes?: number; sha256?: string }>;
  /** 调起系统安装器。没允许「安装未知应用」时 reject,code = {@link APK_UPDATE_NEED_PERMISSION_CODE}。 */
  install(options: { path: string }): Promise<void>;
  /** 把系统那一页「安装未知应用」打开(她允许完回来再按一次)。 */
  openInstallPermission(): Promise<void>;
  addListener(
    event: 'progress',
    handler: (data: ApkUpdateProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * 原生那边 reject 时带的 code:系统还不允许这个 App 装包。
 * **与 ApkUpdatePlugin.java 里那个常量逐字相同**(改一处要改两处)。
 */
export const APK_UPDATE_NEED_PERMISSION_CODE = 'NEED_INSTALL_PERMISSION';

/**
 * 这个包里压根没有原生那一条(浏览器里打开的,或者装的是 10-03 之前那几版手机包)。
 * **这一句里才出现官网** —— 它是真没有别的路的那一种情形。
 */
export const APK_UPDATE_NO_NATIVE_TEXT = '这个手机包里还没有「在 App 里更新」这一条(装的是 2026-10-03 之前那几版)。这一次还得去官网下一份,装上以后就能在 App 里直接更新了。';

/** `registerPlugin` 本身不抛;没实现是**调它的方法**才抛,所以每一次调用都包着(同 meeting/recorder.ts)。 */
const native = registerPlugin<ApkUpdateNative>('ApkUpdate');

/** 真机上那一件。浏览器里也拿得到这个对象,只是调它的方法会抛 —— 调用方一律包着。 */
export function apkUpdateNative(): ApkUpdateNative {
  return native;
}

/** 问原生「我是哪个包」。问不到就 undefined(浏览器里调试、老手机包),界面退到 build.json 那一格。 */
export async function readApkInfo(impl: ApkUpdateNative | null): Promise<ApkUpdateNativeInfo | undefined> {
  if (impl === null) return undefined;
  try {
    return await impl.info();
  } catch {
    return undefined;
  }
}

export type ApkUpdateOutcome =
  | { ok: true }
  | { ok: false; error: string; needPermission?: boolean };

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 下 → 核校验码 → 调起系统安装器。**每一步都能如实失败**,一步不成就停在那儿。
 *
 * 校验码核两遍:原生那边在流上算完就核一遍(不符就删文件、不 resolve),
 * 这里再拿它报回来的那个数核一遍 —— 两遍都过才调 `install`。
 * 多这一遍不是防原生说谎,是**防以后谁把原生那半边改松了**:这一句在这儿,那种改动会当场红。
 */
export async function downloadAndInstall(args: {
  native: ApkUpdateNative | null;
  offer: PhoneApkOffer;
  onProgress?: (received: number, total: number) => void;
}): Promise<ApkUpdateOutcome> {
  const impl = args.native;
  if (impl === null) return { ok: false, error: APK_UPDATE_NO_NATIVE_TEXT };
  const expected = args.offer.sha256;
  // 没校验码压根不下:下一个核不了的 30MB 包,下完也只能删。
  if (!/^[0-9a-fA-F]{64}$/.test(expected ?? '')) {
    return { ok: false, error: '电脑上那份清单没给这个包的校验码,核不了就不下。先在电脑上更新一次工作台。' };
  }

  let listener: { remove: () => Promise<void> } | undefined;
  let got: { path?: string; bytes?: number; sha256?: string };
  try {
    const onProgress = args.onProgress;
    if (onProgress !== undefined) {
      try {
        listener = await impl.addListener('progress', (data) => {
          onProgress(typeof data.received === 'number' ? data.received : 0, typeof data.total === 'number' ? data.total : 0);
        });
      } catch { /* 挂不上就没有进度条,下载照旧 */ }
    }
    got = await impl.download({ url: args.offer.url, sha256: expected as string, size: args.offer.size });
  } catch (error) {
    return { ok: false, error: phoneUpdateFailText(messageOf(error)) };
  } finally {
    // 摘干净:这一页来回进出几次之后,留着的监听会把同一个进度喂给几个已经不在屏上的回调。
    try { await listener?.remove(); } catch { /* 摘不掉也不算失败 */ }
  }

  if (!shaOk(expected, got.sha256)) return { ok: false, error: PHONE_UPDATE_SHA_MISMATCH_TEXT };
  const path = got.path;
  if (typeof path !== 'string' || path === '') {
    return { ok: false, error: phoneUpdateFailText('原生那边没说包下到哪儿了(这是 bug,记一条)') };
  }

  try {
    await impl.install({ path });
  } catch (error) {
    if (codeOf(error) === APK_UPDATE_NEED_PERMISSION_CODE) {
      return { ok: false, error: PHONE_UPDATE_NEED_PERMISSION_TEXT, needPermission: true };
    }
    return { ok: false, error: phoneUpdateFailText(messageOf(error)) };
  }
  return { ok: true };
}
