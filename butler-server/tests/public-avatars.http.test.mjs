// 手机拿形象的公开接口(2026-09-14,材料第 7 节第 5 项第二刀):
//   GET /api/avatars              只回已发布的形象
//   GET /api/avatars/:id          详情,含 model_entry
//   GET /api/avatars/:id/bundle.zip  已发布版本的 Live2D 包;路径不越出 uploads 根
// 鉴权仍是 adminAuth(回环或 X-Workbench-Token);绝对 URL 按 X-Forwarded-* 生成,手机从 8791 的 /butler/proxy 进来时才对。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('public-avatars');
const { createApp } = require('../server/app.cjs');
const { db, UPLOADS_BASE } = require('../server/db.cjs');
const { loadConfig } = require('../server/config.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

let srv;
beforeAll(async () => { srv = await listen(createApp()); });
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});

const META = {
  name: '周到',
  summary: '事务官 · 周到人设',
  persona: { tone: '周到', traits: ['体贴'] },
  transform: { scaleMultiplier: 1.1, verticalOffset: 0.05 },
};

const ZIP = buildLive2dZip();
let avatarId;
let draftId;
let ttsId;

async function upload(meta) {
  const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(ZIP, meta) });
  expect(r.status).toBe(201);
  return r.body.avatar.id;
}

describe('GET /api/avatars 只回已发布', () => {
  it('草稿不出现;发布后出现,带封面/包/音色字段', async () => {
    avatarId = await upload(META);
    draftId = await upload({ ...META, name: '草稿' });
    expect((await json(srv.base, '/api/avatars')).body.avatars).toEqual([]);

    // 绑一个音色再发布:列表要能看到「绑定的音色」。
    const tts = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: { name: '火山', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' }, isDefault: true },
    });
    ttsId = tts.body.model.id;
    const voice = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;
    expect((await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'PUT', body: { providerId: ttsId, voiceId: voice } })).status).toBe(200);
    expect((await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} })).status).toBe(200);

    const r = await json(srv.base, '/api/avatars');
    expect(r.status).toBe(200);
    expect(r.body.avatars).toHaveLength(1);
    const item = r.body.avatars[0];
    expect(item).toMatchObject({
      id: avatarId,
      name: '周到',
      summary: '事务官 · 周到人设',
      persona: { tone: '周到', traits: ['体贴'] },
      version: 1,
      bundle_url: `${srv.base}/api/avatars/${avatarId}/bundle.zip`,
      voice: { scene: 'chat', provider_type: 'volcengine', voice_id: voice },
    });
    expect(item.cover_url).toBeNull();
    expect(typeof item.checksum).toBe('string');
    // 列表里绝不带密钥、绝不带 llm/DJ 之类内部字段。
    expect(JSON.stringify(r.body)).not.toContain('secret-token');
    expect(item).not.toHaveProperty('llm_model_id');
    expect(item).not.toHaveProperty('status');
  });

  it('绝对 URL 按 X-Forwarded-Host / X-Forwarded-Prefix 生成(手机经 8791 代理进来)', async () => {
    const r = await json(srv.base, '/api/avatars', {
      headers: { 'x-forwarded-host': '10.86.37.27:8791', 'x-forwarded-proto': 'http', 'x-forwarded-prefix': '/butler/proxy' },
    });
    expect(r.body.avatars[0].bundle_url).toBe(`http://10.86.37.27:8791/butler/proxy/api/avatars/${avatarId}/bundle.zip`);
  });

  it('PUBLIC_BASE_URL 设了就以它为准', async () => {
    process.env.PUBLIC_BASE_URL = 'http://mac.local:8791/butler/proxy/';
    try {
      const r = await json(srv.base, '/api/avatars', { headers: { 'x-forwarded-host': '10.86.37.27:8791' } });
      expect(r.body.avatars[0].bundle_url).toBe(`http://mac.local:8791/butler/proxy/api/avatars/${avatarId}/bundle.zip`);
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  it('上传时存成 127.0.0.1:8792 的头像/背景地址,公开接口按请求来源重写', async () => {
    db.prepare('UPDATE avatars SET portrait_url = ?, default_background = ? WHERE id = ?')
      .run(`${srv.base}/uploads/portraits/p.png`, `${srv.base}/uploads/backgrounds/b.jpg`, avatarId);
    const r = await json(srv.base, '/api/avatars', {
      headers: { 'x-forwarded-host': '10.86.37.27:8791', 'x-forwarded-prefix': '/butler/proxy' },
    });
    expect(r.body.avatars[0].cover_url).toBe('http://10.86.37.27:8791/butler/proxy/uploads/portraits/p.png');
    const d = await json(srv.base, `/api/avatars/${avatarId}`, {
      headers: { 'x-forwarded-host': '10.86.37.27:8791', 'x-forwarded-prefix': '/butler/proxy' },
    });
    expect(d.body.avatar.portrait_url).toBe('http://10.86.37.27:8791/butler/proxy/uploads/portraits/p.png');
    expect(d.body.avatar.default_background).toBe('http://10.86.37.27:8791/butler/proxy/uploads/backgrounds/b.jpg');
  });
});

describe('GET /api/avatars/:id', () => {
  it('已发布 → 详情含 model_entry / transform / persona / 音色绑定', async () => {
    const r = await json(srv.base, `/api/avatars/${avatarId}`);
    expect(r.status).toBe(200);
    expect(r.body.avatar).toMatchObject({
      id: avatarId,
      model_entry: 'ben.model3.json',
      version: 1,
      transform: { scaleMultiplier: 1.1, verticalOffset: 0.05 },
      persona: { tone: '周到' },
      bundle_url: `${srv.base}/api/avatars/${avatarId}/bundle.zip`,
    });
    expect(r.body.avatar.voice).toMatchObject({ scene: 'chat', provider_type: 'volcengine' });
    expect(r.body.avatar).not.toHaveProperty('llm_model_id');
  });

  it('草稿 / 不存在 → 404 avatar_not_found(不区分)', async () => {
    expect((await json(srv.base, `/api/avatars/${draftId}`)).status).toBe(404);
    expect((await json(srv.base, `/api/avatars/${draftId}`)).body.code).toBe('avatar_not_found');
    expect((await json(srv.base, '/api/avatars/nope')).status).toBe(404);
  });
});

describe('GET /api/avatars/:id/bundle.zip', () => {
  it('回上传的那份 zip,带 ETag 与 Range 支持', async () => {
    const res = await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(ZIP)).toBe(true);

    const part = await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(ZIP.subarray(0, 4))).toBe(true);
  });

  it('草稿的包拿不到 → 404', async () => {
    expect((await fetch(`${srv.base}/api/avatars/${draftId}/bundle.zip`)).status).toBe(404);
  });

  it('zip_path 越出 uploads 根 → 404,不读文件', async () => {
    const outside = join(home, 'outside.zip');
    writeFileSync(outside, ZIP);
    db.prepare('UPDATE avatar_assets SET zip_path = ? WHERE avatar_id = ? AND version = 1').run('../../outside.zip', avatarId);
    expect((await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`)).status).toBe(404);
    // 绝对路径同样拒绝。
    db.prepare('UPDATE avatar_assets SET zip_path = ? WHERE avatar_id = ? AND version = 1').run(outside, avatarId);
    expect((await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`)).status).toBe(404);
    db.prepare('UPDATE avatar_assets SET zip_path = ? WHERE avatar_id = ? AND version = 1').run(`${avatarId}/v1/bundle.zip`, avatarId);
    expect((await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`)).status).toBe(200);
  });

  it('取消发布后列表空、包 404', async () => {
    expect((await json(srv.base, `/admin/avatars/${avatarId}/unpublish`, { method: 'POST', body: {} })).status).toBe(200);
    expect((await json(srv.base, '/api/avatars')).body.avatars).toEqual([]);
    expect((await fetch(`${srv.base}/api/avatars/${avatarId}/bundle.zip`)).status).toBe(404);
  });
});

describe('鉴权与 uploads 根', () => {
  it('公开接口同样走 adminAuth:错令牌 403', async () => {
    const r = await json(srv.base, '/api/avatars', { headers: { 'x-workbench-token': 'deadbeef' } });
    expect(r.status).toBe(403);
    const ok = await json(srv.base, '/api/avatars', { headers: { 'x-workbench-token': loadConfig().token } });
    expect(ok.status).toBe(200);
  });

  it('/uploads/portraits 静态文件能拿到(手机头像走这里)', async () => {
    mkdirSync(join(UPLOADS_BASE, 'portraits'), { recursive: true });
    writeFileSync(join(UPLOADS_BASE, 'portraits', 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await fetch(`${srv.base}/uploads/portraits/p.png`);
    expect(res.status).toBe(200);
  });
});
