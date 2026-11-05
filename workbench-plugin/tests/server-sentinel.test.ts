// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSentinelService, type SentinelDeps } from '../src/server/sentinel.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sentinel-'))
  dirs.push(dir)
  return join(dir, 'nested', 'sentinel.json')
}

const T0 = 1_788_300_000

/** 可控探针:每一类传感器的"这一刻读到什么"都由测试摆布,不碰真文件/真网络/真进程。 */
function fakeDeps(over: Partial<SentinelDeps> = {}): SentinelDeps {
  return {
    statFile: async () => undefined,
    fetchHttp: async () => ({ status: 200, head: '' }),
    runCommand: async () => ({ ok: false, stdout: '' }),
    probePort: async () => false,
    ...over,
  }
}

describe('哨兵:四类传感器(command 类明确不做)', () => {
  it('认得 file / http / process / port 四类', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    for (const kind of ['file', 'http', 'process', 'port'] as const) {
      await expect(sentinel.add({ kind, target: 'x', note: '看着点' })).resolves.toMatchObject({ kind })
    }
  })

  it('★command 类被拒——审计结论:定时执行任意 shell 是这个插件不装的根本原因', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    await expect(sentinel.add({ kind: 'command' as never, target: 'rm -rf /', note: '不许' }))
      .rejects.toThrow(/command/)
  })

  it('note 是必填的——触发时要对 Ben 说一句人话,没话说的监视项没有意义', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    await expect(sentinel.add({ kind: 'file', target: '/tmp/x', note: '  ' })).rejects.toThrow(/note/)
  })

  it('target 为空被拒', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    await expect(sentinel.add({ kind: 'http', target: '', note: '看着点' })).rejects.toThrow(/target/)
  })
})

describe('哨兵:变化即触发,第一次只建基线', () => {
  it('★file:第一拍只记基线不触发,改动之后才触发,并附上 note', async () => {
    let stat: { mtime_ms: number, size: number } | undefined = { mtime_ms: 1000, size: 10 }
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ statFile: async () => stat }),
    })
    await sentinel.add({ kind: 'file', target: '/tmp/a.log', note: '构建日志有动静' })

    expect(await sentinel.tick()).toEqual([]) // 基线拍:不触发
    now += 60
    expect(await sentinel.tick()).toEqual([]) // 没变:不触发

    stat = { mtime_ms: 2000, size: 12 }
    now += 60
    const events = await sentinel.tick()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ agent: 'dsh', type: 'waiting', reason: 'idle_prompt', title: '构建日志有动静' })
    expect(events[0]!.session_id).toMatch(/^sentinel:/)
  })

  it('file:文件消失也是变化(有→无)', async () => {
    let stat: { mtime_ms: number, size: number } | undefined = { mtime_ms: 1000, size: 10 }
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ statFile: async () => stat }),
    })
    await sentinel.add({ kind: 'file', target: '/tmp/a.log', note: '文件没了要知道' })
    await sentinel.tick()
    stat = undefined
    now += 60
    expect(await sentinel.tick()).toHaveLength(1)
    expect(sentinel.list()[0]?.last_change).toMatch(/不存在/)
  })

  it('http:状态码或正文头变了才算变化', async () => {
    let reply = { status: 200, head: 'ok' }
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ fetchHttp: async () => reply }),
    })
    await sentinel.add({ kind: 'http', target: 'http://127.0.0.1:9/health', note: '健康检查变了' })
    await sentinel.tick()
    now += 60
    expect(await sentinel.tick()).toEqual([])
    reply = { status: 500, head: 'boom' }
    now += 60
    expect(await sentinel.tick()).toHaveLength(1)
    expect(sentinel.list()[0]?.last_change).toContain('500')
  })

  it('process:pgrep 模式,起来了/没了都是变化', async () => {
    let running = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(),
      now: () => now,
      deps: fakeDeps({ runCommand: async () => ({ ok: running, stdout: running ? '123\n' : '' }) }),
    })
    await sentinel.add({ kind: 'process', target: 'ffmpeg', note: '转码进程' })
    await sentinel.tick()
    running = true
    now += 60
    const events = await sentinel.tick()
    expect(events).toHaveLength(1)
    expect(sentinel.list()[0]?.last_change).toMatch(/在跑/)
  })

  it('port:TCP 通不通', async () => {
    let open = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    await sentinel.add({ kind: 'port', target: '127.0.0.1:3080', note: 'DSH 端口' })
    await sentinel.tick()
    open = true
    now += 60
    expect(await sentinel.tick()).toHaveLength(1)
    expect(sentinel.list()[0]?.last_change).toMatch(/通/)
  })

  it('★探针失败:如实记 error,不当成变化触发(D13 不编数)', async () => {
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(),
      now: () => now,
      deps: fakeDeps({ fetchHttp: async () => { throw new Error('连不上') } }),
    })
    await sentinel.add({ kind: 'http', target: 'http://127.0.0.1:9/x', note: '接口' })
    expect(await sentinel.tick()).toEqual([])
    now += 60
    expect(await sentinel.tick()).toEqual([])
    expect(sentinel.list()[0]?.error).toContain('连不上')
  })
})

describe('哨兵:间隔、冷却、次数上限、到期', () => {
  it('间隔没到不去探——省得每秒一轮把机器打满', async () => {
    let probes = 0
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(),
      now: () => now,
      deps: fakeDeps({ probePort: async () => { probes += 1; return true } }),
    })
    await sentinel.add({ kind: 'port', target: '3080', note: '端口', interval_sec: 30 })
    await sentinel.tick()
    expect(probes).toBe(1)
    now += 5
    await sentinel.tick()
    expect(probes).toBe(1) // 间隔没到
    now += 30
    await sentinel.tick()
    expect(probes).toBe(2)
  })

  it('★冷却期内的变化不再触发(照抄 sentinel 的语义,防铃声疲劳)', async () => {
    let open = false
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    await sentinel.add({ kind: 'port', target: '3080', note: '端口', interval_sec: 1, cooldown_sec: 600 })
    await sentinel.tick()
    open = true
    now += 10
    expect(await sentinel.tick()).toHaveLength(1)
    open = false
    now += 10
    expect(await sentinel.tick()).toEqual([]) // 冷却里
    open = true
    now += 600
    expect(await sentinel.tick()).toHaveLength(1) // 冷却过了
  })

  it('★次数上限用尽即收工,不再探也不再触发', async () => {
    let open = false
    let now = T0
    let probes = 0
    const sentinel = createSentinelService({
      file: tempFile(),
      now: () => now,
      deps: fakeDeps({ probePort: async () => { probes += 1; return open } }),
    })
    await sentinel.add({ kind: 'port', target: '3080', note: '端口', interval_sec: 1, cooldown_sec: 0, max_fires: 1 })
    await sentinel.tick()
    open = true
    now += 10
    expect(await sentinel.tick()).toHaveLength(1)
    const probesAfterFire = probes
    open = false
    now += 10
    expect(await sentinel.tick()).toEqual([])
    expect(probes).toBe(probesAfterFire) // 收工之后连探都不探
    expect(sentinel.list()[0]?.done).toBe(true)
  })

  it('★到期之后自己收工', async () => {
    let now = T0
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => true }),
    })
    await sentinel.add({
      kind: 'port', target: '3080', note: '端口', interval_sec: 1,
      expires_at: new Date((T0 + 100) * 1000).toISOString(),
    })
    await sentinel.tick()
    now += 200
    expect(await sentinel.tick()).toEqual([])
    expect(sentinel.list()[0]?.done).toBe(true)
    expect(sentinel.list()[0]?.last_change).toMatch(/到期/)
  })
})

describe('哨兵:落盘,重启不丢', () => {
  it('★加了监视项重建实例后还在,基线也在(重启不会白白重报一次)', async () => {
    const file = tempFile()
    const stat = { mtime_ms: 1000, size: 10 }
    const first = createSentinelService({ file, now: () => T0, deps: fakeDeps({ statFile: async () => stat }) })
    await first.add({ kind: 'file', target: '/tmp/a.log', note: '日志' })
    await first.tick()
    await first.flush()

    let now = T0 + 600
    const again = createSentinelService({ file, now: () => now, deps: fakeDeps({ statFile: async () => stat }) })
    await again.load()
    expect(again.list()).toHaveLength(1)
    expect(again.list()[0]?.note).toBe('日志')
    // 基线也跟着回来了:同一份文件没变,重启后不该凭空触发一次
    expect(await again.tick()).toEqual([])
  })

  it('文件不存在/写坏了 → 当空表,不抛(D13)', async () => {
    const sentinel = createSentinelService({
      file: join(tmpdir(), '绝不存在-sentinel.json'), now: () => T0, deps: fakeDeps(),
    })
    await sentinel.load()
    expect(sentinel.list()).toEqual([])
  })

  it('落盘是原子写(先写临时文件再 rename),内容可解析', async () => {
    const file = tempFile()
    const sentinel = createSentinelService({ file, now: () => T0, deps: fakeDeps() })
    await sentinel.add({ kind: 'port', target: '3080', note: '端口' })
    await sentinel.flush()
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { version: number, watches: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.watches).toHaveLength(1)
  })
})

describe('哨兵:取消一条', () => {
  it('★取消掉的监视项连同它那条会话一起收掉(不留一个永远黄着的点)', async () => {
    let now = T0
    let open = false
    const sentinel = createSentinelService({
      file: tempFile(), now: () => now, deps: fakeDeps({ probePort: async () => open }),
    })
    const watch = await sentinel.add({ kind: 'port', target: '3080', note: '端口', interval_sec: 1 })
    await sentinel.tick()
    open = true
    now += 10
    const fired = await sentinel.tick()
    const removed = await sentinel.remove(watch.id)

    expect(removed.ok).toBe(true)
    expect(sentinel.list()).toEqual([])
    // 收掉的是同一条会话
    expect(removed.event?.session_id).toBe(fired[0]?.session_id)
    expect(removed.event?.type).toBe('offline')
  })

  it('取消不存在的:如实回 false,不抛', async () => {
    const sentinel = createSentinelService({ file: tempFile(), now: () => T0, deps: fakeDeps() })
    expect((await sentinel.remove('没有这条')).ok).toBe(false)
  })
})
