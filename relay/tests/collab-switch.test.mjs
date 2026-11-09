// 「多人协作区」总开关在中转这一侧(2026-11-09)。
// 钉死:没配 = 关 → 不建那 15 张表、不挂 /v1 协作路由、/health 不说自己有这一块;
// 显式 WORKBENCH_COLLAB_ENABLED=1 才整块接上(collab.test.mjs 就是这么开的)。
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { collabEnabledOf } from '../server/collabFeature.cjs';

let server;
let db;

async function start(env = {}) {
  const config = relayConfigOf(env);
  db = openRelayDb(':memory:', { collab: config.collabEnabled });
  const app = createApp({ db, config });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function tables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
}

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
  if (db !== undefined) { try { db.close(); } catch { /* 关不上就算了 */ } db = undefined; }
});

describe('多人协作区总开关 · 取值', () => {
  it('没配 = 关;显式 1 才开,与本机工作台同一个变量', () => {
    expect(collabEnabledOf({})).toBe(false);
    expect(collabEnabledOf({ WORKBENCH_COLLAB_ENABLED: '1' })).toBe(true);
    expect(collabEnabledOf({ WORKBENCH_COLLAB_ENABLED: 'true' })).toBe(true);
    expect(collabEnabledOf({ WORKBENCH_COLLAB_ENABLED: '0' })).toBe(false);
    expect(relayConfigOf({}).collabEnabled).toBe(false);
    expect(relayConfigOf({ WORKBENCH_COLLAB_ENABLED: '1' }).collabEnabled).toBe(true);
  });
});

describe('多人协作区总开关 · 关着时', () => {
  it('不建协作区的表,普通中转的表照旧', async () => {
    await start();
    const names = tables();
    expect(names).toContain('tokens');
    for (const table of ['workspaces', 'inbox_events', 'channels', 'wecom_bindings']) {
      expect(names, `关着时不该有 ${table}`).not.toContain(table);
    }
  });

  it('不挂 /v1 协作路由,/health 不带 collab 那一格', async () => {
    const base = await start();
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.collab).toBeUndefined();
    const res = await fetch(`${base}/v1/workspace/me`);
    expect(res.status).toBe(404);
  });
});

describe('多人协作区总开关 · 开着时', () => {
  it('表建起来、路由接管、/health 如实带 collab', async () => {
    const base = await start({ WORKBENCH_COLLAB_ENABLED: '1' });
    expect(tables()).toContain('workspaces');
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.collab).toEqual({ inbox: true, wecom_configured: false });
    // 没带令牌会被协作路由自己挡住(401/403),但绝不是「没这条路由」。
    const res = await fetch(`${base}/v1/workspace/me`);
    expect(res.status).not.toBe(404);
  });
});
