/**
 * 连接器的**宿主进程**源码(卡 OC,2026-09-27)。
 *
 * 为什么要我们自己写一个:npm 上的 `@oomol-lab/open-connector` 是一个
 * **无头 runtime 库**,不带 CLI、不带 Web 控制台、不读环境变量 ——
 * 「谁来听端口、配置从哪来、进程怎么收摊」按它 README 的说法全归宿主。
 * (带控制台的是它的 Docker 镜像与单文件二进制,那两条都与"双击装好就能用"相冲,
 *  见 `docs/设计-连接器通用能力-2026-09-27.md` 第二节。)
 *
 * 这一份以**字符串**的形式随插件走,安装时原样落到 `~/.dsh/open-connector/server.mjs`。
 * 放成字符串而不是 `bin/` 下一个文件,是为了不用动 `build-installer.sh` 与
 * `publish-update.sh` 的 `scripts.tgz` 清单 —— 卡 OC 默认不进安装包。
 *
 * 它做四件事,一件不多:
 * 1. 从 `~/.dsh/workbench/connector.json` 读端口与两个本机令牌(**不读环境变量里的密钥**);
 * 2. 按 `policy.json` 里算好的白名单起 runtime(默认只读);
 * 3. **只绑 127.0.0.1**;
 * 4. 端口被占先问一句 `/healthz` 认亲,是自己人就安静退出(照 butler-server 那条,
 *    免得 launchd 每 10 秒重拉一次的风暴)。
 */
export const CONNECTOR_HOST_SCRIPT = `#!/usr/bin/env node
// 由工作台生成(卡 OC)。改这里没用,升级会覆盖;要改请改仓库里的 hostScript.ts。
import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { createConnectorRuntime } from '@oomol-lab/open-connector'

const dir = new URL('.', import.meta.url).pathname.replace(/\\/$/, '')
const configFile = process.env.CONNECTOR_CONFIG_FILE
if (!configFile) {
  console.error('[connector] 没有 CONNECTOR_CONFIG_FILE,启动脚本没设对')
  process.exit(1)
}
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const port = Number(config.port)
const host = '127.0.0.1'

let policy = { allowedActions: ['workbench:none.none'] }
try {
  policy = JSON.parse(readFileSync(dir + '/policy.json', 'utf8'))
} catch {
  // 没有策略文件 = 一家都没接 = 什么都不许做。这是**故意**的默认值,不要改成全放行。
}

// 端口被占:先认亲。是另一份自己就安静退出(exit 0),launchd 不会反复重拉。
try {
  const probe = await fetch('http://' + host + ':' + port + '/healthz', { signal: AbortSignal.timeout(1500) })
  const body = await probe.json().catch(() => null)
  if (body && body.name === 'open-connector') {
    console.log('[connector] ' + port + ' 上已经有一份在跑,这一份退出')
    process.exit(0)
  }
} catch {
  // 没人应答 = 端口空着,继续起。
}

const t0 = Date.now()
const connector = await createConnectorRuntime({
  dataDir: dir + '/data',
  publicOrigin: 'http://' + host + ':' + port,
  encryptionKey: config.encryptionKey,
  adminToken: config.adminToken,
  runtimeToken: config.runtimeToken,
  actionPolicy: { allowedActions: policy.allowedActions },
  logger: { error: console.error, warn: console.warn, info: () => {} },
})

const server = serve({
  port,
  hostname: host,
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      // 认亲用。**不带任何令牌、不带任何账号信息**。
      return new Response(JSON.stringify({ ok: true, name: 'open-connector', pid: process.pid, port }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return connector.fetch(request)
  },
})
console.log('[connector] 起来了,' + (Date.now() - t0) + 'ms,127.0.0.1:' + port)

const shutdown = async () => {
  server.close()
  await connector.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
`

/** 启动脚本:launchd 调它。令牌**只**从 0600 的配置文件走,不进 plist、不进环境里的明文。 */
export function connectorStartScript(): string {
  return `#!/usr/bin/env bash
# 连接器(open-connector)启动脚本 —— launchd: ~/Library/LaunchAgents/ai.deepseek.connector.plist 调用。
# 安装位置:~/.dsh/bin/connector-start。仿 butler-start。
set -euo pipefail

export DSH_HOME="$HOME/.dsh"
export DSH_NODE="$DSH_HOME/node/bin/node"
export PATH="$DSH_HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CONNECTOR_DIR="\${CONNECTOR_DIR:-$DSH_HOME/open-connector}"
export CONNECTOR_CONFIG_FILE="\${CONNECTOR_CONFIG_FILE:-$DSH_HOME/workbench/connector.json}"

if [ ! -f "$CONNECTOR_DIR/server.mjs" ]; then
  echo "[connector-start] 找不到 $CONNECTOR_DIR/server.mjs:连接器还没装(设置 → 连接器 → 装上)" >&2
  exit 1
fi
if [ ! -x "$DSH_NODE" ]; then
  DSH_NODE="$(command -v node)"
fi

cd "$CONNECTOR_DIR"
exec "$DSH_NODE" "$CONNECTOR_DIR/server.mjs"
`
}

/**
 * 给「自己在终端里起的 Agent」用的一行环境:`source ~/.dsh/bin/connector-env`。
 *
 * 各家 MCP 配置里写的是 `\${OPEN_CONNECTOR_TOKEN}` 占位符,
 * 真值由这个脚本**从 0600 的配置文件现读**,不落在任何别的文件里。
 */
export function connectorEnvScript(): string {
  return `#!/usr/bin/env bash
# source 我,不要执行我。给手动起的 Agent(Claude Code / Codex)喂连接器的本机令牌。
# 令牌只住在 ~/.dsh/workbench/connector.json(0600),这里现读现导,不落盘第二份。
OPEN_CONNECTOR_TOKEN="$("$HOME/.dsh/node/bin/node" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.dsh/workbench/connector.json","utf8")).runtimeToken)')"
export OPEN_CONNECTOR_TOKEN
`
}

/** launchd plist。照 `deploy/ai.deepseek.dsh.plist` 用 `{{HOME}}` 占位,**不写死 /Users/example**。 */
export function connectorPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.deepseek.connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{HOME}}/.dsh/bin/connector-start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{HOME}}/.dsh</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>{{HOME}}/.dsh/logs/connector.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>{{HOME}}/.dsh/logs/connector.stderr.log</string>
</dict>
</plist>
`
}
