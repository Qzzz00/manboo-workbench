// 局域网主路 M2(2026-10-21):8791 的票、状态、续期、配对回包多了几格(`route`、局域网地址、`mode: lan`、`mac_id`)。
//
// M2 时手机只需「不被新字段弄坏」;M4(手机接连接规格)起手机**用上**这几格:续期回来的地址、配对回包的机器 id、
// `/channel/route` 的回包。这一份读 8791 那边的字段表
// (`workbench-plugin/src/server/channelWire.cases.json`,接缝主人是统筹;工人与听筒读同一份),
// 把样例喂给手机自己的解析:还认得出票、续期、状态、配对,值没被新格子带歪。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { channelCallReadiness, channelRoomMoved } from '../src/api/call';
import { parseWbchCredential } from '../src/channel/credentialStore';
import { parseWbchInbound } from '../src/channel/channelProtocol';
import { claimPairing } from '../src/pairing/claim';
import { parseRouteAnswer } from '../src/channel/routePorts';

const wire = JSON.parse(readFileSync(join(process.cwd(), '..', 'workbench-plugin', 'src', 'server', 'channelWire.cases.json'), 'utf8')) as {
  examples: Record<string, Record<string, unknown>>;
};
const ex = wire.examples;

describe('手机读得懂 8791 新那几格(字段表)', () => {
  it('局域网那张票 / 中转那张票:照旧解析成一份凭证,地址原样', () => {
    expect(parseWbchCredential(ex.token_lan)).toEqual({
      url: ex.token_lan?.url, room: ex.token_lan?.room, identity: ex.token_lan?.identity, token: ex.token_lan?.token, expires_at: ex.token_lan?.expires_at,
    });
    expect(parseWbchCredential(ex.token_relay)?.url).toBe(ex.token_relay?.url);
  });

  it('续期回话多了地址三格:手机接住(M4:续期回来的地址覆盖同一路线那份);老那种两格的也认', () => {
    expect(parseWbchInbound(JSON.stringify(ex.renew_lan))).toEqual({
      id: 'r1', type: 'token', token: ex.renew_lan?.token, expires_at: ex.renew_lan?.expires_at,
      url: ex.renew_lan?.url, room: ex.renew_lan?.room, route: ex.renew_lan?.route,
    });
    expect(parseWbchInbound(JSON.stringify(ex.renew_old))).toEqual({ id: 'r1', type: 'token', token: ex.renew_old?.token, expires_at: ex.renew_old?.expires_at });
  });

  it('状态 `mode: lan`:照旧判得出能打电话、报得出房间;与同一位拿到的票是同一间房', () => {
    expect(channelCallReadiness(ex.status_lan)).toEqual({ configured: true, checked: true, room: ex.status_lan?.room });
    expect(channelRoomMoved(ex.status_lan?.room, ex.token_lan?.room as string)).toBe(false);
  });

  it('配对回包的 mac_id:记进配对(M4:在家的判据之一是「答话的就是配对过的那台」)', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(ex.pair_claim), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await claimPairing({ fetchImpl, target: { host: '192.168.31.8', port: 8791 }, code: '123456', deviceName: '小米' });
    expect(result).toEqual({ ok: true, pairing: { token: ex.pair_claim?.token, host: '192.168.31.8', port: 8791, deviceId: ex.pair_claim?.device_id, macId: ex.pair_claim?.mac_id } });
  });

  it('`GET /channel/route` 的回包 → 规格要的那一条答复(机器 id、本机房间、地址表、接没接中转)', () => {
    expect(parseRouteAnswer('http://192.168.31.8:8791', 200, ex.route_lan)).toEqual({
      url: 'http://192.168.31.8:8791',
      status: 'ok',
      mac_id: ex.route_lan?.mac_id,
      lan_url: ex.route_lan?.lan_url,
      room: ex.route_lan?.room,
      lan_addresses: ex.route_lan?.lan_addresses,
      relay_configured: true,
    });
    // 401 也带机器 id:分得清「我那台撤了我」与「别人的 Mac 不认我的令牌」
    expect(parseRouteAnswer('http://10.0.0.9:8791', 401, { error: 'x', mac_id: 'ffff' })).toEqual({ url: 'http://10.0.0.9:8791', status: 'unauthorized', mac_id: 'ffff' });
    // `relay` 整格缺席 = 这台 Mac 没接中转(M7);`configured: false` = 接了,云房间这会儿还没好
    expect(parseRouteAnswer('http://a:8791', 200, { mac_id: 'm' }).relay_configured).toBe(false);
    expect(parseRouteAnswer('http://a:8791', 200, { mac_id: 'm', relay: { configured: false } }).relay_configured).toBe(true);
    expect(parseRouteAnswer('http://a:8791', 500, {}).status).toBe('error');
  });
});
