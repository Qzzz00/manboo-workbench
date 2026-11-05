/**
 * 通用的窗口读法(2026-09-25,卡 Q「Agent 自动发现与统一接入」)里**下判断的那一半**。全是纯函数。
 *
 * 壳 `agent_read`(workbench-app/Sources/AgentWindow.swift)只把窗口如实读回来:窗口标题、输入框在哪、
 * 「停止」键在哪、对话区尾巴上那几块字(从后往前读的,读够就停)、侧栏那几行。这里判:
 *
 * - **状态**:窗口里有「停止生成」一类的键(侧栏里的不算 —— 侧栏按壳认出的真实边界分,不按固定比例切)= 在跑;
 *   **没有就不算在跑**(2026-09-27,卡 GB:原来「隔几秒两次读到的内容不一样 = 还在出字」那一支去掉了 ——
 *   窗上的字会变的缘由太多,拿「变了」当「在跑」就是幽灵气泡的出处;停止键读不到的那几家宁可不显示在跑);
 * - **会话标题**:侧栏里选中的那一条 → 窗口标题(去掉 App 名)→ 都没有就明说认不出;
 * - **最新一句**:对话区里最后一行不是界面字的字(时间戳、「复制」「重试」、「Thinking」、免责声明都跳过),截断;
 * - **气泡**:开始跑了、有新回复了 —— 他正看着那个 App 时不冒(他自己看得见)。
 *
 * **不认名单**:哪一家都走这同一套。各家界面字不一样,这里只收**通用**的界面字;认不准的宁可说「认不出」,不编。
 * **只存需要的**:标题、最新一句(截 120 字)、时间、状态;侧栏标题最多 8 条、每条截 60 字。整段对话不落盘。
 */
import type { AgentBubbleView, SessionAskView } from '../protocol.ts'
import { agentHiddenInSlotWhy } from '../protocol.ts'

export interface ReadRect { x: number, y: number, w: number, h: number }

/** 壳 `agent_read` 回来的那一份。 */
export interface WindowRead {
  running: boolean
  windows?: number
  ax_err?: number
  active?: boolean
  hidden?: boolean
  window?: { w: number, h: number, minimized?: boolean }
  title?: string
  input?: ReadRect
  /** 侧栏容器的真实边界(壳按「贴着左边、又高又不太宽」认出来的);认不出就缺席。 */
  sidebar?: ReadRect
  stop: readonly ReadRect[]
  /** 对话区尾巴上那几块字,按阅读顺序。`ctl` = 这块字在按钮 / 链接里面(界面字)。 */
  tail: readonly (ReadRect & { t: string, ctl?: boolean })[]
  /**
   * 侧栏那几行。`sel` = 选中的(当前那条对话)。
   * `r` = 这一行**自己**是哪种键(有名字的键 / 链接 / 列表项,框就是那颗键);
   * `in` = 光秃秃一块字时,它**外面最近那一层**键的角色(2026-10-08 起的壳才带;旧壳两格都可能缺席)。
   */
  side: readonly (ReadRect & { t: string, sel?: boolean, r?: string, in?: string })[]
  capped?: boolean
  visited?: number
  ms?: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rect(value: Record<string, unknown>): ReadRect {
  return { x: num(value.x), y: num(value.y), w: num(value.w), h: num(value.h) }
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
}

/** 把壳回来的那一包收成 `WindowRead`(坏字段当没有,**不抛**)。 */
export function parseRead(raw: Record<string, unknown>): WindowRead {
  const win = typeof raw.window === 'object' && raw.window !== null ? raw.window as Record<string, unknown> : undefined
  const input = typeof raw.input === 'object' && raw.input !== null ? rect(raw.input as Record<string, unknown>) : undefined
  const sidebar = typeof raw.sidebar === 'object' && raw.sidebar !== null ? rect(raw.sidebar as Record<string, unknown>) : undefined
  return {
    running: raw.running === true,
    ...(typeof raw.windows === 'number' ? { windows: raw.windows } : {}),
    ...(typeof raw.ax_err === 'number' ? { ax_err: raw.ax_err } : {}),
    ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
    ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(win === undefined ? {} : { window: { w: num(win.w), h: num(win.h), ...(win.minimized === true ? { minimized: true } : {}) } }),
    ...(typeof raw.title === 'string' && raw.title.trim() !== '' ? { title: raw.title.trim() } : {}),
    ...(input === undefined ? {} : { input }),
    ...(sidebar === undefined ? {} : { sidebar }),
    stop: rows(raw.stop).map(rect),
    tail: rows(raw.tail).filter(one => typeof one.t === 'string').map(one => ({ ...rect(one), t: String(one.t), ...(one.ctl === true ? { ctl: true } : {}) })),
    side: rows(raw.side).filter(one => typeof one.t === 'string').map(one => ({
      ...rect(one),
      t: String(one.t),
      ...(one.sel === true ? { sel: true } : {}),
      ...(typeof one.r === 'string' ? { r: one.r } : {}),
      ...(typeof one.in === 'string' ? { in: one.in } : {}),
    })),
    ...(raw.capped === true ? { capped: true } : {}),
    ...(typeof raw.visited === 'number' ? { visited: raw.visited } : {}),
    ...(typeof raw.ms === 'number' ? { ms: raw.ms } : {}),
  }
}

// ───────────────────────────── 界面字 ─────────────────────────────

/** 一整行就是这几个词的,是界面字(按钮、标签、状态),不是对话内容。**只收通用的**,不按家列。 */
const CHROME_WORDS = new Set([
  '复制', '复制回复', '已复制', '复制成功', '点赞', '点踩', '重试', '重新生成', '分享', '编辑', '回复', '更多', '更多选项',
  '停止', '停止生成', '朗读', '发送', '新对话', '新聊天', '新建对话', '新会话', '新任务', '搜索', '设置', '帮助', '历史', '历史记录',
  '思考中', '已深度思考', '深度思考', '联网搜索', '正在生成', '生成中', '回答完成', '已停止', '已停止生成', '附件', '上传', '语音',
  'copy', 'copied', 'retry', 'edit', 'share', 'regenerate', 'like', 'dislike', 'stop', 'send', 'search', 'settings', 'help',
  'new chat', 'new session', 'new task', 'new thread', 'new conversation', 'thinking', 'responding', 'loading', 'generating',
  'response complete', 'task completed', 'agent todo completed', 'read aloud', 'attach', 'upload', 'voice', 'more',
  'you said:', 'chatgpt said:', 'claude said:', 'assistant said:',
])

/** 整行像界面字的几种形状:时间、「Worked for 19s」、「已思考 12 秒」、「搜索 3 个关键词」、免责声明。 */
const CHROME_PATTERNS: readonly RegExp[] = [
  /^\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$/i,
  /^(上午|下午|昨天|今天|前天)?\s*\d{1,2}:\d{2}$/,
  /^\d{1,2}\s*(月|\/)\s*\d{1,2}\s*日?$/,
  /^(worked|working|thought|thinking|searched|searching|reasoned) (for )?\d+/i,
  /^已(深度)?思考(（|\()?(用时)?\s*\d+/,
  /^(搜索|参考)\s*\d+\s*(个关键词|篇资料)/,
  /^ran \d+ commands?/i,
  /can make mistakes/i,
  /(内容|回答|回复)(均)?由\s*ai\s*生成/i,
  /^ai\s*生成的?内容/i,
  /仅供参考[。.]?$/,
  /^(check|verify) important info/i,
  /^\d+\s*\/\s*\d+$/,
]

/**
 * 整行**只有日期 / 星期 / 时刻**(2026-09-27,卡 BB)。真机 11:4x 生产上气泡写着
 * 「Codex 回了:Thursday 20:17」—— 那是它对话区里那条消息头上的时间戳,上面那几条正则
 * 只认「10:42」「9月25日」,认不出「Thursday 20:17」。
 *
 * **按形状判,不按词表**:星期名、上下午、数字、日期时刻的分隔符全剥掉,**什么都不剩**
 * 就是一行时间戳(而且至少得有一个数 —— 光一个「Thursday」交给别的那几条判)。
 * 真话剥完一定剩字:「周四 20:17 之前给我」剥完剩「之前给我」。
 */
const STAMP_WORDS = /(星期|周)[一二三四五六日天]|(mon|tues|wednes|thurs|fri|satur|sun)day|(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*|上午|下午|凌晨|晚上|中午|昨天|今天|明天|前天|[ap]\.?m\.?/gi

/** 整行只有日期 / 星期 / 时刻 → 时间戳(见 {@link STAMP_WORDS} 那一段)。 */
export function isStampLine(t: string): boolean {
  if (!/\d/.test(t)) return false
  /*
   * **光一串数字不算时间戳**:一句话画成好几块时,「24」「1440」会各自是一块
   * (真机 09-25 卡 F:Codex 一条消息碎成 18 块),把它们剔掉就把那句话读成半截了。
   * 得有日期时刻的分隔符、或者一个星期 / 上下午那样的词,才当时间戳看。
   */
  const hasShape = /[:：]|\d\s*[/\-.]\s*\d|[年月日号时分秒]/.test(t) || new RegExp(STAMP_WORDS.source, 'i').test(t)
  if (!hasShape) return false
  const rest = t
    .replace(STAMP_WORDS, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[年月日号时分秒]/g, ' ')
    .replace(/[\s:：/\-—–.,,、·()()[\]]+/g, '')
  return rest === ''
}

/**
 * 整行是**英文的状态条**(2026-09-27,卡 BB)。真机 11:4x:「Codex 回了:Context automatically compacting」——
 * 那是 Codex 自己在对话区里贴的一行状态(它在压缩上下文),不是它说给他听的话。
 *
 * **按形状判,不按词表**(词表追不完:下一句就是「Summarizing conversation」):
 * 整行 2–4 个词、全是西文字母与空格、**一个标点都没有**、以 `ing` 结尾、里头**没有人称代词**。
 * 一句真话里几乎一定有代词或标点(「I'm compacting the context now.」有 `I'm` 和句点)。
 * **已知取舍**:「sounds interesting」这种两词残句会被当状态条 —— 代价是少冒一次气泡,
 * 比冒一个假的轻(维护者 09-27 11:47 数了五家假气泡,真在跑的那家反倒没有)。
 */
const WORDS_ONLY = /^[A-Za-z][A-Za-z ]{0,48}$/
const PRONOUN = /\b(i|you|we|he|she|it|they|me|us|him|her|them|my|your|our|his|their|its)\b/i
/** 一个词是不是 `-ing` 那一形(至少 5 个字母,「king」「ring」这种名词不算)。 */
const ING = /^[a-z]{2,}ing$/i
/** 同一条状态条跑完之后的过去式(「Context automatically compacted」)。 */
const ED = /^[a-z]{3,}ed$/i

/** 整行是英文状态条(见上面那一段)。 */
export function isStatusLine(t: string): boolean {
  if (!WORDS_ONLY.test(t)) return false
  const words = t.split(/\s+/)
  if (words.length < 2 || words.length > 4 || PRONOUN.test(t)) return false
  /*
   * **只有头一个词许大写**:状态条是一句话的写法(「Context automatically compacting」
   * 「Summarizing conversation」),而对话名是标题的写法(真机 Antigravity 侧栏里那条
   * 「Initiating A New Conversation」—— 四个词全大写开头,它是他的一条对话,剔掉就是把他的事弄丢)。
   */
  if (words.slice(1).some(one => /^[A-Z]/.test(one))) return false
  /*
   * 头一个词或最后一个词是**动词的那两个样子**:`-ing`(「Context automatically compacting」
   * 「Summarizing conversation」)或 `-ed`(2026-09-27 卡 BB2:真机 12:52 Codex 那一家
   * `latest` 读到的是「Context automatically compacted」—— 同一条状态条**跑完之后的过去式**,
   * 卡 BB 只按 `-ing` 判,它就漏过去了,气泡与「最近在做什么」上写的都是这句)。
   */
  return [words[0], words[words.length - 1]].some(one => one !== undefined && one.length >= 5 && (ING.test(one) || ED.test(one)))
}

/** 读屏播报的前缀(「Response complete: <整段回答>」)。播报里那段就是回答本身,取出来当一行。 */
const ANNOUNCE = /^(response complete|response finished|assistant said|assistant responded|chatgpt said|chatgpt responded|claude responded)\s*[:：]\s*/iu

/**
 * 「<谁> said / asked:」这种播报前缀(真机 09-26:Grok Bot 读出来是「Grok Bot asked: 看完后想怎么用?」)。
 * **不写死是谁**:前面那一小截当成名字。对话区里剥掉它、留内容;侧栏里整行丢掉(见 {@link isSideControl})。
 */
const TALK_ANNOUNCE = /^.{1,40}?\s(said|asked|replied|responded|says)\s*[:：]\s*/iu

/** 侧栏里的分组标题与导航(不是会话标题)。 */
const SIDE_HEADERS: readonly RegExp[] = [
  /^(今天|昨天|前天|本周|上周|本月|上个月|更早|更早之前|最近|最近对话|历史对话|全部对话|置顶|已置顶|收藏|我的收藏)$/,
  /^(过去|最近)?\s*\d+\s*(天|日)(内|以内)?$/,
  /^(today|yesterday|this week|last week|this month|last month|older|earlier|recents?|pinned|starred|favorites|chats|history|all chats)$/i,
  /^(previous|last|past) \d+ days$/i,
  /^(projects?|library|explore|gpts|项目|资料库|探索|发现|智能体|我的智能体|更多智能体)$/i,
  /**
   * **「某某 chats」**(2026-09-28,卡 WR)。统筹 09-28 早真机:Muse 这一家的对话列着
   * 「Main chat / Side chats / New side chat」—— 「Side chats」是**那一组**的标题
   * (它下面才是一条条旁聊),复数那个 s 就是它与「Main chat」的分水岭。
   *
   * 按形状:一两个西文词 + 复数的 `chats / conversations / threads / sessions`,再没别的字。
   * 单数的那一条**留着**(「Main chat」是他真的那条对话,剔掉就是把他的事弄丢)。
   */
  /^[a-z]+(\s+[a-z]+)?\s+(chats|conversations|threads|sessions)$/i,
  /^(旁聊|对话|会话|聊天|任务)(列表|记录|分组)$/,
]

/**
 * 侧栏里那几行**界面动作 / 分区入口**(2026-09-26,卡 ST)。`SIDE_HEADERS` 只收「今天 / 昨天 / Pinned」
 * 那种**分组标题**;真机 09-26 19:10 量下来,侧栏里混进来的远不止分组标题:
 *
 * | 那一家 | 侧栏里读到的(真机 `/state.agent_registry.entries[].titles`) |
 * |---|---|
 * | Grok Bot | `Toggle compact sidebar` `Marketplace` `Update — a new version is available` `Grok Bot asked: 看完后想怎么用?` |
 * | Antigravity | `Conversation History` `Scheduled Tasks` `Conversations` `Pin conversation` `Stop execution` |
 * | Codex | `Quick chat` `Pull requests` `Scheduled` `Plugins` |
 * | Kimi | `返回` `收起导航` `账号与安全` `通知` `新建任务` `看板` `插件` `定时任务` |
 * | Manus | `⌘⇧O` `Agent` `Skills` `New` `Plugins` `Scheduled` |
 * | Muse | `在资源库中显示` `新旁聊` |
 *
 * 维护者 19:10:「Grok Bot 的标题显示不全……我发的任务大部分没变成卡片」——卡按对话画之前,
 * 得先把这些行剔掉,否则台上会摆出一张叫「Marketplace」的卡。
 *
 * **规矩**(与 `CHROME_WORDS` 同一条):只收**通用**的界面词与**形状**,一个品牌名都不写死;
 * 认不准的**宁可留着**(留着最多多一张卡,剔错了就是他发的那件事不见了)。开集 —— 真机上再读到新的往这几张表里加。
 */
const SIDE_NAV_WORDS = new Set([
  // 分区入口(App 的一块地方,不是某一条对话)
  'marketplace', 'store', 'plugins', 'plugin', 'extensions', 'skills', 'skill', 'agent', 'agents', 'apps', 'tools', 'workflows',
  'templates', 'library', 'explore', 'discover', 'community', 'feed', 'inbox', 'notifications', 'tasks', 'scheduled',
  'scheduled tasks', 'automations', 'projects', 'project', 'conversations', 'conversation history', 'chat history', 'chats',
  'threads', 'quick chat', 'pull requests', 'issues', 'commits', 'branches', 'account', 'profile', 'billing', 'usage',
  'subscription', 'plan', 'upgrade', 'preferences', 'support', 'docs', 'documentation', 'feedback', 'about', 'sign in',
  'sign out', 'log in', 'log out', 'trash', 'bin', 'drafts', 'archive', 'archived', 'favorites', 'bookmarks', 'memory', 'files',
  'new', 'home', 'back',
  '商店', '市场', '插件', '扩展', '技能', '智能体', '应用', '工具', '工作流', '模板', '资源库', '素材库', '发现', '探索', '社区', '动态',
  '收件箱', '通知', '消息', '任务', '任务列表', '定时任务', '看板', '项目', '对话', '对话列表', '会话', '会话列表', '聊天', '历史', '历史记录',
  '账号', '账号与安全', '我的账号', '个人资料', '账单', '用量', '订阅', '套餐', '升级', '偏好设置', '支持', '文档', '反馈', '关于',
  '登录', '退出登录', '注销', '回收站', '废纸篓', '草稿', '归档', '已归档', '收藏', '书签', '记忆', '文件', '返回', '前进', '首页', '主页',
  // 2026-09-27(卡 BB):真机 11:4x 生产上气泡写着「豆包办公 回了:对话摘要」—— 那是它窗口上那一格
  // 面板的标牌(点开看这条对话的摘要),它谁也没回。整行恰好是这几个字才算(「帮我写个对话摘要」不算)。
  'summary', 'conversation summary', 'chat summary', 'summarize', '摘要', '对话摘要', '会话摘要', '聊天摘要', '内容摘要',
  // 2026-09-27(卡 BB2):真机 12:5x 日志上气泡写着「Claude 回了:Background tasks」—— 那是 Claude
  // 那扇窗上那一格面板的标牌(在跑的后台活儿列在那儿),它谁也没回。同「对话摘要」那一条。
  'background tasks', 'background task', 'running tasks', 'task list', '后台任务', '后台活儿', '任务列表', '运行中的任务',
])

/** 英文界面动作的**头一个词**(「Toggle compact sidebar」「Pin conversation」「Stop execution」)。 */
const SIDE_ACTION_HEAD_EN = /^(toggle|show|hide|pin|unpin|collapse|expand|open|close|delete|remove|rename|archive|unarchive|export|import|duplicate|move|stop|start|resume|pause|restart|refresh|reload|reset|sign|log|upgrade|downgrade|invite|manage|create|add|edit|download|upload|install|uninstall|enable|disable|select|clear|save|undo|redo|submit|cancel|confirm|continue|switch|share|report|contact|subscribe|connect|disconnect|view|see|learn|go|next|previous|skip|dismiss|copy|paste|cut|mute|unmute|star|unstar|filter|sort)\b/i
/** 中文界面动作的**头一截**。 */
const SIDE_ACTION_HEAD_CN = /^(收起|展开|折叠|显示|隐藏|置顶|取消置顶|删除|移除|重命名|归档|取消归档|导出|导入|移动|停止|暂停|重启|刷新|重新加载|重置|登录|登出|退出|注销|升级|降级|邀请|管理|新建|新增|添加|编辑|下载|上传|安装|卸载|启用|停用|选择|清空|清除|保存|撤销|重做|提交|取消|确认|切换|分享|举报|联系|订阅|连接|断开|了解|上一|下一|跳过|忽略|静音|筛选|排序)/
/** 中文界面动作的**尾一截**(「在资源库中显示」)。 */
const SIDE_ACTION_TAIL_CN = /(显示|隐藏|设置|登录|退出登录)$/
/** 快捷键那一行(真机 Manus:「⌘⇧O」)。 */
const SHORTCUT_GLYPH = /[⌘⇧⌥⌃⎋⏎↩⌫]/
/** 读屏播报(真机 Grok Bot:「Grok Bot asked: 看完后想怎么用?」)—— 那是播报,不是侧栏里的一条对话。 */
const SIDE_ANNOUNCE = /^.{1,40}?\s(asked|said|replied|responded|says)\s*[:：]/i
/**
 * **播报里连内容都没有的那一种**(2026-09-28,卡 WR)。统筹 09-28 早真机 `/state.agent_registry` 里
 * Grok Bot 这一家的对话列着「Grok Bot / Grok Bot replied / 人类与AI」—— 「Grok Bot replied」
 * 是读屏播报的**状态**(它回了一句),上面那条 {@link SIDE_ANNOUNCE} 要一个冒号才认,它没有冒号。
 *
 * **按形状判、不写死是谁**:前面一小截当名字,后面恰好收在一个播报动词上、再没有别的字。
 * 真话剥不成这个样子(「Grok Bot replied 的那条我看了」后面还剩字)。
 */
const SIDE_ANNOUNCE_BARE = /^.{1,40}?\s(asked|said|replied|responded|answered|says|is typing|started|stopped)\.?$/i
/** 升级提示条(真机 Grok Bot:「Update — a new version is available」)。 */
const SIDE_UPDATE = /(new version|update available|有新版本|版本可用|立即更新)/i
/**
 * 对话行**旁边那个时间**(真机 09-26 探针:侧栏里「Initiating A New Conversation」下面单独一行「now」)。
 * 它跟对话名挨着、又是独立一块字,不剔就会变成一张叫「now」的卡。
 */
const RELATIVE_TIME = /^(just now|now|yesterday|today|tomorrow|\d+\s*(s|m|h|d|w|mo|y|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks|month|months|year|years)(\s*ago)?|刚刚|刚才|\d+\s*(秒|分钟|分|小时|天|周|个?月|年)前)$/i

/**
 * 这一行是**界面动作 / 分区入口**,不是一条对话。
 *
 * 动作短语那两条**只对短行生效** —— 一条对话的名字常常也是个动宾短语(真机 Codex:「检测树莓派连接」
 * 「设计未来实验室文字Logo」;Muse:「把虚拟形象改为鲸鱼」),按开头那个动词一律剔就会把他发的事剔掉。
 * 英文 ≤ 4 个词、中文 ≤ 8 个字才当动作看。
 */
function isUiLine(t: string): boolean {
  if (t === '') return true
  if (SHORTCUT_GLYPH.test(t) || SIDE_UPDATE.test(t) || RELATIVE_TIME.test(t)) return true
  // 形状那两条(2026-09-27,卡 BB):整行只有时间戳(「Thursday 20:17」)、整行是英文状态条
  // (「Context automatically compacting」)。对话区与侧栏同一条判据。
  if (isStampLine(t) || isStatusLine(t)) return true
  const lower = t.toLowerCase().replace(/[。.!！…:：]+$/u, '')
  if (SIDE_NAV_WORDS.has(lower) || SIDE_NAV_WORDS.has(t)) return true
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]+$/.test(t)
  if (ascii) return t.split(/\s+/).length <= 4 && SIDE_ACTION_HEAD_EN.test(lower)
  return [...t].length <= 8 && (SIDE_ACTION_HEAD_CN.test(t) || SIDE_ACTION_TAIL_CN.test(t))
}

export function isSideControl(text: string): boolean {
  const t = normalize(text)
  // 侧栏里的播报行**整行丢掉**(它不是一条对话的名字);对话区里那种要把前缀剥掉留内容(见 {@link summarizeRead})。
  return SIDE_ANNOUNCE.test(t) || SIDE_ANNOUNCE_BARE.test(t) || isTabStrip(t) || isUiLine(t)
}

/**
 * 整行是**一排标签 / 一格面板的名字**(2026-09-28,卡 WR)。统筹 09-28 早真机:豆包办公这一家
 * 的对话里列着「连接器 · 技能 · 伙伴」—— 那是它窗口上一排标签的名字挤在一块字里,不是一条对话。
 *
 * **按形状判、不写死品牌**:整行被「·」「•」「|」「/」这类**分隔符**切成 **3 段以上**,
 * 每一段都很短(≤ 6 个字 / 词)、又都不带句读。一条对话的名字不长这样
 * (「做个 PDF 导出 / 顺手把标题也改了」只有两段,而且段里带空格的长句)。
 */
const TAB_SEP = /\s*[·•｜|／/>›»]\s*/
function isTabStrip(t: string): boolean {
  if (!TAB_SEP.test(t)) return false
  const parts = t.split(TAB_SEP).map(one => one.trim()).filter(one => one !== '')
  if (parts.length < 3) return false
  return parts.every(one => [...one].length <= 6 && !/[。.!!??,,;;:：]/.test(one))
}

/**
 * 整行就是 **App 自己的标牌**(真机 09-26 18:50:Codex 那扇窗上读到的只有「Codex App」,
 * 于是气泡写成「Codex 回了:Codex App」)。不是它说的话。
 */
function isAppLabel(t: string, appName: string, aliases: readonly string[] = []): boolean {
  const names = appNames(appName, aliases)
  if (names.length === 0) return false
  const lower = t.toLowerCase()
  const stripped = lower.replace(/\s*(app|application|桌面版|客户端|desktop)$/i, '').trim()
  return names.some(name => lower === name || stripped === name)
}

/**
 * 这一家**叫什么**(可能不止一个名,2026-09-26 卡 AC)。
 *
 * 界面上我们叫它「豆包办公」「Codex」,可它自己的窗口标题写的是「豆包」「ChatGPT」——
 * 真机 21:55 的登记表里,Codex 当前那条对话的卡叫「ChatGPT」、豆包那条叫「介绍自身功能 - 豆包」,
 * 两个都是 App 自己的名字漏进了对话标题。所以凡是判「这是不是 App 的标牌 / 名字」的地方,
 * **两个名字都要认**:界面上的显示名,加上 macOS 里那个 App 名(`aliases`)。
 */
function appNames(appName: string, aliases: readonly string[]): string[] {
  return [appName, ...aliases].map(one => normalize(one).toLowerCase()).filter(one => one !== '')
}

/** 额度页上那些词(「重置 / 剩余 / 额度 / reset / quota」…)。不按家列,只按词。 */
const USAGE_WORDS = /(后重置|重置|剩余|已用|用量|额度|配额|次数|上限|套餐|resets?|remaining|used|usage|billing|quota|credits?|limits?|tokens?|plan)/i
/**
 * 用量 / 账单那一页的**页名**(整格恰好是它才算;见 summarizeRead 里 `onUsagePage`)。
 * 真机:Grok Bot「Usage & Billing」、Antigravity「Models & Usage」、Muse「使用情况」、豆包办公「订阅与额度管理」。
 */
const USAGE_PAGE = /^(usage(\s*(&|and)\s*billing)?|models?\s*(&|and)\s*usage|billing|plan\s*(&|and)\s*usage|使用情况|用量|用量与账单|订阅与额度管理|额度管理|套餐与用量)$/i
/** 行里有百分比 / 「x/y」。 */
const USAGE_NUMBERS = /\d+\s*%|\d+\s*\/\s*\d+/
/** 行里有**日期或时刻**(「10月2日」「09-25」「16:02」「3 天后」)。 */
const USAGE_WHEN = /\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*[月/\-.]\s*\d{1,2}|\d+\s*(天|小时|分钟|周|个?月|days?|hours?|minutes?|weeks?|months?)/i
/** 周期词(「Weekly」「Five Hour」「本周」「近 7 天」…),只和额度词一起出现时才算栏目名。 */
const USAGE_PERIOD = /(weekly|monthly|daily|hourly|five\s*hour|5\s*hour|5h|on-?demand|本周|每周|本月|每月|今日|每日|当前时段|近\s*7\s*天)/gi
/** 没有百分比那一路只认短行(再长就像一句话了)。 */
const USAGE_LINE_MAX = 28

/**
 * **额度 / 用量那一页**上的字(真机 09-26 18:50:Kimi 的蓝气泡写着
 * 「Kimi 回了:Code 0% 09-25 17:21 后重置」—— 那是它的额度页,它谁也没回)。
 * 判据是形状,不按家列。两路:
 *
 * 1. 行里有百分比 / 「x/y」,又带着额度词 —— 原来那一路。
 * 2. **没有百分比也算**(2026-09-26,卡 AC)。维护者 21:38 生产上豆包办公的蓝点还在,
 *    它的「回话」写着「10月2日 16:02 重置」—— 那就是额度页里**重置那一行**,行里一个 % 都没有,
 *    于是第 1 路放它过去了。第 2 路:短行 + 额度词 + 一个日期或时刻,并且**整行除了数字、日期时刻、
 *    额度词之外什么都不剩**(最多剩一个栏目名那样的纯英文词,如「Code」)。
 *
 * 第 2 路刻意留着"不剩别的字"这一关,好让真话过去 —— 「我把密码重置了」「9月30日之前帮我重置一下」
 * 剥完还剩「我把密码了」「之前帮我一下」,不算额度行。
 *
 * 3. **整格只有一个百分比 / 一个「x/y」**也算(2026-09-26 晚,卡 QG)—— 真机 Grok Bot 的 Usage & Billing 页上,
 *    「Weekly Usage」与右边那一格的「5%」是分开的两个 AX 节点,「5%」一个用量词都没有,漏进了对话
 *    (生产上 Grok Bot 那条的 latest 就是「5%」)。一整格就是一个数,那从来不是谁说的一句话。
 */
function isUsageLine(t: string): boolean {
  if (/^\s*[0-9]+(?:\.[0-9]+)?\s*%\s*$/.test(t) || /^\s*[0-9]+\s*\/\s*[0-9]+\s*$/.test(t)) return true
  if (!USAGE_WORDS.test(t)) return false
  if (USAGE_NUMBERS.test(t)) return true
  // 4. 用量栏目名(2026-09-26 深夜,统筹):「Weekly Usage」「Five Hour Limit」「本周用量」—— 额度词 + 周期词,别的什么都没有。
  if ([...t].length <= USAGE_LINE_MAX && t
    .replace(new RegExp(USAGE_WORDS.source, 'gi'), ' ')
    .replace(USAGE_PERIOD, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '') === '') return true
  if (!USAGE_WHEN.test(t) || [...t].length > USAGE_LINE_MAX) return false
  const rest = t
    .replace(new RegExp(USAGE_WORDS.source, 'gi'), ' ')
    .replace(/\d+/g, ' ')
    .replace(/[年月日号时分秒天周]/g, ' ')
    .replace(/(上午|下午|凌晨|晚上|am|pm)/gi, ' ')
    .replace(/[%·,,。.、;;:：\-—~/\\()()[\]{}<>|"'""''!!??*&#@+=]/g, ' ')
    .replace(/\s+/g, '')
  // 全剥光 = 就是那一行;只剩一个栏目名那样的纯英文短词也算(真机 Kimi 的「Code」)。
  return rest === '' || (/^[a-z]+$/i.test(rest) && rest.length <= 12)
}

/**
 * 对话区里这一行**不是它说的话**(2026-09-26,卡 ST)。
 *
 * 维护者 09-26 19:45:「一堆蓝色气泡,我点过了也不消失,是在做什么测试吗」—— 18:50 生产上
 * Kimi / Codex / Muse / Grok Bot / Antigravity 全是蓝 1,气泡原话是额度页的字、窗口标题、
 * App 标牌。这些字**每读一次就可能变**(额度百分比、时间戳),于是 `nextWindowState` 每拍都判出
 * 「内容变了 → 它回了一句」→ 记成做完未读;他点掉,下一拍又亮。
 * (所以坞上「点了不消失」与这条是**同一个根因**,不是客户端没发 `/agents/read` —— 见交接。)
 *
 * 剔掉之后:界面字、App 标牌、额度页、侧栏那些字都不再进 `latest`,也不再进
 * {@link ReadSummary.signature} —— 它们变了不算「它回了一句」。
 */
export function isNotTalk(text: string, appName: string, aliases: readonly string[] = []): boolean {
  const t = normalize(text)
  return isUiLine(t) || isAppLabel(t, appName, aliases) || isUsageLine(t)
}

/**
 * 「新X」那一行是**按钮**,不是对话(真机 Muse:侧栏里「新旁聊」是按钮、「旁聊」才是那条对话)。
 * **不写死品牌、不猜断句**:只有「新 / New」后面剩下的那一截**恰好也是这份侧栏里的另一行**时才算按钮。
 */
function isNewButton(text: string, siblings: readonly string[]): boolean {
  const t = normalize(text)
  const rest = t.replace(/^(新建|新增|新|new)\s*/i, '').trim()
  if (rest === '' || rest === t) return false
  if (siblings.some(one => normalize(one) === rest)) return true
  /**
   * **「新」后面剩下的那一截本来就是「一段对话」的通名**(2026-09-28,卡 WR)。
   *
   * 统筹 09-28 早真机:豆包办公列着「新工作任务」、Muse 列着「New side chat」——
   * 两条都是侧栏上那颗开新对话的键,而上面那一路要求「剩下那一截恰好也是这份侧栏里的另一行」,
   * 豆包那份侧栏里没有单独一行「工作任务」,于是它被当成了一条对话。
   *
   * 这一路只认**通名**(对话 / 会话 / 任务 / 旁聊 / chat / thread…),一个品牌名都不写死:
   * 「新的运营方案」「New pricing page」剩下的那一截不是通名,照旧留着。
   */
  return GENERIC_CHAT_NOUN.test(rest)
}

/**
 * 「一段对话 / 一件活」的**通名**(见 {@link isNewButton})。只收通名,不收任何品牌名;
 * 前面许一个限定词(`side` / `quick` / `工作` / `临时`),后面许一个复数 s。
 */
const GENERIC_CHAT_NOUN
  = /^(side|quick|group|main|blank|empty|temp|temporary)?\s*(chat|conversation|thread|session|task|topic|dialog|dialogue|project)s?$|^(工作|临时|快速|空白|旁)?(对话|会话|聊天|任务|话题|旁聊|项目|工作任务)$/i

/**
 * 侧栏读到的这几行里,哪几行是**对话**(2026-09-26,卡 ST)。台上按对话画卡之前先过这一道。
 * 传进来的是已经过过 `isChromeLine` / `isSideHeader` 的那几行(`WindowAgentState.titles`),
 * 老数据(卡 ST 之前存下来的 `agents.json`)里还留着界面字,所以出视图时也再过一遍。
 */
export function conversationTitles(titles: readonly string[]): string[] {
  const kept = titles.filter(one => !isChromeLine(one) && !isSideHeader(one) && !isSideControl(one))
  return kept.filter(one => !isNewButton(one, kept))
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 这一行是不是界面字。 */
export function isChromeLine(text: string): boolean {
  const t = normalize(text)
  if ([...t].length <= 1) return true
  const lower = t.toLowerCase().replace(/[。.!！…:：]+$/u, '')
  if (CHROME_WORDS.has(lower) || CHROME_WORDS.has(t)) return true
  // 形状那两条(2026-09-27,卡 BB):整行只有时间戳、整行是英文状态条。
  if (isStampLine(t) || isStatusLine(t)) return true
  return CHROME_PATTERNS.some(pattern => pattern.test(t))
}

function isSideHeader(text: string): boolean {
  const t = normalize(text)
  return SIDE_HEADERS.some(pattern => pattern.test(t))
}

/**
 * 侧栏里这一行是不是**分组标题**,它底下那几行算不算对话(2026-09-28,卡 WR)。
 *
 * - `talk`:底下是一条条对话(「今天」「Tasks」「Chats」「历史」)—— 照收;
 * - `not_talk`:底下**不是**对话(「Projects」底下是项目文件夹、「Skills」底下是技能、
 *   「Scheduled Tasks」底下是定时任务)—— 整段跳过,直到下一个分组标题;
 * - `undefined`:这一行不是分组标题(多数家的侧栏没有分组)—— 这一行自己按老规矩判,
 *   **不改当前这一段的性质**。
 *
 * 一个品牌名都不写死,只收通名;拿不准的一律当 `talk`(宁可多一张卡,不许把他的事弄丢)。
 */
const SECTION_NOT_TALK = new Set([
  'projects', 'project', 'my projects', 'library', 'skills', 'skill', 'plugins', 'plugin', 'extensions', 'apps',
  'tools', 'templates', 'workflows', 'agents', 'connectors', 'connector', 'partners', 'files', 'memory',
  'bookmarks', 'marketplace', 'store', 'scheduled tasks', 'scheduled', 'automations', 'explore', 'discover', 'gpts',
  '项目', '我的项目', '资料库', '素材库', '技能', '插件', '扩展', '应用', '工具', '模板', '工作流', '智能体',
  '连接器', '伙伴', '文件', '记忆', '书签', '市场', '商店', '定时任务', '计划任务', '探索', '发现',
])
const SECTION_TALK = new Set([
  'tasks', 'task', 'chats', 'chat', 'conversations', 'conversation', 'threads', 'conversation history', 'chat history',
  'history', 'recents', 'recent', 'all chats',
  '任务', '对话', '会话', '聊天', '历史', '历史记录', '最近', '最近对话', '历史对话', '全部对话',
])

export function sectionKindOf(text: string): 'talk' | 'not_talk' | undefined {
  const t = normalize(text)
  const key = t.toLowerCase().replace(/[。.!！…:：]+$/u, '')
  if (SECTION_NOT_TALK.has(key) || SECTION_NOT_TALK.has(t)) return 'not_talk'
  if (SECTION_TALK.has(key) || SECTION_TALK.has(t)) return 'talk'
  return isSideHeader(t) ? 'talk' : undefined
}

/**
 * **窗口标题是 App 自己截断的,侧栏里那一条是全的 —— 用全的**(2026-09-26,卡 ST)。
 *
 * 维护者 09-26 19:10 头一句就是:「Grok Bot 的标题显示不全」。真机 `/state` 那一刻 Antigravity 的
 * 窗口标题是「Initiating A New Conversa...」(那三个点是 **App 自己**加的,不是我们截的),
 * 而它侧栏里躺着全名「Initiating A New Conversation」—— 侧栏里没有选中标记时标题退回窗口标题,
 * 于是摆到他眼前的就是那个半截的,而且按对话建卡时半截与全名会变成**两张卡**。
 *
 * 判据只看形状:窗口标题以省略号结尾、去掉省略号之后是侧栏里某一条的**开头** → 就是它。
 * 对不上就原样用窗口标题(不猜、不拼)。
 */
export function fullTitleOf(title: string, titles: readonly string[]): string {
  const stem = normalize(title).replace(/(\.{2,}|…|‥)\s*$/, '').trim()
  if (stem === normalize(title) || [...stem].length < 4) return title
  return titles.find(one => one !== title && normalize(one).startsWith(stem)) ?? title
}

/** 按字符截短,超了加「…」。 */
export function clipText(text: string, max: number): string {
  const flat = normalize(text)
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`
}

/** 32 位 FNV-1a(只用来比「内容变没变」,不落什么秘密)。 */
export function fnv1a(text: string): string {
  let hash = 0x811C9DC5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// ───────────────────────────── 读一次 → 四样 ─────────────────────────────

/** 最新一句截多长(存进登记表、摆上界面的就是这个长度)。 */
export const LATEST_MAX = 120
/** 标题截多长。 */
export const TITLE_MAX = 60
/** 侧栏标题最多留几条。 */
export const TITLES_MAX = 8

export interface ReadSummary {
  /** 窗口读得到。 */
  ok: boolean
  /**
   * **这一下没看成是因为它藏着**(2026-10-01)——多半就是工作台自己的窗口槽藏的。
   * 不是「它没有窗口」,更不是「没接上」:上一次读到的那一份照旧算数,等她切到那一格再看一眼。
   */
  hidden?: true
  /** 窗口里有「停止」一类的键(侧栏里的不算)。 */
  busy: boolean
  title?: string
  /** 截断过的最新一句。 */
  latest?: string
  /**
   * 对话区尾巴上读到几段不是界面字的话(2026-09-26,卡 WS)。**只用来认「这扇窗里还没有一来一回」**:
   * 只有一段 = 它的开场白 / 空对话(Manus 那扇新窗上就只有一句「What can I do for you?」),
   * 那句话不是它在问他。不记内容,只记个数。
   */
  lines?: number
  titles: string[]
  /** 对话区尾巴的指纹(判「内容变没变」)。读不到字就缺席。 */
  signature?: string
  /**
   * 尾巴上**每一段各自**的指纹(2026-09-27,卡 BB2;只有哈希,不含内容,最多 3 个)。
   *
   * `signature` 只说「整块变没变」,说不出**怎么变的**。对话区**只会往后长**:它出字、他又说一句,
   * 上一拍读到的那几段里总还剩着一段(他那句问话、上一条回答)。而一扇窗从一页翻到另一页
   * (真机 12:5x Muse:对话区翻到它那张「建议你问我」的卡 —— 维护者点过去「发现什么都没有」)
   * 是**整页换掉**:上一拍那几段一段都不剩。两件事在 `signature` 上一模一样,在这里分得开。
   */
  blocks?: readonly string[]
  gaps: { status?: string, title?: string, latest?: string }
}

/**
 * **会话列表项**的角色(2026-10-08,卡「陌生程序侧栏」)。网页里一条条会话常画成可切换的项
 * (`role=checkbox` / `aria-pressed` 的按钮,辅助功能里是 AXCheckBox/AXToggleButton,或单选项)。
 * 真机:千问办公、Manus 的会话行都是 AXCheckBox;它们的导航键、账号区、空列表的提示都不是。
 * 单选项不算:真机上它是一排标签(千问办公「任务 / 频道」)。
 */
const LIST_ITEM_ROLES = new Set(['AXCheckBox'])
/** 至少露出这么多条列表项才只收列表项(一颗「只看星标」那样的开关不算一份列表)。 */
const LIST_ITEMS_MIN = 2
/** 有名字的键 / 链接 —— 框就是那颗键,能按宽窄判是不是图标键。 */
const CONTROL_ROLES = new Set(['AXButton', 'AXLink', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXMenuButton'])
/**
 * 侧栏里一颗键**不到侧栏宽的这一份**,就是图标键(关侧栏、搜索、新建、钉住、归档、图标栏上的导航)。
 * 真机:会话行占侧栏宽的 0.63(Muse)–0.94(Antigravity);图标键 0.09–0.28(千问办公「新任务」78/280)。
 */
const ICON_CONTROL_SHARE = 0.4

/** 侧栏这一行是图标键:有名字的键,而且窄。光秃秃的字不按宽窄判(字的宽就是字的长)。 */
function isIconControl(row: ReadRect & { r?: string }, sidebar: ReadRect | undefined): boolean {
  return sidebar !== undefined && row.r !== undefined && CONTROL_ROLES.has(row.r) && row.w < sidebar.w * ICON_CONTROL_SHARE
}

function isListItem(row: { r?: string, in?: string }): boolean {
  return LIST_ITEM_ROLES.has(row.r ?? '') || LIST_ITEM_ROLES.has(row.in ?? '')
}

/** 这一块落在侧栏里(横着不出侧栏左右 2 点)。认不出侧栏就谁都不在侧栏里 —— 不按位置猜。 */
export function inSidebar(r: ReadRect, sidebar: ReadRect | undefined): boolean {
  return sidebar !== undefined && r.x >= sidebar.x - 2 && r.x + r.w <= sidebar.x + sidebar.w + 2
}

/**
 * ★ **主对话区那几行**(2026-10-13;从 `engine/adapters/window.ts` 的 `readRelayEvidence`
 * 里提出来 —— 卡 C 的「替她答完再读一次窗口」要用同一份,两处各写一遍必然漂)。
 *
 * 四条筛子(与那边一字不差):不是界面字(`ctl`)、不在侧栏、横着没出输入框那一列
 * (右边的摘要栏在输入框右边)、**在输入框上面**(框里那一块是她的草稿,不读)。按纵坐标排好。
 * 读不到(没在跑 / 没找到输入框 / 辅助功能报错)回空数组 —— 调用方据此说「读不到」,不编。
 */
export function transcriptRows(read: WindowRead): readonly string[] {
  const input = read.input
  if (!read.running || input === undefined || read.ax_err !== undefined) return []
  return read.tail
    .filter(row => row.ctl !== true && !inSidebar(row, read.sidebar) && row.x < input.x + input.w && row.y + row.h / 2 < input.y)
    .slice()
    .sort((a, b) => a.y - b.y)
    .map(row => row.t.trim())
    .filter(t => t !== '')
}

/**
 * 挨着的几块字拼成一段(2026-09-25)。有的 App 把一句话画成好几块(markdown 的加粗、行内代码、换行各是一块 ——
 * 卡 F 读 Codex 时一条消息碎成 18 块),只拿最后一块当「最新一句」会是半截。
 * 判据只用位置:**同一行**(竖着重叠),或者**紧挨着的下一行**(上沿离上一块下沿不到 6 点、横着有重叠)算同一段;
 * 两条消息之间、两段之间的空隙都比这大。
 */
export function paragraphs(rows: readonly (ReadRect & { t: string })[]): string[] {
  const out: { parts: string[], top: number, bottom: number, left: number, right: number }[] = []
  for (const row of rows) {
    const prev = out.at(-1)
    const top = row.y
    const bottom = row.y + row.h
    if (prev !== undefined) {
      const sameLine = top < prev.bottom - 2 && bottom > prev.top + 2
      const overlapX = row.x < prev.right && row.x + row.w > prev.left
      const nextLine = top >= prev.bottom - 2 && top - prev.bottom <= 6 && overlapX
      if (sameLine || nextLine) {
        prev.parts.push(row.t)
        prev.bottom = Math.max(prev.bottom, bottom)
        prev.left = Math.min(prev.left, row.x)
        prev.right = Math.max(prev.right, row.x + row.w)
        continue
      }
    }
    out.push({ parts: [row.t], top, bottom, left: row.x, right: row.x + row.w })
  }
  return out.map(one => joinParts(one.parts)).filter(one => one !== '')
}

/** 拼字:两边都是字母数字才补一个空格,中文直接接上。 */
function joinParts(parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    const piece = part.trim()
    if (piece === '') continue
    out = out === '' ? piece : /[A-Za-z0-9,.;:!?)]$/.test(out) && /^[A-Za-z0-9(]/.test(piece) ? `${out} ${piece}` : `${out}${piece}`
  }
  return out
}

/** 窗口标题去掉 App 名那一截(「ChatGPT - 一年有几个季节」→「一年有几个季节」);剩下的就是 App 名 / 空 → 没有。 */
export function titleFromWindow(windowTitle: string | undefined, appName: string, aliases: readonly string[] = []): string | undefined {
  if (windowTitle === undefined) return undefined
  let t = normalize(windowTitle)
  // 「介绍自身功能 - 豆包」「ChatGPT - 一年有几个季节」:**它的每一个名字**都从两头剥掉(卡 AC)。
  for (const name of appNames(appName, aliases)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`^${escaped}\\s*[-–—|·:：]\\s*`, 'i'), '').replace(new RegExp(`\\s*[-–—|·:：]\\s*${escaped}$`, 'i'), '')
  }
  t = t.trim()
  // 剥完只剩它自己的名字(真机 Codex:窗口标题整个就是「ChatGPT」)→ 认不出标题,不拿 App 名当一条对话。
  if (t === '' || isAppLabel(t, appName, aliases) || isChromeLine(t) || isSideHeader(t) || isSideControl(t)) return undefined
  return t
}

/**
 * 读一次 → 状态、标题、最新一句、侧栏标题,以及拿不到的那几样**为什么拿不到**。
 * 「在不在跑」这里只看停止键;「内容还在变」要跟上一次比,在 `nextWindowState` 里判。
 */
export function summarizeRead(read: WindowRead, appName: string, aliases: readonly string[] = []): ReadSummary {
  if (!read.running) {
    return { ok: false, busy: false, titles: [], gaps: { status: `${appName} 没开`, title: `${appName} 没开`, latest: `${appName} 没开` } }
  }
  /*
   * **藏着就是没看成**(2026-10-09,根治方案第三节第 1 条第 3 级)。Chromium 系的窗被窗口槽藏起来后,
   * 辅助功能树停在藏起那一刻 —— 窗还列得出来,停止键、进度条、秒表都挂着不动(10-08 千问办公)。
   * 那是旧画面,不拿它判在跑或做完:这一拍按没看成算,上一次看得见时的判断照旧(见 `nextWindowState`)。
   */
  if (read.hidden === true) {
    const why = agentHiddenInSlotWhy(appName)
    return { ok: false, hidden: true, busy: false, titles: [], gaps: { status: why, title: why, latest: why } }
  }
  if (read.window === undefined || (read.windows ?? 1) === 0 || read.ax_err !== undefined) {
    // 藏着的那种上面已经收走了(藏着的 App 常常一扇窗都列不出,那不是「它没有窗口」,2026-10-01)。
    const why = read.ax_err !== undefined
      ? `辅助功能读不到 ${appName} 的窗口(回 ${read.ax_err})`
      : `${appName} 开着,但一扇窗都没有(可能只在菜单栏里)`
    return { ok: false, busy: false, titles: [], gaps: { status: why, title: why, latest: why } }
  }
  const sidebar = read.sidebar
  const busy = read.stop.some(r => !inSidebar(r, sidebar))

  // 侧栏:按从上到下,去掉分组标题、导航与界面字,去重。
  const seen = new Set<string>()
  const titles: string[] = []
  let selected: string | undefined
  /**
   * **分组标题管着它底下那几行**(2026-09-28,卡 WR;统筹 09-28 10:07 真机)。
   *
   * Manus 的侧栏是两段:「Projects」底下是项目文件夹(Token Factory / Cassetta / DramaWise / Liteart…),
   * 「Tasks」底下才是一条条对话(派活测试任务管理 / 查询中秋节农历日期…)。以前分组标题在这一步就被
   * 丢掉了,于是两段混成一片 —— 登记表里列出来的、手机上摆成卡的,全是那几个**项目文件夹**。
   *
   * 现在按**从上到下**走,记住最近那个分组标题:落在「不是对话的那种分组」底下的行整段跳过。
   * 认不出是哪种分组(多数家没有分组标题)照旧全留 —— 宁可多一张卡,不许把他的事弄丢。
   */
  const sorted = [...read.side].sort((a, b) => a.y - b.y).map(row => ({ ...row, t: normalize(row.t) }))
  /*
   * **侧栏露出了会话列表项,就只收列表项**(2026-10-08,卡「陌生程序侧栏」)。千问办公 / Manus 把会话画成
   * 一条条可切换的项,导航键、她的账号名(「姚桑」「姚岱楠」)、套餐标、空列表的提示都在列表外面。
   * 一项都没露出来(旧壳、Muse 那种全是按钮的家)就照老规矩判 —— 宁可多一张卡,不许把她的事弄丢。
   */
  const listOnly = sorted.filter(row => isListItem(row) && !isIconControl(row, sidebar)).length >= LIST_ITEMS_MIN
  const rowsBySide: typeof sorted = []
  let notTalkSection = false
  for (const row of sorted) {
    if ([...row.t].length < 2 || isChromeLine(row.t)) continue
    const section = sectionKindOf(row.t)
    if (section !== undefined) { notTalkSection = section === 'not_talk'; continue }
    if (isIconControl(row, sidebar) || (listOnly && !isListItem(row))) continue
    // 侧栏里那一行就是 App 自己的名字(豆包侧栏顶上的「豆包」)也不是一条对话(2026-09-28 Air 维护包)。
    if (isSideControl(row.t) || isAppLabel(row.t, appName, aliases)) continue
    if (notTalkSection) continue
    rowsBySide.push(row)
  }
  const siblings = rowsBySide.map(row => row.t)
  for (const row of rowsBySide) {
    const t = row.t
    if (isNewButton(t, siblings)) continue
    if (row.sel === true && selected === undefined) selected = clipText(t, TITLE_MAX)
    const clipped = clipText(t, TITLE_MAX)
    if (seen.has(clipped)) continue
    seen.add(clipped)
    if (titles.length < TITLES_MAX) titles.push(clipped)
  }
  const title = selected ?? (() => {
    const fromWindow = titleFromWindow(read.title, appName, aliases)
    return fromWindow === undefined ? undefined : clipText(fullTitleOf(fromWindow, titles), TITLE_MAX)
  })()

  // 最新一句:对话区里(输入框上面、侧栏以外、不在按钮/链接里)最后一段不是界面字的。
  const inputTop = read.input === undefined ? undefined : read.input.y
  // 对话区在输入框那一栏里:整块落在输入框右沿以外的是右边那格面板(千问办公「任务监控 / 暂无产物」)。
  const inputRight = read.input === undefined ? undefined : read.input.x + read.input.w
  const kept: (ReadRect & { t: string })[] = []
  for (const row of read.tail) {
    if (row.ctl === true) continue
    if (inSidebar(row, sidebar)) continue
    if (inputTop !== undefined && row.y + row.h / 2 >= inputTop) continue
    if (inputRight !== undefined && row.x >= inputRight) continue
    let t = normalize(row.t)
    // 读屏播报的前缀剥掉、内容留着(「Grok Bot asked: 先推进哪件?」→「先推进哪件?」)。
    const announce = ANNOUNCE.exec(t) ?? TALK_ANNOUNCE.exec(t)
    if (announce !== null) t = t.slice(announce[0].length).trim()
    if (t === '' || isChromeLine(t)) continue
    // 界面字 / App 标牌 / 额度页那几行**不算它说的话**(卡 ST;19:45 那一堆假蓝气泡的根因)。
    if (isNotTalk(t, appName, aliases)) continue
    if (title !== undefined && t === title) continue
    kept.push({ ...row, t })
  }
  /*
   * **窗停在用量 / 账单页上时,整页都不是对话**(2026-09-26 深夜,统筹真壳自核)。
   * 卡 QG 让「5%」不算话之后,Grok Bot 那扇停在 Usage & Billing 的窗,「最后一句」换成了「Weekly Usage」,
   * 一变就判成「它回了一句」→ 台上一张假「做完 · 未读」。逐行补词追不完(下一句是「Billed through Cursor」),
   * 所以按页认:对话区里有一整格就是用量页的页名,这一拍对话区一句都不收。
   */
  const onUsagePage = read.tail.some(row => USAGE_PAGE.test(normalize(row.t)))
  // 进度行(「规划中 ... 13.7s」)不是它说的话,不当最新一句(2026-10-08 千问办公)。
  const lines = onUsagePage ? [] : paragraphs(kept).filter(line => !isProgressLine(line))
  const last = lines.at(-1)
  const latest = last === undefined ? undefined : clipText(last, LATEST_MAX)
  const signature = lines.length === 0 ? undefined : fnv1a(lines.slice(-3).join('\n'))
  // 每一段各自的指纹(卡 BB2:判「整页换掉」还是「往后长了」;见 {@link ReadSummary.blocks})。
  const blocks = lines.length === 0 ? undefined : lines.slice(-3).map(one => fnv1a(one))

  const gaps: ReadSummary['gaps'] = {}
  if (title === undefined) gaps.title = `认不出 ${appName} 当前那条对话的标题(侧栏里没有选中的一条,窗口标题就是 App 名)`
  if (latest === undefined) gaps.latest = read.capped === true
    ? `${appName} 的窗口太大,这次没读到对话区`
    : `${appName} 的对话区里没读到字(可能是一条新开的空对话)`
  return {
    ok: true,
    busy,
    ...(title === undefined ? {} : { title }),
    ...(latest === undefined ? {} : { latest }),
    lines: lines.length,
    titles,
    ...(signature === undefined ? {} : { signature }),
    ...(blocks === undefined ? {} : { blocks }),
    gaps,
  }
}

// ───────────────────────────── 前后两次 → 状态与气泡 ─────────────────────────────

/** 一家读窗口读出来的样子(**这就是登记表里存的那一份**:标题、最新一句、时间、状态,不存整段对话)。 */
export interface WindowAgentState {
  status: 'running' | 'idle' | 'unknown'
  /**
   * 最后这一拍没看成,**是因为它藏在窗口槽里**(2026-10-01)。登记表据此把那一句说成
   * 「藏在窗口槽里,切到它那一格时我再看一眼」,而不是「没接上:开着,但一扇窗都没有」。
   */
  hidden?: true
  /**
   * **藏起来之前最后一次看得见时**它在不在跑(2026-10-09)。藏着时读到的是旧画面,`status` 说不清(`unknown`);
   * 会话那一格照这一格摆(在跑的仍是在跑,空闲的仍是做完),不凭旧画面改判。只在 `hidden` 时有。
   */
  seen_status?: 'running' | 'idle'
  /**
   * 它窗口里**摆着一道选择题等她**(豆包办公「正在询问用户」那种;2026-09-28 Air 维护包)。
   * 有它 = 这条对话在等她:进「等你确认」、打电话、能替她点 / 写。见 {@link doubaoVisibleForm}。
   */
  formAsk?: SessionAskView
  /** 进入这个状态的时刻。 */
  since: string
  title?: string
  latest?: string
  titles: string[]
  /** 这一份是什么时候读的。 */
  at: string
  /** 对话区尾巴的指纹(判「内容变没变」;一串十六进制,不含内容)。 */
  signature?: string
  /** 内容最后一次变的时刻(「最近在做什么 · 几分钟前」按它算)。 */
  changed_at?: string
  /**
   * **这一份不能拿来比「变没变」**(2026-09-27,卡 BB)。维护者 11:47:「豆包办公突然弹出执行中的气泡,
   * 然后蓝了然后又白了又蓝了……实际上正在运行的 codex 却没有气泡」。
   *
   * 「它回了一句」是**两次读之间**的差,所以只有**这一轮里前后两拍**才比得:
   * 中间隔了一次重启(读数从盘上来的)、隔了一段读不到窗口(藏起来了、辅助功能没读到),
   * 或者隔了一次**读额度**(卡 AG:切走一家就重读它的额度,读之前把藏着的家 unhide、读完藏回去 ——
   * 那一下窗口上的字会整页换),两边的读数就不是一个连续的流,差出来的东西不是「它说了话」。
   *
   * 这一格为真时下一拍**只重新起算**:不算变化、不冒气泡、不记未读、不因为「变了」判成在跑
   * (窗口里真有停止键照旧算在跑 —— 那不是比出来的,是当场看见的)。
   */
  stale?: true
  /**
   * 最近几拍的对话区指纹(2026-09-27,卡 BB;只有哈希,不含内容)。判**来回晃**:
   * 真机日志上「Manus 开始跑了 / Manus 回了:What can I do for you?」成对刷了四轮 ——
   * 那扇窗在两份内容之间来回(两扇窗、或者一页额度一页对话),每晃一下都被判成「它回了一句」。
   * 对话区只会往后长,**回到几拍前见过的那一份**从来不是「它又说了一句」。
   */
  sigs?: string[]
  /**
   * 上一拍尾巴上**每一段各自**的指纹(2026-09-27,卡 BB2;见 {@link ReadSummary.blocks})。
   * 判**整页换掉**:这一拍一段都不剩上一拍那几段 → 那是这扇窗翻了一页,不是它又说了一句。
   */
  psigs?: string[]
  /**
   * **这一串「窗口里有停止键」是什么时候开始的**(2026-09-27,卡 BB2)。
   *
   * 维护者 12:50:「codex 只有白色呼吸气泡,完成后没有转为蓝色,我点过去一看其实已经完成有一阵子了。」
   * 真机 12:5x 量下来:Codex 那一家 `status: running` 连着 422 秒,而对话区最后一次变是 210 秒前 ——
   * 「变了才算在跑」那一路早就不成立了,撑着它的只有**当场看见的那个停止键**:Codex 那扇窗上有一个
   * 「停止」形状的键**一直在**,于是它永远是在跑、永远等不到那一拍 idle,`justAnswered` 永不触发,
   * 白点只会一直呼吸,永不变蓝。
   *
   * 所以「当场看见」也得有个活口:停止键在那儿、对话区又一个字都没变,过了
   * {@link BUSY_STALL_MS} 就不算它在跑了(见 `busyStalled`)。停止键一消失这一格就清掉。
   */
  busy_since?: string
  /** 有他还没看过的新回复。 */
  unread: boolean
  /**
   * **最新那句是它刚说完的回话**(2026-09-26,卡 WS)。判「在等你」只判它刚说完的那句 ——
   * 他自己在那扇窗里说的话不该被判成「它在问你」。
   *
   * 判据与 `replied` 气泡同一个转折(在跑 → 不跑了,或者空闲里内容变了而现在不跑),
   * 但**与气泡的抑制条件无关**:他正看着那扇窗时气泡不冒、`unread` 不记,这一格照记 ——
   * 「它刚答完」是事实,冒不冒气泡是另一件事。第一次读(`prev === undefined`)不算(变没变说不清)。
   *
   * **已知缺口**(交接里写清,别当它不存在):读窗口分不出这一段字是谁说的。他刚发出去一句、
   * 那家还没开口的那一瞬间读到,这一格会是 true,`latest` 却是他说的话 —— 但他**没发出去**的字
   * 在输入框里(`summarizeRead` 把输入框那一行以下的字都扔了),不会被读到;发出去之后那家一起手
   * 就是 `running`,下一拍 `decide` 就按「在跑」收掉。加上密读那几分钟,这个窗口只有几秒。
   */
  answered?: boolean
  /**
   * 侧栏里**每条对话上次被选中时**看到的样子(2026-09-26,卡 ST)。
   *
   * 台上按对话画卡(设计 F):一条对话一张卡。可读窗口只读得到**当前选中的那一条**的内容 ——
   * 别的几条只有名字。所以状态与最后一句只挂在当前那条上,其余几条**保留上次看到的**(它们曾经被选中过的话),
   * 从来没被选中过的就只有名字(卡上写「空闲」,不编一句话)。
   *
   * 键是对话名(同 {@link windowSessionId} 那个名),值只有三样:什么时候看到的、那时在不在跑、那时最后一句。
   * **只留侧栏里还在的那几条**(最多 {@link TITLES_MAX} + 当前那条),不无限长大;不存整段对话。
   */
  seen?: Record<string, { at: string, status: 'running' | 'idle', latest?: string }>
  gaps: { status?: string, title?: string, latest?: string }
}

/**
 * 两次读挨得多近才算「同一段连续的流」(判来回晃、判整页换掉那两道闸用)。
 * ★ 2026-09-27(卡 GB)起**不再拿它判在跑** —— 在跑只认停止键。
 */
export const STREAMING_WINDOW_MS = 20_000
/** 最近几拍的指纹留几个(判「来回晃」;只有哈希)。 */
export const SIG_RING_MAX = 6
/**
 * **停止键在那儿、对话区又一直没变**,撑到这么久就不算在跑了(2026-09-27,卡 BB2)。
 *
 * 真机 12:5x:Codex 连着 422 秒 `running`,对话区 210 秒没变一个字。三分钟是照「它想很久才出第一个字」
 * 留的余量 —— 宁可让白点多呼吸三分钟,也不要在它还在想的时候报一句「回了」。
 */
export const BUSY_STALL_MS = 180_000
/**
 * **读得多密才敢说那个停止键卡住了**(2026-09-27,卡 BB2)。
 *
 * 空闲的那几家 3 分钟才读一次(`READ_IDLE_SLOW_MS`)—— 隔那么久读一次,「停止键在、字没变」说明不了什么
 * (它完全可能在跑一件不出字的长活)。只有两拍挨得够近、连着几拍都是这个样子,才判得出「这个键卡住了」。
 * 一家一被看见在跑,读的节奏就转快(十几秒一拍),所以真卡住的那种连着好几拍都落在这道口子里。
 */
export const STALL_MAX_GAP_MS = 60_000

/** 把这一拍的指纹记进那一圈(重复的挪到最后,只留最近 {@link SIG_RING_MAX} 个)。 */
function nextSigs(prev: readonly string[] | undefined, signature: string | undefined, rebase: boolean): string[] | undefined {
  if (signature === undefined) return rebase ? undefined : (prev === undefined ? undefined : [...prev])
  // 重新起算:这一圈从这一拍重新数(隔了一段之后,之前见过什么说明不了这一拍)。
  const base = rebase ? [] : (prev ?? []).filter(one => one !== signature)
  return [...base, signature].slice(-SIG_RING_MAX)
}

/**
 * 记下「当前这条对话此刻什么样」,并把侧栏里已经不在了的那几条丢掉(2026-09-26,卡 ST)。
 * 见 {@link WindowAgentState.seen}:别的对话卡上那句「上次看到的」就是从这里来的。
 */
function nextSeen(
  prev: WindowAgentState['seen'],
  summary: ReadSummary,
  status: 'running' | 'idle',
  at: string,
): WindowAgentState['seen'] {
  const alive = new Set(conversationTitles(summary.titles))
  if (summary.title !== undefined) alive.add(summary.title)
  const out: NonNullable<WindowAgentState['seen']> = {}
  for (const [title, one] of Object.entries(prev ?? {})) if (alive.has(title)) out[title] = one
  if (summary.title !== undefined) {
    out[summary.title] = { at, status, ...(summary.latest === undefined ? {} : { latest: summary.latest }) }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 这一次读完之后的样子,以及要不要冒一个气泡。
 *
 * - 开始跑(之前不是在跑、这次在跑)→ 「X 开始跑了」;
 * - 跑完了(之前在跑、这次不跑了),或者两次之间内容变了而它现在不跑 → 「X 回了:……」,记成**没看过**;
 * - **他正看着那个 App(它在前台)时不冒气泡**,也不记没看过 —— 他自己看得见;
 * - 第一次读(刚接上、工作台刚重启)不冒:那时候变没变说不清,冒出来就是一次误报。
 *
 * 顺带记一格 {@link WindowAgentState.answered}(2026-09-26,卡 WS):最新那句是不是它刚说完的回话。
 * 判「在等你」只判它刚说完的那句(他自己说的话不算),所以这一格**不受气泡的抑制条件影响**。
 */
export function nextWindowState(
  prev: WindowAgentState | undefined,
  summary: ReadSummary,
  input: {
    now: Date
    active: boolean
    name: string
    streamingWindowMs?: number
    busyStallMs?: number
    /**
     * **这一家有文件型的会话源**(2026-09-27,卡 GB;`SESSION_SOURCES` 里 `feed: true` 的那几家 ——
     * Claude / Codex / Kimi,见 {@link windowTitleOnly})。它们的在跑 / 做完**以会话文件为准**
     * (`/state.sessions` 那一路:一条一条、有项目、有等待原因),读窗口那一只手在这几家身上
     * **只补标题与最新一句**:不冒任何气泡、不记蓝点、状态一律说不清(`unknown`)。
     *
     * 为什么:真机日志上 `Kimi 回了:Beta`、`Claude 回了:Bash 2m 09s`、`Codex 回了:Edited 2 files+15-6`
     * 全是这几家窗上的界面字 —— 同一件事会话文件里本来就有准数,没必要再拿窗口上的字猜一遍。
     */
    titleOnly?: boolean
  },
): { state: WindowAgentState, bubble?: AgentBubbleView } {
  const at = input.now.toISOString()
  if (!summary.ok) {
    // 读不到窗口:四样沿用上一次读到的,状态说不清。
    const seenStatus = prev === undefined ? undefined : prev.status === 'unknown' ? prev.seen_status : prev.status
    const state: WindowAgentState = {
      status: 'unknown',
      // 这一拍没看成是因为它藏在窗口槽里(2026-10-01):登记表据此换一句话说,不说「没接上」。
      ...(summary.hidden === true ? { hidden: true as const } : {}),
      ...(summary.hidden === true && seenStatus !== undefined ? { seen_status: seenStatus } : {}),
      since: prev?.status === 'unknown' ? prev.since : at,
      ...(prev?.title === undefined ? {} : { title: prev.title }),
      ...(prev?.latest === undefined ? {} : { latest: prev.latest }),
      titles: prev?.titles ?? [],
      at: prev?.at ?? at,
      ...(prev?.signature === undefined ? {} : { signature: prev.signature }),
      ...(prev?.changed_at === undefined ? {} : { changed_at: prev.changed_at }),
      unread: prev?.unread ?? false,
      // 读不到窗口:四样沿用上一次,「它刚答完」也沿用(这一拍什么都没看见,不该把上一拍的事实抹掉)。
      ...(prev?.answered === true ? { answered: true } : {}),
      /*
       * **这中间断了一段**(卡 BB):读不到窗口的这一拍之后,下一拍读到的那一份与断之前那一份
       * 之间发生了什么谁也不知道 —— 那个差不算「它回了一句」。断之前的指纹也一起扔掉(见 `nextSigs`)。
       */
      stale: true,
      // 上一拍那几段的指纹也一起扔掉(断口两边比不得;见 `nextSigs`)。
      // `busy_since` 不带过来:这一拍窗口都读不到,那一串「看见停止键」就此断了。
      ...(prev?.seen === undefined ? {} : { seen: prev.seen }),
      gaps: summary.gaps,
    }
    return { state }
  }
  const windowMs = input.streamingWindowMs ?? STREAMING_WINDOW_MS
  /**
   * **这一拍与上一拍比得吗**(2026-09-27,卡 BB)。比不得的三种:第一次读、上一拍读不到窗口
   * (`unknown`)、上一份读数中间断过({@link WindowAgentState.stale} —— 重启后从盘上来的、
   * 读额度那一下 unhide/藏回去翻过它的窗口)。比不得就**只重新起算**:这一拍认下这份内容当基准,
   * 不冒气泡、不记未读,在不在跑只看窗口里有没有停止键。
   */
  const comparable = prev !== undefined && prev.stale !== true && prev.status !== 'unknown'
  const rebase = !comparable
  const grew = comparable && summary.signature !== undefined && summary.signature !== prev.signature
  /**
   * **来回晃不算变**(卡 BB):这一拍的内容是最近几拍里见过的那一份(见 {@link WindowAgentState.sigs})。
   * 对话区只会往后长;回到几拍前那一份说明这扇窗在两页 / 两扇窗之间来回,不是它又说了一句。
   */
  const flapped = grew && summary.signature !== undefined && (prev?.sigs ?? []).includes(summary.signature)
  /**
   * **整页换掉不算变**(2026-09-27,卡 BB2)。维护者 12:50:「muse 又弹了白色气泡,我点击过去之后,
   * 发现什么都没有,然后白色气泡就没了。」—— 那扇窗从对话翻到了别的一页(它那张「建议你问我」的卡、
   * 一页面板、另一条对话),`signature` 一变就被判成「它还在出字」→ 白气泡;他点过去,那一页上什么都没有。
   *
   * 对话区**只会往后长**:它出字、他又说一句,上一拍读到的那几段里总还剩着一段。
   * **一段都不剩** = 这扇窗翻了一页,不是它又说了一句。
   *
   * **这道闸开得很窄**,三个条件都要够(宁可少挡一次,也不要把真话挡掉):
   * - 两边都读满了三段 —— 只看得见一两段的窗上,他问一句、它答一句就能把那一两段全换掉
   *   (卡 Q 那几条用例就是这么写的),那不是翻页;
   * - 两拍挨得近(还在 {@link STREAMING_WINDOW_MS} 那道口子里)—— 隔了三分钟才读一次的那一家,
   *   这中间真答完一整轮、三段全是新的,是正常的;十几秒里三段全换掉,才是这扇窗翻了一页;
   * - 一段都不重叠。
   */
  const swapped = grew && (prev?.psigs ?? []).length >= 3 && (summary.blocks ?? []).length >= 3
    && comparable && input.now.getTime() - Date.parse(prev.at) <= windowMs
    && !(summary.blocks ?? []).some(one => (prev?.psigs ?? []).includes(one))
  const changed = grew && !flapped && !swapped
  /** 这一串「看见停止键」是什么时候开始的(见 {@link WindowAgentState.busy_since})。 */
  const busySince = summary.busy ? (prev?.busy_since ?? at) : undefined
  /**
   * **停止键卡住了**(卡 BB2):那个键在那儿够久了,而对话区从那之前到现在一个字都没变 ——
   * 真机上 Codex 那扇窗就是这样(见 {@link WindowAgentState.busy_since})。这一拍起不算它在跑,
   * 于是 `prev.status === 'running'` → `justAnswered` → 「回了」那颗蓝点补上。
   */
  const stallFrom = Math.max(Date.parse(busySince ?? at), Date.parse(prev?.changed_at ?? at))
  const busyStalled = summary.busy && !changed && busySince !== undefined && comparable
    && input.now.getTime() - Date.parse(prev.at) <= STALL_MAX_GAP_MS
    && input.now.getTime() - stallFrom > (input.busyStallMs ?? BUSY_STALL_MS)
  /**
   * **窗口型的「在跑」只认形式信号**(2026-09-27,卡 GB)。
   *
   * 维护者 13:25:「现在是不是就有一些气泡会跑出来,一闪而过很诡异」。卡 BB、BB2 补了两轮界面字,
   * 日志里照旧冒:`Kimi 回了:工作区正在准备中`、`Grok Bot 回了:Routines are recurring tasks…`、
   * `Codex 回了:Edited 2 files+15-6`、`Manus 开始跑了`…… —— 那些字**确实变了**,可「变了」不等于「它在跑」:
   * 面板标牌、额度行、状态条、滚动、他自己翻页,每一样都能把指纹改掉。**逐句补界面字是追不完的。**
   *
   * 所以这一拍**看得见停止键**(`summary.busy`)才算在跑;原来那一支 `changed && recent` 去掉了。
   * 停止键认不出的那几家(窗上没有停止键的 App)就**不显示在跑**、也不冒气泡 —— 宁可少,不可假(D13)。
   * `changed` 这一格照旧算,但只用在「最近在做什么」的时刻与读得密不密上,不再撑状态、不再起气泡。
   */
  const status: WindowAgentState['status'] = summary.busy && !busyStalled ? 'running' : 'idle'
  /**
   * **这一家的在跑 / 做完以会话文件为准,窗口这一路只补标题**(2026-09-27,卡 GB;见 `input.titleOnly`)。
   * 这一格为真时:状态一律 `unknown`(说不清,不是「空闲」——不编)、一个气泡都不冒、蓝点不记也不留,
   * 标题 / 最新一句 / 侧栏那几条照读(登记表上那一家缺标题时退回读窗口读到的就是它们)。
   */
  const titleOnly = input.titleOnly === true
  /** 台上、坞上、设置里读的那一格:只补标题那几家一律说不清。 */
  const shown: WindowAgentState['status'] = titleOnly ? 'unknown' : status
  /**
   * **它刚说完一句回话**(卡 WS):与 `replied` 气泡同一个转折,但不受「他正看着那扇窗」抑制 ——
   * 判「在等你」要的是这个事实,不是气泡。它又跑起来 → 不是。
   *
   * **转折只认停止键从有到无那一拍**(2026-09-27,卡 GB;原来还有「内容变了而现在不跑」那一支,
   * 那一支正是幽灵蓝点的出处)。代价是:两拍之间它已经答完了、又一次都没赶上看见那个停止键,
   * 这一回就不冒、也不记蓝点 —— 宁可少,不可假(D13)。
   */
  const justAnswered = comparable && prev !== undefined && status === 'idle' && summary.latest !== undefined
    && prev.status === 'running'
  /**
   * 这扇窗里**还没有一来一回**(对话区里只读到一段话)= 它的开场白 / 一条空对话
   * (真机 09-26:Manus 那扇窗上就只有一句「What can I do for you?」—— 按内容判是「在问你」,
   * 而它谁也没在问)。这一条只挡「在等你」那一档,**不挡气泡**:气泡是卡 Q 定的,这张卡不动它。
   */
  const hasExchange = summary.lines === undefined || summary.lines >= 2
  // 只补标题那几家:「在等你」也以会话文件为准(那一路有真正的等待原因),窗口这一路不下这个判断。
  const answered = titleOnly || status === 'running' ? false : (justAnswered && hasExchange) || (!changed && prev?.answered === true)
  let bubble: AgentBubbleView | undefined
  let unread = prev?.unread ?? false
  if (input.active) {
    unread = false
  }
  // 比不得的那一拍(第一次读、断过、刚重启、刚读过额度)一个气泡都不冒 —— 见 `comparable` 那一段;
  // 只补标题那几家(卡 GB)从来不从这一路冒气泡 —— 见 `titleOnly`。
  else if (!titleOnly && comparable && prev !== undefined) {
    if (status === 'running' && prev.status !== 'running') {
      bubble = { kind: 'started', text: `${input.name} 开始跑了`, at }
    }
    /*
     * 「回了:…」与「做完未读」那颗蓝点(2026-09-26,卡 ST 收紧):**要有过一来一回**才算。
     * 维护者 19:45:「一堆蓝色气泡,我点过了也不消失」—— 卡 WS 把 `hasExchange` 只用在「在等你」那一档,
     * 明写着「不挡气泡」;真机 18:50 证明气泡这一档也得挡:一扇只有开场白 / 只有额度页 / 只有 App 标牌的窗
     * 照样会一路冒「X 回了:…」并记成未读。现在气泡与 `answered` 同一道闸(只读到一段话 = 还没有一来一回)。
     */
    else if (justAnswered && hasExchange && summary.latest !== undefined) {
      bubble = { kind: 'replied', text: `${input.name} 回了:${clipText(summary.latest, 40)}`, at }
      unread = true
    }
  }
  /*
   * **没有一句它说的话 = 没有什么"没看过"**(2026-09-26,卡 AC)。
   *
   * 上面收紧了「这一行不是它说的话」的判法(额度页里不带 % 的重置行也剔掉了),可 `unread` 是
   * 一路沿用下来的:那些**已经按老判法记下的假蓝点**(21:38 生产上豆包办公那一颗)不会因为
   * 判法变了就自己灭 —— 他得去点一下,或者把那个 App 切到前台。
   * 这一条把它补上:这一拍读得到窗口、而对话区里**一句它说的话都没剩下**(latest 没了),
   * 那颗蓝点就该灭 —— 蓝点的意思是「它答完了、你还没看」,没有那句话就没有那件事。
   * (读不到窗口走上面那一支,沿用上一次,不受这条影响 —— 那一拍什么都没看见,不该抹掉事实。)
   */
  if (summary.latest === undefined) unread = false
  /*
   * 只补标题那几家(卡 GB):蓝点一律不留 —— 连**上一拍存着的那一颗**也灭掉,那是老判法
   * (窗口上的字变了就记未读)记下的,判法变了它不会自己灭(同卡 AC 那一条的道理)。
   */
  if (titleOnly) unread = false
  const state: WindowAgentState = {
    status: shown,
    since: prev !== undefined && prev.status === shown ? prev.since : at,
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.latest === undefined ? {} : { latest: summary.latest }),
    titles: summary.titles,
    at,
    ...(summary.signature === undefined ? {} : { signature: summary.signature }),
    /*
     * 第一次读:不知道它什么时候变的,就按这一次读的时刻(宁可偏晚也不编一个更早的)。
     * **重新起算**那一拍(卡 BB:刚重启、断过、刚读过额度)照旧沿用上一次记下的那个时刻 ——
     * 那一拍没看见它变,把「最近在做什么」的时刻改成现在就是编一个更近的。
     */
    ...(changed ? { changed_at: at } : prev?.changed_at === undefined ? { changed_at: at } : { changed_at: prev.changed_at }),
    ...(() => {
      const sigs = nextSigs(prev?.sigs, summary.signature, rebase)
      return sigs === undefined || sigs.length === 0 ? {} : { sigs }
    })(),
    // 这一拍每一段的指纹(卡 BB2:下一拍判「整页换掉」用);读不到字就沿用上一拍的。
    ...(() => {
      const psigs = summary.blocks === undefined ? prev?.psigs : [...summary.blocks]
      return psigs === undefined || psigs.length === 0 ? {} : { psigs }
    })(),
    ...(busySince === undefined ? {} : { busy_since: busySince }),
    unread,
    ...(answered ? { answered: true } : {}),
    ...(() => {
      const seen = nextSeen(prev?.seen, summary, titleOnly ? 'idle' : status, at)
      return seen === undefined ? {} : { seen }
    })(),
    gaps: titleOnly
      ? { ...summary.gaps, status: `${input.name} 在不在跑以它的会话文件为准,读窗口这一路只补标题` }
      : summary.gaps,
  }
  return { state, ...(bubble === undefined ? {} : { bubble }) }
}

// ───────────────────────────── 读进度字补「在跑」(各家) ─────────────────────────────

/** 两步之间那一下空档:看见过在跑之后,再等这么久没有新进度才算做完。 */
export const PROGRESS_GRACE_MS = 30_000

export interface ProgressSeen {
  at: number
  title?: string
  /** 主对话区那几行拼起来(看见在跑之后正文还在变,空档就续期;2026-09-28 Air 维护包)。 */
  signature?: string
  /** 进度行上那个秒表此刻写着什么、第一次读到这个数是什么时候(秒表停住 = 画面停住,见 `PROGRESS_FROZEN_MS`)。 */
  timer?: string
  timer_at?: number
  /** 秒表停住、已判成读到的是停住的画面:同一条对话上不再凭空档续成在跑。 */
  frozen?: true
}

/**
 * **秒表这么久没动,就是读到了一张停住的画面**(2026-10-08 千问办公真机)。
 * 她切走后窗被藏着,Chromium 的辅助功能树停在藏起那一刻:「规划中 ... 13.7s」挂了三分钟一下没动,放出来一读回答早就在了。
 * 在跑时每 5 秒读一次,秒表精确到 0.1 秒,真在走的不会连着两次一样。停住的画面说不了「它在跑」,于是这一刻起不算在跑 → 「回了」那颗蓝点出来;她点开时画面一刷新,真在跑的会再判回来。
 */
export const PROGRESS_FROZEN_MS = 10_000
const PROGRESS_TIMER = /(\d+(?:\.\d+)?\s*(?:s|秒|ms))\s*$/u

/** 进度行尾巴上的省略号与秒表(千问办公「正在思考 ... 7.3s」)。 */
const PROGRESS_TAIL = /(?:\s*(?:…+|\.{2,}|\d+(?:\.\d+)?\s*(?:s|秒|ms)))+$/u
/** 「正在 + 一个短动词」或「×× 中」:正在思考 / 正在写入文件 / 处理中 / 思考中。一整句话不算(那是回答)。 */
const PROGRESS_ZH = /^(?:正在[\p{Script=Han}A-Za-z]{1,6}|[\p{Script=Han}]{1,4}中)$/u
const PROGRESS_EN = /^(?:thinking|working|generating|searching|reasoning|running|writing|reading|analy[sz]ing)$/i
/** 同一行的几块字纵向差不到这么多就拼成一行(壳把一行拆成好几块:字、省略号、秒表)。 */
const SAME_LINE_PX = 6

export function isProgressLine(text: string): boolean {
  const t = text.trim().replace(PROGRESS_TAIL, '').trim()
  return PROGRESS_ZH.test(t) || PROGRESS_EN.test(t)
}

/**
 * **窗口上写着进度,就是在跑**(2026-09-28 豆包办公起;2026-10-08 起各家都认)。
 *
 * 不少家跑的时候那颗停止键是个没字的图标(壳读不进 `stop`),或者压根没有停止键
 * (千问办公只在输入框上面挂一条「正在思考 ... 7.3s」,输入框改成「添加到队列」)。
 * 原来只补 Air 上那一个豆包包(`com.work.pc.doubao`),本机的豆包、千问办公都漏了 —— 判空闲 → 气泡和事务官卡片一起没有。
 *
 * - 输入框上方、对话区**屏上最下面那一行**(同一行的几块拼起来,去掉末尾省略号与秒表)是一句进度 → 在跑,记下 `seen`;
 * - 之前看见过在跑、**同一条对话**、离上次看见不到 30 秒 → 还算在跑(两步之间的空档);
 * - 从没看见过在跑 → 字怎么变都不凭空起一件事。
 * Claude / Codex / Kimi 的在跑以会话文件为准,窗口这一路对它们只补标题(调用方 `windowTitleOnly` 那一格)。
 */
export function windowProgressBusy(input: {
  bundleId: string
  read: WindowRead
  title?: string
  nowMs: number
  seen?: ProgressSeen
}): { busy: boolean, seen?: ProgressSeen } {
  const { read } = input
  if (!read.running || read.ax_err !== undefined || read.window === undefined) return { busy: false }
  const rows = read.tail.filter((one) => {
    if (one.ctl === true) return false
    if (read.sidebar !== undefined && one.x < read.sidebar.x + read.sidebar.w) return false
    // 输入框下面的、**输入框右边那一栏**(豆包右侧的摘要区)都不是主对话区(2026-09-28 Air 维护包)。
    if (read.input !== undefined && (one.y + one.h > read.input.y || one.x >= read.input.x + read.input.w)) return false
    return one.t.trim() !== ''
  })
    // 辅助功能树的遍历顺序不等于从上到下(右侧摘要区会排在后面):按纵坐标排,「最后一行」才是屏上最下面那行。
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const signature = rows.map(row => row.t.trim()).join('\n')
  const bottom = rows[rows.length - 1]
  const last = bottom === undefined
    ? undefined
    : rows.filter(row => Math.abs(row.y - bottom.y) <= SAME_LINE_PX).sort((a, b) => a.x - b.x).map(row => row.t.trim()).join(' ')
  const seen = input.seen
  if (last !== undefined && isProgressLine(last)) {
    const timer = PROGRESS_TIMER.exec(last)?.[1]
    const sameTimer = timer !== undefined && seen !== undefined && seen.title === input.title && seen.timer === timer && seen.timer_at !== undefined
    const timerAt = sameTimer ? seen.timer_at as number : input.nowMs
    const base = { at: input.nowMs, signature, ...(input.title === undefined ? {} : { title: input.title }), ...(timer === undefined ? {} : { timer, timer_at: timerAt }) }
    if (sameTimer && input.nowMs - timerAt >= PROGRESS_FROZEN_MS) return { busy: false, seen: { ...base, frozen: true } }
    return { busy: true, seen: base }
  }
  /*
   * 两步之间那一下空档只给**不带秒表**的进度字(豆包:「正在写入文件」两步之间会空一拍)。
   * 带秒表的那种进度条(千问办公)从头挂到尾,它一消失就是做完了 —— 再等 30 秒,她听见完成音扫过去还是「运行中」(10-08)。
   */
  if (seen !== undefined && seen.frozen !== true && seen.timer === undefined && seen.title === input.title && input.nowMs - seen.at < PROGRESS_GRACE_MS) {
    // 看见过在跑、正文还在变(两步之间它在出字)→ 续期;正文静止满 30 秒才算做完。
    return { busy: true, seen: seen.signature !== undefined && signature !== seen.signature ? { ...seen, at: input.nowMs, signature } : seen }
  }
  return { busy: false }
}

// ───────────────────────────── 豆包办公:窗口里摆着的那道选择题 ─────────────────────────────

/** 主区标记那一行:维护包 `com.work.pc.doubao` 逐字写这一个词。 */
export const ASK_MARKER_TEXT = '正在询问用户'
/** 普通包 `com.bot.pc.doubao` 在同一个位置写的是工具调用的人话名(「询问用户饮品偏好」),只认这个开头。 */
export const ASK_MARKER_PREFIX = '询问用户'

/**
 * 主区这一行是不是「摆着题」的标记(2026-10-13)。
 *
 * 放宽到「开头对上」而不加长度上限:认不出题就不打电话(她那一通就是这么丢的),
 * 误认的代价只是多排一通 —— 而问号行与成组短行那两条仍然卡着,正文里碰巧这么开头的进不来。
 */
/**
 * 工具调用那一行的名字是模型现起的(10-13 两次真读数:「询问用户饮品偏好」「发起饮料偏好提问」),按字认永远漏。
 * 它上面那一行「已处理 N 分 N 秒」是豆包自己写的、形状固定 —— 也当标记。
 */
export const ASK_MARKER_PROCESSED = /^已处理\s*(?:\d+\s*分\s*)?\d+\s*秒$/u

export function isAskMarkerLine(text: string): boolean {
  const t = text.trim()
  return t === ASK_MARKER_TEXT || t.startsWith(ASK_MARKER_PREFIX) || ASK_MARKER_PROCESSED.test(t)
}

/**
 * 问题底下那一片里的界面字(2026-10-13)。
 *
 * 比 `isChromeLine` 少一条:**一个字的行不当界面字**。选项标签真有一个字的(普通包 10-13 那份读数里的「茶」),
 * 按 `isChromeLine` 筛会把它漏掉 —— 题照样认出来,但念出来、能按的只剩三项。
 */
function isFormChrome(text: string): boolean {
  const t = text.trim()
  return [...t].length > 1 && isChromeLine(t)
}

/**
 * **豆包办公窗口里摆着一道选择题等她**(2026-09-28,Air 维护包回源码)。
 *
 * 现场:豆包问了一道带三个选项的题,电脑和手机的「等你确认」里都没有,也不打电话 —— 窗口型那一路
 * 从来不出「形式上的」一问(`by:'form'`),来电那一路又只扫文件型会话。认法(都要对上才算):
 * - 侧栏里有一行以「待确认」结尾;
 * - 主对话区(输入框上方、不在侧栏、横向落在输入框那一列)里有一行是标记(见 `isAskMarkerLine`);
 * - 它后面第一行带问号的是问题;问题下面、左边对齐、同样高的那几行(2~8 行,每行不超过 60 字)是选项。
 * 同一道题(问题和选项都没变)沿用上一次的 `since` —— 电话一件只打一次靠它。
 * 豆包一家几个包(豆包 / 豆包办公 / 豆包工作)都按这一套认(2026-10-12;调用方按家族 `familyAsksInWindow` 判)。
 * 两份真机读数都绿:维护包 09-28 那份写逐字标记,普通包 10-13 那份写工具名(`tests/fixtures/doubao-read-asking-*.json`)。
 */
export function doubaoVisibleForm(read: WindowRead, previous: SessionAskView | undefined, at: string, name = '豆包'): SessionAskView | undefined {
  const input = read.input
  if (!read.running || input === undefined || read.ax_err !== undefined) return undefined
  if (!read.side.some(row => /待确认\s*$/u.test(row.t))) return undefined
  const rows = read.tail
    .filter(row => row.ctl !== true && !inSidebar(row, read.sidebar) && row.y + row.h / 2 < input.y && row.x >= input.x - 24 && row.x < input.x + input.w)
    .sort((a, b) => a.y - b.y)
  let marker = -1
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isAskMarkerLine((rows[i] as { t: string }).t)) { marker = i; break }
  }
  if (marker < 0) return undefined
  const question = rows.slice(marker + 1).find(row => /[？?]/u.test(row.t))
  if (question === undefined) return undefined
  const remaining = rows.filter(row => row.y >= question.y + question.h && row.t.trim() !== '' && !isFormChrome(row.t))
  const first = remaining[0]
  if (first === undefined) return undefined
  const options = remaining
    .filter(row => Math.abs(row.x - first.x) < 3 && Math.abs(row.h - first.h) < 1 && [...row.t.trim()].length <= 60)
    .map(row => ({ label: row.t.trim() }))
  if (options.length < 2 || options.length > 8) return undefined
  const q = question.t.trim()
  const same = previous?.question === q && JSON.stringify(previous.options) === JSON.stringify(options)
  return {
    kind: 'choose',
    question: q,
    options,
    since: same && previous !== undefined ? previous.since : at,
    quote: q,
    by: 'form',
    reply: 'desk',
    press: true,
    write: true,
    reveal: true,
    where: `${name}正在等你选择`,
  } as SessionAskView
}
