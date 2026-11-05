// 手机 App 的页面在 http://localhost(Capacitor androidScheme http)下,对中转是跨域请求。
// 10-10 真机:中转一个跨域头都不回,App 里的账号登录、直领进房凭证全被 WebView 拦掉,
// 手机只能在局域网里请电脑代领 —— 出门换不了电脑、登不上账号。只放行 App 自己的来源。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';

let server;
let base;
beforeEach(async () => {
  const app = createApp({ db: openRelayDb(':memory:'), config: relayConfigOf({}) });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('手机 App 来源的跨域', () => {
  it.each(['http://localhost', 'https://localhost', 'capacitor://localhost'])('★预检 %s → 放行 POST 与 content-type / authorization', async (origin) => {
    const res = await fetch(`${base}/v1/account/login`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toMatch(/content-type/);
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toMatch(/authorization/);
  });

  it('★正式请求也带上允许的来源(不然预检过了、响应照样被拦)', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost');
    expect(res.headers.get('vary')).toMatch(/Origin/);
  });

  it('别的网页来源不放行(不回允许头)', async () => {
    const res = await fetch(`${base}/v1/account/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('电脑那一侧不带 Origin 的请求照旧', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
