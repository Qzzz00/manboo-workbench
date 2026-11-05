import AppKit

/// 什么都不干的内核。**只给截图用**:截图那一趟由 `Screenshotter` 自己喂事件,
/// 不能让假内核在旁边同时播一遍(两边抢同一个界面,截出来的东西是随机的)。
final class SilentKernel: Kernel {
    func run(onEvent: @escaping (KernelEvent) -> Void, onExit: @escaping (Int32) -> Void) {}
    func cancel() {}
}

/// 把界面的几个状态各截一张 PNG,截完退出。
///
/// **不走 `screencapture`**:那条路要「屏幕录制」授权,而这台机器上每加一次授权都是
/// 一次要 Ben 去点的系统框。这里让窗口把自己画进位图(`cacheDisplay`),不碰任何 TCC。
///
/// 喂进去的是**真事件**(`KernelEvent`),走的是界面平时走的那条 `handle(_:)` ——
/// 所以截出来的就是真机上会看到的东西,不是另画一套样板。
final class Screenshotter {
    private let installer: InstallerWindow
    private let directory: String

    init(installer: InstallerWindow, directory: String) {
        self.installer = installer
        self.directory = directory
    }

    func run() {
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        var queue: [(String, () -> Void)] = []

        queue.append(("1-开场", { self.installer.showIntro() }))
        queue.append(("2-安装中", {
            self.installer.startInstall()
            self.installer.handle(.begin(total: 10))
            self.installer.handle(.step(index: 2, total: 10, key: "runtime", title: "正在下载工作台的运行时…"))
            self.installer.handle(.note("装 @deepseek-ai/dsh@0.1.2-rc.1(网络慢会久一点;断了再点一次会接着装)"))
            self.installer.handle(.progress(0.35))
            for line in Screenshotter.sampleLog { self.installer.handle(.log(line)) }
        }))
        queue.append(("3-详细日志", { self.installer.setLogVisible(true) }))
        queue.append(("4-出错了", {
            self.installer.setLogVisible(false)
            self.installer.handle(.logfile(path: NSHomeDirectory() + "/Library/Logs/工作台/安装-20260927-161200.log"))
            self.installer.handle(.fail(key: "runtime", title: "正在下载工作台的运行时…",
                                        error: "下不下来 —— 这会儿像是没网,或者网络挡着。连上网之后点「重试」。",
                                        tail: ["npm error network request to https://registry.npmjs.org/@deepseek-ai%2fdsh failed",
                                               "npm error network This is a problem related to network connectivity."]))
        }))
        // `.done` 之后先是「授权」那一屏(2026-09-27,卡 IN),再点「下一步」才是「装好了」。
        queue.append(("5-授权", {
            self.installer.handle(.done(shellApp: "/Applications/工作台.app",
                                        workRepo: NSHomeDirectory() + "/Documents/工作台"))
        }))
        queue.append(("6-授权-允许过一样", {
            // 点完一样之后那一行长什么样(不碰状态文件,只把界面画成那个样子)。
            self.installer.markGrantGranted(.accessibility)
        }))
        queue.append(("7-装好了", {
            self.installer.showDoneForScreenshot(workRepo: NSHomeDirectory() + "/Documents/工作台")
        }))

        step(queue, index: 0)
    }

    private func step(_ queue: [(String, () -> Void)], index: Int) {
        guard index < queue.count else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
            return
        }
        let (name, action) = queue[index]
        action()
        // 让 AppKit 把这一帧真的画完再截 —— 立刻截会截到上一屏。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            self.capture(named: name)
            self.step(queue, index: index + 1)
        }
    }

    private func capture(named name: String) {
        guard let view = installer.nsWindow.contentView else { return }
        view.layoutSubtreeIfNeeded()
        installer.nsWindow.displayIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        // 走 CALayer:现在的 AppKit 视图默认是层撑着的,`cacheDisplay` 对它们常常画出一张白纸。
        // **先把底色铺上**:位图新建出来是透明的,而深色模式下文字是白的 ——
        // 不铺底色的话,截出来就是一张"什么都没有"的白纸(第一次就是这么被骗过去的)。
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        installer.nsWindow.effectiveAppearance.performAsCurrentDrawingAppearance {
            NSColor.windowBackgroundColor.setFill()
            view.bounds.fill()
        }
        if let layer = view.layer {
            layer.render(in: ctx.cgContext)
        }
        else {
            view.cacheDisplay(in: view.bounds, to: rep)
        }
        ctx.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return }
        let path = directory + "/installer-" + name + ".png"
        try? png.write(to: URL(fileURLWithPath: path))
        FileHandle.standardError.write(Data(("截了一张:" + path + "\n").utf8))
    }

    private static let sampleLog = [
        "$ npm i @deepseek-ai/dsh@0.1.2-rc.1 --fetch-timeout=300000 --fetch-retries=5",
        "npm warn deprecated inflight@1.0.6: This module is not supported",
        "added 214 packages in 1m 21s",
    ]
}
