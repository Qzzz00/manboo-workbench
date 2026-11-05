import AppKit
import Foundation

final class InstallerAppDelegate: NSObject, NSApplicationDelegate {
    private let installer: InstallerWindow
    private let screenshotDir: String?
    private let autoStart: Bool

    init(kernel: Kernel, resources: String, screenshotDir: String?, autoStart: Bool = false) {
        self.installer = InstallerWindow(kernel: kernel, resources: resources)
        self.screenshotDir = screenshotDir
        self.autoStart = autoStart
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let dir = screenshotDir {
            // 截图那一趟**不抢焦点**:统筹跑它的时候 Ben 可能正在用这台电脑。
            installer.showOffscreen()
            Screenshotter(installer: installer, directory: dir).run()
            return
        }
        if autoStart {
            // `--auto-start`:窗口摆屏幕外、开场那一屏跳过,直接开跑。**只给验收用** ——
            // 假内核(--dry-run)那条路否则只有人点了按钮才走得到,没人点就等于没验过。
            installer.traceEvents = true
            installer.showOffscreen()
            installer.startInstall()
            return
        }
        installer.show()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 关掉窗口 = 退出。安装器没有"在后台待着"的用处。
    /// 截图那一趟例外:窗口是摆在屏幕外的(算"没有可见窗口"),不例外的话它一启动就自己退了。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { screenshotDir == nil && !autoStart }
}
