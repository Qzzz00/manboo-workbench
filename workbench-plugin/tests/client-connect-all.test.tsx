/**
 * 「全部接上」那个框(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 维护者 09-24:「授权要自己点就算了」—— 可以要他点,但只点一次。断言写的是他在屏幕上看得到什么:
 *   ① 框一打开只去"看",一个字都还没写;两家各写进哪个文件都摆出来;
 *   ② 只点一次「一次写入」,两家都写;
 *   ③ 写完逐家一行(备份在哪)+ 各自一颗「撤回」—— 撤一家不动另一家;
 *   ④ Kimi 不在这一次里,那一句说清要他自己登一次。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectAllDialog } from '../src/client/ConnectAllDialog.tsx'

afterEach(cleanup)

/** 钩子脚本的固定位置(卡 R):命令只指这里。 */
const HOOKS = '/Users/someone/.dsh/workbench/hooks'
/** 钩子脚本没放好时服务端那一句(hookScripts.ts 的 no_source,原样)。 */
const SCRIPTS_ERROR = '这次没接上:这一版工作台少了接额度要用的两个小文件(安装不完整)。你的配置一个字都没动。点「再试一次」;还不行就重新装一次工作台。'
const CLAUDE_FILE = '/Users/someone/.claude/settings.json'
const CODEX_FILE = '/Users/someone/.codex/hooks.json'
const KIMI_HOW = '要你自己登一次(账号密码工作台不经手)—— 去设置 → 额度凭据,点「登录 Kimi」,在弹出来的窗口里登一次就好,以后不用再登。'

const PREVIEW = {
  ok: true,
  agents: [
    { agent: 'claude', name: 'Claude', state: 'pending', file: CLAUDE_FILE, content: { hooks: { Stop: [{ hooks: [{ command: `${HOOKS}/agent-hook.sh claude` }] }] } }, will: { added: 4, replaced: 0, status_line: 'added' } },
    { agent: 'codex', name: 'Codex', state: 'pending', file: CODEX_FILE, content: { hooks: { Stop: [{ hooks: [{ command: `${HOOKS}/agent-hook.sh codex` }] }] } }, will: { added: 3, replaced: 0, status_line: 'none' } },
  ],
  apply: ['claude', 'codex'],
  kimi: { state: 'pending', how: KIMI_HOW },
  line: '要写 2 家…',
}
const APPLIED = {
  ok: true,
  results: [
    { agent: 'claude', name: 'Claude', ok: true, file: CLAUDE_FILE, backup_path: `${CLAUDE_FILE}.bak-工作台-20260925-093000`, added: 4, replaced: 0, status_line: 'added' },
    { agent: 'codex', name: 'Codex', ok: true, file: CODEX_FILE, added: 3, replaced: 0, status_line: 'none' },
  ],
  skipped: [],
  restart_hint: '正开着的 Claude Code 窗口和 Codex 会话还是旧配置 —— 各自关掉、重新开一个,工作台才收得到它们的动静。',
  kimi: { state: 'pending', how: KIMI_HOW },
  line: 'Claude、Codex 接上了。',
}

interface Call { url: string, method: string, body?: string }

function fakeFetch(over: Record<string, { status?: number, body: unknown }> = {}) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    const key = Object.keys(over).find(path => url.includes(path))
    const hit = key === undefined ? undefined : over[key]
    const reply = (fallback: unknown) => {
      const answer = hit ?? { body: fallback }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/quota/connect-all/apply')) return reply(APPLIED)
    if (url.includes('/config/hooks/revert')) return reply({ ok: true, removed: 3, note: '撤掉了' })
    return reply(PREVIEW)
  }) as unknown as typeof fetch
  return { calls, impl }
}

function open(over?: Record<string, { status?: number, body: unknown }>) {
  const { calls, impl } = fakeFetch(over)
  const onClose = vi.fn()
  const onChanged = vi.fn()
  render(<ConnectAllDialog baseUrl="http://127.0.0.1:8791" fetchImpl={impl} onClose={onClose} onChanged={onChanged} />)
  return { calls, onClose, onChanged }
}

describe('「全部接上」:一次看、一次点、每家仍能单独撤回', () => {
  it('★框一打开只去"看":两家各加几条摆出来,一个字都还没写;路径收在「看一眼」里,不摊在第一眼上', async () => {
    const { calls } = open()
    expect(await screen.findByText('Claude:加 4 条')).toBeInTheDocument()
    expect(screen.getByText('Codex:加 3 条')).toBeInTheDocument()
    expect(screen.getByText(/写完每家都能单独撤回/)).toBeInTheDocument()
    // 文件在哪、写什么:在「看一眼要写什么」里(维护者的眼睛第 3 条:不露文件路径)。
    const more = screen.getAllByText('看一眼要写什么(看不懂也没关系)')[0]?.closest('details')
    expect(more?.textContent).toContain('~/.claude/settings.json')
    expect(screen.getByLabelText('要写入 Codex 的内容').textContent).toContain('agent-hook.sh codex')
    const firstEye = [...document.querySelectorAll('.ben-wb__hookapply-line')].map(p => p.textContent ?? '').join('')
    expect(firstEye).not.toMatch(/~\/|\/Users\//)
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(calls[0]?.url).toContain('/quota/connect-all/preview')
  })

  it('★Kimi 不在这一次里,那一句说清:自己登一次就好', async () => {
    open()
    expect(await screen.findByText(/Kimi 不在这一次里/)).toBeInTheDocument()
    expect(screen.getByText(/以后不用再登/)).toBeInTheDocument()
  })

  it('★只点一次:两家一起写;写完逐家一行 + 各自一颗撤回;撤 Codex 不动 Claude', async () => {
    const { calls, onChanged } = open()
    fireEvent.click(await screen.findByRole('button', { name: '一次写入(2 家)' }))
    expect(await screen.findByText('Claude 接上了,改之前那一份已经另存好了。')).toBeInTheDocument()
    expect(screen.getByText('Codex 接上了,它的配置原来是空的,是工作台新建的(没有旧的可留)。')).toBeInTheDocument()
    // 另存在哪:找得到,但收在一格里。
    expect(screen.getByText('另存的那几份在哪(看不懂也没关系)').closest('details')?.textContent).toContain('settings.json.bak-工作台-20260925-093000')
    expect(screen.getByText(/各自关掉、重新开一个/)).toBeInTheDocument()
    expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual(['http://127.0.0.1:8791/quota/connect-all/apply'])
    expect(onChanged).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '撤回 Codex' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤回 Codex' })).toBeNull())
    const revert = calls.find(call => call.url.endsWith('/config/hooks/revert'))
    expect(JSON.parse(revert?.body ?? '{}')).toEqual({ agent: 'codex' })
    // Claude 那一行与它的撤回键都还在。
    expect(screen.getByRole('button', { name: '撤回 Claude' })).toBeInTheDocument()
    expect(screen.getByText(/已经撤回了/)).toBeInTheDocument()
  })

  it('一家没写成:那一行如实说,没有撤回键;另一家照常', async () => {
    open({
      '/quota/connect-all/apply': {
        body: {
          ...APPLIED,
          ok: false,
          results: [APPLIED.results[0], { agent: 'codex', name: 'Codex', ok: false, file: CODEX_FILE, error: '这个文件现在不是合法的 JSON' }],
        },
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: '一次写入(2 家)' }))
    expect(await screen.findByText(/Codex 没写成:这个文件现在不是合法的 JSON/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤回 Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: '撤回 Claude' })).toBeInTheDocument()
  })

  it('两家都已经接上:不画「一次写入」,只把那句话摆出来', async () => {
    open({
      '/quota/connect-all/preview': {
        body: {
          ...PREVIEW,
          agents: PREVIEW.agents.map(row => ({ agent: row.agent, name: row.name, state: 'connected', file: row.file })),
          apply: [],
          line: 'Claude、Codex 已经接上了,不用再写。',
        },
      },
    })
    expect(await screen.findByText('Claude、Codex 已经接上了,不用再写。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /一次写入/ })).toBeNull()
  })

  it('★预览取不到(钩子脚本没放好):服务端那句人话原样摆出来,旁边一颗「再试一次」;再试成了就回到先看那一屏', async () => {
    let failing = true
    const calls: string[] = []
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      const body = failing ? { error: SCRIPTS_ERROR } : PREVIEW
      return new Response(JSON.stringify(body), { status: failing ? 503 : 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    render(<ConnectAllDialog baseUrl="http://127.0.0.1:8791" fetchImpl={impl} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(SCRIPTS_ERROR)
    // 那一句里不提仓库、插件、路径,也不叫他去改设置。
    expect(screen.getByRole('alert').textContent).not.toMatch(/仓库|插件|设置|\//)
    failing = false
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    expect(await screen.findByText('Claude:加 4 条')).toBeInTheDocument()
    expect(calls).toHaveLength(2)
  })

  it('★原来接过(旧条目指着别处)→ 那一行说清是换掉原来那几条、不会重复', async () => {
    open({
      '/quota/connect-all/preview': {
        body: {
          ...PREVIEW,
          agents: [
            { ...PREVIEW.agents[0], will: { added: 4, replaced: 4, status_line: 'replaced' } },
            { ...PREVIEW.agents[1], will: { added: 3, replaced: 3, status_line: 'none' } },
          ],
        },
      },
    })
    expect(await screen.findByText('Claude:加 4 条(换掉原来那 4 条,不会重复)')).toBeInTheDocument()
    expect(screen.getByText('Codex:加 3 条(换掉原来那 3 条,不会重复)')).toBeInTheDocument()
  })
})
