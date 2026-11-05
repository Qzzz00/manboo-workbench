// 通道凭据由中转下发(2026-09-21)。两条路:
//
//   GET  /v1/channel-credentials  这台设备的通道怎么连(**不含 LiveKit 的 api key / secret**)
//   POST /v1/channel-token        中转替它签一张进房凭证(secret 只在服务器上)
//
// 这个文件盯住的是**密钥边界**:哪些值允许出现在回包里,哪些一个字节都不许。
// 纯函数那几条在 pure.test.mjs 里;这里全部对着真 http 面跑。
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { issueToken } from '../server/tokens.cjs';
import { CHANNEL_ADMIN_TTL_SECONDS, channelRoomOf, decodeJwtPayload } from '../server/channel.cjs';

const LIVEKIT_KEY = 'APIfakefake';
const LIVEKIT_SECRET = 'secret-fake-do-not-use-0921';
const VOLC_ASR_TOKEN = 'volc-asr-token-fake';
const VOLC_TTS_TOKEN = 'volc-tts-token-fake';

let server;
let db;
let base;

/** 一整套配齐的通道环境变量。测试里想验"少配一样"时把对应项删掉。 */
function channelEnv(extra = {}) {
  return {
    RELAY_CHANNEL_LIVEKIT_URL: 'wss://lk.example.test',
    RELAY_CHANNEL_LIVEKIT_API_KEY: LIVEKIT_KEY,
    RELAY_CHANNEL_LIVEKIT_API_SECRET: LIVEKIT_SECRET,
    RELAY_CHANNEL_VOLC_ASR_APP_ID: '1234567890',
    RELAY_CHANNEL_VOLC_ASR_ACCESS_TOKEN: VOLC_ASR_TOKEN,
    RELAY_CHANNEL_VOLC_TTS_APP_ID: '1234567890',
    RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN: VOLC_TTS_TOKEN,
    ...extra,
  };
}

async function startRelay(env = channelEnv(), now = () => new Date('2026-09-21T03:00:00Z')) {
  db = openRelayDb(':memory:');
  const app = createApp({ db, config: relayConfigOf(env), now });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
}

/**
 * 一个服务器账号的 scope(= `accounts.cjs` 的 `accountScopeOf` 拼出来那一串)。
 * 2026-09-27 起**只有这一形状的令牌进得了房**(卡 RM),所以这个文件里的默认账号是它。
 */
const ACCT = 'acct:0123456789abcdef0123456789abcdef';

function grantToken(account = ACCT, deviceId = 'mac-1') {
  return issueToken(db, { account, deviceId, dailyTokenLimit: 50_000 }).token;
}

/** 一把登记了设备类型的令牌(2026-09-23:`wb_kind` 按这一列签)。 */
function grantTokenOfKind(deviceKind, deviceId = `dev-${deviceKind}`) {
  return issueToken(db, { account: ACCT, deviceId, deviceKind, dailyTokenLimit: 50_000 }).token;
}

const auth = token => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
});

describe('GET /v1/channel-credentials', () => {
  it('没令牌就 401,和 /v1/usage 同一句话同一个形状', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-credentials`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_relay_token');
  });

  it('回的是地址与房间,**没有 LiveKit 的 api key / secret**', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-credentials`, auth(grantToken()));
    expect(res.status).toBe(200);
    const text = await res.text();
    // 这两条是这张卡的全部意义所在:secret 留在服务器上。
    expect(text).not.toContain(LIVEKIT_SECRET);
    expect(text).not.toContain(LIVEKIT_KEY);
    const body = JSON.parse(text);
    expect(body.livekit.url).toBe('wss://lk.example.test');
    expect(body.livekit.token_endpoint).toBe('/v1/channel-token');
    expect(body.livekit.configured).toBe(true);
    expect(body.livekit.api_key).toBeUndefined();
    expect(body.livekit.api_secret).toBeUndefined();
  });

  it('房间由账号算出来,**不由客户端说了算**:同账号不同设备同一间,不同账号不同间', async () => {
    await startRelay();
    const mac = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken(ACCT, 'mac-1')))).json();
    const phone = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken(ACCT, 'mac-2')))).json();
    const other = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken('acct:ffffffffffffffffffffffffffffffff', 'mac-1')))).json();
    expect(mac.livekit.room).toBe(phone.livekit.room);
    expect(mac.livekit.room).not.toBe(other.livekit.room);
    // 房间名里不许出现账号本身 —— 房间名会进日志、进 LiveKit 那台机器。
    expect(mac.livekit.room).not.toContain('0123456789abcdef');
  });

  it('火山 ASR/TTS 的凭据下发,但带到期时间(客户端只许存内存)', async () => {
    await startRelay();
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_asr.app_id).toBe('1234567890');
    expect(body.volc_asr.access_token).toBe(VOLC_ASR_TOKEN);
    expect(body.volc_asr.resource_id).toBe('volc.bigasr.sauc.duration');
    expect(body.volc_tts.access_token).toBe(VOLC_TTS_TOKEN);
    // 到期时间是一个 ISO 串,而且在未来。
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(new Date('2026-09-21T03:00:00Z').getTime());
    expect(body.store).toBe('memory-only');
  });

  it('没配火山那两样就整块缺席,**不编空字符串**', async () => {
    const env = channelEnv();
    delete env.RELAY_CHANNEL_VOLC_ASR_APP_ID;
    delete env.RELAY_CHANNEL_VOLC_ASR_ACCESS_TOKEN;
    delete env.RELAY_CHANNEL_VOLC_TTS_APP_ID;
    delete env.RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN;
    await startRelay(env);
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_asr).toBeUndefined();
    expect(body.volc_tts).toBeUndefined();
    expect(body.notes.join('')).toContain('火山');
  });

  it('★没单独配 TTS 时复用识别那组 appid/token;resource/cluster 不套识别的(2026-09-23)', async () => {
    const env = channelEnv();
    delete env.RELAY_CHANNEL_VOLC_TTS_APP_ID;
    delete env.RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN;
    await startRelay(env);
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_tts.app_id).toBe('1234567890');
    expect(body.volc_tts.access_token).toBe(VOLC_ASR_TOKEN);
    // 识别的 resource(volc.bigasr.*)拿去合成会被火山拒:整块缺席,由合成那端用自己的缺省。
    expect(body.volc_tts.resource_id).toBeUndefined();
    expect(body.volc_tts.cluster).toBeUndefined();
    // 内部标记不出门。
    expect(body.volc_tts.reusesAsr).toBeUndefined();
    expect(body.notes.join('')).toContain('复用识别(ASR)那组凭据');
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.channel_configured).toEqual({ livekit: true, volc_asr: true, volc_tts: true, volc_tts_reuses_asr: true });
    // /health 只有布尔。
    expect(JSON.stringify(health)).not.toContain(VOLC_ASR_TOKEN);
  });

  it('复用时 TTS 自己的 RESOURCE_ID / CLUSTER 照样生效', async () => {
    const env = channelEnv({ RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID: 'volc.tts.custom', RELAY_CHANNEL_VOLC_TTS_CLUSTER: 'volcano_tts' });
    delete env.RELAY_CHANNEL_VOLC_TTS_APP_ID;
    delete env.RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN;
    await startRelay(env);
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_tts.access_token).toBe(VOLC_ASR_TOKEN);
    expect(body.volc_tts.resource_id).toBe('volc.tts.custom');
    expect(body.volc_tts.cluster).toBe('volcano_tts');
  });

  it('单独配了 TTS 那组就以它为准,不说「复用」', async () => {
    await startRelay(channelEnv({ RELAY_CHANNEL_VOLC_TTS_APP_ID: '999' }));
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_tts.app_id).toBe('999');
    expect(body.volc_tts.access_token).toBe(VOLC_TTS_TOKEN);
    expect((body.notes ?? []).join('')).not.toContain('复用');
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.channel_configured.volc_tts_reuses_asr).toBe(false);
  });

  it('识别也没配时,合成照样缺席(没有可借的)', async () => {
    const env = channelEnv();
    delete env.RELAY_CHANNEL_VOLC_ASR_APP_ID;
    delete env.RELAY_CHANNEL_VOLC_TTS_APP_ID;
    await startRelay(env);
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.volc_asr).toBeUndefined();
    expect(body.volc_tts).toBeUndefined();
  });

  it('LiveKit 没配时如实说没配,而不是回一个连不上的地址', async () => {
    const env = channelEnv();
    delete env.RELAY_CHANNEL_LIVEKIT_API_SECRET;
    await startRelay(env);
    const body = await (await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).json();
    expect(body.livekit.configured).toBe(false);
    expect(body.livekit.url).toBeUndefined();
    expect(body.notes.join('')).toContain('LiveKit');
  });

  it('额度用完了照样拿得到通道凭据(通话与模型额度是两件事)', async () => {
    await startRelay();
    const token = issueToken(db, { account: ACCT, deviceId: 'mac-1', dailyTokenLimit: 1 }).token;
    db.prepare('INSERT INTO usage_daily (token_hash, day, requests, prompt_tokens, completion_tokens, total_tokens)'
      + ' VALUES ((SELECT token_hash FROM tokens WHERE prefix = ?), ?, 1, 1, 1, 999)')
      .run(token.slice(0, 8), '2026-09-21');
    const res = await fetch(`${base}/v1/channel-credentials`, auth(token));
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/channel-token', () => {
  it('签出来的是一张 LiveKit 进房凭证,房间是这个账号的那一间', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), { identity: 'wb-channel-worker' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toBe('wb-channel-worker');
    expect(body.room).toBe(channelRoomOf(ACCT, 'wb-'));
    expect(body.url).toBe('wss://lk.example.test');
    const payload = decodeJwtPayload(body.token);
    expect(payload.iss).toBe(LIVEKIT_KEY);
    expect(payload.sub).toBe('wb-channel-worker');
    expect(payload.video.room).toBe(body.room);
    expect(payload.video.roomJoin).toBe(true);
    // 进房凭证里一样不多:踢不了人、列不了别人的房、改不了自己的属性。
    expect(payload.video.roomAdmin).toBeUndefined();
    expect(payload.video.roomList).toBeUndefined();
    expect(payload.video.canUpdateOwnMetadata).toBeUndefined();
  });

  it('客户端说的房间名不算数:与这个账号对不上就 400', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), {
      identity: 'wb-phone-1', room: 'workbench',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('room_not_yours');
  });

  it('把自己那一间原样报上来是可以的(客户端手上就有它)', async () => {
    await startRelay();
    const token = grantToken();
    const res = await fetch(`${base}/v1/channel-token`, post(token, {
      identity: 'wb-phone-1', room: channelRoomOf(ACCT, 'wb-'),
    }));
    expect(res.status).toBe(200);
  });

  it('设备属性原样签进凭证(工人靠它认房里那位是哪台手机)', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), {
      identity: 'wb-phone-abc', attributes: { wb_device_id: 'abc' }, name: '小米',
    }));
    const payload = decodeJwtPayload((await res.json()).token);
    expect(payload.attributes).toEqual({ wb_device_id: 'abc' });
    expect(payload.name).toBe('小米');
  });

  /**
   * 2026-09-23:话筒经中转进房时凭证里没有 `wb_kind`,工人把这只实体话筒当成普通手机
   * (声音送错地方、手机的座机页说「座机不在线」)。这一项现在由**注册时那一列**定,
   * 不由请求体定 —— 房里自称的东西一个字都不能信。
   */
  describe('凭证里的 wb_kind 按设备种类签', () => {
    it('注册成 handset 的设备,凭证里就是 handset(请求体里一个字都不用报)', async () => {
      await startRelay();
      const res = await fetch(`${base}/v1/channel-token`, post(grantTokenOfKind('handset'), {
        identity: 'wb-phone-pi', attributes: { wb_device_id: 'pi' },
      }));
      expect(res.status).toBe(200);
      const payload = decodeJwtPayload((await res.json()).token);
      expect(payload.attributes).toEqual({ wb_device_id: 'pi', wb_kind: 'handset' });
    });

    it('注册成 phone 的设备自称 handset 也没用:以那一列为准', async () => {
      await startRelay();
      const res = await fetch(`${base}/v1/channel-token`, post(grantTokenOfKind('phone'), {
        identity: 'wb-phone-1', attributes: { wb_kind: 'handset' },
      }));
      const payload = decodeJwtPayload((await res.json()).token);
      expect(payload.attributes.wb_kind).toBe('phone');
    });

    it('老设备(kind=other / 没登记过)一个字不动:属性还是客户端报的那一份', async () => {
      await startRelay();
      const older = decodeJwtPayload((await (await fetch(`${base}/v1/channel-token`, post(
        grantTokenOfKind('other'), { identity: 'wb-phone-pi', attributes: { wb_kind: 'handset' } },
      ))).json()).token);
      expect(older.attributes).toEqual({ wb_kind: 'handset' });
      // 压根没报属性的,凭证里就没有属性 —— 不给它凭空补一条。
      const bare = decodeJwtPayload((await (await fetch(`${base}/v1/channel-token`, post(
        grantToken(), { identity: 'wb-channel-worker' },
      ))).json()).token);
      expect(bare.attributes).toBeUndefined();
    });

    it('Mac 上的 8791 替手机签时不会被盖掉(它自己那把令牌是 mac)', async () => {
      await startRelay();
      const res = await fetch(`${base}/v1/channel-token`, post(grantTokenOfKind('mac'), {
        identity: 'wb-phone-abc', attributes: { wb_device_id: 'abc', wb_kind: 'handset' },
      }));
      const payload = decodeJwtPayload((await res.json()).token);
      expect(payload.attributes).toEqual({ wb_device_id: 'abc', wb_kind: 'handset' });
    });
  });

  it('身份不能是空的、也不能带奇怪字节', async () => {
    await startRelay();
    for (const identity of ['', '  ', 'wb phone', 'wb/../admin', 'x'.repeat(200)]) {
      const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), { identity }));
      expect(res.status, identity).toBe(400);
    }
  });

  it('kind=admin 只给这一间的只读管理权,而且只活 60 秒', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), {
      identity: 'wb-status', kind: 'admin', ttl_seconds: 999_999,
    }));
    const body = await res.json();
    const payload = decodeJwtPayload(body.token);
    expect(payload.video.roomAdmin).toBe(true);
    // roomList 会把**别的账号**的房间也列出来,一律不给。
    expect(payload.video.roomList).toBeUndefined();
    expect(payload.video.roomJoin).toBeUndefined();
    expect(payload.exp - payload.nbf).toBe(CHANNEL_ADMIN_TTL_SECONDS);
  });

  it('有效期能自己要短的,但夹在上下界里', async () => {
    await startRelay();
    const short = decodeJwtPayload((await (await fetch(`${base}/v1/channel-token`, post(grantToken(), {
      identity: 'wb-phone-1', ttl_seconds: 1,
    }))).json()).token);
    expect(short.exp - short.nbf).toBe(60);
    const long = decodeJwtPayload((await (await fetch(`${base}/v1/channel-token`, post(grantToken(), {
      identity: 'wb-phone-1', ttl_seconds: 99_999_999,
    }))).json()).token);
    expect(long.exp - long.nbf).toBe(30 * 24 * 60 * 60);
  });

  it('没令牌 401;LiveKit 没配 503', async () => {
    await startRelay();
    expect((await fetch(`${base}/v1/channel-token`, post(undefined, { identity: 'x' }))).status).toBe(401);
    await new Promise(done => server.close(done));
    const env = channelEnv();
    delete env.RELAY_CHANNEL_LIVEKIT_API_SECRET;
    await startRelay(env);
    const res = await fetch(`${base}/v1/channel-token`, post(grantToken(), { identity: 'wb-phone-1' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('channel_not_configured');
  });

  it('日志里只出现 prefix 与身份,不出现令牌、不出现 secret', async () => {
    db = openRelayDb(':memory:');
    const lines = [];
    const app = createApp({ db, config: relayConfigOf(channelEnv()), log: line => lines.push(line) });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const token = grantToken();
    await fetch(`${base}/v1/channel-token`, post(token, { identity: 'wb-phone-1' }));
    const all = lines.join('\n');
    expect(all).toContain('channel-token');
    expect(all).not.toContain(token);
    expect(all).not.toContain(LIVEKIT_SECRET);
  });
});

/**
 * 房间只认账号(2026-09-27,卡 RM)。
 *
 * 在这一刀之前,「装完还没登录时领的那把令牌」(= **每一台新装机器都会走的那条路**)
 * 的 `account` 列是用户起的那个名字,房间由名字算;座机与手机是带账号会话领的,
 * 房间由 `acct:<id>` 算。同一个账号两间房 —— 座机提机没人接,给座机换网络也发不到它头上。
 *
 * 现在:**不是 `acct:` 形状就不签进房凭证**,而模型那条路一个字没动。
 */
describe('房间只认账号', () => {
  const legacyToken = () => issueToken(db, { account: 'ben', deviceId: 'mac-legacy', dailyTokenLimit: 50_000 }).token;

  it('legacy 令牌取不到通道凭据,回的是 not_bound_to_account 那句人话', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-credentials`, auth(legacyToken()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('not_bound_to_account');
    expect(body.error.message).toContain('登录');
    // 一个密钥都不许漏出去。
    expect(JSON.stringify(body)).not.toContain(LIVEKIT_SECRET);
    expect(JSON.stringify(body)).not.toContain(VOLC_ASR_TOKEN);
  });

  it('legacy 令牌签不出进房凭证', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/channel-token`, post(legacyToken(), { identity: 'wb-channel-worker' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('not_bound_to_account');
  });

  it('acct: 令牌照签(同一台机器登录之后就是这一类)', async () => {
    await startRelay();
    expect((await fetch(`${base}/v1/channel-credentials`, auth(grantToken()))).status).toBe(200);
    expect((await fetch(`${base}/v1/channel-token`, post(grantToken(), { identity: 'wb-phone-1' }))).status).toBe(200);
  });

  /**
   * **legacy 令牌照样能调模型**:登录前的引导要用它。挡住的只有通道那两条路。
   * 这里认的门是 `/v1/usage` —— 它与模型那几条走的是同一道 `gate`(认设备令牌),
   * 而且不用假一个上游出来。
   */
  it('legacy 令牌照样过模型那道门(/v1/usage 认它)', async () => {
    await startRelay();
    const res = await fetch(`${base}/v1/usage`, auth(legacyToken()));
    expect(res.status).toBe(200);
  });

  /**
   * **手机拿自己那把账号令牌,自己领得到账号那间房的凭证**(2026-09-28,卡 PH)。
   *
   * 这是手机「电脑搬走了自己跟过去」那条路的服务器一侧:电脑搬进账号房间之后,手机问
   * `/channel/status` 走的是旧房间里的代理(没人应),只能自己直接来问中转。
   * 这一条钉住中转**不拦手机类令牌、不拦 `wb-phone-` 这种身份**,而且签出来的房间
   * 与电脑那把令牌算出来的**是同一间** —— 手机搬过去就能找到电脑。
   * 中转为此一个字节都没改;这条用例是把"不用改"钉住,免得以后有人加身份限制时不知道谁在依赖它。
   */
  it('手机自己的账号令牌领得到账号那间房(卡 PH:手机跟着电脑搬家)', async () => {
    await startRelay();
    const phone = grantTokenOfKind('phone', 'mi-1');
    const where = await fetch(`${base}/v1/channel-credentials`, auth(phone));
    expect(where.status).toBe(200);
    const room = (await where.json()).livekit.room;

    const signed = await fetch(`${base}/v1/channel-token`, post(phone, { identity: 'wb-phone-mi-1', room }));
    expect(signed.status).toBe(200);
    const credential = await signed.json();
    // 电脑那把令牌算出来的也是这一间 —— 两台在同一间房,手机搬过去才找得到电脑。
    expect(credential.room).toBe(room);
    expect(credential.room).toBe(channelRoomOf(ACCT));
    expect(credential.identity).toBe('wb-phone-mi-1');
  });
});
