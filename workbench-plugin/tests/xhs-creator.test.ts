// @vitest-environment node
/**
 * 自取的编排(src/server/xhsCreator.ts)与建议(src/server/xhsAdvice.ts)。
 *
 * 浏览器与模型**全是桩** —— 这一份一个 Chrome 都不开、一个请求都不发。
 * 守的是:频率闸、改版之后不重试轰炸、成功失败都要留下一条看得见的记录、
 * 建议里的数字**一个都不经过模型**,以及 2026-09-22 新加的两件:
 * **切不成范围就不存那一份**、**多账号按档案分开存**。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { XhsRangeView } from '../src/protocol.ts'
import type { XhsBrowser, XhsPageRead } from '../src/server/xhsBrowser.ts'
import { rangeSwitchExpression, readPageWith } from '../src/server/xhsBrowser.ts'
import {
  LAYOUT_CHANGED_BACKOFF_MS, MIN_GAP_MS, XHS_DEFAULT_D7_URL, XHS_DEFAULT_NOTES_URL, XHS_HOME_URL,
  XHS_PROFILE_NAME, XHS_SWITCH_LABELS,
  createXhsService, defaultXhsConfig, isLoginUrl, nicknameFrom, pagesOf, parseXhsConfig, xhsProfileName,
} from '../src/server/xhsCreator.ts'
import {
  advisableChanges, basisLine, buildAdvicePrompt, composeAdvice, friendlyDate, parseAdviceReply,
} from '../src/server/xhsAdvice.ts'
import {
  XHS_FAKE_RENAMED_PAGE_TEXT, XHS_HOME_PAGE_B_TEXT, XHS_HOME_PAGE_D30_TEXT, XHS_HOME_PAGE_TEXT,
  XHS_LOGIN_PAGE_TEXT, XHS_NOTE_TABLE_TEXT,
} from './xhsPageFixtures.ts'

/** 这一轮里「今天」是哪天。夹具里的笔记发布日期是照它编的。 */
const DAY = new Date(2026, 8, 22, 10, 0, 0).getTime()

interface StubPages {
  /** `/new/home` 那一页的队列(近 7 日与近 30 日都从这里拿)。用完最后一份会一直重复。 */
  home?: (XhsPageRead | Error)[]
  /** 按笔记的那张表。 */
  notes?: (XhsPageRead | Error)[]
  /** 点「近30日」之后「统计周期」那一行到底变没变。false = 切不成。 */
  switchWorks?: boolean
  /** 第二个账号的 `/new/home`(多账号用例)。按档案目录名分流。 */
  homeB?: (XhsPageRead | Error)[]
}

/**
 * 一个假浏览器。**按地址分流**(首页一条队列、按笔记的表一条队列),
 * 因为真的取一轮现在是「首页 ×2(近7/近30)+ 按笔记的表 ×1」。
 */
function stubBrowser(pages: StubPages): XhsBrowser & {
  opened: string[]
  read: string[]
  calls: { profile: string, url: string, switchTo?: readonly string[] }[]
} {
  const home = [...(pages.home ?? [homePage()])]
  const homeB = [...(pages.homeB ?? [homePage(XHS_HOME_PAGE_B_TEXT)])]
  const notes = [...(pages.notes ?? [notesPage()])]
  const opened: string[] = []
  const read: string[] = []
  const calls: { profile: string, url: string, switchTo?: readonly string[] }[] = []
  const nextOf = (queue: (XhsPageRead | Error)[]): XhsPageRead | Error | undefined =>
    queue.length > 1 ? queue.shift() : queue[0]
  return {
    opened,
    read,
    calls,
    openWindow: async (profile, url) => { opened.push(`${profile}|${url}`); return 9222 },
    readPage: async (profile, url, switchTo) => {
      read.push(url)
      calls.push({ profile, url, ...(switchTo === undefined ? {} : { switchTo }) })
      const second = profile.endsWith('-2')
      const queue = url.includes('data-analysis') ? notes : (second ? homeB : home)
      const next = nextOf(queue)
      if (next === undefined) throw new Error('桩里没有这一页了')
      if (next instanceof Error) throw next
      if (switchTo === undefined) return next
      // 切范围:桩自己说点着了没有、「统计周期」那一行变了没有。
      const works = pages.switchWorks !== false
      return {
        ...next,
        text: works
          ? next.text.replace('统计周期 09-15 至 09-21', '统计周期 08-23 至 09-21')
          : next.text,
        switch_clicked: true,
        switch_confirmed: works,
      }
    },
  }
}

const homePage = (text = XHS_HOME_PAGE_TEXT): XhsPageRead =>
  ({ href: XHS_HOME_URL, title: '创作服务平台', text })
const notesPage = (text = XHS_NOTE_TABLE_TEXT): XhsPageRead =>
  ({ href: XHS_DEFAULT_NOTES_URL, title: '数据分析', text })

async function makeService(over: StubPages & {
  nowMs?: () => number
  chat?: (prompt: string) => Promise<string>
  selectors?: string
  /** 盘上建哪几个档案目录。默认只有第一个。 */
  profiles?: number[]
  opsAccounts?: () => Promise<readonly string[]>
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xhs-svc-'))
  for (const index of over.profiles ?? [1]) await mkdir(join(dir, xhsProfileName(index)), { recursive: true })
  const browser = stubBrowser(over)
  const selectorsFile = join(dir, 'xhs-selectors.json')
  if (over.selectors !== undefined) await writeFile(selectorsFile, over.selectors)
  const service = createXhsService({
    metricsFile: join(dir, 'xhs-metrics.json'),
    selectorsFile,
    profileRoot: dir,
    peekDir: dir,
    browser,
    now: over.nowMs ?? (() => DAY),
    ...(over.chat === undefined ? {} : { chat: over.chat }),
    ...(over.opsAccounts === undefined ? {} : { opsAccounts: over.opsAccounts }),
  })
  await service.load()
  return { service, browser, dir, metricsFile: join(dir, 'xhs-metrics.json') }
}

describe('常量与判据', () => {
  it('专用档案的名字跟 Kimi 那套同一个命名法', () => {
    expect(XHS_PROFILE_NAME).toBe('login-profile-xhs_creator')
  })

  it('★2026-09-22 实测:账号级总览在 /new/home,按笔记的表在 /statistics/data-analysis', () => {
    expect(XHS_HOME_URL).toBe('https://creator.xiaohongshu.com/new/home')
    expect(XHS_DEFAULT_D7_URL).toBe('https://creator.xiaohongshu.com/new/home')
    expect(XHS_DEFAULT_NOTES_URL).toBe('https://creator.xiaohongshu.com/statistics/data-analysis')
  })

  it('被跳到 /login 就是没登录', () => {
    expect(isLoginUrl('https://creator.xiaohongshu.com/login?source=&redirectReason=401')).toBe(true)
    expect(isLoginUrl(XHS_DEFAULT_D7_URL)).toBe(false)
  })

  it('两次自取之间至少 10 分钟', () => {
    expect(MIN_GAP_MS).toBe(10 * 60 * 1000)
  })

  it('那两颗按钮上写的字是页面上那一串(没有空格)', () => {
    expect(XHS_SWITCH_LABELS.d30[0]).toBe('近30日')
    expect(XHS_SWITCH_LABELS.d7[0]).toBe('近7日')
  })
})

describe('配置:可手改的那份覆盖文件', () => {
  it('★默认两个范围是同一个地址,但近 30 日要先点那颗按钮', () => {
    const config = defaultXhsConfig()
    expect(config.pages.d7).toBe(XHS_DEFAULT_D7_URL)
    expect(config.pages.d30).toBe(XHS_DEFAULT_D7_URL)
    const targets = pagesOf(config)
    expect(targets.map(page => page.range)).toEqual(['近 7 日', '近 30 日'])
    expect(targets[0]?.switchTo).toBeUndefined()
    expect(targets[1]?.switchTo?.[0]).toBe('近30日')
  })

  it('★去重看的是「地址 + 点哪颗按钮」这一对,不是光看地址', () => {
    // 两个范围都不点按钮、又是同一页 —— 那就真是同一份数,只认第一个。
    const config = { ...defaultXhsConfig(), switchLabels: { d7: [], d30: [] } }
    expect(pagesOf(config).map(page => page.range)).toEqual(['近 7 日'])
  })

  it('配上不同的两页就取两份', () => {
    const config = parseXhsConfig({
      pages: { d7: XHS_DEFAULT_D7_URL, d30: `${XHS_DEFAULT_D7_URL}?period=30` },
    })
    expect(pagesOf(config).map(page => page.range)).toEqual(['近 7 日', '近 30 日'])
  })

  it('★只认创作者中心自己的地址 —— 一份可手改的配置不该把这台机器指到别处去', () => {
    const config = parseXhsConfig({ pages: { d30: 'https://example.com/x' } })
    expect(config.pages.d30).toBe(XHS_DEFAULT_D7_URL)
  })

  it('空串 = 明说这个范围别取(连默认那条也清掉)', () => {
    expect(parseXhsConfig({ pages: { d7: '' } }).pages.d7).toBeUndefined()
  })

  it('那颗按钮上的字也能覆盖(后台改文案不用重新发版)', () => {
    const config = parseXhsConfig({ switch_labels: { d30: ['最近三十天'] } })
    expect(config.switchLabels.d30).toEqual(['最近三十天'])
    expect(pagesOf(config)[1]?.switchTo).toEqual(['最近三十天'])
  })

  it('文件坏了 / 形状不对一律退回默认,不抛', () => {
    expect(parseXhsConfig(null).pages.d7).toBe(XHS_DEFAULT_D7_URL)
    expect(parseXhsConfig({ pages: 5 }).pages.d7).toBe(XHS_DEFAULT_D7_URL)
  })
})

describe('昵称', () => {
  it('没配标签就**不编一个名字**', () => {
    expect(nicknameFrom('昵称\n小红薯', [])).toBeUndefined()
  })

  it('配了就按「标签 + 下一行 / 同一行」找', () => {
    expect(nicknameFrom('昵称\n假昵称·用例用的', ['昵称'])).toBe('假昵称·用例用的')
    expect(nicknameFrom('昵称:假昵称·用例用的', ['昵称'])).toBe('假昵称·用例用的')
  })

  it('找不到就没有', () => {
    expect(nicknameFrom('数据中心\n曝光数\n9.9万', ['昵称'])).toBeUndefined()
  })
})

describe('自取一轮', () => {
  it('两个范围都取到:数进盘,自取记录里记一条成功', async () => {
    const { service, metricsFile } = await makeService()
    const result = await service.collect('manual')
    expect(result.ok).toBe(true)

    const view = service.view()
    expect(view.login.connected).toBe(true)
    expect(view.ranges.map(range => range.range)).toEqual(['近 7 日', '近 30 日'])
    // 夹具里的数字全是假的(见 xhsPageFixtures.ts)。
    expect(view.ranges[0]?.metrics.find(metric => metric.key === 'impressions')?.raw).toBe('1,111')
    // ★「净涨粉」就是涨粉数那一项。
    expect(view.ranges[0]?.metrics.find(metric => metric.key === 'new_fans')?.raw).toBe('7')
    expect(view.fetches[0]?.ok).toBe(true)
    expect(view.fetches[0]?.trigger).toBe('manual')

    const saved = JSON.parse(await readFile(metricsFile, 'utf8')) as { accounts: { days: object }[] }
    expect(Object.keys(saved.accounts[0]?.days ?? {}).length).toBe(1)
  })

  it('★笔记发布数是从按笔记的表数出来的(首页没有这一项)', async () => {
    const { service } = await makeService()
    await service.collect('manual')
    const d7 = service.view().ranges.find(range => range.range === '近 7 日')
    // 夹具里近 7 日内有两篇(09-20 / 09-18),08-30 那篇掉出去了。
    expect(d7?.metrics.find(metric => metric.key === 'notes')?.raw).toBe('2')
    const d30 = service.view().ranges.find(range => range.range === '近 30 日')
    expect(d30?.metrics.find(metric => metric.key === 'notes')?.raw).toBe('3')
  })

  it('★平均观看时长永远空着,并且说得出为什么', async () => {
    const { service } = await makeService()
    await service.collect('manual')
    const avg = service.view().ranges[0]?.metrics.find(metric => metric.key === 'avg_watch')
    expect(avg?.value).toBeUndefined()
    expect(avg?.raw).toBeUndefined()
    expect(avg?.why).toContain('平台没给')
  })

  it('★按笔记的表打不开时,笔记发布数那一格空着并说明,别的项照常', async () => {
    const { service } = await makeService({ notes: [new Error('打不开')] })
    await service.collect('manual')
    const d7 = service.view().ranges[0]
    const notes = d7?.metrics.find(metric => metric.key === 'notes')
    expect(notes?.value).toBeUndefined()
    expect(notes?.why).toContain('数不出发了几篇')
    expect(d7?.metrics.find(metric => metric.key === 'impressions')?.raw).toBe('1,111')
  })

  it('★点了「近30日」但「统计周期」那一行没变 → **那一份一个字都不存**', async () => {
    const { service } = await makeService({ switchWorks: false })
    const result = await service.collect('manual')
    expect(result.ok).toBe(true)
    const ranges = service.view().ranges.map(range => range.range)
    // 只剩近 7 日。绝不把近 7 日那份数存成近 30 日那份。
    expect(ranges).toEqual(['近 7 日'])
    expect(service.view().note).toContain('没变')
  })

  it('★频率闸:10 分钟之内再点一次,直接挡掉,浏览器一次都不碰', async () => {
    let nowMs = DAY
    const { service, browser } = await makeService({ nowMs: () => nowMs })
    await service.collect('manual')
    const first = browser.read.length
    expect(first).toBeGreaterThan(0)

    nowMs += 5 * 60 * 1000
    const second = await service.collect('manual')
    expect(second.ok).toBe(false)
    expect(second.message).toContain('分钟后再来')
    expect(browser.read.length).toBe(first)

    nowMs += 6 * 60 * 1000
    await service.collect('manual')
    expect(browser.read.length).toBe(first * 2)
  })

  it('★没登录:如实记一条,不把上一次的数字当成这一次的', async () => {
    const { service } = await makeService({
      home: [{ href: 'https://creator.xiaohongshu.com/login?redirectReason=401', title: '', text: XHS_LOGIN_PAGE_TEXT }],
      notes: [{ href: 'https://creator.xiaohongshu.com/login?redirectReason=401', title: '', text: XHS_LOGIN_PAGE_TEXT }],
    })
    const result = await service.collect('manual')
    expect(result.ok).toBe(false)
    const view = service.view()
    expect(view.login.connected).toBe(false)
    expect(view.ranges).toEqual([])
    expect(view.fetches[0]?.reason).toContain('登录态过期了')
  })

  it('★改版:说「后台页面变了,等更新」,而且例程那条路当天不再试', async () => {
    let nowMs = DAY
    const { service, browser } = await makeService({
      nowMs: () => nowMs,
      home: [{ href: XHS_HOME_URL, title: '数据中心', text: XHS_FAKE_RENAMED_PAGE_TEXT }],
    })
    await service.collect('manual')
    expect(service.view().note).toContain('后台页面变了')
    const after = browser.read.length

    // 过了频率闸也不重试:例程被挡在改版那道闸外面。
    nowMs += MIN_GAP_MS + 1000
    const routine = await service.collect('routine')
    expect(routine.ok).toBe(false)
    expect(routine.message).toContain('不再自动重试')
    expect(browser.read.length).toBe(after)

    // 他自己点刷新还是能试一次(人要能推翻这个判断)。
    const manual = await service.collect('manual')
    expect(browser.read.length).toBeGreaterThan(after)
    expect(manual.ok).toBe(false)
  })

  it('★打不开那一页:记一条失败,上一次的数字还留着 +「上次成功 x 小时前」', async () => {
    let nowMs = DAY
    const { service } = await makeService({
      nowMs: () => nowMs,
      home: [homePage(), new Error('登录窗口没开着')],
    })
    await service.collect('manual')
    nowMs += 3 * 60 * 60 * 1000
    const failed = await service.collect('manual')

    expect(failed.ok).toBe(false)
    const view = service.view()
    // 上一次取到的那一份还在。
    expect(view.ranges[0]?.metrics.find(metric => metric.key === 'views')?.raw).toBe('222')
    expect(view.note).toContain('上次成功 3 小时前')
    expect(view.fetches[0]?.ok).toBe(false)
    expect(view.fetches[0]?.reason).toContain('登录窗口没开着')
  })

  it('★成功失败都留下一条看得见的记录(PRD §9:每个自动动作看得见)', async () => {
    let nowMs = DAY
    const { service } = await makeService({
      nowMs: () => nowMs,
      home: [homePage(), new Error('打不开')],
    })
    await service.collect('routine')
    nowMs += MIN_GAP_MS + 1000
    await service.collect('manual')
    const fetches = service.view().fetches
    expect(fetches.length).toBe(2)
    expect(fetches.map(log => log.trigger)).toEqual(['manual', 'routine'])
  })

  it('一个范围都没配时如实说,而且**不去碰浏览器**', async () => {
    const { service, browser } = await makeService({
      selectors: JSON.stringify({ pages: { d7: '', d30: '' } }),
    })
    const result = await service.collect('manual')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没配取数的页面')
    expect(browser.read.length).toBe(0)
  })

  it('一个档案都还没有时如实说,而且**不去碰浏览器**', async () => {
    const { service, browser } = await makeService({ profiles: [] })
    const result = await service.collect('manual')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('还没有登录过任何小红书账号')
    expect(browser.read.length).toBe(0)
  })
})

/**
 * 多账号(2026-09-22)。Ben 原话:「再开一个纯净的,我登录第二个账号」。
 */
describe('多账号', () => {
  it('★两个档案各取各的,每个账号一行 + 合计一行', async () => {
    const { service } = await makeService({ profiles: [1, 2] })
    const result = await service.collect('manual')
    expect(result.ok).toBe(true)
    expect(result.accounts).toBe(2)

    const view = service.view()
    expect(view.accounts.map(account => account.name)).toEqual(['测试号甲', '测试号乙'])
    expect(view.accounts.map(account => account.uid)).toEqual(['1234567890', '9876543210'])
    // 每个账号自己那一行是**页面上原样那串**。
    const a = view.accounts[0]?.ranges[0]?.metrics.find(metric => metric.key === 'impressions')
    const b = view.accounts[1]?.ranges[0]?.metrics.find(metric => metric.key === 'impressions')
    expect(a?.raw).toBe('1,111')
    expect(b?.raw).toBe('2,000')
    // 合计那一行是算出来的,而且自报家门。
    const total = view.ranges[0]?.metrics.find(metric => metric.key === 'impressions')
    expect(total?.value).toBe(3111)
    expect(total?.derived).toBe('合计')
    expect(view.total_note).toContain('2 个账号')
  })

  it('★一个账号时合计就是它自己:数字仍是页面上那一串,不加「合计」标', async () => {
    const { service } = await makeService()
    await service.collect('manual')
    const total = service.view().ranges[0]?.metrics.find(metric => metric.key === 'impressions')
    expect(total?.raw).toBe('1,111')
    expect(total?.derived).toBeUndefined()
    expect(service.view().total_note).toBeUndefined()
  })

  it('★第二个号没取到时,合计那几格空着 —— 不把一个号的数当成两个号的合计', async () => {
    const { service } = await makeService({ profiles: [1, 2], homeB: [new Error('登录窗口没开着')] })
    await service.collect('manual')
    const view = service.view()
    expect(view.accounts[0]?.ranges.length).toBeGreaterThan(0)
    expect(view.accounts[1]?.ranges.length).toBe(0)
    // 第二个号一天快照都没有 → 合计那一天整天不出现。
    expect(view.ranges).toEqual([])
    expect(view.accounts[1]?.note).toContain('登录窗口没开着')
  })

  it('落盘按账号分开,两个档案互不覆盖', async () => {
    const { service, metricsFile } = await makeService({ profiles: [1, 2] })
    await service.collect('manual')
    const saved = JSON.parse(await readFile(metricsFile, 'utf8')) as {
      version: number
      accounts: { profile: string, index: number, name?: string }[]
    }
    expect(saved.version).toBe(2)
    expect(saved.accounts.map(account => account.profile)).toEqual([
      'login-profile-xhs_creator', 'login-profile-xhs_creator-2',
    ])
  })

  it('★按名字对上运营模板那边的账号文件夹;对不上就没有这个钩子(不强绑)', async () => {
    const { service } = await makeService({
      profiles: [1, 2],
      opsAccounts: async () => ['测试号甲', '别的文件夹'],
    })
    await service.collect('manual')
    const view = service.view()
    expect(view.accounts[0]?.account_dir).toBe('测试号甲')
    expect(view.accounts[1]?.account_dir).toBeUndefined()
  })

  it('★每个档案都用它自己那个目录 —— 不会串到别人的登录态上', async () => {
    const { service, browser } = await makeService({ profiles: [1, 2] })
    await service.collect('manual')
    const dirs = [...new Set(browser.calls.map(call => call.profile.split('/').pop()))]
    expect(dirs.sort()).toEqual(['login-profile-xhs_creator', 'login-profile-xhs_creator-2'])
  })
})

describe('开登录窗口', () => {
  it('开的是创作者中心首页,用的是那个专用档案;**不代填任何账号密码**', async () => {
    const { service, browser } = await makeService()
    const result = await service.startLogin()
    expect(result.ok).toBe(true)
    expect(browser.opened[0]).toContain(XHS_HOME_URL)
    expect(browser.opened[0]).toContain(XHS_PROFILE_NAME)
    expect(result.message).toContain('自己登录')
  })

  it('★「再登录一个账号」开的是下一个序号的**纯净**档案', async () => {
    const { service, browser } = await makeService({ profiles: [1] })
    const result = await service.startLogin('new')
    expect(result.index).toBe(2)
    expect(result.profile).toBe('login-profile-xhs_creator-2')
    expect(browser.opened[0]).toContain('login-profile-xhs_creator-2')
  })

  it('一个档案都没有时,「再登录一个」开的就是第一个(不从 2 开始)', async () => {
    const { service } = await makeService({ profiles: [] })
    expect((await service.startLogin('new')).index).toBe(1)
  })

  it('指定第 N 个 = 重登那一个', async () => {
    const { service, browser } = await makeService({ profiles: [1, 2] })
    await service.startLogin(2)
    expect(browser.opened[0]).toContain('login-profile-xhs_creator-2')
  })
})

describe('「让我看看这页」', () => {
  it('★导出的文件里只有页面文字,而且明写着不含 cookie', async () => {
    const { service } = await makeService()
    const result = await service.peek()
    expect(result.ok).toBe(true)
    const text = await readFile(result.file as string, 'utf8')
    expect(text).toContain('没有 cookie、没有请求头、没有任何登录凭据')
    expect(text).toContain('曝光数')
    for (const word of ['cookie=', 'web_session', 'authorization:', 'Set-Cookie']) {
      expect(text).not.toContain(word)
    }
    expect(service.view().peek?.file).toBe(result.file)
  })

  it('打不开就如实说,不写一个空文件', async () => {
    const { service } = await makeService({ home: [new Error('登录窗口没开着')] })
    const result = await service.peek()
    expect(result.ok).toBe(false)
    expect(result.file).toBeUndefined()
  })
})

/** —— 建议 —— */

function rangeView(over: Partial<XhsRangeView> = {}): XhsRangeView {
  return {
    range: '近 7 日',
    date: '2026-09-21',
    at: '2026-09-21T02:00:00.000Z',
    metrics: [
      {
        key: 'impressions', label: '曝光数', kind: 'count',
        value: 77_000, raw: '7.7万',
        prev: { value: 99_000, raw: '9.9万', date: '2026-09-14' },
      },
      {
        key: 'cover_ctr', label: '封面点击率', kind: 'percent',
        value: 11.1, raw: '11.1%',
        prev: { value: 9.9, raw: '9.9%', date: '2026-09-14' },
      },
      // 本期取到了、上期没有 —— 不能当依据。
      { key: 'likes', label: '点赞数', kind: 'count', value: 999, raw: '999' },
      // 两期都没有。
      { key: 'avg_watch', label: '平均观看时长', kind: 'seconds' },
    ],
    ...over,
  }
}

describe('建议的依据由代码算,模型一个数都不心算', () => {
  it('只有本期与上期都取到的指标才能当依据', () => {
    const changes = advisableChanges(rangeView())
    expect(changes.map(change => change.key)).toEqual(['impressions', 'cover_ctr'])
  })

  it('★依据那一句里的百分比是代码算的', () => {
    const change = advisableChanges(rangeView())[0]
    expect(change?.percent).toBe(-22)
    expect(basisLine(change as never)).toBe('曝光数 9.9万 → 7.7万(-22%,对 9 月 14 日那一份)')
  })

  it('上期是 0 时不算百分比(除不了就不编一个数)', () => {
    const view = rangeView({
      metrics: [{
        key: 'new_fans', label: '涨粉数', kind: 'count', value: 77, raw: '77',
        prev: { value: 0, raw: '0', date: '2026-09-14' },
      }],
    })
    const change = advisableChanges(view)[0]
    expect(change?.percent).toBeUndefined()
    expect(basisLine(change as never)).toContain('涨了')
  })

  it('日期说成人话', () => {
    expect(friendlyDate('2026-09-14')).toBe('9 月 14 日')
    expect(friendlyDate('不是日期')).toBe('不是日期')
  })

  it('提示词里明写着"数字已经算好了,你不要再算"', () => {
    const prompt = buildAdvicePrompt('近 7 日', advisableChanges(rangeView()))
    expect(prompt).toContain('你不要再算、也不要改写任何数字')
    expect(prompt).toContain('impressions(曝光数)')
    // 没有环比的指标不在清单里 —— 模型看不见它,也就编不出来。
    expect(prompt).not.toContain('likes(点赞数)')
  })
})

describe('把模型回的那几行读成结构', () => {
  const allowed = ['impressions', 'cover_ctr']

  it('正常三行', () => {
    const drafts = parseAdviceReply('impressions|换一个更具体的选题角度\ncover_ctr|封面上把主体放大', allowed)
    expect(drafts).toEqual([
      { key: 'impressions', text: '换一个更具体的选题角度' },
      { key: 'cover_ctr', text: '封面上把主体放大' },
    ])
  })

  it('宽容全角竖线与行首的「- 」', () => {
    expect(parseAdviceReply('- impressions｜试试短一点的标题', allowed).length).toBe(1)
  })

  it('★模型编了一个清单里没有的指标:整条丢掉', () => {
    const drafts = parseAdviceReply('gmv|多带货\nimpressions|换个角度', allowed)
    expect(drafts.map(draft => draft.key)).toEqual(['impressions'])
  })

  it('★读不成这个格式的行一律丢掉,不把自由发挥贴到界面上', () => {
    expect(parseAdviceReply('好的,我来给你三条建议:\n\n首先呢……', allowed)).toEqual([])
  })

  it('同一个指标只收第一条', () => {
    const drafts = parseAdviceReply('impressions|甲\nimpressions|乙', allowed)
    expect(drafts.length).toBe(1)
  })

  it('最多三条', () => {
    const many = ['a', 'b', 'c', 'd'].map(x => `impressions|${x}`).join('\n')
    expect(parseAdviceReply(many, allowed).length).toBe(1)
  })
})

describe('composeAdvice + 例程那一下', () => {
  it('每条建议都配着一行代码算出来的依据', () => {
    const changes = advisableChanges(rangeView())
    const advice = composeAdvice(
      [{ key: 'impressions', text: '换一个更具体的选题角度' }],
      changes, '近 7 日', '2026-09-21T02:05:00.000Z',
    )
    expect(advice?.items).toEqual([{
      text: '换一个更具体的选题角度',
      basis: '曝光数 9.9万 → 7.7万(-22%,对 9 月 14 日那一份)',
    }])
  })

  it('一条都没成型就整块缺席(空着的「事务官的建议」比没有更糟)', () => {
    expect(composeAdvice([], advisableChanges(rangeView()), '近 7 日', 'x')).toBeUndefined()
  })

  it('★没数据就不生成 —— 连模型都不调', async () => {
    let called = 0
    const { service } = await makeService({
      chat: async () => { called++; return 'impressions|随便' },
      home: [new Error('打不开')],
      notes: [new Error('打不开')],
    })
    const result = await service.runForRoutine()
    expect(result.advice).toBe(false)
    expect(called).toBe(0)
    expect(service.view().advice).toBeUndefined()
  })

  it('★只有一期数据(没有上一期)时也不生成', async () => {
    const { service } = await makeService({ chat: async () => 'impressions|随便' })
    const result = await service.runForRoutine()
    expect(result.collected.ok).toBe(true)
    expect(result.advice).toBe(false)
  })

  it('两期都有了才生成,并且写进盘里', async () => {
    let nowMs = new Date(2026, 8, 15, 10, 0, 0).getTime()
    const prompts: string[] = []
    const { service } = await makeService({
      nowMs: () => nowMs,
      chat: async (prompt) => { prompts.push(prompt); return 'impressions|下一条把选题收窄到一个具体场景' },
      home: [homePage(), homePage(XHS_HOME_PAGE_TEXT.replace('1,111', '888'))],
    })
    await service.collect('routine')
    nowMs = new Date(2026, 8, 22, 10, 0, 0).getTime()
    const result = await service.runForRoutine()

    expect(result.advice).toBe(true)
    expect(prompts.length).toBe(1)
    const advice = service.view().advice
    expect(advice?.range).toBe('近 7 日')
    expect(advice?.items[0]?.text).toBe('下一条把选题收窄到一个具体场景')
    expect(advice?.items[0]?.basis).toContain('曝光数 1,111 → 888')
  })

  it('模型那头挂了不影响自取的结果(建议缺席,数照样进盘)', async () => {
    let nowMs = new Date(2026, 8, 15, 10, 0, 0).getTime()
    const { service } = await makeService({
      nowMs: () => nowMs,
      chat: async () => { throw new Error('中转连不上') },
      home: [homePage(), homePage(XHS_HOME_PAGE_TEXT.replace('1,111', '888'))],
    })
    await service.collect('routine')
    nowMs = new Date(2026, 8, 22, 10, 0, 0).getTime()
    const result = await service.runForRoutine()
    expect(result.collected.ok).toBe(true)
    expect(result.advice).toBe(false)
    expect(service.view().ranges.length).toBe(2)
  })
})

/**
 * 「打开一页、等它稳下来、把字读回来」那一段(src/server/xhsBrowser.ts 的 readPageWith)。
 *
 * ★ 这一份钉的是**风控自保里最实在的一条**:这条路只发 `Page.navigate` 与
 * `Runtime.evaluate`,读的三个表达式都是只读的 —— 没有点击、没有表单、没有 XHR、
 * 也没有一行碰 cookie / localStorage。
 */
describe('readPageWith:只读,而且等页面稳下来', () => {
  const sleep = async () => {}

  function fakeCdp(texts: string[], href = XHS_DEFAULT_D7_URL) {
    const calls: { method: string, expression?: string }[] = []
    const queue = [...texts]
    const call = async (method: string, params: unknown) => {
      const expression = method === 'Runtime.evaluate'
        ? String((params as { expression: string }).expression)
        : undefined
      calls.push({ method, ...(expression === undefined ? {} : { expression }) })
      if (expression === 'location.href') return { result: { value: href } }
      if (expression === 'document.title') return { result: { value: '数据中心' } }
      if (expression?.startsWith('document.body')) return { result: { value: queue.shift() ?? queue.at(-1) ?? '' } }
      return {}
    }
    return { call, calls }
  }

  it('连着两拍读到一样的文字就算稳了,把那一份交出去', async () => {
    const { call } = fakeCdp(['', '骨架屏', '真页面', '真页面'])
    const read = await readPageWith(call, XHS_DEFAULT_D7_URL, sleep)
    expect(read.text).toBe('真页面')
    expect(read.href).toBe(XHS_DEFAULT_D7_URL)
    expect(read.title).toBe('数据中心')
  })

  it('★一共只发两种 DevTools 调用,三个表达式全是只读的', async () => {
    const { call, calls } = fakeCdp(['一样', '一样'])
    await readPageWith(call, XHS_DEFAULT_D7_URL, sleep)
    expect([...new Set(calls.map(item => item.method))].sort()).toEqual(['Page.navigate', 'Runtime.evaluate'])
    const expressions = [...new Set(calls.map(item => item.expression).filter(Boolean))]
    expect(expressions.sort()).toEqual([
      'document.body ? document.body.innerText : ""',
      'document.title',
      'location.href',
    ])
  })

  it('★一行都不碰 cookie / localStorage / sessionStorage,也不点任何东西', async () => {
    const { call, calls } = fakeCdp(['一样', '一样'])
    await readPageWith(call, XHS_DEFAULT_D7_URL, sleep)
    const all = calls.map(item => `${item.method} ${item.expression ?? ''}`).join('\n')
    for (const word of ['cookie', 'localStorage', 'sessionStorage', 'Input.', 'DOM.', 'Network.']) {
      expect(all).not.toContain(word)
    }
  })

  it('页面一直不稳时等到上限就把此刻那一份交出去(由解析器去判它是不是骨架屏)', async () => {
    const { call } = fakeCdp(['甲', '乙', '丙', '丁', '戊'])
    const read = await readPageWith(call, XHS_DEFAULT_D7_URL, sleep, 2_400)
    expect(read.text).toBe('丙')
  })
})

/**
 * 切范围那一下(2026-09-22)。**这是这条路上唯一一个会改变页面的动作**,
 * 所以它的边界要被钉死:点什么、怎么确认、确认不了怎么办。
 */
describe('readPageWith:切「近30日」', () => {
  const sleep = async () => {}

  /** 一个会"点了就换一份文字"的假页面。 */
  function switchableCdp(before: string, after: string | undefined) {
    const calls: { method: string, expression?: string }[] = []
    let text = before
    const call = async (method: string, params: unknown) => {
      const expression = method === 'Runtime.evaluate'
        ? String((params as { expression: string }).expression)
        : undefined
      calls.push({ method, ...(expression === undefined ? {} : { expression }) })
      if (expression === 'location.href') return { result: { value: XHS_HOME_URL } }
      if (expression === 'document.title') return { result: { value: '创作服务平台' } }
      if (expression?.startsWith('document.body')) return { result: { value: text } }
      if (expression?.includes('el.click()')) {
        if (after === undefined) return { result: { value: 'no-button' } }
        text = after
        return { result: { value: 'clicked' } }
      }
      return {}
    }
    return { call, calls }
  }

  it('点着了、而且「统计周期」那一行变了 → 算切成功,交出来的是新那一份', async () => {
    const { call } = switchableCdp(XHS_HOME_PAGE_TEXT, XHS_HOME_PAGE_D30_TEXT)
    const read = await readPageWith(call, XHS_HOME_URL, sleep, 12_000, ['近30日'])
    expect(read.switch_clicked).toBe(true)
    expect(read.switch_confirmed).toBe(true)
    expect(read.text).toContain('统计周期 08-23 至 09-21')
  })

  it('★点着了、但那一行没变 → **不算切成功**(上层据此不存那一份)', async () => {
    const { call } = switchableCdp(XHS_HOME_PAGE_TEXT, XHS_HOME_PAGE_TEXT)
    const read = await readPageWith(call, XHS_HOME_URL, sleep, 2_400, ['近30日'])
    expect(read.switch_clicked).toBe(true)
    expect(read.switch_confirmed).toBe(false)
  })

  it('★页面上压根找不到那颗按钮 → 如实说没点着,不退而求其次点个差不多的', async () => {
    const { call } = switchableCdp(XHS_HOME_PAGE_TEXT, undefined)
    const read = await readPageWith(call, XHS_HOME_URL, sleep, 2_400, ['近30日'])
    expect(read.switch_clicked).toBe(false)
    expect(read.switch_confirmed).toBe(false)
  })

  it('不传 switchTo 就一个字都不点(与 9/21 那一版逐字相同)', async () => {
    const { call, calls } = switchableCdp(XHS_HOME_PAGE_TEXT, XHS_HOME_PAGE_D30_TEXT)
    const read = await readPageWith(call, XHS_HOME_URL, sleep)
    expect(read.switch_clicked).toBeUndefined()
    expect(calls.every(item => item.expression?.includes('click') !== true)).toBe(true)
  })

  it('★那一下点击只认**完全等于**候选文字的元素,而且只点看得见的', () => {
    const expression = rangeSwitchExpression(['近30日'])
    // 完全相等,不是 includes —— includes 会撞上「近30日数据」这类长句。
    expect(expression).toContain('want.indexOf((el.textContent || \'\').trim()) >= 0')
    expect(expression).toContain('getClientRects().length > 0')
    // 一个都没找到就回 no-button,不点别的。
    expect(expression).toContain("return 'no-button'")
  })

  it('★切范围也没有引入任何碰凭据的调用', async () => {
    const { call, calls } = switchableCdp(XHS_HOME_PAGE_TEXT, XHS_HOME_PAGE_D30_TEXT)
    await readPageWith(call, XHS_HOME_URL, sleep, 12_000, ['近30日'])
    expect([...new Set(calls.map(item => item.method))].sort()).toEqual(['Page.navigate', 'Runtime.evaluate'])
    const all = calls.map(item => `${item.method} ${item.expression ?? ''}`).join('\n')
    for (const word of ['cookie', 'localStorage', 'sessionStorage', 'Input.', 'DOM.', 'Network.']) {
      expect(all).not.toContain(word)
    }
  })
})

// ———————————————————————— 2026-09-30:登录完就自己取一轮(维护者 Air 真机) ————————————————————————
//
// 现场:「小红书能打开网页,也登录上了,但是登录之后,数据没有登记进来」。
// 以前登录只是开个窗口,取数只在他点「刷新」或早报前那一下跑 —— 登完什么都不发生。
// 现在:开了登录窗口就每隔一会儿**只看一眼那个窗口此刻开着哪个地址**(不跳转、不点),
// 看见它离开了登录页、停在创作者中心,就取一轮(触发者记 'login',不受 10 分钟那道闸拦)。

describe('登录完就自己取一轮', () => {
  function watching(urls: (string[] | Error)[]) {
    const queue = [...urls]
    return async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next === undefined || next instanceof Error) throw next ?? new Error('登录窗口没开着')
      return next
    }
  }

  it('★还在登录页 → 不取;离开登录页、停在创作者中心 → 取一轮,记成「登录后」', async () => {
    const { service, browser } = await makeService()
    const loginUrl = 'https://creator.xiaohongshu.com/login?redirectReason=401'
    ;(browser as XhsBrowser).currentUrls = watching([[loginUrl], [loginUrl], [XHS_HOME_URL]])
    const done = service.startLogin(1, { pollMs: 0, maxMs: 60_000, sleep: async () => {} })
    await done
    await service.loginWatchDone?.()
    expect(browser.read.length).toBeGreaterThan(0)
    const last = service.view().fetches.at(-1)
    expect(last?.trigger).toBe('login')
    expect(last?.ok).toBe(true)
  })

  it('窗口被关掉了 → 不再看,也不取', async () => {
    const { service, browser } = await makeService()
    ;(browser as XhsBrowser).currentUrls = watching([new Error('登录窗口没开着')])
    await service.startLogin(1, { pollMs: 0, maxMs: 60_000, sleep: async () => {} })
    await service.loginWatchDone?.()
    expect(browser.read).toEqual([])
    expect(service.view().fetches).toEqual([])
  })

  it('刚手动刷新过(10 分钟那道闸)也照样取:登录完那一下是他在等的', async () => {
    const { service, browser } = await makeService()
    await service.collect('manual')
    const before = browser.read.length
    ;(browser as XhsBrowser).currentUrls = watching([[XHS_HOME_URL]])
    await service.startLogin(1, { pollMs: 0, maxMs: 60_000, sleep: async () => {} })
    await service.loginWatchDone?.()
    expect(browser.read.length).toBeGreaterThan(before)
  })
})
