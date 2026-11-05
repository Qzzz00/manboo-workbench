// @vitest-environment node
/**
 * 各家 Agent 客户端的记忆:探到哪几份、拷过来是什么样(2026-09-21)。
 *
 * **全部在 mktemp 出来的临时目录里跑**:假 HOME、假仓库根。一个字节都不碰真的
 * `~/.claude` / `~/.codex` / `~/.kimi` / `~/.dsh`(读也不读 —— 用例要的是行为,
 * 不是 Ben 机器上的真记忆)。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_FAMILIES,
  MEMORY_FAMILY_LABELS,
  copyTargetOf,
  importAgentMemories,
  probeAgentMemories,
} from '../src/server/agentMemory.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 一台「什么都装了」的假机器。 */
function machine(): { home: string, repoRoot: string } {
  const home = temp('wb-agent-memory-home-')
  const repoRoot = temp('wb-agent-memory-repo-')
  // Claude:每个项目一个 memory 目录,MEMORY.md 当索引 + 若干单主题 md。
  write(join(home, '.claude/projects/-Users-x-KOUKOU/memory/MEMORY.md'), '# 索引\n- [a](a.md)\n')
  write(join(home, '.claude/projects/-Users-x-KOUKOU/memory/a.md'), '# a\n')
  write(join(home, '.claude/projects/-Users-x-Aiboo/memory/b.md'), '# b\n')
  // 会话记录不是记忆,不拷。
  write(join(home, '.claude/projects/-Users-x-KOUKOU/9f0c.jsonl'), '{"x":1}\n')
  // Codex:一份全局 AGENTS.md + 一个(本机实测是空的)memories 目录 + 一个 SQLite 记忆库。
  write(join(home, '.codex/AGENTS.md'), '# codex\n')
  mkdirSync(join(home, '.codex/memories'), { recursive: true })
  write(join(home, '.codex/memories_1.sqlite'), 'SQLite format 3')
  // DSH 自己的那一份。
  write(join(home, '.dsh/AGENTS.md'), '我叫小助。\n')
  return { home, repoRoot }
}

describe('各家记忆在哪(探测)', () => {
  it('Claude:把每个项目的 memory 目录都探到,jsonl 会话记录不算记忆', async () => {
    const { home, repoRoot } = machine()
    const found = await probeAgentMemories({ home, repoRoot })
    const claude = found.find(one => one.family === 'claude')
    expect(claude?.files.map(f => f.rel).sort()).toEqual([
      '-Users-x-Aiboo/b.md', '-Users-x-KOUKOU/MEMORY.md', '-Users-x-KOUKOU/a.md',
    ])
  })

  it('Claude:仓库根的 CLAUDE.md 也算它的记忆', async () => {
    const { home, repoRoot } = machine()
    write(join(repoRoot, 'CLAUDE.md'), '# 本仓库的规矩\n')
    const found = await probeAgentMemories({ home, repoRoot })
    expect(found.find(one => one.family === 'claude')?.files.map(f => f.rel)).toContain('CLAUDE.md')
  })

  it('Codex:AGENTS.md 拷,SQLite 记忆库只如实记一句、不拷', async () => {
    const { home, repoRoot } = machine()
    const codex = (await probeAgentMemories({ home, repoRoot })).find(one => one.family === 'codex')
    expect(codex?.files.map(f => f.rel)).toEqual(['AGENTS.md'])
    expect(codex?.left.join('')).toContain('memories_1.sqlite')
  })

  it('Kimi:这台机器上一份都没有 → files 空,并写出找过哪几个地方', async () => {
    const { home, repoRoot } = machine()
    const kimi = (await probeAgentMemories({ home, repoRoot })).find(one => one.family === 'kimi')
    expect(kimi?.files).toEqual([])
    expect(kimi?.looked.length).toBeGreaterThan(0)
  })

  it('工作台自己那一份探得到,但标着「不用拷」——它本来就是事务官的', async () => {
    const { home, repoRoot } = machine()
    const dsh = (await probeAgentMemories({ home, repoRoot })).find(one => one.family === 'dsh')
    expect(dsh?.files.map(f => f.rel)).toEqual(['AGENTS.md'])
    expect(dsh?.skip).toBeTruthy()
  })

  it('四家一家不少,顺序固定', async () => {
    const { home, repoRoot } = machine()
    const found = await probeAgentMemories({ home, repoRoot })
    expect(found.map(one => one.family)).toEqual([...MEMORY_FAMILIES])
  })
})

describe('拷贝不越界', () => {
  it('只收 .md:jsonl / sqlite / 无扩展名一律不收', () => {
    expect(copyTargetOf('/root', '/root/a.md')).toBe('a.md')
    expect(copyTargetOf('/root', '/root/x/b.md')).toBe('x/b.md')
    expect(copyTargetOf('/root', '/root/a.jsonl')).toBeUndefined()
    expect(copyTargetOf('/root', '/root/a.sqlite')).toBeUndefined()
    expect(copyTargetOf('/root', '/root/AGENTS')).toBeUndefined()
  })

  it('根以外的路径一律拒收(`..`、别的目录、同前缀的兄弟目录)', () => {
    expect(copyTargetOf('/root', '/root/../etc/passwd.md')).toBeUndefined()
    expect(copyTargetOf('/root', '/elsewhere/a.md')).toBeUndefined()
    // `/rootless` 以 `/root` 开头,但它不在 `/root` 底下。
    expect(copyTargetOf('/root', '/rootless/a.md')).toBeUndefined()
    expect(copyTargetOf('/root', '/root')).toBeUndefined()
  })

  it('软链不跟(链到根外面的那一份不会被拷出来)', async () => {
    const { home, repoRoot } = machine()
    const outside = temp('wb-agent-memory-outside-')
    write(join(outside, '别人的.md'), '这一份不该被拷走\n')
    symlinkSync(join(outside, '别人的.md'), join(home, '.claude/projects/-Users-x-KOUKOU/memory/偷渡.md'))
    const claude = (await probeAgentMemories({ home, repoRoot })).find(one => one.family === 'claude')
    expect(claude?.files.map(f => f.rel)).not.toContain('-Users-x-KOUKOU/偷渡.md')
    expect(claude?.left.join('')).toContain('偷渡.md')
  })
})

describe('拷一份过来', () => {
  it('落在 docs/记忆/来自-<家>/ 下,原件一个字不动', async () => {
    const { home, repoRoot } = machine()
    const before = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')
    const result = await importAgentMemories({ home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') })

    expect(readFileSync(join(repoRoot, 'docs/记忆/来自-Codex/AGENTS.md'), 'utf8')).toBe('# codex\n')
    expect(readFileSync(join(repoRoot, 'docs/记忆/来自-Claude/-Users-x-KOUKOU/a.md'), 'utf8')).toBe('# a\n')
    // 原件还在,而且一个字没改(不移动、不解析改写)。
    expect(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')).toBe(before)
    expect(result.written.some(rel => rel.startsWith('docs/记忆/来自-'))).toBe(true)
  })

  it('每一家的文件夹里留一份「来源」,写清哪一份来自哪个路径、哪天拷的', async () => {
    const { home, repoRoot } = machine()
    await importAgentMemories({ home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') })
    const source = readFileSync(join(repoRoot, 'docs/记忆/来自-Claude/来源.md'), 'utf8')
    expect(source).toContain('2026-09-21')
    expect(source).toContain(join(home, '.claude/projects/-Users-x-KOUKOU/memory/a.md'))
    // 只读不改:这句话要写在文件里,下一个人打开就看得见。
    expect(source).toContain('只读')
  })

  it('工作台自己那一份不拷(来自-工作台 这个目录根本不出现)', async () => {
    const { home, repoRoot } = machine()
    await importAgentMemories({ home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') })
    const names = readdirSync(join(repoRoot, 'docs/记忆'))
    expect(names).toContain(`来自-${MEMORY_FAMILY_LABELS.claude}`)
    expect(names).not.toContain(`来自-${MEMORY_FAMILY_LABELS.dsh}`)
  })

  it('一家都没有时不建空文件夹,并如实回一句「没找到」', async () => {
    const home = temp('wb-agent-memory-empty-home-')
    const repoRoot = temp('wb-agent-memory-empty-repo-')
    const result = await importAgentMemories({ home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') })
    expect(result.written).toEqual([])
    expect(result.copied).toEqual([])
    expect(result.line).toContain('没找到')
    expect(readdirSync(repoRoot)).not.toContain('docs')
  })

  it('索引行按家分行,数目与真拷过去的文件数一致(不编数)', async () => {
    const { home, repoRoot } = machine()
    const result = await importAgentMemories({ home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') })
    const claude = result.copied.find(one => one.family === 'claude')
    expect(claude?.count).toBe(3)
    expect(result.index.some(line => line.includes('来自-Claude') && line.includes('3'))).toBe(true)
    // 探到了但没拷的(Codex 的 SQLite)要在结果里留一句话,不闷声吞掉。
    expect(result.left.join('')).toContain('memories_1.sqlite')
  })

  it('再拷一次是覆盖,不会堆出第二份', async () => {
    const { home, repoRoot } = machine()
    const opts = { home, repoRoot, now: () => new Date('2026-09-21T09:00:00Z') }
    await importAgentMemories(opts)
    write(join(home, '.codex/AGENTS.md'), '# codex 改过了\n')
    await importAgentMemories(opts)
    expect(readFileSync(join(repoRoot, 'docs/记忆/来自-Codex/AGENTS.md'), 'utf8')).toBe('# codex 改过了\n')
    expect(readdirSync(join(repoRoot, 'docs/记忆/来自-Codex')).sort()).toEqual(['AGENTS.md', '来源.md'])
  })
})

/**
 * 再点一次那颗按钮(2026-09-22)。界面上那颗按钮是**可以重复点的**,
 * 所以「这一次真写了哪几份」必须和「上一次已经在那儿的那几份」分得开 ——
 * 否则第二次点完屏幕上照样写「拷了 45 份」,而仓库里一个字节都没变,那是编的。
 */
describe('可重复点:只补新的', () => {
  it('第一次全是新的;原样再点一次一份都不写', async () => {
    const { home, repoRoot } = machine()
    const opts = { home, repoRoot, now: () => new Date('2026-09-22T09:00:00Z') }
    const first = await importAgentMemories(opts)
    expect(first.added.length).toBe(first.written.length)
    expect(first.added.length).toBeGreaterThan(0)

    const again = await importAgentMemories(opts)
    // 内容一个字没变 → 这一趟一个文件都没重写(written 空),但**拷过的份数照旧数得出来**。
    expect(again.written).toEqual([])
    expect(again.added).toEqual([])
    expect(again.copied.find(one => one.family === 'claude')?.count).toBe(3)
  })

  it('源头改过的那一份重写,别的不动;新出现的那一份算「新增」', async () => {
    const { home, repoRoot } = machine()
    const opts = { home, repoRoot, now: () => new Date('2026-09-22T09:00:00Z') }
    await importAgentMemories(opts)
    write(join(home, '.codex/AGENTS.md'), '# codex 改过了\n')
    write(join(home, '.claude/projects/-Users-x-Aiboo/memory/c.md'), '# c\n')
    const again = await importAgentMemories(opts)

    expect(again.written).toContain('docs/记忆/来自-Codex/AGENTS.md')
    expect(again.written).toContain('docs/记忆/来自-Claude/-Users-x-Aiboo/c.md')
    // 新增的只有真的第一次出现的那一份;改过的那一份是刷新,不是新增。
    expect(again.added).toEqual(['docs/记忆/来自-Claude/-Users-x-Aiboo/c.md'])
    expect(again.written).not.toContain('docs/记忆/来自-Claude/-Users-x-KOUKOU/a.md')
    expect(readFileSync(join(repoRoot, 'docs/记忆/来自-Codex/AGENTS.md'), 'utf8')).toBe('# codex 改过了\n')
  })
})
