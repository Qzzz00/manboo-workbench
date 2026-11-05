/**
 * 一台假的 Mac(卡 Q「Agent 自动发现」的用例用):几个正在跑的 App、它们窗口的**模拟结构**、一个假的模型。
 *
 * 壳是假的(一扇真窗口都不碰),回包形状与 workbench-app/Sources/AgentWindow.swift 逐字段一致,
 * 且按真 helperChannel 的约定回:成了 resolve 的就是 result 本身。
 */
import type { HelperRequest } from '../../src/server/helperChannel.ts'

export interface FakeApp {
  bundle_id: string
  name: string
  /** 它包里 zh 那一份写的名字(豆包在英文系统上 name 是 Doubao)。 */
  name_zh?: string
  category?: string
  vendor?: string
  running: boolean
  active?: boolean
  /** 窗口结构(`agent_probe` 回的那一份,不含 running)。 */
  probe?: Record<string, unknown>
  /** 窗口此刻读出来的样子(`agent_read` 回的那一份,不含 running)。 */
  read?: () => Record<string, unknown>
  /**
   * 那棵树的**明细**(`agent_ax_detail` 回的那一份,2026-10-02 卡「适配自绘界面的 Kimi」)。
   * 缺席 = 这台机器上的壳不认这个 op(回「未知 op」)—— 老壳就是这个样子,服务端得吞得下。
   */
  ax_detail?: Record<string, unknown>
  /** 它图标的主色(壳的 `icon_colors` 回的那一格,`#rrggbb`)。缺席 = 取不到图标。 */
  icon?: string
  /**
   * 它的**整张图标**(壳的 `app_icon` 回的那一张;2026-09-26,卡 LG)。
   * `true` = 渲得出来(回 {@link FAKE_ICON_PNG});`'bad'` = 壳回了一串不是 PNG 的东西;缺席 = 渲不出。
   */
  logo?: true | 'bad'
  /** 装着没有(没开也算装着);缺席 = 装着。`icon_colors` / `app_icon` 只回装着的。 */
  installed?: boolean
}

/**
 * 一张真的(最小的)PNG:1×1 透明像素。卡 LG 的用例里壳回的就是它 ——
 * 要验的是「这一路通不通」,不是图好不好看,所以用一张字节数最少的真 PNG;
 * 头八个字节是真的 PNG 魔数(服务端 `isPng` 那道门认的就是它)。
 */
export const FAKE_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * ★ **自绘界面那一扇窗**(2026-10-02,卡「适配自绘界面的 Kimi」)。
 * 数照抄 Air 诊断包 20261002-193929 里官网版 Kimi `com.moonshot.kimichat.kmp.mac` 登录之后那一份:
 * 对话文字读得到(23 块静态文本、输入框上面 12 块),输入框与发送键都被画成了 `AXUnknown`。
 */
export function selfDrawnProbe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windows: 1, active: false, hidden: false,
    window: { w: 1200, h: 800, sheet: false, minimized: false },
    roles: { AXGroup: 4, AXScrollArea: 6, AXUnknown: 32, AXButton: 4, AXWindow: 1, AXScrollBar: 5, AXStaticText: 23 },
    inputs: [], send: [], stop: [],
    new_chat: { menu: [], buttons: [] },
    lists: [], left_links: 0,
    texts: { total: 23, left: 11, above_input: 12 },
    toolbar: [], menus: ['Kimi', '编辑'],
    visited: 75, capped: false, ms: 60, ax_manual: true,
    ...over,
  }
}

/** 一扇像对话窗口的窗的结构:左边一列会话、对话区、底下输入框 + 发送、菜单里有「新对话」。 */
export function chatProbe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windows: 1, active: false, hidden: false,
    window: { w: 1200, h: 800, sheet: false, minimized: false },
    inputs: [{ role: 'AXTextArea', settable: true, ph: '有问题,尽管问', x: 380, y: 700, w: 760, h: 60 }],
    send: [{ label: '发送', x: 1100, y: 720, w: 30, h: 30 }],
    stop: [],
    new_chat: { menu: ['新对话'], buttons: [] },
    lists: [], left_links: 12,
    texts: { total: 30, left: 12, above_input: 14 },
    toolbar: ['附加文件', '语音'],
    menus: ['文件', '编辑', '窗口', '帮助'],
    visited: 800, capped: false, ms: 40,
    ...over,
  }
}

/** 一扇对话窗口此刻读出来的样子。 */
export function chatRead(input: { busy?: boolean, answer: string, title?: string, active?: boolean, question?: string }): Record<string, unknown> {
  return {
    windows: 1, active: input.active === true, hidden: false,
    window: { w: 1200, h: 800, minimized: false },
    title: 'Foo AI',
    input: { x: 380, y: 700, w: 760, h: 60 },
    sidebar: { x: 0, y: 0, w: 300, h: 800 },
    stop: input.busy === true ? [{ x: 1100, y: 720, w: 30, h: 30 }] : [],
    tail: [
      { t: input.question ?? '帮我写一份周报', x: 700, y: 200, w: 300, h: 20 },
      { t: input.answer, x: 400, y: 300, w: 600, h: 60 },
      { t: '复制', x: 400, y: 370, w: 30, h: 20, ctl: true },
      { t: '10:42', x: 400, y: 390, w: 40, h: 16 },
    ],
    side: [
      { t: '今天', x: 20, y: 80, w: 200, h: 20 },
      { t: input.title ?? '周报怎么写', sel: true, x: 20, y: 110, w: 260, h: 30 },
      { t: '旅行计划', x: 20, y: 150, w: 260, h: 30 },
    ],
    visited: 300, capped: false, ms: 20,
  }
}

export function fakeShell(apps: FakeApp[], options: { caps?: string[], connected?: boolean } = {}) {
  const calls: HelperRequest[] = []
  const caps = new Set(options.caps ?? ['new_conversation', 'read_reply', 'agent_window'])
  let connected = options.connected ?? true
  const find = (bundleId: string): FakeApp | undefined => apps.find(one => one.bundle_id === bundleId)
  const helper = {
    connected: () => connected,
    supports: (cap: string) => caps.has(cap),
    request: async (req: HelperRequest): Promise<Record<string, unknown>> => {
      calls.push(req)
      if (req.op === 'running_apps') {
        return {
          apps: apps.filter(one => one.running).map(one => ({
            bundle_id: one.bundle_id, name: one.name, pid: 100, active: one.active === true, hidden: false, electron: false,
            ...(one.name_zh === undefined ? {} : { name_zh: one.name_zh }),
            ...(one.category === undefined ? {} : { category: one.category }),
            ...(one.vendor === undefined ? {} : { vendor: one.vendor }),
          })),
        }
      }
      if (req.op === 'icon_colors') {
        const colors: Record<string, string> = {}
        for (const bundleId of req.bundle_ids) {
          const app = find(bundleId)
          if (app !== undefined && app.installed !== false && app.icon !== undefined) colors[bundleId] = app.icon
        }
        return { colors }
      }
      if (req.op === 'app_icon') {
        // 卡 LG:整张图标。没装 / 渲不出的那一家明说 found:false(不是错误,界面退回色点)。
        const app = find(req.bundle_id)
        if (app === undefined || app.installed === false || app.logo === undefined) {
          return { found: false, why: app === undefined ? '这台电脑上没装这个应用' : '渲不出它的图标' }
        }
        const png = app.logo === 'bad' ? Buffer.from('这不是一张 PNG').toString('base64') : FAKE_ICON_PNG
        return { found: true, png, w: 128, h: 128, bytes: Buffer.from(png, 'base64').length }
      }
      if (req.op === 'agent_ax_detail') {
        // 老壳不认这个 op —— 夹具里不给 `ax_detail` 的那几家照旧抛「未知 op」(服务端必须吞得下)。
        const app = find(req.bundle_id)
        if (app?.ax_detail === undefined) throw new Error(`未知 op:${req.op}`)
        if (!app.running) return { running: false }
        return { running: true, ...app.ax_detail }
      }
      if (req.op === 'agent_probe' || req.op === 'agent_read') {
        const app = find(req.bundle_id)
        if (app === undefined || !app.running) return { running: false }
        if (req.op === 'agent_probe') return { running: true, ...(app.probe ?? { windows: 0 }) }
        return { running: true, ...(app.read?.() ?? { windows: 0 }) }
      }
      throw new Error(`未知 op:${req.op}`)
    },
  }
  return {
    helper,
    calls,
    apps,
    setConnected: (value: boolean) => { connected = value },
    /**
     * 碰过这一家窗口的请求(结构、内容、树的明细)。
     * 2026-10-02:`agent_ax_detail` **也算碰窗口** —— 不然「人跟人聊天的那几家一扇窗都不碰」
     * 那几条断言会漏掉这一条新路。
     */
    touched: (bundleId: string) => calls.filter(one =>
      (one.op === 'agent_probe' || one.op === 'agent_read' || one.op === 'agent_ax_detail') && one.bundle_id === bundleId),
    reads: (bundleId: string) => calls.filter(one => one.op === 'agent_read' && one.bundle_id === bundleId),
  }
}

/**
 * 假模型:按清单里的名字回类别。第一道(身份那一批)回数组,第二道(带界面字)回一个对象。
 * `verdicts` 里没有的名字答 unsure。
 *
 * ★ 2026-09-26(卡 QO):还有第三种问法 —— **开集的额度读法**问「这一扇窗上有没有这家自己的用量数字」。
 * `quota` 不给就答「这页上没看见用量」;给了就照它回。认的是那一段问话里的「这一扇窗上摘到的几段」
 * —— 前两道问话里没有这一句。
 */
export function fakeModel(
  verdicts: Record<string, 'ai_agent' | 'human_chat' | 'other' | 'unsure'>,
  second: Record<string, 'ai_agent' | 'human_chat' | 'other' | 'unsure'> = {},
  quota: ((prompt: string) => string) | string = '{"kind":"none","reason":"假模型:这页上没看见用量"}',
) {
  const prompts: string[] = []
  const judge = async (prompt: string): Promise<string> => {
    prompts.push(prompt)
    if (prompt.includes('这一扇窗上摘到的几段')) return typeof quota === 'string' ? quota : quota(prompt)
    if (prompt.includes('App 清单')) {
      const rows = prompt.split('\n').filter(line => /^\d+\|/.test(line))
      const out = rows.map((row) => {
        const [n, name] = row.split('|')
        return { n: Number(n), kind: verdicts[name ?? ''] ?? 'unsure', reason: `假模型:${name}` }
      })
      return `好的\n${JSON.stringify(out)}`
    }
    const name = /名字:([^;]+);/.exec(prompt)?.[1] ?? ''
    return JSON.stringify({ kind: second[name] ?? 'unsure', reason: `假模型带界面字:${name}` })
  }
  return { judge, prompts }
}
