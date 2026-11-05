import CoreGraphics
import Foundation

/// 壳顶上那一条(2026-09-25,卡 TB;维护者原话「客户端没法全屏、顶部空隙难受」)。
///
/// 病在**顶上叠了两三层**:系统菜单栏、壳自己那条标题栏、网页里的「工作台」标题行 + 状态行。
/// 原生全屏永远不做(独占 Space 后贴合编排摆过来的别家窗口看不见,`collectionBehavior = .fullScreenNone`
/// 是写死的),能去掉的是壳那条标题栏:
///
/// - 窗口仍是 `.titled`(**不是**无边框——spec S1 的无边框模式在部分真机上让 WKWebView 的输入框
///   判断不到自己在前台,那个坑不许回来),只是标题栏透明、标题隐藏,`styleMask` 多一个
///   `.fullSizeContentView` 把内容区撑到窗顶;红绿灯浮在网页顶栏上。
/// - 标题栏没了,**拖窗口**也就没了落点:网页顶栏空白处 mousedown → 经壳注册的
///   WKScriptMessageHandler(与加载占位同一条通道 `benWorkbenchShell`)发 `titlebar_drag`
///   → 壳 `performDrag(with:)`,拖动手感、贴边、跨屏全交给系统,和原生标题栏同一条路径。
/// - 双击表头照系统习惯:「桌面与程序坞 → 连按标题栏来」那一项(`AppleActionOnDoubleClick`)
///   说缩放就 zoom、说最小化就 miniaturize、说什么都不做就真的不做。
///
/// 这个文件**故意不 import AppKit**(先例:`WindowPlacement.swift` 顶上那段):`NSWindow.StyleMask`、
/// `UserDefaults`、`NSEvent` 在单测里造不出来,而「styleMask 到底含没含 fullSizeContentView」
/// 「哪条消息算拖动」「系统设置那三个值分别怎么做」恰恰是最值得测的部分。AppKit 那半截在
/// `AppDelegate.swift` 里,测试跑法见 `workbench-app/run-tests.sh`。
enum ShellTitleBar {
    /// 页面 → 壳的通道名。与加载占位共用一条:壳只注册一个 handler,按 body 里的 `type` 分流
    /// (`ready` 归 LoadingCover,`titlebar_*` 归这里),不给页面多开一条通道。
    static var handlerName: String { LoadingCover.handlerName }

    // MARK: - styleMask
    //
    // NSWindow.StyleMask 的原始值(AppKit 头文件里的定义,写在这里才测得了):
    // titled 1<<0 / closable 1<<1 / miniaturizable 1<<2 / resizable 1<<3 / fullSizeContentView 1<<15。

    static let titled: UInt = 1 << 0
    static let closable: UInt = 1 << 1
    static let miniaturizable: UInt = 1 << 2
    static let resizable: UInt = 1 << 3
    static let fullSizeContentView: UInt = 1 << 15

    /// 壳窗口的 styleMask。关闭/最小化/缩放三颗键与可缩放都留着(不懂技术的人第一件事就是
    /// 关窗和缩窗),多的只是 `.fullSizeContentView`。
    static let styleMask: UInt = titled | closable | miniaturizable | resizable | fullSizeContentView

    /// 标题栏透明 + 标题文字隐藏。写成常量只为「这两条是有意为之」留一处断言。
    static let titlebarAppearsTransparent = true
    static let titleHidden = true

    /// 网页顶栏左边要给红绿灯留出的宽度(pt)。三颗键在 x≈7/27/47,直径 12,最右一颗到 ≈59;
    /// 留到 78 是让名字与第一颗小灯离它有一口气,不贴着。
    /// 插件那一侧同一个数写在 `workbench-plugin/src/client/style.ts`(`--ben-wb-traffic-inset`)。
    static let trafficLightInset: CGFloat = 78

    // MARK: - 网页发来的那两条消息

    /// 网页顶栏上发生的事,壳只认这两件。
    enum Message: Equatable {
        /// 顶栏空白处按下了左键:接着拖就是拖窗口。
        case drag
        /// 双击了顶栏空白处:照系统设置做。
        case doubleClick
        /// 顶栏「换屏」(2026-09-27):把窗口搬到下一块屏、按那块屏铺好。
        case moveScreen
    }

    /// 认不认这条消息(名字对、主框架发的、body 是 `{type:'titlebar_drag' | 'titlebar_dblclick'}`)。
    ///
    /// 主框架以外(内嵌的事务官 iframe 等)一概不认:那里的顶栏不是窗口的顶栏,拖它没有意义。
    /// 这两条消息都不带数据,页面伪造了最多也只是「窗口被拖了一下」,没有别的权限。
    static func message(name: String, body: Any, isMainFrame: Bool) -> Message? {
        guard name == handlerName, isMainFrame else { return nil }
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
        switch type {
        case "titlebar_drag": return .drag
        case "titlebar_dblclick": return .doubleClick
        case "titlebar_move_screen": return .moveScreen
        default: return nil
        }
    }

    // MARK: - 双击表头

    /// 双击标题栏该做什么。照系统设置「桌面与程序坞 → 连按标题栏来」那一项走,不自己定。
    enum DoubleClick: Equatable {
        case zoom
        case miniaturize
        /// 系统设置里选的是「什么都不做」——那就真的不做。
        case ignore
    }

    /// `AppleActionOnDoubleClick`(NSGlobalDomain)的三个值:Maximize / Minimize / None。
    /// **没设过**(绝大多数机器)按系统缺省 Maximize —— 缺省不是「不做」。
    /// 认不出来的值也按缺省走:宁可缩放一下,也不要双击毫无反应显得窗口坏了。
    static func doubleClickAction(setting: String?) -> DoubleClick {
        guard let raw = setting?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return .zoom }
        switch raw.lowercased() {
        case "minimize": return .miniaturize
        case "none": return .ignore
        default: return .zoom
        }
    }
}
