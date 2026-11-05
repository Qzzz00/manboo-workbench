'use strict';

// 火山 TTS 的**串行队列 + 并发超限退避重试**(2026-09-20)。
//
// 为什么(决策记录 2026-09-20「②补」,证据在 `~/.dsh/logs/butler.stderr.log`):
//   volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency
// 通道层的工人把一段回复按句切开之后是并发送来合成的,四小块 = 同一瞬间四条 /api/tts,
// 撞了火山按账号算的并发配额;8792 回 502,工人那边的框架攒够三条就把整通电话挂了。
//
// 工人那一侧已经自己排了队(channel-worker/src/tts/gate.ts),但**这台服务不止一个调用方**:
// 手机、管理台试听、以后别的东西都走这条路。所以门要设在**离火山最近的地方** ——
// 谁来都得排队,并发上限是这台服务的属性,不是某个调用方的自觉。
//
// 两件事:
//   ① 串行(默认并发 1,`TTS_MAX_CONCURRENCY` 可配)。先到先得。
//   ② 撞上并发超限就**退避重试**(默认 2 次,间隔 300 / 800ms)。
//      **只对「并发超限」这一种错重试** —— 音色不存在、文本非法、令牌坏了重试一百次也是一样的答案,
//      白让调用方多等两秒。判据见 isBusyError。
//
// 纯 JS,没有 I/O,定时器可注入 —— 测试里一毫秒都不用真等。

/** 同一时刻最多几条合成。默认 1。 */
const DEFAULT_LIMIT = 1;
/** 撞上并发超限重试几次。 */
const DEFAULT_RETRIES = 2;
/** 每次退避多久(毫秒),按次取;用完就取最后一个。 */
const DEFAULT_BACKOFF_MS = [300, 800];

/**
 * 这个错是不是「上游这会儿忙 / 并发超限」——也就是**等一下再来会不一样**的那一种。
 *
 * 认的几样(都有出处):
 *   - `quota exceeded for types: concurrency`:火山对这句 message 的官方说明是
 *     「并发超过了限定值,需要减少并发调用情况或者增购并发」(《WebSocket 单向流式-V1》常见错误返回说明);
 *   - `HTTP 429`:那次真机上带着上面那句 message 一起回来的状态码;
 *   - `code=3003`:V1 返回码表里的「并发超限」,官方建议行为就是「重试」;
 *   - `code=3005`:「后端服务忙」,同上;
 *   - `45000000`:新版大模型 TTS 里同一句 concurrency message 对应的码。
 * 认不出的一律**不重试**(见文件头)。
 */
function isBusyError(error) {
  const message = String((error && error.message) || error || '');
  if (message === '') return false;
  return /quota exceeded for types:\s*concurrency/i.test(message)
    || /\bHTTP\s*429\b/i.test(message)
    || /\bcode=3003\b/.test(message)
    || /\bcode=3005\b/.test(message)
    || /\b45000000\b/.test(message);
}

/**
 * 一道闸 + 一层退避重试。
 * @param {{limit?:number, retries?:number, backoffMs?:number[], sleep?:(ms:number)=>Promise<void>}} [options]
 */
function createTtsQueue(options) {
  const opts = options || {};
  const rawLimit = Number(opts.limit);
  // 0 或负数会把整条合成锁死 —— 那是配错了,不是一种用法。按 1 处理并往下走。
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : DEFAULT_LIMIT;
  const rawRetries = Number(opts.retries);
  const retries = Number.isFinite(rawRetries) && rawRetries >= 0 ? Math.floor(rawRetries) : DEFAULT_RETRIES;
  const backoffMs = Array.isArray(opts.backoffMs) && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); }));

  let active = 0;
  const waiting = [];
  let busyRetries = 0;

  function acquire() {
    if (active < limit) { active += 1; return Promise.resolve(); }
    return new Promise((resolve) => { waiting.push(resolve); });
  }

  function release() {
    const next = waiting.shift();
    // 名额从这一位手里直接转给排头,中间不经过「空出来」那一瞬间(先到先得是这道闸唯一的承诺)。
    if (next) next();
    else active -= 1;
  }

  return {
    limit,
    retries,
    /** 诊断用:一共为「上游忙」重试过几次。 */
    stats: () => ({ limit, active, waiting: waiting.length, busyRetries }),
    /**
     * 排队跑一次合成。`fn` 抛什么这里就抛什么(除了「上游忙」会先重试几次)。
     * 重试**在闸内**发生:退避的那几百毫秒里名额是占着的 —— 放开它只会让后面的人立刻再去撞一次。
     */
    async run(fn) {
      await acquire();
      try {
        let attempt = 0;
        for (;;) {
          try { return await fn(); }
          catch (error) {
            if (attempt >= retries || !isBusyError(error)) throw error;
            const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
            attempt += 1;
            busyRetries += 1;
            await sleep(wait);
          }
        }
      }
      finally { release(); }
    },
  };
}

/** 生产那一份。并发上限与重试次数从环境变量来,改完重启 8792 生效。 */
const ttsQueue = createTtsQueue({
  limit: process.env.TTS_MAX_CONCURRENCY,
  retries: process.env.TTS_BUSY_RETRIES,
});

module.exports = { createTtsQueue, isBusyError, ttsQueue, DEFAULT_LIMIT, DEFAULT_RETRIES, DEFAULT_BACKOFF_MS };
