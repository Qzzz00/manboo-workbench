// @vitest-environment node
/**
 * **2026-09-28 Air 维护包回源码的回归用例**(维护者 Air 上 Codex 22:19 那份最终维护包;原来是对着安装产物跑的
 * 脚本测试,这里对着源码重写)。夹具 `fixtures/doubao-read-asking-20260928.json` 是豆包办公那一刻的真机读数:
 * 侧栏「中秋节月饼相关咨询 待确认」、主对话区「正在询问用户」+ 一道三选一、右侧摘要区。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SessionAskView, TaskView } from '../src/protocol.ts'
import { windowProgressBusy, doubaoVisibleForm, parseRead, type WindowRead } from '../src/server/agentWindowModel.ts'
import { taskCallOutEvent } from '../src/server/callOut.ts'
/*
 * ★ 2026-10-02(卡「引擎接线与删复制品」):`readRelayEvidence` 搬去了窗口适配器
 * (`dispatchClient.ts` 瘦成纯判断 + 类型,而这一下真去碰壳),送话那几只手删了、换成一条引擎。
 */
import { readRelayEvidence } from '../src/server/engine/adapters/window.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const RAW = JSON.parse(readFileSync(new URL('./fixtures/doubao-read-asking-20260928.json', import.meta.url), 'utf8')) as Record<string, unknown>
const READ = parseRead(RAW)
const DOUBAO = 'com.work.pc.doubao'

describe('豆包办公窗口里摆着的那道选择题(doubaoVisibleForm)', () => {
  it('★真机那一刻:认出问题与三个选项,是形式上的一问', () => {
    const ask = doubaoVisibleForm(READ, undefined, 'now')
    expect(ask?.options?.map(one => one.label)).toEqual(['选购/对比月饼', '写文案/做海报', '其他想法'])
    expect(ask).toMatchObject({ by: 'form', kind: 'choose', since: 'now', press: true, write: true })
    expect(ask?.question).toContain('你具体想让我做什么')
  })

  it('侧栏没有「待确认」/ 没有「正在询问用户」那一行 → 不算', () => {
    expect(doubaoVisibleForm({ ...READ, side: [] }, undefined, 'now')).toBeUndefined()
    expect(doubaoVisibleForm({ ...READ, tail: READ.tail.filter(one => one.t !== '正在询问用户') }, undefined, 'now')).toBeUndefined()
  })

  it('★同一道题沿用上一次的 since(电话一件只打一次靠它)', () => {
    const first = doubaoVisibleForm(READ, undefined, 'now') as SessionAskView
    expect(doubaoVisibleForm(READ, first, 'later')?.since).toBe('now')
  })
})

describe('在对话区里找我们那一句(readRelayEvidence)', () => {
  const helperOf = (read: Record<string, unknown>) => ({
    request: async (req: { op: string }) => req.op === 'read_reply' ? { ok: true, result: { found: false } } : read,
  })

  it('★豆包办公 read_reply 认不出时,读整扇窗再找:主对话区里有就算', async () => {
    expect((await readRelayEvidence(helperOf(RAW), DOUBAO, '中秋节月饼的事情')).ok).toBe(true)
    const got = await readRelayEvidence(helperOf(RAW), DOUBAO, '中秋节月饼的事情')
    expect(got.ok && got.result.found).toBe(true)
  })

  it('没发过的、侧栏里的、输入框里的草稿、右侧摘要区的 → 都不算', async () => {
    const miss = async (raw: Record<string, unknown>, marker: string) => {
      const got = await readRelayEvidence(helperOf(raw), DOUBAO, marker)
      return got.ok ? got.result.found : false
    }
    const input = READ.input as NonNullable<WindowRead['input']>
    expect(await miss(RAW, 'not actually sent')).toBe(false)
    expect(await miss(RAW, 'Benger')).toBe(false)
    expect(await miss({ ...RAW, tail: [...(RAW.tail as unknown[]), { x: input.x, y: input.y, w: 100, h: 20, t: 'draft-only-text' }] }, 'draft-only-text')).toBe(false)
    expect(await miss({ ...RAW, tail: [...(RAW.tail as unknown[]), { x: input.x + input.w + 30, y: 300, w: 100, h: 20, t: 'summary-only-marker' }] }, 'summary-only-marker')).toBe(false)
  })

  it('别家不读整扇窗(只认 read_reply)', async () => {
    const calls: string[] = []
    await readRelayEvidence({ request: async (req: { op: string }) => { calls.push(req.op); return { ok: true, result: { found: false } } } }, 'im.manus.desktop', '中秋节月饼的事情')
    expect(calls).toEqual(['read_reply'])
  })
})

describe('豆包在跑:只认主对话区、按上下排、正文在变就续期', () => {
  const base: WindowRead = {
    running: true, window: { w: 1065, h: 732 }, input: { x: 317, y: 627, w: 491, h: 24 }, sidebar: { x: 0, y: 0, w: 280, h: 732 }, stop: [], side: [],
    tail: [{ t: '正在思考', x: 316, y: 400, w: 84, h: 17 }, { t: '对话摘要', x: 862, y: 20, w: 56, h: 16 }, { t: '技能', x: 862, y: 134, w: 28, h: 16, ctl: true }],
  }
  it('★右侧摘要区排在树的后面也不挡:「正在思考」照样是主对话区最后一行', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: base, title: 'A', nowMs: 1000 }).busy).toBe(true)
  })
  it('右侧摘要区里写着「正在思考」→ 不算', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: { ...base, tail: [{ t: '正在思考', x: 862, y: 400, w: 84, h: 17 }] }, title: 'A', nowMs: 1000 }).busy).toBe(false)
  })
  it('★看见过在跑、正文还在变 → 续期;换了对话 / 静止满 30 秒 → 做完', () => {
    const seen = windowProgressBusy({ bundleId: DOUBAO, read: base, title: 'A', nowMs: 1000 }).seen
    const streaming = { ...base, tail: [{ t: '新的正文', x: 316, y: 400, w: 84, h: 17 }] }
    const next = windowProgressBusy({ bundleId: DOUBAO, read: streaming, title: 'A', nowMs: 10_000, ...(seen === undefined ? {} : { seen }) })
    expect(next.busy).toBe(true)
    expect(next.seen?.at).toBe(10_000)
    expect(windowProgressBusy({ bundleId: DOUBAO, read: streaming, title: 'B', nowMs: 11_000, ...(next.seen === undefined ? {} : { seen: next.seen }) }).busy).toBe(false)
    expect(windowProgressBusy({ bundleId: DOUBAO, read: streaming, title: 'A', nowMs: 41_000, ...(next.seen === undefined ? {} : { seen: next.seen }) }).busy).toBe(false)
  })
})

describe('豆包那一问:能替她点、能写进它那个面板', () => {
  it('★窗口型对话(window:…)按登记表的包走窗口那只手;写面板只对豆包办公开', async () => {
    const ask = doubaoVisibleForm(READ, undefined, 'now') as SessionAskView
    let pressed: { bundleId: string } | undefined
    let written: { text: string } | undefined
    const h = engineHarness({
      installed: () => [{ bundle_id: DOUBAO, name: '豆包工作', running: true }],
      bundleOf: () => DOUBAO,
      reply: (req) => {
        if (req.op === 'agent_press') { pressed = { bundleId: req.bundle_id }; return { found: true, pressed: true, gone: true } }
        if (req.op === 'agent_write_ask') { written = { text: req.text }; return { found: true, wrote: true, submitted: true, gone: true, echoed: true } }
        return {}
      },
    })
    const answer = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [{ agent: 'doubao', session_id: 'window:test', status: 'waiting', ask } as never],
      bundleOf: () => DOUBAO,
    })
    expect((await answer.press('doubao', 'window:test', '选购/对比月饼'))).toMatchObject({ ok: true, confirmed: true })
    expect(pressed?.bundleId).toBe(DOUBAO)
    expect(await answer.writeAsk('doubao', 'window:test', '月饼哪个品类好吃？')).toMatchObject({ ok: true, confirmed: true })
    expect(written?.text).toBe('月饼哪个品类好吃？')
    // 写面板**只对豆包办公那个包开着**(`WRITE_ASK_PACKAGES`):别家一个字都不写。
    const other = engineHarness({ installed: () => [{ bundle_id: 'im.manus.desktop', name: 'Manus' }], bundleOf: () => 'im.manus.desktop' })
    const manus = createSessionJobs({
      engine: other.engine,
      registry: other.registry,
      sessions: () => [{ agent: 'manus', session_id: 'window:test', status: 'waiting', ask } as never],
      bundleOf: () => 'im.manus.desktop',
    })
    expect(await manus.writeAsk('manus', 'window:test', '月饼哪个品类好吃？')).toMatchObject({ ok: false })
    expect(other.requests.filter(one => one.op === 'agent_write_ask')).toEqual([])
  })
})

describe('通话纪要不当成「办完了」打电话', () => {
  it('★origin:call 的纪要那张卡 → 不出事件', () => {
    const task = { id: 't-1', title: '和事务官通了个电话(36 秒)', status: 'done', direction: 'mine', origin: 'call', call: { kind: 'call' } } as unknown as TaskView
    expect(taskCallOutEvent(task)).toBeUndefined()
  })
})
