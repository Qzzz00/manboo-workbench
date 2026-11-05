import { afterAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('auth');
const { adminAuthMiddleware, isLoopbackAddress } = require('../server/middleware/adminAuth.cjs');
const { loadConfig } = require('../server/config.cjs');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');

afterAll(() => {
  db.close();
  cleanupHome(home);
});

function fakeReq({ remoteAddress, token }) {
  return { headers: token === undefined ? {} : { 'x-workbench-token': token }, socket: { remoteAddress } };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}
function run(req) {
  const res = fakeRes();
  let passed = false;
  adminAuthMiddleware(req, res, () => { passed = true; });
  return { passed, res, req };
}

describe('本机版鉴权:无账号密码', () => {
  it('非本机、无令牌 → 403', () => {
    const { passed, res } = run(fakeReq({ remoteAddress: '192.168.43.7' }));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('本机回环、无令牌 → 放行,req.admin 固定为 ben', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const { passed, req } = run(fakeReq({ remoteAddress: addr }));
      expect(passed, addr).toBe(true);
      expect(req.admin.username).toBe('ben');
    }
  });

  it('非本机但带正确 X-Workbench-Token(工作台转发) → 放行', () => {
    const { passed } = run(fakeReq({ remoteAddress: '192.168.43.7', token: loadConfig().token }));
    expect(passed).toBe(true);
  });

  it('带错误令牌即使来自本机也拒绝', () => {
    const { passed, res } = run(fakeReq({ remoteAddress: '127.0.0.1', token: 'deadbeef' }));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('isLoopbackAddress 只认回环段', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('HTTP 面', () => {
  it('/health 带令牌可访问且不回显 token;错误令牌 403', async () => {
    const srv = await listen(createApp());
    try {
      const ok = await json(srv.base, '/health', { headers: { 'x-workbench-token': loadConfig().token } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, avatarCount: 0, voiceCount: 0 });
      expect(JSON.stringify(ok.body)).not.toContain(loadConfig().token);
      const bad = await json(srv.base, '/health', { headers: { 'x-workbench-token': 'nope' } });
      expect(bad.status).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
