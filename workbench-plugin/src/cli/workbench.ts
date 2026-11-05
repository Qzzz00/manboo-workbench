/**
 * `workbench` 命令行(2026-10-21 协作区;待拍板 12 已定)。给工程师与脚本、别家 agent 用:
 * **薄壳打本机 8791**,自己不碰任何文件 —— 门(四样、回执三态、授权)全在服务端。普通用户的入口仍是设置页与板,
 * 不以命令行作为使用入口(AGENTS.md)。
 *
 * 认两个环境变量:`WORKBENCH_URL`(默认本机 8791)、`WORKBENCH_TOKEN`(设置页里发的个人访问令牌;
 * 不带的话写接口要看授权表放没放开)。令牌只放在环境变量里,命令行参数里不收(会进 shell 历史)。
 */
import { pathToFileURL } from 'node:url'

export const DEFAULT_WORKBENCH_URL = 'http://127.0.0.1:8791'

export const USAGE = `workbench —— 协作区的命令行(打本机 8791)

  note list [--goal <id>] [--status <章>]
  note create --title <标题> --from <来源> --accept <一条> [--accept …] --assignee <谁> [--goal <id>] [--project <id>]
              来源:said:<原话> | meeting:<会议 id> | session:<家>:<会话 id> | channel:<id> | evidence:<一句> | user
  note move <id> <backlog|todo|doing|confirm|done|blocked|canceled>
  note receipt <id> <done|objection|blocked> <那一句> [--evidence <路径>]… [--by <家>]
  note comment <id> <一句>
  goal list
  goal create --title <一句话> [--why <为什么>] [--due YYYY-MM-DD] [--project <id>] [--version <版本>]
  goal update <id> [--title …] [--why …] [--due …] [--status open|reached|dropped]
  agent list
  agent create --name <名字> --hand <登记表里的家> [--good-at <擅长>] [--skills a,b] [--shared workspace|none]
  agent update <id> [--name …] [--hand …] [--good-at …] [--skills …]
  agent copy <id> [--name <新名字>]
  migrate run | migrate rollback

环境变量:WORKBENCH_URL(默认 ${DEFAULT_WORKBENCH_URL})、WORKBENCH_TOKEN(设置页发的个人访问令牌)`

export type Plan =
  | { method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, pick?: 'notes' | 'goals' | 'agents' }
  | { copy: string, name?: string }
  | { help: string }
  | { error: string }

/** `--key value` 拆出来;同一个键给几次就收几次。剩下的是位置参数。 */
function parseFlags(args: readonly string[]): { flags: Record<string, string[]>, rest: string[] } {
  const flags: Record<string, string[]> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const one = args[i] as string
    if (one.startsWith('--')) {
      const key = one.slice(2)
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { (flags[key] ??= []).push(''); continue }
      ;(flags[key] ??= []).push(value)
      i += 1
    }
    else rest.push(one)
  }
  return { flags, rest }
}

const first = (flags: Record<string, string[]>, key: string): string | undefined => flags[key]?.[0]

/** `--from` 那几种写法 → `{kind, ref?, quote?}`。 */
function fromOf(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined || text === '') return undefined
  const at = text.indexOf(':')
  const kind = at === -1 ? text : text.slice(0, at)
  const rest = at === -1 ? '' : text.slice(at + 1)
  if (kind === 'said' || kind === 'evidence') return { kind, ...(rest === '' ? {} : { quote: rest }) }
  if (kind === 'meeting' || kind === 'session' || kind === 'channel') return { kind, ...(rest === '' ? {} : { ref: rest }) }
  if (kind === 'user') return { kind }
  return { kind }
}

function pickDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

export function planCommand(argv: readonly string[]): Plan {
  const [group, action, ...args] = argv
  if (group === undefined || group === 'help' || group === '--help' || group === '-h') return { help: USAGE }
  const { flags, rest } = parseFlags(args)
  const unknown: Plan = { error: `不认识的命令:${[group, action ?? ''].join(' ').trim()}\n\n${USAGE}` }

  if (group === 'note') {
    if (action === 'list') return { method: 'GET', path: '/state', pick: 'notes' }
    if (action === 'create') {
      return {
        method: 'POST', path: '/task/create',
        body: pickDefined({
          title: first(flags, 'title'),
          // 明说是便签形状:四样的门一定会查(缺一样服务端回 400 说缺哪几样)。
          note: true,
          from: fromOf(first(flags, 'from')),
          acceptance: flags.accept,
          assignee: first(flags, 'assignee'),
          goal_id: first(flags, 'goal'),
          project_id: first(flags, 'project'),
        }),
      }
    }
    if (action === 'move') return { method: 'POST', path: '/task/move', body: { id: rest[0], status: rest[1] } }
    if (action === 'receipt') {
      return {
        method: 'POST', path: '/task/receipt',
        body: pickDefined({ id: rest[0], receipt: rest[1], text: rest[2], evidence: flags.evidence, by: first(flags, 'by') }),
      }
    }
    if (action === 'comment') return { method: 'POST', path: '/task/comment', body: { id: rest[0], text: rest[1] } }
    return unknown
  }

  if (group === 'goal') {
    if (action === 'list') return { method: 'GET', path: '/state', pick: 'goals' }
    const fields = pickDefined({
      title: first(flags, 'title'), why: first(flags, 'why'), due: first(flags, 'due'),
      project_id: first(flags, 'project'), version: first(flags, 'version'), status: first(flags, 'status'),
    })
    if (action === 'create') return { method: 'POST', path: '/collab/goal/create', body: fields }
    if (action === 'update') return { method: 'POST', path: '/collab/goal/update', body: { id: rest[0], ...fields } }
    return unknown
  }

  if (group === 'agent') {
    if (action === 'list') return { method: 'GET', path: '/state', pick: 'agents' }
    const skills = first(flags, 'skills')
    const shared = first(flags, 'shared')
    const fields = pickDefined({
      name: first(flags, 'name'), hand: first(flags, 'hand'), good_at: first(flags, 'good-at'),
      skills: skills === undefined ? undefined : skills.split(',').map(one => one.trim()).filter(one => one !== ''),
      shared: shared === undefined ? undefined : { to: shared === 'workspace' ? 'workspace' : 'none' },
    })
    if (action === 'create') return { method: 'POST', path: '/collab/agent/save', body: fields }
    if (action === 'update') return { method: 'POST', path: '/collab/agent/save', body: { id: rest[0], ...fields } }
    if (action === 'copy' && rest[0] !== undefined) return { copy: rest[0], ...(first(flags, 'name') === undefined ? {} : { name: first(flags, 'name') as string }) }
    return unknown
  }

  if (group === 'migrate') {
    if (action === 'run') return { method: 'POST', path: '/collab/migrate', body: {} }
    if (action === 'rollback') return { method: 'POST', path: '/collab/migrate/rollback', body: {} }
    return unknown
  }
  return unknown
}

type Env = Record<string, string | undefined>

async function call(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const base = (env.WORKBENCH_URL ?? DEFAULT_WORKBENCH_URL).replace(/\/+$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.WORKBENCH_TOKEN !== undefined && env.WORKBENCH_TOKEN !== '') headers.authorization = `Bearer ${env.WORKBENCH_TOKEN}`
  const res = await fetch(`${base}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, json }
}

/** 跑一条命令。回退出码(0 = 办成了);输出一行一行交给 `print`(用例里收起来看)。 */
export async function runCli(argv: readonly string[], env: Env, print: (line: string) => void): Promise<number> {
  const plan = planCommand(argv)
  if ('help' in plan) { print(plan.help); return 0 }
  if ('error' in plan) { print(plan.error); return 2 }
  try {
    if ('copy' in plan) {
      const state = await call(env, 'GET', '/state')
      const cards = ((state.json.tasks as Record<string, unknown> | undefined)?.agent_cards ?? []) as Record<string, unknown>[]
      const source = cards.find(one => one.id === plan.copy)
      if (source === undefined) { print(`没有这张名片:${plan.copy}`); return 1 }
      const made = await call(env, 'POST', '/collab/agent/save', {
        name: plan.name ?? `${String(source.name)}(副本)`, hand: source.hand,
        ...(source.good_at === undefined ? {} : { good_at: source.good_at }),
        ...(source.skills === undefined ? {} : { skills: source.skills }),
        ...(source.shared === undefined ? {} : { shared: source.shared }),
      })
      print(JSON.stringify(made.json, null, 2))
      return made.status >= 200 && made.status < 300 ? 0 : 1
    }
    const got = await call(env, plan.method, plan.path, plan.body)
    if (got.status < 200 || got.status >= 300) {
      print(typeof got.json.error === 'string' ? got.json.error : `没办成(HTTP ${got.status})`)
      return 1
    }
    if (plan.pick !== undefined) {
      const tasks = (got.json.tasks ?? {}) as Record<string, unknown>
      const picked = plan.pick === 'notes' ? tasks.tasks : plan.pick === 'goals' ? tasks.goals : tasks.agent_cards
      const list = Array.isArray(picked) ? picked as Record<string, unknown>[] : []
      const goal = plan.pick === 'notes' ? argv[argv.indexOf('--goal') + 1] : undefined
      const status = plan.pick === 'notes' ? argv[argv.indexOf('--status') + 1] : undefined
      const filtered = list.filter(one => (!argv.includes('--goal') || one.goal_id === goal) && (!argv.includes('--status') || one.status === status))
      print(JSON.stringify(filtered, null, 2))
      return 0
    }
    print(JSON.stringify(got.json, null, 2))
    return 0
  }
  catch (error) {
    print(`工作台服务没应答(${env.WORKBENCH_URL ?? DEFAULT_WORKBENCH_URL}):${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// 直接跑这个文件(`node lib/workbench.js …`)时才动;被 import(用例)时什么都不做。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli(process.argv.slice(2), process.env, line => console.log(line)).then((code) => { process.exitCode = code })
}
