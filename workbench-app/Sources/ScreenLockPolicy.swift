import Foundation

/// ★ **「电脑锁着屏」这件事的全部判断**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
///
/// 现场(维护者那台,2026-10-03 09:04):她在手机「等你确认」里给 Kimi 的那条会话回了一句。
/// 工作台日志里 7 秒内 `[开App] com.moonshot.kimichat ← open -b` **五次**,最后一句是
/// `not_sent · answer_send · 找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有
/// (可能最小化了或只剩菜单栏图标)`。10:30 她人在电脑前再试就成了;10:38 把 Kimi 藏到后台
/// (`isHidden=true`)再捎一句也 6 秒送到。**唯一的差别是 09:04 那会儿电脑锁着屏**
/// (`pmset displaysleep 10` + `screenLock delay is immediate` —— 显示器一睡就锁)。
///
/// 锁屏时这一串事实是量到的,不是猜的:App 照旧在跑,可它**起不出窗**、辅助功能**一扇窗都列不出**,
/// 于是壳只能报「一扇标准窗口都没有」。那句话对她是**误导** —— 她会去查 Kimi 哪儿坏了,
/// 其实是电脑锁着。协议型的那两家(Claude 跨会话 socket、Codex `app-server`)不经窗口,**不受锁屏影响**。
///
/// 所以这一份只做三件事,**都是纯的**:
/// ① 从 `CGSessionCopyCurrentDictionary()` 那本字典里读出「这一刻锁着没有」({@link isLocked});
/// ② 把壳那句「没窗口」在锁屏时换成人话({@link lockedWhy});
/// ③ 给回包加上 {@link field} 那一格,让 8791 认得出来、`/state` 摆得出来({@link decorate})。
///
/// 真去问系统、真去订那两条分布式通知的那一半在 `ScreenLock.swift`(它才 import CoreGraphics)——
/// 与 `DisplayAwakePolicy` / `DisplayAwake` 同一条纪律:判断是纯的,`run-tests.sh` 编得动也测得了。
///
/// **读不出来就是读不出来**:字典拿不到、那一格缺席,一律按「没锁」算(D13:不编一个 ——
/// 编成「锁着」会把她好好的一次送话拦下来,而那是她看不见的)。
enum ScreenLockPolicy {

    // MARK: - 系统那两个名字

    /// 锁屏时 `CGSessionCopyCurrentDictionary()` 里多出来的那一格。
    ///
    /// 2026-10-03 在维护者这台(Darwin 25.6.0 / macOS 26)**没锁屏时量过**:整本字典是
    /// `CGSSessionUniqueSessionUUID / kCGSSessionAuditIDKey / kCGSSessionGroupIDKey /
    /// kCGSSessionLoginwindowSafeLogin / kCGSSessionOnConsoleKey / kCGSSessionSystemSafeBoot /
    /// kCGSSessionUserIDKey / kCGSSessionUserNameKey / kCGSessionLoginDoneKey /
    /// kCGSessionLongUserNameKey / kSCSecuritySessionID` —— **这一格压根不在里面**(`nil`),
    /// 而 `kCGSSessionOnConsoleKey` 是 1。锁上之后这一格才出现并且是 1
    /// (**这一半没能在本机验** —— 不锁维护者的屏;见交接「没验到」那一节)。
    ///
    /// 名字没有公开头文件(`CGSSession…` 这一串是 SkyLight 私有的),所以写成字符串常量,
    /// 并且**认不出就按没锁算** —— 哪天系统改了名字,最坏是回到今天这个样子(报「一扇窗都没有」),
    /// 不会把送话拦死。
    static let lockedKey = "CGSSessionScreenIsLocked"

    /// 这会儿是不是**她这个登录会话占着屏幕**(快速用户切换走开了就是 false)。
    /// 缺席 = 不知道(**不当成「不在控制台」**)。
    static let onConsoleKey = "kCGSSessionOnConsoleKey"

    /// 锁屏 / 解锁那两条分布式通知的名字(`DistributedNotificationCenter`)。
    /// 壳订上它们只为**记一行日志 + 立刻失效缓存**;「这一刻锁没锁」的权威出处永远是上面那本字典。
    static let lockedNotification = "com.apple.screenIsLocked"
    static let unlockedNotification = "com.apple.screenIsUnlocked"

    // MARK: - 这一刻锁着没有

    /// 把 `CGSessionCopyCurrentDictionary()` 那本字典读成一个「锁着没有」。
    ///
    /// 两种都算锁着(她都看不见、窗口都起不出来):① 锁屏那一格是真;
    /// ② 这个会话**明说**不占着屏幕(快速用户切换切走了)。
    /// 字典拿不到 / 两格都缺席 → `false`(不知道,不编)。
    static func isLocked(_ session: [String: Any]?) -> Bool {
        guard let session else { return false }
        if truthy(session[lockedKey]) == true { return true }
        // ★ `== false` 才算,`nil`(这一格缺席)不算 —— 不知道不许说成「她不在」。
        if truthy(session[onConsoleKey]) == false { return true }
        return false
    }

    /// 字典里那一格的真假。认 Bool 与数字(系统给的是 `1`);认不出回 `nil`(= 这一格没有话说)。
    static func truthy(_ value: Any?) -> Bool? {
        guard let value else { return nil }
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.intValue != 0 }
        if let number = value as? Int { return number != 0 }
        return nil
    }

    // MARK: - 回包那一格与那句人话

    /// 回包里那一格的名字(8791 认它)。
    static let field = "screen_locked"

    /// **不管锁没锁都带上那一格**的几个只读 op:它们不碰别人的窗口,服务端拿它们当「问一句锁没锁」的路
    /// (`/state` 据此摆出来)。`screen_info` 走主线程只读 NSScreen,`app_info` 只问 AX 与 `NSRunningApplication`。
    static let alwaysReport: Set<String> = ["screen_info", "app_info"]

    /// ★ **插件认的那几个字**(`workbench-plugin/src/server/screenLock.ts` 的 `SCREEN_LOCK_MARK`
    /// 与这个值**同一个字符串**,`tests/screen-lock-shell-text.test.ts` 读这个文件比对)。
    ///
    /// 为什么靠一截字认:壳回失败时服务端那一侧收到的只有 `error` 那句原话
    /// (`helperChannel` 在 `ok:false` 时 reject 一个 Error,回包里别的格一个都带不过去)。
    /// 口径同 `dispatchClient.classifyFailure` —— 那一处本来就是按壳的原话归类的。
    static let marker = "电脑锁着屏"

    /// 锁着屏、而壳又报了「没窗口」时该说的那句(**换掉那句误导的原话**)。
    ///
    /// 一定要说清三件:哪一家、为什么送不进、下一步 —— 她听了不会去查 Kimi,而是去解锁。
    ///
    /// **只说量到的那一件事**:锁着屏的时候那扇窗列不出来。
    /// 不许说「它还在跑」—— 换掉的那几句里也有「它没在运行」那一种({@link noWindowMarks}),
    /// 那时说「还在跑」就是一句不实的话。
    static func lockedWhy(_ bundleId: String) -> String {
        "\(marker),窗口型的家这会儿送不进:锁着屏的时候 \(bundleId) 的窗口一扇都列不出来 —— 解锁了就能送"
    }

    /// 壳那句原话是不是「一扇标准窗口都没有 / 它没在运行」那一类。
    ///
    /// 判据这两截字与 `SendTextPolicy.Failure.noWindow` / `.notRunning` 那两句同源,
    /// `Tests/main.swift` 里有一条对照断言钉着(**不写「逐字相同」注释代替测试**)。
    static let noWindowMarks = ["找不到窗口", "一扇标准窗口都没有"]

    static func looksLikeNoWindow(_ error: String) -> Bool {
        noWindowMarks.contains { error.contains($0) }
    }

    /// `locate` 那几种「读到了、可一扇窗都没有」的回包形状(`ok:true` + `running:true` + `windows:0`,
    /// 或者 `windows` 那一格压根没有)。这几条**不是失败**,所以要在 `result` 里加那一格。
    static func looksLikeNoWindowResult(_ result: [String: Any]) -> Bool {
        guard truthy(result["running"]) == true else { return false }
        let windows = result["windows"] as? Int ?? (result["windows"] as? NSNumber)?.intValue
        return windows == nil || windows == 0
    }

    /// ★ **一条回包 + 这一刻锁没锁 → 真回给服务端的那一条**(一处改,所有 op 都跟着对)。
    ///
    /// 三件事,各自只在该做的时候做:
    /// ① `alwaysReport` 那几个只读 op:`result` 里带上 `screen_locked`(真假都带 —— 服务端要的就是这个数);
    /// ② 锁着 + 这一条是「没窗口」那一类失败:**换掉 `error` 那句话**,并在顶上记一格
    ///    (顶上那一格只进壳 / 服务端的原始日志,服务端在 `ok:false` 时只收得到 `error`);
    /// ③ 锁着 + `locate` 那种「一扇窗都没有」的只读回包:`result` 里带上那一格。
    ///
    /// 没锁的时候,除了 ① 那一格,**一个字都不改**(老行为一字不变)。
    static func decorate(op: String, bundleId: String, res: [String: Any], locked: Bool) -> [String: Any] {
        var out = res
        let always = alwaysReport.contains(op)
        if always || locked { out[field] = locked }
        if always, var result = out["result"] as? [String: Any] {
            result[field] = locked
            out["result"] = result
        }
        guard locked else { return out }
        if truthy(out["ok"]) == false {
            if let error = out["error"] as? String, looksLikeNoWindow(error) {
                out["error"] = lockedWhy(bundleId)
            }
            return out
        }
        if var result = out["result"] as? [String: Any], looksLikeNoWindowResult(result) {
            result[field] = true
            out["result"] = result
        }
        return out
    }
}
