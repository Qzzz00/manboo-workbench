'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/routes/avatars.cjs(手机侧形象分发接口,本机版改写)
//
//   GET /api/avatars                 已发布形象列表:id、name、summary、persona、封面、Live2D 包下载地址、绑定的音色
//   GET /api/avatars/:id             详情,含 model_entry(model3.json 入口路径)、transform、背景/头像/铃声
//   GET /api/avatars/:id/bundle.zip  已发布版本的 Live2D 包(Range / ETag)
//
// 与 Aiboo 的差别:
//   - 鉴权是 adminAuth(回环或 X-Workbench-Token),手机经工作台 8791 的 /butler/proxy 进来时由 8791 认设备令牌;
//   - 世界书(lorebook)、prompt_template、opening 这些不下发——事务官的提示词走工作台 → DSH,不在这里长;
//   - 路径改成 /:id/bundle.zip(只给当前已发布版本),不再按版本号取任意历史包;
//   - 绝对地址按 lib/publicUrl.cjs 生成(X-Forwarded-*),不是 8792 自己的 host;
//   - 草稿 / 归档 / 不存在一律 404 avatar_not_found,不区分(与 Aiboo §7.4 同)。

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { db, UPLOADS_ROOT } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const { absolute, rebase } = require('../../lib/publicUrl.cjs');

const router = express.Router();

const ZIP_CONTENT_TYPE = 'application/zip';
const ASSET_CACHE_CONTROL = 'private, max-age=86400';

function notFound(res) {
  return res.status(404).json({ code: 'avatar_not_found', error: '没有这个形象,或它还没发布' });
}

function safeParseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 形象绑定的音色(chat 场景;没绑定时落到默认供应商的默认音色)。只回类型与音色 id,不回供应商密钥。
function voiceOf(avatarId) {
  let resolved = null;
  try {
    resolved = avatarVoiceStore.resolveVoice(db, avatarId, 'chat');
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.provider) return null;
  return {
    scene: 'chat',
    provider_type: resolved.provider.provider_type,
    voice_id: resolved.voiceId,
    source: resolved.source,
  };
}

const PUBLISHED_COLUMNS = `
  a.id, a.name, a.summary, a.persona_json, a.transform_json, a.motions_json, a.model_entry,
  a.current_version AS version, a.status, a.default_background, a.portrait_url, a.ringtone_url, a.notify_sound_url,
  a.idle_enhance_enabled, a.idle_enhance_interval_sec, a.updated_at,
  aa.checksum, aa.size_bytes
`;

function summarize(req, row) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    persona: safeParseJson(row.persona_json, {}),
    version: row.version,
    checksum: row.checksum ?? null,
    size_bytes: row.size_bytes ?? null,
    cover_url: rebase(req, row.portrait_url),
    bundle_url: absolute(req, `/api/avatars/${encodeURIComponent(row.id)}/bundle.zip`),
    voice: voiceOf(row.id),
    updated_at: row.updated_at,
  };
}

router.get('/', adminAuthMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT ${PUBLISHED_COLUMNS}
    FROM avatars a
    LEFT JOIN avatar_assets aa ON aa.avatar_id = a.id AND aa.version = a.current_version
    WHERE a.status = 'published'
    ORDER BY a.updated_at DESC, a.id ASC
  `).all();
  res.json({ avatars: rows.map((row) => summarize(req, row)) });
});

router.get('/:id', adminAuthMiddleware, (req, res) => {
  const row = db.prepare(`
    SELECT ${PUBLISHED_COLUMNS}
    FROM avatars a
    LEFT JOIN avatar_assets aa ON aa.avatar_id = a.id AND aa.version = a.current_version
    WHERE a.id = ?
  `).get(req.params.id);
  if (!row || row.status !== 'published') return notFound(res);

  res.json({
    avatar: {
      ...summarize(req, row),
      transform: safeParseJson(row.transform_json, {}),
      motions: safeParseJson(row.motions_json, null),
      model_entry: row.model_entry,
      default_background: rebase(req, row.default_background),
      portrait_url: rebase(req, row.portrait_url),
      ringtone_url: rebase(req, row.ringtone_url),
      notify_sound_url: rebase(req, row.notify_sound_url),
      // 待机动作增强(客户端 idle-beat 调度读取):enabled 默认开,interval 为空 = 用内置默认区间。
      idleEnhancement: {
        enabled: row.idle_enhance_enabled !== 0,
        intervalSec: row.idle_enhance_interval_sec ?? null,
      },
    },
  });
});

// 库里的 zip_path 是相对 UPLOADS_ROOT 的路径;解析后必须仍在 UPLOADS_ROOT 之内,否则当不存在处理(纵深防御)。
function resolveBundlePath(zipPath) {
  if (typeof zipPath !== 'string' || !zipPath || path.isAbsolute(zipPath)) return null;
  const root = path.resolve(UPLOADS_ROOT);
  const abs = path.resolve(root, zipPath);
  if (abs === root || !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// 单段 Range 解析:{ start, end }(闭区间)/ null(没有或忽略)/ { unsatisfiable: true }。
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

router.get('/:id/bundle.zip', adminAuthMiddleware, (req, res) => {
  const asset = db.prepare(`
    SELECT aa.zip_path, aa.size_bytes, aa.checksum
    FROM avatar_assets aa
    JOIN avatars a ON a.id = aa.avatar_id AND aa.version = a.current_version
    WHERE aa.avatar_id = ? AND a.status = 'published'
  `).get(req.params.id);
  if (!asset) return notFound(res);

  const bundlePath = resolveBundlePath(asset.zip_path);
  if (!bundlePath) return notFound(res);

  let stat;
  try {
    stat = fs.statSync(bundlePath);
  } catch {
    return notFound(res);
  }
  const size = stat.size;

  res.setHeader('Content-Type', ZIP_CONTENT_TYPE);
  res.setHeader('Cache-Control', ASSET_CACHE_CONTROL);
  if (asset.checksum) res.setHeader('ETag', `"${asset.checksum}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = parseRange(req.headers.range, size);
  if (range && range.unsatisfiable) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  if (range) {
    const { start, end } = range;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(bundlePath, { start, end }).pipe(res);
  }
  res.status(200);
  res.setHeader('Content-Length', size);
  return fs.createReadStream(bundlePath).pipe(res);
});

module.exports = router;
module.exports.resolveBundlePath = resolveBundlePath;
module.exports.parseRange = parseRange;
