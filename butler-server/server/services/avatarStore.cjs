'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/avatarStore.cjs
// Avatar persistence + validation. Routes stay thin; all DB access and field
// validation for the admin avatar CRUD lives here.

// Fields the admin PATCH is allowed to write. Everything else (id / status /
// current_version / model_entry / *_at) is read-only and must be set through
// the seed / upload / publish flows, never through PATCH.
const PATCHABLE_FIELDS = new Set([
  'name',
  'summary',
  'persona',
  'transform',
  'motions',
  'llm_model_id',
  'voice',
  'default_background',
  'prompt_template',
  'dj_binding',
  'opening_enabled',
  'opening_text',
  'journey_runtime_enabled',
  'idle_enhance_enabled',
  'idle_enhance_interval_sec',
  'portrait_url',
  'ringtone_url',
  'notify_sound_url',
  'public_profile',
]);

// 官方公开资料（ALL-535/A）：唯一允许的四个公开字段。PATCH 只接受这四个键，
// 读侧也只显式构造这四个键，绝不透传 raw public_profile_json 或任何隐藏设定。
const OFFICIAL_PROFILE_FIELDS = ['identity', 'occupation', 'age', 'world_summary'];

// 待机动作增强间隔的合法范围（秒）。
const IDLE_ENHANCE_MIN_SEC = 3;
const IDLE_ENHANCE_MAX_SEC = 60;

const VALID_EMOTION_BASELINES = new Set([
  'neutral', 'calm', 'cheerful', 'energetic', 'melancholic', 'serious', 'playful',
]);
const READONLY_FIELDS = new Set(['id', 'status', 'current_version', 'model_entry', 'created_at', 'updated_at']);

const VALID_STATUSES = new Set(['draft', 'published', 'archived']);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'validation_error';
  }
}

class NotFoundError extends Error {
  constructor(message = 'Avatar not found') {
    super(message);
    this.code = 'avatar_not_found';
  }
}

function safeParse(json, fallback) {
  if (json === null || json === undefined) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// 官方公开资料四字段全部为 null 的规范空值。
function nullOfficialProfile() {
  return { identity: null, occupation: null, age: null, world_summary: null };
}

// 从 raw public_profile_json 显式构造四字段白名单输出：只取四个已知键，
// 类型不对一律归一为 null，绝不返回原始 JSON 或任何未知/隐藏字段（fail-closed）。
function parsePublicProfile(json) {
  const raw = safeParse(json, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return nullOfficialProfile();
  return {
    identity: typeof raw.identity === 'string' ? raw.identity : null,
    occupation: typeof raw.occupation === 'string' ? raw.occupation : null,
    age: Number.isInteger(raw.age) && raw.age >= 0 ? raw.age : null,
    world_summary: typeof raw.world_summary === 'string' ? raw.world_summary : null,
  };
}

// 读取某角色的官方公开资料（四字段白名单）。角色不存在 / 表缺失 / JSON 损坏
// 一律返回四字段 null，绝不抛错或泄漏原始数据。
function getOfficialProfile(db, characterId) {
  if (!characterId) return nullOfficialProfile();
  try {
    const row = db.prepare('SELECT public_profile_json FROM avatars WHERE id = ?').get(characterId);
    return parsePublicProfile(row ? row.public_profile_json : null);
  } catch {
    return nullOfficialProfile();
  }
}

function serializeSummary(row) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    status: row.status,
    current_version: row.current_version,
    updated_at: row.updated_at,
    dj_binding: safeParse(row.dj_binding_json, null),
  };
}

function serializeDetail(db, row) {
  const versions = db
    .prepare(
      `SELECT version, size_bytes, checksum, uploaded_at, restore_source_version, restore_reason, restored_at
       FROM avatar_assets WHERE avatar_id = ? ORDER BY version ASC`,
    )
    .all(row.id);

  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    persona: safeParse(row.persona_json, {}),
    transform: safeParse(row.transform_json, {}),
    motions: safeParse(row.motions_json, null),
    prompt_template: safeParse(row.prompt_template_json, null),
    model_entry: row.model_entry,
    current_version: row.current_version,
    status: row.status,
    llm_model_id: row.llm_model_id ?? null,
    voice: row.voice ?? null,
    default_background: row.default_background ?? null,
    portrait_url: row.portrait_url ?? null,
    ringtone_url: row.ringtone_url ?? null,
    notify_sound_url: row.notify_sound_url ?? null,
    dj_binding: safeParse(row.dj_binding_json, null),
    opening_enabled: row.opening_enabled === 1,
    opening_text: row.opening_text ?? null,
    journey_runtime_enabled: row.journey_runtime_enabled === 1,
    idle_enhance_enabled: row.idle_enhance_enabled !== 0,
    idle_enhance_interval_sec: row.idle_enhance_interval_sec ?? null,
    public_profile: parsePublicProfile(row.public_profile_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    versions,
  };
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM avatars WHERE id = ?').get(id);
}

function listAvatars(db, { status } = {}) {
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    throw new ValidationError('Invalid status filter');
  }
  const rows = status
    ? db
      .prepare('SELECT * FROM avatars WHERE status = ? ORDER BY updated_at DESC, id ASC')
      .all(status)
    : db.prepare('SELECT * FROM avatars ORDER BY updated_at DESC, id ASC').all();
  return rows.map(serializeSummary);
}

function getAvatarDetail(db, id) {
  const row = getRow(db, id);
  if (!row) throw new NotFoundError();
  return serializeDetail(db, row);
}

// 角色可用性判定（ALL-589/T1 运行时拦截的唯一权威读取口，fail-closed）。
// 返回 'published' | 'not_published'：
//   - 'published'     明确查询到 avatars.status === 'published'，才可对外提供服务。
//   - 'not_published' 其余一律不可用：角色行缺失、status 为 NULL/draft/archived/未知、
//                      以及查询异常（绝不 fail-open，绝不按 unmanaged 放行）。
function resolveAvatarAvailability(db, id) {
  if (!id) return 'not_published';
  let row;
  try {
    row = db.prepare('SELECT status FROM avatars WHERE id = ?').get(id);
  } catch {
    return 'not_published';
  }
  if (!row || row.status !== 'published') return 'not_published';
  return 'published';
}

// 角色是否“不可用”（取消发布/草稿/归档/未知/缺失/查询错误）。fail-closed：
// 只有明确查询到 status === 'published' 才算可用，其余一律不可用。
function isAvatarUnavailable(db, id) {
  return resolveAvatarAvailability(db, id) !== 'published';
}

// 轻量取某角色后台配置的音色（TTS 用，权威来源）。不存在/未配则返回 null，不抛错。
function getAvatarVoice(db, id) {
  if (!id) return null;
  const row = getRow(db, id);
  const v = row && typeof row.voice === 'string' ? row.voice.trim() : '';
  return v || null;
}

function getPromptTemplate(db, id) {
  const row = getRow(db, id);
  if (!row) throw new NotFoundError();
  return safeParse(row.prompt_template_json, null);
}

// ---- PATCH validation ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validatePersona(persona) {
  if (!isPlainObject(persona)) throw new ValidationError('persona must be an object');
  if ('tone' in persona && typeof persona.tone !== 'string') {
    throw new ValidationError('persona.tone must be a string');
  }
  if ('traits' in persona && !isStringArray(persona.traits)) {
    throw new ValidationError('persona.traits must be a string array');
  }
  if ('styleRules' in persona && !isStringArray(persona.styleRules)) {
    throw new ValidationError('persona.styleRules must be a string array');
  }
}

const REQUIRED_TEMPLATE_STRINGS = [
  'id',
  'name',
  'story_string',
  'user_prefix',
  'user_suffix',
  'assistant_prefix',
  'assistant_suffix',
  'created_at',
  'updated_at',
];

function validateUgcPolicy(policy) {
  if (!isPlainObject(policy)) throw new ValidationError('prompt_template.ugc_policy must be an object');
  for (const key of [
    'allow_system_prompt_override',
    'allow_post_history_override',
    'force_original_macro',
  ]) {
    if (typeof policy[key] !== 'boolean') {
      throw new ValidationError(`prompt_template.ugc_policy.${key} must be a boolean`);
    }
  }
}

function validatePromptTemplate(template) {
  if (template === null) return;
  if (!isPlainObject(template)) throw new ValidationError('prompt_template must be an object or null');
  for (const key of REQUIRED_TEMPLATE_STRINGS) {
    if (typeof template[key] !== 'string') {
      throw new ValidationError(`prompt_template.${key} must be a string`);
    }
  }
  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new ValidationError('prompt_template.version must be a positive integer');
  }
  validateUgcPolicy(template.ugc_policy);
  if ('dj_persona_md' in template) {
    if (typeof template.dj_persona_md !== 'string') {
      throw new ValidationError('prompt_template.dj_persona_md must be a string');
    }
    if (template.dj_persona_md.length > 1500) {
      throw new ValidationError('prompt_template.dj_persona_md must be ≤ 1500 characters');
    }
  }
}

function validateDjBinding(binding) {
  if (binding === null) return;
  if (!isPlainObject(binding)) throw new ValidationError('dj_binding must be an object or null');
  if (typeof binding.enabled !== 'boolean') {
    throw new ValidationError('dj_binding.enabled must be a boolean');
  }
  if ('segment_template_md' in binding) {
    if (typeof binding.segment_template_md !== 'string') {
      throw new ValidationError('dj_binding.segment_template_md must be a string');
    }
    if (binding.segment_template_md.length > 1500) {
      throw new ValidationError('dj_binding.segment_template_md must be ≤ 1500 characters');
    }
  }
  if ('intro_voice_id' in binding) {
    if (typeof binding.intro_voice_id !== 'string') {
      throw new ValidationError('dj_binding.intro_voice_id must be a string');
    }
    if (binding.intro_voice_id.length > 64) {
      throw new ValidationError('dj_binding.intro_voice_id must be ≤ 64 characters');
    }
  }
  if ('emotion_baseline' in binding) {
    if (!VALID_EMOTION_BASELINES.has(binding.emotion_baseline)) {
      throw new ValidationError(
        `dj_binding.emotion_baseline must be one of: ${[...VALID_EMOTION_BASELINES].join(', ')}`,
      );
    }
  }
}

// 官方公开资料校验：只接受 identity / occupation / age / world_summary 四项。
// 字符串字段必须是 string 或 null；age 必须是非负整数或 null。未知键一律拒绝。
function validatePublicProfile(profile) {
  if (!isPlainObject(profile)) throw new ValidationError('public_profile must be an object');
  for (const key of Object.keys(profile)) {
    if (!OFFICIAL_PROFILE_FIELDS.includes(key)) {
      throw new ValidationError(`Unknown field "public_profile.${key}"`);
    }
  }
  for (const field of ['identity', 'occupation', 'world_summary']) {
    if (field in profile) {
      const v = profile[field];
      if (v !== null && typeof v !== 'string') {
        throw new ValidationError(`public_profile.${field} must be a string or null`);
      }
    }
  }
  if ('age' in profile) {
    const v = profile.age;
    if (v !== null && (!Number.isInteger(v) || v < 0)) {
      throw new ValidationError('public_profile.age must be a non-negative integer or null');
    }
  }
}

// 归一可空文本：string 先 trim，空串归 null；null 保持 null。
function normalizeNullableText(value) {
  if (value === null || value === undefined) return null;
  const s = value.trim();
  return s === '' ? null : s;
}

function buildPatch(body) {
  if (!isPlainObject(body)) throw new ValidationError('Request body must be an object');

  // Reject any attempt to write a read-only field rather than silently
  // dropping it — acceptance: "尝试修改只读字段不污染 DB" with a clear error.
  for (const key of Object.keys(body)) {
    if (READONLY_FIELDS.has(key)) {
      throw new ValidationError(`Field "${key}" is read-only and cannot be patched`);
    }
    if (!PATCHABLE_FIELDS.has(key)) {
      throw new ValidationError(`Unknown field "${key}"`);
    }
  }

  const updates = {};

  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new ValidationError('name must be a non-empty string');
    }
    updates.name = body.name;
  }

  if ('summary' in body) {
    if (typeof body.summary !== 'string') throw new ValidationError('summary must be a string');
    updates.summary = body.summary;
  }

  if ('persona' in body) {
    validatePersona(body.persona);
    updates.persona_json = JSON.stringify(body.persona);
  }

  if ('transform' in body) {
    if (!isPlainObject(body.transform)) throw new ValidationError('transform must be an object');
    updates.transform_json = JSON.stringify(body.transform);
  }

  if ('motions' in body) {
    if (body.motions !== null && !isPlainObject(body.motions)) {
      throw new ValidationError('motions must be an object or null');
    }
    updates.motions_json = body.motions === null ? null : JSON.stringify(body.motions);
  }

  // 运行配置（小智式每角色引用）。空串/ null 归一为 null = 解绑 / 回退默认。
  if ('llm_model_id' in body) {
    if (body.llm_model_id !== null && typeof body.llm_model_id !== 'string') {
      throw new ValidationError('llm_model_id must be a string or null');
    }
    const v = typeof body.llm_model_id === 'string' ? body.llm_model_id.trim() : '';
    updates.llm_model_id = v === '' ? null : v;
  }

  if ('voice' in body) {
    if (body.voice !== null && typeof body.voice !== 'string') {
      throw new ValidationError('voice must be a string or null');
    }
    const v = typeof body.voice === 'string' ? body.voice.trim() : '';
    updates.voice = v === '' ? null : v;
  }

  if ('default_background' in body) {
    if (body.default_background !== null && typeof body.default_background !== 'string') {
      throw new ValidationError('default_background must be a string or null');
    }
    const v = typeof body.default_background === 'string' ? body.default_background.trim() : '';
    if (v !== '' && !isValidHttpUrl(v)) {
      throw new ValidationError('default_background must be a valid http(s) URL');
    }
    updates.default_background = v === '' ? null : v;
  }

  // 触达路由器：头像图 / 来电铃声 / 消息提示音。空串/ null 归一为 null；否则须为 http(s) 绝对URL。
  for (const field of ['portrait_url', 'ringtone_url', 'notify_sound_url']) {
    if (field in body) {
      if (body[field] !== null && typeof body[field] !== 'string') {
        throw new ValidationError(`${field} must be a string or null`);
      }
      const v = typeof body[field] === 'string' ? body[field].trim() : '';
      if (v !== '' && !isValidHttpUrl(v)) {
        throw new ValidationError(`${field} must be a valid http(s) URL`);
      }
      updates[field] = v === '' ? null : v;
    }
  }

  if ('prompt_template' in body) {
    validatePromptTemplate(body.prompt_template);
    updates.prompt_template_json = body.prompt_template === null ? null : JSON.stringify(body.prompt_template);
  }

  if ('dj_binding' in body) {
    validateDjBinding(body.dj_binding);
    updates.dj_binding_json = body.dj_binding === null ? null : JSON.stringify(body.dj_binding);
  }

  if ('opening_enabled' in body) {
    updates.opening_enabled = body.opening_enabled === true || body.opening_enabled === 1 ? 1 : 0;
  }

  // 剧情引擎按角色启用。布尔归一为 0/1；总兜底仍是全局 flag journey_runtime_enabled。
  if ('journey_runtime_enabled' in body) {
    updates.journey_runtime_enabled =
      body.journey_runtime_enabled === true || body.journey_runtime_enabled === 1 ? 1 : 0;
  }

  if ('opening_text' in body) {
    if (body.opening_text !== null && typeof body.opening_text !== 'string') {
      throw new ValidationError('opening_text must be a string or null');
    }
    const v = typeof body.opening_text === 'string' ? body.opening_text.trim() : '';
    if (v.length > 200) {
      throw new ValidationError('opening_text must be at most 200 characters');
    }
    updates.opening_text = v === '' ? null : v;
  }

  if ('idle_enhance_enabled' in body) {
    updates.idle_enhance_enabled = body.idle_enhance_enabled === true || body.idle_enhance_enabled === 1 ? 1 : 0;
  }

  if ('idle_enhance_interval_sec' in body) {
    const raw = body.idle_enhance_interval_sec;
    if (raw === null || raw === '') {
      updates.idle_enhance_interval_sec = null;
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ValidationError('idle_enhance_interval_sec must be an integer or null');
      }
      if (n < IDLE_ENHANCE_MIN_SEC || n > IDLE_ENHANCE_MAX_SEC) {
        throw new ValidationError(
          `idle_enhance_interval_sec must be between ${IDLE_ENHANCE_MIN_SEC} and ${IDLE_ENHANCE_MAX_SEC}`,
        );
      }
      updates.idle_enhance_interval_sec = n;
    }
  }

  if ('public_profile' in body) {
    validatePublicProfile(body.public_profile);
    updates.public_profile_json = JSON.stringify({
      identity: normalizeNullableText(body.public_profile.identity),
      occupation: normalizeNullableText(body.public_profile.occupation),
      age: body.public_profile.age === undefined || body.public_profile.age === null
        ? null
        : body.public_profile.age,
      world_summary: normalizeNullableText(body.public_profile.world_summary),
    });
  }

  return updates;
}

function updateAvatar(db, id, body) {
  const row = getRow(db, id);
  if (!row) throw new NotFoundError();

  const updates = buildPatch(body);
  if (Object.keys(updates).length === 0) {
    throw new ValidationError('No updatable fields provided');
  }

  // 本机版:没有模型库(llm_models 表不建),事务官的模型路由走工作台 → DSH,不在这里配。
  if (updates.llm_model_id != null) {
    throw new ValidationError('本机没有模型库,llm_model_id 不可设置');
  }

  const needsMutex = updates.dj_binding_json !== undefined;
  const binding = needsMutex ? JSON.parse(updates.dj_binding_json) : null;
  const enableMutex = needsMutex && binding && binding.enabled === true;

  // Monotonic updated_at: bump to at least previous + 1 so a PATCH in the same
  // wall-clock second as the seed (second-resolution) still shows an increase.
  const cols = Object.keys(updates);
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const params = cols.map((c) => updates[c]);

  if (enableMutex) {
    const tx = db.transaction(() => {
      const others = db.prepare(
        `SELECT id, dj_binding_json FROM avatars
         WHERE id != ? AND dj_binding_json IS NOT NULL
         AND json_extract(dj_binding_json, '$.enabled') = 1`,
      ).all(id);
      for (const other of others) {
        const otherBinding = safeParse(other.dj_binding_json, {});
        otherBinding.enabled = false;
        db.prepare('UPDATE avatars SET dj_binding_json = ? WHERE id = ?').run(
          JSON.stringify(otherBinding),
          other.id,
        );
      }
      db.prepare(
        `UPDATE avatars
         SET ${setClause},
             updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
         WHERE id = ?`,
      ).run(...params, id);
    });
    tx();
  } else {
    db.prepare(
      `UPDATE avatars
       SET ${setClause},
           updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
       WHERE id = ?`,
    ).run(...params, id);
  }

  return serializeDetail(db, getRow(db, id));
}

function updateDjBinding(db, avatarId, binding) {
  validateDjBinding(binding);
  const row = getRow(db, avatarId);
  if (!row) throw new NotFoundError();

  const json = binding === null ? null : JSON.stringify(binding);
  const enableMutex = binding && binding.enabled === true;

  if (enableMutex) {
    const tx = db.transaction(() => {
      const others = db.prepare(
        `SELECT id, dj_binding_json FROM avatars
         WHERE id != ? AND dj_binding_json IS NOT NULL
         AND json_extract(dj_binding_json, '$.enabled') = 1`,
      ).all(avatarId);
      for (const other of others) {
        const otherBinding = safeParse(other.dj_binding_json, {});
        otherBinding.enabled = false;
        db.prepare('UPDATE avatars SET dj_binding_json = ? WHERE id = ?').run(
          JSON.stringify(otherBinding),
          other.id,
        );
      }
      db.prepare(
        `UPDATE avatars
         SET dj_binding_json = ?,
             updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
         WHERE id = ?`,
      ).run(json, avatarId);
    });
    tx();
  } else {
    db.prepare(
      `UPDATE avatars
       SET dj_binding_json = ?,
           updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
       WHERE id = ?`,
    ).run(json, avatarId);
  }

  return serializeDetail(db, getRow(db, avatarId));
}

function updatePromptTemplate(db, id, promptTemplate) {
  const row = getRow(db, id);
  if (!row) throw new NotFoundError();
  validatePromptTemplate(promptTemplate);
  db.prepare(
    `UPDATE avatars
     SET prompt_template_json = ?,
         updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1)
     WHERE id = ?`,
  ).run(promptTemplate === null ? null : JSON.stringify(promptTemplate), id);
  return getPromptTemplate(db, id);
}

module.exports = {
  listAvatars,
  getAvatarDetail,
  resolveAvatarAvailability,
  isAvatarUnavailable,
  getAvatarVoice,
  getPromptTemplate,
  updatePromptTemplate,
  updateAvatar,
  updateDjBinding,
  serializeSummary,
  serializeDetail,
  getOfficialProfile,
  parsePublicProfile,
  validatePublicProfile,
  OFFICIAL_PROFILE_FIELDS,
  ValidationError,
  NotFoundError,
  PATCHABLE_FIELDS,
  READONLY_FIELDS,
  validatePromptTemplate,
  validateDjBinding,
  VALID_EMOTION_BASELINES,
};
