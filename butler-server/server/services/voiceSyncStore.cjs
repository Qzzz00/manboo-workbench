'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/voiceSyncStore.cjs
// 音色同步配置（ALL-605 Wave 1）契约实现：
//   - voice_sync_mode ∈ independent | follow_base | follow_rtc
//   - base_voice / rtc_voice 统一为 VoiceRef { provider_id, voice_id }
//   - logical_voice_mappings 是「逻辑音色」到两套最终音色的唯一权威
// 保存时服务端查映射、校验 Provider/音色存在性与模式，并把最终两套实际配置落到
// 既有 avatar_voice_bindings（base → chat、rtc → rtc），运行时仍由
// avatarVoiceStore.resolveVoice('chat'/'rtc') 读取，不在运行时临时推导。
// 见 docs/voice-sync-contract.md。

const avatarVoiceStore = require('./avatarVoiceStore.cjs');
const ttsProviderStore = require('./ttsProviderStore.cjs');
const rtcProviderStore = require('./rtcProviderStore.cjs');
const ttsVoices = require('./ttsVoices.cjs');

const VOICE_SYNC_MODES = ['independent', 'follow_base', 'follow_rtc'];
const MODE_SET = new Set(VOICE_SYNC_MODES);

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 逻辑音色映射缺失：统一模式 fail-closed，绝不静默回退默认音色。
class MappingNotFoundError extends Error {
  constructor(message = '当前音色没有可用的逻辑音色映射') {
    super(message);
    this.code = 'VOICE_MAPPING_NOT_FOUND';
  }
}

function normalizeVoiceRef(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('invalid_voice_ref', `${fieldName} must be an object { provider_id, voice_id }`);
  }
  const providerId = typeof value.provider_id === 'string' ? value.provider_id.trim() : '';
  const voiceId = typeof value.voice_id === 'string' ? value.voice_id.trim() : '';
  if (!providerId) throw new ValidationError('invalid_voice_ref', `${fieldName}.provider_id is required`);
  if (!voiceId) throw new ValidationError('invalid_voice_ref', `${fieldName}.voice_id is required`);
  return { provider_id: providerId, voice_id: voiceId };
}

// Provider 存在性校验：base 必须在 tts_models，rtc 必须在 rtc_providers。
function assertProviderExists(db, side, providerId) {
  const raw = side === 'rtc' ? rtcProviderStore.getRaw(db, providerId) : ttsProviderStore.getRaw(db, providerId);
  if (!raw) {
    throw new ValidationError(
      'voice_provider_not_found',
      `${side === 'rtc' ? 'RTC' : 'TTS'} provider ${providerId} not found`,
    );
  }
  return raw;
}

// Provider 存在性 + 该 provider 类型下 voice_id 存在性校验。
// voice_id 必须属于该 provider 类型的已知音色命名空间（官方目录或火山复刻 S_/BV）。
// 校验失败 fail-closed，绝不让无效音色落到绑定/映射。
function assertVoiceExists(db, side, providerId, voiceId) {
  const raw = assertProviderExists(db, side, providerId);
  if (!ttsVoices.voiceExists(raw.provider_type, voiceId)) {
    throw new ValidationError(
      'voice_not_found',
      `${side === 'rtc' ? 'RTC' : 'TTS'} voice ${voiceId} not found for provider ${providerId}`,
    );
  }
  return raw;
}

function mappingRowToObject(row) {
  return {
    id: row.logical_voice_id,
    logical_voice_id: row.logical_voice_id,
    base_voice: { provider_id: row.base_provider_id, voice_id: row.base_voice_id },
    rtc_voice: { provider_id: row.rtc_provider_id, voice_id: row.rtc_voice_id },
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getMapping(db, logicalVoiceId) {
  const row = db
    .prepare('SELECT * FROM logical_voice_mappings WHERE logical_voice_id = ?')
    .get(logicalVoiceId);
  return row ? mappingRowToObject(row) : null;
}

function listMappings(db) {
  return db
    .prepare('SELECT * FROM logical_voice_mappings ORDER BY logical_voice_id ASC')
    .all()
    .map(mappingRowToObject);
}

// 按某一侧 (provider_id, voice_id) 反查启用中的逻辑音色映射，返回两侧最终配置。
// side='base' 以基准侧为键；side='rtc' 以 RTC 侧为键。无启用映射返回 null（不抛错，
// 由 save 流程统一转 VOICE_MAPPING_NOT_FOUND）。
function resolveMapping(db, side, providerId, voiceId) {
  const col = side === 'rtc' ? 'rtc' : 'base';
  const row = db
    .prepare(
      `SELECT * FROM logical_voice_mappings
       WHERE ${col}_provider_id = ? AND ${col}_voice_id = ? AND enabled = 1`,
    )
    .get(providerId, voiceId);
  return row ? mappingRowToObject(row) : null;
}

// upsert 一条逻辑音色映射。enabled 缺省 true；两侧 provider 均校验存在于对应库。
// base/rtc 两侧的 (provider_id, voice_id) 各自唯一（DB 唯一索引），冲突时抛 4xx 语义错误。
function upsertMapping(db, input) {
  const logicalVoiceId = typeof input?.logical_voice_id === 'string' ? input.logical_voice_id.trim() : '';
  if (!logicalVoiceId) throw new ValidationError('invalid_mapping', 'logical_voice_id is required');
  const base = normalizeVoiceRef(input?.base_voice, 'base_voice');
  const rtc = normalizeVoiceRef(input?.rtc_voice, 'rtc_voice');
  assertVoiceExists(db, 'base', base.provider_id, base.voice_id);
  assertVoiceExists(db, 'rtc', rtc.provider_id, rtc.voice_id);
  const enabled = input?.enabled === false ? 0 : 1;

  try {
    db.prepare(
      `INSERT INTO logical_voice_mappings
         (logical_voice_id, base_provider_id, base_voice_id, rtc_provider_id, rtc_voice_id, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(logical_voice_id) DO UPDATE SET
         base_provider_id = excluded.base_provider_id,
         base_voice_id = excluded.base_voice_id,
         rtc_provider_id = excluded.rtc_provider_id,
         rtc_voice_id = excluded.rtc_voice_id,
         enabled = excluded.enabled,
         updated_at = strftime('%s','now')`,
    ).run(
      logicalVoiceId,
      base.provider_id,
      base.voice_id,
      rtc.provider_id,
      rtc.voice_id,
      enabled,
    );
  } catch (err) {
    if (err && /UNIQUE constraint failed/.test(err.message)) {
      throw new ValidationError('mapping_conflict', `逻辑音色映射冲突：${err.message}`);
    }
    throw err;
  }
  return getMapping(db, logicalVoiceId);
}

function removeMapping(db, logicalVoiceId) {
  db.prepare('DELETE FROM logical_voice_mappings WHERE logical_voice_id = ?').run(logicalVoiceId);
  return { logical_voice_id: logicalVoiceId };
}

// 读某角色的音色同步配置：mode + 两侧最终实际配置（取自 avatar_voice_bindings 的 chat/rtc）。
function getVoiceSettings(db, avatarId) {
  const avatar = db.prepare('SELECT id, voice_sync_mode FROM avatars WHERE id = ?').get(avatarId);
  if (!avatar) return null;
  const base = avatarVoiceStore.getBinding(db, avatarId, 'chat');
  const rtc = avatarVoiceStore.getBinding(db, avatarId, 'rtc');
  return {
    avatar_id: avatarId,
    voice_sync_mode: avatar.voice_sync_mode || 'independent',
    base_voice: base ? { provider_id: base.provider_id, voice_id: base.voice_id } : null,
    rtc_voice: rtc ? { provider_id: rtc.provider_id, voice_id: rtc.voice_id } : null,
  };
}

// 保存音色同步配置。入参：
//   { avatarId, voiceSyncMode, baseVoice?, rtcVoice? }
// 校验并解析最终两套音色，落到 avatar_voice_bindings（幂等 upsert）并写 voice_sync_mode。
function saveVoiceSettings(db, { avatarId, voiceSyncMode, baseVoice, rtcVoice }) {
  const avatar = db.prepare('SELECT id FROM avatars WHERE id = ?').get(avatarId);
  if (!avatar) throw new ValidationError('avatar_not_found', `avatar ${avatarId} not found`);

  if (!MODE_SET.has(voiceSyncMode)) {
    throw new ValidationError('invalid_voice_sync_mode', `voice_sync_mode must be one of: ${VOICE_SYNC_MODES.join(', ')}`);
  }

  let finalBase;
  let finalRtc;

  if (voiceSyncMode === 'independent') {
    finalBase = normalizeVoiceRef(baseVoice, 'base_voice');
    finalRtc = normalizeVoiceRef(rtcVoice, 'rtc_voice');
  } else if (voiceSyncMode === 'follow_base') {
    finalBase = normalizeVoiceRef(baseVoice, 'base_voice');
    // 源侧音色（provider + voice_id）必须先真实存在，再查映射，否则无法区分「音色无效」
    // 与「无映射」两种失败。
    assertVoiceExists(db, 'base', finalBase.provider_id, finalBase.voice_id);
    const mapped = resolveMapping(db, 'base', finalBase.provider_id, finalBase.voice_id);
    if (!mapped) throw new MappingNotFoundError();
    finalRtc = mapped.rtc_voice;
  } else {
    // follow_rtc
    finalRtc = normalizeVoiceRef(rtcVoice, 'rtc_voice');
    assertVoiceExists(db, 'rtc', finalRtc.provider_id, finalRtc.voice_id);
    const mapped = resolveMapping(db, 'rtc', finalRtc.provider_id, finalRtc.voice_id);
    if (!mapped) throw new MappingNotFoundError();
    finalBase = mapped.base_voice;
  }

  // 最终两侧音色的 Provider 与 voice_id 都必须存在（映射侧同样校验，防脏映射指向
  // 已删除 provider 或无效音色）。
  assertVoiceExists(db, 'base', finalBase.provider_id, finalBase.voice_id);
  assertVoiceExists(db, 'rtc', finalRtc.provider_id, finalRtc.voice_id);

  const tx = db.transaction(() => {
    avatarVoiceStore.setBinding(db, avatarId, 'chat', {
      providerId: finalBase.provider_id,
      voiceId: finalBase.voice_id,
    });
    avatarVoiceStore.setBinding(db, avatarId, 'rtc', {
      providerId: finalRtc.provider_id,
      voiceId: finalRtc.voice_id,
    });
    db.prepare('UPDATE avatars SET voice_sync_mode = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(voiceSyncMode, avatarId);
  });
  tx();

  return getVoiceSettings(db, avatarId);
}

module.exports = {
  VOICE_SYNC_MODES,
  normalizeVoiceRef,
  getVoiceSettings,
  saveVoiceSettings,
  getMapping,
  listMappings,
  upsertMapping,
  removeMapping,
  resolveMapping,
  ValidationError,
  MappingNotFoundError,
};
