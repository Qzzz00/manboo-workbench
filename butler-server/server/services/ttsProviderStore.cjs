'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/ttsProviderStore.cjs
// 类型化 TTS provider 库（dashscope | volcengine）。与 LLM/文生图的通用三件套不同：
// 每种类型字段不同，统一存进 config_json。密钥脱敏：list 只回非密钥字段 + 密钥 preview。

const { nanoid } = require('nanoid');

const ID_LENGTH = 10;

// 各类型的字段定义。required 用于 create 校验；secrets 决定脱敏 + 「空=不改」。
// 预留扩展位：以后加 volcengine_rtc 等只需在此登记。
const TYPES = {
  dashscope: {
    fields: ['apiUrl', 'apiKey', 'model'],
    required: ['apiUrl', 'apiKey', 'model'],
    secrets: ['apiKey'],
    urlFields: ['apiUrl'],
  },
  volcengine: {
    // appid/accessToken/cluster 用于 TTS 合成；ak/sk 用于「查询复刻音色」(OpenAPI)，可选。
    fields: ['appid', 'accessToken', 'cluster', 'ak', 'sk'],
    required: ['appid', 'accessToken', 'cluster'],
    secrets: ['accessToken', 'sk'],
    urlFields: [],
  },
  minimax: {
    // apiKey/groupId 必填；model/apiUrl/defaultVoice 可空（有代码默认）。
    fields: ['apiKey', 'groupId', 'model', 'apiUrl', 'defaultVoice'],
    required: ['apiKey', 'groupId'],
    secrets: ['apiKey'],
    urlFields: ['apiUrl'],
  },
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_tts_provider';
  }
}
class NotFoundError extends Error {
  constructor(message = 'TTS provider not found') {
    super(message);
    this.code = 'tts_provider_not_found';
  }
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
function maskPreview(v) {
  return v ? `…${String(v).slice(-4)}` : null;
}

function getRaw(db, id) {
  return db.prepare('SELECT * FROM tts_models WHERE id = ?').get(id) || null;
}

// 对外序列化：非密钥字段明文，密钥字段只给 { configured, preview }。
function serialize(row) {
  const spec = TYPES[row.provider_type] || { fields: [], secrets: [] };
  const config = JSON.parse(row.config_json || '{}');
  const publicConfig = {};
  const secrets = {};
  for (const f of spec.fields) {
    if (spec.secrets.includes(f)) {
      secrets[f] = { configured: Boolean(config[f]), preview: maskPreview(config[f]) };
    } else {
      publicConfig[f] = config[f] ?? '';
    }
  }
  return {
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    is_default: !!row.is_default,
    config: publicConfig,
    secrets,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function clearDefaults(db, exceptId) {
  if (exceptId) db.prepare('UPDATE tts_models SET is_default = 0 WHERE id != ?').run(exceptId);
  else db.prepare('UPDATE tts_models SET is_default = 0').run();
}

// 校验 + 归一一份 config（只保留该类型已知字段，trim）。
function normalizeConfig(type, input, { partial = false, existing = {} } = {}) {
  const spec = TYPES[type];
  if (!spec) throw new ValidationError(`unknown provider_type: ${type}`);
  const cfg = { ...existing };
  const src = input || {};
  for (const f of spec.fields) {
    if (!(f in src)) continue;
    const raw = typeof src[f] === 'string' ? src[f].trim() : '';
    // 密钥字段：空 = 不改（保留 existing）。
    if (spec.secrets.includes(f) && raw === '') continue;
    cfg[f] = raw;
  }
  if (!partial) {
    for (const f of spec.required) {
      if (!cfg[f]) throw new ValidationError(`${f} is required for ${type}`);
    }
  }
  for (const f of spec.urlFields) {
    if (cfg[f] && !isValidHttpUrl(cfg[f])) throw new ValidationError(`${f} must be a valid http(s) URL`);
  }
  return cfg;
}

function list(db) {
  return db
    .prepare('SELECT * FROM tts_models ORDER BY is_default DESC, created_at ASC')
    .all()
    .map(serialize);
}

function create(db, input) {
  const { name, provider_type: type, config, isDefault } = input || {};
  if (typeof name !== 'string' || !name.trim()) throw new ValidationError('name is required');
  if (!TYPES[type]) throw new ValidationError(`unknown provider_type: ${type}`);
  const cfg = normalizeConfig(type, config);
  const id = nanoid(ID_LENGTH);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tts_models (id, name, provider_type, config_json, is_default)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name.trim(), type, JSON.stringify(cfg), isDefault ? 1 : 0);
    if (isDefault) clearDefaults(db, id);
  });
  tx();
  return serialize(getRaw(db, id));
}

function update(db, id, patch) {
  const row = getRaw(db, id);
  if (!row) throw new NotFoundError();
  if (!patch || typeof patch !== 'object') throw new ValidationError('patch must be an object');

  const existing = JSON.parse(row.config_json || '{}');
  const updates = {};
  if ('name' in patch) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    updates.name = patch.name.trim();
  }
  if ('config' in patch && patch.config) {
    // provider_type 不可改；按现有类型 merge（密钥空=不改）。
    updates.config_json = JSON.stringify(
      normalizeConfig(row.provider_type, patch.config, { partial: true, existing }),
    );
  }

  const setDefault = 'isDefault' in patch ? Boolean(patch.isDefault) : null;

  const tx = db.transaction(() => {
    if (Object.keys(updates).length > 0) {
      const cols = Object.keys(updates);
      const setClause = cols.map((c) => `${c} = ?`).join(', ');
      db.prepare(`UPDATE tts_models SET ${setClause}, updated_at = strftime('%s','now') WHERE id = ?`).run(
        ...cols.map((c) => updates[c]),
        id,
      );
    }
    if (setDefault === true) {
      db.prepare("UPDATE tts_models SET is_default = 1, updated_at = strftime('%s','now') WHERE id = ?").run(id);
      clearDefaults(db, id);
    } else if (setDefault === false) {
      db.prepare("UPDATE tts_models SET is_default = 0, updated_at = strftime('%s','now') WHERE id = ?").run(id);
    }
  });
  tx();
  return serialize(getRaw(db, id));
}

function remove(db, id) {
  const row = getRaw(db, id);
  if (!row) throw new NotFoundError();
  db.prepare('DELETE FROM tts_models WHERE id = ?').run(id);
  return { id };
}

// 默认 provider 的完整明文配置，仅服务端内部用（合成 / 音色查询）。
function resolveDefault(db) {
  const row = db
    .prepare('SELECT * FROM tts_models WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1')
    .get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    config: JSON.parse(row.config_json || '{}'),
  };
}

module.exports = {
  TYPES,
  list,
  getRaw,
  create,
  update,
  remove,
  resolveDefault,
  ValidationError,
  NotFoundError,
};
