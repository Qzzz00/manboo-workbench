import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentCard, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { COLLAB_Z } from '../src/client/collab/collabStyle.ts'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-21T09:00:00.000Z'
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch,
})

const card = (id: `agent:${string}`, name: string): AgentCard => ({
  id,
  name,
  owner: 'me',
  hand: 'code',
  runtime: { family: 'codex' },
  model: { name: 'gpt-5' },
  shared: { to: 'workspace' },
  created_at: AT,
  updated_at: AT,
})

function stateWith(tasks: TaskView[] = [], agent_cards: AgentCard[] = [card('agent:codex', 'Codex')]): WorkbenchState {
  return {
    now: AT,
    sessions: [],
    tasks: {
      tasks,
      sprints: [],
      modules: [],
      project_meta: [],
      goals: [{ id: 'g-1', title: '目标一', why: '完成一期', owner: 'me', status: 'open', created_at: AT, updated_at: AT }],
      goal_sprints: [],
      agent_cards,
      session_proposals: [],
    },
    agent_registry: { entries: [], asking: [], notices: [] },
  } as unknown as WorkbenchState
}

function fakeFetch() {
  const calls: { path: string, method: string }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push({ path: url.pathname, method })
    const json = url.pathname === '/collab/canvas' && method === 'GET'
      ? { layout: { goals: {}, notes: {} } }
      : { ok: true }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

describe('名片浮列与对话框层级关系', () => {
  it('层级常量:对话框遮罩(dialogVeil)严格高于名片浮列(floatingRail)', () => {
    expect(COLLAB_Z.dialogVeil).toBeGreaterThan(COLLAB_Z.floatingRail)
  })

  it('换头像对话框打开时名片列不在其上 / 关掉后恢复', async () => {
    const user = userEvent.setup()
    const fetch = fakeFetch()
    render(
      <div style={{ width: 600, height: 600, position: 'relative' }}>
        <CollabZone
          state={stateWith([note('任务一')])}
          baseUrl="http://127.0.0.1:8791"
          fetchImpl={fetch.impl}
          presence={[]}
          visible
          width={600}
          initialView="timeline"
        />
      </div>
    )

    // 点击顶栏名片按钮打开名片浮列
    const railBtn = await screen.findByRole('button', { name: /名片/ })
    await user.click(railBtn)
    expect(screen.getByRole('complementary', { name: '名片' })).toBeInTheDocument()

    // 点击名片列里的「给 Codex 换头像」打开 AvatarEditor 对话框
    const avatarEditBtn = screen.getByRole('button', { name: /给 Codex 换头像/ })
    await user.click(avatarEditBtn)

    // 对话框打开后,名片浮列不再在屏幕上(收起/隐藏)
    expect(await screen.findByRole('dialog', { name: /更换头像/ })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '名片' })).toBeNull()

    // 关掉对话框后,名片浮列恢复显示
    const cancelBtn = screen.getByRole('button', { name: '取消' })
    await user.click(cancelBtn)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /更换头像/ })).toBeNull()
    })
    expect(screen.getByRole('complementary', { name: '名片' })).toBeInTheDocument()
  })

  it('设置对话框打开时名片浮列收起 / 关掉后恢复', async () => {
    const user = userEvent.setup()
    const fetch = fakeFetch()
    render(
      <div style={{ width: 600, height: 600, position: 'relative' }}>
        <CollabZone
          state={stateWith([note('任务一')])}
          baseUrl="http://127.0.0.1:8791"
          fetchImpl={fetch.impl}
          presence={[]}
          visible
          width={600}
          initialView="timeline"
        />
      </div>
    )

    // 打开名片浮列
    const railBtn = await screen.findByRole('button', { name: /名片/ })
    await user.click(railBtn)
    expect(screen.getByRole('complementary', { name: '名片' })).toBeInTheDocument()

    // 打开设置对话框
    const settingsBtn = screen.getByRole('button', { name: '设置' })
    await user.click(settingsBtn)

    // 设置对话框打开,名片浮列收起
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '名片' })).toBeNull()

    // 关掉设置对话框,名片浮列恢复
    const closeBtn = screen.getByRole('button', { name: '关闭设置' })
    await user.click(closeBtn)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull()
    })
    expect(screen.getByRole('complementary', { name: '名片' })).toBeInTheDocument()
  })
})
