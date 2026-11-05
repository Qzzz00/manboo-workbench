/**
 * 对话里的附件,按需问电脑要(2026-10-01,手机读对话卡 C)。`GET /sessions/attachment`:
 * 先 `view=info` 问能怎么看,再按需要 `thumb`(缩略图)/ `full`(整份,512KB 一块拼起来)/ `text`(文字、表格)/ `page`(PDF 一页)。
 * 在家在外同一条路(出门走中转的房间代理,每块都装得进一条回包)。转换都在 Mac 上做好了,手机这里只拼字节、不解析文件。
 */
import type { ApiClient } from '../../api/client';
import type { SessionAttachmentChunk, SessionAttachmentInfo, SessionAttachmentKind } from '../../api/protocol';
import type { FetchFileKind, FileAskHit } from '../../files/fileFetch';

export interface AttachmentTarget {
  agent: string;
  sessionId: string;
  ref: string;
}

type Got<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

async function call<T>(client: ApiClient, target: AttachmentTarget, view: string, n = 0): Promise<Got<T>> {
  const res = await client.json<T>(`/sessions/attachment?agent=${encodeURIComponent(target.agent)}&id=${encodeURIComponent(target.sessionId)}&ref=${encodeURIComponent(target.ref)}&view=${view}&part=${n}&page=${n}`);
  if (res.ok && res.data !== undefined) return { ok: true, value: res.data };
  return { ok: false, error: res.ok ? '电脑回的东西认不出' : res.error, status: res.ok ? 0 : res.status };
}

export function attachmentInfo(client: ApiClient, target: AttachmentTarget): Promise<Got<SessionAttachmentInfo>> {
  return call<SessionAttachmentInfo>(client, target, 'info');
}

function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** 缩略图(一块) → data URL。 */
export async function attachmentThumb(client: ApiClient, target: AttachmentTarget): Promise<Got<string>> {
  const got = await call<SessionAttachmentChunk>(client, target, 'thumb');
  if (!got.ok) return got;
  if (got.value.data === undefined) return { ok: false, error: '没有缩略图', status: 404 };
  return { ok: true, value: `data:${got.value.mime ?? 'image/png'};base64,${got.value.data}` };
}

/** 整份:一块一块要,拼成 Blob。`onProgress(已到几块, 一共几块)`。 */
export async function attachmentFull(client: ApiClient, target: AttachmentTarget, parts: number, mime: string, onProgress?: (done: number, total: number) => void): Promise<Got<Blob>> {
  const chunks: Uint8Array[] = [];
  for (let n = 0; n < parts; n += 1) {
    const got = await call<SessionAttachmentChunk>(client, target, 'full', n);
    if (!got.ok) return got;
    if (got.value.data === undefined) return { ok: false, error: '这一块是空的', status: 0 };
    chunks.push(bytesOf(got.value.data));
    onProgress?.(n + 1, parts);
  }
  return { ok: true, value: new Blob(chunks as BlobPart[], { type: mime }) };
}

/** 文字 / 表格:几块拼起来。 */
export async function attachmentText(client: ApiClient, target: AttachmentTarget, parts: number): Promise<Got<{ text?: string; rows?: string[][] }>> {
  let text = '';
  let rows: string[][] | undefined;
  for (let n = 0; n < parts; n += 1) {
    const got = await call<SessionAttachmentChunk>(client, target, 'text', n);
    if (!got.ok) return got;
    if (got.value.rows !== undefined) rows = [...(rows ?? []), ...got.value.rows];
    else text += got.value.text ?? '';
  }
  return { ok: true, value: rows === undefined ? { text } : { rows } };
}

/** PDF 一页 → data URL。 */
export async function attachmentPage(client: ApiClient, target: AttachmentTarget, page: number): Promise<Got<string>> {
  const got = await call<SessionAttachmentChunk>(client, target, 'page', page);
  if (!got.ok) return got;
  return got.value.data === undefined ? { ok: false, error: '这一页出不了图', status: 404 } : { ok: true, value: `data:${got.value.mime ?? 'image/jpeg'};base64,${got.value.data}` };
}

/**
 * 「存到手机上」(2026-10-04,卡「手机看各家对话里的图片和文件」)。
 *
 * 压缩包、设计稿、几百 MB 的视频这一类在手机上看不了全 —— `view=keep` 让电脑开一张取件单,
 * 后面照旧走**现成的那一套**(`pullFileOffer`:在家直连 `GET /files/offer/<单号>`,出门让工人经房间推)。
 * 这里不碰传输,也不碰路径(路径从来不到手机上)。
 *
 * 老电脑端不认 `view=keep` → 400 / 404,外面照它说的那句话写,不摆这颗键。
 */
export async function attachmentKeep(client: ApiClient, target: AttachmentTarget): Promise<Got<FileAskHit>> {
  const got = await call<{ offer?: unknown; name?: unknown; bytes?: unknown; where?: unknown; kind?: unknown }>(client, target, 'keep');
  if (!got.ok) return got;
  const one = got.value;
  if (typeof one.offer !== 'string' || one.offer === '' || typeof one.name !== 'string' || one.name === '') {
    return { ok: false, error: '电脑回的取件单认不出', status: 0 };
  }
  return {
    ok: true,
    value: {
      offer: one.offer,
      name: one.name,
      where: typeof one.where === 'string' ? one.where : '这条对话里',
      bytes: typeof one.bytes === 'number' && Number.isFinite(one.bytes) ? one.bytes : 0,
      kind: KEEP_KINDS.includes(one.kind as FetchFileKind) ? one.kind as FetchFileKind : 'other',
    },
  };
}

const KEEP_KINDS: readonly FetchFileKind[] = ['text', 'pdf', 'image', 'video', 'audio', 'other'];

export const ATTACHMENT_KIND_TITLES: Record<SessionAttachmentKind, string> = {
  image: '图片',
  video: '视频',
  audio: '声音',
  markdown: '文档',
  text: '文本',
  code: '代码',
  table: '表格',
  html: '网页',
  pdf: 'PDF',
  document: '文档',
  slides: '幻灯片',
  sheet: '表格',
  archive: '压缩包',
  other: '文件',
};

/** 「1.2 MB」「340 KB」。 */
export function sizeLabel(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes)) return undefined;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 电脑不在线时附件卡上那一句(对话文字是这次读到的,照常显示)。 */
export const ATTACHMENT_OFFLINE = '电脑不在线,打不开';
export const ATTACHMENT_MISSING = '电脑上已经不在了';
