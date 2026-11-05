'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/routes/voicePreview.cjs
// 本机版改动:样音目录改到 BUTLER_HOME/uploads/voice-preview;estimateDurationMs 原本来自 dj/ttsAdapter(DJ 没搬),
// 这里内联同样的估算;其余原样。admin-ui 的「配置」页 🔊 试听按钮调的就是这条(/api/voices/preview)。

// RTC / 基准音色试听（ALL-606 Wave 2 · B）。
//   POST /api/voices/preview                   合成一句短样音，返回短期音频 URL
//   GET  /api/voices/preview-audio/:id/:token  凭签名 token 读取已落盘的样音（免 admin 头）
//
// 合成通道复用既有 TTS 适配层（ttsSynthesizer → volcengine/minimax），绝不建立 RTC 通话：
//   - scene='base'：provider_id 落在 tts_models，直接按其 provider_type 合成。
//   - scene='rtc' ：provider_id 落在 rtc_providers（volcengine_rtc）；因「火山 RTC 与火山 TTS
//     共用 voice_type 命名空间」，试听用同一 voice_id 经火山 TTS 适配层合成短音频。RTC
//     provider 只做存在性/音色命名空间校验与 ttsAppId 反查，不调用 StartVoiceChat。
// 见 docs/voice-sync-contract.md §8。

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { adminAuthMiddleware } = require('../middleware/adminAuth.cjs');
const { db } = require('../db.cjs');
const ttsProviderStore = require('../services/ttsProviderStore.cjs');
const rtcProviderStore = require('../services/rtcProviderStore.cjs');
const ttsVoices = require('../services/ttsVoices.cjs');
const ttsSynthesizer = require('../services/ttsSynthesizer.cjs');
const { signPreviewToken, verifyPreviewToken } = require('../lib/previewToken.cjs');
const { UPLOADS_BASE } = require('../db.cjs');

// 来源:Aiboo origin/main 7c55ce12 server/dj/ttsAdapter.cjs 的 estimateDurationMs(原样;约 4 字/秒,只给界面显示)。
function estimateDurationMs(text) {
  if (!text) return 1000;
  const len = String(text).length;
  return Math.min(60000, Math.max(1000, Math.round(len * 250)));
}

const DEFAULT_PREVIEW_TEXT = '你好呀，这是音色试听效果～';
const MAX_CUSTOM_TEXT = 60;
// 短期有效：样音 URL 5 分钟内有效，与 previewToken 的 TTL 语义对齐。
const PREVIEW_TTL_MS = 5 * 60 * 1000;
// 合成超时：可经环境变量覆盖（默认 15s），便于测试收敛超时路径，生产缺省不变。
function synthTimeoutMs() {
  return Number.parseInt(process.env.VOICE_PREVIEW_SYNTH_TIMEOUT_MS || '15000', 10);
}

const VOICE_PREVIEW_DIR = process.env.VOICE_PREVIEW_UPLOADS_DIR
  ? path.resolve(process.env.VOICE_PREVIEW_UPLOADS_DIR)
  : path.join(UPLOADS_BASE, 'voice-preview');
fs.mkdirSync(VOICE_PREVIEW_DIR, { recursive: true });

// ── 限流（沿用 imageRateLimit 的滑动窗口机制，按 admin id 计数）────────
const previewRateLimit = new Map();
function readLimit() {
  return {
    windowMs: Number.parseInt(process.env.VOICE_PREVIEW_RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: Number.parseInt(process.env.VOICE_PREVIEW_RATE_LIMIT_MAX || '10', 10),
  };
}
function isPreviewRateLimited(adminId) {
  const { windowMs, max } = readLimit();
  const now = Date.now();
  const windowStart = now - windowMs;
  for (const [key, timestamps] of previewRateLimit.entries()) {
    const recent = timestamps.filter((ts) => ts > windowStart);
    if (recent.length > 0) previewRateLimit.set(key, recent);
    else previewRateLimit.delete(key);
  }
  const key = String(adminId);
  const timestamps = previewRateLimit.get(key) || [];
  if (timestamps.length >= max) return true;
  timestamps.push(now);
  previewRateLimit.set(key, timestamps);
  return false;
}

function normalizeText(text) {
  if (typeof text === 'string' && text.trim()) return text.trim().slice(0, MAX_CUSTOM_TEXT);
  return DEFAULT_PREVIEW_TEXT;
}

function loadProviderConfig(raw) {
  return { provider_type: raw.provider_type, config: JSON.parse(raw.config_json || '{}') };
}

// 为 RTC 试听反查一个可用于合成该 voice_type 的火山 TTS provider：
// 优先 appid 与 RTC 的 ttsAppId 一致的 tts_models 行，否则默认火山行，再否则任一火山行。
function resolveRtcSynthesisProvider(rtcConfig) {
  const ttsAppId = rtcConfig.ttsAppId;
  const rows = db
    .prepare("SELECT * FROM tts_models WHERE provider_type = 'volcengine' ORDER BY is_default DESC, created_at ASC")
    .all();
  let row = null;
  if (ttsAppId) {
    row = rows.find((r) => {
      try { return JSON.parse(r.config_json || '{}').appid === ttsAppId; } catch { return false; }
    }) || null;
  }
  if (!row) row = rows[0] || null;
  return row ? loadProviderConfig(row) : null;
}

// 超时包装：合成卡死/超时 fail-closed，返回稳定的 timeout 错误，不把上游原始错误透传。
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('voice preview timeout');
      err.timeout = true;
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const router = express.Router();

router.post('/api/voices/preview', adminAuthMiddleware, async (req, res) => {
  const adminId = req.admin?.id;
  if (isPreviewRateLimited(adminId)) {
    return res.status(429).json({ code: 'rate_limited', error: '试听太频繁，请稍后再试' });
  }

  const body = req.body || {};
  const scene = body.scene;
  if (scene !== 'rtc' && scene !== 'base') {
    return res.status(400).json({ code: 'invalid_scene', error: 'scene must be "rtc" or "base"' });
  }
  const providerId = typeof body.provider_id === 'string' ? body.provider_id.trim() : '';
  const voiceId = typeof body.voice_id === 'string' ? body.voice_id.trim() : '';
  if (!providerId) return res.status(400).json({ code: 'invalid_voice_ref', error: 'provider_id is required' });
  if (!voiceId) return res.status(400).json({ code: 'invalid_voice_ref', error: 'voice_id is required' });

  let synthProvider;
  if (scene === 'base') {
    const raw = ttsProviderStore.getRaw(db, providerId);
    if (!raw) {
      return res.status(400).json({ code: 'voice_provider_not_found', error: `TTS provider ${providerId} not found` });
    }
    if (!ttsVoices.voiceExists(raw.provider_type, voiceId)) {
      return res.status(400).json({ code: 'voice_not_found', error: `TTS voice ${voiceId} not found for provider ${providerId}` });
    }
    if (raw.provider_type === 'dashscope') {
      return res.status(400).json({ code: 'voice_preview_unsupported', error: '暂不支持 dashscope 音色试听（仅火山 / MiniMax）' });
    }
    synthProvider = loadProviderConfig(raw);
  } else {
    const raw = rtcProviderStore.getRaw(db, providerId);
    if (!raw) {
      return res.status(400).json({ code: 'voice_provider_not_found', error: `RTC provider ${providerId} not found` });
    }
    if (raw.provider_type !== 'volcengine_rtc') {
      return res.status(400).json({ code: 'voice_preview_unsupported', error: `暂不支持 ${raw.provider_type} 音色试听` });
    }
    if (!ttsVoices.voiceExists('volcengine_rtc', voiceId)) {
      return res.status(400).json({ code: 'voice_not_found', error: `RTC voice ${voiceId} not found for provider ${providerId}` });
    }
    synthProvider = resolveRtcSynthesisProvider(JSON.parse(raw.config_json || '{}'));
    if (!synthProvider) {
      return res.status(502).json({ code: 'voice_preview_unavailable', error: '未配置火山 TTS provider，无法试听 RTC 音色' });
    }
  }

  const text = normalizeText(body.text);

  let buffer;
  try {
    const result = await withTimeout(
      ttsSynthesizer.synthesize({ provider: synthProvider, text, voice: voiceId }),
      synthTimeoutMs(),
    );
    buffer = result.buffer;
  } catch (err) {
    if (err && err.timeout) {
      return res.status(504).json({ code: 'voice_preview_timeout', error: '试听超时，请稍后重试' });
    }
    // 脱敏：只记日志，不回传上游原始错误（可能含 key / 上游响应片段）。
    console.warn('[voice-preview] synth failed', { scene, providerId, message: err?.message });
    return res.status(502).json({ code: 'voice_preview_failed', error: '试听失败，请稍后重试' });
  }

  const id = crypto.randomUUID();
  // 两个合成器默认均产 mp3（volcengine encoding 缺省 mp3、minimax 输出 mp3），试听统一 mp3。
  const filePath = path.join(VOICE_PREVIEW_DIR, `${id}.mp3`);
  fs.writeFileSync(filePath, buffer);
  const token = signPreviewToken(id, 1, { ttlMs: PREVIEW_TTL_MS });
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();

  return res.json({
    audio_url: `/api/voices/preview-audio/${id}/${token}`,
    duration_ms: estimateDurationMs(text),
    expires_at: expiresAt,
  });
});

// 样音读取：token 内嵌 id + 过期时间，签名校验通过才放行；无 admin 头（供浏览器 <audio> 拉取）。
router.get('/api/voices/preview-audio/:id/:token', (req, res) => {
  const { id, token } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(403).json({ code: 'preview_invalid', error: '无效的预览地址' });
  }
  const verdict = verifyPreviewToken(token, id);
  if (!verdict.ok) {
    return res.status(403).json({ code: 'preview_expired', error: '预览已过期或无效' });
  }
  const filePath = path.join(VOICE_PREVIEW_DIR, `${id}.mp3`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ code: 'preview_not_found', error: '预览文件不存在' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
module.exports.DEFAULT_PREVIEW_TEXT = DEFAULT_PREVIEW_TEXT;
module.exports.normalizeText = normalizeText;
module.exports.resolveRtcSynthesisProvider = resolveRtcSynthesisProvider;
module.exports.isPreviewRateLimited = isPreviewRateLimited;
module.exports.withTimeout = withTimeout;
module.exports.synthTimeoutMs = synthTimeoutMs;
