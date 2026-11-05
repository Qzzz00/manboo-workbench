'use strict';

// 事务官本机后端(butler-server)的 Express 应用装配。
//
// 路由面(与 Aiboo 同名同形,admin-ui 的 api 层一行不改):
//   /admin/avatars/*                 形象:列表/新建/编辑/上传 zip/版本/发布/预览
//   /admin/tts-models/*              TTS 供应商库(火山 / MiniMax / DashScope)
//   /admin/rtc-providers/*           RTC 供应商库(只留密钥配置,不做通话)
//   /admin/tts-voices, /preview      音色目录与试听
//   /api/voice-settings, /api/voice-mappings  音色同步与逻辑音色映射
//   /api/voices/preview, /api/voices/preview-audio/:id/:token  后台试听(routes/voicePreview.cjs)
//   GET /api/voices, PUT /api/voices/current   电话里换音色(2026-09-23;routes/api/callVoice.cjs)
//   手机公开接口(2026-09-14,手机经工作台 8791 的 /butler/proxy/* 进来,8791 认设备令牌、带 X-Workbench-Token 与 X-Workbench-Device 转发):
//   /api/avatars, /api/avatars/:id, /api/avatars/:id/bundle.zip   已发布形象与 Live2D 包(routes/api/avatars.cjs)
//   /api/tts                         文本 → 音频(routes/api/tts.cjs)
//   /api/tts/stream                  文本 → **边合边发**的音频帧流(routes/api/ttsStream.cjs;通道层工人专用,冲着首包延迟去的)
//   /api/asr                         一段 wav → 文字(routes/api/asr.cjs;HTTP POST,不是 WebSocket)
//   /api/rtc/status                  配了通话供应商没有(只回 true/false,不回密钥)
//   /api/rtc/token|start|stop        火山 RTC 进房 token 与智能体启停(routes/api/rtc.cjs)
//   /api/rtc/function-result         通话中把工具结果回填给智能体(工作台办完事项后调)
//   /uploads/*                       背景/头像/铃声静态文件
//   /health                          运行状态(工作台 /state.butler 用;只有数字,没有密钥)
//   /admin/                          admin-ui 构建产物(HashRouter,所以 /admin/avatars 这类路径不会和 API 撞)
//
// 鉴权全部走 middleware/adminAuth.cjs:本机回环放行,或带 X-Workbench-Token。

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const { db, UPLOADS_BASE } = require('./db.cjs');
const { adminAuthMiddleware } = require('./middleware/adminAuth.cjs');
// chat 场景的音色解析:与 /api/tts 同一个函数(见下面 chatVoice 的注释)。
const avatarVoiceStore = require('./services/avatarVoiceStore.cjs');
const voiceCredentials = require('./services/voiceCredentials.cjs');

const ADMIN_UI_DIR = process.env.BUTLER_ADMIN_UI_DIR
  ? path.resolve(process.env.BUTLER_ADMIN_UI_DIR)
  : path.join(__dirname, '..', 'admin-ui', 'dist');

function countRows(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return undefined;
  }
}

/**
 * chat 场景此刻解析出来的音色 id(2026-09-22)。
 *
 * 为什么 /health 要有它:缓冲语那七句在手机上是**按音色缓存**的
 * (butler-app/src/call/fillerVoiceCache.ts)。人在这台服务的配置后台里换了音色之后,
 * 没有任何东西告诉手机"嗓子换了" —— 于是电话里一半新嗓子一半旧嗓子
 * (docs/交接-0920-缓冲语本地播放.md 第六节第 1 条记着这个洞)。
 *
 * 用的是 /api/tts 里那一个 `resolveVoice`,**不另写一份解析** ——
 * 两份解析迟早会对不上,而那时手机缓存的名字就是假的。
 * 解析不出来(没配供应商)就回 undefined:/health 里那个字段缺席,不编一个默认值。
 */
function chatVoice() {
  try {
    const resolved = avatarVoiceStore.resolveVoice(db, undefined, 'chat');
    const voiceId = resolved && typeof resolved.voiceId === 'string' ? resolved.voiceId.trim() : '';
    return voiceId === '' ? undefined : voiceId;
  } catch {
    return undefined;
  }
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 手机公开接口先挂(各自带 body 解析):/api/asr 的 body 是 base64 音频(60 秒 wav ≈ 2.6MB),
  // 要自己的上限,不能被下面全局 1mb 的 express.json 先拦下。
  app.use('/api/avatars', require('./routes/api/avatars.cjs'));
  app.use('/api', require('./routes/api/tts.cjs'));
  // 流式那条**挂在 /api/tts 后面**:两条路由的路径不重叠(/tts 与 /tts/stream),
  // 老调用方拿到的东西一个字节都没变(理由见 routes/api/ttsStream.cjs 文件头)。
  app.use('/api', require('./routes/api/ttsStream.cjs'));
  app.use('/api', require('./routes/api/asr.cjs'));
  app.use('/api', require('./routes/api/rtc.cjs'));

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', adminAuthMiddleware, (req, res) => {
    const avatarCount = countRows('avatars');
    const voiceCount = countRows('avatar_voice_bindings');
    const voice = chatVoice();
    // 语音合成钥匙有没有、从哪来(2026-09-23)。**不等**工作台下发那一份:/health 是 8791 每 3 秒问一次的,
    // 而拉那一份可能要 8791 去外网问中转 —— 在这儿等就成了 8791 等 8792 等 8791。后台踢一下,下一次问就准了。
    void voiceCredentials.ensureWorkbenchCreds();
    const tts = voiceCredentials.ttsStatus(db);
    res.json({
      ok: true,
      name: 'butler-server',
      version: require('../package.json').version,
      // 给工作台「停止」兜底用:launchd 项没装时按 pid 发 SIGTERM。
      pid: process.pid,
      ...(avatarCount === undefined ? {} : { avatarCount }),
      ...(voiceCount === undefined ? {} : { voiceCount }),
      // 现在 chat 场景用的是哪个音色(2026-09-22)。解析规则与 /api/tts 完全同源
      // (resolveVoice),所以这里报的就是电话里真会听到的那个嗓子。
      // 手机按它当缓冲语的缓存键;工作台盯着它变没变。**解析不出来就缺席,不编一个默认值**。
      ...(voice === undefined ? {} : { voice }),
      // { ready, source: settings|server|none, note? } —— 没有任何密钥,只有有没有与一句能行动的人话。
      tts,
    });
  });

  /**
   * 电话里换音色(2026-09-23)。挂在全局 express.json 之后 —— PUT 那条要读 body。
   * 它只认 `/` 与 `/current`,与 routes/voicePreview.cjs 的 `/api/voices/preview`、
   * `/api/voices/preview-audio/:id/:token` 不重叠,后者照旧从下面那一行走。
   */
  app.use('/api/voices', require('./routes/api/callVoice.cjs'));

  app.use('/admin/avatars', require('./routes/admin/avatars.cjs'));
  app.use('/admin/tts-models', require('./routes/admin/ttsProviders.cjs'));
  app.use('/admin/rtc-providers', require('./routes/admin/rtcProviders.cjs'));
  app.use('/admin/tts-voices', require('./routes/admin/ttsVoices.cjs'));
  app.use(require('./routes/voiceSettings.cjs'));
  app.use(require('./routes/voicePreview.cjs'));

  // 附件静态服务:路径与 routes/admin/avatars.cjs 的写盘目录一致。
  for (const sub of ['backgrounds', 'portraits', 'ringtones']) {
    app.use(`/uploads/${sub}`, express.static(path.join(UPLOADS_BASE, sub), { maxAge: '30d', immutable: true }));
  }

  // admin-ui:构建产物托管在 /admin/。找不到 dist 就给一句人话,而不是静默 404。
  app.use('/admin', express.static(ADMIN_UI_DIR, { index: 'index.html' }));
  app.get('/admin', (req, res) => {
    if (!fs.existsSync(path.join(ADMIN_UI_DIR, 'index.html'))) {
      res.status(503).type('text/plain; charset=utf-8').send('配置后台还没构建:先跑 pnpm -C butler-server/admin-ui build');
      return;
    }
    res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'));
  });
  app.get('/', (req, res) => res.redirect('/admin/'));

  // 兜底:JSON 404,别把 express 默认的 HTML 页给到 axios。
  app.use((req, res) => {
    res.status(404).json({ code: 'not_found', error: `No route for ${req.method} ${req.path}` });
  });
  // multer / express.json 抛出的错误也统一成 JSON。
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error('[butler-server] unhandled:', err && err.message);
    res.status(status).json({ code: err && err.code ? String(err.code) : 'internal_error', error: (err && err.message) || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp, ADMIN_UI_DIR };
