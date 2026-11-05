/**
 * 通话护栏(2026-09-25,卡 fix/call-under-load-and-name):通话中把构建 / 测试调到后台档,挂断还原。
 * 这里钉住的是「碰谁、不碰谁、什么时候还原」—— `ps` 与 `taskpolicy` 都是假的,用例不碰真进程。
 */
import { describe, expect, it } from 'vitest'
import {
  LoadGuard,
  isHeavyCommand,
  loadGuardSettingsOf,
  parsePsTable,
  pickLoadTargets,
  summarizeTools,
  toolNameOf,
  type PsRow,
} from '../src/loadGuard.ts'

const VITEST_FORK = '/Users/example/.dsh/node/bin/node /Users/example/proj/node_modules/.pnpm/vitest@4.1.11_@types+node@25.9.6/node_modules/vitest/dist/workers/forks.js'
const VITEST_MAIN = 'node /Users/example/proj/workbench-plugin/node_modules/.bin/../vitest/vitest.mjs run --reporter=dot'
const TSC = 'node /Users/example/proj/node_modules/typescript/bin/tsc --noEmit'
const ESBUILD = '/Users/example/proj/node_modules/.pnpm/@esbuild+darwin-arm64@0.25.12/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.12 --ping'
const WORKER = '/Users/example/.dsh/node/bin/node /Users/example/.dsh/channel-worker/src/main.ts'
const DSH = '/Users/example/.dsh/node/bin/node /Users/example/.dsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open'
const CODEX_RENDERER = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/153.0/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer'
const CLAUDE_CLI = '/Users/example/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude --output-format stream-json'

describe('认得出的构建 / 测试(isHeavyCommand)', () => {
  it.each([
    ['vitest 的 fork 进程(pnpm 目录结构)', VITEST_FORK],
    ['vitest 主进程(.bin/../vitest)', VITEST_MAIN],
    ['tsc', TSC],
    ['esbuild 服务进程', ESBUILD],
    ['pnpm install', '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs install --offline'],
    ['npm run build', 'npm run build'],
    ['cargo build', '/Users/example/.cargo/bin/cargo build --release'],
    ['Xcode 里的编译器(Contents/Developer 不算 App 本体)', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c'],
    ['ffmpeg 转码', '/opt/homebrew/bin/ffmpeg -i in.mp4 out.wav'],
    ['whisper 本机转写', '/opt/homebrew/bin/whisper-cli -m ggml-small.bin -f a.wav'],
  ])('%s → 算', (_label, command) => {
    expect(isHeavyCommand(command)).toBe(true)
  })

  it.each([
    ['工人自己', WORKER],
    ['DSH(工人的祖先,8791 在它里面)', DSH],
    ['8792', '/Users/example/.dsh/node/bin/node /Users/example/.dsh/butler-server/server/index.cjs'],
    ['livekit-server', '/opt/homebrew/bin/livekit-server --config lk.yaml'],
    ['桌面 App 的 Helper(界面要跟手)', CODEX_RENDERER],
    ['装在 .app 里的命令行本体', CLAUDE_CLI],
    ['普通 node 服务', 'node server.js'],
    ['编辑器开着 vitest.config.ts', 'vim vitest.config.ts'],
    ['grep 一下 vitest', 'grep -rn vitest src'],
  ])('%s → 不算', (_label, command) => {
    expect(isHeavyCommand(command)).toBe(false)
  })

  it('日志里的名字:vitest×2、tsc', () => {
    expect(toolNameOf(VITEST_FORK)).toBe('vitest')
    expect(toolNameOf(TSC)).toBe('tsc')
    expect(summarizeTools([VITEST_FORK, VITEST_MAIN, TSC])).toBe('vitest×2、tsc')
  })
})

describe('进程表(parsePsTable)', () => {
  it('命令行里带空格照样整行拿到;读不懂的行跳过', () => {
    const rows = parsePsTable([
      '  123     1   501  31 /Applications/Foo Bar.app/Contents/MacOS/Foo Bar --flag',
      'garbage line',
      '  456   123   501   4 node x.js',
    ].join('\n'))
    expect(rows).toEqual([
      { pid: 123, ppid: 1, uid: 501, pri: 31, command: '/Applications/Foo Bar.app/Contents/MacOS/Foo Bar --flag' },
      { pid: 456, ppid: 123, uid: 501, pri: 4, command: 'node x.js' },
    ])
  })
})

/** 一张小进程表:launchd → DSH → 工人 → (解 mp3 的 ffmpeg);另有 Codex App 起的一棵 vitest。 */
function table(): PsRow[] {
  return [
    { pid: 1, ppid: 0, uid: 0, pri: 31, command: '/sbin/launchd' },
    { pid: 100, ppid: 1, uid: 501, pri: 31, command: DSH },
    { pid: 200, ppid: 100, uid: 501, pri: 31, command: WORKER },
    { pid: 201, ppid: 200, uid: 501, pri: 31, command: '/opt/homebrew/bin/ffmpeg -i pipe:0 -f s16le pipe:1' },
    { pid: 300, ppid: 1, uid: 501, pri: 31, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 301, ppid: 300, uid: 501, pri: 31, command: '/bin/zsh -c pnpm test' },
    { pid: 302, ppid: 301, uid: 501, pri: 31, command: VITEST_MAIN },
    { pid: 303, ppid: 302, uid: 501, pri: 31, command: VITEST_FORK },
    { pid: 304, ppid: 302, uid: 501, pri: 4, command: VITEST_FORK },
    { pid: 400, ppid: 1, uid: 502, pri: 31, command: TSC },
  ]
}

describe('这一刻调谁(pickLoadTargets)', () => {
  it('只调同一个用户的构建;工人、它的祖先与子孙、已经在后台档的、别的用户的,一个不碰', () => {
    const picked = pickLoadTargets(table(), { selfPid: 200, uid: 501 }).map(row => row.pid)
    // 302(vitest 主进程)、303(fork);304 已经是 4 档;201 是工人自己的 ffmpeg;400 是别的用户。
    expect(picked).toEqual([302, 303])
  })

  it('onlyUnder:只碰那个进程的子孙(压测用,别的会话的测试不碰)', () => {
    expect(pickLoadTargets(table(), { selfPid: 200, uid: 501, onlyUnder: 999 })).toEqual([])
    expect(pickLoadTargets(table(), { selfPid: 200, uid: 501, onlyUnder: 302 }).map(row => row.pid)).toEqual([303])
  })
})

function harness(options: { active?: boolean, failPids?: number[], maxActiveMs?: number } = {}) {
  let active = options.active ?? true
  let rows = table()
  let clock = 0
  const lines: string[] = []
  const calls: { pid: number, on: boolean }[] = []
  const syncCalls: number[] = []
  const guard = new LoadGuard({
    isActive: () => active,
    log: line => lines.push(line),
    listProcesses: async () => rows.map(row => `${row.pid} ${row.ppid} ${row.uid} ${row.pri} ${row.command}`).join('\n'),
    setBackground: async (pid, on) => {
      calls.push({ pid, on })
      return !(options.failPids ?? []).includes(pid)
    },
    setBackgroundSync: pid => syncCalls.push(pid),
    listProcessesSync: () => rows.map(row => `${row.pid} ${row.ppid} ${row.uid} ${row.pri} ${row.command}`).join('\n'),
    selfPid: 200,
    uid: 501,
    ...(options.maxActiveMs === undefined ? {} : { maxActiveMs: options.maxActiveMs }),
    now: () => clock,
  })
  return {
    guard,
    lines,
    calls,
    syncCalls,
    setActive: (value: boolean) => { active = value },
    setRows: (next: PsRow[]) => { rows = next },
    advance: (ms: number) => { clock += ms },
  }
}

describe('护栏本体(LoadGuard)', () => {
  it('不在通话:一个都不碰', async () => {
    const h = harness({ active: false })
    await h.guard.tick()
    expect(h.calls).toEqual([])
    expect(h.guard.held).toBe(0)
  })

  it('在通话:调到后台档、记一行「压着几个」;下一拍不重复调', async () => {
    const h = harness()
    await h.guard.tick()
    expect(h.calls).toEqual([{ pid: 302, on: true }, { pid: 303, on: true }])
    expect(h.guard.held).toBe(2)
    expect(h.lines.join('\n')).toContain('通话护栏:通话中,把 2 个构建/测试进程调到后台档(vitest×2)')
    await h.guard.tick()
    expect(h.calls).toHaveLength(2)
  })

  it('新冒出来的下一拍接着调', async () => {
    const h = harness()
    await h.guard.tick()
    h.setRows([...table(), { pid: 305, ppid: 302, uid: 501, pri: 31, command: VITEST_FORK }])
    await h.guard.tick()
    expect(h.calls.at(-1)).toEqual({ pid: 305, on: true })
    expect(h.guard.held).toBe(3)
  })

  it('挂断:只还原自己调过的,而且命令行要对得上(pid 被复用了就不动)', async () => {
    const h = harness()
    await h.guard.tick()
    // 303 走了,它的 pid 被一个无关的进程复用了。
    h.setRows(table().map(row => (row.pid === 303 ? { ...row, command: 'node something-else.js' } : row)))
    h.setActive(false)
    await h.guard.tick()
    expect(h.calls.filter(call => !call.on)).toEqual([{ pid: 302, on: false }])
    expect(h.guard.held).toBe(0)
    expect(h.lines.at(-1)).toContain('通话结束,还原了 1 个进程的档位')
  })

  it('挂断:压着的进程在通话中新起的子孙(继承了后台档)一起还原;别处本来就在后台档的不碰', async () => {
    const h = harness()
    await h.guard.tick()
    // 通话中 vitest 主进程(302,压着)又起了一批 fork:它们一出生就是后台档(4),不在「调过的」名单里。
    h.setRows([
      ...table(),
      { pid: 306, ppid: 302, uid: 501, pri: 4, command: VITEST_FORK },
      { pid: 307, ppid: 306, uid: 501, pri: 4, command: 'node worker-helper.js' },
      // 与压着的进程无关、自己就在后台档的:不碰。
      { pid: 500, ppid: 1, uid: 501, pri: 4, command: 'node something-backgrounded-by-its-owner.js' },
    ])
    h.setActive(false)
    await h.guard.tick()
    const restored = h.calls.filter(call => !call.on).map(call => call.pid)
    expect(restored).toEqual(expect.arrayContaining([302, 303, 306, 307]))
    expect(restored).not.toContain(500)
    // 304 在我们调 302 之前就已经是后台档了(别人定的),虽然是 302 的子孙,也不碰。
    expect(restored).not.toContain(304)
    expect(h.lines.at(-1)).toContain('连同它们通话中新起的 2 个子进程')
  })

  it('调档失败的不记着(也就不会去还原它)', async () => {
    const h = harness({ failPids: [303] })
    await h.guard.tick()
    expect(h.guard.held).toBe(1)
  })

  it('一通电话护满上限就先放开,这一通不再护;挂断之后下一通照常', async () => {
    const h = harness({ maxActiveMs: 1000 })
    await h.guard.tick()
    expect(h.guard.held).toBe(2)
    h.advance(1500)
    await h.guard.tick()
    expect(h.guard.held).toBe(0)
    expect(h.lines.at(-1)).toContain('先放开')
    h.setRows([...table(), { pid: 305, ppid: 302, uid: 501, pri: 31, command: VITEST_FORK }])
    await h.guard.tick()
    expect(h.guard.held).toBe(0)
    h.setActive(false)
    await h.guard.tick()
    h.setActive(true)
    await h.guard.tick()
    expect(h.guard.held).toBe(3)
  })

  it('工人要退出:同步还原压着的那几个,连同继承了后台档的子孙', async () => {
    const h = harness()
    await h.guard.tick()
    h.setRows([...table(), { pid: 306, ppid: 302, uid: 501, pri: 4, command: VITEST_FORK }])
    h.guard.releaseSync()
    expect(h.syncCalls).toEqual(expect.arrayContaining([302, 303, 306]))
    expect(h.guard.held).toBe(0)
  })
})

describe('开关(loadGuardSettingsOf)', () => {
  it('缺省在 macOS 上开', () => {
    expect(loadGuardSettingsOf({}, 'darwin')).toEqual({ on: true })
  })
  it('WORKBENCH_CHANNEL_LOAD_GUARD=off 关', () => {
    expect(loadGuardSettingsOf({ WORKBENCH_CHANNEL_LOAD_GUARD: 'off' }, 'darwin').on).toBe(false)
  })
  it('别的平台不开,如实说一句', () => {
    const got = loadGuardSettingsOf({}, 'linux')
    expect(got.on).toBe(false)
    expect(got.note).toContain('只在 macOS 上有')
  })
  it('压测把范围收窄到某个进程的子孙', () => {
    expect(loadGuardSettingsOf({ WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER: '4242' }, 'darwin')).toEqual({ on: true, onlyUnder: 4242 })
  })
})
