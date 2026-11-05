/**
 * 选题卡 = 指挥台,界面那一半(2026-09-22,卡 ②)。
 *
 * 钉的是设计第一节那张表在界面上的五件事:
 *
 * 1. **四态**:卡上写着她此刻在哪一态,当前那一态那几个产物页签排在前面并默认选中;
 * 2. **每态一颗「让事务官推进这一步」**,点了打 `POST /topic/run`(带 id 与选题名);
 * 3. **产物回卡**:页签里读得到正文,改完「存回文件」打 `POST /topic/doc/save`;
 * 4. **把关三键**:通过 / 改一改(要带一句话)/ 我自己改,各自打 `POST /topic/review`;
 * 5. **派活小标四档 + 代做**:排队 / 在做 / 回来了 / 失败。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TodoModule } from '../src/client/TodoModule.tsx'
import { topicRunBadge } from '../src/client/TopicDeckModel.ts'
import type { TaskView, TopicDocView, TopicReviewEntry, TopicStage } from '../src/protocol.ts'
import { TOPIC_DOC_TABS } from '../src/protocol.ts'
import { TOPIC_DOC_FILES } from '../src/server/topicRun.ts'

afterEach(cleanup)

const BASE = 'http://127.0.0.1:8791'
const NAME = '假选题:用例用的'

function topic(over: Partial<TaskView> = {}): TaskView {
  return { id: 't-1', title: NAME, status: 'todo', kind: 'topic', stage: '制作中', ...over } as TaskView
}

/** 七个页签的一份默认回答:只有「定稿」有东西。 */
function docs(over: Partial<Record<string, string>> = { 定稿: '甲\n\n乙' }): TopicDocView[] {
  return TOPIC_DOC_TABS.map((tab) => {
    const text = over[tab]
    return {
      tab,
      file: TOPIC_DOC_FILES[tab],
      exists: text !== undefined,
      ...(text === undefined ? {} : { text, updated_at: '2026-09-22T01:00:00.000Z' }),
    }
  })
}

function stub(opts: {
  docs?: TopicDocView[]
  reviews?: TopicReviewEntry[]
  run?: Record<string, unknown>
} = {}) {
  const calls: { url: string, body: Record<string, unknown> }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/topic/docs')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, docs: opts.docs ?? docs(), reviews: opts.reviews ?? [] }) }
    }
    if (url.endsWith('/topic/run')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sent: true, ...(opts.run ?? {}) }) }
    }
    if (url.endsWith('/topic/doc/save') || url.endsWith('/topic/review')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sent: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ topics: [] }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

const BOX = {
  id: 'todo',
  title: '选题池',
  basisPct: 50,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

async function open(task: TaskView, impl: typeof fetch): Promise<void> {
  render(
    <TodoModule
      box={BOX}
      header={<h2 id="h">选题池</h2>}
      headingId="h"
      baseUrl={BASE}
      fetchImpl={impl}
      tasks={[task]}
      lanes={[]}
    />,
  )
  await userEvent.click(screen.getByText(NAME))
  // 指挥台是读完 /topic/docs 才画出来的。
  await screen.findByRole('tab', { name: '定稿' })
}

describe('四态', () => {
  it('★ 卡还没展开就看得见她在哪一态(由段现算,盘上不存第二份)', async () => {
    const { impl } = stub()
    render(
      <TodoModule
        box={BOX} header={<h2 id="h">选题池</h2>} headingId="h"
        baseUrl={BASE} fetchImpl={impl} tasks={[topic()]} lanes={[]}
      />,
    )
    expect(await screen.findByTitle('第 4 段「制作中」')).toHaveTextContent('制作')
  })

  it('展开后四格都在,当前那一格按下去', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    const bar = screen.getByRole('group', { name: '工作状态' })
    expect(within(bar).getAllByRole('button').map(one => one.textContent)).toEqual(['构思', '制作', '发布', '复盘'])
    expect(within(bar).getByRole('button', { name: '制作' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('现在:制作 · 第 4/6 段「制作中」')).toBeInTheDocument()
  })

  it('★ 制作态默认选中「定稿」,而且定稿 / 素材清单 / 合规查词 排在最前面', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    const tabs = screen.getAllByRole('tab').map(one => one.textContent)
    expect(tabs.slice(0, 3)).toEqual(['定稿', '素材清单', '合规查词'])
    expect(screen.getByRole('tab', { name: '定稿' })).toHaveAttribute('aria-selected', 'true')
  })

  it('★ 七个页签一个都不藏 —— 收起的是"铺开与否",不是"看得见与否"', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    expect(screen.getAllByRole('tab')).toHaveLength(7)
    for (const tab of TOPIC_DOC_TABS) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument()
  })

  it('构思态铺开「随手记」,制作态把它收起来(收起 ≠ 删掉,summary 一直在)', async () => {
    const { impl } = stub()
    await open(topic({ stage: '灵感', desc: '路上想到的' }), impl)
    expect(screen.getByText('随手记').closest('details')).toHaveAttribute('open')
    cleanup()
    const again = stub()
    await open(topic({ stage: '制作中', desc: '路上想到的' }), again.impl)
    expect(screen.getByText('随手记').closest('details')).not.toHaveAttribute('open')
  })

  it('发布态铺开「日历」,复盘态铺开「数据与对标」', async () => {
    const { impl } = stub()
    await open(topic({ stage: '发布' }), impl)
    expect(screen.getByText('日历').closest('details')).toHaveAttribute('open')
  })
})

describe('「让事务官推进这一步」', () => {
  it('★ 每态一颗,点了打 POST /topic/run,带 id 与选题名', async () => {
    const { impl, calls } = stub()
    await open(topic(), impl)
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/topic/run'))).toBe(true))
    const call = calls.find(one => one.url.endsWith('/topic/run'))
    expect(call?.body).toMatchObject({ id: 't-1', name: NAME })
  })

  it('补的那一句跟着一起送过去', async () => {
    const { impl, calls } = stub()
    await open(topic(), impl)
    await userEvent.type(screen.getByLabelText('推进时补一句(可不填)'), '走情绪线')
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    await waitFor(() => expect(calls.find(one => one.url.endsWith('/topic/run'))?.body.note).toBe('走情绪线'))
  })

  it('★ 没送进去时如实上屏(不是一句"交出去了")', async () => {
    const { impl } = stub({ run: { sent: false, note: '这条会话在 DSH 里已经没了' } })
    await open(topic(), impl)
    await userEvent.click(screen.getByRole('button', { name: '让事务官推进这一步' }))
    expect(await screen.findByText(/这条会话在 DSH 里已经没了/)).toBeInTheDocument()
  })

  it('「推进一步」与「素材」那两颗一字没改,照旧在', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    expect(screen.getByRole('button', { name: '推进一步 → 发布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '素材' })).toBeInTheDocument()
  })
})

describe('产物回卡:能看能改', () => {
  it('页签里读得到正文,页签名旁边写着落在哪个文件上', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    expect(screen.getByLabelText('定稿 正文')).toHaveValue('甲\n\n乙')
    expect(screen.getByText(/定稿\.md/)).toBeInTheDocument()
  })

  it('★ 改完「存回文件」打 POST /topic/doc/save,正文原样送过去', async () => {
    const { impl, calls } = stub()
    await open(topic(), impl)
    const box = screen.getByLabelText('定稿 正文')
    await userEvent.clear(box)
    await userEvent.type(box, '改过的')
    await userEvent.click(screen.getByRole('button', { name: '存回文件' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/topic/doc/save'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/topic/doc/save'))?.body)
      .toMatchObject({ name: NAME, tab: '定稿', text: '改过的' })
  })

  it('没改动时那颗按钮是灰的,写着「没改动」—— 不画一颗点了没事发生的钮', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    expect(screen.getByRole('button', { name: '没改动' })).toBeDisabled()
  })

  it('★ 段落级 diff 摆在卡里:增的、删的、没动的各自标出来', async () => {
    const withDiff = docs().map(one => (one.tab === '定稿'
      ? { ...one, diff: [{ kind: 'same' as const, text: '甲' }, { kind: 'del' as const, text: '乙' }, { kind: 'add' as const, text: '丙' }] }
      : one))
    const { impl } = stub({ docs: withDiff })
    await open(topic(), impl)
    const block = screen.getByText('这一轮改了什么').closest('details')
    expect(within(block as HTMLElement).getByText('丙').closest('li')).toHaveAttribute('data-kind', 'add')
    expect(within(block as HTMLElement).getByText('乙').closest('li')).toHaveAttribute('data-kind', 'del')
  })

  it('还没有的那几份:页签画虚线边,正文框里写着可以自己先写', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    expect(screen.getByRole('tab', { name: '复盘' })).toHaveAttribute('data-has', 'false')
    await userEvent.click(screen.getByRole('tab', { name: '复盘' }))
    expect(screen.getByLabelText('复盘 正文')).toHaveAttribute('placeholder', expect.stringContaining('还没有'))
  })
})

describe('把关三键', () => {
  it('★ 三颗都在,措辞逐字是「通过 / 改一改 / 我自己改」', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    const group = screen.getByRole('group', { name: '把关' })
    expect(within(group).getAllByRole('button').map(one => one.textContent)).toEqual(['通过', '改一改', '我自己改'])
  })

  it('「通过」直接打 POST /topic/review', async () => {
    const { impl, calls } = stub()
    await open(topic(), impl)
    await userEvent.click(screen.getByRole('button', { name: '通过' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/topic/review'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/topic/review'))?.body)
      .toMatchObject({ id: 't-1', name: NAME, tab: '定稿', action: 'pass' })
  })

  it('★ 「改一改」先要那一句话,填完才送得出去', async () => {
    const { impl, calls } = stub()
    await open(topic(), impl)
    await userEvent.click(screen.getByRole('button', { name: '改一改' }))
    // 还没填字之前「打回去」是灰的,而且一个请求都没发。
    expect(screen.getByRole('button', { name: '打回去' })).toBeDisabled()
    expect(calls.some(one => one.url.endsWith('/topic/review'))).toBe(false)
    await userEvent.type(screen.getByLabelText('改哪儿'), '开头太软了')
    await userEvent.click(screen.getByRole('button', { name: '打回去' }))
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/topic/review'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/topic/review'))?.body)
      .toMatchObject({ action: 'revise', text: '开头太软了' })
  })

  it('★ 一份还不存在的产物上不画把关键(对着空气点「通过」没有意义)', async () => {
    const { impl } = stub()
    await open(topic(), impl)
    await userEvent.click(screen.getByRole('tab', { name: '复盘' }))
    expect(screen.queryByRole('group', { name: '把关' })).toBeNull()
  })

  it('她上次对这一份说过什么,摆在把关键底下', async () => {
    const { impl } = stub({
      reviews: [{ at: '2026-09-22T02:00:00.000Z', tab: '定稿', action: 'revise', text: '开头太软了' }],
    })
    await open(topic(), impl)
    expect(screen.getByText(/你上次对这一份:改一改——「开头太软了」/)).toBeInTheDocument()
  })
})

describe('派活小标四档 + 代做', () => {
  it('★ 交出去了、那头还没报进度 = 排队', () => {
    expect(topicRunBadge({ lastRunAt: '2026-09-22T03:00:00.000Z' })).toBe('排队')
    expect(topicRunBadge({
      lastRunAt: '2026-09-22T03:00:00.000Z',
      dispatch: { family: 'gpt', status: 'done', started_at: '2026-09-22T01:00:00.000Z' },
    })).toBe('排队')
  })

  it('那头报了进度之后按它的状态说:在做 / 回来了 / 失败', () => {
    const at = '2026-09-22T01:00:00.000Z'
    const run = '2026-09-22T00:00:00.000Z'
    expect(topicRunBadge({ lastRunAt: run, dispatch: { family: 'gpt', status: 'running', started_at: at } })).toBe('在做')
    expect(topicRunBadge({ lastRunAt: run, dispatch: { family: 'gpt', status: 'done', started_at: at } })).toBe('回来了')
    expect(topicRunBadge({ lastRunAt: run, dispatch: { family: 'gpt', status: 'failed', started_at: at } })).toBe('失败')
  })

  it('★ 一次都没派过、也没点过按钮 = 整段不画(不写「没派给谁」)', () => {
    expect(topicRunBadge({})).toBeUndefined()
  })

  it('窗口那只手也算数:送出去算「在做」,没送成算「失败」', () => {
    const one = { hand: 'window' as const, family: 'claude' as const, at: '2026-09-22T05:00:00.000Z', text: 'x' }
    expect(topicRunBadge({ clientDispatch: { ...one, status: 'sent' } })).toBe('在做')
    expect(topicRunBadge({ clientDispatch: { ...one, status: 'failed' } })).toBe('失败')
  })

  it('★ 代做:留痕里记着的那一次带 standin,卡上就挂一颗「代做」', async () => {
    const { impl } = stub({
      reviews: [{ at: '2026-09-22T03:00:00.000Z', tab: '定稿', action: 'run', standin: true }],
    })
    await open(topic(), impl)
    expect(screen.getByText('代做')).toBeInTheDocument()
    // 同一拍里那条 run 还没等到进度 → 小标是「排队」。
    expect(screen.getByText('排队')).toBeInTheDocument()
  })
})

describe('不是选题的那一批走老路', () => {
  it('★ 普通事项身上不画指挥台(七个永远空着的页签毫无意义)', async () => {
    const { impl } = stub()
    render(
      <TodoModule
        box={BOX} header={<h2 id="h">选题池</h2>} headingId="h"
        baseUrl={BASE} fetchImpl={impl} tasks={[{ id: 'x', title: '普通事项', status: 'todo' } as TaskView]} lanes={[]}
      />,
    )
    await userEvent.click(screen.getByText('普通事项'))
    expect(screen.getByText('这条不是选题,是一件普通事项。')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
  })
})

/** 六段各归哪一态在界面上也走一遍 —— 免得哪天分组改了,界面这边还照老的画。 */
describe('六段在界面上的归类', () => {
  const cases: [TopicStage, string][] = [
    ['灵感', '构思'], ['初稿', '制作'], ['准备素材', '制作'],
    ['制作中', '制作'], ['发布', '发布'], ['复盘', '复盘'],
  ]
  for (const [stage, phase] of cases) {
    it(`「${stage}」画成「${phase}」`, async () => {
      const { impl } = stub()
      await open(topic({ stage }), impl)
      expect(screen.getByRole('group', { name: '工作状态' })
        .querySelector('[aria-pressed="true"]')?.textContent).toBe(phase)
    })
  }
})
