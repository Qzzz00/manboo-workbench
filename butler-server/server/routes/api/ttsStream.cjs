'use strict';

// 流式合成(2026-09-23,冲着「合成首包 1.4~1.6 秒」去的)。
//
//   POST /api/tts/stream  { text, avatarId?, voiceId?, scene?, emotion?, speed?, tone?, toneNote? }
//     → 200 `application/vnd.butler.tts-stream`,**分块**回一串自描述的帧
//
// ## 为什么不是 /api/tts 加个参数
//
// `/api/tts` 的承诺是「回一段完整音频,Content-Type 是音频类型」——手机、管理台试听都靠它。
// 流式那条的回包**不是音频文件**(它是一串帧,末尾还要说一句「完了」还是「断了」),
// 两件事挤进一条路由,老调用方迟早会拿到一段它读不懂的字节。所以另开一条,老那条一个字节没动。
//
// ## 帧格式(两边各写一份,**改一处要改两处**)
//
//     [1B 类型][4B 大端长度][载荷]
//       1 = 音频(载荷 = 裸 16 位小端单声道 PCM)
//       2 = 完了(载荷空)
//       3 = 断了(载荷 = 一句人话,UTF-8)
//
// 另一份在 `channel-worker/src/tts/streamFrames.ts`。为什么不共用:两个子目录**互不 import**
// (AGENTS.md「仓库结构」),而这几十字节的格式抄一份比造一个共享包便宜。
// 采样率与声道数在响应头里(`x-tts-sample-rate` / `x-tts-channels`),不写死在协议里。
//
// ## 为什么末尾一定要有「完了 / 断了」
//
// 裸音频流断在半路和正常结束在字节上是同一件事。调用方分不出来,就只能把半句话当成整句播出去。
// 有了第 2/3 类帧,工人那边能如实说「这一句只合了一半」,而不是让她说半句就停。
//
// ## 回退与熔断(重要)
//
// 流式这条路**在这张卡上从没接过真的火山**(这台机器上没有密钥,也不该有)。所以:
//   · 一包音频都还没发出去就失败 → **当场回退**走老的非流式合成,把整段音频当成一个音频帧发出去。
//     调用方因此永远拿得到声音,最坏情况只是慢回从前那个样子。
//   · 回退发生过一次 → **熔断 `TTS_STREAM_COOLDOWN_MS`(缺省 10 分钟)**,这段时间里直接走非流式。
//     不熔断的话每一句都要先白试一次流式,那是**比从前更慢**,而不是一样慢。
//   · 已经发出音频之后才断 → 补一个「断了」帧,不回退(前半段已经在他耳朵里了,重播会结巴)。
//
// ## 样音那一句走缓存(2026-09-23 第二版)
//
// 电话里换音色要**先播给他听**,播的是一句固定的自我介绍(voiceSampleCache.SAMPLE_TEXT)。
// 这一句在这条路上进出两次:盘上有就**一次火山都不跑**直接发出去;没有就照常合,
// 合成功了顺手落一份。门只认那一句(`isSampleText`),别的文本一个字节都不落盘。
//
// 开关:`TTS_STREAM=off` 整条关掉(永远走非流式,行为逐字回到 09-22)。

const express = require('express');
const { db } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const ttsSynthesizer = require('../../services/ttsSynthesizer.cjs');
const volcTtsStream = require('../../services/volcTtsStream.cjs');
const { ttsNotConfigured, ttsProviderUsable, ensureWorkbenchCreds, redact } = require('../../services/voiceCredentials.cjs');
const { ttsQueue } = require('../../services/ttsQueue.cjs');
const voiceSampleCache = require('../../services/voiceSampleCache.cjs');
// 火山错误码 → 人话(2026-09-27,卡 VO 第 ③ 件)。流式这一路的错误帧也照它写。
const volcTtsErrors = require('../../services/volcTtsErrors.cjs');
const { resolveVolcengineVoice } = require('./tts.cjs');
// 语气 → 火山那三格(2026-10-02,卡「声音与形象跟着话走」)。映射在 services/toneMap.json。
const ttsTone = require('../../services/ttsTone.cjs');

const MAX_TEXT_CHARS = 2000;
const TTS_SCENES = new Set(['chat', 'dj_intro', 'dj_podcast']);

/** 帧类型。与 channel-worker/src/tts/streamFrames.ts 逐字对应。 */
const FRAME_AUDIO = 1;
const FRAME_END = 2;
const FRAME_ERROR = 3;

const STREAM_CONTENT_TYPE = 'application/vnd.butler.tts-stream';

/** 熔断多久(毫秒)。流式失败过一次就先别再试,免得每句都白试一次。 */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

function cooldownMs() {
  const raw = Number(process.env.TTS_STREAM_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_COOLDOWN_MS;
}

function streamEnabled() {
  const raw = String(process.env.TTS_STREAM ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(raw);
}

/** 一帧。载荷空也照发(「完了」那一帧就是空的)。 */
function frameOf(type, payload) {
  const body = payload === undefined ? Buffer.alloc(0) : payload;
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** 熔断状态。进程内存里,重启就忘 —— 它是「这会儿别试了」,不是账本。 */
const breaker = { until: 0, reason: '' };

/** 这会儿该不该试流式。 */
function streamAllowed(now = Date.now()) {
  return streamEnabled() && now >= breaker.until;
}

/** 流式没成:熔断一段时间。**只记一行**,不刷屏。 */
function tripBreaker(reason, now = Date.now()) {
  const ms = cooldownMs();
  breaker.until = now + ms;
  breaker.reason = reason;
  console.warn('[butler-server] 流式合成没走通,先回退非流式', { reason, cooldown_ms: ms });
}

/** 测试用:把熔断清掉。 */
function resetBreaker() {
  breaker.until = 0;
  breaker.reason = '';
}

const router = express.Router();
const parseJson = express.json({ limit: '256kb' });

router.post('/tts/stream', adminAuthMiddleware, parseJson, async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return res.status(400).json({ code: 'invalid_text', error: '缺少 text' });
  if (text.length > MAX_TEXT_CHARS) return res.status(400).json({ code: 'invalid_text', error: `text 太长(上限 ${MAX_TEXT_CHARS} 字)` });
  const scene = typeof body.scene === 'string' && body.scene ? body.scene : 'chat';
  if (!TTS_SCENES.has(scene)) return res.status(400).json({ code: 'invalid_scene', error: `scene 只能是 ${[...TTS_SCENES].join(' / ')}` });
  const avatarId = typeof body.avatarId === 'string' && body.avatarId ? body.avatarId : undefined;
  const requestedVoice = typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : undefined;

  // 音色解析与 /api/tts **同一个函数**:工作台里选的是哪个,电话里就是哪个,两条路不分叉。
  // 密钥两个来源(设置页优先 → 工作台下发),与 /api/tts 同一个口。
  await ensureWorkbenchCreds();
  const resolved = avatarVoiceStore.resolveVoice(db, avatarId, scene);
  const provider = resolved?.provider || null;
  if (!provider || !ttsProviderUsable(provider)) return res.status(503).json(ttsNotConfigured());
  const boundVoice = resolved.source === 'binding' ? resolved.voiceId : (requestedVoice || resolved.voiceId);
  const isVolc = provider.provider_type === 'volcengine';
  /**
   * **这条路只接火山**(2026-09-23)。
   *
   * 不是偷懒,是因为这条路由的回包里写死了「载荷是裸 PCM」:
   * minimax 的 `synthesize` **不认 encoding**(ttsSynthesizer.cjs 里明写着,传了会被忽略),
   * 回的是 mp3;把 mp3 的字节贴上「PCM」的标签发出去,工人那边会当成波形切帧 —— 那是一段噪音。
   * 所以别家一律如实说「这条路没有你」,调用方(工人)看见非 2xx 自己就回 `/api/tts` 了。
   */
  if (!isVolc) {
    return res.status(415).json({
      code: 'stream_unsupported',
      error: `${provider.provider_type} 没有流式合成这条路,请走 /api/tts`,
    });
  }
  const voice = resolveVolcengineVoice(boundVoice);

  const emotion = typeof body.emotion === 'string' ? body.emotion : undefined;
  const speed = typeof body.speed === 'number' ? body.speed : undefined;
  /**
   * **这一句的语气**(2026-10-02)。`tone` 是短列表 id(主人是 channel-worker/src/tts/tone.ts),
   * `toneNote` 是她写的那一句 ≤20 字指令。认不得 → 翻出来是个空对象 = 退回中性,
   * 请求体与 10-01 逐字相同(`resolveTone` 的纪律 ②)。
   */
  const tone = ttsTone.resolveTone(
    typeof body.tone === 'string' ? body.tone : undefined,
    typeof body.toneNote === 'string' ? body.toneNote : undefined,
  );
  const toneArg = Object.keys(tone).length === 0 ? undefined : tone;

  // 能不能流式:火山那条路有流式面;熔断期内先不试(理由见文件头)。
  const tryStream = streamAllowed();

  let sent = 0;
  const head = (backend) => {
    res.status(200);
    res.setHeader('Content-Type', STREAM_CONTENT_TYPE);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Tts-Sample-Rate', String(volcTtsStream.STREAM_SAMPLE_RATE));
    res.setHeader('X-Tts-Channels', '1');
    res.setHeader('X-Tts-Backend', backend);
    res.flushHeaders?.();
  };
  /** 样音那一句才收集、才落盘(门在 voiceSampleCache.isSampleText)。别的文本这里永远是 undefined。 */
  const sampling = voiceSampleCache.isSampleText(text) ? [] : undefined;
  const writeAudio = (chunk) => {
    if (chunk.length === 0) return;
    if (sent === 0) head(tryStream ? 'volc-stream' : 'oneshot');
    sent += 1;
    sampling?.push(chunk);
    res.write(frameOf(FRAME_AUDIO, chunk));
  };
  /** 这一句合完了:是样音就落一份盘。**写不成不作声**(缓存是加速,不是功能)。 */
  const keepSample = () => {
    if (sampling === undefined || sampling.length === 0) return;
    voiceSampleCache.write(provider.provider_type, voice, 'pcm', text, Buffer.concat(sampling));
  };

  // 样音而且盘上已经有了:直接发,**一次上游都不跑**。这是「下次秒播」那一句的兑现处。
  const cachedSample = voiceSampleCache.read(provider.provider_type, voice, 'pcm', text);
  if (cachedSample !== undefined) {
    head('sample-cache');
    sent += 1;
    res.write(frameOf(FRAME_AUDIO, cachedSample));
    res.write(frameOf(FRAME_END));
    res.end();
    return;
  }

  try {
    if (tryStream) {
      try {
        await ttsQueue.run(() => volcTtsStream.streamSynthesize({
          provider, text, voice, emotion, speed, ...(toneArg === undefined ? {} : { tone: toneArg }), onChunk: writeAudio,
        }));
        if (sent > 0) {
          keepSample();
          res.write(frameOf(FRAME_END));
          res.end();
          return;
        }
        // 没抛错、却一包音频都没有:当成没走通,回退。**不回一条空的流** ——
        // 空流在调用方那边只能变成「这一句没声音」,而这一句本来是合得出来的。
        tripBreaker('流式回了 0 包音频');
      }
      catch (error) {
        const detail = redact(error && error.message, provider.config);
        if (sent > 0) {
          // 已经出过声了:补一句实话就收尾。**不回退** —— 前半段已经在他耳朵里,重播会结巴。
          console.warn('[butler-server] 流式合成中途断了', { message: detail });
          res.write(frameOf(FRAME_ERROR, Buffer.from(`合成中途断了:${detail}`, 'utf8')));
          res.end();
          return;
        }
        tripBreaker(detail);
        // 一包都没发出去 → 往下走非流式,调用方照样拿得到声音。
      }
    }

    const { buffer } = await ttsQueue.run(() => ttsSynthesizer.synthesize({
      provider, text, voice, encoding: 'pcm', emotion, speed, ...(toneArg === undefined ? {} : { tone: toneArg }),
    }));
    head('oneshot');
    if (buffer.length > 0) {
      sent += 1;
      voiceSampleCache.write(provider.provider_type, voice, 'pcm', text, buffer);
      res.write(frameOf(FRAME_AUDIO, buffer));
    }
    res.write(frameOf(FRAME_END));
    res.end();
  }
  catch (error) {
    const detail = redact(error && error.message, provider.config);
    console.warn('[butler-server] tts/stream 合成失败', { provider: provider.provider_type, voice, message: detail });
    if (sent === 0 && !res.headersSent) {
      const cause = provider.provider_type === 'volcengine' ? volcTtsErrors.explain(detail) : undefined;
      res.status(502).json({
        code: 'tts_failed',
        error: cause === undefined ? '语音合成失败,请稍后再试' : volcTtsErrors.humanLine(detail),
        ...(cause === undefined ? {} : { cause: { kind: cause.kind, human: cause.human, ...(cause.action === undefined ? {} : { action: cause.action }) } }),
        detail,
      });
      return;
    }
    // 错误帧里放**人话**(工人拿它当字幕);原话已经在这台的日志里了。
    res.write(frameOf(FRAME_ERROR, Buffer.from(
      provider.provider_type === 'volcengine' ? volcTtsErrors.humanLine(detail) : detail, 'utf8',
    )));
    res.end();
  }
});

module.exports = router;
module.exports.frameOf = frameOf;
module.exports.streamAllowed = streamAllowed;
module.exports.tripBreaker = tripBreaker;
module.exports.resetBreaker = resetBreaker;
module.exports.FRAME_AUDIO = FRAME_AUDIO;
module.exports.FRAME_END = FRAME_END;
module.exports.FRAME_ERROR = FRAME_ERROR;
module.exports.STREAM_CONTENT_TYPE = STREAM_CONTENT_TYPE;
module.exports.DEFAULT_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
