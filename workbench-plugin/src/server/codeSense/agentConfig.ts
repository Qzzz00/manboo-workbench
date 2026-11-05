/**
 * 把「看懂代码结构」这台 MCP 服务器**幂等地**写进各家的配置里,以及**干净地**摘出来
 * (2026-09-27,卡 SE)。全是纯函数:收一段原文、吐一段新文,不碰磁盘。
 *
 * ## 三家各写在哪(2026-09-27 逐个核过)
 *
 * | 家 | 文件 | 形状 |
 * |---|---|---|
 * | Claude Code | `~/.claude.json` | JSON,`mcpServers["code-sense"]` |
 * | Codex | `~/.codex/config.toml` | TOML,`[mcp_servers.code-sense]` |
 * | 事务官(DSH) | `~/.dsh/profiles/web/cordis.patch.yml` | YAML,一条 `insert:` 补丁挂 `@deepseek-ai/dsh-mcp-client` |
 *
 * 别的能挂 MCP 的家(Claude Desktop、Cursor、VSCode、JetBrains)这一版**不自动写** ——
 * 它们不在这台机器的研发闭环里,写进去等于替用户做主。设计文档第五节里留了一张表,
 * 要加的时候照着加一条就行。
 *
 * ## 「幂等且不覆盖用户手改」到底怎么做到的
 *
 * 靠**记住我们上一次逐字写进去的是什么**(`~/.dsh/code-sense/written.json`),而不是靠
 * 「看起来像我们写的」。每次写之前比一次:
 *
 * - 那一格**不在** → 写进去(`written`)。
 * - 那一格在,而且**与我们要写的逐字相同** → 什么都不做(`already`)。这就是幂等。
 * - 那一格在,**与我们记下的上一次逐字相同**(但与这次要写的不同,比如换了版本) → 我们的,换掉(`written`)。
 * - 那一格在,**与我们记下的不同** → **用户手改过,不动**(`user-edited`),并在界面上说一句。
 *
 * 摘的时候同一把尺子:只摘**与我们记下的逐字相同**的那一格;被改过的留着不动,
 * 让用户自己决定 —— 卸载一个可选组件,不该顺手删掉别人写的配置。
 *
 * ## 认不得就不写
 *
 * 与 `dshProfilePatch.ts` 同一条纪律:JSON 解析不了、YAML 顶层不是数组、TOML 里已经有一个
 * 同名但形状怪的段 —— 一律 `ok: false` 并说人话。宁可「这次没接上」,不可写出一个起不来的配置。
 * 事务官那一份尤其:`cordis.patch.yml` 写坏一个字符,DSH 整个起不来。
 */
import {
  CODE_SENSE_DSH_ENTRY_ID, CODE_SENSE_DSH_PLUGIN, CODE_SENSE_SERVER_NAME,
  type CodeSenseHost,
} from './manifest.ts'

/** 一次写入(或摘除)的结果。`text` 永远是「该落盘的全文」——没改时等于原文。 */
export interface CodeSensePatch {
  /** 认得这份文件、可以落盘。false 时调用方**不许写**。 */
  ok: boolean
  /** 该落盘的全文。 */
  text: string
  /** 与原文比有没有变。false 时调用方可以不落盘(少一次写就少一次出错)。 */
  changed: boolean
  /** written=写了/换了;already=本来就对;user-edited=被手改过没动;absent=本来就没有;bad=认不得。 */
  reason: 'written' | 'already' | 'user-edited' | 'absent' | 'bad'
  /** 界面上显示的那一句人话。**不出现文件名以外的行话**。 */
  say: string
  /** 这一次我们写进去的逐字原文,调用方存进 written.json。没写时不给。 */
  wrote?: string | undefined
}

/** 写一家要知道的几件事。 */
export interface CodeSenseTarget {
  host: CodeSenseHost
  /** `~/.dsh/code-sense/run-mcp` 的绝对路径。 */
  runMcp: string
  /** 只有事务官那一份要:MCP 服务器起在哪个目录下(源码仓库根)。 */
  cwd?: string | undefined
  /** 上一次我们写进去的逐字原文(written.json 里存的)。没写过就不给。 */
  recorded?: string | undefined
}

// ---- Claude Code:~/.claude.json 的 mcpServers ------------------------------

/** Claude Code 那一格的值。字段名是它认的那几个,不多写 —— 多写一个未知字段它会报错。 */
export function claudeCodeEntry(t: CodeSenseTarget): unknown {
  return { command: t.runMcp, args: [t.host.context] }
}

/**
 * 写进 `~/.claude.json`。
 *
 * **会把整份 JSON 重新排版**(两格缩进)—— 这份文件本来就由 Claude Code 自己反复重写,
 * 不是人手维护的,所以可以接受;换成逐行改反而更容易写坏。原文解析不了就 `ok: false`。
 */
export function patchClaudeCode(text: string, t: CodeSenseTarget): CodeSensePatch {
  const want = claudeCodeEntry(t)
  const wantText = JSON.stringify(want)
  const base = text.trim() === '' ? '{}' : text
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(base)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    doc = parsed as Record<string, unknown>
  } catch {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 的那份配置(不是一份完整的 JSON),这次没动它。' }
  }
  const servers = doc.mcpServers
  const map: Record<string, unknown> =
    servers !== null && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...(servers as Record<string, unknown>) }
      : {}
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 那份配置里的服务器清单,这次没动它。' }
  }
  const has = Object.prototype.hasOwnProperty.call(map, CODE_SENSE_SERVER_NAME)
  const cur = has ? JSON.stringify(map[CODE_SENSE_SERVER_NAME]) : undefined
  if (cur === wantText) return { ok: true, text, changed: false, reason: 'already', say: 'Claude Code 那边本来就接着了。', wrote: wantText }
  if (has && cur !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Claude Code 那边的这一条你自己改过,没覆盖它。' }
  }
  map[CODE_SENSE_SERVER_NAME] = want
  doc.mcpServers = map
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n`, changed: true, reason: 'written', say: '接上了 Claude Code。', wrote: wantText }
}

/** 从 `~/.claude.json` 里摘掉。只摘与我们记下的逐字相同的那一格。 */
export function unpatchClaudeCode(text: string, t: CodeSenseTarget): CodeSensePatch {
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '{}' : text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    doc = parsed as Record<string, unknown>
  } catch {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得 Claude Code 的那份配置,这次没动它。' }
  }
  const servers = doc.mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: true, text, changed: false, reason: 'absent', say: 'Claude Code 那边本来就没接。' }
  }
  const map = { ...(servers as Record<string, unknown>) }
  if (!Object.prototype.hasOwnProperty.call(map, CODE_SENSE_SERVER_NAME)) {
    return { ok: true, text, changed: false, reason: 'absent', say: 'Claude Code 那边本来就没接。' }
  }
  if (JSON.stringify(map[CODE_SENSE_SERVER_NAME]) !== t.recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Claude Code 那边的这一条你自己改过,留着没删 —— 要去掉自己删一下。' }
  }
  delete map[CODE_SENSE_SERVER_NAME]
  // 摘完只剩一个空壳时把 `mcpServers` 这个键也去掉 —— 「卸载干净」的意思是文件回到没写过时那样,
  // 不是留一个我们顺手建出来的空对象。
  if (Object.keys(map).length === 0) delete doc.mcpServers
  else doc.mcpServers = map
  return { ok: true, text: `${JSON.stringify(doc, null, 2)}\n`, changed: true, reason: 'written', say: '从 Claude Code 摘掉了。' }
}

// ---- 带记号的整段(Codex 的 TOML 与事务官的 YAML 共用这一套)-----------------

/**
 * 记号长这样。为什么用记号而不是去解析 TOML / YAML:
 * ① 这两份文件都可能有用户自己写的注释与顺序,整份重排会把人家的东西揉了;
 * ② 我们只需要「加一段 / 删一段」,记号足够,而且**摘的时候能摘得一个字不剩**。
 */
const MARK_BEGIN = '# >>> 工作台 · 看懂代码结构(code-sense)开始 —— 这一段由工作台生成'
const MARK_END = '# <<< 工作台 · 看懂代码结构(code-sense)结束'

function findBlock(text: string): { start: number, end: number, body: string } | null {
  const s = text.indexOf(MARK_BEGIN)
  if (s < 0) return null
  const e = text.indexOf(MARK_END, s)
  if (e < 0) return null
  const end = e + MARK_END.length
  return { start: s, end, body: text.slice(s, end) }
}

function wrap(inner: string): string {
  return `${MARK_BEGIN}\n${inner.replace(/\s+$/, '')}\n${MARK_END}`
}

function appendBlock(text: string, block: string): string {
  const base = text.replace(/\s+$/, '')
  return base === '' ? `${block}\n` : `${base}\n\n${block}\n`
}

function cutBlock(text: string, at: { start: number, end: number }): string {
  const before = text.slice(0, at.start).replace(/[ \t]+$/, '')
  const after = text.slice(at.end)
  const joined = `${before.replace(/\n+$/, '')}\n${after.replace(/^\n+/, '')}`
  const trimmed = joined.replace(/\s+$/, '')
  return trimmed === '' ? '' : `${trimmed}\n`
}

function patchBlock(text: string, block: string, recorded: string | undefined, says: { already: string, edited: string, done: string }): CodeSensePatch {
  const found = findBlock(text)
  if (!found) return { ok: true, text: appendBlock(text, block), changed: true, reason: 'written', say: says.done, wrote: block }
  if (found.body === block) return { ok: true, text, changed: false, reason: 'already', say: says.already, wrote: block }
  if (recorded !== undefined && found.body === recorded) {
    const next = `${text.slice(0, found.start)}${block}${text.slice(found.end)}`
    return { ok: true, text: next, changed: true, reason: 'written', say: says.done, wrote: block }
  }
  return { ok: true, text, changed: false, reason: 'user-edited', say: says.edited }
}

function unpatchBlock(text: string, recorded: string | undefined, says: { absent: string, edited: string, done: string }): CodeSensePatch {
  const found = findBlock(text)
  if (!found) return { ok: true, text, changed: false, reason: 'absent', say: says.absent }
  if (recorded !== undefined && found.body !== recorded) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: says.edited }
  }
  return { ok: true, text: cutBlock(text, found), changed: true, reason: 'written', say: says.done }
}

// ---- Codex:~/.codex/config.toml --------------------------------------------

/** Codex 那一段的原文(TOML)。 */
export function codexBlock(t: CodeSenseTarget): string {
  return wrap(
    `[mcp_servers.${CODE_SENSE_SERVER_NAME}]\n` +
    `command = ${tomlString(t.runMcp)}\n` +
    `args = [${tomlString(t.host.context)}]\n`,
  )
}

/** TOML 的基本字符串。带反斜杠或引号的路径老老实实转义;控制字符直接拒(调用方不该给)。 */
function tomlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function patchCodex(text: string, t: CodeSenseTarget): CodeSensePatch {
  // 同名的段已经在别处出现过 = 用户(或别的工具)自己配过一条同名的,不抢。
  const dup = new RegExp(`^\\s*\\[mcp_servers\\.${CODE_SENSE_SERVER_NAME}\\]`, 'm')
  const found = findBlock(text)
  const outside = found ? `${text.slice(0, found.start)}${text.slice(found.end)}` : text
  if (dup.test(outside)) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: 'Codex 那边已经有一条同名的了,没动它。' }
  }
  return patchBlock(text, codexBlock(t), t.recorded, {
    already: 'Codex 那边本来就接着了。', edited: 'Codex 那边的这一段你自己改过,没覆盖它。', done: '接上了 Codex。',
  })
}

export function unpatchCodex(text: string, t: CodeSenseTarget): CodeSensePatch {
  return unpatchBlock(text, t.recorded, {
    absent: 'Codex 那边本来就没接。', edited: 'Codex 那边的这一段你自己改过,留着没删。', done: '从 Codex 摘掉了。',
  })
}

// ---- 事务官(DSH):~/.dsh/profiles/web/cordis.patch.yml ---------------------

/**
 * 事务官那一段的原文(YAML)。形状出自上游 `vendor/include/src/index.ts` 的 `applyEntryPatches`:
 * 顶层是一个数组,`- insert: [...]` 会把里面那几项**追加**进去,每一项是一个
 * `{ id, name, config }`。config 的字段名出自 `@deepseek-ai/dsh-mcp-client` 的 `StdioConfig`。
 *
 * **不写 `name` 以外的花活**:`applyEntryPatches` 对非 insert 的补丁会按 id 找行,
 * 找不到只在日志里 warn;我们这一条是 insert,新加一行,不依赖任何已有行。
 */
export function dshBlock(t: CodeSenseTarget): string {
  const cwd = t.cwd ?? ''
  return wrap(
    `# 给事务官接上「按符号看代码」的眼睛(serena,经 MCP,独立进程)。\n` +
    `# 装/卸都在设置 → 看懂代码结构那一格;要自己关掉,把这一整段删掉即可。\n` +
    `- insert:\n` +
    `    - id: ${CODE_SENSE_DSH_ENTRY_ID}\n` +
    `      name: '${CODE_SENSE_DSH_PLUGIN}'\n` +
    `      config:\n` +
    `        transport: stdio\n` +
    `        serverName: ${CODE_SENSE_SERVER_NAME.replace(/-/g, '_')}\n` +
    `        command: '${yamlSingle(t.runMcp)}'\n` +
    `        args:\n` +
    `          - '${yamlSingle(t.host.context)}'\n` +
    `        cwd: '${yamlSingle(cwd)}'\n` +
    `        failOnStartupError: false\n`,
  )
}

/** YAML 单引号纯量:里面的单引号翻倍。换行与控制字符由下面的 `dshValuesSafe` 先拦掉。 */
function yamlSingle(v: string): string {
  return v.replace(/'/g, "''")
}

/** 值里有换行或控制字符就别写 —— 不硬塞引号(同 dshProfilePatch.ts 的规矩)。 */
function dshValuesSafe(t: CodeSenseTarget): boolean {
  const bad = /[\n\r\t\u0000-\u001f]/
  return !bad.test(t.runMcp) && !bad.test(t.host.context) && !bad.test(t.cwd ?? '')
}

export function patchDsh(text: string, t: CodeSenseTarget): CodeSensePatch {
  if (!dshValuesSafe(t)) {
    return { ok: false, text, changed: false, reason: 'bad', say: '这条路径里有事务官的配置放不下的字符,这次没接上它。' }
  }
  if (t.cwd === undefined || t.cwd === '') {
    return { ok: false, text, changed: false, reason: 'bad', say: '没找到源码仓库在哪,事务官这一头先不接。' }
  }
  // 认不得就不写:顶层必须是一个 YAML 数组(每个非注释、非空的顶格行都以 `- ` 开头),
  // 不能有制表符或多文档分隔。写坏一个字符,DSH 整个起不来。
  const outside = (() => { const f = findBlock(text); return f ? `${text.slice(0, f.start)}${text.slice(f.end)}` : text })()
  if (outside.includes('\t')) {
    return { ok: false, text, changed: false, reason: 'bad', say: '认不得事务官的那份配置(里面有制表符),这次没动它。' }
  }
  for (const line of outside.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    if (line === '---' || line.startsWith('--- ') || line === '...') {
      return { ok: false, text, changed: false, reason: 'bad', say: '认不得事务官的那份配置(分了多份),这次没动它。' }
    }
    if (!line.startsWith(' ') && !line.startsWith('- ')) {
      return { ok: false, text, changed: false, reason: 'bad', say: '认不得事务官的那份配置(顶层不是一张清单),这次没动它。' }
    }
  }
  if (outside.includes(`id: ${CODE_SENSE_DSH_ENTRY_ID}`)) {
    return { ok: true, text, changed: false, reason: 'user-edited', say: '事务官那边已经有一条同名的了,没动它。' }
  }
  return patchBlock(text, dshBlock(t), t.recorded, {
    already: '事务官那边本来就接着了。', edited: '事务官那边的这一段你自己改过,没覆盖它。', done: '接上了事务官(下次重启生效)。',
  })
}

export function unpatchDsh(text: string, t: CodeSenseTarget): CodeSensePatch {
  return unpatchBlock(text, t.recorded, {
    absent: '事务官那边本来就没接。', edited: '事务官那边的这一段你自己改过,留着没删。', done: '从事务官摘掉了(下次重启生效)。',
  })
}

// ---- 按家分派 ---------------------------------------------------------------

export function patchFor(hostId: CodeSenseHost['id'], text: string, t: CodeSenseTarget): CodeSensePatch {
  if (hostId === 'claude-code') return patchClaudeCode(text, t)
  if (hostId === 'codex') return patchCodex(text, t)
  return patchDsh(text, t)
}

export function unpatchFor(hostId: CodeSenseHost['id'], text: string, t: CodeSenseTarget): CodeSensePatch {
  if (hostId === 'claude-code') return unpatchClaudeCode(text, t)
  if (hostId === 'codex') return unpatchCodex(text, t)
  return unpatchDsh(text, t)
}

/** 各家那份配置在哪。测试会把 `home` 换成一个临时目录 —— 同 setup/paths.ts 的纪律。 */
export function configPathFor(hostId: CodeSenseHost['id'], home: string): string {
  if (hostId === 'claude-code') return `${home}/.claude.json`
  if (hostId === 'codex') return `${home}/.codex/config.toml`
  return `${home}/.dsh/profiles/web/cordis.patch.yml`
}

/**
 * 那一家现在接着没有。**不是拿字符串在全文里找** —— Claude Code 那份是 JSON,
 * 我们记下的是一行紧凑的原文,而落盘的是两格缩进的排版,`includes` 一定找不着。
 * 所以 JSON 那家按解析后的值比,带记号的那两家按记号那一段比。
 */
export function isConnected(hostId: CodeSenseHost['id'], text: string, recorded: string | undefined): boolean {
  if (recorded === undefined) return false
  if (hostId !== 'claude-code') return text.includes(recorded)
  try {
    const doc: unknown = JSON.parse(text.trim() === '' ? '{}' : text)
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false
    const servers = (doc as { mcpServers?: unknown }).mcpServers
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return false
    const cur = (servers as Record<string, unknown>)[CODE_SENSE_SERVER_NAME]
    return cur !== undefined && JSON.stringify(cur) === recorded
  } catch { return false }
}
