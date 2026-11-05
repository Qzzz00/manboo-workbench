'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/services/volcengineRtc.cjs(原样)
// 本机版只用 generateJoinToken / startVoiceChat / stopVoiceChat / parseToken;updateVoiceChat / sendAigcCommand(视觉、
// 通话中指令)带着但没有路由调它们。凭据来自默认 volcengine_rtc 供应商(rtcProviderStore),不读 env。

/**
 * 火山引擎 RTC 实时对话式 AI（RTC AIGC）服务端能力：
 *  1) 进房 Token 生成（AccessToken 算法，移植自官方 rtc-aigc-demo/Server/token.js）。
 *     —— Token 用 AppKey 在服务端签发，前端绝不能持有 AppKey。
 *  2) StartVoiceChat / StopVoiceChat OpenAPI（service=rtc）——智能体 ASR+豆包+TTS 进房说话。
 *     —— 用火山 AK/SK 签名，必须在服务端调用。
 *
 * 凭据来自默认 volcengine_rtc provider（rtcProviderStore）。
 */

const crypto = require('node:crypto');
const { signedOpenAPI } = require('./volcengine.cjs');

// ── RTC OpenAPI 端点（StartVoiceChat / StopVoiceChat）────────────
// 主机名可换,见 lib/endpoints.cjs。
const RTC_OPENAPI_HOST = require('../lib/endpoints.cjs').volcRtcHost();
const RTC_OPENAPI_REGION = 'cn-north-1';
const RTC_OPENAPI_SERVICE = 'rtc';
const RTC_OPENAPI_VERSION = '2024-12-01';

// ── 通话延迟调优旋钮（真机用 [rtc-timing] 日志逐项验证后微调）─────────
// 端到端「你说完→听到回应」≈ VAD判停 + ASR尾 + LLM首字 + TTS首包 + 网络。
// 这些字段此前全没配=走火山默认；下面是 A 类高确信改动，改完需重新部署阿里云后端才生效。
const TUNING = {
  // 云端判定「你说完了」所需的静音时长(ms)。火山默认 600ms——纯空等，是端到端最肥的一段。
  // 480 稳省约120ms；体感稳后可再降到 400(再省~80ms)。⚠️ 中文别低于 350：句中喘气/思考停顿
  // (200~400ms)会被误判成说完→半句话被提前送进 LLM、答非所问。
  VAD_SILENCE_MS: 480,
  // AI 智能语义判停：开启会在语义不完整时再等约 2 秒(SilenceTime+2s)，与「尽快出声」相反。
  // 显式锁死 false，防止误开反向加延迟。
  VAD_AIVAD: false,
  // 带入豆包 LLM 的历史对话轮数上限。越多→每轮 prefill token 越多→首字越慢。
  // 单听众陪伴场景 6 轮上下文足够；防止长对话「越聊越慢」。
  LLM_HISTORY_LENGTH: 6,
  // LLM 单轮最大输出长度。语音回复本应简短，限制可缩短整句时长、加快接话(不影响首字)。
  LLM_MAX_TOKENS: 256,
  // TTS 语速。略调快=同样回复更快播完、你更快能接话(体感提速，非真首包变化)。1.15~1.25 自然不失真。
  TTS_SPEED_RATIO: 1.15,
};

// ── AccessToken（进房 Token）────────────────────────────────────
const VERSION = '001';
const APP_ID_LENGTH = 24;

const PRIVILEGES = {
  PrivPublishStream: 0,
  privPublishAudioStream: 1,
  privPublishVideoStream: 2,
  privPublishDataStream: 3,
  PrivSubscribeStream: 4,
};

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest();
}

// 小端字节缓冲，与官方 token.js 的 ByteBuf 二进制布局保持一致。
class ByteBuf {
  constructor() {
    this.buffer = Buffer.alloc(1024);
    this.position = 0;
  }
  pack() {
    const out = Buffer.alloc(this.position);
    this.buffer.copy(out, 0, 0, out.length);
    return out;
  }
  putUint16(v) {
    this.buffer.writeUInt16LE(v, this.position);
    this.position += 2;
    return this;
  }
  putUint32(v) {
    this.buffer.writeUInt32LE(v, this.position);
    this.position += 4;
    return this;
  }
  putBytes(bytes) {
    this.putUint16(bytes.length);
    bytes.copy(this.buffer, this.position);
    this.position += bytes.length;
    return this;
  }
  putString(str) {
    return this.putBytes(Buffer.from(str));
  }
  putTreeMapUInt32(map) {
    if (!map) return this.putUint16(0);
    const keys = Object.keys(map);
    this.putUint16(keys.length);
    for (const key of keys) {
      this.putUint16(Number(key));
      this.putUint32(map[key]);
    }
    return this;
  }
}

class ReadByteBuf {
  constructor(bytes) {
    this.buffer = bytes;
    this.position = 0;
  }
  getUint16() {
    const ret = this.buffer.readUInt16LE(this.position);
    this.position += 2;
    return ret;
  }
  getUint32() {
    const ret = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return ret;
  }
  getString() {
    const len = this.getUint16();
    const out = Buffer.alloc(len);
    this.buffer.copy(out, 0, this.position, this.position + len);
    this.position += len;
    return out;
  }
  getTreeMapUInt32() {
    const map = {};
    const len = this.getUint16();
    for (let i = 0; i < len; i++) {
      const key = this.getUint16();
      map[key] = this.getUint32();
    }
    return map;
  }
}

class AccessToken {
  constructor(appID, appKey, roomID, userID) {
    this.appID = appID;
    this.appKey = appKey;
    this.roomID = roomID;
    this.userID = userID;
    this.issuedAt = Math.floor(Date.now() / 1000);
    // nonce：随 token 变化即可（用于区分），用随机 uint32。
    this.nonce = crypto.randomBytes(4).readUInt32LE(0);
    this.expireAt = 0;
    this.privileges = {};
  }

  addPrivilege(privilege, expireTimestamp) {
    this.privileges[privilege] = expireTimestamp;
    if (privilege === PRIVILEGES.PrivPublishStream) {
      this.privileges[PRIVILEGES.privPublishVideoStream] = expireTimestamp;
      this.privileges[PRIVILEGES.privPublishAudioStream] = expireTimestamp;
      this.privileges[PRIVILEGES.privPublishDataStream] = expireTimestamp;
    }
  }

  expireTime(expireTimestamp) {
    this.expireAt = expireTimestamp;
  }

  packMsg() {
    return new ByteBuf()
      .putUint32(this.nonce)
      .putUint32(this.issuedAt)
      .putUint32(this.expireAt)
      .putString(this.roomID)
      .putString(this.userID)
      .putTreeMapUInt32(this.privileges)
      .pack();
  }

  serialize() {
    const bytesM = this.packMsg();
    const signature = hmacSha256(this.appKey, bytesM);
    const content = new ByteBuf().putBytes(bytesM).putBytes(signature).pack();
    return VERSION + this.appID + content.toString('base64');
  }
}

// 解析 token（仅用于自测/校验）。
function parseToken(raw) {
  if (!raw || raw.length <= VERSION.length + APP_ID_LENGTH) return null;
  if (raw.substr(0, VERSION.length) !== VERSION) return null;
  const token = new AccessToken('', '', '', '');
  token.appID = raw.substr(VERSION.length, APP_ID_LENGTH);
  const contentBuf = Buffer.from(raw.substr(VERSION.length + APP_ID_LENGTH), 'base64');
  const readbuf = new ReadByteBuf(contentBuf);
  const msg = readbuf.getString();
  token.signature = readbuf.getString();
  const msgBuf = new ReadByteBuf(msg);
  token.nonce = msgBuf.getUint32();
  token.issuedAt = msgBuf.getUint32();
  token.expireAt = msgBuf.getUint32();
  token.roomID = msgBuf.getString().toString();
  token.userID = msgBuf.getString().toString();
  token.privileges = msgBuf.getTreeMapUInt32();
  return token;
}

/**
 * 生成进房 Token。
 * @param {{appId:string, appKey:string, roomId:string, userId:string, expireSec?:number}} p
 */
function generateJoinToken({ appId, appKey, roomId, userId, expireSec = 24 * 3600 }) {
  if (!appId || !appKey) throw new Error('generateJoinToken: appId/appKey required');
  if (!roomId || !userId) throw new Error('generateJoinToken: roomId/userId required');
  // 火山 RTC AppId 固定 24 位；非 24 位多半是误填了「语音技术 App ID」。
  // 提前拦截，避免拿到看不懂的 SDK token_error。
  if (appId.length !== APP_ID_LENGTH) {
    throw new Error(
      `RTC AppId 长度应为 ${APP_ID_LENGTH} 位，当前为 ${appId.length} 位（你可能误填了语音技术 App ID）。` +
        '请到 RTC 控制台(console.volcengine.com/rtc) 应用管理取 24 位的 RTC AppId/AppKey。',
    );
  }
  const token = new AccessToken(appId, appKey, roomId, userId);
  // expireTimestamp=0：该权限不单独过期，整体有效期由 expireTime 决定（与官方 demo 一致）。
  token.addPrivilege(PRIVILEGES.PrivPublishStream, 0);
  token.addPrivilege(PRIVILEGES.PrivSubscribeStream, 0);
  token.expireTime(Math.floor(Date.now() / 1000) + expireSec);
  return token.serialize();
}

function callRtcOpenAPI(config, action, body) {
  return signedOpenAPI({
    ak: config.accessKeyId,
    sk: config.secretAccessKey,
    action,
    version: RTC_OPENAPI_VERSION,
    body,
    host: RTC_OPENAPI_HOST,
    region: RTC_OPENAPI_REGION,
    service: RTC_OPENAPI_SERVICE,
  });
}

// OpenAPI 间接层：默认走真实签名调用；测试可用 __setOpenAPI 覆写以捕获请求体。
// __setOpenAPI(fn) 用 (action, body) => ... 覆写，并返回 restore 函数用于复原。
let openAPIImpl = (config, action, body) => callRtcOpenAPI(config, action, body);
function __setOpenAPI(fn) {
  const prev = openAPIImpl;
  openAPIImpl = (config, action, body) => fn(action, body);
  return function restore() { openAPIImpl = prev; };
}

/**
 * 启动智能体（StartVoiceChat）。
 * @param {object} p
 * @param {object} p.config        默认 volcengine_rtc provider 的明文 config
 * @param {string} p.roomId
 * @param {string} p.userId        真人用户的 userId（智能体面向的 TargetUserId）
 * @param {string} p.taskId        本次会话 TaskId（停止时需一致）
 * @param {string} p.botUserId     智能体在房间内的 userId
 * @param {string} p.voice         TTS 音色（每角色配置）
 * @param {string} p.systemMessage 角色人设（LLM SystemMessages）
 * @param {string} [p.welcomeMessage]
 */
function startVoiceChat({ config, roomId, userId, taskId, botUserId, voice, systemMessage, welcomeMessage, visionEndpointId, visionEnable = false, tools, functionCalling }) {
  const { appId, asrAppId, asrAccessToken, asrApiResourceId, ttsAppId, ttsCluster, arkEndpointId } = config || {};
  if (!asrAppId) throw new Error('RTC provider 缺少 asrAppId（ASR App ID）');
  if (!ttsAppId) throw new Error('RTC provider 缺少 ttsAppId（TTS App ID）');
  if (!arkEndpointId) throw new Error('RTC provider 缺少 arkEndpointId（方舟 LLM 接入点）');
  if (!voice) throw new Error('通话缺少 TTS 音色（请在角色编辑页配置音色）');

  // 复刻音色(S_*)必须走 volcano_icl，公版音色走 volcano_tts（与直接 TTS 同逻辑）。
  const isCloned = /^S_/i.test(voice);
  const cluster = isCloned ? 'volcano_icl' : ttsCluster || 'volcano_tts';

  // ASR：填了 AccessToken → 大模型流式(豆包 Doubao Seed ASR，Mode=bigmodel)；
  // 否则回落小模型(smallmodel + volcengine_streaming_common)。
  const asrProviderParams = asrAccessToken
    ? {
        Mode: 'bigmodel',
        AppId: asrAppId,
        AccessToken: asrAccessToken,
        // 大模型流式 ASR 必填，2=双向流式（官方推荐）。
        StreamMode: 2,
        ...(asrApiResourceId ? { ApiResourceId: asrApiResourceId } : {}),
      }
    : { Mode: 'smallmodel', AppId: asrAppId, Cluster: 'volcengine_streaming_common' };
  console.info('[rtc] StartVoiceChat', {
    tts: { voice, cluster, ttsAppId, speed: TUNING.TTS_SPEED_RATIO },
    asr: { mode: asrProviderParams.Mode, appId: asrAppId, hasToken: !!asrAccessToken, apiResourceId: asrApiResourceId || '(none)' },
    tuning: { silenceMs: TUNING.VAD_SILENCE_MS, aivad: TUNING.VAD_AIVAD, history: TUNING.LLM_HISTORY_LENGTH, maxTokens: TUNING.LLM_MAX_TOKENS },
  });

  const body = {
    AppId: appId,
    RoomId: roomId,
    TaskId: taskId,
    AgentConfig: {
      TargetUserId: [userId],
      WelcomeMessage: welcomeMessage || '',
      UserId: botUserId,
      EnableConversationStateCallback: true,
    },
    Config: {
      ASRConfig: {
        Provider: 'volcano',
        ProviderParams: asrProviderParams,
        // VAD 静音判停：显式调短「等你说完」的空等窗口（默认 600ms），并锁死 AIVAD=false。
        VADConfig: {
          SilenceTime: TUNING.VAD_SILENCE_MS,
          AIVAD: TUNING.VAD_AIVAD,
        },
      },
      TTSConfig: {
        Provider: 'volcano',
        ProviderParams: {
          app: { appid: ttsAppId, cluster },
          audio: {
            voice_type: voice,
            speed_ratio: TUNING.TTS_SPEED_RATIO,
            pitch_ratio: 1,
            volume_ratio: 1,
          },
        },
      },
      LLMConfig: {
        Mode: 'ArkV3',
        EndPointId: visionEndpointId || arkEndpointId,
        SystemMessages: systemMessage ? [systemMessage] : [],
        // Function Calling 工具(硬件场景:小黑子音乐控制)。tool_calls 经 RTC 二进制消息
        // 下发到设备端处理(rtc-aigc-embedded-demo 官方链路),非 ServerMessageUrl 回调。
        ...(Array.isArray(tools) && tools.length ? { Tools: tools } : {}),
        // 视觉：仅视频通话模式(visionEnable=true)才在建任务时开启抽帧；语音通话保持关闭。
        // EndPointId 恒为视觉接入点(存在时)，但 Enable 由调用方按通话模式显式决定。
        VisionConfig: visionEndpointId
          ? { Enable: !!visionEnable, SnapshotConfig: {} }
          : { Enable: false },
        // 限历史轮数 + 回复长度，压 LLM 首字与整句时长。
        HistoryLength: TUNING.LLM_HISTORY_LENGTH,
        MaxTokens: TUNING.LLM_MAX_TOKENS,
      },
      // InterruptMode 是二值字段(0=可被用户语音打断/1=不可)，0 已是延迟最优，勿改。
      InterruptMode: 0,
      // Function Calling 服务端回调（ALL-450）：与 LLMConfig 平级；配齐 Url+Signature 才开启。
      // tool_calls 由火山 POST 到 ServerMessageUrl（无 Content-Type），不再只发设备端。
      ...(functionCalling && functionCalling.serverMessageUrl && functionCalling.serverMessageSignature
        ? {
            FunctionCallingConfig: {
              ServerMessageUrl: functionCalling.serverMessageUrl,
              ServerMessageSignature: functionCalling.serverMessageSignature,
            },
          }
        : {}),
    },
  };

  return openAPIImpl(config, 'StartVoiceChat', body);
}

/**
 * 通话中向 LLM 直接发指令/文本/图片（火山 UpdateVoiceChat 的 Command 通道）。
 * 用于：主动播报(ExternalTextToLLM 触发缓存视频帧分析)、外部图片问答(带 ImageConfig)、诊断。
 */
function sendAigcCommand({ config, roomId, taskId, command, message, interruptMode, imageConfig }) {
  const body = { AppId: config.appId, RoomId: roomId, TaskId: taskId, Command: command };
  if (message !== undefined) body.Message = message;
  if (interruptMode !== undefined) body.InterruptMode = interruptMode;
  if (imageConfig) body.ImageConfig = imageConfig;
  return openAPIImpl(config, 'UpdateVoiceChat', body);
}

/** 停止智能体（StopVoiceChat）。 */
function stopVoiceChat({ config, roomId, taskId }) {
  return openAPIImpl(config, 'StopVoiceChat', {
    AppId: config.appId,
    RoomId: roomId,
    TaskId: taskId,
  });
}

/**
 * 通话中动态更新智能体：翻转视觉理解开关（VisionConfig.Enable）。
 * 火山 UpdateVoiceChat 要求：Command='UpdateParameters'（必选），配置更新放在 Parameters.Config
 * （不是顶层 Config）。开启带 SnapshotConfig{}（走默认抽帧策略）；关闭仅需 Enable=false。
 * 文档：https://www.volcengine.com/docs/6348/1404671
 */
function updateVoiceChat({ config, roomId, taskId, visionEnable }) {
  const body = {
    AppId: config.appId,
    RoomId: roomId,
    TaskId: taskId,
    Command: 'UpdateParameters',
    Parameters: {
      Config: {
        LLMConfig: {
          VisionConfig: { Enable: !!visionEnable, SnapshotConfig: {} },
        },
      },
    },
  };
  return openAPIImpl(config, 'UpdateVoiceChat', body);
}

module.exports = {
  PRIVILEGES,
  AccessToken,
  parseToken,
  generateJoinToken,
  startVoiceChat,
  stopVoiceChat,
  updateVoiceChat,
  sendAigcCommand,
  __setOpenAPI,
  RTC_OPENAPI_VERSION,
};
