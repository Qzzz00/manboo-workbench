/**
 * 「等你」只放**他不点头就卡住**的事(2026-09-27,卡 WY)。
 *
 * 维护者 09-27 原话:「为什么叫等你,是因为这件事我不点头,不给反馈就卡住,而其他的事项是做完了告知我,
 * 所以本来就是只放我做判断的部分。」按这句把设计 docs/设计-等你清单只放真要他判断的事-2026-09-26.md
 * 第五节 A / B / C 一并定了。
 *
 * 这里核对四件事:
 *   1. 事务官自己的提议(派单提议 `dispatch:`、进度核对要他说一句 `progress:`)不进「等你」;
 *   2. 证据里冒出来的「待排」卡(`origin:'evidence'` + `backlog`)不进「等你」,标题也不再是问句;
 *   3. 老服务端算好的那一份里**已经挂着**的这类条目自动撤出(不要他手动清);
 *   4. 座机不为这几种响(`askCallOutEvents`)。
 */
import { describe, expect, it } from 'vitest'
import type { ButlerInboxView, PendingApprovalView, PendingQuestionView, WaitingView, WorkbenchState } from '../src/protocol.ts'
import { askCallOutEvents } from '../src/server/butlerAsks.ts'
import { judgeContent } from '../src/server/waitingForYou.ts'
import { blockingOnly, isButlerProposalAsk, isProposalConfirmItem, waitingOf, waitingOnHim } from '../src/waiting.ts'

function question(sessionId: string, header: string, id = 'q'): PendingQuestionView {
  return {
    id,
    session_id: sessionId,
    at: '2026-09-27T01:00:00.000Z',
    task_id: 't-1',
    task_title: '参赛视频',
    questions: [{ id: 'a', header, question: `${header}?`, multi: false, options: [{ label: '好', text: '好' }] }],
  }
}

function approval(id = 'a-1'): PendingApprovalView {
  return { id, tool: 'Bash', at: '2026-09-27T01:00:00.000Z', task_id: 't-2', task_title: '导出 PDF', say: '要在这个仓库里跑一条命令' } as unknown as PendingApprovalView
}

const INBOX = (items: ButlerInboxView['items']): ButlerInboxView => ({ items } as unknown as ButlerInboxView)

describe('「等你」只收不等他就走不下去的事', () => {
  it('派单提议(dispatch:)与进度要他说一句(progress:)不进「等你」', () => {
    const state = { questions: [question('dispatch:t-1', '这张派给 Claude 开工'), question('progress:t-1', '进度要你说一句', 'q2')] } as unknown as WorkbenchState
    expect(waitingOnHim(state).count).toBe(0)
  })

  it('权限弹窗那一类照旧进「等你」(那件事正停着等他批)', () => {
    const state = { approvals: [approval()] } as unknown as WorkbenchState
    const view = waitingOnHim(state)
    expect(view.count).toBe(1)
    expect(view.items[0]?.kind).toBe('approval')
  })

  it('事务官在会话里问他的那一问照旧进「等你」', () => {
    const state = { questions: [question('session-1', '用方案 A 还是 B')] } as unknown as WorkbenchState
    expect(waitingOnHim(state).count).toBe(1)
  })

  it('证据里冒出来、等他点头的「待排」卡不进「等你」;办完了等他验收的照旧进', () => {
    const state = {
      butler_inbox: INBOX([
        { id: 'confirm:t-p', kind: 'confirm', title: '参赛网页的真实界面素材', status: 'backlog', task_id: 't-p' },
        { id: 'confirm:t-c', kind: 'confirm', title: '黄历接上了', status: 'confirm', task_id: 't-c' },
      ] as unknown as ButlerInboxView['items']),
    } as unknown as WorkbenchState
    const view = waitingOnHim(state)
    expect(view.count).toBe(1)
    expect(view.items[0]?.text).toContain('黄历接上了')
  })

  it('老服务端算好的那一份里已经挂着的这几种,读的时候自动撤出(不要他手动清)', () => {
    const stale: WaitingView = {
      count: 4,
      items: [
        { key: 'question:1', kind: 'question', verb: '答', text: '「参赛视频」问你:进度要你说一句' },
        { key: 'approval:2', kind: 'approval', verb: '批', text: '「打磨自媒体布局」要你批:这张派给 Claude 开工?' },
        { key: 'confirm:3', kind: 'confirm', verb: '验收', text: '「要加上吗:真实界面素材」办完了,等你确认' },
        { key: 'approval:4', kind: 'approval', verb: '批', text: '「导出 PDF」要你批:要在这个仓库里跑一条命令' },
      ],
    }
    const kept = waitingOf({ waiting: stale } as unknown as WorkbenchState)
    expect(kept.count).toBe(1)
    expect(kept.items[0]?.key).toBe('approval:4')
  })

  it('没有该撤的就原样返回那一份(同一个对象,两端读的仍是同一份账)', () => {
    const view: WaitingView = { count: 1, items: [{ key: 'approval:4', kind: 'approval', verb: '批', text: '要你批:跑一条命令' }] }
    expect(waitingOf({ waiting: view } as unknown as WorkbenchState)).toBe(view)
    expect(blockingOnly(view)).toBe(view)
  })

  it('判据本身:哪几个前缀是事务官自己的提议、哪一条是「待排」卡', () => {
    expect(isButlerProposalAsk('dispatch:t-1')).toBe(true)
    expect(isButlerProposalAsk('progress:t-1')).toBe(true)
    expect(isButlerProposalAsk('progress:access')).toBe(true)
    expect(isButlerProposalAsk('session-1')).toBe(false)
    expect(isProposalConfirmItem({ kind: 'confirm', title: '素材', status: 'backlog' })).toBe(true)
    expect(isProposalConfirmItem({ kind: 'confirm', title: '要加上吗:素材' })).toBe(true)
    expect(isProposalConfirmItem({ kind: 'confirm', title: '黄历接上了', status: 'confirm' })).toBe(false)
  })

  it('座机不为事务官自己的提议响(askCallOutEvents)', () => {
    const events = askCallOutEvents([
      question('dispatch:t-1', '这张派给 Claude 开工'),
      question('progress:t-1', '进度要你说一句', 'q2'),
      question('session-1', '用方案 A 还是 B', 'q3'),
    ], [])
    expect(events).toHaveLength(1)
    expect(events[0]?.title).toContain('用方案 A 还是 B')
  })
})

describe('写给统筹 / 父会话的话不算「在等你」(设计第五节 C)', () => {
  it('一张卡向统筹交差、留一条待拍板 —— 不进「等你」', () => {
    expect(judgeContent('卡 U4 做完了。分支已推,交回统筹,留一条待拍板:cookie 修不修。')).toMatchObject({ waiting: false, rule: 'to-boss' })
    expect(judgeContent('测试全绿,报「可合并」,由统筹在 main 合并发版。')).toMatchObject({ waiting: false, rule: 'to-boss' })
  })

  it('对他说的那几句照旧算(光有「待拍板」三个字不当成交差)', () => {
    expect(judgeContent('交接写好了。\n\n待拍板:悬停亮不亮光。')).toMatchObject({ waiting: true })
    expect(judgeContent('首页改好了。要不要我顺手把手机端也改了?')).toMatchObject({ waiting: true })
  })
})
