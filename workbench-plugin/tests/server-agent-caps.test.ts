// @vitest-environment node
/**
 * 各家能力体检(2026-09-25,卡 O「派活的眼睛」):六家各三格 —— 能聊天 / 能改本机文件 / 能把结果收回来。
 *
 * 每一格的依据都是**查出来的事实**(命令行登没登、壳连没连、窗口挡没挡),这里全用假的:
 * 一次也不真跑 `claude auth status`,一扇真窗口都不看。
 */
import { describe, expect, it } from 'vitest'
import type { CapFacts, CapWindowFact } from '../src/server/agentCaps.ts'
import {
  agentCapFrom, agentCapsFrom, canEdit, cliLoginOf, createAgentCaps, loginScript, windowFactOf,
} from '../src/server/agentCaps.ts'
import { appInstalledWith, appNameOf, createCliLoginProbe, createLoginLauncher, createWindowProbe } from '../src/server/agentCapsIo.ts'
import { fallbackTargets } from '../src/server/dispatchTargets.ts'

/** 没接发现引擎时体检哪几家(卡 Z:写过专门接法、有本机 App 的那几家;登记表在手时由它说)。 */
const FALLBACK_FAMILIES = fallbackTargets().map(one => one.id)

const AT = '2026-09-25T15:00:00.000Z'

/** 维护者这台 Mac 09-25 下午的样子:六家都装了、壳新、有授权;Codex 命令行登着,Claude 命令行没登。 */
function facts(patch: Partial<CapFacts> = {}): CapFacts {
  return {
    installed: { claude: true, codex: true, kimi: true, muse: true, manus: true, doubao: true },
    helper: { connected: true, authorized: true, newConversation: true, readReply: true },
    window: {},
    cli: {
      claude: { found: true, login: 'no', at: AT },
      codex: { found: true, login: 'yes', at: AT },
    },
    ...patch,
  }
}

describe('三格:查出来的,不是写死的', () => {
  it('★Claude 还没登录:能聊天(窗口)、能收回结果,但「能改本机文件」差一步 —— 说结果、给「帮我接上」,账号密码不经手', () => {
    const claude = agentCapFrom('claude', facts())
    expect(claude.cells.chat).toMatchObject({ state: 'ok', via: 'window' })
    expect(claude.cells.collect).toMatchObject({ state: 'ok', via: 'window' })
    expect(claude.cells.edit.state).toBe('no')
    expect(claude.cells.edit.note).toBe('要让 Claude 直接改你电脑上的文件,还差一步:登录一次')
    expect(claude.cells.edit.fix).toMatchObject({ kind: 'login_cli', family: 'claude', label: '帮我接上', desk_only: true })
    expect(claude.cells.edit.fix?.hint).toContain('工作台不经手')
    expect(claude.line).toBe('Claude:要让 Claude 直接改你电脑上的文件,还差一步:登录一次')
  })

  it('★按第一次装、不懂技术的人说(统筹 09-25 设计原则):体检那几格里不出现「命令行」「CLI」「auth」', () => {
    const cases = [
      facts(),
      facts({ cli: { claude: { found: false, login: 'unknown', at: AT }, codex: { found: false, login: 'unknown', at: AT } } }),
      facts({ cli: { claude: { found: true, login: 'yes', at: AT, proxy: { host: '127.0.0.1', port: 8787, local: true, reachable: false, source: 'launchd' } } } }),
      facts({ cli: { claude: { found: true, login: 'no', at: AT, proxy: { host: 'relay.example.com', port: 443, local: false, reachable: false } } } }),
    ]
    for (const one of cases) {
      const view = agentCapsFrom(one)
      // 只看给人看的字(note / hint / label / line),不看 `via:'cli'` 这种程序用的键。
      const words = JSON.stringify(view, (key, value: unknown) => (key === 'via' || key === 'kind' ? undefined : value))
      expect(words.match(/.{0,30}(命令行|CLI|auth|ANTHROPIC_).{0,30}/gi) ?? []).toEqual([])
    }
  })

  it('Codex 命令行登着:能改本机文件(命令行),并说清窗口里那个为什么不算', () => {
    const codex = agentCapFrom('codex', facts())
    expect(codex.cells.edit).toMatchObject({ state: 'ok', via: 'cli' })
    expect(codex.cells.edit.note).toContain('窗口里那个只能改它当前打开的项目')
    expect(codex.line).toBe('Codex:能聊天、能改本机文件、能把结果收回来')
  })

  it('Muse / Manus / 豆包:只能聊天 —— 「能改本机文件」是灰的(na),不给修法', () => {
    for (const family of ['muse', 'manus', 'doubao'] as const) {
      const row = agentCapFrom(family, facts())
      expect(row.cells.edit).toMatchObject({ state: 'na', note: '只能聊天,改不了你电脑上的文件' })
      expect(row.cells.edit.fix).toBeUndefined()
      expect(row.cells.chat.state).toBe('ok')
      expect(row.line).toContain('只能聊天')
    }
  })

  /**
   * Kimi(2026-10-22 卡 C):写代码的命令行有了,体检照三家一起查;登没登没有只本地的查法 → 这一格如实说「还没查到」,
   * 不猜、不说「不行」;没装那一份才说「还差一步:brew install kimi-code」。
   */
  it('Kimi:命令行在体检的范围内;没查过登录 = unknown;没装 = 差一步(brew install kimi-code)', () => {
    const row = agentCapFrom('kimi', facts())
    expect(row.cells.edit.state).toBe('unknown')
    expect(row.cells.edit.note).toContain('还没查到 Kimi 能不能直接改你电脑上的文件')
    const missing = agentCapFrom('kimi', facts({ cli: { kimi: { found: false, login: 'unknown', at: AT } } }))
    expect(missing.cells.edit).toMatchObject({ state: 'no', note: '要让 Kimi 直接改你电脑上的文件,还差一步:这台电脑上没装 Kimi Code CLI(brew install kimi-code),装好用 Kimi 的账号登录一次' })
    const loggedIn = agentCapFrom('kimi', facts({ cli: { kimi: { found: true, login: 'yes', at: AT } } }))
    expect(loggedIn.cells.edit).toMatchObject({ state: 'ok', via: 'cli' })
  })

  /**
   * ★ 2026-09-30 维护者拍板全删「带我过去」(见 `docs/决策记录.md` 末尾那一条)。
   * 原来这一格挂一颗把 Claude 叫到台前的键,点哪个写在键旁边;**键没了,话一个字不少** ——
   * 「在 Claude 那扇窗上点『取消』」并进这一格自己那句里,与 `ax_off` 那一支(一直就只有一句话)一个样子。
   */
  it('★窗口被对话框挡住:说清是哪家、点哪个;该他去点的那一下写成一句话,不摆键', () => {
    const blocked = facts({ window: { claude: { state: 'sheet', title: '存储', button: '取消', at: AT } } })
    const claude = agentCapFrom('claude', blocked)
    expect(claude.cells.chat.state).toBe('no')
    expect(claude.cells.chat.note).toBe('Claude 的窗口上开着一个对话框「存储」,话会打进那个框里 —— 先在 Claude 那扇窗上点「取消」,把对话框关掉')
    expect(claude.cells.chat.fix).toBeUndefined()
  })

  /**
   * 没窗 / 没输入框那两支同一条路:该他做的那一步写在 `note` 里,一颗键都不挂(2026-09-30 维护者拍板全删)。
   */
  it('★一扇窗都没有 / 找不到输入框:该做的那一步写进那句话里,不摆键', () => {
    const noWindow = agentCapFrom('claude', facts({ window: { claude: { state: 'no_window', at: AT } } }))
    expect(noWindow.cells.chat.state).toBe('no')
    expect(noWindow.cells.chat.note).toBe('Claude 开着,但一扇窗都没有(可能缩在程序坞里,或只剩菜单栏图标)—— 把 Claude 的窗口叫出来(点程序坞里的 Claude)')
    expect(noWindow.cells.chat.fix).toBeUndefined()
    const noInput = agentCapFrom('claude', facts({ window: { claude: { state: 'no_input', at: AT } } }))
    expect(noInput.cells.chat.note).toBe('找到了 Claude 的窗口,但没找到能写字的输入框(可能停在设置页之类)—— 把 Claude 切回对话页')
    expect(noInput.cells.chat.fix).toBeUndefined()
  })

  it('没装的那家整行灰掉(不催);壳没开着说「用不了」而不是「不行」;没授权给「去授权」;旧壳给「装新版」', () => {
    expect(agentCapFrom('muse', facts({ installed: { muse: false } })).line).toBe('这台电脑上没装 Muse')
    const down = agentCapFrom('kimi', facts({ helper: { connected: false, authorized: false, newConversation: false, readReply: false } }))
    expect(down.cells.chat.state).toBe('unknown')
    const noAx = agentCapFrom('kimi', facts({ helper: { connected: true, authorized: false, newConversation: true, readReply: true } }))
    expect(noAx.cells.chat.fix?.kind).toBe('grant_ax')
    const old = agentCapFrom('kimi', facts({ helper: { connected: true, authorized: true, newConversation: false, readReply: false } }))
    expect(old.cells.chat.fix?.kind).toBe('update_shell')
    expect(old.cells.collect.fix?.kind).toBe('update_shell')
  })

  it('登没登还没查过 = unknown(不许说成没登);还没有那一份(普通用户多半没有):Claude 给「帮我接上」(先装再登),Codex 说更新 ChatGPT', () => {
    expect(agentCapFrom('claude', facts({ cli: { claude: { found: true, login: 'unknown', at: AT } } })).cells.edit.state).toBe('unknown')
    const missing = agentCapFrom('claude', facts({ cli: { claude: { found: false, login: 'unknown', at: AT } } }))
    expect(missing.cells.edit).toMatchObject({ state: 'no', note: '要让 Claude 直接改你电脑上的文件,还差一步', fix: { kind: 'login_cli', label: '帮我接上' } })
    expect(missing.cells.edit.fix?.hint).toContain('先装好 Claude 改文件要用的那一份')
    const codexMissing = agentCapFrom('codex', facts({ cli: { codex: { found: false, login: 'unknown', at: AT } } }))
    // 2026-09-30 维护者拍板全删「带我过去」:原来这一格挂那颗键、「在 ChatGPT 里检查更新」写在键旁边;
    // 键没了,那句话并进 note(手机与电脑读的是同一句)。
    expect(codexMissing.cells.edit).toMatchObject({ state: 'no', note: '要让 Codex 直接改你电脑上的文件,还差一步:在 ChatGPT 里检查更新,把它更新到最新版;更新完这一格自己变' })
    expect(codexMissing.cells.edit.fix).toBeUndefined()
  })

  it('整张表那一句:能改本机文件的有谁、要修的有哪几样;canEdit 给派活挑手用', () => {
    const view = agentCapsFrom(facts({ window: { claude: { state: 'sheet', at: AT } } }))
    // 卡 Z(2026-09-25):体检哪几家由 Agent 登记表说(`extra.families`);没给就退回「写过专门接法、有 App 的那几家」。
    expect(view.agents.map(one => one.family)).toEqual([...FALLBACK_FAMILIES])
    expect(view.line).toBe('能直接改你电脑上的文件的:Codex;还差一步的:Claude(点那一格里的按钮)')
    expect(canEdit(view, 'codex')).toBe(true)
    expect(canEdit(view, 'claude')).toBe(false)
  })
})

describe('读壳 / 命令行的原话(只取结论,不留输出)', () => {
  it('壳 focus_input 的失败原话 → 窗口状况;新壳带对话框名字与按钮,老壳没有也认', () => {
    expect(windowFactOf('没送:com.anthropic.claudefordesktop 的窗口上开着一个对话框「存储」(存储 / 打开 / 设置之类,按钮:存储 / 取消),话会打进那个框里 —— 先把它关掉再派', AT))
      .toEqual({ state: 'sheet', title: '存储', button: '取消', at: AT })
    expect(windowFactOf('没送:com.anthropic.claudefordesktop 的窗口上开着一个对话框(存储 / 打开 / 设置之类),话会打进那个框里 —— 先把它关掉再派', AT))
      .toEqual({ state: 'sheet', at: AT })
    expect(windowFactOf('找不到窗口:com.moonshot.kimichat 没在运行', AT).state).toBe('not_running')
    expect(windowFactOf('找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)', AT).state).toBe('no_window')
    expect(windowFactOf('辅助功能通道关着:com.meta.endo 回 -25211', AT).state).toBe('ax_off')
    expect(windowFactOf('输入框没找到:im.manus.desktop —— 0 个候选', AT).state).toBe('no_input')
  })

  it('Claude `auth status --json` 只取 loggedIn 一个布尔;Codex `login status` 认 Logged in / Not logged in', () => {
    const claudeOut = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: '/x', projectsDirectory: '/y', analyticsDisabled: false })
    expect(cliLoginOf('claude', { code: 0, stdout: claudeOut, stderr: '' })).toEqual({ login: 'no' })
    expect(cliLoginOf('claude', { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' })).toEqual({ login: 'yes' })
    expect(cliLoginOf('claude', { code: 1, stdout: 'oops', stderr: '' }).login).toBe('unknown')
    expect(cliLoginOf('codex', { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' })).toEqual({ login: 'yes' })
    expect(cliLoginOf('codex', { code: 1, stdout: '', stderr: 'Not logged in\n' })).toEqual({ login: 'no' })
  })

  it('★「登录 X」的脚本只跑那家自己的登录命令,不碰凭据;路径里的单引号转义', () => {
    const script = loginScript('claude', "/Users/b'en/claude")
    expect(script).toContain(`'/Users/b'\\''en/claude' auth login --claudeai`)
    expect(script).toContain('工作台不经手')
    expect(script).not.toMatch(/credentials|token|password|keychain|security /i)
    expect(loginScript('codex', '/Applications/ChatGPT.app/Contents/Resources/codex')).toContain(`'/Applications/ChatGPT.app/Contents/Resources/codex' login`)
  })
})

describe('I/O 那一半(全是注入的)', () => {
  it('问登没登:找不到命令行不跑;跑的是那家自己的 status 命令', async () => {
    const calls: string[][] = []
    const probe = createCliLoginProbe({
      binOf: family => (family === 'claude' ? '/bin/claude' : undefined),
      exec: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '{"loggedIn":false}', stderr: '' } },
    })
    expect(await probe('claude')).toEqual({ login: 'no' })
    expect(calls).toEqual([['/bin/claude', 'auth', 'status', '--json']])
    expect((await probe('codex')).login).toBe('unknown')
    expect(calls.length).toBe(1)
  })

  it('「登录 X」:写 0700 的 .command、用「终端」打开;打不开如实说', async () => {
    const written: { file: string, text: string }[] = []
    const opened: string[] = []
    const launch = createLoginLauncher({
      dir: '/tmp/wb-login',
      binOf: () => '/bin/claude',
      writeScript: async (file, text) => { written.push({ file, text }) },
      openTerminal: async (file) => { opened.push(file); return true },
    })
    const done = await launch('claude')
    expect(done.ok).toBe(true)
    expect(done.note).toContain('工作台不经手')
    expect(written[0]?.file).toBe('/tmp/wb-login/login-claude.command')
    expect(opened).toEqual(['/tmp/wb-login/login-claude.command'])
    // 还没有那一份:Claude 照样开窗口(窗口里先用它官方的安装程序装,再登);Codex 那一份跟着 ChatGPT 走 → 说更新 ChatGPT。
    const scripts: string[] = []
    const missing = createLoginLauncher({ dir: '/tmp/x', binOf: () => undefined, writeScript: async (_file, text) => { scripts.push(text) }, openTerminal: async () => true })
    expect((await missing('claude')).ok).toBe(true)
    expect(scripts[0]).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    expect(scripts[0]).toContain('"$WB_BIN" auth login --claudeai')
    expect(await missing('codex')).toEqual({ ok: false, note: '要让 Codex 直接改你电脑上的文件,先把 ChatGPT 更新到最新版' })
    const noTerminal = createLoginLauncher({ dir: '/tmp/x', binOf: () => '/bin/claude', writeScript: async () => {}, openTerminal: async () => false })
    expect((await noTerminal('claude')).ok).toBe(false)
  })

  it('看窗口:focus_input(focus:false),不送字;失败原话 → 状况', async () => {
    const seen: unknown[] = []
    const probe = createWindowProbe({
      request: async (req) => { seen.push(req); throw new Error('没送:com.anthropic.claudefordesktop 的窗口上开着一个对话框(存储 / 打开 / 设置之类),话会打进那个框里 —— 先把它关掉再派') },
      now: () => new Date(AT),
    })
    expect((await probe('claude')).state).toBe('sheet')
    expect(seen).toEqual([{ op: 'focus_input', bundle_id: 'com.anthropic.claudefordesktop', index: 0, focus: false }])
  })
})

describe('服务:什么时候去查', () => {
  function service(opts: { login?: 'yes' | 'no', helperOk?: boolean } = {}) {
    let login: 'yes' | 'no' = opts.login ?? 'no'
    const cliCalls: string[] = []
    const probes: string[] = []
    let now = Date.parse(AT)
    const timers: (() => void)[] = []
    let changed = 0
    const caps = createAgentCaps({
      installed: () => true,
      helper: () => ({ connected: opts.helperOk !== false, authorized: opts.helperOk !== false, newConversation: true, readReply: true }),
      cliFound: () => true,
      cliLogin: async (family) => { cliCalls.push(family); return { login: family === 'codex' ? 'yes' : login } },
      probeWindow: async (family): Promise<CapWindowFact> => { probes.push(family); return { state: 'ok', at: AT } },
      now: () => new Date(now),
      onChanged: () => { changed += 1 },
      setTimer: (fn) => { timers.push(fn); return timers.length },
      clearTimer: () => { timers.length = 0 },
    })
    return {
      caps, cliCalls, probes, timers,
      setLogin: (value: 'yes' | 'no') => { login = value },
      advance: (ms: number) => { now += ms },
      changed: () => changed,
    }
  }

  it('check:只问写代码那三家的命令行(2026-10-22 卡 C 起含 Kimi);window:true 才看窗口(没授权就不看)', async () => {
    const { caps, cliCalls, probes } = service()
    const view = await caps.check()
    expect(cliCalls).toEqual(['claude', 'codex', 'kimi'])
    expect(probes).toEqual([])
    expect(view.checked_at).toBe(AT)
    expect(view.agents.find(one => one.family === 'claude')?.cells.edit.state).toBe('no')
    await caps.check({ window: true })
    expect(probes).toEqual([...FALLBACK_FAMILIES])
    const noAx = service({ helperOk: false })
    await noAx.caps.check({ window: true })
    expect(noAx.probes).toEqual([])
  })

  it('pump:10 分钟内不重查', async () => {
    const { caps, cliCalls, advance } = service()
    caps.pump()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cliCalls.length).toBe(3)
    caps.pump()
    expect(cliCalls.length).toBe(3)
    advance(11 * 60_000)
    caps.pump()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cliCalls.length).toBe(6)
  })

  it('★点了「登录 Claude」:每几秒看一眼,登好了停、那一格变绿', async () => {
    const { caps, timers, setLogin } = service()
    await caps.check()
    caps.waitLogin('claude')
    expect(caps.view().login_wait?.family).toBe('claude')
    expect(timers.length).toBe(1)
    timers[0]?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(caps.view().agents.find(one => one.family === 'claude')?.cells.edit.state).toBe('no')
    setLogin('yes')
    timers[0]?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(caps.view().agents.find(one => one.family === 'claude')?.cells.edit.state).toBe('ok')
    expect(caps.view().login_wait).toBeUndefined()
    expect(timers.length).toBe(0)
  })
})

describe('装没装:app 名字从 agentSources 里那条「没跑就拉起来」的命令取(卡 Z:不另起一份家名单)', () => {
  it('Codex 就是 ChatGPT.app;GPT 没有本机应用;~/Applications 也认', () => {
    expect(appNameOf('codex')).toBe('ChatGPT')
    expect(appNameOf('doubao')).toBe('Doubao')
    expect(appNameOf('gpt')).toBeUndefined()
    const seen = new Set(['/Users/x/Applications/Manus.app', '/Applications/Claude.app'])
    const installed = appInstalledWith('/Users/x', path => seen.has(path))
    expect(installed('manus')).toBe(true)
    expect(installed('claude')).toBe(true)
    expect(installed('kimi')).toBe(false)
    expect(installed('gpt')).toBe(false)
  })
})

describe('体检那几家来自 Agent 登记表(2026-09-25,卡 Z)', () => {
  it('★登记表里新接上一家 → 体检表上多一行,名字是它自己的;只能聊天、改不了文件那一格是灰的', () => {
    const view = agentCapsFrom(facts({ installed: { 'com.example.fooai': true } as never }), {
      families: [{ id: 'com.example.fooai', title: 'Foo AI' }],
    })
    expect(view.agents.map(one => one.family)).toEqual(['com.example.fooai'])
    const row = view.agents[0]
    expect(row?.title).toBe('Foo AI')
    expect(row?.cells.chat.state).toBe('ok')
    expect(row?.cells.chat.note).toContain('Foo AI')
    // 没为它写过命令行:不是「坏了」,是「没有」—— 灰的、不给修法(D13)。
    expect(row?.cells.edit).toMatchObject({ state: 'na' })
    expect(row?.cells.edit.fix).toBeUndefined()
  })

  it('★他说「这不是 Agent」→ 登记表里没有它 → 体检表上也没有它', () => {
    const view = agentCapsFrom(facts({}), { families: [{ id: 'claude', title: 'Claude' }] })
    expect(view.agents.map(one => one.family)).toEqual(['claude'])
  })
})
