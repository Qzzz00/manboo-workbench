'use strict';

// 电话里换音色(2026-09-23,Ben 第五通:「你的声音太像豆包了,我要换一个」
// 「把音色这个事情改成可以配置的,而且是我在电话通话中能够改的」)。
//
//   GET  /api/voices           能换成哪几个 + 现在是哪一个(**每条带标签与一句人话简介**)
//   PUT  /api/voices/current   { voice_id } → 换,**当场生效**(下一句话就是新嗓子)
//   POST /api/voices/passed    { voice_ids } → 「这几个念过了他没要」,下次别再推同一批
//   POST /api/voices/sample    { voice_id } → 把那个音色的样音**先合出来落盘**,下次秒播
//
// 2026-09-23 第二版(Ben 真机第二通:她念了三个名字,他说「怎么都是女的」):
// 清单**每条带标签**(性别 / 年龄感 / 风格 / 语言口音 / 一句人话),这样工人才挑得动
// 「沉稳一点的男声」。标签在 services/voices-catalog.json,怎么来的写在那个文件头上;
// 推不出来的写「未标」—— **「未标」是一个真答案**,不编。
//
// 为什么这两条挂在 /api 而不是 /admin:调它的是**通道层工人**(回环),
// 它跟 /api/tts、/api/asr 是同一类调用方 —— 电话那条链路上的东西。
// 鉴权仍是 adminAuth(回环或 X-Workbench-Token),和这台服务上其它所有路由一样。
//
// **不另存一份音色配置**:写的是 avatar_voice_bindings 里那条保留行
// (avatarVoiceStore 的 CALL_AVATAR_ID),也正是 /api/tts、/api/tts/stream、/health
// 解析「没点形象时用哪个音色」时读的那一条。于是「她说换好了」与「下一句话的嗓子」
// 是同一个事实,不会一个改了另一个没跟上(D13)。
//
// **复刻音色不在这里列**:拉它要带 AK/SK 去火山跑一趟网络,而这条路由是电话里
// 等着念给他听的 —— 网慢一次她就哑在那儿。后台 /admin/tts-voices 那条照旧能拉。

const express = require('express');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const { db } = require('../../db.cjs');
const ttsVoices = require('../../services/ttsVoices.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const voiceTags = require('../../services/voiceTags.cjs');
const voiceSampleCache = require('../../services/voiceSampleCache.cjs');
const voicePickMemory = require('../../services/voicePickMemory.cjs');
const ttsSynthesizer = require('../../services/ttsSynthesizer.cjs');
const { ttsQueue } = require('../../services/ttsQueue.cjs');
const { ttsProviderUsable, resolveTtsDefault, ttsNotConfigured, ensureWorkbenchCreds, redact } = require('../../services/voiceCredentials.cjs');
// 音色单**按账号实取**(2026-09-27,卡 VO):这里只列取回来真能用的那些;
// 一次都没取到时照列本地清单,但回包里明说「这次没取到」——不假装它是实取的。
const voiceAvailability = require('../../services/voiceAvailability.cjs');
const voiceAvailabilityJob = require('../../services/voiceAvailabilityJob.cjs');
const volcTtsErrors = require('../../services/volcTtsErrors.cjs');
// 「这个嗓子会不会念中文」(2026-09-28,卡 VC)。真机那一晚换到英文女声 Dacey / Stokie,
// 从此每一句中文都 3011,他打过去一直没声音。见 services/voiceLanguage.cjs 的文件头。
const voiceLanguage = require('../../services/voiceLanguage.cjs');

/** 样音落盘用的容器:与 /api/tts/stream 缓存的那一种**必须一致**(裸 PCM),否则白合一次。 */
const SAMPLE_ENCODING = 'pcm';

const router = express.Router();

/**
 * 实取那一份里,这个音色**明确用不了**的原因(一句人话);能用 / 没取过 → undefined。
 * 「没取过」不是「不能用」——那种时候照放行,下一句真合不出来会有自己的报错。
 */
function unavailableReason(providerType, voiceId) {
  const state = voiceAvailability.read();
  if (!state || state.provider_type !== providerType) return undefined;
  const row = state.voices[voiceId];
  if (row === undefined || row.ok === true) return undefined;
  return row.why || volcTtsErrors.explain('').human;
}

/** 这个 id 在目录里那一条的语种信息(`{ lang, accent }`)。查不到就空着 —— 空着 = 「不知道」。 */
function languageOf(providerType, voiceId) {
  const known = ttsVoices.officialVoices(providerType).find((v) => v.id === voiceId);
  const tags = voiceTags.tagsOf(providerType, voiceId);
  return { ...(known ? { lang: known.lang } : {}), ...(tags ? { accent: tags.accent } : {}) };
}

// 电话这一路解析出来的音色 = resolveVoice(db, undefined, 'chat'),与 /api/tts 同一个函数。
function currentVoice() {
  try {
    const resolved = avatarVoiceStore.resolveVoice(db, undefined, 'chat');
    if (!resolved || !resolved.provider) return null;
    const id = typeof resolved.voiceId === 'string' ? resolved.voiceId.trim() : '';
    if (!id) return null;
    const type = resolved.provider.provider_type;
    const known = ttsVoices.officialVoices(type).find((v) => v.id === id);
    // 标签同理:目录里没有这条(复刻音色)就一格都不贴,只如实标 verified:false。
    const tags = voiceTags.tagsOf(type, id);
    // 会不会念中文:判不出来的**不贴这一格**(缺席就是「不知道」,不是「不会」)。
    const chinese = voiceLanguage.speaksChinese(languageOf(type, id));
    return {
      id,
      // 目录里没有这个 id(复刻音色)就不编一个名字,如实只给 id。
      ...(known ? { name: known.name, lang: known.lang } : {}),
      ...(tags === undefined ? { verified: false } : tags),
      ...(chinese === undefined ? {} : { speaks_chinese: chinese }),
      provider_type: type,
      source: resolved.source,
    };
  } catch {
    return null;
  }
}

/**
 * 换之前**先拿一句中文真合一次**(2026-09-28,卡 VC)。
 *
 * 为什么不是「按目录挡住英文音色就完了」:目录是我们标的,会过时,也盖不住复刻音色
 * (S_/BV 一格语种都没有)。**真话只有火山自己说得出来** —— 所以这里问它一句「你念不念中文」。
 *
 * 纪律:
 *   · 目录里明写着会念中文 → **一个字都不白合**(95 条里有 95 条是这种,电话里等不起);
 *   · 样音缓存里已经有那一句中文 → 它念得出中文,不用再问;
 *   · 回 3011(念不了这段字) → `{ ok:false }`,**不换**;
 *   · 回别的(太挤 / 网慢 / 没开通) → 照放行:那不是语种的事,拦了等于凭空少半张表
 *     (「没开通」有它自己那道 unavailableReason 关);
 *   · 密钥不全试不了 → 目录说「不会」的挡住,说「不知道」的放行。
 */
async function probeChinese(provider, voiceId) {
  const known = voiceLanguage.speaksChinese(languageOf(provider.provider_type, voiceId));
  if (known === true) return { ok: true };
  if (voiceSampleCache.has(provider.provider_type, voiceId, SAMPLE_ENCODING)) return { ok: true };
  if (!ttsProviderUsable(provider)) {
    return known === false
      ? { ok: false, why: '音色目录里写着它只会念别的语种,而这台的密钥不全,试不了一句中文' }
      : { ok: true };
  }
  const text = voiceLanguage.CHINESE_PROBE_TEXT;
  try {
    await ttsQueue.run(() => ttsSynthesizer.synthesize({ provider, text, voice: voiceId, encoding: SAMPLE_ENCODING }));
    return { ok: true };
  } catch (error) {
    const detail = redact(error && error.message, provider.config);
    if (!voiceLanguage.meansCannotSpeakChinese(detail)) {
      console.warn('[butler-server] 换音色前那句中文没试成(不是语种的事,照换)', { voice: voiceId, message: detail });
      return { ok: true };
    }
    return { ok: false, why: volcTtsErrors.explain(detail).human, detail };
  }
}

router.get('/', adminAuthMiddleware, async (req, res) => {
  // 默认供应商与 /api/tts 同一个解析口(2026-09-23):设置页能用的 → 工作台下发 → 没有。
  await ensureWorkbenchCreds();
  const provider = resolveTtsDefault(db);
  if (!provider) {
    // 一个供应商都没配:如实说,**不给一张假的音色单**(她会念出来,而一个都换不成)。
    res.status(503).json(ttsNotConfigured());
    return;
  }
  // 没取过 / 过期了就在后台取一趟(**不等它**:这条路是她在电话里说话的当口调的)。
  voiceAvailabilityJob.kickIfNeeded(provider);
  const picked = voiceAvailability.applyTo(
    provider.provider_type,
    voiceTags.decorate(provider.provider_type, ttsVoices.officialVoices(provider.provider_type)),
  );
  res.json({
    provider_type: provider.provider_type,
    current: currentVoice(),
    // 每条带 `speaks_chinese`(2026-09-28,卡 VC):工人靠它把「只会念英文」的挡在推荐之外。
    // 判不出来的那几条**没有这一格** —— 缺席是「不知道」,不是「不会」。
    voices: voiceLanguage.mark(picked.voices),
    // 这一单是什么时候、怎么取回来的。取不到时 fetched_at 是 null,note 里写着实话 ——
    // 工人照这句说,**不许**把本地清单说成「这个账号能用的」。
    availability: picked.availability,
    // 挑的时候要避开的两张名单(他挑过的 / 念过他没要的)。见 services/voicePickMemory.cjs。
    history: voicePickMemory.read(),
    // 样音那一句。**工人照这一句原样念**,盘上的缓存就是按它的 sha1 存的。
    sample_text: voiceSampleCache.SAMPLE_TEXT,
    // 标签是怎么来的 —— 一并交给调用方,她在电话里被追问时说得出实话。
    tagging: voiceTags.CATALOG.tagging_method,
  });
});

/**
 * 换成这一个。
 *
 * `preview:true` = **只是播给他听听**(工人逐个试音那几下)。音色照换不误(不换就听不见),
 * 但**不记进「他挑过的」** —— 把试听算成「他选过这个」,下一轮就再也挑不出生面孔了。
 */
router.put('/current', adminAuthMiddleware, async (req, res) => {
  const voiceId = typeof (req.body || {}).voice_id === 'string' ? req.body.voice_id.trim() : '';
  const preview = (req.body || {}).preview === true;
  if (!voiceId) {
    res.status(400).json({ code: 'invalid_voice', error: 'voice_id 不能为空' });
    return;
  }
  await ensureWorkbenchCreds();
  const provider = resolveTtsDefault(db);
  if (!provider) {
    res.status(503).json(ttsNotConfigured());
    return;
  }
  // 目录里没有的一律拒绝:换成一个供应商不认的 id,下一句话会 400 或者掉回默认嗓子,
  // 而电话里已经说过「换好了」。复刻音色(S_/BV 命名空间)由 voiceExists 放行。
  if (!ttsVoices.voiceExists(provider.provider_type, voiceId)) {
    res.status(400).json({ code: 'invalid_voice', error: `这个供应商没有「${voiceId}」这个音色` });
    return;
  }
  // 实取时明确合不出来的(这一档没开通 / 额度用完)也拒绝,并**说出为什么**。
  // 2026-09-26 那一天就是这里放行了一个换不成的音色:她说「换好了」,下一句一个字都没有。
  const blocked = unavailableReason(provider.provider_type, voiceId);
  if (blocked !== undefined) {
    res.status(400).json({ code: 'voice_not_granted', error: `「${voiceId}」这个账号用不了:${blocked}` });
    return;
  }
  // **换之前先试一句中文**(2026-09-28,卡 VC)。试不出声就不换 —— 换过去他这一整通电话
  // 一个字都听不见,而她已经说过「换好了」(真机 09-28 19:2x 那一晚就是这么哑了二十分钟)。
  const chinese = await probeChinese(provider, voiceId);
  if (chinese.ok === false) {
    const now = currentVoice();
    const stay = now && now.name ? `「${now.name}」` : (now ? `「${now.id}」` : '原来那个');
    res.status(400).json({
      code: 'voice_cannot_speak_chinese',
      error: `「${voiceId}」念不了中文(${chinese.why}),没换,还用${stay}。`,
      ...(chinese.detail === undefined ? {} : { detail: chinese.detail }),
    });
    return;
  }
  try {
    avatarVoiceStore.setCallVoice(db, { providerId: provider.id, voiceId });
  } catch (err) {
    res.status(400).json({ code: 'invalid_voice', error: (err && err.message) || '换不了音色' });
    return;
  }
  // 他真选中了这一个:记一笔,下次挑的时候不再当成生面孔推给他。**记不成不影响换**。
  // 试听(preview)不记 —— 理由见上面那段注释。
  if (!preview) voicePickMemory.recordPicked(voiceId);
  res.json({ ok: true, voice: currentVoice(), history: voicePickMemory.read() });
});

/**
 * 「这几个念给他听过、他没要」。下一批别再推同一批(Ben 2026-09-23)。
 *
 * 为什么是一条**单独的**窄口而不是塞进 PUT:他很可能三个都不要(「换一批」),
 * 那一轮**一个都没换**,没有 PUT 可搭。
 */
router.post('/passed', adminAuthMiddleware, express.json({ limit: '16kb' }), (req, res) => {
  const ids = Array.isArray((req.body || {}).voice_ids) ? req.body.voice_ids : [];
  const history = voicePickMemory.recordPassed(ids);
  res.json({ ok: true, history });
});

/**
 * 把某个音色的**样音先合出来落盘**,下次秒播(Ben:「要么就是你先播给他听」)。
 *
 * 合的是 {@link voiceSampleCache.SAMPLE_TEXT} 那一句,容器是裸 PCM —— 与
 * `/api/tts/stream` 缓存的那一种**同一个键**,所以这里合过一次,真播的时候直接从盘上走。
 *
 * 调用方(工人)是**拿它预热下一个候选**的:第一个正在他耳朵里响的那几秒,
 * 第二个已经在合了。所以这条路**慢是正常的**,失败也只是「下一个照旧现合」——
 * 回 200 带 `synthesized:false` 和一句原因,不回 5xx(它不是一件办砸了的事)。
 */
router.post('/sample', adminAuthMiddleware, express.json({ limit: '16kb' }), async (req, res) => {
  const voiceId = typeof (req.body || {}).voice_id === 'string' ? req.body.voice_id.trim() : '';
  if (!voiceId) {
    res.status(400).json({ code: 'invalid_voice', error: 'voice_id 不能为空' });
    return;
  }
  await ensureWorkbenchCreds();
  const provider = resolveTtsDefault(db);
  if (!provider) {
    res.status(503).json(ttsNotConfigured());
    return;
  }
  if (!ttsVoices.voiceExists(provider.provider_type, voiceId)) {
    res.status(400).json({ code: 'invalid_voice', error: `这个供应商没有「${voiceId}」这个音色` });
    return;
  }
  const text = voiceSampleCache.SAMPLE_TEXT;
  if (voiceSampleCache.has(provider.provider_type, voiceId, SAMPLE_ENCODING)) {
    res.json({ ok: true, voice_id: voiceId, text, cached: true, synthesized: false });
    return;
  }
  if (!ttsProviderUsable(provider)) {
    res.json({ ok: true, voice_id: voiceId, text, cached: false, synthesized: false, note: '这个供应商的密钥不全,样音没合成' });
    return;
  }
  try {
    const { buffer } = await ttsQueue.run(() => ttsSynthesizer.synthesize({
      provider, text, voice: voiceId, encoding: SAMPLE_ENCODING,
    }));
    const cached = voiceSampleCache.write(provider.provider_type, voiceId, SAMPLE_ENCODING, text, buffer);
    res.json({ ok: true, voice_id: voiceId, text, cached, synthesized: true });
  } catch (error) {
    const detail = redact(error && error.message, provider.config);
    console.warn('[butler-server] 样音预热没成', { voice: voiceId, message: detail });
    // note 是**说给人听的那一句**(火山错误码 → 人话 + 去哪开);原话另放 detail,留给查的人。
    res.json({ ok: true, voice_id: voiceId, text, cached: false, synthesized: false, note: volcTtsErrors.humanLine(detail), detail });
  }
});

module.exports = router;
module.exports.SAMPLE_ENCODING = SAMPLE_ENCODING;
