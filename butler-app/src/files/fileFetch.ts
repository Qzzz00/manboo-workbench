/**
 * 手机从电脑取文件(2026-09-25,卡 J `feat/phone-fetch-file`)在手机这一侧的纯逻辑。
 *
 * 维护者 09-24 20:02:「从电脑取文件呢」。两种说法都要通:
 *   - **电话里**说「把工作台仓库的 README 发到我手机上」:电脑上的她找、复述、他说对、推过来 —— 字节从房间的 `wb.file` 到;
 *   - **首页输入框里打同一句**:8791 不建卡,回一张「找到了什么」的卡({@link FileAsk});
 *     他点「发到这台手机」**那一下就是确认**,然后这里去取:
 *       · 在家(直连 8791 通着)→ `GET /files/offer/<单号>` 直接下载,不经服务器,几十 MB 也就几秒;
 *       · 在外面 → 让电脑上的工人经房间推过来(`file_pull`),字节同样从 `wb.file` 到。
 *
 * 路径**从来不到手机上**:卡上只有文件名、在哪、多大;取的时候拿的是单号。
 * 这个文件里没有 React,也不碰原生:取、存、打开都可以在测试里换掉。
 */
import type { ApiClient } from '../api/client';
import { saveWbchFile, type WbchFileSinkDeps, type WbchSavedFile } from '../channel/fileSink';

export type FetchFileKind = 'text' | 'pdf' | 'image' | 'video' | 'audio' | 'other';

/** 卡上的一个候选。与 workbench-plugin/src/server/fileFetch.ts 的 FileAskHitView 同形(只读子集)。 */
export interface FileAskHit {
  /** 取件单号。 */
  offer: string;
  name: string;
  /** 在哪:项目名,或者根名加一两级目录(「GitHub / desktop-workbench / docs」)。 */
  where: string;
  bytes: number;
  kind: FetchFileKind;
  mtime?: string;
}

/** `/butler/item` 认出「把 X 发到我手机上」之后回的那张卡。 */
export interface FileAsk {
  /** Same /say envelope receipt, supplied by the caller; never reconstructed from hits. */
  screen?: string;
  id: string;
  /** 他的原话。 */
  request: string;
  /** 找的是什么(「desktop-workbench · readme」)。 */
  query: string;
  /** 在哪台电脑上找的。 */
  device: string;
  hits: readonly FileAskHit[];
  total: number;
  /** 没授权 / 没找到 / 只列了几个:原样摆出来。 */
  note?: string;
}

const KINDS: readonly FetchFileKind[] = ['text', 'pdf', 'image', 'video', 'audio', 'other'];

/** 回包里的 `file_ask` → 一张卡。认不出就 null(**网络上来的东西**,字段不对就当没收到)。 */
export function parseFileAsk(raw: unknown): FileAsk | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || item.id === '' || !Array.isArray(item.hits)) return null;
  const hits: FileAskHit[] = [];
  for (const one of item.hits) {
    const hit = (one ?? {}) as Record<string, unknown>;
    if (typeof hit.offer !== 'string' || hit.offer === '' || typeof hit.name !== 'string' || hit.name === '') continue;
    hits.push({
      offer: hit.offer,
      name: hit.name,
      where: typeof hit.where === 'string' ? hit.where : '',
      bytes: typeof hit.bytes === 'number' && Number.isFinite(hit.bytes) ? hit.bytes : 0,
      kind: KINDS.includes(hit.kind as FetchFileKind) ? (hit.kind as FetchFileKind) : kindOfName(hit.name),
      ...(typeof hit.mtime === 'string' && hit.mtime !== '' ? { mtime: hit.mtime } : {}),
    });
  }
  return {
    id: item.id,
    request: typeof item.request === 'string' ? item.request : '',
    query: typeof item.query === 'string' ? item.query : '',
    device: typeof item.device === 'string' && item.device !== '' ? item.device : '电脑',
    hits,
    total: typeof item.total === 'number' && Number.isFinite(item.total) ? item.total : hits.length,
    ...(typeof item.note === 'string' && item.note !== '' ? { note: item.note } : {}),
  };
}

/** 文件名 → 大类(卡上挑图标、收到后挑怎么打开)。 */
export function kindOfName(name: string): FetchFileKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav'].includes(ext)) return 'audio';
  return 'other';
}

const MIME: Readonly<Record<string, string>> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 文件名 → MIME(打开时交给系统挑应用用)。认不出就 `*\/*`,让系统自己问。 */
export function mimeOfName(name: string): string {
  return MIME[name.toLowerCase().split('.').pop() ?? ''] ?? '*/*';
}

/** 「4.2 MB」。 */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不详';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 进度那一行:「正在收「录屏.mov」37% · 14.8 / 40.0 MB」。不知道总数就只说收了多少。 */
export function progressText(input: { name: string; received: number; total?: number }): string {
  if (input.total === undefined || input.total <= 0) return `正在收「${input.name}」· 已收 ${sizeText(input.received)}`;
  const pct = Math.min(100, Math.floor((input.received / input.total) * 100));
  return `正在收「${input.name}」${pct}% · ${sizeText(input.received)} / ${sizeText(input.total)}`;
}

/**
 * ——— 电脑**主动推过来**的那几张卡(2026-10-04,卡 `claude/phone-file-send-loop`) ———
 *
 * 以前这张卡**只能跟在她那句话的回包里**(`POST /butler/item` 的回执)。于是事务官找到文件之后
 * 没有任何办法把卡摆到她面前 —— 10-04 早上它只能回一句「你在手机上再打一句『把官网逐字稿发我』」,
 * 而那件事已经被记成了完成。
 *
 * 现在 8791 把卡摆在这台设备名下(`fileDelivery.ts`),这里每隔几秒问一次:
 * 在家直连,出门经房间代理(工人白名单里有 `GET /files/pending`),两条路同一份数据。
 * **问不到就当这一拍没有**(不清掉手上正显示的那张,也不编一张)。
 */
export async function fetchPendingFileAsks(client: ApiClient): Promise<readonly FileAsk[]> {
  const res = await client.json<{ file_asks?: unknown }>('/files/pending');
  if (!res.ok) return [];
  const raw = Array.isArray(res.data.file_asks) ? res.data.file_asks : [];
  const out: FileAsk[] = [];
  for (const one of raw) {
    const ask = parseFileAsk(one);
    if (ask !== null && ask.hits.length > 0) out.push(ask);
  }
  return out;
}

/**
 * **收到了,报一句**(2026-10-04)。这是三条回执路里最真的那一条:文件已经写进这台手机的
 * 「文档 / 事务官」里、sha256 也对上了。电脑那边凭它把那张卡挪进「完成」——
 * 「要一份文件」那一类事项的"办完"认的就是回执。
 *
 * **报不上去不当失败**:文件确实已经在手机上了;那一头还有另两条回执路兜着(直连流走完 / 工人推完)。
 */
export async function reportFileReceived(
  client: ApiClient,
  input: { offer: string; ok: boolean; bytes?: number; error?: string },
): Promise<void> {
  await client.json('/files/received', {
    method: 'POST',
    body: {
      offer: input.offer,
      ok: input.ok,
      ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
  }).catch(() => undefined);
}

/** 取的结果。`room` = 电脑开始推了,字节随后从房间到(那一头由 onFile 收)。 */
export type PullOutcome =
  | { via: 'direct'; ok: true; saved: WbchSavedFile }
  | { via: 'room'; ok: true }
  | { via: 'direct' | 'room'; ok: false; error: string };

export interface PullDeps {
  /** 此刻走哪条路:直连 / 远程 / 连不上。 */
  mode: () => 'direct' | 'remote' | 'offline';
  /** 直连 8791 的那一份(要有 download)。 */
  direct: ApiClient;
  /** 经房间让电脑推(channel.pullOffer)。缺席 = 这一版通道层没有这条路。 */
  pullViaRoom?: (offer: string) => Promise<{ ok: true; name?: string; bytes?: number } | { ok: false; error: string }>;
  onProgress?: (received: number, total?: number) => void;
  sink?: WbchFileSinkDeps;
}

/** 在外面、这一版又没有经房间取的那条路时那句话。 */
export const PULL_NO_ROOM_TEXT = '在外面取文件要新一点的电脑端(电脑上的工作台升级一下),回到家里的 Wi-Fi 也能直接取';

/**
 * 取一个候选。**在家直连下载;直连断了(网络那一类)或者本来就在外面,改经房间让电脑推。**
 * 服务端明说不给(404 单子没了、410 文件没了、413 太大、403 不该出门)就**不换路重试** ——
 * 换一条路问,得到的是同一句话。
 */
export async function pullFileOffer(hit: FileAskHit, deps: PullDeps): Promise<PullOutcome> {
  const path = `/files/offer/${encodeURIComponent(hit.offer)}`;
  if (deps.mode() === 'direct' && deps.direct.download !== undefined) {
    const got = await deps.direct.download(path, { ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }) });
    if (got.ok) {
      const saved = await saveWbchFile(
        { name: hit.name, bytes: got.data.bytes, ...(got.data.mimeType === undefined ? {} : { mimeType: got.data.mimeType }), ...(got.data.sha256 === undefined ? {} : { sha256: got.data.sha256 }) },
        deps.sink ?? {},
      );
      return saved.ok ? { via: 'direct', ok: true, saved: saved.saved } : { via: 'direct', ok: false, error: saved.error };
    }
    if (got.kind !== 'network') return { via: 'direct', ok: false, error: got.error };
    // 直连半路断了(出门了、Wi-Fi 切了):退到房间那条路再要一次。
  }
  if (deps.pullViaRoom === undefined) return { via: 'room', ok: false, error: PULL_NO_ROOM_TEXT };
  const started = await deps.pullViaRoom(hit.offer);
  return started.ok ? { via: 'room', ok: true } : { via: 'room', ok: false, error: started.error };
}
