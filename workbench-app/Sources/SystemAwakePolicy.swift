import Foundation

/// 「工作台开着的时候,整台电脑别因为闲着而睡过去」这件事的**全部判断**(2026-09-28,卡 AW)。
///
/// 维护者原话(09-28 早,新 Air、不插电):「电脑自己会锁屏,可能跟没插电有关系,
/// 一锁屏小米上就显示找不到你的电脑。」
///
/// 真相是:锁屏本身没关系,**睡过去**才有关系 —— 电脑一睡,房间里那一方就消失了,
/// 手机上看起来和「配对坏了」一模一样。所以工作台在运行期间按住
/// `kIOPMAssertPreventUserIdleSystemSleep`:
///
///   - **系统不睡**:她在外面用手机还问得到这台电脑;
///   - 显示器**照样**可以灭、可以锁屏(那是 `PreventUserIdleDisplaySleep` 管的另一条,
///     卡 IN 的「在前台就常亮」原样保留);
///   - 插电 / 不插电都按住 —— 不插电时更费电,这条代价写在设置里那句人话上;
///   - 她自己**合盖**挡不住(合盖睡眠不是 idle sleep,断言管不着),也不去挡:
///     她主动的动作永远大于我们的断言。
///
/// 和 `DisplayAwakePolicy` 的分工:那条只在工作台**在最前面**时按住(切走就放掉),
/// 这条在工作台**活着**的整段时间里按住(只有退出才放掉)—— 因为她要的正是
/// 「人不在电脑前、屏幕黑着,手机还连得上」。
///
/// 为什么单独一个文件、为什么不 import AppKit / IOKit:同 DisplayAwakePolicy 那条纪律 ——
/// 判断是纯的,`run-tests.sh` 编得动也测得了;真去持有断言的那一半在 `SystemAwake.swift`。
enum SystemAwakePolicy {
    /// 这一刻的两个事实。
    struct Moment: Equatable {
        /// 设置里那颗开关(「工作台开着时电脑不睡」)是不是开着。**默认开**,见 `settingOn`。
        var settingOn: Bool
        /// 壳正在退出(`applicationWillTerminate`)。
        var terminating: Bool

        init(settingOn: Bool, terminating: Bool = false) {
            self.settingOn = settingOn
            self.terminating = terminating
        }
    }

    /// 这一刻要不要按着「整台电脑别因为闲着而睡」这条断言。
    ///
    /// 只有两种情况放掉:开关关着、或者壳正在退出。**没有「切走就放掉」**——
    /// 切走恰恰是她离开电脑的时候,而那正是手机要问得到这台电脑的时候。
    static func shouldHold(_ moment: Moment) -> Bool {
        if moment.terminating { return false }
        return moment.settingOn
    }

    /// app.json 里那颗开关的键(插件那边也认同一个:workbench-plugin/src/server/appConfig.ts)。
    static let settingKey = "system_awake_while_running"

    /// 缺省值:**开**。她买这台电脑不是为了守着它 —— 默认就该「开着工作台就找得到」,
    /// 费电这件事由设置里那句人话交代,不由一个默认关着的开关来交代。
    static let settingDefault = true

    /// 从 app.json 那一份字典里读那颗开关。
    ///
    /// **只认真正的布尔**:文件缺席、键缺席、写着别的类型(字符串 "false"、数字 0、乱码)
    /// 一律回缺省值 —— 读不懂一份配置不该让「电脑睡不睡」变成另一个答案。
    static func settingOn(_ json: [String: Any]?) -> Bool {
        guard let value = json?[settingKey] else { return settingDefault }
        guard let on = value as? Bool else { return settingDefault }
        return on
    }

    /// 断言在系统里显示的名字(`pmset -g assertions` 里看得到的那一行)。
    /// 写人话:维护者真去查「谁让我的电脑不睡」的时候,这一行就是答案。
    static let assertionName = "工作台开着,先别让电脑睡过去"
}
