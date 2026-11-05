/**
 * 各家会话读成人话(sessionDigest.ts,2026-09-25 卡 P)。
 *
 * 用例里的记录形状照 2026-09-25 真机上的三家会话文件抄(内容换成假的):Claude Code 2.1.280、
 * Codex Desktop 0.155(新版 item_completed)与老版 CLI、Kimi 桌面版 wire.jsonl。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCommand, clip, digestClaude, digestCodex, digestKimi, humanize, readSessionDigest, readSessionTurns, turnsOf,
} from '../src/server/sessionDigest.ts'

const lines = (...rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n')

describe('humanize:一句能给他看的人话', () => {
  it('截在第一个代码 / 路径片段之前,退回上一个分句边界', () => {
    expect(humanize('我先结合截图和仓库现状确认这张界面的上下文，使用 `ben-work-context` 和 `using-superpowers` 技能检查相关约定。', 36))
      .toBe('我先结合截图和仓库现状确认这张界面的上下文')
  })

  it('去掉 ** 与标题记号;第一句没意思就用下一句', () => {
    expect(humanize('现在 15:13。先说结论：**大约 16:30 能先用上第一批**，四张卡全部合进去。', 60))
      .toBe('先说结论：大约 16:30 能先用上第一批，四张卡全部合进去。')
    expect(humanize('## 进度\n已经改好了。', 20)).toBe('已经改好了。')
  })

  it('不露路径、文件名、英文键名、会话号、工具名', () => {
    const cases = [
      '先看 /Users/example/Documents/GitHub/desktop-workbench/docs/交接.md 再说',
      '改 butlerSceneModel.ts 里的标题逻辑',
      '把 session_id 填进去',
      '读一下 state.sessions 这一格',
      '提交 b2caedd2 已推',
      '用 Bash 跑一下看看',
    ]
    for (const text of cases) {
      const out = humanize(text, 40) ?? ''
      expect(out).not.toMatch(/\/Users|\.ts|session_id|state\.sessions|b2caedd2|Bash/)
    }
  })

  it('洗完没东西就 undefined(调用方换下一个来源,不拿空话凑)', () => {
    expect(humanize('`foo.ts`', 20)).toBeUndefined()
    expect(humanize('好的。', 20)).toBeUndefined()
    expect(humanize('```\nconst a = 1\n```', 20)).toBeUndefined()
    expect(humanize('| 卡 | 进度 |\n|---|---|', 20)).toBeUndefined()
  })

  it('反引号里是中文的留字', () => {
    expect(humanize('打开`工作台`看一下', 20)).toBe('打开工作台看一下')
  })

  it('派活标签与系统注入去掉', () => {
    expect(humanize('【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作:把架构补完', 20)).toBe('接着「制作参赛网页」那条会话的工作:把…')
    expect(humanize('<system-reminder>别管这个</system-reminder>帮我看看首页', 20)).toBe('帮我看看首页')
  })

  it('标题 / 他那句话接着往下拼:多行合成一句(前一句没有句末标点补「，」)', async () => {
    const { humanizeText } = await import('../src/server/sessionDigest.ts')
    expect(humanizeText('修复会话来源\n不要猜状态', 20, 1)).toBe('修复会话来源，不要猜状态')
    expect(humanizeText('先看一下。再改 `a.ts` 里的东西。最后跑测试。', 40)).toBe('先看一下。最后跑测试。')
  })

  it('按字截断带「…」', () => {
    expect(clip('一二三四五六七八九十', 5)).toBe('一二三四…')
    expect(clip('短', 5)).toBe('短')
  })

  it('★超长的一大串(贴进来的日志、base64、压缩过的代码)不卡服务:一眨眼就说完', () => {
    // 以前「a/b 形的相对路径」那条在一长串没有斜杠的字母上回溯成三次方:1600 个字母就要 4 秒,
    // 一段贴进来的日志能把整个服务卡住几十秒。
    const t0 = performance.now()
    expect(humanize('x'.repeat(20000), 60)).toBeUndefined()
    expect(humanize(`先把这件事说清楚 ${'x'.repeat(20000)}/tail`, 60)).toBe('先把这件事说清楚')
    expect(humanize(`先把这件事说清楚 ${'a-b'.repeat(5000)}`, 60)).toBe('先把这件事说清楚')
    expect(humanize('很长的一段话没有句号'.repeat(300), 20)).toBe('很长的一段话没有句号很长的一段话没有句…')
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('classifyCommand:一条命令属于哪一类', () => {
  it('测试 / 构建 / 提交 / 推送 / 看 / 找', () => {
    expect(classifyCommand('cd x && taskpolicy -c utility npx vitest run tests/a.test.ts')).toBe('test')
    expect(classifyCommand('pnpm build')).toBe('build')
    expect(classifyCommand('git -C /a/b commit -m "x"')).toBe('commit')
    expect(classifyCommand('git push origin feat/site')).toBe('push')
    expect(classifyCommand('git status --short')).toBe('git')
    expect(classifyCommand('cat README.md')).toBe('read')
    expect(classifyCommand('rg -n foo src')).toBe('search')
    expect(classifyCommand('python3 x.py')).toBe('run')
  })
})

// ───────────── Claude ─────────────

const claudeUser = (text: string, at: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: 's-1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', timestamp: at,
  origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra,
})
const claudeAssistant = (content: unknown[], at: string, stop: string) => ({
  type: 'assistant', sessionId: 's-1', timestamp: at, message: { role: 'assistant', content, stop_reason: stop },
})
const toolResult = (at: string) => ({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })

describe('digestClaude', () => {
  it('标题:custom-title(Claude 自己的会话名)优先;没有就第一句要求的前 20 来字', () => {
    const withTitle = lines(
      claudeUser('帮我把首页的球做大一点,现在太小了看不清楚', '2026-09-25T06:00:00.000Z'),
      { type: 'custom-title', customTitle: 'Desktop-workbench 统筹交接', sessionId: 's-1' },
    )
    expect(digestClaude({ head: withTitle, tail: withTitle }).title).toBe('Desktop-workbench 统筹交接')
    const noTitle = lines(claudeUser('帮我把首页的球做大一点,现在太小了看不清楚', '2026-09-25T06:00:00.000Z'))
    const digest = digestClaude({ head: noTitle, tail: noTitle })
    expect(digest.title).toBe('帮我把首页的球做大一点,现在太小了看不…')
    expect(digest.title_source).toBe('first_ask')
  })

  it('桌面 App 的会话名(name)压过 custom-title', () => {
    const text = lines({ type: 'custom-title', customTitle: '旧名字' }, claudeUser('随便', '2026-09-25T06:00:00.000Z'))
    expect(digestClaude({ head: text, tail: text, name: '空间快不足了' }).title).toBe('空间快不足了')
  })

  it('子任务回报、系统提醒、工具结果都不算他说的话', () => {
    const text = lines(
      claudeUser('<task-notification><task-id>a1</task-id></task-notification>', '2026-09-25T06:00:00.000Z', { origin: { kind: 'task-notification' } }),
      claudeUser('<system-reminder>The user started your task</system-reminder>', '2026-09-25T06:00:01.000Z'),
      toolResult('2026-09-25T06:00:02.000Z'),
      claudeUser('把窗口槽截图的问题修掉', '2026-09-25T06:00:03.000Z'),
    )
    const digest = digestClaude({ head: text, tail: text })
    expect(digest.title).toBe('把窗口槽截图的问题修掉')
    expect(digest.rounds.map(round => round.ask)).toEqual(['把窗口槽截图的问题修掉'])
  })

  it('在做什么:最近那句旁白;旁白太旧就按最后一步的种类说', () => {
    const text = lines(
      claudeUser('跑一下测试', '2026-09-25T06:00:00.000Z'),
      claudeAssistant([{ type: 'text', text: '我先看一下最近的提交，再跑全量测试。' }], '2026-09-25T06:00:05.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'git log --oneline -5', description: 'Show recent commits' } }], '2026-09-25T06:00:06.000Z', 'tool_use'),
      toolResult('2026-09-25T06:00:07.000Z'),
    )
    const recent = digestClaude({ head: text, tail: text })
    expect(recent.activity).toEqual({ line: '我先看一下最近的提交，再跑全量测试。', at: '2026-09-25T06:00:05.000Z' })

    const longer = lines(
      claudeUser('跑一下测试', '2026-09-25T06:00:00.000Z'),
      claudeAssistant([{ type: 'text', text: '我先看一下最近的提交。' }], '2026-09-25T06:00:05.000Z', 'tool_use'),
      ...[1, 2, 3, 4].map(i => claudeAssistant([{ type: 'tool_use', name: 'Read', input: { file_path: `/a/${i}.ts` } }], `2026-09-25T06:0${i}:00.000Z`, 'tool_use')),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm vitest run', description: 'Run tests' } }], '2026-09-25T06:05:00.000Z', 'tool_use'),
    )
    expect(digestClaude({ head: longer, tail: longer }).activity).toEqual({ line: '在跑测试', at: '2026-09-25T06:05:00.000Z' })
  })

  it('带中文说明的一步操作直接用说明;派助手写「派助手:…」', () => {
    const text = lines(
      claudeUser('查一下', '2026-09-25T06:00:00.000Z'),
      claudeAssistant([{ type: 'tool_use', name: 'Agent', input: { description: '查手机端返回手势', prompt: '...' } }], '2026-09-25T06:01:00.000Z', 'tool_use'),
    )
    expect(digestClaude({ head: text, tail: text }).activity?.line).toBe('派助手:查手机端返回手势')
  })

  it('这一轮只有他那句话、它还没动 →「在想你说的『…』」', () => {
    const text = lines(claudeUser('把事务官页的会话标题补上', '2026-09-25T06:00:00.000Z'))
    expect(digestClaude({ head: text, tail: text }).activity).toEqual({ line: '在想你说的「把事务官页的会话标题补上」', at: '2026-09-25T06:00:00.000Z' })
  })

  it('一轮:他说的 + 它最后说的 + 数出来的「做了什么」;说完了 ended', () => {
    const text = lines(
      claudeUser('修一下', '2026-09-25T06:00:00.000Z'),
      claudeAssistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/x.ts' } }], '2026-09-25T06:01:00.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/x.ts' } }], '2026-09-25T06:01:10.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Write', input: { file_path: '/a/y.ts' } }], '2026-09-25T06:01:20.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run' } }], '2026-09-25T06:02:00.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m x' } }], '2026-09-25T06:03:00.000Z', 'tool_use'),
      claudeAssistant([{ type: 'thinking', thinking: '...' }], '2026-09-25T06:04:00.000Z', 'end_turn'),
      claudeAssistant([{ type: 'text', text: '改好了，测试全绿，已提交。' }], '2026-09-25T06:04:01.000Z', 'end_turn'),
    )
    const digest = digestClaude({ head: text, tail: text })
    expect(digest.rounds).toEqual([{ ask: '修一下', reply: '改好了，测试全绿，已提交。', did: '改了 2 个文件、跑了 1 次测试、提交了 1 次', at: '2026-09-25T06:04:01.000Z' }])
    expect(digest.ended).toBe(true)
    expect(digest.last_at).toBe('2026-09-25T06:04:01.000Z')
  })

  it('只贴了一张图:标题「看一张图片」,那一轮写「发来一张图片」', () => {
    const text = lines(claudeUser('', '2026-09-25T06:00:00.000Z', { message: { role: 'user', content: [{ type: 'image', source: {} }] } }))
    const digest = digestClaude({ head: text, tail: text })
    expect(digest.title).toBe('看一张图片')
    expect(digest.rounds[0]?.ask).toBe('发来一张图片')
  })

  it('尾巴从一轮中间切进来(没有他那句):照样说在做什么,最近那句要求从 last-prompt 补', () => {
    const tail = lines(
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], '2026-09-25T06:00:00.000Z', 'tool_use'),
      { type: 'last-prompt', lastPrompt: '把会话标题补上' },
    )
    const digest = digestClaude({ head: lines(claudeUser('第一句', '2026-09-25T05:00:00.000Z')), tail })
    expect(digest.title).toBe('第一句')
    expect(digest.activity?.line).toBe('在查找')
    expect(digest.rounds).toEqual([{ ask: '把会话标题补上', did: '查找了 1 次', at: '2026-09-25T06:00:00.000Z' }])
  })
})

// ───────────── Codex ─────────────

const codexRow = (type: string, payload: Record<string, unknown>, at: string) => ({ timestamp: at, type, payload })
const item = (itemBody: Record<string, unknown>, at: string) => codexRow('event_msg', { type: 'item_completed', item: itemBody }, at)

describe('digestCodex', () => {
  const meta = codexRow('session_meta', { id: 'c-1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', source: 'vscode' }, '2026-09-25T05:42:08.000Z')

  it('新版:注入的上下文不算;第一句要求去掉派活标签当标题', () => {
    const text = lines(
      meta,
      codexRow('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>\n- Dropbox' }] }, '2026-09-25T05:42:09.000Z'),
      codexRow('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作' }] }, '2026-09-25T05:42:10.000Z'),
      item({ type: 'UserMessage', content: [{ type: 'text', text: '【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作' }] }, '2026-09-25T05:42:10.000Z'),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '我先按续接任务检查最近提交、未提交改动和原会话进度，再补剩余网页架构。' }], phase: 'commentary' }, '2026-09-25T05:42:15.000Z'),
      item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'cat docs/a.md'], parsed_cmd: [{ type: 'read', path: 'docs/a.md' }] }, '2026-09-25T05:42:20.000Z'),
    )
    const digest = digestCodex({ head: text, tail: text })
    expect(digest.session_id).toBe('c-1')
    expect(digest.title).toBe('接着「制作参赛网页」那条会话的工作')
    expect(digest.rounds).toHaveLength(1) // 新版同一句话出现两遍,只认一份
    expect(digest.activity?.line).toBe('我先按续接任务检查最近提交、未提交改动和原会话进度，再补剩余网页架构。')
  })

  it('thread_name 压过第一句;task_complete = 说完了;FileChange 数文件', () => {
    const text = lines(
      meta,
      item({ type: 'UserMessage', content: [{ type: 'text', text: '补完网页架构' }] }, '2026-09-25T05:42:10.000Z'),
      item({ type: 'FileChange', changes: { '/a/site/index.html': { type: 'update' }, '/a/site/app.js': { type: 'update' } } }, '2026-09-25T05:50:00.000Z'),
      item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'git push origin feat/site'], parsed_cmd: [{ type: 'unknown' }] }, '2026-09-25T06:01:24.000Z'),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '已接着原有11屏补完导航、异常回退和构建校验。' }], phase: 'final_answer' }, '2026-09-25T06:01:49.000Z'),
      codexRow('event_msg', { type: 'task_complete', last_agent_message: '已接着…' }, '2026-09-25T06:01:49.500Z'),
    )
    const digest = digestCodex({ head: text, tail: text, name: '补完参赛网页架构' })
    expect(digest.title).toBe('补完参赛网页架构')
    expect(digest.title_source).toBe('name')
    expect(digest.ended).toBe(true)
    expect(digest.rounds[0]).toEqual({ ask: '补完网页架构', reply: '已接着原有11屏补完导航、异常回退和构建校验。', did: '改了 2 个文件、推送了 1 次', at: '2026-09-25T06:01:49.500Z' })
  })

  it('他只发了一张图:标题取它第一句回答', () => {
    const text = lines(
      meta,
      item({ type: 'UserMessage', content: [{ type: 'text', text: '\n' }, { type: 'image', image_url: 'data:image/png;base64,xx' }] }, '2026-09-24T12:26:54.000Z'),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '截图里最明显的三点：\n\n- 粒子球偏暗' }], phase: 'final_answer' }, '2026-09-24T12:27:24.000Z'),
    )
    const digest = digestCodex({ head: text, tail: text })
    expect(digest.title).toBe('截图里最明显的三点，粒子球偏暗')
    expect(digest.title_source).toBe('first_reply')
    expect(digest.rounds[0]?.ask).toBe('发来一张图片')
  })

  it('老版 CLI:user_message / agent_message / exec_command_begin / update_plan', () => {
    const text = lines(
      codexRow('session_meta', { id: 'old-1', cwd: '/w', source: 'cli' }, '2026-09-01T01:00:00.000Z'),
      codexRow('event_msg', { type: 'user_message', message: '把登录页改成深色' }, '2026-09-01T01:00:01.000Z'),
      codexRow('response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: '读登录页样式', status: 'completed' }, { step: '换成深色配色', status: 'in_progress' }] }) }, '2026-09-01T01:00:05.000Z'),
      codexRow('event_msg', { type: 'exec_command_begin', command: ['bash', '-lc', 'pnpm build'] }, '2026-09-01T01:00:06.000Z'),
    )
    const digest = digestCodex({ head: text, tail: text })
    expect(digest.title).toBe('把登录页改成深色')
    expect(digest.activity).toEqual({ line: '换成深色配色', at: '2026-09-01T01:00:05.000Z' })
    expect(digest.rounds[0]?.did).toBe('构建了 1 次')
  })
})

// ───────────── Kimi ─────────────

describe('digestKimi', () => {
  it('turn.prompt 去掉 meta / 附件;todo 里正在做的那一步;工具的中文说明', () => {
    const text = lines(
      { type: 'metadata', protocol_version: '1.4', created_at: 1788765000000 },
      { type: 'turn.prompt', input: [{ type: 'text', text: '<meta awareness="low" timestamp="2026-09-07 15:07" />\n先整体读一遍仓库，然后再看测试反馈\n\n<attachment>{"type":"file","path":"/Users/example/x.pdf"}</attachment>' }] },
      { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'ls -la', description: '查看仓库顶层结构和最近提交记录' } } },
      { type: 'usage.record', time: 1788765020000 },
      { type: 'tools.update_store', key: 'todo', value: [{ title: '整体读一遍仓库', status: 'done' }, { title: '解析 0.63 测试反馈 PDF', status: 'in_progress' }], time: 1788765025934 },
    )
    const digest = digestKimi({ head: text, tail: text, name: '读仓库看反馈' })
    expect(digest.title).toBe('读仓库看反馈')
    expect(digest.rounds[0]?.ask).toBe('先整体读一遍仓库，然后再看测试反馈')
    expect(digest.activity?.line).toBe('解析 0.63 测试反馈 PDF')
    expect(digest.activity?.at).toBe(new Date(1788765025934).toISOString())
  })

  it('step.end end_turn = 说完了,最后那段文字是回答', () => {
    const text = lines(
      { type: 'turn.prompt', input: [{ type: 'text', text: '一小时有几分钟' }] },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: '...' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '一小时有60分钟。' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end', finishReason: 'end_turn' } },
      { type: 'usage.record', time: 1790279943059 },
    )
    const digest = digestKimi({ head: text, tail: text, fallbackAt: '2026-09-25T03:59:00.000Z' })
    expect(digest.ended).toBe(true)
    expect(digest.rounds[0]).toMatchObject({ ask: '一小时有几分钟', reply: '一小时有60分钟。' })
    expect(digest.title).toBe('一小时有几分钟')
  })
})

// ───────────── 读文件 ─────────────

describe('readSessionDigest', () => {
  let dir: string | undefined
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined })

  it('大文件只读头尾:标题在头上,在做什么在尾上', async () => {
    dir = mkdtempSync(join(tmpdir(), 'digest-'))
    const file = join(dir, 's-1.jsonl')
    const filler = claudeAssistant([{ type: 'text', text: 'x'.repeat(2000) }], '2026-09-25T06:00:00.000Z', 'tool_use')
    writeFileSync(file, `${lines(
      claudeUser('第一句要求:把截图不切窗做成机制', '2026-09-25T05:00:00.000Z'),
      ...Array.from({ length: 200 }, () => filler),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm build' } }], '2026-09-25T07:00:00.000Z', 'tool_use'),
    )}\n`)
    const digest = await readSessionDigest({ format: 'claude-transcript', file }, { headBytes: 4096, tailBytes: 4096 })
    expect(digest?.title).toBe('第一句要求:把截图不切窗做成机制')
    expect(digest?.activity).toEqual({ line: '在构建', at: '2026-09-25T07:00:00.000Z' })
  })

  it('文件不在 → undefined(不猜)', async () => {
    expect(await readSessionDigest({ format: 'codex-rollout', file: '/no/such/file.jsonl' })).toBeUndefined()
  })
})

// ───────────── 原文回合(卡 N 的证据评估用) ─────────────

describe('turnsOf:原文回合,不经 humanize', () => {
  it('★Claude:它说的整段原话留着(文件名不截);第一句要求原文带派活记号;说完的那段标 final;主会话不是子任务', () => {
    const text = lines(
      claudeUser('【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作:把逐屏文案整理出来给我审', '2026-09-25T05:00:00.000Z', { isSidechain: false }),
      claudeAssistant([{ type: 'thinking', thinking: '先看看' }, { type: 'text', text: '我先读一下原会话。' }], '2026-09-25T05:00:05.000Z', 'tool_use'),
      claudeAssistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.md' } }], '2026-09-25T05:00:06.000Z', 'tool_use'),
      toolResult('2026-09-25T05:00:07.000Z'),
      claudeAssistant([{ type: 'text', text: '已整理成『参赛网页逐屏文案稿.md』,在等你审。' }], '2026-09-25T05:10:00.000Z', 'end_turn'),
    )
    const turns = turnsOf('claude-transcript', { head: text, tail: text })
    expect(turns.first_ask).toBe('【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作:把逐屏文案整理出来给我审')
    expect(turns.subagent).toBe(false)
    expect(turns.session_id).toBe('s-1')
    expect(turns.cwd).toBe('/Users/example/Documents/GitHub/desktop-workbench')
    expect(turns.turns).toEqual([
      { k: 'ask', text: '【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作:把逐屏文案整理出来给我审', at: '2026-09-25T05:00:00.000Z' },
      { k: 'reply', text: '我先读一下原会话。', at: '2026-09-25T05:00:05.000Z' },
      { k: 'reply', text: '已整理成『参赛网页逐屏文案稿.md』,在等你审。', at: '2026-09-25T05:10:00.000Z', final: true },
    ])
  })

  it('Claude 子任务的会话(从第一条起就是 sidechain)→ subagent', () => {
    const text = lines(claudeUser('查一下手机端返回手势', '2026-09-25T05:00:00.000Z', { isSidechain: true }))
    expect(turnsOf('claude-transcript', { head: text, tail: text }).subagent).toBe(true)
  })

  it('Codex:只认 AgentMessage 的文字(新版一句话两份只认一份),final_answer 标 final;子任务派出来的 → subagent', () => {
    const text = lines(
      codexRow('session_meta', { id: 'c-1', cwd: '/w', source: 'vscode' }, '2026-09-25T05:42:08.000Z'),
      codexRow('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '补完网页架构' }] }, '2026-09-25T05:42:10.000Z'),
      item({ type: 'UserMessage', content: [{ type: 'text', text: '补完网页架构' }] }, '2026-09-25T05:42:10.000Z'),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '先看提交。' }], phase: 'commentary' }, '2026-09-25T05:42:15.000Z'),
      item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'git log'], parsed_cmd: [{ type: 'unknown' }] }, '2026-09-25T05:42:20.000Z'),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: '已补完 `site/index.html` 的导航。' }], phase: 'final_answer' }, '2026-09-25T06:01:49.000Z'),
    )
    const turns = turnsOf('codex-rollout', { head: text, tail: text })
    expect(turns.subagent).toBe(false)
    expect(turns.first_ask).toBe('补完网页架构')
    expect(turns.turns).toEqual([
      { k: 'ask', text: '补完网页架构', at: '2026-09-25T05:42:10.000Z' },
      { k: 'reply', text: '先看提交。', at: '2026-09-25T05:42:15.000Z' },
      { k: 'reply', text: '已补完 `site/index.html` 的导航。', at: '2026-09-25T06:01:49.000Z', final: true },
    ])
    const sub = lines(codexRow('session_meta', { id: 'c-2', source: { subagent: { other: 'guardian' } } }, '2026-09-25T05:42:08.000Z'))
    expect(turnsOf('codex-rollout', { head: sub, tail: sub }).subagent).toBe(true)
  })

  it('卡 T 要的三格:从哪开的(entry)、挂在哪条主会话下(parent_id)、末尾挂着没结果的那一步(pending)', () => {
    const text = lines(
      claudeUser('发版前对一遍', '2026-09-25T05:00:00.000Z', { entrypoint: 'claude-desktop' }),
      { type: 'assistant', sessionId: 's-1', timestamp: '2026-09-25T05:01:00.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: '今晚发吗?', header: '发版', options: [{ label: '今晚', description: '都过了' }, { label: '明早' }] }] } }] } },
    )
    const turns = turnsOf('claude-transcript', { head: text, tail: text })
    expect(turns.entry).toBe('claude-desktop')
    expect(turns.parent_id).toBeUndefined()
    expect(turns.pending).toEqual({ kind: 'question', tool: 'AskUserQuestion', at: '2026-09-25T05:01:00.000Z', questions: [{ question: '今晚发吗?', header: '发版', options: [{ label: '今晚', note: '都过了' }, { label: '明早' }] }] })
    // 他又开口了:那一问不再挂着
    const moved = `${text}\n${lines(claudeUser('今晚', '2026-09-25T05:02:00.000Z'))}`
    expect(turnsOf('claude-transcript', { head: moved, tail: moved }).pending).toBeUndefined()
    // Codex:从哪开的是 source 字符串
    const codex = lines(codexRow('session_meta', { id: 'c-1', cwd: '/w', source: 'exec' }, '2026-09-25T05:00:00.000Z'))
    expect(turnsOf('codex-rollout', { head: codex, tail: codex }).entry).toBe('exec')
  })

  it('读文件:第一句要求从头上读,回合从尾上读;文件不在 → undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turns-'))
    try {
      const file = join(dir, 's-1.jsonl')
      const filler = claudeAssistant([{ type: 'text', text: '中间的旁白。'.repeat(200) }], '2026-09-25T06:00:00.000Z', 'tool_use')
      writeFileSync(file, `${lines(
        claudeUser('第一句要求:把截图不切窗做成机制', '2026-09-25T05:00:00.000Z'),
        ...Array.from({ length: 50 }, () => filler),
        claudeAssistant([{ type: 'text', text: '改好了,见 docs/交接.md。' }], '2026-09-25T07:00:00.000Z', 'end_turn'),
      )}\n`)
      const turns = await readSessionTurns({ format: 'claude-transcript', file }, { headBytes: 4096, tailBytes: 4096 })
      expect(turns?.first_ask).toBe('第一句要求:把截图不切窗做成机制')
      expect(turns?.turns.at(-1)).toEqual({ k: 'reply', text: '改好了,见 docs/交接.md。', at: '2026-09-25T07:00:00.000Z', final: true })
      expect(turns?.turns.some(turn => turn.k === 'ask')).toBe(false) // 尾巴那一段里没有他说的
      expect(await readSessionTurns({ format: 'codex-rollout', file: join(dir, 'nope.jsonl') })).toBeUndefined()
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
