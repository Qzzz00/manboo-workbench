import Foundation

/// ★ **读窗按包各排各的队**(2026-10-21,卡「派活按家隔离」;全景地图「最脆处 · 一 堵塞与连坐」)。
///
/// 从前壳所有读窗(`read_reply` / `agent_read` / `agent_probe`……)走**一条**串行队列:一家慢(那家的
/// 辅助功能树大、或者它卡住了),后面排着的所有别家的读都跟着等,插件那一头一个个超时 ——
/// 一家读不动,所有别家的派活卡都没人盯。现在:
///
/// - **按包分队**:读某一家窗口的那几样,一个包一条串行队列(同一扇窗的读不并发,别家不排在它后面);
///   不看包的只读(列 App、取图标)共用一条;
/// - **排过头的不读**:插件那一头读窗 15 秒就不等了,在队里躺过 {@link staleMs} 的那一下再读也没人收,
///   当场回一句(同 `SwitchBudget.staleInQueue` 那一条的道理,那条只管切窗那几样);
/// - **撤读**:插件「重置这一家」时发 `cancel_reads`,那几个包还没开始的读一律回「撤了」;
/// - **一次读窗有墙钟上限**({@link readBudgetMs}):读不完就停(从前没有上限,慢的那一家能在队里遍历很久)。
///
/// 这一份不碰 AppKit / AX,只记账(才编得进 `run-tests.sh`);真正的队列与读窗在 `HelperSocket` / `TextInsert`。
final class ReadLanes {
    /// 不看包的那几样共用的那条队。
    static let sharedKey = "_shared"
    /// 按包分队的那几样(都是读某一家的窗口)。
    static let perBundleOps: Set<String> = ["read_reply", "agent_probe", "agent_read", "agent_ax_detail", "agent_images"]
    /// 排过这么久就不读了(插件那一头读窗是 15 秒)。
    static let staleMs = 15_000
    /// 一次读窗最多读多久(比插件那一头的 15 秒短:超过 15 秒读完也没人收)。
    static let readBudgetMs = 12_000

    static func laneKey(op: String, bundleId: String) -> String {
        guard perBundleOps.contains(op), !bundleId.isEmpty else { return sharedKey }
        return bundleId
    }

    static func staleSay(waitedMs: Int) -> String {
        "这一下读窗在壳里排了 \(waitedMs / 1000) 秒(前面那一下还没读完),这次不读了"
    }

    static let cancelledSay = "这一家的读窗刚被撤了(重置这一家),这次不读"

    static func budgetSay(ms: Int) -> String {
        "读这扇窗读了 \(ms / 1000) 秒还没读完(那家太慢或这扇窗太大),先停下"
    }

    struct Ticket: Equatable {
        let key: String
        let generation: Int
        let queuedAt: Date
    }

    enum Verdict: Equatable {
        case run
        case cancelled
        case stale(waitedMs: Int)
    }

    private let lock = NSLock()
    private var generations: [String: Int] = [:]
    private var waiting: [String: Int] = [:]

    func enter(_ key: String, at now: Date = Date()) -> Ticket {
        lock.lock(); defer { lock.unlock() }
        waiting[key, default: 0] += 1
        return Ticket(key: key, generation: generations[key] ?? 0, queuedAt: now)
    }

    /// 轮到这一下时问一次:读、还是不读(撤了 / 排过头)。问过就不再算「排着」。
    func verdict(_ ticket: Ticket, at now: Date = Date()) -> Verdict {
        lock.lock(); defer { lock.unlock() }
        if (generations[ticket.key] ?? 0) != ticket.generation { return .cancelled }
        waiting[ticket.key] = max(0, (waiting[ticket.key] ?? 0) - 1)
        let waitedMs = Int(now.timeIntervalSince(ticket.queuedAt) * 1000)
        if waitedMs > Self.staleMs { return .stale(waitedMs: waitedMs) }
        return .run
    }

    /// 撤掉这几个包还没开始的读;回撤了几下。
    @discardableResult
    func cancel(_ keys: [String]) -> Int {
        lock.lock(); defer { lock.unlock() }
        var count = 0
        for key in Set(keys) {
            generations[key, default: 0] += 1
            count += waiting[key] ?? 0
            waiting[key] = 0
        }
        return count
    }

    func pending(_ key: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return waiting[key] ?? 0
    }
}
