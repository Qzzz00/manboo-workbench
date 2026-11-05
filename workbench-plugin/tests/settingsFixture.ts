/**
 * 设置六组的一整份假回包(2026-10-22,新 UI 第二轮 · 设置六组)。用例与样张页(`dev/readability-sample/settings.tsx`)共用:
 * 每条路都答一份形状对的,让每一节都真的渲染出来。数全是编的;文字尽量取评审页同一处的示例,对照截图时一眼认得出。
 */
import { DEFAULT_WORK_TYPES, DISPATCH_PREFS_DEFAULT, type ButlerRuleView, type ButlerRulesView, type HabitView, type HabitsView } from '../src/protocol.ts'

const at = (day: string, time: string): string => new Date(`2026-${day}T${time}:00`).toISOString()

export function rule(id: string, text: string, over: Partial<ButlerRuleView> = {}): ButlerRuleView {
  return {
    id, text, title: text, area: 'all', status: 'active', origin: 'said',
    evidence: [{ channel: 'settings', at: at('10-21', '09:12'), text }],
    created_at: at('10-21', '09:12'), updated_at: at('10-21', '09:12'), editable: true, ...over,
  }
}

export const RULES_VIEW: ButlerRulesView = {
  rules: [
    rule('r1', '交回工作前,先说明检查结果', { area: 'review' }),
    rule('r2', '先给结论,再说原因', { area: 'say', evidence: [{ channel: 'call', at: at('10-20', '16:40'), text: '先给结论' }] }),
    rule('r3', '涉及花钱的操作,先让我确认', { evidence: [{ channel: 'settings', at: at('10-19', '10:08'), text: '花钱先问' }] }),
  ],
  retired: [rule('r4', '例行进展每次都提醒', { status: 'removed' })],
}

export function habit(id: string, text: string, over: Partial<HabitView> = {}): HabitView {
  return {
    id, kind: 'dispatch', kind_title: '默认派给谁', text, status: 'trial',
    evidence: [], applied: 0, adopted_at: at('10-18', '10:00'), updated_at: at('10-21', '10:00'), ...over,
  }
}

const seen = (n: number): HabitView['evidence'] => Array.from({ length: n }, (_, i) => ({ at: at('10-1' + String(i % 9), '09:00'), what: `第 ${i + 1} 次派给 Codex` }))

export const HABITS_VIEW: HabitsView = {
  trial: [
    habit('h1', '界面修改,先交给常用的那一家', { evidence: seen(6), applied: 3 }),
    habit('h2', '例行进展,在你常查看工作的时段说', { kind: 'quiet', kind_title: '什么时候说', evidence: seen(4), applied: 1 }),
  ],
  kept: [],
  retired: [habit('h3', '早报七点就发', { status: 'removed', evidence: seen(2) })],
}

export const PROMPTS_VIEW = {
  file: '/Users/example/.dsh/AGENTS.md',
  note: '这里写的是你的意思。',
  outside: '',
  basics: [
    { name: '它叫什么', title: '它叫什么', note: '它怎么自称。', example: '比如:小事', body: '事务官', present: true, editable: true, overridden: false, default_changed: false, can_undo: false },
    { name: '怎么称呼你', title: '怎么称呼你', note: '它怎么叫你。', example: '比如:老板', body: '按你填写的称呼', present: true, editable: true, overridden: false, default_changed: false, can_undo: false },
    { name: '说话方式', title: '说话方式', note: '说长还是说短。', example: '比如:短一点', body: '先给结论,必要时再展开', present: true, editable: true, overridden: true, default_changed: false, can_undo: true },
  ],
  stages: [
    { name: '运营-选题', title: '选题', note: '选题怎么挑。', example: '比如:先看数据', lines: ['先看上周数据'], present: true, can_undo: false },
    { name: '派活', title: '派活', note: '派给谁。', example: '比如:写代码给 Codex', lines: [], present: true, can_undo: false },
    { name: '交回检查', title: '交回检查', note: '交回来先查什么。', example: '比如:先报检查结果', lines: ['先报检查结果,再说明需要确认的地方。'], present: true, can_undo: false },
  ],
  manual: [
    { name: '运营-发布包装', title: '运营-发布包装', note: '步骤说明。', body: '三组备选', present: true, editable: false, overridden: false, default_changed: false, can_undo: false },
  ],
}

export const CAPS_VIEW = {
  line: '两家能改本机文件。',
  checked_at: at('10-22', '09:30'),
  agents: [
    { family: 'claude', title: 'Claude', installed: true, cells: { chat: { state: 'ok', note: '能聊' }, edit: { state: 'ok', note: '能改本机文件' }, collect: { state: 'ok', note: '收得回来' } } },
    { family: 'codex', title: 'Codex', installed: true, cells: { chat: { state: 'ok', note: '能聊' }, edit: { state: 'ok', note: '能改本机文件' }, collect: { state: 'ok', note: '收得回来' } } },
    {
      family: 'kimi', title: 'Kimi', installed: true,
      cells: {
        chat: { state: 'ok', note: '能聊' },
        edit: { state: 'no', note: '改不了本机文件', fix: { kind: 'grant_ax', family: 'kimi', label: '去授权', hint: '只在网页里聊' } },
        collect: { state: 'ok', note: '收得回来' },
      },
    },
  ],
}

export const PATHS_VIEW = {
  scan_roots: null, inbox_dirs: null, butler_cwd: '/Users/example/事务官资料',
  defaults: { scan_roots: [{ path: '~/项目资料', depth: 1 }], inbox_dirs: ['~/收件箱'] },
  effective: { scan_roots: [{ path: '~/项目资料', depth: 1 }], inbox_dirs: ['~/收件箱'], butler_cwd: '/Users/example/事务官资料', butler_cwd_source: 'app.json' },
}

export const TEMPLATE_VIEW = {
  current: 'base', template: 'base', has_backup: true, last_backup_at: '10-20 21:14',
  templates: [
    { id: 'base', name: '产品研发', tagline: '项目、会话与常用组件', current: true, project_word: '项目', apps: [], board_lanes: [] },
    { id: 'ops', name: '内容创作', tagline: '选题、素材与发布安排', current: false, project_word: '选题', apps: [], board_lanes: [] },
  ],
}

export const USER_LAYER_VIEW = {
  dir: '/Users/example/.dsh/workbench/用户层', web_widgets_dir: '/Users/example/.dsh/workbench/用户层/网页小组件',
  slots: [{ id: 'todo', name: '今天的待办' }],
  widgets: [{ id: 'w1', name: '我的待办', replaces: 'todo', author: '运营同学', status: 'ok' }],
  plugins: [{ id: 'p1', order: 1, name: '采集器', where: 'built-in', note: '小红书笔记与评论' }],
}

/** 每条路都答一份;`posts` 记下每一次非 GET。 */
export function settingsFetch(over: Record<string, unknown> = {}): { fetchImpl: typeof fetch, posts: { url: string, body: unknown }[] } {
  const posts: { url: string, body: unknown }[] = []
  const answer = (url: string): unknown => {
    for (const [key, value] of Object.entries(over)) if (url.includes(key)) return value
    if (url.includes('/butler/rules')) return RULES_VIEW
    if (url.includes('/habits')) return HABITS_VIEW
    if (url.includes('/evolve/log')) return { text: '## 10-21 界面修改先交给 Codex\n- **留下**:三次都没纠正\n' }
    if (url.includes('/butler/prompts')) return PROMPTS_VIEW
    if (url.includes('/agents/caps')) return CAPS_VIEW
    if (url.includes('/agents/quota')) return { agents: [] }
    if (url.includes('/butler/budget')) return { cny: 3, minutes: 20 }
    if (url.includes('/token/personal')) return { tokens: [{ id: 't1', purpose: '本机脚本', hint: 'wbp_3f2a', created_at: at('10-20', '10:00') }] }
    if (url.includes('/model')) return { mode: 'relay', ready: true, relay_token_configured: true, own_key_configured: false }
    if (url.includes('/quota/connect/claude')) return { state: 'idle', message: '' }
    if (url.includes('/credentials')) return { deepseek: { configured: true }, kimi_web: { configured: false }, claude_api: { configured: true } }
    if (url.includes('/login')) return { state: 'idle' }
    if (url.includes('/shell/system-awake')) return { enabled: true }
    if (url.includes('/shell/away-keep-awake')) return { enabled: false }
    if (url.includes('/config/paths')) return PATHS_VIEW
    if (url.includes('/config/ops-skills')) return { file: '~/AGENTS.md', template: 'base', attached: { ok: true, attached: [], expected: [], absent: [], stray: [] } }
    // 派活与办完提醒(2026-10-23,分层二刀一):真实 DispatchPrefsView 形状,节才渲染得出来。
    if (url.includes('/dispatch/prefs')) return DISPATCH_PREFS_DEFAULT
    if (url.includes('/template')) return TEMPLATE_VIEW
    if (url.includes('/user-layer')) return USER_LAYER_VIEW
    if (url.includes('/modules')) return { modules: [{ id: 'm1', name: '本周数据' }], trash: [{ id: 'm2', name: '旧的看板' }] }
    if (url.includes('/update/check')) return { current: '0.4.150', latest: '0.4.150' }
    if (url.includes('/account/devices')) return { devices: [] }
    if (url.includes('/collab/types')) return { scope: 'local', types: DEFAULT_WORK_TYPES }
    return {}
  }
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method !== undefined && init.method !== 'GET') {
      posts.push({ url, body: typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) as unknown : undefined })
      const sent = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) as Record<string, unknown> : {}
      const body = url.includes('/habits/') ? { ok: true, note: '撤掉了。' } : url.includes('/collab/types') ? { ok: true, scope: 'local', types: sent.types } : { ok: true }
      return { ok: true, status: 200, json: async () => body }
    }
    return { ok: true, status: 200, json: async () => answer(url) }
  }) as unknown as typeof fetch
  return { fetchImpl, posts }
}

export const SETTINGS_PROPS = {
  peak: { phase: 'peak' as const, next_phase: 'offpeak' as const, next_switch: '18:00', periods: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
  currentVersion: '0.4.150',
  butler: { running: true, port: 8792, avatarCount: 2, voiceCount: 3 },
  meetings: { dir: '/Users/example/事务官资料/会议' },
  connector: { phase: 'ready' as const, installed: true, running: true, port: 7601, version: '1.0.0', downloadBytes: 0, hosts: [] },
  devices: {
    lan: { enabled: true, host: '192.168.1.8', port: 8791, advertising: true },
    devices: [
      { id: 'd1', name: '我的手机', platform: 'android', kind: 'phone' as const, last_seen_at: at('10-22', '12:21'), created_at: at('10-01', '10:00') },
      { id: 'd2', name: '桌上听筒', platform: 'raspberrypi', kind: 'handset' as const, last_seen_at: at('10-22', '12:20'), created_at: at('10-01', '10:00') },
    ],
  },
  account: { username: '本机维护者', registered: true, logged_in: true },
  todayView: 'by_date' as const,
  experiments: { audience: 'internal' as const, on: { video: true, meeting: true, handset: false, window_dispatch: false } },
}
