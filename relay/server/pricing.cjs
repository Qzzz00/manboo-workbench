'use strict';

// 按钱记账(2026-09-23,「中转额度按钱算」那张卡)。
//
// ## 为什么从 token 改成元
//
// 维护者 09-23 原话:「直接按 DeepSeek 的口径计算不就完了……用户不在乎一通电话花了多少
// Tokens,只在乎花了多少钱」。起因:那天 52.6 万 token 里约 34 万是 DeepSeek 缓存命中,
// 实际只花了几毛钱,却把 50 万 token 的额度撞满,通话里她不吭声了。缓存命中比未命中便宜
// 五十倍,按 token 数一刀切等于把最便宜的那部分当最贵的算。
//
// ## 价格从哪来(**改价只改这里的缺省值,或者服务器 .env 里那几行**)
//
// DeepSeek 官方「模型 & 价格」页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// **2026-09-23 核对**,单位 元 / 百万 tokens,格式「缓存命中,缓存未命中,输出」:
//
//   deepseek-flash(DeepSeek-V4.1-Flash;旧名 deepseek-v4-flash 仍可调,按 Flash 计费)
//     高峰 0.04, 2, 8      空闲 0.02, 1, 4
//   deepseek-v4-pro(DeepSeek-V4-Pro-0813)
//     高峰 0.30, 9, 27     空闲 0.15, 4.5, 13.5
//
// 官方有峰谷两档(北京时间工作日 9–12、14–18 为高峰,其余含法定节假日为空闲,空闲是半价)。
// **这里一律按高峰价记**:法定节假日表我们没有,猜错就是少算;按高峰价最多多算一倍,
// 「宁可多算」是拍过板的口径。代价:空闲时段用户看到的「花了多少」比 DeepSeek 实扣的高。
//
// 认不出的 DeepSeek 模型名(deepseek-chat / deepseek-reasoner / 以后的新名字)一律按 **Pro** 价
// —— 这张页上已经不列它们了,按贵的那档算不会让额度形同虚设。
//
// OpenAI 与豆包:**没核到**(这张卡只核了 DeepSeek 官方页;各家价目按模型差十几倍、
// 还有汇率)。缺省给的是一档**保守**的按 token 价,只为让额度不至于对它们不设防;
// 真要按它们记准,在 .env 里写 RELAY_PRICE_OPENAI_CNY / RELAY_PRICE_DOUBAO_CNY。
//
// ## 不存浮点钱
//
// 成本存成「微元」(百万分之一元)的整数。巧的是:价格单位是「元 / 百万 token」,
// 所以 **token 数 × 价格 = 微元**,一步到位。每次请求向上取整到 1 微元(宁可多算)。

/** 价格档。键是档名,值是 [缓存命中, 缓存未命中, 输出],单位 元 / 百万 tokens。 */
const DEFAULT_PRICES_CNY = {
  // DeepSeek 官方高峰价,2026-09-23 核对(出处见文件头)。
  'deepseek-flash': [0.04, 2, 8],
  'deepseek-pro': [0.3, 9, 27],
  // 没核到,保守值(见文件头)。命中与未命中同价:别家回的缓存字段形状各不一样,不去赌它。
  openai: [20, 20, 120],
  doubao: [4, 4, 40],
};

/** 每一档从哪个环境变量读。**部署文档照抄这张表**(交接-0923-中转额度按钱算.md)。 */
const PRICE_ENV = {
  'deepseek-flash': 'RELAY_PRICE_DEEPSEEK_FLASH_CNY',
  'deepseek-pro': 'RELAY_PRICE_DEEPSEEK_PRO_CNY',
  openai: 'RELAY_PRICE_OPENAI_CNY',
  doubao: 'RELAY_PRICE_DOUBAO_CNY',
};

/** `"0.04,2,8"` → `{ hit, miss, output }`。三个都得是非负有限数,否则 undefined(调用方回落缺省)。 */
function parsePrice(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parts = raw.split(/[,,\s]+/).filter(p => p !== '');
  if (parts.length !== 3) return undefined;
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return undefined;
  return { hit: nums[0], miss: nums[1], output: nums[2] };
}

function priceOf(triple) {
  return { hit: triple[0], miss: triple[1], output: triple[2] };
}

/**
 * 环境变量 → 价格表。写坏了的那一格**回落缺省并记一条 warning**(启动日志与 /health 里看得到),
 * 不让服务起不来 —— 起不来的代价是全网断模型,比某一档价格按缺省算大得多。
 */
function relayPricesConfigOf(env = process.env) {
  const tiers = {};
  const warnings = [];
  for (const [tier, name] of Object.entries(PRICE_ENV)) {
    const raw = env[name];
    const parsed = parsePrice(raw);
    if (parsed === undefined && typeof raw === 'string' && raw.trim() !== '') {
      warnings.push(`${name} 写得不对(要「命中,未命中,输出」三个数,单位 元/百万 tokens),按缺省价算`);
    }
    tiers[tier] = parsed ?? priceOf(DEFAULT_PRICES_CNY[tier]);
  }
  return { tiers, warnings };
}

/** 这家、这个模型名 → 哪一档价。 */
function priceTierOf(provider, model) {
  if (provider === 'openai' || provider === 'doubao') return provider;
  const name = typeof model === 'string' ? model.trim().toLowerCase() : '';
  // 只有明写 flash 的才按 Flash 价;别的 DeepSeek 名字按 Pro(贵的那档,见文件头)。
  return name.includes('flash') ? 'deepseek-flash' : 'deepseek-pro';
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 上游 usage → 三档 token 数。
 *
 * - DeepSeek:`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`;
 * - OpenAI 形状:`prompt_tokens_details.cached_tokens` 当命中;
 * - **两样都没有 → 整段输入按未命中算**(拍过板:宁可多算)。
 * - 只给了其中一样,另一样用 prompt_tokens 减出来。
 */
function splitUsage(usage) {
  if (usage === null || typeof usage !== 'object') return { hit: 0, miss: 0, completion: 0 };
  const completion = count(usage.completion_tokens);
  let prompt = count(usage.prompt_tokens);
  if (prompt === 0 && count(usage.total_tokens) > completion) prompt = count(usage.total_tokens) - completion;
  const hitRaw = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const missRaw = usage.prompt_cache_miss_tokens;
  const hasHit = hitRaw !== undefined && hitRaw !== null && Number.isFinite(Number(hitRaw));
  const hasMiss = missRaw !== undefined && missRaw !== null && Number.isFinite(Number(missRaw));
  if (hasHit && hasMiss) return { hit: count(hitRaw), miss: count(missRaw), completion };
  if (hasHit) {
    const hit = Math.min(count(hitRaw), prompt);
    return { hit, miss: prompt - hit, completion };
  }
  if (hasMiss) {
    const miss = count(missRaw);
    return { hit: Math.max(0, prompt - miss), miss, completion };
  }
  return { hit: 0, miss: prompt, completion };
}

/**
 * 一次请求花了多少微元(整数,向上取整)。`price` 是 `{ hit, miss, output }`,元 / 百万 tokens。
 * usage 缺席(上游报错、没回 usage)就是 0 —— 不猜、不估,同 recordUsage 那条纪律。
 */
function costMicroOf(split, price) {
  const raw = split.hit * price.hit + split.miss * price.miss + split.completion * price.output;
  // 减一个极小量再 ceil:0.04 × 300 在浮点里是 12.000000000000002,不该因此多收 1 微元。
  return raw <= 0 ? 0 : Math.ceil(raw - 1e-9);
}

/** 微元 → 元(数值)。接口里回的就是它;保留到 1 微元,不在这里四舍五入。 */
function microToCny(micro) {
  return Math.round(Number(micro) || 0) / 1_000_000;
}

/** 元 → 给人看的字符串:「5」「0.5」「2.35」—— 上限写得干净,已花的写到分。 */
function formatCny(value, { cents = false } = {}) {
  const n = Number(value) || 0;
  if (cents) return n.toFixed(2);
  return String(Math.round(n * 100) / 100);
}

module.exports = {
  DEFAULT_PRICES_CNY,
  PRICE_ENV,
  parsePrice,
  relayPricesConfigOf,
  priceTierOf,
  splitUsage,
  costMicroOf,
  microToCny,
  formatCny,
};
