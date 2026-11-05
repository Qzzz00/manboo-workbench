/**
 * 会话状态说真话(2026-09-25,卡 V)。
 *
 * 撞出来的事(维护者截图,09-25 21:00):事务官舞台上三张 Claude 卡都写「进行中」,实际只有一条在跑。
 * 另外两张是能力体检用 `claude -p` 探的一句,命令行没登录,一条 `authentication_failed` 的记录就结束了 ——
 * 挂了 53 分钟和 18 分钟。窗口槽 Claude 标签上的「3」跟着错。
 *
 * 下面的记录片段**照维护者这台机器上的真文件抄**(`~/.claude/projects/-/*.jsonl`、
 * `~/.codex/sessions/…/rollout-*.jsonl`、`~/.kimi/sessions/…/wire.jsonl`;只抄形状,不存他的原文)。
 */
import { describe, expect, it } from 'vitest'
import { digestClaude, digestCodex, digestKimi } from '../src/server/sessionDigest.ts'
import { judgeSessionOutcome, STALL_MS } from '../src/server/sessionOutcome.ts'
import { looksRunning, markOfTail, selfcheckOfTail } from '../src/server/claudeSessionRecover.ts'
import { SELFCHECK_PREFIX } from '../src/protocol.ts'

const NOW_MS = Date.parse('2026-09-25T13:00:00.000Z')

const line = (row: unknown): string => JSON.stringify(row)

// ───────────────────── Claude:一次性命令行(`claude -p`)报错结束 ─────────────────────

/**
 * 真机原型:`8233a09f-…jsonl`(18 行、cwd `/`、`entrypoint: sdk-ts`)。最后一条可认记录是
 * `assistant` + `isApiErrorMessage: true` + `error: 'authentication_failed'`,正文是那句英文,
 * 而 `stop_reason` 是 **`stop_sequence`** —— 老读法「不是 end_turn 就算在跑」就是在这儿栽的。
 */
const claudeAuthFailed = [
  line({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1' }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'What is 2+2? Reply with just the number.' }] }, cwd: '/', entrypoint: 'sdk-ts', turnOrigin: 'sdk', promptSource: 'sdk', timestamp: '2026-09-25T12:00:05.000Z', sessionId: 's1' }),
  line({ type: 'attachment', attachment: { type: 'nested_memory' }, cwd: '/', sessionId: 's1' }),
  line({ type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, cwd: '/', entrypoint: 'sdk-ts', timestamp: '2026-09-25T12:00:05.571Z', sessionId: 's1' }),
  line({ type: 'last-prompt', lastPrompt: 'What is 2+2? Reply with just the number.', sessionId: 's1' }),
  line({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0 }),
].join('\n')

/** 真机原型:`b7912cba-…jsonl`。同一句探针,这一次通了:`end_turn` + 正文「4」,后面跟着记账记录。 */
const claudeEnded = [
  line({ type: 'ai-title', aiTitle: 'Simple arithmetic', sessionId: 's2' }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'What is 2+2? Reply with just the number.' }] }, cwd: '/', entrypoint: 'sdk-ts', timestamp: '2026-09-25T12:43:00.000Z', sessionId: 's2' }),
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '4' }] }, cwd: '/', timestamp: '2026-09-25T12:43:01.951Z', sessionId: 's2' }),
  line({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, sessionId: 's2' }),
  line({ type: 'last-prompt', lastPrompt: 'What is 2+2? Reply with just the number.', sessionId: 's2' }),
  line({ type: 'cost-state', sessionId: 's2' }),
].join('\n')

/** 它正在干活:最后一条是 `tool_use`(`stop_reason: 'tool_use'`)。 */
const claudeWorking = [
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '把这一处改掉' }] }, cwd: '/Users/example/x', timestamp: '2026-09-25T12:55:00.000Z', sessionId: 's3' }),
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/Users/example/x/a.ts' } }] }, cwd: '/Users/example/x', timestamp: '2026-09-25T12:55:20.000Z', sessionId: 's3' }),
].join('\n')

/** 他刚说完话,它还没开口(78 份真机文件里 10 份就停在这一形)。 */
const claudeAsked = [
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '好了' }] }, cwd: '/Users/example/x', timestamp: '2026-09-25T12:10:00.000Z', sessionId: 's4' }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '再帮我看一处' }] }, cwd: '/Users/example/x', timestamp: '2026-09-25T12:11:00.000Z', sessionId: 's4' }),
].join('\n')

/** 工具结果回来了 —— 那不是他说的话,它还在干活。 */
const claudeToolResult = [
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] }, timestamp: '2026-09-25T12:50:00.000Z', sessionId: 's5' }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, timestamp: '2026-09-25T12:50:30.000Z', sessionId: 's5' }),
].join('\n')

/** 这一轮被长度顶掉了(78 份里见过 1 条 `max_tokens`)。 */
const claudeMaxTokens = [
  line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '把整份日志贴进来分析' }] }, timestamp: '2026-09-25T12:30:00.000Z', sessionId: 's6' }),
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: '我先说前一半' }] }, timestamp: '2026-09-25T12:31:00.000Z', sessionId: 's6' }),
].join('\n')

describe('Claude:最后一条记录停在哪儿(逐种认,不按修改时间猜)', () => {
  it('★一次性命令行没登录 → 报错结束,而不是「进行中」(09-25 那两张假卡的正身)', () => {
    const { mark, failure } = markOfTail(claudeAuthFailed)
    expect(mark).toBe('failed')
    expect(failure).toEqual({ code: 'authentication_failed', raw: 'Not logged in · Please run /login' })
    // 老读法(留给老用例的那个布尔)会说「还在干活」——这一条钉住它错在哪。
    expect(looksRunning(claudeAuthFailed)).toBe(false)
  })

  it('正常结束(end_turn)→ ended;后面那几条记账记录不影响结论', () => {
    expect(markOfTail(claudeEnded).mark).toBe('ended')
  })

  it('在跑(tool_use)→ working;工具结果回来也算 working,不算「他刚说完话」', () => {
    expect(markOfTail(claudeWorking).mark).toBe('working')
    expect(markOfTail(claudeToolResult).mark).toBe('working')
  })

  it('他刚说完话、它还没开口 → asked', () => {
    expect(markOfTail(claudeAsked).mark).toBe('asked')
  })

  it('这一轮被长度顶掉(max_tokens)→ 也算报错结束', () => {
    const { mark, failure } = markOfTail(claudeMaxTokens)
    expect(mark).toBe('failed')
    expect(failure?.code).toBe('max_tokens')
  })

  it('一条可认记录都没有(整段都是记账记录)→ 不下结论', () => {
    const bookkeeping = [
      line({ type: 'attachment', attachment: {}, sessionId: 's7' }),
      line({ type: 'cost-state', sessionId: 's7' }),
      line({ type: 'atis-latch', atis: '', sessionId: 's7' }),
    ].join('\n')
    expect(markOfTail(bookkeeping).mark).toBeUndefined()
  })

  it('digest 读出来的 mark 与只读尾巴的那一份一致(两条路同一个结论)', () => {
    for (const text of [claudeAuthFailed, claudeEnded, claudeWorking, claudeAsked, claudeMaxTokens]) {
      expect(digestClaude({ head: text, tail: text }).mark).toBe(markOfTail(text).mark)
    }
  })

  it('★报错那条英文不当成「在做什么」(原来卡上写的就是「Not logged in · Please run」)', () => {
    const digest = digestClaude({ head: claudeAuthFailed, tail: claudeAuthFailed })
    expect(digest.activity?.line ?? '').not.toContain('Not logged in')
    expect(digest.failure?.raw).toBe('Not logged in · Please run /login')
  })
})

// ───────────────────── Codex ─────────────────────

describe('Codex:task_complete 是结束,turn_aborted 是中断', () => {
  const ask = line({ type: 'event_msg', timestamp: '2026-09-25T12:00:00.000Z', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '把导出做完' }] } } })
  const work = line({ type: 'event_msg', timestamp: '2026-09-25T12:01:00.000Z', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { 'a.ts': {} } } } })

  it('task_complete → ended(60 份真机 rollout 里 55 份最后一条就是它)', () => {
    const text = [ask, work, line({ type: 'event_msg', timestamp: '2026-09-25T12:02:00.000Z', payload: { type: 'task_complete' } })].join('\n')
    expect(digestCodex({ head: text, tail: text }).mark).toBe('ended')
  })

  it('★turn_aborted → aborted(原来与 task_complete 并成一个 end,被掐断的那一轮会被说成「说完了」)', () => {
    const text = [ask, work, line({ type: 'event_msg', timestamp: '2026-09-25T12:02:00.000Z', payload: { type: 'turn_aborted' } })].join('\n')
    expect(digestCodex({ head: text, tail: text }).mark).toBe('aborted')
  })

  it('error → failed,原文进 failure', () => {
    const text = [ask, line({ type: 'event_msg', timestamp: '2026-09-25T12:02:00.000Z', payload: { type: 'error', message: 'rate limit reached for this model' } })].join('\n')
    const digest = digestCodex({ head: text, tail: text })
    expect(digest.mark).toBe('failed')
    expect(digest.failure?.raw).toContain('rate limit')
  })

  it('停在 item_completed → working', () => {
    const text = [ask, work].join('\n')
    expect(digestCodex({ head: text, tail: text }).mark).toBe('working')
  })
})

// ───────────────────── Kimi(两种文件写法都认) ─────────────────────

describe('Kimi:两种会话文件写法的结束标记', () => {
  it('桌面版 wire 1.4:step.end + end_turn → ended', () => {
    const text = [
      line({ type: 'turn.prompt', time: '2026-09-25T12:00:00.000Z', input: [{ type: 'text', text: '帮我理一下' }] }),
      line({ type: 'context.append_loop_event', time: '2026-09-25T12:00:30.000Z', event: { type: 'content.part', part: { type: 'text', text: '理好了' } } }),
      line({ type: 'context.append_loop_event', time: '2026-09-25T12:00:31.000Z', event: { type: 'step.end', finishReason: 'end_turn' } }),
    ].join('\n')
    expect(digestKimi({ head: text, tail: text }).mark).toBe('ended')
  })

  it('桌面版 wire 1.4:step.end 的 finishReason 是 error / aborted → failed / aborted;tool_calls 不算结束', () => {
    const prompt = line({ type: 'turn.prompt', time: '2026-09-25T12:00:00.000Z', input: [{ type: 'text', text: '跑一下' }] })
    const stepEnd = (reason: string) => line({ type: 'context.append_loop_event', time: '2026-09-25T12:00:10.000Z', event: { type: 'step.end', finishReason: reason } })
    expect(digestKimi({ head: [prompt, stepEnd('error')].join('\n'), tail: [prompt, stepEnd('error')].join('\n') }).mark).toBe('failed')
    expect(digestKimi({ head: [prompt, stepEnd('aborted')].join('\n'), tail: [prompt, stepEnd('aborted')].join('\n') }).mark).toBe('aborted')
    // tool_calls:这一步交给工具了,下一步还会来 —— 不是结束。
    const withTool = [prompt, stepEnd('tool_calls')].join('\n')
    expect(digestKimi({ head: withTool, tail: withTool }).mark).toBe('asked')
  })

  /**
   * 维护者这台上真有的另一种(232 份 `~/.kimi/sessions/*​/*​/wire.jsonl`,`protocol_version 1.10`):
   * 每条是 `{timestamp, message:{type,payload}}`。64/80 份最后一条是 `TurnEnd`。
   */
  it('★另一种写法(protocol_version 1.10):TurnEnd → ended、StepInterrupted → aborted', () => {
    const begin = line({ timestamp: 1790000000.1, message: { type: 'TurnBegin', payload: { user_input: [{ type: 'text', text: '做一下' }] } } })
    const ended = [begin, line({ timestamp: 1790000100.2, message: { type: 'TurnEnd', payload: {} } })].join('\n')
    const cut = [begin, line({ timestamp: 1790000100.2, message: { type: 'StepInterrupted', payload: {} } })].join('\n')
    expect(digestKimi({ head: ended, tail: ended }).mark).toBe('ended')
    expect(digestKimi({ head: cut, tail: cut }).mark).toBe('aborted')
  })

  it('★ApprovalRequest 是**形式上**停下来等人(140 条真机记录);答复过了就不再等', () => {
    const begin = line({ timestamp: 1790000000.1, message: { type: 'TurnBegin', payload: {} } })
    const asking = [begin, line({ timestamp: 1790000010.1, message: { type: 'ApprovalRequest', payload: {} } })].join('\n')
    const answered = [asking, line({ timestamp: 1790000020.1, message: { type: 'ApprovalResponse', payload: {} } })].join('\n')
    expect(digestKimi({ head: asking, tail: asking }).formal_wait).toBe('approval')
    expect(digestKimi({ head: answered, tail: answered }).formal_wait).toBeUndefined()
    expect(digestKimi({ head: answered, tail: answered }).mark).toBe('working')
  })
})

// ───────────────────── 两条证据 → 状态 ─────────────────────

describe('judgeSessionOutcome:文件说停在哪儿 + 进程表说还有没有人在写', () => {
  it('★报错结束 → error(维护者那两张卡的真身:出错,不是进行中)', () => {
    expect(judgeSessionOutcome({ mark: 'failed', nowMs: NOW_MS })).toMatchObject({ status: 'error' })
  })

  it('★被掐断 → 中断(offline + interrupted),不是 error —— 红字只留给真错误', () => {
    expect(judgeSessionOutcome({ mark: 'aborted', nowMs: NOW_MS })).toMatchObject({ status: 'offline', reason: 'interrupted' })
  })

  it('说完了 → done;说完了而进程又忙起来 → running(他刚说了下一句)', () => {
    expect(judgeSessionOutcome({ mark: 'ended', nowMs: NOW_MS })).toMatchObject({ status: 'done' })
    expect(judgeSessionOutcome({ mark: 'ended', writerAlive: true, writerBusy: true, nowMs: NOW_MS })).toMatchObject({ status: 'running' })
  })

  it('在干活 + 进程还在 → running', () => {
    expect(judgeSessionOutcome({ mark: 'working', writerAlive: true, writerBusy: true, nowMs: NOW_MS })).toMatchObject({ status: 'running' })
  })

  it('★在干活 / 他刚说完话 + **写它的进程没了** → 中断,不是进行中', () => {
    for (const mark of ['working', 'asked'] as const) {
      expect(judgeSessionOutcome({ mark, writerAlive: false, nowMs: NOW_MS })).toMatchObject({ status: 'offline', reason: 'interrupted' })
    }
  })

  it('★进程在、但它说自己空闲 → 空闲(done),不是「待确认」', () => {
    const out = judgeSessionOutcome({ mark: 'asked', writerAlive: true, writerBusy: false, nowMs: NOW_MS })
    expect(out).toMatchObject({ status: 'done' })
    expect(out?.status).not.toBe('waiting')
  })

  it('形式上停下来在等人 → waiting(等批准走 permission_prompt,在问他走 idle_prompt)', () => {
    expect(judgeSessionOutcome({ mark: 'working', formalWait: 'approval', nowMs: NOW_MS })).toMatchObject({ status: 'waiting', reason: 'permission_prompt' })
    expect(judgeSessionOutcome({ mark: 'working', formalWait: 'question', nowMs: NOW_MS })).toMatchObject({ status: 'waiting' })
  })

  /**
   * 次序:**直接证据先于推断**。文件写到哪儿与 pid 文件此刻怎么说是两个来源、两个时刻,
   * 真机上难保不错拍 —— 它明写着在等人,就别自己去猜它是不是说完了。
   * 但**报错 / 被掐断盖过形式等待**:一条报错收场的会话不会同时「在等他批」。
   */
  it('★次序:形式等待盖过「说完了」;报错 / 被掐断又盖过形式等待', () => {
    expect(judgeSessionOutcome({ mark: 'ended', formalWait: 'approval', nowMs: NOW_MS })).toMatchObject({ status: 'waiting' })
    expect(judgeSessionOutcome({ mark: 'failed', formalWait: 'approval', nowMs: NOW_MS })).toMatchObject({ status: 'error' })
    expect(judgeSessionOutcome({ mark: 'aborted', formalWait: 'approval', nowMs: NOW_MS })).toMatchObject({ status: 'offline', reason: 'interrupted' })
  })

  it('查不到有没有进程在写(老版本客户端):还在长 → running;长时间不长 → 中断', () => {
    expect(judgeSessionOutcome({ mark: 'working', growing: true, nowMs: NOW_MS })).toMatchObject({ status: 'running' })
    expect(judgeSessionOutcome({ mark: 'working', lastAtMs: NOW_MS - STALL_MS - 1000, nowMs: NOW_MS })).toMatchObject({ status: 'offline', reason: 'interrupted' })
    expect(judgeSessionOutcome({ mark: 'working', lastAtMs: NOW_MS - 30_000, nowMs: NOW_MS })).toMatchObject({ status: 'running' })
  })

  it('认不出这份记录 → 不下结论,谁也不动', () => {
    expect(judgeSessionOutcome({ nowMs: NOW_MS })).toBeUndefined()
  })

  it('每一条结论都带一句「凭什么」(验收与排错看它)', () => {
    for (const mark of ['ended', 'failed', 'aborted', 'working', 'asked'] as const) {
      expect(judgeSessionOutcome({ mark, nowMs: NOW_MS })?.why).toBeTruthy()
    }
  })
})

// ───────────────────── 探针认得出来 ─────────────────────

describe('工作台自己起的会话认得出来(不进舞台、不计数)', () => {
  it('第一句带自检前缀 → 认出来,记 by: prefix', () => {
    const text = [
      line({ type: 'last-prompt', lastPrompt: `${SELFCHECK_PREFIX}这家通不通?回一个字。`, sessionId: 'p1' }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `${SELFCHECK_PREFIX}这家通不通?回一个字。` }] }, cwd: '/Users/example/Documents/工作台', sessionId: 'p1' }),
    ].join('\n')
    expect(selfcheckOfTail(text, '/Users/example/Documents/工作台')).toEqual({ by: 'prefix' })
  })

  it('跑在自检目录里 → 认出来,记 by: cwd(cwd 这条最省,连文件都不用读)', () => {
    expect(selfcheckOfTail('', '/Users/example/Documents/工作台/.工作台自检')).toEqual({ by: 'cwd' })
    expect(selfcheckOfTail('', '/Users/example/Documents/工作台/.工作台自检/claude')).toEqual({ by: 'cwd' })
  })

  /**
   * ★过渡那一条:卡 O 现在的探针还没换成前两样约定(它在 cwd `/` 里探「What is 2+2?」)。
   * **不认那句英文**(写死一句话就是打补丁),认记录里「这一轮是谁发起的」那几格。
   */
  it('★没有人往这条会话里打过字(turnOrigin/promptSource/entrypoint 是 sdk)→ 认出来,记 by: sdk', () => {
    // 09-25 维护者这台上那两条探针的真形状。
    expect(selfcheckOfTail(claudeAuthFailed, '/')).toEqual({ by: 'sdk' })
    expect(selfcheckOfTail(claudeEnded, '/')).toEqual({ by: 'sdk' })
  })

  it('`turnOrigin: sdk` 与 `entrypoint: sdk-ts` 都算(不同版本写的格子不一样)', () => {
    const byTurn = line({ type: 'user', turnOrigin: 'sdk', message: { role: 'user', content: [{ type: 'text', text: '一句' }] }, cwd: '/x' })
    expect(selfcheckOfTail(byTurn, '/x')).toEqual({ by: 'sdk' })
    expect(selfcheckOfTail(line({ type: 'attachment', entrypoint: 'sdk-ts', cwd: '/x' }), '/x')).toEqual({ by: 'sdk' })
  })

  /**
   * ★★09-25 差点栽在这儿的那一条(真机核对时抓出来的)。
   *
   * 统筹那条**真会话**(唯一真在跑的那一条)里有 **83 条** `promptSource: 'sdk'` 而
   * `turnOrigin: 'human'` 的记录 —— 那是**他的话经程序转进来**的(手机上打的、统筹替他转述的)。
   * 拿 `promptSource` 当判据的话,唯一那条真在跑的会话会被当成探针藏掉:
   * 舞台从「3 张假的」变成「一张都没有」,比原来的毛病更糟。
   */
  it('★★`promptSource: sdk` 但 `turnOrigin: human`(他的话经程序转进来)→ **不是**探针', () => {
    const relayed = [
      line({ type: 'user', turnOrigin: 'human', promptSource: 'sdk', entrypoint: 'claude-desktop', message: { role: 'user', content: [{ type: 'text', text: '卡 V 补一条' }] }, cwd: '/Users/example/x' }),
      line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '好' }] }, entrypoint: 'claude-desktop', cwd: '/Users/example/x' }),
    ].join('\n')
    expect(selfcheckOfTail(relayed, '/Users/example/x')).toBeUndefined()
  })

  it('★他往这条会话里打过字 → 一律不是探针(哪怕中间夹着程序发的话)', () => {
    const mixed = [
      line({ type: 'user', turnOrigin: 'sdk', message: { role: 'user', content: [{ type: 'text', text: '程序发的一句' }] }, cwd: '/x' }),
      line({ type: 'user', turnOrigin: 'human', message: { role: 'user', content: [{ type: 'text', text: '他自己打的一句' }] }, cwd: '/x' }),
    ].join('\n')
    expect(selfcheckOfTail(mixed, '/x')).toBeUndefined()
  })

  it('★他自己的会话认不成探针(不许误伤):打字开的那种 turnOrigin 不是 sdk', () => {
    expect(selfcheckOfTail(claudeWorking, '/Users/example/x')).toBeUndefined()
    expect(selfcheckOfTail(claudeAsked, '/Users/example/x')).toBeUndefined()
    // 桌面 App / 命令行里他亲手开的:这几格是 user / cli / claude-desktop。
    const his = line({ type: 'user', turnOrigin: 'user', promptSource: 'cli', entrypoint: 'claude-desktop', message: { role: 'user', content: [{ type: 'text', text: '帮我改一处' }] }, cwd: '/Users/example/x' })
    expect(selfcheckOfTail(his, '/Users/example/x')).toBeUndefined()
  })

  it('自检目录 / 前缀比 sdk 这一条硬(by 如实记是靠哪条)', () => {
    const inDir = line({ type: 'user', turnOrigin: 'sdk', message: { role: 'user', content: [{ type: 'text', text: '一句' }] } })
    expect(selfcheckOfTail(inDir, '/Users/example/工作台/.工作台自检')).toEqual({ by: 'cwd' })
    const prefixed = line({ type: 'last-prompt', lastPrompt: `${SELFCHECK_PREFIX}通不通?` })
    expect(selfcheckOfTail(prefixed, '/x')).toEqual({ by: 'prefix' })
  })
})
