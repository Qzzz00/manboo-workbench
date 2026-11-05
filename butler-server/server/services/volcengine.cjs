'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/volcengine.cjs
// 火山引擎(豆包语音) 适配层。
// 本轮：TTS 非流式合成(HTTP) + 复刻音色列表查询(OpenAPI)。
// 预留扩展位：流式/双向(WS) 与 RTC 实时语音，后续在此扩展。

const crypto = require('node:crypto');

const endpoints = require('../lib/endpoints.cjs');
// 地址默认是火山官方的,可在 butler.json 的 endpoints 或环境变量里换(lib/endpoints.cjs)。
const TTS_HTTP_URL = endpoints.volcTtsHttpUrl();
// V3「大模型语音合成 2.0」单向流式 HTTP：saturn_/_tob 角色扮演音色(seed-tts-2.0)只能走这里。
const TTS_V3_URL = endpoints.volcTtsV3Url();

// 火山 TTS 成功码（非 3000 视为失败）。
const SUCCESS_CODE = 3000;

// saturn_ 前缀 / _tob 后缀 = 「大模型语音合成 2.0」角色扮演音色，V1 引擎不支持(3031)，须走 V3。
//
// 2026-10-02(卡「声音与形象跟着话走」)量到一件要紧的事:**默认音色不在这张名单里**。
// `zh_female_vv_uranus_bigtts` 既不是 `saturn_` 也不是 `_tob`,所以它一直走 **V1 WebSocket** ——
// 那条路有 `emotion`,但**没有** `additions.context_texts`(那一句自然语言语气指令是 2.0 / V3 专有)。
// 也就是说:语气的「枚举」那一半默认音色现在就吃得到,「一句话指令」那一半吃不到。
//
// 要不要把 `_uranus_` 这一族也挪到 V3 是**一次真机取舍**(首包会不会变慢、音质有没有变),
// 不该由一张卡在没有密钥的机器上替维护者拍。所以这里留一个**缺省关着**的口子:
//   VOLC_TTS_V3_VOICES=_uranus_,另一个片段
// 逗号分隔的子串,命中任意一个就走 V3。**不填就与 10-01 逐字相同**(默认一个字节都没变)。
// 真机核法与那笔账见 docs/交接-1002-语气跟着话走.md。
function extraV3Patterns() {
  const raw = process.env.VOLC_TTS_V3_VOICES;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((one) => one.trim()).filter((one) => one !== '');
}

function needsV3Voice(voice) {
  if (typeof voice !== 'string') return false;
  if (/^saturn_/.test(voice) || /_tob$/.test(voice)) return true;
  return extraV3Patterns().some((pattern) => voice.includes(pattern));
}

// 火山 speed_ratio 合法区间 0.2~3.0；非法/缺省 → 1.0。
function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(3.0, Math.max(0.2, n));
}

// canonical emotion(src/lib/emotion.ts) → 火山大模型音色 audio.emotion 值。
// ⚠️ 仅大模型公版多情感音色(如 *_bigtts)支持；复刻音色(S_*)不吃，见 synthesize。
// 不在表内或映射为 null 的情绪 → 不下发情绪参数(等同 neutral)，避免给不支持的
// 音色传非法值导致整段合成失败。改 src/lib/emotion.ts 的 EMOTIONS 时需同步本表。
const VOLC_EMOTION = {
  neutral: null,
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprise',
  excited: 'excited',
  // shy/gentle 火山无直接对应，就近用 gentle(温柔)；该音色不支持时退化为不带情绪。
  shy: 'gentle',
  gentle: 'gentle',
};

/** 取该 canonical emotion 对应的火山值；缺省/中性/未知返回 null（表示不带情绪）。 */
function resolveVolcEmotion(emotion) {
  if (typeof emotion !== 'string') return null;
  return VOLC_EMOTION[emotion.trim().toLowerCase()] ?? null;
}

/**
 * 非流式合成：POST /api/v1/tts，header Authorization: "Bearer;{accessToken}"，
 * 返回 JSON.data = base64 音频。
 * @param {{appid,accessToken,cluster}} config provider 明文配置
 * @param {string} text  合成文本
 * @param {string} voice voice_type（官方音色 id 或复刻 speaker_id，形如 S_xxx）
 * @param {string} [encoding] 默认 mp3
 * @param {string} [emotion] canonical 情绪(src/lib/emotion.ts)，仅公版多情感音色生效
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
async function synthesize({ config, text, voice, encoding = 'mp3', endpoint, emotion, speed, tone } = {}) {
  const { appid, accessToken } = config || {};
  if (!appid || !accessToken) throw new Error('volcengine TTS: appid/accessToken missing');
  if (!text || !voice) throw new Error('volcengine TTS: text/voice required');

  // saturn_/_tob 角色扮演音色属于「大模型语音合成 2.0」，V1 引擎不支持(报 3031)，改走 V3。
  if (needsV3Voice(voice)) return synthesizeV3({ config, text, voice, encoding, speed, tone });

  // 复刻音色(speaker_id 形如 S_xxx)走 volcano_icl + 资源 volc.megatts.default（声音复刻1.0，实测通过）；
  // 公版大模型音色(如 *_bigtts)走 volcano_tts + 资源 volc.service_type.10029。
  // ⚠️ 必须带正确的 X-Api-Resource-Id，否则默认路由到 volc.tts.default → 403。
  const isCloned = typeof voice === 'string' && voice.startsWith('S_');
  const cluster = isCloned ? 'volcano_icl' : config.cluster || 'volcano_tts';
  // config.resourceId:服务器下发那一份可以带(RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID,2026-09-23);设置页那条路不会有它,行为不变。
  const resourceId = isCloned
    ? process.env.VOLC_TTS_CLONE_RESOURCE_ID || 'volc.megatts.default'
    : (config.resourceId || 'volc.service_type.10029');

  // 情绪只对公版多情感音色生效；复刻音色(S_*)不支持，直接跳过避免合成失败。
  // 2026-10-02:`tone.emotion`(这一句的语气)比调用方直接传的 `emotion`(这一通的缺省)更算数。
  const askedEmotion = tone && typeof tone.emotion === 'string' && tone.emotion !== '' ? tone.emotion : emotion;
  const volcEmotion = isCloned ? null : resolveVolcEmotion(askedEmotion);

  const body = {
    app: { appid, token: accessToken, cluster },
    user: { uid: 'aiboo' },
    audio: {
      voice_type: voice,
      encoding,
      speed_ratio: clampSpeed(speed),
      ...(volcEmotion ? { emotion: volcEmotion, enable_emotion: true } : {}),
    },
    request: { reqid: crypto.randomUUID(), text, text_type: 'plain', operation: 'query' },
  };

  const resp = await fetch(endpoint || TTS_HTTP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer;${accessToken}`,
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': resourceId,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) {
    // 透出火山真实错误(code/message)，便于排查（之前只抛 HTTP 状态码，吞了真正原因）。
    const detail = data && (data.code || data.message)
      ? ` code=${data.code} ${data.message || ''}`.trimEnd()
      : '';
    throw new Error(`volcengine TTS HTTP ${resp.status}${detail}`);
  }
  if (data.code !== SUCCESS_CODE || !data.data) {
    throw new Error(data.message || `volcengine TTS failed (code ${data.code})`);
  }

  const buffer = Buffer.from(data.data, 'base64');
  const contentType = encoding === 'wav' ? 'audio/wav' : encoding === 'pcm' ? 'audio/pcm' : 'audio/mpeg';
  return { buffer, contentType };
}

/**
 * V3 单向流式合成：POST /api/v3/tts/unidirectional。
 * 鉴权用 X-Api-* 头(非 V1 的 Bearer;token)，resource_id=seed-tts-2.0。
 * 响应为 chunked NDJSON：逐行 JSON，音频在 data(base64)，按序拼接；
 * 成功码 0 / 20000000，错误码在顶层或 header.code。
 * @param {{appid,accessToken}} config
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
async function synthesizeV3({ config, text, voice, encoding = 'mp3', speed, tone } = {}) {
  const { appid, accessToken } = config || {};
  if (!appid || !accessToken) throw new Error('volcengine TTS: appid/accessToken missing');
  if (!text || !voice) throw new Error('volcengine TTS: text/voice required');

  const resp = await fetch(TTS_V3_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appid,
      'X-Api-Access-Key': accessToken,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'aiboo' },
      req_params: {
        text,
        speaker: voice,
        audio_params: {
          format: encoding,
          sample_rate: 24000,
          // V3 不写码率缺省给 64 kbps 的 mp3,V1 给 160 kbps(2026-10-03 量的);要回同一档,音质才不随挪路而降。
          ...(encoding === 'mp3' ? { bit_rate: 160000 } : {}),
          speed_ratio: clampSpeed(speed),
          // 语气那三格(2026-10-02)。与流式那条 `volcTtsStream.v3RequestOf` **同一套字段**;
          // 缺席时这个对象与 10-01 逐字相同。`additions` 要的是**字符串**不是对象。
          ...(tone && tone.emotion ? { emotion: tone.emotion } : {}),
          ...(tone && tone.emotion && tone.emotionScale ? { emotion_scale: tone.emotionScale } : {}),
        },
        ...(tone && tone.contextText ? { additions: JSON.stringify({ context_texts: [tone.contextText] }) } : {}),
      },
    }),
  });

  const raw = await resp.text();
  const chunks = [];
  let errDetail = '';
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch { continue; }
    const code = j.code ?? j.header?.code;
    const message = j.message ?? j.header?.message;
    if (code !== undefined && code !== 0 && code !== 20000000) {
      errDetail = ` code=${code} ${message || ''}`.trimEnd();
    }
    if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
  }

  if (!resp.ok || chunks.length === 0) {
    throw new Error(`volcengine TTS V3 HTTP ${resp.status}${errDetail}`);
  }

  const buffer = Buffer.concat(chunks);
  const contentType = encoding === 'wav' ? 'audio/wav' : encoding === 'pcm' ? 'audio/pcm' : 'audio/mpeg';
  return { buffer, contentType };
}

// ── 火山 OpenAPI（AK/SK V4 签名）──────────────────────────
// ⚠️ 待核准：以下 4 个参数需用账号/官方文档确认；不对会签名/路由失败 →
//   调用方优雅降级（音色下拉仍有「官方精选 + 手填」，并回传 clonedError）。
const OPENAPI_HOST = endpoints.volcOpenApiHost();
const OPENAPI_REGION = 'cn-north-1';
const OPENAPI_SERVICE = 'speech_saas_prod'; // TODO 核准
const OPENAPI_VERSION = '2023-11-07'; // TODO 核准
const ACTION_LIST_CLONED = 'ListMegaTTSTrainStatus';

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}
function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function isoBasic(date) {
  // 2023-01-01T00:00:00.000Z → 20230101T000000Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// 火山 V4 签名后发起 POST OpenAPI 请求。
async function signedOpenAPI({
  ak,
  sk,
  action,
  version,
  body,
  host = OPENAPI_HOST,
  region = OPENAPI_REGION,
  service = OPENAPI_SERVICE,
}) {
  const method = 'POST';
  const xDate = isoBasic(new Date());
  const shortDate = xDate.slice(0, 8);
  const bodyStr = JSON.stringify(body || {});
  const payloadHash = sha256hex(bodyStr);
  const query = `Action=${action}&Version=${version}`; // 已按字典序(Action<Version)
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${xDate}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [method, '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(sk, shortDate), region), service), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${host}/?${query}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: authorization,
    },
    body: bodyStr,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) throw new Error(`volcengine OpenAPI HTTP ${resp.status}`);
  if (data.ResponseMetadata && data.ResponseMetadata.Error) {
    throw new Error(data.ResponseMetadata.Error.Message || 'volcengine OpenAPI error');
  }
  return data;
}

/**
 * 查询账号下「复刻音色」（声音复刻 SpeakerID 状态）。
 * 防御式解析返回（结构不确定）；任何失败由调用方 catch → 优雅降级。
 * @returns {Promise<Array<{id:string,name:string,state:string}>>}
 */
async function listClonedVoices({ ak, sk, appid }) {
  if (!ak || !sk) return [];
  const data = await signedOpenAPI({
    ak,
    sk,
    action: ACTION_LIST_CLONED,
    version: OPENAPI_VERSION,
    body: { AppID: appid },
  });
  // 返回结构待核准：尽量从 Result 下找数组，提取 SpeakerID/State/Alias。
  const result = data.Result || data.result || {};
  const arr =
    result.Statuses || result.statuses || result.Speakers || result.speakers || result.List || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => ({
      id: it.SpeakerID || it.speaker_id || it.SpeakerId || '',
      name: it.Alias || it.alias || it.Name || it.SpeakerID || it.speaker_id || '',
      state: it.State || it.state || '',
    }))
    .filter((v) => v.id);
}

// needsV3Voice / resolveVolcEmotion / clampSpeed 2026-09-23 起也出口:
// 流式合成(volcTtsStream.cjs)要用**同一套**路由与参数规则 —— 抄一份的下场是
// 「非流式能出声、流式换了个音色」,那种分叉最难查。
module.exports = {
  synthesize, synthesizeV3, listClonedVoices, signedOpenAPI, TTS_HTTP_URL,
  needsV3Voice, resolveVolcEmotion, clampSpeed, TTS_V3_URL,
};
