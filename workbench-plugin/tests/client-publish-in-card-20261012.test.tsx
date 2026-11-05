/**
 * 发布计划:填写面板在卡片里切换,不铺全台遮罩(2026-10-12,卡 `claude/ops-patch-1012`;
 * 运营同学 10-08 在 0.4.98 产物上改的做法,移植进 `user-layer/起步/小组件/publish/index.js`)。
 *
 * 他的原话(维护说明 10-08):「根据使用反馈,取消全工作台层级的模态弹窗和背景遮罩。
 * 点击『添加计划』或日历日期后,仅在『发布计划』卡片内部切换到编辑面板,不遮挡、不模糊其他工作台模块。」
 *
 * 钉四件事:
 *   ① 点一天开的面板(role=dialog)是**这一格的孩子**,不是挂在 body 上的整屏层;
 *   ② 没有 `position:fixed` 的整屏遮罩;卡片内那层遮罩也在这一格里;
 *   ③ 点卡片内遮罩、Esc、取消都关得掉;
 *   ④ 存成之后面板自己收起(没有 <dialog>.close() 可依赖了,靠 picked 置空)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const PublishModule = starterWidget('publish')

afterEach(cleanup)

const BOX = { id: 'publish', title: '发布计划', basisPct: 30, dragging: false, onResizeStart: () => {}, onResizeMove: () => {}, onResizeEnd: () => {} }
const NOON_0928 = new Date(2026, 8, 28, 12, 0).toISOString()

function fakeFetch() {
  const calls: { url: string, body: unknown }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: true, id: 't-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function paint(fetchImpl: typeof fetch) {
  return render(
    <PublishModule box={BOX} header={<h3 id="p">发布计划</h3>} headingId="p" baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} tasks={[]} now={NOON_0928} projects={[]} />,
  )
}

function pickDay(date: string): void {
  const found = [...document.querySelectorAll('.cp-day')].find(node => (node.getAttribute('aria-label') ?? '').startsWith(date))
  if (found === undefined) throw new Error(`月历上没有 ${date} 这一格`)
  act(() => { (found as HTMLButtonElement).click() })
}

function styleText(): string {
  return [...document.querySelectorAll('style')].map(node => node.textContent ?? '').join('\n')
}

describe('发布计划:填写面板在卡片里', () => {
  it('★面板是这一格的孩子,不是整屏层;卡片自己 position:relative + overflow:hidden 把它圈住', () => {
    paint(fakeFetch().impl)
    pickDay('2026-09-30')
    const card = document.querySelector('.ben-wb__publish-card')
    expect(card).not.toBeNull()
    const dialog = screen.getByRole('dialog', { name: '填写发布计划' })
    expect(card).toContainElement(dialog)
    expect(dialog).toHaveClass('cp-panel')
    const css = styleText()
    expect(css).toContain('.ben-wb__publish-card{position:relative;overflow:hidden}')
    expect(css).toContain('.cp-panel{position:absolute')
  })

  it('★没有整屏遮罩:没有 position:fixed 的那一层,卡片内那层遮罩也在这一格里', () => {
    paint(fakeFetch().impl)
    pickDay('2026-09-30')
    expect(document.querySelector('.cp-backdrop')).toBeNull()
    expect(styleText()).not.toContain('position:fixed')
    const local = document.querySelector('.cp-local-backdrop')
    expect(local).not.toBeNull()
    expect(document.querySelector('.ben-wb__publish-card')).toContainElement(local as HTMLElement)
  })

  it('点卡片内遮罩关得掉;Esc、取消照旧', () => {
    paint(fakeFetch().impl)
    pickDay('2026-09-30')
    act(() => { (document.querySelector('.cp-local-backdrop') as HTMLElement).click() })
    expect(screen.queryByRole('dialog')).toBeNull()
    pickDay('2026-09-30')
    act(() => { screen.getByRole('dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    pickDay('2026-09-30')
    act(() => { screen.getByRole('button', { name: '取消' }).click() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('存成之后面板自己收起、月历上说一句', async () => {
    const { impl, calls } = fakeFetch()
    paint(impl)
    pickDay('2026-10-02')
    const input = screen.getByLabelText('发布内容标题') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, '拍开箱视频')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await waitFor(() => expect(calls.some(one => one.url.endsWith('/task/create'))).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status').textContent).toContain('2026-10-02')
  })
})
