/**
 * 窗口编排壳(工作台.app)的 WS 通道(spec W8)。
 *
 * 只认一个壳:新连接顶掉旧连接——壳崩溃重启后重连是常态,旧的半开连接不该挡道。
 * request 是带 id 的请求/响应对,超时与断开都立即拒绝,绝不让调用方无限等。
 */
import type { WebSocket } from 'ws'
import type { ActivationTimelineView, ActivationWindowView, HelperNotifyPermission, HelperNotifyView, HelperRect, HelperView, ShellActivation } from '../protocol.ts'

export type HelperRequest =
  | { op: 'screen_info' }
  | { op: 'app_info', bundle_id: string }
  | { op: 'set_window_frame', bundle_id: string, index: number, frame: HelperRect }
  | { op: 'raise_window', bundle_id: string, index: number }
  | { op: 'hide_app', bundle_id: string }
  | { op: 'unhide_app', bundle_id: string }
  // 窗位叠 v2(spec V2):告诉壳盯哪些 bundle 的 AXObserver 移动事件,下发即替换上一次的订阅集合。
  | { op: 'observe', bundle_ids: string[] }
  // 悬停高亮 v1:告诉壳"拖拽悬停判定"用的圈(屏幕 AX 坐标),null=清除——槽位矩形失效
  // (I3:窗位隐藏/日历借位)时必须能清,不然壳还拿着一份指向空处的旧圈继续判定。
  | { op: 'hover_zone', rect: HelperRect | null }
  // 光圈 v1(2026-09-10,设计-事务官形态 §四 第 2 步):在某个模块的边缘画一圈发光边框,
  // 告诉 Ben「事务官正在动这一块」。跟 hover_zone 是两回事——那个是**判定**(壳算窗口
  // 中心在不在圈里、只回事件,不画任何东西),这个是**绘制**(一扇透明、忽略鼠标的
  // 浮窗,不参与任何判定)。rect 为 null 或到 ttl 即灭;ttl_ms 缺省由壳定(2 秒),
  // label 是画在边框上的一行小字(「事务官正在切换窗位」)。
  // beam:false(2026-09-25 卡 P 补,壳 caps 带 `highlight_label` 才认):只亮那行字、不画那圈流线光 ——
  // 事务官动窗口槽只留字,窗口槽那圈光只属于他亲手拖进来、松手那一下。
  | { op: 'highlight_region', rect: HelperRect | null, ttl_ms?: number, label?: string, beam?: false }
  // Chromium AX 修复(ax_stale 诊断环配套):/debug/helper 的白名单透传口,只放这一个 op——
  // 让 Ben 能直接摆弄某个 bundle 的某条 AX 属性做现场诊断,不是给客户端常规调用的原语。
  | { op: 'ax_probe', action: string, bundle_id?: string, attr?: string, value?: boolean }
  // 前台 / 桌面两档窗口模式(2026-09-18,Ben:「安装完……现在的层级已经在底部了,导致我缩小了
  // 很多应用才看到页面,用户会觉得出 bug 了。登录和引导的时候,应该是和其他应用一样,能在顶部
  // 的,现在写死是底部」)。壳按 spec 是桌面级窗口(压在所有原生窗之下,认领的窗口贴在它的窗位
  // 槽上),但第一次打开(登录/注册/首次流程/引导)时屏幕上根本没有窗位、也没有认领的窗口,
  // 压在底下的唯一后果就是人看不见它。front = 普通应用层 + 置前;desktop = 原来那一档。
  // 判断「什么时候该哪一档」全在网页侧(src/client/shellWindowMode.ts,纯函数、有单测),
  // 这条通道只负责把结论送到壳。
  | { op: 'window_mode', mode: 'front' | 'desktop' }
  // 辅助功能授权框(2026-09-23 从零重装验收):壳**启动时不再弹**系统那个框(那时页面都还没出来,
  // 新用户不知道为什么要给),改成他点了「去授权」才由这一条让壳调带 prompt 的
  // AXIsProcessTrustedWithOptions —— 顺带把「工作台」登记进系统设置的辅助功能列表
  // (从没调过带 prompt 的那一下,列表里压根没有这一行)。壳回 `{ authorized }`。
  | { op: 'request_accessibility' }
  // 派活第一段(2026-09-21,Ben:「派活是直接操作对应的 Agent 客户端」):把一段话送进
  // 那家客户端的输入框。壳侧 AX 优先(直接写 AXValue),写不进去才退到键盘(激活 → 点一下
  // 输入框 → ⌘V 粘贴,先存后还用户的剪贴板)——**从不逐字敲字符键**,那条路才会被中文输入法吃掉。
  // submit 缺省 false:送进框里和按回车是两件事,后者会用 Ben 的账号真跑一次会话。
  // 白名单在壳侧 SendTextPolicy(微信/企微这类 IM 永远不在里面),服务端 dispatchClient.ts 另有独立的一道。
  // new_conversation(2026-09-24,卡 F):先按那家菜单里的「新对话」再送。缺省 false。
  // overwrite / save_draft(2026-09-27,卡 DB):框里有他没发出去的字时怎么办。
  // 缺省两格都不给 = 壳照旧**拦下不送**(不静默覆盖)。
  //   `save_draft`:壳把那段原文读出来一并回给服务端(结果里的 `draft`),送完再原样放回框里
  //     (`draft_returned` / `draft_note`)。服务端落盘在 `~/.dsh/workbench/drafts/`(server/clientDrafts.ts)。
  //     壳 hello 的 caps 里有 `save_draft` 才发;老壳没有这一格 → 照旧「有草稿就不送」。
  //   `overwrite`:明着覆盖。工作台自己**从不**发它 —— 那段字存不下来就该停,不该盖掉。
  | { op: 'send_text', bundle_id: string, index?: number, text: string, submit?: boolean, restore_front?: boolean, new_conversation?: boolean, overwrite?: boolean, save_draft?: boolean }
  // 把一张图粘贴进那家的输入框(2026-10-12,演示卡「出图进可灵」):壳先存她的剪贴板、放图、⌘V、再还回去。
  // 壳 hello 的 caps 里有 `paste_image` 才发;老壳回「未知 op」(调用方如实说「要新版工作台 App」)。
  | { op: 'paste_image', bundle_id: string, index?: number, path: string }
  // 把框上方已经挂着的帧图一张张删掉(2026-10-12,演示卡:上一回的首帧留着,新图会贴成尾帧)。回 `{deleted, left}`。
  | { op: 'clear_frames', bundle_id: string, index?: number }
  // 只找输入框、不送字:能力探测(每家客户端的实测表就是它跑出来的)与"送之前先看一眼"共用。
  // focus 缺省 false —— 探测不该顺手改用户窗口的焦点。
  | { op: 'focus_input', bundle_id: string, index?: number, focus?: boolean }
  // 读回复(2026-09-24,卡 F):只读,回那扇窗里 marker(我们送进去那句话的记号)之后的文字。
  // 老壳不认这个 op 会回「未知 op」,调用方据此如实说「读不回来,到那家里看」。
  | { op: 'read_reply', bundle_id: string, index?: number, marker: string }
  // 只读几小段字(2026-09-25,卡 O「额度要覆盖派活名单里的每一家」):服务端给几条正则,壳**只回命中的那一小段**
  // (带位置),窗口里别的字一个都不往外带。Manus 首页右上角的积分、Muse「使用情况」页上的百分比靠它读。
  // `top` = 只认离窗口上沿这么多点以内的字(顶栏里那一格)。壳 hello 的 caps 里有 `read_texts` 才发;老壳回「未知 op」。
  //
  // ★ 2026-09-26(卡 MQ):**`index` 不给 = 这个 App 的每一扇窗都读一遍**,命中里带 `window`(第几扇),
  // 每扇的宽高在 `windows` 里,别的桌面(Space)上那几扇读不到、只回个数(`offspace_windows`)。
  // 给了 `index` 就还是只读那一扇(老壳只认这一种,它不带 `window`,服务端当成都在第 0 扇)。
  // ★ 卡 MQ2 补:`offspace_windows` 是壳**真去数**的「不在这会儿显示着的那个桌面上的有几扇」
  // (另有 `os_windows` = 系统数得到这个 App 一共几扇窗);原来拿「系统有几扇 − AX 读到几扇」减,
  // 窗都在眼前、只是 AX 少露一扇时会说错话。实测:设置窗开在眼前时 AX 里有它、「使用情况」那一页读得到。
  // ★ 2026-10-03(卡「Grok 读键字」,壳 caps 里那一格叫 `read_titles`):`include_titles` ——
  // **按家声明**地连「键身上的字」(`AXMenuItem` / `AXButton` 的 title)也收进文字流。
  // Grok Bot 的额度写在一颗 `AXMenuItem` 身上(「SuperGrok 6%」),而整扇窗的静态字里一个百分号都没有
  // (真机:89 块字、额度那几条正则命中 0)。**缺省 / 不带 = 只收静态字**,行为一字不变;
  // 而且**不许全局打开** —— 一颗叫「使用情况」的侧栏键会把 Muse / 豆包那条「整格静态字」的旁证骗过去
  // (卡 MQ:假阳性比读不到坏)。声明它的地方是 `QuotaPageReach.read_titles`。
  | { op: 'read_texts', bundle_id: string, index?: number, patterns: readonly { id: string, regex: string, top?: number }[], /** 藏着的家放不放出来读(2026-09-27;只「读一下」才放)。老壳不认这一格,照旧放。 */ unhide?: boolean, include_titles?: boolean }
  // 派活送得进哪几家的窗口(2026-09-25,卡 Z):服务端把 **Agent 登记表里接上了的那几家**的包标识报给壳,
  // 壳的送话门(`SendTextPolicy`)据此放行运行时新发现的一家 —— 壳里那张写死的表不再是「能送话的全部」。
  // 壳自己的两道底线照旧:微信 / 企业微信一律拒(服务端报了也不算);真找不到聊天输入框就不送。
  // 壳 hello 的 caps 里有 `agent_allow` 才发;老壳回「未知 op」(调用方忽略,那时只有壳里实测过的那几家送得进)。
  | { op: 'agent_allow', bundle_ids: readonly string[] }
  // 「遮罩一收就当场藏回去」的预约(2026-09-25 卡 P 补,壳 caps 带 `rehide` 才认):壳报「遮罩开了」
  // (activation 的 verdict:'overlay')之后,该藏回去的那一家由服务端预约;遮罩一收壳自己藏,
  // 结论带 rehidden 来。壳回 `{ armed }`:此刻它没开着遮罩就不收(那一趟照老路,结论来了服务端藏)。
  | { op: 'arm_rehide', bundle_id: string }
  // Agent 自动发现(2026-09-25,卡 Q):三个**只读**原语,壳报 `agent_window` 这件本事才有。
  // running_apps = 正在跑的常规 App 与它们包里写的身份(不碰辅助功能);agent_probe = 窗口**结构**(字只数不读);
  // agent_read = 窗口标题、停止键、对话区尾巴、侧栏 —— 只对登记表里接上了的那几家(server/agentDiscovery.ts 把着)。
  // 人跟人聊天的应用壳永远不读(AgentWindowPolicy.neverRead)。
  | { op: 'running_apps' }
  | { op: 'agent_probe', bundle_id: string }
  | { op: 'agent_read', bundle_id: string }
  /**
   * **那扇窗的辅助功能树明细**(2026-10-02,卡「适配自绘界面的 Kimi」;只读、诊断用)。
   * 每个元素的角色、子角色、在树上第几层、位置大小、按得下去哪些动作、哪几条属性写得进去,
   * 以及标题 / 说明 / 帮助 / 值各**几个字** —— **一个字的内容都不回**。
   * 服务端只对「输入框没认出来」的那几家问一次(`agentJudge.wantsAxDetail`),收进登记表 → 进诊断包。
   * 老壳不认这个 op(回「未知 op」)→ 服务端吞掉,那一格缺席,结构那一道的结论一字不改。
   */
  | { op: 'agent_ax_detail', bundle_id: string }
  // 一扇窗里图片类节点的位置与 AXURL(2026-10-13 夜,卡 T,只读):可灵首帧格「传完了没有」的真信号。
  // 壳 hello 的 caps 里有 `agent_images` 才有;老壳回「未知 op」,调用方退回文字判据。
  | { op: 'agent_images', bundle_id: string }
  /**
   * **在侧栏里点他点名那条对话**(2026-09-28,卡 WR)。窗口型那几家没有「开到某一段对话」的深链,
   * 要往已有的那条对话里捎话就得先切到它。认不准 / 两行都叫这个名字 → 壳一条都不点,回 `found:false`。
   * 老壳不认这个 op(回「未知 op」)→ 窗口型的已有对话照旧捎不进去,如实说。
   */
  | { op: 'agent_pick', bundle_id: string, title: string }
  /**
   * **按那家的「停止」键**(2026-09-28,卡 WR;「打断再发」的第一下)。认停止键与判「它在不在跑」
   * 同一份判据(`SendTextPolicy.looksLikeStopButton`);**认不出就回 `found:false`,一个键都不按**。
   */
  | { op: 'agent_stop', bundle_id: string }
  /**
   * **替他点那家弹的框上的一项**(2026-09-28,卡 WQ)。维护者原话:「它现在几个选项给出来了,
   * 给完之后我还不能选,我还得回那个会话窗口回……我告诉你有事,但是我帮你传不了话。」
   *
   * 纪律与 `agent_pick` 同一套,只是更严:**标签整行相等才点**(`AgentWindowPolicy.matchOptionLabel`),
   * 两处都叫这个名字 → 一处都不点(回 `found:false, many:n`);点之前把那家叫到台前;
   * 点完重读一次:那一项还在不在(`gone:true` = 那个框收了,才算真答上了)。
   * 老壳不认这个 op(回「未知 op」)→ 调用方如实说「装上新版就能替你点」,不假装点了。
   */
  // `role`(2026-10-12):只认这个辅助功能角色的元素(可灵那一页「生成」键与同名导航链接分得开)。老壳不认 = 老行为。
  | { op: 'agent_press', bundle_id: string, label: string, role?: string }
  /**
   * ★ **在后台把那家翻到额度那一页,不抢她的焦点**(2026-10-03,卡 QP)。
   *
   * 与 `agent_press` 的差别只有一件,但那一件是这条 op 存在的全部理由:
   * **它不把那家叫到台前**。`agent_press` 点之前必须 `frontForWindowAction`(Electron 那几家在后台
   * 点不动),所以读额度那一轮一颗键都不敢按(卡 QZ 唯一没闭合的半边);这一条只走
   * `AXUIElementPerformAction(kAXPressAction)` —— 不经过屏幕,后台也按得动,**一次鼠标点击都不合成**。
   *
   * 认那颗键用的是 `agent_press` 那同一套识别(`AgentWindowPolicy.matchOptionLabel`:归一化之后整行相等,
   * 认不准 / 两个元素都叫这个名字 → 一处都不按);藏着的那一家壳自己 `unhide`(**不 activate**)、
   * 按完照原样藏回去。回 `{ found, pressed, how, windows, visited, capped, note? }` ——
   * `capped` = 树太大没走完(**与「它没这颗键」是两件事**);**「按完到没到那一页」壳一个字都不判**,
   * 那由紧接着的 `read_texts` 核(壳不下判断的老规矩)。
   *
   * 壳 hello 的 caps 里有 `quota_page` 才发;老壳回「未知 op」→ 照旧只有她亲手点「读一下」时才按键翻页。
   *
   * ★ **2026-10-03(卡 QT):`labels` —— 一串键在同一次放出来里按完。**
   *
   * 卡 QP 那一版一颗键一条 op。真机上量到这对**弹出式菜单走不通**:这条 op 每次返回前都把那家
   * 照原样藏回去,弹出来的那张菜单跟着收了 —— 第二条 op 再放出来时,下一颗键压根不在树上。
   * 所以新壳收 `labels`(一次 unhide → 挨个认、挨个 `AXPress`、每按一下等一拍 → 一次藏回去),
   * 回包多两格 `pressed_count` / `stuck`(按到第几颗、卡在哪一颗)。
   * `label` **照旧带着**(= `labels[0]`):装着老壳的机器上行为一字不变(它只认 `label`)。
   */
  // ★ **2026-10-03(卡「豆包闪一下」,壳 caps 里那一格叫 `quota_front`):`front` ——
  // 叫到台前按一下、按完立刻把台前与隐藏状态都还原。**
  //
  // 为什么要给这条「不抢焦点」的 op 开一格「抢焦点」:豆包那颗键弹的是 **Chromium 交给系统画的
  // 原生弹出菜单**,后台 `AXPress` 回 success 而整扇窗的树一个字没变(卡 QT 真机:visited 388 → 388,
  // 应用元素底下也没多出 `AXMenu`)—— 那张菜单**要那家在台前才跟踪得住**。
  // 维护者 2026-10-03 21:4x 拍板(原话「行,处理吧」):只在那一格真坏了的时候闪一下换一个真数。
  // **缺省不带 = 壳一下都不碰台前**(与 0.4.91 一字不差);「什么时候才闪」两道门在插件那一侧
  // (`agentQuota.ts` 的 `reachPage`:`worthUnhiding` 那条 2 小时线 + `QUOTA_FRONT_GAP_MS` 90 分钟)。
  // ★ **2026-10-04(卡「豆包台前点一下」,壳 caps 里那一格叫 `quota_click`):`click` ——
  // 台前那一支里**第一颗键**用合成鼠标点击按(豆包那颗「标准套餐」`AXPress` 回 success 而
  // 那一页压根不开)。要与 `front` 一起给才作数;缺省不带 = 后台那一支一下都不点。
  // 声明它的地方是 `QuotaPageReach.front_click`,今天只有豆包一家。
  | { op: 'quota_page', bundle_id: string, label: string, labels?: readonly string[], front?: boolean, click?: boolean }
  /**
   * **看 / 按那家的批准弹窗**(2026-10-01,卡 AP「手机替她批准」)。`marks` = 这一步自己的原话(命令 / 说明),
   * 壳靠它圈出**这条会话的那一个**弹窗(含那截原话、又有几颗键的那几块容器)。
   * 不带 `press`:只读,回 `{ found, panels: [{ rect, keys }] }`(相对窗口左上角;键名原字,重名照列),一颗都不按;
   * 带 `press` + `panel`:只在位置对得上的那一块里按那个名字的键(恰好一颗才按),按完重读回 `gone`。
   * 老壳不认 → 调用方照旧「到电脑上点」。
   */
  | { op: 'agent_approval', bundle_id: string, marks: string[], press?: string, panel?: { x: number, y: number, w: number, h: number } }
  /**
   * **把她自己那句话写进那家提问面板里的自由作答框、按面板自己那颗发送键**(2026-09-28,卡 AT)。
   * 维护者原话:「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
   *
   * `marks` = 那一问的**选项原话 + 问句原话**:壳靠它认出「含问句 / 选项的那个面板容器」——
   * 框与发送键**只认那个容器里的**,绝不碰窗口底部的主输入框(写进那儿 = 把她的话当新一轮指令
   * 发进她正在跑的会话)。认不出面板 / 两处都像 → 一处都不动,回 `found:false` + 一句如实话。
   * 写完按发送,再核实两条:`gone`(那个面板没了)+ `echoed`(窗口里出现了她那句的开头)——
   * **两条都成立才敢说「已替你答了」**。老壳不认这个 op → 调用方照旧说「要自己说一句,得在电脑上…」。
   */
  | { op: 'agent_write_ask', bundle_id: string, text: string, marks: string[] }
  // 各家 App 图标的主色(2026-09-25,卡 Q;壳报 `icon_color` 才有):按包标识找装着的那一份,回 `{ colors: { <包标识>: '#rrggbb' } }`。
  // 不碰辅助功能、不碰窗口;没装的那一家不回。
  | { op: 'icon_colors', bundle_ids: string[] }
  // 一个 App 的**整张图标**(2026-09-26,卡 LG;壳报 `app_icon` 才有;维护者:「桌面端的应用标签,也加各家的 logo icon」):
  // 按包标识找装着的那一份,`NSWorkspace.shared.icon(forFile:)` 按 `size` pt @2x 渲一次,回
  // `{ found, png: <base64>, w, h, bytes }`;没装 / 渲不出 → `{ found: false, why }`(不是错误:界面退回色点)。
  // 壳内存里缓存,同样的问第二次回同一份(幂等)。不碰辅助功能、不碰窗口;
  // **只认包标识、不认任意路径** —— 服务端只拿登记表里有 bundle_id 的那几家来问。
  | { op: 'app_icon', bundle_id: string, size?: number }
  // 系统通知(2026-09-25,卡 M;维护者:「它有很多要我给权限的,它也不弹出来」):事务官问他一件事 / 要他批一件事,
  // 壳**不在前台时**弹一条系统通知(在前台就不弹 —— 他正看着工作台,球下已经有那张卡了);点了壳回到前台并回一条
  // `notification_click`(带同一个 key),页面据此切到事务官那一档、摊开那一张。老壳不认这个 op 会回「未知 op」,忽略即可。
  // 壳回 `{ shown: boolean }`(false = 在前台 / 没给通知授权)。
  // `clear: true` = 那一问答掉了 / 撤了,把还挂在通知中心里的那一条收掉(点一条已经答过的通知没有意义)。
  | { op: 'notify', key: string, title: string, body: string, clear?: boolean }
  // 「工作台开着时电脑不睡」那颗开关被点了(2026-09-28,卡 AW;壳报 `system_awake` 才有):
  // 壳按住 / 放掉一条 `PreventUserIdleSystemSleep`(整机不因空闲睡眠;屏幕照样会黑、会锁)。
  // 落盘在 app.json 的 `system_awake_while_running`(缺席 = 开),这个 op 只管**立刻生效**,
  // 省得改完要重开工作台。壳回 `{ enabled, held }`;老壳不认这个 op 会回「未知 op」,
  // 那就只有落盘生效 —— 接口如实说「要重开工作台才生效」,不谎报当场生效。
  | { op: 'system_awake', enabled: boolean }
  // 「出门时电脑不睡」此刻成不成立(2026-10-03,卡「出门时电脑不睡」;壳报 `away_awake` 才有):
  // 真 = 壳按住那条「别让显示器因为闲着而暗 / 睡」(`PreventUserIdleDisplaySleep`)**不看前台**。
  // `active` 是**服务端算好的结论** —— 设置里那颗开关(app.json 的 `away_keep_awake`,缺席 = 关)
  // 开着,**而且**此刻真有一台已配对手机经中转连着(在线设备表 + 配对记录,见 server/awayAwake.ts)。
  // 壳一个判断都不做,也因此:壳重连之后要再发一次(它起来那一格缺省是 false)。
  // 壳回 `{ active, held }`;老壳不认这个 op 会回「未知 op」—— 那就只有落盘,接口如实说要重开工作台。
  | { op: 'away_awake', active: boolean }
  // 此刻窗口槽里都有谁(2026-10-04,卡「常亮认窗口槽里的程序」;壳报 `slot_apps` 才有):
  // `bundle_ids` = dock.json 那一叠成员的 bundle id(**一处主人**,见 server/dock.ts 的 pushSlotApps)。
  // 壳拿它判「此刻最前面那个 App 是不是槽里那一家」—— 真就照样按住那条「别让屏幕暗下去」
  // (她点进 Codex 的窗之后,最前面的 App 是 Codex 不是工作台,09-27 那条修复因此一直没生效)。
  // 壳回 `{ count, held }`;壳起来那一格缺省是空表,所以**重连之后要再发一次**(同 `away_awake`)。
  | { op: 'slot_apps', bundle_ids: string[] }
  /**
   * ★ **撤掉这几个包排着的读窗**(2026-10-21,卡「派活按家隔离」;壳 caps 里那一格叫 `read_lanes`)。
   * 壳的读窗按包各排各的队(一家读不动只堵它自己);这一下把那几个包**还没开始**的读全回「撤了」,
   * 正在读的那一下读完不再认。回 `{ cancelled }`。只动壳自己的队,一个窗口都不碰(不要辅助功能授权)。
   * 老壳不认(回「未知 op」)→ 插件那一侧照样清,话里如实说壳那一侧没撤。
   */
  | { op: 'cancel_reads', bundle_ids: string[] }

/**
 * 壳主动推来的事件(窗位叠 v2 spec V2 起):moved 是拖动落定,hover 是悬停高亮 v1 新增的
 * 进出圈瞬间信号——页面 1s 轮询做不了拖拽悬停这种实时反馈,只能靠壳侧事件驱动推送。
 * 未来加别的 kind 直接扩 union。
 */
export type HelperEvent =
  // dragged(2026-08-26 微信重登归位修复):壳在这扇窗的事件风暴期间采样过鼠标左键——
  // true=用户在拖,false=程序化移动(应用自己重建/摆放窗口,微信登录流程就是这样)。
  // 缺省(旧壳没有这个字段)由下游按 true 处理:一切按旧行为,部署兼容。
  // pressed(2026-09-18 Claude/企微拖不进窗位):落定**那一刻**鼠标左键还按着没有。
  // dragged 记的是「这轮事件风暴里按过」,pressed 记的是「落定这一刻还按着」——两个独立
  // 证据。壳侧 CG 兜底那条链(AX 全灭的应用,见 DragSense.swift)报的就是 dragged=true;
  // AX 那条链在"事件风暴比按键起得晚"这种极端情况下 dragged 会漏采,pressed 是第二道。
  // 缺省(旧壳没这个字段)= false:没有这条证据就按 dragged 单独判,行为与这一版之前一致。
  | { kind: 'moved', bundle_id: string, frame: HelperRect, dragged?: boolean, pressed?: boolean }
  | { kind: 'hover', inside: boolean }
  // Chromium AX 修复:壳侧探测到某个 bundle 的 AXObserver 通道"看似订阅成功但收不到回调"
  // (ax_err/ax_count/cg_count 是壳自己测的诊断量),已经自动唤醒重试过——这条事件纯粹是
  // "如实报告发生过一次"的诊断信号,不代表这次拖拽/贴合本身失败,dockService 只记环+
  // 顺手给个 note,不做别的判定。
  | { kind: 'ax_stale', bundle_id: string, ax_err: number, ax_count: number, cg_count: number }
  // 被叫到前面的那一家(2026-09-25,卡 P):壳的结论(真切过去 / 临时叫一下),窗口槽跟不跟由 dock 定。
  | ({ kind: 'activation' } & ShellActivation)
  // 有 App 起来 / 被切到前台 / 退出了(2026-09-25,卡 Q「Agent 自动发现」)。只带身份,不带它窗口里的任何东西。
  | { kind: 'app', event: 'launched' | 'activated' | 'terminated', bundle_id: string, name?: string, pid?: number }
  // 他点了壳弹的那条系统通知(2026-09-25,卡 M):key 原样是 notify 时给的那个。
  | { kind: 'notification_click', key: string }
  // 壳的通知到底弹没弹(2026-09-25,卡 M 补):读到授权、问过他、交给系统之后各回一次(见 HelperView.notify)。
  | { kind: 'notify_status', permission: HelperNotifyPermission, key?: string, ok?: boolean, error?: string, at?: string }

export interface HelperChannel {
  attach(ws: WebSocket): void
  view(): HelperView
  connected(): boolean
  request(req: HelperRequest, timeoutMs?: number): Promise<Record<string, unknown>>
  /** 连接/授权状态变化时回调(http.ts 借此把新快照推给展示台)。 */
  onChange(listener: () => void): void
  /** 壳推来的事件逐个回调(dockService 借此做认领/整理/拖出判定)。 */
  onEvent(listener: (event: HelperEvent) => void): void
  /**
   * 这份壳会不会某件新本事(2026-09-24,卡 F):壳的 hello 里带 `caps`(`new_conversation` / `read_reply`)。
   * **插件和壳是分开装的**:新插件碰上旧壳,旧壳会把 `new_conversation` 当没看见、直接打进他正开着的
   * 那条对话 —— 派活那一层据此在旧壳上不送。可选:老的假件(用例)没有这一格,按"会"处理。
   */
  supports?(cap: string): boolean
  /**
   * 服务端这一头没交出去的那一条也记进 `/state.helper.notify.last_post`(卡 M 补):壳没接上、老壳不认 `notify`、
   * 壳没回话 —— 以前 `.catch(() => {})` 吞了,谁也不知道。可选:老的假件没有这一格。
   */
  recordNotify?(post: { key: string, ok: boolean, error?: string }): void
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 不需要「辅助功能」授权的 op(2026-09-18)。
 *
 * request() 底下那道 `authorized` 门是为**动别人窗口**的那些 op 立的(set_window_frame /
 * raise_window / observe……没授权它们必然失败,与其让壳白跑一趟不如当场拒掉)。`window_mode`
 * 不碰任何别人的窗口,只改壳自己那扇窗的层级,壳侧压根不走 AX——而它恰恰**最需要在没授权
 * 的时候能用**:第一次开机时辅助功能多半还没点过,登录屏偏偏是最该被看见的那一屏,门要是
 * 把它拦下来,这次修的毛病就原样留着了。
 *
 * 只放这一个 op,**不顺手把 screen_info 一起放行**:那条今天被门拦着是既有行为,改它是另一
 * 件事,不在这张卡里(壳侧 screen_info 确实也不需要 AX,要放的话该单独有人验一遍)。
 *
 * 2026-09-23 加了第二个:`request_accessibility`。它本身就是「去要授权」的那一下,
 * 只在**没授权**的时候才有意义 —— 门要是拦它,这条路就永远走不通。
 *
 * 2026-09-25 卡 Q 加 `running_apps`:壳那边只问 NSWorkspace 有哪几个常规 App、读它们包里的 Info.plist
 * (AgentWindow.runningApps),**一个 AX 调用都没有**。没授权时自动发现靠它点名 ——
 * 「Muse、Manus 还看不到在忙什么:工作台要「辅助功能」权限」,而不是一片空白。读窗口的两个(agent_probe / agent_read)照旧拦着。
 * 同一天加 `icon_colors`:只读各家 App 图标(NSWorkspace),头像与小灯的颜色从这里来,也不碰 AX。
 * 2026-09-26 卡 LG 加 `app_icon`:同一张图标,只是取整张(窗口槽标签与顶栏那一排的小 logo),同样只问 NSWorkspace、
 * 一个 AX 调用都没有 —— 没授权的那一台上标签与顶栏照样有各家的 logo,不是一片色点。
 * 「未连接」那道门对谁都不放——没有连接就真的没地方发。
 */
/*
 * `agent_allow`(2026-09-25,卡 Z)也在门外:它只改壳自己内存里那一份「哪几家算 Agent」,一个窗口都不碰。
 * 而且没授权时正是最该报的时候 —— 他一给授权,登记表里已经接上的那几家立刻就能派活,不用等下一次重连。
 *
 * `quota_page`(2026-10-03,卡 QP)**不在门外**:它要走那家的辅助功能树找那颗键、再按下去 ——
 * 没授权时必然失败,与其让壳白跑一趟不如当场拒掉(同 `read_texts` / `agent_press` 那一档)。
 * 「不抢焦点」与「要不要授权」是两件事,别因为它温和就把门撤了。
 */
/*
 * `away_awake`(2026-10-03,卡「出门时电脑不睡」)也在门外:同 `system_awake` ——
 * 只按一条电源断言,一个窗口都不碰。而且**没授权时正是最该按的时候**:
 * 她出门在外,屏幕一睡就锁,锁了连「要不要授权」都没人点。
 */
/*
 * `slot_apps`(2026-10-04,卡「常亮认窗口槽里的程序」)同样在门外:它只是一张名单,
 * 壳收完最多动那一条电源断言,一个窗口都不碰。**没授权时也该发** —— 窗口槽的认领要授权,
 * 但「她这会儿最前面是谁」不要;授权还没给的那台机器上她照样会点进那扇窗。
 */
const AX_FREE_OPS: ReadonlySet<string> = new Set(['window_mode', 'request_accessibility', 'notify', 'running_apps', 'icon_colors', 'app_icon', 'agent_allow', 'system_awake', 'away_awake', 'slot_apps', 'cancel_reads'])

const REASON_NOT_RUNNING = '工作台 App 未运行'
const REASON_NOT_AUTHORIZED = '辅助功能未授权'

/**
 * ★ **这一下没应声的那两句**(2026-10-13,卡 N)。导出的理由只有一个:
 * 这两句都是「op 已经发给壳了、它做没做到我们不知道」—— 送话那一层据此**再核一眼窗口**再定成败
 * (判据在 `dispatchClient.isHelperQuietReason` 一处,别处不逐字抄这几个字)。
 */
export const HELPER_TIMEOUT_REASON = '壳响应超时'
/** 这一下正走着壳断了(`failAll` 把挂起的那几条全按这一句拒掉)。 */
export const HELPER_GONE_REASON = '工作台 App 断开'
const REASON_GONE = HELPER_GONE_REASON

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** moved 事件的 frame 校验:壳侧坏帧/字段缺失时整条事件直接丢,不拿 NaN/undefined 污染下游判定。 */
function isHelperRect(value: unknown): value is HelperRect {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.w) && isFiniteNumber(r.h)
}

export interface HelperChannelOptions {
  /**
   * 插件版本号(src/version.ts 构建时注入)。壳一连上就收到 `{kind:'hello', role:'server', version}`:
   * 插件发版要 kickstart 重启 DSH,壳的 WS 会自动重连,但 WKWebView 里的页面不会自己刷新,
   * 前端代码还是旧版(2026-09-14 Ben:0.2.22 修了内容居中,壳里还是居中)。壳记住上次连上时
   * 的版本,重连后版本变了才 reload;同版本重连(壳自己断线)不动。不传就报 '0'(与 mDNS 兜底一致)。
   */
  version?: string
}

export function createHelperChannel(options: HelperChannelOptions = {}): HelperChannel {
  const version = options.version ?? '0'
  let socket: WebSocket | undefined
  let helloSeen = false
  let authorized = false
  /** 壳报来的通知状态(卡 M 补)。壳断了也留着最后一次 —— 那是发生过的事,统筹要看。 */
  let notifyState: HelperNotifyView | undefined
  /** 这次连上的壳报了哪些本事(见 HelperChannel.supports)。 */
  let caps: ReadonlySet<string> = new Set()
  let nextId = 1
  const pending = new Map<number, {
    resolve: (v: Record<string, unknown>) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const listeners: (() => void)[] = []
  const eventListeners: ((event: HelperEvent) => void)[] = []

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function notifyEvent(event: HelperEvent): void {
    for (const listener of eventListeners) listener(event)
  }

  function failAll(reason: string): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  function isConnected(): boolean {
    return socket !== undefined && helloSeen
  }

  return {
    supports(cap: string): boolean {
      return isConnected() && caps.has(cap)
    },
    attach(ws: WebSocket): void {
      // 顶掉旧连接;旧连接上的挂起请求按断开处理。
      if (socket !== undefined) {
        failAll(REASON_GONE)
        socket.terminate()
      }
      socket = ws
      helloSeen = false
      authorized = false
      caps = new Set()
      // 新连接顶掉旧连接这一刻就该让 UI 知道旧连接没了——不用等新壳发 hello,
      // 万一新壳迟迟不发 hello(或干脆连不上),UI 也不该继续显示旧连接的已连接状态。
      notify()
      // 服务端 hello(见 HelperChannelOptions.version):连上就发,不等壳先开口——壳那边
      // 只需要知道"这次连上的插件是哪个版本",跟授权握手无关。send 同步抛(底层已废)
      // 就随它去,close/error 会把这条连接按 drop 处理。
      try {
        ws.send(JSON.stringify({ kind: 'hello', role: 'server', version }))
      }
      catch {
        // 见上。
      }

      ws.on('message', (data) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(data)) as Record<string, unknown>
        }
        catch {
          return // 坏帧直接忽略,不能让一条坏消息炸掉通道。
        }
        if (msg.kind === 'hello' && msg.role === 'helper') {
          helloSeen = true
          authorized = msg.authorized === true
          caps = new Set(Array.isArray(msg.caps) ? (msg.caps as unknown[]).filter((one): one is string => typeof one === 'string') : [])
          notify()
          return
        }
        if (msg.kind === 'authorized') {
          authorized = msg.authorized === true
          notify()
          return
        }
        if (msg.kind === 'moved') {
          // 未知/坏帧照旧忽略(同上面 JSON.parse 那条纪律):字段缺失或类型不对就整条丢,
          // 不让一条坏事件把下游 dockService 的判定带偏。
          if (typeof msg.bundle_id === 'string' && isHelperRect(msg.frame)) {
            // dragged 非布尔(坏字段/未来的怪值)不整条丢——frame/bundle_id 才是判定主体,
            // 只把 dragged 剥掉,下游按缺省(=用户拖拽)走最保守的旧行为。
            notifyEvent({
              kind: 'moved',
              bundle_id: msg.bundle_id,
              frame: msg.frame,
              ...(typeof msg.dragged === 'boolean' ? { dragged: msg.dragged } : {}),
              // pressed 同款纪律:非布尔就剥掉,下游按缺省(false=没有这条证据)走。
              ...(typeof msg.pressed === 'boolean' ? { pressed: msg.pressed } : {}),
            })
          }
          return
        }
        if (msg.kind === 'hover') {
          // 同款纪律:字段不对就整条丢,不拿坏事件污染下游(http.ts 的悬停广播)。
          if (typeof msg.inside === 'boolean') {
            notifyEvent({ kind: 'hover', inside: msg.inside })
          }
          return
        }
        if (msg.kind === 'ax_stale') {
          // 同款纪律(先例:moved 的 isHelperRect):字段不对就整条丢,不拿坏事件污染
          // dock.ts 的诊断环。
          if (
            typeof msg.bundle_id === 'string'
            && isFiniteNumber(msg.ax_err) && isFiniteNumber(msg.ax_count) && isFiniteNumber(msg.cg_count)
          ) {
            notifyEvent({ kind: 'ax_stale', bundle_id: msg.bundle_id, ax_err: msg.ax_err, ax_count: msg.ax_count, cg_count: msg.cg_count })
          }
          return
        }
        if (msg.kind === 'activation') {
          // 同款纪律:主体字段不对就整条丢;几何那几格坏了只剥掉那一格(纯诊断,不参与判定)。
          const parsed = parseActivation(msg)
          if (parsed !== undefined) notifyEvent({ kind: 'activation', ...parsed })
          return
        }
        if (msg.kind === 'app') {
          // 同款纪律:字段不对就整条丢。
          if ((msg.event === 'launched' || msg.event === 'activated' || msg.event === 'terminated')
            && typeof msg.bundle_id === 'string' && msg.bundle_id !== '') {
            notifyEvent({
              kind: 'app',
              event: msg.event,
              bundle_id: msg.bundle_id,
              ...(typeof msg.name === 'string' && msg.name.trim() !== '' ? { name: msg.name } : {}),
              ...(isFiniteNumber(msg.pid) ? { pid: msg.pid } : {}),
            })
          }
          return
        }
        if (msg.kind === 'notification_click') {
          if (typeof msg.key === 'string' && msg.key !== '') notifyEvent({ kind: 'notification_click', key: msg.key })
          return
        }
        if (msg.kind === 'notify_status') {
          const status = parseNotifyStatus(msg)
          if (status === undefined) return
          // 记在壳这一份状态里(/state.helper.notify),再推一次新快照:统筹、事务官当场看得到。
          notifyState = {
            permission: status.permission,
            ...(status.key === undefined ? (notifyState?.last_post === undefined ? {} : { last_post: notifyState.last_post }) : {
              last_post: { key: status.key, at: status.at ?? new Date().toISOString(), ok: status.ok === true, ...(status.error === undefined ? {} : { error: status.error }) },
            }),
          }
          notifyEvent(status)
          notify()
          return
        }
        if (msg.kind === 'res' && typeof msg.id === 'number') {
          const entry = pending.get(msg.id)
          if (entry === undefined) return
          pending.delete(msg.id)
          clearTimeout(entry.timer)
          if (msg.ok === true) entry.resolve((msg.result ?? {}) as Record<string, unknown>)
          else {
            // 失败必须带原因(2026-09-25):壳没给原话时,把回包里有哪几格说出来,不写一句空话。
            const keys = Object.keys(msg).filter(key => key !== 'kind' && key !== 'id' && key !== 'ok')
            entry.reject(new Error(typeof msg.error === 'string' && msg.error.trim() !== ''
              ? msg.error
              : `壳回了失败,但没带原因(回包里只有:${keys.length === 0 ? '什么都没有' : keys.join('、')})`))
          }
        }
      })
      const drop = (): void => {
        if (socket !== ws) return
        socket = undefined
        helloSeen = false
        authorized = false
        caps = new Set()
        failAll(REASON_GONE)
        notify()
      }
      ws.on('close', drop)
      ws.on('error', drop)
    },

    connected: isConnected,

    view(): HelperView {
      const notifyPart = notifyState === undefined ? {} : { notify: notifyState }
      if (!isConnected()) return { connected: false, authorized: false, reason: REASON_NOT_RUNNING, ...notifyPart }
      if (!authorized) return { connected: true, authorized: false, reason: REASON_NOT_AUTHORIZED, ...notifyPart }
      return { connected: true, authorized: true, ...notifyPart }
    },

    request(req: HelperRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
      if (!isConnected()) return Promise.reject(new Error(REASON_NOT_RUNNING))
      // 授权门只拦真正要碰别人窗口的 op,见 AX_FREE_OPS 那段注释。
      if (!authorized && !AX_FREE_OPS.has(req.op)) return Promise.reject(new Error(REASON_NOT_AUTHORIZED))
      const ws = socket as WebSocket
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(HELPER_TIMEOUT_REASON))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        try {
          ws.send(JSON.stringify({ kind: 'req', id, ...req }))
        }
        catch (err) {
          // send 同步抛出(比如底层 socket 已经废了)不能让这条 request 挂到超时才失败——
          // 立即清理挂起项并原样把错误抛给调用方。
          clearTimeout(timer)
          pending.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },

    onChange(listener: () => void): void {
      listeners.push(listener)
    },

    onEvent(listener: (event: HelperEvent) => void): void {
      eventListeners.push(listener)
    },

    recordNotify(post: { key: string, ok: boolean, error?: string }): void {
      notifyState = {
        permission: notifyState?.permission ?? 'unknown',
        last_post: { key: post.key, at: new Date().toISOString(), ok: post.ok, ...(post.error === undefined ? {} : { error: post.error }) },
      }
      notify()
    },
  }
}

/** 壳报来的一条通知状态:授权那一格认不出就整条丢(不猜)。 */
export function parseNotifyStatus(msg: Record<string, unknown>): Extract<HelperEvent, { kind: 'notify_status' }> | undefined {
  const permission = msg.permission
  if (permission !== 'allowed' && permission !== 'denied' && permission !== 'not_determined' && permission !== 'unknown') return undefined
  const key = typeof msg.key === 'string' && msg.key !== '' ? msg.key : undefined
  return {
    kind: 'notify_status',
    permission,
    ...(key === undefined ? {} : { key }),
    ...(typeof msg.ok === 'boolean' ? { ok: msg.ok } : {}),
    ...(typeof msg.error === 'string' && msg.error !== '' ? { error: msg.error } : {}),
    ...(typeof msg.at === 'string' && msg.at !== '' ? { at: msg.at } : {}),
  }
}

function activationWindow(value: unknown): ActivationWindowView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const nums = ['layer', 'x', 'y', 'w', 'h'] as const
  if (!nums.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))) return undefined
  return {
    layer: raw.layer as number, x: raw.x as number, y: raw.y as number, w: raw.w as number, h: raw.h as number,
    ...(typeof raw.why === 'string' && raw.why !== '' ? { why: raw.why } : {}),
  }
}

/**
 * 壳报来的时间线(卡 P 补二):只收「小写名字 → 有限数字 / 不长的一句话」,最多 40 格;别的一概剥掉(整条不丢)。
 */
function activationTimeline(value: unknown): ActivationTimelineView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: ActivationTimelineView = {}
  let kept = 0
  for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= 40 || !/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue
    if (typeof one === 'number' && Number.isFinite(one)) { out[key] = one; kept += 1 }
    else if (typeof one === 'string' && one !== '' && one.length <= 200) { out[key] = one; kept += 1 }
  }
  return kept === 0 ? undefined : out
}

/** 壳报来的 `{kind:'activation'}` → ShellActivation;bundle_id / verdict / was_hidden 不对就整条丢(返回 undefined)。 */
export function parseActivation(msg: Record<string, unknown>): ShellActivation | undefined {
  if (typeof msg.bundle_id !== 'string' || msg.bundle_id === '') return undefined
  if (msg.verdict !== 'switch' && msg.verdict !== 'transient' && msg.verdict !== 'overlay') return undefined
  if (typeof msg.was_hidden !== 'boolean') return undefined
  const reason = msg.reason === 'overlay' || msg.reason === 'quick_return' || msg.reason === 'no_window' ? msg.reason : undefined
  const overlay = activationWindow(msg.overlay)
  const front = activationWindow(msg.front)
  const timeline = activationTimeline(msg.timeline)
  return {
    bundle_id: msg.bundle_id,
    verdict: msg.verdict,
    ...(reason === undefined ? {} : { reason }),
    was_hidden: msg.was_hidden,
    ...(typeof msg.prev_bundle_id === 'string' && msg.prev_bundle_id !== '' ? { prev_bundle_id: msg.prev_bundle_id } : {}),
    dwell_ms: typeof msg.dwell_ms === 'number' && Number.isFinite(msg.dwell_ms) ? msg.dwell_ms : 0,
    ...(overlay === undefined ? {} : { overlay }),
    ...(front === undefined ? {} : { front }),
    ...(msg.verdict === 'transient' && msg.rehidden === true ? { rehidden: true } : {}),
    ...(timeline === undefined ? {} : { timeline }),
  }
}
