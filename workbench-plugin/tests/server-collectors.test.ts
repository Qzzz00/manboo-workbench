// @vitest-environment node
/**
 * 采集器 —— 用户层里「看一页数据」那一样(2026-09-23,`docs/设计-用户自己的那一层-2026-09-23.md`)。
 *
 * 钉四件:
 * ① **只读、不点、不解析**:浏览器那一侧只收到 openWindow / readPage(没有 switchTo),落盘的是页面原文;
 * ② **闸在代码里**:10 分钟、一天 4 次、一次一个、撞墙当天例程不再试;
 * ③ **停得住、留得下**:未登录 / 验证码 / 风控 / 窗口没开 → 停、如实说、记一行;
 * ④ **全在工作目录、能撤**:定义在 `采集器/`、数据在 `数据/`;撤 = 定义进 `.trash/`,数据不删;没配工作目录一个字不写。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COLLECTORS_DIR, COLLECTOR_TRASH, DAILY_MAX, DATA_DIR, LATEST_FILE, MIN_GAP_MS, PROFILE_PREFIX, RECORD_FILE,
  checkCollectorName, checkCollectorUrl, checkProfileName, createCollectorsService, defaultProfileFor, gateOf, parseCollectorDef,
  type CollectorBrowser, type CollectorRecord,
} from '../src/server/collectors.ts'

const NOW = Date.parse('2026-09-23T09:00:00+08:00')
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collectors-'))
  dirs.push(dir)
  return dir
}

/** 假浏览器:记下被叫了什么,按剧本回页面。 */
function fakeBrowser(script: { text?: string, href?: string, fail?: string } = {}) {
  const calls: { kind: 'open' | 'read', profileDir: string, url: string, extra: unknown[] }[] = []
  const browser: CollectorBrowser = {
    openWindow: async (profileDir, url) => { calls.push({ kind: 'open', profileDir, url, extra: [] }); return 9222 },
    readPage: async (profileDir, url, ...extra: unknown[]) => {
      calls.push({ kind: 'read', profileDir, url, extra })
      if (script.fail !== undefined) throw new Error(script.fail)
      return { href: script.href ?? url, title: '店铺后台', text: script.text ?? '成交金额 ¥1,234.00\n访客数 88' }
    },
  }
  return { browser, calls }
}

function make(opts: { workdir?: string, browser?: CollectorBrowser, now?: () => number } = {}) {
  const home = tmp()
  const workdir = opts.workdir === undefined ? join(home, '运营') : opts.workdir
  if (workdir !== '') mkdirSync(workdir, { recursive: true })
  const fake = fakeBrowser()
  const changed: number[] = []
  const service = createCollectorsService({
    workdir: () => workdir,
    // 定义的真源是用户层那一格(2026-10-26 切割收尾);用例不迁老位置,defsDir 直接用工作目录下那一格,行为同旧。
    defsDir: join(workdir, COLLECTORS_DIR),
    profileRoot: join(home, '.dsh', 'workbench'),
    browser: opts.browser ?? fake.browser,
    now: opts.now ?? (() => NOW),
    onChanged: () => { changed.push(1) },
  })
  return { service, workdir, home, calls: fake.calls, changed }
}

describe('校验(纯函数)', () => {
  it('★名字:非空、≤24 字、不拐弯(/ \\ .. 点开头一律不认)', () => {
    expect(checkCollectorName('店铺')).toEqual({ ok: true, name: '店铺' })
    expect(checkCollectorName('  ').ok).toBe(false)
    expect(checkCollectorName('a/b').ok).toBe(false)
    expect(checkCollectorName('..').ok).toBe(false)
    expect(checkCollectorName('.隐藏').ok).toBe(false)
    expect(checkCollectorName('x'.repeat(25)).ok).toBe(false)
  })

  it('★网址:只认 https,不许带账号密码', () => {
    expect(checkCollectorUrl('https://ark.xiaohongshu.com/app/data').ok).toBe(true)
    expect(checkCollectorUrl('http://ark.xiaohongshu.com/').ok).toBe(false)
    expect(checkCollectorUrl('https://user:pass@ark.xiaohongshu.com/').ok).toBe(false)
    expect(checkCollectorUrl('店铺后台').ok).toBe(false)
  })

  it('档案名缺省按名字算一个稳定短码,**不与创作者后台的 xhs_creator 串号**', () => {
    expect(checkProfileName(undefined, defaultProfileFor('店铺'))).toEqual({ ok: true, profile: defaultProfileFor('店铺') })
    expect(defaultProfileFor('店铺')).toBe(defaultProfileFor('店铺'))
    expect(defaultProfileFor('店铺')).not.toBe('xhs_creator')
    expect(checkProfileName('xhs_store', 'x')).toEqual({ ok: true, profile: 'xhs_store' })
    expect(checkProfileName('../x', 'x').ok).toBe(false)
  })

  it('定义读不懂 / 网址不对 → 整份不认(不猜)', () => {
    expect(parseCollectorDef('{')).toBeUndefined()
    expect(parseCollectorDef(JSON.stringify({ name: '店铺', url: 'ftp://x' }))).toBeUndefined()
    expect(parseCollectorDef(JSON.stringify({ name: '店铺', url: 'https://a.b/c' }))?.profile).toBe(defaultProfileFor('店铺'))
  })
})

describe('闸(纯函数)', () => {
  const rec = (minutesAgo: number, over: Partial<CollectorRecord> = {}): CollectorRecord =>
    ({ at: new Date(NOW - minutesAgo * 60_000).toISOString(), trigger: 'manual', status: 'ok', ...over })

  it(`★两次之间至少 ${MIN_GAP_MS / 60_000} 分钟 —— 失败的那一次也算(失败后立刻再试是轰炸)`, () => {
    expect(gateOf([], 'manual', NOW)).toBeUndefined()
    expect(gateOf([rec(3, { status: 'logged_out' })], 'manual', NOW)).toContain('分钟')
    expect(gateOf([rec(11)], 'manual', NOW)).toBeUndefined()
  })

  it(`★一天最多 ${DAILY_MAX} 次`, () => {
    const four = [rec(200), rec(150), rec(100), rec(50)]
    expect(gateOf(four, 'manual', NOW)).toContain('上限')
    // 昨天的不算今天的。
    const yesterday = [rec(60 * 30), rec(60 * 29), rec(60 * 28), rec(60 * 27)]
    expect(gateOf(yesterday, 'manual', NOW)).toBeUndefined()
  })

  it('★例程:今天跑过例程、或今天撞过墙 → 今天不再试;手点不受这两条管', () => {
    expect(gateOf([rec(120, { trigger: 'routine' })], 'routine', NOW)).toContain('例程')
    expect(gateOf([rec(120, { trigger: 'routine' })], 'manual', NOW)).toBeUndefined()
    expect(gateOf([rec(120, { status: 'captcha' })], 'routine', NOW)).toContain('撞过')
    expect(gateOf([rec(120, { status: 'captcha' })], 'manual', NOW)).toBeUndefined()
  })
})

describe('服务', () => {
  it('★建一个:定义落 采集器/<名>.json,进 view;同名不覆盖', async () => {
    const h = make()
    await h.service.load()
    const added = await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data', note: '我开店了' })
    expect(added.ok).toBe(true)
    const file = join(h.workdir, COLLECTORS_DIR, '店铺.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, name: '店铺', profile: defaultProfileFor('店铺'), note: '我开店了' })
    expect(h.service.view().items.map(one => one.name)).toEqual(['店铺'])
    expect((await h.service.add({ name: '店铺', url: 'https://x.y/' })).ok).toBe(false)
    expect((await h.service.add({ name: '店铺2', url: 'http://x.y/' })).ok).toBe(false)
    expect(h.changed.length).toBeGreaterThan(0)
  })

  it('★登录 = 只开窗口,用这个采集器自己的档案目录;工作台不填任何东西', async () => {
    const h = make()
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    const done = await h.service.login('店铺')
    expect(done.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.kind).toBe('open')
    expect(h.calls[0]?.profileDir).toBe(join(h.home, '.dsh', 'workbench', `${PROFILE_PREFIX}${defaultProfileFor('店铺')}`))
    expect(h.calls[0]?.url).toBe('https://ark.xiaohongshu.com/app/data')
    expect((await h.service.login('没有')).ok).toBe(false)
  })

  it('★采一次:readPage **不带 switchTo**(不点任何东西);落 最新.txt + 当天一份 + 记录一行;原文一字不改', async () => {
    const h = make()
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    const done = await h.service.run('店铺', 'manual')
    expect(done.ok).toBe(true)
    const read = h.calls.find(one => one.kind === 'read')
    expect(read?.extra).toEqual([])
    const dir = join(h.workdir, DATA_DIR, '店铺')
    const latest = readFileSync(join(dir, LATEST_FILE), 'utf8')
    expect(latest).toContain('成交金额 ¥1,234.00\n访客数 88')
    expect(latest).toContain('# 页面 https://ark.xiaohongshu.com/app/data')
    expect(readdirSync(dir).some(name => /^\d{4}-\d{2}-\d{2}\.txt$/.test(name))).toBe(true)
    const records = readFileSync(join(dir, RECORD_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line) as CollectorRecord)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'ok', trigger: 'manual', chars: '成交金额 ¥1,234.00\n访客数 88'.length })
    expect(h.service.view().items[0]?.latest_at).toBe(records[0]?.at)
    expect(h.service.view().items[0]?.today).toBe(1)
    const latestView = await h.service.latest('店铺')
    expect(latestView.ok && latestView.text.includes('访客数 88')).toBe(true)
  })

  it('★撞墙(未登录 / 验证码)→ 停、记一行、最新.txt 不动;窗口没开 → window_closed', async () => {
    const loggedOut = fakeBrowser({ href: 'https://ark.xiaohongshu.com/login', text: '请先登录' })
    const h = make({ browser: loggedOut.browser })
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    const done = await h.service.run('店铺', 'manual')
    expect(done.ok).toBe(false)
    expect(!done.ok && done.record?.status).toBe('logged_out')
    expect(!done.ok && done.error).toContain('未登录')
    expect(existsSync(join(h.workdir, DATA_DIR, '店铺', LATEST_FILE))).toBe(false)
    expect(existsSync(join(h.workdir, DATA_DIR, '店铺', RECORD_FILE))).toBe(true)

    let t = NOW + MIN_GAP_MS + 1
    const closed = fakeBrowser({ fail: 'connect ECONNREFUSED' })
    const h2 = make({ browser: closed.browser, now: () => t })
    await h2.service.load()
    await h2.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    const gone = await h2.service.run('店铺', 'manual')
    expect(!gone.ok && gone.record?.status).toBe('window_closed')
    t += 1
  })

  it('★闸真的拦:10 分钟内第二次不采(浏览器一次都没被叫)', async () => {
    let t = NOW
    const h = make({ now: () => t })
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    expect((await h.service.run('店铺', 'manual')).ok).toBe(true)
    t += 60_000
    const again = await h.service.run('店铺', 'manual')
    expect(again.ok).toBe(false)
    expect(!again.ok && again.error).toContain('分钟')
    expect(h.calls.filter(one => one.kind === 'read')).toHaveLength(1)
    t += MIN_GAP_MS
    expect((await h.service.run('店铺', 'manual')).ok).toBe(true)
  })

  it('★例程一轮:每个采集器各一次,过闸的才采;回给早报的几句都是事实', async () => {
    let t = NOW
    const h = make({ now: () => t })
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    await h.service.add({ name: '千川', url: 'https://qianchuan.jinritemai.com/' })
    const lines = await h.service.runForRoutine()
    expect(lines).toHaveLength(2)
    expect(lines.some(line => line.includes('「店铺」采到了'))).toBe(true)
    expect(lines.some(line => line.includes('「千川」采到了'))).toBe(true)
    t += MIN_GAP_MS + 1
    const again = await h.service.runForRoutine()
    expect(again[0]).toContain('今天例程已经采过一次')
    expect(h.calls.filter(one => one.kind === 'read')).toHaveLength(2)
  })

  it('★撤:定义搬进 .trash/,数据不删;之后 latest / run 都认不出它', async () => {
    const h = make()
    await h.service.load()
    await h.service.add({ name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    await h.service.run('店铺', 'manual')
    const done = await h.service.remove('店铺')
    expect(done.ok).toBe(true)
    expect(existsSync(join(h.workdir, COLLECTORS_DIR, '店铺.json'))).toBe(false)
    expect(readdirSync(join(h.workdir, COLLECTORS_DIR, COLLECTOR_TRASH)).some(name => name.startsWith('店铺.'))).toBe(true)
    expect(existsSync(join(h.workdir, DATA_DIR, '店铺', LATEST_FILE))).toBe(true)
    expect(h.service.view().items).toEqual([])
    expect((await h.service.latest('店铺')).ok).toBe(false)
    expect((await h.service.run('店铺', 'manual')).ok).toBe(false)
  })

  it('★没配工作目录:一个字不写,如实说;例程回空', async () => {
    const h = make({ workdir: '' })
    await h.service.load()
    expect(h.service.view().note).toContain('工作目录')
    expect((await h.service.add({ name: '店铺', url: 'https://x.y/' })).ok).toBe(false)
    expect(await h.service.runForRoutine()).toEqual([])
  })

  it('文件名与定义里的名字对不上的、坏掉的定义,整个不进清单', async () => {
    const h = make()
    mkdirSync(join(h.workdir, COLLECTORS_DIR), { recursive: true })
    writeFileSync(join(h.workdir, COLLECTORS_DIR, '店铺.json'), JSON.stringify({ name: '别的', url: 'https://x.y/' }), 'utf8')
    writeFileSync(join(h.workdir, COLLECTORS_DIR, '坏.json'), '{', 'utf8')
    await h.service.load()
    expect(h.service.view().items).toEqual([])
  })
})
