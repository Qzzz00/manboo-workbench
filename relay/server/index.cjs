'use strict';

// 进程入口。systemd 拉起的就是它(deploy/aliyun-relay-setup.sh)。
//
// 启动时打三行:端口、上游地址、上游 Key 配了没有(**只打布尔**)。
// 日志里永远不会出现:上游 Key、中转令牌明文、用户说过的任何一句话。

const { createApp } = require('./app.cjs');
const { relayConfigOf } = require('./config.cjs');
const { openRelayDb } = require('./db.cjs');

function main() {
  const config = relayConfigOf(process.env);
  const db = openRelayDb(config.dbPath);
  const app = createApp({ db, config, log: line => console.log(`[relay] ${line}`) });

  const server = app.listen(config.port, config.bind, () => {
    console.log(`[relay] 监听 ${config.bind}:${config.port}`);
    console.log(`[relay] 上游 ${config.upstreamUrl}`);
    console.log(`[relay] 上游 Key ${config.upstreamKey === undefined ? '未配置(现在还转不了,先写 /opt/relay/.env)' : '已配置'}`);
    console.log(`[relay] 每个令牌每天最多花 ${config.dailyCostLimitCny} 元(按上游官方价折算,见 server/pricing.cjs)`);
    for (const warning of config.warnings ?? []) console.log(`[relay] ★ 注意:${warning}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => { try { db.close(); } catch { /* 关不上就算了,进程马上就没了 */ } process.exit(0); });
    });
  }
}

if (require.main === module) main();

module.exports = { main };
