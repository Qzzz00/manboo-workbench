'use strict';

// 语音供应商密钥的统一取用口(2026-09-14,本机版新写)。
//
// 密钥只在设置页配置、只存 sqlite(tts_models.config_json / rtc_providers.config_json),这里只做「查得到就给、查不到就说没有」,
// 不读 env、不编默认值(2026-09-23 起多一个来源:工作台下发,只在内存,见下)。没有密钥时各接口回 503 + NOT_CONFIGURED_MESSAGE,绝不编假音频。
//
// 火山「大模型流式语音识别」(ASR)的凭证按这个顺序找:
//   1. 默认 RTC 供应商(volcengine_rtc)的 asrAppId / asrAccessToken / asrApiResourceId——通话本来就要它;
//   2. 默认火山 TTS 供应商的 appid / accessToken——火山控制台同一个应用可以同时开 TTS 与 ASR,Ben 只配一处也能用;
//   3. 工作台(8791)从服务器下发的 volc_asr(2026-09-23,见下);
//   4. 都没有 → null。
// 密钥不进日志、不进任何出口(AGENTS.md 凭据纪律)。
//
// ## 2026-09-23:第二个来源 —— 工作台下发(只在内存)
//
// 新装机器上 sqlite 里一个供应商都没有,/api/tts 一律 503,电话里她一个字都说不出。
// 现在 TTS 的解析顺序是:**sqlite 设置页里能用的那个(用户自己填的优先)→ 工作台下发的 volc_tts → 没有**。
// 下发那一份怎么来、为什么是 8792 去 8791 回环拉,见 workbenchVoiceCreds.cjs 文件头。
// 它被包成一个**虚拟供应商**(id = WORKBENCH_PROVIDER_ID,provider_type = volcengine),
// 于是整句合成、流式合成、电话里换音色、样音预热走的全是同一个口(resolveTtsDefault /
// avatarVoiceStore.resolveVoice),下游合成代码一行不用分叉。
// 这个虚拟供应商**不进 sqlite 的 tts_models**,设置页看不见它;电话里换音色时绑定行会记它的 id,
// 用户哪天自己在设置里填了供应商,那一行就让位(avatarVoiceStore.resolveVoice)。
//
// 都没有时的那句话不再是「未配置语音供应商密钥」(新用户读了会以为要自己去设置里填),
// 而是按原因说一句能行动的(ttsNotConfigured / asrNotConfigured)。

const ttsProviderStore = require('./ttsProviderStore.cjs');
const rtcProviderStore = require('./rtcProviderStore.cjs');
const workbenchVoiceCreds = require('./workbenchVoiceCreds.cjs');

const NOT_CONFIGURED_MESSAGE = '未配置语音供应商密钥';
const NOT_CONFIGURED = { code: 'voice_not_configured', error: NOT_CONFIGURED_MESSAGE };
const DEFAULT_ASR_RESOURCE_ID = 'volc.bigasr.sauc.duration';
/** 工作台下发那一份包成的虚拟 TTS 供应商的 id。不会与 sqlite 里的 nanoid 撞。 */
const WORKBENCH_PROVIDER_ID = '__workbench__';

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** 火山 ASR 凭证:{ appId, accessToken, resourceId, source } 或 null。 */
function resolveAsrCreds(db) {
  const rtc = rtcProviderStore.resolveDefault(db);
  if (rtc && rtc.provider_type === 'volcengine_rtc') {
    const appId = nonEmpty(rtc.config.asrAppId);
    const accessToken = nonEmpty(rtc.config.asrAccessToken);
    if (appId && accessToken) {
      return { appId, accessToken, resourceId: nonEmpty(rtc.config.asrApiResourceId) || DEFAULT_ASR_RESOURCE_ID, source: 'rtc' };
    }
  }
  const tts = ttsProviderStore.resolveDefault(db);
  if (tts && tts.provider_type === 'volcengine') {
    const appId = nonEmpty(tts.config.appid);
    const accessToken = nonEmpty(tts.config.accessToken);
    if (appId && accessToken) return { appId, accessToken, resourceId: DEFAULT_ASR_RESOURCE_ID, source: 'tts' };
  }
  const held = workbenchVoiceCreds.store.current();
  if (held && held.volcAsr) {
    const { appId, accessToken, resourceId } = held.volcAsr;
    return { appId, accessToken, resourceId: resourceId || DEFAULT_ASR_RESOURCE_ID, source: 'server' };
  }
  return null;
}

/** 默认 RTC 供应商(带明文 config)或 null。只认 volcengine_rtc 且 appId/appKey 齐全。 */
function resolveRtcProvider(db) {
  const provider = rtcProviderStore.resolveDefault(db);
  if (!provider || provider.provider_type !== 'volcengine_rtc') return null;
  const { appId, appKey } = provider.config || {};
  if (!nonEmpty(appId) || !nonEmpty(appKey)) return null;
  return provider;
}

/** 供应商 config 里能合成吗:火山要 appid+accessToken,MiniMax 要 apiKey+groupId,DashScope 要 apiKey+model。 */
function ttsProviderUsable(provider) {
  if (!provider || !provider.config) return false;
  const c = provider.config;
  switch (provider.provider_type) {
    case 'volcengine': return !!(nonEmpty(c.appid) && nonEmpty(c.accessToken));
    case 'minimax': return !!(nonEmpty(c.apiKey) && nonEmpty(c.groupId));
    case 'dashscope': return !!(nonEmpty(c.apiKey) && nonEmpty(c.model));
    default: return false;
  }
}

/**
 * 工作台下发的 volc_tts 包成的虚拟供应商,或 null。形状与 ttsProviderStore.resolveDefault 一致,
 * 所以 ttsSynthesizer / volcTtsStream / redact 都认它。**每次现包**:内存里那份换了,下一句就跟上。
 */
function workbenchTtsProvider() {
  const held = workbenchVoiceCreds.store.current();
  if (!held || !held.volcTts) return null;
  const { appId, accessToken, cluster, resourceId } = held.volcTts;
  return {
    id: WORKBENCH_PROVIDER_ID,
    name: '服务器下发',
    provider_type: 'volcengine',
    config: {
      appid: appId,
      accessToken,
      ...(cluster ? { cluster } : {}),
      ...(resourceId ? { resourceId } : {}),
    },
  };
}

/** sqlite 里设置页配的默认 TTS 供应商,**而且能用**;否则 null。 */
function usableSettingsTtsProvider(db) {
  const provider = ttsProviderStore.resolveDefault(db);
  return provider && ttsProviderUsable(provider) ? provider : null;
}

/**
 * 默认 TTS 供应商的统一解析口:sqlite 里能用的 → 工作台下发 → sqlite 里那个不能用的(调用方会据此 503)→ null。
 * 电话里换音色、样音预热、/health 都走它;/api/tts 与 /api/tts/stream 经 avatarVoiceStore.resolveVoice 落到它。
 */
function resolveTtsDefault(db) {
  return usableSettingsTtsProvider(db) || workbenchTtsProvider() || ttsProviderStore.resolveDefault(db);
}

/** 没有能用的 TTS 钥匙时那个 503 回包。error 是一句能行动的人话,见 workbenchVoiceCreds.ttsUnavailableMessage。 */
function ttsNotConfigured() {
  return { code: NOT_CONFIGURED.code, error: workbenchVoiceCreds.ttsUnavailableMessage(workbenchVoiceCreds.store.ttsFailure()) };
}

function asrNotConfigured() {
  return { code: NOT_CONFIGURED.code, error: workbenchVoiceCreds.asrUnavailableMessage(workbenchVoiceCreds.store.asrFailure()) };
}

/**
 * 给 /health 的那一格(**没有任何密钥,只有有没有、从哪来、为什么没有**)。
 *   source: settings = 设置页填的;server = 工作台下发;none = 都没有
 */
function ttsStatus(db) {
  if (usableSettingsTtsProvider(db)) return { ready: true, source: 'settings' };
  if (workbenchTtsProvider()) return { ready: true, source: 'server' };
  return { ready: false, source: 'none', note: ttsNotConfigured().error };
}

/**
 * 日志脱敏:把 secrets 里出现的任何值(以及 config 里 8 位以上的字符串值)从消息里抹掉。
 * 上游报错原文偶尔会把请求头/请求体回显出来,这一层保证密钥不进日志。
 */
function redact(message, ...secretSources) {
  let out = String(message == null ? '' : message);
  for (const src of secretSources) {
    const values = typeof src === 'string' ? [src] : (src && typeof src === 'object' ? Object.values(src) : []);
    for (const v of values) {
      if (typeof v === 'string' && v.length >= 8 && out.includes(v)) out = out.split(v).join('[已隐去]');
    }
  }
  return out;
}

module.exports = {
  NOT_CONFIGURED_MESSAGE,
  NOT_CONFIGURED,
  DEFAULT_ASR_RESOURCE_ID,
  WORKBENCH_PROVIDER_ID,
  resolveAsrCreds,
  resolveRtcProvider,
  ttsProviderUsable,
  workbenchTtsProvider,
  usableSettingsTtsProvider,
  resolveTtsDefault,
  ttsNotConfigured,
  asrNotConfigured,
  ttsStatus,
  /** 该拉就向工作台拉一次下发的钥匙(永不抛)。要用 TTS/ASR 的路由先 await 它。 */
  ensureWorkbenchCreds: () => workbenchVoiceCreds.ensure(),
  redact,
};
