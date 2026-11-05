// @vitest-environment node
/**
 * 捎完话、那家回了,**回电话给他**(2026-09-27,卡 CB)。
 *
 * 维护者原话:「我在手机上问了事务官,理论上事务官去问了对应的 AI 之后,事务官得回电话给我。」
 *
 * 这一份钉的是那条回程:轻账 → 按记号读回话 → 排一通电话。守:
 * ① 连着两次读回来一字不差才算它说完了(流式读到一半不当回话);那家还在生成不算;
 * ② 读到了排一通 `reason:'relay'`,`item_id` 是 `relay:<轻账 id>`,电话里念的那一句是**原样的回话**;
 * ③ 等过头(缺省 20 分钟)也回电,说「还没回」——**不沉默**;
 * ④ 一条捎话最多一通电话;排不出来(上一通还在响)下一拍再试;
 * ⑤ **免打扰时段只发通知不响铃**(卡 QH 那条规矩,这一类照样认);
 * ⑥ 轻账里**没有他捎进去那句话**(卡 BR 那条「他的话不落盘」没松);
 * ⑦ 一条都没在等回话时,一次窗口都不读。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCallOutService } from '../src/server/callOut.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import {
  RELAY_WAIT_MAX,
  RELAY_WAIT_MAX_MS,
  createEngineRelayReader,
  createRelayWatchService,
  planRelayWatch,
  relayCallItemId,
  relayCallNoteOf,
  relayCallTitleOf,
  relayIdOfItem,
  relayNoteBody,
  sanitizeRelayWatchFile,
  trimRelayWaits,
  type RelayReader,
  type RelayWait,
} from '../src/server/relayWatch.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-relay-watch-'))
  dirs.push(dir)
  return dir
}

const T0 = Date.parse('2026-09-27T10:00:00.000Z')

function wait(patch: Partial<RelayWait> = {}): RelayWait {
  return {
    id: 'r-1a2b3c',
    agent: 'claude',
    session_id: 'd9991aac',
    title: 'Desktop-workbench 统筹交接',
    mark: '事务官捎话 d9991a',
    at: new Date(T0).toISOString(),
    from: 'phone',
    state: 'waiting',
    ...patch,
  }
}

/** 假的窗口:一次一次按剧本回。记下读过几次。 */
function reader(script: readonly { found: boolean, busy?: boolean, text?: string }[]): RelayReader & { reads: number } {
  let i = 0
  const fake = {
    reads: 0,
    async read() {
      fake.reads += 1
      const step = script[Math.min(i, script.length - 1)] ?? { found: false }
      i += 1
      return { found: step.found, busy: step.busy === true, text: step.text ?? '' }
    },
  }
  return fake
}

/** 假的座机:记下排过哪几通。 */
function ringer(options: { fail?: number } = {}) {
  const calls: { reason: string, item_id: string, title?: string, note?: string }[] = []
  let refused = 0
  return {
    calls,
    request: async (input: { reason: string, item_id: string, title?: string, note?: string }) => {
      if (refused < (options.fail ?? 0)) { refused += 1; return { ok: false, error: '这一件正在响,没有再排一通' } }
      calls.push(input)
      return { ok: true, entry: { id: `c-${calls.length}` } }
    },
  }
}

describe('planRelayWatch:这一拍要做什么', () => {
  it('还在等、没过头 → 去读窗口;别的什么都不做', () => {
    const plan = planRelayWatch({ waits: [wait()], now: T0 + 60_000 })
    expect(plan.poll.map(one => one.id)).toEqual(['r-1a2b3c'])
    expect(plan.timeout).toEqual([])
    expect(plan.call).toEqual([])
  })

  it('★等过头了 → 不再读窗口,转 timeout 并且要打一通(缺省 20 分钟)', () => {
    expect(RELAY_WAIT_MAX_MS).toBe(20 * 60 * 1000)
    const plan = planRelayWatch({ waits: [wait()], now: T0 + RELAY_WAIT_MAX_MS })
    expect(plan.poll).toEqual([])
    expect(plan.timeout.map(one => one.id)).toEqual(['r-1a2b3c'])
    expect(plan.call.map(one => one.id)).toEqual(['r-1a2b3c'])
  })

  it('回了、还没打过 → 打;已经打过(有 call_id)→ 不再打', () => {
    const replied = wait({ id: 'r-a', state: 'replied', reply: '到第三步了' })
    const called = wait({ id: 'r-b', state: 'replied', reply: '好了', call_id: 'c-1' })
    const plan = planRelayWatch({ waits: [replied, called], now: T0 })
    expect(plan.call.map(one => one.id)).toEqual(['r-a'])
  })

  it('捎话那一通不挂看板:item_id 有自己的一段(relay:<轻账 id>),认得回去', () => {
    expect(relayCallItemId('r-1a2b3c')).toBe('relay:r-1a2b3c')
    expect(relayIdOfItem('relay:r-1a2b3c')).toBe('r-1a2b3c')
    expect(relayIdOfItem('t-9f8e7d')).toBeUndefined()
    expect(relayIdOfItem('relay:')).toBeUndefined()
  })
})

describe('念给他听的那两句', () => {
  const name = (agent: string) => (agent === 'claude' ? 'Claude' : agent)

  it('标题:家名 +「那条会话」,英文名后面空一格;标题空着就只剩家名', () => {
    expect(relayCallTitleOf(wait(), name)).toBe('Claude 「Desktop-workbench 统筹交接」')
    expect(relayCallTitleOf(wait({ title: '' }), name)).toBe('Claude')
  })

  it('★回了:那一句里是**原样的回话**(不改写、不摘要)', () => {
    const note = relayCallNoteOf(wait({ state: 'replied', reply: '正在写交接,大概还要十分钟' }), T0 + 60_000)
    expect(note).toBe('你手机上让我捎的那句话,它回了。它的原话:正在写交接,大概还要十分钟')
  })

  it('从哪一端问的就说哪一端(电话里让捎的 →「你电话里让我捎的那句话」)', () => {
    expect(relayCallNoteOf(wait({ from: 'call', state: 'replied', reply: '好' }), T0)).toContain('你电话里让我捎的那句话')
    expect(relayCallNoteOf(wait({ from: 'desk', state: 'replied', reply: '好' }), T0)).toContain('你电脑上让我捎的那句话')
  })

  it('太长了截断,**明说还有**(全文在那家窗口里);读回来是空的也如实说', () => {
    const long = '一'.repeat(700)
    const body = relayNoteBody(long)
    expect(body.truncated).toBe(true)
    expect(body.text.length).toBe(601)
    expect(relayCallNoteOf(wait({ state: 'replied', reply: long }), T0)).toContain('全文在它那扇窗里')
    expect(relayCallNoteOf(wait({ state: 'replied', reply: '   ' }), T0)).toContain('读回来是空的')
  })

  it('★等太久:如实说还没回、捎进去多久了 —— 不猜它在干嘛', () => {
    const note = relayCallNoteOf(wait({ state: 'timeout' }), T0 + 21 * 60_000)
    expect(note).toBe('你手机上让我捎的那句话,捎进去 21 分钟了,它还没回。')
  })
})

describe('巡检:读回话 → 回电话', () => {
  async function svc(options: {
    reader: RelayReader
    ring?: ReturnType<typeof ringer>
    now: () => number
    timeoutMs?: number
  }) {
    const service = createRelayWatchService({
      file: join(tempDir(), 'relay.json'),
      reader: options.reader,
      ...(options.ring === undefined ? {} : { callOut: options.ring }),
      agentName: agent => (agent === 'claude' ? 'Claude' : agent),
      now: options.now,
      newId: () => 'r-1a2b3c',
      pollMs: 0,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    await service.load()
    return service
  }

  it('★连着两次读回来一字不差才算它说完了;第一次不打电话', async () => {
    const read = reader([
      { found: true, text: '正在写交接' },
      { found: true, text: '正在写交接,大概还要十分钟' },
      { found: true, text: '正在写交接,大概还要十分钟' },
    ])
    const ring = ringer()
    let now = T0
    const service = await svc({ reader: read, ring, now: () => now })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'Desktop-workbench 统筹交接', mark: '事务官捎话 d9991a', from: 'phone' })

    now = T0 + 10_000
    await service.pump()
    expect(ring.calls).toEqual([])
    now = T0 + 20_000
    await service.pump()
    expect(ring.calls).toEqual([])
    now = T0 + 30_000
    await service.pump()
    expect(ring.calls).toHaveLength(1)
    expect(ring.calls[0]).toMatchObject({
      reason: 'relay',
      item_id: 'relay:r-1a2b3c',
      title: 'Claude 「Desktop-workbench 统筹交接」',
    })
    expect(ring.calls[0]?.note).toContain('它的原话:正在写交接,大概还要十分钟')
    expect(service.list()[0]?.state).toBe('replied')
  })

  it('那家还在生成(busy)读到的不算回话', async () => {
    const read = reader([{ found: true, busy: true, text: '正在' }, { found: true, busy: true, text: '正在' }])
    const ring = ringer()
    let now = T0
    const service = await svc({ reader: read, ring, now: () => now })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    now = T0 + 10_000; await service.pump()
    now = T0 + 20_000; await service.pump()
    expect(ring.calls).toEqual([])
    expect(service.list()[0]?.state).toBe('waiting')
  })

  it('★一条捎话最多一通电话(回了之后再跑几拍也不再打)', async () => {
    const read = reader([{ found: true, text: '好了' }])
    const ring = ringer()
    let now = T0
    const service = await svc({ reader: read, ring, now: () => now })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    for (const step of [10_000, 20_000, 30_000, 40_000]) { now = T0 + step; await service.pump() }
    expect(ring.calls).toHaveLength(1)
    expect(service.list()[0]?.call_id).toBe('c-1')
  })

  it('★排不出来(上一通还在响)→ 下一拍再试,成功了才记那通的 id', async () => {
    const read = reader([{ found: true, text: '好了' }])
    const ring = ringer({ fail: 1 })
    let now = T0
    const service = await svc({ reader: read, ring, now: () => now })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    now = T0 + 10_000; await service.pump()
    now = T0 + 20_000; await service.pump()
    expect(ring.calls).toEqual([])
    expect(service.list()[0]?.call_id).toBeUndefined()
    now = T0 + 30_000; await service.pump()
    expect(ring.calls).toHaveLength(1)
    expect(service.list()[0]?.call_id).toBe('c-1')
  })

  it('★等太久也回电话说「还没回」,不沉默;之后不再读那扇窗', async () => {
    const read = reader([{ found: false }])
    const ring = ringer()
    let now = T0
    const service = await svc({ reader: read, ring, now: () => now, timeoutMs: 60_000 })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    now = T0 + 30_000; await service.pump()
    expect(ring.calls).toEqual([])
    const readsBefore = read.reads
    now = T0 + 61_000; await service.pump()
    expect(ring.calls).toHaveLength(1)
    expect(ring.calls[0]?.note).toContain('它还没回')
    expect(read.reads).toBe(readsBefore)
    expect(service.list()[0]?.state).toBe('timeout')
  })

  it('★一条都没在等回话:一次窗口都不读', async () => {
    const read = reader([{ found: true, text: '好' }])
    const service = await svc({ reader: read, now: () => T0 })
    await service.pump()
    expect(read.reads).toBe(0)
  })

  it('★轻账里没有他捎进去那句话(卡 BR 那条纪律没松)', async () => {
    const read = reader([{ found: false }])
    const service = await svc({ reader: read, now: () => T0 })
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    expect(JSON.stringify(service.list())).not.toContain('现在进行到什么情况')
    expect(service.list()[0]).toMatchObject({ agent: 'claude', session_id: 'd9991aac', mark: '事务官捎话 d9991a', from: 'phone', state: 'waiting' })
  })

  it('★免打扰时段里这一通只发通知、不响铃(卡 QH 的规矩,这一类照样认)', async () => {
    const dir = tempDir()
    // 23:30,缺省静默时段(23:00–08:00)里面。
    const night = Date.parse('2026-09-27T23:30:00')
    const callOut = createCallOutService({ file: join(dir, 'call-out.json'), now: () => night })
    await callOut.load()
    const read = reader([{ found: true, text: '到第三步了' }])
    const service = createRelayWatchService({
      file: join(dir, 'relay.json'),
      reader: read,
      callOut: { request: input => callOut.request(input) },
      agentName: () => 'Claude',
      now: () => night,
      newId: () => 'r-1a2b3c',
      pollMs: 0,
    })
    await service.load()
    await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '事务官捎话 d9991a', from: 'phone' })
    await service.pump()
    await service.pump()
    const entry = callOut.view().entries[0]
    expect(entry?.reason).toBe('relay')
    expect(entry?.silent).toBe(true)
    expect(entry?.silent_reason).toBe('quiet')
    // 不响归不响,**这一通照样进台账**:第二天早上他在未接里看得到那句回话。
    expect(entry?.note).toContain('它的原话:到第三步了')
  })

  it('★手机上点「回拨」(只送 reason + item_id):标题与那句回话从台账上一通取回来,不念 id', async () => {
    const dir = tempDir()
    const callOut = createCallOutService({ file: join(dir, 'call-out.json'), now: () => T0 })
    await callOut.load()
    const first = await callOut.request({ reason: 'relay', item_id: 'relay:r-1a2b3c', title: 'Claude 「统筹交接」', note: '它的原话:到第三步了' })
    expect(first.ok).toBe(true)
    await callOut.ack({ id: first.entry!.id, result: 'missed' })
    const again = await callOut.request({ reason: 'relay', item_id: 'relay:r-1a2b3c' })
    expect(again.entry).toMatchObject({ title: 'Claude 「统筹交接」', note: '它的原话:到第三步了' })
  })
})

describe('读那一段此刻的回话:走引擎的 read(与派活盯窗同一处)', () => {
  /*
   * ★ 2026-10-02(卡「引擎接线与删复制品」):这一层从前是 `createHelperRelayReader` ——
   * 自己拿壳、自己按家名查包、自己 `read_reply`、自己摘界面字,与派活盯窗那一份几乎一样而又不完全一样
   * (超时 15s / 20s / 6s 三种、豆包办公那条「读整扇窗」的退路只有一处有)。
   * 现在两处都调同一个 `engine.read`,这一层只剩一个翻译:**这一拍读到了什么**。
   */
  it('★按捎话那个记号读,摘掉界面字之后就是回话', async () => {
    const h = engineHarness({
      reply: () => ({
        found: true,
        busy: false,
        texts: ['【事务官捎话 d9991a】现在进行到什么情况', '正在写交接,大概还要十分钟', '复制', '10:03'],
      }),
      installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    })
    const read = createEngineRelayReader({ engine: h.engine })
    const got = await read.read({ agent: 'claude', sessionId: 'd9991aac', mark: '事务官捎话 d9991a' })
    expect(got).toEqual({ found: true, busy: false, text: '正在写交接,大概还要十分钟' })
    // 这一下**只读**:一个 `read_reply` 以外的 op 都不发(不送、不点、不叫台前、不开窗)。
    expect(h.requests).toEqual([{ op: 'read_reply', bundle_id: 'com.anthropic.claudefordesktop', index: 0, marker: '事务官捎话 d9991a' }])
  })

  it('★轻账上记着真送进去的那个包 → 按它读(两个豆包时不会读到另一扇窗)', async () => {
    const h = engineHarness({
      reply: () => ({ found: true, busy: false, texts: ['【事务官捎话 x】问一句', '好了'] }),
      installed: () => [
        { bundle_id: 'com.bot.pc.doubao', name: '豆包', running: true },
        { bundle_id: 'com.work.pc.doubao', name: '豆包工作', running: true },
      ],
    })
    const read = createEngineRelayReader({ engine: h.engine })
    await read.read({ agent: 'doubao', sessionId: 'window:1', mark: '事务官捎话 x', bundleId: 'com.work.pc.doubao' })
    expect(h.requests.map(one => (one as { bundle_id?: string }).bundle_id)).toEqual(['com.work.pc.doubao'])
  })

  it('它还在写(窗口里停止键还在):回「还在写」,**不说成它还没回**', async () => {
    const h = engineHarness({
      reply: () => ({ found: true, busy: true, texts: ['【事务官捎话 x】问一句', '我在查'] }),
      installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    })
    const read = createEngineRelayReader({ engine: h.engine })
    expect(await read.read({ agent: 'claude', sessionId: 'x', mark: '事务官捎话 x' })).toMatchObject({ found: true, busy: true })
  })

  it('壳没连上:一个 op 都不发,如实回「没读到」', async () => {
    const h = engineHarness({ connected: () => false })
    const read = createEngineRelayReader({ engine: h.engine })
    expect(await read.read({ agent: 'claude', sessionId: 'x', mark: '事务官捎话 x' })).toEqual({ found: false, busy: false, text: '' })
    expect(h.requests).toEqual([])
  })

  it('这份壳不会读回话(旧壳):一个 op 都不发', async () => {
    const h = engineHarness({ caps: [] })
    const read = createEngineRelayReader({ engine: h.engine })
    expect(await read.read({ agent: 'claude', sessionId: 'x', mark: '事务官捎话 x' })).toEqual({ found: false, busy: false, text: '' })
    expect(h.requests).toEqual([])
  })

  it('读窗口抛了:这一拍当没读到,不把整条节拍带走', async () => {
    const h = engineHarness({
      reply: () => { throw new Error('壳掉线了') },
      installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    })
    const read = createEngineRelayReader({ engine: h.engine })
    expect(await read.read({ agent: 'claude', sessionId: 'x', mark: '事务官捎话 x' })).toEqual({ found: false, busy: false, text: '' })
  })

  it('★闸说这件事收场了 → 这一拍一个 op 都不发(拦下不等于有结果)', async () => {
    const h = engineHarness({
      phaseOf: () => 'settled',
      installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    })
    const read = createEngineRelayReader({ engine: h.engine })
    expect(await read.read({ agent: 'claude', sessionId: 'd1', mark: '事务官捎话 x' })).toEqual({ found: false, busy: false, text: '' })
    expect(h.requests).toEqual([])
  })
})

describe('落不了盘就说落不了盘(2026-09-30 止血 ①)', () => {
  /** 拿一个**开不出来的**路径当台账:父级是个普通文件,`mkdir` 必定失败。 */
  function blockedFile(): string {
    const dir = tempDir()
    writeFileSync(join(dir, 'blocked'), 'x', 'utf8')
    return join(dir, 'blocked', 'relay.json')
  }

  it('★记不上就抛:调用方才能如实说「回电没登记上」,不许回一句 watched:true', async () => {
    const service = createRelayWatchService({
      file: blockedFile(),
      reader: reader([{ found: false }]),
      now: () => T0,
      newId: () => 'r-1a2b3c',
      pollMs: 0,
    })
    await service.load()
    await expect(service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '到哪了', from: 'phone' }))
      .rejects.toThrow()
  })

  it('巡检那一拍照旧不被落盘带走:只记一行日志,日志里没有她那句话', async () => {
    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      const service = createRelayWatchService({
        file: blockedFile(),
        reader: reader([{ found: true, text: '好了' }]),
        callOut: ringer(),
        now: () => T0,
        newId: () => 'r-1a2b3c',
        pollMs: 0,
      })
      await service.load()
      // 记不上也不拦着巡检往下走(这一条只在内存里,下一拍照读)
      await service.remember({ agent: 'claude', session_id: 'd9991aac', title: 'X', mark: '到哪了', from: 'phone' }).catch(() => {})
      await service.pump()
      await service.pump()
    }
    finally { console.warn = original }
    expect(lines.filter(one => one.includes('台账落盘失败'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('到哪了')
  })
})

describe('台账满了先丢老的、**不丢还在等的那几条**(2026-09-30 止血 ②)', () => {
  const many = (count: number, state: RelayWait['state']): RelayWait[] =>
    Array.from({ length: count }, (_, i) => wait({ id: `${state}-${i}`, state }))

  it('★超了就先丢最老的**已收场**那几条,还在等回话的一条都不丢', () => {
    const kept = trimRelayWaits([...many(5, 'replied'), ...many(3, 'waiting')], 4)
    expect(kept.map(one => one.id)).toEqual(['replied-4', 'waiting-0', 'waiting-1', 'waiting-2'])
  })

  it('还在等的就比上限还多:一条都不丢(宁可账长一点,也不能丢一条永远不回电的)', () => {
    const kept = trimRelayWaits(many(6, 'waiting'), 4)
    expect(kept).toHaveLength(6)
  })

  it('没超上限:原样不动', () => {
    const all = [...many(2, 'replied'), ...many(1, 'waiting')]
    expect(trimRelayWaits(all, 100)).toEqual(all)
  })

  it('读盘也照这条规矩:老的 replied 先丢,waiting 留着', () => {
    const file = sanitizeRelayWatchFile({
      version: 1,
      waits: [
        ...Array.from({ length: RELAY_WAIT_MAX }, (_, i) => wait({ id: `old-${i}`, state: 'replied', reply: '好' })),
        wait({ id: 'new-waiting' }),
      ],
    })
    expect(file.waits.map(one => one.id)).toContain('new-waiting')
    expect(file.waits).toHaveLength(RELAY_WAIT_MAX)
  })
})

describe('读盘', () => {
  it('读不懂的那几条丢掉,别的照留;认不出的 from / state 退回最保守的那一档', () => {
    const file = sanitizeRelayWatchFile({
      version: 1,
      waits: [
        { id: 'r-a', agent: 'claude', session_id: 's1', mark: 'm1', title: 'X', at: '2026-09-27T10:00:00.000Z', from: '乱写', state: '乱写' },
        { id: '', agent: 'claude', session_id: 's2', mark: 'm2' },
        'nonsense',
      ],
    })
    expect(file.waits).toHaveLength(1)
    expect(file.waits[0]).toMatchObject({ id: 'r-a', from: 'desk', state: 'waiting' })
    expect(sanitizeRelayWatchFile(null).waits).toEqual([])
  })
})

describe('★账只许有一个记的人(2026-10-02,卡「引擎接线与删复制品」)', () => {
  /*
   * 真机 `GET /jobs/<id>/trace` 上看得见那个毛病:一次送话四行账、两条 `assigned`,
   * 其中一条没有动作、没有包标识 —— 送话那一下引擎已经把指派与投递连着证据记上了
   * (键与这里**是同一个** `sessionJobId`),这一层又手记了一遍。
   *
   * 分界:**认不出是哪条对话**的那两路(只盯不发 / 新开一条,`session_placeholder`)键是这一条
   * 自己的(`relayWaitJobId`),引擎在那个键上一条都没记过 —— 那一路照旧由这里记。
   */
  async function logged(over: { session_placeholder?: true }) {
    const log = createJobLog({ warn: () => {} })
    const service = createRelayWatchService({
      file: join(tempDir(), 'relay.json'),
      reader: reader([]),
      now: () => T0,
      newId: () => 'r-1a2b3c',
      pollMs: 0,
      jobLog: log,
    })
    await service.load()
    await service.remember({
      agent: 'claude',
      session_id: 'd9991aac',
      title: 'X',
      mark: '事务官捎话 d9991a',
      from: 'phone',
      ...over,
    })
    return log.all().map(one => one.step)
  }

  it('点名某条会话捎话:这里一行都不记(引擎记过了,键是同一个)', async () => {
    expect(await logged({})).toEqual([])
  })

  it('认不出是哪条对话(只盯不发 / 新开一条):这里补记指派 + 投递', async () => {
    expect(await logged({ session_placeholder: true })).toEqual(['assigned', 'sent'])
  })
})
