'use strict';

// 用量:按令牌、按天记一行。额度就是拿这一行跟上限比。
//
// ## 2026-09-23 起额度按**元**比
//
// 每次请求按上游官方价折成人民币(微元整数,`cost_micro_cny`),缓存命中 / 未命中 / 输出三档
// 各自计价(pricing.cjs)。token 数照记,只作参考;拦不拦只看今天花的钱到没到上限。
//
// ## 「今天」是哪一天
//
// 用固定分钟偏移算(默认 +8),不依赖服务器的 TZ,也不依赖 tzdata。
// 理由:这台机器在阿里云上,时区可能是 UTC;而用户看到的「今天用了多少」
// 必须是他自己的今天。中国不实行夏令时,固定偏移就够,不用 Intl。
//
// ## 按家分开记(2026-09-22)
//
// 一行从「一个令牌 · 一天」变成「一个令牌 · 一天 · 一家上游」。**额度的口径没变**:
// 拿三家之和跟上限比。分家是为了 Ben 看得见钱花在谁身上(DeepSeek / OpenAI / 豆包)。
//
// ## 为什么先扣后发不成立
//
// 一次请求用多少 token 是**发完才知道**的。所以顺序只能是:发之前看「今天已经用了多少」,
// 超了就拦;发完把这一次的加上去。极端情况下最后一次会冲过上限一点点——
// 接受,总比为了精确而先冻结再结算要简单得多。

const { PROVIDERS } = require('./providers.cjs');
const { DEFAULT_PRICES_CNY, costMicroOf, microToCny, priceTierOf, splitUsage } = require('./pricing.cjs');

/** 用量行里要加总的那几列。usageOfDay / usageByProvider / usageReport 共用,免得三处各漏一列。 */
const SUM_COLUMNS = ['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_hit_tokens', 'cache_miss_tokens', 'cost_micro_cny'];

/** 一行库里的数 → 接口形状。`cost_cny` 是给人看的元;`cost_micro_cny` 留着给额度比较用(整数,不漂)。 */
function shapeRow(row) {
  const out = {};
  for (const column of SUM_COLUMNS) out[column] = Number(row?.[column] ?? 0);
  out.cost_cny = microToCny(out.cost_micro_cny);
  return out;
}

/** 一个 Date + 分钟偏移 → `YYYY-MM-DD`。纯函数,测试直接喂日期。 */
function dayKey(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 这个令牌今天用了多少 —— **三家上游加起来**。没有就回一行全 0
 * (而不是 undefined:调用方一律拿它跟上限比)。
 *
 * 2026-09-22 起 usage_daily 一行是「一个令牌 · 一天 · 一家」,所以这里从 get 改成 SUM。
 * **额度的口径一个字没变**:上限是一天总量,不是每家各一份 ——
 * 三份各自独立的额度会变成「今天的钱没用完但这家用完了」那种没人懂得了的状态。
 */
function usageOfDay(db, tokenHash, day) {
  const row = db.prepare(
    `SELECT ${SUM_COLUMNS.map(c => `SUM(${c}) AS ${c}`).join(', ')} FROM usage_daily`
    + ' WHERE token_hash = ? AND day = ?',
  ).get(tokenHash, day);
  return shapeRow(row);
}

/**
 * 把一次请求记上去,**记在哪一家上**由 `provider` 说(缺席 = deepseek,老调用方一个字不用改)。
 *
 * `usage` 可以是 undefined(上游没回 usage,比如报错了)——那就只把次数 +1,token 加 0。
 * **不猜、不估**:估出来的数字会被当成真的拿去算钱。
 *
 * 认不出的 provider 一律归 deepseek:库里不许出现一个谁也不认识的家名,
 * 否则 `/v1/usage` 那份分家清单里会冒出一格没人解释得了的东西。
 */
function recordUsage(db, tokenHash, day, usage, provider, options = {}) {
  const prompt = Number(usage?.prompt_tokens ?? 0) || 0;
  const completion = Number(usage?.completion_tokens ?? 0) || 0;
  const total = Number(usage?.total_tokens ?? 0) || (prompt + completion);
  const family = PROVIDERS.includes(provider) ? provider : 'deepseek';
  // 按钱记(2026-09-23):命中 / 未命中 / 输出三档各自计价,见 pricing.cjs。
  // 价格表由调用方从配置带进来;老调用方不带就用缺省价(与服务器没写那几行 env 时同一个数)。
  const tier = priceTierOf(family, options.model);
  const price = options.prices?.[tier] ?? {
    hit: DEFAULT_PRICES_CNY[tier][0], miss: DEFAULT_PRICES_CNY[tier][1], output: DEFAULT_PRICES_CNY[tier][2],
  };
  const split = splitUsage(usage);
  const cost = costMicroOf(split, price);
  db.prepare(
    'INSERT INTO usage_daily (token_hash, day, provider, requests, prompt_tokens, completion_tokens, total_tokens,'
    + ' cache_hit_tokens, cache_miss_tokens, cost_micro_cny)'
    + ' VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)'
    + ' ON CONFLICT(token_hash, day, provider) DO UPDATE SET'
    + '   requests = requests + 1,'
    + '   prompt_tokens = prompt_tokens + excluded.prompt_tokens,'
    + '   completion_tokens = completion_tokens + excluded.completion_tokens,'
    + '   total_tokens = total_tokens + excluded.total_tokens,'
    + '   cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,'
    + '   cache_miss_tokens = cache_miss_tokens + excluded.cache_miss_tokens,'
    + '   cost_micro_cny = cost_micro_cny + excluded.cost_micro_cny',
  ).run(tokenHash, day, family, prompt, completion, total, split.hit, split.miss, cost);
  return { cost_micro_cny: cost, cost_cny: microToCny(cost), ...split };
}

/**
 * 这个令牌今天**按家分开**的用量(2026-09-22)。
 *
 * ★ **三家一家不少,没用过的回 0**:界面上「今天没用过 GPT」要显示得出来 ——
 * 少一格与"用了 0"在人眼里是两件事,前者像是坏了。顺序按 PROVIDERS,固定。
 */
function usageByProvider(db, tokenHash, day) {
  const rows = db.prepare(
    `SELECT provider, ${SUM_COLUMNS.join(', ')} FROM usage_daily`
    + ' WHERE token_hash = ? AND day = ?',
  ).all(tokenHash, day);
  const byName = new Map(rows.map(row => [row.provider, row]));
  return PROVIDERS.map(provider => ({ provider, ...shapeRow(byName.get(provider)) }));
}

/**
 * 管理接口用:某一天所有令牌的用量,带账号与 prefix(不带明文令牌)。
 *
 * **一个令牌仍是一行**(三家求和)—— 这条接口回答的是"谁用得多",分家明细走
 * `/v1/usage` 那一条。子查询先按令牌汇总,再 JOIN,免得一个令牌因为有三家而出现三行。
 */
function usageReport(db, day) {
  const rows = db.prepare(
    'SELECT t.prefix AS prefix, t.account AS account, t.device_id AS device_id,'
    + ' t.daily_token_limit AS daily_token_limit, '
    + SUM_COLUMNS.map(c => `COALESCE(u.${c}, 0) AS ${c}`).join(', ')
    + ' FROM tokens t LEFT JOIN ('
    + `   SELECT token_hash, ${SUM_COLUMNS.map(c => `SUM(${c}) AS ${c}`).join(', ')}`
    + '   FROM usage_daily WHERE day = ? GROUP BY token_hash'
    + ' ) u ON u.token_hash = t.token_hash'
    + ' WHERE t.revoked_at IS NULL'
    // 2026-09-23 起按花的钱排(额度就是按钱算的),钱一样再按 token。
    + ' ORDER BY cost_micro_cny DESC, total_tokens DESC, t.created_at ASC',
  ).all(day);
  return rows.map(row => ({
    prefix: row.prefix,
    account: row.account,
    device_id: row.device_id,
    daily_token_limit: row.daily_token_limit,
    ...shapeRow(row),
  }));
}

/**
 * 搜索代理这个令牌今天用了几次(2026-09-21)。没有就 0 —— 调用方一律拿它跟上限比。
 * **与 usageOfDay 分开**,理由见 db.cjs 里 search_daily 那一段。
 */
function searchOfDay(db, tokenHash, day) {
  const row = db.prepare('SELECT requests FROM search_daily WHERE token_hash = ? AND day = ?').get(tokenHash, day);
  return { requests: Number(row?.requests ?? 0) };
}

/**
 * 记一次搜索。**与 recordUsage 的顺序相反:先记后发**(调用方在 app.cjs 里就是这么用的)。
 *
 * 为什么:一次 chat 用掉多少 token 是发完才知道的,所以只能后记;而搜索是**按次**的,
 * 发出去那一刻就已经欠了一次钱。失败也算 —— 不然一条打不通的上游会变成"无限次免费重试"。
 */
function recordSearch(db, tokenHash, day) {
  db.prepare(
    'INSERT INTO search_daily (token_hash, day, requests) VALUES (?, ?, 1)'
    + ' ON CONFLICT(token_hash, day) DO UPDATE SET requests = requests + 1',
  ).run(tokenHash, day);
}

module.exports = { dayKey, usageOfDay, usageByProvider, recordUsage, usageReport, searchOfDay, recordSearch };
