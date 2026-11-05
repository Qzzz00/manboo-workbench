import Foundation
import IOKit.pwr_mgt

/// 「工作台开着时整台电脑不睡」的**真去动系统**那一半(2026-09-28,卡 AW)。
/// 要不要按住的判断全在 `SystemAwakePolicy`(纯逻辑,run-tests.sh 里有用例),
/// 这里只有「按住」与「放掉」两个动作 —— 和 `DisplayAwake` 逐行同一个形状,
/// 区别只有一个:按住的是 `kIOPMAssertPreventUserIdleSystemSleep`(整机不睡),
/// 而不是 `PreventUserIdleDisplaySleep`(屏幕不暗)。**屏幕照样能灭、能锁。**
///
/// 幂等:同一个结论调多少次,系统里只有一条断言(或者一条都没有)。
final class SystemAwake {
    private var assertion: IOPMAssertionID?
    /// 最近一次算出来的结论(只为日志少刷几行,不参与判断)。
    private var held = false

    /// 把这一刻的结论落实到系统上。**只在主线程调**。
    func apply(_ moment: SystemAwakePolicy.Moment) {
        let should = SystemAwakePolicy.shouldHold(moment)
        if should { hold() } else { release() }
        if should != held {
            held = should
            NSLog("SystemAwake: \(should ? "按住" : "放掉")(开关=\(moment.settingOn) 正在退出=\(moment.terminating))")
        }
    }

    private func hold() {
        guard assertion == nil else { return }
        var id: IOPMAssertionID = IOPMAssertionID(0)
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertPreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            SystemAwakePolicy.assertionName as CFString,
            &id)
        // 拿不到就拿不到(极少见:断言数到了系统上限)。**不重试、不报错给她看** ——
        // 代价只是电脑照系统设置该睡就睡,而那正是加这条之前的样子。
        guard result == kIOReturnSuccess else {
            NSLog("SystemAwake: 按不住(IOPMAssertionCreateWithName=\(result)),电脑照系统设置睡")
            return
        }
        assertion = id
    }

    private func release() {
        guard let id = assertion else { return }
        assertion = nil
        IOPMAssertionRelease(id)
    }

    deinit { release() }
}
