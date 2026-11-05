// 端口被占时的退出码(2026-09-17 重启风暴):对面是 butler-server → exit 0;否则 → exit 1。
import { afterAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen } from './_setup.mjs';

const home = tempHome('listen-err');
const { exitCodeForListenError } = require('../server/index.cjs');
const { createApp } = require('../server/app.cjs');

afterAll(() => cleanupHome(home));

const EADDRINUSE = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8792'), { code: 'EADDRINUSE' });

function fakeFetch(body, status = 200) {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

describe('exitCodeForListenError', () => {
  it('EADDRINUSE 且占端口的是健康的 butler-server → 0,日志说明是多余的一份', async () => {
    const lines = [];
    const code = await exitCodeForListenError(EADDRINUSE, {
      host: '127.0.0.1', port: 8792, log: (...a) => lines.push(a.join(' ')),
      fetchImpl: fakeFetch({ ok: true, name: 'butler-server', pid: 57306 }),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('pid 57306');
    expect(lines.join('\n')).toContain('多余');
  });

  it('EADDRINUSE 但对面不是 butler-server(别的服务、非 JSON、连不上)→ 1', async () => {
    const quiet = { host: '127.0.0.1', port: 8792, log: () => {} };
    expect(await exitCodeForListenError(EADDRINUSE, { ...quiet, fetchImpl: fakeFetch({ ok: true, name: 'something-else' }) })).toBe(1);
    expect(await exitCodeForListenError(EADDRINUSE, { ...quiet, fetchImpl: fakeFetch({ error: 'x' }, 403) })).toBe(1);
    expect(await exitCodeForListenError(EADDRINUSE, { ...quiet, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).toBe(1);
    expect(await exitCodeForListenError(EADDRINUSE, { ...quiet, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) })).toBe(1);
  });

  it('不是 EADDRINUSE(比如 EACCES)→ 1,不去探测', async () => {
    let probed = false;
    const code = await exitCodeForListenError(Object.assign(new Error('EACCES'), { code: 'EACCES' }), {
      host: '127.0.0.1', port: 80, log: () => {}, fetchImpl: async () => { probed = true; throw new Error('x'); },
    });
    expect(code).toBe(1);
    expect(probed).toBe(false);
  });

  it('真打一份 butler-server 的 /health(回环不带令牌)也认得出来', async () => {
    const running = await listen(createApp());
    const port = Number(new URL(running.base).port);
    try {
      const code = await exitCodeForListenError(EADDRINUSE, { host: '127.0.0.1', port, log: () => {} });
      expect(code).toBe(0);
    } finally {
      await running.close();
    }
  });
});
