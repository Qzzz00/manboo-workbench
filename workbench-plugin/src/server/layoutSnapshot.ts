/**
 * 布局快照(2026-09-10,docs/设计-事务官记忆系统.md §一·五 第一族「工作台长什么样」)。
 *
 * 为什么要有这个文件:事务官改 UI 之前得先知道工作台现在长什么样,而这件事以前只能靠
 * 统筹会话手工读 `GET /state` 再手写一份 `docs/记忆/工作台-布局.md`(2026-09-10 那一版
 * 就是手写的)。手写每天都要重来一次,而且写错了没人拦。这里把「从 state 到那两份文件」
 * 变成一个纯函数 + 两条只读路由 + 一次落盘。
 *
 * 三条纪律:
 * - **纯函数不读时钟不读盘**:日期由入参给。固定 state 必须逐字得到同一份 markdown/html
 *   ——不然「今天和昨天的快照有没有变」这个问题永远答不了(diff 里全是噪声)。
 * - **HTML 只是骨架**:grid 里一个盒子代表一个模块,写着 id 与宽高占比,顶栏底栏各一条。
 *   它不是真实渲染,也不打算是——真实渲染要跑 React、要真实数据,那是工作台自己的事。
 *   文件里明写这一句,免得下一个会话拿它当界面真相。
 * - **拿不到就如实说**:没有 layout(没存过自定义布局)、没有场景、没有叠——都写一句
 *   人话,绝不拿默认布局顶替(D13:拿不到就留空,绝不编数)。
 *
 * 落盘那一半(createLayoutSnapshotService)是**请求驱动 + single-flight**:挂在 http.ts
 * 那根既有的 1 秒 tick 上,不新起定时器(同哨兵、同日结)。到「下班」时刻(可配置,默认
 * 18:30)且当天还没落过,才在后台生成一次;read() 只在真的要生成时才被调用,所以平时
 * 那一拍的代价是两次比较,不碰盘也不组装 state。
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DockTab, LayoutModule, SceneView, WorkbenchLayout, WorkbenchState } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import { groupLayoutRows } from '../layoutRows.ts'

/** 渲染一份快照要的那几块 state。字段名与 `GET /state` 一致,方便对着看。 */
export interface LayoutSnapshotInput {
  /** 快照日期 `YYYY-MM-DD`。纯函数不读时钟,这个日期由调用方给。 */
  date: string
  layout?: WorkbenchLayout
  dock?: { stack: readonly DockTab[] }
  apps?: readonly { key: string, label: string }[]
  scenes?: readonly SceneView[]
}

export interface LayoutSnapshot {
  markdown: string
  html: string
}

/**
 * 模块中文名。**与 client/Workbench.tsx 的 MODULE_TITLES 同一份文案**,但不能 import
 * 它——server 不 import client(先例见 daily.ts 里独立实现的 formatTokens)。改标题时
 * 两处一起改;这里认不出的 id 原样显示 id,不猜。
 */
const MODULE_LABELS: Record<string, string> = {
  projects: '项目区',
  usage: '消耗数据',
  quota: '余额 / 额度',
  slot: '窗口槽',
  notes: '随手记',
  files: '系统文件夹',
  // 2026-09-21(布局模板)新增的三个。这里写的是**默认**标题 —— 快照不跟着模板改口:
  // 它回答的是「工作台现在长什么样」,而模块本身的身份是 id,不是当下那个模板给它起的名字
  // (运营模板下 files 叫「素材管理」,但它还是那一格)。模板叫什么由快照里另一行说。
  todo: '待办事项',
  publish: '发布计划',
  review: '数据复盘',
}

function label(id: string): string {
  return MODULE_LABELS[id] ?? id
}

function num(value: number | undefined): string {
  return value === undefined ? '—' : String(value)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 分组成 行 → 列 → 模块:**与页面同一份函数**(src/layoutRows.ts;卡 P 补三起页面和这里都 import 它,
 * 以前是两份抄本)。规则不一致的话快照会描述出一个页面上并不存在的版面。
 */
export { groupLayoutRows } from '../layoutRows.ts'

export function sortedLayoutModules(layout: WorkbenchLayout): LayoutModule[] {
  return [...layout.modules].sort((left, right) => left.order - right.order)
}

function butlerLine(layout: WorkbenchLayout): string {
  const parts = [`角落 \`${layout.butler.corner}\``, `收起=${layout.butler.min ? '是' : '否'}`]
  const pos = layout.butler.pos
  if (pos !== undefined) parts.push(`拖到 ${pos.x_pct}% / ${pos.y_pct}%`)
  const size = layout.butler.size
  if (size !== undefined) parts.push(`尺寸 ${Math.round(size.w_px)}×${Math.round(size.h_px)} px`)
  else parts.push('尺寸没拉过(默认 250px 宽、高度随内容)')
  return `- 事务官浮窗:${parts.join(',')}`
}

function stackNames(stack: readonly DockTab[]): string {
  return stack.map(tab => tab.label).join(', ')
}

function dockSection(input: LayoutSnapshotInput): string[] {
  const stack = input.dock?.stack ?? []
  const out = ['## 窗口槽当前认领的应用(叠序 = 标签顺序)']
  if (stack.length === 0) {
    out.push('(叠是空的,一个应用都没认领)')
    return out
  }
  out.push(stackNames(stack), '')
  for (const tab of stack) {
    const marks = [
      tab.current ? '在台' : '在后台',
      tab.running ? '在跑' : '没在跑',
    ]
    if (tab.im !== undefined) marks.push(`IM=${tab.im}`)
    out.push(`- ${tab.label}${tab.dual === true ? '(双窗)' : ''}:${marks.join(' · ')}`)
  }
  return out
}

function scenesSection(scenes: readonly SceneView[] | undefined): string[] {
  const out = ['## 场景']
  if (scenes === undefined || scenes.length === 0) {
    out.push('(还没存过场景)')
    return out
  }
  for (const scene of scenes) {
    out.push(scene.app_count === 0
      ? `- ${scene.name}(还没存过内容)`
      : `- ${scene.name}(${scene.app_count} 个应用${scene.saved_at === undefined ? '' : `,存于 ${scene.saved_at}`})`)
  }
  return out
}

function rowsDescription(layout: WorkbenchLayout): string[] {
  const visible = sortedLayoutModules(layout).filter(module => module.hidden !== true)
  const rows = groupLayoutRows(visible)
  if (rows.length === 0) return ['所有模块都被收起了,页面上一个模块都没有。']
  const lines = [`页面自上而下分 ${rows.length} 行:`]
  rows.forEach((cols, index) => {
    const text = cols
      .map(col => col.map(module => label(module.id)).join(' + '))
      .join(' | ')
    lines.push(`- 第 ${index + 1} 行:${text}${cols.some(col => col.length > 1) ? '(用 + 连起来的是同一列里上下堆叠)' : ''}`)
  })
  return lines
}

function markdownOf(input: LayoutSnapshotInput): string {
  const out: string[] = [
    `# 工作台布局(快照 ${input.date},来源 GET /state,由工作台生成并每天覆盖)`,
    '',
    '> 这份文件回答「工作台现在长什么样」。改 UI 前先读它;它只描述现状,不含意图。',
    '',
  ]

  const layout = input.layout
  if (layout === undefined) {
    out.push(
      '## 模块与位置',
      '/state 里没有 layout——没存过自定义布局,界面用的是默认布局(见 client/layout.ts 的 DEFAULT_LAYOUT)。',
      '这里不拿默认值顶替:那样看起来像「量到的现状」,其实是抄的常量。',
      '',
    )
  }
  else {
    out.push(
      '## 模块与位置(页面自上而下按 order 排;行号相同且相邻的并排)',
      '',
      '| 模块 | 行 | 列 | 显示 | 宽% | 高% |',
      '|---|---|---|---|---|---|',
    )
    for (const module of sortedLayoutModules(layout)) {
      const cells = [
        `${label(module.id)} (\`${module.id}\`)`,
        num(module.row),
        num(module.col),
        module.hidden === true ? '收起' : '显示',
        num(module.width_pct),
        num(module.basis_pct),
      ]
      out.push(`| ${cells.join(' | ')} |`)
    }
    out.push('', ...rowsDescription(layout), '')
    out.push(
      `- 项目区视图:\`${layout.projects_view ?? 'overview'}\`(overview=总览 / board=看板)`,
      `- 看板列轴:\`${layout.board_axis ?? 'module-rows'}\`(module-rows=模块泳道 / module-columns=模块竖列 / status-columns=只按状态分列)`,
      `- 纯净模式:\`${layout.pureMode === true ? '开' : '关'}\`(开=整屏只有顶栏与一颗声纹球,上面这些模块只是不显示、不卸载;2026-09-11)`,
      butlerLine(layout),
      '',
    )
  }

  out.push(
    '## 顶栏与底栏(固定,不在 layout 里)',
    '- 顶栏:四家 agent 在线/掉线与在跑数、存储与性能读数、时钟、「学到的做法」、设置入口、「恢复布局」「返回对话」。',
    '- 底栏:日结条(昨日日报四段)。',
    '- 事务官浮窗:不可删、不可隐、必有叫停入口(PRD §9 不可改清单第 1 条)。',
    '',
    ...dockSection(input),
    '',
    '## 应用注册表(可认领的应用)',
    (input.apps ?? []).length === 0
      ? '(`/state.apps` 缺席:没接应用清单)'
      : (input.apps ?? []).map(app => app.label).join(', '),
    '',
    ...scenesSection(input.scenes),
    '',
    '## 字段来源',
    `- 快照日期:生成这份文件那一刻的本机日期(${input.date})。`,
    '- 模块表的 行/列/显示/宽%/高%:`/state.layout.modules` 的 `row`/`col`/`hidden`/`width_pct`/`basis_pct`;`—` 表示该字段缺省(不是 0)。',
    '- 行分组规则:与 `client/Workbench.tsx` 的 `moduleRows` 同一套(相邻且 row 相同才并排)。',
    '- 模块中文名:`client/Workbench.tsx` 的 `MODULE_TITLES`(server 侧同文案副本,见本文件顶部注释)。',
    '- 两个视图开关:`/state.layout` 的 `projects_view` / `board_axis`;纯净模式:`pureMode`(缺省 false)。',
    '- 事务官浮窗几何:`/state.layout.butler` 的 `corner` / `min` / `pos` / `size`。',
    '- 窗口槽叠:`/state.dock.stack`(叠序即标签顺序,`current` 是在台那一扇)。',
    '- 应用注册表:`/state.apps`。场景:`/state.scenes`。',
    '- 「每个模块里有什么」那一节不在这份快照里:它是人写的知识,不能从 `/state` 量出来,由事务官在 `docs/记忆/工作台-布局.md` 里自己维护。',
    '',
  )
  return `${out.join('\n')}`
}

function htmlOf(input: LayoutSnapshotInput): string {
  const head = [
    '<!doctype html><meta charset="utf-8">',
    `<title>工作台布局快照 ${escapeHtml(input.date)}</title>`,
    '<style>',
    'body{font:13px -apple-system,system-ui,sans-serif;background:#111;color:#ddd;margin:16px}',
    '.top,.foot{border:1px solid #444;border-radius:6px;padding:8px}',
    '.top{margin-bottom:8px}.foot{margin-top:8px}',
    '.grid{display:grid;gap:8px}.row{display:grid;gap:8px}.col{display:grid;gap:8px}',
    '.mod{border:1px solid #555;border-radius:6px;padding:10px;min-height:48px}',
    '.mod b{display:block}.mod small{color:#888}',
    '.note{color:#777}',
    '</style>',
    '<div class="top">顶栏:四家 agent 在线/掉线与在跑数 · 存储 · 性能 · 时钟 · 学到的做法 · 设置 · 恢复布局</div>',
  ]

  const body: string[] = []
  const layout = input.layout
  if (layout === undefined) {
    body.push('<div class="mod"><b>没有自定义布局</b><small>/state 里没有 layout,界面用默认布局;这里不拿默认值顶替。</small></div>')
  }
  else {
    const visible = sortedLayoutModules(layout).filter(module => module.hidden !== true)
    const rows = groupLayoutRows(visible)
    const rowHeight = (cols: LayoutModule[][]): number => Math.max(
      1,
      ...cols.map(col => col.reduce((sum, module) => sum + (module.basis_pct ?? 20), 0)),
    )
    body.push(`<div class="grid" style="grid-template-rows:${rows.map(cols => `${rowHeight(cols)}fr`).join(' ')}">`)
    for (const cols of rows) {
      // 一列独占的行按 1fr:同行的另一块被收起时,留着 60fr 会让人以为它只占 60% 宽,
      // 而界面上它是整行铺满的(width_pct 只在同行有邻居时才切宽)。
      const widths = cols.length === 1
        ? '1fr'
        : cols.map(col => `${col[0]?.width_pct ?? Math.round(100 / cols.length)}fr`).join(' ')
      body.push(`<div class="row" style="grid-template-columns:${widths}">`)
      for (const col of cols) {
        body.push('<div class="col">')
        for (const module of col) {
          const facts = [
            escapeHtml(module.id),
            module.width_pct === undefined ? '宽 整行' : `宽 ${module.width_pct}%`,
            `高 ${num(module.basis_pct)}%`,
            `行 ${num(module.row)}`,
            `列 ${num(module.col)}`,
          ]
          body.push(
            `<div class="mod" data-id='${escapeHtml(module.id)}'>`
            + `<b>${escapeHtml(label(module.id))}</b>`
            + `<small>${facts.join(' · ')}</small></div>`,
          )
        }
        body.push('</div>')
      }
      body.push('</div>')
    }
    body.push('</div>')
  }

  const hidden = layout === undefined
    ? []
    : sortedLayoutModules(layout).filter(module => module.hidden === true).map(module => label(module.id))
  const stack = input.dock?.stack ?? []
  const stackText = stack.length === 0 ? '(空)' : escapeHtml(stackNames(stack))
  const sceneText = (input.scenes ?? []).length === 0
    ? '(还没存过场景)'
    : escapeHtml((input.scenes ?? []).map(scene => scene.name).join('、'))
  const foot = [
    '<div class="foot">'
    + `窗口槽叠:${stackText}`
    + (hidden.length === 0 ? '' : ` | 已收起:${escapeHtml(hidden.join('、'))}`)
    + ` | 场景:${sceneText}`
    + ' | 日结条'
    + (layout === undefined ? '' : ` | 事务官浮窗(${escapeHtml(layout.butler.corner)}${layout.butler.min ? ',收起' : ''})`)
    + '</div>',
    `<p class="note">快照来源 GET /state,${escapeHtml(input.date)};<b>不是真实渲染</b>,只是骨架——一个盒子代表一个模块,宽高是 layout 里的占比。</p>`,
  ]
  return [...head, ...body, ...foot].join('\n')
}

/**
 * 纯函数:一份 state → 一份 markdown + 一份 html 骨架。
 * 不读时钟、不读盘、不抛——缺哪块就在文件里如实写一句。
 */
export function renderLayoutSnapshot(state: LayoutSnapshotInput): LayoutSnapshot {
  return { markdown: markdownOf(state), html: htmlOf(state) }
}

/**
 * 布局快照的入参:从一份 /state 里挑出「工作台长什么样」用得到的那四块。
 * 日期取 state.now(service 那份时钟,测试注入的假时钟才管得住),解析不出退回本机现在。
 * http.ts(每天落盘)与 routines.ts(下班例程覆盖记忆文件)共用这一份,两边挑的字段才不会漂。
 */
export function snapshotInputOf(state: WorkbenchState): LayoutSnapshotInput {
  const parsed = Date.parse(state.now)
  return {
    date: localDateStr(Number.isNaN(parsed) ? Date.now() : parsed),
    ...(state.layout === undefined ? {} : { layout: state.layout }),
    ...(state.dock === undefined ? {} : { dock: { stack: state.dock.stack } }),
    ...(state.apps === undefined ? {} : { apps: state.apps }),
    ...(state.scenes === undefined ? {} : { scenes: state.scenes }),
  }
}

/** —— 落盘那一半 —— */

export function defaultLayoutSnapshotsDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/snapshots`
}

export interface LayoutSnapshotServiceOptions {
  /** 落盘目录,默认 defaultLayoutSnapshotsDir()。 */
  dir: string
  /** 当前时刻(ms)。默认 Date.now——测试注入固定时钟。 */
  now?: () => number
  /**
   * 「下班」时刻,本机时区的 `HH:MM`,默认 18:30(Ben 的下班例程就在这个点)。
   * 认不出的值退回默认,不抛——配错一个字符串不该让工作台起不来。
   */
  offWorkAt?: string
  /** 保留多少天(含今天),默认 14。 */
  keepDays?: number
  /** 生成失败后的冷却时长(ms),默认 60 秒。测试传 0。 */
  failCooldownMs?: number
}

export interface LayoutSnapshotService {
  /**
   * 走一拍。挂在既有的 1 秒 tick 上,自己不起定时器。
   * `read` 只在**真的要生成**时才被调用——平时这一拍不组装 state、不碰盘。
   */
  pump(read: () => Promise<LayoutSnapshotInput>): void
}

/** `HH:MM` → 当天的分钟数。认不出回 undefined。 */
function parseHhmm(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

const DEFAULT_OFF_WORK = '18:30'

export function createLayoutSnapshotService(opts: LayoutSnapshotServiceOptions): LayoutSnapshotService {
  const now = opts.now ?? (() => Date.now())
  const keepDays = Math.max(1, opts.keepDays ?? 14)
  const failCooldownMs = opts.failCooldownMs ?? 60_000
  const offWorkMinutes = parseHhmm(opts.offWorkAt ?? DEFAULT_OFF_WORK)
    ?? 18 * 60 + 30

  /** 已经落过盘的那一天(内存);进程重启后靠 dirHasDate 把它捞回来。 */
  let doneDate: string | undefined
  let inFlight: Promise<void> | undefined
  let lastFailAt = 0

  function fileName(date: string, ext: 'md' | 'html'): string {
    return join(opts.dir, `layout-${date}.${ext}`)
  }

  /** 落过没:今天的 .md 在不在。重启后不重新生成靠这一条(同 daily.ts 读回落盘报告)。 */
  async function dirHasDate(date: string): Promise<boolean> {
    try {
      await readFile(fileName(date, 'md'), 'utf8')
      return true
    }
    catch {
      return false
    }
  }

  async function writeAtomic(path: string, text: string): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  }

  /** 清过期:只认自己那套文件名,别的文件一律不碰(目录是 ~/.dsh 下的,不是我们独占的)。 */
  async function prune(today: string): Promise<void> {
    const cutoff = localDateStr(Date.parse(`${today}T00:00:00`) - (keepDays - 1) * 86_400_000)
    let names: string[]
    try {
      names = await readdir(opts.dir)
    }
    catch {
      return // 目录还不存在(第一次生成之前)——没什么可清的。
    }
    for (const name of names) {
      const match = /^layout-(\d{4}-\d{2}-\d{2})\.(?:md|html)$/.exec(name)
      if (match === null) continue
      const date = match[1] as string
      if (date >= cutoff) continue
      try {
        await unlink(join(opts.dir, name))
      }
      catch {
        // 别人正好删掉了/权限不对:清不掉这一个不拦别的,也不拦生成。
      }
    }
  }

  async function generate(date: string, read: () => Promise<LayoutSnapshotInput>): Promise<void> {
    const state = await read()
    const snapshot = renderLayoutSnapshot({ ...state, date })
    await mkdir(opts.dir, { recursive: true })
    await writeAtomic(fileName(date, 'md'), snapshot.markdown)
    await writeAtomic(fileName(date, 'html'), snapshot.html)
    doneDate = date
    await prune(date)
  }

  return {
    pump(read: () => Promise<LayoutSnapshotInput>): void {
      if (inFlight !== undefined) return
      const nowMs = now()
      const today = localDateStr(nowMs)
      if (doneDate === today) return
      const at = new Date(nowMs)
      if (at.getHours() * 60 + at.getMinutes() < offWorkMinutes) return
      if (nowMs - lastFailAt < failCooldownMs) return
      // 到点了才碰盘:先看看是不是上一个进程已经落过今天这一份。
      inFlight = (async () => {
        if (await dirHasDate(today)) {
          doneDate = today
          return
        }
        await generate(today, read)
      })()
        .catch(() => { lastFailAt = now() }) // 这一拍作罢,冷却后再试(同 daily.ts)。
        .finally(() => { inFlight = undefined })
    },
  }
}
