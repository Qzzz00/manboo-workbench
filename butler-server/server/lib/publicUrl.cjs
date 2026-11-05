'use strict';

// 手机看到的绝对地址(2026-09-14)。
//
// 手机只跟工作台 8791 说话,请求经 /butler/proxy/* 转到本机 8792;8792 自己看到的 host 永远是 127.0.0.1:8792,
// 直接拿它拼 URL 手机打不通。所以按这个顺序定「对外根地址」:
//   1. PUBLIC_BASE_URL 环境变量(灰度/固定域名时用);
//   2. 代理带来的 X-Forwarded-Proto / X-Forwarded-Host / X-Forwarded-Prefix(8791 转发时会带,见 workbench-plugin/src/server/butler.ts);
//   3. 请求自己的 host(本机直连 8792 的情形,与 Aiboo 原逻辑一致)。
// 结果形如 http://10.86.37.27:8791/butler/proxy,不带尾斜杠。
//
// 背景/头像/铃声在上传时被 routes/admin/avatars.cjs 存成了绝对 URL(当时的 host,通常是 127.0.0.1:8792);
// rebase() 把其中 /uploads/... 的路径接到上面的根上,别的地址(外链)原样。

function firstHeader(req, name) {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.split(',')[0].trim() : '';
}

function publicBase(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const proto = firstHeader(req, 'x-forwarded-proto') || req.protocol || 'http';
  const host = firstHeader(req, 'x-forwarded-host') || req.get('host') || '127.0.0.1';
  let prefix = firstHeader(req, 'x-forwarded-prefix');
  if (prefix && !prefix.startsWith('/')) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, '');
  return `${proto}://${host}${prefix}`;
}

/** 站内路径(以 / 开头)→ 绝对地址。 */
function absolute(req, path) {
  return `${publicBase(req)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 库里存的地址(绝对或相对)→ 手机可用的绝对地址;空值原样回 null。 */
function rebase(req, stored) {
  if (typeof stored !== 'string' || !stored.trim()) return null;
  const s = stored.trim();
  if (s.startsWith('/uploads/')) return absolute(req, s);
  try {
    const u = new URL(s);
    if (u.pathname.startsWith('/uploads/')) return absolute(req, `${u.pathname}${u.search}`);
    return s;
  } catch {
    return s;
  }
}

module.exports = { publicBase, absolute, rebase };
