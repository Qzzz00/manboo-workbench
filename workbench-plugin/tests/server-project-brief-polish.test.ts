// @vitest-environment node
/**
 * 已有项目拉齐小修(2026-09-24 下午,卡 fix/project-brief-polish;统筹真机自验发现的三处,
 * 见 docs/验收报告-2026-09-24-已有项目拉齐.md 第一、二、三、八节)。
 *
 * 钉住:
 *   - 出处写对:这一次引导里读过这个 path 的摘要、这一条记在读之后、他那句只是点头 / 在她念的里面挑 →
 *     一句话 / 进展 / 下一步(与建档那一行)标「读仓库说明,他确认」;没读过、他改了说法、更正 → 仍是「引导访谈,他口述」;
 *     新点子那一支一字不改。判据只看事实(读没读过、他真说了什么),不靠模型报;
 *   - 别读两遍:同一个 path 60 秒内直接回上一份(不续期),过期重读,不同 path 各读各的;
 *   - 改口重问别说过程话:两段 note 里不再出现「再问一遍」,写的是「直接照那句问」。
 * 记忆仓库都在 mkdtemp 出来的临时目录里;读项目用的路径是假的(这一层不碰磁盘)。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, stageDef } from '../src/server/onboardingStages.ts'
import {
  ASK_TO_READ, BRIEF_NOTE, BRIEF_REUSE_MS, READ_CONSENT_NOTE, SURFACED_TTL_MS, briefPathKey, confirmsOnly, createBriefReuse,
  type ProjectBrief,
} from '../src/server/projectBrief.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ———————————————————————— 话术 ————————————————————————

describe('改口重问别说过程话:两段 note', () => {
  it('不再出现「再问一遍」;写的是直接照那句问、不提前面问过、不说「确认一下」', () => {
    for (const note of [READ_CONSENT_NOTE, BRIEF_NOTE]) {
      expect(note).not.toContain('再问一遍')
      expect(note).toContain('直接照')
      expect(note).toContain('不提前面问过')
      expect(note).toContain('也不说「确认一下」这类话')
      expect(note).toContain(ASK_TO_READ)
    }
    expect(READ_CONSENT_NOTE).toContain('他后来改口说「你去看吧」「你自己读吧」:**直接照上面那句问他**')
    expect(BRIEF_NOTE).toContain(`之后他又说「你去看吧」,直接照「${ASK_TO_READ}」问他`)
  })

  it('读好的那段 note 开头就说:已经读好了,不用再调 project-brief / read_project', () => {
    const first = BRIEF_NOTE.split('\n')[0] as string
    expect(first).toContain('**已经读好了,同一个项目不用再读一遍**')
    expect(first).toContain('不用再调 project-brief / read_project')
    expect(first).toContain('他后来说「你再看看」才再读')
  })

  it('电脑那条路的说法同步:第一条消息的清单与引导技能 —— 找到时已读好不用再调 project-brief;改口那条没有「再问一遍」', () => {
    const goals = stageDef('projects', 'existing', 'product').goals
    expect(goals.some(goal => goal.includes('**不用再调 project-brief**'))).toBe(true)
    const goalLines = goals.filter(goal => goal.includes('你去看吧'))
    expect(goalLines).toHaveLength(1)
    expect(goalLines[0]).toContain('**直接照上面那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话')
    expect(goalLines[0]).not.toContain('再问一遍')

    const skill = readFileSync(join(import.meta.dirname, '..', '..', '.dsh', 'skills', '引导', 'SKILL.md'), 'utf8')
    expect(skill).toContain('—— **不用再调 project-brief**,**照 `note` 说**')
    expect(skill).toContain('只找到一个时顺手读好,**不用再调 `read_project`**')
    const step7 = skill.slice(skill.indexOf('  7. 他说不可以读目录'), skill.indexOf('  8. 这一个聊完告诉他'))
    expect(step7).toContain('**直接照第 2 步那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话')
    expect(step7).not.toContain('再问一遍')
  })
})

// ———————————————————————— 别读两遍 ————————————————————————

function fakeBrief(path: string): ProjectBrief {
  return { name: path.split('/').at(-1) as string, path, brief: `【项目】${path}`, sources: [], missing: [], redacted: 0, git: true }
}

describe('刚读过的(createBriefReuse / briefPathKey)', () => {
  it('同一个键 60 秒以内回上一份(带多久以前读的),到点就没了;用了不续期', () => {
    let now = 1_000_000
    const reuse = createBriefReuse(() => now)
    const one = fakeBrief('/code/desktop-workbench')
    expect(reuse.get('/code/desktop-workbench')).toBeUndefined()
    reuse.put('/code/desktop-workbench', one)
    now += 30_000
    expect(reuse.get('/code/desktop-workbench')).toEqual({ brief: one, ageMs: 30_000 })
    now += BRIEF_REUSE_MS - 30_000 - 1
    expect(reuse.get('/code/desktop-workbench')?.ageMs).toBe(BRIEF_REUSE_MS - 1)
    now += 1
    expect(reuse.get('/code/desktop-workbench')).toBeUndefined()
    expect(BRIEF_REUSE_MS).toBe(60_000)
  })

  it('不同的键各记各的;再读一次就从那一刻重新算', () => {
    let now = 0
    const reuse = createBriefReuse(() => now)
    reuse.put('/code/a', fakeBrief('/code/a'))
    now = 50_000
    reuse.put('/code/b', fakeBrief('/code/b'))
    now = 61_000
    expect(reuse.get('/code/a')).toBeUndefined()
    expect(reuse.get('/code/b')?.brief.path).toBe('/code/b')
    reuse.put('/code/a', fakeBrief('/code/a'))
    now = 100_000
    expect(reuse.get('/code/a')?.ageMs).toBe(39_000)
  })

  it('比对键:~ 展开、多余的 / 去掉;相对路径、带 .. 的、不是字符串的都没有键', () => {
    expect(briefPathKey('~/Documents/GitHub/desktop-workbench/', '/Users/example')).toBe('/Users/example/Documents/GitHub/desktop-workbench')
    expect(briefPathKey('/Users/example//Documents/./GitHub/desktop-workbench', '/Users/example')).toBe('/Users/example/Documents/GitHub/desktop-workbench')
    expect(briefPathKey('Documents/GitHub/x', '/Users/example')).toBeUndefined()
    expect(briefPathKey('/Users/example/GitHub/a/../b', '/Users/example')).toBeUndefined()
    expect(briefPathKey(undefined, '/Users/example')).toBeUndefined()
    expect(briefPathKey('  ', '/Users/example')).toBeUndefined()
  })
})

// ———————————————————————— 出处:他那句是不是只是点头 ————————————————————————

const RECAP = '找到了,就是工作台。我读了说明和最近的交接。它是给不会写代码的个体用的事务官工作台,现在在修第五轮真机的引导和通话,是这个吗?'
const NEXT = '记下了。交接里下一步有三件:一是让电话引导能读仓库,二是看聚球还卡不卡,三是自验新版本。你想先做哪个?'
const NAMES = ['工作台', 'desktop-workbench']

describe('confirmsOnly:他那句只是点头、或在她念的里面挑一件', () => {
  it.each([
    ['对'],
    ['对。'],
    ['嗯嗯,对'],
    ['是的,没错'],
    ['没错,就是它'],
    ['对,是这个'],
    ['对,就是这个工作台'],
    ['是的,就是 desktop workbench'],
    ['差不多吧'],
    ['嗯,不用改'],
    ['可以'],
    ['OK'],
  ])('复述之后答「%s」→ 只是点头', (reply) => {
    expect(confirmsOnly({ asked: RECAP, reply }, NAMES)).toBe(true)
  })

  it.each([
    ['先做第一个'],
    ['第二个吧'],
    ['一'],
    ['先做二,再做一'],
    ['先做让电话引导能读仓库那个'],
    ['按你说的来'],
  ])('她念了下一步问先做哪个,答「%s」→ 在她念的里面挑', (reply) => {
    expect(confirmsOnly({ asked: NEXT, reply }, NAMES)).toBe(true)
  })

  it.each([
    ['不对'],
    ['不是这个'],
    ['不对,它是给做自媒体的人用的'],
    ['对,不过现在主要在修电话'],
    ['对,另外截止是十月底'],
    ['是这个,但是现在只有我自己在用'],
    ['现在还只有我一个人在用,还没给别人'],
  ])('复述之后答「%s」→ 他改了说法或补了话', (reply) => {
    expect(confirmsOnly({ asked: RECAP, reply }, NAMES)).toBe(false)
  })

  it('挑的是她没念过的一件(「先做登录页」)→ 那是他说的', () => {
    expect(confirmsOnly({ asked: NEXT, reply: '先做登录页' }, NAMES)).toBe(false)
  })

  it('他说了一大段(哪怕句句都是她说过的)→ 不是点个头', () => {
    expect(confirmsOnly({ asked: RECAP, reply: `对,${RECAP.slice(0, 60)}${RECAP.slice(0, 60)}` }, NAMES)).toBe(false)
  })

  it('没说话(空的一问一答)→ 没有他改过说法的凭据', () => {
    expect(confirmsOnly({ asked: '', reply: '' })).toBe(true)
  })
})

// ———————————————————————— 出处:阶段机 ————————————————————————

const WORKBENCH = '/srv/code/desktop-workbench'
const DAY = '2026-09-24'
const BRIEF_ORIGIN = `读仓库说明,Ben确认,${DAY}`
const SAID_ORIGIN = `引导访谈,Ben口述,${DAY}`

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

async function fixture(mode: 'existing' | 'fresh' = 'existing') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-brief-origin-')))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@e.com')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const clock = { ms: Date.parse(`${DAY}T05:00:00Z`) }
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile: join(root, 'AGENTS.md'),
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date(clock.ms),
  })
  await service.load()
  for (const [stage, key, value] of [['opening', 'nickname', 'Ben'], ['branch', 'mode', mode], ['template', 'template', 'product']] as const) {
    expect((await service.answer({ stage, key, value })).ok).toBe(true)
  }
  expect(service.detail().stage).toBe('projects')
  const read = (name: string): string => readFileSync(join(repo, 'docs', '记忆', '项目', `${name}.md`), 'utf8')
  return { service, clock, read }
}

type Service = Awaited<ReturnType<typeof fixture>>['service']

async function record(service: Service, value: Record<string, unknown>, heard?: { asked: string, reply: string }) {
  const got = await service.answer({ stage: 'projects', key: 'project', value, ...(heard === undefined ? {} : { heard }) })
  expect(got.ok).toBe(true)
}

const CONFIRMED = { name: '工作台', one_liner: '给不会写代码的个体用的事务官工作台', status: '在修第五轮真机的引导和通话', next_step: '让电话引导能读仓库', path: WORKBENCH }

describe('出处写对:读了仓库、他点头之后记的那几句', () => {
  it('读过 → 他答「对」→ 一句话 / 进展 / 下一步 / 建档 标「读仓库说明,Ben确认」;他答的截止日照旧「口述」', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await record(fx.service, { ...CONFIRMED, deadline: '2026-10-31' }, { asked: RECAP, reply: '对' })
    const file = fx.read('工作台')
    expect(file).toContain(`- **一句话**:给不会写代码的个体用的事务官工作台(${BRIEF_ORIGIN})`)
    expect(file).toContain(`- ${DAY}:在修第五轮真机的引导和通话(${BRIEF_ORIGIN})`)
    expect(file).toMatch(new RegExp(`## 下一步\\n- 让电话引导能读仓库\\(${BRIEF_ORIGIN}\\)`))
    expect(file).toContain(`- ${DAY}:建档(${BRIEF_ORIGIN})`)
    expect(file).toContain(`- **截止日**:2026-10-31(${SAID_ORIGIN})`)
    expect(file).toContain('- **路径**:`/srv/code/desktop-workbench`')
  })

  it('没读过(他不让看,全靠问)→ 仍是「引导访谈,Ben口述」,一字不改', async () => {
    const fx = await fixture()
    await record(fx.service, CONFIRMED, { asked: RECAP, reply: '对' })
    const file = fx.read('工作台')
    expect(file).toContain(`- **一句话**:给不会写代码的个体用的事务官工作台(${SAID_ORIGIN})`)
    expect(file).toContain(`- ${DAY}:建档(${SAID_ORIGIN})`)
    expect(file).not.toContain('读仓库说明')
  })

  it('读的是另一个目录 → 这一个不算读过', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.('/srv/code/Aiboo')
    await record(fx.service, CONFIRMED, { asked: RECAP, reply: '对' })
    expect(fx.read('工作台')).not.toContain('读仓库说明')
  })

  it('读过,但他确认时改了说法 → 那一条仍按「他说」记', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await record(fx.service, { ...CONFIRMED, one_liner: '维护者自己在用的事务官工作台,还没对外' }, { asked: RECAP, reply: '不对,现在还只有我自己在用' })
    const file = fx.read('工作台')
    expect(file).toContain(`- **一句话**:维护者自己在用的事务官工作台,还没对外(${SAID_ORIGIN})`)
    expect(file).not.toContain('读仓库说明')
  })

  it('读过,先记一句话(带 path),后面只补下一步(不带 path)、他在她念的里面挑了一件 → 也标读仓库说明', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(`${WORKBENCH}/`)
    await record(fx.service, { name: '工作台', one_liner: CONFIRMED.one_liner, path: WORKBENCH }, { asked: RECAP, reply: '对,就是它' })
    await record(fx.service, { name: '工作台', next_step: '让电话引导能读仓库' }, { asked: NEXT, reply: '先做第一个' })
    const file = fx.read('工作台')
    expect(file).toContain(`- **一句话**:${CONFIRMED.one_liner}(${BRIEF_ORIGIN})`)
    expect(file).toMatch(new RegExp(`## 下一步\\n- 让电话引导能读仓库\\(${BRIEF_ORIGIN}\\)`))
  })

  it('读过,他挑的是她没念过的一件 → 下一步按「他说」', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await record(fx.service, { name: '工作台', one_liner: CONFIRMED.one_liner, path: WORKBENCH }, { asked: RECAP, reply: '对' })
    await record(fx.service, { name: '工作台', next_step: '先把登录页做了' }, { asked: NEXT, reply: '先做登录页' })
    const file = fx.read('工作台')
    expect(file).toContain(`(${BRIEF_ORIGIN})`)
    expect(file).toMatch(new RegExp(`## 下一步\\n- 先把登录页做了\\(${SAID_ORIGIN}\\)`))
  })

  it('更正(他说「不是这个意思」)→ 按「他说」', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await record(fx.service, CONFIRMED, { asked: RECAP, reply: '对' })
    const fixed = await fx.service.correct({ stage: 'projects', key: 'project', value: { name: '工作台', one_liner: '给做自媒体的人用的内容工作台', path: WORKBENCH } })
    expect(fixed.ok).toBe(true)
    expect(fx.read('工作台')).toContain(`- **一句话**:给做自媒体的人用的内容工作台(${SAID_ORIGIN})`)
  })

  it('拿不到他那句话(老调用方没带)→ 只看读没读过', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await record(fx.service, CONFIRMED)
    expect(fx.read('工作台')).toContain(`- **一句话**:${CONFIRMED.one_liner}(${BRIEF_ORIGIN})`)
  })

  it('读过超过 30 分钟才记 → 不算「这一次读过」', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    fx.clock.ms += SURFACED_TTL_MS + 1
    await record(fx.service, CONFIRMED, { asked: RECAP, reply: '对' })
    expect(fx.read('工作台')).not.toContain('读仓库说明')
  })

  it('重来整个引导 → 上一次读过的不算', async () => {
    const fx = await fixture()
    fx.service.noteBriefRead?.(WORKBENCH)
    await fx.service.restart('all')
    for (const [stage, key, value] of [['opening', 'nickname', 'Ben'], ['branch', 'mode', 'existing'], ['template', 'template', 'product']] as const) {
      expect((await fx.service.answer({ stage, key, value })).ok).toBe(true)
    }
    await record(fx.service, CONFIRMED, { asked: RECAP, reply: '对' })
    expect(fx.read('工作台')).not.toContain('读仓库说明')
  })

  it('新点子那一支:一字不改(「引导 B 线点子访谈,Ben口述」)', async () => {
    const fx = await fixture('fresh')
    fx.service.noteBriefRead?.(WORKBENCH)
    const got = await fx.service.answer({
      stage: 'projects',
      key: 'idea',
      value: { name: '吃药提醒', one_liner: '帮爸妈按时吃药的小程序', problem: '爸妈老忘吃药', assets: '只有想法', first_step: '先问问爸妈怎么记的', stage: '市场调研' },
      heard: { asked: '先用一句话说说它是什么?', reply: '对' },
    })
    expect(got.ok).toBe(true)
    const file = fx.read('吃药提醒')
    expect(file).toContain(`- **一句话**:帮爸妈按时吃药的小程序(引导 B 线点子访谈,Ben口述,${DAY})`)
    expect(file).not.toContain('读仓库说明')
  })
})
