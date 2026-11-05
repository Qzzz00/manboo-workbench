// @vitest-environment node
/**
 * 选题指挥台那四条路由(2026-09-22,卡 ②):
 *
 *   /topic/docs      七个页签一次读回来
 *   /topic/doc/save  写回一份产物(存上一版、回段落级 diff)
 *   /topic/review    把关三键 + 一行 `审核记录.jsonl`
 *   /topic/run       「让事务官推进这一步」——**走 `/butler/item/say` 同一个端口**
 *
 * 这一份钉的四件**性质**上的事:
 *
 * 1. 推进走的是**同一个口**(注进来的 `butlerSession.say` 收到了那段话),而且**带了上下文**;
 * 2. 产物真的落在 `选题/<名>/` 里那几个文件名上,改了写得回去;
 * 3. 把关**有留痕**,而且**送不出去的那一次照样留痕**(不能因为 DSH 掉线就丢掉她的判断);
 * 4. 服务器发不出 GPT / 豆包 时标「代做」,并在话里明说 —— 不让按钮变灰、也不假装派出去了。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchLayout } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { TOPIC_DIR } from '../src/templates.ts'
import { REVIEW_LOG_NAME } from '../src/server/topicRun.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-22T09:00:00Z') / 1000)
const TOPIC = '露营锅具怎么选'
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

function fakeModel(mode: 'relay' | 'own', ready = true) {
  return {
    endpoint: () => Promise.resolve({ mode, baseUrl: 'http://127.0.0.1:9/v1', key: 'wb_token_x', ready }),
  } as unknown as NonNullable<Parameters<typeof startWorkbenchServer>[0]['model']>
}

async function serve(opts: { say?: boolean, mode?: 'relay' | 'own', withSession?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-topic-deck-'))
  dirs.push(dir)
  const cwd = join(dir, '运营')
  mkdirSync(cwd, { recursive: true })
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  let layout: WorkbenchLayout | undefined = { modules: [], butler: { corner: 'br', min: false } }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
    templates: () => [OPS_TEMPLATE],
    butlerCwd: () => cwd,
  })
  await template.load()
  await template.apply('ops')
  const butler = fakeButler(opts.say === undefined ? {} : { say: opts.say })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    template,
    butlerSession: butler.port,
    model: fakeModel(opts.mode ?? 'relay'),
  })
  started.push(server)

  // 一条在办的选题(建卡顺手把 `选题/<名>/` 建出来)。
  const created = await post(server.url, '/task/create', { title: TOPIC, kind: 'topic', stage: '制作中' })
  const id = String(created.body.id)
  // 「让事务官推进」要有一条会话才说得进去 —— 与 `/butler/item/say` 同一道门槛。
  if (opts.withSession !== false) {
    await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-1' } })
  }
  return { url: server.url, cwd, tasks, butler, id, topicDir: join(cwd, TOPIC_DIR, TOPIC) }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('/topic/docs:七个页签一次读回来', () => {
  it('★ 七个一个不落;没有的那几份 exists=false,**不给一段空正文**(没有 ≠ 空)', async () => {
    const { url, topicDir } = await serve()
    writeFileSync(join(topicDir, '定稿.md'), '# 定稿\n\n第一段', 'utf8')
    const res = await post(url, '/topic/docs', { name: TOPIC })
    expect(res.status).toBe(200)
    const docs = res.body.docs as { tab: string, file: string, exists: boolean, text?: string }[]
    expect(docs.map(one => one.tab)).toEqual(['框架', '初稿', '定稿', '素材清单', '合规查词', '发布包装', '复盘'])
    const final = docs.find(one => one.tab === '定稿')
    expect(final?.file).toBe('定稿.md')
    expect(final?.text).toBe('# 定稿\n\n第一段')
    const draft = docs.find(one => one.tab === '初稿')
    expect(draft?.exists).toBe(false)
    expect(draft).not.toHaveProperty('text')
  })

  it('合规那一份读的是 查词.md(技能的固定产物,不是我们编的名字)', async () => {
    const { url, topicDir } = await serve()
    writeFileSync(join(topicDir, '查词.md'), '没有命中', 'utf8')
    const docs = (await post(url, '/topic/docs', { name: TOPIC })).body.docs as { tab: string, text?: string }[]
    expect(docs.find(one => one.tab === '合规查词')?.text).toBe('没有命中')
  })

  it('选题名拐弯(带 / 或以点开头)一律 400,不拼一条半截路径出来', async () => {
    const { url } = await serve()
    expect((await post(url, '/topic/docs', { name: '../跑出去' })).status).toBe(400)
    expect((await post(url, '/topic/docs', { name: '.偷偷的' })).status).toBe(400)
    expect((await post(url, '/topic/docs', { name: '  ' })).status).toBe(400)
  })
})

describe('/topic/doc/save:改了写回文件 + 这一轮改了什么', () => {
  it('★ 真写进盘上那个文件名(而不是另起一个界面自己的存法)', async () => {
    const { url, topicDir } = await serve()
    const res = await post(url, '/topic/doc/save', { name: TOPIC, tab: '定稿', text: '她自己改的那一版' })
    expect(res.status).toBe(200)
    expect(readFileSync(join(topicDir, '定稿.md'), 'utf8')).toBe('她自己改的那一版')
  })

  it('★ 第二次写回时给段落级 diff:改掉的那一段一删一增,没动的是 same', async () => {
    const { url } = await serve()
    await post(url, '/topic/doc/save', { name: TOPIC, tab: '定稿', text: '甲\n\n乙' })
    const again = await post(url, '/topic/doc/save', { name: TOPIC, tab: '定稿', text: '甲\n\n丙' })
    expect(again.body.diff).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'del', text: '乙' },
      { kind: 'add', text: '丙' },
    ])
  })

  it('新建的那一次没有 diff —— 把一份新稿子整个标成"新增"是噪音,不是信息', async () => {
    const { url } = await serve()
    const first = await post(url, '/topic/doc/save', { name: TOPIC, tab: '框架', text: '头一版' })
    expect(first.body).not.toHaveProperty('diff')
  })

  it('上一版存进了「修订」,下一次 /topic/docs 读出来时带着 diff', async () => {
    const { url } = await serve()
    await post(url, '/topic/doc/save', { name: TOPIC, tab: '定稿', text: '甲\n\n乙' })
    await post(url, '/topic/doc/save', { name: TOPIC, tab: '定稿', text: '甲\n\n丙' })
    const docs = (await post(url, '/topic/docs', { name: TOPIC })).body.docs as { tab: string, diff?: unknown[] }[]
    expect(docs.find(one => one.tab === '定稿')?.diff).toHaveLength(3)
  })

  it('页签名写错 400 + 把七个名字说出来(不悄悄归成缺省)', async () => {
    const { url } = await serve()
    const bad = await post(url, '/topic/doc/save', { name: TOPIC, tab: '草稿', text: 'x' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('合规查词')
  })
})

describe('/topic/review:把关三键 + 留痕', () => {
  it('★ 「通过」写一行 审核记录.jsonl:时间、哪份、动作', async () => {
    const { url, id, topicDir } = await serve()
    const res = await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: 'pass' })
    expect(res.status).toBe(200)
    const line = JSON.parse(readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8').trim()) as Record<string, unknown>
    expect(line.tab).toBe('定稿')
    expect(line.action).toBe('pass')
    expect(line.stage).toBe('制作中')
    expect(typeof line.at).toBe('string')
  })

  it('★ 「改一改」把她那一句**原样**送进同一个口(butlerSession.say),并且留痕里也有那句话', async () => {
    const { url, id, butler, topicDir } = await serve()
    const res = await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: 'revise', text: '开头太软了' })
    expect(res.body.sent).toBe(true)
    expect(butler.said).toHaveLength(1)
    expect(butler.said[0]?.session).toBe('sess-1')
    expect(butler.said[0]?.text).toContain('开头太软了')
    expect(butler.said[0]?.text).toContain('定稿.md')
    const line = JSON.parse(readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8').trim()) as Record<string, unknown>
    expect(line.text).toBe('开头太软了')
  })

  it('★ 「改一改」不带那一句 → 400,一个字节都不送出去', async () => {
    const { url, id, butler } = await serve()
    const res = await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: 'revise', text: '  ' })
    expect(res.status).toBe(400)
    expect(butler.said).toHaveLength(0)
  })

  it('★ 话送不出去的那一次**照样留痕**,并如实说没送进去(她的判断不能因为 DSH 掉线就丢)', async () => {
    const { url, id, topicDir } = await serve({ say: false })
    const res = await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: 'revise', text: '改这儿' })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(false)
    expect(String(res.body.note)).toContain('已经没了')
    expect(readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8')).toContain('改这儿')
  })

  it('「我自己改」只留痕,不打扰事务官', async () => {
    const { url, id, butler } = await serve()
    const res = await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: 'self' })
    expect(res.body.sent).toBe(false)
    expect(butler.said).toHaveLength(0)
  })

  it('三键之外的动作 400;不是选题的卡 409;没有这张卡 404', async () => {
    const { url, id } = await serve()
    expect((await post(url, '/topic/review', { id, name: TOPIC, tab: '定稿', action: '打回' })).status).toBe(400)
    expect((await post(url, '/topic/review', { id: '不存在', name: TOPIC, tab: '定稿', action: 'pass' })).status).toBe(404)
    const plain = await post(url, '/task/create', { title: '普通事项' })
    const res = await post(url, '/topic/review', { id: plain.body.id, name: TOPIC, tab: '定稿', action: 'pass' })
    expect(res.status).toBe(409)
  })
})

describe('/topic/run:「让事务官推进这一步」', () => {
  it('★ 走的是 `/butler/item/say` 同一个端口,送进的是这条事项自己那条会话', async () => {
    const { url, id, butler } = await serve()
    const res = await post(url, '/topic/run', { id, name: TOPIC })
    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(true)
    expect(butler.said).toHaveLength(1)
    expect(butler.said[0]?.session).toBe('sess-1')
  })

  it('★ 带上下文:段、技能、目录、已有产物、她把过的关 —— 她不必再交代一遍', async () => {
    const { url, id, butler, topicDir } = await serve()
    writeFileSync(join(topicDir, '框架.md'), '# 框架\n\n三段', 'utf8')
    await post(url, '/topic/review', { id, name: TOPIC, tab: '框架', action: 'revise', text: '第三段换个角度' })
    butler.said.length = 0

    await post(url, '/topic/run', { id, name: TOPIC, account: '露营小周' })
    const text = butler.said[0]?.text ?? ''
    expect(text).toContain('「制作中」')
    expect(text).toContain('《运营-初稿定稿》')
    expect(text).toContain(topicDir)
    expect(text).toContain('框架.md:有了')
    expect(text).toContain('「第三段换个角度」')
    expect(text).toContain('账号/露营小周/账号.md')
    expect(text).toContain('不要重新问她一遍背景')
  })

  it('★ 推进这件事也留一行痕(卡上的「排队 / 在做」靠它算)', async () => {
    const { url, id, topicDir } = await serve()
    await post(url, '/topic/run', { id, name: TOPIC })
    const lines = readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8').trim().split('\n')
    const one = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>
    expect(one.action).toBe('run')
    expect(one.stage).toBe('制作中')
    expect(one.tab).toBe('定稿')
  })

  it('★ 服务器发不出 GPT / 豆包 时标「代做」,话里明说让它自己顶 —— 不让按钮变灰', async () => {
    const { url, id, butler, topicDir } = await serve({ mode: 'own' })
    // 2026-09-23:没过确认点的话这一段一家都不许派,「代做」也就无从谈起 —— 先把那一下过掉。
    const points = (await post(url, '/topic/confirm', { id, name: TOPIC })).body.points
    await post(url, '/topic/confirm', { id, name: TOPIC, points })
    const res = await post(url, '/topic/run', { id, name: TOPIC })
    expect(res.body.standin).toBe(true)
    expect(butler.said[butler.said.length - 1]?.text).toContain('你自己顶着做')
    // 留痕里也记着这一次是代做 —— 重开工作台之后卡上那颗「代做」还在。
    const lines = readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1] as string).standin).toBe(true)
  })

  it('中转在、这一段又要派出去时不标代做', async () => {
    const { url, id } = await serve({ mode: 'relay' })
    expect((await post(url, '/topic/run', { id, name: TOPIC })).body.standin).toBe(false)
  })

  it('★ 会话还没开时如实说说不进去(不假装交出去了)', async () => {
    const { url, id } = await serve({ withSession: false })
    const res = await post(url, '/topic/run', { id, name: TOPIC })
    expect(res.body.sent).toBe(false)
    expect(String(res.body.note)).toContain('还没有事务官的会话')
  })

  it('她补的那一句原样带过去,并留在那一行痕里', async () => {
    const { url, id, butler, topicDir } = await serve()
    await post(url, '/topic/run', { id, name: TOPIC, note: '这次走情绪线' })
    expect(butler.said[0]?.text).toContain('「这次走情绪线」')
    expect(readFileSync(join(topicDir, REVIEW_LOG_NAME), 'utf8')).toContain('这次走情绪线')
  })
})
