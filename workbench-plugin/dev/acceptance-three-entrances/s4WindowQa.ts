/** Only the normal isolated runner opts into this pure-data factory configuration. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, symlink, copyFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { parseS4WindowQaConfig, s4WindowQaConfigDigest, S4_WINDOW_QA_ENV, S4_WINDOW_QA_RULE, type S4WindowQaConfig } from '../../src/server/s4WindowQaRules.ts'
import { dispatchMarker } from '../../src/server/dispatchReply.ts'
import type { HelperRequest } from '../../src/server/helperChannel.ts'

export function normalS4WindowQaEnvironment(root: string, home: string, raw?: string): Record<string, string> {
  const config = parseS4WindowQaConfig({ HOME: home, DSH_HOME: join(home, '.dsh'), [S4_WINDOW_QA_ENV]: raw })
  if (config === undefined) return {}
  if (config.root !== root) throw new Error('s4 QA helper root mismatch')
  return { [S4_WINDOW_QA_ENV]: JSON.stringify(config) }
}

export async function prepareNormalS4WindowQaProject(config?: S4WindowQaConfig): Promise<void> {
  if (config === undefined) return
  const repo = config.projectRepo
  await mkdir(join(repo, '..'), { recursive: true })
  await mkdir(repo) // Refuse an existing project; never overwrite its contents.
  await writeFile(join(repo, 'README.md'), '# 样片 QA\n\n仅受控运输验收项目，没有客户素材或个人数据。\n', { flag: 'wx' })
  const exec = promisify(execFile)
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: config.home, LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' }
  for (const argv of [
    ['init', '-q'], ['-c', 'core.hooksPath=/dev/null', 'add', 'README.md'],
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA S4', '-c', 'user.email=qa-s4@example.invalid', 'commit', '-qm', 'Initialize controlled sample project'],
    ['remote', 'add', 'origin', 'https://example.invalid/qa-s4/sample.git'],
  ]) await exec('git', argv, { cwd: repo, env })
}

export async function verifyNormalS4WindowQaBootstrap(config?: S4WindowQaConfig): Promise<void> {
  if (config === undefined) return
  const receipt = JSON.parse(await readFile(join(config.root, 's4-window-qa-bootstrap.json'), 'utf8')) as Record<string, unknown>
  if (receipt.version !== 1 || receipt.state !== 'configured' || receipt.config_sha256 !== s4WindowQaConfigDigest(config) || receipt.home !== config.home || receipt.profileDir !== config.profileDir) throw new Error('s4 QA bootstrap receipt mismatch')
}

export function normalS4RuntimePlan(config: S4WindowQaConfig, cache: string, head: string): { cache: string; target: string } {
  if (!isAbsolute(cache) || resolve(cache) !== cache || cache === config.root || cache.startsWith(config.root + sep) || head !== '477b4f420553e8a52c2fbccc464d7561b239c443') throw new Error('s4 QA requires a separate pinned public DSH cache')
  return { cache, target: join(config.home, '.dsh/runtime/locked-cache') }
}

/** Copy public compiled code only, never ~/.dsh profiles, settings, auth or model files. */
export async function prepareNormalS4Runtime(config: S4WindowQaConfig, cache: string): Promise<void> {
  const exec = promisify(execFile)
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: config.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }
  const head = (await exec('git', ['-C', cache, 'rev-parse', 'HEAD'], { env })).stdout.trim()
  const plan = normalS4RuntimePlan(config, cache, head)
  await mkdir(plan.target, { recursive: true })
  const codeDirectories = ['apps', 'packages', 'vendor', 'node_modules', 'lib', 'native', 'python']
  for (const name of codeDirectories) await exec('cp', ['-Rc', join(cache, name), join(plan.target, name)], { maxBuffer: 1 << 20 })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(join(cache, name), join(plan.target, name))
  const dsh = join(config.home, '.dsh')
  await mkdir(join(dsh, 'node/bin'), { recursive: true })
  await symlink(process.execPath, join(dsh, 'node/bin/node'))
  await mkdir(join(dsh, 'runtime/node_modules/@deepseek-ai'), { recursive: true })
  await symlink(join(plan.target, 'apps/cli'), join(dsh, 'runtime/node_modules/@deepseek-ai/dsh'))
  await mkdir(join(config.profileDir, 'node_modules'), { recursive: true })
  await writeFile(join(config.root, 's4-runtime-source.json'), JSON.stringify({ source: cache, head, target: plan.target, copied: codeDirectories, personalConfigurationCopied: false }), { mode: 0o600 })
}

/** Capture-only boundary: validates the actual request, never edits it or forwards to an App. */
export function auditS4WindowQaCapture(request: Extract<HelperRequest, { op: 'send_text' }>, task: { id: string; title: string }, expectedSubmit: boolean): void {
  const prefix = `【${dispatchMarker(task.id)}】${task.title}`
  if (request.bundle_id !== 'com.anthropic.claudefordesktop' || request.submit !== expectedSubmit || request.new_conversation !== true || !request.text.startsWith(prefix) || !request.text.endsWith(S4_WINDOW_QA_RULE) || request.text.split(S4_WINDOW_QA_RULE).length !== 2) throw new Error('QA_CAPTURE_REJECTED: original task/target/submit/safety mismatch; no window forwarded')
}
