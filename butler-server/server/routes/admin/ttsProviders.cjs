'use strict';

// 来源:Aiboo origin/main 1f430c3f server/routes/admin/ttsProviders.cjs
// 类型化 TTS provider 库 admin 路由（dashscope | volcengine）。
// 与通用 modelProviders.cjs 不同：payload 是 { name, provider_type, config, isDefault }。

const express = require('express');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const { db } = require('../../db.cjs');
const ttsProviderStore = require('../../services/ttsProviderStore.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');

const router = express.Router();

function sendError(res, err) {
  if (err && err.code === 'tts_provider_not_found') {
    return res.status(404).json({ code: 'tts_provider_not_found', error: err.message });
  }
  if (err && err.code === 'invalid_tts_provider') {
    return res.status(400).json({ code: 'invalid_tts_provider', error: err.message });
  }
  return res.status(500).json({ code: 'internal_error', error: 'Internal server error' });
}

// 暴露各类型的字段定义，供前端动态渲染表单。
router.get('/types', adminAuthMiddleware, (req, res) => {
  const types = Object.fromEntries(
    Object.entries(ttsProviderStore.TYPES).map(([k, v]) => [
      k,
      { fields: v.fields, required: v.required, secrets: v.secrets },
    ]),
  );
  res.json({ types });
});

router.get('/', adminAuthMiddleware, (req, res) => {
  try {
    res.json({ models: ttsProviderStore.list(db) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', adminAuthMiddleware, (req, res) => {
  try {
    const b = req.body || {};
    const model = ttsProviderStore.create(db, {
      name: b.name,
      provider_type: b.provider_type,
      config: b.config,
      isDefault: b.isDefault,
    });
    res.status(201).json({ model });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch('/:id', adminAuthMiddleware, (req, res) => {
  try {
    res.json({ model: ttsProviderStore.update(db, req.params.id, req.body || {}) });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', adminAuthMiddleware, (req, res) => {
  try {
    // 占用保护：仍被角色音色绑定引用时拒删，避免解析时落到被删 provider。
    const usage = avatarVoiceStore.countProviderUsage(db, req.params.id);
    if (usage.count > 0) {
      return res.status(409).json({
        code: 'tts_provider_in_use',
        error: `该 TTS provider 仍被 ${usage.avatarIds.length} 个角色音色绑定引用，请先改派后再删除`,
        avatarIds: usage.avatarIds,
      });
    }
    const { id } = ttsProviderStore.remove(db, req.params.id);
    res.json({ deleted: true, id });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
