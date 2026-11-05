'use strict';

// 账号搬到服务器(2026-09-21)。这一刀要堵的是上一张卡自己记下来的那个洞:
//
//   > 房间名 = `wb-<sha256(账号名) 前 16 位>`,而账号此刻只存在于用户自己那台 Mac 上,
//   > 中转对 `POST /register-device` 里的 `account` 不做任何校验。
//   > 知道(或猜到)别人账号名的人,可以拿这个名字领一张自己的设备令牌,
//   > 然后合法地签出**那个账号那一间房**的进房凭证 —— 于是他能进别人的电话。
//
// 堵法只有一条真路:**房间不再由"用户说自己叫什么"决定,而由"服务器认得这是谁"决定**。
//
//   注册 / 登录 → 会话令牌(长期、可吊销)
//        ↓ 凭会话令牌换
//   设备令牌(每台设备一把,记在账号名下)
//        ↓ 凭设备令牌签
//   进房凭证(只签得出 `wb-<sha256("acct:"+账号 id)>` 这一间)
//
// 账号 id 是服务器生成的 16 字节随机数,**猜不出来**;于是"知道账号名"这件事
// 从此一点用都没有 —— 这正是上一张卡缺的那一环。
//
// ## 密码只存加盐哈希
//
// scrypt(N=16384, r=8, p=1, 64 字节),盐 16 字节。算法与参数与工作台本机那一份
// (workbench-plugin/src/server/account.ts)**一模一样** —— 不是巧合:
// Ben 那台上已经有一份本机账号,迁移时要拿他原来的密码在服务器上重新算一次哈希,
// 两边参数不同就迁不过来(见交接「迁移怎么走」)。
//
// N 记进每一行里:以后调大了,老账号仍然验得动。
//
// ## 会话令牌只存哈希,与设备令牌同规矩
//
// 形状 `wbs_` + 32 字节随机 base64url。明文只在"刚发出来"那一次的响应体里出现,
// 库里只有 sha256。日志里只允许出现 prefix(前 8 个字符)。
// **没有到期时间**:它是"这台设备上还登着"的凭据,过期只会让人莫名其妙被踢出去;
// 要它失效的路是明确的两条 —— 自己登出,或者在「我的设备」里把这台移除。
//
// ## 为什么不叫 username 而叫 email_or_phone
//
// 服务器上的账号是**跨设备**的,将来要发验证码、要找回密码,只有邮箱/手机号担得起这件事。
// 但**这一版不验证**它真是邮箱还是手机号(Ben 那台上的本机账号叫什么就得能迁过来),
// 所以校验是宽的:去空白、转小写、1–128 个可见字符、不含空白。
// 字段名先立住,校验以后再收紧 —— 反过来做要动存量数据。

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/** 会话令牌的前缀。与设备令牌的 `wb_` 分开,日志里一眼认得出这是哪一种。 */
const SESSION_PREFIX = 'wbs_';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const IDENTIFIER_MAX = 128;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 200;

/** 设备名与类型的上限。它们会被显示在「我的设备」里,不设上限等于让人往界面里塞任意长的东西。 */
const DEVICE_NAME_MAX = 64;
/**
 * 设备类型只有这几种:界面上要按它画图标,自由字符串会让界面无从下手。
 *
 * 2026-09-23 多了 `handset` —— 树莓派上那只实体话筒。以前它只能报 `other`,
 * 于是中转签进房凭证时说不出「这是一只听筒」,工人把它当普通手机:
 * 通话的声音送去了手机、手机的座机页说「座机不在线」。
 * 这一类**不只是图标**:`/v1/channel-token` 按它往凭证里签 `wb_kind`(channel.cjs)。
 */
const DEVICE_KINDS = new Set(['mac', 'phone', 'windows', 'other', 'handset']);

/** 登录连错几次锁多久(与工作台本机那一份同一档:错 5 次锁 10 分钟)。 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60_000;

/**
 * 账号 id → 设备令牌行里的 `account` 列。
 *
 * 为什么要这么一层:`tokens.account` 这一列在这张卡之前装的是**用户自己起的名字**,
 * 而房间名、设备数封顶、设备列表全都按这一列分组。加一个前缀就能让两种账号在同一列里共存:
 *   - `acct:<16 字节随机 id>` —— 服务器账号下的设备(房间名由 id 算,**猜不出来**);
 *   - 别的任何字符串 —— 还没迁过来的老客户端(房间名由名字算,与这张卡之前一模一样)。
 * 于是"老包还能用"与"新包进不了别人的房"两件事同时成立,而且不用给 tokens 表搬家。
 */
function accountScopeOf(accountId) {
  return `acct:${accountId}`;
}

/** 反过来:这一行属于服务器账号吗?属于的话账号 id 是什么。 */
function accountIdOfScope(scope) {
  return typeof scope === 'string' && scope.startsWith('acct:') ? scope.slice(5) : undefined;
}

function newAccountId() {
  return crypto.randomBytes(16).toString('hex');
}

function newSessionToken() {
  return SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sessionPrefix(token) {
  return String(token).slice(0, 8);
}

function isSessionToken(value) {
  return typeof value === 'string' && value.startsWith(SESSION_PREFIX);
}

/**
 * 登录标识的规整。**只做拒收与大小写归一,不做"是不是真邮箱"的判断**(理由见文件头)。
 * 转小写是为了「Ben@x.com 与 ben@x.com 是同一个账号」——注册完隔天自己大写一个字母就登不进去,
 * 对一个不写代码的人来说这是彻底的死路。
 */
function normalizeIdentifier(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '登录用的邮箱或手机号要是一段文字' };
  const value = raw.trim().toLowerCase();
  if (value === '') return { ok: false, error: '登录用的邮箱或手机号不能是空的' };
  if (value.length > IDENTIFIER_MAX) return { ok: false, error: `登录用的邮箱或手机号最多 ${IDENTIFIER_MAX} 个字符` };
  if (/\s/.test(value)) return { ok: false, error: '登录用的邮箱或手机号里不能有空格' };
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7F) return { ok: false, error: '登录用的邮箱或手机号里不能有控制字符' };
  }
  return { ok: true, value };
}

/**
 * 请求体里那个标识字段。**认三个名字**:`email_or_phone` 是这一版立的正名,
 * `username` 与 `identifier` 是为了让电脑端那份「文案照旧」的登录页
 * (它问的一直是"用户名")能原样把值发过来,不用在客户端改个名字再发。
 */
function identifierFrom(body) {
  const raw = body === null || typeof body !== 'object' ? {} : body;
  for (const key of ['email_or_phone', 'identifier', 'username', 'account']) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') return normalizeIdentifier(raw[key]);
  }
  return { ok: false, error: '要填登录用的邮箱或手机号' };
}

function checkPassword(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '密码要是一段文字' };
  if (raw.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
  if (raw.length > PASSWORD_MAX) return { ok: false, error: `密码最多 ${PASSWORD_MAX} 位` };
  return { ok: true, value: raw };
}

/** 设备名:显示用,可有可无,过长就拒(不悄悄截断——截断会让人以为自己起的名字没生效)。 */
function checkDeviceName(raw) {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: '设备名要是一段文字' };
  const value = raw.trim();
  if (value === '') return { ok: true };
  if (value.length > DEVICE_NAME_MAX) return { ok: false, error: `设备名最多 ${DEVICE_NAME_MAX} 个字符` };
  return { ok: true, value };
}

function checkDeviceKind(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'other' };
  if (typeof raw !== 'string' || !DEVICE_KINDS.has(raw)) {
    return { ok: false, error: `设备类型只能是 ${[...DEVICE_KINDS].join(' / ')}` };
  }
  return { ok: true, value: raw };
}

async function derivePassword(password, salt, n = SCRYPT_N) {
  const buf = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * n * SCRYPT_R,
  });
  return buf.toString('hex');
}

/** 定长比较。两串不等长时 timingSafeEqual 会抛,所以先比长度。 */
function sameHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ────────────────────────────── 库这一层 ────────────────────────────── */

function findAccountByIdentifier(db, identifier) {
  return db.prepare('SELECT * FROM accounts WHERE identifier = ?').get(identifier) ?? undefined;
}

function findAccountById(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? undefined;
}

/**
 * 建账号。**identifier 上有 UNIQUE 约束**,所以"同时有两个人注册同一个邮箱"由库来裁决,
 * 不是靠先查后插那种会漏的写法。
 */
async function createAccount(db, { identifier, password, now = new Date() }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await derivePassword(password, salt);
  const id = newAccountId();
  const createdAt = now.toISOString();
  try {
    db.prepare(
      'INSERT INTO accounts (id, identifier, salt, hash, n, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run(id, identifier, salt, hash, SCRYPT_N, createdAt);
  }
  catch (error) {
    if (String(error?.message ?? '').includes('UNIQUE')) return { ok: false, taken: true };
    throw error;
  }
  return { ok: true, account: { id, identifier, salt, hash, n: SCRYPT_N, created_at: createdAt } };
}

/** 验密码。账号不存在也要**照样算一次 scrypt**,否则"这个邮箱注册过没有"能从响应时间看出来。 */
async function verifyAccountPassword(account, password) {
  const salt = account?.salt ?? '00000000000000000000000000000000';
  const n = Number(account?.n ?? SCRYPT_N);
  const hash = await derivePassword(password, salt, Number.isInteger(n) && n > 0 ? n : SCRYPT_N);
  if (account === undefined) return false;
  return sameHex(hash, account.hash);
}

/** 发一张会话令牌。明文只回这一次。 */
function issueSession(db, { accountId, now = new Date() }) {
  const token = newSessionToken();
  const createdAt = now.toISOString();
  db.prepare(
    'INSERT INTO account_sessions (token_hash, prefix, account_id, created_at, last_seen_at, revoked_at)'
    + ' VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(hashSecret(token), sessionPrefix(token), accountId, createdAt, createdAt);
  return { token, prefix: sessionPrefix(token), created_at: createdAt };
}

/** 认会话令牌 → 账号行。认不出(没这个、已吊销、账号已删)一律 undefined。 */
function findSession(db, token) {
  if (!isSessionToken(token)) return undefined;
  const row = db.prepare(
    'SELECT token_hash, prefix, account_id, created_at FROM account_sessions'
    + ' WHERE token_hash = ? AND revoked_at IS NULL',
  ).get(hashSecret(token));
  if (row === undefined || row === null) return undefined;
  const account = findAccountById(db, row.account_id);
  if (account === undefined) return undefined;
  return { session: row, account };
}

function revokeSession(db, token, now = new Date()) {
  if (!isSessionToken(token)) return 0;
  const info = db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now.toISOString(), hashSecret(token));
  return Number(info.changes ?? 0);
}

/**
 * 改密码。盐换一把,哈希重算。**不碰会话表** —— 撤别处的登录是 revokeOtherSessions 的事,
 * 两件事分开写,因为"改密码"与"把别人踢下去"是两个可以各自成立的决定。
 */
async function setAccountPassword(db, accountId, password, now = new Date()) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await derivePassword(password, salt);
  db.prepare('UPDATE accounts SET salt = ?, hash = ?, n = ?, updated_at = ? WHERE id = ?')
    .run(salt, hash, SCRYPT_N, now.toISOString(), accountId);
}

/** 把这个账号除了 `keep` 之外的会话全吊销。`keep` 是刚刚用来改密码的那一张。 */
function revokeOtherSessions(db, accountId, keep, now = new Date()) {
  const keepHash = typeof keep === 'string' && keep !== '' ? hashSecret(keep) : '';
  const info = db.prepare(
    'UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND token_hash <> ?',
  ).run(now.toISOString(), accountId, keepHash);
  return Number(info.changes ?? 0);
}

/** 这个账号名下此刻还活着的设备。「我的设备」显示的就是它。**不回令牌,也不回哈希**。 */
function devicesOfAccount(db, accountId) {
  const rows = db.prepare(
    'SELECT device_id, device_name, device_kind, created_at, last_seen_at, prefix FROM tokens'
    + ' WHERE account = ? AND revoked_at IS NULL ORDER BY created_at ASC',
  ).all(accountScopeOf(accountId));
  return rows.map(row => ({
    device_id: row.device_id,
    name: row.device_name ?? undefined,
    kind: row.device_kind ?? 'other',
    created_at: row.created_at,
    last_seen_at: row.last_seen_at ?? undefined,
  }));
}

/**
 * 移除一台设备 = 吊销它名下所有还活着的令牌。
 * **只在自己账号里找**:传别人的 device_id 进来什么也不会发生(不是报错,是 0 ——
 * 报错会告诉人"这个 device_id 存在于别的账号")。
 */
function revokeDevice(db, accountId, deviceId, now = new Date()) {
  const info = db.prepare(
    'UPDATE tokens SET revoked_at = ? WHERE account = ? AND device_id = ? AND revoked_at IS NULL',
  ).run(now.toISOString(), accountScopeOf(accountId), deviceId);
  return Number(info.changes ?? 0);
}

/** 记一下"这台设备刚出现过"。调用方负责限频(每台每分钟最多一次,见 app.cjs)。 */
function touchDevice(db, tokenHash, now = new Date()) {
  db.prepare('UPDATE tokens SET last_seen_at = ? WHERE token_hash = ?').run(now.toISOString(), tokenHash);
}

/** 给设备行补上名字与类型(register-device 时写)。 */
function describeDevice(db, tokenHash, { name, kind }) {
  db.prepare('UPDATE tokens SET device_name = ?, device_kind = ? WHERE token_hash = ?')
    .run(name ?? null, kind ?? 'other', tokenHash);
}

/**
 * `GET /v1/account/me` 的回包。**没有哈希、没有盐、没有令牌** —— 这个函数决定了
 * 账号这一侧哪些值出得了服务器,所以单独一条、有用例盯着。
 */
function accountView(account, extra = {}) {
  return {
    id: account.id,
    email_or_phone: account.identifier,
    created_at: account.created_at,
    ...extra,
  };
}

/**
 * 登录失败的计数与锁(内存,进程重启就清零)。
 *
 * 为什么不落库:登录是低频动作,而且锁本来就是"挡住此刻正在猜的人"——
 * 重启一次清零的代价远小于为它加一张表、再加一条清理任务。
 * **按标识分桶**,不按 IP:按 IP 的话同一个办公室里一个人猜错会把别人一起锁上。
 */
function createLoginGuard({ maxAttempts = MAX_LOGIN_ATTEMPTS, lockMs = LOGIN_LOCK_MS } = {}) {
  const state = new Map();
  return {
    /** 现在锁着吗?锁着回解锁时刻(毫秒),没锁回 undefined。 */
    lockedUntil(key, nowMs) {
      const entry = state.get(key);
      if (entry === undefined) return undefined;
      if (entry.until !== undefined && entry.until > nowMs) return entry.until;
      if (entry.until !== undefined) state.delete(key);
      return undefined;
    },
    /** 错一次。到上限就上锁,并把计数归零(同 workbench-plugin 那一份)。 */
    wrong(key, nowMs) {
      const entry = state.get(key) ?? { attempts: 0 };
      entry.attempts += 1;
      if (entry.attempts >= maxAttempts) {
        entry.attempts = 0;
        entry.until = nowMs + lockMs;
      }
      state.set(key, entry);
      return entry.until;
    },
    ok(key) { state.delete(key); },
  };
}

module.exports = {
  SESSION_PREFIX,
  SCRYPT_N,
  IDENTIFIER_MAX,
  PASSWORD_MIN,
  PASSWORD_MAX,
  DEVICE_NAME_MAX,
  DEVICE_KINDS,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_MS,
  accountScopeOf,
  accountIdOfScope,
  newAccountId,
  newSessionToken,
  hashSecret,
  sessionPrefix,
  isSessionToken,
  normalizeIdentifier,
  identifierFrom,
  checkPassword,
  checkDeviceName,
  checkDeviceKind,
  derivePassword,
  findAccountByIdentifier,
  findAccountById,
  createAccount,
  verifyAccountPassword,
  issueSession,
  findSession,
  revokeSession,
  setAccountPassword,
  revokeOtherSessions,
  devicesOfAccount,
  revokeDevice,
  touchDevice,
  describeDevice,
  accountView,
  createLoginGuard,
};
