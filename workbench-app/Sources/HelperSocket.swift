import Foundation

/// 与工作台本地服务(8791)的 /helper 长连。收 req、在主线程执行 AX 原语、回 res。
/// 断线 3 秒后重连(连接管理,不是数据轮询——数据只在服务端主动发 req 时流动)。
final class HelperSocket: NSObject {
    private let url: URL
    private let control: WindowControl
    /// 光圈(2026-09-10):纯绘制,不碰 AX,所以不放进 WindowControl——那边是 AX 原语的家。
    private let highlight: HighlightOverlay
    private let screenInfo: () -> [String: Any]
    private var task: URLSessionWebSocketTask?
    private var authorized: Bool
    /// 动别人窗口的那几个 op 的执行队列(2026-09-21「点标签切换经常卡住」)。
    ///
    /// **为什么非要挪出主线程**:这几个 op 里的 AX 调用是同步等目标应用回话的(见
    /// `WindowControl.armed` 那段)。以前它们全在主线程上跑,一个睡死的 Electron 应用
    /// 就能把壳的整条主线程按住好几秒 —— 期间 `screen_info`、`hover_zone`、`window_mode`、
    /// 壳自己那扇窗的绘制、AXObserver 回调**统统排在后面**,于是"切一个应用"看起来像
    /// "整个工作台卡死了"。真机上 Ben 看到的就是这个。
    ///
    /// **串行而不是并发**:AX 那一侧的正确性依赖顺序(unhide → 唤窗 → 摆位 → 置前 是一条
    /// 有先后的链),并发跑会让同一扇窗的摆位和置前抢跑;而且并发也解决不了"目标应用自己慢"
    /// 这件事 —— 真正的止血是上面那道 1 秒时限 + 队列里躺太久就放弃。
    ///
    /// **怎么分**:
    /// - 进这条队列的(`axQueueOps`):`app_info` / `set_window_frame` / `raise_window` /
    ///   `hide_app` / `unhide_app`。它们只碰 AX 与 `NSRunningApplication`(苹果文档明说
    ///   NSRunningApplication 是线程安全的),不碰 `watches`/`axDead`/`hoverZone` 这些
    ///   WindowControl 的可变状态,也不碰任何 NSWindow —— 这是它们能挪的**前提**,加新 op
    ///   进这张表之前必须逐条对一遍。
    /// - 留在主线程的:`observe`(装/拆 AXObserver,run loop source 挂在主 run loop 上)、
    ///   `hover_zone`(全局 NSEvent 监听)、`highlight_region`(画自己的 NSWindow)、
    ///   `window_mode`(改自己那扇窗的层级)、`screen_info`(读 NSScreen)、
    ///   `send_text`/`focus_input`(NSPasteboard + CGEvent + 激活,另有一张卡管)、
    ///   `ax_probe`(要读 WindowControl 的计数器与 watches)。
    private let axQueue = DispatchQueue(label: "ai.ben.workbench.helper.ax", qos: .userInitiated)
    /// 见 axQueue 的「怎么分」。改这张表 = 改线程边界,不是加一行配置。
    private static let axQueueOps: Set<String> = [
        "app_info", "set_window_frame", "raise_window", "hide_app", "unhide_app",
    ]
    /// 读回复(2026-09-24,卡 F)单走一条自己的串行队列:它是一次几百到几千个节点的只读遍历,
    /// 派出去的活没回来之前每几秒一次。放主线程会让壳的界面一顿一顿,放 axQueue 会让
    /// 点标签切窗口排在它后面(SwitchBudget 那道"排太久就放弃"会把切换判成失败)。
    /// 它只碰 AX 与 NSRunningApplication(同 axQueueOps 那条前提),不碰 WindowControl 的任何状态。
    ///
    /// ★ 2026-10-21(卡「派活按家隔离」):**按包各排各的队**(`ReadLanes`)。从前这里是一条队:一家读不动,
    /// 后面排着的所有别家的读都跟着等,插件那一头一个个超时 —— 一家卡住、所有别家的派活卡都没人盯。
    /// 现在读某一家窗口的那几样一个包一条串行队(同一扇窗不并发读),不看包的共用一条;
    /// 排过头的不读、`cancel_reads` 撤掉某几个包还没开始的读(见 ReadLanes)。
    private let readLanes = ReadLanes()
    private var readQueues: [String: DispatchQueue] = [:]
    private let readQueuesLock = NSLock()
    private func readQueue(for key: String) -> DispatchQueue {
        readQueuesLock.lock(); defer { readQueuesLock.unlock() }
        if let queue = readQueues[key] { return queue }
        let queue = DispatchQueue(label: "ai.ben.workbench.helper.read.\(key)", qos: .utility)
        readQueues[key] = queue
        return queue
    }
    /// 卡 Q(2026-09-25,Agent 自动发现):`running_apps` / `agent_probe` / `agent_read` 也走这条 ——
    /// 同样是只读遍历,同样只碰 AX 与 NSRunningApplication,不碰 WindowControl 的任何状态。
    /// 卡 LG(2026-09-26,各家 logo):`app_icon` 也走这条 —— 渲一张 128×128 的 PNG 是几毫秒的活,
    /// 跟 icon_colors 一样只碰 NSWorkspace,没道理排在主线程上让界面顿一下。
    /// 卡 WR(2026-09-28):`agent_pick` / `agent_stop` **两条都不在这里、也不在 axQueueOps 里** ——
    /// 它们会点一下、会把那家叫到台前(CGEvent + activate),和 `send_text` 同一类,留在主线程。
    /// 卡 WQ(2026-09-28):`agent_press` 同理(它也点一下、也叫台前)。卡 AP(2026-10-01):`agent_approval` 同理。
    private static let readQueueOps: Set<String> = ["read_reply", "running_apps", "agent_probe", "agent_read",
                                                    "agent_ax_detail", "agent_images", "icon_colors", "app_icon"]
    /// 服务端 hello 里的插件版本号(2026-09-14,插件换版自动重载):每次连上服务端都会先收到
    /// `{kind:"hello", role:"server", version}`,原样交给 AppDelegate 判断要不要重载页面——
    /// 这里不比较、不记忆,壳的 socket 只管收发。主线程回调。
    var onServerHello: ((String) -> Void)?
    /// 网页(经服务端转发)要求切「前台 / 桌面」两档窗口模式(2026-09-18)。同 onServerHello:
    /// 这里只解析字段,不判断该不该切——那是 AppDelegate 的事。主线程回调。
    var onWindowMode: ((ShellWindowMode) -> Void)?
    /// 设置里那颗「工作台开着时电脑不睡」被点了(2026-09-28,卡 AW):服务端发
    /// `system_awake {enabled}`,AppDelegate 当场改断言,回此刻真按着没有。
    /// app.json 的落盘在插件那边,壳这里只管让它立刻生效。主线程回调。
    var onSystemAwake: ((Bool) -> Bool)?
    /// 「出门时电脑不睡」此刻成不成立(2026-10-03,卡「出门时电脑不睡」):服务端发
    /// `away_awake {active}`(它算好了「开关开着 + 有已配对手机经中转连着」这两件事),
    /// AppDelegate 当场改断言,回此刻真按着没有。壳不做任何判断。主线程回调。
    var onAwayAwake: ((Bool) -> Bool)?
    /// 此刻窗口槽里都有谁(2026-10-04,卡「常亮认窗口槽里的程序」):插件发
    /// `slot_apps {bundle_ids}`(源头是 dock.json 那一叠),AppDelegate 存下来、当场重算
    /// 「别让屏幕暗下去」,回此刻真按着没有。壳不做任何判断、也不另造一张成员表。主线程回调。
    var onSlotApps: (([String]) -> Bool)?
    /// 他点了「去授权」(2026-09-23):服务端发 `request_accessibility`,AppDelegate 这时才
    /// 调带 prompt 的 AXIsProcessTrustedWithOptions。回此刻是否已授权。主线程回调。
    var onRequestAccessibility: (() -> Bool)?
    /// 服务端预约「这一家的截图遮罩一收就藏回去」(`arm_rehide`,2026-09-25 卡 P 补):交给 ActivationWatch,
    /// 回它收没收(它此刻没开着遮罩就不收)。主线程回调。
    var onArmRehide: ((String) -> Bool)?
    /// 服务端要露出某一家(`unhide_app` / `raise_window`:点标签切过去、摆回窗位):那一家的预约作废。主线程回调。
    var onAppShown: ((String) -> Void)?
    /// 系统通知(2026-09-25,卡 M):服务端发 `notify {key, title, body, clear?}`,AppDelegate 交给 ShellNotifier。
    /// 回给服务端的那一格(`shown` / `reason`)。主线程回调。
    var onNotify: ((_ key: String, _ title: String, _ body: String, _ clear: Bool) -> [String: Any])?

    init(url: URL, control: WindowControl, highlight: HighlightOverlay, authorized: Bool, screenInfo: @escaping () -> [String: Any]) {
        self.url = url
        self.control = control
        self.highlight = highlight
        self.authorized = authorized
        self.screenInfo = screenInfo
    }

    func start() { connect() }

    func updateAuthorized(_ value: Bool) {
        let wasAuthorized = authorized
        authorized = value
        send(["kind": "authorized", "authorized": value])
        // S1(review,真机实测:Codex/Claude/企微/微信——壳启动前就已经在跑的四家——拖不进
        // 窗位):第一次 attachAllRunning()(壳启动时)撞在辅助功能还没授权的窗口,那批
        // 应用当时全部挂载失败。理论上服务端收到 authorized 变化后会重发 observe、
        // WindowControl 再重新扫一遍,但那趟要经过 WS 一来一回(网络抖动/消息顺序/
        // 服务端那一刻还没收到就被覆盖等),真机上没等到——那四家因此一直没被重新观察。
        // 授权状态本地就翻了,没道理还要等服务端喊一声才重挂:这里直接触发一次本地
        // 重挂扫描(attachToCurrentApps 内部对每个还没挂上的应用重新尝试,已经挂上的
        // 跳过),不依赖那趟 round trip。只在真的从"未授权"翻到"已授权"这一刻触发一次
        // (事件驱动,不是每次 applicationDidBecomeActive 调用都扫一遍——大部分调用值
        // 没变,白扫一次没意义)。
        if value && !wasAuthorized {
            control.attachToCurrentApps()
        }
    }

    private func connect() {
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        // caps(2026-09-24,卡 F):这份壳会哪些新本事。插件和壳是分开装的 —— 新插件碰上旧壳时,
        // 旧壳会把 new_conversation 当没看见、直接打进他正开着的那条对话;插件看这一格,旧壳就不送。
        // highlight_label / rehide(2026-09-25 卡 P 补):光圈可以只亮字不亮光;遮罩一收可以按服务端的预约当场藏回去。
        // notify(2026-09-25 卡 M):事务官有话问你 / 要你批时弹系统通知(旧壳不认这个 op,服务端照样不报错)。
        // agent_window(2026-09-25 卡 Q):running_apps / agent_probe / agent_read 三个只读原语 + App 起落的 app 事件;
        // 旧壳没有这一格,服务端的自动发现就停着、说一句「装上新版工作台 App 就好」。
        // icon_color(2026-09-25 卡 Q):icon_colors —— 各家图标的主色(头像、小灯的颜色);旧壳没有就一律中性灰。
        // app_icon(2026-09-26 卡 LG):整张图标渲成一张小 PNG(窗口槽标签、顶栏小灯、「N 家 Agent 客户端」那一条上的小图标);
        // 旧壳没有这一格,插件那一侧 /agents/icon 一律 404、界面退回色点(现有样子),不出错。
        // agent_allow(2026-09-25 卡 Z):服务端报「登记表里接上了的那几家」,壳的送话门据此放行运行时新发现的一家;
        // 旧壳没有这一格,服务端就不报 —— 那时只有壳里实测过的那几家送得进去,新发现的一家如实说要新版工作台 App。
        // save_draft(2026-09-27 卡 DB):框里有他没发出去的字时,壳把那段原文读出来一并回给服务端、
        // 送完原样放回框里。旧壳没有这一格 —— 服务端就不发它,那时照旧「有草稿就不送」(不静默覆盖)。
        send(["kind": "hello", "role": "helper", "authorized": authorized, "version": "1",
              "caps": ["new_conversation", "read_reply", "activation", "highlight_label", "rehide", "notify", "read_texts", "agent_window", "icon_color", "app_icon", "agent_allow", "save_draft", "system_awake",
                       // agent_images(2026-10-13 夜,卡 T):一扇窗里图片类节点的位置与 AXURL(只读)。
                       // 旧壳没有这一格 —— 服务端照旧按文字判据等那几秒,不出错。
                       "agent_images",
                       // away_awake(2026-10-03 卡「出门时电脑不睡」):服务端算好「开关开着 + 手机在外面连着」后下发,
                       // 壳按住那条「屏幕别暗」不看前台。旧壳没有这一格 —— 服务端照旧只落盘,如实说要重开工作台才生效。
                       "away_awake",
                       // slot_apps(2026-10-04 卡「常亮认窗口槽里的程序」):插件下发窗口槽成员表,
                       // 壳据此把「在前台就常亮」认到槽里贴着的那一家头上(她点进 Codex 的窗之后,
                       // 最前面的 App 是 Codex 不是工作台)。旧壳没有这一格 —— 插件就不发,
                       // 行为与 0.4.96 一字不差(照旧只认工作台自己在最前面)。
                       "slot_apps",
                       // 卡 WR(2026-09-28):在侧栏里点那条对话 / 按那家的停止键。旧壳没有这两格 ——
                       // 服务端据此如实说「这台电脑上的工作台 App 还不会切到那条对话」,不假装捎进去了。
                       // 卡 WQ(2026-09-28):替他点它弹的框上那一项。旧壳没有这一格 ——
                       // 服务端据此照旧说「这一问得在电脑上那家里回答」,不假装替他点了。
                       // 卡 AT(2026-09-28):把她自己那句话写进那家提问面板里的自由作答框、按面板自己那颗发送键。
                       // 旧壳没有这一格 —— 服务端照旧说「要自己说一句,得在电脑上…」,不假装写进去了。
                       // 卡 AP(2026-10-01):替她看 / 按那家的批准弹窗。旧壳没有这一格 —— 服务端照旧说「到电脑上点」。
                       // 卡 QP(2026-10-03):在后台把那家翻到额度那一页(只 unhide、不 activate,按只走 AXPress)。
                       // 旧壳没有这一格 —— 插件据此照旧只在她亲手点「读一下」时才按键翻页(那一条会把那家叫到台前),
                       // 自动那一轮一颗键都不按,行为与 0.4.90 一字不差。
                       // 卡「豆包闪一下 / Grok 读键字」(2026-10-03,维护者 21:4x 拍板):
                       // `read_titles` = `read_texts` 收得了一格 `include_titles`(**按家声明**地连
                       // 「键身上的字」也读 —— Grok Bot 的额度写在一颗 `AXMenuItem` 身上);
                       // `quota_front` = `quota_page` 收得了一格 `front`(叫到台前按一下、按完立刻
                       // 把台前与隐藏状态都还原 —— 豆包那张原生菜单非台前不可)。
                       // 老壳没有这两格 —— 插件据此照旧不发那两格,两家的格子停在今天那句话上,不假装读到了。
                       // 卡「豆包台前点一下」(2026-10-04,维护者拍板「可以」):
                       // `quota_click` = `quota_page` 收得了一格 `click`(**台前、第一颗键**那一下
                       // 合成一次鼠标点击 —— 豆包那张原生菜单 AXPress 压根弹不开)。缺省关着;
                       // 后台那一支一行 `clickAt` 都没有(用例按源码钉着)。
                       "read_titles", "quota_front", "quota_click",
                       "agent_pick", "agent_stop", "agent_press", "agent_write_ask", "agent_approval", "quota_page",
                       "paste_image", "press_role", "clear_composer", "clear_frames", "press_below_text",
                       // read_lanes(2026-10-21 卡「派活按家隔离」):读窗按包各排各的队、排过头的不读、
                       // `cancel_reads` 撤掉某几个包还没开始的读。旧壳没有这一格 —— 插件「重置这一家」照样清插件那一侧,
                       // 话里如实说壳那一侧没撤。
                       "read_lanes"]])
        receive()
    }

    private func scheduleReconnect() {
        // receive() 的回调不保证在主线程——task 是被多处读写的可变状态,整体搬到主队列,
        // 不能只把 asyncAfter 里那一半放主线程、外面这行留在别的线程改 task。
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.task = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.connect() }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func send(_ obj: [String: Any]) {
        // 回包序列化不出来(结果里混了 JSON 放不下的值)时**不许默不作声**(2026-09-25,卡 F):
        // 以前这里直接 return,服务端只能等到超时、说一句"壳响应超时",谁也查不出是哪一步。
        // 现在对 req 的回包改回一条只带原因的失败。先问 isValidJSONObject —— 放不下的对象
        // 直接喂给 JSONSerialization 会抛 ObjC 异常,`try?` 接不住,整个壳会崩。
        if JSONSerialization.isValidJSONObject(obj),
           let data = try? JSONSerialization.data(withJSONObject: obj),
           let text = String(data: data, encoding: .utf8) {
            task?.send(.string(text)) { _ in }
            return
        }
        guard obj["kind"] as? String == "res", let id = obj["id"] as? Int else { return }
        let op = (obj["op"] as? String).map { "(\($0))" } ?? ""
        let fallback: [String: Any] = ["kind": "res", "id": id, "ok": false,
                                       "error": "壳的回包序列化不出来\(op):结果里有 JSON 放不下的值"]
        guard let data = try? JSONSerialization.data(withJSONObject: fallback),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if msg["kind"] as? String == "hello", msg["role"] as? String == "server" {
            // 服务端 hello(见 onServerHello):version 缺失/不是字符串就当没收到——旧插件
            // 根本不发这条,新插件一定带;不拿 "0" 之类的猜测值去触发重载。
            guard let version = msg["version"] as? String else { return }
            DispatchQueue.main.async { [weak self] in self?.onServerHello?(version) }
            return
        }
        guard msg["kind"] as? String == "req",
              let id = msg["id"] as? Int,
              let op = msg["op"] as? String else { return }
        /*
         * ★ **每次打开 / 激活 / 叫到台前一个 App 记一行**(2026-10-02,维护者拍板「诊断包加两样」)。
         *
         * 记在这一个口上,不在底下七八处 `app.activate()` 旁边各记一行 —— 所有动别人窗口的活都从
         * 这里进来,路由表里加一个 op 就自动跟着记(判据与「哪几个 op 算、哪几个不算」在 AppOpenLog.swift)。
         * 排在队列分流**之前**:要查的是「这一下是谁要的」,而不是「它排到队了没有」。
         */
        if AppOpenLog.opensApp(op) {
            AppOpenLog.note(bundleId: msg["bundle_id"] as? String ?? "", op: op, why: Self.openWhy(op, msg))
        }
        // 撤掉某几个包还没开始的读(2026-10-21,插件「重置这一家」):只动壳自己的账,一个窗口都不碰,当场回。
        if op == "cancel_reads" {
            let bundles = (msg["bundle_ids"] as? [Any])?.compactMap { $0 as? String } ?? []
            let cancelled = readLanes.cancel(bundles)
            DispatchQueue.main.async { [weak self] in self?.send(["kind": "res", "id": id, "ok": true, "cancelled": cancelled]) }
            return
        }
        if Self.readQueueOps.contains(op) {
            let key = ReadLanes.laneKey(op: op, bundleId: msg["bundle_id"] as? String ?? "")
            let ticket = readLanes.enter(key)
            readQueue(for: key).async { [weak self] in
                guard let self else { return }
                var res: [String: Any]
                switch self.readLanes.verdict(ticket) {
                case .run: res = self.dispatch(op, msg)
                case .cancelled: res = ["ok": false, "error": ReadLanes.cancelledSay]
                case .stale(let waitedMs): res = ["ok": false, "error": ReadLanes.staleSay(waitedMs: waitedMs)]
                }
                res["kind"] = "res"
                res["id"] = id
                DispatchQueue.main.async { [weak self] in self?.send(res) }
            }
            return
        }
        // 服务端要露出这一家:「遮罩一收就藏回去」的预约先作废(不能把他刚切过去的那一家藏掉)。
        if op == "unhide_app" || op == "raise_window", let bundleId = msg["bundle_id"] as? String {
            DispatchQueue.main.async { [weak self] in self?.onAppShown?(bundleId) }
        }
        // 主线程只做**必须在主线程**的那一半(见 axQueueOps 上面那段);其余的进串行队列。
        if Self.axQueueOps.contains(op) {
            let queuedAt = Date()
            axQueue.async { [weak self] in
                guard let self else { return }
                let waitedMs = Int(Date().timeIntervalSince(queuedAt) * 1000)
                var res: [String: Any]
                if SwitchBudget.staleInQueue(queuedForMs: waitedMs) {
                    // 前面有一家在慢,这条已经躺过头了——服务端那次切换八成早回了结果。
                    // 如实回一条失败(调用方的既有 catch 就是「这家这次不动」),不去动窗口。
                    res = ["ok": false, "error": "\(SwitchBudget.staleInQueueMessage)(排队 \(waitedMs)ms)"]
                }
                else {
                    res = self.dispatch(op, msg)
                }
                res["kind"] = "res"
                res["id"] = id
                // send 读写 `task`,那是主线程独占的可变状态(见 scheduleReconnect 的同款纪律)。
                DispatchQueue.main.async { [weak self] in self?.send(res) }
            }
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var res = self.dispatch(op, msg)
            res["kind"] = "res"
            res["id"] = id
            self.send(res)
        }
    }

    /// 壳自己知道的那点由头(插件那一头的管线名不在 helper 协议里,见 AppOpenLog.swift 文件头)。
    private static func openWhy(_ op: String, _ msg: [String: Any]) -> String? {
        if op == "send_text", msg["new_conversation"] as? Bool == true { return "先开新对话" }
        return nil
    }

    /// ★ **每一条回包都从这一处出去**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
    ///
    /// 锁着屏时窗口型那几家**起不出窗、辅助功能一扇窗都列不出**,底下那些 op 只能报
    /// 「一扇标准窗口都没有」—— 那句话对她是误导(她会去查那一家,其实是电脑锁着)。
    /// 所以在这儿**一处**换成人话、加上 `screen_locked` 那一格(判断全在 `ScreenLockPolicy`)。
    ///
    /// 接在这里而不是底下七八个 op 各接一遍:所有动别人窗口的活都从 `dispatch` 出去,
    /// 路由表里加一个 op 就自动跟着对(同上面那条 `AppOpenLog.opensApp` 的理由)。
    private func dispatch(_ op: String, _ msg: [String: Any]) -> [String: Any] {
        ScreenLockPolicy.decorate(op: op, bundleId: msg["bundle_id"] as? String ?? "",
                                  res: runOp(op, msg), locked: ScreenLock.locked())
    }

    private func runOp(_ op: String, _ msg: [String: Any]) -> [String: Any] {
        let bundleId = msg["bundle_id"] as? String ?? ""
        let index = msg["index"] as? Int ?? 0
        switch op {
        case "screen_info":
            return ["ok": true, "result": screenInfo()]
        case "app_info":
            return control.appInfo(bundleId)
        case "set_window_frame":
            guard let f = msg["frame"] as? [String: Any],
                  let x = f["x"] as? Double ?? (f["x"] as? Int).map(Double.init),
                  let y = f["y"] as? Double ?? (f["y"] as? Int).map(Double.init),
                  let w = f["w"] as? Double ?? (f["w"] as? Int).map(Double.init),
                  let h = f["h"] as? Double ?? (f["h"] as? Int).map(Double.init) else {
                return ["ok": false, "error": "frame 缺字段"]
            }
            return control.setWindowFrame(bundleId, index, CGRect(x: x, y: y, width: w, height: h))
        case "raise_window":
            return control.raise(bundleId, index)
        case "hide_app":
            return control.hide(bundleId)
        case "unhide_app":
            return control.unhide(bundleId)
        case "observe":
            let bundleIds = msg["bundle_ids"] as? [String] ?? []
            // I4:startObserving 回挂载失败的 bundle 清单(空数组是常态)——原样透传给服务端,
            // 让 dockService 写一条 note,而不是在这里悄悄吞掉、假装全都订阅成功了。
            let failed = control.startObserving(bundleIds: bundleIds) { [weak self] bundleId, frame, dragged, pressed in
                self?.sendMoved(bundleId, frame, dragged, pressed)
            }
            return ["ok": true, "result": ["failed": failed]]
        case "hover_zone":
            // 悬停高亮 v1:rect 缺失或就是 JSON null(JSONSerialization 把它解成 NSNull,
            // 强转 [String:Any] 会失败)都按清除处理(D13:宁可清掉悬停圈,也不留一个
            // 算不准的旧矩形继续参与判定)。
            if let r = msg["rect"] as? [String: Any],
               let x = r["x"] as? Double ?? (r["x"] as? Int).map(Double.init),
               let y = r["y"] as? Double ?? (r["y"] as? Int).map(Double.init),
               let w = r["w"] as? Double ?? (r["w"] as? Int).map(Double.init),
               let h = r["h"] as? Double ?? (r["h"] as? Int).map(Double.init) {
                control.setHoverZone(CGRect(x: x, y: y, width: w, height: h)) { [weak self] inside in
                    self?.sendHover(inside)
                }
            }
            else {
                control.setHoverZone(nil) { [weak self] inside in
                    self?.sendHover(inside)
                }
            }
            return ["ok": true, "result": [String: Any]()]
        case "highlight_region":
            // 光圈 v1。rect 缺失或是 JSON null(JSONSerialization 解成 NSNull,强转会失败)
            // 都按灭灯处理——与 hover_zone 同一条纪律(D13:宁可灭掉,也不留一个指向
            // 空处的旧矩形继续画)。**不需要辅助功能授权**:画一扇自己的浮窗而已,不碰
            // 别人的窗口(同 screen_info,那条也不依赖 AX)。
            if let r = msg["rect"] as? [String: Any],
               let x = r["x"] as? Double ?? (r["x"] as? Int).map(Double.init),
               let y = r["y"] as? Double ?? (r["y"] as? Int).map(Double.init),
               let w = r["w"] as? Double ?? (r["w"] as? Int).map(Double.init),
               let h = r["h"] as? Double ?? (r["h"] as? Int).map(Double.init) {
                let ttl = msg["ttl_ms"] as? Int ?? (msg["ttl_ms"] as? Double).map { Int($0) }
                // beam:false = 只亮那行字、不亮那圈流线光(2026-09-25 卡 P 补:事务官动窗口槽只留字)。缺省照旧亮光。
                highlight.show(axRect: CGRect(x: x, y: y, width: w, height: h),
                               ttlMs: ttl,
                               label: msg["label"] as? String,
                               beam: msg["beam"] as? Bool ?? true)
            }
            else {
                highlight.hide()
            }
            return ["ok": true, "result": [String: Any]()]
        case "arm_rehide":
            // 「遮罩一收就藏回去」的预约(见 RehideArms)。这条在主线程上跑(不在 axQueueOps 里):ActivationWatch 住在主线程。
            let armed = onArmRehide?(bundleId) ?? false
            return ["ok": true, "result": ["armed": armed]]
        case "window_mode":
            // 前台 / 桌面两档(2026-09-18,Ben:「登录和引导的时候……现在写死是底部」)。
            // **不需要辅助功能授权**:只动壳自己这扇窗的层级,不碰任何别人的窗口
            // (同 screen_info / highlight_region 那一档)。服务端那边也据此把这个 op
            // 放行在授权门之外——第一次开机时辅助功能多半还没授权,而登录屏恰恰是
            // 最需要看得见的那一屏。
            guard let mode = ShellWindowMode.parse(msg["mode"]) else {
                return ["ok": false, "error": "mode 只认 front / desktop"]
            }
            // dispatch 本来就在主线程上跑(见 handle 里的 DispatchQueue.main.async),
            // 这里直接回调,不再套一层。
            onWindowMode?(mode)
            return ["ok": true, "result": ["mode": mode.rawValue]]
        case "system_awake":
            // 工作台开着时整台电脑不睡(2026-09-28,卡 AW)。**不需要辅助功能授权**:
            // 只按一条电源断言,不碰任何别人的窗口(同 window_mode 那一档)。
            guard let enabled = msg["enabled"] as? Bool else {
                return ["ok": false, "error": "enabled 只认 true / false"]
            }
            // dispatch 本来就在主线程上跑(见 handle 里的 DispatchQueue.main.async)。
            let held = onSystemAwake?(enabled) ?? false
            return ["ok": true, "result": ["enabled": enabled, "held": held]]
        case "away_awake":
            // 出门时电脑不睡(2026-10-03)。**不需要辅助功能授权**:同 system_awake,
            // 只按一条电源断言,不碰任何别人的窗口。判断全在插件那边,这里只收结论。
            guard let active = msg["active"] as? Bool else {
                return ["ok": false, "error": "active 只认 true / false"]
            }
            // dispatch 本来就在主线程上跑(见 handle 里的 DispatchQueue.main.async)。
            let holding = onAwayAwake?(active) ?? false
            return ["ok": true, "result": ["active": active, "held": holding]]
        case "slot_apps":
            // 窗口槽成员表(2026-10-04)。**不需要辅助功能授权**:同 system_awake / away_awake,
            // 收完只可能动那一条电源断言,一个窗口都不碰 —— 而且没授权时她照样在用槽里那一家。
            // bundle_ids 缺席 / 不是字符串数组 = 空表(按缺省走 2026-10-04 之前的行为,不报错)。
            let slotIds = (msg["bundle_ids"] as? [Any] ?? []).compactMap { $0 as? String }
            // dispatch 本来就在主线程上跑(见 handle 里的 DispatchQueue.main.async)。
            let slotHeld = onSlotApps?(slotIds) ?? false
            return ["ok": true, "result": ["count": slotIds.count, "held": slotHeld]]
        case "request_accessibility":
            // 2026-09-23:启动时不再弹辅助功能框,只在他点了「去授权」时由这一条触发。
            // **不需要辅助功能授权**(它本身就是去要授权的那一下),服务端把它放在授权门之外。
            // 主线程(dispatch 就在主线程上跑)。
            let trusted = onRequestAccessibility?() ?? false
            return ["ok": true, "result": ["authorized": trusted]]
        case "notify":
            // 事务官有话问你 / 要你批一件事(2026-09-25,卡 M)。**不需要辅助功能授权**(弹一条系统通知,不碰别人的窗口),
            // 服务端把它放在授权门之外。在不在前台、弹不弹,NotifyPolicy 判;真弹在 ShellNotifier。主线程。
            guard let key = msg["key"] as? String, !key.isEmpty else {
                return ["ok": false, "error": "notify 缺 key"]
            }
            let result = onNotify?(key, msg["title"] as? String ?? "", msg["body"] as? String ?? "", msg["clear"] as? Bool ?? false)
                ?? ["shown": false, "reason": "这份壳没接通知"]
            return ["ok": true, "result": result]
        case "focus_input":
            // 派活第一段(2026-09-21):只找输入框、不送字。能力探测与"送之前先看一眼"共用这条。
            // focus 缺省 false —— 探测不该顺手改用户窗口的焦点。
            return TextInsert.focusInput(bundleId: bundleId, index: index,
                                         focus: msg["focus"] as? Bool ?? false)
        case "press_below_text":
            // 按「锚在一段字下面那一排里、没名字的那颗键」(2026-10-12,演示卡:可灵结果卡上的下载)。见 TextInsert.pressBelowText。
            guard let pattern = msg["pattern"] as? String, let role = msg["role"] as? String else {
                return ["ok": false, "error": "press_below_text 缺 pattern / role"]
            }
            return TextInsert.pressBelowText(bundleId: bundleId, index: index, pattern: pattern, role: role, maxBelow: msg["max_below"] as? Int ?? 80)
        case "clear_frames":
            // 把框上方已经挂着的帧图一张张删掉(2026-10-12,演示卡):见 TextInsert.clearFrames。
            return TextInsert.clearFrames(bundleId: bundleId, index: index)
        case "clear_composer":
            // 按输入区左下角那颗没名字的「清空」键(2026-10-12,演示卡):认法见 SendTextPolicy.pickComposerClearKey。
            return TextInsert.clearComposer(bundleId: bundleId, index: index, click: msg["click"] as? Bool ?? false)
        case "paste_image":
            // 把一张图粘贴进那家的输入框(2026-10-12,演示卡「出图进可灵」):剪贴板先存后还,见 TextInsert.pasteImage。
            guard let path = msg["path"] as? String, !path.isEmpty else {
                return ["ok": false, "error": "paste_image 缺 path"]
            }
            return TextInsert.pasteImage(bundleId: bundleId, index: index, path: path)
        case "send_text":
            // 把一段话送进某家 Agent 客户端的输入框(白名单在 SendTextPolicy,微信/企微永远不在里面)。
            // submit 缺省 **false**:送进框里和按下回车是两件事,后者会用他的账号真跑一次会话,
            // 调用方必须明着要。restore_front 缺省 false(送完留在台前,人才看得见字进去了)。
            guard let text = msg["text"] as? String else {
                return ["ok": false, "error": "send_text 缺 text"]
            }
            // new_conversation(2026-09-24,卡 F):先按那家菜单里的「新对话」再送,缺省 false(老调用方一字不变)。
            return TextInsert.sendText(bundleId: bundleId, index: index, text: text,
                                       submit: msg["submit"] as? Bool ?? false,
                                       restoreFront: msg["restore_front"] as? Bool ?? false,
                                       overwrite: msg["overwrite"] as? Bool ?? false,
                                       newConversation: msg["new_conversation"] as? Bool ?? false,
                                       // save_draft(2026-09-27,卡 DB):框里有他没发出去的字时,
                                       // 壳把那段原文读出来一并回给服务端(落盘 ~/.dsh/workbench/drafts/),
                                       // 送完再原样放回框里。缺省 false —— 老服务端照旧拦下不覆盖。
                                       saveDraft: msg["save_draft"] as? Bool ?? false)
        case "read_reply":
            // 派活的收回(2026-09-24,卡 F):只读,回那扇窗里我们那句话之后的文字。见 TextInsert.readReply。
            guard let marker = msg["marker"] as? String, !marker.isEmpty else {
                return ["ok": false, "error": "read_reply 缺 marker"]
            }
            return TextInsert.readReply(bundleId: bundleId, index: index, marker: marker)
        case "read_texts":
            // 额度要覆盖派活名单里的每一家(2026-09-25,卡 O):只读,只回服务端那几条正则命中的那一小段字。
            // 见 SendTextPolicy.matchTexts / TextInsert.readTexts。老服务端不发这个 op,老壳收到回「未知 op」。
            guard let patterns = SendTextPolicy.parseTextPatterns(msg["patterns"]) else {
                return ["ok": false, "error": "read_texts 的 patterns 不对(要 1–\(SendTextPolicy.readTextsMaxPatterns) 条 {id, regex, top?})"]
            }
            // 2026-09-26(卡 MQ):**这一条的 index 不跟上面那个缺省 0** —— 不给就每一扇标准窗都读一遍
            // (Muse 的额度在四扇窗里「设置」那一扇上,写死第 0 扇一条也读不到)。给了就只读那一扇。
            // `unhide`(2026-09-27):服务端说放才放藏着的家 —— 只有他点「读一下」才放,自动那几路不放
            // (维护者:「点击设置按钮,依次闪过 manus、muse、豆包、Grok bot 四个应用」)。老服务端不给这一格 → 照旧放。
            // `include_titles`(2026-10-03,卡「Grok 读键字」;caps 里那一格叫 `read_titles`):
            // **按家声明**地连「键身上的字」(`AXMenuItem` / `AXButton` 的 title)也收进文字流 ——
            // Grok Bot 的额度写在一颗 `AXMenuItem` 身上(「SuperGrok 6%」),整扇窗的静态字里
            // 一个百分号都没有。**不给这一格就一个都不收**(缺省 false,行为与之前一字不差):
            // 全局打开的话,一颗叫「使用情况」的侧栏键会把 Muse / 豆包那条「这确实是那一页」的
            // 整格旁证骗过去 —— 假阳性比读不到坏得多(卡 MQ 的老教训)。见 SendTextPolicy.titleRoles。
            return TextInsert.readTexts(bundleId: bundleId, index: msg["index"] as? Int, patterns: patterns,
                                        unhideHidden: (msg["unhide"] as? Bool) ?? true,
                                        includeTitles: (msg["include_titles"] as? Bool) ?? false)
        case "running_apps":
            // Agent 自动发现(2026-09-25,卡 Q):正在跑的常规 App 与它们包里写的身份。不碰辅助功能、不碰窗口。
            return AgentWindow.runningApps(ownBundleId: Bundle.main.bundleIdentifier ?? "ai.ben.workbench")
        case "agent_probe":
            // 只读窗口**结构**(有没有输入框、发送、新对话、列表;字只数不读)。判「像不像对话窗口」在服务端。
            return AgentWindow.probe(bundleId: bundleId)
        case "agent_read":
            // 只读:窗口标题、停止键、对话区尾巴上那几块字、侧栏那几行。只对登记表里接上了的那几家(服务端把着)。
            return AgentWindow.read(bundleId: bundleId)
        case "agent_images":
            // 只读(2026-10-13 夜,卡 T):一扇窗里图片类节点的位置与 AXURL —— 可灵首帧格「传完了没有」的真信号在服务端判。
            return AgentWindow.images(bundleId: bundleId)
        case "agent_ax_detail":
            // 那棵树的**明细**(2026-10-02,卡「适配自绘界面的 Kimi」,只读、诊断用):一个元素一行,
            // 角色 / 子角色 / 层数 / 位置大小 / 按得下去哪些动作 / 哪几条属性写得进去,文字**只回字数**。
            // 服务端只对「输入框没认出来」的那几家问一次,收进登记表 → 进诊断包(见 AgentWindow.axDetail)。
            return AgentWindow.axDetail(bundleId: bundleId)
        case "agent_pick":
            // 在侧栏里点他点名那条对话(2026-09-28,卡 WR):窗口型那几家没有「开到某一段对话」的深链,
            // 要往**已有的**那条对话里送话只有这一条路。认不准 / 两条都像 → 一条都不点(见 AgentWindow.pick)。
            guard let title = msg["title"] as? String, !title.isEmpty else {
                return ["ok": false, "error": "agent_pick 缺 title"]
            }
            return AgentWindow.pick(bundleId: bundleId, title: title)
        case "agent_stop":
            // 按那家的「停止」键(2026-09-28,卡 WR):他说「打断它 / 先停下」时先走这一下。
            // 认不出停止键就回 found:false —— **不许假装打断**。
            return AgentWindow.stop(bundleId: bundleId)
        case "agent_press":
            // 替他点它弹的框上那一项(2026-09-28,卡 WQ):归一化之后整行相等才点,两处都对得上一处都不点;
            // 点完重读一次核实那一项没了(见 AgentWindow.press)。与 agent_pick / agent_stop 同一类,留在主线程。
            guard let label = msg["label"] as? String, !label.isEmpty else {
                return ["ok": false, "error": "agent_press 缺 label"]
            }
            // 这一问的全部几项(认「只画了标题那一截」时要核唯一);老服务不带就只按这一项认。
            let options = (msg["options"] as? [Any])?.compactMap { $0 as? String } ?? []
            // 只认这个角色(2026-10-12):同名的一颗键与一条导航链接分得开。老服务不带 = 老行为。
            let role = (msg["role"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return AgentWindow.press(bundleId: bundleId, label: label, options: options, role: role)
        case "quota_page":
            // 在后台把那家翻到额度那一页(2026-10-03,卡 QP):**只 unhide、不 activate**,
            // 认那颗键复用 `agent_press` 那套识别,按只走 `AXPress` —— 一次鼠标点击都不合成
            // (合成点击才非得要台前,那正是这条 op 要治的病)。见 AgentWindow.quotaPage。
            //
            // **留在主线程**(既不进 axQueueOps 也不进 readQueueOps):它与 `read_texts` 是同一条链上
            // 一前一后两下 —— 同样要 `unhide` + 等一拍(`RunLoop.run(until:)` 要主 run loop 才真等得住),
            // 而放进切窗那条队列会让她点标签切应用排在一次两秒的翻页后面(SwitchBudget 那道「排太久就放弃」
            // 会把她那一下判成失败)。
            //
            // ★ 卡 QT(2026-10-03):`labels` 收**一串** —— 一次放出来里挨个按完再一次藏回去。
            // 为什么非得这样:豆包那颗通向额度页的键按下去弹一张菜单,而这条 op 返回前就把那家
            // 藏回去了、菜单跟着收 —— 分两条 op 发,第二颗键压根不在树上(见 AgentWindow.quotaPage)。
            // `label`(单颗)照旧认:老插件一个字都不用改。
            //
            // ★ 卡「豆包闪一下」(2026-10-03;caps 里那一格叫 `quota_front`):`front: true` =
            // **叫到台前按一下、按完立刻把台前与隐藏状态都还原**。缺省 false —— 不给这一格时
            // 上面那一整段(不 activate、不抢焦点)一个字都不变。豆包那颗键弹的是系统画的原生菜单,
            // 后台压根弹不出来;「只在那一格真坏了的时候闪、一家 90 分钟最多一次」两道门都在插件那一侧。
            let pageLabels = (msg["labels"] as? [Any])?.compactMap { $0 as? String }
                ?? (msg["label"] as? String).map { [$0] } ?? []
            guard pageLabels.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                return ["ok": false, "error": "quota_page 缺 label"]
            }
            //
            // ★ 卡「豆包台前点一下」(2026-10-04;caps 里那一格叫 `quota_click`):`click: true` =
            // 台前那一支里**第一颗键**用合成点击按(豆包那张原生菜单 AXPress 回 success 却压根不弹)。
            // 要与 `front` 一起给才作数(判据 `AgentWindowPolicy.clicksThisStep`);缺省 false ——
            // 不给这一格时后台那一支一行 `clickAt` 都没有。
            return AgentWindow.quotaPage(bundleId: bundleId, labels: pageLabels,
                                         front: (msg["front"] as? Bool) ?? false,
                                         click: (msg["click"] as? Bool) ?? false)
        case "agent_approval":
            // 替她看 / 按那家的批准弹窗(2026-10-01,卡 AP):`marks` 圈出这条会话的那一个弹窗,不带 `press` 只读键名;
            // 带 `press` + `panel` 只在那一块里按那一颗,按完重读核实。会点一下、会叫台前 —— 同 agent_press,留在主线程。
            var panel: CGRect?
            if let r = msg["panel"] as? [String: Any],
               let x = r["x"] as? Double ?? (r["x"] as? Int).map(Double.init),
               let y = r["y"] as? Double ?? (r["y"] as? Int).map(Double.init),
               let w = r["w"] as? Double ?? (r["w"] as? Int).map(Double.init),
               let h = r["h"] as? Double ?? (r["h"] as? Int).map(Double.init) {
                panel = CGRect(x: x, y: y, width: w, height: h)
            }
            return AgentWindow.approval(bundleId: bundleId, marks: (msg["marks"] as? [String]) ?? [],
                                        press: msg["press"] as? String, panel: panel)
        case "agent_write_ask":
            // 把她自己那句话写进它那个提问面板里的自由作答框(2026-09-28,卡 AT)。
            // `marks` = 那一问的选项原话 + 问句原话:**认那个面板全靠它**,少了就不动手
            // (写进窗口底部主输入框 = 把她的话当新一轮指令发进她正在跑的会话)。见 AgentWindow.writeAsk。
            guard let said = msg["text"] as? String, !said.isEmpty else {
                return ["ok": false, "error": "agent_write_ask 缺 text"]
            }
            return AgentWindow.writeAsk(bundleId: bundleId, text: said, marks: (msg["marks"] as? [String]) ?? [])
        case "agent_allow":
            // Agent 登记表里接上了的那几家(2026-09-25,卡 Z):服务端报一份过来,壳这道门据此放行。
            // **不需要辅助功能授权、不碰任何窗口**(只改壳自己内存里那一份),服务端把它放在授权门之外。
            // 永不送的那几家(微信、企业微信)在 setDeclaredAgents 里被剔掉 —— 服务端说了也不算。
            let ids = (msg["bundle_ids"] as? [String]) ?? []
            SendTextPolicy.setDeclaredAgents(ids)
            return ["ok": true, "result": ["count": SendTextPolicy.declaredAgents.count]]
        case "icon_colors":
            // 各家图标的主色(卡 Q):头像与小灯的颜色从这里来。不碰辅助功能、不碰窗口。
            return AgentWindow.iconColors(bundleIds: msg["bundle_ids"] as? [String] ?? [])
        case "app_icon":
            // 整张图标(2026-09-26,卡 LG):窗口槽标签、顶栏小灯、「N 家 Agent 客户端」那一条上的小图标。
            // 只认包标识、不认任意路径;渲一次记在壳内存里(幂等)。不碰辅助功能、不碰窗口。
            return AgentWindow.appIcon(bundleId: bundleId, size: msg["size"] as? Int)
        case "ax_probe":
            // 1c:纯诊断面,请求驱动,一行转发给 WindowControl.axProbe——具体 action
            // 分支全在那边,这里不重复解析 msg。
            return control.axProbe(msg)
        default:
            return ["ok": false, "error": "未知 op:\(op)"]
        }
    }

    /// 拖动落定后主动推给服务端(窗位叠 v2 Task 1)——不是回 res,是壳这边主动发起的
    /// 出站消息,服务端按 kind 分发,不认识的 kind 会被忽略(不需要版本协商)。
    /// dragged(2026-08-26 微信重登归位修复):事件风暴期间鼠标左键是否按下过——服务端据此
    /// 区分"用户拖出=除名"和"程序化移动=贴回槽位"。旧服务端不认识这个字段会原样忽略。
    /// pressed(2026-09-18 拖窗认领):落定**那一刻**左键还按着没有——与 dragged 是两条独立
    /// 证据,服务端首次那道门"任一为真就认"。旧服务端不认识这个字段同样原样忽略。
    private func sendMoved(_ bundleId: String, _ frame: CGRect, _ dragged: Bool, _ pressed: Bool) {
        send(["kind": "moved", "bundle_id": bundleId, "frame": control.rectJSON(frame), "dragged": dragged, "pressed": pressed])
    }

    /// 悬停进出圈瞬间主动推给服务端(悬停高亮 v1)——同 sendMoved 一样是壳主动发起的
    /// 出站消息,只在跳变时发,不是逐帧上报。
    private func sendHover(_ inside: Bool) {
        send(["kind": "hover", "inside": inside])
    }

    /// 有 App 起来 / 被切到前台 / 退出了(2026-09-25,卡 Q「Agent 自动发现」)——壳主动推给服务端,
    /// 服务端据此发现新 Agent、读一眼它的窗口、标它已读。只带身份(包标识、名字、pid),不碰它的窗口。
    /// 旧服务端不认识这个 kind,原样忽略。
    func sendAppEvent(_ event: String, bundleId: String, name: String?, pid: Int32) {
        var msg: [String: Any] = ["kind": "app", "event": event, "bundle_id": bundleId, "pid": Int(pid)]
        if let name { msg["name"] = name }
        DispatchQueue.main.async { [weak self] in self?.send(msg) }
    }

    /// 他点了系统通知(2026-09-25,卡 M):壳已经回到前台,告诉服务端是哪一张,页面据此切到事务官、摊开那一张。
    func sendNotificationClick(_ key: String) {
        send(["kind": "notification_click", "key": key])
    }

    /// 通知到底弹没弹(卡 M 补):ShellNotifier 每读到授权 / 问过他 / 交给系统之后回一条(`NotifyPolicy.statusPayload`)。
    func sendNotifyStatus(_ payload: [String: Any]) {
        send(payload)
    }

    /// 休眠/坏死上报(ax_stale,1b)——同 sendMoved 一样是壳主动发起的出站消息:观察者
    /// 挂载成功不代表事件真的会来,这条消息把 WindowControl 重挂后立刻测出来的原始
    /// 异常报给服务端,不用等真机再花时间摸索。
    func sendAxStale(_ bundleId: String, _ axErr: Int, _ axCount: Int, _ cgCount: Int) {
        send(["kind": "ax_stale", "bundle_id": bundleId, "ax_err": axErr, "ax_count": axCount, "cg_count": cgCount])
    }

    /// 被叫到前面的那一家:真切过去(`switch`)、临时叫一下(`transient`)、遮罩开了(`overlay`)(2026-09-25,卡 P)。
    /// 同 sendMoved 一样是壳主动发起的出站消息;旧服务端不认识这个 kind 会原样忽略。payload 由 ActivationWatch 拼好。
    func sendActivation(_ payload: [String: Any]) {
        send(payload)
    }
}
