/**
 * 「选题池」那一格(2026-09-21;运营同事需求白板第二节,原话逐字):
 *
 * > 选题池里的每个选题都有自己的创作进度:每完成一步可推进一下直到最终发布;
 * > 类似 multica 新建任务流程、任务完成流转、选项卡设计样式;右上方 +新建选题,
 * > 内容类型可选图文/视频、优先级;进度:灵感-初稿-准备素材-制作中-发布-复盘;
 * > 每个选题关联对应素材,点选题可查对应 part 素材。
 *
 * 这一格上一版是「待办事项」——八环节分列的小看板。改的是**列按什么分**与**卡上是什么**,
 * 模块 id 仍然是 `todo`(布局里那一格、模板备份里存着的排布都按 id 认人,换 id 等于把
 * 已经存在的布局作废)。标题由模板给:运营模板下是「选题池」,别的模板下还是「待办事项」。
 *
 * ## 六列 + 一列,横向滚动
 *
 * 六列是进度六段(`TOPIC_STAGES`)。末尾还有**一列「其它事项」**,装的是这一格里
 * 所有不是选题的在办事项。它存在的理由只有一个:**一张卡都不许因为"它不是选题"
 * 就从界面上消失** —— 运营模板上一版建出来的那些八环节事项还在盘上,改完这一格
 * 它们必须还看得见。那一列里每张卡照旧带着它的八环节(`laneOfModuleId`)。
 *
 * ## 八环节去哪了
 *
 * 留着,当**流程说明**:卡片展开时写一行「当前环节」,由六段按 `TOPIC_STAGE_FLOW` 现算
 * (protocol.ts 里那张映射表),这一格底下再写一行完整的八环节。**不落盘**:选题身上
 * 存的是 `stage`,环节是现算的一句话,存一份副本就等于同一件事有两个地方可以说。
 *
 * ## 关联素材
 *
 * 卡上那个数与展开后那份清单来自 `POST /topic/assets`(server/topicAssets.ts 顶上写了
 * 目录约定与"关联"的两条认定规则)。**一次问一批**,不是每张卡各发一个请求;
 * 问不到就整块不显示,不画一个 0 —— "读不到"和"零个"是两件事(D13)。
 *
 * 写操作走 `postSilently`:失败静默、不做本地乐观更新,真相以下一拍 `GET /state` 为准
 * (全仓通行纪律)。**推进一步与改日期这两颗除外** —— 见下面 `checkedPost` 那一段。
 *
 * ★ 2026-10-03:这一格的**外层**已经不是它了。运营同学(Air)自己写的那一份
 * (`src/client/air/topics.js`,原件 `contrib/air-20261002/src/topics.js`)把它包成
 * 「选题详情」浮层里的那一块(`embedded` + `initialOpen`),外面那一层是她的
 * 「创作选题 / 其它事项」两个页签 + 阶段筛 + 搜索 + 安排发布日 / 确认已发布两张浮层。
 * 她原件里那一份 `LegacyTodoModule` 就是这一格 —— 她在它身上改的四处
 * (`initialOpen` / `embedded` / `actionNote` + `checkedPost` / 嵌入时不套 ModuleBox)
 * 原样落在这里;2026-10-02 那张卡在这个文件里重做的搜索框与段筛按维护者 10-03 的拍板撤掉了。
 */
import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskPriority, TaskView, TopicContentType, TopicStage } from '../protocol.ts'
import { DEFAULT_TOPIC_STAGE, TOPIC_CONTENT_TYPES, TOPIC_STAGES, topicPhaseOf } from '../protocol.ts'
import { ModuleBox, type ModuleBoxProps } from './ModuleBox.tsx'
import { TopicDeck } from './TopicDeck.tsx'
import { laneOfModuleId } from '../templates.ts'
import { postSilently } from './postSilently.ts'

/** 没认出环节的那一列。名字与 boardModel 的 UNASSIGNED_LANE 同一个口径,不另起一套说法。 */
export const TODO_UNASSIGNED_LANE = '未分环节'

/** 不是选题的那些在办事项摆在哪一列。**它们不是选题,所以不假装是**,单独一列。 */
export const TOPIC_OTHERS_LANE = '其它事项'

/** 优先级在这一格里怎么写。与看板同一套词(高 / 中 / 低),不另造一套。 */
export const PRIORITY_WORDS: Readonly<Record<TaskPriority, string>> = { high: '高', mid: '中', low: '低' }

/** 选题池只显示还没做完的:做完与取消的留在看板上,不占这块地方(同上一版)。 */
export function isOpen(task: TaskView): boolean {
  return task.status !== 'done' && task.status !== 'canceled'
}

export function isTopic(task: TaskView): boolean {
  return task.kind === 'topic'
}

/** 一条选题此刻在哪一段。没写过的按「灵感」摆,**但盘上不写**(见 protocol.ts TaskView.stage)。 */
export function stageOf(task: TaskView): TopicStage {
  return task.stage ?? DEFAULT_TOPIC_STAGE
}

/**
 * 选题按六段分组。返回的顺序**就是 TOPIC_STAGES 的顺序**,末尾永远跟一条「其它事项」,
 * 装的是在办的非选题事项 —— 一张卡都不丢。
 */
export function groupTopicsByStage(
  tasks: readonly TaskView[],
  stages: readonly TopicStage[] = TOPIC_STAGES,
): { stage: string, tasks: TaskView[] }[] {
  const known = new Set<string>(stages)
  const buckets = new Map<string, TaskView[]>()
  for (const stage of stages) buckets.set(stage, [])
  buckets.set(TOPIC_OTHERS_LANE, [])
  for (const task of tasks) {
    if (!isOpen(task)) continue
    const stage = stageOf(task)
    // 不是选题的、以及进度落在这份清单之外的,都进「其它事项」——不猜它该在哪一段。
    const key = isTopic(task) && known.has(stage) ? stage : TOPIC_OTHERS_LANE
    buckets.get(key)?.push(task)
  }
  return [...stages, TOPIC_OTHERS_LANE].map(stage => ({ stage, tasks: buckets.get(stage) ?? [] }))
}

/**
 * 事项按**八环节**分组(上一版「待办事项」那一份,**一个字没改**)。
 *
 * 这一版界面不再按它分列,但它仍然是「一件事项属于哪个环节」这件事唯一的读法,
 * 「其它事项」那一列里的老卡靠 `laneOfModuleId` 显示环节走的是同一条约定。
 * 留着它也留着它那一整份用例:`module_id` 那条约定没有改过,不该因为界面换了排法
 * 就把它的守卫一起删掉。
 */
export function groupTasksByLane(
  tasks: readonly TaskView[],
  lanes: readonly string[],
): { lane: string, tasks: TaskView[] }[] {
  const known = new Set(lanes)
  const buckets = new Map<string, TaskView[]>()
  for (const lane of lanes) buckets.set(lane, [])
  buckets.set(TODO_UNASSIGNED_LANE, [])
  for (const task of tasks) {
    if (!isOpen(task)) continue
    const lane = laneOfModuleId(task.module_id)
    const key = lane !== undefined && known.has(lane) ? lane : TODO_UNASSIGNED_LANE
    buckets.get(key)?.push(task)
  }
  return [...lanes, TODO_UNASSIGNED_LANE].map(lane => ({ lane, tasks: buckets.get(lane) ?? [] }))
}

/** `POST /topic/assets` 回来的一条。形状与 server/topicAssets.ts 的 TopicAssetsView 一致。 */
export interface TopicAssetsRow {
  name: string
  dir: string
  files: { name: string, path: string, from: string }[]
  truncated?: boolean
  errors?: string[]
}

/** 新建选题那张小表单此刻填了什么。 */
interface TopicDraft {
  title: string
  contentType: TopicContentType
  priority: TaskPriority | ''
  projectId: string
  /** 计划发布日(`YYYY-MM-DD`)。空 = 不填 —— **没有"默认今天"**,同优先级那条。 */
  plannedAt: string
}

/**
 * 拼「这一批选题叫什么」时用的分隔符。用制表符不用逗号:选题名是人起的标题,
 * 里面出现逗号是常事,出现制表符不是。这一串**只用来判断"这一批变了没有"**,
 * 拆回去之后仍然是原样那几个名字。
 */
const NAME_SEP = '\t'

const EMPTY_DRAFT: TopicDraft = { title: '', contentType: '图文', priority: '', projectId: '', plannedAt: '' }

export function TodoModule({
  box, header, headingId, baseUrl, fetchImpl, tasks, lanes, stages = TOPIC_STAGES, projects = [],
  collectReady = false, initialOpen = null, embedded = false,
}: {
  box: ModuleBoxProps
  header: ReactNode
  headingId: string
  baseUrl: string
  fetchImpl: typeof fetch
  tasks: readonly TaskView[]
  /** 模板给的八环节。**只用来在这一格底下写一行流程说明**,不再分列。 */
  lanes: readonly string[]
  /** 进度六段。默认就是 TOPIC_STAGES;留这个口子是为了用例能给一份短的。 */
  stages?: readonly TopicStage[]
  /** 账号(= 项目区那一份)。卡上写账号名、表单里选账号,都靠它把 id 换成名字。 */
  projects?: readonly { id: string, name: string }[]
  /**
   * 采集接上了没有(2026-09-22)。**缺席 = 这台服务没接采集**,卡上连
   * 「拆解这条」那颗按钮都不出现 —— 不画一颗点了会 404 的按钮。
   */
  collectReady?: boolean
  /**
   * 一开就展开哪一张卡(原件:`contrib/air-20261002/src/topics.js` 里那一份
   * `LegacyTodoModule`,2026-10-03 原封不动接入)。她那一格点一张卡开「选题详情」浮层,
   * 浮层里嵌的就是这一格,只装那一条、并且一开就是展开的。
   */
  initialOpen?: string | null
  /**
   * 嵌在她那张浮层里(同上一条)。两处不一样:
   * 外面不再套 `ModuleBox`(浮层自己是容器),而且**空着的那几列不画**
   * (浮层里只有一条卡,六列里五列是空的)。
   */
  embedded?: boolean
}) {
  /** 新建选题的小表单开着没有。 */
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<TopicDraft>(EMPTY_DRAFT)
  /** 此刻展开的是哪一张卡(一次只展开一张:这一格很窄,两张一起展开就什么都看不见了)。 */
  const [open, setOpen] = useState<string | null>(initialOpen)
  /** 各条选题的素材。**取不到就是一张空表**,卡上那一栏整个不出现(不画 0)。 */
  const [assets, setAssets] = useState<Map<string, TopicAssetsRow>>(new Map())
  /**
   * 「拆解这条」开着的是哪一张卡,以及那个输入框里填了什么。
   *
   * ★ **要他给链接**,而不是我们去找:这一格里没有任何一处能搜索、能列别人的笔记。
   * 只从他自己给的那一条进,是采集与爬虫的分界线(见 server/xhsNoteText.ts 文件头)。
   */
  const [tearing, setTearing] = useState<string | null>(null)
  const [tearLink, setTearLink] = useState('')
  /** 拆解那一颗按钮点完之后服务端说的那句话。原样显示,**不美化**。 */
  const [tearSaid, setTearSaid] = useState<string | null>(null)
  const [tearBusy, setTearBusy] = useState(false)
  /** 嵌在浮层里时空着的那几列不画(见 `embedded`);不嵌的时候六列 + 一列一列都在。 */
  const groups = groupTopicsByStage(tasks, stages).filter(group => !embedded || group.tasks.length > 0)
  const topicNames = tasks.filter(task => isOpen(task) && isTopic(task)).map(task => task.title)
  // 名字变了才重问一次。每拍都问等于把一次目录扫描挂到了 1 秒的轮询上。
  const namesKey = topicNames.join(NAME_SEP)

  useEffect(() => {
    // 一条选题都没有:清空(已经是空的就**不动 state** —— 每次挂载都 set 一次
    // 会在没有 act 环境的用例里刷一串告警,而且那一拍什么都没变)。
    if (namesKey === '') { setAssets(prev => (prev.size === 0 ? prev : new Map())); return }
    let alive = true
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/topic/assets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ names: namesKey.split(NAME_SEP) }),
        })
        if (!res.ok) return
        const body = await res.json() as { topics?: TopicAssetsRow[] }
        if (!alive || body.topics === undefined) return
        setAssets(new Map(body.topics.map(row => [row.name, row])))
      }
      catch {
        // 取不到就维持上一份(或者空)。素材那一栏不显示,比显示一个编出来的 0 好。
      }
    })()
    return () => { alive = false }
  }, [namesKey, baseUrl, fetchImpl])

  /**
   * 拆一条对标笔记。走 `POST /collect/breakdown`(它会先采一次,再转写、再出框架)。
   *
   * 这一步要跑几分钟(下模型、转写、抽帧),所以按钮会一直是「拆解中…」,
   * 中途那几句「正在…」在设置里那一块与 `/state.xhs_collect.note` 上看得见。
   */
  const tearDown = (): void => {
    const url = tearLink.trim()
    if (url === '' || tearBusy) return
    setTearBusy(true)
    setTearSaid('正在拆(要几分钟:下视频、本机转写、抽帧)…')
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/collect/breakdown`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        const body = await res.json() as { message?: string }
        setTearSaid(typeof body.message === 'string' ? body.message : '拆完了')
      }
      catch (error) {
        setTearSaid(error instanceof Error ? error.message : '没拆成')
      }
      finally { setTearBusy(false) }
    })()
  }

  const submit = (): void => {
    const title = draft.title.trim()
    if (title === '') return
    void postSilently(`${baseUrl}/task/create`, {
      title,
      status: 'todo',
      kind: 'topic',
      content_type: draft.contentType,
      stage: DEFAULT_TOPIC_STAGE,
      ...(draft.priority === '' ? {} : { priority: draft.priority }),
      ...(draft.projectId === '' ? {} : { project_id: draft.projectId }),
      ...(draft.plannedAt === '' ? {} : { planned_at: draft.plannedAt }),
    }, fetchImpl)
    setDraft(EMPTY_DRAFT)
    setAdding(false)
  }

  /**
   * 推进一步 / 改日期**点完说一句**(原件:她那一份 `LegacyTodoModule` 里的
   * `actionNote` + `checkedPost`,2026-10-03 原封不动接入 —— 文案逐字是她的)。
   *
   * 原来这两颗走 `postSilently`:服务端拒绝时(从「发布」往「复盘」走而实际发布日还空着,
   * 见 `server/tasks.ts` 的 `TOPIC_PUBLISH_DAY_FIRST`)界面上一个字都不说、卡也不动,
   * 看着就像按钮坏了。
   */
  const [actionNote, setActionNote] = useState('')
  const checkedPost = async (url: string, body: unknown): Promise<void> => {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json() as { ok?: boolean, error?: string }
      setActionNote(r.ok && j.ok === true ? '已保存' : '未完成:' + (j.error ?? '请重试'))
    }
    catch (e) { setActionNote('未完成:' + (e instanceof Error ? e.message : '请重试')) }
  }
  const advance = (id: string): void => {
    void checkedPost(`${baseUrl}/task/advance`, { id })
  }

  /** 改一条选题的计划日 / 实际日。**空 = 清掉**(传 null),不是"写一个空字符串上去"。 */
  const setDate = (id: string, field: 'planned_at' | 'published_at', value: string): void => {
    void checkedPost(`${baseUrl}/task/update`, { id, [field]: value === '' ? null : value })
  }

  const openAssets = (name: string): void => {
    void postSilently(`${baseUrl}/topic/open`, { name }, fetchImpl)
  }

  const nameOfProject = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : projects.find(project => project.id === id)?.name ?? id

  const Shell = embedded ? Fragment : ModuleBox
  return (
    <Shell {...box}>
      <section className="ben-wb__card ben-wb__card--fill ben-wb__topics" aria-labelledby={headingId}>
        {header}
        {/* 推进 / 改日期点完那一句(见上面 `checkedPost`)。 */}
        {actionNote !== '' && <p role="status">{actionNote}</p>}
        <div className="ben-wb__topics-bar">
          <button
            type="button"
            className="ben-wb__topics-new"
            aria-expanded={adding}
            onClick={() => { setAdding(value => !value); setDraft(EMPTY_DRAFT) }}
          >
            ＋ 新建选题
          </button>
        </div>

        {adding && (
          <form
            className="ben-wb__topics-form"
            onSubmit={(event) => { event.preventDefault(); submit() }}
          >
            <input
              className="ben-wb__inp"
              autoFocus
              value={draft.title}
              aria-label="选题标题"
              placeholder="这条选题叫什么"
              onChange={event => setDraft(value => ({ ...value, title: event.target.value }))}
            />
            <label>
              内容类型
              <select
                aria-label="内容类型"
                value={draft.contentType}
                onChange={event => setDraft(value => ({ ...value, contentType: event.target.value as TopicContentType }))}
              >
                {TOPIC_CONTENT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              优先级
              <select
                aria-label="优先级"
                value={draft.priority}
                onChange={event => setDraft(value => ({ ...value, priority: event.target.value as TaskPriority | '' }))}
              >
                {/* 不选 = 不写这个字段。**没有"默认中"**:一个他没选过的优先级摆在卡上就是编的。 */}
                <option value="">不填</option>
                {(Object.keys(PRIORITY_WORDS) as TaskPriority[]).map(key => (
                  <option key={key} value={key}>{PRIORITY_WORDS[key]}</option>
                ))}
              </select>
            </label>
            <label>
              账号
              {/* aria-label 不能就叫「账号」:模块标题在运营模板下也是「账号」,
                  两个同名的可及名字会让"点账号那一个"变成一句有歧义的话。 */}
              <select
                aria-label="归哪个账号"
                value={draft.projectId}
                onChange={event => setDraft(value => ({ ...value, projectId: event.target.value }))}
              >
                <option value="">不填</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>
              {/* 计划发布日:填了就出现在「发布计划」月历的那一天(未发布那一个视图)。
                  不填照样能建 —— 一条还没想好哪天发的选题也是一条选题。 */}
              计划发布日
              <input
                type="date"
                aria-label="计划发布日"
                value={draft.plannedAt}
                onChange={event => setDraft(value => ({ ...value, plannedAt: event.target.value }))}
              />
            </label>
            <button type="submit">建好</button>
            <button type="button" onClick={() => { setAdding(false); setDraft(EMPTY_DRAFT) }}>取消</button>
          </form>
        )}

        <div className="ben-wb__topics-scroll" role="group" aria-label="选题池 按进度">
          {groups.map(group => (
            <div className="ben-wb__topics-col" key={group.stage} data-stage={group.stage}>
              <div className="ben-wb__topics-colname">
                <span>{group.stage}</span>
                <b>{group.tasks.length}</b>
              </div>
              <ul className="ben-wb__topics-list">
                {group.tasks.map((task) => {
                  const topic = isTopic(task)
                  const row = assets.get(task.title)
                  const stage = stageOf(task)
                  const lane = laneOfModuleId(task.module_id)
                  const account = nameOfProject(task.project_id)
                  const expanded = open === task.id
                  return (
                    <li className="ben-wb__topics-card" key={task.id} data-status={task.status} data-topic={topic}>
                      <button
                        type="button"
                        className="ben-wb__topics-head"
                        aria-expanded={expanded}
                        onClick={() => setOpen(value => (value === task.id ? null : task.id))}
                      >
                        <span className="ben-wb__topics-title">{task.title}</span>
                        <span className="ben-wb__topics-tags">
                          {/* 四态(2026-09-22):不展开也看得见她此刻在做哪一种事。
                              **由段现算**,盘上不存第二份(同八环节那条)。 */}
                          {topic && (
                            <span className="ben-wb__topics-tag" data-kind="phase" title={`第 ${TOPIC_STAGES.indexOf(stage) + 1} 段「${stage}」`}>
                              {topicPhaseOf(stage)}
                            </span>
                          )}
                          {task.content_type !== undefined && (
                            <span className="ben-wb__topics-tag" data-kind="type">{task.content_type}</span>
                          )}
                          {task.priority !== undefined && (
                            <span className="ben-wb__topics-tag" data-kind="priority">{PRIORITY_WORDS[task.priority]}</span>
                          )}
                          {account !== undefined && (
                            <span className="ben-wb__topics-tag" data-kind="account">{account}</span>
                          )}
                          {/* 取不到素材清单时这一颗整个不出现——不画「素材 0」。 */}
                          {row !== undefined && (
                            <span className="ben-wb__topics-tag" data-kind="assets">{`素材 ${row.files.length}`}</span>
                          )}
                          {/* 「其它事项」那一列里的老卡照旧带着它的八环节。 */}
                          {!topic && lane !== undefined && (
                            <span className="ben-wb__topics-tag" data-kind="lane">{lane}</span>
                          )}
                        </span>
                      </button>

                      {expanded && (
                        <div className="ben-wb__topics-body">
                          {/*
                            ★ 选题展开 = **指挥台**(2026-09-22 设计第一节):四态、每态一颗
                            「让事务官推进这一步」、七个产物页签、把关三键与留痕,全在 TopicDeck 里。
                            这里只把它做不到的两块塞给它:两个日期(要 `/task/update`)与
                            「拆解这条」(要 `/collect/breakdown`),由它按当前工作状态决定摊开还是收起。

                            **不是选题的那一批走老路**(下面那一支,一字没改):它们没有选题目录、
                            没有六段进度,给它们画一个指挥台等于画七个永远空着的页签。
                          */}
                          {topic
                            ? (
                                <TopicDeck
                                  task={task}
                                  stage={stage}
                                  baseUrl={baseUrl}
                                  fetchImpl={fetchImpl}
                                  account={account}
                                  assets={row}
                                  onAdvance={() => advance(task.id)}
                                  onOpenAssets={() => openAssets(task.title)}
                                  dates={(
                                    <div className="ben-wb__topics-dates">
                                      {/*
                                        两个日期都**可改**(2026-09-22 两状态):计划日是他排的,
                                        实际日我们在推进到「发布」那一段时替他记一个默认值 ——
                                        真发出去是哪天只有他知道,所以这里必须能改、也能清空。
                                        不做本地乐观更新:改完以下一拍 GET /state 为准(全仓通行纪律)。
                                      */}
                                      <label>
                                        计划发布日
                                        <input
                                          type="date"
                                          aria-label={`${task.title} 的计划发布日`}
                                          value={task.planned_at ?? ''}
                                          onChange={event => setDate(task.id, 'planned_at', event.target.value)}
                                        />
                                      </label>
                                      <label>
                                        实际发布日
                                        <input
                                          type="date"
                                          aria-label={`${task.title} 的实际发布日`}
                                          value={task.published_at ?? ''}
                                          onChange={event => setDate(task.id, 'published_at', event.target.value)}
                                        />
                                      </label>
                                      {task.due !== undefined && (
                                        <p className="ben-wb__topics-due">{`预期结束:${task.due}`}</p>
                                      )}
                                    </div>
                                  )}
                                  {...(collectReady
                                    ? {
                                        breakdown: (
                                          <>
                                            {/* 「拆解这条」那颗按钮**一字没改**(措辞、开合、打的路由都是上一版那一颗),
                                                只是连同它的面板一起搬进「数据与对标」那一块 —— 复盘态摊开,别的态收起。 */}
                                            <button
                                              type="button"
                                              className="ben-wb__topics-assets"
                                              title="给我一条小红书笔记链接,我去采下来、转写、拆出内容框架"
                                              onClick={() => {
                                                setTearSaid(null)
                                                setTearing(prev => (prev === task.id ? null : task.id))
                                              }}
                                            >
                                              拆解这条
                                            </button>
                                            {tearing === task.id && (
                                          <div className="ben-wb__topics-tear">
                                            <p className="ben-wb__topics-nofiles">
                                              把那条爆款笔记的链接贴进来(在小红书里打开它,复制地址栏那一条)。
                                              我只从你给的这一条进,不会去搜、也不会去翻别人的主页。
                                            </p>
                                            <input
                                              className="ben-wb__topics-tearin"
                                              type="url"
                                              aria-label="对标笔记链接"
                                              placeholder="https://www.xiaohongshu.com/explore/…"
                                              value={tearLink}
                                              onChange={event => setTearLink(event.target.value)}
                                            />
                                            <button
                                              type="button"
                                              className="ben-wb__topics-adv"
                                              disabled={tearBusy || tearLink.trim() === ''}
                                              onClick={() => tearDown()}
                                            >
                                              {tearBusy ? '拆解中…' : '开始拆解'}
                                            </button>
                                            {tearSaid !== null && (
                                              <p className="ben-wb__topics-nofiles" role="status">{tearSaid}</p>
                                            )}
                                          </div>
                                            )}
                                          </>
                                        ),
                                      }
                                    : {})}
                                />
                              )
                            : (
                                <>
                                  {task.desc !== undefined && <p className="ben-wb__topics-desc">{task.desc}</p>}
                                  <p className="ben-wb__topics-flow">这条不是选题,是一件普通事项。</p>
                                  {task.due !== undefined && <p className="ben-wb__topics-due">{`预期结束:${task.due}`}</p>}
                                </>
                              )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        {lanes.length > 0 && (
          <p className="ben-wb__topics-hint">
            {`完整流程八环节:${lanes.join(' → ')}`}
          </p>
        )}
      </section>
    </Shell>
  )
}
