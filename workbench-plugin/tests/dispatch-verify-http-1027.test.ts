// @vitest-environment node
/**
 * 交回闭环(2026-10-27,卡 t-bd1c04ed「交回之后的闭环归事务官」)——真实机红例:
 * t-d66412f5 Kimi 交回后卡停在「等你」、直接推给人,没人按验收条件核(c0253b 靠
 * 事务官 DSH 会话,会话不在就停摆)。这一份钉机制(CLI 手交回 → **产品**自己核;
 * 2026-10-29 入口归一后入口侧语义换命令表,本文件随退修 1 改写):
 *   ① 验收条件随中枢 dispatch 命令的 acceptance 落卡(命令带 → 落卡;没有 → 卡上如实留话);
 *   ② 交回即核验:过 → 通过回写(留言 + 挪「做完」);不过 → 退修给**同一执行者同一会话**
 *      (续跑,不另起作者),下一轮再核;没给条件 / 核不了 → 卡上如实说、留给人凭回执;
 *   ③ 接续句回指:「刚才那件,派给 X」= 中枢 reassign 命令(模型出 reassign,对题解析器在中枢里):
 *      同卡换负责人重派,**不新建**(t-a244fee0 红例)。
 * 受控替身:CLI 按仓库现状改 README;模型替身分两类(system 区分「理解中枢」/「交回核验」)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PAGE = { origin: 'http://127.0.0.1:3080' }
const NOW = Math.floor(Date.parse('2026-10-27T09:00:00.000Z') / 1000)

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  said: { session: string, text: string }[]
  server: WorkbenchServer
  projectId: string
  readme: () => string
  setReadme: (text: string) => void
}

/** 假 Mac:Kimi 命令行那只手真起「进程」(替身),模型替身按 system 分听懂/核验两路。 */
async function serve(model: { verify: 'pass' | 'fail-once' | 'down' }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-verify-'))
  dirs.push(dir)
  let n = 0
  // 真钟:回指那道「30 分钟窗」按真实时间判,固定钟会把刚建的卡滤掉。
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(Date.now() / 1000), newId: () => `t-${++n}` })
  const said: { session: string, text: string }[] = []
  let readme = '# 验收项目\n\n原始。\n'
  const projectDir = mkdtempSync(join(tmpdir(), 'wb-verify-repo-'))
  dirs.push(projectDir)
  let pid = 50000
  let failArmed = model.verify === 'fail-once'
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> =>
    req.op === 'send_text' ? { method: 'ax_value', submitted: true, new_conversation: 'x' } : { found: false, busy: false }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  let verifyCalls = 0
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { messages?: { role?: string, content?: string }[] }
    const system = String(body.messages?.[0]?.content ?? '')
    const saidText = String(body.messages?.at(-1)?.content ?? '')
    if (system.includes('交回核验')) {
      verifyCalls += 1
      if (model.verify === 'down') throw new Error('qa-down')
      const items = failArmed
        ? [{ condition: '第一行是「工作台验收」', met: true, evidence: '首行「工作台验收」' }, { condition: '文末有「验收人:验收员甲」一行', met: false, evidence: '' }]
        : [{ condition: '第一行是「工作台验收」', met: true, evidence: '首行「工作台验收」' }, { condition: '文末有「验收人:验收员甲」一行', met: true, evidence: '文末加「验收人:验收员甲」' }]
      failArmed = false
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 })
    }
    if (!system.includes('理解中枢')) throw new Error('qa-down')
    // 中枢那一路:模型按命令表出命令(键=「说:「」后、整句到尾,内容包里的旧话可能也带「说:「,取最后一段)。
    const quote = saidText.includes('说:「') ? saidText.slice(saidText.lastIndexOf('说:「') + 3).replace(/」$/u, '') : ''
    const commands = (list: Record<string, unknown>[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ commands: list }) } }] }), { status: 200 })
    // 带验收条件的那句 → dispatch to 小K + acceptance 落卡。
    if (quote.includes('交给小K') && quote.includes('做到什么算完')) {
      return commands([{ name: 'dispatch', new: { title: '把 README 第一行改成「工作台验收」' }, to: 'kimi', text: quote, acceptance: ['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'] }])
    }
    // 派活(不带验收条件)。
    if (quote.includes('交给小K')) {
      return commands([{ name: 'dispatch', new: { title: '把 README 第一行改成「工作台验收」' }, to: 'kimi', text: quote }])
    }
    // 接续句回指:同卡改派给 Codex(中枢 reassign 命令接;第一张卡是 t-1)。
    if (quote.includes('刚才那件')) {
      return commands([{ name: 'reassign', card_id: 't-1', to: 'codex' }])
    }
    // 其余(「把 README 第一行改成…」)= 只记一张卡,不派;派活由用例驱动 dispatchItem 扮演交代注入。
    return commands([{ name: 'note', title: quote, status: 'todo' }])
  }) as never
  const runCli = (cmd: { argv: readonly string[], cwd: string, logFile: string }) => {
    const resume = (() => { const i = cmd.argv.indexOf('--session'); return i >= 0 ? String(cmd.argv[i + 1]) : '' })()
    const lines = readme.split('\n')
    const prompt = cmd.argv.join(' ')
    if (prompt.includes('验收人:验收员甲')) lines.push('', '验收人:验收员甲')
    else if (lines[0] !== undefined && !lines[0].includes('工作台验收')) lines[0] = '工作台验收'
    else lines.push('', '验收人:验收员甲')
    readme = lines.join('\n')
    const sessionId = resume !== '' ? resume : `qa-kimi-${pid}`
    const doneWhat = /验收人\s*[:：]\s*验收员甲/.test(readme)
      ? '已改 README:首行「工作台验收」,文末加「验收人:验收员甲」。'
      : '已改 README:首行「工作台验收」。'
    writeFileSync(cmd.logFile, [
      JSON.stringify({ role: 'assistant', content: doneWhat }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: sessionId }),
    ].join('\n'))
    writeFileSync(cmd.logFile.replace(/\.jsonl$/, ''), '')
    return { pid: ++pid, exited: Promise.resolve({ code: 0 }) }
  }
  for (const family of ['kimi', 'codex', 'claude']) engine.registry.register((await import('../src/server/engine/adapters/cli.ts')).createCliAdapter(family as never, {
    resolveCli: () => ({ found: true, family: family as never, bin: 'kimi-qa', source: 'path' }),
    runCli, resultDir: dir, now: () => new Date(),
  }))
  const { createProjectsService } = await import('../src/server/projectsService.ts')
  const projects = createProjectsService({
    file: join(dir, 'projects.json'),
    exec: async () => ({ ok: false, stdout: '' }),
    listDir: async () => [],
    isRepo: async () => false,
    codexHome: join(dir, '.codex'),
    codexDeps: { listFiles: async () => [], readFirstLine: async () => undefined } as never,
    home: dir,
    scanRoots: [],
  })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW }),
    tickIntervalMs: 0, heartbeatMs: 0,
    tasks,
    projects,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    butlerSession: {
      open: async () => 'sess-v',
      say: async (session: string, text: string) => { said.push({ session, text }); return true },
    },
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl,
    dispatchRun: { pollMs: 30, leaseFile: join(dir, 'leases.json') },
  })
  started.push(server)
  if (projects.adopt === undefined) throw new Error('这台没接 adopt')
  const project = await projects.adopt({ name: '验收项目', path: projectDir })
  return { url: server.url, tasks, said, server, projectId: project.id, readme: () => readme, setReadme: (t) => { readme = t } }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...PAGE }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function waitFor(fn: () => Promise<unknown>, what: string, ms = 60000): Promise<never> {
  const until = Date.now() + ms
  for (;;) {
    if (await fn()) return undefined as never
    if (Date.now() > until) throw new Error(`超时:${what}`)
    await new Promise(r => setTimeout(r, 60))
  }
}

describe('交回闭环:验收条件落卡 → 交回即核验 → 退修同一执行者 → 通过回写', () => {
  it('① dispatch 命令带的「做到什么算完」落成卡上 acceptance(随命令落卡,一处落)', async () => {
    const h = await serve({ verify: 'pass' })
    await post(h.url, '/butler/item', { text: '交给小K把 README 第一行改成「工作台验收」,做到什么算完:第一行是「工作台验收」、文末有「验收人:验收员甲」一行', entrance: 'desktop' })
    const card = (await h.tasks.list()).tasks[0]
    expect(card?.acceptance).toEqual(['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'])
  })

  it('没有验收条件的派活:交回后如实说「没给验收条件,核不了」,卡留「等你」凭回执', async () => {
    const h = await serve({ verify: 'pass' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    expect(((await h.tasks.list()).tasks[0]?.acceptance ?? []).length).toBe(0)
    await h.tasks.update(id, { projectId: h.projectId })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    await waitFor(async () => {
      const card = (await h.tasks.list()).tasks.find(one => one.id === id)
      return card?.status === 'confirm' && (card.comments ?? []).some(one => one.by === 'butler')
    }, '交回 + 核验留言', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('confirm')
    expect((card?.comments ?? []).map(one => one.text).join('\n')).toContain('没给验收条件')
  })

  it('②③ 交回即核:fail-once → 自动退修同一执行者同一会话 → 二次交回通过 → 卡「做完」带事务官留言', async () => {
    const h = await serve({ verify: 'fail-once' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    // 事务官补验收条件 + 归项目(真机里这两样来自交代;这里驱动扮演事务官注入,产品负责核与退修)。
    await h.tasks.update(id, { projectId: h.projectId, acceptance: ['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'] })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    expect(started.ok).toBe(true)
    // 产品自己闭环:等卡到「做完」(核验通过那一步挪的)。
    await waitFor(async () => (await h.tasks.list()).tasks.find(one => one.id === id)?.status === 'done', '闭环后卡做完', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('done')
    expect(card?.round).toBe(2)
    // 同一执行者同一会话:两次 ledger 的 session 一致。
    expect(card?.links?.filter(one => one.agent === 'kimi')).toHaveLength(1)
    // 事务官的判词留言在卡上:先未过后通过。
    const verdicts = (card?.comments ?? []).map(one => one.text).filter(one => /验收(通过|未过)/u.test(one))
    expect(verdicts.some(one => one.includes('验收未过'))).toBe(true)
    expect(verdicts.some(one => one.includes('验收通过'))).toBe(true)
    expect(h.readme()).toContain('验收人:验收员甲')
  }, 100000)

  it('② 没给验收条件:交回后如实说「核不了」,卡留「等你」凭回执(不瞎核)', async () => {
    const h = await serve({ verify: 'pass' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    await h.tasks.update(id, { projectId: h.projectId })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    await waitFor(async () => {
      const card = (await h.tasks.list()).tasks.find(one => one.id === id)
      return card?.status === 'confirm' && (card.comments ?? []).some(one => one.by === 'butler')
    }, '交回 + 核验留言', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('confirm')
    expect((card?.comments ?? []).map(one => one.text).join('\n')).toContain('没给验收条件')
  })

  it('② 核验模型不在场:如实说「核不了(理解服务没接成)」,不冒充通过', async () => {
    const h = await serve({ verify: 'down' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    await h.tasks.update(id, { projectId: h.projectId, acceptance: ['第一行是「工作台验收」'] })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    await waitFor(async () => {
      const card = (await h.tasks.list()).tasks.find(one => one.id === id)
      return card?.status === 'confirm' && (card.comments ?? []).some(one => one.by === 'butler' && one.text.includes('核不了'))
    }, '交回 + 核不了留言', 20000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('confirm')
    expect((card?.comments ?? []).map(one => one.text).join('\n')).toContain('没接成')
  })
})

describe('接续句回指:「刚才那件,派给 X」= 中枢 reassign 命令,同卡换负责人重派,不新建(真机 t-a244fee0 红例)', () => {
  it('第二句回指原卡:同一张卡 id,负责人换成新的一家,卡总数不增', async () => {
    const h = await serve({ verify: 'pass' })
    const first = await post(h.url, '/butler/item', { text: '交给小K把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const firstId = String(first.body.id)
    const second = await post(h.url, '/butler/item', { text: '刚才那件,派给 Codex 去办', entrance: 'desktop' })
    expect(second.status).toBe(200)
    // 回包指回同一张卡(没有「新建第二张」);改派结果在卡上(回包不再带 redispatched 旗标)。
    expect(second.body).toMatchObject({ ok: true, id: firstId })
    const cards = (await h.tasks.list()).tasks
    expect(cards).toHaveLength(1)
    expect(cards[0]?.assignee).toBe('codex')
  })

  it('电话入口同一句子同一条路(同一个路由,不是第二套)', async () => {
    const h = await serve({ verify: 'pass' })
    const first = await post(h.url, '/butler/item', { text: '交给小K把 README 第一行改成「工作台验收」', source: 'call' })
    const firstId = String(first.body.id)
    const second = await post(h.url, '/butler/item', { text: '刚才那件,派给 Codex 去办', source: 'call' })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ ok: true, id: firstId })
    const cards = (await h.tasks.list()).tasks
    expect(cards).toHaveLength(1)
    expect(cards[0]?.assignee).toBe('codex')
  })
})
