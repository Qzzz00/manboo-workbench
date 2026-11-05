/**
 * 各家客户端的三态探测(2026-09-17「每个区域单独解锁」)。
 *
 * 这一份守三条:
 * 1. 没装 / 装了没接上 / 接上了,三态分得开,而且"查不出来"不冒充"没装";
 * 2. 探测是**缓存的**(mdfind 不能一秒跑一次);
 * 3. 体检页与看板问的是同一个探测函数(probeInstalled),不会给出两套答案。
 */
import { describe, expect, it } from 'vitest'
import type { SetupExecResult } from '../src/server/setup/io.ts'
import { bundleOfClient, claudeHookPaths, createClientScan, probeInstalled, wbHookCommands } from '../src/server/clientScan.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'

/** 假 mdfind:`installed` 里列了 bundle id 的算装了;`broken` 为真时整条命令跑不成。 */
function fakeIo(options: {
  installed?: readonly string[]
  files?: Record<string, string>
  broken?: boolean
  /** 真在、能执行的文件(钩子脚本)。缺省:固定位置上那个 agent-hook.sh 在。 */
  executables?: readonly string[]
  /** 在、但没有执行权限的文件。 */
  notExecutable?: readonly string[]
}) {
  const calls: string[][] = []
  return {
    calls,
    io: {
      async exec(cmd: readonly string[]): Promise<SetupExecResult> {
        calls.push([...cmd])
        if (options.broken === true) return { ok: false, code: -1, out: 'mdfind: command not found' }
        const query = cmd[1] ?? ''
        const found = (options.installed ?? []).find(bundle => query.includes(bundle))
        return { ok: true, code: 0, out: found === undefined ? '\n' : `/Applications/${found}.app\n` }
      },
      async readFile(path: string): Promise<string | undefined> {
        return options.files?.[path]
      },
      async stat(path: string) {
        const ok = (options.executables ?? [HOOK_SCRIPT]).includes(path)
        const noX = (options.notExecutable ?? []).includes(path)
        if (!ok && !noX) return undefined
        return { isFile: true, isDirectory: false, size: 1, mtimeMs: 0, executable: ok }
      },
    },
  }
}

const PATHS = {
  claudeSettings: '/home/.claude/settings.json',
  codexHooks: '/home/.codex/hooks.json',
  credentialsJson: '/home/.dsh/workbench/credentials.json',
}

/** 钩子脚本的固定位置(卡 R):各家的 hook 该指着它。 */
const HOOK_SCRIPT = '/home/.dsh/workbench/hooks/agent-hook.sh'
/** 工作台自己的那一条,指着固定位置(判据:命令指着工作台的 hook 脚本,新旧两种位置都认)。 */
const CLAUDE_HOOKS = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ command: `${HOOK_SCRIPT} claude` }] }] },
})
const CODEX_HOOKS = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ command: `${HOOK_SCRIPT} codex` }] }] },
})
/** 旧位置:指着开发仓库(维护者那台机器上现有的就是这种)。 */
const LEGACY_CLAUDE_HOOKS = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ command: '/Users/example/Documents/GitHub/desktop-workbench/workbench-plugin/bin/agent-hook.sh claude' }] }] },
})
/** 别人的钩子。headroom 在 Ben 的 ~/.codex/hooks.json 里现在就挂着两条。 */
const OTHER_HOOKS = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ command: '/opt/headroom/bin/headroom-hook.sh' }] }] },
})

describe('三态:没装 / 装了没接上 / 接上了', () => {
  it('一家都没装时,五家全是 installed:false,而且一个 how 都不给——没装的那家不催', async () => {
    const { io } = fakeIo({ installed: [] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.kimi).toEqual({ installed: false, connected: false })
    expect(view?.claude).toEqual({ installed: false, connected: false })
    // ★ 没装的那家绝不带 how:那是在给一件他没打算做的事写"下一步"。
    expect(Object.values(view ?? {}).every(cell => cell.how === undefined)).toBe(true)
  })

  it('装了没接上 → installed:true, connected:false,并且带一句能照做的 how', async () => {
    const { io } = fakeIo({ installed: [APP_BUNDLES.kimi ?? ''] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.kimi.installed).toBe(true)
    expect(view?.kimi.connected).toBe(false)
    expect(view?.kimi.how).toContain('登录 Kimi')
  })

  it('Kimi 网页登录过 → connected:true,how 整个缺席(接上了就没有"下一步"可说)', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.kimi ?? ''],
      // 真实形状(credentials.ts 落盘的):{ keys: { kimi_web } }。0.2.38 首发只认顶层,Ben 登过 Kimi 却被判"没接上"。
      files: { [PATHS.credentialsJson]: JSON.stringify({ keys: { kimi_web: 'refresh-token-xxx' } }) },
    })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.kimi).toEqual({ installed: true, connected: true })
  })

  it('Kimi 凭据扁平在顶层(旧/未来形状)也认', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.kimi ?? ''],
      files: { [PATHS.credentialsJson]: JSON.stringify({ kimi_web: 'refresh-token-xxx' }) },
    })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    expect((await scan.scan())?.kimi).toEqual({ installed: true, connected: true })
  })

  it('★没装的那家即使凭据在,也不算接上——装都没装,"接上了"是句假话', async () => {
    const { io } = fakeIo({
      installed: [],
      files: { [PATHS.credentialsJson]: JSON.stringify({ kimi_web: 'refresh-token-xxx' }) },
    })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.kimi).toEqual({ installed: false, connected: false })
  })

  /**
   * 2026-09-25 改(卡 fix/quota-and-slot-apps):原来是「装了即算接上」,额度面板顶上那一行
   * 因此写着「已接上 2 家:微信、企业微信」。维护者:「接微信和企业微信干嘛,这两家有额度???」
   * 「接上」只有一个意思 —— 额度数字取得到了;聊天应用永远不是,也没有「下一步」可说。
   */
  it('★微信/企微:永不算接上,也不给 how —— 它们没有额度,只在窗位清单里用 installed', async () => {
    const { io } = fakeIo({ installed: [APP_BUNDLES.wechat ?? '', APP_BUNDLES.wecom ?? ''] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.wechat).toEqual({ installed: true, connected: false })
    expect(view?.wecom).toEqual({ installed: true, connected: false })
    // 窗位清单那一头照旧认得它们装着。
    expect([...(scan.installedKeys() ?? [])].sort()).toEqual(['wechat', 'wecom'])
  })

  it('Kimi 没登过:how 说清要他自己登、登一次就好(工作台代不了这一步)', async () => {
    const { io } = fakeIo({ installed: [APP_BUNDLES.kimi ?? ''] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    const view = await scan.scan()
    expect(view?.kimi.connected).toBe(false)
    expect(view?.kimi.how).toContain('要你自己登一次')
    expect(view?.kimi.how).toContain('以后不用再登')
  })
})

describe('Claude / Codex:工作台自己的 hook 指对了才算接上(2026-09-17「钩子在就算」;卡 R 起指固定位置)', () => {
  it('hook 指着固定位置上的脚本、脚本真在能执行 → connected', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: { [PATHS.claudeSettings]: CLAUDE_HOOKS },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    const view = await scan.scan()
    expect(view?.claude.connected).toBe(true)
  })

  /**
   * 卡 R:维护者那台机器上的条目指着开发仓库。装上新版之后这里要说「没接上」,
   * 那颗「全部接上」才会出现、点一次把它们换到固定位置(与 09-17 决策记录第 8 条同一个道理)。
   */
  it('★hook 指着旧位置(开发仓库里)→ 不算接上,how 说点一下就帮你接上', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: { [PATHS.claudeSettings]: LEGACY_CLAUDE_HOOKS },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    const view = await scan.scan()
    expect(view?.claude.connected).toBe(false)
    expect(view?.claude.how).toContain('帮你接上')
  })

  it('★hook 指着固定位置,但脚本不在(同步没成)或不能执行 → 不算接上(那几条命令每次都在报错)', async () => {
    const missing = fakeIo({ installed: [APP_BUNDLES.claude ?? ''], files: { [PATHS.claudeSettings]: CLAUDE_HOOKS }, executables: [] })
    expect((await createClientScan({ io: missing.io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 }).scan())?.claude.connected).toBe(false)
    const noExec = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: { [PATHS.claudeSettings]: CLAUDE_HOOKS },
      executables: [],
      notExecutable: [HOOK_SCRIPT],
    })
    expect((await createClientScan({ io: noExec.io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 }).scan())?.claude.connected).toBe(false)
  })

  it('★hook 指到另一个仓库副本 → 不算接上(换机后的经典症状:钩子每次静默失败)', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: {
        [PATHS.claudeSettings]: JSON.stringify({
          hooks: { Stop: [{ hooks: [{ command: '/old/checkout/workbench-plugin/bin/agent-hook.sh claude' }] }] },
        }),
      },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    const view = await scan.scan()
    expect(view?.claude.connected).toBe(false)
    expect(view?.claude.how).toContain('帮你接上')
  })

  it('★别人的钩子(headroom 那两条)不算工作台接上了 —— 只数命令数会把没接过的机器判成接上了', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.codex ?? ''],
      files: { [PATHS.codexHooks]: OTHER_HOOKS },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    expect((await scan.scan())?.codex.connected).toBe(false)
  })

  it('工作台的那条与别人的那条并存 → 算接上(别人的条目不影响判断)', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.codex ?? ''],
      files: {
        [PATHS.codexHooks]: JSON.stringify({
          hooks: {
            Stop: [
              { hooks: [{ command: '/opt/headroom/bin/headroom-hook.sh' }] },
              { hooks: [{ command: `${HOOK_SCRIPT} codex` }] },
            ],
          },
        }),
      },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    expect((await scan.scan())?.codex.connected).toBe(true)
  })

  it('没给 hookScript 时只看"有没有工作台的钩子"(新旧两种位置都认)', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: { [PATHS.claudeSettings]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '/anywhere/workbench-plugin/bin/agent-hook.sh claude' }] }] } }) },
    })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    expect((await scan.scan())?.claude.connected).toBe(true)
  })

  it('配置文件在但一条 hook 都没有 → 不算接上', async () => {
    const { io } = fakeIo({
      installed: [APP_BUNDLES.claude ?? ''],
      files: { [PATHS.claudeSettings]: JSON.stringify({ model: 'opus' }) },
    })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    expect((await scan.scan())?.claude.connected).toBe(false)
  })

  it('Codex:工作台的钩子在才算接上;写坏了的 JSON 不算', async () => {
    const good = fakeIo({ installed: [APP_BUNDLES.codex ?? ''], files: { [PATHS.codexHooks]: CODEX_HOOKS } })
    const goodScan = createClientScan({ io: good.io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    expect((await goodScan.scan())?.codex.connected).toBe(true)

    const broken = fakeIo({ installed: [APP_BUNDLES.codex ?? ''], files: { [PATHS.codexHooks]: '{ 这不是 json' } })
    const brokenScan = createClientScan({ io: broken.io, paths: PATHS, now: () => 0 })
    expect((await brokenScan.scan())?.codex.connected).toBe(false)
  })

  /**
   * ★ 2026-09-17 Ben 拍板「钩子在就算」:**事件证据整个去掉了**。
   * 旧版这里断言的是"钩子没贴但收到过事件 → 也算接上";现在反过来钉:
   * 收到事件不改变结论,重启也不改变结论 —— 判据只有钩子这一条,跟那颗「帮你接上」的按钮一一对应。
   */
  it('★钩子没贴 → 一直是"没接上",view() 不接受任何事件证据', async () => {
    const { io } = fakeIo({ installed: [APP_BUNDLES.claude ?? ''] })
    const scan = createClientScan({ io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    await scan.scan()
    expect(scan.view()?.claude.connected).toBe(false)
    expect(scan.view()?.claude.how).toContain('帮你接上')
  })

  it('★结论跨"重启"稳定:同一份配置文件,重新造一个扫描器,答案一模一样', async () => {
    const files = { [PATHS.claudeSettings]: CLAUDE_HOOKS }
    const first = createClientScan({ io: fakeIo({ installed: [APP_BUNDLES.claude ?? ''], files }).io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    const second = createClientScan({ io: fakeIo({ installed: [APP_BUNDLES.claude ?? ''], files }).io, paths: PATHS, hookScript: HOOK_SCRIPT, now: () => 0 })
    expect((await first.scan())?.claude.connected).toBe(true)
    expect((await second.scan())?.claude.connected).toBe(true)
  })
})

describe('缓存:mdfind 不能一秒跑一次', () => {
  it('60 秒内 pump() 不重扫,过了才重扫', async () => {
    const { io, calls } = fakeIo({ installed: [] })
    let clock = 1_000_000
    const scan = createClientScan({ io, paths: PATHS, now: () => clock })
    await scan.scan()
    const afterFirst = calls.length
    expect(afterFirst).toBe(5) // 五家各一条 mdfind

    for (let i = 0; i < 30; i++) scan.pump()
    await Promise.resolve()
    expect(calls.length).toBe(afterFirst)

    clock += 60_001
    scan.pump()
    // pump 是 fire-and-forget,让出一拍让它跑完。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.length).toBe(afterFirst * 2)
  })

  it('还没扫过时 view() 是 undefined —— /state 那一格随之缺席,前台退回"全都显示"', () => {
    const { io } = fakeIo({ installed: [] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    expect(scan.view()).toBeUndefined()
    expect(scan.installedKeys()).toBeUndefined()
  })

  it('★mdfind 整个跑不成 → 回 undefined,而不是"五家都没装"', async () => {
    const { io } = fakeIo({ broken: true })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    expect(await scan.scan()).toBeUndefined()
    expect(scan.view()).toBeUndefined()
    expect(scan.installedKeys()).toBeUndefined()
  })
})

describe('installedKeys():窗位清单的默认值从这里来', () => {
  it('只列出真扫到的那几家', async () => {
    const { io } = fakeIo({ installed: [APP_BUNDLES.claude ?? '', APP_BUNDLES.wechat ?? ''] })
    const scan = createClientScan({ io, paths: PATHS, now: () => 0 })
    await scan.scan()
    expect([...(scan.installedKeys() ?? [])].sort()).toEqual(['claude', 'wechat'])
  })
})

describe('探测函数本身(体检页与看板共用的那一条)', () => {
  it('bundleOfClient 五家都查得到,而且跟 APP_BUNDLES 同一份', () => {
    expect(bundleOfClient('claude')).toBe(APP_BUNDLES.claude)
    expect(bundleOfClient('wecom')).toBe(APP_BUNDLES.wecom)
  })

  it('probeInstalled:找到给路径,没找到给 found:false,跑不成给 undefined', async () => {
    const hit = fakeIo({ installed: ['com.x.y'] })
    expect(await probeInstalled(hit.io, 'com.x.y')).toEqual({ found: true, path: '/Applications/com.x.y.app' })
    expect(await probeInstalled(hit.io, 'com.nope')).toEqual({ found: false })
    const dead = fakeIo({ broken: true })
    expect(await probeInstalled(dead.io, 'com.x.y')).toBeUndefined()
    // bundle id 没登记时不发命令,直接"查不出来"。
    expect(await probeInstalled(hit.io, '')).toBeUndefined()
  })

  it('claudeHookPaths 只数 hooks 那一棵,不把 statusLine 算成接上的证据', () => {
    const text = JSON.stringify({
      statusLine: { command: '/repo/bin/statusline.sh' },
      hooks: { Stop: [{ hooks: [{ command: '/repo/bin/hook.sh' }] }] },
    })
    const found = claudeHookPaths(text)
    expect(found.hooks).toBe(1)
    expect(found.paths).toEqual(['/repo/bin/hook.sh'])
  })

  it('wbHookCommands 只挑工作台自己的那几条(新旧两种位置都收,别人的钩子一条不收)', () => {
    const text = JSON.stringify({
      statusLine: { command: '/home/.dsh/workbench/hooks/claude-statusline.sh' },
      hooks: {
        Stop: [
          { hooks: [{ command: '/opt/headroom/bin/headroom-hook.sh' }] },
          { hooks: [{ command: `${HOOK_SCRIPT} claude` }] },
          { hooks: [{ command: '/repo/workbench-plugin/bin/agent-hook.sh claude' }] },
        ],
      },
    })
    // statusLine 不算(它只是显示),别人的钩子不算。
    expect(wbHookCommands(text)).toEqual([HOOK_SCRIPT, '/repo/workbench-plugin/bin/agent-hook.sh'])
    expect(wbHookCommands('{ 坏的 }')).toEqual([])
  })
})
