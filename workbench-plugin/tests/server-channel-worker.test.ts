// @vitest-environment node
/**
 * 工人的常驻那一层(2026-09-17,server/channelWorker.ts)。
 *
 * 这里**不真 spawn**:注入一个假子进程和一个假定时器,把「崩了自动拉起、有退避、有上限」
 * 这几条逐条走一遍 —— 它们平时几个月才发生一次,不测就等于没有。
 */
import { describe, expect, it } from 'vitest'
import {
  HEALTHY_UPTIME_MS,
  MAX_CONSECUTIVE_RESTARTS,
  RESTART_BACKOFF_MS,
  RETRY_COOLDOWN_MS,
  STOP_GRACE_MS,
  createChannelWorkerService,
  defaultChannelStartScript,
  defaultChannelWorkerLogFile,
} from '../src/server/channelWorker.ts'

interface FakeChild {
  pid: number
  killed: NodeJS.Signals[]
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void
  fail: (message: string) => void
}

/** 一台假机器:假子进程 + 假时钟 + 假定时器。时间只在 `tick()` 里往前走。 */
function machine(options: { scriptExists?: boolean } = {}) {
  const children: FakeChild[] = []
  const spawns: { script: string, env: Record<string, string> }[] = []
  const pending: { at: number, run: () => void }[] = []
  const lines: string[] = []
  let clock = 1_000_000
  let nextPid = 100

  const service = createChannelWorkerService({
    script: '/假的/channel-start',
    logFile: '/假的/channel-worker.log',
    env: { WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://127.0.0.1:8795' },
    scriptExists: async () => options.scriptExists !== false,
    openLog: async () => undefined,
    now: () => clock,
    log: line => lines.push(line),
    schedule: (ms, run) => {
      const item = { at: clock + ms, run }
      pending.push(item)
      return () => { const i = pending.indexOf(item); if (i >= 0) pending.splice(i, 1) }
    },
    spawnImpl: (input) => {
      spawns.push({ script: input.script, env: input.env })
      let onExit: ((exit: { code: number | null, signal: NodeJS.Signals | null }) => void) | undefined
      let onError: ((err: Error) => void) | undefined
      const child: FakeChild = {
        pid: nextPid += 1,
        killed: [],
        exit: (code, signal = null) => onExit?.({ code, signal }),
        fail: message => onError?.(new Error(message)),
      }
      children.push(child)
      return {
        pid: child.pid,
        kill: (signal) => { child.killed.push(signal); onExit?.({ code: null, signal }) },
        onExit: (handler) => { onExit = handler },
        onError: (handler) => { onError = handler },
      }
    },
  })

  /** 时钟往前走 ms,把到点的定时器跑掉。 */
  async function tick(ms: number): Promise<void> {
    clock += ms
    const due = pending.filter(item => item.at <= clock)
    for (const item of due) {
      pending.splice(pending.indexOf(item), 1)
      item.run()
    }
    // launch 里有 await(scriptExists / openLog),让微任务跑完
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  return { service, children, spawns, pending, lines, tick, last: () => children[children.length - 1] as FakeChild }
}

describe('默认位置', () => {
  it('启动脚本与 butler-start 同一个目录', () => {
    expect(defaultChannelStartScript('/Users/example')).toBe('/Users/example/.dsh/bin/channel-start')
  })

  it('日志在工作台数据目录下的 logs/', () => {
    expect(defaultChannelWorkerLogFile('/Users/example')).toBe('/Users/example/.dsh/workbench/logs/channel-worker.log')
  })
})

describe('起与停', () => {
  it('start 真去拉脚本,并把工作台地址传进去(**不传任何密钥**)', async () => {
    const m = machine()
    expect(await m.service.start()).toEqual({ ok: true })
    expect(m.spawns).toEqual([{
      script: '/假的/channel-start',
      // 外加工作台自己的进程号(2026-10-10):工人据此看得出工作台没了就自己走。
      env: { WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://127.0.0.1:8795', WORKBENCH_CHANNEL_PARENT_PID: String(process.pid) },
    }])
    const view = m.service.view()
    expect(view.running).toBe(true)
    expect(view.supervising).toBe(true)
    expect(view.pid).toBe(m.last().pid)
    expect(view.log_file).toBe('/假的/channel-worker.log')
  })

  it('已经在跑就不再起第二个——一个房间只该有一个工人', async () => {
    const m = machine()
    await m.service.start()
    expect(await m.service.start()).toEqual({ ok: true, note: '本来就在跑' })
    expect(m.spawns).toHaveLength(1)
  })

  it('脚本还没 cp 过去:如实说怎么办,不假装成功', async () => {
    const m = machine({ scriptExists: false })
    const result = await m.service.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('deploy/channel-start')
    expect(m.service.view().running).toBe(false)
  })

  it('stop 之后不再自动拉起', async () => {
    const m = machine()
    await m.service.start()
    expect(await m.service.stop()).toEqual({ ok: true })
    await m.tick(RESTART_BACKOFF_MS[0] as number)
    expect(m.spawns).toHaveLength(1)
    const view = m.service.view()
    expect(view.running).toBe(false)
    expect(view.supervising).toBe(false)
  })

  it('本来就没在跑时 stop 如实说,不报错', async () => {
    const m = machine()
    expect(await m.service.stop()).toEqual({ ok: true, note: '本来就没在跑' })
  })
})

describe('崩了自动拉起', () => {
  it('退了就按退避梯子重来,一级一级往后', async () => {
    const m = machine()
    await m.service.start()

    m.last().exit(1)
    expect(m.service.view().running).toBe(false)
    expect(m.service.view().note).toContain('第 1 次拉起')
    // 还没到点就不该起
    await m.tick((RESTART_BACKOFF_MS[0] as number) - 1)
    expect(m.spawns).toHaveLength(1)
    await m.tick(1)
    expect(m.spawns).toHaveLength(2)

    m.last().exit(1)
    await m.tick((RESTART_BACKOFF_MS[1] as number) - 1)
    expect(m.spawns).toHaveLength(2)
    await m.tick(1)
    expect(m.spawns).toHaveLength(3)
  })

  it('活够一分钟就算这一轮是好的,计数清零、下次还从最短的退避重来', async () => {
    const m = machine()
    await m.service.start()
    m.last().exit(1)
    await m.tick(RESTART_BACKOFF_MS[0] as number)
    expect(m.service.view().restarts).toBe(1)

    await m.tick(HEALTHY_UPTIME_MS)
    m.last().exit(1)
    expect(m.service.view().restarts).toBe(1) // 清零之后这一次又是第 1 次
    await m.tick(RESTART_BACKOFF_MS[0] as number)
    expect(m.spawns).toHaveLength(3)
  })

  it('连着拉不起来就**停手**,并在 note 里指到日志——不无限重试把问题藏起来', async () => {
    const m = machine()
    await m.service.start()
    for (let i = 0; i < MAX_CONSECUTIVE_RESTARTS; i += 1) {
      m.last().exit(1)
      await m.tick(60_000)
    }
    expect(m.spawns).toHaveLength(MAX_CONSECUTIVE_RESTARTS + 1)
    m.last().exit(1)
    await m.tick(60_000)
    // 第 MAX+1 次退出时不再拉了
    expect(m.spawns).toHaveLength(MAX_CONSECUTIVE_RESTARTS + 1)
    const view = m.service.view()
    expect(view.supervising).toBe(false)
    expect(view.note).toContain('不再自动拉了')
    expect(view.note).toContain('/假的/channel-worker.log')
  })

  /**
   * ★ 2026-09-30(止血第 5 条):**放弃不是永久的**。
   *
   * 原来撞了上限就再也不拉 —— 而「起不来」的原因常常是一会儿就好的(凭证还没从服务器取回来、
   * 网卡刚换、磁盘忙)。那时手机和座机从此打不进来,本机界面上只是通话那一格灰了,没人会去点一下。
   * 现在:照旧停手、照旧留那句话,但**10 分钟后自己再试一次**,而且那句话里说清什么时候再试。
   */
  it('★放弃之后 10 分钟冷却再试一次,note 里说了什么时候再试', async () => {
    const m = machine()
    await m.service.start()
    for (let i = 0; i <= MAX_CONSECUTIVE_RESTARTS; i += 1) {
      m.last().exit(1)
      await m.tick(60_000)
    }
    const gaveUp = m.service.view()
    expect(gaveUp.supervising).toBe(false)
    expect(gaveUp.note).toContain('不再自动拉了')
    expect(gaveUp.note).toContain('10 分钟后再试一次')
    expect(typeof gaveUp.retry_at).toBe('string')
    const spawnsAtGiveUp = m.spawns.length

    // 冷却没到:一次都不再起(放弃那一刻之后循环里已经走过 1 分钟,这里再走 8 分钟 = 9 分钟)。
    await m.tick(RETRY_COOLDOWN_MS - 2 * 60_000)
    expect(m.spawns).toHaveLength(spawnsAtGiveUp)

    // 冷却到了:自己回来,计数从头数。
    await m.tick(60_000)
    expect(m.spawns).toHaveLength(spawnsAtGiveUp + 1)
    const back = m.service.view()
    expect(back.running).toBe(true)
    expect(back.supervising).toBe(true)
    expect(back.restarts).toBe(0)
    expect(back.retry_at).toBeUndefined()
  })

  it('★冷却期间他自己点了「停」:那个 10 分钟的约就不作数了', async () => {
    const m = machine()
    await m.service.start()
    for (let i = 0; i <= MAX_CONSECUTIVE_RESTARTS; i += 1) {
      m.last().exit(1)
      await m.tick(60_000)
    }
    const spawnsAtGiveUp = m.spawns.length
    await m.service.stop()
    await m.tick(RETRY_COOLDOWN_MS)
    expect(m.spawns).toHaveLength(spawnsAtGiveUp)
    expect(m.service.view().retry_at).toBeUndefined()
  })

  it('撞了上限之后手动 start 从头来——Ben 点一下得有反应', async () => {
    const m = machine()
    await m.service.start()
    for (let i = 0; i <= MAX_CONSECUTIVE_RESTARTS; i += 1) {
      m.last().exit(1)
      await m.tick(60_000)
    }
    expect(m.service.view().supervising).toBe(false)
    expect(await m.service.start()).toEqual({ ok: true })
    expect(m.service.view().restarts).toBe(0)
    expect(m.service.view().supervising).toBe(true)
  })

  it('退出原因如实记下来(信号还是退出码)', async () => {
    const m = machine()
    await m.service.start()
    m.last().exit(null, 'SIGKILL')
    expect(m.service.view().last_exit).toMatchObject({ signal: 'SIGKILL' })
    expect(m.service.view().note).toContain('SIGKILL')
  })

  it('spawn 本身失败(没执行位)也记一句原因', async () => {
    const m = machine()
    await m.service.start()
    m.last().fail('EACCES: permission denied')
    expect(m.service.view().note).toContain('EACCES')
  })
})

describe('dispose', () => {
  it('插件卸载时把工人带走,并且不再拉起', async () => {
    const m = machine()
    await m.service.start()
    const child = m.last()
    await m.service.dispose()
    expect(child.killed).toEqual(['SIGTERM'])
    await m.tick(60_000)
    expect(m.spawns).toHaveLength(1)
    expect(m.service.view().supervising).toBe(false)
    expect(await m.service.start()).toEqual({ ok: false, error: '工作台正在退出,这会儿不起工人' })
  })
})

describe('stop 会等它真的退', () => {
  /** 一个**不肯退**的子进程:收到 SIGTERM 也不触发 exit。 */
  function stubborn() {
    const pending: { at: number, run: () => void }[] = []
    let clock = 0
    const killed: NodeJS.Signals[] = []
    const service = createChannelWorkerService({
      script: '/假的/channel-start',
      logFile: '/假的/channel-worker.log',
      scriptExists: async () => true,
      openLog: async () => undefined,
      now: () => clock,
      schedule: (ms, run) => {
        const item = { at: clock + ms, run }
        pending.push(item)
        return () => { const i = pending.indexOf(item); if (i >= 0) pending.splice(i, 1) }
      },
      spawnImpl: () => ({ pid: 1, kill: signal => killed.push(signal), onExit: () => {}, onError: () => {} }),
    })
    return {
      service,
      killed,
      fire: () => { clock += STOP_GRACE_MS; for (const item of pending.splice(0)) item.run() },
    }
  }

  it('宽限期过了它还在,就如实说「还没退干净」——不假装停了', async () => {
    const m = stubborn()
    await m.service.start()
    const stopping = m.service.stop()
    m.fire()
    expect(await stopping).toEqual({ ok: true, note: '发了 SIGTERM,它还没退干净' })
    expect(m.killed).toEqual(['SIGTERM'])
    expect(m.service.view().running).toBe(true)
    expect(m.service.view().supervising).toBe(false)
  })
})
