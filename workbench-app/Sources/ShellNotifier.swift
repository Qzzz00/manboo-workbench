import AppKit
import UserNotifications

/// 系统通知真弹框的那一半(2026-09-25,卡 M)。判断在 NotifyPolicy(有单测),这里只碰系统:
///   - 第一次要弹时才问通知授权(系统会弹「“工作台”想给你发送通知」—— 只有他能点,点「允许」一次);
///   - 点了通知:壳回到前台、窗口置前,再经 helper 通道告诉服务端 `notification_click`(页面切到事务官、摊开那一张);
///   - 壳在前台时系统要当场展示的通知一律不展示(willPresent 回空)。
///
/// 没允许之前要**优雅退化**(卡 M 追加,统筹):不报错、不弹别的东西,工作台里的气泡和数字照旧 ——
///   - 授权问一次就够:他还没点的时候又来几问,不再叫系统问第二遍,先记着;
///   - 他点了「允许」:记着的那几条里**还没答掉的**才弹(答掉的已经收回去了);点了「不允许」:记着的全丢,以后不弹;
///   - 他后来在系统设置里关了 / 又开了:每次要弹前顺手再读一次授权,下一条按新的来;
///   - 壳不是从 .app 里起来的(没有 bundle id,开发时直接跑可执行文件):通知中心不能碰(一碰就崩),整个不弹。
/// 所有状态只在主线程上改;系统的回调在别的线程,先切回主线程。
final class ShellNotifier: NSObject, UNUserNotificationCenterDelegate {
    /// 他点了通知(主线程)。参数是服务端给的 key。
    var onClick: ((String) -> Void)?
    /**
     * 每读到一次授权、每问过他一次、每交一条给系统,回一条状态(主线程;卡 M 补)。AppDelegate 经 helper 通道交给服务端
     * (`/state.helper.notify`),同时这里 NSLog 一行进壳日志 —— 以前这一路静默失败,谁也说不清为什么没弹。
     */
    var onStatus: (([String: Any]) -> Void)?

    /// 最近一次读到的授权(主线程)。
    private(set) var permission: NotifyPolicy.Permission = .unknown
    /// 正在问他要不要允许(系统那个框开着)。
    private var asking = false
    /// 等授权那几秒里来的几条(按 key;答掉的会被 clear 拿掉)。
    private var waiting: [String: NotifyPolicy.Decision] = [:]

    /// 能不能碰通知中心:没有 bundle id 时 UNUserNotificationCenter.current() 会直接崩。
    private let available = Bundle.main.bundleIdentifier != nil

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    func install() {
        guard available else {
            NSLog("ShellNotifier: 没有 bundle id(不是从 .app 起来的),不碰通知中心")
            onStatus?(NotifyPolicy.statusPayload(permission: .denied, error: "壳不是从 .app 起来的,弹不了系统通知"))
            return
        }
        center.delegate = self
        refreshPermission()
    }

    /// 把此刻知道的授权再报一次(服务端刚连上 / 刚换了插件时,AppDelegate 调)。
    func reportStatus() {
        guard available else { return }
        refreshPermission()
    }

    /// 弹一条。`appActive` 由调用方(主线程)读 NSApp.isActive。回的是这一下的判断(授权结果是异步的)。
    func show(key: String, title: String, body: String, appActive: Bool) -> NotifyPolicy.Decision {
        let decision = NotifyPolicy.decide(key: key, title: title, body: body, appActive: appActive,
                                           permission: available ? permission : .denied)
        guard decision.show else {
            // 以前没允许:顺手再读一次(他可能刚在系统设置里打开),下一条按新的来;这一条没弹也回给服务端。
            if available && permission == .denied {
                NSLog("ShellNotifier: 通知没开,key=\(key) 没弹")
                onStatus?(NotifyPolicy.statusPayload(permission: .denied, key: key, ok: false, error: "系统没让工作台发通知"))
                refreshPermission()
            }
            return decision
        }
        if permission == .allowed {
            post(decision, key: key)
        } else {
            waiting[key] = decision
            askOnce()
        }
        return decision
    }

    /// 那一问答掉了:把还挂在通知中心里的那一条收掉(点一条已经答过的通知没有意义);还没弹出去的也不弹了。
    func clear(key: String) {
        waiting.removeValue(forKey: key)
        guard available else { return }
        let identifier = NotifyPolicy.decide(key: key, title: "x", body: "", appActive: false).identifier
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
    }

    /// 读一次系统那边的授权(不问他),读到就记日志、回给服务端。
    private func refreshPermission() {
        guard available else { return }
        center.getNotificationSettings { [weak self] settings in
            let status = settings.authorizationStatus
            let alert = settings.alertSetting.rawValue
            let center = settings.notificationCenterSetting.rawValue
            DispatchQueue.main.async {
                guard let self else { return }
                self.permission = ShellNotifier.permission(of: status)
                NSLog("ShellNotifier: 读到通知授权 status=\(status.rawValue) alert=\(alert) center=\(center) → \(self.permission.wire)")
                self.onStatus?(NotifyPolicy.statusPayload(permission: self.permission))
            }
        }
    }

    /// 问他一次要不要允许(系统自己的框)。已经在问了就不再问。
    private func askOnce() {
        guard available, !asking else { return }
        asking = true
        center.getNotificationSettings { [weak self] settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async {
                guard let self else { return }
                if status == .notDetermined {
                    NSLog("ShellNotifier: 还没问过他,请求通知授权")
                    self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                        let message = error.map { "\($0.localizedDescription)" }
                        DispatchQueue.main.async {
                            NSLog("ShellNotifier: 授权结果 granted=\(granted) error=\(message ?? "无")")
                            self.onStatus?(NotifyPolicy.statusPayload(permission: granted ? .allowed : .denied, error: message))
                            self.settle(granted ? .allowed : .denied)
                        }
                    }
                } else {
                    self.settle(ShellNotifier.permission(of: status))
                }
            }
        }
    }

    /// 授权有结果了(主线程):允许 → 记着的那几条(还没答掉的)弹出去;不允许 → 全丢。
    private func settle(_ result: NotifyPolicy.Permission) {
        asking = false
        permission = result
        let held = waiting
        waiting.removeAll()
        guard result == .allowed else {
            if !held.isEmpty {
                NSLog("ShellNotifier: 没有通知授权,\(held.count) 条没弹")
                for key in held.keys { onStatus?(NotifyPolicy.statusPayload(permission: result, key: key, ok: false, error: "系统没让工作台发通知")) }
            }
            return
        }
        for (key, decision) in held { post(decision, key: key) }
    }

    private static func permission(of status: UNAuthorizationStatus) -> NotifyPolicy.Permission {
        switch status {
        case .authorized, .provisional: return .allowed
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    private func post(_ decision: NotifyPolicy.Decision, key: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = decision.title
        content.body = decision.body
        content.sound = .default
        content.userInfo = ["ben_wb_key": key]
        let request = UNNotificationRequest(identifier: decision.identifier, content: content, trigger: nil)
        // 系统收没收都记下来、回给服务端(卡 M 补):以前这里 `{ _ in }` 把错误吞了,没弹也没人知道为什么。
        // 界面上照旧不报错 —— 工作台里的气泡本来就不靠通知;要不要提醒他去系统设置,服务端据此判。
        center.add(request) { [weak self] error in
            let message = error.map { "\($0.localizedDescription)" }
            DispatchQueue.main.async {
                guard let self else { return }
                NSLog("ShellNotifier: 交给系统 key=\(key) \(message == nil ? "收下了" : "没收下:\(message!)")")
                self.onStatus?(NotifyPolicy.statusPayload(permission: self.permission, key: key, ok: message == nil, error: message))
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // 壳在前台:不当场展示(球下那一区已经有那张卡了)。
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let key = NotifyPolicy.key(fromUserInfo: response.notification.request.content.userInfo)
        DispatchQueue.main.async { [weak self] in
            if let key { self?.onClick?(key) }
            completionHandler()
        }
    }
}
