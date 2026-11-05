// @vitest-environment node
/**
 * **等可灵出片、把片子下下来**(2026-10-12,卡「演示 · 出图进可灵」;维护者:「看到视频之后推到手机端上,再打个电话过来」)。
 *
 * 判据都是**可灵自己的日志**(`~/Library/Logs/KlingAI/kling-local-app/app.log`,10-12 真量):
 * - 出片:一条通知 `"notixTopic": "AllTaskFinish"`(「可灵AI 创作完成」),块里带毫秒 `timestamp`;
 * - 按成了:`[ISO] [INFO] Download started {`;
 * - 下完:`[ISO] [INFO] Download completed {` 块里带 `"fullPath"`。
 * 下载键是结果卡下面那一排里没名字的 ⬇(壳 `press_below_text`;一点就按 MP4 下,菜单里「去除水印」那个开关一下都不碰)。
 *
 * ## ★ 2026-10-13 真机(卡 D):四次里下载只自动成两次
 *
 * 14:02 与 14:19 两通:`AllTaskFinish` 一到就按,壳回 `found/pressed`,可灵日志里**一条 Download started 都没有**;
 * 14:19 那次是维护者**自己手点**下载,落在等下完那个窗口里,整条链接着走完了。
 * 所以这一版:**先读窗等最新那条结果卡真切到完成态**(有播放时间、两眼之间没动)再按;
 * 按完 10 秒没见 Download started 就**再按一次(只一次)**;两次都没见也接着盯到窗口尽头(手点救得回来),
 * 最后才如实说「下载那一下没按成」—— **不许说办完了**。
 */
import { describe, expect, it } from 'vitest'
import {
  KLING_BUNDLE, KLING_DONE_BY, KLING_FILE_SETTLE_MS, klingCardLook, klingDownloadStartedSince, klingDownloadedSince, klingFinishedSince,
  pickFreshKlingFile, waitKlingVideo,
} from '../src/server/klingStep.ts'

const LOG = `[2026-10-12T10:38:45.484Z] [INFO] [Notification] 收到推送 {
  "timestamp": 1791801525484,
  "type": "NT",
  "notixTopic": "AllTaskFinish",
  "title": "可灵AI 创作完成",
  "body": "您的任务已完成,立即点击查看"
}
[2026-10-12T10:45:03.952Z] [INFO] Download started {
  "fileName": "kling_20261012_作品_花海.mp4"
}
[2026-10-12T10:45:07.406Z] [INFO] Download completed {
  "fileName": "kling_20261012_作品_花海.mp4",
  "fullPath": "/Users/example/Downloads/kling_20261012_作品_花海.mp4"
}
`

describe('读可灵自己的日志', () => {
  it('出片:只认那一刻之后的「创作完成」', () => {
    expect(klingFinishedSince(LOG, Date.parse('2026-10-12T10:30:00Z'))).toBe(true)
    expect(klingFinishedSince(LOG, Date.parse('2026-10-12T10:40:00Z'))).toBe(false)
  })
  it('下完:只认那一刻之后的「Download completed」,带回完整路径', () => {
    expect(klingDownloadedSince(LOG, Date.parse('2026-10-12T10:45:00Z'))).toBe('/Users/example/Downloads/kling_20261012_作品_花海.mp4')
    expect(klingDownloadedSince(LOG, Date.parse('2026-10-12T10:46:00Z'))).toBeUndefined()
  })
  it('★按成了没有:只认那一刻之后的「Download started」(10-13 两次按完一条都没有)', () => {
    expect(klingDownloadStartedSince(LOG, Date.parse('2026-10-12T10:45:00Z'))).toBe(true)
    expect(klingDownloadStartedSince(LOG, Date.parse('2026-10-12T10:45:05Z'))).toBe(false)
    expect(klingDownloadStartedSince(LOG.split('[2026-10-12T10:45:03')[0] as string, Date.parse('2026-10-12T10:30:00Z'))).toBe(false)
  })
})

/** 一条做完的结果卡:卡上那段播放时间(做完的卡才有播放器)。 */
const DONE_ROW = { t: '00:01 / 00:05', y: 120 }
/** 还在生成的那条(界面还没切过来)。 */
const WORKING_ROW = { t: '创作中,预计等待 1 分钟', y: 118 }

describe('★最上面那条结果卡的样子', () => {
  it('有播放时间 = 做完了;还有「创作中」= 界面还没切过来;两条并排 = 分不出哪条新', () => {
    expect(klingCardLook([DONE_ROW, { t: '提示词', y: 400 }])).toMatchObject({ done: 1, top: 120, working: false, tied: false })
    expect(klingCardLook([WORKING_ROW])).toMatchObject({ done: 0, working: true })
    expect(klingCardLook([DONE_ROW, WORKING_ROW])).toMatchObject({ done: 1, working: true })
    // 两条卡各自在放自己的片子,播放时间同时走到「00:01 / 00:05」—— 同一行上两条,按下去可能按在旧那条上。
    expect(klingCardLook([DONE_ROW, { t: '00:01 / 00:05', y: 124 }])).toMatchObject({ done: 2, tied: true })
    // 上下两条(列表,新的在上面)分得出来。
    expect(klingCardLook([DONE_ROW, { t: '00:03 / 00:05', y: 420 }])).toMatchObject({ done: 2, top: 120, tied: false })
    expect(klingCardLook([])).toMatchObject({ done: 0, working: false, tied: false })
  })
})

const T0 = Date.parse('2026-10-12T10:30:00Z')

interface Script {
  finishAt?: number
  /** 第几次按下才真开始下载(1 = 第一次;不给 = 按了都没开始,10-13 真机那两次)。 */
  startOnPress?: number
  startDelayMs?: number
  /** 她自己在可灵里点了下载那一刻(10-13 14:19 就是这么救回来的)。 */
  handAt?: number
  /** 壳回「没认出那颗键」。 */
  pressMiss?: boolean
  /** 按完窗口里新冒出来「去除水印」那张菜单。 */
  pressMenu?: boolean
  /** 下起来了但一直没下完。 */
  noComplete?: boolean
  /** 读窗第 n 眼(1 起)看到哪几行;不给 = 一条做完的卡,位置不动。 */
  rows?: (look: number) => readonly { t: string, y?: number }[]
  /** ★ 可灵那份日志压根读不到(演示机那台的版本 / 路径还没核过;卡 O)。 */
  logThrows?: boolean
  /** ★ 「下载」文件夹里那个片子是哪一刻冒出来的(日志没有「Download completed」时的旁路;卡 O)。 */
  downloadAt?: number
  /**
   * ★ 那个片子**此刻**多少字节(2026-10-13 22:06 真机:可灵把片子直接写在最终那个名字上,
   * 旁路在它只写了 32 KB 时就认了;卡 R)。不给 = 一冒出来就是整的。
   */
  downloadBytes?: (now: number) => number
}

/** 「下载」文件夹里那个可灵片子(旁路认出来的那条路径)。 */
const DOWNLOADED = '/Users/example/Downloads/kling_20261013_作品_小女孩.mp4'

function world(script: Script) {
  let now = T0
  const calls: (Record<string, unknown> & { op: string })[] = []
  let looks = 0
  let presses = 0
  let startAt: number | undefined
  let log = ''
  function pump(): void {
    if (script.finishAt !== undefined && now >= script.finishAt && !log.includes('AllTaskFinish')) {
      log += LOG.split('[2026-10-12T10:45:03')[0] as string
    }
    if (script.handAt !== undefined && now >= script.handAt && startAt === undefined) startAt = script.handAt
    if (startAt !== undefined && now >= startAt && !log.includes('Download started')) {
      log += `[${new Date(startAt).toISOString()}] [INFO] Download started {\n  "fileName": "a.mp4"\n}\n`
    }
    if (startAt !== undefined && now >= startAt + 2000 && script.noComplete !== true
      && log.includes('Download started') && !log.includes('Download completed')) {
      log += `[${new Date(startAt + 2000).toISOString()}] [INFO] Download completed {\n  "fileName": "a.mp4",\n  "fullPath": "/Users/example/Downloads/a.mp4"\n}\n`
    }
  }
  const deps = {
    readLog: async () => {
      pump()
      if (script.logThrows === true) throw new Error('ENOENT: 没有这个文件')
      return log
    },
    ...(script.downloadAt === undefined
      ? {}
      // 「下载」文件夹那条旁路:那一刻之后真多了一个 `kling_*.mp4`(插件那一头读的是目录项与 mtime)。
      : {
          findDownload: async (since: number) => (now >= (script.downloadAt as number) && (script.downloadAt as number) >= since
            ? { path: DOWNLOADED, bytes: script.downloadBytes?.(now) ?? 5_506_145 }
            : undefined),
        }),
    now: () => now,
    sleep: async (ms: number) => { now += ms; pump() },
    helper: {
      request: async (req: Record<string, unknown> & { op: string }) => {
        if (req.op === 'unhide_app') return { ok: true, result: {} }
        calls.push(req)
        if (req.op === 'agent_read') {
          looks += 1
          const rows = script.rows?.(looks) ?? [DONE_ROW]
          return { ok: true, result: { tail: rows.map(one => ({ x: 900, w: 60, h: 16, ...one })) } }
        }
        if (req.op === 'press_below_text') {
          presses += 1
          if (script.pressMiss === true) return { ok: true, result: { found: false, anchors: 1, note: '没认出那颗键,一下都没点' } }
          if (script.startOnPress !== undefined && presses >= script.startOnPress && startAt === undefined) {
            startAt = now + (script.startDelayMs ?? 1000)
          }
          return { ok: true, result: { found: true, pressed: true, ...(script.pressMenu === true ? { new_texts: ['下载原视频', '去除水印'] } : {}) } }
        }
        return { ok: false, error: `没这个 op:${req.op}` }
      },
    },
    pollMs: 5000,
    finishTimeoutMs: 20 * 60_000,
    downloadTimeoutMs: 60_000,
  }
  const readsBeforeFirstPress = (): number => {
    const at = calls.findIndex(one => one.op === 'press_below_text')
    return calls.slice(0, at < 0 ? calls.length : at).filter(one => one.op === 'agent_read').length
  }
  return { deps, calls, readsBeforeFirstPress, presses: () => presses, looks: () => looks, now: () => now }
}

const run = async (w: ReturnType<typeof world>, cardsBefore?: number, doneBarBefore?: string) =>
  await waitKlingVideo({
    since: T0,
    ...(cardsBefore === undefined ? {} : { cardsBefore }),
    ...(doneBarBefore === undefined ? {} : { doneBarBefore }),
  }, w.deps)

describe('等出片 → 等结果卡切到完成态 → 点下载 → 核对下起来了 → 等下完', () => {
  it('出片了 → 读一眼窗、卡稳住 → 按那颗 ⬇(按角色 + 锚)→ 日志里见 Download started → 等到下完 → 回路径', async () => {
    const w = world({ finishAt: T0 + 60_000, startOnPress: 1 })
    expect(await run(w)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
    expect(w.presses()).toBe(1)
    // 按之前先读窗(10-13:一到就按,壳说按了、可灵没动静)。
    expect(w.readsBeforeFirstPress()).toBeGreaterThanOrEqual(2)
    expect(w.calls.find(one => one.op === 'press_below_text')).toMatchObject({ op: 'press_below_text', bundle_id: KLING_BUNDLE, role: 'AXPopUpButton' })
  })

  it('★界面还在生成 / 列表还在动 → 先不按;切到完成态、位置两眼没动才按', async () => {
    const w = world({
      finishAt: T0 + 10_000,
      startOnPress: 1,
      rows: look => (look === 1 ? [WORKING_ROW] : look === 2 ? [{ ...DONE_ROW, y: 300 }] : [DONE_ROW]),
    })
    expect((await run(w)).kind).toBe('ready')
    expect(w.presses()).toBe(1)
    expect(w.readsBeforeFirstPress()).toBe(4)
  })

  it('★按完 10 秒没见 Download started → 再按一次,第二次成了就照样走完', async () => {
    const w = world({ finishAt: T0 + 10_000, startOnPress: 2 })
    expect((await run(w)).kind).toBe('ready')
    expect(w.presses()).toBe(2)
  })

  it('★两次都没见 Download started,她自己在可灵里点了下载 → 照样走完(10-13 14:19)', async () => {
    const w = world({ finishAt: T0 + 10_000, handAt: T0 + 45_000 })
    expect(await run(w)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
    expect(w.presses()).toBe(2)
  })

  it('★两次都没见、也没人点 → failed,一句人话「下载那一下没按成」;最多只按两次', async () => {
    const w = world({ finishAt: T0 + 10_000 })
    const got = await run(w)
    expect(got.kind).toBe('failed')
    expect((got as { why: string }).why).toContain('没按成')
    expect((got as { why: string }).why).toContain('你在可灵里点一下')
    expect(w.presses()).toBe(2)
  })

  it('★壳两次都没认出那颗键 → 也只说没按成,不说办完了', async () => {
    const w = world({ finishAt: T0 + 10_000, pressMiss: true })
    const got = await run(w)
    expect(got.kind).toBe('failed')
    expect((got as { why: string }).why).toContain('你在可灵里点一下')
    expect(w.presses()).toBe(2)
  })

  it('★按完弹出「去除水印」那张菜单、还是没下起来 → 不再按第二下(怕点在那个开关上),如实说', async () => {
    const w = world({ finishAt: T0 + 10_000, pressMenu: true })
    const got = await run(w)
    expect(got.kind).toBe('failed')
    expect((got as { why: string }).why).toContain('弹了个菜单')
    expect(w.presses()).toBe(1)
  })

  it('★最上面那一行两条片子并排 → 一下都不点,如实说;她自己点了照样走完', async () => {
    const tied = (): readonly { t: string, y?: number }[] => [DONE_ROW, { t: '00:01 / 00:05', y: 124 }]
    const w = world({ finishAt: T0 + 10_000, rows: tied })
    const got = await run(w)
    expect(got.kind).toBe('failed')
    expect((got as { why: string }).why).toContain('分不出')
    expect(w.presses()).toBe(0)

    const v = world({ finishAt: T0 + 10_000, rows: tied, handAt: T0 + 30_000 })
    expect((await run(v)).kind).toBe('ready')
    expect(v.presses()).toBe(0)
  })

  /**
   * ★ 2026-10-13 晚(卡 O):等出片时**也读窗**了,所以这一条不再是「一眼都不读」。
   * 要钉住的是另一件:结果列里本来就躺着她从前那些做完的片子,**那不算这一单做完了** ——
   * 判据是「比按生成之前多了一条」(这里一条都没多)。
   */
  it('等不到出片 → failed,一下都不点;结果列里原有的那条做完的卡不算这一单', async () => {
    const w = world({})
    const got = await run(w)
    expect(got.kind).toBe('failed')
    expect((got as { why: string }).why).toContain('还没说做完')
    expect(w.presses()).toBe(0)
    expect(w.looks()).toBeGreaterThan(0)
  })

  it('下起来了却一直没下完 → failed,说清片子在可灵里 / 在「下载」文件夹', async () => {
    const w = world({ finishAt: T0 + 10_000, startOnPress: 1, noComplete: true })
    const got = await run(w)
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('没等到它下完')
    expect(w.presses()).toBe(1)
  })
})

/* ──────── ★ 不能只靠那份日志:2026-10-13 晚演示机那条(卡 O)──────── */

/**
 * ★ **演示机 20:35 那条断在「可灵做出来了、插件在等日志」**(维护者 21:0x:「生成结束之后没有去点击下载」)。
 *
 * 那台的可灵版本 / 日志路径 / 字段一样都没核过(日志文件不在诊断包里)。所以:
 * - 「做完了」= 日志里的 `AllTaskFinish` **或者** 读窗里结果列比按生成之前多了一条做完的卡;
 * - 「下完了」= 日志里的 `Download completed` **或者**「下载」文件夹里那一刻之后新冒出来的 `kling_*.mp4`;
 * - 日志一次都读不到要在卡上留一句(`log_missing`),别当没事发生。
 */
describe('★日志之外的两条旁路', () => {
  it('日志里没有「创作完成」,读窗里结果列多了一条做完的卡 → 照样按下载、走完', async () => {
    const old = { t: '00:02 / 00:05', y: 300 }
    const w = world({ startOnPress: 1, rows: look => (look >= 2 ? [DONE_ROW, old] : [old]) })
    expect(await run(w, 1)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
    expect(w.presses()).toBe(1)
  })

  it('日志里没有「Download completed」,「下载」文件夹里多了一个新 mp4 → 当下完了', async () => {
    const w = world({ finishAt: T0 + 10_000, startOnPress: 1, noComplete: true, downloadAt: T0 + 40_000 })
    expect(await run(w)).toEqual({ kind: 'ready', path: DOWNLOADED })
  })

  it('★可灵那份日志一次都读不到 → 按读窗与「下载」文件夹判,卡上留一句 log_missing', async () => {
    const w = world({ logThrows: true, rows: look => (look >= 2 ? [DONE_ROW] : []), downloadAt: T0 + 17_000 })
    expect(await run(w, 0)).toEqual({ kind: 'ready', path: DOWNLOADED, log_missing: true })
    // 日志读不到也照样按了那颗 ⬇(「按成没成」这时只剩文件夹那一条判据)。
    expect(w.presses()).toBeGreaterThanOrEqual(1)
  })

  /**
   * ★ **页面底部那条浮条**(2026-10-13 晚 21:5x 演示机截图原字:「1/1 生成完成 回到顶部」;卡 Q)。
   *
   * 它是「做完了」的强信号,可**不能光看它在不在** —— 她上一回生成留下的那条也写着「1/1 生成完成」。
   * 所以判的是「**跟按生成之前那一眼不一样**」(没有 → 有,或者 1/1 → 2/2)。
   * 顺带:截图里那条浮条带「回到顶部」,坐实了卡 D / 卡 O 那个前提 —— 新做完的卡在结果列**最上面**。
   */
  it('★浮条从「1/1 生成完成」变成「2/2 生成完成」→ 当做完了(日志里没有创作完成也走得完)', async () => {
    const old = { t: '00:02 / 00:05', y: 300 }
    const w = world({
      startOnPress: 1,
      rows: look => (look >= 2 ? [DONE_ROW, old, { t: '2/2 生成完成' }, { t: '回到顶部' }] : [old, { t: '1/1 生成完成' }]),
    })
    // 结果卡那条判据故意封死(底给到 9 条):这一单只能靠浮条判出来。
    expect(await run(w, 9, '1/1 生成完成')).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
  })

  it('★浮条跟按之前一字没变 → 不当做完(她上一回那条就写着「1/1 生成完成」)', async () => {
    const old = { t: '00:02 / 00:05', y: 300 }
    const w = world({ rows: () => [old, { t: '1/1 生成完成' }] })
    const got = await run(w, 9, '1/1 生成完成')
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('还没说做完')
    expect(w.presses()).toBe(0)
  })

  it('★没按下载之前文件夹里那个旧的 kling 片子不算(只认按下载那一刻之后改动过的)', () => {
    const files = [
      { name: 'kling_旧.mp4', mtimeMs: T0 - 1 },
      { name: 'kling_新.mp4', mtimeMs: T0 + 5 },
      { name: 'kling_次新.mp4', mtimeMs: T0 + 3 },
      { name: '别人的.mp4', mtimeMs: T0 + 9 },
      { name: 'kling_说明.txt', mtimeMs: T0 + 9 },
    ]
    expect(pickFreshKlingFile(files, T0)).toBe('kling_新.mp4')
    expect(pickFreshKlingFile([{ name: 'kling_旧.mp4', mtimeMs: T0 - 1 }], T0)).toBeUndefined()
    expect(pickFreshKlingFile([], T0)).toBeUndefined()
  })
})

/* ──────── 「下载」文件夹那条旁路要等文件写完(2026-10-13 22:06 真机;卡 R)──────── */

/**
 * ★ **22:06 那条「钵钵跳舞」:推到手机上的是一份 32 KB 的半截片子**。
 *
 * 可灵(Electron)把片子**直接写在最终那个名字上**,没有 `.crdownload` 一类的临时名:
 * 日志 `Download started` 22:06:01.979 → 文件夹里立刻有了 `kling_….mp4`(还在长)→ 旁路 22:06:02 就认了、
 * 复制进素材(32 120 字节)、推到手机 → 日志 `Download completed` 22:06:05.352 时文件才 8 023 474 字节。
 * 手机那头弹了播放器、播放失败。所以旁路认文件要等它**大小停住**({@link KLING_FILE_SETTLE_MS});
 * 日志里那条 `Download completed` 照旧一到就认(它带的就是写完了的路径)。
 */
describe('★「下载」文件夹那条旁路要等文件写完', () => {
  const APPEAR = T0 + 40_000
  it('★文件还在长就不算下完;大小停住 3 秒才认(22:06 那条 32 KB 的半截片子)', async () => {
    const w = world({
      finishAt: T0 + 10_000, startOnPress: 1, noComplete: true, downloadAt: APPEAR,
      // 头 4 秒每毫秒长一个字节(32 KB 起),之后就是整的 8 MB。
      downloadBytes: now => (now < APPEAR + 4000 ? 32_120 + (now - APPEAR) : 8_023_474),
    })
    expect(await run(w)).toEqual({ kind: 'ready', path: DOWNLOADED })
    // 长到整的那一刻(+4 秒)之后还要停住 KLING_FILE_SETTLE_MS 才认。
    expect(w.now() - APPEAR).toBeGreaterThanOrEqual(4000 + KLING_FILE_SETTLE_MS)
  })

  it('★一直在长、到窗口尽头都没停 → 如实说没等到它下完,不把半截推出去', async () => {
    const w = world({
      finishAt: T0 + 10_000, startOnPress: 1, noComplete: true, downloadAt: APPEAR,
      downloadBytes: now => 32_120 + (now - APPEAR),
    })
    const got = await run(w)
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('没等到它下完')
  })

  it('★日志里有「Download completed」就一到即认,不为文件夹那条多等', async () => {
    // 日志 +2 秒写完;文件夹里那个一直在长(日志说完了就信日志,那条路径就是写完了的)。
    const w = world({ finishAt: T0 + 10_000, startOnPress: 1, downloadAt: T0 + 11_000, downloadBytes: now => 1 + (now - T0) })
    expect(await run(w)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
  })

  it('★空文件(刚建出来、一个字节还没写)不算', async () => {
    const w = world({ finishAt: T0 + 10_000, startOnPress: 1, noComplete: true, downloadAt: APPEAR, downloadBytes: now => (now < APPEAR + 6000 ? 0 : 5_000_000) })
    expect(await run(w)).toEqual({ kind: 'ready', path: DOWNLOADED })
    expect(w.now() - APPEAR).toBeGreaterThanOrEqual(6000 + KLING_FILE_SETTLE_MS)
  })
})

/* ──────── 同一条链等可灵的上限:2026-10-13 并行之后照旧(卡 M)──────── */

/**
 * ★ **两条链各走各的了,「一条链等可灵」那两个上限一点没放宽**(2026-10-13,卡 M)。
 *
 * 并行改的是「别的链不用跟着等」,不是「这一条可以等更久」:等出片照旧 20 分钟、
 * 等下完照旧 2 分钟(`waitKlingVideo` 不传就是这两个数)。
 * 真机 17:22 那条就在这个 20 分钟里 —— 它该在 17:42 如实说「可灵还没说做完」,不是永远挂着。
 */
describe('★等可灵的上限照旧(20 分钟 + 2 分钟)', () => {
  it('不传就是 20 分钟等出片;等满了如实说,一下都不点', async () => {
    let now = T0
    const sleeps: number[] = []
    const got = await waitKlingVideo({ since: T0 }, {
      readLog: async () => '',
      now: () => now,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms },
      helper: { request: async () => ({ ok: false, error: '不该问壳' }) },
    })
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('等了 20 分钟')
    expect(now - T0).toBeGreaterThanOrEqual(20 * 60_000)
    // 没放宽:多等的那一截不超过一拍。
    expect(now - T0).toBeLessThan(20 * 60_000 + (sleeps[0] as number))
  })

  it('不传就是 2 分钟等下完(出片了、按不成也只盯这么久)', async () => {
    let now = T0
    const log = LOG.split('[2026-10-12T10:45:03')[0] as string
    const got = await waitKlingVideo({ since: T0 }, {
      readLog: async () => log,
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      helper: {
        request: async (req: Record<string, unknown> & { op: string }) => (req.op === 'agent_read'
          ? { ok: true, result: { tail: [DONE_ROW] } }
          : { ok: true, result: { found: true, pressed: true } }),
      },
    })
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('没按成')
    // 出片那一拍是当场的(日志里已经有),所以这一截就是等下完那个窗口。
    expect(now - T0).toBeGreaterThanOrEqual(2 * 60_000)
    expect(now - T0).toBeLessThan(2 * 60_000 + 30_000)
  })
})

/* ──────── 等做完那一段也认「她自己点了下载」:2026-10-14 中午演示机(卡 AD)──────── */

/**
 * ★ **可灵做完了,三条「做完」判据一条都没响,她手点下载也救不回来**(2026-10-14 12:0x,演示机 0.4.134,卡 AD)。
 *
 * 11:59 按下生成,壳每 15 秒读一眼可灵窗口到 12:05,从没判出「做完」(那台的可灵日志 / 读窗长什么样一样都没核过);
 * 维护者在可灵里点了下载 —— 可「下载」文件夹与 `Download started` 那两条旁路原来只在「做完」**之后**才看,
 * 这一层就在「等做完」里干等到 20 分钟。片子能下,必然已经做完:从此等做完那一段也认这两条,而且这时**一下都不按**。
 * 顺带把每一眼读到的样子记进插件日志(`[可灵] …`),下回诊断包里才有据可查。
 */
describe('★等做完那一段也认「她自己点了下载」(2026-10-14,卡 AD)', () => {
  it('日志里没有创作完成、读窗什么都读不到,「下载」文件夹里冒出新片子 → 当做完了,不按下载,等它写完就回路径', async () => {
    const w = world({ rows: () => [], downloadAt: T0 + 90_000 })
    expect(await run(w, 0)).toEqual({ kind: 'ready', path: DOWNLOADED })
    expect(w.presses()).toBe(0)
    // 不是等满 20 分钟才认:她一点下载就认出来了。
    expect(w.now() - T0).toBeLessThan(2 * 60_000)
  })

  it('日志里只有她手点之后的 Download started / completed(没有创作完成)→ 同样当做完了,不按', async () => {
    const w = world({ rows: () => [], handAt: T0 + 90_000 })
    expect(await run(w, 0)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
    expect(w.presses()).toBe(0)
    expect(w.now() - T0).toBeLessThan(2 * 60_000)
  })

  it('按生成之前就躺在文件夹里的旧片子不算(照旧等到上限、如实说没做完)', async () => {
    const w = world({ rows: () => [], downloadAt: T0 - 10_000 })
    const got = await run(w, 0)
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('还没说做完')
    expect(w.presses()).toBe(0)
  })

  it('★每一眼读窗的样子变了才记一行;做完了记是哪条路认出来的', async () => {
    const notes: string[] = []
    const w = world({ rows: () => [], downloadAt: T0 + 90_000 })
    await waitKlingVideo({ since: T0, cardsBefore: 0 }, { ...w.deps, log: line => notes.push(line) })
    expect(notes.some(line => line.includes(KLING_DONE_BY.download))).toBe(true)
    // 十几眼样子都一样,只记第一眼;每一行都带 [可灵] 前缀。
    expect(notes.filter(line => line.includes('读窗')).length).toBe(1)
    expect(notes.every(line => line.startsWith('[可灵] '))).toBe(true)
  })
})

/* ──────── 「创作中」出现过又消失 = 做完了:2026-10-14 13:40 演示机(卡 AE)──────── */

/**
 * ★ **做完了,可「比按之前多一条」永远到不了**(2026-10-14 13:40,演示机 0.4.135,卡 AE)。
 *
 * 日志:13:39:44「做完的卡 4 条(底 5),创作中有」→ 13:40:45「做完的卡 5 条(底 5),创作中无」—— 片子那一刻就做完了,
 * 可 `agent_read` 只给 30 行,做完的卡数封顶在 5,按生成之前量的底就是封顶值,`done > cardsBefore` 永远不成立。
 * 从此:按生成之后见过「创作中」、后来它没了、而且做完的卡比那一眼**多了**(或最上面那条播放时间**上移**了 ——
 * 新卡顶上来、最旧那条被 30 行挤出去)就算做完。既没多也没上移(多半是失败了)不算,照旧等。
 */
describe('★「创作中」出现过又消失 = 做完了(2026-10-14 13:40 演示机,卡 AE)', () => {
  const olds = (n: number): { t: string, y: number }[] => Array.from({ length: n }, (_, i) => ({ t: '00:02 / 00:05', y: 300 + i * 90 }))

  it('底已经封顶(5 条):创作中消失、做完的卡 4 → 5 → 当做完了,照常按下载走完', async () => {
    const w = world({ startOnPress: 1, rows: look => (look === 1 ? [WORKING_ROW, ...olds(4)] : [DONE_ROW, ...olds(4)]) })
    expect(await run(w, 5)).toEqual({ kind: 'ready', path: '/Users/example/Downloads/a.mp4' })
    expect(w.presses()).toBe(1)
  })

  it('条数没变、可最上面那条播放时间上移了(新卡顶上来、最旧那条被挤出去)→ 也当做完', async () => {
    const w = world({ startOnPress: 1, rows: look => (look === 1 ? [WORKING_ROW, ...olds(5)] : [DONE_ROW, ...olds(4)]) })
    expect((await run(w, 5)).kind).toBe('ready')
    expect(w.presses()).toBe(1)
  })

  it('创作中消失、可做完的卡既没多也没上移(多半失败了)→ 不算做完,照旧等到上限、一下不按', async () => {
    const w = world({ rows: look => (look === 1 ? [WORKING_ROW, ...olds(4)] : olds(4)) })
    const got = await run(w, 5)
    expect(got).toMatchObject({ kind: 'failed' })
    expect((got as { why: string }).why).toContain('还没说做完')
    expect(w.presses()).toBe(0)
  })

  it('按生成之后一次都没见过「创作中」→ 这一条不生效', async () => {
    const w = world({ rows: () => olds(5) })
    expect(await run(w, 5)).toMatchObject({ kind: 'failed' })
    expect(w.presses()).toBe(0)
  })

  it('★可灵那份日志读没读到,开头记一行', async () => {
    const notes: string[] = []
    const w = world({ logThrows: true, rows: () => [], downloadAt: T0 + 30_000 })
    await waitKlingVideo({ since: T0, cardsBefore: 0 }, { ...w.deps, log: line => notes.push(line) })
    expect(notes.some(line => line.includes('可灵日志') && line.includes('读不到'))).toBe(true)
    expect(notes.some(line => line.includes(KLING_DONE_BY.download))).toBe(true)
  })
})
