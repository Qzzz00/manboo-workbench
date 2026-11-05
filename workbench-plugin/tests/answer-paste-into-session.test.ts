// @vitest-environment node
/**
 * **把她的文字复制过去、发送 —— 认不出记号也照送,送完回记录文件里核**(2026-10-01,卡 AW)。
 *
 * 现场:维护者 16:06 手机上两条 Claude 桌面会话都在「等你确认」,两次都回
 * 「这一问得在电脑上的 Claude 里回答(没在它的窗口里找到那段对话,没敢替你打字)」。
 * 原话:「怎么又说不敢替我打字了,我都说了这是复制黏贴和发送了」。
 * 他机器上的日志里**每一次**都是这一句 —— 那道「辅助功能树里认出那一问才打字」的闸门从没放行过。
 *
 * 守:
 * ① 记号一次都认不出、而这条会话有本机记录文件 → **深链先开到那一段,再照送**;
 * ② 送完到那条会话的记录文件里核:多出一句对得上的「她说的」→ `confirmed:true`;
 * ③ 核不上 → 照样 `ok:true`,但 `confirmed:false` + 那句人话(**不说成答上了,也不当没送**);
 * ④ 窗口型那几家(没有记录文件)**一点没变**:认不出那段对话照旧一个字不打;
 * ⑤ 微信 / 企业微信照旧永不送;
 * ⑥ 按内容判出来的批准类(`by:'rules'`)走的就是这条打字的路,手机卡片上不再先摆一句「得去电脑上回答」。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):三档证据收进**一条引擎** ——
 * ①②(认在前台了 / 读窗前后比)在 `engine/adapters/window.ts`,③(那条会话的记录文件)是引擎的
 * `transcript` 那一格(`sessionSaid.createTranscriptEvidence`)。所以这一份改成「假壳 + 真引擎」端到端跑:
 * 从前那只假手挡在中间,壳那一侧的事实(回执不可靠)测不到。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { SessionView } from '../src/protocol.ts'
import { windowUnconfirmedWhy } from '../src/server/engine/adapters/window.ts'
import { countSaid, createTranscriptEvidence, normalizeSaid } from '../src/server/sessionSaid.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness, type EngineHarnessOptions, type FakeHelperReply } from './helpers/engineHarness.ts'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const line = (row: unknown) => `${JSON.stringify(row)}\n`

/** 她在等答的那条 Claude 桌面会话(「应用标签点击响应缓慢」那一条的形状)。 */
const asking: SessionView = {
  agent: 'claude',
  session_id: 'd999',
  project: 'desktop-workbench',
  status: 'waiting',
  elapsed_sec: 120,
  unread: false,
  updated_at: '2026-10-01T16:00:00.000Z',
  title: '应用标签点击响应缓慢',
  ask: {
    kind: 'approve',
    question: '要我开一张卡做这两处吗?',
    since: '2026-10-01T16:00:00.000Z',
    quote: '要我开一张卡做这两处吗?',
    by: 'rules',
  },
}

/** 只会说「没找到」的那份壳:`read_reply` 永远 found:false(真机上就是这样)。 */
function blindShell(onSend?: () => void): FakeHelperReply {
  return (req: HelperRequest) => {
    if (req.op === 'read_reply') return { found: false, busy: false, texts: [] }
    if (req.op === 'send_text') { onSend?.(); return { submitted: true, method: 'ax' } }
    return {}
  }
}

/** 一条真的 Claude 会话记录文件(jsonl),外加「她又说了一句」这个动作。 */
function transcript() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-answer-paste-'))
  dirs.push(dir)
  const file = join(dir, 'd999.jsonl')
  writeFileSync(file, [
    line({ type: 'user', sessionId: 'd999', cwd: '/w', entrypoint: 'claude-desktop', timestamp: '2026-10-01T15:50:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: '标签点一下要等两秒' } }),
    line({ type: 'assistant', sessionId: 'd999', entrypoint: 'claude-desktop', timestamp: '2026-10-01T15:59:00.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '查到两处。要我开一张卡做这两处吗?' }] } }),
  ].join(''))
  return {
    file,
    sheAlsoSaid(text: string) {
      appendFileSync(file, line({ type: 'user', sessionId: 'd999', cwd: '/w', entrypoint: 'claude-desktop', timestamp: '2026-10-01T16:06:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: text } }))
    },
  }
}

/** 第三档证据接成引擎那一格(生产里 `index.ts` 接的也是这一个)。 */
const transcriptEvidence = (file: string): NonNullable<EngineHarnessOptions['transcript']> => createTranscriptEvidence({
  locate: async () => ({ agent: 'claude', session_id: 'd999', file, format: 'claude-transcript' as const }),
  why: agent => windowUnconfirmedWhy(sessionAgentName(agent)),
  confirmMs: 30,
  confirmStepMs: 10,
  sleep: async () => {},
})

/**
 * `await rig(...)` 里把每条通道的 `capabilities()` 现查一遍 —— 界面那一格(`replyOf` 摆不摆输入框)
 * 读的是那一份**同步**缓存。钟定住,免得那份缓存在同一条用例里过期变回「还没查过」。
 */
const rig = async (options: { file?: string, onSend?: () => void } = {}) => {
  const opened: string[] = []
  const h = engineHarness({
    reply: blindShell(options.onSend),
    nameOf: sessionAgentName,
    now: () => new Date('2026-10-01T16:06:00.000Z'),
    // 深链要的 `local_…` 是**窗口那一层**问的。
    hostIdOf: () => 'local_d999',
    openUrl: async (url) => { opened.push(url); return { ok: true } },
    ...(options.file === undefined ? {} : { transcript: transcriptEvidence(options.file) }),
  })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => [asking],
    entryOf: () => 'claude-desktop',
    hostIdOf: () => 'local_d999',
    agentName: sessionAgentName,
  })
  await h.registry.targets()
  return { service, requests: h.requests, opened }
}

describe('认不出记号也照送(有记录文件的那几家)', () => {
  it('★壳一次都认不出那一问 → 深链先把那一段开到前面,再把她那句原样发出去;记录文件里核上了 → 答上了', async () => {
    const t = transcript()
    const rigged = await rig({ file: t.file, onSend: () => { t.sheAlsoSaid('开吧,这两处一起做') } })
    /*
     * ★ 2026-10-02:`front` 那一格没了 —— 「这一次怎么开到前台的、开了几回窗」是窗口那一层里面的事
     * (进任务日志、由闸数),引擎的 `JobResult` 不带它,回包里也就不再有。
     */
    expect(await rigged.service.answer('claude', 'd999', '开吧,这两处一起做'))
      .toEqual({ ok: true, route: 'window', confirmed: true })
    // 先开深链(把那一段开到前面),再 send_text —— 顺序不能反
    expect(rigged.opened).toEqual(['claude://code/continue?session=local_d999'])
    const ops = rigged.requests.map(one => one.op)
    expect(ops).toContain('send_text')
    expect(ops.indexOf('read_reply')).toBeLessThan(ops.indexOf('send_text'))
    expect(rigged.requests.find(one => one.op === 'send_text')).toMatchObject({
      op: 'send_text',
      bundle_id: 'com.anthropic.claudefordesktop',
      text: '开吧,这两处一起做',
      submit: true,
    })
  })

  it('★记录文件里一直没出现她那句 → 照样算送了,但如实说核不上(绝不说成答上了)', async () => {
    const t = transcript()
    const rigged = await rig({ file: t.file })
    const got = await rigged.service.answer('claude', 'd999', '开吧,这两处一起做')
    expect(got).toMatchObject({ ok: true, route: 'window', confirmed: false })
    expect(got.ok ? got.note : undefined).toBe('按了发送,但没在那条对话里看到这句话 —— 可能发到了别的对话,去 Claude 里看一眼')
    // 送还是送了(没有「没敢替你打字」这一说)
    expect(rigged.requests.some(one => one.op === 'send_text')).toBe(true)
  })

  it('★她先前说过同一句话:要**多出一句**才算核上(不拿旧的那句冒充)', async () => {
    const t = transcript()
    t.sheAlsoSaid('开吧,这两处一起做')
    const rigged = await rig({ file: t.file })
    expect(await rigged.service.answer('claude', 'd999', '开吧,这两处一起做')).toMatchObject({ confirmed: false })
    const again = transcript()
    again.sheAlsoSaid('开吧,这两处一起做')
    const second = await rig({ file: again.file, onSend: () => { again.sheAlsoSaid('开吧,这两处一起做') } })
    expect(await second.service.answer('claude', 'd999', '开吧,这两处一起做')).toMatchObject({ confirmed: true })
  })

  it('★「没敢替你打字」这一句不再出现在有记录文件的那条路上', async () => {
    const t = transcript()
    const rigged = await rig({ file: t.file })
    const got = await rigged.service.answer('claude', 'd999', '开吧')
    expect(JSON.stringify(got)).not.toContain('没敢替你打字')
  })

  it('★没接记录文件这一格:照样发,只是核的证据换成读窗口(壳说窗里没有 → 如实说核不上)', async () => {
    const rigged = await rig()
    const got = await rigged.service.answer('claude', 'd999', '开吧,这两处一起做')
    expect(got).toMatchObject({ ok: true, route: 'window', confirmed: false })
    expect(got.ok ? got.note : undefined).toBe('按了发送,但没在那条对话里看到这句话 —— 可能发到了别的对话,去 Claude 里看一眼')
    expect(rigged.requests.some(one => one.op === 'send_text')).toBe(true)
  })
})

describe('照旧不动的那几条', () => {
  /** 窗口型那一家的一条已有对话(`window:<hash>`:没有会话记录文件,证据只能读窗)。 */
  const windowOnly: SessionView = {
    ...asking,
    agent: 'manus' as SessionView['agent'],
    session_id: 'window:825f1900',
    title: '周报',
  }

  /** 窗口型那几家:**不接**第三档证据(它们压根没有记录文件)。 */
  const windowRig = (reply: FakeHelperReply, over: EngineHarnessOptions = {}) => {
    const h = engineHarness({ reply, nameOf: () => 'Manus', ...over })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [windowOnly],
      agentName: () => 'Manus',
      bundleOf: () => 'im.manus.desktop',
    })
    return { ...h, service }
  }

  it('★窗口型那几家(Manus:没有记录文件):窗口里找不到那段对话也照样发,证据换成读窗口', async () => {
    const t = windowRig(blindShell())
    const got = await t.service.answer('manus' as SessionView['agent'], 'window:825f1900', '这两处一起做吧')
    // 发了;壳读窗口说没看见 → 如实说核不上(**不说成答上了**)
    expect(got).toMatchObject({ ok: true, route: 'window', confirmed: false })
    expect(got.ok ? got.note : undefined).toBe('按了发送,但没在那条对话里看到这句话 —— 可能发到了别的对话,去 Manus 里看一眼')
    expect(t.requests.some(one => one.op === 'send_text')).toBe(true)
  })

  it('★窗口型那几家:壳读窗口看见了她那句 → confirmed:true(同一套字段)', async () => {
    let afterSend = false
    const t = windowRig((req) => {
      if (req.op === 'send_text') { afterSend = true; return { submitted: true, method: 'ax' } }
      if (req.op === 'read_reply') {
        // 认那段对话:一直认不出;读她那句:送完才读得到
        const marker = (req as { marker?: string }).marker
        return { found: afterSend && marker === '这两处一起做吧', busy: false, texts: [] }
      }
      return {}
    })
    expect(await t.service.answer('manus' as SessionView['agent'], 'window:825f1900', '这两处一起做吧'))
      .toEqual({ ok: true, route: 'window', confirmed: true })
  })

  it('★微信 / 企业微信:永远不往它窗口里送话', async () => {
    const wechat: SessionView = { ...windowOnly, agent: 'wechat' as SessionView['agent'], session_id: 'window:abc12345', title: '家里群' }
    const h = engineHarness({ reply: blindShell(), nameOf: () => '微信' })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [wechat],
      agentName: () => '微信',
      bundleOf: () => 'com.tencent.xinWeChat',
    })
    expect(await service.answer('wechat' as SessionView['agent'], 'window:abc12345', '好')).toMatchObject({ ok: false, status: 200, where: 'desk' })
    expect(h.requests).toEqual([])
  })
})

describe('按内容判出来的批准类(by:rules)走打字这条路', () => {
  it('★手机卡片上不先摆一句「得去电脑上回答」:reply 是 window、没有 where', async () => {
    const rigged = await rig()
    expect(rigged.service.replyOf(asking, { by: 'rules' })).toEqual({ reply: 'window', reveal: true })
  })

  it('★真答的时候也走打字那只手(不是「去那边点那个框」)', async () => {
    const t = transcript()
    const rigged = await rig({ file: t.file, onSend: () => { t.sheAlsoSaid('开') } })
    expect(await rigged.service.answer('claude', 'd999', '开')).toMatchObject({ ok: true, route: 'window', confirmed: true })
  })

  it('真弹了框那一问(by:form)照旧不往对话里打字', async () => {
    const popup: SessionView = { ...asking, ask: { kind: 'approve', question: '它要跑测试,等你批准', since: '2026-10-01T16:00:00.000Z', by: 'form' } }
    const h = engineHarness({ reply: blindShell(), nameOf: sessionAgentName })
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [popup],
      entryOf: () => 'claude-desktop',
      hostIdOf: () => 'local_d999',
      agentName: sessionAgentName,
    })
    // 权限弹窗那一问:回包说清这是权限弹窗(界面据此切到「批准 / 拒绝」那几颗键),**一个 op 都不发**
    expect(await service.answer('claude', 'd999', '可以')).toMatchObject({ ok: false, status: 200, where: 'desk', permission: true })
    expect(h.requests).toEqual([])
  })
})

describe('认「这两句是同一句」(sessionSaid)', () => {
  it('剥掉行首那个记号、空白收成一个空格;不改字', () => {
    expect(normalizeSaid('【事务官捎话 d9991a】现在到哪了')).toBe('现在到哪了')
    expect(normalizeSaid(' 开吧,\n 这两处一起做 ')).toBe('开吧, 这两处一起做')
  })

  it('前后比个数:同一句说过两遍也数得出多了一句', () => {
    expect(countSaid(['开吧'], '开吧')).toBe(1)
    expect(countSaid(['开吧', '开吧'], '开吧')).toBe(2)
    expect(countSaid(['别的话'], '开吧')).toBe(0)
    expect(countSaid(['开吧'], '   ')).toBe(0)
  })
})
