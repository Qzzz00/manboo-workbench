// @vitest-environment node
/**
 * 「这条会话现在能不能捎话」(2026-09-27,卡 PS)——`sessionAnswer.relayReady`。
 *
 * 为什么要这一问:手机点开某家在跑的那条会话,卡片下面要摆一个输入框直接往里说话
 * (维护者 22:0x:「还得能直接在下面输入信息,对标最外侧的输入框」)。
 * 送不进去的会话**不摆输入框**(摆了就是个摆设,按下去只会挨一句「你自己去电脑上说」),
 * 换成一行人话说清为什么 —— 所以界面需要**动手之前**就能问出来的一个答案。
 *
 * 守三件事:
 * ① 判据就是真捎话那道门(同一个 `relayGate`):这一家此刻送不送得进话、这条会话在哪儿开的
 *    (终端 / VS Code 里开的打不进字)、认不认得出是哪一家、它是不是弹了个框等他点;
 * ② 说不行时那句人话**与真捎话回的 `why` 一模一样**(两处说法不许各写一遍);
 * ③ 这道门**一只手都不碰**(不 read_reply、不打字)—— 它只是问一句,不是送一句。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):那六只手删了,服务搬到 `sessionJobs.createSessionJobs`,
 * 「这一家此刻送不送得进话」只有**一处**答案 —— `registry.knownCaps(family).send`
 * (窗口适配器现查出来的那一份)。所以这一份用例要先 `await registry.targets()` 现查一遍,
 * 与生产里界面那一拍一样;**界面那一格照旧悲观**:查不到就不摆那个输入框(摆了就是摆设,D13)。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import type { RelayReady } from '../src/server/sessionAnswer.ts'
import { createSessionJobs, type SessionJobsDeps } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const NOW = '2026-09-27T14:05:00.000Z'

/** 那句人话(能捎的时候没有这一句)。 */
const whyOf = (ready: RelayReady): string | undefined => (ready.can ? undefined : ready.why)

const view = (patch: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: 'desktop-workbench', status: 'running', elapsed_sec: 600, unread: false, updated_at: NOW, ...patch,
})

const 统筹交接 = view({ agent: 'claude', session_id: 'd9991aac-5e0e-4ba6-8dcf-7170236b3763', title: 'Desktop-workbench 统筹交接' })
const kimi = view({ agent: 'kimi', session_id: 'k-1', title: '帮我理一版提纲' })

/**
 * 一套「假壳 + 真引擎 + 会话服务」。这一组用例里壳**一个 op 都不该收到** ——
 * 问「能不能捎」不许碰她的窗口。
 *
 * `await rig(...)` 里把每条通道的 `capabilities()` 现查一遍(界面那几格读的是那一份同步缓存);
 * 钟**定住**,免得同一条用例里那一份缓存过期变回「还没查过」。
 */
async function rig(input: {
  sessions: readonly SessionView[]
  service?: Omit<SessionJobsDeps, 'engine' | 'registry' | 'sessions'>
  engine?: EngineHarnessOptions
}) {
  const h = engineHarness({ nameOf: sessionAgentName, now: () => new Date(NOW), ...input.engine })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => input.sessions,
    agentName: sessionAgentName,
    ...input.service,
  })
  await h.registry.targets()
  return { ...h, service }
}

describe('能不能往这条会话里捎话(动手之前问得出来)', () => {
  it('★桌面 App 开的那条(有深链、这一家此刻送得进话)→ 能捎;一只手都没碰', async () => {
    const t = await rig({
      sessions: [统筹交接],
      service: { entryOf: () => 'claude-desktop', hostIdOf: () => 'local_d9991aac' },
    })
    // 卡 WR(2026-09-28)起这一份还带「在跑没 / 能不能替他打断」两格(手机卡片那颗次级键看它)。
    expect(t.service.relayReady('claude', 统筹交接.session_id)).toMatchObject({ can: true })
    expect(t.requests).toEqual([])
  })

  it('★没深链、只有标题(Kimi)→ 2026-10-01 起照样能捎(卡 AW:开到台前、照发、按证据核)', async () => {
    const t = await rig({ sessions: [kimi] })
    expect(t.service.relayReady('kimi', 'k-1')).toMatchObject({ can: true })
    // 问「能不能捎」照旧一只手都不碰
    expect(t.requests).toEqual([])

    // 给一截只属于那一段的原文(它最后说的那几行)照旧更稳 —— 同真捎话那条路的判据
    const withMarker = await rig({ sessions: [kimi], service: { markersOf: () => ['提纲我列了三版,你看第二版行不行'] } })
    expect(withMarker.service.relayReady('kimi', 'k-1')).toMatchObject({ can: true })
  })

  /*
   * ★ 2026-10-02:这一条的判据换了出处(行为一个字没变)—— 从前问「那只手接上了没有」
   * (`deps.window !== undefined`),现在问**一处**现查来的 `knownCaps(family).send`:
   * 壳没连上 → 窗口那条通道的 `capabilities().send` 是假 → 不摆输入框,换一行人话。
   */
  it('★壳没接上:不能捎,人话是「你到电脑上的 Claude 里自己说」—— 与真捎话回的那一句一模一样', async () => {
    const t = await rig({
      sessions: [统筹交接],
      service: { entryOf: () => 'claude-desktop' },
      engine: { connected: () => false },
    })
    const ready = t.service.relayReady('claude', 统筹交接.session_id)
    expect(ready).toMatchObject({ can: false, why: '这句话得你到电脑上的 Claude 里自己说' })
    const sent = await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')
    if (sent.ok || sent.status !== 200) { expect.fail('这一条该是 200 + 捎不进去'); return }
    expect(sent.why).toBe(whyOf(ready))
    // 问也好、真捎也好:一个 op 都没发出去
    expect(t.requests).toEqual([])
  })

  /*
   * ★ 2026-10-20(卡 D):终端里开的那条不再按 entry 先拒,只许协议那只手(socket)。
   * 这一份没登记 socket 那条 → 一只手都够不着 → 照旧这一句;窗口那只手不接(一个 op 都没发)。
   * 有 socket 时能捎:`session-relay-entry-hands.test.ts`。
   */
  it('★终端里开的那条、没有 socket 那只手:捎不进去,人话说的是那个终端窗口 —— 而且与真捎话回的那一句一模一样', async () => {
    const t = await rig({ sessions: [统筹交接], service: { entryOf: () => 'cli' } })
    const ready = t.service.relayReady('claude', 统筹交接.session_id)
    expect(ready).toMatchObject({
      can: false,
      why: '这句话得你到电脑上开着 Claude 的那个终端窗口里自己说',
    })
    const sent = await t.service.relay('claude', 统筹交接.session_id, '现在到哪了')
    if (sent.ok || sent.status !== 200) { expect.fail('这一条该是 200 + 捎不进去'); return }
    expect(sent.why).toBe(whyOf(ready))
    expect(t.requests).toEqual([])
  })

  /*
   * ★ 2026-10-20(卡 D):派活起的那种 Codex 会话按 App 线程办(探针 55b38005:同一份 rollout、同一把写锁),
   * 这一家此刻送得进话就摆输入框;送不进时那句话照旧(见下一条)。
   */
  it('★派活起的 Codex(exec):这一家送得进话 → 能捎(与 App 开的同一支);一只手都没碰', async () => {
    const exec = view({ agent: 'codex', session_id: 'c-exec', title: '把导出 PDF 做出来' })
    const t = await rig({ sessions: [exec], service: { entryOf: () => 'exec' } })
    expect(t.service.relayReady('codex', 'c-exec')).toMatchObject({ can: true })
    expect(t.requests).toEqual([])
  })

  it('派活起的 Codex(exec)、壳没连上:捎不进去,如实说去电脑上的 Codex 里说,「去回答」照旧摆着', async () => {
    const exec = view({ agent: 'codex', session_id: 'c-exec', title: '把导出 PDF 做出来' })
    const t = await rig({ sessions: [exec], service: { entryOf: () => 'exec' }, engine: { connected: () => false } })
    expect(t.service.relayReady('codex', 'c-exec')).toEqual({
      can: false,
      why: '这句话得你到电脑上的 Codex 里自己说',
      reveal: true,
    })
    expect(t.requests).toEqual([])
  })

  it('它那边弹了个框等他点 → 不能捎(打字送不进去,得去那家里点)', async () => {
    const popup = { ...统筹交接, status: 'waiting' as const, ask: { kind: 'approve' as const, question: '要不要允许', since: NOW, by: 'form' as const } }
    const t = await rig({
      sessions: [popup],
      service: { entryOf: () => 'claude-desktop', hostIdOf: () => 'local_d9991aac' },
    })
    const ready = t.service.relayReady('claude', popup.session_id)
    expect(ready.can).toBe(false)
    expect(whyOf(ready)).toContain('它那边弹了个框等你点')
    expect(t.requests).toEqual([])
  })

  /**
   * ★ **只有记录文件、不在会话表里的那条**(2026-10-13 夜,卡 X)。真机:工作台两次发版重启后,维护者点开 Codex
   * 「查询 GoSim 深圳活动日期」—— 卡 W 让对话读得出来了,可这道门只认会话表,照旧「那条会话不在了」,输入框不摆。
   */
  it('★只在记录登记表里的那条(重启后点开的旧会话)→ 也算候选,能捎;会话表里有同一条时以会话表为准', async () => {
    const old = view({ agent: 'kimi', session_id: 'k-old', title: '上周那版提纲', status: 'done' })
    const t = await rig({ sessions: [], service: { recordedSessions: () => [old] } })
    expect(t.service.relayReady('kimi', 'k-old')).toMatchObject({ can: true })
    expect(t.requests).toEqual([])
    // 会话表里的那一份优先(状态 / 标题以它为准),不会重复出现在候选里。
    const live = { ...old, title: '提纲(在跑)', status: 'running' as const }
    const t2 = await rig({ sessions: [live], service: { recordedSessions: () => [old] } })
    expect(t2.service.relayReady('kimi', 'k-old')).toMatchObject({ can: true })
  })

  it('那条会话不在了 → 不能捎,如实说', async () => {
    const t = await rig({ sessions: [统筹交接] })
    expect(t.service.relayReady('claude', '没这条')).toEqual({
      can: false,
      why: '那条会话不在了(关掉了,或者这会儿认不出来)',
    })
  })
})
