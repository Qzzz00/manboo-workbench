'use strict';

// 来源:Aiboo origin/main 1f430c3f server/routes/admin/rtcProviders.cjs
// 类型化「实时通话(RTC)」provider 库 admin 路由（volcengine_rtc）。
// payload 与 ttsProviders 一致：{ name, provider_type, config, isDefault }。

const express = require('express');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const { db } = require('../../db.cjs');
const rtcProviderStore = require('../../services/rtcProviderStore.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');

const router = express.Router();

function sendError(res, err) {
  if (err && err.code === 'rtc_provider_not_found') {
    return res.status(404).json({ code: 'rtc_provider_not_found', error: err.message });
  }
  if (err && err.code === 'invalid_rtc_provider') {
    return res.status(400).json({ code: 'invalid_rtc_provider', error: err.message });
  }
  return res.status(500).json({ code: 'internal_error', error: 'Internal server error' });
}

// 暴露各类型的字段定义，供前端动态渲染表单。
router.get('/types', adminAuthMiddleware, (req, res) => {
  const types = Object.fromEntries(
    Object.entries(rtcProviderStore.TYPES).map(([k, v]) => [
      k,
      { fields: v.fields, required: v.required, secrets: v.secrets },
    ]),
  );
  res.json({ types });
});

router.get('/', adminAuthMiddleware, (req, res) => {
  try {
    res.json({ models: rtcProviderStore.list(db) });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/', adminAuthMiddleware, (req, res) => {
  try {
    const b = req.body || {};
    const model = rtcProviderStore.create(db, {
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
    res.json({ model: rtcProviderStore.update(db, req.params.id, req.body || {}) });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', adminAuthMiddleware, (req, res) => {
  try {
    const usage = avatarVoiceStore.countProviderUsage(db, req.params.id);
    if (usage.count > 0) {
      return res.status(409).json({
        code: 'rtc_provider_in_use',
        error: `该 RTC provider 仍被 ${usage.avatarIds.length} 个角色音色绑定引用，请先改派后再删除`,
        avatarIds: usage.avatarIds,
      });
    }
    const { id } = rtcProviderStore.remove(db, req.params.id);
    res.json({ deleted: true, id });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
