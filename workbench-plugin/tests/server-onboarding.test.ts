// @vitest-environment node
/**
 * 引导流程的阶段机(docs/设计-引导流程.md v2)。
 *
 * 守住的东西:开场白一字不改;阶段只能顺着走、不能跳;answer 的 key 白名单;中断之后能续;
 * 授权表写入;AGENTS.md 只改标记段;当场答即拍板(项目文件直接写,不进待拍板);
 * onboarding.json 每步落盘;每阶段一次 commit。
 *
 * 全部在临时目录里跑:临时 git 仓库当 docs/记忆 的家,临时 AGENTS.md 当 ~/.dsh/AGENTS.md 的替身。
 * **不碰 ~/.dsh 真身**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService, parseAuthMarkdown } from '../src/server/authorization.ts'
import { applyAgentsFile, readMarkedBlock, upsertMarkedBlock } from '../src/server/memoryMd.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, OPENING_LINE, firstMessage } from '../src/server/onboardingStages.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 生产 ~/.dsh/AGENTS.md 的样子(照抄一份进测试,不读真身)。 */
const AGENTS_ORIGINAL = `# 事务官(用户全局指令)

你是 Ben 的专属事务官(桌面工作台的 AI 管家),服务一个人:Ben,产品经理,不写代码,用桌面 App 跑多个 Agent。

纪律(写死):
- 只读优先;对任何仓库不 git clean、不删文件、不装东西、不碰 ~/.dsh。
- 不编数:拿不到就说拿不到,拿不准就写「拿不准」。
`

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

interface Fixture {
  root: string
  repo: string
  agentsFile: string
  stateFile: string
  service: OnboardingService
  tasksFile: string
  reopen: () => Promise<OnboardingService>
  commits: () => string[]
  read: (relative: string) => string
}

async function fixture(options: { withTasks?: boolean, clock?: () => Date } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  writeFileSync(join(repo, 'docs', '记忆', '项目', '索引.md'), '# 项目索引\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n| Aiboo | 旧的一句话 | MVP 开发 | 闲置 | /x | [项目/Aiboo.md](项目/Aiboo.md) |\n')
  writeFileSync(join(repo, 'docs', '记忆', '项目', 'Aiboo.md'), [
    '# Aiboo', '', '> 项目记忆文件。', '',
    '- **一句话**:Aiboo 本体:掌机/展示台/宠物/ROM 抽取等,独立演进',
    '- **阶段**:MVP 开发(可选:市场调研 / 项目策划 / 需求梳理 / MVP 开发 / 上线 / 维护)',
    '- **路径**:`/Users/example/Documents/GitHub/Aiboo`',
    '- **目标**:待梳理',
    '- **截止日**:无', '',
    '## 进展(倒序,一条一日期)', '- 2026-09-10:建档(统筹会话按项目区扫描生成)', '',
    '## 当前冲刺 / 任务', '- 待梳理', '',
    '## 下一步', '- 待梳理', '',
    '## 关键文件与入口', '- README.md', '',
    '## 风险', '- 待梳理', '',
    '## 历史决定(指向决策记录)', '- 无', '',
  ].join('\n'))
  writeFileSync(join(repo, 'docs', '记忆', '用户-Ben.md'), '# 用户:Ben\n\n> 两段。\n\n## 自述(Ben 写)\n- (待 Ben 补)\n\n## 观察(事务官/统筹会话追加,倒序)\n- 2026-09-11 · 旧观察一条\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')

  const agentsFile = join(root, 'dsh', 'AGENTS.md')
  mkdirSync(join(root, 'dsh'), { recursive: true })
  writeFileSync(agentsFile, AGENTS_ORIGINAL)
  const stateFile = join(root, 'workbench', 'onboarding.json')
  const tasksFile = join(root, 'workbench', 'tasks.json')

  let tick = 0
  const clock = options.clock ?? (() => new Date(Date.UTC(2026, 8, 15, 1, 0, tick++)))
  const build = async (): Promise<OnboardingService> => {
    const authorization = createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') })
    const tasks = options.withTasks === true ? createTasksService({ file: tasksFile, newId: () => 't-first' }) : undefined
    const service = createOnboardingService({
    plan: FULL_PLAN,
      file: stateFile,
      repoRoot: repo,
      agentsFile,
      authorization,
      ...(tasks === undefined ? {} : { tasks }),
      now: clock,
    })
    await service.load()
    return service
  }
  return {
    root, repo, agentsFile, stateFile, tasksFile,
    service: await build(),
    reopen: build,
    commits: () => git(repo, 'log', '--format=%s').trim().split('\n'),
    read: relative => readFileSync(join(repo, relative), 'utf8'),
  }
}

async function ok(service: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await service.answer({ stage, key, value })
  if (!result.ok) throw new Error(`answer ${stage}.${key} 失败:${result.error}`)
  return result
}

/** 走完 B 线(从零)的全部阶段;返回每一步之后的阶段,便于断言。 */
async function walkFresh(service: OnboardingService, nickname = '阿本'): Promise<string[]> {
  const trail: string[] = []
  const step = async (stage: string, key: string, value: unknown) => {
    trail.push((await ok(service, stage, key, value)).stage)
  }
  await step('opening', 'nickname', nickname)
  // 2026-09-21:①′ 布局(做产品 / 自媒体运营)。这一批用例都走 product ——
  // 走 product 的引导问法与加这一步之前逐字相同,所以下面的断言一条没改。
  await step('branch', 'mode', 'fresh')
  await step('template', 'template', 'product')
  await step('projects', 'idea', {
    name: '晨读机', one_liner: '给小学生的每日晨读播放器', problem: '家长早上没空陪读,孩子读不下去',
    assets: '一个点子、两段样音、一位做硬件的朋友', first_step: '先访谈 5 位家长', stage: '市场调研',
  })
  await step('authorization', 'write_docs', 'ask')
  await step('authorization', 'write_commit', true)
  await step('authorization', 'write_api', false)
  // 2026-09-22(C5):授权表多一项「读各家客户端文件」,同样是必答的三档。
  await step('authorization', 'read_client_files', 'ask')
  await step('habits', 'rhythm', '上午一段下午一段,晚饭后不看')
  await step('habits', 'music', '周杰伦、City Pop;工作时不听有词的')
  await step('habits', 'done', true)
  await step('persona', 'persona', '傲娇')
  await step('persona', 'candor', 4)
  await step('persona', 'verbosity', 2)
  await step('naming', 'butler_name', '小满')
  await step('wrapup', 'morning_report', true)
  await step('wrapup', 'evening_routine', '18:30')
  await step('wrapup', 'unsure', ['晨读机的硬件成本还不知道'])
  await step('wrapup', 'first_item', '先把 5 位家长的访谈提纲列出来')
  return trail
}

describe('开场白', () => {
  it('与设计文档 docs/设计-引导流程.md 里 Ben 亲笔那一行一字不差', () => {
    const doc = readFileSync(new URL('../../docs/设计-引导流程.md', import.meta.url), 'utf8')
    const line = doc.split('\n').find(item => item.startsWith('> 你好,很高兴认识你'))
    expect(line).toBeDefined()
    expect((line as string).slice(2)).toBe(OPENING_LINE)
  })

  it('第一条消息把开场白原样带上,并注明一字不改', () => {
    const message = firstMessage({ stage: 'opening', mode: undefined, baseUrl: 'http://127.0.0.1:8791', answered: {}, resumed: false })
    expect(message).toContain(`「${OPENING_LINE}」`)
    expect(message).toContain('一字不改')
    expect(message).toContain('POST http://127.0.0.1:8791/onboarding/answer')
    expect(message).toContain('nickname *')
  })
})

describe('阶段推进(B 线从零走到收尾)', () => {
  it('必答项答完自动推进;每一步 onboarding.json 都落盘;最后 done', async () => {
    const fx = await fixture({ withTasks: true })
    const trail = await walkFresh(fx.service)
    expect(trail).toEqual([
      // 2026-09-23:称呼答完落在 ② 分岔,答完分岔才到 ①′ 布局,再到 ②′。
      'branch', 'template', 'projects', 'authorization',
      // 2026-09-22(C5):授权那一段现在有四项必答(多了「读各家客户端文件」)。
      'authorization', 'authorization', 'authorization', 'habits',
      'habits', 'habits', 'persona',
      'persona', 'persona', 'naming',
      'wrapup',
      'wrapup', 'wrapup', 'wrapup', 'done',
    ])
    const saved = JSON.parse(readFileSync(fx.stateFile, 'utf8')) as { stage: string, nickname: string, mode: string, answers: Record<string, Record<string, unknown>> }
    expect(saved.stage).toBe('done')
    expect(saved.nickname).toBe('阿本')
    expect(saved.mode).toBe('fresh')
    expect(saved.answers.wrapup?.evening_routine).toBe('18:30')
    expect(fx.service.view()).toMatchObject({ stage: 'done', done: true })
  })

  it('记忆文件内容正确:用户文件头部进度行 + 记录段,项目文件当场答即拍板,索引补了一行', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)

    const user = fx.read('docs/记忆/用户-阿本.md')
    expect(user.startsWith('# 用户:阿本\n')).toBe(true)
    expect(readMarkedBlock(user, '进度')).toContain('引导进度:已完成')
    const record = readMarkedBlock(user, '记录') ?? ''
    expect(record).toContain('- 称呼:阿本')
    expect(record).toContain('从零开始——晨读机')
    expect(record).toContain('音乐口味(供 AIDJ 建歌单):周杰伦、City Pop;工作时不听有词的')
    expect(record).toContain('人设:傲娇;直言度 4/5;话量 2/5')
    expect(record).toContain('包装可以俏皮,内容不能打折')
    expect(record).toContain('- 小满(随时可改)')
    expect(record).toContain('早上先汇报再干活:是')
    expect(record).toContain('下班例程:18:30')
    expect(record).toContain('第一条事项建议(只建议,没建事项)')
    expect(record).toContain('- 先把 5 位家长的访谈提纲列出来')
    expect(record).toContain('- 晨读机的硬件成本还不知道')
    // 旧文件 用户-Ben.md 一个字没动。
    expect(fx.read('docs/记忆/用户-Ben.md')).toContain('- 2026-09-11 · 旧观察一条')

    const project = fx.read('docs/记忆/项目/晨读机.md')
    expect(project).toContain('- **一句话**:给小学生的每日晨读播放器(引导 B 线点子访谈,阿本口述,2026-09-15)')
    expect(project).toContain('- **阶段**:市场调研(')
    expect(project).toContain('- **目标**:家长早上没空陪读,孩子读不下去(')
    expect(project).toContain('手上有:一个点子、两段样音、一位做硬件的朋友')
    expect(project).toContain('- 先访谈 5 位家长(')
    expect(project).not.toContain('待拍板')
    expect(fx.read('docs/记忆/项目/索引.md')).toContain('| 晨读机 | 给小学生的每日晨读播放器 | 市场调研 |')
    // 决策记录没被碰:当场答即拍板,不走待拍板。
    expect(existsSync(join(fx.repo, 'docs', '决策记录.md'))).toBe(false)
  })

  it('B2 立项建了第一个事项(方向 = 我交给事务官);没接看板就如实说', async () => {
    const withTasks = await fixture({ withTasks: true })
    await walkFresh(withTasks.service)
    const tasks = JSON.parse(readFileSync(withTasks.tasksFile, 'utf8')) as { tasks: { id: string, title: string, direction?: string, status: string }[] }
    expect(tasks.tasks).toHaveLength(1)
    expect(tasks.tasks[0]).toMatchObject({ id: 't-first', title: '先访谈 5 位家长', direction: 'mine', status: 'todo' })

    const without = await fixture()
    await ok(without.service, 'opening', 'nickname', '阿本')
    await ok(without.service, 'branch', 'mode', 'fresh')
    await ok(without.service, 'template', 'template', 'product')
    const result = await ok(without.service, 'projects', 'idea', {
      name: 'X', one_liner: 'a', problem: 'b', assets: 'c', first_step: 'd', stage: '项目策划',
    })
    expect(result.note).toBe('第一个事项没建:任务看板未接线')
  })

  it('每阶段一次 commit,收尾那一次叫「入职·收尾」', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const commits = fx.commits()
    expect(commits[0]).toBe('chore(记忆): 入职·收尾')
    // 2026-09-21:多了 ①′ 布局那一次。
    expect(commits.filter(item => item.startsWith('chore(记忆): 引导·'))).toHaveLength(8)
    expect(commits).toContain('chore(记忆): 引导·①′ 布局(做产品 / 自媒体运营)')
    expect(commits).toContain('chore(记忆): 引导·① 开场')
    expect(commits).toContain('chore(记忆): 引导·②′ 从零开始(B1 点子访谈 → B2 立项)')
    expect(commits).toContain('chore(记忆): 引导·④′ 对话预期')
    // 工作树干净:写过的都提交了。
    expect(git(fx.repo, 'status', '--porcelain').trim()).toBe('')
  })

  it('进 wrapup 时接口回代码算出来的复述清单,不编', async () => {
    const fx = await fixture({ withTasks: true })
    await ok(fx.service, 'opening', 'nickname', '阿本')
    await ok(fx.service, 'branch', 'mode', 'fresh')
    await ok(fx.service, 'template', 'template', 'product')
    await ok(fx.service, 'projects', 'idea', { name: '晨读机', one_liner: 'a', problem: 'b', assets: 'c', first_step: 'd', stage: '市场调研' })
    await ok(fx.service, 'authorization', 'write_docs', 'ask')
    await ok(fx.service, 'authorization', 'write_commit', false)
    await ok(fx.service, 'authorization', 'write_api', false)
    await ok(fx.service, 'authorization', 'read_client_files', 'ask')
    await ok(fx.service, 'habits', 'done', true)
    await ok(fx.service, 'persona', 'persona', '沉稳')
    await ok(fx.service, 'persona', 'candor', 5)
    await ok(fx.service, 'persona', 'verbosity', 1)
    const result = await ok(fx.service, 'naming', 'butler_name', '老周')
    expect(result.stage).toBe('wrapup')
    expect(result.recap).toContain('- 称呼:阿本')
    expect(result.recap).toContain('- 重心:从零开始——「晨读机」:a(阶段 市场调研)')
    expect(result.recap).toContain('写 docs 要问、commit 不可以、写接口 不可以')
    expect(result.recap).toContain('- 偏好:还没答')
    expect(result.recap).toContain('- 对话方式:沉稳,直言度 5/5,话量 1/5')
    expect(result.recap).toContain('- 名字:老周')
    expect(result.recap).toContain('- 拿不准:无')
  })
})

describe('非法跳转与 key 白名单', () => {
  it('答别的阶段的问题 → 409 并说清现在在哪', async () => {
    const fx = await fixture()
    const result = await fx.service.answer({ stage: 'persona', key: 'persona', value: '傲娇' })
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect((result as { error: string }).error).toContain('① 开场')
  })

  it('不在白名单里的 key → 400 并列出能写的', async () => {
    const fx = await fixture()
    const result = await fx.service.answer({ stage: 'opening', key: 'butler_name', value: 'x' })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect((result as { error: string }).error).toContain('nickname')
  })

  it('值不合法 → 400:mode 乱写、旋钮越界、时刻格式、人设不在三个里、项目名带路径', async () => {
    const fx = await fixture()
    await ok(fx.service, 'opening', 'nickname', '阿本')
    expect(await fx.service.answer({ stage: 'branch', key: 'mode', value: 'maybe' })).toMatchObject({ ok: false, status: 400 })
    await ok(fx.service, 'branch', 'mode', 'existing')
    await ok(fx.service, 'template', 'template', 'product')
    expect(await fx.service.answer({ stage: 'projects', key: 'project', value: { name: '../etc', one_liner: 'x' } })).toMatchObject({ ok: false, status: 400 })
    expect(await fx.service.answer({ stage: 'projects', key: 'project', value: { name: 'X' } })).toMatchObject({ ok: false, status: 400 })
    // 走到人设阶段再试旋钮与人设。
    await ok(fx.service, 'projects', 'done', true)
    await ok(fx.service, 'authorization', 'write_docs', true)
    await ok(fx.service, 'authorization', 'write_commit', true)
    await ok(fx.service, 'authorization', 'write_api', true)
    await ok(fx.service, 'authorization', 'read_client_files', true)
    await ok(fx.service, 'habits', 'done', true)
    expect(await fx.service.answer({ stage: 'persona', key: 'persona', value: '高冷' })).toMatchObject({ ok: false, status: 400 })
    expect(await fx.service.answer({ stage: 'persona', key: 'candor', value: 6 })).toMatchObject({ ok: false, status: 400 })
    expect(await fx.service.answer({ stage: 'persona', key: 'candor', value: '4' })).toMatchObject({ ok: false, status: 400 })
    await ok(fx.service, 'persona', 'persona', '周到')
    await ok(fx.service, 'persona', 'candor', 3)
    await ok(fx.service, 'persona', 'verbosity', 4)
    await ok(fx.service, 'naming', 'butler_name', '阿周')
    expect(await fx.service.answer({ stage: 'wrapup', key: 'evening_routine', value: '6点半' })).toMatchObject({ ok: false, status: 400 })
    expect(await fx.service.answer({ stage: 'wrapup', key: 'evening_routine', value: '25:00' })).toMatchObject({ ok: false, status: 400 })
  })

  it('做完之后不再收答案 → 409 指向 restart', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const result = await fx.service.answer({ stage: 'wrapup', key: 'first_item', value: 'x' })
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect((result as { error: string }).error).toContain('restart')
  })

  it('称呼带路径分隔符 → 400,不建奇怪的文件', async () => {
    const fx = await fixture()
    const result = await fx.service.answer({ stage: 'opening', key: 'nickname', value: '../x' })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(existsSync(join(fx.repo, 'docs', 'x.md'))).toBe(false)
  })
})

describe('中断续做', () => {
  it('进程死掉再起:阶段、已答项从 onboarding.json 回来;开会话第一句直接问还没答的那一题(2026-09-24 起不问「上次到哪」)', async () => {
    const fx = await fixture()
    await ok(fx.service, 'opening', 'nickname', '阿本')
    await ok(fx.service, 'branch', 'mode', 'existing')
    await ok(fx.service, 'template', 'template', 'product')
    await ok(fx.service, 'projects', 'read_scan_roots', true)

    const again = await fx.reopen()
    expect(again.view().stage).toBe('projects')
    const detail = again.detail()
    expect(detail.nickname).toBe('阿本')
    expect(detail.mode).toBe('existing')
    expect(detail.answered).toEqual({ opening: ['nickname'], template: ['template'], branch: ['mode'], projects: ['read_scan_roots'] })

    const opened = await again.openSession({ open: async () => 'sess-9' }, 'http://127.0.0.1:8791')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.session_id).toBe('sess-9')
    expect(opened.first_message).not.toContain('上次到哪')
    expect(opened.first_message).toContain('只问还没答的那一题')
    expect(opened.first_message).toContain('②′ 项目')
    expect(opened.first_message).toContain('read_scan_roots')
    expect(opened.first_message).not.toContain(OPENING_LINE)
    // 接着答,能走下去。
    expect((await ok(again, 'projects', 'done', true)).stage).toBe('authorization')
  })

  it('开过会话后再开(2026-09-16 真机:开场白念了三遍)= 接着:不再发种子句;有 say 就排进原会话不另开,原会话没了才另开', async () => {
    const fx = await fixture()
    const sent: string[] = []
    const said: [string, string][] = []
    const opener = { open: async (m: string) => { sent.push(m); return `sess-${sent.length}` }, say: async (id: string, m: string) => { said.push([id, m]); return id === 'sess-1' } }
    const first = await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    expect(first.ok && first.session_id).toBe('sess-1')
    expect(first.ok && first.resumed).toBe(false)
    expect(first.ok && first.first_message).toContain(`「${OPENING_LINE}」`)
    // 称呼还没答,用户从主页「接着引导」又点进来:同一条会话接着聊,不再念开场白。
    // (她先答完了开场那一轮 —— 还没答时再来开只交会话不再说,见 server-onboarding-r5-0924。)
    await fx.service.noteTurnEnd('sess-1', { ok: true })
    const again = await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    expect(again.ok && again.session_id).toBe('sess-1')
    expect(again.ok && again.resumed).toBe(true)
    expect(again.ok && again.seed).toBe(OPENING_LINE)
    expect(sent).toHaveLength(1)
    expect(said).toHaveLength(1)
    expect(said[0]![1]).not.toContain('上次到哪')
    expect(said[0]![1]).toContain('你希望我怎么称呼你?')
    expect(said[0]![1]).toContain('[引导 · ① 开场]')
    expect(said[0]![1]).toContain('nickname')
    expect(said[0]![1]).not.toContain(OPENING_LINE)
    // 原会话在 DSH 里没了(say 回 false):另开一条,第一条消息同样不带种子句。
    ;(opener as { say: (id: string, m: string) => Promise<boolean> }).say = async () => false
    await fx.service.noteTurnEnd('sess-1', { ok: true })
    const third = await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    expect(third.ok && third.session_id).toBe('sess-2')
    expect(sent).toHaveLength(2)
    expect(sent[1]).not.toContain('上次到哪')
    expect(sent[1]).not.toContain(OPENING_LINE)
    // 没有 say 的通道(老接线):直接另开。
    const fourth = await fx.service.openSession({ open: async (m: string) => { sent.push(m); return `sess-${sent.length}` } }, 'http://127.0.0.1:8791')
    expect(fourth.ok && fourth.session_id).toBe('sess-3')
  })

  it('旧会话上一轮以错误结束(2026-09-23 模型没接上时开的会话)→ 续接不往里 say,另开一条「接着上次」;重启后仍记得', async () => {
    const fx = await fixture()
    const sent: string[] = []
    const said: [string, string][] = []
    const opener = { open: async (m: string) => { sent.push(m); return `sess-${sent.length}` }, say: async (id: string, m: string) => { said.push([id, m]); return true } }
    const first = await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    expect(first.ok && first.session_id).toBe('sess-1')
    expect(fx.service.sessionBroken()).toBe(false)
    // 别的会话的错误不算。
    await fx.service.noteTurnEnd('sess-other', { ok: false, code: 'MISSING_CREDENTIAL' })
    expect(fx.service.sessionBroken()).toBe(false)
    await fx.service.noteTurnEnd('sess-1', { ok: false, code: 'MISSING_CREDENTIAL' })
    expect(fx.service.sessionBroken()).toBe(true)
    // DSH / 插件重启:回合表是空的,但坏过这件事落了盘。
    const again = await fx.reopen()
    expect(again.sessionBroken()).toBe(true)
    const second = await again.openSession(opener, 'http://127.0.0.1:8791')
    expect(second.ok && second.session_id).toBe('sess-2')
    expect(second.ok && second.resumed).toBe(true)
    expect(said).toHaveLength(0)
    // F(2026-09-23):坏会话另开 —— 不问「上次到哪」、不提断线,直接接着问还没答的那一题。
    expect(sent[1]).not.toContain('上次到哪,接着吗')
    expect(sent[1]).toContain('不要提会话、断线、重连、出错')
    expect(sent[1]).toContain('你希望我怎么称呼你?')
    expect(sent[1]).not.toContain(OPENING_LINE)
    expect(again.sessionBroken()).toBe(false)
    expect(JSON.parse(readFileSync(fx.stateFile, 'utf8')).session_failed).toBeUndefined()
    // 新会话好好的:再续接就照旧往里 say。
    await again.noteTurnEnd('sess-2', { ok: true })
    const third = await again.openSession(opener, 'http://127.0.0.1:8791')
    expect(third.ok && third.session_id).toBe('sess-2')
    expect(said).toHaveLength(1)
  })

  it('坏过又好了(下一轮正常结束)→ 撤掉记录,续接照旧往原会话里说', async () => {
    const fx = await fixture()
    const said: string[] = []
    const opener = { open: async () => 'sess-1', say: async (id: string) => { said.push(id); return true } }
    await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    await fx.service.noteTurnEnd('sess-1', { ok: false })
    await fx.service.noteTurnEnd('sess-1', { ok: true })
    expect(fx.service.sessionBroken()).toBe(false)
    await fx.service.openSession(opener, 'http://127.0.0.1:8791')
    expect(said).toEqual(['sess-1'])
  })

  it('第一次开会话不算「接着」;askedAt 只在开过会话之后才有', async () => {
    const fx = await fixture()
    expect(fx.service.view()).toMatchObject({ stage: 'opening', done: false })
    expect(fx.service.view().askedAt).toBeUndefined()
    const opened = await fx.service.openSession({ open: async () => 'sess-1' }, 'http://127.0.0.1:8791')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.first_message).not.toContain('上次到哪')
    expect(fx.service.view().askedAt).toMatch(/^2026-09-15T01:00:0\d\.000Z$/)
  })

  it('开不出会话 → 如实回「会话未开」,第一条消息照样给(前台可以自己贴)', async () => {
    const fx = await fixture()
    const opened = await fx.service.openSession(undefined, 'http://127.0.0.1:8791')
    expect(opened).toMatchObject({ ok: true, stage: 'opening', note: '会话未开' })
    const thrown = await fx.service.openSession({ open: async () => { throw new Error('boom') } }, 'http://127.0.0.1:8791')
    expect(thrown).toMatchObject({ ok: true, note: '会话未开' })
  })
})

describe('A 线:授权线与访谈线', () => {
  it('read_* 逐项写进 授权.md;write_api 默认不可以;项目一句话 / 阶段 / 目标直接写(当场答即拍板),进展与拿不准追加', async () => {
    const fx = await fixture()
    await ok(fx.service, 'opening', 'nickname', 'Ben')
    await ok(fx.service, 'branch', 'mode', 'existing')
    await ok(fx.service, 'template', 'template', 'product')
    await ok(fx.service, 'projects', 'read_scan_roots', true)
    await ok(fx.service, 'projects', 'read_session_titles', false)

    const auth = parseAuthMarkdown(fx.read('docs/记忆/授权.md'))
    expect(auth.read_scan_roots).toEqual({ status: '可以', date: '2026-09-15' })
    expect(auth.read_session_titles).toEqual({ status: '不可以', date: '2026-09-15' })
    expect(auth.read_workbench_state).toEqual({ status: '未答' })
    expect(auth.write_api).toEqual({ status: '不可以' })
    expect(auth.write_docs).toEqual({ status: '要问' })
    expect(fx.read('docs/记忆/授权.md')).toContain('## 永远不动(不请求、不商量)')

    await ok(fx.service, 'projects', 'project', { name: 'Aiboo', one_liner: 'AI 陪伴的移动端角色平台', vision: '孩子愿意每天跟它说话', unsure: ['云端还要不要维护'] })
    await ok(fx.service, 'projects', 'project', { name: 'Aiboo', status: '客户端在做 UGC 表情包,展示台没动', next_step: '把版本号维护起来', deadline: '2026-10-01' })
    await ok(fx.service, 'projects', 'project', { name: 'KOUKOU', later: true })
    const project = fx.read('docs/记忆/项目/Aiboo.md')
    expect(project).toContain('- **一句话**:AI 陪伴的移动端角色平台(引导访谈,Ben口述,2026-09-15)')
    expect(project).toContain('- **目标**:孩子愿意每天跟它说话(')
    expect(project).toContain('- **截止日**:2026-10-01(')
    // 阶段没答就不动。
    expect(project).toContain('- **阶段**:MVP 开发(可选:')
    // 进展只追加,旧条目还在;下一步的占位「待梳理」换掉了。
    expect(project).toContain('- 2026-09-10:建档(统筹会话按项目区扫描生成)')
    // 进展是倒序:新条目在旧条目上面。
    expect(project).toMatch(/## 进展\(倒序,一条一日期\)\n- 2026-09-15:客户端在做 UGC 表情包,展示台没动\([^\n]*\n- 2026-09-10:建档/)
    expect(project).toMatch(/## 下一步\n- 把版本号维护起来\(/)
    expect(project).toContain('- 拿不准:云端还要不要维护(')
    expect(project).not.toContain('待拍板')
    // 「稍后」的项目不建文件,但进度行记着。
    expect(existsSync(join(fx.repo, 'docs', '记忆', '项目', 'KOUKOU.md'))).toBe(false)
    expect(fx.read('docs/记忆/用户-Ben.md')).toContain('稍后再聊:KOUKOU')
    // 用户-Ben.md 原有内容没丢。
    expect(fx.read('docs/记忆/用户-Ben.md')).toContain('- 2026-09-11 · 旧观察一条')

    const result = await ok(fx.service, 'projects', 'done', true)
    expect(result.stage).toBe('authorization')
    expect(result.commit).toMatchObject({ ok: true, message: 'chore(记忆): 引导·②′ 项目(A 授权线∥访谈线 / B 从零)' })
  })

  it('新项目文件从模板建,并在索引里补一行', async () => {
    const fx = await fixture()
    await ok(fx.service, 'opening', 'nickname', 'Ben')
    await ok(fx.service, 'branch', 'mode', 'existing')
    await ok(fx.service, 'template', 'template', 'product')
    await ok(fx.service, 'projects', 'project', { name: 'Echo', one_liner: '回声', stage: '需求梳理' })
    const file = fx.read('docs/记忆/项目/Echo.md')
    expect(file.startsWith('# Echo\n')).toBe(true)
    expect(file).toContain('- **一句话**:回声(')
    expect(file).toContain('- **阶段**:需求梳理(')
    expect(file).toContain('## 风险')
    expect(fx.read('docs/记忆/项目/索引.md')).toContain('| Echo | 回声 | 需求梳理 | 引导建档 2026-09-15 |')
  })
})

describe('人设与取名 → ~/.dsh/AGENTS.md 只改标记段', () => {
  it('说话方式一节用标记包起来,首行「我叫 X」,其余原文一字不动;重复写不叠加', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const agents = readFileSync(fx.agentsFile, 'utf8')
    expect(agents.startsWith('我叫 小满。\n\n# 事务官(用户全局指令)\n')).toBe(true)
    expect(agents).toContain(AGENTS_ORIGINAL)
    const block = readMarkedBlock(agents, '说话方式') ?? ''
    expect(block).toContain('## 说话方式')
    expect(block).toContain('人设:**傲娇**——嘴硬心软')
    expect(block).toContain('直言度 4/5')
    expect(block).toContain('话量 2/5')
    expect(block).toContain('自称「小满」')
    expect(block).toContain('包装可以俏皮,内容不能打折')
    expect(block).toContain('出错 / 赶不上(不耍宝,先说事):「Y 赶不上周五了,差两天。我不绕弯子:今天砍范围,还是往后挪?你定。」')
    expect(agents.split('<!-- 引导:说话方式:开始 -->')).toHaveLength(2)
    expect(agents.split('<!-- 引导:说话方式:结束 -->')).toHaveLength(2)
    // 标记段之外 = 首行 + 原文,别的什么都没有。
    const outside = agents.replace(/<!-- 引导:说话方式:开始 -->[\s\S]*<!-- 引导:说话方式:结束 -->\n?/, '')
    expect(outside).toBe(`我叫 小满。\n\n${AGENTS_ORIGINAL}\n`)
  })

  it('applyAgentsFile 纯函数:第二次写替换而不追加;没有标题的文件也能处理', () => {
    const once = applyAgentsFile(AGENTS_ORIGINAL, { butlerName: '甲', styleSection: '## 说话方式\n- 版本一' })
    const twice = applyAgentsFile(once, { butlerName: '乙', styleSection: '## 说话方式\n- 版本二' })
    expect(twice.startsWith('我叫 乙。\n')).toBe(true)
    expect(twice).toContain('- 版本二')
    expect(twice).not.toContain('- 版本一')
    expect(twice).not.toContain('我叫 甲')
    expect(twice.split('<!-- 引导:说话方式:开始 -->')).toHaveLength(2)
    expect(applyAgentsFile('', { styleSection: '## 说话方式\n- x' })).toBe('<!-- 引导:说话方式:开始 -->\n## 说话方式\n- x\n<!-- 引导:说话方式:结束 -->\n')
  })

  it('upsertMarkedBlock:标题后插入 / 文末插入 / 原地替换', () => {
    const base = '# 标题\n\n正文\n'
    const inserted = upsertMarkedBlock(base, '进度', '> 进度 1', 'afterTitle')
    expect(inserted).toBe('# 标题\n\n<!-- 引导:进度:开始 -->\n> 进度 1\n<!-- 引导:进度:结束 -->\n\n正文\n')
    const replaced = upsertMarkedBlock(inserted, '进度', '> 进度 2', 'afterTitle')
    expect(replaced).toBe('# 标题\n\n<!-- 引导:进度:开始 -->\n> 进度 2\n<!-- 引导:进度:结束 -->\n\n正文\n')
    const atEnd = upsertMarkedBlock(replaced, '记录', '## 记录\n- a', 'end')
    expect(atEnd.endsWith('正文\n\n<!-- 引导:记录:开始 -->\n## 记录\n- a\n<!-- 引导:记录:结束 -->\n')).toBe(true)
  })
})

describe('重新引导与新项目补问', () => {
  it('restart persona:只走人设那一段,答完直接 done,AGENTS.md 换了人设、名字不变', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const restarted = await fx.service.restart('persona')
    expect(restarted).toEqual({ ok: true, stage: 'persona' })
    expect(fx.service.detail().plan).toEqual(['persona', 'done'])
    expect(fx.service.detail().answered.persona).toBeUndefined()
    expect(fx.service.detail().answered.naming).toEqual(['butler_name'])
    await ok(fx.service, 'persona', 'persona', '沉稳')
    await ok(fx.service, 'persona', 'candor', 5)
    const result = await ok(fx.service, 'persona', 'verbosity', 1)
    expect(result).toMatchObject({ stage: 'done', done: true, advanced: true })
    const agents = readFileSync(fx.agentsFile, 'utf8')
    expect(agents.startsWith('我叫 小满。')).toBe(true)
    expect(readMarkedBlock(agents, '说话方式')).toContain('人设:**沉稳**')
    expect(readMarkedBlock(agents, '说话方式')).not.toContain('傲娇')
  })

  it('restart authorization:只重问写权限;restart all:从头来,称呼也重问', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    expect(await fx.service.restart('authorization')).toEqual({ ok: true, stage: 'authorization' })
    await ok(fx.service, 'authorization', 'write_docs', true)
    await ok(fx.service, 'authorization', 'write_commit', true)
    await ok(fx.service, 'authorization', 'write_api', true)
    const result = await ok(fx.service, 'authorization', 'read_client_files', true)
    expect(result.stage).toBe('done')
    expect(parseAuthMarkdown(fx.read('docs/记忆/授权.md')).write_api.status).toBe('可以')

    expect(await fx.service.restart('all')).toEqual({ ok: true, stage: 'opening' })
    const detail = fx.service.detail()
    expect(detail.nickname).toBeUndefined()
    expect(detail.answered).toEqual({})
    expect(detail.plan[0]).toBe('opening')
  })

  it('引导做完后扫描发现新仓库:只补问那一个项目,不重来;引导没做完时不排队', async () => {
    const fx = await fixture({ withTasks: true })
    // 没做完:不排队。
    expect(await fx.service.noticeProjects(['新仓库'])).toEqual([])
    await walkFresh(fx.service)
    // 2026-09-23:做完后第一次自动发现只立基线 —— 那些是他本来就有的,「没挑的一个都不记」。
    expect(await fx.service.noticeProjects(['旧仓库甲', '旧仓库乙'])).toEqual([])
    expect(fx.service.detail().supplement).toEqual([])
    // 已有文件的(晨读机、Aiboo)不算新;基线里的不算新;没文件的算。
    expect(await fx.service.noticeProjects(['晨读机', 'Aiboo', '旧仓库甲', '新仓库', '../坏名字'])).toEqual(['新仓库'])
    expect(await fx.service.noticeProjects(['新仓库'])).toEqual([])
    expect(fx.service.detail().supplement).toEqual(['新仓库'])
    expect(fx.service.view()).toMatchObject({ stage: 'done', done: true })

    const opened = await fx.service.openSession({ open: async () => 's-2' }, 'http://127.0.0.1:8791')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.stage).toBe('projects')
    expect(opened.first_message).toContain('只补问这一个')
    expect(opened.first_message).toContain('新仓库')
    expect(fx.service.detail().plan).toEqual(['projects', 'done'])
    await ok(fx.service, 'projects', 'project', { name: '新仓库', one_liner: '刚发现的' })
    const result = await ok(fx.service, 'projects', 'done', true)
    expect(result.stage).toBe('done')
    expect(fx.service.detail().supplement).toEqual([])
    expect(fx.read('docs/记忆/项目/新仓库.md')).toContain('- **一句话**:刚发现的(')
  })

  it('2026-09-23:他亲口说「再加一个 XX」(explicit)不看基线 —— 基线里的旧仓库也照样排进补问', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    expect(await fx.service.noticeProjects(['旧仓库甲', '旧仓库乙'])).toEqual([])
    expect(await fx.service.noticeProjects(['旧仓库甲'])).toEqual([])
    expect(await fx.service.noticeProjects(['旧仓库甲'], { explicit: true })).toEqual(['旧仓库甲'])
    expect(fx.service.detail().supplement).toEqual(['旧仓库甲'])
    // 基线落盘:重启之后旧仓库仍不算新。
    const again = await fx.reopen()
    expect(await again.noticeProjects(['旧仓库乙'])).toEqual([])
  })

  it('做完且没有新项目时再开会话 → 409 指向 restart', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const opened = await fx.service.openSession({ open: async () => 's' }, 'http://127.0.0.1:8791')
    expect(opened).toMatchObject({ ok: false, status: 409 })
  })
})

describe('commit 失败不挡推进', () => {
  it('git 不可用时照样推进,结果里如实带 error,文件留着下次再提', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-nogit-'))
    dirs.push(root)
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'docs', '记忆'), { recursive: true })
    const service = createOnboardingService({
    plan: FULL_PLAN,
      file: join(root, 'onboarding.json'),
      repoRoot: repo,
      agentsFile: join(root, 'AGENTS.md'),
      authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
      git: async () => { throw new Error('fatal: not a git repository') },
      // 2026-09-30 止血第 5 条起,调 git 之前多了一道门(没 `.git` / 没装开发者工具就不调)。
      // 这一条钉的是**门过了、git 自己失败**那一种:门单独有自己的用例(server-git-no-dev-tools)。
      gitReady: async () => ({ ok: true }),
    })
    await service.load()
    const result = await ok(service, 'opening', 'nickname', '阿本')
    expect(result.stage).toBe('branch')
    expect(result.commit).toMatchObject({ ok: false, error: 'fatal: not a git repository' })
    expect(existsSync(join(repo, 'docs', '记忆', '用户-阿本.md'))).toBe(true)
  })
})

/**
 * 2026-09-25(卡 feat/first-look-orb-top):走完的那一刻 + 引导建的事项标上「是引导写下的」。
 * 电脑首页认 done_at 在「刚走完」那一次切回事务官档;固化提议认 origin 不把引导的出处说明当成他的话。
 */
describe('走完的那一刻与引导建的事项(2026-09-25)', () => {
  it('走到 done:view 带 done_at;引导建的事项 origin=onboarding;重来之后 done_at 没了', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const view = fx.service.view()
    expect(view).toMatchObject({ stage: 'done', done: true })
    expect(typeof view.done_at).toBe('string')
    const saved = JSON.parse(readFileSync(fx.tasksFile, 'utf8')) as { tasks: { origin?: string, direction?: string }[] }
    const mine = saved.tasks.filter(task => task.direction === 'mine')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(task => task.origin === 'onboarding')).toBe(true)
    // 通话纪要那一句的原料:走完了、答过哪几段。
    expect(fx.service.summaryInput?.()).toMatchObject({ done: true, stage: 'done' })
    await fx.service.restart('all')
    expect(fx.service.view().done_at).toBeUndefined()
  })
})

describe('老存档的「走完那一刻」(2026-09-25)', () => {
  it('走完了却没有 done_at 的老存档:读进来那一下拿 updatedAt 盖上;之后别的写盘改了 updatedAt,done_at 不跟着变', async () => {
    const fx = await fixture({ withTasks: true })
    await walkFresh(fx.service)
    const raw = JSON.parse(readFileSync(fx.stateFile, 'utf8')) as Record<string, unknown>
    delete raw.done_at
    raw.updatedAt = '2026-09-24T10:51:50.678Z'
    writeFileSync(fx.stateFile, JSON.stringify(raw))
    const legacy = await fx.reopen()
    expect(legacy.view().done_at).toBe('2026-09-24T10:51:50.678Z')
    // 走完之后又写了一次盘(换主导方):updatedAt 变了,done_at 不变,而且跟着这次写盘落了地。
    expect(await legacy.setLeader('desktop')).toMatchObject({ ok: true })
    expect(legacy.view().done_at).toBe('2026-09-24T10:51:50.678Z')
    const saved = JSON.parse(readFileSync(fx.stateFile, 'utf8')) as { done_at?: string, updatedAt: string }
    expect(saved.done_at).toBe('2026-09-24T10:51:50.678Z')
    expect(saved.updatedAt).not.toBe('2026-09-24T10:51:50.678Z')
    expect((await fx.reopen()).view().done_at).toBe('2026-09-24T10:51:50.678Z')
  })
})
