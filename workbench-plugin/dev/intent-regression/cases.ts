/**
 * 回归集(`docs/回归集-事务官真实交代-2026-10-22至10-28.md`)里**电脑入口**的那几行,一行一条用例。
 *
 * 原话取自回归集与交接(`docs/交接-1027-Claude接手统筹.md` 09:30–13:30 那几节);原话只记了梗概(「?」或「…」截断)的
 * 标 `synopsis`,按梗概写全。预置板 `FIXTURE` 是那几天板上的真卡号与标题(名片 id 用替身,不带本机标识);
 * 每条用例可以藏掉「那一句之后才建出来的卡」(`hide`)、改回当时的标题(`patch`)、带上那一句之前的话(`says`)。
 *
 * 末尾 6 条是小K `t-7b0588ba` 那支(`tests/server-say-directives-1028.test.ts`)重放的 10 句里本表原来没有的那几句
 * (另 4 句 09:35 / 09:36 / 09:38 / 09:5x 本来就在表里),按统筹 10-28 要求并入。
 *
 * 电话与手机入口的行(A2,2026-10-28)在表末:10-22 电话那四句按 `call` 跑(普通来电每句都交 `/butler/say`,与电脑同一个中枢);
 * 回归集里手机那几行是捎话(走 `/sessions/relay`,不经理解中枢),这里改用电脑那几句换成 `phone` 入口各跑一遍,钉「三入口同中枢」。
 * 10-23 / 10-26 补话与 10-27 统筹四条路是 API / 统筹身份,不经一句话的理解,不在这里。
 * 10-27「电脑拍板『继续』×3」是费限暂停那张卡上的按钮(`/butler/item/budget`),不经一句话,也不在这里。
 */
import type { HubHand } from '../../src/server/hub/context.ts'
import type { Case } from './score.ts'

const K = 'agent:me:k1'
const G = 'agent:me:g1'

export const FIXTURE = {
  devMachine: true,
  hands: [
    { id: 'claude', title: 'Claude', family: 'claude', card: false, installed: true, login: 'no', quota: 'ok', quota_text: '本周还剩约 40%', running: 0, ok: true, code: true, recommended: true },
    { id: 'codex', title: 'Codex', family: 'codex', card: false, installed: true, login: 'yes', quota: 'empty', quota_text: 'usage limit,额度用完了', running: 0, ok: true, code: true },
    { id: 'kimi', title: 'Kimi', family: 'kimi', card: false, installed: true, login: 'yes', quota: 'ok', quota_text: '本周还剩约 56%', running: 2, ok: true, code: true },
    { id: K, title: '小K(重生版)', family: 'kimi', card: true, installed: true, login: 'yes', quota: 'ok', quota_text: '本周还剩约 56%', running: 2, ok: true, code: true, good_at: '工作台插件、TDD' },
    { id: G, title: '小G', family: 'codex', card: true, installed: true, login: 'yes', quota: 'empty', quota_text: 'usage limit,额度用完了', running: 0, ok: true, code: true },
  ] satisfies HubHand[],
  goals: [
    { id: 'g-fri1023', title: '周五(10-23)把仓库交接给研发', status: 'open', due: '2026-10-23' },
    { id: 'g-next1026', title: '下周:事务官派活机制收口', status: 'open', due: '2026-10-30' },
    { id: 'g-collab', title: '对话与协作优化', status: 'open' },
    { id: 'g-oss1102', title: '下下周(11-02 起)外部测试,初步开源', status: 'open', due: '2026-11-08' },
  ],
  tasks: [
    { id: 't-ea1e8702', title: '修手机 App 远程连回电脑时 LiveKit 重连竞态', status: 'blocked', assignee: G, dispatch: { family: 'codex', status: 'failed' }, minutesAgo: 8 },
    { id: 't-c323ffa6', title: '查工作台 8791 空转热点', status: 'doing', assignee: K, dispatch: { family: 'kimi', status: 'running' }, minutesAgo: 7 },
    { id: 't-a2240dc9', title: '从机制上修 dispatch-recovery-1027 偶发失败', status: 'doing', assignee: K, dispatch: { family: 'kimi', status: 'running' }, minutesAgo: 10 },
    { id: 't-7b0588ba', title: '按任务书把事务官的接续、卡号、改派和改目标状态从机制上修了', status: 'doing', assignee: K, dispatch: { family: 'kimi', status: 'running' }, minutesAgo: 20 },
    { id: 't-d7eeb2ff', title: '0.4.144 推热修通道', status: 'todo', goal_id: 'g-fri1023', minutesAgo: 3000 },
    { id: 't-b5bb5f33', title: '验收脚本加真手机一列', status: 'todo', goal_id: 'g-fri1023', minutesAgo: 3000 },
    { id: 't-a244fee0', title: '把 Kimi 的 token 用量接进消耗数据面板', status: 'todo', minutesAgo: 900 },
    { id: 't-382f7ee6', title: '系统文件夹小组件改成 Graphify 图谱', status: 'backlog', minutesAgo: 7000 },
    { id: 't-27ff0e35', title: '160 交付后的项目管理验收', status: 'blocked', assignee: 'codex', dispatch: { family: 'codex', status: 'failed' }, minutesAgo: 2000 },
    { id: 't-98ce35df', title: '8791 技能做成 MCP 服务端', status: 'todo', minutesAgo: 4000 },
    { id: 't-fbe68a38', title: '事务官窗「在跑的事项」与 /collab/runs 同源', status: 'confirm', assignee: K, minutesAgo: 200 },
    { id: 't-0961da52', title: '按任务书修派活智能体文件与起跑换手', status: 'doing', assignee: K, dispatch: { family: 'kimi', status: 'running' }, minutesAgo: 30 },
    { id: 't-7ba4acd2', title: '派发 done 卡一:捎话节流闸误拦', status: 'done', minutesAgo: 3000 },
    { id: 't-047a0a64', title: '派发 done 卡二:待排的卡不许被派出去', status: 'done', minutesAgo: 3000 },
  ],
  widgets: [
    { id: 'quick-note', name: '随手记', status: 'ok', replaces: 'quick_note' },
    { id: 'today-cards', name: '今天的待办', status: 'ok', replaces: 'today' },
  ],
}

export const CASES: Case[] = [
  {
    row: '10-23 09:19',
    entrance: 'desktop',
    synopsis: true,
    said: '把三件事排到『下周:事务官派活机制收口』目标下,都待排、研发类,写上验收:一、捎话自动叫醒统筹会话,验收是手机捎一句 30 秒内会话收到;二、派活前核额度,验收是额度 0 的名片不派并建议换人;三、事务官窗在跑的事项与 /collab/runs 同数。归小K,用 kimi --session 接着做。',
    expect: [[
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
    ]],
  },
  {
    row: '10-23 09:29(去掉家名那一次)',
    entrance: 'desktop',
    synopsis: true,
    said: '把三件事排到『下周:事务官派活机制收口』目标下,都待排、研发类,写上验收:一、捎话自动叫醒统筹会话;二、派活前核额度;三、事务官窗在跑的事项与 /collab/runs 同数。',
    expect: [[
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
      { name: 'note', goal_id: 'g-next1026', status: 'backlog' },
    ]],
  },
  {
    row: '10-23 09:35',
    entrance: 'desktop',
    said: `『系统文件夹小组件改成 Graphify 图谱』那张卡,负责人改成名片 ${K},挪到待办,现在就开工。`,
    expect: [[{ name: 'reassign', card_id: 't-382f7ee6', to: K }], [{ name: 'dispatch', card_id: 't-382f7ee6', to: K }]],
    allow: ['move_status'],
  },
  {
    row: '10-26 22:02',
    entrance: 'desktop',
    synopsis: true,
    said: '160安装后管理验收收口:把剩下的验收项逐项核完,状态回写到卡上。',
    expect: [[{ name: 'dispatch', card_id: 't-27ff0e35' }], [{ name: 'reassign', card_id: 't-27ff0e35' }], [{ name: 'supplement', card_id: 't-27ff0e35' }], [{ name: 'dispatch', fresh: true }]],
    ask_ok: true,
  },
  {
    row: '10-26 22:03',
    entrance: 'desktop',
    said: '请实际执行项目管理验收与状态回写。这是我委托的项目事务,不是向产品开发者提交反馈。',
    says: [{ said: '160安装后管理验收收口:把剩下的验收项逐项核完,状态回写到卡上。', commands: ['ask'], cards: ['t-27ff0e35'], minutesAgo: 1 }],
    expect: [[{ name: 'dispatch', card_id: 't-27ff0e35' }], [{ name: 'reassign', card_id: 't-27ff0e35' }], [{ name: 'supplement', card_id: 't-27ff0e35' }], [{ name: 'dispatch', fresh: true }]],
    ask_ok: true,
  },
  {
    row: '10-27 上午(机制重设计委托)',
    entrance: 'desktop',
    synopsis: true,
    said: '交给小K:按 docs/交接-1027-委托派发机制第一批.md 重设计派发机制并直接开工。背景:之前正常入口误派、Kimi 派发 409、管理会话预算暂停,Claude 通道也失败过。',
    files: ['docs/交接-1027-委托派发机制第一批.md'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-27 18:35',
    entrance: 'desktop',
    said: '交给小K把 Kimi 的 token 用量接进『消耗数据』面板,TDD,做到什么算完:面板上 Kimi 一行有六个模型的输入、输出与缓存数,与参考脚本复算一致。',
    hide: ['t-a244fee0'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-27 18:39',
    entrance: 'desktop',
    said: '刚才那件,派给名片『小K(重生版)』去做',
    says: [{ said: '交给小K把 Kimi 的 token 用量接进『消耗数据』面板,TDD,做到什么算完:面板上 Kimi 一行有六个模型的输入、输出与缓存数。', commands: ['dispatch'], cards: ['t-a244fee0'], minutesAgo: 4 }],
    expect: [[{ name: 'reassign', card_id: 't-a244fee0', to: K }], [{ name: 'dispatch', card_id: 't-a244fee0', to: K }]],
  },
  {
    row: '10-28 09:30',
    entrance: 'desktop',
    said: '让小K从机制上修 dispatch-recovery-1027 偶发失败',
    hide: ['t-a2240dc9', 't-7b0588ba', 't-ea1e8702', 't-c323ffa6'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 09:32',
    entrance: 'desktop',
    said: '让小G修手机 App LiveKit 重连竞态',
    hide: ['t-7b0588ba', 't-ea1e8702', 't-c323ffa6'],
    expect: [[{ name: 'dispatch', to: G, fresh: true }]],
  },
  {
    row: '10-28 09:33',
    entrance: 'desktop',
    said: '让小K查 8791 空转热点',
    hide: ['t-7b0588ba', 't-c323ffa6'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 09:35',
    entrance: 'desktop',
    said: '刚才手机 App 那件,小G 的额度用完了,改派给小K。',
    hide: ['t-7b0588ba'],
    says: [
      { said: '让小G修手机 App LiveKit 重连竞态', commands: ['dispatch'], cards: ['t-ea1e8702'], minutesAgo: 3 },
      { said: '让小K查 8791 空转热点', commands: ['dispatch'], cards: ['t-c323ffa6'], minutesAgo: 2 },
    ],
    expect: [[{ name: 'reassign', card_id: 't-ea1e8702', to: K }]],
  },
  {
    row: '10-28 09:36',
    entrance: 'desktop',
    said: '改错了:t-c323ffa6 的标题改回「查工作台 8791 空转热点」;t-ea1e8702 负责人换成小K、重新派出去。',
    hide: ['t-7b0588ba'],
    patch: [{ id: 't-c323ffa6', title: '手机 App 那件改派给小K' }],
    says: [
      { said: '让小K查 8791 空转热点', commands: ['dispatch'], cards: ['t-c323ffa6'], minutesAgo: 3 },
      { said: '刚才手机 App 那件,小G 的额度用完了,改派给小K。', commands: ['rename'], cards: ['t-c323ffa6'], minutesAgo: 1 },
    ],
    expect: [[{ name: 'rename', card_id: 't-c323ffa6' }, { name: 'reassign', card_id: 't-ea1e8702', to: K }]],
  },
  {
    row: '10-28 09:38',
    entrance: 'desktop',
    said: '把标题是「手机 App 那件改派给小K」的那张卡改名成「查工作台 8791 进程的空转热点」',
    hide: ['t-7b0588ba'],
    patch: [{ id: 't-c323ffa6', title: '手机 App 那件改派给小K' }],
    expect: [[{ name: 'rename', card_id: 't-c323ffa6' }]],
  },
  {
    row: '10-28 09:5x',
    entrance: 'desktop',
    said: '让小K把事务官窗里『在跑的事项』显示 0 的问题修了',
    hide: ['t-7b0588ba', 't-fbe68a38'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 09:59',
    entrance: 'desktop',
    synopsis: true,
    said: '让小K在 workbench-plugin 里改 ButlerInbox,把「在跑的事项」改读 /collab/runs 那一本账,补用例',
    hide: ['t-7b0588ba', 't-fbe68a38'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 10:00(a)',
    entrance: 'desktop',
    synopsis: true,
    said: '让小K在 dispatchChoice 加额度预检:点名的名片额度为 0 就不派,回话建议换人,补用例',
    hide: ['t-7b0588ba'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 10:00(b)',
    entrance: 'desktop',
    synopsis: true,
    said: '让小K把协作区目标页的目标状态做成能改的(达成 / 不要了),补用例',
    hide: ['t-7b0588ba'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 12:52',
    entrance: 'desktop',
    said: '把「周五(10-23)把仓库交接给研发」那个目标标成达成。',
    expect: [[{ name: 'goal_status', goal_id: 'g-fri1023', status: 'reached' }]],
  },
  {
    row: '10-28 13:00',
    entrance: 'desktop',
    said: '让小K按 docs/交接-1028-机制退修任务书-接续对题与改派语义.md 把事务官的接续、卡号、改派和改目标状态从机制上修了,补用例。',
    files: ['docs/交接-1028-机制退修任务书-接续对题与改派语义.md'],
    hide: ['t-7b0588ba'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
  {
    row: '10-28 13:03',
    entrance: 'desktop',
    said: '把卡 t-d7eeb2ff(「0.4.144 推热修通道…」那张)取消掉',
    expect: [[{ name: 'cancel', card_id: 't-d7eeb2ff' }], [{ name: 'move_status', card_id: 't-d7eeb2ff', status: 'canceled' }]],
  },
  {
    row: '10-28 13:16',
    entrance: 'desktop',
    synopsis: true,
    said: '给刚才派给小K那件补一句:任务书第 7 条改了,补话要先落到卡上、下一轮带上。',
    says: [
      { said: '让小K按 docs/交接-1028-机制退修任务书-接续对题与改派语义.md 把事务官的接续、卡号、改派和改目标状态从机制上修了,补用例。', commands: ['dispatch'], cards: ['t-7b0588ba'], minutesAgo: 16 },
      { said: '把卡 t-d7eeb2ff(「0.4.144 推热修通道…」那张)取消掉', commands: ['cancel'], cards: ['t-d7eeb2ff'], minutesAgo: 13 },
    ],
    expect: [[{ name: 'supplement', card_id: 't-7b0588ba' }]],
  },
  {
    row: '10-28 13:26',
    entrance: 'desktop',
    said: '随手记那一格的输入框提示语改成「记一笔,想到什么写什么」',
    expect: [[{ name: 'user_layer_fix' }]],
  },
  {
    row: '10-28 重放:对多张不猜',
    entrance: 'desktop',
    said: '刚才手机 App 那件改派给小K。',
    hide: ['t-7b0588ba'],
    add: [{ id: 't-5e1f0a11', title: '手机 App 首页离线排查', status: 'todo', minutesAgo: 1 }],
    says: [
      { said: '派给小G 修手机 App 远程连回电脑时 LiveKit 重连竞态', commands: ['dispatch'], cards: ['t-ea1e8702'], minutesAgo: 3 },
      { said: '记一下手机 App 首页离线排查', commands: ['note'], cards: ['t-5e1f0a11'], minutesAgo: 1 },
    ],
    expect: [[{ name: 'ask' }]],
    ask_ok: true,
  },
  {
    row: '10-28 重放:卡号不在板上',
    entrance: 'desktop',
    said: '把 t-deadbeef 改派给小K',
    expect: [[{ name: 'ask' }]],
    ask_ok: true,
  },
  {
    row: '10-28 重放:没点名的同款抱怨',
    entrance: 'desktop',
    said: '事务官窗里「在跑的事项」显示 0,修一下',
    hide: ['t-fbe68a38'],
    // 这台有源码(维护者机器):派给能改本机文件的手;没源码的机器上才是反馈。两样都算对。
    expect: [[{ name: 'dispatch', fresh: true }], [{ name: 'feedback' }]],
  },
  {
    row: '10-28 重放:目标重新打开',
    entrance: 'desktop',
    said: '把「周五(10-23)把仓库交接给研发」重新打开',
    goalStatus: [{ id: 'g-fri1023', status: 'reached' }],
    expect: [[{ name: 'goal_status', goal_id: 'g-fri1023', status: 'open' }]],
  },
  {
    row: '10-28 重放:目标改截止',
    entrance: 'desktop',
    said: '把「周五(10-23)把仓库交接给研发」改截止到 11 月 5 号',
    expect: [[{ name: 'goal_due', goal_id: 'g-fri1023' }]],
  },
  {
    row: '10-28 重放:目标不要了',
    entrance: 'desktop',
    said: '把「周五(10-23)把仓库交接给研发」不要了',
    expect: [[{ name: 'goal_status', goal_id: 'g-fri1023', status: 'dropped' }]],
  },
  // ——— 10-29 10:12(任务书「中枢派到窗口手不按发送」撞出来的两句)———
  {
    row: '10-29 10:12',
    entrance: 'desktop',
    said: 't-0961da52 补一句:把派发词里那条补话带上;顺带查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天',
    expect: [[{ name: 'supplement', card_id: 't-0961da52' }]],
  },
  {
    row: '10-29 10:12(中枢派活)',
    entrance: 'desktop',
    said: '查 t-7ba4acd2 和 t-047a0a64 为什么派发 done 了卡还挂在进行中一天,进仓库查根因',
    // 没点名:中枢不给 to、执行层只在能改本机文件的手里挑(10-29 统筹按提示词口径改;模型直接点小K也算对)。
    expect: [[{ name: 'dispatch', to: null, fresh: true }], [{ name: 'dispatch', to: K, fresh: true }]],
  },
  // ——— 电话(A2) ———
  {
    row: '10-22 上午 电话 建待办',
    entrance: 'call',
    said: '帮我建一个待办事项:周四下午给客户发样片',
    expect: [[{ name: 'note', status: 'todo' }]],
  },
  {
    row: '10-22 上午 电话 发给客户只记一笔',
    entrance: 'call',
    synopsis: true,
    said: '记一下,周四下午把样片发给客户',
    expect: [[{ name: 'note' }]],
  },
  {
    row: '10-22 上午 电话 换一句更长的',
    entrance: 'call',
    synopsis: true,
    said: '帮我建一个待办事项,周四下午给客户发样片,就是那条秋季穿搭的短片,发之前我要再看一眼',
    expect: [[{ name: 'note' }]],
  },
  {
    row: '10-22 14:35 电话',
    entrance: 'call',
    said: '好的,先放着,下午3点再提醒我。不要再发啦,哎呀我的妈。',
    expect: [[{ name: 'note' }]],
    allow: ['chat'],
  },
  // ——— 手机文字(A2):电脑那几句换成 phone 入口,同一个中枢 ———
  {
    row: '10-28 12:52(手机)',
    entrance: 'phone',
    said: '把「周五(10-23)把仓库交接给研发」那个目标标成达成。',
    expect: [[{ name: 'goal_status', goal_id: 'g-fri1023', status: 'reached' }]],
  },
  {
    row: '10-28 13:03(手机)',
    entrance: 'phone',
    said: '把卡 t-d7eeb2ff(「0.4.144 推热修通道…」那张)取消掉',
    expect: [[{ name: 'cancel', card_id: 't-d7eeb2ff' }], [{ name: 'move_status', card_id: 't-d7eeb2ff', status: 'canceled' }]],
  },
  {
    row: '10-28 09:5x(手机)',
    entrance: 'phone',
    said: '让小K把事务官窗里『在跑的事项』显示 0 的问题修了',
    hide: ['t-7b0588ba', 't-fbe68a38'],
    expect: [[{ name: 'dispatch', to: K, fresh: true }]],
  },
]
