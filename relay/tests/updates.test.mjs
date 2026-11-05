// 热更新的清单与产物那条只读静态路由(2026-09-18)。
//
// 「真跑」= 真起一个服务器、真用 fetch 说话、真从一个 mktemp 出来的目录里发文件。
// 这一组要钉死的是三件事:**发得出来**、**不越界**(目录穿越、点开头的文件、列目录)、
// **latest.json 不被缓存**(它就是"有没有新版"的答案,缓存住等于发了新版也没人知道)。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';

let server;
let db;
let base;
let updatesDir;

beforeEach(async () => {
  updatesDir = mkdtempSync(join(tmpdir(), 'relay-updates-'));
  mkdirSync(join(updatesDir, '0.2.42'), { recursive: true });
  writeFileSync(join(updatesDir, 'latest.json'), JSON.stringify({ version: '0.2.42', assets: {} }));
  writeFileSync(join(updatesDir, '0.2.42', 'plugin.tgz'), '假的插件包');
  writeFileSync(join(updatesDir, '.secret'), '不该发出去');

  db = openRelayDb(':memory:');
  const config = { ...relayConfigOf({}), updatesDir };
  const app = createApp({ db, config });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
  if (updatesDir !== undefined) rmSync(updatesDir, { recursive: true, force: true });
  updatesDir = undefined;
});

describe('GET /updates/*', () => {
  it('清单发得出来,而且**不给缓存**', async () => {
    const res = await fetch(`${base}/updates/latest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await res.json()).version).toBe('0.2.42');
  });

  it('热修那份清单 beta.json 同样不给缓存(2026-10-21 两条通道)', async () => {
    writeFileSync(join(updatesDir, 'beta.json'), JSON.stringify({ version: '0.2.43', assets: {} }));
    const res = await fetch(`${base}/updates/beta.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await res.json()).version).toBe('0.2.43');
  });

  it('产物发得出来,按内容寻址所以给长缓存', async () => {
    const res = await fetch(`${base}/updates/0.2.42/plugin.tgz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe('假的插件包');
  });

  it('不要鉴权 —— 刚装完还没领令牌的那台机器也得查得到更新', async () => {
    // 别的路(/v1/*)没有令牌是 401;这一条是有意的例外,理由写在 app.cjs 文件头。
    const withoutAuth = await fetch(`${base}/updates/latest.json`);
    expect(withoutAuth.status).toBe(200);
    const models = await fetch(`${base}/v1/models`);
    expect(models.status).not.toBe(200);
  });

  it('点开头的文件不发', async () => {
    expect((await fetch(`${base}/updates/.secret`)).status).toBe(404);
  });

  it('不列目录', async () => {
    const res = await fetch(`${base}/updates/`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('0.2.42');
  });

  it('目录穿越拿不到上一级的东西', async () => {
    writeFileSync(join(updatesDir, '..', 'relay-updates-outside.txt'), '外面的东西');
    try {
      for (const path of ['/updates/../relay-updates-outside.txt', '/updates/%2e%2e/relay-updates-outside.txt']) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        expect(res.status).not.toBe(200);
      }
    }
    finally {
      rmSync(join(updatesDir, '..', 'relay-updates-outside.txt'), { force: true });
    }
  });

  it('没有的那些路径回一句人话,不是 express 的默认 404 页', async () => {
    const res = await fetch(`${base}/updates/0.9.9/nope.tgz`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('update_asset_not_found');
    expect(body.error.message).toContain('不存在');
  });

  it('产物目录整个不存在也只是 404,服务照常活着', async () => {
    rmSync(updatesDir, { recursive: true, force: true });
    expect((await fetch(`${base}/updates/latest.json`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
