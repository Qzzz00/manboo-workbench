// @vitest-environment node
/**
 * 「要一份文件」没到她手机上就不算办完(2026-10-04,卡 `claude/phone-file-send-loop`)。
 *
 * 复现的是 10-04 早那一件(事项 `t-63a9291b`、DSH 会话 `session-d0d457fa`):
 * 她在手机上说「官网逐字稿,这份文件发到我这个手机上。」,事务官拷了个文件、叫她再说一遍,
 * 事项随即 `done` + note「只是问了一句」—— 她手机上什么都没有。
 *
 * 三节:① 台账(登记 → 开单 → 回执);② 收尾那一刻的判断(`butlerLifecycle`);
 * ③ 第一条消息里那一行(`butlerBrief`:走哪个口、不许读源码)。
 * 全是纯函数,一行 I/O 都没有。
 */
import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import {
  DELIVERY_WHY_NOT_SENT,
  DELIVERY_WHY_WAITING_TAP,
  createFileDeliveryStore,
  deliveredNote,
  notDeliveredNote,
  sendFileNote,
} from '../src/server/fileDelivery.ts'
import { CASUAL_ASK_NOTE, itemTransitionOnSessionEnd } from '../src/server/butlerLifecycle.ts'
import { FILE_WANT_BRIEF_HEAD, butlerBriefBlock, butlerSkillForItem } from '../src/server/butlerBrief.ts'
import { WB_SKILL_SEND_FILE } from '../src/server/hooksApply.ts'

/** 10-04 早她那一句。 */
const SAID = '官网逐字稿,这份文件发到我这个手机上。'

function store(now: () => number = () => Date.parse('2026-10-04T09:17:00Z')) {
  return createFileDeliveryStore({ now })
}

function expectOne(s: ReturnType<typeof store>) {
  return s.expect({ itemId: 't-63a9291b', request: SAID, query: '官网逐字稿', deviceId: 'dev-phone', deviceName: 'Ben 的手机' })
}

describe('① 台账:登记 → 开单 → 回执', () => {
  it('刚登记:还差一个回执,原因是事务官一下都没走', () => {
    const s = store()
    expectOne(s)
    expect(s.pending('t-63a9291b')).toEqual({ why: DELIVERY_WHY_NOT_SENT, waitingTap: false })
  })

  it('没登记过的卡不受这条规矩管(老卡、别的入口)', () => {
    expect(store().pending('t-别的')).toBeUndefined()
  })

  it('开了单、卡摆在她手机上:还是没到 —— 原因换成「等你点一下」', () => {
    const s = store()
    expectOne(s)
    s.offered('t-63a9291b', { what: '官网逐字稿-2026-10-04.md', offers: ['offer-1'] })
    expect(s.pending('t-63a9291b')).toEqual({
      what: '官网逐字稿-2026-10-04.md',
      why: DELIVERY_WHY_WAITING_TAP,
      waitingTap: true,
    })
  })

  it('回执到了:这件事才算到了;她手机上那张卡撤掉,不让她点第二次', () => {
    const s = store()
    expectOne(s)
    s.offered('t-63a9291b', {
      what: '官网逐字稿.md',
      offers: ['offer-1'],
      ask: { id: 'a1', request: SAID, query: '官网逐字稿', device: '书房 Mac', hits: [], total: 0 },
    })
    expect(s.asksFor('dev-phone')).toHaveLength(1)
    const settled = s.receipt({ offer: 'offer-1', ok: true, name: '官网逐字稿.md', bytes: 2048 })
    expect(settled?.item_id).toBe('t-63a9291b')
    expect(s.pending('t-63a9291b')).toBeUndefined()
    expect(s.asksFor('dev-phone')).toHaveLength(0)
  })

  it('传失败:那句原因原样进卡面,**不许当成到了**', () => {
    const s = store()
    expectOne(s)
    s.offered('t-63a9291b', { what: 'X.md', offers: ['offer-1'] })
    s.receipt({ offer: 'offer-1', ok: false, error: '传到一半断了(手机那头断开了)' })
    expect(s.pending('t-63a9291b')).toEqual({ what: 'X.md', why: '传到一半断了(手机那头断开了)', waitingTap: false })
  })

  it('认不出那张单(别的路开的、过期清掉了)就什么都不做', () => {
    const s = store()
    expectOne(s)
    expect(s.receipt({ offer: '别人的单', ok: true })).toBeUndefined()
  })

  it('只摆给开单那台设备看', () => {
    const s = store()
    expectOne(s)
    s.offered('t-63a9291b', { offers: ['offer-1'], ask: { id: 'a1', request: SAID, query: 'q', device: 'Mac', hits: [], total: 0 } })
    expect(s.asksFor('dev-phone')).toHaveLength(1)
    expect(s.asksFor('别的手机')).toHaveLength(0)
  })

  it('登记太久了就不再拦收尾(她早走开了)', () => {
    let t = Date.parse('2026-10-04T09:17:00Z')
    const s = createFileDeliveryStore({ now: () => t, ttlMs: 1000 })
    expectOne(s)
    t += 2000
    expect(s.pending('t-63a9291b')).toBeUndefined()
  })

  it('卡面那几句话:说清找到了什么、为什么还没到;到了说到了', () => {
    expect(notDeliveredNote('官网逐字稿.md', DELIVERY_WHY_WAITING_TAP))
      .toBe(`找到了「官网逐字稿.md」,但还没送到你手机:${DELIVERY_WHY_WAITING_TAP}`)
    expect(notDeliveredNote(undefined, DELIVERY_WHY_NOT_SENT)).toBe(`还没送到你手机:${DELIVERY_WHY_NOT_SENT}`)
    expect(deliveredNote('官网逐字稿.md', 2048)).toContain('已经到你手机上了')
    // 回给事务官那一句里**必须**有「等传输回执」—— 10-04 它正是在这一步说成了「办完了」。
    expect(sendFileNote('官网逐字稿.md', 'Ben 的手机')).toContain('等传输回执')
  })
})

describe('② 收尾那一刻:回执没到,不许 done、不许「只是问了一句」', () => {
  const task: TaskView = {
    id: 't-63a9291b',
    title: '官网逐字稿,这份文件发到我这个手机上。',
    status: 'doing',
    direction: 'mine',
    created_at: '2026-10-04T09:16:00.000Z',
    updated_at: '2026-10-04T09:16:00.000Z',
    conversation: { agent: 'dsh', session_id: 'session-d0d457fa' },
  } as unknown as TaskView
  const end = { kind: 'done', ts: Math.floor(Date.parse('2026-10-04T09:40:00Z') / 1000), filesChanged: 0 } as never

  it('★ 10-04 那一幕:没有这一问时它被收成「完成 · 只是问了一句」', () => {
    const was = itemTransitionOnSessionEnd(task, end, '已经放到事务官文件夹了,你在手机上再打一句「把官网逐字稿发我」')
    expect(was?.status).toBe('done')
    expect(was?.update.note).toBe(CASUAL_ASK_NOTE)
  })

  it('有这一问:卡进「阻塞 · 等你点那张卡」,卡面如实写还没送到', () => {
    const next = itemTransitionOnSessionEnd(task, end, '找到了', {
      what: '官网逐字稿.md',
      why: DELIVERY_WHY_WAITING_TAP,
      waitingTap: true,
    })
    expect(next?.status).toBe('blocked')
    expect(next?.update.blockReason).toBe('input')
    expect(next?.update.note).toBe(notDeliveredNote('官网逐字稿.md', DELIVERY_WHY_WAITING_TAP))
    expect(next?.update.casual).toBeUndefined()
  })

  it('推失败那一种是「出错」(走回电里「运行失败」那一档)', () => {
    const next = itemTransitionOnSessionEnd(task, end, '找到了', {
      what: 'X.md',
      why: '电脑上这个文件已经不在了(被挪走或删了)',
      waitingTap: false,
    })
    expect(next?.status).toBe('blocked')
    expect(next?.update.blockReason).toBe('error')
  })

  it('她那段回答本身是在问他时,那一问照旧优先(谁等谁更要紧)', () => {
    const next = itemTransitionOnSessionEnd(task, end, '你要的是 A 还是 B?', {
      what: 'A.md',
      why: DELIVERY_WHY_WAITING_TAP,
      waitingTap: true,
    })
    expect(next?.status).toBe('blocked')
    expect(next?.update.blockReason).toBe('input')
    // 等她回话那一句(不是「还没送到」那一句)。
    expect(next?.update.note).not.toContain('还没送到')
  })

  it('回执到了(台账回 undefined):照旧走老路,一个字不变', () => {
    const next = itemTransitionOnSessionEnd(task, end, '发过去了', undefined)
    expect(next?.status).toBe('done')
    expect(next?.update.note).toBe(CASUAL_ASK_NOTE)
  })
})

describe('③ 第一条消息里那一行:路在哪、不许读源码', () => {
  it('摆了口、摆了送到哪台、明说不许读工作台源码', () => {
    const block = butlerBriefBlock({
      itemId: 't-63a9291b',
      title: SAID,
      baseUrl: 'http://127.0.0.1:8791',
      endpoints: ['POST /butler/send-file'],
      fileWant: { query: '官网逐字稿', device: 'Ben 的手机' },
    })
    expect(block).toContain(FILE_WANT_BRIEF_HEAD)
    expect(block).toContain('POST /butler/send-file')
    expect(block).toContain('Ben 的手机')
    expect(block).toContain('不许去读工作台自己的源码')
    expect(block).toContain('没有传输回执')
  })

  it('这一类事点的技能是「发文件到手机」那一段', () => {
    const skill = butlerSkillForItem({ fileWant: true, skillFile: name => `/home/.dsh/workbench/技能/${name}.md` })
    expect(skill?.name).toBe(WB_SKILL_SEND_FILE)
    expect(skill?.file).toBe(`/home/.dsh/workbench/技能/${WB_SKILL_SEND_FILE}.md`)
  })
})
