/**
 * ★ **请求号**(2026-10-12,卡「手机交代只执行一次」;交接 `docs/交接-1012-手机交代只执行一次.md`)。
 *
 * 手机发「会改东西」的那几条时在 body 里带一个自己编的 `client_key`。电脑(8791)按「哪台设备 · 哪条路 · 哪个号」只办一次,
 * 同一个号再来回第一次那份回包(workbench-plugin/src/server/clientKeys.ts)。
 *
 * 盖号在两条路那一层(routedClient.ts)入口:直连发了一半断了、改走房间重发,用的是同一份 options,于是是同一个号。
 * 待发箱(outbox/sendOutbox.ts)补发时自己带着落过盘的那个号,这里看见已经有了就不换。
 *
 * 这张表与 8791 那张一字不差(tests/clientKey.test.ts 读那边的源头比对)。加一条两边一起加。
 */
import type { RequestOptions } from '../api/client';

export const CLIENT_KEY_PATHS: ReadonlySet<string> = new Set([
  '/butler/item',
  '/butler/item/say',
  '/butler/say',
  '/butler/item/continue',
  '/sessions/relay',
  '/onboarding/say',
  '/item/drive',
  '/dispatch/run',
  '/butler/item/budget',
  '/feature/run',
  '/feature/review',
  '/feature/ship',
  '/sessions/answer',
  '/asks/answer',
  '/questions/answer',
  '/approvals/answer',
  '/progress/said',
  '/call/out',
  '/meeting/plan',
  '/butler/call/record',
  '/task/comment',
  '/collab/note/message',
  '/collab/goal/create',
  '/collab/goal/condition/save',
  '/collab/goal/condition/verify',
  '/collab/goal/condition/deliver',
  '/collab/relation/save',
  '/collab/lan/channel/send',
]);

export function newClientKey(): string {
  try {
    const uuid: string | undefined = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid !== '') return `ph-${uuid}`;
  } catch { /* 老 WebView 没有 randomUUID */ }
  return `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(typeof Blob !== 'undefined' && value instanceof Blob)
    && !(typeof FormData !== 'undefined' && value instanceof FormData);
}

/** 表里那几条 POST 的对象 body 盖一个号;已经带了就不换。别的原样返回(同一个对象)。 */
export function stampClientKey(path: string, options: RequestOptions): RequestOptions {
  if ((options.method ?? 'GET') !== 'POST') return options;
  if (!CLIENT_KEY_PATHS.has(path.split('?')[0] ?? '')) return options;
  if (!plainObject(options.body)) return options;
  const existing = options.body.client_key;
  if (typeof existing === 'string' && existing.trim() !== '') return options;
  return { ...options, body: { ...options.body, client_key: newClientKey() } };
}
