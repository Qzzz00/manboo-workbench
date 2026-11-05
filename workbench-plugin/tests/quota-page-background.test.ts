// @vitest-environment node
/**
 * ★ **在后台把那家翻到额度那一页,不抢她的焦点**(2026-10-03,卡 QP)。
 *
 * ## 前因
 *
 * 卡 QZ(`docs/交接-1003-额度自己读到.md`)把自动读额度那一轮接回来了,**唯独没闭合按键那半边**:
 * 壳今天那条 `agent_press` 点之前必须 `TextInsert.frontForWindowAction` 把那家叫到台前
 * (Electron 那几家在后台「点」不作数)—— 那就是抢焦点,与「她一个字都不用操作、也不被打扰」冲突。
 * 于是她把豆包停在聊天页上时,自动那一轮仍旧读不到额度(格子摆上次那个数)。
 *
 * ## 这张卡
 *
 * 壳加一条 `quota_page { bundle_id, label }`:`unhide`(**不 activate**)→ 按
 * `AgentWindowPolicy.matchOptionLabel` 那套认那颗键(复用 `agent_press` 的那一份,不另写识别)→
 * **只走 `AXUIElementPerformAction(kAXPressAction)`,一次鼠标点击都不合成**(合成点击才非得要台前)
 * → 回 `{ found, pressed, note }`,藏回去由壳自己的 `defer` 做。
 *
 * 插件这一侧:`reach.press` 有值时,**按 caps 决定走哪条路** ——
 * 新壳走 `quota_page`(自动那一轮也翻页)、老壳照旧只有她亲手点「读一下」时走 `agent_press`;
 * 读完走过 `quota_page` 的那一家**按原路按回去**(`reach.back`)。
 *
 * 真机实测(10-03,维护者机器,Muse):后台 `AXPress` 按得动(`Library` 按过去、`Chat` 按回来)、
 * 台前那一家一下都没换、按完 Muse 照旧是藏着的。详见 `docs/交接-1003-壳后台翻到额度页.md`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import {
  DOUBAO_WINDOW,
  MANUS_WINDOW,
  MUSE_WINDOW,
  createWindowQuotaReader,
  forgetQuotaMemory,
  readErrorOf,
} from '../src/server/agentQuota.ts'

const NOW = new Date('2026-10-03T06:00:00Z')
const FAKE = 'com.example.fake'
/** 壳回「这一版壳不会这个 op」那句的原话(`HelperSocket.runOp` 的 default 那一支)。 */
const UNKNOWN_OP = '未知 op:quota_page'

function fakeSpec(reach: WindowQuotaSpec['reach']): WindowQuotaSpec {
  return {
    bundleId: FAKE,
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id: 'fake', title: '假的那家', state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
    ...(reach === undefined ? {} : { reach }),
  }
}

/**
 * 一台假机器。
 * - `quotaPage` —— 这份壳会不会那条不抢焦点的 op(= 壳 caps 里有没有 `quota_page`);
 * - `hitAfterPress` —— 第一次读不到、**按过去之后**才读到(真机上那一条路就是这么走的);
 * - `page` —— 壳对 `quota_page` 怎么回(认到并按下 / 认不到 / 老壳不会这个 op)。
 */
function world(input: {
  reach: WindowQuotaSpec['reach']
  quotaPage?: boolean
  hit?: boolean
  hitAfterPress?: boolean
  page?: 'pressed' | 'not_found' | 'unknown_op'
  apps?: readonly { bundle_id: string, active?: boolean, hidden?: boolean }[]
}) {
  const sent: { op: string, bundle_id?: string, label?: string, labels?: readonly string[], unhide?: unknown }[] = []
  const logs: string[] = []
  let pressedOnce = false
  const reader = createWindowQuotaReader({
    request: async (req) => {
      sent.push(req as never)
      const op = (req as { op: string }).op
      if (op === 'running_apps') {
        return { ok: true, result: { apps: input.apps ?? [{ bundle_id: FAKE, hidden: true }] } }
      }
      if (op === 'read_texts') {
        const hit = input.hit ?? (input.hitAfterPress === true ? pressedOnce : false)
        return {
          ok: true,
          result: {
            matches: hit ? [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
            window_count: 1,
          },
        }
      }
      if (op === 'quota_page') {
        const how = input.page ?? 'pressed'
        if (how === 'unknown_op') return { ok: false, error: UNKNOWN_OP }
        if (how === 'not_found') {
          return { ok: true, result: { found: false, pressed: false, windows: 2, capped: false, note: '它这几扇窗上认不出这颗键' } }
        }
        pressedOnce = true
        return { ok: true, result: { found: true, pressed: true, how: 'ax_press', windows: 2, visited: 314, capped: false } }
      }
      if (op === 'agent_press') {
        pressedOnce = true
        return { ok: true, result: { found: true, pressed: true, how: 'ax_press' } }
      }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true,
                     ...(input.quotaPage === undefined ? {} : { quotaPage: input.quotaPage }) }),
    now: () => NOW,
    wait: async () => {},
    log: line => { logs.push(line) },
    specs: new Map([['fake', fakeSpec(input.reach)]]),
  })
  return { reader, sent, logs }
}

/**
 * 这一轮按过哪几颗键(按顺序)。
 *
 * ★ **2026-10-03 卡 QT**:`quota_page` 一条 op 收**一串** `labels`(一次放出来里按完 ——
 * 弹出式菜单在两条 op 之间会收掉,见那张卡)。所以这里把那一串摊开,
 * 断言仍旧是「按了哪几颗、什么顺序」;`agent_press` 照旧一颗一条。
 */
const labels = (sent: { op: string, label?: string, labels?: readonly string[] }[], op: string): (string | undefined)[] =>
  sent.filter(one => one.op === op).flatMap(one => (one.labels === undefined ? [one.label] : [...one.labels]))

beforeEach(() => { forgetQuotaMemory() })

describe('后台翻到额度页 · 新壳走不抢焦点那条路', () => {
  it('★自动那一轮(她一个字都没操作)也翻页:发 quota_page、不发 agent_press', async () => {
    const { reader, sent } = world({ reach: { page: '用量', press: ['设置', '用量'] }, quotaPage: true, hitAfterPress: true })
    await reader.refresh()
    expect(labels(sent, 'quota_page')).toEqual(['设置', '用量'])
    expect(sent.some(one => one.op === 'agent_press')).toBe(false)
  })

  it('★顺序:先读一次 → 按过去 → 再读一次(按完那一次才读到)', async () => {
    const { reader, sent } = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, hitAfterPress: true })
    await reader.refresh()
    const ops = sent.filter(one => ['read_texts', 'quota_page'].includes(one.op)).map(one => one.op)
    // ★ 卡 QT:读那一下成了**两眼**(先按原样、再放窗),翻页在两眼都没读到之后。
    expect(ops).toEqual(['read_texts', 'read_texts', 'quota_page', 'read_texts'])
    expect(sent.filter(one => one.op === 'read_texts').map(one => one.unhide)).toEqual([false, true, true])
    expect(reader.readings().fake?.attempt?.found).toBe(true)
    expect(reader.readings().fake?.last?.matches[0]?.text).toBe('剩 62%')
  })

  it('★这一次就读到了的,一颗键都不按(别无故动她的 App)', async () => {
    const { reader, sent } = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, hit: true })
    await reader.refresh()
    expect(sent.some(one => one.op === 'quota_page')).toBe(false)
  })

  it('★表上没写 press 的那一家:一条 quota_page 都不发(今天那三家就是这样)', async () => {
    const { reader, sent, logs } = world({ reach: { page: '用量' }, quotaPage: true })
    await reader.refresh()
    expect(sent.some(one => one.op === 'quota_page')).toBe(false)
    expect(logs.join('\n')).toContain('到不了那一页')
  })

  /**
   * ★ 壳认不到那颗键(真机上 10-03 的 Muse 就是这样:侧栏那几颗键里没有一颗通向「使用情况」)——
   * **不重试、不换成合成点击、不编一个数**:第二趟读压根不发,格子摆上次那个数,原因只进日志。
   */
  it('★认不到那颗键 → 不再读第二遍,只记一行(壳那句原话照抄进日志)', async () => {
    const { reader, sent, logs } = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, page: 'not_found' })
    await reader.refresh()
    // 两眼(按原样 + 放窗)之后就不再读第三遍 —— 键都没按动,再读也是同一页(卡 QT 起是两眼,原来是一眼)。
    expect(sent.filter(one => one.op === 'read_texts')).toHaveLength(2)
    expect(logs.join('\n')).toContain('按不到「用量」这一步')
    expect(logs.join('\n')).toContain('认不出这颗键')
  })

  it('★按动了、那一页还是没读到(按了没反应)→ 如实记一行,不重试第三遍', async () => {
    const { reader, sent, logs } = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, hit: false })
    await reader.refresh()
    // 两眼 + 按过去之后那一眼 = 三趟,到此为止(卡 QT 起第一眼是「按原样读」)。
    expect(sent.filter(one => one.op === 'read_texts')).toHaveLength(3)
    expect(logs.join('\n')).toContain('按了没反应')
    expect(reader.readings().fake?.last).toBeUndefined()
  })
})

describe('后台翻到额度页 · 老壳行为与今天一字不差', () => {
  it('★老壳(caps 里没有 quota_page):自动那一轮一颗键都不按', async () => {
    const { reader, sent, logs } = world({ reach: { page: '用量', press: ['用量'] } })
    await reader.refresh()
    expect(sent.some(one => one.op === 'quota_page' || one.op === 'agent_press')).toBe(false)
    expect(logs.join('\n')).toContain('叫到台前')
  })

  it('★老壳 + 她亲手点「读一下」→ 照旧走 agent_press(那一条会把那家叫到台前,她正在等)', async () => {
    const { reader, sent } = world({ reach: { page: '用量', press: ['设置', '用量'] }, hitAfterPress: true })
    await reader.refresh(undefined, { press: true })
    expect(labels(sent, 'agent_press')).toEqual(['设置', '用量'])
    expect(sent.some(one => one.op === 'quota_page')).toBe(false)
  })

  /** caps 报了「会」、壳其实回「未知 op」(装了一半 / 壳比 caps 旧):退回老那条路,不假装翻过页。 */
  it('★报了会、其实回「未知 op」:自动那一轮不按,她亲手点时退回 agent_press', async () => {
    const auto = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, page: 'unknown_op' })
    await auto.reader.refresh()
    expect(auto.sent.filter(one => one.op === 'read_texts')).toHaveLength(2)
    expect(auto.logs.join('\n')).toContain('还不会 quota_page')

    const byHand = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, page: 'unknown_op', hitAfterPress: true })
    await byHand.reader.refresh(undefined, { press: true })
    expect(labels(byHand.sent, 'agent_press')).toEqual(['用量'])
  })

  it('★「未知 op」那句话两头认的是同一句(壳的原话 → readErrorOf → old_shell)', () => {
    expect(readErrorOf(UNKNOWN_OP)).toBe('old_shell')
  })
})

describe('后台翻到额度页 · 读完按原路按回去', () => {
  it('★声明了 back:读完按回去那几颗(也走不抢焦点那条路)', async () => {
    const { reader, sent } = world({
      reach: { page: '用量', press: ['设置', '用量'], back: ['聊天'] }, quotaPage: true, hitAfterPress: true,
    })
    await reader.refresh()
    expect(labels(sent, 'quota_page')).toEqual(['设置', '用量', '聊天'])
    // 按回去那一下在**读完之后**(不是读之前)。
    const ops = sent.filter(one => ['read_texts', 'quota_page'].includes(one.op)).map(one => one.op)
    expect(ops[ops.length - 1]).toBe('quota_page')
  })

  it('★没声明 back → 一条都不多发(她眼前照旧什么都不多,只是那家留在额度页上)', async () => {
    const { reader, sent } = world({ reach: { page: '用量', press: ['用量'] }, quotaPage: true, hitAfterPress: true })
    await reader.refresh()
    expect(labels(sent, 'quota_page')).toEqual(['用量'])
  })

  it('★认不到回去那颗键 → 只记一行,这一次读的结论一个字不改', async () => {
    const { reader, logs } = world({
      reach: { page: '用量', press: ['用量'], back: ['聊天'] }, quotaPage: true, page: 'not_found',
    })
    await reader.refresh()
    // 过去那一步就没按成,所以压根走不到按回去(不许在没动过的页上「按回去」)。
    expect(logs.join('\n')).not.toContain('按不回原来那一页')
    expect(reader.readings().fake?.attempt?.found).toBe(false)
  })

  it('★走的是老那条(agent_press)就不按回去 —— 那一下本来就把那家叫到了台前,她正看着', async () => {
    const { reader, sent } = world({
      reach: { page: '用量', press: ['用量'], back: ['聊天'] }, hitAfterPress: true,
    })
    await reader.refresh(undefined, { press: true })
    expect(labels(sent, 'agent_press')).toEqual(['用量'])
    expect(sent.some(one => one.op === 'quota_page')).toBe(false)
  })
})

/**
 * 接缝(AGENTS.md「改契约的卡:同一个分支里改完所有消费方 + 读源头文件比对」)。
 * 这条 op 的主人是**壳**;消费方只有 `agentQuota.ts` 这一处。
 */
describe('后台翻到额度页 · 接缝(读源头文件比对)', () => {
  const ROOT = join(__dirname, '..', '..')
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

  it('① 壳报了这一格、认这个 op、真有那个函数', () => {
    const shell = read('workbench-app/Sources/HelperSocket.swift')
    const caps = shell.slice(shell.indexOf('"caps": ['), shell.indexOf(']]', shell.indexOf('"caps": [')))
    expect(caps).toContain('"quota_page"')
    expect(shell).toContain('case "quota_page":')
    expect(read('workbench-app/Sources/AgentWindow.swift')).toContain('static func quotaPage(')
  })

  it('② 插件按同一个名字问 caps、发同一个 op', () => {
    expect(read('workbench-plugin/src/index.ts')).toContain(`helper.supports?.('quota_page')`)
    expect(read('workbench-plugin/src/server/agentQuota.ts')).toContain(`'quota_page'`)
  })

  it('③ 它要辅助功能授权 —— **不在** AX_FREE_OPS 里(别因为它温和就把门撤了)', () => {
    const channel = read('workbench-plugin/src/server/helperChannel.ts')
    const line = channel.slice(channel.indexOf('const AX_FREE_OPS'), channel.indexOf('\n', channel.indexOf('const AX_FREE_OPS')))
    expect(line).not.toContain('quota_page')
    expect(line).toContain('running_apps')
  })

  it('④ 「开App」那一行记它(它会把藏着的那一家放出来)', () => {
    const log = read('workbench-app/Sources/AppOpenLog.swift')
    const table = log.slice(log.indexOf('static let openingOps'), log.indexOf(']', log.indexOf('static let openingOps')))
    expect(table).toContain('"quota_page"')
  })

  it('⑤ 协议里有这一条请求(插件发它时 tsc 认得)', () => {
    const req: HelperRequest = { op: 'quota_page', bundle_id: FAKE, label: '用量' }
    expect(req.op).toBe('quota_page')
  })
})

/**
 * 那张表今天的样子(10-03 真机量过的结论,**一格 press 都没填**):
 * 填不填是查实的事,不是代码的事 —— 这几条钉住「没查实就别写」,
 * 哪天查实了填上去,上面那几条链一个字都不用改(用例在那儿)。
 */
describe('后台翻到额度页 · 表上今天谁有 press', () => {
  /*
   * ★ **2026-10-04(卡「豆包台前点一下」):豆包那一格填上了,另两家照旧空着。**
   *
   * 豆包填的那一颗**不是**这条后台路上按的 —— 它带着 `front_ok` + `front_click`
   * (台前、只在她亲手点「读一下」时,合成一次鼠标点击),后台这一支**一颗都不按**
   * (`reachPage` 的 `front_ok` 那一支在 `mayPress === false` 时第一行就回头)。
   * 这一条就是为了钉住那件事:后台这条路上今天仍旧一家都不按键。
   */
  it('★三家都写着页名;后台这条路上一条 press 都不走(豆包那一颗是台前点一下那条路的)', () => {
    for (const spec of [MANUS_WINDOW, MUSE_WINDOW, DOUBAO_WINDOW]) {
      expect(spec.reach?.page).toBeTruthy()
      expect(spec.reach?.back).toBeUndefined()
    }
    expect(MANUS_WINDOW.reach?.press).toBeUndefined()
    expect(MUSE_WINDOW.reach?.press).toBeUndefined()
    // 豆包那一颗只在台前那一支走 —— 两格门缺一格都不按。
    expect(DOUBAO_WINDOW.reach?.press).toEqual(['标准套餐'])
    expect(DOUBAO_WINDOW.reach?.front_ok).toBe(true)
    expect(DOUBAO_WINDOW.reach?.front_click).toBe(true)
  })
})
