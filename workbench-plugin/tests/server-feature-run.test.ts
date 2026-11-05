// @vitest-environment node
/**
 * 需求卡 = 指挥台的**纯算那一半**(2026-09-22,
 * `docs/审视-用户到底得到什么-2026-09-22.md` 第三节 + 第四节第三幕)。
 *
 * 这一份钉六件事:
 *
 * 1. **四态归类**:顺序、下一态、认不出归「梳理」——与选题那边同一套分寸;
 * 2. **拆解产物的形状**:四个页签各落哪个文件、这一态派给谁,只有一份定义;
 * 3. **与选题共用一份实现**:diff / 快照 / 留痕走的是同一个 `deckRun.ts`;
 * 4. **那段话里带了什么**:接着做、不要重新问、项目仓库、她说过的原话、派给谁、代做;
 * 5. **决策记录**:宽进严出地读 `记录.md`,只追加、不覆盖、同一条不写两遍;
 * 6. **绝不碰我们自己仓库的那一份决策记录** —— 所有落盘都在 mkdtemp 出来的临时目录里。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureDocView, FeatureReviewEntry } from '../src/protocol.ts'
import {
  DECISION_RECORD_REL, DEFAULT_FEATURE_STAGE, FEATURE_DOC_TABS, FEATURE_HANDS,
  FEATURE_STAGES, FEATURE_STAGE_TABS, featureStageOf, nextFeatureStage,
} from '../src/protocol.ts'
import {
  DECISION_FIELDS, FEATURE_DIR_REL, FEATURE_DOC_FILES, FEATURE_STAGE_HANDS, FEATURE_STAGE_TAB,
  appendDecisionRecord, appendFeatureReview, buildFeatureReviseMessage, buildFeatureRunPrompt,
  featureDirOf, formatDecisionSection, isSafeRecordRel, parseDecisionEntry, readFeatureDocs,
  readFeatureReviews, recordDay, saveFeatureDoc, stageNeedsHands,
} from '../src/server/featureRun.ts'

const NAME = '导出 PDF'
const roots: string[] = []

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 一个临时"她的项目仓库"。**所有写盘只发生在这里面**(硬规矩:不写本仓库的决策记录)。 */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feature-'))
  roots.push(dir)
  return dir
}

function docs(over: Partial<Record<string, string>> = {}): FeatureDocView[] {
  return FEATURE_DOC_TABS.map((tab) => {
    const text = over[tab]
    const file = FEATURE_DOC_FILES[tab]
    return text === undefined
      ? { tab, file, exists: false }
      : { tab, file, exists: true, text, updated_at: '2026-09-22T09:00:00.000Z' }
  })
}

describe('四态', () => {
  it('★ 就是审视第三节那四个字,顺序 = 推进顺序', () => {
    expect(FEATURE_STAGES).toEqual(['梳理', '拆解与派活', '验收', '记录'])
    expect(DEFAULT_FEATURE_STAGE).toBe('梳理')
  })

  it('下一态按顺序走;**最后一态回 undefined**,不绕回第一态', () => {
    expect(nextFeatureStage('梳理')).toBe('拆解与派活')
    expect(nextFeatureStage('拆解与派活')).toBe('验收')
    expect(nextFeatureStage('验收')).toBe('记录')
    expect(nextFeatureStage('记录')).toBeUndefined()
  })

  it('认不出的态归「梳理」,**不抛** —— 盘上可能是任意老字符串', () => {
    expect(featureStageOf(undefined)).toBe('梳理')
    expect(featureStageOf('复盘' as never)).toBe('梳理')
    expect(featureStageOf('验收')).toBe('验收')
  })

  it('每一态都有它要铺开的那个页签,而且那个页签真在四个里面', () => {
    for (const stage of FEATURE_STAGES) {
      const front = FEATURE_STAGE_TABS[stage]
      expect(front.length).toBeGreaterThan(0)
      for (const tab of front) expect(FEATURE_DOC_TABS).toContain(tab)
    }
  })
})

describe('产物的形状', () => {
  it('四个页签各有一个 .md,**四个文件名互不相同**', () => {
    const files = FEATURE_DOC_TABS.map(tab => FEATURE_DOC_FILES[tab])
    expect(files).toHaveLength(4)
    expect(new Set(files).size).toBe(4)
    for (const file of files) expect(file.endsWith('.md')).toBe(true)
  })

  it('每一态的产物落在一个真存在的页签上', () => {
    for (const stage of FEATURE_STAGES) {
      expect(FEATURE_DOC_TABS).toContain(FEATURE_STAGE_TAB[stage])
    }
  })

  it('★ 只有「拆解与派活」要派出去;别的三态是事务官自己办 —— 谈不上代做', () => {
    expect(stageNeedsHands('拆解与派活')).toBe(true)
    expect(stageNeedsHands('梳理')).toBe(false)
    expect(stageNeedsHands('验收')).toBe(false)
    expect(stageNeedsHands('记录')).toBe(false)
    expect(FEATURE_STAGE_HANDS.拆解与派活).toEqual(['codex', 'claude'])
  })

  it('派给谁只有三种,而且 Codex / Claude 那两个 id 与派活那边同名', () => {
    expect(FEATURE_HANDS).toEqual(['codex', 'claude', 'butler'])
  })

  it('需求目录在项目仓库的 docs/需求/<名>/ 下;**名字拐弯的一律不给路径**', () => {
    expect(featureDirOf('/repo', NAME)).toBe(join('/repo', FEATURE_DIR_REL, NAME))
    expect(featureDirOf('/repo', '../etc')).toBeUndefined()
    expect(featureDirOf('/repo', 'a/b')).toBeUndefined()
    expect(featureDirOf('/repo', '.hidden')).toBeUndefined()
    expect(featureDirOf('/repo', '  ')).toBeUndefined()
  })
})

describe('与选题共用同一份实现(deckRun.ts)', () => {
  it('读产物:没有的那几份 exists=false,**不给一段空正文**(没有 ≠ 空)', async () => {
    const repo = tempProject()
    const dir = featureDirOf(repo, NAME) as string
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '需求.md'), '# 目标\n\n导出 PDF', 'utf8')
    const read = await readFeatureDocs(dir)
    expect(read.map(one => one.tab)).toEqual([...FEATURE_DOC_TABS])
    const need = read.find(one => one.tab === '需求') as FeatureDocView
    expect(need.exists).toBe(true)
    expect(need.text).toContain('导出 PDF')
    const sub = read.find(one => one.tab === '子事项') as FeatureDocView
    expect(sub.exists).toBe(false)
    expect(sub.text).toBeUndefined()
  })

  it('写回:第一次不给 diff(整篇标成"新增"是噪音);**第二次存上一版并给段落级 diff**', async () => {
    const repo = tempProject()
    const dir = featureDirOf(repo, NAME) as string
    const first = await saveFeatureDoc({ dir, tab: '子事项', text: '一、写导出按钮\n\n二、生成 PDF', now: new Date() })
    expect(first.ok).toBe(true)
    expect(first.diff).toBeUndefined()

    const second = await saveFeatureDoc({
      dir, tab: '子事项', text: '一、写导出按钮\n\n二、生成 PDF(用 pdfkit)', now: new Date(),
    })
    expect(second.ok).toBe(true)
    expect(second.diff?.some(row => row.kind === 'add')).toBe(true)
    expect(second.diff?.some(row => row.kind === 'same')).toBe(true)
    // 上一版真的留了一份(修订/ 里)。
    expect(existsSync(join(dir, '修订'))).toBe(true)
    expect(readFileSync(join(dir, '子事项.md'), 'utf8')).toContain('pdfkit')
  })

  it('留痕:一行一条 JSON,**追加**;读回来最近的在最后', async () => {
    const repo = tempProject()
    const dir = featureDirOf(repo, NAME) as string
    const one: FeatureReviewEntry = { at: '2026-09-22T01:00:00.000Z', tab: '验收', action: 'pass', stage: '验收' }
    const two: FeatureReviewEntry = { at: '2026-09-22T02:00:00.000Z', tab: '验收', action: 'revise', stage: '验收', text: '这条没测' }
    expect((await appendFeatureReview(dir, one)).ok).toBe(true)
    expect((await appendFeatureReview(dir, two)).ok).toBe(true)
    const back = await readFeatureReviews(dir)
    expect(back).toHaveLength(2)
    expect(back[1]?.text).toBe('这条没测')
  })
})

describe('交给事务官的那段话', () => {
  it('★ 逐字带「不要重新问她一遍背景」—— 她不必再交代一次', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '梳理', dir: '/repo/docs/需求/导出 PDF',
      docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(text).toContain('不要重新问她一遍背景')
    expect(text).toContain('最多问两个问题')
    expect(text).toContain('导出 PDF')
  })

  it('说清这一态、产物落哪个文件、需求目录在哪', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '拆解与派活', dir: '/repo/docs/需求/导出 PDF',
      docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(text).toContain('「拆解与派活」')
    expect(text).toContain(FEATURE_DOC_FILES.子事项)
    expect(text).toContain('/repo/docs/需求/导出 PDF')
  })

  it('带上项目与代码仓库;没挂项目时**整行不出现**(不编一个)', () => {
    const withRepo = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '梳理', dir: '/d', docs: docs(), reviews: [],
      handsReady: true, confirmed: true, project: '工作台', projectPath: '/Users/example/x',
    })
    expect(withRepo).toContain('项目:工作台')
    expect(withRepo).toContain('/Users/example/x')

    const without = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '梳理', dir: '/d', docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(without).not.toContain('代码仓库:')
  })

  it('已有产物按"有了 / 还没有"点名,**不塞全文**', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '拆解与派活', dir: '/d',
      docs: docs({ 需求: '一段很长的需求正文'.repeat(20) }), reviews: [], handsReady: true, confirmed: true,
    })
    expect(text).toContain(`${FEATURE_DOC_FILES.需求}:有了`)
    expect(text).toContain(`${FEATURE_DOC_FILES.子事项}:还没有`)
    expect(text).not.toContain('一段很长的需求正文一段很长的需求正文')
  })

  it('★ 她把过的关带**原话**;`run` 那几条不算把关,不往里塞', () => {
    const reviews: FeatureReviewEntry[] = [
      { at: '2026-09-22T01:00:00.000Z', tab: '子事项', action: 'revise', text: '第二件太大了,再拆' },
      { at: '2026-09-22T02:00:00.000Z', tab: '子事项', action: 'run', text: '顺手把这个也办了' },
    ]
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '拆解与派活', dir: '/d', docs: docs(), reviews, handsReady: true, confirmed: true,
    })
    expect(text).toContain('第二件太大了,再拆')
    expect(text).not.toContain('顺手把这个也办了')
  })

  it('一次关都没把过时如实说一句,不留一段空的', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '验收', dir: '/d', docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(text).toContain('她还没对任何一份产物把过关')
  })

  it('★ 派得出去时说「按「派活给别家Agent」那一节派」,并点名 Codex / Claude', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '拆解与派活', dir: '/d', docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(text).toContain('派活给别家Agent')
    expect(text).toContain('Codex 做代码')
    expect(text).toContain('Claude 审与分析')
    expect(text).not.toContain('你自己顶着做')
  })

  it('★ 派不出去时明说「你自己顶着做」并要它承认是代做 —— 不假装是它们做的', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '拆解与派活', dir: '/d', docs: docs(), reviews: [],
      handsReady: false, confirmed: true, handsNote: '窗口编排壳没接上',
    })
    expect(text).toContain('你自己顶着做')
    expect(text).toContain('这一版是我代做的')
    expect(text).toContain('窗口编排壳没接上')
  })

  it('不需要派活的那几态说「你自己办」,**不谈代做**', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '验收', dir: '/d', docs: docs(), reviews: [], handsReady: false, confirmed: true,
    })
    expect(text).toContain('这一态没有要派出去的活,你自己办')
    expect(text).not.toContain('代做')
  })

  it('★「记录」那一态把五行格式摆出来,并说清**工作台**去追加,它不要自己改那个文件', () => {
    const text = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '记录', dir: '/d', docs: docs(), reviews: [],
      handsReady: true, confirmed: true, recordPath: '/repo/docs/决策记录.md',
    })
    for (const field of DECISION_FIELDS) expect(text).toContain(`- ${field.label}:`)
    expect(text).toContain('写进决策记录')
    expect(text).toContain('/repo/docs/决策记录.md')
    expect(text).toContain('你不用自己去改那个文件')
  })

  it('她补的那一句原样带上;没补时整段不出现', () => {
    const withNote = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '梳理', dir: '/d', docs: docs(), reviews: [],
      handsReady: true, confirmed: true, note: '先只做单页',
    })
    expect(withNote).toContain('先只做单页')
    const without = buildFeatureRunPrompt({
      name: NAME, taskId: 't-1', stage: '梳理', dir: '/d', docs: docs(), reviews: [], handsReady: true, confirmed: true,
    })
    expect(without).not.toContain('她这一次补了一句')
  })

  it('「打回」那一句短、带是哪一份、带卡 id', () => {
    const text = buildFeatureReviseMessage({ name: NAME, taskId: 't-9', tab: '验收', text: '  第三件没验  ' })
    expect(text).toContain(FEATURE_DOC_FILES.验收)
    expect(text).toContain('第三件没验')
    expect(text).toContain('t-9')
    expect(text.split('\n').length).toBeLessThan(8)
  })
})

describe('决策记录', () => {
  const draft = [
    '# 这一条',
    '',
    '- **需求**:给报表加一个导出 PDF',
    '* 做了什么:加了导出按钮与 pdfkit 渲染',
    '谁做的:Codex 写代码,Claude 审了一遍',
    '- 遗留:中文字体还没内嵌',
  ].join('\n')

  it('★ 宽进:`-` / `*` / `**` / 中英文冒号都认', () => {
    const parsed = parseDecisionEntry(draft)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.entry.need).toBe('给报表加一个导出 PDF')
    expect(parsed.entry.did).toContain('pdfkit')
    expect(parsed.entry.who).toContain('Codex')
    expect(parsed.entry.left).toContain('中文字体')
  })

  it('★ 严出:缺哪一行说哪一行,**一个字都不代它写**', () => {
    const parsed = parseDecisionEntry('- 需求:只有这一行')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.missing).toEqual(['做了什么', '谁做的', '遗留'])
  })

  it('一节的形状:日期 + 需求名当标题,底下四行', () => {
    const section = formatDecisionSection({
      day: '2026-09-22', name: NAME,
      entry: { need: 'a', did: 'b', who: 'c', left: 'd' },
    })
    expect(section).toContain(`## 2026-09-22 ${NAME}`)
    for (const field of DECISION_FIELDS) expect(section).toContain(`- ${field.label}:`)
  })

  it('日期是**本地**那一天(不用 UTC 切,东八区早上会切成昨天)', () => {
    expect(recordDay(new Date(2026, 8, 22, 0, 30))).toBe('2026-09-22')
  })

  it('路径可配,但只收项目里的相对 .md —— 绝对路径与 .. 一律不认', () => {
    expect(isSafeRecordRel(DECISION_RECORD_REL)).toBe(true)
    expect(isSafeRecordRel('笔记/决策.md')).toBe(true)
    expect(isSafeRecordRel('/etc/passwd.md')).toBe(false)
    expect(isSafeRecordRel('../外面.md')).toBe(false)
    expect(isSafeRecordRel('docs/决策记录.txt')).toBe(false)
    expect(isSafeRecordRel('')).toBe(false)
  })

  it('★ 文件还没有就建(连同 docs/),第一条带一个标题', async () => {
    const repo = tempProject()
    const written = await appendDecisionRecord({
      projectPath: repo, day: '2026-09-22', name: NAME,
      entry: { need: 'a', did: 'b', who: 'c', left: 'd' },
    })
    expect(written.ok).toBe(true)
    expect(written.added).toBe(true)
    expect(written.path).toBe(join(repo, DECISION_RECORD_REL))
    const body = readFileSync(written.path, 'utf8')
    expect(body.startsWith('# 决策记录')).toBe(true)
    expect(body).toContain(`## 2026-09-22 ${NAME}`)
  })

  it('★ 只追加不覆盖:原来那一条还在', async () => {
    const repo = tempProject()
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, DECISION_RECORD_REL), '# 决策记录\n\n## 2026-09-01 老的一条\n\n- 需求:老的\n', 'utf8')
    await appendDecisionRecord({
      projectPath: repo, day: '2026-09-22', name: NAME,
      entry: { need: 'a', did: 'b', who: 'c', left: 'd' },
    })
    const body = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(body).toContain('老的一条')
    expect(body).toContain(NAME)
  })

  it('★ 一模一样的一节不写第二遍(同一颗按钮点两下不该出现两条)', async () => {
    const repo = tempProject()
    const entry = { need: 'a', did: 'b', who: 'c', left: 'd' } as const
    await appendDecisionRecord({ projectPath: repo, day: '2026-09-22', name: NAME, entry })
    const again = await appendDecisionRecord({ projectPath: repo, day: '2026-09-22', name: NAME, entry })
    expect(again.ok).toBe(true)
    expect(again.added).toBe(false)
    const body = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(body.split(`## 2026-09-22 ${NAME}`)).toHaveLength(2)
  })

  it('路径可配:换一个 rel 就落到那儿', async () => {
    const repo = tempProject()
    const written = await appendDecisionRecord({
      projectPath: repo, rel: '笔记/决定.md', day: '2026-09-22', name: NAME,
      entry: { need: 'a', did: 'b', who: 'c', left: 'd' },
    })
    expect(written.ok).toBe(true)
    expect(readFileSync(join(repo, '笔记/决定.md'), 'utf8')).toContain(NAME)
  })

  it('★ 路径不合法时**一个字节都不写**,如实回那句原话', async () => {
    const repo = tempProject()
    const written = await appendDecisionRecord({
      projectPath: repo, rel: '../外面.md', day: '2026-09-22', name: NAME,
      entry: { need: 'a', did: 'b', who: 'c', left: 'd' },
    })
    expect(written.ok).toBe(false)
    expect(written.reason).toContain('相对')
    expect(existsSync(join(repo, '..', '外面.md'))).toBe(false)
  })
})
