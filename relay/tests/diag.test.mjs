// 远程错误上报(2026-09-22,「诊断包与远程错误上报」那张卡)。
//
// 要钉死的是四件事:
//   ① **谁能写**:一条上报要设备令牌,没有 / 认不出一律 401;
//   ② **谁能读**:`GET /v1/diag/reports` 只认管理员令牌(`RELAY_ADMIN_TOKEN`)——
//      **设备令牌读不到**(它跟写的那把是同一串,这一条是这组用例里最要紧的一条);
//   ③ **限频**:每台设备每小时 20 条,第 21 条 429,而且回包里带着"什么时候能再来";
//   ④ **保留期**:30 天,过期的行在下一次读写时被清掉。
//
// 外加一道**第二张网**:中转自己也把明显的密钥形状擦一遍(设备那头已经擦过一遍了)。
// 理由:这些字符串要在服务器上躺 30 天,而擦两遍的代价只是几个正则。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { countDiagReportsSince, DIAG_COMPONENTS, DIAG_KINDS, DIAG_RETENTION_DAYS, parseDiagReport, pruneDiagReports, scrubDiagText } from '../server/diag.cjs';
import { issueToken } from '../server/tokens.cjs';

const ADMIN = 'admintoken-only-in-tests';

let server;
let db;
let base;
let clock;

function nowOf() {
  return clock;
}

async function serve(env = {}) {
  db = openRelayDb(':memory:');
  clock = new Date('2026-09-22T10:00:00.000Z');
  const config = relayConfigOf({ RELAY_ADMIN_TOKEN: ADMIN, ...env });
  const app = createApp({ db, config, now: nowOf });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
}

function issue(account = 'ben', deviceId = 'mac-1') {
  return issueToken(db, { account, deviceId, dailyTokenLimit: 1000, now: clock }).token;
}

function body(patch = {}) {
  return {
    version: '0.2.54',
    component: 'plugin',
    kind: 'unhandled',
    code: 'WB-3F2A91',
    message: '读 app.json 失败',
    stack: ['at loadAppConfigFile (/x/appConfig.ts:60)', 'at async compose (/x/http.ts:2646)'],
    log: ['[工作台] 起来了', '[工作台] 读 app.json 失败'],
    at: '2026-09-22T09:59:00.000Z',
    ...patch,
  };
}

async function post(token, patch = {}) {
  return await fetch(`${base}/v1/diag/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body(patch)),
  });
}

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
  db?.close?.();
  db = undefined;
});

describe('parseDiagReport(纯函数)', () => {
  it('认得的组件与种类各自是一份闭集', () => {
    expect([...DIAG_COMPONENTS]).toContain('plugin');
    expect([...DIAG_COMPONENTS]).toContain('worker');
    expect([...DIAG_COMPONENTS]).toContain('butler');
    // 前四类是机器自己报的错;第五类 feedback 是人说的(2026-09-28,卡 FB)。
    expect([...DIAG_KINDS]).toEqual(['unhandled', 'crash_restart', 'update_failed', 'call_closed', 'feedback']);
  });

  it('组件不认得就 400,而且错误码说得出是哪一项', () => {
    const out = parseDiagReport({ ...body(), component: '随便写的' });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.code).toBe('bad_component');
  });

  it('种类不认得也 400', () => {
    expect(parseDiagReport({ ...body(), kind: 'boom' })).toMatchObject({ ok: false, code: 'bad_kind' });
  });

  it('message 截断到 500 字,stack 只留前 20 行,log 只留最后 50 行', () => {
    const out = parseDiagReport(body({
      message: 'x'.repeat(2000),
      stack: Array.from({ length: 50 }, (_, i) => `frame-${i}`),
      log: Array.from({ length: 200 }, (_, i) => `line-${i}`),
    }));
    expect(out.ok).toBe(true);
    expect(out.value.message.length).toBe(500);
    expect(out.value.stack.length).toBe(20);
    // 栈取**前** 20 行:最上面那几帧才是出事的地方。
    expect(out.value.stack[0]).toBe('frame-0');
    expect(out.value.log.length).toBe(50);
    // 日志取**最后** 50 行:最后那几行才是出事前后的现场。
    expect(out.value.log[49]).toBe('line-199');
  });

  it('at 写坏了不报错,按"没说"处理(收下的时刻由服务器记)', () => {
    const out = parseDiagReport(body({ at: '昨天下午' }));
    expect(out.ok).toBe(true);
    expect(out.value.at).toBeUndefined();
  });

  it('merged 缺席算 1;写成 0 或负数一律当 1', () => {
    expect(parseDiagReport(body()).value.merged).toBe(1);
    expect(parseDiagReport(body({ merged: 0 })).value.merged).toBe(1);
    expect(parseDiagReport(body({ merged: 7 })).value.merged).toBe(7);
  });

  it('编号形状不对就丢掉这一格,不让整条上报失败', () => {
    const out = parseDiagReport(body({ code: '这不是编号' }));
    expect(out.ok).toBe(true);
    expect(out.value.code).toBe('');
  });
});

describe('scrubDiagText(第二张网)', () => {
  it('家目录里的用户名换成占位', () => {
    expect(scrubDiagText('/Users/example/.dsh/logs/web.stdout.log')).toBe('/Users/<用户>/.dsh/logs/web.stdout.log');
  });

  it('中转令牌只留前缀', () => {
    expect(scrubDiagText('token=wb_kPBgbXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')).not.toContain('kPBgbXXXX');
  });

  it('DSH 网页地址里那个 token 不留', () => {
    // 夹具:假值,形状同 DSH 启动令牌(43 位 base64url),不是真令牌。
    const line = 'dsh web: http://127.0.0.1:3080/?token=fakeDshLaunchTokenTestFixture00000000000000';
    const out = scrubDiagText(line);
    expect(out).not.toContain('fakeDshLaunchTok');
    expect(out).toContain('127.0.0.1:3080');
  });

  it('Authorization 头、sk- 开头的 Key、JWT 都擦掉', () => {
    expect(scrubDiagText('Authorization: Bearer wb_abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(scrubDiagText('key=sk-0123456789abcdefghij')).not.toContain('0123456789abcdefghij');
    expect(scrubDiagText('eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM')).not.toContain('SflKxwRJSM');
  });

  it('不是密钥的普通中文一个字都不动', () => {
    const line = '[工作台] 读 app.json 失败:ENOENT';
    expect(scrubDiagText(line)).toBe(line);
  });
});

describe('POST /v1/diag/report', () => {
  beforeEach(() => serve());

  it('没有令牌就 401', async () => {
    const res = await fetch(`${base}/v1/diag/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
  });

  it('带设备令牌收得下,回包里有 id 与"这一小时还能报几条"', async () => {
    const res = await post(issue());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(typeof out.id).toBe('string');
    expect(out.remaining_this_hour).toBe(19);
  });

  it('存下来的那一行**没有明文令牌**,只有账号、设备与 prefix', async () => {
    const token = issue();
    await post(token);
    const row = db.prepare('SELECT * FROM diag_reports').get();
    expect(row.account).toBe('ben');
    expect(row.device_id).toBe('mac-1');
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('中转自己再擦一遍:设备那头漏过去的路径用户名不会落库', async () => {
    await post(issue(), { message: '读 /Users/example/.dsh/workbench/app.json 失败' });
    const row = db.prepare('SELECT message FROM diag_reports').get();
    expect(row.message).not.toContain('/Users/example/');
    expect(row.message).toContain('/Users/<用户>/');
  });

  it('一小时 20 条封顶,第 21 条 429 并说多久之后能再来', async () => {
    const token = issue();
    for (let i = 0; i < 20; i += 1) expect((await post(token)).status).toBe(200);
    const over = await post(token);
    expect(over.status).toBe(429);
    const out = await over.json();
    expect(out.error.code).toBe('diag_rate_limited');
    expect(out.retry_after_seconds).toBeGreaterThan(0);
  });

  it('封顶是**按设备**算的:另一台照样报得进来', async () => {
    const a = issue('ben', 'mac-1');
    const b = issue('ben', 'mac-2');
    for (let i = 0; i < 20; i += 1) await post(a);
    expect((await post(a)).status).toBe(429);
    expect((await post(b)).status).toBe(200);
  });

  it('一小时窗口滑过去就又能报', async () => {
    const token = issue();
    for (let i = 0; i < 20; i += 1) await post(token);
    expect((await post(token)).status).toBe(429);
    clock = new Date('2026-09-22T11:00:01.000Z');
    expect((await post(token)).status).toBe(200);
  });
});

describe('GET /v1/diag/reports', () => {
  beforeEach(() => serve());

  it('**设备令牌读不到** —— 写得进去不等于看得见', async () => {
    const token = issue();
    await post(token);
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('admin_token_required');
  });

  it('没有令牌也 403', async () => {
    expect((await fetch(`${base}/v1/diag/reports`)).status).toBe(403);
  });

  it('管理员令牌读得到,回的是最近的在前', async () => {
    const token = issue();
    await post(token, { message: '第一条' });
    clock = new Date('2026-09-22T10:05:00.000Z');
    await post(token, { message: '第二条' });
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.rows.length).toBe(2);
    expect(out.rows[0].message).toBe('第二条');
    expect(out.retention_days).toBe(DIAG_RETENTION_DAYS);
  });

  it('?device= 只看那一台', async () => {
    await post(issue('ben', 'mac-1'), { message: '这台' });
    await post(issue('ben', 'mac-2'), { message: '那台' });
    const res = await fetch(`${base}/v1/diag/reports?device=mac-2`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const out = await res.json();
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].message).toBe('那台');
  });

  it('回的行里没有 token_hash', async () => {
    await post(issue());
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(JSON.stringify(await res.json())).not.toContain('token_hash');
  });

  it('服务器上没配 RELAY_ADMIN_TOKEN 时这条路整个关着(503,不是"随便谁都能看")', async () => {
    await new Promise(done => server.close(done));
    db.close();
    await serve({ RELAY_ADMIN_TOKEN: '' });
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('admin_not_configured');
  });
});

describe('保留期', () => {
  beforeEach(() => serve());

  it('过了 30 天的行在下一次读的时候被清掉', async () => {
    const token = issue();
    await post(token, { message: '很久以前' });
    clock = new Date('2026-10-23T10:00:01.000Z');
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect((await res.json()).rows.length).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM diag_reports').get().n).toBe(0);
  });

  it('29 天前的还留着', async () => {
    await post(issue(), { message: '上个月月底' });
    clock = new Date('2026-10-21T10:00:00.000Z');
    const res = await fetch(`${base}/v1/diag/reports`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect((await res.json()).rows.length).toBe(1);
  });

  it('pruneDiagReports 回清掉了几行', async () => {
    await post(issue());
    expect(pruneDiagReports(db, new Date('2026-09-22T10:00:00.000Z'))).toBe(0);
    expect(pruneDiagReports(db, new Date('2026-11-22T10:00:00.000Z'))).toBe(1);
  });

  it('countDiagReportsSince 数的是这台设备这一小时的条数', async () => {
    const token = issue();
    await post(token);
    await post(token);
    const row = db.prepare('SELECT token_hash FROM diag_reports').get();
    expect(countDiagReportsSince(db, row.token_hash, new Date('2026-09-22T09:00:00.000Z'))).toBe(2);
    expect(countDiagReportsSince(db, row.token_hash, new Date('2026-09-22T10:00:01.000Z'))).toBe(0);
  });
});

// 「反馈给开发者」那一类(2026-09-28,卡 FB)。
//
// 工作台**本体**的毛病(界面 / 功能 / bug)不派用户自己的 Agent 改 —— 事务官整理成一条发到这儿,
// 统筹用 `?kind=feedback` 拉。要钉住的是:多的那两格(原话 / 当时的模板与布局)存得下、擦得干净、筛得出来。
describe('kind=feedback:用户反馈', () => {
  beforeEach(async () => { await serve(); });

  function feedback(patch = {}) {
    return {
      kind: 'feedback',
      message: '工作台「发布计划」:发布计划那里没有标记今天是哪一天,这个不方便',
      stack: [],
      log: [],
      said: '发布计划那里没有标记今天是哪一天,这个不方便,安排 Codex 去处理吧',
      context: '模板:自媒体运营;摆着的:账号、选题池、发布计划',
      ...patch,
    };
  }

  it('收下并存住那两格', async () => {
    const res = await post(issue(), feedback());
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT kind, said, context FROM diag_reports').get();
    expect(row.kind).toBe('feedback');
    expect(row.said).toContain('没有标记今天');
    expect(row.context).toContain('自媒体运营');
  });

  it('那两格也过第二张网:原话里的 Key / 家目录擦掉', async () => {
    await post(issue(), feedback({ said: '我在 /Users/arong/Desktop 截的图,顺便说 sk-abcdefgh12345678 这个 key 不对' }));
    const row = db.prepare('SELECT said FROM diag_reports').get();
    expect(row.said).toContain('/Users/<用户>');
    expect(row.said).not.toContain('sk-abcdefgh12345678');
  });

  it('报错那四类不带这两格,库里是 NULL', async () => {
    await post(issue());
    const row = db.prepare('SELECT said, context FROM diag_reports').get();
    expect(row.said).toBeNull();
    expect(row.context).toBeNull();
  });

  it('?kind=feedback 只拉反馈;认不出的 kind 当没筛', async () => {
    const token = issue();
    await post(token, { message: '崩了一次' });
    clock = new Date('2026-09-22T10:05:00.000Z');
    await post(token, feedback());
    const only = await (await fetch(`${base}/v1/diag/reports?kind=feedback`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(only.rows.length).toBe(1);
    expect(only.rows[0].said).toContain('没有标记今天');
    const all = await (await fetch(`${base}/v1/diag/reports?kind=瞎写的`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(all.rows.length).toBe(2);
  });
});
