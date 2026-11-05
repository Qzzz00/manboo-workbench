/**
 * 「选题池」卡片上的「拆解这条」入口(2026-09-22,采集类第 4 条:接进技能)。
 *
 * 这一份钉的不是好看,是三件**性质**上的事:
 *
 * 1. **没接采集服务时连按钮都不出现** —— 不画一颗点了会 404 的按钮;
 * 2. **★ 要他给链接**:这一格里没有任何一处能搜索、能列别人的笔记。
 *    那句「我只从你给的这一条进,不会去搜、也不会去翻别人的主页」逐字在界面上;
 * 3. 点了之后打的是 `POST /collect/breakdown`,**服务端那句回话原样上屏**
 *    (拆不了的时候他要看到的是真原因,不是一句「失败了」)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TodoModule } from '../src/client/TodoModule.tsx'
import type { TaskView } from '../src/protocol.ts'

afterEach(cleanup)

const BASE = 'http://127.0.0.1:8791'
const FAKE_LINK = 'https://www.xiaohongshu.com/explore/aaaaaaaa1111bbbb2222cccc'

/** 一条在办的选题(名字一眼假)。 */
const TOPIC: TaskView = {
  id: 't-1',
  title: '假选题:用例用的',
  status: 'todo',
  kind: 'topic',
  stage: '灵感',
} as TaskView

const BOX = {
  id: 'todo',
  title: '选题池',
  basisPct: 50,
  dragging: false,
  onResizeStart: () => {},
  onResizeMove: () => {},
  onResizeEnd: () => {},
}

function stubFetch(reply: { ok?: boolean, message?: string } = {}) {
  const calls: { url: string, body?: string }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body === undefined ? {} : { body: String(init.body) }) })
    if (url.endsWith('/collect/breakdown')) {
      return { ok: true, status: 200, json: async () => ({ ok: reply.ok ?? true, message: reply.message ?? '拆好了' }) }
    }
    // /topic/assets:回一张空表就够了,这一份不测素材那一栏。
    return { ok: true, status: 200, json: async () => ({ topics: [] }) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function draw(collectReady: boolean, impl: typeof fetch) {
  return render(
    <TodoModule
      box={BOX}
      header={<h2 id="h">选题池</h2>}
      headingId="h"
      baseUrl={BASE}
      fetchImpl={impl}
      tasks={[TOPIC]}
      lanes={[]}
      collectReady={collectReady}
    />,
  )
}

/** 展开那张卡(按钮上写的就是选题名)。 */
async function openCard(): Promise<void> {
  await userEvent.click(screen.getByText('假选题:用例用的'))
}

describe('「拆解这条」', () => {
  it('★ 没接采集服务时那颗按钮不出现', async () => {
    const { impl } = stubFetch()
    draw(false, impl)
    await openCard()
    expect(screen.queryByRole('button', { name: '拆解这条' })).toBeNull()
    // 「素材」那颗照旧在 —— 这一版只加东西,不动既有的。
    expect(screen.getByRole('button', { name: '素材' })).toBeInTheDocument()
  })

  it('接上了才出现,而且展开后才有(不占着卡面)', async () => {
    const { impl } = stubFetch()
    draw(true, impl)
    expect(screen.queryByRole('button', { name: '拆解这条' })).toBeNull()
    await openCard()
    expect(screen.getByRole('button', { name: '拆解这条' })).toBeInTheDocument()
  })

  it('★ 点开之后要的是「链接」,并且逐字写着不去搜、不去翻别人主页', async () => {
    const { impl } = stubFetch()
    draw(true, impl)
    await openCard()
    await userEvent.click(screen.getByRole('button', { name: '拆解这条' }))
    const said = screen.getByText(/把那条爆款笔记的链接贴进来/)
    expect(said.textContent).toContain('我只从你给的这一条进')
    expect(said.textContent).toContain('不会去搜')
    expect(said.textContent).toContain('不会去翻别人的主页')
    expect(screen.getByLabelText('对标笔记链接')).toBeInTheDocument()
  })

  it('没填链接时「开始拆解」点不动', async () => {
    const { impl } = stubFetch()
    draw(true, impl)
    await openCard()
    await userEvent.click(screen.getByRole('button', { name: '拆解这条' }))
    expect(screen.getByRole('button', { name: '开始拆解' })).toBeDisabled()
  })

  it('填了链接点一下 → POST /collect/breakdown,body 里就是他给的那一条', async () => {
    const { impl, calls } = stubFetch({ message: '拆好了,落在 /假路径/拆解.md' })
    draw(true, impl)
    await openCard()
    await userEvent.click(screen.getByRole('button', { name: '拆解这条' }))
    await userEvent.type(screen.getByLabelText('对标笔记链接'), FAKE_LINK)
    await userEvent.click(screen.getByRole('button', { name: '开始拆解' }))

    await waitFor(() => expect(screen.getByText('拆好了,落在 /假路径/拆解.md')).toBeInTheDocument())
    const call = calls.find(one => one.url === `${BASE}/collect/breakdown`)
    expect(call).toBeDefined()
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ url: FAKE_LINK })
  })

  it('★ 拆不了的时候把服务端那句真原因原样摆出来(不是一句「失败了」)', async () => {
    const { impl } = stubFetch({ ok: false, message: '这台机器上找不到 whisper.cpp 的 whisper-cli —— 本机转写要它,这一条拆不了。' })
    draw(true, impl)
    await openCard()
    await userEvent.click(screen.getByRole('button', { name: '拆解这条' }))
    await userEvent.type(screen.getByLabelText('对标笔记链接'), FAKE_LINK)
    await userEvent.click(screen.getByRole('button', { name: '开始拆解' }))
    await waitFor(() => expect(screen.getByText(/找不到 whisper.cpp/)).toBeInTheDocument())
  })

  it('跑着的时候说一句「要几分钟」——不让他对着转圈干等', async () => {
    let release: (() => void) | undefined
    const impl = vi.fn(async (url: string) => {
      if (url.endsWith('/collect/breakdown')) {
        await new Promise<void>((done) => { release = done })
        return { ok: true, status: 200, json: async () => ({ ok: true, message: '拆好了' }) }
      }
      return { ok: true, status: 200, json: async () => ({ topics: [] }) }
    }) as unknown as typeof fetch

    draw(true, impl)
    await openCard()
    await userEvent.click(screen.getByRole('button', { name: '拆解这条' }))
    await userEvent.type(screen.getByLabelText('对标笔记链接'), FAKE_LINK)
    await userEvent.click(screen.getByRole('button', { name: '开始拆解' }))

    await waitFor(() => expect(screen.getByText(/要几分钟/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '拆解中…' })).toBeDisabled()
    release?.()
    await waitFor(() => expect(screen.getByText('拆好了')).toBeInTheDocument())
  })
})
