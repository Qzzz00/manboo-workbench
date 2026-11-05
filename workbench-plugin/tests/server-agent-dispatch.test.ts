// @vitest-environment node
/**
 * 派活给别家 Agent 的内核(2026-09-21,参赛冲刺卡 ④)。
 *
 * 这一份钉住的是**四件会骗人的事**:
 *
 * 1. 没装的那家不许被说成装了(Kimi Code CLI 2.2.0 起真有一份:2026-10-22 维护者 brew 装好并登录,
 *    `kimi -p … --output-format stream-json` 实测取回结果 —— 探不到就如实说没装,不编一条猜的);
 * 2. 命令行不许含 `--dangerously-*`(派一次活不该把整台电脑交出去);
 * 3. 目录门不许被前缀骗过去(`/a/bb` 不在 `/a/b` 底下);
 * 4. 进度那句话三档各一句,失败时必须带原因(拿不到原因就说拿不到)。
 *
 * 全是纯函数,**一个子进程都不起**、一个字节都不写盘。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CODEX_BUNDLED,
  cliFor,
  claudeCliArgv,
  claudeManagedDir,
  cliAllowedFor,
  cliIsBackupFor,
  dispatchCommand,
  dispatchHands,
  dispatchCwdAllowed,
  apiIsHandFor,
  dispatchFamilyOf,
  dispatchNote,
  dispatchSkillBody,
  kimiCliArgv,
  kimiResultOf,
  newestVersionDir,
  resolveAgentCli,
} from '../src/server/agentDispatch.ts'
import { DISPATCH_FAMILY_TITLES, isAgentDispatchFamily } from '../src/protocol.ts'
import { FAMILY_SOURCES } from '../src/server/agentSources.ts'
import { dispatchTargets, fallbackTargets, handsOf } from '../src/server/dispatchTargets.ts'

const HOME = '/Users/someone'
const MANAGED = claudeManagedDir(HOME)
const CLAUDE_BIN = `${MANAGED}/2.1.275/claude.app/Contents/MacOS/claude`

function probe(files: readonly string[], options: { pathEnv?: string, dirs?: Record<string, readonly string[]> } = {}) {
  return {
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    home: HOME,
    exists: (file: string) => files.includes(file),
    listDir: (dir: string) => options.dirs?.[dir] ?? [],
  }
}

describe('认出「让谁做」(只给打字建事项当兜底)', () => {
  it('三家各认得出来,大小写不管', () => {
    expect(dispatchFamilyOf('让 Codex 把首页改了')).toBe('codex')
    expect(dispatchFamilyOf('叫 claude 看看这个报错')).toBe('claude')
    expect(dispatchFamilyOf('让 KIMI 写个文案')).toBe('kimi')
    expect(dispatchFamilyOf('这件交给 Codex')).toBe('codex')
    // 走接口那两家(2026-09-22)。豆包认中文,GPT 认英文——他两种都会写。
    expect(dispatchFamilyOf('让 GPT 写条小红书文案')).toBe('gpt')
    expect(dispatchFamilyOf('叫豆包把这段润色一下')).toBe('doubao')
    expect(dispatchFamilyOf('交给 doubao 改一版')).toBe('doubao')
  })

  it('没点名 → undefined(**不默认派给谁**)', () => {
    expect(dispatchFamilyOf('把展示台的黄历接上')).toBeUndefined()
  })

  it('**提到名字不等于派活**:问一句话不算(不然它会去起一个子进程查额度)', () => {
    expect(dispatchFamilyOf('Codex 那边额度还剩多少')).toBeUndefined()
    expect(dispatchFamilyOf('豆包今天是不是又更新了')).toBeUndefined()
    expect(dispatchFamilyOf('Claude 的窗口是不是卡住了')).toBeUndefined()
  })

  it('一句话点到两家 → 按先出现的那家', () => {
    expect(dispatchFamilyOf('让 Codex 做,别找 Claude')).toBe('codex')
  })
})

describe('这家的命令行在哪', () => {
  it('Codex:PATH 上有就用 PATH 上那份', () => {
    const cli = resolveAgentCli('codex', probe(['/opt/homebrew/bin/codex'], { pathEnv: '/usr/bin:/opt/homebrew/bin' }))
    expect(cli).toEqual({ found: true, family: 'codex', bin: '/opt/homebrew/bin/codex', source: 'path' })
  })

  it('Codex:PATH 上没有 → 退回 ChatGPT.app 自带的那份(2026-09-07 事故之后的同一条兜底)', () => {
    const cli = resolveAgentCli('codex', probe([CODEX_BUNDLED], { pathEnv: '/usr/bin' }))
    expect(cli).toEqual({ found: true, family: 'codex', bin: CODEX_BUNDLED, source: 'bundled' })
  })

  it('Codex:两处都没有 → 如实说没有,而且那句话里有「没有命令行」', () => {
    const cli = resolveAgentCli('codex', probe([], { pathEnv: '/usr/bin' }))
    expect(cli.found).toBe(false)
    if (cli.found) return
    expect(cli.why).toContain('没有命令行')
  })

  it('Claude:桌面端管的那堆版本里挑最新的一份', () => {
    const cli = resolveAgentCli('claude', probe([CLAUDE_BIN], {
      pathEnv: '/usr/bin',
      dirs: { [MANAGED]: ['2.1.9', '2.1.260', '2.1.275'] },
    }))
    expect(cli).toEqual({ found: true, family: 'claude', bin: CLAUDE_BIN, source: 'bundled' })
  })

  it('Claude:一个版本目录都没有 → 没有', () => {
    expect(resolveAgentCli('claude', probe([], { pathEnv: '/usr/bin' })).found).toBe(false)
  })

  it('Kimi:**Kimi Code CLI 2.2.0 起真有**(2026-10-22 实测):PATH 上探得到;装在哪说哪', () => {
    const cli = resolveAgentCli('kimi', probe(['/opt/homebrew/bin/kimi'], { pathEnv: '/usr/bin:/opt/homebrew/bin' }))
    expect(cli).toEqual({ found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' })
    // DSH 的 PATH 里常常没有 /opt/homebrew/bin:照探那一份固定的 Homebrew 位置(同 Claude 的 ~/.local/bin 兜法)。
    const homebrew = resolveAgentCli('kimi', probe(['/opt/homebrew/bin/kimi'], { pathEnv: '/usr/bin' }))
    expect(homebrew).toEqual({ found: true, family: 'kimi', bin: '/opt/homebrew/bin/kimi', source: 'path' })
  })

  it('Kimi:两处都没有 → 如实说没装 Kimi Code CLI,给装法(不编一条猜的命令)', () => {
    const cli = resolveAgentCli('kimi', probe([
      '/Applications/Kimi.app/Contents/Resources/resources/kimiim-cli',
      '/Applications/Kimi.app/Contents/Resources/resources/daimon-bundle/bin/daimon',
    ], { pathEnv: '/usr/bin' }))
    expect(cli.found).toBe(false)
    if (cli.found) return
    expect(cli.why).toContain('没装 Kimi Code CLI')
    expect(cli.why).toContain('brew install kimi-code')
  })
})

describe('版本目录挑最新', () => {
  it('按数字段比,不是按字典序(2.1.275 > 2.1.9)', () => {
    expect(newestVersionDir(['2.1.9', '2.1.275', '2.1.260'])).toBe('2.1.275')
  })

  it('一个都认不出 → undefined(不猜一个)', () => {
    expect(newestVersionDir(['latest', 'tmp'])).toBeUndefined()
    expect(newestVersionDir([])).toBeUndefined()
  })
})

describe('非交互那条命令', () => {
  const codex = resolveAgentCli('codex', probe([CODEX_BUNDLED], { pathEnv: '' }))
  const claude = resolveAgentCli('claude', probe([CLAUDE_BIN], { pathEnv: '', dirs: { [MANAGED]: ['2.1.275'] } }))

  it('Codex:exec + 自己的目录参数 + 结果文件', () => {
    const command = dispatchCommand(codex, { prompt: '加一个 README', cwd: '/repo', outputFile: '/tmp/out.txt' })
    expect(command).toEqual({
      bin: CODEX_BUNDLED,
      argv: ['exec', '-C', '/repo', '-s', 'workspace-write', '-o', '/tmp/out.txt', '加一个 README'],
      cwd: '/repo',
      outputFile: '/tmp/out.txt',
      resultFrom: 'file',
    })
  })

  /**
   * A3(2026-09-22,Ben 定):「Claude 命令行不登,Claude 走窗口那只手,命令行只作 Codex 备用。」
   * 所以**这台电脑上 Claude 那份命令行照旧探得到**(探到的是事实),但**不给它拼命令** ——
   * 拼出来就必定失败在 `Not logged in`,而那次失败会挂在卡上,看起来像是那家坏了。
   */
  it('★Claude:探得到那份命令行,但聊天的活一律不拼命令(它归窗口那只手)', () => {
    expect(claude.found).toBe(true)
    expect(dispatchCommand(claude, { prompt: '看看这个报错', cwd: '/repo' })).toBeUndefined()
    expect(dispatchCommand(claude, { prompt: '看看这个报错', cwd: '/repo', kind: 'chat' })).toBeUndefined()
  })

  /**
   * 2026-09-25(卡 O,设计第 3、6 条):**写代码的活**要「能改本机文件」的那只手 —— Claude 的命令行在这一类活里放开。
   * 沙箱开着、改文件不问、要问人的一步直接拒(不挂着等一个不在电脑前的人),结果走标准输出那条 JSON。
   */
  it('★Claude 写代码的活:命令行 -p + acceptEdits + 不问人 + 沙箱设置,结果从标准输出读', () => {
    const command = dispatchCommand(claude, { prompt: '修一下首页球的显示问题', cwd: '/repo', kind: 'code' })
    expect(command?.bin).toBe(claude.found ? claude.bin : '')
    expect(command?.cwd).toBe('/repo')
    expect(command?.resultFrom).toBe('stdout_json')
    expect(command?.argv).toEqual(expect.arrayContaining(['-p', '修一下首页球的显示问题', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/repo', '--permission-prompts', 'none', '--settings']))
    const settings = JSON.parse(command?.argv[(command?.argv.indexOf('--settings') ?? 0) + 1] as string) as { sandbox: Record<string, unknown> }
    expect(settings.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false })
    expect(command?.argv.some(arg => arg.startsWith('--dangerously') || arg === 'bypassPermissions')).toBe(false)
  })

  it('写代码的活 Codex 仍是 exec -C -s workspace-write;Kimi Code CLI 写代码的活也走命令行(2026-10-22 卡 C)', () => {
    expect(dispatchCommand(codex, { prompt: 'x', cwd: '/repo', outputFile: '/tmp/o', kind: 'code' })?.argv.slice(0, 5)).toEqual(['exec', '-C', '/repo', '-s', 'workspace-write'])
    expect(cliAllowedFor('kimi', 'code')).toBe(true)
    expect(cliAllowedFor('kimi', 'chat')).toBe(false)
    expect(cliAllowedFor('claude', 'code')).toBe(true)
    expect(cliAllowedFor('claude', 'chat')).toBe(false)
    expect(cliAllowedFor('codex', undefined)).toBe(true)
  })

  it('**没有一条命令带 --dangerously-***(派一次活不该把整台电脑交出去)', () => {
    const command = dispatchCommand(codex, { prompt: 'x', cwd: '/repo', outputFile: '/tmp/o' })
    expect(command?.argv.some(arg => arg.startsWith('--dangerously'))).toBe(false)
  })

  it('没有命令行的那家 → 拼不出命令(undefined),不退回一条猜的', () => {
    const kimi = resolveAgentCli('kimi', probe([], { pathEnv: '' }))
    expect(dispatchCommand(kimi, { prompt: 'x', cwd: '/repo' })).toBeUndefined()
  })
})

/**
 * Kimi 命令行那只手(2026-10-22,卡「名片补四样与Kimi命令行手」C;依据:决策记录「先配 Kimi 命令行编程智能体」、
 * 真跑样本 `tests/fixtures/kimi-stream-json/sample.jsonl` = 本机 `kimi -p "说一句话" --output-format stream-json` 的实测输出)。
 */
describe('Kimi 命令行那只手', () => {
  const KIMI_BIN = '/opt/homebrew/bin/kimi'
  const kimi = resolveAgentCli('kimi', probe([KIMI_BIN], { pathEnv: '' }))

  it('cliFor:PATH 上探得到;给了 bin 就用名片写的那一份(不再探)', () => {
    const fromPath = cliFor('kimi', { probe: probe([KIMI_BIN], { pathEnv: '/opt/homebrew/bin' }) })
    expect(fromPath).toEqual({ found: true, family: 'kimi', bin: KIMI_BIN, source: 'path' })
    const pinned = cliFor('kimi', { bin: '/usr/local/bin/kimi', probe: probe([], { pathEnv: '' }) })
    expect(pinned).toEqual({ found: true, family: 'kimi', bin: '/usr/local/bin/kimi', source: 'path' })
    const missing = cliFor('kimi', { probe: probe([], { pathEnv: '/usr/bin' }) })
    expect(missing.found).toBe(false)
    if (missing.found) return
    expect(missing.why).toContain('没装 Kimi Code CLI')
  })

  it('kimiCliArgv:-p + stream-json + --agent-file(相对工作目录化成绝对);名片有模型才加 -m', () => {
    expect(kimiCliArgv('把 X 改了', '/worktree', {})).toEqual([
      '-p', '把 X 改了', '--output-format', 'stream-json', '--agent-file', `${'/worktree'}/docs/卡/agents/kimi-coder.md`,
    ])
    expect(kimiCliArgv('把 X 改了', '/worktree', { instructions: 'agents/coder.md' })).toEqual([
      '-p', '把 X 改了', '--output-format', 'stream-json', '--agent-file', '/worktree/agents/coder.md',
    ])
    expect(kimiCliArgv('把 X 改了', '/worktree', { model: 'kimi-for-coding' })).toEqual([
      '-p', '把 X 改了', '--output-format', 'stream-json', '--agent-file', `${'/worktree'}/docs/卡/agents/kimi-coder.md`, '-m', 'kimi-for-coding',
    ])
  })

  it('dispatchCommand:写代码的活拼 kimi -p(工作目录靠子进程 cwd,没有目录参数);不写 --dangerously-*', () => {
    const command = dispatchCommand(kimi, { prompt: '把 X 改了', cwd: '/worktree', kind: 'code' })
    expect(command?.bin).toBe(KIMI_BIN)
    expect(command?.cwd).toBe('/worktree')
    expect(command?.resultFrom).toBe('stdout_json')
    expect(command?.argv).toEqual(kimiCliArgv('把 X 改了', '/worktree', {}))
    expect(command?.argv.some(arg => arg.startsWith('--dangerously'))).toBe(false)
    // 模型与智能体文件从名片带进来
    const withCard = dispatchCommand(kimi, { prompt: 'x', cwd: '/w', kind: 'code', model: 'm1', agentFile: 'docs/卡/agents/kimi-coder.md' })
    expect(withCard?.argv).toContain('-m')
    expect(withCard?.argv[withCard.argv.indexOf('-m') + 1]).toBe('m1')
    expect(withCard?.argv[withCard.argv.indexOf('--agent-file') + 1]).toBe('/w/docs/卡/agents/kimi-coder.md')
    // 聊天的活照旧不拼(它归窗口那只手)
    expect(dispatchCommand(kimi, { prompt: 'x', cwd: '/w' })).toBeUndefined()
  })

  it('claudeCliArgv:名片给了模型才加 --model(不给一字不变)', () => {
    expect(claudeCliArgv('x', '/repo')).toEqual(['-p', 'x', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/repo'])
    expect(claudeCliArgv('x', '/repo', 'opus')).toEqual(['-p', 'x', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/repo', '--model', 'opus'])
  })

  it('续跑接原会话(2026-10-23 卡「派活给名片的四处」③):给了会话号,claude 带 --resume、kimi 带 --session;不给一字不变', () => {
    const claude = resolveAgentCli('claude', probe([CLAUDE_BIN], { pathEnv: '', dirs: { [MANAGED]: ['2.1.275'] } }))
    const codex = resolveAgentCli('codex', probe([CODEX_BUNDLED], { pathEnv: '' }))
    // Claude:`claude -p … --resume <id>`(接着那一条,不从头再读一遍)。
    expect(claudeCliArgv('接着做', '/repo', undefined, 'sess-1')).toEqual([
      '-p', '接着做', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/repo', '--resume', 'sess-1',
    ])
    expect(dispatchCommand(claude, { prompt: '接着做', cwd: '/repo', kind: 'code', resume: 'sess-1' })?.argv).toContain('--resume')
    // Kimi:`kimi --session <id> -p …`(卡上写的那一条)。
    // 续跑不带 --agent-file(统筹 10-23 实测:Kimi 拒绝 --session 与 --agent-file 同用,智能体在建会话时已绑定、续跑自动恢复)。
    expect(kimiCliArgv('接着做', '/worktree', { resume: 'sess-2' })).toEqual([
      '--session', 'sess-2', '-p', '接着做', '--output-format', 'stream-json',
    ])
    expect(dispatchCommand(kimi, { prompt: '接着做', cwd: '/worktree', kind: 'code', resume: 'sess-2' })?.argv.slice(0, 2)).toEqual(['--session', 'sess-2'])
    // Codex 续跑必须接原会话，不能静默新起。
    expect(dispatchCommand(codex, { prompt: '接着做', cwd: '/repo', outputFile: '/tmp/o', kind: 'code', resume: 'sess-3' })?.argv).toEqual(expect.arrayContaining(['resume', 'sess-3']))
  })

  it('kimiResultOf:读 stream-json —— 最后一条 role=assistant 的 content 是汇报;resume_hint 里的 session_id 记下来', () => {
    const sample = readFileSync(new URL('./fixtures/kimi-stream-json/sample.jsonl', import.meta.url), 'utf8')
    expect(kimiResultOf(sample)).toEqual({
      text: '今天的代码写得怎么样？需要我帮你做点什么吗？',
      error: false,
      session_id: 'session_c9dce676-e97d-4667-98d3-8a78a9ae2ca8',
    })
    // 多条 assistant 取最后一条;半截行跳过
    const multi = [
      '{"role":"assistant","content":"先答一句"}',
      '{"role":"assistant","content":"最终汇报"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"s-2"}',
    ].join('\n')
    expect(kimiResultOf(multi)).toEqual({ text: '最终汇报', error: false, session_id: 's-2' })
    expect(kimiResultOf('{"role":"assis')).toBeUndefined()
    expect(kimiResultOf('')).toBeUndefined()
  })
})

/**
 * A3(2026-09-22,Ben 定):**先用哪只手**。
 * 「Claude 命令行不登,Claude 走窗口那只手,命令行只作 Codex 备用。」
 */
describe('A3:三家各自的手,以及顺序', () => {
  it('Claude 只有窗口一只手 —— 不再试命令行', () => {
    expect(dispatchHands('claude')).toEqual(['window'])
    expect(cliIsBackupFor('claude')).toBe(false)
  })

  it('Codex 是**窗口优先、送不进去再走命令行**(顺序就是这个数组的顺序)', () => {
    expect(dispatchHands('codex')).toEqual(['window', 'cli'])
    expect(cliIsBackupFor('codex')).toBe(true)
  })

  it('Kimi 只有窗口(聊天照旧走窗;写代码的活走命令行 —— 卡 C)', () => {
    expect(dispatchHands('kimi')).toEqual(['window'])
    expect(cliIsBackupFor('kimi')).toBe(false)
  })

  it('★有窗口的那三家,第一只手都是窗口 —— 用户手里是订阅不是 API Key', () => {
    for (const family of ['codex', 'claude', 'kimi'] as const) {
      expect(dispatchHands(family)[0]).toBe('window')
    }
  })

  /**
   * 2026-09-22:接口那只手有适配器了(`server/dispatchApi.ts`),于是 GPT 与豆包进表。
   * 原来那条「一只 api 都没有」写的是**当时的事实**(没有适配器,写一个不存在的手
   * 只会让事务官去试一条不存在的路),现在事实变了,断言跟着变 —— 但**方向没变**:
   * 表里只许出现真跑得起来的手。
   */
  it('★GPT 只有接口那一只手;豆包 2026-09-24 起窗口在前、接口备用(卡 F 实测豆包 2.17.10 的输入框读得到了)', () => {
    expect(dispatchHands('gpt')).toEqual(['api'])
    expect(dispatchHands('doubao')).toEqual(['window', 'api'])
    expect(apiIsHandFor('gpt')).toBe(true)
    expect(apiIsHandFor('doubao')).toBe(true)
  })

  it('★Muse 与 Manus(2026-09-24 新加)只有窗口那一只手', () => {
    expect(dispatchHands('muse')).toEqual(['window'])
    expect(dispatchHands('manus')).toEqual(['window'])
    const none = probe([], { pathEnv: '' })
    for (const family of ['muse', 'manus'] as const) {
      const cli = resolveAgentCli(family, none)
      expect(cli.found).toBe(false)
      expect(cli.found === false && cli.why).toContain('没有命令行')
    }
  })

  it('★老三家一只 `api` 都没有:它们有订阅可用,不该去花他的模型额度', () => {
    for (const family of ['codex', 'claude', 'kimi'] as const) {
      expect(dispatchHands(family)).not.toContain('api')
    }
  })

  it('★GPT 不许出现在窗口那只手上 —— 那扇窗是 Codex 的(同一个 app)', () => {
    expect(dispatchHands('gpt')).not.toContain('window')
  })

  /**
   * 卡 Z(2026-09-25):**有哪几家能接活不再写死**(原来的 `AGENT_DISPATCH_FAMILIES` 删了)——
   * 登记表里判成 Agent、接上了的每一家就是候选,几只手按「它有没有本机 App + 为它写过什么专门接法」现算。
   */
  it('★运行时新发现的一家:不改一行代码就是派活候选,默认窗口那只手', () => {
    expect(handsOf({ id: 'com.example.fooai', hasApp: true })).toEqual(['window'])
    const targets = dispatchTargets({
      registry: {
        entries: [
          { id: 'dsh', name: '事务官', self: true, found: { how: 'self', at: '', basis: '' }, sources: [], status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } },
          { id: 'com.example.fooai', bundle_id: 'com.example.fooai', name: 'Foo AI', color: '#88aaff', app_running: true, found: { how: 'launch', at: '', basis: '' }, sources: [], status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } },
        ],
        asking: [],
        notices: [],
      },
    })
    // 事务官自己不是派活候选(「派给事务官」= 她自己办)。
    expect(targets.map(one => one.id)).toEqual(['com.example.fooai'])
    expect(targets[0]).toMatchObject({ title: 'Foo AI', hands: ['window'], color: '#88aaff', open: ['open', '-b', 'com.example.fooai'], from_registry: true })
    // 没为它写过专门探法:如实说「没查过」,不编一条命令(D13);照旧走窗口那只手。
    const cli = resolveAgentCli('com.example.fooai', probe([], { pathEnv: '' }))
    expect(cli.found).toBe(false)
    expect(cli.found === false && cli.why).toContain('没查过')
  })

  it('接口那两家探不到命令行,而且说得出为什么', () => {
    const none = probe([], { pathEnv: '' })
    const gpt = resolveAgentCli('gpt', none)
    expect(gpt.found).toBe(false)
    // 「ChatGPT.app 里那份命令行就是 Codex」——不把同一个二进制算两遍。
    expect(gpt.found === false && gpt.why).toContain('Codex')
    const doubao = resolveAgentCli('doubao', none)
    expect(doubao.found).toBe(false)
    expect(doubao.found === false && doubao.why).toContain('没有命令行')
  })
})

describe('目录门', () => {
  const roots = ['/Users/someone/Code', '/Users/someone/Docs/']

  it('根本身与根底下都放行', () => {
    expect(dispatchCwdAllowed('/Users/someone/Code', roots)).toBe(true)
    expect(dispatchCwdAllowed('/Users/someone/Code/a/b', roots)).toBe(true)
    // 根配成带尾斜杠的也认(设置里手敲很容易多打一个)。
    expect(dispatchCwdAllowed('/Users/someone/Docs/x', roots)).toBe(true)
  })

  it('**前缀骗不过去**:/Code2 不在 /Code 底下', () => {
    expect(dispatchCwdAllowed('/Users/someone/Code2', roots)).toBe(false)
    expect(dispatchCwdAllowed('/Users/someone/CodeXXX/a', roots)).toBe(false)
  })

  it('带 .. 的一概不放行(这里不碰盘,算不清就不放)', () => {
    expect(dispatchCwdAllowed('/Users/someone/Code/../../../etc', roots)).toBe(false)
  })

  it('相对路径、空串、一条根都没有 → 都不放行', () => {
    expect(dispatchCwdAllowed('Code', roots)).toBe(false)
    expect(dispatchCwdAllowed('', roots)).toBe(false)
    expect(dispatchCwdAllowed('/Users/someone/Code', [])).toBe(false)
  })
})

describe('进度那句话', () => {
  it('三档各一句', () => {
    expect(dispatchNote({ family: 'codex', status: 'running' })).toBe('派给 Codex,进行中')
    expect(dispatchNote({ family: 'claude', status: 'done' })).toBe('派给 Claude,完成')
    expect(dispatchNote({ family: 'codex', status: 'failed', note: '退出码 1' })).toBe('派给 Codex,失败(退出码 1)')
  })

  it('失败但没拿到原因 → 说没拿到,**不编一个**', () => {
    expect(dispatchNote({ family: 'kimi', status: 'failed' })).toBe('派给 Kimi,失败(没说原因)')
    expect(dispatchNote({ family: 'kimi', status: 'failed', note: '   ' })).toBe('派给 Kimi,失败(没说原因)')
  })
})

describe('技能正文 = 仓库那份 + 本机现探的表', () => {
  const clis = [
    resolveAgentCli('codex', probe([CODEX_BUNDLED], { pathEnv: '' })),
    resolveAgentCli('claude', probe([], { pathEnv: '' })),
    resolveAgentCli('kimi', probe([], { pathEnv: '' })),
  ]

  it('仓库那份原样在前,表在后', () => {
    const body = dispatchSkillBody('# 技能:派活给别家 Agent\n\n正文若干。', clis)
    expect(body.startsWith('# 技能:派活给别家 Agent')).toBe(true)
    expect(body).toContain('这台电脑上现在怎么派')
  })

  it('装了的那家写路径,没装的那家写**没有**加一句人话', () => {
    const body = dispatchSkillBody('正文', clis)
    expect(body).toContain(CODEX_BUNDLED)
    expect(body).toContain('| Kimi | 客户端窗口 | 这台电脑上没装 Kimi Code CLI')
    // 那句「我自己来做还是等你装」必须在技能里,不然事务官会自己想一句。
    expect(body).toContain('我自己来做还是等你装')
  })

  it('★A3:表里逐家写清先用哪只手 —— Claude 只有窗口,Codex 窗口在前命令行在后', () => {
    const body = dispatchSkillBody('正文', [
      resolveAgentCli('codex', probe([CODEX_BUNDLED], { pathEnv: '' })),
      resolveAgentCli('claude', probe([CLAUDE_BIN], { pathEnv: '', dirs: { [MANAGED]: ['2.1.275'] } })),
      resolveAgentCli('kimi', probe([], { pathEnv: '' })),
    ])
    expect(body).toContain('| Codex | 客户端窗口 → 命令行(备用)')
    expect(body).toContain('| Claude | 客户端窗口 |')
    // Claude 那份命令行的路径**一个字都不许出现在技能里**:写了事务官就会去试。
    expect(body).not.toContain(CLAUDE_BIN)
  })

  /**
   * 卡 Z(2026-09-25):写死的家名单删了,剩下的是「工作台为哪几个 App 写过专门代码」那一份
   * (`FAMILY_SOURCES`)—— 它不回答「有哪几家 Agent」,只在没接发现引擎时当退路。顺序固定,免得每次渲染不同。
   */
  /**
   * 卡 Z 的形状规矩:登记表里一家的 id 只有两种形状 —— 写过专门接法的那个家名,或者它的包标识。
   * `isAgentDispatchFamily` 就按这条认;所以 `FAMILY_SOURCES` 里每个家名都**必须**在
   * `DISPATCH_FAMILY_TITLES` 里有一格(不然它自己会被当成「不是一家」)。
   */
  it('★家名的形状:写过专门接法的每个家名都认得;包标识认得;「张三」这种一律不算', () => {
    for (const binding of FAMILY_SOURCES) {
      if (binding.self === true) continue
      expect(isAgentDispatchFamily(binding.agent), binding.agent).toBe(true)
      expect(DISPATCH_FAMILY_TITLES[binding.agent], binding.agent).toBe(binding.name)
    }
    expect(isAgentDispatchFamily('com.example.fooai')).toBe(true)
    expect(isAgentDispatchFamily('im.manus.desktop')).toBe(true)
    expect(isAgentDispatchFamily('张三')).toBe(false)
    expect(isAgentDispatchFamily('unknown')).toBe(false)
    expect(isAgentDispatchFamily('dsh')).toBe(false)
    expect(isAgentDispatchFamily('me')).toBe(false)
    // 人跟人聊天的那几家永远不算(两种写法都挡)。
    expect(isAgentDispatchFamily('wechat')).toBe(false)
    expect(isAgentDispatchFamily('com.tencent.xinWeChat')).toBe(false)
  })

  it('写过专门接法的那几家顺序固定(退路那一份;有哪几家能接活由登记表说)', () => {
    expect(FAMILY_SOURCES.filter(one => one.self !== true).map(one => one.agent))
      .toEqual(['claude', 'codex', 'kimi', 'doubao', 'muse', 'manus', 'gpt'])
    // 退路那一份只有「有本机 App」的几家(GPT 没有 App,它要接口接得上才进候选)。
    expect(fallbackTargets().map(one => one.id)).toEqual(['claude', 'codex', 'kimi', 'doubao', 'muse', 'manus'])
  })

  it('★技能表里接口那两家写「经中转 + 默认模型」,而且一个凭据都没有', () => {
    const body = dispatchSkillBody('正文', [
      resolveAgentCli('gpt', probe([], { pathEnv: '' })),
      resolveAgentCli('doubao', probe([], { pathEnv: '' })),
    ])
    expect(body).toContain('| GPT | 接口 |')
    expect(body).toContain('gpt-4o')
    // 豆包 2026-09-24 起窗口在前、接口备用。
    expect(body).toContain('| 豆包办公 | 客户端窗口 → 接口(备用) |')
    // 技能正文会被写进 ~/.dsh/AGENTS.md —— 那份文件里一个凭据、一个地址都不许出现。
    expect(body).not.toContain('sk-')
    expect(body).not.toContain('RELAY_')
    expect(body).toContain('Key 在服务器上')
  })
})
