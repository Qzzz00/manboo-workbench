/**
 * 设置里那一节(2026-10-01 叫「事务官的提示词」;2026-10-02 改成**她的偏好**)。
 *
 * Air 上那位运营同学对 10-01 那一版的反馈是「太杂了」。10-02 起这一节钉七件:
 *   ① 没接(404)→ 整节不出现;
 *   ② 人话那几项:一句说明 + 一个例子 + 当前那一份,改 → 保存走 `POST /butler/prompts/save`;
 *   ③ 她改过的那一项标出来,有「恢复默认」;默认有更新时看得到新默认、能换过去;
 *   ④ **环节偏好**:一行一条,保存走 `POST /butler/prompts/pref`;
 *   ⑤ **技能正文不出现在人话那几项里**,整摊收在页底那一节、**默认收起**;
 *   ⑥ 不可改清单那几段只读 + 说清为什么;规矩那一段指回「记住的规矩」;
 *   ⑦ 迁移留下的旧内容:提示一次 + 原文摆出来,点「知道了」才消。
 * 2026-10-22(新 UI 第二轮 · 设置六组,照评审页):每项一行(名字 + 现在那一句 + 「改」),说明与例子、恢复默认、
 * 撤到上一版、看新默认收进「改」里面;环节偏好收在「各个环节的偏好」那一行的「查看」里;页底那一节是文字入口「只读工作手册」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { PROMPTS_MANUAL_TITLE, PromptsPanel, promptMetaLine } from '../src/client/PromptsPanel.tsx'
import { CONFIRM_SKILL_NAME } from '../src/server/confirmPoints.ts'
import { PROMPT_LOCKED_SECTIONS } from '../src/server/promptOverrides.ts'
import type { ButlerPromptSectionView, ButlerPromptStageView, ButlerPromptsView } from '../src/protocol.ts'

configure({ asyncUtilTimeout: 5_000 })
afterEach(() => { cleanup() })

const STYLE: ButlerPromptSectionView = {
  name: '说话方式', title: '说话方式', note: '说长还是说短、什么语气。', example: '比如:说话短一点,别称「您」。',
  body: '## 说话方式\n- 人设:沉稳',
  present: true, editable: true, overridden: false, default_changed: false, can_undo: false,
}
const RULES: ButlerPromptSectionView = {
  name: '规矩', title: '你的规矩(要 / 不要)', note: '你说过一次就处处算数的那几条。', body: '- 界面不要蓝',
  present: true, editable: false, overridden: false, default_changed: false, can_undo: false,
  elsewhere: '这几条在上面「记住的规矩」那一节加和改 —— 同一张表不该有两处入口。',
}
const MANUAL_LOCKED: ButlerPromptSectionView = {
  name: '需求确认点', title: '需求确认点', note: '工作台干这件事的步骤说明。', body: '默认正文,里面有 /butler/item 这种东西',
  present: true, editable: false, overridden: false, default_changed: false, can_undo: false,
  locked: PROMPT_LOCKED_SECTIONS[CONFIRM_SKILL_NAME] ?? '',
}
const MANUAL_SKILL: ButlerPromptSectionView = {
  name: '运营-发布包装', title: '运营-发布包装', note: '工作台干这件事的步骤说明。',
  body: '三组备选,产物落 选题/<选题名>/发布包装.md',
  present: true, editable: false, overridden: false, default_changed: false, can_undo: false,
  manual: '这一段是工作台的说明书,由工作台发版管着,不用你改。',
}
const STAGE: ButlerPromptStageView = {
  name: '运营-发布包装', title: '标题与封面', note: '标题、短文案、标签、封面建议。',
  example: '比如:标题不要用感叹号', lines: [], present: true, can_undo: false,
}

function view(over: Partial<ButlerPromptsView> = {}): ButlerPromptsView {
  return {
    file: '/tmp/AGENTS.md',
    basics: [STYLE],
    stages: [],
    manual: [],
    outside: '',
    note: '这里写的是你的意思。',
    ...over,
  }
}

/** 一台假服务:记下每一次 POST,GET 回当前那份。 */
function fakeServer(initial: ButlerPromptsView | null) {
  let current = initial
  const posts: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('http://wb', '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ path, body })
      return new Response(JSON.stringify({ ok: true, note: '记下了。电话下一通就按新的说。' }), { status: 200 })
    }
    if (current === null) return new Response(JSON.stringify({ error: '集中改提示词未启用' }), { status: 404 })
    return new Response(JSON.stringify(current), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, posts, set: (next: ButlerPromptsView) => { current = next } }
}

describe('事务官照你的意思办', () => {
  it('① 没接 → 整节不出现', async () => {
    const { fetchImpl } = fakeServer(null)
    const { container } = render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(container.querySelector('section')).toBeNull()
  })

  it('② 人话那一项:说明 + 例子 + 当前那一份,改了走那条接口', async () => {
    const { fetchImpl, posts } = fakeServer(view())
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText('说话方式')).toBeInTheDocument() })
    // 值直接摆在那儿 —— 不用先点一下「看全文」。
    expect(screen.getByText(/人设:沉稳/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '改' }))
    // 说明与例子在「改」的时候摆在框上面
    expect(screen.getByText(/别称「您」/)).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '改「说话方式」' })
    await userEvent.clear(box)
    await userEvent.type(box, '说话像朋友')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(posts).toHaveLength(1) })
    expect(posts[0]).toMatchObject({ path: '/butler/prompts/save', body: { name: '说话方式', body: '说话像朋友' } })
    // 回包那句话原样上屏。
    expect((await screen.findByRole('status')).textContent).toContain('电话下一通')
  })

  it('③ 她改过的那一项标出来、能恢复默认;默认有更新时能换过去', async () => {
    const { fetchImpl, posts } = fakeServer(view({
      basics: [{ ...STYLE, overridden: true, default_changed: true, latest_default_body: '新默认那一份' }],
    }))
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText(/你改过这一项/)).toBeInTheDocument() })
    expect(screen.getByText(/默认版本有更新/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '改' }))
    await userEvent.click(screen.getByRole('button', { name: '看新默认' }))
    expect(screen.getByText('新默认那一份')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    await waitFor(() => { expect(posts[0]?.path).toBe('/butler/prompts/reset') })
  })

  it('④ 环节偏好:一行一条,保存走那条接口', async () => {
    const { fetchImpl, posts } = fakeServer(view({ stages: [STAGE] }))
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText('各个环节的偏好')).toBeInTheDocument() })
    expect(screen.queryByText('标题与封面', { selector: 'strong' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByText('标题与封面', { selector: 'strong' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '写一条' }))
    expect(screen.getByText(/标题不要用感叹号/)).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: '改「标题与封面」的偏好' })
    await userEvent.type(box, '标题不要用感叹号')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(posts).toHaveLength(1) })
    expect(posts[0]).toMatchObject({
      path: '/butler/prompts/pref',
      body: { name: '运营-发布包装', lines: ['标题不要用感叹号'] },
    })
  })

  it('⑤ 说明书默认收起,展开才看得到技能正文', async () => {
    const { fetchImpl } = fakeServer(view({ stages: [STAGE], manual: [MANUAL_SKILL], outside: '我自己写在文件里的一句。' }))
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '只读工作手册' })).toBeInTheDocument() })
    // 默认收起:技能段名、正文、段外那些话一个都不在屏上。
    expect(screen.queryByText(new RegExp(PROMPTS_MANUAL_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull()
    expect(screen.queryByText('运营-发布包装')).toBeNull()
    expect(screen.queryByText(/发布包装.md/)).toBeNull()
    expect(screen.queryByText('这份文件里别的话')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '只读工作手册' }))
    expect(screen.getByText(new RegExp(PROMPTS_MANUAL_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
    expect(screen.getByText('运营-发布包装')).toBeInTheDocument()
    expect(screen.getByText('这份文件里别的话')).toBeInTheDocument()
    // 正文要再点一下「看全文」才摊开,而且没有「改」。
    const row = screen.getByText('运营-发布包装').closest('.ben-wb__prompt-manual-row') as HTMLElement
    await userEvent.click(row.querySelector('button') as HTMLElement)
    expect(screen.getByText(/发布包装.md/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改这一段' })).toBeNull()
  })

  it('⑥ 不可改清单那一段只读并说清为什么;规矩那一项指回「记住的规矩」', async () => {
    const { fetchImpl } = fakeServer(view({ basics: [RULES], manual: [MANUAL_LOCKED] }))
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText(/记住的规矩/)).toBeInTheDocument() })
    expect(screen.queryByRole('button', { name: '改' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '只读工作手册' }))
    expect(screen.getByText(/不可改清单·澄清环节/)).toBeInTheDocument()
  })

  it('⑦ 迁移留下的旧内容:提示一次 + 原文摆出来,点「知道了」才消', async () => {
    const { fetchImpl, posts } = fakeServer(view({
      stages: [{ ...STAGE, kept: '我以前自己改的那一整段', notice: '这段你改过的旧内容我替你放在这里了' }],
    }))
    render(<PromptsPanel baseUrl="http://wb" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(screen.getByText(/我替你放在这里了/)).toBeInTheDocument() })
    expect(screen.getByText('我以前自己改的那一整段')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '知道了' }))
    await waitFor(() => { expect(posts[0]).toMatchObject({ path: '/butler/prompts/pref/seen' }) })
  })

  it('那一小行把三件事说清', () => {
    expect(promptMetaLine({ ...STYLE, overridden: true, default_changed: true })).toBe('你改过这一项 · 默认版本有更新')
    expect(promptMetaLine({ ...STYLE, present: false })).toBe('这一项还没写进去')
    expect(promptMetaLine(STYLE)).toBe('')
  })
})
