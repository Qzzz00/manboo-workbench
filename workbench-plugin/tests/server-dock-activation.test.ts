// @vitest-environment node
/**
 * 截图不切窗(2026-09-25,卡 P)。
 *
 * 维护者原话:「我习惯用企业微信的截图快捷键,但是在这套系统中,每次使用截图,都会把企业微信显示出来,
 * 预期应该是保持页面不变,这个机制应该对其他有截图能力的 APP 都是一个逻辑,不只是企业微信」。
 *
 * 根因:窗口槽里不在台前的几家是藏着的(hide_app),macOS 激活一个藏着的应用会先把它放出来 ——
 * 截图快捷键激活企业微信,它摆在窗口槽位置上的主窗就盖了出来。壳判「临时叫一下 / 真切过去」
 * (workbench-app/Sources/ActivationSense.swift),这里钉服务端拿到结论之后做什么:
 * ① 临时叫一下、它在窗口槽里、不在台前、被叫出来前是藏着的 → 藏回去,当前那一格不变、不置前任何窗;
 * ② 真切过去、它在窗口槽里、不在台前 → 窗口槽跟过去(同点它的标签);
 * ③ 不在窗口槽里的 / 本来就在台前的 / 我们自己刚激活的:不动,只记一笔。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShellActivation } from '../src/protocol.ts'
import type { AppsRegistry } from '../src/server/appsRegistry.ts'
import { createDockService } from '../src/server/dock.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { parseActivation } from '../src/server/helperChannel.ts'

const WECOM = 'com.tencent.WeWorkMac'
const CLAUDE = 'com.anthropic.claudefordesktop'
const SLOT_PAGE_RECT = { x: 100, y: 100, w: 400, h: 300 }
const SCREEN_INFO = { webview: { x: 0, y: 0, w: 2000, h: 1200 }, scale: 1 }
const INSIDE_FRAME = { x: 150, y: 150, w: 100, h: 100 }

function fakeHelper() {
  const calls: HelperRequest[] = []
  return {
    calls,
    channel: {
      request: (req: HelperRequest) => {
        calls.push(req)
        if (req.op === 'screen_info') return Promise.resolve(SCREEN_INFO as Record<string, unknown>)
        if (req.op === 'app_info') return Promise.resolve({ running: true, hidden: false, windows: [{ index: 0, frame: INSIDE_FRAME }] } as Record<string, unknown>)
        if (req.op === 'arm_rehide') return Promise.resolve({ armed: true } as Record<string, unknown>)
        return Promise.resolve({})
      },
    },
  }
}

function registry(): AppsRegistry {
  const entries = [
    { key: 'claude', label: 'Claude', bundleId: CLAUDE, cmd: ['open', '-b', CLAUDE] },
    { key: 'wecom', label: '企业微信', bundleId: WECOM, cmd: ['open', '-b', WECOM] },
  ]
  return {
    async list() { return entries.map(e => ({ key: e.key, label: e.label })) },
    async listAll() { return entries.map(e => ({ key: e.key, label: e.label })) },
    async enable() { return { enabled: [], already: [], unknown: [] } },
    async commandFor(key: string) { return entries.find(e => e.key === key)?.cmd },
    async bundleFor(key: string) { return entries.find(e => e.key === key)?.bundleId },
    async keyFor(bundleId: string) {
      const found = entries.find(e => e.bundleId === bundleId)
      return found === undefined ? undefined : { key: found.key, label: found.label }
    },
    async add() { return { ok: false, reason: '不支持' } },
    async remove() { return { ok: false, reason: '不支持' } },
    async addResolved() { return { ok: false, reason: '不支持' } },
  }
}

const running = async (cmd: readonly string[]) => ({ ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=123\n' : '' })

/** 叠里:企业微信(藏着)、Claude(台前)。 */
async function setup(options: { follow?: boolean, now?: () => number } = {}) {
  const helper = fakeHelper()
  const svc = createDockService({
    file: join(await mkdtemp(join(tmpdir(), 'dock-activation-')), 'dock.json'),
    helper: helper.channel, registry: registry(), runCommand: running, sleep: () => Promise.resolve(),
    ...(options.follow === undefined ? {} : { followActivation: options.follow }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  svc.setSlotRect(SLOT_PAGE_RECT)
  await svc.handleMoved(WECOM, INSIDE_FRAME)
  await svc.handleMoved(CLAUDE, INSIDE_FRAME) // current = claude,企业微信被藏
  helper.calls.length = 0
  return { svc, helper }
}

const screenshot: ShellActivation = {
  bundle_id: WECOM, verdict: 'transient', reason: 'overlay', was_hidden: true, prev_bundle_id: 'ai.ben.workbench', dwell_ms: 4000,
  overlay: { layer: 2000, x: 0, y: 0, w: 1920, h: 1080, why: '层级 2000' },
  front: { layer: 0, x: 100, y: 100, w: 400, h: 300 },
}

describe('截图不切窗:临时叫一下 → 藏回去', () => {
  it('★企业微信截图(藏着的被放出来)→ 只把企业微信藏回去;当前那一格不变、不置前任何窗', async () => {
    const { svc, helper } = await setup({ follow: true })
    await svc.handleActivation!(screenshot)
    expect(helper.calls).toEqual([{ op: 'hide_app', bundle_id: WECOM }])
    const view = await svc.view()
    expect(view?.stack.find(tab => tab.current)?.key).toBe('claude')
    expect(view?.recent_activations?.at(-1)).toMatchObject({ bundle_id: WECOM, verdict: 'transient', reason: 'overlay', decision: 'restore' })
    expect(view?.recent_activations?.at(-1)?.overlay).toEqual({ layer: 2000, x: 0, y: 0, w: 1920, h: 1080, why: '层级 2000' })
  })

  it('★不看名字:任何一家在窗口槽里、被临时叫出来(快速切回 / 划词浮窗)都一样藏回去', async () => {
    const { svc, helper } = await setup()
    await svc.handleActivation!({ ...screenshot, reason: 'quick_return', overlay: undefined as never })
    expect(helper.calls).toEqual([{ op: 'hide_app', bundle_id: WECOM }])
  })

  it('台前那一格自己被临时叫一下(企业微信在台前时用它截图):不动', async () => {
    const { svc, helper } = await setup()
    await svc.switchTo('wecom')
    helper.calls.length = 0
    await svc.handleActivation!({ ...screenshot, was_hidden: false })
    expect(helper.calls).toEqual([])
    expect((await svc.view())?.recent_activations?.at(-1)?.decision).toBe('current')
  })

  it('被叫出来之前就露着的(不是这一趟放出来的):不替他收', async () => {
    const { svc, helper } = await setup()
    await svc.handleActivation!({ ...screenshot, was_hidden: false })
    expect(helper.calls).toEqual([])
    expect((await svc.view())?.recent_activations?.at(-1)?.decision).toBe('was-visible')
  })

  it('不在窗口槽里的(系统截图 screencaptureui、没认领的 QQ):不动,只记一笔', async () => {
    const { svc, helper } = await setup({ follow: true })
    await svc.handleActivation!({ ...screenshot, bundle_id: 'com.apple.screencaptureui', was_hidden: false })
    await svc.handleActivation!({ ...screenshot, bundle_id: 'com.tencent.qq', verdict: 'switch', reason: undefined as never })
    expect(helper.calls).toEqual([])
    expect((await svc.view())?.recent_activations?.map(one => one.decision)).toEqual(['not-member', 'not-member'])
  })

  it('藏回去失败:如实记进观测环,不抛', async () => {
    const helper = fakeHelper()
    const svc = createDockService({
      file: join(await mkdtemp(join(tmpdir(), 'dock-activation-')), 'dock.json'),
      helper: { request: (req: HelperRequest) => req.op === 'hide_app' && helper.calls.length > 100 ? Promise.reject(new Error('x')) : helper.channel.request(req) },
      registry: registry(), runCommand: running, sleep: () => Promise.resolve(),
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(WECOM, INSIDE_FRAME)
    await svc.handleMoved(CLAUDE, INSIDE_FRAME)
    for (let i = 0; i < 101; i++) helper.calls.push({ op: 'screen_info' })
    await svc.handleActivation!(screenshot)
    expect((await svc.view())?.recent_activations?.at(-1)).toMatchObject({ decision: 'restore-failed', detail: 'x' })
  })
})

describe('真切过去 → 窗口槽跟过去', () => {
  const switched: ShellActivation = { bundle_id: WECOM, verdict: 'switch', was_hidden: true, prev_bundle_id: CLAUDE, dwell_ms: 1700, front: { layer: 0, x: 100, y: 100, w: 400, h: 300 } }

  it('★⌘Tab 到窗口槽里的企业微信、待满 1.5 秒 → 切过去(同点它的标签:当前那一格换成企业微信、Claude 藏起来)', async () => {
    let t = 1_000_000
    const { svc, helper } = await setup({ follow: true, now: () => t })
    t += 60_000 // 过了认领时那次程序化激活的抑制期
    await svc.handleActivation!(switched)
    expect(helper.calls).toContainEqual({ op: 'hide_app', bundle_id: CLAUDE })
    const view = await svc.view()
    expect(view?.stack.find(tab => tab.current)?.key).toBe('wecom')
    expect(view?.recent_activations?.at(-1)).toMatchObject({ verdict: 'switch', decision: 'follow' })
  })

  it('我们自己刚激活过的(切换、摆回的抑制期内):不算他切的', async () => {
    let t = 1_000_000
    const { svc, helper } = await setup({ follow: true, now: () => t })
    await svc.switchTo('wecom')
    await svc.switchTo('claude')
    helper.calls.length = 0
    t += 1000
    await svc.handleActivation!({ ...switched, bundle_id: WECOM })
    // 企业微信刚被 switchTo 激活过(抑制期 4 秒内)
    expect(helper.calls).toEqual([])
    expect((await svc.view())?.recent_activations?.at(-1)?.decision).toBe('ours')
  })

  it('本来就在台前:不动;没打开「跟」这一档(老用例 / 测试替身):不动,只记一笔', async () => {
    let t = 1_000_000
    const on = await setup({ follow: true, now: () => t })
    t += 60_000
    await on.svc.handleActivation!({ ...switched, bundle_id: CLAUDE })
    expect(on.helper.calls).toEqual([])
    expect((await on.svc.view())?.recent_activations?.at(-1)?.decision).toBe('already')
    const off = await setup()
    await off.svc.handleActivation!(switched)
    expect(off.helper.calls).toEqual([])
    expect((await off.svc.view())?.recent_activations?.at(-1)?.decision).toBe('follow-off')
  })
})

describe('遮罩一收就当场藏回去(2026-09-25 卡 P 补)', () => {
  // 统筹:「截图遮罩一关,立刻把被掀出来的那个窗位 App 藏回去,不等 1.5 秒判定窗口结束,让『窗口闪一下』尽量看不见。
  // 判定逻辑不变:真切换还是按 1.5 秒算。」遮罩开着时不能藏(会连遮罩一起藏掉,截图就断了),所以遮罩刚开时
  // 预约,遮罩一收壳当场藏(壳那一半的用例在 workbench-app/Tests/main.swift ⑦)。
  const overlayOpen: ShellActivation = {
    bundle_id: WECOM, verdict: 'overlay', reason: 'overlay', was_hidden: true, dwell_ms: 0,
    overlay: { layer: 103, x: 0, y: 0, w: 2560, h: 1440, why: '层级 103' },
  }

  it('★遮罩刚开:该藏回去的(窗口槽成员、不在台前、原来藏着)预约壳「遮罩一收就藏」;此刻不藏', async () => {
    const { svc, helper } = await setup({ follow: true })
    await svc.handleActivation!(overlayOpen)
    expect(helper.calls).toEqual([{ op: 'arm_rehide', bundle_id: WECOM }])
    expect((await svc.view())?.recent_activations?.at(-1)).toMatchObject({ bundle_id: WECOM, verdict: 'overlay', decision: 'armed' })
  })

  it('★遮罩一收、壳已经当场藏回去(rehidden):只记账,不再发 hide_app;当前那一格不变', async () => {
    const { svc, helper } = await setup({ follow: true })
    await svc.handleActivation!(overlayOpen)
    helper.calls.length = 0
    await svc.handleActivation!({ ...screenshot, rehidden: true })
    expect(helper.calls).toEqual([])
    const view = await svc.view()
    expect(view?.stack.find(tab => tab.current)?.key).toBe('claude')
    expect(view?.recent_activations?.at(-1)).toMatchObject({ verdict: 'transient', decision: 'restore', detail: '遮罩一收壳当场藏回' })
    expect(view?.recent_hides?.at(-1)).toMatchObject({ bundle_id: WECOM, decision: 'transient' })
  })

  it('台前那一格 / 原来就露着 / 不在窗口槽里:不预约,也不记(结论来了照原规矩记)', async () => {
    const { svc, helper } = await setup()
    await svc.handleActivation!({ ...overlayOpen, was_hidden: false })
    await svc.handleActivation!({ ...overlayOpen, bundle_id: 'com.apple.screencaptureui' })
    await svc.switchTo('wecom')
    helper.calls.length = 0
    await svc.handleActivation!(overlayOpen)
    expect(helper.calls).toEqual([])
    expect((await svc.view())?.recent_activations ?? []).toEqual([])
  })

  it('壳回说遮罩已经收了(迟到的预约没收)→ 记 arm-failed;结论来了照老路当场 hide_app', async () => {
    const helper = fakeHelper()
    const svc = createDockService({
      file: join(await mkdtemp(join(tmpdir(), 'dock-activation-')), 'dock.json'),
      helper: { request: (req: HelperRequest) => req.op === 'arm_rehide' ? Promise.resolve({ armed: false } as Record<string, unknown>) : helper.channel.request(req) },
      registry: registry(), runCommand: running, sleep: () => Promise.resolve(),
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(WECOM, INSIDE_FRAME)
    await svc.handleMoved(CLAUDE, INSIDE_FRAME)
    helper.calls.length = 0
    await svc.handleActivation!(overlayOpen)
    expect((await svc.view())?.recent_activations?.at(-1)).toMatchObject({ verdict: 'overlay', decision: 'arm-failed' })
    await svc.handleActivation!(screenshot)
    expect(helper.calls).toEqual([{ op: 'hide_app', bundle_id: WECOM }])
  })

  it('老壳(不会 rehide):不预约;结论来了照老路藏', async () => {
    const helper = fakeHelper()
    const svc = createDockService({
      file: join(await mkdtemp(join(tmpdir(), 'dock-activation-')), 'dock.json'),
      helper: { request: helper.channel.request, supports: (cap: string) => cap !== 'rehide' },
      registry: registry(), runCommand: running, sleep: () => Promise.resolve(),
    })
    svc.setSlotRect(SLOT_PAGE_RECT)
    await svc.handleMoved(WECOM, INSIDE_FRAME)
    await svc.handleMoved(CLAUDE, INSIDE_FRAME)
    helper.calls.length = 0
    await svc.handleActivation!(overlayOpen)
    expect(helper.calls).toEqual([])
    await svc.handleActivation!(screenshot)
    expect(helper.calls).toEqual([{ op: 'hide_app', bundle_id: WECOM }])
  })

  it('★预约之后,它的挪窗事件一概不认(壳在遮罩底下把它的窗挪到屏外):不当拖出除名、不当跑偏摆回;结论到了 3 秒后照常', async () => {
    // 不压的话:他按着左键在框选截图时壳挪窗 → 报成「拖出窗位」→ 企业微信被除名;没按左键 → 报成「自己跑偏」→ 摆回窗位,挪开白做。
    let clock = 1_000_000
    const { svc, helper } = await setup({ now: () => clock })
    await svc.handleActivation!(overlayOpen)
    helper.calls.length = 0
    const parkedFrame = { x: 2559, y: 1439, w: 1496, h: 868 }
    await svc.handleMoved(WECOM, parkedFrame, true, true)
    await svc.handleMoved(WECOM, parkedFrame, false, false)
    expect(helper.calls).toEqual([])
    let view = await svc.view()
    expect(view?.stack.map(tab => tab.key)).toContain('wecom')
    expect(view?.recent_moves?.at(-1)?.decision).toBe('parked')
    // 结论到了(壳藏好了、挪回了):再压 3 秒回声,过了照常处理
    await svc.handleActivation!({ ...screenshot, rehidden: true })
    await svc.handleMoved(WECOM, parkedFrame, false, false)
    view = await svc.view()
    expect(view?.recent_moves?.at(-1)?.decision).toBe('parked')
    clock += 3_001
    await svc.handleMoved(WECOM, parkedFrame, false, false)
    view = await svc.view()
    expect(view?.recent_moves?.at(-1)?.decision).not.toBe('parked')
  })

  it('★时间线原样进观测环(卡 P 补二,统筹事后核:掀出来 / 遮罩盖上 / 挪开 / 收起 / 藏好 / 挪回各在第几毫秒)', async () => {
    const { svc } = await setup()
    const timeline = {
      started_at: '2026-09-25T10:10:23.967Z', start_poll_ms: 10, unhide_ms: 0, first_look_ms: 11, overlay_on_ms: 11, armed_ms: 64,
      parked_ms: 83, parked: 1, overlay_off_ms: 2959, revealed_px: 1, rehide_ms: 2959, hidden_ms: 2978, unparked_ms: 2991, unparked: 1,
    }
    await svc.handleActivation!({ ...screenshot, rehidden: true, timeline })
    expect((await svc.view())?.recent_activations?.at(-1)).toMatchObject({ decision: 'restore', rehidden: true, timeline })
  })

  it('壳按预约藏的却正是台前那一格(预约之后它成了当前那一格):摆回来,不让窗口槽空着', async () => {
    const { svc, helper } = await setup()
    await svc.switchTo('wecom')
    helper.calls.length = 0
    await svc.handleActivation!({ ...screenshot, rehidden: true })
    expect(helper.calls.some(call => call.op === 'unhide_app' && call.bundle_id === WECOM)).toBe(true)
    const view = await svc.view()
    expect(view?.stack.find(tab => tab.current)?.key).toBe('wecom')
    expect(view?.recent_activations?.at(-1)).toMatchObject({ decision: 'current', detail: '壳按预约藏了台前那一格,摆回来' })
  })
})

describe('壳的 activation 消息', () => {
  it('主体字段对才收;几何那几格坏了只剥掉那一格', () => {
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'transient', reason: 'overlay', was_hidden: true, dwell_ms: 4000,
      overlay: { layer: 2000, x: 0, y: 0, w: 1920, h: 1080, why: '层级 2000' }, front: { layer: 'x' } })).toEqual({
      bundle_id: WECOM, verdict: 'transient', reason: 'overlay', was_hidden: true, dwell_ms: 4000,
      overlay: { layer: 2000, x: 0, y: 0, w: 1920, h: 1080, why: '层级 2000' },
    })
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'maybe', was_hidden: true })).toBeUndefined()
    // 遮罩开了(还不是结论)也收;rehidden 只在 transient 上认
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'overlay', reason: 'overlay', was_hidden: true, dwell_ms: 0, rehidden: true }))
      .toEqual({ bundle_id: WECOM, verdict: 'overlay', reason: 'overlay', was_hidden: true, dwell_ms: 0 })
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'transient', reason: 'overlay', was_hidden: true, dwell_ms: 5, rehidden: true })?.rehidden).toBe(true)
    // 时间线:只收小写名字 → 有限数字 / 不长的一句话;别的剥掉,整条不丢
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'transient', reason: 'overlay', was_hidden: true, dwell_ms: 5,
      timeline: { overlay_on_ms: 12, 'Bad Key': 1, park_error: 'x'.repeat(300), nested: { a: 1 }, unpark_error: 'AX 读不到它的窗', inf_ms: Number.POSITIVE_INFINITY } })?.timeline)
      .toEqual({ overlay_on_ms: 12, unpark_error: 'AX 读不到它的窗' })
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'switch', was_hidden: true, dwell_ms: 5, timeline: [1, 2] })?.timeline).toBeUndefined()
    expect(parseActivation({ kind: 'activation', verdict: 'switch', was_hidden: true })).toBeUndefined()
    expect(parseActivation({ kind: 'activation', bundle_id: WECOM, verdict: 'switch' })).toBeUndefined()
  })
})
