/**
 * 整版样张的夹具:一台「用了一阵子」的产品研发布局。数全是编的,不读 8791、不读任何真账。
 * 消耗 / 额度 / 日结三样与 dev/fig-sample(数字格换画法)那份夹具同一套数,两张卡的样张能对得上。
 */
import type {
  AgentQuotaView, ButlerInboxItem, DailyReport, QuotaEntry, SessionView, TaskView, UsageDay, UsageState, UsageTotals,
  WorkbenchProject, WorkbenchState,
} from '../../src/protocol.ts'

export const NOW = '2026-10-21T09:42:00+08:00'

function lcg(seed: number): () => number {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
}
const rnd = lcg(20261021)
const zero = (): UsageTotals => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
function totals(scale: number): UsageTotals {
  return { input: Math.round(scale * 0.04 * rnd()), output: Math.round(scale * 0.06 * (0.4 + rnd())), cache_read: Math.round(scale * 6 * rnd()), cache_write: Math.round(scale * (0.3 + rnd())) }
}
function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { input: a.input + b.input, output: a.output + b.output, cache_read: a.cache_read + b.cache_read, cache_write: a.cache_write + b.cache_write }
}
const DAYS: UsageDay[] = []
for (let back = 29; back >= 0; back -= 1) {
  const at = new Date(Date.UTC(2026, 9, 21 - back))
  const date = at.toISOString().slice(0, 10)
  const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6
  const by_source: Record<string, UsageTotals> = {}
  if (date !== '2026-10-05') {
    if (rnd() < (weekend ? 0.5 : 0.95)) by_source.claude = totals(weekend ? 2.5e6 : 8e6)
    if (rnd() < 0.8) by_source.codex = totals(5e6)
    if (rnd() < 0.7) by_source.dsh = totals(2e6)
    if (rnd() < 0.35) by_source.kimi = { ...zero(), output: Math.round(3e5 * (0.3 + rnd())) }
  }
  const all = Object.values(by_source).reduce(add, zero())
  const half = { input: Math.round(all.input / 2), output: Math.round(all.output / 2), cache_read: Math.round(all.cache_read / 2), cache_write: Math.round(all.cache_write / 2) }
  const rest = { input: all.input - half.input, output: all.output - half.output, cache_read: all.cache_read - half.cache_read, cache_write: all.cache_write - half.cache_write }
  const any = Object.keys(by_source).length > 0
  DAYS.push({
    date,
    by_source,
    by_project: any ? { 'desktop-workbench': half, lapis: rest } : {},
    by_model: any ? { 'claude-opus-5-5': half, 'gpt-5.5-codex': rest } : {},
    sessions: Object.keys(by_source).length * 3,
    messages: Object.keys(by_source).length * 41,
    hour_counts: { 10: 12, 15: 20, 21: 9 },
  })
}
export const USAGE: UsageState = {
  days: DAYS,
  sources: { claude: { status: 'ok' }, codex: { status: 'ok' }, dsh: { status: 'ok' }, kimi: { status: 'partial', note: '只有输出 token' } },
  scanned_at: NOW,
  timezone: 'Asia/Shanghai',
}

export const QUOTA: Partial<Record<'dsh' | 'claude' | 'codex' | 'kimi', QuotaEntry>> = {
  dsh: { kind: 'balance', currency: 'CNY', total: '218.40', available: true, as_of: NOW },
  claude: { kind: 'quota', as_of: NOW, windows: [{ label: '5h', left_pct: 62, reset_at: '2026-10-21T14:10:00+08:00' }, { label: '周', left_pct: 18, reset_at: '2026-10-24T09:00:00+08:00' }] },
  codex: { kind: 'quota', as_of: NOW, windows: [{ label: '5h', left_pct: 91 }, { label: '周', left_pct: 47 }] },
  kimi: { kind: 'quota', as_of: NOW, windows: [{ label: '总', left_pct: 0 }] },
}
/**
 * 老四格之外那几家 = 维护者 10-21 截给统筹的那一幕:四家都「读不到最新的,上次 10-03 22:52」,
 * 每家一整行、条是空的。形状照 server/agentQuota.ts `dated()` 过线那一档:数全摘掉、`stale: true`、
 * `short` 是那一句、`line` 后面跟来源声明的话(从窗口上读的这几家今天没有)。
 */
const STALE_AT = '2026-10-03T22:52:00+08:00'
const STALE_WORDS = '读不到最新的,上次 10-03 22:52'
const stale = (id: string, title: string): AgentQuotaView =>
  ({ id, title, state: 'numbers', line: STALE_WORDS, short: STALE_WORDS, read_at: STALE_AT, stale: true }) as AgentQuotaView
export const AGENT_QUOTA: AgentQuotaView[] = [
  stale('muse', 'Muse'),
  stale('doubao', '豆包办公'),
  stale('manus', 'Manus'),
  stale('grok', 'Grok Bot'),
]

export const DAILY: DailyReport = {
  date: '2026-10-20',
  generated_at: '2026-10-21T09:00:12+08:00',
  progress: ['desktop-workbench:14 次提交 · 用量 12.3M(入+出)', 'workbench-site:2 次提交', 'lapis:用量 1.2M(入+出)'],
  missing: ['aiboo:零提交零用量', 'notes-cli:零提交零用量'],
  ideas: ['座机挂机时把最后一句话转成待办'],
  proposals: ['提议系统(M5)未上线,本节暂空'],
  deepseek_spend: { total: '3.20', peak: '2.10', offpeak: '0.90' },
}

const at = (hm: string, day = '21'): string => `2026-10-${day}T${hm}:00+08:00`

const PROJECTS: WorkbenchProject[] = [
  {
    id: 'desktop-workbench', name: 'desktop-workbench', stage: 'MVP 验证', path: '~/Documents/GitHub/desktop-workbench',
    signals: { branch: 'main', dirty_count: 3, worktrees: 6, cleanup_count: 2, last_commit_at: at('09:12'), idle_days: 0, recent_commits: 14 },
    status: { text: '0.4.140 已发;可读性打磨在做', review: 'confirmed', author: 'ben', updated_at: at('09:30'), stale: false },
    ddl: { date: '2026-10-31', title: '交接给工程师' },
    risk: { level: 'tight', reason: '剩 9 件,近 7 天完成 6 件', window_days: 7, done_recent: 6, remaining: 9 },
    links: [], session_count: 3, idle: false, confirmed: true,
  },
  {
    id: 'lapis', name: 'lapis', stage: 'MVP 开发', path: '~/Documents/GitHub/lapis',
    signals: { branch: 'feat/login', dirty_count: 0, worktrees: 1, cleanup_count: 0, last_commit_at: at('18:40', '20'), idle_days: 0, recent_commits: 4 },
    status: { text: '登录页改版等你验收', review: 'suggested', author: 'butler', updated_at: at('08:50'), stale: false },
    links: [], session_count: 1, idle: false, confirmed: true,
  },
  {
    id: 'workbench-site', name: 'workbench-site', stage: 'MVP 验证', path: '~/Documents/GitHub/workbench-site',
    signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, last_commit_at: at('16:02', '20'), idle_days: 1, recent_commits: 2 },
    links: [], session_count: 0, idle: false, confirmed: true,
  },
  {
    id: 'aiboo', name: 'aiboo', stage: '待整理', path: '~/Documents/GitHub/Aiboo',
    signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, last_commit_at: at('11:00', '02'), idle_days: 19 },
    links: [], session_count: 0, idle: true, confirmed: true,
  },
]

function task(over: Partial<TaskView> & Pick<TaskView, 'id' | 'title' | 'status'>): TaskView {
  return { direction: 'mine', source: { kind: 'manual' }, created_at: at('08:00', '20'), updated_at: at('09:00'), ...over } as TaskView
}
const TASKS: TaskView[] = [
  task({ id: 't1', title: '工作台可读性打磨', status: 'doing', project_id: 'desktop-workbench', assignee: 'claude', links: [{ agent: 'claude', session_id: 'cl-1' }] }),
  task({ id: 't2', title: '数字格换画法 · 甲版接线', status: 'doing', project_id: 'desktop-workbench', assignee: 'claude', links: [{ agent: 'claude', session_id: 'cl-2' }] }),
  task({ id: 't3', title: '登录页改版', status: 'confirm', project_id: 'lapis', assignee: 'codex', links: [{ agent: 'codex', session_id: 'cx-1' }] }),
  task({ id: 't4', title: '导出 CSV', status: 'todo', project_id: 'lapis', assignee: 'codex' }),
  task({ id: 't5', title: '官网首屏换图', status: 'todo', project_id: 'workbench-site' }),
  task({ id: 't6', title: '会后待办建事项真机验', status: 'blocked', project_id: 'desktop-workbench', block_reason: 'need_user' as never }),
  task({ id: 't7', title: '0.4.140 发版', status: 'done', project_id: 'desktop-workbench', updated_at: at('10:20', '21') }),
]

const SESSIONS: SessionView[] = [
  { agent: 'claude', session_id: 'cl-1', project: 'desktop-workbench', status: 'running', title: '工作台可读性打磨', elapsed_sec: 1820, unread: false, updated_at: NOW, activity: { line: '在逐格量字号和边距', at: at('09:40') } },
  { agent: 'claude', session_id: 'cl-2', project: 'desktop-workbench', status: 'running', title: '数字格换画法', elapsed_sec: 5400, unread: false, updated_at: NOW, activity: { line: '把甲版样式搬进 figStyle.ts', at: at('09:31') } },
  { agent: 'codex', session_id: 'cx-1', project: 'lapis', status: 'waiting', wait_reason: 'review' as never, title: '登录页改版', elapsed_sec: 3600, unread: true, updated_at: at('08:50'), activity: { line: '改完了,等你验收', at: at('08:50') } },
]

const INBOX_ITEMS: ButlerInboxItem[] = [
  { id: 'i1', kind: 'confirm', title: '登录页改版', note: 'Codex 做完了,等你验收', at: at('08:50'), task_id: 't3', status: 'confirm' },
  { id: 'i2', kind: 'risk', title: 'desktop-workbench 赶 10-31 有点紧', note: '剩 9 件,近 7 天完成 6 件', at: at('09:00') },
  { id: 'i3', kind: 'routine', title: '开工汇报', note: '昨天 3 个项目有推进,2 个没动静', at: at('09:00') },
]

export const STATE: WorkbenchState = {
  agents: [
    { id: 'dsh', online: true, connected: true, waiting: 0, running: 0 },
    { id: 'claude', online: true, connected: true, waiting: 0, running: 2 },
    { id: 'codex', online: true, connected: true, waiting: 1, running: 0 },
    { id: 'kimi', online: true, connected: false, waiting: 0, running: 0 },
  ],
  sessions: SESSIONS,
  quota: QUOTA,
  agent_quota: AGENT_QUOTA,
  now: NOW,
  stale: false,
  usage: USAGE,
  machine: { disk_pct: 71, disk_free_gb: 142, mem_gb: 11.4, cpu_idle_pct: 78, sampled_at: NOW },
  daily: DAILY,
  template: { id: 'product', name: '做产品', project_word: '项目', project_empty_line: '', module_titles: {}, board_lanes: [], has_backup: false },
  onboarding: { stage: 'done', done: true },
  projects: { projects: PROJECTS, pending: [], scan_errors: [], scanned_at: NOW },
  tasks: { tasks: TASKS, sprints: [], modules: [], project_meta: [] },
  butler_inbox: { items: INBOX_ITEMS, executing: 2 },
  notes: [
    { id: 'n1', text: '座机挂机时把最后一句话转成待办', created_at: at('22:10', '20') },
    { id: 'n2', text: '官网首屏换成新的听筒图', created_at: at('08:31') },
    { id: 'n3', text: '问一下工程师 relay 部署窗口', created_at: at('09:05') },
  ],
  files_pin: { pinned: true },
  helper: { connected: true, authorized: true },
  inbox: {
    items: [
      { path: '~/Downloads/登录页-v3.fig', name: '登录页-v3.fig', kind: 'file', size: 2_400_000, seen_at: at('08:40') },
      { path: '~/Downloads/会议录音-1020.m4a', name: '会议录音-1020.m4a', kind: 'file', size: 18_000_000, seen_at: at('18:20', '20') },
    ],
    since: at('00:00', '14'), backfilled: true,
  },
  dock: {
    stack: [
      { key: 'codex', label: 'Codex', running: true, current: false },
      { key: 'claude', label: 'Claude', running: true, current: false },
      { key: 'chrome', label: 'Chrome', running: true, current: false },
    ],
  },
  scenes: [{ id: 's1', name: '写代码', app_count: 3, saved_at: at('09:00', '18') }],
  // 首页「现在能做什么」与实验开关(2026-10-21 视觉 A 样张;编的)
  first_use: {
    order: ['morning', 'delegate', 'call'], call_mode: 'phone', day0: '2026-10-19',
    paths: [
      { path: 'morning', title: '早报与播客', state: 'ok', say: '', oks: 2, fails: 0, first_ok_at: at('08:00', '20'), ok_day: 2 },
      { path: 'delegate', title: '交代一件事', state: 'ok', say: '', oks: 5, fails: 0 },
      { path: 'call', title: '打电话', state: 'todo', say: '', oks: 0, fails: 0 },
    ],
  },
  experiments: { audience: 'internal', on: { video: false, meeting: true, handset: false, window_dispatch: true } },
} as unknown as WorkbenchState

/** 「它学到了什么」与「记住的规矩」(2026-10-21 视觉 A 样张;编的,不是任何人的记录)。 */
const habit = (id: string, status: 'trial' | 'kept' | 'removed', text: string, evidence: number, applied: number) => ({
  id, kind: 'dispatch', kind_title: '默认派给谁', text, status, applied,
  evidence: Array.from({ length: evidence }, (_, n) => ({ at: at('10:00', String(10 + n)), what: `第 ${n + 1} 次派给 Codex` })),
  adopted_at: at('10:00', '18'), updated_at: at('10:00', '20'),
})
export const HABITS = {
  trial: [habit('h1', 'trial', '写代码的活 · Lapis 这类事默认派给 Codex', 5, 2), habit('h2', 'trial', '晚上 10 点后不打电话,留到早报', 4, 1)],
  kept: [habit('h3', 'kept', '改稿先给三个标题再写正文', 3, 4)],
  retired: [habit('h4', 'removed', '每天 8 点早报', 2, 0)],
}
const rule = (id: string, title: string, text: string, status: string) => ({
  id, title, text, area: 'all', status, origin: 'said', evidence: [], editable: true, created_at: at('09:00', '12'), updated_at: at('09:00', '12'),
})
export const RULES = {
  rules: [rule('r1', '先给结论', '回报先说结论,再说过程。', 'active'), rule('r2', '不碰生产', '生产环境的改动先问我。', 'active'), rule('r3', '标题三选一', '写稿先给三个标题。', 'active')],
  retired: [rule('r4', '早报', '每天 8 点早报。', 'removed')],
  synced: { ok: true, at: at('09:00') },
}

/** 顶栏各家 logo(2026-10-21 视觉 A 样张):图标由 vite.config.mjs 从 Codex 评审页的 agent-icons 读;状态是编的。 */
const entry = (id: string, name: string, status: 'running' | 'waiting' | 'idle', running: boolean | undefined, self = false) => ({
  id, name, ...(self ? { self: true } : {}), icon: true, status, ...(running === undefined ? {} : { app_running: running }),
  found: { how: self ? 'self' : 'launch', at: at('08:00'), basis: '示例' }, sources: [], gaps: {}, sessions: [],
  counts: { running: status === 'running' ? 1 : 0, waiting: status === 'waiting' ? 1 : 0, unread: 0 },
})
export const AGENT_REGISTRY = {
  entries: [
    entry('dsh', '事务官', 'idle', undefined, true),
    entry('claude', 'Claude', 'running', true),
    entry('muse', 'Muse', 'idle', true),
    entry('codex', 'Codex', 'waiting', true),
    entry('manus', 'Manus', 'idle', false),
    entry('kimi', 'Kimi', 'idle', false),
    entry('doubao', '豆包办公', 'idle', false),
    entry('grok', 'Grok Bot', 'idle', false),
    entry('antigravity', 'Antigravity', 'idle', false),
    entry('qwen', '千问办公', 'idle', true),
  ],
  asking: [], notices: [],
}
