// 来源:Aiboo origin/main 1f430c3f server/lib/previewToken.test.cjs(node:test → vitest;密钥改走 BUTLER_PREVIEW_SECRET)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome } from './_setup.mjs';

const home = tempHome('ptok');
const { signPreviewToken, verifyPreviewToken } = require('../server/lib/previewToken.cjs');

beforeAll(() => { process.env.BUTLER_PREVIEW_SECRET = 'test-secret'; });
afterAll(() => cleanupHome(home));

describe('预览 URL 短时签名', () => {
  it('签发后能验回版本号', () => {
    const token = signPreviewToken('abc', 3);
    expect(verifyPreviewToken(token, 'abc')).toEqual({ ok: true, version: 3 });
  });
  it('拒绝给别的角色签的 token', () => {
    expect(verifyPreviewToken(signPreviewToken('abc', 1), 'xyz').ok).toBe(false);
  });
  it('拒绝被篡改的 token', () => {
    const token = signPreviewToken('abc', 1);
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyPreviewToken(tampered, 'abc').ok).toBe(false);
  });
  it('过期的拒绝', () => {
    const token = signPreviewToken('abc', 1, { now: () => 1000, ttlMs: 10 });
    expect(verifyPreviewToken(token, 'abc', { now: () => 2000 })).toMatchObject({ ok: false, reason: 'expired' });
  });
  it('没有密钥时签发抛错、校验返回 no_secret', () => {
    process.env.BUTLER_PREVIEW_SECRET = '';
    expect(() => signPreviewToken('abc', 1)).toThrow();
    expect(verifyPreviewToken('a.b', 'abc')).toMatchObject({ ok: false, reason: 'no_secret' });
    process.env.BUTLER_PREVIEW_SECRET = 'test-secret';
  });
  it('缺省密钥来自 butler.json 的 token', () => {
    delete process.env.BUTLER_PREVIEW_SECRET;
    const { loadConfig } = require('../server/config.cjs');
    expect(loadConfig().token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPreviewToken(signPreviewToken('abc', 2), 'abc')).toEqual({ ok: true, version: 2 });
    process.env.BUTLER_PREVIEW_SECRET = 'test-secret';
  });
});
