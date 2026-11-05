// @vitest-environment node
/**
 * 落盘与保留期(src/server/xhsStore.ts)。
 *
 * 守的是三件"错了看不出来"的事:90 天的边界、环比跟哪一天比、
 * 以及**上一周期没有时绝不拿别的天凑**。
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  XHS_KEEP_DAYS, XHS_RANGE_KEY,
  accountOf, appendFetchLog, buildRangeView, buildRangeViews, emptyXhsFile, lastOkAt, lastOkLine,
  latestDate, loadXhsFile, previousSnapshot, pruneDays, putSnapshot, saveXhsFile, shiftDate,
  upsertAccount, xhsDateStr,
} from '../src/server/xhsStore.ts'
import { XHS_PROFILE_NAME } from '../src/server/xhsAccount.ts'
import type { XhsDays } from '../src/server/xhsStore.ts'
import type { XhsFetchLogView } from '../src/protocol.ts'

/** 夹具里的数字全是编的(与解析器那份夹具同一条纪律)。 */
function snap(at: string, over: Record<string, { value: number, raw: string }> = {}) {
  return { at, metrics: { views: { value: 11_000, raw: '1.1万' }, ...over } }
}

const day = (date: string) => `${date}T02:00:00.000Z`

describe('日期', () => {
  it('xhsDateStr 走本地日历,不拿 toISOString 切天', () => {
    // 东八区 2026-09-21 00:30 —— toISOString().slice(0,10) 会给成 09-20。
    const local = new Date(2026, 8, 21, 0, 30).getTime()
    expect(xhsDateStr(local)).toBe('2026-09-21')
  })

  it('shiftDate 跨月跨年都对', () => {
    expect(shiftDate('2026-09-21', -7)).toBe('2026-09-14')
    expect(shiftDate('2026-09-21', -30)).toBe('2026-08-22')
    expect(shiftDate('2026-01-03', -7)).toBe('2025-12-27')
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('认不出的日期串原样回去,不抛也不猜', () => {
    expect(shiftDate('不是日期', -7)).toBe('不是日期')
  })
})

describe('保留 90 天', () => {
  const today = new Date(2026, 8, 21, 12, 0).getTime()

  it('★第 90 天留着,第 91 天丢掉(含今天数满 90)', () => {
    const days: XhsDays = {
      [shiftDate('2026-09-21', -(XHS_KEEP_DAYS - 1))]: { d7: snap(day('2026-06-24')) },
      [shiftDate('2026-09-21', -XHS_KEEP_DAYS)]: { d7: snap(day('2026-06-23')) },
      '2026-09-21': { d7: snap(day('2026-09-21')) },
    }
    const kept = Object.keys(pruneDays(days, today)).sort()
    expect(kept).toContain('2026-09-21')
    expect(kept).toContain(shiftDate('2026-09-21', -89))
    expect(kept).not.toContain(shiftDate('2026-09-21', -90))
  })

  it('★近 30 日的环比要用到 30 天前那一份 —— 保留期必须兜得住', () => {
    expect(XHS_KEEP_DAYS).toBeGreaterThan(30)
  })

  it('认不出的键一律丢(文件是可以被手改的)', () => {
    const days = { 随便写的: { d7: snap(day('2026-09-21')) }, '2026-09-21': { d7: snap(day('2026-09-21')) } }
    expect(Object.keys(pruneDays(days as XhsDays, today))).toEqual(['2026-09-21'])
  })

  it('putSnapshot:同一天同一范围覆盖,不留两份', () => {
    let days: XhsDays = {}
    days = putSnapshot(days, '2026-09-21', '近 7 日', snap(day('2026-09-21')), today)
    days = putSnapshot(days, '2026-09-21', '近 7 日', snap('2026-09-21T09:00:00.000Z'), today)
    expect(Object.keys(days['2026-09-21'] ?? {})).toEqual(['d7'])
    expect(days['2026-09-21']?.d7?.at).toBe('2026-09-21T09:00:00.000Z')
  })

  it('putSnapshot:两个范围各存各的,互不覆盖', () => {
    let days: XhsDays = {}
    days = putSnapshot(days, '2026-09-21', '近 7 日', snap(day('2026-09-21')), today)
    days = putSnapshot(days, '2026-09-21', '近 30 日', snap(day('2026-09-21')), today)
    expect(Object.keys(days['2026-09-21'] ?? {}).sort()).toEqual(['d30', 'd7'])
  })

  it('范围的机器键是稳定的 d7/d30,不拿中文文案当 key', () => {
    expect(XHS_RANGE_KEY['近 7 日']).toBe('d7')
    expect(XHS_RANGE_KEY['近 30 日']).toBe('d30')
  })
})

describe('环比:跟哪一天比', () => {
  const days: XhsDays = {
    '2026-09-21': { d7: snap(day('2026-09-21')), d30: snap(day('2026-09-21')) },
    '2026-09-14': { d7: snap(day('2026-09-14'), { views: { value: 10_000, raw: '1万' } }) },
    '2026-09-16': { d7: snap(day('2026-09-16'), { views: { value: 5_000, raw: '5千' } }) },
    '2026-08-22': { d30: snap(day('2026-08-22'), { views: { value: 8_000, raw: '8千' } }) },
  }

  it('近 7 日对的是 7 天前那一天', () => {
    expect(previousSnapshot(days, '2026-09-21', '近 7 日')?.date).toBe('2026-09-14')
  })

  it('近 30 日对的是 30 天前那一天', () => {
    expect(previousSnapshot(days, '2026-09-21', '近 30 日')?.date).toBe('2026-08-22')
  })

  it('★那一天没有快照就回 undefined —— **不拿 9-16 那份更近的凑**', () => {
    const only = { '2026-09-21': days['2026-09-21'] as never, '2026-09-16': days['2026-09-16'] as never }
    expect(previousSnapshot(only, '2026-09-21', '近 7 日')).toBeUndefined()
  })

  it('视图里 prev 带上那一天的日期(界面才能把依据说出口)', () => {
    const view = buildRangeView(days, '2026-09-21', '近 7 日')
    const views = view?.metrics.find(metric => metric.key === 'views')
    expect(views?.value).toBe(11_000)
    expect(views?.prev).toEqual({ value: 10_000, raw: '1万', date: '2026-09-14' })
  })

  it('★本期这一项没取到时不画箭头(「上期有、本期没有」不是下降)', () => {
    const missing: XhsDays = {
      '2026-09-21': { d7: { at: day('2026-09-21'), metrics: {} } },
      '2026-09-14': { d7: snap(day('2026-09-14')) },
    }
    const view = buildRangeView(missing, '2026-09-21', '近 7 日')
    const views = view?.metrics.find(metric => metric.key === 'views')
    expect(views?.value).toBeUndefined()
    expect(views?.prev).toBeUndefined()
  })

  it('★八格永远都在,取不到的那几格只是没有 value(界面说「后台没有这项」)', () => {
    const view = buildRangeView(days, '2026-09-21', '近 7 日')
    expect(view?.metrics.length).toBe(8)
    expect(view?.metrics.filter(metric => metric.value === undefined).length).toBe(7)
  })

  it('那一天那个范围压根没存过就回 undefined(而不是一份空视图)', () => {
    expect(buildRangeView(days, '2026-09-14', '近 30 日')).toBeUndefined()
  })
})

describe('buildRangeViews:界面拿到的是最新那一天', () => {
  it('一次都没取过回空数组', () => {
    expect(buildRangeViews({})).toEqual([])
    expect(latestDate({})).toBeUndefined()
  })

  it('取最新那一天,取不到的那个范围缺席', () => {
    const days: XhsDays = {
      '2026-09-20': { d7: snap(day('2026-09-20')), d30: snap(day('2026-09-20')) },
      '2026-09-21': { d7: snap(day('2026-09-21')) },
    }
    expect(latestDate(days)).toBe('2026-09-21')
    expect(buildRangeViews(days).map(view => view.range)).toEqual(['近 7 日'])
  })
})

describe('自取记录', () => {
  const log = (at: string, ok: boolean): XhsFetchLogView =>
    ({ at, ok, got: ok ? 8 : 0, total: 8, trigger: 'manual' })

  it('新的在前,超过上限砍掉最旧的', () => {
    let logs: XhsFetchLogView[] = [log(day('2026-09-19'), true)]
    logs = appendFetchLog(logs, log(day('2026-09-20'), false), 2)
    logs = appendFetchLog(logs, log(day('2026-09-21'), true), 2)
    expect(logs.map(item => item.at)).toEqual([day('2026-09-21'), day('2026-09-20')])
  })

  it('lastOkAt 只认成功那几条', () => {
    const logs = [log(day('2026-09-21'), false), log(day('2026-09-20'), true)]
    expect(lastOkAt(logs)).toBe(day('2026-09-20'))
  })

  it('★从没成功过时不说「0 小时前」,整句缺席', () => {
    expect(lastOkLine([log(day('2026-09-21'), false)], Date.now())).toBeUndefined()
    expect(lastOkLine([], Date.now())).toBeUndefined()
  })

  it('小时 / 天的说法', () => {
    const base = Date.parse('2026-09-21T12:00:00.000Z')
    expect(lastOkLine([log('2026-09-21T09:00:00.000Z', true)], base)).toBe('上次成功 3 小时前')
    expect(lastOkLine([log('2026-09-21T11:30:00.000Z', true)], base)).toBe('上次成功 30 分钟前')
    expect(lastOkLine([log('2026-09-18T12:00:00.000Z', true)], base)).toBe('上次成功 3 天前')
  })
})

describe('读写', () => {
  it('没有文件 / 文件坏了一律回空,不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhs-'))
    expect(await loadXhsFile(join(dir, '不存在.json'))).toEqual(emptyXhsFile())
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{ 这不是 json')
    expect(await loadXhsFile(broken)).toEqual(emptyXhsFile())
  })

  it('★写出来的文件是 0600(里面是他自己后台的数)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhs-'))
    const file = join(dir, 'sub', 'xhs-metrics.json')
    await saveXhsFile(file, emptyXhsFile())
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    // 已存在的文件也要收一次。
    await saveXhsFile(file, emptyXhsFile())
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('★落盘里一个凭据字段都没有(登录态只在那个 Chrome 档案里)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhs-'))
    const file = join(dir, 'xhs-metrics.json')
    const today = Date.now()
    const data = emptyXhsFile()
    data.accounts = [{
      profile: XHS_PROFILE_NAME,
      index: 1,
      name: '假昵称·用例用的',
      uid: '1234567890',
      days: putSnapshot({}, xhsDateStr(today), '近 7 日', snap(new Date(today).toISOString()), today),
    }]
    await saveXhsFile(file, data)
    const text = await readFile(file, 'utf8')
    for (const word of ['cookie', 'Cookie', 'token', 'Token', 'authorization', 'web_session', 'password']) {
      expect(text).not.toContain(word)
    }
    expect((await loadXhsFile(file)).accounts[0]?.name).toBe('假昵称·用例用的')
  })
})

/**
 * 2026-09-22:落盘从「一个账号摊在最外层」改成「accounts[] 按账号分开」。
 * 这一组钉的是**存量一天不丢**:v1 那一份读进来之后属于第一个档案,Ben 不用重登。
 */
describe('v1 → v2 迁移', () => {
  it('★v1 的 days / nickname 原样搬进第一个档案', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhs-'))
    const file = join(dir, 'xhs-metrics.json')
    const today = Date.now()
    const days = putSnapshot({}, xhsDateStr(today), '近 7 日', snap(new Date(today).toISOString()), today)
    await writeFile(file, JSON.stringify({ version: 1, days, fetches: [], nickname: '老昵称' }))

    const loaded = await loadXhsFile(file)
    expect(loaded.version).toBe(2)
    expect(loaded.accounts.length).toBe(1)
    expect(loaded.accounts[0]?.profile).toBe(XHS_PROFILE_NAME)
    expect(loaded.accounts[0]?.index).toBe(1)
    expect(loaded.accounts[0]?.name).toBe('老昵称')
    expect(loaded.accounts[0]?.days).toEqual(days)
  })

  it('v1 里一天快照都没有、也没昵称 → 不凭空造一个账号出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhs-'))
    const file = join(dir, 'xhs-metrics.json')
    await writeFile(file, JSON.stringify({ version: 1, days: {}, fetches: [] }))
    expect((await loadXhsFile(file)).accounts).toEqual([])
  })

  it('upsertAccount:第二次写只补不覆盖 —— 这一次没读到名字就留着上一次那个', () => {
    let file = emptyXhsFile()
    file = upsertAccount(file, { profile: XHS_PROFILE_NAME, index: 1, name: '甲', days: {} })
    file = upsertAccount(file, { profile: XHS_PROFILE_NAME, index: 1, days: { '2026-09-22': {} } })
    expect(file.accounts.length).toBe(1)
    expect(file.accounts[0]?.name).toBe('甲')
    expect(file.accounts[0]?.days).toEqual({ '2026-09-22': {} })
  })

  it('upsertAccount:按档案序号排,不按写进来的先后', () => {
    let file = emptyXhsFile()
    file = upsertAccount(file, { profile: 'login-profile-xhs_creator-2', index: 2, days: {} })
    file = upsertAccount(file, { profile: XHS_PROFILE_NAME, index: 1, days: {} })
    expect(file.accounts.map(account => account.index)).toEqual([1, 2])
    expect(accountOf(file, XHS_PROFILE_NAME)?.index).toBe(1)
  })
})
