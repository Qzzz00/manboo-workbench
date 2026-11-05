// @vitest-environment node
/**
 * **「一扇标准窗口都没有」不该退回让她自己打字 —— 先把窗开出来再送**(2026-10-01,卡 AX)。
 *
 * 现场(维护者 19:5x,本机 0.4.79/0.4.80):「在手机端待确认回复成功了,但是直接在最近会话中
 * 找到会话再发信息,又是失败,又让我自己来电脑上打字」。`~/.dsh/logs/web.stdout.log` 里同一条
 * Claude 桌面会话紧挨着四行:`[answer]` 送进去了,接着三行 `[relay]` 都是
 * 「找不到窗口:com.anthropic.claudefordesktop 在跑,但一扇标准窗口都没有」。
 *
 * 根因:窗口那只手**叫一次台前就送**,壳回 `no_window` 就当场失败 —— 一次不等、一次不重开。
 * 而窗口露出来要时间:藏起来的 App 辅助功能一扇窗都列不出(卡 MQ2 量过),`unhide` / `open -b` /
 * 换桌面之后那张清单要一两秒才跟上(壳里只等 250ms)。
 *
 * 守(「答」与「捎话」**同一套**,这份用例两条路逐条对照):
 * ① 壳回 `no_window` → 深链 / `open -b` 把窗真正开出来、等一拍、再送,最多 `NO_WINDOW_WAKE_TRIES` 回;
 * ② 中途窗露出来了 → 照样送进去(她不用到电脑上打字);
 * ③ 到顶还是没有 → 如实说,并且把「又开了几回」说出来(**不假装送到了**);
 * ④ 别的失败(输入框没接住这类)**一回都不重开**:那是那扇窗的事实,重开只会多打一遍字;
 * ⑤ 这一下**没发给壳几回**也数得出来(日志那一行的依据)。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):六只手删了,这一圈只在
 * `engine/adapters/window.ts` 一处(`withWindowWake`),答与捎话都经**同一条引擎**。
 * 回包上那一格结构化的 `front` 没有了(契约里 `JobResult` 没有它)——
 * 「又开了几回窗」那句实话照旧在 `why` 里(`noWindowWhy`),引擎记的那一行带着它。
 */
import { describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { SessionView } from '../src/protocol.ts'
import { NO_WINDOW_GAVE_UP, NO_WINDOW_WAKE_TRIES, isNoWindowReason } from '../src/server/windowWake.ts'
import { logStampOf } from '../src/server/logStamp.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness } from './helpers/engineHarness.ts'

/** 壳那句原话(`SendTextPolicy.Failure.noWindow`,workbench-app/Sources/SendTextPolicy.swift)。 */
const NO_WINDOW = '找不到窗口:com.anthropic.claudefordesktop 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)'
/** 别的失败一例(`SendTextPolicy.Failure.writeRejected`):这一类不重开。 */
const WRITE_REJECTED = '输入框没接住这段话:com.anthropic.claudefordesktop 写 AXValue 回 -25200'

/** 真机那条会话:Claude 桌面(Code 页签)、正在跑、手机从「最近会话」里点开它。 */
const session: SessionView = {
  agent: 'claude',
  session_id: 'aceefe64',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 90,
  unread: false,
  updated_at: '2026-10-01T11:52:00.000Z',
  title: '捎话找不到窗口',
  ask: {
    kind: 'approve',
    question: '要我照这一条改吗?',
    since: '2026-10-01T11:50:00.000Z',
    quote: '要我照这一条改吗?',
    by: 'rules',
  },
}

function rig(options: { noWindowTimes: number, error?: string, deepLink?: boolean, rejects?: boolean }) {
  let sends = 0
  let afterSend = false
  const opened: string[] = []
  const openedApps: string[] = []
  const h = engineHarness({
    installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', running: true }],
    // 深链要桌面 App 里那个 `local_…` 编号;读不到就没有深链(那一路靠 `open -b`)。
    ...(options.deepLink === false ? {} : { hostIdOf: () => 'local_aceefe64' }),
    openUrl: async (url: string) => { opened.push(url); return { ok: true } },
    openApp: async (bundleId: string) => { openedApps.push(bundleId); return { ok: true } },
    nameOf: sessionAgentName,
    reply: (req: HelperRequest) => {
      if (req.op === 'send_text') {
        sends += 1
        if (sends <= options.noWindowTimes) {
          // 真壳(helperChannel)回 ok:false 时是 **reject 一个 Error**,不是回 { ok:false }。
          if (options.rejects === true) throw new Error(options.error ?? NO_WINDOW)
          return { ok: false, error: options.error ?? NO_WINDOW }
        }
        afterSend = true
        return { submitted: true, method: 'ax' }
      }
      if (req.op === 'read_reply') {
        const marker = (req as { marker?: string }).marker ?? ''
        // 认那段对话(记号来自那一问 / 标题)一直认不出;她那句话送完才读得到。
        const mine = afterSend && marker !== '' && !marker.startsWith('要我照这一条改')
        return { found: mine, busy: false, texts: [] }
      }
      return {}
    },
  })
  const service = createSessionJobs({
    engine: h.engine,
    registry: h.registry,
    sessions: () => [session],
    entryOf: () => 'claude-desktop',
    hostIdOf: () => 'local_aceefe64',
    agentName: sessionAgentName,
  })
  return { service, opened, openedApps, sends: () => sends, requests: h.requests, lines: h.lines }
}

describe('撞上「一扇标准窗口都没有」:先把窗开出来再送', () => {
  it('★捎话:壳头两次说一扇窗都没有 → 重开两回、第三次送进去了(她不用到电脑上打字)', async () => {
    const r = rig({ noWindowTimes: 2 })
    const got = await r.service.relay('claude', 'aceefe64', '现在进行到什么情况')
    expect(got.ok).toBe(true)
    expect(r.sends()).toBe(3)
    // 第一次开到前台 + 两回重开,全走深链(它能开到那一段)
    expect(r.opened).toEqual(Array.from({ length: 3 }, () => 'claude://code/continue?session=local_aceefe64'))
  })

  it('★答:同一套 —— 两次没窗口照样重开、照样送进去(两条路对照)', async () => {
    const r = rig({ noWindowTimes: 2 })
    const got = await r.service.answer('claude', 'aceefe64', '可以,就这么改')
    expect(got).toMatchObject({ ok: true, route: 'window' })
    expect(r.sends()).toBe(3)
  })

  it('★一直没窗口:答与捎话**同一个结局** —— 如实说,而且说出又开了几回,一个字不假装', async () => {
    const asked = rig({ noWindowTimes: 99 })
    const answer = await asked.service.answer('claude', 'aceefe64', '可以,就这么改')
    const relayed = rig({ noWindowTimes: 99 })
    const relay = await relayed.service.relay('claude', 'aceefe64', '现在进行到什么情况')
    // 上限:第一次 + NO_WINDOW_WAKE_TRIES 回,不无限重开
    expect(asked.sends()).toBe(1 + NO_WINDOW_WAKE_TRIES)
    expect(relayed.sends()).toBe(1 + NO_WINDOW_WAKE_TRIES)
    expect(answer.ok).toBe(false)
    expect(relay.ok).toBe(false)
    for (const one of [answer, relay]) {
      expect(one).toMatchObject({ ok: false, status: 200, where: 'desk' })
      const why = !one.ok && one.status === 200 ? one.why : ''
      expect(why).toContain('一扇标准窗口都没有')
      expect(why).toContain(NO_WINDOW_GAVE_UP)
    }
    // 引擎记的那一行也带着这句实话(日志那一行从此只有这一处)
    expect(asked.lines.join('\n')).toContain(NO_WINDOW_GAVE_UP)
  })

  it('★没有深链的那一刻(读不到 local_… 编号):走 `open -b` 把它的窗开出来,再送', async () => {
    const r = rig({ noWindowTimes: 1, deepLink: false })
    const got = await r.service.relay('claude', 'aceefe64', '现在进行到什么情况')
    expect(got.ok).toBe(true)
    expect(r.opened).toEqual([])
    expect(r.openedApps).toEqual(['com.anthropic.claudefordesktop'])
    expect(r.sends()).toBe(2)
  })

  it('★真壳的说法:「没窗口」是 reject 出来的(不是回 ok:false)—— 答与捎话照样重开、照样送进去', async () => {
    // 10-01 20:57 真机(0.4.81):两次 [answer] 都是「开到前台:深链,壳回了别的错」、一回没重开 ——
    // 因为真壳把失败 reject 成异常,直接落进最外层 catch,绕过了重开那一圈。
    for (const go of [
      (r: ReturnType<typeof rig>) => r.service.answer('claude', 'aceefe64', '可以,就这么改'),
      (r: ReturnType<typeof rig>) => r.service.relay('claude', 'aceefe64', '现在进行到什么情况'),
    ]) {
      const r = rig({ noWindowTimes: 2, rejects: true })
      const got = await go(r)
      expect(got.ok).toBe(true)
      expect(r.sends()).toBe(3)
    }
  })

  it('★真壳的说法:一直 reject「没窗口」→ 到顶如实说(说出又开了几回)', async () => {
    const r = rig({ noWindowTimes: 99, rejects: true })
    const got = await r.service.answer('claude', 'aceefe64', '可以,就这么改')
    expect(got.ok).toBe(false)
    expect(r.sends()).toBe(1 + NO_WINDOW_WAKE_TRIES)
    expect(!got.ok && got.status === 200 ? got.why : '').toContain(NO_WINDOW_GAVE_UP)
  })

  it('★别的失败(输入框没接住)一回都不重开:那是那扇窗的事实,重开只会多打一遍字', async () => {
    const r = rig({ noWindowTimes: 99, error: WRITE_REJECTED })
    const got = await r.service.relay('claude', 'aceefe64', '现在进行到什么情况')
    expect(got.ok).toBe(false)
    expect(r.sends()).toBe(1)
    expect(r.opened).toEqual(['claude://code/continue?session=local_aceefe64'])
    expect(!got.ok && got.status === 200 ? got.why : '').not.toContain(NO_WINDOW_GAVE_UP)
  })
})

describe('归类与日志那一行', () => {
  it('★「一扇标准窗口都没有」「没在运行」都算没窗口;别的不算(归类只在 classifyFailure 一处)', () => {
    expect(isNoWindowReason(NO_WINDOW)).toBe(true)
    expect(isNoWindowReason('找不到窗口:com.anthropic.claudefordesktop 没在运行')).toBe(true)
    expect(isNoWindowReason(WRITE_REJECTED)).toBe(false)
  })

  it('★日志行前面那个时间(真机上两条路对时间就靠它)', () => {
    expect(logStampOf(new Date(2026, 9, 1, 19, 52, 7))).toBe('19:52:07')
    expect(logStampOf(new Date(2026, 9, 1, 9, 5, 0))).toBe('09:05:00')
  })
})
