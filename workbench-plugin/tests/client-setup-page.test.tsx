/**
 * 「体检与修复」页的渲染与那几颗按钮(2026-09-17 卡 A;09-17 晚改名并降级为只从设置进)。
 *
 * fetch 全是假的:这一页每颗按钮背后都会真改机器(装运行时、写 launchd、往 /Applications
 * 里 ditto),所以用例里**一条都不能真发出去**。断言的是「点了发什么请求、回来显示什么话」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REDO_ONBOARDING_CONFIRM, SetupPage, SetupReopenRow, switchLogLine } from '../src/client/setup/SetupPage.tsx'
import type { WorkbenchState } from '../src/protocol.ts'
import type { SetupItem, SetupJobView, SetupStatus } from '../src/server/setup/types.ts'

afterEach(cleanup)

function item(over: Partial<SetupItem> = {}): SetupItem {
  return { key: 'k', label: 'L', state: 'ok', detail: 'd', step: 1, ...over }
}

function status(items: readonly SetupItem[]): SetupStatus {
  return {
    items,
    all_ok: items.every(one => one.optional === true || one.state === 'ok'),
    optional_pending: items.filter(one => one.optional === true && one.state !== 'ok').length,
    checked_at: '2026-09-17T10:00:00.000Z',
  }
}

const EMPTY_STATE: WorkbenchState = {
  agents: [], sessions: [], quota: {}, now: '2026-09-17T10:00:00.000Z', stale: false,
} as unknown as WorkbenchState

interface Stub {
  impl: typeof fetch
  calls: { url: string, method: string, body: unknown }[]
  /** 下一条 /setup/install 回什么。 */
  job: SetupJobView
}

function stub(options: {
  status?: SetupStatus
  apk?: unknown
  /** /config/* 有没有合并进来(卡 C)。缺省当作还没有 → 404。 */
  configPaths?: unknown
  hooks?: unknown
  job?: Partial<SetupJobView>
} = {}): Stub {
  const calls: Stub['calls'] = []
  const job: SetupJobView = {
    id: 'job-1', step: 'node', state: 'done', started_at: '2026-09-17T10:00:00.000Z', tail: [], ...options.job,
  }
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const reply = (body: unknown, ok = true, code = 200): Response =>
      ({ ok, status: code, json: async () => body }) as unknown as Response
    if (url.endsWith('/setup/status')) return reply(options.status ?? status([]))
    if (url.includes('/setup/install/')) return reply(job)
    if (url.endsWith('/setup/install')) return reply(job)
    if (url.endsWith('/setup/open')) return reply({ ok: true })
    if (url.endsWith('/setup/apk.json')) return reply(options.apk ?? { available: false, path: '/x', hint: '出包办法' })
    if (url.includes('/config/paths')) {
      return options.configPaths === undefined ? reply({ error: '没这条路' }, false, 404) : reply(options.configPaths)
    }
    if (url.includes('/config/hooks')) {
      return options.hooks === undefined ? reply({ error: '没这条路' }, false, 404) : reply(options.hooks)
    }
    if (url.endsWith('/channel/status')) return reply({ configured: false, server: false, worker: false })
    return reply({ ok: true, deepseek: false, kimi_web: false, claude_api: false })
  }) as unknown as typeof fetch
  return { impl, calls, job }
}

function show(s: Stub, over: { status?: SetupStatus, state?: WorkbenchState, onClose?: () => void } = {}) {
  return render(
    <SetupPage
      baseUrl="http://x"
      fetchImpl={s.impl}
      state={over.state ?? EMPTY_STATE}
      onClose={over.onClose ?? (() => {})}
      jobPollMs={0}
    />,
  )
}

describe('体检与修复页 · 九步与灯', () => {
  it('九步都画出来,每步一盏灯', async () => {
    const s = stub({ status: status([]) })
    show(s)
    await waitFor(() => expect(screen.getByLabelText('第 1 步 就绪检查')).toBeTruthy())
    for (const [no, title] of [[2, '仓库在哪'], [3, '系统授权'], [4, '密钥与钩子'], [5, '客户端体检'], [6, '目录与例程'], [7, '事务官'], [8, '手机'], [9, '收尾']] as const) {
      expect(screen.getByLabelText(`第 ${no} 步 ${title}`)).toBeTruthy()
    }
  })

  it('缺的那一项:显示状态、事实、怎么修,还有一颗一键装', async () => {
    const s = stub({
      status: status([item({
        key: 'node', label: '自有 node', state: 'missing', detail: '不存在', fix: '一键装会复制一份过去',
        action: { kind: 'install', step: 'node', label: '装一份自有 node' },
      })]),
    })
    show(s)
    const row = await screen.findByLabelText('自有 node')
    expect(within(row).getByText('缺')).toBeTruthy()
    expect(within(row).getByText('不存在')).toBeTruthy()
    expect(within(row).getByText('一键装会复制一份过去')).toBeTruthy()
    expect(within(row).getByRole('button', { name: '装一份自有 node' })).toBeTruthy()
    // 第 1 步的灯是「等你点一下」。
    expect(within(screen.getByLabelText('第 1 步 就绪检查')).getByText('等你点一下')).toBeTruthy()
  })

  it('已就绪那几行不给按钮(只让他看见"确实查过了")', async () => {
    const s = stub({ status: status([item({ key: 'node', label: '自有 node', detail: 'v24.19.0' })]) })
    show(s)
    const row = await screen.findByLabelText('自有 node')
    expect(within(row).getByText('已就绪')).toBeTruthy()
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('页头如实说还差几项', async () => {
    const s = stub({ status: status([item({ state: 'missing' }), item({ key: 'b' })]) })
    show(s)
    await waitFor(() => expect(screen.getByText('还差 1 项。')).toBeTruthy())
  })
})

describe('体检与修复页 · 一键装', () => {
  it('点「一键装」→ POST /setup/install {step},进度框显示服务端那句人话', async () => {
    const s = stub({
      status: status([item({ key: 'runtime', label: 'DSH 运行时', state: 'missing', action: { kind: 'install', step: 'runtime', label: '装运行时' } })]),
      job: { id: 'job-1', step: 'runtime', state: 'running', note: '在装(网络慢会久一点)' },
    })
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '装运行时' }))
    await waitFor(() => expect(s.calls.find(call => call.url === 'http://x/setup/install')?.body).toEqual({ step: 'runtime' }))
    const progress = await screen.findByLabelText('安装进度 runtime')
    expect(within(progress).getByText('在装(网络慢会久一点)')).toBeTruthy()
    // 在跑的时候按钮按不下去,免得起第二个 npm。
    expect(screen.getByRole('button', { name: '进行中…' })).toBeDisabled()
  })

  it('失败时把人话与原始输出尾巴都摆出来 —— 绝不做成"点了没反应"', async () => {
    const s = stub({
      status: status([item({ key: 'runtime', label: 'DSH 运行时', state: 'missing', action: { kind: 'install', step: 'runtime', label: '装运行时' } })]),
      job: { id: 'job-1', step: 'runtime', state: 'failed', error: '装 DSH 运行时失败(命令 npm 退出码 1)', tail: ['npm ERR! network', 'npm ERR! 拉取超时'] },
    })
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '装运行时' }))
    const progress = await screen.findByLabelText('安装进度 runtime')
    expect(within(progress).getByText(/装 DSH 运行时失败/)).toBeTruthy()
    expect(within(progress).getByLabelText('原始输出').textContent).toContain('拉取超时')
  })

  it('第 1 步末尾永远有一颗「重启 DSH」——前面几步改的东西大多要重启才生效', async () => {
    const s = stub({ status: status([]) })
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '重启 DSH' }))
    expect(s.calls.find(call => call.url === 'http://x/setup/install')?.body).toEqual({ step: 'restart' })
  })
})

describe('体检与修复页 · 系统授权', () => {
  it('「去授权」→ POST /setup/open {pane};「重新检查」再体检一次', async () => {
    const s = stub({
      status: status([item({
        key: 'accessibility', label: '辅助功能授权', state: 'needs_user', step: 3,
        action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
      })]),
    })
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '去授权' }))
    expect(s.calls.find(call => call.url === 'http://x/setup/open')?.body).toEqual({ pane: 'accessibility' })

    const before = s.calls.filter(call => call.url === 'http://x/setup/status').length
    await userEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await waitFor(() => expect(s.calls.filter(call => call.url === 'http://x/setup/status').length).toBe(before + 1))
  })

  /**
   * 「完全磁盘访问」那一格的三颗键(2026-10-13)。三段少一段她就做不完:
   * 打开那一页 → 把隐藏目录(`~/.dsh`)里那条 node 翻出来拖进去 → 回来确认。
   */
  it('★完全磁盘访问那一格:主键 + extras 三颗键都画出来,各打各的那一下', async () => {
    const s = stub({
      status: status([item({
        key: 'full_disk_access', label: '完全磁盘访问(手机看文件)', state: 'needs_user', step: 3,
        action: { kind: 'open_pane', pane: 'all_files', label: '打开系统设置那一页' },
        extras: [
          { kind: 'open_pane', pane: 'node_binary', label: '在访达里显示要加的那个文件' },
          { kind: 'recheck', label: '再核一次' },
        ],
      })]),
    })
    show(s)
    const panesOpened = (): unknown[] => s.calls.filter(call => call.url === 'http://x/setup/open').map(call => (call.body as { pane?: unknown })?.pane)
    await userEvent.click(await screen.findByRole('button', { name: '打开系统设置那一页' }))
    await waitFor(() => { expect(panesOpened()).toContain('all_files') })

    await userEvent.click(screen.getByRole('button', { name: '在访达里显示要加的那个文件' }))
    await waitFor(() => { expect(panesOpened()).toContain('node_binary') })

    const before = s.calls.filter(call => call.url === 'http://x/setup/status').length
    await userEvent.click(screen.getByRole('button', { name: '再核一次' }))
    await waitFor(() => expect(s.calls.filter(call => call.url === 'http://x/setup/status').length).toBe(before + 1))
  })

  it('没有 extras 的老项照旧只有一颗键', async () => {
    const s = stub({
      status: status([item({
        key: 'accessibility', label: '辅助功能授权', state: 'needs_user', step: 3,
        action: { kind: 'open_pane', pane: 'accessibility', label: '去授权' },
      })]),
    })
    show(s)
    const row = await screen.findByLabelText('辅助功能授权')
    expect(row.querySelectorAll('.ben-wb__setup-btn').length).toBe(1)
  })

  it('打不开系统设置时把服务端那句话显示出来', async () => {
    const s = stub({
      status: status([item({ key: 'files', state: 'needs_user', step: 3, action: { kind: 'open_pane', pane: 'files', label: '去授权' } })]),
    })
    const failing = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/setup/open')) return { ok: false, status: 500, json: async () => ({ error: '打不开系统设置那一页' }) } as unknown as Response
      return await (s.impl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    render(<SetupPage baseUrl="http://x" fetchImpl={failing} state={EMPTY_STATE} onClose={() => {}} jobPollMs={0} />)
    await userEvent.click(await screen.findByRole('button', { name: '去授权' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('打不开系统设置那一页')
  })
})

describe('体检与修复页 · 客户端体检', () => {
  it('没装的那家标「等你」并给下载链接,还标着「可选」', async () => {
    const s = stub({
      status: status([item({
        key: 'client_kimi', label: 'Kimi 桌面版', state: 'needs_user', step: 5, optional: true,
        action: { kind: 'link', url: 'https://www.kimi.com/', label: '去下载' },
      })]),
    })
    show(s)
    const row = await screen.findByLabelText('Kimi 桌面版')
    expect(within(row).getByText('可选')).toBeTruthy()
    expect(within(row).getByRole('link', { name: '去下载' })).toHaveAttribute('href', 'https://www.kimi.com/')
    // 可选项不点红灯,但要数出来。
    const step5 = screen.getByLabelText('第 5 步 客户端体检')
    expect(within(step5).getByText('已就绪')).toBeTruthy()
    expect(within(step5).getByText(/另有 1 项可选的没弄/)).toBeTruthy()
  })
})

describe('体检与修复页 · 卡 C 那两条接口还没合并时', () => {
  it('第 2 步如实说「路径配置接口还没合并」,不报一个吓人的错', async () => {
    const s = stub()
    show(s)
    await waitFor(() => expect(screen.getByText(/路径配置接口\(GET\/PUT \/config\/paths\)还没合并/)).toBeTruthy())
  })

  it('接口在了就画输入框,保存走 PUT /config/paths', async () => {
    const s = stub({ configPaths: { scan_roots: null, inbox_dirs: null, butler_cwd: '/repo', effective: { scan_roots: [{ path: '/a', depth: 1 }], inbox_dirs: ['/b'], butler_cwd: '/repo', butler_cwd_source: 'app.json' } } })
    show(s)
    const input = await screen.findByLabelText('仓库目录')
    expect(input).toHaveValue('/repo')
    // 0.2.36 首发事故:卡 C 顶层是 null(没配),画 effective 才不会对 null 调 join
    expect(await screen.findByText('项目扫描根:/a(深 1)(默认)')).toBeTruthy()
    await userEvent.clear(input)
    await userEvent.type(input, '/新仓库')
    await userEvent.click(screen.getByRole('button', { name: '保存仓库路径' }))
    await waitFor(() => {
      const put = s.calls.find(call => call.url === 'http://x/config/paths' && call.method === 'PUT')
      expect(put?.body).toEqual({ butler_cwd: '/新仓库' })
    })
  })

  it('第 4 步的钩子:点「看一下」去问卡 C 的接口,没合并就说没合并', async () => {
    const s = stub()
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '看一下' }))
    await waitFor(() => expect(s.calls.some(call => call.url.includes('/config/hooks?agent=claude'))).toBe(true))
    expect(await screen.findByText(/钩子接口\(GET \/config\/hooks\)还没合并/)).toBeTruthy()
  })
})

describe('体检与修复页 · 事务官三盏灯', () => {
  it('引导 / 形象音色 / 通道层各一盏,各有去处', async () => {
    const s = stub()
    const state = {
      ...EMPTY_STATE,
      onboarding: { stage: 'habits', done: false },
      butler: { running: true, port: 8792, avatarCount: 3, voiceCount: 2 },
    } as unknown as WorkbenchState
    show(s, { state })
    expect(within(await screen.findByLabelText('引导阶段')).getByText(/停在「habits」/)).toBeTruthy()
    const looks = screen.getByLabelText('形象与音色')
    expect(within(looks).getByText(/在跑\(8792\)/)).toBeTruthy()
    await userEvent.click(within(looks).getByRole('button', { name: '去配置后台' }))
    expect(s.calls.some(call => call.url === 'http://x/butler/open')).toBe(true)
    expect(within(screen.getByLabelText('通道层')).getByText(/没配 LiveKit/)).toBeTruthy()
  })
})

describe('体检与修复页 · 手机(双端流程)', () => {
  it('先问「手机端装了吗」,包出过就给下载二维码', async () => {
    const s = stub({ apk: { available: true, path: '/x.apk', size: 12 * 1024 * 1024, built_at: '2026-09-17T09:00:00.000Z', url: 'http://172.20.10.1:8791/setup/apk' } })
    show(s)
    const panel = await screen.findByLabelText('手机端装了吗')
    expect(within(panel).getByRole('img', { name: '配对二维码' })).toBeTruthy()
    expect(within(panel).getByText(/http:\/\/172\.20\.10\.1:8791\/setup\/apk/)).toBeTruthy()
  })

  it('云上那份:括号里报版本号(它没有"出于什么时候"),底下写「扫码下载(公网)」', async () => {
    const s = stub({
      apk: { available: true, path: '(在阿里云上,这台电脑上没有)', size: 32 * 1024 * 1024, version: '0.2.42', source: 'cloud', url: 'https://api.aibooo.cn/updates/0.2.42/app.apk' },
    })
    show(s)
    const panel = await screen.findByLabelText('手机端装了吗')
    expect(within(panel).getByText(/0\.2\.42,32 MB/)).toBeTruthy()
    expect(within(panel).getByText('扫码下载(公网)')).toBeTruthy()
    expect(within(panel).getByText(/api\.aibooo\.cn/)).toBeTruthy()
    // "未知时间"那句只属于局域网那条路 —— 不能拿本机文件的时间冒充云上那份。
    expect(within(panel).queryByText(/未知时间/)).toBeNull()
  })

  it('没出过包就说怎么出包,而不是给一个打不开的二维码', async () => {
    const s = stub({ apk: { available: false, path: '/x.apk', hint: '在仓库 butler-app/ 里跑一次 pnpm android:debug' } })
    show(s)
    const panel = await screen.findByLabelText('手机端装了吗')
    expect(within(panel).getByText(/pnpm android:debug/)).toBeTruthy()
    expect(within(panel).queryByRole('img', { name: '配对二维码' })).toBeNull()
  })

  it('「已装,生成配对码」→ 顺手开局域网 + POST /pair/start', async () => {
    const s = stub()
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '已装,生成配对码' }))
    await userEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(s.calls.find(call => call.url === 'http://x/lan')?.body).toEqual({ enabled: true }))
    expect(s.calls.some(call => call.url === 'http://x/pair/start')).toBe(true)
  })

  it('「先跳过,纯电脑用」说清楚跳过不影响什么', async () => {
    const s = stub()
    show(s)
    await userEvent.click(await screen.findByRole('button', { name: '先跳过,纯电脑用' }))
    expect(screen.getByText(/纯电脑用没问题/)).toBeTruthy()
  })

  it('已经配对过就不再问,直接说配了哪几台', async () => {
    const s = stub()
    const state = { ...EMPTY_STATE, devices: [{ id: 'd1', name: '我的手机', platform: 'android', last_seen_at: '2026-09-17T09:00:00.000Z' }] } as unknown as WorkbenchState
    show(s, { state })
    await waitFor(() => expect(screen.getByText(/已经配对过 1 台:我的手机/)).toBeTruthy())
  })
})

describe('体检与修复页 · 收尾与出口', () => {
  it('第 9 步就是 Time Machine,而且说清楚它是哪次事故换来的', async () => {
    const s = stub()
    show(s)
    const panel = await screen.findByLabelText('Time Machine')
    expect(within(panel).getByText('把 Time Machine 打开。')).toBeTruthy()
    expect(within(panel).getByText(/100GB/)).toBeTruthy()
  })

  it('「关闭」回看板', async () => {
    const s = stub()
    const onClose = vi.fn()
    show(s, { onClose })
    await userEvent.click(await screen.findByRole('button', { name: '关闭体检与修复' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('设置里那一行点一下就打开体检与修复(2026-09-17 改名并降级:只从设置进;10-22 起那颗键照评审页叫「开始体检」)', async () => {
    const onOpen = vi.fn()
    render(<SetupReopenRow onOpen={onOpen} />)
    await userEvent.click(screen.getByRole('button', { name: '开始体检' }))
    expect(onOpen).toHaveBeenCalled()
  })

  it('那一行旁边可以挂「重新走一遍首次流程」;不给就不画', async () => {
    const onReplay = vi.fn()
    const { rerender } = render(<SetupReopenRow onOpen={() => {}} />)
    expect(screen.queryByRole('button', { name: '重新走一遍首次流程' })).toBeNull()
    rerender(<SetupReopenRow onOpen={() => {}} onReplayFirstRun={onReplay} />)
    await userEvent.click(screen.getByRole('button', { name: '重新走一遍首次流程' }))
    expect(onReplay).toHaveBeenCalled()
  })

  /**
   * 「重新做一遍引导」(2026-09-27,卡 OB)。维护者:「桌面端估计得给我一个初始化的按钮,
   * 不然都已经做完了」—— 他那台 Air 已经走完旧引导,只擦首次流程那面旗子是不会重问的。
   * 这一颗**必须先二次确认**:它是唯一一颗会把答过的问题重新问一遍的按钮。
   */
  it('「重新做一遍引导」(10-22 起那一行照评审页叫「重新设置工作台」):不给不画;点了先问一句人话,他说不就什么都不做', async () => {
    const onRedo = vi.fn()
    const { rerender } = render(<SetupReopenRow onOpen={() => {}} />)
    expect(screen.queryByRole('button', { name: '打开「重新设置工作台」' })).toBeNull()
    rerender(<SetupReopenRow onOpen={() => {}} onRedoOnboarding={onRedo} confirmImpl={() => false} />)
    await userEvent.click(screen.getByRole('button', { name: '打开「重新设置工作台」' }))
    expect(onRedo).not.toHaveBeenCalled()
  })

  it('「重新做一遍引导」确认之后才动手;那句确认里说清了什么不会动', async () => {
    const onRedo = vi.fn()
    const asked: string[] = []
    render(<SetupReopenRow onOpen={() => {}} onRedoOnboarding={onRedo} confirmImpl={(message) => { asked.push(message); return true }} />)
    await userEvent.click(screen.getByRole('button', { name: '打开「重新设置工作台」' }))
    expect(onRedo).toHaveBeenCalled()
    expect(asked[0]).toBe(REDO_ONBOARDING_CONFIRM)
    expect(asked[0]).toContain('从称呼开始')
    expect(asked[0]).toContain('项目、事项、随手记、文件、记忆都不动')
  })

  /**
   * 「最近的窗位切换」(2026-09-21「点标签切换经常卡住」):Ben 没有别的办法把"卡住"
   * 这种感觉变成数字 —— curl /state 抠 JSON 是命令行,他不走那条路。
   */
  describe('最近的窗位切换', () => {
    it('一条记录都没有时整块不出现(缺省即无)', async () => {
      render(<SetupPage baseUrl="http://x" fetchImpl={stub().impl} state={EMPTY_STATE} onClose={() => {}} jobPollMs={0} />)
      await screen.findByText('体检与修复')
      expect(screen.queryByLabelText('最近的窗位切换')).toBeNull()
    })

    it('有记录就一行一条,最近的排最上面', async () => {
      const state = {
        ...EMPTY_STATE,
        dock: {
          stack: [],
          recent_switches: [
            { app: 'codex', ts: '2026-09-21T10:00:00.000Z', ok: true, total_ms: 40, raise_ms: 30, hidden: 1 },
            { app: 'claude', ts: '2026-09-21T10:00:05.000Z', ok: true, total_ms: 3000, raise_ms: 3000, hidden: 0, deferred: 1 },
          ],
        },
      } as unknown as WorkbenchState
      render(<SetupPage baseUrl="http://x" fetchImpl={stub().impl} state={state} onClose={() => {}} jobPollMs={0} />)
      const block = await screen.findByLabelText('最近的窗位切换')
      const lines = within(block).getAllByText(/切到/)
      expect(lines).toHaveLength(2)
      expect(lines[0]?.textContent).toContain('claude') // 最近的那一条在最上面
      expect(lines[1]?.textContent).toContain('codex')
    })

    it('一条记录的人话:耗时、抬窗、挪到后台的、没动成的都如实说', () => {
      expect(switchLogLine({ app: 'claude', ts: '2026-09-21T10:00:00.000Z', ok: true, total_ms: 40, raise_ms: 30, hidden: 1 }))
        .toContain('切到「claude」 共 40ms(抬窗 30ms)')
      const slow = switchLogLine({
        app: 'claude', ts: '2026-09-21T10:00:00.000Z', ok: false,
        total_ms: 3000, raise_ms: 3000, hidden: 0, deferred: 2, timed_out: ['codex(壳响应超时)'],
      })
      expect(slow).toContain('没切成')
      expect(slow).toContain('2 家挪到后台藏')
      expect(slow).toContain('没动成:codex(壳响应超时)')
    })
  })
})
