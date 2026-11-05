// @vitest-environment node
/**
 * ★ **电脑锁着屏时,窗口型的家送不进**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 现场(维护者那台 09:04):她在手机「等你确认」里给 Kimi 那条会话回了一句 ——
 * 工作台日志 7 秒内 `[开App] com.moonshot.kimichat ← open -b` **五次**,最后一句
 * `not_sent · answer_send · 找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有`。
 * 10:30 她人在电脑前再试就成了;10:38 把 Kimi 藏到后台再捎一句也 6 秒送到。
 * **唯一的差别:09:04 电脑锁着屏。**
 *
 * 这一份钉住窗口那一层的四件事:
 * ① 锁着屏 → `not_sent` + `screenLocked` + 那句人话,**一个 op 都不发、一回窗都不开**(`openApp` 0 次);
 * ② 壳先报出来的那一种(老壳 / 刚好撞上那一刻)照样认得出,而且**不换包、不重试**;
 * ③ 只读那几下(读回话 / 看权限弹框 / 开到她眼前)也不做,而且**不许说成「它还没回」**;
 * ④ 没锁屏 / 不知道锁没锁 → **一字不变**(老行为)。
 */
import { describe, expect, it } from 'vitest'
import { createWindowAdapter } from '../src/server/engine/adapters/window.ts'
import type { WindowAdapterDeps } from '../src/server/engine/adapters/window.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import { RetryableError } from '../src/server/engine/adapter.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { SCREEN_LOCK_MARK } from '../src/server/screenLock.ts'

const FAMILY = 'kimi'
const BUNDLE = 'com.moonshot.kimichat'
/** 她 09:04 在手机上回的那一句(原话的形状,内容无所谓)。 */
const SAID = '就按第二个方案来,封面用那张海边的'
const CAPS = ['read_reply', 'agent_pick', 'agent_press', 'agent_stop', 'agent_approval', 'new_conversation']

/** 壳在锁屏时回的那一句(`ScreenLockPolicy.lockedWhy` 的形状)。 */
const SHELL_LOCKED_ERROR = `${SCREEN_LOCK_MARK},窗口型的家这会儿送不进:锁着屏的时候 ${BUNDLE} 的窗口一扇都列不出来 —— 解锁了就能送`
/** 壳在**没**锁屏、真没窗口时回的那一句(`SendTextPolicy.Failure.noWindow`)。 */
const SHELL_NO_WINDOW = `找不到窗口:${BUNDLE} 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)`

function harness(options: {
  /** 这一刻锁着屏没有(`undefined` = 不知道)。 */
  locked?: boolean
  /** 壳每一下都抛这句(真壳在 ok:false 时 reject 一个 Error)。 */
  rejectWith?: string
  /** 这台装着几个包(换包那一条要两个)。 */
  packages?: readonly { bundle_id: string, name: string, running?: boolean }[]
} = {}) {
  const requests: HelperRequest[] = []
  const opened: string[] = []
  const urls: string[] = []
  const fronted: string[] = []
  const ran: string[] = []
  const deps: WindowAdapterDeps = {
    helper: {
      connected: () => true,
      supports: (cap: string) => CAPS.includes(cap),
      request: async (req: HelperRequest) => {
        requests.push(req)
        if (options.rejectWith !== undefined) throw new Error(options.rejectWith)
        if (req.op === 'send_text') return { ok: true, result: { submitted: true } }
        if (req.op === 'read_reply') return { ok: true, result: { found: true, busy: false, texts: [SAID, '好的'] } }
        return { ok: true, result: { found: true, pressed: true, gone: true } }
      },
    },
    installed: () => options.packages ?? [{ bundle_id: BUNDLE, name: 'Kimi', running: true }],
    bundleOf: () => BUNDLE,
    nameOf: () => 'Kimi',
    openApp: async (bundleId: string) => { opened.push(bundleId); return { ok: true } },
    openUrl: async (url: string) => { urls.push(url); return { ok: true } },
    bringToFront: async (bundleId: string) => { fronted.push(bundleId); return { ok: true } },
    ensureRunning: async (_family: string, bundleId: string) => { ran.push(bundleId); return { ok: true } },
    ...(options.locked === undefined ? {} : { screenLocked: () => options.locked }),
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { requests, opened, urls, fronted, ran, it: createWindowAdapter(FAMILY, deps) }
}

function answerJob(id = 'job-0904'): Job {
  return {
    id,
    family: FAMILY,
    kind: 'answer',
    target: { kind: 'session', sessionId: 'window:825f1900' },
    text: SAID,
    marks: ['要用哪个方案'],
    expect: 'ack',
  }
}

describe('① 锁着屏:一个 op 都不发,如实说', () => {
  it('★★替她答 → not_sent + screenLocked + 那句人话', async () => {
    const h = harness({ locked: true })
    const out = await h.it.run(answerJob())
    expect(out.delivered).toBe('not_sent')
    expect(out.screenLocked).toBe(true)
    expect(out.why).toContain(SCREEN_LOCK_MARK)
    // 说得出是哪一家 + 下一步(她听了去解锁,不去查 Kimi)
    expect(out.why).toContain('Kimi')
    expect(out.why).toContain('解锁')
  })

  it('★★一个 op 都不发、一回窗都不开(`openApp` 0 次 —— 09:04 那 5 次 `open -b` 不再有)', async () => {
    const h = harness({ locked: true })
    await h.it.run(answerJob())
    expect(h.requests).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.urls).toEqual([])
    expect(h.fronted).toEqual([])
    expect(h.ran).toEqual([])
  })

  it('★一条通道都没用上 → via:none(不许说成「跟那扇窗说过话了」)', async () => {
    const out = await harness({ locked: true }).it.run(answerJob())
    expect(out.via).toBe('none')
  })

  it('★不带 unsupported:解锁了它做得到,带上引擎就会去换另一条通道(一样撞锁屏)', async () => {
    const out = await harness({ locked: true }).it.run(answerJob())
    expect(out.unsupported).toBeUndefined()
  })

  it('★捎话 / 派活 / 点选项 / 写面板 / 按停止:五条路同一句话', async () => {
    const kinds: Job['kind'][] = ['relay', 'dispatch', 'press', 'write_ask', 'stop']
    for (const kind of kinds) {
      const h = harness({ locked: true })
      const out = await h.it.run({ ...answerJob(`job-${kind}`), kind, ...(kind === 'dispatch' ? { target: { kind: 'new' as const } } : {}) })
      expect(out.screenLocked, kind).toBe(true)
      expect(out.why, kind).toContain(SCREEN_LOCK_MARK)
      expect(h.requests, kind).toEqual([])
      expect(h.opened, kind).toEqual([])
    }
  })
})

describe('② 壳先报出来那一种:照样认得出,而且不换包、不重试', () => {
  it('★壳那句话里有那截字 → screenLocked(老壳 / 刚好撞上那一刻)', async () => {
    const h = harness({ rejectWith: SHELL_LOCKED_ERROR })
    const out = await h.it.run(answerJob())
    expect(out.screenLocked).toBe(true)
    expect(out.delivered).toBe('not_sent')
  })

  it('★★装着两个包也不换 —— 不抛 RetryableError(换一个一样没有窗口)', async () => {
    const h = harness({
      rejectWith: SHELL_LOCKED_ERROR,
      packages: [
        { bundle_id: BUNDLE, name: 'Kimi', running: true },
        { bundle_id: 'com.moonshot.kimichat.kmp.mac', name: 'Kimi(官网版)', running: true },
      ],
    })
    // 换包那一路是抛 `RetryableError` 给引擎,所以这里只要「没抛」就说明不换
    const out = await h.it.run(answerJob())
    expect(out.screenLocked).toBe(true)
    expect(out.why).not.toContain('换那一个再送一回')
  })

  it('★对照:**没**锁屏、真没窗口 → 照旧那条路(抛 RetryableError 换包),一字不变', async () => {
    const h = harness({
      rejectWith: SHELL_NO_WINDOW,
      packages: [
        { bundle_id: BUNDLE, name: 'Kimi', running: true },
        { bundle_id: 'com.moonshot.kimichat.kmp.mac', name: 'Kimi(官网版)', running: true },
      ],
    })
    await expect(h.it.run(answerJob())).rejects.toBeInstanceOf(RetryableError)
    // 那一条老路照旧开窗(这正是锁屏时不该做的那几下)
    expect(h.opened.length).toBeGreaterThan(0)
  })
})

describe('③ 只读那几下:也不做,而且不许说成「它还没回」', () => {
  it('★读回话:一个 op 都不发,话里说清是读不到、不是它没回', async () => {
    const h = harness({ locked: true })
    const got = await h.it.read!(answerJob())
    expect(got.reply).toBeUndefined()
    expect(got.evidence).toBe('none')
    expect(got.via).toBe('none')
    expect(got.why).toContain(SCREEN_LOCK_MARK)
    expect(got.why).toContain('不是它没回')
    expect(h.requests).toEqual([])
  })

  it('★「去回答」:开不到她眼前(锁屏时 open -b / 深链都没用),如实说', async () => {
    const h = harness({ locked: true })
    const got = await h.it.reveal!(answerJob())
    expect(got.ok).toBe(false)
    expect(got.how).toBe('none')
    expect(got.why).toContain(SCREEN_LOCK_MARK)
    expect(h.opened).toEqual([])
    expect(h.urls).toEqual([])
  })

  it('★看一眼权限弹框:一颗键都不读(更不按)', async () => {
    const h = harness({ locked: true })
    const got = await h.it.readApproval!({ ...answerJob(), marks: ['要允许它改这个文件吗'] }, { active: true })
    expect(got.panels).toEqual([])
    expect(got.why).toContain(SCREEN_LOCK_MARK)
    expect(h.requests).toEqual([])
  })
})

describe('④ 没锁屏 / 不知道锁没锁:一字不变', () => {
  it('★没锁屏 → 照旧送进去', async () => {
    const h = harness({ locked: false })
    const out = await h.it.run(answerJob())
    expect(out.screenLocked).toBeUndefined()
    expect(out.delivered).toBe('confirmed')
    expect(h.requests.some(one => one.op === 'send_text')).toBe(true)
  })

  it('★★不知道锁没锁(老壳 / 还没问到)→ **照旧送**,不许把「不知道」当成「锁着」', async () => {
    const h = harness()
    const out = await h.it.run(answerJob())
    expect(out.screenLocked).toBeUndefined()
    expect(out.delivered).toBe('confirmed')
  })

  it('★那一格的实现抛了错也按「不知道」算(不拦她的活)', async () => {
    const requests: HelperRequest[] = []
    const adapter = createWindowAdapter(FAMILY, {
      helper: {
        connected: () => true,
        supports: (cap: string) => CAPS.includes(cap),
        request: async (req: HelperRequest) => {
          requests.push(req)
          return req.op === 'send_text' ? { ok: true, result: { submitted: true } } : { ok: true, result: { found: true, busy: false, texts: [SAID, '好'] } }
        },
      },
      installed: () => [{ bundle_id: BUNDLE, name: 'Kimi', running: true }],
      nameOf: () => 'Kimi',
      screenLocked: () => { throw new Error('这一拍问不到') },
      sleep: async () => {},
      settleMs: 0,
    })
    const out = await adapter.run(answerJob())
    expect(out.screenLocked).toBeUndefined()
    expect(requests.some(one => one.op === 'send_text')).toBe(true)
  })
})
