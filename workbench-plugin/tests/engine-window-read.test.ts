// @vitest-environment node
/**
 * **只读一眼那一段此刻的回话**(契约 2026-10-02 加的 `Adapter.read` / `Adapter.writeMode`)。
 *
 * 「盯着等回话」那条巡检一条会话会读几百次,所以这一下的纪律是:
 * **不送、不点、不叫台前、不开窗、不过闸** —— 只发 `read_reply`
 * (豆包办公那一个包认不出时 `readRelayEvidence` 里退到读整扇窗 `agent_read`)。
 *
 * 三种结局分得清,**「读不到」不许说成「它还没回」**:
 * ① 读到了、写完了 → `reply`;② 读到了、还在写 → 没有 `reply` + 「它还在写」;
 * ③ 读不到 → 没有 `reply` + 一句实话。
 *
 * 顺带钉住 `via` 那一格的新用法(契约加了 `'none'`):**一个 op 都没发出去**的那几种回 `'none'`。
 */
import { describe, expect, it } from 'vitest'
import {
  READ_BUSY_WHY,
  READ_FAILED_WHY,
  createWindowAdapter,
} from '../src/server/engine/adapters/window.ts'
import type { WindowAdapterDeps } from '../src/server/engine/adapters/window.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const FAMILY = 'manus'
const BUNDLE = 'im.manus.desktop'
const SAID = '现在进行到什么情况,大概什么时候能处理完'
const CAPS = ['read_reply', 'agent_pick', 'agent_press', 'agent_stop', 'new_conversation']

function harness(options: { read?: Record<string, unknown>, caps?: readonly string[], connected?: boolean, rejects?: boolean } = {}) {
  const requests: HelperRequest[] = []
  const deps: WindowAdapterDeps = {
    helper: {
      connected: () => options.connected !== false,
      supports: (cap: string) => (options.caps ?? CAPS).includes(cap),
      request: async (req: HelperRequest) => {
        requests.push(req)
        if (options.rejects === true) throw new Error('壳断开了')
        // 真壳的 `send_text` 只要 `submit` 为真就一定报 `submitted`(照它,见 engine-window-send 那一份的注释)。
        if (req.op === 'send_text') return { ok: true, result: { submitted: true } }
        return options.read ?? { ok: true, result: { found: true, busy: false, texts: [SAID, '还在跑第三步,大概十分钟'] } }
      },
    },
    installed: () => [{ bundle_id: BUNDLE, name: 'Manus', running: true }],
    bundleOf: () => BUNDLE,
    nameOf: () => 'Manus',
    openApp: async () => ({ ok: true }),
    openUrl: async () => ({ ok: true }),
    bringToFront: async () => ({ ok: true }),
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { requests, it: createWindowAdapter(FAMILY, deps) }
}

const job: Job = {
  id: 'job-read',
  family: FAMILY,
  kind: 'relay',
  target: { kind: 'session', sessionId: 'window:825f1900' },
  text: SAID,
  marks: ['统筹交接'],
  expect: 'reply',
}

describe('read:只读一眼,一下都不动她的窗口', () => {
  it('★读到了、它写完了 → 回那段回答(我们那一句的回声剥掉了)', async () => {
    const h = harness()
    const got = await h.it.read!(job)
    expect(got.reply).toBe('还在跑第三步,大概十分钟')
    expect(got.evidence).toBe('window')
    expect(got.via).toBe('window')
    expect(got.why).toBeUndefined()
  })

  it('★★只发 read_reply:不送、不点、不叫台前、不开窗', async () => {
    const h = harness()
    await h.it.read!(job)
    expect(h.requests.map(one => one.op)).toEqual(['read_reply'])
  })

  it('★它还在写(停止键还在)→ 没有回答 + 「它还在写」,不说成读不到', async () => {
    const h = harness({ read: { ok: true, result: { found: true, busy: true, texts: [SAID, '正在跑…'] } } })
    const got = await h.it.read!(job)
    expect(got.reply).toBeUndefined()
    expect(got.why).toBe(READ_BUSY_WHY)
    expect(got.evidence).toBe('window')
  })

  it('★还没在对话区里看见我们那一句 → 如实说读不到,**不编一个「它还没回」**', async () => {
    const h = harness({ read: { ok: true, result: { found: false } } })
    const got = await h.it.read!(job)
    expect(got.reply).toBeUndefined()
    expect(got.why).toBe(READ_FAILED_WHY)
    expect(got.evidence).toBe('none')
  })

  it('★这一拍壳抛了错 → 读不到(不把整条节拍带走)', async () => {
    const h = harness({ rejects: true })
    const got = await h.it.read!(job)
    expect(got.why).toBe(READ_FAILED_WHY)
  })

  it('★读到了、可剥完一个字都没有 → 不回一个空回答', async () => {
    const h = harness({ read: { ok: true, result: { found: true, busy: false, texts: [SAID] } } })
    const got = await h.it.read!(job)
    expect(got.reply).toBeUndefined()
    expect(got.why).toBeUndefined()
  })

  it('★壳没连上 / 旧壳不会读 → via 一条通道都没用上', async () => {
    const down = await harness({ connected: false }).it.read!(job)
    expect(down.via).toBe('none')
    expect(down.why).toContain('工作台 App 没连上')

    const old = harness({ caps: [] })
    const got = await old.it.read!(job)
    expect(got.via).toBe('none')
    expect(old.requests).toEqual([])
  })

  it('★一截能认的字都没有(按停止那一类,text 是空的)→ 如实说读不出哪一句是回答', async () => {
    const h = harness()
    const got = await h.it.read!({ ...job, text: '', marks: ['短'] })
    expect(got.reply).toBeUndefined()
    expect(got.why).toContain('读不出哪一句')
    expect(h.requests).toEqual([])
  })
})

describe('writeMode:写入靠打字还是靠粘贴', () => {
  it('★没判过 / full → full', async () => {
    expect(await harness().it.writeMode!()).toBe('full')
  })

  it('★自绘界面 → paste_only(那条退路在壳内部)', async () => {
    const deps: WindowAdapterDeps = {
      helper: { connected: () => true, supports: () => true, request: async () => ({ ok: true, result: {} }) },
      installed: () => [{ bundle_id: BUNDLE, name: 'Manus', running: true }],
      structureMode: () => 'paste_only',
      sleep: async () => {},
    }
    expect(await createWindowAdapter(FAMILY, deps).writeMode!()).toBe('paste_only')
  })
})

describe("via:'none' —— 一个 op 都没发出去的那几种", () => {
  it('★壳没连上 / 永不送的那家 / 旧壳按不了停止:都说「一条通道都没用上」', async () => {
    const down = await harness({ connected: false }).it.run(job)
    expect(down.via).toBe('none')

    const wechat = createWindowAdapter('com.tencent.xinWeChat', {
      helper: { connected: () => true, supports: () => true, request: async () => ({ ok: true, result: {} }) },
      installed: () => [{ bundle_id: 'com.tencent.xinWeChat', name: '微信' }],
      nameOf: () => '微信',
      sleep: async () => {},
    })
    const got = await wechat.run({ ...job, id: 'job-wechat' })
    expect(got.via).toBe('none')
    expect(got.unsupported).toBe(true)

    const oldShell = harness({ caps: ['read_reply'] })
    const stopped = await oldShell.it.run({ ...job, id: 'job-stop', kind: 'stop', text: '' })
    expect(stopped.via).toBe('none')
  })

  it("★真跟壳说过话才回 'window'", async () => {
    const h = harness({ read: { ok: false, error: '它窗口里点不动:AXPress 回 -25200' } })
    const got = await h.it.run({ ...job, id: 'job-press', kind: 'press', text: '方案 A', marks: ['方案 A'] })
    expect(got.delivered).toBe('not_sent')
    expect(got.via).toBe('window')
  })
})

describe('attempt(契约 2026-10-02 加的那一格)', () => {
  it('★适配器不碰它 —— 重派算第几次是引擎过闸那一处的事,这一层照样送', async () => {
    const h = harness()
    const got = await h.it.run({ ...job, id: 'job-attempt', attempt: 2 })
    expect(got.delivered).toBe('confirmed')
  })
})
