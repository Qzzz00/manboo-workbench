import CoreGraphics
import Foundation

/// 壳窗口「落在哪块屏、摆成多大」的全部判断(2026-09-18,Ben:「一上来就撑满竖屏不对;
/// 拖到横屏也不变形」)。
///
/// 这个文件**故意不 import AppKit**:NSScreen / NSWindow 在单测里造不出来,而「选哪块屏」
/// 「记忆怎么失效」「frame 怎么收边」恰恰是最容易写错、又最值得测的部分。所以这里只认
/// `ScreenSnapshot`(一块屏的只读快照,纯 CGRect),AppKit 那半截换算留在 AppDelegate 里。
/// 测试跑法见 workbench-app/run-tests.sh。
///
/// 坐标系沿用 AppKit 的全局坐标(主屏左下角为原点、y 向上)——壳自己 setFrame 用的就是它,
/// 不在这里再换一次算,免得多一层换算多一处错。
enum WindowPlacement {
    /// 记忆里允许的最小窗口。比这还小的记忆当脏数据丢掉(见 RememberedFrame.decode):
    /// 一扇 40×30 的工作台没法用,多半是哪次算错了写进去的,不该忠实地还原出来。
    static let minWidth: CGFloat = 480
    static let minHeight: CGFloat = 360

    /// 记忆键:显示器名 + 整块屏的分辨率。
    ///
    /// 为什么不用 CGDirectDisplayID:它在**同一次开机内**稳定,跨重启/换口会变,而「重启后
    /// 还记得上次的大小」正是要的效果。名字+分辨率跨重启稳定,代价是两台同型号同分辨率的屏
    /// 会共用一份记忆——Ben 的两块屏一块 2560×1440 一块 1440×2560,撞不上;真撞上了后果也只是
    /// 两块屏共享一个大小,不是错乱。名字取不到(虚拟屏/远程屏)才退回 displayID。
    static func screenKey(name: String, size: CGSize, displayID: UInt32?) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let w = Int(size.width.rounded())
        let h = Int(size.height.rounded())
        if trimmed.isEmpty {
            return "display-\(displayID.map(String.init) ?? "unknown")@\(w)x\(h)"
        }
        return "\(trimmed)@\(w)x\(h)"
    }

    /// 选屏顺序:配了 `screen_hint` 就听它 → 上次待过的那块屏(还在的话)→ **没有记忆时只挑横屏**:
    /// 鼠标所在的横屏 → 主屏(菜单栏那块)是横屏就主屏 → 第一块横屏 → (一块横屏都没有)鼠标所在的屏 → 主屏 → 第一块屏。
    ///
    /// 2026-09-18 定的是「鼠标所在的屏 → 主屏」:人刚点开工作台,手就在那块屏上。
    /// 2026-09-23 从零重装验收:第一次打开(没有记忆)时鼠标恰好在竖屏副屏上(DELL UP2716D,829×1456 那块),
    /// 登录窗口铺满了竖屏 —— 维护者以前明说过**登录窗口不该铺到竖屏上**。第一次打开铺满的是登录/引导整屏,
    /// 竖屏上又瘦又长;所以没有记忆时竖屏一律往后排。有记忆(他自己拖过去的)照样回到竖屏,那是他选的。
    /// `screen_hint` 留着只是给「我就是要它永远开在某台屏上」这种明确指定用,**不再有缺省值**。
    ///
    /// `mainScreenKey` 传**主屏**(`NSScreen.screens.first`,菜单栏所在那块),不是 `NSScreen.main`(带键盘焦点的那块)。
    static func chooseScreen(screens: [ScreenSnapshot],
                             hint: String?,
                             lastScreenKey: String?,
                             mouse: CGPoint?,
                             mainScreenKey: String?) -> (screen: ScreenSnapshot, reason: Reason)? {
        if screens.isEmpty { return nil }
        if let hint, !hint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let hit = screens.first(where: { $0.name.localizedCaseInsensitiveContains(hint) }) {
            return (hit, .hint)
        }
        if let lastScreenKey, let hit = screens.first(where: { $0.key == lastScreenKey }) {
            return (hit, .remembered)
        }
        let underMouse = mouse.flatMap { point in screens.first(where: { $0.frame.contains(point) }) }
        let main = mainScreenKey.flatMap { key in screens.first(where: { $0.key == key }) }
        if let hit = underMouse, hit.isLandscape { return (hit, .mouse) }
        if let hit = main, hit.isLandscape { return (hit, .main) }
        if let hit = screens.first(where: { $0.isLandscape }) { return (hit, .landscape) }
        if let hit = underMouse { return (hit, .mouse) }
        if let hit = main { return (hit, .main) }
        return (screens[0], .fallback)
    }

    /// 为什么落在这块屏。只用来写日志/交接时讲清楚,行为上不区分。
    enum Reason: String {
        case hint, remembered, mouse, main, landscape, fallback
    }

    /// 这块屏上该摆多大:**第一次在这块屏上出现就铺满它的 visibleFrame**,之后还原记忆
    /// (并收进可视区)。这是「首次铺满、之后尊重用户拖过的大小」那条的实现。
    ///
    /// 2026-09-26(卡 TB 真机回访之二,统筹:「重启还原记忆这条路也漏了跟着新可视区铺满」):
    /// 维护者把菜单栏改成自动隐藏后重开壳,可视区已经是 2560×1440,而记忆里是 h=1410 —— 原来这里
    /// 只 fit,**不知道那份记忆当时正铺满旧的可视区**,于是老老实实还原成 1410,顶上又空一条。
    /// 现在记忆里一并存了「记下它的时候可视区多大」(`RememberedFrame.visible`):当时铺满的、
    /// 而现在可视区变了 → 铺满现在这块。口径与 `refit`(运行中可视区变了那一路)一字不差。
    static func frame(for screen: ScreenSnapshot, remembered: RememberedFrame?) -> CGRect {
        guard let remembered else { return screen.visibleFrame }
        if remembered.filledWhenRemembered(tolerance: fillTolerance) == true,
           remembered.visible != screen.visibleFrame.size { return screen.visibleFrame }
        if remembered.looksFilledBeforeMenuBarHid(now: screen.visibleFrame) { return screen.visibleFrame }
        return fit(remembered.rect(on: screen), into: screen.visibleFrame)
    }

    /// 窗口刚被拖到另一块屏上时摆多大。
    ///
    /// - 那块屏**没有**记忆:铺满它(Ben 的原话「拖到横屏也没变成撑满横屏的形状」就是这一条)。
    /// - 那块屏**有**记忆:只还原**大小**,位置留在他刚松手的地方(再收进可视区)。
    ///   不把位置也拽回去,是因为他刚刚亲手把窗口放在那儿——最近一次的手动操作应当赢过记忆;
    ///   而大小要还原,不然从竖屏拖过去的窗口在横屏上永远是个瘦条。
    /// 拖完之后窗口该去哪块屏(2026-09-27):**看松手时鼠标在哪块屏**,和窗口原来那块不一样才回那一块。
    /// 维护者:「我想把工作台拖拽到另一个屏幕上,但是发现拖拽不过去」—— 铺满大屏的窗口往小屏拖,
    /// 大半个窗还在原屏上,系统按覆盖面积永远认原屏;人眼里「拖到哪」是手在哪。
    /// 顶栏「换屏」点一下去哪块屏(2026-09-27):排在现在这块后面的那一块,最后一块之后回到第一块。
    /// 只有一块屏就 nil(什么都不做)。
    static func nextScreen(after key: String?, in screens: [ScreenSnapshot]) -> ScreenSnapshot? {
        guard screens.count > 1 else { return nil }
        guard let key, let i = screens.firstIndex(where: { $0.key == key }) else { return screens.first }
        return screens[(i + 1) % screens.count]
    }

    /// 换屏(按钮或拖过去松手)落到那块屏上的样子:**铺满它的可视区**(2026-09-27,维护者:「换屏过来没有撑满,
    /// 应该是把之前的顶部栏留下的」—— 按记忆还原会还原成菜单栏还露着那会儿记下的高度,顶上空一条)。
    static func frameForScreenSwitch(_ screen: ScreenSnapshot) -> CGRect { screen.visibleFrame }

    static func screenForDragEnd(pointer: CGPoint, screens: [ScreenSnapshot], windowScreenKey: String?) -> ScreenSnapshot? {
        guard let under = screens.first(where: { $0.frame.contains(pointer) }) else { return nil }
        return under.key == windowScreenKey ? nil : under
    }

    static func frameOnArrival(current: CGRect, screen: ScreenSnapshot, remembered: RememberedFrame?) -> CGRect {
        guard let remembered else { return screen.visibleFrame }
        // 同 frame(for:):那块屏上记着的是一扇铺满的窗,而那块屏的可视区后来变了 → 铺满现在这块。
        if remembered.filledWhenRemembered(tolerance: fillTolerance) == true,
           remembered.visible != screen.visibleFrame.size { return screen.visibleFrame }
        let sized = CGRect(origin: current.origin, size: CGSize(width: remembered.width, height: remembered.height))
        return fit(sized, into: screen.visibleFrame)
    }

    /// 收边:先把尺寸夹进 [最小值, 可视区],再把原点挪到窗口整个落在可视区里。
    /// 「不超出、不裁切」这条硬要求只由这一个函数保证,别处不再各写一遍。
    static func fit(_ rect: CGRect, into visible: CGRect) -> CGRect {
        guard visible.width > 0, visible.height > 0 else { return rect }
        let lowW = min(minWidth, visible.width)
        let lowH = min(minHeight, visible.height)
        let w = max(lowW, min(rect.width, visible.width))
        let h = max(lowH, min(rect.height, visible.height))
        let x = min(max(rect.minX, visible.minX), visible.maxX - w)
        let y = min(max(rect.minY, visible.minY), visible.maxY - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// 「这扇窗此刻正铺满这块可视区」的容差(pt)。setFrame 之后系统可能按整像素取整,
    /// 差一两点还算铺满;取 4 不会误判 —— 菜单栏那一截有 24 点以上。
    static let fillTolerance: CGFloat = 4

    /// 这扇窗是不是正铺满这块可视区(四边都贴着,容差内)。
    static func fills(_ rect: CGRect, _ visible: CGRect) -> Bool {
        guard visible.width > 0, visible.height > 0 else { return false }
        return abs(rect.minX - visible.minX) <= fillTolerance
            && abs(rect.minY - visible.minY) <= fillTolerance
            && abs(rect.width - visible.width) <= fillTolerance
            && abs(rect.height - visible.height) <= fillTolerance
    }

    /// 屏没换、只是**可视区变了**(2026-09-25,卡 TB):菜单栏改成「自动隐藏和显示」、Dock 显隐、
    /// 分辨率变,都会让 visibleFrame 长高或缩水。
    ///
    /// - 原来正铺满旧可视区的窗口 → 跟着铺满新的。菜单栏一藏,visibleFrame 高出一截,只收边的话
    ///   窗口会在顶上留一条空带,人看见的还是「顶上有空隙」—— 这张卡要的恰恰是没有空隙。
    /// - 原来没铺满(他自己拖小过)→ 只收边,尺寸不动:他选的大小赢过自动铺满。
    static func refit(_ rect: CGRect, from previousVisible: CGRect?, into visible: CGRect) -> CGRect {
        if let previousVisible, previousVisible != visible, fills(rect, previousVisible) { return visible }
        return fit(rect, into: visible)
    }

    /// 多久自己核对一次可视区(秒)。2026-09-26 真机回访:维护者把「自动隐藏和显示菜单栏」
    /// 改成「始终」,可视区从 2560×1410 变成 2560×1440,**窗口没跟着长高** —— 壳原来只在
    /// `didChangeScreenParametersNotification` 那一下核对,而这个设置在 macOS 26 上要么不发
    /// 那条通知,要么发了的时候 NSScreen 还停在旧值(两种都会让那一下白过,且再没有第二次机会)。
    ///
    /// 所以不再只靠通知:壳自己按这个间隔核对一次(只读一次 NSScreen.visibleFrame 再比一个 CGRect,
    /// 没变就什么都不做)。2 秒:人改完设置抬头就看见窗口长上去,又不至于频繁到值得担心。
    static let visibleFramePoll: TimeInterval = 2

    /// 核对一次可视区,返回「窗口该挪到哪儿」;**不需要动就是 nil**(调用方据此决定要不要
    /// setFrame / 写盘)。2026-09-26 卡 TB 真机回访补:这是定时核对与屏参数通知共用的同一条判断。
    ///
    /// - `previous` 为空(壳刚起来、还没有可比的旧值):只记住当前可视区,不动窗口。
    /// - 可视区没变:不动。这是每次核对的**常态**,也是这条判断必须便宜的原因。
    /// - 变了:交给 `refit` —— 刚才铺满的跟着铺满新的,他自己拖小过的只收边;
    ///   算出来跟现在一模一样(比如窗口本来就小、收边收了个寂寞)也返回 nil,不白写一次盘。
    static func reconcile(window: CGRect, previous: CGRect?, visible: CGRect) -> CGRect? {
        guard let previous, previous != visible else { return nil }
        let target = refit(window, from: previous, into: visible)
        return target == window ? nil : target
    }

    /// 把当前 frame 折成「相对这块屏 visibleFrame 原点的偏移 + 大小」。
    /// 存相对值而不是全局坐标:显示器在「排列」里换个位置(或主屏换一块)后,全局坐标整体平移,
    /// 存绝对值的记忆就会把窗口还原到别的屏上去;相对值不受排列影响。
    static func remember(frame: CGRect, on screen: ScreenSnapshot) -> RememberedFrame {
        RememberedFrame(dx: frame.minX - screen.visibleFrame.minX,
                        dy: frame.minY - screen.visibleFrame.minY,
                        width: frame.width,
                        height: frame.height,
                        // 记下**当时的可视区多大**(2026-09-26):下次还原时才知道这份记忆
                        // 是不是「那会儿正铺满」,而不是他自己拖成这么大的(见 frame(for:))。
                        visible: screen.visibleFrame.size)
    }

    /// 旧记忆(还没有 `visible` 那一项时写下的)的一次性迁移口径(2026-09-26)。
    ///
    /// 真机上 `~/.dsh/workbench/app.json` 里躺着的就是这种:`{dx:0, dy:0, w:1440, h:2530}`,
    /// 而那块屏的可视区现在是 1440×2560 —— 贴着原点、宽度一样、只矮一条菜单栏。这种形状几乎只可能
    /// 来自「菜单栏还露着的时候铺满过」,当成铺满处理,他升级到这一版后第一次重开壳就不再空一条。
    /// 差得比一条菜单栏还多(Dock 那一截、他自己拖小的)一律不认。只对没有 `visible` 的旧记忆生效;
    /// 壳跑起来之后写回去的记忆都带 `visible`,走上面那条正经判断。
    static let menuBarSlack: CGFloat = 48
}

/// 一块屏的只读快照。AppDelegate 里由 NSScreen 现场折出来,这里只当纯数据用。
struct ScreenSnapshot: Equatable {
    var name: String
    var frame: CGRect
    var visibleFrame: CGRect
    var displayID: UInt32?

    var key: String { WindowPlacement.screenKey(name: name, size: frame.size, displayID: displayID) }
    /// 横屏(宽 ≥ 高;正方形也算横屏)。
    var isLandscape: Bool { frame.width >= frame.height }

    init(name: String, frame: CGRect, visibleFrame: CGRect, displayID: UInt32? = nil) {
        self.name = name
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.displayID = displayID
    }
}

/// 一块屏上记住的窗口:相对该屏 visibleFrame 原点的偏移 + 大小 + **记下它时那块屏的可视区多大**。
struct RememberedFrame: Equatable {
    var dx: CGFloat
    var dy: CGFloat
    var width: CGFloat
    var height: CGFloat
    /// 记下这一份时那块屏的可视区大小(2026-09-26,卡 TB 真机回访之二)。app.json 里是 `vw`/`vh`。
    /// **旧记忆没有这一项 → nil**:那时候不知道这扇窗当时是铺满的还是他自己拖成这样的,
    /// 只能按「不知道」处理(见 WindowPlacement.frame(for:) 与 menuBarSlack 那条迁移口径)。
    var visible: CGSize?

    init(dx: CGFloat, dy: CGFloat, width: CGFloat, height: CGFloat, visible: CGSize? = nil) {
        self.dx = dx
        self.dy = dy
        self.width = width
        self.height = height
        self.visible = visible
    }

    func rect(on screen: ScreenSnapshot) -> CGRect {
        CGRect(x: screen.visibleFrame.minX + dx,
               y: screen.visibleFrame.minY + dy,
               width: width,
               height: height)
    }

    /// 记下这一份的时候,这扇窗正铺满那会儿的可视区吗?旧记忆答不上来(nil)。
    func filledWhenRemembered(tolerance: CGFloat) -> Bool? {
        guard let visible else { return nil }
        return abs(dx) <= tolerance && abs(dy) <= tolerance
            && abs(width - visible.width) <= tolerance
            && abs(height - visible.height) <= tolerance
    }

    /// 旧记忆的一次性迁移口径(见 WindowPlacement.menuBarSlack 顶上那段):贴着可视区原点、
    /// 宽度就是现在的可视区宽度、只比现在矮一条菜单栏之内 —— 当成「当年菜单栏还露着时铺满过」。
    /// 只对没有 `visible` 的旧记忆生效。
    func looksFilledBeforeMenuBarHid(now visible: CGRect) -> Bool {
        guard self.visible == nil, visible.width > 0, visible.height > 0 else { return false }
        let gap = visible.height - height
        return abs(dx) <= WindowPlacement.fillTolerance
            && abs(dy) <= WindowPlacement.fillTolerance
            && abs(width - visible.width) <= WindowPlacement.fillTolerance
            && gap > WindowPlacement.fillTolerance && gap <= WindowPlacement.menuBarSlack
    }

    /// 脏数据一律当「没记忆」处理(结果就是铺满,回到首次的行为),不试着修补一个半对的值:
    /// NaN/inf(算错过一次)、宽高小于最小窗口(存进去就已经不能用了)。
    /// 偏移为负是**正常**的——记忆是跨会话的,Dock 显隐会让 visibleFrame 变,收边在读的时候做。
    static func decode(_ raw: Any?) -> RememberedFrame? {
        guard let dict = raw as? [String: Any],
              let dx = number(dict["dx"]), let dy = number(dict["dy"]),
              let w = number(dict["w"]), let h = number(dict["h"]) else { return nil }
        guard w >= WindowPlacement.minWidth, h >= WindowPlacement.minHeight else { return nil }
        // vw/vh 是 2026-09-26 才加的:旧文件里没有,缺了就是「不知道当时可视区多大」,不编一个。
        // 只有两项都在、都是正的有限数才认(半份数据等于没有)。
        var visible: CGSize?
        if let vw = number(dict["vw"]), let vh = number(dict["vh"]), vw > 0, vh > 0 {
            visible = CGSize(width: vw, height: vh)
        }
        return RememberedFrame(dx: dx, dy: dy, width: w, height: h, visible: visible)
    }

    var encoded: [String: Any] {
        var out: [String: Any] = ["dx": Int(dx.rounded()), "dy": Int(dy.rounded()),
                                  "w": Int(width.rounded()), "h": Int(height.rounded())]
        if let visible {
            out["vw"] = Int(visible.width.rounded())
            out["vh"] = Int(visible.height.rounded())
        }
        return out
    }

    private static func number(_ raw: Any?) -> CGFloat? {
        guard let n = raw as? NSNumber else { return nil }
        let v = CGFloat(n.doubleValue)
        return v.isFinite ? v : nil
    }
}

/// app.json 里 `window_frames` 那一块的内存态:
///
/// ```json
/// "window_frames": {
///   "last_screen": "DELL UP2716D@1440x2560",
///   "screens": { "DELL UP2716D@1440x2560": { "dx": 0, "dy": 0, "w": 1440, "h": 2415 } }
/// }
/// ```
///
/// 整块塞在一个键下面,是为了跟插件那边的开关(lan_access / scan_roots / …)井水不犯河水:
/// 两边都是「读整份 → 改自己那一块 → 原子写回」,谁也不认识对方的键,但都原样保留(见
/// AppConfigStore.saveWindowFrames 与 workbench-plugin/src/server/appConfig.ts 顶上的注释)。
struct WindowFrameStore: Equatable {
    var lastScreen: String?
    var frames: [String: RememberedFrame] = [:]

    static func decode(_ raw: Any?) -> WindowFrameStore {
        var store = WindowFrameStore()
        guard let dict = raw as? [String: Any] else { return store }
        if let last = dict["last_screen"] as? String, !last.isEmpty { store.lastScreen = last }
        if let screens = dict["screens"] as? [String: Any] {
            for (key, value) in screens {
                guard !key.isEmpty, let frame = RememberedFrame.decode(value) else { continue }
                store.frames[key] = frame
            }
        }
        return store
    }

    var encoded: [String: Any] {
        var screens: [String: Any] = [:]
        for (key, frame) in frames { screens[key] = frame.encoded }
        var out: [String: Any] = ["screens": screens]
        if let lastScreen { out["last_screen"] = lastScreen }
        return out
    }
}
