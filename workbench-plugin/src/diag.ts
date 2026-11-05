/**
 * 诊断与上报的共用形状(2026-09-22,「诊断包与远程错误上报」)。
 *
 * **纯类型 + 纯函数,不 import 任何 node 内置** —— 客户端 bundle 会把它打进去
 * (同 server/setup/types.ts 那条规矩)。
 *
 * ## 这一版要解决的那个具体问题
 *
 * Ben 原话:「我弄了台新 Mac,到时候就是脱机运行了,报错信息和日志什么的得准备好,
 * 不然你修复和优化都很不方便。」—— 统筹不在那台机器前面,他也不走命令行
 * (docs/project-memory:用户环节不走命令行)。所以只有两条路能把现场传过来:
 *
 *   ① **他导出一个包**(设置 → 体检与修复 → 导出诊断包),微信发过来;
 *   ② **机器自己报**(出错时 POST 到中转,统筹在服务器上拉)。
 *
 * 两条路共用这个文件里的两样东西:**四类事件**与**那个短编号**。
 *
 * ## 短编号是给"念"用的
 *
 * 界面上出一句报错,同时显示一个 `WB-123456`。同一个编号会出现在:
 * 本机日志里那一行、上报到中转的那一条、诊断包里的那一行。
 * 于是 Ben 在电话里念六个数字,统筹就能在服务器上把那一条捞出来 ——
 * 这比让他描述"就是那个红字"可靠得多。
 *
 * 形状:`组件缩写 + '-' + 时间戳后 6 位`(十进制,不是十六进制 —— 念出来不会有
 * 「是字母 B 还是数字 8」这种麻烦)。后 6 位每 1,000,000 毫秒(约 16.7 分钟)绕一圈,
 * 够把"刚才那一下"跟"上午那一下"分开;它**不是主键**,库里的主键另有其人。
 */

/** 出错的是谁。与中转 `server/diag.cjs` 的 `DIAG_COMPONENTS` 一字不差 —— 两头对不上就落不了库。 */
export const DIAG_COMPONENTS = ['plugin', 'worker', 'butler', 'shell', 'client'] as const
export type DiagComponent = typeof DIAG_COMPONENTS[number]

export function isDiagComponent(value: unknown): value is DiagComponent {
  return typeof value === 'string' && (DIAG_COMPONENTS as readonly string[]).includes(value)
}

/**
 * 上报的种类。前四类是**机器自己报的错**(卡上那四句一一对应):
 * - `unhandled`      没人接的异常 / promise(插件、工人、语音后端)
 * - `crash_restart`  崩了又被拉起来(工人的看护链路、launchd 的 KeepAlive)
 * - `update_failed`  热更新失败
 * - `call_closed`    通话会话异常关闭
 *
 * 第五类是**人说的**(2026-09-28,卡 FB):
 * - `feedback`       本体的毛病由事务官整理成一条「反馈给开发者」发回来(判据 `src/productFeedback.ts`,落盘与发送 `server/diagnostics/feedback.ts`)。
 *   它走同一条通道(`POST /v1/diag/report`)、同一道脱敏、同一个限频,只是内容是她的原话 +
 *   事务官一句整理 + 当时的版本 / 模板 / 布局(`said`、`context` 两格)。
 */
export const DIAG_KINDS = ['unhandled', 'crash_restart', 'update_failed', 'call_closed', 'feedback'] as const
export type DiagKind = typeof DIAG_KINDS[number]

export function isDiagKind(value: unknown): value is DiagKind {
  return typeof value === 'string' && (DIAG_KINDS as readonly string[]).includes(value)
}

/** 人话标题。诊断包的清单与设置里那段说明都用它,免得两处各写一套。 */
export const DIAG_KIND_TITLES: Record<DiagKind, string> = {
  unhandled: '没人接的异常',
  crash_restart: '崩溃后被拉起来',
  update_failed: '更新失败',
  call_closed: '通话异常结束',
  feedback: '反馈给开发者',
}

export const DIAG_COMPONENT_TITLES: Record<DiagComponent, string> = {
  plugin: '工作台',
  worker: '通话工人',
  butler: '语音后端',
  shell: '壳 App',
  client: '网页界面',
}

/**
 * 组件缩写。**两个字母,全大写** —— 念出来最短,而且跟版本号里那些数字不会混。
 * 加新组件时这张表和上面那个闭集一起改(类型会逼你改)。
 */
export const DIAG_COMPONENT_ABBR: Record<DiagComponent, string> = {
  plugin: 'WB',
  worker: 'CW',
  butler: 'BS',
  shell: 'SH',
  client: 'UI',
}

/** 编号的形状。中转那边 `CODE_RE` 是同一条,改一处要改两处(用例各自钉着)。 */
export const DIAG_CODE_RE = /^[A-Z]{2,4}-[0-9]{6}$/

/**
 * 造一个编号。`atMs` 一律由调用方给(时钟注入,测试才断言得了) ——
 * 这里不调 `Date.now()`。
 *
 * 后 6 位不足 6 位时左补零:`WB-000042` 比 `WB-42` 好念,因为长度固定,
 * 念错一位对方立刻听得出来。
 */
export function diagCode(component: DiagComponent, atMs: number): string {
  const abbr = DIAG_COMPONENT_ABBR[component]
  const tail = Math.abs(Math.trunc(atMs)) % 1_000_000
  return `${abbr}-${String(tail).padStart(6, '0')}`
}

/** 上报到中转的那一条的形状(`POST /v1/diag/report` 的 body)。 */
export interface DiagReportBody {
  version: string
  component: DiagComponent
  kind: DiagKind
  /** 界面上显示的那个短编号。取不到就空串(中转那边会丢掉这一格,不会让整条失败)。 */
  code: string
  /** 一句报错,截断过。 */
  message: string
  /** 栈的**前** 20 行,路径里的用户名已经换掉。 */
  stack: readonly string[]
  /** 出事前后的**最后** 50 行日志,脱敏过。 */
  log: readonly string[]
  /** 设备上出事的时刻(ISO)。 */
  at: string
  /**
   * 这一条代表几次。正常是 1;这一小时报满 20 条之后,同样的(组件 + 种类 + 编号前缀)
   * 会被合并成一条,`merged` 就是被合并掉的次数 —— **信息不丢,只是不再一条条发**。
   */
  merged: number
  /**
   * 她的原话(2026-09-28,卡 FB;只有 `kind: 'feedback'` 那一类有)。脱敏过、截断过。
   * **不是对话全文** —— 只有触发这条反馈的那一句。
   */
  said?: string
  /** 当时的模板 / 布局那一行(「模板:自媒体运营;竖屏:项目区、发布计划…」)。同样只有反馈那一类有。 */
  context?: string
}

/** 「我反馈过的问题」里的一条(`GET /diag/feedback`)。 */
export interface FeedbackEntryView {
  id: string
  /** 念得出来的编号(与自动上报同一个形状)。 */
  code: string
  /** 记下这一条的时刻(ISO)。 */
  at: string
  /** 她的原话。**本机这一份没脱敏**(它就是她自己说的话),发出去的那一份擦过。 */
  said: string
  /** 事务官一句整理。 */
  note: string
  /** 命中的那一块(「发布计划」)。认不出缺席。 */
  ui?: string
  version: string
  /** 当时的模板 / 布局。 */
  context?: string
  /**
   * 状态。**不做工单**(卡 FB):
   * - `asking` 事务官拿不准,正等她回一句「改工作台本身 / 做个小工具」;
   * - `sent`   服务器收到了(界面上写「已收到」);
   * - `local`  没发出去(没登录 / 网断了 / 开关关着),只留在本机。`why` 里写为什么。
   */
  status: 'asking' | 'sent' | 'local'
  why?: string
}

export interface FeedbackListView {
  items: readonly FeedbackEntryView[]
  /** 已经发出去几条(界面上「发了几条」就是它)。 */
  sent: number
}

/** 设置里那颗开关的对外视图(`GET /diag/settings`)。 */
export interface DiagSettingsView {
  /** 「出错自动报告给开发者」。**默认开**,首次进体检页时明说一次(见下)。 */
  report_enabled: boolean
  /** 那段说明给他看过了没有(体检页据此决定要不要把它显著地摆出来)。 */
  notice_seen: boolean
  /** 报到哪儿去。没登录 / 没领令牌时缺席 —— 界面据此说「还没连上服务器,只会存在本机」。 */
  relay_url?: string
  /** 这一小时已经报了几条 / 上限几条。让他看得见"它没在偷偷刷"。 */
  sent_this_hour: number
  hourly_limit: number
}

/**
 * 「发诊断包」那一趟(2026-10-21,内测发版底座)。手机设置与电脑体检页上同一颗键:
 * 电脑打包(与「导出诊断包」同一份白名单与脱敏)→ 传到中转的存放位(7 天后自动删)→ 回六位编号。
 *
 * 是一条**作业**而不是一问一答:打包要读日志、跑 `log show`、压 zip,慢机器上几十秒,
 * 而手机出门时那条房间代理 15 秒就放弃。所以 `POST /diag/send` 起作业、立刻回;`GET /diag/send` 看最近一趟。
 *
 * 传不上去(没登录、出门且中转不通、中转拒了)时**包不丢**:挪到电脑桌面,`kept` 说在哪。
 */
export interface DiagSendView {
  id: string
  state: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  /** 传上去了:统筹拿它取包。六位,念出来、抄下来都不容易错(中转那边的字表)。 */
  code?: string
  /** 中转那边到哪一刻自动删(ISO)。 */
  expires_at?: string
  /** 包多大(字节)。 */
  bytes?: number
  /** 没传上去时人话说为什么。 */
  error?: string
  /** 没传上去、包留在电脑上了:在哪。`file` 给本机界面,`file_redacted` 给手机与聊天。 */
  kept?: { file: string, file_redacted: string, name: string }
}
