import Foundation
import CoreGraphics

/// ★ **「这一刻锁着屏没有」的真去问系统那一半**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
///
/// 判断全在 `ScreenLockPolicy`(纯逻辑,`run-tests.sh` 里有用例),这里只有两个动作:
/// 问一次 `CGSessionCopyCurrentDictionary()`、订上那两条锁 / 解锁的分布式通知。
/// 与 `DisplayAwake` / `DisplayAwakePolicy` 同一条纪律。
///
/// **权威出处永远是那本字典**(每次真去问),通知只做两件事:记一行日志(真机排障要能对时间)、
/// 把那 {@link cacheMs} 毫秒的缓存立刻作废。为什么不只靠通知:
/// 通知是「变化」,而我们要答的是「此刻」—— 壳可能在锁屏之后才起来(重启、热更新换壳),
/// 那时一条通知都收不到,只有问字典才答得对。
///
/// 缓存只有 {@link cacheMs} 毫秒,为的是一串 op 连着来的时候别把同一件事问几十遍
/// (`dispatch` 在三条队列上跑,所以这里要加锁)。
enum ScreenLock {

    /// 问一次之后这个答案留多久(毫秒)。一串 op 连着来算同一刻;再长就会在她刚解锁那一下答错。
    static let cacheMs: Double = 200

    private static let lock = NSLock()
    private static var cached: (locked: Bool, at: CFAbsoluteTime)?
    /// 最近一次**说出来过**的结论(只为日志少刷几行,不参与判断)。
    private static var logged: Bool?

    /// 这一刻锁着屏没有。读不出来按「没锁」算(见 `ScreenLockPolicy.isLocked`)。
    static func locked() -> Bool {
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        if let cached, (now - cached.at) * 1000 < cacheMs {
            let answer = cached.locked
            lock.unlock()
            return answer
        }
        lock.unlock()
        let answer = ScreenLockPolicy.isLocked(CGSessionCopyCurrentDictionary() as? [String: Any])
        lock.lock()
        cached = (answer, now)
        let say = logged != answer
        if say { logged = answer }
        lock.unlock()
        if say { NSLog("ScreenLock: \(answer ? "锁着屏了" : "没锁屏")(窗口型的家\(answer ? "这会儿送不进" : "送得进"))") }
        return answer
    }

    /// 订上锁 / 解锁那两条通知(**只在主线程调一次**,壳启动时)。
    ///
    /// 收到就把缓存作废 + 记一行 —— 下一次真有人问的时候照旧去问字典。
    /// 订不上也不是失败(最坏是回到「每 200ms 问一次字典」),所以这里不报错给她看。
    static func start() {
        let center = DistributedNotificationCenter.default()
        for name in [ScreenLockPolicy.lockedNotification, ScreenLockPolicy.unlockedNotification] {
            center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { note in
                lock.lock()
                cached = nil
                lock.unlock()
                NSLog("ScreenLock: 收到系统通知 \(note.name.rawValue)")
                // 顺手问一次,日志里就有「这一刻的结论」那一行(也把缓存填回去)。
                _ = locked()
            }
        }
    }

    /// 用例 / 热更新换壳时把记性清掉(真机上没有调用方)。
    static func forget() {
        lock.lock()
        cached = nil
        logged = nil
        lock.unlock()
    }
}
