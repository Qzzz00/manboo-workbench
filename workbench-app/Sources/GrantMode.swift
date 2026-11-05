import Foundation

/// 「装的时候把系统授权一次做完」那一屏,壳这一侧的**参数与状态文件格式**(2026-09-27,卡 IN)。
///
/// ## 为什么非得由壳自己跑一趟
///
/// macOS 的授权是**按 App 记的**:哪个 App 发起的那一问,就记在哪个 App 名下。
/// 安装器自己去调 `AXIsProcessTrustedWithOptions`,系统记下的是「安装工作台」——
/// 那个 App 装完就再也不会被打开,而真正要摆窗口的「工作台」仍然没有授权。
///
/// 所以安装器那一屏上的按钮**不自己弹框**,它是:
///   `open -n -a /Applications/工作台.app --args --grant accessibility`
/// 壳被这么拉起来时不建窗口、不连 8791,只做三件事:发起那一问、盯着系统那边翻没翻、
/// 把结果写进 `~/.dsh/workbench/grants.json`,然后退出。安装器轮询那份文件,
/// 翻了就把那一行画成「已完成」。
///
/// 这个文件**故意不 import AppKit**:参数怎么认、状态文件长什么样是纯逻辑,
/// `run-tests.sh` 编得动也测得了。真去发起那一问的那一半在 `GrantRun.swift`。
enum GrantKind: String, CaseIterable {
    /// 辅助功能(替她摆窗口、拖窗认领、把话送进各家 AI 都要它)。记在**工作台**名下。
    case accessibility
    /// 通知(事务官有话问她、要她批一件事时弹一条)。记在**工作台**名下。
    case notifications

    /// 界面上那一行的名字(人话,不出现 API 名)。
    var label: String {
        switch self {
        case .accessibility: return "辅助功能"
        case .notifications: return "通知"
        }
    }

    /// 那一行底下那句「它是干什么用的」。
    var why: String {
        switch self {
        case .accessibility: return "替你摆窗口、把你拖进来的窗口认下来、把你说的话送进各家 AI —— 这几件都要它。"
        case .notifications: return "事务官有话问你、或者要你点个头的时候,弹一条提醒给你。"
        }
    }

    /// 系统设置里对应的那一页(点「打开系统设置」去的地方)。
    var settingsURL: String {
        switch self {
        case .accessibility:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .notifications:
            return "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        }
    }
}

/// 一样授权此刻的状态。**「不知道」是一个正经答案**:通知那一问在她点之前系统就是不知道,
/// 这时候画成「没允许」是在说一句还没发生的话(D13:取不到就缺席,不编一个数)。
enum GrantState: String {
    case granted
    case missing
    case unknown
}

/// `--grant …` 这一趟要做什么。
struct GrantRequest: Equatable {
    /// 要办的那几样(按参数里的顺序,去重)。
    var kinds: [GrantKind]
    /// 只查不问(安装器开屏时先读一次现状用)。
    var checkOnly: Bool
}

enum GrantMode {
    /// 参数名。**两边各写一份字面量是会走漂的**,所以安装器那侧引用的是同一串字,
    /// 用例钉着(同 `ShellRelaunch.flag` 那条纪律)。
    static let flag = "--grant"
    static let checkFlag = "--grant-check"

    /// 这一趟是不是「只去办授权」的那一趟。不是 → 回 nil,壳照常启动(行为与加这一条之前逐字相同)。
    ///
    /// 认法刻意严:`--grant` 后面跟一串逗号分隔的名字,不认识的名字**整个当没给**(回 nil),
    /// 宁可退回普通启动,也不要莫名其妙地开一扇不建窗口的壳。
    static func parse(arguments: [String]) -> GrantRequest? {
        let args = Array(arguments.dropFirst())
        if args.contains(checkFlag) {
            return GrantRequest(kinds: GrantKind.allCases, checkOnly: true)
        }
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        let names = args[index + 1]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !names.isEmpty else { return nil }
        var kinds: [GrantKind] = []
        for name in names {
            guard let kind = GrantKind(rawValue: name) else { return nil }
            if !kinds.contains(kind) { kinds.append(kind) }
        }
        return GrantRequest(kinds: kinds, checkOnly: false)
    }
}

/// `~/.dsh/workbench/grants.json` 的编解码。**安装器读的就是它**。
///
/// 为什么另起一份文件而不塞进 app.json:app.json 是壳与插件共用的设置,
/// 授权状态是**读出来的事实、不是设置**,混在一起早晚有人把它当配置去改。
/// 而且这份文件被一个正在跑进度条的安装器每秒读一次,越小越好。
enum GrantStatusFile {
    static var path: String { NSHomeDirectory() + "/.dsh/workbench/grants.json" }

    /// 一份状态 → 一行 JSON。键就是 `GrantKind` 的 rawValue,值就是 `GrantState` 的 rawValue。
    static func encode(_ states: [GrantKind: GrantState], at: Date) -> Data {
        var json: [String: Any] = ["at": ISO8601DateFormatter().string(from: at)]
        for kind in GrantKind.allCases {
            guard let state = states[kind] else { continue }
            json[kind.rawValue] = state.rawValue
        }
        // sortedKeys:同一份状态每次写出来逐字节一样,安装器那边"文件变了没有"才判得准。
        return (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// 一行 JSON → 一份状态。**认不出来的一律缺席**(不是 `missing`):
    /// 文件坏了、还没写过、写了一半,都只意味着"还不知道",不意味着"她没允许"。
    static func decode(_ data: Data?) -> [GrantKind: GrantState] {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var states: [GrantKind: GrantState] = [:]
        for kind in GrantKind.allCases {
            guard let raw = json[kind.rawValue] as? String, let state = GrantState(rawValue: raw) else { continue }
            states[kind] = state
        }
        return states
    }

    /// 写盘(目录不存在就建)。授权这一趟是个短命进程,同步写、写完就退。
    static func write(_ states: [GrantKind: GrantState], now: Date = Date()) {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? encode(states, at: now).write(to: url, options: .atomic)
    }

    static func read() -> [GrantKind: GrantState] {
        decode(FileManager.default.contents(atPath: path))
    }

    /// 把这一趟读到的几样**并进**文件里已有的那几样,再整份写回。
    ///
    /// 为什么不直接覆盖:安装器那一屏上两颗按钮是分别点的,`--grant accessibility`
    /// 那一趟不知道通知的答案 —— 直接覆盖就会把上一趟刚写好的通知结果抹掉。
    static func merge(_ states: [GrantKind: GrantState], now: Date = Date()) {
        var merged = read()
        for (kind, state) in states { merged[kind] = state }
        write(merged, now: now)
    }
}
