/**
 * 把 `docs/技能/*.md` 原样打进插件(2026-09-23)。产物 `src/server/bundledSkills.generated.ts`,
 * tsdown 把它连同服务端代码一起打进 `lib/index.js` —— 于是 dmg 与热更新包带的插件里都有这批技能,
 * 普通用户机器上没有开发仓库也接得上(见 src/server/bundledSkills.ts)。
 *
 * 改了 docs/技能/ 下任何一份之后跑一次:
 *
 *     node workbench-plugin/scripts/gen-bundled-skills.mjs
 *
 * 忘了跑:`tests/bundled-skills-guard.test.ts` 逐字比对,当场红。
 *
 * 2026-09-25(卡 fix/evening-gaps 第 4 条)起还打进仓库根上的 `.dsh/skills/<名字>/SKILL.md`(记忆 / 引导 / 例程):
 * 它们是事务官**自己的**技能,工作台起服务时装进她的工作目录(src/server/butlerSkills.ts)——
 * 以前只在开发仓库里有,维护者机器上她的工作目录与 ~/.dsh 下都没有,「按 .dsh/skills/记忆/SKILL.md 查」读不到。
 * 改了那几份也要跑一次。
 *
 * 2026-09-26(卡「记忆收并推」F)起还打进几份**事务官照着做的文档**(现在只有 `docs/记忆/下班例程.md`):
 * 记忆技能里写着「按 docs/记忆/下班例程.md 八步做」,可那份原来只在开发仓库里有 ——
 * 她的工作目录(`~/Documents/工作台`)下没有,照着做的那份文档读不到。改了它也要跑一次。
 * 与技能的区别:文档**缺才写,有了一个字不动**(她可能按自己的习惯改过),见 src/server/butlerSkills.ts。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillDir = join(here, '..', '..', 'docs', '技能')
const out = join(here, '..', 'src', 'server', 'bundledSkills.generated.ts')

const names = readdirSync(skillDir).filter(name => name.endsWith('.md')).sort()
const butlerSkillDir = join(here, '..', '..', '.dsh', 'skills')
const butlerNames = readdirSync(butlerSkillDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(butlerSkillDir, entry.name, 'SKILL.md')))
  .map(entry => entry.name)
  .sort()
/** 随版本装进她工作目录的文档(相对仓库根;装法见 butlerSkills.ts 的 docs 那一段)。 */
const butlerDocRels = ['docs/记忆/下班例程.md']
const lines = [
  '// 生成文件,别手改:改 docs/技能/*.md、.dsh/skills/*/SKILL.md 或 docs/记忆/下班例程.md 之后跑 `node workbench-plugin/scripts/gen-bundled-skills.mjs`。',
  '// 守卫用例 tests/bundled-skills-guard.test.ts 逐字比对仓库那一份。',
  '/** 文件名(如 `运营-总纲.md`)→ 全文。 */',
  'export const BUNDLED_SKILL_DOCS: Readonly<Record<string, string>> = {',
  ...names.map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(join(skillDir, name), 'utf8'))},`),
  '}',
  '/** 事务官自己的技能:技能名(`.dsh/skills/<名字>/`)→ SKILL.md 全文。装进她工作目录的那一份(butlerSkills.ts)。 */',
  'export const BUNDLED_BUTLER_SKILLS: Readonly<Record<string, string>> = {',
  ...butlerNames.map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(join(butlerSkillDir, name, 'SKILL.md'), 'utf8'))},`),
  '}',
  '/** 事务官照着做的文档:仓库相对路径 → 全文。装进她工作目录同一个相对路径(缺才写,不覆盖她改过的)。 */',
  'export const BUNDLED_BUTLER_DOCS: Readonly<Record<string, string>> = {',
  ...butlerDocRels.map(rel => `  ${JSON.stringify(rel)}: ${JSON.stringify(readFileSync(join(here, '..', '..', rel), 'utf8'))},`),
  '}',
  '',
]
writeFileSync(out, lines.join('\n'))
console.log(`写好 ${names.length} 份技能 + ${butlerNames.length} 份事务官技能(${butlerNames.join('、')}) + ${butlerDocRels.length} 份文档(${butlerDocRels.join('、')})→ ${out}`)
