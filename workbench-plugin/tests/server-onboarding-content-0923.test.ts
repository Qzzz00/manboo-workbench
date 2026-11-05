// @vitest-environment node
/**
 * 2026-09-23 统筹从零重装自跑引导发现的几条「说错话」(F / K / L / M / H 的话术那一半,I 的问法),
 * 以及对话凭据门的纯函数(onboardingConsent.ts)。HTTP 那一半在 server-onboarding-consent-http.test.ts。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { guardAnswer, lastExchange, unansweredAsked } from '../src/server/onboardingConsent.ts'
import { FULL_PLAN, OPENING_LINE, SYSTEM_AUTH_WHY, firstMessage, stageDef } from '../src/server/onboardingStages.ts'
import { cleanTurnText } from '../src/server/onboardingTurns.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function service(): Promise<{ svc: OnboardingService, adopted: { name: string, path: string }[] }> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-0923-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  const agentsFile = join(root, 'AGENTS.md')
  writeFileSync(agentsFile, '# 事务官\n')
  const adopted: { name: string, path: string }[] = []
  let tick = 0
  const svc = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'), repoRoot: repo, agentsFile,
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++)),
    projects: { adopt: async (input) => { adopted.push(input); return { id: 'desktop-workbench' } } },
  })
  await svc.load()
  return { svc, adopted }
}

async function ok(svc: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await svc.answer({ stage, key, value })
  if (!result.ok) throw new Error(`${stage}.${key}:${result.error}`)
  return result
}

describe('L / M → 2026-09-24 晚:收尾不念复述、永不念文件路径(维护者「结束环节的大总结听得我好累」)', () => {
  it('复述清单只给她心里有数:不再带「收尾那两句」,也没有任何 docs/记忆/ 路径;收尾那一段写明不念', async () => {
    const { svc } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    await ok(svc, 'template', 'template', 'product')
    await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官' })
    await ok(svc, 'projects', 'done', true)
    for (const key of ['write_docs', 'write_commit', 'write_api']) await ok(svc, 'authorization', key, true)
    await ok(svc, 'authorization', 'read_client_files', false)
    await ok(svc, 'habits', 'done', true)
    await ok(svc, 'persona', 'persona', '沉稳')
    await ok(svc, 'persona', 'candor', 5)
    await ok(svc, 'persona', 'verbosity', 4)
    const wrap = await ok(svc, 'naming', 'butler_name', '小管家')
    expect(wrap.stage).toBe('wrapup')
    const recap = wrap.recap ?? ''
    expect(recap).toContain('- 称呼:Ben')
    expect(recap).not.toContain('收尾那两句')
    expect(recap).not.toContain('以后我先开口')
    expect(recap).not.toContain('docs/记忆')
    const goals = stageDef('wrapup', 'existing').goals.join('\n')
    expect(goals).toContain('永不念文件路径')
    expect(goals).toContain('不复述')
    expect(stageDef('wrapup', 'existing').seed).not.toContain('复述')
  })
})

describe('M 回合表不再把路径删成一串顿号', () => {
  it('行内反引号里是路径 / 文件名:留字去反引号;是命令 / JSON:照旧删', () => {
    expect(cleanTurnText('都记好了。落下来的几份在 `用户-Ben.md`、`项目/工作台.md`、`授权.md`,都已提交。'))
      .toBe('都记好了。落下来的几份在 用户-Ben.md、项目/工作台.md、授权.md,都已提交。')
    expect(cleanTurnText('我记一下:`curl -s -X POST http://127.0.0.1:8791/onboarding/answer`,然后接着聊。')).toBe('我记一下,然后接着聊。')
    expect(cleanTurnText('我记一下:`{"stage":"opening"}`,好。')).toBe('我记一下,好。')
  })
})

describe('F 坏会话另开:不向他讲内部断线', () => {
  it('quietResume:不问「上次到哪」、不提断线;开场阶段只问称呼那一句,不重念开场白', () => {
    const message = firstMessage({ stage: 'opening', mode: undefined, baseUrl: 'http://x', answered: {}, resumed: true, quietResume: true })
    expect(message).not.toContain('上次到哪,接着吗')
    expect(message).toContain('不要提会话、断线、重连、出错')
    expect(message).toContain('你希望我怎么称呼你?')
    expect(message).not.toContain(OPENING_LINE)
  })
  it('普通续接(2026-09-24 起)也不问「上次到哪」:不寒暄进度,只问还没答的那一题', () => {
    const message = firstMessage({ stage: 'branch', mode: undefined, baseUrl: 'http://x', answered: { opening: ['nickname'] }, resumed: true, nickname: 'Ben' })
    expect(message).not.toContain('上次到哪')
    expect(message).not.toContain('接着吗')
    expect(message).toContain('开口不寒暄进度')
    expect(message).toContain('只问还没答的那一题')
    expect(message).toContain('「Ben」')
  })
})

describe('K / H / I 的话术落在第一条消息与阶段清单里', () => {
  it('每一段都带「一题一答、答非所问追问一次、还不行按默认并明说」', () => {
    for (const stage of ['opening', 'branch', 'habits', 'persona'] as const) {
      const message = firstMessage({ stage, mode: 'existing', baseUrl: 'http://x', answered: {}, resumed: false })
      expect(message).toContain('上一题的「对」「好」不算这一题的答案')
      expect(message).toContain('**追问一次**')
      expect(message).toContain('还不答就按默认记,并明说')
    }
  })
  it('② 分岔:这一问必须问出口', () => {
    expect(stageDef('branch', undefined).goals.join('\n')).toContain('这一问必须问出口')
  })
  it('②′ 已有项目:先问后看 —— 先问「为了找到它、读读它的说明……可以吗?」,等他说可以才记、才找;不许事后补一句', () => {
    const goals = stageDef('projects', 'existing').goals.join('\n')
    expect(goals).toContain('**先问后看**')
    // 2026-09-24(维护者拍板):「只看名字」那句作废 —— 找它、读它一起问,问一句就够。
    expect(goals).toContain('为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?')
    expect(goals).not.toContain('只看名字')
    expect(goals).toContain('**等他说可以**,再把 read_scan_roots 记成 true')
    expect(goals).toContain('不许事后补一句「顺手记成可以了」')
    expect(stageDef('projects', 'existing').keys.project?.desc).toContain('path(')
  })
  it('③ 授权:系统授权(辅助功能)那一步在清单里 —— 为什么要、怎么触发、不替他点', () => {
    const goals = stageDef('authorization', 'existing').goals.join('\n')
    expect(goals).toContain(SYSTEM_AUTH_WHY)
    expect(goals).toContain('POST /onboarding/system-auth')
    expect(goals).toContain('你替他点不了那个开关')
  })
})

describe('onboardingConsent 纯函数', () => {
  it('lastExchange:他最后连着说的几句 + 那之前她说的最后一句;工作台替她说的 error 不算', () => {
    expect(lastExchange([])).toBeUndefined()
    expect(lastExchange([{ role: 'assistant', text: '问?' }])).toBeUndefined()
    expect(lastExchange([
      { role: 'assistant', text: '你先用哪个?' },
      { role: 'assistant', text: '我这边模型没接上', kind: 'error' },
      { role: 'user', text: '嗯' },
      { role: 'user', text: '做产品研发' },
    ])).toEqual({ asked: '你先用哪个?', reply: '嗯\n做产品研发' })
  })
  it('I:read_scan_roots 没问出口不收;问了他拒绝不收「可以」但收 false;问了他点头收', () => {
    const base = { stage: 'projects', key: 'read_scan_roots', required: false }
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '那个在做着的项目,叫什么名字?', reply: '工作台这个项目' } }).ok).toBe(false)
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '我看一眼你放代码的目录,可以吗?', reply: '不行' } }).ok).toBe(false)
    expect(guardAnswer({ ...base, value: false, exchange: { asked: '我看一眼你放代码的目录,可以吗?', reply: '不行' } }).ok).toBe(true)
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '为了找到它,我得看一眼你放代码的那个目录,只看名字,可以吗?', reply: '可以' } }).ok).toBe(true)
    // 2026-09-24 新问句照样过门;他改口之后她只问「读」的那一句也算问到了(409 要是 0)。
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?', reply: '可以' } }).ok).toBe(true)
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '好,那我读一下它的说明和最近的记录,可以吗?', reply: '行,你去看吧' } }).ok).toBe(true)
    // 光他说「你去看吧」、她没问出口:不收。
    expect(guardAnswer({ ...base, value: true, exchange: { asked: '好的,那我们接着聊这个项目。', reply: '你去看吧' } }).ok).toBe(false)
    // 「不用问我」是嫌问得多,不是拒绝;「不用,你直接问我」才是拒绝。
    const asked = '为了找到它、读读它的说明和最近的记录,我得看一眼你放代码的目录,只读不改,可以吗?'
    expect(guardAnswer({ ...base, value: true, exchange: { asked, reply: '可以,你去看吧,不用问我了' } }).ok).toBe(true)
    expect(guardAnswer({ ...base, value: true, exchange: { asked, reply: '行,以后不用每次都问' } }).ok).toBe(true)
    expect(guardAnswer({ ...base, value: true, exchange: { asked, reply: '不用,你直接问我吧' } }).ok).toBe(false)
    expect(guardAnswer({ ...base, value: true, exchange: { asked, reply: '别看了' } }).ok).toBe(false)
    // 拿不到凭据的调用方不在这里拦(见交接)。
    expect(guardAnswer({ ...base, value: true, exchange: undefined }).ok).toBe(true)
  })
  it('H:必答项要有这一题的字眼(问句或他的回答里);确认上一题的「对」不算', () => {
    const base = { stage: 'branch', key: 'mode', value: 'existing', required: true }
    expect(guardAnswer({ ...base, exchange: { asked: '那我先给你摆成产品研发那一套,对吗?', reply: '对' } }).ok).toBe(false)
    expect(guardAnswer({ ...base, exchange: { asked: '你现在是已经有在做的事,还是想从一个新点子开始?', reply: '对' } }).ok).toBe(true)
    expect(guardAnswer({ ...base, exchange: { asked: '说说看?', reply: '已经有在做的' } }).ok).toBe(true)
    // 真机那一段里的话量:问句里没有字眼,他自己说了「主动提醒」—— 收。
    expect(guardAnswer({ stage: 'persona', key: 'verbosity', value: 4, required: true, exchange: { asked: '我先记 2——平时不找你,真有事才开口。行吗?', reply: '4 吧,主动提醒' } }).ok).toBe(true)
  })
  it('K:问出口的 channel 没答上 → 要追问;没问过就不管', () => {
    expect(unansweredAsked({ stage: 'habits', answeredKeys: ['rhythm'], askedTexts: ['那我是开口说,还是发文字给你?'] }))
      .toEqual({ key: 'channel', fallback: '文字为主(默认,他没明说)' })
    expect(unansweredAsked({ stage: 'habits', answeredKeys: ['channel'], askedTexts: ['那我是开口说,还是发文字给你?'] })).toBeUndefined()
    expect(unansweredAsked({ stage: 'habits', answeredKeys: [], askedTexts: ['几点开工?'] })).toBeUndefined()
  })
})

describe('D/N 引导录的项目带 path → 项目区认领同一行', () => {
  it('project.path 只收绝对路径或 ~/;带了就交给项目区 adopt', async () => {
    const { svc, adopted } = await service()
    await ok(svc, 'opening', 'nickname', 'Ben')
    await ok(svc, 'branch', 'mode', 'existing')
    await ok(svc, 'template', 'template', 'product')
    const bad = await svc.answer({ stage: 'projects', key: 'project', value: { name: '工作台', path: 'GitHub/desktop-workbench' } })
    expect(bad.ok).toBe(false)
    await ok(svc, 'projects', 'project', { name: '工作台', one_liner: '桌面事务官', path: '~/Documents/GitHub/desktop-workbench/' })
    expect(adopted).toEqual([{ name: '工作台', path: '~/Documents/GitHub/desktop-workbench' }])
  })
})
