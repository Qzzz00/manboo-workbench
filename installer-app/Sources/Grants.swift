import AppKit

/// 安装器那一屏「授权」这一侧(2026-09-27,卡 IN)。
///
/// 维护者原话:「在安装过程中,把权限还有自动隐藏都做好了,趁我现在还没安装,这是干净的」。
///
/// ## 为什么按钮不是安装器自己弹框
///
/// macOS 的授权**按 App 记**:哪个 App 发起那一问,就记在哪个 App 名下。安装器自己去调,
/// 系统记下的是「安装工作台」—— 那个 App 装完就再也不会被打开,而真要摆窗口的「工作台」
/// 仍然没有授权。所以这里是:
///
///   `open -n -a /Applications/工作台.app --args --grant accessibility`
///
/// 壳被这么拉起来时不建窗口、不连 8791,只发起那一问,并把结果写进
/// `~/.dsh/workbench/grants.json`(格式由壳那侧 `GrantMode.swift` 定,有用例)。
/// 这边**每秒读一次那份文件**,翻了就把那一行画成「已完成」。
///
/// 用 `open` 而不是直接起那个二进制:`open` 走的是 launchd,壳的父进程就不是安装器了 ——
/// TCC 那边不会把「安装工作台」算成这一问的「负责进程」。
enum InstallerGrant: String, CaseIterable {
    case accessibility
    case notifications

    var label: String {
        switch self {
        case .accessibility: return "辅助功能"
        case .notifications: return "通知"
        }
    }

    var why: String {
        switch self {
        case .accessibility: return "替你摆窗口、把你拖进来的窗口认下来、把你说的话送进各家 AI —— 这几件都要它。"
        case .notifications: return "事务官有话问你、或者要你点个头的时候,弹一条提醒给你。"
        }
    }

    /// 点了那颗键之后系统会怎样(按钮旁边不写,这句进"点过之后还没允许"时的提示)。
    var hint: String {
        switch self {
        case .accessibility: return "系统弹框之后点「打开系统设置」,在那张表里把「工作台」的开关打开。"
        case .notifications: return "系统弹框之后点「允许」。"
        }
    }

    var settingsURL: String {
        switch self {
        case .accessibility: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .notifications: return "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        }
    }
}

/// 一样授权此刻的状态。与壳那侧 `GrantState` 同一套字面量(两边各一份,各有用例钉着)。
enum InstallerGrantState: String {
    case granted
    case missing
    case unknown
}

/// `~/.dsh/workbench/grants.json` 的读。**只读**,写的那一半在壳里。
enum InstallerGrantStatus {
    static var path: String { NSHomeDirectory() + "/.dsh/workbench/grants.json" }

    static func decode(_ data: Data?) -> [InstallerGrant: InstallerGrantState] {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var states: [InstallerGrant: InstallerGrantState] = [:]
        for grant in InstallerGrant.allCases {
            guard let raw = json[grant.rawValue] as? String,
                  let state = InstallerGrantState(rawValue: raw) else { continue }
            states[grant] = state
        }
        return states
    }

    static func read() -> [InstallerGrant: InstallerGrantState] {
        decode(FileManager.default.contents(atPath: path))
    }

    /// 让壳自己去发起那一问(见本文件顶上那段:授权按 App 记)。
    @discardableResult
    static func ask(_ grant: InstallerGrant, shellApp: String) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-n", "-a", shellApp, "--args", "--grant", grant.rawValue]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return false }
        return true
    }

    /// 打开系统设置对应那一页(她点完系统框之后还要去那张表里拨开关)。
    static func openSettings(_ grant: InstallerGrant) {
        guard let url = URL(string: grant.settingsURL) else { return }
        NSWorkspace.shared.open(url)
    }
}

/// 「文稿」文件夹与日历那一行的说明。**不做成一颗能点的键,这是有意的。**
///
/// 这两样不记在「工作台」名下,记在工作台后台那条 node 上(`~/.dsh/node/bin/node` ——
/// 系统设置里显示成「node」,见 `deploy/ai.deepseek.dsh.plist` 与 `dsh-start` 顶上那段)。
/// 而那条 node 是 launchd 拉起来的,安装器代它去碰一下文稿目录,系统会把这一问
/// 记在**安装器**名下 —— 那等于白点一次。所以这里如实说一句「到时候系统会问你」。
let documentsAndCalendarNote = """
你的东西放在「文稿」里,日程从「日历」读。这两样系统会在工作台第一次用到的时候问你,\
弹框了点「允许」就行 —— 它们记在工作台后台那个程序名下,这会儿还没法替你先点。
"""

/// 系统防火墙那一问(2026-10-21,局域网主路卡 M1)。本机通话服务(`~/.dsh/livekit/livekit-server`)
/// 要接受手机和听筒从家里网络连进来;系统防火墙开着时,它第一次起来系统会问一次。同理不做成按键:
/// 那一问由系统在它第一次监听时发起,安装器替不了。没开防火墙的机器上不会弹。
let firewallNote = """
系统防火墙开着的话,会问一次要不要允许「livekit-server」接受传入连接 —— 点「允许」。\
那是工作台的本机通话服务:手机和听筒在家要连它。
"""
