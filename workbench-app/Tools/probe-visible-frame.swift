import AppKit
import Foundation

/// 「可视区变了,系统到底通不通知」的**实测工具**(2026-09-26,卡 TB 真机回访)。
/// 不是壳的一部分,不进 `build.sh`。
///
/// 起因:维护者把系统设置「桌面与程序坞 → 自动隐藏和显示菜单栏」改成「始终」之后,
/// 2560×1440 那块屏的可视区从 2560×1410 变成 2560×1440,**壳窗口没跟着长高**。
/// 壳原来只在 `NSApplication.didChangeScreenParametersNotification` 那一下核对可视区,
/// 而这个设置在 macOS 26 上到底发不发那条通知(发的时候 NSScreen 有没有换成新值),
/// 是一句**只有在这台机器上真切一次设置才算数**的话 —— 不能靠猜,也不能靠读文档。
///
/// 这个工具就负责回答它:同时挂两路观察,谁先说话、说的是不是真值,一目了然。
///   ① `didChangeScreenParametersNotification` —— 通知来了就打一行,带上此刻读到的 visibleFrame;
///   ② 每 0.5 秒自己读一次 NSScreen.visibleFrame,变了就打一行(壳里那条定时核对的同款,只是更密)。
///
/// **跑法**(不改任何系统设置、不碰 `~/.dsh`、不起窗口、不连 8791):
/// ```
/// cd workbench-app
/// swiftc -O Tools/probe-visible-frame.swift -o /tmp/probe-visible-frame
/// /tmp/probe-visible-frame            # 让它跑着,然后去系统设置里切一次「自动隐藏和显示菜单栏」
/// ```
/// 看输出:
/// - 切完之后先出现 `[通知]` 且它带的 visible 已经是新值 → 那条通知靠得住,壳里那一路本该生效;
/// - 只出现 `[定时]`,或者 `[通知]` 带的还是旧值、要等下一条 `[定时]` 才变 →
///   **只靠通知不够**,壳里那条每两秒核对的定时(AppDelegate.reconcileVisibleFrame)就是为它留的。
///
/// 切换系统设置这一步由**维护者自己**做(卡上的规矩:授权与系统设置只有他能碰);
/// 这个工具只看、不改。
final class Probe: NSObject {
    private var last: [String: CGRect] = [:]
    private let started = Date()

    func start() {
        for screen in NSScreen.screens { last[screen.localizedName] = screen.visibleFrame }
        print("开始盯着:", terminator: " ")
        for screen in NSScreen.screens {
            print("\(screen.localizedName) frame=\(short(screen.frame)) visible=\(short(screen.visibleFrame))", terminator: "  ")
        }
        print("\n(现在去系统设置里切一次「自动隐藏和显示菜单栏」,⌃C 结束)")

        NotificationCenter.default.addObserver(self, selector: #selector(changed),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common)
    }

    @objc private func changed() {
        for screen in NSScreen.screens {
            print("[通知] +\(elapsed())s \(screen.localizedName) visible=\(short(screen.visibleFrame)) " +
                  "(上一次记下的是 \(short(last[screen.localizedName] ?? .zero)))")
        }
    }

    private func poll() {
        for screen in NSScreen.screens {
            let now = screen.visibleFrame
            guard last[screen.localizedName] != now else { continue }
            print("[定时] +\(elapsed())s \(screen.localizedName) visible \(short(last[screen.localizedName] ?? .zero)) → \(short(now))")
            last[screen.localizedName] = now
        }
    }

    private func elapsed() -> String { String(format: "%.1f", Date().timeIntervalSince(started)) }
    private func short(_ rect: CGRect) -> String {
        "(\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))×\(Int(rect.height)))"
    }
}

// 输出不缓冲:这东西是盯着看的(或者 `| tee`),缓冲住了会让人以为它没反应。
setbuf(stdout, nil)
// 不建窗口、不进 Dock:NSApplication 只是为了拿到那条通知与一条主 runloop。
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe()
probe.start()
app.run()
