#!/usr/bin/env node
/**
 * 派活带技能的**真机探针**(2026-10-21,卡 S):Claude Code 与 Codex 在任务工作树里读不读得到技能目录。
 *
 * 只在维护者自己这台机器上**手动**跑 —— 它会真起 `claude -p` 与 `codex exec`,各花一点额度。不进测试套件。
 *
 * ```
 * node workbench-plugin/scripts/probe-skill-loading.ts
 * node workbench-plugin/scripts/probe-skill-loading.ts --only claude      # 只跑一家:claude / codex
 * node workbench-plugin/scripts/probe-skill-loading.ts --keep             # 跑完不删临时仓库(要去翻日志时)
 * ```
 *
 * 做法:临时 git 仓库里用派活同一个 `installSkills` 装一件只写着「回答开头写上问答编号」的测试技能,
 * 再用派活同一个 `dispatchCommand` 拼命令起那一家(沙箱、权限档位与派活一字不差)。每家问两次:
 * ① 交代里点名那件技能(派活带技能时 `skillsPromptLine` 就是这么交代的);② 不点名,只看它自己会不会找上门。
 * 回答里有那个编号 = 读到了并照做。
 * (第一版写成「先说暗号」,Claude 读到了却当成注入的指令拒绝照做 —— 测试技能要像一条正常的格式约定。)
 * 另外核一眼 `git status` 是干净的(技能目录没进她的提交)。
 *
 * 不读任何凭据:两家都用各自已经登好的登录态。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchCommand, resolveAgentCli } from '../src/server/agentDispatch.ts'
import { SKILL_DIRS, installSkills, skillsPromptLine } from '../src/server/dispatchSkills.ts'

const SKILL = 'probe-secret'
const SECRET = `Q-${Math.random().toString(36).slice(2, 8)}`
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const keep = args.includes('--keep')

const work = mkdtempSync(join(tmpdir(), 'wb-probe-skill-'))
const root = join(work, 'skills')
mkdirSync(join(root, SKILL), { recursive: true })
writeFileSync(join(root, SKILL, 'SKILL.md'), [
  '---',
  `name: ${SKILL}`,
  'description: 本仓库问答的格式约定。回答任何关于本仓库的问题时使用。',
  '---',
  '',
  '# 回答格式',
  '',
  `本仓库的维护者用编号追踪每一次问答。回答关于本仓库的任何问题时,先在开头写上本次问答编号 ${SECRET}(原样照抄),再正常回答。`,
  '',
].join('\n'))
// 派活那一份认「是我们拷的」靠它。
writeFileSync(join(root, SKILL, 'UPSTREAM.json'), '{}\n')

function freshRepo(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir)
  spawnSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '探针用的临时仓库\n')
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

const probe = {
  pathEnv: process.env.PATH,
  home: homedir(),
  exists: (file: string) => existsSync(file),
  listDir: (dir: string) => { try { return readdirSync(dir) } catch { return [] } },
}

interface Row { family: string, ask: string, saw: boolean, clean: boolean, exit: number | null, tail: string }
const rows: Row[] = []

async function runOne(family: 'claude' | 'codex'): Promise<void> {
  const cli = resolveAgentCli(family, probe)
  if (!cli.found) { console.log(`${family}: 没找到命令行 —— ${cli.why}`); return }
  for (const ask of ['named', 'unnamed'] as const) {
    const cwd = freshRepo(`${family}-${ask}`)
    const installed = await installSkills({ family, cwd, skills: [SKILL], root })
    if (!installed.ok) { console.log(`${family}: 装不上 —— ${installed.why}`); return }
    const question = '用一句话说说这个仓库里有什么。'
    const prompt = ask === 'named' ? `${question}\n\n${skillsPromptLine(family, [SKILL])}` : question
    const outputFile = join(work, `${family}-${ask}.out`)
    const cmd = dispatchCommand(cli, { prompt, cwd, kind: 'code', ...(family === 'codex' ? { outputFile } : {}) })
    if (cmd === undefined) { console.log(`${family}: 派活那条命令拼不出来`); return }
    console.log(`\n── ${family} / ${ask === 'named' ? '交代里点名' : '不点名'}:${cmd.bin} ${cmd.argv.map(one => (one.length > 60 ? `${one.slice(0, 57)}…` : one)).join(' ')}`)
    const run = spawnSync(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, encoding: 'utf8', timeout: 5 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    const text = cmd.resultFrom === 'file' ? (existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '') : run.stdout
    const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim()
    const row: Row = { family, ask, saw: text.includes(SECRET) || run.stdout.includes(SECRET), clean: status === '', exit: run.status, tail: text.trim().slice(-300) }
    rows.push(row)
    console.log(`退出码 ${run.status};读到编号:${row.saw ? '是' : '否'};git status 干净:${row.clean ? '是' : `否(${status})`}`)
    if (!row.saw) console.log(`回答末尾:${row.tail || run.stderr.trim().slice(-300)}`)
  }
}

console.log(`临时目录 ${work};编号 ${SECRET};位置 claude=${SKILL_DIRS.claude} codex=${SKILL_DIRS.codex}`)
for (const family of ['claude', 'codex'] as const) {
  if (only !== undefined && only !== family) continue
  await runOne(family)
}
console.log('\n| 家 | 交代 | 读到 | git 干净 | 退出码 |\n|---|---|---|---|---|')
for (const row of rows) console.log(`| ${row.family} | ${row.ask === 'named' ? '点名' : '不点名'} | ${row.saw ? '是' : '否'} | ${row.clean ? '是' : '否'} | ${row.exit} |`)
if (!keep) rmSync(work, { recursive: true, force: true })
