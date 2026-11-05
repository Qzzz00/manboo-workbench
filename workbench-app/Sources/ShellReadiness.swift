import Foundation

/// 壳**先探服务就绪、再让页面开始加载**(2026-09-26,卡 U6)。
///
/// ## 为哪一幕写的
///
/// 09-26 生产切换那天,热更新重启 DSH 之后**壳里整窗一片白**,View → 重新加载就好。
/// 那一幕的成因是:3080 那边先起来了(DSH 的 web 服务在监听),壳把页面加载进来并
/// `didCommit` 了,但工作台插件那一层还没挂上 —— 于是 `LoadingCover` 等的那条
/// `{type:'ready'}` 永远不来,20 秒兜底一到就把盖板揭开,露出下面那张什么都没有的页。
///
/// 盖板那一套(LoadingCover.swift)管的是"页面已经在加载了,别露出上游那一屏";
/// 这一个管的是**在那之前**的一步:**工作台的服务还没在听,就先别开始加载**。
/// 两者串起来:探到 8791 答话了 → 加载 3080 → 盖板等插件的 ready → 揭开。
///
/// ## 为什么探 8791 而不是 3080
///
/// 3080 是 DSH 自己的 web 服务,它起来得早 —— 它答话**不代表**工作台插件加载好了,
/// 而白屏正是"DSH 起来了、插件还没有"这一刻。8791 是工作台插件自己起的那个服务:
/// 它答话 = 插件真的挂上了。这条边界就是这个文件存在的理由。
///
/// ## 三条纪律
///
/// - **有上限**。不能永远转圈:探到头(约三分钟)就摆一句人话 + 一颗「重试」,
///   而不是让一扇窗无声地转下去(那和白屏一样,只是换了个颜色)。
/// - **探不到也不露出下面那一页**。盖板一直盖着,副标题换成「还在等…」。
/// - **判断全在这个文件里**(不 import AppKit,`run-tests.sh` 有用例);真发请求、
///   真加载那一半在 AppDelegate。
enum ShellReadiness {
    /// 探针问的那条路。**特意不是 `/state`**:那一条会算一整份快照,而且会记一次
    /// 「工作台露面了」(开工汇报)—— 开机自启的壳探它等于替他露了个面。
    /// `/ready` 什么都不做,只答一句"我在"。
    static let probePath = "/ready"

    /// 一次探测给多久。它只是一句"我在",慢过这个数就当这一轮没成(下一轮还会来)。
    static let probeTimeout: TimeInterval = 3

    /// 最多探几轮。配上下面的退避,合计约三分钟 —— 冷机 + 高负载装机那一幕都够。
    static let maxAttempts = 40

    /// 从 helper 的 WS 地址推出探针地址(`ws://127.0.0.1:8791/helper` → `http://127.0.0.1:8791/ready`)。
    ///
    /// 推不出来(scheme 不是 ws/wss、拿不到 host)回 `nil` —— 调用方据此**照旧直接加载**,
    /// 也就是 09-26 之前的行为。宁可退回老样子,也不要因为探不出地址就打不开窗。
    static func probeURL(helperWS: URL) -> URL? {
        guard var parts = URLComponents(url: helperWS, resolvingAgainstBaseURL: false) else { return nil }
        switch parts.scheme?.lowercased() {
        case "ws": parts.scheme = "http"
        case "wss": parts.scheme = "https"
        default: return nil
        }
        guard let host = parts.host, !host.isEmpty else { return nil }
        parts.path = probePath
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    /// 这一轮探到的算不算"服务在"。
    ///
    /// **有 HTTP 应答就算**(连 401 / 403 都算):那说明 8791 上真有人在听并且在答话,
    /// 也就是插件挂上了 —— 令牌那一路由页面自己走(WebToken.swift)。
    /// 5xx 不算:那多半是刚起来还没就绪的中间态,再等一轮不亏。
    /// 请求本身失败(连不上、超时)时 `status` 是 nil —— 不算。
    static func isReady(status: Int?) -> Bool {
        guard let status else { return false }
        return status < 500
    }

    /// 第 `attempts` 轮没探到之后,隔多久再探。0.5 → 1 → 2 → 4 → 5 秒封顶。
    ///
    /// 头两下密:绝大多数情况(热更新重启)服务一两秒就回来了,密一点能少盖一会儿盖板。
    /// 之后拉开:冷机要 20 秒以上,一秒一探只是白费电。
    static func delay(afterAttempts attempts: Int) -> TimeInterval {
        let n = max(1, attempts)
        return min(0.5 * pow(2, Double(n - 1)), 5)
    }

    /// 探到头了没有。到头之后**不再自动探** —— 换成一句人话 + 一颗「重试」。
    static func gaveUp(attempts: Int) -> Bool {
        attempts >= maxAttempts
    }

    /// 探到头之后盖板上写的那一句。
    static let timedOut = "工作台还没起来。再等一下,或者点「重试」。"

    /// 那颗按钮上写什么。
    static let retryLabel = "重试"

    /// 盖板上那一行小字。等着的时候沿用 `LoadingCover` 那两句(同一件事只有一份措辞),
    /// 探到头了换成 `timedOut`。
    static func subtitle(waited: TimeInterval, gaveUp: Bool) -> String {
        gaveUp ? timedOut : LoadingCover.subtitle(waited: waited)
    }

    // MARK: - 8791 一直不答时,壳自己把服务拉一次(2026-10-13,0.4.115「装完没自己起来」)
    //
    // ## 为哪一幕写的
    //
    // 10-12 晚那一趟热更新:装完发出的 `launchctl kickstart` 没到 launchd,DSH 以 0 退出,
    // 而 plist 写着 `KeepAlive.SuccessfulExit=false`(正常退出故意不拉起)—— 服务就停在那儿。
    // 壳那时**只会重连、不会去拉服务**,所以界面上那句「没回来的话把工作台窗口关掉重开一次」
    // 是一句空话:关掉重开的那扇新窗一样连不上。只有终端里敲一句才救得回来,
    // 而「不让用户碰终端」是这个产品的底线。
    //
    // ## 为什么敢让壳动手
    //
    // 发的是**不带 `-k`** 的 `launchctl kickstart`:
    //   - 服务**还在跑**(比如正在装更新、正在跑一轮长作业)→ 它什么都不做,
    //     pid 与 runs 一格都不动(2026-10-13 在临时 launchd 测试项上量过:交接里的 E-E)。
    //     所以不需要先问一句「是不是在更新」—— 这一下**不可能**把一个好着的服务弄掉。
    //   - 服务**不在跑** → 把它起起来(E-F)。
    // 带 `-k` 就不一样了(那是"杀掉再起"),所以这里永远不带。
    //
    // ## 三条纪律
    //
    // - **等够久才动手**:`kickstart` 之后 launchd 自己的 `ThrottleInterval` 就要 10 秒
    //   (量到约 9 秒),再加上冷起。20 秒之前一下都不发。
    // - **不无限重试**:一轮最多 `maxKickstarts` 次,两次之间至少 `kickstartInterval`。
    //   拉不起来是别的毛病(插件崩了、端口被占),再拉一百次也一样 —— 那时候该出的是
    //   `timedOut` 那句人话 + 一颗「重试」。
    // - **判断全在这个文件里**,真发命令那一半在 AppDelegate(同这个文件里别的几样)。

    /// DSH 那个 launchd 项的名字。**与插件 `server/setup/paths.ts` 的 `DSH_LAUNCHD_LABEL`
    /// 逐字相同**,两边各有一条用例钉着这一串字(同 `ShellRelaunch.flag` 的做法)。
    static let dshLaunchdLabel = "ai.deepseek.dsh"

    /// 连续多久探不到才许发第一下。要大于 launchd 的 `ThrottleInterval`(plist 里 10 秒)。
    static let kickstartAfter: TimeInterval = 20

    /// 两下之间至少隔多久。一下没救起来,多半不是"没人起它"这个毛病。
    static let kickstartInterval: TimeInterval = 60

    /// 一轮最多发几下。
    static let maxKickstarts = 3

    /// `launchctl kickstart gui/<uid>/ai.deepseek.dsh` —— **不带 `-k`**(理由见上面那一节)。
    static func kickstartArguments(uid: UInt32) -> [String] {
        ["kickstart", "gui/\(uid)/\(dshLaunchdLabel)"]
    }

    /// 这一下该不该发。
    ///
    /// - `waited`:这一轮从开始探到现在等了多久;
    /// - `kicks`:这一轮已经发过几下;
    /// - `sinceLastKick`:上一下发出去多久了(还没发过就是 nil)。
    static func shouldKickstart(waited: TimeInterval, kicks: Int, sinceLastKick: TimeInterval?) -> Bool {
        guard waited >= kickstartAfter else { return false }
        guard kicks < maxKickstarts else { return false }
        guard let sinceLastKick else { return true }
        return sinceLastKick >= kickstartInterval
    }
}
