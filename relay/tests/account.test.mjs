// 账号搬到服务器(2026-09-21)。这个文件盯住的是**边界**,不是功能:
//
//   1. 密码、盐、哈希、会话令牌一个字节都不许出现在任何回包里;
//   2. 一个账号的会话看不到、也动不了另一个账号的设备;
//   3. **知道别人的账号名领不到别人的房** —— 这是整张卡存在的理由
//      (上一张卡自己记下来的那个洞,见 docs/交接-0921-通道密钥下发与DSH走中转.md 第七节)。
//
// 全部对着真 http 面跑。
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { issueToken } from '../server/tokens.cjs';
import { accountScopeOf } from '../server/accounts.cjs';
import { channelRoomOf } from '../server/channel.cjs';

const LIVEKIT_KEY = 'APIfakefake';
const LIVEKIT_SECRET = 'secret-fake-do-not-use-0921';

let server;
let db;
let base;

function channelEnv(extra = {}) {
  return {
    RELAY_CHANNEL_LIVEKIT_URL: 'wss://lk.example.test',
    RELAY_CHANNEL_LIVEKIT_API_KEY: LIVEKIT_KEY,
    RELAY_CHANNEL_LIVEKIT_API_SECRET: LIVEKIT_SECRET,
    ...extra,
  };
}

async function startRelay(env = channelEnv(), overrides = {}) {
  db = openRelayDb(':memory:');
  const config = { ...relayConfigOf(env), ...overrides };
  const app = createApp({ db, config });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return config;
}

const post = (path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body ?? {}),
});

const get = (path, token) => fetch(`${base}${path}`, {
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
});

/** 注册一个账号并把这台设备也领好令牌。返回 `{ session, device, accountId }`。 */
async function signUp(identifier, password = 'hunter22', device = { device_id: 'mac-1', name: '我的 Mac', kind: 'mac' }) {
  const registered = await (await post('/v1/account/register', { email_or_phone: identifier, password })).json();
  const issued = await (await post('/register-device', device, registered.session_token)).json();
  return { session: registered.session_token, device: issued.token, accountId: registered.account.id };
}

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
});

describe('注册与登录', () => {
  it('注册回一张会话令牌与账号本身,**不回密码相关的任何东西**', async () => {
    await startRelay();
    const res = await post('/v1/account/register', { email_or_phone: 'Ben@Example.com', password: 'hunter22' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session_token.startsWith('wbs_')).toBe(true);
    // 标识被转成小写了 —— 隔天自己大写一个字母还登得进来。
    expect(body.account.email_or_phone).toBe('ben@example.com');
    const text = JSON.stringify(body);
    for (const forbidden of ['hash', 'salt', 'password', 'hunter22']) {
      expect(text.includes(forbidden), `回包里不该出现 ${forbidden}`).toBe(false);
    }
  });

  it('同一个邮箱注册两次回 409,而不是悄悄覆盖', async () => {
    await startRelay();
    await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    const again = await post('/v1/account/register', { email_or_phone: 'BEN@x.com', password: 'other-pass' });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('account_exists');
  });

  it('登录回一张新的会话令牌;两张都好使(两台设备各登各的)', async () => {
    await startRelay();
    const first = await (await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    const second = await (await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    expect(second.session_token).not.toBe(first.session_token);
    expect((await get('/v1/account/me', first.session_token)).status).toBe(200);
    expect((await get('/v1/account/me', second.session_token)).status).toBe(200);
  });

  it('电脑端那份「文案照旧」的登录页发 username 也认', async () => {
    await startRelay();
    await post('/v1/account/register', { username: 'ben', password: 'hunter22' });
    const login = await post('/v1/account/login', { username: 'ben', password: 'hunter22' });
    expect(login.status).toBe(200);
  });

  it('密码错与账号不存在回同一句话、同一个状态码', async () => {
    await startRelay();
    await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    const wrongPassword = await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'nope-nope' });
    const noSuchAccount = await post('/v1/account/login', { email_or_phone: 'nobody@x.com', password: 'nope-nope' });
    expect(wrongPassword.status).toBe(noSuchAccount.status);
    expect((await wrongPassword.json()).error.message).toBe((await noSuchAccount.json()).error.message);
  });

  it('密码连错 5 次就锁住,锁着的时候**连对的密码也不放行**', async () => {
    await startRelay();
    await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    for (let i = 0; i < 5; i += 1) {
      await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: `wrong-${i}` });
    }
    const right = await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    expect(right.status).toBe(429);
    expect((await right.json()).error.code).toBe('account_locked');
  });

  it('锁的是这一个标识,不牵连别人', async () => {
    await startRelay();
    await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    await post('/v1/account/register', { email_or_phone: 'her@x.com', password: 'hunter22' });
    for (let i = 0; i < 5; i += 1) {
      await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: `wrong-${i}` });
    }
    expect((await post('/v1/account/login', { email_or_phone: 'her@x.com', password: 'hunter22' })).status).toBe(200);
  });

  it('同一个 IP 拿不同邮箱撞密码:失败攒够了就被拦(按标识那道闸拦不住这种打法)', async () => {
    await startRelay(channelEnv(), { registerPerHour: 2 });  // 失败额度 = 2 × 3 = 6
    for (let i = 0; i < 6; i += 1) {
      const res = await post('/v1/account/login', { email_or_phone: `victim-${i}@x.com`, password: 'password123' });
      expect(res.status).toBe(401);
    }
    const blocked = await post('/v1/account/login', { email_or_phone: 'victim-9@x.com', password: 'password123' });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('login_rate_limited');
  });

  it('**登录成功不记一笔** —— 正常人不该因为登得勤被限', async () => {
    await startRelay(channelEnv(), { registerPerHour: 2 });
    await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' });
    for (let i = 0; i < 10; i += 1) {
      expect((await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).status).toBe(200);
    }
  });

  it('太短的密码、空标识都回 400', async () => {
    await startRelay();
    expect((await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'ab' })).status).toBe(400);
    expect((await post('/v1/account/register', { email_or_phone: '   ', password: 'hunter22' })).status).toBe(400);
    expect((await post('/v1/account/register', { email_or_phone: 'a b@x.com', password: 'hunter22' })).status).toBe(400);
  });

  it('登出把这一张吊销,别的设备上那张不受影响', async () => {
    await startRelay();
    const a = await (await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    const b = await (await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    expect((await post('/v1/account/logout', {}, a.session_token)).status).toBe(200);
    expect((await get('/v1/account/me', a.session_token)).status).toBe(401);
    expect((await get('/v1/account/me', b.session_token)).status).toBe(200);
  });

  it('登出一张认不出的令牌也回 ok —— 登出没有「失败」这个状态', async () => {
    await startRelay();
    expect((await post('/v1/account/logout', {}, 'wbs_not-a-real-one')).status).toBe(200);
  });

  it('/v1/account/me 不带令牌回 401', async () => {
    await startRelay();
    expect((await get('/v1/account/me')).status).toBe(401);
  });
});

describe('改密码', () => {
  it('改完之后旧密码不认、新密码认;**别处的登录被撤掉,自己这张还在**', async () => {
    await startRelay();
    const a = await (await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    const b = await (await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();

    const changed = await post('/v1/account/password', { current_password: 'hunter22', password: 'new-pass-9' }, a.session_token);
    expect(changed.status).toBe(200);

    expect((await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).status).toBe(401);
    expect((await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'new-pass-9' })).status).toBe(200);
    // 改密码的那一张还在,别处那张没了。
    expect((await get('/v1/account/me', a.session_token)).status).toBe(200);
    expect((await get('/v1/account/me', b.session_token)).status).toBe(401);
  });

  it('当前密码说不对就不改', async () => {
    await startRelay();
    const a = await (await post('/v1/account/register', { email_or_phone: 'ben@x.com', password: 'hunter22' })).json();
    const res = await post('/v1/account/password', { current_password: 'wrong-one', password: 'new-pass-9' }, a.session_token);
    expect(res.status).toBe(401);
    expect((await post('/v1/account/login', { email_or_phone: 'ben@x.com', password: 'hunter22' })).status).toBe(200);
  });
});

describe('设备归账号', () => {
  it('领令牌要账号会话;领到的设备记在账号名下', async () => {
    await startRelay();
    const { session, accountId } = await signUp('ben@x.com');
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ device_id: 'mac-1', name: '我的 Mac', kind: 'mac' });
    // 库里那一行的 account 列是 `acct:<id>`,不是用户起的任何名字。
    const row = db.prepare('SELECT account FROM tokens WHERE device_id = ?').get('mac-1');
    expect(row.account).toBe(accountScopeOf(accountId));
  });

  it('设备列表里**没有令牌、没有哈希**', async () => {
    await startRelay();
    const { session, device } = await signUp('ben@x.com');
    const text = await (await get('/v1/account/devices', session)).text();
    expect(text.includes(device)).toBe(false);
    expect(text.includes('token')).toBe(false);
    expect(text.includes('hash')).toBe(false);
  });

  it('第二台设备进同一个账号;两台设备算出的是同一间房', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    const phone = await (await post('/register-device', { device_id: 'phone-1', name: '我的手机', kind: 'phone' }, session)).json();
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices.map(d => d.device_id).sort()).toEqual(['mac-1', 'phone-1']);

    const mac = await (await get('/v1/channel-credentials', (await signInDevice(session, 'mac-1')))).json();
    const fromPhone = await (await get('/v1/channel-credentials', phone.token)).json();
    expect(fromPhone.livekit.room).toBe(mac.livekit.room);
  });

  /**
   * 电脑、手机、**座机**三台同一间房(2026-09-27,卡 RM)。
   *
   * 这一条钉的是 0927 那件事的下半段:座机提机、以及「给座机换网络」(手机经房间把
   * netcfg 发给座机、电脑的 `/devices/online` 里看得见它)全都只在**三台在同一间房**时成立。
   * 电脑那把令牌是登录之后重领的(`signInDevice` 带着会话),所以它与座机算出同一间。
   */
  it('电脑、手机、座机三台在同一间房(提机与给座机换网络都靠这一条)', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    const phone = await (await post('/register-device', { device_id: 'phone-1', kind: 'phone' }, session)).json();
    const handset = await (await post('/register-device', { device_id: 'handset-4b4a', kind: 'handset' }, session)).json();
    const mac = await (await get('/v1/channel-credentials', await signInDevice(session, 'mac-1'))).json();

    const roomOf = async token => (await (await get('/v1/channel-credentials', token)).json()).livekit.room;
    expect(await roomOf(phone.token)).toBe(mac.livekit.room);
    expect(await roomOf(handset.token)).toBe(mac.livekit.room);
  });

  it('移除一台之后它的令牌当场失效', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    const phone = await (await post('/register-device', { device_id: 'phone-1', kind: 'phone' }, session)).json();
    expect((await get('/v1/channel-credentials', phone.token)).status).toBe(200);
    const removed = await (await post('/v1/account/devices/revoke', { device_id: 'phone-1' }, session)).json();
    expect(removed.removed).toBe(1);
    expect(removed.devices.map(d => d.device_id)).toEqual(['mac-1']);
    expect((await get('/v1/channel-credentials', phone.token)).status).toBe(401);
  });

  it('移除别人账号里的 device_id:什么也不发生,而且不告诉你它存在', async () => {
    await startRelay();
    const mine = await signUp('ben@x.com');
    const hers = await signUp('her@x.com', 'hunter22', { device_id: 'her-phone', kind: 'phone' });
    const res = await post('/v1/account/devices/revoke', { device_id: 'her-phone' }, mine.session);
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(0);
    // 她那台照样好使。
    expect((await get('/v1/channel-credentials', hers.device)).status).toBe(200);
  });

  it('别人的会话看不到我的设备', async () => {
    await startRelay();
    await signUp('ben@x.com');
    const hers = await signUp('her@x.com', 'hunter22', { device_id: 'her-phone', kind: 'phone' });
    const list = await (await get('/v1/account/devices', hers.session)).json();
    expect(list.devices.map(d => d.device_id)).toEqual(['her-phone']);
  });

  it('认不出的会话令牌来领设备令牌 → 401,**不悄悄退回老路**', async () => {
    await startRelay();
    const res = await post('/register-device', { device_id: 'mac-9', account: 'ben' }, 'wbs_forged-one');
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_account_session');
  });

  it('设备类型只认那几种', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    expect((await post('/register-device', { device_id: 'x', kind: '<img>' }, session)).status).toBe(400);
  });

  /**
   * 2026-09-23:树莓派话筒以前只能报 `other`,于是中转签进房凭证时说不出「这是一只听筒」。
   * 这一类不只是图标 —— `/v1/channel-token` 按它往凭证里签 `wb_kind`。
   */
  it('认 handset,而且「我的设备」里看得到这一类', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    const res = await post('/register-device', { device_id: 'pi-1', name: '客厅话筒', kind: 'handset' }, session);
    expect(res.status).toBe(201);
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices.find(d => d.device_id === 'pi-1').kind).toBe('handset');
  });

  it('已经注册成 other 的那台,再跑一次就把种类改过来(不算新设备)', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    await post('/register-device', { device_id: 'pi-1', name: '客厅话筒', kind: 'other' }, session);
    await post('/register-device', { device_id: 'pi-1', name: '客厅话筒', kind: 'handset' }, session);
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices.filter(d => d.device_id === 'pi-1').length).toBe(1);
    expect(list.devices.find(d => d.device_id === 'pi-1').kind).toBe('handset');
  });

  it('同一台设备重领时,之前起的名字还在', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    await post('/register-device', { device_id: 'mac-1' }, session);
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices[0].name).toBe('我的 Mac');
  });
});

describe('房间边界:知道别人的账号名也领不到别人的房', () => {
  it('老路(账号名)压根算不出房间 —— 2026-09-27 起它取不到通道凭据', async () => {
    await startRelay();
    const { session, device } = await signUp('ben@x.com');
    const mine = await (await get('/v1/channel-credentials', device)).json();

    // 攻击者知道「ben@x.com」这个名字,用老路给自己领一把令牌。
    const attacker = await (await post('/register-device', { account: 'ben@x.com', device_id: 'evil-1' })).json();
    /**
     * 2026-09-27(卡 RM)起这条更硬了:老路那把令牌**没有房间**可算 ——
     * 它进不去别人的房,也进不去自己的房,回的是 `not_bound_to_account`。
     * (那把令牌照样能调模型,见 channel.test.mjs 的「房间只认账号」。)
     */
    const theirs = await get('/v1/channel-credentials', attacker.token);
    expect(theirs.status).toBe(403);
    expect((await theirs.json()).error.code).toBe('not_bound_to_account');

    // 真正的房间名由账号 id 算,**不是**由标识算 —— 这是这张卡的全部意义。
    const accountId = (await (await get('/v1/account/me', session)).json()).id;
    expect(mine.livekit.room).toBe(channelRoomOf(accountScopeOf(accountId)));
    expect(mine.livekit.room).not.toBe(channelRoomOf('ben@x.com'));
  });

  it('拿别人的房间名去签进房凭证:400 room_not_yours', async () => {
    await startRelay();
    const mine = await signUp('ben@x.com');
    const hers = await signUp('her@x.com', 'hunter22', { device_id: 'her-phone', kind: 'phone' });
    const hersRoom = (await (await get('/v1/channel-credentials', hers.device)).json()).livekit.room;

    const res = await post('/v1/channel-token', { identity: 'wb-evil', room: hersRoom }, mine.device);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('room_not_yours');
  });

  it('同一个账号换一台设备,房间不变(电脑与手机本来就该在一起)', async () => {
    await startRelay();
    const { session, device } = await signUp('ben@x.com');
    const phone = await (await post('/register-device', { device_id: 'phone-1', kind: 'phone' }, session)).json();
    const a = await (await get('/v1/channel-credentials', device)).json();
    const b = await (await get('/v1/channel-credentials', phone.token)).json();
    expect(a.livekit.room).toBe(b.livekit.room);
    // 而且手机用这个房间名真的签得出凭证。
    const signed = await post('/v1/channel-token', { identity: 'wb-phone-1', room: b.livekit.room }, phone.token);
    expect(signed.status).toBe(200);
  });
});

describe('老客户端的兼容路', () => {
  it('默认开着:不带会话、带 account 照样领得到(旧插件不会因为部署而挂掉)', async () => {
    await startRelay();
    const res = await post('/register-device', { account: 'ben', device_id: 'old-mac' });
    expect(res.status).toBe(201);
    expect((await res.json()).token.startsWith('wb_')).toBe(true);
  });

  it('关掉之后老路回 401,并指路去登录', async () => {
    await startRelay(channelEnv({ RELAY_ALLOW_LEGACY_REGISTER: '0' }));
    const res = await post('/register-device', { account: 'ben', device_id: 'old-mac' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('account_session_required');
  });

  it('/health 说得出这台中转支不支持账号、老路还开着没有', async () => {
    await startRelay(channelEnv({ RELAY_ALLOW_LEGACY_REGISTER: '0' }));
    const health = await (await get('/health')).json();
    expect(health.accounts).toBe(true);
    expect(health.legacy_register).toBe(false);
  });

  it('老路领的设备不出现在任何账号的「我的设备」里', async () => {
    await startRelay();
    const { session } = await signUp('ben@x.com');
    await post('/register-device', { account: 'ben@x.com', device_id: 'old-mac' });
    const list = await (await get('/v1/account/devices', session)).json();
    expect(list.devices.map(d => d.device_id)).toEqual(['mac-1']);
  });
});

describe('存量库原地升级', () => {
  it('老库(没有 device_name / device_kind / last_seen_at 三列)打开时自己补上', () => {
    // 手搓一张这张卡之前的 tokens 表,再让 openRelayDb 去补。
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(':memory:');
    old.exec(`CREATE TABLE tokens (
      token_hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, account TEXT NOT NULL, device_id TEXT NOT NULL,
      daily_token_limit INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);`);
    old.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run('hash-1', 'wb_old12', 'ben', 'mac-1', 500000, '2026-09-01T00:00:00.000Z');
    const { migrate } = require('../server/db.cjs');
    migrate(old);
    const columns = old.prepare('PRAGMA table_info(tokens)').all().map(r => r.name);
    expect(columns).toContain('device_name');
    expect(columns).toContain('device_kind');
    expect(columns).toContain('last_seen_at');
    // 老行还在,新列是 NULL。
    const row = old.prepare('SELECT * FROM tokens WHERE token_hash = ?').get('hash-1');
    expect(row.account).toBe('ben');
    expect(row.device_name).toBe(null);
    // 重复跑一遍不出错。
    expect(() => migrate(old)).not.toThrow();
    old.close();
  });
});

describe('上次在线', () => {
  it('设备用过一次之后「上次在线」就有值了', async () => {
    await startRelay();
    const { session, device } = await signUp('ben@x.com');
    await get('/v1/channel-credentials', device);
    const list = await (await get('/v1/account/devices', session)).json();
    expect(typeof list.devices[0].last_seen_at).toBe('string');
  });
});

/** 这台 Mac 自己那把设备令牌。signUp 已经领过,这里只是把它取出来给用例读着方便。 */
async function signInDevice(session, deviceId) {
  const issued = await (await post('/register-device', { device_id: deviceId }, session)).json();
  return issued.token;
}
