// 协作区跨机底座(2026-10-21):账号组、收件箱、对象目录、频道、用别人的 Agent、定时派活回调。
// 全部对着真 http 面跑;时钟可拨(邀请过期、保留窗、在线判据)。
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { pruneCollab } from '../server/collab.cjs';

let server;
let db;
let base;
let clock;

async function startRelay(env = {}) {
  db = openRelayDb(':memory:');
  clock = new Date('2026-10-21T02:00:00Z');
  const config = relayConfigOf({ RELAY_PUBLIC_URL: 'https://relay.example.test', ...env });
  const app = createApp({ db, config, now: () => clock });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
}

function advance(ms) {
  clock = new Date(clock.getTime() + ms);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const post = (path, body, token, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
  body: JSON.stringify(body ?? {}),
});
const get = (path, token) => fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
const json = async res => ({ status: res.status, body: await res.json() });

/** 注册一个账号,领一台电脑、一台手机的设备令牌。 */
async function person(identifier) {
  const slug = identifier.split('@')[0];
  const reg = await (await post('/v1/account/register', { email_or_phone: identifier, password: 'hunter22' })).json();
  const mac = await (await post('/register-device', { device_id: `${slug}-mac`, name: 'Mac', kind: 'mac' }, reg.session_token)).json();
  const phone = await (await post('/register-device', { device_id: `${slug}-phone`, name: '手机', kind: 'phone' }, reg.session_token)).json();
  return { id: reg.account.id, session: reg.session_token, mac: mac.token, phone: phone.token, macId: `${slug}-mac`, phoneId: `${slug}-phone` };
}

/** A 建工作室,B(与可选的 C)用邀请码加入。 */
async function studio(extra = []) {
  const a = await person('a@x.cn');
  const b = await person('b@x.cn');
  const created = await json(await post('/v1/workspace', { name: '小作坊', nick: '阿本' }, a.session));
  expect(created.status).toBe(201);
  const invite = (await json(await post('/v1/workspace/invite', {}, a.session))).body;
  expect((await post('/v1/workspace/join', { code: invite.code, nick: '运营' }, b.session)).status).toBe(200);
  const others = [];
  for (const [ident, nick] of extra) {
    const p = await person(ident);
    const inv = (await json(await post('/v1/workspace/invite', {}, a.session))).body;
    await post('/v1/workspace/join', { code: inv.code, nick }, p.session);
    others.push(p);
  }
  return { a, b, others, ws: created.body.workspace, channel: created.body.channel };
}

async function pullAll(token, since = 0, limit = 200) {
  const events = [];
  let cursor = since;
  for (;;) {
    const page = await json(await get(`/v1/inbox/events?since=${cursor}&limit=${limit}`, token));
    expect(page.status).toBe(200);
    events.push(...page.body.events);
    cursor = page.body.next_cursor;
    if (!page.body.more) break;
  }
  return { events, cursor };
}

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  server = undefined;
});

describe('账号组', () => {
  it('建工作室 → 发邀请码 → 加入;/me 用设备令牌或会话令牌都能看成员与频道', async () => {
    await startRelay();
    const { a, b, ws, channel } = await studio();
    expect(ws.id.startsWith('ws:')).toBe(true);
    expect(channel.kind).toBe('workspace');
    const me = await json(await get('/v1/workspace/me', b.mac));
    expect(me.status).toBe(200);
    expect(me.body.workspace.id).toBe(ws.id);
    expect(me.body.me).toEqual({ account_id: b.id, nick: '运营', role: 'member' });
    expect(me.body.members.map(m => [m.nick, m.role])).toEqual([['阿本', 'admin'], ['运营', 'member']]);
    // 每台设备最后在线
    expect(me.body.members[0].devices.map(d => d.kind).sort()).toEqual(['mac', 'phone']);
    expect(me.body.channels.map(c => c.id)).toEqual([channel.id]);
    // 不出现 identifier(频道里只显示花名)
    expect(JSON.stringify(me.body).includes('a@x.cn')).toBe(false);
    const bySession = await json(await get('/v1/workspace/me', a.session));
    expect(bySession.body.me.role).toBe('admin');
  });

  it('邀请码:24 小时过期 → 410;用过一次 → 409;不是管理员发不了 → 403', async () => {
    await startRelay();
    const { a, b } = await studio();
    expect((await json(await post('/v1/workspace/invite', {}, b.session))).body.error.code).toBe('not_admin');
    const c = await person('c@x.cn');
    const d = await person('d@x.cn');
    const invite = (await json(await post('/v1/workspace/invite', {}, a.session))).body;
    expect(invite.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    advance(24 * HOUR + 1000);
    const late = await json(await post('/v1/workspace/join', { code: invite.code, nick: '丙' }, c.session));
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('invite_expired');
    const fresh = (await json(await post('/v1/workspace/invite', {}, a.session))).body;
    expect((await post('/v1/workspace/join', { code: fresh.code.toLowerCase(), nick: '丙' }, c.session)).status).toBe(200);
    const again = await json(await post('/v1/workspace/join', { code: fresh.code, nick: '丁' }, d.session));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invite_used');
    expect((await json(await post('/v1/workspace/join', { code: 'ZZZZZZZZ', nick: '丁' }, d.session))).body.error.code).toBe('invite_unknown');
  });

  it('第一版一个账号只进一个工作室;改成员关系要会话令牌,设备令牌不行', async () => {
    await startRelay();
    const { a, b } = await studio();
    expect((await json(await post('/v1/workspace', { name: '第二个', nick: 'x' }, b.session))).body.error.code).toBe('already_in_workspace');
    expect((await post('/v1/workspace/members/role', { account_id: b.id, role: 'admin' }, a.mac)).status).toBe(401);
  });

  it('最后一个管理员降不了级、移不走;设了第二个管理员就可以', async () => {
    await startRelay();
    const { a, b } = await studio();
    expect((await json(await post('/v1/workspace/members/role', { account_id: a.id, role: 'member' }, a.session))).body.error.code).toBe('last_admin');
    expect((await json(await post('/v1/workspace/members/role', { account_id: b.id, role: 'admin' }, a.session))).body.member.role).toBe('admin');
    expect((await post('/v1/workspace/members/role', { account_id: a.id, role: 'member' }, a.session)).status).toBe(200);
  });

  it('移除成员:他的三端下一次拉事件 403;他的对象别人看不见、请求不过去;历史消息留着', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    await post(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, { request_id: 'r1', text: '我来了' }, b.phone);
    await post('/v1/objects', { object_id: 'bbbbbbbb:t-1', kind: 'card', title: 'B 的卡' }, b.mac);
    const removed = await json(await post('/v1/workspace/members/remove', { account_id: b.id }, a.session));
    expect(removed.status).toBe(200);
    const pulled = await json(await get('/v1/inbox/events?since=0', b.phone));
    expect(pulled.status).toBe(403);
    expect(pulled.body.error.code).toBe('not_in_workspace');
    const objects = (await json(await get('/v1/objects', a.mac))).body.objects;
    expect(objects.map(o => o.object_id)).not.toContain('bbbbbbbb:t-1');
    const sent = await json(await post('/v1/inbox/requests', { request_id: 'q1', to_account: b.id, op: 'task.comment', object_id: 'bbbbbbbb:t-1', args: { text: 'x' } }, a.mac));
    expect(sent.status).toBe(404);
    const snap = (await json(await get(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, a.mac))).body;
    expect(snap.messages.some(m => m.text === '我来了')).toBe(true);
  });

  it('还在用老令牌(不在服务器账号名下)的设备进不了工作室', async () => {
    await startRelay();
    const legacy = await (await post('/register-device', { account: 'ben', device_id: 'old-mac' })).json();
    const res = await json(await get('/v1/inbox/events?since=0', legacy.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_required');
  });
});

describe('收件箱:序号、游标、补齐', () => {
  it('两账号:A 发十条,B 离线后按序号分页补齐,不少不重;同 request_id 重发不占新号', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    const path = `/v1/channels/${encodeURIComponent(channel.id)}/messages`;
    // B 先读到当前队头,然后「离线」
    const { cursor: bCursor } = await pullAll(b.mac);
    for (let i = 1; i <= 10; i += 1) {
      const res = await json(await post(path, { request_id: `a-${i}`, text: `第 ${i} 条` }, a.mac));
      expect(res.status).toBe(201);
    }
    // 断网重发第 5、10 条
    const dup = await json(await post(path, { request_id: 'a-5', text: '第 5 条' }, a.phone));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    await post(path, { request_id: 'a-10', text: '第 10 条' }, a.mac);

    const { events } = await pullAll(b.mac, bCursor, 3);
    const msgs = events.filter(e => e.kind === 'channel.message');
    expect(msgs.map(e => e.payload.text)).toEqual(Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 条`));
    // 游标连续、无洞
    const cursors = events.map(e => e.cursor);
    expect(cursors).toEqual(cursors.map((_, i) => bCursor + i + 1));
    // 频道 seq 连续(= 频道 version)
    const seqs = msgs.map(e => e.object_version);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    expect(new Set(msgs.map(e => e.payload.id)).size).toBe(10);
    // 发件人自己那条也有(三端同步靠它)
    const own = await pullAll(a.phone);
    expect(own.events.filter(e => e.kind === 'channel.message' && e.payload.request_id.startsWith('a-')).length).toBe(10);
  });

  it('手机与电脑各记各的游标:同一条队列读两遍,内容一样', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    await post(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, { request_id: 'x', text: '你好' }, a.mac);
    const onMac = await pullAll(b.mac);
    const onPhone = await pullAll(b.phone);
    expect(onPhone.events).toEqual(onMac.events);
  });

  it('长轮询:没有新事件就挂着,一有就放行', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    const { cursor } = await pullAll(b.mac);
    const started = Date.now();
    const waiting = get(`/v1/inbox/events?since=${cursor}&wait=5`, b.mac).then(json);
    setTimeout(() => { post(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, { request_id: 'late', text: '来了' }, a.mac); }, 150);
    const page = await waiting;
    expect(page.body.events.map(e => e.payload.text)).toEqual(['来了']);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('长轮询等满了也回 200 空页,游标不动', async () => {
    await startRelay();
    const { b } = await studio();
    const { cursor } = await pullAll(b.mac);
    const page = await json(await get(`/v1/inbox/events?since=${cursor}&wait=1`, b.mac));
    expect(page.status).toBe(200);
    expect(page.body.events).toEqual([]);
    expect(page.body.next_cursor).toBe(cursor);
  });

  it('过了 30 天保留窗:since 落在删掉的那段 → 410,重取快照后从快照的游标续', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    const path = `/v1/channels/${encodeURIComponent(channel.id)}/messages`;
    await post(path, { request_id: 'old', text: '一个月前' }, a.mac);
    advance(31 * DAY);
    await post(path, { request_id: 'new', text: '今天' }, a.mac);
    pruneCollab(db, clock);
    const gone = await json(await get('/v1/inbox/events?since=0', b.mac));
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe('cursor_expired');
    const snap = (await json(await get(path, b.mac))).body;
    expect(snap.messages.map(m => m.text)).toEqual(['今天']);
    const resumed = await json(await get(`/v1/inbox/events?since=${snap.cursor}`, b.mac));
    expect(resumed.status).toBe(200);
    expect(resumed.body.events).toEqual([]);
    await post(path, { request_id: 'after', text: '之后' }, a.mac);
    const next = await json(await get(`/v1/inbox/events?since=${snap.cursor}`, b.mac));
    expect(next.body.events.map(e => e.payload.text)).toEqual(['之后']);
  });

  it('本地游标比队头还大(中转换过库)→ 410 cursor_ahead', async () => {
    await startRelay();
    const { b } = await studio();
    const res = await json(await get('/v1/inbox/events?since=9999', b.mac));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('cursor_ahead');
  });

  it('已办完的请求 7 天后删;没办完的不过期', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    await post('/v1/inbox/requests', { request_id: 'q-done', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: {} }, b.phone);
    await post('/v1/inbox/requests', { request_id: 'q-open', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: {} }, b.phone);
    await post('/v1/inbox/requests/result', { request_id: 'q-done', state: 'done', result: {} }, a.mac);
    advance(8 * DAY);
    pruneCollab(db, clock);
    const left = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body.requests.map(r => r.request_id);
    expect(left).toEqual(['q-open']);
  });
});

describe('对象目录与请求路由', () => {
  it('请求发给不是权威写入方的账号 → 409 wrong_owner 并回现任;发对了排队,主人电脑拉到', async () => {
    await startRelay();
    const { a, b } = await studio();
    const reg = await json(await post('/v1/objects', { object_id: 'aaaaaaaa:t-63a9', kind: 'card', title: '封面改一版', version: 3 }, a.mac));
    expect(reg.status).toBe(201);
    expect(reg.body.object.owner_account).toBe(a.id);
    const wrong = await json(await post('/v1/inbox/requests', {
      request_id: 'q1', to_account: b.id, op: 'task.comment', object_id: 'aaaaaaaa:t-63a9', args: { text: '标题太长' },
    }, b.phone));
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('wrong_owner');
    expect(wrong.body.error.owner_account).toBe(a.id);
    const ok = await json(await post('/v1/inbox/requests', {
      request_id: 'q1', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-63a9', args: { text: '标题太长' },
    }, b.phone));
    expect(ok.status).toBe(201);
    expect(ok.body.request.state).toBe('queued');
    // 手机拉不了请求队列
    expect((await json(await get('/v1/inbox/requests?since=0', a.phone))).body.error.code).toBe('desk_only');
    const pulled = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body;
    expect(pulled.requests).toHaveLength(1);
    expect(pulled.requests[0]).toMatchObject({ request_id: 'q1', from_account: b.id, from_device: b.phoneId, op: 'task.comment', state: 'delivered', args: { text: '标题太长' } });
  });

  it('request_id 幂等:同号再发回存着的;办完后再发回带结果的那条', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    const body = { request_id: 'q-same', to_account: a.id, op: 'task.return', object_id: 'aaaaaaaa:t-1', args: { by: 'revise', text: '改一改' } };
    expect((await post('/v1/inbox/requests', body, b.phone)).status).toBe(201);
    const again = await json(await post('/v1/inbox/requests', body, b.mac));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const done = await json(await post('/v1/inbox/requests/result', { request_id: 'q-same', state: 'done', result: { note: '已记为反馈' } }, a.mac));
    expect(done.body.request.state).toBe('done');
    const third = await json(await post('/v1/inbox/requests', body, b.phone));
    expect(third.body.request.result).toEqual({ note: '已记为反馈' });
    const pulled = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body.requests;
    expect(pulled).toHaveLength(1);
    // 结果以事件回到发起者
    const evs = (await pullAll(b.phone)).events.filter(e => e.kind === 'request.result');
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ request_id: 'q-same', state: 'done', result: { note: '已记为反馈' } });
    // 再回一次结果:不改、不再发事件
    const twice = await json(await post('/v1/inbox/requests/result', { request_id: 'q-same', state: 'rejected', result: {} }, a.mac));
    expect(twice.body.duplicate).toBe(true);
    expect(twice.body.request.state).toBe('done');
    expect((await pullAll(b.phone)).events.filter(e => e.kind === 'request.result')).toHaveLength(1);
  });

  it('expected_owner_epoch 对不上 → 409 stale_owner_epoch;只给主人看的对象别人当不存在', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-2', kind: 'card', title: '私卡', visibility: 'owner' }, a.mac);
    const stale = await json(await post('/v1/inbox/requests', { request_id: 'e', to_account: a.id, op: 'task.create', object_id: 'aaaaaaaa:t-1', expected_owner_epoch: 2, args: {} }, b.mac));
    expect(stale.body.error.code).toBe('stale_owner_epoch');
    const hidden = await json(await post('/v1/inbox/requests', { request_id: 'h', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-2', args: {} }, b.mac));
    expect(hidden.status).toBe(404);
    expect((await json(await get('/v1/objects', b.mac))).body.objects.map(o => o.object_id)).toEqual(['aaaaaaaa:t-1']);
  });

  it('别人名下的对象登记不了;发给别人的请求必须带对象;手机发给自己的电脑可以不带', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    expect((await json(await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '抢' }, b.mac))).body.error.code).toBe('wrong_owner');
    expect((await json(await post('/v1/inbox/requests', { request_id: 'n', to_account: a.id, op: 'task.create', args: {} }, b.mac))).body.error.code).toBe('object_required');
    expect((await post('/v1/inbox/requests', { request_id: 'self', to_account: b.id, op: 'task.create', args: { title: '买咖啡' } }, b.phone)).status).toBe(201);
  });

  it('对象事件按 origin{device, seq} 去重:重发不占新号,同事只收到一条', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    const { cursor } = await pullAll(b.mac);
    const path = `/v1/objects/${encodeURIComponent('aaaaaaaa:t-1')}/events`;
    const first = await json(await post(path, { origin_seq: 41, object_version: 4, payload: { status: 'confirm' } }, a.mac));
    expect(first.status).toBe(201);
    const again = await json(await post(path, { origin_seq: 41, object_version: 4, payload: { status: 'confirm' } }, a.mac));
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const got = (await pullAll(b.mac, cursor)).events;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'object.event', object_id: 'aaaaaaaa:t-1', object_version: 4, origin: { device: a.macId, seq: 41 }, payload: { change: 'event', event: { status: 'confirm' } } });
    // 别人推不了
    expect((await json(await post(path, { origin_seq: 1, payload: {} }, b.mac))).body.error.code).toBe('wrong_owner');
  });

  it('项目收回成只给自己看:同事收到 withdrawn(不带标题),项目频道归档只读', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:p-1', kind: 'project', title: '店铺改版' }, a.mac);
    const ch = (await json(await post('/v1/channels', { project_object_id: 'aaaaaaaa:p-1' }, a.mac))).body.channel;
    expect(ch.kind).toBe('project');
    expect(ch.project).toEqual({ object_id: 'aaaaaaaa:p-1', owner_account: a.id, name: '店铺改版' });
    const { cursor } = await pullAll(b.mac);
    await post('/v1/objects', { object_id: 'aaaaaaaa:p-1', kind: 'project', title: '店铺改版', visibility: 'owner' }, a.mac);
    const evs = (await pullAll(b.mac, cursor)).events;
    const withdrawn = evs.find(e => e.kind === 'object.event');
    expect(withdrawn.payload).toEqual({ change: 'withdrawn', object: { object_id: 'aaaaaaaa:p-1', kind: 'project' } });
    expect(evs.some(e => e.kind === 'channel.created' && e.payload.archived_at !== undefined)).toBe(true);
    const say = await json(await post(`/v1/channels/${encodeURIComponent(ch.id)}/messages`, { request_id: 's', text: '还在吗' }, b.mac));
    expect(say.body.error.code).toBe('channel_archived');
  });
});

describe('用别人的 Agent', () => {
  async function agentStudio() {
    const s = await studio([['c@x.cn', '丙']]);
    const card = (shared, version) => ({
      object_id: 'agent:aaaaaaaa:01', kind: 'agent', title: 'Ben 的代码 Agent', version,
      data: { hand: 'codex', good_at: '改前端', shared },
    });
    return { ...s, card };
  }

  it('不共享 → 403;只给名单上的人 → 名单外 403、名单内排进主人请求队列', async () => {
    await startRelay();
    const { a, b, others: [c], card } = await agentStudio();
    await post('/v1/objects', card({ to: 'none' }, 1), a.mac);
    const req = id => ({ request_id: id, to_account: a.id, op: 'agent.dispatch', object_id: 'agent:aaaaaaaa:01', args: { note: 'bbbbbbbb:t-9', text: '把按钮改圆' } });
    expect((await json(await post('/v1/inbox/requests', req('d1'), b.mac))).body.error.code).toBe('agent_not_shared');
    await post('/v1/objects', card({ to: 'workspace', allowed_members: [c.id] }, 2), a.mac);
    expect((await json(await post('/v1/inbox/requests', req('d2'), b.mac))).body.error.code).toBe('agent_not_shared');
    expect((await post('/v1/inbox/requests', req('d3'), c.mac)).status).toBe(201);
    await post('/v1/objects', card({ to: 'workspace' }, 3), a.mac);
    expect((await post('/v1/inbox/requests', req('d4'), b.mac)).status).toBe(201);
    const ops = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body.requests.map(r => [r.request_id, r.op]);
    expect(ops).toEqual([['d3', 'agent.dispatch'], ['d4', 'agent.dispatch']]);
  });

  it('agent.dispatch 只能发给名片;主人离线照样排队,名片显示不在线', async () => {
    await startRelay();
    const { a, b, card } = await agentStudio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    expect((await json(await post('/v1/inbox/requests', { request_id: 'x', to_account: a.id, op: 'agent.dispatch', object_id: 'aaaaaaaa:t-1', args: {} }, b.mac))).body.error.code).toBe('not_an_agent');
    await post('/v1/objects', card({ to: 'workspace' }, 1), a.mac);
    let listed = (await json(await get('/v1/objects?kind=agent', b.mac))).body.objects;
    expect(listed).toHaveLength(1);
    expect(listed[0].owner_online).toBe(true);
    expect(listed[0].data.shared).toEqual({ to: 'workspace' });
    advance(10 * 60_000); // A 合盖
    await get('/v1/workspace/me', b.mac);
    listed = (await json(await get('/v1/objects?kind=agent', b.mac))).body.objects;
    expect(listed[0].owner_online).toBe(false);
    expect((await post('/v1/inbox/requests', { request_id: 'off', to_account: a.id, op: 'agent.dispatch', object_id: 'agent:aaaaaaaa:01', args: {} }, b.mac)).status).toBe(201);
    advance(2 * HOUR); // A 开机
    const pulled = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body.requests;
    expect(pulled.map(r => r.request_id)).toEqual(['off']);
    const result = await json(await post('/v1/inbox/requests/result', { request_id: 'off', state: 'done', result: { receipt: { kind: 'done', text: '改好了' } } }, a.mac));
    expect(result.status).toBe(200);
    const back = (await pullAll(b.mac)).events.filter(e => e.kind === 'request.result');
    expect(back[0].payload).toMatchObject({ op: 'agent.dispatch', object_id: 'agent:aaaaaaaa:01', result: { receipt: { kind: 'done' } } });
  });
});

describe('频道', () => {
  it('消息只存取件单引用;撤回不删原行,快照里折成已撤回;只能撤自己的', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    const path = `/v1/channels/${encodeURIComponent(channel.id)}/messages`;
    const sent = (await json(await post(path, {
      request_id: 'm1', text: '样片在这', attachments: [{ offer: 'of-1', name: '样片.mp4', bytes: 1024, kind: 'video', owner_device: a.macId, path: '/Users/example/秘密/样片.mp4', data: 'AAAA' }],
    }, a.mac))).body.message;
    expect(sent.attachments).toEqual([{ offer: 'of-1', name: '样片.mp4', bytes: 1024, kind: 'video', owner_device: a.macId }]);
    expect((await json(await post(`${path}/${sent.id}/retract`, { request_id: 'rb' }, b.mac))).body.error.code).toBe('not_author');
    const retract = await json(await post(`${path}/${sent.id}/retract`, { request_id: 'ra' }, a.phone));
    expect(retract.status).toBe(201);
    expect(retract.body.message).toMatchObject({ kind: 'system', retract_of: sent.id });
    const snap = (await json(await get(path, b.mac))).body;
    const original = snap.messages.find(m => m.id === sent.id);
    expect(original.text).toBe('');
    expect(original.retracted.by).toBe(retract.body.message.id);
    // 原行还在库里
    expect(db.prepare('SELECT text FROM channel_messages WHERE id = ?').get(sent.id).text).toBe('样片在这');
  });

  it('快照按 before 往前翻页;reply_to 要在本频道里;4000 字上限;butler 只有电脑能标', async () => {
    await startRelay();
    const { a, channel } = await studio();
    const path = `/v1/channels/${encodeURIComponent(channel.id)}/messages`;
    for (let i = 1; i <= 5; i += 1) await post(path, { request_id: `p${i}`, text: `${i}` }, a.mac);
    const all = (await json(await get(path, a.mac))).body.messages;
    const last = all[all.length - 1].seq;
    const page = (await json(await get(`${path}?before=${last}&limit=2`, a.mac))).body.messages;
    expect(page.map(m => m.seq)).toEqual([last - 2, last - 1]);
    expect((await json(await post(path, { request_id: 'bad', text: 'x', reply_to: 'nope' }, a.mac))).body.error.code).toBe('bad_reply_to');
    expect((await json(await post(path, { request_id: 'long', text: 'x'.repeat(4001) }, a.mac))).status).toBe(413);
    const fromPhone = (await json(await post(path, { request_id: 'bp', text: '日结', kind: 'daily', butler: true }, a.phone))).body.message;
    expect(fromPhone.author.butler).toBeUndefined();
    const fromMac = (await json(await post(path, { request_id: 'bm', text: '日结', kind: 'daily', butler: true }, a.mac))).body.message;
    expect(fromMac.author).toMatchObject({ person: a.id, nick: '阿本', butler: true });
  });

  it('不在工作室的人看不到频道', async () => {
    await startRelay();
    const { channel } = await studio();
    const z = await person('z@x.cn');
    expect((await json(await get(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, z.mac))).status).toBe(404);
  });
});

describe('定时派活的回调地址', () => {
  it('电脑开地址(整串只给一次)→ 外面打进来变成一条 timer.fire 请求;Idempotency-Key 同号只投一次', async () => {
    await startRelay();
    const { a } = await studio();
    expect((await json(await post('/v1/webhooks', { label: '每周一', target: {} }, a.phone))).body.error.code).toBe('desk_only');
    const made = await json(await post('/v1/webhooks', { label: '每周一复盘', target: { agent_object_id: 'agent:aaaaaaaa:01', template: '复盘上周数据' } }, a.mac));
    expect(made.status).toBe(201);
    expect(made.body.url.startsWith('https://relay.example.test/v1/hooks/wh_')).toBe(true);
    const listed = (await json(await get('/v1/webhooks', a.mac))).body.webhooks;
    expect(JSON.stringify(listed).includes(made.body.url.split('/hooks/')[1])).toBe(false);
    const hookPath = new URL(made.body.url).pathname;
    const hit = await json(await post(hookPath, { source: 'cron' }, undefined, { 'idempotency-key': 'mon-1027' }));
    expect(hit.status).toBe(202);
    const again = await json(await post(hookPath, { source: 'cron' }, undefined, { 'idempotency-key': 'mon-1027' }));
    expect(again.body.duplicate).toBe(true);
    const reqs = (await json(await get('/v1/inbox/requests?since=0', a.mac))).body.requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ op: 'timer.fire', from_account: a.id, args: { label: '每周一复盘', target: { template: '复盘上周数据' }, body: { source: 'cron' } } });
  });

  it('轮换后旧地址 404;停用后也 404;客户端发不了 timer.fire', async () => {
    await startRelay();
    const { a } = await studio();
    const made = (await json(await post('/v1/webhooks', { label: 'x', target: {} }, a.mac))).body;
    const rotated = (await json(await post(`/v1/webhooks/${encodeURIComponent(made.webhook.id)}/rotate`, {}, a.mac))).body;
    expect((await post(new URL(made.url).pathname, {})).status).toBe(404);
    expect((await post(new URL(rotated.url).pathname, {})).status).toBe(202);
    await post(`/v1/webhooks/${encodeURIComponent(made.webhook.id)}/revoke`, {}, a.mac);
    expect((await post(new URL(rotated.url).pathname, {})).status).toBe(404);
    expect((await json(await post('/v1/inbox/requests', { request_id: 't', to_account: a.id, op: 'timer.fire', args: {} }, a.mac))).body.error.code).toBe('bad_op');
  });
});

// 2026-10-21 合并:卡 C 独有、并进本底座的几样(它的 studio*.cjs 与用例已退役)。
describe('并进来的卡 C 能力', () => {
  it('邀请码只存哈希:库里找不到明文', async () => {
    await startRelay();
    const { a } = await studio();
    const invite = (await json(await post('/v1/workspace/invite', {}, a.session))).body;
    const rows = db.prepare('SELECT * FROM workspace_invites').all();
    expect(JSON.stringify(rows).includes(invite.code)).toBe(false);
  });

  it('被移除后另起工作室:移出前没取走的积压读不回;自己对象的事件仍读得回;游标推到队头', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    await post('/v1/objects', { object_id: 'bbbbbbbb:t-1', kind: 'card', title: 'B 的卡' }, b.mac);
    const { cursor } = await pullAll(b.mac);
    await post(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, { request_id: 'secret', text: '移出前的悄悄话' }, a.mac);
    await post(`/v1/objects/${encodeURIComponent('bbbbbbbb:t-1')}/events`, { origin_seq: 7, payload: { status: 'doing' } }, b.mac);
    await post('/v1/workspace/members/remove', { account_id: b.id }, a.session);
    expect((await post('/v1/workspace', { name: 'B 自己的', nick: '运营' }, b.session)).status).toBe(201);
    const page = await json(await get(`/v1/inbox/events?since=${cursor}`, b.mac));
    expect(page.status).toBe(200);
    expect(page.body.events.some(e => e.payload.text === '移出前的悄悄话')).toBe(false);
    expect(page.body.events.some(e => e.object_id === 'bbbbbbbb:t-1' && e.origin.seq === 7)).toBe(true);
    expect(page.body.next_cursor).toBe(page.body.head);
  });

  it('同一个 request_id 被别的账号先占了 → 409 request_id_taken', async () => {
    await startRelay();
    const { a, b, others: [c] } = await studio([['c@x.cn', '丙']]);
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    const body = { request_id: 'same-id', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: { text: 'B 说的' } };
    expect((await post('/v1/inbox/requests', body, b.phone)).status).toBe(201);
    const taken = await json(await post('/v1/inbox/requests', body, c.phone));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('request_id_taken');
  });

  it('对象只能由电脑登记 / 推事件;手机 403 desk_only;GET ?id= 查一个,看不见 404', async () => {
    await startRelay();
    const { a, b } = await studio();
    expect((await json(await post('/v1/objects', { object_id: 'aaaaaaaa:t-9', kind: 'card', title: '卡' }, a.phone))).body.error.code).toBe('desk_only');
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-9', kind: 'card', title: '卡' }, a.mac);
    expect((await json(await post(`/v1/objects/${encodeURIComponent('aaaaaaaa:t-9')}/events`, { origin_seq: 1 }, a.phone))).body.error.code).toBe('desk_only');
    const one = await json(await get(`/v1/objects?id=${encodeURIComponent('aaaaaaaa:t-9')}`, b.phone));
    expect(one.body.object).toMatchObject({ object_id: 'aaaaaaaa:t-9', owner_account: a.id, owner_epoch: 1 });
    expect((await get(`/v1/objects?id=${encodeURIComponent('nope:1')}`, b.phone)).status).toBe(404);
  });

  it('交接:epoch +1;旧主人名下没办的请求退回发起者(owner_changed),按目录重投到新主人', async () => {
    await startRelay();
    const { a, b } = await studio();
    await post('/v1/objects', { object_id: 'aaaaaaaa:t-1', kind: 'card', title: '卡' }, a.mac);
    await post('/v1/inbox/requests', { request_id: 'pending', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-1', args: {} }, b.phone);
    const { cursor } = await pullAll(b.phone);
    const xfer = { object_id: 'aaaaaaaa:t-1', to_account: b.id, to_device: b.macId };
    expect((await json(await post('/v1/objects/transfer', { ...xfer, expected_owner_epoch: 2 }, a.mac))).body.error.code).toBe('stale_owner_epoch');
    expect((await json(await post('/v1/objects/transfer', { ...xfer, to_device: b.phoneId, expected_owner_epoch: 1 }, a.mac))).body.error.code).toBe('invalid_transfer_target');
    expect((await json(await post('/v1/objects/transfer', { ...xfer, expected_owner_epoch: 1 }, b.mac))).body.error.code).toBe('wrong_owner');
    const moved = await json(await post('/v1/objects/transfer', { ...xfer, expected_owner_epoch: 1 }, a.mac));
    expect(moved.body.object).toMatchObject({ owner_account: b.id, owner_device: b.macId, owner_epoch: 2 });
    const back = (await pullAll(b.phone, cursor)).events;
    expect(back.find(e => e.kind === 'request.result').payload).toMatchObject({ request_id: 'pending', state: 'rejected', result: { code: 'owner_changed', owner_account: b.id, owner_epoch: 2 } });
    expect(back.some(e => e.kind === 'object.event' && e.payload.change === 'owner_changed')).toBe(true);
    const stale = await json(await post('/v1/inbox/requests', { request_id: 'again', to_account: a.id, op: 'task.comment', object_id: 'aaaaaaaa:t-1', expected_owner_epoch: 1, args: {} }, b.phone));
    expect(stale.body.error).toMatchObject({ code: 'wrong_owner', owner_account: b.id, owner_epoch: 2 });
  });

  it('ack:按设备各记各的、只进不退、封顶队头;GET 不带 since 从书签续', async () => {
    await startRelay();
    const { a, b, channel } = await studio();
    const path = `/v1/channels/${encodeURIComponent(channel.id)}/messages`;
    const { cursor } = await pullAll(b.mac);
    expect((await json(await post('/v1/inbox/ack', { queue: 'events', last_acked: cursor }, b.mac))).body).toEqual({ queue: 'events', last_acked: cursor });
    expect((await json(await post('/v1/inbox/ack', { queue: 'events', last_acked: 1 }, b.mac))).body.last_acked).toBe(cursor);
    expect((await json(await post('/v1/inbox/ack', { queue: 'events', last_acked: 99999 }, b.mac))).body.last_acked).toBe(cursor);
    await post(path, { request_id: 'n1', text: '新的' }, a.mac);
    const resumed = await json(await get('/v1/inbox/events', b.mac));
    expect(resumed.body.events.map(e => e.payload.text)).toEqual(['新的']);
    // 手机没 ack 过:从 0 起
    const phone = await json(await get('/v1/inbox/events', b.phone));
    expect(phone.body.events.length).toBeGreaterThan(1);
  });

  it('保留期可配:RELAY_INBOX_EVENT_DAYS=2 时三天前的事件就清了', async () => {
    await startRelay({ RELAY_INBOX_EVENT_DAYS: '2' });
    const { a, b, channel } = await studio();
    await post(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, { request_id: 'o', text: '老' }, a.mac);
    advance(3 * DAY);
    const res = await json(await get('/v1/inbox/events?since=0', b.mac));
    expect(res.status).toBe(410);
  });
});
