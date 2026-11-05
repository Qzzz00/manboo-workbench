// @vitest-environment node
/**
 * 运营目标与经验闭环(2026-09-22 卡④)。四件事各钉一节:
 *
 * ① `账号/<名>/目标.md` 读回来 + 早报里那句进度怎么算;
 * ② `选题/<名>/复盘.md` 的自评写入(五格、幂等、经验同时落 `经验.md`);
 * ③ `账号/<名>/经验.md` 的追加(建骨架、去重);
 * ④ `账号.md` 的画像段回写(整段重写、**幂等**、没内容就不写)。
 *
 * 用真临时目录里的真文件 —— 这一层的价值全在"盘上到底写成什么样",
 * 假 fs 兜住等于没测(同 server-accounts.test.ts 的做法)。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_EXPERIENCE_FILE, ACCOUNT_FILE_NAME, ACCOUNT_GOAL_FILE,
  ACCOUNT_PROFILE_BEGIN, ACCOUNT_PROFILE_END,
  accountsDir, appendAccountExperience, composeGoalProgress, countPublishedInPeriod,
  newAccountFile, parseAccountGoal, parseGoalCount, parseReviewLog, readAccountGoal,
  readExperienceLines, renderProfileSection, upsertProfileSection, writeAccountProfile,
} from '../src/server/accounts.ts'
import {
  TOPIC_REVIEW_FILE, TOPIC_REVIEW_LOG_FILE,
  readReviewLogs, validateTopicReview, writeTopicReview,
} from '../src/server/topicReview.ts'
import { composeMorningReport } from '../src/server/routineMemory.ts'
import type { RoutinesService } from '../src/server/routines.ts'
import { createRoutinesService } from '../src/server/routines.ts'
import { TOPIC_DELIVERABLE_FILES, TOPIC_DIR } from '../src/templates.ts'

let cwd = ''

beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'ops-goals-')) })
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

/** 技能 docs/技能/运营-运营目标.md 里那份钉死的格式,逐字。 */
const GOAL_MD = [
  '# 小食堂 · 运营目标',
  '',
  '> 由事务官生成于 2026-09-01,依据:账号.md 的定位/人群/平台 + 近 30 日真实数据。',
  '',
  '- **周期**:2026-09-01 到 2026-09-30',
  '- **笔记发布目标**:8 条',
  '- **粉丝目标**:1450(起点 1200)',
  '- **定这两个数的依据**:上 30 天发了 6 条、涨了 214,他拍的',
  '',
  '## 拆到周',
  '- 第 1 周(09-01 到 09-07):2 条',
  '',
  '## 进展(倒序,一条一日期)',
  '- 2026-09-01:建档(近 30 日真实数据)',
  '',
].join('\n')

async function seedAccount(name: string, goal?: string): Promise<string> {
  const dir = join(accountsDir(cwd), name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, ACCOUNT_FILE_NAME), newAccountFile(name, {
    fields: { 平台: '小红书' }, date: '2026-09-01', origin: '引导访谈',
  }), 'utf8')
  if (goal !== undefined) await writeFile(join(dir, ACCOUNT_GOAL_FILE), goal, 'utf8')
  return dir
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 目标.md 读回来', () => {
  it('技能那份格式四行全读得出来', () => {
    const goal = parseAccountGoal(GOAL_MD)
    expect(goal.period).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(goal.notes_target).toBe(8)
    expect(goal.fans_target).toBe(1450)
    expect(goal.fans_start).toBe(1200)
    expect(goal.unreadable).toEqual([])
  })

  it('「起点没取到」是技能里明写的一种写法:**不算读不懂**,就是没有起点', () => {
    const goal = parseAccountGoal('- **粉丝目标**:1450(起点 起点没取到)\n')
    expect(goal.fans_target).toBe(1450)
    expect(goal.fans_start).toBeUndefined()
    expect(goal.unreadable).toEqual([])
  })

  it('半角括号、全角冒号照收 —— 这文件是人改的,别在标点上难为她', () => {
    const goal = parseAccountGoal('- **粉丝目标**:300(起点 100)\n- **笔记发布目标**: 12 条\n')
    expect(goal.fans_target).toBe(300)
    expect(goal.fans_start).toBe(100)
    expect(goal.notes_target).toBe(12)
  })

  it('★ 读不懂的整行带回 unreadable,**不猜一个数**', () => {
    const goal = parseAccountGoal([
      '- **周期**:这个月',
      '- **笔记发布目标**:多发点',
      '- **粉丝目标**:涨一些',
    ].join('\n'))
    expect(goal.period).toBeUndefined()
    expect(goal.notes_target).toBeUndefined()
    expect(goal.fans_target).toBeUndefined()
    expect(goal.unreadable).toHaveLength(3)
    expect(goal.unreadable[0]).toContain('这个月')
  })

  it('★「1.2万」一律不认 —— 取首个数字会把它读成 1,差四个量级', () => {
    expect(parseGoalCount('1.2万')).toBeUndefined()
    expect(parseGoalCount('1,200')).toBe(1200)
    expect(parseGoalCount('8 条')).toBe(8)
    expect(parseGoalCount('  12  ')).toBe(12)
  })

  it('目标.md 不在 = 还没定目标,不是错', async () => {
    const dir = await seedAccount('小食堂')
    expect(await readAccountGoal(dir)).toEqual({ exists: false })
  })

  it('目标.md 在就带着解析结果回来', async () => {
    const dir = await seedAccount('小食堂', GOAL_MD)
    const read = await readAccountGoal(dir)
    expect(read.exists).toBe(true)
    expect(read.goal?.notes_target).toBe(8)
  })
})

describe('② 已发布数怎么数', () => {
  const board = [
    { kind: 'topic', project_id: 'a', published_at: '2026-09-03' },
    { kind: 'topic', project_id: 'a', published_at: '2026-09-29' },
    { kind: 'topic', project_id: 'a', published_at: '2026-08-31' }, // 周期外
    { kind: 'topic', project_id: 'b', published_at: '2026-09-10' }, // 别的账号
    { kind: 'topic', project_id: 'a' }, // 还没发
    { project_id: 'a', published_at: '2026-09-05' }, // 普通事项,不是选题
  ]
  const period = { from: '2026-09-01', to: '2026-09-30' }

  it('只数「这个账号的选题 + published_at 落在周期里」', () => {
    expect(countPublishedInPeriod(board, 'a', period)).toBe(2)
  })

  it('★ 账号对不上 / 周期读不懂 → undefined(「算不了」),**不是 0**', () => {
    expect(countPublishedInPeriod(board, undefined, period)).toBeUndefined()
    expect(countPublishedInPeriod(board, 'a', undefined)).toBeUndefined()
  })
})

describe('③ 早报里那一句', () => {
  const goal = parseAccountGoal(GOAL_MD)

  it('没目标就一句「还没定目标」', () => {
    expect(composeGoalProgress({ account: '小食堂' })).toBe('「小食堂」还没定目标。')
  })

  it('两样都取到:发了几篇、差几篇、涨了多少、差多少', () => {
    const line = composeGoalProgress({
      account: '小食堂',
      goal,
      published: 3,
      fans: { value: 120, raw: '120', range: '近 30 日' },
    })
    expect(line).toContain('2026-09-01 到 2026-09-30 发了 3/8 篇,还差 5 篇')
    expect(line).toContain('粉丝目标 1450(起点 1200),近 30 日涨了 120,还差 130')
  })

  it('★ 涨粉那一项的口径每次都说清:它是近 7 / 近 30 日那一份,不是按周期算的', () => {
    const line = composeGoalProgress({
      account: '小食堂', goal, published: 3, fans: { value: 120, raw: '120', range: '近 30 日' },
    })
    expect(line).toContain('不是按周期算的')
  })

  it('★ 涨粉没取到就说取不到并带上为什么,**差多少不算**', () => {
    const line = composeGoalProgress({
      account: '小食堂', goal, published: 3, fans_absent_why: '这个账号还没登录过',
    })
    expect(line).toContain('涨粉这次没取到(这个账号还没登录过),差多少算不了')
    expect(line).not.toContain('还差 130')
  })

  it('★ 起点没取到 → 只念涨了多少,差多少明说算不了', () => {
    const noStart = parseAccountGoal('- **周期**:2026-09-01 到 2026-09-30\n- **粉丝目标**:1450\n')
    const line = composeGoalProgress({
      account: '小食堂', goal: noStart, fans: { value: 120, raw: '120', range: '近 7 日' },
    })
    expect(line).toContain('起点没取到、差多少算不了')
    expect(line).toContain('近 7 日涨了 120')
  })

  it('★ 已发布数算不了时说「算不了」,不写 0/8', () => {
    const line = composeGoalProgress({ account: '小食堂', goal })
    expect(line).toContain('已发几篇算不了')
    expect(line).not.toContain('0/8')
  })

  it('发够了 / 超了都如实说,不加一句鼓劲', () => {
    expect(composeGoalProgress({ account: '小食堂', goal, published: 8 })).toContain('发了 8/8 篇,刚好够')
    expect(composeGoalProgress({ account: '小食堂', goal, published: 10 })).toContain('多出 2 篇')
  })

  it('读不懂的那几行在早报里点名说出来', () => {
    const broken = parseAccountGoal('- **周期**:这个月\n- **笔记发布目标**:8 条\n')
    expect(composeGoalProgress({ account: '小食堂', goal: broken })).toContain('没读懂、跳过了')
  })
})

describe('④ 进度句进早报正文', () => {
  const state = { running: 0, waiting: 0, confirm: 0 } as never

  it('goals 缺席 = 与加它之前逐字相同', () => {
    const before = composeMorningReport({ state })
    const after = composeMorningReport({ state, goals: [] })
    expect(after.text).toBe(before.text)
  })

  it('有进度句就排在三句之后、资讯之前', () => {
    const report = composeMorningReport({
      state,
      goals: ['「小食堂」发了 3/8 篇。'],
      feed: [{ project_name: '小食堂', items: [{ title: '露营热', why: '与她的选题有关' }] }],
    })
    expect(report.text.indexOf('「小食堂」发了 3/8 篇。')).toBeGreaterThan(report.text.indexOf('今天在盯'))
    expect(report.text.indexOf('「小食堂」发了 3/8 篇。')).toBeLessThan(report.text.indexOf('今天看到'))
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑤ 复盘自评写入', () => {
  it('五格的产物文件名与模板里「复盘」那一段的产物一致', () => {
    expect(TOPIC_REVIEW_FILE).toBe(TOPIC_DELIVERABLE_FILES.复盘)
  })

  it('★ 五格一格都没填 → 拒绝,不生成一份空壳复盘', () => {
    const result = validateTopicReview({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('一格都没填')
  })

  it('★ 自评分不在 1–5 就拒绝(技能里那一问就是 1-5)', () => {
    for (const score of [0, 6, 3.5, '高']) {
      expect(validateTopicReview({ score }).ok).toBe(false)
    }
    expect(validateTopicReview({ score: 4 }).ok).toBe(true)
    expect(validateTopicReview({ score: '4' })).toEqual({ ok: true, review: { score: 4 } })
  })

  it('写出去的五格按固定顺序,没填的格整行不出现', async () => {
    const topicsDir = join(cwd, TOPIC_DIR)
    await seedAccount('小食堂')
    const result = await writeTopicReview({
      topicsDir,
      accountsRoot: accountsDir(cwd),
      name: '露营锅具怎么选',
      review: { score: 4, good: '开头那句钩子', lesson: '封面放人脸比放锅好' },
      account: '小食堂',
      date: '2026-09-22',
      origin: '她在工作台上填的',
    })
    expect(result.ok).toBe(true)
    expect(result.appended).toBe(true)
    const text = await readFile(join(topicsDir, '露营锅具怎么选', TOPIC_REVIEW_FILE), 'utf8')
    expect(text).toContain('## 自评(2026-09-22)')
    expect(text).toContain('- **自评分**:4/5')
    expect(text).toContain('- **好在哪**:开头那句钩子')
    expect(text).toContain('- **经验一句话**:封面放人脸比放锅好')
    // 没填的两格整行不出现 —— 不写「未填」。
    expect(text).not.toContain('差在哪')
    expect(text).not.toContain('下次怎么做')

    // 经验那一句同时落了账号的经验.md。
    const experience = await readFile(join(accountsDir(cwd), '小食堂', ACCOUNT_EXPERIENCE_FILE), 'utf8')
    expect(experience).toContain('- 2026-09-22:封面放人脸比放锅好(《露营锅具怎么选》复盘自评)')
  })

  it('★ 同一份自评写两遍只有一节(幂等)', async () => {
    const topicsDir = join(cwd, TOPIC_DIR)
    await seedAccount('小食堂')
    const input = {
      topicsDir,
      accountsRoot: accountsDir(cwd),
      name: '露营锅具怎么选',
      review: { score: 4, lesson: '封面放人脸比放锅好' },
      account: '小食堂',
      date: '2026-09-22',
      origin: '她在工作台上填的',
    }
    await writeTopicReview(input)
    const again = await writeTopicReview(input)
    expect(again.appended).toBe(false)
    const text = await readFile(join(topicsDir, '露营锅具怎么选', TOPIC_REVIEW_FILE), 'utf8')
    expect(text.match(/## 自评/g)).toHaveLength(1)
    const experience = await readFile(join(accountsDir(cwd), '小食堂', ACCOUNT_EXPERIENCE_FILE), 'utf8')
    expect(experience.match(/封面放人脸比放锅好/g)).toHaveLength(1)
  })

  it('改天再复盘一次 = 多一节,旧的一个字不动', async () => {
    const topicsDir = join(cwd, TOPIC_DIR)
    const base = { topicsDir, accountsRoot: accountsDir(cwd), name: '露营锅具怎么选', origin: '她填的' }
    await writeTopicReview({ ...base, review: { score: 4 }, date: '2026-09-22' })
    await writeTopicReview({ ...base, review: { score: 5 }, date: '2026-09-25' })
    const text = await readFile(join(topicsDir, '露营锅具怎么选', TOPIC_REVIEW_FILE), 'utf8')
    expect(text).toContain('## 自评(2026-09-22)')
    expect(text).toContain('## 自评(2026-09-25)')
    expect(text.indexOf('2026-09-22')).toBeLessThan(text.indexOf('2026-09-25'))
  })

  it('★ 没说归哪个账号:复盘照样落,经验那一句如实说没落', async () => {
    const result = await writeTopicReview({
      topicsDir: join(cwd, TOPIC_DIR),
      accountsRoot: accountsDir(cwd),
      name: '露营锅具怎么选',
      review: { lesson: '封面放人脸比放锅好' },
      date: '2026-09-22',
      origin: '她填的',
    })
    expect(result.ok).toBe(true)
    expect(result.appended).toBe(true)
    expect(result.note).toContain('没说归哪个账号')
  })

  it('选题名当不了目录名的一律不写', async () => {
    const result = await writeTopicReview({
      topicsDir: join(cwd, TOPIC_DIR),
      accountsRoot: accountsDir(cwd),
      name: '../跑出去',
      review: { score: 3 },
      date: '2026-09-22',
      origin: '她填的',
    })
    expect(result.ok).toBe(false)
  })
})

describe('⑥ 经验.md', () => {
  it('文件不在就先建骨架,一行一条', async () => {
    await seedAccount('小食堂')
    const first = await appendAccountExperience(cwd, '小食堂', { lesson: '开头三秒要给结论', date: '2026-09-22', origin: '《A》复盘自评' })
    expect(first.ok).toBe(true)
    expect(first.appended).toBe(true)
    const text = await readFile(join(accountsDir(cwd), '小食堂', ACCOUNT_EXPERIENCE_FILE), 'utf8')
    expect(text).toContain('# 小食堂 · 经验')
    expect(text).toContain('- 2026-09-22:开头三秒要给结论(《A》复盘自评)')
  })

  it('★ 一模一样的一条不追加第二遍', async () => {
    await seedAccount('小食堂')
    const input = { lesson: '开头三秒要给结论', date: '2026-09-22', origin: '《A》复盘自评' }
    await appendAccountExperience(cwd, '小食堂', input)
    const again = await appendAccountExperience(cwd, '小食堂', input)
    expect(again.appended).toBe(false)
  })

  it('空的一句话拒绝', async () => {
    await seedAccount('小食堂')
    expect((await appendAccountExperience(cwd, '小食堂', { lesson: '   ', date: '2026-09-22', origin: 'x' })).ok).toBe(false)
  })

  it('读回来只拿「## 经验」那一节的行', () => {
    expect(readExperienceLines([
      '# 小食堂 · 经验', '', '> 说明行', '', '## 经验', '- 2026-09-22:甲(《A》)', '- 2026-09-23:乙(《B》)', '',
    ].join('\n'))).toEqual(['2026-09-22:甲(《A》)', '2026-09-23:乙(《B》)'])
  })
})

describe('⑦ 审核记录.jsonl 数一遍', () => {
  it('按读到的 action 分组,**不写死那三个词**', () => {
    const stats = parseReviewLog([
      '{"at":"2026-09-20T10:00:00Z","doc":"定稿.md","action":"通过"}',
      '{"at":"2026-09-21T10:00:00Z","doc":"定稿.md","action":"改一改","note":"开头太长"}',
      '{"at":"2026-09-22T10:00:00Z","doc":"发布包装.md","action":"通过"}',
    ].join('\n'))
    expect(stats.total).toBe(3)
    expect(stats.by_action).toEqual([{ action: '通过', count: 2 }, { action: '改一改', count: 1 }])
    expect(stats.notes[0]).toMatchObject({ note: '开头太长', doc: '定稿.md' })
  })

  it('★ 坏掉的一行安静跳过,别的照数', () => {
    const stats = parseReviewLog('{"action":"通过"}\n这不是 JSON\n{"action":"通过"}')
    expect(stats.total).toBe(2)
  })

  it('★ 最近几句按 at 倒序,没有 at 的排后面', () => {
    const stats = parseReviewLog([
      '{"at":"2026-09-20T10:00:00Z","action":"改一改","note":"旧"}',
      '{"action":"改一改","note":"没时间"}',
      '{"at":"2026-09-22T10:00:00Z","action":"改一改","note":"新"}',
    ].join('\n'))
    expect(stats.notes.map(item => item.note)).toEqual(['新', '旧', '没时间'])
  })

  it('选题目录不在 = 一条都没有,不是错', async () => {
    expect(await readReviewLogs(join(cwd, TOPIC_DIR))).toEqual({ total: 0, by_action: [], notes: [] })
  })

  it('所有选题的记录合起来数', async () => {
    const topicsDir = join(cwd, TOPIC_DIR)
    for (const [name, action] of [['甲', '通过'], ['乙', '改一改']]) {
      await mkdir(join(topicsDir, name as string), { recursive: true })
      await writeFile(join(topicsDir, name as string, TOPIC_REVIEW_LOG_FILE), `{"at":"2026-09-22T10:00:00Z","action":"${action as string}"}\n`, 'utf8')
    }
    const stats = await readReviewLogs(topicsDir)
    expect(stats.total).toBe(2)
    expect(stats.by_action.map(item => item.action).sort()).toEqual(['改一改', '通过'])
  })
})

describe('⑧ 画像回写', () => {
  const reviews = parseReviewLog([
    '{"at":"2026-09-22T10:00:00Z","doc":"定稿.md","action":"改一改","note":"开头太长"}',
    '{"at":"2026-09-21T10:00:00Z","doc":"定稿.md","action":"通过"}',
  ].join('\n'))

  it('两边都空 → 整段不写(不塞一句「暂无」)', () => {
    expect(renderProfileSection({ experiences: [], reviews: { total: 0, by_action: [], notes: [] }, date: '2026-09-22' })).toBeUndefined()
  })

  it('段里每一句都能追到出处', () => {
    const section = renderProfileSection({ experiences: ['2026-09-22:封面放人脸(《A》)'], reviews, date: '2026-09-22' }) as string
    expect(section.startsWith(ACCOUNT_PROFILE_BEGIN)).toBe(true)
    expect(section).toContain('风格与偏好(工作台学到的)')
    expect(section).toContain('封面放人脸')
    expect(section).toContain('改一改 1')
    expect(section).toContain('「开头太长」')
    expect(section.trimEnd().endsWith(ACCOUNT_PROFILE_END)).toBe(true)
  })

  it('★ 她说过不止一次的偏好单独一行列出,与「打回时你说过的」那几句(单次原话)分开(2026-09-23)', () => {
    const line = '「开头太长」—— 在《A》《B》上都打回过(试用中,2026-09-23 起)'
    const section = renderProfileSection({ experiences: [], reviews, date: '2026-09-23', preferences: [line] }) as string
    expect(section).toContain('你说过不止一次的偏好')
    expect(section).toContain(`  - ${line}`)
    expect(section).toContain('没见效自动撤')
    // 只有偏好、没有经验也没有把关记录时,这一段照样写(它有内容)。
    const only = renderProfileSection({ experiences: [], reviews: { total: 0, by_action: [], notes: [] }, date: '2026-09-23', preferences: [line] })
    expect(only).toContain(line)
    // 缺席或空 → 与加它之前逐字相同。
    const plain = renderProfileSection({ experiences: [], reviews, date: '2026-09-23' })
    expect(renderProfileSection({ experiences: [], reviews, date: '2026-09-23', preferences: [] })).toBe(plain)
    expect(plain).not.toContain('偏好**')
  })

  it('★ 标记之间整段换掉,标记之外一个字不动', () => {
    const before = `# 小食堂\n\n- **平台**:小红书\n\n${ACCOUNT_PROFILE_BEGIN}\n旧的\n${ACCOUNT_PROFILE_END}\n\n## 我自己写的\n- 一行\n`
    const next = upsertProfileSection(before, `${ACCOUNT_PROFILE_BEGIN}\n新的\n${ACCOUNT_PROFILE_END}\n`)
    expect(next.changed).toBe(true)
    expect(next.text).toContain('- **平台**:小红书')
    expect(next.text).toContain('## 我自己写的')
    expect(next.text).toContain('新的')
    expect(next.text).not.toContain('旧的')
  })

  it('★ 内容一个字没变 → changed:false(连写都不写)', () => {
    const section = `${ACCOUNT_PROFILE_BEGIN}\n新的\n${ACCOUNT_PROFILE_END}\n`
    const once = upsertProfileSection(`# 小食堂\n`, section)
    expect(upsertProfileSection(once.text, section).changed).toBe(false)
  })

  it('★ 整条链路幂等:同样的素材跑两次,第二次不写盘', async () => {
    await seedAccount('小食堂')
    const input = { experiences: ['2026-09-22:封面放人脸(《A》)'], reviews, date: '2026-09-22' }
    const first = await writeAccountProfile(cwd, '小食堂', input)
    expect(first.written).toBe(true)
    const second = await writeAccountProfile(cwd, '小食堂', input)
    expect(second.written).toBe(false)
    const text = await readFile(join(accountsDir(cwd), '小食堂', ACCOUNT_FILE_NAME), 'utf8')
    expect(text.match(new RegExp(ACCOUNT_PROFILE_BEGIN.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'), 'g'))).toHaveLength(1)
    // 五个字段与人自己写的「进展」一个字没动。
    expect(text).toContain('- **平台**:小红书')
    expect(text).toContain('## 进展(倒序,一条一日期)')
  })

  it('账号.md 还不在就什么都不做 —— 不替她建一份账号档案', async () => {
    await mkdir(join(accountsDir(cwd), '小食堂'), { recursive: true })
    const result = await writeAccountProfile(cwd, '小食堂', { experiences: ['x'], reviews, date: '2026-09-22' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('账号.md')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑨ 两个钩子挂进例程', () => {
  async function routinesHarness(options: {
    goals?: () => Promise<readonly string[]>
    profile?: () => Promise<string | undefined>
  }): Promise<{ routines: RoutinesService, sent: string[] }> {
    const configFile = join(cwd, 'routines.json')
    const stateFile = join(cwd, 'routines-state.json')
    const sent: string[] = []
    const routines = createRoutinesService({
      configFile,
      stateFile,
      skipRetryMs: 0,
      session: { open: async (message: string) => { sent.push(message); return 'sess-1' } },
      ...(options.goals === undefined ? {} : { goalsBeforeMorning: options.goals }),
      ...(options.profile === undefined ? {} : { profileAfterEvening: options.profile }),
    })
    await routines.load()
    routines.attach({
      readState: async () => ({
        agents: [], sessions: [], quota: {}, now: new Date().toISOString(), stale: false,
      } as never),
    })
    return { routines, sent }
  }

  it('进度句进早报正文,念给她听', async () => {
    const h = await routinesHarness({ goals: async () => ['「小食堂」发了 3/8 篇,还差 5 篇。'] })
    const run = await h.routines.run('morning', 'manual')
    expect(run.ok).toBe(true)
    expect(h.sent[0]).toContain('「小食堂」发了 3/8 篇,还差 5 篇。')
  })

  it('★ 目标那一步抛了不连累开工汇报 —— 早报照发,原因如实记进 note', async () => {
    const h = await routinesHarness({ goals: async () => { throw new Error('工作目录读不了') } })
    const run = await h.routines.run('morning', 'manual')
    expect(run.ok && run.run.status).toBe('ok')
    expect(run.ok && run.run.note).toContain('运营目标对进度出错:工作目录读不了')
    expect(h.sent).toHaveLength(1)
  })

  it('★ 画像回写「先写后说」:那句话进下班例程的 note 与会话第一条', async () => {
    const h = await routinesHarness({ profile: async () => '画像回写:小食堂 的「风格与偏好」更新了' })
    const run = await h.routines.run('evening', 'manual')
    expect(run.ok && run.run.note).toContain('画像回写:小食堂 的「风格与偏好」更新了')
    expect(h.sent[0]).toContain('画像回写:小食堂 的「风格与偏好」更新了')
  })

  it('★ 画像回写抛了不连累下班例程的其余几步', async () => {
    const h = await routinesHarness({ profile: async () => { throw new Error('盘满了') } })
    const run = await h.routines.run('evening', 'manual')
    expect(run.ok && run.run.status).toBe('ok')
    expect(run.ok && run.run.note).toContain('画像回写出错:盘满了')
  })

  it('两个钩子都缺席 = 与加它们之前逐字相同', async () => {
    const h = await routinesHarness({})
    const before = await h.routines.run('morning', 'manual')
    expect(before.ok && before.run.note).toBe('没配记忆仓库(routines.json 的 repo),第一句没有')
  })
})
