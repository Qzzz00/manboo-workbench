/**
 * 派活第一段:把一段话送进那家客户端的输入框(2026-09-21)。
 *
 * Ben 纠正过派活的定义:「派活是直接操作对应的 Agent 客户端」。三段里 ② 知道做完没、
 * ③ 把回复读回来都是现成的,这张卡只做 ①。这一份钉的是**服务端**那一半:
 * 白名单、失败归因、会话怎么认、送话那条链的每一步失败都说得出是哪一步断的。
 *
 * 壳那一半(哪个元素是输入框、哪颗按钮是发送、输入法)在 `workbench-app/Tests/main.swift`。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」)这一份跟着改了五处口径,逐条写在用例里:
 *
 * 1. `createClientDispatch` 搬到 `src/server/dispatchSend.ts`,`deps` 只剩
 *    `{ engine, targets?, unreadable?, sessionIdsOf, now }` —— 拉起来 / 叫台前 / 开窗 / 打字发送
 *    全在窗口适配器,所以这一份用「假壳 + 真引擎」(`engineHarness`)端到端跑。
 * 2. 写死的 `CLIENT_DISPATCH_BUNDLES` 删了:**家 → 包只问 `agentSources`**(家族目录一处)。
 * 3. `submit:false`(只写进框、不发出去)照旧走得通:契约加了 `Job.submit` 那一格,
 *    壳的 `send_text` 字段一个没动;只是那一下**没有证据可核**,所以结局是「未确证」+ 一句实话。
 * 4. `method`(壳走的是打属性还是粘贴)**不再记在卡上**:契约里 `JobResult` 没有这一格。
 * 5. 「叫不到台前」不再往回包里带一句 —— 那一下在适配器里,`JobResult` 也没有 `front` 那一格。
 */
import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../src/server/apps.ts'
import { FAMILY_SOURCES, bindingFor, openCommandFor, packagesOf } from '../src/server/agentSources.ts'
import {
  CLIENT_DISPATCH_AGENTS,
  CLIENT_DISPATCH_DOCK_KEYS,
  CLIENT_DISPATCH_NEVER,
  classifyFailure,
  claimedSessionIds,
  clientDispatchSource,
  createDispatchMatcher,
  dispatchAfterMatch,
  dispatchBadgeText,
  humanizeFailure,
  matchNewSession,
  pendingDispatchTasks,
  submitForSource,
} from '../src/server/dispatchClient.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { SendToClientInput } from '../src/server/dispatchSend.ts'
import { SEND_RECEIPT_UNSURE, windowUnconfirmedWhy, windowUnverifiableWhy } from '../src/server/engine/adapters/window.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { TaskClientDispatch } from '../src/protocol.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const AT = '2026-09-21T10:00:00.000Z'
/** 人话里这一家叫什么(`windowUnconfirmedWhy` 那两句里要用)。 */
const CLAUDE_NAME = 'Claude'

function sentDispatch(over: Partial<TaskClientDispatch> = {}): TaskClientDispatch {
  return { hand: 'window', family: 'claude', status: 'sent', at: AT, text: '看看这个', ...over }
}

interface HarnessOptions {
  send?: Record<string, unknown>
  throws?: string
  running?: { ok: boolean, reason?: string }
  front?: { ok: boolean, reason?: string }
  sessions?: readonly string[]
  connected?: boolean
  /**
   * 卡 WR(2026-09-28):`read_reply` 找不找得到那个记号(= 那句话在对话区里露面了没有)。
   * `'after_send'` = **送之前没有、送完才有**(2026-10-02 起适配器先读一眼当底子,再读一眼比),
   * 那才是「亲眼看见送进去了」。
   */
  replyFound?: boolean | 'after_send'
  /** 旧壳不认 `read_reply` 这个 op(直接报错)→ 核不了,如实说核不了。 */
  readFails?: boolean
}

function harness(options: HarnessOptions = {}) {
  /** 送进去了没有(`replyFound:'after_send'` 那一档靠它分「送前」「送后」)。 */
  let sentOk = false
  const h = engineHarness({
    connected: () => options.connected ?? true,
    nameOf: () => CLAUDE_NAME,
    reply: (req) => {
      if (options.throws !== undefined) throw new Error(options.throws)
      // 「送之前 / 送完各核一眼」那两下(卡 AW 第二档):只有这一条按 replyFound 回。
      if (req.op === 'read_reply') {
        if (options.readFails === true) throw new Error('这个假壳不认 read_reply')
        const found = options.replyFound === 'after_send' ? sentOk : (options.replyFound ?? false)
        return { ok: true, result: { found, texts: [] } }
      }
      if (req.op === 'send_text') {
        const out = options.send ?? { ok: true, result: { method: 'ax_value' } }
        if ((out as { ok?: boolean }).ok !== false) sentOk = true
        return out
      }
      return { ok: true, result: {} }
    },
    ensureRunning: () => Promise.resolve(options.running ?? { ok: true }),
    bringToFront: () => Promise.resolve(options.front ?? { ok: true }),
    now: () => new Date(AT),
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    sessionIdsOf: () => options.sessions ?? [],
    now: () => new Date(AT),
  })
  return { requests: h.requests as readonly HelperRequest[], dispatch }
}

function send(input: Partial<SendToClientInput> = {}, options: HarnessOptions = {}) {
  const h = harness(options)
  return h.dispatch.send({ family: 'claude', text: '看看这个', ...input }).then(result => ({ ...h, result }))
}

describe('白名单:只有 Agent 客户端,IM 永远不在里面', () => {
  /*
   * ★ 2026-10-02:写死那张 `CLIENT_DISPATCH_BUNDLES` 删了 —— **家 → 包只问家族目录一处**
   * (`agentSources.bindingFor`)。这几条还是那六家、还是那几个真机读出来的包标识,
   * 只是出处换成了唯一的那一份,不再有第二张表可以漂。
   */
  it('六家 Agent 客户端各有 bundle id(2026-09-24 多了 Muse / Manus,本机 Info.plist 读出来的)', () => {
    const bundleOf = (family: string): string | undefined => bindingFor(family)?.bundle_id
    expect(Object.fromEntries(['claude', 'codex', 'kimi', 'doubao', 'muse', 'manus'].map(one => [one, bundleOf(one)]))).toEqual({
      claude: 'com.anthropic.claudefordesktop',
      codex: 'com.openai.codex',
      kimi: 'com.moonshot.kimichat',
      doubao: 'com.bot.pc.doubao',
      muse: 'com.meta.endo',
      manus: 'im.manus.desktop',
    })
  })

  it('★微信 / 企业微信一个都不在白名单里', () => {
    // 一家名下的**每一个**包都算(卡 CF / DP:豆包那一家有三个),不然漏一个就是一条后门。
    const allowed = FAMILY_SOURCES.flatMap(one => packagesOf(one).map(pkg => pkg.bundle_id))
    for (const banned of CLIENT_DISPATCH_NEVER) expect(allowed).not.toContain(banned)
  })

  it('★不认识的家当场拒,一次 helper 请求都不发', async () => {
    const { result, requests } = await send({ family: 'wechat' })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('not_allowed')
    expect(requests).toHaveLength(0)
  })

  it('空话不送(连窗口都不激活)', async () => {
    const { result, requests } = await send({ text: '   ' })
    expect(result.ok).toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('★codex 与 ChatGPT 是同一个 app,拉起它的命令与 APP_COMMANDS 逐字相同', () => {
    expect(openCommandFor('codex')).toEqual(APP_COMMANDS.codex)
    expect(openCommandFor('claude')).toEqual(APP_COMMANDS.claude)
    expect(openCommandFor('kimi')).toEqual(APP_COMMANDS.kimi)
    /**
     * ★ 2026-09-27(卡 HC):豆包办公**现在也在基础键里**。原来 `APP_COMMANDS` 只有
     * claude / codex / kimi 三家 AI,于是全新 Air 上装着的豆包办公在窗口槽、常用应用、
     * 派活对象里一处都认不出来(维护者:「豆包办公还认不出来呢」)。
     * 两张表现在是同一份 —— AI 那几行由 `FAMILY_SOURCES` 长出来,所以必然逐字相同。
     */
    expect(openCommandFor('doubao')).toEqual(APP_COMMANDS.doubao)
    expect(APP_COMMANDS.doubao).toEqual(openCommandFor('doubao'))
    expect(APP_COMMANDS.muse).toEqual(openCommandFor('muse'))
    expect(APP_COMMANDS.manus).toEqual(openCommandFor('manus'))
    // 卡 Z(2026-09-25):写死的命令表删了 —— 运行时新接上的一家按包标识拉,不改代码也拉得起来。
    expect(openCommandFor('com.example.fooai')).toEqual(['open', '-b', 'com.example.fooai'])
  })
})

describe('送话那条链:每一步断了都说得出是哪一步', () => {
  /*
   * ★ 2026-10-02 这一条的**措辞与归类都变了**,不是行为退步,但得写明白:
   * 壳没连上 → 窗口那条通道 `capabilities().send` 当场是 false → 登记处一条通道都排不进队,
   * 于是引擎回的是「没有一条能办这件事的通道」(`engineNoChannelSay`)。
   * 那句话里没有「工作台 App 未运行 / 断开」这几个判据字,所以 `classifyFailure` 归 `other`。
   * **「不假装送得出去」这一条没动**:ok:false、一个 op 都不发。
   */
  it('壳没接上就别假装送得出去 —— 而且话里说得清是「壳没连上」,不是「这台没装它」', async () => {
    const { result, requests } = await send({}, { connected: false })
    expect(result.ok).toBe(false)
    expect(result.reason ?? '').toContain('没有一条能')
    /*
     * ★ **「壳没连上」与「这台没装它」要分得开**(D13:查不到不许冒充没有):
     * 下一步做的事完全不同(一个去开工作台 App,一个去装那一家)。这一句由窗口那条通道自己报
     * (契约的 `Adapter.unavailable`),引擎接进 `why`,`classifyFailure` 归到 `helper_down` ——
     * 收件箱那一句「工作台的窗口编排壳没接上」靠的就是这一档。
     */
    expect(result.reason ?? '').toContain('工作台 App 没连上')
    expect(result.kind).toBe('helper_down')
    expect(requests).toHaveLength(0)
  })

  it('那家没在跑、也拉不起来 → 找不到窗口', async () => {
    const { result } = await send({}, { running: { ok: false, reason: '激活失败:com.anthropic.claudefordesktop 未在运行(已重试 3 轮)' } })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('no_window')
    expect(result.reason).toContain('未在运行')
  })

  /*
   * ★ 2026-10-02:「叫不到台前」**不再往回包里带一句** —— 叫台前那一下在窗口适配器里,
   * 而契约里 `JobResult` 没有 `front` 那一格(`windowWake.frontTraceText` 跟着删了)。
   * 守住的那一条还在、而且是这一条的全部意思:**叫不到台前不算失败,照样送**
   * (壳那条 `send_text` 自己会激活那扇窗)。
   */
  it('★叫不到台前不算失败,照样送进去', async () => {
    const { result, requests } = await send({}, { front: { ok: false, reason: '未认领:先把窗口拖进窗位' } })
    expect(result.ok).toBe(true)
    expect(requests.some(one => one.op === 'send_text')).toBe(true)
  })

  it('壳说没送成 → 原样把那句原因带回来,并且记一条 failed 在卡上', async () => {
    const { result } = await send({}, { send: { ok: false, error: '输入框没找到:com.anthropic.claudefordesktop —— 这扇窗的 AX 树里没有任何文本输入元素' } })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('no_input')
    expect(result.dispatch?.status).toBe('failed')
    expect(result.dispatch?.reason).toContain('输入框没找到')
    // ★没送成也要把原话留在卡上:用户要能看见我们以他的名义想说什么。
    expect(result.dispatch?.text).toBe('看看这个')
  })

  /*
   * ★ 2026-10-13(卡 N)这一条的归类**故意改了**:从前「壳超时 / 断开」与「壳没连上」同归
   * `helper_down`,而它们的事实正相反 —— 没连上是**一个 op 都没发出去**,超时 / 断开是
   * **op 发出去了、我们不知道它做没做到**(17:42 真机:豆包窗口里那句明明进去了)。
   * 所以多一类 `helper_timeout`:送话那一层据此先只读地再核一眼那扇窗,核不上才如实说没派,
   * 而那句话是人话 —— 「壳」「超时」这种内部口径只留在分号后面(卡上看得见、嘴上不念)。
   */
  it('★壳超时 / 断开:核不上就如实说没派,话是人话、原因留在后半句', async () => {
    const { result } = await send({}, { throws: '工作台 App 断开' })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('helper_timeout')
    const spoken = ((result.reason ?? '').split(';')[0] ?? '').replace('窗口:', '')
    expect(spoken).toBe(humanizeFailure('工作台 App 断开', 'claude'))
    expect(spoken).not.toContain('工作台 App 断开')
    expect(result.reason).toContain('工作台 App 断开')
    expect(result.dispatch?.status).toBe('failed')
  })

  /*
   * ★ 2026-10-02:**`method` 这一格不再记在卡上** —— 壳走的是打属性还是粘贴,契约里
   * `JobResult` 没有这一格(协议型那两条通道压根没有「方法」这回事)。
   * 「记原话、记基线」照旧;真送进去的那个包改记在 `bundle_id` 上(2026-09-30 止血,根子 1)。
   */
  it('送成了:记原话、记基线、记真送进去那个包', async () => {
    const { result, requests } = await send(
      { submit: true },
      { sessions: ['old-1', 'old-2'], send: { ok: true, result: { method: 'paste', submitted: true } }, replyFound: 'after_send' },
    )
    expect(result.ok).toBe(true)
    expect(result.dispatch?.status).toBe('sent')
    expect(result.dispatch?.text).toBe('看看这个')
    expect(result.dispatch?.baseline).toEqual(['old-1', 'old-2'])
    expect(result.dispatch?.bundle_id).toBe('com.anthropic.claudefordesktop')
    const req = requests.find(r => r.op === 'send_text')
    expect(req).toMatchObject({ op: 'send_text', bundle_id: 'com.anthropic.claudefordesktop', text: '看看这个' })
  })

  /**
   * ★ **「只写进框、不发出去」照旧走得通**(2026-09-22 Ben 定的 A2:「事务官主动派的替按回车,
   * 用户手点的不按」)。2026-10-02 接引擎时这一格顺着契约加上了(`Job.submit`),壳那条
   * `send_text` 的字段一个没动 —— 所以这一条行为与接手之前一字不差。
   *
   * 口径只有一处变了:**没有任何证据可核**(一个字都没发出去),所以结局是「未确证」+ 一句实话;
   * 卡上照旧记 `sent`(字送进去了,这就是她要的)。
   */
  it('★`submit:false`:壳那条 send_text 带 submit:false,如实说没替她按发送', async () => {
    const { result, requests } = await send({ submit: false })
    expect(result.ok).toBe(true)
    expect(requests.find(r => r.op === 'send_text')).toMatchObject({ submit: false })
    expect(result.dispatch?.status).toBe('sent')
    expect(result.dispatch?.submitted).toBe(false)
    expect(String(result.confirm_note)).toContain('没替你按发送')
  })

  it('★明着要发送:壳那条 `send_text` 带 submit:true,回执确认了就记 submitted', async () => {
    const asked = await send({ submit: true }, { send: { ok: true, result: { method: 'ax_value', submitted: true } } })
    expect(asked.requests.find(r => r.op === 'send_text')).toMatchObject({ submit: true })
    expect(asked.result.dispatch?.submitted).toBe(true)
  })

  /** A2(2026-09-22 Ben 定):替不替他按回车**看来源**,规矩是一个纯函数。 */
  it('★来源 → 按不按回车:事务官主动派的按,界面手点的不按', () => {
    expect(submitForSource('item')).toBe(true)
    expect(submitForSource('call')).toBe(true)
    expect(submitForSource('inbox')).toBe(true)
    expect(submitForSource('hub')).toBe(true)
    expect(submitForSource('ui')).toBe(false)
    // 没来源 = 老调用方 = 照旧不按(送错一句话是撤不回来的,缺省要站在"不按"那一边)。
    expect(submitForSource(undefined)).toBe(false)
    expect(clientDispatchSource('item')).toBe('item')
    expect(clientDispatchSource('随便')).toBeUndefined()
    expect(clientDispatchSource(undefined)).toBeUndefined()
  })

  it('★没要求发送时,卡上不写 submitted —— 不留一个"看起来发过了"的字段', async () => {
    const { result } = await send()
    expect(result.dispatch).not.toHaveProperty('submitted')
  })

  /**
   * ───────── 卡 WR(2026-09-28,统筹真机 10:07)—— 状态不许撒谎 ─────────
   *
   * 那一次 Manus 记的是 `{status:'sent', submitted:false}`、事项还进了「在办」,
   * 而统筹截屏看到那段字**停在他的输入框里**。
   */
  /*
   * ★ 2026-10-02:`typed` 的判据改成**壳那条回执(`JobResult.submitted`)或者在对话区里亲眼看见了
   * (`delivered:'confirmed'`)**,两样都没有才是「字进了框、没发出去」—— 与从前逐字同义。
   * 卡上那句话照旧是**「回执尚未确认、不要重复发送」**那一句(`SEND_RECEIPT_UNSURE`,现在只有
   * 窗口适配器一份):要紧的是叫她**别重发** —— 它多半已经收到了(2026-09-28 Air 维护包)。
   */
  it('★要我们按发送、可它没发出去 → 记 typed,不记 sent,并且叫她别重发', async () => {
    const { result } = await send({ submit: true }, { send: { ok: true, result: { method: 'ax_value', submitted: false } } })
    expect(result.ok).toBe(true)
    expect(result.dispatch?.status).toBe('typed')
    expect(result.dispatch?.submitted).toBe(false)
    expect(result.dispatch?.reason).toBe(SEND_RECEIPT_UNSURE)
    expect(String(result.dispatch?.reason)).toContain('不要重复发送')
    // **一个字都不说成送到了**(这一条是硬的)。
    expect(result.dispatch?.seen_at).toBeUndefined()
  })

  /**
   * 第二道(**软**的):按了发送还要在它对话区里露过面。看不见**不改状态** ——
   * 前端画出来要一拍,现成那条「读回答」的巡检本来就在按同一个记号等它;
   * 这里三次 700ms 看不见就当「没发出去」,会把一堆真发出去的活拦在「卡住了」。
   * 所以只留一句要告诉他的话。
   */
  it('★按了发送、可这会儿还没在对话区里看见那句话 → 状态照旧 sent,但留一句话告诉他', async () => {
    const h = harness({ send: { ok: true, result: { method: 'ax_value', submitted: true } } })
    const result = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
    expect(result.dispatch?.status).toBe('sent')
    // 那一句由适配器出(一处写),断言读那个导出的函数 —— 不逐字抄中文。
    expect(result.confirm_note).toBe(windowUnconfirmedWhy(CLAUDE_NAME))
  })

  /*
   * ★ 2026-10-02:「看见了」的判法是**送之前后各读一眼比一比**(卡 AW 第二档):
   * 送前对话区里没这句、送完有了 —— 那才是亲眼看见送进去了(`delivered:'confirmed'`)。
   * 从前只在送完读一眼,送之前框里本来就有同一句时会把旧的那一条认成新送进去的。
   */
  it('★按了发送、对话区里也看见了(送前没有、送完有了)→ 一句多余的话都不说', async () => {
    const h = harness({ send: { ok: true, result: { method: 'ax_value', submitted: true } }, replyFound: 'after_send' })
    const result = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
    expect(result.dispatch?.status).toBe('sent')
    expect(result.dispatch?.seen_at).toBe(AT)
    expect(result).not.toHaveProperty('confirm_note')
  })

  /*
   * ★ 2026-10-02:送话这一条**不再先问壳「你会不会 read_reply」** —— 核那一眼直接发出去,
   * 旧壳不认这个 op 就报错,这边照旧**不假装核过**:状态按回执算,话里说的是「没能核实」
   * (与「看了、没看见」那一句分得开,见 `windowUnconfirmedWhy` / `windowUnverifiableWhy`)。
   */
  it('★旧壳读不回那一眼 → 不假装核过,如实说没能核实', async () => {
    const h = harness({ send: { ok: true, result: { method: 'ax_value', submitted: true } }, readFails: true })
    const result = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
    expect(result.dispatch?.status).toBe('sent')
    expect(result.dispatch?.seen_at).toBeUndefined()
    expect(result.confirm_note).toBe(windowUnverifiableWhy(CLAUDE_NAME))
  })

  it('★卡上那一句:写进框里了没发出去,不许说成「已发出」', () => {
    expect(dispatchBadgeText(sentDispatch({ status: 'typed' }))).toBe('派给 Claude(窗口)· 字写进框里了,没发出去')
  })

  it('基线在送之前取:送完再取会把刚开的那条会话算进基线', async () => {
    const h = engineHarness({ now: () => new Date(AT) })
    const result = await createClientDispatch({
      engine: h.engine,
      // 壳一个 op 都还没收到 = 还没送 → 那一刻的基线只有「before」。
      sessionIdsOf: () => (h.requests.length === 0 ? ['before'] : ['before', 'after']),
      now: () => new Date(AT),
    }).send({ family: 'kimi', text: '嗨,帮我看一眼', submit: true })
    expect(result.dispatch?.baseline).toEqual(['before'])
  })
})

describe('失败归因', () => {
  it('每一类都认得出来', () => {
    expect(classifyFailure('不许往这个应用送话:com.tencent.xinWeChat(白名单只有 Agent 客户端)')).toBe('not_allowed')
    expect(classifyFailure('辅助功能通道关着:x 回 -25211')).toBe('ax_disabled')
    expect(classifyFailure('输入框没找到:x —— 树里没有')).toBe('no_input')
    expect(classifyFailure('送进去了但读回来对不上:x 框里现在是「半截」')).toBe('not_typed')
    expect(classifyFailure('找不到窗口:x 没在运行')).toBe('no_window')
    expect(classifyFailure('工作台 App 未运行')).toBe('helper_down')
  })

  it('★归不出类就归 other,原话照样带走(不为了分类好看而猜)', () => {
    expect(classifyFailure('这是一句谁也没见过的错误')).toBe('other')
  })
})

describe('会话怎么认', () => {
  const sentAt = new Date(AT)
  const now = new Date('2026-09-21T10:01:00.000Z')

  it('差集恰好一条就是它', () => {
    expect(matchNewSession({ baseline: ['a'], current: ['a', 'b'], sentAt, now }))
      .toEqual({ kind: 'matched', session_id: 'b' })
  })

  it('★同时冒出两条:一条都不认', () => {
    const match = matchNewSession({ baseline: ['a'], current: ['a', 'b', 'c'], sentAt, now })
    expect(match.kind).toBe('ambiguous')
    expect(match.kind === 'ambiguous' && match.note).toContain('认不准')
  })

  it('还没冒出来就继续等', () => {
    expect(matchNewSession({ baseline: ['a'], current: ['a'], sentAt, now })).toEqual({ kind: 'waiting' })
  })

  it('★等过了窗口期就放弃,并说清多半是那段话还在框里等他按回车', () => {
    const late = new Date('2026-09-21T11:00:00.000Z')
    const match = matchNewSession({ baseline: [], current: [], sentAt, now: late })
    expect(match.kind).toBe('timeout')
    expect(match.kind === 'timeout' && match.note).toContain('按回车')
  })

  it('★被别的事项认走的会话不参与(两件事不抢同一条)', () => {
    expect(matchNewSession({ baseline: ['a'], current: ['a', 'b'], claimed: ['b'], sentAt, now }))
      .toEqual({ kind: 'waiting' })
  })

  it('哨兵会话不算数', () => {
    expect(matchNewSession({ baseline: [], current: ['sentinel:probe'], sentAt, now })).toEqual({ kind: 'waiting' })
  })

  it('★豆包没有会话流:一次就放弃,不留一张永远在等的卡', () => {
    const next = dispatchAfterMatch(sentDispatch({ family: 'doubao' }), [], [], now)
    expect(next?.match_note).toContain('没有会话流')
    expect(CLIENT_DISPATCH_AGENTS.doubao).toBeUndefined()
    expect(CLIENT_DISPATCH_DOCK_KEYS.doubao).toBeUndefined()
  })

  it('认上了就把 session_id 与时刻写回去', () => {
    const next = dispatchAfterMatch(sentDispatch({ baseline: ['a'] }), ['a', 'b'], [], now)
    expect(next).toMatchObject({ session_id: 'b', matched_at: now.toISOString() })
  })

  it('还在等的时候什么都不写', () => {
    expect(dispatchAfterMatch(sentDispatch({ baseline: ['a'] }), ['a'], [], now)).toBeUndefined()
  })
})

describe('哪几张卡还在等会话', () => {
  it('只有"送成了、还没认上、还没放弃"那几张', () => {
    const tasks = [
      { id: '1', client_dispatch: sentDispatch() },
      { id: '2' },
      { id: '3', client_dispatch: sentDispatch({ status: 'failed', reason: '没送成' }) },
      { id: '4', client_dispatch: sentDispatch({ session_id: 'x' }) },
      { id: '5', client_dispatch: sentDispatch({ match_note: '认不准' }) },
      // ★ 2026-09-24(卡 F):工作台自己盯着读回答的那几条归 dispatchRun 管,这里不碰(不然会拿旧快照盖掉刚收回来的回答)。
      { id: '6', client_dispatch: sentDispatch({ reply_state: 'waiting', marker: '工作台派活 000006' }) },
    ]
    expect(pendingDispatchTasks(tasks).map(t => t.id)).toEqual(['1'])
  })

  it('已经被认走的:别的卡的 session_id 与卡上的关联窗口都算', () => {
    const claimed = claimedSessionIds([
      { client_dispatch: sentDispatch({ session_id: 'a' }) },
      { links: [{ session_id: 'b' }] },
      {},
    ])
    expect(claimed.sort()).toEqual(['a', 'b'])
  })
})

describe('对账那层薄接线', () => {
  function matcher(now: () => Date, updates: { id: string, dispatch: TaskClientDispatch }[]) {
    return createDispatchMatcher({
      update: (id, dispatch) => { updates.push({ id, dispatch }); return Promise.resolve(true) },
      now,
    })
  }

  it('认上就写回卡上', async () => {
    const updates: { id: string, dispatch: TaskClientDispatch }[] = []
    const m = matcher(() => new Date('2026-09-21T10:01:00.000Z'), updates)
    const changed = await m.reconcile(
      [{ id: 'card-1', client_dispatch: sentDispatch({ baseline: ['old'] }) }],
      [{ agent: 'claude', session_id: 'old' }, { agent: 'claude', session_id: 'new' }],
    )
    expect(changed).toBe(1)
    expect(updates[0]?.dispatch.session_id).toBe('new')
  })

  it('★别家的会话不算数(送给 Claude 的活不认 Kimi 那条新会话)', async () => {
    const updates: { id: string, dispatch: TaskClientDispatch }[] = []
    const m = matcher(() => new Date('2026-09-21T10:01:00.000Z'), updates)
    await m.reconcile(
      [{ id: 'card-1', client_dispatch: sentDispatch({ baseline: [] }) }],
      [{ agent: 'kimi', session_id: 'kimi-new' }],
    )
    expect(updates).toHaveLength(0)
  })

  it('★没有卡在等的时候一次都不做事(限频也不该被空转磨掉)', async () => {
    const updates: { id: string, dispatch: TaskClientDispatch }[] = []
    const m = matcher(() => new Date(AT), updates)
    expect(await m.reconcile([{ id: 'x' }], [])).toBe(0)
  })

  it('★10 秒内最多认一次', async () => {
    const updates: { id: string, dispatch: TaskClientDispatch }[] = []
    let t = Date.parse('2026-09-21T10:01:00.000Z')
    const m = matcher(() => new Date(t), updates)
    const tasks = [{ id: 'card-1', client_dispatch: sentDispatch({ baseline: [] }) }]
    await m.reconcile(tasks, [{ agent: 'claude', session_id: 'new' }])
    t += 1_000
    await m.reconcile(tasks, [{ agent: 'claude', session_id: 'new' }])
    expect(updates).toHaveLength(1)
    t += 20_000
    await m.reconcile(tasks, [{ agent: 'claude', session_id: 'new' }])
    expect(updates).toHaveLength(2)
  })

  it('★写卡失败不往外抛(认会话不该把 /state 带塌)', async () => {
    const m = createDispatchMatcher({
      update: () => Promise.reject(new Error('盘满了')),
      now: () => new Date('2026-09-21T10:01:00.000Z'),
    })
    await expect(m.reconcile(
      [{ id: 'card-1', client_dispatch: sentDispatch({ baseline: [] }) }],
      [{ agent: 'claude', session_id: 'new' }],
    )).resolves.toBe(0)
  })
})

describe('卡面那句话', () => {
  it('三档各一句', () => {
    expect(dispatchBadgeText(sentDispatch())).toBe('派给 Claude(窗口)· 已送出')
    expect(dispatchBadgeText(sentDispatch({ submitted: true }))).toBe('派给 Claude(窗口)· 已送出并发送')
    expect(dispatchBadgeText(sentDispatch({ status: 'failed' }))).toBe('派给 Claude(窗口)· 没送成')
    expect(dispatchBadgeText(sentDispatch({ family: 'doubao' }))).toBe('派给 豆包办公(窗口)· 已送出')
  })

  it('2026-09-24(卡 F):工作台自己盯着读回答的那几条多三档;老记录没有 reply_state,一字不变', () => {
    expect(dispatchBadgeText(sentDispatch({ family: 'muse', submitted: true, reply_state: 'waiting' }))).toBe('派给 Muse(窗口)· 已发出,等它回答')
    expect(dispatchBadgeText(sentDispatch({ family: 'manus', submitted: true, reply_state: 'done' }))).toBe('派给 Manus(窗口)· 回来了')
    expect(dispatchBadgeText(sentDispatch({ family: 'kimi', submitted: true, reply_state: 'unreadable' }))).toBe('派给 Kimi(窗口)· 已发出,结果在 Kimi 里')
  })
})

describe('★协议那条路自己报的那条线程号(2026-10-02 真机那一跑查出来的)', () => {
  /*
   * 真机:`POST /butler/item {text:'让 Codex 用一句话回答:一周有几天'}` → `thread/start` 开了一条
   * `01a0fdc2-…`、10 秒后 Codex 就答完了「一周有七天。」,而卡上一直是「等它回」—— 因为
   * `JobResult.sessionId`(对端自己报的那条线程号)在这一层被丢掉了:四秒一拍的盯窗于是拿
   * `target:{kind:'current'}` 去问协议,而协议**认不出她此刻开着哪一条**(`codex.say` 那一句),
   * 那句回答永远收不回来。记上它之后同一条真机链路 12 秒把「一周有七天。」收回了卡上。
   */
  /** 一条只会「送话」的假协议通道:回执 + 它自己报的那条线程号。 */
  function protocolChannel(family: string, sessionId: string | undefined) {
    return {
      family,
      via: 'protocol' as const,
      capabilities: async () => ({
        open: true, send: true, read: true, press: false, approve: false, writeAsk: false, stop: true, openSession: true,
      }),
      run: async () => ({
        delivered: 'confirmed' as const,
        via: 'protocol' as const,
        evidence: 'receipt' as const,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    }
  }

  it('报了线程号 → 卡上 session_id / matched_at 当场记上(盯窗不必再猜是哪一段)', async () => {
    const h = engineHarness({ installed: () => [{ bundle_id: 'com.openai.codex' }], now: () => new Date(AT) })
    h.registry.register(protocolChannel('codex', 'thread-7'))
    const dispatch = createClientDispatch({ engine: h.engine, sessionIdsOf: () => [], now: () => new Date(AT) })
    const out = await dispatch.send({ family: 'codex', text: '一周有几天', newConversation: true, submit: true })
    expect(out.ok).toBe(true)
    expect(out.dispatch?.session_id).toBe('thread-7')
    expect(out.dispatch?.matched_at).toBe(AT)
  })

  it('没报线程号(窗口那条路就是这样)→ 这两格缺席,照旧交给盯窗去认', async () => {
    const h = engineHarness({ installed: () => [{ bundle_id: 'com.openai.codex' }], now: () => new Date(AT) })
    h.registry.register(protocolChannel('codex', undefined))
    const dispatch = createClientDispatch({ engine: h.engine, sessionIdsOf: () => [], now: () => new Date(AT) })
    const out = await dispatch.send({ family: 'codex', text: '一周有几天', newConversation: true, submit: true })
    expect(out.ok).toBe(true)
    expect(out.dispatch?.session_id).toBeUndefined()
    expect(out.dispatch?.matched_at).toBeUndefined()
  })
})

describe('★替她按掉了挡着输入框的那层框 → 一定说一句(卡 DP;审计第二表 5)', () => {
  /*
   * 这一句从前只有派活这一处说(`dispatchClient.sendOnce` 读 `modal_closed`),答 / 捎话压根不读那一格。
   * 收成一份之后由 `JobResult.modalClosed` 带上来 —— 答那一侧的用例在 `session-answer.test.ts`,
   * 这一条钉派活这一侧:**替她按了键就不许做完不说**。
   */
  it('壳报了 modal_closed → front_note / confirm_note 里都带着那句话', async () => {
    const { result } = await send({ submit: true }, {
      send: { ok: true, result: { method: 'ax_value', submitted: true, modal_closed: '替你把挡着输入框的那层框关掉了' } },
      replyFound: 'after_send',
    })
    expect(result.ok).toBe(true)
    expect(result.front_note).toContain('替你把挡着输入框的那层框关掉了')
    expect(result.confirm_note).toContain('替你把挡着输入框的那层框关掉了')
  })

  it('壳一个字都没报 → 不编一句(两格都缺席)', async () => {
    const { result } = await send({ submit: true }, {
      send: { ok: true, result: { method: 'ax_value', submitted: true } },
      replyFound: 'after_send',
    })
    expect(result.ok).toBe(true)
    expect(result.front_note).toBeUndefined()
    expect(result.confirm_note).toBeUndefined()
  })
})
