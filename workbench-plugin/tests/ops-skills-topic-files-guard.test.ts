// @vitest-environment node
/**
 * 守卫:运营技能包的产物路径 ←→ 选题池的目录结构约定(2026-09-21)。
 *
 * 由来:`docs/交接-0921-合并sprint3.md` 第五节第 4 条 ——
 * 「两处定义、内容一致,但**它们之间没有任何用例互相钉着**;哪天谁改了 `templates.ts`
 * 那张表而忘了 `opsSkills.ts`(或反过来),事务官会把 `定稿.md` 写到一个界面不去读的
 * 名字上,而两边的用例都是绿的。」这一份就是那条守卫。
 *
 * 钉四件事:
 * 1. `opsSkills.ts` 的 `artifacts` 里每个**选题类**产物,文件名逐字落在
 *    `templates.ts` 的 `TOPIC_DELIVERABLE_FILES` 里(白名单在下面,写着理由);
 * 2. `TOPIC_DELIVERABLE_FILES` 六段一个不落,每一份都真有技能产出它;
 * 3. `docs/技能/运营-*.md` **正文里写的路径**(人读的那一份)也逐条对得上 ——
 *    技能文本才是事务官真正照着干的东西,它跟代码走样了,代码之间再一致也没用;
 * 4. 账号类产物 `账号/<账号名>/目标.md` 与 `accountSource` / `accounts.ts` 读的
 *    目录名、文件名、五个字段对得上。
 *
 * **一行 I/O 都没有**(只读仓库里的文本),不碰 `~/.dsh`,不写任何文件。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPS_SKILLS, OPS_SKILL_DIR, opsSkillDoc } from '../src/server/opsSkills.ts'
import {
  OPS_ASSET_DIRS, OPS_FAVORITES_REL, TOPIC_ASSET_SUBDIR, TOPIC_DELIVERABLE_FILES, TOPIC_DIR,
} from '../src/templates.ts'
import { TOPIC_STAGES } from '../src/protocol.ts'
import { ACCOUNTS_DIR_NAME, ACCOUNT_FIELDS, ACCOUNT_FILE_NAME, ACCOUNT_NOTES_DIR } from '../src/server/accounts.ts'

/** 仓库根(tests/ 的上两级)。技能文档是**真读**的,不是夹具。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** 六段产物的文件名(`框架.md` 那六个),给下面所有断言当判据。 */
const STAGE_FILES: readonly string[] = TOPIC_STAGES.map(stage => TOPIC_DELIVERABLE_FILES[stage] as string)

/**
 * **白名单**:是技能产物、但**故意**不在 `TOPIC_DELIVERABLE_FILES` 里的选题类文件。
 *
 * 那张常量表钉的是「六段进度**各自**的产物」(界面按段去找它),
 * 下面这些不对应任何一段,所以不该往表里加 —— 加进去反而会让看板多出一段。
 * 要新增一条,**必须在这里写清理由**,而不是悄悄放行。
 */
const 不在六段表里的选题产物: ReadonlyMap<string, string> = new Map([
  ['查词.md', '合规查词随时可查(改一版查一次),不是六段进度里的某一段的产出'],
])

/** 占位名:代码里写 `<选题名>`,技能文本里为了行文短会写 `<名>`。两种都认,别的一律不认。 */
const TOPIC_PLACEHOLDERS = ['<选题名>', '<名>'] as const
const ACCOUNT_PLACEHOLDERS = ['<账号名>', '<名>'] as const

/** 一条产物路径拆成三段:`<顶层目录>/<占位>/<末段>`。拆不开回 undefined(**不猜**)。 */
function splitArtifact(path: string): { top: string, placeholder: string, tail: string } | undefined {
  const parts = path.split('/')
  if (parts.length !== 3) return undefined
  const [top, placeholder, tail] = parts
  if (top === undefined || placeholder === undefined || tail === undefined) return undefined
  return { top, placeholder, tail }
}

/* ───────────────────────── ① 代码 → 常量表 ───────────────────────── */

describe('opsSkills 的选题类产物,逐字落在 TOPIC_DELIVERABLE_FILES 里', () => {
  it('每条选题类产物都是 `选题/<选题名>/<六段表里的文件名>`', () => {
    const topicArtifacts = OPS_SKILLS.flatMap(skill =>
      skill.artifacts.filter(a => a.startsWith(`${TOPIC_DIR}/`)).map(a => ({ skill: skill.name, path: a })),
    )
    // 技能里至少有六条落选题产物,别让"一条都没扫到"冒充全绿。
    expect(topicArtifacts.length).toBeGreaterThanOrEqual(STAGE_FILES.length)

    for (const { skill, path } of topicArtifacts) {
      const parts = splitArtifact(path)
      expect(parts, `${skill} 的产物 ${path} 不是「选题/<选题名>/文件名」三段`).toBeDefined()
      if (parts === undefined) continue
      // 代码里写死用**规范占位**,技能文本里那种简写只在文档里认。
      expect(parts.placeholder, `${skill} 的产物 ${path} 占位应是 <选题名>`).toBe('<选题名>')
      const known = STAGE_FILES.includes(parts.tail) || 不在六段表里的选题产物.has(parts.tail)
      expect(known, [
        `${skill} 的产物 ${path} 的文件名 ${parts.tail} 既不在 TOPIC_DELIVERABLE_FILES 里,`,
        '也不在本用例的白名单里。要么改 templates.ts 那张表,要么在白名单里写清理由。',
      ].join('')).toBe(true)
    }
  })

  it('非选题类的产物只有两处,而且各自有自己的那份定义钉着', () => {
    const others = OPS_SKILLS.flatMap(s => s.artifacts).filter(a => !a.startsWith(`${TOPIC_DIR}/`))
    /**
     * 收藏网址 == templates.ts 的 OPS_FAVORITES_REL;目标.md 走账号那一套(见第四节)。
     * **就这两条,不许有第三条**:2026-09-22 新增的「给 AI 分发任务」`artifacts` 是空的
     * —— 它的产出是**别的技能的产物**(GPT 写的标题落 `发布包装.md`),在那边已经钉着了,
     * 在这里再写一份就是第二份定义。这条用例就是那道闸。
     */
    expect(others.filter(a => a === OPS_FAVORITES_REL)).toHaveLength(1)
    expect(others.filter(a => a.startsWith(`${ACCOUNTS_DIR_NAME}/`))).toHaveLength(1)
    expect(others).toHaveLength(2)
  })
})

/* ───────────────────────── ② 常量表 → 代码 ───────────────────────── */

describe('TOPIC_DELIVERABLE_FILES 里每一份都真有技能产出', () => {
  it('六段一个不落,每一段都能点名是哪条技能落的', () => {
    const produced = new Set(
      OPS_SKILLS.flatMap(s => s.artifacts)
        .map(a => splitArtifact(a))
        .filter((p): p is { top: string, placeholder: string, tail: string } => p !== undefined && p.top === TOPIC_DIR)
        .map(p => p.tail),
    )
    const missing = TOPIC_STAGES.filter(stage => !produced.has(TOPIC_DELIVERABLE_FILES[stage] as string))
    expect(missing, `这几段的产物没有任何技能会落:${missing.join(' / ')}`).toEqual([])
  })

  it('没有哪一份是"表里有、没人写"的(白名单为空 —— 有了就要写理由)', () => {
    /**
     * 与上一条的区别:上一条是**必须全覆盖**,这一条是把「允许不覆盖」的口子摆出来。
     * 今天一个都没有;哪天真要留一个(比如某段的产物改由界面自己生成),
     * 在这里列上并写清理由,而不是把上面那条用例删掉。
     */
    const 允许没有技能产出的段: readonly string[] = []
    expect(允许没有技能产出的段).toEqual([])
  })
})

/* ───────────────────────── ③ 技能文档 → 两处定义 ───────────────────────── */

/** `docs/技能/运营-*.md` 八份(真读目录,不写死文件名 —— 新增一份也会被扫到)。 */
function opsSkillDocs(): { rel: string, text: string }[] {
  return readdirSync(join(REPO_ROOT, OPS_SKILL_DIR))
    .filter(name => name.startsWith('运营-') && name.endsWith('.md'))
    .sort()
    .map(name => ({ rel: `${OPS_SKILL_DIR}/${name}`, text: read(`${OPS_SKILL_DIR}/${name}`) }))
}

/**
 * 从 markdown 正文里把 `选题/…` / `账号/…` / `素材/…` 这类路径抠出来。
 *
 * 判据很窄,**宁可少抠也不乱抠**:从 `<工作目录>/` 或某个顶层目录名起,
 * 到中文标点 / 空白 / 反引号 / 括号为止。抠不干净的行不算路径 —— 一个把散文当路径的
 * 用例会天天误报,红得没人看。
 */
function pathsIn(text: string, top: string): string[] {
  const re = new RegExp(`(?:<工作目录>/)?${top}/[^\\s\`,,。;;:()()\\[\\]「」、]*`, 'g')
  return [...text.matchAll(re)].map(m => m[0].replace(/^<工作目录>\//, '').replace(/[…。,,]+$/, ''))
}

describe('docs/技能/运营-*.md 正文里的路径,与两处定义逐条对得上', () => {
  it('每一份技能文档都在(少一份就不是"全扫过了")', () => {
    const docs = opsSkillDocs()
    expect(docs).toHaveLength(OPS_SKILLS.length)
    expect(docs.map(d => d.rel).sort()).toEqual(OPS_SKILLS.map(s => opsSkillDoc(s)).sort())
  })

  it('文本里每一条 `选题/<名>/xxx.md`,文件名都在六段表或白名单里', () => {
    let seen = 0
    for (const { rel, text } of opsSkillDocs()) {
      for (const path of pathsIn(text, TOPIC_DIR)) {
        const parts = splitArtifact(path)
        if (parts === undefined) {
          // `选题/<选题名>/` 这种"指目录"的写法:只要占位认得出就放过。
          const two = path.split('/')
          expect(two.length, `${rel} 里的 ${path} 既不是目录也不是三段路径`).toBeLessThanOrEqual(3)
          continue
        }
        expect(
          (TOPIC_PLACEHOLDERS as readonly string[]).includes(parts.placeholder),
          `${rel} 里的 ${path} 用了没见过的占位 ${parts.placeholder}`,
        ).toBe(true)
        if (parts.tail === '' || parts.tail === TOPIC_ASSET_SUBDIR) continue // `选题/<名>/素材/`
        seen += 1
        const known = STAGE_FILES.includes(parts.tail) || 不在六段表里的选题产物.has(parts.tail)
        expect(known, [
          `${rel} 里写着 ${path},但文件名 ${parts.tail} 不在 TOPIC_DELIVERABLE_FILES 里。`,
          '技能文本是事务官照着干的那一份 —— 它跟常量表走样,界面就读不到那个文件。',
        ].join('')).toBe(true)
      }
    }
    expect(seen, '一条选题路径都没扫到 —— 正则八成失效了,不许这么绿').toBeGreaterThanOrEqual(STAGE_FILES.length)
  })

  it('六段产物每一份,都至少在一份技能文档里被点过名', () => {
    const all = opsSkillDocs().map(d => d.text).join('\n')
    for (const stage of TOPIC_STAGES) {
      const file = TOPIC_DELIVERABLE_FILES[stage] as string
      expect(all, `六段里「${stage}」的产物 ${file} 在八份技能文档里一次都没出现`).toContain(file)
    }
  })

  it('文本里的 `素材/…`:收藏网址那一份与七类素材库都对得上', () => {
    for (const { rel, text } of opsSkillDocs()) {
      for (const path of pathsIn(text, TOPIC_ASSET_SUBDIR)) {
        const rest = path.slice(`${TOPIC_ASSET_SUBDIR}/`.length)
        if (rest === '' || rest.startsWith('<')) continue // `素材/` 与 `素材/<子文件夹>/…`
        if (rest.endsWith('.md')) {
          expect(path, `${rel} 里的 ${path} 不是 OPS_FAVORITES_REL`).toBe(OPS_FAVORITES_REL)
          continue
        }
        const dir = rest.replace(/\/$/, '')
        expect(
          (OPS_ASSET_DIRS as readonly string[]).includes(dir),
          `${rel} 里的 ${path} 不在 OPS_ASSET_DIRS 七类里`,
        ).toBe(true)
      }
    }
  })
})

/* ───────────────────────── ④ 账号类产物 ←→ accountSource ───────────────────────── */

describe('账号类产物与账号数据源对得上', () => {
  const goal = OPS_SKILLS.find(s => s.name === '运营-运营目标')
  const goalText = read(`${OPS_SKILL_DIR}/运营-运营目标.md`)

  it('产物是 `账号/<账号名>/目标.md`,顶层目录就是 accounts.ts 那一个', () => {
    expect(goal).toBeDefined()
    expect(goal?.artifacts).toEqual([`${ACCOUNTS_DIR_NAME}/<账号名>/目标.md`])
    const parts = splitArtifact(goal?.artifacts[0] as string)
    expect(parts?.top).toBe(ACCOUNTS_DIR_NAME)
    expect((ACCOUNT_PLACEHOLDERS as readonly string[]).includes(parts?.placeholder ?? '')).toBe(true)
    // `目标.md` **不是** `账号.md`:那五个字段归引导与他自己管,目标另起一个文件(技能里写着)。
    expect(parts?.tail).not.toBe(ACCOUNT_FILE_NAME)
  })

  it('技能文本里读的是 `账号/<账号名>/账号.md` 与 `账号/<名>/笔记/`,名字与 accounts.ts 一致', () => {
    expect(goalText).toContain(`${ACCOUNTS_DIR_NAME}/<账号名>/${ACCOUNT_FILE_NAME}`)
    expect(goalText).toContain(`${ACCOUNTS_DIR_NAME}/<名>/${ACCOUNT_NOTES_DIR}/`)
  })

  it('技能里那"五个字段",与 ACCOUNT_FIELDS 逐字、同序相等', () => {
    const matched = /的五个字段:([^;;\n]+)/.exec(goalText)
    expect(matched, '运营-运营目标.md 里那句「…的五个字段:…」不见了,改了措辞就要改这条用例').not.toBeNull()
    const listed = (matched?.[1] ?? '').split('/').map(s => s.trim()).filter(s => s !== '')
    expect(listed).toEqual([...ACCOUNT_FIELDS])
  })

  it('accountSource 真读出来的那两个字段,都在 ACCOUNT_FIELDS 里、也都在技能的输入里', () => {
    // 账号那一格现在从 `账号.md` 里取的就这两项(平台、开号日期),其余三项只进事务官的脑子。
    const source = read('workbench-plugin/src/server/accountSource.ts')
    const used = (ACCOUNT_FIELDS as readonly string[]).filter(field => source.includes(`fields.${field}`))
    expect(used.length, 'accountSource 一个 ACCOUNT_FIELDS 字段都没读 —— 八成改了读法').toBeGreaterThan(0)
    for (const field of used) expect(goalText, `accountSource 读 ${field},技能输入里却没写`).toContain(field)
  })
})

/**
 * 深度复盘从「粘文本」改成「给链接」(2026-09-22 采集类第 4 条)。
 *
 * 这一组钉的是**技能文本与代码里那些闸说的是同一件事**:
 * 技能里要是写着"我去帮你找几篇同类的",代码却只认一条链接,
 * 那事务官就会答应一件它做不到的事 —— 而用户先信的是事务官说的话。
 */
describe('运营-复盘:深度复盘改成「给链接」', () => {
  const text = read(`${OPS_SKILL_DIR}/运营-复盘.md`)

  it('★ 要的是链接,不再是让他粘正文', () => {
    expect(text).toContain('先要链接')
    expect(text).toContain('把地址栏那一条复制过来')
    // 采集接口的名字写在技能里,事务官照着调。
    expect(text).toContain('POST /collect/note')
  })

  it('★ 红线三条逐字写在「不做的」里', () => {
    const tail = text.slice(text.lastIndexOf('## 不做的'))
    expect(tail).toContain('只从他给的链接进')
    expect(tail).toContain('不点任何东西')
    expect(tail).toContain('不替他过')
    expect(tail).toContain('一个凭据都不取')
  })

  it('采集失败时技能里写着「停在那里如实说」,并给了退路(仍可粘文本)', () => {
    expect(text).toContain('就停在那里如实说')
    expect(text).toContain('请他把正文粘给我')
  })

  it('★ 提到拆解时必须带上「机器转写可能有出入」那一句', () => {
    const block = text.slice(text.indexOf('爆款拆解'))
    expect(block).toContain('每一段都带时间戳')
    expect(block).toContain('机器转的,可能有出入')
    expect(block).toContain('不要把转写稿当成原话引用')
  })

  it('清单里那一行摘要也跟着改了(两处说同一件事)', () => {
    const summary = OPS_SKILLS.find(one => one.name === '运营-复盘')?.summary ?? ''
    expect(summary).toContain('给链接')
    expect(summary).not.toContain('粘过来')
  })
})
