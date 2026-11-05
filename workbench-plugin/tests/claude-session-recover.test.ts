// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSessionRecoverDeps } from '../src/server/claudeSessionRecover.ts'
import { createClaudeSessionRecover } from '../src/server/claudeSessionRecover.ts'

const NOW_SEC = 1_788_330_000
const FRESH_MS = (NOW_SEC - 120) * 1000 // 2 分钟前
const STALE_MS = (NOW_SEC - 10_800) * 1000 // 3 小时前

const P_A = '/home/.claude/projects/-Users-ben-GitHub-KOUKOU/aaa-1.jsonl'
const P_B = '/home/.claude/projects/-Users-ben-GitHub-Echo/bbb-2.jsonl'

function line(o: unknown): string { return JSON.stringify(o) }
const WORKING = [
  line({ type: 'user', cwd: '/Users/example/GitHub/KOUKOU', message: { role: 'user' } }),
  line({ type: 'assistant', cwd: '/Users/example/GitHub/KOUKOU', message: { role: 'assistant', stop_reason: 'tool_use' } }),
].join('\n')
const FINISHED = [
  line({ type: 'user', cwd: '/Users/example/GitHub/Echo', message: { role: 'user' } }),
  line({ type: 'assistant', cwd: '/Users/example/GitHub/Echo', message: { role: 'assistant', stop_reason: 'end_turn' } }),
].join('\n')

function deps(files: Record<string, string>, mtimes: Record<string, number>): ClaudeSessionRecoverDeps {
  return {
    listRecentTranscripts: async () => Object.keys(files),
    statMtimeMs: async (p: string) => mtimes[p],
    readTail: async (p: string) => files[p] ?? '',
  }
}

/**
 * 2026-09-02 真机:Mac 重启 + DSH 重启后,Ben 有两个 Claude 会话在跑,标签上一个气泡都没有。
 * 根因与 Codex 同类——Claude 靠 hook 推送,而会话表只在内存里;**重启前就在跑的会话
 * 要等下一次 hook 事件才会重新出现**。这条兜底扫一遍最近写过的会话文件把它们捞回来。
 *
 * 纪律:只捞**正在跑**的。已完成的不回放——那会凭空冒出蓝点(未读完成),
 * 而他可能早就看过了(同 codexSessionFeed 的"启动不回放历史")。
 */
describe('Claude 会话恢复(重启后把在跑的捞回来)', () => {
  it('★正在干活的会话(末尾 stop_reason=tool_use)被报成 running,带上 cwd', async () => {
    const applyEvent = vi.fn()
    const rec = createClaudeSessionRecover(
      deps({ [P_A]: WORKING }, { [P_A]: FRESH_MS }),
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] },
    )
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({
      agent: 'claude', session_id: 'aaa-1', type: 'running', cwd: '/Users/example/GitHub/KOUKOU',
    })
  })

  /**
   * ★★**改过口径的一条**(2026-09-26,卡 V 补;维护者:「现在应该是 3 完成 1 进行中」)。
   *
   * 这一条原来断言的是**相反**的事:「已经收尾的会话不回放 —— 免得凭空冒出一个未读蓝点」。
   * 那是 2026-09-02 的写法,当时唯一的办法就是不报:重启七八次,他早就看过的完成会话每次都翻回未读蓝点。
   *
   * 两件事让它过时了:
   * ① **已读簿**(`readMarks.ts`,同一天补的)会跨重启记住「他看过了」,`applyEvent` 不会再把它翻回未读 ——
   *    当初那个顾虑没了;
   * ② 不报的代价这次现形了:09-26 他桌面里**三条做完的 Claude 会话在 `/state` 里一条都没有**,
   *    Claude 标签上本该是蓝色的「3」,结果一个蓝点都没有 —— 做完的活整条看不见,比多一个蓝点糟得多。
   *
   * 现在:窗口内的一律报,做完的进「完成 · 未读」那一档。仍然不报的只剩 `offline`(见下一条)。
   */
  it('★★已经收尾的会话(end_turn)**要**报成 done —— 做完的活得看得见(蓝点那一档)', async () => {
    const applyEvent = vi.fn()
    const rec = createClaudeSessionRecover(
      deps({ [P_B]: FINISHED }, { [P_B]: FRESH_MS }),
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] },
    )
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({
      agent: 'claude', session_id: 'bbb-2', type: 'done', cwd: '/Users/example/GitHub/Echo',
    })
  })

  /**
   * 仍然不报的那一种:**第一次见到就已经判成「关掉了 / 中断了」**。
   * 报一条「中断」毫无用处 —— 他没在等它、也点不动它,还会把上一命的残留会话拖进列表。
   * (这里:文件停在半路 + pid 文件在而这条不在里面 → 没人在写它 → 中断。)
   */
  it('第一次见到就判成中断的不报(没人在等它,报了只是噪音)', async () => {
    const applyEvent = vi.fn()
    const rec = createClaudeSessionRecover(
      {
        ...deps({ [P_A]: WORKING }, { [P_A]: FRESH_MS }),
        // 那份「此刻开着的会话」在,而 aaa-1 不在里面 → 写它的进程已经没了。
        readLiveSessions: async () => new Map([['zzz-9', { alive: true, status: 'idle' }]]),
      },
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] },
    )
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('★hook 已经在管的会话不插手(避免和推送打架)', async () => {
    const applyEvent = vi.fn()
    const rec = createClaudeSessionRecover(
      deps({ [P_A]: WORKING }, { [P_A]: FRESH_MS }),
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => ['aaa-1'] },
    )
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('陈旧文件(超过阈值没动)不捞', async () => {
    const applyEvent = vi.fn()
    const rec = createClaudeSessionRecover(
      deps({ [P_A]: WORKING }, { [P_A]: STALE_MS }),
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] },
    )
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('限频:连着调两次只扫一轮', async () => {
    const applyEvent = vi.fn()
    let listCalls = 0
    const d = deps({ [P_A]: WORKING }, { [P_A]: FRESH_MS })
    const rec = createClaudeSessionRecover(
      { ...d, listRecentTranscripts: async () => { listCalls += 1; return [P_A] } },
      { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] },
    )
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(listCalls).toBe(1)
  })
})

/**
 * 2026-09-25(卡 P):从「捞一次」改成「跟着读」。维护者机器上没接 hook(`~/.claude/settings.json` 是 `{}`),
 * Claude 会话只能从会话文件进来;旧版捞一次就再也不看 —— 说完了的那条一直挂着「进行中 · 19 分钟」,
 * 标题永远是「Claude 的一条会话」。
 */
describe('Claude 会话跟着读(卡 P)', () => {
  const DESKTOP_WORKING = [
    line({ type: 'user', cwd: '/Users/example/GitHub/KOUKOU', entrypoint: 'claude-desktop', timestamp: '2026-09-02T00:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '把球做大一点' } }),
    line({ type: 'assistant', cwd: '/Users/example/GitHub/KOUKOU', entrypoint: 'claude-desktop', timestamp: '2026-09-02T00:01:00.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '我先看一下球的尺寸设置。' }] } }),
  ].join('\n')
  const DESKTOP_DONE = [
    DESKTOP_WORKING,
    line({ type: 'assistant', cwd: '/Users/example/GitHub/KOUKOU', entrypoint: 'claude-desktop', timestamp: '2026-09-02T00:05:00.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '改好了。' }] } }),
  ].join('\n')

  function followDeps(state: { files: Record<string, string>, mtimes: Record<string, number>, live?: Map<string, { name?: string, status?: string, alive: boolean }> }): ClaudeSessionRecoverDeps {
    return {
      listRecentTranscripts: async () => Object.keys(state.files),
      statMtimeMs: async (p: string) => state.mtimes[p],
      readTail: async (p: string) => state.files[p] ?? '',
      readDigest: async (p: string, name?: string) => {
        const { digestClaude } = await import('../src/server/sessionDigest.ts')
        const text = state.files[p] ?? ''
        return digestClaude({ head: text, tail: text, ...(name === undefined ? {} : { name }) })
      },
      readLiveSessions: async () => state.live,
    }
  }

  it('★报过「在跑」的会话说完了(文件动了、末尾 end_turn)→ 补报 done;事件里带标题与在做什么', async () => {
    const applyEvent = vi.fn()
    let clock = NOW_SEC
    const state = { files: { [P_A]: WORKING.replace('"role":"user"}', '"role":"user","content":"把球做大一点"}') }, mtimes: { [P_A]: FRESH_MS } as Record<string, number> }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent, now: () => clock, knownSessionIds: () => [], minIntervalMs: 0 })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'running', title: '把球做大一点' })
    state.files[P_A] = FINISHED
    state.mtimes[P_A] = FRESH_MS + 60_000
    clock += 30
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ agent: 'claude', session_id: 'aaa-1', type: 'done' })
  })

  it('★文件没动就一个字节都不读(限频之外的第二道省电)', async () => {
    const applyEvent = vi.fn()
    let reads = 0
    let clock = NOW_SEC
    const state = { files: { [P_A]: WORKING }, mtimes: { [P_A]: FRESH_MS } }
    const base = followDeps(state)
    const rec = createClaudeSessionRecover({ ...base, readTail: async (p) => { reads += 1; return base.readTail(p) } }, { applyEvent, now: () => clock, knownSessionIds: () => [], minIntervalMs: 0 })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    clock += 30
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(reads).toBe(1)
  })

  /**
   * 2026-09-26(卡 V 补)改了后半句:`idle` 那条现在**报成 done**(蓝点那一档),不再「第一次见不回放」——
   * 理由见上面那条 ★★ 用例的注释(做完的活得看得见;已读簿管住了「凭空冒未读」那个老顾虑)。
   * 前半句一字没动:那份「开着的会话」说 busy 就是在跑,文件末尾看着像什么都不算。
   */
  it('★桌面 App 记着的「此刻开着的会话」说了算:busy = 在跑(标题用会话名),idle = 做完了(报 done)', async () => {
    const applyEvent = vi.fn()
    const live = new Map([['aaa-1', { name: 'Desktop-workbench 统筹交接', status: 'busy', alive: true }], ['bbb-2', { name: '空间快不足了', status: 'idle', alive: true }]])
    // bbb-2 的文件末尾看着「还在干活」(tool_use),但它自己说 idle —— **听它的**:做完了,报 done。
    const state = { files: { [P_A]: DESKTOP_WORKING, [P_B]: WORKING }, mtimes: { [P_A]: FRESH_MS, [P_B]: FRESH_MS }, live }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    const byId = new Map(applyEvent.mock.calls.map(call => [(call[0] as { session_id: string }).session_id, call[0]]))
    expect(byId.get('aaa-1')).toMatchObject({
      session_id: 'aaa-1', type: 'running', title: 'Desktop-workbench 统筹交接',
      activity: { line: '我先看一下球的尺寸设置。', at: '2026-09-02T00:01:00.000Z' },
    })
    // 进程在、它说自己空闲 → 做完了(不是 waiting、不是 running)。
    expect(byId.get('bbb-2')).toMatchObject({ session_id: 'bbb-2', type: 'done', title: '空间快不足了' })
  })

  it('★桌面 App 的会话关掉了(不在「开着的会话」里)→ 报过的补一条 offline', async () => {
    const applyEvent = vi.fn()
    let clock = NOW_SEC
    const state = { files: { [P_A]: DESKTOP_WORKING }, mtimes: { [P_A]: FRESH_MS } as Record<string, number>, live: new Map([['aaa-1', { status: 'busy', alive: true }]]) as Map<string, { name?: string, status?: string, alive: boolean }> }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent, now: () => clock, knownSessionIds: () => [], minIntervalMs: 0 })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    state.live = new Map([['zzz', { status: 'idle', alive: true }]])
    clock += 30
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(2))
    expect(applyEvent.mock.calls[1]![0]).toMatchObject({ session_id: 'aaa-1', type: 'offline', project: '' })
  })

  it('★hook 在管的会话:不改状态,只补标题与在做什么', async () => {
    const applyEvent = vi.fn()
    const setDetail = vi.fn()
    const state = { files: { [P_A]: DESKTOP_DONE }, mtimes: { [P_A]: FRESH_MS } }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent, setDetail, now: () => NOW_SEC, knownSessionIds: () => ['aaa-1'] })
    rec.recover()
    await vi.waitFor(() => expect(setDetail).toHaveBeenCalledTimes(1))
    expect(applyEvent).not.toHaveBeenCalled()
    expect(setDetail.mock.calls[0]).toEqual(['aaa-1', { title: '把球做大一点', activity: { line: '改好了。', at: '2026-09-02T00:05:00.000Z' } }])
  })

  /**
   * 2026-09-26 晚(统筹,维护者:「左侧应用标签的蓝点还没好」):Claude 那一格的蓝 1 是一条
   * `cwd: "/"`、`turnOrigin: "sdk"` 的「What is 2+2? Reply with just the number.」——
   * 程序起的一次性会话,没有一句人打的字。它走的是钩子那一路,原来钩子在管的会话**只补标题**,
   * 探针的判据只在「文件说报错 / 中断」时才带上,于是它一路被当成他的会话、做完未读。
   */
  it('★hook 在管的会话也认探针:SDK 起的、没有一句人打的字 → setDetail 带 selfcheck', async () => {
    const setDetail = vi.fn()
    const SDK_PROBE = [
      line({ type: 'user', cwd: '/', entrypoint: 'sdk-ts', turnOrigin: 'sdk', timestamp: '2026-09-02T00:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'What is 2+2? Reply with just the number.' }] } }),
      line({ type: 'assistant', cwd: '/', entrypoint: 'sdk-ts', turnOrigin: 'sdk', timestamp: '2026-09-02T00:05:01.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '4' }] } }),
    ].join('\n')
    const state = { files: { [P_A]: SDK_PROBE }, mtimes: { [P_A]: FRESH_MS } }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent: vi.fn(), setDetail, now: () => NOW_SEC, knownSessionIds: () => ['aaa-1'] })
    rec.recover()
    await vi.waitFor(() => expect(setDetail).toHaveBeenCalledTimes(1))
    expect(setDetail.mock.calls[0]![1]).toMatchObject({ selfcheck: { by: 'sdk' } })
  })

  it('读到的文件登记下来(点开详情时按会话 id 找文件),带上会话名', async () => {
    const onFile = vi.fn()
    const state = { files: { [P_A]: DESKTOP_WORKING }, mtimes: { [P_A]: FRESH_MS }, live: new Map([['aaa-1', { name: '统筹', status: 'busy', alive: true }]]) }
    const rec = createClaudeSessionRecover(followDeps(state), { applyEvent: vi.fn(), onFile, now: () => NOW_SEC, knownSessionIds: () => [] })
    rec.recover()
    await vi.waitFor(() => expect(onFile).toHaveBeenCalledWith('aaa-1', P_A, '统筹'))
  })
})

describe('停下来等他(卡 T「在等你」)', () => {
  function followDeps(state: { files: Record<string, string>, mtimes: Record<string, number>, live?: Map<string, { name?: string, status?: string, waitingFor?: string, alive: boolean }> }): ClaudeSessionRecoverDeps {
    return {
      listRecentTranscripts: async () => Object.keys(state.files),
      statMtimeMs: async (p: string) => state.mtimes[p],
      readTail: async (p: string) => state.files[p] ?? '',
      readLiveSessions: async () => state.live,
    }
  }

  it('★Claude 自己记着 waiting + permission prompt(没接 hook 的机器上只有这里看得到)→ 报 waiting / 等审批,第一次见也报', async () => {
    const applyEvent = vi.fn()
    const live = new Map([['aaa-1', { status: 'waiting', waitingFor: 'permission prompt', alive: true }]])
    const rec = createClaudeSessionRecover(followDeps({ files: { [P_A]: WORKING }, mtimes: { [P_A]: FRESH_MS }, live }), { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ session_id: 'aaa-1', type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
  })

  it('提问弹窗(input needed)→ waiting / 等你输入(不响铃:reason 是 idle_prompt)', async () => {
    const applyEvent = vi.fn()
    const live = new Map([['aaa-1', { status: 'waiting', waitingFor: 'input needed', alive: true }]])
    const rec = createClaudeSessionRecover(followDeps({ files: { [P_A]: WORKING }, mtimes: { [P_A]: FRESH_MS }, live }), { applyEvent, now: () => NOW_SEC, knownSessionIds: () => [] })
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ type: 'waiting', reason: 'idle_prompt', wait_reason: 'input' })
  })

  /**
   * 2026-09-26(卡 V 补)改了前提:说完了的**当场就报**(done),不再等「在等你」判出来才回放。
   *
   * 卡 T 当初要那条反向口子(`waitingIfIdle`)是因为:说完了的会话根本不进会话表,
   * `overlayWaiting` 没有一行可以把 `ask` 挂上去。现在表里有了 —— 这一条钉的就是这个前提:
   * **说完了的那条在表里,而且状态是 done**(那一问由 `overlayWaiting` 出 /state 时叠上去,
   * 见 tests/session-done-visible.test.ts 的第三组)。
   */
  it('★说完了的当场报 done —— 在等他的那一问有一行可以挂(不必再反向回放)', async () => {
    const applyEvent = vi.fn()
    let clock = NOW_SEC
    let reads = 0
    const live = new Map([['bbb-2', { status: 'idle', alive: true }]])
    const base = followDeps({ files: { [P_B]: FINISHED }, mtimes: { [P_B]: FRESH_MS }, live })
    const rec = createClaudeSessionRecover(
      { ...base, readTail: async (p: string) => { reads += 1; return base.readTail(p) } },
      { applyEvent, now: () => clock, knownSessionIds: () => [], minIntervalMs: 0 },
    )
    rec.recover()
    await vi.waitFor(() => expect(applyEvent).toHaveBeenCalledTimes(1))
    expect(applyEvent.mock.calls[0]![0]).toMatchObject({ session_id: 'bbb-2', type: 'done' })
    expect(reads).toBe(1)

    // 文件没动、那份「开着的会话」也没变:这一轮该一个字节都不读,也不再报一遍。
    clock += 30
    rec.recover()
    await new Promise(r => setTimeout(r, 30))
    expect(reads).toBe(1)
    expect(applyEvent).toHaveBeenCalledTimes(1)
  })
})

describe('readClaudeLiveSessions:只读 .json,不碰 .key', () => {
  it('读名字 / 忙闲;进程不在的那份记 alive:false;.key 文件不读', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readClaudeLiveSessions } = await import('../src/server/claudeSessionRecover.ts')
    const home = mkdtempSync(join(tmpdir(), 'claude-live-'))
    try {
      mkdirSync(join(home, 'sessions'))
      writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'aaa-1', name: '统筹交接', status: 'busy', statusUpdatedAt: 1790315598225 }))
      writeFileSync(join(home, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'bbb-2', status: 'idle' }))
      // 卡 T:停在弹窗上的那份多一格 waitingFor
      writeFileSync(join(home, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'ccc-3', status: 'waiting', waitingFor: 'permission prompt', hostSessionId: 'local_ab-12', messagingSocketPath: '/tmp/x.sock' }))
      writeFileSync(join(home, 'sessions', `${process.pid}.abc.key`), 'not-json-and-secret')
      const live = await readClaudeLiveSessions(home)
      expect(live?.get('aaa-1')).toEqual({ alive: true, name: '统筹交接', status: 'busy', statusSinceMs: 1790315598225 })
      expect(live?.get('bbb-2')?.alive).toBe(false)
      expect(live?.get('ccc-3')).toEqual({ alive: true, status: 'waiting', waitingFor: 'permission prompt', hostSessionId: 'local_ab-12' })
      expect(live?.size).toBe(3)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
