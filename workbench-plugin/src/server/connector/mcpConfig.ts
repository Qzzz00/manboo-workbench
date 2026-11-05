/**
 * 把连接器接进**各家 Agent**的 MCP 配置里(卡 OC,2026-09-27)。全是纯函数:
 * 收一段原文、吐一段新文,不碰磁盘。
 *
 * | 谁 | 文件 | 形状 |
 * |---|---|---|
 * | Claude Code | `~/.claude.json` | JSON,`mcpServers["open-connector"]` |
 * | Codex | `~/.codex/config.toml` | TOML,`[mcp_servers.open-connector]` |
 * | 事务官(DSH) | `~/.dsh/profiles/web/cordis.patch.yml` | YAML 数组里一项 `@deepseek-ai/dsh-mcp-client` |
 *
 * ## 与卡 SE(看懂代码结构)刻意同构
 *
 * 同一天落地的卡 SE 已经把「把一台本机 MCP 服务接进这三家」做过一遍
 * (`server/codeSense/agentConfig.ts`)。这一份**照它的语义抄**,包括:
 *
 * - 「是不是我们写的」**靠记账**(`~/.dsh/open-connector/written.json` 记下我们上一次
 *   逐字写进去的那一段),**不靠往配置里塞一个自己的字段** ——
 *   Claude Code 与 Codex 对未知字段会报错,塞指纹是会出事的做法(卡 SE 文件头写明了这一点)。
 * - 四种下场:那一格不在 → 写(`written`);与要写的逐字相同 → 不动(`already`,这就是幂等);
 *   与**我们记下的**逐字相同但和这次要写的不同(换了端口) → 我们的,换掉(`written`);
 *   与我们记下的不同 → **她手改过,不动**(`user-edited`),并把这句人话原样说给她听。
 * - 认不得就不写(`bad`)。事务官那一份尤其:`cordis.patch.yml` 写坏一个字符,DSH 整个起不来。
 *
 * **两处同构的代码应当收成一份共用模块**,但那是一次跨卡重构,留给单独一张卡
 * (见 `docs/交接-0927-连接器通用能力.md` 第五节)。
 *
 * ## 不写令牌
 *
 * 三家写进去的一律是 `${OPEN_CONNECTOR_TOKEN}` **占位符**,真值只住在
 * `~/.dsh/workbench/connector.json`(0600),由启动脚本 / `connector-env` 现读现导。
 * 仓库纪律「不展示或写入 API Key、密码、Cookie、Token」在这里是逐字执行的。
 */
import { CONNECTOR_MCP_NAME } from './manifest.ts'

/** 各家 MCP 配置里都写这个占位符。 */
export const CONNECTOR_TOKEN_ENV = 'OPEN_CONNECTOR_TOKEN'
export const CONNECTOR_TOKEN_PLACEHOLDER = `\${${CONNECTOR_TOKEN_ENV}}`

export type McpPatchReason = 'written' | 'already' | 'user-edited' | 'absent' | 'bad'

/** 一次写入(或摘除)的结果。`text` 永远是「该落盘的全文」—— 没改时等于原文。 */
export interface McpPatch {
  /** 认得这份文件、可以落盘。false 时调用方**不许写**。 */
  ok: boolean
  text: string
  /** 与原文比有没有变。false 时不用落盘(少写一次就少错一次)。 */
  changed: boolean
  reason: McpPatchReason
  /** 界面上那一句人话。 */
  say: string
  /** 这一次我们逐字写进去的那一段,调用方存进 written.json。没写时不给。 */
  wrote?: string | undefined
}

export interface McpTargetInput {
  port: number
  /** 上一次我们写进去的逐字原文(written.json 里的)。没写过就不给。 */
  recorded?: string | undefined
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/* ---------------------------------------------------------------- */
/* Claude Code                                                       */
/* ---------------------------------------------------------------- */

/** 只写它认的那几个字段 —— **多写一个未知字段它会报错**。 */
export function claudeCodeEntry(t: McpTargetInput): unknown {
  return {
    type: 'http',
    url: mcpUrl(t.port),
    headers: { Authorization: `Bearer ${CONNECTOR_TOKEN_PLACEHOLDER}` },
  }
}

export function patchClaudeCode(text: string, t: McpTargetInput): McpPatch {
  const want = claudeCodeEntry(t)
  const wantText = JSON.stringify(want)
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '{}' : text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    doc = parsed as Record<string, unknown>
  } catch {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 的那份配置(不是一份完整的 JSON),这次没动它。' }
  }
  const servers = doc['mcpServers']
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 那份配置里的服务器清单,这次没动它。' }
  }
  const map: Record<string, unknown> = servers === undefined ? {} : { ...(servers as Record<string, unknown>) }
  const has = Object.prototype.hasOwnProperty.call(map, CONNECTOR_MCP_NAME)
  const cur = has ? JSON.stringify(map[CONNECTOR_MCP_NAME]) : undefined
  if (cur === wantText) return { ok: true, text, changed: false, reason: 'already', say: 'Claude Code 那边本来就接着了。', wrote: wantText }
  if (has && cur !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Claude Code 那边的这一条你自己改过,没覆盖它。' }
  }
  map[CONNECTOR_MCP_NAME] = want
  doc['mcpServers'] = map
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n`, changed: true, reason: 'written', say: '接上了 Claude Code。', wrote: wantText }
}

export function unpatchClaudeCode(text: string, t: McpTargetInput): McpPatch {
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '{}' : text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    doc = parsed as Record<string, unknown>
  } catch {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 的那份配置,这次没动它。' }
  }
  const servers = doc['mcpServers']
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: true, text, changed: false, reason: 'absent', say: 'Claude Code 那边本来就没接。' }
  }
  const map = { ...(servers as Record<string, unknown>) }
  if (!Object.prototype.hasOwnProperty.call(map, CONNECTOR_MCP_NAME)) {
    return { ok: true, text, changed: false, reason: 'absent', say: 'Claude Code 那边本来就没接。' }
  }
  if (JSON.stringify(map[CONNECTOR_MCP_NAME]) !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Claude Code 那边的这一条你自己改过,留着没删 —— 要去掉自己删一下。' }
  }
  delete map[CONNECTOR_MCP_NAME]
  // 摘完只剩空壳就把 `mcpServers` 这个键也去掉 —— 「卸干净」的意思是回到没写过时那样。
  if (Object.keys(map).length === 0) delete doc['mcpServers']
  else doc['mcpServers'] = map
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n`, changed: true, reason: 'written', say: '从 Claude Code 摘掉了。' }
}

/* ---------------------------------------------------------------- */
/* Codex                                                            */
/* ---------------------------------------------------------------- */

const CODEX_TABLE = `[mcp_servers.${CONNECTOR_MCP_NAME}]`
const CODEX_SUBTABLE_PREFIX = `[mcp_servers.${CONNECTOR_MCP_NAME}.`

export function codexBlock(t: McpTargetInput): string {
  return [
    CODEX_TABLE,
    `url = "${mcpUrl(t.port)}"`,
    '',
    `${CODEX_SUBTABLE_PREFIX}http_headers]`,
    `Authorization = "Bearer ${CONNECTOR_TOKEN_PLACEHOLDER}"`,
    '',
  ].join('\n')
}

/**
 * TOML 不做通用解析(写坏了 Codex 起不来)。只认「一段从 `[mcp_servers.open-connector]` 起、
 * 到下一个不属于它的顶层 `[` 为止」的块,整块比、整块换。
 */
export function patchCodex(text: string, t: McpTargetInput): McpPatch {
  const want = codexBlock(t)
  if (text.trim() === '') {
    return { ok: true, text: want, changed: true, reason: 'written', say: '接上了 Codex。', wrote: want }
  }
  const found = findCodexBlock(text)
  if (!found) {
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    return { ok: true, text: `${text}${sep}${want}`, changed: true, reason: 'written', say: '接上了 Codex。', wrote: want }
  }
  const cur = text.slice(found.start, found.end)
  if (cur === want) return { ok: true, text, changed: false, reason: 'already', say: 'Codex 那边本来就接着了。', wrote: want }
  if (cur !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Codex 那边的这一段你自己改过,没覆盖它。' }
  }
  return { ok: true, text: `${text.slice(0, found.start)}${want}${text.slice(found.end)}`, changed: true, reason: 'written', say: '接上了 Codex。', wrote: want }
}

export function unpatchCodex(text: string, t: McpTargetInput): McpPatch {
  if (text.trim() === '') return { ok: true, text, changed: false, reason: 'absent', say: 'Codex 那边本来就没接。' }
  const found = findCodexBlock(text)
  if (!found) return { ok: true, text, changed: false, reason: 'absent', say: 'Codex 那边本来就没接。' }
  const cur = text.slice(found.start, found.end)
  if (cur !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Codex 那边的这一段你自己改过,留着没删 —— 要去掉自己删一下。' }
  }
  return { ok: true, text: `${text.slice(0, found.start)}${text.slice(found.end)}`, changed: true, reason: 'written', say: '从 Codex 摘掉了。' }
}

function findCodexBlock(text: string): { start: number, end: number } | undefined {
  const lines = text.split('\n')
  let startIndex = -1
  let startOffset = -1
  let offset = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (startIndex < 0 && line.trim() === CODEX_TABLE) { startIndex = i; startOffset = offset }
    offset += line.length + 1
  }
  if (startIndex < 0) return undefined
  let endOffset = text.length
  let cursor = startOffset + (lines[startIndex]?.length ?? 0) + 1
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && !trimmed.startsWith(CODEX_SUBTABLE_PREFIX)) { endOffset = cursor; break }
    cursor += line.length + 1
  }
  return { start: startOffset, end: endOffset }
}

/* ---------------------------------------------------------------- */
/* 事务官(DSH profile 的补丁层)                                      */
/* ---------------------------------------------------------------- */

export const DSH_PATCH_ENTRY_ID = `mcp-${CONNECTOR_MCP_NAME}`

/**
 * 一项 `dsh-mcp-client`(上游 `serverName` 限 `[A-Za-z0-9_-]{1,32}`,`open-connector` 合规)。
 * 令牌走 `!!js` 读环境变量 —— **补丁层里没有令牌原文**。
 */
export function dshBlock(t: McpTargetInput): string {
  /*
   * 2026-09-27 12:05 事故(统筹):原来写成顶层 `- id:` + 不带引号的 `!!js \`Bearer …\``。
   * ① YAML 里反引号不能起头,真 dsh 读补丁层当场抛错,**整个工作台服务起不来**;
   * ② 顶层 `- id:` 是「改一项已有的」,加一项新的要走 `- insert:`(同登录台写插件那一项)。
   * 现在照上游 dsh-mcp-client README 的写法:值用单引号包住整个模板字符串。
   * 守门:tests/install-shape-connector-patch.test.ts 拿装着的真 dsh `--dump-config` 验。
   */
  return [
    '- insert:',
    `    - id: ${DSH_PATCH_ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${CONNECTOR_MCP_NAME}`,
    '        transport: streamable-http',
    `        url: ${mcpUrl(t.port)}`,
    '        headers:',
    `          Authorization: !!js '\`Bearer \${process.env.${CONNECTOR_TOKEN_ENV}}\`'`,
    '',
  ].join('\n')
}

/** 12:05 之前写出去的那一版(坏的):见到它就当成我们的、直接换掉,不当成「他自己改过」。 */
export function legacyBrokenDshBlock(t: McpTargetInput): string {
  return [
    `- id: ${DSH_PATCH_ENTRY_ID}`,
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    `    serverName: ${CONNECTOR_MCP_NAME}`,
    '    transport: streamable-http',
    `    url: ${mcpUrl(t.port)}`,
    '    headers:',
    `      Authorization: !!js \`Bearer \${process.env.${CONNECTOR_TOKEN_ENV}}\``,
    '',
  ].join('\n')
}

export function patchDsh(text: string, t: McpTargetInput): McpPatch {
  const want = dshBlock(t)
  if (text.trim() === '') {
    return { ok: true, text: want, changed: true, reason: 'written', say: '接上了事务官。', wrote: want }
  }
  const bad = dshUnreadable(text)
  if (bad) return { ok: false, text, changed: false, reason: 'bad', say: bad }
  const found = findDshBlock(text)
  if (!found) {
    const sep = text.endsWith('\n') ? '' : '\n'
    return { ok: true, text: `${text}${sep}${want}`, changed: true, reason: 'written', say: '接上了事务官。', wrote: want }
  }
  const cur = text.slice(found.start, found.end)
  if (cur === want) return { ok: true, text, changed: false, reason: 'already', say: '事务官那边本来就接着了。', wrote: want }
  // 12:05 之前写坏的那一版(或任何带着那一行不加引号反引号的):一定是我们写的,换掉 —— 留着它 DSH 就起不来。
  const brokenOurs = cur === legacyBrokenDshBlock(t) || /Authorization: !!js `/.test(cur)
  if (cur !== t.recorded && !brokenOurs) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: '事务官那边的这一项你自己改过,没覆盖它。' }
  }
  return { ok: true, text: `${text.slice(0, found.start)}${want}${text.slice(found.end)}`, changed: true, reason: 'written', say: '接上了事务官。', wrote: want }
}

export function unpatchDsh(text: string, t: McpTargetInput): McpPatch {
  if (text.trim() === '') return { ok: true, text, changed: false, reason: 'absent', say: '事务官那边本来就没接。' }
  const bad = dshUnreadable(text)
  if (bad) return { ok: false, text, changed: false, reason: 'bad', say: bad }
  const found = findDshBlock(text)
  if (!found) return { ok: true, text, changed: false, reason: 'absent', say: '事务官那边本来就没接。' }
  const cur = text.slice(found.start, found.end)
  if (cur !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: '事务官那边的这一项你自己改过,留着没删 —— 要去掉自己删一下。' }
  }
  return { ok: true, text: `${text.slice(0, found.start)}${text.slice(found.end)}`, changed: true, reason: 'written', say: '从事务官摘掉了。' }
}

/** 认不得的几种样子 —— 与 `dshProfilePatch.ts` 同一套判据。 */
function dshUnreadable(text: string): string | undefined {
  if (text.includes('\t')) return '事务官那份补丁层里有制表符,认不得,这次没动它。'
  if (/^---\s*$/m.test(text)) return '事务官那份补丁层是多文档 YAML,认不得,这次没动它。'
  const first = text.split('\n').find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
  if (first !== undefined && !first.startsWith('- ')) return '事务官那份补丁层顶层不是一个数组,认不得,这次没动它。'
  return undefined
}

function findDshBlock(text: string): { start: number, end: number } | undefined {
  const lines = text.split('\n')
  let startIndex = -1
  let startOffset = -1
  let offset = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (startIndex < 0 && line.trim() === `- id: ${DSH_PATCH_ENTRY_ID}`) { startIndex = i; startOffset = offset }
    offset += line.length + 1
  }
  if (startIndex < 0) return undefined
  // 包在 `- insert:` 里的那一版:整块从 `- insert:` 那一行算起。
  const prev = lines[startIndex - 1]
  if ((lines[startIndex] ?? '').startsWith(' ') && prev !== undefined && prev.trim() === '- insert:') {
    startIndex -= 1
    startOffset -= prev.length + 1
  }
  let endOffset = text.length
  let cursor = startOffset + (lines[startIndex]?.length ?? 0) + 1
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.startsWith('- ')) { endOffset = cursor; break }
    cursor += line.length + 1
  }
  return { start: startOffset, end: endOffset }
}

/* ---------------------------------------------------------------- */

export type McpHostId = 'dsh' | 'claude-code' | 'codex'

export interface McpHost {
  id: McpHostId
  /** 给界面看的名字。 */
  label: string
  file: (home: string) => string
  patch: (text: string, t: McpTargetInput) => McpPatch
  unpatch: (text: string, t: McpTargetInput) => McpPatch
}

/** 三家的表。要多接一家能挂 MCP 的,在这里加一行 + 一对 patch/unpatch。 */
export const MCP_HOSTS: readonly McpHost[] = [
  { id: 'dsh', label: '事务官(DSH)', file: (home) => `${home}/.dsh/profiles/web/cordis.patch.yml`, patch: patchDsh, unpatch: unpatchDsh },
  { id: 'claude-code', label: 'Claude Code', file: (home) => `${home}/.claude.json`, patch: patchClaudeCode, unpatch: unpatchClaudeCode },
  { id: 'codex', label: 'Codex', file: (home) => `${home}/.codex/config.toml`, patch: patchCodex, unpatch: unpatchCodex },
]

/** written.json 的形状:每一家 → 我们上一次逐字写进去的那一段。 */
export type McpWritten = Partial<Record<McpHostId, string>>

export function parseMcpWritten(text: string | undefined): McpWritten {
  if (!text) return {}
  try {
    const j: unknown = JSON.parse(text)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
    const out: McpWritten = {}
    for (const host of MCP_HOSTS) {
      const v = (j as Record<string, unknown>)[host.id]
      if (typeof v === 'string') out[host.id] = v
    }
    return out
  } catch {
    return {}
  }
}
