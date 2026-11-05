/**
 * 事务官自己的技能装进她的工作目录(2026-09-25,卡 fix/evening-gaps 第 4 条)。
 *
 * ## 为什么
 *
 * 仓库根上的 `.dsh/skills/{记忆,引导,例程}/SKILL.md` 是事务官**自己的**技能:工作台发给她的话里写的是
 * 「按 `.dsh/skills/记忆/SKILL.md` 查」(butlerItem.ts 的 BUTLER_MEMORY_HINT)、「按 `.dsh/skills/例程/SKILL.md`
 * 的某一节做」(routines.ts)、「按 `.dsh/skills/引导/SKILL.md` 做」(onboardingStages.ts)——都是**相对她会话 cwd** 的路径。
 * DSH 找技能的第一个根也正是 `<项目根>/.dsh/skills`(上游 skill-filesystem 的 project-dsh)。
 *
 * 可这三份**只在开发仓库里有**。维护者机器上她的会话 cwd 是 `~/Documents/工作台`(app.json 的 butler_cwd,
 * 安装器 installer.ts 的 ensureWorkRepo 建的空骨架),那里与 `~/.dsh` 下都没有 —— 卡 K 查到「问到才读记忆」其实读不到。
 * 安装器只建了 AGENTS.md 与 docs/记忆/README.md,从没人把技能放过去;引导那边甚至在找 `~/.dsh/skills/引导/SKILL.md`,
 * 那个文件也从没人写过。
 *
 * ## 怎么装
 *
 * 三份原文随版本打进插件(scripts/gen-bundled-skills.mjs → `BUNDLED_BUTLER_SKILLS`),**工作台每次起服务、
 * 每次换工作目录**都同步一遍 —— 新装的机器第一次起服务就有,老机器热更新重启之后补上,技能改了下一版跟着升级。
 *
 * 那是**用户层**(AGENTS.md 第一节:技能是用户层,她机器上的东西本体不覆盖),所以升级要分得清「我们装的」和「她改过的」:
 *   - 没有这份 → 装上;
 *   - 与这一版一字不差 → 不动(记下指纹);
 *   - 与我们上次装的那份一字不差(她没改过)→ 换成这一版;
 *   - 别的(她改过、或者这是开发仓库、版本库里自己管着的那份)→ **不动**,如实说一句。
 * 「上次装的是什么」记在 `~/.dsh/workbench/butler-skills.json`(按绝对路径记指纹,换工作目录也分得开)。
 *
 * 装完如果工作目录是 git 仓库,**只提交这几个文件**(`-- .dsh/skills`,不碰她别的改动),身份现给、不动全局配置
 * —— 与安装器建工作目录那一笔同一个做法。不是 git 仓库、没有 git 就不提交,照样能用。
 *
 * 不删任何文件;不写工作目录以外的地方(除了那份指纹表)。
 *
 * ## 用户层技能也走这一趟(2026-10-22,卡「用户层技能生效」C)
 *
 * 维护者自己的技能(`~/.dsh/workbench/用户层/技能/`,`userLayer.ts` 扫出来的那一份)同样装进
 * 她工作目录的 `.dsh/skills/<名>/SKILL.md`(扁平形包成目录,同派活那边)。规矩只有一条:
 * **用户层那份是源头,工作目录那份与它不同就换成它** —— 她改工作目录里那份没用(那不是源头);
 * 不走本体三态指纹。用户层删了的不删工作目录那份(不删任何文件,同上面)。指纹表另记一段
 * (`user_layer`),不与本体技能的 `files` 混在一起。
 *
 * ## 顺带装的那几份文档(2026-09-26,卡「记忆收并推」F)
 *
 * 记忆技能里写着「按 `docs/记忆/下班例程.md` 八步做」,而那份模板原来**只在开发仓库里有**
 * (设计-讨论结论都落进工作台记忆-2026-09-26 §一 4)。现在它随版本打进插件(`BUNDLED_BUTLER_DOCS`),
 * 与技能同一趟装进她的工作目录同一个相对路径。
 *
 * 与技能**不同的一条**:文档只「**缺才写**」—— 有了就一个字不动,连"是不是我们上次装的"都不看。
 * 理由:技能是我们发版维护的东西(她没改过就该升级),而下班例程那份是**她照着做的流程**,
 * 她按自己的习惯改过一行,我们没有资格替她换掉。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { BUNDLED_BUTLER_DOCS, BUNDLED_BUTLER_SKILLS } from './bundledSkills.generated.ts'
import type { UserLayerSkill } from './userLayer.ts'

/** 技能在工作目录里的位置(相对):`.dsh/skills/<名字>/SKILL.md`。 */
export const BUTLER_SKILLS_DIR = '.dsh/skills'

export function butlerSkillFile(workDir: string, name: string): string {
  return join(workDir, BUTLER_SKILLS_DIR, name, 'SKILL.md')
}

/** 指纹表放哪:`~/.dsh/workbench/butler-skills.json`。 */
export function defaultButlerSkillsManifest(home: string): string {
  return join(home, '.dsh', 'workbench', 'butler-skills.json')
}

/** 提交那一笔的说明。 */
export const BUTLER_SKILLS_COMMIT_MESSAGE = '工作台:装上 / 更新事务官的技能(记忆 · 引导 · 例程 · 截图验收)'

export interface ButlerSkillsIo {
  /** 读一个文件;没有就 undefined。 */
  readFile: (path: string) => Promise<string | undefined>
  /** 写一个文件(上级目录没有就建)。 */
  writeFile: (path: string, text: string) => Promise<void>
  /** 这个路径在不在。 */
  exists: (path: string) => Promise<boolean>
  /** 在 cwd 里跑一条 git;没有 git 就回 ok:false。缺席 = 不提交。 */
  git?: (args: readonly string[], cwd: string) => Promise<{ ok: boolean }>
}

export interface ButlerSkillsOutcome {
  /** 新装上的。 */
  installed: string[]
  /** 从我们上一版换成这一版的。 */
  upgraded: string[]
  /** 已经是这一版的。 */
  current: string[]
  /** 她改过(或者版本库自己管着)、没动的。 */
  kept: string[]
  /** 这次补上的文档(相对工作目录,如 `docs/记忆/下班例程.md`)。已经有的不在里面。 */
  docs: string[]
  /** 提交了没有。 */
  committed: boolean
  /** 一句人话,进日志。 */
  note: string
}

interface Manifest { version: 1, files: Record<string, string>, user_layer?: Record<string, string> }

function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readManifest(io: ButlerSkillsIo, file: string): Promise<Manifest> {
  const text = await io.readFile(file)
  if (text === undefined) return { version: 1, files: {}, user_layer: {} }
  try {
    const parsed = JSON.parse(text) as Partial<Manifest> | null
    const files = parsed?.files
    const userLayer = parsed?.user_layer
    return {
      version: 1,
      ...(files === null || typeof files !== 'object' || Array.isArray(files) ? { files: {} } : { files: Object.fromEntries(Object.entries(files).filter(([, value]) => typeof value === 'string')) }),
      ...(userLayer === null || typeof userLayer !== 'object' || Array.isArray(userLayer) ? { user_layer: {} } : { user_layer: Object.fromEntries(Object.entries(userLayer).filter(([, value]) => typeof value === 'string')) }),
    }
  }
  catch { return { version: 1, files: {}, user_layer: {} } }
}

/**
 * 同步一遍。**不抛**:任何一步不成都只是这一回没装上,回一句话;下次起服务再来。
 */
export async function syncButlerSkills(input: {
  workDir: string
  manifestFile: string
  io: ButlerSkillsIo
  /** 测试注入;缺省是随版本打进来的那三份。 */
  skills?: Readonly<Record<string, string>>
  /** 顺带装的文档(相对工作目录的路径 → 全文)。测试注入;缺省是 BUNDLED_BUTLER_DOCS。 */
  docs?: Readonly<Record<string, string>>
  /**
   * 用户层技能(2026-10-22,卡「用户层技能生效」C):`userLayer.ts` 现扫出来的那一份。
   * 与本体那份**不同的一条规矩**:用户层是源头,工作目录里那份与它不同就换成它(不走上面三态指纹);
   * 用户层删了的不删工作目录那份(不删任何文件)。指纹另记 `user_layer` 一段。
   */
  userSkills?: readonly UserLayerSkill[]
}): Promise<ButlerSkillsOutcome> {
  const outcome: ButlerSkillsOutcome = { installed: [], upgraded: [], current: [], kept: [], docs: [], committed: false, note: '' }
  const workDir = input.workDir.trim()
  if (workDir === '' || !isAbsolute(workDir)) {
    outcome.note = `事务官技能没装:工作目录不是一个绝对路径(${workDir === '' ? '空的' : workDir})`
    return outcome
  }
  const skills = input.skills ?? BUNDLED_BUTLER_SKILLS
  const names = Object.keys(skills).sort()
  try {
    if (!(await input.io.exists(workDir))) {
      outcome.note = `事务官技能没装:工作目录 ${workDir} 不在`
      return outcome
    }
    const manifest = await readManifest(input.io, input.manifestFile)
    let manifestChanged = false
    for (const name of names) {
      const text = skills[name] as string
      const file = butlerSkillFile(workDir, name)
      const want = fingerprint(text)
      const existing = await input.io.readFile(file)
      if (existing === undefined) {
        await input.io.writeFile(file, text)
        outcome.installed.push(name)
      }
      else if (existing === text) {
        outcome.current.push(name)
      }
      else if (manifest.files[file] !== undefined && manifest.files[file] === fingerprint(existing)) {
        // 我们上次装的那份,她没改过:换成这一版。
        await input.io.writeFile(file, text)
        outcome.upgraded.push(name)
      }
      else {
        // 她改过,或者这是版本库自己管着的那份(开发仓库):不动。指纹也不记 —— 它不是我们写的。
        outcome.kept.push(name)
        continue
      }
      if (manifest.files[file] !== want) { manifest.files[file] = want; manifestChanged = true }
    }

    // 用户层技能(2026-10-22,卡「用户层技能生效」C):源头是她用户层里那份,不同就换、删了不删。
    const userSkills = input.userSkills ?? []
    for (const skill of [...userSkills].sort((a, b) => a.id.localeCompare(b.id))) {
      const sourceFile = 'dir' in skill ? join(skill.dir, 'SKILL.md') : skill.file
      const text = await input.io.readFile(sourceFile)
      if (text === undefined) continue // 这一件这会儿读不出来:跳过,别的不受带累
      const file = butlerSkillFile(workDir, skill.id)
      const want = fingerprint(text)
      const existing = await input.io.readFile(file)
      if (existing === undefined) {
        await input.io.writeFile(file, text)
        outcome.installed.push(skill.id)
      }
      else if (existing === text) {
        outcome.current.push(skill.id)
      }
      else {
        await input.io.writeFile(file, text)
        outcome.upgraded.push(skill.id)
      }
      const table = manifest.user_layer ?? {}
      if (table[file] !== want) { table[file] = want; manifest.user_layer = table; manifestChanged = true }
    }
    if (manifestChanged) await input.io.writeFile(input.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

    // 顺带那几份文档:**缺才写**,有了一个字不动(见文件头那一段)。
    for (const rel of Object.keys(input.docs ?? BUNDLED_BUTLER_DOCS).sort()) {
      const text = (input.docs ?? BUNDLED_BUTLER_DOCS)[rel] as string
      const file = join(workDir, rel)
      if (await input.io.readFile(file) !== undefined) continue
      await input.io.writeFile(file, text)
      outcome.docs.push(rel)
    }

    const touched = [...outcome.installed, ...outcome.upgraded]
    const paths = [...(touched.length > 0 ? [BUTLER_SKILLS_DIR] : []), ...outcome.docs]
    if (paths.length > 0 && input.io.git !== undefined && await input.io.exists(join(workDir, '.git'))) {
      const added = await input.io.git(['add', '--', ...paths], workDir)
      if (added.ok) {
        const committed = await input.io.git([
          '-c', 'user.name=工作台', '-c', 'user.email=workbench@localhost',
          'commit', '-q', '-m', BUTLER_SKILLS_COMMIT_MESSAGE, '--', ...paths,
        ], workDir)
        outcome.committed = committed.ok
      }
    }
    outcome.note = describe(outcome, workDir)
    return outcome
  }
  catch (err) {
    outcome.note = `事务官技能没装完:${(err as Error)?.message ?? '没说原因'}(装上了 ${outcome.installed.length + outcome.upgraded.length} 份;下次起服务再补)`
    return outcome
  }
}

function describe(outcome: ButlerSkillsOutcome, workDir: string): string {
  const parts: string[] = []
  if (outcome.installed.length > 0) parts.push(`装上了 ${outcome.installed.join('、')}`)
  if (outcome.upgraded.length > 0) parts.push(`换成这一版:${outcome.upgraded.join('、')}`)
  if (outcome.kept.length > 0) parts.push(`${outcome.kept.join('、')} 被改过,没动`)
  if (outcome.docs.length > 0) parts.push(`补上文档 ${outcome.docs.join('、')}`)
  if (parts.length === 0) return `事务官技能都是这一版(${workDir}/${BUTLER_SKILLS_DIR})`
  return `事务官技能(${workDir}/${BUTLER_SKILLS_DIR}):${parts.join(';')}${outcome.installed.length + outcome.upgraded.length + outcome.docs.length > 0 ? (outcome.committed ? ',已提交' : ',没提交(不是 git 仓库或 git 不在)') : ''}`
}

/** 真的那一套读写(Node)。写走「临时文件 + 改名」,写到一半断电也不留半截文件。 */
export function nodeButlerSkillsIo(): ButlerSkillsIo {
  return {
    async readFile(path) {
      try { return await readFile(path, 'utf8') }
      catch { return undefined }
    },
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, path)
    },
    async exists(path) {
      try { await stat(path); return true }
      catch { return false }
    },
    git: (args, cwd) => new Promise((resolve) => {
      execFile('git', [...args], { cwd, timeout: 15_000 }, err => resolve({ ok: err === null }))
    }),
  }
}
