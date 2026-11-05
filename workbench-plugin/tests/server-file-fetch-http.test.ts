// @vitest-environment node
/**
 * 手机从电脑取文件 · 8791 的几条路(2026-09-25,卡 J `feat/phone-fetch-file`;★ 2026-10-29 入口归一改写):
 *
 *   GET  /files/offer/<单号>              手机在家直接下载(只有开单的那台取得到)
 *   GET  /channel/file-offer/<单号>       工人替在外面的手机核单(只认回环 + 降权头)
 *   GET  /channel/search-roots?q=         顺手认项目(focus);找文件的深度不再是「仓库藏多深」的 1
 *   POST /butler/send-file                事务官找她要的文件、开取件单、把卡推到她手机上
 *
 * ★ A#1(删规矩第一批):/butler/item 的「把 X 发到我手机上」专项词表(file_ask 岔口)已删 ——
 * 这一类话现在与其它交代一样进理解中枢(假模型按原话回 note,卡照建),不再有 file_ask 回包;
 * 取件单改由 `POST /butler/send-file` 这一条正规路开出来。本文件里原来钉「专项认话」的
 * 三条用例(没授权读扫描根 / 没找到 / 扫描根外项目不认)随那条岔口一并删除;
 * 其余用例保留负向断言(不岔专项、照建卡),并把开单前置换成「手机交代进中枢建卡 →
 * 工人报在线设备 → 事务官 send-file」这一套现在真实存在的路。
 *
 * 文件全建在 mkdtemp 的临时目录里,只删那个目录。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { DELIVERY_WHY_WAITING_TAP } from '../src/server/fileDelivery.ts'
import type { ProjectsService } from '../src/server/projectsService.ts'
import { lanOn } from './helpers/lanOn.ts'
import { fakeHubModel } from './helpers/fakeHubModel.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-25T09:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const README = '# 工作台\n\n卡 J 的测试 README。\n'

async function serve(options: { scanAuth?: '可以' | '不可以', answers?: Parameters<typeof fakeHubModel>[0] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fetch-http-'))
  dirs.push(dir)
  const scan = join(dir, 'GitHub')
  const repo = join(scan, 'desktop-workbench')
  mkdirSync(join(repo, 'docs'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), README)
  writeFileSync(join(repo, 'docs', 'README.md'), 'docs\n')
  writeFileSync(join(repo, 'docs', '产品说明.pdf'), '%PDF-1.4 fake\n')
  writeFileSync(join(repo, '.git', 'README'), 'no\n')
  const work = join(dir, '事务官')
  mkdirSync(join(work, '收件'), { recursive: true })
  writeFileSync(join(work, '收件', '会议纪要-README.txt'), '纪要\n')

  const authFile = join(dir, '授权.md')
  writeFileSync(authFile, [
    '| 项 | 说明 | 授权 | 日期 |',
    '|---|---|---|---|',
    `| \`read_scan_roots\` | 读扫描根 | ${options.scanAuth ?? '可以'} | 2026-09-25 |`,
    // 本机那条「照旧建卡」要过 write_api 那道门(程序来源建事项)。
    '| `write_api` | 写接口 | 可以 | 2026-09-25 |',
    '',
  ].join('\n'), 'utf8')
  const authorization = createAuthorizationService({ file: authFile })
  const appConfig = createAppConfig({ file: join(dir, 'app.json') })
  await appConfig.set({ scan_roots: [{ path: scan, depth: 1 }] })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  const deviceDirectory = createDeviceDirectoryService()
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const projects = {
    getProjectsState: async () => ({
      projects: [
        { id: 'desktop-workbench', name: 'desktop-workbench', stage: 'build', path: repo, links: [], session_count: 0, idle: false },
        // 扫描根外面的一条(项目区里手填的):不该被认成可以找的项目。
        { id: 'outside', name: 'outside-workbench', stage: 'build', path: join(dir, 'outside-workbench'), links: [], session_count: 0, idle: false },
      ],
      pending: [],
      scan_errors: [],
    }),
  } as unknown as ProjectsService

  let actor: 'local' | 'phone' = 'local'
  // 2026-10-29 入口归一:/butler/item 一律进理解中枢 —— 假模型按原话回 note(标题 = 原话)。
  const model = fakeHubModel(options.answers ?? {})
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    authorization,
    deviceDirectory,
    tasks,
    projects,
    fileWorkDir: work,
    computerName: '书房 Mac',
    paths: { home: dir, config: appConfig },
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
    model: model.service as never,
    fetchImpl: model.fetchImpl,
  })
  started.push(server)
  pairing.start()
  const phone = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: 'Ben 的手机', platform: 'android' })
  if (!phone.ok) throw new Error('测试装置:配对没成')
  pairing.start()
  const other = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '别的手机', platform: 'android' })
  if (!other.ok) throw new Error('测试装置:第二台没配成')

  const call = async (method: string, path: string, init: { body?: unknown, token?: string, headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return res
  }
  const json = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>
  return {
    call, json, tasks, deviceDirectory, repo, work, server, model,
    as: (who: 'local' | 'phone') => { actor = who },
    phone: { token: phone.token, id: phone.device_id },
    other: { token: other.token, id: other.device_id },
  }
}

type H = Awaited<ReturnType<typeof serve>>

type Ask = { hits: { offer: string, name: string, where: string, bytes: number, kind: string }[], note?: string, query: string, device: string, total: number }

/** 等那张卡变成想要的样子(回执落卡那一笔是下载之后那一拍)。等不到就把此刻的样子交出去,让断言自己报。 */
async function untilTask(
  h: H,
  id: string,
  want: (task: { status: string, note?: string }) => boolean,
): Promise<{ status: string, note?: string }> {
  let last: { status: string, note?: string } = { status: '没有这张卡' }
  for (let i = 0; i < 50; i += 1) {
    const task = (await h.tasks.list()).tasks.find(one => one.id === id)
    if (task !== undefined) {
      last = { status: task.status, ...(task.note === undefined ? {} : { note: task.note }) }
      if (want(last)) return last
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return last
}

/** 一句一句的交代进中枢:假模型对哪句都回 note(标题 = 原话)。 */
function noteAnswers(texts: readonly string[]): Parameters<typeof fakeHubModel>[0] {
  return Object.fromEntries(texts.map(text => [text, [{ name: 'note', title: text, status: 'todo' }]]))
}

/** 手机上打一句 → 中枢建卡(入口归一后的真实路)。 */
async function phoneCard(h: H, text: string): Promise<{ status: number, body: Record<string, unknown>, itemId: string }> {
  h.as('phone')
  const res = await h.call('POST', '/butler/item', { body: { text, can_file_ask: true }, token: h.phone.token })
  const body = await h.json(res)
  return { status: res.status, body, itemId: String(body.id ?? '') }
}

/** 工人报一下在线设备(A#1 之后「送到哪一台」从这张表认,手机交代不再自带登记)。 */
async function reportPhoneOnline(h: H): Promise<void> {
  h.as('local')
  const res = await h.call('POST', '/channel/devices', { body: { devices: [{ identity: 'wb-phone-x', device_id: h.phone.id, name: 'Ben 的手机', kind: 'phone' }] } })
  expect(res.status).toBe(200)
}

/**
 * 开单前置(2026-10-29 入口归一后的真实路):手机交代进中枢建卡 → 工人报在线设备 →
 * 事务官(本机)POST /butler/send-file 开取件单 → 她手机上 /files/pending 看得见那张卡。
 */
async function offerSetup(h: H, text: string, query: string): Promise<{ itemId: string, sent: Record<string, unknown>, asks: Ask[] }> {
  const { itemId } = await phoneCard(h, text)
  await reportPhoneOnline(h)
  const sent = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, query } }))
  h.as('phone')
  const pending = await h.json(await h.call('GET', '/files/pending', { token: h.phone.token }))
  return { itemId, sent, asks: pending.file_asks as Ask[] }
}

describe('POST /butler/item:「把 X 发到我手机上」', () => {
  // A#1(删规矩第一批):这条岔口(file_ask 专项词表)已删 —— 这几条用例钉「不岔」:
  // 哪一路打进来的都不回 file_ask,话照原样进中枢、卡照建。取文件改由
  // POST /butler/send-file 那一条正规路办(见下面几个 describe)。
  it('手机发来的:不岔专项(A#1),话进中枢、照建卡', async () => {
    const said = '把工作台仓库的 README 发到我手机上'
    const h = await serve({ answers: noteAnswers([said]) })
    const { status, body } = await phoneCard(h, said)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.file_ask).toBeUndefined()
    // 原话一字未改进中枢(她在手机上说)。
    const prompt = h.model.seen.prompts.at(-1) ?? ''
    expect(prompt).toContain('她在 phone 说')
    expect(prompt).toContain(`说:「${said}」`)
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })

  it('老手机包(不带 can_file_ask)不岔:照旧当一件事项', async () => {
    const said = '把工作台仓库的 README 发到我手机上'
    const h = await serve({ answers: noteAnswers([said]) })
    h.as('phone')
    const res = await h.call('POST', '/butler/item', { body: { text: said }, token: h.phone.token })
    expect((await h.json(res)).file_ask).toBeUndefined()
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })

  it('本机(电脑上打的)不岔:照旧当一件事项', async () => {
    const said = '把工作台仓库的 README 发到我手机上'
    const h = await serve({ answers: noteAnswers([said]) })
    h.as('local')
    const res = await h.call('POST', '/butler/item', { body: { text: said } })
    const body = await h.json(res)
    expect(body.file_ask).toBeUndefined()
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })

  it('no_fetch(手机上「交给事务官」那一下)不岔', async () => {
    const said = '把工作台仓库的 README 发到我手机上'
    const h = await serve({ answers: noteAnswers([said]) })
    h.as('phone')
    const res = await h.call('POST', '/butler/item', { body: { text: said, no_fetch: true, can_file_ask: true }, token: h.phone.token })
    expect((await h.json(res)).file_ask).toBeUndefined()
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })

  it('认不出的照旧建卡(宁可漏认)', async () => {
    const said = '把 README 改一下再发我'
    const h = await serve({ answers: noteAnswers([said]) })
    h.as('phone')
    const res = await h.call('POST', '/butler/item', { body: { text: said, can_file_ask: true }, token: h.phone.token })
    expect((await h.json(res)).file_ask).toBeUndefined()
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })
})

describe('GET /files/offer/<单号>:在家直接下载', () => {
  const TEXT = '把工作台仓库的 README 发到我手机上'
  it('开单的那台手机下得到,字节一个不差;带 sha256;记一条传输记录', async () => {
    const h = await serve({ answers: noteAnswers([TEXT]) })
    const { asks } = await offerSetup(h, TEXT, '工作台 README')
    const offer = asks[0]?.hits.find(hit => hit.name === 'README.md')?.offer as string
    h.as('phone')
    const res = await h.call('GET', `/files/offer/${offer}`, { token: h.phone.token })
    expect(res.status).toBe(200)
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.toString('utf8')).toBe(README)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(README)))
    expect(res.headers.get('x-wb-sha256')).toBe(createHash('sha256').update(README).digest('hex'))
    expect(decodeURIComponent(res.headers.get('x-wb-name') ?? '')).toBe('README.md')
    // 传完才记(finish 之后),给一拍。
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.deviceDirectory.transfers()[0]).toMatchObject({ direction: 'out', peer: 'Ben 的手机', name: 'README.md', ok: true, by: 'typed' })
  })

  it('别的手机拿同一个单号取不到;乱编的单号也取不到', async () => {
    const h = await serve({ answers: noteAnswers([TEXT]) })
    const { asks } = await offerSetup(h, TEXT, '工作台 README')
    const offer = asks[0]?.hits.find(hit => hit.name === 'README.md')?.offer as string
    h.as('phone')
    expect((await h.call('GET', `/files/offer/${offer}`, { token: h.other.token })).status).toBe(404)
    expect((await h.call('GET', '/files/offer/not-a-real-offer', { token: h.phone.token })).status).toBe(404)
  })

  it('开单之后文件被挪走了:410 + 一句人话,并记一条没成的传输', async () => {
    const h = await serve({ answers: noteAnswers([TEXT]) })
    const { asks } = await offerSetup(h, TEXT, '工作台 README')
    unlinkSync(join(h.repo, 'README.md'))
    h.as('phone')
    const res = await h.call('GET', `/files/offer/${asks[0]?.hits.find(hit => hit.name === 'README.md')?.offer as string}`, { token: h.phone.token })
    expect(res.status).toBe(410)
    expect(String((await h.json(res)).error)).toContain('不在了')
    expect(h.deviceDirectory.transfers()[0]).toMatchObject({ ok: false, name: 'README.md' })
  })
})

describe('GET /channel/file-offer/<单号>:工人替在外面的手机核单', () => {
  const TEXT = '把工作台仓库的 README 发到我手机上'
  it('回环 + 那台手机的降权头:给路径;单子不是开给它的就 404', async () => {
    const h = await serve({ answers: noteAnswers([TEXT]) })
    const { asks } = await offerSetup(h, TEXT, '工作台 README')
    const offer = asks[0]?.hits.find(hit => hit.name === 'README.md')?.offer as string
    h.as('local')
    const ok = await h.call('GET', `/channel/file-offer/${offer}`, { headers: { 'x-workbench-channel-device': h.phone.id } })
    expect(ok.status).toBe(200)
    expect(await h.json(ok)).toMatchObject({ path: join(h.repo, 'README.md'), name: 'README.md', bytes: Buffer.byteLength(README) })
    const wrong = await h.call('GET', `/channel/file-offer/${offer}`, { headers: { 'x-workbench-channel-device': h.other.id } })
    expect(wrong.status).toBe(404)
  })

  it('不带降权头的回环、带令牌的手机:都 403(路径只给回环上的工人)', async () => {
    const h = await serve({ answers: noteAnswers([TEXT]) })
    const { asks } = await offerSetup(h, TEXT, '工作台 README')
    const offer = asks[0]?.hits.find(hit => hit.name === 'README.md')?.offer as string
    h.as('local')
    expect((await h.call('GET', `/channel/file-offer/${offer}`)).status).toBe(403)
    h.as('phone')
    expect((await h.call('GET', `/channel/file-offer/${offer}`, { token: h.phone.token })).status).toBe(403)
  })
})

describe('GET /channel/search-roots', () => {
  it('?q= 认出项目给 focus;找文件的深度至少 6(不再是扫仓库的 1)', async () => {
    const h = await serve()
    h.as('local')
    const res = await h.call('GET', `/channel/search-roots?q=${encodeURIComponent('工作台 README')}`)
    const body = await h.json(res)
    expect(body.allowed).toBe(true)
    expect((body.roots as { depth: number }[])[0]?.depth).toBe(6)
    expect(body.focus).toEqual({ name: 'desktop-workbench', path: h.repo, terms: ['readme'] })
  })

  it('不带 q 就没有 focus(老工人照旧)', async () => {
    const h = await serve()
    h.as('local')
    const body = await h.json(await h.call('GET', '/channel/search-roots'))
    expect(body.focus).toBeUndefined()
  })
})

/**
 * ——— 一条路走通:她那一句 → 事务官 → 卡推到手机 → 回执 → 完成 ———
 * (2026-10-04,卡 `claude/phone-file-send-loop`;那天早上断在哪见 `docs/交接-1004-手机要文件一条路走通.md`)
 */
describe('POST /butler/send-file:事务官替她发文件', () => {
  it('★ 她 10-04 早那一句现在进中枢、照建卡(不再岔 file_ask;A#1)', async () => {
    const said = '官网逐字稿,这份文件发到我这个手机上。'
    const h = await serve({ answers: noteAnswers([said]) })
    const { status, body } = await phoneCard(h, said)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.file_ask).toBeUndefined()
    // 原话进中枢(这台机器上没有叫「官网逐字稿」的文件 —— 交给中枢按上下文办,不编一个)。
    expect(h.model.seen.prompts.at(-1) ?? '').toContain(`说:「${said}」`)
    expect((await h.tasks.list()).tasks).toHaveLength(1)
  })

  it('事务官调一次就把卡推到她手机上;/files/pending 上她看得见;回执一到卡进「完成」', async () => {
    const said = '把工作台仓库的产品说明改一下再发我'
    const h = await serve({ answers: noteAnswers([said]) })
    const { itemId } = await phoneCard(h, said)

    // 事务官(本机)走正规的那一下。**只找到一个**才直接摆卡(找到几个走下面那一条)。
    // A#1 之后「送到哪一台」从工人报的在线设备表认(手机交代不再自带登记)。
    await reportPhoneOnline(h)
    const sent = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, query: '工作台 产品说明.pdf' } }))
    expect(sent.ok).toBe(true)
    expect(sent.name).toBe('产品说明.pdf')
    expect(String(sent.note)).toContain('等传输回执')
    // 回给事务官的话里也没有路径。
    expect(JSON.stringify(sent)).not.toContain(h.repo)

    // 她手机上看得见那张卡(不用再说一遍)。
    h.as('phone')
    const pending = await h.json(await h.call('GET', '/files/pending', { token: h.phone.token }))
    const asks = pending.file_asks as Ask[]
    expect(asks).toHaveLength(1)
    expect(asks[0]?.hits[0]?.name).toBe('产品说明.pdf')
    // 别的手机看不见这张卡。
    const other = await h.json(await h.call('GET', '/files/pending', { token: h.other.token }))
    expect(other.file_asks).toEqual([])

    // 还没点 → 还是没到。
    expect(h.server.fileDelivery.pending(itemId)?.why).toBe(DELIVERY_WHY_WAITING_TAP)

    /*
     * 会话答完了、卡停在「阻塞 · 等你点那张卡」上(真机上这一步由 `butlerLifecycle` 落;
     * 这个用例里没有 DSH 会话,所以手摆到那个位置)。
     */
    await h.tasks.move(itemId, 'doing')
    await h.tasks.move(itemId, 'blocked')

    // 她点了那一下:直连下载完 = 回执。
    const got = await h.call('GET', `/files/offer/${asks[0]?.hits[0]?.offer}`, { token: h.phone.token })
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('%PDF-1.4 fake\n')
    // 回执在服务端 `res` 的 finish 那一拍才记,她这头读完正文时它不一定已经发生 —— 等到卡进「完成」再看台账。
    const after = await untilTask(h, itemId, one => one.status === 'done')
    expect(after.status).toBe('done')
    expect(h.server.fileDelivery.pending(itemId)).toBeUndefined()
    expect(after.note).toContain('已经到你手机上了')
    // 流水里留了单号(出门那条路靠它认是哪件事)。
    expect(h.deviceDirectory.transfers()[0]?.offer).toBe(asks[0]?.hits[0]?.offer)
  })

  it('找到几个:不许自己挑 —— 回「问她一句是哪一个」,几个候选都摆在卡上', async () => {
    const said = '把 README 整理一下发我'
    const h = await serve({ answers: noteAnswers([said]) })
    const { itemId } = await phoneCard(h, said)
    await reportPhoneOnline(h)
    const sent = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, query: 'README' } }))
    expect(sent.ok).toBe(false)
    expect(sent.where).toBe('pick')
    expect((sent.hits as unknown[]).length).toBeGreaterThan(1)
    expect(String(sent.note)).toContain('问她一句')
    h.as('phone')
    const asks = (await h.json(await h.call('GET', '/files/pending', { token: h.phone.token }))).file_asks as Ask[]
    expect(asks[0]?.hits.length).toBeGreaterThan(1)
  })

  it('一个都没找到:如实说在哪找的、找的什么,叫它问她一句', async () => {
    const said = '把季度报表整理一下发我'
    const h = await serve({ answers: noteAnswers([said]) })
    const { itemId } = await phoneCard(h, said)
    await reportPhoneOnline(h)
    const sent = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, query: '季度报表' } }))
    expect(sent.ok).toBe(false)
    expect(sent.where).toBe('none')
    expect(String(sent.note)).toContain('没找到')
    expect(String(sent.note)).toContain('问她一句')
    expect(h.server.fileDelivery.pending(itemId)?.why).toContain('没找到')
  })

  it('它自己生成的那一份(path):照样过取文件那一整套门', async () => {
    const said = '把工作台的 README 改一下再发我'
    const h = await serve({ answers: noteAnswers([said]) })
    const { itemId } = await phoneCard(h, said)
    await reportPhoneOnline(h)
    const ok = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, path: join(h.repo, 'README.md') } }))
    expect(ok.ok).toBe(true)
    expect(ok.name).toBe('README.md')
    // 隐藏目录里的一份:发不过去,原因原样回(取文件那一套门,不另开一条松的路)。
    const bad = await h.json(await h.call('POST', '/butler/send-file', { body: { item: itemId, path: join(h.repo, '.git', 'README') } }))
    expect(bad.ok).toBe(false)
    expect(String(bad.note)).toContain('不传')
  })

  it('没登记过、又说不出送到哪一台:如实回一句,不立一个送不到的牌子', async () => {
    const said = '随手记一件事'
    const h = await serve({ answers: noteAnswers([said]) })
    h.as('local')
    const made = await h.json(await h.call('POST', '/butler/item', { body: { text: said } }))
    // 工人没报过在线设备 → 认不出送到哪一台。
    const res = await h.call('POST', '/butler/send-file', { body: { item: made.id, query: 'README' } })
    expect(res.status).toBe(409)
    expect(String((await h.json(res)).note)).toContain('认不出要把文件送到哪一台')
  })

  it('手机自己报的回执(写完盘、对上 sha256)也算;别人的单报不了', async () => {
    const said = '把工作台仓库的产品说明整理一下发我手机上'
    const h = await serve({ answers: noteAnswers([said]) })
    const { itemId } = await phoneCard(h, said)
    await reportPhoneOnline(h)
    await h.call('POST', '/butler/send-file', { body: { item: itemId, query: '工作台 产品说明.pdf' } })
    h.as('phone')
    const asks = (await h.json(await h.call('GET', '/files/pending', { token: h.phone.token }))).file_asks as Ask[]
    const offer = asks[0]?.hits[0]?.offer as string
    const mine = await h.json(await h.call('POST', '/files/received', { body: { offer, ok: true, bytes: 99 }, token: h.phone.token }))
    expect(mine.counted).toBe(true)
    expect(h.server.fileDelivery.pending(itemId)).toBeUndefined()
    // 别的手机报不了这张单。
    expect((await h.call('POST', '/files/received', { body: { offer, ok: true }, token: h.other.token })).status).toBe(404)
  })
})
