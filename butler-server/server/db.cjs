'use strict';

// 来源:Aiboo origin/main 1f430c3f server/db.cjs(精简版)
//
// 与 Aiboo 的两点不同:
// 1. 用 Node 内置 `node:sqlite`(v24 起可用)代替 better-sqlite3——launchd 拉起时用的是
//    ~/.dsh/node 的自有 node(v24),原生模块要对着那个 node 重新编译,升级 node 就要再编一次;
//    内置 sqlite 没有这个包袱。下面的 Db/Stmt 是一层薄适配,把 better-sqlite3 的用法
//    (db.prepare().run/get/all、db.transaction、@name 命名参数)原样保住,搬来的 service 一行不改。
// 2. 只建「形象 + 音色」这一刀用到的表:avatars / avatar_assets / tts_models / rtc_providers /
//    avatar_voice_bindings / logical_voice_mappings / app_settings,2026-09-14 加 call_records(通话记录)。其余(用户、旅程、漫画、DJ…)不建。
//
// 数据库与上传目录:~/.dsh/workbench/butler/{butler.sqlite, uploads/}(BUTLER_HOME 可覆盖,测试用)。

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { butlerHome } = require('./config.cjs');

const HOME = butlerHome();
const DB_PATH = process.env.BUTLER_DB_PATH || path.join(HOME, 'butler.sqlite');
// 所有上传的根;角色资源包在 uploads/avatars/<id>/v<n>/,背景/头像/铃声各自一个子目录。
const UPLOADS_BASE = process.env.BUTLER_UPLOADS_DIR ? path.resolve(process.env.BUTLER_UPLOADS_DIR) : path.join(HOME, 'uploads');
const UPLOADS_ROOT = path.join(UPLOADS_BASE, 'avatars');

// SQL 里出现过的命名参数(@a / :a / $a)。node:sqlite 对象绑定时多一个键就抛错,
// better-sqlite3 则宽容;这里按语句提前算出参数名,只绑用得到的键。
const NAMED_RE = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;

function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Stmt {
  constructor(raw, sql) {
    this.raw = raw;
    this.names = new Set();
    for (const m of sql.matchAll(NAMED_RE)) this.names.add(m[1]);
  }

  bindArgs(args) {
    if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Buffer.isBuffer(args[0]) && !ArrayBuffer.isView(args[0])) {
      const out = {};
      for (const [k, v] of Object.entries(args[0])) {
        if (this.names.has(k)) out[k] = coerce(v);
      }
      return [out];
    }
    return args.map(coerce);
  }

  run(...args) {
    return this.raw.run(...this.bindArgs(args));
  }

  get(...args) {
    return this.raw.get(...this.bindArgs(args));
  }

  all(...args) {
    return this.raw.all(...this.bindArgs(args));
  }
}

class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    return new Stmt(this.raw.prepare(sql), sql);
  }

  // better-sqlite3 风格:db.transaction(fn) 返回一个「在事务里跑 fn」的函数;嵌套用 SAVEPOINT。
  transaction(fn) {
    const self = this;
    return function tx(...args) {
      const nested = self.depth > 0;
      const name = `sp${self.depth}`;
      self.raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      self.depth += 1;
      try {
        const result = fn(...args);
        self.depth -= 1;
        self.raw.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        self.depth -= 1;
        try {
          self.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        } catch {
          /* 回滚失败无可再做 */
        }
        throw err;
      }
    };
  }

  close() {
    this.raw.close();
  }
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Db(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 给已存在的表幂等补列(CREATE TABLE IF NOT EXISTS 不会改既有表)。表名/列名均为代码常量。
function addColumnIfMissing(table, col, ddl, database = db) {
  const exists = database.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// 幂等建表,每次启动都跑。DDL 逐句取自 Aiboo db.cjs 的同名迁移。
function initSchema(database = db) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS avatars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      persona_json TEXT NOT NULL,
      transform_json TEXT NOT NULL,
      motions_json TEXT,
      model_entry TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS avatar_assets (
      avatar_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      zip_path TEXT NOT NULL,
      unpacked_dir TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_at INTEGER DEFAULT (strftime('%s', 'now')),
      restore_source_version INTEGER,
      restore_reason TEXT,
      restored_at INTEGER,
      PRIMARY KEY (avatar_id, version),
      FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_avatars_status_updated ON avatars(status, updated_at);

    CREATE TABLE IF NOT EXISTS tts_models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'dashscope',
      config_json TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tts_models_default ON tts_models(is_default);

    CREATE TABLE IF NOT EXISTS rtc_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'volcengine_rtc',
      config_json TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rtc_providers_default ON rtc_providers(is_default);

    CREATE TABLE IF NOT EXISTS avatar_voice_bindings (
      avatar_id TEXT NOT NULL,
      scene TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      voice_id TEXT NOT NULL,
      params_json TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (avatar_id, scene)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_bindings_provider ON avatar_voice_bindings(provider_id);

    CREATE TABLE IF NOT EXISTS logical_voice_mappings (
      logical_voice_id TEXT PRIMARY KEY,
      base_provider_id TEXT NOT NULL,
      base_voice_id TEXT NOT NULL,
      rtc_provider_id TEXT NOT NULL,
      rtc_voice_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_logical_voice_base
      ON logical_voice_mappings(base_provider_id, base_voice_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_logical_voice_rtc
      ON logical_voice_mappings(rtc_provider_id, rtc_voice_id);

    -- 通话记录(2026-09-14,来源 Aiboo call_records 的最小字段;user_id 换成 device_id):
    -- 谁(设备)、哪个形象、房间、任务、起止、时长、结束原因。见 services/callRecordStore.cjs。
    CREATE TABLE IF NOT EXISTS call_records (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL DEFAULT 'local',
      avatar_id TEXT NOT NULL DEFAULT '',
      room_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_seconds INTEGER,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_records_device ON call_records(device_id, started_at);
  `);

  // avatars 补列:与 Aiboo migrateAvatarColumns 一致,保证搬来的 avatarStore.serializeDetail 读到同样的列。
  // llm_model_id 保留列但本机没有模型库(PATCH 时会校验失败,前端不再暴露该字段)。
  addColumnIfMissing('avatars', 'llm_model_id', 'llm_model_id TEXT', database);
  addColumnIfMissing('avatars', 'voice', 'voice TEXT', database);
  addColumnIfMissing('avatars', 'default_background', 'default_background TEXT', database);
  addColumnIfMissing('avatars', 'dj_binding_json', 'dj_binding_json TEXT', database);
  addColumnIfMissing('avatars', 'prompt_template_json', 'prompt_template_json TEXT', database);
  addColumnIfMissing('avatars', 'opening_enabled', 'opening_enabled INTEGER NOT NULL DEFAULT 0', database);
  addColumnIfMissing('avatars', 'opening_text', 'opening_text TEXT', database);
  addColumnIfMissing('avatars', 'journey_runtime_enabled', 'journey_runtime_enabled INTEGER NOT NULL DEFAULT 0', database);
  addColumnIfMissing('avatars', 'idle_enhance_enabled', 'idle_enhance_enabled INTEGER NOT NULL DEFAULT 1', database);
  addColumnIfMissing('avatars', 'idle_enhance_interval_sec', 'idle_enhance_interval_sec INTEGER', database);
  addColumnIfMissing('avatars', 'portrait_url', 'portrait_url TEXT', database);
  addColumnIfMissing('avatars', 'ringtone_url', 'ringtone_url TEXT', database);
  addColumnIfMissing('avatars', 'notify_sound_url', 'notify_sound_url TEXT', database);
  addColumnIfMissing('avatars', 'public_profile_json', "public_profile_json TEXT NOT NULL DEFAULT '{}'", database);
  addColumnIfMissing('avatars', 'published_by', 'published_by TEXT', database);
  addColumnIfMissing('avatars', 'published_at', 'published_at INTEGER', database);
  addColumnIfMissing('avatars', 'unpublished_by', 'unpublished_by TEXT', database);
  addColumnIfMissing('avatars', 'unpublished_at', 'unpublished_at INTEGER', database);
  addColumnIfMissing('avatars', 'voice_sync_mode', "voice_sync_mode TEXT NOT NULL DEFAULT 'independent'", database);
}

initSchema();

module.exports = { db, Db, DB_PATH, UPLOADS_BASE, UPLOADS_ROOT, initSchema, addColumnIfMissing };
