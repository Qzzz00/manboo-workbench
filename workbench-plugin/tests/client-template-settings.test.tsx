/**
 * 设置里的「模板」那一节(2026-09-21 布局模板)。
 *
 * 钉四件:
 *   ① 两张卡片(名字 + 一句话 + 当前标记),当前那张的按钮是灰的;
 *   ② 点「切换」**先二次确认**,确认文案里必须有「会重排布局,原布局已备份可回退」;
 *   ③ 确认之后才 POST /template/apply,结果如实上屏(建了哪几个文件夹、哪个应用没查到);
 *   ④ 「回退上次」:没有备份时是灰的;有备份时点了 POST /template/restore。
 *
 * 还有一件反着钉:**GET /template 404 时整节不出现** —— 不摆一个点不动的空表单。
 *
 * 2026-10-22 起照评审页 `section('template', '工作布局', …)`:两张卡本身就是按钮(名字 + 一句话),现用那张 `aria-pressed`,
 * 点另一张 = 原来的「切换」;「项目在这里叫什么 / 窗位 / 环节」收进文字键「一套布局里有什么」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemplatePanel, isTemplatePayload } from '../src/client/TemplatePanel.tsx'
import { CONFIRMS } from '../src/client/ui/index.tsx'

afterEach(cleanup)

const BASE = 'http://127.0.0.1:8791'

interface Call { url: string, method: string, body: unknown }

function payload(over: Record<string, unknown> = {}) {
  return {
    current: 'product',
    has_backup: false,
    templates: [
      {
        id: 'product',
        name: '做产品',
        tagline: '写代码、带 Agent、盯仓库和额度 —— 现在这一套就是它。',
        project_word: '项目',
        current: true,
        apps: [],
        folders: [],
        board_lanes: [],
      },
      {
        id: 'ops',
        name: '自媒体运营',
        tagline: '选题、脚本、剪辑、发布、复盘 —— 一条内容从想法到数据。',
        project_word: '账号',
        current: false,
        apps: [
          { label: 'ChatGPT', kind: 'native' },
          { label: '剪映', kind: 'native', note: '未查到 bundle id(这台机器上没装剪映)。' },
          { label: '可灵', kind: 'web' },
        ],
        folders: ['账号', '素材/脚本'],
        board_lanes: ['选题策划', '内容调研'],
      },
    ],
    ...over,
  }
}

/** 假 fetch:GET /template 回 `payload()`(切过之后回 `after`),POST 记一笔。 */
function fakeFetch(calls: Call[], opts: { get?: unknown, getStatus?: number, apply?: unknown, after?: unknown } = {}) {
  let switched = false
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'POST') {
      calls.push({ url: String(url), method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      switched = true
      return { ok: true, json: async () => opts.apply ?? { ok: true } }
    }
    calls.push({ url: String(url), method, body: undefined })
    if (opts.getStatus !== undefined && opts.getStatus >= 400) {
      return { ok: false, status: opts.getStatus, json: async () => ({ error: '布局模板未启用' }) }
    }
    return { ok: true, json: async () => (switched && opts.after !== undefined ? opts.after : (opts.get ?? payload())) }
  }) as unknown as typeof fetch
}

async function renderPanel(fetchImpl: typeof fetch): Promise<void> {
  render(<TemplatePanel baseUrl={BASE} fetchImpl={fetchImpl} />)
  await waitFor(() => expect(screen.queryByRole('heading', { name: '工作布局' })).not.toBeNull())
}

function click(name: string | RegExp): void {
  act(() => { screen.getByRole('button', { name }).click() })
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 两张卡片', () => {
  it('名字 + 一句话 + 当前标记', async () => {
    await renderPanel(fakeFetch([]))
    expect(screen.getByText('做产品')).toBeInTheDocument()
    expect(screen.getByText('自媒体运营')).toBeInTheDocument()
    expect(screen.getByText(/写代码、带 Agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^做产品/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^自媒体运营/ })).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('[data-tpl="product"]')).toHaveAttribute('data-current', 'true')
    expect(document.querySelector('[data-tpl="ops"]')).toHaveAttribute('data-current', 'false')
  })

  it('当前那张标着「按下」,点了什么都不发生(不问、不切);另一张点得动', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls))
    click(/^做产品/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
    expect(screen.getByRole('button', { name: /^自媒体运营/ })).toBeEnabled()
  })

  it('「一套布局里有什么」里写得出「项目在这里叫什么」、带哪几个应用、分几个环节', async () => {
    await renderPanel(fakeFetch([]))
    click('一套布局里有什么')
    expect(screen.getByText(/「项目」在这里叫「账号」/)).toBeInTheDocument()
    expect(screen.getByText(/ChatGPT、剪映、可灵/)).toBeInTheDocument()
    expect(screen.getByText(/待办分 2 个环节/)).toBeInTheDocument()
  })

  it('查不到 bundle id 的那个应用,原因**原样**摆出来', async () => {
    await renderPanel(fakeFetch([]))
    click('一套布局里有什么')
    expect(screen.getByText(/剪映:未查到 bundle id/)).toBeInTheDocument()
  })

  // 2026-10-23(分层二刀二):盘上记的当前模板这会儿认不出来(她删了 / 改坏了用户层布局文件),
  // 服务端在 detail 里带一句人话 —— 这里必须看得见:为什么界面退回「做产品」、怎么恢复。
  it('★当前模板认不出来时的那一句人话,在卡片区原样上屏', async () => {
    const note = '原来用的「ops」布局在用户层里读不出来或已不在,现在按「做产品」显示。把 用户层/布局/ops.json 修复或放回去就恢复。'
    await renderPanel(fakeFetch([], { get: payload({ note, current: 'ops' }) }))
    expect(screen.getByText(note)).toBeInTheDocument()
    // 没有这种情况时一行都不多。
    cleanup()
    await renderPanel(fakeFetch([]))
    expect(screen.queryByText(/读不出来或已不在/)).toBeNull()
  })
})

describe('② 二次确认', () => {
  it('点另一张卡(原来的「切换」)先问一句,**这一刻一个请求都没发**', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls))
    click(/^自媒体运营/)
    // 10-22 起是共用的确认弹层「切换布局?」(标题与确认键照评审页 CONFIRMS.switchLayout)
    const ask = screen.getByRole('dialog', { name: CONFIRMS.switchLayout.title })
    expect(ask.textContent).toContain('会重排布局,原布局已备份可回退')
    expect(ask.textContent).toContain('自媒体运营')
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
  })

  it('「取消」收回去(原来叫「再想想」),还是一个请求都没发', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls))
    click(/^自媒体运营/)
    click('取消')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(calls.filter(c => c.method === 'POST')).toEqual([])
  })
})

describe('③ 确认之后才切', () => {
  it('POST /template/apply 带着 id', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/template/apply'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/template/apply'))?.body).toEqual({ id: 'ops' })
  })

  it('结果如实上屏:建了哪几个文件夹、窗位那一句、并且明说不用刷新不用重启', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls, {
      apply: {
        ok: true,
        folders_made: ['账号', '素材/脚本'],
        folder_errors: [],
        apps_note: '已放进窗位清单:codex、t-doubao;剪映:未查到 bundle id',
      },
    }))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    const said = await screen.findByRole('status')
    expect(said.textContent).toContain('已经切过去了')
    expect(said.textContent).toContain('不用刷新、也不用重启')
    expect(said.textContent).toContain('账号、素材/脚本')
    expect(said.textContent).toContain('剪映:未查到 bundle id')
  })

  it('建不成的文件夹也如实说,不吞掉', async () => {
    await renderPanel(fakeFetch([], {
      apply: { ok: true, folders_made: [], folder_errors: ['素材/成片:EACCES'] },
    }))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    expect((await screen.findByRole('status')).textContent).toContain('素材/成片:EACCES')
  })

  it('切完重新拉一次 /template:当前标记跟着换过去', async () => {
    const after = payload({ current: 'ops', has_backup: true, last_backup_at: '2026-09-21T02:00:00.000Z' })
    const cards = after.templates as { id: string, current: boolean }[]
    cards.forEach((card) => { card.current = card.id === 'ops' })
    await renderPanel(fakeFetch([], { after }))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    await waitFor(() => expect(document.querySelector('[data-tpl="ops"]')).toHaveAttribute('data-current', 'true'))
  })

  it('服务端说没切成:把原因原样摆出来,不谎报成功', async () => {
    await renderPanel(fakeFetch([], { apply: { ok: false, reason: '存不下回退用的布局备份,这次没切' } }))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    expect((await screen.findByRole('status')).textContent).toContain('存不下回退用的布局备份')
  })
})

/**
 * 卡 TM(2026-09-27):「在设置里切换自媒体布局,压根没有切换布局成功。」
 *
 * 界面真的换过去那一步在 `tests/client-layout-live.test.tsx`(根因是页面只读一次
 * `/state.layout`)。这一节钉的是**这一节说的话**:成了要告诉他下一步(关掉设置窗),
 * 没成不许停在一句「已经切过去了」上。
 */
describe('③b 切了就要看得见(卡 TM)', () => {
  function switchedTo(id: string) {
    const after = payload({ current: id, has_backup: true })
    const cards = after.templates as { id: string, current: boolean }[]
    cards.forEach((card) => { card.current = card.id === id })
    return after
  }

  it('成了那一句里有「关掉这扇设置窗」—— 这扇窗盖在工作台上,不关他看不见', async () => {
    await renderPanel(fakeFetch([], { after: switchedTo('ops') }))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    const said = await screen.findByRole('status')
    expect(said.textContent).toContain('关掉这扇设置窗')
    expect(said.textContent).toContain('不用刷新、也不用重启')
    expect(said.textContent).not.toContain('没真的切过去')
  })

  it('★ 服务端回了 ok、但再问一次它还停在原来那个模板:当场说这次没切成,不谎报', async () => {
    // after 不给 → 切完那一拉回来的仍然是 current:'product' 的原样那一份。
    await renderPanel(fakeFetch([]))
    click(/^自媒体运营/)
    click(CONFIRMS.switchLayout.confirm)
    const said = await screen.findByRole('status')
    expect(said.textContent).toContain('没真的切过去')
    expect(said.textContent).toContain('请再点一次那张卡')
  })

  it('切回原来那套也是同一条路:POST 带 product 的 id,标记跟着换回去', async () => {
    const calls: Call[] = []
    const ops = payload({ current: 'ops', has_backup: true })
    ;(ops.templates as { id: string, current: boolean }[]).forEach((card) => { card.current = card.id === 'ops' })
    await renderPanel(fakeFetch(calls, { get: ops, after: switchedTo('product') }))
    click(/^做产品/)
    click(CONFIRMS.switchLayout.confirm)
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/template/apply'))).toBe(true))
    expect(calls.find(c => c.url.endsWith('/template/apply'))?.body).toEqual({ id: 'product' })
    await waitFor(() => expect(document.querySelector('[data-tpl="product"]')).toHaveAttribute('data-current', 'true'))
    expect((await screen.findByRole('status')).textContent).not.toContain('没真的切过去')
  })
})

describe('④ 回退上次', () => {
  it('没有备份:按钮是灰的,并说一句为什么', async () => {
    await renderPanel(fakeFetch([]))
    expect(screen.getByRole('button', { name: '回退上次' })).toBeDisabled()
    expect(screen.getByText('还没有可回退的布局备份。')).toBeInTheDocument()
  })

  it('有备份:按钮能点,点了 POST /template/restore,并显示上一份存于什么时候', async () => {
    const calls: Call[] = []
    await renderPanel(fakeFetch(calls, {
      get: payload({ has_backup: true, last_backup_at: '2026-09-21T02:00:00.000Z' }),
    }))
    expect(screen.getByText(/上一份备份存于 2026-09-21T02:00:00.000Z/)).toBeInTheDocument()
    click('回退上次')
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/template/restore'))).toBe(true))
  })
})

describe('⑤ 没接模板服务', () => {
  it('GET /template 404 → 整节不出现', async () => {
    render(<TemplatePanel baseUrl={BASE} fetchImpl={fakeFetch([], { getStatus: 404 })} />)
    await waitFor(() => expect(screen.queryByRole('heading', { name: '工作布局' })).toBeNull())
  })

  it('形状不对也当没拿到(别的节的 mock 串过来时不炸整个弹窗)', () => {
    expect(isTemplatePayload(null)).toBe(false)
    expect(isTemplatePayload({ current: 'product' })).toBe(false)
    expect(isTemplatePayload({ templates: [] })).toBe(false)
    expect(isTemplatePayload({ current: 'product', templates: [] })).toBe(true)
  })
})
