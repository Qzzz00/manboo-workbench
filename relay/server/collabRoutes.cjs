'use strict';

// 协作区跨机底座的 HTTP 面(2026-10-21)。全部在 /v1/ 下,Caddy 不用改。规则与库在 collab.cjs。
//
//   POST /v1/workspace                       建工作室(会话令牌),创建者为 admin,顺手建工作室频道
//   POST /v1/workspace/invite                发邀请码(会话令牌 + admin;8 位、24 小时、一次性)
//   POST /v1/workspace/join                  用邀请码加入(会话令牌)
//   GET  /v1/workspace/me                    我在哪个工作室、成员、设备最后在线、频道(设备令牌或会话令牌)
//   POST /v1/workspace/members/role|remove   改角色 / 移除(会话令牌 + admin;移除自己 = 退出)
//   GET  /v1/inbox/events?since=&wait=       事件下行(设备令牌;长轮询最多 25 秒;过保留窗 410)
//   GET  /v1/inbox/requests?since=&wait=     请求上行,只有本账号的电脑能拉
//   POST /v1/inbox/requests                  发请求;按对象目录路由,不是主人 409 wrong_owner
//   POST /v1/inbox/requests/result           权威写入方回结果 → 发起者事件队列一条 request.result
//   POST /v1/inbox/ack                       记这台设备读到哪(不删行;GET 不带 since 时从这里续)
//   GET  /v1/objects?kind= | ?id=            对象目录里我看得见的 / 查一个
//   POST /v1/objects                         登记 / 更新(卡、项目、目标、Agent 名片;只认电脑)
//   POST /v1/objects/<id>/events             主人推一条对象事件(origin_seq 去重;只认电脑)
//   POST /v1/objects/transfer                交接(现任那台电脑;owner_epoch +1)
//   GET  /v1/channels                        频道清单
//   POST /v1/channels                        建项目频道(项目主人)
//   POST /v1/channels/<id>/archive           归档项目频道(项目主人或管理员)
//   POST /v1/channels/<id>/messages          发消息(request_id 幂等)
//   POST /v1/channels/<id>/messages/<mid>/retract  撤回(不删原行)
//   GET  /v1/channels/<id>/messages?before=  快照
//   GET|POST /v1/webhooks, /v1/webhooks/<id>/rotate|revoke   定时派活的回调地址(电脑)
//   POST /v1/hooks/<密钥>                    外面打进来 → 一条 timer.fire 请求进主人的请求队列(开放、按地址限频)
//   GET|POST /v1/wecom/callback              企业微信机器人回调(验签;密钥只从环境变量读)
//   GET|POST /v1/wecom/bindings, /v1/wecom/bindings/remove   群与频道的绑定
//
// 2026-10-21 合并:卡 C(studio.cjs / studioRoutes.cjs)与本文件重复的路与表已退役,它独有的
// ack、交接、查一个对象、邀请码只存哈希、移出后积压读不回、保留期可配都并进了这里与 collab.cjs。
//
// 门的口径(频道设计稿 1.1):看、发、拉用设备令牌;改成员关系用账号会话令牌。
// 设备令牌必须记在服务器账号名下(`acct:`);还没迁过来的老令牌进不了工作室。

const crypto = require('node:crypto');
const express = require('express');

const collab = require('./collab.cjs');
const { CollabError } = collab;
const { accountIdOfScope } = require('./accounts.cjs');
const { bearerOf, hashToken } = require('./tokens.cjs');
const wecom = require('./wecom.cjs');

const PRUNE_EVERY_MS = 10 * 60_000;
const HOOK_PER_HOUR = 60;
const HOOK_BODY_MAX = 16 * 1024;
const BIND_CODE_TTL_MS = 30 * 60_000;
/** 企微的 response_url 一小时有效;留五分钟余量。 */
const WECOM_RECEIPT_TTL_MS = 55 * 60_000;

function sendError(res, error) {
  res.status(error.status).json({ error: { message: error.message, type: 'invalid_request_error', code: error.code, ...error.extra } });
}

function mountCollab(app, { db, config, now, fetchImpl, log, deviceOf, sessionOf }) {
  const publicUrl = config.publicUrl ?? 'https://api.aibooo.cn';
  const wecomConfig = config.wecom ?? {};

  // ── 长轮询:谁在等哪条队列。notify 在事务里被调,真正放行发生在事务提交之后(同步代码跑完才轮到回调)。
  const waiters = new Map();
  function notify(queue, accountId) {
    const set = waiters.get(`${queue}|${accountId}`);
    if (set === undefined) return;
    for (const wake of [...set]) wake();
  }
  function waitFor(queue, accountId, ms, res) {
    return new Promise((resolve) => {
      const key = `${queue}|${accountId}`;
      let set = waiters.get(key);
      if (set === undefined) { set = new Set(); waiters.set(key, set); }
      let timer;
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) waiters.delete(key);
        resolve();
      };
      timer = setTimeout(done, ms);
      set.add(done);
      // 客户端走了就别挂着(用 res 的 close:GET 的 req 读完就会 close)。
      res.on('close', done);
    });
  }
  function waitOf(raw) {
    const n = Number.parseInt(String(raw ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? Math.min(n, config.inboxMaxWaitSeconds ?? collab.LONG_POLL_MAX_S) : 0;
  }

  let lastPrune = 0;
  function maybePrune() {
    const at = now().getTime();
    if (at - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = at;
    try {
      collab.pruneCollab(db, now(), {
        eventMs: (config.inboxEventDays ?? 30) * 24 * 3_600_000,
        doneRequestMs: (config.inboxDoneRequestDays ?? 7) * 24 * 3_600_000,
      });
    }
    catch (error) { log(`协作区清理失败:${error.message}`); }
  }

  /** 统一收 CollabError;别的错照常抛给 Express。 */
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof CollabError) { if (!res.headersSent) sendError(res, error); return; }
      throw error;
    }
  };

  /** 设备令牌 → `{ accountId, deviceId, deviceKind }`。老令牌(不在服务器账号名下)→ 403。 */
  function device(req, res) {
    const row = deviceOf(req, res);
    if (row === undefined) return undefined;
    const accountId = accountIdOfScope(row.account);
    if (accountId === undefined) {
      sendError(res, new CollabError(403, 'account_required', '这台设备还没登录服务器账号;在设置里登录后再进工作室。'));
      return undefined;
    }
    return { accountId, deviceId: row.device_id, deviceKind: row.device_kind ?? null };
  }

  function session(req, res) {
    const found = sessionOf(req, res);
    if (found === undefined) return undefined;
    return { accountId: found.account.id };
  }

  /** 设备令牌或会话令牌都认(只读的 /me 用)。 */
  function anyone(req, res) {
    const bearer = bearerOf(req.headers.authorization);
    return typeof bearer === 'string' && bearer.startsWith('wbs_') ? session(req, res) : device(req, res);
  }

  // ───────────────────────── 账号组 ─────────────────────────

  app.post('/v1/workspace', handle((req, res) => {
    const who = session(req, res); if (who === undefined) return;
    res.status(201).json(collab.createWorkspace(db, { accountId: who.accountId, name: req.body?.name, nick: req.body?.nick, now: now() }));
  }));

  app.post('/v1/workspace/invite', handle((req, res) => {
    const who = session(req, res); if (who === undefined) return;
    res.status(201).json(collab.createInvite(db, { accountId: who.accountId, now: now() }));
  }));

  app.post('/v1/workspace/join', handle((req, res) => {
    const who = session(req, res); if (who === undefined) return;
    res.json(collab.joinWorkspace(db, { accountId: who.accountId, code: req.body?.code, nick: req.body?.nick, now: now() }, notify));
  }));

  app.get('/v1/workspace/me', handle((req, res) => {
    const who = anyone(req, res); if (who === undefined) return;
    res.json(collab.workspaceMe(db, who.accountId));
  }));

  app.post('/v1/workspace/members/role', handle((req, res) => {
    const who = session(req, res); if (who === undefined) return;
    res.json({ member: collab.setMemberRole(db, { accountId: who.accountId, target: req.body?.account_id, role: req.body?.role, now: now() }, notify) });
  }));

  app.post('/v1/workspace/members/remove', handle((req, res) => {
    const who = session(req, res); if (who === undefined) return;
    res.json(collab.removeMember(db, { accountId: who.accountId, target: req.body?.account_id, now: now() }, notify));
  }));

  // ───────────────────────── 收件箱 ─────────────────────────

  app.get('/v1/inbox/events', handle(async (req, res) => {
    const who = device(req, res); if (who === undefined) return;
    // 被移除的人下一次拉就 403,设置页据此写「你已不在这个工作室」。
    if (collab.activeMembership(db, who.accountId) === undefined) {
      throw new CollabError(403, 'not_in_workspace', '你不在任何工作室里(可能已被移除)。');
    }
    maybePrune();
    const since = req.query.since === undefined ? collab.ackedOf(db, who.accountId, who.deviceId, 'events') : collab.cursorOf(req.query.since);
    const limit = collab.pageLimit(req.query.limit);
    const wait = waitOf(req.query.wait);
    let page = collab.readEvents(db, who.accountId, { since, limit });
    if (page.events.length === 0 && wait > 0) {
      await waitFor('events', who.accountId, wait * 1000, res);
      if (res.writableEnded || res.destroyed) return;
      page = collab.readEvents(db, who.accountId, { since, limit });
    }
    res.json(page);
  }));

  app.get('/v1/inbox/requests', handle(async (req, res) => {
    const who = device(req, res); if (who === undefined) return;
    if (who.deviceKind !== null && !collab.DESK_KINDS.has(who.deviceKind)) {
      throw new CollabError(403, 'desk_only', '请求队列只有这个账号的电脑(座机服务)能拉。');
    }
    maybePrune();
    const since = req.query.since === undefined ? collab.ackedOf(db, who.accountId, who.deviceId, 'requests') : collab.cursorOf(req.query.since);
    const limit = collab.pageLimit(req.query.limit);
    const wait = waitOf(req.query.wait);
    let page = collab.readRequests(db, who.accountId, { since, limit });
    if (page.requests.length === 0 && wait > 0) {
      await waitFor('requests', who.accountId, wait * 1000, res);
      if (res.writableEnded || res.destroyed) return;
      page = collab.readRequests(db, who.accountId, { since, limit });
    }
    res.json(page);
  }));

  app.post('/v1/inbox/requests', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const out = collab.sendRequest(db, { accountId: who.accountId, deviceId: who.deviceId, body: req.body, now: now() }, notify);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  app.post('/v1/inbox/requests/result', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const out = collab.finishRequest(db, { accountId: who.accountId, body: req.body, now: now() }, notify, { onFinished: wecomReceipt });
    res.json(out);
  }));

  app.post('/v1/inbox/ack', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    if (collab.activeMembership(db, who.accountId) === undefined) {
      throw new CollabError(403, 'not_in_workspace', '你不在任何工作室里(可能已被移除)。');
    }
    res.json(collab.ackInbox(db, { accountId: who.accountId, deviceId: who.deviceId, body: req.body, now: now() }));
  }));

  // ───────────────────────── 对象目录 ─────────────────────────

  /** 对象的权威写入方是座机服务:登记、推事件、交接只认电脑。 */
  function deskWriter(who) {
    if (who.deviceKind !== null && !collab.DESK_KINDS.has(who.deviceKind)) {
      throw new CollabError(403, 'desk_only', '对象只能由电脑(座机服务)登记、推事件、交接;手机发请求。');
    }
  }

  app.get('/v1/objects', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    if (typeof req.query.id === 'string' && req.query.id !== '') {
      res.json({ object: collab.getObject(db, who.accountId, req.query.id, now()) });
      return;
    }
    const kind = typeof req.query.kind === 'string' && req.query.kind !== '' ? req.query.kind : undefined;
    res.json({ objects: collab.listObjects(db, who.accountId, { kind, now: now() }) });
  }));

  app.post('/v1/objects', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    deskWriter(who);
    const out = collab.upsertObject(db, { accountId: who.accountId, deviceId: who.deviceId, body: req.body, now: now() }, notify);
    res.status(out.created ? 201 : 200).json({ object: out.object });
  }));

  app.post('/v1/objects/transfer', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    deskWriter(who);
    res.json(collab.transferObject(db, { accountId: who.accountId, deviceId: who.deviceId, body: req.body, now: now() }, notify));
  }));

  app.post('/v1/objects/:id/events', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    deskWriter(who);
    const out = collab.pushObjectEvent(db, { accountId: who.accountId, deviceId: who.deviceId, objectId: req.params.id, body: req.body, now: now() }, notify);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  // ───────────────────────── 频道 ─────────────────────────

  app.get('/v1/channels', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    res.json({ channels: collab.listChannels(db, who.accountId) });
  }));

  app.post('/v1/channels', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const out = collab.createProjectChannel(db, { accountId: who.accountId, body: req.body, now: now() }, notify);
    res.status(out.created ? 201 : 200).json({ channel: out.channel });
  }));

  app.post('/v1/channels/:id/archive', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    res.json(collab.archiveChannel(db, { accountId: who.accountId, channelId: req.params.id, now: now() }, notify));
  }));

  app.post('/v1/channels/:id/messages', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const out = collab.postMessage(db, {
      accountId: who.accountId, deviceId: who.deviceId, deviceKind: who.deviceKind, channelId: req.params.id, body: req.body, now: now(),
    }, notify);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  app.post('/v1/channels/:id/messages/:mid/retract', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const out = collab.retractMessage(db, {
      accountId: who.accountId, deviceId: who.deviceId, channelId: req.params.id, messageId: req.params.mid, body: req.body, now: now(),
    }, notify);
    res.status(out.duplicate ? 200 : 201).json(out);
  }));

  app.get('/v1/channels/:id/messages', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const before = req.query.before === undefined || req.query.before === '' ? undefined : collab.cursorOf(req.query.before);
    res.json(collab.channelSnapshot(db, { accountId: who.accountId, channelId: req.params.id, before, limit: collab.pageLimit(req.query.limit) }));
  }));

  // ───────────────────────── 定时派活的回调地址 ─────────────────────────

  function newHookSecret() {
    return `wh_${crypto.randomBytes(24).toString('base64url')}`;
  }
  function hookView(row) {
    return {
      id: row.id,
      label: row.label,
      target: JSON.parse(row.target),
      prefix: row.prefix,
      created_at: row.created_at,
      ...(row.rotated_at === null ? {} : { rotated_at: row.rotated_at }),
      ...(row.revoked_at === null ? {} : { revoked_at: row.revoked_at }),
      ...(row.last_hit_at === null ? {} : { last_hit_at: row.last_hit_at }),
    };
  }
  function deskOnly(who) {
    if (who.deviceKind !== null && !collab.DESK_KINDS.has(who.deviceKind)) {
      throw new CollabError(403, 'desk_only', '回调地址只有电脑(座机服务)能开:它是收请求的那一端。');
    }
  }
  function ownHook(who, id) {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ? AND account_id = ?').get(id, who.accountId);
    if (row === undefined) throw new CollabError(404, 'unknown_webhook', '没有这个回调地址。');
    return row;
  }

  app.get('/v1/webhooks', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const rows = db.prepare('SELECT * FROM webhooks WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, rowid ASC').all(who.accountId);
    res.json({ webhooks: rows.map(hookView) });
  }));

  /** 开一个回调地址。**整串地址只在这一次回包里出现**(库里只有哈希);丢了就轮换。 */
  app.post('/v1/webhooks', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    deskOnly(who);
    const label = typeof req.body?.label === 'string' && req.body.label.trim() !== '' ? req.body.label.trim().slice(0, 64) : undefined;
    if (label === undefined) throw new CollabError(400, 'bad_label', '给这个回调地址起个名字(1–64 字)。');
    const target = req.body?.target ?? {};
    if (typeof target !== 'object' || target === null || Array.isArray(target) || JSON.stringify(target).length > 8192) {
      throw new CollabError(400, 'bad_target', 'target 要是一个对象(派给哪张名片、便签模板),上限 8 KB。');
    }
    const secret = newHookSecret();
    const id = `wh:${collab.newId()}`;
    db.prepare('INSERT INTO webhooks (id, account_id, device_id, secret_hash, prefix, label, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, who.accountId, who.deviceId, hashToken(secret), secret.slice(0, 8), label, JSON.stringify(target), now().toISOString());
    res.status(201).json({ webhook: hookView(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)), url: `${publicUrl}/v1/hooks/${secret}` });
  }));

  app.post('/v1/webhooks/:id/rotate', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const row = ownHook(who, req.params.id);
    if (row.revoked_at !== null) throw new CollabError(409, 'webhook_revoked', '这个回调地址已经停用了,重新开一个。');
    const secret = newHookSecret();
    db.prepare('UPDATE webhooks SET secret_hash = ?, prefix = ?, rotated_at = ? WHERE id = ?')
      .run(hashToken(secret), secret.slice(0, 8), now().toISOString(), row.id);
    res.json({ webhook: hookView(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(row.id)), url: `${publicUrl}/v1/hooks/${secret}` });
  }));

  app.post('/v1/webhooks/:id/revoke', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const row = ownHook(who, req.params.id);
    db.prepare('UPDATE webhooks SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now().toISOString(), row.id);
    res.json({ revoked: true });
  }));

  const hookHits = new Map();
  function hookAllowed(id) {
    const at = now().getTime();
    const list = (hookHits.get(id) ?? []).filter(t => at - t < 3_600_000);
    if (list.length >= HOOK_PER_HOUR) { hookHits.set(id, list); return false; }
    list.push(at);
    hookHits.set(id, list);
    return true;
  }

  /**
   * 外面打进来的回调。认地址里的密钥(只比哈希);投成一条 `timer.fire` 请求进主人的请求队列,
   * 主人的座机服务拉到后按 target 建便签并派活。带 `Idempotency-Key` 头的同号重打只投一次。
   */
  app.post('/v1/hooks/:secret', handle((req, res) => {
    const secret = String(req.params.secret ?? '');
    const row = secret.startsWith('wh_')
      ? db.prepare('SELECT * FROM webhooks WHERE secret_hash = ? AND revoked_at IS NULL').get(hashToken(secret))
      : undefined;
    if (row === undefined) throw new CollabError(404, 'unknown_webhook', '没有这个回调地址(或已经轮换 / 停用)。');
    if (!hookAllowed(row.id)) throw new CollabError(429, 'webhook_rate_limited', `这个回调地址一小时最多收 ${HOOK_PER_HOUR} 次。`);
    const payload = req.body === undefined ? {} : req.body;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > HOOK_BODY_MAX) throw new CollabError(413, 'webhook_body_too_large', '回调正文上限 16 KB。');
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim().slice(0, 100) : '';
    const requestId = key === '' ? `hook:${row.id}:${collab.newId()}` : `hook:${row.id}:${key}`;
    const at = now();
    const out = collab.tx(db, () => {
      db.prepare('UPDATE webhooks SET last_hit_at = ? WHERE id = ?').run(at.toISOString(), row.id);
      return collab.insertRequest(db, {
        toAccount: row.account_id, requestId, fromAccount: row.account_id, fromDevice: `webhook:${row.id}`, op: 'timer.fire',
        args: { webhook_id: row.id, label: row.label, target: JSON.parse(row.target), body: payload, fired_at: at.toISOString() }, now: at,
      }, notify);
    });
    res.status(202).json({ request_id: out.request.request_id, duplicate: out.duplicate });
  }));

  // ───────────────────────── 企业微信机器人 ─────────────────────────

  function wecomReply(responseUrl, content) {
    if (!wecom.isWecomResponseUrl(responseUrl)) return;
    Promise.resolve().then(() => fetchImpl(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    })).catch(() => log('企微回执没发出去'));
  }

  /** 群里一句话变成的请求办完了 → 回执回群(response_url 一小时内、只用一次)。 */
  function wecomReceipt(request) {
    const row = db.prepare('SELECT * FROM wecom_receipts WHERE to_account = ? AND request_id = ?').get(request.to_account, request.request_id);
    if (row === undefined) return;
    db.prepare('DELETE FROM wecom_receipts WHERE to_account = ? AND request_id = ?').run(request.to_account, request.request_id);
    if (now().getTime() - Date.parse(row.created_at) > WECOM_RECEIPT_TTL_MS) { log('企微回执过了一小时,不回群了'); return; }
    const title = typeof request.result?.title === 'string' ? request.result.title : request.args?.title;
    const reason = typeof request.result?.reason === 'string' ? request.result.reason : '';
    let line;
    if (request.state === 'rejected') line = `没办成:${title ?? ''}${reason === '' ? '' : `(${reason})`}`;
    else if (request.op === 'agent.dispatch') line = `已派出:${title ?? ''}`;
    else line = `已记成便签:${title ?? ''}`;
    wecomReply(row.response_url, line);
  }

  function bindingOf(chatid) {
    return db.prepare('SELECT * FROM wecom_bindings WHERE chatid = ?').get(chatid);
  }

  function onWecomMessage(msg) {
    if (msg === null || typeof msg !== 'object' || msg.msgtype !== 'text') return;
    const userid = typeof msg.from?.userid === 'string' ? msg.from.userid : 'unknown';
    const chatid = typeof msg.chatid === 'string' && msg.chatid !== '' ? msg.chatid : `single:${userid}`;
    const msgid = typeof msg.msgid === 'string' && msg.msgid !== '' ? msg.msgid : collab.newId();
    const responseUrl = typeof msg.response_url === 'string' ? msg.response_url : '';
    const cmd = wecom.commandOf(msg.text?.content);
    const at = now();

    if (cmd.kind === 'bind') {
      const code = db.prepare('SELECT * FROM wecom_bind_codes WHERE code = ?').get(cmd.code);
      if (code === undefined || code.used_at !== null || Date.parse(code.expires_at) <= at.getTime()) {
        wecomReply(responseUrl, '绑定码不认识或过期了,在协作区设置里重新生成一个。');
        return;
      }
      collab.tx(db, () => {
        db.prepare('UPDATE wecom_bind_codes SET used_at = ? WHERE code = ?').run(at.toISOString(), cmd.code);
        db.prepare('INSERT OR REPLACE INTO wecom_bindings (chatid, workspace_id, channel_id, bound_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(chatid, code.workspace_id, code.channel_id, code.created_by, at.toISOString());
      });
      const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(code.channel_id);
      wecomReply(responseUrl, `已绑定到频道「${channel?.name ?? ''}」。以后在群里 @我 说一句就记成便签;「派给 名片名:要做的事」就派活。`);
      return;
    }
    if (cmd.kind === 'empty') return;

    const binding = bindingOf(chatid);
    if (binding === undefined) {
      wecomReply(responseUrl, '这个群还没绑定协作区频道。在协作区设置里生成绑定码,然后在群里 @我 发「绑定 绑定码」。');
      return;
    }
    if (!collab.isActiveMember(db, binding.workspace_id, binding.bound_by)) {
      wecomReply(responseUrl, '绑定这个群的人已不在工作室,请工作室里的人重新绑定。');
      return;
    }
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(binding.channel_id);
    if (channel === undefined || channel.archived_at !== null) {
      wecomReply(responseUrl, '绑定的频道已归档,请重新绑定。');
      return;
    }
    const requestId = `wecom:${msgid}`;
    const author = { person: binding.bound_by, nick: `企微·${userid}`.slice(0, 32), device: 'wecom' };
    const body = cmd.text;
    const title = wecom.firstSentence(body);

    try {
      collab.tx(db, () => {
        let target = { toAccount: binding.bound_by, op: 'task.create', objectId: undefined };
        if (cmd.kind === 'dispatch') {
          const agent = db.prepare("SELECT * FROM objects WHERE workspace_id = ? AND kind = 'agent' AND title = ?").get(binding.workspace_id, cmd.agent);
          const visible = agent === undefined ? undefined : collab.visibleObject(db, agent.object_id, binding.bound_by);
          if (visible === undefined) throw new CollabError(404, 'unknown_object', `工作室里没有叫「${cmd.agent}」的 Agent 名片。`);
          // 核名单用的是绑定人:群里的人不是工作室成员,借的是绑定人的身份。
          const shared = JSON.parse(visible.data ?? '{}')?.shared ?? {};
          if (visible.owner_account !== binding.bound_by
            && (shared.to !== 'workspace' || (Array.isArray(shared.allowed_members) && shared.allowed_members.length > 0 && !shared.allowed_members.includes(binding.bound_by)))) {
            throw new CollabError(403, 'agent_not_shared', `「${cmd.agent}」的主人没有把它共享给绑定这个群的人。`);
          }
          target = { toAccount: visible.owner_account, op: 'agent.dispatch', objectId: visible.object_id };
        }
        const { message } = collab.appendMessage(db, {
          channel, author, kind: 'say', textBody: msg.text.content.trim().slice(0, collab.TEXT_MAX), requestId, via: 'wecom', now: at,
        }, notify);
        const args = {
          title, desc: body, origin: 'channel', channel: channel.id,
          ...(channel.project_object_id === null ? {} : { project_object_id: channel.project_object_id }),
          source: { via: 'wecom', ref: message.id, from_user: userid, chatid },
        };
        const out = collab.insertRequest(db, {
          toAccount: target.toAccount, requestId, fromAccount: binding.bound_by, fromDevice: 'wecom', op: target.op, objectId: target.objectId, args, now: at,
        }, notify);
        if (!out.duplicate && wecom.isWecomResponseUrl(responseUrl)) {
          db.prepare('INSERT OR IGNORE INTO wecom_receipts (to_account, request_id, response_url, created_at) VALUES (?, ?, ?, ?)')
            .run(target.toAccount, requestId, responseUrl, at.toISOString());
        }
      });
    }
    catch (error) {
      if (error instanceof CollabError) { wecomReply(responseUrl, error.message); return; }
      throw error;
    }
  }

  function wecomReady(res) {
    if (wecom.wecomConfigured(wecomConfig)) return true;
    res.status(503).json({ error: { message: '企业微信机器人还没配(RELAY_WECOM_TOKEN / RELAY_WECOM_ENCODING_AES_KEY)。', type: 'server_error', code: 'wecom_not_configured' } });
    return false;
  }

  /** 企微后台「保存回调地址」时打的验证:验签 → 解 echostr → 原样回明文。 */
  app.get('/v1/wecom/callback', (req, res) => {
    if (!wecomReady(res)) return;
    const q = req.query;
    const echostr = typeof q.echostr === 'string' ? q.echostr : '';
    if (!wecom.verifySignature(wecomConfig, { signature: q.msg_signature, timestamp: q.timestamp, nonce: q.nonce, encrypt: echostr })) {
      res.status(401).type('text/plain').send('bad signature');
      return;
    }
    try { res.type('text/plain').send(wecom.decrypt(wecomConfig, echostr)); }
    catch { res.status(400).type('text/plain').send('bad echostr'); }
  });

  app.post('/v1/wecom/callback', express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '256kb' }), (req, res) => {
    if (!wecomReady(res)) return;
    const q = req.query;
    const enc = wecom.encryptOf(req.body);
    if (enc === undefined || !wecom.verifySignature(wecomConfig, { signature: q.msg_signature, timestamp: q.timestamp, nonce: q.nonce, encrypt: enc })) {
      res.status(401).type('text/plain').send('bad signature');
      return;
    }
    let msg;
    try { msg = JSON.parse(wecom.decrypt(wecomConfig, enc)); }
    catch { res.status(400).type('text/plain').send('bad message'); return; }
    try { onWecomMessage(msg); }
    catch (error) { log(`企微消息没处理成:${error.message}`); }
    // 先回 200 空包:企微收不到 200 会重试三次;重试同一个 msgid 靠 request_id 去重。
    res.status(200).type('text/plain').send('');
  });

  app.post('/v1/wecom/bindings', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const channelId = typeof req.body?.channel_id === 'string' ? req.body.channel_id : '';
    const channel = collab.channelFor(db, channelId, who.accountId);
    if (channel.archived_at !== null) throw new CollabError(409, 'channel_archived', '这个频道已归档。');
    const code = collab.newCode();
    const expires = new Date(now().getTime() + BIND_CODE_TTL_MS).toISOString();
    db.prepare('INSERT INTO wecom_bind_codes (code, workspace_id, channel_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, channel.workspace_id, channel.id, who.accountId, expires);
    res.status(201).json({ code, expires_at: expires, say: `绑定 ${code}` });
  }));

  app.get('/v1/wecom/bindings', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const m = collab.activeMembership(db, who.accountId);
    const rows = m === undefined ? [] : db.prepare('SELECT * FROM wecom_bindings WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC').all(m.workspace_id);
    res.json({ bindings: rows, configured: wecom.wecomConfigured(wecomConfig) });
  }));

  app.post('/v1/wecom/bindings/remove', handle((req, res) => {
    const who = device(req, res); if (who === undefined) return;
    const m = collab.activeMembership(db, who.accountId);
    const row = typeof req.body?.chatid === 'string' ? bindingOf(req.body.chatid) : undefined;
    if (m === undefined || row === undefined || row.workspace_id !== m.workspace_id) throw new CollabError(404, 'unknown_binding', '没有这个群的绑定。');
    if (row.bound_by !== who.accountId && m.role !== 'admin') throw new CollabError(403, 'not_admin', '只有绑定人或管理员能解绑。');
    db.prepare('DELETE FROM wecom_bindings WHERE chatid = ?').run(row.chatid);
    res.json({ removed: true });
  }));

  return { notify };
}

module.exports = { mountCollab, WECOM_RECEIPT_TTL_MS, BIND_CODE_TTL_MS, HOOK_PER_HOUR };
