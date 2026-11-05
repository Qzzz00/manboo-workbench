'use strict';

// 来源:Aiboo origin/main 1f430c3f server/routes/admin/ttsVoices.cjs
// GET /admin/tts-voices —— 给后台音色下拉用：官方精选 + 账号复刻音色。
// 默认按指定 provider（?providerId=&kind=tts|rtc）决定 provider_type；不传则回落全局默认 TTS provider。
// 火山(含 RTC)+有 AK/SK 时拉复刻音色，失败优雅降级。

const express = require('express');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const { db } = require('../../db.cjs');
const ttsProviderStore = require('../../services/ttsProviderStore.cjs');
const rtcProviderStore = require('../../services/rtcProviderStore.cjs');
const ttsVoices = require('../../services/ttsVoices.cjs');
const volcengine = require('../../services/volcengine.cjs');
const minimax = require('../../services/minimax.cjs');
// 2026-09-27 卡 VO:下拉里**只列这个账号实取回来能用的**;实取怎么来见 voiceAvailability.cjs。
const voiceAvailability = require('../../services/voiceAvailability.cjs');
const voiceAvailabilityJob = require('../../services/voiceAvailabilityJob.cjs');
const volcTtsErrors = require('../../services/volcTtsErrors.cjs');
const { resolveTtsDefault, ttsProviderUsable, ensureWorkbenchCreds, ttsNotConfigured, redact } = require('../../services/voiceCredentials.cjs');

const router = express.Router();

// 解析「按哪个 provider 取音色」。providerId 指定则用它；否则全局默认 TTS。
// 返回 { providerType, config } 或 null。
function resolveTargetProvider(req) {
  const providerId = typeof req.query.providerId === 'string' ? req.query.providerId.trim() : '';
  const kind = req.query.kind === 'rtc' ? 'rtc' : 'tts';
  if (providerId) {
    const raw = kind === 'rtc' ? rtcProviderStore.getRaw(db, providerId) : ttsProviderStore.getRaw(db, providerId);
    if (!raw) return null;
    return { providerType: raw.provider_type, config: JSON.parse(raw.config_json || '{}') };
  }
  const def = ttsProviderStore.resolveDefault(db);
  return def ? { providerType: def.provider_type, config: def.config } : { providerType: 'dashscope', config: {} };
}

// 火山 RTC 与火山 TTS 共用 voice_type 命名空间 → RTC provider 复用火山官方音色目录。
function officialFor(providerType) {
  if (providerType === 'volcengine_rtc') return ttsVoices.officialVoices('volcengine');
  return ttsVoices.officialVoices(providerType);
}

router.get('/', adminAuthMiddleware, async (req, res) => {
  const target = resolveTargetProvider(req);
  if (!target) return res.status(404).json({ error: 'provider not found' });
  const { providerType, config } = target;
  let official = officialFor(providerType);

  let cloned = [];
  let clonedError = null;
  const isVolcKind = providerType === 'volcengine' || providerType === 'volcengine_rtc';
  if (isVolcKind && config.ak && config.sk) {
    try {
      cloned = await volcengine.listClonedVoices({ ak: config.ak, sk: config.sk, appid: config.appid });
    } catch (err) {
      clonedError = err.message || '复刻音色拉取失败';
    }
  } else if (providerType === 'minimax' && config.apiKey && config.groupId) {
    // MiniMax 系统音色 300+ 实时拉取(get_voice)，连同账号复刻/生成音色；失败降级到本地兜底目录。
    try {
      const live = await minimax.listVoices({ apiKey: config.apiKey, groupId: config.groupId, apiUrl: config.apiUrl });
      if (live.official.length > 0) official = live.official;
      cloned = live.cloned;
    } catch (err) {
      clonedError = err.message || 'MiniMax 音色拉取失败（已回退本地目录）';
    }
  }

  // 火山这一路:把静态目录裁成「实取回来这个账号真能用的」。没取过就在后台取一趟,
  // 这一次照列本地清单 —— availability.note 里明说「这次没取到」,页面照它显示。
  let availability;
  if (isVolcKind) {
    const runnable = resolveTtsDefault(db);
    if (runnable) voiceAvailabilityJob.kickIfNeeded(runnable);
    const picked = voiceAvailability.applyTo('volcengine', official);
    official = picked.voices;
    availability = picked.availability;
  }

  res.json({ provider_type: providerType, official, cloned, clonedError, ...(availability === undefined ? {} : { availability }) });
});

/**
 * **手动重取一遍**(2026-09-27)。维护者刚在火山控制台开通/退订了一档,不想等过期。
 *
 * 一趟要逐个音色试合一句,99 条要两三分钟 —— 所以这里**起了就回**(202),
 * 页面轮 `GET /admin/tts-voices` 看 `availability.refreshing` 与 `fetched_at`。
 */
router.post('/refresh', adminAuthMiddleware, async (req, res) => {
  await ensureWorkbenchCreds();
  const provider = resolveTtsDefault(db);
  if (!provider || !ttsProviderUsable(provider)) return res.status(503).json(ttsNotConfigured());
  const already = voiceAvailability.refreshing();
  if (already === undefined) void voiceAvailabilityJob.runRefresh(provider).catch(() => {});
  return res.status(202).json({
    ok: true,
    started: already === undefined,
    note: already === undefined ? '开始向火山逐个试音色了,两三分钟;好了这一页自己会变。' : '已经在取了,等它跑完。',
    refreshing: voiceAvailability.refreshing() || already,
  });
});

// POST /admin/tts-voices/preview —— 试听：用指定(或默认)火山 TTS provider 合成一句样音。
// body: { voice, text?, providerId? }。直接用传入 voice（不做回退），让后台真实判断可用性。
router.post('/preview', adminAuthMiddleware, async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '';
  // 2026-09-27:不指定 providerId 时走**统一解析口**(设置页填的 → 工作台下发的)。
  // 在这之前这里只认 sqlite 里的,于是「钥匙由服务器下发」的那种机器上试听一律 400
  // (09-27 实取时撞见:电话里能出声,后台一按 🔊 就说「未找到 TTS provider」)。
  await ensureWorkbenchCreds();
  const provider = providerId
    ? (() => {
        const raw = ttsProviderStore.getRaw(db, providerId);
        return raw ? { provider_type: raw.provider_type, config: JSON.parse(raw.config_json || '{}') } : null;
      })()
    : resolveTtsDefault(db);
  if (!provider) return res.status(400).json({ error: '未找到 TTS provider' });

  const voice = typeof req.body?.voice === 'string' ? req.body.voice.trim() : '';
  if (!voice) return res.status(400).json({ error: 'voice is required' });
  const text = typeof req.body?.text === 'string' && req.body.text.trim()
    ? req.body.text.trim().slice(0, 60)
    : '你好呀，这是音色试听效果～';

  // 按 provider 类型选合成器：火山 / MiniMax 都支持试听；dashscope 走客户端流程，这里不试听。
  const synth = provider.provider_type === 'volcengine'
    ? volcengine.synthesize
    : provider.provider_type === 'minimax'
      ? minimax.synthesize
      : null;
  if (!synth) {
    return res.status(400).json({
      error: `暂不支持 ${provider.provider_type} 音色试听（仅火山 / MiniMax）`,
    });
  }

  try {
    const { buffer, contentType } = await synth({ config: provider.config, text, voice });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (err) {
    // 火山错误码 → 一句人话 + 去哪开(volcTtsErrors)。原话脱敏后另放 detail。
    const detail = redact((err && err.message) || '', provider.config);
    return res.status(502).json({ error: volcTtsErrors.humanLine(detail), detail });
  }
});

module.exports = router;
