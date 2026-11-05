import Foundation

/// 系统通知「事务官有话问你 / 要你批一件事」的判断那一半(2026-09-25,卡 M)。
///
/// 维护者:「它有很多要我给权限的,它也不弹出来,还得我自己点过去事务官了,才看到有我要确认的」。
/// 工作台服务(8791)有新的一问 / 一条要批的,就经 helper 通道发 `notify`;壳在这里判要不要真弹:
///   - **壳在前台就不弹**:他正看着工作台,球下那一区已经有那张卡了,再弹一条是打扰;
///   - 标题、正文太长就截短(系统通知只摆两三行);空的不弹(服务端给坏数据时不弹一条空通知);
///   - 通知的标识带上 key(同一问服务端只发一次,万一重发也只留一条,系统按标识去重)。
/// 真弹框(UNUserNotificationCenter)在 ShellNotifier.swift,那一半碰 AppKit,不进单测。
/// 这个文件不 import AppKit,才编得进 run-tests.sh。
enum NotifyPolicy {
    /// 标题最多几个字(系统通知标题一行)。
    static let titleMax = 40
    /// 正文最多几个字(系统通知正文两三行)。
    static let bodyMax = 120

    /**
     * 工作台能不能发通知(2026-09-25,卡 M 追加;统筹:「维护者没点『允许』之前要能优雅退化,
     * 工作台里的气泡和数字照样有,不报错、不弹别的东西」)。系统那边的授权是异步读到的,壳记着最近一次读到的。
     *   - `unknown` 还没读到 / `notDetermined` 还没问过他:照常判,真弹之前壳去问一次(系统自己弹「允许通知吗」,只问一次);
     *   - `denied` 他没允许 / 后来关掉了:**不弹**,原因回给服务端进日志;不另弹任何东西 —— 气泡和数字在工作台里照旧;
     *   - `allowed` 允许了(含「临时允许」)。
     */
    enum Permission: Equatable {
        case unknown, notDetermined, denied, allowed

        /// 回给服务端的那个词(`/state.helper.notify.permission`)。
        var wire: String {
            switch self {
            case .unknown: return "unknown"
            case .notDetermined: return "not_determined"
            case .denied: return "denied"
            case .allowed: return "allowed"
            }
        }
    }

    /**
     * 回给服务端的一条通知状态(`notify_status`,卡 M 补;统筹:以前这一路静默失败 —— 服务端把结果吞了、壳也不看错误)。
     * 读到授权 / 问过他 / 交给系统之后各回一条:`key` 有就是交的那一条,`ok` 系统收没收,`error` 没收的原话。
     */
    static func statusPayload(permission: Permission, key: String? = nil, ok: Bool? = nil, error: String? = nil, at: Date = Date()) -> [String: Any] {
        var payload: [String: Any] = ["kind": "notify_status", "permission": permission.wire, "at": ISO8601DateFormatter().string(from: at)]
        if let key, !key.isEmpty { payload["key"] = key }
        if let ok { payload["ok"] = ok }
        if let error, !error.isEmpty { payload["error"] = error }
        return payload
    }

    struct Decision: Equatable {
        let show: Bool
        /// 不弹的原因(回给服务端,进它的日志,不上界面)。
        let reason: String?
        let identifier: String
        let title: String
        let body: String
    }

    static func decide(key: String, title: String, body: String, appActive: Bool, permission: Permission = .unknown) -> Decision {
        let cleanTitle = clip(title.trimmingCharacters(in: .whitespacesAndNewlines), titleMax)
        let cleanBody = clip(body.trimmingCharacters(in: .whitespacesAndNewlines), bodyMax)
        let identifier = "ben-wb-ask-\(key)"
        if key.isEmpty || cleanTitle.isEmpty {
            return Decision(show: false, reason: "没有 key 或标题", identifier: identifier, title: cleanTitle, body: cleanBody)
        }
        if appActive {
            return Decision(show: false, reason: "工作台在前台", identifier: identifier, title: cleanTitle, body: cleanBody)
        }
        if permission == .denied {
            return Decision(show: false, reason: "工作台的通知没开(他没点允许或关掉了);工作台里的气泡照旧", identifier: identifier, title: cleanTitle, body: cleanBody)
        }
        return Decision(show: true, reason: nil, identifier: identifier, title: cleanTitle, body: cleanBody)
    }

    /// 点了通知:从通知的 userInfo 里认出 key(没有就不是我们的通知)。
    static func key(fromUserInfo info: [AnyHashable: Any]) -> String? {
        guard let key = info["ben_wb_key"] as? String, !key.isEmpty else { return nil }
        return key
    }

    static func clip(_ text: String, _ max: Int) -> String {
        if text.count <= max { return text }
        return String(text.prefix(max)) + "…"
    }
}
