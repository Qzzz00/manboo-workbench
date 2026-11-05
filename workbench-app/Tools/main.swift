import AppKit
import ApplicationServices
import Foundation

/// `_AXUIElementGetWindow` —— 把一个 AX 窗口元素换成系统窗口清单里的那个 id。苹果**没公开**这条,
/// 所以**只有这个探针用**(诊断用、不发版):Muse 那两扇窗位置尺寸一模一样,不靠它分不出
/// AX 露出来的到底是哪一扇,而这正是卡 MQ2 要判的事。壳(`Sources/`)里一个字都不用它。
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ windowId: UnsafeMutablePointer<CGWindowID>) -> AXError


/// AX 属性一格(读不到回 nil)。探针里到处要用,所以放文件作用域。
private func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &ref) == .success else { return nil }
    return ref
}

/// 这扇 AX 窗对应系统窗口清单里的哪个 id。**只有这个探针用那条私有 API**:
/// Muse 有两扇窗位置尺寸一模一样,光看几何量分不出 AX 露出来的是哪一扇,而这正是卡 MQ2 要判的事。
/// 壳(`Sources/`)里不用它 —— 生产代码不靠没公开的符号。
private func axCgId(_ el: AXUIElement) -> Int? {
    var id: CGWindowID = 0
    guard _AXUIElementGetWindow(el, &id) == .success, id != 0 else { return nil }
    return Int(id)
}

/// 一个 AX 元素的矩形(位置 + 大小;读不到回 nil)。`quota-keys` 要它 —— 「这颗键在窗口哪儿」
/// 是认那一页入口的关键线索(侧栏底下那一排和正文里那一片,光看名字分不开)。
private func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let pos = axAttr(el, kAXPositionAttribute as String), let size = axAttr(el, kAXSizeAttribute as String) else { return nil }
    var point = CGPoint.zero
    var box = CGSize.zero
    guard AXValueGetValue(pos as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &box) else { return nil }
    return CGRect(origin: point, size: box)
}

/// 这个进程的窗在系统窗口清单里:每扇的 id 与「在不在当前桌面上」(普通层、200pt 以上那几扇)。
/// **一个标题都不读**。
private func cgWindows(pid: pid_t) -> [(id: Int, onSpace: Bool, w: Int, h: Int)] {
    let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let onIds = Set(onScreen.compactMap { $0[kCGWindowNumber as String] as? Int })
    var rows: [(id: Int, onSpace: Bool, w: Int, h: Int)] = []
    for info in (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? [] {
        guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
              (info[kCGWindowLayer as String] as? Int) == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double,
              w >= 200, h >= 200,
              let id = info[kCGWindowNumber as String] as? Int else { continue }
        rows.append((id: id, onSpace: onIds.contains(id), w: Int(w), h: Int(h)))
    }
    return rows
}

/// 「送话进客户端窗口」的**实测工具**(2026-09-21)。不是壳的一部分,不进 `build.sh`。
///
/// 为什么要单独有它:每家客户端到底能不能被写进字,只有**在这台机器上真试一次**才知道
/// (卡上的规矩:不编数)。而壳本身是个 GUI 常驻程序 —— 随便起一份临时 build 会注册登录项、
/// 退出时覆盖 Ben 真的 `~/.dsh/workbench/app.json`、连上真 `/helper` 去挪他正开着的窗口
/// (2026-09-21「壳自动重开」那张卡记的坑)。所以这个工具**只编两个文件**
/// (`SendTextPolicy.swift` + `TextInsert.swift`),`AppDelegate` 一行都不进来:
/// 没有窗口、没有登录项、不碰 app.json、不连 8791。
///
/// 辅助功能授权(TCC)认的是签名里那条 designated requirement(`identifier "ai.ben.workbench"
/// and certificate leaf = H"…"`),所以 `probe-send-text.sh` 用**同一份 Info.plist + 同一张自签证书**
/// 打包签名 —— 系统认得这还是工作台,授权不用重点。跑法见那个脚本。
///
/// 用法:
///   probe list                                   —— 白名单里每家现在是什么样
///   probe find <bundle_id>                       —— 只找输入框,不动任何东西
///   probe send <bundle_id> "<要送的话>"           —— 送进输入框,**不按回车**
///   probe clear <bundle_id>                      —— 把输入框擦干净(验完收尾)
///   probe send <bundle_id> "<话>" --submit       —— 送进去并按发送(只对 TextEdit 这类靶子用)
///   probe send <bundle_id> "<话>" --new --submit —— 先按那家菜单里的「新对话」再送(2026-09-24,卡 F)
///   probe newchat <bundle_id>                    —— 只按「新对话」
///   probe read <bundle_id> <marker>              —— 只读:那扇窗里 marker 之后的文字(只对我们自己送的那句用)
///   probe apps                                   —— 只读:正在跑的常规 App 与它们包里写的身份(卡 Q,2026-09-25)
///   probe agent <bundle_id>                      —— 只读:那扇窗的**结构**(Agent 自动发现用的那一份,不读对话内容)
///   probe agent-read <bundle_id>                 —— 只读:窗口标题、停止键、对话区尾巴、侧栏(只对 Agent 用;微信 / 企业微信壳会拒)
///   probe approval <bundle_id> <原话>...          —— 只读:含这几截原话、又有几颗键的那几块(卡 AP,2026-10-01;与壳 `agent_approval` 不带 press 同一份,一颗都不按)
///   probe read-texts <bundle_id> [id=regex ...]  —— 只读:**每一扇标准窗**里额度那几小段(卡 MQ,2026-09-26;`--index N` 只读第 N 扇;`--watch` 看放出来的窗排在工作台前面还是后面,卡 MQ3)。`--titles` = 连「键身上的字」也收(卡「Grok 读键字」,2026-10-03;= 生产那一侧的 `include_titles`)
///   probe windows <bundle_id> [--enhanced] [--front]  —— 只读:这个 App 的窗在 AX 里长什么样,`AXWindows` 之外的几条路一起问(卡 MQ2,2026-09-26)
///   probe settings <bundle_id> [--no-front]      —— 从这家菜单里开「设置…」,开完立刻照一遍窗口清单(卡 MQ2;只按菜单那一项)。`--no-front` = **一下都不叫台前**(卡 QT:量「后台按菜单项到底行不行」)
///   probe hide <bundle_id>                       —— 把这家藏回后台(卡 QT,2026-10-03;量完善后用,只藏不点)
///   probe quota-link <bundle_id> <url> [id=regex ...] —— 在后台开一条它注册的深链(`open -g`),开完读一遍额度那几小段(卡 QT,2026-10-03;填 reach.link 用,本来藏着的量完藏回去)
///   probe spacewatch <bundle_id> [--switch-to <id>]  —— 只读:AX 的窗口清单与「在不在当前桌面上」**同一刻**对照着采几次(卡 MQ2)
///   probe quota-keys <bundle_id> [--at X,Y]      —— 只读:那几扇窗上按得下去的那些键都叫什么(卡 QP,2026-10-03;填 reach.press / reach.back 用,一颗都不按)。`--at` = 那一点上套着的每一个元素,**不论角色**(卡 QT)
///   probe quota-page <bundle_id> <label> [<label> ...] [--keys] —— 与壳 `quota_page` 同一份(卡 QP):只 unhide 不 activate,按只走 AXPress,按完原样藏回去。一串 label 一次按完(卡 QT);`--keys` = 藏回去之前再照一遍键名(看弹出来那张菜单)。`--front` = 叫到台前按、按完立刻把台前与隐藏状态都还原(卡「豆包闪一下」,2026-10-03;回包里 `ms` 就是「她眼前闪了多久」)。`--click` = 台前那一支里第一颗键用合成鼠标点击按(卡「豆包台前点一下」,2026-10-04;要与 `--front` 一起给)
///
/// ★ **2026-09-26(卡 QO):`--allow` —— 看运行时新接上的那几家。**
///
/// 壳的送话 / 读字门(`SendTextPolicy.isAllowed`)放行两种:壳里写死的那张表,加上**服务端报过来的**
/// 那几家(`agent_allow`,卡 Z:登记表里接上了的)。探针是个光身子进程,没人给它报过 —— 于是
/// `probe read-texts com.anysphere.sand` 只会回一句「不许往这个应用送话」,哪怕生产上的壳这会儿正放行着它。
/// `--allow <bundle_id>`(可给多次)就是**手动补那一下**:调的是服务端调的同一个函数
/// (`setDeclaredAgents`),微信 / 企业微信那条底线照旧剔掉(那一道门服务端说了也不算)。
/// 只在这个诊断工具里(`Tools/` 不进 `build.sh`,不进 /Applications),壳的行为一个字没变。
enum Probe {
    static func main() {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let cmd = args.first else { out(["ok": false, "error": "用法:probe list|find|send"]); exit(2) }

        // `--allow <bundle_id>`:把这几家当成「服务端报过来的 Agent」(同 agent_allow)。先摘出来,别让它混进位置参数。
        var declared: [String] = []
        while let at = args.firstIndex(of: "--allow"), at + 1 < args.count {
            declared.append(args[at + 1])
            args.removeSubrange(at...(at + 1))
        }
        if !declared.isEmpty { SendTextPolicy.setDeclaredAgents(declared) }

        guard AXIsProcessTrusted() else {
            out(["ok": false, "error": "这份二进制没有辅助功能授权(AXIsProcessTrusted=false)——签名对不上,测出来的会是一张假表,直接停"])
            exit(3)
        }

        switch cmd {
        case "list":
            var rows: [[String: Any]] = []
            for bundleId in SendTextPolicy.allowedBundleIds.sorted() {
                let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
                var row: [String: Any] = ["bundle_id": bundleId, "running": app != nil]
                if app != nil {
                    row["find"] = TextInsert.focusInput(bundleId: bundleId, index: 0, focus: false)
                }
                rows.append(row)
            }
            out(["ok": true, "ime": TextInsert.currentInputSourceID(), "apps": rows])
        case "find":
            guard args.count >= 2 else { out(["ok": false, "error": "probe find <bundle_id>"]); exit(2) }
            out(TextInsert.focusInput(bundleId: args[1], index: 0, focus: args.contains("--focus")))
        case "paste-image":
            // 把一张图粘贴进那家的输入框(2026-10-12,演示卡):与壳 `paste_image` 同一份。会碰她的剪贴板(先存后还)。
            guard args.count >= 3 else { out(["ok": false, "error": "probe paste-image <bundle_id> <图的路径>"]); exit(2) }
            out(TextInsert.pasteImage(bundleId: args[1], index: 0, path: args[2]))
        case "clear":
            // 验完把框里那段话擦掉 —— 送进去是为了证明送得进去,不是为了在人家的输入框里留字。
            guard args.count >= 2 else { out(["ok": false, "error": "probe clear <bundle_id>"]); exit(2) }
            out(TextInsert.clearInput(bundleId: args[1], index: 0))
        case "newchat":
            // 只按「新对话」,不送字(2026-09-24,卡 F)。
            guard args.count >= 2 else { out(["ok": false, "error": "probe newchat <bundle_id>"]); exit(2) }
            out(TextInsert.openNewConversation(bundleId: args[1]))
        case "read":
            // 只读:回那扇窗里 marker 之后的文字(2026-09-24,卡 F)。只对我们自己送进去的那句用。
            guard args.count >= 3 else { out(["ok": false, "error": "probe read <bundle_id> <marker>"]); exit(2) }
            out(TextInsert.readReply(bundleId: args[1], index: 0, marker: args[2]))
        case "apps":
            // 卡 Q(2026-09-25):与壳 `running_apps` 同一份。
            out(AgentWindow.runningApps(ownBundleId: "ai.ben.workbench"))
        case "agent":
            // 卡 Q:与壳 `agent_probe` 同一份 —— 只读结构,不读对话内容。
            guard args.count >= 2 else { out(["ok": false, "error": "probe agent <bundle_id>"]); exit(2) }
            out(AgentWindow.probe(bundleId: args[1]))
        case "agent-read":
            // 卡 Q:与壳 `agent_read` 同一份。人跟人聊天的应用壳会拒(AgentWindowPolicy.neverRead)。
            guard args.count >= 2 else { out(["ok": false, "error": "probe agent-read <bundle_id>"]); exit(2) }
            out(AgentWindow.read(bundleId: args[1]))
        case "approval":
            // 卡 AP(2026-10-01):与壳 `agent_approval` 只读那一下同一份 —— 一颗键都不按。
            guard args.count >= 3 else { out(["ok": false, "error": "probe approval <bundle_id> <原话>..."]); exit(2) }
            // 碰到第一个 `--`(--out)就停,它后面那个路径不是原话。
            let marks = Array(args[2...].prefix { !$0.hasPrefix("--") })
            out(AgentWindow.approval(bundleId: args[1], marks: marks, press: nil, panel: nil))
        case "agent-images":
            // 卡 T(2026-10-13 夜):与壳 `agent_images` 同一份(AgentWindow.images),只读 —— 核回包形状用。
            guard args.count >= 2 else { out(["ok": false, "error": "probe agent-images <bundle_id>"]); exit(2) }
            out(AgentWindow.images(bundleId: args[1]))
        case "images":
            // 卡 T 量法(2026-10-13 夜):**只读** —— 一扇窗里图片类节点(AXImage / 进度圈)的位置、AXURL、说明,
            // 比壳的 op 多带进度圈与「loading / 上传」字样的节点。先在传完的页上留底,再在拖图那 15 秒里每 0.5 秒跑一次对比。
            guard args.count >= 2 else { out(["ok": false, "error": "probe images <bundle_id>"]); exit(2) }
            out(ProbeImages.dump(bundleId: args[1]))
        case "windows":
            // 卡 MQ(2026-09-26)的**只读**探针:这个 App 的 AX 窗口清单 —— 每一扇的 role / subrole /
            // 位置大小、是不是主窗、有没有最小化。
            //
            // **窗口标题一个字都不往外带**(聊天窗的标题多半就是他那条对话的名字):只回标题几个字,
            // 以及它是不是「设置 / 登录 / 欢迎」这三类里的一类(一张写死的小表)。
            //
            // ★ 卡 MQ2(2026-09-26)扩到「`AXWindows` 之外的几条路一起问」:卡 MQ 收尾时看着像
            // 「设置窗明明开着、`AXWindows` 却不列它」,于是要把主窗 / 焦点窗 / 应用元素的 children /
            // 敲门过一拍再取 / 挂在别的窗底下的 sheet / 照系统窗口中心点位测,一条一条都问一遍 ——
            // 量下来**一条都不用**:那扇窗只要在这会儿显示着的桌面上,`AXWindows` 里就有它;
            // 不在,哪条路都没有。当初那个「矛盾」是两次跑探针跨了一次桌面切换(见 `spacewatch`)。
            guard args.count >= 2 else { out(["ok": false, "error": "probe windows <bundle_id> [--enhanced] [--front]"]); exit(2) }
            out(windowsProbe(args[1], enhanced: args.contains("--enhanced"), front: args.contains("--front")))
        case "settings":
            // 卡 MQ2(2026-09-26):从这家**自己的菜单**里开「设置…」,开完立刻照一遍窗口清单。
            // 为什么要有这一下:上一次量的时候那扇设置窗自己关掉了,而「它开着的那一刻 AX 里有没有它」
            // 正是这张卡的题目。卡里明说**菜单开设置可以**;窗口里的按钮一个都不点、一句话也不发。
            guard args.count >= 2 else { out(["ok": false, "error": "probe settings <bundle_id> [id=regex ...] [--no-front]"]); exit(2) }
            // 后面给了正则就**在同一个进程里**紧接着读一遍(只读命中的那一小段)——
            // 换一次进程就换一次台前 / 当前桌面,那扇刚开的设置窗又照不到了。
            //
            // ★ `--no-front`(卡 QT,2026-10-03):**不把它叫到台前**就去按那一项。
            // 这是「自动那一轮能不能替她开设置窗」的命门 —— 菜单项的亮 / 灰跟着台前变,
            // 到底灰不灰、`AXPress` 在后台到底有没有效,只有这么量一次才知道(不猜)。
            out(settingsProbe(args[1], patterns: SendTextPolicy.parseTextPatterns(patternArgs(args)),
                              front: !args.contains("--no-front")))
        case "spacewatch":
            // 卡 MQ2(2026-09-26)的关键一量:**同一个进程里、同一刻**同时问
            // 「AX 列了哪几扇窗」与「系统说这几扇在不在当前桌面上」,中途还可以切一次台前的 App。
            // 为什么非得同一个进程:探针每跑一次都是一个新的 GUI 进程,那一下自己会换台前、
            // 连当前桌面都可能跟着变 —— 分两次跑量出来的两张表根本对不上(卡 MQ 那次就对不上)。
            //
            //   probe spacewatch <bundle_id> [--switch-to <另一个 bundle_id>] [--samples N]
            //
            // 只 activate,不点任何按钮、不发任何话。
            guard args.count >= 2 else { out(["ok": false, "error": "probe spacewatch <bundle_id> [--switch-to <bundle_id>] [--samples N]"]); exit(2) }
            var switchTo: String?
            if let at = args.firstIndex(of: "--switch-to"), at + 1 < args.count { switchTo = args[at + 1] }
            var samples = 4
            if let at = args.firstIndex(of: "--samples"), at + 1 < args.count, let n = Int(args[at + 1]) { samples = max(1, min(12, n)) }
            out(spaceWatch(args[1], switchTo: switchTo, samples: samples))
        case "read-texts":
            // 卡 MQ(2026-09-26)的**只读**探针:让壳对这个 App 的**每一扇标准窗**跑一次 read_texts,
            // 回的是「哪一扇窗、命中了哪几小段」。用来判「额度那几个字到底在第几扇窗上、AX 里露不露出来」——
            // 「选错窗」和「AX 里没那段字」在界面上长得一模一样,只有这么看一眼才分得开。
            //
            // 后面可以给自己的正则(`id=regex`),不给就用下面那组**宽松但只认额度那几小段**的缺省:
            // 回来的永远只有正则命中的那一小段(≤80 字),他的对话内容带不出来,也不落盘。
            // `--index N` = 只读第 N 扇(复现老壳写死第 0 扇的样子)。
            guard args.count >= 2 else { out(["ok": false, "error": "probe read-texts <bundle_id> [id=regex ...] [--index N]"]); exit(2) }
            var raw = patternArgs(args)
            if raw.isEmpty { raw = defaultQuotaPatterns }
            guard let patterns = SendTextPolicy.parseTextPatterns(raw) else {
                out(["ok": false, "error": "正则不认(要 id=regex,最多 \(SendTextPolicy.readTextsMaxPatterns) 条)"]); exit(2)
            }
            var onlyIndex: Int?
            if let at = args.firstIndex(of: "--index"), at + 1 < args.count { onlyIndex = Int(args[at + 1]) }
            // `--front`:先把那家切到台前再读。**读额度的生产路径不这么干**(读一下不该抢焦点),
            // 这里是为了量「那扇窗在当前桌面上时读不读得到」—— 别的桌面上的窗 AX 根本不列(见 frontUp)。
            var frontedRead: [String: Any] = ["asked": false]
            if args.contains("--front"), let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first {
                frontedRead = frontUp(app)
            }
            // 卡 MQ3(2026-09-26):读之前 / 读完的 `isHidden` 与 `isActive` 一起打出来 —— 真机上就靠这三格
            // 核「藏着的家放出来读到了、读完又照原样藏回去了、而且没被叫到台前」。
            let probeApp = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first
            let hiddenBefore = probeApp?.isHidden
            // `--watch`:读的这一两秒里,放出来的窗排在工作台前面还是后面(见 startUnhideWatch)。
            let watching = args.contains("--watch") ? startUnhideWatch(args[1], everyMs: 120, forMs: 6_000) : nil
            let readStarted = CFAbsoluteTimeGetCurrent()
            // `--no-unhide`:复现卡 MQ3 之前那条路(藏着的不放出来,直接读)—— 同一刻对照才看得出差别。
            // `--titles`(卡「Grok 读键字」,2026-10-03):连「键身上的字」也收(= 生产那一侧的
            // `include_titles`)。同一刻跑两遍(带 / 不带)就量得出那个数到底在哪一类节点上。
            var texts = TextInsert.readTexts(bundleId: args[1], index: onlyIndex, patterns: patterns,
                                             unhideHidden: !args.contains("--no-unhide"),
                                             includeTitles: args.contains("--titles"))
            texts["fronted"] = frontedRead
            texts["ms"] = Int(((CFAbsoluteTimeGetCurrent() - readStarted) * 1000).rounded())
            texts["hidden_before"] = hiddenBefore ?? NSNull()
            texts["hidden_after"] = probeApp?.isHidden ?? NSNull()
            texts["active_after"] = probeApp?.isActive ?? NSNull()
            // `NSRunningApplication` 的这几格是 KVO 异步更新的(苹果的话:别指望它当场就是新的),
            // 所以再跑一拍运行循环让通知落地,再读一遍 —— 「读完藏回去了没有」看的是 `*_settled` 这两格。
            RunLoop.current.run(until: Date().addingTimeInterval(0.7))
            texts["hidden_settled"] = probeApp?.isHidden ?? NSNull()
            texts["active_settled"] = probeApp?.isActive ?? NSNull()
            if let watching { texts["watch"] = watching() }
            out(texts)
        case "icon-color":
            // 卡 Q:与壳 `icon_colors` 同一份 —— 各家图标的主色(不碰辅助功能,没签名也能跑)。
            guard args.count >= 2 else { out(["ok": false, "error": "probe icon-color <bundle_id> [...]"]); exit(2) }
            out(AgentWindow.iconColors(bundleIds: Array(args.dropFirst())))
        case "app-icon":
            // 卡 LG(2026-09-26):与壳 `app_icon` 同一份 —— 整张图标渲成 PNG(不碰辅助功能,没签名也能跑)。
            // **不把 base64 打到终端**(一张十几 KB,刷屏还没法读):只报取到没取到、多大、多少字节;
            // 带 --save <目录> 就把 PNG 落到 <目录>/<包标识>.png,好拿眼睛看一眼渲出来的是什么。
            guard args.count >= 2 else { out(["ok": false, "error": "probe app-icon <bundle_id> [...] [--save <目录>]"]); exit(2) }
            var saveDir: String?
            if let at = args.firstIndex(of: "--save"), at + 1 < args.count { saveDir = args[at + 1] }
            // 只把**开头那几个**当包标识:碰到第一个 `--`(--save / --out)就停 —— 否则它后面那个路径
            // 会被当成一个包标识,回一条「这台电脑上没装」的噪音。
            var bundleIds: [String] = []
            for arg in args.dropFirst() {
                if arg.hasPrefix("--") { break }
                bundleIds.append(arg)
            }
            var rows: [[String: Any]] = []
            for bundleId in bundleIds {
                let raw = AgentWindow.appIcon(bundleId: bundleId, size: nil)
                var row: [String: Any] = ["bundle_id": bundleId]
                let result = raw["result"] as? [String: Any] ?? [:]
                row["found"] = result["found"] as? Bool ?? false
                if let why = result["why"] as? String { row["why"] = why }
                if let bytes = result["bytes"] as? Int { row["bytes"] = bytes }
                if let w = result["w"] as? Int, let h = result["h"] as? Int { row["size"] = "\(w)×\(h)" }
                if let dir = saveDir, let base64 = result["png"] as? String, let data = Data(base64Encoded: base64) {
                    let path = "\(dir)/\(bundleId).png"
                    row["saved"] = (try? data.write(to: URL(fileURLWithPath: path))) == nil ? false : path
                }
                rows.append(row)
            }
            out(["ok": true, "result": ["icons": rows]])
        case "quota-keys":
            // 卡 QP(2026-10-03)的**只读**探针:那几扇窗上**按得下去**的那些键都叫什么。
            // 一颗都不按、一个字都不写 —— 这是填 `WindowQuotaSpec.reach.press` / `reach.back`
            // 那两格的唯一诚实办法(壳的 `agent_ax_detail` 只回字数,看不见键名)。
            // 藏着的那一家放出来看(**不 activate**)、看完原样藏回去,同 `quota_page` 本身。
            guard args.count >= 2 else { out(["ok": false, "error": "probe quota-keys <bundle_id> [--at X,Y]"]); exit(2) }
            // `--at X,Y`(窗口相对,就是 `read-texts` 命中里那两个数):那一点上套着的每一个元素,
            // **不论角色** —— 分开「它没有这颗键」与「我们的角色白名单认不出这颗键」。
            var atPoint: CGPoint?
            if let i = args.firstIndex(of: "--at"), i + 1 < args.count {
                let parts = args[i + 1].split(separator: ",").compactMap { Double($0) }
                if parts.count == 2 { atPoint = CGPoint(x: parts[0], y: parts[1]) }
            }
            out(quotaKeysProbe(args[1], point: atPoint))
        case "hide":
            // 量完善后用的一下(卡 QT,2026-10-03):把这家藏回后台(`NSRunningApplication.hide()`,
            // 同窗口槽那一手)。**量额度那几条路有一条会把它放出来又没法藏回去**
            // (开深链那一下系统自己把它叫到了台前,`shouldRehide` 就不再藏它)——
            // 那时她眼前会留着一扇窗,这一条是把它收回去的手。只藏,不点、不写、不读。
            guard args.count >= 2 else { out(["ok": false, "error": "probe hide <bundle_id>"]); exit(2) }
            guard let hiding = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first else {
                out(["ok": false, "error": "\(args[1]) 没在运行"]); exit(2)
            }
            let askedHide = hiding.hide()
            RunLoop.current.run(until: Date().addingTimeInterval(0.7))
            out(["ok": true, "result": ["asked": askedHide, "hidden_settled": hiding.isHidden,
                                        "active_settled": hiding.isActive,
                                        "front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""]])
        case "quota-link":
            // 卡 QT(2026-10-03):在后台开一条它自己注册的深链,看开到了哪一页(填 `reach.link`)。
            // 只 `open -g`(不抢焦点)、地址由命令行给(探针不拼参数)、本来藏着的量完藏回去。
            guard args.count >= 3 else { out(["ok": false, "error": "probe quota-link <bundle_id> <url> [id=regex ...]"]); exit(2) }
            // 正则从第 4 个参数起数(第 3 个是地址,别让一条带 `=` 的地址被当成正则)。
            var linkRaw: [[String: Any]] = []
            for spec in args.dropFirst(3) where !spec.hasPrefix("--") && spec.contains("=") {
                let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
                linkRaw.append(["id": parts[0], "regex": parts[1]])
            }
            if linkRaw.isEmpty { linkRaw = defaultQuotaPatterns }
            guard let linkPatterns = SendTextPolicy.parseTextPatterns(linkRaw) else {
                out(["ok": false, "error": "正则不认(要 id=regex)"]); exit(2)
            }
            out(quotaLinkProbe(args[1], url: args[2], patterns: linkPatterns))
        case "quota-page":
            // 卡 QP(2026-10-03):与壳 `quota_page` **同一份**(直接调生产那个函数)——
            // 在后台把那家翻到额度那一页:只 unhide、不 activate,按只走 AXPress。
            // 真机上就靠这一下核「认到那颗键了、按下去了、她眼前没被抢焦点」。
            //
            // ★ 卡 QT(2026-10-03):**一串 label 一次按完**(弹出式菜单在两条 op 之间会收掉);
            // `--keys` = 按完**在藏回去之前**再照一遍那几扇窗上的键 —— 弹出来的那张菜单里
            // 下一颗键叫什么,只有这一刻看得见(分两次跑探针,菜单早收了)。
            guard args.count >= 3 else { out(["ok": false, "error": "probe quota-page <bundle_id> <label> [<label> ...] [--keys]"]); exit(2) }
            let pressLabels = Array(args.dropFirst(2).prefix { !$0.hasPrefix("--") })
            let probeApp = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first
            let frontBefore = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            let wantKeys = args.contains("--keys")
            /*
             * `--keys`:**先自己把它放出来**,这样 `quotaPage` 看见的 `wasHidden` 是 false、
             * 返回时不会藏回去 —— 弹出来那张菜单于是还在,照得到键名;照完由探针自己藏回去。
             * (藏回去那一下菜单就收了,所以分两次跑探针永远照不到那张菜单。)
             */
            let keysWasHidden = wantKeys && (probeApp?.isHidden ?? false)
            if keysWasHidden { probeApp?.unhide(); RunLoop.current.run(until: Date().addingTimeInterval(Double(SendTextPolicy.unhideWaitMs) / 1000)) }
            /*
             * `--front`(卡「豆包闪一下」,2026-10-03):**叫到台前按、按完立刻把台前与隐藏状态
             * 都还原**(= 生产那一侧的 `front: true`)。这一下她眼前会闪一下 —— `ms` 那一格量的
             * 就是「闪了多久」,`front_before` / `front_after` 量的是「焦点回来没」。
             */
            // `--watch-menu`(卡「豆包台前点一下」):这几秒里那一家在屏幕上多出过什么窗
            // —— 分得开「原生菜单压根没弹」与「弹了但 AX 树上看不见」(见 startMenuWatch)。
            let menuWatching = args.contains("--watch-menu")
                ? startMenuWatch(args[1], everyMs: 100, forMs: 6_000) : nil
            let pageStarted = CFAbsoluteTimeGetCurrent()
            /*
             * `--click`(卡「豆包台前点一下」,2026-10-04):台前那一支里**第一颗键**用
             * 合成鼠标点击按(= 生产那一侧的 `click: true`)。要与 `--front` 一起给才作数。
             * 量的就是「照她那样点一下,那张原生菜单进不进 AX 树」(`menu_roots`)。
             */
            var paged = AgentWindow.quotaPage(bundleId: args[1], labels: pressLabels,
                                              front: args.contains("--front"),
                                              click: args.contains("--click"))
            paged["ms"] = Int(((CFAbsoluteTimeGetCurrent() - pageStarted) * 1000).rounded())
            paged["labels"] = pressLabels
            if wantKeys {
                paged["keys_after"] = quotaKeysProbe(args[1])
                if keysWasHidden, let probeApp,
                   SendTextPolicy.shouldRehide(wasHidden: true, isActive: probeApp.isActive) { probeApp.hide() }
            }
            paged["hidden_after"] = probeApp?.isHidden ?? NSNull()
            // 这几格是 KVO 异步更新的(同 read-texts 那一段):再跑一拍运行循环让通知落地再读。
            RunLoop.current.run(until: Date().addingTimeInterval(0.7))
            paged["hidden_settled"] = probeApp?.isHidden ?? NSNull()
            paged["active_settled"] = probeApp?.isActive ?? NSNull()
            paged["front_before"] = frontBefore ?? NSNull()
            paged["front_after"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? NSNull()
            if let menuWatching {
                // 采样跑 6 秒,上面那一串顶多两三秒 —— 等它跑完再收,不然收到的是半张表。
                RunLoop.current.run(until: Date().addingTimeInterval(6.2))
                paged["menu_watch"] = menuWatching()
            }
            out(paged)
        case "op":
            // 端到端跑接力用(2026-10-12,演示卡「出图进可灵」):收一条**与壳协议同形**的请求(JSON),
            // 调壳 `runOp` 那几支调的同一个函数。只认接力用到的那几样;别的照实说不认。
            guard args.count >= 2, let data = args[1].data(using: .utf8),
                  let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let op = msg["op"] as? String, let bundleId = msg["bundle_id"] as? String else {
                out(["ok": false, "error": "probe op '<{\"op\":…,\"bundle_id\":…}>'"]); exit(2)
            }
            let index = msg["index"] as? Int ?? 0
            switch op {
            case "focus_input":
                out(TextInsert.focusInput(bundleId: bundleId, index: index, focus: msg["focus"] as? Bool ?? false))
            case "send_text":
                out(TextInsert.sendText(bundleId: bundleId, index: index, text: msg["text"] as? String ?? "",
                                        submit: msg["submit"] as? Bool ?? false,
                                        restoreFront: msg["restore_front"] as? Bool ?? false,
                                        overwrite: msg["overwrite"] as? Bool ?? false,
                                        newConversation: msg["new_conversation"] as? Bool ?? false,
                                        saveDraft: msg["save_draft"] as? Bool ?? false))
            case "press_below_text":
                out(TextInsert.pressBelowText(bundleId: bundleId, index: index, pattern: msg["pattern"] as? String ?? "",
                                              role: msg["role"] as? String ?? "", maxBelow: msg["max_below"] as? Int ?? 80))
            case "clear_frames":
                out(TextInsert.clearFrames(bundleId: bundleId, index: index))
            case "clear_composer":
                out(TextInsert.clearComposer(bundleId: bundleId, index: index, click: msg["click"] as? Bool ?? false))
            case "paste_image":
                out(TextInsert.pasteImage(bundleId: bundleId, index: index, path: msg["path"] as? String ?? ""))
            case "agent_press":
                let role = (msg["role"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                out(AgentWindow.press(bundleId: bundleId, label: msg["label"] as? String ?? "", role: role))
            case "agent_read":
                out(AgentWindow.read(bundleId: bundleId))
            case "read_reply":
                out(TextInsert.readReply(bundleId: bundleId, index: index, marker: msg["marker"] as? String ?? ""))
            case "unhide_app":
                let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
                for app in apps where app.isHidden { app.unhide() }
                out(["ok": true, "result": ["apps": apps.count]])
            default:
                out(["ok": false, "error": "probe op 不认这个 op:\(op)"])
            }
        case "send":
            guard args.count >= 3 else { out(["ok": false, "error": "probe send <bundle_id> \"<话>\""]); exit(2) }
            // 耗时由**工具自己量**:外面用 shell 量的那一份里有 LaunchServices 拉起进程的
            // 一秒多,那不是这条原语的成本,写进实测表会把人误导。
            let started = CFAbsoluteTimeGetCurrent()
            var result = TextInsert.sendText(bundleId: args[1], index: 0, text: args[2],
                                             submit: args.contains("--submit"),
                                             restoreFront: args.contains("--restore-front"),
                                             overwrite: args.contains("--overwrite"),
                                             newConversation: args.contains("--new"))
            result["ms"] = Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded())
            out(result)
        default:
            out(["ok": false, "error": "不认识的子命令:\(cmd)"])
            exit(2)
        }
    }

    // MARK: - probe quota-link(卡 QT,2026-10-03:填 reach.link 那一格)

    /**
     **在后台开一条它自己注册的深链,看开到了哪一页**(`open -g <url>`,与读额度那一侧
     `backgroundOpenCommand` / `backgroundLinkCommand` 同一条命令),开完立刻读一遍额度那几小段。

     为什么要有这一条:`reach.link` 那一格「查实过才写」(卡 QZ 的 D13),而查实的唯一办法是
     **在这台机器上开一次**。隔着 `Info.plist` 只看得见注册了哪几个 scheme,看不见哪条地址开到哪一页。

     纪律(与生产那条路一样,外加探针自己要善后):
     - **只 `open -g`**(不激活、不抢焦点);地址由命令行给,探针自己不拼参数;
     - **本来藏着的,最后照原样藏回去** —— 开深链会把藏着的那家放出来(这正是要量的事之一),
       而生产那条路上 `read_texts` 的 `wasHidden` 已经是 false、不会再藏它。所以这里量完自己藏,
       并把 `hidden_before` / `hidden_after` / `hidden_settled` 三格都打出来:
       **生产那一侧要不要补一手「开完深链自己藏回去」,看的就是这三格**;
     - 窗口清单与命中都照 `read_texts` 那一份(同一个函数),不另写一套。
     */
    private static func quotaLinkProbe(_ bundleId: String, url: String, patterns: [SendTextPolicy.TextPattern]) -> [String: Any] {
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": "不许读这个应用的窗口:\(bundleId)(要 --allow)"]
        }
        let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
        let hiddenBefore = app?.isHidden
        let frontBefore = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-g", url]
        let err = Pipe()
        task.standardError = err
        task.standardOutput = Pipe()
        var opened = false
        var note = ""
        do {
            try task.run()
            task.waitUntilExit()
            opened = task.terminationStatus == 0
            note = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        catch { note = "\(error)" }
        // 开一扇窗要一拍(新窗要建、AX 那边也要登记);同 settingsProbe 那一拍。
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        var result: [String: Any] = ["ok": true, "url": url, "opened": opened]
        if !note.isEmpty { result["note"] = AgentWindowPolicy.clip(note, 200) }
        result["hidden_before"] = hiddenBefore ?? NSNull()
        result["windows"] = windowsProbe(bundleId, enhanced: false, front: false)["windows"] ?? NSNull()
        result["read_texts"] = TextInsert.readTexts(bundleId: bundleId, index: nil, patterns: patterns)
        let after = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
        result["hidden_after"] = after?.isHidden ?? NSNull()
        result["front_after"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? NSNull()
        result["front_before"] = frontBefore ?? NSNull()
        // 善后:本来藏着就藏回去(同 `SendTextPolicy.shouldRehide` 那条判据 —— 这会儿她自己在用它就不藏)。
        if hiddenBefore == true, let after,
           SendTextPolicy.shouldRehide(wasHidden: true, isActive: after.isActive) { after.hide() }
        RunLoop.current.run(until: Date().addingTimeInterval(0.7))
        result["hidden_settled"] = after?.isHidden ?? NSNull()
        result["active_settled"] = after?.isActive ?? NSNull()
        return result
    }

    // MARK: - probe quota-keys(卡 QP,2026-10-03:填 reach.press / reach.back 那两格)

    /**
     那几扇窗上**按得下去**的那些键都叫什么(**只读,一颗都不按**)。

     为什么非要这一条:`reach.press` 要写的是「按过去那颗键的原话」,而壳 `agent_ax_detail`
     为了不把她窗口里的字带出来**只回字数** —— 隔着那一份填不出键名,只能在这台机器上看一眼。
     猜一个填上去的后果是「按错一颗键」(D13:查实过才写)。

     走法与**角色表**照着 `AgentWindow.optionItems` 抄(那是 `quota_page` 真去认键的那一处):
     可按的角色、三处标签(title / description / value)、自己身上没字就拼底下那几截静态字。
     这里不做匹配、不挑唯一 —— 把看见的原样列出来,挑哪一个是人的事。
     **看完原样藏回去**(同 `quota_page`:`unhide` 不 activate,`defer` 里按 `shouldRehide` 藏)。
     */
    private static func quotaKeysProbe(_ bundleId: String, point: CGPoint? = nil) -> [String: Any] {
        guard SendTextPolicy.isAllowed(bundleId) else {
            return ["ok": false, "error": "不许读这个应用的窗口:\(bundleId)(要 --allow)"]
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": "\(bundleId) 没在运行"]
        }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        // Chromium / Electron 的 AX 通道默认关着,敲一次门(同 AXWake,这里不 import 壳那一份)。
        AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        let wasHidden = app.isHidden
        if wasHidden { app.unhide() }
        defer {
            if SendTextPolicy.shouldRehide(wasHidden: wasHidden, isActive: app.isActive) { app.hide() }
        }
        var windows: [AXUIElement] = []
        var looks = 0
        repeat {
            if wasHidden { RunLoop.current.run(until: Date().addingTimeInterval(Double(SendTextPolicy.unhideWaitMs) / 1000)) }
            windows = (axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
            looks += 1
        } while wasHidden && SendTextPolicy.worthAnotherUnhideLook(windows: windows.count, looks: looks)
        /// 可按的角色:**就是壳那一份**(`AgentWindowPolicy.pressableRoles`,卡 QT 起一处主人)——
        /// 探针里再抄一份的后果是「探针看得见、壳看不见」,那正是 10-03 这张卡要治的误判。
        let pressableRoles = AgentWindowPolicy.pressableRoles
        func text(_ el: AXUIElement, _ name: String) -> String? {
            guard let s = axAttr(el, name) as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        /// 走过几个节点。**真机上这个数要和壳 `quota_page` 回的 `visited` 对着看**:
        /// 两边差不多(10-03 实测 314 / 313)就说明「壳也走到了那几颗键」—— 那时「认不出」是
        /// **认**的问题,不是走的问题(10-03 就是这么定位到 `pickOptionRows` 那一条的)。
        var visitedAll = 0
        var rows: [[String: Any]] = []
        /*
         * `--at X,Y`(卡 QT,2026-10-03):**那一点上套着的每一个元素,不论角色**。
         *
         * 为什么要它:`read_texts` 回的命中带着窗口相对坐标(「套餐」在豆包侧栏 x=57 y=941),
         * 而上面那张键表按**角色白名单**收 —— 一行 `AXGroup` / `AXGenericElement` 就算按得下去,
         * 那张表里也没有它。于是「它没有这颗键」与「我们的白名单认不出这颗键」在结果里长得一模一样。
         * 这一格把那一点上从窗口到叶子的整条链原样列出来(角色 + 按不按得下去 + 身上那几处字),
         * 分得开的就是这两件事。
         */
        var atRows: [[String: Any]] = []
        var others: [[String: Any]] = []
        /*
         * ★ 卡 QT(2026-10-03):**应用元素底下那几个不是窗的**(今天就是 `AXMenu`)也走一遍,
         * 记成 `window: -1`。
         *
         * 为什么要它:豆包那颗 `AXPopUpButton`「<账号名> 标准套餐」按下去之后,**整扇窗的树一个字没变** ——
         * 它弹出来的那张菜单是 Chromium 交给系统画的原生菜单,挂在**应用元素**底下,不在 `AXWindows` 里。
         * 而壳的 `quota_page` / `agent_press` 只走窗口 —— 于是「菜单弹出来了」与「这一下什么都没发生」
         * 在结果里长得一模一样。这一格就是把这两件事分开。
         */
        var roots: [(index: Int, element: AXUIElement)] = windows.enumerated().map { ($0.offset, $0.element) }
        if let kids = axAttr(appEl, kAXChildrenAttribute as String) as? [AXUIElement] {
            for kid in kids where !windows.contains(where: { CFEqual($0, kid) }) {
                let role = (axAttr(kid, kAXRoleAttribute as String) as? String) ?? ""
                if role == kAXWindowRole as String || role == kAXMenuBarRole as String { continue }
                roots.append((-1, kid))
            }
        }
        for (at, window) in roots {
            AXUIElementSetMessagingTimeout(window, 0.5)
            let winFrame = axFrame(window) ?? .zero
            var visited = 0
            var stack: [(AXUIElement, Int)] = [(window, 0)]
            while let (element, depth) = stack.popLast() {
                if visited >= 6_000 || rows.count >= 400 { break }
                visited += 1
                visitedAll += 1
                let role = text(element, kAXRoleAttribute as String) ?? ""
                let children = (axAttr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
                if let point, let r = axFrame(element), atRows.count < 60 {
                    let rel = AgentWindowPolicy.relative(r, to: winFrame)
                    if rel.contains(point) {
                        var actions: CFArray?
                        AXUIElementCopyActionNames(element, &actions)
                        let labels = [text(element, kAXTitleAttribute as String),
                                      text(element, kAXDescriptionAttribute as String),
                                      text(element, kAXValueAttribute as String)].compactMap { $0 }
                        atRows.append(["window": at, "role": role, "depth": depth,
                                       "x": AgentWindowPolicy.int(rel.origin.x), "y": AgentWindowPolicy.int(rel.origin.y),
                                       "w": AgentWindowPolicy.int(rel.width), "h": AgentWindowPolicy.int(rel.height),
                                       "actions": (actions as? [String]) ?? [],
                                       "labels": labels.map { AgentWindowPolicy.clip($0, 60) }])
                    }
                }
                /// 这个元素身上那几处字(三处 + 自己没字就拼底下那几截静态字;同 `optionHits`)。
                func labelsOf() -> [String] {
                    var labels = [text(element, kAXTitleAttribute as String),
                                  text(element, kAXDescriptionAttribute as String),
                                  text(element, kAXValueAttribute as String)].compactMap { $0 }
                    if labels.isEmpty {
                        let inner = children.compactMap { child -> String? in
                            guard text(child, kAXRoleAttribute as String) == kAXStaticTextRole as String else { return nil }
                            return text(child, kAXValueAttribute as String) ?? text(child, kAXTitleAttribute as String)
                        }.joined(separator: " ")
                        if !inner.trimmingCharacters(in: .whitespaces).isEmpty { labels = [inner] }
                    }
                    return labels
                }
                func frameOf() -> [String: Any] {
                    guard let r = axFrame(element) else { return [:] }
                    let rel = AgentWindowPolicy.relative(r, to: winFrame)
                    return ["x": AgentWindowPolicy.int(rel.origin.x), "y": AgentWindowPolicy.int(rel.origin.y),
                            "w": AgentWindowPolicy.int(rel.width), "h": AgentWindowPolicy.int(rel.height)]
                }
                /*
                 * ★ `others`(卡 QT,2026-10-03):**按得下去、可角色不在白名单里**的那些。
                 *
                 * 这一格是这张卡的命门。10-03 量到豆包办公那颗通向额度页的键是 `AXPopUpButton`
                 * (「Ben 标准套餐」,身上有 `AXPress`),而 `optionHits` 的角色白名单里没有这一档 ——
                 * 于是壳回「它这几扇窗上认不出这颗键」,**而那是一句假话**。没有这一格,
                 * 「它没有这颗键」与「我们的白名单认不出这颗键」在结果里长得一模一样。
                 */
                if !pressableRoles.contains(role), others.count < 60 {
                    var actions: CFArray?
                    AXUIElementCopyActionNames(element, &actions)
                    let names = (actions as? [String]) ?? []
                    let labels = labelsOf()
                    if names.contains(kAXPressAction as String), !labels.isEmpty {
                        var row: [String: Any] = ["window": at, "role": role,
                                                  "labels": labels.map { AgentWindowPolicy.clip($0, 60) },
                                                  "actions": names]
                        row.merge(frameOf()) { a, _ in a }
                        others.append(row)
                    }
                }
                if pressableRoles.contains(role) {
                    let labels = labelsOf()
                    var actions: CFArray?
                    AXUIElementCopyActionNames(element, &actions)
                    let names = (actions as? [String]) ?? []
                    if !labels.isEmpty {
                        // 位置一起回(窗口相对,2026-10-03 卡 QT):额度那一页的入口在侧栏最底下
                        // 还是在正文里,光看名字分不开 —— 而「侧栏底下那一行」正是三家都藏着入口的地方。
                        var row: [String: Any] = ["window": at, "role": role,
                                                  "labels": labels.map { AgentWindowPolicy.clip($0, 60) },
                                                  "press": names.contains(kAXPressAction as String)]
                        row.merge(frameOf()) { a, _ in a }
                        rows.append(row)
                        // 认出一颗键就不再往它底下走(同 `optionHits`)—— 但 `--at` 要的是**整条链**,
                        // 那一下得一直走到叶子,所以只有不带 `--at` 时才在这儿收住。
                        if point == nil { continue }
                    }
                }
                if depth >= 60 { continue }
                for child in children { stack.append((child, depth + 1)) }
            }
        }
        var result: [String: Any] = ["windows": windows.count, "app_unhidden": wasHidden,
                                     "keys": rows, "others": others, "visited": visitedAll,
                                     "hidden_now": app.isHidden, "active_now": app.isActive]
        if point != nil { result["at"] = ["x": AgentWindowPolicy.int(point!.x), "y": AgentWindowPolicy.int(point!.y), "chain": atRows] }
        return ["ok": true, "result": result]
    }

    // MARK: - probe windows

    /// 这个 App 的窗口在 AX 里长什么样 —— **几条路各问一遍**(卡 MQ2,2026-09-26)。
    ///
    /// 为什么要问好几条:卡 MQ 把「壳读不到 Muse 的设置页」归到「别的桌面上的窗 AX 看不见」,
    /// 但 16:05 那一次实测把这条解释推翻了 —— 系统窗口清单里 `Settings` 就在**当前桌面**上、
    /// 尺寸位置与聊天窗一模一样,`AXWindows` 里却只有聊天窗一扇。于是要分清到底是哪一种:
    ///
    /// - `windows` —— `AXWindows`(壳现在唯一走的那条路);
    /// - `main_window` / `focused_window` —— 系统说它是主窗,那 `AXMainWindow` 指的是谁?
    ///   **`in_windows` 是要点**:回 `-1` 就是「这条路拿到的窗不在 `AXWindows` 里」,壳补这条路就能读到它;
    /// - `app_children` —— 应用元素的 `AXChildren`(有的 App 把窗挂在这儿,不进 `AXWindows`);
    /// - `after_knock` —— 敲一次门(`AXManualAccessibility`)+ 等一拍再取,清单会不会多出来;
    /// - `after_enhanced` —— 同上,但写的是 `AXEnhancedUserInterface`。**要 `--enhanced` 才试**:
    ///   这条属性已知会让某些 App 偷偷改自己的窗口尺寸 / 布局(壳因此一直不写它),
    ///   在维护者正开着的窗口上试是有代价的,试完这里**立刻写回 false**;
    /// - 每扇窗的 `subwindows` —— 挂在它底下的 sheet / popover / 子窗(设置页会不会是聊天窗的一张 sheet);
    /// - `cg` + `hit_test` —— 系统窗口清单(只有 id / 位置大小 / 在不在当前桌面,**不读标题**),
    ///   并拿每扇的中心点做一次 `AXUIElementCopyElementAtPosition`:点位测到的那扇窗在不在 `AXWindows` 里,
    ///   是「AX 压根不认它」和「AX 认得、只是没进那张清单」的分水岭。
    ///
    /// **窗口标题一个字都不往外带**(聊天窗的标题多半就是他那条对话的名字):只回标题几个字、
    /// 以及它是不是「设置 / 登录 / 欢迎」这三类里的一类(一张写死的小表)。属性名单(`attrs`)是
    /// AX 的固定词表,不含内容。
    private static func windowsProbe(_ bundleId: String, enhanced: Bool, front: Bool) -> [String: Any] {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": "\(bundleId) 没在运行"]
        }
        let pid = app.processIdentifier
        let appEl = AXUIElementCreateApplication(pid)
        let fronted: [String: Any] = front ? frontUp(app) : ["asked": false]

        func axAttrNames(_ el: AXUIElement) -> [String] {
            var names: CFArray?
            guard AXUIElementCopyAttributeNames(el, &names) == .success else { return [] }
            return (names as? [String]) ?? []
        }
        func elements(_ el: AXUIElement, _ name: String) -> [AXUIElement] {
            (axAttr(el, name) as? [AXUIElement]) ?? []
        }
        func kindOf(_ title: String) -> String {
            let low = title.lowercased()
            if low.contains("setting") || low.contains("preference") || title.contains("设置") || title.contains("偏好") { return "settings" }
            if low.contains("log in") || low.contains("login") || low.contains("sign in") || title.contains("登录") { return "login" }
            if low.contains("welcome") || title.contains("欢迎") { return "welcome" }
            return "other"
        }
        func i(_ v: CGFloat) -> Int { v.isFinite ? Int(v.rounded()) : 0 }
        func geometry(_ el: AXUIElement) -> [String: Any] {
            var row: [String: Any] = [:]
            if let value = axAttr(el, kAXPositionAttribute as String) {
                var pos = CGPoint.zero
                if AXValueGetValue(value as! AXValue, .cgPoint, &pos) { row["x"] = i(pos.x); row["y"] = i(pos.y) }
            }
            if let value = axAttr(el, kAXSizeAttribute as String) {
                var size = CGSize.zero
                if AXValueGetValue(value as! AXValue, .cgSize, &size) { row["w"] = i(size.width); row["h"] = i(size.height) }
            }
            return row
        }
        /// 一扇窗(或任何元素)的画像。标题只回字数与类别。
        func describe(_ el: AXUIElement) -> [String: Any] {
            let title = axAttr(el, kAXTitleAttribute as String) as? String ?? ""
            var row: [String: Any] = [
                "role": axAttr(el, kAXRoleAttribute as String) as? String ?? "",
                "subrole": axAttr(el, kAXSubroleAttribute as String) as? String ?? "",
                "title_kind": kindOf(title),
                "title_chars": title.count,
                "main": (axAttr(el, kAXMainAttribute as String) as? Bool) ?? false,
                "minimized": (axAttr(el, kAXMinimizedAttribute as String) as? Bool) ?? false,
            ]
            row.merge(geometry(el)) { a, _ in a }
            if let id = axCgId(el) { row["cg_id"] = id }
            return row
        }
        /// 这个元素是 `AXWindows` 里的第几扇(AX 元素比得了相等:同一扇窗两次取回来 `CFEqual` 为真)。
        /// 回 `-1` = 不在那张清单里 —— 这一格就是这次要查的东西。
        func indexIn(_ list: [AXUIElement], _ el: AXUIElement) -> Int {
            list.firstIndex { CFEqual($0, el) } ?? -1
        }
        func wait(ms: Int) { RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000.0)) }

        // 第一眼:先不敲门,看它本来的样子(敲门这一下是不是有用,后面那格才说得清)。
        var winRef: CFTypeRef?
        let winErr = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winRef)
        guard winErr == .success, let wins = winRef as? [AXUIElement] else {
            return ["ok": false, "error": "读不到窗口列表(AXError \(winErr.rawValue))"]
        }

        var rows: [[String: Any]] = []
        for (at, win) in wins.enumerated() {
            var row = describe(win)
            row["index"] = at
            row["attrs"] = axAttrNames(win)
            // 挂在这扇窗底下的窗一类的东西:存储面板那种 sheet、popover、子窗。
            // 设置页会不会其实是聊天窗的一张 sheet —— 这一格回答它。
            var subs: [[String: Any]] = []
            for name in [kAXChildrenAttribute as String, "AXSheets", "AXChildWindows"] {
                for kid in elements(win, name) {
                    let role = axAttr(kid, kAXRoleAttribute as String) as? String ?? ""
                    guard ["AXWindow", "AXSheet", "AXPopover", "AXDrawer", "AXDialog"].contains(role) else { continue }
                    var sub = describe(kid)
                    sub["via"] = name
                    sub["in_windows"] = indexIn(wins, kid)
                    subs.append(sub)
                }
            }
            row["subwindows"] = subs
            rows.append(row)
        }

        var result: [String: Any] = [
            "ok": true, "bundle_id": bundleId, "fronted": fronted,
            "app_attrs": axAttrNames(appEl),
            "windows": rows,
            "standard": rows.filter { ($0["subrole"] as? String) == (kAXStandardWindowSubrole as String) }.count,
        ]

        // 主窗 / 焦点窗:系统窗口清单说设置窗是主窗,那这两条路指的是谁?
        for (key, name) in [("main_window", kAXMainWindowAttribute as String),
                            ("focused_window", kAXFocusedWindowAttribute as String)] {
            guard let ref = axAttr(appEl, name), CFGetTypeID(ref) == AXUIElementGetTypeID() else {
                result[key] = ["present": false]; continue
            }
            let el = ref as! AXUIElement
            var row = describe(el)
            row["present"] = true
            row["in_windows"] = indexIn(wins, el)
            result[key] = row
        }

        // 应用元素的 children:有的 App 把窗挂在这儿而不进 AXWindows。
        var kids: [[String: Any]] = []
        for kid in elements(appEl, kAXChildrenAttribute as String) {
            var row = describe(kid)
            row["in_windows"] = indexIn(wins, kid)
            kids.append(row)
        }
        result["app_children"] = kids

        // 敲门 + 等一拍再取:清单会不会多出来(Chromium 系要这一下才建树;原生应用无害)。
        AXWake.knock(appEl)
        wait(ms: 900)
        let afterKnock = elements(appEl, kAXWindowsAttribute as String)
        result["after_knock"] = ["count": afterKnock.count, "waited_ms": 900,
                                "windows": afterKnock.map { describe($0) }]

        if enhanced {
            // **只有 `--enhanced` 才走这一段**,而且试完立刻写回 false:这条属性会让某些 App
            // 偷偷改自己的窗口尺寸 / 布局,不能留在维护者正用着的 App 上。
            AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            wait(ms: 900)
            let afterEnhanced = elements(appEl, kAXWindowsAttribute as String)
            result["after_enhanced"] = ["count": afterEnhanced.count, "waited_ms": 900,
                                       "windows": afterEnhanced.map { describe($0) }]
            AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }

        // 系统那份窗口清单 + 照着每扇的中心点做一次点位测。**不读标题**:只要 id / 位置大小 /
        // 在不在当前桌面。点位测到的窗在不在 AXWindows 里,分得开「AX 压根不认它」与「只是没进清单」。
        let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        let onScreenIds = Set(onScreen.compactMap { $0[kCGWindowNumber as String] as? Int })
        var cg: [[String: Any]] = []
        for info in (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? [] {
            guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid else { continue }
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double,
                  let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double else { continue }
            if w < 200 || h < 200 { continue }
            let id = info[kCGWindowNumber as String] as? Int ?? -1
            var row: [String: Any] = ["id": id, "x": Int(x), "y": Int(y), "w": Int(w), "h": Int(h),
                                      "on_space": onScreenIds.contains(id)]
            // 点位测:CG 的坐标系与 AX 一样(左上角原点、全局),中心点直接拿来问。
            var hitRef: AXUIElement?
            if AXUIElementCopyElementAtPosition(appEl, Float(x + w / 2), Float(y + h / 2), &hitRef) == .success,
               let hit = hitRef {
                var top: [String: Any] = ["role": axAttr(hit, kAXRoleAttribute as String) as? String ?? ""]
                // 从命中的那个元素往上走到它所属的窗。
                for name in [kAXWindowAttribute as String, kAXTopLevelUIElementAttribute as String] {
                    guard let ref = axAttr(hit, name), CFGetTypeID(ref) == AXUIElementGetTypeID() else { continue }
                    let win = ref as! AXUIElement
                    var w = describe(win)
                    w["in_windows"] = indexIn(wins, win)
                    top[name] = w
                }
                row["hit_test"] = top
            }
            cg.append(row)
        }
        result["cg"] = cg
        return result
    }

    /// **同一个进程里**把「AX 列了哪几扇窗」和「系统说这几扇在不在当前桌面上」对照着采几次
    /// (卡 MQ2,2026-09-26)。中途可以换一次台前的 App(`--switch-to`),看那一下之后两边怎么变。
    ///
    /// 这是这张卡的取证工具:卡 MQ 的两张表是分两次跑量的 —— 而探针每跑一次自己就是一个新的
    /// GUI 进程,那一下会换台前、当前桌面也可能跟着变,于是「系统说它在这个桌面上」与
    /// 「AX 里没有它」看着像同一刻的矛盾,其实是两刻的两件事。同一个进程里采,才对得上。
    ///
    /// 每一次采样只回:几毫秒、台前是谁(bundle id)、AX 列出来的窗(cg id + 标题几个字 + 哪一类)、
    /// 系统清单里这个 App 的窗(cg id + 在不在当前桌面)。**标题一个字不带。**
    /// 卡 MQ3(2026-09-26):**读那一两秒里,放出来的窗会不会被他看见。**
    ///
    /// 壳读藏着的那一家之前会先 `unhide()`(不 activate),读完藏回去 —— 交接里那句
    /// 「工作台整屏在最前时,放出来的窗排在它后面,看不见闪动」得真机核实,这就是核它的工具。
    ///
    /// 一个后台线程每 `everyMs` 采一次系统的**在屏**窗口清单(这份清单是**从前到后**排的),只记三格:
    /// 最前那扇普通窗是谁的(工作台 / 目标 / 别人)、目标这会儿在屏上几扇、目标最前那扇排在工作台
    /// 最前那扇的**前面还是后面**。
    ///
    /// **一个窗口标题都不读、一张截图都不拍**:标题多半就是他那条对话的名字,截屏会把他屏幕上的
    /// 私事整张录下来 —— 而「有没有闪到他眼前」这件事,窗口次序就证得了。
    private static func startUnhideWatch(_ bundleId: String, everyMs: Int, forMs: Int) -> () -> [[String: Any]] {
        let lock = NSLock()
        var rows: [[String: Any]] = []
        let started = CFAbsoluteTimeGetCurrent()
        let targetPids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).map { $0.processIdentifier })
        // 装在 /Applications 的那份真壳(同一个 bundle id,但不是探针自己这个进程)。
        let shellPids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "ai.ben.workbench")
            .map { $0.processIdentifier }
            .filter { $0 != ProcessInfo.processInfo.processIdentifier })
        DispatchQueue.global().async {
            while (CFAbsoluteTimeGetCurrent() - started) * 1000 < Double(forMs) {
                let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
                var targetAt: Int?, shellAt: Int?, frontOwner = "other", targetOnScreen = 0, rank = 0
                for info in onScreen {
                    guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                          let bounds = info[kCGWindowBounds as String] as? [String: Any],
                          let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double,
                          w >= 200, h >= 200 else { continue }
                    if rank == 0 { frontOwner = targetPids.contains(pid) ? "target" : (shellPids.contains(pid) ? "workbench" : "other") }
                    if targetPids.contains(pid) {
                        targetOnScreen += 1
                        if targetAt == nil { targetAt = rank }
                    }
                    if shellPids.contains(pid), shellAt == nil { shellAt = rank }
                    rank += 1
                }
                var row: [String: Any] = ["at_ms": Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded()),
                                          "front_owner": frontOwner, "target_on_screen": targetOnScreen]
                if let targetAt, let shellAt { row["target_above_workbench"] = targetAt < shellAt }
                lock.lock(); rows.append(row); lock.unlock()
                usleep(UInt32(everyMs) * 1000)
            }
        }
        return { lock.lock(); let out = rows; lock.unlock(); return out }
    }

    /**
     **这几秒里那一家在屏幕上多出过什么窗**(卡「豆包台前点一下」,2026-10-04;`quota-page --watch-menu`)。

     为什么要它:合成点击按下去之后 `menu_roots` 回 0 —— 可那一个 0 分不出两件事:
     **① 那张原生菜单压根没弹开**,还是 **② 弹开了但辅助功能树上看不见它**。
     分开这两件靠 `CGWindowListCopyWindowInfo`:macOS 的弹出菜单是一扇**真窗**(layer > 0 的
     小窗,owner 还是那个 App),与辅助功能完全两条路。弹开了这里就看得见一行,没弹开就一行都没有。

     跑在后台队列上(主线程那会儿正被 `quotaPage` 的等待占着);只收**尺寸与层**,一个字的内容都不读
     (窗名要屏幕录制授权,而且那是她的内容)。
     */
    private static func startMenuWatch(_ bundleId: String, everyMs: Int, forMs: Int) -> () -> [String: Any] {
        let lock = NSLock()
        var rows: [[String: Any]] = []
        var seen = Set<String>()
        let started = CFAbsoluteTimeGetCurrent()
        let targetPids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).map { $0.processIdentifier })
        DispatchQueue.global().async {
            while (CFAbsoluteTimeGetCurrent() - started) * 1000 < Double(forMs) {
                let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
                for info in onScreen {
                    guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, targetPids.contains(pid),
                          let layer = info[kCGWindowLayer as String] as? Int,
                          let bounds = info[kCGWindowBounds as String] as? [String: Any],
                          let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double else { continue }
                    // 一样的窗(层 + 尺寸)只记第一次看见它的那一刻,不然五秒钟刷几十行一个样的。
                    let key = "\(layer)x\(Int(w))x\(Int(h))"
                    lock.lock()
                    defer { lock.unlock() }
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    rows.append(["at_ms": Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded()),
                                 "layer": layer, "w": Int(w), "h": Int(h)])
                }
                usleep(UInt32(everyMs) * 1000)
            }
        }
        return { lock.lock(); let out: [String: Any] = ["windows_seen": rows]; lock.unlock(); return out }
    }

    private static func spaceWatch(_ bundleId: String, switchTo: String?, samples: Int) -> [String: Any] {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": "\(bundleId) 没在运行"]
        }
        let pid = app.processIdentifier
        let appEl = AXWake.app(pid)
        let started = CFAbsoluteTimeGetCurrent()
        func kindOf(_ title: String) -> String {
            let low = title.lowercased()
            if low.contains("setting") || low.contains("preference") || title.contains("设置") || title.contains("偏好") { return "settings" }
            if low.contains("log in") || low.contains("login") || low.contains("sign in") || title.contains("登录") { return "login" }
            if low.contains("welcome") || title.contains("欢迎") { return "welcome" }
            return "other"
        }
        func sample(_ note: String) -> [String: Any] {
            var ax: [[String: Any]] = []
            for win in (axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
                let title = axAttr(win, kAXTitleAttribute as String) as? String ?? ""
                var row: [String: Any] = ["subrole": axAttr(win, kAXSubroleAttribute as String) as? String ?? "",
                                          "title_kind": kindOf(title), "title_chars": title.count,
                                          "main": (axAttr(win, kAXMainAttribute as String) as? Bool) ?? false]
                if let id = axCgId(win) { row["cg_id"] = id }
                ax.append(row)
            }
            let cg = cgWindows(pid: pid).map { ["id": $0.id, "on_space": $0.onSpace, "w": $0.w, "h": $0.h] as [String: Any] }
            return ["at_ms": Int(((CFAbsoluteTimeGetCurrent() - started) * 1000).rounded()),
                    "note": note,
                    "front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
                    "ax": ax, "cg": cg]
        }
        func wait(ms: Int) { RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000.0)) }

        var rows: [[String: Any]] = [sample("刚起来(台前多半还是探针自己)")]
        let fronted = frontUp(app)
        wait(ms: 700)
        rows.append(sample("把目标切到台前之后"))
        wait(ms: 900)
        rows.append(sample("再过一拍"))
        var switched: [String: Any] = ["asked": switchTo ?? ""]
        if let switchTo, let other = NSRunningApplication.runningApplications(withBundleIdentifier: switchTo).first {
            switched = frontUp(other)
            for i in 1...samples {
                wait(ms: 700)
                rows.append(sample("切到 \(switchTo) 之后第 \(i) 次"))
            }
        }
        return ["ok": true, "bundle_id": bundleId, "fronted": fronted, "switched": switched, "samples": rows]
    }

    /// 不给正则时用的那一组:**宽松,但只认额度那几小段**(`read-texts` 与 `quota-link` 共用一份)。
    private static let defaultQuotaPatterns: [[String: Any]] = [
        ["id": "pct", "regex": "[0-9]{1,3}\\s*%\\s*[A-Za-z\\u4e00-\\u9fff]{0,12}"],
        ["id": "used", "regex": "(?i)used|已使用|使用了|已用完"],
        ["id": "usage", "regex": "(?i)usage|使用情况|使用量"],
        ["id": "reset", "regex": "(?i)resets? on[^\\n]{0,24}|重置|刷新"],
        ["id": "plan", "regex": "(?i)(?:free|pro|premium)\\s+plan|unlimited|无限制|套餐"],
    ]

    /// 命令行上的 `id=regex` 那几条(`--` 开头的旗标不算)。
    private static func patternArgs(_ args: [String]) -> [[String: Any]] {
        var raw: [[String: Any]] = []
        for spec in args.dropFirst(2) where !spec.hasPrefix("--") && spec.contains("=") {
            let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
            raw.append(["id": parts[0], "regex": parts[1]])
        }
        return raw
    }

    /// 把这家切到台前(**只 activate,不点它任何东西**),回「原来台前是谁 / 试了几次 / 现在是谁」。
    ///
    /// 为什么要有这一下:辅助功能**只列得出当前桌面(Space)上的窗**(2026-09-26 实测,见交接)。
    /// 探针自己每跑一次都是 `open -n -a` 拉起一个新进程,那一下会把当前桌面切回探针这边 ——
    /// 于是「刚开的设置窗」在下一次探针里又成了别的桌面上的窗。要在设置窗那一侧量东西,
    /// 就得先把目标切回台前。
    ///
    /// **要重试**:LaunchServices 激活探针自己那一下比这里的 `activate` 还晚到,
    /// 一次就成的话台前反而是探针自己(实测 `now_front = ai.ben.workbench`)。最多五次。
    private static func frontUp(_ app: NSRunningApplication) -> [String: Any] {
        var info: [String: Any] = ["asked": true]
        info["previous_front"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        var tries = 0
        while tries < 5 {
            tries += 1
            app.activate(options: [.activateAllWindows])
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == app.bundleIdentifier { break }
        }
        info["tries"] = tries
        info["now_front"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        return info
    }

    /// 从这家自己的菜单里按一下「设置…」,再照一遍窗口清单(卡 MQ2,2026-09-26)。
    ///
    /// 菜单项的亮 / 灰跟着「谁在台前」变(`TextInsert.openNewConversation` 上面那段注释记过),
    /// 所以先把它切到台前、确认台前真是它,再找那一项。**只按菜单里那一项**,窗口里什么都不点。
    private static func settingsProbe(_ bundleId: String, patterns: [SendTextPolicy.TextPattern]?,
                                      front: Bool = true) -> [String: Any] {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            return ["ok": false, "error": "\(bundleId) 没在运行"]
        }
        let appEl = AXWake.app(app.processIdentifier)
        func wait(ms: Int) { RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000.0)) }
        func kids(_ el: AXUIElement) -> [AXUIElement] {
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref) == .success else { return [] }
            return (ref as? [AXUIElement]) ?? []
        }
        func title(_ el: AXUIElement) -> String? {
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &ref) == .success else { return nil }
            return ref as? String
        }
        func enabled(_ el: AXUIElement) -> Bool? {
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &ref) == .success,
                  let ref, CFGetTypeID(ref) == CFBooleanGetTypeID() else { return nil }
            return CFBooleanGetValue((ref as! CFBoolean))
        }
        /// 「设置 / 偏好设置」那一项(带不带省略号都算)。
        func looksLikeSettings(_ text: String) -> Bool {
            let low = text.lowercased()
            return low.hasPrefix("settings") || low.hasPrefix("preferences")
                || text.hasPrefix("设置") || text.hasPrefix("偏好设置")
        }

        // `--no-front`:一下都不叫台前(卡 QT 要量的就是这一种)。藏着的那家先放出来
        // (**不 activate**)—— 没有窗的时候菜单栏自己也常常不在树上;量完照原样藏回去。
        let wasHidden = app.isHidden
        if !front, wasHidden { app.unhide(); wait(ms: SendTextPolicy.unhideWaitMs) }
        defer {
            if !front, SendTextPolicy.shouldRehide(wasHidden: wasHidden, isActive: app.isActive) { app.hide() }
        }
        let fronted: [String: Any] = front ? frontUp(app) : ["asked": false, "app_unhidden": wasHidden]
        var barRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXMenuBarAttribute as CFString, &barRef) == .success,
              let bar = barRef, CFGetTypeID(bar) == AXUIElementGetTypeID() else {
            return ["ok": false, "error": "读不到它的菜单栏", "front_asked": front]
        }
        var pressed: String?
        var greyed: String?
        // 量到的每一项都记下来(`--no-front` 下「它在树上、但是灰的」与「压根不在树上」是两件事,
        // 回包里分开说 —— 混成一句就等于把没查清的当查清了)。
        var seen: [[String: Any]] = []
        var axErr: Int?
        outer: for top in kids(bar as! AXUIElement) {
            for menu in kids(top) {
                for item in kids(menu) {
                    guard let text = title(item), looksLikeSettings(text) else { continue }
                    let on = enabled(item)
                    seen.append(["label": AgentWindowPolicy.clip(text, 40), "enabled": on ?? NSNull()])
                    if on == false { greyed = text; continue }
                    let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
                    if err == .success { pressed = text; break outer }
                    axErr = Int(err.rawValue)
                }
            }
        }
        // 开窗要一拍(新窗要建、AX 那边也要登记)。
        wait(ms: 1500)
        var result = windowsProbe(bundleId, enhanced: false, front: false)
        var menu: [String: Any] = ["pressed": pressed ?? "", "greyed": greyed ?? "", "fronted": fronted,
                                   "front_asked": front, "items": seen,
                                   "front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""]
        if let axErr { menu["ax_err"] = axErr }
        result["settings_menu"] = menu
        // 给了正则就**紧接着读一遍**:设置窗开着、又在当前桌面上的这一刻,只有这个进程照得到。
        if let patterns {
            result["read_texts"] = TextInsert.readTexts(bundleId: bundleId, index: nil, patterns: patterns)
        }
        return result
    }

    /// 结果既打到标准输出,也可以写进 `--out <文件>`。
    ///
    /// **为什么需要 `--out`**:辅助功能授权是按"负责进程"算的 —— 从终端里直接跑这个二进制,
    /// 系统把授权算在终端头上(实测 `AXIsProcessTrusted()` = false,哪怕 designated requirement
    /// 与 /Applications/工作台.app 一字不差)。只有用 `open -n -a <这个包>` 由 LaunchServices
    /// 拉起,它才是自己的负责进程、才认得那条授权;而那样一来标准输出就没人接了,只能落文件。
    private static func out(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            print("{\"ok\":false,\"error\":\"结果序列化不出来\"}")
            return
        }
        print(text)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--out"), i + 1 < args.count {
            try? text.write(toFile: args[i + 1], atomically: true, encoding: .utf8)
        }
    }
}

Probe.main()
