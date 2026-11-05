/**
 * 当前那一格的窗其实不在窗位里(2026-09-25,卡 fix/slot-current-empty)。
 *
 * 统筹 0.2.88 真壳验收:插件重载后窗口槽停在「Kimi」标签,槽里一整块空的深色区 —— 维护者一打开
 * 看见的就是「一块空黑区 + 高亮的 Kimi 标签」。断言写的是他在屏幕上看得到什么:
 *   ① 那个标签上写「点一下拉进来」,原因在悬停 / 聚焦出来的说明卡里(PR #5 起不用系统 title);点了照旧 /dock/switch(那条路会开应用、唤窗、摆位、置前);
 *   ② 槽里写清是哪一家、为什么,外加一颗「点一下拉进来」—— 不留空黑区;
 *   ③ 窗好好在窗位里的标签一个字不变。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { SlotZone } from '../src/client/SlotZone.tsx'

afterEach(cleanup)

function recordingFetch() {
  const calls: { url: string, body: unknown }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('标签:窗没在窗位里的那一格', () => {
  it('★写「点一下拉进来」,原因在说明卡里;点了就是 /dock/switch(拉进来)', () => {
    const fetchImpl = recordingFetch()
    render(
      <DockTabBar
        dock={{ stack: [
          { key: 'codex', label: 'Codex', running: true, current: false },
          { key: 'kimi', label: 'Kimi', running: true, current: true, unplaced: 'Kimi 被藏起来了' },
        ] }}
        sessions={[]} badges={{}} baseUrl="http://x" fetchImpl={fetchImpl.impl}
        butlerActive={false} onSelectButler={() => {}}
      />,
    )
    const kimi = screen.getByRole('button', { name: 'Kimi:点一下拉进来' })
    expect(kimi).not.toHaveAttribute('title')
    fireEvent.focus(kimi)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Kimi 被藏起来了 · 点一下拉进来')
    expect(kimi.closest('span')).toHaveAttribute('data-unplaced', 'true')
    fireEvent.click(kimi)
    expect(fetchImpl.calls).toEqual([{ url: 'http://x/dock/switch', body: { app: 'kimi' } }])
    // 好好在窗位里的那一格一个字不变。
    expect(screen.getByRole('button', { name: 'Codex' }).closest('span')).not.toHaveAttribute('data-unplaced')
    expect(screen.getAllByText('点一下拉进来')).toHaveLength(1)
  })
})

describe('槽里:不留一块空黑区', () => {
  it('★写清是哪一家、为什么,外加一颗「点一下拉进来」', () => {
    const onPull = vi.fn()
    render(
      <SlotZone
        helper={{ connected: true, authorized: true }}
        snap={undefined}
        dockNote={undefined}
        bodyRef={createRef<HTMLDivElement>()}
        dropHover={false}
        missing={{ label: 'Kimi', reason: 'Kimi 被藏起来了', onPull }}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('「Kimi」的窗没在窗位里:Kimi 被藏起来了。')
    fireEvent.click(screen.getByRole('button', { name: '点一下拉进来' }))
    expect(onPull).toHaveBeenCalledTimes(1)
  })

  it('窗好好在窗位里(没给 missing)→ 槽里什么都不多画', () => {
    render(
      <SlotZone
        helper={{ connected: true, authorized: true }}
        snap={undefined}
        dockNote={undefined}
        bodyRef={createRef<HTMLDivElement>()}
        dropHover={false}
      />,
    )
    expect(screen.queryByRole('button', { name: '点一下拉进来' })).toBeNull()
  })
})
