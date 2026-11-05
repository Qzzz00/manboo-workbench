/**
 * ★ **「这件事」的键只有一处定法**(2026-10-02,卡 AG2)。
 *
 * 卡 AG 把动作闸(`actionGate.ts`)立起来之后留了一个口子,写在
 * `docs/交接-1002-网易云反复弹出与不点名不派.md` 第二节 D 的末尾:
 *
 * > **要定的一件事**:捎话轻账(`RelayWait`)与会话那几条路上**没有事项 id**,所以闸的
 * > 「收场了就不动」在那几条上退化成 `unknown`(只有次数上限生效)。
 *
 * 于是「替她答 / 捎话 / 点选项 / 写面板 / 批准 / 停止」那六只手,哪怕接上了闸,也只挡得住
 * 「来太多回」,挡不住「这件事早就收场了还在动那一家」—— 而后者正是 10-02 真机那一类
 * (她的原话:「完成后每隔 10s 又自行打开网易云。。不断弹窗」)。
 *
 * 这一份就是补那个口子,只做两件事,**都只在这一处**:
 *
 * ① **键**:有事项就用事项 id;真没有事项的那几条路用**会话**当这件事的键
 *    (`session:<家>/<会话 id>`)。拼字符串、拆字符串都只许问这里({@link sessionJobId} /
 *    {@link sessionOfJob}),管线里一处都不许自己拼。
 * ② **这个键此刻收场了没有**({@link jobPhaseOf}):
 *    - 事项 id → 看板上那张卡的状态(`done` / `canceled` = 收场);
 *    - 会话键 → 先看**有没有一张卡认领了这条会话**(卡上 `client_dispatch.session_id`);
 *      认领了就按那张卡算(这就是「有对应事项的带上」那一半,自动生效);
 *      没卡认领 → 这条会话还在清单上 = 还在办;**这一家的清单查得到、而这一条不在里面** = 收场;
 *      连这一家的清单都查不到(壳没连上、还没扫到)→ `unknown`,**照旧放行**。
 *
 * 最后那一条是纪律不是性能:什么都不知道的时候不许拦她的活,也不许把「查不到」说成「收场了」。
 */
/*
 * ★ **这个文件是纯叶子,故意的**(2026-10-03,卡「两条接缝」):只有一个 type import,
 * 没有任何运行时依赖。所以 `src/waiting.ts` / `src/running.ts` 与 `src/client/*`(两半共用的那几份)
 * 也 import 得起它 —— 「这条会话这件事的键」在服务端与浏览器里是同一个定法,不许各拼一遍。
 * 手机那个包够不到这里(顶层子目录互不 import),它那一份由
 * `butler-app/tests/session-job-key-sync.test.ts` 读这个文件的源码钉着。
 */
import type { JobPhase } from './actionGate.ts'

/** 会话当键时前面那一截。**别在别处写这个字面量**。 */
export const SESSION_JOB_PREFIX = 'session:'

/**
 * 登记回电那一刻还认不出是哪条对话(新开一条 / 只盯不发)时,这件事的键 = 这本账自己那一条。
 * 它不是会话键,`jobPhaseOf` 对它只能答「查不出」(放行;次数上限照旧管)—— 不许把「还不知道是哪条」说成「收场了」。
 */
export const RELAY_JOB_PREFIX = 'relay:'
export function relayWaitJobId(waitId: string): string {
  return `${RELAY_JOB_PREFIX}${waitId}`
}

/**
 * 家与会话 id 之间那一刀。**冒号不行**:窗口型那几条会话 id 自己带冒号(`window:825f1900`),
 * 而家名(登记表 id / 包标识)里没有 `/`(`/^[A-Za-z0-9._-]{1,64}$/`),所以第一个 `/` 之后全是会话 id。
 */
export const SESSION_JOB_SEP = '/'

/**
 * ★ **「这条会话」这件事的键,只有这一个定法**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
 *
 * 2026-10-02 这里收了闸与账那一条链;审计第二表第 15 条记着另两种格式:
 * `sessionAskCalls` 排电话的事项 id(`session:<会话 id>`,没有家名)与 `/state.waiting` 那一行的键
 * (`session:<家>:<会话 id>`,分隔符是冒号 —— 窗口型会话 id 自带冒号,于是拆的时候要「只切前两刀」)。
 * 三种都叫 `session:` 开头,**同一个字符串在三处是三个意思**。
 *
 * 现在三处都用这一个({@link sessionJobId} 拼、{@link sessionOfJob} 拆):
 * 闸与账的键、座机台账的 `item_id`、`/state.waiting` 与 `/state.running` 那一行的 `key`。
 * 落了盘的老键由 `callOutMigrate.ts` 启动时迁一次;认得出家的那几行改写,认不出家的
 * **原样留着**(`sessionOfJob` 对它答 undefined → 闸 `unknown` → 放行,与从前一字不差,不许当收场)。
 */
export function sessionJobId(agent: string, sessionId: string): string {
  return `${SESSION_JOB_PREFIX}${agent}${SESSION_JOB_SEP}${sessionId}`
}

/** 这个键是不是会话键;是就拆出家与会话 id(不是就 undefined)。 */
export function sessionOfJob(job: string): { agent: string, sessionId: string } | undefined {
  if (!job.startsWith(SESSION_JOB_PREFIX)) return undefined
  const rest = job.slice(SESSION_JOB_PREFIX.length)
  const cut = rest.indexOf(SESSION_JOB_SEP)
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { agent: rest.slice(0, cut), sessionId: rest.slice(cut + 1) }
}

/**
 * **老格式那两种**(2026-10-03 之前写下的键)。只在两处用:
 * ① 迁移读落了盘的座机台账(`session:<会话 id>` —— 没有家名,`withAgent:false`);
 * ② `/asks/answer` 收老手机包送来的那一行键(`session:<家>:<会话 id>`,`withAgent:true`)。
 *
 * **两种老格式彼此有歧义**(`session:window:825f1900` 两边都读得通),所以不做「自动认」——
 * 调用点自己知道读的是哪一种,把 `withAgent` 填清楚。认不出一律 undefined,不猜。
 */
export function legacySessionOfJob(
  job: string,
  options: { withAgent: boolean },
): { agent?: string, sessionId: string } | undefined {
  if (!job.startsWith(SESSION_JOB_PREFIX)) return undefined
  const rest = job.slice(SESSION_JOB_PREFIX.length)
  // 新格式(带 `/`)不是老格式 —— 迁过的行再迁一次会把家名拼两遍。
  if (rest.includes(SESSION_JOB_SEP)) return undefined
  if (!options.withAgent) return rest === '' ? undefined : { sessionId: rest }
  const cut = rest.indexOf(':')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { agent: rest.slice(0, cut), sessionId: rest.slice(cut + 1) }
}

/** 哪几种状态算**收场**(办完 / 取消)。一处写:闸、早报、日志都照它。 */
export const SETTLED_TASK_STATUS: readonly string[] = ['done', 'canceled']

/** 判这个键要用到的那一点点卡面(不引 `protocol.ts` 那一整套,免得这一处成了新的接缝)。 */
export interface JobKeyTask {
  id: string
  status: string
  /** 派进别家窗口那一次(认出来的那条会话在这一格里;认不准时它缺席)。 */
  client_dispatch?: { family?: string, session_id?: string }
}

/** 这条会话归哪一件事(卡上 `client_dispatch` 认下的那条会话)。没有一张卡认领就 undefined。 */
export function itemOfSession(tasks: readonly JobKeyTask[], agent: string, sessionId: string): string | undefined {
  for (const task of tasks) {
    const sent = task.client_dispatch
    if (sent === undefined || sent.session_id === undefined) continue
    if (sent.session_id === sessionId && (sent.family === undefined || sent.family === agent)) return task.id
  }
  return undefined
}

/**
 * ★ **这个键此刻还动不动得**(动作闸的 `phaseOf` 就是它;见文件头 ②)。**纯函数**,
 * 查不出来的一律 `unknown`(= 放行),一个字都不编。
 */
export function jobPhaseOf(input: {
  job: string
  /** 看板上此刻那几张卡。 */
  tasks: readonly JobKeyTask[]
  /** 此刻认得出的那几条会话(文件型 + 窗口型登记表里那几条,与捎话候选池同一份)。 */
  sessions: readonly { agent: string, session_id: string }[]
}): JobPhase {
  const phaseOfTask = (task: JobKeyTask): JobPhase => (SETTLED_TASK_STATUS.includes(task.status) ? 'settled' : 'open')
  const own = input.tasks.find(one => one.id === input.job)
  if (own !== undefined) return phaseOfTask(own)
  const session = sessionOfJob(input.job)
  if (session === undefined) return 'unknown'
  const item = itemOfSession(input.tasks, session.agent, session.sessionId)
  if (item !== undefined) {
    const card = input.tasks.find(one => one.id === item)
    if (card !== undefined) return phaseOfTask(card)
  }
  if (input.sessions.some(one => one.agent === session.agent && one.session_id === session.sessionId)) return 'open'
  // 这一家的对话清单查得到、而这一条不在里面 —— 那条对话收场了(关掉了 / 认不出来了)。
  if (input.sessions.some(one => one.agent === session.agent)) return 'settled'
  // 连这一家的清单都没有(壳没连上、登记表还没扫到)—— 查不出,不许当收场。
  return 'unknown'
}
