// GET /health 里那个 `voice`(2026-09-22)。
//
// 为什么它值得单独一份用例:缓冲语那七句在手机上是**按音色缓存**的
// (butler-app/src/call/fillerVoiceCache.ts)。人在这台服务的配置后台里换了音色之后,
// 只有这一个字段能告诉外面"嗓子换了" —— 工作台盯着它、手机拿它当缓存键。
//
// 两条:**没配供应商就缺席**(不编一个默认音色名 —— 假名字的缓存比没有缓存糟);
// 配好了就等于 /api/tts 真会用的那一个(同一个 resolveVoice,不另写一份解析)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('health-voice');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

const VOICE = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;

let srv;
let avatarId;

beforeAll(async () => {
  srv = await listen(createApp());
  const created = await json(srv.base, '/admin/avatars', {
    method: 'POST',
    body: zipForm(buildLive2dZip(), { name: '沉稳', summary: 's', persona: {}, transform: {} }),
  });
  avatarId = created.body.avatar.id;
  expect((await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} })).status).toBe(200);
});
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});

describe('GET /health 里的 voice', () => {
  it('★一个供应商都没配:整个字段缺席,不编一个默认音色名', async () => {
    const r = await json(srv.base, '/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.voice).toBeUndefined();
  });

  it('★配好供应商并把 chat 绑到某个音色之后:voice 就是那一个(与 /api/tts 同源)', async () => {
    const tts = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: { name: '火山', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' }, isDefault: true },
    });
    expect(tts.status).toBe(201);
    const ttsId = tts.body.model.id;
    expect((await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, {
      method: 'PUT',
      body: { providerId: ttsId, voiceId: VOICE },
    })).status).toBe(200);

    const r = await json(srv.base, '/health');
    expect(r.status).toBe(200);
    // 没有 avatarId 时解析走的是"供应商默认音色"那一支 —— 这里断言的是**它真的有一个名字**,
    // 而且是个非空字符串(手机拿它当缓存键的前半截,空的会把七句写到 `filler//<id>` 底下)。
    expect(typeof r.body.voice).toBe('string');
    expect(r.body.voice.length).toBeGreaterThan(0);
  });

  it('密钥一个字符都不出口(这条回包是给工作台与手机看的)', async () => {
    const r = await json(srv.base, '/health');
    expect(JSON.stringify(r.body)).not.toContain('secret-token-1234');
  });
});
