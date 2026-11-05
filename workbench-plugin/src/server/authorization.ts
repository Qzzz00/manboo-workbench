/**
 * 授权表(2026-09-15,docs/设计-引导流程.md ③ / docs/设计-事务官完整材料.md §6)。
 *
 * 真相源是 `docs/记忆/授权.md`——一份 Markdown,Ben 能在 git 里手改;这里只是把它读成表、
 * 把引导里当场答的写回去。插件的写接口(/butler/item、/task/*)在放行**程序来源**
 * (不是页面、不是已配对手机)之前读一次 `write_api`:不是「可以」就 403 带人话。
 *
 * 三档:可以 / 要问 / 不可以;没答过是「未答」。默认按任务书:写 docs 与 commit 要问,
 * 写接口不可以,读的三项未答。「永远不动」那一节是写死的声明,不是表项,谁也改不了。
 *
 * 文件每次校验都看一眼 mtime:Ben 手改完不用重启。读坏了按默认表(最保守的那份)处理,
 * 不会因为文件格式错了就把门敞开。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuthKey } from './onboardingStages.ts'
import { AUTH_KEY_DESC, AUTH_READ_KEYS, AUTH_WRITE_KEYS } from './onboardingStages.ts'

export type AuthStatus = '可以' | '要问' | '不可以' | '未答'

export interface AuthEntry { status: AuthStatus, date?: string }
export type AuthTable = Record<AuthKey, AuthEntry>

export const NEVER_REQUEST = [
  '删文件(任何仓库、任何目录)',
  '改代码',
  '碰凭据、账号、密钥、cookie、token',
  '碰 ~/.dsh 生产目录、kickstart 重启 DSH',
] as const

export function defaultAuthTable(): AuthTable {
  return {
    read_scan_roots: { status: '未答' },
    read_session_titles: { status: '未答' },
    read_workbench_state: { status: '未答' },
    /**
     * 2026-09-22(Ben 定的 C5):读各家客户端的文件。
     * **缺省「要问」**(同 write_docs)—— 不是「未答」:这一项一出生就有后果
     * (拷记忆那条路按它放行),而"没答过"会被读成"随便读"。
     */
    read_client_files: { status: '要问' },
    /**
     * 2026-09-25(卡 N):看各家会话的最后几轮(进度靠证据)。**缺省「要问」**(同 read_client_files 的理由):
     * 第一次核进度要读时在外层问他一次,答了写进这一格。
     */
    read_session_content: { status: '要问' },
    write_docs: { status: '要问' },
    write_commit: { status: '要问' },
    write_api: { status: '不可以' },
  }
}

const STATUSES: readonly AuthStatus[] = ['可以', '要问', '不可以', '未答']

export function isAuthKey(value: unknown): value is AuthKey {
  return typeof value === 'string'
    && ((AUTH_READ_KEYS as readonly string[]).includes(value) || (AUTH_WRITE_KEYS as readonly string[]).includes(value))
}

/** 表 → Markdown。整份重写(它是机器维护的表,不是流水)。 */
export function renderAuthMarkdown(table: AuthTable, updatedAt: string): string {
  const row = (key: AuthKey): string => {
    const entry = table[key]
    return `| \`${key}\` | ${AUTH_KEY_DESC[key]} | ${entry.status} | ${entry.date ?? ''} |`
  }
  return [
    '# 授权:事务官能读什么、能写什么、永远不动什么',
    '',
    `> 真相源。只有他本人能改(引导里当场答的由阶段机代写,每次一 commit)。插件的写接口按这里校验:程序来源调 \`/butler/item\`、\`/task/*\` 时 \`write_api\` 不是「可以」就回 403。三档:可以 / 要问 / 不可以;没答过是「未答」。最后更新 ${updatedAt}。`,
    '',
    '## 能读什么',
    '',
    '| 项 | 说明 | 授权 | 日期 |',
    '|---|---|---|---|',
    ...AUTH_READ_KEYS.map(row),
    '',
    '## 能写什么',
    '',
    '| 项 | 说明 | 授权 | 日期 |',
    '|---|---|---|---|',
    ...AUTH_WRITE_KEYS.map(row),
    '',
    '## 永远不动(不请求、不商量)',
    '',
    ...NEVER_REQUEST.map(item => `- ${item}`),
    '',
    '> 「要问」= 每次动手前在对话里问一句,Ben 点头才做;「不可以」= 不做也不问。改这份文件就是改授权,改完 commit。',
    '',
  ].join('\n')
}

/** Markdown → 表。认不出来的行忽略;没出现的项按默认。 */
export function parseAuthMarkdown(text: string): AuthTable {
  const table = defaultAuthTable()
  for (const line of text.split('\n')) {
    const match = /^\|\s*`?([a-z_]+)`?\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line)
    if (match === null) continue
    const [, key, status, date] = match
    if (!isAuthKey(key) || !(STATUSES as readonly string[]).includes(status ?? '')) continue
    table[key] = { status: status as AuthStatus, ...(date === undefined || date === '' ? {} : { date }) }
  }
  return table
}

export interface AuthorizationService {
  /** 当前表(按 mtime 决定要不要重读)。 */
  get: () => Promise<AuthTable>
  /** 写一项并整份重写文件。 */
  set: (key: AuthKey, status: AuthStatus, date: string) => Promise<AuthTable>
  /** 只有「可以」算放行。读不到文件 = 默认表。 */
  isAllowed: (key: AuthKey) => Promise<boolean>
  /** 拒绝时的那句人话。 */
  denialMessage: (key: AuthKey) => string
  file: string
}

export function createAuthorizationService(options: { file: string }): AuthorizationService {
  let cached: { mtimeMs: number, table: AuthTable } | undefined

  async function load(): Promise<AuthTable> {
    let mtimeMs: number
    try {
      mtimeMs = (await stat(options.file)).mtimeMs
    }
    catch {
      cached = undefined
      return defaultAuthTable()
    }
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.table
    try {
      const table = parseAuthMarkdown(await readFile(options.file, 'utf8'))
      cached = { mtimeMs, table }
      return table
    }
    catch {
      return defaultAuthTable()
    }
  }

  return {
    file: options.file,
    get: load,
    async set(key, status, date) {
      const table = await load()
      table[key] = { status, date }
      await mkdir(dirname(options.file), { recursive: true })
      const tmp = `${options.file}.${randomUUID()}.tmp`
      await writeFile(tmp, renderAuthMarkdown(table, date), 'utf8')
      await rename(tmp, options.file)
      cached = undefined
      return table
    },
    async isAllowed(key) {
      return (await load())[key].status === '可以'
    },
    denialMessage(key) {
      return `事务官还没有这项授权:${AUTH_KEY_DESC[key]}(docs/记忆/授权.md 里 ${key} 不是「可以」)。要放开,在引导里答「可以」,或者他本人直接改那份文件。`
    },
  }
}
