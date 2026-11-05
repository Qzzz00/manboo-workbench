// 企业微信机器人回调(2026-10-21):验签、加解密、群消息 → 便签 / 派活请求、回执回群、群与频道绑定。
// 没有真企微:密文由本文件按同一套算法造(wecom.cjs 的 encrypt),回执打到假的 fetch 上。
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { commandOf, decrypt, encrypt, encryptOf, firstSentence, isWecomResponseUrl, signatureOf, verifySignature } from '../server/wecom.cjs';

const TOKEN = 'wecom-token-fake';
const AES_KEY = crypto.randomBytes(32).toString('base64').slice(0, 43);
const CONF = { token: TOKEN, aesKey: AES_KEY, receiveId: '' };
const RESPONSE_URL = 'https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=fake';

let server;
let db;
let base;
let replies;

async function startRelay(env = { RELAY_WECOM_TOKEN: TOKEN, RELAY_WECOM_ENCODING_AES_KEY: AES_KEY }) {
  db = openRelayDb(':memory:');
  replies = [];
  const fetchImpl = async (url, init) => { replies.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); };
  const app = createApp({ db, config: relayConfigOf(env), fetchImpl });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
});

const post = (path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body ?? {}),
});
const get = (path, token) => fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

/** 按企微的样子把一条消息加密、签名后打到回调上。 */
async function callback(message, { tamper = false } = {}) {
  const enc = encrypt(CONF, JSON.stringify(message));
  const timestamp = '1761012345';
  const nonce = 'n0nce';
  const sig = signatureOf(TOKEN, timestamp, nonce, enc);
  const qs = `msg_signature=${tamper ? sig.replace(/^./, c => (c === 'a' ? 'b' : 'a')) : sig}&timestamp=${timestamp}&nonce=${nonce}`;
  const res = await post(`/v1/wecom/callback?${qs}`, { encrypt: enc });
  await settle();
  return res;
}

function groupMsg(msgid, content, chatid = 'wrkSFfCgAAxxxx') {
  return { msgid, aibotid: 'bot-1', chatid, chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content }, response_url: RESPONSE_URL };
}

async function owner() {
  const reg = await (await post('/v1/account/register', { email_or_phone: 'a@x.cn', password: 'hunter22' })).json();
  const mac = await (await post('/register-device', { device_id: 'a-mac', kind: 'mac' }, reg.session_token)).json();
  const ws = await (await post('/v1/workspace', { name: '小作坊', nick: '阿本' }, reg.session_token)).json();
  return { id: reg.account.id, session: reg.session_token, mac: mac.token, channel: ws.channel };
}

describe('加解密与验签', () => {
  it('加密再解密得回原文;签名对得上;改一个字就对不上', () => {
    const enc = encrypt(CONF, '{"hello":"世界"}');
    expect(decrypt(CONF, enc)).toBe('{"hello":"世界"}');
    const sig = signatureOf(TOKEN, '1', '2', enc);
    expect(verifySignature(CONF, { signature: sig, timestamp: '1', nonce: '2', encrypt: enc })).toBe(true);
    expect(verifySignature(CONF, { signature: sig, timestamp: '1', nonce: '3', encrypt: enc })).toBe(false);
    expect(verifySignature({ ...CONF, token: 'other' }, { signature: sig, timestamp: '1', nonce: '2', encrypt: enc })).toBe(false);
  });

  it('签名按字典序拼接后 sha1(与企微文档同一个算法)', () => {
    const expected = crypto.createHash('sha1').update(['b', 'a', 'c', 'd'].sort().join('')).digest('hex');
    expect(signatureOf('b', 'a', 'c', 'd')).toBe(expected);
  });

  it('配了 ReceiveId 就核它', () => {
    const enc = encrypt({ ...CONF, receiveId: 'ww-corp' }, 'x');
    expect(decrypt({ ...CONF, receiveId: 'ww-corp' }, enc)).toBe('x');
    expect(() => decrypt({ ...CONF, receiveId: 'ww-other' }, enc)).toThrow();
  });

  it('外壳 JSON 与 XML 都认', () => {
    expect(encryptOf({ encrypt: 'abc' })).toBe('abc');
    expect(encryptOf('<xml><Encrypt><![CDATA[abc==]]></Encrypt></xml>')).toBe('abc==');
    expect(encryptOf('{"encrypt":"q"}')).toBe('q');
    expect(encryptOf('nothing')).toBeUndefined();
  });

  it('只往企微自己的域名回执', () => {
    expect(isWecomResponseUrl(RESPONSE_URL)).toBe(true);
    expect(isWecomResponseUrl('https://evil.example.com/x')).toBe(false);
    expect(isWecomResponseUrl('http://qyapi.weixin.qq.com/x')).toBe(false);
  });
});

describe('一句话 → 做什么(机械规则)', () => {
  it('绑定 / 派给 / 便签', () => {
    expect(commandOf('@事务官 绑定 abcd2345')).toEqual({ kind: 'bind', code: 'ABCD2345' });
    expect(commandOf('@事务官 派给 代码Agent:把按钮改圆')).toEqual({ kind: 'dispatch', agent: '代码Agent', text: '把按钮改圆' });
    expect(commandOf('@事务官 派给 代码Agent: 把按钮改圆')).toEqual({ kind: 'dispatch', agent: '代码Agent', text: '把按钮改圆' });
    expect(commandOf('@事务官 周五前把封面改了。顺便看看标题')).toEqual({ kind: 'note', text: '周五前把封面改了。顺便看看标题' });
    expect(commandOf('@事务官')).toEqual({ kind: 'empty' });
    expect(firstSentence('周五前把封面改了。顺便看看标题')).toBe('周五前把封面改了');
  });
});

describe('回调 HTTP 面', () => {
  it('没配密钥 → 503;/health 只回布尔', async () => {
    await startRelay({});
    expect((await get('/v1/wecom/callback?msg_signature=x&timestamp=1&nonce=2&echostr=abc')).status).toBe(503);
    const health = await (await get('/health')).json();
    expect(health.collab).toEqual({ inbox: true, wecom_configured: false });
  });

  it('保存回调地址时的验证:验签过了回 echostr 明文;签名错 401', async () => {
    await startRelay();
    const echostr = encrypt(CONF, 'echo-1234');
    const sig = signatureOf(TOKEN, '9', 'n', echostr);
    const ok = await get(`/v1/wecom/callback?msg_signature=${sig}&timestamp=9&nonce=n&echostr=${encodeURIComponent(echostr)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('echo-1234');
    const bad = await get(`/v1/wecom/callback?msg_signature=${'0'.repeat(40)}&timestamp=9&nonce=n&echostr=${encodeURIComponent(echostr)}`);
    expect(bad.status).toBe(401);
    const health = await (await get('/health')).json();
    expect(JSON.stringify(health).includes(TOKEN)).toBe(false);
    expect(JSON.stringify(health).includes(AES_KEY)).toBe(false);
  });

  it('签名被改过的消息 401,什么都不做', async () => {
    await startRelay();
    const res = await callback(groupMsg('m0', '@事务官 你好'), { tamper: true });
    expect(res.status).toBe(401);
    expect(replies).toEqual([]);
  });

  it('没绑定的群:回一句怎么绑;绑定码绑上之后,一句话 = 频道一条 + 绑定人电脑一条 task.create;办完回执回群', async () => {
    await startRelay();
    const a = await owner();
    await callback(groupMsg('m1', '@事务官 周五前把封面改了'));
    expect(replies.at(-1).body.markdown.content).toContain('还没绑定');

    const bind = await (await post('/v1/wecom/bindings', { channel_id: a.channel.id }, a.mac)).json();
    expect(bind.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    await callback(groupMsg('m2', `@事务官 绑定 ${bind.code}`));
    expect(replies.at(-1).body.markdown.content).toContain('已绑定到频道「小作坊」');
    const listed = await (await get('/v1/wecom/bindings', a.mac)).json();
    expect(listed.bindings.map(b => b.chatid)).toEqual(['wrkSFfCgAAxxxx']);

    const before = replies.length;
    expect((await callback(groupMsg('m3', '@事务官 周五前把封面改了。顺便看看标题'))).status).toBe(200);
    // 企微重试同一个 msgid:不出第二条
    await callback(groupMsg('m3', '@事务官 周五前把封面改了。顺便看看标题'));
    expect(replies.length).toBe(before); // 回执等办完再回

    const snap = await (await get(`/v1/channels/${encodeURIComponent(a.channel.id)}/messages`, a.mac)).json();
    const said = snap.messages.filter(m => m.via === 'wecom');
    expect(said).toHaveLength(1);
    expect(said[0].author).toMatchObject({ person: a.id, nick: '企微·zhangsan', device: 'wecom' });

    const reqs = (await (await get('/v1/inbox/requests?since=0', a.mac)).json()).requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      request_id: 'wecom:m3', op: 'task.create', from_device: 'wecom',
      args: { title: '周五前把封面改了', origin: 'channel', channel: a.channel.id, source: { via: 'wecom', ref: said[0].id, from_user: 'zhangsan' } },
    });
    expect(JSON.stringify(reqs[0]).includes('response_url')).toBe(false);

    await post('/v1/inbox/requests/result', { request_id: 'wecom:m3', state: 'done', result: { title: '周五前把封面改了' } }, a.mac);
    await settle();
    expect(replies.at(-1)).toEqual({ url: RESPONSE_URL, body: { msgtype: 'markdown', markdown: { content: '已记成便签:周五前把封面改了' } } });
  });

  it('「派给 名片名:…」→ agent.dispatch 到名片主人;名片不共享就回群一句', async () => {
    await startRelay();
    const a = await owner();
    // 第二个成员 B 登记一张名片,群由 A 绑定
    const inv = await (await post('/v1/workspace/invite', {}, a.session)).json();
    const regB = await (await post('/v1/account/register', { email_or_phone: 'b@x.cn', password: 'hunter22' })).json();
    const macB = (await (await post('/register-device', { device_id: 'b-mac', kind: 'mac' }, regB.session_token)).json()).token;
    await post('/v1/workspace/join', { code: inv.code, nick: '运营' }, regB.session_token);
    await post('/v1/objects', { object_id: 'agent:bbbbbbbb:01', kind: 'agent', title: '数据Agent', data: { shared: { to: 'none' } } }, macB);
    const bind = await (await post('/v1/wecom/bindings', { channel_id: a.channel.id }, a.mac)).json();
    await callback(groupMsg('k1', `@事务官 绑定 ${bind.code}`));

    await callback(groupMsg('k2', '@事务官 派给 数据Agent:拉一下上周的店铺数据'));
    expect(replies.at(-1).body.markdown.content).toContain('没有把它共享');
    await post('/v1/objects', { object_id: 'agent:bbbbbbbb:01', kind: 'agent', title: '数据Agent', data: { shared: { to: 'workspace' } } }, macB);
    await callback(groupMsg('k3', '@事务官 派给 数据Agent:拉一下上周的店铺数据'));
    const reqs = (await (await get('/v1/inbox/requests?since=0', macB)).json()).requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ op: 'agent.dispatch', object_id: 'agent:bbbbbbbb:01', from_account: a.id, args: { desc: '拉一下上周的店铺数据' } });
    await callback(groupMsg('k4', '@事务官 派给 不存在:x'));
    expect(replies.at(-1).body.markdown.content).toContain('没有叫「不存在」');
  });
});
