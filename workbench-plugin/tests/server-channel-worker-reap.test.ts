// @vitest-environment node
/**
 * 起新工人前先收上一轮的(2026-10-10,通话组件孤儿进程;server/channelWorkerReap.ts)。
 *
 * 只收认得出的:命令行确是 `channel-worker/src/main.ts`,父进程是 1 或不是这个工作台。
 * 文件只在临时目录里读写;进程表、kill、等待全是注入的,不碰真进程。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHANNEL_WORKER_MAIN_MARK,
  REAP_TERM_GRACE_MS,
  createChannelWorkerReaper,
  defaultChannelWorkerPidFile,
  parseProcessTable,
  staleChannelWorkers,
} from '../src/server/channelWorkerReap.ts'
import type { ProcessRow } from '../src/server/channelWorkerReap.ts'
import { LAUNCHING_NOTE, createChannelWorkerService } from '../src/server/channelWorker.ts'

const DSH = '/Users/x/.dsh'
const SELF = 6983
const MAIN = `/Users/x/.dsh/node/bin/node ${DSH}/channel-worker/src/main.ts`

describe('默认位置', () => {
  it('进程号文件在 DSH_HOME 的 workbench 目录下;没设 DSH_HOME 就是 ~/.dsh', () => {
    expect(defaultChannelWorkerPidFile({ DSH_HOME: '/d', HOME: '/h' })).toBe('/d/workbench/channel-worker.pid')
    expect(defaultChannelWorkerPidFile({ HOME: '/h' })).toBe('/h/.dsh/workbench/channel-worker.pid')
  })
})

describe('parseProcessTable', () => {
  it('读 ps -axo pid=,ppid=,command= 的输出,命令行里的空格保留', () => {
    const rows = parseProcessTable(`  7273  6983 ${MAIN}\n 50318     1 ${MAIN}\n\n垃圾行\n`)
    expect(rows).toEqual([
      { pid: 7273, ppid: 6983, command: MAIN },
      { pid: 50318, ppid: 1, command: MAIN },
    ])
  })
})

describe('staleChannelWorkers', () => {
  const base = { selfPid: SELF, dshHome: DSH }

  it('★记下的那个被过继给 1 号 → 收', () => {
    const procs: ProcessRow[] = [{ pid: 50318, ppid: 1, command: MAIN }]
    expect(staleChannelWorkers({ ...base, recorded: 50318, procs })).toEqual([50318])
  })

  it('记下的那个父进程是别人(另一个工作台)→ 收', () => {
    const procs: ProcessRow[] = [{ pid: 50318, ppid: 4242, command: `node /repo/${CHANNEL_WORKER_MAIN_MARK}` }]
    expect(staleChannelWorkers({ ...base, recorded: 50318, procs })).toEqual([50318])
  })

  it('父进程就是自己 → 不收', () => {
    const procs: ProcessRow[] = [{ pid: 7273, ppid: SELF, command: MAIN }]
    expect(staleChannelWorkers({ ...base, recorded: 7273, procs })).toEqual([])
  })

  it('★进程号被别的程序重用了(命令行不是工人)→ 不碰', () => {
    const procs: ProcessRow[] = [{ pid: 50318, ppid: 1, command: '/usr/bin/node /别的/server.js' }]
    expect(staleChannelWorkers({ ...base, recorded: 50318, procs })).toEqual([])
  })

  it('记下的那个已经不在了 → 什么都不做', () => {
    expect(staleChannelWorkers({ ...base, recorded: 50318, procs: [] })).toEqual([])
  })

  it('★没有进程号文件(升级前那一代留下的)也认:父进程是 1、跑的是这个 DSH_HOME 下的工人', () => {
    const procs: ProcessRow[] = [
      { pid: 50318, ppid: 1, command: MAIN },
      { pid: 56368, ppid: 1, command: MAIN },
      // 仓库里开发起的、父进程是 1 的:不是这个 DSH_HOME 的,不碰
      { pid: 60000, ppid: 1, command: `node /repo/${CHANNEL_WORKER_MAIN_MARK}` },
      // 别的 node 进程:不碰
      { pid: 60001, ppid: 1, command: 'node /Users/x/.dsh/butler-server/dist/index.js' },
      // 自己的子进程:不碰
      { pid: 7273, ppid: SELF, command: MAIN },
    ]
    expect(staleChannelWorkers({ ...base, procs })).toEqual([50318, 56368])
  })

  it('记下的和扫到的是同一个 → 只算一次;不会收到自己头上', () => {
    const procs: ProcessRow[] = [
      { pid: 50318, ppid: 1, command: MAIN },
      { pid: SELF, ppid: 1, command: MAIN },
    ]
    expect(staleChannelWorkers({ ...base, recorded: 50318, procs })).toEqual([50318])
  })
})

describe('createChannelWorkerReaper', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function harness(options: { procs: ProcessRow[], stubborn?: number[], pidFile?: string }) {
    dir = await mkdtemp(join(tmpdir(), 'wb-reap-'))
    const pidFile = join(dir, 'workbench', 'channel-worker.pid')
    const alive = new Set(options.procs.map(p => p.pid))
    const signals: [number, NodeJS.Signals][] = []
    const lines: string[] = []
    let waited = 0
    const reaper = createChannelWorkerReaper({
      pidFile,
      dshHome: DSH,
      selfPid: SELF,
      listProcesses: async () => options.procs.filter(p => alive.has(p.pid)),
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (signal === 'SIGKILL' || !(options.stubborn ?? []).includes(pid)) alive.delete(pid)
      },
      isAlive: pid => alive.has(pid),
      sleep: async (ms) => { waited += ms },
      log: line => lines.push(line),
    })
    return { reaper, pidFile, signals, lines, waited: () => waited }
  }

  it('记下进程号、再读回来', async () => {
    const h = await harness({ procs: [] })
    await h.reaper.record(7273)
    expect((await readFile(h.pidFile, 'utf8')).trim()).toBe('7273')
  })

  it('★收孤儿:先 SIGTERM,退了就不 SIGKILL', async () => {
    const h = await harness({ procs: [{ pid: 50318, ppid: 1, command: MAIN }] })
    await h.reaper.record(50318)
    expect(await h.reaper.reap()).toEqual([50318])
    expect(h.signals).toEqual([[50318, 'SIGTERM']])
    expect(h.lines.join('\n')).toContain('50318')
  })

  it('★SIGTERM 不退:等满宽限再 SIGKILL', async () => {
    const h = await harness({ procs: [{ pid: 50318, ppid: 1, command: MAIN }], stubborn: [50318] })
    expect(await h.reaper.reap()).toEqual([50318])
    expect(h.signals).toEqual([[50318, 'SIGTERM'], [50318, 'SIGKILL']])
    expect(h.waited()).toBeGreaterThanOrEqual(REAP_TERM_GRACE_MS)
  })

  it('没有可收的:不发任何信号', async () => {
    const h = await harness({ procs: [{ pid: 7273, ppid: SELF, command: MAIN }] })
    await h.reaper.record(7273)
    expect(await h.reaper.reap()).toEqual([])
    expect(h.signals).toEqual([])
  })

  it('进程号文件是坏的:当没有,照样按扫描收', async () => {
    const h = await harness({ procs: [{ pid: 50318, ppid: 1, command: MAIN }] })
    await h.reaper.record(1)
    await writeFile(h.pidFile, '不是数字\n')
    expect(await h.reaper.reap()).toEqual([50318])
  })

  it('取不到进程表:不收,也不抛', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-reap-'))
    const reaper = createChannelWorkerReaper({
      pidFile: join(dir, 'p.pid'),
      dshHome: DSH,
      selfPid: SELF,
      listProcesses: async () => { throw new Error('ps 不在') },
      kill: () => { throw new Error('不该被调') },
      log: () => {},
    })
    expect(await reaper.reap()).toEqual([])
  })
})

describe('监工接上收孤儿', () => {
  it('★每次拉起前先收上一轮的、起了之后记进程号;并把自己的进程号传给工人', async () => {
    const order: string[] = []
    const spawns: Record<string, string>[] = []
    const service = createChannelWorkerService({
      script: '/假的/channel-start',
      logFile: '/假的/channel-worker.log',
      env: { WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://127.0.0.1:8795' },
      selfPid: SELF,
      scriptExists: async () => true,
      openLog: async () => undefined,
      reaper: {
        reap: async () => { order.push('reap'); return [] },
        record: async (pid) => { order.push(`record ${pid}`) },
      },
      spawnImpl: (input) => {
        order.push('spawn')
        spawns.push(input.env)
        return { pid: 321, kill: () => {}, onExit: () => {}, onError: () => {} }
      },
    })
    expect(await service.start()).toEqual({ ok: true })
    expect(order).toEqual(['reap', 'spawn', 'record 321'])
    expect(spawns[0]?.WORKBENCH_CHANNEL_PARENT_PID).toBe(String(SELF))
  })

  it('收孤儿那几秒里又点了一次「起」:只起一个', async () => {
    let release: (() => void) | undefined
    let spawned = 0
    const service = createChannelWorkerService({
      script: '/假的/channel-start',
      logFile: '/假的/channel-worker.log',
      scriptExists: async () => true,
      openLog: async () => undefined,
      reaper: {
        reap: () => new Promise<number[]>((resolve) => { release = () => resolve([]) }),
        record: async () => {},
      },
      spawnImpl: () => {
        spawned += 1
        return { pid: 321, kill: () => {}, onExit: () => {}, onError: () => {} }
      },
    })
    const first = service.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(await service.start()).toEqual({ ok: true, note: LAUNCHING_NOTE })
    release?.()
    expect(await first).toEqual({ ok: true })
    expect(spawned).toBe(1)
  })
})
