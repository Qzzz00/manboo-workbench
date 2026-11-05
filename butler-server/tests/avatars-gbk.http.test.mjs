// Windows(GBK 条目名)Live2D 包的整条链路:上传 → 预览 URL 编码往返 → 静态路由越界 → 重新解压修旧版。
// 背景:2026-09-16 真机上传的包条目名是 GBK 且无 UTF-8 标志位,旧逻辑解出乱码,预览「模型加载失败」。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('gbk');
const { createApp } = require('../server/app.cjs');
const { db, UPLOADS_ROOT } = require('../server/db.cjs');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

let srv;
beforeAll(async () => { srv = await listen(createApp()); });
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});

const META = { name: '事务官', summary: 'Windows 包', persona: {}, transform: {} };
const MODEL_NAME = '爱伶Rin.model3.json';
const TEXTURE = '爱伶Rin.4096/texture_00.png';
const MODEL_JSON = JSON.stringify({
  Version: 3,
  FileReferences: { Moc: '爱伶Rin.moc3', Textures: [TEXTURE], Expressions: [{ Name: '害羞', File: '害羞.exp3.json' }] },
});

function buildGbkZip(entries) {
  const decoder = { encode: (s) => iconv.encode(s, 'gbk'), decode: (b) => iconv.decode(b, 'gbk'), efs: false };
  const zip = new AdmZip(null, { decoder });
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}
const GBK_ZIP = buildGbkZip([
  [MODEL_NAME, MODEL_JSON],
  ['爱伶Rin.moc3', 'moc'],
  [TEXTURE, 'png'],
  ['害羞.exp3.json', '{}'],
  ['【雪熊企划】黑客少女.png', 'png'],
]);

const hasGarbage = (dir) => readdirSync(dir, { recursive: true }).some((n) => String(n).includes('�'));

let avatarId;

describe('Windows GBK 包上传与预览', () => {
  it('上传 GBK 包 → 201,model_entry 与磁盘文件名都是正确中文', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(GBK_ZIP, META) });
    expect(r.status).toBe(201);
    avatarId = r.body.avatar.id;
    expect(r.body.avatar.model_entry).toBe(MODEL_NAME);
    const unpacked = join(UPLOADS_ROOT, avatarId, 'v1', 'unpacked');
    expect(existsSync(join(unpacked, MODEL_NAME))).toBe(true);
    expect(existsSync(join(unpacked, TEXTURE))).toBe(true);
    expect(existsSync(join(unpacked, '【雪熊企划】黑客少女.png'))).toBe(true);
    expect(hasGarbage(unpacked)).toBe(false);
  });

  it('preview-url:modelEntry 是原名,modelUrl 已按段 encodeURIComponent;两种写法都能取到文件', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/preview-url`);
    expect(r.status).toBe(200);
    expect(r.body.modelEntry).toBe(MODEL_NAME);
    expect(r.body.modelUrl).toBe(`${r.body.baseUrl}/${encodeURIComponent(MODEL_NAME)}`);
    expect(r.body.modelUrl).not.toMatch(/[^\x20-\x7e]/);
    const viaEncoded = await fetch(`${srv.base}${r.body.modelUrl}`);
    expect(viaEncoded.status).toBe(200);
    expect(JSON.parse(await viaEncoded.text()).FileReferences.Moc).toBe('爱伶Rin.moc3');
    // 贴图路径带子目录:逐段编码,斜杠保留
    const tex = await fetch(`${srv.base}${r.body.baseUrl}/${TEXTURE.split('/').map(encodeURIComponent).join('/')}`);
    expect(tex.status).toBe(200);
    expect(await tex.text()).toBe('png');
    // 浏览器把相对引用里的中文自动 percent-encode,等价于上面;全角括号也一样
    const full = await fetch(`${srv.base}${r.body.baseUrl}/${encodeURIComponent('【雪熊企划】黑客少女.png')}`);
    expect(full.status).toBe(200);
  });

  it('静态路由:编码过的 .. 越界 → 400,不出 unpacked 目录', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/preview-url`);
    // (fetch 会把 %2E%2E 归一成 .. 并在客户端就解析掉,到不了路由,所以不列这一种)
    for (const evil of ['..%2F..%2Fbundle.zip', 'a/..%2F..%2Fbundle.zip', '..%5Cbundle.zip', 'a%2F%2Fb.png']) {
      const res = await fetch(`${srv.base}${r.body.baseUrl}/${evil}`);
      expect(res.status, evil).toBe(400);
      expect((await res.json()).code).toBe('preview_path_invalid');
    }
    expect((await fetch(`${srv.base}${r.body.baseUrl}/${encodeURIComponent('没有.json')}`)).status).toBe(404);
  });
});

describe('POST /admin/avatars/:id/assets/:version/reextract 修已上传的乱码版本', () => {
  it('把 v1 弄成旧逻辑的样子(乱码文件名 + 乱码 model_entry),重新解压后恢复正确', async () => {
    const unpacked = join(UPLOADS_ROOT, avatarId, 'v1', 'unpacked');
    const garbage = iconv.encode(MODEL_NAME, 'gbk').toString('utf8'); // 与旧 adm-zip entryName 同款 U+FFFD 乱码
    renameSync(join(unpacked, MODEL_NAME), join(unpacked, garbage));
    db.prepare('UPDATE avatars SET model_entry = ? WHERE id = ?').run(garbage, avatarId);
    expect((await json(srv.base, `/admin/avatars/${avatarId}`)).body.avatar.model_entry).toContain('�');

    const r = await json(srv.base, `/admin/avatars/${avatarId}/assets/1/reextract`, { method: 'POST', body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, model_entry: MODEL_NAME, current: true });
    expect(r.body.extracted_files).toBe(5);
    expect(existsSync(join(unpacked, MODEL_NAME))).toBe(true);
    expect(existsSync(join(unpacked, garbage))).toBe(false);
    expect(hasGarbage(unpacked)).toBe(false);
    // 只剩 bundle.zip + unpacked,不留 tmp/old 目录
    expect(readdirSync(join(UPLOADS_ROOT, avatarId, 'v1')).sort()).toEqual(['bundle.zip', 'unpacked']);
    const detail = await json(srv.base, `/admin/avatars/${avatarId}`);
    expect(detail.body.avatar.model_entry).toBe(MODEL_NAME);
    const pv = await json(srv.base, `/admin/avatars/${avatarId}/preview-url`);
    expect((await fetch(`${srv.base}${pv.body.modelUrl}`)).status).toBe(200);
  });

  it('重新解压非当前版本:不改 avatars.model_entry', async () => {
    const up = await json(srv.base, `/admin/avatars/${avatarId}/assets`, { method: 'POST', body: zipForm(buildLive2dZip()) });
    expect(up.status).toBe(201);
    expect(up.body.version).toBe(2);
    const r = await json(srv.base, `/admin/avatars/${avatarId}/assets/1/reextract`, { method: 'POST', body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, model_entry: MODEL_NAME, current: false });
    expect((await json(srv.base, `/admin/avatars/${avatarId}`)).body.avatar.model_entry).toBe('ben.model3.json');
  });

  it('版本不存在 → 404;版本号非法 → 400;角色不存在 → 404', async () => {
    expect((await json(srv.base, `/admin/avatars/${avatarId}/assets/9/reextract`, { method: 'POST', body: {} })).body.code).toBe('asset_version_not_found');
    expect((await json(srv.base, `/admin/avatars/${avatarId}/assets/abc/reextract`, { method: 'POST', body: {} })).status).toBe(400);
    expect((await json(srv.base, `/admin/avatars/${avatarId}/assets/0/reextract`, { method: 'POST', body: {} })).status).toBe(400);
    expect((await json(srv.base, `/admin/avatars/zzz/assets/1/reextract`, { method: 'POST', body: {} })).status).toBe(404);
  });
});
