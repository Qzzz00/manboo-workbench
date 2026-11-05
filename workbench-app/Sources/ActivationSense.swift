import CoreGraphics
import Foundation

/// 「某个应用被叫到前面 / 被放出来」是他要切过去,还是临时叫一下 —— 全部判断在这里(2026-09-25,卡 P)。
///
/// 维护者 09-25 原话:「我习惯用企业微信的截图快捷键,但是在这套系统中,每次使用截图,都会把企业微信
/// 显示出来,预期应该是保持页面不变,这个机制应该对其他有截图能力的 APP 都是一个逻辑,不只是企业微信」。
///
/// ## 真机实测(2026-09-25 16:2x,维护者这台 Mac,只读探针 + 真按快捷键)
///
/// - **企业微信 ⌘⇧A**:企业微信**没有被激活**(最前面的一直是工作台),而是**被放出来**(`didUnhideApplication`),
///   同时每块屏各盖一扇**层级 103、正好铺满那块屏**的遮罩(主屏 2560×1440、竖屏 1440×2560),
///   外加一个跟着鼠标走的 100×18 尺寸标签(同层级)。截完 / 取消后遮罩没了,企业微信**仍然放着**,
///   它摆在窗口槽位置上的主窗(层级 0、1640×868)就盖在窗口槽上 —— 这就是「把企业微信显示出来」。
/// - **系统截图(同 ⌘⇧4 的交互截屏)**:没有任何应用被激活或放出来,也没有可见的遮罩窗 —— 碰不到窗口槽。
///
/// 所以要管的是**两种入口**:「被激活」(⌘Tab、点程序坞、别家的快捷键)和「被放出来却没被激活」(企业微信截图)。
/// 对所有应用同一套判断,不认名字:
///
/// - **临时叫一下**(transient):它最前面那扇**不是普通窗口**(截图遮罩、划词浮窗、快捷面板:层级高于普通窗口、
///   铺满整块屏、或 AX 读得到时子角色不是标准窗口),等遮罩收了才露出普通窗口;或者被激活后没待够 `dwell`
///   秒焦点就回去了。→ 服务端把这一趟**放出来的**那家重新藏回去,当前那一格不变、工作台层级不动。
/// - **真切过去**(switched):它**被激活**,普通窗口成了最前面那扇,并且待满 `dwell` 秒。→ 服务端让窗口槽跟过去。
/// - 被放出来、没被激活、也一直没出现遮罩的(我们自己摆回窗口那类):**不下结论**,谁也不动。
///
/// 这个文件故意不 import AppKit(先例:DragSense.swift、WindowPlacement.swift):「哪扇算遮罩」「待够没有」
/// 「一趟什么时候算完」是最容易写错、又最值得测的部分;取窗口快照、问 AX 那一半在 ActivationWatch.swift。
/// 坐标:CGWindowList 的全局坐标(主屏左上原点、y 向下),屏的矩形也用 CGDisplayBounds 同一套。

/// 一扇窗此刻的样子(CGWindowList 取的 —— 不走 AX,AX 对企业微信 / Claude 这类应用常年不通)。
struct ActivationWindow: Equatable {
    let number: Int
    /// `kCGWindowLayer`:0 = 普通窗口;浮窗 3、菜单栏 24/25、截图遮罩 103(企业微信实测)都在更高的层;
    /// 负的是压在普通窗口下面的(工作台自己桌面档是 -1),不算「盖上来的」。
    let layer: Int
    let frame: CGRect
    let alpha: Double
}

/// 被叫出来的那一家,它最前面那扇窗是哪一种。
enum FrontKind: Equatable {
    case ordinary(ActivationWindow)
    case overlay(ActivationWindow, reason: String)
    /// 一扇像样的窗都没有(只剩菜单栏小图标那类,窗还没画出来,或者整家又藏起来了)。
    case none
}

enum ActivationSense {
    /// 能当「它的窗」的最小边长 —— 挡住菜单栏小图标、跟着鼠标走的尺寸标签、1×1 的辅助窗(同 DragTracker.minTrackableSide)。
    static let minSide: CGFloat = 120
    /// 「铺满整块屏」的容差(像素)。
    static let fullScreenSlack: CGFloat = 2
    /// AX 的标准窗口子角色。
    static let standardSubrole = "AXStandardWindow"

    /// 这扇窗是不是正好盖住某一整块屏(截图遮罩的样子;普通窗口最大化也只到菜单栏下面,盖不住菜单栏那一条)。
    static func coversDisplay(_ frame: CGRect, displays: [CGRect]) -> Bool {
        displays.contains { display in
            abs(display.minX - frame.minX) <= fullScreenSlack && abs(display.minY - frame.minY) <= fullScreenSlack
                && abs(display.width - frame.width) <= fullScreenSlack && abs(display.height - frame.height) <= fullScreenSlack
        }
    }

    /// 最前面那扇像样的窗是哪一种。
    ///
    /// - `windows`:这一家在屏上的窗,**前后序**(最前面那扇排第一 —— `CGWindowListCopyWindowInfo` 带
    ///   `.optionOnScreenOnly` 回的就是这个顺序);层级为负的(压在普通窗口下面的)不算;
    /// - `focusedSubrole`:AX 读到的「它当前那扇窗」的子角色,**只在那扇窗的位置对得上 CG 最前面那扇时才传**
    ///   (AX 读不了的应用 —— 企业微信、Claude —— 传 nil,只看 CG 那两条)。
    static func classify(windows: [ActivationWindow], displays: [CGRect], focusedSubrole: String?) -> FrontKind {
        guard let front = windows.first(where: {
            $0.layer >= 0 && $0.alpha > 0.01 && $0.frame.width >= minSide && $0.frame.height >= minSide
        }) else {
            return .none
        }
        if front.layer > 0 { return .overlay(front, reason: "层级 \(front.layer)") }
        if let subrole = focusedSubrole, subrole != standardSubrole { return .overlay(front, reason: "子角色 \(subrole)") }
        // 铺满整块屏的普通层窗口:AX 说它是标准窗口(原生全屏的那种)才算普通;说不上来就当遮罩。
        if coversDisplay(front.frame, displays: displays), focusedSubrole != standardSubrole {
            return .overlay(front, reason: "铺满整块屏")
        }
        return .ordinary(front)
    }

    /// 两个 bundle id 是不是同一家(一样,或者一个是另一个的子程序:`com.tencent.WeWorkMac.xxx`)。
    static func related(_ a: String, _ b: String) -> Bool {
        a == b || a.hasPrefix(b + ".") || b.hasPrefix(a + ".")
    }
}

/// 「被叫出来」的跟踪状态机。纯值语义,没有定时器、没有系统调用 —— 外面喂「激活了 / 放出来了 / 此刻的样子」,它回结论。
/// 同一时刻可以看好几家(企业微信被截图放出来的那一会儿,他也可能在 ⌘Tab 别家),一家一趟,各判各的。
struct ActivationTracker {
    /// 普通窗口要待满这么久才算「真切过去」(卡 P 任务书:「激活后很快把焦点还回去(比如 1.5 秒内)都不算」)。
    static let dwell: TimeInterval = 1.5
    /// 一段遮罩结束后,同一家(含子程序)这么快又被叫出来,算同一趟(截图小程序做完把焦点交回主程序)。
    static let chainWindow: TimeInterval = 2
    /// 只被放出来、没被激活的那一趟:这么久都没出现遮罩就不看了(那是我们自己摆回窗口之类,不是截图)。
    static let unhideWatch: TimeInterval = 3
    /// 一趟最多看这么久(遮罩一直开着没人管):到了就不看了,也不下结论 —— 拿不准就不替他动窗口。
    static let giveUp: TimeInterval = 600
    /// 遮罩开着时多久问一次「那扇遮罩还在不在屏上」(2026-09-25 卡 P 补,统筹:「截图遮罩一关,立刻把被掀出来的
    /// 那个窗位 App 藏回去」)。只问那一扇窗(本机实测 0.4 毫秒一次,整看一遍 1.9 毫秒);不在了当场整看、当场下结论。
    /// 原来遮罩收没收要等下一拍整看(开头 3 秒 0.25 秒一拍,之后 1 秒一拍),截图多半超过 3 秒 —— 最多晚一秒才发现。
    static let overlayPoll: TimeInterval = 0.03
    /// 一趟开头这么久(还没看到遮罩时)看得勤一点:`startPoll` 一次(卡 P 补二:统筹要量清「掀出来到遮罩盖上之间」有没有闪)。
    /// 这几拍只看 CG、不问 AX(AX 要等对方回话,开头这一下对方正忙着开截图)。
    static let startWatch: TimeInterval = 0.3
    static let startPoll: TimeInterval = 0.01

    enum Reason: String, Equatable {
        /// 它最前面那扇是遮罩 / 浮窗 / 面板(截图、划词、快捷面板)。
        case overlay
        /// 没待够就把焦点还回去了。
        case quickReturn = "quick_return"
        /// 一扇像样的窗都没露就走了。
        case noWindow = "no_window"
    }

    struct Episode: Equatable {
        let bundleId: String
        let pid: Int32
        var startedAt: TimeInterval
        /// 被叫出来之前它是不是藏着的(藏着的才需要藏回去 —— 只还原这一趟放出来的东西)。
        var wasHidden: Bool
        var previousBundleId: String?
        /// 这一趟它被激活过没有。企业微信截图那种只放出来、不激活:焦点不在它身上是正常的,不算「焦点走了」。
        var activated: Bool
        var overlay: ActivationWindow?
        var overlayReason: String?
        var ordinarySince: TimeInterval?
        var ordinary: ActivationWindow?
        /// 最近一次看,它最前面那扇**正是**遮罩(截图框选中)。`overlay` 记的是「这一趟出现过遮罩」,这个是「此刻还开着」。
        var overlayShowing = false
        /// 「遮罩开了」已经报过没有(一趟只报一次)。
        var overlayAnnounced = false
    }

    /// 一趟里**第一次**看到遮罩(还没下结论):壳把它报给服务端,服务端据此决定遮罩一收要不要当场藏回去(见 RehideArms)。
    struct OverlayOpened: Equatable {
        let bundleId: String
        let pid: Int32
        let wasHidden: Bool
        let activated: Bool
        let previous: String?
        let overlay: ActivationWindow
        let overlayReason: String
        let at: TimeInterval
    }

    enum Verdict: Equatable {
        case switched(bundleId: String, wasHidden: Bool, previous: String?, dwellMs: Int, window: ActivationWindow)
        case transient(bundleId: String, wasHidden: Bool, previous: String?, reason: Reason, dwellMs: Int,
                       overlay: ActivationWindow?, overlayReason: String?, front: ActivationWindow?)

        var bundleId: String {
            switch self {
            case .switched(let bundleId, _, _, _, _): return bundleId
            case .transient(let bundleId, _, _, _, _, _, _, _): return bundleId
            }
        }
    }

    /// 正在看的那几家(按进程号)。
    private(set) var episodes: [Int32: Episode] = [:]
    /// 第一次看到遮罩、还没被取走的那几条(见 takeOpenedOverlays)。
    private var openedPending: [OverlayOpened] = []
    /// 上一趟以「遮罩」收尾的是哪一家、什么时候(给紧跟着的那一次激活认「同一趟」)。
    private var lastOverlay: (bundleId: String, at: TimeInterval, window: ActivationWindow?, reason: String?)?

    init() {}

    /// 有一家被激活。同一家正在看(先被放出来、这会儿才激活)就接着那一趟;别家**被激活的**那几趟按「焦点走了」收掉
    /// (只被放出来的那几趟不受影响:焦点本来就不在它们身上)。
    mutating func activated(bundleId: String, pid: Int32, at: TimeInterval, wasHidden: Bool, previous: String?) -> [Verdict] {
        var out: [Verdict] = []
        for (other, ended) in episodes where other != pid && ended.activated {
            episodes[other] = nil
            out.append(contentsOf: finishOrDrop(ended, at: at))
        }
        if var current = episodes[pid] {
            if !current.activated {
                current.activated = true
                current.wasHidden = current.wasHidden || wasHidden
                if current.previousBundleId == nil { current.previousBundleId = previous }
                episodes[pid] = current
            }
            return out
        }
        var next = Episode(bundleId: bundleId, pid: pid, startedAt: at, wasHidden: wasHidden, previousBundleId: previous,
                           activated: true, overlay: nil, overlayReason: nil, ordinarySince: nil, ordinary: nil)
        chain(&next, at: at)
        episodes[pid] = next
        return out
    }

    /// 有一家**被放出来**(没被激活也算 —— 企业微信截图就是这样)。已经在看它就不另起。
    mutating func unhidden(bundleId: String, pid: Int32, at: TimeInterval) -> [Verdict] {
        if episodes[pid] != nil { return [] }
        var next = Episode(bundleId: bundleId, pid: pid, startedAt: at, wasHidden: true, previousBundleId: nil,
                           activated: false, overlay: nil, overlayReason: nil, ordinarySince: nil, ordinary: nil)
        chain(&next, at: at)
        episodes[pid] = next
        return []
    }

    /// 工作台自己被点到前面了:被激活的那几趟按「焦点走了」收掉;只被放出来的接着看。
    mutating func focusLeft(at: TimeInterval) -> [Verdict] {
        var out: [Verdict] = []
        for (pid, ended) in episodes where ended.activated {
            episodes[pid] = nil
            out.append(contentsOf: finishOrDrop(ended, at: at))
        }
        return out
    }

    /// 一次采样:此刻最前面的是谁,某一家最前面那扇是哪一种。
    mutating func sample(pid: Int32, at: TimeInterval, frontmostPid: Int32?, kind: FrontKind) -> [Verdict] {
        guard var current = episodes[pid] else { return [] }
        if current.activated, frontmostPid != current.pid {
            episodes[pid] = nil
            return finishOrDrop(current, at: at)
        }
        switch kind {
        case .overlay(let window, let reason):
            current.overlay = window
            current.overlayReason = reason
            current.ordinarySince = nil
            current.ordinary = nil
            current.overlayShowing = true
            if !current.overlayAnnounced {
                current.overlayAnnounced = true
                openedPending.append(OverlayOpened(bundleId: current.bundleId, pid: current.pid, wasHidden: current.wasHidden,
                                                   activated: current.activated, previous: current.previousBundleId,
                                                   overlay: window, overlayReason: reason, at: at))
            }
        case .ordinary(let window):
            current.overlayShowing = false
            if current.overlay != nil {
                // 遮罩收了,露出来的是它的普通窗口 —— 那是这一趟**放出来**的,不是他要切过去。
                episodes[pid] = nil
                remember(current, at: at)
                return [.transient(bundleId: current.bundleId, wasHidden: current.wasHidden, previous: current.previousBundleId,
                                   reason: .overlay, dwellMs: ms(at - current.startedAt),
                                   overlay: current.overlay, overlayReason: current.overlayReason, front: window)]
            }
            if !current.activated {
                // 只被放出来、没激活、也没遮罩(我们自己摆回窗口那类):看一会儿,没事就不管了。
                if at - current.startedAt >= Self.unhideWatch { episodes[pid] = nil; return [] }
                break
            }
            if current.ordinarySince == nil || current.ordinary?.number != window.number {
                current.ordinarySince = at
                current.ordinary = window
            }
            if let since = current.ordinarySince, at - since >= Self.dwell {
                episodes[pid] = nil
                return [.switched(bundleId: current.bundleId, wasHidden: current.wasHidden, previous: current.previousBundleId,
                                  dwellMs: ms(at - current.startedAt), window: window)]
            }
        case .none:
            current.ordinarySince = nil
            current.ordinary = nil
            current.overlayShowing = false
            if !current.activated {
                if current.overlay != nil {
                    // 遮罩收了、它自己也又藏回去了(整家没窗了):不用我们再藏,就此结束。
                    episodes[pid] = nil
                    remember(current, at: at)
                    return []
                }
                if at - current.startedAt >= Self.unhideWatch { episodes[pid] = nil; return [] }
            }
        }
        if at - current.startedAt >= Self.giveUp {
            episodes[pid] = nil // 看太久了:不下结论、不动窗口
            return []
        }
        episodes[pid] = current
        return []
    }

    /// 此刻正开着的遮罩:进程号 → 那扇遮罩的窗号。壳拿它每 `overlayPoll` 问一次「还在不在屏上」。
    var showingOverlays: [Int32: Int] {
        var out: [Int32: Int] = [:]
        for (pid, episode) in episodes where episode.overlayShowing {
            if let number = episode.overlay?.number { out[pid] = number }
        }
        return out
    }

    /// 取走「第一次看到遮罩」的那几条(取了就清)。
    mutating func takeOpenedOverlays() -> [OverlayOpened] {
        defer { openedPending = [] }
        return openedPending
    }

    /// 下一次采样隔多久(有在看的一趟时才有):最新那一趟的前 3 秒 0.25 秒一次(待满 1.5 秒要看得清),之后 1 秒一次。
    /// 唤醒这条链的是「有一家被激活 / 被放出来」这个事件,不是常驻定时器 —— 没有这种事件就一次都不采(同 DragSense 的纪律)。
    func nextDelay(at: TimeInterval) -> TimeInterval? {
        guard !episodes.isEmpty else { return nil }
        // 开头 0.3 秒、还没看到遮罩:10 毫秒看一次(量「被掀出来 → 遮罩盖上」之间它的窗露没露,也让遮罩早一点被看到、早一点预约)。
        if episodes.values.contains(where: { at - $0.startedAt < Self.startWatch && $0.overlay == nil }) { return Self.startPoll }
        return episodes.values.contains(where: { at - $0.startedAt < 3 }) ? 0.25 : 1
    }

    /// 紧跟在同一家的一段遮罩之后:接着那一趟算(它这回露出来的普通窗口不算他要切过去)。
    private func chain(_ next: inout Episode, at: TimeInterval) {
        guard let chained = lastOverlay, at - chained.at <= Self.chainWindow, ActivationSense.related(chained.bundleId, next.bundleId) else { return }
        next.overlay = chained.window
        next.overlayReason = chained.reason.map { "\($0)(接着上一段)" } ?? "接着上一段遮罩"
    }

    private mutating func remember(_ ended: Episode, at: TimeInterval) {
        if let window = ended.overlay {
            lastOverlay = (ended.bundleId, at, window, ended.overlayReason)
        }
    }

    /// 被激活的那一趟焦点走了:下结论(临时叫一下)。只被放出来的那一趟结束时:
    /// 有过遮罩就照「遮罩收了」下结论(藏回去),没有就不说话。
    private mutating func finishOrDrop(_ ended: Episode, at: TimeInterval) -> [Verdict] {
        remember(ended, at: at)
        if !ended.activated && ended.overlay == nil { return [] }
        let reason: Reason = ended.overlay != nil ? .overlay : (ended.ordinarySince == nil ? .noWindow : .quickReturn)
        return [.transient(bundleId: ended.bundleId, wasHidden: ended.wasHidden, previous: ended.previousBundleId,
                           reason: reason, dwellMs: ms(at - ended.startedAt),
                           overlay: ended.overlay, overlayReason: ended.overlayReason, front: ended.ordinary)]
    }

    private func ms(_ seconds: TimeInterval) -> Int { Int((seconds * 1000).rounded()) }
}

/// 挪到屏外的一扇窗:原来在哪、挪到了哪(左上角)。藏好之后按它挪回来。
struct ParkedWindow: Equatable {
    let original: CGRect
    let parkedAt: CGPoint
}

extension ActivationSense {
    /// 这扇窗该不该在遮罩底下挪开:普通层、像样大小、不是盖整块屏的那种(那是遮罩本身)、在某块屏上露着。
    static func parkable(_ window: ActivationWindow, displays: [CGRect]) -> Bool {
        window.layer == 0 && window.alpha > 0.01
            && window.frame.width >= minSide && window.frame.height >= minSide
            && !coversDisplay(window.frame, displays: displays)
            && exposedArea(window.frame, displays: displays) > 1.5
    }

    /// 被掀出来的那一家要挪开哪几扇(遮罩那几扇层级高,不在里面;挪了遮罩截图就花了)。
    static func windowsToPark(_ windows: [ActivationWindow], displays: [CGRect]) -> [ActivationWindow] {
        windows.filter { parkable($0, displays: displays) }
    }

    /// 一个矩形在各块屏上露出来多少(像素²)。
    static func exposedArea(_ frame: CGRect, displays: [CGRect]) -> CGFloat {
        displays.reduce(0) { total, display in
            let cut = frame.intersection(display)
            return cut.isNull ? total : total + cut.width * cut.height
        }
    }

    /// 挪到哪:某块屏的右下角(不行就左下角)外面,只留 1 个像素在屏上 —— macOS 不让窗整扇挪出所有屏,
    /// 管窗口的工具(AeroSpace 那类)也是这么「藏」的。挑一个不会压到别的屏的角;都不行回 nil(不挪,照老路遮罩一收就藏)。
    /// 不用上面两个角:屏顶是菜单栏,窗口的标题栏不许挪到它上面。
    static func parkOrigin(size: CGSize, displays: [CGRect]) -> CGPoint? {
        for display in displays {
            let corners = [
                CGPoint(x: display.maxX - 1, y: display.maxY - 1),
                CGPoint(x: display.minX - size.width + 1, y: display.maxY - 1),
            ]
            for origin in corners where exposedArea(CGRect(origin: origin, size: size), displays: displays) <= 1.5 {
                return origin
            }
        }
        return nil
    }
}

/// 「遮罩收起那一刻,露出来的就是他原来的页面」(2026-09-25 卡 P 补二)。
///
/// 维护者 0.3.0 真壳验企业微信 ⌘⇧A:「没彻底解决,但是比之前好,还是会闪一下企业微信,然后恢复之前的页面」。
/// 统筹的判断:藏回本身够快,问题在遮罩底下 —— 那一刻最前面已经是它的主窗口,遮罩一收它先被看见,藏回才生效;
/// 「收了再藏」再快也会闪。所以改成**遮罩还开着的时候**就把它的普通窗口挪到屏外(只挪位置:不激活、不置前任何东西,
/// 遮罩那几扇不动,截图不断);遮罩一收,露出来的是他原来的窗口(窗位里当前那一家,或者工作台)。然后藏回去,
/// 藏好了(didHide)再把窗挪回原位 —— 藏着挪,人看不见。
///
/// 该不该这么做仍由服务端定(只有它知道谁是窗口槽成员、谁在台前):遮罩刚开时壳报一句「遮罩开了」,
/// 服务端认为该藏(是成员、不是当前那一格、被叫出来之前是藏着的)就回一个 `arm_rehide`,壳收下就挪。
///
/// 一家一条,走四步:预约(armed,同时去挪)→ 遮罩收了、当场藏(rehidden)→ 藏好了(hidden)→ 挪回原位。
/// 挪是在另一条队列上做的(AX 要等对方回话),所以「挪完」可能晚于「藏好」:两种先后都接得住。
/// 纯值语义,不碰系统:什么时候挪、什么时候藏、什么时候挪回、什么时候作废,都在这里,能测。
struct RehideArms {
    enum Stage: Equatable {
        case armed
        case rehidden
        case hidden
    }

    struct Entry: Equatable {
        let bundleId: String
        var stage: Stage
        /// 挪开这一步已经发出去、还没回话。
        var parking: Bool
        var parked: [ParkedWindow]
    }

    private(set) var entries: [String: Entry] = [:]

    init() {}

    /// 此刻预约着、还没用上的那几家。
    var armed: Set<String> { Set(entries.values.filter { $0.stage == .armed }.map { $0.bundleId }) }

    private func key(for bundleId: String) -> String? {
        entries.keys.first { ActivationSense.related($0, bundleId) }
    }

    /// 服务端预约。只在这一家此刻确实开着遮罩时才收 —— 遮罩已经收了的迟到预约不收(那一趟已经走服务端那条路了)。
    mutating func arm(_ bundleId: String, overlayShowing: Bool) -> Bool {
        guard overlayShowing, !bundleId.isEmpty else { return false }
        if key(for: bundleId) == nil { entries[bundleId] = Entry(bundleId: bundleId, stage: .armed, parking: false, parked: []) }
        return true
    }

    /// 收下预约之后去挪:只挪一次。回 true = 壳这就去挪。
    mutating func beginPark(_ bundleId: String) -> Bool {
        guard let k = key(for: bundleId), var entry = entries[k], entry.stage == .armed, !entry.parking, entry.parked.isEmpty else { return false }
        entry.parking = true
        entries[k] = entry
        return true
    }

    /// 挪完了(另一条队列回话)。回要**当场挪回**的那几扇:已经藏好了(藏在挪之前完成)、或者这一条已经作废了
    /// (服务端要露出它 / 这一趟没结论就结束了)—— 挪走的窗不能就这么留在屏外。
    mutating func didPark(_ bundleId: String, _ windows: [ParkedWindow]) -> [ParkedWindow] {
        guard let k = key(for: bundleId), var entry = entries[k] else { return windows }
        entry.parking = false
        entry.parked = windows
        if entry.stage == .hidden {
            entries[k] = nil
            return windows
        }
        entries[k] = entry
        return []
    }

    /// 这条结论要不要壳当场藏回去:遮罩收了的「临时叫一下」、被叫出来之前是藏着的、这一家(或同一家的子程序)预约过。
    /// 一次预约只藏一次。
    mutating func take(_ verdict: ActivationTracker.Verdict) -> Bool {
        guard case .transient(let bundleId, let wasHidden, _, let reason, _, _, _, _) = verdict,
              reason == .overlay, wasHidden,
              let k = key(for: bundleId), var entry = entries[k], entry.stage == .armed else { return false }
        entry.stage = .rehidden
        entries[k] = entry
        return true
    }

    /// 它藏好了(didHide)。回要挪回原位的那几扇(还在挪的,等挪完再挪回;没挪过的回空)。
    mutating func didHide(_ bundleId: String) -> [ParkedWindow] {
        guard let k = key(for: bundleId), var entry = entries[k], entry.stage == .rehidden else { return [] }
        if entry.parking {
            entry.stage = .hidden
            entries[k] = entry
            return []
        }
        entries[k] = nil
        return entry.parked
    }

    /// 这一家还在不在等(预约了、藏了、还没挪回)。
    func pending(_ bundleId: String) -> Bool { key(for: bundleId) != nil }

    /// 服务端自己要露出它(点标签切过去、摆回窗位):预约作废,挪走的窗当场挪回(不能把他刚切过去的那一家留在屏外)。
    /// 回「哪一家 → 要挪回的窗」。还在挪的那一家挪完时 `didPark` 会把窗交回来。
    @discardableResult
    mutating func cancel(_ bundleId: String) -> [String: [ParkedWindow]] {
        var back: [String: [ParkedWindow]] = [:]
        for (k, entry) in entries where ActivationSense.related(k, bundleId) {
            if !entry.parked.isEmpty { back[k] = entry.parked }
            entries[k] = nil
        }
        return back
    }

    /// 一趟结束了、还只是预约(没有「遮罩收了」的结论:它自己又藏回去了 / 看太久不看了):作废,挪走的窗挪回。
    /// 已经藏了、在等 didHide 的不动。回「哪一家 → 要挪回的窗」。
    @discardableResult
    mutating func keep(only bundleIds: Set<String>) -> [String: [ParkedWindow]] {
        var back: [String: [ParkedWindow]] = [:]
        for (k, entry) in entries where entry.stage == .armed && !bundleIds.contains(where: { ActivationSense.related($0, k) }) {
            if !entry.parked.isEmpty { back[k] = entry.parked }
            entries[k] = nil
        }
        return back
    }

    /// 藏了却一直没等到 didHide(它不肯藏):不再等,也**不当场挪回**(它还露着,挪回来就又盖在窗位上了)。
    /// 回挪走的那几扇:调用方记着,等它下次被叫到前面 / 服务端要露出它时再挪回。还在挪的,挪完时 `didPark` 交回。
    @discardableResult
    mutating func forget(_ bundleId: String) -> [ParkedWindow] {
        guard let k = key(for: bundleId), let entry = entries[k] else { return [] }
        entries[k] = nil
        return entry.parked
    }
}

/// 一趟的时间线(2026-09-25 卡 P 补二;统筹:「先把时间线量清楚:企业微信什么时候被掀出来、遮罩什么时候出现、
/// 什么时候收、藏回什么时候真生效(要有 didUnhide、didHide 通知的时刻)……写进 recent_activations,方便我事后核」)。
///
/// 每一样记第一次发生的时刻,报的时候换成「离这一趟开头多少毫秒」(开头 = 壳收到 didUnhide / didActivate 那一刻)。
/// 名字:unhide / activate(系统通知)、first_look、ordinary_before_overlay(遮罩盖上之前看到它的普通窗口露着 —— 开头那一下闪了)、
/// overlay_on、armed、parked、overlay_off、rehide、hidden(didHide 通知)、unparked。
struct ActivationTimeline: Equatable {
    let startedAt: TimeInterval
    private(set) var marks: [String: TimeInterval] = [:]
    private(set) var counts: [String: Int] = [:]
    private(set) var notes: [String: String] = [:]

    init(startedAt: TimeInterval) {
        self.startedAt = startedAt
    }

    /// 记一样的时刻(只记第一次)。
    mutating func mark(_ name: String, at: TimeInterval) {
        if marks[name] == nil { marks[name] = at }
    }

    mutating func count(_ name: String, _ value: Int) { counts[name] = value }
    mutating func note(_ name: String, _ text: String) { notes[name] = text }

    /// 离开头多少毫秒(没发生过 = nil)。
    func milliseconds(_ name: String) -> Int? {
        marks[name].map { Int((($0 - startedAt) * 1000).rounded()) }
    }

    /// 发给服务端的那一格:`started_at`(墙钟)+ `<名字>_ms` + 计数 + 说明。没有标题、没有内容。
    func payload(startedAtWall: Date) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var out: [String: Any] = ["started_at": formatter.string(from: startedAtWall)]
        for name in marks.keys { out["\(name)_ms"] = milliseconds(name) }
        for (name, value) in counts { out[name] = value }
        for (name, text) in notes { out[name] = text }
        return out
    }
}
