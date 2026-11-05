// 音色目录带描述 + 样音缓存 + 「他挑过的 / 不要的」(2026-09-23 第二版)。
//
// Ben 那一通:她念了知性灿灿 / 可爱女生 / 调皮公主,他说 **「怎么都是女的」**。
// 病根在这一层 —— `GET /api/voices` 回的每条只有 id 和名字,调用方只能按顺序取前三个。
//
// 这一组钉四件:
//   ① 每条带**性别 / 年龄感 / 风格 / 语言口音 / 一句人话**,推不出来的写「未标」,**不编**;
//   ② 男女都有(库里远不止三个女声)—— 这一条直接对着他那句话;
//   ③ 样音**合一次落盘**,第二次不再碰上游;`/api/tts/stream` 也从同一份盘上走;
//   ④ 他挑过的 / 念过他没要的记得住;**试听(preview)不算他挑过**。
//
// 上游(火山)全部打桩,不联网、不碰密钥。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('voice-catalog');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');
const ttsSynthesizer = require('../server/services/ttsSynthesizer.cjs');
const volcTtsStream = require('../server/services/volcTtsStream.cjs');
const voiceSampleCache = require('../server/services/voiceSampleCache.cjs');
const ttsStreamRoute = require('../server/routes/api/ttsStream.cjs');

const { FRAME_AUDIO, FRAME_END } = ttsStreamRoute;

let srv;
let synthCalls = 0;
const originalSynthesize = ttsSynthesizer.synthesize;
const originalStream = volcTtsStream.streamSynthesize;

/** 两个真实存在的火山音色:一男一女,用来验「男女都在目录里」。 */
const MALE = 'zh_male_gaolengchenwen_uranus_bigtts';
const FEMALE = 'zh_female_cancan_uranus_bigtts';

beforeAll(async () => {
  srv = await listen(createApp());
  const p = await json(srv.base, '/admin/tts-models', {
    method: 'POST',
    body: {
      name: '火山',
      provider_type: 'volcengine',
      config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' },
      isDefault: true,
    },
  });
  expect(p.status).toBe(201);
  // 上游打桩:回一段固定的「PCM」。每调一次记一笔 —— 缓存有没有生效全看这个数。
  ttsSynthesizer.synthesize = async ({ voice, encoding }) => {
    synthCalls += 1;
    return { buffer: Buffer.from(`pcm-${voice}-${encoding}`), contentType: 'audio/pcm' };
  };
  // 流式那条永远失败 → 走非流式回退,这一组关心的是缓存,不是流式本身。
  volcTtsStream.streamSynthesize = async () => { throw new Error('这一组不测流式'); };
});

afterAll(async () => {
  ttsSynthesizer.synthesize = originalSynthesize;
  volcTtsStream.streamSynthesize = originalStream;
  await srv.close();
  db.close();
  cleanupHome(home);
});

// ———————————————————— ① ② 目录带描述 ————————————————————

describe('GET /api/voices:每条带标签与一句人话', () => {
  it('★每条都有性别 / 年龄感 / 风格 / 口音 / 一句人话,一格都不缺', async () => {
    const { status, body } = await json(srv.base, '/api/voices');
    expect(status).toBe(200);
    expect(body.voices.length).toBeGreaterThan(50);
    for (const one of body.voices) {
      expect(typeof one.gender).toBe('string');
      expect(typeof one.age).toBe('string');
      expect(Array.isArray(one.styles)).toBe(true);
      expect(typeof one.accent).toBe('string');
      expect(typeof one.blurb).toBe('string');
      expect(one.blurb.length).toBeGreaterThan(0);
      expect(one.verified).toBe(true);
    }
  });

  it('★男女都有 —— Ben「怎么都是女的」那一句的正面反证', async () => {
    const { body } = await json(srv.base, '/api/voices');
    const male = body.voices.filter(one => one.gender === '男');
    const female = body.voices.filter(one => one.gender === '女');
    expect(male.length).toBeGreaterThan(10);
    expect(female.length).toBeGreaterThan(10);
    expect(body.voices.find(one => one.id === MALE).gender).toBe('男');
    expect(body.voices.find(one => one.id === FEMALE).gender).toBe('女');
  });

  it('★推不出来的写「未标」,**不编一个「温柔知性」**', async () => {
    const { body } = await json(srv.base, '/api/voices');
    const untagged = body.voices.filter(one => one.age === '未标');
    expect(untagged.length).toBeGreaterThan(0);
    // 「未标」也得有一句人话 —— 她在电话里照样得说得出口。
    expect(untagged[0].blurb).toContain('没标');
    // 标签是怎么来的,一并交出去:她被追问时说得出实话。
    expect(body.tagging).toContain('没有人逐个听过');
  });

  it('★沉稳的男声查得到(「沉稳一点的男声」这句话挑得动人)', async () => {
    const { body } = await json(srv.base, '/api/voices');
    const hit = body.voices.filter(one => one.gender === '男' && one.styles.includes('沉稳'));
    expect(hit.length).toBeGreaterThan(1);
  });

  it('样音那一句跟着清单一起给 —— 工人照抄,缓存才命中得了', async () => {
    const { body } = await json(srv.base, '/api/voices');
    expect(body.sample_text).toBe(voiceSampleCache.SAMPLE_TEXT);
  });

  it('密钥一个字符都不出口', async () => {
    const { body } = await json(srv.base, '/api/voices');
    expect(JSON.stringify(body)).not.toContain('secret-token-1234');
  });
});

// ———————————————————— ④ 他挑过的 / 不要的 ————————————————————

describe('他挑过的 / 念过他没要的', () => {
  it('★试听(preview)照换不误,但**不记成「他挑过」**', async () => {
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: MALE, preview: true } });
    expect(put.status).toBe(200);
    // 换是真换了 —— 不换他就听不见。
    expect((await json(srv.base, '/health')).body.voice).toBe(MALE);
    expect(put.body.history.picked).not.toContain(MALE);
  });

  it('★他真挑定了才记一笔', async () => {
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: FEMALE } });
    expect(put.status).toBe(200);
    expect(put.body.history.picked).toContain(FEMALE);
    expect((await json(srv.base, '/api/voices')).body.history.picked).toContain(FEMALE);
  });

  it('★念过他没要的记下来,下次挑的时候好避开', async () => {
    const r = await json(srv.base, '/api/voices/passed', { method: 'POST', body: { voice_ids: [MALE, ' ', MALE] } });
    expect(r.status).toBe(200);
    expect(r.body.history.passed).toEqual([MALE]);
  });

  it('他挑过的不会因为一次「听听下一个」被记成不要的', async () => {
    const r = await json(srv.base, '/api/voices/passed', { method: 'POST', body: { voice_ids: [FEMALE] } });
    expect(r.body.history.passed).not.toContain(FEMALE);
  });

  it('空清单:不炸,也不记', async () => {
    const r = await json(srv.base, '/api/voices/passed', { method: 'POST', body: {} });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.history.passed)).toBe(true);
  });
});

// ———————————————————— ③ 样音缓存 ————————————————————

describe('样音:合一次落盘,下次秒播', () => {
  it('★第一次要合成,第二次直接从盘上走(上游一次都不碰)', async () => {
    const before = synthCalls;
    const first = await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: MALE } });
    expect(first.status).toBe(200);
    expect(first.body.synthesized).toBe(true);
    expect(first.body.cached).toBe(true);
    expect(first.body.text).toBe(voiceSampleCache.SAMPLE_TEXT);
    expect(synthCalls).toBe(before + 1);

    const second = await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: MALE } });
    expect(second.body.synthesized).toBe(false);
    expect(second.body.cached).toBe(true);
    expect(synthCalls).toBe(before + 1);
  });

  it('★`/api/tts/stream` 播那一句时命中同一份缓存,一次上游都不跑', async () => {
    // 先把音色换到 MALE(上面那条样音就是它的),再让它播样音那一句。
    await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: MALE, preview: true } });
    const before = synthCalls;
    const res = await fetch(`${srv.base}/api/tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: voiceSampleCache.SAMPLE_TEXT }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tts-backend')).toBe('sample-cache');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.readUInt8(0)).toBe(FRAME_AUDIO);
    const len = buf.readUInt32BE(1);
    expect(buf.subarray(5, 5 + len).toString()).toBe(`pcm-${MALE}-pcm`);
    expect(buf.readUInt8(5 + len)).toBe(FRAME_END);
    expect(synthCalls).toBe(before);
  });

  it('★只缓存样音那一句 —— 别的话一个字节都不落盘', async () => {
    expect(voiceSampleCache.isSampleText(voiceSampleCache.SAMPLE_TEXT)).toBe(true);
    // 工人是按句合成的,半句也算(见 voiceSampleCache 文件头)。
    expect(voiceSampleCache.isSampleText('老板你好,我是你的事务官,')).toBe(true);
    expect(voiceSampleCache.isSampleText('登录页做到哪了')).toBe(false);
    expect(voiceSampleCache.write('volcengine', MALE, 'pcm', '登录页做到哪了', Buffer.from('x'))).toBe(false);
    expect(voiceSampleCache.read('volcengine', MALE, 'pcm', '登录页做到哪了')).toBeUndefined();
  });

  it('这个供应商没有的音色:400,不合成', async () => {
    const before = synthCalls;
    const r = await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: '豆包那个' } });
    expect(r.status).toBe(400);
    expect(synthCalls).toBe(before);
  });

  it('voice_id 空的:400', async () => {
    expect((await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: ' ' } })).status).toBe(400);
  });

  it('★合不出来不当成办砸了 —— 回 200 带一句实话,下一个照旧现合', async () => {
    const saved = ttsSynthesizer.synthesize;
    ttsSynthesizer.synthesize = async () => { throw new Error('上游 429'); };
    const other = ttsVoices.VOLC_OFFICIAL_VOICES.find(v => v.id !== MALE && v.id !== FEMALE).id;
    const r = await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: other } });
    ttsSynthesizer.synthesize = saved;
    expect(r.status).toBe(200);
    expect(r.body.synthesized).toBe(false);
    expect(r.body.cached).toBe(false);
    expect(r.body.note).toContain('429');
  });
});
