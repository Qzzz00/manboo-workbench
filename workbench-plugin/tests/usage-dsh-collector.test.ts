import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createUsageCollector } from '../src/usage/collector.ts'

/**
 * DSH 会话日志采集(2026-09-15)。真机形态:`~/.dsh/sessions/<编码目录>/session-<uuid>/session.jsonl.zstd`,
 * 是**多帧追加**的 zstd——每次落盘各压一帧再 append(一份 420KB 的文件里有 756 帧),
 * `zlib.zstdDecompressSync` 整块喂只会解出第一帧。这里按真机方式造文件:逐段压缩再拼接。
 */
const header = (cwd: string, version = 0): string => JSON.stringify({ type: 'session', version, id: 'session-x', createdAt: 1789468204357, cwd })
/**
 * `id` 默认按 seq 生成,但**可以单独给**:迁移到 4 代时 seq 会重排,而消息自己的 `id`
 * 跨代不变(上游 `MessageBase.id`「跨每一个表示层都保留的稳定身份」)。两代并存那几个用例
 * 要的就是「同一条消息、不同的 seq、同一个 id」。
 */
const message = (seq: number, input: number, output: number, cacheRead = 0, id = `m${seq}`): string => JSON.stringify({
  type: 'assistant/message',
  seq,
  time: 1789468206067 + seq,
  data: { turn: 1, step: seq, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, id }, usage: { inputTokens: input, outputTokens: output, totalTokens: input + output + cacheRead, cacheReadTokens: cacheRead, reasoningTokens: 0 } },
})

function frames(...chunks: string[]): Buffer {
  return Buffer.concat(chunks.map(chunk => zstdCompressSync(Buffer.from(chunk, 'utf8'))))
}

let tmp: string | undefined
function home(): string {
  tmp = mkdtempSync(join(tmpdir(), 'usage-dsh-'))
  mkdirSync(join(tmp, '.claude/projects'), { recursive: true })
  mkdirSync(join(tmp, '.codex/sessions'), { recursive: true })
  mkdirSync(join(tmp, '.dsh/sessions'), { recursive: true })
  return tmp
}
function sessionDir(root: string, encoded: string, id: string): string {
  const dir = join(root, '.dsh/sessions', encoded, id)
  mkdirSync(dir, { recursive: true })
  return dir
}
afterEach(() => {
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  tmp = undefined
})

async function refreshed(root: string) {
  const collector = createUsageCollector({ home: root })
  await collector.refresh()
  const view = collector.view()
  if ('error' in view) throw new Error(view.error)
  return { collector, view }
}

describe('DSH 会话用量采集(scanDsh)', () => {
  it('多帧 zstd 与明文 jsonl 都认;来源标 dsh,项目按会话头 cwd 归属,会话键是目录名', async () => {
    const root = home()
    const zst = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-aaaa')
    // 一行被切在两帧之间也要能拼回来(真机 756 帧对 1091 行,帧与行不对齐)
    const line2 = message(2, 200, 20, 1000)
    writeFileSync(join(zst, 'session.jsonl.zstd'), frames(
      `${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(1, 100, 10)}\n`,
      line2.slice(0, 40),
      `${line2.slice(40)}\n`,
    ))
    const plain = sessionDir(root, '--Users-ben-Documents-GitHub-DouDou--', 'session-bbbb')
    writeFileSync(join(plain, 'session.jsonl'), `${header('/Users/example/Documents/GitHub/DouDou')}\n${message(1, 50, 5)}\n`)

    const { collector, view } = await refreshed(root)
    expect(view.sources.dsh).toEqual({ status: 'ok' })
    const day = view.days.find(d => d.date === '2026-09-15')
    expect(day?.by_source.dsh).toEqual({ input: 350, output: 35, cache_read: 1000, cache_write: 0 })
    expect(day?.by_project['desktop-workbench']).toEqual({ input: 300, output: 30, cache_read: 1000, cache_write: 0 })
    expect(day?.by_project.DouDou).toEqual({ input: 50, output: 5, cache_read: 0, cache_write: 0 })
    expect(day?.by_model['deepseek-v4-flash']?.input).toBe(350)
    expect(collector.sessionTotals(['dsh:session-aaaa', 'dsh:session-bbbb'])).toEqual({
      'dsh:session-aaaa': { input: 300, output: 30, cache_read: 1000, cache_write: 0 },
      'dsh:session-bbbb': { input: 50, output: 5, cache_read: 0, cache_write: 0 },
    })
  })

  it('游标按文件大小:没变不重读,追加了整份重解析且旧记录不重复计入', async () => {
    const root = home()
    const dir = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-cccc')
    const path = join(dir, 'session.jsonl.zstd')
    writeFileSync(path, frames(`${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(1, 100, 10)}\n`, `${message(2, 200, 20)}\n`))
    const collector = createUsageCollector({ home: root })
    await collector.refresh()
    await collector.refresh()
    const totals = () => {
      const view = collector.view()
      if ('error' in view) throw new Error(view.error)
      return view.days.find(d => d.date === '2026-09-15')?.by_source.dsh
    }
    expect(totals()).toEqual({ input: 300, output: 30, cache_read: 0, cache_write: 0 })
    appendFileSync(path, frames(`${message(3, 1000, 100)}\n`))
    await collector.refresh()
    expect(totals()).toEqual({ input: 1300, output: 130, cache_read: 0, cache_write: 0 })
    expect(collector.sessionTotals(['dsh:session-cccc'])['dsh:session-cccc']?.input).toBe(1300)
  })

  it('一份读不了/解不开的会话只让 dsh 标 partial 并计数,其余照常入账;下轮修好后回到 ok', async () => {
    const root = home()
    const good = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-good')
    writeFileSync(join(good, 'session.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(1, 100, 10)}\n`))
    const corrupt = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-corrupt')
    writeFileSync(join(corrupt, 'session.jsonl.zstd'), Buffer.from('this is not zstd at all'))
    const locked = sessionDir(root, '--Users-ben-Documents-GitHub-DouDou--', 'session-locked')
    const lockedPath = join(locked, 'session.jsonl')
    writeFileSync(lockedPath, `${header('/Users/example/Documents/GitHub/DouDou')}\n${message(1, 50, 5)}\n`)
    chmodSync(lockedPath, 0o000)

    const collector = createUsageCollector({ home: root })
    await collector.refresh()
    let view = collector.view()
    if ('error' in view) throw new Error(view.error)
    expect(view.sources.dsh).toEqual({ status: 'partial', note: '2 份会话文件读不了,已跳过' })
    expect(view.days[0]?.by_source.dsh).toEqual({ input: 100, output: 10, cache_read: 0, cache_write: 0 })
    expect(view.sources.claude).toEqual({ status: 'ok' })

    // 坏文件下轮再试(权限修好、写到一半的帧补齐都可能同尺寸),没修好就照旧如实标 partial
    await collector.refresh()
    view = collector.view()
    if ('error' in view) throw new Error(view.error)
    expect(view.sources.dsh?.status).toBe('partial')

    chmodSync(lockedPath, 0o644)
    writeFileSync(join(corrupt, 'session.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(9, 1, 1)}\n`))
    await collector.refresh()
    view = collector.view()
    if ('error' in view) throw new Error(view.error)
    expect(view.sources.dsh).toEqual({ status: 'ok' })
    expect(view.days[0]?.by_source.dsh).toEqual({ input: 151, output: 16, cache_read: 0, cache_write: 0 })
  })

  /**
   * 升到 0.1.7:会话文件从 `session.jsonl[.zstd]` 改叫 `session.v4.jsonl[.zstd]`,而且上游
   * 「迁移不移动、不覆盖、不删除任何已提交代际」—— 两代**同时**留在一个目录里(卡 U3)。
   */
  describe('★两代并存(0 → 4,卡 U3)', () => {
    it('★同一个目录里有 v4 就读 v4,不把两代算两遍', async () => {
      const root = home()
      const dir = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-mig')
      // 迁移后的样子:老文件逐字节留着,新内容只往 v4 里写。两代里同一条消息的 id 一样、seq 不一样。
      writeFileSync(join(dir, 'session.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(1, 100, 10)}\n`))
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench', 4)}\n${message(0, 100, 10, 0, 'm1')}\n${message(1, 200, 20, 0, 'm2')}\n`))
      const { view } = await refreshed(root)
      expect(view.sources.dsh).toEqual({ status: 'ok' })
      // 读的是 v4 那一份(300/30),不是 0 代那一份(100/10),更不是两代相加(400/40)
      expect(view.days.find(d => d.date === '2026-09-15')?.by_source.dsh)
        .toEqual({ input: 300, output: 30, cache_read: 0, cache_write: 0 })
    })

    it('★只有老文件的会话照旧读得到(没被打开过就还没迁移,不许因此归零)', async () => {
      const root = home()
      const dir = sessionDir(root, '--Users-ben-Documents-GitHub-DouDou--', 'session-old')
      writeFileSync(join(dir, 'session.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/DouDou')}\n${message(1, 70, 7)}\n`))
      const { view } = await refreshed(root)
      expect(view.days.find(d => d.date === '2026-09-15')?.by_source.dsh)
        .toEqual({ input: 70, output: 7, cache_read: 0, cache_write: 0 })
    })

    it('★会话跑着的时候被迁移:改读 v4,已经算过的不重复计入,新长出来的记上', async () => {
      // 这是升级当天真会发生的那一幕:上游是「打开某条会话时逐文件迁」,
      // 工作台的采集循环正跑着,上一轮读的还是 0 代。
      const root = home()
      const dir = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-live')
      writeFileSync(join(dir, 'session.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench')}\n${message(1, 100, 10)}\n`))
      const collector = createUsageCollector({ home: root })
      await collector.refresh()
      const totals = () => {
        const view = collector.view()
        if ('error' in view) throw new Error(view.error)
        return view.days.find(d => d.date === '2026-09-15')?.by_source.dsh
      }
      expect(totals()).toEqual({ input: 100, output: 10, cache_read: 0, cache_write: 0 })

      // 他点开了这条会话 → 上游发布 v4(同一条消息 m1 的 seq 被重排成 0),之后又答了一段只进 v4
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames(`${header('/Users/example/Documents/GitHub/desktop-workbench', 4)}\n${message(0, 100, 10, 0, 'm1')}\n${message(1, 400, 40, 0, 'm2')}\n`))
      await collector.refresh()
      // 不归零、不翻倍:m1 那条靠 message.id 认出来只算一次,新的 400/40 记上
      expect(totals()).toEqual({ input: 500, output: 50, cache_read: 0, cache_write: 0 })
      expect(collector.sessionTotals(['dsh:session-live'])['dsh:session-live']?.input).toBe(500)
    })

    it('目录里只有不规范的名字(临时文件、锁文件)→ 不读、不报错', async () => {
      const root = home()
      const dir = sessionDir(root, '--Users-ben-Documents-GitHub-desktop-workbench--', 'session-junk')
      writeFileSync(join(dir, 'session.lock'), 'pid')
      writeFileSync(join(dir, 'session.v4.jsonl.tmp'), 'half written')
      const { view } = await refreshed(root)
      expect(view.sources.dsh).toEqual({ status: 'ok' })
      expect(view.days.find(d => d.date === '2026-09-15')?.by_source.dsh).toBeUndefined()
    })
  })

  it('没有 ~/.dsh/sessions 时 dsh 标 error 带原因,不影响另外两家', async () => {
    const root = home()
    rmSync(join(root, '.dsh'), { recursive: true })
    const { view } = await refreshed(root)
    expect(view.sources.dsh?.status).toBe('error')
    expect(view.sources.dsh?.note).toMatch(/\.dsh\/sessions/)
    expect(view.sources.claude).toEqual({ status: 'ok' })
  })
})
