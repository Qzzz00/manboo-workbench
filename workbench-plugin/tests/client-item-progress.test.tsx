import '@testing-library/jest-dom/vitest'
/**
 * 一件事一份、进度靠证据(2026-09-25,卡 N)在电脑界面上的那几块:
 *
 * - 看板卡上那一行「现在到哪」、卡片弹窗里「现在到哪 · 依据 · 几点看的」与三颗按钮(现在核一次 / 派给 X / 说一句);
 * - 负责人那一排放宽到人那三档 + 补充;
 * - 空的模块泳道收成一行;
 * - 事项那一屏:看板上写了负责人的卡也是事项;证据里冒出来的下一步在「待确认」里问「要加上吗」。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEntryView, BoardModule, SprintView, TaskProgressView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { PROGRESS_NONE_LINE, dispatchAskText, friendlyWhen, isItemExecuting } from '../src/protocol.ts'
import { TaskBoard, type BoardActions } from '../src/client/TaskBoard.tsx'
import { TaskCard } from '../src/client/TaskCard.tsx'
import { TaskDialog } from '../src/client/TaskDialog.tsx'
import { ProgressBlock } from '../src/client/ProgressBlock.tsx'
import { driveLabel } from '../src/client/boardModel.ts'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { mineCard } from '../src/client/orb.ts'

afterEach(cleanup)

/**
 * 登记表里接上了的那几家(卡 Z:负责人那一排、卡面小头像的颜色与名字都读它)。
 * 事务官自己那一条不进这一排(它另有一颗「事务官」);「Foo AI」是运行时发现的那一种(id 是包标识)。
 */
function registryAgents(): readonly AgentEntryView[] {
  const base = { found: { how: 'patrol' as const, at: '', basis: '' }, sources: [], status: 'idle' as const, gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 } }
  return [
    { ...base, id: 'dsh', name: '事务官', self: true },
    { ...base, id: 'claude', bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', color: '#e8875a' },
    { ...base, id: 'doubao', bundle_id: 'com.bot.pc.doubao', name: '豆包', color: '#4f7cff' },
    { ...base, id: 'com.example.fooai', bundle_id: 'com.example.fooai', name: 'Foo AI', color: '#66cc99' },
  ]
}

const AT = '2026-09-25T02:00:00.000Z'
const NOW = '2026-09-25T15:00:00+08:00'

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 'a', title: '参赛网页架构收尾', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...over }
}

const SITE: TaskProgressView = {
  line: '11 屏已做完,逐屏文案稿在等你审',
  state: 'found',
  basis: [{ kind: 'session', source: 'Codex 里「制作参赛网页」那段对话', ref: '/Users/example/.codex/sessions/2026/09/23/rollout-01a0ccd1.jsonl', at: '2026-09-24T12:17:00Z', quote: '11 屏按网页顺序排列' }],
  checked_at: '2026-09-25T07:10:00Z',
  waiting_on: 'me',
  by: 'model',
}
const NONE: TaskProgressView = { line: PROGRESS_NONE_LINE, state: 'none', basis: [], checked_at: '2026-09-25T07:10:00Z', by: 'rules', read_sessions: true }

describe('看板卡上那一行「现在到哪」', () => {
  it('核过的卡:标题下一行写证据说的进度;悬停看依据与几点看的 —— 出处是人话、时刻是「昨天 / 今天」(不露文件名、路径)', () => {
    render(<TaskCard task={task({ assignee: 'codex', progress: SITE })} sessions={[]} sessionUsage={{}} nowMs={Date.parse(NOW)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
    const line = screen.getByText('11 屏已做完,逐屏文案稿在等你审')
    expect(line).toHaveAttribute('data-state', 'found')
    const title = line.getAttribute('title') ?? ''
    expect(title).toMatch(/依据:Codex 里「制作参赛网页」那段对话 · 昨天 \d{2}:17/)
    expect(title).toMatch(/今天 \d{2}:10 看的/)
    expect(title).not.toMatch(/rollout|jsonl|\/Users/)
  })

  it('没看到进展的卡,卡面上不画那一句(刚引导完一屏卡张张挂「没看到」只会让人发懵;那一句在卡片弹窗里)', () => {
    render(<TaskCard task={task({ assignee: 'codex', progress: NONE })} sessions={[]} sessionUsage={{}} nowMs={Date.parse(NOW)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
    expect(document.querySelector('.ben-wb__task-progress')).toBeNull()
    expect(screen.queryByText(PROGRESS_NONE_LINE)).toBeNull()
  })

  it('没核过的卡整行不画;负责人小标悬停带补充', () => {
    render(<TaskCard task={task({ assignee: 'colleague', assignee_note: '9/29 回来写' })} sessions={[]} sessionUsage={{}} nowMs={Date.parse(NOW)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
    expect(document.querySelector('.ben-wb__task-progress')).toBeNull()
    expect(screen.getByText('同事')).toHaveAttribute('title', '负责人 同事 · 9/29 回来写')
  })
})

describe('卡片弹窗:现在到哪 · 依据 · 几点看的', () => {
  function dialog(one: TaskView, extra: Partial<Parameters<typeof TaskDialog>[0]> = {}) {
    const onUpdate = vi.fn()
    render(<TaskDialog task={one} moduleName="参赛材料" sessions={[]} sessionUsage={{}} branches={[]} filePathHints={[]} onClose={() => {}} onMove={() => {}} onUpdate={onUpdate} onDelete={() => {}} {...extra} />)
    return onUpdate
  }

  it('进度、依据(出处 + 时刻 + 逐字那一句)、几点看的;没接按钮时只读', () => {
    dialog(task({ assignee: 'codex', progress: SITE, mover: { who: 'me', line: '等你点头派给 Codex', assignee: 'codex' } }), { now: NOW })
    const block = screen.getByRole('region', { name: '现在到哪' })
    expect(within(block).getByText('现在该谁动:等你点头派给 Codex')).toBeInTheDocument()
    expect(within(block).getByText('11 屏已做完,逐屏文案稿在等你审')).toBeInTheDocument()
    const basis = within(block).getByRole('list', { name: '依据' })
    expect(basis.textContent).toMatch(/^依据:Codex 里「制作参赛网页」那段对话 · 昨天 \d{2}:17 · 11 屏按网页顺序排列$/)
    expect(block.textContent).toMatch(/今天 \d{2}:10 看的/)
    expect(block.textContent).not.toMatch(/rollout|jsonl|\/Users|按规则|证据/)
    expect(within(block).queryByRole('button')).toBeNull()
  })

  it('三颗按钮:现在核一次 / 派给 Codex(他点的这一下就是点头)/ 没看到进展时说一句;没看到进展时补一句我在哪儿找过', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => '看过了。')
    const drive = vi.fn(async () => '派给 Codex 了')
    const say = vi.fn(async () => '记下了。')
    dialog(task({ assignee: 'codex', progress: NONE }), { progressActions: { check, drive, say }, now: NOW })
    const block = screen.getByRole('region', { name: '现在到哪' })
    expect(within(block).getByText('还没看到进展,要你说一句')).toBeInTheDocument()
    expect(within(block).getByText('项目文件夹、交出去的活、你跟各家 AI 的对话里,都没说到这件事做到哪了。')).toBeInTheDocument()
    await user.click(within(block).getByRole('button', { name: '现在核一次' }))
    expect(check).toHaveBeenCalledWith('a')
    expect(await within(block).findByText('看过了。')).toBeInTheDocument()
    // 真派活前先摆出那一问(与外层卡、手机同一句);点「先不派」收回去,点「派」才派。
    await user.click(within(block).getByRole('button', { name: '派给 Codex' }))
    const confirm = within(block).getByRole('group', { name: '派活确认' })
    expect(confirm).toHaveTextContent('这张派给 Codex 开工?现在:还没看到这件事的进展')
    await user.click(within(confirm).getByRole('button', { name: '先不派' }))
    expect(drive).not.toHaveBeenCalled()
    await user.click(within(block).getByRole('button', { name: '派给 Codex' }))
    await user.click(within(within(block).getByRole('group', { name: '派活确认' })).getByRole('button', { name: '派' }))
    expect(drive).toHaveBeenCalledWith('a')
    await user.type(within(block).getByRole('textbox', { name: '说一句到哪了' }), '域名昨天注册好了{Enter}')
    expect(say).toHaveBeenCalledWith('a', '域名昨天注册好了')
    expect(await within(block).findByText('记下了。')).toBeInTheDocument()
  })

  it('这一轮没看各家的对话(他还没点头 / 说了不看):「我在哪儿找过」不说看过对话', () => {
    render(<ProgressBlock task={task({ assignee: 'codex', progress: { ...NONE, read_sessions: false } })} now={NOW} />)
    expect(screen.getByText('项目文件夹和交出去的活里,都没说到这件事做到哪了(你跟各家 AI 的对话我没看)。')).toBeInTheDocument()
  })

  it('证据找到了就不摆「说一句」;负责人是他 / 同事的卡不摆「派给」', () => {
    const actions = { check: vi.fn(), drive: vi.fn(), say: vi.fn() }
    render(<ProgressBlock task={task({ assignee: 'me', progress: SITE })} actions={actions} />)
    expect(screen.queryByRole('textbox', { name: '说一句到哪了' })).toBeNull()
    expect(screen.queryByRole('button', { name: /派给|交给事务官/ })).toBeNull()
    expect(screen.getByRole('button', { name: '现在核一次' })).toBeInTheDocument()
  })

  /**
   * ★ 卡 Z(2026-09-25):几家 AI **从 Agent 登记表插进来**(原来 `ASSIGNEE_PICKER` 里写死着六家)——
   * 名字是登记表里那一家的名字,登记表里新接上一家这一排就多一颗,不改代码。
   */
  // 2026-10-21 协作区:「同事 / 别人」退休,那一排不再给选;老卡上写着「同事」的照旧摆出来(看得出原来选的是谁)。
  it('负责人那一排:你 / 事务官 / 登记表里的每一家;老卡上的「同事」照旧摆出来;人那几档可补一句', async () => {
    const user = userEvent.setup()
    const onUpdate = dialog(task({ assignee: 'colleague' }), { agents: registryAgents() })
    const group = screen.getByRole('group', { name: '负责人' })
    expect(within(group).getAllByRole('button').map(one => one.textContent)).toEqual(['你', '事务官', 'Claude', '豆包', 'Foo AI', '同事'])
    await user.click(within(group).getByRole('button', { name: '你' }))
    expect(onUpdate).toHaveBeenCalledWith('a', { assignee: 'me' })
    await user.type(screen.getByRole('textbox', { name: '负责人补充' }), '9/29 回来写')
    await user.tab()
    expect(onUpdate).toHaveBeenCalledWith('a', { assignee_note: '9/29 回来写' })
  })

  it('卡上写着一家不在那一排里的(电话里点名的 GPT):也摆出来,看得出选的是谁', () => {
    dialog(task({ assignee: 'gpt' }))
    expect(within(screen.getByRole('group', { name: '负责人' })).getByRole('button', { name: 'GPT' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('「派给 X」那颗什么时候有', () => {
  it('待办 + 某家 AI / 事务官;在跑的、选题 / 需求卡、人那三档都没有', () => {
    expect(driveLabel(task({ assignee: 'codex' }))).toBe('派给 Codex')
    expect(driveLabel(task({ assignee: 'dsh' }))).toBe('交给事务官')
    expect(driveLabel(task({ assignee: 'me' }))).toBeUndefined()
    expect(driveLabel(task({ assignee: 'colleague' }))).toBeUndefined()
    expect(driveLabel(task({ assignee: 'codex', status: 'doing' }))).toBeUndefined()
    expect(driveLabel(task({ assignee: 'codex', kind: 'feature' }))).toBeUndefined()
    expect(driveLabel(task())).toBeUndefined()
  })

  it('真派活前那一问(外层卡、卡片弹窗、手机同一句):证据说已经做完时把「对不上」接在后面', () => {
    // 挂进外层那一问(会挂一阵子):写几月几日;界面上现画的(给了 now):写「昨天」。
    expect(dispatchAskText('codex', SITE)).toMatch(/^这张派给 Codex 开工\?现在:11 屏已做完,逐屏文案稿在等你审\(Codex 里「制作参赛网页」那段对话 · \d+月\d+日 \d{2}:17\)$/)
    expect(dispatchAskText('codex', SITE, undefined, NOW)).toMatch(/\(Codex 里「制作参赛网页」那段对话 · 昨天 \d{2}:17\)$/)
    expect(dispatchAskText('dsh', NONE)).toBe('这张交给事务官开工?现在:还没看到这件事的进展')
    const done: TaskProgressView = { ...SITE, state: 'mismatch', mismatch: '卡上还在待办,可我看到已经做完' }
    expect(dispatchAskText('claude', done)).toContain(';和卡上对不上:卡上还在待办,可我看到已经做完')
  })

  it('界面上的时刻:今天 / 昨天 / 几月几日(不是今年的带年份);只有日子的不补钟点;认不出空串', () => {
    const now = '2026-09-25T15:00:00+08:00'
    expect(friendlyWhen(new Date(2026, 8, 25, 9, 5).toISOString(), now)).toBe('今天 09:05')
    expect(friendlyWhen(new Date(2026, 8, 24, 20, 17).toISOString(), now)).toBe('昨天 20:17')
    expect(friendlyWhen(new Date(2026, 8, 22, 8, 0).toISOString(), now)).toBe('9月22日 08:00')
    expect(friendlyWhen(new Date(2025, 11, 30, 8, 0).toISOString(), now)).toBe('2025年12月30日 08:00')
    expect(friendlyWhen('2026-09-24', now)).toBe('昨天')
    expect(friendlyWhen('2026-09-20', now)).toBe('9月20日')
    expect(friendlyWhen('不是时刻', now)).toBe('')
  })
})

describe('空的模块泳道收成一行', () => {
  it('没有卡的模块:名字 + 「这一栏还没有卡」+ 记一条,不画七个空格子', async () => {
    const user = userEvent.setup()
    const sprint: SprintView = { id: 's1', project_id: 'p1', name: '冲刺一', versions: [], created_at: AT, updated_at: AT }
    const modules: BoardModule[] = [
      { id: 'm1', sprint_id: 's1', name: '核心能力与打磨', created_at: AT, updated_at: AT },
      { id: 'm2', sprint_id: 's1', name: '参赛材料', created_at: AT, updated_at: AT },
    ]
    const actions = {
      createTask: vi.fn(), moveTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
      createSprint: vi.fn(), updateSprint: vi.fn(), deleteSprint: vi.fn(),
      createModule: vi.fn(), updateModule: vi.fn(), deleteModule: vi.fn(), setProjectMeta: vi.fn(),
    } satisfies BoardActions
    render(<TaskBoard tasks={[task({ project_id: 'p1', module_id: 'm1' })]} sprints={[sprint]} modules={modules} projectMeta={[]} projects={[{ id: 'p1', name: '工作台', stage: 'MVP 开发', links: [], session_count: 0, idle: false }]} sessions={[]} now={NOW} axis="module-rows" onAxisChange={() => {}} actions={actions} />)
    const empty = screen.getByLabelText('参赛材料 · 还没有卡')
    expect(within(empty).getByText('这一栏还没有卡')).toBeInTheDocument()
    expect(screen.queryByLabelText('参赛材料 · 待办')).toBeNull()
    expect(screen.getByLabelText('核心能力与打磨 · 待办')).toBeInTheDocument()
    await user.type(within(empty).getByLabelText('在 参赛材料 记一条'), '换真截图{Enter}')
    expect(actions.createTask).toHaveBeenCalledWith({ title: '换真截图', projectId: 'p1', moduleId: 'm2' })
  })
})

describe('事项那一屏:一件事一份', () => {
  const state = (tasks: TaskView[], extra: Partial<WorkbenchState> = {}): WorkbenchState => ({
    agents: [], sessions: [], quota: {}, stale: false, now: NOW,
    tasks: { tasks, sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] }, ...extra,
  })

  it('看板上写了负责人的卡也是一件事项(与他交给事务官的同摆);没写负责人的看板卡不是', () => {
    const model = buildButlerScene(state([
      task({ id: 'site', assignee: 'codex', progress: SITE, mover: { who: 'butler', line: '排着,等派给 Codex', assignee: 'codex' } }),
      task({ id: 'plain', title: '随手记的一张' }),
      task({ id: 'mine', title: '他交给事务官的', direction: 'mine', conversation: { agent: 'dsh', session_id: 's-1' } }),
    ]))
    expect(model.items.map(item => item.id).sort()).toEqual(['mine', 'site'])
    const site = model.items.find(item => item.id === 'site')
    expect(site?.note).toBe('排着,等派给 Codex')
    expect(site?.evidence?.line).toBe('11 屏已做完,逐屏文案稿在等你审')
  })

  it('证据里冒出来的下一步:不在「待确认」那一夹里(它是提议,不是等他验收),照旧点「加上」/「不要」', async () => {
    const user = userEvent.setup()
    const s = state([task({ id: 'shot', title: '换真截图', status: 'backlog', origin: 'evidence', desc: 'Codex 里「制作参赛网页」那段对话里提到还要做这件(9月24日 20:17):「换成真实界面截图」\n要加上就点「加上」,不要就点「不要」。' })], {
      butler_inbox: { items: [{ id: 'confirm:shot', kind: 'confirm', title: '换真截图', note: '对话里提到还要做的 · 要不要加', status: 'backlog', task_id: 'shot' }] },
    })
    const model = buildButlerScene(s)
    // 2026-09-27(卡 WY):「等你确认」那一夹只放他不点头就卡住的事;提议摆在排着那一夹,标题是名词短语。
    expect(model.groups.confirmation).toEqual([])
    expect(model.groups.queued.map(item => [item.title, item.label, item.proposalTaskId])).toEqual([['换真截图', '要不要加', 'shot']])
    const onProposal = vi.fn()
    render(<ButlerScene state={s} onOpen={() => {}} onConfirm={() => {}} onProposal={onProposal} focusedId="shot">{null}</ButlerScene>)
    await user.click(screen.getByRole('button', { name: '加上这张卡:换真截图' }))
    expect(onProposal).toHaveBeenCalledWith('shot', true)
    await user.click(screen.getByRole('button', { name: '不要这张卡:换真截图' }))
    expect(onProposal).toHaveBeenCalledWith('shot', false)
  })

  it('看板上派出去、正在那家跑着的卡算「执行中」(口径 isItemExecuting)', () => {
    const running = task({ id: 'site', status: 'doing', assignee: 'codex', links: [{ agent: 'codex', session_id: 'c-1' }] })
    const snapshot = { sessions: [{ agent: 'codex' as const, session_id: 'c-1', project: '', status: 'running' as const, elapsed_sec: 60, unread: false, updated_at: AT }], agents: [], stale: false }
    expect(isItemExecuting(running, snapshot)).toBe(true)
    const { assignee: _drop, ...unowned } = running
    expect(isItemExecuting(unowned, snapshot)).toBe(false)
  })

  it('看板上的那种事项卡上不写「会话未开」,写现在该谁动', () => {
    expect(mineCard(task({ assignee: 'colleague', mover: { who: 'others', line: '等同事 · 9/29 回来写', assignee: 'colleague' } })).note).toBe('等同事 · 9/29 回来写')
    expect(mineCard(task({ direction: 'mine' })).note).toBe('会话未开')
  })
})
