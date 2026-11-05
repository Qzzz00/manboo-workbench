import AppKit
import ApplicationServices
import UserNotifications

/// 「装的时候把授权一次做完」,壳这一侧真去发起那一问的那一半(2026-09-27,卡 IN)。
/// 参数怎么认、状态文件长什么样在 `GrantMode.swift`(纯逻辑,有用例)。
///
/// ## 这一趟的壳长什么样
///
/// **不建窗口、不连 8791、不注册登录项、不摆窗口**。它是一个短命进程:
/// 发起那一问 → 每秒盯一下系统那边翻没翻 → 写 `~/.dsh/workbench/grants.json` → 退出。
/// 安装器那一屏轮询那份文件,翻了就把那一行画成「已完成」。
///
/// 为什么不让安装器自己弹框:**授权是按 App 记的**。安装器调那一下,系统记的是
/// 「安装工作台」—— 那个 App 装完就再也不会被打开,而真要摆窗口的「工作台」仍然没授权。
///
/// ## 为什么要「每秒盯一下」而不是等一个回调
///
/// 辅助功能没有"授权变了"的系统回调(壳平时也是靠回到前台时重查一次)。
/// 她点完系统框还要去系统设置里拨那个开关,这中间是几十秒。所以这一趟就是轮询,
/// 到了 `deadline` 还没翻就把此刻的事实写下来退出 —— **不假装成功**,
/// 安装器那一行仍然是「还没允许」,她可以再点一次,也可以先跳过。
enum GrantRun {
    /// 最长盯多久(秒)。她去系统设置里拨那个开关、回来,几十秒是常事;
    /// 超过五分钟就当她走开了 —— 进程不该一直挂着。
    static let deadline: TimeInterval = 300

    /// 跑这一趟。调完**不会返回**(自己 `exit`)。
    static func run(_ request: GrantRequest) {
        // 这一趟没有界面。`.prohibited` 让它不出现在程序坞、不抢焦点 ——
        // 她眼前应该只有安装器那一屏,加上系统自己弹的那个框。
        NSApp.setActivationPolicy(.prohibited)

        if request.checkOnly {
            GrantStatusFile.merge(currentStates(request.kinds))
            exit(0)
        }

        // 先把这一刻的现状写下来:安装器那一屏可能正等着第一份答案。
        GrantStatusFile.merge(currentStates(request.kinds))

        for kind in request.kinds {
            switch kind {
            case .accessibility: askAccessibility()
            case .notifications: askNotifications()
            }
        }

        // 轮询到都翻了、或者到点。
        let started = Date()
        DispatchQueue.global().async {
            while Date().timeIntervalSince(started) < deadline {
                let states = currentStates(request.kinds)
                GrantStatusFile.merge(states)
                // 都不是「还不知道 / 还没给」了就收工。通知被她按了「不允许」也算有答案 ——
                // 那是她的决定,不该让安装器一直转圈等。
                if request.kinds.allSatisfy({ states[$0] != nil && states[$0] != .unknown && states[$0] != .missing }) { break }
                Thread.sleep(forTimeInterval: 1)
            }
            GrantStatusFile.merge(currentStates(request.kinds))
            exit(0)
        }
        NSApp.run()
    }

    /// 此刻这几样各是什么状态。**读,不问**。
    static func currentStates(_ kinds: [GrantKind]) -> [GrantKind: GrantState] {
        var states: [GrantKind: GrantState] = [:]
        for kind in kinds {
            switch kind {
            case .accessibility:
                states[kind] = AXIsProcessTrusted() ? .granted : .missing
            case .notifications:
                states[kind] = notificationState
            }
        }
        return states
    }

    /// 通知那一问的状态。`UNUserNotificationCenter` 的读是异步的,这里同步等一下
    /// (一个短命进程,等 2 秒不碍任何人);等不到就是「不知道」,**不编一个答案**。
    private static var notificationState: GrantState {
        guard Bundle.main.bundleIdentifier != nil else { return .unknown }
        var answer: GrantState = .unknown
        let semaphore = DispatchSemaphore(value: 0)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: answer = .granted
            case .denied: answer = .missing
            case .notDetermined: answer = .unknown
            @unknown default: answer = .unknown
            }
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 2)
        return answer
    }

    /// 辅助功能那一问。带 prompt 的这一下同时把「工作台」**登记进**系统设置那张表
    /// —— 从没调过它,那张表里压根没有「工作台」这一行,她只能按 + 自己去找。
    /// 已经授权了就只是查一下,不会弹。
    private static func askAccessibility() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }

    /// 通知那一问(系统弹「“工作台”想给你发送通知」)。已经问过了系统不会再弹。
    private static func askNotifications() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            GrantStatusFile.merge([.notifications: granted ? .granted : .missing])
        }
    }
}
