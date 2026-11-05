'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/minimax.cjs
// MiniMax T2A v2 (HTTP 非流式) 合成适配。对外签名与 volcengine.synthesize 一致，
// 供 ttsSynthesizer 统一分发。响应 data.audio 为 hex 字符串。

const ttsVoices = require('./ttsVoices.cjs');

const DEFAULT_API_URL = 'https://api.minimaxi.com/v1/t2a_v2';
const DEFAULT_MODEL = 'speech-2.8-hd';
// 默认音色：官方电台男主播。低松暖可在后台改用「抒情男声」「温润青年」等（A/B 后定）。env 可覆盖。
const MINIMAX_DEFAULT_VOICE = process.env.MINIMAX_TTS_DEFAULT_VOICE || 'Chinese (Mandarin)_Radio_Host';

// canonical emotion(src/lib/emotion.ts) → MiniMax 情绪枚举。
// ⚠️ 枚举确切拼写须对最新文档核对；未命中 → 省略不下发(安全退化，不报错)。
const MINIMAX_EMOTION = {
  neutral: 'neutral',
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  excited: 'happy', // 无对应，就近
  // shy / gentle 无对应 → 省略
};

function resolveMinimaxEmotion(emotion) {
  if (typeof emotion !== 'string') return null;
  return MINIMAX_EMOTION[emotion.trim().toLowerCase()] ?? null;
}

// MiniMax speed 合法区间 0.5~2.0；非法/缺省 → 1.0。
function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(2.0, Math.max(0.5, n));
}

// 请求音色若是已知 MiniMax 音色则直用；为空或属于别的命名空间（如遗留火山 id）则忽略，
// 回落到 provider 配置的默认音色，再回落代码默认。避免切到 MiniMax 后老角色音色 id 致合成失败。
function resolveMinimaxVoice(config, requestedVoice) {
  const v = typeof requestedVoice === 'string' ? requestedVoice.trim() : '';
  if (v && ttsVoices.isMinimaxVoice(v)) return v;
  return (config && config.defaultVoice) || MINIMAX_DEFAULT_VOICE;
}

async function synthesize({ config, text, voice, emotion, speed } = {}) {
  const { apiKey, groupId, model, apiUrl } = config || {};
  if (!apiKey || !groupId) throw new Error('minimax TTS: apiKey/groupId missing');
  if (!text || !voice) throw new Error('minimax TTS: text/voice required');

  const mmEmotion = resolveMinimaxEmotion(emotion);
  const url = `${apiUrl || DEFAULT_API_URL}?GroupId=${encodeURIComponent(groupId)}`;
  const body = {
    model: model || DEFAULT_MODEL,
    text,
    stream: false,
    output_format: 'hex',
    language_boost: 'auto',
    voice_setting: {
      voice_id: voice,
      speed: clampSpeed(speed),
      vol: 1.0,
      pitch: 0,
      ...(mmEmotion ? { emotion: mmEmotion } : {}),
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // fetch 抛错（DNS/连接/TLS）——透出底层 cause.code 与目标 host，便于定位"连不上端点"。
    const code = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    throw new Error(`minimax TTS 连接失败${code} → ${host}: ${err.message}`);
  }
  const data = await resp.json().catch(() => null);
  if (data && data.base_resp && data.base_resp.status_code !== 0) {
    const msg = data.base_resp.status_msg || `code ${data.base_resp.status_code}`;
    throw new Error(`minimax TTS failed: ${msg}`);
  }
  if (!resp.ok || !data) {
    throw new Error(`minimax TTS HTTP ${resp.status}`);
  }
  const hex = data.data && data.data.audio;
  if (!hex || typeof hex !== 'string') {
    throw new Error('minimax TTS: empty audio');
  }
  const buffer = Buffer.from(hex, 'hex');
  if (buffer.length === 0) throw new Error('minimax TTS: hex decode produced empty buffer');
  return { buffer, contentType: 'audio/mpeg' };
}

// get_voice 与 t2a_v2 同源不同路径；从 apiUrl 取 origin，保留国内站 host(api.minimaxi.com)。
function getVoiceUrl(apiUrl) {
  try {
    return `${new URL(apiUrl || DEFAULT_API_URL).origin}/v1/get_voice`;
  } catch {
    return 'https://api.minimaxi.com/v1/get_voice';
  }
}

// 拉账号可用音色：系统音色(300+) + 复刻/生成音色。对外形状与 volcengine.listClonedVoices 对齐
// （{id,name} 数组），供后台音色下拉。失败抛错由调用方优雅降级到本地兜底目录。
async function listVoices({ apiKey, groupId, apiUrl } = {}) {
  if (!apiKey || !groupId) throw new Error('minimax get_voice: apiKey/groupId missing');
  const url = `${getVoiceUrl(apiUrl)}?GroupId=${encodeURIComponent(groupId)}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'all' }),
    });
  } catch (err) {
    const code = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    throw new Error(`minimax get_voice 连接失败${code} → ${host}: ${err.message}`);
  }
  const data = await resp.json().catch(() => null);
  if (data && data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(`minimax get_voice failed: ${data.base_resp.status_msg || `code ${data.base_resp.status_code}`}`);
  }
  if (!resp.ok || !data) throw new Error(`minimax get_voice HTTP ${resp.status}`);

  const mapVoice = (v) => ({ id: v.voice_id, name: v.voice_name || v.description || v.voice_id });
  const official = Array.isArray(data.system_voice) ? data.system_voice.map(mapVoice) : [];
  const cloned = [
    ...(Array.isArray(data.voice_cloning) ? data.voice_cloning.map(mapVoice) : []),
    ...(Array.isArray(data.voice_generation) ? data.voice_generation.map(mapVoice) : []),
  ];
  return { official, cloned };
}

module.exports = { synthesize, resolveMinimaxVoice, listVoices, MINIMAX_DEFAULT_VOICE, MINIMAX_EMOTION };
