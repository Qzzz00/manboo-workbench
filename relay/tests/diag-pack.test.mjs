// 诊断包存放位(2026-10-21,内测发版底座)。
//
// 她在手机(或电脑)上按一下「发诊断包」,电脑打好包传到这里,手机上显示一个短编号;
// 统筹拿编号取。要钉死的几件事:
//   ① **谁能传**:只认设备令牌,没有 / 认不出 401 —— 而且**不读完请求体就拒**(不让陌生人白传几十兆);
//   ② **谁能取**:管理员令牌取谁的都行;设备令牌只取得到**自己账号**的;别人的与不存在的说同一句 404;
//   ③ **形状**:只收 zip(看开头四个字节),超过上限 413,回包都是 OpenAI 形状的人话;
//   ④ **过期**:7 天,过期的行与文件在下一次读写时一起清掉;
//   ⑤ **限量**:每台设备一天 10 个,多了 429。
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import {
  DIAG_PACK_CODE_RE, DIAG_PACK_MAX_BYTES, DIAG_PACK_PER_DAY, DIAG_PACK_RETENTION_DAYS, newDiagPackCode,
} from '../server/diagPacks.cjs';
import { issueToken } from '../server/tokens.cjs';

const ADMIN = 'admintoken-only-in-tests';
/** 一个最小的「像 zip」的包:开头是 PK\x03\x04,后面随便。 */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('诊断包的内容')]);

let server;
let db;
let base;
let clock;
let packsDir;

beforeEach(async () => {
  packsDir = mkdtempSync(join(tmpdir(), 'relay-diag-packs-'));
  db = openRelayDb(':memory:');
  clock = new Date('2026-10-21T10:00:00.000Z');
  const config = { ...relayConfigOf({ RELAY_ADMIN_TOKEN: ADMIN }), diagPacksDir: packsDir };
  const app = createApp({ db, config, now: () => clock });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
  if (packsDir !== undefined) rmSync(packsDir, { recursive: true, force: true });
  packsDir = undefined;
});

function issue(account = 'ben', deviceId = 'mac-1') {
  return issueToken(db, { account, deviceId, dailyTokenLimit: 1000, now: clock }).token;
}

async function upload(token, bytes = ZIP, headers = {}) {
  return await fetch(`${base}/v1/diag/pack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-workbench-version': '0.4.143',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: bytes,
  });
}

async function download(code, token) {
  return await fetch(`${base}/v1/diag/pack/${code}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('编号', () => {
  it('六位,不含容易念错的 0 O 1 I L U', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newDiagPackCode();
      expect(code).toMatch(DIAG_PACK_CODE_RE);
      expect(code).not.toMatch(/[01OILU]/);
    }
  });
});

describe('POST /v1/diag/pack', () => {
  it('设备令牌传上来 → 回编号与到期时刻(7 天),文件落在存放目录', async () => {
    const res = await upload(issue());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(DIAG_PACK_CODE_RE);
    expect(body.bytes).toBe(ZIP.length);
    expect(body.retention_days).toBe(DIAG_PACK_RETENTION_DAYS);
    expect(Date.parse(body.expires_at) - clock.getTime()).toBe(DIAG_PACK_RETENTION_DAYS * 86_400_000);
    expect(readdirSync(packsDir)).toEqual([`${body.code}.zip`]);
  });

  it('★没令牌 / 令牌认不出 → 401,一个字节都不落盘', async () => {
    expect((await upload(undefined)).status).toBe(401);
    expect((await upload('wb_not_a_real_token_123456')).status).toBe(401);
    expect(readdirSync(packsDir)).toEqual([]);
  });

  it('不是 zip(类型不对 / 开头不是 PK)→ 拒,人话', async () => {
    const token = issue();
    const wrongType = await upload(token, ZIP, { 'content-type': 'application/octet-stream' });
    expect(wrongType.status).toBe(415);
    expect((await wrongType.json()).error.code).toBe('diag_pack_not_zip');
    const notZip = await upload(token, Buffer.from('hello'));
    expect(notZip.status).toBe(400);
    expect((await notZip.json()).error.code).toBe('diag_pack_not_zip');
    expect(readdirSync(packsDir)).toEqual([]);
  });

  it('超过上限 → 413,OpenAI 形状的人话(不是框架的 HTML 页)', async () => {
    const big = Buffer.alloc(DIAG_PACK_MAX_BYTES + 1, 0);
    ZIP.copy(big, 0, 0, 4);
    const res = await upload(issue(), big);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('diag_pack_too_large');
    expect(body.error.message).toContain('MB');
    expect(readdirSync(packsDir)).toEqual([]);
  });

  it(`每台设备一天最多 ${DIAG_PACK_PER_DAY} 个,多了 429;换一台照样能传`, async () => {
    const token = issue();
    for (let i = 0; i < DIAG_PACK_PER_DAY; i += 1) expect((await upload(token)).status).toBe(200);
    const over = await upload(token);
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe('diag_pack_rate_limited');
    expect((await upload(issue('ben', 'phone-1'))).status).toBe(200);
  });
});

describe('GET /v1/diag/pack/:code', () => {
  it('管理员令牌取得到谁的都行,拿到的就是传上来的那几个字节', async () => {
    const { code } = await (await upload(issue('ronglin', 'mac-9'))).json();
    const res = await download(code, ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`diag-${code}.zip`);
    expect(res.headers.get('x-diag-pack-version')).toBe('0.4.143');
    expect(Buffer.from(await res.arrayBuffer()).equals(ZIP)).toBe(true);
  });

  it('编号不分大小写、可带空格与横杠(念出来、抄下来都对得上)', async () => {
    const { code } = await (await upload(issue())).json();
    const typed = `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`;
    expect((await download(encodeURIComponent(typed), ADMIN)).status).toBe(200);
  });

  it('★同一个账号的另一台设备取得到;别的账号取不到,与「不存在」说同一句', async () => {
    const { code } = await (await upload(issue('ben', 'mac-1'))).json();
    expect((await download(code, issue('ben', 'phone-1'))).status).toBe(200);
    const other = await download(code, issue('stranger', 'mac-x'));
    const missing = await download('ZZZZZZ', issue('stranger', 'mac-x'));
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await other.json()).error.message).toBe((await missing.json()).error.message);
  });

  it('没令牌 → 401', async () => {
    const { code } = await (await upload(issue())).json();
    expect((await download(code, undefined)).status).toBe(401);
  });

  it(`★过了 ${DIAG_PACK_RETENTION_DAYS} 天:取不到,行与文件在下一次读写时一起清掉`, async () => {
    const { code } = await (await upload(issue())).json();
    clock = new Date(clock.getTime() + DIAG_PACK_RETENTION_DAYS * 86_400_000 + 1000);
    expect((await download(code, ADMIN)).status).toBe(404);
    expect(existsSync(join(packsDir, `${code}.zip`))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM diag_packs').get().n).toBe(0);
  });
});
