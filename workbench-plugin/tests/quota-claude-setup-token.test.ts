// @vitest-environment node
/**
 * Claude 额度「一键接上」那一层(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * 维护者原话:额度里 Claude 那格一直「未接入」,统筹查出要先在终端跑一条命令、再把密钥粘进设置;
 * 他照做接上了,然后说:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」
 *
 * 所以这一组钉的是**她能不能只按一颗键**:
 * - 子进程那一层全是假 `spawn`(吐密钥 / 只吐链接 / 超时 / 找不到命令四种),**绝不起真的命令**;
 * - 密钥一个字节都不许出现在进度、日志、回包里(`scrubToken` 那一道);
 * - 链接只认 Claude 自家那几个域名 —— 子进程打印出来的是**数据**,不是让我们去打开任何地址的命令。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CONNECT_DONE,
  CLAUDE_CONNECT_NO_CLI,
  CLAUDE_CONNECT_NO_TOKEN,
  CLAUDE_CONNECT_OPENING,
  CLAUDE_CONNECT_TIMEOUT,
  CLAUDE_CONNECT_WAITING,
  claudeConnectFailed,
  claudeQuotaWords,
  connectClaudeQuota,
  findClaudeAuthUrl,
  findClaudeSetupToken,
  findClaudeTokenExpiry,
  resolveClaudeCli,
  scrubClaudeToken,
} from '../src/quota/claudeSetupToken.ts'

/** 假密钥。形状照真的来(前缀 + 够长),但**不是**任何真实凭据。 */
const FAKE_TOKEN = 'sk-ant-oat01-0000000000000000000000000000-fake-for-tests'
const AUTH_URL = 'https://claude.ai/oauth/authorize?code=1&state=abc'

/** 一只假子进程:用例自己决定什么时候吐什么。 */
function fakeChild() {
  const outs: ((chunk: unknown) => void)[] = []
  const errs: ((chunk: unknown) => void)[] = []
  const exits: ((code: number | null) => void)[] = []
  const fails: ((error: Error) => void)[] = []
  const killed: string[] = []
  const child = {
    stdout: { on: (_event: 'data', handler: (chunk: unknown) => void) => { outs.push(handler) } },
    stderr: { on: (_event: 'data', handler: (chunk: unknown) => void) => { errs.push(handler) } },
    on: (event: string, handler: (arg: never) => void) => {
      if (event === 'error') fails.push(handler as (error: Error) => void)
      if (event === 'exit' || event === 'close') exits.push(handler as (code: number | null) => void)
    },
    kill: (signal?: string) => { killed.push(signal ?? 'SIGTERM') },
  }
  return {
    child,
    killed,
    say: (text: string) => { for (const handler of outs) handler(Buffer.from(text)) },
    sayErr: (text: string) => { for (const handler of errs) handler(Buffer.from(text)) },
    exit: (code: number | null = 0) => { for (const handler of exits) handler(code) },
    crash: (error: Error) => { for (const handler of fails) handler(error) },
  }
}

/** 一次「接上」要的那几样,全是假的:没有真 spawn、没有真浏览器、没有真凭据文件。 */
function harness(options: { cli?: string | undefined } = {}) {
  const fake = fakeChild()
  const opened: string[] = []
  const saved: string[] = []
  let timer: (() => void) | undefined
  const run = connectClaudeQuota({
    findCli: () => (options.cli === undefined ? '/fake/bin/claude' : options.cli),
    spawn: vi.fn(() => fake.child),
    openUrl: async (url) => { opened.push(url) },
    save: async (token) => { saved.push(token); return '本周还剩 81%' },
    // 计时器注入:超时那一条不必真等五分钟。
    schedule: (fn) => { timer = fn; return { cancel: () => { timer = undefined } } },
  })
  return { run, fake, opened, saved, fireTimeout: () => timer?.() }
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

describe('认链接 / 认密钥 / 认有效期(纯函数)', () => {
  it('链接只认 Claude 自家那几个域名 —— 子进程打印出来的是数据,不是「去开这个地址」的命令', () => {
    expect(findClaudeAuthUrl(`请打开 ${AUTH_URL}`)).toBe(AUTH_URL)
    expect(findClaudeAuthUrl('open https://console.anthropic.com/oauth/x')).toBe('https://console.anthropic.com/oauth/x')
    // 别家的地址一概不开(就算命令行某天被改成打印它)。
    expect(findClaudeAuthUrl('open https://example.com/evil')).toBeUndefined()
    // http 也不认:授权链接本来就是 https。
    expect(findClaudeAuthUrl('open http://claude.ai/oauth/authorize')).toBeUndefined()
  })

  it('密钥认得出来,认不出来就缺席(绝不编一串)', () => {
    expect(findClaudeSetupToken(`Your token:\n${FAKE_TOKEN}\n`)).toBe(FAKE_TOKEN)
    expect(findClaudeSetupToken('授权完成,没有密钥')).toBeUndefined()
  })

  it('有效期只在命令真的打印了的时候才有', () => {
    expect(findClaudeTokenExpiry('This token expires at 2027-01-02.')).toBe('2027-01-02')
    expect(findClaudeTokenExpiry('有效期至 2027-01-02')).toBe('2027-01-02')
    // 一个日子都没写 → 缺席。界面那一行于是只写「实时」,不编一个到期日(D13)。
    expect(findClaudeTokenExpiry('token created')).toBeUndefined()
  })

  it('★ 任何要上屏的文字先过一道:密钥样子的串抹掉', () => {
    const said = scrubClaudeToken(`failed with ${FAKE_TOKEN} oops`)
    expect(said).not.toContain(FAKE_TOKEN)
    expect(said).not.toContain('sk-ant-')
  })
})

describe('这台机器上 claude 在哪', () => {
  const probe = (files: readonly string[], pathEnv = '') => ({
    pathEnv,
    home: '/fake/home',
    exists: (file: string) => files.includes(file),
    listDir: () => [],
  })

  it('PATH 上有就用 PATH 上那一份', () => {
    expect(resolveClaudeCli(probe(['/usr/bin/claude'], '/usr/bin'))).toBe('/usr/bin/claude')
  })

  it('Claude 官方安装程序装的那一份也认(DSH 的 PATH 里常常没有 ~/.local/bin)', () => {
    expect(resolveClaudeCli(probe(['/fake/home/.claude/local/claude']))).toBe('/fake/home/.claude/local/claude')
  })

  it('★ Homebrew 装的那一份也认 —— DSH 继承的 PATH 里常常没有 /opt/homebrew/bin', () => {
    expect(resolveClaudeCli(probe(['/opt/homebrew/bin/claude']))).toBe('/opt/homebrew/bin/claude')
  })

  it('一处都没有就回 undefined(调用方据此说那句人话,不猜一个路径)', () => {
    expect(resolveClaudeCli(probe([]))).toBeUndefined()
  })
})

describe('一键接上:四种结局', () => {
  it('① 吐出密钥 → 写进凭据库、格子变实时,进度里一个字节都没有那串密钥', async () => {
    const { run, fake, opened, saved } = harness()

    expect(run.progress().state).toBe('opening')
    expect(run.progress().message).toBe(CLAUDE_CONNECT_OPENING)

    fake.say(`Open this URL: ${AUTH_URL}\n`)
    await settled()
    expect(opened).toEqual([AUTH_URL])
    expect(run.progress()).toMatchObject({ state: 'waiting', message: CLAUDE_CONNECT_WAITING })

    fake.say(`Success! Your token expires at 2027-01-02\n${FAKE_TOKEN}\n`)
    await settled()

    expect(saved).toEqual([FAKE_TOKEN])
    const done = run.progress()
    expect(done.state).toBe('done')
    // 「接上了 · 本周还剩 81%」—— 那个数是采了一轮真读到的,读不到就只说「接上了」。
    expect(done.message).toBe(`${CLAUDE_CONNECT_DONE} · 本周还剩 81%`)
    expect(done.expires_at).toBe('2027-01-02')
    expect(JSON.stringify(done)).not.toContain('sk-ant-')
  })

  it('② 只吐链接、授权没走完 → 如实说没成,不写任何凭据', async () => {
    const { run, fake, saved } = harness()
    fake.say(`Open this URL: ${AUTH_URL}\n`)
    await settled()
    fake.exit(1)
    await settled()

    expect(saved).toEqual([])
    expect(run.progress()).toMatchObject({ state: 'failed', message: claudeConnectFailed(CLAUDE_CONNECT_NO_TOKEN) })
  })

  it('③ 超时 → 把子进程杀干净,并说「再试一次」', async () => {
    const { run, fake, fireTimeout } = harness()
    fake.say(`Open this URL: ${AUTH_URL}\n`)
    await settled()

    fireTimeout()
    await settled()

    expect(fake.killed.length).toBeGreaterThan(0)
    expect(run.progress()).toMatchObject({ state: 'failed', message: claudeConnectFailed(CLAUDE_CONNECT_TIMEOUT) })
  })

  it('④ 这台电脑上没装那条命令行 → 一次 spawn 都不做,给出能照做的那一步', () => {
    const spawn = vi.fn()
    const run = connectClaudeQuota({
      findCli: () => undefined,
      spawn: spawn as never,
      openUrl: async () => {},
      save: async () => undefined,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(run.progress()).toEqual({ state: 'failed', message: CLAUDE_CONNECT_NO_CLI })
    // 「先在 Claude 桌面端里装一次」那一步要**写在话里**,不是让她自己猜。
    expect(CLAUDE_CONNECT_NO_CLI).toContain('Claude 桌面端')
    // ★ 而且不说程序员的话(同设置页那条老纪律:tests/client-settings-groups.test.tsx 的 ④)。
    for (const jargon of ['命令行', 'CLI', '终端', 'Terminal', 'setup-token']) {
      expect(CLAUDE_CONNECT_NO_CLI).not.toContain(jargon)
    }
  })

  it('命令起不来(权限不对 / 包坏了)也接住,不让它变成进程级崩溃', async () => {
    const { run, fake } = harness()
    fake.crash(new Error(`spawn 失败 ${FAKE_TOKEN}`))
    await settled()
    const said = run.progress()
    expect(said.state).toBe('failed')
    // 错误原文里要是带了密钥,先抹掉再上屏。
    expect(said.message).not.toContain('sk-ant-')
  })

  it('取消:杀干净、状态回到「没在接」—— 不把界面卡在「等你授权」', async () => {
    const { run, fake } = harness()
    fake.say(`Open this URL: ${AUTH_URL}\n`)
    await settled()

    run.cancel()
    expect(fake.killed.length).toBeGreaterThan(0)
    expect(run.progress().state).toBe('idle')

    // 取消之后子进程迟到的那几句一概不算数(否则会把界面又点亮成「接上了」)。
    fake.say(`${FAKE_TOKEN}\n`)
    await settled()
    expect(run.progress().state).toBe('idle')
  })

  it('★ 存凭据这一步自己失败时,如实说没成(而不是说「接上了」)', async () => {
    const fake = fakeChild()
    const run = connectClaudeQuota({
      findCli: () => '/fake/bin/claude',
      spawn: () => fake.child,
      openUrl: async () => {},
      save: async () => { throw new Error('假的写盘失败') },
    })
    fake.say(`${FAKE_TOKEN}\n`)
    await settled()
    expect(run.progress()).toMatchObject({ state: 'failed', message: claudeConnectFailed('假的写盘失败') })
  })
})

describe('接上之后那半句「本周还剩 x%」', () => {
  it('周窗口有就说周的 —— 她问的是「这周还能用多少」', () => {
    expect(claudeQuotaWords({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 42 }, { label: '周', left_pct: 81 }],
    })).toBe('本周还剩 81%')
  })

  it('只有短窗口时照实说那一扇,不把它冒充成周', () => {
    expect(claudeQuotaWords({ kind: 'quota', windows: [{ label: '5h', left_pct: 9 }] })).toBe('5h 还剩 9%')
  })

  it('★ 取不到数就不说 —— 不编一个百分比(D13)', () => {
    expect(claudeQuotaWords({ kind: 'unknown', note: '取不到' })).toBeUndefined()
    expect(claudeQuotaWords(undefined)).toBeUndefined()
    expect(claudeQuotaWords({ kind: 'quota', windows: [] })).toBeUndefined()
  })
})
