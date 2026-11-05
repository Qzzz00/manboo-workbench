'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/settingsStore.cjs(只留原始读写)
//
// Aiboo 的 settingsStore 管 DashScope/聊天/ASR/liblib/风险词等一大串键;形象与音色这一刀
// 用到 app_settings 表的只有键值原始读写(供以后放开关或迁移标记用)。resolveXxx 全部不搬,
// ASR 等以后搬时再按需补键。

const { db } = require('../db.cjs');

function getRaw(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row && typeof row.value === 'string' ? row.value : '';
}

function getAllRaw() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

const upsertStmt = db.prepare(
  `INSERT INTO app_settings (key, value, updated_at)
   VALUES (?, ?, strftime('%s','now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);
const deleteStmt = db.prepare('DELETE FROM app_settings WHERE key = ?');

// 空串 / null 视为「清除该键」。
function setOne(key, value) {
  if (value === '' || value == null) {
    deleteStmt.run(key);
    return;
  }
  upsertStmt.run(key, String(value));
}

function clear(key) {
  deleteStmt.run(key);
}

module.exports = { getRaw, getAllRaw, setOne, clear };
