/**
 * 电脑发过来的文件落到手机哪儿(2026-09-17;2026-09-25 卡 J 改了三处)。
 *
 * 落在**系统「文档」目录**底下的 `事务官/`(Capacitor `Directory.Documents`,在安卓上是公共的
 * `/storage/emulated/0/Documents/事务官/`,文件管理器里「文档 → 事务官」就能看到;09-17 那版这里的注释
 * 写成了 App 私有目录,是错的 —— 卡 J 翻了 `ionfilesystem-android` 的实现才确认)。
 * 安卓 11 起 App 往公共「文档」里写自己建的文件不要权限;浏览器上(vite dev)退回浏览器自己的下载。
 *
 * 2026-09-25 改的三处:
 *   1. **分块写**:以前整个文件一次转 base64 过原生桥 —— 40MB 的文件是一条 54MB 的字符串,
 *      WebView 当场吃不消。现在 512KB 一块:第一块 writeFile,后面 appendFile;
 *   2. **不覆盖**:同名的加 `-2`、`-3`(与电脑收件夹同一条规矩),两次要的两份都在;
 *   3. **对 sha256**:电脑推过来时在流上签了 sha256,收完对一遍,**对不上就不存**并如实说 ——
 *      一个传坏了的 PDF 打开是一片空白,他只会以为文件本来就是坏的。
 */

export interface WbchSavedFile {
  /** 真正落盘用的名字(清洗过、去过重)。 */
  name: string;
  /** 一句能给人看的话(落在哪儿)。 */
  where: string;
  /** 相对「文档」目录的路径(`事务官/README.md`)。打开 / 分享要它;浏览器那条路没有。 */
  path?: string;
  /** 原生那边给的 `file://` 地址(打开 / 分享用)。拿不到就缺席。 */
  uri?: string;
  bytes: number;
  mimeType?: string;
}

/** 文件夹名。中文,因为它是给人在文件管理器里认的。 */
export const WBCH_SAVE_FOLDER = '事务官';
export const WBCH_SAVE_WHERE_TEXT = `手机「文档 / ${WBCH_SAVE_FOLDER}」里`;
export const WBCH_SAVE_WHERE_WEB_TEXT = '浏览器的下载里';
/** 一块多大(原始字节)。512KB → 约 700KB 的 base64,原生桥吃得下。 */
export const WBCH_SAVE_CHUNK_BYTES = 512 * 1024;
/** 流上签的 sha256 对不上时那句话。 */
export const WBCH_SHA_MISMATCH_TEXT = '收到的和电脑上那份对不上(路上传坏了),没存;再要一次';

/**
 * 文件名清洗。房间里来的名字是别人给的:只留最后一段、去掉路径分隔符与前导点、限长。
 * 名字空了给一个能认的缺省,**不拿一个空名字去写文件**。
 */
export function wbchSafeFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  // 控制字符用转义写(以前这里是两个裸的控制字节,改文件的工具一过手就变成了空格,把「.」也换掉了)。
  const cleaned = last.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (cleaned === '') return '未命名文件';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** 重名怎么办:`图.png` → `图-2.png`。 */
export function wbchNumberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // 一次 32k:整段 apply 会在大文件上爆栈
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** sha256 → 十六进制。环境里没有 WebCrypto 就 undefined(那就不对,不假装对过)。 */
export async function wbchSha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) return undefined;
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export interface WbchFilesystemLike {
  writeFile(options: Record<string, unknown>): Promise<unknown>;
  appendFile?(options: Record<string, unknown>): Promise<unknown>;
  stat?(options: Record<string, unknown>): Promise<unknown>;
  getUri?(options: Record<string, unknown>): Promise<{ uri?: string }>;
}

export interface WbchFileSinkDeps {
  /** 测试注入;生产是动态 import('@capacitor/filesystem')。 */
  loadFilesystem?: () => Promise<{
    Filesystem: WbchFilesystemLike;
    Directory: Record<string, string>;
  }>;
  /** 浏览器那条退路。测试注入一个记录函数。 */
  saveInBrowser?: (name: string, bytes: Uint8Array, mimeType?: string) => void;
}

function defaultSaveInBrowser(name: string, bytes: Uint8Array, mimeType?: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], mimeType === undefined ? {} : { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻回收会让某些 WebView 来不及读;下一拍再收。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 是不是跑在手机原生壳里(不是浏览器)。原生上写不进去就是真失败,不退到「浏览器下载」。 */
function onNative(): boolean {
  try {
    return (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * 存一个文件。**失败就说失败**,不吞:收到文件却没存下来,人却看见一句「收到了」是最糟的。
 */
export async function saveWbchFile(
  file: { name: string; bytes: Uint8Array; mimeType?: string; sha256?: string },
  deps: WbchFileSinkDeps = {},
): Promise<{ ok: true; saved: WbchSavedFile } | { ok: false; error: string }> {
  const clean = wbchSafeFileName(file.name);
  if (file.sha256 !== undefined && file.sha256 !== '') {
    const got = await wbchSha256Hex(file.bytes);
    if (got !== undefined && got !== file.sha256.toLowerCase()) return { ok: false, error: WBCH_SHA_MISMATCH_TEXT };
  }
  const loadFilesystem = deps.loadFilesystem ?? (() => import('@capacitor/filesystem') as unknown as ReturnType<NonNullable<WbchFileSinkDeps['loadFilesystem']>>);
  try {
    // 浏览器里(vite dev)Capacitor 的文件接口写进 IndexedDB,人看不见 —— 那条路上直接走浏览器下载,
    // 别说一句「存在手机『文档 / 事务官』里」(卡 J 在浏览器里对着界面点的时候看到的)。
    if (deps.loadFilesystem === undefined && !onNative()) throw new Error('浏览器里没有手机的文件夹');
    const { Filesystem, Directory } = await loadFilesystem();
    // 重名加序号:stat 得到就是有了。没有 stat(老的假实现)就直接写。
    let name = clean;
    if (Filesystem.stat !== undefined) {
      for (let n = 2; n < 50; n += 1) {
        const exists = await Filesystem.stat({ path: `${WBCH_SAVE_FOLDER}/${name}`, directory: Directory.Documents }).then(() => true, () => false);
        if (!exists) break;
        name = wbchNumberedName(clean, n);
      }
    }
    const path = `${WBCH_SAVE_FOLDER}/${name}`;
    const bytes = file.bytes;
    await Filesystem.writeFile({ path, data: toBase64(bytes.subarray(0, WBCH_SAVE_CHUNK_BYTES)), directory: Directory.Documents, recursive: true });
    for (let at = WBCH_SAVE_CHUNK_BYTES; at < bytes.length; at += WBCH_SAVE_CHUNK_BYTES) {
      if (Filesystem.appendFile === undefined) throw new Error('这个版本的文件接口不能追加写');
      await Filesystem.appendFile({ path, data: toBase64(bytes.subarray(at, at + WBCH_SAVE_CHUNK_BYTES)), directory: Directory.Documents });
    }
    let uri: string | undefined;
    try { uri = (await Filesystem.getUri?.({ path, directory: Directory.Documents }))?.uri; } catch { uri = undefined; }
    return {
      ok: true,
      saved: {
        name,
        where: WBCH_SAVE_WHERE_TEXT,
        path,
        ...(uri === undefined || uri === '' ? {} : { uri }),
        bytes: bytes.length,
        ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      },
    };
  } catch (error) {
    // 原生壳里写不进去(磁盘满、没权限):那是真失败 —— 手机上没有「浏览器的下载」这回事。
    if (onNative()) {
      return { ok: false, error: error instanceof Error && error.message !== '' ? `手机上没存下来:${error.message}` : '手机上没存下来' };
    }
    // 没有原生桥(浏览器):退回浏览器下载。它也失败才算真失败。
    try {
      (deps.saveInBrowser ?? defaultSaveInBrowser)(clean, file.bytes, file.mimeType);
      return { ok: true, saved: { name: clean, where: WBCH_SAVE_WHERE_WEB_TEXT, bytes: file.bytes.length, ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }) } };
    } catch (fallbackError) {
      return { ok: false, error: fallbackError instanceof Error && fallbackError.message !== '' ? fallbackError.message : '文件没存下来' };
    }
  }
}
