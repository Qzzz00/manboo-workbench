'use strict';

// 来源:Aiboo origin/main 1f430c3f server/middleware/adminAuth.cjs(本机版重写)
//
// Aiboo 的版本是 JWT 账号登录;本机版没有账号密码,唯一用户是 Ben 本人。放行两种来源:
//   1. 来自 127.0.0.1 回环的请求(浏览器直接打开 /admin/);
//   2. 带 X-Workbench-Token 且与 ~/.dsh/workbench/butler.json 里的 token 一致(工作台 8791 代理转发;
//      以后开热点网段给手机也走这一条)。
// 其余一律 403。审计字段 req.admin 固定为本机用户,搬来的路由不用改。

const crypto = require('node:crypto');
const { loadConfig } = require('../config.cjs');

const FORBIDDEN = { code: 'forbidden', error: '只接受本机或工作台转发的请求' };

function isLoopbackAddress(address) {
  const a = String(address || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminAuthMiddleware(req, res, next) {
  const header = req.headers['x-workbench-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (token !== undefined) {
    // 带了令牌就只认令牌:错的令牌即使来自本机也拒绝(避免"错令牌但恰好回环"掩盖配置问题)。
    if (!tokenMatches(token, loadConfig().token)) return res.status(403).json(FORBIDDEN);
  } else if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    return res.status(403).json(FORBIDDEN);
  }
  req.admin = { id: 0, username: 'ben' };
  next();
}

module.exports = adminAuthMiddleware;
module.exports.adminAuthMiddleware = adminAuthMiddleware;
module.exports.isLoopbackAddress = isLoopbackAddress;
