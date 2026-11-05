// @vitest-environment node
/**
 * 引导会话的回合(2026-09-16,给手机 App):从 DSH 原生事件里把 user / assistant 的文字折出来,
 * 去掉工具调用与代码块;阶段机发的种子句不算用户回合;会话 disposed 就算结束。
 */
import { describe, expect, it } from 'vitest'
import { ONBOARDING_MODEL_DOWN, cleanTurnText, createOnboardingTurns, speechKey, textOfContent, turnEndOutcome, wireOnboardingTurns } from '../src/server/onboardingTurns.ts'

const T = () => new Date('2026-09-16T08:00:00Z')

const user = (text: string, kind = 'user') => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_call', id: 'c', name: 'bash', arguments: '{}' }] }, ...extra } })

describe('cleanTurnText', () => {
  it('去掉 ``` 代码块与行内 `curl …`,压掉多余空行,首尾修剪', () => {
    const raw = '好的,记下了。\n\n```bash\ncurl -X POST http://127.0.0.1:8791/onboarding/answer -d \'{"stage":"opening"}\'\n```\n\n\n那你现在是已经有在做的事,还是想从一个新点子开始?  '
    expect(cleanTurnText(raw)).toBe('好的,记下了。\n\n那你现在是已经有在做的事,还是想从一个新点子开始?')
    expect(cleanTurnText('```\nonly code\n```')).toBe('')
    expect(cleanTurnText('我记一下:`{"stage":"opening","key":"nickname","value":"Ben"}`,然后接着聊。')).toBe('我记一下,然后接着聊。')
  })
  it('textOfContent 只拼 text 块;不是数组当空', () => {
    expect(textOfContent([{ type: 'text', text: '甲' }, { type: 'tool_call' }, { type: 'text', text: '乙' }])).toBe('甲\n乙')
    expect(textOfContent('x')).toBe('')
  })
})

describe('speechKey', () => {
  it('去空白与标点(全角半角都算)后比较:模型改了标点的开场白与 Ben 亲笔那句算同一句', () => {
    const ben = '你好,很高兴认识你,我是你的专属事务官。我能够帮助你更轻松、更有条理的经营你的事业,首先,你希望我怎么称呼你?'
    const model = '你好,很高兴认识你,我是你的专属事务官。 我能够帮助你更轻松、更有条理的经营你的事业,首先,你希望我怎么称呼你?'
    expect(speechKey(ben)).toBe(speechKey(model))
    expect(speechKey(' 叫我 Ben。 ')).toBe('叫我Ben')
    expect(speechKey('叫我 Ben')).not.toBe(speechKey('叫我 Bob'))
    expect(speechKey('')).toBe('')
  })
})

describe('createOnboardingTurns', () => {
  it('种子句(2026-09-16 开场体验):模型照念的那条标 kind:seed;紧接着一模一样的再说一遍不重复记;阶段推进后换种子句', () => {
    const turns = createOnboardingTurns({ now: T })
    const opening = '你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你?'
    turns.bind('sess-1', '[引导 · ① 开场]\n开场白…', opening)
    turns.handleEvent('sess-1', assistant('我先读一下引导技能和工作区的规矩。'))
    // 模型把半角逗号念成了全角,末尾多了空白:还是那句种子句。
    turns.handleEvent('sess-1', assistant('你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你? '))
    turns.handleEvent('sess-1', assistant(opening))
    turns.handleEvent('sess-1', user('叫我 Ben'))
    turns.handleEvent('sess-1', assistant('Ben,记下了。'))
    turns.setStageSeed('你现在是已经有在做的事,还是想从一个新点子开始?')
    turns.handleEvent('sess-1', assistant('你现在是已经有在做的事,还是想从一个新点子开始?'))
    turns.handleEvent('sess-1', assistant('你现在是已经有在做的事,还是想从一个新点子开始?'))
    turns.handleEvent('sess-1', assistant('比如手上的仓库,或者一个还没动手的点子。'))
    expect(turns.list(0).map(t => [t.seq, t.role, t.text, t.kind])).toEqual([
      [1, 'assistant', '我先读一下引导技能和工作区的规矩。', undefined],
      [2, 'assistant', '你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你?', 'seed'],
      [3, 'user', '叫我 Ben', undefined],
      [4, 'assistant', 'Ben,记下了。', undefined],
      [5, 'assistant', '你现在是已经有在做的事,还是想从一个新点子开始?', 'seed'],
      [6, 'assistant', '比如手上的仓库,或者一个还没动手的点子。', undefined],
    ])
    // 中间隔了用户的话,同一句再说不算重复(用户可能真的让它再说一遍)。
    turns.handleEvent('sess-1', user('再说一遍'))
    turns.handleEvent('sess-1', assistant('比如手上的仓库,或者一个还没动手的点子。'))
    expect(turns.list(6).map(t => t.seq)).toEqual([7, 8])
    // 没给种子句时照旧:没有 kind。
    turns.reset()
    turns.bind('sess-2', 'first')
    turns.handleEvent('sess-2', assistant(opening))
    expect(turns.list(0)[0]?.kind).toBeUndefined()
  })

  it('绑定会话后:种子句不算用户回合;用户说的、事务官说的按 seq 递增;别的会话不收', () => {
    const turns = createOnboardingTurns({ now: T })
    turns.bind('sess-1', '[引导 · ① 开场]\n开场白…')
    turns.handleEvent('sess-1', user('[引导 · ① 开场]\n开场白…'))
    turns.handleEvent('sess-1', { type: 'turn/start', data: { turn: 1 } })
    turns.handleEvent('sess-1', assistant('你好,很高兴认识你。你希望我怎么称呼你?'))
    turns.handleEvent('sess-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    turns.handleEvent('sess-1', user('叫我 Ben'))
    turns.handleEvent('sess-1', { type: 'turn/start', data: { turn: 2 } })
    turns.handleEvent('sess-1', assistant('```bash\ncurl …\n```'))
    turns.handleEvent('sess-1', assistant('Ben,记下了。'))
    turns.handleEvent('sess-2', assistant('别的会话'))
    turns.handleEvent('sess-1', user('注入的上下文', 'plugin'))
    expect(turns.list(0)).toEqual([
      { seq: 1, role: 'assistant', text: '你好,很高兴认识你。你希望我怎么称呼你?', at: '2026-09-16T08:00:00.000Z' },
      { seq: 2, role: 'user', text: '叫我 Ben', at: '2026-09-16T08:00:00.000Z' },
      { seq: 3, role: 'assistant', text: 'Ben,记下了。', at: '2026-09-16T08:00:00.000Z' },
    ])
    expect(turns.list(2).map(t => t.seq)).toEqual([3])
    expect(turns.status()).toEqual({ session_id: 'sess-1', busy: true, ended: false, failed: false })
    turns.handleEvent('sess-1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    expect(turns.status().busy).toBe(false)
  })
  it('会话 disposed → ended;重新绑定新会话回合接着编号、不清历史;reset 清空', () => {
    const turns = createOnboardingTurns({ now: T })
    turns.bind('sess-1', 'seed')
    turns.handleEvent('sess-1', assistant('一'))
    turns.handleDisposed('sess-1')
    expect(turns.status()).toEqual({ session_id: 'sess-1', busy: false, ended: true, failed: false })
    turns.bind('sess-2', '这是接着上次做…')
    expect(turns.status()).toEqual({ session_id: 'sess-2', busy: false, ended: false, failed: false })
    turns.handleEvent('sess-2', user('这是接着上次做…'))
    turns.handleEvent('sess-2', assistant('上次到哪,接着吗?'))
    expect(turns.list(0).map(t => [t.seq, t.text])).toEqual([[1, '一'], [2, '上次到哪,接着吗?']])
    turns.reset()
    expect(turns.list(0)).toEqual([])
    expect(turns.status()).toEqual({ busy: false, ended: false, failed: false })
  })
  it('turn/end reason kind:error(2026-09-23 no API key)→ 补一句人话 kind:error、failed 置真、通知 onTurnEnd;连着坏只说一次;下一轮正常撤掉', () => {
    const ends: [string, unknown][] = []
    const turns = createOnboardingTurns({ now: T, onTurnEnd: (id, outcome) => { ends.push([id, outcome]) } })
    turns.bind('sess-1', 'seed')
    const failure = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'llm-deepseek: no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' } } } }
    turns.handleEvent('sess-1', { type: 'turn/start', data: { turn: 1 } })
    turns.handleEvent('sess-1', failure)
    expect(turns.status()).toMatchObject({ busy: false, failed: true })
    expect(turns.list(0)).toEqual([{ seq: 1, role: 'assistant', text: ONBOARDING_MODEL_DOWN, at: '2026-09-16T08:00:00.000Z', kind: 'error' }])
    expect(turns.list(0)[0]!.text).not.toContain('deepseek')
    turns.handleEvent('sess-1', failure)
    expect(turns.list(0)).toHaveLength(1)
    turns.handleEvent('sess-1', user('你在吗'))
    turns.handleEvent('sess-1', failure)
    expect(turns.list(0).map(t => t.kind ?? t.role)).toEqual(['error', 'user', 'error'])
    turns.handleEvent('sess-1', { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    expect(turns.status().failed).toBe(false)
    expect(ends).toEqual([
      ['sess-1', { ok: false, code: 'MISSING_CREDENTIAL', message: expect.stringContaining('no API key') }],
      ['sess-1', expect.objectContaining({ ok: false })],
      ['sess-1', expect.objectContaining({ ok: false })],
      ['sess-1', { ok: true }],
    ])
    // 别的会话的 turn/end 不理;回调抛了也不带走派发。
    turns.handleEvent('other', failure)
    expect(ends).toHaveLength(4)
    const throwing = createOnboardingTurns({ now: T, onTurnEnd: () => { throw new Error('boom') } })
    throwing.bind('s', 'seed')
    expect(() => throwing.handleEvent('s', failure)).not.toThrow()
    expect(throwing.status().failed).toBe(true)
  })
  it('turnEndOutcome:只有明确 kind:error 才算坏', () => {
    expect(turnEndOutcome({ turn: 1, reason: { kind: 'aborted', reason: {} } })).toEqual({ ok: true })
    expect(turnEndOutcome(undefined)).toEqual({ ok: true })
    expect(turnEndOutcome({ reason: { kind: 'error' } })).toEqual({ ok: false })
  })
  it('坏事件当没看见;回合上限之外的旧回合丢掉', () => {
    const turns = createOnboardingTurns({ now: T, limit: 3 })
    turns.bind('s', 'seed')
    expect(() => turns.handleEvent('s', { type: 'assistant/message', data: null })).not.toThrow()
    expect(() => turns.handleEvent('s', { type: 'user/message', data: { content: 'x' } })).not.toThrow()
    for (const text of ['1', '2', '3', '4']) turns.handleEvent('s', assistant(text))
    expect(turns.list(0).map(t => t.text)).toEqual(['2', '3', '4'])
  })
  it('wireOnboardingTurns:接 session/event 与 session/disposed,监听器里绝不抛', () => {
    const handlers = new Map<string, (...args: never[]) => void>()
    const ctx = { on: (name: string, handler: (...args: never[]) => void) => { handlers.set(name, handler) } }
    const fire = (name: string, ...args: unknown[]) => (handlers.get(name) as unknown as (...a: unknown[]) => void)(...args)
    const turns = createOnboardingTurns({ now: T })
    wireOnboardingTurns(ctx, turns)
    turns.bind('s', 'seed')
    fire('session/event', { id: 's' }, assistant('嗯'))
    fire('session/event', { id: 's' }, { type: 3 })
    fire('session/event', null, undefined)
    fire('session/disposed', { id: 's' })
    expect(turns.list(0).map(t => t.text)).toEqual(['嗯'])
    expect(turns.status().ended).toBe(true)
    // 没有 ctx / 不认识事件:整块跳过,不抛。
    expect(() => wireOnboardingTurns(undefined, turns)).not.toThrow()
    expect(() => wireOnboardingTurns({ on: () => { throw new Error('unknown event') } }, turns)).not.toThrow()
  })
})
