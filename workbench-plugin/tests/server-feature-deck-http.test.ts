// @vitest-environment node
/**
 * 需求指挥台那五条路由(2026-09-22,审视第四节第三幕):
 *
 *   /feature/docs      四个页签一次读回来
 *   /feature/doc/save  写回一份产物(存上一版、回段落级 diff)
 *   /feature/review    把关三键 + 一行 `审核记录.jsonl`
 *   /feature/run       「让事务官推进这一步」——**走 `/butler/item/say` 同一个端口**
 *   /feature/record    把结论追加进**她项目里**的 docs/决策记录.md
 *
 * 这一份钉的性质:
 *
 * 1. 推进走的是**同一个口**(注进来的 `butlerSession.say` 收到了那段话),而且带了上下文;
 * 2. 产物真的落在项目仓库的 `docs/需求/<名>/` 里,改了写得回去;
 * 3. 把关**有留痕**,而且**送不出去的那一次照样留痕**;
 * 4. 窗口编排壳没接上时标「代做」并在话里明说 —— 不让按钮变灰、也不假装派出去了;
 * 5. 决策记录只写**临时目录里那个假项目**,一个字节都不碰本仓库的 docs/决策记录.md。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { DECISION_RECORD_REL } from '../src/protocol.ts'
import { FEATURE_DIR_REL, FEATURE_DOC_FILES } from '../src/server/featureRun.ts'
import { REVIEW_LOG_NAME } from '../src/server/deckRun.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-22T09:00:00Z') / 1000)
const NEED = '加一个导出 PDF'
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 注进去的假会话端口:记下「说进去了什么」,并且可以装成"这条会话已经没了"。 */
function fakeButler(over: { say?: boolean } = {}) {
  const said: { session: string, text: string }[] = []
  return {
    said,
    port: {
      open: async () => 'sess-1',
      say: async (session: string, text: string) => { said.push({ session, text }); return over.say ?? true },
    },
  }
}

function fakeProjects(path: string | undefined): ProjectsService {
  const state: ProjectsState = {
    projects: [{
      id: 'p-1',
      name: '工作台',
      stage: 'dev' as never,
      ...(path === undefined ? {} : { path }),
      links: [],
      session_count: 0,
      idle: true,
    }],
    pending: [],
    scan_errors: [],
    scanned_at: '',
  }
  return { getProjectsState: async () => state, getLayout: async () => undefined } as unknown as ProjectsService
}

async function serve(opts: {
  say?: boolean
  hands?: boolean
  withSession?: boolean
  withProject?: boolean
  /** 这个项目在本机**没有路径**(扫不到本地仓库那一种)。 */
  noRepoPath?: boolean
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feature-http-'))
  dirs.push(dir)
  // 「她的项目仓库」:整份用例只往这里面写。
  const repo = join(dir, '她的项目')
  mkdirSync(repo, { recursive: true })
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const butler = fakeButler(opts.say === undefined ? {} : { say: opts.say })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    projects: fakeProjects(opts.noRepoPath === true ? undefined : repo),
    butlerSession: butler.port,
    // 窗口编排壳:接上 = 派得出去。**不试送**,与选题那边"不试发"同一条分寸。
    ...(opts.hands === false
      ? {}
      : { clientDispatch: { send: async () => ({ ok: true as const }) } as never }),
  })
  started.push(server)

  const created = await post(server.url, '/task/create', {
    title: NEED,
    kind: 'feature',
    ...(opts.withProject === false ? {} : { project_id: 'p-1' }),
  })
  const id = String(created.body.id)
  if (opts.withSession !== false) {
    await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  }
  return { url: server.url, repo, tasks, butler, id, featureDir: join(repo, FEATURE_DIR_REL, NEED) }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').split('\n').filter(one => one.trim() !== '')
    .map(one => JSON.parse(one) as Record<string, unknown>)
}

describe('/feature/docs', () => {
  it('★ 四个页签一个不落;没有的那几份 exists=false,**不给一段空正文**', async () => {
    const { url, id, featureDir } = await serve()
    mkdirSync(featureDir, { recursive: true })
    writeFileSync(join(featureDir, FEATURE_DOC_FILES.需求), '# 目标\n\n能导出 PDF', 'utf8')
    const res = await post(url, '/feature/docs', { id })
    expect(res.status).toBe(200)
    const docs = res.body.docs as { tab: string, exists: boolean, text?: string }[]
    expect(docs.map(one => one.tab)).toEqual(['需求', '子事项', '验收', '记录'])
    expect(docs[0]?.exists).toBe(true)
    expect(docs[1]?.exists).toBe(false)
    expect(docs[1]?.text).toBeUndefined()
    expect(res.body.stage).toBe('梳理')
    expect(res.body.project).toBe('工作台')
  })

  it('这张卡不是需求 → 409,**如实说为什么**', async () => {
    const { url } = await serve()
    const plain = await post(url, '/task/create', { title: '随手一条' })
    const res = await post(url, '/feature/docs', { id: String(plain.body.id) })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('不是需求')
  })

  it('★ 没挂项目 → 409,不猜一个仓库往里写', async () => {
    const { url, id } = await serve({ withProject: false })
    const res = await post(url, '/feature/docs', { id })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('还没归到项目')
  })

  it('项目在本机没有路径 → 409,同样不猜', async () => {
    const { url, id } = await serve({ noRepoPath: true })
    const res = await post(url, '/feature/docs', { id })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('没有路径')
  })

  it('没有这个事项 → 404', async () => {
    const { url } = await serve()
    expect((await post(url, '/feature/docs', { id: '没有这条' })).status).toBe(404)
  })
})

describe('/feature/doc/save', () => {
  it('★ 真写到项目仓库的 docs/需求/<名>/ 里', async () => {
    const { url, id, featureDir } = await serve()
    const res = await post(url, '/feature/doc/save', { id, tab: '子事项', text: '一、导出按钮\n\n二、渲染 PDF' })
    expect(res.status).toBe(200)
    expect(readFileSync(join(featureDir, FEATURE_DOC_FILES.子事项), 'utf8')).toContain('渲染 PDF')
    // 第一次不给 diff(整篇标成"新增"是噪音)。
    expect(res.body.diff).toBeUndefined()
  })

  it('再存一次:上一版进 `修订/`,并回这一轮的段落级 diff', async () => {
    const { url, id, featureDir } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '子事项', text: '一、导出按钮\n\n二、渲染 PDF' })
    const res = await post(url, '/feature/doc/save', { id, tab: '子事项', text: '一、导出按钮\n\n二、渲染 PDF(pdfkit)' })
    const diff = res.body.diff as { kind: string }[]
    expect(diff.some(row => row.kind === 'add')).toBe(true)
    expect(existsSync(join(featureDir, '修订'))).toBe(true)
  })

  it('认不出的页签 400,**把四个名字说出来**', async () => {
    const { url, id } = await serve()
    const res = await post(url, '/feature/doc/save', { id, tab: '复盘', text: 'x' })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('需求')
  })
})

describe('/feature/run:同一个口', () => {
  it('★ 那段话经 `butlerSession.say` 进了这条卡的会话(= /butler/item/say 那个端口)', async () => {
    const { url, id, butler } = await serve()
    const res = await post(url, '/feature/run', { id })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(true)
    expect(butler.said).toHaveLength(1)
    expect(butler.said[0]?.session).toBe('sess-1')
    expect(butler.said[0]?.text).toContain('不要重新问她一遍背景')
    expect(butler.said[0]?.text).toContain(NEED)
  })

  it('★ 带需求上下文:需求目录、项目仓库、已有产物、她说过的原话', async () => {
    const { url, id, butler, repo, featureDir } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '需求', text: '# 目标\n\n能导出 PDF' })
    await post(url, '/feature/review', { id, tab: '需求', action: 'revise', text: '边界没写' })
    butler.said.length = 0
    await post(url, '/feature/run', { id })
    const text = butler.said[0]?.text ?? ''
    expect(text).toContain(featureDir)
    expect(text).toContain(repo)
    expect(text).toContain(`${FEATURE_DOC_FILES.需求}:有了`)
    expect(text).toContain('边界没写')
  })

  it('交出去这一下也进 `审核记录.jsonl`(卡上的「排队」靠它算)', async () => {
    const { url, id, featureDir } = await serve()
    await post(url, '/feature/run', { id, note: '先只做单页' })
    const log = lines(join(featureDir, REVIEW_LOG_NAME))
    expect(log).toHaveLength(1)
    expect(log[0]?.action).toBe('run')
    expect(log[0]?.text).toBe('先只做单页')
    expect(log[0]?.stage).toBe('梳理')
  })

  it('★ 会话那头不在时**如实说没送进去**,不是一颗点了像是成了的按钮', async () => {
    const { url, id } = await serve({ withSession: false })
    const res = await post(url, '/feature/run', { id })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(false)
    expect(String(res.body.note)).toContain('还没有事务官的会话')
  })

  it('★ 窗口编排壳没接上 + 这一态要派活 → standin,并在话里明说代做', async () => {
    const { url, id, tasks, butler } = await serve({ hands: false })
    await tasks.update(id, { featureStage: '拆解与派活' })
    // 2026-09-23:没过确认点的话这一态一件都不许派,「代做」也就无从谈起 —— 先把那一下过掉。
    const points = (await post(url, '/feature/confirm', { id })).body.points
    await post(url, '/feature/confirm', { id, points })
    const res = await post(url, '/feature/run', { id })
    expect(res.body.standin).toBe(true)
    expect(butler.said[butler.said.length - 1]?.text).toContain('你自己顶着做')
    expect(butler.said[0]?.text).toContain('这一版是我代做的')
  })

  it('壳没接上、但这一态本来就不派活 → **不谈代做**', async () => {
    const { url, id } = await serve({ hands: false })
    const res = await post(url, '/feature/run', { id })
    expect(res.body.standin).toBe(false)
  })
})

describe('/feature/review:三键 + 留痕', () => {
  it('「通过」只留痕,不打扰事务官', async () => {
    const { url, id, featureDir, butler } = await serve()
    const res = await post(url, '/feature/review', { id, tab: '验收', action: 'pass' })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(false)
    expect(butler.said).toHaveLength(0)
    expect(lines(join(featureDir, REVIEW_LOG_NAME))[0]?.action).toBe('pass')
  })

  it('★「打回」必须带一句话,不带 400 —— 而且**一个字节都不送出去**', async () => {
    const { url, id, butler, featureDir } = await serve()
    const res = await post(url, '/feature/review', { id, tab: '验收', action: 'revise' })
    expect(res.status).toBe(400)
    expect(butler.said).toHaveLength(0)
    expect(existsSync(join(featureDir, REVIEW_LOG_NAME))).toBe(false)
  })

  it('「打回」带上那一句 → 留痕 + 原话送给事务官', async () => {
    const { url, id, butler, featureDir } = await serve()
    const res = await post(url, '/feature/review', { id, tab: '验收', action: 'revise', text: '第三件没验' })
    expect(res.body.sent).toBe(true)
    expect(butler.said[0]?.text).toContain('第三件没验')
    expect(lines(join(featureDir, REVIEW_LOG_NAME))[0]?.text).toBe('第三件没验')
  })

  it('★ 话送不出去的那一次**照样留痕**:她的判断不能因为通道掉线就丢', async () => {
    const { url, id, featureDir } = await serve({ say: false })
    const res = await post(url, '/feature/review', { id, tab: '验收', action: 'revise', text: '这条没测' })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(false)
    expect(String(res.body.note)).toContain('已经没了')
    expect(lines(join(featureDir, REVIEW_LOG_NAME))[0]?.text).toBe('这条没测')
  })

  it('认不出的 action 400', async () => {
    const { url, id } = await serve()
    expect((await post(url, '/feature/review', { id, tab: '验收', action: 'run' })).status).toBe(400)
  })
})

describe('/feature/record:决策记录', () => {
  const draft = [
    '- 需求:给报表加一个导出 PDF',
    '- 做了什么:加了导出按钮与 pdfkit 渲染',
    '- 谁做的:Codex 写代码,Claude 审了一遍',
    '- 遗留:中文字体还没内嵌',
  ].join('\n')

  it('★ 追加进**她项目**的 docs/决策记录.md(没有就建),并留一行痕', async () => {
    const { url, id, repo, featureDir } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '记录', text: draft })
    const res = await post(url, '/feature/record', { id })
    expect(res.status).toBe(200)
    expect(res.body.added).toBe(true)
    expect(res.body.path).toBe(join(repo, DECISION_RECORD_REL))
    const body = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(body).toContain(NEED)
    expect(body).toContain('pdfkit')
    const log = lines(join(featureDir, REVIEW_LOG_NAME))
    expect(log.at(-1)?.action).toBe('record')
  })

  it('★ 同一颗按钮点两下不出现两条', async () => {
    const { url, id, repo } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '记录', text: draft })
    await post(url, '/feature/record', { id })
    const again = await post(url, '/feature/record', { id })
    expect(again.body.added).toBe(false)
    const body = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    // 一条 = 一节。数「谁做的」那一行有几处就知道写进去了几条。
    expect(body.split('- 谁做的:')).toHaveLength(2)
  })

  it('★ 记录.md 还没有 → 409,**一个字都不代它写**', async () => {
    const { url, id, repo } = await serve()
    const res = await post(url, '/feature/record', { id })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('还没有内容')
    expect(existsSync(join(repo, DECISION_RECORD_REL))).toBe(false)
  })

  it('★ 四行缺了几行 → 409 并说出缺哪几行', async () => {
    const { url, id, repo } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '记录', text: '- 需求:只有这一行' })
    const res = await post(url, '/feature/record', { id })
    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('做了什么')
    expect(existsSync(join(repo, DECISION_RECORD_REL))).toBe(false)
  })

  it('路径可配:record_rel 换一个就落到那儿;不合法的一律 500 + 原话,不写', async () => {
    const { url, id, repo } = await serve()
    await post(url, '/feature/doc/save', { id, tab: '记录', text: draft })
    const ok = await post(url, '/feature/record', { id, record_rel: '笔记/决定.md' })
    expect(ok.status).toBe(200)
    expect(readFileSync(join(repo, '笔记/决定.md'), 'utf8')).toContain(NEED)

    const bad = await post(url, '/feature/record', { id, record_rel: '../外面.md' })
    expect(bad.status).toBe(500)
    expect(existsSync(join(repo, '..', '外面.md'))).toBe(false)
  })
})

describe('推进一步(走 /task/update 那一条,不另开路由)', () => {
  it('四态按顺序改得动;认不出的态 400 + 原话', async () => {
    const { url, id, tasks } = await serve()
    const ok = await post(url, '/task/update', { id, feature_stage: '拆解与派活' })
    expect(ok.status).toBe(200)
    expect((await tasks.list()).tasks.find(one => one.id === id)?.feature_stage).toBe('拆解与派活')
    const bad = await post(url, '/task/update', { id, feature_stage: '复盘' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('feature_stage')
  })
})
