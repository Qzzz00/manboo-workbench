/**
 * 「点一下,工作台帮你接上」的确认框(2026-09-17 Ben 拍板:**界面上先看后写**、**能一键撤回**)。
 *
 * Ben 是 PM、不写代码:这几条断言写的全是他在屏幕上看得到什么、点下去发生了什么,
 * 尤其是那两件最要紧的:
 *   ① 框一打开**还没有任何写入发生**(先看后写);
 *   ② 写完那句话里一定有**备份在哪**和**要重开会话**。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HooksApplyDialog } from '../src/client/HooksApplyDialog.tsx'
import { appliedLine, shortHome } from '../src/client/hooksApply.ts'

afterEach(cleanup)

const FILE = '/Users/someone/.claude/settings.json'
/** 钩子脚本的固定位置(卡 R):命令只指这里。 */
const HOOKS = '/Users/someone/.dsh/workbench/hooks'
const PREVIEW = {
  agent: 'claude',
  file: FILE,
  can_apply: true,
  hooks_dir: HOOKS,
  hooks: { Stop: [{ hooks: [{ type: 'command', command: `${HOOKS}/agent-hook.sh claude`, timeout: 5 }] }] },
  statusLine: { type: 'command', command: `${HOOKS}/claude-statusline.sh` },
}
/** 钩子脚本没放好时服务端那一句(hookScripts.ts 的 write_failed,原样)。 */
const SCRIPTS_ERROR = '这次没接上:工作台没能在自己的文件夹里放下接额度要用的两个小文件(多半是电脑存储空间满了)。你的配置一个字都没动。腾出一点空间后点「再试一次」。'
const APPLIED = {
  ok: true,
  backup_path: `${FILE}.bak-工作台-20260917-214233`,
  added: 4,
  replaced: 0,
  status_line: 'added',
  restart_hint: '已经接上了。正开着的 Claude Code 窗口还是旧配置 —— 关掉它、重新开一个会话,工作台才收得到它的动静。',
}

interface Call { url: string, method: string }

/** 假服务端。`over` 里给某条路指定回什么(状态码 + body)。 */
function fakeFetch(over: Record<string, { status?: number, body: unknown }> = {}) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const key = Object.keys(over).find(path => url.includes(path))
    const hit = key === undefined ? undefined : over[key]
    if (url.includes('/config/hooks/apply')) {
      const answer = hit ?? { body: APPLIED }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/config/hooks/revert')) {
      const answer = hit ?? { body: { ok: true, removed: 4, backup_path: `${FILE}.bak-工作台-20260917-220000`, note: '撤掉了' } }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    const answer = hit ?? { body: PREVIEW }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

function open(over?: Record<string, { status?: number, body: unknown }>, onClose = vi.fn()) {
  const { calls, impl } = fakeFetch(over)
  render(<HooksApplyDialog agent="claude" baseUrl="http://127.0.0.1:8791" fetchImpl={impl} onClose={onClose} />)
  return { calls, onClose }
}

describe('先看后写', () => {
  it('★框一打开只去"看",一个字都还没写', async () => {
    const { calls } = open()
    await screen.findByText(FILE)
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(calls[0]?.url).toContain('/config/hooks?agent=claude')
  })

  it('摆出来的是:写进哪个文件、为什么要写、要写什么', async () => {
    open()
    // 路径两处:一句人话里的短写法,和完整路径本身。
    expect(await screen.findByText(FILE)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(shortHome(FILE)))).toBeInTheDocument()
    expect(screen.getByText(/只加工作台自己的那几条/)).toBeInTheDocument()
    expect(screen.getByLabelText('要写入的内容').textContent).toContain('agent-hook.sh claude')
  })

  it('★按钮上一个技术词都没有,而且"取消"排在"写入"前面', async () => {
    open()
    await screen.findByText(FILE)
    expect(screen.getByRole('button', { name: '写入' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('点取消:关掉,什么都没写', async () => {
    const { calls, onClose } = open()
    await screen.findByText(FILE)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('★这台服务不会代写(老版本)→ 写入按不动,并说该去哪儿', async () => {
    open({ '/config/hooks?agent': { body: { ...PREVIEW, can_apply: false, file: undefined } } })
    await screen.findByText(/还不会代写/)
    expect(screen.getByRole('button', { name: '写入' })).toBeDisabled()
  })

  /** 卡 R:真接不上时一句人话 + 一键能做的下一步(「再试一次」),不叫他去改设置。 */
  it('★钩子脚本没放好(服务端 503)→ 原样显示那句人话、不出现"写入";点「再试一次」重新看一遍,好了就回到先看那一屏', async () => {
    let failing = true
    const calls: string[] = []
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      const body = failing ? { error: SCRIPTS_ERROR } : PREVIEW
      return new Response(JSON.stringify(body), { status: failing ? 503 : 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    render(<HooksApplyDialog agent="claude" baseUrl="http://127.0.0.1:8791" fetchImpl={impl} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(SCRIPTS_ERROR)
    expect(screen.queryByRole('button', { name: '写入' })).toBeNull()
    failing = false
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    expect(await screen.findByRole('button', { name: '写入' })).toBeEnabled()
    expect(calls).toHaveLength(2)
    expect(calls.every(url => url.includes('/config/hooks?agent=claude'))).toBe(true)
  })
})

describe('写入之后', () => {
  it('★那句话里有三样:接上了、备份在哪、要重开会话', async () => {
    const { calls } = open()
    await screen.findByText(FILE)
    fireEvent.click(screen.getByRole('button', { name: '写入' }))
    await waitFor(() => expect(screen.getByText(/已经接上 Claude 了/)).toBeInTheDocument())
    expect(screen.getByText(/bak-工作台-20260917-214233/)).toBeInTheDocument()
    expect(screen.getByText(/重新开一个会话/)).toBeInTheDocument()
    expect(calls.some(call => call.method === 'POST' && call.url.includes('/config/hooks/apply'))).toBe(true)
  })

  it('★旁边就有「撤回」,点了真发撤回请求并说撤了几条', async () => {
    const { calls } = open()
    await screen.findByText(FILE)
    fireEvent.click(screen.getByRole('button', { name: '写入' }))
    await screen.findByRole('button', { name: '撤回' })
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(screen.getByText(/已经撤回了/)).toBeInTheDocument())
    expect(screen.getByText(/摘掉 4 条,别的一个字没动/)).toBeInTheDocument()
    expect(calls.some(call => call.url.includes('/config/hooks/revert'))).toBe(true)
  })

  it('★备份没做成 → 服务端那句"一个字都没写"原样摆出来,绝不显示"已接上"', async () => {
    open({ '/config/hooks/apply': { status: 400, body: { error: '备份没做成(写不了 …),所以这次一个字都没写。原来的配置没有任何改动。' } } })
    await screen.findByText(FILE)
    fireEvent.click(screen.getByRole('button', { name: '写入' }))
    await waitFor(() => expect(screen.getByText(/所以这次一个字都没写/)).toBeInTheDocument())
    expect(screen.queryByText(/已经接上/)).toBeNull()
  })

  it('他自己配过状态栏 → 如实说那一条没动', async () => {
    open({ '/config/hooks/apply': { body: { ...APPLIED, status_line: 'kept_user' } } })
    await screen.findByText(FILE)
    fireEvent.click(screen.getByRole('button', { name: '写入' }))
    await waitFor(() => expect(screen.getByText(/你自己配过状态栏/)).toBeInTheDocument())
  })
})

describe('那句回执本身(纯函数)', () => {
  it('文件原来不存在时不说"备份在…",而是说清楚为什么没有备份', () => {
    const line = appliedLine('codex', { added: 3, replaced: 0, statusLine: 'none', restartHint: '重开一次。' })
    expect(line).toContain('没有备份可留')
    expect(line).not.toContain('备份在:')
  })

  it('换掉旧条目时说一句"没有重复"(幂等这件事他看不见,得说)', () => {
    const line = appliedLine('claude', {
      backupPath: '/x.bak', added: 4, replaced: 4, statusLine: 'replaced', restartHint: '重开一次。',
    })
    expect(line).toContain('已经换掉,没有重复')
  })

  it('shortHome 把家目录缩成 ~(界面上摆短的那一份)', () => {
    expect(shortHome('/Users/example/.codex/hooks.json')).toBe('~/.codex/hooks.json')
    expect(shortHome('/opt/x.json')).toBe('/opt/x.json')
  })
})
