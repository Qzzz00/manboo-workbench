// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NoteView, TaskView, TodayTodosView } from '../src/protocol.ts'
import type { JobEvent } from '../src/server/jobLog.ts'
import {
  DAY_REVIEW_HEAD,
  DAY_REVIEW_MAX_CHARS,
  DAY_REVIEW_PROGRAM_ONLY_NOTE,
  DAY_REVIEW_SECTION_HEADS,
  DAY_REVIEW_SECTION_MAX,
  buildDayReviewPrompt,
  composeDayReview,
  dayReviewFacts,
  dayReviewLines,
  dayReviewSectionsByProgram,
  dayReviewWindow,
  parseDayReviewReply,
} from '../src/server/agentDayReview.ts'
import { composeMorningReport } from '../src/server/routineMemory.ts'
import type { ChainRecord } from '../src/server/videoChain.ts'

const SINCE = '2026-10-12T00:30:00Z'
const UNTIL = '2026-10-13T00:30:00Z'
/** 窗口内的一个时刻。 */
const IN = '2026-10-12T06:00:00Z'
/** 窗口之前的一个时刻。 */
const OLD = '2026-10-01T06:00:00Z'

function task(patch: Partial<TaskView> & Pick<TaskView, 'id' | 'title'>): TaskView {
  return {
    status: 'doing',
    source: { kind: 'manual' },
    created_at: OLD,
    updated_at: IN,
    direction: 'mine',
    ...patch,
  } as TaskView
}

function facts(input: {
  tasks: readonly TaskView[]
  jobEvents?: readonly JobEvent[]
  notes?: readonly NoteView[]
  today_todos?: TodayTodosView
  chains?: readonly ChainRecord[]
}) {
  return dayReviewFacts({ since: SINCE, until: UNTIL, ...input })
}

/** 一条接力记录(`~/.dsh/workbench/video-chains.json` 里那一条的形状)。 */
function chain(item: string, stage: ChainRecord['stage']): ChainRecord {
  return { item, subject: '女孩树林摘蘑菇', video_prompt: '…', stage, since: Date.parse(IN) }
}

/**
 * 视频链里**豆包的回话不是交付**(2026-10-13,卡 F;四场景验收第 16 条)。
 *
 * 真机 14:31 那份早报把正在可灵那一步的「女孩树林摘蘑菇」列进了已完成,依据是
 * 「豆包办公已说完,结果没收进卡」—— 那只是第一步(出参考图)读回来了,片子还没出。
 */
describe('两步接力还没走完的不算已完成(卡 F)', () => {
  const inChain = (stage: ChainRecord['stage']) => facts({
    tasks: [task({
      id: 't1',
      title: '女孩树林摘蘑菇的视频',
      client_dispatch: { family: 'doubao', hand: 'window', text: '出一张参考图', status: 'sent', at: IN, seen_at: IN, reply_state: 'done', reply_at: IN },
    })],
    chains: [chain('t1', stage)],
  })

  it('★在可灵那一步(stage=kling)→ 推进中,而且说得出做到哪', () => {
    const rows = inChain('kling')
    expect(rows[0]?.verdict).toBe('in_progress')
    expect(rows[0]?.because).toBeUndefined()
    expect(rows[0]?.stage_result).toBe('参考图拿到了,在可灵生成')
  })

  it('★还在等豆包出图(stage=image)/ 可灵在出片(stage=video)→ 都是推进中', () => {
    expect(inChain('image')[0]?.verdict).toBe('in_progress')
    expect(inChain('video')[0]?.verdict).toBe('in_progress')
  })

  it('接力走完了(stage=done)→ 照旧按证据算已完成', () => {
    const rows = inChain('done')
    expect(rows[0]?.verdict).toBe('done')
    expect(rows[0]?.because).toContain('回话读回来了')
  })

  it('★接力断了(stage=failed)→ 不算已完成,按卡点', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '女孩树林摘蘑菇的视频',
        status: 'blocked',
        block_reason: 'error',
        note: '豆包回话了,但在它的本机缓存里没找到这一轮出的图',
        client_dispatch: { family: 'doubao', hand: 'window', text: '出一张参考图', status: 'sent', at: IN, seen_at: IN, reply_state: 'done', reply_at: IN },
      })],
      chains: [chain('t1', 'failed')],
    })
    expect(rows[0]?.verdict).toBe('blocked')
    expect(rows[0]?.blocked_why).toContain('没找到这一轮出的图')
  })

  it('没接接力记录(别的宿主 / 老服务)→ 与加这一道之前逐字相同', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '女孩树林摘蘑菇的视频',
        client_dispatch: { family: 'doubao', hand: 'window', text: '出一张参考图', status: 'sent', at: IN, seen_at: IN, reply_state: 'done', reply_at: IN },
      })],
    })
    expect(rows[0]?.verdict).toBe('done')
  })

  it('接力记录里没有这张卡 → 不受影响', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '写脚本',
        status: 'confirm',
        dispatch: { family: 'codex', status: 'done', started_at: IN, ended_at: IN, note: '脚本写好了' },
      })],
      chains: [chain('t-别的卡', 'kling')],
    })
    expect(rows[0]?.verdict).toBe('done')
  })
})

describe('事实表:谁进得来(规范 §1 §2 §9)', () => {
  it('窗口内派过活的 Agent 任务进表,带编号与出处', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '产品宣传视频脚本',
        dispatch: { family: 'codex', status: 'running', started_at: IN },
      })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('d1')
    expect(rows[0]?.task_id).toBe('t1')
    expect(rows[0]?.source).not.toBe('')
    expect(rows[0]?.families).toEqual(['codex'])
  })

  it('只动过卡上标题(updated_at)而没有一条派活 / 完成证据的,一条都不进 —— 卡上改动只作兜底', () => {
    const rows = facts({ tasks: [task({ id: 't1', title: '改个标题', updated_at: IN, created_at: OLD })] })
    expect(rows.filter(row => row.kind === 'agent_task')).toEqual([])
  })

  it('她自己的待办(没派过、没会话)不算 Agent 任务;「只是问了一句」也不算', () => {
    const rows = facts({
      tasks: [
        task({ id: 't1', title: '自己去买快递', assignee: 'me', created_at: IN }),
        task({ id: 't2', title: '随口问一句', created_at: IN, casual: true, conversation: { agent: 'dsh', session_id: 's1' } }),
      ],
    })
    expect(rows.filter(row => row.kind === 'agent_task')).toEqual([])
  })

  it('窗口之外的派活不进表(时间窗按上次早报算)', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '老活', updated_at: OLD, dispatch: { family: 'codex', status: 'done', started_at: OLD, ended_at: OLD } })],
    })
    expect(rows.filter(row => row.kind === 'agent_task')).toEqual([])
  })

  it('关键状态变化只留影响任务发展的那几步:打电话、动作闸不进(规范 §8)', () => {
    const jobEvents: JobEvent[] = [
      { at: IN, job: 't1', step: 'assigned', family: 'claude' },
      { at: IN, job: 't1', step: 'called' },
      { at: IN, job: 't1', step: 'gate_pass', action: 'window' },
      { at: IN, job: 't1', step: 'sent', family: 'claude' },
    ]
    const rows = facts({ tasks: [task({ id: 't1', title: '查资料' })], jobEvents })
    const changes = (rows[0]?.changes ?? []).join('\n')
    expect(changes).toContain('Claude')
    expect(changes).not.toContain('电话')
    expect(changes).not.toContain('闸')
  })

  it('随手记与待办只当辅助行,编号与 Agent 任务分开(规范 §2)', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '写脚本', dispatch: { family: 'codex', status: 'running', started_at: IN } })],
      notes: [{ id: 'n1', text: '想做一条开箱', created_at: IN }, { id: 'n2', text: '上个月的旧想法', created_at: OLD }],
      today_todos: { date: '2026-10-13', tomorrow: '2026-10-14', items: [{ id: 'x1', title: '剪片子', due: '2026-10-13', done: false, overdue: false }] },
    })
    expect(rows.filter(row => row.kind === 'note').map(row => row.id)).toEqual(['n1'])
    expect(rows.find(row => row.kind === 'note')?.title).toContain('开箱')
    expect(rows.filter(row => row.kind === 'todo').map(row => row.id)).toEqual(['t1'])
    // 旧的随手记不进(只收窗口内新记的)
    expect(rows.map(row => row.title).join('\n')).not.toContain('旧想法')
  })
})

describe('五档按证据判(规范 §4 §5 §6 §7)', () => {
  it('完成要有明确结果依据:那家交回来了算完成', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '写脚本',
        status: 'confirm',
        dispatch: { family: 'codex', status: 'done', started_at: IN, ended_at: IN, note: '脚本写好了' },
      })],
    })
    expect(rows[0]?.verdict).toBe('done')
    expect(rows[0]?.because).toContain('交回')
  })

  it('她把卡挪进办完 → 完成', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '报价单', status: 'done', done_at: IN, dispatch: { family: 'gpt', status: 'done', started_at: OLD, ended_at: IN } })],
    })
    expect(rows[0]?.verdict).toBe('done')
  })

  it('只是送进去了、还没回话 —— 推进中,不是完成(「讨论了」「试了」不算完成)', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '查竞品',
        client_dispatch: { family: 'doubao', hand: 'window', text: '查一下竞品', status: 'sent', at: IN, seen_at: IN },
      })],
    })
    expect(rows[0]?.verdict).toBe('in_progress')
  })

  it('推进中要说出已经做到哪里(规范 §6):取「现在到哪」那一句', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '产品宣传视频',
        dispatch: { family: 'codex', status: 'running', started_at: IN },
        progress: { line: '框架与功能说明写完了,视觉展示还没动', state: 'found', basis: [], checked_at: IN, by: 'model' },
      })],
    })
    expect(rows[0]?.stage_result).toContain('视觉展示还没动')
  })

  it('卡点要说卡在哪、为什么、要不要外部条件(规范 §7):超时、额度、锁屏、派不出去各自一种', () => {
    const rows = facts({
      tasks: [
        task({ id: 't1', title: '超时那件', dispatch: { family: 'kimi', status: 'running', started_at: IN } }),
        task({ id: 't2', title: '额度那件', dispatch: { family: 'codex', status: 'failed', started_at: IN, ended_at: IN, stopped: 'cap' } }),
        task({ id: 't3', title: '锁屏那件' }),
        task({ id: 't4', title: '派不出去那件', status: 'blocked', dispatch_block: { family: 'kimi', kind: 'code', why: '这家只能聊天', at: IN }, updated_at: IN, created_at: IN }),
      ],
      jobEvents: [
        { at: IN, job: 't1', step: 'assigned', family: 'kimi' },
        { at: IN, job: 't1', step: 'timeout', family: 'kimi' },
        { at: IN, job: 't3', step: 'assigned', family: 'claude' },
        { at: IN, job: 't3', step: 'waiting', family: 'claude' },
      ],
    })
    const byId = new Map(rows.map(row => [row.task_id, row]))
    expect(byId.get('t1')?.verdict).toBe('blocked')
    expect(byId.get('t1')?.blocked_why).toContain('等')
    expect(byId.get('t2')?.verdict).toBe('blocked')
    expect(byId.get('t2')?.blocked_why).toContain('上限')
    expect(byId.get('t3')?.verdict).toBe('blocked')
    expect(byId.get('t3')?.blocked_why).toContain('锁')
    expect(byId.get('t3')?.blocked_needs).toBe('她')
    expect(byId.get('t4')?.verdict).toBe('blocked')
    for (const row of rows) expect(row.blocked_needs).not.toBeUndefined()
  })

  it('回话读不回来 → 卡点,要她去那扇窗里看一眼(不写成「卡上标着阻塞」那种内部话)', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '竞品拆解',
        status: 'blocked',
        block_reason: 'error',
        note: '豆包那扇窗读不到',
        client_dispatch: { family: 'doubao', hand: 'window', text: '拆一下竞品', status: 'sent', at: IN, reply_state: 'unreadable', reply_at: IN },
      })],
    })
    expect(rows[0]?.verdict).toBe('blocked')
    expect(rows[0]?.blocked_why).toBe('豆包办公 的回话读不回来')
    expect(rows[0]?.blocked_needs).toBe('她')
  })

  it('卡上标着阻塞、没有别的证据 → 把卡上那句话摆在前面', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '客户报价',
        status: 'blocked',
        block_reason: 'input',
        note: '等客户给预算',
        created_at: IN,
        conversation: { agent: 'dsh', session_id: 's1' },
      })],
    })
    expect(rows[0]?.blocked_why).toBe('等客户给预算(卡上标着阻塞 · 等你输入)')
    expect(rows[0]?.blocked_needs).toBe('她')
  })

  it('「今天没来得及继续」不算卡点:当天建了卡、一个字没送出去 → 当日新增未推进', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '新交代的一件', status: 'todo', created_at: IN, conversation: { agent: 'dsh', session_id: 's1' } })],
    })
    expect(rows[0]?.verdict).toBe('new_idle')
    const sections = dayReviewSectionsByProgram(rows)
    expect(sections.blocked).toEqual([])
    expect(sections.in_progress).toEqual([])
  })

  it('她点了停掉 → 暂停,只进下一步,不写成卡点也不写成推进中', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '那件停掉的', dispatch: { family: 'codex', status: 'failed', started_at: IN, ended_at: IN, stopped: 'user' } })],
    })
    expect(rows[0]?.verdict).toBe('paused')
    const sections = dayReviewSectionsByProgram(rows)
    expect(sections.blocked).toEqual([])
    expect(sections.in_progress).toEqual([])
    expect(sections.next.map(one => one.name)).toContain('那件停掉的')
  })
})

describe('停太久的事项并进卡点,不在早报里出现两次', () => {
  it('停太久的「等你」进卡点;「多半不需要了」算暂停(只进下一步)', () => {
    const rows = facts({
      tasks: [
        task({
          id: 't1',
          title: '等你答的那件',
          updated_at: OLD,
          standing: { case: 'waiting_her', waiting_on: 'her', next: '你定一下:继续、停掉还是换一家', idle_days: 5, stalled: true },
        }),
        task({
          id: 't2',
          title: '多半不需要的那件',
          updated_at: OLD,
          standing: { case: 'likely_moot', waiting_on: 'nobody', next: '9 天没动静:还要就继续,不要就关掉', idle_days: 9, stalled: true },
        }),
      ],
    })
    const byId = new Map(rows.map(row => [row.task_id, row]))
    expect(byId.get('t1')?.verdict).toBe('blocked')
    expect(byId.get('t1')?.blocked_why).toContain('5 天')
    expect(byId.get('t2')?.verdict).toBe('paused')
  })

  it('同一件既在窗口里动过、又标着停太久 —— 只出一行', () => {
    const rows = facts({
      tasks: [task({
        id: 't1',
        title: '同一件',
        dispatch: { family: 'codex', status: 'running', started_at: IN },
        standing: { case: 'waiting_her', waiting_on: 'her', next: '你定一下', idle_days: 4, stalled: true },
      })],
    })
    expect(rows.filter(row => row.task_id === 't1')).toHaveLength(1)
  })
})

describe('模型只许引编号(照预案卡的先例)', () => {
  const rows = facts({
    tasks: [
      task({ id: 't1', title: '写脚本', status: 'confirm', dispatch: { family: 'codex', status: 'done', started_at: IN, ended_at: IN, note: '脚本写好了' } }),
      task({ id: 't2', title: '查竞品', client_dispatch: { family: 'doubao', hand: 'window', text: '查一下竞品', status: 'sent', at: IN, seen_at: IN } }),
    ],
  })

  it('提示里有编号表、四段与风格要求', () => {
    const prompt = buildDayReviewPrompt(rows)
    expect(prompt).toContain('d1')
    expect(prompt).toContain('d2')
    expect(prompt).toContain('已完成')
    expect(prompt).toContain('下一步')
    expect(prompt).toContain('编号')
  })

  it('引表外编号的整条丢;冒出表里没有的数整条丢', () => {
    const reply = JSON.stringify([
      { section: 'done', fact: 'd9', name: '凭空一件', line: '做完了' },
      { section: 'done', fact: 'd1', name: '写脚本', line: '交回了 3 个版本' },
      { section: 'in_progress', fact: 'd2', name: '查竞品', line: '送进豆包了,还没回话' },
    ])
    const parsed = parseDayReviewReply(reply, rows)
    expect('sections' in parsed).toBe(true)
    if (!('sections' in parsed)) return
    expect(parsed.sections.done).toEqual([])
    expect(parsed.sections.in_progress.map(one => one.name)).toEqual(['查竞品'])
  })

  it('把没有完成依据的那件写进「已完成」 —— 整条丢(规范 §5)', () => {
    const reply = JSON.stringify([
      { section: 'done', fact: 'd2', name: '查竞品', line: '已经搞定了' },
      { section: 'in_progress', fact: 'd2', name: '查竞品', line: '送进豆包了,还没回话' },
    ])
    const parsed = parseDayReviewReply(reply, rows)
    expect('sections' in parsed).toBe(true)
    if (!('sections' in parsed)) return
    expect(parsed.sections.done).toEqual([])
    expect(parsed.sections.in_progress).toHaveLength(1)
  })

  it('下一步写「继续优化」「跟进一下」那种 —— 整条丢(规范 §10)', () => {
    const reply = JSON.stringify([
      { section: 'next', fact: 'd2', name: '查竞品', line: '继续优化' },
      { section: 'next', fact: 'd2', name: '查竞品', line: '去豆包里把那段回话读回来,收进卡' },
    ])
    const parsed = parseDayReviewReply(reply, rows)
    expect('sections' in parsed).toBe(true)
    if (!('sections' in parsed)) return
    expect(parsed.sections.next.map(one => one.line)).toEqual(['去豆包里把那段回话读回来,收进卡'])
  })

  it('一条都对不上 → 报错(交给程序排)', () => {
    expect(parseDayReviewReply('这不是 JSON', rows)).toHaveProperty('error')
    expect(parseDayReviewReply(JSON.stringify([{ section: 'done', fact: 'd9', name: 'x', line: 'y' }]), rows)).toHaveProperty('error')
  })
})

describe('四段排版与上限', () => {
  it('四段顺序固定;空段不出;一段都没有整块不出(规范 §13、§14)', () => {
    expect(dayReviewLines({ done: [], in_progress: [], blocked: [], next: [], by: 'program' })).toEqual([])
    const lines = dayReviewLines({
      done: [{ name: '写脚本', line: '交回了' }],
      in_progress: [],
      blocked: [{ name: '查竞品', line: '卡在:等你答' }],
      next: [{ name: '查竞品', line: '去豆包里读回那段话' }],
      by: 'model',
    })
    const text = lines.join('\n')
    expect(lines[0]).toBe(DAY_REVIEW_HEAD)
    expect(text).toContain(DAY_REVIEW_SECTION_HEADS.done)
    expect(text).not.toContain(DAY_REVIEW_SECTION_HEADS.in_progress)
    expect(text.indexOf(DAY_REVIEW_SECTION_HEADS.blocked)).toBeLessThan(text.indexOf(DAY_REVIEW_SECTION_HEADS.next))
    expect(text).toContain('写脚本｜交回了')
    expect(text).not.toContain(DAY_REVIEW_PROGRAM_ONLY_NOTE)
  })

  it('程序排的那一份注明「只有程序拼的部分」', () => {
    const lines = dayReviewLines({ done: [{ name: 'a', line: 'b' }], in_progress: [], blocked: [], next: [], by: 'program' })
    expect(lines.join('\n')).toContain(DAY_REVIEW_PROGRAM_ONLY_NOTE)
  })

  it('一段超过上限 → 末尾一行「另外 N 件」', () => {
    const many = Array.from({ length: DAY_REVIEW_SECTION_MAX + 3 }, (_, i) => ({ name: `第 ${i} 件`, line: '交回了' }))
    const lines = dayReviewLines({ done: many, in_progress: [], blocked: [], next: [], by: 'model' })
    expect(lines.join('\n')).toContain('另外 3 件')
    expect(lines.filter(line => line.startsWith('- 第'))).toHaveLength(DAY_REVIEW_SECTION_MAX)
  })

  it('正文超长 → 先裁推进中与已完成,卡点与下一步留着', () => {
    const long = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, line: 'x'.repeat(130) }))
    const lines = dayReviewLines({
      done: long(5, '完'),
      in_progress: long(5, '进'),
      blocked: [{ name: '卡住那件', line: '卡在:豆包那扇窗读不到,要重派' }],
      next: [{ name: '卡住那件', line: '重派给 Claude' }],
      by: 'model',
    })
    const text = lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(DAY_REVIEW_MAX_CHARS)
    expect(text).toContain('卡住那件｜卡在:豆包那扇窗读不到,要重派')
    expect(text).toContain('重派给 Claude')
  })
})

describe('下一步的来源(规范 §10)', () => {
  it('昨日未完成 / 卡点各出一条,待办里原定今天的也进来;随手记不作为来源', () => {
    const rows = facts({
      tasks: [
        task({
          id: 't1',
          title: '卡住那件',
          status: 'blocked',
          block_reason: 'error',
          note: '豆包那扇窗读不到',
          created_at: IN,
          client_dispatch: { family: 'doubao', hand: 'window', text: '查一下竞品', status: 'sent', at: IN, reply_state: 'unreadable', reply_at: IN },
          standing: { case: 'channel_failed', waiting_on: 'nobody', next: '重派,或者不做了就关掉' },
        }),
        task({ id: 't2', title: '在做那件', dispatch: { family: 'codex', status: 'running', started_at: IN }, standing: { case: 'in_motion', waiting_on: 'agent', agent: 'codex', next: 'Codex 在做,等它交回来' } }),
      ],
      notes: [{ id: 'n1', text: '也许该做个开箱', created_at: IN }],
      today_todos: { date: '2026-10-13', tomorrow: '2026-10-14', items: [{ id: 'x1', title: '剪片子', due: '2026-10-13', done: false, overdue: false }, { id: 'x2', title: '已经剪完的', due: '2026-10-13', done: true, overdue: false }] },
    })
    const sections = dayReviewSectionsByProgram(rows)
    const text = sections.next.map(one => `${one.name}｜${one.line}`).join('\n')
    expect(text).toContain('卡住那件')
    expect(text).toContain('重派')
    expect(text).toContain('剪片子')
    expect(text).not.toContain('已经剪完的')
    expect(text).not.toContain('开箱')
  })

  it('程序排的下一步里不许出现「继续优化」那类词', () => {
    const rows = facts({
      tasks: [task({ id: 't1', title: '含糊那件', dispatch: { family: 'codex', status: 'running', started_at: IN }, standing: { case: 'in_motion', waiting_on: 'agent', next: '继续优化' } })],
    })
    const sections = dayReviewSectionsByProgram(rows)
    expect(sections.next.map(one => one.line).join('\n')).not.toContain('继续优化')
  })
})

describe('composeDayReview:模型不在就程序排', () => {
  const tasks = [task({ id: 't1', title: '写脚本', status: 'confirm', dispatch: { family: 'codex', status: 'done', started_at: IN, ended_at: IN, note: '脚本写好了' } })]

  it('没接模型 → 程序按事实表排四段,并说清这一份只有程序拼的部分', async () => {
    const made = await composeDayReview({ since: SINCE, until: UNTIL, tasks })
    expect(made.sections.by).toBe('program')
    expect(made.lines.join('\n')).toContain(DAY_REVIEW_PROGRAM_ONLY_NOTE)
    expect(made.lines.join('\n')).toContain('写脚本')
  })

  it('模型抛了 / 回话对不上 → 退回程序排,原因记一句', async () => {
    const thrown = await composeDayReview({ since: SINCE, until: UNTIL, tasks, chat: async () => { throw new Error('模型服务还没接上') } })
    expect(thrown.sections.by).toBe('program')
    expect(thrown.note).toContain('模型服务还没接上')
    const junk = await composeDayReview({ since: SINCE, until: UNTIL, tasks, chat: async () => '胡说八道' })
    expect(junk.sections.by).toBe('program')
    expect(junk.note).not.toBeUndefined()
  })

  it('模型回得上 → 用它并好的四段', async () => {
    const made = await composeDayReview({
      since: SINCE,
      until: UNTIL,
      tasks,
      chat: async () => JSON.stringify([{ section: 'done', fact: 'd1', name: '产品宣传视频', line: '脚本交回了,等你验收' }]),
    })
    expect(made.sections.by).toBe('model')
    expect(made.lines.join('\n')).toContain('产品宣传视频｜脚本交回了,等你验收')
  })

  it('一件事都没有 → 整块不出,不写废话', async () => {
    const made = await composeDayReview({ since: SINCE, until: UNTIL, tasks: [] })
    expect(made.lines).toEqual([])
  })
})

describe('窗口怎么算', () => {
  it('有上次早报就从那一刻算,没有就退回 24 小时', () => {
    const withLast = dayReviewWindow(Date.parse(UNTIL), SINCE)
    expect(Date.parse(withLast.since)).toBe(Date.parse(SINCE))
    expect(Date.parse(withLast.until)).toBe(Date.parse(UNTIL))
    const noLast = dayReviewWindow(Date.parse(UNTIL), undefined)
    expect(Date.parse(noLast.until) - Date.parse(noLast.since)).toBe(24 * 3600 * 1000)
    // 认不出的时刻、比现在还晚的时刻,都当没有
    expect(dayReviewWindow(Date.parse(UNTIL), '不是时刻').since).toBe(noLast.since)
    expect(dayReviewWindow(Date.parse(UNTIL), '2026-11-01T00:00:00Z').since).toBe(noLast.since)
  })
})

describe('早报的排法:四段在最前', () => {
  const base = { state: { running: 0, waiting: 0 } }

  it('四段排在三句之前;给了四段就不再单独出「今天的待办」与「停太久」那两段', () => {
    const report = composeMorningReport({
      ...base,
      day_review: [DAY_REVIEW_HEAD, '已完成:', '- 写脚本｜交回了'],
      todos: ['今天的待办:', '- 「剪片子」'],
      stalled: ['停太久的几件:', '- 「等你答的那件」'],
      meetings: ['今天要开的会:', '- 10:00「周会」'],
    })
    expect(report.text.startsWith(DAY_REVIEW_HEAD)).toBe(true)
    expect(report.text).toContain('今天要开的会:')
    expect(report.text).not.toContain('今天的待办:')
    expect(report.text).not.toContain('停太久的几件:')
    expect(report.text.indexOf(DAY_REVIEW_HEAD)).toBeLessThan(report.text.indexOf('今天没有在盯的事'))
  })

  it('不给四段 → 与加它之前逐字相同', () => {
    const without = composeMorningReport({ ...base, todos: ['今天的待办:', '- 「剪片子」'], stalled: ['停太久的几件:', '- 「那件」'] })
    const empty = composeMorningReport({ ...base, day_review: [], todos: ['今天的待办:', '- 「剪片子」'], stalled: ['停太久的几件:', '- 「那件」'] })
    expect(empty.text).toBe(without.text)
    expect(without.text).toContain('今天的待办:')
  })
})
