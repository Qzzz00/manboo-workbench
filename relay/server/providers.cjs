'use strict';

// 上游有三家(2026-09-22,「派活的第三只手 · 接口」那张卡)。
//
// 起因写在决策记录 2026-09-21「运营白板三件」第 2 条:Ben 说「产品研发场景怎么派活,
// 这个场景就怎么派活」——派活链路通用,各家只是**手**不同。GPT 与豆包没有命令行
// (豆包的窗口也送不进去:辅助功能树只有 10 个节点),那两家就走**接口**这只手;
// 而用户手里没有 API Key,所以 Key 在服务器上,请求经中转转出去、按家记账。
//
// ## 一个模块只回答三个问题
//
// 1. **这个模型名归哪一家**(`providerOfModel`)——纯字符串判断,没有 I/O;
// 2. **那一家此刻配了没有、地址是什么**(`relayProvidersConfigOf` / `providerUpstream`);
// 3. **豆包那家要不要把模型名换成 endpoint id**(`resolveUpstreamModel`)。
//
// 真发请求的那一段仍在 upstream.cjs(一个字没改:它本来就只认 url + key)。
//
// ## 三条纪律,与 config.cjs 的文件头同源
//
// - **Key 只从环境变量读**,不落库、不进任何接口的返回、不进日志;「配了没有」只回布尔。
// - **没配那一家不影响起服务**:起得来,真要用时才 503 + 一句人话(「服务器没配 X」)。
// - **DeepSeek 那家仍读老变量**(`RELAY_UPSTREAM_KEY` / `RELAY_UPSTREAM_URL`):
//   服务器上 .env 里已经有它了,这一版不许要求改存量部署才能起得来。
//
// ## 为什么按「模型名前缀」路由,而不是让客户端说一句「我要发给谁」
//
// 因为客户端就是各种现成的 OpenAI SDK(DSH 的 pi-ai、@livekit/agents 的 openai 插件、
// 工作台自己那条 fetch),它们的请求体里**只有 model 这一格**是我们能约定的。
// 再加一个自定义字段,等于要求每一个客户端都改一遍——而 `model` 每一家本来就得填。

/**
 * 去掉末尾斜杠 —— 后面一律 `${base}${prefix}/…` 拼,双斜杠会让某些网关 404。
 *
 * config.cjs 里有一份同名的。**这里不 require 它**:config.cjs 反过来要 require 这个模块
 * (它把 `providers` 拼进配置),两边互相 require 就是一个环。三行的纯函数复制一份,
 * 比为它拆第三个文件划算 —— 有用例钉着两边行为一致。
 */
function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

/** 三家。顺序固定(日志、/v1/usage 的分家用量、管理面都按它排)。 */
const PROVIDERS = ['deepseek', 'openai', 'doubao'];

/** 错误里写给人看的名字。**不出现英文缩写**——最终读到这句的是不懂代码的人。 */
const PROVIDER_TITLES = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  doubao: '豆包(火山方舟)',
};

/**
 * 各家的环境变量名。**部署文档里逐字抄的就是这张表**,所以它是唯一定义处
 * (交接-0922-派活API适配器.md 第二节那张表由这里的名字写成)。
 */
const PROVIDER_ENV = {
  deepseek: { key: 'RELAY_UPSTREAM_KEY', base: 'RELAY_UPSTREAM_URL' },
  openai: { key: 'RELAY_OPENAI_KEY', base: 'RELAY_OPENAI_BASE' },
  doubao: { key: 'RELAY_DOUBAO_KEY', base: 'RELAY_DOUBAO_BASE' },
};

/**
 * 各家的默认地址与**路径前缀**。
 *
 * ★ 前缀这一格是真踩出来的形状差异:OpenAI 与 DeepSeek 的路是 `<base>/v1/chat/completions`,
 * 而**火山方舟的 base 自带 `/api/v3`**,它的路是 `<base>/chat/completions` ——
 * 照着别家拼一个 `/v1` 上去就是 404。所以前缀跟着家走,不由调用方拼。
 */
const PROVIDER_DEFAULTS = {
  deepseek: { base: 'https://api.deepseek.com', prefix: '/v1' },
  openai: { base: 'https://api.openai.com', prefix: '/v1' },
  doubao: { base: 'https://ark.cn-beijing.volces.com/api/v3', prefix: '' },
};

/** 豆包的模型名 → endpoint id 映射,从这个变量读。 */
const DOUBAO_ENDPOINTS_ENV = 'RELAY_DOUBAO_ENDPOINTS';

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 模型名 → 哪一家。**认不出就是 DeepSeek**(现状那一档)。
 *
 * - `gpt-*`、`o1`/`o3`/`o4-…`(o 后面紧跟数字) → OpenAI
 * - `doubao-*`、`ep-*`(客户端直接给了 endpoint id) → 豆包
 * - 其余 → DeepSeek
 *
 * ★ 为什么 `o*` 收窄成「o + 数字」:兜底那一档是 DeepSeek,所以判错的代价是
 * **把一条本该发给 DeepSeek 的请求发去 OpenAI**,而两边的 Key 都是对的,于是错得毫无声响。
 * 宁可漏判(兜底那家会如实回一句"没这个模型"),不可错判。
 */
function providerOfModel(model) {
  const name = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (name.startsWith('gpt-') || /^o\d/.test(name)) return 'openai';
  if (name.startsWith('doubao-') || name.startsWith('ep-')) return 'doubao';
  return 'deepseek';
}

/**
 * `"doubao-pro-32k=ep-2026…,doubao-lite-4k=ep-…"` → `{ 'doubao-pro-32k': 'ep-2026…' }`。
 *
 * 逗号、分号、换行都当分隔符(.env 里一行写不下时能换行写)。
 * 缺等号、值为空的条目**一概跳过**:造一个空的 endpoint 出来,只会让方舟回一句看不懂的错。
 * 模型名统一小写存,查的时候也小写查 —— 客户端写 `Doubao-Pro` 一样认得出。
 */
function parseEndpointMap(raw) {
  const out = {};
  for (const piece of String(raw ?? '').split(/[,;\n]/)) {
    const at = piece.indexOf('=');
    if (at === -1) continue;
    const name = piece.slice(0, at).trim().toLowerCase();
    const endpoint = piece.slice(at + 1).trim();
    if (name === '' || endpoint === '') continue;
    out[name] = endpoint;
  }
  return out;
}

/**
 * 真正发给上游的那个 model 值。
 *
 * 只有豆包这一家要换:方舟上很多模型是**按接入点(endpoint id)调**的,
 * 而客户端那边写的是人看得懂的名字。映射不到就**原样发过去** ——
 * 方舟自己会回一句"没这个模型",那句原话比我们替它编一条错误有用得多。
 */
function resolveUpstreamModel(provider, model, endpoints) {
  if (provider !== 'doubao') return model;
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  return (endpoints ?? {})[key] ?? model;
}

/**
 * 环境变量 → 三家的配置。**缺了照样能起**(同 config.cjs 的规矩):
 * `configured:false` 的那一家在真要用时才 503。
 */
function relayProvidersConfigOf(env = process.env) {
  const out = {};
  for (const provider of PROVIDERS) {
    const names = PROVIDER_ENV[provider];
    const defaults = PROVIDER_DEFAULTS[provider];
    const key = text(env[names.key]);
    out[provider] = {
      baseUrl: trimSlash(text(env[names.base]) ?? defaults.base),
      prefix: defaults.prefix,
      ...(key === undefined ? {} : { key }),
      configured: key !== undefined,
      ...(provider === 'doubao' ? { endpoints: parseEndpointMap(env[DOUBAO_ENDPOINTS_ENV]) } : {}),
    };
  }
  return out;
}

/**
 * 这一家此刻能不能发。能就回三条路 + key,不能回 `undefined`。
 *
 * ★ **DeepSeek 走老字段** `config.upstreamUrl` / `config.upstreamKey`,不走 `config.providers`:
 * 那两个字段是这台中转从第一天起的真相源,http.test.mjs 里每一份用例都在覆盖它们、
 * 服务器上的 .env 里也只有它们。多一处真相就会有一处漂。
 */
function providerUpstream(config, provider) {
  if (provider === 'deepseek') {
    if (config.upstreamKey === undefined) return undefined;
    const base = trimSlash(config.upstreamUrl ?? PROVIDER_DEFAULTS.deepseek.base);
    return urls(provider, base, PROVIDER_DEFAULTS.deepseek.prefix, config.upstreamKey, undefined);
  }
  const one = (config.providers ?? {})[provider];
  if (one === undefined || one.key === undefined) return undefined;
  return urls(provider, one.baseUrl, one.prefix, one.key, one.endpoints);
}

function urls(provider, base, prefix, key, endpoints) {
  const root = `${base}${prefix}`;
  return {
    provider,
    baseUrl: base,
    key,
    chatUrl: `${root}/chat/completions`,
    modelsUrl: `${root}/models`,
    imagesUrl: `${root}/images/generations`,
    ...(endpoints === undefined ? {} : { endpoints }),
  };
}

/** 503 时说的那一句。**变量名写在里面**——看到这句的人下一步就是去 .env 里加那一行。 */
function notConfiguredMessage(provider) {
  return `服务器没配 ${PROVIDER_TITLES[provider]}(缺 ${PROVIDER_ENV[provider].key}),这条请求发不出去。`;
}

/** 503 的 code。`openai_not_configured` / `doubao_not_configured` / `upstream_not_configured`。 */
function notConfiguredCode(provider) {
  // DeepSeek 那一档保持老 code:已经有客户端按它认了(工作台的模型那一节)。
  return provider === 'deepseek' ? 'upstream_not_configured' : `${provider}_not_configured`;
}

module.exports = {
  PROVIDERS,
  PROVIDER_TITLES,
  PROVIDER_ENV,
  PROVIDER_DEFAULTS,
  DOUBAO_ENDPOINTS_ENV,
  providerOfModel,
  parseEndpointMap,
  resolveUpstreamModel,
  relayProvidersConfigOf,
  providerUpstream,
  notConfiguredMessage,
  notConfiguredCode,
};
