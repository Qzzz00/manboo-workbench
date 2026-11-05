/** Pure-data provenance for the opt-in S4 QA runner. Never starts a service or loads config code. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { join, resolve, isAbsolute, basename } from 'node:path'
const exec = promisify(execFile)
export const S4_PRODUCT_PATHS = [
  'channel-worker', 'deploy/channel-start', 'workbench-plugin/src', 'workbench-plugin/bin',
  'workbench-plugin/scripts', 'workbench-plugin/package.json', 'workbench-plugin/pnpm-lock.yaml',
  'workbench-plugin/tsconfig.json', 'workbench-plugin/tsdown.config.ts',
  'docs/技能', '.dsh/skills', 'docs/记忆/下班例程.md', 'user-layer/起步',
] as const
export const S4_QA_FILES = [
  's4AuthorizedAcceptance.mts', 's4AuthorizedBridge.ts', 's4AuthorizedTrace.mts', 's4SourceProof.ts',
  's4PrepareSourceProof.mts', 'instance.ts', 's4WindowQa.ts', 'phonePorts.ts', 'entrances.ts',
  'judge.ts', 'sentences.json',
].map(name => 'workbench-plugin/dev/acceptance-three-entrances/' + name)
const BUNDLES = ['index.js', 'client.js', 'workbench.js'] as const
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
interface FileProof { gitBlob: string; sha256: string }
export interface S4SourceSnapshot {
  repo: string; expectedFixedSHA: string; builtAtGitSHA: string
  productTrees: Record<string, string>; sourceFiles: Record<string, FileProof>; qaFiles: Record<string, FileProof>
  worker: { directory: string; entry: string; mode: 'node-typescript-source'; sha256: string }
  launchScriptSha256: string
  node: { path: string; version: string }
}
export interface S4SourceProof extends S4SourceSnapshot {
  version: 1; bundle: Record<string, string>; archive: { file: string; sha256: string }
}
export type S4VerifiedSourceProof = S4SourceProof & { currentGitSHA: string; proofRoot: string }
function fail(why: string): never { throw new Error('S4 source proof: ' + why) }
async function git(repo: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', repo, ...args], { maxBuffer: 32 << 20, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
}
async function fileProof(repo: string, name: string, expectedBlob: string): Promise<FileProof> {
  const path = join(repo, name)
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) fail('source path is not a canonical regular file: ' + name)
  const bytes = await readFile(path)
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (blob !== expectedBlob) fail('source differs from current Git: ' + name)
  return { gitBlob: blob, sha256: hash(bytes) }
}
export async function snapshotS4Sources(repoInput: string, expected: string | undefined, workerDir?: string): Promise<S4SourceSnapshot> {
  if (!expected || !/^[a-f0-9]{40}$/.test(expected)) fail('expected fixed full SHA required')
  const repo = await realpath(repoInput)
  if (await realpath(await git(repo, ['rev-parse', '--show-toplevel'])) !== repo) fail('repository root mismatch')
  await git(repo, ['rev-parse', '--verify', expected + '^{commit}'])
  await git(repo, ['merge-base', '--is-ancestor', expected, 'HEAD'])
  if (workerDir !== undefined && resolve(workerDir) !== join(repo, 'channel-worker')) fail('worker directory must be this verified source tree')
  const builtAtGitSHA = await git(repo, ['rev-parse', 'HEAD'])
  const productTrees: Record<string, string> = {}, sourceFiles: Record<string, FileProof> = {}, qaFiles: Record<string, FileProof> = {}
  for (const path of S4_PRODUCT_PATHS) {
    const fixedTree = await git(repo, ['rev-parse', `${expected}:${path}`])
    if (await git(repo, ['rev-parse', `HEAD:${path}`]) !== fixedTree) fail('production source differs from expected fixed SHA: ' + path)
    productTrees[path] = fixedTree
  }
  const listing = await git(repo, ['ls-tree', '-r', '-z', 'HEAD', '--', ...S4_PRODUCT_PATHS])
  for (const row of listing.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row)
    if (!match) fail('unsupported source entry')
    sourceFiles[match[3]!] = await fileProof(repo, match[3]!, match[2]!)
  }
  for (const path of S4_QA_FILES) qaFiles[path] = await fileProof(repo, path, await git(repo, ['rev-parse', `HEAD:${path}`]))
  const entry = join(repo, 'channel-worker/src/main.ts')
  const entryProof = sourceFiles['channel-worker/src/main.ts']; if (!entryProof) fail('worker entry missing')
  return { repo, expectedFixedSHA: expected, builtAtGitSHA, productTrees, sourceFiles, qaFiles,
    worker: { directory: join(repo, 'channel-worker'), entry, mode: 'node-typescript-source', sha256: entryProof.sha256 },
    launchScriptSha256: sourceFiles['deploy/channel-start']!.sha256,
    node: { path: await realpath(process.execPath), version: process.version } }
}
export async function s4BundleHashes(repo: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(BUNDLES.map(async name => [name, hash(await readFile(join(repo, 'workbench-plugin/lib', name)))])))
}
export async function verifyS4PackedBundle(proof: S4SourceProof, archive: string): Promise<void> {
  if (hash(await readFile(archive)) !== proof.archive.sha256) fail('archive hash mismatch')
  for (const name of BUNDLES) {
    const { stdout } = await exec('tar', ['-xOf', archive, `package/lib/${name}`], { encoding: 'buffer', maxBuffer: 32 << 20 })
    if (hash(stdout) !== proof.bundle[name]) fail('archive bundle entry mismatch: ' + name)
  }
}
export async function verifyS4SourceProof(repo: string, expected: string | undefined, proofRoot: string | undefined, workerDir?: string): Promise<S4VerifiedSourceProof> {
  if (!expected || !/^[a-f0-9]{40}$/.test(expected)) fail('expected fixed full SHA required')
  if (!proofRoot || !isAbsolute(proofRoot) || resolve(proofRoot) !== proofRoot || await realpath(proofRoot) !== proofRoot) fail('explicit canonical source proof root required')
  if (!(await lstat(join(proofRoot, 'source-proof.json'))).isFile()) fail('source proof must be a regular data file')
  const proof = JSON.parse(await readFile(join(proofRoot, 'source-proof.json'), 'utf8')) as S4SourceProof
  if (proof.version !== 1 || proof.expectedFixedSHA !== expected || !/^[a-f0-9]{40}$/.test(proof.builtAtGitSHA)) fail('wrong/old expected source proof')
  const current = await snapshotS4Sources(repo, expected, workerDir)
  await git(current.repo, ['merge-base', '--is-ancestor', proof.builtAtGitSHA, current.builtAtGitSHA])
  for (const key of ['repo', 'productTrees', 'sourceFiles', 'qaFiles', 'worker', 'launchScriptSha256', 'node'] as const) {
    if (JSON.stringify(proof[key]) !== JSON.stringify(current[key])) fail('source proof mismatch: ' + key)
  }
  if (JSON.stringify(proof.bundle) !== JSON.stringify(await s4BundleHashes(current.repo))) fail('local bundle differs from freshly built proof')
  if (!proof.archive || basename(proof.archive.file) !== proof.archive.file || !proof.archive.file.endsWith('.tgz')) fail('invalid archive data')
  await verifyS4PackedBundle(proof, join(proofRoot, proof.archive.file))
  return { ...proof, currentGitSHA: current.builtAtGitSHA, proofRoot }
}
export async function verifyS4InstalledBundle(proof: S4SourceProof, home: string): Promise<void> {
  for (const name of BUNDLES) {
    const path = join(home, '.dsh/profiles/web/node_modules/@ben/dsh-workbench/lib', name)
    if (hash(await readFile(path)) !== proof.bundle[name]) fail('installed bundle mismatch: ' + name)
  }
  if (hash(await readFile(join(home, '.dsh/bin/channel-start'))) !== proof.launchScriptSha256) fail('installed worker launch script mismatch')
  if (await realpath(join(home, '.dsh/node/bin/node')) !== proof.node.path || process.version !== proof.node.version) fail('installed Node runtime mismatch')
}
