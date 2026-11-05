/**
 * 设置 → 「更新」那一节(2026-09-18 热更新)。
 *
 * 两半:`updateModel.ts` 那几个纯函数(措辞与档位),以及 `UpdatePanel` 真渲染出来的那一屏。
 * 界面会改,**措辞不该跟着界面一起没人验** —— 目标用户不懂代码,那几句话就是这张卡的交付物。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from '../src/client/TopBar.tsx'
import { UpdatePanel } from '../src/client/update/UpdatePanel.tsx'
import { applyLabelOf, downloadLineOf, headlineOf, humanDuration, INSTALLER_HINT, jobHeadlineOf, NEEDS_INSTALLER_HINT, OFFICIAL_SITE, planLineOf, progressOf, runtimeStaleButtonOf, runtimeStaleLineOf, stageOf } from '../src/client/update/updateModel.ts'
import type { UpdateCheckView, UpdateJobView, UpdateRuntimeStaleView } from '../src/server/update/types.ts'

afterEach(cleanup)

const WIDGET = { valueText: '未接入', error: true, alert: false } as const

function checkView(over: Partial<UpdateCheckView> = {}): UpdateCheckView {
  return { current: '0.2.41', available: false, checked_at: '2026-09-18T10:00:00.000Z', ...over }
}

function jobView(over: Partial<UpdateJobView> = {}): UpdateJobView {
  return {
    id: 'up-1', step: 'update', state: 'running', started_at: '2026-09-18T10:00:00.000Z',
    tail: [], version: '0.2.42', progress: 0, phase: '正在下载', skipped: [], unchanged: [], ...over,
  }
}

describe('updateModel', () => {
  it('档位:没查过 / 正在查 / 最新 / 有新版 / 查不到 / 太旧', () => {
    expect(stageOf(undefined, false)).toBe('idle')
    expect(stageOf(undefined, true)).toBe('checking')
    expect(stageOf(checkView(), false)).toBe('latest')
    expect(stageOf(checkView({ available: true, latest: '0.2.42' }), false)).toBe('available')
    expect(stageOf(checkView({ error: '连不上更新服务器' }), false)).toBe('unreachable')
    expect(stageOf(checkView({ needs_installer: '太旧了' }), false)).toBe('needs_installer')
  })

  it('查不到时**原样说服务端那句人话**,不包一层「检查失败」', () => {
    const view = checkView({ error: '连不上更新服务器(api.aibooo.cn)。多半是这会儿没网。' })
    expect(headlineOf(view, 'unreachable')).toBe(view.error)
  })

  it('唯一那颗按钮上把这一下会发生什么说全;别的档位根本没有这颗按钮', () => {
    expect(applyLabelOf(checkView({ available: true, latest: '0.2.42', size: 1_150_000 }), 'available'))
      .toBe('有新版 0.2.42,更新并重启')
    expect(applyLabelOf(checkView(), 'latest')).toBeUndefined()
    expect(applyLabelOf(checkView({ error: 'x' }), 'unreachable')).toBeUndefined()
    expect(applyLabelOf(checkView({ needs_installer: 'x' }), 'needs_installer')).toBeUndefined()
  })

  it('★安装包那两句都指官网,一个 dmg 直链都没有(2026-09-28,卡 UP)', () => {
    expect(INSTALLER_HINT).toContain(OFFICIAL_SITE)
    expect(INSTALLER_HINT).not.toContain('.dmg')
    expect(NEEDS_INSTALLER_HINT).toContain(OFFICIAL_SITE)
    expect(NEEDS_INSTALLER_HINT).not.toContain('.dmg')
  })

  it('★还没查回来时说的是"正在看",不是"还没查过"(打开就自己查了)', () => {
    expect(headlineOf(undefined, 'idle')).toContain('正在看')
    expect(headlineOf(undefined, 'checking')).toContain('正在看')
  })

  it('进度框那一行:跑着说在干什么、重启时说重启中、失败说为什么', () => {
    expect(jobHeadlineOf(jobView({ note: '正在下载 1/2:工作台本体(1.1 MB)' }))).toContain('正在下载 1/2')
    expect(jobHeadlineOf(jobView({ state: 'done', restarting: true }))).toContain('重启中')
    expect(jobHeadlineOf(jobView({ state: 'failed', error: '没网' }))).toBe('没网')
  })

  it('进度条只增不减(轮询回来的顺序不保证)', () => {
    expect(progressOf(jobView({ progress: 30 }), 60)).toBe(60)
    expect(progressOf(jobView({ progress: 80 }), 60)).toBe(80)
    expect(progressOf(jobView({ progress: 999 }), 0)).toBe(100)
  })
})

/** 假 fetch:check 回给定视图;apply 回给定作业;job 依次回 script 里的下一条。 */
function fakeFetch(options: { check?: UpdateCheckView, jobs?: readonly UpdateJobView[], checkFails?: boolean }) {
  let step = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
    const text = String(url)
    if (text.endsWith('/update/check')) {
      if (options.checkFails === true) {
        return { ok: false, status: 500, json: async () => ({ error: '服务端自己坏了' }) } as unknown as Response
      }
      return reply(options.check ?? checkView())
    }
    if (text.endsWith('/update/apply') && init?.method === 'POST') return reply(options.jobs?.[0] ?? jobView())
    if (text.includes('/update/job/')) {
      step += 1
      return reply(options.jobs?.[Math.min(step, (options.jobs.length ?? 1) - 1)] ?? jobView())
    }
    return reply({})
  }) as unknown as typeof fetch
}

describe('UpdatePanel', () => {
  it('★打开这一页就自己查一次(不用先点「检查更新」,那颗按钮也不该在)', async () => {
    const fetchImpl = fakeFetch({ check: checkView({ available: true, latest: '0.2.42' }) })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} currentVersion="0.2.41" />)
    expect(screen.getByText(/这台电脑上装的是 0\.2\.41/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/有新版:0\.2\.42/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument()
    expect(fetchImpl).toHaveBeenCalledWith('http://x/update/check')
  })

  it('查到最新:一句「已经是最新的了」,整节一颗按钮都没有', async () => {
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check: checkView() })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByText(/已经是最新的了/)).toBeInTheDocument())
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('★查到新版:屏上**只有一颗**按钮,写着有新版几点几、更新并重启', async () => {
    const check = checkView({ available: true, latest: '0.2.42', size: 1_150_000, notes: '修了窗口落屏' })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByText(/有新版:0\.2\.42/)).toBeInTheDocument())
    expect(screen.getByLabelText('这一版改了什么')).toHaveTextContent('修了窗口落屏')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('有新版 0.2.42,更新并重启')
  })

  it('没网:一句人话 + 一个「再查一次」的文字链接(不是第二颗主按钮)', async () => {
    const check = checkView({ error: '连不上更新服务器(api.aibooo.cn)。多半是这会儿没网,过一会儿再点一次。' })
    const fetchImpl = fakeFetch({ check })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByText(/多半是这会儿没网/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /更新并重启/ })).not.toBeInTheDocument()
    const again = screen.getByRole('button', { name: '再查一次' })
    // 2026-10-22 起按钮走设置那一套(`data-kind`):它是无框的次级键,不是描边 / 实心的主键。
    expect(again).toHaveAttribute('data-kind', 'plain')
    await userEvent.click(again)
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
  })

  it('这一份不查更新(没接中转):说一句怎么办,不给「再查一次」', async () => {
    const check = checkView({ error: '这台没接中转,不自动查更新;新版本到项目主页下载。', not_configured: true })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByText(/这台没接中转/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '再查一次' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /更新并重启/ })).not.toBeInTheDocument()
  })

  it('点「立即更新」之后出进度条与当前这一步', async () => {
    const check = checkView({ available: true, latest: '0.2.42', size: 1000 })
    const jobs = [jobView({ progress: 10, phase: '正在下载', note: '正在下载 1/2:工作台本体(1.1 MB)' })]
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check, jobs })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /更新并重启/ })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /更新并重启/ }))
    await waitFor(() => expect(screen.getByRole('progressbar', { name: '更新进度' })).toHaveAttribute('aria-valuenow', '10'))
    expect(screen.getByLabelText('更新作业')).toBeInTheDocument()
    expect(screen.getByText(/正在下载 1\/2/)).toBeInTheDocument()
  })

  it('装完在重启:那一行说「重启中…」,并且跳过的那几步各说一句', async () => {
    const check = checkView({ available: true, latest: '0.2.42', size: 1000 })
    const jobs = [jobView({
      state: 'done', restarting: true, progress: 100,
      skipped: ['没换工作台窗口:新那份壳的签名身份跟你现在装的这份不一样。'],
    })]
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check, jobs })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /更新并重启/ })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /更新并重启/ }))
    await waitFor(() => expect(screen.getByText(/重启中/)).toBeInTheDocument())
    expect(screen.getByLabelText('这次没换的')).toHaveTextContent('签名身份')
  })

  it('失败:人话 + 原始输出 + 一颗「重试」,并说清楚重试不会重下', async () => {
    const check = checkView({ available: true, latest: '0.2.42', size: 1000 })
    const jobs = [jobView({ state: 'failed', error: '「工作台本体」没下下来(curl 退出码 6)。', tail: ['curl: (6) Could not resolve host'] })]
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check, jobs })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /更新并重启/ })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /更新并重启/ }))
    await waitFor(() => expect(screen.getByText(/没下下来/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByText(/不会重下/)).toBeInTheDocument()
    expect(screen.getByLabelText('原始输出')).toHaveTextContent('Could not resolve host')
    // 失败时不画那条停在半路的进度条 —— 该被看见的是"为什么"。
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('★这台太旧升不过去:没有按钮,只有一句"去官网下安装包"', async () => {
    const check = checkView({ needs_installer: '这台电脑上的工作台(0.2.41)太旧了,没法直接升到 9.9.9。' })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByText(/太旧了/)).toBeInTheDocument())
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText(NEEDS_INSTALLER_HINT)).toBeInTheDocument()
  })

  it('服务端自己坏了(不是没网):这一下的错也要说出来,不做成"点了没反应"', async () => {
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ checkFails: true })} jobPollMs={0} />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('服务端自己坏了'))
  })
})

describe('齿轮上那个点', () => {
  function bar(updateDot: boolean) {
    render(
      <TopBar
        lamps={[]}
        now="10:00"
        storage={WIDGET}
        performance={WIDGET}
        onOpenSettings={() => {}}
        updateDot={updateDot}
      />,
    )
  }

  it('有新版时齿轮带一个点,并且读屏能读出来', () => {
    bar(true)
    expect(screen.getByRole('button', { name: '设置(有新版)' })).toBeInTheDocument()
  })

  it('没新版时就是平常那颗齿轮', () => {
    bar(false)
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
  })
})

describe('只下变了的:那句账与那行速度(2026-09-18)', () => {
  const plan = (over: Partial<NonNullable<UpdateCheckView['plan']>> = {}): NonNullable<UpdateCheckView['plan']> => ({
    items: [], total: 5, changed: 2, bytes: 1_150_000, all_bytes: 134_000_000, ...over,
  })

  it('有几样没变:说清楚几项里几项变了、这次下多少、省下多少', () => {
    const line = planLineOf(checkView({ available: true, latest: '0.2.45', plan: plan() }), 'available')
    expect(line).toContain('5 项里 2 项有变化')
    expect(line).toContain('下载 1.1 MB')
    expect(line).toContain('省下')
  })

  it('全都要下(第一次):不说「省下」,只说合计多少', () => {
    const line = planLineOf(checkView({ available: true, plan: plan({ changed: 5, bytes: 134_000_000 }) }), 'available')
    expect(line).toContain('5 样东西要下')
    expect(line).not.toContain('省下')
  })

  it('一样都没变:直说不用下也不用换', () => {
    const line = planLineOf(checkView({ available: true, plan: plan({ changed: 0, bytes: 0 }) }), 'available')
    expect(line).toContain('一模一样')
  })

  it('不是「有新版」那一档,就没有这句话 —— 已经最新时不该冒出一句账', () => {
    expect(planLineOf(checkView({ plan: plan() }), 'latest')).toBeUndefined()
    expect(planLineOf(checkView({ available: true }), 'available')).toBeUndefined()
  })

  it('算不出速度时那一行只剩「已下 / 总量」,一个编出来的数都没有', () => {
    const line = downloadLineOf(jobView({ download: { total: 1_150_000, done: 400_000 } }))
    expect(line).toBe('已下 391 KB / 1.1 MB')
  })

  it('算得出速度时才有速度与预计剩余', () => {
    const line = downloadLineOf(jobView({
      download: { total: 1_150_000, done: 400_000, bytes_per_sec: 250_000, eta_seconds: 3 },
    }))
    expect(line).toContain('244 KB/秒')
    expect(line).toContain('大约还要 3 秒')
  })

  it('跑完了就不再显示那一行(解包与安装不是按字节走的)', () => {
    expect(downloadLineOf(jobView({ state: 'done', download: { total: 10, done: 10 } }))).toBeUndefined()
    expect(downloadLineOf(jobView())).toBeUndefined()
  })

  it('时长说人话', () => {
    expect(humanDuration(3)).toBe('3 秒')
    expect(humanDuration(0)).toBe('1 秒')
    expect(humanDuration(130)).toBe('2 分 10 秒')
    expect(humanDuration(120)).toBe('2 分钟')
    expect(humanDuration(7200)).toBe('一小时以上')
  })

  it('那一屏上:账那句在,跑完之后「这次没重下的」那一节也在', async () => {
    const view = checkView({ available: true, latest: '0.2.45', size: 1_150_000, plan: plan() })
    const done = jobView({
      state: 'done',
      restarting: true,
      unchanged: ['通话组件:跟这台电脑上装着的那份一模一样,这次不下也不装。'],
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/update/check')) return new Response(JSON.stringify(view), { status: 200 })
      if (url.endsWith('/update/apply')) return new Response(JSON.stringify(done), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    render(<UpdatePanel baseUrl="" fetchImpl={fetchImpl} jobPollMs={0} currentVersion="0.2.44" />)
    await waitFor(() => { expect(screen.getByLabelText('这次要下什么')).toHaveTextContent('5 项里 2 项有变化') })
    await userEvent.click(screen.getByRole('button', { name: /更新并重启/ }))
    await waitFor(() => { expect(screen.getByLabelText('这次没重下的')).toHaveTextContent('通话组件') })
  })
})

/**
 * 「DSH 运行环境还没换到这一版:[装运行环境]」那一格(2026-09-26,卡 U6)。
 *
 * 09-26 那台机器的样子:上面那一行写着「已经是最新的了」,同时这一格亮着 ——
 * 所以这几条盯的正是"两句话同时在一屏上都说得通"。
 */
function staleView(over: Partial<UpdateRuntimeStaleView> = {}): UpdateRuntimeStaleView {
  return {
    says: 'DSH 运行环境还没换到这一版(装着的是 0.1.2-rc.1,这一版要 0.1.7-rc.2)。',
    locked: '0.1.7-rc.2',
    installed: '0.1.2-rc.1',
    action_label: '装运行环境',
    ...over,
  }
}

describe('运行环境还没换到这一版(2026-09-26,卡 U6)', () => {
  it('措辞与按钮:自动补在跑的时候说它在跑、**不给按钮**;别的时候一律给', () => {
    expect(runtimeStaleLineOf(undefined)).toBeUndefined()
    expect(runtimeStaleLineOf(staleView())).toContain('0.1.2-rc.1')
    // 正在自动补:说"这会儿在发生什么"比说"运行环境还是旧的"要紧。
    const running = staleView({ repair: { state: 'running', says: '正在自动装 DSH 运行环境…', attempts: 1 } })
    expect(runtimeStaleLineOf(running)).toBe('正在自动装 DSH 运行环境…')
    expect(runtimeStaleButtonOf(running, false)).toBeUndefined()
    // 自动试到头了:那一句说清为什么停了,按钮还在(他自己按不受防循环限制)。
    const stopped = staleView({ repair: { state: 'stopped', says: '自动装过 2 次都没装上,不再自动试了。', attempts: 2 } })
    expect(runtimeStaleLineOf(stopped)).toContain('不再自动试')
    expect(runtimeStaleButtonOf(stopped, false)).toBe('装运行环境')
    // 他自己点的那一趟正在跑:也不给第二颗。
    expect(runtimeStaleButtonOf(staleView(), true)).toBeUndefined()
    // ★有新版时屏上只留「更新并重启」那一颗(2026-09-28,卡 UP)。
    expect(runtimeStaleButtonOf(staleView(), false, true)).toBeUndefined()
  })

  it('★不用等联网那一趟回来就亮着(它读的是本机的运行时目录,跟联网没关系)', () => {
    render(
      <UpdatePanel
        baseUrl="http://x"
        fetchImpl={fakeFetch({})}
        jobPollMs={0}
        currentVersion="0.4.0"
        runtimeStale={staleView()}
      />,
    )
    expect(screen.getByText(/DSH 运行环境还没换到这一版/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '装运行环境' })).toBeInTheDocument()
  })

  it('★「已经是最新的了」与这一格同时在一屏上(09-26 那台机器的样子)', async () => {
    render(
      <UpdatePanel
        baseUrl="http://x"
        fetchImpl={fakeFetch({ check: checkView({ current: '0.4.0' }) })}
        jobPollMs={0}
        runtimeStale={staleView()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/已经是最新的了/)).toBeInTheDocument())
    expect(screen.getByText(/DSH 运行环境还没换到这一版/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '装运行环境' })).toBeInTheDocument()
  })

  it('★有新版时这一格不给第二颗按钮,改说一句"更新那一下会把它一起换好"', async () => {
    render(
      <UpdatePanel
        baseUrl="http://x"
        fetchImpl={fakeFetch({ check: checkView({ available: true, latest: '0.4.5' }) })}
        jobPollMs={0}
        runtimeStale={staleView()}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /更新并重启/ })).toBeInTheDocument())
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText(/更新那一下会把运行环境一起换好/)).toBeInTheDocument()
  })

  it('点「装运行环境」:走 /update/runtime,进度用登录台那条路问', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
      if (String(url).endsWith('/update/runtime')) {
        return reply({
          id: 'rt-1', step: 'runtime', state: 'running', started_at: '2026-09-26T04:00:00.000Z',
          tail: [], note: '正在装 DSH 运行环境(几十秒,装完会自动重启一次)',
        })
      }
      return reply({})
    }) as unknown as typeof fetch
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} runtimeStale={staleView()} />)
    await userEvent.click(screen.getByRole('button', { name: '装运行环境' }))
    await waitFor(() => expect(screen.getByLabelText('装运行环境')).toBeInTheDocument())
    expect(calls).toContain('POST http://x/update/runtime')
    expect(screen.getByText(/几十秒/)).toBeInTheDocument()
  })

  it('装失败:摆出为什么 + 原始输出 + 一颗「重试」,并且明说在用的那一份没被动过', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
      if (String(url).endsWith('/update/runtime')) {
        return reply({
          id: 'rt-2', step: 'runtime', state: 'failed', started_at: '2026-09-26T04:00:00.000Z',
          finished_at: '2026-09-26T04:01:00.000Z',
          tail: ['npm ERR! 假的'],
          error: '装 DSH 运行环境没成功:网断了。运行环境没换成,你这会儿在用的那一份没有被动过,工作台照常能用。',
        })
      }
      return reply({})
    }) as unknown as typeof fetch
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fetchImpl} jobPollMs={0} runtimeStale={staleView()} />)
    await userEvent.click(screen.getByRole('button', { name: '装运行环境' }))
    await waitFor(() => expect(screen.getByText(/没有被动过/)).toBeInTheDocument())
    expect(screen.getByLabelText('原始输出')).toHaveTextContent('npm ERR!')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('运行环境没问题时这一格整个不在(不留一个空框)', () => {
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({})} jobPollMs={0} currentVersion="0.4.0" />)
    expect(screen.queryByText(/DSH 运行环境/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '装运行环境' })).not.toBeInTheDocument()
  })
})

/**
 * 给别的机器装用的那份安装包(2026-09-26 卡 SM → **2026-09-28 卡 UP 改**)。
 *
 * 09-28 维护者在这一页点了那颗「下载安装包」当成更新:「大哥,你搞这几个按钮搞成这样,
 * 谁能理解啊?」于是那颗按钮与那条 dmg 直链都没了 —— 只剩最底下一句话和一个官网网址。
 */
describe('安装包那一行:只有一句话,指官网(2026-09-28,卡 UP)', () => {
  it('★最底下那一行在,写着去官网下,**没有任何 dmg 链接、没有第二颗按钮**', async () => {
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check: checkView({ current: '0.4.4' }) })} jobPollMs={0} currentVersion="0.4.4" />)
    await waitFor(() => expect(screen.getByText(/已经是最新的了/)).toBeInTheDocument())
    expect(screen.getByText(INSTALLER_HINT)).toBeInTheDocument()
    expect(screen.getByText(INSTALLER_HINT).textContent).toContain(OFFICIAL_SITE)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('.dmg')
    expect(screen.queryByText(/下载安装包/)).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('★有新版那一屏上也一样:一颗主按钮 + 底下那句官网小字,没有 dmg', async () => {
    const check = checkView({ available: true, latest: '0.4.5', notes: '修了几处' })
    render(<UpdatePanel baseUrl="http://x" fetchImpl={fakeFetch({ check })} jobPollMs={0} currentVersion="0.4.4" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /更新并重启/ })).toBeInTheDocument())
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText(INSTALLER_HINT)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('.dmg')
  })
})
