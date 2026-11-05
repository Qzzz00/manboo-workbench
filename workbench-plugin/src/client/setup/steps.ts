/**
 * 初始化页的**纯逻辑**(2026-09-17):九步怎么分、每步那盏灯是什么颜色、从哪儿进来。
 *
 * 全部是纯函数,一个 React、一个 fetch 都不碰 —— 灯的规则是这一页里最容易出错、
 * 也最该被用例钉死的东西(一盏说错的灯会让 Ben 以为装好了)。渲染在 SetupPage.tsx。
 */
import type { SetupInstallStep, SetupItem, SetupStatus } from '../../server/setup/types.ts'

/**
 * 一步一盏灯,四档(设计-电脑端登录台梳理 §三):
 * - `ok`    已就绪
 * - `busy`  程序在做(这一步底下有安装作业在跑)
 * - `click` 等你点一下(程序能代劳,只差你按那个按钮)
 * - `fill`  等你填(只有你能做:系统授权、密钥、装客户端)
 */
export type SetupLamp = 'ok' | 'busy' | 'click' | 'fill'

export const LAMP_LABELS: Record<SetupLamp, string> = {
  ok: '已就绪',
  busy: '程序在做',
  click: '等你点一下',
  fill: '等你填',
}

export interface SetupStepMeta {
  no: number
  title: string
  summary: string
}

/** 九步。顺序是 Ben 09-17 拍板过的(拍板⑤:顺序不变)。 */
export const SETUP_STEPS: readonly SetupStepMeta[] = [
  { no: 1, title: '就绪检查', summary: '自有 node、DSH 运行时、插件、启动脚本、开机自启、壳 App —— 缺的这里一键装。' },
  { no: 2, title: '仓库在哪', summary: '事务官在哪个仓库里干活、引导的记忆写进哪儿。不选它,引导整块不启用。' },
  { no: 3, title: '系统授权', summary: '辅助功能、文稿文件夹、日历。这三样只能你本人点,这里只把你送到那一页。' },
  { no: 4, title: '密钥与钩子', summary: 'DeepSeek 的 key 填一次写两处;Claude 的四个 hook 决定会话状态准不准。' },
  { no: 5, title: '客户端体检', summary: '装了哪家、没装哪家。没装也能用工作台,只是那一家整块「未接入」。' },
  { no: 6, title: '目录与例程', summary: '项目扫描根、收件箱盯的目录、例程时刻。' },
  { no: 7, title: '事务官', summary: '引导阶段、形象与音色、通道层。三盏灯各有各的去处。' },
  { no: 8, title: '手机', summary: '先确认手机端装了没有,再生成配对码。纯电脑用可以跳过。' },
  { no: 9, title: '收尾', summary: '把 Time Machine 打开。这是 09-04 家目录被删事故留下的唯一一条硬结论。' },
]

/** 安装步骤属于九步里的哪一步。界面靠它把「程序在做」那盏灯点在对的地方。 */
export const INSTALL_STEP_OF: Record<SetupInstallStep, number> = {
  node: 1,
  runtime: 1,
  profile: 1,
  plugin: 1,
  scripts: 1,
  launchd: 1,
  shell: 1,
  butler: 1,
  worker: 1,
  livekit: 1,
  restart: 1,
  web_login: 3,
}

export interface SetupStepView extends SetupStepMeta {
  items: readonly SetupItem[]
  lamp: SetupLamp
  /** 这一步里可选项还没弄的个数。灯照样绿,但界面要说一句。 */
  optionalPending: number
}

/**
 * 一步的灯。
 *
 * 优先级 `busy > click > fill > ok`,**而且 click 排在 fill 前面是有意的**:
 * 同一步里既有"程序能装的"又有"只能你做的"时,先让程序把能做的做完 —— 不然 Ben 会先
 * 跑去系统设置点授权,回来发现那个东西根本还没装上,白跑一趟。
 *
 * 可选项(没装微信、没发布事务官后端)**不点亮任何灯**:它们不该让这一步看起来没完成。
 */
export function lampOf(items: readonly SetupItem[], busy: boolean): SetupLamp {
  if (busy) return 'busy'
  const blocking = items.filter(item => item.optional !== true && item.state !== 'ok')
  if (blocking.some(item => item.state === 'missing' || item.state === 'stale')) return 'click'
  if (blocking.length > 0) return 'fill'
  return 'ok'
}

/**
 * 把体检结果摊成九步。
 *
 * 体检还没回来(`status === undefined`)时,前五步的灯一律 `busy` —— 那正是当时的事实
 * (程序在查),而不是"已就绪"。后四步没有体检项,灯由它们自己那几个按钮的状态决定,
 * 这里一律给 `fill`(等你点/填),因为它们都是只有 Ben 能做的事。
 */
export function groupSetupSteps(
  status: SetupStatus | undefined,
  runningInstallSteps: readonly SetupInstallStep[] = [],
): readonly SetupStepView[] {
  const busySteps = new Set(runningInstallSteps.map(step => INSTALL_STEP_OF[step]))
  return SETUP_STEPS.map((meta) => {
    const items = status === undefined ? [] : status.items.filter(item => item.step === meta.no)
    const busy = busySteps.has(meta.no)
    const hasChecks = items.length > 0
    const lamp: SetupLamp = busy
      ? 'busy'
      : status === undefined && meta.no <= 5
        ? 'busy'
        : hasChecks
          ? lampOf(items, false)
          : 'fill'
    return {
      ...meta,
      items,
      lamp,
      optionalPending: items.filter(item => item.optional === true && item.state !== 'ok').length,
    }
  })
}

/**
 * 从地址栏判断"要不要直接打开初始化页"。
 *
 * 两种写法都认:`?setup=1` 与 `#setup`。壳那边不改一行 —— 它只是加载同一个地址,
 * 自动打开由 `/state.setup_required` 驱动(见 Workbench.tsx)。
 */
export function setupRequestedIn(search: string, hash: string): boolean {
  try {
    if (new URLSearchParams(search).get('setup') === '1') return true
  }
  catch {
    // 地址栏里是什么怪东西都不该让页面挂掉。
  }
  return hash.replace(/^#/, '') === 'setup'
}

/** 一句总结,放在页头。**不四舍五入**:还差几项就说几项。 */
export function setupHeadline(status: SetupStatus | undefined): string {
  if (status === undefined) return '正在体检…'
  const blocking = status.items.filter(item => item.optional !== true && item.state !== 'ok')
  if (blocking.length === 0) {
    return status.optional_pending === 0
      ? '全都就绪了。'
      : `要紧的都就绪了;另有 ${status.optional_pending} 项可选的没弄(不影响用)。`
  }
  return `还差 ${blocking.length} 项${status.optional_pending === 0 ? '' : `(另有 ${status.optional_pending} 项可选的)`}。`
}
