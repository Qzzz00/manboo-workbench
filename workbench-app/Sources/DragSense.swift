import CoreGraphics
import Foundation

/// 「用户正把哪扇窗拖到哪儿」的全部判断 —— **不靠辅助功能(AX)**。
///
/// 2026-09-18 Ben 真机原话:「网易云音乐、终端可以拖拽进去,也有交互反馈,Claude 和企业微信不行。」
/// 真机取证(`/state.dock.recent_ax` + `/debug/helper` 的 ax_probe)结论是:
///
/// - `com.anthropic.claudefordesktop`(Electron)与 `com.tencent.WeWorkMac`(企业微信)对
///   **任何一条** AX 属性读取都回 `-25211`(`kAXErrorAPIDisabled`),窗口列表恒为 0 扇,而
///   同一时刻 `CGWindowList` 看得见 1 扇真窗口;
/// - `com.netease.163music` / `com.apple.Terminal` 回 `0` + `AXApplication`,一切正常。
///
/// 也就是说这两家**根本不产生 `kAXWindowMovedNotification`** —— 不是 `dragged` 判错了,是
/// 事件压根没有。`recent_moves` 观测环里这两个 bundle 一条记录都没有,这是实锤。
///
/// 所以兜底这条链一个 AX 调用都不用:
/// - 「手按着没有」来自鼠标事件本身(`.leftMouseDown` / `.leftMouseDragged` / `.leftMouseUp`);
/// - 「哪扇窗、在哪儿」来自 `CGWindowList`(不走 AX 通道,上面那份取证里它是唯一还活着的真相源)。
///
/// **这个文件故意不 import AppKit**(先例:`WindowPlacement.swift` 顶上那段)——`NSEvent`、
/// `NSRunningApplication`、`CGWindowListCopyWindowInfo` 在单测里都造不出来,而「点在哪扇窗上」
/// 「什么时候算进圈出圈」「什么时候才算一次真的拖拽」恰恰是最容易写错、又最值得测的部分。
/// 取快照那半截留在 `WindowControl.swift` 里,这里只认已经取好的 `[ScreenWindow]`。
/// 测试跑法见 `workbench-app/run-tests.sh`。
///
/// 坐标系:AX 全局坐标(主屏左上角为原点,y 向下)。`CGWindowList` 的 `bounds` 本来就是
/// 这个坐标系,`CGEvent().location` 也是 —— 全链没有任何一次换算,这是**刻意**的
/// (AppKit 那套 y 向上的坐标一旦混进来,就多一处能算错的地方)。
struct ScreenWindow: Equatable {
    /// 这扇窗属于谁。取不到 bundle id 的进程(纯 CLI/守护进程开的窗)在取快照那一步就被丢掉了。
    let bundleId: String
    /// `kCGWindowNumber` —— 窗口在系统里的身份证。**位置会变,号不会**,跟踪一扇窗全靠它。
    /// AX 那条链吃过"按 frame 反查窗口身份"的亏(两扇窗 frame 逐字相等时位置根本不构成身份,
    /// 见 dock.ts 里那段),这里从一开始就不用位置认人。
    let windowNumber: Int
    /// AX 全局坐标下的窗口矩形。
    let frame: CGRect
}

/// 兜底链要告诉外面的事,只有两件。
enum DragEvent: Equatable {
    /// 悬停圈进出的**瞬间**(只在翻转时产生,不是逐帧)。这就是 Ben 说的"交互反馈"。
    case hover(Bool)
    /// 松手那一刻判定为「这次拖拽落在窗位里」——等价于 AX 那条链的落定上报。
    case settled(bundleId: String, frame: CGRect)
}

/// 一次左键拖拽的跟踪状态机。纯值语义,没有定时器、没有系统调用 —— 外面喂快照,它回事件。
struct DragTracker {
    /// 能当"被拖的窗"的最小尺寸。CGWindowList 的 layer 0 里混着一批小东西(真机实证:
    /// 企业微信、ChatGPT 的窗口列表里有 2560×30 的菜单条大小的幽灵窗、几个屏外小窗,见
    /// `WindowControl.standardWindows` 顶上那段)。AX 那条链靠 `AXStandardWindow` 子角色滤掉
    /// 它们,CG 这条链没有子角色可问,只能用尺寸下限 —— 门槛取得低,只想挡住菜单条那一类,
    /// 不想替用户判断"这扇窗够不够大值得拖"。
    static let minTrackableSide: CGFloat = 120

    /// 正在跟踪的那扇窗(松手/窗没了就清空)。
    private(set) var tracked: ScreenWindow?
    /// 这扇窗此刻在不在悬停圈里 —— 只在翻转时才发事件,天然节流(同 AX 那条链的 `hoverInside`)。
    private(set) var hoverInside = false
    /// 这扇窗**真的挪过**没有。只点一下不算拖拽:光标正好落在窗位上方的一次普通点击
    /// 不该把这个应用认领进窗位(D13:拿不准就不替用户做决定)。
    private(set) var movedSinceBegin = false

    init() {}

    /// 矩形中心点 —— 认"界内/界外"的口径,与服务端 `insideRect(center(frame), …)` 逐字一致。
    static func center(_ rect: CGRect) -> CGPoint {
        CGPoint(x: rect.origin.x + rect.width / 2, y: rect.origin.y + rect.height / 2)
    }

    /// 中心点落没落在圈里。圈不存在(服务端没报过窗位矩形、窗位被隐藏)时**一律 false**:
    /// 没有落点就没有"界内"这回事,不猜一个。
    static func inside(_ frame: CGRect, zone: CGRect?) -> Bool {
        guard let zone else { return false }
        return zone.contains(center(frame))
    }

    /// AX 那条链上「这扇窗算不算正悬在圈里」(2026-09-25,卡 P;维护者:「窗口槽的流线光效时不时自己闪一下,
    /// 其实没拖新应用进去」)。**只有左键按着(他在拖)才算**:点标签切换时我们自己把窗摆进槽、应用自己缩放 /
    /// 重建窗口、截图快捷键把藏着的应用放出来 —— 这些都会让窗的中心落进圈里,却没有人在拖,以前照样报进圈。
    static func hovering(_ frame: CGRect, zone: CGRect?, pressed: Bool) -> Bool {
        pressed && inside(frame, zone: zone)
    }

    /// 光标底下那扇窗是谁。
    ///
    /// `windows` 必须是**前后序**(最前面那扇排第一)—— `CGWindowListCopyWindowInfo` 带
    /// `.optionOnScreenOnly` 回的就是这个顺序,所以第一个命中的就是最上面那扇,不用比较层级。
    /// `eligible` 决定哪些 bundle 走兜底(实际接线里 = "AX 通道已经确认死掉的那些"):健康的
    /// 应用照旧走 AX 那条链,一个字都不改。
    static func windowUnder(_ point: CGPoint, in windows: [ScreenWindow], eligible: (String) -> Bool) -> ScreenWindow? {
        windows.first { win in
            win.frame.width >= minTrackableSide
                && win.frame.height >= minTrackableSide
                && win.frame.contains(point)
                && eligible(win.bundleId)
        }
    }

    /// 按窗号在新一批快照里找回正在跟踪的那扇窗。找不到 = 窗关了/挪到别的桌面去了。
    static func follow(_ tracked: ScreenWindow, in windows: [ScreenWindow]) -> ScreenWindow? {
        windows.first { $0.windowNumber == tracked.windowNumber }
    }

    /// 左键按下。
    ///
    /// **圈不存在就不开工**(`zone == nil` 直接返回空):没有窗位矩形就没有任何可认领的落点,
    /// 这时候跟踪一扇窗、每 100ms 读一次窗口列表,纯属白烧电 —— 兜底这条链的作用面必须
    /// 窄到"用户正对着窗位槽拖一扇 AX 死掉的窗"这一种情形。
    ///
    /// 按下这一刻**不发** hover:`hoverInside` 从 false 起步,第一次 `sample` 才可能翻转。
    /// 与 AX 那条链的 `updateHover` 同一口径(那边每扇窗的 `hoverInside` 也是 false 起步)。
    mutating func begin(at point: CGPoint, windows: [ScreenWindow], zone: CGRect?, eligible: (String) -> Bool) -> [DragEvent] {
        tracked = nil
        hoverInside = false
        movedSinceBegin = false
        guard zone != nil else { return [] }
        tracked = DragTracker.windowUnder(point, in: windows, eligible: eligible)
        return []
    }

    /// 拖动过程中的一次采样(调用方自己节流,见 `WindowControl` 那边的 100ms 闸)。
    /// 跟踪中的窗不见了就放弃跟踪,曾经进过圈的补一次 `hover(false)` —— 不留一个追不回来的高亮。
    mutating func sample(windows: [ScreenWindow], zone: CGRect?) -> [DragEvent] {
        guard let current = tracked else { return [] }
        guard let fresh = DragTracker.follow(current, in: windows) else {
            tracked = nil
            let events: [DragEvent] = hoverInside ? [.hover(false)] : []
            hoverInside = false
            return events
        }
        if fresh.frame != current.frame { movedSinceBegin = true }
        tracked = fresh
        let nowInside = DragTracker.inside(fresh.frame, zone: zone)
        guard nowInside != hoverInside else { return [] }
        hoverInside = nowInside
        return [.hover(nowInside)]
    }

    /// 左键松开 —— 这条链的"落定"。AX 那边落定是"300ms 没有新事件",这边不用等:
    /// 松手就是用户亲口说的"我摆完了",比任何去抖都准。
    ///
    /// 三个条件缺一不可才报 `settled`:还跟着一扇窗、这扇窗**真的挪过**、松手时中心点在圈里。
    /// 「真的挪过」那一条挡的是"光标正好落在窗位上方的一次普通点击" —— 那不是拖拽。
    ///
    /// 不管报不报 settled,曾经进过圈都补一次 `hover(false)`:拖拽已经结束,高亮不该留着
    /// (同 AX 那条链 `settle()` 里那一句)。
    mutating func end(windows: [ScreenWindow], zone: CGRect?) -> [DragEvent] {
        defer {
            tracked = nil
            hoverInside = false
            movedSinceBegin = false
        }
        guard let current = tracked else { return [] }
        let fresh = DragTracker.follow(current, in: windows) ?? current
        let moved = movedSinceBegin || fresh.frame != current.frame
        var events: [DragEvent] = []
        if hoverInside { events.append(.hover(false)) }
        if moved, DragTracker.inside(fresh.frame, zone: zone) {
            events.append(.settled(bundleId: fresh.bundleId, frame: fresh.frame))
        }
        return events
    }
}
