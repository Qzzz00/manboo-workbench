'use strict';

// 事务官后端往外连的火山地址(2026-10-21,开源整理)。
//
// 默认就是火山的官方地址,行为与之前写死时一字不差。要换(自建代理、私有化部署、测试替身)有两处,
// 环境变量压过文件:
//   ~/.dsh/workbench/butler.json 的 endpoints(与端口、token 同一份,config.cjs 重写时会留着它)
//     { "endpoints": { "volc_openspeech_url": "https://…", "volc_openapi_host": "…", "volc_rtc_host": "…" } }
//   BUTLER_VOLC_OPENSPEECH_URL / BUTLER_VOLC_OPENAPI_HOST / BUTLER_VOLC_RTC_HOST
// OpenAPI 两项是**主机名**不是网址:它要进签名里的 Host 头(volcengine.cjs signedOpenAPI)。
// MiniMax 与百炼的地址早就能在各自 provider 的 config.apiUrl 里改,不在这里。
// 全部对外连接的清单见 docs/开源-对外连接清单-2026-10-21.md。

const fs = require('node:fs');
const { configFile } = require('../config.cjs');

const DEFAULTS = {
  volc_openspeech_url: 'https://openspeech.bytedance.com',
  volc_openapi_host: 'open.volcengineapi.com',
  volc_rtc_host: 'rtc.volcengineapi.com',
};

const ENV = {
  volc_openspeech_url: 'BUTLER_VOLC_OPENSPEECH_URL',
  volc_openapi_host: 'BUTLER_VOLC_OPENAPI_HOST',
  volc_rtc_host: 'BUTLER_VOLC_RTC_HOST',
};

function validUrl(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(trimmed) ? trimmed : undefined;
}

function validHost(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(trimmed) ? trimmed : undefined;
}

const VALIDATE = { volc_openspeech_url: validUrl, volc_openapi_host: validHost, volc_rtc_host: validHost };

let cached = null;

function fromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return raw && typeof raw.endpoints === 'object' && raw.endpoints !== null ? raw.endpoints : {};
  } catch {
    return {};
  }
}

/** 进程内只读一次文件;改了地址要重启事务官后端(设置里有启停)。 */
function resolved() {
  if (cached) return cached;
  const file = fromFile();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = VALIDATE[key](process.env[ENV[key]]) ?? VALIDATE[key](file[key]) ?? DEFAULTS[key];
  }
  cached = out;
  return cached;
}

function openspeech() { return resolved().volc_openspeech_url; }
function wsOf(httpBase) { return httpBase.replace(/^http/i, 'ws'); }

function volcTtsHttpUrl() { return `${openspeech()}/api/v1/tts`; }
function volcTtsV3Url() { return `${openspeech()}/api/v3/tts/unidirectional`; }
function volcTtsWsUrl() { return `${wsOf(openspeech())}/api/v1/tts/ws_binary`; }
function volcAsrWsUrl() { return `${wsOf(openspeech())}/api/v3/sauc/bigmodel`; }
function volcOpenApiHost() { return resolved().volc_openapi_host; }
function volcRtcHost() { return resolved().volc_rtc_host; }

/** 测试用:清掉缓存,让下一次重读环境变量与文件。 */
function resetEndpointsCache() { cached = null; }

module.exports = {
  DEFAULTS, volcTtsHttpUrl, volcTtsV3Url, volcTtsWsUrl, volcAsrWsUrl, volcOpenApiHost, volcRtcHost, resetEndpointsCache,
};
