// V3(2.0 音色)一次合成的 mp3 码率(2026-10-03,统筹量「默认音色挪不挪 V3」时发现)。
//
// 同一句话、同一音色:V1 回 160 kbps 的 mp3,V3 不写码率只回 64 kbps(时长一样,文件小一半多)。
// 挪路不该顺手把音质降一档,所以 V3 的 mp3 请求显式要 160 kbps;pcm / wav 没有码率这件事,不带。
// 流式那条(volcTtsStream.v3RequestOf)是 pcm,不在此列。
import { afterEach, describe, expect, it } from 'vitest';
import { require } from './_setup.mjs';

const volcengine = require('../server/services/volcengine.cjs');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 拦住 fetch 只看请求体,不真打火山(拦下即抛,synthesizeV3 跟着抛,这里吞掉)。 */
async function captureBody(args) {
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); throw new Error('拦下了,不真发'); };
  await volcengine.synthesizeV3({
    config: { appid: 'test-app', accessToken: 'test-token' },
    text: '好的。', voice: 'zh_female_vv_uranus_bigtts', ...args,
  }).catch(() => {});
  return body;
}

describe('V3 一次合成(非流式)的码率', () => {
  it('mp3 显式要 160 kbps(V3 缺省 64、V1 是 160)', async () => {
    const body = await captureBody({ encoding: 'mp3' });
    expect(body.req_params.audio_params.bit_rate).toBe(160000);
  });

  it('pcm / wav 不带 bit_rate', async () => {
    expect((await captureBody({ encoding: 'pcm' })).req_params.audio_params.bit_rate).toBeUndefined();
    expect((await captureBody({ encoding: 'wav' })).req_params.audio_params.bit_rate).toBeUndefined();
  });

  it('语气缺席时其余与 10-01 一样:format / sample_rate / speed_ratio,没有 additions', async () => {
    const body = await captureBody({ encoding: 'mp3', speed: 1 });
    expect(body.req_params.audio_params).toEqual({ format: 'mp3', sample_rate: 24000, bit_rate: 160000, speed_ratio: 1 });
    expect(body.req_params.additions).toBeUndefined();
  });
});
