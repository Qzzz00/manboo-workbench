/**
 * **运营同学(Air)那六个小组件原封接进源码之后的回归用例**。
 *
 * 原件:`workbench-plugin/contrib/air-20261002/`(她交来的《小组件持久维护包-20261002》,
 * 整包原样进 git);接进来的源码在 `src/client/air/*.js`,文件头写明机械替换了哪几处。
 *
 * ★ 2026-10-03 维护者拍板「原封不动」(原话见 docs/决策记录.md),所以这一份整份改过:
 * 10-02 那张卡是**按她的意图重做**,断言的是重做版的做法(`ben-wb__inboxfind` 那一列、
 * `ben-wb__pub-veil` 那张浮层、`NOTES_SAVE_FAILED` 那一句、选题池的段筛 class……)——
 * 那些做法连同那一版代码一起撤了,用例跟着删。
 *
 * 现在这一份分两段:
 *
 * 1. **六格各一条渲染用例**:用今天真实形状的 `/state` 夹具渲染,不炸、关键文案在
 *    (她那六份是从构建产物里摘出来的 JS,接线对不上的话第一个症状就是整格挂掉);
 * 2. **她那几条意图里最容易在下一次改动中丢掉的**,照她的代码断言:
 *
 * | 哪一格 | 钉的是 |
 * |---|---|
 * | 随手记 | 存失败时**草稿留着**,而且界面说出来(整条"失败静默"纪律唯一的例外) |
 * | 素材管理 | 点一下有回话;待整理文件默认 5 条 + 能搜;★ `<input>` 不带 children 那条回归 |
 * | 发布计划 | 点日期**开浮层**;存失败**留草稿 + 贴服务端原话**;存成了翻到那个月 |
 * | 选题池 | 搜 + 阶段筛 + 两个页签;服务端拒绝推进时把**原话**贴出来 |
 *
 * 数据复盘在 client-review-module.test.tsx、消耗数据在 client-usage-panel.test.tsx。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView, UsageState, XhsView } from '../src/protocol.ts'
import { TOPIC_PUBLISH_DAY_FIRST } from '../src/server/tasks.ts'
import { starterWidget } from './helpers/starterLayer.ts'

/**
 * 2026-10-23:服务端收件箱(InboxView)随 Wiki 页签整个删了,protocol 里不再有这个类型;
 * 起步层那份 files 小组件**原样保留**(验收拍板用户层不动),它内部还读 inbox?.items ——
 * 这一份局部类型照它读的形状写,让这一格的用例继续钉着她那几条意图(素材入口不丢)。
 */
interface WidgetInboxItem { path: string, name: string, kind: 'file' | 'dir', seen_at: string }
interface WidgetInboxView { items?: readonly WidgetInboxItem[], since?: string, backfilled?: boolean, error?: string }

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const NotesModule = starterWidget('notes')
const FilesModule = starterWidget('files')
const PublishModule = starterWidget('publish')
const ReviewModule = starterWidget('review')
const TodoModule = starterWidget('topics')
const UsagePanel = starterWidget('usage')

afterEach(cleanup)

const BOX = {
  id: 'one',
  title: '一格',
  basisPct: 30,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

/** 一个按调用序号决定成败的假 fetch。`fail` 为真的那几次回 500。 */
function fakeFetch(options: { fail?: boolean, body?: unknown } = {}) {
  const calls: { url: string, body: unknown }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (options.fail === true) {
      return { ok: false, json: async () => options.body ?? { error: '服务端说的那句原话' } } as unknown as Response
    }
    return { ok: true, json: async () => options.body ?? { ok: true } } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 2026-09-28 那天中午(**本地**时间,同 client-publish-today.test.tsx)。 */
const NOON_0928 = new Date(2026, 8, 28, 12, 0).toISOString()

function inboxOf(count: number): WidgetInboxView {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      path: `/Users/example/Downloads/素材${index + 1}.mp4`,
      name: `素材${index + 1}.mp4`,
      kind: 'file' as const,
      seen_at: '2026-10-02T01:00:00.000Z',
    })),
    since: '2026-10-01T00:00:00.000Z',
    backfilled: false,
  }
}

function topic(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1',
    title: '露营锅具怎么选',
    status: 'todo',
    kind: 'topic',
    stage: '灵感',
    source: { kind: 'manual' },
    created_at: '2026-10-03T02:00:00.000Z',
    updated_at: '2026-10-03T02:00:00.000Z',
    ...over,
  } as TaskView
}

/** 一件**普通事项**(不是选题)—— 她那一格把它摆在「其它事项」那个页签里。 */
function plainTask(id: string, title: string): TaskView {
  const one = topic({ id, title })
  delete (one as { kind?: unknown }).kind
  delete (one as { stage?: unknown }).stage
  return one
}

/** 随手记的草稿在上层(Workbench)手里,所以用例自己做一个壳把它拿住。 */
function NotesHarness({ fetchImpl }: { fetchImpl: typeof fetch }) {
  const [draft, setDraft] = useState('')
  return (
    <NotesModule
      box={BOX}
      header={<h3 id="n">随手记</h3>}
      headingId="n"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={fetchImpl}
      notes={[]}
      draft={draft}
      setDraft={setDraft}
    />
  )
}

function paintFiles(options: { fetchImpl: typeof fetch, inbox?: WidgetInboxView }) {
  return render(
    <FilesModule
      box={BOX}
      header={<h3 id="f">素材管理</h3>}
      headingId="f"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={options.fetchImpl}
      view="finder"
      pin={undefined}
      helper={undefined}
      bodyRef={{ current: null } as never}
      onSwitchView={() => {}}
      inbox={options.inbox}
      projects={[]}
      assetDirs={{ 脚本: '/Users/example/运营/脚本', 封面: '/Users/example/运营/封面' }}
      assetFiles={{ 收藏网址: '/Users/example/运营/收藏网址.md' }}
    />,
  )
}

function paintPublish(fetchImpl: typeof fetch, tasks: readonly TaskView[] = []) {
  return render(
    <PublishModule
      box={BOX}
      header={<h3 id="p">发布计划</h3>}
      headingId="p"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={fetchImpl}
      tasks={tasks}
      now={NOON_0928}
      projects={[{ id: 'p-1', name: '小红书·露营' }]}
    />,
  )
}

function paintTopics(fetchImpl: typeof fetch, tasks: readonly TaskView[]) {
  return render(
    <TodoModule
      box={BOX}
      header={<h3 id="t">选题池</h3>}
      headingId="t"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={fetchImpl}
      tasks={tasks}
      lanes={[]}
      projects={[{ id: 'p-1', name: '小红书·露营' }]}
    />,
  )
}

/** 她那一格按 `aria-label` 认日期格(`2026-09-30,…`),没有 `data-date`。 */
function pickDay(date: string): void {
  const found = [...document.querySelectorAll('.cp-day')]
    .find(node => (node.getAttribute('aria-label') ?? '').startsWith(date))
  if (found === undefined) throw new Error(`月历上没有 ${date} 这一格`)
  act(() => { (found as HTMLButtonElement).click() })
}

function typeInto(label: string, text: string): HTMLInputElement {
  const input = screen.getByLabelText(label) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

// ─────────────────── 一、六格各一条渲染用例 ───────────────────

describe('六格都渲染得出来(今天真实形状的 /state 夹具)', () => {
  it('随手记', () => {
    render(<NotesHarness fetchImpl={fakeFetch().impl} />)
    expect(screen.getByRole('heading', { name: '随手记' })).toBeInTheDocument()
    // 2026-10-22 照评审页:顶上「灵感随记」那一行撤了,条数挪到格头右端(本体给 headerWith 时)
    expect(screen.queryByText('灵感随记')).toBeNull()
    expect(screen.getByLabelText('记录灵感或当天安排')).toHaveAttribute('placeholder', '记下一个想法，或今天要做的事…')
    expect(screen.getByText('Enter 记下 · Shift + Enter 换行')).toBeInTheDocument()
    expect(screen.getByText('想法先留在这里')).toBeInTheDocument()
  })

  it('随手记:本体给了 headerWith,格头右端「N 条记录 ›」点开「全部随手记」(评审页 0cf75042)', () => {
    const notes = [{ id: 'a', text: '第一条', created_at: '2026-10-21T03:42:00Z' }, { id: 'b', text: '第二条', created_at: '2026-10-20T10:30:00Z' }]
    render(
      <NotesModule box={BOX} header={<h3 id="n">随手记</h3>} headerWith={(aside: unknown) => <div><h3 id="n">随手记</h3>{aside as never}</div>}
        headingId="n" baseUrl="http://127.0.0.1:8791" fetchImpl={fakeFetch().impl} notes={notes} draft="" setDraft={() => {}} />,
    )
    act(() => { screen.getByRole('button', { name: '2 条记录' }).click() })
    const dialog = screen.getByRole('dialog', { name: '全部随手记' })
    expect(dialog).toHaveTextContent('第一条')
    expect(dialog).toHaveTextContent('第二条')
  })

  it('素材管理', () => {
    paintFiles({ fetchImpl: fakeFetch().impl, inbox: inboxOf(2) })
    expect(screen.getByRole('heading', { name: '素材管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '素材入口' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '整理与图谱' })).toBeInTheDocument()
    expect(screen.getByLabelText('搜索待整理文件')).toHaveAttribute('placeholder', '搜索 2 项待整理文件')
  })

  it('发布计划', () => {
    paintPublish(fakeFetch().impl, [topic({ planned_at: '2026-09-30' })])
    expect(screen.getByRole('heading', { name: '发布计划' })).toBeInTheDocument()
    expect(screen.getByText('把下一条内容，排进日历')).toBeInTheDocument()
    expect(screen.getByText('2026 年 09 月')).toBeInTheDocument()
    expect(screen.getByLabelText('发布计划 月历 未发布')).toBeInTheDocument()
  })

  it('选题池', () => {
    paintTopics(fakeFetch().impl, [topic(), plainTask('t-9', '把发票贴了')])
    expect(screen.getByRole('heading', { name: '选题池' })).toBeInTheDocument()
    expect(screen.getByText('让灵感，成为下一条内容')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创作选题 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '其它事项 1' })).toBeInTheDocument()
  })

  it('数据复盘', () => {
    const xhs: XhsView = {
      login: { connected: true, nickname: '假昵称·用例用的' },
      accounts: [{
        profile: 'a',
        index: 0,
        name: '小食堂',
        connected: true,
        ranges: [{
          range: '近 7 日',
          date: '2026-10-02',
          at: '2026-10-02T02:00:00.000Z',
          metrics: [{ key: 'views', label: '观看数', kind: 'count', value: 1234, raw: '1234' }],
        }],
      }],
      ranges: [{
        range: '近 7 日',
        date: '2026-10-02',
        at: '2026-10-02T02:00:00.000Z',
        metrics: [{ key: 'views', label: '观看数', kind: 'count', value: 1234, raw: '1234' }],
      }],
      fetches: [{ at: '2026-10-02T02:00:00.000Z', ok: true, got: 6, total: 6, trigger: 'routine' }],
      last_ok_at: '2026-10-02T02:00:00.000Z',
    }
    render(
      <ReviewModule
        box={BOX}
        header={<h3 id="r">数据复盘</h3>}
        headingId="r"
        baseUrl="http://127.0.0.1:8791"
        fetchImpl={fakeFetch().impl}
        xhs={xhs}
      />,
    )
    expect(screen.getByRole('heading', { name: '数据复盘' })).toBeInTheDocument()
    expect(screen.getByText('已连接 1/1 个账号')).toBeInTheDocument()
    expect(screen.getByText('观看 · 账号对比')).toBeInTheDocument()
    expect(screen.getAllByText('1234').length).toBeGreaterThan(0)
  })

  it('消耗数据', () => {
    const usage: UsageState = {
      days: [{
        date: '2026-10-02',
        by_project: { 运营: { input: 1000, output: 200, cache_read: 50, cache_write: 10 } },
        by_model: { 'gpt-5-codex': { input: 1000, output: 200, cache_read: 50, cache_write: 10 } },
        by_source: { codex: { input: 1000, output: 200, cache_read: 50, cache_write: 10 } },
        sessions: 1,
        messages: 4,
        hour_counts: { 10: 4 },
      }],
      sources: { codex: { status: 'ok' }, dsh: { status: 'ok' } },
      scanned_at: '2026-10-02T06:00:00.000Z',
    }
    render(<UsagePanel usage={usage} now="2026-10-02T14:00:00+08:00" />)
    expect(screen.getByText('AI 创作投入 · 本机留存日志 · 北京时间')).toBeInTheDocument()
    expect(document.querySelector('.cu-hero strong')?.textContent).toBe('1.3K')
    // 2026-10-04:没有 token 来源的那几家不在这一格上了;顶上换成了「Codex 剩余额度」那张卡
    // (额度读不到就照实说「暂未读取」,一个数都不推算 —— 见 client-codex-quota-card-20261004)。
    expect(screen.queryByText('未接入用量')).toBeNull()
    expect(screen.getByLabelText('Codex 剩余额度')).toHaveTextContent('暂未读取')
  })
})

// ─────────────────── 二、她那几条意图 ───────────────────

describe('随手记:一个框装灵感与安排,存不上要说', () => {
  const type = (text: string): HTMLTextAreaElement => {
    const box = screen.getByLabelText('记录灵感或当天安排') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return box
  }
  const FAILED = '没有保存成功，内容已保留。可以再试一次。'

  it('存成了:POST /note/add,输入框清空,一句红字都没有', async () => {
    const { impl, calls } = fakeFetch()
    render(<NotesHarness fetchImpl={impl} />)
    const box = type('露营那条可以拍开箱')
    act(() => { (box.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/note/add'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/note/add'))?.body).toEqual({ text: '露营那条可以拍开箱' })
    await waitFor(() => expect(box).toHaveValue(''))
    expect(screen.queryByText(FAILED)).toBeNull()
  })

  it('★存不上:说一句**而且把文字留在框里**(这句话只存在于这个框里,清掉就找不回来了)', async () => {
    const { impl } = fakeFetch({ fail: true })
    render(<NotesHarness fetchImpl={impl} />)
    const box = type('今天下午去看场地')
    act(() => { (box.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())
    expect(box).toHaveValue('今天下午去看场地')
    expect(FAILED).toContain('内容已保留')
  })

  it('服务端回 200 但说了 `ok: false`,也算没存上', async () => {
    const { impl } = fakeFetch({ body: { ok: false } })
    render(<NotesHarness fetchImpl={impl} />)
    const box = type('一条')
    act(() => { (box.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(screen.getByText(FAILED)).toBeInTheDocument())
    expect(box).toHaveValue('一条')
  })
})

describe('素材管理:分类入口点完有回话,待整理文件能搜', () => {
  it('点一个素材文件夹:POST /files/reveal 带**那一条确切路径**,成了说定位到哪', async () => {
    const { impl, calls } = fakeFetch()
    paintFiles({ fetchImpl: impl })
    act(() => { screen.getByRole('button', { name: '定位脚本' }).click() })
    await waitFor(() => expect(screen.getByText('已在访达中定位「脚本」')).toBeInTheDocument())
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8791/files/reveal', body: { path: '/Users/example/运营/脚本' } }])
  })

  it('★定位没成:把**服务端那句原话**贴出来,界面不自己编一个原因', async () => {
    const { impl } = fakeFetch({ fail: true, body: { error: '这个路径不在已授权的项目目录之内' } })
    paintFiles({ fetchImpl: impl })
    act(() => { screen.getByRole('button', { name: '定位封面' }).click() })
    await waitFor(() => {
      expect(screen.getByText('定位未完成：这个路径不在已授权的项目目录之内')).toBeInTheDocument()
    })
  })

  // 2026-10-22 照评审页:列表整列可滚,不再先只列 5 条(全部也在格头「N 项 ›」那张弹层里)
  it('待整理文件整列都在,没有「查看全部」', () => {
    paintFiles({ fetchImpl: fakeFetch().impl, inbox: inboxOf(8) })
    expect(document.querySelectorAll('.cf-list .cf-file').length).toBe(8)
    expect(screen.queryByRole('button', { name: /查看全部/ })).toBeNull()
  })

  it('搜一下:只留名字对得上的;搜不到就如实说', () => {
    paintFiles({ fetchImpl: fakeFetch().impl, inbox: inboxOf(3) })
    const put = (text: string): void => { typeInto('搜索待整理文件', text) }
    put('素材2')
    expect(document.querySelectorAll('.cf-list .cf-file').length).toBe(1)
    put('不存在的名字')
    expect(screen.getByText('没有找到匹配项')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: '清除搜索' }).click() })
    expect(document.querySelectorAll('.cf-list .cf-file').length).toBe(3)
  })

  it('点一条待整理文件:定位的是**它自己那一条路径**(这一格没有一处能输路径进来)', async () => {
    const { impl, calls } = fakeFetch()
    paintFiles({ fetchImpl: impl, inbox: inboxOf(1) })
    act(() => { screen.getByRole('button', { name: '在访达中定位 素材1.mp4' }).click() })
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]?.body).toEqual({ path: '/Users/example/Downloads/素材1.mp4' })
    // 这一格发出去的路径,只能是它自己画出来的那几条之一。
    const painted = [
      '/Users/example/运营/脚本', '/Users/example/运营/封面', '/Users/example/运营/收藏网址.md',
      '/Users/example/Downloads/素材1.mp4',
    ]
    for (const call of calls) expect(painted).toContain((call.body as { path: string }).path)
  })

  /**
   * ★ 回归(她那一版真机上踩到过、她自己修掉的那一条):搜索框是个 `<input>`,
   * **不能带 children**。她那一格的 `h()` 辅助函数原来无条件写 `children: [...]`,
   * 空数组落到 `<input>` 上就是「void element 不能有子节点」—— React 直接抛,
   * 而且抛的是整棵树:**整个工作台挂不上**,不只是这一格坏掉。
   * 她的修法是 `...(children.length ? { children: … } : {})`(原件里就是这么写的),
   * 这一条钉的是**结果**:这一格里每个 input 都没有子节点,而且这一格渲染得出来。
   */
  it('★这一格里的 input 一个都不带子节点(她那边 children:[] 把整个工作台挂挂了)', () => {
    paintFiles({ fetchImpl: fakeFetch().impl, inbox: inboxOf(2) })
    const inputs = [...document.querySelectorAll('input')]
    expect(inputs.length).toBeGreaterThan(0)
    for (const input of inputs) expect(input.childNodes.length).toBe(0)
    // 整一格真的画出来了(抛了的话这一句就取不到东西)。
    expect(screen.getByRole('heading', { name: '素材管理' })).toBeInTheDocument()
  })
})

describe('发布计划:点日期开浮层,存不上留草稿', () => {
  it('★点一天开的是一张浮层(role=dialog + aria-modal),不是月历底下那一行', () => {
    paintPublish(fakeFetch().impl)
    expect(document.querySelector('.cp-panel')).toBeNull()
    pickDay('2026-09-30')
    const dialog = screen.getByRole('dialog', { name: '填写发布计划' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toContainElement(screen.getByLabelText('发布内容标题'))
    expect(dialog.textContent).toContain('2026-09-30')
  })

  it('取消 / Esc 都关得掉', () => {
    paintPublish(fakeFetch().impl)
    pickDay('2026-09-30')
    act(() => { screen.getByRole('button', { name: '取消' }).click() })
    expect(screen.queryByRole('dialog')).toBeNull()
    pickDay('2026-09-30')
    act(() => {
      // Esc 的监听挂在面板自己身上(2026-10-12 起没有全台遮罩了)。
      screen.getByRole('dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('存成了:带上**内容形式**,浮层自己关,月历翻到那一天所在的月份并说一句', async () => {
    const { impl, calls } = fakeFetch()
    paintPublish(impl)
    pickDay('2026-10-02')
    typeInto('发布内容标题', '拍开箱视频')
    const form = screen.getByLabelText('发布内容标题').closest('form') as HTMLFormElement
    act(() => { form.requestSubmit() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/task/create'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/task/create'))?.body).toMatchObject({
      title: '拍开箱视频', kind: 'topic', stage: '灵感', content_type: '视频', planned_at: '2026-10-02',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('已保存 2026-10-02 的发布计划「拍开箱视频」')).toBeInTheDocument()
    // 翻到了 10 月(月历标题那一行说的就是它)。
    expect(screen.getByText('2026 年 10 月')).toBeInTheDocument()
  })

  it('★存不上:浮层**不关**、草稿一个字不动,服务端那句原话贴在表里', async () => {
    const { impl } = fakeFetch({ fail: true, body: { error: 'tasks.json 写不进去' } })
    paintPublish(impl)
    pickDay('2026-09-30')
    typeInto('发布内容标题', '露营锅具怎么选')
    const form = screen.getByLabelText('发布内容标题').closest('form') as HTMLFormElement
    act(() => { form.requestSubmit() })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('tasks.json 写不进去'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('发布内容标题')).toHaveValue('露营锅具怎么选')
    // 没存上就**不说**"已保存" —— 那会是一句假话。
    expect(screen.queryByText(/已保存 2026-09-30 的发布计划/)).toBeNull()
  })

  it('那一天已经排了什么,排之前先列出来', () => {
    paintPublish(fakeFetch().impl, [topic({ planned_at: '2026-09-30', title: '已经排了那条' })])
    pickDay('2026-09-30')
    const dialog = screen.getByRole('dialog', { name: '填写发布计划' })
    expect(dialog.textContent).toContain('当天已有 1 条内容')
    expect(dialog.textContent).toContain('已经排了那条')
  })
})

describe('选题池:搜一条、只看一段、推进被拒要说', () => {
  const tasks = [
    topic(),
    topic({ id: 't-2', title: '帐篷怎么挑', stage: '制作中' }),
    // 非选题:它在「其它事项」那个页签里,与选题分开(她要的「选题与事项分开」)。
    plainTask('t-3', '把发票贴了'),
  ]

  it('搜标题:只留对得上的那几张;搜不到就如实说', () => {
    paintTopics(fakeFetch().impl, tasks)
    const put = (text: string): void => { typeInto('搜索选题或事项', text) }
    put('帐篷')
    expect(screen.getByText('帐篷怎么挑')).toBeInTheDocument()
    expect(screen.queryByText('露营锅具怎么选')).toBeNull()
    put('不存在')
    expect(screen.getByText('没有找到匹配内容')).toBeInTheDocument()
  })

  it('只看某一段:那一段的卡留下,别的此刻不画(一张卡都没丢,切回「全部」就都回来)', () => {
    paintTopics(fakeFetch().impl, tasks)
    act(() => { screen.getByRole('button', { name: '制作中 1' }).click() })
    expect(document.querySelectorAll('.ct-card').length).toBe(1)
    expect(screen.getByText('帐篷怎么挑')).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: '全部 2' }).click() })
    expect(document.querySelectorAll('.ct-card').length).toBe(2)
  })

  it('「其它事项」是另一个页签 —— 选题与非选题各看一边', () => {
    paintTopics(fakeFetch().impl, tasks)
    act(() => { screen.getByRole('button', { name: '其它事项 1' }).click() })
    expect(screen.getByText('把发票贴了')).toBeInTheDocument()
    expect(screen.queryByText('露营锅具怎么选')).toBeNull()
  })

  it('★服务端拒绝推进(实际发布日还空着):把**它那句原话**贴出来,不静默', async () => {
    // HTTP 层把 advanceTopic 的 reason 转成 409 + `{ error: reason }`(server/http.ts),
    // 她那一格读的就是 `error` —— 两头对得上,这一条同时钉着这条接缝。
    const { impl, calls } = fakeFetch({ fail: true, body: { ok: false, error: TOPIC_PUBLISH_DAY_FIRST } })
    paintTopics(impl, [topic({ stage: '发布', published_at: '2026-10-01' })])
    act(() => { screen.getByRole('button', { name: '推进到复盘' }).click() })
    await waitFor(() => expect(screen.getByText(`未完成：${TOPIC_PUBLISH_DAY_FIRST}`)).toBeInTheDocument())
    expect(calls.some(one => one.url.endsWith('/task/advance'))).toBe(true)
  })

  it('推进成了:说推进到哪一段', async () => {
    const { impl } = fakeFetch({ body: { ok: true, stage: '初稿' } })
    paintTopics(impl, [topic()])
    act(() => { screen.getByRole('button', { name: '推进到初稿' }).click() })
    await waitFor(() => expect(screen.getByText('「露营锅具怎么选」已推进到初稿')).toBeInTheDocument())
  })

  it('到了「发布」而实际发布日还空着:卡上那一颗是「确认已发布」,填完才记', async () => {
    const { impl, calls } = fakeFetch()
    paintTopics(impl, [topic({ stage: '发布' })])
    act(() => { screen.getByRole('button', { name: '确认已发布' }).click() })
    const dialog = await screen.findByRole('dialog', { name: '确认内容已发布' })
    expect(dialog.textContent).toContain('这里只记录发布结果，不会替你发布到平台。')
    const input = screen.getByLabelText('确认实际发布日') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '2026-10-03')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/task/update'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/task/update'))?.body)
      .toEqual({ id: 't-1', published_at: '2026-10-03' })
  })

  it('「安排发布日」留空 = 清掉排期(传 null,不是写一个空字符串上去)', async () => {
    const { impl, calls } = fakeFetch()
    paintTopics(impl, [topic({ planned_at: '2026-10-05' })])
    act(() => { screen.getByRole('button', { name: '安排发布日' }).click() })
    const dialog = await screen.findByRole('dialog', { name: '安排发布日' })
    const input = dialog.querySelector('input[type="date"]') as HTMLInputElement
    expect(input.value).toBe('2026-10-05')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/task/update'))).toBe(true))
    expect(calls.find(one => one.url.endsWith('/task/update'))?.body).toEqual({ id: 't-1', planned_at: null })
  })
})
