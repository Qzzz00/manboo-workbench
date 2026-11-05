// 电话里换音色(2026-09-23,Ben:「你的声音太像豆包了,我要换一个」)。
//
// 这一组钉的是两件事:
//   ① 换完**当场生效** —— /health 的 voice 与 /api/voices 的 current 立刻变成新的那一个。
//      它们读的是同一个 resolveVoice,所以这一条也顺带钉住「不存第二份音色配置」。
//   ② 换不成就如实说 —— 供应商没配、音色 id 不认识,一律 4xx/503 带人话,**不假装换好了**。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('call-voice');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

/** 目录里第二个音色 —— 第一个正好是默认那个,换成它看不出有没有真换。 */
const OTHER = ttsVoices.VOLC_OFFICIAL_VOICES.find(v => v.id !== ttsVoices.DEFAULT_VOLC_VOICE);

let srv;

beforeAll(async () => { srv = await listen(createApp()); });
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});

describe('GET /api/voices 与 PUT /api/voices/current', () => {
  it('★一个供应商都没配:两条都 503 + 人话,不给一张假的音色单', async () => {
    const list = await json(srv.base, '/api/voices');
    expect(list.status).toBe(503);
    // 2026-09-23:说的是「服务器还没下发 / 她开不了口」,不再让新用户以为要自己去设置里填。
    expect(list.body.error).toContain('她暂时开不了口');

    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: OTHER.id } });
    expect(put.status).toBe(503);
  });

  it('★配好供应商:列得出音色,current 是供应商默认那一个(还没换过)', async () => {
    const tts = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: {
        name: '火山',
        provider_type: 'volcengine',
        config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' },
        isDefault: true,
      },
    });
    expect(tts.status).toBe(201);

    const list = await json(srv.base, '/api/voices');
    expect(list.status).toBe(200);
    expect(list.body.provider_type).toBe('volcengine');
    expect(list.body.voices.length).toBeGreaterThan(2);
    expect(list.body.current.id).toBe(ttsVoices.DEFAULT_VOLC_VOICE);
    expect(list.body.current.source).toBe('fallback');
  });

  it('★换一个:PUT 之后 current 与 /health 的 voice 当场都是新的那一个', async () => {
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: OTHER.id } });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.voice.id).toBe(OTHER.id);
    // 目录里有名字就带上 —— 电话里念给他听的是名字,不是 id。
    expect(put.body.voice.name).toBe(OTHER.name);
    // 这一条是「当场生效」的证据:绑定行真的被读到了,不再是 fallback。
    expect(put.body.voice.source).toBe('binding');

    expect((await json(srv.base, '/api/voices')).body.current.id).toBe(OTHER.id);
    // /health 读的是同一个 resolveVoice —— 手机拿它当缓冲语的缓存键。
    expect((await json(srv.base, '/health')).body.voice).toBe(OTHER.id);
  });

  it('★这个供应商没有的音色:400 + 人话,绑定一个字没动', async () => {
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: '豆包那个' } });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain('没有');
    expect((await json(srv.base, '/api/voices')).body.current.id).toBe(OTHER.id);
  });

  it('voice_id 空的:400,不当成「换回默认」', async () => {
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: '  ' } });
    expect(put.status).toBe(400);
    expect((await json(srv.base, '/api/voices')).body.current.id).toBe(OTHER.id);
  });

  it('密钥一个字符都不出口', async () => {
    const list = await json(srv.base, '/api/voices');
    expect(JSON.stringify(list.body)).not.toContain('secret-token-1234');
  });
});
