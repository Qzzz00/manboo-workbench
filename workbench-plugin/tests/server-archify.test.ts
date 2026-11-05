import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archifyAssetRootFrom, createArchifyService, type ArchifyService } from '../src/server/archify.ts'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

let tempHome: string
let service: ArchifyService

beforeEach(() => {
  tempHome = join(tmpdir(), `archify-test-home-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tempHome, { recursive: true })
  service = createArchifyService({
    homeDir: tempHome,
    repoRoot: REPO_ROOT,
  })
})

afterEach(() => {
  if (existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

describe('Archify 服务与安全路由', () => {
  it('1. desktop-workbench 项目默认承接五张已验钉c55的架构图产物，并标明来源', async () => {
    const status = await service.status('desktop-workbench')
    expect(status.hasDiagrams).toBe(true)
    expect(status.pinnedCommit).toContain('c55')
    expect(status.sourceNote).toContain('c55')
    expect(status.diagrams.length).toBe(5)
    
    const ids = status.diagrams.map(d => d.id)
    expect(ids).toContain('architecture-runtime')
    expect(ids).toContain('tree-repo')
    expect(ids).toContain('sequence-call')
    expect(ids).toContain('sequence-video')
    expect(ids).toContain('lifecycle-card')

    // 每一张均带 html 与 spec
    for (const d of status.diagrams) {
      expect(d.hasHtml).toBe(true)
      expect(d.hasSpec).toBe(true)
    }
  })

  it('2. DouDou 等其他项目不串用 desktop-workbench 的五图，缺图如实返回 hasDiagrams: false', async () => {
    const status = await service.status('doudou')
    expect(status.hasDiagrams).toBe(false)
    expect(status.diagrams).toEqual([])
  })

  it('3. readView 读取架构图静态页面', async () => {
    const res = await service.readView('desktop-workbench', 'architecture-runtime.html')
    expect(res.found).toBe(true)
    expect(res.contentType).toBe('text/html; charset=utf-8')
    expect(res.content?.toString('utf8')).toContain('<!DOCTYPE html>')
    expect(res.content?.toString('utf8')).toContain('archify 3.2.0')
  })

  it('4. 安全边界防越界(路径遍历、恶意文件名、非法字符)一律拒绝', async () => {
    // 路径遍历
    expect((await service.readView('desktop-workbench', '../../secret.txt')).found).toBe(false)
    expect((await service.readView('desktop-workbench', '..%2f..%2fsecret.txt')).found).toBe(false)
    expect((await service.readView('desktop-workbench', '/etc/passwd')).found).toBe(false)
    // 非法文件名后缀
    expect((await service.readView('desktop-workbench', 'bad.exe')).found).toBe(false)
    expect((await service.readView('desktop-workbench', 'script.sh')).found).toBe(false)
    // 非法 projectId
    expect((await service.readView('../etc', 'architecture-runtime.html')).found).toBe(false)
    expect((await service.readView('desktop/workbench', 'architecture-runtime.html')).found).toBe(false)
  })

  it('5. readSpec 提供给 Agent 结构化规格与源码引用，无需塞大份 HTML', async () => {
    const res = await service.readSpec('desktop-workbench', 'architecture-runtime')
    expect(res.found).toBe(true)
    const spec = res.spec as any
    expect(spec.schema_version).toBe(1)
    expect(spec.diagram_type).toBe('architecture')
    expect(spec.meta.title).toContain('运行时总览')
    expect(spec.meta.repository.revision).toContain('c55')
    expect(spec.components).toBeDefined()
    expect(spec.connections).toBeDefined()
  })

  it('6. generate 能够基于合法 JSON 规范自校验并生成 HTML 产物，失败保留原版', async () => {
    // 使用一个小而合法的架构图 spec 为 doudou 生成
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

    const genResult = await service.generate('doudou', 'doudou-arch', 'architecture', doudouSpec)
    expect(genResult.ok).toBe(true)

    // 生成后查看 doudou 的 status
    const status = await service.status('doudou')
    expect(status.hasDiagrams).toBe(true)
    expect(status.diagrams.some(d => d.id === 'doudou-arch')).toBe(true)

    // 读取生成的 HTML
    const viewRes = await service.readView('doudou', 'doudou-arch.html')
    expect(viewRes.found).toBe(true)
    expect(viewRes.content?.toString('utf8')).toContain('DouDou · 架构简图')

    // 若生成非法规格，应该失败并保留原有的可用版本
    const badSpec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: {}, // 缺少必要字段
      nodes: 'invalid',
    }
    const failGen = await service.generate('doudou', 'doudou-arch', 'architecture', badSpec as any)
    expect(failGen.ok).toBe(false)

    // 原有的 HTML 仍然保留可用
    const stillThere = await service.readView('doudou', 'doudou-arch.html')
    expect(stillThere.found).toBe(true)
  })

  it('7. readView/readSpec 拒绝符号链接越出项目目录(realpath 校验)', async () => {
    const projectDir = join(tempHome, '.dsh', 'workbench', 'archify', 'linktest')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'inside.html'), '<!DOCTYPE html><p>inside</p>')
    // 项目目录外的真身:链接指过去必须被拒
    const outside = mkdtempSync(join(tmpdir(), 'archify-outside-'))
    writeFileSync(join(outside, 'secret.html'), '<!DOCTYPE html><p>secret</p>')
    symlinkSync(join(outside, 'secret.html'), join(projectDir, 'escape.html'))
    symlinkSync(join(outside, 'secret.html'), join(projectDir, 'escape.json'))

    const escaped = await service.readView('linktest', 'escape.html')
    expect(escaped.found).toBe(false)
    expect(escaped.error).toContain('符号链接')

    const escapedSpec = await service.readSpec('linktest', 'escape')
    expect(escapedSpec.found).toBe(false)

    // 目录内部的正常读取不受影响
    const inside = await service.readView('linktest', 'inside.html')
    expect(inside.found).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })

  it('8. status 对生成图如实给出生成时间,并从规格读出名称/类型/钉点', async () => {
    const demoSpec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: {
        title: '演示项目 · 架构图',
        output: 'demo-arch.html',
        quality_profile: 'showcase',
        locale: 'zh-CN',
      },
      components: [
        { id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50] },
      ],
      connections: [],
    }
    const before = Date.now()
    const gen = await service.generate('demo', 'demo-arch', 'architecture', demoSpec)
    expect(gen.ok).toBe(true)

    const status = await service.status('demo')
    expect(status.hasDiagrams).toBe(true)
    const diagram = status.diagrams.find(d => d.id === 'demo-arch')
    expect(diagram).toBeDefined()
    // 生成时间是真实文件时间,不是空的
    expect(typeof diagram?.generatedAt).toBe('number')
    expect(diagram!.generatedAt!).toBeGreaterThanOrEqual(before - 1000)
    expect(diagram!.generatedAt!).toBeLessThanOrEqual(Date.now() + 1000)
    // 名称/类型从规格 meta 读,不再恒等于 id / 'architecture'
    expect(diagram?.name).toBe('演示项目 · 架构图')
    expect(diagram?.type).toBe('architecture')

    // 钉点五图的 pinnedCommit 从规格 meta.repository.revision 读出来(仍含 c55)
    const pinned = await service.status('desktop-workbench')
    expect(pinned.pinnedCommit).toContain('c55')
    expect(pinned.diagrams.every(d => d.generatedAt !== undefined)).toBe(true)
  })
})

/** 假 Agent CLI:按约定往 ARCHIFY_SPEC_OUT 写规格(有效/无效/不写三种行为) */
function fakeAgentScript(behavior: 'valid' | 'invalid' | 'silent'): string {
  const spec = JSON.stringify({
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Agent 产物 · 架构图', output: 'agent-arch.html', quality_profile: 'showcase', locale: 'zh-CN' },
    components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50], sources: [{ path: 'README.md', line: 1 }] }],
    connections: [],
  })
  const body = behavior === 'valid'
    ? `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, ${JSON.stringify(spec)})`
    : behavior === 'invalid'
      ? `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, '{"schema_version":1,"meta":{}}')`
      : `/* 什么都不写,模拟 Agent 失败 */`
  const file = join(tempHome, `fake-agent-${behavior}.cjs`)
  writeFileSync(file, body)
  return file
}

describe('Archify 由 Agent 生成(generateWithAgent)', () => {
/** 造一个带 HEAD 提交与 origin 远端的真 git 项目(Agent 生成的官方校验需要 meta.repository 真值) */
function makeGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archify-agent-proj-'))
  const git = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  expect(git(['init']).status).toBe(0)
  expect(spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8' }).status).toBe(0)
  expect(git(['remote', 'add', 'origin', 'https://github.com/test-owner/demo.git']).status).toBe(0)
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  expect(git(['add', 'README.md']).status).toBe(0)
  expect(spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'readme'], { encoding: 'utf8' }).status).toBe(0)
  return dir
}


  it('9. Agent 写出合法规格 → 官方校验 → 原子落地,返回真实 diagramId', async () => {
    const projectDir = makeGitProject()
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [fakeAgentScript('valid')], timeoutMs: 20_000 },
    })

    const result = await agent.generateWithAgent({ projectId: 'demo' })
    expect(result.ok).toBe(true)
    expect(result.diagramId).toBe('demo-arch')
    expect(result.agent).toContain('node')

    const status = await agent.status('demo')
    const diagram = status.diagrams.find(d => d.id === 'demo-arch')
    expect(diagram?.name).toBe('Agent 产物 · 架构图')
    expect(typeof diagram?.generatedAt).toBe('number')

    const view = await agent.readView('demo', 'demo-arch.html')
    expect(view.found).toBe(true)
    expect(view.content?.toString('utf8')).toContain('Agent 产物 · 架构图')
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('10. Agent 写出非法规格 → 校验失败,保留上一次可用版', async () => {
    const projectDir = makeGitProject()
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [fakeAgentScript('valid')], timeoutMs: 20_000 },
    })
    // 先有一次成功生成(可用版)
    expect((await agent.generateWithAgent({ projectId: 'demo' })).ok).toBe(true)

    // 换一个只会写坏规格的 Agent
    const badAgent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [fakeAgentScript('invalid')], timeoutMs: 20_000 },
    })
    const failed = await badAgent.generateWithAgent({ projectId: 'demo' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeTruthy()

    // 旧版仍在,且内容没被破坏
    const view = await badAgent.readView('demo', 'demo-arch.html')
    expect(view.found).toBe(true)
    expect(view.content?.toString('utf8')).toContain('Agent 产物 · 架构图')
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('11. Agent 没写出规格/退出非零 → 如实失败,不造空图', async () => {
    const projectDir = makeGitProject()
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [fakeAgentScript('silent')], timeoutMs: 20_000 },
    })
    const failed = await agent.generateWithAgent({ projectId: 'demo' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeTruthy()

    const status = await agent.status('demo')
    expect(status.hasDiagrams).toBe(false)
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('12. desktop-workbench 五图有钉点,拒绝 Agent 覆盖;未知项目无路径也如实失败', async () => {
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      agentCli: { command: 'node', args: [fakeAgentScript('valid')], timeoutMs: 20_000 },
    })
    const pinned = await agent.generateWithAgent({ projectId: 'desktop-workbench' })
    expect(pinned.ok).toBe(false)
    expect(pinned.error).toContain('钉点')

    const unknown = await agent.generateWithAgent({ projectId: 'no-such-project' })
    expect(unknown.ok).toBe(false)
  })

  it('13. generate 的 --repo-root 按项目解析,不再一律本仓', async () => {
    const projectDir = makeGitProject()
    const logFile = join(tempHome, 'wrapper-log.jsonl')
    const wrapper = join(tempHome, 'archify-wrapper.mjs')
    // 包装一层真实 CLI,先记下 argv 再走原逻辑
    writeFileSync(wrapper, `
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.argv = [process.execPath, ${JSON.stringify(join(REPO_ROOT, 'third_party', 'archify', 'bin', 'archify.mjs'))}, ...process.argv.slice(2)]
await import(process.argv[1])
`)

    const routed = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      archifyBin: wrapper,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
    })
    const spec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '路由演示', output: 'routed.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50] }],
      connections: [],
    }
    const gen = await routed.generate('demo', 'routed', 'architecture', spec)
    expect(gen.ok).toBe(true)

    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const deliverCall = calls.find(args => args[0] === 'deliver')
    expect(deliverCall).toBeDefined()
    const repoRootIdx = deliverCall!.indexOf('--repo-root')
    expect(deliverCall![repoRootIdx + 1]).toBe(projectDir)

    // 未提供 projectPaths 时退回本仓兜底
    const fallback = createArchifyService({ homeDir: tempHome, repoRoot: REPO_ROOT, archifyBin: wrapper })
    expect((await fallback.generate('demo2', 'fb', 'architecture', { ...spec, meta: { ...spec.meta, title: '兜底', output: 'fb.html' } })).ok).toBe(true)
    const calls2 = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const fallbackCall = calls2.find(args => args[0] === 'deliver' && args.some(a => a.endsWith('fb.json')))
    expect(fallbackCall).toBeDefined()
    expect(fallbackCall![fallbackCall!.indexOf('--repo-root') + 1]).toBe(REPO_ROOT)
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('14. Agent 规格缺 meta.repository 时,服务端用项目 git 真值补上再校验', async () => {
    // 造一个真 git 项目(空提交即可拿 HEAD)
    const projectDir = mkdtempSync(join(tmpdir(), 'archify-agent-git-'))
    const git = (args: string[]) => spawnSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' })
    expect(git(['init']).status).toBe(0)
    expect(spawnSync('git', ['-C', projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8' }).status).toBe(0)
    expect(git(['remote', 'add', 'origin', 'https://github.com/test-owner/demo.git']).status).toBe(0)
    writeFileSync(join(projectDir, 'README.md'), '# demo\n')
    expect(git(['add', 'README.md']).status).toBe(0)
    expect(spawnSync('git', ['-C', projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'readme'], { encoding: 'utf8' }).status).toBe(0)
    const headSha = git(['rev-parse', 'HEAD']).stdout.trim()
    expect(headSha).toMatch(/^[0-9a-f]{40}$/)

    // 假 Agent 写一份**没有** meta.repository 的合法规格
    const noRepoSpec = JSON.stringify({
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: 'Git 补钉 · 架构图', output: 'git-arch.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50], sources: [{ path: 'README.md', line: 1 }] }],
      connections: [],
    })
    const agentScript = join(tempHome, 'fake-agent-norepo.cjs')
    writeFileSync(agentScript, `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, ${JSON.stringify(noRepoSpec)})`)
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [agentScript], timeoutMs: 20_000 },
    })
    const result = await agent.generateWithAgent({ projectId: 'demo' })
    expect(result.ok).toBe(true)

    // 落地的规格里 repository.revision 就是项目真 HEAD(diagramId 默认 demo-arch)
    const specRes = await agent.readSpec('demo', 'demo-arch')
    expect(specRes.found).toBe(true)
    const spec = specRes.spec as any
    expect(spec.meta.repository.revision).toBe(headSha)
    rmSync(projectDir, { recursive: true, force: true })
  })
  it('15. 首轮规格不过校验时,校验诊断回喂 Agent 修一轮再交付', async () => {
    const projectDir = makeGitProject()
    const validSpec = JSON.stringify({
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '修复轮 · 架构图', output: 'fix.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50], sources: [{ path: 'README.md', line: 1 }] }],
      connections: [],
    })
    // 有状态的假 Agent:第一次写坏规格(type 自造),第二次写好的
    const marker = join(tempHome, 'repair-marker')
    const agentScript = join(tempHome, 'fake-agent-repair.cjs')
    writeFileSync(agentScript, `
const fs = require('node:fs')
const valid = ${JSON.stringify(validSpec)}
const invalid = JSON.stringify({ schema_version: 1, diagram_type: 'architecture', meta: { title: '坏', output: 'fix.html', quality_profile: 'showcase', locale: 'zh-CN' }, components: [{ id: 'a', label: '甲', type: '自造类型', sources: [{ path: 'README.md', line: 1 }] }], connections: [] })
if (fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(process.env.ARCHIFY_SPEC_OUT, valid) }
else { fs.writeFileSync(${JSON.stringify(marker)}, '1'); fs.writeFileSync(process.env.ARCHIFY_SPEC_OUT, invalid) }
`)
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [agentScript], timeoutMs: 20_000 },
    })
    const result = await agent.generateWithAgent({ projectId: 'demo' })
    expect(result.ok).toBe(true)
    const view = await agent.readView('demo', 'demo-arch.html')
    expect(view.found).toBe(true)
    expect(view.content?.toString('utf8')).toContain('修复轮 · 架构图')
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('16. Agent 不写坐标时,服务端按连接拓扑分层布局后交付(官方渲染器无自动布局)', async () => {
    const projectDir = makeGitProject()
    // 无 pos/size 的规格:连边 a→b→c 应分成三层
    const bareSpec = JSON.stringify({
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '分层布局 · 架构图', output: 'bare.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [
        { id: 'ui', label: '界面层', type: 'frontend', sources: [{ path: 'README.md', line: 1 }] },
        { id: 'svc', label: '服务层', type: 'backend' },
        { id: 'store', label: '存储层', type: 'database' },
      ],
      connections: [
        { from: 'ui', to: 'svc', label: '请求' },
        { from: 'svc', to: 'store', label: '读写' },
      ],
    })
    const agentScript = join(tempHome, 'fake-agent-bare.cjs')
    writeFileSync(agentScript, `require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, ${JSON.stringify(bareSpec)})`)
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [agentScript], timeoutMs: 20_000 },
    })
    const result = await agent.generateWithAgent({ projectId: 'demo' })
    expect(result.ok).toBe(true)

    // 落地的规格带分层布局:ui 第 0 行,store 第 2 行,layout.mode=grid
    const specRes = await agent.readSpec('demo', 'demo-arch')
    const spec = specRes.spec as any
    expect(spec.layout.mode).toBe('grid')
    const byId = Object.fromEntries(spec.components.map((c: any) => [c.id, c]))
    expect(byId.ui.row).toBe(0)
    expect(byId.svc.row).toBe(1)
    expect(byId.store.row).toBe(2)
    // 画布按网格占地放大(否则官方构图检查报 extends outside the viewBox)
    expect(Array.isArray(spec.meta.viewBox)).toBe(true)
    expect(spec.meta.viewBox[0]).toBeGreaterThanOrEqual(700)
    expect(spec.meta.viewBox[1]).toBeGreaterThanOrEqual(240)
    const view = await agent.readView('demo', 'demo-arch.html')
    expect(view.found).toBe(true)
    expect(view.content?.toString('utf8')).toContain('分层布局 · 架构图')
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('17. Agent 运行期间服务保持响应(异步 spawn,不卡事件循环)', async () => {
    const projectDir = makeGitProject()
    // 假 Agent 先睡 2 秒再写规格 —— 这段时间里 status 必须能即时返回
    const slowAgent = join(tempHome, 'fake-agent-slow.cjs')
    writeFileSync(slowAgent, `
const spec = ${JSON.stringify(JSON.stringify({
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '慢 Agent', output: 'slow.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', sources: [{ path: 'README.md', line: 1 }] }],
      connections: [],
    }))}
setTimeout(() => { require('node:fs').writeFileSync(process.env.ARCHIFY_SPEC_OUT, spec) }, 2000)
`)
    const agent = createArchifyService({
      homeDir: tempHome,
      repoRoot: REPO_ROOT,
      projectPaths: async () => [{ id: 'demo', name: '演示', path: projectDir }],
      agentCli: { command: 'node', args: [slowAgent], timeoutMs: 20_000 },
    })
    const started = Date.now()
    const generating = agent.generateWithAgent({ projectId: 'demo' })
    // 给 Agent 起跑留出 300ms,然后 status 必须在远小于 2 秒内回来
    await new Promise(r => setTimeout(r, 300))
    const statusAt = Date.now()
    const status = await agent.status('demo')
    const statusMs = Date.now() - statusAt
    expect(status.hasDiagrams).toBe(false)
    expect(statusMs).toBeLessThan(1000)
    const result = await generating
    expect(result.ok).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('18. 安装包形态(repoRoot 下只有 lib/ 资产)工具链与五图可用,不靠仓库根', async () => {
    // 模拟 npm pack 解压后的包根:third_party/ 与 docs/ 都不在,只有 lib/ 里的随包资产
    const pkgRoot = mkdtempSync(join(tmpdir(), 'archify-pkg-'))
    const libDir = join(pkgRoot, 'lib')
    mkdirSync(join(libDir, 'third_party'), { recursive: true })
    cpSync(join(REPO_ROOT, 'third_party', 'archify'), join(libDir, 'third_party', 'archify'), { recursive: true })
    mkdirSync(join(libDir, 'archify-pinned'), { recursive: true })
    for (const name of readdirSync(join(REPO_ROOT, 'docs', '全景地图', 'archify'))) {
      if (/\.(html|json)$/.test(name) && !name.endsWith('.delivery.json')) {
        cpSync(join(REPO_ROOT, 'docs', '全景地图', 'archify', name), join(libDir, 'archify-pinned', name))
      }
    }
    const packaged = createArchifyService({ homeDir: tempHome, repoRoot: pkgRoot })

    // 五图 status/readView/readSpec 全部从包内 pinned 目录读出
    const status = await packaged.status('desktop-workbench')
    expect(status.hasDiagrams).toBe(true)
    expect(status.diagrams.length).toBe(5)
    expect(status.pinnedCommit).toContain('c55')
    const view = await packaged.readView('desktop-workbench', 'architecture-runtime.html')
    expect(view.found).toBe(true)
    expect(view.content?.toString('utf8')).toContain('archify 3.2.0')
    const spec = await packaged.readSpec('desktop-workbench', 'architecture-runtime')
    expect(spec.found).toBe(true)

    // 工具链从包内 lib 解析:真实生成走官方 CLI
    const gen = await packaged.generate('demo', 'pkg-arch', 'architecture', {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '包形态生成', output: 'pkg-arch.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50] }],
      connections: [],
    })
    expect(gen.ok).toBe(true)
    rmSync(pkgRoot, { recursive: true, force: true })
  })
})

describe('安装装配定位(archifyAssetRootFrom:从装配模块真实位置求资产基准)', () => {
  it('19. 编译安装形态(lib/index.js 位于包根/lib)锚到包根,源码检出形态锚到仓库根', () => {
    // 安装形态:pkg/lib/index.js + pkg/lib/third_party/archify(随包资产)
    const pkg = mkdtempSync(join(tmpdir(), 'archify-pkgshape-'))
    mkdirSync(join(pkg, 'lib', 'third_party', 'archify', 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs'), '// tool')
    writeFileSync(join(pkg, 'lib', 'index.js'), '// compiled entry')
    expect(archifyAssetRootFrom(pathToFileURL(join(pkg, 'lib', 'index.js')).href)).toBe(pkg)

    // 源码检出形态:repo/workbench-plugin/src/index.ts + repo/third_party/archify(仓库根)
    const repo = mkdtempSync(join(tmpdir(), 'archify-reposhape-'))
    mkdirSync(join(repo, 'third_party', 'archify', 'bin'), { recursive: true })
    writeFileSync(join(repo, 'third_party', 'archify', 'bin', 'archify.mjs'), '// tool')
    const srcDir = join(repo, 'workbench-plugin', 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'index.ts'), '// src entry')
    expect(archifyAssetRootFrom(pathToFileURL(join(srcDir, 'index.ts')).href)).toBe(repo)

    // 旧表达式('../..')在安装态锚到包父(@ben scope)——helper 不得选中它
    expect(archifyAssetRootFrom(pathToFileURL(join(pkg, 'lib', 'index.js')).href)).not.toBe(resolve(pkg, '..'))
    rmSync(pkg, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('20. 渲染兜底不删语义原件:去标签只作用于渲染,落地规格 JSON 保留全部连接名', async () => {
    const labeledSpec = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: '语义保全', output: 'sem.html', quality_profile: 'showcase', locale: 'zh-CN' },
      components: [
        { id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [200, 50] },
        { id: 'b', label: '乙', type: 'backend', pos: [20, 120], size: [200, 50] },
      ],
      connections: [{ from: 'a', to: 'b', label: '唯一关系名' }],
    }
    // specForRender 模拟兜底(渲染用去标签副本);落地规格必须是原件 —— 两侧都要能证:
    // 渲染产物 HTML 不含连接名(渲染确实用了副本),落地 JSON 含连接名(原件没丢)
    const strippedRender = {
      ...labeledSpec,
      connections: labeledSpec.connections.map(({ label: _label, ...rest }) => rest),
    }
    const gen = await service.generate('sem', 'sem', 'architecture', labeledSpec, { specForRender: strippedRender })
    expect(gen.ok).toBe(true)
    const html = (await service.readView('sem', 'sem.html')).content?.toString('utf8') ?? ''
    expect(html).not.toContain('唯一关系名')
    const landed = await service.readSpec('sem', 'sem')
    const landedSpec = landed.spec as any
    expect(landedSpec.connections[0].label).toBe('唯一关系名')
    expect(JSON.stringify(landedSpec)).toContain('唯一关系名')
    // 对照:不带 specForRender 时,渲染产物含连接名(证明断言本身有效)
    await service.generate('sem2', 'sem2', 'architecture', labeledSpec)
    const html2 = (await service.readView('sem2', 'sem2.html')).content?.toString('utf8') ?? ''
    expect(html2).toContain('唯一关系名')
  })
})
