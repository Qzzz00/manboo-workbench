// @vitest-environment node
/**
 * **自绘界面那一档映射成能力**(2026-10-02,卡「窗口适配器」接卡「适配自绘界面的 Kimi」)。
 *
 * 那张卡查实的现场:官网版 Kimi 登录之后辅助功能树里 `AXUnknown:32`、`inputs:0 send:0`、
 * 对话文字 12 行读得到 —— **读得到、输入框与发送键认不出**。它把这一档判在
 * `agentJudge.judgeStructure`(`mode: 'paste_only'`),送话那一侧由壳内部那条
 * 「点一下 + 粘贴 + 回车」接住,**壳 op 的字段一格没动**。
 *
 * 所以适配器这一侧只做一件事:**把那一格映射成能力,并且让 `run` 跟 `capabilities` 说一样的话**。
 * - 送 / 读照旧(粘贴那条退路在壳里);
 * - **按名字找键的那三样说不行**:点选项、按停止、在侧栏里点那一行 —— 自绘的控件没有名字,
 *   `agent_press` / `agent_stop` / `agent_pick` 一定找不着。认错的方向**悲观**。
 *
 * 两处说不一样的话会出 D13 那个病:界面上摆着一颗能点的键,点下去说「到电脑上点」。
 * 这一份就是钉住「两处一样」。**代码里一个 App 的名字都没有** —— 哪一家是自绘界面现查。
 */
import { describe, expect, it } from 'vitest'
import { createWindowAdapter } from '../src/server/engine/adapters/window.ts'
import type { WindowAdapterDeps } from '../src/server/engine/adapters/window.ts'
import type { Job, JobKind } from '../src/server/engine/adapter.ts'
import type { StructureMode } from '../src/server/agentJudge.ts'
import { judgeStructure } from '../src/server/agentJudge.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'

const FAMILY = 'kimi'
const BUNDLE = 'com.moonshot.kimichat.kmp.mac'
const CAPS = ['read_reply', 'agent_pick', 'agent_press', 'agent_write_ask', 'agent_stop', 'agent_approval', 'new_conversation']

function made(mode: StructureMode | undefined) {
  const requests: HelperRequest[] = []
  const deps: WindowAdapterDeps = {
    helper: {
      connected: () => true,
      supports: (cap: string) => CAPS.includes(cap),
      request: async (req: HelperRequest) => {
        requests.push(req)
        if (req.op === 'read_reply') return { ok: true, result: { found: true } }
        return { ok: true, result: { found: true, pressed: true, gone: true, stopped: true, wrote: true, submitted: true, echoed: true } }
      },
    },
    installed: () => [{ bundle_id: BUNDLE, name: 'Kimi', running: true }],
    bundleOf: () => BUNDLE,
    nameOf: () => 'Kimi',
    ...(mode === undefined ? {} : { structureMode: () => mode }),
    openApp: async () => ({ ok: true }),
    bringToFront: async () => ({ ok: true }),
    sleep: async () => {},
    wakeWaitMs: 0,
    settleMs: 0,
  }
  return { requests, it: createWindowAdapter(FAMILY, deps) }
}

function job(kind: JobKind, text: string, marks?: readonly string[]): Job {
  return {
    id: `job-${kind}`,
    family: FAMILY,
    kind,
    target: { kind: 'session', sessionId: 'window:825f1900' },
    text,
    ...(marks === undefined ? {} : { marks }),
    expect: 'none',
  }
}

/** 卡「适配自绘界面的 Kimi」第一节那份诊断包(20261002-193929)的计数,原样当夹具。 */
const SELF_DRAWN_PROBE = {
  running: true,
  windows: 1,
  window: { w: 1200, h: 800 },
  inputs: [],
  send: [],
  lists: [],
  texts: { above_input: 12, left: 0 },
  left_links: 0,
  new_chat: { menu: [], buttons: [] },
  roles: { AXGroup: 4, AXScrollArea: 6, AXUnknown: 32, AXButton: 4, AXWindow: 1, AXScrollBar: 5, AXStaticText: 23 },
}

describe('那一档不是写死的,是 judgeStructure 现查的', () => {
  it('★那份诊断包的计数喂进 judgeStructure → paste_only(差异表里一行都没写 Kimi 的行为)', () => {
    const verdict = judgeStructure(SELF_DRAWN_PROBE as unknown as Parameters<typeof judgeStructure>[0])
    expect(verdict.pass).toBe(true)
    expect(verdict.mode).toBe('paste_only')
  })
})

describe('capabilities:读得到、写入靠粘贴,按名字找键的那三样说不行', () => {
  it('★paste_only', async () => {
    const caps = await made('paste_only').it.capabilities()
    expect(caps.send).toBe(true)
    expect(caps.read).toBe(true)
    expect(caps.open).toBe(true)
    expect(caps.press).toBe(false)
    expect(caps.stop).toBe(false)
    // 侧栏那几行也是自绘的 —— 没有深链的这一家于是开不到某一段。
    expect(caps.openSession).toBe(false)
  })

  it('★full(认得出输入框)/ 没判过(老宿主)→ 一样都不少', async () => {
    for (const mode of ['full', undefined] as const) {
      const caps = await made(mode).it.capabilities()
      expect(caps.press).toBe(true)
      expect(caps.stop).toBe(true)
      expect(caps.openSession).toBe(true)
    }
  })
})

describe('run 跟 capabilities 说一样的话', () => {
  it('★点选项 / 写面板 / 按停止:一个 op 都不发,unsupported + 人话', async () => {
    for (const [kind, text, marks] of [
      ['press', '方案 A', ['方案 A', '方案 B']],
      ['write_ask', '先按方案 A 做', ['要不要动数据库']],
      ['stop', ''],
    ] as const) {
      const one = made('paste_only')
      const got = await one.it.run(job(kind, text, marks as readonly string[] | undefined))
      expect(got.delivered).toBe('not_sent')
      expect(got.unsupported).toBe(true)
      expect(got.why).toContain('自己画的')
      // 一个字都没在她的窗口上动过。
      expect(one.requests).toEqual([])
    }
  })

  it('★送话照旧送得进去(壳内部那条粘贴的退路;op 字段一格没动)', async () => {
    const one = made('paste_only')
    const got = await one.it.run(job('relay', '用一句话回答:一周有几天', ['一周有几天']))
    expect(got.delivered).toBe('confirmed')
    const sent = one.requests.find(req => req.op === 'send_text') as Extract<HelperRequest, { op: 'send_text' }>
    // 适配器照现有契约写:没有一格新字段。
    expect(Object.keys(sent).sort()).toEqual(['bundle_id', 'index', 'op', 'restore_front', 'submit', 'text'])
  })

  it('★full 那一档照旧点得下去', async () => {
    const one = made('full')
    const got = await one.it.run(job('press', '方案 A', ['方案 A', '方案 B']))
    expect(got.delivered).toBe('confirmed')
  })
})
