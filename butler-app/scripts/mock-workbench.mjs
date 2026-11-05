#!/usr/bin/env node
/**
 * 假工作台:在本机起一台"8791",按交接文档的契约回话,给手机端联调用(不碰真的 ~/.dsh、不碰真 8791)。
 *
 *   node scripts/mock-workbench.mjs [--port 8795] [--voice] [--avatar-zip <形象包.zip>] [--code 123456]
 *
 * - POST /pair/claim { code, device_name, platform } → { ok, token, device_id }(码不对 400,原话「配对码不对或已失效」)
 * - 其它路由要 Authorization: Bearer <token>,否则 401
 * - GET /state:sessions / tasks / butler_inbox,POST /butler/item 建事项 + 开"会话",3 秒后给一句 summary 当回复
 * - WS /live?token=:连上先发 snapshot,之后每次变化再发;20 秒一次 ping
 * - /butler/proxy/api/*:不带 --voice 时全 503(界面应退回文字);带 --voice 时 tts 回一段 1 秒的 440Hz WAV(听个响、看口型),
 *   asr 固定回「这是假识别结果」;avatars 默认**一个都没有**(仓库不带模型,10-21 —— 正好看缺省态),
 *   给了 --avatar-zip 就把那个 zip 当成电脑上发布过的一个形象(自己拿 Live2D 官方样例打一个)
 * - --rtc:让 /rtc/status 答「配了」,好在浏览器上看通话中的那一屏(底部三个键)。**这里没有真的火山**,
 *   token 照样打不通,所以界面会停在「正在接通…」再落到那句错误——够看底部键与球,打不了真电话。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(flag('--port', '8795'));
const CODE = flag('--code', '123456');
const VOICE = args.includes('--voice');
// 只影响 /rtc/status 答什么:界面据它决定通话键灰不灰。真的接通要火山密钥,mock 给不了。
const RTC = args.includes('--rtc');
// 令牌从配对码派生:重启 mock 不用重配。真工作台是随机的,这里只为联调省事。
const TOKEN = crypto.createHash('sha256').update(`mock:${CODE}`).digest('base64url').slice(0, 32);

const AVATAR_ZIP = flag('--avatar-zip', null);

let seq = 0;
const now = () => new Date().toISOString();
const state = {
  now: now(), stale: false,
  // 真 /state 恒带 agents / quota(展示台读它们不判空),mock 也得带。
  agents: ['dsh', 'claude', 'codex', 'kimi'].map((id) => ({ id, online: id === 'dsh', connected: id === 'dsh', waiting: 0, running: 0 })),
  quota: {},
  sessions: [],
  tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
  butler_inbox: { items: [
    { id: 'sentinel:w1', kind: 'sentinel', title: '磁盘剩余 8%', at: now() },
    { id: 'risk:p1', kind: 'risk', title: 'Aiboo 赶不上预期结束', note: '预计 09-20' },
  ] },
  projects: { projects: [] },
};
const sockets = new Set();

function snapshot() { state.now = now(); return { ...state }; }
function broadcast() { const msg = JSON.stringify({ kind: 'snapshot', state: snapshot() }); for (const s of sockets) wsSend(s, msg); }

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); }); }

function sineWav(seconds = 1, hz = 440, rate = 16000) {
  const n = seconds * rate; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const env = Math.abs(Math.sin(i / rate * 6)); buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 12000 * env), 44 + i * 2); }
  return buf;
}

// 电脑上「发布过」的形象:给了 --avatar-zip 才有一个(同 butler-server routes/api/avatars.cjs 的形状,详情带 { avatar } 外壳)。
const avatarZip = AVATAR_ZIP === null ? null : readFileSync(path.resolve(AVATAR_ZIP));
const AVATAR = avatarZip === null ? null : {
  id: 'mock1', name: path.basename(AVATAR_ZIP, '.zip'), summary: '假形象(--avatar-zip 给的包)', status: 'published', version: 1,
  size_bytes: avatarZip.length, checksum: crypto.createHash('sha256').update(avatarZip).digest('hex'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://x`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' });
    res.end(); return;
  }
  if (p === '/pair/claim' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'body 不是合法 JSON' }); return; }
    if (typeof body.code !== 'string' || typeof body.device_name !== 'string' || typeof body.platform !== 'string') { json(res, 400, { error: 'code / device_name / platform 都必须是字符串' }); return; }
    if (body.code !== CODE) { json(res, 400, { error: '配对码不对或已失效' }); return; }
    console.log(`[mock] 配对成功:${body.device_name} (${body.platform})`);
    json(res, 200, { ok: true, token: TOKEN, device_id: 'dev-mock-1' }); return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) { json(res, 401, { error: '需要设备令牌:先在工作台设置里配对' }); return; }

  if (p === '/state' && req.method === 'GET') { json(res, 200, snapshot()); return; }
  if (p === '/butler/item' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'body 不是合法 JSON' }); return; }
    if (typeof body.text !== 'string' || body.text.trim() === '') { json(res, 400, { error: '事项内容不能为空' }); return; }
    const id = `t-${++seq}`; const sid = `s-${seq}`; const at = now();
    const title = body.text.split('\n')[0].slice(0, 40);
    state.tasks.tasks.push({ id, title, desc: body.text, status: 'doing', direction: 'mine', conversation: { agent: 'dsh', session_id: sid }, links: [{ agent: 'dsh', session_id: sid }], source: 'manual', created_at: at, updated_at: at });
    state.sessions.push({ agent: 'dsh', session_id: sid, project: 'mock', status: 'running', title, elapsed_sec: 0, unread: false, updated_at: at });
    console.log(`[mock] 建事项 ${id}:${title}`);
    broadcast();
    setTimeout(() => {
      const s = state.sessions.find((x) => x.session_id === sid); const t = state.tasks.tasks.find((x) => x.id === id);
      if (s && t) { s.status = 'done'; s.summary = `收到「${title}」,我先记下了;这是假工作台的回复。`; s.updated_at = now(); t.status = 'confirm'; t.updated_at = now();
        state.butler_inbox.items.unshift({ id: `confirm:${id}`, kind: 'confirm', title, status: 'confirm', task_id: id, at: now(), conversation: { agent: 'dsh', session_id: sid } });
        broadcast(); }
    }, 3000);
    json(res, 200, { ok: true, id, conversation: { agent: 'dsh', session_id: sid } }); return;
  }
  if (p.startsWith('/butler/proxy/api/')) {
    const sub = p.slice('/butler/proxy/api'.length);
    if (!VOICE) { json(res, 503, { error: '本机后端没有配语音(mock 未加 --voice)' }); return; }
    if (sub === '/avatars') { json(res, 200, { avatars: AVATAR === null ? [] : [AVATAR] }); return; }
    if (AVATAR !== null && sub === `/avatars/${AVATAR.id}`) { json(res, 200, { avatar: { ...AVATAR, transform: {}, voice: null } }); return; }
    if (AVATAR !== null && sub === `/avatars/${AVATAR.id}/bundle.zip`) { res.writeHead(200, { 'content-type': 'application/zip', 'access-control-allow-origin': '*' }); res.end(avatarZip); return; }
    if (sub.startsWith('/avatars/')) { json(res, 404, { code: 'avatar_not_found', error: '没有这个形象,或它还没发布' }); return; }
    if (sub === '/tts' && req.method === 'POST') { await readBody(req); res.writeHead(200, { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' }); res.end(sineWav()); return; }
    if (sub === '/asr' && req.method === 'POST') { const b = await readBody(req); console.log(`[mock] asr 收到 ${b.length} 字节`); json(res, 200, { text: '这是假识别结果' }); return; }
    if (sub === '/rtc/status') { json(res, 200, RTC ? { configured: true } : { configured: false, reason: '未配置语音供应商密钥' }); return; }
    // 带 --rtc 时发一份假 token / 假 taskId:界面会一路走到「正在接通…」,底部三个键就画出来了。
    // 火山那一头当然连不上,最后落到「接不通」那一屏——这正是没有密钥时真机会看到的样子。
    if (sub === '/rtc/token' && req.method === 'POST') {
      if (!RTC) { json(res, 503, { error: 'mock 没有真的火山 RTC(只能看界面)' }); return; }
      json(res, 200, { appId: 'a'.repeat(24), roomId: 'mock-room', userId: 'mock-user', token: 'mock-token' }); return;
    }
    if (sub === '/rtc/start' && req.method === 'POST') { await readBody(req); json(res, 200, { taskId: 'mock-task', botUserId: 'mock-bot' }); return; }
    if (sub === '/rtc/stop' && req.method === 'POST') { await readBody(req); json(res, 200, {}); return; }
    json(res, 404, { error: `mock 没有 ${sub}` }); return;
  }
  json(res, 404, { error: `mock 没有 ${p}` });
});

// —— 极简 WebSocket(只发不收):握手 + 文本帧 ——
function wsSend(socket, text) {
  const payload = Buffer.from(text); const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch { sockets.delete(socket); }
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  // 与真工作台同规矩:回环来源免令牌(展示台页面连 127.0.0.1 时不带 ?token=),别的来源要令牌。
  const loopback = socket.remoteAddress === '127.0.0.1' || socket.remoteAddress === '::1' || socket.remoteAddress === '::ffff:127.0.0.1';
  if (url.pathname !== '/live' || (!loopback && url.searchParams.get('token') !== TOKEN)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket)); socket.on('error', () => sockets.delete(socket));
  socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 0x8) { sockets.delete(socket); socket.end(); } });
  wsSend(socket, JSON.stringify({ kind: 'snapshot', state: snapshot() }));
  console.log('[mock] /live 订阅 +1');
});
setInterval(() => { for (const s of sockets) wsSend(s, JSON.stringify({ kind: 'ping', ts: Date.now() })); }, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] 假工作台听 0.0.0.0:${PORT};配对码 ${CODE};语音 ${VOICE ? `开(假 tts/asr;形象 ${AVATAR === null ? '没有' : AVATAR.name})` : '关(503)'};通话入口 ${RTC ? '开(只到"正在接通",没有真火山)' : '灰'}`);
  console.log(`[mock] 浏览器调试:打开 App 后地址栏加 #workbench://pair?host=127.0.0.1&port=${PORT}&code=${CODE}`);
});
