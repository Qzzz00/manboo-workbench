'use strict';

// 中转的 Express 装配。路由面就这么几条:
//
//   POST /v1/chat/completions   OpenAI 兼容,流式与非流式都转(要中转令牌;**按模型名分三家上游**)
//   POST /v1/images             图片生成,转 OpenAI(要中转令牌)
//   GET  /v1/models             上游的模型目录(要中转令牌;`?provider=` 指定哪一家,缺省 DeepSeek)
//   GET  /v1/usage              我今天用了多少 / 上限多少(要中转令牌;工作台设置里显示的就是它)
//   GET  /usage                 同一份答案的**老路径**,只为还没升级的工作台留着(见下)
//   GET  /v1/channel-credentials 通道怎么连(要中转令牌;**不含 LiveKit 的 secret**,见 channel.cjs)
//   POST /v1/channel-token      替这台设备签一张 LiveKit 进房凭证(要中转令牌)
//   POST /v1/account/register   注册一个账号,回一张会话令牌(长期、可吊销)
//   POST /v1/account/login      登录,回一张会话令牌
//   POST /v1/account/logout     把这一张会话令牌吊销
//   GET  /v1/account/me         我是谁(要会话令牌;**没有哈希、没有盐**)
//   POST /v1/account/password   改密码(要会话令牌 + 当前密码;改完撤掉别处的登录)
//   GET  /v1/account/devices    我名下有哪几台设备(要会话令牌)
//   POST /v1/account/devices/revoke  移除一台设备(要会话令牌)
//   POST /register-device       这台设备领令牌(**要账号会话**;老客户端的兼容路见下)
//   POST /v1/search             代发一次网页搜索(要中转令牌;按次限额,见 search.cjs)
//   POST /v1/diag/report        用户那台机器报一条错(要中转令牌;每台每小时 20 条,见 diag.cjs)
//   GET  /v1/diag/reports       把报错拉下来看(**只认管理员令牌 RELAY_ADMIN_TOKEN**;
//                               `?kind=feedback` 只看用户反馈给开发者的那些,2026-09-28 卡 FB)
//   POST /v1/diag/pack          传一个诊断包(zip,要设备令牌;回六位编号,7 天后自动删,见 diagPacks.cjs)
//   GET  /v1/diag/pack/:code    按编号取(管理员令牌取谁的都行;设备令牌只取得到自己账号的)
//   POST /register-device       第一次领令牌(开放,但限速 + 每账号设备数封顶)
//   GET  /health                活着没有(不含任何密钥)
//   GET  /updates/*             热更新的清单与产物(公开、只读、无鉴权)
//   /v1/workspace* /v1/inbox/* /v1/objects* /v1/channels* /v1/webhooks* /v1/hooks/* /v1/wecom/*
//                               协作区跨机底座(2026-10-21),清单与门见 collabRoutes.cjs 文件头
//   POST /admin/tokens          手工发一个令牌(只认回环)
//   POST /admin/tokens/revoke   吊销(只认回环)
//   GET  /admin/usage           某一天所有令牌的用量(只认回环)
//
// ## /updates/* 为什么不要鉴权
//
// 那里面只有**我们自己发布的安装产物与一份清单**,没有任何用户数据、没有任何密钥。
// 而要它的那台机器可能正处在"什么都还没配好"的状态(第一次装完、令牌还没领),
// 让更新也要先有令牌等于把一条本该最简单的路绑在另一条上。
// 真正防"装到别人给的包"的那道门不在这里,而在客户端:清单里每件产物钉着 sha256,
// 而且产物必须与清单同源(workbench-plugin/src/server/update/manifest.ts)。
//
// ## 「只认回环」在反代后面为什么还要再加一道
//
// Caddy 是从 127.0.0.1 连过来的,所以光看 remoteAddress,**所有**经过 Caddy 的请求都像本机。
// 两道防线:① Caddyfile 里只反代 /v1/*、/register-device、/health 三条路,/admin 压根到不了
// (deploy/aliyun-relay-setup.sh);② 这里再看一眼有没有 `x-forwarded-for` / `x-real-ip`——
// 反代会加,真正的本机 curl 不会。两道都破了才谈得上越权。
//
// ## 上游有三家(2026-09-22)
//
// `/v1/chat/completions` 按**模型名前缀**挑上游:`gpt-*`/`o1..o4` → OpenAI、`doubao-*`/`ep-*` → 豆包、
// 其余 → DeepSeek(现状那一档)。哪一家没配就 **503 + 「服务器没配 X」**,绝不改发给别家 ——
// 静默换一家的下场是账记在别人头上、回答风格突然变了却没人说得清为什么。
// 判据与地址全在 server/providers.cjs;用量按家分开记(usage_daily 多了 provider 一列)。
//
// ## 错误一律用 OpenAI 的形状
//
// `{ error: { message, type, code } }`。客户端(DSH 的 pi-ai、@livekit/agents 的 openai 插件、
// 各种 SDK)都按这个形状读 message,用别的形状等于「出了错但界面上什么也不说」。
// message 里写人话,因为最终是要显示给不懂代码的人看的。

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { createUsageSniffer } = require('./sse.cjs');
const { forwardJson, forwardStream, fetchModels, withUsageOptions } = require('./upstream.cjs');
const {
  activeTokenCount, bearerOf, findToken, issueToken, revokeByPrefix,
} = require('./tokens.cjs');
const { dayKey, recordSearch, recordUsage, searchOfDay, usageByProvider, usageOfDay, usageReport } = require('./usage.cjs');
const {
  PROVIDERS, notConfiguredCode, notConfiguredMessage, providerOfModel, providerUpstream, resolveUpstreamModel,
} = require('./providers.cjs');
const { parseSearchRequest, searchConfigured, searchUpstream } = require('./search.cjs');
const { formatCny, microToCny } = require('./pricing.cjs');
const { DEFAULT_DAILY_COST_LIMIT_CNY } = require('./config.cjs');
const {
  channelAccountRefusal,
  channelAttributesOf,
  channelCredentialsView, channelRoomOf, joinGrant, parseChannelTokenRequest, roomAdminGrant, signLivekitToken,
} = require('./channel.cjs');
const {
  adminTokenMatches, countDiagReportsSince, diagReportRows, DIAG_KINDS, DIAG_PER_HOUR, DIAG_RETENTION_DAYS,
  insertDiagReport, parseDiagReport, pruneDiagReports,
} = require('./diag.cjs');
const {
  countDiagPacksSince, DIAG_PACK_MAX_BYTES, DIAG_PACK_PER_DAY, DIAG_PACK_RETENTION_DAYS, findDiagPack,
  looksLikeZip, normalizeDiagPackCode, packFileOf, pruneDiagPacks, storeDiagPack,
} = require('./diagPacks.cjs');
const {
  accountScopeOf, accountView, checkDeviceKind, checkDeviceName, checkPassword, createAccount, createLoginGuard,
  devicesOfAccount, findAccountByIdentifier, findSession, identifierFrom, issueSession, revokeDevice, revokeSession,
  touchDevice, verifyAccountPassword, setAccountPassword, revokeOtherSessions, MAX_LOGIN_ATTEMPTS,
} = require('./accounts.cjs');

const { mountCollab } = require('./collabRoutes.cjs');
const { wecomConfigured } = require('./wecom.cjs');

const PKG_VERSION = require('../package.json').version;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 热更新的清单文件名:稳定版与热修两条通道(与 deploy/publish-update.sh 写的两个名字逐字相同)。 */
const UPDATE_MANIFESTS = new Set(['latest.json', 'beta.json']);

/** 真·本机。反代加的那两个头出现了就不算——理由见文件头。 */
function isLoopbackRequest(req) {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  if (req.headers['x-real-ip'] !== undefined) return false;
  const address = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function oaiError(res, status, message, type, code) {
  res.status(status).json({ error: { message, type, ...(code === undefined ? {} : { code }) } });
}

/** 限速用的来源标识。反代后面认 x-forwarded-for 的第一段,否则认 socket 地址。 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** 一小时窗口的内存计数器。重启就清零——领令牌是低频动作,不值得为它加一张表。 */
function createRateLimiter({ perHour, windowMs = 3_600_000 }) {
  const hits = new Map();
  return {
    take(key, now) {
      const at = now ?? Date.now();
      const kept = (hits.get(key) ?? []).filter(t => at - t < windowMs);
      if (kept.length >= perHour) { hits.set(key, kept); return false; }
      kept.push(at);
      hits.set(key, kept);
      return true;
    },
  };
}

/**
 * **只数失败**的一小时窗口计数器。与上面那个 createRateLimiter 的区别就在这一点:
 * 那个是"做这件事就扣一笔",这个是"做砸了才扣一笔" —— 正常人不该因为登录成功被限。
 */
function createFailureLimiter({ perHour, windowMs = 3_600_000 }) {
  const hits = new Map();
  const live = (key, at) => (hits.get(key) ?? []).filter(t => at - t < windowMs);
  return {
    blocked(key, at) {
      const kept = live(key, at);
      hits.set(key, kept);
      return kept.length >= perHour;
    },
    note(key, at) {
      const kept = live(key, at);
      kept.push(at);
      hits.set(key, kept);
    },
  };
}

function nonEmptyString(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= max
    ? value.trim()
    : undefined;
}

/**
 * 造一个 app。所有外部依赖都从参数进来(库、时钟、fetch),测试才好把上游换成假的。
 *
 * @param db        openRelayDb() 的返回
 * @param config    relayConfigOf() 的返回
 * @param fetchImpl 发往上游用的 fetch(测试里指向假上游)
 * @param now       取当前时间(测试里可以把日子拨过去)
 * @param log       一行日志(默认 console.log)。**只允许出现 prefix,不允许出现整串令牌**
 */
/** 事务官手机 App(Capacitor)页面的来源。 */
const APP_ORIGINS = new Set(['http://localhost', 'https://localhost', 'capacitor://localhost']);

function createApp({ db, config, fetchImpl = fetch, now = () => new Date(), log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  // 手机 App 的页面在 http://localhost(Capacitor androidScheme http)下,对中转是跨域请求:
  // 不回这几个头,WebView 会把账号登录、直领进房凭证全拦掉(10-10 真机)。只放行 App 自己的来源。
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && APP_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    }
    next();
  });
  // 1mb 不够:带长上下文的一次 chat 请求可以到几百 KB,带图更大。4mb 是拍的,能改。
  app.use(express.json({ limit: '4mb' }));

  const registerLimiter = createRateLimiter({ perHour: config.registerPerHour });

  /** 每台设备每天最多花多少元(2026-09-23 起额度按钱算,见 pricing.cjs)。一个全局数,不按令牌存。 */
  const costLimitCny = config.dailyCostLimitCny ?? DEFAULT_DAILY_COST_LIMIT_CNY;
  const costLimitMicro = Math.round(costLimitCny * 1_000_000);
  /** 记一次账:把模型名与价格表带上,让 usage.cjs 按那一档价折成元。 */
  const record = (row, day, usage, provider, model) => recordUsage(db, row.token_hash, day, usage, provider, { model, prices: config.prices });

  /**
   * 认令牌 + 看额度。过不了就自己把响应写完,返回 undefined。
   *
   * ★ **「上游配没配」不在这里看了**(2026-09-22):上游有三家,配没配是**按家**问的,
   * 而这一层还不知道这次要发给谁(要先读到 body 里的 model)。所以那一问挪到了
   * `upstreamFor()`,在认完令牌之后 —— 顺带把「不带令牌的人问得出服务器配了什么」这条缝堵上。
   */
  function gate(req, res) {
    const token = bearerOf(req.headers.authorization);
    const row = findToken(db, token);
    if (row === undefined) {
      // 「没这个令牌」与「被吊销了」说同一句话,不给猜的人送信息。
      oaiError(
        res, 401,
        '这台设备的模型服务凭证不认识或已失效。在工作台的「设置 → 模型」里重新领一次就好。',
        'invalid_request_error', 'invalid_relay_token',
      );
      return undefined;
    }
    const day = dayKey(now(), config.dayOffsetMinutes);
    const used = usageOfDay(db, row.token_hash, day);
    // ★ 2026-09-23 起比的是**钱**(微元整数对微元整数,不比浮点)。
    // tokens.daily_token_limit 那一列不再拦任何请求(理由见 config.cjs 的 DEFAULT_DAILY_TOKEN_LIMIT)。
    // code 仍是 daily_quota_exceeded:工作台与派活那边按它认「额度用完」,不许改。
    if (used.cost_micro_cny >= costLimitMicro) {
      oaiError(
        res, 429,
        `今天工作台提供的模型额度(${formatCny(costLimitCny)} 元)用完了,已花 ¥${formatCny(used.cost_cny, { cents: true })}。`
        + '明天零点自动恢复。想现在就继续,可以在「设置 → 模型」里换成自己的 DeepSeek Key。',
        'rate_limit_exceeded', 'daily_quota_exceeded',
      );
      return undefined;
    }
    return { row, day, used };
  }

  /**
   * 这次该发给哪一家,以及那一家此刻能不能发。
   *
   * 不能发就自己把 503 写完并回 `undefined`。**绝不改发给别家**:静默换一家的下场是
   * 账记在别人头上、回答风格突然变了却没人说得清为什么。那句错误里带着**环境变量名**,
   * 看到它的人下一步就是去 .env 里加那一行(providers.cjs 的 notConfiguredMessage)。
   */
  function upstreamFor(res, model) {
    const provider = providerOfModel(model);
    const upstream = providerUpstream(config, provider);
    if (upstream === undefined) {
      oaiError(res, 503, notConfiguredMessage(provider), 'server_error', notConfiguredCode(provider));
      return undefined;
    }
    return upstream;
  }

  /**
   * 热更新的清单与产物(2026-09-18)。**只读的静态目录**,没有别的。
   *
   * 三条:
   * 1. **只发 GET/HEAD**(express.static 本来就是这样),而且这棵树在服务器上由
   *    deploy/publish-update.sh 用 rsync 推上来,中转进程自己**从不往里写**;
   * 2. `dotfiles: 'deny'` + `index: false` —— 不发点开头的文件,也不列目录;
   * 3. `latest.json` **不给缓存**(`no-cache`):它就是"有没有新版"这个问题的答案,
   *    被 CDN 或浏览器缓存住的话,发了新版用户也查不到。产物本身按内容寻址(路径里带版本号),
   *    所以给一年的长缓存,重下时省流量。
   */
  app.use('/updates', express.static(config.updatesDir, {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
    setHeaders: (res, filePath) => {
      // 两份清单都不给缓存:稳定版 latest.json 与热修 beta.json(2026-10-21 两条通道)。
      if (UPDATE_MANIFESTS.has(path.basename(filePath))) res.setHeader('cache-control', 'no-cache');
      else res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    },
  }));
  // 静态目录里没有的那些路径:回一句人话,别让 express 的默认 404 页面出去
  // (它会带着 `Cannot GET /updates/x` 这种把框架名字抖出来的文本)。
  app.use('/updates', (req, res) => {
    oaiError(res, 404, '这个更新产物不存在。多半是清单与产物没同步上去,或者这一版已经撤了。', 'invalid_request_error', 'update_asset_not_found');
  });

  app.get('/health', (req, res) => {
    const tokens = db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL').get();
    res.json({
      ok: true,
      name: 'model-relay',
      version: PKG_VERSION,
      // 「配了没有」只回布尔,永远不回值本身。
      upstream_configured: config.upstreamKey !== undefined,
      // 三家各自配了没有(2026-09-22)。**只回布尔**,永远不回 Key、不回地址 ——
      // 工作台那边据此说得出「服务器没配 GPT」,而不是等一次派活失败才知道。
      providers: Object.fromEntries(PROVIDERS.map(one => [one, providerUpstream(config, one) !== undefined])),
      // 「这台中转支持账号了没有」。客户端据此决定走服务器账号还是退回本机账号
      // (workbench-plugin/src/server/serverAccount.ts)——它是一个能力声明,不是密钥。
      accounts: true,
      // 老客户端那条不带会话的领令牌路还开着吗。全网升完之后由 Ben 关掉(见 /register-device)。
      legacy_register: config.allowLegacyRegister,
      // 搜索代理配了没有(2026-09-21)。同样**只回布尔**,永远不回 Key、不回地址。
      search_configured: searchConfigured(config.search),
      // 通道那几把配了没有(2026-09-23)。**只回布尔**。`volc_tts_reuses_asr`:合成没单独配、借的是识别那组。
      channel_configured: {
        livekit: config.channel?.livekit !== undefined,
        volc_asr: config.channel?.volcAsr !== undefined,
        volc_tts: config.channel?.volcTts !== undefined,
        volc_tts_reuses_asr: config.channel?.volcTts?.reusesAsr === true,
      },
      // 协作区跨机底座(2026-10-21):有这一格 = 这台中转有工作室 / 收件箱 / 频道。企微机器人配没配只回布尔。
      collab: { inbox: true, wecom_configured: wecomConfigured(config.wecom) },
      active_tokens: Number(tokens?.n ?? 0),
      day: dayKey(now(), config.dayOffsetMinutes),
      // 每日额度(元)与启动时的注意事项(已废弃的变量、写坏的价格)。只是话,不含任何值。
      daily_cost_limit_cny: costLimitCny,
      warnings: config.warnings ?? [],
    });
  });

  /**
   * 我今天用了多少。工作台「模型」那一节显示的就是这两个数。
   * 额度用完之后这条**照样能访问**(否则界面在最需要解释的时候反而什么都显示不出来)。
   *
   * ## 为什么挂在 /v1 下面(2026-09-18)
   *
   * Ben 真机上这条一直回 **404**,而中转进程里明明有它 —— 挡住的是 Caddy:
   * `api.aibooo.cn` 那一段只反代 `/v1/*`、`/register-device`、`/health`、`/updates/*`
   * (deploy/aliyun-relay-setup.sh),`/usage` 从公网压根到不了中转,404 是 Caddy 自己回的。
   *
   * 所以正路是**把这条挪进已经放行的前缀里**,而不是再往白名单上加一条:
   * 白名单每多一条,就多一次"部署过的机器忘了改 Caddyfile"的机会,而这一次正是那样出的事。
   * 老路径 `/usage` 原样留着 —— 还没升级的工作台在本机直连中转(127.0.0.1:8795)时仍然走它,
   * 两条路同一个 handler,不会有两份会漂的实现。
   */
  function replyUsage(req, res) {
    const row = findToken(db, bearerOf(req.headers.authorization));
    if (row === undefined) {
      oaiError(res, 401, '这台设备的模型服务凭证不认识或已失效。', 'invalid_request_error', 'invalid_relay_token');
      return;
    }
    const day = dayKey(now(), config.dayOffsetMinutes);
    const used = usageOfDay(db, row.token_hash, day);
    res.json({
      day,
      /**
       * 按钱算的那三格(2026-09-23)。**额度只看这三格**:工作台新版据此显示「今天花了 ¥x.xx / 上限 ¥5」。
       * 下面那几个 token 数原样保留,只作参考(老工作台还读它们;它们已经不决定拦不拦)。
       */
      used_cny: used.cost_cny,
      daily_cost_limit_cny: costLimitCny,
      remaining_cny: microToCny(Math.max(0, costLimitMicro - used.cost_micro_cny)),
      cache_hit_tokens: used.cache_hit_tokens,
      cache_miss_tokens: used.cache_miss_tokens,
      daily_token_limit: row.daily_token_limit,
      used_tokens: used.total_tokens,
      remaining_tokens: Math.max(0, row.daily_token_limit - used.total_tokens),
      requests: used.requests,
      /**
       * 按家分开的那一份(2026-09-22)。**上面那四个数字一个字没动** ——
       * 老工作台读的就是它们,额度也仍然是三家之和跟上限比。
       * 三家一家不少,没用过的回 0:界面上「今天没用过 GPT」要显示得出来。
       */
      by_provider: usageByProvider(db, row.token_hash, day),
    });
  }

  app.get('/v1/usage', replyUsage);
  app.get('/usage', replyUsage);

  /**
   * 「认得出这台设备」这一道门,与 /v1/usage 同一套(见 replyUsage 里那三行)。
   * **只认令牌,不看额度** —— 通话与模型额度是两件事:今天的 token 用完了,
   * 电话照样该打得通(那一通电话花的是火山与 LiveKit 的钱,不是上游模型的)。
   */
  function deviceOf(req, res) {
    const row = findToken(db, bearerOf(req.headers.authorization));
    if (row === undefined) {
      oaiError(res, 401, '这台设备的凭证不认识或已失效。', 'invalid_request_error', 'invalid_relay_token');
      return undefined;
    }
    noteDeviceSeen(row);
    return row;
  }

  /**
   * 「这台设备上次什么时候在线」(2026-09-21,给设置里的「我的设备」用)。
   *
   * **限频到每台每分钟一次**:聊天那条路每发一句话就会走一次认令牌,每次都写一行
   * 等于给 sqlite 加一个与对话一样频繁的写入。限频的表在内存里,重启清零 ——
   * 清零的代价只是某台设备的这个时间晚一分钟才更新,没人会因此做错决定。
   */
  const lastSeenWrites = new Map();
  function noteDeviceSeen(row) {
    const at = now().getTime();
    const previous = lastSeenWrites.get(row.token_hash);
    if (previous !== undefined && at - previous < 60_000) return;
    lastSeenWrites.set(row.token_hash, at);
    try { touchDevice(db, row.token_hash, now()); }
    catch { /* 记个时间而已,写不进去不值得让整条请求失败 */ }
  }

  /**
   * 通道怎么连(2026-09-21)。**这条接口的全部意义是"LiveKit 的 secret 不下发"** ——
   * 客户端拿到的是地址、房间名与一条"要凭证来这儿要"的路径;火山那两样因为要直连
   * 流式 WebSocket 才下发值本身,带到期时间、约定只存内存。整份回包由
   * `channelCredentialsView` 拼(纯函数,有专门的用例盯着密钥边界)。
   *
   * 房间名**在这里算**,不由客户端说:`wb-<sha256(账号) 前 16 位>`。
   * 以前每台 Mac 自己起 livekit-server,房间叫 `workbench` 没问题;搬到公用那台之后
   * 那就成了"所有人的手机进同一间屋子"。理由全文在 channel.cjs 的文件头。
   */
  app.get('/v1/channel-credentials', (req, res) => {
    const row = deviceOf(req, res);
    if (row === undefined) return;
    // 房间只认账号(2026-09-27,卡 RM):legacy 令牌进不了房。理由全文在 channel.cjs 的
    // channelAccountRefusal。模型那几条路一个字没动 —— 登录前的引导还要用这把令牌调模型。
    const unbound = channelAccountRefusal(row.account);
    if (unbound !== undefined) {
      oaiError(res, unbound.status, unbound.error, 'invalid_request_error', unbound.code);
      return;
    }
    const channel = config.channel;
    const view = channelCredentialsView(channel, {
      room: channelRoomOf(row.account, channel.roomPrefix),
      nowMs: now().getTime(),
    });
    log(`channel-credentials prefix=${row.prefix} livekit=${view.livekit.configured ? 1 : 0}`
      + ` asr=${view.volc_asr === undefined ? 0 : 1} tts=${view.volc_tts === undefined ? 0 : 1}`);
    res.json(view);
  });

  /**
   * 替这台设备签一张 LiveKit 进房凭证。**secret 只在 signLivekitToken 里出现一次**,
   * 签完就没了;回给客户端的只有签好的那一串。
   *
   * 谁是谁由**客户端**说(identity 与 attributes 原样签进去)——这不是漏洞:
   * 那一头是用户自己那台 Mac 上的工作台(8791),它本来就是"按设备令牌拼身份"的那一层
   * (workbench-plugin/src/server/channel.ts 的 channelIdentityOf)。中转这边守的是
   * **房间边界**:一张设备令牌只签得出它自己那一间的凭证,别人的房间进不去。
   */
  app.post('/v1/channel-token', (req, res) => {
    const row = deviceOf(req, res);
    if (row === undefined) return;
    // 同 /v1/channel-credentials:房间只认账号,legacy 令牌签不出进房凭证(卡 RM)。
    const unbound = channelAccountRefusal(row.account);
    if (unbound !== undefined) {
      oaiError(res, unbound.status, unbound.error, 'invalid_request_error', unbound.code);
      return;
    }
    const channel = config.channel;
    if (channel.livekit === undefined) {
      oaiError(
        res, 503,
        '服务器上还没配 LiveKit(地址 / api key / secret),这会儿签不出进房凭证。',
        'server_error', 'channel_not_configured',
      );
      return;
    }
    const room = channelRoomOf(row.account, channel.roomPrefix);
    const parsed = parseChannelTokenRequest(req.body, { room, defaultTtlSeconds: channel.tokenTtlSeconds });
    if (!parsed.ok) {
      oaiError(res, parsed.status, parsed.error, 'invalid_request_error', parsed.code);
      return;
    }
    const nowSeconds = Math.floor(now().getTime() / 1000);
    /**
     * 「这台是什么」由**注册时那一列**盖进属性(2026-09-23,channel.cjs 的 channelKindAttributeOf)。
     * 手机与话筒按 `device_kind` 签死;别的(含老的 `other`)一个字不动,原样用客户端报的。
     */
    const attributes = channelAttributesOf(parsed.attributes, row.device_kind);
    const token = signLivekitToken({
      apiKey: channel.livekit.apiKey,
      apiSecret: channel.livekit.apiSecret,
      identity: parsed.identity,
      grant: parsed.kind === 'admin' ? roomAdminGrant(room) : joinGrant(room),
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(attributes === undefined ? {} : { attributes }),
      ttlSeconds: parsed.ttlSeconds,
      nowSeconds,
    });
    // 日志里只有 prefix、身份与种类 —— 没有令牌、没有 secret、没有签出来的那一串。
    log(`channel-token prefix=${row.prefix} identity=${parsed.identity} kind=${parsed.kind} ttl=${parsed.ttlSeconds}`);
    res.json({
      url: channel.livekit.url,
      room,
      identity: parsed.identity,
      token,
      expires_at: nowSeconds + parsed.ttlSeconds,
    });
  });

  /* ──────────────────── 远程错误上报(2026-09-22) ──────────────────── */

  /**
   * 用户那台机器出了错,报一条过来。
   *
   * 门与 /v1/channel-credentials 同一道:**只认设备令牌,不看 token 额度** ——
   * 报错跟他今天问了模型多少字毫无关系,而且额度用完的那一刻恰恰是最需要报错的时候。
   *
   * 三道闸,顺序有讲究:
   *   ① 认设备(deviceOf);
   *   ② 形状(parseDiagReport:组件与种类是闭集,别的读不懂就当没说);
   *   ③ 限频(每台设备每小时 DIAG_PER_HOUR 条)。
   *
   * **为什么限频排在解析后面**:429 的回包里要说清"多久之后能再来",而那个数
   * 跟解析结果无关 —— 但先解析能保证一条形状就不对的请求不会占掉一个名额。
   *
   * 日志里只有 prefix、组件、种类与编号 —— **没有报错正文**。正文里可能有路径与文件名,
   * 它们该躺在库里(30 天后自动消失),不该躺在 journald 里(那儿谁也不会去清)。
   */
  app.post('/v1/diag/report', (req, res) => {
    const row = deviceOf(req, res);
    if (row === undefined) return;
    const parsed = parseDiagReport(req.body);
    if (!parsed.ok) {
      oaiError(res, parsed.status, parsed.error, 'invalid_request_error', parsed.code);
      return;
    }
    const at = now();
    const windowStart = new Date(at.getTime() - 3_600_000);
    const used = countDiagReportsSince(db, row.token_hash, windowStart);
    if (used >= DIAG_PER_HOUR) {
      // 顺手清一次过期的。这条路是"出事时才走"的,所以清理挂在它身上不花钱。
      pruneDiagReports(db, at);
      res.status(429).json({
        error: {
          message: `这台设备这一小时已经报了 ${used} 条(上限 ${DIAG_PER_HOUR})。先合并计数,下一小时再报。`,
          type: 'rate_limit_exceeded',
          code: 'diag_rate_limited',
        },
        retry_after_seconds: 3600,
      });
      return;
    }
    const id = insertDiagReport(db, {
      tokenHash: row.token_hash,
      account: row.account,
      deviceId: row.device_id,
      prefix: row.prefix,
      report: parsed.value,
      now: at,
    });
    pruneDiagReports(db, at);
    log(`diag-report prefix=${row.prefix} component=${parsed.value.component} kind=${parsed.value.kind}`
      + ` code=${parsed.value.code === '' ? '-' : parsed.value.code} merged=${parsed.value.merged}`);
    res.json({ id, remaining_this_hour: Math.max(0, DIAG_PER_HOUR - used - 1) });
  });

  /**
   * 统筹把报错拉下来看。**只认管理员令牌**(`RELAY_ADMIN_TOKEN`)。
   *
   * ## 为什么不用 /admin/* 那条"只认回环"的老路
   *
   * 老路挂在 `/admin` 前缀下,而 Caddy **不放行** `/admin/*`(只放行 `/v1/*`、
   * `/register-device`、`/health`、`/updates/*`)。挂在那儿就只能在服务器上 curl,
   * 那正好是统筹要走的路 —— 但 `/v1/diag/report` 必须走公网,两条路挨着放在同一个
   * 前缀下,读和写的规矩才好在一处说清。
   *
   * 于是这条挂在 `/v1` 下面、**自己带一把钥匙**。回环不算数:`/v1/*` 经过 Caddy 过来时
   * 看着就像本机(app.cjs 文件头那一段),拿回环当门等于没有门。
   *
   * 没配 `RELAY_ADMIN_TOKEN` 时这条路 **503**,不是"谁都能看" ——
   * 一个还没配好的服务器不该悄悄把所有人的报错摆在公网上。
   */
  app.get('/v1/diag/reports', (req, res) => {
    if (config.adminToken === undefined) {
      oaiError(
        res, 503,
        '这台服务器还没配 RELAY_ADMIN_TOKEN,报错查询关着。',
        'server_error', 'admin_not_configured',
      );
      return;
    }
    if (!adminTokenMatches(config.adminToken, bearerOf(req.headers.authorization))) {
      // 「没带」与「带错了」说同一句话 —— 不给猜的人送信息(同 findToken 那条规矩)。
      oaiError(res, 403, '这条路要管理员令牌。', 'invalid_request_error', 'admin_token_required');
      return;
    }
    const at = now();
    pruneDiagReports(db, at);
    const device = nonEmptyString(req.query?.device, 128);
    const account = nonEmptyString(req.query?.account, 64);
    /**
     * 只看某一类(2026-09-28,卡 FB):`?kind=feedback` 是统筹拉「用户反馈给开发者」那一份
     * (工作台本体的毛病 —— 界面 / 功能 / bug —— 不派用户自己的 Agent 改,整理成一条发到这儿)。
     * 认不出的值**当没筛**,不报错:一个拼错的筛选条件不该让这条路整个失败。
     */
    const kindRaw = nonEmptyString(req.query?.kind, 32);
    const kind = kindRaw !== undefined && DIAG_KINDS.includes(kindRaw) ? kindRaw : undefined;
    const limitRaw = Number.parseInt(String(req.query?.limit ?? ''), 10);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const rows = diagReportRows(db, {
      ...(device === undefined ? {} : { device }),
      ...(account === undefined ? {} : { account }),
      ...(kind === undefined ? {} : { kind }),
      limit,
    });
    res.json({ rows, retention_days: DIAG_RETENTION_DAYS, hourly_limit: DIAG_PER_HOUR });
  });

  /* ──────────────────── 诊断包存放位(2026-10-21) ──────────────────── */

  /** 只读 zip、读到上限为止。**认完设备才调它**:陌生人不该白传几十兆进来。 */
  const readPackBody = express.raw({ type: 'application/zip', limit: DIAG_PACK_MAX_BYTES });
  const packLimitMb = Math.round(DIAG_PACK_MAX_BYTES / 1024 / 1024);

  /**
   * 电脑把打好的诊断包传上来(手机或电脑上那颗「发诊断包」)。门与 /v1/diag/report 同一道:
   * **只认设备令牌,不看模型额度**。回六位编号,她念给统筹 / 统筹拿它来取。
   * 日志里只有 prefix、大小与编号 —— 没有内容(中转从不打开这个包)。
   */
  app.post('/v1/diag/pack', (req, res) => {
    const row = deviceOf(req, res);
    if (row === undefined) return;
    if (!req.is('application/zip')) {
      oaiError(res, 415, '诊断包要是一个 zip(content-type: application/zip)。', 'invalid_request_error', 'diag_pack_not_zip');
      return;
    }
    readPackBody(req, res, (error) => {
      if (error !== undefined && error !== null) {
        if (error.type === 'entity.too.large') {
          oaiError(res, 413, `诊断包太大了(上限 ${packLimitMb}MB)。在电脑上导出到桌面,再用别的办法传。`, 'invalid_request_error', 'diag_pack_too_large');
        }
        else oaiError(res, 400, '诊断包没读完整,再传一次。', 'invalid_request_error', 'diag_pack_unreadable');
        return;
      }
      if (!looksLikeZip(req.body)) {
        oaiError(res, 400, '传上来的不是 zip。', 'invalid_request_error', 'diag_pack_not_zip');
        return;
      }
      const at = now();
      pruneDiagPacks(db, config.diagPacksDir, at);
      const used = countDiagPacksSince(db, row.token_hash, new Date(at.getTime() - 86_400_000));
      if (used >= DIAG_PACK_PER_DAY) {
        oaiError(res, 429, `这台设备今天已经传了 ${used} 个诊断包(上限 ${DIAG_PACK_PER_DAY})。明天再传,或者先把手上这几个的编号发给统筹。`, 'rate_limit_exceeded', 'diag_pack_rate_limited');
        return;
      }
      const version = nonEmptyString(req.headers['x-workbench-version'], 32) ?? '';
      const stored = storeDiagPack(db, config.diagPacksDir, {
        tokenHash: row.token_hash,
        prefix: row.prefix,
        account: row.account,
        deviceId: row.device_id,
        version,
        bytes: req.body,
        now: at,
      });
      log(`diag-pack prefix=${row.prefix} code=${stored.code} bytes=${stored.bytes}`);
      res.json({ ...stored, retention_days: DIAG_PACK_RETENTION_DAYS });
    });
  });

  /**
   * 按编号取。管理员令牌(统筹)取谁的都行;设备令牌只取得到**自己账号**的。
   * 别人的、不存在的、过期的说同一句 404 —— 不给猜编号的人送信息。
   */
  app.get('/v1/diag/pack/:code', (req, res) => {
    const bearer = bearerOf(req.headers.authorization);
    const admin = adminTokenMatches(config.adminToken, bearer);
    const device = admin ? undefined : findToken(db, bearer);
    if (!admin && device === undefined) {
      oaiError(res, 401, '取诊断包要设备令牌或管理员令牌。', 'invalid_request_error', 'invalid_relay_token');
      return;
    }
    const at = now();
    pruneDiagPacks(db, config.diagPacksDir, at);
    const code = normalizeDiagPackCode(req.params.code);
    const pack = code === undefined ? undefined : findDiagPack(db, code, at);
    const mine = pack !== undefined && (admin || pack.account === device.account);
    if (!mine) {
      oaiError(res, 404, '没有这个编号的诊断包(可能抄错了,或者已经过了 7 天被清掉了)。', 'invalid_request_error', 'diag_pack_not_found');
      return;
    }
    let bytes;
    try { bytes = fs.readFileSync(packFileOf(config.diagPacksDir, pack.code)); }
    catch {
      oaiError(res, 404, '没有这个编号的诊断包(可能抄错了,或者已经过了 7 天被清掉了)。', 'invalid_request_error', 'diag_pack_not_found');
      return;
    }
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="diag-${pack.code}.zip"`);
    res.setHeader('x-diag-pack-version', pack.version);
    res.setHeader('x-diag-pack-received-at', pack.received_at);
    res.setHeader('x-diag-pack-sha256', pack.sha256);
    if (admin) res.setHeader('x-diag-pack-device', pack.device_id);
    res.end(bytes);
  });

  /* ─────────────────────────── 账号(2026-09-21) ─────────────────────────── */

  /**
   * 代发一次网页搜索(2026-09-21,资讯与播客那张卡)。
   *
   * 门与 /v1/channel-credentials 同一道:**只认设备令牌,不看 token 额度**——
   * 搜索花的是搜索服务的钱,跟他今天问了模型多少字没有关系。额度是**按次、按天**
   * 另算的一本账(search_daily 表)。
   *
   * 上游 Key 一个字符都不出这台机器;错误里也不带上游原话(理由同 chat)。
   * 服务器上没配搜索时 **503 + `search_not_configured`** —— 工作台那一侧据此让整块
   * 资讯如实缺席,不摆空壳、不编条目。
   */
  app.post('/v1/search', async (req, res) => {
    const row = deviceOf(req, res);
    if (row === undefined) return;
    if (!searchConfigured(config.search)) {
      oaiError(
        res, 503,
        '这台服务器还没配搜索服务,资讯这一块暂时用不了。',
        'server_error', 'search_not_configured',
      );
      return;
    }
    const parsed = parseSearchRequest(req.body);
    if (!parsed.ok) {
      oaiError(res, parsed.status, parsed.error, 'invalid_request_error', parsed.code);
      return;
    }
    const day = dayKey(now(), config.dayOffsetMinutes);
    const used = searchOfDay(db, row.token_hash, day);
    if (used.requests >= config.search.dailyLimit) {
      oaiError(
        res, 429,
        `今天的搜索次数用完了(已用 ${used.requests} / 今日 ${config.search.dailyLimit})。明天零点自动恢复。`,
        'rate_limit_exceeded', 'search_quota_exceeded',
      );
      return;
    }
    // 先记后发:一次调用在搜索服务那边多半已经计了费,失败也得算在他头上,
    // 否则一条打不通的上游会变成"无限次免费重试"。
    recordSearch(db, row.token_hash, day);
    const out = await searchUpstream({
      config: config.search, query: parsed.query, count: parsed.count,
      ...(parsed.freshness === undefined ? {} : { freshness: parsed.freshness }),
      fetchImpl,
    });
    // 日志里只有 prefix、要了几条、回了几条 —— 没有令牌、没有 Key、**也没有他搜了什么**。
    log(`search prefix=${row.prefix} count=${parsed.count} ok=${out.ok ? 1 : 0} results=${out.ok ? out.results.length : 0}`);
    if (!out.ok) {
      oaiError(res, out.status, out.error, 'server_error', 'search_upstream_failed');
      return;
    }
    res.json({
      results: out.results,
      day,
      daily_limit: config.search.dailyLimit,
      used: used.requests + 1,
    });
  });

  /**
   * 认会话令牌。认不出一律同一句话、同一个状态码(同设备令牌那条规矩)。
   * 回的是 `{ session, account }`。
   */
  function sessionOf(req, res) {
    const found = findSession(db, bearerOf(req.headers.authorization));
    if (found === undefined) {
      oaiError(
        res, 401,
        '登录状态不认识或已失效(可能是在别的设备上把这台移除了)。重新登录一次就好。',
        'invalid_request_error', 'invalid_account_session',
      );
      return undefined;
    }
    return found;
  }

  /** 登录失败的计数与锁。按标识分桶,理由见 accounts.cjs。 */
  const loginGuard = createLoginGuard();

  /**
   * **按 IP 数失败次数**的第二道闸。
   *
   * 按标识那一道挡的是"盯着一个账号猜密码";它挡不住"拿一个常见密码去撞一千个邮箱"
   * —— 那种打法每个标识只错一次,永远触不到 5 次那条线。
   * 所以这里再加一道:**只有失败才记一笔**,成功不记(正常人不会因为登录成功被限)。
   * 额度给得比领令牌宽三倍:一个家里可能有几台设备、还有人会连着输错几次。
   */
  const loginFailureLimiter = createFailureLimiter({ perHour: config.registerPerHour * 3 });

  function lockedReply(res, untilMs) {
    oaiError(
      res, 429,
      `密码连续错 ${MAX_LOGIN_ATTEMPTS} 次,${Math.ceil((untilMs - now().getTime()) / 60_000)} 分钟内不再接受登录。`,
      'rate_limit_exceeded', 'account_locked',
    );
  }

  /**
   * 注册。回一张会话令牌 —— 注册完就是登录状态(与电脑端本机那一份同一口径:
   * 「注册完直接算登录」,不让人刚填完表又填一次)。
   *
   * 邮箱/手机号**这一版不验证真伪**(理由见 accounts.cjs 文件头):Ben 那台上已经有一份
   * 本机账号,迁移时要原样带着他起的名字过来,现在就收紧等于把唯一的存量用户挡在门外。
   */
  app.post('/v1/account/register', async (req, res) => {
    const identifier = identifierFrom(req.body);
    if (!identifier.ok) { oaiError(res, 400, identifier.error, 'invalid_request_error'); return; }
    const password = checkPassword(req.body?.password);
    if (!password.ok) { oaiError(res, 400, password.error, 'invalid_request_error'); return; }
    if (!registerLimiter.take(clientIp(req), now().getTime())) {
      oaiError(res, 429, '注册太频繁了,过一会儿再试。', 'rate_limit_exceeded', 'register_rate_limited');
      return;
    }
    const created = await createAccount(db, { identifier: identifier.value, password: password.value, now: now() });
    if (!created.ok) {
      oaiError(res, 409, '这个邮箱/手机号已经注册过了,直接登录就行。', 'invalid_request_error', 'account_exists');
      return;
    }
    const session = issueSession(db, { accountId: created.account.id, now: now() });
    // 日志里只有账号 id 与会话 prefix —— 没有标识本身(它是个人信息)、没有令牌。
    log(`account-register id=${created.account.id} session=${session.prefix}`);
    res.status(201).json({
      session_token: session.token,
      account: accountView(created.account),
    });
  });

  /**
   * 登录。用户名错与密码错**回同一句话** —— 分开说等于告诉人"这个邮箱注册过"。
   * 账号不存在时也照样算一次 scrypt(accounts.cjs 里那一行),否则从响应时间就能看出来。
   */
  app.post('/v1/account/login', async (req, res) => {
    const identifier = identifierFrom(req.body);
    if (!identifier.ok) { oaiError(res, 400, identifier.error, 'invalid_request_error'); return; }
    if (typeof req.body?.password !== 'string' || req.body.password === '') {
      oaiError(res, 400, '密码不能是空的。', 'invalid_request_error');
      return;
    }
    const lockedUntil = loginGuard.lockedUntil(identifier.value, now().getTime());
    if (lockedUntil !== undefined) { lockedReply(res, lockedUntil); return; }
    if (loginFailureLimiter.blocked(clientIp(req), now().getTime())) {
      oaiError(res, 429, '登录尝试太频繁了,过一会儿再试。', 'rate_limit_exceeded', 'login_rate_limited');
      return;
    }

    const account = findAccountByIdentifier(db, identifier.value);
    const good = await verifyAccountPassword(account, req.body.password);
    if (!good) {
      loginFailureLimiter.note(clientIp(req), now().getTime());
      const until = loginGuard.wrong(identifier.value, now().getTime());
      if (until !== undefined) { lockedReply(res, until); return; }
      oaiError(res, 401, '邮箱/手机号或密码不对。', 'invalid_request_error', 'bad_credentials');
      return;
    }
    loginGuard.ok(identifier.value);
    const session = issueSession(db, { accountId: account.id, now: now() });
    log(`account-login id=${account.id} session=${session.prefix}`);
    res.json({ session_token: session.token, account: accountView(account) });
  });

  /**
   * 登出 = 把**这一张**会话令牌吊销(别的设备上的登录态不受影响)。
   * 认不出那张也回 ok:登出这件事没有"失败"这个状态,人要的只是"我下线了"。
   */
  app.post('/v1/account/logout', (req, res) => {
    const revoked = revokeSession(db, bearerOf(req.headers.authorization), now());
    res.json({ ok: true, revoked });
  });

  /**
   * 改密码(要会话令牌 + 说得出当前密码)。改完**把别的会话全吊销**,只留这一张 ——
   * 改密码的常见动机是"我怀疑别人登着我的账号",不撤别处等于这一下白做。
   */
  app.post('/v1/account/password', async (req, res) => {
    const found = sessionOf(req, res);
    if (found === undefined) return;
    if (typeof req.body?.current_password !== 'string' || req.body.current_password === '') {
      oaiError(res, 400, '改密码要先输入当前密码。', 'invalid_request_error');
      return;
    }
    const next = checkPassword(req.body?.password);
    if (!next.ok) { oaiError(res, 400, next.error, 'invalid_request_error'); return; }
    if (!(await verifyAccountPassword(found.account, req.body.current_password))) {
      oaiError(res, 401, '当前密码不对。', 'invalid_request_error', 'bad_credentials');
      return;
    }
    await setAccountPassword(db, found.account.id, next.value, now());
    const kept = bearerOf(req.headers.authorization);
    revokeOtherSessions(db, found.account.id, kept, now());
    log(`account-password id=${found.account.id}`);
    res.json({ ok: true });
  });

  app.get('/v1/account/me', (req, res) => {
    const found = sessionOf(req, res);
    if (found === undefined) return;
    res.json(accountView(found.account, { devices: devicesOfAccount(db, found.account.id).length }));
  });

  /**
   * 「我的设备」。回的每一行都**没有令牌、没有哈希**,只有:哪台、叫什么、什么类型、
   * 什么时候加的、上次什么时候在线。
   */
  app.get('/v1/account/devices', (req, res) => {
    const found = sessionOf(req, res);
    if (found === undefined) return;
    res.json({ devices: devicesOfAccount(db, found.account.id) });
  });

  /**
   * 移除一台设备。吊销它的设备令牌,于是它既发不了模型请求,也签不出进房凭证 ——
   * **这是"把手机丢了"时唯一要按的那颗按钮**。
   *
   * 传一个不属于本账号的 device_id 进来回的是 `removed: 0`,不是报错:
   * 报错等于告诉人"这个 device_id 在别的账号里存在"。
   */
  app.post('/v1/account/devices/revoke', (req, res) => {
    const found = sessionOf(req, res);
    if (found === undefined) return;
    const deviceId = nonEmptyString(req.body?.device_id, 128);
    if (deviceId === undefined) {
      oaiError(res, 400, 'device_id 要是非空字符串。', 'invalid_request_error');
      return;
    }
    const removed = revokeDevice(db, found.account.id, deviceId, now());
    log(`account-device-revoke id=${found.account.id} removed=${removed}`);
    res.json({ ok: true, removed, devices: devicesOfAccount(db, found.account.id) });
  });

  /**
   * 这台设备领令牌。**2026-09-21 起要账号会话** —— 这一条就是上一张卡留下的那个洞的补丁。
   *
   * 以前:`{account: "随便写", device_id}` 就发,于是房间名(`wb-<sha256(账号)>`)
   * 绑在一个没人验过的字符串上,知道别人账号名的人能领一张自己的令牌、进别人的房。
   * 现在:设备记在**账号 id** 名下(`acct:<16 字节随机>`),房间由它算 —— 猜不出来。
   *
   * ## 老客户端怎么办(`RELAY_ALLOW_LEGACY_REGISTER`,默认开)
   *
   * 部署这一版的那一刻,Ben 那台 Mac 上跑的还是旧插件,它发的仍然是
   * `{account, device_id}`。直接 401 等于"部署完他的模型服务与电话当场全挂",
   * 所以留一条兼容路:没带会话、但带了 `account` 时照旧发一把令牌,**行为与这张卡之前
   * 一模一样**(房间由那个名字算)。
   *
   * 它不会把新洞带进来:老路算出来的房间与新账号算出来的房间**永远不是同一间**
   * (一个是 `sha256("ben")`,一个是 `sha256("acct:<随机 id>")`),所以
   * 「用老路进新账号的房」做不到。留下的只是老账号之间的那个旧洞,而它随着
   * 客户端升级自己就没了。全网升完之后把 `RELAY_ALLOW_LEGACY_REGISTER=0` 一写,
   * 这条路彻底关掉 —— 那是 Ben 拍板的一刀,不是代码替他拍的。
   */
  app.post('/register-device', (req, res) => {
    const deviceId = nonEmptyString(req.body?.device_id, 128);
    if (deviceId === undefined) {
      oaiError(res, 400, 'device_id 要是非空字符串。', 'invalid_request_error');
      return;
    }
    const name = checkDeviceName(req.body?.name);
    if (!name.ok) { oaiError(res, 400, name.error, 'invalid_request_error'); return; }
    const kind = checkDeviceKind(req.body?.kind);
    if (!kind.ok) { oaiError(res, 400, kind.error, 'invalid_request_error'); return; }

    const bearer = bearerOf(req.headers.authorization);
    const found = bearer === undefined ? undefined : findSession(db, bearer);

    let account;
    let logWho;
    if (found !== undefined) {
      account = accountScopeOf(found.account.id);
      logWho = `account=${found.account.id}`;
    }
    else if (bearer !== undefined) {
      // 带了个认不出的会话令牌:这是"登录过期了",不是"没登录"。**不退回老路** ——
      // 悄悄用 body 里那个名字发一把,等于在用户以为自己登着的时候把他挪进另一间房。
      oaiError(
        res, 401,
        '登录状态不认识或已失效。重新登录一次就好。',
        'invalid_request_error', 'invalid_account_session',
      );
      return;
    }
    else {
      const legacy = nonEmptyString(req.body?.account, 64);
      if (!config.allowLegacyRegister || legacy === undefined) {
        oaiError(
          res, 401,
          '领设备令牌要先登录账号(POST /v1/account/login),再带着会话令牌来领。',
          'invalid_request_error', 'account_session_required',
        );
        return;
      }
      account = legacy;
      logWho = 'legacy';
    }

    if (!registerLimiter.take(clientIp(req), now().getTime())) {
      oaiError(res, 429, '领取太频繁了,过一会儿再试。', 'rate_limit_exceeded', 'register_rate_limited');
      return;
    }
    // 同一台设备重领不算新设备(issueToken 会把它自己那把旧的作废),所以先查再发。
    const existing = db.prepare(
      'SELECT 1 FROM tokens WHERE account = ? AND device_id = ? AND revoked_at IS NULL',
    ).get(account, deviceId);
    if (existing === undefined && activeTokenCount(db, account) >= config.maxDevicesPerAccount) {
      oaiError(
        res, 429,
        `一个账号最多 ${config.maxDevicesPerAccount} 台设备。要换设备的话,先在「设置 → 我的设备」里移除一台。`,
        'invalid_request_error', 'too_many_devices',
      );
      return;
    }
    const issued = issueToken(db, {
      account,
      deviceId,
      dailyTokenLimit: config.dailyTokenLimit,
      ...(name.value === undefined ? {} : { deviceName: name.value }),
      ...(found === undefined && kind.value === 'other' ? {} : { deviceKind: kind.value }),
      now: now(),
    });
    // 日志里没有账号标识本身(个人信息)、没有令牌,只有账号 id 与 prefix。
    log(`register-device ${logWho} prefix=${issued.prefix}`);
    // token 明文只在这一次的响应体里出现。
    res.status(201).json(issued);
  });

  /**
   * 上游的模型目录。`?provider=openai|doubao|deepseek` 指定哪一家,**缺省 DeepSeek**
   * (老客户端不带这个参数,行为一个字没变)。认不出的家名当场 400 ——
   * 悄悄按缺省走的话,他会以为自己看的是 OpenAI 的目录。
   */
  app.get('/v1/models', async (req, res) => {
    const gated = gate(req, res);
    if (gated === undefined) return;
    const asked = typeof req.query?.provider === 'string' ? req.query.provider : undefined;
    if (asked !== undefined && !PROVIDERS.includes(asked)) {
      oaiError(res, 400, `不认识的上游:${asked}(只有 ${PROVIDERS.join(' / ')})`, 'invalid_request_error');
      return;
    }
    const provider = asked ?? 'deepseek';
    const up = providerUpstream(config, provider);
    if (up === undefined) {
      oaiError(res, 503, notConfiguredMessage(provider), 'server_error', notConfiguredCode(provider));
      return;
    }
    const upstream = await fetchModels({ url: up.modelsUrl, upstreamKey: up.key, fetchImpl });
    res.status(upstream.status).type('application/json').send(upstream.text);
  });

  /**
   * 图片生成(2026-09-22)。**固定转 OpenAI**:运营白板上那句分工写的就是
   * 「GPT 负责文本与图片生成」,豆包与 DeepSeek 这条路今天没有,所以这里不按模型名分家 ——
   * 分了也只有一家,多一层只会多一处会漂的判断。
   *
   * 记账:图片接口**不回 token 用量**,所以这一次只加一次 `requests`、token 加 0
   * (上游哪天真回了 usage 就照记 —— `out.usage` 有什么记什么,不猜不估)。
   * 于是**图片不吃 token 额度,但看得见"今天生成过几张"**;要给图片单独限量是另一件事,
   * 那得先有一本按张计费的账,这一版没有(如实写在交接的「没做的」里)。
   */
  app.post('/v1/images', async (req, res) => {
    const gated = gate(req, res);
    if (gated === undefined) return;
    const { row, day } = gated;
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      oaiError(res, 400, '请求体要是一个 JSON 对象。', 'invalid_request_error');
      return;
    }
    const up = providerUpstream(config, 'openai');
    if (up === undefined) {
      oaiError(res, 503, notConfiguredMessage('openai'), 'server_error', notConfiguredCode('openai'));
      return;
    }
    try {
      const out = await forwardJson({ url: up.imagesUrl, upstreamKey: up.key, body, fetchImpl });
      record(row, day, out.usage, 'openai', body.model);
      log(`images prefix=${row.prefix} status=${out.status}`);
      res.status(out.status).set(out.headers).send(out.text);
    }
    catch (error) {
      log(`images prefix=${row.prefix} failed: ${String(error?.name ?? 'Error')}`);
      record(row, day, undefined, 'openai', body.model);
      oaiError(res, 502, '图片服务这会儿连不上上游,请稍后再试。', 'server_error', 'upstream_unreachable');
    }
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const gated = gate(req, res);
    if (gated === undefined) return;
    const { row, day } = gated;

    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      oaiError(res, 400, '请求体要是一个 JSON 对象。', 'invalid_request_error');
      return;
    }

    /**
     * 按模型名挑一家(2026-09-22)。没配那家就在这里 503,**不改发给别家**。
     * 豆包还要把模型名换成接入点 id(`resolveUpstreamModel`);别家原样。
     */
    const up = upstreamFor(res, body.model);
    if (up === undefined) return;
    const url = up.chatUrl;
    const model = resolveUpstreamModel(up.provider, body.model, up.endpoints);
    // 只有真换了才动请求体 —— 「不改内容」那条纪律(upstream.cjs 文件头第 2 条)只让这一处例外。
    const outgoing = model === body.model ? body : { ...body, model };
    const streaming = body.stream === true;

    try {
      if (!streaming) {
        const out = await forwardJson({ url, upstreamKey: up.key, body: outgoing, fetchImpl });
        const cost = record(row, day, out.usage, up.provider, body.model);
        log(`chat prefix=${row.prefix} to=${up.provider} stream=0 status=${out.status} tokens=${out.usage?.total_tokens ?? 0} hit=${cost.hit} cny=${cost.cost_cny}`);
        res.status(out.status).set(out.headers).send(out.text);
        return;
      }

      const usage = await forwardStream({
        url,
        upstreamKey: up.key,
        body: withUsageOptions(outgoing),
        fetchImpl,
        onHead: (status, headers) => { res.status(status).set(headers); res.flushHeaders?.(); },
        onChunk: (bytes) => { res.write(bytes); },
      });
      const cost = record(row, day, usage, up.provider, body.model);
      log(`chat prefix=${row.prefix} to=${up.provider} stream=1 tokens=${usage?.total_tokens ?? 0} hit=${cost.hit} cny=${cost.cost_cny}`);
      res.end();
    }
    catch (error) {
      // 连不上上游、上游中途断线。**错误信息里不带 error.message**——它可能把 URL、
      // 甚至带着鉴权头的请求细节抖出来。真相只进服务器日志。
      log(`chat prefix=${row.prefix} to=${up.provider} failed: ${String(error?.name ?? 'Error')}`);
      record(row, day, undefined, up.provider, body.model);
      if (res.headersSent) { res.end(); return; }
      oaiError(res, 502, '模型服务这会儿连不上上游,请稍后再试。', 'server_error', 'upstream_unreachable');
    }
  });

  // 协作区跨机底座(工作室、收件箱、对象目录、频道、定时派活回调、企微机器人),路由与规则见 collabRoutes.cjs。
  mountCollab(app, { db, config, now, fetchImpl, log, deviceOf, sessionOf });

  /** 管理面:只认回环(理由见文件头)。 */
  function adminGate(req, res) {
    if (isLoopbackRequest(req)) return true;
    oaiError(res, 403, '管理接口只能在服务器本机调用。', 'invalid_request_error', 'admin_loopback_only');
    return false;
  }

  app.post('/admin/tokens', (req, res) => {
    if (!adminGate(req, res)) return;
    const account = nonEmptyString(req.body?.account, 64);
    const deviceId = nonEmptyString(req.body?.device_id, 128) ?? 'manual';
    if (account === undefined) {
      oaiError(res, 400, 'account 要是非空字符串。', 'invalid_request_error');
      return;
    }
    const limit = Number.isInteger(req.body?.daily_token_limit) && req.body.daily_token_limit > 0
      ? req.body.daily_token_limit
      : config.dailyTokenLimit;
    const issued = issueToken(db, { account, deviceId, dailyTokenLimit: limit, now: now() });
    log(`admin issue account=${account} prefix=${issued.prefix}`);
    res.status(201).json(issued);
  });

  app.post('/admin/tokens/revoke', (req, res) => {
    if (!adminGate(req, res)) return;
    const prefix = nonEmptyString(req.body?.prefix, 32);
    if (prefix === undefined) {
      oaiError(res, 400, 'prefix 要是非空字符串(在 /admin/usage 里看得到)。', 'invalid_request_error');
      return;
    }
    const revoked = revokeByPrefix(db, prefix, now());
    res.json({ revoked });
  });

  app.get('/admin/usage', (req, res) => {
    if (!adminGate(req, res)) return;
    const day = nonEmptyString(req.query?.day, 10) ?? dayKey(now(), config.dayOffsetMinutes);
    res.json({ day, daily_cost_limit_cny: costLimitCny, rows: usageReport(db, day) });
  });

  return app;
}

module.exports = { createApp, createRateLimiter, isLoopbackRequest, createUsageSniffer };
