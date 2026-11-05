import Foundation

/// 壳窗口的「前台 / 桌面」两种模式(2026-09-18,Ben:「安装完……现在的层级已经在底部了,
/// 导致我缩小了很多应用才看到页面,用户会觉得出 bug 了。登录和引导的时候,应该是和其他
/// 应用一样,能在顶部的,现在写死是底部。」)。
///
/// 背景:壳按 spec 是**桌面级**窗口——平时压在所有原生窗之下,贴合编排把认领的窗口摆到它
/// 的窗位槽上,那些窗口必须永远浮在它上面(见 AppDelegate 里 `window.level` 那段注释)。
/// 这在日常是对的,但**第一次打开**(登录、注册、首次流程、引导对话)时屏幕上根本没有窗位、
/// 也没有认领的窗口,压在底下的结果就是人看不见它。
///
/// 所以分两档:
///   - `.front`  —— 普通应用层(与别的 App 平起平坐),还会 activate + 置前;
///   - `.desktop`—— 比普通层低半级,原生窗天然排在它前面(原来写死的那一档)。
///
/// 这个文件**故意不 import AppKit**(同 WindowPlacement 的纪律):`NSWindow.Level` 造不出来,
/// 但「认不认这个 mode 字符串」「该用哪一档 level」是纯判断,单测里就能钉住。AppKit 那半截
/// (真的去设 level、activate)留在 AppDelegate。测试跑法见 workbench-app/run-tests.sh。
enum ShellWindowMode: String {
    /// 前台:普通应用层。壳**启动时的默认值**——那一刻还没连上工作台、不知道人走到哪一步了,
    /// 先让人看见比什么都重要(看不见的窗口没法登录)。连上之后由网页按阶段改。
    case front
    /// 桌面级:压在所有原生窗之下,贴合编排摆过来的窗口浮在它上面。
    case desktop

    /// 解析网页发来的 `mode` 字段。**认不出就是 nil,壳不猜**——同 HelperSocket 里
    /// 「未知 op」的纪律:宁可原样回一条错,也不拿一个猜出来的值去动窗口层级。
    static func parse(_ raw: Any?) -> ShellWindowMode? {
        guard let text = raw as? String else { return nil }
        return ShellWindowMode(rawValue: text)
    }

    /// 相对 `NSWindow.Level.normal` 的偏移。
    ///
    /// 桌面级是 `normal - 1`:**降半级而不是用 `.desktopIconLevel` 之类的系统档位**——
    /// 那些档位低到连键盘焦点都不正常,而壳仍然要能收点击、能打字(ShellWindow 覆盖了
    /// canBecomeKey/canBecomeMain,那跟层级是两回事)。`normal - 1` 刚好让普通层的窗口
    /// 天然排在它前面,又不掉出正常的交互范围。
    var levelOffset: Int {
        switch self {
        case .front: return 0
        case .desktop: return -1
        }
    }

    /// 切到这一档时要不要把 App 拉到最前(activate + makeKeyAndOrderFront)。
    ///
    /// 只有 `.front` 要:那是「像普通应用一样出现在人眼前」的全部意思。切回 `.desktop`
    /// 时**只改层级、不重排窗口**——此刻原生窗已经贴在窗位上了,再 order 一次只会把它们
    /// 的前后关系搅乱(降级本身已经足够让它们浮到壳上面)。
    var shouldActivate: Bool { self == .front }
}
