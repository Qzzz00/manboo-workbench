// @vitest-environment node
/**
 * **选项超过 40 字时「替她点」按不中**(2026-10-04,卡 `claude/three-small-1004`;
 * 出处 `docs/交接-1004-待确认带上下文.md` 待拍板 ②,统筹已定修)。
 *
 * 病在两处字对不上:
 * - 出门那一道(`server/waitingForYou.ts` 的 `questionView`)把选项 `label` 截到 **40 字 + 「…」**;
 * - 壳的 `agent_press` 是**按标签在它窗口里找那一项**(整行归一化之后相等,见
 *   `AgentWindowPolicy.matchOptionLabel`)—— 带「…」的那一行它窗口里压根没有,于是 `found:false`。
 *
 * 2026-10-04 卡 `claude/ask-with-context` 之后 `SessionAskView.full.options` 里有**原字**了,
 * 所以这一下改成:**显示照旧可短,送去按的是原字**。
 *
 * 守的几条:
 * ① 45 字的选项:她点的是短标签(界面上那一份),送进壳的 `label` 与 `options` 都是**原字**;
 * ② 老手机包只回短标签 → 照旧按得中(按下标配原字);新客户端直接回原字 → 一样按得中;
 * ③ **条数不一样就不配对**(宁可按短的那一份,不猜哪一颗对哪一颗 —— 同界面那一处的规矩);
 * ④ 没有 `full` 的那几条(窗口 / 按内容判出来的)一个字不变;
 * ⑤ 框已经收掉、退回「当一句话送进对话」那条路时,送进去的也是**原字**(不是带「…」的那一行)。
 */
import { describe, expect, it } from 'vitest'
import type { SessionAskOption, SessionView } from '../src/protocol.ts'
import { clipText } from '../src/server/agentWindowModel.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const SESSION = '01a0e814-ecb0-7192-8a50-d6870eb79c35'

/** 45 字(她那条真会遇上的长选项:一句带理由的方案名)。 */
const LONG = '把中转那条线的上限从每天 10 元提到 15 元,撞到了就停下来问我一句,别自己接着往下跑'
/** 另一条,一样超过 40 字。 */
const LONG2 = '保持每天 10 元不动,撞到了就直接停下来,等我第二天自己来看一眼再决定要不要加一点'
const SHORT = '再想想'

function clipped(label: string): string {
  return clipText(label, 40)
}

function asking(options: readonly SessionAskOption[], full?: readonly SessionAskOption[]): SessionView {
  return {
    agent: 'codex',
    session_id: SESSION,
    title: '上限提不提',
    status: 'waiting',
    ask: {
      kind: 'choose',
      question: '上限提不提?',
      quote: '上限提不提?',
      options,
      ...(full === undefined ? {} : { full: { question: '上限提不提?', options: full } }),
      by: 'form',
      since: '2026-10-04T12:55:02.780Z',
    },
  } as unknown as SessionView
}

function setup(view: SessionView, press: { found: boolean } = { found: true }) {
  const h = engineHarness({
    nameOf: () => 'Codex',
    reply: (req) => {
      if (req.op === 'agent_press') {
        return press.found
          ? { found: true, pressed: true, gone: true, how: 'ax_press' }
          : { found: false, note: '它窗口里没找到这一项(那个框可能已经不在了)' }
      }
      if (req.op === 'read_reply') return { found: true, busy: false, texts: [] }
      if (req.op === 'send_text') return { submitted: true, method: 'ax' }
      return {}
    },
  })
  const jobs = createSessionJobs({ engine: h.engine, registry: h.registry, sessions: () => [view] })
  return {
    jobs,
    pressed: () => h.requests.filter(one => one.op === 'agent_press').map(one => (one as { label: string }).label),
    marks: () => h.requests.filter(one => one.op === 'agent_press').map(one => (one as { options?: string[] }).options),
    sent: () => h.requests.filter(one => one.op === 'send_text').map(one => (one as { text: string }).text),
  }
}

/** 界面上那一份(截过的)+ 原字那一份,条数一样。 */
function bothViews() {
  const short = [clipped(LONG), clipped(LONG2), SHORT].map(label => ({ label }))
  const full = [LONG, LONG2, SHORT].map(label => ({ label }))
  return { short, full, view: asking(short, full) }
}

describe('选项超过 40 字:显示照旧短,送去按的是原字', () => {
  it('★她点的是界面上那一份(截过、带「…」)→ 送进壳的 label 是原字', async () => {
    const { short, view } = bothViews()
    // 前提先钉住:界面那一份真的被截过,而且与原字不是同一个串。
    expect(short[0]!.label).not.toBe(LONG)
    expect(short[0]!.label.endsWith('…')).toBe(true)

    const t = setup(view)
    const res = await t.jobs.press('codex', SESSION, short[0]!.label)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    expect(t.pressed()).toEqual([LONG])
  })

  it('★那一串候选(options / marks)也给原字 —— 壳是拿它在窗口里圈那个框的', async () => {
    const { short, view } = bothViews()
    const t = setup(view)
    await t.jobs.press('codex', SESSION, short[1]!.label)
    expect(t.pressed()).toEqual([LONG2])
    expect(t.marks()).toEqual([[LONG, LONG2, SHORT]])
  })

  it('新客户端直接回原字 → 一样按得中(两份字都认)', async () => {
    const { view } = bothViews()
    const t = setup(view)
    const res = await t.jobs.press('codex', SESSION, LONG2)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    expect(t.pressed()).toEqual([LONG2])
  })

  it('没超 40 字那一颗:截不截都是同一个串,送的还是它', async () => {
    const { view } = bothViews()
    const t = setup(view)
    await t.jobs.press('codex', SESSION, SHORT)
    expect(t.pressed()).toEqual([SHORT])
  })

  it('★两份条数不一样 → 不配对,按短的那一份(不猜哪一颗对哪一颗)', async () => {
    const short = [clipped(LONG), clipped(LONG2), SHORT].map(label => ({ label }))
    const t = setup(asking(short, [{ label: LONG }]))
    await t.jobs.press('codex', SESSION, short[0]!.label)
    expect(t.pressed()).toEqual([short[0]!.label])
  })

  it('没有 full 的那几条(窗口 / 按内容判出来的)一个字不变', async () => {
    const short = [{ label: '继续' }, { label: '停' }]
    const t = setup(asking(short))
    await t.jobs.press('codex', SESSION, '停')
    expect(t.pressed()).toEqual(['停'])
    expect(t.marks()).toEqual([['继续', '停']])
  })

  it('不是它给的那几项 → 照旧不点(两份字都对不上才算对不上)', async () => {
    const { view } = bothViews()
    const t = setup(view)
    const res = await t.jobs.press('codex', SESSION, '把上限提到 100 元')
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(t.pressed()).toEqual([])
  })

  it('★框已经收掉 → 退回「当一句话送进对话」,送进去的也是原字', async () => {
    const { short, view } = bothViews()
    const t = setup(view, { found: false })
    const res = await t.jobs.press('codex', SESSION, short[0]!.label)
    expect(res).toMatchObject({ ok: true })
    expect(t.sent()).toEqual([LONG])
  })
})
