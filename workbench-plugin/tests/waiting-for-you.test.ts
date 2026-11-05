/**
 * 「在等你」判断(waitingForYou.ts,2026-09-25 卡 T)。
 *
 * 会话片段照 2026-09-25 真机上的三家记录形状抄(内容换成假的):Claude Code 2.1.280 的 transcript(桌面 App 的 Code 标签)、
 * Codex Desktop 0.155 的 rollout、Kimi 桌面版 wire.jsonl。走一遍卡 P 的 `turnsOf`(统一的会话形状),再交给判断 ——
 * 与生产同一条路。**不调真模型**:问模型那一段用的是假 fetch(见 waiting-service 的用例)。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { turnsOf } from '../src/server/sessionDigest.ts'
import type { PendingStep } from '../src/server/sessionDigest.ts'
import {
  childWaitOf, decide, factsOf, judgeContent, judgeWaiting, lastExchange, loadOf, modelExchangeOf, overlayWaiting, parseWaitModelReply,
  reviewPending, rollUpLoads, speakable, waitMessageKey, waitModelPrompt, withChildWait, type ChildTask, type WaitSignals, type WaitVerdict,
} from '../src/server/waitingForYou.ts'

const lines = (...rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n')

// ───────────── Claude(桌面 App Code 标签的会话记录) ─────────────

const SID = 'd9991aac-0000-4000-8000-000000000001'
const human = (text: string, at: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: SID, cwd: '/Users/example/Documents/GitHub/ben-dsh-workbench', timestamp: at, entrypoint: 'claude-desktop',
  origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra,
})
const said = (text: string, at: string, stop: 'end_turn' | 'tool_use' = 'end_turn', extra: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: SID, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop }, ...extra,
})
const toolUse = (id: string, name: string, input: Record<string, unknown>, at: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', sessionId: SID, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' }, ...extra,
})
const toolResult = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId: SID, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra,
})
const taskNotice = (at: string) => ({
  type: 'user', sessionId: SID, timestamp: at, origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>' },
})

function claude(...rows: unknown[]) {
  const text = lines(...rows)
  return turnsOf('claude-transcript', { head: text, tail: text })
}

/** 统筹 09-25 那一段的形状:三个选项 + 「你选哪个?回个数字就行」,没用弹窗;这一轮说完了(桌面 App 记着 idle)。 */
const COORDINATOR_ASK = [
  '卡 R 已合进 main,0.3.0 装好了,三层自验过了。',
  '',
  '剩下一件要你定:中转每天的额度上限,今天下午已经用掉 8.6 元,照这个速度晚上会撞到 10 元的上限。要不要提?三个选项:',
  '',
  '1. **提到 30 元** —— 调试阶段先别省,发布前再改回来',
  '2. 保持 10 元 —— 撞到了我就停下来等明天',
  '3. 按天看 —— 今天先提到 20,明天再说',
  '',
  '你选哪个?回个数字就行。',
].join('\n')

describe('★卡 T 的六个用例(录好的会话片段,不调模型)', () => {
  it('① 统筹那种「三个选项 + 你选哪个?回个数字就行」→ 在等你(要你选),三个选项', () => {
    const turns = claude(
      human('额度那边你看着办,先把卡 R 合了', '2026-09-25T08:40:00.000Z'),
      said('我先合卡 R。', '2026-09-25T08:40:05.000Z', 'tool_use'),
      toolUse('toolu_1', 'Bash', { command: 'git merge --ff-only feat/hooks-packaged', description: 'Fast-forward main' }, '2026-09-25T08:41:00.000Z'),
      toolResult('toolu_1', '2026-09-25T08:41:02.000Z'),
      said(COORDINATOR_ASK, '2026-09-25T09:02:11.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'done', now: '2026-09-25T09:10:00.000Z', agent_name: 'Claude' })
    expect(verdict.waiting).toBe(true)
    expect(verdict.certainty).toBe('sure')
    expect(verdict.kind).toBe('choose')
    expect(verdict.by).toBe('rules')
    expect(verdict.options?.map(option => option.label)).toEqual(['提到 30 元', '保持 10 元', '按天看'])
    expect(verdict.options?.[0]?.note).toBe('调试阶段先别省,发布前再改回来')
    // 问题是选项前面那一句在问的话,不是「你选哪个」
    expect(verdict.question).toBe('要不要提?')
    // 依据逐字摘那一行
    expect(verdict.quote).toBe('你选哪个?回个数字就行。')
    expect(verdict.since).toBe('2026-09-25T09:02:11.000Z')
  })

  it('② 完成汇报、没有问句 → 不等', () => {
    const turns = claude(
      human('把截图不切窗修掉', '2026-09-25T06:00:00.000Z'),
      said('改好了:截图遮罩一收壳当场藏回去,真切换照旧按 1.5 秒算。插件全量 6973 条绿,壳 326 条断言绿,已推到分支。', '2026-09-25T07:10:00.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'done', now: '2026-09-25T07:20:00.000Z' })
    expect(verdict).toMatchObject({ waiting: false, certainty: 'sure', rule: 'report' })
  })

  it('③「需要你在终端里跑这条命令」→ 在等你(要你去做)', () => {
    const turns = claude(
      human('钩子装不上,你看看', '2026-09-25T06:00:00.000Z'),
      said([
        '查到了:钩子脚本在,只是这台机器的 Claude 设置文件是只读的,我这边改不了。',
        '',
        '需要你在终端里跑这条命令,跑完告诉我一声:',
        '',
        '```',
        'chmod u+w ~/.claude/settings.json',
        '```',
      ].join('\n'), '2026-09-25T06:05:00.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'done', now: '2026-09-25T06:06:00.000Z' })
    expect(verdict.waiting).toBe(true)
    expect(verdict.kind).toBe('do')
    expect(verdict.question).toBe('需要你在终端里跑这条命令,跑完告诉我一声:')
    expect(verdict.quote).toBe('需要你在终端里跑这条命令,跑完告诉我一声:')
    // 代码块里的命令不进问题(不露内部的东西)
    expect(verdict.question).not.toContain('settings.json')
  })

  it('④ 权限弹窗 → 在等你(要你批):Claude 自己记着 waiting + permission prompt,挂着的那一步说清要干什么', () => {
    const turns = claude(
      human('把旧的截图目录清掉', '2026-09-25T06:00:00.000Z'),
      said('我先列一下要清的东西。', '2026-09-25T06:00:03.000Z', 'tool_use'),
      toolUse('toolu_9', 'Bash', { command: '/usr/bin/trash ~/Desktop/旧截图', description: '把旧截图移到废纸篓' }, '2026-09-25T06:00:10.000Z'),
    )
    expect(turns.pending).toMatchObject({ kind: 'tool', tool: 'Bash', verb: 'run', detail: '把旧截图移到废纸篓' })
    const verdict = judgeWaiting(turns, { status: 'waiting', waiting_for: 'permission prompt', status_since: '2026-09-25T06:00:11.000Z', agent_name: 'Claude' })
    expect(verdict).toMatchObject({ waiting: true, kind: 'approve', by: 'form', rule: 'form:permission', since: '2026-09-25T06:00:10.000Z' })
    expect(verdict.question).toBe('Claude 要把旧截图移到废纸篓,等你批准')
    // 卡 AP(2026-10-01):认那个批准弹窗用这一步自己的命令(不进问题、不上 /state,只给替她按键那一路认弹窗)
    expect(turns.pending?.marks).toEqual(['/usr/bin/trash ~/Desktop/旧截图'])
    expect(verdict.marks).toEqual(['/usr/bin/trash ~/Desktop/旧截图'])
    expect(verdict.question).not.toContain('trash')
    // hook 那条路报的 permission_prompt 同样算
    const hooked = judgeWaiting(turns, { status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' })
    expect(hooked).toMatchObject({ waiting: true, kind: 'approve', by: 'form' })
    // 同一步在跑(没在等批)→ 不等
    expect(judgeWaiting(turns, { status: 'running' })).toMatchObject({ waiting: false, rule: 'running' })
  })

  it('⑤ 子代理挂到主会话:子任务的记录认得出挂在谁下面;主会话空闲、子任务在跑 → 主会话在跑;子任务不单算一条', () => {
    // Claude 子任务:<主会话>/subagents/agent-*.jsonl,记录里 sessionId 是主会话、isSidechain 为真
    const sub = claude(
      human('查一下手机端返回手势', '2026-09-25T06:00:00.000Z', { isSidechain: true, agentId: 'a68f55a68df59606d' }),
      said('我先看手机端的路由。', '2026-09-25T06:00:04.000Z', 'tool_use', { isSidechain: true, agentId: 'a68f55a68df59606d' }),
    )
    expect(sub.subagent).toBe(true)
    expect(sub.parent_id).toBe(SID)
    // Codex 子任务:parent_thread_id
    const codexSub = lines({ type: 'session_meta', timestamp: '2026-09-25T06:00:00.000Z', payload: { id: 'c-child', parent_thread_id: 'c-main', source: { subagent: { thread_spawn: { parent_thread_id: 'c-main', depth: 1 } } } } })
    expect(turnsOf('codex-rollout', { head: codexSub, tail: codexSub })).toMatchObject({ subagent: true, parent_id: 'c-main' })

    // 子任务说的话是说给主会话听的:哪怕末尾在问,也不按内容判「在等他」
    const subAsking = claude(said('主会话:这两个方案你选哪个?', '2026-09-25T06:01:00.000Z', 'end_turn', { isSidechain: true }))
    expect(judgeWaiting(subAsking, { status: 'done' })).toMatchObject({ waiting: false, rule: 'subagent' })

    // 分量:在等你 > 在跑 > 空闲;子任务挂在主会话下,不单算一条
    const rolled = rollUpLoads([
      { key: `claude:${SID}`, load: 'idle' },
      { key: 'claude:agent-a68f', parent: `claude:${SID}`, load: 'running' },
      { key: 'claude:agent-b12', parent: `claude:${SID}`, load: 'idle' },
      { key: 'claude:other', load: 'idle' },
      { key: 'claude:orphan', parent: 'claude:gone', load: 'running' },
    ])
    expect([...rolled.keys()]).toEqual([`claude:${SID}`, 'claude:other'])
    expect(rolled.get(`claude:${SID}`)).toEqual({ load: 'running', children: ['claude:agent-a68f', 'claude:agent-b12'] })
    expect(rolled.get('claude:other')?.load).toBe('idle')

    // 叠到会话表上:主会话「这一轮说完了」、子任务在跑 → 在跑
    const view: SessionView = { agent: 'claude', session_id: SID, project: 'x', status: 'done', elapsed_sec: 60, unread: false, updated_at: '2026-09-25T06:00:00.000Z' }
    const [shown] = overlayWaiting([view], new Map(), new Map([[`claude:${SID}`, 'running']]), { nowSec: 1_790_000_000 })
    expect(shown?.status).toBe('running')
  })

  it('⑥ 旧的空闲会话 → 空闲:最后那句话说完超过 12 小时就不算在等;会话已经关了也不算', () => {
    const turns = claude(
      human('帮我看看首页', '2026-09-23T10:00:00.000Z'),
      said('首页两种改法:1 是放大球,2 是收窄卡片。你倾向哪种?', '2026-09-23T10:05:00.000Z'),
    )
    // 当时是在等他的
    expect(judgeWaiting(turns, { status: 'done', now: '2026-09-23T10:06:00.000Z' }).waiting).toBe(true)
    // 两天后还没理:旧的,空闲
    const later = judgeWaiting(turns, { status: 'done', now: '2026-09-25T10:06:00.000Z' })
    expect(later).toMatchObject({ waiting: false, rule: 'stale' })
    expect(loadOf('done', later)).toBe('idle')
    // 已经关了的会话
    expect(judgeWaiting(turns, { status: 'offline', now: '2026-09-23T10:06:00.000Z' })).toMatchObject({ waiting: false, rule: 'offline' })
  })
})

describe('形式上的:弹窗、等批计划、blocked', () => {
  it('Claude 提问弹窗(AskUserQuestion 挂着没结果)→ 要你选,问题与选项原样', () => {
    const turns = claude(
      human('发版前对一遍', '2026-09-25T06:00:00.000Z'),
      toolUse('toolu_q', 'AskUserQuestion', {
        questions: [{
          question: '0.3.0 要不要今晚就发?',
          header: '发版',
          multiSelect: false,
          options: [{ label: '今晚发 (Recommended)', description: '三层自验都过了' }, { label: '明早发', description: '等你睡前再看一眼' }],
        }],
      }, '2026-09-25T06:01:00.000Z'),
    )
    expect(turns.pending?.kind).toBe('question')
    const verdict = judgeWaiting(turns, { status: 'waiting', waiting_for: 'input needed' })
    expect(verdict).toMatchObject({ waiting: true, kind: 'choose', by: 'form', rule: 'form:question', question: '0.3.0 要不要今晚就发?', since: '2026-09-25T06:01:00.000Z' })
    expect(verdict.options).toEqual([{ label: '今晚发 (Recommended)', note: '三层自验都过了' }, { label: '明早发', note: '等你睡前再看一眼' }])
    // 答了(工具结果回来了)就不挂着了
    const answered = claude(
      human('发版前对一遍', '2026-09-25T06:00:00.000Z'),
      toolUse('toolu_q', 'AskUserQuestion', { questions: [{ question: '0.3.0 要不要今晚就发?', options: [] }] }, '2026-09-25T06:01:00.000Z'),
      toolResult('toolu_q', '2026-09-25T06:03:00.000Z'),
    )
    expect(answered.pending).toBeUndefined()
  })

  it('等他批计划(ExitPlanMode)→ 要你批', () => {
    const turns = claude(
      human('先出个计划', '2026-09-25T06:00:00.000Z'),
      toolUse('toolu_p', 'ExitPlanMode', { plan: '## 计划\n1. 先读登记表\n2. 再改界面' }, '2026-09-25T06:02:00.000Z'),
    )
    expect(judgeWaiting(turns, {}, )).toMatchObject({ waiting: true, kind: 'approve', by: 'form', rule: 'form:plan', quote: '计划' })
  })

  it('Codex 提问弹窗(request_user_input 挂着)→ 要你选;回答回来了就不挂', () => {
    const row = (type: string, payload: Record<string, unknown>, at: string) => ({ type, timestamp: at, payload })
    const base = [
      row('session_meta', { id: 'c-1', cwd: '/w', source: 'vscode' }, '2026-09-25T05:00:00.000Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '网页先做哪一屏' }] } }, '2026-09-25T05:00:01.000Z'),
      row('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'call_1', arguments: JSON.stringify({ questions: [{ header: '顺序', id: 'q1', question: '先做首屏还是价格页?', options: [{ label: '首屏', description: '先把第一印象做好' }, { label: '价格页', description: '' }] }] }) }, '2026-09-25T05:00:30.000Z'),
    ]
    const open = lines(...base)
    const turns = turnsOf('codex-rollout', { head: open, tail: open })
    expect(turns.pending).toMatchObject({ kind: 'question', tool: 'request_user_input' })
    const verdict = judgeWaiting(turns, { status: 'done', agent_name: 'Codex' })
    expect(verdict).toMatchObject({ waiting: true, kind: 'choose', by: 'form', question: '先做首屏还是价格页?' })
    expect(verdict.options?.map(option => option.label)).toEqual(['首屏', '价格页'])
    const done = lines(...base, row('response_item', { type: 'function_call_output', call_id: 'call_1', output: '{"answers":["首屏"]}' }, '2026-09-25T05:02:00.000Z'))
    expect(turnsOf('codex-rollout', { head: done, tail: done }).pending).toBeUndefined()
  })

  it('Kimi 的 blocked:记录里有待批/待答的那一条才算在等你;内容里读得出问题就用那一句(2026-09-28 卡 KM 收紧)', () => {
    const wire = lines(
      { type: 'turn.prompt', input: [{ type: 'text', text: '<meta timestamp="2026-09-25 14:00" />帮我改简历' }] },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '改好了两版。你要偏技术的还是偏管理的?' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end', finishReason: 'end_turn' } },
    )
    const turns = turnsOf('kimi-wire', { head: wire, tail: wire })
    const verdict = judgeWaiting(turns, { status: 'waiting', formal_wait: 'question', agent_name: 'Kimi' })
    expect(verdict).toMatchObject({ waiting: true, by: 'form', rule: 'form:blocked', kind: 'choose', question: '你要偏技术的还是偏管理的?' })
    // 读不出内容:说清它是等你批一步操作(证据里写着 approval),不编「弹了个框」
    expect(judgeWaiting({ turns: [] }, { status: 'waiting', formal_wait: 'approval', agent_name: 'Kimi' }))
      .toMatchObject({ waiting: true, kind: 'approve', question: 'Kimi 要你批准一步操作' })
    // **没有证据**(Kimi 这一轮说完也记 blocked):形式上不算在等你,交给内容判断(卡 KM)
    expect(judgeWaiting({ turns: [] }, { status: 'waiting', agent_name: 'Kimi' })).toMatchObject({ waiting: false })
  })

  it('Claude 空闲一分钟就发的 idle_prompt 不算形式上的在等:照内容判', () => {
    const turns = claude(human('跑测试', '2026-09-25T06:00:00.000Z'), said('全绿,已提交。', '2026-09-25T06:10:00.000Z'))
    expect(judgeWaiting(turns, { status: 'waiting', reason: 'idle_prompt', wait_reason: 'input' })).toMatchObject({ waiting: false, rule: 'report' })
  })
})

describe('内容上的:规则', () => {
  const content = (text: string, ask?: string) => judgeContent(text, ask)

  it('要你批:「要不要我顺手…?」「你点头我就合」「待拍板」', () => {
    expect(content('首页改好了。要不要我顺手把手机端也改了?')).toMatchObject({ waiting: true, kind: 'approve', quote: '要不要我顺手把手机端也改了?' })
    expect(content('分支已推。如果你同意,我就合进 main 发 0.3.1。')).toMatchObject({ waiting: true, kind: 'approve' })
    expect(content('交接写好了。\n\n待拍板:悬停亮不亮光。')).toMatchObject({ waiting: true, kind: 'approve' })
    expect(content('Done with the refactor. Should I also update the docs?')).toMatchObject({ waiting: true, kind: 'approve' })
  })

  it('要你去做:登录、授权、给材料;「不需要你…」不算;「如果需要你可以…」拿不准', () => {
    expect(content('Claude 命令行还没登录。麻烦你在电脑上点一下「登录 Claude」,登好了我接着派。')).toMatchObject({ waiting: true, kind: 'do' })
    expect(content('需要你在系统设置里给工作台勾上辅助功能。')).toMatchObject({ waiting: true, kind: 'do' })
    expect(content('Please run `pnpm install` in the repo and tell me when it finishes.')).toMatchObject({ waiting: true, kind: 'do' })
    expect(content('我已经替你跑过了,不需要你在终端里跑任何命令。')).toMatchObject({ waiting: false })
    expect(content('都改好了。如果需要,你可以自己在终端里跑一下看看。')).toMatchObject({ waiting: false, certainty: 'unsure' })
  })

  it('等你审:卡 N 那一条(他要了东西 → 交了 → 没回)与明着叫他看', () => {
    const ask = '给我一个文档...写清楚哪个是标题，我自己先看着看看'
    const answer = '已整理成 参赛网页逐屏文案稿。11 屏按网页顺序排列，每屏都标清了页面标题、正文、要点、示例和折叠说明，方便你逐段看、直接圈改。'
    expect(reviewPending(ask, answer)).toEqual({ what: '参赛网页逐屏文案稿', quote: '已整理成 参赛网页逐屏文案稿' })
    expect(content(answer, ask)).toMatchObject({ waiting: true, kind: 'review', what: '参赛网页逐屏文案稿', question: '参赛网页逐屏文案稿在等你审', quote: '已整理成 参赛网页逐屏文案稿', rule: 'review:delivered' })
    // 他要的不是给他看的东西 → 不算审;「已修好导航」也不是在问他
    expect(reviewPending('把导航修一下', '已修好导航。')).toBeUndefined()
    expect(content('已修好导航。', '把导航修一下')).toMatchObject({ waiting: false, rule: 'report' })
    // 文件名的扩展名不进「那份东西」
    expect(reviewPending('把逐屏文案整理出来给我审', '已整理成『参赛网页逐屏文案稿.md』,在等你审。')?.what).toBe('参赛网页逐屏文案稿')
    // 明着叫他看
    expect(content('手机包装好了,请你打开手机看一下首页的球。')).toMatchObject({ waiting: true, kind: 'review' })
  })

  it('在问你:最后一句是问句;客套的收尾不算', () => {
    expect(content('两个名字都行:「事务官」和「管家」。你更喜欢哪个名字?')).toMatchObject({ waiting: true, kind: 'choose' })
    expect(content('改好了,测试全绿。有问题随时叫我。')).toMatchObject({ waiting: false, rule: 'closer' })
    expect(content('改好了,测试全绿。还有别的需要吗?')).toMatchObject({ waiting: false })
    expect(content('我先去跑全量测试,跑完再汇报。')).toMatchObject({ waiting: false, rule: 'working' })
    // 代码块里的问号不算
    expect(content('加了一行:\n```\nconst ok = a ? b : c\n```\n已提交。')).toMatchObject({ waiting: false })
  })

  it('A 还是 B?/ 回个数字 → 要你选;选项认「1. 2.」「A. B.」「方案一 / 方案二」', () => {
    expect(content('先修手机还是先修电脑?')).toMatchObject({ waiting: true, kind: 'choose' })
    const lettered = content('两条路:\nA. 今晚发\nB. 明早发\n回个字母就行。')
    expect(lettered).toMatchObject({ waiting: true, kind: 'choose' })
    expect(lettered.options?.map(option => option.label)).toEqual(['今晚发', '明早发'])
    const named = content('方案一:只改电脑\n方案二:电脑手机一起改\n你选哪个?')
    expect(named.options?.map(option => option.label)).toEqual(['只改电脑', '电脑手机一起改'])
    // 汇报里的编号清单不是选项
    expect(content('做了三件事:\n1. 改了登记表\n2. 补了用例\n3. 写了交接\n都推到分支了。')).toMatchObject({ waiting: false })
  })

  it('引号里的字不算在叫他:界面上那一格的名字(「等你确认」)、转述他的话(「先别合」)', () => {
    expect(content('来电我按规矩没有接,点了「稍后」,再到「等你确认」里点 B。')).toMatchObject({ waiting: false, certainty: 'sure' })
    expect(content('你之前说「要不要先别合」,我就没合。都推到分支了。')).toMatchObject({ waiting: false })
  })

  it('拿不准的:末尾夹着问句 / 「建议下一步」→ unsure(交给模型),不硬判', () => {
    expect(content('这样行不行呢,我也拿不准。先按这个版本合了,测试全绿。')).toMatchObject({ waiting: false, certainty: 'unsure' })
    expect(content('都改好了。建议下一步把手机端也接上。')).toMatchObject({ waiting: false, certainty: 'unsure' })
  })
})

describe('最后一来一回', () => {
  it('最后一句是他说的:球在那家,不等', () => {
    const turns = claude(said('你选哪个?', '2026-09-25T06:00:00.000Z'), human('2', '2026-09-25T06:01:00.000Z'))
    expect(judgeWaiting(turns, { status: 'done' })).toMatchObject({ waiting: false, rule: 'his-turn' })
  })

  it('子任务回报之后它又说的那段才是最后的话(同一轮里隔了几小时的两段最终回答不并)', () => {
    const turns = claude(
      human('三张卡都派出去', '2026-09-25T04:35:00.000Z'),
      said('派出去了,等它们回来。要不要我顺便把交接也写了?', '2026-09-25T04:35:30.000Z'),
      taskNotice('2026-09-25T08:19:00.000Z'),
      said('卡 P 回来了:全绿,已推分支。', '2026-09-25T08:19:36.000Z'),
    )
    const exchange = lastExchange(turns.turns)
    expect(exchange.answer?.text).toBe('卡 P 回来了:全绿,已推分支。')
    expect(judgeWaiting(turns, { status: 'done' })).toMatchObject({ waiting: false, rule: 'report' })
  })

  it('一条消息被记成好几段(同一分钟里都是最终回答):并起来看', () => {
    const turns = claude(
      human('额度怎么办', '2026-09-25T06:00:00.000Z'),
      said('三个选项:\n1. 提到 30\n2. 保持 10', '2026-09-25T06:00:10.000Z'),
      said('你选哪个?', '2026-09-25T06:00:11.000Z'),
    )
    const verdict = judgeWaiting(turns, { status: 'done' })
    expect(verdict).toMatchObject({ waiting: true, kind: 'choose' })
    expect(verdict.options).toHaveLength(2)
  })

  it('事实只算一次:之后跟着状态变(在跑 → 不等;说完了 → 在等你)', () => {
    const facts = factsOf(claude(human('额度怎么办', '2026-09-25T06:00:00.000Z'), said(COORDINATOR_ASK, '2026-09-25T06:01:00.000Z')))
    expect(decide(facts, { status: 'running' }).waiting).toBe(false)
    expect(decide(facts, { status: 'done' }).waiting).toBe(true)
    expect(decide(facts, { status: 'error' }).waiting).toBe(false)
  })
})

describe('叠到会话表上', () => {
  const view = (patch: Partial<SessionView>): SessionView => ({ agent: 'claude', session_id: 's1', project: 'p', status: 'done', elapsed_sec: 30, unread: true, updated_at: '2026-09-25T06:00:00.000Z', ...patch })
  const waiting: WaitVerdict = { waiting: true, certainty: 'sure', kind: 'choose', question: '要不要提?', options: [{ label: '提到 30 元' }], since: '2026-09-25T06:00:00.000Z', quote: '你选**哪个**?', by: 'rules', rule: 'choose:options' }

  /**
   * ★★**改过口径的一条**(2026-09-26,卡 V 补;维护者:「现在应该是 3 完成 1 进行中」)。
   *
   * 这一条原来断言的是:**按内容判出来的也把 `status` 改成 `waiting`**。09-26 真机上那就是错的 ——
   * 「修 profile 补丁里 cookie 那一行的 id 写错」这条**已经说完了**(会话文件最后一条是最终回答,
   * pid 文件也说 `idle`),只因为最后那段话里顺口问了他一句,就从蓝点那一档挪进了橙点那一档,
   * 于是 Claude 标签上是「1 白 + 1 橙」,而实情是一条在跑、三条做完。
   *
   * 现在**按内容判的只挂 `ask`,运行状态原样**:两件事分开 ——
   * 「在跑 / 说完了」是会话文件与进程表说的事实,「有一问在等你」是这里读出来的内容。
   * 那一问一个都没少:`ask` 照旧进 `src/waiting.ts` 的 `waitingOnHim`(「事务官」标签的琥珀气泡、
   * 球下「等你 n」、手机「等你确认」)。**形式上真卡住的(`by: 'form'`)照旧改状态** —— 见下一条。
   */
  it('★★按内容判出来的(by: rules)只挂 ask,运行状态原样 —— 说完了就还是说完了', () => {
    const nowSec = Math.floor(Date.parse('2026-09-25T06:05:00.000Z') / 1000)
    const [shown] = overlayWaiting([view({})], new Map([['claude:s1', waiting]]), new Map(), { nowSec, replyOf: () => ({ reply: 'desk', where: '这一问得在电脑上的 Claude 里回答' }) })
    expect(shown).toMatchObject({ status: 'done', elapsed_sec: 30 })
    expect(shown?.wait_reason).toBeUndefined()
    expect(shown?.ask).toEqual({ kind: 'choose', question: '要不要提?', options: [{ label: '提到 30 元' }], since: '2026-09-25T06:00:00.000Z', quote: '你选哪个?', by: 'rules', reply: 'desk', where: '这一问得在电脑上的 Claude 里回答' })
  })

  it('形式上真卡住的(by: form —— 弹窗 / 等他批计划)照旧 waiting + ask,并按那一问的时刻重算时长', () => {
    const nowSec = Math.floor(Date.parse('2026-09-25T06:05:00.000Z') / 1000)
    const form: WaitVerdict = { ...waiting, by: 'form', rule: 'form:question' }
    const [shown] = overlayWaiting([view({})], new Map([['claude:s1', form]]), new Map(), { nowSec })
    expect(shown).toMatchObject({ status: 'waiting', reason: 'idle_prompt', wait_reason: 'input', elapsed_sec: 300 })
    expect(shown?.ask?.kind).toBe('choose')
  })

  it('那家报 idle_prompt 而判断说没在等 → 按空闲摆;事务官自己的会话不碰', () => {
    const idle = view({ status: 'waiting', reason: 'idle_prompt', wait_reason: 'input' })
    const [shown] = overlayWaiting([idle], new Map([['claude:s1', { waiting: false, certainty: 'sure', by: 'rules', rule: 'report' } as WaitVerdict]]))
    expect(shown?.status).toBe('done')
    expect(shown?.wait_reason).toBeUndefined()
    const dsh = view({ agent: 'dsh' })
    expect(overlayWaiting([dsh], new Map([['dsh:s1', waiting]]))[0]).toBe(dsh)
  })
})

describe('★子任务在等他 → 冒到主会话上(设计第六节:一张卡多一层)', () => {
  const bash: PendingStep = { kind: 'tool', tool: 'Bash', verb: 'run', detail: 'Run the script', at: '2026-09-25T06:02:00.000Z' }
  const asking: PendingStep = { kind: 'question', tool: 'AskUserQuestion', at: '2026-09-25T06:03:00.000Z', questions: [{ question: '测试要不要连真模型?', options: [{ label: '不连' }, { label: '连一次' }] }] }
  const permission: WaitSignals = { status: 'waiting', waiting_for: 'permission prompt', agent_name: 'Claude' }

  it('子任务明着在问(提问弹窗):冒上来、带是哪个子任务;主会话自己没在等也算', () => {
    const children: ChildTask[] = [{ id: 'agent-a1', title: '整理测试', status: 'running' }, { id: 'agent-q1', title: '核对额度', status: 'running', pending: asking }]
    const child = childWaitOf(children, {})
    expect(child).toMatchObject({ waiting: true, kind: 'choose', question: '测试要不要连真模型?', by: 'form', rule: 'form:question', child: { id: 'agent-q1', title: '核对额度' } })
    expect(withChildWait(decide({ hisTurn: false }, { status: 'running' }), {}, child)).toBe(child)
  })

  it('主会话停在权限弹窗上、它挂着的是「派助手」:那是子任务要的权限 —— 说清哪个子任务;主会话自己挂着命令就用它自己的', () => {
    const children: ChildTask[] = [{ id: 'agent-a1', title: '整理测试', status: 'running', pending: bash }, { id: 'agent-b2', status: 'done' }]
    const child = childWaitOf(children, permission)
    expect(child).toMatchObject({ waiting: true, kind: 'approve', question: '它要跑一条命令,等你批准', rule: 'form:permission', child: { id: 'agent-a1', title: '整理测试' } })
    const task: PendingStep = { kind: 'tool', tool: 'Task', verb: 'agent' }
    expect(withChildWait(decide({ hisTurn: false, pending: task }, permission), { pending: task }, child)).toBe(child)
    const own = decide({ hisTurn: false, pending: bash }, permission)
    expect(withChildWait(own, { pending: bash }, child)).toBe(own)
    // 没有权限弹窗:子任务挂着一条命令只是在跑,不算在等他
    expect(childWaitOf(children, { status: 'running' })).toBeUndefined()
  })

  it('children 里只写着「等你」、说不出等什么:照实说它停下来等你确认,不编问题;叠到会话上带 child,答了往哪送按子任务算', () => {
    const child = childWaitOf([{ id: 'x1', title: '改手机端', status: 'waiting', updated_at: '2026-09-25T06:04:00.000Z' }], {})
    expect(child).toMatchObject({ waiting: true, kind: 'approve', question: '它停下来等你确认', since: '2026-09-25T06:04:00.000Z', rule: 'form:blocked', child: { id: 'x1', title: '改手机端' } })
    const nowSec = Math.floor(Date.parse('2026-09-25T06:05:00.000Z') / 1000)
    const main: SessionView = { agent: 'codex', session_id: 'c1', project: 'p', status: 'running', elapsed_sec: 30, unread: false, updated_at: '2026-09-25T06:00:00.000Z' }
    const [shown] = overlayWaiting([main], new Map([['codex:c1', child!]]), new Map(), {
      nowSec,
      replyOf: (_view, ask) => (ask.child === undefined ? { reply: 'window' } : { reply: 'desk', where: '这一问得在电脑上的 Codex 里回答(它那边弹了个框等你点)' }),
    })
    expect(shown).toMatchObject({ status: 'waiting', wait_reason: 'approval' })
    expect(shown?.ask).toMatchObject({ child: { id: 'x1', title: '改手机端' }, reply: 'desk' })
  })
})

describe('拿不准时问一次模型:提示词与核对(不调真模型)', () => {
  const turns = claude(human('看看这版', '2026-09-25T06:00:00.000Z'), said('这样行不行呢,我也拿不准。先按这个版本合了。', '2026-09-25T06:01:00.000Z'))
  const exchange = modelExchangeOf(turns)!

  it('送去的只有最后一来一回;同一段话同一个键', () => {
    expect(exchange).toEqual({ ask: '看看这版', answer: '这样行不行呢,我也拿不准。先按这个版本合了。', at: '2026-09-25T06:01:00.000Z' })
    expect(waitMessageKey(exchange)).toBe(waitMessageKey({ ...exchange }))
    expect(waitMessageKey(exchange)).not.toBe(waitMessageKey({ ...exchange, answer: `${exchange.answer}!` }))
    const prompt = waitModelPrompt(exchange, 'Claude')
    expect(prompt.user).toContain(exchange.answer)
    expect(prompt.user).toContain('"waiting"')
  })

  it('依据逐字核过才算;核不上整条不算;模型说不等就不等', () => {
    expect(parseWaitModelReply({ waiting: true, kind: 'approve', question: '这版能不能合', options: [], quote: '这样行不行呢' }, exchange))
      .toMatchObject({ waiting: true, kind: 'approve', by: 'model', quote: '这样行不行呢', since: '2026-09-25T06:01:00.000Z' })
    expect(parseWaitModelReply({ waiting: true, kind: 'approve', question: 'x', options: [], quote: '你同意合进去吗' }, exchange)).toBeUndefined()
    expect(parseWaitModelReply({ waiting: true, kind: 'nonsense', quote: '这样行不行呢' }, exchange)).toBeUndefined()
    expect(parseWaitModelReply({ waiting: false }, exchange)).toMatchObject({ waiting: false, by: 'model' })
    // 选项只留原话里真有的
    const withOptions = parseWaitModelReply({ waiting: true, kind: 'choose', question: '选哪版', options: ['这个版本', '上个版本'], quote: '先按这个版本合了' }, exchange)
    expect(withOptions?.options).toEqual([{ label: '这个版本' }])
  })
})

describe('一句人话', () => {
  // 2026-09-28(卡 RC):路径从"删成空"改成**可读的占位**(末段目录名)——
  // 删成空会把句子挖空(「落在哪(她的工作目录还是 )」),严格脱敏只用在诊断上报那一路。
  it('去掉记号、文件名;路径换成可读的占位;问号留着', () => {
    expect(speakable('要不要把 **docs/交接.md** 也改了?')).toBe('要不要把「交接.md」也改了?')
    expect(speakable('今晚/明早都行,你定?')).toBe('今晚/明早都行,你定?')
    expect(speakable('0.3.0 要不要今晚就发?')).toBe('0.3.0 要不要今晚就发?')
    expect(speakable('打开 /Users/example/Desktop 看一下?')).toBe('打开「Desktop」看一下?')
    expect(speakable('`a.ts`')).toBeUndefined()
  })
})
