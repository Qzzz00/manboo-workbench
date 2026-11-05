/**
 * 需求卡 = 指挥台,界面那一半(2026-09-22,审视第四节第三幕)。
 *
 * 钉的是四件事:
 *
 * 1. **四态**:卡上写着她此刻在哪一态,当前那一态那个产物页签排在前面并默认选中;
 * 2. **每态一颗「让事务官推进这一步」**,点了打 `POST /feature/run`(带卡 id);
 * 3. **产物回卡**:页签里读得到正文,改完「存回文件」打 `POST /feature/doc/save`;
 * 4. **把关三键 + 「写进决策记录」**:后者**只在「记录」那一态出现**。
 *
 * 还有一条反面的:**普通事项与没接线时整块不画** —— 既有那一批卡一字不变。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeatureDeck } from '../src/client/FeatureDeck.tsx'
import { TaskDialog } from '../src/client/TaskDialog.tsx'
import {
  defaultFeatureTab, featureStageView, orderedFeatureTabs,
} from '../src/client/FeatureDeckModel.ts'
import { deckRunBadge } from '../src/client/DeckModel.ts'
import type { FeatureDocView, FeatureReviewEntry, FeatureStage, TaskView } from '../src/protocol.ts'
import { FEATURE_DOC_TABS } from '../src/protocol.ts'
import { FEATURE_DOC_FILES } from '../src/server/featureRun.ts'

afterEach(cleanup)

const BASE = 'http://127.0.0.1:8791'
const NEED = '加一个导出 PDF'

function feature(over: Partial<TaskView> = {}): TaskView {
  return { id: 'f-1', title: NEED, status: 'todo', kind: 'feature', ...over } as TaskView
}

/** 四个页签的一份默认回答:只有「需求」有东西。 */
function docs(over: Partial<Record<string, string>> = { 需求: '目标\n\n边界' }): FeatureDocView[] {
  return FEATURE_DOC_TABS.map((tab) => {
    const text = over[tab]
    return {
      tab,
      file: FEATURE_DOC_FILES[tab],
      exists: text !== undefined,
      ...(text === undefined ? {} : { text, updated_at: '2026-09-22T01:00:00.000Z' }),
    }
  })
}

function stub(opts: {
  docs?: FeatureDocView[]
  reviews?: FeatureReviewEntry[]
  run?: Record<string, unknown>
  record?: Record<string, unknown>
} = {}) {
  const calls: { url: string, body: Record<string, unknown> }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/feature/docs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true, dir: '/repo/docs/需求/' + NEED, project: '工作台', project_path: '/repo',
          docs: opts.docs ?? docs(), reviews: opts.reviews ?? [],
        }),
      }
    }
    if (url.endsWith('/feature/run')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sent: true, ...(opts.run ?? {}) }) }
    }
    if (url.endsWith('/feature/record')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, added: true, path: '/repo/docs/决策记录.md', ...(opts.record ?? {}) }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: true }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function open(
  task: TaskView, impl: typeof fetch, onStageChange: (stage: FeatureStage) => void = () => {},
): Promise<void> {
  render(<FeatureDeck task={task} baseUrl={BASE} fetchImpl={impl} onStageChange={onStageChange} />)
  await waitFor(() => expect(screen.getByRole('tablist', { name: '产物' })).toBeInTheDocument())
}

describe('纯算那一半', () => {
  it('第几态照实说(四态是粗刻度,但不能糊)', () => {
    expect(featureStageView('验收')).toEqual({ stage: '验收', index: 3, total: 4 })
  })

  it('★ 页签**一个都不藏**,只是这一态那个排在最前面并默认选中', () => {
    for (const stage of ['梳理', '拆解与派活', '验收', '记录'] as FeatureStage[]) {
      const tabs = orderedFeatureTabs(stage)
      expect([...tabs].sort()).toEqual([...FEATURE_DOC_TABS].sort())
      expect(defaultFeatureTab(stage)).toBe(tabs[0])
    }
    expect(defaultFeatureTab('验收')).toBe('验收')
  })

  it('派活小标与选题那边**同一个算法**:点完按钮那头还没报进度 = 排队', () => {
    expect(deckRunBadge({ lastRunAt: '2026-09-22T03:00:00.000Z' })).toBe('排队')
    expect(deckRunBadge({
      dispatch: { family: 'codex', status: 'done', started_at: '2026-09-22T04:00:00.000Z' } as never,
      lastRunAt: '2026-09-22T03:00:00.000Z',
    })).toBe('回来了')
    // 一条都没有 → 整段不画。
    expect(deckRunBadge({})).toBeUndefined()
  })
})

describe('四态与产物页签', () => {
  it('四格都在,当前那格高亮;底下写着第几态', async () => {
    const { impl } = stub()
    await open(feature({ feature_stage: '验收' }), impl)
    const group = screen.getByRole('group', { name: '需求进度' })
    for (const one of ['梳理', '拆解与派活', '验收', '记录']) {
      expect(within(group).getByRole('button', { name: one })).toBeInTheDocument()
    }
    expect(within(group).getByRole('button', { name: '验收' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/第 3\/4 态「验收」/)).toBeInTheDocument()
  })

  it('★ 点别的一格**不改进度**(不打任何写路由),只是把那一份翻到前面', async () => {
    const { impl, calls } = stub()
    const changed: FeatureStage[] = []
    await open(feature({ feature_stage: '梳理' }), impl, stage => changed.push(stage))
    const before = calls.length
    await userEvent.click(screen.getByRole('group', { name: '需求进度' }).querySelector('button:last-child') as HTMLElement)
    expect(calls).toHaveLength(before)
    expect(changed).toHaveLength(0)
  })

  it('四个页签都在;已经有东西的那几个带 data-has', async () => {
    const { impl } = stub()
    await open(feature(), impl)
    const tabs = screen.getByRole('tablist', { name: '产物' })
    for (const one of FEATURE_DOC_TABS) {
      expect(within(tabs).getByRole('tab', { name: one })).toBeInTheDocument()
    }
    expect(within(tabs).getByRole('tab', { name: '需求' })).toHaveAttribute('data-has', 'true')
    expect(within(tabs).getByRole('tab', { name: '子事项' })).toHaveAttribute('data-has', 'false')
  })

  it('项目与仓库路径摆在卡上 —— 她要知道这条需求动的是哪个仓库', async () => {
    const { impl } = stub()
    await open(feature(), impl)
    expect(screen.getByText('项目:工作台 · /repo')).toBeInTheDocument()
    expect(screen.getByText(`产物都落在 /repo/docs/需求/${NEED}`)).toBeInTheDocument()
  })
})

describe('让事务官推进这一步', () => {
  it('★ 点了打 `/feature/run`,带卡 id;补的那一句一起带上', async () => {
    const { impl, calls } = stub()
    await open(feature(), impl)
    await userEvent.type(screen.getByLabelText('推进时补一句(可不填)'), '先只做单页')
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/run'))).toBe(true))
    const run = calls.find(one => one.url.endsWith('/feature/run')) as { body: Record<string, unknown> }
    expect(run.body).toEqual({ id: 'f-1', note: '先只做单页' })
  })

  it('★ 没送进去要**如实说**,不是一颗点了像是成了的按钮', async () => {
    const { impl } = stub({ run: { sent: false, note: '这条需求底下还没有事务官的会话,话说不进去' } })
    await open(feature(), impl)
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('没送进去'))
  })

  it('代做时说清是它自己顶着做的', async () => {
    const { impl } = stub({ run: { sent: true, standin: true } })
    await open(feature({ feature_stage: '拆解与派活' }), impl)
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('它自己顶着做'))
  })

  it('「推进一步」交给外面那一层改卡;**最后一态置灰**', async () => {
    const { impl } = stub()
    const changed: FeatureStage[] = []
    await open(feature({ feature_stage: '验收' }), impl, stage => changed.push(stage))
    await userEvent.click(screen.getByRole('button', { name: '推进一步 → 记录' }))
    expect(changed).toEqual(['记录'])

    cleanup()
    const again = stub()
    await open(feature({ feature_stage: '记录' }), again.impl)
    expect(screen.getByRole('button', { name: '已到记录' })).toBeDisabled()
  })
})

describe('产物回卡与把关', () => {
  it('★ 改完「存回文件」打 `/feature/doc/save`;没改动时那颗按钮是灰的', async () => {
    const { impl, calls } = stub()
    await open(feature(), impl)
    expect(screen.getByRole('button', { name: '没改动' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('需求 正文'), '丙')
    await userEvent.click(screen.getByRole('button', { name: '存回文件' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/doc/save'))).toBe(true))
    const save = calls.find(one => one.url.endsWith('/feature/doc/save')) as { body: Record<string, unknown> }
    expect(save.body.id).toBe('f-1')
    expect(save.body.tab).toBe('需求')
    expect(String(save.body.text)).toContain('丙')
  })

  it('★ 三键只在这一份真有东西时才画', async () => {
    const { impl } = stub({ docs: docs({}) })
    await open(feature(), impl)
    expect(screen.queryByRole('group', { name: '把关' })).not.toBeInTheDocument()
  })

  it('「通过」打 `/feature/review`', async () => {
    const { impl, calls } = stub()
    await open(feature(), impl)
    await userEvent.click(screen.getByRole('button', { name: '通过' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/review'))).toBe(true))
    const judged = calls.find(one => one.url.endsWith('/feature/review')) as { body: Record<string, unknown> }
    expect(judged.body).toEqual({ id: 'f-1', tab: '需求', action: 'pass' })
  })

  it('★「打回」先要那一句话:**不填不发**', async () => {
    const { impl, calls } = stub()
    await open(feature(), impl)
    await userEvent.click(screen.getByRole('button', { name: '打回' }))
    expect(calls.some(one => one.url.endsWith('/feature/review'))).toBe(false)
    expect(screen.getByRole('button', { name: '打回去' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('改哪儿'), '边界没写')
    await userEvent.click(screen.getByRole('button', { name: '打回去' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/review'))).toBe(true))
    const judged = calls.find(one => one.url.endsWith('/feature/review')) as { body: Record<string, unknown> }
    expect(judged.body.action).toBe('revise')
    expect(judged.body.text).toBe('边界没写')
  })

  it('她上次对这一份说过什么,卡上写着', async () => {
    const { impl } = stub({
      reviews: [{ at: '2026-09-22T02:00:00.000Z', tab: '需求', action: 'revise', text: '边界没写' }],
    })
    await open(feature(), impl)
    expect(screen.getByText(/你上次对这一份:改一改——「边界没写」/)).toBeInTheDocument()
  })
})

describe('写进决策记录', () => {
  it('★ 只在「记录」那一态出现 —— 别的态点它没有意义', async () => {
    const { impl } = stub()
    await open(feature({ feature_stage: '验收' }), impl)
    expect(screen.queryByRole('button', { name: '写进决策记录' })).not.toBeInTheDocument()
  })

  it('★ 点了打 `/feature/record`,并把落到哪个文件原样说出来', async () => {
    const { impl, calls } = stub()
    await open(feature({ feature_stage: '记录' }), impl)
    await userEvent.click(screen.getByRole('button', { name: '写进决策记录' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/record'))).toBe(true))
    expect(screen.getByRole('status')).toHaveTextContent('/repo/docs/决策记录.md')
  })

  it('已经写过的那一条不重复写,如实说一句', async () => {
    const { impl } = stub({ record: { added: false } })
    await open(feature({ feature_stage: '记录' }), impl)
    await userEvent.click(screen.getByRole('button', { name: '写进决策记录' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已经在里面了'))
  })
})

describe('普通事项一字不变', () => {
  const DIALOG = {
    moduleName: '未归模块',
    sessions: [],
    sessionUsage: {},
    branches: [],
    filePathHints: [],
    onClose: () => {},
    onMove: () => {},
    onUpdate: () => {},
    onDelete: () => {},
  }

  it('★ 普通事项的弹窗里**没有指挥台**', async () => {
    const { impl } = stub()
    render(<TaskDialog task={{ id: 'x', title: '随手一条', status: 'todo', source: { kind: 'manual' }, created_at: '', updated_at: '' } as TaskView} {...DIALOG} deckBaseUrl={BASE} deckFetch={impl} />)
    expect(screen.queryByRole('group', { name: '需求进度' })).not.toBeInTheDocument()
  })

  it('★ 需求卡但**没接线**时也不画 —— 一颗点了没反应的按钮比没有按钮更坏', () => {
    render(<TaskDialog task={feature({ source: { kind: 'manual' }, created_at: '', updated_at: '' } as never)} {...DIALOG} />)
    expect(screen.queryByRole('group', { name: '需求进度' })).not.toBeInTheDocument()
  })

  it('接上线的需求卡:弹窗里长出指挥台', async () => {
    const { impl } = stub()
    render(<TaskDialog task={feature({ source: { kind: 'manual' }, created_at: '', updated_at: '' } as never)} {...DIALOG} deckBaseUrl={BASE} deckFetch={impl} />)
    await waitFor(() => expect(screen.getByRole('group', { name: '需求进度' })).toBeInTheDocument())
  })
})

/**
 * 断点 B 与 C 在界面上那一半(2026-09-23)。
 *
 * 1. 派出去那几件的结果在「验收」那一态铺开,一件一行,点标题看全文;
 * 2. 「改工作台自己」那两颗按钮**只在判据成立时画**;判据不成立时画一句实话,
 *    **不画一颗灰按钮** —— 她要知道"为什么这张卡上没有那条闭环";
 * 3. 停在某一步时把八步铺出来,失败那一步把**原话**摊在底下。
 */
describe('结果回卡与「改自己」', () => {
  /** 在上面那个 stub 外面再套一层:多回 results / self / ship。 */
  function stub2(opts: {
    results?: { item: string, file: string, ok: boolean, summary: string, text: string }[]
    self?: boolean
    selfWhy?: string
    ship?: Record<string, unknown>
  } = {}) {
    const calls: { url: string, body: Record<string, unknown> }[] = []
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, body })
      if (url.endsWith('/feature/docs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true, dir: `/repo/docs/需求/${NEED}`, project: '工作台', project_path: '/repo',
            docs: docs(), reviews: [],
            results: opts.results ?? [],
            self: opts.self ?? false,
            self_why: opts.selfWhy ?? '这个项目里没有 deploy/publish-update.sh,它不是工作台自己的仓库',
          }),
        }
      }
      if (url.endsWith('/feature/ship')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, version: '0.2.65', ...(opts.ship ?? {}) }) }
      }
      if (url.endsWith('/feature/branch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, created: true, branch: 'feat/导出PDF', worktree: '/repo/.claude/worktrees/导出PDF' }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, sent: true }) }
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  const RESULT = {
    item: '改样式',
    file: '结果-改样式.md',
    ok: false,
    summary: '- 改样式:没成(退出码 1,有改动)',
    text: '# 结果:改样式\n\n- 成没成:**没成**(退出码 1)\n\n## 截图\n\n没截 —— 这台机器上没有现成的截屏能力',
  }

  it('「验收」那一态铺开那几件的结果,点标题看全文', async () => {
    const { impl } = stub2({ results: [RESULT] })
    await open(feature({ feature_stage: '验收' }), impl)
    await waitFor(() => expect(screen.getByText('- 改样式:没成(退出码 1,有改动)')).toBeInTheDocument())
    // 全文默认收着(她在手机上先看的是那一行摘要)。
    expect(screen.queryByText(/没截/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('- 改样式:没成(退出码 1,有改动)'))
    expect(screen.getByText(/没截/)).toBeInTheDocument()
  })

  it('一件结果都没有时整块不画(不画一个空壳)', async () => {
    const { impl } = stub2({ results: [] })
    await open(feature({ feature_stage: '验收' }), impl)
    expect(screen.queryByText(/派出去那几件的结果/)).not.toBeInTheDocument()
  })

  it('★ 不是工作台自己时**没有那颗按钮**,而是一句实话', async () => {
    const { impl } = stub2({ self: false })
    await open(feature({ feature_stage: '验收' }), impl)
    await waitFor(() => expect(screen.getByText(/改的不是工作台自己/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '通过,合并并发版' })).not.toBeInTheDocument()
  })

  it('是工作台自己时:「拆解与派活」那一态有「先开分支再派活」', async () => {
    const { impl, calls } = stub2({ self: true })
    await open(feature({ feature_stage: '拆解与派活' }), impl)
    await userEvent.click(await screen.findByRole('button', { name: '先开分支再派活' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/branch'))).toBe(true))
    expect(await screen.findByText(/开好了:feat\/导出PDF/)).toBeInTheDocument()
  })

  it('是工作台自己时:「验收」那一态那颗按钮走 /feature/ship,成了就推到「记录」', async () => {
    const { impl, calls } = stub2({ self: true })
    const stages: FeatureStage[] = []
    await open(feature({ feature_stage: '验收' }), impl, stage => stages.push(stage))
    await userEvent.click(await screen.findByRole('button', { name: '通过,合并并发版' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/feature/ship'))).toBe(true))
    expect(await screen.findByText(/发出去了:0\.2\.65/)).toBeInTheDocument()
    expect(stages).toEqual(['记录'])
  })

  it('停在某一步时把**原话**摊出来,不含糊成一句「失败了」', async () => {
    const { impl } = stub2({
      self: true,
      ship: {
        ok: false,
        stopped_at: 'merge',
        note: 'feat/x 快进不到 main(main 上有它没有的提交)',
        steps: [
          { id: 'guard', title: '过一遍不许改的东西', status: 'ok' },
          { id: 'merge', title: '合并到 main(只许快进)', status: 'failed' },
        ],
      },
    })
    await open(feature({ feature_stage: '验收' }), impl)
    await userEvent.click(await screen.findByRole('button', { name: '通过,合并并发版' }))
    expect(await screen.findByText(/停在「合并到 main\(只许快进\)」/)).toBeInTheDocument()
    expect(screen.getByText(/快进不到 main/)).toBeInTheDocument()
  })

  it('卡上存着的那八步照样画(刷新回来也看得见停在哪)', async () => {
    const { impl } = stub2({ self: true })
    await open(feature({
      feature_stage: '验收',
      self_ship: {
        branch: 'feat/x',
        status: 'failed',
        stopped_at: 'test',
        note: 'FAIL tests/clock.test.ts',
        started_at: '2026-09-23T10:00:00.000Z',
        steps: [
          { id: 'guard', title: '过一遍不许改的东西', status: 'ok' },
          { id: 'test', title: '全量测试', status: 'failed', note: 'FAIL tests/clock.test.ts' },
          { id: 'merge', title: '合并到 main(只许快进)', status: 'pending' },
        ],
      },
    } as never), impl)
    expect(await screen.findByText('过一遍不许改的东西:过了')).toBeInTheDocument()
    expect(screen.getByText('全量测试:停在这儿')).toBeInTheDocument()
    expect(screen.getByText('合并到 main(只许快进):还没走到')).toBeInTheDocument()
    expect(screen.getByText('FAIL tests/clock.test.ts')).toBeInTheDocument()
  })
})
