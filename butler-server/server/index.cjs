'use strict';

// 入口:读 ~/.dsh/workbench/butler.json(首次生成端口与令牌),只监听 127.0.0.1。
// 热点网段以后再开(设计-事务官完整材料 §1),届时改 host 并让 adminAuth 认设备令牌。
// SIGTERM 时正常退出(exit 0):launchd 的 KeepAlive.SuccessfulExit=false 才不会把「工作台点了停止」当崩溃拉起。
//
// 端口被占(EADDRINUSE,2026-09-17):先问一句占着端口的是不是另一份 butler-server(GET /health)。
// 是 → 本进程是多出来的那一份,exit 0 让 launchd 别再拉(否则 KeepAlive 每 10 秒重试一次,永远);
// 不是 → 还是 exit 1,让 launchd 继续等那个陌生进程让出端口。
// 起因:launchd 项装上之前,工作台曾脱离 launchd 直接拉过一份;装上 launchd 项后两份抢 8792,风暴 125 次。

const { loadConfig } = require('./config.cjs');
const { createApp } = require('./app.cjs');
const { DB_PATH, UPLOADS_BASE } = require('./db.cjs');

const HOST = process.env.BUTLER_HOST || '127.0.0.1';

/**
 * 问占着 host:port 的进程是不是一份健康的 butler-server。
 * 只认 { ok:true, name:'butler-server' };回环请求 adminAuth 放行,不用带令牌。
 * 任何异常(连不上、超时、不是 JSON)都当「不是」——那就按原来的 exit 1 走。
 */
async function probeSibling(host, port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const body = await res.json();
    if (body && body.ok === true && body.name === 'butler-server') {
      return { pid: typeof body.pid === 'number' ? body.pid : undefined };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * listen 出错时该用哪个退出码(纯函数,可测)。
 * EADDRINUSE 且对面是 butler-server → 0(本进程多余,别让 launchd 再拉);其余 → 1。
 */
async function exitCodeForListenError(err, { host, port, fetchImpl, log = console.error } = {}) {
  if (err && err.code === 'EADDRINUSE') {
    const sibling = await probeSibling(host, port, fetchImpl);
    if (sibling !== undefined) {
      const who = sibling.pid === undefined ? '' : `(pid ${sibling.pid})`;
      log(`[butler-server] ${host}:${port} 已经有一份 butler-server 在跑${who},本进程多余,正常退出;要换成 launchd 管的那份,先停掉它再 launchctl kickstart`);
      return 0;
    }
  }
  log('[butler-server] listen failed:', err && err.message);
  return 1;
}

function main() {
  const config = loadConfig();
  const port = Number.isInteger(Number(process.env.BUTLER_PORT)) && process.env.BUTLER_PORT !== undefined
    ? Number(process.env.BUTLER_PORT)
    : config.port;
  const app = createApp();
  const server = app.listen(port, HOST, () => {
    // 只打端口与目录,不打 token。
    console.log(`[butler-server] listening on http://${HOST}:${port}/admin/  db=${DB_PATH} uploads=${UPLOADS_BASE}`);
    // 起来就先向工作台拉一次下发的语音钥匙(2026-09-23;只进内存,见 services/workbenchVoiceCreds.cjs)。
    // 不拉也行 —— 第一句合成时会自己拉;先拉是为了通话工人第一次预合成开场白时不用多等这一趟。
    void require('./services/voiceCredentials.cjs').ensureWorkbenchCreds();
  });
  server.on('error', (err) => {
    exitCodeForListenError(err, { host: HOST, port }).then((code) => process.exit(code));
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { main, exitCodeForListenError, probeSibling };
