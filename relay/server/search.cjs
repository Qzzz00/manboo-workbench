'use strict';

// 搜索代理(2026-09-21,资讯与播客那张卡)。中转多一条 `POST /v1/search`。
//
// ## 为什么搜索也走中转,而不是让每台 Mac 自己拿一把搜索 Key
//
// 与上游模型 Key 同一个理由,而且更硬:搜索 API 按**次**计费,一把 Key 泄出去
// 就是直接烧钱,而工作台的用户是不写代码的人——让他去某个平台注册、充值、
// 把一串 sk- 粘进设置里,这条路在「用户环节不走命令行」那条规矩下根本走不通。
// 所以:**钥匙只在 /opt/relay/.env,客户端拿的是一条带设备令牌的代理路**。
//
// ## 选哪一家(2026-09-21 调研,写进 docs/交接-0921-资讯与播客.md 第一节)
//
// 默认 `bocha`(博查,api.bochaai.com)。三条:国内直连不用梯子;按次计费、有免费
// 试用资源包;返回体里带 `summary` 这种长摘要,是给模型读的,不是给人扫一眼的。
// Bing 的 Web Search API 对个人开发者已经不好申请且贵,SerpAPI 国内访问不稳。
// **这是可推翻的选择**:`RELAY_SEARCH_PROVIDER` 换成 `generic` + `RELAY_SEARCH_URL`
// 就能指到别家,只要那家吃 `{query, count}` 并回一个数组(见 normalizeResults)。
//
// ## 凭据纪律
//
// `RELAY_SEARCH_KEY` 只从环境变量读,不进库、不进任何返回、不进日志;
// `/health` 与这条路的错误里都只出现布尔「配了没有」。**仓库里一个字符都没有。**
//
// ## 配额
//
// 按次,按设备令牌,按天(与 token 额度分开算——搜索花的是搜索服务的钱,
// 跟他今天问了模型多少字没有关系)。默认 60 次/天:一个用户十来个项目、
// 每个项目一天搜一轮,够用且封得住跑飞的循环。

const DEFAULT_SEARCH_DAILY_LIMIT = 60;
/** 一次最多要几条。要多了既慢又贵,而早报每个项目只用得上 3 条。 */
const MAX_COUNT = 20;
const DEFAULT_COUNT = 10;
/** 上游超时。搜索是早报链路上的一步,卡住比没搜到更坏。 */
const DEFAULT_TIMEOUT_MS = 12_000;

const PROVIDER_URLS = {
  bocha: 'https://api.bochaai.com/v1/web-search',
};

/** 新鲜度只认这几个值(博查的口径);认不出就整个字段不发,让上游用它自己的默认。 */
const FRESHNESS = new Set(['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit']);

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function intOf(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * 环境变量 → 搜索配置。**不校验 Key 在不在**:缺了照样起得来,真有人来搜时才 503 + 一句人话
 * (与 relayConfigOf 对上游 Key 的口径完全一致)。
 */
function relaySearchConfigOf(env = process.env) {
  const provider = text(env.RELAY_SEARCH_PROVIDER) ?? 'bocha';
  const url = text(env.RELAY_SEARCH_URL) ?? PROVIDER_URLS[provider];
  return {
    provider,
    ...(url === undefined ? {} : { url }),
    key: text(env.RELAY_SEARCH_KEY),
    dailyLimit: intOf(env.RELAY_SEARCH_DAILY_LIMIT, DEFAULT_SEARCH_DAILY_LIMIT),
    timeoutMs: intOf(env.RELAY_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

/** 配没配得齐(Key 与地址两样都要)。只回布尔,永远不回值本身。 */
function searchConfigured(config) {
  return config !== undefined && config.key !== undefined && text(config.url) !== undefined;
}

/**
 * 请求体校验。纯函数。
 * `query` 必填;`count` 夹在 1..MAX_COUNT;`freshness` 认不出就丢掉(不 400——
 * 为一个可选的时间窗拒掉整次搜索,换来的只是调用方多一轮重试)。
 */
function parseSearchRequest(body) {
  const raw = (typeof body === 'object' && body !== null && !Array.isArray(body)) ? body : {};
  const query = text(raw.query);
  if (query === undefined) {
    return { ok: false, status: 400, code: 'invalid_query', error: 'query 要是一个非空字符串。' };
  }
  if (query.length > 200) {
    return { ok: false, status: 400, code: 'invalid_query', error: 'query 太长了(上限 200 字)。' };
  }
  const wanted = Number.parseInt(String(raw.count ?? ''), 10);
  const count = Number.isInteger(wanted) && wanted >= 1 ? Math.min(wanted, MAX_COUNT) : DEFAULT_COUNT;
  const freshness = typeof raw.freshness === 'string' && FRESHNESS.has(raw.freshness) ? raw.freshness : undefined;
  return { ok: true, query, count, ...(freshness === undefined ? {} : { freshness }) };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 上游回包 → 我们这一侧唯一的形状 `{ title, url, snippet, source?, published_at? }`。
 *
 * 认三种形状,按顺序试:
 *   ① 博查:`data.webPages.value[]`(name / url / snippet / summary / siteName / datePublished);
 *   ② 扁平数组:`results[]` 或顶层就是数组(自建搜索、别家网关多半长这样);
 *   ③ SerpAPI:`organic_results[]`(title / link / snippet / source / date)。
 * **一条都认不出就回空数组**,不编——上游换了形状要让调用方看见"0 条",
 * 而不是看见三条我们瞎拼出来的东西。
 *
 * `snippet` 优先取 summary(博查那段长摘要就是给模型读的),没有才退回 snippet。
 */
function normalizeResults(json) {
  const rows = pickRows(json);
  const out = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const url = nonEmpty(row.url) ?? nonEmpty(row.link);
    const title = nonEmpty(row.name) ?? nonEmpty(row.title);
    if (url === undefined || title === undefined) continue; // 没标题或没链接的条目对资讯流没有用
    const snippet = nonEmpty(row.summary) ?? nonEmpty(row.snippet) ?? nonEmpty(row.description) ?? '';
    const source = nonEmpty(row.siteName) ?? nonEmpty(row.source) ?? nonEmpty(row.displayUrl);
    const published = nonEmpty(row.datePublished) ?? nonEmpty(row.date) ?? nonEmpty(row.published_at);
    out.push({
      title,
      url,
      snippet,
      ...(source === undefined ? {} : { source }),
      ...(published === undefined ? {} : { published_at: published }),
    });
  }
  return out;
}

function pickRows(json) {
  if (Array.isArray(json)) return json;
  if (typeof json !== 'object' || json === null) return [];
  const value = json.data?.webPages?.value ?? json.webPages?.value;
  if (Array.isArray(value)) return value;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.organic_results)) return json.organic_results;
  return [];
}

/**
 * 打一次上游。**不抛**:连不上、超时、回了非 JSON,一律 `{ ok:false, error }`,
 * 而且 error 里**不带上游的原始 message**(它可能把带 Key 的 URL 抖出来,同 /v1/chat/completions)。
 */
async function searchUpstream(input) {
  const { config, query, count, freshness, fetchImpl = fetch } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ query, count, ...(freshness === undefined ? {} : { freshness }), summary: true }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: 502, error: `搜索服务回了 ${res.status}。` };
    let json;
    try { json = await res.json(); }
    catch { return { ok: false, status: 502, error: '搜索服务回了一段读不懂的内容。' }; }
    return { ok: true, results: normalizeResults(json) };
  }
  catch (error) {
    const aborted = String(error?.name ?? '') === 'AbortError';
    return { ok: false, status: 504, error: aborted ? '搜索服务超时了。' : '这会儿连不上搜索服务。' };
  }
  finally { clearTimeout(timer); }
}

module.exports = {
  DEFAULT_SEARCH_DAILY_LIMIT,
  MAX_COUNT,
  DEFAULT_COUNT,
  PROVIDER_URLS,
  relaySearchConfigOf,
  searchConfigured,
  parseSearchRequest,
  normalizeResults,
  searchUpstream,
};
