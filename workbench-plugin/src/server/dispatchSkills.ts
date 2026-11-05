/**
 * **派活带技能**(2026-10-21,卡 S;设计 `docs/设计-接入花叔五件技能-2026-10-21.md` 第三节)。
 *
 * 技能是一整个目录(`SKILL.md` + `references/` + `scripts/` + `assets/`),只有在本机目录里干活的命令行那只手读得到:
 * 派活前把选中的几件从 `third_party/skills/` 拷进任务工作树里那一家自己找技能的位置,并写进这个仓库的
 * `info/exclude` —— 不进她的提交。窗口那只手与接口那只手看不到文件夹,带技能的活不派给它们。
 *
 * 读不读得到是探针实测的(`scripts/probe-skill-loading.ts`),不是照文档猜的。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { AgentDispatchFamily } from '../protocol.ts'
import type { UserLayerSkill } from './userLayer.ts'

/**
 * 每一家在工作目录里找技能的位置(相对工作目录)。Kimi 项目级技能目录与 Codex 同一条(2026-10-22 卡 C)。
 */
export const SKILL_DIRS: Readonly<Record<'claude' | 'codex' | 'kimi', string>> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  kimi: '.agents/skills',
}

/**
 * 读得到工作树里技能目录的那几家。2026-10-21 探针实测(Claude Code 2.1.283、codex-cli 0.162.0-alpha.17.2,
 * 派活同款沙箱与权限档位):两家在交代里点名、不点名都读到并照做,结果见 `docs/交接-1021-卡S-技能入库与装载.md`。
 * 2026-10-22(卡 C)加 Kimi(Kimi Code CLI 的项目级技能目录 `.agents/skills` 同 Codex 那一条)。
 * 不在这张表上的,带技能的活一律不派给它。
 */
export const SKILL_READER_FAMILIES: readonly AgentDispatchFamily[] = ['claude', 'codex', 'kimi']

/**
 * 派活能带的那几件(`third_party/skills/` 下的目录名)。
 *
 * 入库的五件里只有这两件给执行 Agent 用:mac-use 不在用户机器上现编(审计第三节),女娲与达尔文由评测程序用(卡 E / N)。
 * 用户层 `~/.dsh/workbench/用户层/技能/` 里的是第二格(2026-10-22,卡「用户层技能生效」B):技能库 = 这一格 ∪ 用户层,
 * 同名以用户层为准。用户层的名单运行时才扫得到(`userLayer.ts` 的 `scanUserLayerSkills`),由调用方递给
 * `checkSkillNames` / `installSkills` —— 这里不自己去读她的目录。
 */
export const DISPATCH_SKILLS: readonly string[] = ['huashu-report', 'huashu-design']

/** 我们拷进去的那一份带着它 —— 据此认「这是我们上次拷的,可以换新」。 */
const OURS_MARK = 'UPSTREAM.json'

export function canReadSkills(family: string): family is 'claude' | 'codex' | 'kimi' {
  return SKILL_READER_FAMILIES.includes(family) && family in SKILL_DIRS
}

/** 「X 读不了技能目录」那一句(派活回包、选项表两处同一句)。 */
export function skillsUnreadableWhy(who: string): string {
  const readers = SKILL_READER_FAMILIES.map(one => (one === 'claude' ? 'Claude Code' : one === 'codex' ? 'Codex' : one === 'kimi' ? 'Kimi' : one)).join(' / ')
  return `${who} 读不了技能目录,带技能的活只能派给 ${readers}(命令行在本机目录里干活的那几家)`
}

/**
 * 校验 `/dispatch/run` 的 `skills`。缺席与空表都算没带。
 * `extra` = 用户层技能名单(2026-10-22,卡「用户层技能生效」B):本体 ∪ 用户层,两边都认。
 */
export function checkSkillNames(value: unknown, extra?: readonly string[]): { ok: true, skills: string[] } | { ok: false, error: string } {
  if (value === undefined) return { ok: true, skills: [] }
  if (!Array.isArray(value) || value.some(one => typeof one !== 'string')) return { ok: false, error: 'skills 要是技能名的数组' }
  const names = [...new Set((value as string[]).map(one => one.trim()).filter(one => one !== ''))]
  const known = [...DISPATCH_SKILLS, ...(extra ?? [])]
  const unknown = names.filter(one => !known.includes(one))
  if (unknown.length > 0) return { ok: false, error: `不认得的技能:${unknown.join('、')}(能带的是 ${known.join(' / ')})` }
  return { ok: true, skills: names }
}

export type SkillInstallResult =
  | { ok: true, installed: string[], dir: string }
  | { ok: false, why: string }

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/** 这个工作目录所属仓库的 `info/exclude`(工作树也认:`--git-path` 落到共用的那份)。不是 git 仓库回 undefined。 */
function excludeFileOf(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, timeout: 10_000 }, (error, stdout) => {
      const path = String(stdout).trim()
      if (error !== null || path === '') { resolve(undefined); return }
      resolve(isAbsolute(path) ? path : join(cwd, path))
    })
  })
}

async function excludeLines(cwd: string, lines: readonly string[]): Promise<void> {
  const file = await excludeFileOf(cwd)
  if (file === undefined) return
  const had = await readFile(file, 'utf8').catch(() => '')
  const have = new Set(had.split('\n'))
  const add = lines.filter(line => !have.has(line))
  if (add.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${had === '' || had.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`)
}

/**
 * 把选中的技能拷进 `cwd` 里那一家找技能的位置。一件不成就整件不派(已拷的留着,下次派会换新)。
 *
 * 那个位置上已有同名目录、又不是我们拷的(没有 `UPSTREAM.json`)→ 不覆盖:那是她自己的技能。
 *
 * 技能库 = 本体 `third_party/skills/` ∪ 用户层技能(2026-10-22,卡「用户层技能生效」B):**用户层优先**,
 * 同名时拷用户层那份。扁平形(一份 .md)包成 `<名>/SKILL.md` 拷 —— 各家只认目录形。
 */
export async function installSkills(input: { family: string, cwd: string, skills: readonly string[], root: string, userSkills?: readonly UserLayerSkill[] }): Promise<SkillInstallResult> {
  if (!canReadSkills(input.family)) return { ok: false, why: skillsUnreadableWhy(input.family) }
  const dir = SKILL_DIRS[input.family]
  for (const name of input.skills) {
    if (name === '' || name.startsWith('.') || /[/\\]/.test(name)) return { ok: false, why: `技能名不对:${name}` }
    const fromUserLayer = input.userSkills?.find(one => one.id === name)
    if (fromUserLayer === undefined) {
      if (input.root === '' || !(await exists(join(input.root, name, 'SKILL.md')))) {
        return { ok: false, why: `这台工作台的技能库里没有 ${name}(本体 ${input.root === '' ? '没带' : input.root}、用户层 技能/ 里也找不到)` }
      }
    }
  }
  for (const name of input.skills) {
    const dest = join(input.cwd, dir, name)
    if (await exists(dest)) {
      if (!(await exists(join(dest, OURS_MARK)))) return { ok: false, why: `工作区里已经有一个同名的技能目录 ${dir}/${name},不是工作台拷的,没覆盖` }
      await rm(dest, { recursive: true, force: true })
    }
    await mkdir(dirname(dest), { recursive: true })
    const fromUserLayer = input.userSkills?.find(one => one.id === name)
    if (fromUserLayer !== undefined) {
      // 用户层是源头:目录形整目录拷;扁平形包成 <名>/SKILL.md。
      if ('dir' in fromUserLayer) await cp(fromUserLayer.dir, dest, { recursive: true })
      else {
        await mkdir(dest, { recursive: true })
        await cp(fromUserLayer.file, join(dest, 'SKILL.md'))
      }
      await writeFile(join(dest, OURS_MARK), `${JSON.stringify({ name, from: 'user-layer' })}\n`)
    }
    else {
      await cp(join(input.root, name), dest, { recursive: true })
    }
  }
  await excludeLines(input.cwd, input.skills.map(name => `/${dir}/${name}/`))
  return { ok: true, installed: [...input.skills], dir }
}

/** 交代末尾那一句:带了哪几件、在哪。 */
export function skillsPromptLine(family: 'claude' | 'codex' | 'kimi', skills: readonly string[]): string {
  const where = skills.map(name => `${SKILL_DIRS[family]}/${name}/SKILL.md`).join('、')
  return `这件活带了技能:${skills.join('、')}。先读 ${where},按它做。`
}

/**
 * 技能库在哪:从这份代码所在目录往上找 `third_party/skills`(源码里跑与 `lib/` 里跑差几层)。找不到回 undefined ——
 * 发版包里还没带它(交接里写着),带技能的活就如实说派不了。
 */
export function findSkillsRoot(fromDir: string, levels = 5): string | undefined {
  let dir = fromDir
  for (let i = 0; i <= levels; i++) {
    const candidate = join(dir, 'third_party', 'skills')
    if (existsSync(join(candidate, 'NOTICE.md'))) return candidate
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}
