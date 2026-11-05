/**
 * 手机调电脑的每一条接口,**出了局域网怎么走**(2026-09-25,卡 S「手机在哪都能用」)。
 *
 * 维护者放假在外,手机远程用正是核心场景 ——「通过事务官去下发、通过事务官去验收,这样子的话我其实放不放假没区别」。
 * 09-24 那一版「按住说话」出了局域网必然转不了文字,屏上一句「不在同一个网络」。往下查不止这一处:
 * 手机调电脑的接口里,有的出门能走房间,有的不能;不能的那几条,在外面按下去弹的是一句
 * 「POST /feed/run 不在房间代理的白名单里」—— 没人决定过它该不该在外面能用,只是没人想起来。
 *
 * 所以这张表是一条**机制**,不是一份说明:手机调电脑的**每一条**都在这里,二选一 ——
 *   - `via`:出了局域网有一条走房间的路(房间代理 / 识别专门那条 / 字节流 / 中转);
 *   - `lanOnly`:明说「只在跟电脑连同一个 Wi-Fi 时有」,并写一句**给他看的**话。在外面按到它,屏上就是这一句
 *     (channelClient.ts 当场回它,不再往房间里白跑一趟,也不再露出「白名单」这种话)。
 *
 * 守门(tests/remoteParity.test.ts):
 *   ① 扫 src 里每一个路径字面量 —— 手机新调了电脑的一条路,既不在这张表里、也不在「不是电脑接口」那张表里,红;
 *   ② 说走房间代理的,必须真在 channel-worker/src/rpc.ts 的白名单里;说只在局域网的,必须真不在;
 *   ③ 这张表里手机已经不调的,也红 —— 免得表越放越假;
 *   ④ 核心几件(发消息、答提问、批准、派活、识别、取文件)在 tests/remoteCore.test.ts 里用「远程模式」真走一遍。
 *
 * 加一条新接口时:能走房间代理的,在工人白名单(channel-worker/src/rpc.ts 的 RPC_ALLOWED)加一行,这里写 `via: 'proxy'`;
 * 走不了的,写 `lanOnly` 和一句他看得懂的话 —— 要写成「在外面怎么办」,不是「为什么不行」。
 *
 * 不经 8791 路径、本来就走房间的那几件(引导 / 通话 / 取文件 / 续期 / 识别的 `wb.rpc` 专门消息)不在这张表里:
 * 它们没有路径,天生就在房间里(见 rpc.ts)。
 */

export type PhoneMethod = 'GET' | 'POST' | 'WS';

/** 出了局域网怎么走。 */
export type RemoteWay =
  /** `wb.rpc` 的 http 代理:工人以这台手机的身份替它调 8791(白名单见 channel-worker/src/rpc.ts)。 */
  | { via: 'proxy' }
  /** 识别专门那条:`wb.rpc` 上 `{type:'asr'}` + `wb.asr` 字节流(channel-worker/src/asrRelay.ts)。 */
  | { via: 'asr' }
  /** 不经 8791 这条路径,在外面换一条房间里的路(字节流、专门的请求);`how` 说换成了哪条。 */
  | { via: 'room'; how: string }
  /** 在外面向中转(账号服务器)要,不经电脑。 */
  | { via: 'relay'; how: string }
  /** 只在跟电脑连同一个 Wi-Fi 时有。**这一句是给他看的**:在外面按到这条,屏上就是它(要说在外面怎么办)。 */
  | { lanOnly: string };

export interface PhoneInterface {
  method: PhoneMethod;
  /** 路径;`:x` 是一段(事项 id、形象 id…)。不带查询串。 */
  path: string;
  /** 这条是干什么的(给维护者看)。 */
  what: string;
  remote: RemoteWay;
  /**
   * **普通用户第一次就会碰到**(2026-09-25,维护者:「从常规用户的第一次使用角度,甚至是非专业用户的视角考虑」)。
   * 装好、登录、第一次打开首页、第一次说一句 / 按住说话 / 打电话 / 做引导 / 批一次,会用到的那些。
   * 这一类里只在局域网的,每一条都要在交接里按「不懂技术、第一次装、人在外面」走过(守门用例钉着那张名单)。
   */
  firstUse?: true;
}

const AVATAR_LAN_ONLY = '形象要跟电脑连同一个 Wi-Fi 时才下载得了;在外面先用粒子球,别的照常';
const OLD_CALL_LAN_ONLY = '这种通话方式要跟电脑连同一个 Wi-Fi 才能打;在外面点电话走另一条路,照样能打';

export const PHONE_INTERFACES: readonly PhoneInterface[] = [
  // ———— 看板、事项、批准、派活 ————
  { method: 'GET', path: '/state', what: '首页与看板的快照', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/butler/item', what: '发一句话(建事项、派给某一家、带附件、「把 X 发我」)', remote: { via: 'proxy' }, firstUse: true },
  /** 1a(2026-10-24):一句话落地口 —— 听懂(多项命令)→决策→执行→真实回话;与 /butler/item 同一道门。 */
  { method: 'POST', path: '/butler/say', what: '「落地」口:一句话进、命令清单与真实回话出(1a)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/approvals/answer', what: '批准「先问我」那一步', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/questions/answer', what: '答事务官问你的话(「等你确认」里那几问)', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/sessions/answer', what: '答别家会话在等你的那一问(「等你确认」里「Claude 在等你选」那种;送不回去时电脑回一句去哪儿答)', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/asks/answer', what: '「等你」里那一件他答了(点它给的那一项 / 自己说一句)—— 电脑替他点进那家的窗口,再重读核实(卡 WQ)', remote: { via: 'proxy' }, firstUse: true },
  // 卡 AP(2026-10-01):那家停在权限弹窗上 —— 打开那张卡时读弹窗上那几颗键(按走 /asks/answer)。10-01 维护者在外面就撞上了。
  { method: 'POST', path: '/sessions/approval/read', what: '别家会话停在权限弹窗上:读出弹窗上「批准一次 / 拒绝」那几颗键给你按', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/sessions/ask/dismiss', what: '别家会话那一问点「不用管这条」', remote: { via: 'proxy' } },
  // 卡 PS(2026-09-27):点开某家在跑的那条会话,在最近几轮下面直接说一句 —— 那句话进那条对话(捎话)。
  { method: 'POST', path: '/sessions/relay', what: '在某家那条会话的卡片里直接说一句(那句话送进那条正在跑的对话)', remote: { via: 'proxy' } },
  // 卡 O(派活的眼睛,09-25):事项详情里那几颗键。工人白名单里都有(channel-worker/src/rpc.ts 那一段写了每条为什么能在外面按);
  // 「帮我接上」(`/agents/login`)在这台 Mac 上开窗口,手机上不画按钮、只说「要在电脑前点」,所以不在这张表里。
  { method: 'POST', path: '/butler/item/stop', what: '停掉这一件(停她那条会话 / 停后台做的那一件 / 不再等窗口里的回答)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/item/budget', what: '到上限停下来之后「继续 / 停掉这一件 / 换 X 来做」', remote: { via: 'proxy' } },
  { method: 'POST', path: '/dispatch/run', what: '派不出去时「先交给 X 做」(对已经建好的那张卡派活)', remote: { via: 'proxy' } },
  // 卡 N(一件事一份、进度靠证据,09-25):事项详情里那三颗。工人白名单里都有(channel-worker/src/rpc.ts 那一段写了每条为什么能在外面按);
  // 合并卡 W 09-25 补进这张表 —— 卡 S 的守门用例拦出来的。
  { method: 'POST', path: '/progress/said', what: '没看到进展时「说一句」(记成口述证据、当场再核那一张)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/progress/check', what: '「现在核一次」(当场按证据重判这一张;花模型的钱,一张约一分钱)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/item/drive', what: '「派给 X」/「交给她」—— 真派活(手机上先摆出那一问,点「派」才发)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/agents/not-agent', what: '「这不是 Agent」(新接上一家那一句上、点开某家会话里;卡 Q)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/agents/notice/dismiss', what: '「新接上一家」那一句点「知道了」(卡 Q)', remote: { via: 'proxy' } },
  /**
   * 各家的 **logo**(2026-09-26,卡 LG3)。两条分开走,是因为一条是 JSON、一条是图片字节:
   *   - 清单(哪几家有图、各自的 etag)是一份小 JSON,走房间没问题 —— 在外面也知道**存着的那几张还算不算新**;
   *   - 图片本身十几 KB,房间那条路只收 JSON(设计 §二:大文件先不做),所以只在局域网取。
   * 在外面没有的那一家就退回色点 —— 图标晚到不挡任何事,所以这句话是「回家会补上」,不是「出错了」。
   */
  { method: 'GET', path: '/agents/icons', what: '各家 logo 的清单(哪几家有图、各自的 etag;手机据此决定哪几张要重取)', remote: { via: 'proxy' } },
  { method: 'GET', path: '/agents/icon/:x', what: '一家的 logo(一张 PNG)', remote: { lanOnly: '各家的图标要跟电脑连同一个 Wi-Fi 时才取得到;在外面先用颜色点,名字照样看得见' } },
  /**
   * 卡 V(09-25):**手机页面自己出的错报给电脑**。09-25 晚电脑上点「事务官」没反应、页面卡死,
   * 而没有任何地方记录;手机上同一件事更查不到 —— 他在外面,连不上局域网、adb 也接不上。
   * 所以这一条在外面**尤其**要通:往里只送一句话 + 栈的前几行 + 在哪一页,不回任何数据。
   * 界面上没有按钮,是 `window.onerror` / `unhandledrejection` 自己发的(src/api/reportClientError.ts)。
   */
  { method: 'POST', path: '/client/error', what: '手机页面自己出的错(报给电脑记下来,设置里看得到)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/task/move', what: '批准(把他看见的那张卡挪一格)', remote: { via: 'proxy' } },
  /**
   * ★ 「看过了」那两下(2026-10-04,卡 `claude/answer-comes-to-her`)。服务端只有那一格,
   * **两端同步靠的就是它** —— 所以出门也得通,不然「她在外面看过了,回家电脑上那几条还亮着」。
   */
  { method: 'POST', path: '/answers/seen', what: '球下那条回答:看过了(点一下展开全文那一下)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/task/seen-result', what: '「刚办完」那一条:看过了 / 划掉', remote: { via: 'proxy' } },
  { method: 'POST', path: '/task/comment', what: '协作区事项留言(请求号保证断线补发只写一次)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/note/message', what: '协作区留言与邀请投递(client_msg_id 与 client_key 双重幂等)', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/goal/board', what: '目标能力条件汇总', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/note/activity', what: '事项活动与精确回执', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/relations', what: '事项关系与轮次', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/runs', what: '真实执行片段', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/capacity', what: '名片运行容量事实', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/lan/identity', what: '局域网稳定身份', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/lan/members', what: '已知局域网成员', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/lan/channel', what: '电脑局域网项目频道', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/goal/create', what: '创建目标', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/goal/condition/save', what: '保存能力条件与证据', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/goal/condition/remove', what: '移除能力条件', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/goal/condition/verify', what: '核验或退回能力条件', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/goal/condition/deliver', what: '记录条件交付', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/relation/save', what: '记录事项关系', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/relation/remove', what: '移除事项关系', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/lan/identity', what: '修改电脑的局域网展示名', remote: { via: 'proxy' } },
  { method: 'POST', path: '/collab/lan/channel/send', what: '请电脑向已配对项目成员传递消息或报告', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/relay/studio', what: '协作区工作室与成员名单', remote: { via: 'proxy' } },
  { method: 'GET', path: '/collab/relay/channel', what: '协作区 relay 频道消息', remote: { via: 'proxy' } },
  // 设置 › 高级 › 删掉测试单子(2026-10-01):一次性的清理,不为它动房间工人的白名单。
  { method: 'POST', path: '/task/delete', what: '删掉看板上的测试单子', remote: { lanOnly: '在外面删不了测试单子;回家连上同一个 Wi-Fi 再按一下' } },
  { method: 'GET', path: '/sessions/digest', what: '点开各家正在跑的一条会话', remote: { via: 'proxy' } },
  /**
   * 接着这件事做(2026-10-23,卡 A「同事项接续与动作契约」):事项详情里读来源清单、把一句补到
   * 原会话 —— 与「往这条会话里捎话」(/sessions/relay)是两条路:那条只认一家,这条由服务端认
   * 这件事连着哪几条、选一条发。人在外面照样接续;只读/只发她自己的话,同 digest 那一档。
   */
  { method: 'GET', path: '/butler/item/:x/continue', what: '事项详情「继续这件事」:这件事连着哪几条会话、各能不能这会儿接着发话', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/item/continue', what: '「继续这件事」把一句发到选定的来源(事务官那条会话 / 原 Agent 会话),带请求号重试不重复', remote: { via: 'proxy' } },
  // 手机读对话(2026-10-01):各家最近的对话从记录文件读(关掉的也在),出门照样能翻。
  // 2026-10-03(卡「手机各家最近会话固定入口」):多一个 `?per_family=10`(首页那条常驻入口要的那一份)——
  // 工人的白名单按 path 比、query 原样转发,所以这一条**一个字没动**;对照测试在 tests/remoteCore.test.ts。
  { method: 'GET', path: '/sessions/history', what: '「各家最近的对话」:各家最近 7 天的对话,每家多条(或每家 10 条、按项目分组),往下翻', remote: { via: 'proxy' } },
  { method: 'GET', path: '/sessions/transcript', what: '点开一条对话看完整内容,往上翻到开头', remote: { via: 'proxy' } },
  // `view=keep`(2026-10-04)也是这一条:它只开一张取件单,字节照旧走下面 `/files/offer/:x` 那条(在家直连 / 出门工人推)。
  { method: 'GET', path: '/sessions/attachment', what: '对话里的图片 / 视频 / 文件:缩略图、全文、逐页、开一张取件单(分块取,在外面也走得通)', remote: { via: 'proxy' } },
  { method: 'GET', path: '/composer/options', what: '输入框的几个菜单', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/composer/choice', what: '换档、换模型', remote: { via: 'proxy' } },
  /**
   * 附件在外面走字节流,**文件到得了**;但 09-25 卡 S 查到:livekit-client 2.22 的 `sendFile` 把流上的属性丢了,
   * `purpose: attachment` 到不了工人,电脑那边把它当成「发来了一个文件」。维护者另起了一件在修
   * (remote attachments losing purpose tag):那边改的是 roomLink.ts 的 sendFile / composerApi.ts 的上传,
   * 可以直接用卡 S 加的 `WbchRoomLink.sendBytes`(带属性、只发一台、可关压缩),别再加一个。
   */
  { method: 'POST', path: '/composer/upload', what: '输入框附件上传', remote: { via: 'room', how: '在外面走 wb.file 字节流,进同一个收件文件夹(用途标记 purpose: attachment 眼下在路上丢了,另一件在修)' } },
  { method: 'GET', path: '/files/offer/:x', what: '取电脑上的一个文件(在家直接下)', remote: { via: 'room', how: '在外面让电脑经房间推(file_pull + wb.file)' } },
  // ———— 需求卡(指挥台) ————
  { method: 'POST', path: '/feature/docs', what: '需求卡四个页签', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feature/run', what: '让事务官推进这一步(派活)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feature/review', what: '把关三键', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feature/record', what: '写进决策记录', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feature/ship', what: '发版', remote: { via: 'proxy' } },
  // ———— 引导 ————
  { method: 'GET', path: '/onboarding', what: '引导进度', remote: { via: 'proxy' }, firstUse: true },
  { method: 'GET', path: '/onboarding/turns', what: '引导对话', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/onboarding/say', what: '引导里打字答她的问题', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/onboarding/session', what: '开引导那一场会话', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/onboarding/restart', what: '引导从头来', remote: { via: 'proxy' } },
  { method: 'POST', path: '/onboarding/leader', what: '引导改回手机上做', remote: { via: 'proxy' } },
  { method: 'POST', path: '/onboarding/materialize/apply', what: '「我照你说的摆好了」点「就这样」', remote: { via: 'proxy' }, firstUse: true },
  // ———— 语音与通话 ————
  { method: 'POST', path: '/butler/proxy/api/asr', what: '按住说话转文字', remote: { via: 'asr' }, firstUse: true },
  { method: 'POST', path: '/butler/proxy/api/tts', what: '朗读回复、电话垫场那几句的预取', remote: { lanOnly: '朗读回复要跟电脑连同一个 Wi-Fi 才有;在外面回复照样出字,想听就直接点电话' }, firstUse: true },
  { method: 'GET', path: '/butler/proxy/api/avatars', what: '形象列表', remote: { lanOnly: AVATAR_LAN_ONLY }, firstUse: true },
  { method: 'GET', path: '/butler/proxy/api/avatars/:x', what: '一个形象的配置', remote: { lanOnly: AVATAR_LAN_ONLY } },
  { method: 'GET', path: '/butler/proxy/api/avatars/:x/bundle.zip', what: '形象包(几 MB)', remote: { lanOnly: AVATAR_LAN_ONLY } },
  { method: 'GET', path: '/butler/proxy/api/rtc/status', what: '旧通话方式(火山)配了没有', remote: { lanOnly: OLD_CALL_LAN_ONLY } },
  { method: 'POST', path: '/butler/proxy/api/rtc/token', what: '旧通话方式的进房凭证', remote: { lanOnly: OLD_CALL_LAN_ONLY } },
  { method: 'POST', path: '/butler/proxy/api/rtc/start', what: '旧通话方式开始', remote: { lanOnly: OLD_CALL_LAN_ONLY } },
  { method: 'POST', path: '/butler/proxy/api/rtc/stop', what: '旧通话方式挂断', remote: { lanOnly: OLD_CALL_LAN_ONLY } },
  { method: 'GET', path: '/butler/status', what: '电脑上的语音后端在不在、现在是哪个音色', remote: { via: 'proxy' }, firstUse: true },
  { method: 'GET', path: '/channel/status', what: '能不能打电话', remote: { via: 'proxy' }, firstUse: true },
  // 局域网 M4(2026-10-21):判「在家」的那一问。经云房间转来的一问不能当「在家」,所以故意不进房间代理白名单(M2 有用例钉着)。
  { method: 'GET', path: '/channel/route', what: '判在家还是出门:这个地址上是不是配对过的那台、本机房间在哪', remote: { lanOnly: '在外面不用判这个:出门时手机直接走云上那间房' } },
  { method: 'POST', path: '/butler/call/record', what: '挂断后的通话记录', remote: { via: 'proxy' }, firstUse: true },
  { method: 'GET', path: '/call/log', what: '来电台账', remote: { via: 'proxy' } },
  { method: 'POST', path: '/call/out', what: '回拨', remote: { via: 'proxy' } },
  { method: 'POST', path: '/call/missed/clear', what: '清空未接', remote: { via: 'proxy' } },
  { method: 'GET', path: '/call/config', what: '座机设置', remote: { via: 'proxy' } },
  { method: 'POST', path: '/call/config', what: '改座机设置', remote: { via: 'proxy' } },
  // ———— 设置 ————
  { method: 'GET', path: '/butler/appearance', what: '粒子外观(继承电脑那一份)', remote: { via: 'proxy' }, firstUse: true },
  { method: 'GET', path: '/butler/rules', what: '她记住的规矩', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/rules', what: '添一条规矩', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/rules/update', what: '改一条规矩', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/rules/remove', what: '删一条规矩', remote: { via: 'proxy' } },
  { method: 'POST', path: '/butler/rules/restore', what: '恢复一条规矩', remote: { via: 'proxy' } },
  { method: 'GET', path: '/habits', what: '它从她的行为里学到了什么(试用 / 留下 / 撤掉的)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/habits/revoke', what: '撤掉一条学到的习惯', remote: { via: 'proxy' } },
  { method: 'POST', path: '/habits/restore', what: '撤错了,恢复一条学到的习惯(重新试用)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/habits/seen', what: '收件箱「新学到一条」那一句看过了', remote: { via: 'proxy' } },
  /**
   * 发诊断包(2026-10-21,内测发版底座):设置 › 关于与更新。出了事**多半正是在外面**,所以出门也得通 ——
   * 经房间送进去的只是「打个包」这一句,回来的只是编号与「包在哪」;包本身由电脑直接交给中转,不走房间。
   */
  { method: 'POST', path: '/diag/send', what: '发诊断包(电脑打包、交到服务器、回一个编号)', remote: { via: 'proxy' } },
  { method: 'GET', path: '/diag/send', what: '诊断包发出去没有、编号是多少', remote: { via: 'proxy' } },
  { method: 'GET', path: '/evolve/log', what: '进化日志(手机上只给摘要)', remote: { via: 'proxy' } },
  { method: 'GET', path: '/devices/online', what: '房里有哪几台设备', remote: { via: 'proxy' } },
  { method: 'GET', path: '/devices/transfers', what: '传输记录', remote: { via: 'proxy' } },
  /**
   * 取文件那条路 2026-10-04 多的两条(卡 `claude/phone-file-send-loop`):
   * 电脑主动推过来的卡、收到了报一句回执。两条都要在外面能用 ——
   * 她 9/29 起只带手机出门,「要一份文件」本来就是出门时最常用的那一件。
   */
  { method: 'GET', path: '/files/pending', what: '电脑推过来、等她点的那几张取文件的卡', remote: { via: 'proxy' }, firstUse: true },
  { method: 'POST', path: '/files/received', what: '收到了报一句(没有回执,那件事就不算办完)', remote: { via: 'proxy' }, firstUse: true },
  // ———— 资讯 ————
  { method: 'GET', path: '/feed', what: '资讯', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/feedback', what: '资讯「多来点 / 别再推」', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/config', what: '资讯设置', remote: { via: 'proxy' } },
  { method: 'GET', path: '/feed/aidj', what: '双主播播客节目单(音频直接从播客服务器拉)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/aidj/config', what: '播客设置', remote: { via: 'proxy' } },
  // 就一条资讯深聊(2026-10-13,卡「播客页重做」):工人白名单 RPC_ALLOWED 已放这四条,出门走房间代理。
  { method: 'POST', path: '/feed/dig', what: '就一条资讯深聊(文字 / 按住说话,回一段话)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/dig/note', what: '深聊结论存成随手记(来源那一行电脑拼)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/dig/task', what: '深聊结论做成事项(来源 / 项目由电脑按那条资讯填)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/feed/dig/call', what: '「打电话聊」之前记一格:下一通为这条资讯打', remote: { via: 'proxy' } },
  { method: 'GET', path: '/feed/podcast', what: '单人口播的音频(几 MB)', remote: { lanOnly: '单人口播要跟电脑连同一个 Wi-Fi 才能放;在外面听双主播那一档' } },
  { method: 'POST', path: '/feed/run', what: '「现在搜一轮」', remote: { lanOnly: '在外面还不能叫电脑现搜一轮;电脑按时搜好的照常能看' } },
  // ———— 配对、凭证、会议、推送 ————
  { method: 'WS', path: '/live', what: '快照实时推送、横屏展示台', remote: { lanOnly: '横屏展示台要跟电脑连同一个 Wi-Fi 才有;在外面竖着用,首页照常,每隔几秒刷新一次' }, firstUse: true },
  { method: 'POST', path: '/pair/claim', what: '扫码配对', remote: { lanOnly: '扫码配对要跟电脑连同一个 Wi-Fi;在外面用账号登录就行,不用扫码' }, firstUse: true },
  { method: 'POST', path: '/channel/relay-device', what: '扫码配对后顺手替手机领一把账号设备令牌', remote: { lanOnly: '这一步是扫码配对时顺手做的,要跟电脑连同一个 Wi-Fi;在外面用账号登录' } },
  /**
   * 「添加座机」最后一步(2026-09-27,卡 HS):电脑替座机在账号里登记一次。
   * **出了局域网也得通** —— 手机跟座机之间是蓝牙,跟电脑之间这一下多半不在同一个网
   * (他站在座机旁边、手机走着流量;座机那个网这会儿才刚配好)。
   */
  { method: 'POST', path: '/channel/relay-handset', what: '「添加座机」最后一步:请电脑替座机领一把账号设备令牌', remote: { via: 'proxy' } },
  { method: 'POST', path: '/channel/token', what: '领进房凭证(兜底那条)', remote: { via: 'relay', how: '在外面向中转领,不经电脑' }, firstUse: true },
  /*
   * 会议(2026-10-09,卡「会后真机走通」):只有文字的那几条(开 / 结束 / 看纪要 / 建事项 / 重新来)出门走房间代理,
   * 和别的事项文字一样。**录音本身**默认不出门:在外面攒在手机上、回家自动补传;她这一场点了「现在经服务器传」
   * 才走 `wb.meeting` 字节流(meetingApi.ts 管这道门,channel-worker/src/meetingRelay.ts 收)。
   */
  { method: 'GET', path: '/meeting', what: '一场会的纪要', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/start', what: '开一场会(手机先录着,连上了补开)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/segment', what: '会议分段录音', remote: { via: 'room', how: '她这一场点了「现在经服务器传」才走 wb.rpc 的 meeting_segment + wb.meeting 字节流;不然攒在手机上回家传' } },
  { method: 'POST', path: '/meeting/finish', what: '会开完了', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/apply', what: '会议待办落成事项', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/retry', what: '会议转写 / 梳理没成,重新来', remote: { via: 'proxy' } },
  // 会前(2026-10-10,卡「会前画像与预案」):登记、一问一答、预案卡、撤掉登记、会后那一句 —— 都是文字,出门走房间代理。
  // 花名档案(`/meeting/people*`)手机不调:只在她电脑上看、删。
  { method: 'POST', path: '/meeting/plan', what: '一句话登记一场待开的会', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/answer', what: '会前五问,答一问', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/card', what: '再做一次预案卡 / 目的没说清也先照现在的准备', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/drop', what: '撤掉一场待开的会(这不是会)', remote: { via: 'proxy' } },
  { method: 'POST', path: '/meeting/outcome', what: '会后回一句:要定的定下来没有', remote: { via: 'proxy' } },
  { method: 'POST', path: '/perf/handoff', what: '登录动画的性能记录(给维护者查卡顿)', remote: { lanOnly: '登录动画的性能记录要跟电脑连同一个 Wi-Fi 才交;在外面不交,不影响用' } },
];

/** 源码里出现、但**不是手机调电脑**的路径字面量(守门用例据此不追问)。每一条写清为什么。 */
export const NOT_PHONE_INTERFACES: readonly { path: string; why: string }[] = [
  { path: '/butler/proxy/api', why: '拼路径用的前缀常量,本身不是一条接口' },
  { path: '/v1/account/login', why: '中转(账号服务器)的接口,本来就不经电脑' },
  { path: '/v1/account/logout', why: '同上' },
  { path: '/v1/account/register', why: '同上' },
  { path: '/v1/channel-credentials', why: '同上' },
  { path: '/v1/channel-token', why: '同上' },
  { path: '/register-device', why: '同上(中转的设备登记)' },
  { path: '/butler/item/say', why: '请求号那张表(clientKey.ts)要与 8791 一字不差才列着它;手机不调,是电话工人给在办的事补一句用的' },
];

/** `/files/offer/abc?x=1` 对不对得上 `/files/offer/:x`。`:x` 只配一段。 */
export function phonePathMatches(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const got = (path.split('?')[0] ?? '').split('/');
  if (want.length !== got.length) return false;
  return want.every((seg, i) => (seg === ':x' ? (got[i] ?? '') !== '' : seg === got[i]));
}

/**
 * 在外面调到这一条时该说的那句(只在局域网的那几条才有)。channelClient.ts 用它当场回,不往房间里白跑一趟。
 * 表里没有的、或者有房间路的,回 undefined(照常发)。
 */
export function lanOnlyReason(method: string, path: string): string | undefined {
  const entry = PHONE_INTERFACES.find((one) => one.method === method && phonePathMatches(one.path, path));
  return entry !== undefined && 'lanOnly' in entry.remote ? entry.remote.lanOnly : undefined;
}
