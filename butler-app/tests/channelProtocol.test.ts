import { describe, expect, it } from 'vitest';
import {
  WBCH_FILE_TOPIC,
  WBCH_MODE_TEXT,
  WBCH_RENEW_LEAD_SECONDS,
  WBCH_RPC_TOPIC,
  WBCH_WORKER_IDENTITY,
  encodeWbchOutbound,
  parseWbchInbound,
  wbchExpired,
  wbchExpiryText,
  wbchNeedsRenew,
  wbchRenewDelayMs,
} from '../src/channel/channelProtocol';

function lineOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

describe('通道协议:约定的那几个字符串', () => {
  it('topic 与工人身份与 Mac 侧那张卡逐字一致', () => {
    expect(WBCH_RPC_TOPIC).toBe('wb.rpc');
    expect(WBCH_FILE_TOPIC).toBe('wb.file');
    expect(WBCH_WORKER_IDENTITY).toBe('wb-channel-worker');
  });

  it('三种连接状态各有一句给人看的字', () => {
    expect(WBCH_MODE_TEXT.direct).toBe('直连');
    expect(WBCH_MODE_TEXT.remote).toBe('远程');
    expect(WBCH_MODE_TEXT.offline).toBe('未连接');
  });
});

describe('encodeWbchOutbound', () => {
  it('http 请求照协议的字段发,body 为空时发 null(不是缺席)', () => {
    const line = encodeWbchOutbound({ id: 'a1', type: 'http', method: 'GET', path: '/state', body: null });
    expect(JSON.parse(line)).toEqual({ id: 'a1', type: 'http', method: 'GET', path: '/state', body: null });
  });

  it('续期请求只有 id 与 type', () => {
    expect(JSON.parse(encodeWbchOutbound({ id: 'b2', type: 'renew' }))).toEqual({ id: 'b2', type: 'renew' });
  });
});

describe('parseWbchInbound', () => {
  it('认得 http 响应', () => {
    const msg = parseWbchInbound(lineOf({ id: 'a1', type: 'http', status: 200, body: { ok: true } }));
    expect(msg).toEqual({ id: 'a1', type: 'http', status: 200, body: { ok: true } });
  });

  it('认得「这条没办成」', () => {
    expect(parseWbchInbound(lineOf({ id: 'a1', type: 'error', error: '工作台连不上' })))
      .toEqual({ id: 'a1', type: 'error', error: '工作台连不上' });
  });

  it('认得续到的新凭证', () => {
    const msg = parseWbchInbound(lineOf({ id: 'b2', type: 'token', token: 'jwt', expires_at: 1789 }));
    expect(msg).toEqual({ id: 'b2', type: 'token', token: 'jwt', expires_at: 1789 });
  });

  it('认得字幕,final 缺席当没定稿', () => {
    expect(parseWbchInbound(lineOf({ type: 'caption', role: 'butler', text: '好' })))
      .toEqual({ type: 'caption', role: 'butler', text: '好', final: false });
    expect(parseWbchInbound(lineOf({ type: 'caption', role: 'me', text: '记一下', final: true })))
      .toEqual({ type: 'caption', role: 'me', text: '记一下', final: true });
  });

  // 这是网络上来的字节:解析失败只能返回 null,绝不抛——抛出去会把整条数据通道带走。
  it.each([
    ['不是 JSON', lineOf('{ 半句')],
    ['空字符串', ''],
    ['不是对象', lineOf(['a'])],
    ['没有 type', lineOf({ id: 'a1', status: 200 })],
    ['不认识的 type', lineOf({ id: 'a1', type: 'ping' })],
    ['http 没有 id', lineOf({ type: 'http', status: 200, body: {} })],
    ['http 的 status 不是数', lineOf({ id: 'a1', type: 'http', status: '200', body: {} })],
    ['token 没有 token', lineOf({ id: 'b2', type: 'token', expires_at: 1789 })],
    ['token 的 expires_at 不是数', lineOf({ id: 'b2', type: 'token', token: 'jwt', expires_at: '1789' })],
    ['error 没有 error', lineOf({ id: 'a1', type: 'error' })],
    ['字幕的 role 不认识', lineOf({ type: 'caption', role: '第三个人', text: '喂' })],
    ['字幕是空字符串', lineOf({ type: 'caption', role: 'me', text: '   ' })],
  ])('%s → null', (_name, line) => {
    expect(parseWbchInbound(line)).toBeNull();
  });
});

describe('凭证续期的时点', () => {
  const expiresAt = 1_000_000; // 秒

  it('提前十分钟续', () => {
    expect(WBCH_RENEW_LEAD_SECONDS).toBe(600);
    // 还差 30 分钟到期 → 再等 20 分钟才续
    expect(wbchRenewDelayMs(expiresAt, (expiresAt - 30 * 60) * 1000)).toBe(20 * 60 * 1000);
  });

  it('已经进了最后十分钟 → 现在就续(不给负数)', () => {
    expect(wbchRenewDelayMs(expiresAt, (expiresAt - 60) * 1000)).toBe(0);
    expect(wbchRenewDelayMs(expiresAt, (expiresAt + 9999) * 1000)).toBe(0);
    expect(wbchNeedsRenew(expiresAt, (expiresAt - 60) * 1000)).toBe(true);
    expect(wbchNeedsRenew(expiresAt, (expiresAt - 30 * 60) * 1000)).toBe(false);
  });

  it('过期就是过期', () => {
    expect(wbchExpired(expiresAt, (expiresAt - 1) * 1000)).toBe(false);
    expect(wbchExpired(expiresAt, (expiresAt + 1) * 1000)).toBe(true);
  });

  it('到期时间说人话', () => {
    expect(wbchExpiryText(expiresAt, (expiresAt - 90) * 1000)).toBe('2 分钟后到期');
    expect(wbchExpiryText(expiresAt, (expiresAt - 2 * 3600) * 1000)).toBe('2 小时后到期');
    expect(wbchExpiryText(expiresAt, (expiresAt + 5) * 1000)).toBe('已过期');
  });
});

describe('引导那条消息的编解码(2026-09-18)', () => {
  it('发出去的是一行 JSON;工人的答复认 ok / stage / error', () => {
    expect(JSON.parse(encodeWbchOutbound({ id: 'x', type: 'onboarding', action: 'resume' }))).toEqual({ id: 'x', type: 'onboarding', action: 'resume' });
    expect(parseWbchInbound(JSON.stringify({ id: 'x', type: 'onboarding', ok: true, stage: 'branch' })))
      .toEqual({ id: 'x', type: 'onboarding', ok: true, stage: 'branch' });
    expect(parseWbchInbound(JSON.stringify({ id: 'x', type: 'onboarding', ok: false, error: '接不了' })))
      .toEqual({ id: 'x', type: 'onboarding', ok: false, error: '接不了' });
  });

  it('缺 id 或 ok 不是布尔:当没收到(宁可超时也不半懂不懂地处理)', () => {
    expect(parseWbchInbound(JSON.stringify({ type: 'onboarding', ok: true }))).toBeNull();
    expect(parseWbchInbound(JSON.stringify({ id: 'x', type: 'onboarding', ok: '好了' }))).toBeNull();
  });
});

/**
 * 招呼与主导方(2026-09-18)。协议上多了一条 `{type:'call',action:'start'}`
 * 与引导答复里的 `leader` —— 两端必须同时改,所以这里逐字钉住。
 */
describe('招呼那条', () => {
  it('发出去就是一行 JSON', () => {
    expect(JSON.parse(encodeWbchOutbound({ id: '1', type: 'call', action: 'start' }))).toEqual({
      id: '1', type: 'call', action: 'start',
    });
  });

  it('工人的答复认得出来;缺 ok 就当没收到', () => {
    expect(parseWbchInbound('{"id":"1","type":"call","ok":true}')).toEqual({ id: '1', type: 'call', ok: true });
    expect(parseWbchInbound('{"id":"1","type":"call","ok":false,"error":"没有接话模型"}'))
      .toEqual({ id: '1', type: 'call', ok: false, error: '没有接话模型' });
    expect(parseWbchInbound('{"id":"1","type":"call"}')).toBeNull();
  });

  it('引导答复里的 leader 原样带回来(没有这一格 = 归手机)', () => {
    expect(parseWbchInbound('{"id":"1","type":"onboarding","ok":true,"stage":"branch","leader":"desktop"}'))
      .toEqual({ id: '1', type: 'onboarding', ok: true, stage: 'branch', leader: 'desktop' });
    expect(parseWbchInbound('{"id":"1","type":"onboarding","ok":true}'))
      .toEqual({ id: '1', type: 'onboarding', ok: true });
  });
});

/**
 * 缓冲语信号(2026-09-20,Ben:「缓冲语可以存到手机里啊」)。
 * 这条是**广播**、没有 id、没有回包 —— 和字幕同一类。轮号是它的骨头:手机靠它分批次。
 */
describe('缓冲语那条信号', () => {
  it('认得出来,工具名原样带回来', () => {
    expect(parseWbchInbound('{"type":"filler","kind":"tool","tool":"scan_projects","round":3,"at":1700}'))
      .toEqual({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 3, at: 1700 });
    expect(parseWbchInbound('{"type":"filler","kind":"thinking","round":1,"at":9}'))
      .toEqual({ type: 'filler', kind: 'thinking', round: 1, at: 9 });
  });

  it('**没有轮号就当没收到**(手机靠它分「同一轮的第二条」和「新的一轮」)', () => {
    expect(parseWbchInbound('{"type":"filler","kind":"thinking","at":9}')).toBeNull();
    expect(parseWbchInbound('{"type":"filler","kind":"thinking","round":"一","at":9}')).toBeNull();
  });

  it('认不出的 kind 当没收到(不半懂不懂地当成 thinking)', () => {
    expect(parseWbchInbound('{"type":"filler","kind":"humming","round":1,"at":9}')).toBeNull();
  });

  it('★ 慢工具跑完(tool_done,2026-09-24 傍晚)认得出来,工具名原样带回来', () => {
    expect(parseWbchInbound('{"type":"filler","kind":"tool_done","tool":"read_project","round":2,"at":5}'))
      .toEqual({ type: 'filler', kind: 'tool_done', tool: 'read_project', round: 2, at: 5 });
  });

  it('没有 at 也收(它只用来量延迟,缺了不该把这条丢掉)', () => {
    expect(parseWbchInbound('{"type":"filler","kind":"thinking","round":2}'))
      .toEqual({ type: 'filler', kind: 'thinking', round: 2, at: 0 });
  });

  it('**信号里没有话** —— 说哪一句由手机挑,字幕上写的必须正好是喇叭里放的', () => {
    const parsed = parseWbchInbound('{"type":"filler","kind":"thinking","round":1,"at":9,"text":"我想想。"}');
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {})).not.toContain('text');
  });
});

/**
 * 音色换了那一条(2026-09-22)。手机据此把按音色缓存的那七句标成旧的,下次进房重取。
 */
describe('filler_voice_changed', () => {
  it('认得出来,音色名两头的空白削掉', () => {
    expect(parseWbchInbound('{"type":"filler_voice_changed","voice":" V2 ","at":9}'))
      .toEqual({ type: 'filler_voice_changed', voice: 'V2', at: 9 });
  });

  it('★没有音色名就当没收到 —— 空名字会把七句缓存写到一个不是任何音色的键上', () => {
    expect(parseWbchInbound('{"type":"filler_voice_changed","at":9}')).toBeNull();
    expect(parseWbchInbound('{"type":"filler_voice_changed","voice":"","at":9}')).toBeNull();
    expect(parseWbchInbound('{"type":"filler_voice_changed","voice":"   ","at":9}')).toBeNull();
  });

  it('没有 at 也收(它只用来写日志)', () => {
    expect(parseWbchInbound('{"type":"filler_voice_changed","voice":"V2"}'))
      .toEqual({ type: 'filler_voice_changed', voice: 'V2', at: 0 });
  });
});

/**
 * ——— 通话状态那条统一信号(2026-09-23,「打进打出同一张页」) ———
 *
 * Ben 12:45 真机 0.2.68:「我拿起话筒确实是打出去了,但是手机上没有变化,这不对,
 * 打过来和打过去都应该是显示同一个页面。」工人从这一版起在三个时刻广播 `call_state`。
 */
describe('call_state', () => {
  it('★ 读得懂 in_call:谁在通话、从什么时候起', () => {
    const message = parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1_700_000_000_000 }));
    expect(message).toEqual({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1_700_000_000_000 });
  });

  it('★ 来电接起的那一通带 call_id;拨出那一通没有,那一格就整个缺席', () => {
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: 'handset', call_id: 'c1', started_at: 1 })))
      .toMatchObject({ call_id: 'c1' });
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: 'handset', started_at: 1 })))
      .not.toHaveProperty('call_id');
  });

  it('★ idle 那一条也读得懂(挂断 / 超时 / 掉线都走它)', () => {
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'idle', by: 'worker', started_at: 1 })))
      .toMatchObject({ type: 'call_state', state: 'idle', by: 'worker' });
  });

  it('state / by 认不得的一律当没收到 —— 半懂不懂地处理会收掉一屏不该收的', () => {
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: '通话中', by: 'handset', started_at: 1 }))).toBeNull();
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: '座机', started_at: 1 }))).toBeNull();
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', started_at: 1 }))).toBeNull();
  });

  it('没带 started_at 就当 0(界面上那行「从 HH:MM 起」自己会不显示)', () => {
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: 'handset' })))
      .toMatchObject({ started_at: 0 });
  });

  /**
   * ★ 2026-09-23 真机上暴露出来的老毛病:`WbchRingEnd.by` 从 2026-09-22 晚就写在协议里,
   * 而 `parseWbchInbound` 从来没把它读出来 —— 于是「是谁接的」在手机这一侧永远是 undefined,
   * `HANDSET_BANNER_OTHER_PHONE` 那一行一次都没显示过。
   */
  it('★ ring_end 的 `by` 要真的读出来(从 09-22 起就漏在解析外面)', () => {
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' })))
      .toMatchObject({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'handset' });
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone' })))
      .toMatchObject({ by: 'phone' });
    // 认不得的种类不编一个:那一格整个缺席,手机退回 0921 那条推断。
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: '别的' })))
      .not.toHaveProperty('by');
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'missed' })))
      .not.toHaveProperty('by');
  });

  it('★ 垫场信号上的 voiced_by:worker 读出来;别的值不认', () => {
    expect(parseWbchInbound(lineOf({ type: 'filler', kind: 'thinking', round: 1, at: 1, voiced_by: 'worker' })))
      .toMatchObject({ voiced_by: 'worker' });
    expect(parseWbchInbound(lineOf({ type: 'filler', kind: 'thinking', round: 1, at: 1, voiced_by: 'phone' })))
      .not.toHaveProperty('voiced_by');
  });

  it('★ 接起那一台的 identity(by_identity,2026-09-23 晚)在 ring_end 与 call_state 上都读出来;空的不编', () => {
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by: 'phone', by_identity: 'wb-phone-a' })))
      .toMatchObject({ by_identity: 'wb-phone-a' });
    expect(parseWbchInbound(lineOf({ type: 'call_state', state: 'in_call', by: 'phone', started_at: 1, by_identity: 'wb-phone-a' })))
      .toMatchObject({ by_identity: 'wb-phone-a' });
    expect(parseWbchInbound(lineOf({ type: 'ring_end', call_id: 'c1', outcome: 'answered', by_identity: '' })))
      .not.toHaveProperty('by_identity');
  });
});
