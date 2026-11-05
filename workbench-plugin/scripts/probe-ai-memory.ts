#!/usr/bin/env node
/**
 * 记忆层换 ai-memory 的**真机探针**(2026-10-21,卡 ai-memory-probe)。
 *
 * 只在维护者这台机器上**手动**跑,前提是 ai-memory 已在回环 127.0.0.1:49374 跑着、Claude Code / Codex 的钩子已挂上
 * (`ai-memory setup`)。它会真起 `claude -p` 两次与 `codex exec` 一次,各花一点额度。不进测试套件。
 *
 * ```
 * node workbench-plugin/scripts/probe-ai-memory.ts            # 跑完把临时仓库路径与假令牌打出来,供 grep
 * node workbench-plugin/scripts/probe-ai-memory.ts --only claude
 * ```
 *
 * 做法:临时 git 仓库里放一份 `.ai-memory.toml`(固定项目名、开会话简报、忽略 `private/**` 与 `机密/**`),
 * 两个被忽略目录里各放一句只出现在那里的标记;再用派活同一个 `dispatchCommand` 拼命令(沙箱、权限档位与派活一字不差):
 * ① Claude 读三份文件、跑一次 `cat .env`、写 notes.md,交代里带两枚假令牌;
 * ② 同一个仓库再起一次 Claude,问「上次做到哪了」,看会话开头有没有拿到 ai-memory 的背景;
 * ③ Codex 做一件同样形状的小事,交代里带一枚假令牌。
 * 假令牌都是现生的随机串,形状像真的、没有任何用处。之后由交接里那几条命令 grep 数据目录。
 *
 * 不读任何凭据:两家都用各自已经登好的登录态;不碰 `~/.dsh`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchCommand, resolveAgentCli } from '../src/server/agentDispatch.ts'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined

function rand(alphabet: string, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
const AZ09 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const az09 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const id = rand('abcdefghijklmnopqrstuvwxyz0123456789', 6)
const FAKE = {
  anthropic: `sk-ant-api03-${rand(`${az09}-_`, 93)}AA`,
  github: `ghp_${rand(az09, 36)}`,
  aws: `AKIA${rand(AZ09, 16)}`,
  openaiInEnv: `sk-proj-${rand(`${az09}-_`, 48)}`,
}
const MARK = { private: `PRIVMARK-${id}-a`, chinese: `PRIVMARK-${id}-b` }
const PROJECT = `aim-probe-${id}`

const work = mkdtempSync(join(tmpdir(), 'wb-probe-aim-'))
function freshRepo(name: string): string {
  const dir = join(work, name)
  mkdirSync(join(dir, 'private'), { recursive: true })
  mkdirSync(join(dir, '机密'), { recursive: true })
  writeFileSync(join(dir, '.ai-memory.toml'), [
    'workspace = "probe"',
    `project = "${PROJECT}"`,
    '',
    '[briefing]',
    'inject_on_session_start = "true"',
    '',
    '[capture]',
    'ignore_paths = ["private/**", "机密/**"]',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'README.md'), '# 探针仓库\n\n这个仓库要做一个记账小工具:每天记一笔开销,月底出一张表。\n')
  writeFileSync(join(dir, 'private', 'plan.md'), `私人计划:${MARK.private}。下周先做导出。\n`)
  writeFileSync(join(dir, '机密', '计划.md'), `机密计划:${MARK.chinese}。预算三千。\n`)
  writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${FAKE.openaiInEnv}\nPORT=3000\n`)
  spawnSync('git', ['init', '-q'], { cwd: dir })
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

interface Row { step: string, exit: number | null, ms: number, tail: string }
const rows: Row[] = []

function run(family: 'claude' | 'codex', step: string, cwd: string, prompt: string): void {
  const cli = resolveAgentCli(family, probe)
  if (!cli.found) { console.log(`${family}: 没找到命令行 —— ${cli.why}`); return }
  const outputFile = join(work, `${step}.out`)
  const cmd = dispatchCommand(cli, { prompt, cwd, kind: 'code', ...(family === 'codex' ? { outputFile } : {}) })
  if (cmd === undefined) { console.log(`${family}: 派活那条命令拼不出来`); return }
  console.log(`\n── ${step}:${cmd.bin} ${cmd.argv.map(one => (one.length > 60 ? `${one.slice(0, 57)}…` : one)).join(' ')}`)
  const started = Date.now()
  const done = spawnSync(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, encoding: 'utf8', timeout: 6 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const ms = Date.now() - started
  let text = cmd.resultFrom === 'file' ? (existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '') : done.stdout
  if (cmd.resultFrom === 'stdout_json') {
    const last = done.stdout.trim().split('\n').reverse().find(line => line.includes('"type":"result"'))
    if (last !== undefined) { try { text = String(JSON.parse(last).result ?? '') } catch { /* 原样 */ } }
  }
  rows.push({ step, exit: done.status, ms, tail: text.trim().slice(-600) })
  console.log(`退出码 ${done.status};用时 ${(ms / 1000).toFixed(1)} 秒\n回答:${text.trim().slice(-600) || done.stderr.trim().slice(-400)}`)
}

const repo = freshRepo('repo')
console.log(`临时仓库 ${repo}\n项目 probe/${PROJECT}\n假令牌(只用于 grep):${JSON.stringify(FAKE)}\n被忽略目录里的标记:${JSON.stringify(MARK)}`)

if (only === undefined || only === 'claude') {
  run('claude', 'claude-1', repo, [
    '这是一个测试仓库,请依次做三件事:',
    '1. 读 README.md、private/plan.md、机密/计划.md,各用一句话说里面写了什么;',
    '2. 用 Bash 运行 `cat .env` 看一眼配置有哪些项;',
    '3. 新建 notes.md,用两三句话写下这个仓库要做什么、下一步做什么。',
    `另外备注:部署那边给的钥匙是 ${FAKE.anthropic},GitHub 令牌是 ${FAKE.github} —— 这两样都不要写进任何文件。`,
  ].join('\n'))
  run('claude', 'claude-2', repo, '这个仓库上次做到哪了?只根据会话开头你收到的背景材料回答;如果开头没有收到任何关于这个仓库的背景,就直说没有。再原样抄出背景材料的前三行(没有就写「无」)。')
}
if (only === undefined || only === 'codex') {
  run('codex', 'codex-1', repo, `读 README.md,新建 summary.txt 写一句话总结这个仓库。备注:测试用的 AWS 钥匙是 ${FAKE.aws},不要写进文件。`)
}

console.log('\n| 步 | 退出码 | 用时(秒) |\n|---|---|---|')
for (const row of rows) console.log(`| ${row.step} | ${row.exit} | ${(row.ms / 1000).toFixed(1)} |`)
console.log(`\n临时仓库留着供核对:${repo}`)
