// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createArchifyService } from '../src/server/archify.ts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archify-http-home-'))
  dirs.push(dir)
  return dir
}

async function startServerWithArchify(homeDir: string) {
  const service = createWorkbenchService()
  const archify = createArchifyService({
    homeDir,
    repoRoot: REPO_ROOT,
  })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    archify,
    tickIntervalMs: 0,
    heartbeatMs: 0,
  })
  started.push(server)
  return { server, archify, url: server.url }
}

function makeGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archify-http-git-'))
  const git = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (git(['init']).status !== 0) throw new Error('git init 失败')
  if (spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8' }).status !== 0) throw new Error('git commit 失败')
  if (git(['remote', 'add', 'origin', 'https://github.com/test-owner/demo.git']).status !== 0) throw new Error('git remote 失败')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git(['add', 'README.md'])
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'readme'], { encoding: 'utf8' })
  return dir
}

describe('Archify HTTP 路由 (GET /archify/status, /spec, /view, POST /archify/generate)', () => {
  it('1. GET /archify/status?project=desktop-workbench 返回 200 与五张已验钉 c55 的架构图', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/status?project=desktop-workbench`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.projectId).toBe('desktop-workbench')
    expect(data.hasDiagrams).toBe(true)
    expect(data.pinnedCommit).toContain('c55')
    expect(data.sourceNote).toContain('c55')
    expect(data.diagrams.length).toBe(5)
    expect(data.diagrams.map((d: any) => d.id)).toContain('architecture-runtime')
  })

  it('2. GET /archify/status?project=doudou 跨项目不串，返回 hasDiagrams: false', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/status?project=doudou`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.projectId).toBe('doudou')
    expect(data.hasDiagrams).toBe(false)
    expect(data.diagrams).toEqual([])
  })

  it('3. GET /archify/status 缺少 project 参数返回 400', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/status`)
    expect(res.status).toBe(400)
  })

  it('4. GET /archify/view/desktop-workbench/architecture-runtime.html 返回静态 HTML 产物', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/view/desktop-workbench/architecture-runtime.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('archify 3.2.0')
  })

  it('5. GET /archify/view 路径越界返回 404', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/view/desktop-workbench/../../secret.txt`)
    expect(res.status).toBe(404)
  })

  it('6. GET /archify/spec/desktop-workbench/architecture-runtime 返回给 Agent 结构化规范', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const res = await fetch(`${url}/archify/spec/desktop-workbench/architecture-runtime`)
    expect(res.status).toBe(200)
    const spec = await res.json() as any
    expect(spec.schema_version).toBe(1)
    expect(spec.diagram_type).toBe('architecture')
    expect(spec.meta.title).toContain('运行时总览')
    expect(spec.components).toBeDefined()
    expect(spec.connections).toBeDefined()
  })

  it('7. POST /archify/generate 生成并原子落地，更新项目状态与静态产物', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const doudouSpec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: {
        title: 'DouDou · 架构简图',
        output: 'doudou-arch.html',
        quality_profile: 'showcase',
        locale: 'zh-CN',
      },
      components: [
        { id: 'client', label: '客户端 UI', type: 'frontend', sublabel: 'DouDou 交互', pos: [20, 20], size: [120, 50] },
        { id: 'engine', label: '核心引擎', type: 'backend', sublabel: '任务调度', pos: [200, 20], size: [120, 50] },
      ],
      connections: [
        { from: 'client', to: 'engine', label: '请求' },
      ],
    }

    const postRes = await fetch(`${url}/archify/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'doudou',
        diagramId: 'doudou-arch',
        type: 'architecture',
        spec: doudouSpec,
      }),
    })
    expect(postRes.status).toBe(200)
    const genData = await postRes.json() as any
    expect(genData.ok).toBe(true)

    // 生成后查询 status
    const statusRes = await fetch(`${url}/archify/status?project=doudou`)
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json() as any
    expect(statusData.hasDiagrams).toBe(true)
    expect(statusData.diagrams.some((d: any) => d.id === 'doudou-arch')).toBe(true)

    // 可以访问刚生成的 HTML
    const viewRes = await fetch(`${url}/archify/view/doudou/doudou-arch.html`)
    expect(viewRes.status).toBe(200)
    const viewHtml = await viewRes.text()
    expect(viewHtml).toContain('DouDou · 架构简图')
  })

  it('8. POST /archify/generate 格式错误时返回 400 失败', async () => {
    const home = createTempHome()
    const { url } = await startServerWithArchify(home)

    const postRes = await fetch(`${url}/archify/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'doudou',
        diagramId: 'doudou-arch',
        type: 'architecture',
        spec: { invalid: 'spec' },
      }),
    })
    expect(postRes.status).toBe(400)
  })

  it('9. 未启用 archify 服务时返回 404', async () => {
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({
      port: 0,
      service,
      // archify 未传
      tickIntervalMs: 0,
      heartbeatMs: 0,
    })
    started.push(server)

    const res = await fetch(`${server.url}/archify/status?project=desktop-workbench`)
    expect(res.status).toBe(404)
  })

  it('10. POST /archify/generate-agent 由 Agent 生成并返回 diagramId', async () => {
    const home = createTempHome()
    const gitProject = makeGitProject()
    dirs.push(gitProject)
    const agentScript = join(home, 'fake-agent.cjs')
    const spec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: 'HTTP 接线 · 架构图', output: 'agent-arch.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50], sources: [{ path: 'README.md', line: 1 }] }],
      connections: [],
    }
    writeFileSync(agentScript, `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, ${JSON.stringify(JSON.stringify(spec))})`)
    const archify = createArchifyService({
      homeDir: home,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: gitProject }],
      agentCli: { command: 'node', args: [agentScript], timeoutMs: 20_000 },
    })
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({ port: 0, service, archify, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)

    const res = await fetch(`${server.url}/archify/generate-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'demo' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.diagramId).toBe('demo-arch')

    // 生成的图真实可访问
    const view = await fetch(`${server.url}/archify/view/demo/demo-arch.html`)
    expect(view.status).toBe(200)
    expect(await view.text()).toContain('HTTP 接线 · 架构图')
  })

  it('11. POST /archify/generate-agent 失败时如实 400 且不覆盖旧版', async () => {
    const home = createTempHome()
    const gitProject = makeGitProject()
    dirs.push(gitProject)
    const agentScript = join(home, 'fake-agent.cjs')
    const goodSpec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '可用版', output: 'agent-arch.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50], sources: [{ path: 'README.md', line: 1 }] }],
      connections: [],
    }
    // 先造一份可用版
    writeFileSync(agentScript, `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, ${JSON.stringify(JSON.stringify(goodSpec))})`)
    const archify = createArchifyService({
      homeDir: home,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: gitProject }],
      agentCli: { command: 'node', args: [agentScript], timeoutMs: 20_000 },
    })
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({ port: 0, service, archify, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)
    const okRes = await fetch(`${server.url}/archify/generate-agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'demo' }),
    })
    expect(okRes.status).toBe(200)

    // 换一个必失败的 Agent:直接让服务用不存在的 CLI
    const broken = createArchifyService({
      homeDir: home,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: gitProject }],
      agentCli: { command: 'node', args: [join(home, 'no-such-agent.cjs')], timeoutMs: 20_000 },
    })
    const server2 = await startWorkbenchServer({ port: 0, service, archify: broken, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server2)
    const badRes = await fetch(`${server2.url}/archify/generate-agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'demo' }),
    })
    expect(badRes.status).toBe(400)
    const badData = await badRes.json() as any
    expect(badData.error).toBeTruthy()

    // 旧版仍在
    const view = await fetch(`${server.url}/archify/view/demo/demo-arch.html`)
    expect(view.status).toBe(200)
    expect(await view.text()).toContain('可用版')
  })

  it('12. POST /archify/generate-agent 拒绝覆盖 desktop-workbench 钉点五图', async () => {
    const home = createTempHome()
    const archify = createArchifyService({ homeDir: home, repoRoot: REPO_ROOT })
    const service = createWorkbenchService()
    const server = await startWorkbenchServer({ port: 0, service, archify, tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)

    const res = await fetch(`${server.url}/archify/generate-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'desktop-workbench' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error).toContain('钉点')
  })
})
