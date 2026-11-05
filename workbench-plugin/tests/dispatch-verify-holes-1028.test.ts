// @vitest-environment node
/**
 * 按产物核三个洞(2026-10-28,任务书「交回核验按产物核第一次真用的三个洞」)——
 * 真机红例 t-5dd56fa3(小K 改对了被判没改、退修没派出去卡直接 blocked 不说为什么):
 *   洞1 diff 类对**派发基线**比(dispatch.base_sha,退回 merge-base HEAD main,算不出 → unknown 不放行):
 *      执行者的规矩是提交并推分支再交回,交回那一刻树干净、对 HEAD 比永远「没有改动」(假阴性);
 *   洞2 模型指认的产物路径不存在、git 也不认识 → 按 basename 在 git ls-files + diff --name-only
 *      里找唯一匹配;多条 / 零条 → unknown「路径对不上」不放行;
 *   洞3 核验不过 → 退修派不出去,原因必须落在卡上(「退修没派出去:因为 …」),能换手按派活规矩换,
 *      不能的才留人 —— 不许再出现「卡同一秒 blocked、note 全空、人不知道为什么」。
 * 受控替身:CLI 手在**真 git 仓库**里改 README 并提交;模型替身分中枢(命令表)/ 核验两路
 * (2026-10-29 入口归一:入口不再本地认派发意图,建卡那句由中枢 note 命令出,派活由用例驱动)。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
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
const NOW = Math.floor(Date.parse('2026-10-28T09:00:00.000Z') / 1000)

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  server: WorkbenchServer
  projectId: string
  projectDir: string
  argvLog: string[][]
  head: () => Promise<string>
}

/** 假 Mac:Kimi 命令行手真起「进程」(替身),在真 git 仓库里干活;模型替身按 system 分听懂/核验两路。 */
async function serve(model: { verify: 'pass' | 'fail-once' | 'down' }, opts: { refuseResend?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-holes-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(Date.now() / 1000), newId: () => `t-${++n}` })
  const argvLog: string[][] = []
  // 真 git 仓库:执行者在这里改文件、提交(模拟「提交并推分支再交回」)。
  const projectDir = mkdtempSync(join(tmpdir(), 'wb-holes-repo-'))
  dirs.push(projectDir)
  git(projectDir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(projectDir, 'README.md'), '# 验收项目\n\n原始。\n', 'utf8')
  git(projectDir, ['add', '.'])
  git(projectDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  let pid = 60000
  let failArmed = model.verify === 'fail-once'
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> =>
    req.op === 'send_text' ? { method: 'ax_value', submitted: true, new_conversation: 'x' } : { found: false, busy: false }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { messages?: { role?: string, content?: string }[] }
    const system = String(body.messages?.[0]?.content ?? '')
    const saidText = String(body.messages?.at(-1)?.content ?? '')
    if (system.includes('交回核验')) {
      if (model.verify === 'down') throw new Error('qa-down')
      // 判词条数与卡上条件一一对应(从核验正文里现数),缺的那条按模式判 fail-once。
      const condText = saidText.split('验收条件(逐条核):')[1]?.split('\n执行者交回汇报:')[0] ?? ''
      const conditions = condText.split('\n')
        .map(line => /^\d+\.\s*(.+)$/u.exec(line.trim())?.[1])
        .filter((one): one is string => one !== undefined && one !== '')
      const fail = failArmed
      failArmed = false
      const items = conditions.map((condition) => {
        const people = condition.includes('验收人')
        if (fail && people) return { condition, met: false, evidence: '' }
        return {
          condition, met: true,
          evidence: people ? '文末加「验收人:验收员甲」' : '改了 README',
          ...(condition.includes('README') ? { artifact: { kind: 'diff', path: 'README.md' } } : {}),
        }
      })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 })
    }
    if (!system.includes('理解中枢')) throw new Error('qa-down')
    // 中枢那一路:模型按命令表出命令(键=「说:「」后、整句到尾;内容包里的旧话可能也带「说:「,取最后一段)。
    const quote = saidText.includes('说:「') ? saidText.slice(saidText.lastIndexOf('说:「') + 3).replace(/」$/u, '') : ''
    const commands = (list: Record<string, unknown>[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ commands: list }) } }] }), { status: 200 })
    // 这句只记一张卡、不派(派活与验收条件由用例驱动扮演交代注入,产品负责核与退修)。
    return commands([{ name: 'note', title: quote, status: 'todo' }])
  }) as never
  const runCli = (cmd: { argv: readonly string[], cwd: string, logFile: string }) => {
    argvLog.push([...cmd.argv])
    const prompt = cmd.argv.join(' ')
    const refuse = opts.refuseResend !== undefined && prompt.includes('验收未过')
    if (refuse) {
      // 假手这一拍「不许派」:进程没起来(替身规定的挡法,原因原句要在卡上找得到)。
      return { error: opts.refuseResend as string, exited: Promise.resolve({ code: 1 }) }
    }
    // 干活:改 README、**提交**(执行者的规矩:提交并推分支再交回),结果写进输出文件。
    // 每一轮都真落改动:核验的基线是「这一轮派发那一刻」,第二轮不再动文件就永远「没有改动」。
    let text = ''
    try { text = readFileSyncUtf8(join(cmd.cwd, 'README.md')) } catch { /* 首次 */ }
    const lines = text.split('\n')
    lines[0] = '# 工作台验收'
    if (!text.includes('验收人:验收员甲')) lines.push('', '验收人:验收员甲')
    lines.push('', `第 ${argvLog.length} 轮补记`)
    const next = lines.join('\n')
    writeFileSync(join(cmd.cwd, 'README.md'), next, 'utf8')
    const doneWhat = '做完了:改了 README,文末加「验收人:验收员甲」。'
    const exited = new Promise<{ code: number }>(resolveDelay => setTimeout(() => { resolveDelay({ code: 0 }) }, 150)).then(async (r) => {
      // 提交在「退出」那一拍做(延迟一拍,派发那一刻记的基线才是改之前的 HEAD;生产里执行者要跑几分钟,天然如此)。
      git(cmd.cwd, ['add', '.'])
      git(cmd.cwd, ['-c', 'user.email=k@k', '-c', 'user.name=k', 'commit', '-qam', `${doneWhat}(允许空提交,替身第二轮可能没新改动)`, '--allow-empty'])
      writeFileSync(cmd.logFile, [
        JSON.stringify({ role: 'assistant', content: doneWhat }),
        JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'qa-kimi-session-1' }),
      ].join('\n'))
      writeFileSync(cmd.logFile.replace(/\.jsonl$/, ''), '')
      return r
    })
    return { pid: ++pid, exited }
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
    isRepo: async () => true,
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
      say: async () => true,
    },
    model: { endpoint: async () => ({ baseUrl: 'http://x/v1', key: 'k', model: 'm', ready: true }) } as never,
    fetchImpl,
    dispatchRun: { pollMs: 30, leaseFile: join(dir, 'leases.json') },
  })
  started.push(server)
  if (projects.adopt === undefined) throw new Error('这台没接 adopt')
  const project = await projects.adopt({ name: '验收项目', path: projectDir })
  return {
    url: server.url, tasks, server, projectId: project.id, projectDir, argvLog,
    head: async () => await gitStdout(['rev-parse', 'HEAD'], projectDir),
  }
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

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd }, (err, stdout) => (err === null ? resolvePromise(stdout.trim()) : rejectPromise(err)))
  })
}

function readFileSyncUtf8(file: string): string {
  return readFileSync(file, 'utf8')
}

describe('洞1 端到端:执行者已提交、树干净,对派发基线核「动过」→ 通过,不叫人', () => {
  it('派发时记 dispatch.base_sha;交回那一刻 HEAD 已是执行者的提交,照样判「动过」', async () => {
    const h = await serve({ verify: 'pass' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    await h.tasks.update(id, { projectId: h.projectId, acceptance: ['改了 README'] })
    const baseBefore = await h.head()
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    expect(started.ok).toBe(true)
    await waitFor(async () => (await h.tasks.list()).tasks.find(one => one.id === id)?.status === 'done', '核验通过后卡做完', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('done')
    // 派发那一刻的基线记在卡上,是改之前的 HEAD。
    expect(card?.dispatch?.base_sha).toBe(baseBefore)
    // 执行者确实提交过(树干净、HEAD ≠ 基线)—— 假阴性红例的状态。
    expect(await h.head()).not.toBe(baseBefore)
    expect((card?.comments ?? []).map(one => one.text).join('\n')).toContain('验收通过')
  }, 100000)
})

describe('洞3:退修没派出去,原因必须落卡;派得出去 → 新一轮带退修要求', () => {
  it('★假手「不许派」→ 卡上留言含原因原句、卡不挂 doing / 无故 blocked(真机 t-5dd56fa3 红例;1029 第 4 步④:改卡回「等你确认」+ 恢复记录接着推)', async () => {
    const h = await serve({ verify: 'fail-once' }, { refuseResend: '不许派(测试替身规定的挡法)' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    await h.tasks.update(id, { projectId: h.projectId, acceptance: ['改了 README', '文末有「验收人:验收员甲」一行'] })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    expect(started.ok).toBe(true)
    // 等到事务官把「退修没派出去」那句落在卡上(第 4 步④:卡回「等你确认」,不再停进「卡住」)。
    await waitFor(async () => {
      const card = (await h.tasks.list()).tasks.find(one => one.id === id)
      return (card?.comments ?? []).some(one => one.by === 'butler' && one.text.includes('退修没派出去'))
    }, '退修被挡 + 原因落卡', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    const comments = (card?.comments ?? []).map(one => one.text).join('\n')
    // 原因原句在留言里找得到;核验判了什么(验收未过)也在卡上。
    expect(comments).toContain('不许派(测试替身规定的挡法)')
    expect(comments).toContain('验收未过')
    // 卡不是「无故」blocked:note / dispatch_block 说清了为什么。
    expect(String(card?.note ?? '')).toContain('不许派')
    // 没有僵尸的「在做 / 卡住」:退修没派出去,卡回「等你确认」,执行记录 recover 带 wakeAt 接着推。
    expect(card?.status).toBe('confirm')
    const record = await h.tasks.readExecution(id)
    expect(record?.phase).toBe('recovering')
    expect(record?.next?.kind).toBe('recover')
    expect(typeof record?.next?.wakeAt).toBe('number')
  }, 100000)

  it('★派得出去 → round+1,新一轮派发词带着退修要求给同一执行者同一会话', async () => {
    const h = await serve({ verify: 'fail-once' })
    const made = await post(h.url, '/butler/item', { text: '把 README 第一行改成「工作台验收」', entrance: 'desktop' })
    const id = String(made.body.id)
    await h.tasks.update(id, { projectId: h.projectId, acceptance: ['改了 README', '文末有「验收人:验收员甲」一行'] })
    if (h.server.dispatchItem === undefined) throw new Error('这台没露 dispatchItem')
    const started = await h.server.dispatchItem(id, { family: 'kimi', text: '把 README 第一行改成「工作台验收」', kind: 'code' })
    expect(started.ok).toBe(true)
    await waitFor(async () => (await h.tasks.list()).tasks.find(one => one.id === id)?.status === 'done', '二次交回核验通过卡做完', 60000)
    const card = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card?.status).toBe('done')
    // 新一轮:轮次 +1。
    expect(card?.round).toBe(2)
    // 两次起进程:第二轮的派发词带着退修要求(验收未过)与续跑会话号。
    expect(h.argvLog).toHaveLength(2)
    const second = h.argvLog[1]?.join(' ') ?? ''
    expect(second).toContain('验收未过')
    expect(second).toContain('--session')
    // 判词:先未过、后通过,都在卡上。
    const comments = (card?.comments ?? []).map(one => one.text).join('\n')
    expect(comments).toContain('验收未过')
    expect(comments).toContain('验收通过')
  }, 100000)
})
