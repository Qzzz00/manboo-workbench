// @vitest-environment node
/**
 * 给他看的字只有一个出口(2026-09-25,卡 M 补;统筹真壳:事项对话里她回的「**B**」原样露出了 `**`)。
 * src/plainText.ts:`plainForHim` 一段话怎么洗,`stateForHim` 发出去的 /state 里哪几格洗。
 */
import { describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { plainForHim, stateForHim } from '../src/plainText.ts'

describe('plainForHim:一段话 → 给他看的纯文字', () => {
  it('★「**B**」→「B」;加粗、下划线加粗、删除线、行内代码:记号去掉、字留着', () => {
    expect(plainForHim('**B**')).toBe('B')
    expect(plainForHim('选 **B**,__理由__ 是 ~~旧的~~ 新的,跑 `pnpm test`')).toBe('选 B,理由 是 旧的 新的,跑 pnpm test')
  })
  it('标题井号、引用号、星号列表、分隔线、代码围栏(里面的字留着)、链接与图片(留说明文字)', () => {
    expect(plainForHim('# 结论\n> 他说过\n* 第一条\n+ 第二条\n- 第三条\n---\n```ts\nconst a = 1\n```\n看 [这个页面](https://x.y/z) ![截图](a.png)')).toBe(
      '结论\n他说过\n· 第一条\n· 第二条\n- 第三条\n\nconst a = 1\n看 这个页面 截图')
  })
  it('单星号的强调只认两边挨着空白 / 标点的;「2*3*4」这种算式不动;落单的 ** 去掉', () => {
    expect(plainForHim('这是 *重点* 啊')).toBe('这是 重点 啊')
    expect(plainForHim('2*3*4=24')).toBe('2*3*4=24')
    expect(plainForHim('没配上对的 ** 记号')).toBe('没配上对的  记号')
  })
  it('洗过的再洗一遍不变;空的、不是字的回空', () => {
    const once = plainForHim('**好**,我去办。\n\n\n\n下一步 `x`')
    expect(plainForHim(once)).toBe(once)
    expect(plainForHim('')).toBe('')
    expect(plainForHim(undefined as unknown as string)).toBe('')
  })
})

describe('stateForHim:发出去的那一份里她和别家说的话都洗过', () => {
  const state = {
    agents: [], quota: {}, now: 'x', stale: false,
    sessions: [
      { agent: 'dsh', session_id: 's-1', project: '', status: 'done', elapsed_sec: 0, unread: false, updated_at: 'x', summary: '收到,选 **B**。', title: '**标题不动**' },
      { agent: 'codex', session_id: 's-2', project: '', status: 'running', elapsed_sec: 0, unread: false, updated_at: 'x' },
    ],
    tasks: {
      tasks: [{
        id: 't-1', title: '**他的标题不动**', status: 'confirm', direction: 'mine', source: { kind: 'manual' }, created_at: 'x', updated_at: 'x',
        deliverables: [{ kind: 'reply', ref: '选 **B** 就行' }, { kind: 'file', ref: '/tmp/**a**.md' }],
        dispatch: { family: 'codex', status: 'done', reply: '`done`' },
        client_dispatch: { family: 'kimi', status: 'sent', reply: '# 回答\n**好**' },
      }],
      sprints: [], modules: [], project_meta: [],
    },
    butler_inbox: { items: [{ id: 'confirm:t-1', kind: 'confirm', title: 't', summary: '**B**' }] },
  } as unknown as WorkbenchState

  it('会话最近一句、事项的回答、派给别家收回来的回答、收件箱抄的那一句:洗掉;标题、文件路径、他自己的话不动;原对象不改', () => {
    const shown = stateForHim(state)
    expect(shown.sessions[0]?.summary).toBe('收到,选 B。')
    expect(shown.sessions[0]?.title).toBe('**标题不动**')
    expect(shown.sessions[1]).toBe(state.sessions[1])
    const task = shown.tasks!.tasks[0]!
    expect(task.title).toBe('**他的标题不动**')
    expect(task.deliverables).toEqual([{ kind: 'reply', ref: '选 B 就行' }, { kind: 'file', ref: '/tmp/**a**.md' }])
    expect(task.dispatch?.reply).toBe('done')
    expect(task.client_dispatch?.reply).toBe('回答\n好')
    expect(shown.butler_inbox?.items[0]?.summary).toBe('B')
    expect(state.sessions[0]?.summary).toBe('收到,选 **B**。')
    expect(state.tasks!.tasks[0]!.deliverables![0]!.ref).toBe('选 **B** 就行')
  })
})
