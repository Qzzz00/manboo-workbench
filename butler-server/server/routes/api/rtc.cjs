'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/routes/rtc.cjs(本机版改写)
//
//   GET  /api/rtc/status                                      → { configured, reason? }           配了通话供应商没有(一个密钥字段都不回)
//   POST /api/rtc/token  {}                                   → { appId, roomId, userId, token }  进房 token(AppKey 只在服务端)
//   POST /api/rtc/start  { roomId, userId, avatarId?, voice?, systemMessage?, welcomeMessage?, tools?, functionCalling? }
//                                                             → { taskId, botUserId, result }      让火山智能体(ASR+LLM+TTS)进房
//   POST /api/rtc/stop   { roomId, taskId }                   → { stopped, result | alreadySettled, durationSeconds }
//   POST /api/rtc/function-result { roomId, taskId, toolCallId, content }
//                                                             → { ok }                             把工具结果回填给通话里的智能体
//
// 与 Aiboo 的差别:
//   - 用户体系没了:userId 前缀用设备 id(工作台 8791 转发时的 X-Workbench-Device 头;本机回环记 'local'),通话记录按它落;
//   - 旅程/来源路由/生命体征/场景工具/视觉(vision)/行为账,整段删掉:systemMessage 就是客户端给的
//     (事务官的人设由工作台 → 手机传,不在这里长);
//   - Function Calling(2026-09-17 复活,但换了位置):工具清单与回调地址**都由工作台给**,这里只做透传与校验。
//     「记一件事项」要落到工作台的看板上,回调自然也该由工作台收——后端不认识事项,也不该认识。
//     Url 与 Signature 缺一不下发 FunctionCallingConfig(半配等于没配,不留一条只发不收的链路);
//   - 没有默认 RTC 供应商或缺 appId/appKey → 503 + 人话「未配置语音供应商密钥」;
//   - 未发布的形象不能通话(409),与 Aiboo 同;
//   - 上游失败 → 502,只给一句人话;原文经 redact() 进日志。
// 通话本身在手机与火山 RTC 之间直连,不经过工作台,所以这里也不需要 WebSocket 转发。

const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../../db.cjs');
const { adminAuthMiddleware } = require('../../middleware/adminAuth.cjs');
const volcengineRtc = require('../../services/volcengineRtc.cjs');
const avatarVoiceStore = require('../../services/avatarVoiceStore.cjs');
const avatarStore = require('../../services/avatarStore.cjs');
const callRecordStore = require('../../services/callRecordStore.cjs');
const { NOT_CONFIGURED, resolveRtcProvider, redact } = require('../../services/voiceCredentials.cjs');

const router = express.Router();
const parseJson = express.json({ limit: '256kb' });

function deviceIdOf(req) {
  const h = req.headers['x-workbench-device'];
  const v = Array.isArray(h) ? h[0] : h;
  const s = typeof v === 'string' ? v.trim() : '';
  // 只留安全字符,免得设备 id 混进 userId 后火山那边不认。
  return s ? s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : 'local';
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * 配了通话供应商没有。**只回一个 true/false 加一句人话**,不回 provider 名字、不回任何字段值——
 * 手机拿它来决定通话入口灰不灰,不需要知道别的(没配时手机显示「电脑上还没配通话供应商」,不弹错误栈)。
 */
router.get('/rtc/status', adminAuthMiddleware, (req, res) => {
  const provider = resolveRtcProvider(db);
  if (!provider) return res.json({ configured: false, reason: NOT_CONFIGURED.error });
  return res.json({ configured: true });
});

router.post('/rtc/token', adminAuthMiddleware, parseJson, (req, res) => {
  const provider = resolveRtcProvider(db);
  if (!provider) return res.status(503).json(NOT_CONFIGURED);
  const { appId, appKey } = provider.config;
  const roomId = `room_${crypto.randomUUID()}`;
  const userId = `user_${deviceIdOf(req)}_${crypto.randomUUID().slice(0, 8)}`;
  try {
    const token = volcengineRtc.generateJoinToken({ appId, appKey, roomId, userId });
    return res.json({ appId, roomId, userId, token });
  } catch (error) {
    // AppId 位数不对这类是配置问题,话要给到人;但先抹掉密钥。
    console.warn('[butler-server] rtc token 签发失败', { message: redact(error && error.message, provider.config) });
    return res.status(502).json({ code: 'rtc_token_failed', error: redact((error && error.message) || 'token 签发失败', provider.config) });
  }
});

router.post('/rtc/start', adminAuthMiddleware, parseJson, async (req, res) => {
  const { roomId, userId, voice, systemMessage, welcomeMessage, avatarId, tools, functionCalling } = req.body || {};
  if (!roomId || !userId) return res.status(400).json({ code: 'invalid_request', error: '缺少 roomId / userId' });
  if (avatarId && avatarStore.isAvatarUnavailable(db, avatarId)) {
    return res.status(409).json({ code: 'avatar_unavailable', error: '这个形象还没发布,不能通话' });
  }
  const provider = resolveRtcProvider(db);
  if (!provider) return res.status(503).json(NOT_CONFIGURED);

  // 音色按形象 × rtc 场景解析(火山 RTC 命名空间):绑定权威;无绑定回落客户端值或默认音色。
  let effectiveVoice = voice;
  try {
    const resolvedRtc = avatarVoiceStore.resolveVoice(db, avatarId || undefined, 'rtc');
    effectiveVoice = resolvedRtc && resolvedRtc.source === 'binding' ? resolvedRtc.voiceId : (voice || (resolvedRtc && resolvedRtc.voiceId));
  } catch {
    effectiveVoice = voice;
  }

  // 工具与回调:两者都由工作台给(它才认识事项)。Url+Signature 齐了才算数,半配当没配。
  const effectiveTools = Array.isArray(tools) && tools.length ? tools : undefined;
  const fc = functionCalling && typeof functionCalling === 'object' ? functionCalling : {};
  const effectiveFunctionCalling =
    typeof fc.serverMessageUrl === 'string' && fc.serverMessageUrl !== ''
      && typeof fc.serverMessageSignature === 'string' && fc.serverMessageSignature !== ''
      ? { serverMessageUrl: fc.serverMessageUrl, serverMessageSignature: fc.serverMessageSignature }
      : undefined;

  const taskId = `task_${crypto.randomUUID()}`;
  const botUserId = `bot_${crypto.randomUUID().slice(0, 8)}`;
  try {
    const result = await volcengineRtc.startVoiceChat({
      config: provider.config,
      roomId,
      userId,
      taskId,
      botUserId,
      voice: effectiveVoice,
      systemMessage: typeof systemMessage === 'string' ? systemMessage : undefined,
      welcomeMessage: typeof welcomeMessage === 'string' ? welcomeMessage : undefined,
      visionEnable: false,
      ...(effectiveTools === undefined ? {} : { tools: effectiveTools }),
      ...(effectiveFunctionCalling === undefined ? {} : { functionCalling: effectiveFunctionCalling }),
    });
    try {
      callRecordStore.createCallRecord(db, { deviceId: deviceIdOf(req), avatarId, roomId, taskId, startedAt: nowSec() });
    } catch (err) {
      console.error('[butler-server] call_records 插入失败:', err && err.message);
    }
    return res.json({ taskId, botUserId, result });
  } catch (error) {
    console.warn('[butler-server] StartVoiceChat 失败', { roomId, message: redact(error && error.message, provider.config) });
    return res.status(502).json({ code: 'rtc_start_failed', error: redact((error && error.message) || '通话没接通', provider.config) });
  }
});

router.post('/rtc/stop', adminAuthMiddleware, parseJson, async (req, res) => {
  const { roomId, taskId } = req.body || {};
  if (!roomId || !taskId) return res.status(400).json({ code: 'invalid_request', error: '缺少 roomId / taskId' });
  const provider = resolveRtcProvider(db);
  if (!provider) return res.status(503).json(NOT_CONFIGURED);

  // 重复 stop 幂等:已结算的记录直接返回成功,不再调火山 stop。
  const existing = callRecordStore.getByTaskId(db, taskId);
  if (existing && existing.ended_at != null) {
    return res.json({ stopped: true, alreadySettled: true, durationSeconds: existing.duration_seconds });
  }
  try {
    const result = await volcengineRtc.stopVoiceChat({ config: provider.config, roomId, taskId });
    // 时长要回给手机:挂断那一刻界面要说「通了几分钟」,通话摘要也按它写回工作台。
    // 结算不上(记录没落成)时这个字段整个缺席,不填 0——没通就是没数,不是 0 秒。
    let durationSeconds;
    try {
      const settled = callRecordStore.settleByTaskId(db, taskId, { endedAt: nowSec(), endReason: 'normal' });
      if (settled && settled.record && settled.record.duration_seconds != null) {
        durationSeconds = settled.record.duration_seconds;
      }
    } catch (err) {
      console.error('[butler-server] 通话记录结算失败:', err && err.message);
    }
    return res.json({ stopped: true, result, ...(durationSeconds === undefined ? {} : { durationSeconds }) });
  } catch (error) {
    // 火山 stop 失败也结算为 error(通话事实已发生),避免记录悬置。
    try {
      callRecordStore.settleByTaskId(db, taskId, { endedAt: nowSec(), endReason: 'error' });
    } catch (err) {
      console.error('[butler-server] 通话记录结算失败:', err && err.message);
    }
    console.warn('[butler-server] StopVoiceChat 失败', { roomId, taskId, message: redact(error && error.message, provider.config) });
    return res.status(502).json({ code: 'rtc_stop_failed', error: '通话没能正常挂断,请稍后再试' });
  }
});

/**
 * 把一次工具调用的结果回填给通话里的智能体(火山 UpdateVoiceChat,Command='function')。
 *
 * 火山把 tool_calls POST 给**工作台**(它才认识事项),工作台办完之后要把「办没办成」交回给
 * 智能体,好让她在电话里亲口说出来。回填这一步必须用 AK/SK 签名,所以只能在这边做。
 * 门还是 adminAuth:回环或工作台令牌——密钥不出这台机器。
 */
router.post('/rtc/function-result', adminAuthMiddleware, parseJson, async (req, res) => {
  const { roomId, taskId, toolCallId, content } = req.body || {};
  if (!roomId || !taskId || !toolCallId) {
    return res.status(400).json({ code: 'invalid_request', error: '缺少 roomId / taskId / toolCallId' });
  }
  const provider = resolveRtcProvider(db);
  if (!provider) return res.status(503).json(NOT_CONFIGURED);
  try {
    const result = await volcengineRtc.sendAigcCommand({
      config: provider.config,
      roomId,
      taskId,
      command: 'function',
      message: JSON.stringify({ ToolCallID: String(toolCallId), Content: typeof content === 'string' ? content : '' }),
    });
    return res.json({ ok: true, result });
  } catch (error) {
    console.warn('[butler-server] 工具结果回填失败', { roomId, taskId, message: redact(error && error.message, provider.config) });
    return res.status(502).json({ code: 'rtc_function_result_failed', error: '工具结果没能回填给通话' });
  }
});

module.exports = router;
module.exports.deviceIdOf = deviceIdOf;
