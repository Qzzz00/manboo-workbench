// @vitest-environment node
/**
 * **Codex 那个选项框自己收掉了 → 把她点的那一项当一句话送进对话**(2026-09-28 20:5x,统筹真机复现)。
 *
 * 现场:Codex 用 `request_user_input_async` 问完,这一轮当场收工(task_complete),桌面 App 里那个
 * 选项框随这一轮一起没了 —— 不是工作台点掉的(统筹两次复现,全程没动它,Codex 自己的记录对得上)。
 * 下午「川菜」「饮料」那两次点得进,是因为那两次它问完原地 sleep 等着,框一直在。
 * 维护者:「是把我的文字复制过去发送」—— 框没了,她点的那一项就原样送进这条对话、按发送。
 *
 * 另一件(同一晚,维护者):手机上打的话送进对话时**不带「事务官捎话」那个前缀**,只送她的原话。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):点一下 / 送一句都在**一条引擎**后面了
 * (`sessionJobs` 判断 + `engine/adapters/window.ts` 动手),所以这一份改成「假壳 + 真引擎」端到端跑。
 * 守的那一条没变:**闸拦下的那一下不许走这条替代的路**(`JobResult.blocked`),见最后一条用例。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { ASK_LANDED_POLL_MS, ASK_LANDED_POLL_TRIES } from '../src/server/askLanded.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { relayPrompt } from '../src/server/sessionRelay.ts'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const OPTIONS = ['🍜 面食｜来一碗热乎乎的汤面', '🍲 火锅｜边涮边吃，慢慢享受', '🍣 日料｜寿司刺身，清爽一点']

function codexAsking(): SessionView {
  return {
    agent: 'codex',
    session_id: '01a0e814-ecb0-7192-8a50-d6870eb79c35',
    title: '发起晚餐单选题',
    status: 'waiting',
    ask: {
      kind: 'choose',
      question: '今晚想吃哪一种？',
      quote: '今晚想吃哪一种？',
      options: OPTIONS.map(label => ({ label })),
      by: 'form',
      since: '2026-09-28T12:55:02.780Z',
    },
  } as unknown as SessionView
}

const SESSION = '01a0e814-ecb0-7192-8a50-d6870eb79c35'

function setup(press: { found: boolean }, limits?: EngineHarnessOptions['limits']) {
  const h = engineHarness({
    nameOf: () => 'Codex',
    ...(limits === undefined ? {} : { limits }),
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
  const answer = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => [codexAsking()],
  })
  return {
    answer,
    pressed: () => h.requests.filter(one => one.op === 'agent_press').map(one => (one as { label: string }).label),
    sent: () => h.requests.filter(one => one.op === 'send_text').map(one => (one as { text: string }).text),
  }
}

describe('选项框收掉了,她点的那一项照样送进去', () => {
  it('★框还在 → 替她点,不另发一句', async () => {
    const t = setup({ found: true })
    const res = await t.answer.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    expect(t.pressed()).toEqual([OPTIONS[1]])
    expect(t.sent()).toEqual([])
  })

  it('★框没了 → 她点的那一项原样当一句话送进这条对话、按发送', async () => {
    const t = setup({ found: false })
    const res = await t.answer.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true })
    expect(t.sent()).toEqual([OPTIONS[1]])
  })

  it('不是它给的那几项 → 照旧不点也不发', async () => {
    const t = setup({ found: false })
    const res = await t.answer.press('codex', SESSION, '烧烤')
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(t.pressed()).toEqual([])
    expect(t.sent()).toEqual([])
  })

  /*
   * ★ 2026-10-02(卡 AG2 的那一条口径,接线这张卡搬到 `JobResult.blocked`):
   * **动作闸拦下的那一下不许走这条替代的路** —— 换一条路办同一件事也是动她的电脑。
   * 从前靠「壳说 found:false」判,闸拦下时也会漏进这条路(等于没拦)。
   */
  it('★闸拦下那一下:一项都没点,也**不**另发一句', async () => {
    const t = setup({ found: true }, { press_option: { tries: 0, minIntervalMs: 0 } })
    const res = await t.answer.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: false, status: 200, where: 'desk' })
    expect(t.pressed()).toEqual([])
    expect(t.sent()).toEqual([])
  })
})

describe('她打的话送进对话:只送原话,不带前缀', () => {
  it('★捎话送进去的就是她那句,前后不加一个字', () => {
    expect(relayPrompt({ sessionId: '01a0e814-ecb0', said: '  停下  ' })).toBe('停下')
  })
})

/* ───── 替她答完按「窗口里新冒出来的行」判(2026-10-13 下午,卡 C;14:17 真机那一通)───── */

describe('★★ 点不上 → 打字回退 → 再读一次窗口,按结果判「成没成」', () => {
  /** 送之前那扇窗:题和那几个选项都在屏上(所以「咖啡」按「有没有」判一定成立)。 */
  const BEFORE = ['我最想喝哪种饮料?', '可乐', '茶', '咖啡', '果汁']

  function press(windows: readonly (readonly string[])[]) {
    const h = engineHarness({
      nameOf: () => '豆包',
      reply: (req) => {
        // 14:17 真机:普通包工作模式下这一项从来没点上过。
        if (req.op === 'agent_press') return { found: false, note: '它窗口里没找到这一项' }
        if (req.op === 'read_reply') return { found: true, busy: false, texts: [] }
        // 壳说「送出去了,可回执没核上」—— 这一下正是那一通念出内部提示的源头。
        if (req.op === 'send_text') return { submitted: false, note: '已尝试发送,但回执尚未确认' }
        return {}
      },
    })
    let at = 0
    const naps: number[] = []
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [codexAsking()],
      askWindowLines: async () => windows[Math.min(at++, windows.length - 1)],
      // 用例里不真等(真路上是每拍 1 秒);这几拍的间隔在 `naps` 里逐个量。
      sleep: async (ms) => { naps.push(ms) },
    })
    return { service, reads: () => at, naps: () => naps }
  }

  it('★它那边冒出「收到:…」→ confirmed:true(壳的回执说没核上也照样算办成了)', async () => {
    const t = press([BEFORE, [...BEFORE, '🍲 火锅｜边涮边吃，慢慢享受', '收到:🍲 火锅｜边涮边吃，慢慢享受']])
    const res = await t.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    // 送之前量一眼、送完再量一眼 —— 两次只读,一个字都不送
    expect(t.reads()).toBe(2)
  })

  it('★窗口里什么都没多出来 → 照旧 confirmed:false,note 如实说为什么', async () => {
    const t = press([BEFORE, BEFORE])
    const res = await t.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: false })
    expect((res as { note?: string }).note).toContain('没多出来')
  })

  it('这一档没接上(老宿主 / 读不到那扇窗)→ 行为与 2026-10-13 之前一字不差:照壳的回执说', async () => {
    // 这一份假壳说「送出去了」(submitted:true)→ 照它说 confirmed:true,一个窗都不读
    const t = setup({ found: false })
    expect(await t.answer.press('codex', SESSION, OPTIONS[1] as string)).toMatchObject({ ok: true, confirmed: true })
    // 读窗这一档接上了、可两头有一头读不到 → 照旧 confirmed:false,不替它说办成了
    const blind = press([])
    const res = await blind.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: false })
  })

  /* ───── 判漏那两处(2026-10-13 傍晚,卡 J;16:33 真机那一通)───── */

  it('★★ 它那句回话 2–5 秒才冒出来 → 每秒读一拍,冒出来就停(不是送完立刻读一次就下结论)', async () => {
    // 前两拍窗口一个字没变(豆包还在打字),第三拍才冒出「收到:…」
    const landed = [...BEFORE, '收到:🍲 火锅｜边涮边吃，慢慢享受']
    const t = press([BEFORE, BEFORE, BEFORE, landed])
    const res = await t.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    // 1 次底子 + 3 拍(第三拍成立就停,不再读第四拍)
    expect(t.reads()).toBe(4)
    expect(t.naps()).toEqual([ASK_LANDED_POLL_MS, ASK_LANDED_POLL_MS])
  })

  it('★六拍都没动静 → 这才 confirmed:false,note 如实(不无限读下去)', async () => {
    const t = press([BEFORE])
    const res = await t.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: false })
    expect((res as { note?: string }).note).toContain('没多出来')
    // 1 次底子 + 最多六拍
    expect(t.reads()).toBe(1 + ASK_LANDED_POLL_TRIES)
  })

  it('★★ 答完那个提问面板整块收起来了 → 算办成(16:33 那一通:提到答案的行反而变少)', async () => {
    /** 送之前:那段对话 + 面板那四行(它那一句原话 + 三个选项)都画在屏上。 */
    const panelOn = ['我们聊到晚饭', '今晚想吃哪一种？', ...OPTIONS]
    // 面板那几行(题 + 另两个选项)全没了,她点的那一项成了对话里的一个气泡 —— 提到答案的行一条没多
    const t = press([panelOn, ['我们聊到晚饭', OPTIONS[1] as string]])
    const res = await t.service.press('codex', SESSION, OPTIONS[1] as string)
    expect(res).toMatchObject({ ok: true, confirmed: true })
    expect((res as { note?: string }).note).toContain('面板')
    expect(t.reads()).toBe(2)
  })

  it('底子读不到就一拍都不轮询(判不出哪一行是新的,白等 6 秒)', async () => {
    const t = press([])
    expect(await t.service.press('codex', SESSION, OPTIONS[1] as string)).toMatchObject({ ok: true, confirmed: false })
    expect(t.reads()).toBe(1)
    expect(t.naps()).toEqual([])
  })
})
