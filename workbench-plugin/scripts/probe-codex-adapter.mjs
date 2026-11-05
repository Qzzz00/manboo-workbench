#!/usr/bin/env node
/**
 * Codex 协议适配器的**真机自测**(2026-10-02,卡「Codex 协议适配器」)。
 *
 * 只在维护者自己这台机器上**手动**跑 —— 它会在 Codex 里真开一条新线程、真发一句话、真花一点额度。
 * 不挂任何定时、不进测试套件(`vitest` 只跑假对端那两个文件)。
 *
 * ```
 * node workbench-plugin/scripts/probe-codex-adapter.mjs
 * node workbench-plugin/scripts/probe-codex-adapter.mjs --cwd /Users/example/Code/x --text '只回复两个字:收到'
 * node workbench-plugin/scripts/probe-codex-adapter.mjs --name '加个导出 PDF'   # 新线程起个名字(卡标题那一格)
 * node workbench-plugin/scripts/probe-codex-adapter.mjs --resume <threadId>   # 接着某条对话捎一句
 * ```
 *
 * 跑完它会打三样,交接里就贴这三样:
 * ① `thread/list` 头几条(核 `id` 与 `sessionId` 是不是同一个、与 `~/.codex/sessions` 的 rollout 文件名对不对得上);
 * ② 新开那条的 threadId + 它回的那句;
 * ③ 这一条在 `thread/list` 里看不看得见(桌面 App 里能不能看到这条新线程,要人去 App 里再看一眼)。
 *
 * **`--name` 只对新开的那条管用,`--resume` 一律不起名** —— 改一条她自己那条对话的名字
 * 不是这张卡要的事(适配器里同一个分寸,见 `codex.ts` 的 `nameNewThread`)。
 *
 * **不读任何凭据**:app-server 走 ChatGPT 桌面版自己的登录态;它若反过来要我们刷新令牌,
 * 共用客户端回的是错误(见 `src/server/engine/adapters/codexAppServerClient.ts`)。
 *
 * 这个脚本故意**不** import TypeScript 源码(src 要先编译),而是照着适配器同一串调用自己走一遍 ——
 * 它核的是「协议这条路在这台机器上通不通」,适配器自己的分支由 `tests/engine-codex-*.test.ts` 核。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 `codexAppServerClient.ts` 的 `CODEX_APP_BUNDLE_BINARY` 同一个路径(那边是唯一的主人)。 */
const BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
/** 与 `codex.ts` 的 `CODEX_APPROVAL_POLICY` / `CODEX_SANDBOX_*` 同一个口径。 */
const APPROVAL_POLICY = 'never'
const SANDBOX_READ_ONLY = 'read-only'
const SANDBOX_WRITES = 'workspace-write'
/** 与 `codex.ts` 的 `CODEX_NAME_METHOD` 同一个方法名(查实自 codex-cli 0.159.2 的 `ClientRequest`)。 */
const NAME_METHOD = 'thread/name/set'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

function findBinary() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'codex'))) return join(dir, 'codex')
  }
  return existsSync(BUNDLED) ? BUNDLED : undefined
}

function open(binary) {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  const watchers = new Set()
  let id = 1
  let buffer = ''
  let gone

  const send = (message) => {
    if (gone !== undefined) throw new Error(`断了:${gone}`)
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const die = (why) => {
    if (gone !== undefined) return
    gone = why
    for (const [, flight] of pending) flight.reject(new Error(`断了:${why}`))
    pending.clear()
  }
  child.on('error', error => die(error.message))
  child.on('exit', code => die(`提前退出(${code})`))
  child.stdin.on('error', error => die(error.message))

  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (line === '') continue
      let message
      try { message = JSON.parse(line) }
      catch { continue }
      if (typeof message.method === 'string' && message.id !== undefined) {
        // 它反过来问我们:要批准一律不批;别的(含刷登录令牌)回错误,一个凭据字段都不给。
        const deny = message.method.endsWith('requestApproval')
        send(deny
          ? { jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `自测脚本不接 ${message.method}` } })
        continue
      }
      if (typeof message.method === 'string') {
        for (const watcher of [...watchers]) watcher(message)
        continue
      }
      const flight = pending.get(message.id)
      if (flight === undefined) continue
      pending.delete(message.id)
      if (message.error != null) flight.reject(new Error(JSON.stringify(message.error)))
      else flight.resolve(message.result)
    }
  })

  const request = (method, params = {}, ms = 15_000) => new Promise((resolve, reject) => {
    const mine = id++
    const timer = setTimeout(() => { pending.delete(mine); reject(new Error(`超时未回 ${method}`)) }, ms)
    pending.set(mine, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    send({ jsonrpc: '2.0', id: mine, method, params })
  })

  return {
    request,
    notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }),
    watch: (listen) => { watchers.add(listen); return () => watchers.delete(listen) },
    close: () => { die('自测脚本收工'); child.kill() },
  }
}

/**
 * 她那台机器上 `~/.codex/sessions/<年>/<月>/<日>/rollout-<时刻>-<UUID>.jsonl` 里的那些 UUID
 * (核我们登记表里的会话 id 与 `thread/list` 的 `id` 是不是同一个)。
 *
 * **全扫,不设上限**:月份是按名字升序列出来的,设了上限会在八九月就填满、
 * 今天那几条反而落在外面(10-02 第一版就栽在这儿,看着像「对不上」,其实是没扫到)。
 */
function rolloutIds() {
  const root = join(homedir(), '.codex', 'sessions')
  const found = new Set()
  const walk = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3) { walk(join(dir, entry.name), depth + 1); continue }
      const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(entry.name)
      if (match !== null) found.add(match[1])
    }
  }
  walk(root, 0)
  return found
}

/**
 * `~/.codex/session_index.jsonl` 里这条线程那一行(**只读**)。
 *
 * 这个文件每行 `{id, thread_name, updated_at}`,**只记有名字的线程** ——
 * 她的 ChatGPT App 侧栏与 `src/server/codexThreads.ts` 都按它找,所以起名有没有生效看它最直接。
 * 回 `{ lines, mtime, row }`:`row` 缺席 = 这条线程没进索引。
 */
function indexRowOf(threadId) {
  const file = join(homedir(), '.codex', 'session_index.jsonl')
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(one => one.trim() !== '')
    let row
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id === threadId) row = parsed
      }
      catch { /* 一行坏的不影响别的 */ }
    }
    return { lines: lines.length, mtime: statSync(file).mtime.toISOString(), row }
  }
  catch (error) {
    return { lines: 0, mtime: undefined, row: undefined, why: error.message }
  }
}

async function main() {
  const binary = findBinary()
  if (binary === undefined) {
    console.error('这台机器上找不到 codex(PATH 上没有,ChatGPT.app 自带的那份也没有)')
    process.exit(1)
  }
  const text = arg('text', '只回复两个字:收到')
  const cwd = arg('cwd', process.cwd())
  const resume = arg('resume', undefined)
  const name = arg('name', undefined)
  const writes = process.argv.includes('--writes')
  console.log(`① 用的二进制:${binary}`)

  const conn = open(binary)
  try {
    const init = await conn.request('initialize', { clientInfo: { name: 'probe-codex-adapter', version: '1' } })
    conn.notify('initialized')
    console.log(`   握手上了:codexHome=${init?.codexHome}`)

    // 名字变了它会反过来说一声(`thread/name/updated {threadId,threadName}`)。
    // **握手之后就挂上** —— 起名那一问的回声可能比下面那个盯轮次的看客挂上来得早。
    const renamed = []
    conn.watch((note) => {
      if (note.method !== 'thread/name/updated') return
      renamed.push(note.params ?? {})
      console.log(`   thread/name/updated threadId=${note.params?.threadId} threadName=「${note.params?.threadName ?? ''}」`)
    })

    const listed = await conn.request('thread/list', { limit: 5 })
    const rollouts = rolloutIds()
    console.log('② thread/list 头几条(核 id ↔ sessionId ↔ rollout 文件名):')
    for (const thread of listed?.data ?? []) {
      const same = thread.id === thread.sessionId ? 'id===sessionId' : `id≠sessionId(${thread.sessionId})`
      const onDisk = rollouts.has(thread.id) ? 'rollout 文件名上有这个 id' : 'rollout 里没找到(可能太老被清了)'
      console.log(`   ${thread.id}  ${same}  ${onDisk}  「${String(thread.preview ?? '').slice(0, 24)}」`)
    }

    if (process.argv.includes('--list-only')) {
      console.log('(--list-only:只核 id,不开新线程、不花额度)')
      return
    }

    // `--read <threadId>`:走适配器 `read` 那一条 —— resume 之后只看它说过的最后一句,
    // **不开 turn、不花额度**。核的是 `thread.turns[].items[]` 这个形状在真机上对不对。
    const readOnly = arg('read', undefined)
    if (readOnly !== undefined) {
      const resumed = await conn.request('thread/resume', { threadId: readOnly })
      const turns = resumed?.thread?.turns ?? []
      const said = turns.flatMap(turn => (turn.items ?? []).filter(item => item.type === 'agentMessage'))
      console.log(`③ 只读一眼 ${readOnly}:resume 回了 ${turns.length} 轮、其中 agentMessage ${said.length} 条`)
      for (const one of said.slice(-3)) console.log(`   phase=${one.phase} 「${String(one.text).slice(0, 40)}」`)
      const final = said.filter(one => one.phase === 'final_answer')
      console.log(`   取回的那一句:「${(final.length > 0 ? final : said).at(-1)?.text ?? '(它还一个字都没说)'}」`)
      if (said.length === 0) {
        const listed = await conn.request('thread/items/list', { threadId: readOnly, sortDirection: 'desc', limit: 50 })
        console.log(`   退路 thread/items/list 回了 ${listed?.data?.length ?? 0} 条(第一条 type=${listed?.data?.[0]?.item?.type})`)
      }
      return
    }

    let threadId = resume
    if (threadId === undefined) {
      const started = await conn.request('thread/start', {
        cwd,
        approvalPolicy: APPROVAL_POLICY,
        sandbox: writes ? SANDBOX_WRITES : SANDBOX_READ_ONLY,
      })
      threadId = started?.thread?.id
      console.log(`③ 新开了一条:threadId=${threadId}(cwd=${cwd},sandbox=${writes ? SANDBOX_WRITES : SANDBOX_READ_ONLY},approvalPolicy=${APPROVAL_POLICY})`)
      console.log(`   回包里 sessionId=${started?.thread?.sessionId}  approvalPolicy=${started?.approvalPolicy}  sandbox=${started?.sandbox}`)
      console.log(`   起名前 session_index.jsonl:${JSON.stringify(indexRowOf(threadId))}`)
      if (name !== undefined) {
        // 起名那一问(适配器里也在 `thread/start` 之后、`turn/start` 之前)。
        const named = await conn.request(NAME_METHOD, { threadId, name })
        console.log(`③′ ${NAME_METHOD} 回包:${JSON.stringify(named)}(照 schema 是空对象 ThreadSetNameResponse)`)
        console.log(`   起名后 session_index.jsonl:${JSON.stringify(indexRowOf(threadId))}`)
      }
    }
    else {
      await conn.request('thread/resume', { threadId })
      console.log(`③ 接着这条:threadId=${threadId}`)
    }

    const said = []
    let startedTurn
    const done = new Promise((resolve) => {
      conn.watch((note) => {
        const params = note.params ?? {}
        if (params.threadId !== undefined && params.threadId !== threadId) return
        if (note.method === 'turn/started') { startedTurn = params.turn?.id; console.log(`   turn/started turnId=${startedTurn}`) }
        if (note.method === 'item/completed' && params.item?.type === 'agentMessage') {
          said.push({ text: params.item.text, phase: params.item.phase })
          console.log(`   item/completed agentMessage phase=${params.item.phase} 「${params.item.text}」`)
        }
        if (note.method === 'error') console.log(`   error willRetry=${params.willRetry} ${JSON.stringify(params.error)}`)
        if (note.method === 'turn/completed') { console.log(`   turn/completed status=${params.turn?.status}`); resolve(params.turn) }
      })
    })

    const response = await conn.request('turn/start', { threadId, input: [{ type: 'text', text }] })
    console.log(`④ turn/start 回包:turnId=${response?.turn?.id} status=${response?.turn?.status}`)
    const turn = await Promise.race([done, new Promise(resolve => setTimeout(() => resolve(undefined), 180_000))])
    if (turn === undefined) { console.log('④ 三分钟没等到 turn/completed —— 它还在做,这一下只算「送到了」'); }

    const final = said.filter(one => one.phase === 'final_answer')
    const pool = final.length > 0 ? final : said
    console.log(`⑤ 它的回答:「${pool.at(-1)?.text ?? '(一个字都没说)'}」`)

    const again = await conn.request('thread/list', { limit: 5 })
    const listedOne = (again?.data ?? []).find(one => one.id === threadId)
    console.log(`⑥ 这条线程在 thread/list 里${listedOne === undefined ? '看不见' : `看得见(name=「${listedOne.name ?? listedOne.threadName ?? ''}」)`};桌面 App 里能不能看到要人去 App 里再看一眼(深链 codex://threads/${threadId})`)
    console.log(`⑦ 这一轮完了之后 session_index.jsonl:${JSON.stringify(indexRowOf(threadId))}`)
    console.log(`   thread/name/updated 一共收到 ${renamed.length} 条`)
  }
  finally { conn.close() }
}

await main()
