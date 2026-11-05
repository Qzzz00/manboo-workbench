// @vitest-environment node
/**
 * **窗口槽里的家与读不到的家**(2026-10-01;Air 诊断 14:47,插件 0.4.77)。
 *
 * 维护者两条现场:
 * 1. 「事务官窗口无法识别设备现有智能体(已拉进窗口槽,依旧不能被识别,一直停留在初始版本;
 *    豆包工作和 muse 我已关闭后台但依旧挂在事务官处)」;
 * 2. 「事务官无法给豆包派活,可以给 codex 派活。我已把豆包办公移动到窗口槽里,@ 后依旧无法给豆包办公派活」
 *    —— 一件事都没建出来:事务官读到的登记表 / 能力表上写着「没接上:豆包办公 开着,但一扇窗都没有」。
 *
 * 根子是同一句假话:**窗口槽把不在台前那一格的 App 自己藏了**(`dock` 发 `hide_app`),
 * 藏着的 App 辅助功能一扇窗都列不出,壳于是回 `windows: 0, hidden: true` ——
 * 以前服务端把它说成「它没有窗口」。藏它的手是工作台自己的,这句话既假,又把她支去「把窗口叫出来」。
 *
 * 这一组用例钉三件事:
 * - A 藏在窗口槽里 ≠ 没有窗口(判、读、能力表三处同一个口径,派活不因此被挡);
 * - B 没开就说没开(来源明说没在跑时,不许拿上一拍那句「开着但没有窗口」顶上来);
 * - C 认出是 AI 应用、窗口却读不到的那几家如实摆出来,不默默不列;
 * - D 诊断包里带得走那扇窗的结构摘要(**只有数**,一个字的内容都没有)。
 */
import { describe, expect, it } from 'vitest'
import { agentHiddenInSlotWhy, agentNotOpenWhy, agentUnreadableWhy } from '../src/protocol.ts'
import { axSummaryOf, judgeStructure, parseProbe } from '../src/server/agentJudge.ts'
import { parseRead, summarizeRead, nextWindowState } from '../src/server/agentWindowModel.ts'
import { emptyRegistry, registryView, unreadableApps, judgedApps } from '../src/server/agentRegistry.ts'
import type { AppRecord, RegistryFile } from '../src/server/agentRegistry.ts'
import { agentCapFrom } from '../src/server/agentCaps.ts'
import { createWindowProbe } from '../src/server/agentCapsIo.ts'

/** Air 上那一下:豆包办公在跑、被窗口槽藏着,辅助功能一扇窗都列不出。 */
const HIDDEN_PROBE = { running: true, windows: 0, active: false, hidden: true }

describe('A · 藏在窗口槽里 ≠ 没有窗口', () => {
  it('judgeStructure:藏着那一下不说「它没有窗口」,而且标出来「这一下没看成」', () => {
    const verdict = judgeStructure(parseProbe(HIDDEN_PROBE))
    expect(verdict.pass).toBe(false)
    expect(verdict.hidden).toBe(true)
    expect(verdict.why).toContain('藏在窗口槽里')
    expect(verdict.why).not.toContain('它没有窗口')
  })

  it('judgeStructure:真没有窗口(没藏)照旧说没有窗口 —— 这一条不许被上面那一支吃掉', () => {
    const verdict = judgeStructure(parseProbe({ running: true, windows: 0, hidden: false }))
    expect(verdict.hidden).toBeUndefined()
    expect(verdict.why).toContain('它没有窗口')
  })

  it('summarizeRead:藏着那一拍说「藏在窗口槽里」,不说「开着,但一扇窗都没有」', () => {
    const summary = summarizeRead(parseRead({ ...HIDDEN_PROBE, stop: [], tail: [], side: [] }), '豆包办公')
    expect(summary.ok).toBe(false)
    expect(summary.hidden).toBe(true)
    expect(summary.gaps.status).toBe(agentHiddenInSlotWhy('豆包办公'))
    expect(summary.gaps.status).not.toContain('一扇窗都没有')
  })

  it('登记表:接上了的那一家被藏起来 → 还是那一家,那一句不写「没接上」', () => {
    const data = connected('com.work.pc.doubao', '豆包办公')
    const summary = summarizeRead(parseRead({ ...HIDDEN_PROBE, stop: [], tail: [], side: [] }), '豆包办公')
    const { state } = nextWindowState(data.apps['com.work.pc.doubao']?.last, summary, {
      now: new Date('2026-10-01T06:47:00.000Z'), active: false, name: '豆包办公',
    })
    ;(data.apps['com.work.pc.doubao'] as AppRecord).last = state
    const view = registryView({
      data, running: () => true, sessions: [], bubbles: new Map(), now: new Date('2026-10-01T06:47:30.000Z'),
    })
    const entry = view.entries.find(one => one.id === 'doubao')
    expect(entry).toBeDefined()
    expect(entry?.gaps.status).toBe(agentHiddenInSlotWhy('豆包办公'))
    expect(entry?.gaps.status).not.toContain('没接上')
  })

  it('能力表:藏在窗口槽里照旧派得出去(派活会先切到它那一格)', () => {
    const chat = agentCapFrom('doubao', {
      installed: { doubao: true },
      titles: { doubao: '豆包办公' },
      helper: { connected: true, authorized: true, newConversation: true, readReply: true },
      window: { doubao: { state: 'hidden', at: '2026-10-01T06:47:00.000Z' } },
      cli: {},
    }).cells.chat
    expect(chat.state).toBe('ok')
    expect(chat.note).toContain('藏在窗口槽里')
  })

  it('看窗口那一眼:壳说「一扇标准窗口都没有」时再问一句 app_info,藏着就说藏着', async () => {
    const asked: string[] = []
    const probe = createWindowProbe({
      now: () => new Date('2026-10-01T06:47:00.000Z'),
      request: async (req) => {
        asked.push(req.op)
        if (req.op === 'focus_input') throw new Error('找不到窗口:com.work.pc.doubao 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)')
        return { result: { running: true, hidden: true, windows: 0 } }
      },
    })
    expect((await probe('doubao')).state).toBe('hidden')
    expect(asked).toEqual(['focus_input', 'app_info'])
  })

  it('看窗口那一眼:没藏(或者老壳问不到)照旧是「没有窗口」', async () => {
    const probe = createWindowProbe({
      now: () => new Date('2026-10-01T06:47:00.000Z'),
      request: async (req) => {
        if (req.op === 'focus_input') throw new Error('找不到窗口:com.foo.bar 在跑,但一扇标准窗口都没有')
        throw new Error('这个壳不认得 app_info')
      },
    })
    expect((await probe('doubao')).state).toBe('no_window')
  })
})

describe('B · 没开就说没开', () => {
  it('来源明说没在跑 → 那几句写「没开」,不拿上一拍那句「开着但没有窗口」顶上来', () => {
    const data = connected('com.meta.endo', 'Muse')
    const record = data.apps['com.meta.endo'] as AppRecord
    record.last = {
      status: 'unknown', since: '2026-10-01T05:00:00.000Z', titles: [], at: '2026-10-01T05:00:00.000Z', unread: false,
      gaps: { status: 'Muse 开着,但一扇窗都没有(可能只在菜单栏里)' },
    }
    const view = registryView({
      data, running: () => false, sessions: [], bubbles: new Map(), now: new Date('2026-10-01T06:47:00.000Z'),
    })
    const entry = view.entries.find(one => one.id === 'muse')
    /*
     * 没开的那一家状态照旧是「显示的是上次读到的」(`note` 里写着几点读的),所以 `status` 不是说不清、
     * 没有 `gaps.status`;缺的那几样(标题、最新一句)那一句**要写「没开」** ——
     * 以前它们原样抄上一拍那句「开着,但一扇窗都没有」,而来源这会儿明说它没在跑。
     */
    expect(entry?.gaps.title).toBe(agentNotOpenWhy('Muse'))
    expect(entry?.gaps.latest).toBe(agentNotOpenWhy('Muse'))
    expect(JSON.stringify(entry?.gaps)).not.toContain('一扇窗都没有')
    expect(entry?.note).toContain('Muse 没开')
  })

  it('一次都没读到过、而且没开 → 也是「没开」,不加「没接上」', () => {
    const data = connected('com.meta.endo', 'Muse')
    const view = registryView({
      data, running: () => false, sessions: [], bubbles: new Map(), now: new Date('2026-10-01T06:47:00.000Z'),
    })
    expect(view.entries.find(one => one.id === 'muse')?.gaps.status).toBe(agentNotOpenWhy('Muse'))
  })
})

describe('C · 认出是 AI 应用、窗口却读不到的那几家如实摆出来', () => {
  /** Air 上的新版 Kimi:判成 ai_agent,窗口那一道过不去(读不到输入框、读不到对话区)。 */
  function unreadableKimi(): RegistryFile {
    const data = emptyRegistry()
    data.apps['com.moonshot.kimichat.kmp.mac'] = {
      bundle_id: 'com.moonshot.kimichat.kmp.mac',
      name: 'Kimi',
      state: 'candidate',
      verdict: { kind: 'ai_agent', reason: 'Kimi 的桌面客户端', by: 'model', stage: 'identity', at: '2026-10-01T06:00:00.000Z' },
      structure: {
        pass: false, surface: false, input: false, send: false, new_chat: false,
        why: '不像对话窗口:没有输入框;没有对话区也没有会话列表', at: '2026-10-01T06:10:00.000Z',
      },
    }
    return data
  }

  it('摆进登记表的 unreadable 那一格,话说清「读不到它的窗口」', () => {
    const view = registryView({
      data: unreadableKimi(), running: () => true, sessions: [], bubbles: new Map(), now: new Date('2026-10-01T06:47:00.000Z'),
    })
    expect(view.unreadable).toHaveLength(1)
    expect(view.unreadable?.[0]?.why).toBe(agentUnreadableWhy('Kimi'))
    expect(view.unreadable?.[0]?.detail).toContain('没有输入框')
    // 没接上就是没接上:不混进接上了的那几家里冒充。
    expect(view.entries.some(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')).toBe(false)
  })

  it('★「藏在窗口槽里」不算读不到:那只是这一拍没看成,不摆这一行', () => {
    const data = unreadableKimi()
    const record = data.apps['com.moonshot.kimichat.kmp.mac'] as AppRecord
    record.structure = { ...(record.structure as NonNullable<AppRecord['structure']>), hidden: true }
    expect(unreadableApps({ data })).toHaveLength(0)
  })

  it('他说过「这不是 Agent」的、还在问他的那几家不摆(判成 ai_agent 才摆)', () => {
    const data = unreadableKimi()
    ;(data.apps['com.moonshot.kimichat.kmp.mac'] as AppRecord).verdict = {
      kind: 'unsure', reason: '只凭名字判不出来', by: 'model', stage: 'identity', at: '2026-10-01T06:00:00.000Z',
    }
    expect(unreadableApps({ data })).toHaveLength(0)
  })
})

describe('D · 诊断包里那扇窗的结构摘要:只有数', () => {
  it('结构那一道没过的那几家,摘要里有角色个数、窗口大小、藏没藏、敲没敲过门', () => {
    const probe = parseProbe({
      running: true, windows: 1, hidden: false, window: { w: 1200, h: 800 },
      inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] },
      lists: [], left_links: 0, texts: { total: 12, left: 0, above_input: 0 },
      toolbar: ['设置'], menus: ['文件', '编辑'],
      roles: { AXGroup: 420, AXStaticText: 88, AXWebArea: 1 },
      ax_manual: true, visited: 900, capped: false,
    })
    const summary = axSummaryOf(probe, '2026-10-01T06:47:00.000Z')
    expect(summary.roles).toEqual({ AXGroup: 420, AXStaticText: 88, AXWebArea: 1 })
    expect(summary.window).toEqual({ w: 1200, h: 800 })
    expect(summary.inputs).toBe(0)
    expect(summary.ax_manual).toBe(true)
    // **一个字的内容都没有**:摘要整份序列化出来,不许出现界面字(工具栏、菜单那几项的名字)。
    const json = JSON.stringify(summary)
    expect(json).not.toContain('设置')
    expect(json).not.toContain('文件')
    expect(summary.toolbar).toBe(1)
    expect(summary.menus).toBe(2)
  })

  it('老壳没有 roles / ax_manual 那两格 → 整格缺席,不编一个', () => {
    const summary = axSummaryOf(parseProbe({ ...HIDDEN_PROBE }), '2026-10-01T06:47:00.000Z')
    expect(summary.roles).toBeUndefined()
    expect(summary.ax_manual).toBeUndefined()
    expect(summary.hidden).toBe(true)
    expect(summary.windows).toBe(0)
  })

  it('judgedApps(`GET /agents`、诊断包里的那一份)把摘要带上', () => {
    const data = emptyRegistry()
    data.apps['com.electron.klingai'] = {
      bundle_id: 'com.electron.klingai',
      name: '可灵',
      state: 'candidate',
      ax: { at: '2026-10-01T06:47:00.000Z', windows: 1, inputs: 0, send: 0, stop: 0, lists: 0, left_links: 0, texts: { total: 3, left: 0, above_input: 0 }, toolbar: 0, menus: 5 },
    }
    expect(judgedApps(data)[0]?.ax?.windows).toBe(1)
  })
})

/** 登记表里接上了的一家(还没读到过窗口)。 */
function connected(bundleId: string, name: string): RegistryFile {
  const data = emptyRegistry()
  data.apps[bundleId] = {
    bundle_id: bundleId,
    name,
    state: 'connected',
    found: { how: 'patrol', at: '2026-10-01T05:00:00.000Z', basis: '巡检读到它的窗口' },
  }
  return data
}
