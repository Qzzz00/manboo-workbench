import AppKit

/// 「安装工作台.app」的入口。
///
/// 三个开关(都是给统筹验收用的,Ben 双击时一个都不给):
///   --dry-run          什么都不装,用假内核把十步播一遍(看界面)
///   --dry-run-fail N   同上,但在第 N 步假装失败(看失败那屏)
///   --screenshot DIR   把几屏各截一张 PNG 到 DIR,然后退出(不需要屏幕录制授权:
///                      窗口自己把自己画进位图,不走 screencapture)
///   --auto-start       不等人点「开始安装」,启动就开跑,窗口摆在屏幕外(验收时走一遍假内核)
let arguments = CommandLine.arguments
let resources = Bundle.main.resourcePath ?? "."

func flagValue(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

let screenshotDir = flagValue("--screenshot")
let dryRun = arguments.contains("--dry-run") || arguments.contains("--dry-run-fail") || screenshotDir != nil
let failAt = Int(flagValue("--dry-run-fail") ?? "") ?? 0
// `--auto-start`:不等人点「开始安装」,启动即开跑(验收时用来真的走一遍假内核)。
let autoStart = arguments.contains("--auto-start")

// 截图那一趟由 Screenshotter 自己喂事件,内核必须闭嘴(两边同时改一个界面 = 截出来的东西随机)。
func makeKernel() -> Kernel {
    if screenshotDir != nil { return SilentKernel() }
    if dryRun { return FakeKernel(failAt: failAt) }
    return ProcessKernel(resources: resources)
}
let kernel: Kernel = makeKernel()

let app = NSApplication.shared
let delegate = InstallerAppDelegate(kernel: kernel, resources: resources, screenshotDir: screenshotDir, autoStart: autoStart)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
