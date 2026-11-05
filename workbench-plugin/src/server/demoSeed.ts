/**
 * **演示数据一键放进去**(2026-10-13,卡「演示数据一键放进去」;周三 10-14 演示)。
 *
 * 来由:统筹 10-13 中午在这台 Mac 上真跑了一遍早报,出来的还是老三句 + 资讯 + 一问 ——
 * 日报那四段(已完成 / 推进中 / 卡点 / 下一步)一段没有、「今天的会」没有、「今天的待办」没有。
 * 不是早报写坏了:**窗口里没有东西**(没有 Agent 任务记录、没有带日期的事项,三场演示会是
 * 「整理好的」不是「今天要开的」)。演示机上更空。维护者的口径是「演示不是展示生产」——
 * 要有现成的、**明标演示用**的数据。
 *
 * ## 三条纪律(照 `meetingDemoCases.ts` 那张卡的先例)
 *
 * ① **走真路**:看板事项走 `tasks.create` + 七态表一格一格 `move`(与「卡片内填」、`/task/create`
 *    同一个口);派活记录走**任务账那本**(`jobLog.append`,时刻自己给)与卡上那份派活记录
 *    (与 `POST /butler/item/dispatch` 记的那一份同形 —— 那条路由自己写着「这一层不起进程,只记账」);
 *    发布计划走选题卡(与「座机一句话记发布计划」落成的那一种逐字同形);会走 `meeting.plan`。
 *    **没有另造一套假数据结构。**
 * ② **明标演示用**:每张卡 `demo: true`(机器认它,清掉时按它挑)+ `desc` 第一段写着「演示用」
 *    (人看得见:卡片里、发布计划悬浮里都是这一段)。发布计划那几条的来源写「演示数据」,
 *    不冒充电话或手机。
 * ③ **虚构、不写真人真公司、一处凭据都没有**(用例钉着:不许出现邮箱、长串数字、
 *    「微信 / 手机号」、「密码 / 密钥」)。
 *
 * ## 为什么记录的时刻是算出来的,不是写死「昨天 18:40」
 *
 * 早报四段的窗口是**上次早报那一刻到现在**(`agentDayReview.dayReviewWindow`)。统筹中午刚手动
 * 跑过一次,于是「昨天」的时间戳一条都落不进窗口 —— 四段照样空着。所以这几条记录的时刻由
 * {@link demoRecordAt} 现算:名义上铺开 {@link DEMO_SPAN_MINUTES} 分钟,**上次早报比那还近就
 * 整段压进「上次早报之后」那一截**,保证每一条都落在这一次早报看得见的窗口里。
 * 放一次 = 这一段的记录重记一套(卡不重建),所以**先放、再跑早报** —— 放完这里会自己去跑一遍。
 */
import type { TaskStatus, TaskView, TopicContentType } from '../protocol.ts'
import { DEFAULT_TOPIC_STAGE, publishPlanDescOf, statusPathTo } from '../protocol.ts'
import { localDayOf } from '../todayTodos.ts'
import type { JobEvent, JobStep } from './jobLog.ts'
import type { CreateTaskInput, UpdateTaskInput } from './tasks.ts'

/* ─────────────────────── 记号与口径 ─────────────────────── */

/** 界面上那个不起眼的记号(卡片里、回话里共用这一个字串;同 `MEETING_DEMO_TAG`)。 */
export const DEMO_TAG = '演示用'

/** 发布计划那几条的「来源」那一行写什么。**不冒充电话 / 手机**。 */
export const DEMO_SOURCE = '演示数据'

/** 这几条记录名义上铺开多少分钟(「昨天傍晚到今天早上」那一段的压缩版)。 */
export const DEMO_SPAN_MINUTES = 240

/** 清掉时要说实话的两句(账是只追加的、会删不掉)。 */
export const DEMO_CLEAR_JOBS_NOTE = '任务账是只追加的那一本,放进去的那几条记录留在账上;卡取消了,早报四段就不再数它们。'
export const DEMO_CLEAR_MEETING_NOTE = '会议模式里没有删除的路,那一场留着(列表上标着「演示用」)。'

/** 卡上 `desc` 第一段:人一眼看得出这是演示用的。 */
export function demoDescOf(text: string): string {
  return `${DEMO_TAG} · ${text}`
}

/** 今天 / 今天 + N 天是哪一天(`YYYY-MM-DD`,按这台电脑的时区 —— 同 `/state.today_todos` 那一刀)。 */
export function demoDayOf(nowMs: number, days: number): string {
  return localDayOf(new Date(nowMs + days * 86_400_000))
}

/**
 * 一条记录落在哪一刻。名义上是「{@link DEMO_SPAN_MINUTES} 分钟前到现在」那一段里的某一刻;
 * **上次早报比那还近就整段压进「上次早报之后」**(晚一分钟起),这样每一条都在这一次早报的窗口里。
 *
 * 一个数都不编:`minutesAgo` 是样例表里写着的名义位置,窗口两端来自钟与上次早报那一刻。
 */
export function demoRecordAt(nowMs: number, lastMorningAt: string | undefined, minutesAgo: number): string {
  const span = DEMO_SPAN_MINUTES * 60_000
  const last = lastMorningAt === undefined || lastMorningAt === '' ? Number.NaN : Date.parse(lastMorningAt)
  const floor = Number.isNaN(last) || last < nowMs - span ? nowMs - span : last + 60_000
  const usable = Math.max(1, nowMs - floor)
  const ago = Math.round((Math.min(Math.max(minutesAgo, 0), DEMO_SPAN_MINUTES) / DEMO_SPAN_MINUTES) * usable)
  return new Date(nowMs - ago).toISOString()
}

/* ─────────────────────── ① 看板事项(带日期) ─────────────────────── */

export interface DemoBoardItem {
  /** 稳定的号(用例、彩排页里认它;不进界面)。 */
  key: string
  title: string
  desc: string
  /** `due` 距今天几天(0 = 今天;没有负数 —— 逾期那一档由她自己的真数据演)。 */
  dueDays: number
  /** 卡最后停在哪一格(从「待办」按七态表一格一格走过去)。 */
  status: TaskStatus
}

/**
 * 自媒体语境的一天:今天到期 6 条(其中 1 条已经打过勾、1 条卡着)、明天 2 条、更晚 2 条。
 * 前两条**接着昨天那几件**(交回来的脚本要定一版、读不回来的封面图要重派)。
 */
export const DEMO_BOARD_ITEMS: readonly DemoBoardItem[] = [
  {
    key: 'script-pick',
    title: '看一眼三版口播脚本,定用哪一版',
    desc: '接着昨天交回来的那三版:挑一版定下来,另两版留着当备选。',
    dueDays: 0,
    status: 'todo',
  },
  {
    key: 'cover-retry',
    title: '封面图换个法子重派',
    desc: '昨天那条卡在「回话读不回来」:换一家、或者把要求缩短再派一次。',
    dueDays: 0,
    status: 'todo',
  },
  {
    key: 'rough-cut',
    title: '露营短片粗剪到 3 分钟',
    desc: '素材已经进剪辑工程,先把节奏剪顺;配乐等选定再铺。',
    dueDays: 0,
    status: 'doing',
  },
  {
    key: 'shot-list',
    title: '列周六补拍的机位与日落时间',
    desc: '补两个镜头:支帐篷的俯拍、天黑前的侧逆光。',
    dueDays: 0,
    status: 'todo',
  },
  {
    key: 'send-cut',
    title: '把上周的粗剪发给朋友看一眼',
    desc: '回了两条意见:开头太慢、字幕太小。',
    dueDays: 0,
    status: 'done',
  },
  {
    key: 'product-closeup',
    title: '补拍一条产品特写',
    desc: '卡在等客户回传产品素材 —— 素材到了才拍得了。',
    dueDays: 0,
    status: 'blocked',
  },
  {
    key: 'post-copy',
    title: '写露营短片的发布文案与标签',
    desc: '标题三版、正文一版、标签不超过八个。',
    dueDays: 1,
    status: 'todo',
  },
  {
    key: 'call-dp',
    title: '约摄影师聊下一条片子的机位',
    desc: '先把下一条片子的拍摄日定下来。',
    dueDays: 1,
    status: 'todo',
  },
  {
    key: 'review-page',
    title: '把九月复盘做成一页图',
    desc: '三条结论各一张图,发在账号主页。',
    dueDays: 3,
    status: 'todo',
  },
  {
    key: 'archive',
    title: '清一遍素材盘,把九月的素材归档',
    desc: '按「选题 / <名> / 素材」那套目录归。',
    dueDays: 5,
    status: 'todo',
  },
]

/* ─────────────────────── ② 昨天的 Agent 任务记录 ─────────────────────── */

/** 账上那一条:哪一步、名义上在多少分钟前。 */
export interface DemoAgentMark {
  step: JobStep
  minutesAgo: number
}

export interface DemoAgentRecord {
  key: string
  title: string
  desc: string
  /** 哪一家(登记表里那个 id;念法只在 `ASSIGNEE_NAMES`,这里不写中文名)。 */
  family: string
  /** 卡最后停在哪一格。 */
  status: TaskStatus
  /** 任务账上那几条(走 `jobLog.append`)。 */
  marks: readonly DemoAgentMark[]
  /**
   * 卡上那份派活记录(与 `POST /butler/item/dispatch` 记的那一份同形)。
   * **不带 pid** —— 没有真进程,卡上那颗「停掉」就不该出现(D13:不画一颗点了没反应的按钮)。
   */
  dispatch?: {
    status: 'running' | 'done' | 'failed'
    /** 那家交回时的摘要 / 没做成的原话。早报「推进中」那一段的「做到哪」读的就是它。 */
    note: string
    startedAgo: number
    endedAgo?: number
  }
  /** 这一条演示四段里的哪一档(回话与彩排页用同一句)。 */
  blurb: string
}

/**
 * 六件:已完成 2(各有明确结果依据)、推进中 2(写清做到哪)、卡点 1(卡在哪 + 要不要外部条件)、
 * 当日新增未推进 1。头三件同属「露营短片」那一条片子 —— 规范第 3 条要的并条给模型留着素材。
 *
 * **档位不是写在这张表里的**:它由 `agentDayReview.ts` 按这几条记录自己判(完成要有依据、
 * 送到不算办完、没来得及不算卡点)。表里只有「记录本身」。
 */
export const DEMO_AGENT_RECORDS: readonly DemoAgentRecord[] = [
  {
    key: 'script',
    title: '露营短片:三版口播脚本',
    desc: '一版平铺直叙、一版先抛问题、一版第一人称;交回来挑一版。',
    family: 'claude',
    status: 'confirm',
    marks: [
      { step: 'assigned', minutesAgo: 230 },
      { step: 'sent', minutesAgo: 225 },
      { step: 'seen', minutesAgo: 220 },
      { step: 'replied', minutesAgo: 60 },
    ],
    dispatch: { status: 'done', note: '三版口播脚本写完交回来了,落在选题目录里', startedAgo: 230, endedAgo: 60 },
    blurb: '已完成:那家交回来了,等你验收(依据是交回那一下,不是「讨论过了」)',
  },
  {
    key: 'music',
    title: '露营短片:配乐挑 6 首备选',
    desc: '要安静、不抢人声;挑够 6 首再一起听。',
    family: 'codex',
    status: 'doing',
    marks: [
      { step: 'assigned', minutesAgo: 200 },
      { step: 'sent', minutesAgo: 195 },
      { step: 'seen', minutesAgo: 190 },
    ],
    dispatch: { status: 'running', note: '挑了 6 首备选,还没定用哪一首', startedAgo: 200 },
    blurb: '推进中:做到哪有一句具体的(「挑了 6 首备选,还没定」)',
  },
  {
    key: 'cover',
    title: '露营短片:封面图三版',
    desc: '一版人在帐篷前、一版只有山、一版特写;要竖版。',
    family: 'doubao',
    status: 'doing',
    marks: [
      { step: 'assigned', minutesAgo: 180 },
      { step: 'sent', minutesAgo: 175 },
      { step: 'unreadable', minutesAgo: 95 },
    ],
    dispatch: { status: 'failed', note: '那扇窗里的回话读不回来', startedAgo: 180, endedAgo: 95 },
    blurb: '卡点:回话读不回来,要重派(「今天没来得及」不算卡点)',
  },
  {
    key: 'review',
    title: '九月数据复盘:三条结论',
    desc: '只要结论与下一步,不要一大张表。',
    family: 'kimi',
    status: 'done',
    marks: [
      { step: 'assigned', minutesAgo: 220 },
      { step: 'sent', minutesAgo: 215 },
      { step: 'replied', minutesAgo: 120 },
    ],
    dispatch: { status: 'done', note: '三条结论 + 下一步建议', startedAgo: 220, endedAgo: 120 },
    blurb: '已完成:你自己把卡收进「办完」那一件',
  },
  {
    key: 'topics',
    title: '十一月选题:六个方向初筛',
    desc: '从二十多个想法里筛到六个,再排一轮顺序。',
    family: 'claude',
    status: 'doing',
    marks: [
      { step: 'assigned', minutesAgo: 150 },
      { step: 'sent', minutesAgo: 145 },
      { step: 'seen', minutesAgo: 140 },
    ],
    dispatch: { status: 'running', note: '筛到 6 个方向,还差一轮排序', startedAgo: 150 },
    blurb: '推进中:第二条,与上面那条不同目标(并条时分得开)',
  },
  {
    key: 'brand',
    title: '品牌方植入:口播那一段怎么改',
    desc: '把植入那句话放在哪、说多久,先出两个改法。',
    family: 'codex',
    status: 'todo',
    marks: [{ step: 'assigned', minutesAgo: 20 }],
    blurb: '当日新增、还没实质推进:它只进「下一步」,不占前三段',
  },
]

/* ─────────────────────── ③ 发布计划 ─────────────────────── */

export interface DemoPublishPlan {
  key: string
  title: string
  contentType: TopicContentType
  /** 计划发布日距今天几天。 */
  plannedDays: number
}

export const DEMO_PUBLISH_PLANS: readonly DemoPublishPlan[] = [
  { key: 'camping', title: '露营短片:一个人山里住两天', contentType: '视频', plannedDays: 2 },
  { key: 'gear', title: '装备清单:背包里这八样', contentType: '图文', plannedDays: 5 },
  { key: 'review', title: '九月复盘:涨粉是从哪儿来的', contentType: '视频', plannedDays: 8 },
]

/** 发布计划那条卡上的「原话」(悬浮上去看得见)。日子由上面那个天数算出来,不写死一个号。 */
export function demoPlanSaid(plan: DemoPublishPlan, day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const when = m === null ? day : `${Number(m[2])} 月 ${Number(m[3])} 号`
  return `计划 ${when} 发这条${plan.contentType}:${plan.title}`
}

/* ─────────────────────── ④ 今天要开的那一场会 ─────────────────────── */

/**
 * 登记那一句(走 `meeting.plan` 的真路)。标题与哪天都由 `draftMeetingPlan` 从这句话里切出来 ——
 * 所以这一场是**今天**的会,早报的「今天的会」与手机的会前画像才有东西。
 * 与昨晚那三场「整理好的」不冲突(那三场是 `done`,这一场是 `planned`)。
 */
export const DEMO_MEETING_SAID = '跟剪辑对一下这条片子的节奏,今天下午四点,把粗剪的问题过一遍'

/* ─────────────────────── 放进去 ─────────────────────── */

export type DemoGroup = 'board' | 'agent' | 'publish' | 'meeting'

export interface DemoSeedLine {
  group: DemoGroup
  key: string
  title: string
  /** 卡已经在了(没建第二张)。 */
  skipped?: true
  /** 这一条发生了什么 / 哪一步没成(如实说,不吞)。 */
  note: string
}

export interface DemoSeedReport {
  lines: readonly DemoSeedLine[]
  /** 往任务账上记了几条。 */
  jobs: number
  /** 这几条记录落在哪一段(早报四段的窗口要盖得住它)。 */
  window: { since: string, until: string }
  /** 早报重跑了没有(如实说;没接例程就是那句)。 */
  morning: string
  note: string
}

export interface DemoSeedDeps {
  now: () => number
  /** 上次早报那一刻(`/state.routines.last.morning.started_at`)。缺席 = 没跑过 → 按 24 小时那条退路。 */
  lastMorningAt?: () => string | undefined
  tasks: {
    list: () => Promise<readonly TaskView[]>
    create: (input: CreateTaskInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
    move: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }>
    update: (id: string, input: UpdateTaskInput) => Promise<boolean>
  }
  /** 任务账那本的写入口(`jobLog.append`)。 */
  appendJob: (event: Omit<JobEvent, 'at'> & { at?: string }) => unknown
  /** 建 `选题/<名>/素材/`(与 `/task/create` 那一段同一个口)。缺席 = 没配工作目录,不建也不报错。 */
  ensureTopicDir?: (title: string) => Promise<{ ok: boolean, reason?: string }>
  /** 登记一场会(`meeting.plan`)。缺席 = 没接会议模式。 */
  planMeeting?: (text: string) => Promise<{ ok: boolean, title?: string, error?: string }>
  /** 已经有哪几场会(认重复:同一天、同一个标题)。 */
  listMeetings?: () => Promise<readonly { title: string, date: string }[]>
  /** 这一句话会切出什么标题、哪一天(`draftMeetingPlan`)。认重复用它,不自己再切一遍。 */
  draftMeetingTitle?: (said: string, nowMs: number) => { title: string, date: string }
  /** 放完跑一遍早报(`routines.run('morning')`)。缺席 = 没接例程,回话里让她自己点一下。 */
  runMorning?: () => Promise<{ ok: boolean, reason?: string }>
}

export const DEMO_MORNING_NO_ROUTINE = '这台没接例程,早报没替你跑 —— 在收件箱里点一下「现在出一份早报」。'

export async function seedDemoData(deps: DemoSeedDeps): Promise<DemoSeedReport> {
  const nowMs = deps.now()
  const lastMorning = deps.lastMorningAt?.()
  const lines: DemoSeedLine[] = []
  let jobs = 0
  const existing = await deps.tasks.list()

  /** 这张卡放过了没有(按 `demo` 记号 + 标题;取消掉的不算 —— 清过之后再放一次照旧放得进)。 */
  const mine = (title: string): TaskView | undefined =>
    existing.find(task => task.demo === true && task.title === title && task.status !== 'canceled')

  /** 建一张卡,再按七态表一格一格走到那一格。**不直接写一个状态**(与她在界面上拖是同一条路)。 */
  async function putCard(input: CreateTaskInput, target: TaskStatus): Promise<{ id?: string, note?: string }> {
    const created = await deps.tasks.create({ ...input, status: 'todo', demo: true })
    if (!created.ok || created.id === undefined) return { note: `建不出来:${created.reason ?? '没说原因'}` }
    const path = statusPathTo('todo', target) ?? []
    for (const step of path) {
      const moved = await deps.tasks.move(created.id, step)
      if (!moved.ok) return { id: created.id, note: `卡建好了,挪到「${step}」没成:${moved.reason ?? '没说原因'}` }
    }
    return { id: created.id }
  }

  // ① 看板事项(带日期)
  for (const item of DEMO_BOARD_ITEMS) {
    if (mine(item.title) !== undefined) {
      lines.push({ group: 'board', key: item.key, title: item.title, skipped: true, note: '已经有这一条了,没放第二张。' })
      continue
    }
    const day = demoDayOf(nowMs, item.dueDays)
    const put = await putCard({ title: item.title, desc: demoDescOf(item.desc), due: day }, item.status)
    lines.push({ group: 'board', key: item.key, title: item.title, note: put.note ?? `放好了:${day} 到期。` })
  }

  // ② 昨天的 Agent 任务记录。**卡不重建,记录每次都重记一套** —— 四段的窗口是「上次早报到现在」。
  for (const one of DEMO_AGENT_RECORDS) {
    const already = mine(one.title)
    let id = already?.id
    let note = already === undefined ? '' : '卡已经有了,只把那几条记录的时刻刷新到这一段。'
    if (already === undefined) {
      const put = await putCard({ title: one.title, desc: demoDescOf(one.desc), assignee: one.family }, one.status)
      id = put.id
      if (put.note !== undefined) note = put.note
    }
    if (id === undefined) {
      lines.push({ group: 'agent', key: one.key, title: one.title, note: note === '' ? '建不出来' : note })
      continue
    }
    for (const mark of one.marks) {
      deps.appendJob({
        job: id,
        step: mark.step,
        family: one.family,
        at: demoRecordAt(nowMs, lastMorning, mark.minutesAgo),
        why: DEMO_TAG,
      })
      jobs += 1
    }
    if (one.dispatch !== undefined) {
      const written = await deps.tasks.update(id, {
        dispatch: {
          family: one.family,
          status: one.dispatch.status,
          // 接口那只手:这几条记录不碰任何文件,所以没有工作目录(同 `/butler/item/dispatch` 给 `api` 留的那一格)。
          hand: 'api',
          started_at: demoRecordAt(nowMs, lastMorning, one.dispatch.startedAgo),
          ...(one.dispatch.endedAgo === undefined ? {} : { ended_at: demoRecordAt(nowMs, lastMorning, one.dispatch.endedAgo) }),
          note: one.dispatch.note,
        },
      })
      if (!written) note = `${note}派活记录没写上(没有这张卡)。`
    }
    lines.push({
      group: 'agent',
      key: one.key,
      title: one.title,
      ...(already === undefined ? {} : { skipped: true as const }),
      note: `${note === '' ? '' : `${note} `}${one.blurb}`,
    })
  }

  // ③ 发布计划(与「卡片内填」逐字同形的选题卡)
  for (const plan of DEMO_PUBLISH_PLANS) {
    if (mine(plan.title) !== undefined) {
      lines.push({ group: 'publish', key: plan.key, title: plan.title, skipped: true, note: '月历上已经有这一条了。' })
      continue
    }
    const day = demoDayOf(nowMs, plan.plannedDays)
    const put = await putCard({
      title: plan.title,
      kind: 'topic',
      stage: DEFAULT_TOPIC_STAGE,
      contentType: plan.contentType,
      plannedAt: day,
      // 原话 + 来源那一行走契约里那一个记号(发布计划悬浮上去读的就是它)。
      desc: publishPlanDescOf({ said: demoDescOf(demoPlanSaid(plan, day)), from: DEMO_SOURCE, at: new Date(nowMs) }),
    }, 'todo')
    const dir = put.id === undefined ? undefined : await deps.ensureTopicDir?.(plan.title)
    lines.push({
      group: 'publish',
      key: plan.key,
      title: plan.title,
      note: put.note ?? `排在 ${day}${dir === undefined || dir.ok ? '' : `(选题目录没建出来:${dir.reason ?? '没说原因'})`}。`,
    })
  }

  // ④ 今天要开的那一场会
  if (deps.planMeeting === undefined) {
    lines.push({ group: 'meeting', key: 'meeting', title: DEMO_MEETING_SAID, note: '这台没接会议模式,这一场没登记。' })
  }
  else {
    const draft = deps.draftMeetingTitle?.(DEMO_MEETING_SAID, nowMs)
    const had = draft === undefined
      ? undefined
      : (await deps.listMeetings?.() ?? []).find(one => one.date === draft.date && one.title === draft.title)
    if (had !== undefined) {
      lines.push({ group: 'meeting', key: 'meeting', title: had.title, skipped: true, note: '今天已经有这一场了,没登记第二场。' })
    }
    else {
      const planned = await deps.planMeeting(DEMO_MEETING_SAID)
      lines.push({
        group: 'meeting',
        key: 'meeting',
        title: planned.title ?? DEMO_MEETING_SAID,
        note: planned.ok
          ? '登记好了:今天下午那一场(手机上翻会前,早报里念「今天的会」)。'
          : `没登记上:${planned.error ?? '没说原因'}`,
      })
    }
  }

  // ⑤ 放完跑一遍早报(四段的窗口刚好盖住上面那几条记录)
  let morning = DEMO_MORNING_NO_ROUTINE
  if (deps.runMorning !== undefined) {
    const ran = await deps.runMorning().catch((error: unknown) =>
      ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
    morning = ran.ok
      ? '早报在跑了:好了在事务官收件箱与手机「汇报」页里看。'
      : `早报没跑成:${ran.reason ?? '没说原因'}(自己点一下「现在出一份早报」)。`
  }

  const put = lines.filter(one => one.skipped !== true).length
  return {
    lines,
    jobs,
    window: { since: demoRecordAt(nowMs, lastMorning, DEMO_SPAN_MINUTES), until: new Date(nowMs).toISOString() },
    morning,
    note: `放了 ${put} 条,跳过 ${lines.length - put} 条已经有的;往任务账上记了 ${jobs} 条。全部标着「${DEMO_TAG}」。`,
  }
}

/* ─────────────────────── 清掉 ─────────────────────── */

export interface DemoClearReport {
  /** 挪进「取消」的几张。 */
  canceled: number
  /** 挪不动的那几张(如实说是哪一张、为什么)。 */
  failed: readonly { title: string, why: string }[]
  note: string
}

/**
 * 清掉演示数据:**只动带 `demo` 记号的那几张卡**,按七态表挪进「取消」
 * (「取消」不是删掉 —— 不可改清单第 5 条要的正是「系统不许替她扔东西」;
 * `tasks.remove` 只有她自己点才走,服务端永远不调它)。
 * 取消掉的卡不进月历、不进「今天的待办」,也不进早报四段(`dayReviewFacts` 第一道就排掉取消的)。
 *
 * 两样动不了,如实说:任务账是只追加的那一本;会议模式没有删除的路。
 */
export async function clearDemoData(deps: Pick<DemoSeedDeps, 'tasks'>): Promise<DemoClearReport> {
  const all = await deps.tasks.list()
  const demos = all.filter(task => task.demo === true && task.status !== 'canceled')
  const failed: { title: string, why: string }[] = []
  let canceled = 0
  for (const task of demos) {
    const path = statusPathTo(task.status, 'canceled')
    if (path === undefined) { failed.push({ title: task.title, why: `从「${task.status}」挪不到「取消」` }); continue }
    let ok = true
    for (const step of path) {
      const moved = await deps.tasks.move(task.id, step)
      if (!moved.ok) { failed.push({ title: task.title, why: moved.reason ?? `挪到「${step}」没成` }); ok = false; break }
    }
    if (ok) canceled += 1
  }
  return {
    canceled,
    failed,
    note: `取消了 ${canceled} 张演示卡${failed.length === 0 ? '' : `,${failed.length} 张没挪动`}。`
      + `${DEMO_CLEAR_JOBS_NOTE}${DEMO_CLEAR_MEETING_NOTE}`,
  }
}
