// @vitest-environment node
/**
 * 命令行派活别继承死掉的代理地址(2026-09-25,卡 O 兜底;统筹:维护者 DSH 环境里带着
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`,来自 ~/.dsh/bin/dsh-start,以前 headroom 代理的地址,8787 上没人在听 ——
 * DSH 起的 `claude` 命令行全都连不上,他登录以后也一样)。钉住:
 * - 本机地址、连不上 → 起命令行时**只拿掉这一个变量**,别的 `ANTHROPIC_*` 一个不动;
 * - 本机地址、连得上 / 远端地址 → 原样(远端的去掉会带着给中转的令牌改道去官方,不替他改);
 * - 结论留一会儿(派活、体检、登录探查共用),探坏了当连不上,绝不抛;
 * - 体检「能改本机文件」那一格说人话;登录窗口那段脚本同一条规矩。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { agentCapFrom, loginScript } from '../src/server/agentCaps.ts'
import type { CapFacts } from '../src/server/agentCaps.ts'
import { cliEnvWith, createCliEnv, hostPort, parseBaseUrl, SHELL_DROP_DEAD_LOCAL_BASE_URL, shouldDrop, tcpProbe } from '../src/server/cliEnv.ts'

const servers: { close: () => void }[] = []
afterEach(() => { while (servers.length) servers.pop()?.close() })

/** 本机开一个端口(可选:回一句最小的 HTTP),回端口号。 */
async function listen(http = false): Promise<number> {
  const server = createServer((socket) => {
    if (http) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    else socket.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push({ close: () => server.close() })
  return (server.address() as AddressInfo).port
}

/** 一个此刻没人在听的本机端口(开了再关)。 */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

describe('认地址', () => {
  it('本机 / 远端、缺省端口、认不出的', () => {
    expect(parseBaseUrl('http://127.0.0.1:8787')).toEqual({ url: 'http://127.0.0.1:8787', host: '127.0.0.1', port: 8787, local: true })
    expect(parseBaseUrl('http://localhost:9000/v1')).toMatchObject({ host: 'localhost', port: 9000, local: true })
    expect(parseBaseUrl('http://[::1]:8787')).toMatchObject({ host: '::1', port: 8787, local: true })
    expect(parseBaseUrl('https://relay.example.com')).toMatchObject({ host: 'relay.example.com', port: 443, local: false })
    expect(parseBaseUrl('http://10.0.0.2')).toMatchObject({ port: 80, local: false })
    expect(parseBaseUrl('')).toBeUndefined()
    expect(parseBaseUrl('not a url')).toBeUndefined()
    expect(parseBaseUrl('ftp://127.0.0.1:21')).toBeUndefined()
    expect(hostPort({ host: '::1', port: 8787 })).toBe('[::1]:8787')
  })
})

describe('起命令行用的那份环境', () => {
  const base = { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' }

  it('★本机、连不上 → 只拿掉 ANTHROPIC_BASE_URL,别的 ANTHROPIC_* 原样', () => {
    const fact = { url: base.ANTHROPIC_BASE_URL, host: '127.0.0.1', port: 8787, local: true, reachable: false, at: 0 }
    const out = cliEnvWith(base, fact)
    expect(out.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' })
    expect(out.dropped).toBe(fact)
    expect(base.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
  })

  it('本机连得上 / 远端连不上 / 没这个变量 → 原样', () => {
    expect(cliEnvWith(base, { url: 'x', host: '127.0.0.1', port: 8787, local: true, reachable: true, at: 0 }).env).toBe(base)
    expect(shouldDrop({ url: 'x', host: 'relay.example.com', port: 443, local: false, reachable: false, at: 0 })).toBe(false)
    expect(cliEnvWith(base, { url: 'x', host: 'relay.example.com', port: 443, local: false, reachable: false, at: 0 }).env).toBe(base)
    expect(cliEnvWith({ PATH: '/usr/bin' }, undefined).env).toEqual({ PATH: '/usr/bin' })
  })

  it('探一次留 30 秒;过了再探;探坏了当连不上;环境里没有就不探', async () => {
    let t = 0
    const probes: string[] = []
    let answer: boolean | Error = false
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } as NodeJS.ProcessEnv
    const cli = createCliEnv({
      env: () => env,
      now: () => t,
      probe: async (host, port) => { probes.push(`${host}:${port}`); if (answer instanceof Error) throw answer; return answer },
    })
    expect((await cli.envFor()).env.ANTHROPIC_BASE_URL).toBeUndefined()
    t = 10_000
    await cli.envFor()
    expect(probes).toHaveLength(1)
    t = 40_001
    answer = true
    expect((await cli.envFor()).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(probes).toHaveLength(2)
    answer = new Error('boom')
    expect((await cli.check(true))?.reachable).toBe(false)
    delete env.ANTHROPIC_BASE_URL
    expect(await cli.check(true)).toBeUndefined()
    expect(cli.fact()).toBeUndefined()
  })

  it('真去连:开着的端口连得上,关了的连不上', async () => {
    expect(await tcpProbe('127.0.0.1', await listen(), 800)).toBe(true)
    expect(await tcpProbe('127.0.0.1', await deadPort(), 800)).toBe(false)
  })
})

describe('体检「能改本机文件」那一格', () => {
  const facts = (proxy: NonNullable<CapFacts['cli']['claude']>['proxy'], login: 'yes' | 'no' = 'yes'): CapFacts => ({
    installed: { claude: true },
    helper: { connected: true, authorized: true, newConversation: true, readReply: true },
    window: {},
    cli: { claude: { found: true, login, ...(proxy === undefined ? {} : { proxy }) } },
  })

  it('★本机那个没人在听的中转(那天的 127.0.0.1:8787):照常判,补一句说清派活时不带它', () => {
    const ok = agentCapFrom('claude', facts({ host: '127.0.0.1', port: 8787, local: true, reachable: false })).cells.edit
    expect(ok.state).toBe('ok')
    expect(ok.note).toContain('Claude 被设成先连一个本机中转(127.0.0.1:8787),那上面早就没人在听了')
    expect(ok.note).toContain('工作台派活时会绕开它,直接连 Claude,不用你管')
    const notLogged = agentCapFrom('claude', facts({ host: '127.0.0.1', port: 8787, local: true, reachable: false }, 'no')).cells.edit
    expect(notLogged).toMatchObject({ state: 'no', fix: { kind: 'login_cli' } })
    expect(notLogged.note).toContain('要让 Claude 直接改你电脑上的文件,还差一步:登录一次')
    expect(notLogged.note).toContain('127.0.0.1:8787')
  })

  it('远端的中转连不上 → 这一格「不行」,说是哪个地址、从哪带进来的', () => {
    const cell = agentCapFrom('claude', facts({ host: 'relay.example.com', port: 443, local: false, reachable: false })).cells.edit
    expect(cell.state).toBe('no')
    expect(cell.note).toContain('Claude 被设成先连一个中转,那个中转这会儿连不上(relay.example.com:443)')
    expect(cell.note).toContain('要懂的人来改(工作台不替你改),这之前写代码的活先交给别家')
  })

  it('★说得出这个地址从哪来的:系统每次登录时设进去的(launchctl)/ DSH 启动时带进来的', async () => {
    const launchd = agentCapFrom('claude', facts({ host: '127.0.0.1', port: 8787, local: true, reachable: false, source: 'launchd' })).cells.edit
    expect(launchd.note).toContain('这个设置是系统每次登录时设进去的(以前装的本机代理留下的开机项)')
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } as NodeJS.ProcessEnv
    const fromLaunchd = createCliEnv({ env: () => env, probe: async () => false, launchdGetenv: async () => 'http://127.0.0.1:8787\n' })
    expect((await fromLaunchd.check())?.source).toBe('launchd')
    const fromProcess = createCliEnv({ env: () => env, probe: async () => false, launchdGetenv: async () => undefined })
    expect((await fromProcess.check())?.source).toBe('process')
    const broken = createCliEnv({ env: () => env, probe: async () => false, launchdGetenv: async () => { throw new Error('x') } })
    expect((await broken.check())?.source).toBeUndefined()
  })

  it('中转连得上 / 没有中转 → 跟原来一样', () => {
    expect(agentCapFrom('claude', facts({ host: '127.0.0.1', port: 8787, local: true, reachable: true })).cells.edit.note).not.toContain('中转')
    expect(agentCapFrom('claude', facts(undefined)).cells.edit.note).not.toContain('中转')
  })
})

describe('登录窗口那段脚本', () => {
  it('Claude 的带着「本机那个死地址就拿掉」那一段,Codex 的不带', () => {
    expect(loginScript('claude', '/x/claude')).toContain(SHELL_DROP_DEAD_LOCAL_BASE_URL)
    expect(loginScript('claude', '/x/claude').indexOf('unset ANTHROPIC_BASE_URL')).toBeLessThan(loginScript('claude', '/x/claude').indexOf("'/x/claude' auth login"))
    expect(loginScript('codex', '/x/codex')).not.toContain('ANTHROPIC_BASE_URL')
  })

  it('★真跑那一段:本机死地址被拿掉;本机活地址、远端地址留着', async () => {
    const run = (url: string): string => spawnSync('/bin/zsh', ['-f', '-c', `${SHELL_DROP_DEAD_LOCAL_BASE_URL}\nprint -r -- "[$ANTHROPIC_BASE_URL]"`], {
      env: { PATH: '/usr/bin:/bin', ANTHROPIC_BASE_URL: url }, encoding: 'utf8', timeout: 10_000,
    }).stdout.trim()
    expect(run(`http://127.0.0.1:${await deadPort()}`)).toBe('[]')
    const live = `http://127.0.0.1:${await listen(true)}`
    expect(run(live)).toBe(`[${live}]`)
    expect(run('https://relay.example.invalid')).toBe('[https://relay.example.invalid]')
  })
})
