// @vitest-environment node
/**
 * 提问与审批两条 DSH waterfall 接到外层(2026-09-25,卡 M)。DSH 是假的(一个 on + 一个假会话日志),
 * 真 DSH 里那一遍在灰度实例里跑(交接第四节)。
 */
import { describe, expect, it, vi } from 'vitest'
import { wireApprovalAnswerer, wireQuestionAnswerer } from '../src/index.ts'
import { createApprovalGrants, createQuestionBroker } from '../src/server/butlerAsks.ts'
import { createApprovalBroker } from '../src/server/composer.ts'

const QUESTION = {
  id: 'confirm_avatar_clip',
  header: '派活前对一遍',
  question: '哪条不对说一下,都对就开工。',
  options: [{ label: '都对,开工' }, { label: '都对,但你自己做' }, { label: '有不对的,我来说' }],
}

function captureListener(event: string) {
  let listener: ((req: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let options: unknown
  const on = vi.fn((name: string, fn: never, opts?: unknown) => { if (name === event) { listener = fn; options = opts } })
  return {
    ctx: { on: on as never, inject: vi.fn() },
    call: (req: unknown, next: () => Promise<unknown>) => listener!(req, next),
    options: () => options,
  }
}

function userCancel(): Error {
  return Object.assign(new Error('the user cancelled ask_user_question'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' })
}

describe('wireQuestionAnswerer', () => {
  function wire() {
    const broker = createQuestionBroker()
    const hook = captureListener('user-questions/request')
    wireQuestionAnswerer(hook.ctx, broker)
    return { broker, ...hook }
  }

  it('排在最前面(prepend)', () => {
    expect(wire().options()).toEqual({ prepend: true })
  })

  it('网页那边没人答(NO_PROVIDER)→ 不算数;电脑 / 手机上答了 → 交回 DSH 要的形状,那一问消失', async () => {
    const { broker, call } = wire()
    const pending = call({ agent: { session: { id: 's-1' } }, questions: [QUESTION] }, () => Promise.reject(Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })))
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.answer(broker.list()[0]!.id, [{ id: 'confirm_avatar_clip', selected: ['都对,开工'] }])).toEqual({ ok: true })
    expect(await pending).toEqual({ answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工'] }] })
    expect(broker.list()).toEqual([])
  })

  it('我们先答了:往后传给网页的那个 signal 跟着停 —— 网页上那个面板收掉', async () => {
    const { broker, call } = wire()
    const outer = new AbortController()
    const req: { agent: unknown, questions: unknown[], signal?: AbortSignal } = { agent: { session: { id: 's-1' } }, questions: [QUESTION], signal: outer.signal }
    let seen: AbortSignal | undefined
    const pending = call(req, () => { seen = req.signal; return new Promise(() => {}) })
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(seen).toBeDefined()
    expect(seen?.aborted).toBe(false)
    broker.answer(broker.list()[0]!.id, [{ id: 'confirm_avatar_clip', custom: '你自己能修吗' }])
    expect(await pending).toEqual({ answers: [{ id: 'confirm_avatar_clip', selected: [], custom: '你自己能修吗' }] })
    expect(seen?.aborted).toBe(true)
    expect(outer.signal.aborted).toBe(false)
  })

  it('网页那边先答了 → 用它的,外层那一张撤掉', async () => {
    const { broker, call } = wire()
    const web = { answers: [{ id: 'confirm_avatar_clip', selected: ['都对,但你自己做'] }] }
    expect(await call({ agent: { session: { id: 's-1' } }, questions: [QUESTION] }, async () => web)).toEqual(web)
    expect(broker.list()).toEqual([])
  })

  it('他在 DSH 网页上点了关掉(ASK_CANCELLED)→ 整问作废,外层那一张也收掉', async () => {
    const { broker, call } = wire()
    await expect(call({ agent: { session: { id: 's-1' } }, questions: [QUESTION] }, () => Promise.reject(userCancel()))).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(broker.list()).toEqual([])
  })

  it('网页掉线(转发那一份被撤)不算数,照样等外层', async () => {
    const { broker, call } = wire()
    const pending = call({ agent: { session: { id: 's-1' } }, questions: [QUESTION] }, () => Promise.reject(new Error('api-remotes: forwarded Remote event source ended')))
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    broker.answer(broker.list()[0]!.id, [{ id: 'confirm_avatar_clip', selected: ['有不对的,我来说'] }])
    expect(await pending).toEqual({ answers: [{ id: 'confirm_avatar_clip', selected: ['有不对的,我来说'] }] })
  })

  it('这一轮被停了 → 抛上游认得的「中断」,那一张收掉', async () => {
    const { broker, call } = wire()
    const outer = new AbortController()
    const pending = call({ agent: { session: { id: 's-1' } }, questions: [QUESTION], signal: outer.signal }, () => new Promise(() => {}))
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    outer.abort()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(broker.list()).toEqual([])
  })

  it('没有会话(不是哪位 Agent 问的)、没有问题 → 不接,原样往后传', async () => {
    const { broker, call } = wire()
    const next = vi.fn(async () => ({ answers: [] }))
    await call({ questions: [QUESTION] }, next)
    await call({ agent: { session: { id: 's-1' } }, questions: [] }, next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(broker.list()).toEqual([])
  })
})

describe('wireApprovalAnswerer 的人话与「同类的都允许」', () => {
  const REPO = '/Users/example/Documents/GitHub/desktop-workbench'
  function session(args: Record<string, unknown>) {
    const events = [{ type: 'tool/call', data: { callId: 'c-1', name: 'bash', arguments: JSON.stringify(args) } }]
    return { id: 's-1', header: { cwd: '/Users/example/Documents/工作台' }, seq: events.length, eventAt: (seq: number) => events[seq] }
  }
  function wire(taskOf?: (sessionId: string) => Promise<{ id: string, status: string } | undefined>) {
    const broker = createApprovalBroker()
    const grants = createApprovalGrants()
    const hook = captureListener('approval/request')
    wireApprovalAnswerer(hook.ctx, broker, {
      grants,
      home: '/Users/example',
      tempRoots: ['/tmp', '/private/tmp'],
      repoRootOf: path => (path.startsWith(REPO) ? REPO : undefined),
      ...(taskOf === undefined ? {} : { taskOf }),
    })
    return { broker, grants, ...hook }
  }
  const escalate = (command: string, justification: string) => ({
    agent: { session: session({ command, sandbox_permissions: 'danger-full-access', justification }) },
    toolName: 'bash',
    callId: 'c-1',
    reason: `escalate sandbox to danger-full-access: ${justification}`,
  })

  it('挂上去的那一条带着人话、放开到多大、同类的那一类、原话', async () => {
    const { broker, call } = wire()
    void call(escalate(`cd ${REPO} && git switch -c fix/avatar-headroom`, '工作台自己的仓库在会话工作目录之外'), async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.list()[0]).toMatchObject({
      say: '要在「desktop-workbench」这个仓库里跑一条命令',
      why: '工作台自己的仓库在会话工作目录之外',
      scope: '这一条要能改这台电脑上的任何文件;平时只能改「工作台」文件夹和临时文件。',
      kind: { key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' },
      raw: { reason: expect.stringContaining('escalate sandbox'), command: expect.stringContaining('git switch') },
    })
  })

  it('这件事里他点过「同类的都允许」:同类的直接放行,不挂、不问网页,数一次', async () => {
    const { broker, grants, call } = wire()
    grants.grant({ sessionId: 's-1' }, { key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' })
    const next = vi.fn(async () => 'rejected')
    expect(await call(escalate(`mkdir -p ${REPO}/workbench-plugin/dev/avatar-clip`, '试验页要落在仓库里'), next)).toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
    expect(broker.list()).toEqual([])
    expect(grants.list()[0]?.allowed).toBe(1)
  })

  it('★记在事项上的(卡 M 追加):这件事换了会话 / DSH 重启过照样认;这件事收了就不认、顺手作废', async () => {
    let status = 'doing'
    const { broker, grants, call } = wire(async () => ({ id: 't-1', status }))
    grants.grant({ sessionId: 's-old', taskId: 't-1' }, { key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' })
    expect(await call(escalate(`cd ${REPO} && git status`, '看一眼'), vi.fn(async () => 'rejected'))).toBe('allowed-once')
    expect(grants.list()[0]?.allowed).toBe(1)
    status = 'done'
    void call(escalate(`cd ${REPO} && git status`, '看一眼'), async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(grants.list()).toEqual([])
  })

  it('不是同一类(开浏览器截图)照样问', async () => {
    const { broker, grants, call } = wire()
    grants.grant({ sessionId: 's-1' }, { key: `repo:${REPO}`, title: '改「desktop-workbench」这个仓库' })
    void call(escalate('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/a.png about:blank', 'headless Chrome 要写 crashpad 目录'), async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.list()[0]?.kind?.key).toBe('browser')
  })

  it('我们先答了:往后传给网页的那个 signal 跟着停', async () => {
    const { broker, call } = wire()
    const req = { ...escalate(`cd ${REPO} && ls`, '看一眼'), signal: new AbortController().signal } as { signal?: AbortSignal }
    let seen: AbortSignal | undefined
    const pending = call(req, () => { seen = req.signal; return new Promise(() => {}) })
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    broker.answer(broker.list()[0]!.id, false)
    expect(await pending).toBe('rejected')
    expect(seen?.aborted).toBe(true)
  })

  it('会话日志里找不到那次调用:照旧能批,只是没有「同类的」', async () => {
    const { broker, call } = wire()
    void call({ agent: { session: { id: 's-1' } }, toolName: 'bash', callId: 'nope', reason: 'escalate sandbox to danger-full-access: 要写仓库' }, async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.list()[0]).toMatchObject({ say: '要跑一条命令', why: '要写仓库' })
    expect(broker.list()[0]?.kind).toBeUndefined()
  })
})
