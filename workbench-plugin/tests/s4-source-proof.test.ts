// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { S4_PRODUCT_PATHS, S4_QA_FILES, snapshotS4Sources, verifyS4SourceProof, verifyS4PackedBundle, verifyS4InstalledBundle, type S4SourceProof } from '../dev/acceptance-three-entrances/s4SourceProof.ts'
const exec = promisify(execFile), roots: string[] = []
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 's4-source-proof-'))); roots.push(root)
  const repo = join(root, 'repo'), evidence = join(root, 'proof')
  await mkdir(repo); await mkdir(evidence)
  const put = async (name: string, text: string) => { const p = join(repo, name); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text) }
  // Miniature real Git repo: fixture provenance only, never a product pass.
  for (const p of S4_PRODUCT_PATHS) await put(/\.(json|ts|mjs|yaml)$/.test(p) || p.endsWith('channel-start') ? p : p + '/fixture.txt', 'fixture\n')
  await put('channel-worker/src/main.ts', "import './agent.ts'\n")
  await put('channel-worker/src/agent.ts', 'export const fixed = 15000\n')
  for (const p of S4_QA_FILES) await put(p, '// QA fixture\n')
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args], { env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim()
  await git('init', '-q'); await git('add', '.'); await git('-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture fixed source')
  const fixed = await git('rev-parse', 'HEAD'), snapshot = await snapshotS4Sources(repo, fixed)
  const bundle: Record<string, string> = {}
  const staging = join(root, 'archive/package/lib'); await mkdir(staging, { recursive: true })
  for (const n of ['index.js', 'client.js', 'workbench.js']) { await put('workbench-plugin/lib/' + n, n + ' fixture'); bundle[n] = sha(n + ' fixture'); await copyFile(join(repo, 'workbench-plugin/lib', n), join(staging, n)) }
  const archive = join(evidence, 'bundle.tgz'); await exec('tar', ['-czf', archive, '-C', join(root, 'archive'), 'package'])
  const proof: S4SourceProof = { version: 1, ...snapshot, bundle, archive: { file: 'bundle.tgz', sha256: sha(await readFile(archive)) } }
  await writeFile(join(evidence, 'source-proof.json'), JSON.stringify(proof))
  return { root, repo, evidence, fixed, proof, git, put, archive }
}
it('实取HEAD/产品树/实际入口；缺expected、旧基线、dirty生产输入或外部worker均拒绝', async () => {
  const w = await world(), ok = await verifyS4SourceProof(w.repo, w.fixed, w.evidence)
  expect(ok.currentGitSHA).toBe(w.fixed)
  expect(ok.worker.entry).toBe(join(w.repo, 'channel-worker/src/main.ts'))
  expect(ok.worker.mode).toBe('node-typescript-source')
  expect(ok.worker.sha256).toBe(sha(await readFile(ok.worker.entry)))
  await expect(verifyS4SourceProof(w.repo, undefined, w.evidence)).rejects.toThrow(/expected/)
  await expect(verifyS4SourceProof(w.repo, '95304f338c493262129b234584ca9d3dd6c3f02f', w.evidence)).rejects.toThrow()
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence, '/tmp/old-worker')).rejects.toThrow(/worker/)
  await w.put('channel-worker/src/agent.ts', 'old worker\n')
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence)).rejects.toThrow(/source/)
})
it('QA工具blob/最终当前Git/产品基线分列；docs-only实取新SHA，工具变化不得复用旧证明', async () => {
  const w = await world()
  await w.put('docs/result.md', 'docs only'); await w.git('add', '.'); await w.git('-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'docs')
  const p = await verifyS4SourceProof(w.repo, w.fixed, w.evidence)
  expect(p.currentGitSHA).toBe(await w.git('rev-parse', 'HEAD')); expect(p.builtAtGitSHA).toBe(w.fixed); expect(p.expectedFixedSHA).toBe(w.fixed)
  await w.put(S4_QA_FILES[0]!, '// changed tool')
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence)).rejects.toThrow(/source/)
})
it('旧bundle、缺证明、错误包或安装入口不符全部失败，不能据build:false标ready', async () => {
  const w = await world()
  await expect(verifyS4SourceProof(w.repo, w.fixed, join(w.root, 'missing'))).rejects.toThrow()
  await verifyS4PackedBundle(w.proof, w.archive)
  const home = join(w.root, 'iso/home'), installed = join(home, '.dsh/profiles/web/node_modules/@ben/dsh-workbench/lib')
  await mkdir(installed, { recursive: true }); await mkdir(join(home, '.dsh/bin'), { recursive: true }); await mkdir(join(home, '.dsh/node/bin'), { recursive: true })
  for (const n of Object.keys(w.proof.bundle)) await copyFile(join(w.repo, 'workbench-plugin/lib', n), join(installed, n))
  await copyFile(join(w.repo, 'deploy/channel-start'), join(home, '.dsh/bin/channel-start'))
  await symlink(process.execPath, join(home, '.dsh/node/bin/node'))
  await verifyS4InstalledBundle(w.proof, home)
  await writeFile(join(installed, 'index.js'), 'stale installed bundle')
  await expect(verifyS4InstalledBundle(w.proof, home)).rejects.toThrow(/installed/)
  await writeFile(join(w.repo, 'workbench-plugin/lib/index.js'), 'stale build')
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence)).rejects.toThrow(/bundle/)
  await writeFile(w.archive, 'stale archive')
  await expect(verifyS4PackedBundle(w.proof, w.archive)).rejects.toThrow(/archive/)
})
it('原runner缺证明时在startInstance前退出；仅失败门Node子进程，不创建iso/permit或发送', async () => {
  const root = await mkdtemp(join(tmpdir(), 's4-source-denied-')); roots.push(root)
  const runner = new URL('../dev/acceptance-three-entrances/s4AuthorizedAcceptance.mts', import.meta.url).pathname
  let error: any
  try { await exec(process.execPath, [runner], { env: { PATH: process.env.PATH, PHONE_ACCEPTANCE_ROOT: root, S4_AUTHORIZED_SINGLE_WINDOW: '1', S4_QA_PROBE_APP: join(root, 'not-opened.app'), WORKBENCH_S4_WINDOW_QA: '{}' } }) } catch (e) { error = e }
  expect(error?.code).toBe(1)
  expect(existsSync(join(root, 'iso'))).toBe(false)
  expect(existsSync(join(root, 'allow-s4-once'))).toBe(false)
  expect(error?.stderr + error?.stdout).toMatch(/source proof|expected/)
})
it('缺证明也不清理已有隔离目录；失败门夹具禁止所有网络与进程信号', async () => {
  const root = await mkdtemp(join(tmpdir(), 's4-source-preserve-')); roots.push(root)
  await mkdir(join(root, 'iso')); await writeFile(join(root, 'iso/sentinel'), 'original evidence')
  await writeFile(join(root, 'acceptance-result.json'), '{"original":true}')
  const runner = new URL('../dev/acceptance-three-entrances/s4AuthorizedAcceptance.mts', import.meta.url).href
  const script = `let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('fixture denies all network')};process.kill=()=>{throw Error('fixture denies all signals')};process.on('exit',()=>console.log('FETCH_COUNT='+fetches));await import(${JSON.stringify(runner)});`
  let failure: any
  try { await exec(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, PHONE_ACCEPTANCE_ROOT: root, S4_AUTHORIZED_SINGLE_WINDOW: '1', S4_QA_PROBE_APP: join(root, 'never-opened.app'), WORKBENCH_S4_WINDOW_QA: '{}' }, timeout: 15_000 }) } catch (e) { failure = e }
  expect(failure?.stdout).toContain('FETCH_COUNT=0')
  expect(await readFile(join(root, 'iso/sentinel'), 'utf8')).toBe('original evidence')
  expect(await readFile(join(root, 'acceptance-result.json'), 'utf8')).toBe('{"original":true}')
})
it('expected祖先存在也不能隐藏已提交的旧worker；按当前生产tree失败', async () => {
  const w = await world()
  await w.put('channel-worker/src/agent.ts', 'export const fixed = 3000\n')
  await w.git('add', 'channel-worker/src/agent.ts'); await w.git('-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'old worker fixture')
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence)).rejects.toThrow(/production source/)
})
it('源证明是普通JSON文件，拒绝symlink；安装后的旧启动脚本也拒绝', async () => {
  const w = await world(), home = join(w.root, 'iso/home'), lib = join(home, '.dsh/profiles/web/node_modules/@ben/dsh-workbench/lib')
  await mkdir(lib, { recursive: true }); await mkdir(join(home, '.dsh/bin'), { recursive: true }); await mkdir(join(home, '.dsh/node/bin'), { recursive: true })
  for (const n of Object.keys(w.proof.bundle)) await copyFile(join(w.repo, 'workbench-plugin/lib', n), join(lib, n))
  await symlink(process.execPath, join(home, '.dsh/node/bin/node'))
  await writeFile(join(home, '.dsh/bin/channel-start'), 'old worker launcher')
  await expect(verifyS4InstalledBundle(w.proof, home)).rejects.toThrow(/launch script/)
  await copyFile(join(w.evidence, 'source-proof.json'), join(w.root, 'elsewhere.json'))
  await rm(join(w.evidence, 'source-proof.json')); await symlink(join(w.root, 'elsewhere.json'), join(w.evidence, 'source-proof.json'))
  await expect(verifyS4SourceProof(w.repo, w.fixed, w.evidence)).rejects.toThrow(/regular data/)
})
