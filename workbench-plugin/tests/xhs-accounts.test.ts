// @vitest-environment node
/**
 * 多账号(2026-09-22):一个账号一个浏览器档案,数据按账号分开存,界面上每个账号一行 + 合计一行。
 *
 * 依据:Ben 原话「我想直接验证多账号的数据汇总,现在你打开的网页已经登录好一个了,
 * 再开一个纯净的,我登录第二个账号」。
 *
 * 这一份守两件事:
 * 1. **归属**:一份数是谁的,只认从首页读回来的账号名与「小红书账号」id;
 * 2. **合计**:能加的加,比率按曝光加权,**少一个账号就整格空着**(不是"把有的加起来")。
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  XHS_PROFILE_NAME, accountDisplayName, accountIdentityFrom, listXhsProfiles,
  xhsProfileIndex, xhsProfileName,
} from '../src/server/xhsAccount.ts'
import {
  XHS_TOTAL_DERIVED, XHS_TOTAL_WEIGHTED, formatTotalCount, mergeDaysForTotal, totalSnapshotOf,
} from '../src/server/xhsTotal.ts'
import type { XhsDays, XhsSnapshot } from '../src/server/xhsStore.ts'
import { buildRangeView } from '../src/server/xhsStore.ts'
import { XHS_HOME_PAGE_B_TEXT, XHS_HOME_PAGE_TEXT, XHS_LOGIN_PAGE_TEXT } from './xhsPageFixtures.ts'

describe('档案命名:第一个不改名', () => {
  it('★第 1 个就是 9/21 那一版那个名字 —— 改了 Ben 要重登一次', () => {
    expect(xhsProfileName(1)).toBe('login-profile-xhs_creator')
    expect(XHS_PROFILE_NAME).toBe('login-profile-xhs_creator')
  })

  it('第 2、3 个带后缀', () => {
    expect(xhsProfileName(2)).toBe('login-profile-xhs_creator-2')
    expect(xhsProfileName(3)).toBe('login-profile-xhs_creator-3')
  })

  it('反过来认得回去;别人的档案一概不认', () => {
    expect(xhsProfileIndex('login-profile-xhs_creator')).toBe(1)
    expect(xhsProfileIndex('login-profile-xhs_creator-2')).toBe(2)
    expect(xhsProfileIndex('login-profile-kimi_web')).toBeUndefined()
    expect(xhsProfileIndex('login-profile-xhs_creator-0')).toBeUndefined()
    expect(xhsProfileIndex('login-profile-xhs_creator-x')).toBeUndefined()
  })
})

describe('listXhsProfiles:盘上现在有哪几个档案', () => {
  it('只看目录名,按序号排;别的目录一概不数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-profiles-'))
    await mkdir(join(root, 'login-profile-xhs_creator'))
    await mkdir(join(root, 'login-profile-xhs_creator-2'))
    await mkdir(join(root, 'login-profile-kimi_web'))
    expect(await listXhsProfiles(root)).toEqual([1, 2])
  })

  it('目录不存在 = 还没登过,回空数组而不是抛', async () => {
    expect(await listXhsProfiles(join(tmpdir(), '不存在的目录-xhs'))).toEqual([])
  })
})

describe('accountIdentityFrom:这份数是谁的', () => {
  it('从真版面读到账号名与 id(夹具里两样都是编的)', () => {
    expect(accountIdentityFrom(XHS_HOME_PAGE_TEXT)).toEqual({ name: '测试号甲', uid: '1234567890' })
    expect(accountIdentityFrom(XHS_HOME_PAGE_B_TEXT)).toEqual({ name: '测试号乙', uid: '9876543210' })
  })

  it('★不许把「获赞与收藏」那一排数字或标签当成账号名', () => {
    const identity = accountIdentityFrom(XHS_HOME_PAGE_TEXT)
    expect(identity.name).not.toBe('333')
    expect(identity.name).not.toBe('获赞与收藏')
  })

  it('★小红书号是字母数字混排(用户自己改过的)也认得出,名字照样从上面找', () => {
    const text = [
      '测试号丙', '账号状态正常', '12', '关注数', '1250', '粉丝数', '4816', '获赞与收藏',
      '小红书账号: Test18700000000', '一句个人简介',
    ].join('\n')
    expect(accountIdentityFrom(text)).toEqual({ name: '测试号丙', uid: 'Test18700000000' })
  })

  it('读不到就什么都不回 —— **不编一个名字**', () => {
    expect(accountIdentityFrom(XHS_LOGIN_PAGE_TEXT)).toEqual({})
  })

  it('手配的昵称标签优先于那条启发式', () => {
    const text = ['昵称：手配出来的名字', '小红书账号: 1234567890'].join('\n')
    expect(accountIdentityFrom(text, ['昵称'])).toEqual({ name: '手配出来的名字', uid: '1234567890' })
  })

  it('读不到名字时界面叫它「账号 N」,不拿档案目录名冒充昵称', () => {
    expect(accountDisplayName(2)).toBe('账号 2')
    expect(accountDisplayName(2, '测试号乙')).toBe('测试号乙')
  })
})

/** 造一份快照。`metrics` 里写「值 / 页面上原样那串」。 */
function snap(metrics: Record<string, [number, string]>): XhsSnapshot {
  return {
    at: '2026-09-22T01:00:00.000Z',
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, [value, raw]]) => [key, { value, raw }]),
    ) as XhsSnapshot['metrics'],
  }
}

describe('合计:能加的加,不能加的空着', () => {
  it('计数直接加,并且自报家门「合计」', () => {
    const total = totalSnapshotOf([
      snap({ impressions: [1000, '1,000'], likes: [9, '9'] }),
      snap({ impressions: [2000, '2,000'], likes: [1, '1'] }),
    ])
    expect(total?.metrics.impressions).toEqual({ value: 3000, raw: '3,000', derived: XHS_TOTAL_DERIVED })
    expect(total?.metrics.likes).toEqual({ value: 10, raw: '10', derived: XHS_TOTAL_DERIVED })
  })

  it('★少一个账号的那一项 → 整格缺席,不是"把有的加起来"', () => {
    const total = totalSnapshotOf([
      snap({ impressions: [1000, '1,000'], likes: [9, '9'] }),
      snap({ impressions: [2000, '2,000'] }),
    ])
    expect(total?.metrics.impressions?.value).toBe(3000)
    // 第二个号没有点赞数 —— 只报第一个的 9 会偏小,而且看不出来是错的。
    expect(total?.metrics.likes).toBeUndefined()
  })

  it('★封面点击率按曝光加权,不是算术平均', () => {
    const total = totalSnapshotOf([
      snap({ impressions: [1000, '1,000'], cover_ctr: [10, '10.0%'] }),
      snap({ impressions: [9000, '9,000'], cover_ctr: [20, '20.0%'] }),
    ])
    // 算术平均会是 15%;按曝光加权是 (10×1000 + 20×9000) / 10000 = 19%。
    expect(total?.metrics.cover_ctr).toEqual({ value: 19, raw: '19%', derived: XHS_TOTAL_WEIGHTED })
  })

  it('少了曝光数就算不了加权 → 那一格缺席', () => {
    const total = totalSnapshotOf([
      snap({ cover_ctr: [10, '10.0%'] }),
      snap({ cover_ctr: [20, '20.0%'] }),
    ])
    expect(total?.metrics.cover_ctr).toBeUndefined()
  })

  it('★时长不能加,永远缺席', () => {
    const total = totalSnapshotOf([snap({ avg_watch: [11, '00:11'] }), snap({ avg_watch: [21, '00:21'] })])
    expect(total?.metrics.avg_watch).toBeUndefined()
  })

  it('千分位是我们自己排的,不走 toLocaleString(那一串跟着机器的 ICU 走)', () => {
    expect(formatTotalCount(1234567)).toBe('1,234,567')
    expect(formatTotalCount(999)).toBe('999')
  })
})

describe('mergeDaysForTotal:按日合计', () => {
  const a: XhsDays = {
    '2026-09-22': { d7: snap({ impressions: [1000, '1,000'], views: [100, '100'] }) },
    '2026-09-21': { d7: snap({ impressions: [900, '900'], views: [90, '90'] }) },
  }
  const b: XhsDays = {
    '2026-09-22': { d7: snap({ impressions: [2000, '2,000'], views: [200, '200'] }) },
  }

  it('★一个账号时原样交出去:数字仍是页面上那一串,不加「合计」标', () => {
    expect(mergeDaysForTotal([a])).toEqual(a)
  })

  it('两个账号:两边都有的那天才合计', () => {
    const merged = mergeDaysForTotal([a, b])
    expect(merged['2026-09-22']?.d7?.metrics.impressions?.value).toBe(3000)
    // ★ 9-21 只有第一个号有 —— 那一天整个不出现,合计那条线在那天断掉,
    //   而不是画成"那天只有 900"。
    expect(merged['2026-09-21']).toBeUndefined()
  })

  it('合计那一行照样走 buildRangeView,所以环比、缺席的口径和单个账号完全一样', () => {
    const merged = mergeDaysForTotal([a, b])
    const view = buildRangeView(merged, '2026-09-22', '近 7 日')
    expect(view?.metrics.find(item => item.key === 'impressions')?.raw).toBe('3,000')
    expect(view?.metrics.find(item => item.key === 'impressions')?.derived).toBe(XHS_TOTAL_DERIVED)
    // 上一周期(9-15)那天没有快照 → 不画箭头。
    expect(view?.metrics.find(item => item.key === 'impressions')?.prev).toBeUndefined()
    // 平均观看时长永远空着,并且带着一句「为什么」。
    const avg = view?.metrics.find(item => item.key === 'avg_watch')
    expect(avg?.value).toBeUndefined()
    expect(avg?.why).toContain('平台没给')
  })

  it('一个账号都没有时回空', () => {
    expect(mergeDaysForTotal([])).toEqual({})
  })
})
