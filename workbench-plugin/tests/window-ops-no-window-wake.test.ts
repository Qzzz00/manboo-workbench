// @vitest-environment node
/**
 * **「窗没露出来」在哪一条路上都不是终点**(2026-10-01,卡 AX2)。
 *
 * 现场(维护者 21:0x,紧接卡 AX 那次真机修完):「把你说的三种情况赶紧也搞通,**能力是通用的**」。
 * 卡 AX 只把「打字发送」那一条收进了「没窗口 → 把窗开出来 → 等一拍 → 再试」那一圈
 * (用例在 `relay-no-window-wake.test.ts`);另外三条路撞上同一件事照旧当场失败:
 * - 点选项(`agent_press`)
 * - 写提问面板(`agent_write_ask`)
 * - 看 / 按权限弹窗(`agent_approval`,卡 AP)
 *
 * 守的口径(那一圈只写一份:`windowWake.withWindowWake`):
 * ① 壳说没窗口 → 深链 / `open -b` 把窗真正开出来、等一拍、再来一遍,最多 `NO_WINDOW_WAKE_TRIES` 回;
 * ② 中途窗露出来了 → 照样点上 / 写进去 / 读到键(她不用到电脑上自己点);
 * ③ 到顶还是没有 → **如实说**,并且说出又开了几回(`NO_WINDOW_GAVE_UP`);
 * ④ **别的失败一回都不重开**:那是那扇窗上的事实(没找着那一项 / 认不出面板 / 那颗键按不动),
 *    重开只会**多点一下、多写一遍** —— 这一条是这张卡最怕的事;
 * ⑤ 真壳(`helperChannel`)ok:false 是 **reject 一个 Error**,不是回 `{ok:false}`(4505d5da 那次真机)。
 *    所以每条路**两种都测**:回 `{ok:false}` 与 reject;
 * ⑥ 「只读一眼、不动她的窗口」那一路(`readApproval active:false`)**一回都不开窗**。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):六只手删了,这几下都在
 * `engine/adapters/window.ts` 一处 —— 这一份于是直接驱动那个适配器(拼 `Job`),
 * 「点选项」那一路再从服务那一层(`sessionJobs`)走一遍,核实深链真的交到了那一层手里。
 * 结构化的 `front` 那一格没有了(契约里 `JobResult` 没有它);「又开了几回」照旧在 `why` 里。
 */
import { describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { SessionView } from '../src/protocol.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import { NO_WINDOW_GAVE_UP, NO_WINDOW_WAKE_TRIES } from '../src/server/windowWake.ts'
import { createWindowAdapter, type WindowAdapterDeps } from '../src/server/engine/adapters/window.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness } from './helpers/engineHarness.ts'

/** 壳那句原话(`SendTextPolicy.Failure.noWindow`,workbench-app/Sources/SendTextPolicy.swift)。 */
const NO_WINDOW = '找不到窗口:com.anthropic.claudefordesktop 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)'
/** 别的失败一例(辅助功能那一层回了错):这一类**一回都不重开**。 */
const AX_ERROR = '它窗口里点不动:com.anthropic.claudefordesktop AXPress 回 -25200'
const BUNDLE = 'com.anthropic.claudefordesktop'
const DEEP_LINK = 'claude://code/continue?session=local_aceefe64'
const CAPS = ['read_reply', 'agent_press', 'agent_write_ask', 'agent_approval', 'agent_stop', 'new_conversation']

type Shell = ReturnType<typeof shell>

/**
 * 一份假壳:认 `op` 那一下前 `noWindowTimes` 次「没窗口」,之后成功。
 * `rejects:true` = 像真壳那样 **reject 一个 Error**(不是回 `{ok:false}`)。
 */
function shell(options: { op: HelperRequest['op'], noWindowTimes: number, error?: string, rejects?: boolean, ok: Record<string, unknown>, press?: Record<string, unknown> }) {
  let calls = 0
  return {
    calls: () => calls,
    helper: {
      connected: () => true,
      supports: (cap: string) => CAPS.includes(cap),
      request: async (req: HelperRequest): Promise<Record<string, unknown>> => {
        if (req.op !== options.op) return {}
        // `agent_approval` 一个 op 两种用法:不带 `press` = 读一眼,带 `press` = 按那一颗。
        const pressing = req.op === 'agent_approval' && (req as { press?: string }).press !== undefined
        if (pressing && options.press !== undefined) return { ok: true, result: options.press }
        calls += 1
        if (calls <= options.noWindowTimes) {
          if (options.rejects === true) throw new Error(options.error ?? NO_WINDOW)
          return { ok: false, error: options.error ?? NO_WINDOW }
        }
        return { ok: true, result: options.ok }
      },
    },
  }
}

/** 那个适配器 + 开窗那两下的台账(开了几回深链、几回 `open -b`)。 */
function adapterOf(fake: Shell, options: { deepLink?: boolean } = {}) {
  const opened: string[] = []
  const openedApps: string[] = []
  const deps: WindowAdapterDeps = {
    helper: fake.helper,
    installed: () => [{ bundle_id: BUNDLE, name: 'Claude', running: true }],
    ...(options.deepLink === false ? {} : { hostIdOf: () => 'local_aceefe64' }),
    ...(options.deepLink === false ? {} : { openUrl: async (url: string) => { opened.push(url); return { ok: true } } }),
    openApp: async (bundleId: string) => { openedApps.push(bundleId); return { ok: true } },
    nameOf: () => 'Claude',
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { opened, openedApps, it: createWindowAdapter('claude', deps) }
}

function job(over: Partial<Job> & Pick<Job, 'kind' | 'text'>): Job {
  return {
    id: 'job-1',
    family: 'claude',
    target: { kind: 'session', sessionId: 'aceefe64' },
    expect: 'none',
    ...over,
  }
}

const PANEL = { rect: { x: 10, y: 20, w: 300, h: 120 }, keys: ['批准一次', '拒绝'] }

describe('点那一项(agent_press):没窗口就把窗开出来再点一回', () => {
  for (const rejects of [false, true]) {
    const how = rejects ? 'reject 版(真壳就是这样)' : '回 ok:false 版'
    it(`★头两次说一扇窗都没有 → 重开两回、第三次点上了(${how})`, async () => {
      const fake = shell({ op: 'agent_press', noWindowTimes: 2, rejects, ok: { found: true, pressed: true, gone: true, how: 'ax_press' } })
      const made = adapterOf(fake)
      const got = await made.it.run(job({ kind: 'press', text: '川菜', marks: ['川菜', '粤菜'] }))
      expect(got.delivered).toBe('confirmed')
      expect(fake.calls()).toBe(3)
      expect(made.opened).toEqual([DEEP_LINK, DEEP_LINK])
    })

    it(`★一直没窗口 → 如实说、说出又开了几回(${how})`, async () => {
      const fake = shell({ op: 'agent_press', noWindowTimes: 99, rejects, ok: {} })
      const made = adapterOf(fake)
      const got = await made.it.run(job({ kind: 'press', text: '川菜', marks: ['川菜', '粤菜'] }))
      expect(got.delivered).toBe('not_sent')
      expect(fake.calls()).toBe(1 + NO_WINDOW_WAKE_TRIES)
      expect(got.why).toContain('一扇标准窗口都没有')
      expect(got.why).toContain(NO_WINDOW_GAVE_UP)
    })
  }

  it('★别的失败一回都不重开(重开就是多点一下)', async () => {
    const fake = shell({ op: 'agent_press', noWindowTimes: 99, error: AX_ERROR, rejects: true, ok: {} })
    const made = adapterOf(fake)
    const got = await made.it.run(job({ kind: 'press', text: '川菜', marks: ['川菜', '粤菜'] }))
    expect(got.delivered).toBe('not_sent')
    expect(fake.calls()).toBe(1)
    expect(made.openedApps).toEqual([])
    expect(got.why).not.toContain(NO_WINDOW_GAVE_UP)
  })

  it('★没有深链的那一刻:走 `open -b` 把它的窗开出来,再点', async () => {
    const fake = shell({ op: 'agent_press', noWindowTimes: 1, rejects: true, ok: { found: true, pressed: true, gone: true } })
    const made = adapterOf(fake, { deepLink: false })
    const got = await made.it.run(job({ kind: 'press', text: '川菜', marks: ['川菜', '粤菜'] }))
    expect(got.delivered).toBe('confirmed')
    expect(made.openedApps).toEqual([BUNDLE])
  })

  it('★壳碰到了窗、只是没找着那一项(found:false):**不是**没窗口,一回都不重开', async () => {
    const fake = shell({ op: 'agent_press', noWindowTimes: 0, ok: { found: false, note: '它窗口里没找到「川菜」这一项' } })
    const made = adapterOf(fake)
    const got = await made.it.run(job({ kind: 'press', text: '川菜', marks: ['川菜', '粤菜'] }))
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('没找到')
    expect(fake.calls()).toBe(1)
    expect(made.openedApps).toEqual([])
  })
})

describe('写那个提问面板(agent_write_ask):同一套', () => {
  /** 写面板那一路只对真机上认准了的那个包开着(`WRITE_ASK_PACKAGES`),所以这一组动豆包办公那个包。 */
  const DOUBAO = 'com.work.pc.doubao'
  const marks = ['川菜', '你最喜欢哪种菜系?']
  function doubaoAdapter(fake: Shell, options: { deepLink?: boolean } = {}) {
    const opened: string[] = []
    const openedApps: string[] = []
    const deps: WindowAdapterDeps = {
      helper: fake.helper,
      installed: () => [{ bundle_id: DOUBAO, name: '豆包工作', running: true }],
      ...(options.deepLink === false ? {} : { openUrl: async (url: string) => { opened.push(url); return { ok: true } } }),
      openApp: async (bundleId: string) => { openedApps.push(bundleId); return { ok: true } },
      nameOf: () => '豆包办公',
      sleep: async () => {},
      wakeWaitMs: 0,
      settleMs: 0,
    }
    return { opened, openedApps, it: createWindowAdapter('doubao', deps) }
  }
  const writeJob = (): Job => ({ ...job({ kind: 'write_ask', text: '换成江浙菜,清淡一点', marks }), family: 'doubao' })

  for (const rejects of [false, true]) {
    const how = rejects ? 'reject 版' : '回 ok:false 版'
    it(`★两次没窗口 → 重开两回、第三次写进去了(${how})`, async () => {
      const fake = shell({ op: 'agent_write_ask', noWindowTimes: 2, rejects, ok: { found: true, wrote: true, submitted: true, gone: true, echoed: true } })
      const made = doubaoAdapter(fake)
      const got = await made.it.run(writeJob())
      expect(got.delivered).toBe('confirmed')
      expect(fake.calls()).toBe(3)
      expect(made.openedApps).toEqual([DOUBAO, DOUBAO])
    })

    it(`★一直没窗口 → 如实说,一个字不假装(${how})`, async () => {
      const fake = shell({ op: 'agent_write_ask', noWindowTimes: 99, rejects, ok: {} })
      const made = doubaoAdapter(fake)
      const got = await made.it.run(writeJob())
      expect(got.delivered).toBe('not_sent')
      expect(fake.calls()).toBe(1 + NO_WINDOW_WAKE_TRIES)
      expect(got.why).toContain(NO_WINDOW_GAVE_UP)
    })
  }

  it('★别的失败一回都不重开(重开就是把她那句**多写一遍**)', async () => {
    const fake = shell({ op: 'agent_write_ask', noWindowTimes: 99, error: AX_ERROR, rejects: true, ok: {} })
    const made = doubaoAdapter(fake)
    const got = await made.it.run(writeJob())
    expect(got.delivered).toBe('not_sent')
    expect(fake.calls()).toBe(1)
    expect(made.openedApps).toEqual([])
  })
})

describe('批准弹窗(agent_approval):读那几颗键 / 按那一颗,都是同一套', () => {
  const approveJob = (): Job => job({ kind: 'press', text: '批准一次', marks: ['rm -rf ./build'] })

  for (const rejects of [false, true]) {
    const how = rejects ? 'reject 版' : '回 ok:false 版'
    it(`★读键:两次没窗口 → 重开两回、第三次读到了(${how})`, async () => {
      const fake = shell({ op: 'agent_approval', noWindowTimes: 2, rejects, ok: { panels: [PANEL] } })
      const made = adapterOf(fake)
      const got = await made.it.readApproval!(approveJob(), { active: true })
      expect(got.panels).toEqual([PANEL])
      expect(fake.calls()).toBe(3)
    })

    it(`★按键:两次没窗口 → 重开两回、第三次按上了(${how})`, async () => {
      const fake = shell({ op: 'agent_approval', noWindowTimes: 2, rejects, ok: { panels: [PANEL] }, press: { found: true, pressed: true, gone: true } })
      const made = adapterOf(fake)
      const got = await made.it.run(approveJob())
      expect(got.delivered).toBe('confirmed')
      expect(fake.calls()).toBe(3)
    })

    it(`★按键:一直没窗口 → 如实说(${how})`, async () => {
      const fake = shell({ op: 'agent_approval', noWindowTimes: 99, rejects, ok: {} })
      const made = adapterOf(fake)
      const got = await made.it.run(approveJob())
      expect(got.delivered).toBe('not_sent')
      expect(fake.calls()).toBe(1 + NO_WINDOW_WAKE_TRIES)
      expect(got.why).toContain(NO_WINDOW_GAVE_UP)
    })
  }

  it('★「只读一眼、不动她的窗口」那一路(active:false):**一回都不开窗**,也不说「又开了几回」', async () => {
    const fake = shell({ op: 'agent_approval', noWindowTimes: 99, rejects: true, ok: {} })
    const made = adapterOf(fake)
    const got = await made.it.readApproval!(approveJob(), { active: false })
    expect(got.panels).toEqual([])
    expect(fake.calls()).toBe(1)
    expect(made.opened).toEqual([])
    expect(made.openedApps).toEqual([])
    expect(got.why).not.toContain(NO_WINDOW_GAVE_UP)
  })
})

describe('按它的停止键(agent_stop):「打断再发」的第一下也是一下', () => {
  it('★两次没窗口 → 重开两回、第三次按上了(reject 版)', async () => {
    const fake = shell({ op: 'agent_stop', noWindowTimes: 2, rejects: true, ok: { found: true, pressed: true, stopped: true } })
    const made = adapterOf(fake)
    const got = await made.it.run(job({ kind: 'stop', text: '' }))
    expect(got.delivered).toBe('confirmed')
    expect(fake.calls()).toBe(3)
  })

  it('★别的失败一回都不重开(重开就是**多按一次停止**)', async () => {
    const fake = shell({ op: 'agent_stop', noWindowTimes: 99, error: AX_ERROR, rejects: true, ok: {} })
    const made = adapterOf(fake)
    const got = await made.it.run(job({ kind: 'stop', text: '' }))
    expect(got.delivered).toBe('not_sent')
    expect(fake.calls()).toBe(1)
    expect(made.openedApps).toEqual([])
  })
})

/** 它弹了个框问她选哪一项(「点选项」那一路从服务那一层走一遍)。 */
const asking: SessionView = {
  agent: 'claude',
  session_id: 'aceefe64',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 90,
  unread: false,
  updated_at: '2026-10-01T13:00:00.000Z',
  title: '点选项撞上没窗口',
  ask: {
    kind: 'choose',
    question: '你最喜欢哪种菜系?',
    since: '2026-10-01T12:58:00.000Z',
    quote: '你最喜欢哪种菜系?',
    by: 'form',
    options: [{ label: '川菜' }, { label: '粤菜' }],
  },
}

describe('点选项:服务那一层也走同一圈(深链真的交到了那一层手里)', () => {
  it('★手机上点「川菜」:两次没窗口 → 重开两回(走深链)、第三次点上了', async () => {
    let presses = 0
    const opened: string[] = []
    const h = engineHarness({
      installed: () => [{ bundle_id: BUNDLE, name: 'Claude', running: true }],
      hostIdOf: () => 'local_aceefe64',
      openUrl: async (url: string) => { opened.push(url); return { ok: true } },
      nameOf: sessionAgentName,
      reply: (req) => {
        if (req.op !== 'agent_press') return {}
        presses += 1
        if (presses <= 2) throw new Error(NO_WINDOW)
        return { found: true, pressed: true, gone: true }
      },
    })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [asking],
      entryOf: () => 'claude-desktop',
      hostIdOf: () => 'local_aceefe64',
      agentName: sessionAgentName,
    })
    await h.registry.targets()
    const got = await service.press('claude', 'aceefe64', '川菜')
    expect(got).toMatchObject({ ok: true, label: '川菜', confirmed: true })
    expect(presses).toBe(3)
    expect(opened).toEqual([DEEP_LINK, DEEP_LINK])
  })
})
