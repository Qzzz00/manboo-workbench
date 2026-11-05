/**
 * 事务官动了哪一块:页面在那一块旁边出一行字(2026-09-25 卡 P 补三)。
 *
 * 维护者 0.3.1 截图:「看到红框里的东西了吗,好像是个新bug」——「事务官正在挪任务卡的状态」连同一圈光框挂在
 * 工作台左上角,任务卡却在右边的看板里。那是服务端按布局参数(而且只按竖屏那一份)重算「看板在哪」再让壳画。
 * 统筹定:程序做的动作一律只出一行字,**页面自己画,挂在真实的元素上**;看不见(纯净模式、模块收起)就不画。
 *
 * 这里钉页面那一半:
 * ① 挂在哪:挪状态 / 改卡挂**那张卡**;建事项挂任务所在的那一块;贴 Finder 挂文件区;切窗挂窗口槽;
 * ② 纯净模式、那一块收起了 → 一行都不画;
 * ③ 同一块再来一条续上(不叠两行),到点收掉;
 * ④ 整条接线:/live 送来 → 那一块旁边出一行字;`actor_note_clear` 收掉;纯净模式下 0 行。
 * 服务端那一半(壳收到 0 次光效请求)在 tests/server-slot-glow-http.test.ts、server-highlight-http.test.ts。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActorNotes, actorNoteAnchor, addActorNote, isActorNote, liveActorNotes, type ShownActorNote } from '../src/client/ActorNotes.tsx'
import { DEFAULT_LAYOUT } from '../src/client/layout.ts'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { ActorNote, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const NOTE_MOVE: ActorNote = { action: 'task.move', region: 'board', task_id: 't-1', text: '事务官正在挪任务卡的状态', ttl_ms: 2000 }
const NOTE_CREATE: ActorNote = { action: 'task.create', region: 'board', text: '事务官正在建事项', ttl_ms: 2000 }
const NOTE_PIN: ActorNote = { action: 'files.pin', region: 'files', text: '事务官正在贴 Finder', ttl_ms: 2000 }
const NOTE_SWITCH: ActorNote = { action: 'dock.switch', region: 'slot', text: '事务官正在切换窗位', ttl_ms: 2000 }

/** 一块假的工作台:窗口槽、项目区(里面一张卡)、文件区 —— 属性与 ModuleBox / TaskCard 一样。 */
function mountFixture(): void {
  document.body.innerHTML = `
    <div class="ben-wb__mod" data-module-box="slot"><h2>窗口槽</h2></div>
    <div class="ben-wb__mod" data-module-box="projects"><article class="ben-wb__task" data-task-id="t-1"><button>通知测试</button></article></div>
    <div class="ben-wb__mod" data-module-box="files"><h2>文件</h2></div>`
}
const ALL_VISIBLE = new Set(['slot', 'projects', 'files'])
const view = (over: Partial<{ pureMode: boolean, visibleModuleIds: ReadonlySet<string> }> = {}) =>
  ({ pureMode: false, visibleModuleIds: ALL_VISIBLE, root: document, ...over })

describe('① 挂在哪:只认页面上真实存在的元素', () => {
  it('★挪状态 → 那张卡;建事项 → 项目区;贴 Finder → 文件区;切窗 → 窗口槽', () => {
    mountFixture()
    expect(actorNoteAnchor(NOTE_MOVE, view())).toBe(document.querySelector('[data-task-id="t-1"]'))
    expect(actorNoteAnchor(NOTE_CREATE, view())).toBe(document.querySelector('[data-module-box="projects"]'))
    expect(actorNoteAnchor(NOTE_PIN, view())).toBe(document.querySelector('[data-module-box="files"]'))
    expect(actorNoteAnchor(NOTE_SWITCH, view())).toBe(document.querySelector('[data-module-box="slot"]'))
  })

  it('那张卡不在页面上(别的视图 / 已经归档)→ 挂任务所在的那一块', () => {
    mountFixture()
    expect(actorNoteAnchor({ ...NOTE_MOVE, task_id: 't-不在' }, view())).toBe(document.querySelector('[data-module-box="projects"]'))
  })
})

describe('② 看不见就不画', () => {
  it('★纯净模式:哪一块都不画', () => {
    mountFixture()
    for (const note of [NOTE_MOVE, NOTE_CREATE, NOTE_PIN, NOTE_SWITCH]) expect(actorNoteAnchor(note, view({ pureMode: true }))).toBeUndefined()
  })

  it('那一块收起了(不在这一档看得见的模块里):不画,也不挂到别处去', () => {
    mountFixture()
    const noFiles = new Set(['slot', 'projects'])
    expect(actorNoteAnchor(NOTE_PIN, view({ visibleModuleIds: noFiles }))).toBeUndefined()
    const noProjects = new Set(['slot', 'files'])
    expect(actorNoteAnchor(NOTE_MOVE, view({ visibleModuleIds: noProjects }))).toBeUndefined()
  })
})

describe('画出来的样子', () => {
  const shown = (note: ActorNote): ShownActorNote[] => addActorNote([], note, Date.now())

  it('★挪状态 / 建事项 / 贴 Finder:各出 1 行字,挂在对的那一块上', () => {
    mountFixture()
    for (const [note, anchor] of [[NOTE_MOVE, 'task:t-1'], [NOTE_CREATE, 'module:projects'], [NOTE_PIN, 'module:files']] as const) {
      const { container, unmount } = render(<ActorNotes notes={shown(note)} pureMode={false} visibleModuleIds={ALL_VISIBLE} />)
      const lines = container.querySelectorAll('.ben-wb__actor-note')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toHaveTextContent(note.text)
      expect(lines[0]).toHaveAttribute('data-anchor', anchor)
      unmount()
    }
  })

  it('★纯净模式:0 行', () => {
    mountFixture()
    const { container } = render(<ActorNotes notes={[...shown(NOTE_MOVE), ...shown(NOTE_PIN)]} pureMode visibleModuleIds={ALL_VISIBLE} />)
    expect(container.querySelectorAll('.ben-wb__actor-note')).toHaveLength(0)
  })

  it('只是一行字:没有光、没有圈(不画任何 border-beam / 光框的东西)', () => {
    mountFixture()
    const { container } = render(<ActorNotes notes={shown(NOTE_SWITCH)} pureMode={false} visibleModuleIds={ALL_VISIBLE} />)
    expect(container.querySelector('[data-beam], [data-fx]')).toBeNull()
    expect(container.querySelector('.ben-wb__actor-note')?.tagName).toBe('P')
  })
})

describe('③ 续上、收掉;送来的东西不像样就不收', () => {
  it('同一块(同一张卡)再来一条:续上、换成新的那句,不叠两行;到点收掉', () => {
    let list = addActorNote([], NOTE_MOVE, 1000)
    list = addActorNote(list, { ...NOTE_MOVE, text: '事务官正在改任务卡' }, 1500)
    expect(list).toHaveLength(1)
    expect(list[0]?.note.text).toBe('事务官正在改任务卡')
    expect(list[0]?.until).toBe(3500)
    list = addActorNote(list, NOTE_PIN, 1600)
    expect(list).toHaveLength(2)
    expect(liveActorNotes(list, 3550).map(one => one.note.action)).toEqual(['files.pin'])
  })

  it('isActorNote:区域、字、时长都得像样', () => {
    expect(isActorNote(NOTE_MOVE)).toBe(true)
    expect(isActorNote({ ...NOTE_MOVE, region: '看板' })).toBe(false)
    expect(isActorNote({ ...NOTE_MOVE, text: '  ' })).toBe(false)
    expect(isActorNote({ ...NOTE_MOVE, ttl_ms: 0 })).toBe(false)
    expect(isActorNote({ ...NOTE_MOVE, task_id: 7 })).toBe(false)
  })
})

describe('④ 整条接线:/live → 那一块旁边一行字', () => {
  const NOW = '2026-09-25T12:00:00.000Z'
  function state(over: Partial<WorkbenchState> = {}): WorkbenchState {
    return { agents: [], sessions: [], quota: {}, now: NOW, stale: false, ...over }
  }
  function sockets() {
    const made: MinimalWebSocket[] = []
    const factory = () => { const ws: MinimalWebSocket = { onmessage: null, onclose: null, close: () => {} }; made.push(ws); return ws }
    return { made, factory }
  }
  function fakeFetch(read: () => WorkbenchState) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
      if (String(url).endsWith('/state')) return { ok: true, json: async () => ({ ...read() }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
  }
  function props(fetchImpl: typeof fetch, ws: () => MinimalWebSocket): WorkbenchOverlayProps {
    const instance = createWorkbenchStore().create()
    const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
    return {
      useStore: selector => selector(instance.getSnapshot()),
      actions: instance.actions,
      useWorkspaces: selector => selector(workspaceState as never),
      useSessions: selector => selector({} as never),
      ...UNUSED_STANDARD_PROPS,
      openWorkspace: async () => {}, openSession: () => {},
      serviceFetch: fetchImpl, servicePollMs: 0, serviceWebSocket: ws,
    }
  }
  const stored = new Map<string, string>()
  const memoryStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) }, clear: () => stored.clear() }
  beforeEach(() => {
    stored.clear()
    Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true })
  })
  const send = (ws: MinimalWebSocket, msg: unknown) => act(() => { ws.onmessage?.({ data: JSON.stringify(msg) }) })

  it('★事务官贴 Finder → 文件区旁边 1 行字;收掉的那一条到了 → 0 行', async () => {
    const ws = sockets()
    render(<WorkbenchOverlay {...props(fakeFetch(() => state({ onboarding: { stage: 'done', done: true } })), ws.factory)} />)
    await waitFor(() => expect(document.querySelector('[data-module-box="files"]')).not.toBeNull())
    send(ws.made.at(-1)!, { kind: 'actor_note', note: NOTE_PIN })
    const lines = document.querySelectorAll('.ben-wb__actor-note')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent('事务官正在贴 Finder')
    expect(lines[0]).toHaveAttribute('data-anchor', 'module:files')
    send(ws.made.at(-1)!, { kind: 'actor_note_clear' })
    expect(document.querySelectorAll('.ben-wb__actor-note')).toHaveLength(0)
  })

  it('★纯净模式:事务官挪状态、贴 Finder → 0 行', async () => {
    const ws = sockets()
    render(<WorkbenchOverlay {...props(fakeFetch(() => state({ onboarding: { stage: 'done', done: true }, layout: { ...DEFAULT_LAYOUT, pureMode: true } })), ws.factory)} />)
    await waitFor(() => expect(document.querySelector('main.ben-wb')).toHaveAttribute('data-pure', 'true'))
    send(ws.made.at(-1)!, { kind: 'actor_note', note: NOTE_MOVE })
    send(ws.made.at(-1)!, { kind: 'actor_note', note: NOTE_PIN })
    expect(document.querySelectorAll('.ben-wb__actor-note')).toHaveLength(0)
  })

  it('送来的不像样(缺字、区域认不出):不画', async () => {
    const ws = sockets()
    render(<WorkbenchOverlay {...props(fakeFetch(() => state({ onboarding: { stage: 'done', done: true } })), ws.factory)} />)
    await waitFor(() => expect(document.querySelector('[data-module-box="files"]')).not.toBeNull())
    send(ws.made.at(-1)!, { kind: 'actor_note', note: { ...NOTE_PIN, region: '文件夹' } })
    send(ws.made.at(-1)!, { kind: 'actor_note' })
    expect(document.querySelectorAll('.ben-wb__actor-note')).toHaveLength(0)
  })
})
