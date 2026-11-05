/**
 * 「看懂代码结构」的用例(2026-09-27,卡 SE)。三件事:
 *
 * ① **清单与版本钉**:仓库里那份装的脚本与 `manifest.ts` 逐字一致 —— 改一边忘了另一边就红。
 * ② **配置写入幂等、且不覆盖用户手改**:三家各跑一遍「写两次 = 写一次」「改过就不动」。
 * ③ **卸载干净**:摘完之后各家配置回到原样一个字不差;临时 HOME 里除了我们写的什么都没多。
 *
 * 真装(下 uv、装 Python、装 serena,约 205 MiB)**不在用例里跑** —— 它要联网、要两分钟,
 * 在临时目录里手跑一次并把实测数字写进交接就够了。见 `docs/交接-0927-看懂代码结构能力.md`。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeCodeEntry, codexBlock, configPathFor, dshBlock,
  patchClaudeCode, patchCodex, patchDsh, unpatchClaudeCode, unpatchCodex, unpatchDsh,
} from '../src/server/codeSense/agentConfig.ts'
import {
  CODE_SENSE_HOSTS, CODE_SENSE_PYTHON_VERSION, CODE_SENSE_SERENA_SPEC,
  CODE_SENSE_UV_SHA256, CODE_SENSE_UV_VERSION,
} from '../src/server/codeSense/manifest.ts'
import { connectHosts, disconnectHosts, readStatus, readWritten } from '../src/server/codeSense/service.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO, 'deploy/code-sense-install.sh')

const host = (id: 'claude-code' | 'codex' | 'dsh') => CODE_SENSE_HOSTS.find((h) => h.id === id)!

describe('清单与版本钉', () => {
  it('装的脚本里那几行与 manifest.ts 逐字一致', async () => {
    const sh = await readFile(SCRIPT, 'utf8')
    expect(sh).toContain(`UV_VERSION="${CODE_SENSE_UV_VERSION}"`)
    expect(sh).toContain(`UV_SHA256="${CODE_SENSE_UV_SHA256}"`)
    expect(sh).toContain(`SERENA_SPEC="${CODE_SENSE_SERENA_SPEC}"`)
    expect(sh).toContain(`PYTHON_VERSION="${CODE_SENSE_PYTHON_VERSION}"`)
  })

  it('serena 的版本是钉死的一个点,不是范围、不是 main', () => {
    expect(CODE_SENSE_SERENA_SPEC).toMatch(/^serena-agent==\d+\.\d+\.\d+$/)
  })

  it('uv 的 sha256 是一个完整的 64 位十六进制', () => {
    expect(CODE_SENSE_UV_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('脚本把 uv 的每一条默认路径都改道进了 $ROOT(少一条就会往用户家目录里落东西)', async () => {
    const sh = await readFile(SCRIPT, 'utf8')
    for (const key of ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_BIN_DIR']) {
      expect(sh, key).toContain(`export ${key}="$ROOT/`)
    }
    expect(sh).toContain('export UV_NO_MODIFY_PATH="1"')
  })

  it('校验和对不上就删掉、不解压', async () => {
    const sh = await readFile(SCRIPT, 'utf8')
    expect(sh).toMatch(/校验和对不上[\s\S]*?已删掉,没有解压/)
  })

  it('起 serena 时关掉了自动弹的面板与它自带的记忆', async () => {
    const sh = await readFile(SCRIPT, 'utf8')
    expect(sh).toContain('--enable-web-dashboard False')
    expect(sh).toContain('--open-web-dashboard False')
    expect(sh).toContain('--enable-gui-log-window False')
    expect(sh).toContain('--add-mode no-memories')
    // mode 只把工具从 agent 的活动集里摘掉,MCP 那一层照样会报给模型;
    // 全局 excluded_tools 才是真的不注册。两道都要在。
    expect(sh).toContain('excluded_tools:')
    for (const t of ['write_memory', 'read_memory', 'list_memories', 'onboarding']) {
      expect(sh, t).toContain(`  - ${t}`)
    }
  })
})

describe('Claude Code:~/.claude.json', () => {
  const t = { host: host('claude-code'), runMcp: '/home/.dsh/code-sense/run-mcp' }

  it('空文件也接得上,别的键原样留着', () => {
    const before = JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'x' } } }, null, 2)
    const p = patchClaudeCode(before, t)
    expect(p.ok && p.changed && p.reason === 'written').toBe(true)
    const doc = JSON.parse(p.text) as Record<string, unknown>
    expect(doc.numStartups).toBe(7)
    const servers = doc.mcpServers as Record<string, unknown>
    expect(servers.other).toEqual({ command: 'x' })
    expect(servers['code-sense']).toEqual(claudeCodeEntry(t))
  })

  it('写两次 = 写一次(第二次什么都不做)', () => {
    const one = patchClaudeCode('{}', t)
    const two = patchClaudeCode(one.text, { ...t, recorded: one.wrote })
    expect(two.changed).toBe(false)
    expect(two.reason).toBe('already')
    expect(two.text).toBe(one.text)
  })

  it('用户手改过那一格就不覆盖', () => {
    const one = patchClaudeCode('{}', t)
    const doc = JSON.parse(one.text) as { mcpServers: Record<string, unknown> }
    doc.mcpServers['code-sense'] = { command: '/我/自己/改的', args: [] }
    const edited = JSON.stringify(doc, null, 2)
    const two = patchClaudeCode(edited, { ...t, recorded: one.wrote })
    expect(two.changed).toBe(false)
    expect(two.reason).toBe('user-edited')
    expect(two.text).toBe(edited)
  })

  it('换了版本(我们自己写的那一格与上次记的一样)才换得动', () => {
    const one = patchClaudeCode('{}', t)
    const next = { ...t, runMcp: '/新/路径/run-mcp', recorded: one.wrote }
    const two = patchClaudeCode(one.text, next)
    expect(two.reason).toBe('written')
    expect((JSON.parse(two.text) as { mcpServers: Record<string, { command: string }> }).mcpServers['code-sense']?.command).toBe('/新/路径/run-mcp')
  })

  it('认不得的 JSON 一个字都不写', () => {
    const p = patchClaudeCode('{这不是 JSON', t)
    expect(p.ok).toBe(false)
    expect(p.changed).toBe(false)
    expect(p.text).toBe('{这不是 JSON')
  })

  it('摘掉之后回到原样;被手改过的留着不删', () => {
    const before = `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`
    const one = patchClaudeCode(before, t)
    const off = unpatchClaudeCode(one.text, { ...t, recorded: one.wrote })
    expect(off.changed).toBe(true)
    expect(JSON.parse(off.text)).toEqual(JSON.parse(before))

    const keep = unpatchClaudeCode(one.text, { ...t, recorded: '{"command":"别的"}' })
    expect(keep.changed).toBe(false)
    expect(keep.reason).toBe('user-edited')
  })
})

describe('Codex:~/.codex/config.toml', () => {
  const t = { host: host('codex'), runMcp: '/home/.dsh/code-sense/run-mcp' }

  it('接在原有内容后面,原有内容一个字不动', () => {
    const before = '[model]\nname = "gpt"\n'
    const p = patchCodex(before, t)
    expect(p.changed).toBe(true)
    expect(p.text.startsWith(before.trimEnd())).toBe(true)
    expect(p.text).toContain('[mcp_servers.code-sense]')
    expect(p.text).toContain('args = ["codex"]')
  })

  it('写两次 = 写一次', () => {
    const one = patchCodex('', t)
    const two = patchCodex(one.text, { ...t, recorded: one.wrote })
    expect(two.changed).toBe(false)
    expect(two.text).toBe(one.text)
  })

  it('用户改了我们那一段就不覆盖', () => {
    const one = patchCodex('', t)
    const edited = one.text.replace('args = ["codex"]', 'args = ["ide"]')
    const two = patchCodex(edited, { ...t, recorded: one.wrote })
    expect(two.reason).toBe('user-edited')
    expect(two.text).toBe(edited)
  })

  it('他自己已经配过一条同名的就不抢', () => {
    const before = '[mcp_servers.code-sense]\ncommand = "/我自己装的"\n'
    const p = patchCodex(before, t)
    expect(p.changed).toBe(false)
    expect(p.reason).toBe('user-edited')
  })

  it('摘掉之后与没写过时逐字相同', () => {
    const before = '[model]\nname = "gpt"\n'
    const one = patchCodex(before, t)
    const off = unpatchCodex(one.text, { ...t, recorded: one.wrote })
    expect(off.text).toBe(before)
  })

  it('路径里的引号与反斜杠会转义', () => {
    const block = codexBlock({ host: host('codex'), runMcp: '/a"b\\c/run-mcp' })
    expect(block).toContain('command = "/a\\"b\\\\c/run-mcp"')
  })
})

describe('事务官:cordis.patch.yml', () => {
  const YML = "# 工作台登录台生成。\n- insert:\n    - id: ben-workbench\n      name: '@ben/dsh-workbench'\n\n- id: connection\n  config:\n    cookieMaxAgeDays: 3650\n"
  const t = { host: host('dsh'), runMcp: '/home/.dsh/code-sense/run-mcp', cwd: '/仓库' }

  it('接在末尾,上面每一行逐字不动', () => {
    const p = patchDsh(YML, t)
    expect(p.changed).toBe(true)
    expect(p.text.startsWith(YML.trimEnd())).toBe(true)
    expect(p.text).toContain('name: \'@deepseek-ai/dsh-mcp-client\'')
    // DSH 的 serverName 只认 [A-Za-z0-9_-]{1,32}
    const m = /serverName: (\S+)/.exec(p.text)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('写两次 = 写一次', () => {
    const one = patchDsh(YML, t)
    const two = patchDsh(one.text, { ...t, recorded: one.wrote })
    expect(two.changed).toBe(false)
    expect(two.text).toBe(one.text)
  })

  it('没有源码仓库就不接', () => {
    const p = patchDsh(YML, { ...t, cwd: undefined })
    expect(p.ok).toBe(false)
    expect(p.text).toBe(YML)
  })

  it('认不得的补丁层一个字都不写', () => {
    for (const bad of ['顶层不是清单\n', '- insert:\n\t- id: x\n', '- id: a\n---\n- id: b\n']) {
      const p = patchDsh(bad, t)
      expect(p.ok, bad).toBe(false)
      expect(p.text).toBe(bad)
    }
  })

  it('值里有换行就拒写,不硬塞引号', () => {
    const p = patchDsh(YML, { ...t, runMcp: '/a\nb' })
    expect(p.ok).toBe(false)
  })

  it('已经有一条同名的就不抢', () => {
    const p = patchDsh(`${YML}- insert:\n    - id: code-sense-mcp\n      name: 'x'\n`, t)
    expect(p.changed).toBe(false)
    expect(p.reason).toBe('user-edited')
  })

  it('摘掉之后与没写过时逐字相同', () => {
    const one = patchDsh(YML, t)
    const off = unpatchDsh(one.text, { ...t, recorded: one.wrote })
    expect(off.text).toBe(YML)
  })

  it('那一段里带得出 cwd —— 事务官起它的时候要在源码仓库里', () => {
    expect(dshBlock(t)).toContain("cwd: '/仓库'")
  })
})

describe('在临时 HOME 里接上再摘掉', () => {
  let home = ''

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'code-sense-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  const seed = async () => {
    await writeFile(join(home, '.claude.json'), '{\n  "numStartups": 3\n}\n', 'utf8')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex/config.toml'), '[model]\nname = "gpt"\n', 'utf8')
    await mkdir(join(home, '.dsh/profiles/web'), { recursive: true })
    await writeFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), '- id: connection\n  config:\n    cookieMaxAgeDays: 3650\n', 'utf8')
  }

  const snapshot = async () => {
    const out = new Map<string, string>()
    for (const h of CODE_SENSE_HOSTS) out.set(h.id, await readFile(configPathFor(h.id, home), 'utf8'))
    return out
  }

  it('三家都接上、再跑一遍什么都不变、摘掉之后逐字回到原样', async () => {
    await seed()
    const before = await snapshot()

    const first = await connectHosts({ home, repoRoot: '/仓库' })
    expect(first.every((r) => r.patch.ok)).toBe(true)
    expect(first.map((r) => r.patch.reason)).toEqual(['written', 'written', 'written'])
    const after = await snapshot()
    for (const h of CODE_SENSE_HOSTS) expect(after.get(h.id)).not.toBe(before.get(h.id))

    const second = await connectHosts({ home, repoRoot: '/仓库' })
    expect(second.map((r) => r.patch.reason)).toEqual(['already', 'already', 'already'])
    expect(await snapshot()).toEqual(after)

    const off = await disconnectHosts({ home })
    expect(off.every((r) => r.patch.ok)).toBe(true)
    const back = await snapshot()
    expect(JSON.parse(back.get('claude-code') ?? '')).toEqual(JSON.parse(before.get('claude-code') ?? ''))
    expect(back.get('codex')).toBe(before.get('codex'))
    expect(back.get('dsh')).toBe(before.get('dsh'))
    expect(await readWritten(home)).toEqual({})
  })

  it('用户手改过的那一家,摘的时候留着不删', async () => {
    await seed()
    await connectHosts({ home, repoRoot: '/仓库' })
    const path = configPathFor('codex', home)
    const edited = (await readFile(path, 'utf8')).replace('args = ["codex"]', 'args = ["我改的"]')
    await writeFile(path, edited, 'utf8')

    const off = await disconnectHosts({ home })
    const codex = off.find((r) => r.host === 'codex')!
    expect(codex.patch.reason).toBe('user-edited')
    expect(await readFile(path, 'utf8')).toBe(edited)
  })

  it('没装事务官的机器上,事务官那一头跳过,另外两家照接', async () => {
    await writeFile(join(home, '.claude.json'), '{}\n', 'utf8')
    const rs = await connectHosts({ home, repoRoot: '/仓库' })
    expect(rs.find((r) => r.host === 'dsh')!.patch.ok).toBe(false)
    expect(rs.find((r) => r.host === 'claude-code')!.patch.reason).toBe('written')
  })

  it('没装的时候,设置页照样答得出钉的是哪几个版本', async () => {
    const s = await readStatus(home)
    expect(s.installed).toBe(false)
    expect(s.pinned.serena).toBe(CODE_SENSE_SERENA_SPEC)
    expect(s.bytes).toBeUndefined()
    expect(s.hosts.every((h) => !h.connected)).toBe(true)
  })

  it('装上之后报得出大小与接了哪几家', async () => {
    await seed()
    await mkdir(join(home, '.dsh/code-sense'), { recursive: true })
    await writeFile(join(home, '.dsh/code-sense/installed.json'), JSON.stringify({ installedAt: '2026-09-27T02:00:00Z' }), 'utf8')
    await writeFile(join(home, '.dsh/code-sense/blob'), 'x'.repeat(1024), 'utf8')
    await connectHosts({ home, repoRoot: '/仓库' })

    const s = await readStatus(home)
    expect(s.installed).toBe(true)
    expect(s.installedAt).toBe('2026-09-27T02:00:00Z')
    expect(s.bytes).toBeGreaterThan(1024)
    expect(s.hosts.every((h) => h.connected)).toBe(true)
  })

  it('索引占多大是数出来的;没有索引就不列(不编一个数)', async () => {
    const repo = join(home, 'repo')
    await mkdir(join(repo, '.serena/cache'), { recursive: true })
    await writeFile(join(repo, '.serena/cache/idx'), 'y'.repeat(2048), 'utf8')
    const s = await readStatus(home, [repo, join(home, '没索引的仓库')])
    expect(s.indexes).toHaveLength(1)
    expect(s.indexes[0]?.bytes ?? 0).toBeGreaterThanOrEqual(2048)
  })
})
