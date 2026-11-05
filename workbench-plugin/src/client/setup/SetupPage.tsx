/**
 * 初始化页(登录台,2026-09-17)。Ben 09-17 拍板②:**登录台放网页里**,壳只负责打开它。
 *
 * 形态:整屏一页,九步竖排,每步一盏灯(已就绪 / 程序在做 / 等你点一下 / 等你填)。
 * 它**不是新一套配置系统** —— 密钥仍是 `CredentialPanel`、配对二维码仍是 `PairQr`、
 * 路径与钩子调卡 C 的 `/config/*`;这一页只负责"把七道关排成一条线,并在每一处给一个
 * 能按下去的按钮"。
 *
 * 一条贯穿全页的纪律:**按钮按下去要有话**。这一页上每个按钮背后都是一次真会改机器的
 * 动作(装运行时、写 launchd、往 /Applications 里 ditto),所以失败必须把服务端那句人话
 * 和原始输出的尾巴显示出来,绝不做成"点了没反应"(那正是 postSilently 在看板上合适、
 * 在这里绝不合适的原因)。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SetBtn, SetRow, SetSection } from '../settings/setKit.tsx'
import type { WorkbenchState } from '../../protocol.ts'
import type { SetupAction, SetupApkView, SetupInstallStep, SetupItem, SetupJobView, SetupPane, SetupStatus } from '../../server/setup/types.ts'
import { CredentialPanel } from '../CredentialPanel.tsx'
import { PairQr } from '../PairQr.tsx'
import {
  exportDiagPackage, fetchConfigHooks, fetchConfigPaths, fetchDiagSend, fetchDiagSettings, fetchFeedbackList, fetchSetupApk, fetchSetupJob,
  fetchSetupStatus, markDiagNoticeSeen, openSetupPane,
  putConfigPaths, sendDiagPackage, setDiagReportEnabled, setLanAccess, startPairing, startSetupInstall,
  type ConfigHooksView, type ConfigPathsView, type DiagExportResponse,
} from './setupApi.ts'
import type { DiagSendView, DiagSettingsView, FeedbackListView } from '../../diag.ts'
import { codedOf, ErrorNote } from '../ErrorNote.tsx'
import { groupSetupSteps, LAMP_LABELS, setupHeadline, type SetupLamp } from './steps.ts'
// 钩子由工作台代写(2026-09-17 Ben 拍板)。这一页原来只把要写的内容摆出来让他自己复制;
// 现在同一处多两颗按钮,点了弹「先看后写」的确认框 —— 看板解锁卡上那颗是同一个组件。
import { HooksApplyDialog } from '../HooksApplyDialog.tsx'
import { MemoryImportPanel } from './MemoryImportPanel.tsx'
import type { HooksAgent } from '../hooksApply.ts'

/** 安装作业的轮询间隔。装运行时要几分钟,一秒一问既不贵也够灵敏。 */
const JOB_POLL_MS = 1000

export interface SetupPageProps {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** /state 那一份。手机、事务官、通道层几步直接读它,不另外拉。 */
  state: WorkbenchState
  onClose: () => void
  /** 轮询间隔,测试传 0 表示不起定时器。 */
  jobPollMs?: number
}

interface JobSlot { step: SetupInstallStep, job: SetupJobView }

export function SetupPage({ baseUrl, fetchImpl, state, onClose, jobPollMs }: SetupPageProps) {
  const doFetch = fetchImpl ?? fetch
  const pollMs = jobPollMs ?? JOB_POLL_MS
  const [status, setStatus] = useState<SetupStatus | undefined>(undefined)
  const [error, setError] = useState<{ text: string, code?: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [jobs, setJobs] = useState<readonly JobSlot[]>([])
  const [apk, setApk] = useState<SetupApkView | undefined>(undefined)
  const [paths, setPaths] = useState<ConfigPathsView | undefined | 'pending'>(undefined)
  const [repoDraft, setRepoDraft] = useState('')
  const [hooks, setHooks] = useState<ConfigHooksView | undefined | 'pending'>(undefined)
  /** 正在给哪家代写(undefined = 没开框)。 */
  const [applyFor, setApplyFor] = useState<HooksAgent | undefined>(undefined)
  const [phoneChoice, setPhoneChoice] = useState<'unknown' | 'installed' | 'skipped'>('unknown')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const recheck = useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      const next = await fetchSetupStatus(baseUrl, doFetch)
      if (mounted.current) setStatus(next)
    }
    catch (err) {
      if (mounted.current) setError(codedOf(err, '就绪检查失败'))
    }
    finally {
      if (mounted.current) setChecking(false)
    }
  }, [baseUrl, doFetch])

  useEffect(() => { void recheck() }, [recheck])

  // 手机端的包、路径配置:各拉一次。拉不到不挡这一页(对应那一步自己会说明)。
  useEffect(() => {
    void fetchSetupApk(baseUrl, doFetch).then(view => { if (mounted.current) setApk(view) }).catch(() => {})
    void fetchConfigPaths(baseUrl, doFetch).then((result) => {
      if (!mounted.current) return
      if (result.pending) { setPaths('pending'); return }
      setPaths(result.value)
      setRepoDraft(result.value.butler_cwd ?? result.value.effective.butler_cwd ?? '')
    }).catch(() => {})
  }, [baseUrl, doFetch])

  // 在跑的安装作业:一秒问一次,跑完自动重检一遍体检。
  const runningIds = jobs.filter(slot => slot.job.state === 'running').map(slot => slot.job.id).join(',')
  useEffect(() => {
    if (pollMs === 0 || runningIds === '') return
    const timer = window.setInterval(() => {
      for (const id of runningIds.split(',')) {
        void fetchSetupJob(baseUrl, id, doFetch).then((next) => {
          if (!mounted.current) return
          setJobs(prev => prev.map(slot => (slot.job.id === next.id ? { ...slot, job: next } : slot)))
          if (next.state === 'done') void recheck()
        }).catch(() => { /* 下一拍再问 */ })
      }
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [runningIds, baseUrl, doFetch, pollMs, recheck])

  const install = useCallback(async (step: SetupInstallStep) => {
    setError(null)
    try {
      const job = await startSetupInstall(baseUrl, step, doFetch)
      if (!mounted.current) return
      setJobs(prev => [...prev.filter(slot => slot.step !== step), { step, job }])
      // 带 url 的那一步(web_login)由下面那个 effect 统一开,**只开一次** ——
      // 在这里也开一次的话,同一个地址会被打开两遍(它随即也进了 jobs)。
    }
    catch (err) {
      if (mounted.current) setError(codedOf(err, '开始安装失败'))
    }
  }, [baseUrl, doFetch])

  // web_login 的地址可能是轮询之后才拿到的,这里统一处理一次(只开一次)。
  const openedUrls = useRef(new Set<string>())
  useEffect(() => {
    for (const slot of jobs) {
      const url = slot.job.url
      if (url === undefined || openedUrls.current.has(url)) continue
      openedUrls.current.add(url)
      window.open(url, '_blank', 'noopener')
    }
  }, [jobs])

  const openPane = useCallback(async (pane: SetupPane) => {
    setError(null)
    try { await openSetupPane(baseUrl, pane, doFetch) }
    catch (err) { if (mounted.current) setError(codedOf(err, '打开系统设置失败')) }
  }, [baseUrl, doFetch])

  const runningSteps = useMemo(
    () => jobs.filter(slot => slot.job.state === 'running').map(slot => slot.step),
    [jobs],
  )
  const steps = useMemo(() => groupSetupSteps(status, runningSteps), [status, runningSteps])
  const jobFor = (step: SetupInstallStep): SetupJobView | undefined => jobs.find(slot => slot.step === step)?.job

  return (
    <div className="ben-wb__setup" role="dialog" aria-modal="true" aria-label="体检与修复">
      <div className="ben-wb__setup-head">
        <div>
          <h2 className="ben-wb__setup-ttl">体检与修复</h2>
          <p className="ben-wb__setup-sub" role="status">{setupHeadline(status)}</p>
        </div>
        <div className="ben-wb__setup-headact">
          <button type="button" className="ben-wb__setup-btn" disabled={checking} onClick={() => { void recheck() }}>
            {checking ? '检查中…' : '重新检查'}
          </button>
          <button type="button" className="ben-wb__setup-btn" aria-label="关闭体检与修复" onClick={onClose}>关闭</button>
        </div>
      </div>

      {/* 报错带编号(2026-09-22):Ben 念六个数字,统筹在日志与中转两头都捞得到同一条。 */}
      <ErrorNote className="ben-wb__setup-err" text={error?.text ?? null} code={error?.code} />

      <ol className="ben-wb__setup-list">
        {steps.map(step => (
          <li className="ben-wb__setup-step" key={step.no} aria-label={`第 ${step.no} 步 ${step.title}`}>
            <div className="ben-wb__setup-stephead">
              <Lamp lamp={step.lamp} />
              <span className="ben-wb__setup-stepno">{step.no}</span>
              <span className="ben-wb__setup-steptitle">{step.title}</span>
              <span className="ben-wb__setup-steplamp">{LAMP_LABELS[step.lamp]}</span>
            </div>
            <p className="ben-wb__setup-stepsum">{step.summary}</p>
            {step.optionalPending > 0 && (
              <p className="ben-wb__setup-hint">{`另有 ${step.optionalPending} 项可选的没弄,不影响用。`}</p>
            )}

            <div className="ben-wb__setup-items">
              {step.items.map(item => (
                <ItemRow
                  key={item.key}
                  item={item}
                  job={item.action?.kind === 'install' ? jobFor(item.action.step) : undefined}
                  onInstall={install}
                  onOpenPane={openPane}
                  onRecheck={recheck}
                  rechecking={checking}
                />
              ))}
            </div>

            {step.no === 1 && <RestartRow job={jobFor('restart')} onInstall={install} />}
            {step.no === 2 && (
              <RepoPanel
                paths={paths}
                draft={repoDraft}
                onDraft={setRepoDraft}
                onSave={async () => {
                  setError(null)
                  try {
                    const saved = await putConfigPaths(baseUrl, { butler_cwd: repoDraft }, doFetch)
                    if (!mounted.current) return
                    setPaths(saved.pending ? 'pending' : saved.value)
                    await recheck()
                  }
                  catch (err) { if (mounted.current) setError(codedOf(err, '保存仓库路径失败')) }
                }}
              />
            )}
            {step.no === 4 && (
              <>
                <CredentialPanel expanded baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />
                <HooksPanel
                  hooks={hooks}
                  onLoad={async () => {
                    const result = await fetchConfigHooks(baseUrl, 'claude', doFetch).catch(() => ({ pending: true as const }))
                    if (mounted.current) setHooks(result.pending ? 'pending' : result.value)
                  }}
                  onApply={setApplyFor}
                />
              </>
            )}
            {step.no === 6 && <DirsPanel paths={paths} />}
            {step.no === 7 && <ButlerPanel state={state} baseUrl={baseUrl} fetchImpl={doFetch} />}
            {step.no === 8 && (
              <PhonePanel
                state={state}
                apk={apk}
                choice={phoneChoice}
                onChoice={setPhoneChoice}
                onPair={async () => {
                  setError(null)
                  try {
                    if (state.lan?.enabled !== true) await setLanAccess(baseUrl, true, doFetch)
                    await startPairing(baseUrl, doFetch)
                  }
                  catch (err) { if (mounted.current) setError(codedOf(err, '生成配对码失败')) }
                }}
              />
            )}
            {step.no === 9 && <WrapUpPanel />}
          </li>
        ))}
      </ol>

      <SwitchLogPanel state={state} />

      <DiagPanel baseUrl={baseUrl} fetchImpl={doFetch} pollMs={pollMs} />
      {/* 「把各家 Agent 的记忆拷给事务官」(2026-09-22)。摆在这一页**末尾**:
          它不是"开机要过的一道关",是想起来就能点一次的维护动作 —— 同上面那块窗位切换记录。
          同期 `feat/diagnostics` 那张卡也在往这一页加东西,所以它是独立组件 + 独立一节。 */}
      <MemoryImportPanel baseUrl={baseUrl} {...(fetchImpl === undefined ? {} : { fetchImpl })} />

      {/* 代写钩子的确认框(2026-09-17)。跟看板解锁卡上那颗按钮弹的是同一个组件 ——
          两处文案、两处"先看后写"的顺序因此不可能走样。 */}
      {applyFor !== undefined && (
        <HooksApplyDialog
          agent={applyFor}
          baseUrl={baseUrl}
          {...(fetchImpl === undefined ? {} : { fetchImpl })}
          onClose={() => setApplyFor(undefined)}
          onChanged={() => { void recheck() }}
        />
      )}
    </div>
  )
}

/**
 * 「出错怎么让人知道」(2026-09-22,Ben:「我弄了台新 Mac,到时候就是脱机运行了,
 * 报错信息和日志什么的得准备好,不然你修复和优化都很不方便」)。
 *
 * 两件事摆在同一块里,因为它们回答的是同一个问题:
 *   ① **导出诊断包** —— 他点一下,桌面上出现一个 zip,微信发过来;
 *   ② **出错自动报告给开发者** —— 机器自己报,他什么都不用做。
 *
 * 开关**默认开**,所以这一块的第一要务是**把话说清楚**:报什么、不报什么、怎么关。
 * 第一次进这一页时那段说明是展开的(`notice_seen` 为假),看过一次之后收起来 ——
 * 默认开 + 说清楚 + 一颗随时能关的开关,是这一版的选择(决策记录里写着,可推翻)。
 *
 * **导出按下去要有话**(这一页的老规矩):它要读日志、跑 `log show`、压包,
 * 在慢机器上十几秒。所以有「在打包…」,完了把包内清单摊开给他看 ——
 * 一个不知道里头装了什么的 zip,没人敢发给别人。
 */
function DiagPanel({ baseUrl, fetchImpl, pollMs }: { baseUrl: string, fetchImpl: typeof fetch, pollMs: number }) {
  const [settings, setSettings] = useState<DiagSettingsView | undefined>(undefined)
  /** 「我反馈过的问题」那一行。读不到就一直是 undefined = 那一行不出现。 */
  const [feedback, setFeedback] = useState<FeedbackListView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DiagExportResponse | undefined>(undefined)
  const [error, setError] = useState<{ text: string, code?: string } | null>(null)
  const [openList, setOpenList] = useState(false)
  /** 「发诊断包」那一趟(2026-10-21)。跑着时每拍问一次,跑完停。 */
  const [sendView, setSendView] = useState<DiagSendView | undefined>(undefined)
  const [sendError, setSendError] = useState<{ text: string, code?: string } | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    void fetchDiagSettings(baseUrl, fetchImpl).then((view) => {
      if (!mounted.current) return
      setSettings(view)
      // 看过一次就记一笔。**只记不拦**:没记上最多下次再展开一遍。
      if (!view.notice_seen) void markDiagNoticeSeen(baseUrl, fetchImpl)
    }).catch(() => { /* 这一块拿不到就整块不出现,不挡这一页 */ })
    void fetchFeedbackList(baseUrl, fetchImpl).then((view) => {
      if (mounted.current) setFeedback(view)
    }).catch(() => { /* 同上:这一行拿不到就不出现 */ })
  }, [baseUrl, fetchImpl])

  useEffect(() => {
    if (sendView?.state !== 'running' || pollMs <= 0) return
    const timer = setTimeout(() => {
      void fetchDiagSend(baseUrl, fetchImpl)
        .then((next) => { if (mounted.current && next.state !== 'none') setSendView(next) })
        .catch((err: unknown) => { if (mounted.current) setSendError(codedOf(err, '看不到诊断包发没发出去')) })
    }, pollMs)
    return () => { clearTimeout(timer) }
  }, [baseUrl, fetchImpl, pollMs, sendView])

  if (settings === undefined) return null

  const sendNow = async (): Promise<void> => {
    setSendError(null)
    try {
      const started = await sendDiagPackage(baseUrl, fetchImpl)
      if (mounted.current) setSendView(started)
    }
    catch (err) { if (mounted.current) setSendError(codedOf(err, '发诊断包失败')) }
  }
  const sending = sendView?.state === 'running'

  const toggle = async (next: boolean): Promise<void> => {
    setError(null)
    try {
      const view = await setDiagReportEnabled(baseUrl, next, fetchImpl)
      if (mounted.current) setSettings(view)
    }
    catch (err) { if (mounted.current) setError(codedOf(err, '改不动这个开关')) }
  }

  const exportNow = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    setResult(undefined)
    try {
      const out = await exportDiagPackage(baseUrl, fetchImpl)
      if (!mounted.current) return
      setResult(out)
      if (out.ok) setOpenList(true)
    }
    catch (err) { if (mounted.current) setError(codedOf(err, '导出诊断包失败')) }
    finally { if (mounted.current) setBusy(false) }
  }

  return (
    <section className="ben-wb__setup-step" aria-label="出错怎么让人知道">
      <div className="ben-wb__setup-stephead">
        <span className="ben-wb__setup-steptitle">出错怎么让人知道</span>
      </div>
      <p className="ben-wb__setup-stepsum">
        这台电脑出了毛病,得让做这个工作台的人看得见。两条路:你导一个包发过去,或者让它自己报。
      </p>

      <ErrorNote className="ben-wb__setup-err" text={error?.text ?? null} code={error?.code} />

      <div className="ben-wb__setup-items">
        {/* ── 一、导出诊断包 ───────────────────────────────────────── */}
        <div className="ben-wb__setup-item" data-state={busy ? 'missing' : 'ok'} aria-label="导出诊断包">
          <div className="ben-wb__setup-itemhead">
            <span className="ben-wb__setup-itemname">导出诊断包</span>
            <button type="button" className="ben-wb__setup-btn" disabled={busy} onClick={() => { void exportNow() }}>
              {busy ? '在打包…' : '导出诊断包'}
            </button>
          </div>
          <p className="ben-wb__setup-detail">
            最近 7 天的日志、各组件版本、体检结果与几份配置,打成一个 zip 放到桌面并在访达里选中。
            <strong>密码、密钥、浏览器登录档案一个字节都不进去</strong>;包里有一份《包内清单》写着装了什么、擦掉了什么。
          </p>
          {result !== undefined && !result.ok && (
            <ErrorNote className="ben-wb__setup-err" text={result.error} />
          )}
          {result !== undefined && result.ok && (
            <>
              <p className="ben-wb__setup-detail">
                {`好了:${result.file_redacted}(${Math.max(1, Math.round(result.bytes / 1024))}KB,${result.entries.length} 项)`}
                {result.revealed ? '。访达里已经帮你选中它了。' : '。访达没弹出来,自己去桌面找一下。'}
              </p>
              <button type="button" className="ben-wb__setup-btn" onClick={() => setOpenList(!openList)}>
                {openList ? '收起包内清单' : '看看包里有什么'}
              </button>
              {openList && (
                <div className="ben-wb__setup-items" aria-label="包内清单">
                  {result.entries.map(entry => (
                    <p className="ben-wb__setup-detail" key={entry.path}>
                      {`${entry.path} · ${Math.max(1, Math.round(entry.bytes / 1024))}KB${entry.truncated === true ? ' · 前面截断过' : ''}${entry.note === undefined ? '' : ` · ${entry.note}`}`}
                    </p>
                  ))}
                  {result.skipped.map(item => (
                    <p className="ben-wb__setup-detail" key={`skip-${item.what}`}>
                      {`没收:${item.what} —— ${item.why}`}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 一½、发诊断包(2026-10-21):同一个包直接交到服务器,回一个编号 ───────── */}
        <div className="ben-wb__setup-item" data-state={sending ? 'missing' : 'ok'} aria-label="发诊断包">
          <div className="ben-wb__setup-itemhead">
            <span className="ben-wb__setup-itemname">发诊断包</span>
            <button type="button" className="ben-wb__setup-btn" disabled={sending} onClick={() => { void sendNow() }}>
              {sending ? '在打包、在传…' : '发诊断包'}
            </button>
          </div>
          <p className="ben-wb__setup-detail">
            同一个包,不用存桌面再微信发:直接交到工作台的服务器上,回一个六位编号,把编号发给统筹就行。
            服务器上 7 天后自动删。手机设置里也有这颗键。
          </p>
          <ErrorNote className="ben-wb__setup-err" text={sendError?.text ?? null} code={sendError?.code} />
          {sendView?.state === 'done' && sendView.code !== undefined && (
            <p className="ben-wb__setup-detail" role="status">
              {`交上去了。编号 ${sendView.code},把它发给统筹(7 天内取得到)。`}
            </p>
          )}
          {sendView?.state === 'failed' && (
            <>
              <ErrorNote className="ben-wb__setup-err" text={sendView.error ?? '诊断包没发出去'} />
              {sendView.kept !== undefined && (
                <p className="ben-wb__setup-detail">
                  {`包留在这台电脑上了:${sendView.kept.file}。用微信发给统筹也行。`}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── 二、自动上报 ─────────────────────────────────────────── */}
        <div className="ben-wb__setup-item" data-state={settings.report_enabled ? 'ok' : 'needs_user'} aria-label="出错自动报告给开发者">
          <div className="ben-wb__setup-itemhead">
            <span className="ben-wb__setup-itemname">出错自动报告给开发者</span>
            <label className="ben-wb__setup-switch">
              <input
                type="checkbox"
                checked={settings.report_enabled}
                aria-label="出错自动报告给开发者"
                onChange={event => { void toggle(event.target.checked) }}
              />
              <span>{settings.report_enabled ? '开着' : '关着'}</span>
            </label>
          </div>
          {/* 第一次进来把话摊开说;看过一次之后仍然留着,只是短一点。 */}
          <p className="ben-wb__setup-detail">
            {settings.notice_seen
              ? '出错时自动把一条脱敏过的报错发给开发者。随时可以关。'
              : '这一项默认是开着的,所以先把话说清楚:'}
          </p>
          {!settings.notice_seen && (
            <>
              <p className="ben-wb__setup-detail">
                <strong>报什么</strong>:程序崩了、更新失败、通话异常结束这几种情况下,
                把一句报错、出错位置的前 20 行、以及出错前后 50 行日志发给开发者。路径里你的用户名会换成「用户」。
              </p>
              <p className="ben-wb__setup-detail">
                <strong>不报什么</strong>:你的密码与密钥、你跟事务官说过的话、任何文件内容。每小时最多 20 条,多了合并成一条计数。
              </p>
              <p className="ben-wb__setup-detail">
                <strong>不想报</strong>:把右边这个开关关掉。关掉之后报错仍然写在本机日志里,
                需要时你再用上面那颗按钮导一个包。
              </p>
            </>
          )}
          <p className="ben-wb__setup-detail">
            {settings.relay_url === undefined
              ? '这会儿还没连上服务器(没登录),报错只留在本机日志里。'
              : `这一小时已经报了 ${settings.sent_this_hour} / ${settings.hourly_limit} 条。`}
          </p>
        </div>

        {/* ── 三、我反馈过的问题 ───────────────────────────────────── */}
        <FeedbackRow list={feedback} />
      </div>
    </section>
  )
}

/**
 * 「我反馈过的问题」(2026-09-28,卡 FB)。
 *
 * 她说了一句「这里不对」,事务官答「我已经反馈给开发者了」—— 那句承诺得有个**看得见的落处**,
 * 否则她没法知道到底发出去没有。所以这一行只说三件事:发了几条、每条是哪一句、状态。
 *
 * **不做工单**(卡上写着):没有「处理中 / 已修复 / 不修」那一串状态机 —— 那需要服务器往回说话,
 * 而这一版服务器只负责收。状态只有两种:服务器收到了(「已收到」)、还没发出去(写清为什么)。
 * 读不到这一份就整块不出现(同这一块别的几格:不摆一个「0 条」让她以为自己说的话没记下)。
 */
function FeedbackRow({ list }: { list: FeedbackListView | undefined }) {
  // 读不到、或者回来的东西形状不对 → 整行不出现(**不摆一个「0 条」**让她以为自己说的话没记下)。
  if (list === undefined || !Array.isArray(list.items) || list.items.length === 0) return null
  const waiting = list.items.filter(one => one.status === 'asking').length
  return (
    <div className="ben-wb__setup-item" data-state="ok" aria-label="我反馈过的问题">
      <div className="ben-wb__setup-itemhead">
        <span className="ben-wb__setup-itemname">我反馈过的问题</span>
        <span className="ben-wb__setup-detail">{`${list.items.length} 条,${list.sent} 条已收到`}</span>
      </div>
      <p className="ben-wb__setup-detail">
        工作台本身的毛病(界面、功能、bug)不派给你的 Agent 改 —— 事务官整理一条发给开发者,修好了随更新到你这。
        {waiting > 0 ? `还有 ${waiting} 条等你说一句是改工作台本身、还是另做一个小工具。` : ''}
      </p>
      {list.items.map(one => (
        <p className="ben-wb__setup-detail" key={one.id}>
          {`${one.at.slice(0, 16).replace('T', ' ')} · ${one.code} · ${one.note}`}
          {' — '}
          {one.status === 'sent' ? '已收到' : one.status === 'asking' ? '等你答一句' : `还没发出去:${one.why ?? '原因不明'}`}
        </p>
      ))}
    </div>
  )
}

function Lamp({ lamp }: { lamp: SetupLamp }) {
  return <i className={`ben-wb__setup-dot ben-wb__setup-dot--${lamp}`} aria-hidden="true" />
}

/**
 * 「最近的窗位切换」(2026-09-21 Ben:「今天点击标签切换应用经常卡住」)。
 *
 * 为什么它该出现在体检页上:"卡住"只有 Ben 感觉得到,而**他没有任何办法把这种感觉变成
 * 一个数字**。之前排查这类问题全靠 curl `/state` 抠 JSON —— 那是命令行,他不走那条路
 * (docs/project-memory:用户环节不走命令行)。这一小块把服务端已经在记的
 * `dock.recent_switches` 一行一条摊开:哪一次慢、慢在抬窗还是收尾、谁没动成,
 * 下次他说"又卡了"时就有东西可指。
 *
 * **最小 UI,刻意的**:一行一条、没有排序没有筛选没有图,一条都没有时整块不出现
 * (缺省即无,同这一页别处的纪律)。它是证据,不是仪表盘。
 */
function SwitchLogPanel({ state }: { state: WorkbenchState }) {
  const entries = state.dock?.recent_switches
  if (entries === undefined || entries.length === 0) return null
  return (
    <section className="ben-wb__setup-step" aria-label="最近的窗位切换">
      <div className="ben-wb__setup-stephead">
        <span className="ben-wb__setup-steptitle">最近的窗位切换</span>
      </div>
      <p className="ben-wb__setup-stepsum">
        点标签切应用花了多久。正常是几十毫秒;上百毫秒以上多半是那家应用自己忙着没回话。
      </p>
      <div className="ben-wb__setup-items">
        {/* 最近的排最上面:他要看的是"刚才那一下",不是十次之前那一下。 */}
        {[...entries].reverse().map(entry => (
          <p className="ben-wb__setup-detail" key={`${entry.ts}-${entry.app}`}>
            {switchLogLine(entry)}
          </p>
        ))}
      </div>
    </section>
  )
}

/** 一条切换记录的人话。不编数:每个数字都是服务端真量的。 */
export function switchLogLine(entry: NonNullable<NonNullable<WorkbenchState['dock']>['recent_switches']>[number]): string {
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
  const parts = [`${time} 切到「${entry.app}」 共 ${entry.total_ms}ms(抬窗 ${entry.raise_ms}ms)`]
  if (!entry.ok) parts.push('没切成')
  if (entry.deferred !== undefined && entry.deferred > 0) parts.push(`${entry.deferred} 家挪到后台藏`)
  if (entry.timed_out !== undefined && entry.timed_out.length > 0) parts.push(`没动成:${entry.timed_out.join('、')}`)
  return parts.join(' · ')
}

/**
 * 一条体检项。**不 ok 的才有按钮** —— 已就绪的那几行只是让 Ben 看得见"这一项确实查过了"。
 *
 * 2026-10-13 起主按钮后面还可能跟 `item.extras` 那几颗(今天只有「完全磁盘访问」那一格用:
 * 打开那一页 → 在访达里显示要拖的那个文件 → 再核一次,三段少一段她就做不完)。
 */
function ItemRow({ item, job, onInstall, onOpenPane, onRecheck, rechecking }: {
  item: SetupItem
  job: SetupJobView | undefined
  onInstall: (step: SetupInstallStep) => Promise<void>
  onOpenPane: (pane: SetupPane) => Promise<void>
  /** 「再核一次」:走的就是页头那颗「重新检查」。 */
  onRecheck: () => Promise<void>
  rechecking: boolean
}) {
  const action = item.action
  const buttonOf = (one: SetupAction, key: string): ReactNode => {
    if (one.kind === 'link') return <a key={key} className="ben-wb__setup-btn" href={one.url} target="_blank" rel="noreferrer">{one.label}</a>
    if (one.kind === 'install' || one.kind === 'web_login') {
      return (
        <button
          key={key}
          type="button"
          className="ben-wb__setup-btn"
          disabled={job?.state === 'running'}
          onClick={() => { void onInstall(one.kind === 'web_login' ? 'web_login' : one.step) }}
        >
          {job?.state === 'running' ? '进行中…' : one.label}
        </button>
      )
    }
    if (one.kind === 'open_pane') {
      return (
        <button key={key} type="button" className="ben-wb__setup-btn" onClick={() => { void onOpenPane(one.pane) }}>
          {one.label}
        </button>
      )
    }
    if (one.kind === 'recheck') {
      return (
        <button key={key} type="button" className="ben-wb__setup-btn" disabled={rechecking} onClick={() => { void onRecheck() }}>
          {rechecking ? '检查中…' : one.label}
        </button>
      )
    }
    return <span key={key} className="ben-wb__setup-hint">{one.label}</span>
  }
  return (
    <div className="ben-wb__setup-item" data-state={item.state} aria-label={item.label}>
      <div className="ben-wb__setup-itemhead">
        <span className={`ben-wb__setup-badge ben-wb__setup-badge--${item.state}`}>{STATE_LABELS[item.state]}</span>
        <span className="ben-wb__setup-itemname">{item.label}</span>
        {item.optional === true && <span className="ben-wb__setup-optional">可选</span>}
        {action !== undefined && buttonOf(action, 'main')}
        {(item.extras ?? []).map((one, index) => buttonOf(one, `extra-${index}`))}
      </div>
      <p className="ben-wb__setup-detail">{item.detail}</p>
      {item.fix !== undefined && <p className="ben-wb__setup-fix">{item.fix}</p>}
      {job !== undefined && <JobBox job={job} />}
    </div>
  )
}

const STATE_LABELS: Record<SetupItem['state'], string> = {
  ok: '已就绪',
  missing: '缺',
  stale: '旧了',
  needs_user: '等你',
}

/** 一条安装作业的进度框。失败时把服务端那句人话和原始输出的尾巴都摆出来。 */
function JobBox({ job }: { job: SetupJobView }) {
  return (
    <div className="ben-wb__setup-job" data-state={job.state} role="status" aria-label={`安装进度 ${job.step}`}>
      <p className="ben-wb__setup-jobnote">
        {job.state === 'running' ? (job.note ?? '在做…') : job.state === 'done' ? (job.note ?? '好了') : (job.error ?? '失败了')}
      </p>
      {job.tail.length > 0 && (
        <pre className="ben-wb__setup-tail" aria-label="原始输出">{job.tail.join('\n')}</pre>
      )}
    </div>
  )
}

/** 第 1 步末尾那颗「重启」:前面几步改的东西大多要重启一次才生效。 */
function RestartRow({ job, onInstall }: { job: SetupJobView | undefined, onInstall: (step: SetupInstallStep) => Promise<void> }) {
  return (
    <div className="ben-wb__setup-item" aria-label="重启 DSH">
      <div className="ben-wb__setup-itemhead">
        <span className="ben-wb__setup-itemname">装完了就重启一次</span>
        <button
          type="button"
          className="ben-wb__setup-btn"
          disabled={job?.state === 'running'}
          onClick={() => { void onInstall('restart') }}
        >
          {job?.state === 'running' ? '重启中…' : '重启 DSH'}
        </button>
      </div>
      <p className="ben-wb__setup-fix">冷机要 20 秒以上才监听得上,页面会自己重连 —— 白屏几秒是正常的。</p>
      {job !== undefined && <JobBox job={job} />}
    </div>
  )
}

/** 第 2 步:仓库在哪。读写走卡 C 的 `/config/paths`;它还没合并时这里如实说。 */
function RepoPanel({ paths, draft, onDraft, onSave }: {
  paths: ConfigPathsView | undefined | 'pending'
  draft: string
  onDraft: (value: string) => void
  onSave: () => Promise<void>
}) {
  if (paths === 'pending') {
    return (
      <p className="ben-wb__setup-hint" role="status">
        路径配置接口(GET/PUT /config/paths)还没合并进来 —— 那是同期另一张卡在做的。
        在它合并之前,仓库路径仍由 dsh-start 里的 WORKBENCH_BUTLER_CWD 说了算(第 1 步的「启动脚本」会按你选的值渲染)。
      </p>
    )
  }
  return (
    <div className="ben-wb__setup-item" aria-label="选仓库目录">
      <div className="ben-wb__setup-itemhead">
        <span className="ben-wb__setup-itemname">仓库目录</span>
        <input
          className="ben-wb__inp"
          aria-label="仓库目录"
          placeholder="/Users/…/desktop-workbench"
          value={draft}
          onChange={event => onDraft(event.target.value)}
        />
        <button type="button" className="ben-wb__setup-btn" onClick={() => { void onSave() }}>保存仓库路径</button>
      </div>
      <p className="ben-wb__setup-fix">
        保存之后要回第 1 步重装一次「启动脚本」,再点「重启 DSH」——
        这个值是写进 dsh-start 的,不重启不生效。
      </p>
    </div>
  )
}

/**
 * 第 4 步的后半截:钩子。
 *
 * 2026-09-17 改(Ben 拍板放开护栏):这里不再只是"把该写的内容摆出来让你自己抄"——
 * 两颗按钮真的会替他写,写之前先弹确认框看一眼,写完能一键撤回。
 * 「看一下」那条老路留着:想先看看要写什么、或者想手工做的人照旧。
 */
function HooksPanel({ hooks, onLoad, onApply }: {
  hooks: ConfigHooksView | undefined | 'pending'
  onLoad: () => Promise<void>
  onApply: (agent: HooksAgent) => void
}) {
  return (
    <div className="ben-wb__setup-item" aria-label="Claude 钩子">
      <div className="ben-wb__setup-itemhead">
        <span className="ben-wb__setup-itemname">让 Claude / Codex 把动静告诉工作台</span>
        <button type="button" className="ben-wb__setup-btn" onClick={() => onApply('claude')}>帮我接上 Claude</button>
        <button type="button" className="ben-wb__setup-btn" onClick={() => onApply('codex')}>帮我接上 Codex</button>
        <button type="button" className="ben-wb__setup-btn" onClick={() => { void onLoad() }}>看一下</button>
      </div>
      <p className="ben-wb__setup-fix">
        工作台只会往这两个文件里加自己的那几条,加之前先把原文件另存一份,随时能撤回。接完要重开一次会话才生效。
      </p>
      {hooks === 'pending' && (
        <p className="ben-wb__setup-hint" role="status">钩子接口(GET /config/hooks)还没合并进来 —— 那是同期另一张卡在做的。在它合并之前,照 README 里那条 cp 命令手工做一次。</p>
      )}
      {hooks !== undefined && hooks !== 'pending' && (
        <>
          {hooks.hint !== undefined && <p className="ben-wb__setup-hint">{hooks.hint}</p>}
          {hooks.settings !== undefined && (
            <pre className="ben-wb__setup-tail" aria-label="钩子配置">{JSON.stringify(hooks.settings, null, 2)}</pre>
          )}
        </>
      )}
    </div>
  )
}

/** 第 6 步:目录与例程。同样是卡 C 的地盘,这里只把现状摆出来 + 指路。 */
function DirsPanel({ paths }: { paths: ConfigPathsView | undefined | 'pending' }) {
  if (paths === 'pending' || paths === undefined) {
    return (
      <p className="ben-wb__setup-hint" role="status">
        扫描根与收件箱目录目前还是写死的(~/Documents/GitHub、~/Documents/Codex、~/WeChatProjects;~/Downloads、~/Desktop)。
        改成可配是同期另一张卡在做的事,合并之后这里就能改。
      </p>
    )
  }
  return (
    <div className="ben-wb__setup-item" aria-label="目录">
      <p className="ben-wb__setup-detail">{`项目扫描根:${paths.effective.scan_roots.map(root => `${root.path}(深 ${root.depth})`).join('、')}${paths.scan_roots === null ? '(默认)' : ''}`}</p>
      <p className="ben-wb__setup-detail">{`收件箱盯的目录:${paths.effective.inbox_dirs.join('、')}${paths.inbox_dirs === null ? '(默认)' : ''}`}</p>
      <p className="ben-wb__setup-fix">例程时刻在设置里改(~/.dsh/workbench/routines.json)。</p>
    </div>
  )
}

/** 第 7 步:事务官三盏灯 —— 引导阶段 / 形象与音色 / 通道层,各配一个去处。 */
function ButlerPanel({ state, baseUrl, fetchImpl }: { state: WorkbenchState, baseUrl: string, fetchImpl: typeof fetch }) {
  const onboarding = state.onboarding
  const butler = state.butler
  const [channel, setChannel] = useState<{ configured: boolean, server: boolean, worker: boolean, note?: string } | undefined>(undefined)
  /**
   * 通话延迟那一行(2026-09-23)。工人每收一回合往 8791 报一条,这里只念最近那一条的摘要。
   * **问不到就是空串**,不在这盏灯上显示一句猜的话 —— 这一页的全部价值就是如实。
   */
  const [latency, setLatency] = useState('')
  useEffect(() => {
    let alive = true
    void fetchImpl(`${baseUrl}/channel/status`)
      .then(async res => (res.ok ? await res.json() as { configured: boolean, server: boolean, worker: boolean, note?: string } : undefined))
      .then((next) => { if (alive) setChannel(next) })
      .catch(() => {})
    void fetchImpl(`${baseUrl}/channel/latency`)
      .then(async res => (res.ok ? (await res.json() as { note?: string }).note ?? '' : ''))
      .then((next) => { if (alive) setLatency(next) })
      .catch(() => {})
    return () => { alive = false }
  }, [baseUrl, fetchImpl])

  return (
    <div className="ben-wb__setup-items">
      <SubLamp
        label="引导阶段"
        ok={onboarding?.done === true}
        detail={onboarding === undefined
          ? '引导没启用(要先在第 2 步选好仓库)。'
          : onboarding.done ? '走完了。' : `停在「${onboarding.stage}」。`}
        actionLabel="去手机上继续"
        hint="引导以手机为主(设计-引导流程 v2);电脑上是文字备胎,配对完成那一刻自动开场。"
      />
      <SubLamp
        label="形象与音色"
        ok={butler?.running === true}
        detail={butler === undefined
          ? '本机后端没接线。'
          : butler.running
            ? `在跑(${butler.port})${butler.avatarCount === undefined ? '' : ` · 形象 ${butler.avatarCount}`}${butler.voiceCount === undefined ? '' : ` · 音色 ${butler.voiceCount}`}`
            : '没在跑。'}
        actionLabel="去配置后台"
        onAction={() => { void fetchImpl(`${baseUrl}/butler/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) }}
        hint="形象靠上传(Live2D 形象包 zip,发布后手机上能选;安装包里不带形象)、音色(火山 TTS)都在后端自己的页面里配,这里不重画一遍。"
      />
      <SubLamp
        label="通道层"
        ok={channel?.configured === true && channel.server}
        detail={channel === undefined
          ? '问不到通道层状态。'
          : !channel.configured
            ? '没配 LiveKit 的 key/secret,手机打不了电话。'
            : `${channel.server ? '服务器在' : '服务器探不到'} · ${channel.worker ? '工人在房里' : '工人不在房里'}${channel.note === undefined ? '' : ` · ${channel.note}`}${latency === '' ? '' : `。${latency}`}`}
        actionLabel="怎么配"
        hint="LiveKit 密钥与火山流式识别写在 ~/.dsh/workbench/channel.json;阿里云那台的装机脚本在仓库 deploy/aliyun-livekit-setup.sh。"
      />
    </div>
  )
}

function SubLamp({ label, ok, detail, actionLabel, onAction, hint }: {
  label: string
  ok: boolean
  detail: string
  actionLabel: string
  onAction?: () => void
  hint: string
}) {
  return (
    <div className="ben-wb__setup-item" data-state={ok ? 'ok' : 'needs_user'} aria-label={label}>
      <div className="ben-wb__setup-itemhead">
        <span className={`ben-wb__setup-badge ben-wb__setup-badge--${ok ? 'ok' : 'needs_user'}`}>{ok ? '已就绪' : '等你'}</span>
        <span className="ben-wb__setup-itemname">{label}</span>
        {onAction !== undefined
          ? <button type="button" className="ben-wb__setup-btn" onClick={onAction}>{actionLabel}</button>
          : <span className="ben-wb__setup-hint">{actionLabel}</span>}
      </div>
      <p className="ben-wb__setup-detail">{detail}</p>
      <p className="ben-wb__setup-fix">{hint}</p>
    </div>
  )
}

/**
 * 「还没装的话,用手机扫这个下载(…)」里括号那一段(2026-09-18)。
 *
 * 云上那份**没有"出于什么时候"**(清单里只有版本号与大小),所以这里按来源分两句写,
 * 而不是给云上那份也硬凑一个 `built_at` —— 拿本机那个 apk 文件的 mtime 冒充"云上这份是什么时候出的",
 * 正是 D13 说的那种"猜一个"。
 */
export function apkLine(apk: SetupApkView): string {
  const mb = `${Math.round((apk.size ?? 0) / 1024 / 1024)} MB`
  if (apk.source === 'cloud') return `还没装的话,用手机扫这个下载(${apk.version ?? '最新版'},${mb})。`
  return `还没装的话,用手机扫这个下载(包出于 ${apk.built_at ?? '未知时间'},${mb})。`
}

/**
 * 第 8 步:手机(双端流程,设计文档 §八)。
 *
 * 顺序是 Ben 定的:**先问"手机端装了吗"**,没装就在屏上给 APK 的下载二维码;
 * 装了才生成配对码。纯电脑用可以整步跳过 —— 这一条要说清楚,不能让人以为不配对就用不了。
 */
function PhonePanel({ state, apk, choice, onChoice, onPair }: {
  state: WorkbenchState
  apk: SetupApkView | undefined
  choice: 'unknown' | 'installed' | 'skipped'
  onChoice: (value: 'unknown' | 'installed' | 'skipped') => void
  onPair: () => Promise<void>
}) {
  const devices = state.devices ?? []
  const pairing = state.pairing
  if (devices.length > 0) {
    return (
      <p className="ben-wb__setup-hint" role="status">
        {`已经配对过 ${devices.length} 台:${devices.map(device => device.name).join('、')}。要再加一台就去设置里那一节。`}
      </p>
    )
  }
  if (choice === 'skipped') {
    return (
      <div className="ben-wb__setup-item" aria-label="跳过手机">
        <p className="ben-wb__setup-detail">先跳过了 —— 纯电脑用没问题:看板、窗位、会话、日结都不依赖手机。</p>
        <button type="button" className="ben-wb__setup-btn" onClick={() => onChoice('unknown')}>我改主意了</button>
      </div>
    )
  }
  if (choice === 'unknown') {
    return (
      <div className="ben-wb__setup-item" aria-label="手机端装了吗">
        <div className="ben-wb__setup-itemhead">
          <span className="ben-wb__setup-itemname">手机端装了吗?</span>
          <button type="button" className="ben-wb__setup-btn" onClick={() => onChoice('installed')}>已装,生成配对码</button>
          <button type="button" className="ben-wb__setup-btn" onClick={() => onChoice('skipped')}>先跳过,纯电脑用</button>
        </div>
        {apk?.available === true
          ? (
              <>
                <p className="ben-wb__setup-detail">{apkLine(apk)}</p>
                {apk.url === undefined
                  ? <p className="ben-wb__setup-fix">要先打开「允许手机在局域网访问」,手机才连得上这台电脑 —— 没有局域网地址就没有二维码。</p>
                  : (
                      <>
                        <PairQr text={apk.url} px={200} />
                        {/* 云上那份出门也扫得通;局域网那份只在同一个 Wi-Fi 下有效(2026-09-18)。 */}
                        <p className="ben-wb__setup-fix">{apk.source === 'cloud' ? '扫码下载(公网)' : '同一 Wi‑Fi 下扫码'}</p>
                        <p className="ben-wb__setup-fix">{`扫不了就在手机浏览器里开:${apk.url}`}</p>
                      </>
                    )}
              </>
            )
          : <p className="ben-wb__setup-fix">{apk?.hint ?? '手机端的包还没出过。'}</p>}
      </div>
    )
  }
  return (
    <div className="ben-wb__setup-item" aria-label="生成配对码">
      <div className="ben-wb__setup-itemhead">
        <span className="ben-wb__setup-itemname">配对</span>
        <button type="button" className="ben-wb__setup-btn" onClick={() => { void onPair() }}>生成配对码</button>
        <button type="button" className="ben-wb__setup-btn" onClick={() => onChoice('unknown')}>返回</button>
      </div>
      {pairing === undefined
        ? <p className="ben-wb__setup-fix">点上面那颗按钮:会顺手打开局域网访问,再生成一个 5 分钟有效的码。</p>
        : (
            <>
              {pairing.qr !== undefined && <PairQr text={pairing.qr} px={200} />}
              <p className="ben-wb__setup-detail">{`用手机上的「事务官」扫;扫不了就手输:${pairing.code}`}</p>
            </>
          )}
      <p className="ben-wb__setup-fix">配对成功那一刻会触发引导开场(两端同一份会话,答过的不重问)。</p>
    </div>
  )
}

/** 第 9 步:只有一句话,但它是 09-04 事故换来的。 */
function WrapUpPanel() {
  return (
    <div className="ben-wb__setup-item" aria-label="Time Machine">
      <p className="ben-wb__setup-detail">把 Time Machine 打开。</p>
      <p className="ben-wb__setup-fix">
        2026-09-04 一条子代理从家目录开始真删了约 100GB:~/.dsh 整个、Claude 的全部会话记录与记忆库、两个仓库的工作区。
        能靠 git 找回来的都找回来了,找不回来的就是没了。这一条不是流程建议,是那次事故留下的唯一硬结论。
      </p>
    </div>
  )
}

/**
 * 设置弹窗里那一节「体检与修复」(2026-09-17)。
 *
 * 09-17 拍板「三个环节分开」之后,这一页**改名并降级**:它不再是第一次开机看到的东西
 * (那是登录屏),`setup_required` 也不再让它自己弹出来 —— 它是**维护用的**:
 * 哪天窗位不灵了、额度不动了,来这儿逐项看一遍、一键修。入口只剩这一行。
 *
 * 旁边那颗「重新走一遍首次流程」擦掉 app.json 的 first_run_done_at,
 * 于是手机/配对/事务官出场那三屏会再来一次(见 FirstRunFlow)。
 *
 * 2026-09-27(卡 OB)多一颗**「重新做一遍引导」**。维护者:「桌面端估计得给我一个初始化的按钮,
 * 不然都已经做完了」—— 他那台 Air 已经走完旧引导,换成新的 5 问之后点上面那颗是不会重问的
 * (它只擦首次流程那面旗子,引导进度还在「已完成」)。这一颗两件事一起做:
 * 擦旗子 + `POST /onboarding/restart {"scope":"all"}`,于是从称呼开始重新问。
 * **数据一样不删**:项目、事项、随手记、记忆文件夹、布局都在(模板按他新答的那一问换)。
 * 点下去先二次确认一句人话 —— 这是唯一一颗会把已经答过的问题重新问一遍的按钮。
 */
export const REDO_ONBOARDING_CONFIRM
  = '会从称呼开始重新问你几句(最多五句)。你的项目、事项、随手记、文件、记忆都不动,确定吗?'

export function SetupReopenRow({ onOpen, onReplayFirstRun, onRedoOnboarding, confirmImpl }: {
  onOpen: () => void
  /** 不给就不画那颗按钮(没接首次流程的场合,比如单独渲染这一行的用例)。 */
  onReplayFirstRun?: () => void
  /** 不给就不画「重新做一遍引导」(同上)。 */
  onRedoOnboarding?: () => void
  /** 二次确认怎么问(默认 window.confirm;用例注入)。 */
  confirmImpl?: (message: string) => boolean
}) {
  const ask = (): void => {
    const confirm = confirmImpl ?? ((message: string) => globalThis.confirm?.(message) === true)
    if (!confirm(REDO_ONBOARDING_CONFIRM)) return
    onRedoOnboarding?.()
  }
  // 评审页 `section('diagnostics', '体检与引导', …)`:三行 ——「体检与修复」描边「开始体检」、「首次使用流程」「重新走一遍」、
  // 「重新设置工作台」「打开」(= 重新做一遍引导,先问一句)。
  return (
    <SetSection id="ben-wb-setup-reopen" title="体检与引导">
      <SetRow title="体检与修复" sub="就绪检查、一键装、系统授权、密钥与配对,都在那一页。">
        <SetBtn kind="outline" onClick={onOpen}>开始体检</SetBtn>
      </SetRow>
      {onReplayFirstRun !== undefined && (
        <SetRow title="首次使用流程" sub="重新查看操作引导。">
          <SetBtn aria-label="重新走一遍首次流程" onClick={onReplayFirstRun}>重新走一遍</SetBtn>
        </SetRow>
      )}
      {onRedoOnboarding !== undefined && (
        <SetRow title="重新设置工作台" sub="从称呼开始重新问几句;项目、事项、随手记、文件都不动。">
          <SetBtn aria-label="打开「重新设置工作台」" onClick={ask}>打开</SetBtn>
        </SetRow>
      )}
    </SetSection>
  )
}
