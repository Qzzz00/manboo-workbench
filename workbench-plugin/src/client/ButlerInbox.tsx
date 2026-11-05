import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BriefView, RoutineRun, RoutinesView, SentinelView, WaitingItemView, WorkbenchState } from '../protocol.ts'
// 「会话未开」与「事务官会话没开」是同一处定的词(protocol.ts),界面不另写一份。
import { BUTLER_NO_SESSION_NOTE, BUTLER_SESSION_OFFLINE_NOTE } from '../protocol.ts'
// 「这条会话」这件事的键只有一处定法(2026-10-03,卡「两条接缝」),见 server/jobKey.ts 文件头。
import { sessionOfJob } from '../server/jobKey.ts'
import { butlerReportLine, orbStatusLine } from './butlerInbox.ts'
import { watchLine } from './Butler.tsx'
import { ParticleOrb } from './ParticleOrb.tsx'
import { ButlerScene } from './ButlerScene.tsx'
import { businessExecutionView } from './businessExecutionModel.ts'
import { activeFailureOf, buildButlerScene, callingNowOf, orbCountsLine, orbNoticeOf, stageAskKeys, type SceneRead } from './butlerSceneModel.ts'
import { ParticleSettings } from './ParticleSettings.tsx'
import { getParticleSettingsStore, useParticleSettings } from './particleSettingsStore.ts'
import { useAppearanceSync } from './appearanceSync.ts'
import { PARTICLE_STYLE } from './particleStyle.ts'
import { EVIDENCE_DAYS_REQUIRED, type Proposal } from './proposals.ts'
import { DevToolAsk } from './DevToolAsk.tsx'
import { LayoutAsk } from './LayoutAsk.tsx'
// 固化提议(2026-09-22,卡 ⑥ 进化循环):跟上面两张是同一类卡 —— 动她的东西之前先问一句。
import { EvolveAsk } from './EvolveAsk.tsx'
import { MeetingPrepAsk, meetingPrepRowText } from './MeetingPrepAsk.tsx'
// 引导落地(2026-09-24 晚):「我照你说的摆好了」—— 要他点头的那张单子,摆在这一摞的最上面。
import { MaterializeAsk, readMaterializeDismissed, writeMaterializeDismissed } from './MaterializeAsk.tsx'
import { shouldShow } from './materializeAskModel.ts'
// 额度还差一步(2026-09-25,卡 fix/quota-and-slot-apps):Claude/Codex 一次接上、Kimi 登一次。
import { QuotaConnectAsk, quotaAskShown } from './QuotaConnectAsk.tsx'
import { CAPABILITY_ASK_KEY, CapabilityCard, capabilityRowText, readCapabilityDismissed, writeCapabilityDismissed } from './CapabilityCard.tsx'
// 球下那一区摆得下多少(卡 fix/materialize-card-fit):整张 / 每张一行 / 只留一行「还有 N 件要你看」。
import { asksMode, asksSummaryText, measureAsksRoom } from './asksFit.ts'
// 第一次用(2026-09-18):手上一件事都没有时,输入框上面多一句话。
import { EmptyState } from './EmptyState.tsx'
import type { EmptyView } from './emptyState.ts'
import { SENSOR_LABEL } from './sentinel.ts'
import { BEAM, strongFx } from './fx/fxModel.ts'
import { FxBeam } from './fx/Fx.tsx'
import { Composer } from './composer/Composer.tsx'
import { itemBody, usesSayPath, type ComposerDraft } from './composer/composerModel.ts'

/**
 * say 路(「交给事务官」那一类整句交办)在客户端的上限(2026-10-28 卡「悬浮窗 say 挂住与超时」):
 * 服务端不回,发送键不能永远灰着、她第二句发不出去(维护者 10-28 在装机版撞到,5 分 40 秒才回)。
 */
export const SAY_CLIENT_TIMEOUT_MS = 90_000
/** 到点回执:这句没丢,还在服务端办;草稿留着,她可以直接说下一句。 */
export const SAY_STILL_WORKING = '这句还在办,办完我说'
/** Promise.race 里认超时用的记号(不走 Error 类型判断,避免撞到别的错)。 */
const SAY_WAIT_TIMEOUT_MARK = 'say-wait-timeout'
import { ItemControls } from './ItemControls.tsx'
// 她在 DSH 会话里问你的话、要你批的事(2026-09-25,卡 M;维护者点名的 bug):摆在球下那一区,不用进 DSH 原始界面。
import { QuestionAsk } from './QuestionAsk.tsx'
import { SESSION_ASK_STYLE, SessionAsk } from './SessionAsk.tsx'
import { ApprovalAsk } from './ApprovalAsk.tsx'
import { ASK_STYLE } from './askStyle.ts'
import { notifyTrouble, waitingOf } from './askModel.ts'
// 「事务官自己的提议」那一条判据(卡 WY / 卡 UX):球下那一句与「等你 n」数的必须是同一堆。
import { isButlerProposalAsk } from '../waiting.ts'
// ★ 答案来找她那两格(2026-10-04):摆哪一条由 `src/answerCell.ts` 一处算,这一层只显示。
import { answerToShow } from '../answerCell.ts'
import { NOTIFY_SETTINGS_URL } from '../protocol.ts'
import { ConfirmAsk } from './ConfirmAsk.tsx'
import { SayDecisionCards } from './SayDecisionCards.tsx'
import { sayConfirmBody, sayDecidedBody, sayNeedsAction, sayResultLine, sayScreen, saySuggestBody, type SayCardPayload } from './sayCards.ts'

/**
 * 从右下角浮窗搬过来的那几样(Butler.tsx 的同名 props,语义一字不改)。
 * 打包成一个对象经 SlotModule 管道传下来,免得那条管道再多七个洞。
 */
export interface ButlerControls {
  /** spec §5 诚实边界:暂停只影响工作台自己的响铃/采集,不控制 Agent 进程。 */
  paused: boolean
  /** 真相来自 /state.test_ringing,不本地猜。 */
  testRinging: boolean
  onPause: () => void
  onTestRing: () => void
  /** 哨兵:在盯着的事。一条都没有就整栏不渲染。 */
  sentinel?: SentinelView
  onCancelWatch: (id: string) => void
  /** 今晨快报。缺省/无条目/已划走时不渲染。 */
  brief?: BriefView
  onDismissBrief: () => void
  /** 已过三条门槛(proposals.ts)的提议。今天没有提议源,恒为空。 */
  proposals: readonly Proposal[]
}

export interface ButlerInboxProps {
  state: WorkbenchState
  baseUrl: string
  fetchImpl: typeof fetch
  /**
   * 点开某条事项底下那段对话。上层拿它去调 DSH 客户端的 `sessions.open(id)` 并把
   * 工作台浮层让开(见 client/index.ts 的 openSession)——**这个组件不认识 DSH**。
   */
  onOpenConversation: (sessionId: string) => void
  /** 输入框草稿。提到上层持有,切走再切回来不丢(同事务官对话不丢的产品决策)。 */
  draft: string
  onDraftChange: (next: string) => void
  /**
   * 「把光标送进输入框、停在草稿末尾」的请求(2026-09-20「开发一个小工具」)。
   *
   * 是一个**只增不减的计数器**而不是布尔:上层每按一次那颗按钮就 +1,这里跟着抢一次焦点。
   * 布尔要么得由上层负责翻回 false(多一个来回、还容易忘),要么第二次按下去什么也不发生
   * (值没变 = effect 不跑)——而"按了没反应"正是这个仓库到处在防的东西(D13)。
   *
   * 缺省 undefined **与 0 都是"没人要求过"**,一次都不抢焦点 —— 0 这一档不能漏:上层那个
   * 计数器初值就是 0,而事务官档是懒挂载的,漏了它就变成"点『事务官』标签也会被塞一次焦点"
   * (挂载那一拍 effect 照样跑),光标凭空跳进输入框、手机上还会顶出软键盘。
   *
   * 纯净模式那一份就不传:那颗按钮所在的标签栏在纯净模式下根本看不见,
   * 两份 ButlerInbox 同时抢焦点只会互相打架。
   */
  focusDraftAt?: number | undefined
  /**
   * 这会儿看不看得见。**display:none 而不是不渲染**:切到别的应用标签再切回来,
   * 输入框里没发出去的那句话、滚动位置都还在(2026-08-26 那条产品决策的沿用)。
   */
  visible: boolean
  controls: ButlerControls
  /** 纯净模式(整屏只有一颗球)。 */
  pure?: boolean
  /** 纯净模式下点过球、临时展开着。 */
  pureExpanded?: boolean
  onPureExpand?: () => void
  onPureCollapse?: () => void
  /**
   * 第一次用且一件事项、一条会话都没有(2026-09-18)。那句话画在输入框**上面**,
   * 球与场景照旧 —— 事务官本人不该因为"还没活干"就从屏幕上消失,她就是这一格的主角。
   * 纯净模式没展开时不画:那一档 Ben 定过「全屏幕只有一个球,事项卡片都不留」。
   */
  empty?: EmptyView
  /**
   * 这会儿界面按哪一版排布(2026-09-22「用自然语言改布局」)。
   *
   * 跟着 `POST /butler/item` 一起发给服务端 —— 「把消耗数据挪到项目区下面」这句话
   * 在横屏与竖屏上是**两件不同的事**(竖屏根本没有"右侧栏"),服务端不知道他此刻
   * 看的是哪一版的话,只能猜一个,而猜错的下场是"我说了一句,另一个方向的布局变了"。
   *
   * 缺省 `'portrait'`:既有调用点(一大批用例、纯净模式那一份)不传,行为与加这个字段
   * 之前逐字相同(竖屏是这个工作台的主用版面)。
   */
  orientation?: 'portrait' | 'landscape'
  /**
   * 把某一张「要你看的」摊开(2026-09-25,卡 M):点了「事务官」标签上的气泡、或者系统通知「事务官有话问你」。
   * `at` 每次都变(同一张点两次也要再摊一次);`key` 是 `question:<id>` / `approval:<id>`,找不到那一张就摊开全部。
   */
  focusAsk?: { key: string, at: number }
  /** 悬浮球展开窗那一版(2026-10-27):只放待你处理、最近结果、在跑的事项、交代入口。见 ButlerScene 的同名项。 */
  compact?: boolean
  /** 「在协作区查看」:打开协作区并定位那件事项。 */
  onLocate?: (taskId: string) => void
}

/**
 * 「现在跑一遍」(2026-10-13,卡「早报:界面上能随时跑一遍…」第 1 件)。
 *
 * 由来:早报与资讯的路由(`POST /routine/run` / `POST /feed/run`)从 2026-09-15 就在,
 * 界面上一颗键都没有 —— 演示与展位要能当场重放一份。摆在抽屉里「全部暂停 / 试铃」旁边:
 * 那一排本来就是事务官自己那几个动作。
 *
 * 三条纪律:**在跑时灰掉并说「在出了」**(真相是 `/state.routines.running`,不本地猜);
 * **回执原样说**(409「这条例程正在跑」、404「资讯未启用」都照说);**没接例程服务就整块不画**。
 */
function RunNow({ routines, baseUrl, fetchImpl, onReceipt }: {
  routines: RoutinesView
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt: (line: string) => void
}) {
  // 从按下到下一拍快照回来之间也要灰着(轮询有间隔,不灰就会被连点两次)。
  const [posting, setPosting] = useState<'morning' | 'feed' | undefined>(undefined)
  const morningBusy = routines.running.includes('morning') || posting === 'morning'
  const feedBusy = posting === 'feed'

  const runMorning = (): void => {
    if (morningBusy) return
    setPosting('morning')
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/routine/run`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'morning' }),
        })
        const body = await res.json() as { ok?: boolean, error?: string, run?: RoutineRun }
        if (res.ok === false || body.ok !== true || body.run === undefined) {
          onReceipt(body.error ?? '早报没出成,再按一次试试')
          return
        }
        onReceipt(morningRunReceipt(body.run))
      }
      catch { onReceipt('这一下没送到,工作台服务没应答') }
      finally { setPosting(undefined) }
    })()
  }

  const runFeed = (): void => {
    if (feedBusy) return
    setPosting('feed')
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/feed/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const body = await res.json() as { note?: string, error?: string }
        if (res.ok === false) { onReceipt(body.error ?? '资讯没搜成,再按一次试试'); return }
        // note 是服务端那一句人话(搜到几条);error 在的时候也照说(中转没配搜索就说没配)。
        const said = [body.note, body.error].filter((one): one is string => one !== undefined && one !== '')
        onReceipt(said.length === 0 ? '搜完了' : said.join(';'))
      }
      catch { onReceipt('这一下没送到,工作台服务没应答') }
      finally { setPosting(undefined) }
    })()
  }

  return (
    <section className="ben-wb__butler-runnow" aria-label="现在跑一遍">
      <h4 className="ben-wb__stack-head">现在跑一遍</h4>
      <div className="ben-wb__butler-acts">
        <button
          type="button"
          className="ben-wb__butler-pause"
          disabled={morningBusy}
          onClick={runMorning}
          title="重新拼一份开工汇报:停太久的事项、今天的会与待办、进度核对、运营目标、资讯"
        >
          {morningBusy ? '在出了…' : '现在出一份早报'}
        </button>
        <button
          type="button"
          className="ben-wb__butler-pause"
          disabled={feedBusy}
          onClick={runFeed}
          title="按每个项目的关键词搜一轮资讯(下一份早报里念的就是它)"
        >
          {feedBusy ? '在搜了…' : '现在搜一轮'}
        </button>
      </div>
    </section>
  )
}

/** 跑完那一下该说什么。**状态原样翻成人话**,不把「会话没开」说成「出来了」(D13)。 */
function morningRunReceipt(run: RoutineRun): string {
  if (run.status === 'failed') return `早报没出成:${run.note ?? '没说原因'}`
  if (run.status === 'skipped') return `这次跳过:${run.note ?? '没说原因'}`
  if (run.status === 'no_session') {
    return `早报出来了,在上面那一摞里;${run.session_offline === true ? BUTLER_SESSION_OFFLINE_NOTE : BUTLER_NO_SESSION_NOTE}`
  }
  return '早报出来了,在上面那一摞里'
}

/**
 * 球旁的小抽屉:浮窗搬家过来的那几样。**「全部暂停」没有任何外层条件**——抽屉打开就在
 * 第一行(不可改清单第 1 条:改坏了要有喊停入口)。
 */
function Drawer({ controls, routines, baseUrl, fetchImpl, onReceipt }: {
  controls: ButlerControls
  routines?: RoutinesView | undefined
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt: (line: string) => void
}) {
  const { paused, testRinging, onPause, onTestRing, sentinel, onCancelWatch, brief, onDismissBrief, proposals } = controls
  return (
    <div className="ben-wb__drawer" role="group" aria-label="事务官的抽屉">
      <div className="ben-wb__butler-acts">
        <button type="button" className="ben-wb__butler-pause" onClick={onPause}>
          {paused ? '▶ 恢复' : '⏸ 全部暂停'}
        </button>
        {/* 与浮窗上那颗同一条路(2026-09-23 起排的是一通真来电,见 Butler.tsx 的注释)。 */}
        <button
          type="button"
          className="ben-wb__butler-pause"
          onClick={onTestRing}
          title={testRinging ? '取消刚排的那一通(工人已经领走就停不掉,手机上按挂断)' : '排一通真来电:手机会响,拿起听筒就能接'}
        >
          {testRinging ? '🔕 停铃' : '🔔 试铃'}
        </button>
      </div>
      {paused && (
        // spec §5 诚实边界原话——暂停管得到的只有工作台自己的响铃/采集,管不到任何 Agent 进程。
        <p className="ben-wb__butler-paused">已暂停工作台自动行为(响铃/采集)——不控制 Agent 进程</p>
      )}
      {routines !== undefined && <RunNow routines={routines} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={onReceipt} />}
      {sentinel !== undefined && sentinel.watches.length > 0 && (
        <section className="ben-wb__butler-sentinel" aria-label="在盯着的事">
          <h4 className="ben-wb__stack-head">在盯着的事</h4>
          <ul className="ben-wb__butler-sentinel-list">
            {sentinel.watches.map(watch => (
              <li key={watch.id} data-done={watch.done === true}>
                <div className="ben-wb__butler-sentinel-head">
                  <span className="ben-wb__butler-sentinel-note">{watch.note}</span>
                  <button
                    type="button"
                    className="ben-wb__butler-brief-x"
                    aria-label={`取消监视:${watch.note}`}
                    onClick={() => onCancelWatch(watch.id)}
                  >
                    ✕
                  </button>
                </div>
                <span className="ben-wb__butler-sentinel-target">{SENSOR_LABEL[watch.kind]} · {watch.target}</span>
                <span className="ben-wb__butler-sentinel-change">{watchLine(watch)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {brief !== undefined && ((brief.topics.length > 0 && brief.dismissed !== true) || brief.error !== undefined) && (
        <section className="ben-wb__butler-brief" aria-label="今晨快报">
          <div className="ben-wb__butler-brief-head">
            <h4 className="ben-wb__stack-head">今晨快报</h4>
            {brief.topics.length > 0 && (
              <button type="button" className="ben-wb__butler-brief-x" aria-label="划走今晨快报" onClick={onDismissBrief}>✕</button>
            )}
          </div>
          {brief.error !== undefined
            ? <p className="ben-wb__items-empty">今天没取到快报({brief.error})</p>
            : (
                <ul className="ben-wb__butler-brief-list">
                  {brief.topics.map(topic => (
                    <li key={topic.id}>
                      <a href={topic.url} target="_blank" rel="noopener noreferrer">{topic.title}</a>
                      <span className="ben-wb__butler-brief-src">{topic.source}</span>
                    </li>
                  ))}
                </ul>
              )}
        </section>
      )}
      <section className="ben-wb__butler-prop" aria-label="工作台自己的提议">
        <h4 className="ben-wb__stack-head">工作台自己的提议</h4>
        {proposals.length === 0
          ? (
              <p className="ben-wb__items-empty">
                证据不足,暂不提议。功能层提议需同一模块连续 {EVIDENCE_DAYS_REQUIRED} 天同向行为才允许发起。
              </p>
            )
          : <p className="ben-wb__items-empty">{proposals.length} 条待拍板,在事项收纳中。</p>}
      </section>
    </div>
  )
}

export function ButlerInbox({
  state, baseUrl, fetchImpl, onOpenConversation, draft, onDraftChange, focusDraftAt, visible, controls,
  pure = false, pureExpanded = false, onPureExpand, onPureCollapse, empty, orientation, focusAsk, compact = false, onLocate,
}: ButlerInboxProps) {
  /**
   * 建项回执只说明服务端是否建下事项；没有执行证据就不声称开始执行。
   * 开不出会话时保留服务端「会话未开」说明。
   */
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [sayCards, setSayCards] = useState<SayCardPayload | undefined>(undefined)
  /**
   * 处理完的那一份(不要她再点的):摊开看详情没有、标为已读没有(2026-10-27)。都跟着这一份回执走 ——
   * 下一次交代换了回执,两样自然回到「收着、未读」,不用另记清除时机。
   */
  const [sayOpen, setSayOpen] = useState<SayCardPayload | undefined>(undefined)
  const [saySeen, setSaySeen] = useState<SayCardPayload | undefined>(undefined)
  const sayPending = sayCards !== undefined && sayNeedsAction(sayCards)
  const sayDone = sayCards !== undefined && !sayPending && saySeen !== sayCards ? sayCards : undefined
  const sayLine = sayDone === undefined ? undefined : sayResultLine(sayDone)
  const pendingSayChoices = useRef(new Set<SayCardPayload>())
  const [, refreshSayBusy] = useState(0)
  const sayBusy = sayCards !== undefined && pendingSayChoices.current.has(sayCards)
  // 只约束本地回包归属，不取消已交给服务端的动作。编辑草稿不换代。
  const sayGeneration = useRef(0)
  /** 哪一次提交等到了客户端上限(到点那一代):它晚到的回包只补话,不盖她新打的草稿。 */
  const sayTimedOutGeneration = useRef(0)
  /** 最新草稿(晚到回包补话时比对用,不清掉她后来新打的字)。 */
  const draftRef = useRef(draft)
  draftRef.current = draft
  // 「我照你说的摆好了」点过「收起」的那一张(本机记着;同一张单子不再出来)。
  const [laidDismissed, setLaidDismissed] = useState<string | undefined>(readMaterializeDismissed)
  const dismissLaid = (id: string): void => { setLaidDismissed(id); writeMaterializeDismissed(id) }
  // 「现在能做什么」点过「收起」(本机记着;2026-10-28):这一档里不再摆、收成一行那一句也不说。
  const [capabilityDismissed, setCapabilityDismissed] = useState<boolean>(readCapabilityDismissed)
  const dismissCapability = (): void => { setCapabilityDismissed(true); writeCapabilityDismissed() }
  const capabilityShown = state.first_use !== undefined && !capabilityDismissed
  /**
   * 整张单子摊开着没有(2026-09-25 真壳验收,卡 fix/materialize-card-fit):球下那一区摆不下时,那张收成一行,
   * 「看全部」「改一下」把整张单子摊在事务官这一档上面(盖住球与输入框,底栏照样钉在底下)。'edit' = 一打开就是「改一下」。
   */
  const [laidSheet, setLaidSheet] = useState<'view' | 'edit' | undefined>(undefined)
  /**
   * 球下那一区摆得下多少(卡 fix/materialize-card-fit;统筹拍板:粒子球是主角,卡片不许挤球)。
   * 量的是那一区在球按卡 A 的规矩摆好之后还剩多高(asksFit.measureAsksRoom);量不出来(没有布局的环境)就当摆得下整张。
   */
  const sectionRef = useRef<HTMLElement | null>(null)
  const [asksRoom, setAsksRoom] = useState<number | undefined>(undefined)
  /** 「还有 N 件要你看 · 展开」/ 一行里的「展开」:把要他看的几张整张摊在这一档上面。 */
  const [asksSheet, setAsksSheet] = useState(false)
  useLayoutEffect(() => {
    const section = sectionRef.current
    if (section === null) return undefined
    const measure = (): void => {
      const next = measureAsksRoom(section)
      setAsksRoom(prev => (prev === next ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(section)
    const scene = section.querySelector('.ben-wb__particle-scene')
    if (scene !== null) observer.observe(scene)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  })
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [focused, setFocused] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [read, setRead] = useState<SceneRead>({})
  /** 一次选题操作在路上。两颗键一起禁用 —— 按两下会建出两张同名的卡。 */
  const [topicBusy, setTopicBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const settingsStore = getParticleSettingsStore()
  const settings = useParticleSettings(settingsStore)
  // 外观一份两端共用(2026-09-16):启动拉服务端、调参推服务端;版本变了重新拉。
  useAppearanceSync({ store: settingsStore, baseUrl, fetchImpl }, state.appearance_version)
  const model = buildButlerScene(state, read, controls.proposals)
  /**
   * 台上哪几张会话卡卡面上已经写着那一问(2026-09-27,卡 DD:同一件「等你」只摆一处,拍板留球旁的卡)。
   * 算在这里(不在下面用它的地方)是因为**摊开哪一处**那条 effect 也要读它 —— 通知与标签气泡点进来的那一件
   * 若已经在台上,该聚焦台上那张卡,不该去摊球下那一层(那一层里已经没有它了)。
   */
  const stageAsks = stageAskKeys(model.stage.filter(item => item.executing && item.external === undefined))
  const selected = model.items.find(item => item.id === focusId)
  const focusRunning = selected?.executing === true
  /**
   * 球此刻的样子**读服务端算好的那一格**(2026-10-04,卡「球的颜色一处算」):`/state.orb`。
   * 电脑与手机只显示它,不各自推算 —— 根治「同一刻两个端两种颜色」(维护者 10-04 那个镜头)。
   * 缺席 = 老服务端,下面两处各自退回 0.4.96 的本地推算。
   */
  const orbCell = state.orb
  /**
   * ★ **答案来找她那两格**(2026-10-04,卡 `claude/answer-comes-to-her`):
   * 「问一句」的那条回答与「刚办完」那几条。两样都**读服务端算好的那一格**
   * (`/state.answers` / `/state.fresh_results`,判据在 `src/answerCell.ts`)——
   * 这一层一个条件都不自己判(两处判据必漂,同球那一格的理由)。
   * 老服务端没有这两格时两处都不画,**行为与 0.4.97 一字不差**。
   */
  const freshAnswer = answerToShow(state.answers)
  const freshResults = state.fresh_results?.items ?? []
  // 有事项在执行,球就是在办(流沙)——不必先点它(Ben 2026-09-16:「进行中应该是流沙一直转的形态」)。
  // 数的是服务端那一格(与球下「执行 n」、汇报条「运行会话 n 个」同一个数);老服务端才就地算。
  const anyRunning = orbCell?.working ?? (model.running ?? 0) > 0
  const textInput = (focused && (!pure || pureExpanded)) || draft.trim() !== ''
  const mode = textInput ? 'listening' : anyRunning ? 'working' : 'idle'
  /**
   * 球下那一句 / 球的读屏名字数的是**「等你」那一堆里的那几问**(2026-09-28,卡 UX 补一致性):
   * 事务官自己的提议(「这张派给 X 开工?」、「进度要你说一句」)不算 —— 它不在「等你 n」里,
   * 球下也不该说「等你批」(维护者硬规矩:同一件事的数字各处一致)。
   */
  const askingNow = (state.questions ?? []).filter(one => !isButlerProposalAsk(one.session_id)).length
  const approvingNow = (state.approvals ?? []).filter(one => one.proposal !== true).length
  /** 球下那一句:她停下来等他(问了一句 / 要他批)时先说这个,不写「文字输入中」「正在执行」(卡 M 补)。球的读屏名字同一句。 */
  const statusLine = orbStatusLine({
    preview: settings.preview?.label,
    questions: askingNow,
    approvals: approvingNow,
    typing: textInput,
    focusRunning,
    running: model.running,
    observedRunning: !state.stale && state.running?.scope === 'classified_business_tasks' ? businessExecutionView(state).observed : undefined,
  })
  /** 她停着等他(问了一句 / 要他批):球的读屏名字也说这一句(「事务官:等你回答」),不说「文字输入中」。 */
  const waitingOnHimNow = askingNow + approvingNow > 0 && settings.preview === undefined
  /**
   * 「等你」的那一堆只有一份(2026-09-25 卡 M 追加,维护者硬规矩:同一件事的数字各处一致):
   * 要他答的、要他批的(操作 / 单子 / 提议)、要他验收的。球下「等你 n」、那一区「还有 N 件要你看」、「事务官」标签上的数、
   * 手机「等你确认」、汇报条 —— 全读服务端算好的 `state.waiting`(src/waiting.ts)。
   */
  const pile = waitingOf(state)
  // 「受阻 N」只在 N>0 时出现(2026-10-04);前三个数照旧,口径见上面那几条注释。
  // 「受阻 N」也认服务端那一格(与手机同源);老服务端才用本地算的 `model.blocked`。
  const businessRunning = state.running === undefined ? model.running : businessExecutionView(state).count
  const countsLine = businessRunning === undefined
    ? undefined
    : orbCountsLine({ running: businessRunning, queued: model.groups.queued.length, waiting: pile.count, blocked: orbCell?.blocked ?? model.blocked })
  /*
   * 球的提示色(2026-10-04,卡「球的颜色一处算」):**读服务端那一格**(`/state.orb.notice`,判据在 `src/orbCell.ts`)——
   * 红只认此刻台上正在执行的那件出错(历史阻塞去「受阻 N」),通话中与等她回话同一档(琥珀),其余中性。
   * 老服务端没有那一格时退回 0.4.96 的本地三条(`butlerSceneModel.ts` 里那几个纯函数)。
   * **`mode` 一个字没动** —— 执行中的颜色与形态(莫比乌斯环)保持现状,不新开一档青色。
   */
  const orbNotice = orbCell?.notice ?? orbNoticeOf({
    activeFailure: activeFailureOf(model.stage),
    waitingOnUser: waitingOnHimNow,
    calling: callingNowOf(state),
    base: model.notice,
  })

  /**
   * 上层要求"把光标送进来"(2026-09-20「开发一个小工具」):聚焦 + 光标落在**草稿末尾**。
   *
   * 末尾而不是开头:预填那句话停在「它要做的是:」,用户接着往下说就行,
   * 光标停在开头等于让他先按一次 End(而且这一版**不自动发送**,他一定要再打字)。
   * 输入框还没挂上(纯净模式没展开、事务官档还没懒挂载)就什么都不做——
   * 计数器下一次再变时自然会重来一遍,不必在这里排队等它出现。
   */
  useEffect(() => {
    if (focusDraftAt === undefined || focusDraftAt === 0) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  }, [focusDraftAt])

  /**
   * 点了「事务官」标签上的气泡 / 系统通知(2026-09-25,卡 M):把「要你看的」整张摊开,滚到那一张。
   * 纯净模式没展开时先展开(那一档只有一颗球,摊开的卡没处放)。
   *
   * 那一件已经在台上有卡、卡上写着那一问时**改成聚焦台上那张卡**(2026-09-27,卡 DD 追加,统筹定):
   * 球下那一层里已经没有它了(同一件「等你」只摆一处),还去摊那一层就是点进来什么也找不到 —— 那正是 D13
   * 到处在防的「点了没反应」。聚焦等同于点那张卡:底下「当前聚焦事项」整张摊开,里面就是可答的 `SessionAsk`。
   * 这条路真会走到:标签气泡送的是 `waitingOf(state).items[0].key`,系统通知送的也是「等你」那一堆里的键。
   */
  useEffect(() => {
    if (focusAsk === undefined) return undefined
    if (pure && !pureExpanded) onPureExpand?.()
    if (stageAsks.has(focusAsk.key)) { setAsksSheet(false); setFocusId(focusAsk.key); return undefined }
    setAsksSheet(true)
    const timer = setTimeout(() => {
      const sheet = sectionRef.current?.querySelector('.ben-wb__asks-sheet')
      const key = focusAsk.key.replace(/["\\]/g, '')
      const target = sheet?.querySelector(`[data-ask="${key}"]`)
      if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
    }, 60)
    return () => clearTimeout(timer)
    // 只跟着这一次「要摊开」走;纯净模式的开合由上层管。
  }, [focusAsk?.at])

  // Removing a focused input does not fire blur. Clear the remembered focus on any collapse path.
  useEffect(() => { if (pure && !pureExpanded) setFocused(false) }, [pure, pureExpanded])

  // 纯净模式的 Esc 收回。只在"纯净 + 展开着"时挂监听,别的时候 Esc 不归这里管。
  useEffect(() => {
    if (!pure || !pureExpanded || onPureCollapse === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onPureCollapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pure, pureExpanded, onPureCollapse])

  /**
   * ★ **「看过了」那一下**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 维护者 10-04(经工作台捎话):「信息直接从正在办切到办完了,我是自己追过去点开查看的」。
   * 从此「问一句」的答案出现在**她提问的那个地方** —— 电脑上就是球下这一处;
   * 交代的事办完先挂一条「刚办完 · 结果一句话」,她看过或划掉才收进「办完」。
   *
   * 两条路、同一个意思(她看过了),服务端各只记一格,**所以两端同步**:
   * 手机上看过,电脑这一处下一拍快照就跟着收(反过来也一样)。
   * 成功也**以新 `/state` 为准**(同 `confirmTask`:不把「请求发出」当成「状态已经改了」)。
   */
  const markSeen = (path: '/answers/seen' | '/task/seen-result', id: string): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
        })
        const body = await res.json() as { ok?: boolean, error?: string }
        if (res.ok === false || body.ok !== true) setReceipt(body.error ?? '这一下没记上,再按一次试试')
      } catch { setReceipt('这一下没送到,工作台服务没应答') }
    })()
  }

  /**
   * 确认走看板唯一的改状态路由。错误在当前页显示；成功也以新 /state 为准，
   * 不把阅读或请求发出误当作状态已经改变。
   */
  const confirmTask = (taskId: string): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/task/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: taskId, status: 'done' }) })
        const body = await res.json() as { ok?: boolean, error?: string }
        if (res.ok === false || body.ok !== true) setReceipt(body.error ?? '确认未完成，请稍后重试')
        else setReceipt('确认已送达，等待服务端更新事项状态')
      } catch { setReceipt('确认未送达，工作台服务没应答') }
    })()
  }

  /**
   * 证据里冒出来的下一步(2026-09-25 卡 N):「加上」= 挪进「待办」(有负责人的,负责人驱动接着按档位问 / 派),
   * 「不要」= 改取消(卡留着,进度核对不再提同一件)。同 confirmTask 走 /task/move,以服务端下一份快照为准。
   */
  const answerProposal = (taskId: string, accept: boolean): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/task/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: taskId, status: accept ? 'todo' : 'canceled' }) })
        const body = await res.json() as { ok?: boolean, error?: string }
        if (res.ok === false || body.ok !== true) setReceipt(body.error ?? '没改成，请稍后重试')
        else setReceipt(accept ? '加上了，在看板「待办」里' : '不要了，这张改成取消')
      } catch { setReceipt('没送到，工作台服务没应答') }
    })()
  }

  /**
   * 点开一条事项。**兜住 open 的抛出**:DSH 客户端对不认识的 id 是 fail loud(会抛),
   * 而卡上那条会话可能早就不在它的会话列表里了。不兜的话按下去只有控制台一行红字,
   * 界面上是"点了没反应"——那正是这个组件到处在防的东西(D13)。
   */
  /**
   * 「加入选题池」(2026-09-22 卡 ③)。一个请求做完四件事(见服务端 POST /feed/adopt):
   * 建一条 `kind:'topic'` 的卡、建 `选题/<名>/`、来源落 `来源.md`、把这条记成已建。
   *
   * **回执原样说出来**:目录建不出来(没配工作目录)时卡是真建下了,
   * 那句「卡建好了,但…」比一个笼统的「成功」有用得多(D13)。
   */
  const adoptTopic = (feedId: string, title: string): void => {
    if (topicBusy) return
    setTopicBusy(true)
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/feed/adopt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: feedId }),
        })
        const body = await res.json() as { ok?: boolean, note?: string, error?: string }
        if (res.ok !== false && body.ok === true) {
          setReceipt(body.note === undefined ? `「${title}」已进选题池` : `「${title}」已进选题池,${body.note}`)
        }
        else setReceipt(body.error ?? '没能把这条选题加进选题池')
      }
      catch { setReceipt('工作台服务没应答,这条选题还没建下') }
      finally { setTopicBusy(false) }
    })()
  }

  /**
   * 会议「重新整理」(2026-10-09):转写或梳理没成的那一场,只重做没成的那一截(服务端 POST /meeting/retry)。
   * 回执原样说;之后的进度由 /state 那一档自己更新(正在转写 → 纪要好了 / 没整理成)。
   */
  /** 会后那一句(2026-10-10):这场要定的定下来没有。存下来给以后的会议学习用(服务端 POST /meeting/outcome)。 */
  const meetingOutcome = (meetingId: string, settled: 'yes' | 'partly' | 'no'): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/meeting/outcome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: meetingId, settled }) })
        const payload = await res.json() as { ok?: boolean, error?: string }
        setReceipt(payload.ok === true ? '记下了这场会的结果' : payload.error ?? '没记上')
      }
      catch { setReceipt('工作台服务没应答,这次没记上') }
    })()
  }

  const retryMeeting = (meetingId: string): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/meeting/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: meetingId }),
        })
        const body = await res.json() as { ok?: boolean, error?: string }
        setReceipt(res.ok !== false && body.ok === true ? '重新整理这场会了,已经转好的段不再送识别' : (body.error ?? '没能重新整理这场会'))
      }
      catch { setReceipt('工作台服务没应答,这场会还没重新整理') }
    })()
  }

  /**
   * 「不要」。**只记住这一条**(同链接/同标题不再推),不是"这个来源以后都别给我"——
   * 那是资讯页上另一颗键(「不看了」)。措辞与服务端 action 一一对应:decline ≠ mute。
   */
  const declineTopic = (feedId: string, title: string): void => {
    if (topicBusy) return
    setTopicBusy(true)
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/feed/feedback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: feedId, action: 'decline' }),
        })
        const body = await res.json() as { ok?: boolean, error?: string }
        if (res.ok !== false && body.ok === true) setReceipt(`记下了,以后不再推「${title}」这一条`)
        else setReceipt(body.error ?? '没能记下这次「不要」')
      }
      catch { setReceipt('工作台服务没应答,这次「不要」没记下') }
      finally { setTopicBusy(false) }
    })()
  }

  const openConversation = (sessionId: string): void => {
    try {
      onOpenConversation(sessionId)
    }
    catch {
      setReceipt('这条对话打不开了——它可能已经不在 DSH 的会话列表里')
    }
  }

  /**
   * 交办(2026-09-24 起经统一输入框):正文 + 谁来办 + 附件 + 引用一起发。档与模型不随这一句带 ——
   * 下拉里一换就记成默认了(粘性),服务端用的就是那一份。
   */
  const submit = async (composed: ComposerDraft): Promise<boolean> => {
    if (sendingRef.current) return false
    const body = itemBody({ ...composed, text: composed.text }, { orientation: orientation ?? 'portrait', ...(composed.mode === undefined ? {} : { mode: composed.mode }), ...(composed.model === undefined ? {} : { model: composed.model }) })
    if (typeof body.text !== 'string' || (body.text === '' && body.attachments === undefined)) return false
    sayGeneration.current += 1
    const generation = sayGeneration.current
    sendingRef.current = true
    setSending(true)
    const plainSay = usesSayPath(composed)
    try {
      if (plainSay) {
        /**
         * say 路带 SAY_CLIENT_TIMEOUT_MS 上限:到点键复原、草稿留着、回执如实说还在办;
         * **请求不回断** —— 回包到了(带同一个 say_id)照样把回话补上,不当失败重发(重发会重复建卡)。
         */
        const done = (async (): Promise<boolean> => {
          const res = await fetchImpl(`${baseUrl}/butler/say`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // can_meeting_plan(2026-10-10):这台认得「登记了一场会」那条回执 —— 「下午三点跟 B 客户谈…」落成待开的会。
            body: JSON.stringify({ text: body.text, entrance: 'desktop', ...(sayCards?.say_id === undefined ? {} : { ctx: { last_say_id: sayCards.say_id } }) }),
          })
          const answer = await res.json() as { ok?: boolean, note?: string, error?: string, carried_on?: boolean, feedback?: unknown, meeting_plan?: unknown } & SayCardPayload
          // 晚到的回包只补话,不盖掉她已经在看的新回话(与 chooseSay 同一条 sayGeneration 归属规矩);
          // 在路上的那一份 generation 必然还是当前这份,行为与加超时之前逐字相同。
          if (generation !== sayGeneration.current) return false
          if (res.ok === false || sayScreen(answer) === undefined) {
            setReceipt(answer.error ?? '工作台没有返回有效的 say 回执；原话仍留在输入框。')
            return false
          }
          setSayCards(answer)
          setReceipt(undefined)
          // 等到上限才回来的那一份:她可能已打着下一句,草稿没动过才清(在路上的那一份照老规矩清)。
          if (sayTimedOutGeneration.current === generation) {
            if (draftRef.current === body.text || draftRef.current === '') onDraftChange('')
          }
          else onDraftChange('')
          return true
        })()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            done,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(SAY_WAIT_TIMEOUT_MARK)), SAY_CLIENT_TIMEOUT_MS) }),
          ])
        }
        catch (err) {
          if (!(err instanceof Error && err.message === SAY_WAIT_TIMEOUT_MARK)) throw err
          sayTimedOutGeneration.current = generation
          setReceipt(SAY_STILL_WORKING)
          // 这一句还在服务端办:回包到了由 done 补上;done 自己再出错也不惊动这一页。
          void done.then(() => undefined, () => undefined)
          return false
        }
        finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      const res = await fetchImpl(`${baseUrl}/butler/item`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, can_meeting_plan: true }),
      })
      const answer = await res.json() as { ok?: boolean, note?: string, error?: string, carried_on?: boolean, feedback?: unknown, meeting_plan?: unknown } & SayCardPayload
      if (res.ok !== false && answer.ok === true) {
        onDraftChange('')
        /**
         * 「接着刚才那件说了」(2026-09-25,卡 Y):服务端把这句话说进了上一件那条会话里、**没建新卡** ——
         * 回执就不能说「事项已建下」(那是句假话,看板上并没有多一张卡)。
         */
        /**
         * 本体的毛病(2026-09-28,卡 FB):这句话说的是工作台自己哪儿不对 —— 服务端**一张卡都没建**、
         * 一家都没派,回的是那条反馈与事务官那一句。所以回执里不许出现「已建下」三个字
         * (同 `carried_on` 那一条的理由:看板上并没有多一张卡),照服务端那一句原样摆。
         */
        // 登记了一场会:没建事项,回执照服务端那一句(记下了 + 还差哪一问),缺的那几问在球下那张卡上答。
        setReceipt(answer.meeting_plan !== undefined
          ? answer.note ?? '记下了这场会'
          : answer.feedback !== undefined
          ? answer.note ?? '这是工作台本身的问题,我反馈给开发者了。'
          : answer.carried_on === true
            ? '接着刚才那件说了'
            /**
             * 「落地」口挂起确认(2026-10-24,卡 1a):她明说先确认的那件**还没建卡**,等她说「好」。
             * 回执照那句问话原样摆,不说「已建下」(看板上还没有这张卡,同 carried_on 的理由)。
             */
            : (answer as { ask?: unknown }).ask !== undefined
              ? answer.note ?? '这件等你点头我再办。'
              : answer.note === undefined ? '事项已建下' : `已建下,${answer.note}`)
        return true
      }
      setReceipt(answer.error ?? '没建成')
      return false
    }
    catch {
      // 网络/服务没起来。如实说一句,草稿留着(同上)。
      setReceipt('工作台服务没应答,这句话还留在框里')
      return false
    }
    finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const chooseSay = (choice: string, askId?: string, suggestId?: string, decidedId?: string): void => {
    if (sayCards === undefined || sendingRef.current || pendingSayChoices.current.has(sayCards)) return
    if (suggestId !== undefined && sayCards.suggest?.suggest_id !== suggestId) { setReceipt('这条建议已更新，请按最新回话重新选择。'); return }
    const body = decidedId !== undefined ? sayDecidedBody(sayCards, decidedId, choice, state)
      : suggestId !== undefined ? saySuggestBody(sayCards, choice) : sayConfirmBody(sayCards, choice, askId)
    if (body === undefined) { setReceipt('这张卡缺少服务端确认编号，暂时不能提交选择。'); return }
    const owner = sayCards
    const generation = ++sayGeneration.current
    pendingSayChoices.current.add(owner)
    refreshSayBusy(value => value + 1)
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/butler/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const next = await res.json() as SayCardPayload & { error?: string }
        if (generation !== sayGeneration.current) return
        if (res.ok === false || sayScreen(next) === undefined) { setReceipt(next.error ?? '选择没有得到有效回执。'); return }
        setSayCards(next)
        setReceipt(undefined)
      } catch { if (generation === sayGeneration.current) setReceipt('工作台服务没应答，选择尚未确认。') }
      finally {
        pendingSayChoices.current.delete(owner)
        refreshSayBusy(value => value + 1)
      }
    })()
  }

  const hiddenStyle = visible ? undefined : { display: 'none' }
  /**
   * 球下面「要你处理的」那几张(2026-09-25,卡 feat/first-look-orb-top)。以前它们摆在输入框正上方、
   * 与球挤同一列:一张长卡(那张「这 4 次你都在说…」)就把球挤出了屏幕。现在一律进球下面那一区,那一区自己滚。
   *
   * 2026-09-25(卡 M 追加):这张表**就是「等你」那一堆**(src/waiting.ts,服务端算好的 `state.waiting`),一件一张,顺序照它:
   * 她问你的 → 要你批的 → 等你点头的单子 → 提议(小工具 → 布局 → 固化)→ 办完了等你确认的。
   * 单子正在落 / 落好了那张回执、卡 C 的「额度还差一步」也摆在这一区,但不进数(不是哪件事停着在等他),排在后面。
   */
  const approvals = state.approvals ?? []
  // 引导落地那张单子(卡 feat/onboarding-materialize):出不出来按 materializeAskModel.shouldShow(等他点头 / 落完十分钟内 / 没点「收起」),
  // 「收起」的状态提到这一层 —— 不出来就不进表(不然表里多一个空框,还会抢走那一道光)。
  const laid = state.materialize
  const laidShown = shouldShow(laid, Date.now(), laidDismissed)
  const laidPending = laid !== undefined && laidShown && laid.status !== 'applied'
  const openLaid = (edit: boolean): void => setLaidSheet(edit ? 'edit' : 'view')
  const openAsks = (): void => setAsksSheet(true)
  /** 每张:整张的样子(node)与收成一行的样子(row)。一行里的「展开」把这几张整张摊开。 */
  const plain = (text: string): ReactNode => (
    <>
      <span className="ben-wb__askrow-text">{text}</span>
      <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={openAsks}>展开</button>
    </>
  )
  const questions = state.questions ?? []
  const inboxConfirms = (state.butler_inbox?.items ?? []).filter(item => item.kind === 'confirm')
  /** 「看看」:在工作台里摊开那一件(收起「要你看的」那一层,聚焦那一张)。 */
  const lookAt = (taskId: string): void => { setAsksSheet(false); setFocusId(taskId) }
  /**
   * 「等你」那一堆里的一件 → 球下那一区里的一张。**一件对一张,不多不少**:数与摆的是同一张表(统筹 09-25)。
   * 快照里对不上号的(不该有)照样摆一行它那句话 —— 宁可朴素,不能让数和摆出来的对不上。
   */
  const pileEntry = (item: WaitingItemView): { key: string, node: ReactNode, row: ReactNode } => {
    const id = item.key.slice(item.key.indexOf(':') + 1)
    const fallback = { key: item.key, node: <p className="ben-wb__askrow-text">{item.text}</p>, row: plain(item.text) }
    if (item.kind === 'question') {
      const question = questions.find(one => one.id === id)
      return question === undefined ? fallback : {
        key: item.key,
        node: <QuestionAsk question={question} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={setReceipt} />,
        row: <QuestionAsk question={question} baseUrl={baseUrl} fetchImpl={fetchImpl} variant="row" onExpand={openAsks} />,
      }
    }
    if (item.kind === 'approval') {
      const approval = approvals.find(one => one.id === id)
      return approval === undefined ? fallback : {
        key: item.key,
        node: <ApprovalAsk approval={approval} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={setReceipt} />,
        row: <ApprovalAsk approval={approval} baseUrl={baseUrl} fetchImpl={fetchImpl} variant="row" onExpand={openAsks} />,
      }
    }
    if (item.kind === 'plan') {
      return laid === undefined || !laidShown ? fallback : {
        key: item.key,
        node: <MaterializeAsk view={laid} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={laidDismissed} onDismiss={dismissLaid} onOpenSheet={openLaid} />,
        row: <MaterializeAsk view={laid} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={laidDismissed} onDismiss={dismissLaid} onOpenSheet={openLaid} variant="row" />,
      }
    }
    if (item.kind === 'confirm') {
      const event = inboxConfirms.find(one => (one.task_id ?? one.id) === id)
      const title = event?.title ?? item.text
      return {
        key: item.key,
        node: <ConfirmAsk taskId={id} title={title} note={event?.note} ask={event?.owner_ask} onConfirm={confirmTask} onLook={lookAt} />,
        row: <ConfirmAsk taskId={id} title={title} variant="row" onConfirm={confirmTask} onLook={lookAt} />,
      }
    }
    if (item.kind === 'session') {
      /*
       * 别家的会话在等他(卡 T)。★ 2026-10-03(卡「两条接缝」):键只有一个定法
       * (`jobKey.sessionJobId` —— `session:<哪一家>/<会话 id>`),拆也只问那一处;
       * 从前这里自己「只切第一刀」手拆一遍,而同一个串在台账里是另一个意思(审计第二表第 15 条)。
       */
      const ref = sessionOfJob(item.key)
      const session = ref === undefined
        ? undefined
        : state.sessions.find(one => one.agent === ref.agent && one.session_id === ref.sessionId)
      return session === undefined ? fallback : {
        key: item.key,
        node: <SessionAsk session={session} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={setReceipt} />,
        row: <SessionAsk session={session} baseUrl={baseUrl} fetchImpl={fetchImpl} variant="row" onExpand={openAsks} />,
      }
    }
    if (item.kind === 'decide') {
      // 要他定的(卡 O):派不出去 / 到上限停下来了 —— 那件事卡上的几颗键(登录 Claude、换一家、继续、停掉)就摆在这一张上。
      const task = state.tasks?.tasks.find(one => one.id === id)
      return task === undefined ? fallback : {
        key: item.key,
        node: (
          <div className="ben-wb__decide" role="group" aria-label={item.text}>
            <p className="ben-wb__askrow-text">{item.text}</p>
            <ItemControls task={task} sessions={state.sessions} baseUrl={baseUrl} fetchImpl={fetchImpl} />
            <button type="button" className="ben-wb__laid-link" onClick={() => lookAt(task.id)}>看看这件</button>
          </div>
        ),
        row: plain(item.text),
      }
    }
    if (item.key.startsWith('dev:')) {
      const proposal = (state.dev_tool?.pending ?? []).find(one => one.id === id)
      return proposal === undefined ? fallback : { key: item.key, node: <DevToolAsk proposal={proposal} baseUrl={baseUrl} fetchImpl={fetchImpl} />, row: plain(item.text) }
    }
    if (item.key.startsWith('layout:')) {
      const ask = (state.layout_ask?.pending ?? []).find(one => one.id === id)
      return ask === undefined ? fallback : { key: item.key, node: <LayoutAsk ask={ask} baseUrl={baseUrl} fetchImpl={fetchImpl} />, row: plain(item.text) }
    }
    if (item.key.startsWith('evolve:')) {
      const proposal = (state.evolve?.pending ?? []).find(one => one.id === id)
      return proposal === undefined ? fallback : { key: item.key, node: <EvolveAsk proposal={proposal} baseUrl={baseUrl} fetchImpl={fetchImpl} />, row: plain(item.text) }
    }
    return fallback
  }
  /**
   * 同一件「等你」只摆一处(2026-09-27,卡 DD;维护者拍板:**留球旁的卡**)。
   *
   * 现场是 Muse「Main chat」、Claude「…方案评估」两张球旁的卡已经写着「等你动手 / 等你看:…」,
   * 球下「等你回答」那一区又各摆一行同一句话。原则:**这一问在屏幕上恰好出现一处**。所以:
   *   - 这一件是一条会话(`kind: 'session'`)、而且它此刻在台上有一张会话卡、卡上摆着那一问 → 球下整张 / 一行 /「展开」都不摆;
   *   - 台上摆不下(超过 `STAGE_SESSION_CARDS_MAX` 被截掉)、或台上那张是**事项卡**(卡面写「进行中 · n 分钟」,没写那一问)→ 照旧在球下摆。
   * 「等你 n」那几个数不动(照旧 `pile.count`):摆在哪儿是一回事,有几件等他是另一回事。
   * 判据 `stageAsks` 在上面(摊开哪一处那条 effect 也读它)。
   */
  const onStageAlready = (item: WaitingItemView): boolean => item.kind === 'session' && stageAsks.has(item.key)
  const pileShown = pile.items.filter(item => !onStageAlready(item))
  const asks: { key: string, node: ReactNode, row: ReactNode }[] = pileShown.map(pileEntry)
  /**
   * ★ **「要你看的」那一层(抽屉)摆的是整份「等你」**(2026-09-28,卡 WQ)。
   *
   * 维护者 16:1x:「这个会话的东西没有进入到待确认的抽屉,这可是核心功能啊。」
   * 现场那一条(Codex 弹的框)服务端算出来了、台上那张卡也画了,可抽屉里一条都没有 —— 因为上面那道
   * 卡 DD 的去重把 `kind:'session'` 从 `pileShown` 里整条撤了,而抽屉和球下那一区读的是同一张表。
   *
   * 分开:**球下常驻那一区照旧按卡 DD 去重**(同一问不在屏幕上出现两次);
   * **抽屉是他自己点开来「看全部」的那一层,一件不少** —— 手机「等你确认」点开也是整份,两端一致。
   */
  const sheetAsks: { key: string, node: ReactNode, row: ReactNode }[] = pile.items.map(pileEntry)
  /**
   * 走光落在哪(2026-09-27,卡 DD 追加):**「要他处理的第一件」**就是「等你」那一堆里排最前的那一件。
   * 它已经在台上有卡 → 光跟着挪到那张卡上(球下那一行已经不摆了,光没处落);球下还有没上卡的等你、
   * 且它排在最前时,光照旧在球下。「这一屏的强效果最多一个」不变(`strongFx`),两处只亮一处。
   */
  const glowStageId = pile.items[0] !== undefined && onStageAlready(pile.items[0]) ? pile.items[0].key : undefined
  /**
   * 不在「等你」那一堆里、但也摆在这一区的(不进数):单子正在落 / 落好了那张回执(他已经点过头),
   * 「额度还差一步」(装配提醒,不是哪件事停着在等他;它出不出来自己定)。摆在那一堆后面。
   */
  const laidExtra = laid !== undefined && laidShown && laid.status !== 'pending'
  /**
   * 系统通知出了问题(卡 M 补;以前静默失败):事务官说一句人话,系统那边的问题给一键去「系统设置 → 通知」那一页。
   * 不进「等你」的数 —— 那不是哪件事停着等他,是这台电脑的一项设置。
   */
  const trouble = notifyTrouble(state.helper)
  const troubleNode = trouble === undefined ? undefined : (
    <>
      <span className="ben-wb__askrow-text">{trouble.text}</span>
      {trouble.settings && <a className="ben-wb__laid-link ben-wb__askrow-open" href={NOTIFY_SETTINGS_URL}>打开通知设置</a>}
    </>
  )
  const extras: { key: string, node: ReactNode, row: ReactNode }[] = [
    ...(laidExtra ? [{
      key: `laid:${laid.id}`,
      node: <MaterializeAsk view={laid} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={laidDismissed} onDismiss={dismissLaid} onOpenSheet={openLaid} />,
      row: <MaterializeAsk view={laid} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={laidDismissed} onDismiss={dismissLaid} onOpenSheet={openLaid} variant="row" />,
    }] : []),
    ...(troubleNode === undefined ? [] : [{ key: 'notify', node: <p className="ben-wb__notify-trouble" role="status">{troubleNode}</p>, row: troubleNode }]),
    /*
     * 固定卡「现在能做什么」(2026-10-21,卡「引导三件事」):三件主路各一行、实验那几样标内测中。不进「等你」的数。
     * 摆在这一张表里(不另挂在这一区末尾):隔离实例真机 1475×812 上这一区收成一行时,挂在末尾的那张整张被截掉、看不见。
     */
    ...(!capabilityShown || state.first_use === undefined ? [] : [{
      key: CAPABILITY_ASK_KEY,
      node: <CapabilityCard state={state} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={capabilityDismissed} onDismiss={dismissCapability} />,
      row: plain(capabilityRowText(state.first_use)),
    }]),
    // 会前准备(2026-10-10):一场待开的会一张 —— 缺的那一问、目的说不清那一下、预案卡全本。
    ...(state.meetings?.upcoming ?? []).map(meeting => ({
      key: `meeting-prep:${meeting.id}`,
      node: <MeetingPrepAsk meeting={meeting} baseUrl={baseUrl} fetchImpl={fetchImpl} />,
      row: plain(meetingPrepRowText(meeting)),
    })),
  ]
  const quotaShown = quotaAskShown(state)
  /** 这一区要摆几样(量摆不摆得下用它);**说出来的数永远是 pile.count**。 */
  const slotCount = asks.length + extras.length + (quotaShown ? 1 : 0)
  /** 抽屉那一层要摆几样(卡 WQ:整份「等你」)。只有它决定抽屉开不开得起来 —— 球下摆不摆得下是另一回事。 */
  const sheetSlotCount = sheetAsks.length + extras.length + (quotaShown ? 1 : 0)
  const asksLayout = asksMode(asksRoom, slotCount)
  /**
   * 只剩一行时那一行:有等他的就是「还有 N 件要你看」;只剩提醒 / 回执时说那一样。
   *
   * N 数的是**这一区真摆出来的那几件**(2026-09-27,卡 DD):已经在台上的那几件不在这一区里,
   * 「展开」摊开的也只有这几张 —— 写 `pile.count` 就成了「还有 3 件要你看」点开只有 1 张,字和摆出来的对不上。
   * 球下「等你 n」、台上「等你 n」、汇报条那几个数照旧读 `pile.count`(那是「有几件等他」,与摆在哪儿无关)。
   */
  const summaryText = pileShown.length > 0 ? asksSummaryText(pileShown.length) : laidExtra ? '我照你说的摆好了' : trouble !== undefined ? '系统没让我弹通知'
    : capabilityShown && state.first_use !== undefined ? capabilityRowText(state.first_use) : '额度还差一步'
  // 动效配角:这一屏的强效果最多一个 —— 交办在路上时输入框亮;否则有要他处理的卡,最前面那张走光。
  // 台上在跑的卡不再单独走光(2026-09-25 卡 P 补三:两张一样在跑、只有一张有光,看的人以为不一致);
  // 只有「等你」那张走(卡 DD:排最前的那一件已经在台上时,光落在那张卡上,球下不走)。
  const strong = strongFx({ visible, composerBusy: sending, ask: slotCount > 0 || glowStageId !== undefined })
  const composerGlow = strong === 'composer'
  const askGlow = strong === 'ask' && glowStageId === undefined
  /** 台上哪张卡走光(缺席 = 台上没有一张走光)。 */
  const stageGlow = strong === 'ask' ? glowStageId : undefined
  /** 整张摆那几张(球下那一区摆得下时;「展开」摊开时也是它 —— 摊开那一层里单子用一行,整张单子另有「看全部」)。 */
  /**
   * 摆那几张。`planAsRow` = 单子那一张收成一行(「展开」摊开的那一层里用);
   * `list` 缺省是球下常驻那一区那几张(按卡 DD 去重过的),抽屉传整份 `sheetAsks`(卡 WQ)。
   */
  const renderAsks = (planAsRow: boolean, list: { key: string, node: ReactNode, row: ReactNode }[] = asks): ReactNode => (
    <>
      {list.map((ask, index) => (
        <FxBeam key={ask.key} name="ask" spec={BEAM.ask} active={askGlow && index === 0}>
          <div className="ben-wb__ask" data-ask={ask.key}>{planAsRow && ask.key.startsWith('laid:') ? ask.row : ask.node}</div>
        </FxBeam>
      ))}
      {/* 不进数的那几样(见 extras):「要你看的」那一层里有等他的时,先隔一行「另外」再摆。 */}
      {planAsRow && list.length > 0 && (extras.length > 0 || quotaShown) && <p className="ben-wb__asks-extra-title">另外</p>}
      {extras.map(extra => (
        <div key={extra.key} className="ben-wb__ask" data-ask={extra.key}>{planAsRow && extra.key !== CAPABILITY_ASK_KEY ? extra.row : extra.node}</div>
      ))}
      {/* 额度还差一步(2026-09-25,卡 fix/quota-and-slot-apps):设计里「球下面那张 3 家额度一键接上」。
          出不出现它自己定(引导没做完、还没扫过、没有要他处理的、他点过「先不」时整块不渲染),
          所以不进上面那张表、不参与走光;排在要他拍板的几张后面。 */}
      <QuotaConnectAsk state={state} baseUrl={baseUrl} fetchImpl={fetchImpl} />
    </>
  )

  // 纯净模式、没展开:整屏只有一颗球与那一行。没有卡片、汇报条、输入框——Ben 原话:
  // 「全屏幕只有一个球,事项卡片都不留」。球变琥珀色是这里唯一的提示。
  if (pure && !pureExpanded) {
    return (
      <section className="ben-wb__items ben-wb__items--particle" data-pure="true" data-expanded="false" aria-label="事项收件箱" style={hiddenStyle}>
        <style>{PARTICLE_STYLE}</style>
        <div className="ben-wb__pure-stage">
          <ParticleOrb mode={mode} notice={orbNotice} visible={visible} settings={settings.preset.settings} paused={settings.paused} preview={settings.preview} {...(waitingOnHimNow ? { label: statusLine } : {})} large onClick={onPureExpand} />
          {(countsLine !== undefined || settings.preview !== undefined) && <p className="ben-wb__orb-counts ben-wb__orb-counts--large">{settings.preview ? `${settings.preview.label}${countsLine ? ` · ${countsLine}` : ''}` : countsLine}</p>}
        </div>
      </section>
    )
  }

  return (
    <section
      className="ben-wb__items ben-wb__items--particle"
      data-pure={pure}
      data-settings={settingsOpen}
      data-expanded={pure ? 'true' : undefined}
      data-laid={laidPending ? 'pending' : undefined}
      data-asks-mode={slotCount === 0 ? undefined : asksLayout}
      aria-label="事项收件箱"
      style={hiddenStyle}
      ref={sectionRef}
    >
      {/* 纯净模式的临时展开:这层背板接"点空白收回";堆/球/输入框自己接自己的点击。 */}
      {pure && <div className="ben-wb__pure-backdrop" data-testid="ben-wb-pure-backdrop" onClick={onPureCollapse} />}

      <style>{PARTICLE_STYLE}</style>
      <style>{ASK_STYLE}</style>
      <style>{SESSION_ASK_STYLE}</style>
      <ButlerScene
        state={state} visible={visible} read={read} onRead={setRead} focusedId={focusId} onFocus={setFocusId}
        compact={compact} {...(onLocate === undefined ? {} : { onLocate })}
        {...(stageGlow === undefined ? {} : { stageGlow })}
        proposals={controls.proposals} onOpen={openConversation} onConfirm={confirmTask} onProposal={answerProposal} onAdoptTopic={adoptTopic} onDeclineTopic={declineTopic} topicBusy={topicBusy} onRetryMeeting={retryMeeting} onMeetingOutcome={meetingOutcome}
        itemControls={(item) => {
          // 卡 O:聚焦那张卡(事务官自己在办的 / 派出去的)上的花费、「停掉这一件」、到上限的三颗键、派不出去的修法。
          const task = state.tasks?.tasks.find(one => one.id === item.id)
          return task === undefined ? null : <ItemControls task={task} sessions={state.sessions} baseUrl={baseUrl} fetchImpl={fetchImpl} />
        }}
        talk={{ baseUrl, fetchImpl, onReceipt: setReceipt }}
        orb={<ParticleOrb mode={mode} notice={orbNotice} visible={visible} settings={settings.preset.settings} paused={settings.paused} preview={settings.preview} {...(waitingOnHimNow ? { label: statusLine } : {})} />}
        tools={<span className="ben-wb__particle-actions">
          <button type="button" className="ben-wb__orb-drawer-btn" aria-label="事务官抽屉" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(open => !open)}>⋯</button>
          <button type="button" aria-label="粒子外观设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}>外观设置</button>
        </span>}
        asks={<>
          {drawerOpen && <Drawer controls={controls} routines={state.routines} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={setReceipt} />}
          {/* 处理完那份的详情(看详情才摊开):在球下这一区里,跟着这一区一起滚,不另占一块。 */}
          {sayDone !== undefined && sayOpen === sayDone && <SayDecisionCards payload={sayDone} state={state} busy={sayBusy || sending} onChoose={chooseSay} hideScreen />}
          {/*
            球下那一区摆得下多少就摆多少(卡 fix/materialize-card-fit,统筹拍板:球不让):整张 → 每张一行 → 只留一行「还有 N 件要你看 · 展开」。
            一行里「展开」「看全部」「改一下」把整张摊在这一档上面。
          */}
          {asksLayout === 'full' && renderAsks(false)}
          {asksLayout === 'rows' && [
            ...asks.map((ask, index) => (
              <FxBeam key={ask.key} name="ask" spec={BEAM.ask} active={askGlow && index === 0}>
                <div className="ben-wb__askrow" data-ask={ask.key}>{ask.row}</div>
              </FxBeam>
            )),
            ...extras.map(extra => <div key={extra.key} className="ben-wb__askrow" data-ask={extra.key}>{extra.row}</div>),
            ...(quotaShown ? [<div key="quota" className="ben-wb__askrow" data-ask="quota">{plain('额度还差一步')}</div>] : []),
          ]}
          {asksLayout === 'summary' && (
            <FxBeam name="ask" spec={BEAM.ask} active={askGlow}>
              <div className="ben-wb__askrow ben-wb__askrow--summary" data-ask="summary">
                <span className="ben-wb__askrow-text">{summaryText}</span>
                <span className="ben-wb__askrow-dot" aria-hidden="true">·</span>
                <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={openAsks}>展开</button>
              </div>
            </FxBeam>
          )}
          {/* 第一次用、手上一件事都没有(2026-09-18):一句话。见 ButlerInboxProps.empty。 */}
          {empty !== undefined && <EmptyState view={empty} />}
        </>}
      >
        <>
          <p className="ben-wb__particle-mode">{statusLine}</p>
          {settings.preview && <button type="button" onClick={() => settingsStore.preview(undefined)}>关闭动效预览</button>}
          {countsLine !== undefined && <p className="ben-wb__orb-counts">{countsLine}</p>}
          {/*
            ★ **答案来找她 —— 电脑这一处**(2026-10-04,卡 `claude/answer-comes-to-her`)。
            「她在哪问就在哪答」:电脑输入框里问的那一句,答案就摆在球下这一处 ——
            与手机球下那一行字幕是**同一格**(`/state.answers`,一处算、两端只显示)。
            点一下 = 标「看过了」,这一条随下一拍快照收掉。
          */}
          {freshAnswer !== undefined && (
            <button
              type="button"
              className="ben-wb__orb-answer"
              aria-label={`事务官答:${freshAnswer.answer}。点一下收起这条回答`}
              onClick={() => markSeen('/answers/seen', freshAnswer.id)}
            >
              {freshAnswer.question !== '' && <span className="ben-wb__orb-answer-ask">{freshAnswer.question}</span>}
              <span className="ben-wb__orb-answer-said">{freshAnswer.answer}</span>
            </button>
          )}
          {/*
            ★ 「刚办完 · 结果一句话」(同上第 2 条):办完**不直接沉进「办完」**,
            先在这儿摆一条,她点开看过或划掉才收进去。摆哪几条工作台一处算(`/state.fresh_results`),
            这一层只渲染 —— 一个条件都不自己判。
          */}
          {/*
            交代后的处理结果(2026-10-27,维护者在装机版浮窗撞到「盖住、滑不动、关不掉」):处理完、不要她再点的,
            收成「最近结果」这一处的一行 —— 服务端那一句 + 件数;「看详情」在下面那一区摊开,「标为已读」收掉,下次交代再出新的一行。
          */}
          {sayLine !== undefined && sayDone !== undefined && (
            <p className="ben-wb__say-line" role="status">
              {sayLine.screen !== undefined && <span className="ben-wb__say-line-text">{sayLine.screen}</span>}
              {sayLine.count !== undefined && <span className="ben-wb__say-line-count">{sayLine.count}</span>}
              <button type="button" aria-expanded={sayOpen === sayDone} onClick={() => setSayOpen(sayOpen === sayDone ? undefined : sayDone)}>{sayOpen === sayDone ? '收起详情' : '看详情'}</button>
              <button type="button" onClick={() => { setSaySeen(sayDone); setSayOpen(undefined) }}>标为已读</button>
            </p>
          )}
          {freshResults.length > 0 && (
            <ul className="ben-wb__orb-fresh" aria-label="刚办完">
              {freshResults.map(one => (
                <li key={one.task_id}>
                  <span className="ben-wb__orb-fresh-text">{one.result ?? one.title}</span>
                  {one.result !== undefined && <span className="ben-wb__orb-fresh-note">{one.title}</span>}
                  <button
                    type="button"
                    className="ben-wb__orb-fresh-seen"
                    aria-label={`划掉「${one.title}」这一条(卡还在「办完」里)`}
                    onClick={() => markSeen('/task/seen-result', one.task_id)}
                  >划掉</button>
                </li>
              ))}
            </ul>
          )}
          <p className="ben-wb__items-report" role="status" aria-label="汇报条" data-open={reportOpen}>
            {/* 汇报与球下都报公共业务事项数；窗口槽另按各家运行会话数显示。 */}
            <span className="ben-wb__items-report-text">{butlerReportLine(state, businessRunning)}</span>
            <button type="button" className="ben-wb__items-report-toggle" aria-label={reportOpen ? '收起汇报条' : '展开汇报条'} aria-expanded={reportOpen} onClick={() => setReportOpen(open => !open)}>{reportOpen ? '▴' : '▾'}</button>
          </p>
        </>
      </ButlerScene>
      {settingsOpen && <ParticleSettings onClose={() => setSettingsOpen(false)} />}

      {receipt !== undefined && <p className="ben-wb__items-receipt" role="status">{receipt}</p>}
      {/* 还要她点的(确认、改选、建议)照旧摆在输入框上方;处理完的那种见球下那一行。 */}
      {sayPending && sayCards !== undefined && <SayDecisionCards payload={sayCards} state={state} busy={sayBusy || sending} onChoose={chooseSay} />}

      {/* 统一输入框(2026-09-24):事务官完整版 —— +、@、模式、模型、发送。 */}
      <div className="ben-wb__composer-slot">
        <Composer
          trim="butler"
          text={draft}
          onTextChange={onDraftChange}
          onSubmit={submit}
          busy={sending}
          glow={composerGlow}
          fxName="composer"
          fxSpec={BEAM.composer}
          placeholder="有什么事,交给我。"
          ariaLabel="交给事务官一件事"
          sendLabel="交给事务官"
          current={state.composer}
          baseUrl={baseUrl}
          fetchImpl={fetchImpl}
          inputRef={inputRef}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
      {/*
        整张单子摊开(卡 fix/materialize-card-fit):盖在事务官这一档上面(球、输入框都盖住),卡头「收起」回去;
        底栏照样钉在底下。单子落好了 / 收起了 / 不在了就不摆。
      */}
      {/* 要他看的几张整张摊开(「还有 N 件要你看 · 展开」、一行里的「展开」):盖在这一档上面,「收起」回去。 */}
      {asksSheet && sheetSlotCount > 0 && (
        <div className="ben-wb__asks-sheet" role="dialog" aria-label="要你看的">
          <div className="ben-wb__asks-sheet-head">
            {/* N = 整份「等你」(卡 WQ:抽屉是「看全部」那一层,已经在台上的那几件也在里面,数与球下「等你 n」一致)。 */}
            <p className="ben-wb__asks-sheet-title">{pile.count > 0 ? `要你看的 ${pile.count} 件` : '要你看一眼的'}</p>
            <button type="button" className="ben-wb__laid-ghost" onClick={() => setAsksSheet(false)}>收起</button>
          </div>
          <div className="ben-wb__asks-sheet-body ben-wb__asks">{renderAsks(true, sheetAsks)}</div>
        </div>
      )}
      {laidSheet !== undefined && laid !== undefined && laidShown && (
        <div className="ben-wb__laid-sheet" role="dialog" aria-label="我照你说的摆好了(整张)">
          <MaterializeAsk
            view={laid} baseUrl={baseUrl} fetchImpl={fetchImpl} dismissed={laidDismissed} onDismiss={dismissLaid}
            variant="sheet" startEditing={laidSheet === 'edit'} onCloseSheet={() => setLaidSheet(undefined)}
          />
        </div>
      )}
    </section>
  )
}
