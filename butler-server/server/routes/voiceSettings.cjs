'use strict';

// 来源:Aiboo origin/main 1f430c3f server/routes/voiceSettings.cjs
// 音色同步配置 admin 路由（ALL-605 Wave 1）。
//   PUT    /api/voice-settings                        保存同步模式 + 源音色
//   GET    /api/voice-settings/:avatarId              读某角色最终两侧音色配置
//   GET    /api/voice-mappings                        列逻辑音色映射
//   PUT    /api/voice-mappings/:logicalVoiceId        新增/更新逻辑音色映射
//   DELETE /api/voice-mappings/:logicalVoiceId        删除逻辑音色映射
//   POST   /api/voice-mappings/resolve                按一侧音色反查两侧最终配置
// 鉴权沿用现有 admin 音色绑定端点（adminAuthMiddleware），不改变权限体系。
// 见 docs/voice-sync-contract.md。

const express = require('express');
const { adminAuthMiddleware } = require('../middleware/adminAuth.cjs');
const { db } = require('../db.cjs');
const voiceSyncStore = require('../services/voiceSyncStore.cjs');

const router = express.Router();

function sendError(res, err) {
  const code = err?.code || 'internal_error';
  if (code === 'avatar_not_found') {
    return res.status(404).json({ code, error: err.message });
  }
  if (code === 'VOICE_MAPPING_NOT_FOUND') {
    return res.status(400).json({ code, error: err.message });
  }
  if (
    code === 'invalid_voice_sync_mode' ||
    code === 'invalid_voice_ref' ||
    code === 'voice_provider_not_found' ||
    code === 'voice_not_found' ||
    code === 'invalid_mapping' ||
    code === 'mapping_conflict'
  ) {
    return res.status(400).json({ code, error: err.message });
  }
  return res.status(500).json({ code: 'internal_error', error: 'Internal server error' });
}

router.put('/api/voice-settings', adminAuthMiddleware, (req, res) => {
  try {
    const body = req.body || {};
    const settings = voiceSyncStore.saveVoiceSettings(db, {
      avatarId: body.avatar_id,
      voiceSyncMode: body.voice_sync_mode,
      baseVoice: body.base_voice,
      rtcVoice: body.rtc_voice,
    });
    return res.json({ voice_settings: settings });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/api/voice-settings/:avatarId', adminAuthMiddleware, (req, res) => {
  const settings = voiceSyncStore.getVoiceSettings(db, req.params.avatarId);
  if (!settings) {
    return res.status(404).json({ code: 'avatar_not_found', error: `avatar ${req.params.avatarId} not found` });
  }
  return res.json({ voice_settings: settings });
});

router.get('/api/voice-mappings', adminAuthMiddleware, (_req, res) => {
  return res.json({ mappings: voiceSyncStore.listMappings(db) });
});

router.put('/api/voice-mappings/:logicalVoiceId', adminAuthMiddleware, (req, res) => {
  try {
    const mapping = voiceSyncStore.upsertMapping(db, {
      logical_voice_id: req.params.logicalVoiceId,
      base_voice: req.body?.base_voice,
      rtc_voice: req.body?.rtc_voice,
      enabled: req.body?.enabled,
    });
    return res.json({ mapping });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/api/voice-mappings/:logicalVoiceId', adminAuthMiddleware, (req, res) => {
  voiceSyncStore.removeMapping(db, req.params.logicalVoiceId);
  return res.json({ deleted: true, logical_voice_id: req.params.logicalVoiceId });
});

router.post('/api/voice-mappings/resolve', adminAuthMiddleware, (req, res) => {
  try {
    const side = req.body?.side === 'rtc' ? 'rtc' : 'base';
    const ref = voiceSyncStore.normalizeVoiceRef(req.body?.voice, 'voice');
    const mapping = voiceSyncStore.resolveMapping(db, side, ref.provider_id, ref.voice_id);
    if (!mapping) {
      return res.status(400).json({ code: 'VOICE_MAPPING_NOT_FOUND', error: '当前音色没有可用的逻辑音色映射' });
    }
    return res.json({ mapping });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
