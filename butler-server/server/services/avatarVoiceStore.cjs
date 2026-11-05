'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/avatarVoiceStore.cjs
// 角色 × 场景级音色绑定。一个「音色」= (provider, voiceId)：provider 指向 provider 库行
// （TTS 场景 → tts_models；RTC 场景 → rtc_providers），类型从库行派生，绝不从 voice 字符串猜。
// 见 docs/superpowers/specs/2026-06-25-per-character-scene-tts-voice-design.md。

const ttsProviderStore = require('./ttsProviderStore.cjs');
const rtcProviderStore = require('./rtcProviderStore.cjs');
const ttsVoices = require('./ttsVoices.cjs');
const minimax = require('./minimax.cjs');
// 2026-09-23:TTS 默认供应商多了「工作台下发」那个虚拟供应商(只在内存),解析口统一在这里。
const voiceCredentials = require('./voiceCredentials.cjs');

// chat 为基准；dj_intro/dj_podcast 不覆盖则继承 chat；rtc 是另一种 provider 类型，独立解析。
const SCENES = ['chat', 'dj_intro', 'dj_podcast', 'rtc'];
const SCENE_SET = new Set(SCENES);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_voice_binding';
  }
}

function providerKindForScene(scene) {
  return scene === 'rtc' ? 'rtc' : 'tts';
}

// 取 provider 库行并解出明文 config，统一成 { id, name, provider_type, config }。
function loadProvider(db, kind, providerId) {
  // 工作台下发那一份不在 sqlite 里:按 id 认出来,现包一个(没下发就当它不存在)。
  if (kind === 'tts' && providerId === voiceCredentials.WORKBENCH_PROVIDER_ID) return voiceCredentials.workbenchTtsProvider();
  const raw = kind === 'rtc' ? rtcProviderStore.getRaw(db, providerId) : ttsProviderStore.getRaw(db, providerId);
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name,
    provider_type: raw.provider_type,
    config: JSON.parse(raw.config_json || '{}'),
  };
}

// 某 provider 的「默认音色」——用于无显式 voice 时的末级兜底。
function defaultVoiceForProvider(provider) {
  if (!provider) return null;
  switch (provider.provider_type) {
    case 'volcengine':
    case 'volcengine_rtc':
      return ttsVoices.DEFAULT_VOLC_VOICE;
    case 'minimax':
      return provider.config?.defaultVoice || minimax.MINIMAX_DEFAULT_VOICE;
    case 'dashscope':
      return (ttsVoices.DASHSCOPE_OFFICIAL_VOICES[0] || {}).id || 'Cherry';
    default:
      return null;
  }
}

function rowToBinding(row) {
  return {
    scene: row.scene,
    provider_id: row.provider_id,
    voice_id: row.voice_id,
    params: row.params_json ? JSON.parse(row.params_json) : null,
  };
}

function getBindings(db, avatarId) {
  return db
    .prepare('SELECT * FROM avatar_voice_bindings WHERE avatar_id = ? ORDER BY scene ASC')
    .all(avatarId)
    .map(rowToBinding);
}

function getBinding(db, avatarId, scene) {
  const row = db
    .prepare('SELECT * FROM avatar_voice_bindings WHERE avatar_id = ? AND scene = ?')
    .get(avatarId, scene);
  return row ? rowToBinding(row) : null;
}

function setBinding(db, avatarId, scene, { providerId, voiceId, params } = {}) {
  if (!SCENE_SET.has(scene)) throw new ValidationError(`unknown scene: ${scene}`);
  const pid = typeof providerId === 'string' ? providerId.trim() : '';
  const vid = typeof voiceId === 'string' ? voiceId.trim() : '';
  if (!pid) throw new ValidationError('providerId is required');
  if (!vid) throw new ValidationError('voiceId is required');
  const kind = providerKindForScene(scene);
  if (!loadProvider(db, kind, pid)) {
    throw new ValidationError(`provider ${pid} not found in ${kind} provider library`);
  }
  db.prepare(
    `INSERT INTO avatar_voice_bindings (avatar_id, scene, provider_id, voice_id, params_json, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(avatar_id, scene) DO UPDATE SET
       provider_id = excluded.provider_id,
       voice_id = excluded.voice_id,
       params_json = excluded.params_json,
       updated_at = strftime('%s','now')`,
  ).run(avatarId, scene, pid, vid, params ? JSON.stringify(params) : null);
  return getBinding(db, avatarId, scene);
}

function removeBinding(db, avatarId, scene) {
  db.prepare('DELETE FROM avatar_voice_bindings WHERE avatar_id = ? AND scene = ?').run(avatarId, scene);
  return { avatarId, scene };
}

// 「电话里那把嗓子」的绑定行(2026-09-23,Ben:「你的声音太像豆包了,我要换一个」)。
//
// 通道层工人调 /api/tts 时**不带 avatarId**(它没有形象,只有一张嘴,见 channel-worker
// 的 tts/butlerTts.ts):于是 resolveVoice 以前直接掉到最后那条「供应商默认音色」上,
// 谁也改不动它 —— Ben 在电话里听到的 zh_female_vv_uranus_bigtts 正是那个写死的常量。
//
// 修法不是再开一张表(音色配置只能有一份,就在这张 avatar_voice_bindings 里),
// 而是给「没点形象」这一路一个**保留的 avatar_id**。这张表没有指向 avatars 的外键
// (见 db.cjs 的建表),所以这一行合法,也跟着 provider 删除保护一起被数到。
const CALL_AVATAR_ID = '__call__';

// 解析某角色某场景实际该用的 { provider, voiceId, params }。永远尽量返回可用值。
// 走法：显式场景绑定 → (TTS 场景)chat 基准 → **没点形象时:通话绑定** → 全局默认 provider + 其默认音色。
function resolveVoice(db, avatarId, scene) {
  if (!SCENE_SET.has(scene)) throw new ValidationError(`unknown scene: ${scene}`);
  const kind = providerKindForScene(scene);

  // 没点形象就按保留 id 查一遍。规矩说死:**点了形象的,形象说了算**;
  // 电话里那把嗓子只管没点形象的那一路(工人正是这一路)。
  {
    const lookupId = avatarId || CALL_AVATAR_ID;
    const binding = getBinding(db, lookupId, scene)
      || (kind === 'tts' && scene !== 'chat' ? getBinding(db, lookupId, 'chat') : null);
    if (binding) {
      const fromBinding = resolveBinding(db, kind, binding);
      if (fromBinding) return fromBinding;
      // 绑定的 provider 已被删(或让位给用户自己填的)→ 落到下面的全局默认兜底
    }
  }

  // TTS 默认:sqlite 里能用的 → 工作台下发 → sqlite 里那个不能用的(路由据此 503)。见 voiceCredentials.resolveTtsDefault。
  const provider = kind === 'rtc'
    ? rtcProviderStore.resolveDefault(db)
    : voiceCredentials.resolveTtsDefault(db);
  if (!provider) return null;
  return { provider, voiceId: defaultVoiceForProvider(provider), params: null, source: 'fallback' };
}

/**
 * 一条绑定行 → { provider, voiceId, params, source:'binding' } 或 null(落到默认兜底)。
 *
 * 2026-09-23 两条让位规矩(「用户自己填的优先」):
 *   · 绑的是**工作台下发**那个虚拟供应商,而 sqlite 里已经有能用的 → 让位,走默认(= 用户自己那个);
 *   · 绑的是 sqlite 里的供应商,但它**密钥不全**,而工作台下发了 → 换成下发那一份。
 *     原供应商也是火山就留着那个音色 id(同一套命名空间);别家的音色火山不认,交给默认兜底选音色。
 */
function resolveBinding(db, kind, binding) {
  if (kind === 'tts' && binding.provider_id === voiceCredentials.WORKBENCH_PROVIDER_ID) {
    if (voiceCredentials.usableSettingsTtsProvider(db)) return null;
    const provider = voiceCredentials.workbenchTtsProvider();
    return provider ? { provider, voiceId: binding.voice_id, params: binding.params, source: 'binding' } : null;
  }
  const provider = loadProvider(db, kind, binding.provider_id);
  if (!provider) return null;
  if (kind === 'tts' && !voiceCredentials.ttsProviderUsable(provider)) {
    const fromServer = voiceCredentials.workbenchTtsProvider();
    if (fromServer) {
      if (provider.provider_type !== 'volcengine') return null;
      return { provider: fromServer, voiceId: binding.voice_id, params: binding.params, source: 'binding' };
    }
  }
  return { provider, voiceId: binding.voice_id, params: binding.params, source: 'binding' };
}

// 电话里那把嗓子换成 voiceId。provider 不给就用全局默认 TTS ——
// 他在电话里说的是「换个音色」,不是「换个供应商」。
// 没有任何可用的 TTS 供应商时**不写**:写一条指向不存在 provider 的绑定,
// 下一句话会静默掉回默认嗓子,而她已经说过「换好了」(D13)。
function setCallVoice(db, { providerId, voiceId } = {}) {
  // 缺省供应商与 /api/tts 同一个解析口(2026-09-23):新用户 sqlite 里什么都没有时,记的是工作台下发那一个。
  const pid = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim()
    : ((voiceCredentials.resolveTtsDefault(db) || {}).id);
  if (!pid) throw new ValidationError('没有可用的 TTS 供应商,换不了音色');
  return setBinding(db, CALL_AVATAR_ID, 'chat', { providerId: pid, voiceId });
}

// 电话里此刻绑的那一条(没绑过就 null)。
function getCallBinding(db) {
  return getBinding(db, CALL_AVATAR_ID, 'chat');
}

// provider 删除保护：返回引用该 provider 的绑定数 + 角色 id 列表。
function countProviderUsage(db, providerId) {
  const rows = db
    .prepare('SELECT DISTINCT avatar_id FROM avatar_voice_bindings WHERE provider_id = ?')
    .all(providerId);
  const total = db
    .prepare('SELECT COUNT(*) AS n FROM avatar_voice_bindings WHERE provider_id = ?')
    .get(providerId);
  return { count: total.n, avatarIds: rows.map((r) => r.avatar_id) };
}

// ---- 旧数据一次性迁移 ------------------------------------------------------

function defaultProviderIdByType(db, type) {
  const row = db
    .prepare('SELECT id FROM tts_models WHERE provider_type = ? ORDER BY is_default DESC, created_at ASC LIMIT 1')
    .get(type);
  return row ? row.id : null;
}
function globalDefaultTtsId(db) {
  const def = ttsProviderStore.resolveDefault(db);
  if (def) return def.id;
  const any = db.prepare('SELECT id FROM tts_models ORDER BY created_at ASC LIMIT 1').get();
  return any ? any.id : null;
}
function defaultRtcId(db) {
  const def = rtcProviderStore.resolveDefault(db);
  if (def) return def.id;
  const any = db.prepare('SELECT id FROM rtc_providers ORDER BY created_at ASC LIMIT 1').get();
  return any ? any.id : null;
}

// 旧 voice 字符串命名空间归类：minimax / volcengine / dashscope，再不行交给全局默认。
function isVolcVoice(v) {
  if (/^(S_|BV)/i.test(v) || /^zh_/.test(v)) return true;
  return ttsVoices.VOLC_VOICE_CATALOG.some((c) => c.id === v);
}
function isDashscopeVoice(v) {
  return ttsVoices.DASHSCOPE_OFFICIAL_VOICES.some((c) => c.id === v);
}
function classifyLegacyProviderId(db, voice) {
  if (ttsVoices.isMinimaxVoice(voice)) return defaultProviderIdByType(db, 'minimax') || globalDefaultTtsId(db);
  if (isVolcVoice(voice)) return defaultProviderIdByType(db, 'volcengine') || globalDefaultTtsId(db);
  if (isDashscopeVoice(voice)) return defaultProviderIdByType(db, 'dashscope') || globalDefaultTtsId(db);
  return globalDefaultTtsId(db);
}

// 幂等：仅当目标 (avatar, scene) 尚无绑定时种。
function seedIfAbsent(db, avatarId, scene, providerId, voiceId) {
  if (!providerId || !voiceId) return;
  if (getBinding(db, avatarId, scene)) return;
  db.prepare(
    `INSERT OR IGNORE INTO avatar_voice_bindings (avatar_id, scene, provider_id, voice_id, updated_at)
     VALUES (?, ?, ?, ?, strftime('%s','now'))`,
  ).run(avatarId, scene, providerId, voiceId);
}

function seedFromLegacy(db) {
  const rows = db.prepare('SELECT id, voice, dj_binding_json FROM avatars').all();
  for (const row of rows) {
    const voice = typeof row.voice === 'string' ? row.voice.trim() : '';
    if (voice) {
      seedIfAbsent(db, row.id, 'chat', classifyLegacyProviderId(db, voice), voice);
      // RTC 此前复用 avatar.voice 喂火山 → 仅火山命名空间的 voice 才安全地种 rtc 绑定。
      if (isVolcVoice(voice)) seedIfAbsent(db, row.id, 'rtc', defaultRtcId(db), voice);
    }
    let dj = null;
    try { dj = row.dj_binding_json ? JSON.parse(row.dj_binding_json) : null; } catch { dj = null; }
    const introVoice = dj && typeof dj.intro_voice_id === 'string' ? dj.intro_voice_id.trim() : '';
    if (introVoice) seedIfAbsent(db, row.id, 'dj_intro', globalDefaultTtsId(db), introVoice);
  }
}

module.exports = {
  SCENES,
  CALL_AVATAR_ID,
  setCallVoice,
  getCallBinding,
  providerKindForScene,
  defaultVoiceForProvider,
  getBindings,
  getBinding,
  setBinding,
  removeBinding,
  resolveVoice,
  countProviderUsage,
  seedFromLegacy,
  ValidationError,
};
