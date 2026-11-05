/**
 * 为电子吧唧演示设备签发长期 access token（绑定固定测试账号）。
 *
 * 用法（在 server 同环境下跑，确保 JWT_SECRET 与线上一致）：
 *   node scripts/badge-sign-token.cjs <username> [days=180]
 */
'use strict';

try {
  require('dotenv').config(); // 与 server.cjs 同源加载 .env，保证 JWT_SECRET 一致
} catch { /* optional */ }

const jwt = require('jsonwebtoken');
const { db } = require('../server/db.cjs');

const JWT_SECRET = process.env.JWT_SECRET || 'llm-live2d-secret-key-change-me';

const username = process.argv[2];
const days = Number(process.argv[3] || 180);
if (!username) {
  console.error('usage: node scripts/badge-sign-token.cjs <username> [days=180]');
  process.exit(1);
}

const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`user not found: ${username}`);
  process.exit(1);
}

const token = jwt.sign(
  { id: user.id, username: user.username, type: 'access' },
  JWT_SECRET,
  { expiresIn: `${days}d` },
);
console.log(token);
