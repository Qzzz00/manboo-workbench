import Foundation

/// 「工作台在前台的时候,别让屏幕自己暗下去」这件事的**全部判断**(2026-09-27,卡 IN)。
///
/// 维护者原话:「只要工作台在前台,电脑就常亮,这个也得有」。
///
/// 为什么单独一个文件、为什么不 import AppKit:和 WindowPlacement / NotifyPolicy 同一条纪律 ——
/// 判断是纯的,`run-tests.sh` 编得动也测得了;真去持有那条电源断言(IOPMAssertionCreateWithName)
/// 的那一半在 `DisplayAwake.swift`,它才 import IOKit。
///
/// **不给设置开关**(维护者 2026-09-27 拍板):它只在她正看着工作台的时候管用,切走就放掉 ——
/// 一个只在"你正看着它"的时候生效的东西,不需要一颗开关来解释自己。
///
/// ## 2026-10-04:「在前台」= 工作台自己在前,**或者槽里那一家在前**
///
/// 维护者 10-04 原话:「我说的是锁屏的修复没有生效……之前做了一个只要工作台在前台就不锁屏的修复」。
/// 她用工作台的常态是点进**窗口槽里的真窗**(Codex / Claude / 豆包…),那时最前面的 App 是那一家,
/// 工作台 `isActive=false`,这条断言被放掉 —— 于是屏暗、锁屏。详见 `holdReason` 与
/// `docs/交接-1004-常亮认窗口槽里的程序.md`。
/// 「槽里是谁」**一处主人**:dock.json 那一叠,插件经新的 `slot_apps` op 下发;壳只对一下
/// (`slotAppFront(front:members:)`),不另造表、不自己猜。
///
/// ## 2026-10-03 多了一颗开关:「出门时电脑不睡」(**缺省关**)
///
/// 前因见 `docs/交接-1003-锁屏时窗口型的家.md` 第四节:本机 `displaysleep 10` +
/// `screenLock delay is immediate` —— 她离开 10 分钟屏幕就睡,一睡**立刻锁**,
/// 而锁屏时窗口型的家(豆包 / Kimi / Manus…)一扇窗都列不出来,她在外面答的那句话送不进去。
/// 上面那条断言在那一幕里**一定是放掉的**(她不在电脑前,工作台当然不是最前面那个)。
///
/// 所以维护者拍板加一颗开关:**手机在外面连着(出门)时,不管工作台在不在最前面都按住**。
/// 这一格由插件那边算好(「开关开着」**且**「真有一台已配对手机经中转连着」),
/// 经 helper 的 `away_awake` op 下发;壳只收结论,一个判断都不自己做
/// (同 `SystemAwakePolicy` 那颗开关的分工:落盘与判断在插件,壳只管立刻生效)。
///
/// 代价写在设置里那句人话上:**出门在外的时候,家里那块屏一直亮着**。
/// 所以缺省关 —— 这一条和「工作台在前台就常亮」不一样,她看不见自己家的屏幕亮不亮。
enum DisplayAwakePolicy {
    /// 按住那条断言的**理由**。只为两件事:`pmset -g assertions` 里那一行写哪句话、日志里记哪一种。
    ///
    /// 顺序有讲究:两条理由同时成立时先认 `away` —— 她这会儿真不在电脑前,
    /// 那一行该说的是「出门模式」,不是「工作台在前台」(后者在她眼里是假话)。
    enum Reason: String, Equatable {
        /// 工作台自己在最前面、窗在屏上、没收进坞(2026-09-27,卡 IN)。
        case foreground
        /// 「出门时电脑不睡」开着,而且此刻真有一台已配对手机经中转连着(2026-10-03)。
        case away
        /// 最前面那个 App 是**窗口槽里的那一家**(Codex / Claude / 豆包…),壳那扇窗还在屏上(2026-10-04)。
        case slotApp
    }

    /// 这一刻的六个事实。前四个由 AppDelegate 从 AppKit 读,读完原样传进来;
    /// `awayKeepAwake` 由服务端下发(`away_awake` op),`slotAppFront` 由壳拿
    /// 「最前面是谁」对插件下发的成员表(`slot_apps` op)算一下(`slotAppFront(front:members:)`)。
    struct Moment: Equatable {
        /// 工作台是不是当前最前面那个 App(`NSApp.isActive`)。
        var appActive: Bool
        /// 壳那扇窗还在不在屏上(`window.isVisible` —— 藏起来 / 关掉了就是 false)。
        var windowVisible: Bool
        /// 那扇窗有没有被收进程序坞(`window.isMiniaturized`)。
        var windowMiniaturized: Bool
        /// 壳正在退出(`applicationWillTerminate`)。
        var terminating: Bool
        /// 「出门时电脑不睡」此刻成不成立(2026-10-03)。服务端算好下发的一个结论:
        /// 开关开着 **且** 真有一台已配对手机经中转连着。**缺省假** —— 缺省就是 2026-10-03 之前的行为。
        var awayKeepAwake: Bool
        /// 此刻最前面那个 App 是**窗口槽里的那一家**(2026-10-04)。**缺省假** ——
        /// 缺省就是 2026-10-04 之前的行为(成员表还没下发、旧插件不发这一格时也是这个值)。
        var slotAppFront: Bool

        init(appActive: Bool, windowVisible: Bool, windowMiniaturized: Bool,
             terminating: Bool = false, awayKeepAwake: Bool = false, slotAppFront: Bool = false) {
            self.appActive = appActive
            self.windowVisible = windowVisible
            self.windowMiniaturized = windowMiniaturized
            self.terminating = terminating
            self.awayKeepAwake = awayKeepAwake
            self.slotAppFront = slotAppFront
        }
    }

    /// 「此刻最前面那个 App 是窗口槽里的那一家吗」—— 一句纯判断,壳在 `refreshDisplayAwake` 里调(2026-10-04)。
    ///
    /// `front` = `NSWorkspace.shared.frontmostApplication?.bundleIdentifier`(**现问现答,壳不存**);
    /// `members` = 插件经 `slot_apps` op 下发的窗口槽成员 bundle id(**一处主人**:dock.json 那一叠,
    /// 壳不另造一张表、也不自己猜谁在槽里)。
    ///
    /// 问不出最前面是谁、或者成员表还没下发(空)→ **假**,按 `holdReason` 那句
    /// 「宁可放掉也不要按着不放」。
    static func slotAppFront(front: String?, members: Set<String>) -> Bool {
        guard let front, !front.isEmpty else { return false }
        return members.contains(front)
    }

    /// 这一刻按着那条断言是**为什么**(`nil` = 不按)。`shouldHold` 就是这一条的"有没有"。
    ///
    /// - 正在退出:一定放掉(不留一条没人管的断言)——**出门模式也不例外**;
    /// - 出门那一格为真:按住,**不看前台**(她不在电脑前,前台那几条本来就都不成立);
    /// - 否则照 2026-09-27 那三条:在前台 + 窗在屏上 + 没收进坞,任何一条不成立就放掉。
    ///   **宁可放掉也不要按着不放**:按着不放的代价是她合上盖子出门、屏幕却一直亮着耗电,
    ///   而这是她自己看不见的 —— 这也正是出门那一格要一颗**缺省关**的开关来解释自己的原因。
    ///
    /// ## 2026-10-04:「在前台」认窗口槽里的那一家
    ///
    /// 维护者 10-04:「我说的是锁屏的修复没有生效……之前做了一个只要工作台在前台就不锁屏的修复」。
    /// 量到的那一幕:她在用窗口槽里的 Codex,16:51 屏幕锁了,`pmset -g assertions` 里
    /// `PreventUserIdleDisplaySleep 0`。根因就在上面那条 `!moment.appActive` —— 她点进槽里那扇**真窗**之后,
    /// 最前面的 App 是 Codex,工作台 `isActive=false`,断言被放掉。
    ///
    /// 她眼里「工作台在前台」= **壳那扇窗在屏上、她在用它**,而「用它」包括用槽里贴着的那一家。
    /// 所以「在前面那个 App」这一条从「只认工作台自己」放宽到「工作台自己 **或** 槽里那一家」;
    /// 后面「窗在屏上 + 没收进坞」两条一个字不动 —— 她把壳藏起来 / 收进坞 / 切到**槽外**的别的 App,照旧放掉。
    static func holdReason(_ moment: Moment) -> Reason? {
        if moment.terminating { return nil }
        if moment.awayKeepAwake { return .away }
        if !moment.appActive && !moment.slotAppFront { return nil }
        if moment.windowMiniaturized { return nil }
        guard moment.windowVisible else { return nil }
        // 两条都成立时先认工作台自己 —— 那是更准的那一句(她这会儿看着的是工作台本体)。
        return moment.appActive ? .foreground : .slotApp
    }

    /// 这一刻要不要按着「显示器别因为闲着而变暗 / 睡过去」这条断言。
    static func shouldHold(_ moment: Moment) -> Bool {
        holdReason(moment) != nil
    }

    /// 断言在系统里显示的名字(`pmset -g assertions` 里看得到的那一行)。
    /// 写人话:维护者真去查"谁让我的屏幕不睡"的时候,这一行就是答案。
    static let assertionName = "工作台在前台,先别让屏幕暗下去"

    /// 出门那一行后面加的那一句里一定有的两个字(用例按它断言,不逐字抄整句)。
    static let awayMark = "出门"

    /// 槽里那一家那一行后面加的那一句里一定有的三个字(2026-10-04,用例按它断言)。
    static let slotMark = "窗口槽"

    /// 按理由选那一行的名字。出门那一条是在原句后面**加一句** ——
    /// 原句一个字不动(她去 pmset 里查的时候,两种情况看到的是同一个开头),
    /// 后面那一句把"为什么这会儿按着"说清楚:她不在电脑前,是手机在外面连着。
    static func assertionName(for reason: Reason) -> String {
        switch reason {
        case .foreground: return assertionName
        case .away: return "\(assertionName)(\(awayMark)模式:手机在外面连着)"
        // 2026-10-04:同一套做法 —— 原句一个字不动,后面那一句说清「这会儿最前面的不是工作台本体,
        // 是她在工作台里用的那一家」。**不写那一家的名字**:断言的名字是创建那一刻定下的,
        // 带上名字就得每换一家重按一次(而 `DisplayAwake` 的幂等正是按 Reason 比的)。
        case .slotApp: return "\(assertionName)(她正在用\(slotMark)里的那一家)"
        }
    }
}
