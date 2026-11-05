/** 电脑完成认识与首次有用后，最后可选连接手机和座机；沿用已有服务端进度。 */
import { ModelPanel } from '../ModelPanel.tsx'
import { CredentialPanel } from '../CredentialPanel.tsx'
import { Composer } from '../composer/Composer.tsx'
import { BEAM, onboardingFx } from '../fx/fxModel.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ONBOARDING_RESTARTING_NOTE, type OnboardingStateView, type WorkbenchState } from '../../protocol.ts'
import type { SetupApkView } from '../../server/setup/types.ts'
import { PairQr } from '../PairQr.tsx'
import { fetchSetupApk, setLanAccess, startPairing } from '../setup/setupApi.ts'
import {
  answerOnboarding, fetchOnboardingDetail, fetchOnboardingTurns, markFirstRunDone, sayOnboarding,
  setOnboardingLeader, startOnboardingSessionThroughRestart, type OnboardingDetailView, type OnboardingTurnView,
} from './firstRunApi.ts'
import {
  onboardingLeaderOf, phoneIdle, phoneProgressText, PHONE_IDLE_ASK, PHONE_LEAD_TITLE,
} from './onboardingLead.ts'
import { useMeName } from '../meName.tsx'
import { OnboardingOrb } from './OnboardingOrb.tsx'
import { chatHerLine } from './chatHerLine.ts'
import {
  readDialogue, scanProgressOf, speakMsFor, stageViewOf, type ScanProgress, type StageView,
} from './onboardingStage.ts'
import { useReplyWindow } from './scanHold.ts'
import { FIRST_RUN_HELLO, FirstTryStep, FirstUseStep, firstUseLine } from './FirstUseStep.tsx'

/** 事务官在这一屏上说的第一句(Ben 亲笔那句里"问称呼"的部分留给称呼那一屏)。 */
export { FIRST_RUN_HELLO } from './FirstUseStep.tsx'
/** 打过招呼之后,出场那一屏只问这一句。 */
export const INTRO_AFTER_HELLO = '好。我们从哪儿开始?'
/** 称呼那一屏上的问句(设计-引导流程 ① 开场白,Ben 2026-09-11 亲笔的后半句)。 */
export const FIRST_RUN_ASK_NAME = '为了后面的工作能顺利开展,我需要对你和你正在做的事有一些了解。首先,你希望我怎么称呼你?'

/**
 * `firstuse`(2026-10-21,卡「引导三件事」):五问走完之后的「第一次有用」—— 三件主路各成一次才收尾进工作台。
 * 服务端没给 `/state.first_use`(老工作台)时不出现,引导走完照旧直接进。
 */
export type FirstRunStep = 'phone' | 'pair' | 'intro' | 'nickname' | 'chat' | 'firstuse' | 'devices' | 'config'

/** 对话轮询间隔。事务官一句话要想几秒,两秒一问够灵敏也不吵。 */
const TURNS_POLL_MS = 2000

export interface FirstRunFlowProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** /state 那一份:配对二维码、已配对设备、局域网开关都从它来(上层每拍轮询)。 */
  state: WorkbenchState
  /** 走完或跳过(旗子已经写了)。 */
  onDone: () => void
  /** 测试传 0 表示不起定时器。 */
  turnsPollMs?: number
  /** 从哪一屏开始。默认第一屏;测试用。 */
  initialStep?: FirstRunStep
  /** 现在几点。只用于「手机那边十分钟没动静」那一句;测试注入。 */
  now?: () => number
}

export function FirstRunFlow({ baseUrl, fetchImpl, state, onDone, turnsPollMs, initialStep, now }: FirstRunFlowProps) {
  const doFetch = fetchImpl ?? fetch
  const pollMs = turnsPollMs ?? TURNS_POLL_MS
  const [step, setStep] = useState<FirstRunStep>(initialStep ?? 'intro')
  const beforeConfig = useRef<FirstRunStep>('intro')
  const [apk, setApk] = useState<SetupApkView | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * DSH 正在为认新凭证重启(2026-09-24):不是出错,只挂一行灰字 + 球的等待态,重启完自动接着往下走、这一行消失。
   * restartedAt:那一下是几点 —— 重启之后她的第一句要冷启动,等得久时状态行说得出为什么(stageViewOf 的 coldStart)。
   */
  const [preparing, setPreparing] = useState(false)
  const [restartedAt, setRestartedAt] = useState<number | undefined>(undefined)
  /** 进配对屏那一刻已经有几台设备:多出来的那一台就是刚配上的。 */
  const [devicesAtStart, setDevicesAtStart] = useState<number | undefined>(undefined)
  const [paired, setPaired] = useState(false)
  /** ③ 那两颗按钮选的是哪一支;称呼答完之后才交给阶段机。 */
  const [mode, setMode] = useState<'existing' | 'fresh' | undefined>(undefined)
  const [nickname, setNickname] = useState('')
  const [turns, setTurns] = useState<readonly OnboardingTurnView[]>([])
  const [seed, setSeed] = useState<string | undefined>(undefined)
  const [thinking, setThinking] = useState(false)
  const [draft, setDraft] = useState('')
  /** 回合表上的几面旗子(2026-09-23):出错、会话没了、阶段、扫描进度。 */
  const [failed, setFailed] = useState(false)
  const [ended, setEnded] = useState(false)
  const [turnStage, setTurnStage] = useState<string | undefined>(undefined)
  const [turnScan, setTurnScan] = useState<ScanProgress | undefined>(undefined)
  /** 你最后一次在这一屏上说话是几点(等她回话等太久 → 一句人话)。 */
  const [saidAt, setSaidAt] = useState<number | undefined>(undefined)
  const [showHistory, setShowHistory] = useState(false)
  /** /onboarding/turns 说阶段机走完了。 */
  const [turnsDone, setTurnsDone] = useState(false)
  /** 「想先试哪一件」这一回答过了(说「都行」服务端不记哪一件,这里记一下别再问)。 */
  const [firstTryDone, setFirstTryDone] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const devices = state.devices ?? []

  // 旧版本仍在进行的手机引导显式 leader=phone 时保留接手入口；配过设备不再自动转手机。
  const onboardingView = state.onboarding
  const leader = onboardingLeaderOf({
    ...(onboardingView?.leader === undefined ? {} : { leader: onboardingView.leader }),
    phonePaired: devices.length > 0,
  })
  const phoneLeads = leader === 'phone' && onboardingView !== undefined && !onboardingView.done
  const idle = phoneIdle({
    ...(onboardingView?.leader_at === undefined ? {} : { leaderAt: onboardingView.leader_at }),
    now: (now ?? Date.now)(),
  })

  /** 「改在电脑上做」:落一笔 desktop,这一屏立刻变回原来那三屏。 */
  async function takeOverOnDesktop(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await setOnboardingLeader(baseUrl, 'desktop', doFetch)
      if (mounted.current) setStep('intro')
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '改不了主导方')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  // 手机端的包:拉一次。拉不到不挡路(那一屏自己会说"还没出过包")。
  useEffect(() => {
    void fetchSetupApk(baseUrl, doFetch).then((view) => { if (mounted.current) setApk(view) }).catch(() => {})
  }, [baseUrl, doFetch])

  // 配对屏:多出一台设备就是配上了。**只认"比进来时多"**,不认"有设备" ——
  // 以前配过手机的人重走一遍首次流程时,不该一进配对屏就说"配好了"。
  useEffect(() => {
    if (step !== 'pair' || devicesAtStart === undefined) return
    if (devices.length > devicesAtStart) setPaired(true)
  }, [step, devices.length, devicesAtStart])

  /** 只有引导 done 才走到这里(见下面那条 effect);只写一次。 */
  const finishing = useRef(false)
  const finish = useCallback(async () => {
    if (finishing.current) return
    finishing.current = true
    setError(null)
    try {
      await markFirstRunDone(baseUrl, true, doFetch)
      onDone()
    } catch (err) {
      finishing.current = false
      setError(err instanceof Error ? err.message : '保存失败，请重试')
    }
  }, [baseUrl, doFetch, onDone])

  // 认识用户完成后，先试电脑两项，再选择是否连接设备。
  const guideDone = onboardingView?.done === true || turnsDone
  const firstUse = state.first_use
  const firstUseOpen = firstUse !== undefined && firstUse.closed_at === undefined
  useEffect(() => {
    if (!guideDone || step === 'phone' || step === 'pair' || step === 'firstuse' || step === 'devices' || step === 'config') return
    if (firstUseOpen) { setStep('firstuse'); return }
    setStep('devices')
  }, [guideDone, step, firstUseOpen])
  /** 五问前那一问:服务端给了 `first_use`、还没答过、引导还没走完。 */
  const needFirstTry = firstUse !== undefined && firstUse.asked_at === undefined && !firstTryDone && !guideDone

  async function enterPairing(): Promise<void> {
    setBusy(true)
    setError(null)
    setDevicesAtStart(devices.length)
    setPaired(false)
    setStep('pair')
    try {
      // 先把开关打开再生成码:开关关着时手机连不上,二维码扫了也是白扫。
      await setLanAccess(baseUrl, true, doFetch)
      await startPairing(baseUrl, doFetch)
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '生成配对码失败')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  /** 交一项答案;阶段机说什么原样显示。 */
  async function answer(stage: string, key: string, value: unknown): Promise<boolean> {
    try {
      await answerOnboarding(baseUrl, { stage, key, value }, doFetch)
      return true
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '这一步没答上')
      return false
    }
  }

  /**
   * ——— 先记界面上答的,再开引导会话(2026-09-24,卡 fix/firstrun-session-after-answers) ———
   *
   * 会话第一条消息是**开会话那一刻**按阶段机写的(server/onboardingStages.ts firstMessage):现在在哪一段、
   * 哪几项答过了、开口问哪一题。以前 `pick` 先开会话、称呼与分岔后交 —— 那一刻阶段还在开场,
   * 模型拿到的是「原样念开场白、问称呼」那一版;称呼与分岔是按钮流直接交给阶段机的,模型一概不知道。
   * 于是对话屏上摆着布局那一问,他答「产品研发」,她却接着开场问「我该怎么称呼你呢」(维护者 09-24「称呼问了两遍」,
   * 统筹 14:32 在 0.2.81 上复现)。
   *
   * 所以:称呼还没答 → 先去称呼那一屏,**这时不开会话**;称呼那一屏答完,把称呼与已选的分岔都记上**之后**才开;
   * 称呼已经答过的那条路,先记分岔再开。开会话那一步的「稍等,正在准备…」(DSH 为认新凭证重启)照旧,
   * 在哪一屏开就在哪一屏显示。
   */
  async function recordThenOpen(
    detail: OnboardingDetailView,
    answers: { nickname?: string, mode?: 'existing' | 'fresh' },
  ): Promise<void> {
    // 照阶段机**现在**的样子只补还没记的:上一次会话没开成、他再点一次时,称呼 / 分岔可能已经记上了,
    // 再交一遍旧阶段的答案会被 409(阶段已经往前走了)。
    // 哪一项没记上(阶段机回了人话,已经上屏)就停在这儿、不开会话 —— 开了也是一条按旧阶段写的会话。
    let stage = detail.stage
    if (stage === 'opening' && answers.nickname !== undefined) {
      if (!(await answer('opening', 'nickname', answers.nickname))) return
      stage = 'branch'
    }
    if (stage === 'branch' && answers.mode !== undefined) {
      if (!(await answer('branch', 'mode', answers.mode))) return
    }
    if (!mounted.current) return
    await startOnboardingSessionThroughRestart(baseUrl, doFetch, {
      onRestarting: () => { if (mounted.current) { setPreparing(true); setRestartedAt((now ?? Date.now)()) } },
    })
    if (!mounted.current) return
    setPreparing(false)
    setStep('chat')
  }

  async function resume(): Promise<void> {
    setBusy(true)
    setError(null)
    try { await recordThenOpen(await fetchOnboardingDetail(baseUrl, doFetch), {}) }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : '继续引导失败，请重试') }
    finally { if (mounted.current) { setBusy(false); setPreparing(false) } }
  }

  /** ③ 两颗按钮(= ② 分岔):称呼还没答就先去问称呼(不开会话);答过了就记分岔、开会话。 */
  async function pick(which: 'existing' | 'fresh'): Promise<void> {
    setBusy(true)
    setError(null)
    setMode(which)
    try {
      const detail = await fetchOnboardingDetail(baseUrl, doFetch)
      if (!mounted.current) return
      if (detail.stage === 'opening' && detail.nickname === undefined) {
        setStep('nickname')
        return
      }
      await recordThenOpen(detail, { mode: which })
    }
    catch (err) {
      // 引导没启用(没配 WORKBENCH_BUTLER_CWD)、会话通道没接上,都会走到这里。
      if (mounted.current) setError(err instanceof Error ? err.message : '开始引导失败')
    }
    finally {
      if (mounted.current) { setBusy(false); setPreparing(false) }
    }
  }

  /** 称呼那一屏「就这么叫」:记称呼 → 记分岔 → 这时才开会话。 */
  async function submitNickname(): Promise<void> {
    const value = nickname.trim()
    if (value === '') { setError('先告诉我怎么称呼你'); return }
    setBusy(true)
    setError(null)
    try {
      const detail = await fetchOnboardingDetail(baseUrl, doFetch)
      if (!mounted.current) return
      await recordThenOpen(detail, { nickname: value, ...(mode === undefined ? {} : { mode }) })
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '开始引导失败')
    }
    finally {
      if (mounted.current) { setBusy(false); setPreparing(false) }
    }
  }

  // 对话屏:轮询回合。`after` 只问新的,不重复搬运整段对话。
  const lastSeq = turns.length === 0 ? 0 : (turns[turns.length - 1]?.seq ?? 0)
  const readTurns = useCallback(async (after: number) => {
    try {
      const view = await fetchOnboardingTurns(baseUrl, after, doFetch)
      if (!mounted.current) return
      if (view.turns.length > 0) setTurns(prev => [...prev, ...view.turns])
      setThinking(view.busy)
      setSeed(view.seed)
      setFailed(view.failed === true)
      setEnded(view.ended === true)
      setTurnStage(view.stage)
      setTurnsDone(view.done === true)
      setTurnScan(scanProgressOf(view))
    }
    catch {
      // 下一拍再问:对话断一拍不该在屏上跳一句红字。
    }
  }, [baseUrl, doFetch])

  useEffect(() => {
    if (step !== 'chat') return
    void readTurns(0)
  }, [step, readTurns])

  useEffect(() => {
    if (step !== 'chat' || pollMs === 0) return
    const timer = window.setInterval(() => { void readTurns(lastSeq) }, pollMs)
    return () => window.clearInterval(timer)
  }, [step, pollMs, lastSeq, readTurns])

  /** 「再发一次」:等太久时把你刚才那句原样再说一遍(2026-09-24)。 */
  async function resend(): Promise<void> {
    const text = readDialogue(turns).you?.text
    if (text === undefined || text === '') return
    setBusy(true)
    setError(null)
    try {
      await sayOnboarding(baseUrl, text, doFetch)
      if (mounted.current) setSaidAt(clock())
      await readTurns(lastSeq)
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '这句话没说出去')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (text === '') return
    setBusy(true)
    setError(null)
    try {
      await sayOnboarding(baseUrl, text, doFetch)
      if (mounted.current) { setDraft(''); setSaidAt(clock()) }
      await readTurns(lastSeq)
    }
    catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '这句话没说出去')
    }
    finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * ——— 粒子球舞台(2026-09-23,维护者:「电脑上的注册之后,粒子球就应该要出现了」) ———
   *
   * 球从第一屏就在,**整段首次流程只有这一颗**(不随换屏重建,画布与动画是连着的):
   * 手机/配对那两屏它小一点让出二维码;事务官出场之后它是主角,她的话做成球下面的字幕。
   * 态怎么定见 onboardingStage.ts(纯函数,有单测);这里只收集信号。
   */
  const clock = now ?? Date.now
  const dialogue = readDialogue(turns)
  const herLine = step === 'firstuse' && firstUse !== undefined ? firstUseLine(firstUse)
    : !phoneLeads && step === 'intro' && needFirstTry ? FIRST_RUN_HELLO
    : !phoneLeads && step === 'intro' ? (firstTryDone ? INTRO_AFTER_HELLO : FIRST_RUN_HELLO)
    : !phoneLeads && step === 'nickname' ? FIRST_RUN_ASK_NAME
      : !phoneLeads && step === 'chat' ? chatHerLine(turns, seed)
        : undefined
  const [speakingUntil, setSpeakingUntil] = useState(0)
  const [, setTick] = useState(0)
  // 她的字幕换了一句 → 球做一段说话动作,时长按字数;到点重画一次回到别的态。
  useEffect(() => {
    if (herLine === undefined || herLine === '') return
    const ms = speakMsFor(herLine)
    setSpeakingUntil(clock() + ms)
    if (pollMs === 0) return
    const timer = window.setTimeout(() => setTick(n => n + 1), ms + 50)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认那句话本身变没变
  }, [herLine])
  // 在等她回话:每 2 秒看一眼有没有等太久(8 秒补一句人话、30 秒给「再发一次」;测试 pollMs=0 时不起定时器,靠注入的 now)。
  useEffect(() => {
    if (step !== 'chat' || !dialogue.waiting || pollMs === 0) return
    const timer = window.setInterval(() => setTick(n => n + 1), 2000)
    return () => window.clearInterval(timer)
  }, [step, dialogue.waiting, pollMs])
  const lastUserAt = [...turns].reverse().find(turn => turn.role === 'user')?.at
  const waitedFrom = saidAt ?? (lastUserAt === undefined ? undefined : Date.parse(lastUserAt))
  /**
   * 「她在找你的项目」那一整段(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait):服务端一动手找,球就是执行中,
   * 一直到**她的下一句**(最后一条事务官回合)出来才回去 —— 那一刻字幕换句,球当场做说话动作(scanHold.ts)。
   */
  const serverScan = turnScan ?? scanProgressOf(onboardingView)
  const herSeq = [...turns].reverse().find(turn => turn.role === 'assistant')?.seq
  const scanWindow = useReplyWindow({
    scan: serverScan,
    her: herSeq === undefined ? undefined : String(herSeq),
    busy: step === 'chat' && thinking,
  }, clock)
  // 窗口收了就不在找(哪怕服务端还报着收掉的那一段 —— 不重开);开着就是那一整段最后的样子。
  const scan = scanWindow.open
    ? { ...(scanWindow.shown ?? { scanning: true }), scanning: true }
    : serverScan?.scanning === true ? { ...serverScan, scanning: false } : serverScan
  const stage = stageViewOf({
    speaking: clock() < speakingUntil,
    busy: step === 'chat' && thinking,
    pending: busy,
    waiting: step === 'chat' && dialogue.waiting,
    drafting: (step === 'chat' ? draft : step === 'nickname' ? nickname : '').trim() !== '',
    ...(turnStage === undefined ? {} : { stage: turnStage }),
    ...(scan === undefined ? {} : { scan }),
    ...(step === 'chat' && dialogue.errorText !== undefined ? { errorText: dialogue.errorText } : {}),
    ...(step === 'chat' ? { failed, ended } : {}),
    ...(waitedFrom === undefined || Number.isNaN(waitedFrom) ? {} : { waitedMs: clock() - waitedFrom }),
    coldStart: (restartedAt !== undefined && clock() - restartedAt < 180_000) || !turns.some(turn => turn.role === 'assistant'),
  })
  // 电脑主路保留大球；较长的配置与首次有用内容在球下滚动。
  const orbSize = step === 'phone' || step === 'pair' ? 'small' : 'large'
  /**
   * 排版(2026-09-23 维护者:「桌面端也很丑...不需要弹窗」):**每一屏都没有卡片框**。
   * 同一片背景、球在上居中,下面是标题 + 一句说明 +(二维码)+ 按钮;对话屏(chat)输入框贴底,
   * 其余屏整组竖直居中。
   */
  const layout = !phoneLeads && step === 'chat' ? 'chat' : 'center'

  return (
    <div className="ben-wb__firstrun ben-wb__onb" role="dialog" aria-modal="true" aria-label="第一次用" data-orb={orbSize} data-step={step} data-cue={stage.cue} data-layout={layout}>
      <OnboardingOrb stage={stage} />
      <div className="ben-wb__onb-body">
        {step === 'config' ? <section className="ben-wb__firstrun-step" aria-label="模型与 AI 来源">
          <ModelPanel baseUrl={baseUrl} fetchImpl={doFetch} />
          <CredentialPanel baseUrl={baseUrl} fetchImpl={doFetch} />
          <button type="button" className="ben-wb__firstrun-alt" onClick={() => setStep(beforeConfig.current)}>返回引导</button>
        </section> : <button type="button" className="ben-wb__firstrun-alt" onClick={() => { beforeConfig.current = step; setStep('config') }}>配置模型与 AI 来源</button>}

        {step === 'phone' && (
          <PhoneStep
            {...(apk === undefined ? {} : { apk })}
            onPair={() => { void enterPairing() }}
            onSkip={() => { setStep(guideDone ? 'devices' : 'intro') }}
          />
        )}

        {step === 'pair' && (
          <PairStep
            state={state}
            paired={paired}
            busy={busy}
            onRegenerate={() => { void enterPairing() }}
            onNext={() => { setStep(guideDone ? 'devices' : 'intro') }}
          />
        )}

        {/*
          手机主导:第 ③ 屏及之后**整段**换成只读进度。放在 intro 之前拦截,
          这样「上一屏还在配对、配上就自动变成在手机上继续」是一步到位的,不会闪一下两颗按钮。
        */}
        {phoneLeads && (step === 'intro' || step === 'nickname' || step === 'chat') && onboardingView !== undefined && (
          <PhoneLeadStep
            view={onboardingView}
            idle={idle}
            busy={busy}
            onTakeOver={() => { void takeOverOnDesktop() }}
          />
        )}

        {!phoneLeads && step === 'intro' && needFirstTry && (
          <FirstTryStep baseUrl={baseUrl} fetchImpl={doFetch} onAnswered={() => setFirstTryDone(true)} />
        )}

        {!phoneLeads && step === 'intro' && onboardingView !== undefined && !['opening', 'done'].includes(onboardingView.stage) && (
          <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => { void resume() }}>继续引导</button>
        )}
        {!phoneLeads && step === 'intro' && !needFirstTry && (
          <IntroStep
            greeted={firstTryDone}
            paired={devices.length > 0}
            busy={busy}
            preparing={preparing}
            onPick={(which) => { void pick(which) }}
          />
        )}

        {!phoneLeads && step === 'nickname' && (
          <section className="ben-wb__firstrun-step" aria-label="事务官问称呼">
            <h1 className="ben-wb__firstrun-ttl ben-wb__onb-sr">事务官</h1>
            <p className="ben-wb__firstrun-say">{FIRST_RUN_ASK_NAME}</p>
            <div className="ben-wb__firstrun-row ben-wb__onb-field">
              <input
                className="ben-wb__firstrun-input"
                aria-label="称呼"
                value={nickname}
                onChange={event => setNickname(event.target.value)}
              />
              <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => { void submitNickname() }}>
                就这么叫
              </button>
            </div>
            {/* 称呼答完才开会话(2026-09-24):那一下 DSH 若为认新凭证重启,灰字就挂在这一屏,与出场屏同一句。 */}
            {preparing && <p className="ben-wb__onb-status ben-wb__onb-preparing" role="status">{ONBOARDING_RESTARTING_NOTE}</p>}
          </section>
        )}

        {!phoneLeads && step === 'chat' && (
          <ChatStep
            turns={turns}
            {...(herLine === undefined ? {} : { her: herLine })}
            {...(dialogue.you === undefined ? {} : { you: dialogue.you.text })}
            stage={stage}
            showHistory={showHistory}
            onToggleHistory={() => setShowHistory(open => !open)}
            draft={draft}
            busy={busy}
            phonePaired={devices.length > 0}
            onDraft={setDraft}
            onSend={() => { void send() }}
            onResend={() => { void resend() }}
          />
        )}

        {step === 'firstuse' && firstUse !== undefined && (
          <FirstUseStep
            view={firstUse}
            desktopOnly
            baseUrl={baseUrl}
            fetchImpl={doFetch}
            onFinish={() => { setStep('devices') }}
          />
        )}

        {step === 'devices' && (
          <section className="ben-wb__firstrun-step" aria-label="可选设备">
            <h1 className="ben-wb__firstrun-ttl">连接手机与座机（可选）</h1>
            <p className="ben-wb__firstrun-sub">电脑上的准备已结束。手机与座机可以稍后在设置中连接，不影响使用工作台。</p>
            {devices.length > 0 && <p className="ben-wb__firstrun-hint">已有 {devices.length} 台设备，保留原有配对。</p>}
            <p className="ben-wb__firstrun-hint">座机需先连接手机，再从手机设置中添加；未开启座机功能时，可在电脑设置中开启。未配置的设备尚未验证通话。</p>
            <div className="ben-wb__firstrun-row">
              <button type="button" className="ben-wb__firstrun-alt" onClick={() => setStep('phone')}>连接手机或座机</button>
              <button type="button" className="ben-wb__firstrun-go" onClick={() => { void finish() }}>稍后再配，进工作台</button>
            </div>
          </section>
        )}
        {error !== null && <p className="ben-wb__firstrun-err" role="alert">{error}</p>}
      </div>
    </div>
  )
}

/** ① 手机端装好了吗?(球 → 标题 → 一句 → 二维码 → 按钮,不套框) */
function PhoneStep({ apk, onPair, onSkip }: {
  apk?: SetupApkView
  onPair: () => void
  onSkip: () => void
}) {
  return (
    <section className="ben-wb__firstrun-step" aria-label="手机端装好了吗">
      <h1 className="ben-wb__firstrun-ttl">手机端装好了吗?</h1>
      <p className="ben-wb__firstrun-sub">
        手机可以接续已支持的工作。配对是可选的，也可以稍后从设置连接。
      </p>
      {apk?.available === true && apk.url !== undefined
        ? (
            <div className="ben-wb__onb-qr">
              <PairQr text={apk.url} px={176} />
              {/*
                二维码底下这一行说的是「这张码在哪儿才扫得通」(2026-09-18)。
                云上那份出了门也能下;局域网那份只在同一个 Wi-Fi 下有效 —— Ben 真机上
                踩的就是后者(「扫码下载是失效的,IP 是局域网」),所以这句非说不可。
              */}
              <p className="ben-wb__firstrun-hint">
                {apk.source === 'cloud' ? '扫码下载(公网)' : '同一 Wi‑Fi 下扫码'}
              </p>
            </div>
          )
        : (
            <p className="ben-wb__firstrun-hint">
              {apk?.available === true
                ? '包出过了,但这会儿没有手机能连上的地址(局域网访问是关着的)。点「已装,去配对」会顺手把它打开。'
                : '暂时没有可下载的手机安装包。可以先进入工作台，之后从设置连接。'}
            </p>
          )}
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" onClick={onPair}>已装,去配对</button>
        <button type="button" className="ben-wb__firstrun-alt" onClick={onSkip}>先不配,纯电脑用</button>
      </div>
    </section>
  )
}

/** ② 配对。二维码与 6 位码跟设置里「手机与设备」那一节是同一套(同一条 /pair/start)。 */
function PairStep({ state, paired, busy, onRegenerate, onNext }: {
  state: WorkbenchState
  paired: boolean
  busy: boolean
  onRegenerate: () => void
  onNext: () => void
}) {
  const pairing = state.pairing
  return (
    <section className="ben-wb__firstrun-step" aria-label="配对">
      <h1 className="ben-wb__firstrun-ttl">{paired ? '配上了' : '在手机上扫一下'}</h1>
      <p className="ben-wb__firstrun-sub">
        {paired
          ? '手机已经认得这台工作台。'
          : '打开手机上的「事务官」,扫这个码就连上了。配上后点击继续。'}
      </p>
      {!paired && pairing !== undefined && (
        <div className="ben-wb__onb-qr">
          {pairing.qr !== undefined && <PairQr text={pairing.qr} px={176} />}
          <p className="ben-wb__firstrun-hint">
            扫不了就在手机上手输:
            <span className="ben-wb__firstrun-code">{pairing.code}</span>
          </p>
        </div>
      )}
      {!paired && pairing === undefined && (
        <p className="ben-wb__firstrun-hint">{busy ? '正在生成配对码…' : '这会儿没有配对码,点下面「换一个码」。'}</p>
      )}
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" onClick={onNext}>
          {paired ? '好了,继续' : '先跳过配对'}
        </button>
        {!paired && <button type="button" className="ben-wb__firstrun-alt" onClick={onRegenerate}>换一个码</button>}
      </div>
    </section>
  )
}

/**
 * ③(手机主导版)只读进度。**没有输入框、没有分岔按钮** —— 这一屏的全部作用是让在电脑前的人
 * 知道「手机上正在做,做到哪儿了」,以及给他一条随时能回来的路。
 *
 * 进度跟着 /state.onboarding 走(上层每秒轮询),所以手机上答完一项,这一行几乎立刻就变。
 */
function PhoneLeadStep({ view, idle, busy, onTakeOver }: {
  view: OnboardingStateView
  idle: boolean
  busy: boolean
  onTakeOver: () => void
}) {
  return (
    <section className="ben-wb__firstrun-step" aria-label="在手机上继续">
      <h1 className="ben-wb__firstrun-ttl">{PHONE_LEAD_TITLE}</h1>
      <p className="ben-wb__firstrun-say">{phoneProgressText(view)}</p>
      <p className="ben-wb__firstrun-sub">
        手机已经配好了,引导在那边做更顺手(可以直接说话)。这一页只显示进度,不用在这儿答。
      </p>
      {idle && <p className="ben-wb__firstrun-hint" role="status">{PHONE_IDLE_ASK}</p>}
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-alt" disabled={busy} onClick={onTakeOver}>
          改在电脑上做
        </button>
      </div>
    </section>
  )
}

/** ③ 事务官出场。标题「事务官」只给读屏(球就是她),她那句是球下面的字幕。 */
function IntroStep({ greeted, paired, busy, preparing, onPick }: {
  /** 刚在「想先试哪一件」那一屏打过招呼了:这里不再说一遍(2026-10-21 隔离实例真机)。 */
  greeted: boolean
  paired: boolean
  busy: boolean
  /** DSH 正在为认新凭证重启:一行灰字,不是红字(2026-09-24)。 */
  preparing: boolean
  onPick: (which: 'existing' | 'fresh') => void
}) {
  return (
    <section className="ben-wb__firstrun-step" aria-label="事务官">
      <h1 className="ben-wb__firstrun-ttl ben-wb__onb-sr">事务官</h1>
      {greeted
        ? <p className="ben-wb__firstrun-say">{INTRO_AFTER_HELLO}</p>
        : (
            <>
              <p className="ben-wb__firstrun-say">{FIRST_RUN_HELLO}</p>
              <p className="ben-wb__firstrun-sub">我们从哪儿开始?</p>
            </>
          )}
      {/* 2026-09-23:这两颗就是 ② 分岔(称呼之后、布局之前),说法与引导的分岔句一致,不说"项目"、不说"扫描"。 */}
      <div className="ben-wb__firstrun-row">
        <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => onPick('existing')}>
          已经有在做的事
        </button>
        <button type="button" className="ben-wb__firstrun-go" disabled={busy} onClick={() => onPick('fresh')}>
          从一个新点子开始
        </button>
      </div>
      {preparing && <p className="ben-wb__onb-status ben-wb__onb-preparing" role="status">{ONBOARDING_RESTARTING_NOTE}</p>}
      {paired && <p className="ben-wb__firstrun-hint">手机已连接。先在电脑完成引导。</p>}
    </section>
  )
}

/**
 * ③′ 电脑端的文字引导(2026-09-23 改成字幕式):
 * 球下面只放**她最近那一句**(大字)、一行状态(在想 / 找项目的进度 / 出错那句人话)、你刚说的那句(小字);
 * 输入框贴底。前面聊过的收在「看前面的对话」里,点开才出。
 */
function ChatStep({ turns, her, you, stage, showHistory, onToggleHistory, draft, busy, phonePaired, onDraft, onSend, onResend }: {
  turns: readonly OnboardingTurnView[]
  her?: string
  you?: string
  stage: StageView
  showHistory: boolean
  onToggleHistory: () => void
  draft: string
  busy: boolean
  phonePaired: boolean
  onDraft: (text: string) => void
  onSend: () => void
  onResend: () => void
}) {
  const history = turns.filter(turn => turn.kind !== 'error')
  const meName = useMeName()
  // 动效配角(2026-09-23):她在想 / 在找项目时,输入框底边走一道光。状态行前**不放**小球(维护者 09-23:
  // 「这里错了」—— 上面那颗主球就是她,工作态由主球自己表现,见 onboardingStage 的优先级)。
  const fx = onboardingFx(stage.cue)
  return (
    <section className="ben-wb__firstrun-step ben-wb__onb-chat" aria-label="引导对话">
      <h1 className="ben-wb__firstrun-ttl ben-wb__onb-sr">事务官</h1>
      {her !== undefined && her !== '' && (
        <p key={her} className="ben-wb__onb-her" aria-live="polite">{her}</p>
      )}
      {stage.trouble !== undefined
        ? <p className="ben-wb__onb-trouble" role="status" data-trouble="true">{stage.trouble}</p>
        : stage.status !== undefined && (
          <div className="ben-wb__onb-status" role="status">
            <span>{stage.status}</span>
            {stage.ratio !== undefined && (
              <span className="ben-wb__onb-bar" role="progressbar" aria-label="扫描进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stage.ratio * 100)}>
                <span style={{ width: `${Math.round(stage.ratio * 100)}%` }} />
              </span>
            )}
          </div>
        )}
      {stage.resend === true && (
        <button type="button" className="ben-wb__firstrun-alt ben-wb__onb-resend" disabled={busy} onClick={onResend}>再发一次</button>
      )}
      {you !== undefined && (
        <p className="ben-wb__onb-you"><span className="ben-wb__firstrun-who">{meName}</span>{you}</p>
      )}
      {showHistory && (
        <ul className="ben-wb__firstrun-turns" aria-label="对话">
          {history.map(turn => (
            <li key={turn.seq} className="ben-wb__firstrun-turn" data-role={turn.role}>
              <span className="ben-wb__firstrun-who">{turn.role === 'user' ? meName : '事务官'}</span>
              <span className="ben-wb__firstrun-text">{turn.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="ben-wb__onb-dock">
        <div className="ben-wb__firstrun-row">
          {/* 统一输入框的「引导」裁剪(2026-09-24):只有文字与发送,光沿边在她想 / 找项目时走。 */}
          <Composer
            trim="onboarding"
            text={draft}
            onTextChange={onDraft}
            onSubmit={async () => { onSend(); return true }}
            busy={busy}
            glow={fx.beam}
            fxName="onboarding-input"
            fxSpec={BEAM.onboardingInput}
            placeholder="说点什么…"
            ariaLabel="说一句"
            sendLabel="发送"
            rows={1}
          />
        </div>
        <div className="ben-wb__onb-exits">
          {phonePaired && <p className="ben-wb__firstrun-hint">手机已连接，当前引导在电脑继续。</p>}
          {history.length > 1 && (
            <button type="button" className="ben-wb__firstrun-alt" aria-expanded={showHistory} onClick={onToggleHistory}>
              {showHistory ? '收起前面的对话' : `看前面的对话(${history.length})`}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
