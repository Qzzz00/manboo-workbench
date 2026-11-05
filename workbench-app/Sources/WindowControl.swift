import AppKit
import ApplicationServices

/// AXObserver 回调是 C 函数指针,不能捕获 self——回调里只能靠 refcon 带上下文。
/// 这个盒子装 bundle id 和指回 WindowControl 的弱引用,喂给 AXObserverAddNotification
/// 的 refcon,回调里用 Unmanaged 取回来再转发给实例方法。
private final class AXObserverContext {
    weak var control: WindowControl?
    let bundleId: String
    init(control: WindowControl, bundleId: String) {
        self.control = control
        self.bundleId = bundleId
    }
}

/// 单个被观察窗口的落定去抖状态——每个窗口独立一个定时器,互不影响
/// (同一应用两个窗口分别拖动,各自的 300ms 窗口不能互相打断)。
///
/// hoverInside(悬停高亮 v1):这扇窗口"当前中心点是否落在悬停圈内"的最近一次判定结果,
/// 逐窗口各记各的——两扇窗口同时被拖(少见但可能),一扇进圈不该被另一扇的出圈事件覆盖。
private struct WatchedWindow {
    let window: AXUIElement
    var settleTimer: DispatchWorkItem
    var hoverInside: Bool = false
    /// dragged(2026-08-26 微信重登归位修复):这轮事件风暴期间鼠标左键有没有按下过——
    /// 用户拖窗必然全程按着左键,应用自己重建/摆放窗口(微信登录流程销毁旧主窗、在
    /// 默认位置新开一扇)时没有。每次事件采样一次 NSEvent.pressedMouseButtons(事件
    /// 驱动的顺手一读,不是新开轮询),按下过就置位,落定时随 moved 一起上报,服务端
    /// 据此区分"用户拖出=除名"和"程序化移动=贴回槽位"。落定即清(条目整个移除)。
    var dragged: Bool = false
}

/// 单个被观察应用的 AXObserver 及其挂着的窗口去抖状态,应用退出时整体清理。
private final class AppWatch {
    let pid: pid_t
    let observer: AXObserver
    let contextRef: UnsafeMutableRawPointer
    var windows: [WatchedWindow] = []
    init(pid: pid_t, observer: AXObserver, contextRef: UnsafeMutableRawPointer) {
        self.pid = pid
        self.observer = observer
        self.contextRef = contextRef
    }
}

/// AXObserver 系统回调转发入口。V8 纪律修订(Ben 2026-08-24 批)只放行"事件型 AX
/// 观察"——这个回调本身就是被放行的那一类,不是轮询;它不主动读任何东西,只是
/// AX 系统在窗口挪动/变尺寸时叫醒我们,叫醒之后再落到 300ms 去抖里判断"落定"没有。
private let axObserverCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon else { return }
    let context = Unmanaged<AXObserverContext>.fromOpaque(refcon).takeUnretainedValue()
    context.control?.handleAXEvent(bundleId: context.bundleId, notification: notification as String, window: element)
}

/// AX 窗口原语。坐标一律 AX 全局坐标(主屏左上为原点,y 向下)——AX 的
/// kAXPositionAttribute 本身就是这个坐标系,这里不做任何换算。
final class WindowControl {
    /// A2(c) 修订(Ben 2026-08-24 批,V8 纪律延续):不再靠服务端下发的 bundle 名单决定
    /// 观察范围——拖入即认领是产品语义,名单制会挡住服务端还不认识的应用(比如 bundle id
    /// 又变了一次的微信,见 activation.ts 顶部注释)。改成"当前+未来所有常规界面应用"
    /// 都挂观察者,认领决策仍然全在服务端(只有窗口中心落进槽位矩形才会被认领,几何判定
    /// 把噪声滤掉了,不需要靠观察范围本身来收窄)。
    private let ownBundleId = Bundle.main.bundleIdentifier ?? "ai.ben.workbench"
    private var watches: [String: AppWatch] = [:]
    /// 第三个参数是 dragged(见 WatchedWindow.dragged 的 WHY),第四个是 pressed ——
    /// **落定那一刻**左键还按着没有(2026-09-18 拖窗认领那张卡新加)。dragged 只在 AX 事件
    /// 回调里采样,事件风暴起得比按键晚的那一拍它就是 false;pressed 与事件时序无关,是
    /// 第二条独立证据,服务端首次那道门改成"两条任一成立就认"。
    private var onSettled: ((String, CGRect, Bool, Bool) -> Void)?
    /// AX 通道已经确认不可用的 bundle —— 挂观察者失败即入列,成功即出列。
    ///
    /// 这份名单就是 CG 兜底链(见 DragSense.swift)的作用面:**只有名单里的应用**才会在
    /// 用户按下左键时被跟踪。健康的应用照旧走 AX 那条链,一个字都不改 —— 兜底不是"从此
    /// 人人都走兜底",是"AX 已经给不出任何东西的那几家,总得有条路"。
    private var axDead: Set<String> = []
    /// 悬停高亮 v1:圈的屏幕(AX)坐标,nil=没有圈——服务端矩形未知/被清除时就是这个态。
    private var hoverZone: CGRect?
    private var onHover: ((Bool) -> Void)?
    /// 休眠/坏死上报(ax_stale,1b)——handleAppActivated 重挂后测出异常就调它。socket
    /// 比 control 晚创建,这根线只能在 AppDelegate 里等 socket 建好后回填,这里先留空。
    var onAxStale: ((String, Int, Int, Int) -> Void)?
    /// 回调计数器(1d):key 是 `"\(bundleId)/\(notification)"`,ax_probe "counters" 透出。
    /// 事件回调本体(handleAXEvent)不打 NSLog(拖拽风暴刷屏),真出问题时靠这份计数看
    /// 回调到底有没有在响,不用凭感觉猜是"没事件"还是"事件来了但后面链路断了"。
    private var eventCounts: [String: Int] = [:]
    /// ax_stale 补挂竞态修复(review,2026-08-25):每次 reattachObserver 都给这个 bundle
    /// 递增一代。checkStaleAndReport 的 2s 延迟补挂闭包排队时记住自己那一代,到期时如果
    /// 已经不是最新一代,说明这段等待期里已经有别的路径(更晚一次激活、ax_probe 手动
    /// reattach…)重新挂过了,这条排队中的补挂对着的已经是过时状态,直接放弃——不校验
    /// 会让较早激活链的补挂对着更晚激活刚建好的新 watch 再拆一次,纯属重复劳动,还会
    /// 对新 watch 重新踩一遍下面 windows 非空那条竞态。
    private var generation: [String: Int] = [:]
    /// 我们自己在挪窗的那几家 → 到这个时刻(开机以来的秒数)之前,它们的挪窗事件**不报给服务端**(卡 P 补二)。
    /// 遮罩底下把被掀出来的那一家的窗挪到屏外、藏好后挪回,都是我们挪的:服务端要是当成「他把它拖出窗位」
    /// 会把它从窗口槽里除名,当成「应用自己跑偏」会把它摆回窗位 —— 挪开就白做了,遮罩一收照样闪。
    /// 挪窗在 ActivationWatch 那条队列上、落定上报在主线程,两边都读写这份表,带锁。
    private var movesHeldUntil: [String: TimeInterval] = [:]
    private let movesHeldLock = NSLock()

    private func runningApp(_ bundleId: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    }

    /// 这一家的 AX 通道此刻是不是已知不通(挂观察者失败过、还没恢复)。ActivationWatch 据此不白问子角色(卡 P)。
    func isAxDead(_ bundleId: String) -> Bool {
        axDead.contains(bundleId)
    }

    // MARK: - AX 时限(2026-09-21「点标签切换经常卡住」)

    /// **每一个拿到手的 AXUIElement 都要先过这里。**
    ///
    /// AX 调用是**同步等目标应用回话**的:`AXUIElementCopyAttributeValue` 发一条消息给目标
    /// 进程,然后就地等它答。默认没有时限 —— 目标忙(Claude / 微信 / 企业微信 这些 Chromium
    /// 系客户端在机器负载 100+ 时尤其明显)时一次能挂好几秒,而一次切换要做三四次 AX 往返。
    /// 2026-09-21 真机排查:负载 100–200 时 `/dock/switch` 要好几秒,负载降到 5 之后同一条路
    /// 只要 40ms —— 卡的不是代码路径长,是每一步都在无限期等人。
    ///
    /// 时限值与「为什么是 1 秒」写在 `SwitchBudget.axMessagingTimeoutSeconds`(纯逻辑、有单测)。
    /// 超时后 AX 回 `kAXErrorCannotComplete`,而下面每个调用点的既有写法(`== .success` 才用,
    /// 否则返回 nil / 空数组 / 如实报错)本来就是「**这家这次不动**」—— 不抛、不重试、不阻塞
    /// 后面的家。也就是说这次改动**没有新增任何失败分支**,只是让原来那些分支在有限时间内到达。
    @discardableResult
    private func armed(_ element: AXUIElement) -> AXUIElement {
        AXUIElementSetMessagingTimeout(element, Float(SwitchBudget.axMessagingTimeoutSeconds))
        return element
    }

    /// 应用级元素统一从这里拿 —— `AXUIElementCreateApplication` 在这个文件里出现过七次,
    /// 每一处都得带时限,靠人记不住,所以只留这一个入口。
    private func appElement(_ pid: pid_t) -> AXUIElement {
        return armed(AXUIElementCreateApplication(pid))
    }

    /// 系统级元素上的时限 = 这个进程的**全局缺省**(苹果文档:设在 system-wide element 上的
    /// 值适用于所有没有单独设过的元素)。我们仍然逐个元素设(上面两个函数),这条纯属兜底:
    /// 万一哪天有人新加了一处 AX 调用忘了走 `appElement`,它至少也有 1 秒的天花板,不会一路
    /// 退回「无限期等」。壳启动时设一次即可。
    private func armGlobalTimeout() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Float(SwitchBudget.axMessagingTimeoutSeconds))
    }

    init() {
        armGlobalTimeout()
    }

    private func axWindows(_ pid: pid_t) -> [AXUIElement] {
        let appEl = appElement(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &value) == .success,
              let arr = value as? [AXUIElement] else { return [] }
        // 窗口级元素是独立的 AXUIElementRef,**不继承**应用元素上的时限 —— 逐个也要带上,
        // 不然下面 subrole / frame / setWindowFrame / raise 那几步又回到无限期等。
        return arr.map { armed($0) }
    }

    private func subrole(of win: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(armed(win), kAXSubroleAttribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    /// 只留 AXStandardWindow,幽灵窗真机实测坑:企业微信(com.tencent.WeWorkMac)、
    /// ChatGPT(com.openai.codex,即 Codex 客户端)的 AX 窗口列表里混进好几个幽灵窗——
    /// 一个 (0,0,2560×30) 菜单条大小的、几个屏外的小窗——跟那唯一一个真窗口一起出现在
    /// windows 数组里。编排器一直摆 windows[0],这些应用恰好幽灵窗排在最前面,于是摆的
    /// 是幽灵窗、真窗口纹丝不动,回读校验诚实地报"贴合失败"。之前"终端能用"只是因为
    /// Terminal 的真窗口凑巧排第一个,不是这套逻辑本来就对。
    /// 过滤后为空就退回原始列表兜底——部分应用的窗口压根不设置 subrole,不能因为查不到
    /// 标准窗口就把这个应用的窗口清空成 0 个。
    private func standardWindows(_ pid: pid_t) -> [AXUIElement] {
        let all = axWindows(pid)
        let standard = all.filter { subrole(of: $0) == kAXStandardWindowSubrole as String }
        return standard.isEmpty ? all : standard
    }

    private func frame(of win: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
        let el = armed(win)
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }

    /// HelperSocket 拼 {kind:'moved', frame} 时复用同一套取整规则,不重复写一遍。
    func rectJSON(_ r: CGRect) -> [String: Any] {
        ["x": Int(r.origin.x.rounded()), "y": Int(r.origin.y.rounded()),
         "w": Int(r.width.rounded()), "h": Int(r.height.rounded())]
    }

    func appInfo(_ bundleId: String) -> [String: Any] {
        guard let app = runningApp(bundleId) else {
            return ["ok": true, "result": ["running": false, "hidden": false, "windows": [[String: Any]]()]]
        }
        let wins = standardWindows(app.processIdentifier).enumerated().compactMap { (i, w) -> [String: Any]? in
            guard let f = frame(of: w) else { return nil }
            return ["index": i, "frame": rectJSON(f)]
        }
        // A2(b):name 供服务端自愈注册用——未知 bundle 拖进窗位时,dockService 靠这个
        // 展示名把它写进 registry(见 dock.ts handleMoved 的自愈分支),不用 osascript
        // 反查(那条路认 bundle id 时反而更慢更容易踩系统弹窗)。查不到本地化名字就退回
        // bundle id 本身,不装一个更好看但可能不对的名字(D13)。
        let name = app.localizedName ?? bundleId
        return ["ok": true, "result": ["running": true, "hidden": app.isHidden, "windows": wins, "name": name]]
    }

    func setWindowFrame(_ bundleId: String, _ index: Int, _ target: CGRect) -> [String: Any] {
        guard let app = runningApp(bundleId) else { return ["ok": false, "error": "应用未在运行:\(bundleId)"] }
        let wins = standardWindows(app.processIdentifier)
        guard index >= 0 && index < wins.count else { return ["ok": false, "error": "没有第 \(index) 个窗口(共 \(wins.count) 个)"] }
        let win = wins[index]
        // 缩在程序坞里的窗(2026-09-25,卡 fix/slot-current-empty):只摆位的话改的是它「还原之后」
        // 的位置,人看见的仍是一块空槽,标签却高亮着 —— 先把它从程序坞里放出来再摆。本来就没缩的窗
        // 这一下是空操作;应用不认这个属性(读不出来 / 写不进去)就算了,照旧摆位,不因此报错。
        var minimizedRef: CFTypeRef?
        var unminimized = false
        if AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &minimizedRef) == .success,
           let minimized = minimizedRef as? Bool, minimized {
            unminimized = AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success
        }
        var pos = target.origin; var size = target.size
        // 先位置→尺寸→再位置:部分应用改尺寸时会挪原点,双写位置更稳。
        let posV = AXValueCreate(.cgPoint, &pos)!
        let sizeV = AXValueCreate(.cgSize, &size)!
        AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, posV)
        AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sizeV)
        AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, posV)
        guard let actual = frame(of: win) else { return ["ok": false, "error": "设置后读不回窗口位置"] }
        // unminimized 只在真的从程序坞里放出来过时带(排障用:服务端不认也不影响)。
        var result: [String: Any] = ["frame": rectJSON(actual)]
        if unminimized { result["unminimized"] = true }
        return ["ok": true, "result": result]
    }

    func raise(_ bundleId: String, _ index: Int) -> [String: Any] {
        guard let app = runningApp(bundleId) else { return ["ok": false, "error": "应用未在运行:\(bundleId)"] }
        let wins = standardWindows(app.processIdentifier)
        if index >= 0 && index < wins.count {
            AXUIElementPerformAction(wins[index], kAXRaiseAction as CFString)
        }
        app.activate()
        return ["ok": true, "result": [String: Any]()]
    }

    // MARK: - 遮罩底下挪开 / 藏好后挪回(2026-09-25 卡 P 补二)

    /// 这一家的挪窗事件先别报,直到 `seconds` 秒后(再调一次就改成新的期限)。
    func holdMoveEvents(_ bundleId: String, for seconds: TimeInterval) {
        movesHeldLock.lock()
        movesHeldUntil[bundleId] = ProcessInfo.processInfo.systemUptime + seconds
        movesHeldLock.unlock()
    }

    private func movesHeld(_ bundleId: String) -> Bool {
        movesHeldLock.lock()
        defer { movesHeldLock.unlock() }
        guard let until = movesHeldUntil[bundleId] else { return false }
        if until > ProcessInfo.processInfo.systemUptime { return true }
        movesHeldUntil[bundleId] = nil
        return false
    }

    /// 截图遮罩开着时,把被掀出来的那一家的普通窗口挪到屏外 —— 遮罩收起那一刻露出来的是他原来的页面,
    /// 不是它的主窗口(维护者:「还是会闪一下企业微信,然后恢复之前的页面」)。
    ///
    /// 按 CG 量到的位置认窗(AX 读回的位置、大小 ±4 像素);**只改位置**:不改尺寸、不激活、不置前任何东西,
    /// 遮罩那几扇(层级高)不在 `frames` 里、不会被挪 —— 截图不断。挪到哪由 `ActivationSense.parkOrigin` 定
    /// (某块屏的角外面,只留 1 像素)。回挪走了哪几扇(原来在哪、实际挪到了哪)与没挪成的原因。
    /// 不在主线程上调(AX 要等对方回话,对方这会儿正开着截图)。
    func park(_ bundleId: String, frames: [CGRect], displays: [CGRect]) -> (parked: [ParkedWindow], error: String?) {
        guard !frames.isEmpty else { return ([], nil) }
        guard let app = runningApp(bundleId) else { return ([], "应用未在运行") }
        // 先把它的挪窗事件压住(挪开到挪回之间都压着;挪回那一下之后再放 1.5 秒的回声),再挪。
        holdMoveEvents(bundleId, for: 60)
        let wins = axWindows(app.processIdentifier)
        guard !wins.isEmpty else { return ([], "AX 读不到它的窗") }
        let known = wins.compactMap { win in frame(of: win).map { (win, $0) } }
        var parked: [ParkedWindow] = []
        var problems: [String] = []
        for target in frames {
            guard let (win, current) = known.first(where: { Self.near($0.1, target) }) else {
                problems.append("有一扇 AX 对不上")
                continue
            }
            guard let destination = ActivationSense.parkOrigin(size: current.size, displays: displays) else {
                problems.append("找不到不压别的屏的角")
                continue
            }
            var point = destination
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &point)!)
            let landed = frame(of: win) ?? CGRect(origin: destination, size: current.size)
            parked.append(ParkedWindow(original: current, parkedAt: landed.origin))
            // 被系统挪回屏内(不许挪那么远):照记(藏好后照样挪回),但说出来 —— 这时遮罩一收它还会露一下。
            if ActivationSense.exposedArea(landed, displays: displays) > current.width * current.height * 0.01 {
                problems.append("挪完还露着(系统把它挪回了屏内)")
            }
        }
        return (parked, problems.isEmpty ? nil : problems.joined(separator: ";"))
    }

    /// 藏好之后把挪走的窗挪回原位(按挪到的位置认窗)。藏着挪,人看不见;下次它被放出来(点标签、下一次截图)还在原位。
    /// 藏着的应用 AX 可能读不到它的窗 —— 读不到就如实说,调用方下次它被放出来 / 被叫到前面时再挪。
    /// 回没挪回来的那几扇(调用方记着,下次它被叫到前面时再挪)。
    func unpark(_ bundleId: String, _ parked: [ParkedWindow]) -> (missed: [ParkedWindow], error: String?) {
        guard !parked.isEmpty else { return ([], nil) }
        // 应用已经退了:窗也没了,不用再挪(它下次开会用自己记的位置 —— 挪走时要是退了,那个位置可能在角上,摆进窗位时会摆回来)。
        guard let app = runningApp(bundleId) else { return ([], "应用已经退了") }
        let wins = axWindows(app.processIdentifier)
        guard !wins.isEmpty else { return (parked, "AX 读不到它的窗") }
        let known = wins.compactMap { win in frame(of: win).map { (win, $0) } }
        var missed: [ParkedWindow] = []
        for one in parked {
            guard let (win, _) = known.first(where: {
                abs($0.1.minX - one.parkedAt.x) <= 4 && abs($0.1.minY - one.parkedAt.y) <= 4
                    && abs($0.1.width - one.original.width) <= 4 && abs($0.1.height - one.original.height) <= 4
            }) else {
                missed.append(one)
                continue
            }
            var point = one.original.origin
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &point)!)
        }
        // 挪回原位那一下的回声也别报;没挪回来的还在屏外,接着压到下次挪回。
        holdMoveEvents(bundleId, for: missed.isEmpty ? 1.5 : 60)
        return (missed, missed.isEmpty ? nil : "有 \(missed.count) 扇没找到")
    }

    private static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 4 && abs(a.minY - b.minY) <= 4 && abs(a.width - b.width) <= 4 && abs(a.height - b.height) <= 4
    }

    func hide(_ bundleId: String) -> [String: Any] {
        guard let app = runningApp(bundleId) else { return ["ok": true, "result": [String: Any]()] }
        app.hide()
        return ["ok": true, "result": [String: Any]()]
    }

    func unhide(_ bundleId: String) -> [String: Any] {
        guard let app = runningApp(bundleId) else { return ["ok": false, "error": "应用未在运行:\(bundleId)"] }
        app.unhide()
        return ["ok": true, "result": [String: Any]()]
    }

    // MARK: - 拖动落定事件(窗位叠 v2 Task 1,V8 已批的事件型 AX 观察;A2c 起观察范围改为全量)

    /// 这个应用该不该被观察(A2c):只看它是不是一个常规界面应用,不看服务端认不认识它——
    /// 认领判定(是否落进槽位矩形)全在服务端,这里没必要提前收窄。跳过自己(工作台本身
    /// 不是"可被拖进窗位"的候选)。
    private func shouldObserve(_ app: NSRunningApplication) -> Bool {
        guard app.activationPolicy == .regular else { return false }
        guard let bundleId = app.bundleIdentifier, bundleId != ownBundleId else { return false }
        return true
    }

    /// 对"当前所有常规界面应用"补挂 AXObserver,不再在的应用拆观察者。
    ///
    /// 返回本次尝试补挂但失败的 bundle id(I4,spec §6 第三条):调用方把这份清单原样回给
    /// 服务端,让 dockService 写一条"这些应用不支持拖拽认领"的 note——挂载失败不该只在
    /// 这里 NSLog 一声就完事,那样 Ben 永远不知道为什么某个应用拖进窗位没反应。
    @discardableResult
    private func attachAllRunning() -> [String] {
        let running = NSWorkspace.shared.runningApplications.filter(shouldObserve)
        let currentBundleIds = Set(running.compactMap { $0.bundleIdentifier })
        for (bundleId, watch) in watches where !currentBundleIds.contains(bundleId) {
            teardown(watch)
            watches.removeValue(forKey: bundleId)
        }
        // F1(review,真机截图实证):辅助功能未授权时,AXObserverCreate/AXObserverAddNotification
        // 对"所有"应用都会失败——这不是"这些应用不支持拖拽认领",是权限缺口本身,不是应用
        // 兼容性问题。启动早期(Ben 还没点完系统授权弹窗)第一次 attachAllRunning() 常常
        // 撞上这个窗口,把当时枚举到的一整批应用错误地报成"挂载失败";服务端那一侧写了一条
        // note,授权完成后哪怕重挂全部成功,这条陈旧 note 也不会自动消失(服务端 dock.ts
        // 那一半的修复见 ts 提交)。这里从根上掐断:未授权时依然尝试挂载(万一授权状态在
        // 检查瞬间之后就变了,不假设它一定失败),但不把失败计入返回清单——避免一整批
        // 权限缺口噪音报给服务端。
        let trusted = AXIsProcessTrusted()
        var failed: [String] = []
        for app in running {
            guard let bundleId = app.bundleIdentifier, watches[bundleId] == nil else { continue }
            if !attachObserver(bundleId: bundleId, pid: app.processIdentifier), trusted {
                failed.append(bundleId)
            }
        }
        return failed
    }

    /// AppDelegate 启动时调用一次:先把当前已经在跑的常规应用全部挂上,不等服务端第一次
    /// 下发 observe——壳应该自己就知道该看哪些应用,服务端的 observe 只是兼容旧协议的
    /// 一次"确认"(见下面 startObserving 的注释)。
    @discardableResult
    func attachToCurrentApps() -> [String] {
        attachAllRunning()
    }

    /// 服务端 observe 请求的处理入口。A2c 修订:bundleIds 参数不再决定观察范围(签名保留
    /// 只为兼容 HelperSocket 现有的调用/协议,回执仍然是 {ok:true, result:{failed:[...]}}),
    /// 挂载范围统一改走 attachAllRunning()——名单制会挡住服务端还不认识的应用,几何判定
    /// (是否落进槽位矩形)已经在服务端把噪声滤掉了。
    @discardableResult
    func startObserving(bundleIds: [String], onSettled: @escaping (String, CGRect, Bool, Bool) -> Void) -> [String] {
        self.onSettled = onSettled
        startDragFallback()
        return attachAllRunning()
    }

    /// AppDelegate 转发的 NSWorkspace 启动通知——任何新起的常规应用都补挂,不再看名单。
    func handleAppLaunched(_ app: NSRunningApplication) {
        guard shouldObserve(app), let bundleId = app.bundleIdentifier, watches[bundleId] == nil else { return }
        if attachObserver(bundleId: bundleId, pid: app.processIdentifier) { return }
        // I4:单次重试(非轮询,V8 只放行事件型 AX 观察——这里不是轮询等它就绪,是应用刚
        // 启动那一刻 AX 树可能还没搭好,补一次时间余量再试一遍;1s 后仍失败就放弃,不再重试,
        // 不能让"重试"退化成变相轮询)。重试前重新核对状态:这 1 秒里应用可能已经退出、
        // 或已经被别的路径(比如又一次 observe 下发)挂上了。
        // S1 续:重试直接再调一次 attachObserver,唤醒属性(AXManualAccessibility)写在
        // 那个函数最开头,天然会在这次重试里重新设置一遍——不用在这里另外重复写一次;
        // 唤醒信号本身可能要一拍才生效,这 1s 延迟同时也给它留出了这个余量。
        let pid = app.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self,
                  self.shouldObserve(app),
                  self.watches[bundleId] == nil,
                  self.runningApp(bundleId)?.processIdentifier == pid else { return }
            self.attachObserver(bundleId: bundleId, pid: pid)
        }
    }

    /// AppDelegate 转发的 NSWorkspace 退出通知——应用退出后它的 AXUIElement 全部失效,
    /// 必须清掉 observer 和还没落定的定时器,不然回调可能打在已经没有意义的引用上。
    func handleAppTerminated(_ app: NSRunningApplication) {
        guard let bundleId = app.bundleIdentifier, let watch = watches[bundleId] else { return }
        teardown(watch)
        watches.removeValue(forKey: bundleId)
    }

    /// AppDelegate 转发的 NSWorkspace 激活通知(1a)。WHY:老进程对 Chromium 系应用的
    /// 观察者会静默坏死——挂载成功不代表事件还会来(参见 attachObserver 顶上 S1 那段
    /// 真机实证,那次只解决了"挂不挂得上",没解决"挂上之后途中睡死")。激活=用户即将
    /// 交互(拖拽必先点击),此刻还没有任何拖拽在飞,是重挂的安全窗口:无条件拆旧重挂,
    /// 让观察者在拖拽落定前恢复新鲜。
    ///
    /// "重挂无害"这条论证的范围仅限于这里——激活这一刻确实不可能有正在飞的 300ms
    /// 落定定时器被误伤,几毫秒的 teardown+attach 对健康应用不痛不痒。它**不能**推广到
    /// `checkStaleAndReport` 那条 2s 延迟补挂路径:那条路径醒来的时刻和"用户刚点了一下"
    /// 没有任何时序关系,补挂前必须自己单独核实同一前提是否仍然成立(见那边的 WHY)。
    ///
    /// 终审必修4(对称补 checkStaleAndReport 已有的那道守卫):若这个 bundle 当前
    /// `watch.windows` 非空,说明有 moved/resized 事件正在被追踪、300ms 落定定时器还没
    /// 到期(比如"拖拽刚松手后 300ms 内切走又切回")——事件在流动本身就是"观察者没有
    /// 坏死"的证据,上面那句"激活这一刻不可能有飞行中的定时器"其实并不总成立(切出去
    /// 又切回来就是反例)。此时无条件 teardown 会把这个真实存在的落定定时器直接 cancel
    /// 掉,这次拖拽的落定上报就永久丢了——论证与 checkStaleAndReport 那条 2s 补挂路径
    /// 完全同源(见那边 WHY),这里必须同样核实,不能因为"激活路径一般更安全"就省掉。
    ///
    /// 终审必修1(重挂失败本身就是 stale 证据):老版本这里 `guard reattachObserver(...)
    /// else { return }` 静默 return——重挂失败时旧观察者已经被 teardown 拆掉、新的没挂
    /// 上,这个应用此刻是零观察者,且没有任何别的路径会再补挂它,观测环对"attach 失败"
    /// 这一已实证的主要老化形态(真机上 Chromium 系应用的 AX 服务懒启动,唤醒信号不保证
    /// 立即生效)完全失明。改为:重挂失败时把它当 stale 命中处理——上报一次 onAxStale
    /// (ax_err 用 -1 这个哨兵值,专指"attach 这一步本身失败",不是某次
    /// AXUIElementCopyAttributeValue 返回的真实 AXError,服务端那一侧据此能把这两种不同
    /// 的坏死形态区分开;ax_count/cg_count 仍然照常现测,不因为 attach 失败就连这两个
    /// 诊断数字也放弃),再复用 `scheduleStaleRetry`——跟 checkStaleAndReport 的 2s 单次
    /// 补挂共用同一份代码,同一套 generation/pid/windows 三道并发守卫,不重写一份容易漏掉
    /// 某道守卫的重复逻辑。
    ///
    /// 闸门(先例 F1,attachAllRunning 顶上那段真机截图实证):辅助功能未授权时,
    /// AXObserverCreate/AXObserverAddNotification 对"所有"应用都会失败——这不是"这个应用
    /// 的观察者老化了",是权限缺口本身。不加这道闸门,Ben 还没点完系统授权弹窗那段时间里
    /// 每切一次应用都会误报一条 ax_stale,把真正的老化信号淹没在权限噪音里。跟 F1 同一个
    /// 取舍:依然尝试重挂(万一授权状态在检查瞬间之后就变了),只是不把失败当证据上报。
    func handleAppActivated(_ app: NSRunningApplication) {
        guard shouldObserve(app), let bundleId = app.bundleIdentifier else { return }
        let pid = app.processIdentifier
        if let watch = watches[bundleId], !watch.windows.isEmpty { return }
        guard reattachObserver(bundleId: bundleId, pid: pid) else {
            guard AXIsProcessTrusted() else { return }
            let raw = axWindowsRaw(pid)
            let cgCount = cgWindowCount(pid)
            NSLog("WindowControl: 激活重挂失败(视为 stale)bundle=\(bundleId) axCount=\(raw.count) cgCount=\(cgCount)")
            onAxStale?(bundleId, -1, raw.count, cgCount)
            let myGeneration = generation[bundleId] ?? 0
            scheduleStaleRetry(bundleId: bundleId, pid: pid, generation: myGeneration)
            return
        }
        let gen = generation[bundleId] ?? 0
        checkStaleAndReport(bundleId: bundleId, pid: pid, generation: gen, retry: true)
    }

    // MARK: - 休眠/坏死检测(ax_stale,1b)

    /// fresh AXUIElementCreateApplication 读 kAXWindowsAttribute 的原始结果——ax_stale
    /// 判定和 ax_probe 诊断都要用原始 AXError rawValue,不能复用 axWindows()(那个函数
    /// 把失败吞成空数组,诊断时恰恰需要知道具体是哪种失败)。
    private func axWindowsRaw(_ pid: pid_t) -> (err: Int32, count: Int) {
        let appEl = appElement(pid)
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &value)
        let count = (value as? [AXUIElement])?.count ?? 0
        return (err.rawValue, count)
    }

    /// CGWindowList 不走 AX 通道、不受坏死影响,是"窗口明明在屏上"的真相源(1b WHY)。
    /// .optionOnScreenOnly 排掉不在屏上的窗口,.excludeDesktopElements 排掉桌面图标层,
    /// kCGWindowLayer == 0 是普通应用窗口层(菜单栏/浮动面板层号不是 0),只数这些才是
    /// 跟 AX 标准窗口口径对得上的比较基准。
    private func cgWindowCount(_ pid: pid_t) -> Int {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return 0
        }
        return list.filter { entry in
            (entry[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
            (entry[kCGWindowLayer as String] as? Int) == 0
        }.count
    }

    /// 重挂后立刻测一次这次挂载是不是形同虚设。axErr!=0 是挂载/读取本身在报错;
    /// axCount==0 && cgCount>0 是更隐蔽的坏死——AX 通道说"没有窗口",CGWindowList(见上)
    /// 说屏幕上明明有,两者任一命中都判 stale。
    ///
    /// `generation` 是调用方在自己那次 reattachObserver 成功后立刻读到的代号,只用来给
    /// 2s 后的延迟补挂闭包校验"我排队等待的这段时间里,是不是已经有更新的一次重挂发生
    /// 过了"——不是这个函数自己维护的状态。
    ///
    /// retry=true 时命中会再补一次 2s 后的单次复检:V8 纪律边界写在这里——这不是给
    /// "迟迟不醒"的应用兜底轮询,只是给刚才那次重挂多留一拍时间余量,复检仍 stale 也
    /// 只再上报这一次,不再继续、不再排下一轮。补挂闭包本身的两道放弃条件见下面
    /// `scheduleStaleRetry` 的注释。
    private func checkStaleAndReport(bundleId: String, pid: pid_t, generation myGeneration: Int, retry: Bool) {
        let raw = axWindowsRaw(pid)
        let cgCount = cgWindowCount(pid)
        let stale = raw.err != 0 || (raw.count == 0 && cgCount > 0)
        guard stale else { return }
        NSLog("WindowControl: ax_stale 命中 bundle=\(bundleId) axErr=\(raw.err) axCount=\(raw.count) cgCount=\(cgCount)")
        onAxStale?(bundleId, Int(raw.err), raw.count, cgCount)
        guard retry else { return }
        scheduleStaleRetry(bundleId: bundleId, pid: pid, generation: myGeneration)
    }

    /// 2s 单次补挂闭包(从 checkStaleAndReport 抽出,终审必修1):供 checkStaleAndReport
    /// 自己的 retry 分支、以及 handleAppActivated 的"重挂失败即 stale"分支共用同一套
    /// 守卫逻辑——两条路径醒来/触发的时刻都跟"用户刚点了一下"没有必然的时序关系,补挂前
    /// 必须重新核实同一批前提,拆成独立函数是为了让两处调用方共享同一份实现,不是各自
    /// 维护一份容易在某一处漏掉某道守卫的重复代码。
    ///
    /// 两道独立的放弃条件(review,2026-08-25 两处并发缺陷修复,原文保留):
    /// 1) generation 不再是排队时那一代——这 2s 内已经有别的路径(更晚一次激活、
    ///    ax_probe 手动 reattach…)重新挂过了,现在的 watch 早就不是当初触发这次检测
    ///    的那一个,继续动手是对着已经过时的状态重复劳动。
    /// 2) `watches[bundleId]?.windows` 非空——这一刻还有 moved/resized 事件正在被追踪、
    ///    300ms 落定定时器还没到期,说明观察者根本没有坏死,此时无条件 teardown 会把这个
    ///    真实存在的落定定时器直接 cancel 掉,这次拖拽的落定上报就永久丢了。
    /// 两道检查都通过才真正补挂,补挂前仍按 handleAppLaunched 的惯例重新核对应用还在跑、
    /// pid 未变。补挂成功后再跑一次不带 retry 的 checkStaleAndReport,只为了如实记录
    /// "补挂之后现在还 stale 不 stale",不会再排下一轮——V8 纪律边界:这不是给"迟迟不醒"
    /// 的应用兜底轮询。
    private func scheduleStaleRetry(bundleId: String, pid: pid_t, generation myGeneration: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.generation[bundleId] == myGeneration else { return }
            if let watch = self.watches[bundleId], !watch.windows.isEmpty { return }
            guard let app = self.runningApp(bundleId),
                  self.shouldObserve(app),
                  app.processIdentifier == pid else { return }
            guard self.reattachObserver(bundleId: bundleId, pid: pid) else { return }
            let newGeneration = self.generation[bundleId] ?? 0
            self.checkStaleAndReport(bundleId: bundleId, pid: pid, generation: newGeneration, retry: false)
        }
    }

    // MARK: - 拖动悬停进出圈信号(悬停高亮 v1)

    /// 设置/清除悬停圈。rect=nil 是清除:页面 1s 轮询报不了实时拖拽状态,悬停高亮完全
    /// 靠服务端在矩形已知时推一次这个圈、矩形失效(槽位隐藏/日历借位,见 I3)时推 nil。
    /// 清除时必须把所有正在追踪中的窗口的悬停态清零——曾经 inside 的窗口要补发一次
    /// inside:false,不然页面会在圈已经不存在之后还留着高亮(认领流程本会靠 snapshot
    /// 重绘覆盖掉,但这里不指望它兜底)。设新圈(非 nil)不重置——按 spec 只在"落定"或
    /// "清除"这两个时机重置,矩形微调(跟随重贴那种)留给下一次真实 AX 移动事件自然刷新。
    func setHoverZone(_ rect: CGRect?, onHover: @escaping (Bool) -> Void) {
        hoverZone = rect
        self.onHover = onHover
        if rect == nil {
            resetAllHoverTracking()
        }
    }

    private func resetAllHoverTracking() {
        for (_, watch) in watches {
            for idx in watch.windows.indices where watch.windows[idx].hoverInside {
                watch.windows[idx].hoverInside = false
                onHover?(false)
            }
        }
    }

    /// 挂一个应用的 AXObserver。返回是否挂成功(I4):AXObserverCreate/AXObserverAddNotification
    /// 任一步失败都如实 NSLog 一条并回 false——调用方据此把失败名单报给服务端,不是吞掉
    /// 假装订阅上了。
    ///
    /// S1(review 复核确认,第一轮):失败路径(两处 guard)都在写 `watches[bundleId]` 之前
    /// return,从来不会给失败的 bundle 在 `watches` 里留半条记录——`attachAllRunning()` 的
    /// `watches[bundleId] == nil` 判断因此总能在下一次调用时把它当"还没挂上"重新尝试,
    /// 不存在"死挂载占着位置、永远不会再被 retry"这回事。授权状态翻转的那一刻主动触发
    /// attachAllRunning() 这条修复(见 HelperSocket.updateAuthorized)确实堵住了一个真实
    /// 缺口,但真机复测后 attach 对这几家应用依然失败——第一轮诊断没找全根因。
    ///
    /// S1 续(真机实证,第二轮):ChatGPT/Claude/企业微信/微信都是 Chromium 系(Electron 或
    /// 类似技术栈)客户端。这类应用的辅助功能(AX)服务是懒启动的——没有辅助客户端主动
    /// "敲门"过,底层的 AX 树/事件桥根本没起来,`AXObserverAddNotification` 对着一个还没
    /// 醒的 AX 服务自然失败。证据链吻合:这几家只在"刚启动"那个窗口内(走 handleAppLaunched
    /// 的首次挂载)能挂上,常驻一段时间后(走 attachAllRunning 的重试)必败;每次重启壳所在
    /// 应用（比如微信）之后又能立刻挂上一次——不是权限问题(appInfo/setWindowFrame 走的是
    /// 另一套 AX 调用,一直正常,切换/贴合从没受影响),是"这个应用的 AX 服务这一刻醒着没醒"
    /// 的问题。挂观察者前先摸一下 `AXManualAccessibility`——这是苹果给 Chromium 系应用
    /// 定义的"辅助功能客户端在场"信号,写它一下会触发对方唤醒 AX 服务;原生应用没有这个
    /// 属性,`AXUIElementSetAttributeValue` 会报错但完全无害(忽略返回值)。
    /// 只加 `AXManualAccessibility`,不加 `AXEnhancedUserInterface`(review 明确要求):
    /// 后者是另一个更强的"进入辅助模式"开关,已知会让某些应用悄悄改变自己的窗口尺寸/
    /// 布局策略(对窗口管理器是已知副作用)——这个壳本来就要靠 `set_window_frame` 摆窗口,
    /// 两者一起用有互相踩踏的风险,没有证据表明只用 `AXManualAccessibility` 不够,所以
    /// 先不加,留一句注释说明这是刻意的取舍而不是漏加。
    @discardableResult
    private func attachObserver(bundleId: String, pid: pid_t) -> Bool {
        let appEl = appElement(pid)
        // 顺序很重要:必须先唤醒再挂观察者——Chromium 系应用的 AX 服务闲置时挂观察者必败,
        // 唤醒信号本身不保证立即生效(见下面 handleAppLaunched 的 1s 延迟重试),但至少给了
        // 它一个机会。返回值不检查:原生应用压根没有这个属性,报错是预期内的噪音。
        AXWake.knock(appEl)
        var observerRef: AXObserver?
        guard AXObserverCreate(pid, axObserverCallback, &observerRef) == .success,
              let observer = observerRef else {
            NSLog("WindowControl: AXObserverCreate 失败,bundle=\(bundleId)")
            axDead.insert(bundleId)
            return false
        }
        let context = AXObserverContext(control: self, bundleId: bundleId)
        let refcon = Unmanaged.passRetained(context).toOpaque()
        let movedResult = AXObserverAddNotification(observer, appEl, kAXWindowMovedNotification as CFString, refcon)
        let resizedResult = AXObserverAddNotification(observer, appEl, kAXWindowResizedNotification as CFString, refcon)
        guard movedResult == .success, resizedResult == .success else {
            NSLog("WindowControl: AXObserverAddNotification 失败,bundle=\(bundleId) moved=\(movedResult.rawValue) resized=\(resizedResult.rawValue)")
            Unmanaged<AXObserverContext>.fromOpaque(refcon).release()
            axDead.insert(bundleId)
            return false
        }
        // 加到主 RunLoop:回调因此在主线程触发,后面去抖定时器可以直接排 DispatchQueue.main
        // 而不必再切线程。
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        watches[bundleId] = AppWatch(pid: pid, observer: observer, contextRef: refcon)
        // 挂上了 = AX 这条链对这个应用是活的,从兜底名单里退出来(唤醒信号一拍之后才生效
        // 那种情形就是走这里回来的)。名单不是"一次失败判死刑",是"此刻 AX 给不出东西"。
        axDead.remove(bundleId)
        return true
    }

    /// 应用退出或被移出观察名单时的清理:撤销 run loop source、撤销通知订阅、
    /// 取消所有未落定的去抖定时器、释放 refcon 的强引用——四样缺一样都会漏东西
    /// (漏释放 refcon 会泄漏那个小盒子;漏撤 run loop source 则是给已经无效的
    /// observer 留了个僵尸订阅)。悬停高亮 v1:退出前先把这个应用名下所有 inside 的
    /// 窗口清一遍(应用中途被杀/被移出观察名单不该留着一份追不回来的高亮)。
    private func teardown(_ watch: AppWatch) {
        for idx in watch.windows.indices where watch.windows[idx].hoverInside {
            onHover?(false)
        }
        for w in watch.windows { w.settleTimer.cancel() }
        let appEl = appElement(watch.pid)
        AXObserverRemoveNotification(watch.observer, appEl, kAXWindowMovedNotification as CFString)
        AXObserverRemoveNotification(watch.observer, appEl, kAXWindowResizedNotification as CFString)
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(watch.observer), .defaultMode)
        Unmanaged<AXObserverContext>.fromOpaque(watch.contextRef).release()
    }

    /// 拆旧重挂,供 handleAppActivated(1a)和 axProbe("reattach",1c)共用同一套逻辑。
    /// 拆旧必须走 teardown()(释放 refcon、撤 run loop source、取消未落定定时器),不能
    /// 只删 `watches` 字典项——那样会漏撤订阅、漏释放小盒子。返回本次挂载是否成功。
    ///
    /// generation 计数在这里无条件递增(不管这次挂载最终成不成功)——它标记的是"这个
    /// bundle 最近一次被谁动过手",不是"挂载成功次数"。任何一条正在排队等待的延迟补挂
    /// (见 checkStaleAndReport)据此就能判断自己是不是已经被更晚的一次重挂盖过了。
    @discardableResult
    private func reattachObserver(bundleId: String, pid: pid_t) -> Bool {
        generation[bundleId, default: 0] += 1
        if let watch = watches[bundleId] {
            teardown(watch)
            watches.removeValue(forKey: bundleId)
        }
        let attached = attachObserver(bundleId: bundleId, pid: pid)
        NSLog("WindowControl: 重挂 bundle=\(bundleId) 成功=\(attached)")
        return attached
    }

    /// AXObserver 回调转发到这里(已经在主线程)。每次 moved/resized 事件都重置该窗口
    /// 自己的 300ms 定时器——事件驱动的去抖,不是轮询;定时器到期没被打断才算"落定"。
    ///
    /// 悬停高亮 v1 也挂在这个"原始"回调上,在 300ms 落定去抖**之前**:页面 1s 轮询做不了
    /// 拖拽悬停这种实时反馈,只能靠事件驱动的进出圈瞬间推送,不能等落定才报——那时用户
    /// 早就看不到反馈了。updateHover 内部只在跳变时才发消息,天然节流,不是逐帧上报
    /// (V8 合规:仍是"事件叫醒才做事",不是新开一条轮询)。
    fileprivate func handleAXEvent(bundleId: String, notification: String, window: AXUIElement) {
        // 1d:回调计数器,事件回调本体不打 NSLog(拖拽风暴刷屏),靠这份计数在 ax_probe
        // "counters" 里看回调到底有没有在响。
        eventCounts["\(bundleId)/\(notification)", default: 0] += 1
        guard let watch = watches[bundleId] else { return }
        // dragged 采样(2026-08-26 微信重登归位修复):回调本来就在主线程,顺手读一次全局
        // 左键状态(bit0)。事件风暴里任何一次按着=用户在拖;程序化移动(应用自己摆窗)
        // 全程没有。不需要权限,也不是轮询——只在 AX 事件叫醒时读。
        let mouseDown = (NSEvent.pressedMouseButtons & 1) != 0
        if let idx = watch.windows.firstIndex(where: { CFEqual($0.window, window) }) {
            watch.windows[idx].settleTimer.cancel()
            let item = DispatchWorkItem { [weak self] in self?.settle(bundleId: bundleId, window: window) }
            watch.windows[idx].settleTimer = item
            watch.windows[idx].dragged = watch.windows[idx].dragged || mouseDown
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: item)
            updateHover(bundleId: bundleId, idx: idx, window: window, pressed: mouseDown)
        } else {
            let item = DispatchWorkItem { [weak self] in self?.settle(bundleId: bundleId, window: window) }
            watch.windows.append(WatchedWindow(window: window, settleTimer: item, dragged: mouseDown))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: item)
            updateHover(bundleId: bundleId, idx: watch.windows.count - 1, window: window, pressed: mouseDown)
        }
    }

    /// 悬停圈进出判定:窗口当前帧的中心点落没落在圈里,只在这扇窗口自己的判定结果
    /// 真的翻转那一刻才发消息——不是每次 AX 事件都发,避免拖动全程刷屏。
    private func updateHover(bundleId: String, idx: Int, window: AXUIElement, pressed: Bool) {
        guard hoverZone != nil, let watch = watches[bundleId], !movesHeld(bundleId) else { return }
        guard let f = frame(of: window) else { return }
        // 只有他在拖(左键按着)才算进圈 —— 程序化挪窗不报(卡 P,见 DragTracker.hovering)。
        let inside = DragTracker.hovering(f, zone: hoverZone, pressed: pressed)
        guard watch.windows[idx].hoverInside != inside else { return }
        watch.windows[idx].hoverInside = inside
        onHover?(inside)
    }

    /// 300ms 无新事件,判定"落定"。落定后只按标准窗过滤规则(参见 standardWindows 顶部
    /// 那段真机踩坑记录)确认这确实是个真窗口才上报——幽灵窗产生的 moved 事件不值得
    /// 告诉服务端"用户在拖它"。
    ///
    /// 悬停高亮 v1:落定这一刻就该把这扇窗口的悬停追踪清零——它已经不再"正在被拖动"了,
    /// 曾经 inside 的话补发一次 inside:false,不然认领/整理流程跑完之后页面还留着高亮
    /// (认领会靠 snapshot 重绘覆盖掉,但这里不指望它兜底,拖出窗位/整理不重新认领的分支
    /// 未必会触发 snapshot 刷新悬停态)。
    private func settle(bundleId: String, window: AXUIElement) {
        guard let watch = watches[bundleId] else { return }
        // dragged 要在条目被移除之前取出。条目意外缺失时缺省按 true(=用户拖拽):那是
        // 服务端行为完全不变的保守口径,拿不准就不把一扇窗判成"程序化移动"去自动归位。
        var dragged = true
        if let idx = watch.windows.firstIndex(where: { CFEqual($0.window, window) }) {
            dragged = watch.windows[idx].dragged
            if watch.windows[idx].hoverInside { onHover?(false) }
        }
        watch.windows.removeAll { CFEqual($0.window, window) }
        guard standardWindows(watch.pid).contains(where: { CFEqual($0, window) }) else { return }
        guard let f = frame(of: window) else { return }
        // pressed(2026-09-18):落定**这一刻**左键还按着没有。跟 dragged 是两条独立证据——
        // dragged 只在 AX 事件回调里采样,事件风暴起得比按键晚的那一拍(应用第一帧 moved
        // 迟到、壳刚重挂完观察者)它就是 false;这一读与事件时序无关。同样不是轮询:落定
        // 本来就只发生一次,顺手读一次全局左键状态。
        let pressed = (NSEvent.pressedMouseButtons & 1) != 0
        // 我们自己挪的(遮罩底下挪开 / 藏好后挪回):不报。他这会儿按着左键多半是在框选截图,不是在拖这扇窗。
        if movesHeld(bundleId) {
            NSLog("WindowControl: 自己挪的窗,落定不上报 bundle=\(bundleId) frame=\(f)")
            return
        }
        NSLog("WindowControl: 落定上报 bundle=\(bundleId) frame=\(f) dragged=\(dragged) pressed=\(pressed)")
        onSettled?(bundleId, f, dragged, pressed)
    }

    // MARK: - CG 兜底链(2026-09-18 Claude/企微拖不进窗位)

    /// 全局左键监听器的句柄(nil = 还没装)。装一次就一直在,不随观察者重挂而反复拆装。
    private var dragMonitor: Any?
    /// 兜底跟踪状态机(纯逻辑在 DragSense.swift,这里只喂快照)。
    private var dragTracker = DragTracker()
    /// 上一次读 CGWindowList 的时刻(闸门见 DRAG_SAMPLE_INTERVAL)。
    private var lastDragSample: TimeInterval = 0
    /// 拖动过程中两次读窗口列表的最小间隔。
    ///
    /// V8 纪律(只放行事件型观察,不开轮询)在这条链上的边界写在这里:**唤醒它的是鼠标
    /// 拖动事件本身,不是定时器** —— 没有人在拖窗口时这条链一次系统调用都不发生。100ms
    /// 是给 `.leftMouseDragged` 那 60~120Hz 的事件流加的闸,免得每一帧都去读一次窗口列表;
    /// 它只会让采样**变少**,不会在没有事件时把自己叫醒。
    private static let dragSampleInterval: TimeInterval = 0.1

    /// 装上全局左键监听。
    ///
    /// 为什么非它不可:AX 对 Claude / 企业微信这类应用回 `kAXErrorAPIDisabled`(真机取证见
    /// DragSense.swift 顶部),**一条 moved 事件都不会来**,壳对"用户正在拖这扇窗"完全失明。
    /// 鼠标事件不走 AX 通道,是这两家还剩下的唯一入口。
    ///
    /// 全局监听器需要辅助功能授权(壳本来就要),**只读不改**:`addGlobalMonitorForEvents`
    /// 拿不到别的应用的事件内容也改不了它们,只是被叫醒一下(这也是没用 CGEventTap 的原因——
    /// 那个能改能吞事件,权限面大得多,这里不需要)。
    private func startDragFallback() {
        guard dragMonitor == nil else { return }
        dragMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self else { return }
            switch event.type {
            case .leftMouseDown: self.dragBegan()
            case .leftMouseDragged: self.dragSampled()
            case .leftMouseUp: self.dragEnded()
            default: break
            }
        }
    }

    /// 此刻屏上的窗口快照(前后序,最前面那扇排第一)——不走 AX,这是 AX 死掉的应用身上
    /// 唯一还能问出"窗口在哪儿"的地方。
    ///
    /// 过滤口径与 `cgWindowCount` 一致(`kCGWindowLayer == 0` 才是普通应用窗口层),另外
    /// 跳过壳自己(工作台不是可被拖进窗位的候选,同 `shouldObserve`)。取不到 bundle id 的
    /// 进程直接丢掉:服务端整条认领链都以 bundle id 为身份,没有它这条记录没有用。
    private func screenWindows() -> [ScreenWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var bundleCache: [pid_t: String?] = [:]
        return list.compactMap { entry -> ScreenWindow? in
            guard (entry[kCGWindowLayer as String] as? Int) == 0,
                  let pid = (entry[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) }),
                  let number = entry[kCGWindowNumber as String] as? Int,
                  let bounds = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            let bundleId: String?
            if let cached = bundleCache[pid] { bundleId = cached }
            else {
                let resolved = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
                bundleCache[pid] = resolved
                bundleId = resolved
            }
            guard let bundleId, bundleId != ownBundleId else { return nil }
            return ScreenWindow(bundleId: bundleId, windowNumber: number, frame: rect)
        }
    }

    /// 光标此刻在哪儿。用 `CGEvent().location` 而不是 `NSEvent.mouseLocation`:前者本来就是
    /// AX/CGWindowList 那套全局坐标(主屏左上原点、y 向下),后者是 AppKit 的 y 向上坐标,
    /// 换算过来要靠主屏高度——全链只用一套坐标,就没有换算错的余地(同 DragSense 顶上那段)。
    private func cursorPoint() -> CGPoint? {
        CGEvent(source: nil)?.location
    }

    private func dragBegan() {
        let point = cursorPoint() ?? .zero
        let windows = screenWindows()
        lastDragSample = Date().timeIntervalSince1970
        // 先把名单取出来再进 begin:begin 是 mutating,闭包里再回头读 self 的另一个属性
        // 纯属给独占访问检查找麻烦,没有任何好处。
        let dead = axDead
        _ = dragTracker.begin(at: point, windows: windows, zone: hoverZone) { dead.contains($0) }
        guard let tracked = dragTracker.tracked else { return }
        NSLog("WindowControl: CG 兜底开始跟踪 bundle=\(tracked.bundleId) window=\(tracked.windowNumber)")
        // 顺手敲一次门:AX 睡着的应用,这一拖少说一两秒,**够它醒过来**——醒了之后
        // set_window_frame(贴合进槽位)才做得成,不然就算认领成功,窗口也不会动。
        // 只在 AX 确实没挂上时敲(watches 里没有它),健康的应用不碰。
        if watches[tracked.bundleId] == nil, let app = runningApp(tracked.bundleId) {
            reattachObserver(bundleId: tracked.bundleId, pid: app.processIdentifier)
        }
    }

    private func dragSampled() {
        guard dragTracker.tracked != nil else { return }
        let now = Date().timeIntervalSince1970
        guard now - lastDragSample >= WindowControl.dragSampleInterval else { return }
        lastDragSample = now
        emit(dragTracker.sample(windows: screenWindows(), zone: hoverZone))
    }

    private func dragEnded() {
        guard let tracked = dragTracker.tracked else { return }
        // AX 在这次拖拽途中醒过来了(上面那次敲门生效)——那边的 300ms 落定会照常上报,
        // 这条兜底就闭嘴,免得同一次拖拽报两遍。悬停态仍然要清(不留追不回来的高亮)。
        let axAlive = watches[tracked.bundleId] != nil
        let events = dragTracker.end(windows: screenWindows(), zone: hoverZone)
        emit(axAlive ? events.filter { if case .settled = $0 { return false } else { return true } } : events)
    }

    private func emit(_ events: [DragEvent]) {
        for event in events {
            switch event {
            case .hover(let inside):
                onHover?(inside)
            case .settled(let bundleId, let frame):
                if movesHeld(bundleId) { continue } // 我们自己挪的窗(卡 P 补二):不当成他拖进来的
                // dragged=true 是**实话**:走到这里的前提就是"用户按着左键把这扇窗挪动过、
                // 松手时落在圈里",壳是亲眼看着这一串鼠标事件过来的,不是缺省值。
                // pressed=false 也是实话:这一刻左键刚松开。两个字段各说各看见的那一半,
                // 不拿一个"反正服务端只要有一条为真"的凑数值去糊弄下游(D13)。
                NSLog("WindowControl: CG 兜底落定上报 bundle=\(bundleId) frame=\(frame)")
                onSettled?(bundleId, frame, true, false)
            }
        }
    }

    // MARK: - 诊断口(ax_probe,1c)

    /// 纯诊断面,请求驱动,不是事件驱动的一部分——下一次真机自然老化时用它直接量老进程
    /// 的原始错误码,不用再靠猜(参见 attachObserver 顶上的 S1 真机实证记录,那次是靠
    /// 反复重启+试探拼出来的证据链,有这个口以后直接读数字)。
    func axProbe(_ msg: [String: Any]) -> [String: Any] {
        guard let action = msg["action"] as? String else { return ["ok": false, "error": "缺少 action"] }
        switch action {
        case "windows":
            guard let bundleId = msg["bundle_id"] as? String, let app = runningApp(bundleId) else {
                return ["ok": false, "error": "应用未在运行"]
            }
            let raw = axWindowsRaw(app.processIdentifier)
            let cg = cgWindowCount(app.processIdentifier)
            return ["ok": true, "result": ["err": raw.err, "count": raw.count, "cg_count": cg]]
        case "read":
            guard let bundleId = msg["bundle_id"] as? String, let app = runningApp(bundleId),
                  let attr = msg["attr"] as? String else {
                return ["ok": false, "error": "应用未在运行或缺少 attr"]
            }
            let appEl = appElement(app.processIdentifier)
            var value: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(appEl, attr as CFString, &value)
            return ["ok": true, "result": ["err": err.rawValue, "value": axProbeDescribe(value)]]
        case "write":
            guard let bundleId = msg["bundle_id"] as? String, let app = runningApp(bundleId),
                  let attr = msg["attr"] as? String else {
                return ["ok": false, "error": "应用未在运行或缺少 attr"]
            }
            // value 缺省 true——诊断口大多数时候是想"触发唤醒"这一类写 true 就够的场景
            // (比如手动补一次 AXManualAccessibility),不强求调用方每次都填。
            let boolValue = msg["value"] as? Bool ?? true
            let appEl = appElement(app.processIdentifier)
            let err = AXUIElementSetAttributeValue(appEl, attr as CFString, boolValue ? kCFBooleanTrue : kCFBooleanFalse)
            return ["ok": true, "result": ["err": err.rawValue]]
        case "counters":
            return ["ok": true, "result": ["counters": eventCounts]]
        case "reattach":
            guard let bundleId = msg["bundle_id"] as? String, let app = runningApp(bundleId) else {
                return ["ok": false, "error": "应用未在运行"]
            }
            let attached = reattachObserver(bundleId: bundleId, pid: app.processIdentifier)
            return ["ok": true, "result": ["attached": attached]]
        default:
            return ["ok": false, "error": "未知 action:\(action)"]
        }
    }

    /// ax_probe "read" 的取值只处理诊断真正用得上的三种标量(Bool/String/Number)——AX
    /// 属性也可能是 AXUIElement/CFArray 这类复杂类型,那些直接序列化成 JSON 没有意义,
    /// 给个类型描述字符串比硬编码成 null 更诚实(D13)。
    private func axProbeDescribe(_ value: CFTypeRef?) -> Any {
        guard let value else { return "nil" }
        // 终审必修5:`as? Bool` 在 Swift 里对 NSNumber(比如 CFNumber 包的 0/1)也会"桥"成
        // true/false——数值型的 0/1 会被谎报成 false/true,诊断口存在的意义就是给出老实的
        // 原始值,不能连这点都算错。CFGetTypeID 是唯一能分辨"这真的是 CFBoolean"还是
        // "这是个凑巧等于 0/1 的 CFNumber"的办法,必须先判它,再退到 NSNumber 分支。
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((value as! CFBoolean))
        }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n }
        return String(describing: type(of: value))
    }
}
