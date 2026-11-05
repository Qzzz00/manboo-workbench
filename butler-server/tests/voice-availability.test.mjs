// 音色单**按账号实取**(2026-09-27,卡 VO)。维护者原话:
// 「我现在已经正式开通了,音色列表是全的,你最好重新去取一遍,而不是只靠记忆做事。」
//
// 这一组钉五件:
//   ① 火山错误码翻成**人话**,认不出来的如实说认不出来(不编一个意思);
//   ② 「没开通 / 额度用完」才划掉音色;「太挤 / 念不了这段字 / 网断了」**不许**划掉;
//   ③ 实取结果带取的时刻、落盘、能复读;
//   ④ 一次都没取到时照列本地清单,但回包里**明说这次没取到**;过期了明说是上次几点取的;
//   ⑤ `GET /api/voices` 只列取回来能用的;`PUT /current` 拒绝实取里明确用不了的那些。
//
// 上游(火山)全部打桩,不联网、不碰任何密钥。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('voice-availability');
const { createApp } = require('../server/app.cjs');
const volcTtsErrors = require('../server/services/volcTtsErrors.cjs');
const voiceAvailability = require('../server/services/voiceAvailability.cjs');
const ttsSynthesizer = require('../server/services/ttsSynthesizer.cjs');
const volcTtsStream = require('../server/services/volcTtsStream.cjs');

/** 这个账号真开通了的(实取里成功的那几个)。 */
const GOOD = 'zh_female_vv_uranus_bigtts';
/** 没开通的那一个:火山回 403 not granted。 */
const NOT_GRANTED = 'saturn_zh_female_cancan_tob';
/** 英文音色:拿中文探针去喂会回 3011,那**不是**没开通(09-27 实取撞见的那三个)。 */
const ENGLISH = 'en_male_tim_uranus_bigtts';

let srv;
const originalSynthesize = ttsSynthesizer.synthesize;
const originalStream = volcTtsStream.streamSynthesize;

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
  volcTtsStream.streamSynthesize = async () => { throw new Error('这一组不测流式'); };
});

afterAll(async () => {
  ttsSynthesizer.synthesize = originalSynthesize;
  volcTtsStream.streamSynthesize = originalStream;
  await srv.close();
  cleanupHome(home);
});

beforeEach(() => {
  voiceAvailability.clear();
  ttsSynthesizer.synthesize = originalSynthesize;
});

describe('① 火山错误码 → 人话', () => {
  it('「这一档没开通」说得出去哪开', () => {
    const e = volcTtsErrors.explain('volcengine TTS HTTP 403 [resource_id=x] requested resource not granted');
    expect(e.kind).toBe('not_granted');
    expect(e.action).toContain('火山引擎控制台');
    expect(volcTtsErrors.humanLine(e.detail)).toContain('没开通');
  });

  it('额度用完 / 并发超限 / 念不了这段字,是三件不同的事', () => {
    expect(volcTtsErrors.explain('code=45000292 quota exceeded for types: text_words_lifetime').kind).toBe('quota');
    expect(volcTtsErrors.explain('HTTP 429 code=3001 quota exceeded for types: concurrency').kind).toBe('busy');
    expect(volcTtsErrors.explain('HTTP 400 code=3011 TTSInvalidText:unsupported language').kind).toBe('text_rejected');
  });

  it('官方那两句「音色没授权」也认得出来', () => {
    expect(volcTtsErrors.explain('code=45000000 speaker permission denied: get resource id: access denied').kind).toBe('not_granted');
    expect(volcTtsErrors.explain('code=55000000 resource ID is mismatched with speaker related resource').kind).toBe('not_granted');
  });

  it('认不出来的**如实说认不出来**,原话照抄,不编一个意思', () => {
    const e = volcTtsErrors.explain('天知道这是什么');
    expect(e.kind).toBe('unknown');
    expect(e.action).toBeUndefined();
    expect(e.human).toContain('天知道这是什么');
  });
});

describe('② 什么才算「这个音色用不了」', () => {
  it('没开通 / 额度用完 / 音色不存在 → 划掉', () => {
    expect(volcTtsErrors.meansUnavailable('requested resource not granted')).toBe(true);
    expect(volcTtsErrors.meansUnavailable('quota exceeded for types: text_words_lifetime')).toBe(true);
    expect(volcTtsErrors.meansUnavailable('code=3050 音色不存在')).toBe(true);
  });

  it('太挤 / 网断了 / 念不了这段字 / 看不懂 → **不许**划掉', () => {
    for (const m of [
      'quota exceeded for types: concurrency',
      'fetch failed',
      'code=3011 TTSInvalidText:unsupported language',
      '天知道这是什么',
    ]) {
      expect(volcTtsErrors.meansUnavailable(m), m).toBe(false);
      expect(volcTtsErrors.meansInconclusive(m), m).toBe(true);
    }
  });
});

describe('③ 实取:逐个试合一句极短文本', () => {
  it('探针那句话按音色的语种挑(英文音色不拿中文去喂)', () => {
    expect(voiceAvailability.probeTextFor('zh')).toBe('你好');
    expect(voiceAvailability.probeTextFor('en')).toBe('Hello.');
    expect(voiceAvailability.probeTextFor('什么鬼')).toBe('你好');
  });

  it('成功的留下、没开通的划掉、太挤的留着但标「这次没问出来」', async () => {
    const seen = [];
    const state = await voiceAvailability.refresh({
      provider: { provider_type: 'volcengine', config: {} },
      catalog: [
        { id: GOOD, lang: 'zh' },
        { id: NOT_GRANTED, lang: 'zh' },
        { id: ENGLISH, lang: 'en' },
      ],
      synthesize: async ({ voice, text }) => {
        seen.push([voice, text]);
        if (voice === NOT_GRANTED) throw new Error('volcengine TTS HTTP 403 requested resource not granted');
        if (voice === ENGLISH) throw new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency');
        return { buffer: Buffer.from('pcm'), contentType: 'audio/pcm' };
      },
    });
    expect(seen).toEqual([[GOOD, '你好'], [NOT_GRANTED, '你好'], [ENGLISH, 'Hello.']]);
    expect(state.counts).toEqual({ total: 3, ok: 1, inconclusive: 1, unavailable: 1, listed: 2 });
    expect(state.voices[GOOD]).toEqual({ ok: true });
    expect(state.voices[NOT_GRANTED].ok).toBe(false);
    expect(state.voices[NOT_GRANTED].why).toContain('没开通');
    expect(state.voices[ENGLISH]).toMatchObject({ ok: true, inconclusive: true });
    expect(typeof state.fetched_at).toBe('string');
  });

  it('落了盘,读得回来;那一份里没有任何密钥', async () => {
    await voiceAvailability.refresh({
      provider: { provider_type: 'volcengine', config: { accessToken: 'secret-token-1234' } },
      catalog: [{ id: GOOD, lang: 'zh' }],
      synthesize: async () => ({ buffer: Buffer.from('pcm'), contentType: 'audio/pcm' }),
    });
    const back = voiceAvailability.read();
    expect(back.voices[GOOD]).toEqual({ ok: true });
    expect(JSON.stringify(back)).not.toContain('secret-token-1234');
  });
});

describe('④ 取不到时说实话', () => {
  it('一次都没取到:照列本地清单,但明说「这次没取到」', () => {
    const out = voiceAvailability.applyTo('volcengine', [{ id: GOOD }, { id: NOT_GRANTED }]);
    expect(out.voices).toHaveLength(2);
    expect(out.availability.fetched_at).toBeNull();
    expect(out.availability.note).toContain('这次没取到');
  });

  it('取到过:只留能用的,并说清楚是几点取的', async () => {
    await voiceAvailability.refresh({
      provider: { provider_type: 'volcengine', config: {} },
      catalog: [{ id: GOOD, lang: 'zh' }, { id: NOT_GRANTED, lang: 'zh' }],
      synthesize: async ({ voice }) => {
        if (voice === NOT_GRANTED) throw new Error('HTTP 403 requested resource not granted');
        return { buffer: Buffer.from('pcm'), contentType: 'audio/pcm' };
      },
    });
    const out = voiceAvailability.applyTo('volcengine', [{ id: GOOD }, { id: NOT_GRANTED }]);
    expect(out.voices.map((v) => v.id)).toEqual([GOOD]);
    expect(out.availability.stale).toBe(false);
    expect(out.availability.note).toContain('真能用');
    expect(out.availability.note).toContain(voiceAvailability.fetchedAtLabel(voiceAvailability.read()));
  });

  it('过期了:照列,但明说是上次几点取的', async () => {
    await voiceAvailability.refresh({
      provider: { provider_type: 'volcengine', config: {} },
      catalog: [{ id: GOOD, lang: 'zh' }],
      synthesize: async () => ({ buffer: Buffer.from('pcm'), contentType: 'audio/pcm' }),
    });
    const later = Date.now() + voiceAvailability.MAX_AGE_MS + 1000;
    const out = voiceAvailability.applyTo('volcengine', [{ id: GOOD }], { now: later });
    expect(out.availability.stale).toBe(true);
    expect(out.availability.note).toContain('上次');
    expect(out.voices.map((v) => v.id)).toEqual([GOOD]);
  });
});

describe('⑤ 后台那个下拉', () => {
  it('GET /admin/tts-voices 也只列取回来能用的,并带上 availability', async () => {
    ttsSynthesizer.synthesize = async ({ voice }) => {
      if (voice === NOT_GRANTED) throw new Error('volcengine TTS HTTP 403 requested resource not granted');
      return { buffer: Buffer.from('pcm'), contentType: 'audio/pcm' };
    };
    const voiceAvailabilityJob = require('../server/services/voiceAvailabilityJob.cjs');
    await voiceAvailabilityJob.runRefresh({
      id: 'p1', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234' },
    });
    const res = await json(srv.base, '/admin/tts-voices');
    expect(res.status).toBe(200);
    expect(res.body.official.map((v) => v.id)).not.toContain(NOT_GRANTED);
    expect(res.body.official.every((v) => v.probed === true)).toBe(true);
    expect(res.body.availability.fetched_at).toEqual(expect.any(String));
  });

  it('POST /admin/tts-voices/refresh 起了就回 202', async () => {
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from('pcm'), contentType: 'audio/pcm' });
    const res = await json(srv.base, '/admin/tts-voices/refresh', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
  });
});

describe('⑥ 电话里那条单子', () => {
  it('GET /api/voices 只列取回来能用的,并带上「什么时候取的」', async () => {
    // 实取一次:把「知性灿灿」划掉(这正是 2026-09-26 那一天的形状)。
    ttsSynthesizer.synthesize = async ({ voice }) => {
      if (voice === NOT_GRANTED) throw new Error('volcengine TTS HTTP 403 requested resource not granted');
      return { buffer: Buffer.from('pcm'), contentType: 'audio/pcm' };
    };
    const voiceAvailabilityJob = require('../server/services/voiceAvailabilityJob.cjs');
    await voiceAvailabilityJob.runRefresh({
      id: 'p1', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234' },
    });

    const res = await json(srv.base, '/api/voices');
    expect(res.status).toBe(200);
    const ids = res.body.voices.map((v) => v.id);
    expect(ids).not.toContain(NOT_GRANTED);
    expect(ids).toContain(GOOD);
    expect(res.body.availability.fetched_at).toEqual(expect.any(String));
    expect(res.body.availability.note).toContain('真能用');
    // 回包里一个密钥字符都没有。
    expect(JSON.stringify(res.body)).not.toContain('secret-token-1234');
  });

  it('PUT /api/voices/current 拒绝实取里明确用不了的,并说出为什么', async () => {
    ttsSynthesizer.synthesize = async ({ voice }) => {
      if (voice === NOT_GRANTED) throw new Error('volcengine TTS HTTP 403 requested resource not granted');
      return { buffer: Buffer.from('pcm'), contentType: 'audio/pcm' };
    };
    const voiceAvailabilityJob = require('../server/services/voiceAvailabilityJob.cjs');
    await voiceAvailabilityJob.runRefresh({
      id: 'p1', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234' },
    });

    const bad = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: NOT_GRANTED } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('voice_not_granted');
    expect(bad.body.error).toContain('没开通');

    const ok = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: GOOD } });
    expect(ok.status).toBe(200);
    expect(ok.body.voice.id).toBe(GOOD);
  });
});
