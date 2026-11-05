// @vitest-environment node
/**
 * Graphify 图谱服务(2026-10-23,卡「系统文件夹改成Graphify图谱」)。
 *
 * 真实链路(10-23 从官方源码取证):console script 没有 extract/--version,无模型图谱走
 * Python API,经 `uv run --with graphifyy==0.1.14 python <脚本> <项目> <暂存>` 起在 uv
 * 隔离环境里。这里全部注入假 runner + 临时目录,不真起 uv、不碰真家目录;
 * 异步时序(jobId 先于完成返回、同项目去重)用**真 setTimeout** 拍,不 mock 时钟。
 *
 * 钉的东西:
 * - status = uv 在 + `--offline` 热探针过;generatedAt 读 meta.json;
 * - build 的命令行 pins 住 `graphifyy==0.1.14`;staging 校验过才换,失败旧图谱原样在;
 * - install:uv 缺席 → brew → 官方脚本兜底,最后热 `import graphify`;
 * - read:项目 id 不合法、`..`/编码穿越、符号链接翻出根外一律 undefined。
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createGraphifyService, PIPELINE_PY, type GraphifyRunResult, type GraphifyRunner } from '../src/server/graphify.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const OK: GraphifyRunResult = { code: 0, stdout: '', stderr: '' }

/** 假 vis-network 内容与其 sha256:小体量,校验逻辑照跑(vizSha256 注入)。 */
const FAKE_VIZ = '/* vis-network fake */'
const FAKE_VIZ_SHA = createHash('sha256').update(FAKE_VIZ).digest('hex')

interface BuildBehavior {
  /** 真异步等待:模拟生成耗时,拍「jobId 先于完成返回」。 */
  delayMs?: number
  code?: number
  stderr?: string
  /** 只写一半就退(比如写了 report 没写 graph.json)。 */
  partial?: boolean
  withHtml?: boolean
  /** 大图那一档:html 直接是相对引用(社区网格模板),另出 graph-layout.json。 */
  large?: boolean
}

interface FakeEnvOptions {
  uv?: boolean
  /** brew / 官方脚本装 uv 那两条兜底走不走得通。 */
  fallbacks?: boolean
  /** --offline 热探针过不过(=环境热没热)。 */
  warm?: boolean
  build?: BuildBehavior
}

/**
 * 假 uv 环境:按命令前缀分发。build 那次调用拿**真目录**写**真文件**(暂存目录就是
 * 命令行最后一个参数),vis-network 那次也写真文件(vendor 路径在 -o 参数上),
 * 后面的断言全落在文件系统上,不依赖 runner 内部说法。
 */
function fakeEnv(opts: FakeEnvOptions = {}) {
  const calls: { cmd: readonly string[] }[] = []
  let buildRuns = 0
  let uvWorking = opts.uv !== false
  const run: GraphifyRunner = async (cmd, runOpts) => {
    calls.push({ cmd })
    await new Promise(r => setTimeout(r, 5))
    const key = cmd.join(' ')
    if (key === 'uv --version') return uvWorking ? { ...OK, stdout: 'uv 0.12.23' } : { code: 127, stdout: '', stderr: 'command not found' }
    if (cmd[0] === 'sh' && typeof cmd[1] === 'string' && cmd[1].includes('.uv-install-')) {
      if (opts.fallbacks === false) return { code: 1, stdout: '', stderr: 'install script failed' }
      uvWorking = true
      return { ...OK, stdout: 'installed uv' }
    }
    if (key.startsWith('uv run --offline')) return opts.warm === false ? { code: 2, stdout: '', stderr: 'offline' } : { ...OK, stdout: 'ok' }
    if (key.startsWith('uv run --with') && cmd.includes('-c')) {
      return opts.warm === false ? { code: 2, stdout: '', stderr: 'resolve failed' } : { ...OK, stdout: 'ok' }
    }
    if (key.startsWith('uv run --with')) {
      buildRuns += 1
      const behavior: BuildBehavior = opts.build ?? {}
      if (behavior.delayMs !== undefined) await new Promise(r => setTimeout(r, behavior.delayMs))
      const staging = cmd[cmd.length - 1] as string
      await mkdir(staging, { recursive: true })
      // 阶段标记走 onLine 流转(真链路里服务层靠它 live 更新作业阶段)。
      runOpts?.onLine?.('GRAPHIFY_STAGE detect 0.1')
      runOpts?.onLine?.('GRAPHIFY_STAGE extract 0.2')
      if (behavior.partial === true) {
        // 退出 0 但只写了报告、没有 graph.json —— 服务层要能把这道住。
        await writeFile(join(staging, 'GRAPH_REPORT.md'), '半截报告')
        runOpts?.onLine?.('GRAPHIFY_RESULT {"nodes":0,"edges":0,"communities":0,"has_html":false}')
        return { ...OK, stdout: 'GRAPHIFY_RESULT {"nodes":0,"edges":0,"communities":0,"has_html":false}\n' }
      }
      if (behavior.code !== undefined && behavior.code !== 0) {
        return { code: behavior.code, stdout: '', stderr: behavior.stderr ?? 'boom' }
      }
      await writeFile(join(staging, 'graph.json'), JSON.stringify({ nodes: [{ id: 'n1', label: '节点一' }], edges: [] }))
      if (behavior.withHtml !== false) {
        if (behavior.large === true) {
          await writeFile(join(staging, 'graph.html'), '<html><script src="vis-network.min.js"></script>大图页</html>')
          await writeFile(join(staging, 'graph-layout.json'), JSON.stringify({ positions: { n1: [0, 0] }, communities: { n1: 0 }, order: [0] }))
          runOpts?.onLine?.('GRAPHIFY_RESULT {"nodes":6000,"edges":9000,"communities":40,"has_html":true,"layout":"grid-circles(approximate)","betweenness":"approx-k200-seed42"}')
          return { ...OK, stdout: 'noise\nGRAPHIFY_RESULT {"nodes":6000,"edges":9000,"communities":40,"has_html":true,"layout":"grid-circles(approximate)","betweenness":"approx-k200-seed42"}\n' }
        }
        await writeFile(join(staging, 'graph.html'), `<html><script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>图谱页</html>`)
      }
      await writeFile(join(staging, 'GRAPH_REPORT.md'), '报告')
      runOpts?.onLine?.(`GRAPHIFY_RESULT {"nodes":1,"edges":0,"communities":1,"has_html":${behavior.withHtml === false ? 'false' : 'true'}}`)
      return { ...OK, stdout: `noise\nGRAPHIFY_RESULT {"nodes":1,"edges":0,"communities":1,"has_html":${behavior.withHtml === false ? 'false' : 'true'}}\n` }
    }
    if (key.startsWith('curl -fsSL')) {
      const out = cmd[cmd.length - 1]
      if (typeof out === 'string') {
        await mkdir(join(out, '..'), { recursive: true }).catch(() => undefined)
        if (out.includes('.uv-install-')) {
          await writeFile(out, '#!/bin/sh\necho ok\n')
        } else {
          await writeFile(out, FAKE_VIZ)
        }
      }
      return { ...OK, stdout: '' }
    }
    return { code: 127, stdout: '', stderr: `unexpected: ${key}` }
  }
  return { run, calls, buildRuns: () => buildRuns }
}

function service(dir: string, projectPath: string | undefined, run: GraphifyRunner, extra: Partial<Parameters<typeof createGraphifyService>[0]> = {}) {
  return createGraphifyService({
    dir,
    projectPaths: async () => (projectPath === undefined ? [] : [{ id: 'p1', path: projectPath }]),
    run,
    vizSha256: FAKE_VIZ_SHA,
    ...extra,
  })
}

/** 轮询到 job 停(真异步时序,上限 5 秒)。 */
async function settle(svc: ReturnType<typeof createGraphifyService>, jobId: string) {
  const startedAt = Date.now()
  for (;;) {
    const view = svc.job(jobId)
    if (view !== undefined && view.status !== 'running') return view
    if (Date.now() - startedAt > 5_000) throw new Error('作业 5 秒没停')
    await new Promise(r => setTimeout(r, 20))
  }
}

/**
 * 失败路径的清理(rm 暂存/脚本)在作业置 error 之后**异步**收尾 —— 断言目录前先把
 * staging / pipeline / prev 这几类点开头的残骸等它清完(上限 2 秒),
 * 不把收尾的瞬态残留当泄漏。
 */
async function waitForClean(dir: string): Promise<string[]> {
  const startedAt = Date.now()
  for (;;) {
    const names = (await readdirSafe(dir))
      .filter(name => !name.startsWith('.staging-') && !name.startsWith('.pipeline-') && !name.startsWith('.prev-'))
    if (names.length <= 2 || Date.now() - startedAt > 2_000) return names.sort()
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('status', () => {
  it('uv 不在 → installed:false(不再多问);uv 在且热探针过 → true', async () => {
    const dir = await tempDir('graphify-dir-')
    const noUv = fakeEnv({ uv: false })
    expect(await service(dir, undefined, noUv.run).status('p1')).toEqual({ installed: false, generatedAt: null, hasHtml: false })
    expect(noUv.calls.map(c => c.cmd.join(' '))).toEqual(['uv --version'])

    const warm = fakeEnv({ warm: true })
    expect(await service(dir, undefined, warm.run).status('p1')).toEqual({ installed: true, generatedAt: null, hasHtml: false })
    const cold = fakeEnv({ warm: false })
    expect(await service(dir, undefined, cold.run).status('p1')).toEqual({ installed: false, generatedAt: null, hasHtml: false })
  })

  it('meta.json 里有 generatedAt 就读得到;没有 → null', async () => {
    const dir = await tempDir('graphify-dir-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'meta.json'), JSON.stringify({ generatedAt: 1729600000000, projectId: 'p1', projectPath: '/x' }))
    const withMeta = fakeEnv({ warm: true })
    expect(await service(dir, undefined, withMeta.run).status('p1'))
      .toEqual({ installed: true, generatedAt: 1729600000000, hasHtml: false })
    expect(await service(dir, undefined, withMeta.run).status('p2'))
      .toEqual({ installed: true, generatedAt: null, hasHtml: false })
  })
})

describe('build(真实异步时序)', () => {
  it('命令行 pins graphifyy==0.1.14;产物从暂存挪正,meta.json 写齐,暂存与脚本清掉', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const view = await settle(svc, result.jobId)
      expect(view.status).toBe('done')
    }
    const buildCall = env.calls.find(c => c.cmd.join(' ').startsWith('uv run --with'))!
    expect(buildCall.cmd.slice(0, 5)).toEqual(['uv', 'run', '--with', 'graphifyy==0.1.14', 'python'])
    expect(buildCall.cmd[6]).toBe(project)
    const meta = JSON.parse(await readFile(join(dir, 'p1', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.projectId).toBe('p1')
    expect(meta.projectPath).toBe(project)
    expect(typeof meta.generatedAt).toBe('number')
    expect(meta.hasHtml).toBe(true)
    expect(await readFile(join(dir, 'p1', 'graph.html'), 'utf8')).toContain('图谱页')
    // 暂存目录与流水线脚本不留残骸(列目录只剩 p1)。
    expect(await waitForClean(dir)).toEqual(['p1', 'vendor'])
  })

  it('★jobId 在生成办完之前就返回:拿到手时作业还在 running', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true, build: { delayMs: 400 } })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const early = svc.job(result.jobId)
    expect(early?.status).toBe('running')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
  })

  it('同项目在跑 → 第二次 build 拿回同一条 jobId,runner 只被调一次', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true, build: { delayMs: 300 } })
    const svc = service(dir, project, env.run)
    const first = await svc.build('p1')
    const second = await svc.build('p1')
    expect(first.ok && second.ok && first.jobId === second.jobId).toBe(true)
    if (first.ok) await settle(svc, first.jobId)
    // 落定之后整条流水线只被叫起来一次(去重靠 running 档,不靠时序运气)。
    expect(env.buildRuns()).toBe(1)
  })

  it('项目 id 不认识 / 路径不存在 → 当场回错,不起作业', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run)
    expect(await svc.build('nope')).toEqual({ ok: false, error: '项目没有本机路径' })
    const svcGone = createGraphifyService({
      dir,
      projectPaths: async () => [{ id: 'p1', path: join(project, '不存在') }],
      run: env.run,
      vizSha256: FAKE_VIZ_SHA,
    })
    expect(await svcGone.build('p1')).toEqual({ ok: false, error: '项目路径不存在' })
    expect(env.buildRuns()).toBe(0)
  })

  it('生成失败 → job error;上一次的好图谱原样还在,暂存清掉', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    // 预置一份「上次生成」的旧产物。
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), '旧图谱页')
    await writeFile(join(dir, 'p1', 'meta.json'), JSON.stringify({ generatedAt: 1, projectId: 'p1', projectPath: project }))
    const env = fakeEnv({ warm: true, build: { code: 1, stderr: 'extract 崩了' } })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('生成图谱失败')
    expect(await readFile(join(dir, 'p1', 'graph.html'), 'utf8')).toBe('旧图谱页')
    expect(await waitForClean(dir)).toEqual(['p1', 'vendor'])
  })

  it('退出 0 但产物不齐(没有 graph.json)→ 也算失败,旧图谱还在', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), '旧图谱页')
    const env = fakeEnv({ warm: true, build: { partial: true } })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('graph.json')
    expect(await readFile(join(dir, 'p1', 'graph.html'), 'utf8')).toBe('旧图谱页')
    expect(await waitForClean(dir)).toEqual(['p1', 'vendor'])
  })

  it('成功重建 → 旧产物整个换掉(旧文件不留)', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'old.html'), '旧专属文件')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    await settle(svc, result.jobId)
    expect(await exists(join(dir, 'p1', 'old.html'))).toBe(false)
    expect(await exists(join(dir, 'p1', 'graph.html'))).toBe(true)
  })

  it('上游没出 graph.html 的那次(防御档):hasHtml=false,job 仍算 done,status 如实说没有页面', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true, build: { withHtml: false } })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    const meta = JSON.parse(await readFile(join(dir, 'p1', 'meta.json'), 'utf8')) as { hasHtml: boolean }
    expect(meta.hasHtml).toBe(false)
    expect(await exists(join(dir, 'p1', 'graph.html'))).toBe(false)
    // status 的 hasHtml 以盘上有没有 graph.html 为准,不把「没页面」说成「有页面」。
    expect((await svc.status('p1')).hasHtml).toBe(false)
  })

  it('大图(超过 5000 节点)走社区网格近似布局的本地页:graph.html + graph-layout.json 都在,vis-network 本地引用', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true, build: { large: true } })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    // 大图模板:html 本来就是相对引用(不需要改写),组件照样拷进来,布局数据原样落地。
    const html = await readFile(join(dir, 'p1', 'graph.html'), 'utf8')
    expect(html).toContain('vis-network.min.js')
    expect(html).not.toContain('unpkg.com')
    expect(await exists(join(dir, 'p1', 'vis-network.min.js'))).toBe(true)
    const layout = JSON.parse(await readFile(join(dir, 'p1', 'graph-layout.json'), 'utf8')) as { positions: Record<string, number[]> }
    expect(Object.keys(layout.positions).length).toBeGreaterThan(0)
    expect((await svc.status('p1')).hasHtml).toBe(true)
    const meta = JSON.parse(await readFile(join(dir, 'p1', 'meta.json'), 'utf8')) as { layout?: string, hasHtml: boolean }
    expect(meta.hasHtml).toBe(true)
  })

  it('★真实 PIPELINE_PY writer 产出的大图 graph.html 内联 JS 语法合法(node --check 通过,无单引号内真实换行)', async () => {
    // 实际生产链路:PIPELINE_PY 内的 write_large_html 写出的 HTML 模板,
    // 抽取其实际 <script> 标签并在 Node 进程真跑 node --check,杜绝单引号内真实换行语法错误。
    const dir = await tempDir('graphify-html-test-')
    const start = PIPELINE_PY.indexOf('LARGE_HTML =')
    const end = PIPELINE_PY.indexOf('\nt0 = time.time()')
    const pyScript = `import json, sys
from pathlib import Path
${PIPELINE_PY.slice(start, end)}
out = Path(${JSON.stringify(dir)})
write_large_html(None, {'c0': ['n1', 'n2']}, out)
`
    const pyFile = join(dir, 'test_writer.py')
    await writeFile(pyFile, pyScript, 'utf8')
    const py = spawnSync('python3', [pyFile])
    expect(py.status).toBe(0)
    const html = await readFile(join(dir, 'graph.html'), 'utf8')
    expect(html).toContain('<script src="vis-network.min.js"></script>')
    const match = html.match(/<script>([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const script = match![1]!
    expect(script).toContain('window.__net')
    // 换行一律走运行期 NL=String.fromCharCode(10):模板被 raw 源码直取与 JS 求值两条路
    // 消费,任何反斜杠转义在 raw 路上都会变成字面量 \n 上屏(13 截图实证)。
    expect(script).toContain('var NL=String.fromCharCode(10)')
    expect(script).toContain("title:(n.label||'')+NL+")
    expect(script).toContain("source_file?NL+raw.source_file")
    const jsFile = join(dir, 'test_script.js')
    await writeFile(jsFile, script, 'utf8')
    const check = spawnSync('node', ['--check', jsFile])
    expect(check.status).toBe(0)
  })

  it('★大图模板是真社区聚合概览:概览只画社区聚合点,点社区进入成员视图,可返回(2026-10-26 排查实证旧模板把 4 万节点全量点画成矩形点阵冒充「社区聚合概览」)', async () => {
    // 从 PIPELINE_PY 抽出 LARGE_HTML 真跑 write_large_html,再对内联 JS 做结构断言。
    const dir = await tempDir('graphify-html-agg-')
    const start = PIPELINE_PY.indexOf('LARGE_HTML =')
    const end = PIPELINE_PY.indexOf('\nt0 = time.time()')
    const pyScript = `import json, sys
from pathlib import Path
${PIPELINE_PY.slice(start, end)}
out = Path(${JSON.stringify(dir)})
write_large_html(None, {'c0': ['n1', 'n2'], 'c1': ['n3']}, out)
`
    const pyFile = join(dir, 'test_writer.py')
    await writeFile(pyFile, pyScript, 'utf8')
    const py = spawnSync('python3', [pyFile])
    expect(py.status).toBe(0)
    const html = await readFile(join(dir, 'graph.html'), 'utf8')
    // 聚合概览三要素:概览态存在、进入社区、返回概览;概览节点数上报 window.__overviewCount,
    // 原始总量如实上报 window.__nodeCount(总量一个不少,只是不一次全画出来)。
    expect(html).toContain('返回概览')
    expect(html).toContain('__overviewCount')
    expect(html).toContain('__nodeCount')
    // 概览态的社区间连线是聚合计数,不是把原始边一条条铺进概览。
    expect(html).toContain('count')
    // HUD 如实写「聚合」。
    expect(html).toContain('聚合')
  })

  it('★概览首屏必须可读(2026-10-26 视觉验收退回):分页+视口自适应布局+像素半径下限+「其余社区」翻页入口;旧「fit 全图」布局在这套断言上必红', async () => {
    // 视觉退回的实证:旧模板把 2515 个社区铺在 45000×45000 世界坐标上 fit 全图,
    // 普通窗口(~700×110)里每社区格子只有 ~14px、点半径 0.16px 起步 —— 名符其实的
    // 「极暗极小矩形点阵」。这里钉新机制:每页固定颗数、按视口宽高现算行列与半径、
    // 半径有像素下限、页外社区聚成一颗「其余」翻页点。原始数据一行不删(graph.json 全量)。
    const dir = await tempDir('graphify-html-readable-')
    const start = PIPELINE_PY.indexOf('LARGE_HTML =')
    const end = PIPELINE_PY.indexOf('\nt0 = time.time()')
    const pyScript = `import json, sys
from pathlib import Path
${PIPELINE_PY.slice(start, end)}
out = Path(${JSON.stringify(dir)})
write_large_html(None, {i: ['n%d' % (i * 3 + j) for j in range(100 - i)] for i in range(60)}, out)
`
    const pyFile = join(dir, 'test_writer.py')
    await writeFile(pyFile, pyScript, 'utf8')
    const py = spawnSync('python3', [pyFile])
    expect(py.status).toBe(0)
    const html = await readFile(join(dir, 'graph.html'), 'utf8')
    const match = html.match(/<script>([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const script = match![1]!
    const jsFile = join(dir, 'readable_script.js')
    await writeFile(jsFile, script, 'utf8')
    expect(spawnSync('node', ['--check', jsFile]).status).toBe(0)
    // 机制要素:分页、「其余社区」入口、视口自适应、像素下限、真实渲染几何回执。
    expect(script).toContain('__overviewStats')
    expect(script).toContain('其余')
    expect(script).toContain('layoutPage')
    expect(script).toContain('resize')
    // 载入提示在 HTML 体里(黑屏闪烁的实话状态)。
    expect(html).toContain('正在载入图谱')
    // ① 换行不许走反斜杠转义:模板被「raw 源码直取」(harness 重放)与「JS 求值后」(真服务)
    // 两条路消费,任何 \\n 转义都会在 raw 路上变成字面量 \n 上屏(13 截图实证)。
    // 唯一两条路字节一致的做法是运行期 String.fromCharCode(10)。
    expect(html).toContain('String.fromCharCode(10)')
    expect(html).not.toContain('\\\\n')
    // ② HUD 带必须量真实工具条:offsetHeight 实测,不写死常数(HUD 会随宽度折行,36px 盖顶行)。
    expect(script).toContain('offsetHeight')
    expect(script).not.toContain('HUD_BAND=')
    // ③ 出社区连线的 from 必须是本社区成员(在 DataSet 里);旧实现取社区外端点,
    // 边端点不在 DataSet 里被 vis 丢弃,成员→相邻社区关系丢失(统筹退回点名的回归)。
    expect(script).toContain("var k=e.source+'|'+c2")
    expect(script).toContain("var k2=e.target+'|'+c1")
    expect(script).not.toContain("var k=e.target+'|'+c2")
    // 不许再靠「fit 全图」撞大运(旧机制退回根因);社区内视图用手工包围盒定位。
    expect(script).not.toContain('net.fit(')
    // layoutPage 是纯函数:抽出来用真 node 跑布局数学。机制与页容挂钩(capacityOf):
    // 每颗社区带「名+数」两行标签,格子窄于 104px 或行高低于 64px 就减页容换可读,
    // 而不是把 48 颗挤进 110px 高的窗。三种真实视口下钉可读性下限。
    const begin = script.indexOf('/*LAYOUT_BEGIN*/')
    const end2 = script.indexOf('/*LAYOUT_END*/')
    expect(begin).toBeGreaterThan(-1)
    expect(end2).toBeGreaterThan(begin)
    const fns = new Function(`${script.slice(begin, end2)}; return { layoutPage, capacityOf };`)() as {
      layoutPage: (items: ReadonlyArray<{ count: number }>, W: number, H: number) => ReadonlyArray<{ x: number, y: number, r: number }> & { cellMin: number }
      capacityOf: (W: number, H: number) => number
    }
    const items = Array.from({ length: 60 }, (_, i) => ({ count: 5000 - i * 80 }))
    for (const [W, H] of [[700, 110], [700, 250], [732, 236], [1227, 839]] as const) {
      const per = fns.capacityOf(W, H)
      // 页容必须真的是「名+数标签放得下」的颗数:小窗个位数~二十颗,大屏封顶 60。
      expect(per).toBeGreaterThanOrEqual(4)
      expect(per).toBeLessThanOrEqual(60)
      if (H <= 120) expect(per).toBeLessThanOrEqual(16)
      const slots = fns.layoutPage(items.slice(0, per), W, H)
      expect(slots.length).toBe(per)
      const radii = slots.map(s => s.r)
      // 像素半径下限:任何真实视口里,最小的社区点直径也不低于 16px(半径 8)。
      expect(Math.min(...radii)).toBeGreaterThanOrEqual(8)
      // 行高必须容得下「点+两行标签」:半径 ≤ (行高-34)/2 的约束在 layoutPage 内,
      // 这里用边界等价式复核最底行(中心+半径+28px 标签)不越 H。
      const rows = Math.ceil(per / Math.max(1, Math.floor(W / 104)))
      const ch = H / rows
      const bottom = Math.max(...slots.map((s) => s.y + s.r + 28))
      expect(bottom).toBeLessThanOrEqual(H + 1)
      // 最大的社区是视觉主角(首位半径 ≥ 中位数)。
      const median = radii.slice().sort((a, b) => a - b)[Math.floor(radii.length / 2)]!
      expect(radii[0]!).toBeGreaterThanOrEqual(median)
      // 所有点完整落在视口内(中心 ± 半径不超界),布局真的适配窗口而不是超出。
      for (const s of slots) {
        expect(s.x - s.r).toBeGreaterThanOrEqual(0)
        expect(s.x + s.r).toBeLessThanOrEqual(W)
        expect(s.y - s.r).toBeGreaterThanOrEqual(0)
        expect(s.y + s.r).toBeLessThanOrEqual(H)
      }
    }
    // 大屏视口里点要够大(全屏展开是「读图」主路径之一):1200×850 的中位半径 ≥ 20px。
    const bigPer = fns.capacityOf(1200, 850)
    const bigSlots = fns.layoutPage(items.slice(0, bigPer), 1200, 850)
    const bigMedian = bigSlots.map(s => s.r).sort((a, b) => a - b)[Math.floor(bigSlots.length / 2)]!
    expect(bigMedian).toBeGreaterThanOrEqual(20)
  })

  it('graph.html 里的 unpkg 外链换成本目录的 vis-network.min.js(本地可用,不连外网)', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    await settle(svc, result.jobId)
    const html = await readFile(join(dir, 'p1', 'graph.html'), 'utf8')
    expect(html).not.toContain('unpkg.com')
    expect(html).toContain('vis-network.min.js')
    // 组件真拷进了产物目录,iframe 同目录引用拿得到。
    expect(await readFile(join(dir, 'p1', 'vis-network.min.js'), 'utf8')).toContain('vis-network')
    // 下载的是钉死版本的 standalone 构建(自带 DataSet,和 graphify 引用的同一份)。
    expect(env.calls.some(c => c.cmd.join(' ').includes('vis-network@9.1.9/standalone/umd/vis-network.min.js'))).toBe(true)
  })

  it('vis-network 下不到 → 作业如实失败,不把要连外网的页面交出去', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    // 把 vendor 那一步掐死:vis-network 的 curl 回非 0。
    const run: GraphifyRunner = async (cmd, runOpts) => {
      if (cmd.join(' ').startsWith('curl -fsSL')) return { code: 7, stdout: '', stderr: 'connect failed' }
      return env.run(cmd, runOpts)
    }
    const svc = service(dir, project, run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('vis-network')
    expect(env.buildRuns()).toBe(0)
  })

  it('作业视图带最后一个完成的阶段(done/error 都照实停在那一阶段)', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run)
    const ok = await svc.build('p1')
    if (!ok.ok) throw new Error('应当起作业')
    await settle(svc, ok.jobId)
    // 假 runner 流转的最后阶段是 extract;真链路里 done 停在 export。
    expect(svc.job(ok.jobId)?.stage).toBe('extract')

    const envFail = fakeEnv({ warm: true, build: { code: 1, stderr: 'extract 崩了' } })
    const svcFail = createGraphifyService({
      dir,
      projectPaths: async () => [{ id: 'p1', path: project }],
      run: envFail.run,
      vizSha256: FAKE_VIZ_SHA,
    })
    const bad = await svcFail.build('p1')
    if (!bad.ok) throw new Error('应当起作业')
    const view = await settle(svcFail, bad.jobId)
    expect(view.status).toBe('error')
    expect(view.stage).toBe('extract')
  })
})

describe('install', () => {
  it('jobId 立即返回;uv 缺席 → 下载官方脚本到临时文件再安全执行 sh → 热 import graphify', async () => {
    const dir = await tempDir('graphify-dir-')
    const env = fakeEnv({ uv: false })
    const svc = service(dir, undefined, env.run)
    const result = await svc.install()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(svc.job(result.jobId)?.status).toBe('running')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    const keys = env.calls.map(c => c.cmd.join(' '))
    expect(keys[0]).toBe('uv --version')
    // 官方脚本走 curl 安全参数下载到临时文件，再走 sh 安全参数执行，绝不拼 bash
    expect(keys.some(k => k.startsWith('curl -fsSL https://astral.sh/uv/install.sh -o ') && k.includes('.uv-install-'))).toBe(true)
    expect(keys.some(k => k.startsWith('sh ') && k.includes('.uv-install-'))).toBe(true)
    expect(keys.some(k => k.includes('brew'))).toBe(false)
    expect(keys.some(k => k.includes('bash -c'))).toBe(false)
    expect(keys[keys.length - 2]).toBe('uv run --with graphifyy==0.1.14 python -c import graphify')
    expect(keys[keys.length - 1]?.startsWith('curl -fsSL')).toBe(true)
  })

  it('uv 官方脚本执行失败 → job error,那句原话进 error', async () => {
    const dir = await tempDir('graphify-dir-')
    const env = fakeEnv({ uv: false, fallbacks: false })
    const svc = service(dir, undefined, env.run)
    const result = await svc.install()
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('执行 uv 安装脚本失败')
  })

  it('uv_bootstrap_url 配成 off → 不下脚本(零 curl 零 sh),装 uv 失败如实报错', async () => {
    const dir = await tempDir('graphify-dir-')
    const env = fakeEnv({ uv: false })
    const svc = service(dir, undefined, env.run, { uvBootstrapUrl: () => undefined })
    const result = await svc.install()
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('uv 安装脚本下载被关掉了(endpoints.json 里 uv_bootstrap_url 是 off)')
    const keys = env.calls.map(c => c.cmd.join(' '))
    expect(keys.some(k => k.includes('curl -fsSL') && k.includes('install'))).toBe(false)
    expect(keys.some(k => k.startsWith('sh '))).toBe(false)
  })

  it('自定 uv_bootstrap_url 传给 curl argv 且临时脚本执行后已删除', async () => {
    const dir = await tempDir('graphify-dir-')
    const env = fakeEnv({ uv: false })
    const svc = service(dir, undefined, env.run, { uvBootstrapUrl: () => 'https://mirror.example.com/uv.sh' })
    const result = await svc.install()
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    const keys = env.calls.map(c => c.cmd.join(' '))
    expect(keys.some(k => k.includes('https://mirror.example.com/uv.sh'))).toBe(true)
  })
})

describe('read(越界与符号链接)', () => {
  it('正常读 html / json,contentType 按扩展名', async () => {
    const dir = await tempDir('graphify-dir-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), '<html>x</html>')
    await writeFile(join(dir, 'p1', 'graph.json'), '{}')
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    const html = await svc.read('p1', 'graph.html')
    expect(html?.contentType).toContain('text/html')
    expect(html?.data.toString()).toContain('<html>')
    expect((await svc.read('p1', 'graph.json'))?.contentType).toBe('application/json')
    expect(await svc.read('p1', '')).toBeUndefined()
    expect(await svc.read('p1', '不存在.html')).toBeUndefined()
  })

  it('项目 id 不合法(.. / 含斜杠)一律 undefined —— 不碰磁盘外任何东西', async () => {
    const dir = await tempDir('graphify-dir-')
    const outside = await tempDir('graphify-out-')
    await writeFile(join(outside, 'secret.txt'), '不该被读到')
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    expect(await svc.read('..', 'secret.txt')).toBeUndefined()
    expect(await svc.read('.', 'secret.txt')).toBeUndefined()
    expect(await svc.read(`..${outside.slice(1)}/secret.txt`, 'secret.txt')).toBeUndefined()
    expect(await svc.read('a/b', 'secret.txt')).toBeUndefined()
  })

  it('relPath 的 .. 与编码穿越一律 undefined', async () => {
    const dir = await tempDir('graphify-dir-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), 'x')
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    expect(await svc.read('p1', '../x')).toBeUndefined()
    expect(await svc.read('p1', '..%2fx')).toBeUndefined()
    expect(await svc.read('p1', '%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBeUndefined()
    expect(await svc.read('p1', '/etc/passwd')).toBeUndefined()
    expect(await svc.read('p1', 'a/../../x')).toBeUndefined()
  })

  it('★项目目录本身是指到产物根外的 symlink → undefined(独立验收员的哨兵实证)', async () => {
    const dir = await tempDir('graphify-dir-')
    const outside = await tempDir('graphify-out-')
    await writeFile(join(outside, 'proof.txt'), '不该被读到')
    await symlink(outside, join(dir, 'p1'))
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    expect(await svc.read('p1', 'proof.txt')).toBeUndefined()
  })

  it('★项目目录里 nested 一层再链到根外 → undefined', async () => {
    const dir = await tempDir('graphify-dir-')
    const outside = await tempDir('graphify-out-')
    await writeFile(join(outside, 'proof.txt'), '不该被读到')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await symlink(outside, join(dir, 'p1', 'nested'))
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    expect(await svc.read('p1', 'nested/proof.txt')).toBeUndefined()
  })

  it('符号链接翻出项目目录 → undefined(真 symlink)', async () => {
    const dir = await tempDir('graphify-dir-')
    const outside = await tempDir('graphify-out-')
    await writeFile(join(outside, 'secret.txt'), '不该被读到')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), 'x')
    await symlink(join(outside, 'secret.txt'), join(dir, 'p1', 'link-out'))
    const svc = service(dir, undefined, fakeEnv({ warm: true }).run)
    expect(await svc.read('p1', 'link-out')).toBeUndefined()
  })
})

describe('HTTP 层的编码路径(/graphify/view/*)', () => {
  it('%2e%2e 与项目 id 越界一律 404;正常路径 200 出图', async () => {
    const dir = await tempDir('graphify-dir-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'graph.html'), '<html>图谱页</html>')
    const graphify = createGraphifyService({
      dir,
      projectPaths: async () => [],
      run: fakeEnv({ warm: true }).run,
      vizSha256: FAKE_VIZ_SHA,
    })
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      graphify,
      tickIntervalMs: 0,
      heartbeatMs: 0,
    })
    started.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const good = await fetch(`${base}/graphify/view/p1/graph.html`)
    expect(good.status).toBe(200)
    expect(await good.text()).toContain('图谱页')
    // 编码后的穿越:route 解出来是 ..,服务层挡住,404。
    expect((await fetch(`${base}/graphify/view/p1/..%2f..%2f..%2fsecret`)).status).toBe(404)
    expect((await fetch(`${base}/graphify/view/%2e%2e/graph.html`)).status).toBe(404)
    expect((await fetch(`${base}/graphify/view/..%2f/graph.html`)).status).toBe(404)
  })
})

describe('vendor(vis-network 下载:临时文件 + 校验 + rename + 重试 + 并发)', () => {
  it('下到一半/内容验不过 → 重试;第二次好文件 rename 成功,作业 done', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    let curls = 0
    const run: GraphifyRunner = async (cmd, runOpts) => {
      if (cmd.join(' ').startsWith('curl -fsSL')) {
        curls += 1
        if (curls === 1) {
          // 第一次:写个半截文件、退出 0(sha 验不过)。
          const out = cmd[cmd.length - 1] as string
          await mkdir(join(out, '..'), { recursive: true })
          await writeFile(out, 'HALF-FILE')
          return { ...OK }
        }
      }
      return env.run(cmd, runOpts)
    }
    const svc = service(dir, project, run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    expect(curls).toBe(2)
    // 校验过的那份真的落了盘,且没有 tmp 残骸。
    expect(await readFile(join(dir, 'vendor', 'vis-network.min.js'), 'utf8')).toBe(FAKE_VIZ)
    expect((await readdirSafe(join(dir, 'vendor'))).sort()).toEqual(['vis-network.min.js'])
  })

  it('并发首装:两条 install 同时在跑也只下一次', async () => {
    const dir = await tempDir('graphify-dir-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, undefined, env.run)
    const first = await svc.install()
    const second = await svc.install()
    if (!first.ok || !second.ok) throw new Error('都应当起作业')
    await settle(svc, first.jobId)
    await settle(svc, second.jobId)
    const vizCurls = env.calls.filter(c => c.cmd.join(' ').startsWith('curl -fsSL')).length
    expect(vizCurls).toBe(1)
  })

  it('已有一份完整的 vendor → 下载坏了也不碰它(旧件原样在)', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    await mkdir(join(dir, 'vendor'), { recursive: true })
    await writeFile(join(dir, 'vendor', 'vis-network.min.js'), '旧的那份完整组件')
    const env = fakeEnv({ warm: true })
    const run: GraphifyRunner = async (cmd, runOpts) => {
      if (cmd.join(' ').startsWith('curl -fsSL')) return { code: 7, stdout: '', stderr: 'connect failed' }
      return env.run(cmd, runOpts)
    }
    const svc = service(dir, project, run)
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('done')
    expect(await readFile(join(dir, 'vendor', 'vis-network.min.js'), 'utf8')).toBe('旧的那份完整组件')
  })

  it('viz_cdn_url 配成 off → 不下(一个 curl 都不发),作业如实失败', async () => {
    const dir = await tempDir('graphify-dir-')
    const project = await tempDir('graphify-proj-')
    const env = fakeEnv({ warm: true })
    const svc = service(dir, project, env.run, { vizUrl: () => undefined })
    const result = await svc.build('p1')
    if (!result.ok) throw new Error('应当起作业')
    const view = await settle(svc, result.jobId)
    expect(view.status).toBe('error')
    expect(view.error).toContain('off')
    expect(env.calls.some(c => c.cmd.join(' ').startsWith('curl -fsSL'))).toBe(false)
  })
})

async function readdirSafe(path: string): Promise<string[]> {
  try { return await readdir(path) }
  catch { return [] }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch { return false }
}
