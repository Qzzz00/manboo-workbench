/** Build/pack provenance only. This entry never imports the normal instance or any window/room driver. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { snapshotS4Sources, s4BundleHashes, verifyS4PackedBundle, verifyS4SourceProof, type S4SourceProof } from './s4SourceProof.ts'
const exec = promisify(execFile)
export async function prepareS4SourceProof(repo: string, expected: string | undefined, proofRoot: string | undefined): Promise<void> {
  if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error('S4 source proof: expected fixed full SHA required')
  if (!proofRoot || !isAbsolute(proofRoot) || resolve(proofRoot) !== proofRoot || proofRoot === '/' || proofRoot === resolve(repo)) throw new Error('S4 source proof: explicit evidence root required')
  await mkdir(proofRoot, { recursive: true, mode: 0o700 })
  if (await realpath(proofRoot) !== proofRoot || existsSync(join(proofRoot, 'source-proof.json'))) throw new Error('S4 source proof: canonical fresh evidence root required')
  const before = await snapshotS4Sources(repo, expected, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  const plugin = join(before.repo, 'workbench-plugin'), home = join(proofRoot, 'npm-home')
  await mkdir(home)
  const globalConfig = join(proofRoot, 'empty-global-npmrc'); await writeFile(globalConfig, '', { mode: 0o600, flag: 'wx' })
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: globalConfig, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }
  const commands: [string, string, string[]][] = [
    ['gen-skills', process.execPath, ['scripts/gen-bundled-skills.mjs']],
    ['tsdown', join(plugin, 'node_modules/.bin/tsdown'), []],
    ['starter-layer', process.execPath, ['scripts/copy-starter-layer.mjs']],
    ['archify-assets', process.execPath, ['scripts/copy-archify-assets.mjs']],
    ['npm-pack', 'npm', ['pack', '--json', '--pack-destination', proofRoot]],
  ]
  let pack = ''
  for (const [name, command, args] of commands) {
    const at = Date.now()
    try {
      const { stdout, stderr } = await exec(command, args, { cwd: plugin, env, maxBuffer: 32 << 20, timeout: 300_000 })
      await writeFile(join(proofRoot, name + '.log'), stdout + stderr)
      await writeFile(join(proofRoot, name + '.exit'), '0\n')
      console.log(`${name}: exit0 (${Date.now() - at}ms)`)
      if (name === 'npm-pack') pack = (JSON.parse(stdout) as { filename: string }[])[0]!.filename
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number }
      await writeFile(join(proofRoot, name + '.log'), (e.stdout ?? '') + (e.stderr ?? '') + String(error))
      await writeFile(join(proofRoot, name + '.exit'), String(e.code ?? 1) + '\n')
      throw error
    }
  }
  const after = await snapshotS4Sources(repo, expected, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('S4 source proof: source changed during build')
  const proof: S4SourceProof = { version: 1, ...after, bundle: await s4BundleHashes(before.repo), archive: { file: pack, sha256: createHash('sha256').update(await readFile(join(proofRoot, pack))).digest('hex') } }
  await verifyS4PackedBundle(proof, join(proofRoot, pack))
  await writeFile(join(proofRoot, 'source-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const checked = await verifyS4SourceProof(repo, expected, proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  await writeFile(join(proofRoot, 'source-verification.json'), JSON.stringify({ ...checked, artifactOnly: true, servicesStarted: 0, permitsCreated: 0, realUnderstandingCalls: 0, windowCalls: 0 }, null, 2) + '\n')
  console.log(JSON.stringify({ currentGitSHA: checked.currentGitSHA, expectedFixedSHA: checked.expectedFixedSHA, worker: checked.worker, archive: checked.archive, artifactOnly: true }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareS4SourceProof(resolve(import.meta.dirname, '../../..'), process.env.S4_QA_EXPECTED_FIXED_SHA, process.env.S4_QA_PROOF_ROOT)
}
