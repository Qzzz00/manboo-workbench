'use strict';

// 通道层的钥匙串(2026-09-21)。这一刀要回答的问题只有一个:
//
//   **用户那台 Mac 上,为什么会有一份 LiveKit 的 api secret 和火山的 access token?**
//
// 以前的答案是「Ben 手工把 channel.json 拷过去的」(docs/验收-从零重装清单 第九节的暂留项)。
// 那意味着:每一台装了工作台的机器上都躺着一把**整套基础设施**的钥匙——
// 拿到它的人可以进任何房间、可以拿我们的火山账号刷额度。新用户更是压根拿不到,
// 于是「通道」对他等于不存在。
//
// 现在的答案:**钥匙留在这台服务器上,客户端拿的是签好的、短命的、只够办这一件事的东西。**
//
// ## 三样东西,三种待遇
//
// | 钥匙 | 在哪 | 客户端拿到什么 |
// |---|---|---|
// | LiveKit api key / secret | 只在 `/opt/relay/.env` | **什么都拿不到**。要进房就来 `POST /v1/channel-token`,中转替它签 |
// | 火山 ASR appid / access token | 只在 `/opt/relay/.env` | 拿到**值本身**,带到期时间,约定只存内存(见下) |
// | 火山 TTS appid / access token | 同上 | 同上 |
//
// 火山那两样为什么还得下发:识别是**客户端直连火山的流式 WebSocket**
// (channel-worker/src/asr/volcStt.ts),音频帧一秒好几个,绕一趟我们的服务器等于
// 把延迟和带宽都翻一倍,而延迟正是这条链路上最贵的东西。改成中转代理不是做不到
// (见交接「没做的」一节的可行性),但那是另一张卡。
//
// 所以对这两样,我们能做到的是**把暴露面压到最小**:
//   - 只有带着设备令牌的请求拿得到(和 /v1/usage 同一道门);
//   - 回包里带 `expires_at` 与 `store: 'memory-only'`,客户端据此**不落盘**、过期重取;
//   - 服务器上换一把新的,所有客户端下一次取就跟着换了——以前要 Ben 一台台去改 channel.json。
//
// ## 房间名由账号算,不由客户端说
//
// 以前房间名是写死的 `workbench`(workbench-plugin/src/server/channel.ts 的
// CHANNEL_DEFAULT_ROOM),因为那时 livekit-server 是**每台 Mac 自己起的**,一台机器一个宇宙。
// 搬到公用那台之后这就成了一个真问题:所有人的手机都会进同一间屋子。
//
// 所以房间名在**中转这边**按令牌里的 `account` 算:`wb-<sha256(account) 前 16 位>`。
//   - 同一个账号的电脑与手机算出同一间(它们本来就该在一起);
//   - 别人的账号算出另一间,而且**客户端没法要求进别人的房间**——它说的 room 只被拿来核对;
//   - 房间名会进 LiveKit 那台机器的日志,所以里头不放账号本身,只放哈希。
//
// ## 签出去的凭证一样不多
//
// `join`:进这一间、能说能听能发数据。没有 roomAdmin(踢不了人)、没有 roomList
// (列不到别人的房间)、没有 canUpdateOwnMetadata(改不了自己的设备属性——工人正是靠
// 那条属性决定用谁的权限去调 8791 的,能改属性就等于能改自己是谁)。
// `admin`:只给 roomAdmin、只给这一间、只活 60 秒。它唯一的用处是工作台那条
// `/channel/status` 要 ListParticipants 看看工人在不在房。**不给 roomList**。

const crypto = require('node:crypto');

/** 房间名前缀。改它等于把所有人换到新的一批房间里(在线的会被留在旧房间直到重连)。 */
const CHANNEL_ROOM_PREFIX = 'wb-';

/** 进房凭证的默认有效期:7 天,与 workbench-plugin 那边的 CHANNEL_DEFAULT_TOKEN_TTL_SECONDS 同一个数。 */
const CHANNEL_DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHANNEL_MIN_TOKEN_TTL_SECONDS = 60;
const CHANNEL_MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** `kind: 'admin'` 那一张的有效期。**写死**——它只够打一次 ListParticipants,不该能久留。 */
const CHANNEL_ADMIN_TTL_SECONDS = 60;

/**
 * 下发出去的火山凭据在客户端内存里活多久。到点客户端重取一次(顺带把服务器上换过的新值带回去)。
 * 一小时是拍的:短到「服务器上换了钥匙,一小时内全网跟上」,长到不至于把中转拉麻。
 */
const CHANNEL_CREDENTIAL_TTL_SECONDS = 60 * 60;

/** 火山流式识别的默认 resource id(与 butler-server、channel-worker 那两份一致)。 */
const VOLC_ASR_DEFAULT_RESOURCE = 'volc.bigasr.sauc.duration';

/**
 * 身份允许的字符。它要进 JWT 的 `sub`、要进 LiveKit 的房间列表与日志,
 * 所以只放行一眼看得懂的那几类。**不做清洗,只做拒收**:
 * 悄悄把 `wb phone` 改成 `wb-phone` 会让调用方以为自己拼对了。
 */
const IDENTITY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 属性的上限。它整个进 JWT,不设上限等于让人往凭证里塞任意大小的东西。 */
const MAX_ATTRIBUTES = 8;
const MAX_ATTRIBUTE_LEN = 128;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function intOf(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 环境变量 → 通道配置。**缺一半当没配**(同 workbench-plugin 那边 channelConfigOf 的口径):
 * 有 url 没 secret 时回一个连不上的地址,只会让人对着一条"配好了但进不去"的通道猜半天。
 */
function relayChannelConfigOf(env) {
  const apiKey = text(env.RELAY_CHANNEL_LIVEKIT_API_KEY);
  const apiSecret = text(env.RELAY_CHANNEL_LIVEKIT_API_SECRET);
  const url = text(env.RELAY_CHANNEL_LIVEKIT_URL);
  const livekit = apiKey === undefined || apiSecret === undefined || url === undefined
    ? undefined
    : { url, apiKey, apiSecret };

  const asrAppId = text(env.RELAY_CHANNEL_VOLC_ASR_APP_ID);
  const asrToken = text(env.RELAY_CHANNEL_VOLC_ASR_ACCESS_TOKEN);
  const volcAsr = asrAppId === undefined || asrToken === undefined
    ? undefined
    : {
        appId: asrAppId,
        accessToken: asrToken,
        resourceId: text(env.RELAY_CHANNEL_VOLC_ASR_RESOURCE_ID) ?? VOLC_ASR_DEFAULT_RESOURCE,
      };

  /**
   * 火山合成(TTS)。2026-09-23 起:**没单独配 TTS 那组时,复用识别(ASR)那组 appid / token**。
   *
   * 维护者:「火山的 TTS 和 ASR 是同一个 APPID 和 Token」—— 火山控制台里同一个应用可以同时开两样,
   * 服务器 .env 里已经有 ASR 那组,再抄一遍只是多一处要同步换的地方。
   * 复用时**只借 appid / token**:resource_id / cluster 不套 ASR 的(ASR 的 resource 是
   * `volc.bigasr.*`,拿去合成会被火山拒),而是整块缺席,由合成那一端用它自己的缺省
   * (butler-server services/volcengine.cjs:cluster `volcano_tts`、公版音色 resource
   * `volc.service_type.10029`)。`RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID / _CLUSTER` 单独配了照样生效。
   * 单独配了 `RELAY_CHANNEL_VOLC_TTS_APP_ID / _ACCESS_TOKEN` 就以它为准(`reusesAsr` 为假)。
   */
  const ttsAppId = text(env.RELAY_CHANNEL_VOLC_TTS_APP_ID);
  const ttsToken = text(env.RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN);
  const ttsOwn = ttsAppId !== undefined && ttsToken !== undefined;
  const ttsExtras = {
    ...(text(env.RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID) === undefined
      ? {}
      : { resourceId: text(env.RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID) }),
    ...(text(env.RELAY_CHANNEL_VOLC_TTS_CLUSTER) === undefined
      ? {}
      : { cluster: text(env.RELAY_CHANNEL_VOLC_TTS_CLUSTER) }),
  };
  const volcTts = ttsOwn
    ? { appId: ttsAppId, accessToken: ttsToken, ...ttsExtras }
    : volcAsr === undefined
      ? undefined
      : { appId: volcAsr.appId, accessToken: volcAsr.accessToken, ...ttsExtras, reusesAsr: true };

  return {
    roomPrefix: text(env.RELAY_CHANNEL_ROOM_PREFIX) ?? CHANNEL_ROOM_PREFIX,
    tokenTtlSeconds: clampTtl(intOf(env.RELAY_CHANNEL_TOKEN_TTL, CHANNEL_DEFAULT_TOKEN_TTL_SECONDS)),
    credentialTtlSeconds: intOf(env.RELAY_CHANNEL_CREDENTIAL_TTL, CHANNEL_CREDENTIAL_TTL_SECONDS),
    ...(livekit === undefined ? {} : { livekit }),
    ...(volcAsr === undefined ? {} : { volcAsr }),
    ...(volcTts === undefined ? {} : { volcTts }),
  };
}

function clampTtl(seconds) {
  return Math.min(CHANNEL_MAX_TOKEN_TTL_SECONDS, Math.max(CHANNEL_MIN_TOKEN_TTL_SECONDS, Math.floor(seconds)));
}

/**
 * 账号 → 房间名。**只进不出**:拿着房间名回推不出账号。
 * 同一个账号的所有设备算出同一间,这正是我们要的(电脑上的工人与他的手机得在一起)。
 */
function channelRoomOf(account, prefix = CHANNEL_ROOM_PREFIX) {
  return `${prefix}${crypto.createHash('sha256').update(String(account), 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * 设备令牌行里「这一行属于服务器账号」的那个前缀。**必须与 accounts.cjs 的
 * `accountScopeOf` 拼出来的一样** —— pure.test.mjs 里有一条用例拿 `accountScopeOf`
 * 的产物过这道门,两边漂了当场红。
 */
const CHANNEL_ACCOUNT_SCOPE_PREFIX = 'acct:';

/**
 * 「这把令牌配不配得上一间房」(2026-09-27,卡 RM)。
 *
 * 2026-09-27 之前,房间名一律由令牌行的 `account` 列算,而那一列有两种可能的内容:
 * `acct:<账号 id>`(带会话领的)与**用户起的那个名字**(`allowLegacyRegister` 那条老路领的)。
 * 于是同一个账号会算出两间房:
 *
 *   · 电脑上那把 `relay_token` 是**装完、还没登录**时由 modelService 领的(这是每一台新装
 *     机器的**主路径**,不是边角情况),走的是 legacy → `account = <名字>` → 房间 A;
 *   · 座机与手机是带账号会话领的 → `account = acct:<id>` → 房间 B。
 *
 * 结果:电脑与扫码配对的手机在房间 A,座机在房间 B —— 座机提机没人接、给座机换网络
 * 也发不到它头上(docs/交接-0927-座机进错房间.md)。
 *
 * 根治的第一刀在这里:**房间只有一个来源,账号**。令牌行不是 `acct:` 形状就**不签进房凭证**,
 * 回一句人话。注意它**只挡通道那两条路**:legacy 令牌**照样能调模型**——
 * 登录前的引导要用它,把那条一起掐掉等于新用户装完连话都搭不上。
 *
 * 回 undefined = 这把可以进房;回一个对象 = 这一次拒了,里头是照原样回给客户端的三样。
 */
function channelAccountRefusal(account) {
  if (typeof account === 'string'
    && account.startsWith(CHANNEL_ACCOUNT_SCOPE_PREFIX)
    && account.length > CHANNEL_ACCOUNT_SCOPE_PREFIX.length) {
    return undefined;
  }
  return {
    status: 403,
    code: 'not_bound_to_account',
    error: '这台电脑还没登录账号,登录后才能通话。',
  };
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 签一张 LiveKit 进房凭证。就是一个 HS256 JWT,没有别的花样——
 * `iss` = api key,`sub` = 身份,`video` = 授权。**secret 只在这个函数里出现**。
 * 与 workbench-plugin/src/server/channel.ts 的 signAccessToken 同一份算法(两边必须签得出一样的东西)。
 */
function signLivekitToken(input) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: input.apiKey,
    sub: input.identity,
    nbf: input.nowSeconds,
    exp: input.nowSeconds + input.ttlSeconds,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
    video: input.grant,
  }));
  const signature = base64url(crypto.createHmac('sha256', input.apiSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/** 测试与排查用:读出 JWT 中间那一段。**不验签**——它只是给人看的。 */
function decodeJwtPayload(token) {
  const part = String(token).split('.')[1];
  if (part === undefined) return undefined;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { return undefined; }
}

/** 进房的授权。一样不多,理由见文件头。 */
function joinGrant(room) {
  return { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true };
}

/** 看一眼房里有谁。**没有 roomList** —— 那会把别的账号的房间也端出来。 */
function roomAdminGrant(room) {
  return { room, roomAdmin: true };
}

/**
 * `POST /v1/channel-token` 的请求体校验。纯函数,所有"能不能"的判断都在这里,
 * 路由那边只负责把结论翻成 HTTP。
 *
 * `room` 的待遇很特别:**它不是输入,是一道核对**。客户端手上确实有房间名
 * (上一条 /v1/channel-credentials 给的),把它报上来能让"我以为我在 A 房、其实签到了 B 房"
 * 这种错当场暴露;但它说了不算——对不上就拒,而不是照它签。
 */
function parseChannelTokenRequest(body, options) {
  const raw = (body !== null && typeof body === 'object' && !Array.isArray(body)) ? body : {};

  const identity = typeof raw.identity === 'string' ? raw.identity.trim() : '';
  if (!IDENTITY_RE.test(identity)) {
    return {
      ok: false, status: 400, code: 'invalid_identity',
      error: 'identity 要是 1–128 个字母、数字或 _ . : - 组成的字符串。',
    };
  }

  const asked = text(raw.room);
  if (asked !== undefined && asked !== options.room) {
    return {
      ok: false, status: 400, code: 'room_not_yours',
      error: '这个房间不属于这台设备的账号。房间名以 /v1/channel-credentials 回的那个为准。',
    };
  }

  const kind = raw.kind === 'admin' ? 'admin' : 'join';

  const attributes = {};
  if (raw.attributes !== null && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes)) {
    const entries = Object.entries(raw.attributes);
    if (entries.length > MAX_ATTRIBUTES) {
      return { ok: false, status: 400, code: 'too_many_attributes', error: `attributes 最多 ${MAX_ATTRIBUTES} 项。` };
    }
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || key.length > MAX_ATTRIBUTE_LEN || value.length > MAX_ATTRIBUTE_LEN) {
        return {
          ok: false, status: 400, code: 'invalid_attributes',
          error: `attributes 的键与值都要是不超过 ${MAX_ATTRIBUTE_LEN} 个字符的字符串。`,
        };
      }
      attributes[key] = value;
    }
  }

  const name = text(raw.name);
  const ttlSeconds = kind === 'admin'
    ? CHANNEL_ADMIN_TTL_SECONDS
    : clampTtl(intOf(raw.ttl_seconds, options.defaultTtlSeconds));

  return {
    ok: true,
    identity,
    kind,
    ttlSeconds,
    ...(name === undefined ? {} : { name }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
  };
}

/**
 * 进房凭证里带「这台是什么」的属性名。与 workbench-plugin/src/server/channel.ts 的
 * `CHANNEL_KIND_ATTRIBUTE`、channel-worker/src/rpc.ts 的 `KIND_ATTRIBUTE`、
 * phone-bridge/pairing.py 的 `KIND_ATTRIBUTE` 逐字相同。
 */
const CHANNEL_KIND_ATTRIBUTE = 'wb_kind';

/**
 * 这台设备在凭证里该被签成什么(2026-09-23)。**由注册时那一列说了算,不由请求体说了算**。
 *
 * 为什么中转要管这一件:本机 8791 签凭证时按配对记录带 `wb_kind`,中转这条路上却
 * 一直只是把客户端报的 attributes 原样签进去。于是一只走中转进房的树莓派话筒,
 * 凭证里没有(或可以随便有)这一项 —— 工人把它当手机,通话的声音就送错地方,
 * 而「一台手机自称 handset 就能把声音抢过去」正是这一项必须由服务端定的理由。
 *
 * **只对手机与话筒说话**:`mac` / `windows` / `other` / 没登记过类型的一律回 undefined,
 * 请求体里的 attributes 原样保留。这样两件事同时成立 ——
 *   · 老设备(注册成 `other` 的那几台派)行为一个字没变,还靠自己报的属性;
 *   · Mac 上的 8791 替手机签凭证时(它自己那把令牌是 `mac`)不会被盖掉。
 */
function channelKindAttributeOf(deviceKind) {
  if (deviceKind === 'handset') return 'handset';
  if (deviceKind === 'phone') return 'phone';
  return undefined;
}

/** 把「这台是什么」盖进要签的属性里。回 undefined 表示一条属性都不签。 */
function channelAttributesOf(attributes, deviceKind) {
  const signed = channelKindAttributeOf(deviceKind);
  if (signed === undefined) return attributes;
  return { ...(attributes ?? {}), [CHANNEL_KIND_ATTRIBUTE]: signed };
}

/**
 * `GET /v1/channel-credentials` 的回包。**这个函数决定了哪些值出得了这台服务器**,
 * 所以它是纯函数、单独一条、有专门的用例盯着:改它等于改密钥边界。
 */
function channelCredentialsView(config, options) {
  const notes = [];
  const livekit = config.livekit === undefined
    ? { configured: false }
    : {
        configured: true,
        url: config.livekit.url,
        room: options.room,
        // **不是** api key,是一条路径:要凭证就来这儿要,secret 留在服务器上。
        token_endpoint: '/v1/channel-token',
        token_ttl_seconds: config.tokenTtlSeconds,
      };
  if (config.livekit === undefined) {
    notes.push('服务器上还没配 LiveKit(地址 / api key / secret 三样缺一不可),这台设备暂时通不了话。');
  }
  if (config.volcAsr === undefined && config.volcTts === undefined) {
    notes.push('服务器上还没配火山的识别与合成凭据,通话能接通但听不懂也不出声。');
  }
  else if (config.volcAsr === undefined) {
    notes.push('服务器上还没配火山识别(ASR)的凭据,通话里说的话转不成字。');
  }
  else if (config.volcTts === undefined) {
    notes.push('服务器上还没配火山合成(TTS)的凭据,通话里听不到声音。');
  }
  if (config.volcTts !== undefined && config.volcTts.reusesAsr === true) {
    // 不是缺东西,是如实交代这一把从哪来:以后 TTS 报鉴权错,先查的是识别那组。
    notes.push('火山合成(TTS)复用识别(ASR)那组凭据(服务器上没单独配 TTS)。');
  }
  return {
    livekit,
    ...(config.volcAsr === undefined ? {} : {
      volc_asr: {
        app_id: config.volcAsr.appId,
        access_token: config.volcAsr.accessToken,
        resource_id: config.volcAsr.resourceId,
      },
    }),
    ...(config.volcTts === undefined ? {} : {
      volc_tts: {
        app_id: config.volcTts.appId,
        access_token: config.volcTts.accessToken,
        ...(config.volcTts.resourceId === undefined ? {} : { resource_id: config.volcTts.resourceId }),
        ...(config.volcTts.cluster === undefined ? {} : { cluster: config.volcTts.cluster }),
      },
    }),
    /**
     * 这份回包能用到什么时候。客户端拿它决定"什么时候再来取一次";
     * 它也是"服务器上换了钥匙多久能全网生效"的上界。
     */
    expires_at: new Date(options.nowMs + config.credentialTtlSeconds * 1000).toISOString(),
    /**
     * 一句**给写客户端的人看的**约定,不是给机器读的:这份东西不许落盘。
     * 写成字段而不是只写在文档里,是因为文档不会跟着回包一起走到下一个人手上。
     */
    store: 'memory-only',
    ...(notes.length === 0 ? {} : { notes }),
  };
}

module.exports = {
  CHANNEL_ROOM_PREFIX,
  CHANNEL_DEFAULT_TOKEN_TTL_SECONDS,
  CHANNEL_MIN_TOKEN_TTL_SECONDS,
  CHANNEL_MAX_TOKEN_TTL_SECONDS,
  CHANNEL_ADMIN_TTL_SECONDS,
  CHANNEL_CREDENTIAL_TTL_SECONDS,
  VOLC_ASR_DEFAULT_RESOURCE,
  relayChannelConfigOf,
  channelRoomOf,
  CHANNEL_ACCOUNT_SCOPE_PREFIX,
  channelAccountRefusal,
  clampTtl,
  signLivekitToken,
  decodeJwtPayload,
  joinGrant,
  roomAdminGrant,
  parseChannelTokenRequest,
  channelCredentialsView,
  CHANNEL_KIND_ATTRIBUTE,
  channelKindAttributeOf,
  channelAttributesOf,
};
