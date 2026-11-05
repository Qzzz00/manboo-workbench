// @vitest-environment node
/**
 * 三件主路与首次引导的共享口径(2026-10-21,卡「引导三件事」;设计 `docs/设计-拿得出手-三件事与首次引导-2026-10-15.md`)。
 *
 * 钉的是电脑、手机、安装器三处要说同一句的那几样:三件是哪三件、先试哪件怎么认、顺序、缺哪道门怎么说、
 * 自检那一行怎么写(**不许出现「都好了」**)、实验开关的默认、首页那张「现在能做什么」。
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_GOOD_WORDS,
  EXPERIMENT_KEYS,
  EXPERIMENT_OFF_LINE,
  FIRST_TRY_ASK,
  FIRST_USE_SAY,
  MAIN_PATHS,
  MAIN_PATH_TITLES,
  audienceOf,
  capabilityRows,
  doorView,
  experimentOfUnderstanding,
  experimentsOf,
  firstTryOf,
  firstUseOrder,
  selfCheckLine,
  selfCheckSummary,
  windowDispatchExperiment,
} from '../src/mainPaths.ts'

describe('三件主路', () => {
  it('就是早报、交代、电话三件,顺序固定', () => {
    expect(MAIN_PATHS).toEqual(['morning', 'delegate', 'call'])
    expect(MAIN_PATH_TITLES).toEqual({ morning: '早报与播客', delegate: '交代一件事', call: '打个电话' })
  })

  it('先试哪一件那一问逐字照设计稿', () => {
    expect(FIRST_TRY_ASK).toBe('想先试哪一件:早报、交代一件事?')
  })

  it('认得她答的那一句:按钮的 id、或她说的话', () => {
    expect(firstTryOf('morning')).toBe('morning')
    expect(firstTryOf('早报')).toBe('morning')
    expect(firstTryOf('先听听播客吧')).toBe('morning')
    expect(firstTryOf('交代一件事')).toBe('delegate')
    expect(firstTryOf('我想派个活')).toBe('delegate')
    expect(firstTryOf('打个电话')).toBe('call')
    expect(firstTryOf('电话')).toBe('call')
  })

  it('不答 / 都行 / 认不出 = 没选,按默认顺序', () => {
    expect(firstTryOf(undefined)).toBeUndefined()
    expect(firstTryOf('')).toBeUndefined()
    expect(firstTryOf('都行')).toBeUndefined()
    expect(firstTryOf('随便')).toBeUndefined()
    expect(firstTryOf(42)).toBeUndefined()
  })

  it('答了哪件就排第一,其余照「早报 → 交代 → 电话」', () => {
    expect(firstUseOrder(undefined)).toEqual(['morning', 'delegate', 'call'])
    expect(firstUseOrder('call')).toEqual(['call', 'morning', 'delegate'])
    expect(firstUseOrder('delegate')).toEqual(['delegate', 'morning', 'call'])
    expect(firstUseOrder('morning')).toEqual(['morning', 'delegate', 'call'])
  })

  it('第一次有用那几句话逐字照设计稿', () => {
    expect(FIRST_USE_SAY.morning).toBe('我先把今天的资讯整理成早报,一分钟。')
    expect(FIRST_USE_SAY.delegate).toBe('挑一件你手上的事,交给我试试;没想好就让我把这个项目介绍一遍。')
    expect(FIRST_USE_SAY.call).toBe('手机上拨给我一下。')
    expect(FIRST_USE_SAY.closing).toBe('三样都通了,剩下的用到时我再问。')
    // 没配手机(iPhone / 没手机)那一版:第三件换成在电脑上对她说一句。
    expect(FIRST_USE_SAY.call_desk).toContain('电脑')
  })
})

describe('缺哪道门', () => {
  it('每道门一句人话;能一颗键修的给键', () => {
    const login = doorView('ai_login', { families: [{ family: 'claude', title: 'Claude' }, { family: 'codex', title: 'Codex' }] })
    expect(login.text).toContain('先登录 Claude 或 Codex 其中一家')
    expect(login.fixes.map(one => one.label)).toEqual(['登录 Claude', '登录 Codex'])
    expect(login.fixes.every(one => one.kind === 'login_cli')).toBe(true)

    const phone = doorView('phone')
    expect(phone.text).toContain('配对码')
    expect(phone.fixes[0]?.kind).toBe('pair')

    const model = doorView('model')
    expect(model.title).toBe('缺模型钥匙')
    expect(model.fixes[0]?.kind).toBe('model')
    // 用例跑的是开源缺省(构建不带中转):没有账号可登,只说填自己的钥匙(2026-10-21)。
    expect(model.text).not.toContain('登录')
    expect(model.text).toContain('自己的 DeepSeek 密钥')
  })

  it('认不出的原因原话带上,不编', () => {
    const other = doorView('other', { note: 'Codex 回了 429' })
    expect(other.text).toContain('Codex 回了 429')
    expect(other.fixes).toEqual([])
  })

  it('一家都没装时不给登录键,只说先装哪一家', () => {
    const missing = doorView('ai_missing')
    expect(missing.text).toContain('Claude 或 Codex')
    expect(missing.fixes).toEqual([])
  })
})

describe('安装器末尾那三行', () => {
  it('成 / 没成 + 缺哪道门,一行一件', () => {
    expect(selfCheckLine({ path: 'morning', state: 'ok' })).toBe('早报与播客:成')
    expect(selfCheckLine({ path: 'delegate', state: 'missing', door: doorView('ai_login', { families: [{ family: 'claude', title: 'Claude' }] }) }))
      .toBe('交代一件事:没成 —— 没登录 Claude 或 Codex。先登录 Claude 或 Codex 其中一家(点「登录 Claude」)。')
    expect(selfCheckLine({ path: 'call', state: 'missing', door: doorView('phone') })).toMatch(/^打个电话:没成 —— 手机没配对。/)
    expect(selfCheckLine({ path: 'delegate', state: 'pending', note: '派给 Codex 了' })).toBe('交代一件事:在路上 —— 派给 Codex 了,结果回来会出现在卡上')
  })

  it('三样都成也只说三样都成,绝不说「都好了」', () => {
    const rows = MAIN_PATHS.map(path => ({ path, state: 'ok' as const }))
    const summary = selfCheckSummary(rows)
    expect(summary).toBe('三件都试过了,都成。')
    for (const word of ALL_GOOD_WORDS) expect(summary).not.toContain(word)
  })

  it('有没成的就数出来、点名是哪几件', () => {
    const summary = selfCheckSummary([
      { path: 'morning', state: 'ok' },
      { path: 'delegate', state: 'missing', door: doorView('ai_login') },
      { path: 'call', state: 'missing', door: doorView('phone') },
    ])
    expect(summary).toBe('三件里成了 1 件;交代一件事、打个电话还差一步,见下面。')
  })
})

describe('实验开关', () => {
  it('四样:视频链、会议录音转纪要、座机硬件、读窗派活到豆包 / Kimi', () => {
    expect(EXPERIMENT_KEYS).toEqual(['video', 'meeting', 'handset', 'window_dispatch'])
  })

  it('内部默认开、外部默认关;存过的照存的', () => {
    expect(experimentsOf(undefined, 'internal')).toEqual({ video: true, meeting: true, handset: true, window_dispatch: true })
    expect(experimentsOf(undefined, 'external')).toEqual({ video: false, meeting: false, handset: false, window_dispatch: false })
    expect(experimentsOf({ meeting: true }, 'external')).toEqual({ video: false, meeting: true, handset: false, window_dispatch: false })
    expect(experimentsOf({ video: false }, 'internal').video).toBe(false)
  })

  it('内部还是外部:环境变量 > 存的 > 有源码仓库的机器算内部 > 外部', () => {
    expect(audienceOf({ env: 'internal', saved: 'external', sourceRepo: false })).toBe('internal')
    expect(audienceOf({ saved: 'internal', sourceRepo: false })).toBe('internal')
    expect(audienceOf({ sourceRepo: true })).toBe('internal')
    expect(audienceOf({ sourceRepo: false })).toBe('external')
    expect(audienceOf({ env: 'nonsense', sourceRepo: false })).toBe('external')
  })

  it('关着时说的那一句', () => {
    expect(EXPERIMENT_OFF_LINE).toBe('这一类还在内测,我先不接。')
  })

  it('认话认出来的哪一类归哪个开关', () => {
    expect(experimentOfUnderstanding('video')).toBe('video')
    expect(experimentOfUnderstanding('meeting_plan')).toBe('meeting')
    expect(experimentOfUnderstanding('dispatch')).toBeUndefined()
    expect(experimentOfUnderstanding('none')).toBeUndefined()
  })

  it('读窗派活只管豆包与 Kimi;Claude / Codex 是协议路,不归它', () => {
    expect(windowDispatchExperiment('doubao')).toBe(true)
    expect(windowDispatchExperiment('kimi')).toBe(true)
    expect(windowDispatchExperiment('claude')).toBe(false)
    expect(windowDispatchExperiment('codex')).toBe(false)
  })
})

describe('首页那张「现在能做什么」', () => {
  it('三件主路各一行,实验里的几样标「内测中」', () => {
    const rows = capabilityRows({
      paths: [
        { path: 'morning', state: 'ok' },
        { path: 'delegate', state: 'missing', door: doorView('ai_login', { families: [{ family: 'codex', title: 'Codex' }] }) },
        { path: 'call', state: 'todo' },
      ],
      experiments: { video: true, meeting: false, handset: true, window_dispatch: false },
    })
    expect(rows.map(one => one.title)).toEqual([
      '早报与播客', '交代一件事', '打个电话',
      '视频(豆包出图 → 可灵出片)', '会议录音转纪要', '座机听筒', '派活到豆包 / Kimi(读窗口)',
    ])
    expect(rows[0]).toMatchObject({ kind: 'main', state: 'ok', line: '通了' })
    expect(rows[1]).toMatchObject({ kind: 'main', state: 'missing' })
    expect(rows[1]?.line).toContain('没登录 Claude 或 Codex')
    expect(rows[2]).toMatchObject({ kind: 'main', state: 'todo', line: '还没试过' })
    expect(rows[3]).toMatchObject({ kind: 'beta', state: 'on', line: '内测中' })
    expect(rows[4]).toMatchObject({ kind: 'beta', state: 'off', line: '内测中 · 没开' })
  })
})

describe('认不出原因的那一行', () => {
  it('直接说原话,不念「没成 —— 没成」', () => {
    expect(selfCheckLine({ path: 'morning', state: 'missing', door: doorView('other', { note: '例程写不进记忆' }) })).toBe('早报与播客:没成 —— 例程写不进记忆。')
  })
})
