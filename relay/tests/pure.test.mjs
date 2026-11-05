import { describe, expect, it } from 'vitest';

import { accountScopeOf } from '../server/accounts.cjs';
import { createRateLimiter, isLoopbackRequest } from '../server/app.cjs';
import { channelAccountRefusal } from '../server/channel.cjs';
import { relayConfigOf, trimSlash } from '../server/config.cjs';
import { createUsageSniffer } from '../server/sse.cjs';
import { bearerOf, hashToken, isRelayToken, newToken, tokenPrefix } from '../server/tokens.cjs';
import { withUsageOptions } from '../server/upstream.cjs';
import { dayKey } from '../server/usage.cjs';

describe('config', () => {
  it('缺环境变量时上游 Key 是 undefined,而不是空串', () => {
    expect(relayConfigOf({}).upstreamKey).toBeUndefined();
    expect(relayConfigOf({ RELAY_UPSTREAM_KEY: '   ' }).upstreamKey).toBeUndefined();
  });

  it('上游地址去掉末尾斜杠', () => {
    expect(relayConfigOf({ RELAY_UPSTREAM_URL: 'https://x.test/' }).upstreamUrl).toBe('https://x.test');
    expect(trimSlash('https://x.test///')).toBe('https://x.test');
  });

  it('数字项非法时退回默认,不抛', () => {
    expect(relayConfigOf({ RELAY_DAILY_TOKEN_LIMIT: '不是数字' }).dailyTokenLimit).toBe(500_000);
    expect(relayConfigOf({ RELAY_DAILY_TOKEN_LIMIT: '1234' }).dailyTokenLimit).toBe(1234);
  });
});

describe('令牌', () => {
  it('形状是 wb_ 开头,且每次都不一样', () => {
    const a = newToken();
    const b = newToken();
    expect(a.startsWith('wb_')).toBe(true);
    expect(a).not.toBe(b);
    expect(isRelayToken(a)).toBe(true);
    expect(isRelayToken('sk-abc')).toBe(false);
  });

  it('哈希稳定,prefix 只有 8 个字符', () => {
    const token = 'wb_abcdefghijklmn';
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(`${token}x`));
    expect(tokenPrefix(token)).toBe('wb_abcde');
    expect(tokenPrefix(token).length).toBe(8);
  });

  it('Bearer 头解析:大小写、空格、缺失', () => {
    expect(bearerOf('Bearer wb_x')).toBe('wb_x');
    expect(bearerOf('bearer   wb_x  ')).toBe('wb_x');
    expect(bearerOf('Basic wb_x')).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
    expect(bearerOf('Bearer ')).toBeUndefined();
  });
});

describe('「今天」是哪一天', () => {
  it('按 +8 算:UTC 的 16:00 已经是第二天', () => {
    expect(dayKey(new Date('2026-09-17T15:59:00Z'), 480)).toBe('2026-09-17');
    expect(dayKey(new Date('2026-09-17T16:00:00Z'), 480)).toBe('2026-09-18');
  });

  it('偏移 0 就是 UTC 那一天', () => {
    expect(dayKey(new Date('2026-09-17T23:59:00Z'), 0)).toBe('2026-09-17');
  });
});

describe('流式回包里挑 usage', () => {
  it('挑得出最后一块里的 usage', () => {
    const s = createUsageSniffer();
    s.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    s.push('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n');
    s.push('data: [DONE]\n\n');
    s.end();
    expect(s.usage()).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('chunk 从一行中间切开也认得出来', () => {
    const s = createUsageSniffer();
    s.push('data: {"choices":[],"usage":{"prompt_');
    s.push('tokens":1,"completion_tokens":2,"total_tokens":3}}\n');
    s.end();
    expect(s.usage()).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it('坏 JSON 与没有 usage 都只是「没看到」,不抛', () => {
    const s = createUsageSniffer();
    s.push('data: {坏掉的\n\n');
    s.push('data: {"choices":[{"delta":{}}]}\n\n');
    s.end();
    expect(s.usage()).toBeUndefined();
  });

  it('最后一行没有换行也收得住', () => {
    const s = createUsageSniffer();
    s.push('data: {"usage":{"total_tokens":9}}');
    expect(s.usage()).toBeUndefined();
    s.end();
    expect(s.usage()).toEqual({ total_tokens: 9 });
  });
});

describe('强制打开 include_usage', () => {
  it('流式请求补上开关,客户端写 false 也覆盖掉', () => {
    expect(withUsageOptions({ stream: true })).toEqual({ stream: true, stream_options: { include_usage: true } });
    expect(withUsageOptions({ stream: true, stream_options: { include_usage: false } }))
      .toEqual({ stream: true, stream_options: { include_usage: true } });
  });

  it('非流式一个字都不动', () => {
    const body = { model: 'x', messages: [] };
    expect(withUsageOptions(body)).toBe(body);
  });
});

describe('限速', () => {
  it('到了上限就拦,过了窗口又放行', () => {
    const limiter = createRateLimiter({ perHour: 2, windowMs: 1000 });
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('a', 2)).toBe(false);
    // 另一个来源不受影响。
    expect(limiter.take('b', 2)).toBe(true);
    expect(limiter.take('a', 1001)).toBe(true);
  });
});

describe('「真·本机」', () => {
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });

  it('回环地址且没有反代头才算', () => {
    expect(isLoopbackRequest(req('127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('::1'))).toBe(true);
    expect(isLoopbackRequest(req('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('10.0.0.5'))).toBe(false);
  });

  it('带了反代头就不算 —— Caddy 是从 127.0.0.1 连过来的', () => {
    expect(isLoopbackRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
    expect(isLoopbackRequest(req('127.0.0.1', { 'x-real-ip': '1.2.3.4' }))).toBe(false);
  });
});

/**
 * 房间只认账号那道门(2026-09-27,卡 RM)。这一条的全部意义是**把两个文件钉在一起**:
 * `channel.cjs` 里那个 `acct:` 前缀是抄来的(它不 require accounts.cjs),
 * 所以这里拿 `accountScopeOf` 真正的产物过一遍门 —— 哪天前缀漂了,这条当场红。
 */
describe('channelAccountRefusal', () => {
  it('accountScopeOf 拼出来的那一串过得去', () => {
    expect(channelAccountRefusal(accountScopeOf('0123456789abcdef0123456789abcdef'))).toBeUndefined();
  });

  it('老路那种「用户起的名字」过不去,而且回的是一句人话', () => {
    for (const legacy of ['ben', 'ben@x.com', 'local-abcd1234', 'acct:', '', undefined, null, 42]) {
      const refusal = channelAccountRefusal(legacy);
      expect(refusal?.code).toBe('not_bound_to_account');
      expect(refusal?.status).toBe(403);
      expect(refusal?.error).toContain('登录');
    }
  });
});
