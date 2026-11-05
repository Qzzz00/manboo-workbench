// @vitest-environment node
/**
 * **Claude 桌面走跨会话 socket 送话**(2026-10-02,`docs/设计-一条引擎替八条管线-2026-10-02.md` 第二节 Claude 那一行)。
 *
 * 这一组用例把真机上验过的那条路钉住:假的 `~/.claude/sessions/*.json` 登记表 + 真的 unix socket
 * (`net.createServer` 开在临时路径)+ 假的会话记录文件。**不碰窗口、不读 `.key`、不开任何 App**。
 *
 * 真机自测见 `scripts/probe-claude-adapter.mjs` 与 `docs/交接-1002-Claude-socket适配器.md`。
 */
import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import type { ClaudeAdapterDeps } from '../src/server/engine/adapters/claude.ts'
import {
  CLAUDE_FROM,
  CLAUDE_HELD_WHY,
  CLAUDE_NOT_OPEN_WHY,
  CLAUDE_NO_NEW_WHY,
  CLAUDE_NO_PRESS_WHY,
  CLAUDE_NO_TRANSCRIPT_WHY,
  claudeMessageLine,
  claudePrefixOf,
  claudeSessionOpen,
  createClaudeAdapter,
  readClaudeSockets,
} from '../src/server/engine/adapters/claude.ts'

const SID = 'aceefe64-6d3a-4f88-9e06-f8f7080616d6'
const HOST_SID = 'local_abeae068-d2fc-4ba2-8985-adbb35be0245'
/** 登记表里混一份 `.key`:里头这个 id **绝不许**出现在结果里(`.key` 一个字节都不读)。 */
const KEY_DECOY = 'from-the-key-file'

function job(one: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    family: 'claude',
    kind: 'answer',
    target: { kind: 'session', sessionId: SID },
    text: '就按第二版来',
    expect: 'ack',
    ...one,
  }
}

/** 送之前就在记录里的那两句用这个时刻(一小时前):免得「新冒出来的回话」把旧的那句认成新的。 */
const OLD = '2026-10-02T01:00:00.000Z'

const sayLine = (text: string, at: string = new Date().toISOString()): string => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  timestamp: at,
})

const askLine = (text: string, at: string = new Date().toISOString()): string => JSON.stringify({
  type: 'user',
  origin: { kind: 'human' },
  message: { role: 'user', content: text },
  timestamp: at,
})

/**
 * 工作台送进去的那一句,**到了对方那里长这样**(2026-10-02 在本机 78 份记录文件里查实):
 * 一条 `type:'user'`、`isMeta:true`、`origin.kind:'peer'` 的记录,正文是
 * 「Another Claude session sent a message: <cross-session-message from=…>…」。
 * 所以 `sessionSaid.createSaidInTranscript` 那份「她说的」里**看不到它**(`claudeAsk` 按 `isMeta` / `origin` 滤掉了),
 * 适配器必须自己认这一类行 —— 这一条用例就是钉这件事的。
 */
const peerLine = (text: string): string => JSON.stringify({
  type: 'user',
  isMeta: true,
  origin: { kind: 'peer', from: CLAUDE_FROM, hostInjected: true },
  message: {
    role: 'user',
    content: `Another Claude session sent a message:\n<cross-session-message from="${CLAUDE_FROM}" name="工作台">\n${text}\n</cross-session-message>`,
  },
  timestamp: new Date().toISOString(),
})

/**
 * **对方正忙的时候**是另一种落法(2026-10-02 真机那一跑拿到的原样一行,见 `docs/交接-1002-Claude-socket适配器.md`):
 * 收下了、排进队列,记录文件里是一条 `type:'queue-operation'` + `operation:'enqueue'`,`content` 是我们送的那句原文;
 * 要等它这一轮说完才变成上面那条 `user` / `peer` 记录。**排进队列就是送到了**,不能报成「没核上」。
 */
const enqueueLine = (text: string): string => JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: new Date().toISOString(),
  sessionId: SID,
  content: text,
})

interface Fake {
  claudeHome: string
  transcript: string
  socketPath: string
  /** socket 上收到的整行(NDJSON,已去掉换行)。 */
  got: string[]
  append: (...lines: string[]) => Promise<void>
  close: () => Promise<void>
}

interface FakeOptions {
  /** 登记表里写不写这条会话(不写 = 那条 Claude 会话没开着)。 */
  register?: boolean
  /** 登记表里的路径带不带 `uds:` 前缀(真机上两种都见过)。 */
  udsPrefix?: boolean
  /** 开不开 socket 服务(不开 = 文件在、连不上)。 */
  listen?: boolean
  /** 收到一行之后往记录文件里补什么(模拟对方 `crossSessionInbound: accept` 收下)。 */
  onLine?: (line: string, append: (...lines: string[]) => Promise<void>) => Promise<void> | void
}

async function fake(options: FakeOptions = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-claude-'))
  const claudeHome = join(dir, 'claude')
  await mkdir(join(claudeHome, 'sessions'), { recursive: true })
  const socketPath = join(dir, 's.sock')
  const transcript = join(dir, 'tr.jsonl')
  await writeFile(transcript, `${[askLine('先看一眼', OLD), sayLine('看完了', OLD)].join('\n')}\n`, 'utf8')

  const append = async (...lines: string[]): Promise<void> => {
    const now = await readFile(transcript, 'utf8')
    await writeFile(transcript, `${now}${lines.join('\n')}\n`, 'utf8')
  }

  if (options.register !== false) {
    await writeFile(join(claudeHome, 'sessions', '86279.json'), JSON.stringify({
      pid: process.pid,
      sessionId: SID,
      version: '2.1.286',
      peerProtocol: 1,
      entrypoint: 'claude-desktop',
      hostSessionId: HOST_SID,
      messagingSocketPath: options.udsPrefix === true ? `uds:${socketPath}` : socketPath,
      name: '接手统筹',
      status: 'idle',
    }), 'utf8')
  }
  // 同目录的 `.key`:只要结果里没有 KEY_DECOY,就证明没碰过它。
  await writeFile(join(claudeHome, 'sessions', '86279.deadbeef.key'), JSON.stringify({
    pid: 1, sessionId: KEY_DECOY, messagingSocketPath: '/tmp/never.sock',
  }), 'utf8')

  const got: string[] = []
  let server: Server | undefined
  if (options.listen !== false) {
    server = createServer(socket => {
      let buffer = ''
      socket.on('data', chunk => {
        buffer += String(chunk)
        for (;;) {
          const at = buffer.indexOf('\n')
          if (at < 0) break
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          if (line.trim() === '') continue
          got.push(line)
          void options.onLine?.(line, append)
        }
      })
    })
    const listening = server
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject)
      listening.listen(socketPath, () => { resolve() })
    })
  }
  else {
    // 文件在、没人听:连上去就是 ECONNREFUSED(残留的登记 + 残留的 socket 文件)。
    await writeFile(socketPath, '', 'utf8')
  }

  return {
    claudeHome,
    transcript,
    socketPath,
    got,
    append,
    close: async () => {
      if (server !== undefined) await new Promise<void>(resolve => { server.close(() => { resolve() }) })
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function adapterOf(one: Fake, over: ClaudeAdapterDeps = {}) {
  return createClaudeAdapter({
    claudeHome: one.claudeHome,
    locate: async (agent, sessionId) => agent === 'claude' && sessionId === SID
      ? { agent: 'claude', session_id: SID, file: one.transcript, format: 'claude-transcript' as const }
      : undefined,
    confirmMs: 800,
    confirmStepMs: 10,
    replyMs: 800,
    ...over,
  })
}

describe('Claude socket 适配器(登记表 → socket → 记录文件核)', () => {
  it('★登记表只读 .json:同目录的 .key 一个字节都不碰', async () => {
    const one = await fake()
    try {
      const rows = await readClaudeSockets(one.claudeHome)
      expect(rows.map(row => row.sessionId)).toEqual([SID])
      expect(rows.map(row => row.sessionId)).not.toContain(KEY_DECOY)
      expect(rows[0]).toMatchObject({ socket: one.socketPath, hostSessionId: HOST_SID, name: '接手统筹' })
    }
    finally { await one.close() }
  })

  it('登记表里的 `uds:` 前缀剥掉(真机上两种写法都见过)', async () => {
    const one = await fake({ udsPrefix: true })
    try {
      const rows = await readClaudeSockets(one.claudeHome)
      expect(rows[0]?.socket).toBe(one.socketPath)
    }
    finally { await one.close() }
  })

  it('能力:有登记 + socket 在 → 送话 / 读回答 / 开到某一段 真;点键 / 停止 假', async () => {
    const one = await fake()
    try {
      expect(await adapterOf(one).capabilities()).toEqual({
        // 协议只送字:点键 / 看按权限弹框 / 写进那个提问面板都让引擎换窗口那条路(2026-10-02 契约加的两格)。
        open: true, send: true, read: true, press: false, approve: false, writeAsk: false, stop: false, openSession: true,
      })
    }
    finally { await one.close() }
  })

  it('能力:一条都没登记 → 送话 / 读回答 全假(这台机器上 Claude 桌面没开着)', async () => {
    const one = await fake({ register: false })
    try {
      expect(await adapterOf(one).capabilities()).toMatchObject({ send: false, read: false, openSession: false })
    }
    finally { await one.close() }
  })

  it('★那条会话没开着(登记表里找不到)→ not_sent + 人话,一个字节都没往 socket 写,**不去开窗找**', async () => {
    const one = await fake({ register: false })
    try {
      const result = await adapterOf(one).run(job())
      expect(result).toMatchObject({ delivered: 'not_sent', via: 'protocol', evidence: 'none', why: CLAUDE_NOT_OPEN_WHY })
      // ★ 2026-10-23(卡「捎话留言等它醒」):带上 `sessionClosed` 那一格 —— 引擎据此排队等它醒,而不是照「没送成」丢。
      expect(result.sessionClosed).toBe(true)
      expect(result.unsupported).toBeUndefined()
      expect(one.got).toEqual([])
    }
    finally { await one.close() }
  })

  it('socket 文件在、没人听(残留)→ not_sent + 同一句人话,同一格', async () => {
    const one = await fake({ listen: false })
    try {
      const result = await adapterOf(one).run(job())
      expect(result).toMatchObject({ delivered: 'not_sent', why: CLAUDE_NOT_OPEN_WHY, sessionClosed: true })
    }
    finally { await one.close() }
  })

  it('★claudeSessionOpen:登记表 + socket 都在 → true;登记表里没有 → false', async () => {
    const one = await fake()
    try {
      expect(await claudeSessionOpen(one.claudeHome, SID)).toBe(true)
      expect(await claudeSessionOpen(one.claudeHome, 'local_not_this')).toBe(false)
    }
    finally { await one.close() }
  })

  it('★送到了:socket 上收到一行 NDJSON(带前缀 / from / msgV),记录文件多出那句 → confirmed + transcript', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(peerLine(sent.message.content))
    } })
    try {
      const result = await adapterOf(one).run(job())
      expect(result).toMatchObject({
        delivered: 'confirmed', evidence: 'transcript', via: 'protocol', sessionId: SID,
      })
      expect(result.why).toBeUndefined()
      expect(one.got).toHaveLength(1)
      expect(JSON.parse(one.got[0]!)).toEqual({
        type: 'user',
        message: { role: 'user', content: `${claudePrefixOf('answer')} 就按第二版来` },
        from: CLAUDE_FROM,
        msgV: 1,
      })
      // 线协议只有这一行:macOS 上验过不带 auth 行也直达,所以**不读 `.key`、不发 auth**。
      expect(one.got[0]).toBe(claudeMessageLine(job()).trim())
    }
    finally { await one.close() }
  })

  it('★对方正忙:记录里是 queue-operation/enqueue(真机那一种)→ 照样 confirmed', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(enqueueLine(sent.message.content))
    } })
    try {
      const result = await adapterOf(one).run(job())
      expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'transcript', sessionId: SID })
    }
    finally { await one.close() }
  })

  it('排进去又被撤掉的(operation 不是 enqueue)不算送到', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(JSON.stringify({ type: 'queue-operation', operation: 'remove', sessionId: SID, content: sent.message.content }))
    } })
    try {
      expect((await adapterOf(one).run(job())).delivered).toBe('unconfirmed')
    }
    finally { await one.close() }
  })

  it('★写成功、记录里没出现 → unconfirmed + 「可能扣在待批准里」(一个字不说成送到了)', async () => {
    const one = await fake()
    try {
      const result = await adapterOf(one).run(job())
      expect(result).toMatchObject({ delivered: 'unconfirmed', evidence: 'receipt', via: 'protocol', why: CLAUDE_HELD_WHY })
      expect(result.why).toContain('crossSessionInbound')
      expect(one.got).toHaveLength(1)
    }
    finally { await one.close() }
  })

  it('这条会话在本机没有记录文件 → unconfirmed + 「核不了」(不冒充 confirmed)', async () => {
    const one = await fake()
    try {
      const result = await adapterOf(one, { locate: async () => undefined }).run(job())
      expect(result).toMatchObject({ delivered: 'unconfirmed', evidence: 'receipt', why: CLAUDE_NO_TRANSCRIPT_WHY })
    }
    finally { await one.close() }
  })

  it('★expect:reply → 等记录文件里下一条 assistant 文本,拿到当回话', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(peerLine(sent.message.content))
      await append(sayLine('第二版已经改好了'))
    } })
    try {
      const result = await adapterOf(one).run(job({ expect: 'reply' }))
      expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'transcript', reply: '第二版已经改好了' })
    }
    finally { await one.close() }
  })

  it('expect:reply 但它只收下没回话 → confirmed(送到了)+ 说清还没回', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(peerLine(sent.message.content))
    } })
    try {
      const result = await adapterOf(one).run(job({ expect: 'reply' }))
      expect(result).toMatchObject({ delivered: 'confirmed', evidence: 'transcript' })
      expect(result.reply).toBeUndefined()
      expect(result.why).toBeTruthy()
    }
    finally { await one.close() }
  })

  it('★捎话 / 派活各有自己的前缀,都写明「她本人经工作台」', async () => {
    const one = await fake()
    try {
      await adapterOf(one).run(job({ kind: 'relay', text: '顺带把封面也换掉' }))
      const sent = JSON.parse(one.got[0]!) as { message: { content: string } }
      expect(sent.message.content).toBe(`${claudePrefixOf('relay')} 顺带把封面也换掉`)
      expect(sent.message.content).toContain('她本人经工作台')
    }
    finally { await one.close() }
  })

  it('★点键 / 写提问面板 / 按停止:socket 送不了 → unsupported(引擎换窗口路)', async () => {
    const one = await fake()
    try {
      for (const kind of ['press', 'write_ask', 'stop'] as const) {
        const result = await adapterOf(one).run(job({ kind, expect: 'none' }))
        expect(result).toMatchObject({ delivered: 'not_sent', unsupported: true, why: CLAUDE_NO_PRESS_WHY })
      }
      expect(one.got).toEqual([])
    }
    finally { await one.close() }
  })

  it('★派活 + 新开一条:Claude 桌面没有这条协议 → unsupported(引擎换窗口路)', async () => {
    const one = await fake()
    try {
      const result = await adapterOf(one).run(job({ kind: 'dispatch', target: { kind: 'new' } }))
      expect(result).toMatchObject({ delivered: 'not_sent', unsupported: true, why: CLAUDE_NO_NEW_WHY })
      expect(one.got).toEqual([])
    }
    finally { await one.close() }
  })

  it('派活到**指名的**一条会话还是走 socket(只有「新开」不行)', async () => {
    const one = await fake({ onLine: async (line, append) => {
      const sent = JSON.parse(line) as { message: { content: string } }
      await append(peerLine(sent.message.content))
    } })
    try {
      const result = await adapterOf(one).run(job({ kind: 'dispatch', text: '把导出 PDF 加上' }))
      expect(result.delivered).toBe('confirmed')
    }
    finally { await one.close() }
  })

  it('一个字都没有:不送(空话送进去只会让她以为答过了)', async () => {
    const one = await fake()
    try {
      const result = await adapterOf(one).run(job({ text: '   ' }))
      expect(result.delivered).toBe('not_sent')
      expect(one.got).toEqual([])
    }
    finally { await one.close() }
  })
})
