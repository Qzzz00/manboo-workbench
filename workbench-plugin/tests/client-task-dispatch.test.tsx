import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDispatch, TaskView } from '../src/protocol.ts'
import { TaskCard } from '../src/client/TaskCard.tsx'

afterEach(cleanup)

const AT = '2026-09-21T09:00:00.000Z'

function task(dispatch?: TaskDispatch): TaskView {
  return {
    id: 'a', title: '加一个 README', status: 'doing', source: { kind: 'manual' },
    created_at: AT, updated_at: AT, ...(dispatch === undefined ? {} : { dispatch }),
  }
}

function card(dispatch?: TaskDispatch, onStopDispatch?: () => void) {
  render(
    <TaskCard
      task={task(dispatch)}
      sessions={[]}
      sessionUsage={{}}
      nowMs={Date.parse(AT)}
      onOpen={() => {}}
      onStopDispatch={onStopDispatch}
      onDragStart={() => {}}
      onDragEnd={() => {}}
    />,
  )
}

const RUNNING: TaskDispatch = { family: 'codex', status: 'running', cwd: '/tmp/repo', pid: 4321, started_at: AT }

describe('卡面上的派活小标', () => {
  it('进行中 → 「派给 Codex · 进行中」', () => {
    card(RUNNING)
    expect(screen.getByText(/派给 Codex · 进行中/)).toBeInTheDocument()
  })

  it('完成、失败各自一档(样式靠 data-state,一屏扫过去要跳得出来)', () => {
    cleanup()
    card({ family: 'claude', status: 'done', cwd: '/tmp/repo', started_at: AT, ended_at: AT })
    const done = screen.getByText(/派给 Claude · 完成/)
    expect(done).toHaveAttribute('data-state', 'done')
    cleanup()
    card({ family: 'kimi', status: 'failed', cwd: '/tmp/repo', started_at: AT, note: '退出码 1' })
    const failed = screen.getByText(/派给 Kimi · 失败/)
    expect(failed).toHaveAttribute('data-state', 'failed')
    // 原因原话挂在 title 上 —— 卡面不铺开,但鼠标停一下要看得到。
    expect(failed).toHaveAttribute('title', expect.stringContaining('退出码 1'))
  })

  it('没派过的卡 → **整段不显示**,不写「没派给谁」', () => {
    card()
    expect(screen.queryByText(/派给/)).not.toBeInTheDocument()
  })

  it('工作目录挂在 title 上(「在哪个仓库改的」是验收第一问)', () => {
    card(RUNNING)
    expect(screen.getByText(/派给 Codex · 进行中/)).toHaveAttribute('title', expect.stringContaining('/tmp/repo'))
  })

  it('哪只手也在 title 上;没写手的老记录按「在后台做」读(卡 O 09-25:界面上不出现「命令行」)', () => {
    card(RUNNING)
    expect(screen.getByText(/派给 Codex · 进行中/)).toHaveAttribute('title', expect.stringContaining('在后台做'))
    expect(screen.getByText(/派给 Codex · 进行中/).getAttribute('title')).not.toContain('命令行')
    cleanup()
    card({ ...RUNNING, hand: 'window' })
    expect(screen.getByText(/派给 Codex · 进行中/)).toHaveAttribute('title', expect.stringContaining('送进它的窗口里做'))
  })
})

/**
 * 接口那只手(2026-09-22)。小标上**只有这一只手把手写出来** —— 理由在
 * `boardModel.agentDispatchBadgeText` 的注释里:它花的是他今天的模型额度,
 * 而另外两只花的是他的订阅;同一张卡上扣没扣额度,是他看一眼就该知道的事。
 */
describe('接口那只手的小标', () => {
  const API_DONE: TaskDispatch = { family: 'gpt', status: 'done', hand: 'api', started_at: AT, ended_at: AT, note: '给你三个标题' }

  it('★ 「派给 GPT(接口)· 完成」', () => {
    card(API_DONE)
    expect(screen.getByText('派给 GPT(接口) · 完成')).toBeInTheDocument()
  })

  it('豆包同一套', () => {
    card({ ...API_DONE, family: 'doubao', status: 'failed', note: '服务器没配豆包' })
    expect(screen.getByText('派给 豆包办公(接口) · 失败')).toBeInTheDocument()
  })

  it('★ 另外两只手的小标一个字没变(老记录照旧)', () => {
    card(RUNNING)
    expect(screen.getByText('派给 Codex · 进行中')).toBeInTheDocument()
  })

  it('★ 没有工作目录时 title 里明说「这只手不碰文件」,不写「在 undefined 里跑」', () => {
    card(API_DONE)
    const badge = screen.getByText('派给 GPT(接口) · 完成')
    expect(badge).toHaveAttribute('title', expect.stringContaining('不碰文件'))
    expect(badge.getAttribute('title')).not.toContain('undefined')
    expect(badge).toHaveAttribute('title', expect.stringContaining('给你三个标题'))
  })

  it('★ 接口那只手不画「停掉」按钮 —— 没有子进程可杀', () => {
    card(API_DONE, () => {})
    expect(screen.queryByRole('button', { name: '停掉' })).not.toBeInTheDocument()
  })
})

describe('「停掉」按钮', () => {
  it('还在跑 + 有 pid + 接了线 → 画出来,点了把事项 id 交上去', async () => {
    const onStop = vi.fn()
    card(RUNNING, onStop)
    await userEvent.click(screen.getByRole('button', { name: /停掉/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('没报 pid → **不画**(不画一颗停不掉的按钮)', () => {
    card({ family: 'codex', status: 'running', cwd: '/tmp/repo', started_at: AT }, vi.fn())
    expect(screen.queryByRole('button', { name: /停掉/ })).not.toBeInTheDocument()
  })

  it('已经完成的那次 → 不画(没有东西可停)', () => {
    card({ family: 'codex', status: 'done', cwd: '/tmp/repo', pid: 4321, started_at: AT, ended_at: AT }, vi.fn())
    expect(screen.queryByRole('button', { name: /停掉/ })).not.toBeInTheDocument()
  })

  it('这一层没接线 → 不画(点了没反应的按钮比没有更坏)', () => {
    card(RUNNING)
    expect(screen.queryByRole('button', { name: /停掉/ })).not.toBeInTheDocument()
  })
})

it('运行回执与选人依据直接可见,不拿名片填实际值', () => {
  card({ ...RUNNING, selection: { evaluated_at: AT, family: 'codex', reason: 'Claude 只剩9%，这次用 Codex', candidates: [] }, runtime: { attempt_id: 'a', mode: 'new', started_at: AT, requested: { model: 'requested', effort: 'high' }, observed: { model: 'actual', effort: 'low' }, status: 'mismatch', source: 'native_context' } })
  expect(screen.getByText(/运行档位与请求不符/)).toHaveTextContent('actual')
  expect(screen.getByText(/Claude 只剩9%/)).toBeInTheDocument()
})

it('新一轮后台派活不展示旧窗口回执', () => {
  render(<TaskCard task={{ ...task({ ...RUNNING, runtime: { attempt_id: 'new', mode: 'new', started_at: '2026-10-26T00:00:00Z', requested: {}, observed: {}, status: 'unverified' } }), client_dispatch: { hand: 'window', family: 'codex', status: 'sent', at: AT, text: '旧交代', runtime: { attempt_id: 'old', mode: 'new', started_at: AT, requested: {}, observed: { model: 'old-model', effort: 'high' }, status: 'verified', source: 'native_context' } } }} sessions={[]} sessionUsage={{}} nowMs={Date.parse(AT)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
  expect(screen.queryByText(/old-model/)).not.toBeInTheDocument()
  expect(screen.getByText('运行模型与思考档未核实')).toBeInTheDocument()
})
