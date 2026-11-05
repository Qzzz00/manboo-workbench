/**
 * 送话引擎的契约(2026-10-02,`docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节)。
 *
 * 「往别家 AI 送一句话、把回答拿回来」只有**一条**引擎、每家**一个**适配器。
 * 适配器按这一家真正的通道实现:协议(Codex app-server、Claude 跨会话 socket)优先,
 * 窗口(辅助功能树)只留给只有窗口的那几家,而且窗口型共用一个 `WindowAdapter`。
 *
 * 这个文件只有类型与常量,没有实现、没有 I/O。改这里 = 改契约,所有适配器与引擎同一分支里一起改。
 */

import type { JobKind as ProtocolJobKind } from '../../protocol.ts'

/**
 * 用的哪条通道。`api` = 经工作台中转打到云上模型的接口(2026-10-03 收进引擎;它既不是那家 App 的协议,也不是窗口);
 * `none` = 一条通道都没用上。每一种都得念得出人话({@link VIA_TEXT}),账上、日志里、交接里都用那一句。
 */
export type JobVia = 'protocol' | 'cli' | 'api' | 'file' | 'window' | 'none'

/** 每条通道怎么念(一处写;账那一行、日志、给她的话都用它)。**新加一种 via 必须加一行**,有用例钉着。 */
export const VIA_TEXT: Readonly<Record<JobVia, string>> = {
  protocol: '协议',
  cli: '命令行',
  api: '接口',
  file: '记录文件',
  window: '窗口',
  none: '没有通道',
}

/** 她要它干什么。六种,对应原来六只手 + 派活。 */
export type JobKind =
  /** 替她答:它在等她,送她的回答进去。 */
  | 'answer'
  /** 捎话:它在跑,往里补一句。 */
  | 'relay'
  /** 派活:新开一条(或指定一条)把交代送进去。 */
  | 'dispatch'
  /** 替她点它框上的一项(选项 / 批准一次 / 拒绝)。 */
  | 'press'
  /** 往它的提问面板里写字。 */
  | 'write_ask'
  /** 按停止。 */
  | 'stop'

/**
 * 送到哪一段对话。
 *
 * - `session` 她指名的那一段(有会话 id / threadId);
 * - `new` 新开一条(派活);
 * - `current` **它此刻正开着的那条**:不新开、也不切过去。2026-10-02 加的那一种,
 *   两条真路要它:自查没过**打回同一条对话**让它改一遍(`dispatchRun` 的返工),
 *   以及 `/dispatch/client` 没要求新开那一种。从前这两条靠「不发 `new_conversation`」表达,
 *   引擎上得说得出来 —— 协议那两条认不出「此刻开着的那条」,会如实回 `unsupported`,引擎换窗口那条路。
 */
export type JobTarget =
  | { kind: 'session', sessionId: string }
  | { kind: 'new' }
  | { kind: 'current' }

export interface Job {
  id: string
  /** 哪一家(家族目录里的家名,不是包标识)。 */
  family: string
  /** 她点名了哪个包(一家多包时);缺席由家族目录解析。 */
  package?: string
  kind: JobKind
  target: JobTarget
  /** 送进去的字(答 / 捎话 / 交代),或要点的那一项的名字(press)。 */
  text: string
  /** 认那一段对话 / 那个框用的几截原话(窗口型才用得着;协议型忽略)。 */
  marks?: readonly string[]
  /** 期望什么:`reply` 要等它回话;`ack` 只要送到;`none` 点一下就完。 */
  expect: 'reply' | 'ack' | 'none'
  /** 这一件对应看板上的哪张卡(有就带,没有不硬造)。 */
  itemId?: string
  /**
   * ★ **这一下是她亲口 / 亲手交代的**(2026-10-13 夜,卡 Y):手机输入框里往某条会话捎的话、电话里点名捎话。
   * 闸的「收场了就不再动那一家」是拦工作台**自动**追着办的那几条管线的(盯窗、重派、巡检);她自己往一条
   * 早就办完的会话里再说一句,是新的交代,不该被旧卡的状态拦(真机:GoSim 那条,卡已办完 → 「这件已经收场了」)。
   * 缺席 = 自动的,照旧拦。
   */
  by?: 'user'
  /** 最晚等到什么时候(ISO)。 */
  deadline?: string
  /**
   * 这是第几次派这同一件事(1 = 第一次)。重派(她点卡再派一次、自查没过打回)带 2 起,
   * 引擎据此过闸的 `dispatch_resend` 那一档;缺席当 1。
   */
  attempt?: number
  /**
   * ★ **送完要不要替她按发送**(缺省 `true`;2026-09-22 Ben 定的 A2)。
   *
   * 原话:「送话进窗口:事务官主动派的替按回车,用户手点的不按。」
   * 她自己在界面上点「送进窗口」那一种(`source:'ui'`)、以及统一输入框里「先问我」那一档,
   * 要的是**字进了框、她自己按** —— 那两件在她眼里本来就是两下。
   * `false` 时**没有任何证据可核**(一个字都没发出去),所以结局一定是 `unconfirmed` + 一句实话。
   */
  submit?: boolean
  /**
   * **送完拿这一截字在它的对话区里核一眼**(卡上 / 账上记着的那个记号;2026-09-28 卡 WR)。
   *
   * 为什么不从 {@link text} 里现取:派活那一段话前面有个「【工作台派活 xxxxxx】」,
   * **盯窗那条巡检后来按的就是那个记号**;送完核那一眼要是按别的字去找,两头就对不上。
   * 缺席 = 从送进去那段话本身取(捎话 / 替她答那两路就是这样)。
   */
  confirmMark?: string
  /**
   * ★ **锁着屏时这件派活排队等解锁**(2026-10-12,卡「锁屏派活排队」)。只对 `kind:'dispatch'` 有意义,
   * 而且要有 {@link itemId}(排队按「这件事 + 派给哪家」去重,没有事项就没有可去重的东西)。
   *
   * 为什么是调用方明说、而不是所有派活都排:解锁之后要**回到派活的正常流程**(卡挪「在办」、盯窗读回话、
   * 自查),那只有 `dispatchRun` 那一条路接得住;界面上点「送进窗口」、返工打回、捎话新开一条
   * 那几条路排了也没人收尾。缺席 = 不排(如实说「解锁了再叫我一次」)。
   */
  waitUnlock?: true
  /**
   * ★ **只认它的这一轮**(2026-10-03,审计第二节第 2 条;`read` 用)。送那一刻对端报的轮号
   * ({@link JobResult.turnId})记在卡上 / 账上,巡检读的时候原样带回来:协议型按它找那一轮
   * (她自己又在那条线程里发了一句也不会认错);缺席 = 认最后一轮(老账、窗口型)。
   */
  turnId?: string
  /**
   * ★ **这件派活是哪一种活**(2026-10-03,卡「派活三只手收进引擎」;只有 `kind:'dispatch'` 带)。
   * 主人是 `protocol.ts` 的 `JobKind`(写代码 / 聊天 / 在电脑上动手)。登记表按它留通道:
   * 写代码只走命令行(沙箱、改文件),在电脑上动手只走窗口,聊天全留(协议 > 窗口 > 命令行 > 接口,后两条是备用)。
   */
  work?: WorkKind
  /** 在哪个目录里干(命令行那一条起进程的地方;接口那一条当上下文)。调用方算好(含独立工作区)再给。 */
  cwd?: string
  /** 挂在哪个项目(接口那一条当上下文)。 */
  project?: string
  /**
   * 名片带的模型名(2026-10-22 卡 D):命令行适配器照它拼 `claude --model` / `kimi -m` / `codex -m`。
   */
  model?: string
  effort?: 'low' | 'medium' | 'high'
  attemptId?: string
  /**
   * 名片带的智能体文件(2026-10-22 卡 D):kimi `--agent-file` 用;相对路径相对 {@link cwd} 化。
   * 派发那一层已用 `pickAgentFile` 解析成绝对路径(先 project.repo 后 cwd)。
   */
  agentFile?: string
  /**
   * **这次不带 `--agent-file`**(2026-10-29,任务书「派活智能体文件与起跑换手」):派发那一层解析过
   * 智能体文件、决定不带(文件不存在 / 用户层那条路),kimi 适配器据此连缺省那一份也不加 ——
   * 缺省路径相对任务 cwd 拼,用户层那条路上它永远不存在,命令行一起就退。
   */
  agentFileOmit?: boolean
  /**
   * ★ **她这一句勾了「回了打电话给我」没有**(2026-10-04,卡 `claude/relay-call-optin`;只有 `kind:'relay'` 带)。
   *
   * 引擎自己**一下都不读它** —— 它在这儿只为了跟着这件活过一次落盘:电脑锁着屏时捎话会被排进
   * `engine/lockQueue.ts`(落盘的就是这份 `Job`),解锁重送成了之后由接线那一处补登记回电
   * (`index.ts` 的 `drain.after`),那一刻必须知道**她当初勾没勾**。缺席 = 没勾(不回电,只发通知)。
   */
  callOnReply?: true
  /**
   * ★ **这一件只许走这几条通道**(2026-10-20,卡 D;缺席 = 不限)。
   *
   * 终端 / VS Code 里开的会话只有协议那只手够得着(socket / `thread/resume`);窗口那只手开的是桌面 App,
   * 认不出那段对话也照发(卡 AW),让它接手就是把她的话打进别的对话。判据在登记处一处(`picksFor`),
   * 引擎的送 / 读 / 去回答 / 读弹框都经过它。谁该限、限到哪几条由 `sessionAnswer.answerViasOf` 一处定。
   */
  vias?: readonly JobVia[]
  /**
   * 她的原话。接口那一条**只送这个** + 它自己的系统提示(`dispatchApi.ts`);窗口 / 协议 / 命令行送的是 {@link text}
   * 那一整段(「【工作台派活 xxx】+ 规矩」)—— 同一个 Job 两条路要两份字,今天就是这样。
   */
  brief?: string
}

/** 这件派活是哪一种活:`protocol.ts` 的 `JobKind`('code' / 'chat' / 'desk'),这里只是借个名字,不另定义一套。 */
export type WorkKind = ProtocolJobKind

/**
 * 三种结局同一套字段(卡 AW 10-01 定的,这里只是收成一处):
 * - `delivered:'confirmed'`:有证据送到了(协议回执 / 记录文件多出那句 / 窗口里出现了)
 * - `delivered:'unconfirmed'`:按了发送 / 调了协议,但证据没核上 —— **一个字不说成送到了**
 * - `delivered:'not_sent'`:没送,`why` 是人话
 */
export interface JobResult {
  delivered: 'confirmed' | 'unconfirmed' | 'not_sent'
  /** 它的回话(`expect:'reply'` 且拿到了)。 */
  reply?: string
  /** 送到哪一段(新开的那条 id、或 Codex 的 threadId)。 */
  sessionId?: string
  /**
   * 送进去的是它的**哪一轮**(Codex `turn/start` 回包 / `turn/started` 报的 id;2026-10-03)。
   * 消费方记下来,读回话时按 {@link Job.turnId} 只认这一轮。只有协议型报得出;窗口型缺席。
   */
  turnId?: string
  /**
   * ★ **命令行那一条:进程起来了**(2026-10-03,卡「派活三只手收进引擎」)。命令行的「送到」= 进程起来了,
   * 结果要等它退出(由 `dispatchRun.finishCli` 按卡上记的 pid / 结果文件收)。`exited` 只在内存里走,账上不记它。
   */
  process?: { pid: number, output_file: string, log_file: string, exited: Promise<{ code: number | null }> }
  /** 证据是哪一种,给日志与交接看。 */
  evidence?: 'receipt' | 'transcript' | 'window' | 'none'
  /** 用的哪条通道;`none` = 一条通道都没用上(这一家没有一条能办这件事)。 */
  via: JobVia
  /** 没送 / 没核上时的人话;要她做什么写清楚。 */
  why?: string
  /** 这一家没这个能力(比如窗口型不能 stop)时真;上层据此换路或如实说。 */
  unsupported?: boolean
  /**
   * ★ **这一下是动作闸拦下的,不是那扇窗上的事实**(2026-10-02,接线那张卡;
   * 从前是 `sessionAnswer.HandBlocked` 那一格)。
   *
   * 为什么要这一格:`not_sent` 在消费方那一层有时会**换一条路办同一件事**
   * (框已经收掉了 → 把她点的那一项当一句话发进对话,2026-09-28 卡 WQ)。
   * 闸拦下的那一下要是也只报 `not_sent`,就会从拦下的那条路漏到另一条路上去 —— 等于没拦。
   * **见了它,一条替代的路都不许走。**
   */
  blocked?: true
  /**
   * ★ **这一下是同一句刚捎过、被静默合并的重复**(2026-10-23,卡「捎话节流闸误拦」)。
   *
   * 为什么要有这一格、为什么不只靠 `why` 那句话:闸的 `relay_send` 按内容指纹去重 ——
   * 同一件事 · 同一句原话在 1 秒窗口内重复,第一次放行、其余**静默合并**(不拦、不计数)。
   * 重复那一下到引擎就是这一格:**一个字都不再送**,而消费方也不能照「没送成」说话 ——
   * 那句原话第一次那一下已经在送 / 已经送进那条会话了。
   *
   * 两条纪律:
   * - 这一格为真时 `delivered` 一定是 `not_sent`(这一下没有真的再送),但**没有** `blocked`
   *   (不是被闸拦下,是同一回);
   * - 消费方见了它照「已按这一句办过」回(捎话那一路回 ok + {@link RELAY_DEDUPED_NOTE}),
   *   **不当成失败、不重试**。
   */
  deduped?: true
  /**
   * ★ **这一下没送是因为「电脑锁着屏」**(2026-10-03,卡「锁屏时窗口型的家送不进」;
   * 主人 = 这个契约文件,消费方在同一个分支里改完了,逐条写在
   * `docs/交接-1003-锁屏时窗口型的家.md` 第五节)。
   *
   * 为什么要这一格、为什么不只靠 `why` 那句话:锁着屏时窗口型那几家**起不出窗、辅助功能一扇窗都列不出**,
   * 壳只能报「一扇标准窗口都没有」——而那一类失败在这一层本来的下一步是
   * **把它的窗开出来再来一遍 / 换同一家另一个包**(`windowWake` 那 3 回 + `swapError`)。
   * 锁着屏时那两下一次都不该做(2026-10-03 09:04 真机:7 秒里 `open -b` 五次,一下都没用),
   * 而且**这一件该排进队等解锁**(`engine/lockQueue.ts`)。
   *
   * 三条纪律:
   * - 这一格为真时 `delivered` 一定是 `not_sent`(一个字都没送出去);
   * - 消费方见了它**一条替代的路都不许走**(同 {@link blocked}:换一条路也一样撞上锁屏),
   *   该说的是那一句人话(`screenLock.screenLockedSay` 一处);
   *   ★ 例外只有一处、在引擎里(2026-10-12):**派活**撞上锁屏,不靠窗口的通道(命令行 / 接口)接着试 ——
   *   那几条不经窗口、不受锁屏影响,本来就是派活的备用;引擎往外回的这一格仍是「这件事最后没送出去、因为锁屏」;
   * - 「不知道锁没锁」**不许当成锁着**(老壳不报这一格)→ 这一格缺席,行为一字不变。
   */
  screenLocked?: true
  /**
   * ★ **这条会话没开着**(2026-10-23,卡「捎话到没开着的会话留言等它醒」;
   * 主人 = 这个契约文件,消费方在同一个分支里改完了)。
   *
   * 现场:维护者 07:36 在手机上给统筹会话捎话,那条 Claude 会话进程 07:37 才起 ——
   * 协议手(Claude socket)在登记表里找不到这条会话,如实回「没开着」。从前这一句就丢了,
   * 现在引擎据此**排进队等它醒**(与 {@link screenLocked} 同一个意思、同一本队)。
   *
   * 三条纪律(与 {@link screenLocked} 同款):
   * - 这一格为真时 `delivered` 一定是 `not_sent`(一个字都没送出去);
   * - 消费方见了它**一条替代的路都不许走**(同 {@link blocked}:换一条通道也认不出这段对话),
   *   该说的是那一句人话(`sessionClosed.SESSION_CLOSED_QUEUED_SAY` 一处);
   * - 缺席 = 老行为,一字不变。
   */
  sessionClosed?: true
  /**
   * ★ **锁着屏、而且这一件真排上队了**(2026-10-12,卡「锁屏派活排队」;只由引擎填)。
   * 消费方据此说「解锁了就送」、卡上挂「在等你解锁电脑」;缺席 = 没排上(那一下真的没了,不许装作在等)。
   */
  lockQueued?: true
  /**
   * ★ **这一家的窗口通道堵了**(2026-10-21,卡「派活按家隔离」;只由引擎填,`familyLanes.ts`)。
   * 这一下超了硬上限、或者那一家堵着还没到再探的时候 —— `why` 是那句人话(哪家、哪一步、等了多久)。
   * 消费方见了它:**这不是「它还没回」,也不是「没看到那一句」**,卡上挂那句话、下一拍再探,别家照常。
   */
  jammed?: true
  /**
   * **真动到的那个包**(2026-09-30 止血,根子 1)。回电巡检按它读窗 —— 两个豆包时按家名会查到另一扇。
   * 只有真跟那扇窗说过话才有(协议型、一个 op 都没发出去的那几种缺席)。
   */
  bundle_id?: string
  /**
   * **回执说按下发送了没有**(窗口那条才有)。
   *
   * ★ **回执不等于送到**:真机上豆包按了发送、回执说没发(2026-09-28 Air 维护包),
   * 所以「送到没送到」永远看 {@link delivered};这一格只回答「我们那一下到底按下去了没有」——
   * 卡上「字写进框里了,没发出去」(`status:'typed'`)那一句的出处就是它。
   */
  submitted?: boolean
  /**
   * **框里她没发出去的那段字**(2026-09-27,卡 DB):存哪了 / 放回去了没有 + 一句人话。
   *
   * 2026-10-02 收成一份(审计第二表第 4 条):从前 `dispatchClient` 与 `sessionAnswer` 各存一份、
   * 行为还不一样(一处存不下照样算送出并说,一处存不下就判失败、存下了不说)。
   * 现在只有窗口适配器这一处存,**存不下来的不许盖掉**那条老规矩没动。
   */
  draft?: { saved: boolean, saved_to?: string, returned: boolean, note: string }
  /**
   * **替她按掉了她窗口上的一层框**(2026-09-28,卡 DP:那种「×」推广框)。
   * 替她按了键就**一定要说一句**,不许做完不说(审计第二表第 5 条:从前只有派活那一处说)。
   */
  modalClosed?: string
  /**
   * **字是怎么进去的**(壳回包里那一格:`ax_value` 打属性 / `paste` 粘贴 / …)。
   * 只进卡上那一格与排障 —— 不说给她听(她不认这几个词)。
   */
  method?: string
  /**
   * **「新开一条」那一下壳到底怎么开的**(壳回包里那一格:菜单项的名字,或者 `single_thread`)。
   *
   * 为什么要带上来:Muse 那种**只有一条对话**的 App 开不出新的,壳如实报 `single_thread` ——
   * 卡上那句话据此说「它只有一条对话,送进了那一条」。少了这一格,工作台会对她说
   * 「新开了一条对话」,而那是**一句不实的话**。
   */
  newConversation?: string
}

/**
 * **权限弹框上读到的一块**(相对那扇窗左上角)。
 *
 * 结构与 `approvalKeys.ApprovalPanelRead` 相同,**契约里不 import 实现** ——
 * 挑哪一块、哪几颗键算「批准一次 / 拒绝」由 `approvalKeys.ts` 一处判(这里只是原样搬运)。
 */
export interface ApprovalPanelSeen {
  rect: { x: number, y: number, w: number, h: number }
  keys: readonly string[]
}

/**
 * **只读一眼那一段此刻的回话**的结论({@link Adapter.read})。
 *
 * 三种分得清,**「读不到」不许说成「它还没回」**:
 * ① 读到了、写完了 → `reply`;② 读到了、它还在写 → `busy:true` + 没有 `reply`;
 * ③ 读不到(壳没连上 / 这一拍失败)→ `evidence:'none'` + 一句实话。
 */
export interface AdapterReadResult {
  reply?: string
  /** 通道堵了(只由引擎填,见 {@link JobResult.jammed})。 */
  jammed?: true
  evidence?: JobResult['evidence']
  via: JobResult['via']
  why?: string
  /**
   * 它**还在写**(窗口里停止键还在 / 进度条在动;协议型:这一轮还没 `turn/completed`)。
   * 与「读不到」分开报 —— 巡检据此决定「再等一拍」还是「如实说读不到」。
   */
  busy?: boolean
  /**
   * ★ **这条通道此刻读不了这一段**(2026-10-04,卡「Codex 线程被占时换路」;
   * 主人 = 这个契约文件,消费方在同一个分支里改完了,逐条写在
   * `docs/交接-1004-Codex线程被占时换路.md` 第四节)。
   *
   * 与送话那一侧的 {@link JobResult.unsupported} 同一个意思、同一条下一步:**换队里下一条通道**
   * (`Engine.read` 一处换)。出处是真机那一条:她的 Codex App 开着那条线程、握着写入锁,
   * `thread/resume` 进不去,于是协议这头**连读都读不了** —— 而窗口那条照样读得到那扇窗。
   *
   * 两条纪律:
   * - 它为真时一定没有 `reply`、也没有 `busy`(**读不到不许说成「它还没回」**);
   * - 缺席(老实现、没这回事)行为一字不变:照旧只有那一条通道,`why` 原样交上去。
   */
  unsupported?: true
}

/**
 * **读一眼时「在它那边看见我们那一句了」算哪几种证据**(2026-10-09,一处写:派活盯窗、「只盯不发」都照它)。
 * `transcript` = 它自己的记录里有那一句(协议读回的那一轮 / 「记录文件」那条通道在它库里找到了那一句)。
 */
export const READ_SEEN_EVIDENCE: readonly NonNullable<JobResult['evidence']>[] = ['window', 'receipt', 'transcript']

/** 只看一眼那个权限弹框的结论(**一颗键都没按**)。 */
export interface ApprovalReadResult {
  panels: readonly ApprovalPanelSeen[]
  via: JobResult['via']
  /** 读不到 / 这一家没这一样时的人话(`panels` 是空的时候才有)。 */
  why?: string
}

/** 这家在这台机器上能做哪几样(适配器现查,不写死)。 */
export interface AdapterCapabilities {
  open: boolean
  send: boolean
  read: boolean
  /** 能不能替她点它**明写的**那一项(「要 A 还是 B」)。 */
  press: boolean
  /**
   * 能不能**看 / 按它那个权限弹框**(2026-10-02,接线那张卡补的一格)。
   *
   * 与 {@link press} 分开的理由:界面上这两格是两样东西 —— 它明写的选项摆成按钮靠 `press`,
   * 「批准一次 / 拒绝」那两颗键靠这一格。从前这两格在 `sessionAnswer` 的两只手上各判一份
   * (`canPress` / `canApprove`),于是「界面摆着能点、点下去说到电脑上点」(D13)。
   */
  approve: boolean
  /**
   * 能不能**往它那个提问面板里写字**(2026-10-02,同上)。
   * 不并进 {@link send}:送进对话区与写进那个面板是两件事,壳也是两个 op。
   */
  writeAsk: boolean
  stop: boolean
  /** 能不能开到**某一段**对话(有深链 / 有 threadId);没有就只能叫到台前。 */
  openSession: boolean
}

/**
 * 每家一个。实现只管「怎么和这一家说话」,**不管**重试、次数上限、收场判断、落账 —— 那些在引擎一处。
 * 适配器里只许出现这一家自己的失败原因;「没窗口」这类可重试的失败用 `RetryableError` 抛出,引擎才重试。
 */
export interface Adapter {
  readonly family: string
  readonly via: JobResult['via']
  capabilities: () => Promise<AdapterCapabilities>
  /**
   * ★ **这一条通道此刻为什么用不上**(人话;用得上就缺席)。
   *
   * 为什么要它:`capabilities()` 只说「不行」,而「**壳没连上**」与「这台**没装**它」
   * 下一步做的事完全不同(一个是去开工作台 App,一个是去装那一家)。
   * 一条通道都排不上队时引擎把这一句接进 `why` —— 「查不到」不许冒充「没有」(D13)。
   * 可选:没实现 = 不说(照旧只有那句通用的)。
   */
  unavailable?: () => string | undefined
  /**
   * 做这一件。实现自己负责「开到那一段」(协议型:resume;窗口型:深链 / 侧栏点 / 叫台前 / 没窗口就开窗)。
   * 返回时 `delivered` 必须按证据说。
   */
  run: (job: Job) => Promise<JobResult>
  /**
   * **只读一眼**那一段此刻的回话,不送、不点、不叫台前(「盯着等回话」那条巡检用它)。
   * 回 `reply` = 它回了;没回就 `reply` 缺席。可选:没实现的家,巡检照旧走老路。
   */
  read?: (job: Job) => Promise<AdapterReadResult>
  /**
   * **只看一眼它那个权限弹框上有哪几颗键**(2026-10-02,接线那张卡补的那一样;`agent_approval` 不带 `press`)。
   *
   * 与 {@link run} 的 `press` 分开的理由:手机上打开那张卡时要**先把键念给她**,那一下不能按下去
   * (按一颗键是替她做了一个决定)。`active:false` = 一下都不动她的窗口;`active:true` = 允许先开到那一段再读。
   * 可选:没实现 = 这一家没有这一样(协议型那两条都没有)。
   */
  readApproval?: (job: Job, options: { active: boolean }) => Promise<ApprovalReadResult>
  /**
   * ★ **「去回答」:把那一段开到她眼前**(2026-10-02,接线那张卡补的那一样)。
   *
   * **一个字都不送** —— 它只开窗 / 开深链 / 在侧栏里点那一行。为什么要进契约:
   * 这一下**真的在动她的电脑**(把一个 App 的窗弹到她眼前),闸里 `bring_front` 那一样
   * 从卡 AG 立起来就没有调用方(审计第二表第 13 条点名的那一条)—— 收进这一层,
   * 那一样才数得了。可选:没实现 = 这一家开不到(调用方照旧只能叫它到台前)。
   */
  reveal?: (job: Job) => Promise<{ ok: boolean, how: 'link' | 'pick' | 'app' | 'none', why?: string }>
  /**
   * 写入靠什么:`full` 正常打字;`paste_only` 自绘界面只能粘贴 + 回车(登录后的 Kimi)。
   * 可选:没实现 = `full`。候选名单据此标「写入靠粘贴」。
   */
  writeMode?: () => 'full' | 'paste_only' | Promise<'full' | 'paste_only'>
}

/**
 * 适配器声明「这一下可以再来一次」的失败(窗口没露出来、协议连接刚起)。别的失败一律不重试。
 * 写成普通字段而不是参数属性:Node 直接跑 .ts(strip-only)不认参数属性,真机自测脚本要能直接 import 这一份。
 */
export class RetryableError extends Error {
  readonly waitMs: number
  constructor(message: string, waitMs = 1200) {
    super(message)
    this.waitMs = waitMs
  }
}

/**
 * 一次 `Engine.run` 里**一共最多跑几回**(含第一回;只有 `RetryableError` 才再来)。
 * 与 `windowWake.ts` 的 NO_WINDOW_WAKE_TRIES 同源(都是 3 回),合并时只留一处。
 */
export const ENGINE_MAX_RETRIES = 3
