'use strict';

// 中转令牌:发、认、吊销。
//
// 形状 `wb_` + 32 字节随机的 base64url(约 43 字符)。前缀是为了在日志和管理接口里
// **一眼认出这是工作台的中转令牌**,而不是 DeepSeek 的 sk- 或 LiveKit 的凭证。
//
// 纪律(同 workbench-plugin/src/server/credentials.ts):
//   - 明文只在「刚发出来」那一次的响应体里出现,之后库里只有 sha256;
//   - 任何日志、任何管理接口的返回,只允许出现 `prefix`(前 8 个字符),不允许出现整串;
//   - 认不出来的令牌一律同一句话、同一个状态码,不区分「没这个」和「被吊销了」——
//     区分了就等于给猜令牌的人送信息。

const crypto = require('node:crypto');

const TOKEN_PREFIX = 'wb_';

function newToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** 令牌 → 库里的主键。同一串永远算出同一个值,所以能当主键用。 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 能出现在日志与管理接口里的那一小截。整串永远不允许。 */
function tokenPrefix(token) {
  return token.slice(0, 8);
}

/** `Authorization: Bearer wb_…` → 令牌本身。取不到就 undefined。 */
function bearerOf(header) {
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m === null) return undefined;
  const value = m[1].trim();
  return value === '' ? undefined : value;
}

function isRelayToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

/**
 * 发一个令牌。同一个(账号, 设备)再来一次 = 换一把新钥匙,旧的当场作废——
 * 因为库里只有哈希,「把上次那把再给你一遍」做不到(见 db.cjs 的注释)。
 * 重装客户端、换机器都会走到这里,所以它必须是可以随便重复调的。
 *
 * 返回 `{ token, prefix, account, device_id, daily_token_limit, created_at }`。
 * **`token` 是整串明文,调用方只许把它放进这一次的响应体**。
 */
function issueToken(db, { account, deviceId, dailyTokenLimit, deviceName, deviceKind, now = new Date() }) {
  const token = newToken();
  const hash = hashToken(token);
  const createdAt = now.toISOString();
  // 重领时把上一把的名字与类型接过来:用户在「我的设备」里给这台起过名,
  // 不该因为换了一把钥匙就变回「未命名」(2026-09-21)。
  const previous = db.prepare(
    'SELECT device_name, device_kind FROM tokens WHERE account = ? AND device_id = ? AND revoked_at IS NULL',
  ).get(account, deviceId);
  const name = deviceName ?? previous?.device_name ?? null;
  const kind = deviceKind ?? previous?.device_kind ?? null;
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE account = ? AND device_id = ? AND revoked_at IS NULL')
    .run(createdAt, account, deviceId);
  db.prepare(
    'INSERT INTO tokens (token_hash, prefix, account, device_id, daily_token_limit, created_at, revoked_at,'
    + ' device_name, device_kind, last_seen_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
  ).run(hash, tokenPrefix(token), account, deviceId, dailyTokenLimit, createdAt, name, kind, createdAt);
  return {
    token,
    prefix: tokenPrefix(token),
    account,
    device_id: deviceId,
    daily_token_limit: dailyTokenLimit,
    created_at: createdAt,
    ...(name === null ? {} : { device_name: name }),
    ...(kind === null ? {} : { device_kind: kind }),
  };
}

/** 认令牌。认不出来(不存在 / 已吊销)一律返回 undefined,调用方只说一句话。 */
function findToken(db, token) {
  if (!isRelayToken(token)) return undefined;
  const row = db.prepare(
    'SELECT token_hash, prefix, account, device_id, device_kind, daily_token_limit, created_at FROM tokens'
    + ' WHERE token_hash = ? AND revoked_at IS NULL',
  ).get(hashToken(token));
  return row ?? undefined;
}

/** 一个账号此刻有几把活着的钥匙(= 几台设备)。领令牌那条路靠它封顶。 */
function activeTokenCount(db, account) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE account = ? AND revoked_at IS NULL').get(account);
  return Number(row?.n ?? 0);
}

/** 吊销。按 prefix 吊——管理接口手上只有 prefix,没有明文(故意的)。 */
function revokeByPrefix(db, prefix, now = new Date()) {
  const info = db.prepare('UPDATE tokens SET revoked_at = ? WHERE prefix = ? AND revoked_at IS NULL')
    .run(now.toISOString(), prefix);
  return Number(info.changes ?? 0);
}

module.exports = {
  TOKEN_PREFIX,
  newToken,
  hashToken,
  tokenPrefix,
  bearerOf,
  isRelayToken,
  issueToken,
  findToken,
  activeTokenCount,
  revokeByPrefix,
};
