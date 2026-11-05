// @vitest-environment node
/**
 * 受控假模型(2026-10-29 退修 1 起共用):入口归一后所有入口进理解中枢,打 `/butler/say`、`/butler/item`
 * 的用例用它给中枢喂命令 —— 与 `tests/task-execution-entrances.test.ts` 里那套同一个形状:
 *
 *   const model = fakeHubModel({ '她说的一句': [{ name: 'note', title: '…', status: 'todo' }] })
 *   startWorkbenchServer({ ..., model: model.service, fetchImpl: model.fetchImpl })
 *
 * - 键 = 提示词里「说:「…」」的那句原话;值可以是数组,也可以是拿整条提示词的函数
 *   (答挂着的那一问要按上下文包里的 ask_id 出 confirm 时用)。
 * - 喂表外的句子回 503 —— 用例红出来,不许悄悄冒称听懂。
 * - `seen` 记下每条提示词,断言「原话 / 附件 / 点名作为事实进了上下文包」用得上。
 */
export interface FakeHubModel {
  /** 传给 startWorkbenchServer 的 model 替身(只有 endpoint() 一个口)。 */
  service: { endpoint: () => Promise<{ baseUrl: string, key: string, model: string, ready: true }> }
  /** 传给 startWorkbenchServer 的 fetchImpl。 */
  fetchImpl: typeof fetch
  /** 假模型看到的提示词(逐条,按顺序)。 */
  seen: { prompts: string[] }
}

export type FakeHubCommands = Record<string, Record<string, unknown>[] | ((body: string) => Record<string, unknown>[] | undefined)>

export function fakeHubModel(answers: FakeHubCommands): FakeHubModel {
  const seen: FakeHubModel['seen'] = { prompts: [] }
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? '')
    seen.prompts.push(body)
    const said = body.split('说:「').at(-1)?.split('」').at(0) ?? ''
    const hit = answers[said]
    const commands = typeof hit === 'function' ? hit(body) : hit
    if (commands === undefined) return new Response('qa-unreachable', { status: 503 })
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ commands }) } }] }), { status: 200 })
  }) as never
  return {
    service: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) },
    fetchImpl,
    seen,
  }
}
