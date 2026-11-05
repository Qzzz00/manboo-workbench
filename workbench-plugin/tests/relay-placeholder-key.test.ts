// @vitest-environment node
/**
 * **登记回电时会话 id 是占位的那两条路,不许冒充会话键**(2026-10-02,统筹盘点时查出的回归,卡 AG2 引入)。
 *
 * 现场:新开一条捎话(`relayNewConversation.ts`)与「只盯着不发」(`/sessions/relay watch_only`,http.ts)
 * 登记回电时 `session_id` 用的是 `randomUUID()` —— 那一刻还认不出它开的是哪一条对话。
 * 而 `jobKey.jobPhaseOf` 的规矩是「这一家的清单查得到、而这一条不在里面 = 收场」:
 * 只要这家还有别的会话(Claude / Codex / Kimi 基本一定有),回电巡检每 8 秒都被闸判成「已收场」拦下,
 * 结果读不到回话,只能等 20 分钟打一通「还没回」。
 *
 * 守:占位的会话 id 要**如实标出来**(`session_placeholder`),键用这本账自己的 id(`relay:<id>`)——
 * 闸对它只能答「查不出」(放行,次数上限照旧管),不许把「还不知道是哪条」说成「收场了」。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jobPhaseOf, sessionJobId } from '../src/server/jobKey.ts'
import { createEngineRelayReader, createRelayWatchService, relayJobOf, sanitizeRelayWatchFile } from '../src/server/relayWatch.ts'
import { engineHarness } from './helpers/engineHarness.ts'

describe('占位会话 id 的捎话:键与闸', () => {
  it('★键:占位 id 不拼成会话键,用账上自己的 id;真会话 id 照旧;有事项优先事项', () => {
    expect(relayJobOf({ id: 'w-1', agent: 'claude', session_id: 'e0f1-random', session_placeholder: true })).toBe('relay:w-1')
    expect(relayJobOf({ id: 'w-1', agent: 'claude', session_id: 'abc123' })).toBe(sessionJobId('claude', 'abc123'))
    expect(relayJobOf({ id: 'w-1', agent: 'claude', session_id: 'e0f1-random', session_placeholder: true, item_id: 't-9' })).toBe('t-9')
  })

  it('★闸的判法:占位键答「查不出」(放行);同样情形拼成会话键就会被误判成「收场」—— 这就是那个回归', () => {
    const sessions = [{ agent: 'claude', session_id: 'another-real-session' }]
    expect(jobPhaseOf({ job: 'relay:w-1', tasks: [], sessions })).toBe('unknown')
    expect(jobPhaseOf({ job: sessionJobId('claude', 'e0f1-random'), tasks: [], sessions })).toBe('settled')
  })

  /*
   * ★ 2026-10-02(卡「引擎接线与删复制品」):闸从巡检这一层搬去了引擎一处
   * (`reply_watch` 在 `engine.read` 里面)。所以这一条改成**端到端**跑:
   * 假壳 + 真引擎 + 真闸 + 真巡检 —— 占位那一条照旧每一拍读得到窗,闸不拦。
   */
  it('★真跑巡检:这家有别的会话、这条是占位 id → 每一拍照旧去读窗,闸不拦', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-placeholder-'))
    try {
      let nowMs = 0
      const sessions = [{ agent: 'claude', session_id: 'another-real-session' }]
      const h = engineHarness({
        // 闸的判法照生产那一份(`jobKey.jobPhaseOf`):这家有别的会话、这条不在清单里。
        phaseOf: job => jobPhaseOf({ job, tasks: [], sessions }),
        installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
        reply: () => ({ found: false, busy: false, texts: [] }),
        now: () => new Date(nowMs),
      })
      const service = createRelayWatchService({
        file: join(dir, 'relay.json'),
        reader: createEngineRelayReader({ engine: h.engine }),
        now: () => nowMs,
        newId: () => 'w-1',
        pollMs: 0,
      })
      await service.load()
      const wait = await service.remember({
        agent: 'claude', session_id: 'e0f1-random', title: '新会话', mark: '事务官捎话 a1b2c3', from: 'phone', session_placeholder: true,
      })
      expect(wait.session_placeholder).toBe(true)
      // 闸对巡检本来就有「两拍至少隔 3 秒」的上限(另一条规矩,不在这里验),三拍拉开些。
      for (const t of [1000, 5000, 9000]) { nowMs = t; await service.pump() }
      // 三拍都真读了那扇窗(闸一次都没拦;拦下的话一个 op 都不会发)。
      expect(h.requests.filter(one => one.op === 'read_reply')).toHaveLength(3)
      expect(h.events().filter(one => one.step === 'gate_block')).toEqual([])
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('★反过来:同一条拼成会话键 → 闸判「收场」,一个 op 都不发(这就是那个回归的样子)', async () => {
    const sessions = [{ agent: 'claude', session_id: 'another-real-session' }]
    const h = engineHarness({
      phaseOf: job => jobPhaseOf({ job, tasks: [], sessions }),
      installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
      reply: () => ({ found: false, busy: false, texts: [] }),
    })
    const read = createEngineRelayReader({ engine: h.engine })
    // 不标占位 → 键是会话键 → 这家清单查得到、这条不在里面 = 收场 → 拦下。
    await read.read({ agent: 'claude', sessionId: 'e0f1-random', mark: '事务官捎话 a1b2c3', waitId: 'w-1' })
    expect(h.requests).toEqual([])
    expect(h.events().some(one => one.step === 'gate_block')).toBe(true)
  })

  it('★落盘再读回,占位那一格还在(重启后闸照旧不拦)', () => {
    const file = sanitizeRelayWatchFile({ version: 1, waits: [{ id: 'w-1', agent: 'claude', session_id: 'e0f1-random', mark: 'm', title: '新会话', at: '', from: 'phone', state: 'waiting', session_placeholder: true }] })
    expect(file.waits[0]?.session_placeholder).toBe(true)
    expect(relayJobOf(file.waits[0]!)).toBe('relay:w-1')
  })
})
