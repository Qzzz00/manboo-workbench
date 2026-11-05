/**
 * 手机交代一次、电脑只办一次(2026-10-12,卡「手机交代只执行一次」):手机这一侧的请求号。
 *
 * - 认请求号的那几条 POST,手机自动盖一个号;已经带了(待发箱补发)就不换;
 * - 直连发了一半断了、改走房间重发 —— **两条路带的是同一个号**(8791 据此只办一次);
 * - 手机这张表与 8791 那张(workbench-plugin/src/server/clientKeys.ts)一字不差。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import { CLIENT_KEY_PATHS, newClientKey, stampClientKey } from '../src/channel/clientKey';
import { createWbchRoutedClient } from '../src/channel/routedClient';

const PLUGIN_CLIENT_KEYS = resolve(process.cwd(), '../workbench-plugin/src/server/clientKeys.ts');

function pluginClientKeyPaths(): string[] {
  const source = readFileSync(PLUGIN_CLIENT_KEYS, 'utf8');
  const block = /export const CLIENT_KEY_PATHS[^[]*\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('请求号那张表', () => {
  it('与 8791 那张一字不差', () => {
    expect([...CLIENT_KEY_PATHS].sort()).toEqual(pluginClientKeyPaths().sort());
  });
});

describe('stampClientKey', () => {
  it('表里那几条 POST 的对象 body 盖一个号', () => {
    const out = stampClientKey('/butler/item', { method: 'POST', body: { text: 'a' } });
    expect(typeof (out.body as { client_key?: unknown }).client_key).toBe('string');
  });

  it('已经带了号(待发箱补发)就不换', () => {
    const out = stampClientKey('/butler/item', { method: 'POST', body: { text: 'a', client_key: 'k-1' } });
    expect((out.body as { client_key?: unknown }).client_key).toBe('k-1');
  });

  it('GET、表外的路、非对象 body 原样不动', () => {
    const get: RequestOptions = { method: 'GET' };
    expect(stampClientKey('/butler/item', get)).toBe(get);
    const other: RequestOptions = { method: 'POST', body: { id: 'x' } };
    expect(stampClientKey('/task/delete', other)).toBe(other);
    const blob: RequestOptions = { method: 'POST', body: new Blob(['x']) };
    expect(stampClientKey('/butler/item', blob)).toBe(blob);
  });

  it('查询串不影响认路', () => {
    const out = stampClientKey('/butler/item?x=1', { method: 'POST', body: {} });
    expect((out.body as { client_key?: unknown }).client_key).toBeDefined();
  });

  it('每次编的号都不一样', () => {
    expect(newClientKey()).not.toBe(newClientKey());
  });
});

describe('两条路带同一个号', () => {
  it('直连连不上、改走房间:房间那一下带的是直连那一下的号', async () => {
    const seen: { via: string; body: unknown }[] = [];
    const OFFLINE: ApiResult<unknown> = { ok: false, status: 0, kind: 'network', error: '连不上' };
    const OK: ApiResult<unknown> = { ok: true, status: 200, data: { id: 't-1' } };
    const make = (via: string, answer: ApiResult<unknown>): ApiClient => ({
      baseUrl: via,
      async json(_path, options) { seen.push({ via, body: options?.body }); return answer as ApiResult<never>; },
      async blob() { return answer as ApiResult<Blob>; },
    });
    const client = createWbchRoutedClient({ direct: make('direct', OFFLINE), remote: async () => ({ ok: true, client: make('room', OK) }) });
    await client.json('/butler/item', { method: 'POST', body: { text: '买咖啡豆' } });
    expect(seen.map((s) => s.via)).toEqual(['direct', 'room']);
    const [a, b] = seen.map((s) => (s.body as { client_key?: string }).client_key);
    expect(typeof a).toBe('string');
    expect(b).toBe(a);
  });
});
