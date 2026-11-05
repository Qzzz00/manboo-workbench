// @vitest-environment node
/**
 * ★ **手机、电话、账上那一行:同一句话**(2026-10-03,卡「锁屏时窗口型的家送不进」第 3 条)。
 *
 * 09:04 那一回她在手机上看到的是「找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有
 * (可能最小化了或只剩菜单栏图标)」—— 包标识她不认,而且这句话**把她指错了方向**
 * (她会去查 Kimi,其实是电脑锁着屏)。
 *
 * 这一份端到端跑(**假壳 + 真引擎 + 真会话服务 + 真派活服务**),钉住:
 * ① 替她答 / 捎话的回包里那一句 = 引擎那一句(`screenLock.screenLockedSay` 一处),
 *    **前面不接「这一问得到电脑上的 X 里回」**,而且 `reveal:false`(锁屏时那颗键点了也没用);
 * ② 派活回包同一句,`kind:'screen_locked'`,而且**卡上一个字不改**(它在等,不是失败);
 * ③ `jobs.jsonl` 那一行的 `why` 也是同一句;
 * ④ 包标识、「一扇标准窗口都没有」那种话一个字都不出现在给她看的那一句里。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { createLockQueue } from '../src/server/engine/lockQueue.ts'
import { SCREEN_LOCK_MARK } from '../src/server/screenLock.ts'
import type { RelaySessionView } from '../src/server/sessionRelay.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const FAMILY = 'kimi'
const BUNDLE = 'com.moonshot.kimichat'
const SESSION = 'window:825f1900'
/** 她 09:04 在手机「等你确认」里回的那一句(形状)。 */
const SAID = '就按第二个方案来,封面用那张海边的'

const session: RelaySessionView = {
  agent: FAMILY,
  session_id: SESSION,
  project: 'Kimi',
  status: 'waiting',
  elapsed_sec: 60,
  unread: true,
  updated_at: '2026-10-03T01:04:00.000Z',
  title: '选哪个方案',
  ask: { kind: 'choose', question: '你要哪个方案?', quote: '你要哪个方案?', by: 'model', since: '2026-10-03T01:03:00.000Z' },
}

function harness() {
  const queue = createLockQueue()
  const h = engineHarness({
    nameOf: () => 'Kimi',
    bundleOf: () => BUNDLE,
    installed: () => [{ bundle_id: BUNDLE, name: 'Kimi', running: true }],
    machine: [{ bundle_id: BUNDLE, running: true }],
    screenLocked: () => true,
    lockQueue: { add: job => queue.add(job) },
  })
  const sessions = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    // 生产里这一格是「文件型那几条 + 窗口型登记表里那几条」(见 index.ts 那一处的注释)。
    sessions: () => [session] as unknown as readonly SessionView[],
    windowSessions: () => [session],
    bundleOf: () => BUNDLE,
    agentName: () => 'Kimi',
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    sessionIdsOf: () => [],
    targets: () => [{
      id: FAMILY,
      title: 'Kimi',
      bundle_id: BUNDLE,
      app_running: true,
      hands: ['window'],
      aliases: [],
      from_registry: true,
    }] as unknown as readonly DispatchTarget[],
    unreadable: () => [],
    now: () => new Date('2026-10-03T01:04:00.000Z'),
  })
  return { ...h, queue, sessions, dispatch }
}

/** 给她看的那一句话里不许出现的东西(机器的话)。 */
function noMachineTalk(said: string | undefined): void {
  expect(said).toBeDefined()
  expect(said).not.toContain(BUNDLE)
  expect(said).not.toContain('一扇标准窗口都没有')
  expect(said).not.toContain('AX')
}

describe('① 替她答 / 捎话:手机上看到的那一句', () => {
  it('★★那一句说的是「电脑锁着屏」,而且带下一步', async () => {
    const h = harness()
    const out = await h.sessions.answer(FAMILY, SESSION, SAID)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.status).toBe(200)
    if (out.status !== 200) return
    expect(out.why).toContain(SCREEN_LOCK_MARK)
    expect(out.why).toContain('解锁了我就把这句送进去')
    noMachineTalk(out.why)
  })

  it('★★**前面不接**「这一问得到电脑上的 Kimi 里回」(她这会儿看不见屏幕)', async () => {
    const h = harness()
    const out = await h.sessions.answer(FAMILY, SESSION, SAID)
    if (out.ok || out.status !== 200) throw new Error('这一下应该是 200 + 没送')
    expect(out.why.startsWith(SCREEN_LOCK_MARK)).toBe(true)
    expect(out.why).not.toContain('到电脑上')
  })

  it('★★`reveal:false`:「去回答」那颗键摆不出来(锁屏时开窗一下都没用)', async () => {
    const h = harness()
    const out = await h.sessions.answer(FAMILY, SESSION, SAID)
    if (out.ok || out.status !== 200) throw new Error('这一下应该是 200 + 没送')
    expect(out.reveal).toBe(false)
  })

  it('★★捎话那一路同一句(手机「最近会话」与电话里念的是它)', async () => {
    const h = harness()
    const out = await h.sessions.relay(FAMILY, SESSION, SAID)
    expect(out.ok).toBe(false)
    if (out.ok || out.status !== 200) throw new Error('这一下应该是 200 + 没送')
    expect(out.why).toContain(SCREEN_LOCK_MARK)
    expect(out.reveal).toBe(false)
    // 不许走「按了发送、没核上」那一档 —— 那一档会登记一通回电,而这一下一个字都没发出去
    expect(out.unconfirmed).toBeUndefined()
  })

  it('★★这两下都排进了队(她一解锁就送)', async () => {
    const h = harness()
    await h.sessions.answer(FAMILY, SESSION, SAID)
    await h.sessions.relay(FAMILY, SESSION, '再加一句:别用竖版')
    expect(h.queue.list()).toHaveLength(2)
    expect(h.queue.list().map(one => one.job.kind)).toEqual(['answer', 'relay'])
  })

  it('★★一个 op 都没发给壳(09:04 那 5 次 `open -b` 不再有)', async () => {
    const h = harness()
    await h.sessions.answer(FAMILY, SESSION, SAID)
    expect(h.requests).toEqual([])
  })
})

describe('② 派活(没带 waitUnlock 的那几条路):同一句 + 那一格(上一层据此挂「等你处理」),**不排队**', () => {
  it('★★回包同一句 + `kind:screen_locked` + `screen_locked`', async () => {
    const h = harness()
    const out = await h.dispatch.send({ family: FAMILY, text: '帮我把这篇的封面做三版', submit: true })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('screen_locked')
    expect(out.screen_locked).toBe(true)
    expect(out.reason).toContain(SCREEN_LOCK_MARK)
    noMachineTalk(out.reason)
  })

  it('★★界面上点「送进窗口」那一类不排队:解锁后没人接得住「回到派活流程」那一半', async () => {
    const h = harness()
    await h.dispatch.send({ family: FAMILY, text: '帮我把这篇的封面做三版', submit: true })
    expect(h.queue.list()).toEqual([])
    // 卡还在、理由是人话、她点一下就能重派 —— 派活这一种没有东西被弄丢(她那句话才会丢)
    expect(h.dispatch).toBeDefined()
  })

  it('★那一句里不许说「解锁了我就送」(没排上就不许许这个诺)', async () => {
    const h = harness()
    const out = await h.dispatch.send({ family: FAMILY, text: '帮我把这篇的封面做三版', submit: true })
    expect(out.reason).toContain('解锁了再叫我一次')
    expect(out.reason).not.toContain('我就把这句送进去')
  })
})

describe('②b 派活从 dispatchRun 那一条来(带事项 id + waitUnlock):**排队**(2026-10-12)', () => {
  it('★★排进队、回包带 lock_queued、那一句说「解锁了我就把这件派出去」', async () => {
    const h = harness()
    const out = await h.dispatch.send({ family: FAMILY, job: 't-cover', waitUnlock: true, text: '帮我把这篇的封面做三版', submit: true })
    expect(out.screen_locked).toBe(true)
    expect(out.lock_queued).toBe(true)
    expect(out.reason).toContain('解锁了我就把这件派出去')
    expect(h.queue.list().map(one => [one.job.itemId, one.job.kind, one.job.waitUnlock])).toEqual([['t-cover', 'dispatch', true]])
    noMachineTalk(out.reason)
  })

  it('★同一件事连派两次 → 队里只有一条', async () => {
    const h = harness()
    await h.dispatch.send({ family: FAMILY, job: 't-cover', waitUnlock: true, text: '第一次', submit: true })
    await h.dispatch.send({ family: FAMILY, job: 't-cover', waitUnlock: true, text: '又点了一下', submit: true })
    expect(h.queue.list()).toHaveLength(1)
  })
})

describe('③ 账上那一行:同一句,而且这件事**没有收场**', () => {
  it('★★`jobs.jsonl` 那一行记 `waiting` + 同一句 why', async () => {
    const h = harness()
    await h.sessions.answer(FAMILY, SESSION, SAID)
    const waiting = h.events().find(one => one.step === 'waiting')
    expect(waiting, '账上要有「等着」那一行').toBeDefined()
    expect(waiting?.why).toContain(SCREEN_LOCK_MARK)
    expect(h.events().some(one => one.step === 'not_sent')).toBe(false)
  })

  it('★★四步表上**没有收场那一格**(记了收场,解锁重送会被闸拦下)', async () => {
    const h = harness()
    await h.sessions.answer(FAMILY, SESSION, SAID)
    const key = h.events().find(one => one.step === 'waiting')?.job as string
    expect(h.log.trace(key).finished).toBeUndefined()
    expect(h.log.trace(key).delivered).toBeUndefined()
    expect(h.log.trace(key).assigned).toBeDefined()
  })
})
