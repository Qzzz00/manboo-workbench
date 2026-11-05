// @vitest-environment node
/**
 * 本机房间服务的交付链路(局域网主路卡 M1,2026-10-21):取包、出安装包、发热更新、本机闸。
 *
 * - `deploy/fetch-livekit.sh` 真跑两条(读 paths.ts、坏包被拒);下真 bottle 那一条不在用例里(要上 ghcr.io),在交接的沙箱演练里;
 * - `deploy/publish-update.sh` 与 `deploy/build-installer.sh` **一次都不真跑**(会构建、会推公网),只按正文断言形状;
 *   唯一真跑的是 `--skip-livekit-check` 没给理由那一条(参数解析那一行就退出);
 * - `deploy/local-install-gate.sh` 在沙箱里真跑:假的自带 node、假 launchctl、这个进程里起的假 8791 与假「本机房间」。
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DSH_LAUNCHD_LABEL, LIVEKIT_BOTTLE_SHA256, LIVEKIT_SERVER_SHA256 } from '../src/server/setup/paths.ts'
import { REPO_ROOT, installerScriptFiles, updateScriptFiles } from './helpers/shippedScripts.ts'

const FETCH = join(REPO_ROOT, 'deploy', 'fetch-livekit.sh')
const PUBLISH = join(REPO_ROOT, 'deploy', 'publish-update.sh')
const BUILD = join(REPO_ROOT, 'deploy', 'build-installer.sh')
const GATE = join(REPO_ROOT, 'deploy', 'local-install-gate.sh')
const 取包脚本 = readFileSync(FETCH, 'utf8')
const 发版脚本 = readFileSync(PUBLISH, 'utf8')
const 出包脚本 = readFileSync(BUILD, 'utf8')
const 闸脚本 = readFileSync(GATE, 'utf8')
const 热更新装法 = readFileSync(join(REPO_ROOT, 'workbench-plugin/src/server/update/apply.ts'), 'utf8')

const PREFIX = join(tmpdir(), 'wb-livekit-deploy-')
const boxes: string[] = []
const servers: Server[] = []
afterAll(async () => {
  while (servers.length) await new Promise<void>((resolve) => { servers.pop()?.close(() => resolve()) })
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(PREFIX) || box.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${box}`)
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function newDir(): string {
  const dir = mkdtempSync(PREFIX)
  boxes.push(dir)
  return dir
}

function put(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}

describe('fetch-livekit.sh', () => {
  it('语法过;版本与两个 sha 只从 paths.ts 读(脚本里一个 sha 都不抄)', () => {
    expect(spawnSync('bash', ['-n', FETCH]).status).toBe(0)
    expect(取包脚本).toContain('m.LIVEKIT_BOTTLE_SHA256')
    expect(取包脚本).toContain('m.LIVEKIT_SERVER_SHA256')
    expect(取包脚本).not.toContain(LIVEKIT_BOTTLE_SHA256)
    expect(取包脚本).not.toContain(LIVEKIT_SERVER_SHA256)
    // 两道都核,不对就 die;下下来的东西先进新建的空目录。
    expect(取包脚本).toContain('mktemp -d')
    expect(取包脚本.match(/对不上/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('★给它一份 sha 对不上的包:拒,一个文件都不放出去', () => {
    const dir = newDir()
    const bad = join(dir, 'bad.tar.gz')
    writeFileSync(bad, '不是那一份')
    const into = join(dir, 'into')
    const got = spawnSync('bash', [FETCH, '--into', into, '--bottle', bad], { encoding: 'utf8', env: { ...process.env, TMPDIR: dir } })
    expect(got.status).not.toBe(0)
    expect(`${got.stdout}${got.stderr}`).toContain('对不上')
    expect(existsSync(into)).toBe(false)
  })
})

describe('出安装包、发热更新:带上本机通话服务', () => {
  it('安装包:取包脚本放进 payload 并重签;启动脚本与开机自启模板一起收', () => {
    expect(出包脚本).toContain('bash "$REPO_ROOT/deploy/fetch-livekit.sh" --into "$PAYLOAD" --sign "$SIGN_ID"')
    expect(出包脚本).toContain('[ -x "$PAYLOAD/livekit/livekit-server" ]')
    expect(出包脚本).toContain('$PAYLOAD/livekit/NOTICE')
    expect(installerScriptFiles()).toEqual(expect.arrayContaining(['deploy/livekit-start', 'deploy/ai.deepseek.livekit.plist']))
  })

  it('热更新:scripts.tgz 带上那两份;`--with livekit` 出 livekit.tgz,名字与 apply.ts 下下来那个名字一样', () => {
    expect(updateScriptFiles()).toEqual(expect.arrayContaining(['deploy/livekit-start', 'deploy/ai.deepseek.livekit.plist']))
    expect(发版脚本).toContain('if want livekit; then')
    expect(发版脚本).toContain('bash "$REPO_ROOT/deploy/fetch-livekit.sh" --into "$LK_STAGE" --sign "$SIGN_ID"')
    // 解进 payload 之后:livekit/livekit-server(安装那一步找的位置)+ 它自己的启动脚本与模板。
    expect(发版脚本).toContain('tar -czf "$STAGE/livekit.tgz" -C "$LK_STAGE" livekit deploy/livekit-start deploy/ai.deepseek.livekit.plist')
    expect(发版脚本).toContain('livekit_tgz:livekit.tgz')
    expect(热更新装法).toContain("livekit_tgz: 'livekit.tgz'")
    // `--with all` 也带它(want 认 all)。
    expect(发版脚本).toContain('want() { case ",$WITH," in *,all,*) return 0')
  })

  it('★`--skip-livekit-check` 不给理由:拒,退出码非 0(参数解析那一行就停,一件都不构建)', () => {
    const got = spawnSync('bash', [PUBLISH, '--skip-livekit-check'], { encoding: 'utf8', timeout: 20_000 })
    expect(got.status).not.toBe(0)
    expect(`${got.stdout}${got.stderr}`).toContain('理由')
    // 给了理由就原样递给闸。
    expect(发版脚本).toContain('${SKIP_LIVEKIT_WHY:+--skip-livekit "$SKIP_LIVEKIT_WHY"}')
  })
})

/* ─────────────────────────── 本机闸:第 5 下,本机房间 ─────────────────────────── */

interface GateBox { home: string, dsh: string, tgz: string }

function gateBox(options: { livekit?: boolean, port?: number } = {}): GateBox {
  const home = newDir()
  const dsh = join(home, '.dsh')
  put(join(dsh, 'packages', 'plugin.tgz'), '旧的')
  put(join(dsh, 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n', 0o755)
  put(join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export {}\n')
  put(join(home, 'Library', 'LaunchAgents', `${DSH_LAUNCHD_LABEL}.plist`), '<plist/>\n')
  put(join(home, '假launchctl'), '#!/bin/sh\nexit 0\n', 0o755)
  if (options.livekit === true) {
    put(join(dsh, 'livekit', 'livekit-server'), '#!/bin/sh\n', 0o755)
    if (options.port !== undefined) put(join(dsh, 'livekit', 'livekit.yaml'), `port: ${options.port}\n`, 0o600)
  }
  const tgz = join(home, '新的.tgz')
  put(tgz, '新的')
  return { home, dsh, tgz }
}

async function serve(handler: (path: string) => { code: number, body: string }): Promise<number> {
  const server = createServer((req, res) => {
    const got = handler((req.url ?? '/').split('?')[0] as string)
    res.writeHead(got.code, { 'content-type': 'application/json' })
    res.end(got.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  return (server.address() as { port: number }).port
}

async function fake8791(): Promise<string> {
  const port = await serve(path => (path === '/update/check'
    ? { code: 200, body: JSON.stringify({ current: '9.9.9', available: false }) }
    : path === '/state' ? { code: 200, body: '{"ok":true}' } : { code: 404, body: '{}' }))
  return `http://127.0.0.1:${port}`
}

/** 一个一定没人听的口(listen 0 拿到再关掉)。 */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  return port
}

async function runGate(b: GateBox, base: string, extra: readonly string[] = []): Promise<{ status: number | null, out: string }> {
  const child = spawn('bash', [
    GATE, '--tgz', b.tgz, '--version', '9.9.9', '--dsh-home', b.dsh, '--base', base,
    '--launchctl', join(b.home, '假launchctl'), '--settle', '0', '--poll', '0', '--wait', '10',
    // 第 0 下(网页端能加载)与第 4½ 下(再盯两分钟)有自己的用例(release-gate.test.ts 末尾);这里的包是假的。
    '--watch', '0', '--no-web-check', ...extra,
  ], { cwd: b.home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: b.home, TMPDIR: b.home } })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  return { status, out }
}

describe('本机闸:本机房间回 200', () => {
  it('缺省地址按 livekit.yaml 的 port 定(读不到就 7880);这一下排在 /state 之后、记账之前', () => {
    expect(闸脚本).toContain('LIVEKIT_URL="http://127.0.0.1:${LK_PORT:-7880}"')
    const lines = 闸脚本.split('\n')
    const at = (needle: string): number => lines.findIndex(line => !line.trimStart().startsWith('#') && line.includes(needle))
    expect(at('say "5. 本机房间')).toBeGreaterThan(at('"$BASE/state"'))
    expect(at('say "6. 记一行账')).toBeGreaterThan(at('say "5. 本机房间'))
  })

  it('★装了、在:过,并打出「本机房间 200」', async () => {
    const lk = await serve(() => ({ code: 200, body: 'OK' }))
    const b = gateBox({ livekit: true, port: lk })
    const got = await runGate(b, await fake8791())
    expect(got.status, got.out).toBe(0)
    expect(got.out).toContain(`http://127.0.0.1:${lk}`)
    expect(got.out).toContain('本机房间 200')
  }, 90_000)

  it('★装了、没答:非 0,说清楚插件不用回退、本机房间去哪查', async () => {
    const b = gateBox({ livekit: true, port: await closedPort() })
    const got = await runGate(b, await fake8791(), ['--livekit-wait', '1'])
    expect(got.status).not.toBe(0)
    expect(got.out).toContain('本机房间没答')
    expect(got.out).toContain('不用回退')
    expect(got.out).toContain('ai.deepseek.livekit')
    expect(got.out).toContain('没推')
  }, 90_000)

  it('没装:跳过这一下,如实说一句,闸照过', async () => {
    const b = gateBox()
    const got = await runGate(b, await fake8791())
    expect(got.status, got.out).toBe(0)
    expect(got.out).toContain('还没装本机通话服务')
  }, 90_000)

  it('`--skip-livekit "<理由>"`:跳过并原样打出理由;不给理由就拒', async () => {
    const b = gateBox({ livekit: true, port: await closedPort() })
    const got = await runGate(b, await fake8791(), ['--skip-livekit', '沙箱演练'])
    expect(got.status, got.out).toBe(0)
    expect(got.out).toContain('沙箱演练')
    const bad = await runGate(b, await fake8791(), ['--skip-livekit'])
    expect(bad.status).not.toBe(0)
    expect(bad.out).toContain('理由')
  }, 90_000)
})
