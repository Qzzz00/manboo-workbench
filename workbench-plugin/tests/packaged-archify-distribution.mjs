/**
 * 安装/分发形态下 Archify 可用性验证(2026-10-24,卡「图谱显示修复与Archify接入」,独立审固定 Major 的差分回归)。
 *
 * 形态:真实 `npm run build`(含 copy-archify-assets)→ `npm pack` → 全新解压到隔离目录,
 * 源码根的 third_party/ 与 docs/ 在解压目录里**不存在**(解析不可能回退到仓库)。
 *
 * 本轮增量(第三轮收口):先红锚再绿 —— 从**真实编译入口位置**(解压包 lib/index.js)
 * 起算,复现旧表达式 `new URL('../..', import.meta.url)` 锚到包父、四候选全 MISSING;
 * 再验真实装配 helper(archifyAssetRootFrom)从同一位置锚到包根、资产命中,
 * 并以该基准起真服务:五图 status/readView/readSpec 从包内 pinned 读出、
 * 官方离线工具链从包内 lib 完成一次真实 generate、产物写隔离 HOME。
 *
 * 用法:node tests/packaged-archify-distribution.mjs   (内部自跑 npm run build)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(pluginDir, '..')
const EVIDENCE_DIR = path.join(repoRoot, 'docs', '验收-图谱显示与Archify-2026-10-23')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

function log(stage, msg) { console.log(`[包形态][${stage}] ${msg}`) }

async function main() {
  // ── 1. 构建 + 打包 + 解压到隔离目录 ──
  log('build', 'npm run build(含 copy-archify-assets)…')
  execFileSync('npm', ['run', 'build'], { cwd: pluginDir, stdio: 'inherit' })
  const tgz = execFileSync('npm', ['pack', '--silent'], { cwd: pluginDir, encoding: 'utf8' }).trim().split('\n').pop()
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-pack-sim-'))
  execFileSync('tar', ['-xzf', path.join(pluginDir, tgz), '-C', pkgRoot])
  const extracted = path.join(pkgRoot, 'package')
  log('pack', `${tgz} → ${extracted}`)

  // ── 2. 包内容断言:工具链与五图必须随包,源码根资产必须不存在 ──
  const binInPkg = path.join(extracted, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs')
  const pinnedInPkg = path.join(extracted, 'lib', 'archify-pinned')
  const assetsOk = fs.existsSync(binInPkg) && fs.readdirSync(pinnedInPkg).filter(f => f.endsWith('.html')).length === 5
  const noSourceFallback = !fs.existsSync(path.join(extracted, 'third_party')) && !fs.existsSync(path.join(extracted, 'docs'))
  if (!assetsOk) throw new Error('包内缺少 Archify 工具链或五图产物')
  if (!noSourceFallback) throw new Error('解压目录里出现源码根资产,形态不真')

  const { archifyAssetRootFrom, createArchifyService } = await import(pathToFileURL(path.join(pluginDir, 'src/server/archify.ts')).href)
  const { startWorkbenchServer } = await import(pathToFileURL(path.join(pluginDir, 'src/server/http.ts')).href)
  const { createWorkbenchService } = await import(pathToFileURL(path.join(pluginDir, 'src/server/service.ts')).href)

  const checks = {}
  const measurements = { tgz, extracted, assetsOk, noSourceFallback }

  // ── 2b. 真实装配入口定位:先红锚(旧表达式从编译 lib/index.js 起算锚到包父、四候选全 MISSING),
  //        再绿(装配 helper 从同一真实位置起算锚到包根、资产命中) ──
  const compiledEntry = path.join(extracted, 'lib', 'index.js')
  const oldExpressionRoot = path.resolve(path.dirname(compiledEntry), '..', '..') // 旧 new URL('../..') 的真实解析值
  const oldCandidates = [
    path.join(oldExpressionRoot, 'third_party', 'archify', 'bin', 'archify.mjs'),
    path.join(oldExpressionRoot, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs'),
    path.join(oldExpressionRoot, 'docs', '全景地图', 'archify'),
    path.join(oldExpressionRoot, 'lib', 'archify-pinned'),
  ]
  checks.oldWiringAnchorMissing = oldCandidates.every(c => !fs.existsSync(c))
  const wiredRoot = archifyAssetRootFrom(pathToFileURL(compiledEntry).href)
  checks.realWiringResolvesAssets = wiredRoot === extracted
    && fs.existsSync(path.join(wiredRoot, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs'))
    && fs.existsSync(path.join(wiredRoot, 'lib', 'archify-pinned'))
  measurements.wiring = { compiledEntry, oldExpressionRoot, wiredRoot }
  log('wiring', `旧锚(红): ${oldExpressionRoot} 四候选全缺=${checks.oldWiringAnchorMissing};新接线(绿): ${wiredRoot}`)

  // ── 3. 以真实装配基准起真服务(repoRoot 解析只能靠包内 lib) ──
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-pack-home-'))
  const archify = createArchifyService({ homeDir: tempHome, repoRoot: wiredRoot })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    archify,
    tickIntervalMs: 0,
    heartbeatMs: 0,
  })
  log('server', `真服务 ${server.url}(repoRoot=真实装配基准,HOME=隔离)`)

  // 五图:status / readView / readSpec 全部从包内 pinned 读出
  const status = await (await fetch(`${server.url}/archify/status?project=desktop-workbench`)).json()
  checks.packFiveDiagrams = status.hasDiagrams === true && status.diagrams.length === 5 && status.pinnedCommit.includes('c55')
  measurements.status = { hasDiagrams: status.hasDiagrams, count: status.diagrams.length, pinned: status.pinnedCommit }
  const viewRes = await fetch(`${server.url}/archify/view/desktop-workbench/architecture-runtime.html`)
  const viewHtml = await viewRes.text()
  checks.packView = viewRes.status === 200 && viewHtml.includes('archify 3.2.0')
  const specRes = await fetch(`${server.url}/archify/spec/desktop-workbench/architecture-runtime`)
  const spec = await specRes.json()
  checks.packSpec = specRes.status === 200 && spec.meta.repository.revision.includes('c55')

  // 工具链从包内解析:一次真实 generate(直传规格路,项目自有缓存 = 隔离 HOME)
  const genRes = await fetch(`${server.url}/archify/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'demo',
      diagramId: 'pack-check',
      type: 'architecture',
      spec: {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: '包形态实证', output: 'pack-check.html', quality_profile: 'showcase', locale: 'zh-CN' },
        components: [{ id: 'a', label: '甲', type: 'backend', pos: [20, 20], size: [120, 50] }],
        connections: [],
      },
    }),
  })
  const gen = await genRes.json()
  checks.packGenerate = genRes.status === 200 && gen.ok === true
  const genView = await fetch(`${server.url}/archify/view/demo/pack-check.html`)
  checks.packGeneratedView = genView.status === 200 && (await genView.text()).includes('包形态实证')
  measurements.generate = { status: genRes.status, ok: gen.ok, receiptChecks: gen.receipt?.validation?.checksPassed }

  await server.close()
  fs.rmSync(tempHome, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
  fs.rmSync(path.join(pluginDir, tgz), { force: true })

  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
  const receipt = {
    timestamp: new Date().toISOString(),
    form: 'npm pack 解压隔离目录(源码根 third_party/docs 不存在,解析无回退;装配定位从真实编译入口 lib/index.js 起算)',
    checks, measurements,
    whatIsReal: [
      '真实 build(含 copy-archify-assets)', '真实 npm pack + tar 解压',
      '真实装配定位:旧表达式红锚(包父四候选全缺)→ helper 锚包根(资产命中)',
      '真 startWorkbenchServer + 隔离 HOME', '官方离线 CLI 从包内 lib 解析并真跑 deliver',
    ],
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, '包形态-Archify分发验证收据.json'), JSON.stringify(receipt, null, 2))
  if (failed.length > 0) throw new Error(`有未过检查:${failed.join(', ')}`)
  log('done', '包形态全检查通过。')
}

main().catch((err) => { console.error('包形态验证失败:', err); process.exit(1) })
