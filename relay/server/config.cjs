'use strict';

// 中转的全部可配项。**一个密钥都不在这个文件里**——上游 Key 只从环境变量读,
// 生产上由 Ben 写进 /opt/relay/.env(0600),systemd 用 EnvironmentFile 喂给进程。
//
// 为什么上游 Key 只走环境变量:它是整台服务里唯一一件「泄了要赔钱」的东西。
// 不落我们自己的库、不进任何接口的返回、不进日志——连「配了没有」都只回布尔。
//
// 2026-09-21 起这里不止一把钥匙了:LiveKit 的 api key / secret 与火山的 ASR/TTS 凭据
// 也搬进了同一份 .env(`RELAY_CHANNEL_*`,形状见 server/channel.cjs)。
// 规矩没变:值只从环境变量读,LiveKit 那对**永远不出这台机器**,火山那两样出去时
// 带到期时间、约定只存内存。
//
// 默认端口 8795:这台机器上 7880 是 LiveKit、80/443 是 Caddy;中转只监听回环,
// 外面那一层由 Caddy 的 api.aibooo.cn 反代进来(deploy/aliyun-relay-setup.sh)。

const os = require('node:os');
const path = require('node:path');

const { relayChannelConfigOf } = require('./channel.cjs');
const { relayProvidersConfigOf } = require('./providers.cjs');
const { relaySearchConfigOf } = require('./search.cjs');
const { relayPricesConfigOf } = require('./pricing.cjs');
const { wecomConfigOf } = require('./wecom.cjs');

const DEFAULT_PORT = 8795;
const DEFAULT_UPSTREAM_URL = 'https://api.deepseek.com';
/**
 * **已废弃(2026-09-23)**:每个令牌每天的 token 上限。额度改按元算之后它不再拦任何请求,
 * 只还写进 tokens.daily_token_limit 那一列(那列 NOT NULL,老客户端也还读 /v1/usage 里的它)。
 * 服务器 .env 里若还写着 `RELAY_DAILY_TOKEN_LIMIT`,启动日志与 /health 会各说一句「已废弃、被忽略」。
 */
const DEFAULT_DAILY_TOKEN_LIMIT = 500_000;
/**
 * 每个令牌(= 每台设备)每天最多花多少**元**(2026-09-23 维护者拍板:缺省 5 元)。
 * 怎么把一次请求折成元见 server/pricing.cjs。要调就改 .env 的 RELAY_DAILY_COST_LIMIT_CNY。
 */
const DEFAULT_DAILY_COST_LIMIT_CNY = 5;
/** 同一个 IP 一小时最多领几个令牌。领令牌这条路是开放的,必须有闸。 */
const DEFAULT_REGISTER_PER_HOUR = 10;
/** 一个账号最多同时有几个活着的令牌(= 几台设备)。 */
const DEFAULT_MAX_DEVICES_PER_ACCOUNT = 10;
/**
 * 老客户端那条「不带账号会话就领令牌」的路还开着吗(2026-09-21)。
 *
 * **默认开**:部署这一版的那一刻,用户那台 Mac 上跑的还是旧插件,关掉等于
 * 部署完他的模型服务与电话当场全挂。全网升完之后写 `RELAY_ALLOW_LEGACY_REGISTER=0`
 * 把它关死 —— 那一刀由人拍板,不由代码替他拍(理由全文在 app.cjs 的 /register-device)。
 */
const DEFAULT_ALLOW_LEGACY_REGISTER = true;
/**
 * 算「今天」用哪个时区。中国用户,零点要是他们的零点,不是 UTC 的。
 * 存的是分钟偏移,免得依赖 tzdata。
 */
const DEFAULT_DAY_OFFSET_MINUTES = 8 * 60;
/**
 * 工作室收件箱的保留期(2026-10-20,卡 C;待拍板 2 的建议):事件 30 天(= v3 §5.2.4 续流保留窗)、
 * 已办完的请求 7 天;没办的请求不过期(权威写入方离线两周回来仍要办),所以没有那一格。
 */
const DEFAULT_INBOX_EVENT_DAYS = 30;
const DEFAULT_INBOX_DONE_REQUEST_DAYS = 7;
/** 长轮询最多挂多少秒(待拍板 4 的建议:长轮询,25 秒)。 */
const DEFAULT_INBOX_MAX_WAIT_SECONDS = 25;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function intOf(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 正整数;缺席、写坏、写 0 都回落缺省。 */
function positiveIntOf(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 正的有限小数;缺席、写坏、写 0 或负数都回落缺省 —— 上限 0 等于全网断模型,不该是一个手滑能写出来的值。 */
function positiveNumberOf(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `0` / `false` / `no` / `off` 算关,别的(含缺席)按默认。**只有明写才关得掉** —— 
 * 拼错一个变量名就把兼容路关了,那是部署时最不该发生的事。 */
function boolOf(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

/** 去掉末尾斜杠——后面一律 `${base}/v1/...` 拼,双斜杠会让某些网关 404。 */
function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

/**
 * 环境变量 → 配置。**不校验上游 Key 在不在**:缺了照样能起(/health 会说「上游未配置」),
 * 这样部署时先起服务再填 .env 也不至于让 systemd 反复重启。真正要用时才 503 + 一句人话。
 */
function relayConfigOf(env = process.env) {
  const pricesOf = relayPricesConfigOf(env);
  const home = text(env.RELAY_HOME) ?? '/var/lib/relay';
  return {
    port: intOf(env.RELAY_PORT, DEFAULT_PORT),
    bind: text(env.RELAY_BIND) ?? '127.0.0.1',
    dbPath: text(env.RELAY_DB_PATH) ?? path.join(home, 'relay.sqlite'),
    // 热更新的产物目录(2026-09-18)。**只读**:中转只负责把它发出去,写是 Mac 上的
    // deploy/publish-update.sh 用 rsync 推上来的。放在 RELAY_HOME 底下,跟库同一棵树,
    // systemd 单元里 ReadWritePaths 已经圈着它。
    updatesDir: text(env.RELAY_UPDATES_DIR) ?? path.join(home, 'updates'),
    // 诊断包存放位(2026-10-21,server/diagPacks.cjs)。中转自己写、7 天自己清;同在 RELAY_HOME 底下。
    diagPacksDir: text(env.RELAY_DIAG_PACKS_DIR) ?? path.join(home, 'diag-packs'),
    upstreamUrl: trimSlash(text(env.RELAY_UPSTREAM_URL) ?? DEFAULT_UPSTREAM_URL),
    upstreamKey: text(env.RELAY_UPSTREAM_KEY),
    dailyTokenLimit: intOf(env.RELAY_DAILY_TOKEN_LIMIT, DEFAULT_DAILY_TOKEN_LIMIT),
    dailyCostLimitCny: positiveNumberOf(env.RELAY_DAILY_COST_LIMIT_CNY, DEFAULT_DAILY_COST_LIMIT_CNY),
    // 价格表(元 / 百万 tokens,三档)。来源与核对日期见 server/pricing.cjs 文件头。
    prices: pricesOf.tiers,
    /**
     * 启动时要大声说出来的几件事(写坏的价格、已废弃的变量)。**只是话,不拦启动**。
     * index.cjs 逐条打日志,/health 原样回 —— 升级后行为变了,得有地方看得见为什么。
     */
    warnings: [
      ...pricesOf.warnings,
      ...(text(env.RELAY_DAILY_TOKEN_LIMIT) === undefined ? [] : [
        'RELAY_DAILY_TOKEN_LIMIT 已废弃并被忽略:每日额度从 2026-09-23 起按元算,'
        + '改 RELAY_DAILY_COST_LIMIT_CNY(缺省 5 元),然后把 .env 里那一行删掉',
      ]),
    ],
    registerPerHour: intOf(env.RELAY_REGISTER_PER_HOUR, DEFAULT_REGISTER_PER_HOUR),
    maxDevicesPerAccount: intOf(env.RELAY_MAX_DEVICES_PER_ACCOUNT, DEFAULT_MAX_DEVICES_PER_ACCOUNT),
    dayOffsetMinutes: intOf(env.RELAY_DAY_OFFSET_MINUTES, DEFAULT_DAY_OFFSET_MINUTES),
    allowLegacyRegister: boolOf(env.RELAY_ALLOW_LEGACY_REGISTER, DEFAULT_ALLOW_LEGACY_REGISTER),
    // 工作室收件箱(卡 C 起;10-21 起由 collabRoutes.cjs 读)。写坏、写 0 都回落缺省 —— 保留 0 天等于每条事件一进来就被清掉。
    inboxEventDays: positiveIntOf(env.RELAY_INBOX_EVENT_DAYS, DEFAULT_INBOX_EVENT_DAYS),
    inboxDoneRequestDays: positiveIntOf(env.RELAY_INBOX_DONE_REQUEST_DAYS, DEFAULT_INBOX_DONE_REQUEST_DAYS),
    inboxMaxWaitSeconds: positiveIntOf(env.RELAY_INBOX_MAX_WAIT_SECONDS, DEFAULT_INBOX_MAX_WAIT_SECONDS),
    /**
     * 管理员令牌(2026-09-22,远程错误上报)。`GET /v1/diag/reports` 唯一的那道门。
     *
     * **没配就是那条路整个关着**(503),不是"谁都能看" —— 一个还没配好的服务器
     * 不该悄悄把所有人的报错摆在公网上。仓库里不出现任何真值:Ben 在
     * `/opt/relay/.env` 里 `nano` 一行 `RELAY_ADMIN_TOKEN=…`,重启中转即可。
     *
     * 为什么不复用 `/admin/*` 那条「只认回环」:那个前缀 Caddy 不放行,而
     * `/v1/diag/report`(写)必须走公网。读和写挨着放在同一个前缀下,规矩才好在一处说清。
     */
    adminToken: text(env.RELAY_ADMIN_TOKEN),
    // 通道层的钥匙串(2026-09-21)。一样不配也起得来:/v1/channel-credentials 会如实说「没配」。
    channel: relayChannelConfigOf(env),
    /**
     * 三家上游(2026-09-22,派活走接口那只手)。**DeepSeek 不在这里当真相源** ——
     * 它仍是上面那两个老字段(`upstreamUrl` / `upstreamKey`),存量部署的 .env 一个字不用改;
     * 这一格里的 `deepseek` 只是照着同样的变量读了一份,给 /health 报「配了没有」用。
     * 形状与规矩见 server/providers.cjs 的文件头。
     */
    providers: relayProvidersConfigOf(env),
    // 搜索代理(2026-09-21,资讯与播客)。同样不配也起得来:/v1/search 会 503 说「没配」,
    // 工作台那一侧据此**整块缺席**——资讯流不摆空壳、不编条目。
    search: relaySearchConfigOf(env),
    /**
     * 对外的根地址(2026-10-21):定时派活的回调地址要拼成公网能打进来的整串。
     * 不是密钥;缺省就是生产那台的反代域名。
     */
    publicUrl: trimSlash(text(env.RELAY_PUBLIC_URL) ?? 'https://api.aibooo.cn'),
    // 企业微信机器人的回调密钥(2026-10-21)。只从环境变量读,规矩见 server/wecom.cjs 文件头。
    wecom: wecomConfigOf(env),
  };
}

function defaultHome() {
  return process.env.RELAY_HOME || path.join(os.homedir(), '.relay');
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_URL,
  DEFAULT_DAILY_TOKEN_LIMIT,
  DEFAULT_DAILY_COST_LIMIT_CNY,
  DEFAULT_REGISTER_PER_HOUR,
  DEFAULT_MAX_DEVICES_PER_ACCOUNT,
  DEFAULT_DAY_OFFSET_MINUTES,
  DEFAULT_ALLOW_LEGACY_REGISTER,
  DEFAULT_INBOX_EVENT_DAYS,
  DEFAULT_INBOX_DONE_REQUEST_DAYS,
  DEFAULT_INBOX_MAX_WAIT_SECONDS,
  boolOf,
  relayConfigOf,
  defaultHome,
  trimSlash,
};
