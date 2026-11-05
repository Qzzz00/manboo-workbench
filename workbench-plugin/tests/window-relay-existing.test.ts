// @vitest-environment node
/**
 * **窗口型各家的「已有对话」也捎得进去 + 打断再发**(2026-09-28,卡 WR)。
 *
 * 统筹 09-28 早在维护者本机(main)量的那一份:`/state.agent_registry` 里窗口型各家列着对话
 * (Manus「Token Factory / Cassetta / DramaWise」、豆包办公三条、Muse 三条、Grok Bot 三条、
 * Antigravity 一条),可
 *
 * - `POST /sessions/relay {agent:'manus', session_id:'window:825f1900'}` → 「那条会话不在了」
 * - `{who:'Manus 的 DramaWise'}` → 「没认出…(这会儿有 4 条)」
 *
 * —— **捎话只认文件型那 4 条会话**。这一组用例钉的就是这件事,以及维护者点的三个场景:
 *
 * | 场景 | 他的意思 | 这里钉什么 |
 * |---|---|---|
 * | 一 | 新建会话发信息 | 卡 DB 那条路没动(先开新对话再查框)—— 见 `window-send-new-chat-first.test.ts` |
 * | 二 | **在停下的已有会话发信息** | 按标题在侧栏里点那条对话(`agent_pick`)、认回来了才打字 |
 * | 三 | 给正在跑的那条发信息 | 「补一句」= 排进去;「打断再发」= 先按停止键、停下了才送;认不出停止键**如实失败** |
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):切对话 / 打字 / 按停止都在**一条引擎**后面
 * (`sessionJobs` 判断 + `engine/adapters/window.ts` 动手),所以这一份改成「假壳 + 真引擎」端到端跑。
 * 「这份壳会哪几件本事」从前是那只假手上的几个 `canXxx`,现在是壳 hello 里那一串(`caps` 白名单)。
 */
import { describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { SessionView } from '../src/protocol.ts'
import { pickMarkerOf } from '../src/server/sessionAnswer.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { looksLikeInterrupt, relayMoveOf } from '../src/server/relayMove.ts'
import { matchRelaySession } from '../src/server/sessionRelay.ts'
import { lookupSession } from '../src/server/sessionLookup.ts'
import type { RelaySessionView } from '../src/server/sessionRelay.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { ALL_HELPER_CAPS, engineHarness, type EngineHarnessOptions, type FakeHelperReply } from './helpers/engineHarness.ts'

const NOW = '2026-09-28T02:07:00.000Z'
/** 家族目录里 Manus 的那个包(2026-10-02 起挑包由 `agentSources.pickFamilyPackage` 一处说了算)。 */
const MANUS = 'im.manus.desktop'

const view = (patch: Partial<RelaySessionView> & Pick<RelaySessionView, 'agent' | 'session_id'>): RelaySessionView => ({
  project: 'Manus', status: 'done', elapsed_sec: 600, unread: false, updated_at: NOW, ...patch,
})

/** 统筹 09-28 早真机那几条(标题逐字抄的)。 */
const dramaWise = view({ agent: 'manus', session_id: 'window:825f1900', title: 'DramaWise' })
const dramaWiseRunning = { ...dramaWise, status: 'running' as const }

/**
 * 这份假壳怎么答。`picks` = `agent_pick` 认到了没有;`seesBeforePick` = 点之前 `read_reply` 认不认得出;
 * `stop` = `agent_stop` 回什么(这份壳不会按停止键时用 `caps` 把那一格去掉,不是在这里给 undefined)。
 */
function shell(over: {
  picks?: boolean
  seesBeforePick?: boolean
  stop?: { found: boolean, pressed?: boolean, stopped?: boolean }
} = {}): FakeHelperReply {
  let picked = false
  return (req: HelperRequest) => {
    if (req.op === 'read_reply') return { found: picked ? (over.picks ?? true) : (over.seesBeforePick ?? false), busy: false, texts: [] }
    if (req.op === 'agent_pick') { picked = (over.picks ?? true); return { found: picked, pressed: picked, selected: picked } }
    if (req.op === 'agent_stop') return { found: true, ...over.stop, pressed: over.stop?.pressed ?? true, stopped: over.stop?.stopped ?? true }
    if (req.op === 'send_text') return { submitted: true, method: 'ax' }
    return {}
  }
}

/** 一套「假壳 + 真引擎 + 会话服务」。`caps` 不给 = 这份壳什么都会。 */
function serviceWith(
  sessions: readonly RelaySessionView[],
  engine: EngineHarnessOptions = {},
) {
  const h = engineHarness({ nameOf: () => 'Manus', ...engine })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => [] as readonly SessionView[],
    windowSessions: () => sessions,
    bundleOf: () => MANUS,
    agentName: sessionAgentName,
  })
  return { ...h, service }
}

/**
 * 问「能不能捎 / 能不能打断」那一路:界面那几格读的是**现查来的那一份能力**
 * (`registry.knownCaps`),所以先 `targets()` 查一遍,与生产里 `/state` 那一拍一样。
 * 钟定住,免得那一份缓存在同一条用例里过期变回「还没查过」。
 */
async function readyWith(sessions: readonly RelaySessionView[], engine: EngineHarnessOptions = {}) {
  const t = serviceWith(sessions, { now: () => new Date(NOW), ...engine })
  await t.registry.targets()
  return t
}

/** 这份壳不会某一件本事时的 `caps`(白名单里去掉那一格)。 */
const capsWithout = (...gone: readonly string[]): readonly string[] =>
  ALL_HELPER_CAPS.filter(one => !gone.includes(one))

describe('场景二:在停下的已有会话里发信息(窗口型那几家)', () => {
  it('★捎话认窗口型那几条对话:按 session_id 点名,切到那条对话再送', async () => {
    const t = serviceWith([dramaWise], { reply: shell() })
    const sent = await t.service.relay('manus', 'window:825f1900', '这一条先停着,别动')
    expect(sent.ok).toBe(true)
    // 顺序:先读一眼(认不出)→ 在侧栏里点那条对话 → 再读一眼(认出来了)→ 才打字
    // 最后那一下 read_reply:送之前先看她那句在不在对话区里(2026-09-28 Air 维护包)
    expect(t.requests.map(one => one.op)).toEqual(['read_reply', 'agent_pick', 'read_reply', 'read_reply', 'send_text'])
    /*
     * ★ 2026-10-02:动哪一个包由 `agentSources.pickFamilyPackage` 一处说了算(家族目录里 Manus 那个包),
     * 不再由会话那一层的 `bundleOf` 决定 —— 那一格现在只回答「这条窗口型对话认不认得出是哪一家」。
     */
    expect(t.requests.find(one => one.op === 'agent_pick')).toMatchObject({ op: 'agent_pick', bundle_id: MANUS, title: 'DramaWise' })
  })

  /*
   * ★ 2026-10-01(卡 AW,维护者「这个能力不应该是通用的吗」):下面这三种从前都**拒发**
   * (点不着那条对话 / 旧壳不会点 / 那一条连名字都没读到)。现在一律**照发**,
   * 送完读窗口核一次:核不上就如实说「可能发到了别的对话」,**不说成答上了,也不当没送**。
   */
  it('★侧栏里点不着那条对话 → 照样发,核不上就如实说', async () => {
    const t = serviceWith([dramaWise], { reply: shell({ picks: false }) })
    const sent = await t.service.relay('manus', 'window:825f1900', '看一下这条')
    expect(sent.ok).toBe(false)
    if (sent.ok || sent.status !== 200) { expect.fail('该是 200 + 没核上'); return }
    expect(sent.unconfirmed).toBe(true)
    expect(sent.why).toContain('可能发到了别的对话')
    expect(t.requests.some(one => one.op === 'send_text')).toBe(true)
  })

  it('★这份壳还不会在侧栏里点那条对话(旧壳)→ 照样能捎(手机上照旧摆输入框)', async () => {
    const t = await readyWith([dramaWise], { reply: shell(), caps: capsWithout('agent_pick') })
    expect(t.service.relayReady('manus', 'window:825f1900')).toMatchObject({ can: true })
  })

  it('★那一条连名字都没读到 → 照样能捎(叫到台前、照发、按证据核)', async () => {
    const nameless = view({ agent: 'manus', session_id: 'window:deadbeef' })
    const t = await readyWith([nameless], { reply: shell() })
    expect(t.service.relayReady('manus', 'window:deadbeef')).toMatchObject({ can: true })
  })

  it('★他点名标题也认得出来了(以前回「没认出…(这会儿有 4 条)」)', () => {
    const pool: readonly RelaySessionView[] = [
      view({ agent: 'claude', session_id: 'd9991aac', title: 'Desktop-workbench 统筹交接', project: 'desktop-workbench' }),
      dramaWise,
      view({ agent: 'manus', session_id: 'window:1111', title: 'Token Factory' }),
    ]
    const match = matchRelaySession({ sessions: pool, who: 'Manus 的 DramaWise', agentName: sessionAgentName, now: NOW })
    expect(match.kind).toBe('one')
    if (match.kind !== 'one') return
    expect(match.target).toMatchObject({ agent: 'manus', session_id: 'window:825f1900' })
  })

  /**
   * ───────── 卡 FX 的「先认家」对窗口型同样成立(2026-09-28 合 main 时接上) ─────────
   *
   * 窗口型那几条会话的 `agent` 是**登记表条目 id**(多数是包标识),而卡 FX 认家认的是家名。
   * 两边靠 `agentName`(`http.ts` 的 `relayAgentName`:包在派活那张表里就用那一家的正名)接上。
   * 这里用同一个形状钉三件:点了名的那一家**绝不跨家挑**、这一家的窗口型对话认得到、
   * 这一家没有对话时照实说。
   */
  it('★点了名的那一家绝不跨家挑:「Kimi」不许答成 Manus 的窗口型对话', () => {
    const families = [{ id: 'kimi', title: 'Kimi' }, { id: 'manus', title: 'Manus' }]
    const pool: readonly RelaySessionView[] = [dramaWise, view({ agent: 'im.manus.desktop', session_id: 'window:1111', title: 'Token Factory' })]
    // 登记表里那条的 agent 是包标识 —— 家名由 agentName 换成正名(同 relayAgentName)。
    const name = (agent: string): string => (agent === 'im.manus.desktop' || agent === 'manus' ? 'Manus' : sessionAgentName(agent))
    const found = lookupSession({ sessions: pool, who: 'Kimi 现在什么状态', agentName: name, now: NOW, families })
    expect(found.kind).toBe('none')
    expect(found.line).toContain('Kimi')
    expect(found.line).toContain('没有在跑的对话')
  })

  it('★包标识那一条也按家名筛得到:「Manus 在干什么」认的是它自己那条窗口型对话', () => {
    const families = [{ id: 'kimi', title: 'Kimi' }, { id: 'manus', title: 'Manus' }]
    const running = { ...dramaWise, agent: 'im.manus.desktop', status: 'running' as const }
    const name = (agent: string): string => (agent === 'im.manus.desktop' || agent === 'manus' ? 'Manus' : sessionAgentName(agent))
    const found = lookupSession({ sessions: [running], who: 'Manus 在干什么', agentName: name, now: NOW, families })
    expect(found.kind).toBe('one')
    if (found.kind !== 'one') return
    expect(found).toMatchObject({ agent: 'im.manus.desktop', session_id: 'window:825f1900' })
  })
})

describe('场景三:给正在跑的那条发信息 —— 补一句 / 打断再发', () => {
  it('★「补一句」:它在跑,话排进去,回执说清「排在它后面」', async () => {
    const t = serviceWith([dramaWiseRunning], { reply: shell() })
    const sent = await t.service.relay('manus', 'window:825f1900', '顺手把标题也改一下')
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.queued).toBe(true)
    expect(sent.interrupted).toBeUndefined()
    // 补一句**不碰停止键**
    expect(t.requests.some(one => one.op === 'agent_stop')).toBe(false)
  })

  it('★「打断再发」:先按那家的停止键,停下了才送', async () => {
    const t = serviceWith([dramaWiseRunning], { reply: shell({ stop: { found: true, stopped: true } }) })
    // 不带 interrupt 就只是「补一句」:排进去、**一下停止键都不碰**
    const appended = await t.service.relay('manus', 'window:825f1900', '别做了,改成先出提纲')
    expect(appended.ok).toBe(true)
    expect(t.requests.some(one => one.op === 'agent_stop')).toBe(false)
    const t2 = serviceWith([dramaWiseRunning], { reply: shell({ stop: { found: true, stopped: true } }) })
    const real = await t2.service.relay('manus', 'window:825f1900', '别做了,改成先出提纲', { interrupt: true })
    expect(real.ok).toBe(true)
    if (!real.ok) return
    expect(real.interrupted).toBe(true)
    // 停止键排在打字之前(而且排在**认那条对话**之前 —— 先停下再切、再说)
    expect(t2.requests.findIndex(one => one.op === 'agent_stop'))
      .toBeLessThan(t2.requests.findIndex(one => one.op === 'send_text'))
  })

  it('★认不出停止键 → 不许假装打断:一个字都不打,如实说', async () => {
    const t = serviceWith([dramaWiseRunning], { reply: shell({ stop: { found: false } }) })
    const sent = await t.service.relay('manus', 'window:825f1900', '先停下', { interrupt: true })
    expect(sent.ok).toBe(false)
    if (sent.ok || sent.status !== 200) { expect.fail('该是 200 + 没打断'); return }
    expect(sent.why).toContain('认不出它的停止键')
    expect(t.requests.some(one => one.op === 'send_text')).toBe(false)
  })

  it('★按了停止键它还在跑 → 也不接着往里说', async () => {
    const t = serviceWith([dramaWiseRunning], { reply: shell({ stop: { found: true, stopped: false } }) })
    const sent = await t.service.relay('manus', 'window:825f1900', '先停下', { interrupt: true })
    expect(sent.ok).toBe(false)
    if (sent.ok || sent.status !== 200) { expect.fail('该是 200'); return }
    expect(sent.why).toContain('可它还在跑')
    expect(t.requests.some(one => one.op === 'send_text')).toBe(false)
  })

  it('★这份壳不会按那家的停止键(旧壳)→ 打断如实失败、一个字都不打,「补一句」照旧能送', async () => {
    const old = { reply: shell(), caps: capsWithout('agent_stop') }
    const t = serviceWith([dramaWiseRunning], old)
    const blocked = await t.service.relay('manus', 'window:825f1900', '先停下', { interrupt: true })
    expect(blocked.ok).toBe(false)
    if (blocked.ok || blocked.status !== 200) { expect.fail('该是 200 + 没打断'); return }
    /*
     * ★ 2026-10-02:这一下连那扇窗都不碰 —— 「按停止」这一样这一家此刻排不上队
     * (`registry.picksFor` 现查 `capabilities().stop`),引擎如实说「没有一条能按它的停止的通道」,
     * 后面接上「没打断,也没替你说那句话」。**不说成打断了**那一条没变。
     */
    expect(blocked.why).toContain('没有一条能按它的停止的通道')
    expect(blocked.why).toContain('没打断,也没替你说那句话')
    expect(t.requests.some(one => one.op === 'send_text')).toBe(false)
    const appended = await serviceWith([dramaWiseRunning], old).service.relay('manus', 'window:825f1900', '现在到哪了')
    expect(appended.ok).toBe(true)
  })

  /*
   * ★ 2026-10-02:界面那两格(「摆不摆输入框 / 摆不摆打断」)只有**一处**答案 ——
   * `registry.knownCaps(family)` 的 `send` / `stop`(窗口适配器现查出来的那一份)。
   * 所以这一条先把能力现查一遍再问,与生产里 `/state` 那一拍一样。
   */
  it('★手机卡片问得出「在跑没 / 能不能打断」(动手之前,一只手都不碰)', async () => {
    const can = await readyWith([dramaWiseRunning], { reply: shell() })
    const ready = can.service.relayReady('manus', 'window:825f1900')
    expect(ready).toMatchObject({ can: true, running: true, interrupt: { can: true } })
    expect(can.requests).toEqual([])

    const cannot = await readyWith([dramaWiseRunning], { reply: shell(), caps: capsWithout('agent_stop') })
    const noStop = cannot.service.relayReady('manus', 'window:825f1900')
    expect(noStop).toMatchObject({ can: true, running: true, interrupt: { can: false } })
    if (!noStop.can) return
    expect(noStop.interrupt?.why).toContain('认不出它的停止键')
    expect(cannot.requests).toEqual([])
  })
})

describe('三场景的决策(relayMoveOf,纯函数)', () => {
  it('★停着的:直接送(场景一、场景二)', () => {
    expect(relayMoveOf({ running: false, intent: 'append', kind: 'window', canStop: true })).toEqual({ kind: 'send' })
    // 他说「打断它」可它已经停了:没有什么要打断的,直接送(不去按一颗此刻没有的键)
    expect(relayMoveOf({ running: false, intent: 'interrupt', kind: 'file', canStop: false })).toEqual({ kind: 'send' })
  })

  it('★在跑 + 补一句:框还能打字就排进去;打不进字就如实说,不假装排上了', () => {
    expect(relayMoveOf({ running: true, intent: 'append', kind: 'window', canStop: true })).toEqual({ kind: 'queue' })
    const wait = relayMoveOf({ running: true, intent: 'append', kind: 'window', queues: false, canStop: true })
    expect(wait.kind).toBe('wait')
  })

  it('★在跑 + 打断:窗口那一路按得到停止键才打断', () => {
    expect(relayMoveOf({ running: true, intent: 'interrupt', kind: 'window', canStop: true })).toEqual({ kind: 'stop_then_send' })
    expect(relayMoveOf({ running: true, intent: 'interrupt', kind: 'window', canStop: false }))
      .toMatchObject({ kind: 'refuse' })
  })

  it('★正在干活的 Codex / Claude / Kimi(文件型)一律不打断 —— 维护者明说不许动', () => {
    const move = relayMoveOf({ running: true, intent: 'interrupt', kind: 'file', canStop: true })
    expect(move.kind).toBe('refuse')
    if (move.kind !== 'refuse') return
    expect(move.why).toContain('我不去打断')
    // 「补一句」照旧能送(那是卡 BR 起就有的那条路)
    expect(relayMoveOf({ running: true, intent: 'append', kind: 'file', canStop: true })).toEqual({ kind: 'queue' })
  })

  it('★电话里哪一句算「打断再发」:认不准一律按补一句(多送一句话比无端按停止键轻)', () => {
    for (const said of ['打断它', '先停下', '别做了,改成先出提纲', '停一下', '不用做了']) {
      expect(looksLikeInterrupt(said), said).toBe(true)
    }
    for (const said of ['跟它说一句现在到哪了', '把标题改成蓝色', '问问它做完了没', '再加一句要带数据']) {
      expect(looksLikeInterrupt(said), said).toBe(false)
    }
  })
})

describe('点完那条对话之后拿什么认回它(pickMarkerOf)', () => {
  it('★不要 6 个字那道门:我们亲手点过去的,两个字的对话名也认得回来', () => {
    expect(pickMarkerOf('周报')).toBe('周报')
    expect(pickMarkerOf('DramaWise')).toBe('DramaWise')
    expect(pickMarkerOf('一')).toBeUndefined()
    expect(pickMarkerOf('  ')).toBeUndefined()
    // 最多 20 个字(同 answerMarkerOf)
    expect(pickMarkerOf('一二三四五六七八九十一二三四五六七八九十一二三')).toHaveLength(20)
  })
})
