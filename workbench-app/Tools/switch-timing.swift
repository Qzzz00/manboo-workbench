import AppKit
import ApplicationServices
import Foundation

/// 「点标签切换经常卡住」的**实测工具**(2026-09-21)。不是壳的一部分,不进 `build.sh`。
///
/// 为什么要单独有它:这张卡的核心主张是「AX 调用在无限期同步等目标应用回话,给它一个
/// 1 秒的时限就不会再把主线程按住」。这是一句**只有在这台机器上真量一次才算数**的话
/// (卡上的规矩:不编数)。而壳本身是个 GUI 常驻程序 —— 随手起一份临时 build 会注册登录项、
/// 退出时覆盖 Ben 真的 `~/.dsh/workbench/app.json`、连上真 `/helper` 去挪他正开着的窗口
/// (2026-09-21「壳自动重开」那张卡记的坑)。所以这个工具沿用 `Tools/main.swift`(送话那张卡)
/// 的做法:**只编它自己 + SwitchBudget**,`AppDelegate` / `WindowControl` / `HelperSocket`
/// 一行都不进来 —— 没有窗口、没有登录项、不碰 app.json、不连 8791。
///
/// **改前 / 改后在同一份二进制里跑**:`--timeout off` 走的就是这次改动之前那条路
/// (拿到 AXUIElement 直接用,不设时限),`--timeout on` 走改动之后那条(每个元素先过
/// `AXUIElementSetMessagingTimeout`)。同一台机器、同一批进程、同一秒的负载 —— 两份数字
/// 才真的可比;分别编两个二进制去测,中间机器状态一变,对比就没了意义。
///
/// 量的动作与壳里 `WindowControl.raise` / `.hide` **逐字同构**:
///   raise = 取应用元素 → 读 kAXWindows → 按 subrole 过滤标准窗 → AXUIElementPerformAction(raise)
///           → NSRunningApplication.activate()
///   hide  = NSRunningApplication.hide()
/// (hide 那条本来就不碰 AX —— 这本身就是一个该被量出来、该写进交接的事实,不是我猜的。)
///
/// 收尾:每一轮 hide 之后立刻 unhide 还原;整趟跑完把应用的 hidden 状态恢复成开跑之前那样。
/// **不截屏、不读窗口内容、不动任何窗口的位置和大小**(拖窗那套几何逻辑这张卡一字不动)。
///
/// 用法(见 probe-switch-timing.sh):
///   probe-switch-timing <bundle_id> [--rounds 10] [--timeout on|off]
///
/// 用 `@main` 而不是把文件叫 `main.swift`:`Tools/main.swift` 已经被送话那个工具占了,
/// 两个工具各编各的,不能撞文件名。
@main
enum SwitchTimingProbe {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let bundleId = args.first, !bundleId.hasPrefix("--") else {
            out(["ok": false, "error": "用法:probe-switch-timing <bundle_id> [--rounds 10] [--timeout on|off]"])
            exit(2)
        }
        guard AXIsProcessTrusted() else {
            out(["ok": false, "error": "这份二进制没有辅助功能授权(AXIsProcessTrusted=false)——签名对不上,测出来的会是一张假表,直接停"])
            exit(3)
        }
        let rounds = intFlag(args, "--rounds") ?? 10
        let useTimeout = (stringFlag(args, "--timeout") ?? "on") != "off"

        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
            out(["ok": false, "error": "应用未在运行:\(bundleId)"])
            exit(4)
        }
        let pid = app.processIdentifier
        let wasHidden = app.isHidden

        var raiseMs: [Int] = []
        var hideMs: [Int] = []
        var raiseFailures = 0
        for _ in 0..<rounds {
            // ── raise ──
            let t0 = CFAbsoluteTimeGetCurrent()
            let wins = standardWindows(pid, useTimeout: useTimeout)
            if let first = wins.first {
                AXUIElementPerformAction(first, kAXRaiseAction as CFString)
            }
            else {
                raiseFailures += 1
            }
            app.activate()
            raiseMs.append(ms(since: t0))

            // ── hide ──(壳里 hide 就是这一行,不碰 AX)
            let t1 = CFAbsoluteTimeGetCurrent()
            app.hide()
            hideMs.append(ms(since: t1))

            // 还原:这台机器是 Ben 正在用的,不能测完就把他的窗留在隐藏里。
            app.unhide()
        }
        // 整趟收尾:恢复开跑之前的 hidden 状态。
        if wasHidden { app.hide() } else { app.unhide() }

        out([
            "ok": true,
            "bundle_id": bundleId,
            "rounds": rounds,
            "timeout": useTimeout ? "on(\(SwitchBudget.axMessagingTimeoutSeconds)s)" : "off(改动之前:无时限)",
            "load": loadAverage(),
            "raise_ms": ["each": raiseMs, "max": raiseMs.max() ?? 0, "p50": median(raiseMs), "sum": raiseMs.reduce(0, +)],
            "hide_ms": ["each": hideMs, "max": hideMs.max() ?? 0, "p50": median(hideMs), "sum": hideMs.reduce(0, +)],
            // 一扇标准窗都读不到的轮数:AX 通道睡死(kAXErrorAPIDisabled)或超时都会落在这里。
            // 它不是"失败",是「这家这次不动」—— 但必须如实报出来,不然上面那些好看的毫秒数
            // 可能只是因为压根没跟对方说上话。
            "raise_no_window_rounds": raiseFailures,
        ])
    }

    /// 与 `WindowControl.standardWindows` 同构。`useTimeout=false` 就是这次改动之前那条路。
    private static func standardWindows(_ pid: pid_t, useTimeout: Bool) -> [AXUIElement] {
        let appEl = AXUIElementCreateApplication(pid)
        if useTimeout { AXUIElementSetMessagingTimeout(appEl, Float(SwitchBudget.axMessagingTimeoutSeconds)) }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &value) == .success,
              let all = value as? [AXUIElement] else { return [] }
        if useTimeout { for w in all { AXUIElementSetMessagingTimeout(w, Float(SwitchBudget.axMessagingTimeoutSeconds)) } }
        let standard = all.filter { win -> Bool in
            var sub: CFTypeRef?
            guard AXUIElementCopyAttributeValue(win, kAXSubroleAttribute as CFString, &sub) == .success else { return false }
            return (sub as? String) == kAXStandardWindowSubrole as String
        }
        return standard.isEmpty ? all : standard
    }

    private static func ms(since t0: CFAbsoluteTime) -> Int {
        return Int(((CFAbsoluteTimeGetCurrent() - t0) * 1000).rounded())
    }

    private static func median(_ xs: [Int]) -> Int {
        guard !xs.isEmpty else { return 0 }
        let sorted = xs.sorted()
        return sorted[sorted.count / 2]
    }

    /// 1 分钟负载 —— 每一份数字都得带着"当时机器多忙"一起看,不然对比没有意义。
    private static func loadAverage() -> Double {
        var avg = [Double](repeating: 0, count: 3)
        guard getloadavg(&avg, 3) > 0 else { return -1 }
        return (avg[0] * 100).rounded() / 100
    }

    private static func intFlag(_ args: [String], _ name: String) -> Int? {
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return Int(args[i + 1])
    }

    private static func stringFlag(_ args: [String], _ name: String) -> String? {
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// 同 `Tools/main.swift` 的 `out`:授权按"负责进程"算,必须由 LaunchServices 拉起,
    /// 那时标准输出没人接,结果只能落 `--out` 指的文件再读回来。
    private static func out(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            print("{\"ok\":false,\"error\":\"结果序列化不出来\"}")
            return
        }
        print(text)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--out"), i + 1 < args.count {
            try? text.write(toFile: args[i + 1], atomically: true, encoding: .utf8)
        }
    }
}
