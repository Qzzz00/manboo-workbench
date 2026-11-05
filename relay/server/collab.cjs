'use strict';

// 协作区的跨机底座(2026-10-21):账号组、收件箱、对象目录、频道。
// 契约见 docs/设计-工作室频道与层包-2026-10-20.md 第一、二节(10-21 待拍板全部按建议定)
// 与 docs/设计-协作区-无限画布-2026-10-21.md 第三、六节;本文件只放库与纯规则,HTTP 在 collabRoutes.cjs。
//
// ## 几条口径
//
// - **序号由中转在一个事务里分配**:每账号每队列一个单调整数(inbox_heads.last_cursor)。
//   删过期行不回收号,所以 `since` 落在被删的那一段里 → 410,客户端重取快照。
// - **频道是唯一一类由中转做权威写入方的对象**:消息 seq = 频道 version,频道内全序、无洞。
//   卡 / 项目 / 目标 / Agent 名片的权威写入方是主人的座机服务,中转只按目录路由与扇出。
// - **中转存正文**(待拍板 2):频道消息 30 天;附件只存取件单引用,字节不过中转。
// - **撤回不删原行**:撤回是一条 system 消息引用原消息;快照里原消息折成「已撤回」,正文不再给出。

const crypto = require('node:crypto');

const COLLAB_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  nick         TEXT NOT NULL,
  joined_at    TEXT NOT NULL,
  removed_at   TEXT,
  PRIMARY KEY (workspace_id, account_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_account ON workspace_members(account_id);

-- 邀请码只存 sha256(同令牌那条规矩);明文只在发码那一次的回包里。
CREATE TABLE IF NOT EXISTS workspace_invites (
  code_hash    TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_by      TEXT,
  used_at      TEXT
);

-- 每账号两条队列的「下一个号」与「删到了哪」。号不随删行回收。
CREATE TABLE IF NOT EXISTS inbox_heads (
  account_id     TEXT NOT NULL,
  queue          TEXT NOT NULL,
  last_cursor    INTEGER NOT NULL DEFAULT 0,
  pruned_through INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, queue)
);

-- workspace_id = 这一行是凭哪个工作室的成员身份扇给收件人的;NULL = 收件人自己的东西(自己对象的事件、
-- 自己请求的结果)。读时只给收件人此刻仍在册的工作室的行:被移出后另起 / 加入别的工作室,旧积压读不回。
CREATE TABLE IF NOT EXISTS inbox_events (
  account_id     TEXT NOT NULL,
  cursor         INTEGER NOT NULL,
  workspace_id   TEXT,
  kind           TEXT NOT NULL,
  origin_device  TEXT,
  origin_seq     INTEGER,
  object_id      TEXT,
  object_version INTEGER,
  payload        TEXT NOT NULL,
  at             TEXT NOT NULL,
  PRIMARY KEY (account_id, cursor),
  UNIQUE (account_id, origin_device, origin_seq)
);
CREATE INDEX IF NOT EXISTS inbox_events_at ON inbox_events(at);

CREATE TABLE IF NOT EXISTS inbox_requests (
  account_id           TEXT NOT NULL,
  cursor               INTEGER NOT NULL,
  request_id           TEXT NOT NULL,
  from_account         TEXT NOT NULL,
  from_device          TEXT NOT NULL,
  op                   TEXT NOT NULL,
  object_id            TEXT,
  expected_owner_epoch INTEGER,
  args                 TEXT NOT NULL,
  at                   TEXT NOT NULL,
  state                TEXT NOT NULL,
  result               TEXT,
  done_at              TEXT,
  PRIMARY KEY (account_id, cursor),
  UNIQUE (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS inbox_requests_done ON inbox_requests(state, done_at);

CREATE TABLE IF NOT EXISTS objects (
  object_id     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  owner_account TEXT,
  owner_device  TEXT,
  owner_epoch   INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT NOT NULL,
  title         TEXT NOT NULL,
  data          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_workspace ON objects(workspace_id, kind);

CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  project_object_id TEXT UNIQUE,
  name              TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  archived_at       TEXT,
  version           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channels_workspace ON channels(workspace_id);

CREATE TABLE IF NOT EXISTS channel_messages (
  channel_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  id             TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  author_account TEXT NOT NULL,
  author_nick    TEXT NOT NULL,
  author_device  TEXT NOT NULL,
  butler         INTEGER NOT NULL DEFAULT 0,
  via            TEXT,
  text           TEXT NOT NULL,
  refs           TEXT NOT NULL,
  attachments    TEXT NOT NULL,
  reply_to       TEXT,
  link           TEXT,
  retract_of     TEXT,
  retracted_by   TEXT,
  retracted_at   TEXT,
  request_id     TEXT NOT NULL,
  origin_seq     INTEGER,
  at             TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq),
  UNIQUE (channel_id, request_id)
);
CREATE INDEX IF NOT EXISTS channel_messages_at ON channel_messages(at);

-- 每台设备「读到哪」的书签(断线续读用;不删任何一行、不进账)。GET 不带 since 时从这里续。
CREATE TABLE IF NOT EXISTS inbox_acks (
  account_id TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  queue      TEXT NOT NULL,
  last_acked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id, queue)
);

-- 定时派活的回调地址。地址里的密钥只存哈希;轮换 = 换一把,旧的当场作废。
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  secret_hash  TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  label        TEXT NOT NULL,
  target       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  rotated_at   TEXT,
  revoked_at   TEXT,
  last_hit_at  TEXT
);
CREATE INDEX IF NOT EXISTS webhooks_account ON webhooks(account_id);

-- 企业微信群 ↔ 频道。chatid 是企微给的群号;绑定码在协作区设置里生成,群里 @机器人「绑定 <码>」生效。
CREATE TABLE IF NOT EXISTS wecom_bindings (
  chatid       TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  bound_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wecom_bind_codes (
  code         TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
-- 群里一句话变成的请求,办完要回群:企微的 response_url 一小时内有效、只能用一次。
CREATE TABLE IF NOT EXISTS wecom_receipts (
  to_account   TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  response_url TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (to_account, request_id)
);
`;

const ROLES = new Set(['member', 'admin']);
const OBJECT_KINDS = new Set(['card', 'project', 'agent', 'goal']);
const VISIBILITIES = new Set(['workspace', 'owner']);
const MESSAGE_KINDS = new Set(['say', 'daily', 'weekly', 'status', 'system']);
/**
 * 请求的种类。名字按 docs/设计-账的对象与动作-2026-10-21.md 4.3「一个动作一个名字」:
 * 旧的 card.comment / card.create / object.transfer → task.comment / task.create / task.transfer;
 * card.feedback 拆成 task.accept(通过)与 task.return(改一改 / 我自己改,args.by 区分)。
 * `agent.dispatch` 是协作区设计稿六节的;`timer.fire` 只由中转自己投(webhook),客户端发不了。
 */
const REQUEST_OPS = new Set(['task.create', 'task.comment', 'task.say', 'task.accept', 'task.return', 'task.transfer', 'agent.dispatch']);
const SERVER_OPS = new Set(['timer.fire']);
/** 只有电脑那一类能拉请求队列(它是这个账号名下对象的权威写入方)。NULL = 9-21 之前领的老令牌,全是 Mac。 */
const DESK_KINDS = new Set(['mac', 'windows']);

const INVITE_TTL_MS = 24 * 3_600_000;
/** 缺省保留期;部署时可由 RELAY_INBOX_EVENT_DAYS / RELAY_INBOX_DONE_REQUEST_DAYS 改(config.cjs)。 */
const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;
const DONE_REQUEST_RETENTION_MS = 7 * 24 * 3_600_000;
const PAGE_MAX = 200;
const LONG_POLL_MAX_S = 25;
const TEXT_MAX = 4000;
const NICK_MAX = 32;
const NAME_MAX = 64;
const TITLE_MAX = 200;
const ID_MAX = 200;
const REFS_MAX = 20;
const ATTACHMENTS_MAX = 10;
const ARGS_MAX_BYTES = 32 * 1024;
/** 主人那台座机服务多久没露面就算离线。长轮询 25 秒一拍,认令牌写「最后在线」每分钟最多一次。 */
const ONLINE_WINDOW_MS = 2 * 60_000;

/** 邀请码 8 位:去掉 0/O、1/I/L 这几个念出来会错的。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

class CollabError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function newId() {
  return Date.now().toString(36).padStart(9, '0') + crypto.randomBytes(8).toString('hex');
}

function newCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function text(value, max) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '' || v.length > max) return undefined;
  return v;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

let txDepth = 0;
/** 一次提交 = 一个事务。可嵌套:里层不另开事务。 */
function tx(db, fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const out = fn();
    txDepth -= 1;
    db.exec('COMMIT');
    return out;
  }
  catch (error) {
    txDepth -= 1;
    db.exec('ROLLBACK');
    throw error;
  }
}

// ───────────────────────── 账号组 ─────────────────────────

function activeMembership(db, accountId) {
  return db.prepare(
    'SELECT m.workspace_id, m.account_id, m.role, m.nick, m.joined_at, w.name, w.created_at, w.created_by'
    + ' FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id'
    + ' WHERE m.account_id = ? AND m.removed_at IS NULL ORDER BY m.joined_at ASC',
  ).get(accountId) ?? undefined;
}

function memberOf(db, workspaceId, accountId) {
  return db.prepare(
    'SELECT workspace_id, account_id, role, nick, joined_at, removed_at FROM workspace_members'
    + ' WHERE workspace_id = ? AND account_id = ?',
  ).get(workspaceId, accountId) ?? undefined;
}

function isActiveMember(db, workspaceId, accountId) {
  const row = memberOf(db, workspaceId, accountId);
  return row !== undefined && row.removed_at === null;
}

function activeMemberIds(db, workspaceId) {
  return db.prepare('SELECT account_id FROM workspace_members WHERE workspace_id = ? AND removed_at IS NULL')
    .all(workspaceId).map(row => row.account_id);
}

function workspaceView(row) {
  return { id: row.workspace_id ?? row.id, name: row.name, created_by: row.created_by, created_at: row.created_at };
}

function requireMembership(db, accountId) {
  const m = activeMembership(db, accountId);
  if (m === undefined) throw new CollabError(403, 'not_in_workspace', '你不在任何工作室里(可能已被移除)。');
  return m;
}

function requireAdmin(db, accountId) {
  const m = requireMembership(db, accountId);
  if (m.role !== 'admin') throw new CollabError(403, 'not_admin', '只有工作室管理员能做这一步。');
  return m;
}

function checkNick(raw) {
  const nick = text(raw, NICK_MAX);
  if (nick === undefined) throw new CollabError(400, 'bad_nick', `花名要 1–${NICK_MAX} 个字。`);
  return nick;
}

function createWorkspace(db, { accountId, name, nick, now }) {
  const wsName = text(name, NAME_MAX);
  if (wsName === undefined) throw new CollabError(400, 'bad_name', `工作室名字要 1–${NAME_MAX} 个字。`);
  const memberNick = checkNick(nick);
  return tx(db, () => {
    // 待拍板 1:第一版一个账号只在一个工作室里(表允许多个,界面不做切换)。
    if (activeMembership(db, accountId) !== undefined) {
      throw new CollabError(409, 'already_in_workspace', '你已经在一个工作室里了;第一版一个账号只进一个工作室。');
    }
    const at = now.toISOString();
    const id = `ws:${crypto.randomBytes(16).toString('hex')}`;
    db.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, wsName, accountId, at);
    db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, nick, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, accountId, 'admin', memberNick, at);
    const channel = createChannelRow(db, { workspaceId: id, kind: 'workspace', name: wsName, createdBy: accountId, now });
    return { workspace: { id, name: wsName, created_by: accountId, created_at: at }, member: { account_id: accountId, nick: memberNick, role: 'admin' }, channel };
  });
}

function createInvite(db, { accountId, now }) {
  const m = requireAdmin(db, accountId);
  const at = now.toISOString();
  const expires = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    try {
      db.prepare('INSERT INTO workspace_invites (code_hash, workspace_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(code), m.workspace_id, accountId, at, expires);
      return { code, workspace_id: m.workspace_id, expires_at: expires };
    }
    catch { /* 撞号了再来一个 */ }
  }
  throw new CollabError(500, 'invite_failed', '邀请码没生成出来,再点一次。');
}

function joinWorkspace(db, { accountId, code, nick, now }, notify) {
  const memberNick = checkNick(nick);
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return tx(db, () => {
    const codeHash = sha256(normalized);
    const invite = db.prepare('SELECT * FROM workspace_invites WHERE code_hash = ?').get(codeHash);
    if (invite === undefined) throw new CollabError(404, 'invite_unknown', '这个邀请码不认识,核对一下 8 位字母数字。');
    if (invite.used_by !== null) throw new CollabError(409, 'invite_used', '这个邀请码已经用过了,请管理员再发一个。');
    if (Date.parse(invite.expires_at) <= now.getTime()) throw new CollabError(410, 'invite_expired', '这个邀请码过期了(24 小时),请管理员再发一个。');
    if (activeMembership(db, accountId) !== undefined) {
      throw new CollabError(409, 'already_in_workspace', '你已经在一个工作室里了;第一版一个账号只进一个工作室。');
    }
    const at = now.toISOString();
    db.prepare('UPDATE workspace_invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(accountId, at, codeHash);
    // 被移除过又回来:复用那一行(不删的纪律),角色回到 member。
    const existing = memberOf(db, invite.workspace_id, accountId);
    if (existing === undefined) {
      db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, nick, joined_at) VALUES (?, ?, ?, ?, ?)')
        .run(invite.workspace_id, accountId, 'member', memberNick, at);
    }
    else {
      db.prepare('UPDATE workspace_members SET role = ?, nick = ?, joined_at = ?, removed_at = NULL WHERE workspace_id = ? AND account_id = ?')
        .run('member', memberNick, at, invite.workspace_id, accountId);
    }
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(invite.workspace_id);
    memberEvent(db, invite.workspace_id, { account_id: accountId, nick: memberNick, role: 'member', change: 'joined' }, now, notify);
    systemNote(db, workspaceChannelId(db, invite.workspace_id), accountId, `${memberNick} 加入了工作室`, now, notify);
    return { workspace: workspaceView(ws), member: { account_id: accountId, nick: memberNick, role: 'member' } };
  });
}

function adminCount(db, workspaceId) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'admin' AND removed_at IS NULL")
    .get(workspaceId).n);
}

function setMemberRole(db, { accountId, target, role, now }, notify) {
  if (!ROLES.has(role)) throw new CollabError(400, 'bad_role', '角色只有 member / admin 两档。');
  const m = requireAdmin(db, accountId);
  return tx(db, () => {
    const row = memberOf(db, m.workspace_id, target);
    if (row === undefined || row.removed_at !== null) throw new CollabError(404, 'member_unknown', '工作室里没有这个人。');
    if (row.role === 'admin' && role !== 'admin' && adminCount(db, m.workspace_id) <= 1) {
      throw new CollabError(409, 'last_admin', '这是工作室里最后一个管理员,先把别人设成管理员。');
    }
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND account_id = ?').run(role, m.workspace_id, target);
    memberEvent(db, m.workspace_id, { account_id: target, nick: row.nick, role, change: 'role' }, now, notify);
    return { account_id: target, nick: row.nick, role };
  });
}

/** 移除(或自己退出:target = 自己)。只记 removed_at,不删行;他发过的消息、登记过的对象都留着。 */
function removeMember(db, { accountId, target, now }, notify) {
  const self = target === accountId;
  const m = self ? requireMembership(db, accountId) : requireAdmin(db, accountId);
  return tx(db, () => {
    const row = memberOf(db, m.workspace_id, target);
    if (row === undefined || row.removed_at !== null) throw new CollabError(404, 'member_unknown', '工作室里没有这个人。');
    if (row.role === 'admin' && adminCount(db, m.workspace_id) <= 1) {
      throw new CollabError(409, 'last_admin', '这是工作室里最后一个管理员,先把别人设成管理员。');
    }
    // 先发事件再标移除:被移除的人自己的队列里也有这一条(他的三端下一次拉会先 403,设置页据此说清)。
    memberEvent(db, m.workspace_id, { account_id: target, nick: row.nick, role: row.role, change: 'removed' }, now, notify);
    db.prepare('UPDATE workspace_members SET removed_at = ? WHERE workspace_id = ? AND account_id = ?')
      .run(now.toISOString(), m.workspace_id, target);
    systemNote(db, workspaceChannelId(db, m.workspace_id), accountId, `${row.nick} ${self ? '退出了' : '已不在'}工作室`, now, notify);
    return { removed: true, account_id: target };
  });
}

function devicesOf(db, accountId) {
  return db.prepare(
    'SELECT device_id, device_name, device_kind, last_seen_at FROM tokens WHERE account = ? AND revoked_at IS NULL ORDER BY created_at ASC',
  ).all(`acct:${accountId}`).map(row => ({
    device_id: row.device_id,
    kind: row.device_kind ?? 'other',
    ...(row.device_name === null ? {} : { name: row.device_name }),
    ...(row.last_seen_at === null ? {} : { last_seen_at: row.last_seen_at }),
  }));
}

/** `GET /v1/workspace/me`:我在哪个工作室、成员表(含每台设备最后在线)、频道清单。「谁在工作室」的唯一出口。 */
function workspaceMe(db, accountId) {
  const m = activeMembership(db, accountId);
  if (m === undefined) return { workspace: null };
  const members = db.prepare(
    'SELECT account_id, nick, role, joined_at FROM workspace_members WHERE workspace_id = ? AND removed_at IS NULL ORDER BY joined_at ASC, rowid ASC',
  ).all(m.workspace_id).map(row => ({ ...row, devices: devicesOf(db, row.account_id) }));
  return {
    workspace: workspaceView(m),
    me: { account_id: accountId, nick: m.nick, role: m.role },
    members,
    channels: listChannels(db, accountId),
  };
}

// ───────────────────────── 收件箱 ─────────────────────────

function nextCursor(db, accountId, queue) {
  db.prepare('INSERT OR IGNORE INTO inbox_heads (account_id, queue) VALUES (?, ?)').run(accountId, queue);
  db.prepare('UPDATE inbox_heads SET last_cursor = last_cursor + 1 WHERE account_id = ? AND queue = ?').run(accountId, queue);
  return Number(db.prepare('SELECT last_cursor FROM inbox_heads WHERE account_id = ? AND queue = ?').get(accountId, queue).last_cursor);
}

function headOf(db, accountId, queue) {
  const row = db.prepare('SELECT last_cursor, pruned_through FROM inbox_heads WHERE account_id = ? AND queue = ?').get(accountId, queue);
  return { last: Number(row?.last_cursor ?? 0), pruned: Number(row?.pruned_through ?? 0) };
}

/**
 * 往一个账号的事件队列放一条。`originSeq` 有值时按 (账号, 设备, seq) 去重:已经有了就回 undefined,不占号。
 * 调用方负责事务(扇出要么全成要么全不成)。
 */
function appendEvent(db, accountId, { kind, workspaceId, objectId, objectVersion, originDevice, originSeq, payload, now }) {
  if (originSeq !== undefined && originSeq !== null) {
    const seen = db.prepare('SELECT cursor FROM inbox_events WHERE account_id = ? AND origin_device = ? AND origin_seq = ?')
      .get(accountId, originDevice ?? null, originSeq);
    if (seen !== undefined) return undefined;
  }
  const cursor = nextCursor(db, accountId, 'events');
  db.prepare(
    'INSERT INTO inbox_events (account_id, cursor, workspace_id, kind, origin_device, origin_seq, object_id, object_version, payload, at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, cursor, workspaceId ?? null, kind, originDevice ?? null, originSeq ?? null, objectId ?? null, objectVersion ?? null,
    JSON.stringify(payload ?? {}), now.toISOString());
  return cursor;
}

/**
 * 扇出。`event.workspaceId` = 凭哪个工作室扇的;`event.self` = 这件事是谁自己的(对象主人),
 * 他那一份记 workspace_id = NULL —— 被移出之后自己对象的事件仍读得回。
 */
function fanout(db, accountIds, event, notify) {
  const unique = [...new Set(accountIds)];
  for (const accountId of unique) {
    const cursor = appendEvent(db, accountId, { ...event, workspaceId: accountId === event.self ? null : event.workspaceId });
    if (cursor !== undefined) notify?.('events', accountId);
  }
}

function eventView(row) {
  return {
    cursor: Number(row.cursor),
    kind: row.kind,
    ...(row.object_id === null ? {} : { object_id: row.object_id }),
    ...(row.object_version === null ? {} : { object_version: Number(row.object_version) }),
    origin: { ...(row.origin_device === null ? {} : { device: row.origin_device }), ...(row.origin_seq === null ? {} : { seq: Number(row.origin_seq) }) },
    payload: parseJson(row.payload, {}),
    at: row.at,
  };
}

function pageLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_MAX;
}

function cursorOf(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) throw new CollabError(400, 'bad_cursor', 'since 要是不小于 0 的整数。');
  return n;
}

/**
 * 读事件。`since` 落在已删的那一段 → 410 cursor_expired;比队头还大(中转库换过)→ 410 cursor_ahead。
 * 两种都是「本地副本不可信了,重取快照」。
 */
function readEvents(db, accountId, { since, limit }) {
  const head = headOf(db, accountId, 'events');
  if (since < head.pruned) {
    throw new CollabError(410, 'cursor_expired', '离开太久了,超过了中转的保留窗(30 天);请重取频道快照。', { floor: head.pruned, head: head.last });
  }
  if (since > head.last) {
    throw new CollabError(410, 'cursor_ahead', '本地记的位置比中转还靠后(中转可能换过库);请重取频道快照。', { floor: head.pruned, head: head.last });
  }
  // 只给收件人此刻仍在册的工作室扇来的行(以及他自己的)。
  const rows = db.prepare(
    'SELECT * FROM inbox_events WHERE account_id = ? AND cursor > ?'
    + ' AND (workspace_id IS NULL OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE account_id = ? AND removed_at IS NULL))'
    + ' ORDER BY cursor ASC LIMIT ?',
  ).all(accountId, since, accountId, limit + 1);
  const more = rows.length > limit;
  const events = rows.slice(0, limit).map(eventView);
  // 没有更多时游标推到队头:被过滤掉的尾巴不能一直卡住游标、过了保留期再撞 410。
  return { events, next_cursor: more ? events[events.length - 1].cursor : head.last, more, head: head.last };
}

function requestView(row) {
  const result = parseJson(row.result, undefined);
  return {
    cursor: Number(row.cursor),
    request_id: row.request_id,
    to_account: row.account_id,
    from_account: row.from_account,
    from_device: row.from_device,
    op: row.op,
    ...(row.object_id === null ? {} : { object_id: row.object_id }),
    ...(row.expected_owner_epoch === null ? {} : { expected_owner_epoch: Number(row.expected_owner_epoch) }),
    args: parseJson(row.args, {}),
    at: row.at,
    state: row.state,
    ...(result === undefined ? {} : { result }),
    ...(row.done_at === null ? {} : { done_at: row.done_at }),
  };
}

function readRequests(db, accountId, { since, limit }) {
  const head = headOf(db, accountId, 'requests');
  if (since > head.last) {
    throw new CollabError(410, 'cursor_ahead', '本地记的位置比中转还靠后(中转可能换过库);从 0 重拉。', { head: head.last });
  }
  // 请求队列不回 410 cursor_expired:没办完的请求永不过期,删掉的只有已经办完的。
  const rows = db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?')
    .all(accountId, since, limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const queued = page.filter(row => row.state === 'queued').map(row => row.cursor);
  for (const c of queued) db.prepare("UPDATE inbox_requests SET state = 'delivered' WHERE account_id = ? AND cursor = ?").run(accountId, c);
  const requests = page.map(row => requestView(queued.includes(row.cursor) ? { ...row, state: 'delivered' } : row));
  return { requests, next_cursor: requests.length === 0 ? since : requests[requests.length - 1].cursor, more, head: head.last };
}

function checkArgs(raw) {
  const args = raw === undefined ? {} : raw;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new CollabError(400, 'bad_args', 'args 要是一个对象。');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > ARGS_MAX_BYTES) throw new CollabError(413, 'args_too_large', 'args 太大了(上限 32 KB)。');
  return args;
}

function checkRequestId(raw) {
  const id = text(raw, ID_MAX);
  if (id === undefined) throw new CollabError(400, 'bad_request_id', 'request_id 要客户端生成,1–200 个字符。');
  return id;
}

/** 对象在不在这个账号眼里。看不见的一律当不存在(不告诉人「它存在于别处」)。 */
function visibleObject(db, objectId, accountId) {
  const row = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(objectId);
  if (row === undefined) return undefined;
  if (row.owner_account === accountId) return row;
  if (!isActiveMember(db, row.workspace_id, accountId)) return undefined;
  if (row.kind === 'channel') return row;
  if (row.visibility !== 'workspace') return undefined;
  // 主人被移除了:他的对象别人不再看得见、也派不过去。
  if (row.owner_account !== null && !isActiveMember(db, row.workspace_id, row.owner_account)) return undefined;
  return row;
}

/** 插一条请求进目标账号的请求队列。同号(目标账号内)再来 → 回存着的那条,`duplicate: true`。 */
function insertRequest(db, { toAccount, requestId, fromAccount, fromDevice, op, objectId, expectedOwnerEpoch, args, now }, notify) {
  const existing = db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND request_id = ?').get(toAccount, requestId);
  if (existing !== undefined) return { request: requestView(existing), duplicate: true };
  const cursor = nextCursor(db, toAccount, 'requests');
  db.prepare(
    'INSERT INTO inbox_requests (account_id, cursor, request_id, from_account, from_device, op, object_id,'
    + ' expected_owner_epoch, args, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(toAccount, cursor, requestId, fromAccount, fromDevice, op, objectId ?? null, expectedOwnerEpoch ?? null,
    JSON.stringify(args), now.toISOString(), 'queued');
  notify?.('requests', toAccount);
  const row = db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND cursor = ?').get(toAccount, cursor);
  return { request: requestView(row), duplicate: false };
}

/**
 * 发一条请求。按对象目录路由:`to_account` 不是该对象的权威写入方 → 409 wrong_owner,并回目录里的现任。
 * 发给自己的账号(手机 → 自己的电脑)可以不带对象。
 */
function sendRequest(db, { accountId, deviceId, body, now }, notify) {
  const requestId = checkRequestId(body?.request_id);
  const op = typeof body?.op === 'string' ? body.op : '';
  if (!REQUEST_OPS.has(op)) throw new CollabError(400, 'bad_op', `op 只认 ${[...REQUEST_OPS].join(' / ')}。`);
  const toAccount = text(body?.to_account, ID_MAX);
  if (toAccount === undefined) throw new CollabError(400, 'bad_to_account', 'to_account 必填。');
  const args = checkArgs(body?.args);
  const objectId = body?.object_id === undefined || body?.object_id === null ? undefined : text(body.object_id, ID_MAX);
  if (body?.object_id !== undefined && body?.object_id !== null && objectId === undefined) throw new CollabError(400, 'bad_object_id', 'object_id 不对。');
  const epoch = body?.expected_owner_epoch;
  if (epoch !== undefined && (!Number.isInteger(epoch) || epoch < 1)) throw new CollabError(400, 'bad_epoch', 'expected_owner_epoch 要是正整数。');

  return tx(db, () => {
    // 幂等先于一切:同号重发直接回存着的(哪怕对象这会儿已经换了主人)。
    const existing = db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND request_id = ?').get(toAccount, requestId);
    if (existing !== undefined) {
      if (existing.from_account !== accountId) throw new CollabError(409, 'request_id_taken', '这个 request_id 已被别的账号用了;换一个号。');
      return { request: requestView(existing), duplicate: true };
    }

    if (objectId === undefined) {
      if (toAccount !== accountId) throw new CollabError(400, 'object_required', '发给别人的请求必须指明对象。');
      if (op === 'agent.dispatch') throw new CollabError(400, 'object_required', 'agent.dispatch 要指明是哪张 Agent 名片。');
    }
    else {
      const object = visibleObject(db, objectId, accountId);
      if (object === undefined) throw new CollabError(404, 'unknown_object', '对象目录里没有这个对象(或你看不到它)。');
      if (object.kind === 'channel') throw new CollabError(400, 'channel_via_messages', '频道由中转直接写,发消息走 /v1/channels/<id>/messages。');
      if (object.owner_account !== toAccount) {
        throw new CollabError(409, 'wrong_owner', '这个对象的权威写入方不是你发去的那个账号;按目录里的现任重发。',
          { owner_account: object.owner_account, owner_epoch: Number(object.owner_epoch) });
      }
      if (epoch !== undefined && epoch !== Number(object.owner_epoch)) {
        throw new CollabError(409, 'stale_owner_epoch', '对象已经交接过了;按目录里的现任重发。',
          { owner_account: object.owner_account, owner_epoch: Number(object.owner_epoch) });
      }
      if (op === 'agent.dispatch') checkAgentShared(object, accountId);
    }
    return insertRequest(db, { toAccount, requestId, fromAccount: accountId, fromDevice: deviceId, op, objectId, expectedOwnerEpoch: epoch, args, now }, notify);
  });
}

/** 名片的 `shared` 在中转核:不共享 → 只有主人能用;`allowed_members` 非空 → 只有名单上的成员能用。 */
function checkAgentShared(object, accountId) {
  if (object.kind !== 'agent') throw new CollabError(400, 'not_an_agent', 'agent.dispatch 只能发给 Agent 名片。');
  if (object.owner_account === accountId) return;
  const shared = parseJson(object.data, {})?.shared ?? {};
  if (shared.to !== 'workspace') throw new CollabError(403, 'agent_not_shared', '这张名片的主人没有把它共享给工作室。');
  if (Array.isArray(shared.allowed_members) && shared.allowed_members.length > 0 && !shared.allowed_members.includes(accountId)) {
    throw new CollabError(403, 'agent_not_shared', '这张名片的主人只让名单上的成员用它。');
  }
}

/** 权威写入方回结果。写进请求表,并往发起者的事件队列放一条 request.result。同一条再回一次 → 不改、回存着的。 */
function finishRequest(db, { accountId, body, now }, notify, hooks = {}) {
  const requestId = checkRequestId(body?.request_id);
  const state = body?.state;
  if (state !== 'done' && state !== 'rejected') throw new CollabError(400, 'bad_state', 'state 只有 done / rejected。');
  const result = body?.result === undefined ? {} : body.result;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > ARGS_MAX_BYTES) throw new CollabError(413, 'result_too_large', 'result 太大了(上限 32 KB)。');
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND request_id = ?').get(accountId, requestId);
    if (row === undefined) throw new CollabError(404, 'unknown_request', '你的请求队列里没有这一条。');
    if (row.state === 'done' || row.state === 'rejected') return { request: requestView(row), duplicate: true };
    const at = now.toISOString();
    db.prepare('UPDATE inbox_requests SET state = ?, result = ?, done_at = ? WHERE account_id = ? AND request_id = ?')
      .run(state, JSON.stringify(result), at, accountId, requestId);
    const done = requestView(db.prepare('SELECT * FROM inbox_requests WHERE account_id = ? AND request_id = ?').get(accountId, requestId));
    // webhook / 企微投来的请求,发起者就是主人自己;结果照样回到他的事件队列(三端看得到)。
    const object = row.object_id === null ? undefined : db.prepare('SELECT workspace_id FROM objects WHERE object_id = ?').get(row.object_id);
    appendEvent(db, row.from_account, {
      kind: 'request.result', objectId: row.object_id, now,
      // 问的是自己账号的东西 → NULL;问的是别人的对象 → 凭那个对象的工作室(移出后读不回)。
      workspaceId: row.from_account === accountId || object === undefined ? null : object.workspace_id,
      payload: { request_id: requestId, to_account: accountId, op: row.op, object_id: row.object_id ?? undefined, state, result },
    });
    notify?.('events', row.from_account);
    hooks.onFinished?.(done);
    return { request: done, duplicate: false };
  });
}

// ───────────────────────── 对象目录 ─────────────────────────

function isOnline(db, ownerAccount, ownerDevice, now) {
  if (ownerAccount === null || ownerDevice === null) return false;
  const row = db.prepare('SELECT last_seen_at FROM tokens WHERE account = ? AND device_id = ? AND revoked_at IS NULL')
    .get(`acct:${ownerAccount}`, ownerDevice);
  if (row === undefined || row.last_seen_at === null) return false;
  return now.getTime() - Date.parse(row.last_seen_at) <= ONLINE_WINDOW_MS;
}

function objectView(row, { db, now } = {}) {
  const data = parseJson(row.data, undefined);
  return {
    object_id: row.object_id,
    kind: row.kind,
    workspace_id: row.workspace_id,
    owner_account: row.owner_account,
    owner_device: row.owner_device,
    owner_epoch: Number(row.owner_epoch),
    version: Number(row.version),
    visibility: row.visibility,
    title: row.title,
    ...(data === undefined ? {} : { data }),
    updated_at: row.updated_at,
    ...(db === undefined ? {} : { owner_online: isOnline(db, row.owner_account, row.owner_device, now) }),
  };
}

function checkData(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new CollabError(400, 'bad_data', 'data 要是一个对象。');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > ARGS_MAX_BYTES) throw new CollabError(413, 'data_too_large', 'data 太大了(上限 32 KB)。');
  return raw;
}

/**
 * 登记 / 更新一个对象(卡、项目、目标、Agent 名片)。权威写入方 = 登记它的那台设备所在账号。
 * 别人名下已有同号对象 → 409 wrong_owner。扇出一条 object.event(change: 'upsert');
 * 从 workspace 收回成 owner → 别人那里收到 change: 'withdrawn'(不带标题与正文),项目频道归档只读。
 */
function upsertObject(db, { accountId, deviceId, body, now }, notify) {
  const objectId = text(body?.object_id, ID_MAX);
  if (objectId === undefined) throw new CollabError(400, 'bad_object_id', 'object_id 必填(<设备前缀>:<本机 id>)。');
  const kind = body?.kind;
  if (!OBJECT_KINDS.has(kind)) throw new CollabError(400, 'bad_kind', `kind 只认 ${[...OBJECT_KINDS].join(' / ')}(频道由中转建)。`);
  const title = text(body?.title, TITLE_MAX);
  if (title === undefined) throw new CollabError(400, 'bad_title', `title 要 1–${TITLE_MAX} 个字。`);
  const visibility = body?.visibility ?? 'workspace';
  if (!VISIBILITIES.has(visibility)) throw new CollabError(400, 'bad_visibility', 'visibility 只有 workspace / owner。');
  const data = checkData(body?.data);
  const version = body?.version;
  if (version !== undefined && (!Number.isInteger(version) || version < 0)) throw new CollabError(400, 'bad_version', 'version 要是非负整数。');
  const originSeq = body?.origin_seq;
  if (originSeq !== undefined && (!Number.isInteger(originSeq) || originSeq < 0)) throw new CollabError(400, 'bad_origin_seq', 'origin_seq 要是非负整数。');
  const m = requireMembership(db, accountId);

  return tx(db, () => {
    const at = now.toISOString();
    const existing = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(objectId);
    if (existing !== undefined && existing.owner_account !== accountId) {
      throw new CollabError(409, 'wrong_owner', '这个对象登记在别人名下。', { owner_account: existing.owner_account, owner_epoch: Number(existing.owner_epoch) });
    }
    if (existing !== undefined && existing.kind !== kind) throw new CollabError(409, 'kind_mismatch', '同一个对象换不了种类。');
    if (existing === undefined) {
      db.prepare(
        'INSERT INTO objects (object_id, kind, workspace_id, owner_account, owner_device, owner_epoch, version, visibility, title, data, created_at, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
      ).run(objectId, kind, m.workspace_id, accountId, deviceId, version ?? 0, visibility, title,
        data === undefined ? null : JSON.stringify(data), at, at);
    }
    else {
      db.prepare('UPDATE objects SET owner_device = ?, version = MAX(version, ?), visibility = ?, title = ?, data = COALESCE(?, data), updated_at = ? WHERE object_id = ?')
        .run(deviceId, version ?? Number(existing.version), visibility, title, data === undefined ? null : JSON.stringify(data), at, objectId);
    }
    const row = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(objectId);
    const view = objectView(row);
    const base = { kind: 'object.event', workspaceId: row.workspace_id, self: accountId, objectId, objectVersion: view.version, originDevice: deviceId, originSeq, now };
    if (visibility === 'workspace') {
      fanout(db, [accountId, ...activeMemberIds(db, row.workspace_id)], { ...base, payload: { change: 'upsert', object: view } }, notify);
    }
    else {
      fanout(db, [accountId], { ...base, payload: { change: 'upsert', object: view } }, notify);
      if (existing !== undefined && existing.visibility === 'workspace') {
        const others = activeMemberIds(db, row.workspace_id).filter(id => id !== accountId);
        fanout(db, others, { ...base, originSeq: undefined, payload: { change: 'withdrawn', object: { object_id: objectId, kind } } }, notify);
        if (kind === 'project') archiveProjectChannel(db, objectId, accountId, now, notify);
      }
    }
    return { object: objectView(row, { db, now }), created: existing === undefined };
  });
}

/** 主人推一条对象事件(卡变了状态、回执到了……)。按可见性扇出;origin{device, seq} 去重,重发不占新号。 */
function pushObjectEvent(db, { accountId, deviceId, objectId, body, now }, notify) {
  const originSeq = body?.origin_seq;
  if (!Number.isInteger(originSeq) || originSeq < 0) throw new CollabError(400, 'bad_origin_seq', 'origin_seq 必填(发出方本机 seq,用来去重)。');
  const objectVersion = body?.object_version;
  if (objectVersion !== undefined && (!Number.isInteger(objectVersion) || objectVersion < 0)) throw new CollabError(400, 'bad_version', 'object_version 要是非负整数。');
  const payload = checkData(body?.payload) ?? {};
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(objectId);
    if (row === undefined) throw new CollabError(404, 'unknown_object', '对象目录里没有这个对象;先登记(POST /v1/objects)。');
    if (row.kind === 'channel') throw new CollabError(400, 'channel_via_messages', '频道由中转直接写,发消息走 /v1/channels/<id>/messages。');
    if (row.owner_account !== accountId) {
      throw new CollabError(409, 'wrong_owner', '只有权威写入方能推这个对象的事件。', { owner_account: row.owner_account, owner_epoch: Number(row.owner_epoch) });
    }
    const seen = db.prepare('SELECT cursor FROM inbox_events WHERE account_id = ? AND origin_device = ? AND origin_seq = ?').get(accountId, deviceId, originSeq);
    if (seen !== undefined) return { duplicate: true, cursor: Number(seen.cursor) };
    if (objectVersion !== undefined && objectVersion > Number(row.version)) {
      db.prepare('UPDATE objects SET version = ?, updated_at = ? WHERE object_id = ?').run(objectVersion, now.toISOString(), objectId);
    }
    const version = objectVersion ?? Number(row.version);
    const targets = row.visibility === 'workspace' ? [accountId, ...activeMemberIds(db, row.workspace_id)] : [accountId];
    fanout(db, targets, { kind: 'object.event', workspaceId: row.workspace_id, self: accountId, objectId, objectVersion: version, originDevice: deviceId, originSeq, now, payload: { change: 'event', event: payload } }, notify);
    const own = db.prepare('SELECT cursor FROM inbox_events WHERE account_id = ? AND origin_device = ? AND origin_seq = ?').get(accountId, deviceId, originSeq);
    return { duplicate: false, cursor: Number(own.cursor) };
  });
}

/** 查一个对象(`GET /v1/objects?id=`)。看不见一律 404,不回主人。 */
function getObject(db, accountId, objectId, now) {
  const row = typeof objectId === 'string' ? visibleObject(db, objectId, accountId) : undefined;
  if (row === undefined) throw new CollabError(404, 'unknown_object', '对象目录里没有这个对象(或你看不到它)。');
  return objectView(row, { db, now });
}

/**
 * 交接:现任把对象交给工作室里另一台电脑。owner_epoch +1。
 * 换了账号 → 旧主人名下还没办的、针对这个对象的请求当场 rejected(`owner_changed` + 现任),
 * 以 request.result 回给发起者,由发起者按目录重投;同账号换电脑 → 请求按账号投,不用动。
 */
function transferObject(db, { accountId, deviceId, body, now }, notify) {
  const objectId = text(body?.object_id, ID_MAX);
  const toAccount = text(body?.to_account, ID_MAX);
  const toDevice = text(body?.to_device, ID_MAX);
  const epoch = body?.expected_owner_epoch;
  if (objectId === undefined || toAccount === undefined || toDevice === undefined) {
    throw new CollabError(400, 'bad_transfer', 'object_id、to_account、to_device 都要填。');
  }
  if (!Number.isInteger(epoch) || epoch < 1) throw new CollabError(400, 'bad_epoch', 'expected_owner_epoch 必填(正整数)。');
  return tx(db, () => {
    const row = visibleObject(db, objectId, accountId);
    if (row === undefined) throw new CollabError(404, 'unknown_object', '对象目录里没有这个对象(或你看不到它)。');
    if (row.kind === 'channel') throw new CollabError(400, 'channel_via_messages', '频道由中转做权威写入方,不能交接。');
    if (row.owner_account !== accountId || row.owner_device !== deviceId) {
      throw new CollabError(409, 'wrong_owner', '只有现任那台电脑能交接。', { owner_account: row.owner_account, owner_epoch: Number(row.owner_epoch) });
    }
    if (epoch !== Number(row.owner_epoch)) {
      throw new CollabError(409, 'stale_owner_epoch', '对象已经交接过了。', { owner_account: row.owner_account, owner_epoch: Number(row.owner_epoch) });
    }
    if (!isActiveMember(db, row.workspace_id, toAccount)) throw new CollabError(400, 'invalid_transfer_target', '接手的人不在这个工作室里。');
    const target = db.prepare('SELECT device_kind FROM tokens WHERE account = ? AND device_id = ? AND revoked_at IS NULL').get(`acct:${toAccount}`, toDevice);
    if (target === undefined || (target.device_kind !== null && !DESK_KINDS.has(target.device_kind))) {
      throw new CollabError(400, 'invalid_transfer_target', '接手的必须是对方的一台电脑(座机服务)。');
    }
    const at = now.toISOString();
    db.prepare('UPDATE objects SET owner_account = ?, owner_device = ?, owner_epoch = owner_epoch + 1, updated_at = ? WHERE object_id = ?')
      .run(toAccount, toDevice, at, objectId);
    const moved = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(objectId);
    const view = objectView(moved);
    if (toAccount !== accountId) {
      const pending = db.prepare("SELECT * FROM inbox_requests WHERE account_id = ? AND object_id = ? AND state IN ('queued', 'delivered')").all(accountId, objectId);
      for (const req of pending) {
        const result = { code: 'owner_changed', owner_account: toAccount, owner_epoch: view.owner_epoch };
        db.prepare("UPDATE inbox_requests SET state = 'rejected', result = ?, done_at = ? WHERE account_id = ? AND cursor = ?")
          .run(JSON.stringify(result), at, accountId, req.cursor);
        appendEvent(db, req.from_account, {
          kind: 'request.result', objectId, now, workspaceId: req.from_account === accountId ? null : row.workspace_id,
          payload: { request_id: req.request_id, to_account: accountId, op: req.op, object_id: objectId, state: 'rejected', result },
        });
        notify?.('events', req.from_account);
      }
    }
    const targets = row.visibility === 'workspace' ? [accountId, toAccount, ...activeMemberIds(db, row.workspace_id)] : [accountId, toAccount];
    fanout(db, targets, { kind: 'object.event', workspaceId: row.workspace_id, objectId, objectVersion: view.version, now, payload: { change: 'owner_changed', object: view } }, notify);
    return { object: objectView(moved, { db, now }) };
  });
}

/** 记这台设备读到哪(只进不退、封顶队头、不删任何一行)。 */
function ackInbox(db, { accountId, deviceId, body, now }) {
  const queue = body?.queue;
  if (queue !== 'events' && queue !== 'requests') throw new CollabError(400, 'bad_queue', "queue 只有 'events' / 'requests'。");
  const value = body?.last_acked;
  if (!Number.isInteger(value) || value < 0) throw new CollabError(400, 'bad_cursor', 'last_acked 要是非负整数。');
  const head = headOf(db, accountId, queue);
  const capped = Math.min(value, head.last);
  db.prepare(
    'INSERT INTO inbox_acks (account_id, device_id, queue, last_acked, updated_at) VALUES (?, ?, ?, ?, ?)'
    + ' ON CONFLICT (account_id, device_id, queue) DO UPDATE SET last_acked = MAX(last_acked, excluded.last_acked), updated_at = excluded.updated_at',
  ).run(accountId, deviceId, queue, capped, now.toISOString());
  const row = db.prepare('SELECT last_acked FROM inbox_acks WHERE account_id = ? AND device_id = ? AND queue = ?').get(accountId, deviceId, queue);
  return { queue, last_acked: Number(row.last_acked) };
}

function ackedOf(db, accountId, deviceId, queue) {
  const row = db.prepare('SELECT last_acked FROM inbox_acks WHERE account_id = ? AND device_id = ? AND queue = ?').get(accountId, deviceId, queue);
  return Number(row?.last_acked ?? 0);
}

function listObjects(db, accountId, { kind, now }) {
  const m = activeMembership(db, accountId);
  if (m === undefined) return [];
  const rows = db.prepare(
    "SELECT * FROM objects WHERE workspace_id = ? AND kind <> 'channel' AND (? IS NULL OR kind = ?) ORDER BY created_at ASC, rowid ASC",
  ).all(m.workspace_id, kind ?? null, kind ?? null);
  return rows.filter(row => visibleObject(db, row.object_id, accountId) !== undefined).map(row => objectView(row, { db, now }));
}

// ───────────────────────── 频道 ─────────────────────────

function createChannelRow(db, { workspaceId, kind, name, createdBy, projectObjectId, now }) {
  const id = `${workspaceId}/ch:${newId()}`;
  const at = now.toISOString();
  db.prepare(
    'INSERT INTO channels (id, kind, workspace_id, project_object_id, name, created_by, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(id, kind, workspaceId, projectObjectId ?? null, name, createdBy, at);
  // 频道也进对象目录:权威写入方 = 中转(owner 为空),owner_epoch 固定 1。
  db.prepare(
    'INSERT INTO objects (object_id, kind, workspace_id, owner_account, owner_device, owner_epoch, version, visibility, title, created_at, updated_at)'
    + " VALUES (?, 'channel', ?, NULL, NULL, 1, 0, 'workspace', ?, ?, ?)",
  ).run(id, workspaceId, name, at, at);
  return channelView(db, db.prepare('SELECT * FROM channels WHERE id = ?').get(id));
}

function channelView(db, row) {
  let project;
  if (row.project_object_id !== null) {
    const obj = db.prepare('SELECT object_id, owner_account, title FROM objects WHERE object_id = ?').get(row.project_object_id);
    if (obj !== undefined) project = { object_id: obj.object_id, owner_account: obj.owner_account, name: obj.title };
  }
  return {
    id: row.id,
    kind: row.kind,
    workspace_id: row.workspace_id,
    name: project?.name ?? row.name,
    ...(project === undefined ? {} : { project }),
    created_by: row.created_by,
    created_at: row.created_at,
    ...(row.archived_at === null ? {} : { archived_at: row.archived_at }),
    version: Number(row.version),
  };
}

function workspaceChannelId(db, workspaceId) {
  return db.prepare("SELECT id FROM channels WHERE workspace_id = ? AND kind = 'workspace'").get(workspaceId)?.id;
}

function listChannels(db, accountId) {
  const m = activeMembership(db, accountId);
  if (m === undefined) return [];
  return db.prepare("SELECT * FROM channels WHERE workspace_id = ? ORDER BY CASE kind WHEN 'workspace' THEN 0 ELSE 1 END, created_at ASC, rowid ASC")
    .all(m.workspace_id).map(row => channelView(db, row));
}

function channelFor(db, channelId, accountId) {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (row === undefined || !isActiveMember(db, row.workspace_id, accountId)) {
    throw new CollabError(404, 'unknown_channel', '没有这个频道(或你不在它的工作室里)。');
  }
  return row;
}

/** 项目频道:项目主人「分享到工作室」时建,一个项目一条;再来一次回已有的那条。 */
function createProjectChannel(db, { accountId, body, now }, notify) {
  const projectId = text(body?.project_object_id, ID_MAX);
  if (projectId === undefined) throw new CollabError(400, 'bad_object_id', 'project_object_id 必填。');
  return tx(db, () => {
    const project = db.prepare('SELECT * FROM objects WHERE object_id = ?').get(projectId);
    if (project === undefined || project.kind !== 'project') throw new CollabError(404, 'unknown_object', '对象目录里没有这个项目;先登记(POST /v1/objects)。');
    if (project.owner_account !== accountId) throw new CollabError(409, 'wrong_owner', '只有项目主人能为它建频道。', { owner_account: project.owner_account, owner_epoch: Number(project.owner_epoch) });
    if (project.visibility !== 'workspace') throw new CollabError(409, 'project_private', '项目还没分享到工作室(visibility 是 owner)。');
    requireMembership(db, accountId);
    const existing = db.prepare('SELECT * FROM channels WHERE project_object_id = ?').get(projectId);
    if (existing !== undefined) {
      if (existing.archived_at !== null) db.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(existing.id);
      return { channel: channelView(db, db.prepare('SELECT * FROM channels WHERE id = ?').get(existing.id)), created: false };
    }
    const channel = createChannelRow(db, { workspaceId: project.workspace_id, kind: 'project', name: project.title, createdBy: accountId, projectObjectId: projectId, now });
    fanout(db, activeMemberIds(db, project.workspace_id), { kind: 'channel.created', workspaceId: project.workspace_id, objectId: channel.id, objectVersion: 0, now, payload: channel }, notify);
    return { channel, created: true };
  });
}

function archiveProjectChannel(db, projectObjectId, accountId, now, notify) {
  const row = db.prepare('SELECT * FROM channels WHERE project_object_id = ? AND archived_at IS NULL').get(projectObjectId);
  if (row === undefined) return;
  db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  const channel = channelView(db, db.prepare('SELECT * FROM channels WHERE id = ?').get(row.id));
  fanout(db, activeMemberIds(db, row.workspace_id), { kind: 'channel.created', workspaceId: row.workspace_id, objectId: row.id, objectVersion: channel.version, now, payload: channel }, notify);
}

function archiveChannel(db, { accountId, channelId, now }, notify) {
  return tx(db, () => {
    const row = channelFor(db, channelId, accountId);
    if (row.kind === 'workspace') throw new CollabError(409, 'workspace_channel', '工作室频道不能归档。');
    const owner = db.prepare('SELECT owner_account FROM objects WHERE object_id = ?').get(row.project_object_id)?.owner_account;
    const m = requireMembership(db, accountId);
    if (owner !== accountId && m.role !== 'admin') throw new CollabError(403, 'not_admin', '只有项目主人或管理员能归档项目频道。');
    archiveProjectChannel(db, row.project_object_id, accountId, now, notify);
    return { channel: channelView(db, db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId)) };
  });
}

function messageView(row) {
  const retracted = row.retracted_by !== null;
  const link = parseJson(row.link, undefined);
  return {
    id: row.id,
    channel: row.channel_id,
    seq: Number(row.seq),
    kind: row.kind,
    author: {
      person: row.author_account,
      nick: row.author_nick,
      device: row.author_device,
      ...(row.butler === 1 ? { butler: true } : {}),
    },
    ...(row.via === null ? {} : { via: row.via }),
    text: retracted ? '' : row.text,
    refs: retracted ? [] : parseJson(row.refs, []),
    attachments: retracted ? [] : parseJson(row.attachments, []),
    ...(row.reply_to === null ? {} : { reply_to: row.reply_to }),
    ...(link === undefined || retracted ? {} : { link }),
    ...(row.retract_of === null ? {} : { retract_of: row.retract_of }),
    ...(retracted ? { retracted: { by: row.retracted_by, at: row.retracted_at } } : {}),
    request_id: row.request_id,
    at: row.at,
    origin: { device: row.author_device, ...(row.origin_seq === null ? {} : { seq: Number(row.origin_seq) }) },
  };
}

function checkRefs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > REFS_MAX) throw new CollabError(400, 'bad_refs', `refs 要是数组,最多 ${REFS_MAX} 条。`);
  return raw.map((ref) => {
    const objectId = text(ref?.object_id, ID_MAX);
    if (objectId === undefined) throw new CollabError(400, 'bad_refs', 'refs 里每一条都要有 object_id。');
    return {
      object_id: objectId,
      kind: text(ref?.kind, 32) ?? 'card',
      ...(Number.isInteger(ref?.object_version) ? { object_version: ref.object_version } : {}),
      ...(text(ref?.owner_account, ID_MAX) === undefined ? {} : { owner_account: text(ref.owner_account, ID_MAX) }),
      ...(text(ref?.title, TITLE_MAX) === undefined ? {} : { title: text(ref.title, TITLE_MAX) }),
    };
  });
}

/** 附件只存取件单引用:单号、名字、大小、种类、开单设备。字节不过中转,别的格子一律丢掉。 */
function checkAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_MAX) throw new CollabError(400, 'bad_attachments', `attachments 要是数组,最多 ${ATTACHMENTS_MAX} 个。`);
  return raw.map((a) => {
    const offer = text(a?.offer, ID_MAX);
    const name = text(a?.name, 255);
    if (offer === undefined || name === undefined) throw new CollabError(400, 'bad_attachments', '附件只收取件单引用:offer 与 name 必填。');
    return {
      offer,
      name,
      bytes: Number.isInteger(a?.bytes) && a.bytes >= 0 ? a.bytes : 0,
      ...(text(a?.kind, 32) === undefined ? {} : { kind: text(a.kind, 32) }),
      ...(text(a?.owner_device, ID_MAX) === undefined ? {} : { owner_device: text(a.owner_device, ID_MAX) }),
    };
  });
}

function checkLink(raw) {
  if (raw === undefined || raw === null) return undefined;
  const kind = text(raw?.kind, 32);
  const id = text(raw?.id, ID_MAX);
  if (kind === undefined || id === undefined) throw new CollabError(400, 'bad_link', 'link 要有 kind 与 id。');
  return { kind, id, ...(text(raw?.owner_account, ID_MAX) === undefined ? {} : { owner_account: text(raw.owner_account, ID_MAX) }) };
}

/**
 * 追加一条消息:分配 seq(= 频道 version +1)、落库、往每个成员的事件队列各放一条 channel.message(发件人自己也放)。
 * 同频道同 request_id 再来 → 回存着的那条,不出第二条。
 */
function appendMessage(db, { channel, author, kind, textBody, refs, attachments, replyTo, link, requestId, originSeq, retractOf, via, now }, notify) {
  const dup = db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND request_id = ?').get(channel.id, requestId);
  if (dup !== undefined) return { message: messageView(dup), duplicate: true };
  db.prepare('UPDATE channels SET version = version + 1 WHERE id = ?').run(channel.id);
  const seq = Number(db.prepare('SELECT version FROM channels WHERE id = ?').get(channel.id).version);
  db.prepare('UPDATE objects SET version = ?, updated_at = ? WHERE object_id = ?').run(seq, now.toISOString(), channel.id);
  const id = newId();
  db.prepare(
    'INSERT INTO channel_messages (channel_id, seq, id, kind, author_account, author_nick, author_device, butler, via, text, refs, attachments,'
    + ' reply_to, link, retract_of, request_id, origin_seq, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(channel.id, seq, id, kind, author.person, author.nick, author.device, author.butler ? 1 : 0, via ?? null, textBody,
    JSON.stringify(refs ?? []), JSON.stringify(attachments ?? []), replyTo ?? null, link === undefined ? null : JSON.stringify(link),
    retractOf ?? null, requestId, originSeq ?? null, now.toISOString());
  if (retractOf !== undefined) {
    db.prepare('UPDATE channel_messages SET retracted_by = ?, retracted_at = ? WHERE id = ?').run(id, now.toISOString(), retractOf);
  }
  const message = messageView(db.prepare('SELECT * FROM channel_messages WHERE id = ?').get(id));
  // 事件里不带 origin_seq:频道消息靠 request_id 去重,免得与同一台设备的对象事件撞号。
  fanout(db, activeMemberIds(db, channel.workspace_id), {
    kind: 'channel.message', workspaceId: channel.workspace_id, objectId: channel.id, objectVersion: seq, originDevice: author.device, now, payload: message,
  }, notify);
  return { message, duplicate: false };
}

function systemNote(db, channelId, accountId, line, now, notify) {
  if (channelId === undefined) return undefined;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (channel === undefined) return undefined;
  return appendMessage(db, {
    channel, author: { person: accountId, nick: '工作室', device: 'relay' }, kind: 'system', textBody: line,
    requestId: `sys:${newId()}`, now,
  }, notify);
}

function postMessage(db, { accountId, deviceId, deviceKind, channelId, body, now }, notify) {
  const requestId = checkRequestId(body?.request_id);
  const kind = body?.kind ?? 'say';
  if (!MESSAGE_KINDS.has(kind)) throw new CollabError(400, 'bad_kind', `kind 只认 ${[...MESSAGE_KINDS].join(' / ')}。`);
  const refs = checkRefs(body?.refs);
  const attachments = checkAttachments(body?.attachments);
  const raw = typeof body?.text === 'string' ? body.text.trim() : '';
  if (raw.length > TEXT_MAX) throw new CollabError(413, 'text_too_long', `一条消息最多 ${TEXT_MAX} 字。`);
  if (raw === '' && attachments.length === 0) throw new CollabError(400, 'empty_message', '消息不能是空的。');
  const link = checkLink(body?.link);
  const originSeq = Number.isInteger(body?.origin_seq) && body.origin_seq >= 0 ? body.origin_seq : undefined;
  return tx(db, () => {
    const channel = channelFor(db, channelId, accountId);
    const dup = db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND request_id = ?').get(channel.id, requestId);
    if (dup !== undefined) return { message: messageView(dup), duplicate: true };
    if (channel.archived_at !== null) throw new CollabError(409, 'channel_archived', '这个频道已归档,只读。');
    const replyTo = body?.reply_to === undefined || body?.reply_to === null ? undefined : text(body.reply_to, ID_MAX);
    if (replyTo !== undefined && db.prepare('SELECT 1 FROM channel_messages WHERE channel_id = ? AND id = ?').get(channel.id, replyTo) === undefined) {
      throw new CollabError(400, 'bad_reply_to', 'reply_to 指的消息不在这个频道里。');
    }
    const m = memberOf(db, channel.workspace_id, accountId);
    // 事务官署在主人名下(待拍板 5);只有电脑那一类设备发的才能标 butler。
    const butler = body?.butler === true && (deviceKind === null || DESK_KINDS.has(deviceKind));
    return appendMessage(db, {
      channel, author: { person: accountId, nick: m.nick, device: deviceId, butler }, kind, textBody: raw, refs, attachments,
      replyTo, link, requestId, originSeq, now,
    }, notify);
  });
}

/** 撤回 = 一条 system 消息引用原消息;原行不删,快照里折成「已撤回」。只有作者账号能撤。 */
function retractMessage(db, { accountId, deviceId, channelId, messageId, body, now }, notify) {
  const requestId = checkRequestId(body?.request_id);
  return tx(db, () => {
    const channel = channelFor(db, channelId, accountId);
    const dup = db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND request_id = ?').get(channel.id, requestId);
    if (dup !== undefined) return { message: messageView(dup), duplicate: true };
    const original = db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?').get(channel.id, messageId);
    if (original === undefined) throw new CollabError(404, 'unknown_message', '这个频道里没有这条消息。');
    if (original.author_account !== accountId) throw new CollabError(403, 'not_author', '只能撤回自己发的消息。');
    if (original.retracted_by !== null) throw new CollabError(409, 'already_retracted', '这条已经撤回了。');
    const m = memberOf(db, channel.workspace_id, accountId);
    return appendMessage(db, {
      channel, author: { person: accountId, nick: m.nick, device: deviceId }, kind: 'system', textBody: `${m.nick} 撤回了一条消息`,
      requestId, retractOf: messageId, now,
    }, notify);
  });
}

/** 频道快照:`before` 之前(不含)最多 limit 条,按 seq 升序;带上调用者此刻的事件游标,快照之后从它续。 */
function channelSnapshot(db, { accountId, channelId, before, limit }) {
  const channel = channelFor(db, channelId, accountId);
  const upper = before === undefined ? Number(channel.version) + 1 : before;
  const rows = db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(channel.id, upper, limit).reverse();
  return { channel: channelView(db, channel), messages: rows.map(messageView), cursor: headOf(db, accountId, 'events').last };
}

// ───────────────────────── 保留期 ─────────────────────────

/** 删过期的:事件 30 天、已办完的请求 7 天;未办完的请求不过期(待拍板 2)。频道消息本体跟事件同一个窗。 */
function pruneCollab(db, now, { eventMs = EVENT_RETENTION_MS, doneRequestMs = DONE_REQUEST_RETENTION_MS } = {}) {
  const eventCut = new Date(now.getTime() - eventMs).toISOString();
  const doneCut = new Date(now.getTime() - doneRequestMs).toISOString();
  return tx(db, () => {
    const marks = db.prepare('SELECT account_id, MAX(cursor) AS top FROM inbox_events WHERE at < ? GROUP BY account_id').all(eventCut);
    for (const { account_id: accountId, top } of marks) {
      db.prepare('INSERT OR IGNORE INTO inbox_heads (account_id, queue) VALUES (?, ?)').run(accountId, 'events');
      db.prepare('UPDATE inbox_heads SET pruned_through = MAX(pruned_through, ?) WHERE account_id = ? AND queue = ?').run(top, accountId, 'events');
      // 按游标删(不只按时刻):保证删掉的是连续的一段,410 的判据才成立。
      db.prepare('DELETE FROM inbox_events WHERE account_id = ? AND cursor <= ?').run(accountId, top);
    }
    const msgs = db.prepare('DELETE FROM channel_messages WHERE at < ?').run(eventCut);
    const reqs = db.prepare("DELETE FROM inbox_requests WHERE state IN ('done', 'rejected') AND done_at < ?").run(doneCut);
    db.prepare('DELETE FROM wecom_receipts WHERE created_at < ?').run(doneCut);
    return { event_queues: marks.length, messages: Number(msgs.changes ?? 0), requests: Number(reqs.changes ?? 0) };
  });
}

function memberEvent(db, workspaceId, payload, now, notify) {
  const ids = activeMemberIds(db, workspaceId);
  fanout(db, ids, { kind: 'workspace.member', workspaceId, objectId: workspaceId, now, payload }, notify);
}

module.exports = {
  COLLAB_SCHEMA,
  CollabError,
  CODE_ALPHABET,
  DESK_KINDS,
  REQUEST_OPS,
  SERVER_OPS,
  INVITE_TTL_MS,
  EVENT_RETENTION_MS,
  DONE_REQUEST_RETENTION_MS,
  LONG_POLL_MAX_S,
  PAGE_MAX,
  TEXT_MAX,
  ONLINE_WINDOW_MS,
  newId,
  newCode,
  tx,
  pageLimit,
  cursorOf,
  activeMembership,
  isActiveMember,
  activeMemberIds,
  memberOf,
  createWorkspace,
  createInvite,
  joinWorkspace,
  setMemberRole,
  removeMember,
  workspaceMe,
  appendEvent,
  readEvents,
  readRequests,
  insertRequest,
  sendRequest,
  finishRequest,
  visibleObject,
  upsertObject,
  pushObjectEvent,
  listObjects,
  getObject,
  transferObject,
  ackInbox,
  ackedOf,
  objectView,
  listChannels,
  channelFor,
  channelView,
  createProjectChannel,
  archiveChannel,
  postMessage,
  appendMessage,
  retractMessage,
  channelSnapshot,
  pruneCollab,
};
