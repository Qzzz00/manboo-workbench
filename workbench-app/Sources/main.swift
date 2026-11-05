import AppKit

let app = NSApplication.shared

// 「装的时候把授权一次做完」那一趟(2026-09-27,卡 IN):安装器用
// `open -n -a /Applications/工作台.app --args --grant accessibility` 把壳拉起来,
// 壳**不建窗口、不连 8791**,只发起那一问并把结果写进 ~/.dsh/workbench/grants.json。
// 授权是按 App 记的,所以这一问必须由工作台自己发起(细节见 GrantMode.swift)。
// 没给这个参数(常态)时下面一个字都不变。
if let request = GrantMode.parse(arguments: CommandLine.arguments) {
    GrantRun.run(request)  // 不返回
}

let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
