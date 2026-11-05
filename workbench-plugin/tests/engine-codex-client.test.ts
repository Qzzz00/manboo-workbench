/**
 * `codex app-server` 那条 stdio JSON-RPC 的共用客户端(2026-10-02,卡「Codex 协议适配器」)。
 *
 * 用例全部对着**假 stdio 对端**跑:不起真进程、不碰 `~/.codex`、不读任何凭据。
 * 真机那条自测在 `workbench-plugin/scripts/probe-codex-adapter.mjs`(手动跑)。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CodexNotification, CodexStdioPeer } from '../src/server/engine/adapters/codexAppServerClient.ts'
import {
  CODEX_APP_BUNDLE_BINARY,
  CODEX_TIMEOUT_MS,
  CodexAppServerGone,
  codexAppServerLink,
  openCodexAppServer,
  resolveCodexBinary,
} from '../src/server/engine/adapters/codexAppServerClient.ts'

/** 假对端:记下我们写进去的每一行,想回什么回什么。 */
function fakePeer() {
  const written: Record<string, unknown>[] = []
  let onData: ((chunk: string) => void) | undefined
  let onGone: ((why: string) => void) | undefined
  let killed = false
  const peer: CodexStdioPeer = {
    send: (line) => {
      if (killed) throw new Error('已经杀掉了')
      written.push(JSON.parse(line) as Record<string, unknown>)
    },
    onData: (listen) => { onData = listen },
    onGone: (listen) => { onGone = listen },
    kill: () => { killed = true },
  }
  return {
    peer,
    written,
    killed: () => killed,
    /** 它吐一整行出来。 */
    emit: (message: unknown) => onData?.(`${JSON.stringify(message)}\n`),
    /** 它吐一段原样的字节(可以是半行)。 */
    feed: (chunk: string) => onData?.(chunk),
    /** 它没了。 */
    die: (why = '提前退出') => onGone?.(why),
    /** 我们发出去的那几个带 id 的请求。 */
    requests: () => written.filter(m => m.id !== undefined),
    notifications: () => written.filter(m => m.id === undefined),
  }
}

/** 握手:`initialize` 的回包一到就答 `initialized`,连接才算开好。 */
async function connected(fake: ReturnType<typeof fakePeer>) {
  const opening = openCodexAppServer(fake.peer, { clientName: 'test' })
  await vi.waitFor(() => expect(fake.requests()).toHaveLength(1))
  const init = fake.requests()[0]!
  fake.emit({ jsonrpc: '2.0', id: init.id, result: { userAgent: 'test/0.159.2' } })
  return await opening
}

describe('握手', () => {
  it('先 initialize 带 clientInfo,拿到回包再发 initialized 通知', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    expect(fake.requests()[0]).toMatchObject({
      jsonrpc: '2.0', method: 'initialize', params: { clientInfo: { name: 'test' } },
    })
    expect(fake.notifications()).toEqual([{ jsonrpc: '2.0', method: 'initialized', params: {} }])
    conn.close()
    expect(fake.killed()).toBe(true)
  })

  it('握手期间它就死了 → 抛 CodexAppServerGone(可重试)', async () => {
    const fake = fakePeer()
    const opening = openCodexAppServer(fake.peer, { clientName: 'test' })
    await vi.waitFor(() => expect(fake.requests()).toHaveLength(1))
    fake.die('提前退出')
    await expect(opening).rejects.toBeInstanceOf(CodexAppServerGone)
  })
})

describe('一问一答', () => {
  it('result 回来就 resolve,error 回来就 reject,原话带在消息里', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)

    const ok = conn.request('thread/list', { limit: 2 })
    await vi.waitFor(() => expect(fake.requests()).toHaveLength(2))
    const listed = fake.requests()[1]!
    expect(listed).toMatchObject({ method: 'thread/list', params: { limit: 2 } })
    fake.emit({ jsonrpc: '2.0', id: listed.id, result: { data: [{ id: 'T1' }] } })
    expect(await ok).toEqual({ data: [{ id: 'T1' }] })

    const bad = conn.request('thread/resume', { threadId: '没有这条' })
    await vi.waitFor(() => expect(fake.requests()).toHaveLength(3))
    fake.emit({ jsonrpc: '2.0', id: fake.requests()[2]!.id, error: { code: -32602, message: 'thread not found' } })
    await expect(bad).rejects.toThrow(/thread not found/)
    conn.close()
  })

  it('每个请求一个自己的 id,回包按 id 对上,不按顺序也认得', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    const first = conn.request('a')
    const second = conn.request('b')
    await vi.waitFor(() => expect(fake.requests()).toHaveLength(3))
    const [, one, two] = fake.requests() as [unknown, { id: unknown }, { id: unknown }]
    expect(one.id).not.toEqual(two.id)
    fake.emit({ jsonrpc: '2.0', id: two.id, result: 'B' })
    fake.emit({ jsonrpc: '2.0', id: one.id, result: 'A' })
    expect(await first).toBe('A')
    expect(await second).toBe('B')
    conn.close()
  })

  it('到了时限还没回包 → reject,**不**无限期挂着', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakePeer()
      const opening = openCodexAppServer(fake.peer, { clientName: 'test' })
      await vi.waitFor(() => expect(fake.requests()).toHaveLength(1), { interval: 1 })
      fake.emit({ jsonrpc: '2.0', id: fake.requests()[0]!.id, result: {} })
      const conn = await opening
      const caught = conn.request('turn/start', {})
        .then(() => new Error('不该回来:它一个回包都没给'))
        .catch((error: Error) => error)
      await vi.advanceTimersByTimeAsync(CODEX_TIMEOUT_MS.request + 10)
      expect((await caught).message).toMatch(/超时/)
      conn.close()
    }
    finally { vi.useRealTimers() }
  })

  it('连接已经死了之后再问 → 抛 CodexAppServerGone,在飞的那几问一起 reject', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    const flying = conn.request('turn/start', {}).catch((error: Error) => error)
    await vi.waitFor(() => expect(fake.requests()).toHaveLength(2))
    fake.die('被杀')
    expect(await flying).toBeInstanceOf(CodexAppServerGone)
    expect(conn.gone()).toMatch(/被杀/)
    await expect(conn.request('thread/list')).rejects.toBeInstanceOf(CodexAppServerGone)
  })
})

describe('通知', () => {
  it('不带 id 的消息分发给每个看客,退订之后不再给', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    const seen: CodexNotification[] = []
    const stop = conn.watch(note => seen.push(note))
    fake.emit({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'T1', turn: { id: 'U1' } } })
    stop()
    fake.emit({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'T1' } })
    expect(seen.map(n => n.method)).toEqual(['turn/started'])
    expect(seen[0]!.params).toEqual({ threadId: 'T1', turn: { id: 'U1' } })
    conn.close()
  })

  it('一个看客抛了,别的看客照样收得到', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    const seen: string[] = []
    conn.watch(() => { throw new Error('这个看客坏了') })
    conn.watch(note => seen.push(note.method))
    fake.emit({ jsonrpc: '2.0', method: 'turn/completed', params: {} })
    expect(seen).toEqual(['turn/completed'])
    conn.close()
  })

  it('坏行、半行、空行都跳过,不把连接搞死', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    const seen: string[] = []
    conn.watch(note => seen.push(note.method))
    fake.feed('这不是 JSON\n')
    fake.feed('{"jsonrpc":"2.0","meth')
    fake.feed('od":"turn/started","params":{}}\n\n')
    expect(seen).toEqual(['turn/started'])
    expect(conn.gone()).toBeUndefined()
    conn.close()
  })
})

describe('它反过来问我们(ServerRequest)', () => {
  it('要批准 → 一律 decline(没人在电脑前,挂着等人点才是真卡死)', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    fake.emit({
      jsonrpc: '2.0', id: 'S1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'T1', command: ['rm', '-rf', '/'] },
    })
    await vi.waitFor(() => expect(fake.written.some(m => m.id === 'S1')).toBe(true))
    expect(fake.written.find(m => m.id === 'S1')).toEqual({ jsonrpc: '2.0', id: 'S1', result: { decision: 'decline' } })
    conn.close()
  })

  it('改文件要批准 → 同样 decline', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    fake.emit({ jsonrpc: '2.0', id: 7, method: 'item/fileChange/requestApproval', params: {} })
    await vi.waitFor(() => expect(fake.written.some(m => m.id === 7)).toBe(true))
    expect(fake.written.find(m => m.id === 7)).toMatchObject({ result: { decision: 'decline' } })
    conn.close()
  })

  it('要我们刷新 ChatGPT 的登录令牌 → 回错误,**一个凭据字段都不给**', async () => {
    const fake = fakePeer()
    const conn = await connected(fake)
    fake.emit({ jsonrpc: '2.0', id: 9, method: 'account/chatgptAuthTokens/refresh', params: {} })
    await vi.waitFor(() => expect(fake.written.some(m => m.id === 9)).toBe(true))
    const answered = fake.written.find(m => m.id === 9) as { result?: unknown, error?: { code?: number, message?: string } }
    // 回包里只有「没这个方法」这一句,**没有 result**:一个令牌字段都没往回写。
    expect(answered.result).toBeUndefined()
    expect(Object.keys(answered).sort()).toEqual(['error', 'id', 'jsonrpc'])
    expect(Object.keys(answered.error ?? {}).sort()).toEqual(['code', 'message'])
    expect(answered.error?.code).toBe(-32601)
    conn.close()
  })
})

describe('一个长连接 + 断了重起', () => {
  it('连着用只起一次进程', async () => {
    const fakes: ReturnType<typeof fakePeer>[] = []
    const link = codexAppServerLink({
      clientName: 'test',
      spawnPeer: () => {
        const fake = fakePeer()
        fakes.push(fake)
        // 握手回包:等我们把 initialize 写进去再回。
        void vi.waitFor(() => expect(fake.requests()).toHaveLength(1))
          .then(() => fake.emit({ jsonrpc: '2.0', id: fake.requests()[0]!.id, result: {} }))
        return fake.peer
      },
    })
    const first = await link.open()
    const second = await link.open()
    expect(second).toBe(first)
    expect(fakes).toHaveLength(1)
    link.close()
    expect(fakes[0]!.killed()).toBe(true)
  })

  it('它死了 → 下一次 open 自己重起一条新的', async () => {
    const fakes: ReturnType<typeof fakePeer>[] = []
    const link = codexAppServerLink({
      clientName: 'test',
      spawnPeer: () => {
        const fake = fakePeer()
        fakes.push(fake)
        void vi.waitFor(() => expect(fake.requests()).toHaveLength(1))
          .then(() => fake.emit({ jsonrpc: '2.0', id: fake.requests()[0]!.id, result: {} }))
        return fake.peer
      },
    })
    const first = await link.open()
    fakes[0]!.die('崩了')
    const second = await link.open()
    expect(second).not.toBe(first)
    expect(fakes).toHaveLength(2)
    expect(second.gone()).toBeUndefined()
    link.close()
  })

  /**
   * ★ **重起之前把旧那个对端杀掉**(2026-10-04,卡「Codex 线程被占时换路」第 1 问的那一半)。
   *
   * 「它死了」不一定等于**那个进程没了**:`spawnCodexAppServerPeer` 里往 stdin 写出错
   * (EPIPE)也会叫 `onGone`,而那一下子进程可能还活着。`codex app-server` 活着就一直握着
   * 它加载过的那几条线程的写入锁(`~/.codex/thread-writer-locks/<threadId>.lock`,本机量过),
   * 于是新起的那一条永远 resume 不上同一条线程 —— 自己把自己挡在外面。
   */
  it('它说死了(进程可能还活着)→ 重起之前杀掉旧那个,不留一个握着线程锁的孤儿', async () => {
    const fakes: ReturnType<typeof fakePeer>[] = []
    const link = codexAppServerLink({
      clientName: 'test',
      spawnPeer: () => {
        const fake = fakePeer()
        fakes.push(fake)
        void vi.waitFor(() => expect(fake.requests()).toHaveLength(1))
          .then(() => fake.emit({ jsonrpc: '2.0', id: fake.requests()[0]!.id, result: {} }))
        return fake.peer
      },
    })
    await link.open()
    fakes[0]!.die('它的 stdin 已经关了')
    expect(fakes[0]!.killed()).toBe(false)
    await link.open()
    expect(fakes[0]!.killed()).toBe(true)
    link.close()
  })
})

describe('二进制在哪(设计文档第六节:写死的那个路径早就不存在了)', () => {
  it('ChatGPT.app 自带的那一份在 codex-cli/bin/codex', () => {
    expect(CODEX_APP_BUNDLE_BINARY).toBe('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  })

  it('这条接缝只有一个主人:额度那条、派活那条、送话那条认同一个常量', async () => {
    const [quota, dispatch] = await Promise.all([
      import('../src/quota/codexAppServer.ts'),
      import('../src/server/agentDispatch.ts'),
    ])
    expect(quota.CODEX_APP_BUNDLE_BINARY).toBe(CODEX_APP_BUNDLE_BINARY)
    expect(dispatch.CODEX_BUNDLED).toBe(CODEX_APP_BUNDLE_BINARY)
    expect(quota.resolveCodexBinary).toBe(resolveCodexBinary)
  })

  it('PATH 上有就用 PATH 上那个;没有退回 app 自带;两个都没有仍回 codex', () => {
    const onPath = (file: string) => file === '/opt/homebrew/bin/codex'
    expect(resolveCodexBinary('/usr/bin:/opt/homebrew/bin', onPath)).toBe('codex')
    expect(resolveCodexBinary('/usr/bin', file => file === CODEX_APP_BUNDLE_BINARY)).toBe(CODEX_APP_BUNDLE_BINARY)
    expect(resolveCodexBinary('/usr/bin', () => false)).toBe('codex')
    expect(resolveCodexBinary(undefined, () => false)).toBe('codex')
  })
})
