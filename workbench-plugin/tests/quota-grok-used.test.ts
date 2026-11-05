// @vitest-environment node
/**
 * ★ **Grok Bot 的额度按「已用」读到**(2026-10-04,卡 `claude/quota-grok-used`)。
 *
 * ## 这张卡从哪儿来
 *
 * 卡「豆包闪一下 / Grok 读键字」(`docs/交接-1003-豆包闪一下与Grok读键字.md`)把三件事量齐了:
 * 触发键叫 **`Open account menu`**(`AXPopUpButton` (16,919) 36×36)、**后台 `AXPress` 按得开**
 * (77ms、不抢焦点、读完照旧藏着,等一拍那六行才进树)、带 `include_titles` 那一行**读到了**
 * (`AXMenuItem (22,708) ['SuperGrok 0%']`)。只剩一件没查实:**「N%」是已用还是剩余**。
 *
 * 维护者 2026-10-04 答:「**是已用**」(0% = 没用过)。于是这一家从**开集**那条路搬到**窗口型**:
 *
 * - 开集那条路有一道「同一扇窗上要有旁证,只有数字的那一组一律不问模型」的门,
 *   而账号菜单那一扇窗上只有那一行 —— 那道门为一家放宽是危险的(假阳性比读不到坏);
 * - 窗口型这条路**压根不问模型**:认不认由这一家自己那条**整格相等**的正则说
 *   (`^SuperGrok\s*[0-9]{1,3}\s*%$` —— 整格就这么长、前面写着它自己的套餐名,正则自带旁证)。
 *
 * ## 这个文件钉的五组
 *
 * 1. **口径**:那个数是**已用** —— 「SuperGrok 6%」= 还剩约 94%(读反了方向就是最坏的那种假数);
 * 2. **整格相等**:聊天里提到这几个字配不上(那条正则是整格锚死的);
 * 3. **一家一处**:窗口型登了之后开集那条路一轮都不再读它(`openQuotaFamilies` 不再算它);
 * 4. **那一行已经在树上时一颗键都不按**(按原样读先读,读到就停)—— 她的菜单不白开一次;
 * 5. **不许走台前**:这一家的 `reach` 里没有 `front_ok`,自动那一轮也只走后台 `quota_page`。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaReading } from '../src/server/agentQuota.ts'
import {
  GROK_BOT_FAMILY_ID,
  GROK_BOT_TITLE,
  GROK_BOT_WINDOW,
  createWindowQuotaReader,
  forgetQuotaMemory,
  grokBotQuotaOf,
  hasQuotaAdapter,
  openQuotaFamilies,
  quotaFor,
  quotaReachFor,
} from '../src/server/agentQuota.ts'

const NOW = new Date('2026-10-04T12:30:00Z')

/** 真机那一行(`AXMenuItem (22,708) 220x30 ['SuperGrok 0%']`;文字换成要量的那个数)。 */
function row(text: string): NonNullable<WindowQuotaReading['last']> {
  return { at: NOW.toISOString(), matches: [{ id: 'used', text, x: 22, y: 708, window: 0 }] }
}

beforeEach(() => { forgetQuotaMemory() })

describe('Grok Bot · 那个数是已用(维护者 2026-10-04 拍板)', () => {
  it('★「SuperGrok 6%」= 已用 6% → 还剩约 94%(读反方向是最坏的那种假数)', () => {
    const view = grokBotQuotaOf(row('SuperGrok 6%'))
    expect(view).toMatchObject({
      id: GROK_BOT_FAMILY_ID, title: GROK_BOT_TITLE, state: 'numbers', level: 'ok', left_pct: 94, line: '还剩约 94%',
    })
    // 出处写**那一行的原话** + 这个数是已用(她一眼能对上她自己看到的那一行)。
    expect(view?.source).toContain('「SuperGrok 6%」')
    expect(view?.source).toContain('已用')
  })

  it('★0% = 没用过 → 还剩约 100%', () => {
    expect(grokBotQuotaOf(row('SuperGrok 0%'))).toMatchObject({ level: 'ok', left_pct: 100, line: '还剩约 100%' })
  })

  it('★快用完 / 用完了那两档与别家同一条线(15% / 1%)', () => {
    expect(grokBotQuotaOf(row('SuperGrok 90%'))).toMatchObject({ level: 'low', left_pct: 10, line: '只剩约 10%,快用完了' })
    expect(grokBotQuotaOf(row('SuperGrok 100%'))).toMatchObject({ level: 'empty', left_pct: 0, line: '用量用完了' })
  })

  it('★那一行没读到 → 回 undefined(不编一个数)', () => {
    expect(grokBotQuotaOf({ at: NOW.toISOString(), matches: [] })).toBeUndefined()
  })
})

describe('Grok Bot · 那条正则整格锚死(聊天里提到配不上)', () => {
  const regex = new RegExp(GROK_BOT_WINDOW.patterns[0]?.regex as string)

  it('★真机那一行认得出(名字与数之间、数与百分号之间都留了空白余量)', () => {
    expect(regex.test('SuperGrok 0%')).toBe(true)
    expect(regex.test('SuperGrok 6%')).toBe(true)
    expect(regex.test('SuperGrok  100 %')).toBe(true)
  })

  it('★一句话里提到这几个字配不上 —— 那道旁证就是「整格」本身', () => {
    expect(regex.test('你的 SuperGrok 6% 用完了吗')).toBe(false)
    expect(regex.test('SuperGrok 6% left')).toBe(false)
    expect(regex.test('6%')).toBe(false)
    // 别的写法没量到过,不猜(D13)。
    expect(regex.test('Grok 6%')).toBe(false)
  })
})

describe('Grok Bot · 一家一处(窗口型登了,开集那条路不再读它)', () => {
  it('★`registerQuotaAdapter` 登了 → `openQuotaFamilies` 不再把它算进开集', () => {
    expect(hasQuotaAdapter(GROK_BOT_FAMILY_ID)).toBe(true)
    const families = openQuotaFamilies([
      { id: GROK_BOT_FAMILY_ID, title: 'Grok Bot', bundle_id: GROK_BOT_FAMILY_ID },
      { id: 'com.google.antigravity', title: 'Antigravity', bundle_id: 'com.google.antigravity' },
    ])
    expect(families.map(one => one.id)).toEqual(['com.google.antigravity'])
  })

  it('★那张表仍旧一处查(`quotaReachFor`;声明的地方是 `GROK_BOT_WINDOW.reach`)', () => {
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)).toEqual(GROK_BOT_WINDOW.reach)
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.press).toEqual(['Open account menu'])
    expect(quotaReachFor(GROK_BOT_FAMILY_ID)?.read_titles).toBe(true)
  })

  it('★不许走台前:这一家没有 `front_ok`、也没有 `back`(菜单后台收不回,不假装收)', () => {
    expect(GROK_BOT_WINDOW.reach?.front_ok).toBeUndefined()
    expect(GROK_BOT_WINDOW.reach?.back).toBeUndefined()
    expect(GROK_BOT_WINDOW.reach?.link).toBeUndefined()
  })

  it('★走窗口型那一格:读到了就是有数,一句「还没找到这家的额度来源」都不说', () => {
    const view = quotaFor(GROK_BOT_FAMILY_ID, {
      quota: {}, now: NOW, window: { [GROK_BOT_FAMILY_ID]: { last: row('SuperGrok 6%') } },
    })
    expect(view).toMatchObject({ state: 'numbers', left_pct: 94 })
  })

  it('★还没读到时那句话里念的是「Grok Bot」,不是包标识', () => {
    const view = quotaFor(GROK_BOT_FAMILY_ID, { quota: {}, now: NOW, window: {} })
    expect(view.state).toBe('unconnected')
    expect(view.line).toContain(GROK_BOT_TITLE)
    expect(view.line).not.toContain('com.anysphere')
  })
})

/** 一台假机器:只有 Grok Bot 这一家(用生产那一份 spec),账号菜单开没开着由 `menuOpen` 说。 */
function world(input: { menuOpen?: boolean, pressOpensIt?: boolean, caps?: { quotaPage?: boolean, readTitles?: boolean } }) {
  const sent: { op: string, labels?: readonly string[], front?: unknown, include_titles?: unknown, unhide?: unknown }[] = []
  let open = input.menuOpen ?? false
  const reader = createWindowQuotaReader({
    request: async (req: unknown) => {
      const one = req as { op: string }
      sent.push(one as never)
      if (one.op === 'running_apps') {
        return { ok: true, result: { apps: [{ bundle_id: GROK_BOT_FAMILY_ID, hidden: true }] } }
      }
      if (one.op === 'read_texts') {
        return {
          ok: true,
          result: {
            matches: open ? [{ id: 'used', text: 'SuperGrok 6%', x: 22, y: 708, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
          },
        }
      }
      if (one.op === 'quota_page') {
        // 真机:后台 `AXPress`「Open account menu」按得开,**等一拍**那六行才进树。
        if (input.pressOpensIt !== false) open = true
        return { ok: true, result: { found: true, pressed: true, how: 'ax_press', pressed_count: 1 } }
      }
      return { ok: true, result: {} }
    },
    helper: () => ({
      connected: true, authorized: true, readTexts: true,
      quotaPage: input.caps?.quotaPage ?? true, readTitles: input.caps?.readTitles ?? true,
    }),
    now: () => NOW,
    wait: async () => {},
    log: () => {},
    specs: new Map([[GROK_BOT_FAMILY_ID, GROK_BOT_WINDOW]]),
  } as never)
  return {
    reader,
    sent,
    pages: () => sent.filter(one => one.op === 'quota_page'),
    reads: () => sent.filter(one => one.op === 'read_texts'),
  }
}

describe('Grok Bot · 按原样读先读,读到就停(她的菜单不白开一次)', () => {
  it('★那一行已经在树上(菜单开着)→ 一颗键都不按', async () => {
    const { reader, pages, reads } = world({ menuOpen: true })
    await reader.refresh()
    expect(pages()).toHaveLength(0)
    // 第一眼就是**按原样读**(不放窗 —— 她眼前一动不动),而且带着 `include_titles`。
    expect(reads()[0]?.unhide).toBe(false)
    expect(reads()[0]?.include_titles).toBe(true)
    expect(reader.readings()[GROK_BOT_FAMILY_ID]?.last?.matches[0]?.text).toBe('SuperGrok 6%')
  })

  it('★菜单收起来着 → 后台按一次「Open account menu」,**不带 `front`**,再读一遍就有数', async () => {
    const { reader, pages } = world({ menuOpen: false })
    await reader.refresh()
    expect(pages()).toHaveLength(1)
    expect(pages()[0]?.labels).toEqual(['Open account menu'])
    // ★ 凡会把 App 顶到前台的动作,自动那一轮一律不许走(10-03 22:4x 规矩)。
    expect(pages()[0]?.front).toBeUndefined()
    expect(reader.readings()[GROK_BOT_FAMILY_ID]?.last?.matches[0]?.text).toBe('SuperGrok 6%')
  })

  it('★按完还是没读到 → 不按第三次、也不按「回去」(菜单从后台收不回)', async () => {
    const { reader, pages } = world({ menuOpen: false, pressOpensIt: false })
    await reader.refresh()
    expect(pages()).toHaveLength(1)
    expect(reader.readings()[GROK_BOT_FAMILY_ID]?.last).toBeUndefined()
  })

  it('★老壳(没有 `read_titles`)→ 压根不发那一格;自动那一轮也不按键', async () => {
    const { reader, reads, pages } = world({ menuOpen: false, caps: { quotaPage: false, readTitles: false } })
    await reader.refresh()
    for (const one of reads()) expect(one.include_titles).toBeUndefined()
    expect(pages()).toHaveLength(0)
  })
})
