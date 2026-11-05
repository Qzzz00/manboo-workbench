#!/usr/bin/env node
/**
 * **ACP 客户端 vs app-server 直连:同一句交代,真机对比**(2026-10-19,实验卡「ACP 客户端替 app-server 直连」)。
 *
 * 只在维护者自己这台机器上**手动**跑 —— 它会在 Codex 里真开两条新线程、真发一句话、真花一点额度,
 * 真在你给的目录里让 Codex 新建文件。不挂任何定时、不进测试套件、不装插件、不碰 `~/.dsh`。
 *
 * ```
 * node workbench-plugin/scripts/probe-acp-compare.ts                       # 两条路都跑(先 ACP 后 app-server)
 * node workbench-plugin/scripts/probe-acp-compare.ts --only acp            # 只跑一条:acp / appserver
 * node workbench-plugin/scripts/probe-acp-compare.ts --cwd /tmp/x --text '在这个目录新建 hello.txt 写一句话'
 * node workbench-plugin/scripts/probe-acp-compare.ts --answer decline      # 它一问权限就替她答哪一项(缺省 allow_once);none = 不答,看它等多久
 * node workbench-plugin/scripts/probe-acp-compare.ts --answer-after 5      # 收到那一问几秒后再答(模拟她在手机上看一眼)
 * node workbench-plugin/scripts/probe-acp-compare.ts --readonly            # 卡上**不许改文件**那一档:ACP 走 read-only 会问人,app-server 走 read-only + never 不会问
 * ```
 *
 * 记的几样(交接里就贴这几样):起进程到握手耗时、第一个字回来耗时、权限请求有没有到(到了几次、长什么样)、
 * 答完有没有接着跑、总耗时、目录里有没有那个文件、它的 stderr 里有没有多余的东西(弹窗 / 开浏览器)。
 *
 * **不读任何凭据**:两条路都走 ChatGPT 桌面版自带那份 `codex` 的登录态(`CODEX_PATH` 指向它);
 * ACP 那条从不调 `authenticate`,它说没登录就如实打出来。
 *
 * 直接 import 两个适配器(Node 直接跑 .ts,strip-only):核的是「这两条路在这台机器上通不通、各花多久」,
 * 适配器自己的分支由 `tests/engine-acp-adapter.test.ts` / `tests/engine-codex-adapter.test.ts` 核。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acpCodexAdapter, acpOptionLabel } from '../src/server/engine/adapters/acp.ts'
import { acpAgentLink, spawnCodexAcpPeer, CODEX_ACP_VERSION, findNpx } from '../src/server/engine/adapters/acpClient.ts'
import { codexAdapter, findCodexBinary } from '../src/server/engine/adapters/codex.ts'
import { codexAppServerLink, spawnCodexAppServerPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import type { WorkbenchEvent } from '../src/protocol.ts'

function arg(name: string, fallback: string | undefined): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const since = Date.now()
const stamp = (): string => `+${((Date.now() - since) / 1000).toFixed(2)}s`
const log = (line: string): void => { console.log(`${stamp()} ${line}`) }

interface Numbers {
  route: 'acp' | 'appserver'
  handshakeMs?: number
  firstSignalMs?: number
  firstTextMs?: number
  permissionAskedAtMs?: number[]
  answeredAtMs?: number[]
  continuedAfterAnswer?: boolean
  totalMs?: number
  delivered?: string
  reply?: string
  why?: string
  sessionId?: string
  fileMade?: boolean
  stderrLines?: number
  stderrOddities?: string[]
}

function fileMade(cwd: string, before: Set<string>): boolean {
  try { return readdirSync(cwd).some(one => !before.has(one)) }
  catch { return false }
}

async function runAcp(input: { cwd: string, text: string, answer: string, answerAfterMs: number, binary: string, logsDir: string, writes: boolean }): Promise<Numbers> {
  const out: Numbers = { route: 'acp', permissionAskedAtMs: [], answeredAtMs: [], stderrOddities: [] }
  const t0 = Date.now()
  const stderr: string[] = []
  const npx = findNpx(process.env.PATH, existsSync)
  log(`[ACP] npx=${npx} 包=@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} CODEX_PATH=${input.binary}`)
  const link = acpAgentLink({
    clientName: 'probe-acp-compare',
    spawnPeer: () => spawnCodexAcpPeer({
      codexBinary: input.binary,
      npx,
      stderr: 'pipe',
      logsDir: input.logsDir,
      onStderr: (chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.trim() === '') continue
          stderr.push(line)
          if (/browser|open\(|login|auth/i.test(line)) out.stderrOddities?.push(line.slice(0, 200))
        }
      },
    }),
  })
  const events: WorkbenchEvent[] = []
  let firstSignal: number | undefined
  const adapter = acpCodexAdapter({
    link,
    binary: () => input.binary,
    workdir: () => ({ writes: input.writes, cwd: input.cwd }),
    title: () => 'ACP 对比自测',
    events: (event) => { events.push(event); log(`[ACP] 会话表:${event.type}${event.wait_reason === undefined ? '' : `(${event.wait_reason})`}`) },
    onChange: () => {
      const asks = adapter.asks()
      if (asks.length === 0) return
      const ask = asks[0]!
      firstSignal ??= Date.now()
      out.permissionAskedAtMs?.push(Date.now() - t0)
      log(`[ACP] 它在问:${ask.question} · 选项:${ask.options.map(one => one.label).join(' / ')}`)
      log(`[ACP] 原文:${(ask.full?.question ?? '').replace(/\n/g, ' ⏎ ')}`)
      if (input.answer === 'none') { log('[ACP] (--answer none:不答,看它等)'); return }
      const label = acpOptionLabel(input.answer) ?? input.answer
      setTimeout(() => {
        void adapter.run({ id: 'press', family: 'codex', kind: 'press', target: { kind: 'session', sessionId: ask.session_id }, text: label, expect: 'none' })
          .then((pressed) => {
            out.answeredAtMs?.push(Date.now() - t0)
            log(`[ACP] 替她答了「${label}」→ ${pressed.delivered}${pressed.why === undefined ? '' : ` · ${pressed.why}`}`)
          })
      }, input.answerAfterMs)
    },
    warn: line => log(`[ACP] ${line}`),
  })

  log('[ACP] 起进程 + 握手…')
  const caps = await adapter.capabilities()
  out.handshakeMs = Date.now() - t0
  log(`[ACP] 握手 ${out.handshakeMs}ms · 能力:${JSON.stringify(caps)}`)
  if (!caps.send) {
    out.why = '握手没过(stderr 见下)'
    out.stderrLines = stderr.length
    link.close()
    return out
  }
  const before = new Set(readdirSync(input.cwd))
  const job: Job = { id: 'probe-acp', family: 'codex', kind: 'dispatch', target: { kind: 'new' }, text: input.text, expect: 'reply', cwd: input.cwd, itemId: 'probe' }
  /** 第一个字:读 `read` 看 chunks 的笨办法太重;这里按会话表「在跑」之后第一次 asks/首个 agent_message_chunk 近似 —— 用 read 轮询。 */
  const t1 = Date.now()
  const result = adapter.run(job)
  const poll = setInterval(() => {
    void (async () => {
      const sessionId = events.find(one => one.type === 'running')?.session_id
      if (sessionId === undefined) return
      const got = await adapter.read!({ ...job, target: { kind: 'session', sessionId } })
      if (out.firstSignalMs === undefined && (got.busy === true || got.reply !== undefined)) out.firstSignalMs = Date.now() - t1
      if (out.firstTextMs === undefined && got.reply !== undefined) out.firstTextMs = Date.now() - t1
    })()
  }, 250)
  const done = await result
  clearInterval(poll)
  out.totalMs = Date.now() - t1
  out.delivered = done.delivered
  if (done.reply !== undefined) out.reply = done.reply
  if (done.why !== undefined) out.why = done.why
  if (done.sessionId !== undefined) out.sessionId = done.sessionId
  if (firstSignal !== undefined) out.firstSignalMs = Math.min(out.firstSignalMs ?? Number.MAX_SAFE_INTEGER, firstSignal - t1)
  out.continuedAfterAnswer = (out.answeredAtMs?.length ?? 0) > 0 && done.reply !== undefined
  out.fileMade = fileMade(input.cwd, before)
  out.stderrLines = stderr.length
  log(`[ACP] 结局:${done.delivered} · 回话:${(done.reply ?? '(无)').slice(0, 120).replace(/\n/g, ' ⏎ ')}${done.why === undefined ? '' : ` · ${done.why}`}`)
  writeFileSync(join(input.logsDir, 'codex-acp.stderr.log'), stderr.join('\n'))
  link.close()
  return out
}

async function runAppServer(input: { cwd: string, text: string, binary: string, writes: boolean }): Promise<Numbers> {
  const out: Numbers = { route: 'appserver', permissionAskedAtMs: [], answeredAtMs: [] }
  const t0 = Date.now()
  const link = codexAppServerLink({ clientName: 'probe-acp-compare', spawnPeer: () => spawnCodexAppServerPeer(input.binary) })
  const adapter = codexAdapter({
    link,
    binary: () => input.binary,
    workdir: () => ({ writes: input.writes, cwd: input.cwd }),
    title: () => 'app-server 对比自测',
    warn: line => log(`[app-server] ${line}`),
  })
  log('[app-server] 起进程 + 握手…')
  const caps = await adapter.capabilities()
  out.handshakeMs = Date.now() - t0
  log(`[app-server] 握手 ${out.handshakeMs}ms · 能力:${JSON.stringify(caps)}`)
  if (!caps.send) { out.why = '握手没过'; link.close(); return out }
  // 它反过来要批准的那几问:共用客户端一律 decline(今天的路就是这样);这里数一数来了几次。
  const connection = await link.open()
  connection.watch((note) => {
    if (note.method === 'turn/started') out.firstSignalMs ??= Date.now() - t1
    if (note.method === 'item/completed' && out.firstTextMs === undefined) {
      const item = note.params.item as { type?: string } | undefined
      if (item?.type === 'agentMessage') out.firstTextMs = Date.now() - t1
    }
    if (note.method === 'item/started' || note.method === 'item/completed') {
      const item = note.params.item as { type?: string, status?: string } | undefined
      if (item?.type === 'commandExecution' || item?.type === 'fileChange') log(`[app-server] 它做了一步:${item.type} ${item.status ?? ''}`)
    }
  })
  const before = new Set(readdirSync(input.cwd))
  const t1 = Date.now()
  const job: Job = { id: 'probe-appserver', family: 'codex', kind: 'dispatch', target: { kind: 'new' }, text: input.text, expect: 'reply', cwd: input.cwd, itemId: 'probe' }
  const done = await adapter.run(job)
  out.totalMs = Date.now() - t1
  out.delivered = done.delivered
  if (done.reply !== undefined) out.reply = done.reply
  if (done.why !== undefined) out.why = done.why
  if (done.sessionId !== undefined) out.sessionId = done.sessionId
  out.fileMade = fileMade(input.cwd, before)
  log(`[app-server] 结局:${done.delivered} · 回话:${(done.reply ?? '(无)').slice(0, 120).replace(/\n/g, ' ⏎ ')}${done.why === undefined ? '' : ` · ${done.why}`}`)
  link.close()
  return out
}

async function main(): Promise<void> {
  const binary = findCodexBinary(process.env.PATH, existsSync)
  if (binary === undefined) { console.error('这台机器上找不到 codex(PATH 上没有,ChatGPT.app 自带的那份也没有)'); process.exit(1) }
  const text = arg('text', '在这个目录新建 hello.txt,写一句问候。做完只回一句话说明做了什么。') as string
  const only = arg('only', undefined)
  const answer = arg('answer', 'allow_once') as string
  const answerAfterMs = Number(arg('answer-after', '3')) * 1000
  const writes = !process.argv.includes('--readonly')
  const base = arg('cwd', undefined) ?? join(tmpdir(), `acp-compare-${Date.now()}`)
  const logsDir = join(base, '.logs')
  const numbers: Numbers[] = []
  console.log(`二进制:${binary}\n目录:${base}\n交代:${text}\n权限档:${writes ? 'workspace-write(卡许改文件)' : 'read-only(卡不许改文件)'}\n`)
  if (only !== 'appserver') {
    const cwd = join(base, 'acp')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    numbers.push(await runAcp({ cwd, text, answer, answerAfterMs, binary, logsDir, writes }))
  }
  if (only !== 'acp') {
    const cwd = join(base, 'appserver')
    mkdirSync(cwd, { recursive: true })
    numbers.push(await runAppServer({ cwd, text, binary, writes }))
  }
  console.log('\n=== 对比(毫秒) ===')
  console.log(JSON.stringify(numbers, null, 2))
  process.exit(0)
}

void main().catch((error) => { console.error(error); process.exit(1) })
