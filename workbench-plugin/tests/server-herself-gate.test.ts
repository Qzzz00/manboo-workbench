// @vitest-environment node
/**
 * 「等你确认」只认她本人、发版要她点头(2026-09-28,卡 BS;
 * 决策记录 2026-09-28 15:5x 第 2、3、4 条)。整段理由与那个还没关上的洞在 `src/server/herself.ts`。
 *
 * 这一份钉四件:
 *   ① 事务官带着**自己那把进程令牌**打这几个口 → 403,话里说清是谁被拒;
 *   ② 派出去的别家 / 随手一条 curl(既没有设备令牌、也没有浏览器痕迹)→ 403;
 *   ③ 她自己:页面 / 壳(浏览器痕迹)、电话工人(工人那把进程令牌)→ 过;
 *   ④ 令牌一把都没接进来(老实现)时**认不出就不认错**:事务官那把也当「认不出来的程序」,照样拒。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalGrants, createQuestionBroker } from '../src/server/butlerAsks.ts'
import { createApprovalBroker } from '../src/server/composer.ts'
import { ACTOR_TOKEN_HEADER, isDisplayStateWrite, mintActorTokens, whoIsAsking } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const TOKENS = mintActorTokens()

async function serve(withTokens = true) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-herself-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const approvals = createApprovalBroker()
  const questions = createQuestionBroker()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    tasks,
    approvals,
    approvalGrants: createApprovalGrants(),
    questions,
    ...(withTokens ? { actorTokens: TOKENS } : {}),
  })
  started.push(server)
  return { url: server.url, approvals, questions }
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
}

/** 这四个口。`/feature/ship` 在这台没接需求闭环的服务上会更早地回别的码,所以另测(见下)。 */
const ANSWER_PATHS = ['/approvals/answer', '/questions/answer', '/asks/voice'] as const

describe('「等你确认」只认她本人', () => {
  it('★事务官带着自己那把令牌 → 403,而且话里说清「事务官不能替你答」', async () => {
    const h = await serve()
    for (const path of ANSWER_PATHS) {
      const r = await post(h.url, path, { id: 'x', allow: true, item_id: 'x', said: '批' }, { [ACTOR_TOKEN_HEADER]: TOKENS.butler })
      expect(r.status).toBe(403)
      expect(String(r.body.error)).toContain('只有你本人能答')
      expect(String(r.body.error)).toContain('事务官')
    }
  })

  it('★派出去的别家 / 随手一条 curl(什么身份都不带)→ 403', async () => {
    const h = await serve()
    for (const path of ANSWER_PATHS) {
      expect((await post(h.url, path, { id: 'x', allow: true, item_id: 'x', said: '批' })).status).toBe(403)
    }
  })

  it('她自己:页面(Origin)、壳(壳 UA)、电话工人(工人那把令牌)都过得去这道门', async () => {
    const h = await serve()
    const asHer = [
      { origin: 'http://127.0.0.1:3080' },
      { 'user-agent': 'Mozilla/5.0 BenWorkbenchShell/1.2' },
      { [ACTOR_TOKEN_HEADER]: TOKENS.worker },
    ]
    for (const headers of asHer) {
      // 过了这道门就轮到那条路自己的判断(这里没有在等的,于是 404 / 409 / 400)—— 反正**不是 403**。
      const r = await post(h.url, '/asks/voice', { item_id: 't-1', said: '批' }, headers)
      expect(r.status).not.toBe(403)
    }
  })

  it('★发版只有她点头才走:事务官按 /feature/ship → 403,话里说清「按不下这一下」', async () => {
    const h = await serve()
    const r = await post(h.url, '/feature/ship', { id: 't-1' }, { [ACTOR_TOKEN_HEADER]: TOKENS.butler })
    expect(r.status).toBe(403)
    expect(String(r.body.error)).toContain('只有你点头才走')
  })

  it('需求目录里**别的**那几下事务官照旧做得了(拦的只有 ship 这一下)', async () => {
    const h = await serve()
    // 没接需求闭环的这台服务上,过了身份那道门就该落到那条路自己的判断上 —— 不是 403。
    const r = await post(h.url, '/feature/docs', { id: 't-1' }, { [ACTOR_TOKEN_HEADER]: TOKENS.butler })
    expect(r.status).not.toBe(403)
  })

  it('令牌一把都没接进来(老实现):认不出就不认错 —— 事务官那把也当程序调用,照样拒', async () => {
    const h = await serve(false)
    const r = await post(h.url, '/approvals/answer', { id: 'x', allow: true }, { [ACTOR_TOKEN_HEADER]: TOKENS.butler })
    expect(r.status).toBe(403)
  })
})

describe('whoIsAsking:令牌先认,伪造 Origin 也压不过令牌', () => {
  it('事务官同时伪造了页面的 Origin,认出来的仍然是事务官', () => {
    expect(whoIsAsking({
      headers: { [ACTOR_TOKEN_HEADER]: TOKENS.butler, origin: 'http://127.0.0.1:3080' },
      device: false,
      tokens: TOKENS,
    })).toBe('butler')
  })

  it('两把令牌各认各的;设备令牌次之;都没有才看浏览器痕迹', () => {
    expect(whoIsAsking({ headers: { [ACTOR_TOKEN_HEADER]: TOKENS.worker }, device: false, tokens: TOKENS })).toBe('worker')
    expect(whoIsAsking({ headers: {}, device: true, tokens: TOKENS })).toBe('device')
    expect(whoIsAsking({ headers: { origin: 'http://127.0.0.1:3080' }, device: false, tokens: TOKENS })).toBe('page')
    expect(whoIsAsking({ headers: {}, device: false, tokens: TOKENS })).toBe('unknown')
  })

  it('`Origin: null`(加了 sandbox 的自定义模块)不算页面', () => {
    expect(whoIsAsking({ headers: { origin: 'null' }, device: false, tokens: TOKENS })).toBe('unknown')
  })

  it('两把令牌不一样,而且都不落盘(每次现生)', () => {
    const a = mintActorTokens()
    const b = mintActorTokens()
    expect(a.butler).not.toBe(a.worker)
    expect(a.butler).not.toBe(b.butler)
  })
})

/**
 * ★ A11:改工作台上各模组显示的状态,只许事务官与她本人做
 * (2026-09-28 维护者拍板 +15:5x 第 1 条,卡 BS2 落地;`docs/盘点-模组显示状态谁能改-2026-09-28.md`)。
 *
 * 在这之前那份盘点的结论是:**本机任何程序都写得动任何一处** —— 派出去的 Codex / Claude
 * 在本机随手一条 curl 就能建卡、挪列、改进度、改布局、触发例程。这一份钉:
 *   ① 认不出来的程序打这一批写口 → 403,话里说清是谁能改、事务官该怎么带身份;
 *   ② 事务官带上那把进程令牌 → 过;她的页面 / 壳 / 配对设备 / 电话工人 → 过;
 *   ③ 报事实的那三个口(`/event`、`/hook/<哪一家>`、`/statusline`)不在这道门里,照旧敞着;
 *   ④ 读(GET)不在这道门里;
 *   ⑤ 这个进程没现生令牌时不判(认不出就不认错,同 `whoIsAsking`)。
 */
describe('★A11:改显示状态的口只认事务官与她本人', () => {
  /** 这一批都是「改显示状态」的写口(照那份盘点的表)。 */
  const DISPLAY_WRITES = [
    '/butler/item',
    '/task/t-1/move',
    '/dispatch/run',
    '/layout/act',
    '/note/add',
    '/routine/run',
    '/project/status',
    '/inbox/read',
    '/feature/branch',
    '/topic/confirm',
  ] as const

  it('★认不出来的程序(派出去的别家 / 随手一条 curl)→ 403,话里说清三方是谁、事务官怎么带身份', async () => {
    const h = await serve()
    for (const path of DISPLAY_WRITES) {
      const r = await post(h.url, path, { id: 't-1', text: '随便', to: 'doing' })
      expect(r.status, path).toBe(403)
      expect(String(r.body.error), path).toContain('认不出你是谁')
      expect(String(r.body.error), path).toContain('x-workbench-actor')
    }
  })

  it('★事务官带上那把进程令牌 → 过得去这道门;她的页面 / 壳 / 电话工人也过', async () => {
    const h = await serve()
    const asAllowed = [
      { [ACTOR_TOKEN_HEADER]: TOKENS.butler },
      { origin: 'http://127.0.0.1:3080' },
      { 'user-agent': 'Mozilla/5.0 BenWorkbenchShell/1.2' },
      { [ACTOR_TOKEN_HEADER]: TOKENS.worker },
    ]
    for (const headers of asAllowed) {
      // 过了这道门就轮到那条路自己的判断(这台服务好多块没接线,于是 404 / 400 / 409)—— 反正**不是 403**。
      const r = await post(h.url, '/note/add', { text: '记一句' }, headers)
      expect(r.status, JSON.stringify(headers)).not.toBe(403)
    }
  })

  it('★报事实的三个口不在这道门里:钩子与状态行照旧报得进来', async () => {
    const h = await serve()
    for (const path of ['/event', '/hook/claude', '/statusline']) {
      const r = await post(h.url, path, { agent: 'claude', session_id: 's-1', kind: 'turn_start' })
      expect(r.status, path).not.toBe(403)
    }
  })

  it('读不拦:同一条路的 GET 不经这道门', async () => {
    const h = await serve()
    const res = await fetch(`${h.url}/state`)
    expect(res.status).toBe(200)
    expect((await fetch(`${h.url}/dispatch/choices?item=t-1`)).status).not.toBe(403)
  })

  it('令牌一把都没接进来(老实现 / 用例):这道门不判 —— 认不出就不认错', async () => {
    const h = await serve(false)
    expect((await post(h.url, '/note/add', { text: '记一句' })).status).not.toBe(403)
  })
})

describe('isDisplayStateWrite:表里有哪些、没有哪些', () => {
  it('写方法 + 表里的路径才算', () => {
    expect(isDisplayStateWrite('POST', '/butler/item')).toBe(true)
    expect(isDisplayStateWrite('PUT', '/layout')).toBe(true)
    expect(isDisplayStateWrite('DELETE', '/note/n-1')).toBe(true)
    expect(isDisplayStateWrite('GET', '/butler/item')).toBe(false)
    expect(isDisplayStateWrite('HEAD', '/layout')).toBe(false)
  })

  it('报事实的口、座机那条信令、设备与安装那一摊都不在表里', () => {
    for (const path of ['/event', '/hook/codex', '/statusline', '/phone/event', '/call/start', '/ring/test', '/pair/start', '/credentials', '/update/apply', '/setup/run', '/diag/export']) {
      expect(isDisplayStateWrite('POST', path), path).toBe(false)
    }
  })

  it('挑手那条只读查询(`/dispatch/choices`)不在表里;真派活那三条在', () => {
    expect(isDisplayStateWrite('POST', '/dispatch/choices')).toBe(false)
    for (const path of ['/dispatch/run', '/dispatch/client', '/dispatch/api']) {
      expect(isDisplayStateWrite('POST', path), path).toBe(true)
    }
  })
})
