import ApplicationServices

/// **读别人的窗口之前先敲一下门**(2026-09-26,卡 MQ 把三处散着的同一行收到这里)。
///
/// Chromium / Electron 系的应用平时**不建辅助功能树** —— 没有辅助功能客户端在场时,
/// 网页那一层的树根本不往外吐,读回来只有窗口壳和寥寥几个控件。苹果给这类应用定义了一个信号:
/// 往它的 AX 应用元素上写一次 `AXManualAccessibility`,意思是「有辅助功能客户端在场」,
/// 它据此把树建起来。原生应用没有这个属性,写它会报错(-25205 之类)—— **无害,忽略返回值**。
///
/// 为什么要收到一处:壳里有三条路都要读别人的窗口 —— 送话 / 找输入框(`TextInsert`)、
/// 读额度那几小段(`TextInsert.readTexts`)、判「像不像对话窗口」(`AgentWindow`),
/// 再加上挂窗口观察者(`WindowControl`)。哪条路漏了这一下,那条路看到的就是一棵空树,
/// 而空树和「这个 App 真没有输入框」在结果里长得一模一样(2026-09-26 登记表把两家 VS Code 系的
/// 应用判成「没有输入框、没有发送键」,第一反应就是怀疑这里漏了)。一处写、处处用,才不会再出现
/// 「这条路读得到、那条路读不到」。
///
/// **只加 `AXManualAccessibility`,不加 `AXEnhancedUserInterface`**(这是老 review 定下的取舍,
/// 原文见 `WindowControl.attachObserver` 上面那段):后者是更强的「进入辅助模式」开关,
/// 已知会让某些应用悄悄改自己的窗口尺寸 / 布局策略 —— 这个壳本来就要靠 `set_window_frame` 摆窗口,
/// 两者一起用有互相踩踏的风险。
///
/// **敲了门不等于树马上就好**:Chromium 收到信号后要重建整棵网页树,刚写完那一下拿到的元素引用
/// 可能已经作废(`TextInsert.sendText` 因此「必须重新 locate 再试一次」)。要立刻读的地方,
/// 自己按老办法留一拍或重试一次 —— 这里只负责敲门,不替调用方决定等多久。
enum AXWake {
    /// 这个进程的 AX 应用元素,**顺手敲过门**。
    static func app(_ pid: pid_t) -> AXUIElement {
        let appEl = AXUIElementCreateApplication(pid)
        knock(appEl)
        return appEl
    }

    /// 对着已经拿到的 AX 应用元素敲门(幂等:写多少次都一样,只对这一个 App)。
    static func knock(_ appEl: AXUIElement) {
        AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }
}
