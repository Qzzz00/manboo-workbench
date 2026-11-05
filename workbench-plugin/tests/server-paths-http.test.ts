// @vitest-environment node
/**
 * 路径可配的 HTTP 层(2026-09-17 卡 C 第 5 条):
 * `GET /config/paths`(读默认值 + 配置值 + 生效值)、`PUT /config/paths`(改,只认回环、校验目录)、
 * `GET /config/hooks?agent=claude|codex`(渲染 hooks;卡 R 起命令只指钩子脚本的固定位置,不找仓库)。
 *
 * 同期另一张卡在做登录台的前端,它读写路径就走这三条口子——所以这里把"回什么形状"钉死。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { HOOK_SCRIPTS_ERRORS } from '../src/server/hookScripts.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

interface Changed { scan_roots?: unknown, inbox_dirs?: unknown, butler_cwd?: unknown }

async function serve(over: { envButlerCwd?: string, moduleDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-paths-http-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const realDir = join(dir, '真目录')
  mkdirSync(realDir)
  const realFile = join(dir, '不是目录.txt')
  writeFileSync(realFile, 'x')

  const config = createAppConfig({ file: join(dir, 'app.json') })
  const changes: Changed[] = []
  const remote = { address: LOOPBACK }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    remoteAddress: () => remote.address,
    paths: {
      config,
      home,
      ...(over.envButlerCwd === undefined ? {} : { envButlerCwd: over.envButlerCwd }),
      onChanged: (next) => { changes.push(next as Changed) },
      // 缺省不传 moduleDir:钩子脚本从这份 checkout 里的插件包同步(真的那一套),写只写进临时 HOME。
      ...(over.moduleDir === undefined ? {} : { moduleDir: over.moduleDir }),
    },
  })
  started.push(server)

  const call = async (path: string, init: { method?: string, body?: unknown, from?: string } = {}) => {
    remote.address = init.from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
  }
  const put = (body: unknown, from?: string) =>
    call('/config/paths', { method: 'PUT', body, ...(from === undefined ? {} : { from }) })
  return { call, put, home, realDir, realFile, changes, config }
}

describe('GET /config/paths', () => {
  it('没配过:三项是 null,defaults 与 effective 都是那套默认值', async () => {
    const { call, home } = await serve()
    const { status, body } = await call('/config/paths')
    expect(status).toBe(200)
    expect(body.scan_roots).toBeNull()
    expect(body.inbox_dirs).toBeNull()
    expect(body.butler_cwd).toBeNull()
    expect(body.defaults.scan_roots).toEqual([
      { path: `${home}/Documents/GitHub`, depth: 1 },
      { path: `${home}/Documents/Codex`, depth: 2 },
      { path: `${home}/WeChatProjects`, depth: 1 },
    ])
    expect(body.defaults.inbox_dirs).toEqual([`${home}/Downloads`, `${home}/Desktop`])
    expect(body.effective.scan_roots).toEqual(body.defaults.scan_roots)
    expect(body.effective.butler_cwd).toBeNull()
    expect(body.effective.butler_cwd_source).toBe('none')
  })

  it('环境变量里有事务官仓库:effective 用它,并说这一条来自 env', async () => {
    const { call } = await serve({ envButlerCwd: '/from/env' })
    const { body } = await call('/config/paths')
    expect(body.effective.butler_cwd).toBe('/from/env')
    expect(body.effective.butler_cwd_source).toBe('env')
  })
})

describe('PUT /config/paths', () => {
  it('改扫描根:落盘、回新的 effective、通知调用方重扫', async () => {
    const { put, realDir, changes, config } = await serve()
    const { status, body } = await put({ scan_roots: [{ path: realDir, depth: 2 }] })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.restart_required).toBe(false)
    expect(body.effective.scan_roots).toEqual([{ path: realDir, depth: 2 }])
    expect((await config.get()).scan_roots).toEqual([{ path: realDir, depth: 2 }])
    expect(changes).toHaveLength(1)
  })

  it('改收件箱目录:同样即时生效', async () => {
    const { put, realDir, changes } = await serve()
    const { body } = await put({ inbox_dirs: [realDir] })
    expect(body.effective.inbox_dirs).toEqual([realDir])
    expect(body.restart_required).toBe(false)
    expect(changes).toHaveLength(1)
  })

  it('改事务官仓库:回 restart_required 与一句说明(引导/授权/例程是启动时接线的)', async () => {
    const { put, realDir } = await serve()
    const { status, body } = await put({ butler_cwd: realDir })
    expect(status).toBe(200)
    expect(body.restart_required).toBe(true)
    expect(String(body.hint)).toContain('kickstart')
    expect(body.effective.butler_cwd).toBe(realDir)
    expect(body.effective.butler_cwd_source).toBe('app.json')
  })

  it('环境变量在的时候改 app.json:如实说明这次改动被环境变量压着,没有生效', async () => {
    const { put, realDir } = await serve({ envButlerCwd: '/from/env' })
    const { body } = await put({ butler_cwd: realDir })
    expect(body.effective.butler_cwd).toBe('/from/env')
    expect(body.effective.butler_cwd_source).toBe('env')
    expect(String(body.hint)).toContain('WORKBENCH_BUTLER_CWD')
  })

  it('目录不存在 → 400,一句人话点名是哪一条', async () => {
    const { put } = await serve()
    const { status, body } = await put({ inbox_dirs: ['/definitely/not/here'] })
    expect(status).toBe(400)
    expect(body.error).toBe('收件箱目录 /definitely/not/here 不存在')
  })

  it('路径是个文件不是目录 → 400', async () => {
    const { put, realFile } = await serve()
    const { status, body } = await put({ scan_roots: [{ path: realFile, depth: 1 }] })
    expect(status).toBe(400)
    expect(body.error).toBe(`扫描根 ${realFile} 不是一个目录`)
  })

  it('形状不对 → 400,错误来自纯函数层那句人话', async () => {
    const { put } = await serve()
    expect((await put({ scan_roots: [{ path: '/x', depth: 9 }] })).body.error).toBe('第 1 个扫描根的层数要在 1~3 之间')
    expect((await put({})).status).toBe(400)
  })

  it('校验没过时一个字都不落盘', async () => {
    const { put, config, changes } = await serve()
    await put({ inbox_dirs: ['/definitely/not/here'] })
    expect((await config.get()).inbox_dirs).toBeUndefined()
    expect(changes).toHaveLength(0)
  })

  it('只认回环:手机来的 403', async () => {
    const { put, realDir } = await serve()
    const { status } = await put({ inbox_dirs: [realDir] }, PHONE)
    expect(status).toBe(403)
  })

  it('body 不是 JSON → 400', async () => {
    const { call } = await serve()
    const res = await fetch(`${(started.at(-1) as WorkbenchServer).url}/config/paths`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ 不是 JSON',
    })
    expect(res.status).toBe(400)
    // 服务还活着,后面的请求照常。
    expect((await call('/config/paths')).status).toBe(200)
  })
})

describe('GET /config/hooks', () => {
  /** 这份 checkout 里插件包的 bin/(钩子脚本的来源)。 */
  const PACKAGE_BIN = fileURLToPath(new URL('../bin/', import.meta.url))

  it('claude:四条 + statusLine + 一段人话;★命令指这台机器上钩子脚本的固定位置,脚本已经放好', async () => {
    const { call, home } = await serve()
    const { status, body } = await call('/config/hooks?agent=claude')
    expect(status).toBe(200)
    expect(body.agent).toBe('claude')
    const dir = join(home, '.dsh', 'workbench', 'hooks')
    expect(body.hooks_dir).toBe(dir)
    expect(body.repo_root).toBeUndefined()
    expect(body.hooks.Stop[0].hooks[0].command).toBe(`${dir}/agent-hook.sh claude`)
    expect(body.statusLine.command).toBe(`${dir}/claude-statusline.sh`)
    expect(String(body.instructions)).toContain('~/.claude/settings.json')
    expect(String(body.instructions)).not.toContain('仓库')
    // 摆出来的命令指着的文件此刻就在,内容就是包里那一份。
    expect(readFileSync(`${dir}/agent-hook.sh`, 'utf8')).toBe(readFileSync(`${PACKAGE_BIN}agent-hook.sh`, 'utf8'))
  })

  it('codex:三条,没有 statusLine', async () => {
    const { call } = await serve()
    const { body } = await call('/config/hooks?agent=codex')
    expect(Object.keys(body.hooks)).toEqual(['Stop', 'UserPromptSubmit', 'SessionEnd'])
    expect(body.statusLine).toBeUndefined()
  })

  it('不带 agent 或写了别家 → 400', async () => {
    const { call } = await serve()
    expect((await call('/config/hooks')).status).toBe(400)
    expect((await call('/config/hooks?agent=kimi')).status).toBe(400)
  })

  it('★钩子脚本找不到来源(装得不完整)→ 503 一句人话,不拿一个猜的路径糊弄', async () => {
    const { call } = await serve({ moduleDir: '/nowhere/at/all' })
    const { status, body } = await call('/config/hooks?agent=claude')
    expect(status).toBe(503)
    expect(body.error).toBe(HOOK_SCRIPTS_ERRORS.no_source)
  })

  /**
   * 卡 R 的根因:原来「插件不在仓库里跑」时退回 butler_cwd 去找 `workbench-plugin/bin/agent-hook.sh`。
   * butler_cwd 是事务官的工作目录,不是仓库 —— 现在**完全不看它**:哪怕它里面恰好有一份,也不用。
   */
  it('★不看 butler_cwd:它里面哪怕真有一份 workbench-plugin/bin/agent-hook.sh,也不指过去', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'wb-paths-fake-repo-'))
    mkdirSync(join(fake, 'workbench-plugin', 'bin'), { recursive: true })
    writeFileSync(join(fake, 'workbench-plugin', 'bin', 'agent-hook.sh'), '#!/bin/sh\necho 冒牌\n')
    writeFileSync(join(fake, 'workbench-plugin', 'bin', 'claude-statusline.sh'), '#!/bin/sh\necho 冒牌\n')
    const { call, home } = await serve({ envButlerCwd: fake })
    const { status, body } = await call('/config/hooks?agent=claude')
    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain(fake)
    expect(body.hooks.Stop[0].hooks[0].command).toBe(`${join(home, '.dsh', 'workbench', 'hooks')}/agent-hook.sh claude`)
    expect(readFileSync(join(home, '.dsh', 'workbench', 'hooks', 'agent-hook.sh'), 'utf8')).not.toContain('冒牌')
  })
})

describe('没接 paths 时', () => {
  it('三条路由都 404,行为与改造前一样', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
    })
    started.push(server)
    expect((await fetch(`${server.url}/config/paths`)).status).toBe(404)
    expect((await fetch(`${server.url}/config/hooks?agent=claude`)).status).toBe(404)
  })
})
