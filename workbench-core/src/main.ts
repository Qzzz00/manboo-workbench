#!/usr/bin/env node
/**
 * 座机服务的进程入口(launchd:deploy/ai.deepseek.workbench-core.plist)。
 * 端口与上游都由环境变量定,见 config.ts;收到 SIGTERM 先关监听再退,launchd 的 stop / kickstart 不留半截连接。
 */
import { readConfig } from './config.ts'
import { startCore } from './server.ts'

const log = (line: string): void => { console.log(`${new Date().toISOString()} ${line}`) }

async function main(): Promise<void> {
  const config = readConfig(process.env)
  const core = await startCore({ ...config, log })
  log(`[core] 座机服务在 ${config.host}:${core.port},上游 ${config.upstream}${config.upstreamRemote === undefined ? ',非本机来源不转' : `,非本机来源转 ${config.upstreamRemote}`}`)
  const shutdown = (signal: string): void => {
    log(`[core] 收到 ${signal},退出`)
    void core.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(`[core] 起不来:${error instanceof Error ? error.message : String(error)}`)
  // 非零退出:plist 的 KeepAlive.SuccessfulExit=false 会按 ThrottleInterval 再拉起。
  process.exit(1)
})
