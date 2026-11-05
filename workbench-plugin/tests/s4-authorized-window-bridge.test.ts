// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createAuthorizedS4WindowBridge, s4OpeningCacheReady } from '../dev/acceptance-three-entrances/s4AuthorizedBridge.ts'
import { dispatchMarker, dispatchPrompt } from '../src/server/dispatchReply.ts'
import { S4_WINDOW_QA_RULE } from '../src/server/s4WindowQaRules.ts'
const task = { id: 't-12345678', title: '把样片剪一版', project_id: '样片' }
const request = { op: 'send_text' as const, bundle_id: 'com.anthropic.claudefordesktop', index: 0, text: dispatchPrompt({ taskId: task.id, said: task.title }) + '\n\n' + S4_WINDOW_QA_RULE, submit: true, new_conversation: true }
it('缺失授权/真实任务/安全段或错误目标不调用原 Swift；不改 submit 凑成功', async () => {
  const invoke = vi.fn(async () => ({ ok: true, result: { submitted: true } }))
  const make = (authorized = true, tasks = [task]) => createAuthorizedS4WindowBridge({ authorized, tasks: async () => tasks, invoke })
  await expect(make(false).handle(request)).rejects.toThrow(/authorization/)
  await expect(make(true, []).handle(request)).rejects.toThrow(/task/)
  for (const bad of [{ ...request, text: dispatchPrompt({ taskId: task.id, said: task.title }) }, { ...request, submit: false }, { ...request, bundle_id: 'com.openai.codex' }, { ...request, new_conversation: false }, { ...request, index: 1 }]) await expect(make().handle(bad)).rejects.toThrow()
  expect(invoke).not.toHaveBeenCalled()
})
it('只交原包一次，原始 Swift 失败/提交结果不伪造；同 marker 回话可读，其余 op 一律拒绝', async () => {
  const raw = { ok: true, result: { submitted: true, method: 'ax' } }
  const invoke = vi.fn(async () => raw)
  const bridge = createAuthorizedS4WindowBridge({ authorized: true, tasks: async () => [task], invoke })
  await expect(bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: dispatchMarker(task.id) })).rejects.toThrow(/before/)
  expect(await bridge.handle(request)).toBe(raw)
  expect(invoke).toHaveBeenCalledWith(request)
  await expect(bridge.handle(request)).rejects.toThrow(/one/)
  await expect(bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: 'another' })).rejects.toThrow(/marker/)
  await expect(bridge.handle({ op: 'agent_read', bundle_id: request.bundle_id })).rejects.toThrow(/op/)
  expect(await bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: dispatchMarker(task.id) })).toBe(raw)
  expect(invoke).toHaveBeenCalledTimes(2)
})
it('failed send 也花掉唯一转发额度，但允许按本任务 marker 查实际送达，不重发或改回执', async () => {
  const raw = { ok: false, error: 'actual Swift failure' }
  const invoke = vi.fn(async () => raw)
  const bridge = createAuthorizedS4WindowBridge({ authorized: true, tasks: async () => [task], invoke })
  expect(await bridge.handle(request)).toBe(raw)
  await expect(bridge.handle(request)).rejects.toThrow(/one/)
  expect(await bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: dispatchMarker(task.id) })).toBe(raw)
})

it('开场缓存 readiness 按真实日志的空白格式读，12句未全备好不得放行', () => {
  expect(s4OpeningCacheReady('[channel-worker] 开场白备好了 12 句(缓存里共 12 句),提机就出声。')).toBe(true)
  expect(s4OpeningCacheReady('开场白备好了12句')).toBe(true)
  expect(s4OpeningCacheReady('开场白备好了 2 句')).toBe(false)
  expect(s4OpeningCacheReady('开场白预合成503')).toBe(false)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
for (const otherCard of [false, true]) {
  for (const failure of ['reply', 'throw'] as const) {
    it(`并发tasks同时放行只发送一次：${otherCard ? '不同卡' : '同卡'}/${failure}，pending与失败都不释放`, async () => {
      const other = { ...task, id: 't-87654321' }
      const otherRequest = otherCard ? { ...request, text: dispatchPrompt({ taskId: other.id, said: other.title }) + '\n\n' + S4_WINDOW_QA_RULE } : request
      const tasks = deferred<readonly typeof task[]>()
      const swift = deferred<unknown>()
      const read = { ok: true, result: { found: true, busy: false, texts: ['controlled same-marker read'] } }
      const inputTasks = vi.fn(() => tasks.promise)
      const invoke = vi.fn((message: { op: string }) => message.op === 'send_text' ? swift.promise : Promise.resolve(read))
      const bridge = createAuthorizedS4WindowBridge({ authorized: true, tasks: inputTasks, invoke })
      // Attach rejection handlers immediately; neither caller can finish reading tasks before both have entered.
      const first = bridge.handle(request).then(value => ({ kind: 'ok' as const, value }), error => ({ kind: 'error' as const, error }))
      const second = bridge.handle(otherRequest).then(value => ({ kind: 'ok' as const, value }), error => ({ kind: 'error' as const, error }))
      expect(inputTasks).toHaveBeenCalledTimes(2)
      expect(invoke).not.toHaveBeenCalled()
      tasks.resolve([task, other])
      await Promise.resolve(); await Promise.resolve()
      try {
        expect(invoke).toHaveBeenCalledTimes(1)
        expect(invoke).toHaveBeenCalledWith(request)
        const rejected = await second
        expect(rejected.kind).toBe('error')
        if (rejected.kind === 'error') expect(String(rejected.error)).toMatch(/only one/)
        await expect(bridge.handle(request)).rejects.toThrow(/only one/)
        expect(inputTasks).toHaveBeenCalledTimes(2)
        expect(await bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: dispatchMarker(task.id) })).toBe(read)
        if (otherCard) await expect(bridge.handle({ op: 'read_reply', bundle_id: request.bundle_id, index: 0, marker: dispatchMarker(other.id) })).rejects.toThrow(/marker/)
        if (failure === 'reply') swift.resolve({ ok: false, error: 'controlled Swift failure' })
        else swift.reject(new Error('controlled Swift rejection'))
        const finished = await first
        expect(finished.kind).toBe(failure === 'reply' ? 'ok' : 'error')
        if (finished.kind === 'ok') expect(finished.value).toEqual({ ok: false, error: 'controlled Swift failure' })
        await expect(bridge.handle(request)).rejects.toThrow(/only one/)
        expect(invoke.mock.calls.filter(([message]) => message.op === 'send_text')).toHaveLength(1)
      } finally {
        swift.resolve({ ok: false, error: 'fixture cleanup' })
        await Promise.all([first, second])
      }
    })
  }
}
