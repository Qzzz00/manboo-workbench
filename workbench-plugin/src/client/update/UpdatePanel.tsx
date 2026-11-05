/**
 * 设置 → 「更新」那一节(2026-09-18)。Ben:「能加热更新的按钮吗,更新完之后重启。」
 *
 * 一屏里就四件事:**现在是哪一版 → 有没有新版 → 新版说了什么 → 一颗按钮**。
 * 没有版本号对比表,没有 changelog 折叠面板,没有「高级选项」——
 * 目标用户不懂代码,他要的是"点一下,等一会儿,好了"。
 *
 * 两条从登录台原样搬过来的规矩:
 * - **按钮按下去要有话**。这后面是一次真会改这台机器的动作(下载代码、装进 profile、
 *   重启服务),失败必须把服务端那句人话和原始输出的尾巴摆出来,绝不做成"点了没反应"。
 * **2026-09-28(卡 UP)重来一次**。维护者在这一页点了「下载安装包」当成更新,下到的是给
 * 新电脑用的 dmg:「大哥,你搞这几个按钮搞成这样,谁能理解啊?」于是这一页只剩一条路 ——
 * **打开就自己查**(不用先点「检查更新」),**同一时刻屏上最多一颗主按钮**,
 * 安装包那颗按钮整个拿掉,只在最底下留一句"给另一台电脑装:打开官网下载"。
 *
 * - **进度用同一套轮询**(`/update/job/:id`,1 秒一问)。`UpdateJobView` 与登录台的
 *   `SetupJobView` 同形,所以这里那个进度框跟「体检与修复」那一页长得一样,不是巧合。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupJobView } from '../../server/setup/types.ts'
import type { UpdateChannel, UpdateCheckView, UpdateJobView, UpdateRuntimeStaleView } from '../../server/update/types.ts'
import { UPDATE_CHANNEL_TITLES, UPDATE_CHANNELS } from '../../server/update/types.ts'
import { fetchSetupJob } from '../setup/setupApi.ts'
import { SetActions, SetBtn, SetErr, SetLead, SetRow, SetSection, SetSource, SetWarn } from '../settings/setKit.tsx'
import { applyUpdate, checkUpdate, fetchUpdateJob, installRuntime, setUpdateChannel } from './updateApi.ts'
import { applyLabelOf, channelHintOf, downloadLineOf, headlineOf, INSTALLER_HINT, jobHeadlineOf, NEEDS_INSTALLER_HINT, planLineOf, progressOf, RETRY_HINT, runtimeJobHeadlineOf, RUNTIME_AFTER_UPDATE_HINT, runtimeStaleButtonOf, runtimeStaleLineOf, stageOf } from './updateModel.ts'

/** 作业轮询间隔。下载几分钟很正常,一秒一问既不贵也够灵敏(同登录台)。 */
const JOB_POLL_MS = 1000

export function UpdatePanel({ baseUrl, fetchImpl, jobPollMs, currentVersion, runtimeStale }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 轮询间隔,测试传 0 表示不起定时器。 */
  jobPollMs?: number
  /**
   * /state 里那一格带来的当前版本。**自动那一趟查回来之前先把版本号显示出来**
   * —— 不然这一节在结果回来之前是空的,像坏了。
   */
  currentVersion?: string
  /**
   * 「DSH 运行环境还没换到这一版」(2026-09-26,卡 U6)。同样来自 `/state.update`,
   * **不用点「检查更新」就有** —— 它读的是本机的运行时目录,跟联网没关系。
   * 09-26 那台机器的样子正是:「已经是最新的了」,同时这一格亮着。
   */
  runtimeStale?: UpdateRuntimeStaleView
}) {
  const doFetch = fetchImpl ?? fetch
  const pollMs = jobPollMs ?? JOB_POLL_MS
  const [view, setView] = useState<UpdateCheckView | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [job, setJob] = useState<UpdateJobView | undefined>(undefined)
  /** 点「立即更新」这一下本身失败了(还没起作业)。作业跑起来之后的失败在 job.error 里。 */
  const [startError, setStartError] = useState<string | null>(null)
  const [bar, setBar] = useState(0)
  /**
   * 「装运行环境」那一趟(2026-09-26,卡 U6)。**跟更新作业分开存**:它是另一件事
   * (不下载、只装运行环境),形状也不一样(`SetupJobView`)。
   * 自动补跑起来的那一趟不在这里 —— 它在 `/state.update.runtime_stale.repair` 里,由服务端说。
   */
  const [runtimeJob, setRuntimeJob] = useState<SetupJobView | undefined>(undefined)
  /** 正在切通道(切完会按新通道查一次,要几秒)。 */
  const [switching, setSwitching] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const stage = stageOf(view, checking)

  const check = useCallback(async () => {
    setChecking(true)
    setStartError(null)
    try {
      const next = await checkUpdate(baseUrl, doFetch)
      if (mounted.current) setView(next)
    }
    catch (error) {
      // checkUpdate 只在**服务端自己坏了**时抛(没网那种服务端已经翻成 view.error 了)。
      if (mounted.current) setStartError(error instanceof Error ? error.message : '检查更新失败')
    }
    finally {
      if (mounted.current) setChecking(false)
    }
  }, [baseUrl, doFetch])

  /**
   * **打开这一页就自己查一次**(2026-09-28,卡 UP)。
   *
   * 在这之前,人得先点「检查更新」才知道有没有新版 —— 于是那一页上摆着两颗长得一样的按钮,
   * 维护者点错了那颗(「下载安装包」)。查这一下不花他任何东西,就别让他先付一次点击。
   * 只自动查一次(`autoChecked`):这一节可能因为父组件重画而重新跑 effect,
   * 每次重画都去问一趟服务器是没道理的;要再查由他点那句「再查一次」。
   */
  const autoChecked = useRef(false)
  useEffect(() => {
    if (autoChecked.current) return
    autoChecked.current = true
    void check()
  }, [check])

  const start = useCallback(async () => {
    setStartError(null)
    setBar(0)
    try {
      const started = await applyUpdate(baseUrl, doFetch)
      if (mounted.current) setJob(started)
    }
    catch (error) {
      if (mounted.current) setStartError(error instanceof Error ? error.message : '没能开始更新')
    }
  }, [baseUrl, doFetch])

  // 作业轮询。跑完/失败就停;**重启那一段照样继续问** —— 服务马上会被 kickstart 掉,
  // 请求会失败,这时候界面上停在「重启中…」是对的,不该翻成一个红色的错误。
  useEffect(() => {
    if (job === undefined || pollMs <= 0) return
    if (job.state !== 'running') return
    const id = job.id
    let alive = true
    const timer = setInterval(() => {
      void fetchUpdateJob(baseUrl, id, doFetch)
        .then((next) => { if (alive && mounted.current) setJob(next) })
        .catch(() => { /* 重启途中连不上是预期之内的,不翻成错误 */ })
    }, pollMs)
    return () => { alive = false; clearInterval(timer) }
  }, [baseUrl, doFetch, job, pollMs])

  useEffect(() => { if (job !== undefined) setBar(prev => progressOf(job, prev)) }, [job])

  /** 切通道。回来的是按新通道查的那一趟,直接拿它重画;切不过去就原样说服务端那句。 */
  const switchChannel = useCallback(async (channel: UpdateChannel) => {
    setStartError(null)
    setSwitching(true)
    try {
      const next = await setUpdateChannel(baseUrl, channel, doFetch)
      if (mounted.current) setView(next)
    }
    catch (error) {
      if (mounted.current) setStartError(error instanceof Error ? error.message : '没能切更新通道')
    }
    finally {
      if (mounted.current) setSwitching(false)
    }
  }, [baseUrl, doFetch])

  /** 「装运行环境」按下去。回的是 `SetupJobView`,进度走登录台那条路。 */
  const startRuntime = useCallback(async () => {
    setStartError(null)
    try {
      const started = await installRuntime(baseUrl, doFetch)
      if (mounted.current) setRuntimeJob(started)
    }
    catch (error) {
      if (mounted.current) setStartError(error instanceof Error ? error.message : '没能开始装运行环境')
    }
  }, [baseUrl, doFetch])

  // 「装运行环境」那一趟的轮询。**重启那一段照样继续问**(服务马上会被 kickstart 掉,
  // 请求会失败,这时候停在「正在重启」是对的),同更新作业那一处。
  useEffect(() => {
    if (runtimeJob === undefined || pollMs <= 0) return
    if (runtimeJob.state !== 'running') return
    const id = runtimeJob.id
    let alive = true
    const timer = setInterval(() => {
      void fetchSetupJob(baseUrl, id, doFetch)
        .then((next) => { if (alive && mounted.current) setRuntimeJob(next) })
        .catch(() => { /* 重启途中连不上是预期之内的,不翻成错误 */ })
    }, pollMs)
    return () => { alive = false; clearInterval(timer) }
  }, [baseUrl, doFetch, runtimeJob, pollMs])

  const runtimeBusy = runtimeJob !== undefined && runtimeJob.state === 'running'
  const runtimeLine = runtimeStaleLineOf(runtimeStale)

  const applyLabel = applyLabelOf(view, stage)
  const planLine = planLineOf(view, stage)
  const downloadLine = job === undefined ? undefined : downloadLineOf(job)
  const busy = job !== undefined && job.state === 'running'
  const shownVersion = view?.current ?? currentVersion
  /** 那颗「有新版,更新并重启」这会儿在不在屏上。作业一起来它就走了(位置让给进度框)。 */
  const applyOnScreen = applyLabel !== undefined && job === undefined
  const runtimeLabel = runtimeStaleButtonOf(runtimeStale, runtimeBusy, applyOnScreen)

  // 评审页 `updateSettings()`:两节 ——「应用更新」(一句 + 一行版本与动作)与「运行环境」(没有待切换就一行,有就一圈提醒框 + 按钮)。
  // 稿里「应用更新」那一行带一颗「检查更新」;这一页打开就已经查过了(2026-09-28 卡 UP 拍板不要那颗键),照旧不画,只在查不到时给「再查一次」。
  return (
    <>
      <SetSection id="ben-wb-update" title="应用更新" className="ben-wb__upd">
        <SetRow
          title={shownVersion === undefined ? '还不知道这台电脑上装的是哪一版' : `这台电脑上装的是 ${shownVersion}`}
          sub={<span role="status">{headlineOf(view, stage)}</span>}
        >
          {applyOnScreen && applyLabel !== undefined && (
            <SetBtn kind="outline" onClick={() => { void start() }}>{applyLabel}</SetBtn>
          )}
          {stage === 'unreachable' && view?.not_configured !== true && (
            <SetBtn disabled={checking || busy} onClick={() => { void check() }}>再查一次</SetBtn>
          )}
        </SetRow>

        {/* 「收哪条更新」(2026-10-21,内测发版底座)。**两个单选、不是按钮**:这一节「屏上最多一颗主按钮」的规矩照旧
            (套件里的分段 SetSeg 是按钮,用了就破这条)。查回来之后才画 —— 不知道这台收的是哪条时不摆一个猜出来的勾。 */}
        {view?.channel !== undefined && (
          <SetRow title="收哪条更新" sub={channelHintOf(view)}>
            <div className="ben-wb__upd-channel" role="radiogroup" aria-label="收哪条更新">
              {UPDATE_CHANNELS.map(channel => (
                <label key={channel} className="ben-wb__upd-channelopt">
                  <input
                    type="radio"
                    name="ben-wb-update-channel"
                    value={channel}
                    checked={view.channel === channel}
                    disabled={switching || checking || busy}
                    onChange={() => { void switchChannel(channel) }}
                  />
                  {UPDATE_CHANNEL_TITLES[channel]}
                </label>
              ))}
            </div>
          </SetRow>
        )}

        {/* 新版说了什么。发版的人写的那段人话,这里原样显示 —— 不截断、不改写。 */}
        {stage === 'available' && view?.notes !== undefined && (
          <p className="ben-wb__smsg" aria-label="这一版改了什么">{view.notes}</p>
        )}
        {/* 「5 项里 2 项有变化,下载 12MB」:按钮上那个数比上一版小一个数量级,不说清楚人会以为漏下了(2026-09-18)。 */}
        {planLine !== undefined && <p className="ben-wb__smsg" aria-label="这次要下什么">{planLine}</p>}
        {applyOnScreen && applyLabel !== undefined && (
          <p className="ben-wb__smsg">更新完工作台会自己重启一次(几秒),开着的原生窗口不会动。</p>
        )}

        {startError !== null && <SetErr>{startError}</SetErr>}

        {job !== undefined && (
          <div className="ben-wb__setup-job ben-wb__upd-job" data-state={job.state} role="status" aria-label="更新作业">
            <p className="ben-wb__setup-jobnote">{jobHeadlineOf(job)}</p>
            {/* 进度条只在跑着和刚跑完时画:失败时那条停在半路的条没有信息量,该被看见的是底下那句为什么。 */}
            {job.state !== 'failed' && (
              <div
                className="ben-wb__upd-bar"
                role="progressbar"
                aria-label="更新进度"
                aria-valuenow={bar}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <i style={{ width: `${bar}%` }} />
              </div>
            )}
            {job.state !== 'failed' && <p className="ben-wb__upd-phase">{job.phase}</p>}
            {downloadLine !== undefined && <p className="ben-wb__upd-rate">{downloadLine}</p>}
            {job.state !== 'running' && job.unchanged.length > 0 && (
              <ul className="ben-wb__upd-skipped" aria-label="这次没重下的">
                {job.unchanged.map(item => <li key={item}>{item}</li>)}
              </ul>
            )}
            {job.state !== 'running' && job.skipped.length > 0 && (
              <ul className="ben-wb__upd-skipped" aria-label="这次没换的">
                {job.skipped.map(item => <li key={item}>{item}</li>)}
              </ul>
            )}
            {job.state === 'failed' && (
              <SetActions>
                <SetSource>{RETRY_HINT}</SetSource>
                <SetBtn kind="outline" onClick={() => { void start() }}>重试</SetBtn>
              </SetActions>
            )}
            {job.tail.length > 0 && job.state === 'failed' && (
              <pre className="ben-wb__setup-tail" aria-label="原始输出">{job.tail.join('\n')}</pre>
            )}
          </div>
        )}

        {/* 这台太旧、热更新跨不过去:只有话,没有按钮(不给 dmg 直链:直链会过期)。 */}
        {stage === 'needs_installer' && <p className="ben-wb__smsg">{NEEDS_INSTALLER_HINT}</p>}
        {/* 给**另一台**电脑装的时候去哪拿:一句话加一个网址,不是按钮(09-28 维护者点错过)。 */}
        <p className="ben-wb__smsg"><SetSource>{INSTALLER_HINT}</SetSource></p>
      </SetSection>

      <SetSection id="ben-wb-runtime" title="运行环境">
        <SetLead>更新完成后,必要时重启以切换运行环境。</SetLead>
        {/* 「DSH 运行环境还没换到这一版:[装运行环境]」(2026-09-26,卡 U6):这台机器此刻真正缺的那一件。 */}
        {runtimeLine !== undefined
          ? (
              <div data-repair={runtimeStale?.repair?.state ?? 'idle'}>
                <SetWarn>
                  <span role="status">
                    {runtimeLine}
                    {/* 有新版时这一格不给按钮(屏上只留「更新并重启」那一颗),得把两者的关系说出来。 */}
                    {applyOnScreen && <>{' '}{RUNTIME_AFTER_UPDATE_HINT}</>}
                  </span>
                  {runtimeLabel !== undefined && (
                    <SetActions>
                      <SetBtn kind="outline" disabled={busy} onClick={() => { void startRuntime() }}>{runtimeLabel}</SetBtn>
                    </SetActions>
                  )}
                </SetWarn>
              </div>
            )
          : <SetRow title="没有待切换的环境" />}

        {/* 他自己点的那一趟「装运行环境」跑到哪了。自动补那一趟的话在上面那一行里。 */}
        {runtimeJob !== undefined && (
          <div className="ben-wb__setup-job ben-wb__upd-job" data-state={runtimeJob.state} role="status" aria-label="装运行环境">
            <p className="ben-wb__setup-jobnote">{runtimeJobHeadlineOf(runtimeJob)}</p>
            {runtimeJob.state === 'failed' && (
              <SetActions>
                <SetSource>已经装好的那几样不会重装,点一次是从断的那一步接着来。</SetSource>
                <SetBtn kind="outline" onClick={() => { void startRuntime() }}>重试</SetBtn>
              </SetActions>
            )}
            {runtimeJob.state === 'failed' && runtimeJob.tail.length > 0 && (
              <pre className="ben-wb__setup-tail" aria-label="原始输出">{runtimeJob.tail.join('\n')}</pre>
            )}
          </div>
        )}
      </SetSection>
    </>
  )
}
