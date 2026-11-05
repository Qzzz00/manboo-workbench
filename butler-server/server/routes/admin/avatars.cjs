'use strict';

// 来源:Aiboo origin/main 1f430c3f server/routes/admin/avatars.cjs(去掉 journey-engine / comic-store 依赖;附件目录改到 BUTLER_HOME)
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');

const { db, UPLOADS_ROOT, UPLOADS_BASE } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const avatarStore = require('../../services/avatarStore.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const { validateAndExtractZip, findModelEntry, sha256Hex, MAX_ZIP_BYTES } = require('../../services/zipService.cjs');
const { signPreviewToken, verifyPreviewToken } = require('../../lib/previewToken.cjs');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES } });

const ID_LENGTH = 10;
const ID_RETRY = 3;
// UPLOADS_ROOT 来自 db.cjs，作为唯一来源（写入与下载读取共用同一根目录）。

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// best-effort recursive cleanup; never throws.
function safeRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[adminAvatars] cleanup failed for ${dir}: ${err.message}`);
  }
}

function zipErrorStatus(code) {
  if (code === 'upload_too_large') return 413;
  return 400; // avatar_zip_invalid / avatar_zip_no_model / avatar_zip_path_traversal / avatar_zip_bad_filename
}

// 预览 URL 里的模型路径:逐段 encodeURIComponent,斜杠保留。中文 / 全角括号 / 空格都编码成 ASCII,
// 前端拿 modelUrl 直接用;modelEntry 仍回原名(展示与兼容旧前端)。
function encodePathSegments(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

// 只认本机回环:重新解压是运维动作,不走工作台代理转发。
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopbackRequest(req) {
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress);
}

function serializeAvatar(row) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    persona: JSON.parse(row.persona_json || '{}'),
    transform: JSON.parse(row.transform_json || '{}'),
    motions: row.motions_json ? JSON.parse(row.motions_json) : null,
    prompt_template: row.prompt_template_json ? JSON.parse(row.prompt_template_json) : null,
    model_entry: row.model_entry,
    current_version: row.current_version,
    status: row.status,
    llm_model_id: row.llm_model_id ?? null,
    voice: row.voice ?? null,
    default_background: row.default_background ?? null,
    portrait_url: row.portrait_url ?? null,
    ringtone_url: row.ringtone_url ?? null,
    notify_sound_url: row.notify_sound_url ?? null,
    dj_binding: row.dj_binding_json ? JSON.parse(row.dj_binding_json) : null,
    opening_enabled: row.opening_enabled === 1,
    opening_text: row.opening_text ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_by: row.published_by ?? null,
    published_at: row.published_at ?? null,
    unpublished_by: row.unpublished_by ?? null,
    unpublished_at: row.unpublished_at ?? null,
  };
}

function sendError(res, err) {
  if (err && err.code === 'avatar_not_found') {
    return res.status(404).json({ code: 'avatar_not_found', error: err.message });
  }
  if (err && err.code === 'validation_error') {
    return res.status(400).json({ code: 'validation_error', error: err.message });
  }
  return res.status(500).json({ code: 'internal_error', error: 'Internal server error' });
}

// Validate the multipart `meta` JSON field for avatar creation.
function parseCreateMeta(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw { status: 400, code: 'invalid_meta', error: 'meta field is required' };
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw { status: 400, code: 'invalid_meta', error: 'meta must be valid JSON' };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw { status: 400, code: 'invalid_meta', error: 'meta must be a JSON object' };
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) {
    throw { status: 400, code: 'invalid_meta', error: 'name is required' };
  }
  const summary = typeof meta.summary === 'string' ? meta.summary : '';

  const persona = meta.persona && typeof meta.persona === 'object' && !Array.isArray(meta.persona) ? meta.persona : {};
  const transform =
    meta.transform && typeof meta.transform === 'object' && !Array.isArray(meta.transform) ? meta.transform : {};
  const motions =
    meta.motions && typeof meta.motions === 'object' && !Array.isArray(meta.motions) ? meta.motions : null;

  return { name, summary, persona, transform, motions };
}

// ---- prepared statements ----
const getAvatar = db.prepare('SELECT * FROM avatars WHERE id = ?');
const insertAvatar = db.prepare(`
  INSERT INTO avatars (id, name, summary, persona_json, transform_json, motions_json, model_entry, current_version, status, created_at, updated_at)
  VALUES (@id, @name, @summary, @persona_json, @transform_json, @motions_json, @model_entry, @current_version, @status, @ts, @ts)
`);
const insertAsset = db.prepare(`
  INSERT INTO avatar_assets (avatar_id, version, zip_path, unpacked_dir, size_bytes, checksum, uploaded_at)
  VALUES (@avatar_id, @version, @zip_path, @unpacked_dir, @size_bytes, @checksum, @ts)
`);
const getAsset = db.prepare('SELECT * FROM avatar_assets WHERE avatar_id = ? AND version = ?');
const insertRestoredAsset = db.prepare(`
  INSERT INTO avatar_assets (avatar_id, version, zip_path, unpacked_dir, size_bytes, checksum, uploaded_at, restore_source_version, restore_reason, restored_at)
  VALUES (@avatar_id, @version, @zip_path, @unpacked_dir, @size_bytes, @checksum, @ts, @restore_source_version, @restore_reason, @ts)
`);
const updateAvatarVersion = db.prepare(
  'UPDATE avatars SET current_version = @version, model_entry = @model_entry, updated_at = @ts WHERE id = @id',
);
const updateAvatarStatus = db.prepare('UPDATE avatars SET status = @status, updated_at = @ts WHERE id = @id');
const publishAvatarAudit = db.prepare(`
  UPDATE avatars
  SET status = 'published', published_by = @by, published_at = @ts,
      unpublished_by = NULL, unpublished_at = NULL, updated_at = @ts
  WHERE id = @id
`);
const unpublishAvatarAudit = db.prepare(`
  UPDATE avatars
  SET status = 'draft', unpublished_by = @by, unpublished_at = @ts,
      published_by = NULL, published_at = NULL, updated_at = @ts
  WHERE id = @id
`);
const deleteAssets = db.prepare('DELETE FROM avatar_assets WHERE avatar_id = ?');
const deleteAvatar = db.prepare('DELETE FROM avatars WHERE id = ?');

// ---- helpers ----
const versionDir = (id, version) => path.join(UPLOADS_ROOT, id, `v${version}`);
const relZipPath = (id, version) => path.posix.join(id, `v${version}`, 'bundle.zip');
const relUnpackedDir = (id, version) => path.posix.join(id, `v${version}`, 'unpacked');

function generateId() {
  for (let i = 0; i < ID_RETRY; i += 1) {
    const id = nanoid(ID_LENGTH);
    if (!getAvatar.get(id)) return id;
  }
  return null;
}

// multer wrapper that maps the file-size limit to upload_too_large.
function handleZipUpload(req, res, next) {
  upload.single('zip')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ code: 'upload_too_large', error: 'Uploaded zip exceeds 100MB' });
    }
    return res.status(400).json({ code: 'avatar_zip_invalid', error: err.message || 'Upload failed' });
  });
}

// ---- 背景图上传：存盘 + 返回客户端可直连的绝对 URL ----
// 目录解析与 server.cjs 的 /uploads/backgrounds 静态服务保持一致（同 TTS 的先例）。
const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;
// 本机版:三类附件都落在 ~/.dsh/workbench/butler/uploads/ 下(与 app.cjs 的 /uploads/* 静态服务同根)。
const backgroundsDir = path.join(UPLOADS_BASE, 'backgrounds');
const backgroundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BACKGROUND_BYTES } });

// 校验背景图名字（去扩展名的部分，如 1783052233-5NAuhL_5）：只允许数字、字母、下划线、中划线
function isValidBgName(name) {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// 按魔数识别图片类型；客户端 <img> 直连展示，扩展名/前端 mimetype 都不可信。
function sniffImageExt(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function handleBackgroundUpload(req, res, next) {
  backgroundUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ code: 'background_too_large', error: 'Background image exceeds 10MB' });
    }
    return res.status(400).json({ code: 'background_upload_invalid', error: err.message || 'Upload failed' });
  });
}

// ---- POST /admin/avatars/backgrounds : upload a background image ----
router.post('/backgrounds', adminAuthMiddleware, handleBackgroundUpload, (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ code: 'background_missing', error: 'Missing image field' });
  }
  const ext = sniffImageExt(req.file.buffer);
  if (!ext) {
    return res.status(400).json({ code: 'background_not_image', error: 'Only PNG/JPEG/WebP images are accepted' });
  }
  const filename = `${nowSec()}-${nanoid(8)}.${ext}`;
  try {
    fs.mkdirSync(backgroundsDir, { recursive: true });
    fs.writeFileSync(path.join(backgroundsDir, filename), req.file.buffer);
  } catch (err) {
    console.error('[adminAvatars] background write failed:', err);
    return res.status(500).json({ code: 'background_write_failed', error: 'Failed to store image' });
  }
  // 存进 default_background 的必须是绝对 URL：客户端 App(capacitor https://localhost)
  // 对相对路径会解析到自己的 origin。默认取本次请求的 host（admin 与 API 同源部署）。
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return res.json({ url: `${base}/uploads/backgrounds/${filename}` });
});

// ---- POST /admin/avatars/backgrounds/:name/depth : 上传深度图(2.5D 景深) ----
// :name = 背景文件名去扩展(如 1783052233-5NAuhL_5)，存 <name>.depth.png 同目录。
// 深度图靠命名约定关联背景，客户端 deriveDepthUrl 自动探测，不进 DB；只接受 PNG。
router.post('/backgrounds/:name/depth', adminAuthMiddleware, handleBackgroundUpload, (req, res) => {
  const name = req.params.name;
  if (!isValidBgName(name)) {
    return res.status(400).json({ code: 'depth_bad_name', error: 'Invalid background name' });
  }
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ code: 'depth_missing', error: 'Missing image field' });
  }
  if (sniffImageExt(req.file.buffer) !== 'png') {
    return res.status(400).json({ code: 'depth_not_png', error: 'Depth map must be a PNG image' });
  }
  try {
    fs.mkdirSync(backgroundsDir, { recursive: true });
    fs.writeFileSync(path.join(backgroundsDir, `${name}.depth.png`), req.file.buffer);
  } catch (err) {
    console.error('[adminAvatars] depth write failed:', err);
    return res.status(500).json({ code: 'depth_write_failed', error: 'Failed to store depth map' });
  }
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return res.json({ ok: true, url: `${base}/uploads/backgrounds/${name}.depth.png` });
});

// ---- 头像图上传：与背景图同款，存 uploads/portraits ----
const portraitsDir = path.join(UPLOADS_BASE, 'portraits');
router.post('/portraits', adminAuthMiddleware, handleBackgroundUpload, (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ code: 'portrait_missing', error: 'Missing image field' });
  }
  const ext = sniffImageExt(req.file.buffer);
  if (!ext) return res.status(400).json({ code: 'portrait_not_image', error: 'Only PNG/JPEG/WebP images are accepted' });
  const filename = `${nowSec()}-${nanoid(8)}.${ext}`;
  try {
    fs.mkdirSync(portraitsDir, { recursive: true });
    fs.writeFileSync(path.join(portraitsDir, filename), req.file.buffer);
  } catch (err) {
    console.error('[adminAvatars] portrait write failed:', err);
    return res.status(500).json({ code: 'portrait_write_failed', error: 'Failed to store image' });
  }
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return res.json({ url: `${base}/uploads/portraits/${filename}` });
});

// ---- 音频上传（来电铃声 / 消息提示音共用）：存 uploads/ringtones ----
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const ringtonesDir = path.join(UPLOADS_BASE, 'ringtones');
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });
function sniffMp3(buf) {
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // 'ID3'
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}
function handleAudioUpload(req, res, next) {
  audioUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ code: 'audio_too_large', error: 'Audio exceeds 5MB' });
    return res.status(400).json({ code: 'audio_upload_invalid', error: err.message || 'Upload failed' });
  });
}
router.post('/audio', adminAuthMiddleware, handleAudioUpload, (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ code: 'audio_missing', error: 'Missing audio field' });
  }
  if (!sniffMp3(req.file.buffer)) return res.status(400).json({ code: 'audio_not_mp3', error: 'Only MP3 audio is accepted' });
  const filename = `${nowSec()}-${nanoid(8)}.mp3`;
  try {
    fs.mkdirSync(ringtonesDir, { recursive: true });
    fs.writeFileSync(path.join(ringtonesDir, filename), req.file.buffer);
  } catch (err) {
    console.error('[adminAvatars] audio write failed:', err);
    return res.status(500).json({ code: 'audio_write_failed', error: 'Failed to store audio' });
  }
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return res.json({ url: `${base}/uploads/ringtones/${filename}` });
});

// ---- GET /admin/avatars : list (optional ?status= filter) ----
router.get('/', adminAuthMiddleware, (req, res) => {
  try {
    const status = req.query.status === undefined ? undefined : String(req.query.status);
    res.json({ avatars: avatarStore.listAvatars(db, { status }) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /admin/avatars/:id/prompt_template ----
router.get('/:id/prompt_template', adminAuthMiddleware, (req, res) => {
  try {
    res.json({ prompt_template: avatarStore.getPromptTemplate(db, req.params.id) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- PUT /admin/avatars/:id/prompt_template ----
router.put('/:id/prompt_template', adminAuthMiddleware, (req, res) => {
  try {
    const promptTemplate = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'prompt_template')
      ? req.body.prompt_template
      : req.body;
    res.json({ prompt_template: avatarStore.updatePromptTemplate(db, req.params.id, promptTemplate) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- GET /admin/avatars/:id : detail + versions ----
router.get('/:id', adminAuthMiddleware, (req, res) => {
  try {
    const avatar = avatarStore.getAvatarDetail(db, req.params.id);
    avatar.voice_bindings = avatarVoiceStore.getBindings(db, req.params.id);
    res.json({ avatar });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- 角色 × 场景级音色绑定 ----
// PUT  /admin/avatars/:id/voice-bindings/:scene  upsert 一条绑定
// DELETE 同路径                                   删除（回到继承/全局默认）
router.put('/:id/voice-bindings/:scene', adminAuthMiddleware, (req, res) => {
  try {
    avatarStore.getAvatarDetail(db, req.params.id); // 不存在则 404
    const { providerId, voiceId, params } = req.body || {};
    const binding = avatarVoiceStore.setBinding(db, req.params.id, req.params.scene, { providerId, voiceId, params });
    res.json({ binding });
  } catch (err) {
    if (err.code === 'invalid_voice_binding') return res.status(400).json({ error: err.message });
    sendError(res, err);
  }
});

router.delete('/:id/voice-bindings/:scene', adminAuthMiddleware, (req, res) => {
  try {
    avatarStore.getAvatarDetail(db, req.params.id); // 不存在则 404
    avatarVoiceStore.removeBinding(db, req.params.id, req.params.scene);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- PATCH /admin/avatars/:id : edit name/summary/persona/transform/motions ----
router.patch('/:id', adminAuthMiddleware, (req, res) => {
  try {
    res.json({ avatar: avatarStore.updateAvatar(db, req.params.id, req.body) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- POST /admin/avatars : create avatar + first version ----
router.post('/', adminAuthMiddleware, handleZipUpload, (req, res) => {
  let meta;
  try {
    meta = parseCreateMeta(req.body?.meta);
  } catch (e) {
    return res.status(e.status || 400).json({ code: e.code, error: e.error });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ code: 'avatar_zip_invalid', error: 'zip file field is required' });
  }

  const id = generateId();
  if (!id) {
    return res.status(500).json({ code: 'avatar_id_collision', error: 'Failed to allocate a unique avatar id' });
  }

  const vDir = versionDir(id, 1);
  const unpacked = path.join(vDir, 'unpacked');

  let extraction;
  try {
    extraction = validateAndExtractZip(req.file.buffer, unpacked);
  } catch (err) {
    safeRemove(path.join(UPLOADS_ROOT, id));
    if (err.isZipError) {
      return res.status(zipErrorStatus(err.code)).json({ code: err.code, error: err.message });
    }
    console.error('[adminAvatars] extraction failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to process zip' });
  }

  try {
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'bundle.zip'), req.file.buffer);

    const ts = nowSec();
    const tx = db.transaction(() => {
      insertAvatar.run({
        id,
        name: meta.name,
        summary: meta.summary,
        persona_json: JSON.stringify(meta.persona),
        transform_json: JSON.stringify(meta.transform),
        motions_json: meta.motions ? JSON.stringify(meta.motions) : null,
        model_entry: extraction.modelEntry,
        current_version: 1,
        status: 'draft',
        ts,
      });
      insertAsset.run({
        avatar_id: id,
        version: 1,
        zip_path: relZipPath(id, 1),
        unpacked_dir: relUnpackedDir(id, 1),
        size_bytes: extraction.sizeBytes,
        checksum: extraction.checksum,
        ts,
      });
    });
    tx();
  } catch (err) {
    safeRemove(path.join(UPLOADS_ROOT, id));
    console.error('[adminAvatars] create transaction failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to persist avatar' });
  }

  return res.status(201).json({ avatar: serializeAvatar(getAvatar.get(id)) });
});

// ---- POST /admin/avatars/:id/assets : append a new version ----
router.post('/:id/assets', adminAuthMiddleware, handleZipUpload, (req, res) => {
  const { id } = req.params;
  const avatar = getAvatar.get(id);
  if (!avatar) {
    return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  }
  if (avatar.status === 'archived') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: 'Cannot upload assets to an archived avatar' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ code: 'avatar_zip_invalid', error: 'zip file field is required' });
  }

  const version = avatar.current_version + 1;
  const vDir = versionDir(id, version);
  const unpacked = path.join(vDir, 'unpacked');

  let extraction;
  try {
    extraction = validateAndExtractZip(req.file.buffer, unpacked);
  } catch (err) {
    safeRemove(vDir);
    if (err.isZipError) {
      return res.status(zipErrorStatus(err.code)).json({ code: err.code, error: err.message });
    }
    console.error('[adminAvatars] extraction failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to process zip' });
  }

  try {
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'bundle.zip'), req.file.buffer);

    const ts = nowSec();
    const tx = db.transaction(() => {
      insertAsset.run({
        avatar_id: id,
        version,
        zip_path: relZipPath(id, version),
        unpacked_dir: relUnpackedDir(id, version),
        size_bytes: extraction.sizeBytes,
        checksum: extraction.checksum,
        ts,
      });
      updateAvatarVersion.run({ id, version, model_entry: extraction.modelEntry, ts });
      // 本机版:Aiboo 这里还会把漫画视觉基准标过期(comic-store),本机没有漫画,删掉。
    });
    tx();
  } catch (err) {
    safeRemove(vDir);
    console.error('[adminAvatars] asset transaction failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to persist new version' });
  }

  return res.status(201).json({
    version,
    checksum: extraction.checksum,
    size_bytes: extraction.sizeBytes,
  });
});

// ---- POST /admin/avatars/:id/assets/restore : 从历史版本恢复并生成新版本 ----
// 语义：回滚不是删除/覆盖历史，而是把 source_version 的 bundle.zip + unpacked
// 复制成 current_version + 1 的新版本，再把 avatars.current_version / model_entry
// 切过去。恢复当前版本无意义，明确拒绝（409 restore_source_is_current）。
router.post('/:id/assets/restore', adminAuthMiddleware, (req, res) => {
  const { id } = req.params;
  const avatar = getAvatar.get(id);
  if (!avatar) {
    return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  }
  if (avatar.status === 'archived') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: 'Cannot restore assets of an archived avatar' });
  }

  const sourceVersion = req.body?.source_version;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) {
    return res.status(400).json({ code: 'invalid_source_version', error: 'source_version must be a positive integer' });
  }
  if (sourceVersion === avatar.current_version) {
    return res.status(409).json({ code: 'restore_source_is_current', error: `当前已经是 v${sourceVersion}，无需恢复` });
  }

  const source = getAsset.get(id, sourceVersion);
  if (!source) {
    return res.status(404).json({ code: 'asset_version_not_found', error: `Version v${sourceVersion} not found for this avatar` });
  }

  const restoreReason =
    typeof req.body?.restore_reason === 'string' ? req.body.restore_reason.trim().slice(0, 200) || null : null;

  const version = avatar.current_version + 1;
  const srcDir = versionDir(id, sourceVersion);
  const vDir = versionDir(id, version);

  // 复制文件先于写库：复制失败不动 DB；写库失败清理新目录，避免
  // 「DB 指向不存在文件」或「目录残留但 DB 没记录」的不一致。
  let bundle;
  try {
    bundle = fs.readFileSync(path.join(srcDir, 'bundle.zip'));
  } catch (err) {
    console.error(`[adminAvatars] restore: source bundle unreadable for ${id} v${sourceVersion}:`, err);
    return res.status(500).json({ code: 'internal_error', error: 'Source version files are missing' });
  }
  // model_entry 直接从源包字节重新解析（与上传时同一选择规则），不依赖解压目录里的猜测。
  const modelEntry = findModelEntry(bundle);
  if (!modelEntry) {
    console.error(`[adminAvatars] restore: no model entry in bundle for ${id} v${sourceVersion}`);
    return res.status(500).json({ code: 'internal_error', error: 'Source version bundle is corrupt' });
  }

  try {
    if (fs.existsSync(vDir)) {
      // 版本号单调递增，DB 不可能已有 version 行；目录只可能是历史失败残留，清理后重建。
      console.warn(`[adminAvatars] restore: removing leftover dir ${vDir}`);
      safeRemove(vDir);
    }
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'bundle.zip'), bundle);
    fs.cpSync(path.join(srcDir, 'unpacked'), path.join(vDir, 'unpacked'), { recursive: true });
  } catch (err) {
    safeRemove(vDir);
    console.error('[adminAvatars] restore copy failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to copy version files' });
  }

  try {
    const ts = nowSec();
    const tx = db.transaction(() => {
      insertRestoredAsset.run({
        avatar_id: id,
        version,
        zip_path: relZipPath(id, version),
        unpacked_dir: relUnpackedDir(id, version),
        size_bytes: bundle.length,
        checksum: sha256Hex(bundle),
        restore_source_version: sourceVersion,
        restore_reason: restoreReason,
        ts,
      });
      updateAvatarVersion.run({ id, version, model_entry: modelEntry, ts });
    });
    tx();
  } catch (err) {
    safeRemove(vDir);
    console.error('[adminAvatars] restore transaction failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to persist restored version' });
  }

  return res.status(201).json({
    version,
    restored_from: sourceVersion,
    checksum: sha256Hex(bundle),
    size_bytes: bundle.length,
    model_entry: modelEntry,
  });
});

// ---- POST /admin/avatars/:id/assets/:version/reextract : 用原 bundle.zip 按当前规则重新解压覆盖 unpacked/ ----
// 用途:2026-09-16 之前上传的 Windows(GBK 条目名)包解出乱码文件名,不用重传,重新解压即可修好。
// 语义:不生成新版本、不动 bundle.zip;先解到同目录的临时目录,成功后原子换掉 unpacked/,失败保留原目录。
// 若该版本是当前版本,同步更新 avatars.model_entry。只接受本机回环请求。
router.post('/:id/assets/:version/reextract', adminAuthMiddleware, (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ code: 'loopback_only', error: 'Re-extract is only allowed from localhost' });
  }
  const { id } = req.params;
  const avatar = getAvatar.get(id);
  if (!avatar) {
    return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  }
  if (!/^[1-9]\d{0,6}$/.test(String(req.params.version))) {
    return res.status(400).json({ code: 'invalid_version', error: 'version must be a positive integer' });
  }
  const version = Number(req.params.version);
  const asset = getAsset.get(id, version);
  if (!asset) {
    return res.status(404).json({ code: 'asset_version_not_found', error: `Version v${version} not found for this avatar` });
  }

  const vDir = versionDir(id, version);
  const unpacked = path.join(vDir, 'unpacked');
  let bundle;
  try {
    bundle = fs.readFileSync(path.join(vDir, 'bundle.zip'));
  } catch (err) {
    console.error(`[adminAvatars] reextract: bundle unreadable for ${id} v${version}:`, err);
    return res.status(500).json({ code: 'internal_error', error: 'Version bundle.zip is missing' });
  }
  const checksum = sha256Hex(bundle);
  if (asset.checksum && checksum !== asset.checksum) {
    return res.status(409).json({ code: 'bundle_checksum_mismatch', error: 'bundle.zip on disk does not match the recorded checksum' });
  }

  const stamp = Date.now();
  const tmpDir = path.join(vDir, `unpacked.tmp-${stamp}`);
  const oldDir = path.join(vDir, `unpacked.old-${stamp}`);
  let extraction;
  try {
    extraction = validateAndExtractZip(bundle, tmpDir);
  } catch (err) {
    safeRemove(tmpDir);
    if (err.isZipError) {
      return res.status(zipErrorStatus(err.code)).json({ code: err.code, error: err.message });
    }
    console.error('[adminAvatars] reextract failed:', err);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to re-extract zip' });
  }

  // 换目录:旧 unpacked → old,tmp → unpacked;任一步失败尽量回滚,原目录不丢。
  try {
    if (fs.existsSync(unpacked)) fs.renameSync(unpacked, oldDir);
    fs.renameSync(tmpDir, unpacked);
  } catch (err) {
    console.error('[adminAvatars] reextract swap failed:', err);
    try {
      if (!fs.existsSync(unpacked) && fs.existsSync(oldDir)) fs.renameSync(oldDir, unpacked);
    } catch (rollbackErr) {
      console.error('[adminAvatars] reextract rollback failed:', rollbackErr);
    }
    safeRemove(tmpDir);
    return res.status(500).json({ code: 'internal_error', error: 'Failed to replace unpacked directory' });
  }
  safeRemove(oldDir);

  const current = avatar.current_version === version;
  if (current && avatar.model_entry !== extraction.modelEntry) {
    updateAvatarVersion.run({ id, version, model_entry: extraction.modelEntry, ts: nowSec() });
  }

  return res.json({
    version,
    model_entry: extraction.modelEntry,
    extracted_files: extraction.extractedFiles.length,
    checksum,
    current,
  });
});

// ---- state machine: publish / unpublish / archive / delete ----
router.post('/:id/publish', adminAuthMiddleware, (req, res) => {
  const avatar = getAvatar.get(req.params.id);
  if (!avatar) return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  if (avatar.status !== 'draft') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: `Cannot publish from status '${avatar.status}'` });
  }
  // 审计身份取自 adminAuth 注入的 req.admin(本机固定为 ben),绝不采信请求体。
  const by = req.admin?.username || String(req.admin?.id ?? '');
  // 本机版:Aiboo 发布时还会幂等创建默认旅程实例(journey-engine),本机没有旅程,删掉;
  // 响应里也不再有 journey_instance 字段。
  publishAvatarAudit.run({ id: avatar.id, by, ts: nowSec() });
  return res.json({ avatar: serializeAvatar(getAvatar.get(avatar.id)) });
});

// ---- POST /admin/avatars/:id/unpublish：已发布角色取消发布 → draft ----
// 不物理删除角色/版本/历史/审计；取消发布后该角色立即对用户端不可用，可再次 publish 恢复。
router.post('/:id/unpublish', adminAuthMiddleware, (req, res) => {
  const avatar = getAvatar.get(req.params.id);
  if (!avatar) return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  if (avatar.status !== 'published') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: `Cannot unpublish from status '${avatar.status}'` });
  }
  const by = req.admin?.username || String(req.admin?.id ?? '');
  unpublishAvatarAudit.run({ id: avatar.id, by, ts: nowSec() });
  // 本机版:Aiboo 这里会失活旅程实例,本机没有旅程,删掉。
  return res.json({ avatar: serializeAvatar(getAvatar.get(avatar.id)) });
});

router.post('/:id/archive', adminAuthMiddleware, (req, res) => {
  const avatar = getAvatar.get(req.params.id);
  if (!avatar) return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  if (avatar.status !== 'published') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: `Cannot archive from status '${avatar.status}'` });
  }
  updateAvatarStatus.run({ id: avatar.id, status: 'archived', ts: nowSec() });
  return res.json({ avatar: serializeAvatar(getAvatar.get(avatar.id)) });
});

router.delete('/:id', adminAuthMiddleware, (req, res) => {
  const avatar = getAvatar.get(req.params.id);
  if (!avatar) return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  if (avatar.status !== 'archived') {
    return res.status(409).json({ code: 'avatar_state_conflict', error: 'Only archived avatars can be deleted' });
  }

  // DB delete first (transaction); file delete is best-effort and does not roll back the DB.
  const tx = db.transaction(() => {
    deleteAssets.run(avatar.id);
    deleteAvatar.run(avatar.id);
  });
  tx();

  safeRemove(path.join(UPLOADS_ROOT, avatar.id));
  return res.json({ deleted: true, id: avatar.id });
});

// ---- GET /admin/avatars/:id/preview-url : 返回带短时签名的预览基址（鉴权） ----
router.get('/:id/preview-url', adminAuthMiddleware, (req, res) => {
  const avatar = getAvatar.get(req.params.id);
  if (!avatar) {
    return res.status(404).json({ code: 'avatar_not_found', error: 'Avatar not found' });
  }
  if (!avatar.current_version || avatar.current_version < 1) {
    return res.status(409).json({ code: 'avatar_no_version', error: 'Avatar has no uploaded version' });
  }
  const token = signPreviewToken(avatar.id, avatar.current_version);
  const baseUrl = `/admin/avatars/${avatar.id}/preview/${token}`;
  return res.json({
    baseUrl,
    modelEntry: avatar.model_entry,
    // 已编码的完整模型 URL:前端直接交给 Live2D 加载器,不要再 encode 一次。
    modelUrl: `${baseUrl}/${encodePathSegments(avatar.model_entry)}`,
    version: avatar.current_version,
  });
});

// ---- GET /admin/avatars/:id/preview/:token/*splat : 免鉴权头静态服务，靠签名放行 ----
router.get('/:id/preview/:token/*splat', (req, res) => {
  const { id, token } = req.params;
  const verdict = verifyPreviewToken(token, id);
  if (!verdict.ok) {
    return res.status(403).json({ code: 'preview_token_invalid', error: 'Invalid or expired preview token' });
  }
  // Express 5 已对每一段做过 decodeURIComponent(%E7%88%B1 → 爱,%2F → /),这里不再解码,
  // 否则名字里本来就有 % 的文件会被解坏。通配段可能是数组或字符串,防御式归一。
  const splat = req.params.splat ?? req.params[0] ?? '';
  const rel = Array.isArray(splat) ? splat.join('/') : String(splat);
  const root = path.join(versionDir(id, verdict.version), 'unpacked');
  // 解码后的路径不许越出 unpacked/:拒绝 NUL、空段、.. 段(含反斜杠写法)与绝对路径,再用 resolve 兜底。
  const segments = rel.replace(/\\/g, '/').split('/');
  const resolved = path.resolve(root, rel);
  if (
    rel.includes('\0') ||
    rel.startsWith('/') ||
    segments.some((seg) => seg === '..' || seg === '') ||
    (resolved !== root && !resolved.startsWith(root + path.sep))
  ) {
    return res.status(400).json({ code: 'preview_path_invalid', error: 'Preview path escapes the unpacked directory' });
  }
  return res.sendFile(rel, { root, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) {
      const status = err.status === 403 ? 403 : 404;
      res.status(status).json({ code: 'preview_file_not_found', error: 'Preview file not found' });
    }
  });
});

module.exports = router;
