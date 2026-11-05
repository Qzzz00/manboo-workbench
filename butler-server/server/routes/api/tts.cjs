'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/routes/ai/tts.cjs(本机版改写)
//
//   POST /api/tts  { text, avatarId?, voiceId?, scene?, emotion?, speed?, tone?, toneNote? } → 音频字节(audio/mpeg 或供应商给的类型)
//
// 与 Aiboo 的差别:
//   - 鉴权 adminAuth(回环或 X-Workbench-Token),不再有用户 JWT / 设备 token 两套;
//   - 旅程「生命体征」的情绪覆盖(journey-engine)整段删掉:emotion 就是客户端传的;
//   - 没有可用的供应商密钥 → 503 { code:'voice_not_configured', error:一句能行动的人话 },不编假音频;
//     2026-09-23 起密钥两个来源:设置页(sqlite,优先)→ 工作台下发(只在内存),见 services/voiceCredentials.cjs;
//   - 合成走一道**串行队列**(services/ttsQueue.cjs,默认并发 1,`TTS_MAX_CONCURRENCY` 可配),
//     撞上火山「并发超限」时退避重试两次。2026-09-20:那次 502 的真因就是并发撞配额;
//   - 上游失败 → 502 { code:'tts_failed', error:一句人话, detail:上游原话(已 redact) };
//     detail 是 2026-09-20 加的:调用方(通道层工人)的日志里以前只看得见「502」,
//     原因躺在这台进程的 stderr 里,两份日志对不上时间就等于没有证据。脱敏口径不变。
// 音色解析规则照旧:形象在该场景的绑定权威 > 客户端 voiceId > 供应商默认音色。

const express = require('express');
const { db } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const ttsVoices = require('../../services/ttsVoices.cjs');
const ttsSynthesizer = require('../../services/ttsSynthesizer.cjs');
const minimax = require('../../services/minimax.cjs');
const { splitTextForTts, generateTtsChunk } = require('../../services/ttsChunker.cjs');
const { ttsNotConfigured, ttsProviderUsable, ensureWorkbenchCreds, redact } = require('../../services/voiceCredentials.cjs');
// 串行队列 + 并发超限退避重试(2026-09-20,决策记录「②补」):门设在离火山最近的地方,
// 因为这台服务不止一个调用方 —— 并发上限是这台服务的属性,不是某个调用方的自觉。
const { ttsQueue } = require('../../services/ttsQueue.cjs');
// 样音那一句(换音色时播给他听的自我介绍)合一次就落盘,下次秒出。门只认那一句,见该文件头。
const voiceSampleCache = require('../../services/voiceSampleCache.cjs');
// 火山错误码 → 人话(2026-09-27,卡 VO 第 ③ 件):`error` 这一格从此是**说给人听的那一句**,
// 通道层工人原样拿去当字幕(channel-worker/src/tts/butlerTts.ts 的 degradedText)。
const volcTtsErrors = require('../../services/volcTtsErrors.cjs');
// 语气 → 火山那三格(2026-10-02,卡「声音与形象跟着话走」)。映射在 services/toneMap.json。
const ttsTone = require('../../services/ttsTone.cjs');

const MAX_TEXT_CHARS = 2000;
// 从盘上直接回样音时贴哪个类型。**与 ttsSynthesizer 对同一个 encoding 回的那个一致**,
// 否则同一段字节走缓存和走合成会拿到两种类型,调用方那边要分两条路解码。
const SAMPLE_CONTENT_TYPE = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' };
// TTS 场景只认这几个(rtc 场景的供应商是通话用的,不能直接合成)。
const TTS_SCENES = new Set(['chat', 'dj_intro', 'dj_podcast']);
// 2026-09-17 通道层:允许调用方指定容器。默认仍是 mp3 —— 手机与管理台拿到的东西一个字节都没变。
// 通道层的工人要 wav:LiveKit 吃的是 PCM,mp3 还得再解一次码(要么装 ffmpeg,要么多一个纯 JS 解码器),
// 而 wav 自带采样率,截掉 44 字节头就能直接送进房间。dashscope 那条路只出 mp3,不认这个参数。
const TTS_ENCODINGS = new Set(['mp3', 'wav', 'pcm']);

function resolveVolcengineVoice(voice) {
  const trimmed = typeof voice === 'string' ? voice.trim() : '';
  const dashscopeVoiceIds = new Set(ttsVoices.DASHSCOPE_OFFICIAL_VOICES.map((item) => item.id));
  // 空 / dashscope 音色 id / 遗留传统 BV*_streaming → 回退到大模型默认音色。
  if (!trimmed || dashscopeVoiceIds.has(trimmed) || /^BV\d+_/i.test(trimmed)) {
    return ttsVoices.DEFAULT_VOLC_VOICE;
  }
  return trimmed;
}

const router = express.Router();
const parseJson = express.json({ limit: '256kb' });

router.post('/tts', adminAuthMiddleware, parseJson, async (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return res.status(400).json({ code: 'invalid_text', error: '缺少 text' });
  if (text.length > MAX_TEXT_CHARS) return res.status(400).json({ code: 'invalid_text', error: `text 太长(上限 ${MAX_TEXT_CHARS} 字)` });
  const scene = typeof body.scene === 'string' && body.scene ? body.scene : 'chat';
  if (!TTS_SCENES.has(scene)) return res.status(400).json({ code: 'invalid_scene', error: `scene 只能是 ${[...TTS_SCENES].join(' / ')}` });
  const encoding = typeof body.encoding === 'string' && body.encoding ? body.encoding : 'mp3';
  if (!TTS_ENCODINGS.has(encoding)) return res.status(400).json({ code: 'invalid_encoding', error: `encoding 只能是 ${[...TTS_ENCODINGS].join(' / ')}` });
  const avatarId = typeof body.avatarId === 'string' && body.avatarId ? body.avatarId : undefined;
  const requestedVoice = typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : undefined;

  // 工作台下发那一份该拉就拉(新鲜的话立刻回;8792 刚重启时第一句在这里等它)。
  await ensureWorkbenchCreds();
  const resolved = avatarVoiceStore.resolveVoice(db, avatarId, scene);
  const provider = resolved?.provider || null;
  if (!provider || !ttsProviderUsable(provider)) return res.status(503).json(ttsNotConfigured());
  // 有显式绑定 → 绑定音色权威;无绑定 → 客户端 voiceId,再不行用供应商默认。
  const boundVoice = resolved.source === 'binding' ? resolved.voiceId : (requestedVoice || resolved.voiceId);

  if (provider.provider_type === 'volcengine' || provider.provider_type === 'minimax') {
    const voice = provider.provider_type === 'volcengine'
      ? resolveVolcengineVoice(boundVoice)
      : minimax.resolveMinimaxVoice(provider.config, boundVoice);
    // 样音那一句:盘上有就直接回,一次上游都不跑。容器进键,wav 与 pcm 不会串。
    const cachedSample = voiceSampleCache.read(provider.provider_type, voice, encoding, text);
    if (cachedSample !== undefined) {
      res.setHeader('Content-Type', SAMPLE_CONTENT_TYPE[encoding] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(cachedSample);
    }
    try {
      /**
       * 语气(2026-10-02,卡「声音与形象跟着话走」)。工人在**两条路**上都带它 ——
       * 流式熔断之后落到这条老路上,她的语气不该跟着不见(那种分叉最难查)。
       * 认不得 → 空对象 = 不往下传 = 与 10-01 逐字相同。
       */
      const tone = ttsTone.resolveTone(
        typeof body.tone === 'string' ? body.tone : undefined,
        typeof body.toneNote === 'string' ? body.toneNote : undefined,
      );
      const { buffer, contentType } = await ttsQueue.run(() => ttsSynthesizer.synthesize({
        provider,
        text,
        voice,
        encoding,
        emotion: typeof body.emotion === 'string' ? body.emotion : undefined,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
        ...(Object.keys(tone).length === 0 ? {} : { tone }),
      }));
      voiceSampleCache.write(provider.provider_type, voice, encoding, text, buffer);
      res.setHeader('Content-Type', contentType || 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    } catch (error) {
      // detail:上游原话(脱敏后)原样带给调用方。2026-09-20 —— 通道层工人的日志里以前只有
      // 「合成失败(502)」,真正的原因(`volcengine TTS HTTP 429 code=3001 quota exceeded
      // for types: concurrency`)只躺在这台进程自己的 stderr 里,两份日志对不上时间就等于没有证据。
      // 脱敏走的还是同一个 redact(provider.config),密钥一个字符都不出口。
      const detail = redact(error && error.message, provider.config);
      console.warn('[butler-server] tts 合成失败', { provider: provider.provider_type, voice, message: detail });
      // 火山那一路:`error` 说人话(没开通 / 太挤 / 额度用完 / 念不了这段字),`detail` 照旧是原话。
      // MiniMax 走同一个分支,它的原话认不出来时 humanLine 会如实说「看不懂」,**不编一个意思**。
      const volc = provider.provider_type === 'volcengine';
      // cause:给调用方**分好格**的那一份 —— human 是一句能进字幕的短话,action 是该去哪做什么。
      // 工人只念 human(字幕里塞一整段控制台路径没人看),排查的人看 action 与 detail。
      const cause = volc ? volcTtsErrors.explain(detail) : undefined;
      return res.status(502).json({
        code: 'tts_failed',
        error: volc ? volcTtsErrors.humanLine(detail) : '语音合成失败,请稍后再试',
        ...(cause === undefined ? {} : { cause: { kind: cause.kind, human: cause.human, ...(cause.action === undefined ? {} : { action: cause.action }) } }),
        detail,
      });
    }
  }

  // DashScope:分段合成再拼接。
  const config = provider.config || {};
  try {
    const buffers = [];
    for (const chunk of splitTextForTts(text)) {
      // 分段本来就是串的;过一遍同一道闸,是为了让**整台服务**的并发上限只有一个口径。
      buffers.push(await ttsQueue.run(() => generateTtsChunk(chunk, config.model, boundVoice, 'Chinese', undefined, config.apiKey, config.apiUrl || undefined)));
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffers.length === 1 ? buffers[0] : Buffer.concat(buffers));
  } catch (error) {
    const detail = redact(error && error.message, config);
    console.warn('[butler-server] tts(dashscope) 合成失败', { message: detail });
    return res.status(502).json({ code: 'tts_failed', error: '语音合成失败,请稍后再试', detail });
  }
});

module.exports = router;
module.exports.resolveVolcengineVoice = resolveVolcengineVoice;
