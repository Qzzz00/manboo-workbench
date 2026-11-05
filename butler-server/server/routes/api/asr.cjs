'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/routes/ai/asr.cjs(本机版改写)
//
//   POST /api/asr
//     - JSON:{ audio: <base64 或 data:audio/wav;base64,…>, hotwords?: string[] }
//     - 或裸 body:Content-Type: audio/wav(或 audio/x-wav、application/octet-stream)
//   → { text }
//
// 音频格式:WAV(PCM 16k / 16bit / 单声道)或裸 PCM,≤ 60 秒。Aiboo 的手机端就是这么发的
// (录音 blob → 16k 单声道 WAV → base64 → POST,见 Aiboo src/lib/asr.ts);火山「大模型流式识别」
// 只吃 PCM,webm/opus 这类压缩格式本机没有解码器,收到直接 415 说清楚。
//
// 上游是火山 WS 二进制协议,但对手机来说这是一次普通的 HTTP POST——**不需要工作台转发 WebSocket**。
// 凭证见 services/voiceCredentials.cjs;没有 → 503 + 人话。上游报错原文经 redact() 才进日志。

const express = require('express');
const { db } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const volcAsr = require('../../services/volcAsr.cjs');
const { asrNotConfigured, resolveAsrCreds, ensureWorkbenchCreds, redact } = require('../../services/voiceCredentials.cjs');

const MAX_SECONDS = 60;
const PCM_BYTES_PER_SECOND = 16000 * 2; // 16k / 16bit / mono
const MAX_PCM_BYTES = MAX_SECONDS * PCM_BYTES_PER_SECOND;
// base64 之后约 1.33 倍,再留 JSON 外壳的余量。
const JSON_LIMIT = '4mb';
const RAW_LIMIT = MAX_PCM_BYTES + 1024;

const RAW_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream', 'audio/pcm', 'audio/l16'];

/** 一眼能认出来的压缩容器:webm/mkv(EBML)、ogg、mp3、mp4/m4a、flac。 */
function sniffUnsupported(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  const head4 = buf.toString('ascii', 0, 4);
  if (head4 === 'OggS') return 'ogg/opus';
  if (head4 === 'fLaC') return 'flac';
  if (head4 === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && buf.length > 1000)) return 'mp3';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4/m4a';
  return null;
}

function unsupported(res, kind) {
  return res.status(415).json({
    code: 'unsupported_audio',
    error: `不支持 ${kind}:请把录音转成 wav(PCM 16k / 16bit / 单声道)再发`,
  });
}

const router = express.Router();

router.post(
  '/asr',
  adminAuthMiddleware,
  express.json({ limit: JSON_LIMIT }),
  express.raw({ type: RAW_TYPES, limit: RAW_LIMIT }),
  async (req, res) => {
    let buffer = null;
    let hotwords = [];
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
    } else if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
      return unsupported(res, contentType.split(';')[0]);
    } else {
      const { audio } = req.body || {};
      if (typeof audio !== 'string' || !audio) return res.status(400).json({ code: 'invalid_audio', error: '缺少音频数据(audio 字段,base64)' });
      const b64 = audio.startsWith('data:') ? audio.slice(audio.indexOf(',') + 1) : audio;
      buffer = Buffer.from(b64, 'base64');
      if (Array.isArray(req.body.hotwords)) hotwords = req.body.hotwords.filter((w) => typeof w === 'string');
    }
    if (!buffer || buffer.length === 0) return res.status(400).json({ code: 'invalid_audio', error: '音频数据为空' });
    const kind = sniffUnsupported(buffer);
    if (kind) return unsupported(res, kind);
    const pcm = volcAsr.extractPcm(buffer);
    if (pcm.length > MAX_PCM_BYTES) {
      return res.status(400).json({ code: 'audio_too_long', error: `一段最多 ${MAX_SECONDS} 秒,这段约 ${Math.round(pcm.length / PCM_BYTES_PER_SECOND)} 秒` });
    }

    // 第三个来源是工作台下发(2026-09-23):该拉就拉一次再解析。
    await ensureWorkbenchCreds();
    const creds = resolveAsrCreds(db);
    if (!creds) return res.status(503).json(asrNotConfigured());

    try {
      const text = await volcAsr.transcribe(buffer, creds, hotwords);
      return res.json({ text });
    } catch (err) {
      const message = (err && err.message) || '';
      if (message === 'EMPTY_TRANSCRIPT') return res.status(422).json({ code: 'empty_transcript', error: '没听清,请再说一遍' });
      console.warn('[butler-server] asr 失败', { message: redact(message, creds) });
      return res.status(502).json({ code: 'asr_failed', error: '语音识别失败,请稍后再试' });
    }
  },
);

module.exports = router;
module.exports.sniffUnsupported = sniffUnsupported;
