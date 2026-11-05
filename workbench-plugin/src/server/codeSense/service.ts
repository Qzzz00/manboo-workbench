/**
 * 「看懂代码结构」的装 / 接 / 查 / 卸(2026-09-27,卡 SE)。碰磁盘的那一半。
 *
 * 纯判断全在 `agentConfig.ts`(哪一格该写、写进去长什么样、算不算被手改过),
 * 这一份只做四件事:读文件、写文件、跑那个装的脚本、数大小。
 *
 * **每个函数都收 `home`**,一处都不读 `process.env.HOME` —— 同 `setup/paths.ts` 的纪律:
 * 只要没有一处写死,「把整件事搬进临时 HOME 里跑」就是结构性成立的,不靠每个用例自己记得 mock。
 * 9/4 家目录被删那件事之后,这条不是洁癖。
 */
import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  configPathFor, isConnected, patchFor, unpatchFor, type CodeSensePatch, type CodeSenseTarget,
} from './agentConfig.ts'
import {
  CODE_SENSE_HOSTS, CODE_SENSE_PYTHON_VERSION, CODE_SENSE_SERENA_SPEC, CODE_SENSE_UV_VERSION,
  codeSenseInstalledJson, codeSenseRoot, codeSenseWrittenJson, type CodeSenseHost,
} from './manifest.ts'

/** written.json 的形状:每一家 → 我们上一次逐字写进去的那一段。 */
export type CodeSenseWritten = Partial<Record<CodeSenseHost['id'], string>>

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

export async function readWritten(home: string): Promise<CodeSenseWritten> {
  const raw = await readText(codeSenseWrittenJson(`${home}/.dsh`))
  if (raw === null) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as CodeSenseWritten : {}
  } catch { return {} }
}

async function saveWritten(home: string, v: CodeSenseWritten): Promise<void> {
  await writeText(codeSenseWrittenJson(`${home}/.dsh`), `${JSON.stringify(v, null, 2)}\n`)
}

/** 一个目录占多少字节。数不到(没权限、不存在)算 0 —— 设置页上宁可少说,不编。 */
export async function dirBytes(path: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const child = `${path}/${e.name}`
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { total += await dirBytes(child); continue }
    try { total += (await stat(child)).size } catch { /* 数不到就不数 */ }
  }
  return total
}

/** 设置页上那一格要显示的东西。**取不到就缺席,不编一个数**(总纲那条尺子)。 */
export interface CodeSenseStatus {
  installed: boolean
  /** 钉死的那几个版本号,装没装都答得出 —— 用户问「装的是哪一版」时不该先去装一遍。 */
  pinned: { serena: string, uv: string, python: string }
  /** 装了多大(字节)。没装时不给。 */
  bytes?: number | undefined
  installedAt?: string | undefined
  root: string
  /** 三家各自接没接上、以及上一次为什么没接上。 */
  hosts: { id: CodeSenseHost['id'], label: string, connected: boolean, configPath: string }[]
  /** 每个项目的索引占多大。只列传进来的那几个仓库根。 */
  indexes: { path: string, bytes: number }[]
}

export async function readStatus(home: string, repoRoots: readonly string[] = []): Promise<CodeSenseStatus> {
  const root = codeSenseRoot(`${home}/.dsh`)
  const raw = await readText(codeSenseInstalledJson(`${home}/.dsh`))
  const written = await readWritten(home)
  const hosts = await Promise.all(CODE_SENSE_HOSTS.map(async (h) => {
    const path = configPathFor(h.id, home)
    const text = await readText(path)
    const rec = written[h.id]
    return {
      id: h.id, label: h.label, configPath: path,
      connected: text !== null && isConnected(h.id, text, rec),
    }
  }))
  const indexes: { path: string, bytes: number }[] = []
  for (const r of repoRoots) {
    const b = await dirBytes(`${r}/.serena`)
    if (b > 0) indexes.push({ path: `${r}/.serena`, bytes: b })
  }
  const pinned = { serena: CODE_SENSE_SERENA_SPEC, uv: CODE_SENSE_UV_VERSION, python: CODE_SENSE_PYTHON_VERSION }
  if (raw === null) return { installed: false, pinned, root, hosts, indexes }
  let installedAt: string | undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (v !== null && typeof v === 'object' && 'installedAt' in v) installedAt = String((v as { installedAt: unknown }).installedAt)
  } catch { /* 读不出就不说 */ }
  return { installed: true, pinned, root, bytes: await dirBytes(root), installedAt, hosts, indexes }
}

// ---- 接上 / 摘掉 ------------------------------------------------------------

export interface CodeSenseWireResult {
  host: CodeSenseHost['id']
  label: string
  patch: CodeSensePatch
}

/**
 * 把三家都接上。**一家写坏不影响另外两家**:每一家各自读、各自判、各自写,
 * `ok: false` 的那家原样跳过并把话带回界面。
 */
export async function connectHosts(opts: {
  home: string
  /** 源码仓库根(事务官那一头要它当 cwd)。没有源码仓库的机器上不接事务官。 */
  repoRoot?: string | undefined
  /** 只接这几家。不给就三家都接。 */
  only?: readonly CodeSenseHost['id'][]
}): Promise<CodeSenseWireResult[]> {
  const { home, repoRoot, only } = opts
  const written = await readWritten(home)
  const runMcp = `${codeSenseRoot(`${home}/.dsh`)}/run-mcp`
  const out: CodeSenseWireResult[] = []
  for (const host of CODE_SENSE_HOSTS) {
    if (only !== undefined && !only.includes(host.id)) continue
    const path = configPathFor(host.id, home)
    const before = await readText(path)
    if (host.id === 'dsh' && before === null) {
      out.push({ host: host.id, label: host.label, patch: { ok: false, text: '', changed: false, reason: 'bad', say: '这台机器上没装事务官,这一头跳过。' } })
      continue
    }
    const t: CodeSenseTarget = { host, runMcp, cwd: repoRoot, recorded: written[host.id] }
    const patch = patchFor(host.id, before ?? '', t)
    if (patch.ok && patch.changed) {
      await writeText(path, patch.text)
      if (patch.wrote !== undefined) written[host.id] = patch.wrote
    } else if (patch.ok && patch.reason === 'already' && patch.wrote !== undefined) {
      written[host.id] = patch.wrote
    }
    out.push({ host: host.id, label: host.label, patch })
  }
  await saveWritten(home, written)
  return out
}

/** 三家都摘掉。只摘与我们记下的逐字相同的那一段,被改过的留着。 */
export async function disconnectHosts(opts: { home: string, only?: readonly CodeSenseHost['id'][] }): Promise<CodeSenseWireResult[]> {
  const { home, only } = opts
  const written = await readWritten(home)
  const runMcp = `${codeSenseRoot(`${home}/.dsh`)}/run-mcp`
  const out: CodeSenseWireResult[] = []
  for (const host of CODE_SENSE_HOSTS) {
    if (only !== undefined && !only.includes(host.id)) continue
    const path = configPathFor(host.id, home)
    const before = await readText(path)
    if (before === null) {
      out.push({ host: host.id, label: host.label, patch: { ok: true, text: '', changed: false, reason: 'absent', say: `${host.label} 那边本来就没接。` } })
      delete written[host.id]
      continue
    }
    const t: CodeSenseTarget = { host, runMcp, recorded: written[host.id] }
    const patch = unpatchFor(host.id, before, t)
    if (patch.ok && patch.changed) {
      await writeText(path, patch.text)
      delete written[host.id]
    } else if (patch.ok && patch.reason === 'absent') {
      delete written[host.id]
    }
    out.push({ host: host.id, label: host.label, patch })
  }
  await saveWritten(home, written)
  return out
}

// ---- 跑那个装的脚本 ---------------------------------------------------------

export interface CodeSenseRun { ok: boolean, code: number, out: string }

/**
 * 跑 `deploy/code-sense-install.sh`。**这件事只在有源码仓库的机器上成立** ——
 * 脚本就在仓库里,没仓库就没脚本,这一格在设置里也不出现(AGENTS.md 第一节:
 * 「改工作台自己」那条闭环只在有源码仓库的机器上跑)。
 *
 * `HOME` 与 `CODE_SENSE_ROOT` 都显式传进去,测试因此能把整件事关进临时目录。
 */
export function runInstaller(opts: {
  scriptPath: string
  action: 'install' | 'uninstall' | 'status'
  home: string
  /** 不给就用 `$HOME/.dsh/code-sense`。 */
  root?: string | undefined
  spawnFn?: typeof spawn
}): Promise<CodeSenseRun> {
  const { scriptPath, action, home, root, spawnFn = spawn } = opts
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    if (root !== undefined) env.CODE_SENSE_ROOT = root
    const child = spawnFn('bash', [scriptPath, action], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.on('error', (e: Error) => { resolve({ ok: false, code: -1, out: `${out}${e.message}` }) })
    child.on('close', (code: number | null) => { resolve({ ok: code === 0, code: code ?? -1, out }) })
  })
}
