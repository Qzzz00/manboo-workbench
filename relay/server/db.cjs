'use strict';

// 中转的库。四张表:账号、账号会话、设备令牌(「谁能用」)、用量(「用了多少」)。
//
// 与 butler-server 同一套选择:Node 内置 `node:sqlite`(v24 起),不要 better-sqlite3——
// 服务器上以后换 node 版本时不用重编原生模块。这里用位置参数(`?`),
// 所以不需要 butler-server 那层命名参数适配。
//
// ## 令牌只存哈希
//
// `tokens.token_hash` 是令牌明文的 sha256。库被拖走也拿不到能用的令牌,
// 代价是「重发一次同样的令牌」做不到——重新领就是换一个新的(revoke 旧的)。
// 这是有意的:令牌是钥匙,钥匙没有「再看一眼」这回事(同工作台凭据那条规矩)。
//
// ## 用量按天汇总,不存每一条请求
//
// 一行 = 一个令牌的一天。不存 prompt 内容、不存 message、不存任何用户说过的话——
// 中转是「代发」,不是「留底」。要排查只看得到:哪个令牌、哪天、几次、多少 token。
//
// ## 账号(2026-09-21)
//
// `accounts` 一行 = 一个人。密码只存 scrypt 加盐哈希(server/accounts.cjs),
// `identifier` 上有 UNIQUE —— 「同一个邮箱注册两次」由库裁决,不靠先查后插。
// `account_sessions` 一行 = 一次登录(一台设备上的登录态),同样只存令牌哈希。
//
// ## 存量库要能原地升上来
//
// 服务器上那张 `tokens` 表里已经有 Ben 那台 Mac 的令牌。这一版给它补三列
// (归谁、叫什么、上次什么时候在线),用 `ALTER TABLE … ADD COLUMN` 逐列补,
// **补过就跳过**(node:sqlite 没有 `ADD COLUMN IF NOT EXISTS`,所以先读 PRAGMA)。
// 老行的新列都是 NULL,读的时候按"没填"处理 —— 不需要停服、不需要导数据。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { COLLAB_SCHEMA } = require('./collab.cjs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  token_hash        TEXT PRIMARY KEY,
  prefix            TEXT NOT NULL,
  account           TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  daily_token_limit INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  revoked_at        TEXT
);
CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account);

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL UNIQUE,
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  n           INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash   TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id);

-- 搜索代理的用量(2026-09-21)。**与 usage_daily 分开一张表**:搜索按「次」计费、
-- 按次限额,跟他今天问了模型多少 token 是两件事,混在一行里会逼着调用方去猜
-- 「requests 这一列到底数的是哪一种请求」。一行 = 一个令牌的一天。
CREATE TABLE IF NOT EXISTS search_daily (
  token_hash        TEXT NOT NULL,
  day               TEXT NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, day)
);

-- 远程错误上报(2026-09-22)。一行 = 用户那台机器上出的一次错。
-- **保留 30 天**(server/diag.cjs 的 pruneDiagReports,在每次读写时顺手清)——
-- 它是排障材料,不是业务数据,所以过期自动消失,不靠谁记得去删。
--
-- token_hash 在这里只当「哪台设备」的键用,**不出现在任何接口的返回里**。
-- stack / log 存成换行分隔的文本(sqlite 没有数组),读出来时再 split ——
-- 存成 JSON 会让「在服务器上 grep 一下库文件」这种最土的排障办法失效,而那一招很管用。
CREATE TABLE IF NOT EXISTS diag_reports (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  account     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  version     TEXT NOT NULL,
  component   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  stack       TEXT NOT NULL,
  log         TEXT NOT NULL,
  merged      INTEGER NOT NULL DEFAULT 1,
  at          TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- 「反馈给开发者」那一类(kind='feedback',2026-09-28 卡 FB)多的两格:
  -- said = 用户的原话(擦过),context = 当时的模板 / 布局。报错那四类这两格是 NULL。
  said        TEXT,
  context     TEXT
);
-- 限频数的是「这台设备这一小时几条」,列表按收到的时刻倒序 —— 两条索引各管一件事。
CREATE INDEX IF NOT EXISTS diag_reports_device ON diag_reports(token_hash, received_at);
CREATE INDEX IF NOT EXISTS diag_reports_received ON diag_reports(received_at);

-- 诊断包存放位(2026-10-21,server/diagPacks.cjs)。一行 = 一个传上来的 zip,文件在 RELAY_HOME/diag-packs/<code>.zip。
-- **7 天**后行与文件一起清掉。token_hash 同 diag_reports 只当「哪台设备」的键,不出现在任何回包里。
CREATE TABLE IF NOT EXISTS diag_packs (
  code        TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  account     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  version     TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diag_packs_device ON diag_packs(token_hash, received_at);
CREATE INDEX IF NOT EXISTS diag_packs_expires ON diag_packs(expires_at);

-- 一行 = 一个令牌、一天、**一家上游**(2026-09-22 起多了 provider 这一列)。
-- 额度仍按三家之和算(usage.cjs 的 usageOfDay 就是 SUM);分家只为看得见钱花在谁身上
-- —— 三份各自独立的额度会变成「今天的钱没用完但这家用完了」那种没人懂的状态。
CREATE TABLE IF NOT EXISTS usage_daily (
  token_hash        TEXT NOT NULL,
  day               TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'deepseek',
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_cny    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, day, provider)
);

`;

/**
 * 存量表要补的列。`CREATE TABLE IF NOT EXISTS` 对**已经存在**的表一个字都不会改,
 * 所以新列只能这么补。全是可空列 + 无默认值:老行读出来是 NULL,调用方按"没填"处理。
 */
const ADDED_COLUMNS = [
  ['tokens', 'device_name', 'TEXT'],
  ['tokens', 'device_kind', 'TEXT'],
  ['tokens', 'last_seen_at', 'TEXT'],
  // 2026-09-28(卡 FB):反馈那一类的原话与当时的模板 / 布局。老行是 NULL = 没填。
  ['diag_reports', 'said', 'TEXT'],
  ['diag_reports', 'context', 'TEXT'],
];

/**
 * 用量表按钱记账要的三列(2026-09-23,「中转额度按钱算」)。
 *
 * - `cache_hit_tokens` / `cache_miss_tokens`:输入里缓存命中与未命中各多少,只作参考;
 * - `cost_micro_cny`:折成人民币的**微元**(百万分之一元)整数 —— 额度拿它跟上限比。
 *
 * 与上面 ADDED_COLUMNS 不同,这三列是 `NOT NULL DEFAULT 0`(sqlite 允许 ADD COLUMN 带非空常量缺省):
 * 老行读出来就是 0,SUM 不会碰到 NULL。**老行不回填成本** —— 那时没记命中/未命中,
 * 回填只能是估,而估出来的数会被当成真的钱(同 recordUsage 那条「不猜不估」)。
 * 升级当天升级前的那部分用量因此记 0 元,第二天零点就翻篇了(交接里写明)。
 *
 * ★ 必须在 migrateUsageProvider **之后**补:那一步会重建整张表,先补的列会被它丢掉。
 */
const USAGE_COST_COLUMNS = [
  ['usage_daily', 'cache_hit_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_daily', 'cache_miss_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_daily', 'cost_micro_cny', 'INTEGER NOT NULL DEFAULT 0'],
];

/** 这张 usage_daily 是新形状吗(有没有 provider 那一列)。 */
function usageDailyHasProvider(db) {
  return db.prepare('PRAGMA table_info(usage_daily)').all().some(row => row.name === 'provider');
}

/**
 * 用量表加 provider 那一列(2026-09-22)。
 *
 * ★ **这一条不能用 `ALTER TABLE … ADD COLUMN`**,与上面那三列不同:
 * 加一列容易,难的是**主键**——老表的 PK 是 `(token_hash, day)`,同一天第二家上游
 * 插进去就撞主键。sqlite 改不了已有表的主键,所以只能走它文档里那套「建新表 → 搬数据 →
 * 换名字」。搬的时候老行一律记成 `deepseek`:这一版之前中转只转 DeepSeek,
 * 那些行**本来就只可能是** DeepSeek —— 这不是猜,是事实。
 *
 * 幂等靠 `usageDailyHasProvider`:升过就一个字都不做(每次启动都会跑一遍)。
 * 整段在一个事务里:中途断电要么全成要么全不成,不会留下半张表。
 */
function migrateUsageProvider(db) {
  const columns = db.prepare('PRAGMA table_info(usage_daily)').all();
  if (columns.length === 0) return; // 表还没建(SCHEMA 先跑,正常到不了这儿)
  if (columns.some(row => row.name === 'provider')) return;
  db.exec(`
    BEGIN;
    CREATE TABLE usage_daily_new (
      token_hash        TEXT NOT NULL,
      day               TEXT NOT NULL,
      provider          TEXT NOT NULL DEFAULT 'deepseek',
      requests          INTEGER NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (token_hash, day, provider)
    );
    INSERT INTO usage_daily_new (token_hash, day, provider, requests, prompt_tokens, completion_tokens, total_tokens)
      SELECT token_hash, day, 'deepseek', requests, prompt_tokens, completion_tokens, total_tokens FROM usage_daily;
    DROP TABLE usage_daily;
    ALTER TABLE usage_daily_new RENAME TO usage_daily;
    COMMIT;
  `);
}

/** 逐列补。已经有了就跳过 —— 重复跑不出错(每次启动都会跑一遍)。 */
function addColumns(db, list) {
  for (const [table, column, type] of list) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length === 0) continue; // 表还没建(只在手搭的老库用例里会遇到)
    if (columns.some(row => row.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function migrate(db) {
  addColumns(db, ADDED_COLUMNS);
  migrateUsageProvider(db);
  addColumns(db, USAGE_COST_COLUMNS);
}

/**
 * 打开(必要时建)库。`:memory:` 也认——测试里跑得最快的那条路。
 * 返回的是裸 DatabaseSync:这一层薄到不值得再包一层,调用方直接 prepare。
 */
function openRelayDb(file, opts = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL:一个写(记账)一堆读(查额度)并发时不互相卡。内存库不支持,跳过。
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 协作区的表(2026-10-21)全是新表,CREATE IF NOT EXISTS 就够,存量库原地升。
  // 2026-11-09 起受总开关管:**没显式开就不建**。生产由 index.cjs 从 config.collabEnabled 传进来;
  // 单测要跑协作区那一块就 openRelayDb(':memory:', { collab: true })。
  if (opts.collab === true) db.exec(COLLAB_SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openRelayDb, SCHEMA, migrate, migrateUsageProvider, usageDailyHasProvider, ADDED_COLUMNS, USAGE_COST_COLUMNS };
