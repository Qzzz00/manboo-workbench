// @vitest-environment node
/**
 * 技能一键接上(2026-09-22,卡 ①;`docs/设计-运营事务官指挥做事-2026-09-22.md` 第三节)。
 *
 * 由来:十份运营技能写好了、`POST /config/ops-skills/apply` 也在,但**界面上没有任何一颗
 * 按钮会去调它**,`/template/apply` 也不调 —— 于是切了运营模板的用户,事务官根本不知道
 * 有这几条技能。这一份钉的就是那条断掉的线:
 *
 * 1. **切模板自动写**:切到 `ops` 时十段运营技能进 `~/.dsh/AGENTS.md`;切回 `product` 自动摘掉;
 * 2. **幂等**:重复切不会变成二十段,内容没变时连 `.bak` 都不多留一个;
 * 3. **备份**:写之前先备份,备份里是改之前那一份;
 * 4. **状态接口**:`GET /config/ops-skills` 回得出"现在接上了几条、缺哪几条";
 * 5. **起服务补一次**:存量用户(切模板发生在这件功能之前)重启一次就补上。
 *
 * 全程在 `mkdtemp` 出来的**临时 HOME** 里跑 —— 一个字节都不会碰真实的 `~/.dsh`
 * (2026-09-04 家目录被删事故之后的纪律)。技能正文是**真读仓库里那十份文件**,
 * 不是夹具:清单与文件对不上时要当场红。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { DEFAULT_LANDSCAPE_MODULES } from '../src/client/layout.ts'
import type { WorkbenchLayout } from '../src/protocol.ts'
import { markers } from '../src/server/memoryMd.ts'
import { BASE_SKILLS, OPS_SKILLS, PRODUCT_SKILLS, opsSkillsAttachState } from '../src/server/opsSkills.ts'
import { resetStarterTemplateSource, startRealUserLayer } from './helpers/starterLayer.ts'

/** 本机仓库根(tests/ 的上两级)。技能正文真从这里读。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  // **只删自己 mkdtemp 出来的那几个**(2026-09-04 的纪律:删除先有清单、只在自己的目录里)。
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // 全局模板来源是模块级状态:装过真实起步层也要复位,不然串到并行用例。
  resetStarterTemplateSource()
})

interface Served {
  url: string
  /** 这台服务真听着的端口(`port: 0` → 系统分配的那个)。技能正文里的地址该是它。 */
  port: number
  home: string
  agentsFile: string
  /** 伪造来源地址用(测那道"只认回环"的门)。 */
  remote: { address: string }
  /** `~/.dsh` 里工作台留下的备份文件名(只数技能那一份所在的目录)。 */
  backups: () => string[]
  agents: () => string | undefined
}

async function serve(opts: { agents?: string, templateId?: string, noRepo?: boolean } = {}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ops-wire-'))
  dirs.push(dir)
  const home = join(dir, 'home')
  const agentsFile = join(home, '.dsh', 'AGENTS.md')

  /**
   * ops 模板从用户层来(2026-10-23,分层二刀二):与 src/index.ts 起服务同款 —— 真实
   * UserLayer 服务(起步层=仓库真文件)ensure→scan,模板 provider 与全局来源同一份快照。
   * 本体不再内置 ops 常量,这里也不在夹具里另造一份。
   */
  const userLayer = await startRealUserLayer(join(dir, '用户层'))

  let layout: WorkbenchLayout | undefined = {
    modules: [],
    butler: { corner: 'br', min: false },
    landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(one => ({ ...one })) },
  }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    templates: () => userLayer.layoutTemplates(),
  })
  await template.load()
  // 「存量用户」那一条要的前置:服务还没起来,模板就已经是运营了。
  if (opts.templateId !== undefined) {
    const result = await template.apply(opts.templateId)
    expect(result.ok).toBe(true)
  }
  if (opts.agents !== undefined) {
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(agentsFile, opts.agents)
  }

  const remote = { address: '127.0.0.1' }
  let tick = 0

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    template,
    remoteAddress: () => remote.address,
    paths: {
      config: createAppConfig({ file: join(dir, 'app.json') }),
      home,
      // 仓库根走**真实**的这一个:技能正文要真读得到。
      // noRepo:普通用户机器 —— 插件不在仓库里跑、也没配事务官仓库(2026-09-23)。
      moduleDir: opts.noRepo === true ? join(dir, 'plugin', 'lib') : `${REPO_ROOT}/workbench-plugin/src/server`,
      applyHooks: {
        files: { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') },
        // **每叫一次走一秒**:备份文件名里带的就是这个时刻,固定不动的话第二次备份会
        // 原地覆盖第一次(名字一模一样),"留了几份备份"那几条用例就永远只数得到一份。
        now: () => new Date(2026, 8, 22, 23, 30, tick++),
      },
    },
  })
  started.push(server)
  return {
    url: server.url,
    port: server.port,
    home,
    agentsFile,
    remote,
    backups: () => {
      try { return readdirSync(join(home, '.dsh')).filter(name => name.includes('bak-工作台')) }
      catch { return [] }
    },
    agents: () => {
      try { return readFileSync(agentsFile, 'utf8') }
      catch { return undefined }
    },
  }
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number, body: Record<string, any> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
}

async function getJson(url: string, path: string): Promise<{ status: number, body: Record<string, any> }> {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}

/** 等 AGENTS.md 里出现某一段(起服务那一下是 fire-and-forget,不等它整台服务就起来了)。 */
async function waitForBlock(read: () => string | undefined, name: string, ms = 4000): Promise<string> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = read()
    if (text !== undefined && text.includes(markers(name).open)) return text
    if (Date.now() > deadline) throw new Error(`等了 ${ms}ms,AGENTS.md 里还是没有「${name}」这一段`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * 技能**正文**落在哪(2026-10-02,卡「事务官为什么要跑这么多步」)。
 *
 * AGENTS.md 里从这一天起只留索引(H1 + 一句 summary + 正文在哪),正文落
 * `~/.dsh/workbench/技能/<段名>.md`。于是下面几条「正文里该有什么」的用例看的是**这几份文件**
 * —— 看 AGENTS.md 的那几条(标记段在不在、顺序、摘段、幂等、备份)一个字没改。
 */
function bodyText(home: string, name: string): string {
  return readFileSync(join(home, '.dsh', 'workbench', '技能', `${name}.md`), 'utf8')
}

/** 这台机器上落下来的所有技能正文,接成一摊(等于事务官按需读得到的全部)。 */
function allBodies(home: string, names: readonly string[]): string {
  return names.map(name => bodyText(home, name)).join('\n')
}

const ALL_OPS = OPS_SKILLS.map(one => one.name)
const ALL_BASE = BASE_SKILLS.map(one => one.name)
/** 2026-09-23:做产品模板下多一包(`做产品-改工作台自己`)。`ops` 那一档一个字没变。 */
const ALL_PRODUCT = PRODUCT_SKILLS.map(one => one.name)

describe('切模板 = 自动把技能接上', () => {
  it('★切到自媒体运营:十段运营技能 + 基础那几段都进了 AGENTS.md', async () => {
    const wb = await serve()
    const { status, body } = await post(wb.url, '/template/apply', { id: 'ops' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // 回包里如实带着这一次接技能的结果(切模板成不成与接技能成不成是两件事,都要说)。
    expect(body.ops_skills.ok).toBe(true)
    expect(body.ops_skills.written).toEqual([...ALL_BASE, ...ALL_OPS])
    expect(body.ops_skills.missing).toEqual([])

    const after = wb.agents() ?? ''
    for (const name of [...ALL_BASE, ...ALL_OPS]) {
      expect(after, `${name} 这一段没写进去`).toContain(markers(name).open)
    }
  })

  it('★总纲排在运营那一包最前面,而且定调那几句真进了正文(第〇节)', async () => {
    const wb = await serve()
    await post(wb.url, '/template/apply', { id: 'ops' })
    const after = wb.agents() ?? ''
    // 顺序:总纲的开始标记在其余每一条运营技能之前。
    const head = after.indexOf(markers('运营-总纲').open)
    expect(head).toBeGreaterThanOrEqual(0)
    for (const name of ALL_OPS.filter(one => one !== '运营-总纲')) {
      expect(after.indexOf(markers(name).open), `${name} 排到总纲前面去了`).toBeGreaterThan(head)
    }
    // 定调的四条:总管、先问再做、留位置给她填、每次把关都是学习。
    // 2026-10-02 起正文落盘,所以这四句看的是落下来那一份(AGENTS.md 里只剩索引)。
    const body = bodyText(wb.home, '运营-总纲')
    expect(body).toContain('总管')
    expect(body).toContain('先问再做')
    expect(body).toContain('这里你来填')
    expect(body).toContain('每一次把关都是一次学习')
    // 文件开头那段"这是怎么进 AGENTS.md 的"说明要被摘掉(它是给改技能的人看的)。
    expect(body).not.toContain('工作台会在**自媒体运营模板**下把它整段写进')
    // 索引那一段里有这一条是干什么的 + 正文在哪,但没有正文。
    expect(after).toContain(join(wb.home, '.dsh', 'workbench', '技能', '运营-总纲.md'))
    expect(after).not.toContain('每一次把关都是一次学习')
  })

  it('★切回做产品:运营那十段自动摘掉,基础那几段与他自己的内容一个字不动', async () => {
    const wb = await serve({ agents: '我叫小助。\n' })
    await post(wb.url, '/template/apply', { id: 'ops' })
    const { body } = await post(wb.url, '/template/apply', { id: 'product' })
    expect(body.ok).toBe(true)
    expect(body.ops_skills.removed).toEqual(ALL_OPS)
    expect(body.ops_skills.written).toEqual([...ALL_BASE, ...ALL_PRODUCT])

    const after = wb.agents() ?? ''
    for (const name of ALL_OPS) expect(after, `${name} 没摘干净`).not.toContain(markers(name).open)
    for (const name of ALL_BASE) expect(after).toContain(markers(name).open)
    expect(after.startsWith('我叫小助。')).toBe(true)
  })

  it('★幂等:同一个模板切两次不会变成二十段,第二次一个字没变、连备份都不多留', async () => {
    const wb = await serve({ agents: '我叫小助。\n' })
    await waitForBlock(wb.agents, ALL_BASE[0] as string)
    await post(wb.url, '/template/apply', { id: 'ops' })
    const once = wb.agents()
    const backupsAfterFirst = wb.backups().length

    const { body } = await post(wb.url, '/template/apply', { id: 'ops' })
    expect(wb.agents()).toBe(once)
    expect(wb.backups()).toHaveLength(backupsAfterFirst)
    // 一个字没改时如实说一句(D13:不总结成"已接上 11 段"那种看着像干了活的话)。
    expect(body.ops_skills.changed).toBe(false)
    expect(String(body.ops_skills.note)).toContain('一个字没改')
    const opened = (once ?? '').split(markers('运营-总纲').open).length - 1
    expect(opened).toBe(1)
  })

  it('★写之前先备份,备份里是改之前那一份', async () => {
    const before = '我叫小助。\n原来就有的一行。\n'
    const wb = await serve({ agents: before })
    // 起服务那一下先写了基础那几段(它也备份了一次)—— 等它落定,再看切模板那一次。
    await waitForBlock(wb.agents, ALL_BASE[0] as string)
    const beforeSwitch = wb.agents()
    const backupsBefore = wb.backups()
    expect(backupsBefore).toHaveLength(1)
    expect(readFileSync(join(wb.home, '.dsh', backupsBefore[0] as string), 'utf8')).toBe(before)

    const { body } = await post(wb.url, '/template/apply', { id: 'ops' })
    expect(String(body.ops_skills.backup_path)).toContain('bak-工作台-20260922-2330')
    // 这一份备份里是**切之前**那一份:他自己的两行在,运营那十段还没有。
    const saved = readFileSync(String(body.ops_skills.backup_path), 'utf8')
    expect(saved).toBe(beforeSwitch)
    expect(saved).toContain('原来就有的一行。')
    expect(saved).not.toContain(markers('运营-总纲').open)
    // 一次切换只留**一份**备份(十一段是在内存里换完一次写回的,不是写十一次)。
    expect(wb.backups()).toHaveLength(2)
  })

  it('AGENTS.md 本来就不存在:起服务那一下照样写,而且没有备份(没有东西可丢)', async () => {
    const wb = await serve()
    // 起服务那一下就把基础那几段写出来了 —— 文件是新建的,所以一个 .bak 都没有。
    await waitForBlock(wb.agents, ALL_BASE[0] as string)
    expect(wb.backups()).toHaveLength(0)

    const { body } = await post(wb.url, '/template/apply', { id: 'ops' })
    expect(wb.agents()).toContain(markers('运营-总纲').open)
    // 这一次文件已经在了,于是有备份 —— 这两句合起来就是那条纪律:**有东西可丢才备份**。
    expect(body.ops_skills.backup_path).toBeDefined()
    expect(wb.backups()).toHaveLength(1)
  })

  it('没接代写(既有那批用例的接线):切模板照常成功,回包里一个字的技能都不提', async () => {
    // paths 整块不传 = 这台服务没接代写。**不许**因此写到任何地方去。
    // ops 模板照样认得:与真机同款,来自用户层(全局来源那一处注册),不来自本体常量。
    const dir = mkdtempSync(join(tmpdir(), 'wb-ops-wire-nowire-'))
    dirs.push(dir)
    await startRealUserLayer(join(dir, '用户层'))
    let layout: WorkbenchLayout | undefined = {
      modules: [], butler: { corner: 'br', min: false },
      landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(one => ({ ...one })) },
    }
    const template = createTemplateService({
      file: join(dir, 'template.json'),
      backupsDir: join(dir, 'backups'),
      readLayout: () => Promise.resolve(layout),
      writeLayout: (next) => { layout = next; return Promise.resolve() },
    })
    await template.load()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService({ now: () => 0 }), tickIntervalMs: 0, heartbeatMs: 0, template,
    })
    started.push(server)
    const { status, body } = await post(server.url, '/template/apply', { id: 'ops' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.ops_skills).toBeUndefined()
  })

  it('★没有 ops 文件时诚实不认模板:用户层里没有 ops,apply ops 回 400、布局一个字不动', async () => {
    // 反例:这台机器的用户层是空的(起步层没放进 / 她删了)。本体不许内置 ops 常量
    // 来讨好这种场合 —— 认不得就是认不得,回包里如实说现在有哪些。
    const dir = mkdtempSync(join(tmpdir(), 'wb-ops-wire-noops-'))
    dirs.push(dir)
    const userLayer = await startRealUserLayer(join(dir, '用户层-empty'), { starter: false })
    // 空目录:ensure 不会凭空造 ops.json(起步层只在给了 starterDir 时才放)。
    expect(userLayer.layoutTemplates().map(one => one.id)).not.toContain('ops')
    let layout: WorkbenchLayout | undefined = {
      modules: [], butler: { corner: 'br', min: false },
      landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(one => ({ ...one })) },
    }
    const template = createTemplateService({
      file: join(dir, 'template.json'),
      backupsDir: join(dir, 'backups'),
      readLayout: () => Promise.resolve(layout),
      writeLayout: (next) => { layout = next; return Promise.resolve() },
      templates: () => userLayer.layoutTemplates(),
    })
    await template.load()
    const server = await startWorkbenchServer({
      port: 0, service: createWorkbenchService({ now: () => 0 }), tickIntervalMs: 0, heartbeatMs: 0, template,
      paths: { config: createAppConfig({ file: join(dir, 'app.json') }), home: join(dir, 'home') },
    })
    started.push(server)
    const before = layout
    const { status, body } = await post(server.url, '/template/apply', { id: 'ops' })
    expect(status).toBe(400)
    expect(String(body.error)).toContain('ops')
    expect(layout).toBe(before)
  })
})

describe('GET /config/ops-skills:接上了没有', () => {
  it('★还没接:ok=false,缺的那几段一条条列出来(不总结成一句"未就绪")', async () => {
    const wb = await serve()
    await post(wb.url, '/template/apply', { id: 'product' })
    // 先切到运营(但把 AGENTS.md 删掉,模拟"切过模板、技能没接上"那台存量机器)
    await post(wb.url, '/template/apply', { id: 'ops' })
    rmSync(wb.agentsFile, { force: true })

    const { status, body } = await getJson(wb.url, '/config/ops-skills')
    expect(status).toBe(200)
    expect(body.template).toBe('ops')
    expect(body.attached.ok).toBe(false)
    expect(body.attached.attached).toEqual([])
    expect(body.attached.absent).toEqual([...ALL_BASE, ...ALL_OPS])
    expect(body.attached.expected).toHaveLength(BASE_SKILLS.length + OPS_SKILLS.length)
    // 每一条都说得出:仓库里读到了没有、此刻接上了没有。
    expect(body.skills.every((row: any) => row.found === true)).toBe(true)
    expect(body.skills.every((row: any) => row.attached === false)).toBe(true)
  })

  it('★「重新接上」那颗按钮:POST 一次就全接上,而且提醒要新开一条会话', async () => {
    const wb = await serve()
    await post(wb.url, '/template/apply', { id: 'ops' })
    rmSync(wb.agentsFile, { force: true })

    const applied = await post(wb.url, '/config/ops-skills/apply', {})
    expect(applied.status).toBe(200)
    expect(applied.body.written).toEqual([...ALL_BASE, ...ALL_OPS])
    expect(String(applied.body.restart_hint)).toContain('新开一条')

    const { body } = await getJson(wb.url, '/config/ops-skills')
    expect(body.attached.ok).toBe(true)
    expect(body.attached.absent).toEqual([])
    expect(body.attached.stray).toEqual([])
    expect(body.attached.attached).toHaveLength(BASE_SKILLS.length + OPS_SKILLS.length)
  })

  it('做产品模板下:运营那几段不在期待里,接上的只有基础那几段', async () => {
    const wb = await serve()
    await post(wb.url, '/template/apply', { id: 'product' })
    const { body } = await getJson(wb.url, '/config/ops-skills')
    expect(body.template).toBe('product')
    expect(body.attached.expected).toEqual([...ALL_BASE, ...ALL_PRODUCT])
    expect(body.attached.ok).toBe(true)
    expect(body.attached.stray).toEqual([])
  })

  /**
   * ★ 2026-09-23「同一个事务官」改了这条的口径:挡住的是**没配对过的**那种来源。
   * 配对过的手机从此与本机同权(技能是事务官自己的能力,不是这台机器的装配)——
   * 那一条钉在 `tests/server-one-butler-gates.test.ts`。这里钉的是"外面进不来"。
   */
  it('★没配对过的局域网来源一律挡住(放宽的是她的另一台设备,不是外面)', async () => {
    const wb = await serve()
    await waitForBlock(wb.agents, ALL_BASE[0] as string)
    wb.remote.address = '192.168.1.20'
    const { status, body } = await post(wb.url, '/config/ops-skills/apply', {})
    wb.remote.address = '127.0.0.1'
    expect(status).toBe(403)
    // 外面那道来源门先拦下了(连路由都没进);拦在哪一层不重要,重要的是写不进去。
    expect(String(body.error)).not.toBe('')
    expect(wb.agents()).not.toContain(markers('运营-总纲').open)
  })
})

describe('起服务时补一次(存量用户)', () => {
  it('★模板早就是运营、AGENTS.md 里一段技能都没有 → 起服务后自动补上', async () => {
    const wb = await serve({ templateId: 'ops' })
    const after = await waitForBlock(wb.agents, '运营-总纲')
    for (const name of [...ALL_BASE, ...ALL_OPS]) expect(after).toContain(markers(name).open)
    expect(existsSync(wb.agentsFile)).toBe(true)
  })

  it('★补那一次也是幂等的:已经接上的机器重启不会多出一个 .bak', async () => {
    const wb = await serve({ templateId: 'ops' })
    await waitForBlock(wb.agents, '运营-总纲')
    const text = wb.agents()
    const backups = wb.backups().length
    // 再走一遍同一条路(等价于又重启了一次)
    const applied = await post(wb.url, '/config/ops-skills/apply', {})
    expect(applied.status).toBe(200)
    expect(wb.agents()).toBe(text)
    expect(wb.backups()).toHaveLength(backups)
  })
})

describe('没有开发仓库(普通用户机器,2026-09-23)', () => {
  it('★起服务照样把运营技能写进去:正文是包内那份,违禁词表落到 ~/.dsh/workbench/技能/,正文指向它', async () => {
    const wb = await serve({ templateId: 'ops', noRepo: true })
    const after = await waitForBlock(wb.agents, '运营-合规查词')
    for (const name of [...ALL_BASE, ...ALL_OPS]) expect(after).toContain(markers(name).open)
    const wordlist = join(wb.home, '.dsh', 'workbench', '技能', '违禁词表.md')
    expect(readFileSync(wordlist, 'utf8')).toBe(readFileSync(join(REPO_ROOT, 'docs', '技能', '违禁词表.md'), 'utf8'))
    // 2026-10-02:词表路径写在**正文**里(正文落盘,AGENTS.md 里只剩索引)。
    const body = bodyText(wb.home, '运营-合规查词')
    expect(body).toContain(wordlist)
    expect(body).not.toContain('docs/技能/违禁词表.md')
    const view = await getJson(wb.url, '/config/ops-skills')
    expect(view.body.attached.ok).toBe(true)
    expect(view.body.repo_root).toBeUndefined()
  })
  it('派活技能也接得上(包内那份)', async () => {
    const wb = await serve({ noRepo: true })
    const view = await getJson(wb.url, '/config/skill')
    expect(view.status).toBe(200)
  })
})

/**
 * ★ 卡 SP(2026-09-26):技能正文里的工作台地址是**这台服务真在听的那个**。
 *
 * 由来:正文里原来写死 `http://127.0.0.1:8791/dispatch/run` 等等,而端口是 `WORKBENCH_PORT`
 * 算出来的。灰度实例(8890)里的事务官照那个地址派活 —— **派的是生产**(卡 ZM 撞出;卡 GP 修的
 * 是页面那一半,它的守门只扫 `src/client`,Markdown 不在范围里)。
 *
 * 这几条端到端走的是**真的那条路**:起服务 → 写 `~/.dsh/AGENTS.md`。`port: 0` 让系统分配一个端口,
 * 于是"跟着真端口走"这件事是真被验的(随机端口几乎不可能恰好是 8791),而且不跟这台机器上
 * 跑着的生产 / 灰度实例抢端口。
 */
describe('技能正文里的工作台地址跟着真端口走', () => {
  /** AGENTS.md 里工作台自己那几段(段外是他自己的东西,不该被这几条管)。 */
  function ourBlocks(text: string): string {
    const out: string[] = []
    for (const name of [...ALL_BASE, ...ALL_OPS]) {
      const { open, close } = markers(name)
      const from = text.indexOf(open)
      const to = text.indexOf(close, from)
      if (from >= 0 && to > from) out.push(text.slice(from, to + close.length))
    }
    return out.join('\n')
  }

  it('★落下来的技能正文里地址全是真端口,一个 8791 都没有,占位也没漏出去', async () => {
    const wb = await serve({ templateId: 'ops' })
    const after = await waitForBlock(wb.agents, '运营-给AI分发任务')
    expect(wb.port).not.toBe(8791)
    // 2026-10-02:正文落盘,所以这几条看的是落下来那几份(索引里不写接口)。
    const bodies = allBodies(wb.home, [...ALL_BASE, ...ALL_OPS])
    // 那几条接口逐条按真端口写(这是事务官真去 POST 的那几句)。
    for (const path of ['/dispatch/run', '/dispatch/choices', '/progress/ask', '/agents/quota', '/dispatch/api', '/confirm/points']) {
      expect(bodies, path).toContain(`http://127.0.0.1:${wb.port}${path}`)
    }
    // 生产那个端口一个字都不许出现 —— 正文里不许,AGENTS.md 我们那几段里也不许。
    expect(bodies).not.toContain('8791')
    expect(ourBlocks(after)).not.toContain('8791')
    // 占位不许漏进去 —— 漏了事务官会照着 `{{工作台地址}}` 去 fetch。
    expect(bodies).not.toContain('{{工作台地址}}')
    expect(ourBlocks(after)).not.toContain('{{工作台地址}}')
  })

  it('★没有开发仓库(普通用户机器)时,包内那份也一样渲', async () => {
    const wb = await serve({ templateId: 'ops', noRepo: true })
    const after = await waitForBlock(wb.agents, '派活给别家Agent')
    expect(bodyText(wb.home, '派活给别家Agent')).toContain(`http://127.0.0.1:${wb.port}/dispatch/run`)
    expect(allBodies(wb.home, [...ALL_BASE, ...ALL_OPS])).not.toContain('8791')
    expect(ourBlocks(after)).not.toContain('8791')
    expect(ourBlocks(after)).not.toContain('{{工作台地址}}')
  })

  it('★老那条路(GET /config/skill,设置里那颗「接上」按钮看的那一份)渲的是同一个地址', async () => {
    const wb = await serve()
    const { status, body } = await getJson(wb.url, '/config/skill')
    expect(status).toBe(200)
    const skillBody = String(body.body)
    expect(skillBody).toContain(`http://127.0.0.1:${wb.port}/dispatch/run`)
    expect(skillBody).not.toContain('8791')
    expect(skillBody).not.toContain('{{工作台地址}}')
    // 文末那张现探的表没被这一下挤掉(卡 GH 可能同时在改那张表,这里只盯它还在)。
    expect(skillBody).toContain('这台电脑上现在怎么派')
  })
})

describe('opsSkillsAttachState(纯函数)', () => {
  it('该在的都在、不该在的都不在,才算 ok', () => {
    const with全部 = [...ALL_BASE, ...ALL_OPS].map(name => `${markers(name).open}\nx\n${markers(name).close}`).join('\n')
    expect(opsSkillsAttachState(with全部, 'ops').ok).toBe(true)
    // 同一份文本放在做产品模板下:运营那十段就成了"该摘没摘"。
    const product = opsSkillsAttachState(with全部, 'product')
    expect(product.ok).toBe(false)
    expect(product.stray).toEqual(ALL_OPS)
    // 做产品那一包在这份文本里没写过 —— 所以它是"该在却不在"的那一档。
    expect(product.absent).toEqual(ALL_PRODUCT)
  })

  it('文件不存在 = 一段都没接上(而不是报错)', () => {
    const state = opsSkillsAttachState(undefined, 'ops')
    expect(state.attached).toEqual([])
    expect(state.absent).toEqual([...ALL_BASE, ...ALL_OPS])
    expect(state.ok).toBe(false)
  })
})
