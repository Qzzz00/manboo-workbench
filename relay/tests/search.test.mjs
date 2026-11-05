// 搜索代理 `POST /v1/search`:纯函数(请求校验、上游回包归一)+ 整条路(鉴权、没配、配额、上游桩)。
//
// 上游用一个**真起的 http 服务器**当桩,和 http.test.mjs 同一个路子:
// 这条路上最容易出问题的地方是 Authorization 头与 JSON 形状,mock 掉 fetch 就验不到。
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { issueToken } from '../server/tokens.cjs';
import { normalizeResults, parseSearchRequest, relaySearchConfigOf, searchConfigured } from '../server/search.cjs';

const SEARCH_KEY = 'sk-fake-search-0921';

let server;
let upstream;
let db;
let base;

/** 假搜索上游。`reply` 决定这一次回什么;`seen` 记下它收到的请求,好验头与 body。 */
async function startFakeSearch(reply) {
  const seen = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      const out = reply(seen.length);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${s.address().port}/v1/web-search`, seen, close: () => new Promise(d => s.close(d)) };
}

async function startRelay(searchOverrides = {}) {
  db = openRelayDb(':memory:');
  const config = {
    ...relayConfigOf({}),
    upstreamKey: 'sk-fake-upstream',
    search: { ...relaySearchConfigOf({}), key: SEARCH_KEY, ...searchOverrides },
  };
  const app = createApp({ db, config });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return config;
}

function grantToken() {
  return issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 50_000 }).token;
}

function post(token, body) {
  return fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

/** 博查那一家的回包形状(字段名按官方文档:name / url / snippet / summary / siteName / datePublished)。 */
const BOCHA_OK = {
  status: 200,
  json: {
    code: 200,
    data: {
      webPages: {
        value: [
          { name: 'DeepSeek 发布新模型', url: 'https://a.example/1', snippet: '短摘要', summary: '长摘要,给模型读的', siteName: '机器之心', datePublished: '2026-09-20T08:00:00Z' },
          { name: '没有链接的那条', snippet: '应该被丢掉' },
        ],
      },
    },
  },
};

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  if (upstream !== undefined) await upstream.close();
  server = undefined;
  upstream = undefined;
});

describe('parseSearchRequest', () => {
  it('query 必填、超长拒掉', () => {
    expect(parseSearchRequest({}).ok).toBe(false);
    expect(parseSearchRequest({ query: '   ' }).ok).toBe(false);
    expect(parseSearchRequest({ query: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('count 夹在 1..20,缺省 10', () => {
    expect(parseSearchRequest({ query: 'a' }).count).toBe(10);
    expect(parseSearchRequest({ query: 'a', count: 99 }).count).toBe(20);
    expect(parseSearchRequest({ query: 'a', count: 3 }).count).toBe(3);
    expect(parseSearchRequest({ query: 'a', count: 0 }).count).toBe(10);
  });

  it('freshness 认不出就整个字段不发,而不是拒掉整次搜索', () => {
    expect(parseSearchRequest({ query: 'a', freshness: 'oneWeek' }).freshness).toBe('oneWeek');
    expect(parseSearchRequest({ query: 'a', freshness: '最近一周' }).freshness).toBeUndefined();
  });
});

describe('normalizeResults', () => {
  it('认博查的 data.webPages.value,summary 优先于 snippet', () => {
    const rows = normalizeResults(BOCHA_OK.json);
    expect(rows).toHaveLength(1); // 没链接的那条被丢掉
    expect(rows[0]).toEqual({
      title: 'DeepSeek 发布新模型',
      url: 'https://a.example/1',
      snippet: '长摘要,给模型读的',
      source: '机器之心',
      published_at: '2026-09-20T08:00:00Z',
    });
  });

  it('也认扁平数组与 SerpAPI 的 organic_results', () => {
    expect(normalizeResults([{ title: 'T', link: 'https://b.example' }])[0].url).toBe('https://b.example');
    expect(normalizeResults({ organic_results: [{ title: 'T', link: 'https://c.example', source: '新华社' }] })[0].source).toBe('新华社');
    expect(normalizeResults({ results: [{ title: 'T', url: 'https://d.example' }] })[0].url).toBe('https://d.example');
  });

  it('一条都认不出就回空数组,不编', () => {
    expect(normalizeResults({ 谁知道: '什么形状' })).toEqual([]);
    expect(normalizeResults(null)).toEqual([]);
  });
});

describe('searchConfigured', () => {
  it('Key 与地址两样都要', () => {
    expect(searchConfigured(relaySearchConfigOf({}))).toBe(false); // 默认有地址,没 Key
    expect(searchConfigured(relaySearchConfigOf({ RELAY_SEARCH_KEY: 'k' }))).toBe(true);
    expect(searchConfigured(relaySearchConfigOf({ RELAY_SEARCH_KEY: 'k', RELAY_SEARCH_PROVIDER: '没这家' }))).toBe(false);
  });
});

describe('POST /v1/search', () => {
  it('没令牌 401', async () => {
    await startRelay({ url: 'http://127.0.0.1:1/x' });
    const res = await post(undefined, { query: 'a' });
    expect(res.status).toBe(401);
  });

  it('服务器没配搜索 → 503 search_not_configured(不编条目)', async () => {
    await startRelay({ key: undefined });
    const token = grantToken();
    const res = await post(token, { query: 'a' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('search_not_configured');
  });

  it('把 Key 放请求头发给上游,回归一后的条目;搜的内容不进响应', async () => {
    upstream = await startFakeSearch(() => BOCHA_OK);
    await startRelay({ url: upstream.url });
    const token = grantToken();
    const res = await post(token, { query: '事务官 工作台', count: 5, freshness: 'oneWeek' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].title).toBe('DeepSeek 发布新模型');
    expect(body.used).toBe(1);
    expect(upstream.seen[0].auth).toBe(`Bearer ${SEARCH_KEY}`);
    expect(upstream.seen[0].body).toMatchObject({ query: '事务官 工作台', count: 5, freshness: 'oneWeek' });
  });

  it('按次限额:超了 429,且 chat 的 token 额度一点没动', async () => {
    upstream = await startFakeSearch(() => BOCHA_OK);
    await startRelay({ url: upstream.url, dailyLimit: 2 });
    const token = grantToken();
    expect((await post(token, { query: 'a' })).status).toBe(200);
    expect((await post(token, { query: 'b' })).status).toBe(200);
    const third = await post(token, { query: 'c' });
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('search_quota_exceeded');
    // token 额度那本账一个字没写
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.used_tokens).toBe(0);
  });

  it('上游失败:502,而且失败那一次照样计次(它在对方那边多半已经计费了)', async () => {
    upstream = await startFakeSearch(() => ({ status: 500, json: { error: 'boom' } }));
    await startRelay({ url: upstream.url, dailyLimit: 5 });
    const token = grantToken();
    const res = await post(token, { query: 'a' });
    expect(res.status).toBe(502);
    // 再来一次仍然打得通(说明计的是次数,不是把令牌锁死)
    expect((await post(token, { query: 'b' })).status).toBe(502);
    expect(upstream.seen).toHaveLength(2);
  });

  it('/health 只说「配了没有」,不抖 Key 也不抖地址', async () => {
    await startRelay({ url: 'http://127.0.0.1:1/x' });
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.search_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SEARCH_KEY);
    expect(JSON.stringify(body)).not.toContain('127.0.0.1:1');
  });
});
