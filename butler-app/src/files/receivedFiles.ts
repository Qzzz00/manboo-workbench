/**
 * 手机上「收到的文件」(2026-09-25,卡 J):在哪看、点了能打开、能分享到别的 App。
 *
 * **真相就是那个文件夹**(「文档 / 事务官」):不另记一本账 —— 列表每次现读目录,
 * 他在文件管理器里删了一个,这里下一次就没有了,不会指着一个不存在的文件。
 *
 * 打开 / 分享走一件小原生插件(`android/app/src/main/java/ai/ben/butler/FileOpenerPlugin.java`):
 * 用 FileProvider 把文件交给系统,系统弹「用什么打开 / 发给谁」。WebView 自己打不开 PDF,
 * 也够不到微信、文件管理器 —— 这件事只有原生能做。浏览器里(vite dev)只能如实说一句。
 */
import { registerPlugin } from '@capacitor/core';
import { WBCH_SAVE_FOLDER, type WbchSavedFile } from '../channel/fileSink';
import { kindOfName, mimeOfName, type FetchFileKind } from './fileFetch';

export interface ReceivedFile {
  name: string;
  /** 相对「文档」目录(`事务官/README.md`)。 */
  path: string;
  /** 原生给的 `file://` 地址。打开 / 分享用它。 */
  uri?: string;
  bytes: number;
  /** 毫秒时间戳。读不到就缺席。 */
  mtime?: number;
  kind: FetchFileKind;
}

export interface ReceivedFilesDeps {
  loadFilesystem?: () => Promise<{
    Filesystem: {
      readdir(options: Record<string, unknown>): Promise<{ files: readonly { name: string; type?: string; size?: number; mtime?: number; uri?: string }[] }>;
    };
    Directory: Record<string, string>;
  }>;
}

/** 刚存下的那一个 → 列表里的一行(不必等下一次读目录)。 */
export function receivedFromSaved(saved: WbchSavedFile, now: number = Date.now()): ReceivedFile | null {
  if (saved.path === undefined) return null;
  return {
    name: saved.name,
    path: saved.path,
    ...(saved.uri === undefined ? {} : { uri: saved.uri }),
    bytes: saved.bytes,
    mtime: now,
    kind: kindOfName(saved.name),
  };
}

/**
 * 列一遍「文档 / 事务官」。新的在前。**不抛**:读不到(浏览器里、还没收过)就是空的并带一句话。
 */
export async function listReceivedFiles(deps: ReceivedFilesDeps = {}): Promise<{ files: ReceivedFile[]; note?: string }> {
  const load = deps.loadFilesystem ?? (() => import('@capacitor/filesystem') as unknown as ReturnType<NonNullable<ReceivedFilesDeps['loadFilesystem']>>);
  try {
    const { Filesystem, Directory } = await load();
    const listed = await Filesystem.readdir({ path: WBCH_SAVE_FOLDER, directory: Directory.Documents });
    const files: ReceivedFile[] = [];
    for (const entry of listed.files ?? []) {
      if (entry.type === 'directory' || typeof entry.name !== 'string' || entry.name === '' || entry.name.startsWith('.')) continue;
      files.push({
        name: entry.name,
        path: `${WBCH_SAVE_FOLDER}/${entry.name}`,
        ...(typeof entry.uri === 'string' && entry.uri !== '' ? { uri: entry.uri } : {}),
        bytes: typeof entry.size === 'number' ? entry.size : 0,
        ...(typeof entry.mtime === 'number' ? { mtime: entry.mtime } : {}),
        kind: kindOfName(entry.name),
      });
    }
    files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return { files };
  } catch {
    return { files: [], note: '还没有收到过文件(或者这里读不到那个文件夹)。' };
  }
}

/** 原生那件插件的形状。 */
export interface FileOpenerNative {
  open(options: { path: string; mimeType: string }): Promise<unknown>;
  share(options: { path: string; mimeType: string; name: string }): Promise<unknown>;
}

/** `registerPlugin` 本身不抛,**调它的方法才抛**(同 micPermission.ts 那条)。 */
const NativeFileOpener = registerPlugin<FileOpenerNative>('FileOpener');

export interface FileOpenerDeps {
  native?: FileOpenerNative;
}

/** 浏览器里 / 插件没登记上时那句话。 */
export const OPEN_UNAVAILABLE_TEXT = '这里打不开:到手机的「文件」App 里,「文档 → 事务官」文件夹就能看到它';

function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message.includes('not implemented') || message.includes('UNIMPLEMENTED')) return OPEN_UNAVAILABLE_TEXT;
  return message !== '' ? message : fallback;
}

/** 用手机上的应用打开它(系统弹「用什么打开」)。 */
export async function openReceivedFile(file: ReceivedFile, deps: FileOpenerDeps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = file.uri ?? file.path;
  try {
    await (deps.native ?? NativeFileOpener).open({ path: target, mimeType: mimeOfName(file.name) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error, '没打开') };
  }
}

/** 分享给别的 App(微信、邮件……系统弹「发给谁」)。 */
export async function shareReceivedFile(file: ReceivedFile, deps: FileOpenerDeps = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = file.uri ?? file.path;
  try {
    await (deps.native ?? NativeFileOpener).share({ path: target, mimeType: mimeOfName(file.name), name: file.name });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error, '没分享出去') };
  }
}

/** 「09-25 14:03」。今天的只写时刻。 */
export function receivedTimeText(mtime: number | undefined, now: number = Date.now()): string {
  if (mtime === undefined) return '';
  const date = new Date(mtime);
  const today = new Date(now);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === today.toDateString()) return hhmm;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hhmm}`;
}
