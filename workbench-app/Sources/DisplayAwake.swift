import Foundation
import IOKit.pwr_mgt

/// 「工作台在前台就常亮」的**真去动系统**那一半(2026-09-27,卡 IN)。
/// 要不要按住那条断言的判断全在 `DisplayAwakePolicy`(纯逻辑,run-tests.sh 里有用例),
/// 这里只有「按住」与「放掉」两个动作。
///
/// 按住的是 `kIOPMAssertPreventUserIdleDisplaySleep`:**只挡「闲着太久自动暗掉 / 睡过去」**。
/// 刻意不用 `PreventUserIdleSystemSleep`(那是整机不睡,工作台没理由要那个),
/// 也**挡不住**她自己合盖子、自己按快捷键锁屏、或者「节能」里那些她自己设的东西 ——
/// 这是对的:她主动的动作永远大于我们的断言。
///
/// 幂等:`apply` 拿同一个结论调多少次,系统里只有一条断言(或者一条都没有)。
/// 这一点要紧 —— 前台/后台那几个通知在真机上会连着来好几条。
///
/// 2026-10-03 多了第二个按住的理由(「出门时电脑不睡」,缺省关)。按的还是**同一条**
/// `kIOPMAssertPreventUserIdleDisplaySleep`,只是 `pmset -g assertions` 里那一行的名字
/// 按理由换(见 `DisplayAwakePolicy.assertionName(for:)`)—— 理由变了要重按一次,
/// 因为那一行的名字是创建那一刻定下的。整机那条断言照旧**不碰**(那是 `SystemAwake` 的事)。
final class DisplayAwake {
    /// 现在按着的那条断言。nil = 没按着。
    private var assertion: IOPMAssertionID?

    /// 现在按着的那条**是为什么按的**(2026-10-03)。nil = 没按着。
    /// 理由换了要重按一次 —— 断言的名字是创建那一刻定下的,`pmset -g assertions` 里
    /// 那一行不会自己改口,而维护者查「谁让我的屏幕不睡」看的就是那一行。
    private var reason: DisplayAwakePolicy.Reason?

    /// 最近一次记进日志的结论(只为日志少刷几行,不参与判断)。
    private var logged: DisplayAwakePolicy.Reason?

    /// 把这一刻的结论落实到系统上。**只在主线程调**(调用方都是 AppKit 的回调)。
    func apply(_ moment: DisplayAwakePolicy.Moment) {
        let want = DisplayAwakePolicy.holdReason(moment)
        if let want { hold(want) } else { release() }
        if want != logged {
            logged = want
            let why = want.map { "按住(\($0.rawValue))" } ?? "放掉"
            NSLog("DisplayAwake: \(why)(在前台=\(moment.appActive) 槽里那家在前=\(moment.slotAppFront) 窗在屏上=\(moment.windowVisible) 收进坞=\(moment.windowMiniaturized) 正在退出=\(moment.terminating) 出门=\(moment.awayKeepAwake))")
        }
    }

    private func hold(_ want: DisplayAwakePolicy.Reason) {
        // 已经按着同一条:什么都不做(幂等 —— 前台/后台那几个通知在真机上会连着来好几条)。
        if assertion != nil && reason == want { return }
        // 按着的是另一条理由:先放掉再按,好让 pmset 那一行跟着改口。
        if assertion != nil { release() }
        var id: IOPMAssertionID = IOPMAssertionID(0)
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertPreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            DisplayAwakePolicy.assertionName(for: want) as CFString,
            &id)
        // 拿不到就拿不到(极少见:断言数到了系统上限)。**不重试、不报错给她看** ——
        // 代价只是屏幕照常会暗,而她看不出这是一个失败。
        guard result == kIOReturnSuccess else {
            NSLog("DisplayAwake: 按不住(IOPMAssertionCreateWithName=\(result)),屏幕照系统设置暗")
            return
        }
        assertion = id
        reason = want
    }

    private func release() {
        guard let id = assertion else { return }
        assertion = nil
        reason = nil
        IOPMAssertionRelease(id)
    }

    deinit { release() }
}
