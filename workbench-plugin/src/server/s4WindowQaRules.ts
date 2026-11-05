import type { DispatchRunDeps } from './dispatchRun.ts'
import type { TasksService } from './tasks.ts'
import type { WorkbenchProject } from '../protocol.ts'
import { realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const S4_WINDOW_QA_ENV = 'WORKBENCH_S4_WINDOW_QA'
export const S4_WINDOW_QA_RULE = '本次为受控运输验收，唯一任务只回复QA_S4_CLAUDE_RECEIPT；不用工具、不读写仓库/统筹state、不建子代理、不声称剪辑成品。'
export interface S4WindowQaConfig {
  version: 1
  enabled: true
  root: string
  home: string
  profileDir: string
  projectId: string
  projectRepo: string
}
export type S4WindowQaRulesFor = NonNullable<DispatchRunDeps['rulesFor']>
export interface S4WindowQaRulesInput {
  env: Record<string, string | undefined>
  tasks: Pick<TasksService, 'list'>
  projects: () => Promise<readonly Pick<WorkbenchProject, 'id' | 'path'>[]>
  ordinaryRulesFor: S4WindowQaRulesFor
}
/** Pure JSON only; no filename, code loader or user-level configuration lookup. */
export function parseS4WindowQaConfig(env: Record<string, string | undefined>): S4WindowQaConfig | undefined {
  const raw = env[S4_WINDOW_QA_ENV]
  if (raw === undefined || raw === '') return undefined
  if (raw.length > 16_384) throw new Error('s4 QA config too large')
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid s4 QA config')
  const c = value as Record<string, unknown>
  if (c.enabled === false && Object.keys(c).length === 1) return undefined
  const keys = ['version', 'enabled', 'root', 'home', 'profileDir', 'projectId', 'projectRepo']
  if (Object.keys(c).length !== keys.length || keys.some(key => !(key in c)) || c.version !== 1 || c.enabled !== true) throw new Error('invalid s4 QA config fields')
  for (const key of ['root', 'home', 'profileDir', 'projectRepo']) {
    if (typeof c[key] !== 'string' || !isAbsolute(c[key]) || resolve(c[key]) !== c[key]) throw new Error('s4 QA requires exact absolute paths')
  }
  const config = c as unknown as S4WindowQaConfig
  if (config.root === '/' || config.home !== join(config.root, 'iso/home') || env.HOME !== config.home || env.DSH_HOME !== join(config.home, '.dsh') || config.profileDir !== join(config.home, '.dsh/profiles/web') || config.projectRepo !== join(config.home, 'Documents/GitHub/样片') || config.projectId !== '样片') throw new Error('s4 QA instance/profile/project mismatch')
  return config
}

export function s4WindowQaConfigDigest(config: S4WindowQaConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

/** Internal opt-in decorator of the existing dispatchRules.rulesFor option. */
export async function createS4WindowQaRules(input: S4WindowQaRulesInput): Promise<S4WindowQaRulesFor | undefined> {
  const config = parseS4WindowQaConfig(input.env)
  if (config === undefined) return undefined
  const canonicalRoot = await realpath(config.root)
  const assertCanonical = async (path: string): Promise<void> => {
    if (await realpath(path) !== join(canonicalRoot, relative(config.root, path))) throw new Error('s4 QA symlink escapes canonical instance')
  }
  for (const path of [config.home, join(config.home, '.dsh'), config.profileDir, config.projectRepo]) await assertCanonical(path)
  const initial = await input.tasks.list()
  if (initial.problem !== undefined) throw new Error('s4 QA task store unavailable')
  const oldIds = new Set(initial.tasks.map(task => task.id))
  // A fresh profile gets a single bootstrap receipt; stale receipts cannot certify a new boot.
  await writeFile(join(config.root, 's4-window-qa-bootstrap.json'), JSON.stringify({ version: 1, state: 'configured', config_sha256: s4WindowQaConfigDigest(config), home: config.home, profileDir: config.profileDir, baselineTasks: oldIds.size }), { mode: 0o600, flag: 'wx' })
  let chosen: string | undefined
  return async request => {
    const ordinary = await input.ordinaryRulesFor(request)
    if (request.kind !== 'chat' || oldIds.has(request.taskId) || (chosen !== undefined && chosen !== request.taskId)) return ordinary
    // The execution owner supplies this internal context after resolving family/assignee.
    // Missing context remains out of scope, including older production hosts.
    const dispatch = request.dispatch
    if (dispatch === undefined) return ordinary
    if (dispatch.family !== 'claude' || dispatch.assignee !== 'claude' || dispatch.target !== 'new') return ordinary
    const state = await input.tasks.list()
    if (state.problem !== undefined) throw new Error('s4 QA task store unavailable')
    const task = state.tasks.find(one => one.id === request.taskId)
    if (task === undefined || task.project_id !== config.projectId || (task.assignee !== undefined && task.assignee !== dispatch.assignee) || task.title !== request.said || task.links?.length || task.conversation !== undefined || task.dispatch !== undefined || task.client_dispatch !== undefined || task.status === 'done' || task.status === 'canceled') return ordinary
    const projects = (await input.projects()).filter(project => project.id === config.projectId)
    if (projects.length !== 1 || projects[0]?.path !== config.projectRepo) return ordinary
    await assertCanonical(config.projectRepo)
    // Re-check after awaits: concurrent requests cannot claim two different tasks.
    if (chosen !== undefined && chosen !== task.id) return ordinary
    chosen = task.id
    return ordinary === undefined || ordinary === '' ? S4_WINDOW_QA_RULE : `${ordinary}\n\n${S4_WINDOW_QA_RULE}`
  }
}
