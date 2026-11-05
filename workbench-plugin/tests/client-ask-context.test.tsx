/**
 * 电脑上「等你确认」那一条点开就看得懂前因后果(2026-10-04,卡 `claude/ask-with-context`)。
 *
 * 维护者原话:「麻烦的是每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
 *
 * 球下那一区那张卡上多两样:
 *   ① **问的是什么**:`ask.full` 有原文就摆原文(长了折起来,一颗「展开全文」);没有(按内容判出来的)照旧摆短的那一句;
 *   ② **它刚才在干什么**:一颗「它刚才在干什么」,点开摆那条会话的**最近几轮原文** —— 复用现成那条路
 *      (`GET /sessions/digest`,SessionDigestPanel 那一份),不另写一套、不经模型;读不到就如实说一句。
 *
 * 默认收着(09-25 那条规矩还在:球下那一区一屏要摆几张,整段贴开会把别的顶出屏幕)——
 * 她点开要看的那一下才摆。手机那一页是另一回事:那是点进去的专页,摊开(见 butler-app/tests/askWithContext.test.tsx)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionDigestView, SessionView } from '../src/protocol.ts'
import { SessionAsk } from '../src/client/SessionAsk.tsx'

afterEach(() => { cleanup(); globalThis.localStorage?.clear() })

const BASE = 'http://127.0.0.1:8791'

const LONG_QUESTION = [
  '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己定,好处是以后改样式不用动别人的东西);',
  '另一条是调系统的打印那一路(样子跟她在浏览器里按 ⌘P 一样,坏处是页眉页脚改不了)。',
  '两条路工期差不多,差别只在以后改样式方便不方便。你要哪一条?选完我就按这一条往下做,中途不再回来问你。',
].join('')
const LONG_NOTE = '自己排版:第一版大约两天,之后换字体换页边距都在工作台设置里点,不用等我改代码;缺点是她那台机器上没装的字体会退回默认那一个。'

/** 最近几轮:她说的 / 它说的,原样(服务端数出来的,不经模型)。 */
const ROUNDS: SessionDigestView['rounds'] = [
  { ask: '加个导出 PDF', reply: '好,我先看这一页现在是怎么画的。', did: '读了 3 个文件', at: '2026-10-04T08:58:00.000Z' },
  { reply: '看完了,排版那一路和调系统打印那一路都走得通,区别在改样式方便不方便。', did: '读了 2 个文件', at: '2026-10-04T09:00:30.000Z' },
]

function digest(patch: Partial<SessionDigestView> = {}): SessionDigestView {
  return {
    agent: 'claude', session_id: 'd999', project: 'desktop-workbench', status: 'waiting',
    title: '加个导出 PDF', rounds: ROUNDS, read_at: '2026-10-04T09:05:00.000Z', ...patch,
  }
}

function stub(reply: (path: string) => { status?: number, body: unknown } = () => ({ body: digest() })) {
  const paths: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    const out = reply(url.pathname)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, paths }
}

/** 老工作台 / 按内容判出来的那一条:`full` 与 `options` 压根没有这两格(不是「有而为空」)。 */
function noFull(ask: NonNullable<SessionView['ask']>): NonNullable<SessionView['ask']> {
  const { full: _full, options: _options, ...rest } = ask
  return rest
}

function asking(ask: Partial<NonNullable<SessionView['ask']>> = {}): SessionView {
  return {
    agent: 'claude', session_id: 'd999', project: 'desktop-workbench', status: 'waiting', reason: 'idle_prompt', wait_reason: 'input',
    title: '加个导出 PDF', elapsed_sec: 600, unread: false, updated_at: '2026-10-04T09:01:00.000Z',
    ask: {
      kind: 'choose',
      question: '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己…',
      options: [{ label: '自己排版', note: '第一版大约两天,之后换字体换页边距都在工作台设置里点,不用等我改代…' }, { label: '调系统打印那一路' }],
      since: '2026-10-04T09:01:00.000Z',
      by: 'form',
      reply: 'desk',
      where: '这一问得在电脑上的 Claude 里回答',
      press: true,
      ...ask,
    },
    ...{},
  }
}

const FULL = { question: LONG_QUESTION, header: '导出 PDF 走哪一条', options: [{ label: '自己排版', note: LONG_NOTE }, { label: '调系统打印那一路' }] }

describe('电脑:那一条带上前因后果(卡 claude/ask-with-context)', () => {
  it('① 有原文:摆原文全文(不是那句截短的),选项说明也是原文', async () => {
    const { impl } = stub()
    render(<SessionAsk session={asking({ full: FULL })} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    // 原文一个字不少,摆在卡上(默认折着,所以用 textContent 认,不认可见高度)。
    expect(screen.getByTestId('sask-say')).toHaveTextContent(LONG_QUESTION)
    // 那行小标题也在(弹窗给了才有)。
    expect(screen.getByText('导出 PDF 走哪一条')).toBeInTheDocument()
    // 选项说明是原文那一份。
    expect(screen.getByText(LONG_NOTE)).toBeInTheDocument()
  })

  it('① 长原文折起来,一颗「展开全文」摊开 / 收起', async () => {
    const { impl } = stub()
    render(<SessionAsk session={asking({ full: FULL })} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    const say = screen.getByTestId('sask-say')
    expect(say).toHaveAttribute('data-folded', 'true')
    await userEvent.click(screen.getByRole('button', { name: '展开全文' }))
    expect(screen.getByTestId('sask-say')).toHaveAttribute('data-folded', 'false')
    await userEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByTestId('sask-say')).toHaveAttribute('data-folded', 'true')
  })

  it('① 短的原文不折(没有那颗键);没有原文的(按内容判出来的)照旧摆短的那一句', async () => {
    const { impl } = stub()
    const base = asking()
    render(<SessionAsk session={{ ...base, ask: noFull({ ...base.ask!, by: 'rules', question: '你选哪个?回个数字就行。' }) }} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    expect(screen.getByTestId('sask-say')).toHaveTextContent('你选哪个?回个数字就行。')
    expect(screen.queryByRole('button', { name: '展开全文' })).not.toBeInTheDocument()
  })

  it('② 「它刚才在干什么」:默认收着、不去要;点开才读 /sessions/digest,最近几轮原样摆 + 在哪个项目', async () => {
    const { impl, paths } = stub()
    render(<SessionAsk session={asking({ full: FULL })} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    // 默认收着:一条请求都没发(球下那一区同时摆着几张卡,不许一打开就各读一次)。
    expect(paths).toEqual([])
    const toggle = screen.getByRole('button', { name: '它刚才在干什么' })
    await userEvent.click(toggle)
    await waitFor(() => { expect(paths.some(one => one === '/sessions/digest')).toBe(true) })
    // 她说的、它说的,原样(数出来的,不经模型)。
    await waitFor(() => { expect(screen.getByText('加个导出 PDF', { selector: '.ben-wb__session-digest-ask' })).toBeInTheDocument() })
    expect(screen.getByText('好,我先看这一页现在是怎么画的。')).toBeInTheDocument()
    expect(screen.getByText('看完了,排版那一路和调系统打印那一路都走得通,区别在改样式方便不方便。')).toBeInTheDocument()
    // 在哪个项目(登记表 / 会话文件里现成的)。
    expect(screen.getByText(/desktop-workbench/)).toBeInTheDocument()
  })

  it('② 读不到前面的对话(离线 / 中转):如实一句,不编;问题与选项照旧摆、照旧答得了', async () => {
    const { impl } = stub(() => ({ status: 503, body: { error: '连不上工作台' } }))
    render(<SessionAsk session={asking({ full: FULL })} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    await userEvent.click(screen.getByRole('button', { name: '它刚才在干什么' }))
    await waitFor(() => { expect(screen.getByText('这会儿取不到前面的对话')).toBeInTheDocument() })
    // 那一问本身照样在,选项照样点得到(卡 WQ 那条路没动)。
    expect(screen.getByTestId('sask-say')).toHaveTextContent(LONG_QUESTION)
    expect(screen.getByRole('button', { name: /自己排版/ })).toBeEnabled()
  })

  it('③ 收成一行那种摆法(row)不带这两样:它是一行字 + 「展开」', () => {
    const { impl, paths } = stub()
    render(<SessionAsk session={asking({ full: FULL })} baseUrl={BASE} fetchImpl={impl} variant="row" />)
    expect(screen.queryByRole('button', { name: '它刚才在干什么' })).not.toBeInTheDocument()
    expect(paths).toEqual([])
  })

  it('④ 答上去的还是工作台给的那一颗 label(短的那一份),不拿原文那一颗顶替', async () => {
    const calls: { path: string, body: unknown }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
      if (url.pathname === '/sessions/digest') return new Response(JSON.stringify(digest()), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ ok: true, confirmed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const long = { ...FULL, options: [{ label: '自己排版,字体与页边距都在工作台设置里点(以后改样式不用动别人的东西)' }, { label: '调系统打印那一路' }] }
    render(<SessionAsk session={asking({ full: long })} baseUrl={BASE} fetchImpl={impl} variant="card" />)
    // 看见的是原文那一颗(整句),按下去送回去的是工作台给的那一颗。
    await userEvent.click(screen.getByRole('button', { name: /自己排版,字体与页边距都在工作台设置里点/ }))
    await waitFor(() => { expect(calls.some(one => one.path === '/asks/answer')).toBe(true) })
    expect(calls.find(one => one.path === '/asks/answer')?.body).toMatchObject({ choice: '自己排版' })
  })
})
