// @vitest-environment node
/**
 * 进度靠证据 —— 纯函数那一半(2026-09-25,卡 N,`server/progressEvidence.ts`)。
 *
 * 样本是维护者真会话里的原样几句(Codex「制作参赛网页」最后一轮、「补完参赛网页架构」交回来的话),
 * 看板是他那份真看板的形状(引导落地排的十张卡 + 冲刺「Spotlight 参赛 · 10-04」两个模块)。
 */
import { describe, expect, it } from 'vitest'
import { PROGRESS_NONE_LINE } from '../src/protocol.ts'
import type { EvalCard, EvidenceItem, RawJudgement } from '../src/server/progressEvidence.ts'
import {
  buildJudgePrompt, JUDGE_SYSTEM, cardSubject, cleanRequest, coverage, decisionSections, dispatchMarkerIn, dispatchMarkerOf, docSummary, evidenceTurns, isTestAsk,
  isTestSession, judgementsFromModel, namedSessionsIn, numbersBacked, parseJudgeReply, pendingForHim, pickCandidates, progressView, proposalsFrom, quoteFound,
  briefSource, mergeClaimsBacked, peopleText, promptAt, releaseRows, rulesJudge, salvageJudgeItems, sameThing, saysAnotherCard, scoreEvidence, sessionEvidenceText, shortAt, shownQuote,
  titleParts, verifyJudgement,
} from '../src/server/progressEvidence.ts'
import { turnsOf } from '../src/server/sessionDigest.ts'

const CONTEXT = ['工作台', 'desktop-workbench', 'Spotlight 参赛 · 10-04', '参赛材料']
const parseJudgeReplyForTest = (value: unknown): RawJudgement[] => parseJudgeReply(value) ?? []

function card(title: string, extra: Partial<EvalCard> = {}): EvalCard {
  return { id: `t-${title.length}${title.charCodeAt(0)}`, title, status: 'todo', context: CONTEXT, sessionIds: [], namedSessions: [], ...extra }
}

const LAST_ANSWER = '已整理成 [参赛网页逐屏文案稿](/Users/example/Documents/GitHub/desktop-workbench/.worktrees/feat-site/docs/文案-参赛网页逐屏审稿-2026-09-24.md)。11 屏按网页顺序排列，每屏都标清了**页面标题、正文、要点、示例和折叠说明**，方便你逐段看、直接圈改。\n\n文案按当前网页照录；这次没有改网页。文档已推送到 `feat/site`。'
const RETURNED = '已接着原有11屏补完导航、异常回退和构建校验，并修复字体重复下载。\n还差文案定稿、真实界面素材和下载地址；手机真机尚未验收，视频未动。'

function codexLine(type: string, payload: Record<string, unknown>, at = '2026-09-24T12:17:00.167Z'): string {
  return JSON.stringify({ timestamp: at, type, payload })
}

const SITE_SESSION: EvidenceItem = {
  id: 'session:codex:01a0ccd1',
  kind: 'session',
  source: 'Codex 里「制作参赛网页」那段对话',
  ref: '/Users/example/.codex/sessions/2026/09/23/rollout-2026-09-23T13-51-08-01a0ccd1-5e62-7eb2-a0af-224d9d844cfd.jsonl',
  at: '2026-09-24T12:17:00.150Z',
  title: '制作参赛网页',
  text: `他说:「给我一个文档...写清楚哪个是标题，我自己先看着看看」\nCodex 答:「已整理成 参赛网页逐屏文案稿。11 屏按网页顺序排列，每屏都标清了页面标题、正文、要点、示例和折叠说明，方便你逐段看、直接圈改。」`,
  lastBy: 'agent',
  project: 'desktop-workbench',
}

/** 一段会话记录走卡 P 那一份读法(`turnsOf`,会话读法全仓一份),再排成证据要的回合。 */
function codexOf(lines: readonly string[]) {
  const text = lines.join('\n')
  const raw = turnsOf('codex-rollout', { head: text, tail: text })
  return { raw, turns: evidenceTurns(raw.turns) }
}
function claudeOf(lines: readonly string[]) {
  const text = lines.join('\n')
  const raw = turnsOf('claude-transcript', { head: text, tail: text })
  return { raw, turns: evidenceTurns(raw.turns) }
}

describe('读 Codex 会话(卡 P 的读法):只留他说的与每一轮的最终回答', () => {
  it('新格式(item_completed):他打的字干净,回答取 final_answer,中间的过程不要', () => {
    const lines = [
      codexLine('session_meta', { id: '01a0ccd1', cwd: '/Users/example/Documents/GitHub/desktop-workbench', source: 'vscode' }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '给我一个文档...写清楚哪个是标题，我自己先看着看看\n' }] } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '我会在仓库里做一份 Markdown 文案稿' }] } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['git', 'status'] } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: LAST_ANSWER }] } }),
      // 同一句在老格式里又写了一遍:新格式在就不用它。
      codexLine('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: LAST_ANSWER }] }),
      codexLine('event_msg', { type: 'task_complete', last_agent_message: LAST_ANSWER }),
    ]
    const { raw, turns } = codexOf(lines)
    const parsed = { cwd: raw.cwd, turns }
    expect(parsed.cwd).toBe('/Users/example/Documents/GitHub/desktop-workbench')
    expect(parsed.turns.map(turn => turn.role)).toEqual(['him', 'agent'])
    expect(parsed.turns[0]?.text).toBe('给我一个文档...写清楚哪个是标题，我自己先看着看看')
    // markdown 记号与链接地址去掉,字留着。
    expect(parsed.turns[1]?.text).toContain('已整理成 参赛网页逐屏文案稿。11 屏按网页顺序排列')
    expect(parsed.turns[1]?.text).not.toContain('**')
    expect(parsed.turns[1]?.text).not.toContain('/Users/example')
  })

  it('老格式:他那句夹着 App 注入的浏览器块与文件清单,只留「My request」后面的字', () => {
    const raw = '<in-app-browser-context source="ambient-ui-state">\n# In app browser: ...\n</in-app-browser-context>\n# Files mentioned by the user:\n## a.png: /tmp/a.png\n## My request:\n不错，两翼再长一点'
    expect(cleanRequest(raw)).toBe('不错，两翼再长一点')
    const lines = [
      codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] }),
      codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: raw }] }),
      codexLine('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '拉长了。' }] }),
    ]
    expect(codexOf(lines).turns).toEqual([
      { role: 'him', text: '不错，两翼再长一点', at: '2026-09-24T12:17:00.167Z' },
      { role: 'agent', text: '拉长了。', at: '2026-09-24T12:17:00.167Z' },
    ])
  })

  it('子代理 / 自动审查开的那几条认得出(它们不是他的会话)', () => {
    const sub = codexOf([codexLine('session_meta', { id: 'x', cwd: '/r', source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: 'p' })])
    expect(sub.raw.subagent).toBe(true)
    const own = codexOf([codexLine('session_meta', { id: 'y', cwd: '/r', source: 'vscode', thread_source: 'user' })])
    expect(own.raw.subagent).toBe(false)
  })

  it('这一轮还没说完(或老格式没标最终回答):留这一轮最后那一句;说完了只留最终回答', () => {
    const lines = [
      codexLine('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '把导航修一下' }] } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '我先看一下导航那段' }] } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '在改翻页脚本' }] } }),
    ]
    expect(codexOf(lines).turns.map(turn => [turn.role, turn.text])).toEqual([['him', '把导航修一下'], ['agent', '在改翻页脚本']])
  })

  it('最后一来一回是「他要了东西自己先看 → 那家交了 → 他没回话」:认出来,球在他那儿', () => {
    const turns = [
      { role: 'him' as const, text: '给我一个文档...写清楚哪个是标题，我自己先看着看看' },
      { role: 'agent' as const, text: '已整理成 参赛网页逐屏文案稿。11 屏按网页顺序排列，每屏都标清了页面标题、正文、要点、示例和折叠说明，方便你逐段看、直接圈改。' },
    ]
    expect(pendingForHim(turns)).toEqual({ what: '参赛网页逐屏文案稿在等你审', quote: '已整理成 参赛网页逐屏文案稿' })
    // 他后来又说了话 / 他要的不是给他看的东西 → 不算。
    expect(pendingForHim([...turns, { role: 'him', text: '标题改一下' }])).toBeUndefined()
    expect(pendingForHim([{ role: 'him', text: '把导航修一下' }, { role: 'agent', text: '已修好导航。' }])).toBeUndefined()
  })

  it('派活记号认得出是哪张卡派出去的;测试留下的会话认得出', () => {
    const turns = [{ role: 'him' as const, text: '【工作台派活 371c3b】接着「制作参赛网页」那条会话的工作' }]
    expect(dispatchMarkerOf(turns)).toBe('371c3b')
    // 卡 P 的读法单给「第一句原文」(大文件的尾巴里读不到第一句):直接看它。
    expect(dispatchMarkerIn('【工作台派活 371c3b】接着…')).toBe('371c3b')
    expect(dispatchMarkerIn(undefined)).toBeUndefined()
    expect(isTestSession([{ role: 'him', text: '【工作台派活 32be89】[派活测试] 让 Codex 用一句话回答' }])).toBe(true)
    expect(isTestAsk('【工作台派活 32be89】[派活测试] 让 Codex 用一句话回答')).toBe(true)
    expect(isTestSession(turns)).toBe(false)
  })

  it('一条证据的正文:最后几轮,最后一轮给得长,记下最后一句是谁说的', () => {
    const body = sessionEvidenceText([
      { role: 'him', text: '好了，你把纯文字稿给我一下', at: '2026-09-24T12:11:27Z' },
      { role: 'agent', text: '以下是当前网页的纯文字稿……'.repeat(40), at: '2026-09-24T12:12:50Z' },
      { role: 'him', text: '给我一个文档...写清楚哪个是标题，我自己先看着看看', at: '2026-09-24T12:13:01Z' },
      { role: 'agent', text: '已整理成 参赛网页逐屏文案稿。', at: '2026-09-24T12:17:00Z' },
    ], 'Codex')
    expect(body.lastBy).toBe('agent')
    expect(body.at).toBe('2026-09-24T12:17:00Z')
    expect(body.text.endsWith('Codex 答:「已整理成 参赛网页逐屏文案稿。」')).toBe(true)
  })
})

describe('读 Claude 会话(卡 P 的读法)', () => {
  it('他说的 + 每一轮说完的那一句;工具结果、系统提醒、子代理那几行不要;标题取 custom-title', () => {
    const lines = [
      JSON.stringify({ type: 'user', isSidechain: false, cwd: '/Users/example/Documents/GitHub/ben-dsh-workbench', sessionId: 's1', timestamp: '2026-09-25T01:00:00Z', message: { role: 'user', content: '你是 desktop-workbench 的统筹。先读 /Users/example/Documents/GitHub/desktop-workbench/AGENTS.md' } }),
      JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-25T01:00:05Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '我先看看' }, { type: 'tool_use', name: 'Bash' }] } }),
      JSON.stringify({ type: 'user', isSidechain: false, timestamp: '2026-09-25T01:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'user', isSidechain: true, timestamp: '2026-09-25T01:00:07Z', message: { role: 'user', content: '子代理的活' } }),
      JSON.stringify({ type: 'user', isSidechain: false, timestamp: '2026-09-25T01:00:08Z', message: { role: 'user', content: '<system-reminder>别管</system-reminder>' } }),
      JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-25T01:01:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '0.2.98 装好了,五家真系统派活通。' }] } }),
      JSON.stringify({ type: 'custom-title', customTitle: '统筹 0925' }),
    ]
    const { raw, turns } = claudeOf(lines)
    const parsed = { title: raw.title, cwd: raw.cwd, turns }
    expect(raw.subagent).toBe(false)
    expect(raw.first_ask?.startsWith('你是 desktop-workbench 的统筹')).toBe(true)
    expect(parsed.title).toBe('统筹 0925')
    expect(parsed.cwd).toBe('/Users/example/Documents/GitHub/ben-dsh-workbench')
    expect(parsed.turns.map(turn => turn.role)).toEqual(['him', 'agent'])
    expect(parsed.turns[0]?.text.startsWith('你是 desktop-workbench 的统筹')).toBe(true)
    expect(parsed.turns[1]?.text).toBe('0.2.98 装好了,五家真系统派活通。')
  })
})

describe('读仓库:发版记录、文档、决策记录', () => {
  it('发版记录一版一行;日期补上年份', () => {
    const md = [
      '| 版本 | 日期 | 你会看到什么 | 交接 |',
      '|---|---|---|---|',
      '| 0.2.98 | 09-25 | 派活回答再干净一层:剥掉 Codex 答完那几秒给读屏挂的字 | `docs/交接-0925-远程派活六家.md` 〇·补3 |',
      '| 0.2.87 | 09-24 | ① 远程派活六家:Codex、Claude、Kimi、Muse、Manus、豆包都能派、结果收回到卡上 | `docs/交接-0925-远程派活六家.md` |',
    ].join('\n')
    const rows = releaseRows(md, new Date('2026-09-25T15:00:00+08:00'))
    expect(rows.map(row => [row.version, row.date])).toEqual([['0.2.98', '2026-09-25'], ['0.2.87', '2026-09-24']])
    expect(rows[1]?.text).toContain('远程派活六家')
    expect(rows[0]?.handoff).toContain('交接-0925-远程派活六家.md')
  })

  it('文档摘要优先「一句话」那一节;决策记录按日期切节', () => {
    const doc = ['# 交接 2026-09-25:手机远程派活 —— 六家都能派', '', '分支 `feat/x`', '', '## 〇、一句话', '', '**六家都派得出去、结果都收得回来**(证据在第三节)。', '', '## 一、盘点'].join('\n')
    const summary = docSummary(doc)
    expect(summary.title).toBe('交接 2026-09-25:手机远程派活 —— 六家都能派')
    expect(summary.text).toBe('六家都派得出去、结果都收得回来(证据在第三节)。')
    // 只留第一句:写下那一刻的附注几个小时后就过时了(「但真系统里现在装的还是旧版」)。
    const stale = docSummary(['# 交接', '## 〇、一句话', '六家都派得出去。但真系统里现在装的还是旧版:要统筹装一次。'].join('\n'))
    expect(stale.text).toBe('六家都派得出去。')
    const sections = decisionSections(['# 决策记录', '## 2026-09-24 · 引导落地', '他点「就这样」才落。', '## 2026-09-25 · 手机远程派活六家', '派活由工作台直接跑。'].join('\n'))
    expect(sections.map(one => [one.date, one.heading])).toEqual([['2026-09-24', '引导落地'], ['2026-09-25', '手机远程派活六家']])
  })

  it('只有日子的时刻只写日子,不补编出来的钟点;给人看的写「9月25日」,问模型的写「09-25」(和「现在是 2026-09-25 15:10」同一种)', () => {
    expect(shortAt('2026-09-25')).toBe('9月25日')
    expect(promptAt('2026-09-25')).toBe('09-25')
    expect(shortAt('2026-09-24T12:17:00Z')).toMatch(/^\d+月\d+日 \d{2}:17$/)
    expect(promptAt('2026-09-24T12:17:00Z')).toMatch(/^\d{2}-\d{2} \d{2}:17$/)
    expect(shortAt('不是时刻')).toBe('')
  })
})

describe('比对:这条证据说的是不是这件事', () => {
  it('项目 / 冲刺 / 模块里人人都有的字不算数(「参赛」),动作词不算数(「收尾」)', () => {
    const subject = cardSubject('参赛网页架构收尾', CONTEXT)
    expect(coverage(subject, '制作参赛网页')).toBeCloseTo(0.5)
    expect(coverage(subject, '补完参赛网页架构')).toBe(1)
    expect(coverage(cardSubject('注册域名', CONTEXT), '能直接部署到 GitHub Pages')).toBe(0)
  })

  it('「A / B」拆开各比各的:只讲额度的发版记录也配「额度显示 / 会话读取」', () => {
    expect(titleParts('额度显示 / 会话读取')).toEqual(['额度显示 / 会话读取', '额度显示', '会话读取'])
    const score = scoreEvidence(card('额度显示 / 会话读取'), { id: 'r', kind: 'release', source: '更新说明 0.2.85', text: '额度只列有额度的家;球下「额度还差一步」卡' })
    expect(score).toBeGreaterThanOrEqual(0.45)
  })

  it('同义说法换成同一个字:派单 = 派活', () => {
    const score = scoreEvidence(card('手机远程派单 + 汇报 / 进度评估准确'), { id: 'h', kind: 'handoff', source: '交接', text: '手机远程派活 —— 六家都能派、都能把结果收回来' })
    expect(score).toBe(1)
  })

  it('卡上交代里点名的会话(「接着『制作参赛网页』那条会话」)认出来', () => {
    expect(namedSessionsIn(['接着「制作参赛网页」那条会话的工作:把参赛网页架构剩下的补完'])).toEqual(['制作参赛网页'])
  })

  it('挑证据:直连的在前(派活记号 / 卡上 links / 点名的会话,新的在前),字面够的补上,别的项目的不配', () => {
    const site = card('参赛网页架构收尾', { id: 't-371c3ba9', status: 'done', sessionIds: ['01a0d715'], namedSessions: ['制作参赛网页'], project_id: 'desktop-workbench' })
    const domain = card('注册域名', { id: 't-domain', project_id: 'desktop-workbench' })
    const returned: EvidenceItem = { id: 'session:codex:01a0d715', kind: 'session', source: 'Codex · 补完参赛网页架构', ref: '/x/rollout-2026-09-25T13-42-08-01a0d715-d804.jsonl', at: '2026-09-25T06:01:49Z', title: '补完参赛网页架构', text: `Codex 答:「${RETURNED}」`, project: 'desktop-workbench' }
    const lapis: EvidenceItem = { id: 'commit:echo1', kind: 'commit', source: '提交 echo1', text: '参赛网页的截图', project: 'echo' }
    const picked = pickCandidates([site, domain], [SITE_SESSION, returned, lapis])
    expect(picked.get('t-371c3ba9')?.map(one => [one.ev.id, one.strong])).toEqual([
      ['session:codex:01a0d715', true],
      ['session:codex:01a0ccd1', true],
    ])
    expect(picked.get('t-domain')).toEqual([])
  })
})

describe('判:模型的每一句都逐字核过', () => {
  const site = card('参赛网页架构收尾', { id: 't-site', status: 'done' })
  const keys = new Map([['E1', SITE_SESSION]])

  it('摘录逐字在原文里 → 留;「现在到哪」里的数字在摘录里出现过 → 用模型那一句', () => {
    const raw: RawJudgement = {
      id: 'T1', found: true, now: '11 屏已做完,逐屏文案稿在等你审', waiting_on: 'me',
      basis: [{ e: 'E1', quote: '11 屏按网页顺序排列，每屏都标清了页面标题' }, { e: 'E1', quote: '方便你逐段看、直接圈改' }],
      next: [{ title: '审逐屏文案稿', owner: 'me', e: 'E1', quote: '方便你逐段看、直接圈改' }],
    }
    // 那条会话挂在这张卡上(直连):摘录不必再含标题里的字。
    const judged = verifyJudgement(raw, site, keys, new Set([SITE_SESSION.id]))
    expect(judged.state).toBe('found')
    expect(judged.line).toBe('11 屏已做完,逐屏文案稿在等你审')
    expect(judged.waiting_on).toBe('me')
    expect(judged.basis.map(b => b.ev.ref)).toEqual([SITE_SESSION.ref, SITE_SESSION.ref])
    expect(judged.next.map(n => [n.title, n.owner])).toEqual([['审逐屏文案稿', 'me']])
  })

  it('编出来的摘录核不上 → 丢掉;一条都没核上 → 「还没看到进展,要你说一句」(不管它说自己找没找到)', () => {
    const raw: RawJudgement = { id: 'T1', found: true, now: '域名已经注册好了', basis: [{ e: 'E1', quote: '域名已经注册好了,指向 GitHub Pages' }], next: [] }
    const judged = verifyJudgement(raw, card('注册域名', { id: 't-domain' }), keys)
    expect(judged.state).toBe('none')
    expect(judged.line).toBe(PROGRESS_NONE_LINE)
    expect(judged.basis).toEqual([])
  })

  it('真实但不相干的一句(不直连、摘录里没有这件事的字)不算依据 —— 核得上原文也不算', () => {
    const quota = card('额度显示 / 会话读取', { id: 't-quota' })
    const other: EvidenceItem = { id: 'claude:x', kind: 'session', source: 'Claude · 统筹', text: 'Claude 答:「O | 改了 14 个文件,还没提交 | 16:30」' }
    const judged = verifyJudgement({ id: 'T1', found: true, now: '额度显示还没提交', basis: [{ e: 'E1', quote: '改了 14 个文件,还没提交' }], next: [] }, quota, new Map([['E1', other]]))
    expect(judged.state).toBe('none')
    // 只沾一个词不算(按截比:「额度显示」这一截算数的字只有四个,要差不多原样出现)。
    const release: EvidenceItem = { id: 'release:0.2.85', kind: 'release', source: '更新说明 0.2.85', text: '① 额度只列有额度的家(微信、企业微信不再算「接上」);额度显示改成按钱算' }
    const loose = verifyJudgement({ id: 'T1', found: true, now: '额度只列有额度的家了', basis: [{ e: 'E1', quote: '额度只列有额度的家' }], next: [] }, quota, new Map([['E1', release]]))
    expect(loose.state).toBe('none')
    const ok = verifyJudgement({ id: 'T1', found: true, now: '额度显示改成按钱算了', basis: [{ e: 'E1', quote: '额度显示改成按钱算' }], next: [] }, quota, new Map([['E1', release]]))
    expect(ok.state).toBe('found')
    // 「部署上线」被那件活的一句要求撑成进展(真看板副本上撞到过)→ 不算。
    const deploy = card('部署上线', { id: 't-deploy' })
    const require: EvidenceItem = { id: 'claude:y', kind: 'session', source: 'Claude · 吸收 Mobius', text: 'Claude 答:「纯静态 HTML + CSS,能直接部署到 GitHub Pages」' }
    expect(verifyJudgement({ id: 'T1', found: true, now: '还没做,只定了要部署上线', basis: [{ e: 'E1', quote: '能直接部署到 GitHub Pages' }], next: [] }, deploy, new Map([['E1', require]])).state).toBe('none')
  })

  it('摘录太短(三个字以内)不算;标点、空白、全角半角、markdown 记号不影响核对', () => {
    expect(quoteFound('11屏', SITE_SESSION.text)).toBe(false)
    expect(quoteFound('11 屏按网页顺序排列,每屏都标清了', SITE_SESSION.text)).toBe(true)
    expect(quoteFound('**参赛网页逐屏文案稿**', SITE_SESSION.text)).toBe(true)
  })

  it('「现在到哪」里凭空多出一个数 → 不用它那一句,退回摘录原话', () => {
    expect(numbersBacked('12 屏已做完', ['11 屏按网页顺序排列'])).toBe(false)
    const judged = verifyJudgement({ id: 'T1', found: true, now: '12 屏已做完', basis: [{ e: 'E1', quote: '11 屏按网页顺序排列，每屏都标清了页面标题' }], next: [] }, site, keys, new Set([SITE_SESSION.id]))
    expect(judged.line).toBe('11 屏按网页顺序排列，每屏都标清了页面标题')
  })

  it('模型回的 T 编号对回卡;形状不对的那一张丢掉,不整份丢', () => {
    const cards = [site, card('注册域名', { id: 't-domain' })]
    // 那条会话直连参赛网页这张卡(卡上点名的会话):摘录不必再字面说到主语。
    const strong = new Map([['t-site', [{ ev: SITE_SESSION, score: 1, strong: true }]]])
    const out = judgementsFromModel({ items: [
      { id: 'T1', found: true, now: '11 屏已做完', basis: [{ e: 'E1', quote: '11 屏按网页顺序排列，每屏都标清了页面标题' }], next: [] },
      { id: 'T2', found: false, basis: 'oops' },
      { nope: true },
    ] }, cards, keys, strong)
    expect(out?.get('t-site')?.state).toBe('found')
    expect(out?.get('t-domain')?.state).toBe('none')
    expect(judgementsFromModel({ nothing: 1 }, cards, keys)).toBeUndefined()
  })

  it('模型回的整份不是合法 JSON(第二件漏了 "basis":[ —— 真看板副本上撞到过):一件一件捞,坏的那件丢掉', () => {
    const broken = '{"items":[{"id":"T1","found":true,"now":"已修好","basis":[{"e":"E1","quote":"修好了,{不是}估计不够"}],"next":[],"mismatch":""},'
      + '{"id":"T2","found":true,"now":"11 屏已补完","waiting_on":"me","wait_what":"审逐屏文案稿","wait_e":"E33","wait_quote":"已整理成"},{"e":"E32","quote":"已接着原有11屏补完"}],"next":[],"mismatch":""},'
      + '{"id":"T3","found":false,"now":"","basis":[],"next":[],"mismatch":""}]}'
    expect(() => JSON.parse(broken)).toThrow()
    const salvaged = salvageJudgeItems(broken)
    expect((salvaged?.items as { id: string }[]).map(one => one.id)).toEqual(['T1', 'T2', 'T3'])
    // T2 那一件自己是合法的(只是后面那截成了孤儿):它的「在等你做什么」平铺三格照样认得出。
    const parsed = parseJudgeReplyForTest(salvaged)
    expect(parsed.find(one => one.id === 'T2')?.waiting_for).toEqual({ what: '审逐屏文案稿', e: 'E33', quote: '已整理成' })
    expect(salvageJudgeItems('完全不是 JSON')).toBeUndefined()
  })

  it('问模型的那两段话:卡上写的只当起点,证据带编号与出处时刻,要求逐字摘录', () => {
    const c = card('参赛网页架构收尾', { id: 't-site', desc: '第一条:让 Codex 把参赛网页的架构剩下的补完', assignee: 'codex', status: 'done' })
    const prompt = buildJudgePrompt({ now: new Date('2026-09-25T15:10:00+08:00'), cards: [c], candidates: new Map([['t-site', [{ ev: SITE_SESSION, score: 1, strong: true }]]]) })
    expect(prompt.user).toContain('T1 「参赛网页架构收尾」(负责:Codex;卡在「完成」;卡上写的(口述,只当起点):第一条')
    expect(prompt.user).toContain('E1 [Codex 里「制作参赛网页」那段对话 · 09-24')
    expect(prompt.system).toContain('逐字')
    // 规矩全在 system(每一轮一字不变);user 里只有时刻、总账、卡与证据 —— 模型那头的前缀缓存吃得到。
    expect(prompt.system).toBe(JUDGE_SYSTEM)
    expect(prompt.user).not.toContain('1. 只按证据说')
    expect(prompt.keys.get('E1')).toBe(SITE_SESSION)
  })

  it('总账排在卡前面:同一轮的几批开头一字不差', () => {
    const a = card('参赛网页架构收尾', { id: 't-site' })
    const b = card('注册域名', { id: 't-domain' })
    const recent: EvidenceItem[] = [{ id: 'release:0.2.99', kind: 'release', source: '更新说明 0.2.99', at: '2026-09-25', text: '卡片小头像不再被切' }]
    const now = new Date('2026-09-25T15:10:00+08:00')
    const first = buildJudgePrompt({ now, cards: [a], candidates: new Map([['t-site', [{ ev: SITE_SESSION, score: 1, strong: true }]]]), recent })
    const second = buildJudgePrompt({ now, cards: [b], candidates: new Map(), recent })
    const head = first.user.slice(0, first.user.indexOf('【要核的事】'))
    expect(head).toContain('E1 [更新说明 0.2.99 · 09-25]')
    expect(second.user.startsWith(head)).toBe(true)
  })
})

describe('模型写的那一句说的是不是这张卡(真看板副本上撞到的两种)', () => {
  const context = ['工作台', 'Spotlight 参赛 · 10-04', '参赛材料']
  it('「参赛视频」写成了「网页架构收尾已交…」:那是另一张卡的事 → 不算', () => {
    const video = card('参赛视频', { id: 't-video', context })
    const site = card('参赛网页架构收尾', { id: 't-site', context })
    expect(saysAnotherCard('网页架构收尾已交,还差文案定稿与素材', video, [site])).toBe(true)
    expect(saysAnotherCard('视频第一版剪好了', video, [site])).toBe(false)
    const raw: RawJudgement = { id: 'T1', found: true, now: '网页架构收尾已交,还差文案定稿与素材', basis: [{ e: 'E1', quote: '还差文案定稿、真实界面素材和下载地址;手机真机尚未验收,视频未动' }], next: [] }
    const ev: EvidenceItem = { id: 'd', kind: 'dispatch', source: 'Codex 交回来的话', text: `Codex 答:「${RETURNED}」`.replace(/；/g, ';').replace(/，/g, ',') }
    expect(verifyJudgement(raw, video, new Map([['E1', ev]]), new Set(), [site]).state).toBe('none')
  })

  it('决策记录要主语差不多原样出现才配卡(「打磨自媒体布局」配不上「引导里先问布局」那一节)', () => {
    const layout = card('打磨自媒体布局', { id: 't-layout', context })
    const decision: EvidenceItem = { id: 'decision:x', kind: 'decision', source: '项目里记下的决定', at: '2026-09-23', title: '晚 · 引导先问分岔', text: '引导顺序改成 ① 称呼 → ② 分岔 → ①′ 布局 → ②′ 项目 / 账号,之后不变' }
    const release: EvidenceItem = { id: 'release:x', kind: 'release', source: '更新说明 0.2.77', at: '2026-09-23', text: '引导顺序改成 称呼 → 已有在做的事还是新点子 → 布局 → 录项目/账号' }
    const picked = pickCandidates([layout], [decision, release]).get('t-layout') ?? []
    expect(picked.map(one => one.ev.id)).not.toContain('decision:x')
  })
})

describe('规则那一套(没接模型 / 到了上限):只摘原话', () => {
  it('直连的证据 → 哪儿说的(短说法)+ 说到这件事的那一句(一样多取靠后的;时刻在依据里);在请他看 → 等他', () => {
    const judged = rulesJudge(card('参赛网页架构收尾', { status: 'done' }), [{ ev: SITE_SESSION, score: 1, strong: true }])
    expect(judged.state).toBe('found')
    expect(judged.by).toBe('rules')
    expect(judged.line).toMatch(/^Codex 里那段对话:「[^「」]*11 屏按网页顺序排列[^「」]*」$/)
    expect(judged.waiting_on).toBe('me')
  })

  it('一段交回来的话里挑说的就是这件事的那一句(「真实界面素材」→「还差…真实界面素材…」,不是第一句)', () => {
    const returned: EvidenceItem = { id: 'd', kind: 'dispatch', source: 'Codex 交回来的话', text: `Codex 答:「${RETURNED}」` }
    const judged = rulesJudge(card('真实界面素材'), [{ ev: returned, score: 1, strong: true }])
    expect(judged.basis[0]?.quote).toBe('还差文案定稿、真实界面素材和下载地址')
  })

  it('只有字面沾边(覆盖不到八成)的 → 不当证据', () => {
    const judged = rulesJudge(card('部署上线'), [{ ev: { id: 'x', kind: 'session', source: 'Codex', text: '能直接部署到 GitHub Pages' }, score: 0.5, strong: false }])
    expect(judged.line).toBe(PROGRESS_NONE_LINE)
  })

  it('去掉冲刺名只剩两个字的主语(「参赛视频」→「视频」):要整个标题原样出现才算(真看板副本上认错过一次)', () => {
    const context = ['工作台', 'Spotlight 参赛 · 10-04', '参赛材料']
    const loose: EvidenceItem = { id: 'v', kind: 'session', source: 'Claude · 吸收 Mobius 机制', text: '页面里不放视频和音频,只用截图与照片,素材没给的位置放灰色留位框加编号' }
    expect(rulesJudge(card('参赛视频', { context }), [{ ev: loose, score: 1, strong: false }]).line).toBe(PROGRESS_NONE_LINE)
    const exact: EvidenceItem = { id: 'w', kind: 'session', source: 'Codex · 剪片', text: '参赛视频第一版剪好了,90 秒' }
    expect(rulesJudge(card('参赛视频', { context }), [{ ev: exact, score: 1, strong: false }]).state).toBe('found')
  })
})

describe('落到卡上与下一步', () => {
  it('和上一轮比变没变', () => {
    const judged = rulesJudge(card('参赛网页架构收尾'), [{ ev: SITE_SESSION, score: 1, strong: true }])
    const first = progressView(judged, '2026-09-25T07:00:00Z')
    expect(first.changed).toBe(true)
    expect(progressView(judged, '2026-09-25T08:00:00Z', first).changed).toBe(false)
    expect(first.basis[0]?.ref).toBe(SITE_SESSION.ref)
  })

  it('下一步:看板上已经有的、提过的、同一轮重复的都不再提;一轮最多三条', () => {
    const step = (title: string) => ({ title, quote: '还差文案定稿、真实界面素材和下载地址', ev: SITE_SESSION, fromTask: 't-site' })
    const out = proposalsFrom(
      [step('文案定稿'), step('真实界面素材'), step('下载地址'), step('下载地址'), step('手机真机验收'), step('参赛视频')],
      [{ title: '参赛文案' }, { title: '参赛视频' }],
      ['手机真机验收'],
      3,
      CONTEXT,
    )
    // 「文案定稿」和看板上的「参赛文案」是一件(「参赛」是模块里人人都有的字)。
    expect(out.map(one => one.title)).toEqual(['真实界面素材', '下载地址'])
    expect(sameThing('参赛文案', '文案定稿', CONTEXT)).toBe(true)
    expect(sameThing('参赛文案', '文案定稿')).toBe(false)
    expect(sameThing('注册域名', '注册页面', CONTEXT)).toBe(false)
  })
})

describe('给人看的字(2026-09-25:「从常规用户的第一次使用角度」):不出现文件名、路径、提交号', () => {
  it('peopleText:路径、网址、带扩展名的文件名、提交号、会话号、分支名、提交标题前那一截都拿掉;中文文件名留名字;「Codex/Claude」不当路径', () => {
    expect(peopleText('已整理成 参赛网页逐屏文案稿(/Users/example/Documents/GitHub/desktop-workbench/docs/文案-参赛网页逐屏审稿.md)。')).toBe('已整理成 参赛网页逐屏文案稿(文案-参赛网页逐屏审稿)。')
    expect(peopleText('fix(dispatch): 读回答的锚点改成我们整条消息的末尾')).toBe('读回答的锚点改成我们整条消息的末尾')
    expect(peopleText('合进 main 了(b21048c2),Codex/Claude 两家都能派')).toBe('并进正式版了,Codex/Claude 两家都能派')
    expect(peopleText('看 https://example.com/a/b 那一页')).toBe('看 那一页')
    expect(peopleText('会话 01a0ccd1-5e62-7eb2-a0af-224d9d844cfd 里说了')).toBe('会话 里说了')
    expect(peopleText('文档推到 `feat/site` 上了')).toBe('文档推到 上了')
    expect(peopleText('11 屏已做完,逐屏文案稿在等你审')).toBe('11 屏已做完,逐屏文案稿在等你审')
    // 版本号、数目不是提交号。
    expect(peopleText('0.2.87 上线了,远程派活六家都能派')).toBe('0.2.87 上线了,远程派活六家都能派')
  })

  it('摘录:夹着文件名 / 路径 / 提交号 / 网址的整句不给看(剥完常剩半句);提交标题前那一截、反引号剥掉不算;太短的不给', () => {
    expect(shownQuote('11 屏按网页顺序排列，每屏都标清了页面标题')).toBe('11 屏按网页顺序排列，每屏都标清了页面标题')
    expect(shownQuote('改了 src/server/progress.ts 和 tests/x.test.ts,还差文案')).toBe('')
    expect(shownQuote('合进 main 了(b21048c2)')).toBe('')
    expect(shownQuote('fix(dispatch): 读回答的锚点改成我们整条消息的末尾')).toBe('读回答的锚点改成我们整条消息的末尾')
    expect(shownQuote('好了')).toBe('')
  })

  it('落到卡上的那一格:出处、摘录、那一句都过一遍;夹着路径的摘录不给,出处与时刻照给;剥空了的那一句算没看到进展', () => {
    const ev: EvidenceItem = { id: 'c', kind: 'commit', source: '项目里的一次改动(还没并进正式版)', ref: 'abcdef123456', at: '2026-09-25T09:54:58Z', text: 'x' }
    const view = progressView({ taskId: 't', state: 'found', line: '会话读法改成一份(sessionDigest.ts),还没并进正式版', basis: [{ ev, quote: 'refactor: 会话读法全仓一份 src/server/sessionDigest.ts' }], next: [], by: 'model' }, '2026-09-25T10:00:00Z')
    expect(view.line).toBe('会话读法改成一份,还没并进正式版')
    expect(view.basis[0]?.source).toBe('项目里的一次改动(还没并进正式版)')
    expect(view.basis[0]?.quote).toBeUndefined()
    expect(view.basis[0]?.ref).toBe('abcdef123456')
    const empty = progressView({ taskId: 't', state: 'found', line: '`src/a.ts`', basis: [{ ev, quote: '会话读法全仓一份' }], next: [], by: 'model' }, '2026-09-25T10:00:00Z')
    expect(empty.state).toBe('none')
    expect(empty.line).toBe(PROGRESS_NONE_LINE)
    expect(empty.basis).toEqual([])
  })

  it('全角标点也认(「，」「（）」):剥完不留空括号、不留孤零零的逗号', () => {
    expect(peopleText('已合（b21048c2），两家都能派')).toBe('已合，两家都能派')
    expect(peopleText('改了 src/a.ts，还差文案')).toBe('改了，还差文案')
    expect(shownQuote('改了 src/a.ts，还差文案')).toBe('')
  })

  it('出处的短说法(规则拼的那一句用):去掉书名号里那一截', () => {
    expect(briefSource('Codex 里「制作参赛网页」那段对话')).toBe('Codex 里那段对话')
    expect(briefSource('工作记录「某张卡」(还没并进正式版)')).toBe('工作记录(还没并进正式版)')
    expect(briefSource('更新说明 0.2.87')).toBe('更新说明 0.2.87')
  })
})

describe('「并没并进正式版」也要有依据撑着(真看板副本 09-25 晚:0.2.99 已经发了,模型写成「还没并进正式版」)', () => {
  const onMain = { kind: 'commit' as const }
  const branch = { kind: 'commit' as const, unmerged: true as const }
  it('说「还没并进正式版」却没有一条还没合的依据 → 那一截拿掉;有就留着', () => {
    expect(mergeClaimsBacked('事务官自己改好了一处界面小毛病，还没并进正式版', [onMain])).toBe('事务官自己改好了一处界面小毛病')
    expect(mergeClaimsBacked('做了会话读法一份,还没合', [onMain])).toBe('做了会话读法一份')
    expect(mergeClaimsBacked('事务官自己改好了一处界面小毛病，还没并进正式版', [branch])).toBe('事务官自己改好了一处界面小毛病，还没并进正式版')
    expect(mergeClaimsBacked('还没并进正式版', [onMain])).toBe('')
  })
  it('说「已上线」而依据全是还没合的 → 改说「还没并进正式版」;有一条在主线上的就不动', () => {
    expect(mergeClaimsBacked('会话读法改成一份,已上线', [branch])).toBe('会话读法改成一份,还没并进正式版')
    expect(mergeClaimsBacked('会话读法改成一份,已上线', [onMain, branch])).toBe('会话读法改成一份,已上线')
    expect(mergeClaimsBacked('11 屏已做完,逐屏文案稿在等你审', [onMain])).toBe('11 屏已做完,逐屏文案稿在等你审')
  })
  it('核一张卡时照这条收拾模型那一句', () => {
    const c = card('验证自我迭代能力', { id: 't-self' })
    const commit: EvidenceItem = { id: 'commit:d1fe048f', kind: 'commit', source: '项目里的一次改动', main: true, at: '2026-09-25T14:37:10+08:00', text: 'chore: 0.2.99 —— 卡片小头像不再被切(事务官自修,统筹合并)' }
    const raw: RawJudgement = { id: 'T1', found: true, now: '事务官自己改好了一处界面小毛病，还没并进正式版', basis: [{ e: 'E1', quote: '卡片小头像不再被切(事务官自修,统筹合并)' }], next: [] }
    const judged = verifyJudgement(raw, c, new Map([['E1', commit]]), new Set(['commit:d1fe048f']))
    expect(judged.line).toBe('事务官自己改好了一处界面小毛病')
  })
})
