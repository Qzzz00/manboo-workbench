// 换音色之前**先拿一句中文试合一次**(2026-09-28,卡 VC)。
//
// 真机那一晚(维护者本机 19:2x):电话里一路「换」下去 → 爽朗少年 → 小何 → 小天 →
// 「只要女生的再换」→ 工人换成了英文女声 **Dacey**,后来又到 **Stokie**。从那一刻起
// 每一句中文都是 `volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language`,
// 开场白预合成 10 趟全失败,他打过去**一直没声音**,以为 TTS 坏了。
//
// 这一组钉三件:
//   ① /api/voices 每条带 `speaks_chinese` —— 工人靠它把英文音色挡在推荐之外;
//   ② PUT /api/voices/current 换一个「不确定会不会念中文」的音色之前,**真合一句中文**;
//      回 3011 就 **400 不换**,current 一个字没动,并且话里说得出为什么;
//   ③ 别的原因(太挤 / 网慢)**不拦** —— 那不是语种的事,拦了等于凭空少半张表。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('call-voice-language');
// 实取那一份**先摆一份新鲜的**:否则每次 GET /api/voices 都会在后台把 99 条音色挨个试合一遍,
// 而这一组正把 synthesize 换成了假的 —— 那 99 趟会混进我们数的那几趟里。
process.env.VOICE_AVAILABILITY_FILE = join(home, 'voice-availability.json');
const catalog = require('../server/services/voices-catalog.json');
writeFileSync(process.env.VOICE_AVAILABILITY_FILE, `${JSON.stringify({
  provider_type: 'volcengine',
  fetched_at: new Date().toISOString(),
  method: 'probe',
  voices: Object.fromEntries(catalog.voices.map(v => [v.id, { ok: true }])),
})}\n`);
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsSynthesizer = require('../server/services/ttsSynthesizer.cjs');

/** 真机换到的那个英文女声 —— 这张卡就是它换来的。 */
const ENGLISH = 'en_female_stokie_uranus_bigtts';
/** 中文默认那个。 */
const CHINESE = 'zh_female_vv_uranus_bigtts';
/** 另一个中文音色(换过去看得出有没有真换)。 */
const OTHER_CHINESE = 'saturn_zh_female_cancan_tob';

const originalSynthesize = ttsSynthesizer.synthesize;
let srv;

beforeAll(async () => {
  srv = await listen(createApp());
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
});

afterEach(() => {
  ttsSynthesizer.synthesize = originalSynthesize;
});

afterAll(async () => {
  ttsSynthesizer.synthesize = originalSynthesize;
  await srv.close();
  db.close();
  cleanupHome(home);
});

describe('GET /api/voices 带「会不会念中文」', () => {
  it('★三个英文音色标着 speaks_chinese:false,中文的标 true', async () => {
    const list = await json(srv.base, '/api/voices');
    expect(list.status).toBe(200);
    const byId = new Map(list.body.voices.map(v => [v.id, v]));
    expect(byId.get(ENGLISH).speaks_chinese).toBe(false);
    expect(byId.get('en_female_dacey_uranus_bigtts').speaks_chinese).toBe(false);
    expect(byId.get(CHINESE).speaks_chinese).toBe(true);
    // 现在用的那一个也带这一格 —— 兜底那一头要拿它判「现在这个嗓子靠不靠得住」。
    expect(list.body.current.speaks_chinese).toBe(true);
  });
});

describe('PUT /api/voices/current 换之前先试一句中文', () => {
  it('★英文音色:合中文回 3011 → 400 不换,current 还是原来那个', async () => {
    const calls = [];
    ttsSynthesizer.synthesize = async (args) => {
      calls.push(args);
      throw new Error('volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language');
    };
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: ENGLISH } });
    expect(put.status).toBe(400);
    expect(put.body.code).toBe('voice_cannot_speak_chinese');
    expect(put.body.error).toContain('念不了中文');
    // 试的**是一句中文**,不是英文探针 —— 问的就是「你念不念中文」。
    expect(calls).toHaveLength(1);
    expect(/[一-龥]/.test(calls[0].text)).toBe(true);
    expect((await json(srv.base, '/api/voices')).body.current.id).toBe(CHINESE);
  });

  it('★中文音色:不白试那一句(目录里就写着会念),照换', async () => {
    let tried = 0;
    ttsSynthesizer.synthesize = async () => { tried += 1; return { buffer: Buffer.from([1]), contentType: 'audio/pcm' }; };
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: OTHER_CHINESE } });
    expect(put.status).toBe(200);
    expect(put.body.voice.id).toBe(OTHER_CHINESE);
    expect(tried).toBe(0);
  });

  it('★别的原因(太挤)不拦:照换,不许把「这会儿忙」说成「念不了中文」', async () => {
    ttsSynthesizer.synthesize = async () => {
      throw new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency');
    };
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: ENGLISH } });
    expect(put.status).toBe(200);
    expect(put.body.voice.id).toBe(ENGLISH);
    // 收拾干净:换回中文那个,别把后面的用例架在英文嗓子上。
    ttsSynthesizer.synthesize = originalSynthesize;
    expect((await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: CHINESE } })).status).toBe(200);
  });

  it('★试出来能念中文的英文音色照换(目录可能过时,实测说话)', async () => {
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([2, 2]), contentType: 'audio/pcm' });
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: ENGLISH } });
    expect(put.status).toBe(200);
    expect(put.body.voice.id).toBe(ENGLISH);
    ttsSynthesizer.synthesize = originalSynthesize;
    expect((await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: CHINESE } })).status).toBe(200);
  });
});
