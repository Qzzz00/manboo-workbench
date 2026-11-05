/**
 * 「图谱」那一格的图谱体(2026-10-23,卡「系统文件夹改成Graphify图谱」)。
 *
 * 这一格嵌的是 graphify 生成的 graph.html:服务端按项目生成一份静态产物
 * (`GET /graphify/view/<projectId>/graph.html`),这里用 iframe 挂上,图谱自己的
 * 交互(点节点、缩放)全在那份页面里,sandbox 要给 `allow-scripts allow-same-origin`
 * —— graph.html 里点了节点会取同目录的 graph.json,同origin才取得到。
 *
 * 三档状态(GET /graphify/status 现取):
 *
 * - `installed=false`   graphify 还没装:说一句实话 + 一颗「装上」键,装是服务端的一次
 *   作业(POST /graphify/install → jobId),这里每秒轮询到 done/error 停;
 * - `installed=true, generatedAt 有值`  生成过:有 graph.html(hasHtml)就 iframe 挂上 +
 *   「上次生成:N 分钟前」;那次超过 5000 节点没出页面(!hasHtml)就如实说,不嵌空页;
 * - `installed=true, generatedAt 空`   还没给这个项目生成过:一句「这个项目还没有图谱」
 *   + 「重建图谱」键(生成走 POST /graphify/build,同样拿 jobId 轮询)。
 *
 * 生成中的「正在生成…」带阶段名(协议里的 stage,翻译在 STAGE_TEXT 这一处),不是干转圈。
 *
 * 只有带本机路径的项目(`WorkbenchProject.path` 非空)才有图谱——没 path 不知道
 * 对着哪个目录生成。一个带 path 的项目都没有时如实说一句,不摆一颗点了必错的键(D13)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArchifyStatusView, GraphifyJobView, GraphifyStatusView, WorkbenchProject } from '../protocol.ts'

/** 轮询作业的间隔:装/生成都是秒级的活儿,1 秒一拍足够跟手。 */
const JOB_POLL_MS = 1000

/** 架构图「已较旧」的门槛:生成时间超过 7 天标注一句,不静默当新图(我定的阈值,可撤回)。 */
const ARCHIFY_STALE_MS = 7 * 24 * 3600 * 1000

/** Unix 毫秒 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」。认不出的值回 undefined,不编(D13)。 */
/** 流水线阶段 → 格子上的那一句人话(阶段名是协议里的英文键,翻译在这一处)。 */
const STAGE_TEXT: Readonly<Record<string, string>> = {
  vendor: '正在备页面组件…',
  warm: '正在装…',
  detect: '正在扫文件…',
  extract: '正在抽节点…',
  build: '正在连边…',
  cluster: '正在聚类…',
  score: '正在算社区得分…',
  gods: '正在找关键节点…',
  surprises: '正在找意外连接…',
  questions: '正在想建议问题…',
  report: '正在写报告…',
  json: '正在写图数据…',
  export: '正在出页面…',
}

export function graphAgeText(generatedAt: number, nowMs: number): string | undefined {
  const ageMs = nowMs - generatedAt
  if (!Number.isFinite(ageMs) || ageMs < 0) return undefined
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 图体容器:够高挂真 iframe,太矮给一颗收拢条(2026-10-26 视觉验收退回的机制修复)。
 * 二十几 px 的图区谁也读不清 —— 与其塞一根细线冒充「图已展示」,不如一句实话 +
 * 一颗点了就开全屏的键。ResizeObserver 跟着格子拖高拖低实时换档,拖回够高图就回来。
 */
const FRAME_MIN_PX = 90

function FrameOrBar({ src, title, barText, onExpand }: {
  src: string
  title: string
  barText: string
  onExpand: () => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [tallEnough, setTallEnough] = useState(true)
  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    // 量不了高度就不收拢(测试环境/老内核):只在真能跟手的环境里才换档。
    if (typeof ResizeObserver === 'undefined') return
    const update = (): void => { setTallEnough(el.clientHeight >= FRAME_MIN_PX) }
    const observer = new ResizeObserver(update)
    observer.observe(el)
    update()
    return () => { observer.disconnect() }
  }, [])
  return (
    <div className="ben-wb__graph-frame-wrap" ref={wrapRef}>
      {tallEnough
        ? (
          <iframe
            className="ben-wb__graph-frame"
            title={title}
            sandbox="allow-scripts allow-same-origin"
            src={src}
          />
        )
        : (
          <button type="button" className="ben-wb__graph-collapsed" onClick={onExpand}>
            {barText}
          </button>
        )}
    </div>
  )
}

export function GraphView({ baseUrl, fetchImpl, projects, currentProjectId }: {
  baseUrl: string
  fetchImpl: typeof fetch
  projects: readonly WorkbenchProject[]
  /** 项目区此刻展开的那一个(带 path 时优先当本格的当前项目)。 */
  currentProjectId?: string | null
}) {
  /** 只有带 path 的项目才有图谱。 */
  const pathProjects = useMemo(
    () => projects.filter((project): project is WorkbenchProject & { path: string } => project.path !== undefined && project.path !== ''),
    [projects],
  )
  /**
   * 本地显式选择。**用户在下拉里挑过,就以他挑的为准** —— 否则项目区恰好展开着某个
   * 项目时,下拉选第二个会被 currentProjectId 当场盖回去(2026-10-23 验收指出的假可选)。
   * 项目区换展开(他明摆着换了「当前项目」)才把显式选择清掉,格子跟着走。
   */
  const [pickedId, setPickedId] = useState<string | null>(null)
  useEffect(() => { setPickedId(null) }, [currentProjectId])
  const current = useMemo(() => {
    if (pickedId !== null) {
      const picked = pathProjects.find(project => project.id === pickedId)
      if (picked !== undefined) return picked
    }
    const byExpanded = currentProjectId === undefined || currentProjectId === null
      ? undefined
      : pathProjects.find(project => project.id === currentProjectId)
    if (byExpanded !== undefined) return byExpanded
    return pathProjects[0]
  }, [pathProjects, currentProjectId, pickedId])
  /** 本格的生命周期按键是稳定的 project.id(current 对象随每拍快照换新,不能当依赖)。 */
  const currentId = current?.id

  const [status, setStatus] = useState<GraphifyStatusView | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  /** 图谱视图模式: Graphify 关系图 vs Archify 架构图 (2026-10-23, 卡「图谱显示修复与Archify产品图接入」) */
  const [mode, setMode] = useState<'graphify' | 'archify'>('graphify')
  const [archifyStatus, setArchifyStatus] = useState<ArchifyStatusView | undefined>(undefined)
  const [archifyError, setArchifyError] = useState<string | undefined>(undefined)
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | undefined>(undefined)
  const [generatingArchify, setGeneratingArchify] = useState(false)
  /** 展开全屏查看的弹层 */
  const [expandedModal, setExpandedModal] = useState(false)
  /** 正在跑的作业(install 或 build):有它的时候轮询,界面上也照实说「正在…」。 */
  const [job, setJob] = useState<GraphifyJobView | undefined>(undefined)
  /** 装/建失败、或 build 被 4xx 拒的那一句原文(role=status 贴出来,不自己编)。 */
  const [jobError, setJobError] = useState<string | undefined>(undefined)
  /**
   * 键按下去到服务端把 jobId 拿回来之间那几拍:这段时间作业还没建,光靠 job 状态防不住
   * 连点 —— 先本地置忙,jobId 回来之后交给 job 状态接管(2026-10-23 验收:前端立即 busy)。
   */
  const [submitting, setSubmitting] = useState(false)
  const jobTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const statusTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  /** 全屏弹层的根与关闭键(焦点收进弹层用) */
  const modalRootRef = useRef<HTMLDivElement | null>(null)
  const modalCloseRef = useRef<HTMLButtonElement | null>(null)
  /** 异步回包的边界(2026-10-23 第五轮):只回写「此刻这一格所属项目 + 同一代」。
   * 换项目、同项目重建、卸载都算越过边界 —— 在途的旧 status/job/build 响应一律丢弃,
   * 不许污染新项目(真实 Chrome 交错响应复现的两条:旧 status 清掉 B 的图、旧 job 让 B 假忙)。 */
  const activeIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)

  const clearTimers = useCallback(() => {
    if (jobTimer.current !== undefined) clearInterval(jobTimer.current)
    if (statusTimer.current !== undefined) clearInterval(statusTimer.current)
    jobTimer.current = undefined
    statusTimer.current = undefined
  }, [])

  /** 回包是否还能写:项目没换、代次没动、组件没卸载。 */
  const isFresh = useCallback((projectId: string, generation: number): boolean => {
    return mountedRef.current && activeIdRef.current === projectId && generationRef.current === generation
  }, [])

  const loadStatus = useCallback(async (projectId: string, generation = generationRef.current): Promise<void> => {
    try {
      const res = await fetchImpl(`${baseUrl}/graphify/status?project=${encodeURIComponent(projectId)}`)
      const view = await res.json() as GraphifyStatusView
      if (!isFresh(projectId, generation)) return
      setStatus(view)
      setStatusError(undefined)
    }
    catch (error) {
      if (!isFresh(projectId, generation)) return
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }, [baseUrl, fetchImpl, isFresh])

  const loadArchifyStatus = useCallback(async (projectId: string, generation = generationRef.current): Promise<void> => {
    try {
      const res = await fetchImpl(`${baseUrl}/archify/status?project=${encodeURIComponent(projectId)}`)
      const view = await res.json() as ArchifyStatusView
      if (!isFresh(projectId, generation)) return
      setArchifyStatus(view)
      setArchifyError(undefined)
      if (view.selectedDiagramId) {
        setSelectedDiagramId(view.selectedDiagramId)
      } else if (view.diagrams && view.diagrams.length > 0 && view.diagrams[0]?.id) {
        setSelectedDiagramId(view.diagrams[0].id)
      } else {
        setSelectedDiagramId(undefined)
      }
    } catch (error) {
      if (!isFresh(projectId, generation)) return
      setArchifyError(error instanceof Error ? error.message : String(error))
    }
  }, [baseUrl, fetchImpl, isFresh])

  /** 轮询一个 jobId 到 done/error;done 后重拉 status(新的 generatedAt 会刷新 iframe)。
   * 作业是服务端内存态,工作台一重启 jobId 就 404 —— 404 是「这轮作业没了」的判据:
   * 停轮询、重拉 status、给一句可以再点的错,不许空转到永远(2026-10-23 第三轮验收)。 */
  const watchJob = useCallback((jobId: string, projectId: string, generation: number): void => {
    if (!isFresh(projectId, generation)) return
    clearTimers()
    setJob({ id: jobId, status: 'running', startedAt: Date.now() })
    setJobError(undefined)
    let timer: ReturnType<typeof setInterval> | undefined = undefined
    let reqSeq = 0
    let acceptedSeq = 0
    let terminal = false

    timer = setInterval(() => {
      void (async () => {
        const mySeq = ++reqSeq
        // 每拍先验界:项目换了 / 同项目重建了 / 卸载了 / 终态已达 → 停本拍,不许清后一代的 timer。
        if (!isFresh(projectId, generation) || terminal) {
          if (timer !== undefined) clearInterval(timer)
          if (jobTimer.current === timer) jobTimer.current = undefined
          return
        }
        try {
          const res = await fetchImpl(`${baseUrl}/graphify/job?id=${encodeURIComponent(jobId)}`)
          if (!res.ok) {
            terminal = true
            if (timer !== undefined) clearInterval(timer)
            if (jobTimer.current === timer) jobTimer.current = undefined
            if (!isFresh(projectId, generation) || mySeq < acceptedSeq) return
            acceptedSeq = mySeq
            setJob(undefined)
            setJobError('这次作业找不到了(工作台可能重启过),再点一次就好')
            await loadStatus(projectId, generation)
            return
          }
          const view = await res.json() as GraphifyJobView
          if (!isFresh(projectId, generation) || terminal || mySeq < acceptedSeq) {
            if (timer !== undefined && terminal) clearInterval(timer)
            if (jobTimer.current === timer && terminal) jobTimer.current = undefined
            return
          }
          acceptedSeq = mySeq
          setJob(view)
          if (view.status === 'done' || view.status === 'error') {
            terminal = true
            if (timer !== undefined) clearInterval(timer)
            if (jobTimer.current === timer) jobTimer.current = undefined
            if (view.status === 'error') setJobError(view.error ?? '出错了')
            else await loadStatus(projectId, generation)
          }
        }
        catch {
          // 一拍没取到不算完(网络抖一下),下一拍接着问;真没了由上面那条 404 路收。
        }
      })()
    }, JOB_POLL_MS)
    jobTimer.current = timer
  }, [baseUrl, fetchImpl, clearTimers, loadStatus, isFresh])

  /** status 说此刻有 build 在跑(可能是别的页面起的):每秒重拉 status 到它停下。 */
  const watchRunning = useCallback((projectId: string, generation: number): void => {
    if (statusTimer.current !== undefined) clearInterval(statusTimer.current)
    let timer: ReturnType<typeof setInterval> | undefined = undefined
    timer = setInterval(() => {
      if (!isFresh(projectId, generation)) {
        if (timer !== undefined) clearInterval(timer)
        if (statusTimer.current === timer) statusTimer.current = undefined
        return
      }
      void loadStatus(projectId, generation)
    }, JOB_POLL_MS)
    statusTimer.current = timer
  }, [loadStatus, isFresh])

  // 挂载与**换项目(id 变了)** 才重来:重拉 status、清掉上一格的作业/错误、代次 +1。
  // 依赖是稳定的 currentId 不是 current 对象 —— projects 每秒一拍是新数组,以对象为依赖
  // 会把正在跑的作业/错误每秒清掉(2026-10-23 第三轮验收);同 id 的新对象不触发。
  useEffect(() => {
    mountedRef.current = true
    generationRef.current += 1
    const gen = generationRef.current
    activeIdRef.current = currentId ?? null
    clearTimers()
    setStatus(undefined)
    setStatusError(undefined)
    setJob(undefined)
    setJobError(undefined)
    setSubmitting(false)
    setGeneratingArchify(false)
    setArchifyError(undefined)
    if (currentId !== undefined) {
      if (mode === 'graphify') {
        void loadStatus(currentId, gen)
      } else {
        void loadArchifyStatus(currentId, gen)
      }
    }
    return () => { clearTimers(); mountedRef.current = false }
  }, [currentId, mode, loadStatus, loadArchifyStatus, clearTimers])

  // status 回来的那一刻说 running:跟上它;running 一翻 false 就**主动停** running 轮询
  // (2026-10-23 第五轮:不能新造永远轮询)。
  useEffect(() => {
    if (currentId === undefined || status?.running !== true || jobTimer.current !== undefined) {
      if (statusTimer.current !== undefined) {
        clearInterval(statusTimer.current)
        statusTimer.current = undefined
      }
      return
    }
    watchRunning(currentId, generationRef.current)
  }, [status?.running, currentId, job, watchRunning])

  useEffect(() => {
    if (!expandedModal) return
    // 焦点收进弹层:打开即落在「退出全屏」上,Tab 在弹层内循环,不泄漏到背景页面
    modalCloseRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedModal(false)
      if (event.key === 'Tab') {
        const root = modalRootRef.current
        if (root === null) return
        const focusables = root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    // Esc 搭桥(2026-10-26 实证):在图里点过(焦点进了 iframe)之后,顶层 window 的
    // keydown 收不到 Esc —— 弹层关不掉,盖住整格。弹层里的图都是同 origin
    // (sandbox 带 allow-same-origin),把 Esc 接进来关弹层。
    // 两个讲究:① 用**捕获**挂在图窗上 —— 图页自己在 document 冒泡里处理按键,
    // 有的会 stopPropagation,冒泡监听到不了 window,捕获不受它影响;
    // ② 关弹层延后到这轮按键派发完之后(setTimeout 0)—— 图页拿 Esc 关自己的
    // 面板/清节点聚焦照常用,但别把正在接收事件的图页中途整个卸载掉。实测钉点
    // 原图对 Esc 普遍 preventDefault(如清节点聚焦那一支,doudou-arch.html L14667
    // 起),所以**不看** defaultPrevented,Esc 就是退出全屏。非同源够不着的,
    // 「退出全屏」键兜底。
    const closeFromFrame = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setTimeout(() => setExpandedModal(false), 0)
    }
    const bridged: Window[] = []
    const bridge = (): void => {
      modalRootRef.current?.querySelectorAll('iframe').forEach((frame) => {
        try {
          const inner = frame.contentWindow
          if (inner !== null && !bridged.includes(inner)) {
            inner.addEventListener('keydown', closeFromFrame, true)
            bridged.push(inner)
          }
        }
        catch { /* 非同源:够不着就算了,Esc 由图页自己解释 */ }
      })
    }
    bridge()
    modalRootRef.current?.querySelectorAll('iframe').forEach((frame) => frame.addEventListener('load', bridge))
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const inner of bridged) inner.removeEventListener('keydown', closeFromFrame, true)
      modalRootRef.current?.querySelectorAll('iframe').forEach((frame) => frame.removeEventListener('load', bridge))
    }
  }, [expandedModal])

  const busy = submitting || job?.status === 'running' || status?.running === true
  const startInstall = (): void => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    setSubmitting(true)
    clearTimers()
    setJob(undefined)
    setJobError(undefined)
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/graphify/install`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          if (!isFresh(current?.id ?? '', generation)) return
          setJobError(body.error ?? `装不上(${res.status})`)
          return
        }
        const { jobId } = await res.json() as { jobId: string }
        if (!isFresh(current?.id ?? '', generation)) return
        watchJob(jobId, current?.id ?? '', generation)
      }
      catch (error) {
        if (!isFresh(current?.id ?? '', generation)) return
        setJobError(error instanceof Error ? error.message : String(error))
      }
      finally {
        if (isFresh(current?.id ?? '', generation)) setSubmitting(false)
      }
    })()
  }
  const startBuild = (): void => {
    if (current === undefined) return
    const projectId = current.id
    // 同项目重建:代次 +1,旧作业/旧 status 的在途回包都不许覆盖新结果。
    const generation = generationRef.current + 1
    generationRef.current = generation
    setSubmitting(true)
    clearTimers()
    setJob(undefined)
    setJobError(undefined)
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/graphify/build`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }),
        })
        if (!res.ok) {
          // 4xx:服务端把原因写在 error 里,原样贴出来(D13)。
          const body = await res.json().catch(() => ({})) as { error?: string }
          if (!isFresh(projectId, generation)) return
          setJobError(body.error ?? `生成不了(${res.status})`)
          return
        }
        const { jobId } = await res.json() as { jobId: string }
        if (!isFresh(projectId, generation)) return
        watchJob(jobId, projectId, generation)
      }
      catch (error) {
        if (!isFresh(projectId, generation)) return
        setJobError(error instanceof Error ? error.message : String(error))
      }
      finally {
        if (isFresh(projectId, generation)) setSubmitting(false)
      }
    })()
  }

  const activeDiagram = useMemo(() => {
    if (!archifyStatus?.diagrams || archifyStatus.diagrams.length === 0) return undefined
    if (selectedDiagramId) {
      const found = archifyStatus.diagrams.find(d => d.id === selectedDiagramId)
      if (found) return found
    }
    return archifyStatus.diagrams[0]
  }, [archifyStatus, selectedDiagramId])

  /**
   * 「由 Agent 生成」(2026-10-23 集中收口):前端不再带任何硬编码规格模板 —— 那两个
   * 通用方框曾被独立审判为「用户看得见的假能力」。这里只发 projectId,服务端派已授权
   * Agent 只读项目源码、现场产出结构化规格,官方离线工具链校验后原子落地;失败保留
   * 上一次可用版,错误原文贴出来。
   */
  const triggerGenerateArchify = useCallback(async () => {
    if (!currentId) return
    setGeneratingArchify(true)
    setArchifyError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}/archify/generate-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: currentId }),
      })
      const data = await res.json().catch(() => ({})) as { diagramId?: string, error?: string }
      if (!res.ok || data.diagramId === undefined) {
        if (!isFresh(currentId, generationRef.current)) return
        setArchifyError(data.error ?? '生成架构图失败')
        return
      }
      const newDiagramId = data.diagramId
      if (!isFresh(currentId, generationRef.current)) return
      await loadArchifyStatus(currentId, generationRef.current)
      if (isFresh(currentId, generationRef.current)) setSelectedDiagramId(newDiagramId)
    } catch (err) {
      if (!isFresh(currentId, generationRef.current)) return
      setArchifyError(err instanceof Error ? err.message : String(err))
    } finally {
      // 本地忙标记,换代也照清:不给新项目留下一把锁死的按钮
      setGeneratingArchify(false)
    }
  }, [baseUrl, currentId, fetchImpl, loadArchifyStatus, isFresh])

  // Hook 全部在上(React 铁律:early return 之后不许再出现 Hook)——
  // 项目区从空到加载出来(0 → 有 path 项目)会让两次渲染的 Hook 数不同,
  // 直接抛「Rendered more hooks than during the previous render」(2026-10-24 整包红真修)。
  if (pathProjects.length === 0) {
    return <p className="ben-wb__graph-note" role="status">项目区里还没有带本机路径的项目</p>
  }

  return (
    <div className="ben-wb__graph">
      <div className="ben-wb__graph-tabs" role="tablist" aria-label="图谱类型">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'graphify'}
          className={`ben-wb__graph-tab${mode === 'graphify' ? ' is-active' : ''}`}
          onClick={() => setMode('graphify')}
        >
          关系图 (Graphify)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'archify'}
          className={`ben-wb__graph-tab${mode === 'archify' ? ' is-active' : ''}`}
          onClick={() => setMode('archify')}
        >
          架构图 (Archify)
        </button>
      </div>

      {mode === 'graphify' && (
        <>
          <div className="ben-wb__graph-head">
            {pathProjects.length > 1
              ? (
                <select
                  className="ben-wb__graph-select"
                  aria-label="图谱项目"
                  value={current?.id ?? ''}
                  onChange={event => setPickedId(event.target.value)}
                >
                  {pathProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              )
              : <span className="ben-wb__graph-name">{current?.name}</span>}
            {status?.installed === true && status.generatedAt !== null && status.hasHtml && (
              <button
                type="button"
                className="ben-wb__graph-expand"
                aria-label="展开查看图谱"
                title="展开全屏查看"
                onClick={() => setExpandedModal(true)}
              >
                展开
              </button>
            )}
            <button
              type="button"
              className="ben-wb__graph-rebuild"
              aria-label="重建图谱"
              disabled={busy || status?.installed !== true}
              onClick={startBuild}
            >
              {busy ? (STAGE_TEXT[job?.stage ?? ''] ?? '正在生成…') : '重建图谱'}
            </button>
          </div>

          {statusError !== undefined && <p className="ben-wb__graph-error" role="status">{statusError}</p>}
          {jobError !== undefined && <p className="ben-wb__graph-error" role="status">{jobError}</p>}

          {status !== undefined && !status.installed && (
            <div className="ben-wb__graph-empty">
              <p className="ben-wb__graph-note">生成图谱要先装 graphify</p>
              <button type="button" className="ben-wb__graph-install" onClick={startInstall} disabled={busy}>
                {job?.status === 'running' ? '正在安装…' : '装上'}
              </button>
            </div>
          )}

          {status?.installed === true && status.generatedAt !== null && status.hasHtml && (
            <>
              {/* t=generatedAt 绕缓存:重建之后同名文件内容变了,不带它 iframe 会拿旧缓存。 */}
              <FrameOrBar
                src={`${baseUrl}/graphify/view/${encodeURIComponent(current?.id ?? '')}/graph.html?t=${status.generatedAt}`}
                title="项目图谱"
                barText="项目图谱 · 这个高度读不清图,点这里展开全屏"
                onExpand={() => setExpandedModal(true)}
              />
              <p className="ben-wb__graph-note">
                上次生成:
                {graphAgeText(status.generatedAt, Date.now()) ?? '不知道'}
              </p>
            </>
          )}

          {status?.installed === true && status.generatedAt !== null && !status.hasHtml && (
            <p className="ben-wb__graph-note" role="status">
              这份图谱页没有生成出来;图数据和报告已在,重建图谱后会再出一次。
            </p>
          )}

          {status?.installed === true && status.generatedAt === null && !busy && (
            <div className="ben-wb__graph-empty">
              <p className="ben-wb__graph-note">这个项目还没有图谱</p>
            </div>
          )}
        </>
      )}

      {mode === 'archify' && (
        <>
          <div className="ben-wb__graph-head">
            {pathProjects.length > 1
              ? (
                <select
                  className="ben-wb__graph-select"
                  aria-label="图谱项目"
                  value={current?.id ?? ''}
                  onChange={event => setPickedId(event.target.value)}
                >
                  {pathProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              )
              : <span className="ben-wb__graph-name">{current?.name}</span>}

            {archifyStatus?.hasDiagrams && archifyStatus.diagrams.length > 0 && (
              <select
                className="ben-wb__graph-select"
                aria-label="架构图选择"
                value={selectedDiagramId ?? activeDiagram?.id ?? ''}
                onChange={e => setSelectedDiagramId(e.target.value)}
              >
                {archifyStatus.diagrams.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}

            {archifyStatus?.pinnedCommit && (
              <span className="ben-wb__graph-badge" title={archifyStatus.sourceNote}>
                {archifyStatus.pinnedCommit}
              </span>
            )}

            {archifyStatus?.hasDiagrams && (
              <button
                type="button"
                className="ben-wb__graph-expand"
                aria-label="展开查看图谱"
                title="展开全屏查看"
                onClick={() => setExpandedModal(true)}
              >
                展开
              </button>
            )}
          </div>

          {archifyError !== undefined && <p className="ben-wb__graph-error" role="status">{archifyError}</p>}

          {archifyStatus?.hasDiagrams && activeDiagram && (
            <>
              {/* 2026-10-26:不许加 ?embed=1 —— 原图 embed 模式会隐藏缩放导航、节点详情等全部
                  交互控件(排查-1026 真浏览器实证,维护者验收「Archify 无缩放与节点详情」的根因)。
                  全景地图 build.py 嵌同一批图也不用 embed;原样嵌原始页,缩放/详情/复位都在。 */}
              <FrameOrBar
                src={`${baseUrl}/archify/view/${encodeURIComponent(current?.id ?? '')}/${encodeURIComponent(activeDiagram.id)}.html`}
                title={`架构图 · ${activeDiagram.name}`}
                barText="架构图 · 这个高度读不清图,点这里展开全屏"
                onExpand={() => setExpandedModal(true)}
              />
              <p className="ben-wb__graph-note">
                {archifyStatus.sourceNote ?? 'Archify 3.2.0 离线交付'}
                {/* 生成时间与来源钉点分开如实呈现;超过 7 天标注已较旧 */}
                {activeDiagram.generatedAt !== undefined && (() => {
                  const age = graphAgeText(activeDiagram.generatedAt, Date.now())
                  if (age === undefined) return null
                  const stale = Date.now() - activeDiagram.generatedAt > ARCHIFY_STALE_MS
                  return ` · 生成于: ${age}${stale ? '(已较旧,源码可能已有变化)' : ''}`
                })()}
              </p>
            </>
          )}

          {archifyStatus !== undefined && !archifyStatus.hasDiagrams && (
            <div className="ben-wb__graph-empty">
              <p className="ben-wb__graph-note">这个项目还没有架构图</p>
              <button
                type="button"
                className="ben-wb__graph-install"
                disabled={generatingArchify}
                onClick={triggerGenerateArchify}
              >
                {generatingArchify ? '正在生成…' : '由 Agent 生成'}
              </button>
            </div>
          )}
        </>
      )}

      {expandedModal && (
        <div
          className="ben-wb__graph-modal"
          role="dialog"
          aria-modal="true"
          ref={modalRootRef}
          aria-label={mode === 'archify' ? `全屏架构图 · ${current?.name}` : '全屏项目图谱'}
          onClick={() => setExpandedModal(false)}
        >
          <div className="ben-wb__graph-modal-content" onClick={event => event.stopPropagation()}>
            <div className="ben-wb__graph-modal-head">
              <h3 className="ben-wb__graph-modal-title">
                {mode === 'archify'
                  ? `架构图 · ${current?.name} · ${activeDiagram?.name ?? ''}`
                  : `项目图谱 · ${current?.name}`}
              </h3>
              <button
                type="button"
                className="ben-wb__graph-modal-close"
                aria-label="退出全屏"
                ref={modalCloseRef}
                onClick={() => setExpandedModal(false)}
              >
                退出全屏
              </button>
            </div>
            <div className="ben-wb__graph-modal-body">
              <iframe
                title={mode === 'archify' ? `全屏架构图 · ${activeDiagram?.name}` : '全屏项目图谱'}
                sandbox="allow-scripts allow-same-origin"
                src={mode === 'archify'
                  ? `${baseUrl}/archify/view/${encodeURIComponent(current?.id ?? '')}/${encodeURIComponent(activeDiagram?.id ?? '')}.html`
                  : `${baseUrl}/graphify/view/${encodeURIComponent(current?.id ?? '')}/graph.html?t=${status?.generatedAt}`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
