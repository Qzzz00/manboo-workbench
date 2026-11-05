import Foundation

/// 「点一下标签切换应用」这件事里**不碰系统 API 的那一半**:时限与预算的算术。
///
/// 2026-09-21 Ben 真机原话:「今天点击标签切换应用经常卡住」。统筹排查的结论(完整证据链见
/// `docs/交接-0921-切换标签卡住.md`):机器负载 100–200 时一次 `/dock/switch` 要好几秒,负载
/// 降到 5 之后只要 40ms —— 卡的不是我们的代码路径长,是**每一次 AX 调用都在同步等目标应用
/// 回话**,而目标应用(尤其 Claude / 微信 / 企业微信 这些 Chromium 系客户端)在高负载下一次
/// 能挂好几秒。壳里此前**一个 `AXUIElementSetMessagingTimeout` 都没有**,等于默认无限期等。
///
/// **这个文件故意不 import AppKit / ApplicationServices**(先例:`WindowPlacement.swift`、
/// `DragSense.swift`、`SendTextPolicy.swift` 顶上那三段)——`AXUIElement` 在单测里造不出来,
/// 而「一次切换的时间该怎么切给谁」恰恰是最该被钉死的部分。真去调 AX 的那一半在
/// `WindowControl.swift` / `HelperSocket.swift`,它们只做动作,一条算术都不自己下。
/// 测试跑法见 `workbench-app/run-tests.sh`。
///
/// 服务端(`workbench-plugin/src/server/dock.ts` 的 `SWITCH_TOTAL_BUDGET_MS` /
/// `SWITCH_HIDE_BUDGET_MS`)镜像着同一组数字 —— 两边各自独立成立:服务端管「这次切换整体
/// 超预算没有」,壳管「这一条请求在队里躺太久了没有、这一次 AX 调用等多久就放弃」。改数字
/// 要两边一起改,两边的注释互相指着对方。
enum SwitchBudget {

    // MARK: - 单次 AX 调用的时限

    /// 每个 AXUIElement 的消息时限(秒)。**为什么是 1 秒**:
    ///
    /// - 下限:健康应用回一次 `kAXWindowsAttribute` / `kAXPositionAttribute` 是毫秒级,
    ///   负载 100+ 时实测也在几十毫秒到一两百毫秒之间 —— 1 秒对「答得出来的那些」绰绰有余,
    ///   不会把正常调用误伤成超时。
    /// - 上限:一次切换要对目标那家做 `app_info` → `set_window_frame` → `raise_window`
    ///   三四次 AX 往返,再对上一家做一次藏。每次都顶满 1 秒已经是 3~4 秒 —— 再大就守不住
    ///   下面那条 3 秒总预算了。
    /// - 语义:超时按「**这家这次不动**」处理(`AXError` 回 `kAXErrorCannotComplete`),
    ///   不抛、不重试、不阻塞后面的家。宁可这一次没藏成(下次切换会再藏一遍),
    ///   也不能让整个壳的主线程陪着一个睡死的 Electron 应用一起卡住。
    ///
    /// 不做成可配置:能调的旋钮就是迟早要有人调错的旋钮,这个值该由证据改,不该由心情改。
    static let axMessagingTimeoutSeconds: Double = 1.0

    // MARK: - 一次切换的总预算

    /// 一次切换整体最多花多久(毫秒)才回 8791。超了就把没做完的挪到后台,不让用户干等。
    /// 3 秒是「人还愿意认为这是在响应我」的上限(再久他就会去点第二下,而第二下会排在
    /// 写队列后面,雪上加霜——真机上「卡住」的观感正是这么叠出来的)。
    static let totalMs = 3000

    /// 「藏别家」这一段的预算(毫秒)。抬起要切到的那家是用户**看得见**的那一半,优先级最高、
    /// 单独计时;藏别家是收尾,晚几百毫秒没人看得出来,所以它是可以被牺牲的那一段。
    static let hideOthersMs = 1500

    /// 抬窗那一段能用的时间(毫秒)= 总预算 - 留给藏别家的那一段。
    /// 抬窗自己超了也不是硬中断(窗已经在摆了,半途丢下更糟),只是往后的藏别家会因此没预算。
    static var raiseBudgetMs: Int { totalMs - hideOthersMs }

    /// 抬完窗之后,「藏别家」这一段还剩多少毫秒可用。
    ///
    /// - 抬窗很快 ⇒ 拿满 `hideOthersMs`(不会因为总预算还很宽裕就放宽,藏别家本来就只配这么多);
    /// - 抬窗拖久了 ⇒ 只剩总预算里没用掉的那点;
    /// - 抬窗把总预算吃光了 ⇒ 0,一家都不当场藏,全部进后台队列。
    static func hideBudgetMs(raiseElapsedMs: Int) -> Int {
        let leftOfTotal = totalMs - max(0, raiseElapsedMs)
        if leftOfTotal <= 0 { return 0 }
        return min(hideOthersMs, leftOfTotal)
    }

    /// 还该不该当场藏下一家:已经在藏别家上花了 `hideElapsedMs`,预算是 `budgetMs`。
    /// **等于**预算就算超(`>=`)——预算用光那一刻就该收手,不该再赌下一家很快。
    static func shouldDeferNextHide(hideElapsedMs: Int, budgetMs: Int) -> Bool {
        return hideElapsedMs >= budgetMs
    }

    // MARK: - 壳侧:排队太久的请求

    /// 这条请求在壳的串行队列里躺了 `queuedForMs` 毫秒,还该不该做?
    ///
    /// 壳把 AX 那几个 op 挪到了串行队列上(见 `HelperSocket`),排队本身就说明前面有一家在慢。
    /// 躺够 `hideOthersMs` 的请求,服务端那次切换八成早就过了预算、已经把结果回给用户了 ——
    /// 这时候再去动窗口,只会让屏幕在用户已经看到结果之后又跳一下。直接按「这家这次不动」
    /// 回一条如实的失败,比迟到的正确更好。
    ///
    /// 阈值复用 `hideOthersMs` 而不是另起一个数:队列里堆着的绝大多数就是藏别家那些请求,
    /// 两者本来就是同一段时间的两种说法。
    static func staleInQueue(queuedForMs: Int) -> Bool {
        return queuedForMs >= hideOthersMs
    }

    /// 排队太久时回给服务端的原话(壳不编新词:说清是壳自己主动放弃的,不是应用没反应)。
    static let staleInQueueMessage = "这条请求在壳里排队超过预算,这次不动(切换已经先回了结果)"
}
