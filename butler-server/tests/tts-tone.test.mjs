// 语气跟着话走 —— **8792 这一头**(2026-10-02,卡「声音与形象跟着话走」第 2 件)。
//
// 这一组钉五件:
//   ① 映射放**配置**(services/toneMap.json),不写死;`BUTLER_TTS_TONE_MAP` 能整张换掉;
//   ② 认不得的语气 → **三格全缺席**,请求体与 10-01 逐字相同(「没有对应就退回中性」);
//   ③ V3(2.0 音色)请求体里真的拼上了 `audio_params.emotion` / `emotion_scale`
//      与 `req_params.additions` —— 而且 **additions 是一个 JSON 字符串**,不是对象;
//   ④ V1 那条路**只吃得到那个枚举**,那一句自然语言指令如实丢掉(V1 没有 context_texts);
//   ⑤ `/api/tts/stream` 把 body 里的 `tone` / `toneNote` 一路带到上游;
//      **她写的那句指令盖掉表里那句**。
//
// 上游(火山)全部打桩,不联网、不碰密钥。真的字段名与取值**没在真机上核过** ——
// 待真机核那一条写在 docs/交接-1002-语气跟着话走.md 与 toneMap.json 的 `unverified` 里。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('tts-tone');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsTone = require('../server/services/ttsTone.cjs');
const volcTtsStream = require('../server/services/volcTtsStream.cjs');
const volcengine = require('../server/services/volcengine.cjs');
const ttsStreamRoute = require('../server/routes/api/ttsStream.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const VOICE = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;
/** 一个一定会走 V3 的音色(`_tob` 后缀;与 needsV3Voice 同源)。 */
const V3_VOICE = 'zh_female_demo_tob';

let srv;
let avatarId;
const originalStream = volcTtsStream.streamSynthesize;

beforeAll(async () => {
  srv = await listen(createApp());
  const r = await json(srv.base, '/admin/avatars', {
    method: 'POST',
    body: zipForm(buildLive2dZip(), { name: '沉稳', summary: 's', persona: {}, transform: {} }),
  });
  avatarId = r.body.avatar.id;
  expect((await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} })).status).toBe(200);
  const p = await json(srv.base, '/admin/tts-models', {
    method: 'POST',
    body: { name: '火山', provider_type: 'volcengine', config: { appid: 'test-appid', accessToken: 'test-token', cluster: 'volcano_tts' }, isDefault: true },
  });
  expect(p.status).toBe(201);
  expect((await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, {
    method: 'PUT',
    body: { providerId: p.body.model.id, voiceId: VOICE },
  })).status).toBe(200);
});
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});
afterEach(() => {
  volcTtsStream.streamSynthesize = originalStream;
  ttsStreamRoute.resetBreaker();
  delete process.env.BUTLER_TTS_TONE_MAP;
  delete process.env.VOLC_TTS_V3_VOICES;
  ttsTone.reset();
});

describe('语气映射表', () => {
  it('缺省那一份认得工人会发的那七个 id', () => {
    // 短列表的主人是 channel-worker/src/tts/tone.ts;这里是**对照表**,改那边就要改这边。
    expect(ttsTone.knownTones()).toEqual(['ask', 'calm', 'care', 'happy', 'sorry', 'soft', 'urgent'].sort());
  });

  it('认得的语气翻出 emotion / 强度 / 一句指令;强度掐在 1–5', () => {
    const happy = ttsTone.resolveTone('happy');
    expect(happy.emotion).toBe('happy');
    expect(happy.emotionScale).toBeGreaterThanOrEqual(ttsTone.SCALE_MIN);
    expect(happy.emotionScale).toBeLessThanOrEqual(ttsTone.SCALE_MAX);
    expect(typeof happy.contextText).toBe('string');
  });

  it('**认不得的退回中性**:三格全缺席(不是 emotion:neutral)', () => {
    expect(ttsTone.resolveTone('兴高采烈')).toEqual({});
    expect(ttsTone.resolveTone('')).toEqual({});
    expect(ttsTone.resolveTone(undefined)).toEqual({});
    // 认不得的语气连她写的那句指令也不用(理由见 ttsTone.cjs)。
    expect(ttsTone.resolveTone('兴高采烈', '慢一点说')).toEqual({});
  });

  it('她写的那一句盖掉表里那句;超过二十字就当没写', () => {
    expect(ttsTone.resolveTone('care', '慢一点、轻一点说').contextText).toBe('慢一点、轻一点说');
    const long = '一'.repeat(ttsTone.TONE_NOTE_MAX + 1);
    expect(ttsTone.resolveTone('care', long).contextText).toBe(ttsTone.resolveTone('care').contextText);
  });

  it('整张表能用 BUTLER_TTS_TONE_MAP 换掉(映射放配置,不写死)', () => {
    const file = join(home, 'my-tone-map.json');
    writeFileSync(file, JSON.stringify({
      default_emotion_scale: 5,
      tones: { calm: { emotion: 'angry', context_text: '换过的那一句' } },
    }));
    process.env.BUTLER_TTS_TONE_MAP = file;
    ttsTone.reset();
    expect(ttsTone.knownTones()).toEqual(['calm']);
    expect(ttsTone.resolveTone('calm')).toEqual({ emotion: 'angry', emotionScale: 5, contextText: '换过的那一句' });
    expect(ttsTone.resolveTone('happy')).toEqual({});
  });

  it('表坏了 / 指歪了 → 空表(所有语气退回中性),**不抛**', () => {
    process.env.BUTLER_TTS_TONE_MAP = join(home, '压根不存在.json');
    ttsTone.reset();
    expect(ttsTone.knownTones()).toEqual([]);
    expect(ttsTone.resolveTone('happy')).toEqual({});
  });
});

describe('V3(2.0 音色)请求体', () => {
  it('语气缺席时与 10-01 逐字相同:audio_params 只有那三格,没有 additions', () => {
    const body = volcTtsStream.v3RequestOf({ text: '好的。', voice: V3_VOICE, speed: 1 });
    expect(body.req_params.audio_params).toEqual({ format: 'pcm', sample_rate: 24000, speed_ratio: 1 });
    expect(body.req_params.additions).toBeUndefined();
  });

  it('语气在的时候:emotion + emotion_scale 进 audio_params', () => {
    const body = volcTtsStream.v3RequestOf({
      text: '好的。', voice: V3_VOICE, tone: { emotion: 'happy', emotionScale: 4, contextText: '语气轻快' },
    });
    expect(body.req_params.audio_params.emotion).toBe('happy');
    expect(body.req_params.audio_params.emotion_scale).toBe(4);
  });

  it('**additions 是一个 JSON 字符串**(传对象上去火山会静默忽略整段语气)', () => {
    const body = volcTtsStream.v3RequestOf({
      text: '好的。', voice: V3_VOICE, tone: { contextText: '压低声音轻声说' },
    });
    expect(typeof body.req_params.additions).toBe('string');
    expect(JSON.parse(body.req_params.additions)).toEqual({ context_texts: ['压低声音轻声说'] });
  });

  it('只有 emotion 没有强度 → 不编一个 emotion_scale', () => {
    const body = volcTtsStream.v3RequestOf({ text: '好。', voice: V3_VOICE, tone: { emotion: 'sad' } });
    expect(body.req_params.audio_params.emotion).toBe('sad');
    expect(body.req_params.audio_params.emotion_scale).toBeUndefined();
  });
});

describe('V1(默认音色今天走的那条)', () => {
  it('吃得到那个枚举', () => {
    const { body } = volcTtsStream.v1RequestOf({
      config: { appid: 'a', accessToken: 't', cluster: 'volcano_tts' },
      text: '好。', voice: VOICE, emotion: 'happy',
    });
    expect(body.audio.emotion).toBe('happy');
    expect(body.audio.enable_emotion).toBe(true);
  });

  it('**没有 context_texts 这条路**:那一句自然语言指令在 V1 上如实丢掉', () => {
    const { body } = volcTtsStream.v1RequestOf({
      config: { appid: 'a', accessToken: 't', cluster: 'volcano_tts' },
      text: '好。', voice: VOICE,
    });
    expect(JSON.stringify(body)).not.toContain('context_texts');
    expect(JSON.stringify(body)).not.toContain('additions');
  });

  it('默认音色今天**不走 V3**;`VOLC_TTS_V3_VOICES` 能把它挪过去(缺省关着)', () => {
    // 这一条是这张卡量到的那件要紧事:zh_female_vv_uranus_bigtts 既不是 saturn_ 也不是 _tob。
    expect(volcengine.needsV3Voice('zh_female_vv_uranus_bigtts')).toBe(false);
    expect(volcengine.needsV3Voice(V3_VOICE)).toBe(true);
    process.env.VOLC_TTS_V3_VOICES = '_uranus_';
    expect(volcengine.needsV3Voice('zh_female_vv_uranus_bigtts')).toBe(true);
  });
});

describe('POST /api/tts/stream 把语气一路带下去', () => {
  async function capture(body) {
    let seen;
    volcTtsStream.streamSynthesize = async (input) => {
      seen = input;
      input.onChunk(Buffer.alloc(480, 1));
      return { chunks: 1 };
    };
    const res = await fetch(`${srv.base}/api/tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    return seen;
  }

  it('tone 翻好了才下去(上游拿到的是 {emotion, emotionScale, contextText},不是那个 id)', async () => {
    const seen = await capture({ text: '那件事我没办成。', tone: 'sorry' });
    expect(seen.tone).toBeDefined();
    expect(seen.tone.emotion).toBe(ttsTone.resolveTone('sorry').emotion);
    expect(seen.tone.contextText).toBe(ttsTone.resolveTone('sorry').contextText);
  });

  it('她写的那一句指令跟着走', async () => {
    const seen = await capture({ text: '你还好吗?', tone: 'care', toneNote: '慢一点、轻一点说' });
    expect(seen.tone.contextText).toBe('慢一点、轻一点说');
  });

  it('**没带 tone / 认不得的 tone → 上游一个语气参数都收不到**(与 10-01 逐字相同)', async () => {
    expect((await capture({ text: '好的。' })).tone).toBeUndefined();
    expect((await capture({ text: '好的。', tone: '兴高采烈' })).tone).toBeUndefined();
  });
});
