'use strict';

// 来源:Aiboo origin/main 1f430c3f server/lib/previewToken.cjs(密钥改取 butler.json)
const crypto = require('node:crypto');
const { loadConfig } = require('../config.cjs');

// 本机版:签名密钥 = butler.json 里的 token(Aiboo 用的是 ADMIN_JWT_SECRET)。测试可用 BUTLER_PREVIEW_SECRET 覆盖。
function getSecret() {
  if (process.env.BUTLER_PREVIEW_SECRET !== undefined) return process.env.BUTLER_PREVIEW_SECRET;
  try {
    return loadConfig().token || '';
  } catch {
    return '';
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

// token = base64url(payload) + '.' + base64url(hmac(payload))
// payload = `${id}.${version}.${expMs}`
function signPreviewToken(id, version, opts = {}) {
  const secret = getSecret();
  if (!secret) throw new Error('preview secret is not configured');
  const now = opts.now ? opts.now() : Date.now();
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 600_000;
  const exp = now + ttlMs;
  const payload = `${id}.${version}.${exp}`;
  const sig = hmac(secret, payload);
  return `${b64url(payload)}.${b64url(sig)}`;
}

function verifyPreviewToken(token, id, opts = {}) {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };

  const dot = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expected = hmac(secret, payload);
  let provided;
  try {
    provided = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const parts = payload.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [tokenId, versionStr, expStr] = parts;
  if (tokenId !== id) return { ok: false, reason: 'id_mismatch' };

  const now = opts.now ? opts.now() : Date.now();
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || now > exp) return { ok: false, reason: 'expired' };

  const version = Number(versionStr);
  if (!Number.isInteger(version)) return { ok: false, reason: 'bad_version' };

  return { ok: true, version };
}

module.exports = { signPreviewToken, verifyPreviewToken };
