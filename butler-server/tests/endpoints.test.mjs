import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { require, tempHome, cleanupHome } from './_setup.mjs';

const home = tempHome('endpoints');
const endpoints = require('../server/lib/endpoints.cjs');
const { loadConfig, resetConfigCache } = require('../server/config.cjs');

const ENV_KEYS = ['BUTLER_VOLC_OPENSPEECH_URL', 'BUTLER_VOLC_OPENAPI_HOST', 'BUTLER_VOLC_RTC_HOST'];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeFileSync(process.env.BUTLER_CONFIG_FILE, '{}');
  endpoints.resetEndpointsCache();
  resetConfigCache();
});
afterAll(() => cleanupHome(home));

describe('火山的对外地址(2026-10-21:默认不变,可换)', () => {
  it('什么都没配:就是今天写死的那几个官方地址', () => {
    expect(endpoints.volcTtsHttpUrl()).toBe('https://openspeech.bytedance.com/api/v1/tts');
    expect(endpoints.volcTtsV3Url()).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    expect(endpoints.volcTtsWsUrl()).toBe('wss://openspeech.bytedance.com/api/v1/tts/ws_binary');
    expect(endpoints.volcAsrWsUrl()).toBe('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel');
    expect(endpoints.volcOpenApiHost()).toBe('open.volcengineapi.com');
    expect(endpoints.volcRtcHost()).toBe('rtc.volcengineapi.com');
  });

  it('butler.json 的 endpoints 里写了就用它;ws 地址跟着 http 换协议', () => {
    writeFileSync(process.env.BUTLER_CONFIG_FILE, JSON.stringify({
      endpoints: { volc_openspeech_url: 'http://127.0.0.1:9000/', volc_openapi_host: 'openapi.example.test', volc_rtc_host: 'rtc.example.test' },
    }));
    endpoints.resetEndpointsCache();
    expect(endpoints.volcTtsHttpUrl()).toBe('http://127.0.0.1:9000/api/v1/tts');
    expect(endpoints.volcAsrWsUrl()).toBe('ws://127.0.0.1:9000/api/v3/sauc/bigmodel');
    expect(endpoints.volcOpenApiHost()).toBe('openapi.example.test');
    expect(endpoints.volcRtcHost()).toBe('rtc.example.test');
  });

  it('环境变量压过文件;认不出的值(不是 http/https、主机名里带路径)退回默认', () => {
    writeFileSync(process.env.BUTLER_CONFIG_FILE, JSON.stringify({ endpoints: { volc_openspeech_url: 'https://file.example.test' } }));
    process.env.BUTLER_VOLC_OPENSPEECH_URL = 'https://env.example.test';
    endpoints.resetEndpointsCache();
    expect(endpoints.volcTtsV3Url()).toBe('https://env.example.test/api/v3/tts/unidirectional');
    process.env.BUTLER_VOLC_OPENSPEECH_URL = 'file:///etc/passwd';
    process.env.BUTLER_VOLC_OPENAPI_HOST = 'evil.test/path';
    endpoints.resetEndpointsCache();
    expect(endpoints.volcTtsV3Url()).toBe('https://file.example.test/api/v3/tts/unidirectional');
    expect(endpoints.volcOpenApiHost()).toBe('open.volcengineapi.com');
  });

  it('butler.json 因 token 坏了重写时,endpoints 那一块不被冲掉', () => {
    writeFileSync(process.env.BUTLER_CONFIG_FILE, JSON.stringify({ version: 1, port: 8792, token: 'bad', endpoints: { volc_rtc_host: 'rtc.example.test' } }));
    resetConfigCache();
    loadConfig();
    expect(JSON.parse(readFileSync(process.env.BUTLER_CONFIG_FILE, 'utf8')).endpoints).toEqual({ volc_rtc_host: 'rtc.example.test' });
  });
});
