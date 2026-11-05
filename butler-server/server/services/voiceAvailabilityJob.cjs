'use strict';

// 实取那趟活的**接线**(2026-09-27,卡 VO)。
// voiceAvailability.cjs 只管「怎么判断、怎么存」,不认识供应商、队列和合成器;
// 这一层把真家伙接上去,好让那一层能被单测直接喂假的。
//
// 纪律:
//   · 实取走**同一道串行闸**(ttsQueue)。它跟电话抢的是同一份火山并发配额,
//     插队进去的下场就是她正说着话突然哑一句(决策记录 09-20「②补」那条)。
//   · 永不抛。取不到就是「这次没取到」,调用方照旧有静态表可列。
//   · 上游原话先 redact 再交给分类器 —— 密钥一个字符都不进那份落盘的 JSON。

const ttsVoices = require('./ttsVoices.cjs');
const ttsSynthesizer = require('./ttsSynthesizer.cjs');
const { ttsQueue } = require('./ttsQueue.cjs');
const { ttsProviderUsable, redact } = require('./voiceCredentials.cjs');
const voiceAvailability = require('./voiceAvailability.cjs');

/** 这个供应商的候选音色(带 lang,探针要按语种挑话)。 */
function catalogFor(providerType) {
  if (providerType === 'volcengine' || providerType === 'volcengine_rtc') {
    return ttsVoices.VOLC_VOICE_CATALOG.filter((v) => v.supported !== false)
      .map((v) => ({ id: v.id, name: v.name, lang: v.lang, scene: v.scene }));
  }
  return ttsVoices.officialVoices(providerType).map((v) => ({ id: v.id, name: v.name, lang: v.lang }));
}

/** 真的去取一遍(await 到取完)。取不到回 undefined。 */
async function runRefresh(provider) {
  if (!provider || !ttsProviderUsable(provider)) return undefined;
  const providerType = provider.provider_type === 'volcengine_rtc' ? 'volcengine' : provider.provider_type;
  const catalog = catalogFor(providerType);
  if (catalog.length === 0) return undefined;
  try {
    return await voiceAvailability.refresh({
      provider: { ...provider, provider_type: providerType },
      catalog,
      synthesize: (args) => ttsQueue.run(async () => {
        try {
          return await ttsSynthesizer.synthesize(args);
        } catch (err) {
          // 原话脱敏之后再往上抛:再往上就是分类器和那份落盘的 JSON。
          throw new Error(redact((err && err.message) || '', provider.config));
        }
      }),
    });
  } catch (err) {
    console.warn('[butler-server] 音色实取没跑完', { message: redact((err && err.message) || '没说原因', provider.config) });
    return undefined;
  }
}

/**
 * **该取就在后台取一趟**(没取过 / 过期了),立刻返回,不让调用方等。
 * 电话里那条 `GET /api/voices` 是在她说话的当口调的 —— 一秒都不能多等。
 */
function kickIfNeeded(provider) {
  if (voiceAvailability.refreshing() !== undefined) return;
  const state = voiceAvailability.read();
  const providerType = provider && provider.provider_type === 'volcengine_rtc' ? 'volcengine' : (provider && provider.provider_type);
  const matches = state && state.provider_type === providerType;
  if (matches && !voiceAvailability.isStale(state)) return;
  // 起了就不管了:结果落盘,下一次请求自己就看得到。失败也只是「这次没取到」。
  void runRefresh(provider).catch(() => {});
}

module.exports = { catalogFor, runRefresh, kickIfNeeded };
