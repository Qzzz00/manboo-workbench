// 上游按模型名分家(2026-09-22,派活第二只手「接口」)。
//
// 这一份只测**纯函数**:模型名 → 哪一家、环境变量 → 那一家的地址与开关、
// 豆包的 endpoint 映射怎么解析。真发请求的那一半在 http.test.mjs 里对着假上游跑。
//
// ★ 一条贯穿的纪律:**这份用例里一个真 Key 都不许出现**,断言也只断言"配没配"(布尔)
//   与地址,绝不把 key 的值写进期望里 —— 期望值会被 grep 出来当成真值。
import { describe, expect, it } from 'vitest';

import {
  PROVIDERS, PROVIDER_ENV, PROVIDER_TITLES,
  parseEndpointMap, providerOfModel, providerUpstream, relayProvidersConfigOf, resolveUpstreamModel,
} from '../server/providers.cjs';

describe('模型名 → 哪一家', () => {
  it('gpt- 开头归 OpenAI', () => {
    expect(providerOfModel('gpt-4o')).toBe('openai');
    expect(providerOfModel('gpt-4o-mini')).toBe('openai');
    expect(providerOfModel('GPT-4O')).toBe('openai');
  });

  it('o 加数字那一系(o1 / o3 / o4-mini)也归 OpenAI', () => {
    expect(providerOfModel('o1')).toBe('openai');
    expect(providerOfModel('o3-mini')).toBe('openai');
    expect(providerOfModel('o4-mini')).toBe('openai');
  });

  it('★ 光一个 o 开头不算 —— 判据是「o 后面紧跟数字」', () => {
    // 「其余 → DeepSeek」是兜底那一档。要是把所有 o 开头都判给 OpenAI,
    // 哪天上游出一个 `omni-…` 之类的名字就会被静默发到另一家去,而 Key 还是对的,
    // 于是错得毫无声响。宁可漏判(兜底那家会如实报错),不可错判。
    expect(providerOfModel('openchat')).toBe('deepseek');
    expect(providerOfModel('o-my-model')).toBe('deepseek');
  });

  it('doubao- 开头归豆包;ep- 开头(直接给 endpoint id)也归豆包', () => {
    expect(providerOfModel('doubao-pro-32k')).toBe('doubao');
    expect(providerOfModel('ep-20260922-abcde')).toBe('doubao');
  });

  it('其余一律 DeepSeek(现状不变)', () => {
    expect(providerOfModel('deepseek-chat')).toBe('deepseek');
    expect(providerOfModel('deepseek-reasoner')).toBe('deepseek');
    expect(providerOfModel(undefined)).toBe('deepseek');
    expect(providerOfModel('')).toBe('deepseek');
    expect(providerOfModel(42)).toBe('deepseek');
  });

  it('三家都在表里,而且各有一个中文名(错误里要写人话)', () => {
    expect([...PROVIDERS].sort()).toEqual(['deepseek', 'doubao', 'openai']);
    for (const provider of PROVIDERS) {
      expect(PROVIDER_TITLES[provider]).toBeTruthy();
      expect(PROVIDER_ENV[provider].key).toMatch(/^RELAY_/);
      expect(PROVIDER_ENV[provider].base).toMatch(/^RELAY_/);
    }
  });
});

describe('环境变量 → 三家的配置', () => {
  it('一个都不配时三家全是「没配」,而且起得来(不抛)', () => {
    const config = relayProvidersConfigOf({});
    for (const provider of PROVIDERS) {
      expect(config[provider].configured).toBe(false);
      expect(config[provider].key).toBeUndefined();
      expect(config[provider].baseUrl).toBeTruthy();
    }
  });

  it('配了 Key 才算配上;地址有默认值,写了就用写的(末尾斜杠去掉)', () => {
    const config = relayProvidersConfigOf({
      RELAY_OPENAI_KEY: 'x',
      RELAY_DOUBAO_KEY: 'y',
      RELAY_DOUBAO_BASE: 'https://ark.example.com/api/v3/',
    });
    expect(config.openai.configured).toBe(true);
    expect(config.openai.baseUrl).toBe('https://api.openai.com');
    expect(config.doubao.configured).toBe(true);
    expect(config.doubao.baseUrl).toBe('https://ark.example.com/api/v3');
  });

  it('★ 豆包那家的路径前缀是空的 —— 火山方舟的 base 自带 /api/v3,再拼 /v1 就 404', () => {
    const config = relayProvidersConfigOf({});
    expect(config.doubao.baseUrl).toContain('/api/v3');
    expect(config.doubao.prefix).toBe('');
    expect(config.openai.prefix).toBe('/v1');
    expect(config.deepseek.prefix).toBe('/v1');
  });

  it('DeepSeek 那家仍读老变量(存量部署一个字都不用改)', () => {
    const config = relayProvidersConfigOf({ RELAY_UPSTREAM_KEY: 'z', RELAY_UPSTREAM_URL: 'https://ds.example.com' });
    expect(config.deepseek.configured).toBe(true);
    expect(config.deepseek.baseUrl).toBe('https://ds.example.com');
  });
});

describe('豆包的 endpoint 映射', () => {
  it('逗号 / 分号 / 换行都当分隔符', () => {
    expect(parseEndpointMap('a=ep-1,b=ep-2;c=ep-3\nd=ep-4')).toEqual({
      a: 'ep-1', b: 'ep-2', c: 'ep-3', d: 'ep-4',
    });
  });

  it('空的、缺等号的、只有名字的,一概跳过(不造一个空值出来)', () => {
    expect(parseEndpointMap('')).toEqual({});
    expect(parseEndpointMap(undefined)).toEqual({});
    expect(parseEndpointMap('a=ep-1,,坏了,b=')).toEqual({ a: 'ep-1' });
  });

  it('模型名不分大小写(客户端写 Doubao-Pro 也认)', () => {
    expect(parseEndpointMap('Doubao-Pro-32K=ep-9')).toEqual({ 'doubao-pro-32k': 'ep-9' });
  });

  it('映射到了就换成 endpoint id;没映射到就原样发过去', () => {
    const map = { 'doubao-pro-32k': 'ep-9' };
    expect(resolveUpstreamModel('doubao', 'doubao-pro-32k', map)).toBe('ep-9');
    expect(resolveUpstreamModel('doubao', 'Doubao-Pro-32K', map)).toBe('ep-9');
    // 没映射:**原样发**,让方舟自己回一句"没这个模型"——比我们替它编一条错误强。
    expect(resolveUpstreamModel('doubao', 'doubao-lite-4k', map)).toBe('doubao-lite-4k');
    // 别家不做映射。
    expect(resolveUpstreamModel('openai', 'gpt-4o', map)).toBe('gpt-4o');
  });
});

describe('这一家此刻能不能发', () => {
  const config = {
    upstreamUrl: 'https://ds.example.com',
    upstreamKey: 'ds-key',
    providers: relayProvidersConfigOf({ RELAY_OPENAI_KEY: 'oa-key' }),
  };

  it('DeepSeek 走老字段(测试与存量部署都还在覆盖它们)', () => {
    const up = providerUpstream(config, 'deepseek');
    expect(up.chatUrl).toBe('https://ds.example.com/v1/chat/completions');
    expect(up.modelsUrl).toBe('https://ds.example.com/v1/models');
  });

  it('OpenAI 配了就拼得出三条路', () => {
    const up = providerUpstream(config, 'openai');
    expect(up.chatUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(up.imagesUrl).toBe('https://api.openai.com/v1/images/generations');
  });

  it('★ 豆包没配 → undefined(调用方据此 503 说「服务器没配豆包」)', () => {
    expect(providerUpstream(config, 'doubao')).toBeUndefined();
  });

  it('老字段没填时 DeepSeek 也是 undefined', () => {
    expect(providerUpstream({ ...config, upstreamKey: undefined }, 'deepseek')).toBeUndefined();
  });

  it('豆包的 chat 路径上没有 /v1', () => {
    const withDoubao = { ...config, providers: relayProvidersConfigOf({ RELAY_DOUBAO_KEY: 'db-key' }) };
    expect(providerUpstream(withDoubao, 'doubao').chatUrl)
      .toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  });
});
