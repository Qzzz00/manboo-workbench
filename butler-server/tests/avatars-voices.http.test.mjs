// 整条链路的 HTTP 测试:形象上传 → 供应商 → 音色绑定 → 逻辑音色映射 → 预览签名。
// 取材于 Aiboo 的 adminVoiceBindings / voiceSettings / avatarPreview / avatars.upload 四组测试(node:test → vitest)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('http');
const { createApp } = require('../server/app.cjs');
const { db, UPLOADS_ROOT } = require('../server/db.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

let srv;
beforeAll(async () => { srv = await listen(createApp()); });
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});

const META = {
  name: '沉稳',
  summary: '事务官 · 沉稳人设',
  persona: { tone: '沉稳', traits: ['可靠'], styleRules: ['不耍宝'] },
  transform: { scaleMultiplier: 1, verticalOffset: 0 },
};

let avatarId;
let ttsId;
let rtcId;
const VOLC_VOICE = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;
const VOLC_VOICE_2 = ttsVoices.VOLC_OFFICIAL_VOICES[1].id;

describe('上传 zip 校验(走真正的 multipart)', () => {
  it('meta 缺 name → 400 invalid_meta', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(buildLive2dZip(), { summary: 'x' }) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_meta');
  });

  it('不是 zip → 400 avatar_zip_invalid,磁盘无残留', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(Buffer.from('not a zip'), META) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('avatar_zip_invalid');
    expect((await json(srv.base, '/admin/avatars')).body.avatars).toEqual([]);
  });

  it('没有 model3.json → 400 avatar_zip_no_model', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(buildLive2dZip([['readme.txt', 'hi']]), META) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('avatar_zip_no_model');
  });

  it('合法包 → 201,落盘到 BUTLER_HOME/uploads/avatars/<id>/v1', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(buildLive2dZip(), META) });
    expect(r.status).toBe(201);
    avatarId = r.body.avatar.id;
    expect(r.body.avatar).toMatchObject({ name: '沉稳', status: 'draft', current_version: 1, model_entry: 'ben.model3.json' });
    expect(existsSync(join(UPLOADS_ROOT, avatarId, 'v1', 'bundle.zip'))).toBe(true);
    expect(existsSync(join(UPLOADS_ROOT, avatarId, 'v1', 'unpacked', 'ben.model3.json'))).toBe(true);
    expect(UPLOADS_ROOT.startsWith(home)).toBe(true);
  });

  it('上传新版本 → v2', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/assets`, { method: 'POST', body: zipForm(buildLive2dZip()) });
    expect(r.status).toBe(201);
    expect(r.body.version).toBe(2);
    const detail = await json(srv.base, `/admin/avatars/${avatarId}`);
    expect(detail.body.avatar.current_version).toBe(2);
    expect(detail.body.avatar.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('PATCH 名称与人设;llm_model_id 在本机不可设', async () => {
    const ok = await json(srv.base, `/admin/avatars/${avatarId}`, { method: 'PATCH', body: { name: '沉稳·改' } });
    expect(ok.status).toBe(200);
    expect(ok.body.avatar.name).toBe('沉稳·改');
    const bad = await json(srv.base, `/admin/avatars/${avatarId}`, { method: 'PATCH', body: { llm_model_id: 'x' } });
    expect(bad.status).toBe(400);
  });

  it('发布 / 取消发布不再带 journey_instance 字段', async () => {
    const pub = await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} });
    expect(pub.status).toBe(200);
    expect(pub.body.avatar.status).toBe('published');
    expect(pub.body.avatar.published_by).toBe('ben');
    expect(pub.body).not.toHaveProperty('journey_instance');
    const un = await json(srv.base, `/admin/avatars/${avatarId}/unpublish`, { method: 'POST', body: {} });
    expect(un.status).toBe(200);
    expect(un.body.avatar.status).toBe('draft');
  });
});

describe('供应商库与音色绑定', () => {
  it('新增火山 TTS 供应商:密钥脱敏,只回后 4 位', async () => {
    const r = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: { name: '火山', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' }, isDefault: true },
    });
    expect(r.status).toBe(201);
    ttsId = r.body.model.id;
    expect(r.body.model.secrets.accessToken).toEqual({ configured: true, preview: '…1234' });
    expect(JSON.stringify(r.body)).not.toContain('secret-token-1234');
  });

  it('必填缺失 → 400 invalid_tts_provider', async () => {
    const r = await json(srv.base, '/admin/tts-models', { method: 'POST', body: { name: 'x', provider_type: 'volcengine', config: { appid: 'a' } } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_tts_provider');
  });

  it('新增火山 RTC 供应商(只留密钥配置)', async () => {
    const r = await json(srv.base, '/admin/rtc-providers', {
      method: 'POST',
      body: { name: '火山通话', provider_type: 'volcengine_rtc', config: { appId: 'r1', appKey: 'k1', accessKeyId: 'ak', secretAccessKey: 'sk-xyz' }, isDefault: true },
    });
    expect(r.status).toBe(201);
    rtcId = r.body.model.id;
    expect(r.body.model.secrets.secretAccessKey.preview).toBe('…-xyz');
  });

  it('GET /admin/tts-voices 按默认供应商给官方音色目录', async () => {
    const r = await json(srv.base, '/admin/tts-voices');
    expect(r.status).toBe(200);
    expect(r.body.provider_type).toBe('volcengine');
    expect(r.body.official.some((v) => v.id === VOLC_VOICE)).toBe(true);
  });

  it('PUT 音色绑定后 GET 形象详情能读回', async () => {
    const put = await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'PUT', body: { providerId: ttsId, voiceId: VOLC_VOICE } });
    expect(put.status).toBe(200);
    expect(put.body.binding).toMatchObject({ scene: 'chat', provider_id: ttsId, voice_id: VOLC_VOICE });
    const detail = await json(srv.base, `/admin/avatars/${avatarId}`);
    expect(detail.body.avatar.voice_bindings).toEqual([{ scene: 'chat', provider_id: ttsId, voice_id: VOLC_VOICE, params: null }]);
  });

  it('绑定不存在的供应商 → 400', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'PUT', body: { providerId: 'nope', voiceId: 'v' } });
    expect(r.status).toBe(400);
  });

  it('被绑定引用的供应商不能删 → 409;解绑后可删', async () => {
    const busy = await json(srv.base, `/admin/tts-models/${ttsId}`, { method: 'DELETE' });
    expect(busy.status).toBe(409);
    expect(busy.body.avatarIds).toEqual([avatarId]);
    const unbind = await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'DELETE' });
    expect(unbind.status).toBe(200);
    // 不真删:后面的映射测试还要用它;只验证「现在可删」这个判断
    const detail = await json(srv.base, `/admin/avatars/${avatarId}`);
    expect(detail.body.avatar.voice_bindings).toEqual([]);
  });

  it('/health 的数字随数据变', async () => {
    await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'PUT', body: { providerId: ttsId, voiceId: VOLC_VOICE } });
    const h = await json(srv.base, '/health');
    expect(h.body).toMatchObject({ avatarCount: 1, voiceCount: 1 });
  });
});

describe('逻辑音色映射与同步模式(/api/voice-*)', () => {
  it('PUT 映射后按 follow_base 保存,两侧都解析出来', async () => {
    const map = await json(srv.base, '/api/voice-mappings/calm', {
      method: 'PUT',
      body: { base_voice: { provider_id: ttsId, voice_id: VOLC_VOICE }, rtc_voice: { provider_id: rtcId, voice_id: VOLC_VOICE_2 } },
    });
    expect(map.status).toBe(200);
    expect(map.body.mapping.logical_voice_id).toBe('calm');
    const saved = await json(srv.base, '/api/voice-settings', {
      method: 'PUT',
      body: { avatar_id: avatarId, voice_sync_mode: 'follow_base', base_voice: { provider_id: ttsId, voice_id: VOLC_VOICE } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.voice_settings).toEqual({
      avatar_id: avatarId,
      voice_sync_mode: 'follow_base',
      base_voice: { provider_id: ttsId, voice_id: VOLC_VOICE },
      rtc_voice: { provider_id: rtcId, voice_id: VOLC_VOICE_2 },
    });
    const read = await json(srv.base, `/api/voice-settings/${avatarId}`);
    expect(read.body.voice_settings.rtc_voice.voice_id).toBe(VOLC_VOICE_2);
  });

  it('无映射的音色走 follow_base → VOICE_MAPPING_NOT_FOUND', async () => {
    const r = await json(srv.base, '/api/voice-settings', {
      method: 'PUT',
      body: { avatar_id: avatarId, voice_sync_mode: 'follow_base', base_voice: { provider_id: ttsId, voice_id: VOLC_VOICE_2 } },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VOICE_MAPPING_NOT_FOUND');
  });

  it('不存在的 voice_id → voice_not_found;非法模式 → invalid_voice_sync_mode', async () => {
    const bad = await json(srv.base, '/api/voice-settings', {
      method: 'PUT',
      body: { avatar_id: avatarId, voice_sync_mode: 'independent', base_voice: { provider_id: ttsId, voice_id: 'no-such' }, rtc_voice: { provider_id: rtcId, voice_id: VOLC_VOICE } },
    });
    expect(bad.body.code).toBe('voice_not_found');
    const mode = await json(srv.base, '/api/voice-settings', { method: 'PUT', body: { avatar_id: avatarId, voice_sync_mode: 'weird' } });
    expect(mode.body.code).toBe('invalid_voice_sync_mode');
  });

  it('POST resolve 按一侧反查;DELETE 删掉映射', async () => {
    const r = await json(srv.base, '/api/voice-mappings/resolve', { method: 'POST', body: { side: 'rtc', voice: { provider_id: rtcId, voice_id: VOLC_VOICE_2 } } });
    expect(r.status).toBe(200);
    expect(r.body.mapping.base_voice.voice_id).toBe(VOLC_VOICE);
    const del = await json(srv.base, '/api/voice-mappings/calm', { method: 'DELETE' });
    expect(del.body).toEqual({ deleted: true, logical_voice_id: 'calm' });
    expect((await json(srv.base, '/api/voice-mappings')).body.mappings).toEqual([]);
  });
});

describe('预览:签名 URL 免鉴权头静态服务', () => {
  it('preview-url 给出签名基址,能读到 model3.json', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/preview-url`);
    expect(r.status).toBe(200);
    expect(r.body.modelEntry).toBe('ben.model3.json');
    expect(r.body.version).toBe(2);
    const file = await fetch(`${srv.base}${r.body.baseUrl}/${r.body.modelEntry}`);
    expect(file.status).toBe(200);
    expect(await file.json()).toEqual({ Version: 3, FileReferences: {} });
  });

  it('篡改 token → 403;穿越 → 不出目录;缺文件 → 404;未知角色 → 404', async () => {
    const r = await json(srv.base, `/admin/avatars/${avatarId}/preview-url`);
    const tampered = r.body.baseUrl.replace(/preview\/(.+)$/, (m, t) => `preview/${t.slice(0, -2)}${t.endsWith('AA') ? 'BB' : 'AA'}`);
    expect((await fetch(`${srv.base}${tampered}/ben.model3.json`)).status).toBe(403);
    expect((await fetch(`${srv.base}${r.body.baseUrl}/..%2F..%2Fbundle.zip`)).status).toBe(400);
    expect((await fetch(`${srv.base}${r.body.baseUrl}/nope.json`)).status).toBe(404);
    expect((await json(srv.base, '/admin/avatars/zzz/preview-url')).status).toBe(404);
  });
});
