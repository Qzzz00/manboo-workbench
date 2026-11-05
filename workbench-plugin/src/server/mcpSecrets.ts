/**
 * 工作室 MCP 库的**密钥值**(2026-10-21 协作区全量,视觉需求第 12 屏)。库里只有名字;值只在这台电脑的
 * `~/.dsh/workbench/mcp-secrets.json`(600)。**这份文件里的值永不回给界面**:对外只说哪几个名字填过。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function defaultMcpSecretsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/mcp-secrets.json`
}

export interface McpSecrets {
  /** 填一把(value 空 = 清掉)。 */
  set: (name: string, value: string | null) => Promise<void>
  /** 填过哪几个名字。 */
  names: () => Promise<Set<string>>
}

export function createMcpSecrets(opts: { file: string }): McpSecrets {
  async function read(): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(opts.file, 'utf8')) as { values?: Record<string, unknown> }
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw.values ?? {})) if (typeof value === 'string' && value !== '') out[key] = value
      return out
    }
    catch { return {} }
  }
  return {
    async set(name, value) {
      const values = await read()
      if (value === null || value.trim() === '') delete values[name]
      else values[name] = value.trim()
      await mkdir(dirname(opts.file), { recursive: true })
      const tmp = `${opts.file}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify({ values }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, opts.file)
    },
    async names() {
      return new Set(Object.keys(await read()))
    },
  }
}
